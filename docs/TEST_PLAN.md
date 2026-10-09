# Test Plan & Mobile View Plan — Heart on a Sleeve

## Regression Test Plan

### Auth — `login.html`

| # | Test | Expected |
|---|---|---|
| A1 | Visit `/` unauthenticated | Redirect to `/login.html?returnTo=/` |
| A3 | Valid login credentials | Stores 3 localStorage keys, redirects to `returnTo` |
| A4 | Wrong password | Error message, button re-enables |
| A5 | Login with empty fields | "Email and password are required" — no request fires |
| A6 | Press Enter in login view | Submits form |
| A7 | Register: new email + 8+ char password | Success, redirects to map |
| A8 | Register: duplicate email | Server 400 error surfaced |
| A9 | Register: password < 8 chars | Client-side error, no request fires |
| A10 | "Create one" / "Sign in" links | Switches view, clears error messages |
| A11 | "Forgot password" → info box → Back | Shows/hides correct view |
| A12 | Logout (any page) | Removes `hoas_token`, `hoas_refresh`, `hoas_email`; redirects |
| A13 | Token expiry mid-session (401 from API) | Clears token, redirects to login with `returnTo` |

---

### Map selector — `index.html` / `app.ts`

| # | Test | Expected |
|---|---|---|
| M1 | Page load | T-Shirt active, Generate disabled, bbox displays "Click a product above to start drawing" |
| M2 | Click any merch type | Enters draw mode, crosshair cursor, bbox resets |
| M3 | Re-click active merch | Restarts draw mode (clears existing selection) |
| M4 | Click different merch while in edit mode | Enforces new aspect ratio on existing selection |
| M5 | Coaster shape cycle ‹ › | Icon and label update; shape flows to bbox corners; cycle hidden when coaster not active |
| M6 | Draw a rectangle | Selection polygon + handles appear |
| M7 | Drag inside selection | Moves bbox |
| M8 | Drag corner handle | Resizes, ratio locked to current merch |
| M9 | Drag outer ring | Rotates |
| M10 | Camera heading lock | Heading snaps back to north if rotated |
| M11 | Place search: 1–2 chars | No results dropdown |
| M12 | Place search: 3+ chars | Results after 500ms debounce; click flies camera |
| M13 | Escape in search | Closes dropdown |
| M14 | Click outside search | Closes dropdown |
| M15 | Generate with no bbox | Button remains disabled |
| M16 | Generate fires | Panel hides, spinner shows, "Generating…" |
| M17 | Forward transition | Globe captures → pixelates selection → bar fills → crossfade to SVG |
| M18 | My Designs FAB | Hidden when logged out; visible when logged in |
| M19 | STL generates in background | Save section appears in designs panel after STL finishes |
| M20 | Network error on generate | Status shows error, Retry button enables |
| M21 | 60-second timeout | "Timed out — try a smaller area" message |

---

### Inline SVG viewer (within `index.html`)

| # | Test | Expected |
|---|---|---|
| S1 | SVG renders in viewport | Fit to window on initial load |
| S2 | Colour swatch click | 80ms debounce then regen; "Updating…" clears on completion |
| S3 | Place labels toggle | Regen with/without labels |
| S4 | Buildings toggle | Regen with/without buildings |
| S5 | Fit to window button | SVG recentres and scales to fit |
| S6 | Actual size button | Scale = 100%, centred |
| S7 | Scroll zoom | Zooms toward cursor point |
| S8 | Left drag pan | Pans correctly |
| S9 | Download SVG | File downloads as `design.svg` |
| S10 | View 3D button hidden for T-shirt/Mug/Tote | Not present in DOM |
| S11 | View 3D button visible for Coaster/Placemat/Relief | Shown; download button highlighted |
| S12 | View 3D click | Fade-to-dark → navigates to `3d-viewer.html` with all URL params |
| S13 | ← Map click | Reverse transition → globe restored, SVG view hidden |
| S14 | ← Map then Generate again | Second generate works cleanly |
| S15 | My Designs panel: Save | Saves to API, shows "Saved!" |
| S16 | My Designs panel: Load saved design | Restores bbox, merch, palette; shows SVG view |
| S17 | My Designs panel: Delete | Confirm → card removed; last card → empty state |
| S18 | Colour regen abort on fast clicking | Only last request runs; no stacked fetches |

---

### 3D Viewer — `3d-viewer.html`

| # | Test | Expected |
|---|---|---|
| T1 | Page load with SVG URL | SVG cover shows immediately, progress bar 0→50% |
| T2 | SVG cover on entryReady | Shrinks from full canvas to ground plate screen rect (650ms), then fades out |
| T3 | OSM cache hit (sessionStorage) | Pre-load minimum = 800ms; faster entry |
| T4 | Ground SVG texture | Fades in over 2.2s during entry animation |
| T5 | Entry animation | Wireframe fade-in (water/parks → roads → buildings), pause, colour fill |
| T6 | Camera controls | Left=orbit, middle=pan, right=zoom, scroll=zoom |
| T7 | Wireframe toggle | Neon colours + dark background; toggles back to solid |
| T8 | Wireframe toggle in Print Preview | All `allMats` toggled correctly |
| T9 | Auto-rotate toggle | Rotation starts/stops |
| T10 | Window resize | Renderer and camera resize correctly |
| T11 | Print Preview button — 3D types only | Not shown for T-shirt/Mug/Tote |
| T12 | Print Preview load animation | Buildings solid → water drops → land lid drops |
| T13 | Print Preview: ground hidden | OSM SVG ground plane not visible behind STL |
| T14 | Print Preview: STL roads clipped | No grey road geometry outside green lid boundary |
| T15 | Print Preview: collar walls visible | 1mm collar rings not clipped at bbox edge |
| T16 | Print Preview exit → Map View | `osmGroup` + `ground` visible; STL groups hidden; layers reset to y=0 |
| T17 | STL download links | Three files download correctly |
| T18 | Regen STL | New params → API call → new STL loads; Print Preview updates in-place if showing |
| T19 | Regen while not in preview | `printLoaded` resets; next Print Preview click shows new geometry |
| T20 | Fabric preview (T-shirt etc.) | SVG texture + buildings only; auto-triggers after entry animation |
| T21 | ← SVG View button | Navigates to `/` (not `history.back()`) |
| T22 | Stats display | Shows "N buildings · M roads" after load |

---

### Regression: recent changes to verify first

| # | Test | Why |
|---|---|---|
| R1 | STL for a bbox where roads cross the boundary | Verify road tentacles gone — clip fix |
| R2 | Print Preview shows no beige SVG ground plane | Ground visibility toggle |
| R3 | Collar walls visible in Print Preview | `bboxClip` removed from print part materials |
| R4 | SVG→3D transition is a fade, not expand-to-window | `runSvgTo3dTransition` rewrite |
| R5 | SVG cover in 3d-viewer shrinks toward ground plate | New shrink-to-base animation |
| R6 | Coaster circle/hexagon shape flows to STL | `coaster_shape` param passed through regen |
| R7 | Regen STL clears `printLoaded` flag correctly | Prevents stale geometry on subsequent previews |

---

## Mobile View Plan

### Situation

No page has a mobile layout. `index.html` and `login.html` have `<meta viewport>` tags; `3d-viewer.html` and `svg-viewer.html` do not. All sidebars are hard-coded widths. Touch drawing is unwired.

### Breakpoints

| Range | Target |
|---|---|
| ≤ 600px | Phone portrait — primary mobile target |
| 601–900px | Phone landscape / small tablet |
| > 900px | Current desktop layout unchanged |

---

### Page-by-page strategy

**`login.html`** — minimal work
- Add `max-width: calc(100vw - 24px)` to the 380px card
- No structural changes needed

**`dashboard.html`** — minor
- Collapse `#side-panel` (240px) to a horizontal top bar at ≤ 600px
- Grid `minmax(220px, 1fr)` already mobile-friendly

**`svg-viewer.html`** — medium
- Add missing `<meta name="viewport">` tag
- At ≤ 768px: sidebar becomes a bottom sheet (see shared CSS below)
- Wire `touchstart/touchmove/touchend` to existing drag handlers (pan)
- Wire 2-finger `touchmove` pinch distance delta → zoom

**`3d-viewer.html`** — medium
- Add missing `<meta name="viewport">` tag
- At ≤ 768px: `#panel3d` becomes a bottom sheet
- Three.js `OrbitControls` already handles touch natively
- STL download links already have `href` — work on mobile Safari

**`index.html` (map selector)** — most complex
- `#panel` becomes a **bottom sheet**: full width, `max-height: 55vh`, default collapsed to ~120px showing merch grid + Generate; expands on drag/tap of handle
- Globe takes full screen behind it
- `#map-hint` hidden on mobile (no mouse)
- Coaster ‹ › cycle buttons: increase touch target to 32×32px minimum
- My Designs FAB stays top-right

---

### Touch drawing model — two options

**Option A — Direct drag (mirrors mouse):**
Wire Cesium `TOUCH_START/MOVE/END` to the existing `LEFT_DOWN/MOUSE_MOVE/LEFT_UP` handlers. Requires disabling `enableTranslate` during draw mode (mirrors existing `enableRotate = false`). Ambiguous with panning on small screens.

**Option B — Tap-to-corner (recommended for phones):**
- First tap places NW anchor point (visual dot appears)
- Second tap confirms SE corner → bbox created, enters edit mode
- Cleaner separation from camera pan gesture
- Resize handles need 44×44px touch targets
- Rotation: locked to axis-aligned on mobile (outer ring hidden on touch devices)

---

### Shared CSS additions to `app.css`

```css
@media (max-width: 600px) {
  /* Bottom sheet pattern — apply to each page's sidebar */
  .panel-mobile-sheet {
    position: fixed; bottom: 0; left: 0; right: 0;
    width: 100%; max-height: 60vh;
    border-radius: 14px 14px 0 0;
    overflow-y: auto; z-index: 1000;
    transform: translateY(calc(100% - 120px)); /* collapsed */
    transition: transform 0.3s cubic-bezier(.2,.8,.4,1);
  }
  .panel-mobile-sheet.expanded { transform: translateY(0); }

  /* Drag handle */
  .sheet-handle {
    width: 36px; height: 4px;
    background: var(--border-item); border-radius: 2px;
    margin: 10px auto 8px;
  }

  /* 100vh iOS Safari fix */
  .full-height { height: 100dvh; }
}
```

---

### Known constraints

- **CesiumJS on low-end phones**: may render at 10–15fps — add a status hint; consider a reduced-detail tile provider at low DPR.
- **iOS Safari 100vh bug**: use `100dvh` with `100vh` fallback everywhere height is viewport-dependent.
- **sessionStorage OSM cache**: passes large JSON between pages; existing `try/catch` already handles quota-exceeded silently.
- **STL wait time**: unchanged on mobile — existing progress bar is sufficient; no extra work needed.

---

### Implementation order

1. `login.html` — card max-width fix (30 min)
2. `dashboard.html` — top bar collapse (1 hr)
3. `svg-viewer.html` — viewport tag + bottom sheet + touch pan/zoom (2 hrs)
4. `3d-viewer.html` — viewport tag + bottom sheet (1 hr; OrbitControls already touch-ready)
5. `index.html` — bottom sheet + coaster touch targets (2 hrs)
6. Touch drawing Option B (3 hrs — most complex, do last)
