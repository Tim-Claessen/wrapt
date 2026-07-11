# Wrapt — build notes for Claude Code

## What this is

A private, multi-user Spotify listening dashboard for a two-person household — a seamless, year-round "Spotify Wrapped" experience. Dark, artwork-led, one gold accent, mobile-first (assume a phone unless told otherwise). Playful, warm voice — one light line per screen, never at the expense of clarity.

**Multi-user, not single-user:** the data model supports up to 5 allowlisted Spotify users (launch = Tim + Zoe). **Every table is scoped by `profile_id`/`user_id` — never assume a singleton user when writing queries.**

## Stack

- **Astro** (`output: 'server'`) + **vanilla CSS + vanilla JS** on **Cloudflare Pages**. No React/Vue/Svelte, no CSS framework, no CSS-in-JS. Layout with CSS grid/flex + `gap` and simple CSS transitions.
- **Supabase**: Postgres + Auth (email + password) + RLS.
- A **standalone Cloudflare Worker** (`workers/sync/`) runs the 2-hourly sync cron.
- **No client-side data fetching** for page content — data loads in Astro frontmatter and renders server-side. (The only client JS is small progressive-enhancement scripts: the import uploader, the skeleton swap, Supabase auth in `<script>` tags.)
- Design tokens are **CSS custom properties** in `:root` (in `src/layouts/AppShell.astro`). `--gold` is themeable — read it everywhere, never hardcode the hex.
- Fonts: `Schibsted Grotesk` + `Space Mono` via a Google Fonts `<link>` (with preconnect).
- **No audio-feature visualisations** — that data isn't available from Spotify (C4). The story is rankings, recency, listened-time, and period-over-period change. Never invent tempo/energy/valence charts.

## Design tokens & direction

**Colour** — near-black warm background; album artwork carries the colour; one restrained gold accent. These are the live `:root` values (source of truth: `AppShell.astro`):

| Token | Value | Use |
|---|---|---|
| `--bg` | `#08080a` | App/page background (body uses `radial-gradient(120% 80% at 50% -10%,#131117,#08080a 60%)`) |
| `--surface` | `#0d0c0a` | Screen / card surface |
| `--surface-raised` | `rgba(255,255,255,0.05)` | Inputs, toggles, subtle fills |
| `--hairline` | `rgba(255,255,255,0.07)` | Borders, dividers |
| `--text-1` | `#f2efe8` | Primary text (warm white) |
| `--text-2` | `#9a948a` | Secondary text |
| `--text-3` | `#625d54` | Muted / metadata |
| `--text-4` | `#4a453d` | Faintest (counts, chevrons) |
| `--gold` | `#d0a24e` | **Accent** — CTAs, ranks, "NEW", active nav/toggle. Themeable. |
| `--gold-on` | `#12100b` | Text/icon on gold fills |
| `--up` | `#8bb996` | Climbers / positive delta — muted sage |
| `--down` | `#d99a9a` | Fallers / negative delta — muted rose |

Only two semantic colours beyond the accent (`--up`/`--down`), both low-chroma. Don't introduce more.

**Typography** — `Schibsted Grotesk` (400/500/600/700) for display/body/UI; `Space Mono` (400/700) for **all numerals, eyebrow labels, deltas, times, and play counts** (the "chart ticker" feel; global `.mono` class). No third family.

**Spacing / shape** — screen horizontal padding 20px; card radius ~14–16, thumb/art radius ~10, pill/input/toggle radius ~13; grid gap 16; list-row vertical padding 9–12; min hit target 44px.

**Album art** — use real Spotify image URLs; keep a duotone gradient tile (`linear-gradient(140deg,…)`) as the fallback/loading placeholder. **Top-artist art = circle; track/playlist art = rounded square** — keep that distinction.

**Motion** (CSS-only, no JS animation libs) — `riseIn` (opacity + `translateY`) staggered ~50ms/row for countdown-style reveals; `shimmer` for loading skeletons (a couple of blocks offset 150–200ms); toggle pill transition `.18s ease`.

## Architecture & real constraints

### Version pin (and why) + how env is read

- Pinned to **Astro `5.18.2`** + **`@astrojs/cloudflare` `12.6.13`** — *not* latest. Astro `7.x` + `@astrojs/cloudflare` `14.x` (what `astro add cloudflare` installs today) run a real `workerd` isolate even in `astro dev`, and that combination has a day-one bug: any render error crashes Astro's own JSON logger with `process is not defined` (it assumes Node's `process`, which doesn't exist in `workerd`), masking the real error so every request 500s. **Don't upgrade past `astro@6` / `@astrojs/cloudflare@13` without first re-testing `astro dev`.**
- Because of that pin, server-side env vars/bindings are read via **`Astro.locals.runtime.env`** (typed in `src/env.d.ts` as `Runtime<Env>`, `Env` from the Wrangler-generated `worker-configuration.d.ts`). **Not** `import { env } from 'cloudflare:workers'` (that's the v6+ API — wrong for this pin). `import.meta.env.PUBLIC_*` is still correct for **client-side** code (Vite build-time inlining).

### Local dev: two env files + generated types

- `.env` (Vite-loaded — only `PUBLIC_*` vars reach client code) **and** `.dev.vars` (Wrangler-loaded — all vars, used for `locals.runtime.env` during `astro dev`) must **both** exist and stay in sync. Both are gitignored.
- After adding a var to either file, run `npm run generate-types` (= `wrangler types`) to keep `worker-configuration.d.ts` in sync.
- `workers/sync/` has its own `.dev.vars` (same values as the root one).

### Supabase & migrations

- Client/session handling via `@supabase/ssr`: `createBrowserClient` in page `<script>` tags, `createServerClient` in `src/lib/supabase.ts` bound to Astro's `request`/`cookies`. Astro's `AstroCookies` has no `getAll()`, so the cookie adapter parses the raw `Cookie` header manually.
- `createSupabaseServiceClient()` uses the **service-role key and must only be called from server code** (API routes, `.astro` frontmatter, the sync worker) — never shipped to the client.
- **Migrations** live in `supabase/migrations/*.sql`. The Supabase CLI isn't linked on this machine (`db push` has never run here), so migrations are **hand-pasted into the Supabase Dashboard SQL editor**, in filename order, and mirrored into a file here for history. Write every migration to be **self-contained and idempotent** (it may be pasted, re-pasted, and re-run). To know the live schema, check the dashboard, not just this repo.

### Deploy topology

- The Astro app deploys to the Cloudflare **Pages** project `wrapt` (Git-connected to `main`, custom domain `wrapt.timclaessen.com`). Production env vars are **Pages secrets**, not read from `.env`/`.dev.vars`.
- `workers/sync/` is a **separate standalone Worker** with its own `wrangler.jsonc`, cron trigger (`0 */2 * * *`), and secret store. It can't live inside the Pages app: `@astrojs/cloudflare` 12.x has no scheduled-handler support at this pin. It imports directly from `../../src/lib/*` (those modules have no Astro-only runtime deps).
- **Footgun:** the Pages app is published with `wrangler pages deploy`; the sync worker with `wrangler deploy`. They target different products — using the wrong command deploys to the wrong place. Exact commands live in `README.md`.
- `SPOTIFY_REDIRECT_URI` differs by environment: `http://127.0.0.1:4321/api/auth/callback` locally, `https://wrapt.timclaessen.com/api/auth/callback` in production (C3 — one Client ID, separate redirect URIs per env).

### Spotify API constraints register (post-Feb-2026 rules)

These are externally imposed by Spotify — things that break if ignored.

| # | Constraint | Design response |
|---|-----------|-----------------|
| C1 | Max 5 users, manually allowlisted in the Spotify dashboard | Launch Tim + Zoe; invite-only thereafter |
| C2 | App owner must hold active Spotify Premium; the app dies for everyone if it lapses | Don't let Tim's Premium lapse |
| C3 | 1 Client ID per developer | Single app for dev + prod; separate redirect URIs per environment |
| C4 | Recommendations & audio features unavailable | No tempo/energy/valence UI, ever |
| C5 | Search capped at 10 results/request (default 5) | Paginate; batch track-validation searches server-side |
| C6 | Batch fetch endpoints removed (one request per track/artist) | Aggressive Supabase caching; queue + backoff on 429 |
| C7 | `popularity`, user `email`/`country`/`product` fields removed | Identity keyed on Spotify user ID; no popularity-based sorting |
| C8 | Playlist items only readable for owned/collaborative playlists | Show own playlists only |
| C9 | Playlist endpoints renamed: `/playlists/{id}/items`, `POST /me/playlists` | Build against the new names |
| C10 | Dev-mode rate limits (30-second rolling window) | Server-side caching + scheduled sync, not live fan-out |

Every Spotify HTTP call (token grant + Web API) funnels through `spotifyRequest()` in `src/lib/spotify.ts`, which retries on `429` honouring `Retry-After` (bounded) before throwing `SpotifyRateLimitError`; the sync cron catches that and skips the profile for the cycle rather than blocking the whole run.

### Security invariants

- **Read-only Spotify scopes only:** `user-read-recently-played`, `playlist-read-private`. Never request write/modify scopes — *"we only read what you play, never post"* is a product commitment, not just a default. (Adding `playlist-modify-*` would only be needed for a future AI-playlist push, and changes the privacy promise — flag it to Tim before doing so.)
- **Refresh tokens are AES-GCM encrypted at rest** (`src/lib/crypto.ts`, key = `TOKEN_ENC_KEY`). Ciphertexts are versioned `v1.<base64 iv>.<base64 ciphertext>`; `decryptToken` also accepts legacy unprefixed values, so a future `v2` key rotation can coexist with `v1` decrypts.
- **`spotify_profiles.refresh_token_enc` is locked down with column-level Postgres grants**, not just RLS — RLS filters rows, not columns, so a user's own row would otherwise expose their own encrypted token to the anon-key client. No insert/update/delete grants exist for `authenticated`/`anon`; every write goes through the service-role client server-side.
- Spotify tokens never touch the client; every Spotify call is server-side. OAuth uses Authorization Code + **PKCE** (public client, no client secret in the exchange) with `state` + PKCE cookies.
- **`/ask` is model-generated text-to-SQL** (Cloudflare Workers AI → one read-only `SELECT` → answer from rows; `src/lib/ask.ts` + the `run_ask_sql` RPC). This was a deliberate product-owner call (Tim, 2026-07) — the early spec's "never text-to-SQL / fixed tool whitelist" rule was **intentionally overridden** for a true "ask anything" over the data. It's kept safe by a read-only transaction + statement timeout in `run_ask_sql` and an app-layer single-`SELECT` guard, but it is **NOT profile-isolated at the DB level yet** (runs as `service_role`, only *prompted* to scope by `profile_id`). Fine while Tim is the sole user — **add real per-user isolation before onboarding anyone else** (see the `run_ask_sql` migration header). LLM access is wrapped in `src/lib/llm.ts` so swapping Workers AI for the Anthropic API is one module + one secret.

### Listening-time maths

- Every "minutes listened" figure sums **`coalesce(ms_played, duration_ms, 0)`**. `plays.ms_played` is the real listened-time (present in the Extended Streaming History import; null for live-synced rows, which fall back to the track's full `duration_ms`).

## Auth flow

`/signup` or `/login` (email + password via the `@supabase/ssr` browser client) → `/connect` → `/api/auth/spotify` (generates PKCE verifier/challenge + state in short-lived httpOnly cookies, redirects to Spotify) → Spotify → `/api/auth/callback` (verifies `state`, exchanges `code` + `code_verifier` for tokens — no client secret — encrypts the refresh token, upserts `spotify_profiles` via the service-role client) → `/`.

- **Shared page gate:** `src/lib/auth.ts` — `requireUser(Astro)` (session → redirect `/login`) and `requireProfile(Astro, columns)` (session + `spotify_profiles` row → redirect `/connect`). Each returns the resolved context or a redirect `Response` the page returns as-is. Use these in authed pages instead of re-implementing the dance.
- `src/lib/tokens.ts` — `getValidSpotifyAccessToken(userId, env)`: decrypts the stored refresh token, calls Spotify's refresh grant, re-encrypts + persists if Spotify rotated it. Called fresh per request (no access-token caching yet).
- Expired/revoked refresh tokens surface as `SpotifyTokenExpiredError` (thrown on `invalid_grant`); callers redirect the user to `/connect?error=token_expired` to reconnect. `/connect` redirects already-connected users to `/` **except** during an explicit reconnect (`?error=…`), where the row exists but the token is dead.

## Data model & leaderboard

- **`plays`** — the durable per-play log. `UNIQUE (profile_id, played_at)` makes every write idempotent, so the sync cron can safely re-fetch overlapping ranges. `spotify_profiles.plays_cursor_after_ms` tracks the latest ingested `played_at` and is passed back to Spotify as the `after` cursor (a dedicated column — *not* `last_synced_at`, which bumps on every token mint including plain dashboard visits).
- **Imported history** ingests through the **`ingest_import_plays(jsonb)`** RPC (INSERT … ON CONFLICT DO UPDATE `ms_played`). The RPC **must dedup the incoming batch by `(profile_id, played_at)`** — two plays sharing a second-precision timestamp otherwise throw *"ON CONFLICT DO UPDATE command cannot affect row a second time"* and 500 the batch.
- **`artists_cache`** — genres/image per Spotify artist id, fetched one-by-one (C6) and refreshed lazily.
- **Import enrichment:** imported plays need a per-track `/v1/tracks/{id}` lookup to backfill `artist_ids`/album art/`duration_ms` (`import_track_enrichment` queue, `src/lib/import.ts`). It drains fast only while the `/import` tab is open (foreground tick loop); otherwise the 2-hourly cron drains it in bounded, paced rounds. `scripts/backfill-enrichment.mjs` clears a big backlog in one local run.
- **Leaderboard** (`src/lib/leaderboard.ts`, rendered by `src/pages/index.astro` → `Leaderboard.astro`): **every window is computed from `plays`** via Postgres RPCs (`supabase/migrations/…leaderboard_functions.sql`). Windows are `7d` / `30d` / `6m` / `all` / `custom`. Each diffs against the immediately-preceding equal-length window for real rank movement (NEW / ▲ / ▼); `all` is the one window with no comparable prior period (`hasMovement` false). Artist rankings group by **lowercased artist name** so imported plays rank immediately. Every row carries `total_ms`. Drill-down: `?artist=<name>` filters `leaderboard_top_tracks` to one artist. All `leaderboard_*` RPCs are **`service_role`-only** — call via `createSupabaseServiceClient()` after verifying the caller's session with the request-scoped client. The dashboard needs no Spotify token (it's pure DB).

## Pages, nav & routes

- **Nav** (`src/components/AppNav.astro`) is a mobile bottom bar / desktop left rail: **Home (`/`) · Ask (`/ask`) · History (`/history`) · Import (`/import`) · Settings (`/settings`)**. Only pages that pass `nav` to `AppShell` show it; auth screens don't.
- **`/` (dashboard)** — `MinutesHero` (minutes headline over an album-art mosaic) + `Leaderboard` + `TrendChart` + `ListeningHeatmap`, driven by window/kind/custom-date URL params. Shared param parsing in `src/lib/params.ts` (invalid date params degrade to the default window rather than erroring). Loading is a `Skeleton` swapped in on same-page filter navigations via `astro:before-preparation`.
- **`/ask`** — natural-language questions about your own listening, answered via **model-generated text-to-SQL** (see the security-invariants note). Ephemeral chat UI (vanilla JS, same convention-bend as `/import`), a two-tab `Ask` / `Playlist` switcher (Playlist is a "coming soon" `EmptyState` until the next prompt), and a per-day question cap. Flow: `src/pages/ask.astro` posts to `src/pages/api/ask.ts` → `runAskAgent` (`src/lib/ask.ts`) loops the model (≤4 queries) through the `query_database` tool → `run_ask_sql` RPC → answers from the rows, optionally with a result table. LLM access is wrapped in `src/lib/llm.ts` (Cloudflare Workers AI `AI` binding, `@cf/meta/llama-4-scout-17b-16e-instruct`; **OpenAI-style tool schema** — the native `{name,parameters}` form is rejected `8001 Invalid input`, and tool results are fed back as a `user` turn, not `role:'tool'`). Needs the `AI` binding added in the Cloudflare Pages dashboard (see README).
- **`/history`** — chronological, paginated play log with date-range + free-text filters and a hero stat row (`src/lib/history.ts`).
- **`/settings`** — Spotify connection + "last upload / last sync / last sync that added songs" (all derived from existing columns), enrichment progress, Reconnect button.
- **`/import`** — self-serve Extended Streaming History upload (zip/json parsed client-side with `fflate`, batched to `/api/import/*`).
- **Time zone:** timestamps and day/hour buckets display in a pinned zone, `DISPLAY_TIME_ZONE` in `src/lib/format.ts` = `Australia/Perth` (AWST — the household's zone; SSR runs UTC on Cloudflare). The stats RPCs bucket in AWST via `at time zone 'Australia/Perth'` — **keep that string in sync with `DISPLAY_TIME_ZONE`.** If we ever go per-user, both become a per-profile lookup.

## Conventions

- Match the surrounding code: Astro components carry their own scoped `<style>`, use design tokens via CSS custom properties, and add no client JS beyond what already exists.
- `npm run check` (astro check) and `npm run build` must pass; CI runs both on push/PR to `main`.
- Ops (Premium dependency, allowlisting, secret rotation, export re-request cadence, backfill scripts) live in **[`README.md`](README.md) → Ops runbook** — update there, don't duplicate here.
