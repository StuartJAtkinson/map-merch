# Heart on a Sleeve — Build Roadmap

## Overview
A platform where users select a location on a stylised OSM map, choose a merch product (placemat, coaster, t-shirt, mug, tote, 3D print), and the system generates print-ready SVG or STL files — with live 2D and 3D preview, handling licences, WooCommerce product creation, and POD fulfillment automatically.

---

## Development Environment & Agent Collaboration

This project is actively developed by multiple AI agents (Claude Code instances) running in different host environments. This section documents what each environment can and cannot do, and the canonical workflows that keep them aligned.

---

### Environment map

```
Windows host (Stuart's machine)
│
├── Claude Code (Windows)                ← "me" — this agent
│   Shell: Git Bash / PowerShell
│   Docker: via Docker Desktop (Windows)
│   Node: Windows native process
│   Ports: port 8000 blocked by wslrelay (SSH tunnel in Ubuntu WSL)
│
├── Claude Code (Ubuntu WSL2)            ← "Hermes" — the other agent
│   Shell: bash in Ubuntu WSL2
│   Docker: same Docker Desktop, shared engine
│   Node: Linux process inside WSL
│   Ports: all Docker ports reachable directly from WSL
│
└── Docker Desktop (shared)
    ├── heart-on-a-sleeve-database-1     PostgreSQL/PostGIS :5432
    ├── heart-on-a-sleeve-backend-1      FastAPI :8000 (internal) / :8000 (host)
    ├── heart-on-a-sleeve-frontend-1     nginx :80 (internal) / :8080 (host)  ← profile: full only
    └── heart-on-a-sleeve_default        Docker bridge network (internal DNS)
```

Both agents share the **same Docker engine, the same containers, and the same database.** A database write from a Windows-agent session is immediately visible to a WSL-agent session, and vice versa.

---

### Known host-specific quirks

#### Windows agent — port 8000 blocked by WSL relay

Docker Desktop on Windows uses a `wslrelay` process to bridge WSL ↔ Windows networking. On this machine, a persistent SSH tunnel inside Ubuntu WSL (`ssh -L 8000:...`) causes `wslrelay` to bind `127.0.0.1:8000` and `::1:8000` on the Windows side. This intercepts any attempt to reach the Docker backend at `localhost:8000` from Windows processes (curl, PowerShell, Vite's Node proxy).

**Workaround:** use `--profile full`. The nginx frontend container proxies to the backend over the internal Docker network (`http://backend:8000`) — this never touches the Windows host port, so the SSH tunnel is irrelevant.

If you need the raw Vite dev-server workflow from Windows, kill the tunnel in WSL first:
```bash
# inside Ubuntu WSL
kill $(pgrep -f 'ssh.*8000')
```

#### Windows agent — CRLF line endings

Git on Windows may convert LF → CRLF on checkout, producing massive noisy diffs where every line appears changed. This is cosmetic only — no real content change — but it pollutes `git diff` and can confuse staged-vs-unstaged analysis.

Do not commit CRLF-inflated diffs. Check `git diff --stat` for suspiciously balanced insertion/deletion counts (e.g. `+4428 / -4416`) before staging — that pattern means line-ending noise, not real changes.

#### Linux (WSL) agent — Docker label

Images built from Ubuntu WSL carry the label `desktop.docker.io/wsl-distro: Ubuntu`. This is cosmetic metadata added by Docker Desktop. It has no effect on runtime behaviour or CI.

---

### Canonical workflows

These are the only two ways to run the project. Do not invent new port mappings, custom docker run commands, or parallel compose files.

#### Dev mode — hot reload (preferred for code changes)

```bash
# Start database + backend (Docker)
docker compose up -d

# Start frontend dev server (Vite, whichever shell you're in)
cd frontend/cesium && npm run dev
# → http://localhost:5173
```

- Backend source is bind-mounted (`./backend:/app`) — FastAPI reloads on save
- Frontend TypeScript compiles on save in the browser
- Vite proxies `/api` and `/output` → `localhost:8000`
- **Windows agents:** only usable if port 8000 is free (no SSH tunnel). Otherwise use full mode.

#### Full mode — production-like, all Docker (preferred for integration testing and Windows agents)

```bash
docker compose --profile full up -d --build
# → http://localhost:8080
```

- Builds the Vite bundle inside Docker, serves via nginx
- nginx proxies to backend over internal Docker network (no host port conflict)
- Matches Cloud Run topology exactly: nginx → FastAPI → PostgreSQL
- Omit `--build` if frontend source hasn't changed (saves ~15 s)

```bash
# Tear down
docker compose --profile full down
```

---

### What each mode does NOT share

| | Dev mode | Full mode | Cloud Run |
|---|---|---|---|
| Hot reload (backend) | ✅ | ❌ (restart to update) | ❌ |
| Hot reload (frontend) | ✅ | ❌ | ❌ |
| Mirrors nginx routing | ❌ | ✅ | ✅ |
| Port 8000 on host needed | ✅ | ❌ | ❌ |
| Uses docker-compose.yml | ✅ | ✅ | ❌ |
| Uses CI pipeline | ❌ | ❌ | ✅ |

---

### Cloud Run — how deployment works

**docker-compose.yml is not used by Cloud Run.** The CI pipeline (`ci.yml`) builds Docker images directly from `./backend` and `./frontend` using `docker/build-push-action`. Changes to docker-compose files have zero effect on the deployed cloud service.

Deployment is automatic on every push to `main` that passes CI, provided `GCP_PROJECT_ID` is set in GitHub repo Variables. See [`docs/DEPLOY.md`](DEPLOY.md) for the one-time GCP setup.

```
git push origin main
  └─► GitHub Actions
        ├── lint-backend (ruff)
        ├── typecheck-frontend (tsc)
        ├── test-backend (pytest smoke)
        ├── build-backend image
        ├── build-frontend image
        ├── publish-images → ghcr.io (always, on main)
        └── deploy → Google Cloud Run (if GCP_PROJECT_ID set)
```

---

### Rules for all agents

1. **Never commit machine-specific port remaps.** If port 8000 is blocked locally, use `--profile full` rather than changing `docker-compose.yml` or `vite.config.ts`.
2. **Never commit CRLF inflation.** Verify `git diff` shows real content changes before staging.
3. **Stage and commit atomically.** Don't leave large staged hunks from a previous session; another agent will pick them up and misread the state.
4. **Use `docker compose down` when done.** Leaving containers running across sessions causes database state confusion.
5. **Both agents write to the same ISSUES.md.** Log findings immediately; resolve immediately on fix.

---

## Phase 1 — Core Backend ✅ Done

- [x] FastAPI app with uvicorn, all imports clean
- [x] `__init__.py` in all subpackages
- [x] Pydantic v2 schemas — `BBox`, `SVGGenerationRequest`, `STLGenerationRequest`, `LicenseCheckRequest`, `MERCH_SPECS`
- [x] CORS configured for `localhost:5173`
- [x] `POST /api/generate/svg` — fetches OSM, renders SVG, saves to `/output/svg_output/`
- [x] `POST /api/generate/stl` — fetches OSM, generates 3 STL parts, saves to `/output/stl_output/`
- [x] `POST /api/license/check` — returns ODbL attribution
- [x] `GET /api/osm/features` — Overpass proxy for 3D viewer (avoids browser CORS + User-Agent issues)
- [x] `GET /health`
- [x] StaticFiles mount serving generated outputs at `/output`
- [x] Async Overpass client (`httpx`) with `User-Agent: heart-on-a-sleeve/1.0` (required by overpass-api.de)
- [x] CPU-bound generators (SVG + STL) run in thread pool executor — event loop stays responsive
- [ ] Postgres/PostGIS — project storage, caching, user records *(deferred)*
- [ ] Alembic migrations
- [ ] Rate limiting on Overpass calls

---

## Phase 2 — SVG Generation ✅ Done

- [x] Real OSM vector data → print-ready SVG via `svgwrite`
- [x] Three style presets: `osm_default`, `minimalist`, `vibrant`
- [x] Draw order: landuse → water → buildings → roads → railways → labels
- [x] Landuse groups: agriculture, parks/managed green, residential/civic, industrial
- [x] Water: polygon fills (lakes, reservoirs) + line widths (rivers, canals, streams)
- [x] Roads: two tiers (main/other), no casings, width by road class
- [x] Buildings: footprint polygons, toggleable
- [x] Railways: black lines in minimalist + vibrant
- [x] Place labels: city/town/village/suburb/neighbourhood from OSM `place=*` nodes
- [x] ODbL attribution embedded in SVG
- [x] `include_buildings` and `include_labels` toggles
- [x] **cosLat projection** — east-west features scale correctly (no ~1.7× stretch at UK latitudes)
- [x] **Edge clipping** — `<clipPath>` cuts roads/buildings at the canvas boundary
- [x] Bbox passed from request (not derived from node spread)
- [ ] Proper coordinate projection (pyproj EPSG:27700 for UK)
- [ ] Bleed margins
- [ ] Mug wrap perspective
- [ ] SVG validation

---

## Phase 3 — STL / 3D Generation ✅ Done (v2)

Three interlocking pieces per print:

- [x] **buildings.stl** (grey) — building pillars + road ribbons, Z=0→bldg_h
  - Flat mode: extrudes fully merged `urban_union` (terrace rows → single block)
  - Topology mode: individual buildings at proportional heights from OSM tags
  - Outer collar walls (collar_mm wide) frame the assembly
  - Polygon simplification (Douglas-Peucker) + gap closing (dilate→union→erode)
- [x] **water.stl** (blue) — water bodies + buffered waterways, Z=water_start→water_end
  - Building/road shapes punched out (pillars slot through)
  - Water bodies expanded by `water_expand_mm` (printable minimum width)
- [x] **land.stl** (green, locking lid) — Z=land_start→land_end
  - Same outer footprint as grey base (collar_mm on all sides)
  - Building holes so protrusions pierce through and clamp the stack
  - Flat for coaster/placemat; SRTM terrain mesh for topology/relief mode
- [x] All 8 parameters exposed in API and live viewer panel:
  `bldg_height`, `water_start`, `water_end`, `land_start`, `land_end`, `gap_close_mm`, `water_expand_mm`, `min_bldg_mm`, `collar_mm`
- [x] SRTM elevation via OpenTopoData (topology mode, 10×10 grid)
- [x] shapely `make_valid` for degenerate polygons
- [x] mapbox-earcut installed for trimesh triangulation
- [ ] Watertight mesh validation
- [ ] Hollowing for large prints
- [ ] Terrain side walls (fully closed solid)

---

## Phase 4 — Licence Tracker ✅ Done (v1)

- [x] ODbL attribution returned on every generate request
- [x] Attribution embedded in SVG `<text>` element
- [ ] SVG `<metadata>` block with CC namespace
- [ ] PDF licence report export
- [ ] User-uploaded asset licence detection

---

## Phase 5 — CesiumJS Frontend ✅ Done

- [x] CesiumJS 1.141 with OSM tiles — no Ion token required
- [x] Left-drag bbox drawing — aspect-ratio locked with cos(lat) correction
- [x] Move handle (drag inside shape)
- [x] Corner resize handles (inner zone, maintains ratio)
- [x] Corner rotate handles (outer billboard ring with arc-arrow icon)
- [x] Rotation in geographic space (correct cos(lat) scaling)
- [x] Globe controls: rotate=disabled during draw, scroll-zoom + middle-tilt always on
- [x] Merch panel split: Fabrics & Transfers (3 col) / 3D Prints (3 col)
- [x] **Auto-draw on merch click** — clicking any product type immediately enters draw mode (no separate Draw button); re-clicking the active type redraws; clicking a different type while editing just re-ratios the existing selection
- [x] **Circle + hexagon coaster shapes** — globe polygon renders as circle (64-pt) or hexagon when those coaster shapes are active; all hit-tests and screen AABB use the correct shape
- [x] **Generate transition** — pixelation phases → fake-asymptotic progress bar (tau from bbox-area estimate) → zoom to SVG-viewer fit bounds → pixel-to-SVG cross-dissolve
- [x] Camera pitch constraints (20°–90° from horizon)
- [x] **Fabric/transfer types** — "View 3D →" hidden; "↓ Download SVG" highlighted as primary action
- [ ] Preset location dropdown
- [ ] Scale bar
- [ ] Geolocation
- [ ] EPSG:27700 coordinate display
- [ ] **SSE streaming progress** from SVG/STL generators so transition bar tracks real server progress *(deferred — requires backend chunked-response endpoint)*

---

## Phase 5b — SVG Viewer ✅ Done

- [x] `/svg-viewer.html` — standalone pan/zoom viewer
- [x] Fetches SVG as text, parses `viewBox` for reliable dimensions (img.naturalWidth = 0 for SVGs)
- [x] Scroll to zoom (towards cursor), left-drag to pan
- [x] Fit-to-window (with margin) and Actual Size buttons
- [x] Download link, dark background

---

## Phase 5c — 3D Map Viewer ✅ Done

- [x] `/3d-viewer.html` — live Three.js OSM renderer
- [x] Fetches OSM via `/api/osm/features` backend proxy (no browser CORS issues)
- [x] 60 s AbortController timeout with clear error message
- [x] Buildings: `ExtrudeGeometry` from OSM footprints + real heights (3 tiers)
- [x] Roads: hand-built ribbon geometry, width by road class
- [x] Parks + water: flat coloured polygons
- [x] Mouse controls match Cesium (left=orbit, right=zoom, middle=pan)
- [x] **Solid colours**: fixed print-material scheme (grey/blue/green) — not scheme-dependent
- [x] **Wireframe**: per-type neon colours — parks=green, water=blue, roads=orange/yellow, buildings=cyan/purple/white; black background
- [x] Grid: light blue solid / bright blue wireframe
- [x] **Floating progress bar** — render loop starts before OSM fetch; `#loading` is a translucent bottom bar; pre-load fake-asymptotic fill (0→50%, tau from bbox area); 3 s minimum pre-load; post-load 5 s wireframe entry drives bar 50→100%; bar hides when animation completes
- [x] **Print Preview** — loads all 3 STL parts in correct print colours, spatially aligned
- [x] **⟳ Regenerate STL** panel — 9 tunable parameters, calls API, updates downloads + Print Preview in-place
- [x] STL download links for all 3 parts
- [x] **Fabric Preview** — SVG as `TextureLoader` ground plane + buildings-only OSM; hides roads/water/parks (SVG covers them)
- [x] **Layered print animation** — buildings wireframe fade-in → solid fill; water plate descends from above; land lid descends from above; ease-out cubic on descent phases
- [ ] Terrain elevation in live render (SRTM)
- [ ] Roof shapes
- [ ] Street-level textures

---

## Phase 5d — Design System ✅ Done

- [x] `public/app.css` — single CSS file shared by all three pages
- [x] 24 CSS custom properties (`--bg-*`, `--border-*`, `--text-*`, `--accent-*`, `--toggle-*`, `--radius-*`)
- [x] Shared components: `.panel`, `.btn`, `.btn-primary`, `.divider`, `.section-label`, `.dl-label`, `.param-row`, `.toggle-row`, `.toggle`, `#loading`, `.hint`, `.spinner`
- [x] Page-specific styles reduced to layout + unique components only

---

## Phase 5e — Client-side SVG Renderer ✅ Done

Moved SVG generation from the Python backend to the browser for Cloud Run scalability:

- [x] `frontend/cesium/src/svg-renderer.ts` — full TypeScript port of Python `svg_generator.py`
  - All three style presets (osm_default, minimalist, vibrant) with identical colour palettes
  - cosLat projection exactly matching backend formula
  - Same draw order: landuse → water → buildings → roads → railways → labels → attribution
  - Clip-path support (square/circle/hexagon for coasters)
- [x] `generate()` in `app.ts` — fetches `/api/osm/features` then calls `renderSvg()` client-side; no `/api/generate/svg` call
- [x] `svgRegen()` — uses cached OSM data (`_cachedOsmData`), re-renders with new palette/toggles at ~0 ms (no API call)
- [x] `POST /api/save-svg` — backend endpoint to persist client-rendered SVG text to `/output/svg_output/` for dashboard thumbnails
- [x] `saveProject()` — POSTs SVG text to `/api/save-svg` before saving project (blob: URL → stable /output/ URL)
- [x] Backend `/api/generate/svg` still available for server-side use (PDF export, server batch)

**Why:** Python GIL limits SVG parallelism to ~2 concurrent generations per Cloud Run instance. With client-side rendering, the backend only handles I/O-bound Overpass proxy calls — zero CPU per generation, trivially scales to hundreds of concurrent users.

---

## Phase 6 — SVG Editor App ✅ Done

- [x] Load generated SVG into an editable panel (pan/zoom viewport + side panel)
- [x] Layer toggles — Buildings + Place Labels (intentionally scoped; roads/parks always included)
- [x] Per-layer colour picker — 6 categories × 6 swatches, live regeneration
- [x] Re-render at 300 DPI — all merch types auto-generate at print resolution (300 DPI)
- [x] Download SVG button

---

## Phase 7 — WooCommerce Integration 📋 Planned

- [ ] WooCommerce REST API client
- [ ] Create product from design project
- [ ] Price calculation: base cost + configurable markup
- [ ] Order submission to POD provider
- [ ] Webhook handlers

---

## Phase 8 — POD Providers 📋 Planned

- [ ] Prodigi API: POST /orders, upload print file
- [ ] Printful API: fallback/DTG coverage
- [ ] Fulfillment webhook → update order status

---

## Phase 9 — User Auth & Dashboard ✅ Done

- [x] JWT auth — register + login endpoints, bcrypt passwords, access/refresh tokens (30 min / 7 day)
- [x] Save design projects — POST /api/projects stores bbox, merch type, SVG/STL URLs, palette, toggles
- [x] List + delete saved projects — GET/DELETE /api/projects with user ownership check
- [x] Login/register page — `/login.html` with tab toggle, localStorage token storage
- [x] Dashboard — `/dashboard.html` grid of saved projects with thumbnail, open + delete
- [x] Save button in SVG viewer (both inline and standalone) — prompts login if unauthenticated
- [x] User nav (Login / My Designs / Logout) in all SVG panels
- [ ] Order history + re-order *(deferred to Phase 7/8)*
- [ ] Share design (public view-only link) *(future)*

---

## Phase 10 — Deployment 🔄 In Progress

- [x] `backend/Dockerfile` — Python 3.12-slim, thread pool, SIGTERM-safe
- [x] `frontend/Dockerfile` — node:20-alpine build → nginx:alpine serve
- [x] `docker-compose.yml` — two modes: default (DB + backend, Vite dev server) and `--profile full` (adds nginx frontend on :8080)
- [x] `docker-compose.prod.yml` — production compose (no pgadmin, env-validated secrets, restart policies)
- [x] `frontend/nginx.conf` — reverse proxy with large buffers for JWT, SPA routing
- [x] DB tables auto-created on startup via `Base.metadata.create_all` in lifespan — no manual migration step needed for Cloud Run
- [x] GitHub Actions CI — ruff lint, tsc typecheck, pytest smoke, build + push images to ghcr.io
- [x] GitHub Actions CD — deploy to Cloud Run on push to main (dormant until `GCP_PROJECT_ID` repo variable is set)
- [ ] `heart.stuartjatkinson.co.uk` custom domain + TLS (Cloud Run domain mapping + DNS)
- [ ] Rate limiting on Overpass calls
- [ ] Alembic migrations (currently using `create_all` — fine for new deploys, not for schema changes)

---

## Current status summary

| Phase | Status | Key deliverables |
|---|---|---|
| 1. Core Backend | ✅ Done | FastAPI, Overpass proxy, thread pool, all endpoints |
| 2. SVG Generation | ✅ Done | 3 styles, cosLat projection, edge clipping, place labels |
| 3. STL Generation | ✅ Done | 3-piece interlock, gap closing, topology mode, 9 tunable params |
| 4. Licence Tracker | ✅ Done (v1) | ODbL attribution in every output |
| 5. CesiumJS Frontend | ✅ Done | Draw/move/resize/rotate, merch panel, style selector |
| 5b. SVG Viewer | ✅ Done | Pan/zoom, fit, download |
| 5c. 3D Map Viewer | ✅ Done | Live OSM render, Print Preview, live regenerate |
| 5d. Design System | ✅ Done | Unified CSS, variables, shared components |
| 5e. Client SVG Renderer | ✅ Done | TS port of svg_generator.py, client-side regen, save-svg endpoint |
| 6. SVG Editor | ✅ Done | Side panel, colour picker, layer toggles, live regen, 300 DPI output |
| 7. WooCommerce | 📋 Planned | |
| 8. POD Providers | 📋 Planned | |
| 9. Auth + Dashboard | ✅ Done | JWT auth, register/login, save/dashboard, user nav |
| 10. Deployment | 🔄 In Progress | Docker, prod compose, CI — CD + domain pending |

---

## Embeddable SPA consolidation (planned 2026-06-01)

**Goal:** collapse the page-by-page UI into one self-contained, state-machine-driven SPA
(sidebar · main stage · persistent status bar) so it can ship as an embeddable widget /
single-page attachment. End model: a saved **config** drives on-demand pulls + renders held
**entirely client-side**, with reversible animations between cached stages.

**Target shell**
```
┌───────────┬───────────────────────────────┐
│  SIDEBAR  │  STAGE (map | svg | 3d | print)│  ← one container, content swaps per state
│ docked/   │                                │
│ float/    │                                │
│ sheet     │                                │
├───────────┴───────────────────────────────┤
│  STATUS BAR — tool attributions, always on │
└─────────────────────────────────────────────┘
```
States: `select → svg → map3d → print3d` (+ dashboard/login overlays). **Back = state pop,
not navigation** (no re-pull).

**Page inventory**
- Live primary: `index.html` (SPA). Auxiliary: `dashboard.html`, `login.html`, `landing.html`.
- `3d-print.html` — live but a near-duplicate of the inline 3D viewer (own panel/loading/
  controls/save/nav IDs). Fold into the SPA as the `print3d` state.
- `3d-viewer.html` — **orphaned, no refs → delete** (Stage 1).
- `svg-viewer.html` — still referenced by `dashboard.html` "Open" link; delete only once the
  dashboard "Open" routes into the SPA (Stage 4).

**Decisions**
- Attribution: **status bar only, none in generated files** (chosen 2026-06-01). Removes
  `_draw_attribution` (svg_generator.py) + client attribution text (svg-renderer.ts).
  ⚠️ ODbL produced-works obligation to be handled via the app/product page, not the file.
- Non-rect SVG (circle/hexagon coaster): background clipped to the shape → **transparent
  outside** the shape (alpha corners).
- **Server stores config only** (design_projects row); STOP persisting generated SVG/STL.
  Generation endpoints stream, write nothing. Client holds a pipeline cache keyed by
  `hash(config)+stage` (osm → svg blob → stl blobs → render snip); reverse traversal restores
  the snip with no re-fetch/regenerate; downloads come from cached client blobs.

**Stages** (each independently shippable)
1. ✅ Delete orphaned `3d-viewer.html`. (svg-viewer.html deferred to Stage 4.) *(2026-06-01)*
2. ✅ Persistent status bar (`.app-status-bar` in app.css; in index.html + 3d-print.html) +
   attribution removed from generated files (svg-renderer.ts + svg_generator.py) + circle/hex
   background clipped to the shape (transparent corners). *(2026-06-01)*
3. 📋 Extract shared components (sidebar shell, loading bar, save, user-nav, mobile sheet); de-dup IDs.
   (Largely shrunk now 3d-print is folded in — remaining work is in-SPA dedup only.)
4. 🔄 Fold print view into the SPA:
   - ✅ `print-viewer.ts` (`PrintViewer`) + `#viewer-print-view` overlay in index.html; the 3D-map
     "🖨 3D Print →" button now pushes an in-SPA state via `Viewer3D.onPrint` → `openPrintView`
     (no navigation). "← 3D Map" = state pop (no re-pull). Old `hoas_return_to_3d` shim removed.
     `3d-print.html` deleted. *(2026-06-01)*
   - ✅ Dashboard "Open" re-pointed to `/index.html?design=<id>` (SPA loads it via `loadDesign`);
     dashboard thumbnail fixed to use `thumbnail_data_url`. `svg-viewer.html` deleted. The
     dashboard↔svg-viewer pair was an orphaned legacy island — the SPA's in-app "My Designs"
     panel already replaced it. *(2026-06-01)*
5. 📋 Client pipeline cache + stop server-side file persistence (reversibility / embeddable payoff).

**Remaining legacy:** `dashboard.html` kept as a standalone gallery (Open now routes into the
SPA); could later fold into the in-app "My Designs" panel entirely. `landing.html` + `login.html`
remain as separate entry pages by design.
