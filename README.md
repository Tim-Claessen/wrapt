# Wrapt

A private Spotify listening dashboard for a two-person household — "Wrapped, all year round." Minutes listened, artist/track leaderboards with week-over-week movement, a full play-history log, imported Extended Streaming History, and an **Ask** page that answers natural-language questions about your own listening (Cloudflare Workers AI turns your question into a read-only SQL query, runs it against your `plays` data, and answers from the rows) plus a **Create** page that drafts a real, Spotify-search-validated playlist from a plain-English brief and saves it to your account on request. Built with Astro + vanilla CSS/JS on Cloudflare Pages and Supabase.

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

  **Don't put this on a recurring schedule** (Task Scheduler, cron, etc.). It refreshes the same Spotify refresh token as the 2-hourly sync worker, and Spotify rotates that token on every use — two processes refreshing it independently race each other, and whichever one holds the now-superseded copy gets `invalid_grant`. Run it by hand only when you actually need to grind through a big backlog fast; the sync worker already drains it automatically every cycle otherwise. See **Local scripts vs. the cron** below for the second hazard (the shared rate limit) that applies even to scripts which don't touch the refresh token.
- **Local scripts vs. the cron — the two ways to break sync from your laptop.** Any script in `scripts/` that calls Spotify shares state with the 2-hourly worker. There are two distinct hazards, and avoiding one does *not* avoid the other:

  1. **Refresh-token rotation** (only affects scripts that use the *user* token, i.e. `backfill-enrichment.mjs`). Covered directly above. Scripts that authenticate with the **client-credentials grant** — `artist-details.mjs` — are structurally immune: there is no refresh token in that flow to rotate.
  2. **The rate limit is per Client ID** (C10, ~30-second rolling window in dev mode), so *every* local script competes with the cron for the same budget, client-credentials or not. Fire a few hundred lookups from your laptop and the next cron cycle can eat `429`s.

  Hazard 2 degrades safely by design — `SpotifyRateLimitError` is a warn-and-skip, so the worker loses a **cycle, not data**. But skipping *repeatedly* is not harmless: `/me/player/recently-played` only holds the last ~50 plays, so a long enough stall during heavy listening loses plays permanently (same failure mode as the export re-request note above). Practical rule: keep bulk local runs small, and run them well clear of the top of an even hour — the cron fires on `0 */2 * * *` **UTC**, i.e. 08:00/10:00/…/18:00 AWST.
- **Artist artwork on the leaderboard (gradient tiles instead of photos).** The artist rows read their image *only* from `artists_cache`; no row means the duotone gradient placeholder, which looks like a design choice rather than missing data. Historically the cache was filled only for artists seen in **live** plays, so after a big history import almost every artist on the all-time board had no photo (measured 2026-07-25: 198 of the top 200). The cron now self-heals this — `backfillTopArtistImages` sweeps the 30d → 6m → all-time boards each cycle and fetches 25 missing artists, deliberately gentle so it can't crowd out the enrichment drain. It converges on its own; you only need the manual path after a large import if you don't want to wait:

  ```
  node scripts/artist-details.mjs --top 50 --cache
  ```

  Read-only without `--cache`; `--out <path.json>` also dumps the full report. It authenticates with the **client-credentials grant**, so unlike `backfill-enrichment.mjs` it never touches the user's refresh token — but it still shares the rate limit, so keep `--top` modest (see **Local scripts vs. the cron** above; `--top 250` is ~700 requests and will sit in `429` backoff for a long time). It writes every 25 artists, so Ctrl-C keeps its progress.

  Without `--top` it prints a standing report instead: the top 10 artists and top 10 tracks' artists, over both 6 months and all time, with play counts and minutes.
- **Spotify removed artist genres (C11).** As of 2026-07-25, `/v1/artists/{id}` returns only `id`/`name`/`images`/`href`/`uri`/`external_urls` — no `genres`, `followers` or `popularity`. So there is no genre data to be had, and none of it is coming back on its own. `artists_cache.genres` still exists as a column but is permanently empty; `/ask` is instructed to refuse genre questions rather than run a query that returns nothing and answer as if that were real. `artist-details.mjs` re-checks this on every run and prints `Artists returning any genre (C11 says this should be 0)` — if that ever prints non-zero, Spotify has reversed course and the constraint should be revisited.
- **Ask (AI) — how it works & safety.** `/ask` is **text-to-SQL**: the model (`@cf/meta/llama-4-scout-17b-16e-instruct`, set in `src/lib/llm.ts`) writes one read-only SQL `SELECT` against the `plays`/`artists_cache` schema, which runs via the `run_ask_sql` RPC and is answered from the rows. Guardrails: `run_ask_sql` executes inside a **read-only transaction with a 5s statement timeout** (so a bad/expensive query can't damage or hang the DB), the app layer (`src/lib/ask.ts`) rejects anything that isn't a single `SELECT`/`WITH` (no semicolons, comments, or data-modifying CTEs), and results are capped at 1000 rows. **Not yet multi-user-isolated:** `run_ask_sql` runs as `service_role` and can read any profile's rows; the model is only *instructed* to filter by the caller's `profile_id`. That's fine while Tim is the only user — **before onboarding Zoe/others, add real per-user isolation** (a profile-scoped view or a row-security-bound role) in the `run_ask_sql` migration rather than trusting the prompt.
- **Ask (AI) usage cap.** `/ask` is capped at **50 questions per profile per day** (resets at AWST midnight), counted in the `ai_usage` table via the `bump_ai_usage` RPC. The remaining count shows quietly on `/settings`. To change the cap, edit `ASK_DAILY_LIMIT` in `src/lib/ask.ts`. Cost is Cloudflare Workers AI inference (metered on your Cloudflare account); the cap is the guardrail.
- **Create (AI playlists) — how it works, safety & cap.** `/create` drafts a playlist from a brief + familiarity dial, then resolves every candidate track against the real Spotify Search API before it's allowed to render or save (`src/lib/playlist.ts`) — nothing hallucinated ever reaches the screen. A brief that only partially matches (e.g. a narrow genre/region combo) still shows whatever resolved, honestly flagged, rather than refusing outright. Capped at **10 generations per profile per day** (same `ai_usage`/`bump_ai_usage` mechanism as Ask, `kind='playlist'`, edit `PLAYLIST_DAILY_LIMIT` in `src/lib/playlist.ts` to change it); saving a generated playlist to Spotify is uncapped. Saving needs the `playlist-modify-private` scope (added to `SPOTIFY_SCOPES` alongside the original read scopes) — **connections made before this scope existed need one reconnect** via `/settings` → Reconnect Spotify before Save will work; generation itself works fine on old tokens.
- **Migrations.** The Supabase CLI isn't linked on this machine, so new migrations are hand-pasted into the Supabase Dashboard SQL editor in filename order (mirrored into `supabase/migrations/` for history). Check the dashboard, not just this repo, to know the live schema.
- **Sync worker health / troubleshooting.** If new plays stop showing up, check `/settings` ("last sync that added songs") first. A genuine per-profile failure (expired token, unexpected error) throws once at the end of the cycle rather than just logging, so it shows up as a real invocation error in the Cloudflare dashboard (Workers & Pages → `wrapt-sync` → Logs/exceptions) — rate-limit skips stay quiet since those self-heal within the cycle (C10). No alert is currently wired up for it (Cloudflare's per-script Workers error alerting wasn't discoverable in the dashboard as of 2026-07); if that changes, scope it to the `wrapt-sync` script and deliver to email. To reproduce/debug locally against real prod data: `npm run sync:dev`, then in another terminal `curl "http://127.0.0.1:8787/__scheduled?cron=0+*/2+*+*+*"` — it reads `workers/sync/.dev.vars`, so console output shows the real failure.
