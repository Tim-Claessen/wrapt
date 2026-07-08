# Wrapt

A personal Spotify listening dashboard for a two-person household — "Wrapped, all year round." Recently played, top artists/tracks, week-over-week movement, and deep-dive listening stats, built with Astro + vanilla CSS/JS on Cloudflare Pages and Supabase.

This README covers running and operating the app. For architecture, data model, and build-time constraints (Spotify API limits, the Astro/Cloudflare version pin, etc.), see [`CLAUDE.md`](CLAUDE.md) and [`spotify-dashboard-sdd.md`](spotify-dashboard-sdd.md).

## Prerequisites

- Node ≥ 22.12 (see `engines` in `package.json`)
- A Cloudflare account with the `wrapt` Pages project (Git-connected to this repo's `main` branch, custom domain `wrapt.timclaessen.com`)
- A Supabase project (Postgres + Auth)
- A Spotify Developer app (Client ID/secret), with each user's Spotify account manually allowlisted (see Ops below)

## Local setup

1. `npm install`
2. Create two gitignored env files with the same values — both are required and must stay in sync:
   - `.env` (Vite-loaded, only `PUBLIC_*` vars reach client-side code)
   - `.dev.vars` (Wrangler-loaded, used for `locals.runtime.env` during `astro dev`)

   Required vars: `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REDIRECT_URI` (`http://127.0.0.1:4321/api/auth/callback` locally), `PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `TOKEN_ENC_KEY` (base64-encoded 32-byte AES-GCM key).
3. After adding a new var to either file, run `npm run generate-types` (`wrangler types`) to keep `worker-configuration.d.ts` in sync.
4. `npm run dev` — serves at `http://127.0.0.1:4321`.

To also run the sync worker locally: `npm run sync:dev`, then in another terminal `curl "http://127.0.0.1:8787/__scheduled?cron=0+*/2+*+*+*"` to trigger a cycle manually. It reads `workers/sync/.dev.vars` (same values as the root `.dev.vars`).

## Deploy

```
npm run build
npx wrangler pages deploy dist --project-name wrapt --branch main
```

Production env vars are Cloudflare Pages **secrets**, not read from `.env`/`.dev.vars`:

```
wrangler pages secret put <NAME> --project-name wrapt   # pipe the value in, never as a literal arg
```

The sync worker (`workers/sync/`) is a separate standalone Cloudflare Worker (its own cron trigger, not a Pages Function) with its own secret store:

```
npm run sync:deploy
wrangler secret put <NAME> -c workers/sync/wrangler.jsonc
```

## Ops runbook

- **Spotify Premium dependency.** The Spotify app dies if the developer-account holder's Premium subscription lapses — the whole dashboard stops working for every allowlisted user, not just that one account. Don't let it lapse.
- **Allowlisting.** Spotify caps this app at 5 users, manually added in the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) under the app's user management (Client ID `d53d9e97...`). Launch is Tim + Zoe; invite-only beyond that.
- **Secret rotation.** Most secrets (Spotify client secret, Supabase keys) can be rotated normally — regenerate in the respective dashboard, then `wrangler pages secret put` / `wrangler secret put -c workers/sync/wrangler.jsonc` with the new value. **`TOKEN_ENC_KEY` is the one exception — do not rotate it casually.** It has no key-versioning scheme (`src/lib/crypto.ts`): rotating it makes every already-stored `refresh_token_enc` value undecryptable, silently breaking sync for every connected user until each one reconnects via `/connect`. Only rotate it if it's actually been compromised, and expect to ask everyone to reconnect afterward.
- **Re-requesting your Spotify export (optional, periodic).** `/me/player/recently-played` only ever returns your last ~50 plays, and the sync cron polls every 2 hours — so an extended gap (the app down, or just not listening for a while) can permanently lose plays that Spotify's live API can no longer backfill. Every few months, consider re-requesting your Extended Streaming History export from [Spotify's privacy settings](https://www.spotify.com/account/privacy/) and re-uploading it via `/import`. This is safe to re-run — `plays` ingestion is idempotent (unique on `profile_id` + `played_at`), so overlapping history just fills in any gaps rather than duplicating.
- **Outstanding manual step:** none currently — migrations, the production Spotify redirect URI, and all Cloudflare secrets (Pages + sync worker) are confirmed in place as of 2026-07-08.
