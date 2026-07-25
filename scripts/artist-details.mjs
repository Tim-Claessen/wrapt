// One-shot local report: Spotify artist details for the four "who am I actually listening to" lists —
// top 10 artists (last 6 months / all time) and the artists behind the top 10 tracks (last 6 months /
// all time). Rankings come from the same leaderboard RPCs the dashboard uses, so the numbers match the
// UI exactly; the artist metadata is fetched fresh from Spotify's public catalog endpoints.
//
// Usage:   node scripts/artist-details.mjs [--cache] [--out <path.json>] [--top N]
//            --cache   also upsert what Spotify returns into artists_cache (default: read-only)
//            --out     also write the full report as JSON to <path>
//            --top N   additionally sweep the top N artists of the 30d / 6m / all-time boards.
//                      Pair with --cache to backfill leaderboard artwork. Writes as it goes (every
//                      25 artists), so Ctrl-C keeps whatever it already fetched.
//
// RATE LIMIT — the other way this can hurt the 2-hourly cron.
// The token flow below is race-proof, but Spotify's dev-mode rate limit (C10, ~30-second rolling
// window) is per **Client ID**, and the cron uses the same one. A big `--top 250` sweep is ~700
// requests; run it while the cron fires (UTC 0 */2 = 08:00/10:00/…/18:00 AWST) and the worker can eat
// 429s. It degrades safely — SpotifyRateLimitError is a warn-and-skip, so the cron loses a cycle, not
// data — but skipping *repeatedly* is not free: /me/player/recently-played only holds the last 50
// plays, so a long enough outage during heavy listening loses plays permanently.
// So: prefer small values (--top 50), run it well clear of the top of an even hour, and let the cron's
// own backfillTopArtistImages (25/cycle, deliberately gentle) handle the long tail.
//
// Reads creds from .dev.vars in the repo root. Read-only against Supabase unless --cache is passed.
//
// TOKEN SAFETY — read this before changing how it authenticates.
// This script authenticates with the **client-credentials grant** (an app-level token derived from
// SPOTIFY_CLIENT_ID + SPOTIFY_CLIENT_SECRET). It deliberately does NOT decrypt or use the user's
// refresh token the way scripts/backfill-enrichment.mjs does. That matters: Spotify rotates a refresh
// token on every use, so any second process refreshing it races the 2-hourly sync worker and whichever
// side ends up holding the superseded copy dies with `invalid_grant` (see README → Ops runbook). There
// is no refresh token in this flow at all, so this script cannot cause that race — not "if you run it
// at the right time", but structurally. Every endpoint it touches (/artists, /tracks) is public catalog
// data needing no user scope, which is what makes that possible.
// If the client-credentials grant is ever refused, this script prints the DB-only rankings and stops.
// Do NOT "fix" that by falling back to the user's refresh token.

import { readFileSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API_BASE = 'https://api.spotify.com/v1';
const TOP_N = 10;
const SIX_MONTH_DAYS = 183; // matches COMPUTED_WINDOW_DAYS['6m'] in src/lib/leaderboard.ts
const ALL_TIME_START = new Date('2000-01-01T00:00:00Z'); // matches ALL_TIME_START in src/lib/leaderboard.ts
const PACING_MS = 200; // gap between catalog lookups — keeps under the dev-mode rate window (C10)
const RATE_LIMIT_MAX_WAIT_S = 60;
const CACHE_FLUSH_EVERY = 25; // upsert in chunks so an interrupted --top run keeps its progress

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- args ----
const args = process.argv.slice(2);
const writeCache = args.includes('--cache');
const outIdx = args.indexOf('--out');
const outPath = outIdx !== -1 ? args[outIdx + 1] : null;
if (outIdx !== -1 && !outPath) {
  console.error('--out needs a file path.');
  process.exit(1);
}
const topIdx = args.indexOf('--top');
const topN = topIdx !== -1 ? Number(args[topIdx + 1]) : 0;
if (topIdx !== -1 && (!Number.isInteger(topN) || topN < 1)) {
  console.error('--top needs a positive whole number, e.g. --top 200');
  process.exit(1);
}

// ---- env ----
const vars = {};
for (const raw of readFileSync('.dev.vars', 'utf8').split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) continue;
  const eq = line.indexOf('=');
  if (eq === -1) continue;
  vars[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^"|"$/g, '');
}
for (const key of ['PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET']) {
  if (!vars[key]) {
    console.error(`Missing ${key} in .dev.vars`);
    process.exit(1);
  }
}
const sb = createClient(vars.PUBLIC_SUPABASE_URL, vars.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// ---- profile ----
// Only id/display_name — refresh_token_enc is deliberately never read here (see TOKEN SAFETY above).
const { data: profiles, error: profileError } = await sb
  .from('spotify_profiles')
  .select('id, display_name')
  .order('connected_at', { ascending: true });
if (profileError) {
  console.error(`Failed to read profiles: ${profileError.message}`);
  process.exit(1);
}
if (!profiles?.length) {
  console.error('No spotify_profiles row found.');
  process.exit(1);
}
const profile = profiles[0];
if (profiles.length > 1) {
  console.log(`Note: ${profiles.length} profiles exist — reporting on the oldest.`);
}
console.log(`Profile: ${profile.display_name ?? profile.id} (${profile.id})\n`);

// ---- windows (mirrors resolveWindowRange in src/lib/leaderboard.ts) ----
const now = new Date();
const sixMonthsAgo = new Date(now.getTime() - SIX_MONTH_DAYS * 24 * 60 * 60 * 1000);
const WINDOWS = {
  sixMonths: {
    label: `last 6 months (${SIX_MONTH_DAYS}d)`,
    since: sixMonthsAgo,
    until: now,
    prevSince: new Date(sixMonthsAgo.getTime() - SIX_MONTH_DAYS * 24 * 60 * 60 * 1000),
    prevUntil: sixMonthsAgo,
  },
  // `all` has no comparable previous period, so its prev range is zero-width — same as the app.
  allTime: { label: 'all time', since: ALL_TIME_START, until: now, prevSince: ALL_TIME_START, prevUntil: ALL_TIME_START },
};

async function topArtists(w, limit = TOP_N) {
  const { data, error } = await sb.rpc('leaderboard_top_artists', {
    p_profile_id: profile.id,
    p_since: w.since.toISOString(),
    p_until: w.until.toISOString(),
    p_prev_since: w.prevSince.toISOString(),
    p_prev_until: w.prevUntil.toISOString(),
    p_genre: null,
    p_limit: limit,
  });
  if (error) throw new Error(`leaderboard_top_artists: ${error.message}`);
  return data ?? [];
}

async function topTracks(w) {
  const { data, error } = await sb.rpc('leaderboard_top_tracks', {
    p_profile_id: profile.id,
    p_since: w.since.toISOString(),
    p_until: w.until.toISOString(),
    p_prev_since: w.prevSince.toISOString(),
    p_prev_until: w.prevUntil.toISOString(),
    p_genre: null,
    p_limit: TOP_N,
    p_artist: null,
  });
  if (error) throw new Error(`leaderboard_top_tracks: ${error.message}`);
  return data ?? [];
}

const artists6m = await topArtists(WINDOWS.sixMonths);
const artistsAll = await topArtists(WINDOWS.allTime);
const tracks6m = await topTracks(WINDOWS.sixMonths);
const tracksAll = await topTracks(WINDOWS.allTime);

// ---- Spotify: client-credentials token (no refresh token involved — see TOKEN SAFETY) ----
let accessToken = null;
let spotifyError = null;

async function mintAppToken() {
  const basic = Buffer.from(`${vars.SPOTIFY_CLIENT_ID}:${vars.SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const json = await res.json();
  if (!json.access_token) throw new Error('no access_token in client-credentials response');
  return json.access_token;
}

try {
  accessToken = await mintAppToken();
} catch (err) {
  spotifyError = err instanceof Error ? err.message : String(err);
}

// GET a public catalog endpoint. 401 re-mints the app token (cheap, and still no refresh token in play).
async function spotifyGet(path) {
  let reAuthed = false;
  for (;;) {
    const res = await fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (res.status === 401 && !reAuthed) {
      accessToken = await mintAppToken();
      reAuthed = true;
      continue;
    }
    if (res.status === 429) {
      const wait = Math.min(Number(res.headers.get('Retry-After') ?? '1') || 1, RATE_LIMIT_MAX_WAIT_S);
      process.stdout.write(`\r  rate limited — waiting ${wait}s…            `);
      await sleep(wait * 1000);
      continue;
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
    return res.json();
  }
}

// ---- resolve the artists behind each top track ----
// leaderboard_top_tracks carries artist *names* but no ids, and imported plays often have no artist_ids
// at all until enrichment reaches them — so ask the catalog directly. Authoritative and only ~20 calls.
const trackIds = [...new Set([...tracks6m, ...tracksAll].map((r) => r.track_id).filter(Boolean))];
const trackArtists = new Map(); // track_id -> [{ id, name }]
if (accessToken) {
  let i = 0;
  for (const trackId of trackIds) {
    if (i++ > 0) await sleep(PACING_MS);
    process.stdout.write(`\r  resolving tracks ${i}/${trackIds.length}…            `);
    try {
      const track = await spotifyGet(`/tracks/${trackId}`);
      if (track) trackArtists.set(trackId, (track.artists ?? []).map((a) => ({ id: a.id, name: a.name })));
    } catch (err) {
      console.error(`\n  track ${trackId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  process.stdout.write('\r                                              \r');
}

// ---- fetch details for every unique artist across all four lists ----
const artistIds = new Set();
for (const row of [...artists6m, ...artistsAll]) if (row.artist_id) artistIds.add(row.artist_id);
for (const list of trackArtists.values()) for (const a of list) if (a.id) artistIds.add(a.id);

// --top N widens the net past the four top-10 lists to the head of each board — this is the
// artwork-backfill mode, so it only bothers with artists that have no cached image yet. It sweeps the
// same windows as the cron's backfillTopArtistImages (30d / 6m / all time), because the dashboard
// defaults to 30d and a heavy-rotation recent artist can sit far outside the all-time top few hundred.
if (topN > 0) {
  const sweep = [
    ['last 30 days', 30],
    ['last 6 months', SIX_MONTH_DAYS],
    ['all time', null],
  ];
  for (const [label, days] of sweep) {
    const w =
      days === null
        ? WINDOWS.allTime
        : { since: new Date(now.getTime() - days * 24 * 60 * 60 * 1000), until: now, prevSince: ALL_TIME_START, prevUntil: ALL_TIME_START };
    const rows = await topArtists(w, topN);
    const missing = rows.filter((r) => r.artist_id && !r.image);
    for (const row of missing) artistIds.add(row.artist_id);
    console.log(`--top ${topN} · ${label}: ${rows.length} artists, ${missing.length} without a cached image.`);
  }
}

// Upserts a chunk of fetched artists. Called as we go rather than once at the end so a long --top run
// that's interrupted (Ctrl-C, or a rate-limit stall you give up on) keeps everything it already
// fetched — same resumable contract as scripts/backfill-enrichment.mjs.
async function flushCache(buffer) {
  if (!writeCache || buffer.length === 0) return 0;
  const rows = buffer.map((a) => ({
    id: a.id,
    name: a.name,
    genres: a.genres ?? [], // always [] — Spotify no longer returns genres (C11)
    image: a.images?.[0]?.url ?? null,
    fetched_at: new Date().toISOString(),
  }));
  const { error } = await sb.from('artists_cache').upsert(rows);
  if (error) {
    console.error(`\nartists_cache upsert failed: ${error.message}`);
    return 0;
  }
  buffer.length = 0;
  return rows.length;
}

const details = new Map(); // artist id -> Spotify artist object
let cachedCount = 0;
if (accessToken) {
  const ids = [...artistIds];
  const pending = [];
  let i = 0;
  for (const artistId of ids) {
    if (i++ > 0) await sleep(PACING_MS);
    process.stdout.write(`\r  fetching artists ${i}/${ids.length}${writeCache ? ` · cached ${cachedCount}` : ''}…            `);
    try {
      const artist = await spotifyGet(`/artists/${artistId}`); // one request each — no batch endpoint (C6)
      if (artist) {
        details.set(artistId, artist);
        pending.push(artist);
        if (pending.length >= CACHE_FLUSH_EVERY) cachedCount += await flushCache(pending);
      }
    } catch (err) {
      console.error(`\n  artist ${artistId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  cachedCount += await flushCache(pending); // final partial chunk
  process.stdout.write('\r                                              \r');
  if (writeCache) console.log(`Cached ${cachedCount} artists into artists_cache.\n`);
}

// ---- report ----
const minutes = (ms) => Math.round(Number(ms ?? 0) / 60000).toLocaleString();
const pad = (n) => String(n).padStart(2, ' ');

function describe(artistId, fallbackName, indent) {
  const a = artistId ? details.get(artistId) : null;
  if (!a) {
    const why = !accessToken ? 'Spotify unavailable' : artistId ? 'not found on Spotify' : 'no Spotify id in our data';
    return [`${indent}${fallbackName ?? 'Unknown'}  — no details (${why})`];
  }
  const lines = [`${indent}${a.name}`];
  const genres = a.genres ?? [];
  lines.push(`${indent}  genres    ${genres.length ? genres.join(', ') : '—  (Spotify returned none)'}`);
  if (typeof a.followers?.total === 'number') lines.push(`${indent}  followers ${a.followers.total.toLocaleString()}`);
  if (typeof a.popularity === 'number') lines.push(`${indent}  popularity ${a.popularity}`);
  lines.push(`${indent}  image     ${a.images?.[0]?.url ?? '—'}`);
  lines.push(`${indent}  spotify   ${a.external_urls?.spotify ?? `https://open.spotify.com/artist/${a.id}`}`);
  return lines;
}

function section(title) {
  console.log(`\n${'═'.repeat(78)}\n${title}\n${'═'.repeat(78)}`);
}

function printArtistList(title, rows) {
  section(title);
  for (const row of rows) {
    console.log(`\n${pad(row.rank)}. ${row.artist_name}   ${row.play_count} plays · ${minutes(row.total_ms)} min`);
    for (const line of describe(row.artist_id, row.artist_name, '    ')) console.log(line);
  }
}

function printTrackList(title, rows) {
  section(title);
  for (const row of rows) {
    const names = (row.artist_names ?? []).join(', ');
    console.log(`\n${pad(row.rank)}. ${row.track_name} — ${names}   ${row.play_count} plays · ${minutes(row.total_ms)} min`);
    const resolved = trackArtists.get(row.track_id);
    if (resolved?.length) {
      for (const a of resolved) for (const line of describe(a.id, a.name, '    ')) console.log(line);
    } else {
      for (const name of row.artist_names ?? []) console.log(`    ${name}  — no details (track not resolved)`);
    }
  }
}

if (spotifyError) {
  console.log('─'.repeat(78));
  console.log('Spotify client-credentials grant failed — reporting rankings only, no artist details.');
  console.log(`  ${spotifyError}`);
  console.log('Not falling back to the user refresh token on purpose: that would race the 2-hourly');
  console.log('sync worker and can break it with invalid_grant (README → Ops runbook).');
  console.log('─'.repeat(78));
}

printArtistList(`TOP ${TOP_N} ARTISTS — ${WINDOWS.sixMonths.label}`, artists6m);
printArtistList(`TOP ${TOP_N} ARTISTS — ${WINDOWS.allTime.label}`, artistsAll);
printTrackList(`ARTISTS OF THE TOP ${TOP_N} TRACKS — ${WINDOWS.sixMonths.label}`, tracks6m);
printTrackList(`ARTISTS OF THE TOP ${TOP_N} TRACKS — ${WINDOWS.allTime.label}`, tracksAll);

console.log(`\n${'─'.repeat(78)}`);
console.log(`Unique artists resolved: ${details.size}/${artistIds.size}`);
if (details.size > 0) {
  // Live re-check of C11 (CLAUDE.md): Spotify dropped genres from the artist object. If this ever
  // prints a non-zero number, genres are back and the constraint needs revisiting.
  const withGenres = [...details.values()].filter((a) => (a.genres ?? []).length > 0).length;
  console.log(`Artists returning any genre (C11 says this should be 0): ${withGenres}/${details.size}`);
}
if (!writeCache && details.size > 0) console.log('Nothing was written to artists_cache (re-run with --cache to store these).');

// ---- optional JSON ----
if (outPath) {
  const artistRow = (row) => ({
    rank: row.rank,
    name: row.artist_name,
    spotifyId: row.artist_id ?? null,
    plays: Number(row.play_count),
    minutes: Math.round(Number(row.total_ms ?? 0) / 60000),
    details: row.artist_id ? (details.get(row.artist_id) ?? null) : null,
  });
  const trackRow = (row) => ({
    rank: row.rank,
    track: row.track_name,
    trackId: row.track_id,
    artistNames: row.artist_names ?? [],
    plays: Number(row.play_count),
    minutes: Math.round(Number(row.total_ms ?? 0) / 60000),
    artists: (trackArtists.get(row.track_id) ?? []).map((a) => ({
      name: a.name,
      spotifyId: a.id,
      details: details.get(a.id) ?? null,
    })),
  });
  const report = {
    generatedAt: new Date().toISOString(),
    profile: { id: profile.id, displayName: profile.display_name ?? null },
    spotifyDetailsAvailable: Boolean(accessToken),
    spotifyError,
    windows: {
      sixMonths: { since: WINDOWS.sixMonths.since.toISOString(), until: WINDOWS.sixMonths.until.toISOString() },
      allTime: { since: WINDOWS.allTime.since.toISOString(), until: WINDOWS.allTime.until.toISOString() },
    },
    topArtistsSixMonths: artists6m.map(artistRow),
    topArtistsAllTime: artistsAll.map(artistRow),
    topTracksSixMonths: tracks6m.map(trackRow),
    topTracksAllTime: tracksAll.map(trackRow),
  };
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`JSON written to ${outPath}`);
}

console.log('\nDone. ✅');
