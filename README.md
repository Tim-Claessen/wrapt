# Wrapt

A private Spotify listening dashboard for a two-person household — "Wrapped, all year round." Minutes listened, artist/track leaderboards with week-over-week movement, a full play-history log, imported Extended Streaming History, and an **Ask** page that answers natural-language questions about your own listening (Cloudflare Workers AI turns your question into a read-only SQL query, runs it against your `plays` data, and answers from the rows) plus a **Playlist** generator that drafts a real, Spotify-search-validated playlist from a plain-English brief and saves it to your account on request. Built with Astro + vanilla CSS/JS on Cloudflare Pages and Supabase.

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

   The **Ask** page needs the Workers AI binding, not an env var: it's declared as `"ai": { "binding": "AI" }` in `wrangler.jsonc`, which is what gives `locals.runtime.env.AI` to `npm run dev` (via `@astrojs/cloudflare`'s platform proxy). Local `env.AI.run()` calls proxy to the **real** Workers AI over the network, so `wrangler` must be authenticated (it already is on this machine — `wrangler whoami`). No extra `.env`/`.dev.vars` entry is required for it.
3. After adding a new var to either file, run `npm run generate-types` (`wrangler types`) to keep `worker-configuration.d.ts` in sync. (This also picks up new bindings like `AI` from `wrangler.jsonc`.)
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

**Workers AI binding (Ask page).** Unlike the secrets above, the `AI` binding is not set via the CLI — add it once in the Cloudflare Pages dashboard: **wrapt → Settings → Functions → Bindings → Add → Workers AI**, with variable name **`AI`**. Pages doesn't read `wrangler.jsonc` for bindings, so this dashboard step is required for `/ask` to work in production (the `wrangler.jsonc` entry only covers local `npm run dev`). Model is chosen in `src/lib/llm.ts` (`WORKERS_AI_MODEL`); swapping the provider to the Anthropic API later is a rewrite of that one module plus one secret.

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

  It prints before/after progress, then grinds through every `pending` track, sleeping through rate limits. Idempotent and resumable — safe to Ctrl-C and re-run (~2 tracks/sec un-throttled). On Windows you can just double-click **`grab-artist-info.bat`** (repo root) instead — it runs the same script and keeps the window open.
- **Ask (AI) — how it works & safety.** `/ask` is **text-to-SQL**: the model (`@cf/meta/llama-4-scout-17b-16e-instruct`, set in `src/lib/llm.ts`) writes one read-only SQL `SELECT` against the `plays`/`artists_cache` schema, which runs via the `run_ask_sql` RPC and is answered from the rows. Guardrails: `run_ask_sql` executes inside a **read-only transaction with a 5s statement timeout** (so a bad/expensive query can't damage or hang the DB), the app layer (`src/lib/ask.ts`) rejects anything that isn't a single `SELECT`/`WITH` (no semicolons, comments, or data-modifying CTEs), and results are capped at 1000 rows. **Not yet multi-user-isolated:** `run_ask_sql` runs as `service_role` and can read any profile's rows; the model is only *instructed* to filter by the caller's `profile_id`. That's fine while Tim is the only user — **before onboarding Zoe/others, add real per-user isolation** (a profile-scoped view or a row-security-bound role) in the `run_ask_sql` migration rather than trusting the prompt.
- **Ask (AI) usage cap.** `/ask` is capped at **50 questions per profile per day** (resets at AWST midnight), counted in the `ai_usage` table via the `bump_ai_usage` RPC. The remaining count shows quietly on `/settings`. To change the cap, edit `ASK_DAILY_LIMIT` in `src/lib/ask.ts`. Cost is Cloudflare Workers AI inference (metered on your Cloudflare account); the cap is the guardrail.
- **Playlist (AI) — how it works, safety & cap.** The `Playlist` tab on `/ask` drafts a playlist from a brief + familiarity dial, then resolves every candidate track against the real Spotify Search API before it's allowed to render or save (`src/lib/playlist.ts`) — nothing hallucinated ever reaches the screen. Capped at **10 generations per profile per day** (same `ai_usage`/`bump_ai_usage` mechanism as Ask, `kind='playlist'`, edit `PLAYLIST_DAILY_LIMIT` in `src/lib/playlist.ts` to change it); saving a generated playlist to Spotify is uncapped. Saving needs the `playlist-modify-private` scope (added to `SPOTIFY_SCOPES` alongside the original read scopes) — **connections made before this scope existed need one reconnect** via `/settings` → Reconnect Spotify before Save will work; generation itself works fine on old tokens.
- **Migrations.** The Supabase CLI isn't linked on this machine, so new migrations are hand-pasted into the Supabase Dashboard SQL editor in filename order (mirrored into `supabase/migrations/` for history). Check the dashboard, not just this repo, to know the live schema.
