// One-shot backfill of plays.ms_played from a Spotify "Extended Streaming History" export.
//
// Why this exists: the original import discarded ms_played, and the web re-upload path was hitting
// an ON CONFLICT bug on same-timestamp plays (fixed in 20260709000003). This runs the backfill
// locally, deduped by timestamp so it's immune to that bug, straight against the DB via the proven
// ingest_import_plays RPC. Idempotent — safe to run more than once.
//
// Usage:
//   node scripts/backfill-ms-played.mjs "C:\path\to\my_spotify_data.zip"
//   node scripts/backfill-ms-played.mjs "C:\path\to\folder-of-json-files"
//   node scripts/backfill-ms-played.mjs "C:\path\to\Streaming_History_Audio_2023.json"
//
// Reads DB creds from .dev.vars in the repo root.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { createClient } from '@supabase/supabase-js';

const target = process.argv[2];
if (!target) {
  console.error('Usage: node scripts/backfill-ms-played.mjs <export.zip | folder | *.json>');
  process.exit(1);
}

const vars = {};
for (const raw of readFileSync('.dev.vars', 'utf8').split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) continue;
  const eq = line.indexOf('=');
  if (eq === -1) continue;
  vars[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^"|"$/g, '');
}
const sb = createClient(vars.PUBLIC_SUPABASE_URL, vars.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const AUDIO = /Streaming_History_Audio_.*\.json$/i;
const PREFIX = 'spotify:track:';

// ---- collect history JSON text from a zip, folder, or single file ----
const jsonTexts = [];
const st = statSync(target);
if (st.isDirectory()) {
  for (const f of readdirSync(target)) if (AUDIO.test(f)) jsonTexts.push(readFileSync(join(target, f), 'utf8'));
} else if (target.toLowerCase().endsWith('.zip')) {
  const files = unzipSync(readFileSync(target));
  for (const [path, bytes] of Object.entries(files)) {
    const base = path.split('/').pop() ?? path;
    if (AUDIO.test(base)) jsonTexts.push(Buffer.from(bytes).toString('utf8'));
  }
} else if (AUDIO.test(target)) {
  jsonTexts.push(readFileSync(target, 'utf8'));
} else {
  console.error('Give a .zip, a folder, or a Streaming_History_Audio_*.json file.');
  process.exit(1);
}
console.log(`Found ${jsonTexts.length} history file(s).`);
if (jsonTexts.length === 0) process.exit(1);

// ---- profile ----
const { data: profiles } = await sb.from('spotify_profiles').select('id, display_name');
if (!profiles?.length) {
  console.error('No spotify_profiles row found.');
  process.exit(1);
}
const profile = profiles[0];
console.log(`Profile: ${profile.display_name} (${profile.id})`);

// ---- parse + filter, then dedup by timestamp (keep the largest ms_played) ----
const byTs = new Map();
let seen = 0;
for (const text of jsonTexts) {
  let arr;
  try {
    arr = JSON.parse(text);
  } catch {
    continue;
  }
  if (!Array.isArray(arr)) continue;
  for (const raw of arr) {
    seen++;
    const uri = raw.spotify_track_uri;
    const ms = raw.ms_played;
    if (
      typeof uri !== 'string' ||
      !uri.startsWith(PREFIX) ||
      raw.episode_name != null ||
      raw.audiobook_uri != null ||
      typeof ms !== 'number' ||
      ms < 30000
    ) {
      continue;
    }
    const row = {
      profile_id: profile.id,
      played_at: raw.ts,
      track_id: uri.slice(PREFIX.length),
      track_name: raw.master_metadata_track_name ?? '',
      artist_names: [raw.master_metadata_album_artist_name ?? ''],
      ms_played: ms,
    };
    const existing = byTs.get(row.played_at);
    if (!existing || row.ms_played > existing.ms_played) byTs.set(row.played_at, row);
  }
}
const rows = [...byTs.values()];
console.log(`Scanned ${seen} entries → ${rows.length} eligible plays (deduped by timestamp).`);

// ---- batch through ingest_import_plays ----
const BATCH = 500;
let processed = 0;
let inserted = 0;
for (let i = 0; i < rows.length; i += BATCH) {
  const batch = rows.slice(i, i + BATCH);
  const { data, error } = await sb.rpc('ingest_import_plays', { p_rows: batch });
  if (error) {
    console.error(`\nBatch at row ${i} failed: ${error.message}`);
    process.exit(1);
  }
  inserted += data ?? 0;
  processed += batch.length;
  process.stdout.write(`\r  ${processed}/${rows.length} processed…`);
}
console.log(`\nDone: ${processed} rows sent, ${inserted} new, ${processed - inserted} existing rows backfilled with ms_played.`);

// ---- verify last 30 days ----
const now = new Date();
const since30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
const { data: sum } = await sb.rpc('listening_summary', {
  p_profile_id: profile.id,
  p_since: since30.toISOString(),
  p_until: now.toISOString(),
});
const s = sum?.[0];
if (s) {
  const mins = Math.round(Number(s.total_ms) / 60000);
  console.log(`\nLast 30 days now: ${mins.toLocaleString()} min (${(mins / 60).toFixed(1)}h) across ${s.total_plays} plays.`);
}
