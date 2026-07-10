# Wrapt

A private Spotify listening dashboard for a two-person household — "Wrapped, all year round." Minutes listened, artist/track leaderboards with week-over-week movement, a full play-history log, and imported Extended Streaming History. Built with Astro + vanilla CSS/JS on Cloudflare Pages and Supabase.

This README covers running and operating the app. For architecture, data model, design tokens, and build-time constraints (Spotify API limits, the Astro/Cloudflare version pin, security invariants), see [`CLAUDE.md`](CLAUDE.md).

## Prerequisites

- Node ≥ 22.12 (see `engines` in `package.json`)
- A Cloudflare account with the `wrapt` Pages project (Git-connected to this repo's `main` branch, custom domain `wrapt.timclaessen.com`)
- A Supabase project (Postgres + Auth)
- A Spotify Developer app (Client ID), with each user's Spotify account manually allowlisted (see Ops below)

## Local setup

1. `npm install`
2. Create two gitignored env files with the same values — both are required and must stay in sync:
   - `.env` (Vite-loaded, only `PUBLIC_*` vars reach client-side code)
   - `.dev.vars` (Wrangler-loaded, used for `locals.runtime.env` during `astro dev`)

   Required vars: `SPOTIFY_CLIENT_ID`, `SPOTIFY_REDIRECT_URI` (`http://127.0.0.1:4321/api/auth/callback` locally), `PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `TOKEN_ENC_KEY` (base64-encoded 32-byte AES-GCM key).
3. After adding a new var to either file, run `npm run generate-types` (`wrangler types`) to keep `worker-configuration.d.ts` in sync.
4. `npm run dev` — serves at `http://127.0.0.1:4321`.
5. `npm run check` (astro check) and `npm run build` should both pass before pushing — CI runs them on every push/PR to `main`.

To also run the sync worker locally: `npm run sync:dev`, then in another terminal `curl "http://127.0.0.1:8787/__scheduled?cron=0+*/2+*+*+*"` to trigger a cycle manually. It reads `workers/sync/.dev.vars` (same values as the root `.dev.vars`).

## Deploy

The Astro app is a Cloudflare **Pages** project; the sync worker is a **separate standalone Worker**. They deploy with different commands — don't mix them up (each targets a different product).

**Pages app:**

```
npm run build
npx wrangler pages deploy dist --project-name wrapt --branch main
```

**Sync worker** (`workers/sync/`, its own cron trigger and secret store):

```
npm run sync:deploy
```

Production env vars are secrets, not read from `.env`/`.dev.vars`. Set them per store (pipe the value in, never as a literal CLI arg):

```
wrangler pages secret put <NAME> --project-name wrapt          # Pages app
wrangler secret put <NAME> -c workers/sync/wrangler.jsonc      # sync worker
```

## Ops runbook

- **Spotify Premium dependency.** The Spotify app dies if the developer-account holder's Premium subscription lapses — the whole dashboard stops working for every allowlisted user, not just that one account. Don't let it lapse.
- **Allowlisting.** Spotify caps this app at 5 users, manually added in the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) under the app's user management (Client ID `d53d9e97...`). Launch is Tim + Zoe; invite-only beyond that.
- **Secret rotation.** Most secrets (Supabase keys) can be rotated normally — regenerate in the respective dashboard, then `wrangler pages secret put` / `wrangler secret put -c workers/sync/wrangler.jsonc` with the new value, in **both** stores. **`TOKEN_ENC_KEY` is the one exception — do not rotate it casually.** Stored ciphertexts are now versioned (`v1.<iv>.<ciphertext>`, see `src/lib/crypto.ts`), which lays the groundwork for a future `v2` key that could coexist with `v1` decrypts during a phased rotation — but that dual-key path doesn't exist yet. Today there's only the v1 key, so swapping `TOKEN_ENC_KEY` for new bytes makes every stored `refresh_token_enc` undecryptable, silently breaking sync for every connected user until each reconnects via `/connect`. Only rotate if it's actually been compromised, and expect to ask everyone to reconnect afterward.
- **Re-requesting your Spotify export (optional, periodic).** `/me/player/recently-played` only ever returns your last ~50 plays, and the sync cron polls every 2 hours — so an extended gap (the app down, or just not listening for a while) can permanently lose plays that Spotify's live API can no longer backfill. Every few months, consider re-requesting your Extended Streaming History export from [Spotify's privacy settings](https://www.spotify.com/account/privacy/) and re-uploading it via `/import`. Safe to re-run — `plays` ingestion is idempotent (unique on `profile_id` + `played_at`), so overlapping history just fills gaps rather than duplicating.
- **Backfilling listened-time (`ms_played`).** "Minutes listened" comes from each play's `ms_played`, which lives in the Extended Streaming History export (the live `/recently-played` API doesn't report it, so live plays fall back to full track length). If an import predates the `ms_played` column, or a `/import` upload stalls, backfill it in one shot locally:

  ```
  node scripts/backfill-ms-played.mjs "<path to export .zip or folder>"
  ```

  It dedups by timestamp, batches through the `ingest_import_plays` RPC, and prints the corrected last-30-day minutes. Idempotent, and reads DB creds from `.dev.vars`.
- **Draining the import enrichment backlog (album art / artist ids / true duration).** Imported plays need a per-track Spotify lookup to backfill album art, artist ids, and true duration. That only drains fast while the `/import` tab is open; once closed, only the 2-hourly cron runs (throttled), so a big backlog can look "stuck" for a long time. To finish it in one sitting locally:

  ```
  node scripts/backfill-enrichment.mjs
  ```

  It prints before/after progress, then grinds through every `pending` track, sleeping through rate limits. Idempotent and resumable — safe to Ctrl-C and re-run (~2 tracks/sec un-throttled).
- **Migrations.** The Supabase CLI isn't linked on this machine, so new migrations are hand-pasted into the Supabase Dashboard SQL editor in filename order (mirrored into `supabase/migrations/` for history). Check the dashboard, not just this repo, to know the live schema.

### Outstanding manual steps

- **Apply `supabase/migrations/20260709000005_awst_stats.sql`** in the Supabase Dashboard SQL editor if it hasn't been applied yet — it re-buckets the listening stats in AWST (`Australia/Perth`) so the heatmap/trends match the household's clock.
- **Run `node scripts/backfill-enrichment.mjs`** to clear the imported album-art / artist-id backlog (resumable; roughly a few hours at ~2 tracks/sec for a large backlog).
