# Solution Design Document — "Wrapt" (working title)
### Personal Spotify Dashboard & AI Playlist Generator
**Version:** 0.3 (AI generation deferred to Mark 2) · **Date:** 7 July 2026 · **Author:** Tim Claessen (with Claude)

---

## 1. Purpose & Scope

A private, multi-user web app that gives each authorised user a personal Spotify listening dashboard ("year-round Wrapped") and generates new playlists using AI, pushing them directly into the user's Spotify account.

**Confirmed launch users:** Tim + Zoe (2 of 5 available seats). The multi-user data model is retained regardless — it costs nothing now and leaves headroom for up to 3 more allowlisted users later without rework.

### 1.1 In scope (Mark 1)
- Spotify OAuth login flow (Authorization Code + PKCE) via the web UI
- Secure per-user credential storage (refresh tokens) in Supabase
- Dashboard: top artists, top tracks (short/medium/long term), recently played, user's playlists, listening trends over time (via snapshotting)

### 1.1a Future state (Mark 2)
- AI-generated playlist suggestions (Claude/Workers AI) seeded from the user's listening profile, with one-click "Create in Spotify" (§4.3 retained as future-state design)

### 1.2 Explicitly out of scope
- **Spotify-native recommendations** — endpoint removed for new apps (Nov 2024)
- **Recommending existing third-party playlists** — browse/other-user endpoints removed; playlist contents unreadable unless owned/collaborative (Feb 2026)
- **Audio features / analysis** (danceability, energy, valence) — removed for new apps
- **Public scale** — hard cap of 5 authorised users in Development Mode; Extended Quota requires a registered business with ≥250k MAU
- Zoe as a "separate instance" — unnecessary; multi-user data model covers her as user #2 within the same app

### 1.3 Constraints register (Spotify API, post-Feb 2026)

| # | Constraint | Design response |
|---|-----------|-----------------|
| C1 | Max 5 users, manually allowlisted in Spotify dashboard | ✅ Accepted — launch with Tim + Zoe; invite-only thereafter |
| C2 | App owner must hold active Spotify Premium; app dies if it lapses | ✅ Confirmed — Tim holds Premium; flag in ops runbook (don't let it lapse) |
| C3 | 1 Client ID per developer | Single app for dev + prod; use separate redirect URIs per environment |
| C4 | Recommendations & audio features unavailable | AI generation replaces them (§4.3) |
| C5 | Search capped at 10 results/request (default 5) | Paginate; batch track-validation searches server-side |
| C6 | Batch fetch endpoints removed (one request per track/artist) | Aggressive caching in Supabase; respect rate limits with queue + backoff on 429 |
| C7 | `popularity`, user `email`/`country`/`product` fields removed | Identity keyed on Spotify user ID; no popularity-based sorting |
| C8 | Playlist items only readable for owned/collaborative playlists | Dashboard shows own playlists only |
| C9 | Playlist endpoints renamed: `/playlists/{id}/items`, `POST /me/playlists` | Build against new endpoints from day one |
| C10 | Dev-mode rate limits (30-second rolling window) | Server-side caching + scheduled sync rather than live fan-out |

---

## 2. Architecture Overview

Same pattern as Yumlog: static-first Astro on Cloudflare Pages, server logic in Pages Functions, Supabase as the system of record.

```
┌────────────┐     HTTPS      ┌──────────────────────────┐
│  Browser    │ ─────────────▶ │ Cloudflare Pages (Astro) │
│  (Astro UI) │                │  + Pages Functions        │
└────────────┘                └────────┬───────────┬─────┘
                                       │           │
                          OAuth + API  │           │  Service role
                                       ▼           ▼
                              ┌────────────┐  ┌────────────┐
                              │ Spotify     │  │ Supabase    │
                              │ Web API     │  │ (Postgres + │
                              └────────────┘  │  Auth + RLS)│
                                              └────────────┘
                                       ▲
                                       │  AI playlist generation
                              ┌────────┴───────┐
                              │ Workers AI /    │
                              │ Anthropic API   │
                              └────────────────┘
```

**Key principles**
- Spotify tokens never touch the client. All Spotify calls proxied through Pages Functions.
- Refresh tokens encrypted at rest in Supabase; access tokens held short-lived in memory/KV.
- Dashboard reads served from Supabase cache where possible (C6, C10); Spotify hit on a sync cadence, not per page view.
- A scheduled Worker (cron) snapshots each user's top artists/tracks weekly — this is what enables **trends over time**, which Spotify itself doesn't expose. This becomes the app's genuinely differentiated feature.

---

## 3. Data Model (Supabase)

```
users                      -- Supabase Auth (email login)
  id (uuid, PK)

spotify_profiles
  id (uuid, PK)
  user_id (uuid, FK → users, UNIQUE)
  spotify_user_id (text, UNIQUE)
  display_name (text)
  refresh_token_enc (text)        -- encrypted, service-role access only
  scopes (text[])
  connected_at, last_synced_at (timestamptz)

listening_snapshots              -- weekly cron capture
  id (uuid, PK)
  profile_id (FK → spotify_profiles)
  captured_at (timestamptz)
  time_range (enum: short|medium|long)
  kind (enum: top_tracks|top_artists)
  payload (jsonb)                 -- ranked list w/ ids, names, images

recently_played
  id (uuid, PK)
  profile_id (FK)
  played_at (timestamptz)
  track_id (text), track_name, artist_names (text[]), album_image (text)
  UNIQUE (profile_id, played_at)

generated_playlists
  id (uuid, PK)
  profile_id (FK)
  title, description (text)
  prompt_context (jsonb)          -- seed data + user brief given to the LLM
  tracks (jsonb)                  -- proposed list w/ validation status
  spotify_playlist_id (text, nullable)  -- set once pushed to Spotify
  status (enum: draft|pushed|dismissed)
  created_at (timestamptz)
```

**RLS:** every table row-scoped to `auth.uid()`. `refresh_token_enc` readable by service role only (Pages Functions), never by client-side anon key.

---

## 4. Functional Design

### 4.1 Auth & onboarding
1. User signs in to the app (Supabase Auth — email magic link keeps it simple for 5 users).
2. "Connect Spotify" → Authorization Code + PKCE flow → callback Pages Function exchanges code, encrypts and stores refresh token, records profile.
3. Scopes: `user-top-read`, `user-read-recently-played`, `playlist-read-private`, `playlist-modify-private`, `playlist-modify-public`.
4. Pre-requisite: user's Spotify email added to the app allowlist in the Spotify Developer Dashboard (manual, admin task).

### 4.2 Dashboard
- **Now:** recently played feed (synced on visit if stale > 30 min).
- **Top lists:** top artists & tracks across the three Spotify time ranges.
- **Trends:** movement vs prior snapshots — new entries, climbers, dropped artists ("your Wrapped, all year"). Powered entirely by our own snapshot history, immune to further Spotify endpoint cuts to derived/analytical data.
- **Your playlists:** metadata + contents (own playlists only, per C8).

### 4.3 AI playlist generation (replaces Spotify recommendations)
1. Build a taste context: top artists/tracks + recent plays + optional user brief ("rainy Sunday cooking", "gym, no skips").
2. LLM (Workers AI for cheap/fast, Anthropic API for quality — decide in build) proposes ~25 tracks as artist + title pairs with a playlist name and description.
3. Server validates each proposal via Spotify Search (paginated, C5), resolving to track URIs; unresolved tracks flagged and optionally re-generated.
4. User reviews/edits the draft in the UI → "Send to Spotify" → `POST /me/playlists` then `POST /playlists/{id}/items`.
5. Draft, prompt context and outcome stored in `generated_playlists` for iteration.

*Risk note:* LLM hallucination of non-existent tracks is expected; the search-validation step is mandatory, not optional. Budget ~25 search calls per generation against rate limits (C10) — queue with backoff.

### 4.4 Sync engine
- Cron Worker (weekly): snapshot top lists per connected profile.
- On-visit refresh: recently played, if stale.
- All Spotify responses cached in Supabase; UI reads cache first.

---

## 5. Non-Functional

| Area | Approach |
|------|----------|
| Security | Tokens server-side only; AES-GCM encryption of refresh tokens with a Workers secret; RLS everywhere; state + PKCE on OAuth |
| Privacy | 5 known users; listening data is personal — no cross-user visibility in Mark 1 |
| Performance | Cache-first reads; Spotify only on sync; static Astro shell |
| Cost | Cloudflare free tier + Supabase free tier + pennies of LLM inference |
| Resilience | Handle 429 with Retry-After; degrade gracefully if Spotify fields absent (C7) |
| Ops | Runbook: allowlisting users, Premium dependency (C2), token revocation/reconnect flow |

---

## 6. Delivery Phases (preview — full runsheet to follow as #3)

| Phase | Outcome |
|-------|---------|
| 0 | **Human setup sprint (front-loaded):** Spotify app registration, allowlist, secrets, Supabase, Cloudflare, repo — all access verified before build |
| 1 | Auth: Supabase login + Spotify OAuth + token storage |
| 2 | Dashboard: recently played + top lists (live sync, cache-first) |
| 3 | Snapshot cron + trends view |
| 4 | Polish: Zoe onboarding, error states, mobile pass |
| Future | AI playlist generation + push-to-Spotify (Mark 2) |

---

## 7. Decision Log

| # | Decision | Status |
|---|----------|--------|
| D1 | No pre-Feb-2026 Client ID exists — build under current (new-app) rules | ✅ Confirmed by Tim, 7 Jul 2026. All constraints C1–C10 apply as written. |
| D2 | User ceiling of 5 accepted; launch = Tim + Zoe only | ✅ Confirmed by Tim, 7 Jul 2026. No pivot to Last.fm required. |
| D3 | App owner Spotify Premium requirement | ✅ Confirmed — Tim holds Premium. |
| D4 | LLM for playlist generation | 🔮 **Deferred to Mark 2** (Tim, 7 Jul 2026). Default remains Workers AI behind a swappable interface when picked up. |
| D5 | Trends snapshot cadence | ⏳ **Default: weekly.** Daily doubles storage and API calls for marginal insight at 2 users. Override if preferred. |
| D6 | Product name & domain (e.g. `wrapt.timclaessen.com`) | ⏳ Open — needed before Phase 0 (DNS + OAuth redirect URIs). Runsheet will use a placeholder. |
