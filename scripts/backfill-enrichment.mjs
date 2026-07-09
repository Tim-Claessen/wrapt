// One-shot local drain of the import enrichment backlog (artist ids, album art, true duration for
// imported plays). It resolves every `pending` track in import_track_enrichment via Spotify's
// single-track endpoint and applies the metadata — the same work the /import tab and the 2-hourly
// cron do, but run locally so it can grind through a big backlog in one sitting, sleeping through
// rate limits instead of abandoning the cycle.
//
// Why you'd run this: enrichment only drains fast while the /import tab is open; once closed, only
// the throttled cron runs, so a large import can look "stuck" for a long time. This finishes it.
//
// Usage:   node scripts/backfill-enrichment.mjs
// Reads DB creds, TOKEN_ENC_KEY and SPOTIFY_CLIENT_ID from .dev.vars in the repo root. Idempotent
// and resumable — safe to stop (Ctrl-C) and re-run; it picks up wherever it left off.

import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API_BASE = 'https://api.spotify.com/v1';
const SELECT_PAGE = 1000; // pending ids fetched per outer pass
const PACING_MS = 200; // gap between track lookups — keeps under the dev-mode rate window
const RATE_LIMIT_MAX_WAIT_S = 60;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- env ----
const vars = {};
for (const raw of readFileSync('.dev.vars', 'utf8').split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) continue;
  const eq = line.indexOf('=');
  if (eq === -1) continue;
  vars[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^"|"$/g, '');
}
for (const key of ['PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'TOKEN_ENC_KEY', 'SPOTIFY_CLIENT_ID']) {
  if (!vars[key]) {
    console.error(`Missing ${key} in .dev.vars`);
    process.exit(1);
  }
}
const sb = createClient(vars.PUBLIC_SUPABASE_URL, vars.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// ---- AES-GCM decrypt/encrypt (mirrors src/lib/crypto.ts) ----
const fromB64 = (v) => Uint8Array.from(atob(v), (c) => c.charCodeAt(0));
const toB64 = (bytes) => btoa(String.fromCharCode(...bytes));

async function importKey() {
  return crypto.subtle.importKey('raw', fromB64(vars.TOKEN_ENC_KEY), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function decryptToken(encrypted) {
  const [iv, data] = encrypted.split('.');
  const key = await importKey();
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv) }, key, fromB64(data));
  return new TextDecoder().decode(plain);
}
async function encryptToken(plaintext) {
  const key = await importKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  return `${toB64(iv)}.${toB64(new Uint8Array(ct))}`;
}

// ---- profile + token ----
const { data: profiles } = await sb.from('spotify_profiles').select('id, user_id, display_name, refresh_token_enc');
if (!profiles?.length) {
  console.error('No spotify_profiles row found.');
  process.exit(1);
}
const profile = profiles[0];
console.log(`Profile: ${profile.display_name ?? profile.id} (${profile.id})`);

let refreshToken = await decryptToken(profile.refresh_token_enc);
let accessToken = null;

async function refreshAccessToken() {
  const body = new URLSearchParams({
    client_id: vars.SPOTIFY_CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 400 && text.includes('invalid_grant')) {
      console.error('\nSpotify refresh token is invalid/revoked — reconnect at /connect, then re-run.');
      process.exit(1);
    }
    console.error(`\nToken refresh failed: ${res.status} ${text}`);
    process.exit(1);
  }
  const json = await res.json();
  accessToken = json.access_token;
  if (json.refresh_token && json.refresh_token !== refreshToken) {
    refreshToken = json.refresh_token;
    const enc = await encryptToken(refreshToken);
    await sb.from('spotify_profiles').update({ refresh_token_enc: enc }).eq('id', profile.id);
  }
}
await refreshAccessToken();

// ---- diagnostic ----
async function printProgress(prefix) {
  const { data } = await sb.rpc('import_progress', { p_profile_id: profile.id });
  const p = data?.[0] ?? { total: 0, done: 0, failed: 0, pending: 0 };
  console.log(`${prefix} total ${p.total} · done ${p.done} · failed ${p.failed} · pending ${p.pending}`);
  return Number(p.pending);
}
console.log('');
const startPending = await printProgress('Before:');
if (startPending === 0) {
  console.log('\nNothing pending — enrichment is already complete. ✅');
  process.exit(0);
}

// ---- getTrack with 429 backoff + 401 token refresh ----
async function getTrack(trackId) {
  for (;;) {
    const res = await fetch(`${API_BASE}/tracks/${trackId}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (res.status === 401) {
      await refreshAccessToken();
      continue;
    }
    if (res.status === 429) {
      const wait = Math.min(Number(res.headers.get('Retry-After') ?? '1') || 1, RATE_LIMIT_MAX_WAIT_S);
      process.stdout.write(`\r  rate limited — waiting ${wait}s…            `);
      await sleep(wait * 1000);
      continue;
    }
    if (res.status === 404) return { notFound: true };
    if (!res.ok) throw new Error(`track ${trackId}: ${res.status} ${await res.text()}`);
    return { track: await res.json() };
  }
}

// ---- drain loop ----
const handled = new Set();
let resolved = 0;
let failed = 0;
let transient = 0;

for (;;) {
  const { data: pendingRows, error } = await sb
    .from('import_track_enrichment')
    .select('track_id')
    .eq('status', 'pending')
    .order('updated_at', { ascending: true })
    .limit(SELECT_PAGE);
  if (error) {
    console.error(`\nFailed to read backlog: ${error.message}`);
    process.exit(1);
  }
  const batch = (pendingRows ?? []).map((r) => r.track_id).filter((id) => !handled.has(id));
  if (batch.length === 0) break; // nothing left we haven't already attempted this run

  for (let i = 0; i < batch.length; i++) {
    const trackId = batch[i];
    handled.add(trackId);
    if (i > 0) await sleep(PACING_MS);
    try {
      const { track, notFound } = await getTrack(trackId);
      if (notFound) {
        await sb.rpc('mark_track_enrichment_failed', { p_track_id: trackId, p_error: 'not found' });
        failed++;
      } else {
        await sb.rpc('enrich_apply_track_metadata', {
          p_track_id: trackId,
          p_artist_ids: track.artists.map((a) => a.id),
          p_artist_names: track.artists.map((a) => a.name),
          p_album_image: track.album?.images?.[0]?.url ?? null,
          p_duration_ms: track.duration_ms,
        });
        resolved++;
      }
    } catch (err) {
      // Transient (network/5xx) — leave it pending for a later pass, don't burn a failure attempt.
      transient++;
      console.error(`\n  ${trackId}: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.stdout.write(`\r  resolved ${resolved} · failed ${failed} · transient ${transient} (this run)      `);
  }
}

console.log('\n');
await printProgress('After: ');
console.log('\nDone. ✅');
