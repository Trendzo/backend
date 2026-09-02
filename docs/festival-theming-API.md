# Festival Theming — server-driven skins for the consumer app

An admin creates a theme (colors, header chrome, wordmark, decoration, copy, schedule,
targeting), previews it on a phone frame, and publishes it. Eligible consumer apps re-skin
on their next refresh — no code change, no app-store release. At expiry, disable, or
rollback the app returns to its bundled LIGHT look on its own.

This is **bounded theming**, not server-driven UI: the server may send presentation tokens,
configuration, text, images and approved Lottie JSON — never executable code, and never a
value outside the allowlists below. That keeps the system inside Apple/Google rules on
remotely-loaded functionality: the app binary remains the renderer and the authority for
everything it supports.

## Architecture

```
web-portal (admin)                backend                          consumer-app
─────────────────                 ───────                          ────────────
Themes editor  ──draft CRUD──▶  cms_themes (DRAFT rows)
Publish panel  ──publish─────▶  cms_theme_publications (immutable snapshots)
Phone preview  ◀─resolver────   GET /admin/cms/themes/preview
                                  │  latest snapshot (60s in-process cache)
                                  ▼
                                GET /api/v1/cms/theme ──resolved winner──▶ services/theme.ts
                                                                             │ validate (allowlist)
                                                                             ▼
                                                                           applyPalette → C/T proxies
                                                                           chrome via useFestivalTheme()
```

Same draft→snapshot→publish architecture as the Home CMS (`src/db/schema/cms.ts`), and the
same read-time-targeting insight: the snapshot freezes every enabled theme **with its
targeting**, and windows/city/platform/version gates are applied per request. A theme
published Monday goes live at midnight Friday with nobody touching Publish.

## Wire contract — `GET /api/v1/cms/theme?city=<s>`

Public, unauthenticated. Reads `x-app-version` and `x-app-platform` headers (the app sends
them on every request). Returns exactly ONE winner or null:

```jsonc
{ "success": true, "data": {
  "schemaVersion": 1,
  "publicationVersion": 7,          // 0 = never published
  "generatedAt": "2026-11-06T00:01:10.000Z",
  "refreshAfterSeconds": 1800,
  "theme": null | {
    "slug": "diwali-2026",
    "startsAt": "…" , "endsAt": "…",          // ISO or null
    "tokens":  { "accent", "accentInk", "accentSoft", "surfaceAlt", "hairline" },  // all optional #RRGGBB
    "chrome":  { "statusBarStyle": "light|dark",
                 "header": { "kind": "default|solid|gradient|image", "color?", "gradient?": [hex,hex],
                             "ink?", "wordmarkUrl?", "overlayUrl?", "overlayHeight?": 1-300 },
                 "tabBar": { "activeInk?", "badgeBg?" } },
    "decor":   { "kind": "none|image|lottie", "url?", "placement?": "header",
                 "loop?", "maxPlays?": 1-10, "respectReduceMotion": true },
    "copy":    { "greeting?": "≤80", "searchPlaceholder?": "≤60" }
  }
}}
```

- `theme: null` is the normal answer most of the year and means "bundled LIGHT look".
- Header `kind:"image"` reuses `overlayUrl` as the full-bleed header image.
- ETag is semantic (`W/"theme:<version>:<slug|none>"`) with `Vary: x-app-version,
  x-app-platform`; an unchanged winner costs a 304 with no body.

## Token safety model

| Category | Keys | Rule |
|---|---|---|
| Remote-safe | accent, accentInk, accentSoft, surfaceAlt, hairline | The only palette keys a theme may set |
| Client-owned | bg, ink, inkSoft, dim, faint, white | Never sent; the app's structural look |
| Locked semantic | ok, warn, err, green | Rejected at write AND publish (`REMOTE_TOKEN_NOT_ALLOWED`) — an error stays red in every season, and the savings green is money |

Both sides enforce this: zod `.strict()` + the publish gate on the backend
(`shared/cms/theme-schema.ts`, `theme-validate.ts`), and an allowlist-only merge on the app
(`consumer-app/src/theme/remoteTheme.ts`) that drops anything unknown and never spreads raw
JSON over the palette.

## Resolver precedence (deterministic — `shared/cms/theme-render.ts`)

```
eligible  =  within window  ∧  city matches  ∧  platform matches  ∧  meets minAppVersion
winner    =  priority DESC → specificity DESC (city-restricted beats national)
             → snapshot updatedAt DESC → slug ASC
```

City/platform/version gates FAIL CLOSED: a request missing the context never receives a
restricted theme (same philosophy as the CMS city filter). `minAppVersion` compares
numerically per part — `1.0.10 > 1.0.6` (`shared/semver.ts`).

## Admin workflow — `/api/v1/admin/cms/themes` (portal: Content → Festival Themes)

Permissions reuse the CMS keys: `cms.view` reads, `cms.edit` draft writes, `cms.publish`
publish/restore/disable. Every mutation is audited (`cms.theme.*`).

- **Draft CRUD**: `GET /`, `POST /`, `GET|PATCH|DELETE /:id`, `POST /:id/clone` (clone lands
  disabled). PATCH: `null` clears, absent leaves. Saves validate shape + coherence + asset
  hosts; contrast is checked only at publish so work-in-progress colors can be saved.
- **Publish** (`POST /publish {note?}`): validates EVERY enabled theme (all failures in one
  422 as `details.failures[{slug, field, message}]`), then freezes them into a new
  `cms_theme_publications` version under a pg advisory lock.
- **Restore** (`POST /publications/:version/restore`): copies a snapshot back over the
  DRAFT only — publish afterwards to make it live. Drafts absent from the snapshot are
  disabled, never deleted, so a follow-up publish reproduces the version exactly.
- **Disable now** (`POST /:id/disable-now`): the 3AM kill switch — one transaction that
  disables the draft AND ships a publication with the slug subtracted from the *last
  published payload*. No draft re-render, no validation: an unrelated broken draft can never
  block it. Propagation ≤ 60s server-side cache + the client's refresh cadence.
- **Preview** (`GET /preview?source=&at=&city=&platform=&appVersion=`): runs the
  *production* resolver against the draft or the live snapshot at any instant — the
  portal's resolver simulator and phone frame both feed from it.

## Publish-time validation (`theme-validate.ts`)

Shape re-parse → locked/unknown tokens → header/decor coherence (solid⇒color,
gradient⇒stops, image⇒overlayUrl, lottie⇒https `.json`) → **WCAG AA contrast ≥ 4.5:1**
(accentInk on accent; header ink on solid color / each gradient stop; no override) →
**trusted asset hosts** (only our CDN/storage hosts, derived from env — a pasted
`random-site.xyz/sparkles.json` can never ship) → window and version sanity.

## Uploads

`POST /api/v1/uploads?purpose=theme-wordmark|theme-overlay|theme-lottie` — 1MB/2MB/512KB
caps, png/webp for images, `application/json` sanity-checked as a real Lottie (`v`,
`layers`, numeric `op`). See `shared/uploads/limits.ts`.

## Caching

- Server: latest snapshot in-process, 60s TTL + explicit invalidation on publish/restore/
  disable (`theme-published.ts`; multi-process staleness bound = 60s, same as `/cms/home`).
- Client: `cachedGet` (memory + ETag revalidation) + an AsyncStorage snapshot
  (`cms.theme.v1`) applied synchronously before first paint, + bundled LIGHT as the failure
  path. Clock skew is corrected via `generatedAt` so a tampered device clock cannot extend
  a campaign past its next successful fetch; expiry reverts to LIGHT without the network.

## Client lifecycle (consumer-app)

1. Cold start: persisted snapshot re-validated + applied synchronously during AppState's
   hydration multiGet (before the routed tree mounts — no flash), then an async refresh.
2. Foreground: expiry check + refresh (TTL-throttled; unchanged snapshot = 304).
3. Apply: `applyPalette()` merges allowlisted tokens over LIGHT, rebuilds the precomputed
   `T` typography map, bumps the theme version; chrome surfaces subscribed via
   `useFestivalTheme()`/`useThemeVersion()` repaint live.
4. Every failure mode (malformed payload, unknown schemaVersion, dead asset URL, offline)
   degrades to LIGHT or to a smaller decoration — never to a crash.

## Known limitations / phase 2

- Deep-stack screens already mounted repaint body accents on their next natural render
  (chrome is live everywhere).
- No percentage rollout / cohorts / country targeting (deterministic bucketing needs a
  stable subject id on the request — designed for, not built).
- Portal phone preview is an HTML approximation; the resolver simulator is the truth for
  *which* theme wins.
- Phase 2/3 (per sdu.md): server-driven homepage section composition from an app-shipped
  component registry (`cms_sections.sortOrder` already exists for it), then a bounded SDUI
  layer. The theme system's primitives (snapshot publishing, read-time resolver, allowlist
  validation, capability gating via version headers) are the foundation for both.
