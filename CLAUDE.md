# Wrapt — build notes for Claude Code

**What this is:** a personal Spotify listening dashboard — "Wrapped, all year round," for a two-person household. Dark-first, artwork-led, one gold accent. Mobile-first: assume a phone unless told otherwise.

**Multi-user, not single-user:** the data model supports up to 5 allowlisted Spotify users (launch = Tim + Zoe) even though Mark 1 UI is built and tested against one account at a time. See `spotify-dashboard-sdd.md` D2. Every table is scoped by `user_id`/`profile_id` — never assume a singleton user when writing queries.

**Design source of truth:** `SPEC.md` (tokens, components, states) + `Wrapt.dc.html` (visual mockup of all 7 screens — open in a browser to see them). Match those. The `.dc.html` is a *mockup format*; do not copy its markup — rebuild in Astro.

**Solution design source of truth:** `spotify-dashboard-sdd.md` — architecture, data model, Spotify API constraints, and phased delivery plan. Read it before touching auth, Supabase schema, or any Spotify API call.

**Ops runbook (Premium dependency, allowlisting, secret rotation, export re-request cadence) lives in [`README.md`](README.md) → Ops runbook** — that's the human-facing doc Tim actually operates from day-to-day; don't duplicate it here, update it there and link to it.

## Stack & constraints
- **Astro** with **vanilla CSS + vanilla JS**. No React/Vue/Svelte, no CSS framework, no CSS-in-JS.
- Layout with **CSS grid/flex + `gap`** and **simple CSS transitions** only.
- Design tokens as **CSS custom properties** in `:root` (see SPEC "Design tokens" table). `--gold` is themeable — read it everywhere, never hardcode the hex.
- Fonts: `Schibsted Grotesk` + `Space Mono` via Google Fonts `<link>` (preconnect). Space Mono for all numerals/labels/times.
- **No audio-feature visualisations** — that data isn't available. The story is rankings, recency, and week-over-week change. Don't invent tempo/energy/valence charts.
- Don't add pages, sections, or content beyond what's in SPEC without asking.

## Suggested structure
```
src/
  layouts/AppShell.astro        # <html>, fonts, :root tokens, dark bg
  components/
    BottomNav.astro             # Home / Trends / You
    RangeToggle.astro           # 4 weeks | 6 months | All time  (+ small client script)
    AlbumTile.astro             # img with gradient fallback; shape=square|circle prop
    RankCard.astro              # grid card w/ rank badge
    TrackRow.astro / TrendRow.astro
    EmptyState.astro / Skeleton.astro
  pages/
    login.astro
    connect.astro
    index.astro                 # dashboard (auth-gated)
    trends.astro
  lib/spotify.ts                # token exchange + API calls
  lib/snapshots.ts              # weekly snapshot capture + diffing
```

## Data model
- **Auth:** email magic link → session. Then Spotify OAuth (`connect`).
- **Spotify scopes (read-only):** `user-read-recently-played`, `user-top-read`, `playlist-read-private`. Never request write/post scopes — the privacy promise ("we only read what you play, never post") is a product commitment. Note: the SDD (§4.1) lists `playlist-modify-private`/`playlist-modify-public` for the Mark 2 AI-playlist push; those are deliberately **not** requested yet — add them only when Mark 2 (`POST /me/playlists`, C9) is actually built, and flag the privacy-copy implications to Tim first since it changes the "never post" promise.
- **Dashboard data:**
  - Recently played → `/me/player/recently-played`
  - Top artists / top tracks → `/me/top/{type}?time_range=` where the toggle maps **4 weeks → `short_term`**, **6 months → `medium_term`**, **All time → `long_term`**.
  - Playlists → `/me/playlists`
- **Trends (the differentiator):** Spotify has no "last week's ranking" API. You must **capture your own weekly snapshot** (store the top-tracks ranking, e.g. Sunday night cron) and **diff the two most recent snapshots** to compute: new entries, climbers (`+n`), fallers (`-n`), dropped. Needs ≥2 snapshots before Trends shows movement — until then render the **no-snapshots empty state**.

## States — all three are required (built)
1. **First visit / no data** (dashboard) — `EmptyState.astro`, rendered by `index.astro` when `historySince === null`.
2. **No snapshots** (Trends) — the real app diffs live via `hasMovement` on `LeaderboardResult` rather than weekly snapshots (see "Plays history + Leaderboard" below), so this is adapted to a dashed-gold-badge banner in `index.astro` shown whenever `entries.length > 0 && !hasMovement` (native `4w`/`6m`/`all` windows and `lifetime`, which structurally have no comparable prior period).
3. **Loading** — `Skeleton.astro`, mirroring the dashboard layout with `shimmer` keyframes (`AppShell.astro`). Wired via Astro's `<ClientRouter />` (`astro:transitions`) + an `astro:before-preparation` listener in `index.astro` that swaps `#dashboard-content` for the skeleton during same-page filter navigations (range/kind/genre/custom-date) — cross-page navigations keep default browser behavior.

Also handled: expired Spotify token (`SpotifyTokenExpiredError` in `src/lib/spotify.ts`, thrown on `invalid_grant`; caught in `index.astro` → redirects to `/connect?error=token_expired`, in `api/me.ts`, `api/import/enrich-tick.ts` → `import.astro`'s reconnect link, `workers/sync`, and `api/auth/callback.ts`), API error (`index.astro` wraps its data-fetch `Promise.all` in try/catch, rendering a `--down`-colored "Something went wrong loading your dashboard" message instead of a 500).

## Album art
Use real Spotify image URLs. Keep a duotone gradient tile as the fallback/placeholder (and loading state). Top-artist art = circle; track/playlist = rounded square.

## Motion
- Trends rows: staggered `riseIn` (~50ms/row) for the countdown reveal.
- Skeletons: `shimmer`, a couple blocks offset by 150–200ms.
- Toggle: `.18s` transition. Keep everything CSS-only; no JS animation libs.

## Voice
Playful, warm, human — one light line per screen (examples in SPEC). Two-person household, not enterprise. Never sacrifice clarity for a joke.

---

## Architecture & stack (as built)
- **Astro `5.18.2`** (`output: 'server'`) + **`@astrojs/cloudflare` `12.6.13`** — pinned, not latest. Astro `7.0.6` + `@astrojs/cloudflare` `14.x` (the versions `astro add cloudflare` installs today) run a real `workerd` isolate even in `astro dev`, and that combination has a **day-one bug**: any render error crashes Astro's own JSON logger with `process is not defined` (it assumes Node's `process` global, which doesn't exist inside `workerd`), masking the real error and making every request 500. Confirmed by bisecting down to a trivial API route. Don't upgrade past `astro@6` / `@astrojs/cloudflare@13` without retesting `astro dev` first.
- Because of that pin, env vars/bindings are read via `context.locals.runtime.env` (typed in `src/env.d.ts` — `Runtime<Env>` generic, `Env` from the Wrangler-generated `worker-configuration.d.ts`), **not** `import { env } from 'cloudflare:workers'` (that's the v6+ API — wrong for this pin) and not `import.meta.env` (client-only). `import.meta.env.PUBLIC_*` is still correct for client-side code (Vite build-time).
- Local dev: `.env` (Vite-loaded, `PUBLIC_*` vars for client code) **and** `.dev.vars` (Wrangler-loaded, all vars, used for `locals.runtime.env` during `astro dev`) must both exist and stay in sync — both gitignored. Real secrets already live in both. Run `npm run generate-types` (= `wrangler types`) after adding a new var to either, to keep `worker-configuration.d.ts` in sync.
- **Supabase**: Postgres + Auth (email + password) + RLS. Client-side session/PKCE-cookie handling via `@supabase/ssr` (`createBrowserClient` in page `<script>` tags, `createServerClient` in `src/lib/supabase.ts` bound to Astro's `request`/`cookies` — Astro's `AstroCookies` has no `getAll()`, so the cookie adapter parses the raw `Cookie` header manually). `createSupabaseServiceClient()` uses the service-role key and **must only be called from server code** (API routes / `.astro` frontmatter), never shipped to the client.
- Migrations live in `supabase/migrations/*.sql`. **`db push` has never been run from this machine** (CLI has no cached `supabase login` token, and no DB password is in `.env` for a direct `psql`/Management-API route). The first migration (`spotify_profiles`) was hard-pasted by Tim into the Supabase Dashboard SQL editor instead — check the dashboard, not just this repo, to know what schema actually exists live. Keep pasting new migrations there (mirrored into a file here for history) until the CLI is linked.
- **Deploy**: Cloudflare Pages project `wrapt` already exists (created outside this repo, in the SDD's "Phase 0 human setup sprint"), Git-connected to `Tim-Claessen/wrapt` on `main`, with custom domain **`wrapt.timclaessen.com`** already attached (resolves SDD Decision D6 — no longer open) alongside the default `wrapt.pages.dev`. `wrangler` on this machine is pre-authenticated with Pages write access (`wrangler whoami`). Build with `npm run build` (`@astrojs/cloudflare` 12.x emits classic Pages Functions output — `dist/_worker.js` + `dist/_routes.json`), then publish with `npx wrangler pages deploy dist --project-name wrapt --branch main`. Don't use `wrangler deploy` (plain Workers deploy) — it targets a different product/namespace than this Pages project. Production env vars are set as **Pages secrets** (`wrangler pages secret put <NAME> --project-name wrapt`, value piped in — never as a literal CLI arg) — they are not read from `.env`/`.dev.vars` in production. `SPOTIFY_REDIRECT_URI` differs by environment: `http://127.0.0.1:4321/api/auth/callback` locally, `https://wrapt.timclaessen.com/api/auth/callback` in production (C3).
- The production redirect URI (`https://wrapt.timclaessen.com/api/auth/callback`) has been added to the allowed Redirect URIs in the Spotify Developer Dashboard (Client ID `d53d9e97...`) — confirmed by Tim 2026-07-08. Prod login works end-to-end.

## Spotify API constraints register (from `spotify-dashboard-sdd.md` §1.3, post-Feb-2026 rules)
| # | Constraint | Design response |
|---|-----------|-----------------|
| C1 | Max 5 users, manually allowlisted in Spotify dashboard | Launch with Tim + Zoe; invite-only thereafter |
| C2 | App owner must hold active Spotify Premium; app dies if it lapses | Tim holds Premium — don't let it lapse |
| C3 | 1 Client ID per developer | Single app for dev + prod; separate redirect URIs per environment |
| C4 | Recommendations & audio features unavailable | No tempo/energy/valence UI, ever (see Stack & constraints above); AI generation (Mark 2) replaces recommendations |
| C5 | Search capped at 10 results/request (default 5) | Paginate; batch track-validation searches server-side (Mark 2) |
| C6 | Batch fetch endpoints removed (one request per track/artist) | Aggressive Supabase caching; queue + backoff on 429 |
| C7 | `popularity`, user `email`/`country`/`product` fields removed | Identity keyed on Spotify user ID; no popularity-based sorting |
| C8 | Playlist items only readable for owned/collaborative playlists | Dashboard shows own playlists only |
| **C9** | **Playlist endpoints renamed:** `/playlists/{id}/items` (was `/playlists/{id}/tracks`), `POST /me/playlists` | Build against the new endpoint names from day one — relevant once Mark 2 playlist creation is built |
| C10 | Dev-mode rate limits (30-second rolling window) | Server-side caching + scheduled sync, not live fan-out |

## Auth implementation (Phase 1, built)
Flow: `/signup` (email + password, `@supabase/ssr` browser client, `supabase.auth.signUp`) or `/login` (`supabase.auth.signInWithPassword`) → `/connect` → `/api/auth/spotify` (generates PKCE verifier/challenge + state, stores in short-lived httpOnly cookies, redirects to Spotify `/authorize`) → Spotify → `/api/auth/callback` (verifies `state`, exchanges `code` + `code_verifier` for tokens — **no client secret**, this is public-client PKCE per SDD §4.1 — encrypts the refresh token with AES-GCM (`src/lib/crypto.ts`, key = `TOKEN_ENC_KEY`), upserts `spotify_profiles` via the service-role client) → `/` (dashboard, redirects to `/login`/`/connect` as needed).

Signup was previously magic-link/OTP-based; replaced with email+password because Tim doesn't like magic links. `/api/auth/confirm` (`exchangeCodeForSession`) is unchanged and now serves as the PKCE code-exchange target for `/signup`'s email confirmation link (`emailRedirectTo`) instead of the old magic-link redirect — reused as-is since it's just a generic "exchange this code for a session" handler. Self-serve signup is open to anyone with the URL (no invite-code gate) since this is a private app whose link Tim controls; the actual admission control is the Spotify allowlist (C1), not Supabase account creation. Supabase's "Confirm email" project setting is **off** (confirmed by Tim 2026-07-08) — `signUp` returns an active session immediately, no confirmation email required. `/signup`'s client script still handles the on-case too (shows a "check your email" message if no session comes back), in case that setting is ever flipped.

- `src/lib/tokens.ts` — `getValidSpotifyAccessToken(userId, env)`: server-only helper, decrypts the stored refresh token, calls Spotify's refresh grant, re-encrypts + persists if Spotify rotated the refresh token. Called fresh on every request for now (no KV/memory caching of access tokens yet — SDD §2 mentions this as a later optimization).
- `/api/me` — smoke endpoint: session → `getValidSpotifyAccessToken` → live `GET /v1/me` → `{ connected, spotifyUserId, displayName }`. Good manual check that the full pipeline works end-to-end.
- `spotify_profiles.refresh_token_enc` is locked down with **column-level** Postgres grants (`revoke all ... ; grant select (safe columns only) ... to authenticated`), not just RLS — RLS alone only filters rows, not columns, so a user's own row would otherwise expose their own encrypted token to the anon-key client. No insert/update/delete grants exist for `authenticated`/`anon` at all; every write goes through the service-role client server-side.

## Plays history + Leaderboard (Phase 2, built)
- **`plays`** (`supabase/migrations/20260708000000_plays.sql`) is the durable per-play log — `UNIQUE (profile_id, played_at)` makes every write idempotent, so the sync cron can safely re-fetch overlapping ranges. `spotify_profiles.plays_cursor_after_ms` tracks the latest ingested `played_at` (ms) per profile and is passed back to Spotify as the `after` cursor; it's a dedicated column, deliberately **not** reusing `last_synced_at` (that column is bumped on every token refresh, including plain dashboard visits via `getValidSpotifyAccessToken`, so it isn't a safe proxy for "last play sync").
- **`artists_cache`** (`...20260708000001_artists_cache.sql`) holds genres/image per Spotify artist id, fetched one-by-one (C6 — no batch artist endpoint) and refreshed lazily (`src/lib/plays.ts` `syncArtistGenres`, 30-day staleness window), never on a schedule.
- **`workers/sync/`** is a **standalone Cloudflare Worker** (own `wrangler.jsonc`, cron trigger `0 */2 * * *`), not a Pages Function — `@astrojs/cloudflare` 12.x has no scheduled-handler support at the pin this repo uses (see Architecture note above), so the sync cron can't live inside the Astro/Pages app. It imports directly from `../../src/lib/*` (crypto, supabase, tokens, spotify, plays) rather than duplicating logic — those modules have no Astro-only runtime dependencies. Deploy with `npm run sync:deploy` (real `wrangler deploy` — correct here, unlike the Pages app; see Deploy note above). Test locally with `npm run sync:dev` (`wrangler dev --test-scheduled`, then `curl "http://127.0.0.1:8787/__scheduled?cron=0+*/2+*+*+*"`); note wrangler dev sometimes doesn't flush console output from work done inside `ctx.waitUntil` — if you need to see errors while iterating, temporarily add a `fetch` handler that awaits the same function and returns its result/error in the HTTP response, then remove it again before deploying.
- All 6 migrations (`20260707000000_spotify_profiles.sql` through `20260708000004_listening_stats.sql`) are applied to the live Supabase database — confirmed by Tim 2026-07-08. Keep pasting new ones into the Supabase Dashboard SQL editor, in filename order, until the CLI is linked (see `db push` note above).
- `workers/sync` is a separate Worker from the Pages app and has its own secret store — `wrangler secret put <NAME> -c workers/sync/wrangler.jsonc` for `SPOTIFY_CLIENT_ID`, `PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TOKEN_ENC_KEY` (same values as the Pages secrets) — confirmed set (verified via `wrangler secret list -c workers/sync/wrangler.jsonc` 2026-07-08). Local dev reads `workers/sync/.dev.vars` (gitignored, already populated on this machine from the root `.dev.vars`).
- **`src/lib/leaderboard.ts`** powers the dashboard's Leaderboard section (`src/pages/index.astro`). Two data sources depending on the selected window: native `4w`/`6m`/`all` hit Spotify's `/me/top/*` directly (no play counts or rank-change available — Spotify doesn't expose prior-period data); computed `7d`/`30d`/`custom` are sliced from `plays` via Postgres RPC functions (`supabase/migrations/20260708000002_leaderboard_functions.sql`) that also diff against the immediately-preceding equal-length window for real rank-change (NEW/▲/▼), no weekly snapshot needed. Genre cross-filtering (via `artists_cache`) only works for computed windows, since native Spotify top-tracks/artists responses don't carry genre. The RPC functions are granted to `service_role` only — always call them via `createSupabaseServiceClient()`, after already verifying the caller's session with the request-scoped client (same pattern as every other privileged read/write in this app).
- Every Spotify HTTP call (token grant + Web API) now funnels through `spotifyRequest()` in `src/lib/spotify.ts`, which retries on `429` honouring `Retry-After` (bounded, 2 retries by default) before throwing `SpotifyRateLimitError` — the sync cron catches that specifically and skips the profile for the current cycle rather than blocking the whole run.
