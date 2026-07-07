# Wrapt — Design Spec

Personal listening dashboard. "Spotify Wrapped, all year round." Dark-first, artwork-led, one gold accent. Mobile-first. Single-user (v1).

The visual reference is `Wrapt.dc.html` — open it in a browser to see all 7 screens. This doc is the source of truth for tokens, components, and states.

---

## Design tokens

### Colour
Near-black warm background; album artwork carries the colour. One restrained gold accent.

| Token | Value | Use |
|---|---|---|
| `--bg` | `#08080a` | App/page background (board uses a subtle radial: `radial-gradient(120% 80% at 50% -10%,#131117,#08080a 60%)`) |
| `--surface` | `#0d0c0a` | Screen / card surface |
| `--surface-raised` | `rgba(255,255,255,0.05)` | Inputs, toggles, subtle fills |
| `--hairline` | `rgba(255,255,255,0.07)` | Borders, dividers |
| `--text-1` | `#f2efe8` | Primary text (warm white) |
| `--text-2` | `#9a948a` | Secondary text |
| `--text-3` | `#625d54` | Muted / metadata |
| `--text-4` | `#4a453d` | Faintest (counts, chevrons) |
| `--gold` | `#d0a24e` | **Accent** — CTAs, ranks, "NEW", active nav/toggle. Themeable. |
| `--gold-on` | `#12100b` | Text/icon on gold fills |
| `--up` | `#8bb996` | Climbers (Trends) — muted sage |
| `--down` | `#d99a9a` | Fallers (Trends) — muted rose |

Only two semantic colours beyond the accent (up/down), both low-chroma. Do not introduce more.

### Typography
- **Display / UI:** `Schibsted Grotesk` (400/500/600/700) — headings, body, labels.
- **Numerals / metadata / labels:** `Space Mono` (400/700) — ranks, deltas, times, play counts, eyebrow labels. Gives the "chart ticker" feel.

Both from Google Fonts. No third family.

Scale (mobile): wordmark 56 · screen H1 24 · section title 16 · body 14–15 · meta 12–12.5 · mono eyebrow 11 (uppercase, `letter-spacing:1px`) · nav label 9.5. Big rank numerals on Trends: **30px Space Mono 700**. Grid rank badges: 14px.

### Spacing / shape
- Screen horizontal padding: **20px**.
- Card radius 14 · thumb radius 10 · playlist art radius 9 · pill/input radius 13 · toggle track radius 13.
- Grid gap 16 · list row vertical padding 9–12.
- Min hit target 44px.

### Motion
- `riseIn` (opacity + `translateY(10px→0)`, .5s) on Trends rows, **staggered** ~50ms per row → the countdown reveal.
- `shimmer` (moving 200% gradient, 1.4s ease-in-out infinite) for loading skeletons; offset a couple blocks by 150–200ms.
- Toggle pill transition: `all .18s ease`.
- `floaty` (subtle 6px bob, 5s) on the Connect artwork stack.

---

## Album artwork
Real cover art is the colour of the app. In the mockup it's stand-in duotone gradient tiles (`linear-gradient(140deg, lightHue, darkHue)`). In production, use the actual Spotify image URLs; keep the gradient tiles only as the fallback / loading placeholder. Sizes: recently 46 · grid cards fill 2-col (`aspect-ratio:1`) · Trends row 50 · playlist 42. Top-artist art is **circular**; track/playlist art is **rounded square** — keep that distinction.

---

## Components

- **Screen shell** — `#0d0c0a`, 1px hairline border, radius 38, faux status bar (`9:41` mono + `•••`). ~380px wide.
- **Bottom nav** — 3 tabs: Home (`⌂`), Trends (`▲`), You (`○`). Mono uppercase labels. Active = gold, inactive = `--text-3`.
- **Range toggle** — segmented control, 3 options (`4 weeks` / `6 months` / `All time`), Space Mono. Active pill = gold bg + dark text; inactive = transparent + secondary text. Drives Top Artists & Top Tracks.
- **Recently played row** — thumb + title/artist + "time ago" (mono, e.g. `2m`, `1h`).
- **Rank card (grid)** — square/circle art with a blurred gold-numeral badge top-left; title + meta below. 2-col grid.
- **Playlist row** — art + name + track count (mono) + `›`, divided by hairlines.
- **Trends row** — big mono rank · art · title + "last week #n" (mono) · movement indicator on the right:
  - New: gold `NEW` pill
  - Climber: `▲ n` in `--up`
  - Faller: `▼ n` in `--down`
  - Dropped: `—` rank, `OUT` label, row at `opacity:.5`
- **Primary button / input** — gold button, dark text; input is `--surface-raised` with hairline border, gold focus.

---

## Pages

1. **Login** — wordmark, one-line tagline, email field, "Send magic link", "No passwords" helper. Centered, generous negative space.
2. **Connect Spotify** — floating artwork stack, "Connect your Spotify", one-line sub, gold CTA, `✦` privacy note ("your listening data stays yours").
3. **Dashboard (hero)** — greeting + date eyebrow → Recently played → range toggle → Top artists (grid) → Top tracks (grid) → My playlists (list) → bottom nav.
4. **Trends** — "The weekly countdown" + week eyebrow + playful sub → grouped sections **New entries → Climbing ▲ → Slipping ▼ → Dropped out**, each with a count. Staggered rise-in = chart-countdown drama.

## States (must-build)

- **First visit (Dashboard)** — faint tile trio, "Still learning your taste", body, `◷ syncing your last plays…`.
- **No snapshots (Trends)** — dashed gold `▲` badge, "No countdown yet", "first chart drops in 6 days", `0 / 1` progress bar. Trends needs ≥2 weekly snapshots to show movement; until then, show this.
- **Loading** — shimmer skeleton mirroring the dashboard layout (title, toggle, 2-col grid, list rows). Offset a couple blocks' animation-delay.

## Voice
Playful, warm, two-person household — not enterprise. E.g. "Cue the drumroll.", "Here's what's been on repeat." Keep it to one light line per screen; never at the expense of clarity. (The mockup exposes a `voice: playful | plain` toggle showing both copy sets.)
