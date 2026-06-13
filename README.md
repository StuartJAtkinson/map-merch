# Heart on a Sleeve

A map-to-merch platform. Select any area on an interactive OSM globe, choose a product, and generate print-ready SVG artwork and 3D-printable STL files from real OpenStreetMap data — with a live 3D preview and a tunable 3D print generator.

---

## What it does

1. **Draw a selection** on the CesiumJS globe — left-drag to draw, then move, resize (corner handles), or rotate (outer ring). The bounding box is aspect-ratio locked to the chosen merch type with cos(latitude) correction.
2. **Choose merch** — Fabrics & Transfers (T-Shirt, Mug, Tote) or 3D Prints (Coaster, Placemat, Relief).
3. **Choose a style** — OSM Default (warm cartographic), Minimalist (greyscale + railways), or Vibrant (saturated).
4. **Generate** — backend fetches OSM vector data from Overpass, renders a print-ready SVG (with edge clipping and correct geographic projection) and three interlocking 3D-printable STL files.
5. **Preview SVG** — pan/zoom viewer with fit-to-window, actual-size, and download.
6. **Preview 3D** — live Three.js renderer showing buildings, roads, water, parks from real OSM heights. Toggle **Print Preview** to load the actual STL model in three print-material colours. Tune layer heights and regenerate in-place.

---

## Architecture

```
heart-on-a-sleeve/
├── backend/                        FastAPI (Python 3.12)
│   ├── app/
│   │   ├── api/
│   │   │   ├── router.py           REST endpoints (async, thread-pool for CPU work)
│   │   │   ├── auth.py             JWT register/login/refresh/me
│   │   │   └── projects.py         Save/load design projects (CRUD)
│   │   ├── core/
│   │   │   ├── config.py           Settings (env vars, pydantic-settings)
│   │   │   ├── database.py         Async SQLAlchemy engine + session
│   │   │   └── security.py         bcrypt hashing, JWT access+refresh tokens
│   │   ├── models/
│   │   │   ├── db_models.py        User + DesignProject ORM models
│   │   │   └── schemas.py          Pydantic request/response models
│   │   └── services/
│   │       ├── osm_fetcher.py      Async Overpass API client
│   │       ├── svg_generator.py    OSM → SVG (cosLat projection, 3 styles)
│   │       ├── stl_generator.py    OSM → 3 interlocking STL pieces
│   │       └── license_tracker.py  ODbL attribution
│   ├── Dockerfile
│   └── requirements.txt
│
├── frontend/
│   ├── Dockerfile                  Multi-stage: node build → nginx:alpine serve
│   ├── nginx.conf                  Reverse-proxy template (BACKEND_URL injected at start)
│   └── cesium/                     Vite + TypeScript + CesiumJS
│       ├── src/app.ts              Globe selector, bbox draw/move/resize/rotate
│       ├── public/
│       │   ├── app.css             Shared design system
│       │   ├── login.html          Auth page
│       │   ├── dashboard.html      Saved projects
│       │   ├── 3d-viewer.html      Three.js OSM renderer + Print Preview
│       │   └── svg-viewer.html     Pan/zoom SVG viewer + colour editor
│       └── index.html              Map selector + merch picker
│
├── docker-compose.yml              Dev: database + backend (+ frontend via --profile full)
├── docker-compose.prod.yml         Prod-like: all services with env-file credentials
├── db/init/                        PostgreSQL init SQL (runs on first container start)
└── docs/
    ├── DEPLOY.md                   One-time GCP / Cloud Run setup guide
    └── ROADMAP.md                  Phase plan and build status
```

**Request flow (full local / Cloud Run):**

```
Browser → nginx (port 80/8080)
            ├── /           → serve built Vite bundle
            ├── /api/*      → proxy to FastAPI backend
            └── /output/*   → proxy to FastAPI static files

FastAPI backend
    ├── /api/auth/*         → JWT auth (PostgreSQL users table)
    ├── /api/projects/*     → design project CRUD (PostgreSQL)
    ├── /api/generate/svg   → Overpass fetch → svgwrite render
    ├── /api/generate/stl   → Overpass fetch → trimesh/shapely STL
    └── /api/osm/features   → Overpass proxy (3D viewer live render)
```

---

## Environments

| Environment | How it runs | URL |
|---|---|---|
| **Dev** | Vite dev server + Docker backend + Docker DB | `:5174` |
| **Full local** | All three services in Docker (mirrors Cloud Run) | `:8080` |
| **Cloud (prod)** | CI/CD → Google Cloud Run (auto on push to `main`) | Custom domain |

---

## Running locally

### Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (running)
- [Node.js 20+](https://nodejs.org/) (for dev mode only)

---

### Dev mode — fast iteration with hot reload

Use this for day-to-day development. The backend and database run in Docker; the frontend runs as a Vite dev server with TypeScript hot-reload.

**1. Start the backend and database:**

```bash
docker compose up -d
```

This starts `database` (PostgreSQL/PostGIS on `:5432`) and `backend` (FastAPI on `:8000`, source-mounted with `--reload`). Database tables are created automatically on first startup.

**2. Start the frontend dev server:**

```bash
cd frontend/cesium
npm install          # first time only
npm run dev          # → http://localhost:5174
```

Vite proxies `/api` and `/output` to the backend at `localhost:8000`.

**3. Stop everything:**

```bash
docker compose down
```

---

### Full local mode — production-like stack

Use this to test the full nginx → backend → database pipeline exactly as it runs on Cloud Run. No Vite dev server; the frontend is compiled and served by nginx.

```bash
docker compose --profile full up -d --build
# → http://localhost:8080
```

Stop it:

```bash
docker compose --profile full down
```

> **Note:** the `frontend` service rebuilds the Vite bundle each time `--build` is passed.
> Omit `--build` if the frontend source hasn't changed.

---

### Cloud Run (production)

Deployment is automatic. Every push to `main` that passes CI will:

1. Build and push both Docker images to `ghcr.io` (always)
2. Deploy to Google Cloud Run (only if `GCP_PROJECT_ID` is set in repo Variables)

The CI pipeline builds images directly from `./backend` and `./frontend` — it does **not** use `docker-compose.yml`. Changes to `docker-compose.yml` have no effect on the cloud deployment.

See [`docs/DEPLOY.md`](docs/DEPLOY.md) for the one-time GCP setup.

---

## API endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `POST` | `/api/generate/svg` | Fetch OSM + render SVG |
| `POST` | `/api/generate/stl` | Fetch OSM + generate 3 STL files |
| `GET` | `/api/osm/features` | Proxy Overpass fetch (used by 3D viewer) |
| `POST` | `/api/license/check` | ODbL attribution info |
| `GET` | `/output/svg_output/{file}` | Download generated SVG |
| `GET` | `/output/stl_output/{file}` | Download generated STL part |

---

## Merch types

| Product | Category | Aspect ratio | SVG size |
|---|---|---|---|
| T-Shirt | Fabric | 3:4 | 3000×4000 px @300 dpi |
| Mug | Fabric | 9:3 | 2700×900 px @300 dpi |
| Tote Bag | Fabric | 2:3 | 2000×3000 px @300 dpi |
| Coaster | 3D Print | 1:1 | 95×95 mm plate |
| Placemat | 3D Print | 14:10 | 150×107 mm plate |
| Relief | 3D Print | 1:1 | 100×100 mm plate |

---

## SVG generation

- **Three styles**: OSM Default (warm cartographic), Minimalist (main roads + railways only, no labels), Vibrant (saturated)
- **Layers** (draw order): landuse → water → buildings → roads → railways → place labels
- **Projection**: correct cosine-of-latitude scaling — geographic squares appear as squares in the SVG
- **Edge clipping**: `<clipPath>` ensures roads/buildings crossing the bbox boundary are cut cleanly
- **Place labels**: city/town/village/suburb/neighbourhood, sized and weighted by hierarchy
- **Attribution**: ODbL credit embedded in every SVG

---

## 3D printing — three interlocking pieces

Every generate produces three separate STL files designed to slot together:

```
Green lid (land)    ← locking top cap, same outer footprint as grey base
                      holes where building pillars pierce through
Blue layer (water)  ← thin disc at 1–2 mm, within the collar walls
                      holes where buildings/roads punch through
Grey base (bldg)    ← building pillars + roads from Z=0
                      outer collar walls frame the assembly
```

Assembly: grey frame/pillars → blue water slots inside → green lid snaps over building tops.
Building protrusions act as alignment pins clamping the stack.

### STL modes by merch type

| Merch | Mode | Description |
|---|---|---|
| **Relief** | Topology | Buildings at real OSM heights (proportional), SRTM terrain for land lid |
| **Coaster / Placemat** | Flat | All buildings normalised to same height; flat land lid; glue clear acrylic for "map under glass" |
| **Fabrics** | Basic | Flat base + roads + gentle building extrusions (reference object) |

### Tunable parameters (all exposed in the 3D viewer)

| Parameter | Default | Effect |
|---|---|---|
| Building height | 4 mm | Top of building pillars |
| Water start / end | 1–2 mm | Water layer Z range |
| Land start / end | 2–3 mm | Land lid Z range |
| Gap close | 0.8 mm | Merge buildings closer than this (terrace rows → single block) |
| Water expand | 0.5 mm | Enlarge water bodies so thin waterways are printable |
| Min building height | 1 mm | Floor for any building |
| Collar width | 1 mm | Outer frame walls on grey base and green lid |

---

## 3D viewer

- **Live OSM render** (default): buildings extruded from `building:levels`/`building:height` tags, roads as ribbons, water/parks as flat polygons. Matches Cesium mouse controls (left=orbit, right=zoom, middle=pan).
- **Print Preview**: loads the actual three STL files. Pieces shown in print-material colours.
- **Wireframe**: per-type neon colours — parks=green, water=blue, roads=orange/yellow, buildings=cyan/purple/white.
- **Solid colours**: fixed print-material scheme (grey buildings, blue water, green land) regardless of 2D style.
- **⟳ Regenerate STL**: adjust any parameter, click regenerate — backend produces new files and Print Preview updates in-place.

---

## Design system

All three pages share `public/app.css` — a single CSS file with 18 custom properties:

```css
--bg-page, --bg-panel, --bg-item, --bg-hover
--border-panel, --border-item, --border-dim
--text-primary, --text-high, --text-mid, --text-muted, --text-dim, --text-faint
--text-label, --text-sublabel
--accent, --accent-soft, --accent-border
--toggle-track, --toggle-dot, --toggle-on
--radius-panel, --radius-btn, --radius-input, --panel-pad
```

Shared components: `.panel`, `.btn`, `.btn-primary`, `.divider`, `.section-label`, `.dl-label`, `.param-row`, `.toggle-row`, `.toggle`, `#loading`, `.hint`, `.spinner`.

---

## Tech stack

| Layer | Technology |
|---|---|
| Globe selector | CesiumJS 1.141 — OSM tiles, no Ion token required |
| Frontend build | Vite 8 + TypeScript |
| 3D preview | Three.js 0.160 + OrbitControls + STLLoader |
| SVG viewer | Vanilla JS inline SVG, pan/zoom |
| Backend API | FastAPI 0.136 + Uvicorn (async, CPU tasks in thread pool) |
| OSM data | Overpass API (overpass-api.de) via httpx — User-Agent required |
| Elevation | OpenTopoData SRTM90m (topology mode only) |
| SVG generation | svgwrite — cosLat projection, clipPath edge clipping |
| STL generation | trimesh + shapely + mapbox-earcut |
| Licence | ODbL — attribution embedded in all SVG outputs |

---

## Data & licence

OpenStreetMap data © OpenStreetMap contributors, licensed under [ODbL](https://opendatacommons.org/licenses/odbl/). Attribution is required in all generated outputs and is embedded automatically.

See [docs/ROADMAP.md](docs/ROADMAP.md) for the full build plan and phase status.
