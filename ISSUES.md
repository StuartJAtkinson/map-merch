# Issues — Heart on a Sleeve

## Open

- [ ] **Prod register/login 500 — `column users.reset_token does not exist`** — the lifespan ad-hoc migration's Postgres branch (`router.py`) ignored the per-column SQL and always ran `ALTER TABLE design_projects ADD COLUMN IF NOT EXISTS {col} TEXT`, so the 2026-06-13 `reset_token`/`reset_token_expires_at` columns were never added to `users` in Cloud SQL (and were wrongly added to `design_projects` as junk TEXT columns). Every `select(User)` (register duplicate-check, login) 500s since that deploy. Reproduced live; traceback confirmed in Cloud Run logs. **Fix written and verified locally** (migration table/type now per-column; dropped the columns from local Postgres, restarted backend, columns re-added, register 201) — awaiting commit+push to deploy via CD. Junk `reset_token`/`reset_token_expires_at` TEXT columns left on prod `design_projects` are harmless; drop at leisure. *(found 2026-07-04)*

- [ ] **Cloud SQL `hoas-db` public IP exposed** — `sslMode` forced to `ENCRYPTED_ONLY` (all connections must be TLS-encrypted; unencrypted access rejected at the protocol level). Public IP cannot be disabled: instance has no private IP or PSC, and the Compute Engine API needed to create a VPC/PSC network is not enabled on the project. The backend connects via Cloud SQL Auth Proxy socket (`/cloudsql/...`), which does not need the public IP. Remaining risk: an attacker with the IP could attempt a TLS handshake, but would be rejected without a valid certificate. To fully resolve: enable Compute Engine API, create a VPC and Private Service Connect network attachment, then `--no-assign-ip`. *(found 2026-06-04)*
- [ ] **backend `.venv` built under WSL, unusable from Windows** — `backend/.venv/pyvenv.cfg` `home = /usr/bin`, so its Windows `python.exe` errors (`did not find executable at '/usr/bin\python.exe'`). Windows-side tooling can't use it; had to fall back to system `py -3`. Recreate the venv per-OS or keep it WSL-only. *(found 2026-06-04)*
- [ ] **TypeScript 6 migration (deferred)** — Dependabot #6 (TS 5.9.3→6.0.3) breaks `tsc`: `TS2882 Cannot find module or type declarations for side-effect import of 'cesium/Build/Cesium/Widgets/widgets.css'` (TS 6 tightened non-code side-effect imports). Needs an ambient `declare module '*.css'` or tsconfig tweak before upgrading. PR closed to keep `main` green; do as a planned migration. *(found 2026-06-01)*

## Resolved (2026-06-17 session)

- [x] **CI red on `main` — `Lint backend (ruff)` failing, blocked CD to Cloud Run** — ruff reported 5 errors; everything else (pytest, tsc, gitleaks, image builds) was green, but `publish-images` and `deploy` (Cloud Run) `needs: lint-backend` so the whole pipeline was gated. Fixes: (1) **real bug** — `decode_token` was used in `get_current_user`/`refresh` (`app/api/auth.py`) but never imported (F821) → would 500 on any authenticated request or token refresh in prod; added it to the `app.core.security` import. (2) `TTFont` F821 in `stl_generator.py` string annotation → added a `TYPE_CHECKING` import and dropped the now-redundant `# type: ignore`. (3) removed unused `text_h` (F841) and (4) `except Exception as exc` → `except Exception` (F841). `ruff check .` now clean; CD pipeline unblocked. *(resolved 2026-06-17)*

## Resolved (2026-06-13 session)

- [x] **No app-level password reset / account recovery** — added `POST /api/auth/forgot-password` (generates token, sends email via SendGrid) and `POST /api/auth/reset-password` (verifies token, updates password). `User` model gains `reset_token` + `reset_token_expires_at` columns. `create_reset_token`/`verify_reset_token` in security.py. Email service in `app/services/email.py` using SendGrid v3 API. Token expires after 60 minutes. *(resolved 2026-06-13)*
- [x] **Local dev: port 8000 blocked by WSL SSH tunnel** — docker-compose backend port remapped from `8000:8000` to `8001:8000` so it no longer conflicts with the WSL SSH tunnel. Access backend at `localhost:8001` instead. *(resolved 2026-06-13)*
- [x] **Coaster shape not enforced across all 3D** — ground mesh now uses `CircleGeometry`/`_hexShape()`/`PlaneGeometry` based on `coasterShape`; border Line updated to match; print baseplate uses `CylinderGeometry`/`_hexCylGeometry()`/`BoxGeometry`. *(resolved 2026-06-13)*

## Resolved (2026-06-13 session, cont.)

- [x] **`index.html` corrupted by mojibake (double UTF-8 mis-decode)** — the `#panel-print` block had a truncated opening `<div id="panel-prin...` merged into the next line, and emoji/arrow glyphs (💾 ⬡ ▶ ⟳ ↓ ←) were double-encoded from a prior bad save, breaking the markup. Fixed by splitting the merged tag and reversing the double UTF-8/Latin-1 mis-encoding on the affected lines; `npx tsc --noEmit` and `npm run build` now pass. *(resolved 2026-06-13)*
- [x] **SVG/3D "Green Party" branding stamp** — extended the STL moat-text feature to the SVG and live 3D map. New `Branding`/`BrandStyle`/`BrandPos` types in `svg-renderer.ts` render "WAKEFIELD GREEN PARTY" as either curved/straight Impact-outline text or a solid banner, clipped to the coaster shape; `viewer3d.ts` extrudes the same text with `TextGeometry` + `helvetiker_bold` font, clearing any buildings beneath it and joining the wireframe→solid entry animation. New SVG-panel "Branding" section with on/off toggle, style select, and a click-to-position picker (shape preview + position dots, corner positions only for non-circular shapes). *(resolved 2026-06-13)*

## Resolved (2026-06-12 session)

- [x] **No server-side bbox-area cap** — added `MAX_BBOX_AREA_KM2 = 110` guard (`_guard_bbox`, mirrors frontend `MAX_AREA_KM2=100` with rounding slack) in `router.py`; applied to `/api/generate/svg`, `/api/generate/stl`, `/api/osm/fetch`, `/api/osm/features` and `/api/estimate` — oversized bboxes now 422 before any Overpass fetch. `test_generate_svg__bbox_too_large` rewritten to assert the deterministic 422 (no more 120s flake). Verified via TestClient in the WSL venv: half-of-Europe bbox → 422 on svg + stl. *(resolved 2026-06-12)*

## Resolved (2026-06-04 session)

- [x] **3D viewer + save-name refinements** — (1) removed the `GridHelper` floor from the 3D map; (2) hold the building wireframe→solid entry (`entryReady`) until the SVG fold/translation animation has laid flat, so buildings emerge after the fold (fallback: immediate when no SVG); (3) removed manual save-name entry — the 3 inputs are now read-only `.save-name-preview` divs showing the auto name, save handlers use `buildBaseName()` directly; (4) reverse-geocode `label` now picks the settlement tier (`village>town>city>municipality`) not the sub-locality — Pontefract, not Chequerfield. Verified live on the `:8080` stack. *(resolved 2026-06-04)*
- [x] **Progress bars consolidated + panels aligned + auto save-names** — (1) New leaf `src/status.ts` drives a single global progress/status line in the bottom `.app-status-bar` (fill + message); the map→SVG transition (`app.ts`), 3D loader (`viewer3d.ts`) and STL loader (`print-viewer.ts`) all route through it; removed the per-panel `#loading-3d`/`#loading-print` bars and canvas `drawProgressBar`. (2) `#svg-side`/`#panel3d`/`#panel-print` reordered to one canonical control order with a shared `.save-section`. (3) Auto save-name `Place — Merch (Shape)`: new backend `GET /api/geocode/reverse` (Nominatim, cached) feeds a place pre-flight in `generate()`; `buildBaseName()`/`prefillSaveName()` fill the 3 save inputs; shape token only for coaster; `displayName()` appends `#NN` at display time only when ≥2 saves share a base (index.html My Designs + dashboard.html). No schema change (identity = existing id). tsc + build pass; geocode endpoint live-verified (Pontefract→Chequerfield, London→Covent Garden). *(resolved 2026-06-04)*
- [x] **`httpx.Timeout(connect=,read=,write=)` raised ValueError (swallowed)** — invalid without a default/`pool`, so `/api/estimate`'s Overpass element-count silently always failed (degrading the progress estimate) and the new reverse-geocode returned empty. Fixed both to `httpx.Timeout(<default>, connect=<n>)`. *(resolved 2026-06-04)*
- [x] **Prod secrets in plaintext Cloud Run env vars** — moved `DATABASE_URL` + `SECRET_KEY` off plaintext `--set-env-vars` and onto Secret Manager refs, keeping GitHub Secrets as the single source of truth (no duplication). Bootstrap via gcloud: enabled `secretmanager.googleapis.com`; created secrets `hoas-database-url` / `hoas-secret-key` (v1) from the live values; granted runtime SA (`40846791146-compute@…`) `secretAccessor` and deployer SA (`hoas-deployer@…`) `secretVersionAdder` at the secret level. Updated the live service (rev `hoas-backend-00025-46w`: `--update-secrets` + `--remove-env-vars`); verified env now uses `secretKeyRef`, `/health`=200, register=201. Workflow mirrored: new "Sync secrets to Secret Manager" step adds a version from the GitHub Secret each deploy; `deploy-backend` now uses `secrets:` not `env_vars:` for the two. *(resolved 2026-06-04)*
- [x] **Prod login "not recognised" (401)** — not a deploy/DB-connectivity fault. Backend↔Cloud SQL was healthy (clean 409/401, not 500). Root cause: the only real account was registered as `stuart.john.atkinson@hotmail.com` (not the usual gmail), and the entered password didn't match its bcrypt hash; no reset endpoint exists. Per user choice, connected to `hoas-db` via the bundled Cloud SQL Auth Proxy (token from `gcloud auth print-access-token`, no network/IAM changes) and deleted all 6 rows (the hotmail account + 5 test accounts) so the table is empty for a fresh register via the app UI. Helper: `tools/db_admin.py` (pg8000, reads PGUSER/PGPASSWORD). *(resolved 2026-06-04)*

## Resolved (2026-06-01 session)

- [x] **CD to Cloud Run + Cloud SQL wiring** — first push-to-main after GCP_PROJECT_ID was set activated CD; deploy failed (Cloud SQL APIs off, backend crashing on startup). Enabled `sqladmin`/`sql-component`/`serviceusage` APIs; the `hoas-db` instance + `heart_on_a_sleeve` DB + `heart_user` already existed, so reset `heart_user`'s password, synced the `DATABASE_URL` GitHub secret, and granted the runtime SA (`<PROJECT_NUMBER>-compute@…`) `roles/cloudsql.client`. Deploy now green; verified backend `/health`=200 and a full DB round-trip (register 201 → duplicate 409 → login 200). *(resolved 2026-06-01)*
- [x] **Frontend `/api` proxy loop on Cloud Run — `400 Request Header Or Cookie Too Large`** — `nginx.conf` set `proxy_set_header Host $host` on `/api/`; Cloud Run routes by Host, so proxied requests carried the frontend's host and were routed back to the frontend → infinite loop, `X-Forwarded-For` growing each hop until the header overflowed. Worked locally (Docker routes by address). Removed the Host override so nginx sends the backend's hostname (its proxy_pass default). *(resolved 2026-06-01)*
- [x] **CI smoke tests all fail — `aiosqlite` missing** — CI sets no `DATABASE_URL`, so the backend falls back to its default `sqlite+aiosqlite://` driver, but `aiosqlite` wasn't in `requirements.txt`; the server failed to start (`ModuleNotFoundError`) and all 18 smoke tests errored with connection-refused. Pre-existing (Docker uses Postgres/asyncpg locally so it was masked). Added `aiosqlite>=0.20.0`. *(resolved 2026-06-01)*

- [x] **Dead duplicate app `endpoints.py`** (GH #14) — deleted the orphaned 131-line second FastAPI app; nothing imported it *(resolved 2026-06-01)*
- [x] **SQLite db + `data/` not gitignored** (GH #15) — added `/data/` and `*.db` to `.gitignore` *(resolved 2026-06-01)*
- [x] **Dead code: `_current_bbox` global + unused schemas** (GH #17) — removed `_current_bbox` (def + 2 globals + 2 writes) from router.py; deleted unused `MerchType`/`DesignProjectCreate`/`DesignProjectResponse` and their now-orphaned `datetime`/`Optional` imports from schemas.py *(resolved 2026-06-01)*
- [x] **Startup logs at WARNING + silent migration except** (GH #18) — demoted routine startup logs `warning→info`; migration `except` now logs at `debug` instead of silent `pass` *(resolved 2026-06-01)*
- [x] **Refresh token passed as query param** (GH #11) — `refresh()` now takes a `RefreshRequest` body model; old query-param form returns 422 *(resolved 2026-06-01)*
- [x] **No SECRET_KEY guard** (GH #13) — added `environment` setting; lifespan raises if `ENVIRONMENT=production` and key is still the placeholder (dev/test/CI use default `development`, unaffected) *(resolved 2026-06-01)*
- [x] **Output filename collisions** (GH #16) — `generate_svg`/`generate_stl` now timestamp at microsecond granularity (`%f`), matching `save_svg` *(resolved 2026-06-01)*
- [x] **CORS wildcard + credentials in Cloud Run deploy** (GH #12) — `ci.yml` no longer defaults `CORS_ORIGINS` to `*` (now the real custom domain); also sets `ENVIRONMENT=production` to activate the SECRET_KEY guard *(resolved 2026-06-01)*

- [x] **3D print roads insanely big vs 3D map** — STL had its own `ROAD_WIDTH_MM` (motorway 3.0mm) ~6× wider than the 3D-map SVG (`svg-renderer.ts` `ROAD_W` motorway 5px/1000px ≈ 0.48mm on a 95mm coaster); fat buffers merged and destroyed adjacent roads. Removed the divergent STL table; STL now mirrors `svg-renderer.ts` `ROAD_W`/`WATERWAY_W` scaled by `plate_mm / canvas_px`, so printed roads are identical to the map. Dropped the extra `water_expand` on waterway lines (kept it for polygon water). *(resolved 2026-06-01)*
- [x] **"← 3D Map" button went to map selection** — `3d-print.html` used `history.back()`, which boots the SPA fresh at map selection. Now sets `hoas_return_to_3d` flag and navigates to `/index.html`; implemented the previously-stubbed restore in `app.ts` (`restore3dMapView`) that rebuilds state from `hoas_print_data`, re-fetches OSM, re-renders the SVG, and replays the exact View-3D path. *(resolved 2026-06-01)*

## Resolved (2026-05-30 session)

- [x] **Water crosshatch removed** — was applying everywhere; removed `_apply_crosshatch` entirely; water is now a solid slab; slicer handles infill/material saving *(resolved 2026-05-31)*
- [x] **Layer heights now equal thirds for flat-top coaster** — buildings 0→4mm, water 1.33→2.67mm, land 2.67→4mm; land has no collar ring (collar belongs to buildings layer only); assembled top surface is flat everywhere except water features (recessed 1.33mm) *(resolved 2026-05-31)*
- [x] **Buildings triangular from simplify+gap-close merge** — removed `poly.simplify(0.4)` and the buffer-in/buffer-out gap-close pass; each building polygon extruded individually; `bldg_union` is now a plain `unary_union` for hole-punching water/land *(resolved 2026-05-30)*
- [x] **Solid single-piece STL added** — `_build` now returns a fourth `solid` key; same geometry as 3-piece but with solid (no crosshatch) water layer; downloads as `solid.stl` with a green-tinted button in the panel *(resolved 2026-05-30)*
- [x] **3D viewer iframe replaced with single-page inline viewer** — removed `<iframe id="viewer-3d-frame">`, added `#viewer-3d-view` div + `viewer3d.ts` Viewer3D class; dynamic import in `app.ts` creates instance on first use; `loadScene()` rebuilds Three.js scene in-place each call; `← SVG View` button hides the overlay *(resolved 2026-05-30)*
- [x] **2D→3D not reversible** — with inline viewer the SVG view simply stays under z-index 9999; `btn-3d-back` sets `display:none` restoring the SVG panel with no page reload *(resolved 2026-05-30)*
- [x] **`style.display = ''` bug on btn-back-from-3d** — btn-back-from-3d removed entirely; back is now `btn-3d-back` inside `#panel3d` wired directly in `app.ts` *(resolved 2026-05-30)*

## Resolved (2026-05-29 session)

- [x] **Auth guard doesn't detect expired JWT** — added `atob` payload decode + `exp` field check; clears token and redirects to login if expired or malformed *(resolved 2026-05-29)*
- [x] **SVG generation transition ~3s minimum** — reduced forward-zoom TAU from 2200ms to 600ms; lowered exit threshold from 0.82 to 0.75 → minimum ~830ms *(resolved 2026-05-29)*
- [x] **3D SVG animation is CSS overlay, misses aim, flickers** — replaced CSS shrink/tilt animation with THREE.js PlaneGeometry fold: pivot at scene south edge, rotates -PI/2 from vertical to flat over 600ms, fades out over 400ms *(resolved 2026-05-29)*
- [x] **Print preview baseplate misaligned** — `bpMesh.position.set(centre.x/scaleX, bldLocalMinY-bpH/2, centre.z/scaleZ)` uses STL footprint centre; fixed in previous session, needs Docker rebuild *(resolved 2026-05-29)*
- [x] **Water STL only covers water bodies instead of full base disc** — `_water_piece` now uses full `plate_shape` minus urban as the base layer; land lid sits on top in non-water areas *(resolved 2026-05-29)*

## Resolved

- [x] **Cloud Run auth/sign-in broken — database tables never created** — `Base.metadata.create_all` added to `lifespan` in router.py; runs on every container startup so Cloud Run bootstraps its own schema *(resolved 2026-05-26)*

- [x] **2D transition zoom starts during progress bar** — `fitBounds` moved before phase 3; loop lerps pixelated sel → fitBounds using same fake-asymptotic curve as the bar; phase 4 snaps remaining gap *(resolved 2026-05-23)*
- [x] **2D transition flicker (page navigation)** — merged map-selector + SVG viewer into one page; after transition phases complete the canvas fades out over the already-displayed inline SVG panel; "← Map" button returns to Cesium view without reload *(resolved 2026-05-23)*
- [x] **3D fabric preview: SVG becomes the canvas** — `tickEntry` auto-triggers fabric preview click after entry animation completes for non-3D merch types; user sees wireframe → solid OSM animation then SVG texture + buildings appear automatically *(resolved 2026-05-23)*

- [x] **SVG viewer: fabric types show "Export SVG" not "View 3D →"** — `is3dMerch` check hides btn-3d and highlights download button for tshirt/mug/tote *(resolved 2026-05-23)*
- [x] **3D viewer: SVG as base layer (fabric preview)** — `fabricGroup` + `loadFabricPreview()` load SVG as `TextureLoader` plane + buildings-only OSM render; `btn-mode` shows "🖼 Fabric Preview" for non-3D types *(resolved 2026-05-23)*
- [x] **3D viewer: layered STL print animation** — `printLayers` sub-groups per STL part; `runPrintAnimation()` phases: buildings wireframe fade-in → solid fill → water descends from above → land lid descends from above *(resolved 2026-05-23)*

- [x] **3D viewer road/waterway misalignment** — `roadMesh` built raw vertex buffers with `Z = +latProj`; `polyMesh`/`buildingMesh` use `rotateX(-π/2)` giving `Z = -latProj`; roads were north-south mirrored relative to all polygon features and faced downward (dark from the overhead sun). Fixed: negate all Z components in `roadMesh` vertex push *(resolved 2026-05-23)*

## Resolved

- [x] **3D viewer floating progress bar** — CSS override in 3d-viewer.html; render loop starts before OSM await; pre-load fake-asymptotic bar (0→50%, bbox-area tau); 3 s minimum pre-load; post-load 5 s wireframe entry drives bar 50→100%; bar hides on completion *(resolved 2026-05-23)*
- [x] **Auto-draw on merch click** — draw button removed; clicking any product type enters draw mode; re-clicking active type redraws; clicking different type while editing enforces new ratio without restarting *(resolved 2026-05-23)*
- [x] **Transition zoom to SVG-viewer fit bounds** — `getSvgViewerFitBounds(W,H,ratio)` computes exact landing rect (272 px panel + margins + merch ratio); phases 4+5 animate to that rect instead of full screen *(resolved 2026-05-23)*
- [x] **Progress bar tau from bbox-area estimate** — `estimateGenMs(bbox)` = 1000 + km²×1200 ms, capped 30 s; tau = estimatedMs/3; faster for tiny areas, slower for large cities *(resolved 2026-05-23)*
- [x] **Circle/hex coaster globe shapes** — `selCirclePoints`, `selHexagonPoints`, `selShapePoints` added to app.ts; polygon entity, polyline, `getZone` point-in-polygon check, and `getSelAabb` screen-space AABB all use `selShapePoints`; coaster circle/hexagon now draws the correct shape on the Cesium globe *(resolved 2026-05-23)*
- [x] **Transition redesign — trailing phase + zoom + dissolve** — `runTransition` in app.ts rewritten: phase 1 darken, phase 2 pixelate, phase 3 fake-asymptotic progress bar while awaiting SVG (min 300 ms), phase 4 zoom pixelated selection → fill screen (400 ms), phase 5 cross-dissolve pixelated → SVG (500 ms); `drawProgressBar` helper added *(resolved 2026-05-23)*
- [x] **Merch section order + emoji consistency** — Merch Type moved above Select Area; section numbering removed; tote 👜, placemat 🟫, relief ⛰, draw button ✜; `updateDrawBtn` now uses ✜ instead of 🎯 *(resolved 2026-05-23)*
- [x] **Colour swatches for map style** — 7-category colour picker (Canvas/Water/Fields/Parks/Urban/Buildings/Roads), 6 swatches each; palette_overrides sent to backend; urban_ind/road_other derived automatically *(resolved 2026-05-23)*
- [x] **Coaster shape cycling** — ‹ › buttons on coaster button cycle square/circle/hexagon; shape flows to SVG clipPath and STL plate outline *(resolved 2026-05-23)*
- [x] **SVG generator AttributeError** — `Group` has no attribute `path`; fixed by accessing elements correctly *(resolved 2026-05-23)*
- [x] **Camera north-lock** — postRender heading-snap to 0; heading no longer stored in _validCam *(resolved 2026-05-23)*
- [x] **Wakefield default + perpendicular start** — camera starts at Wakefield council area, pitch −90° (flat Google Maps view), 50 km altitude *(resolved 2026-05-23)*
- [x] **Place resolver (Nominatim)** — debounced search input calling Nominatim OSM geocoder; results dropdown flies camera to place bbox *(resolved 2026-05-23)*
- [x] **Mouse controls hint on selector** — floating hint bottom-right of map showing left/right/middle/scroll controls *(resolved 2026-05-23)*
- [x] **Merch type icons** — emoji icons added to all 6 merch buttons *(resolved 2026-05-23)*
- [x] **3D params explained + expandable** — each STL parameter has a description line; panel split into two collapsible `<details>` groups *(resolved 2026-05-23)*


## Migrated from GitHub Issues (closed 2026-06-30)

> Issue tracking consolidated into this file during the portfolio alignment sweep. The 9 GitHub issues below were closed on GitHub and preserved here as the single source of truth. Tick off as resolved.

- [ ] **#11 [security] Refresh token passed as URL query parameter**
  > `backend/app/api/auth.py:85`
  > 
  > ```python
  > async def refresh(refresh_token: str, db: AsyncSession = Depends(get_db)):
  > ```
  > 
  > A bare `str` parameter on a POST handler is bound by FastAPI as a **query parameter**, so the call is `POST /api/auth/refresh?refresh_token=...`. Refresh tokens then leak into nginx/Cloud Run access logs, proxy logs, and browser history.
  > 
  > **Fix:** accept it in the request body via a Pydantic model:
  > 
  > ```python
  > class RefreshRequest(BaseModel):
  >     refresh_token: str
  > 
  > @router.post("/refresh")
  > async def refresh(req: RefreshRequest, db: AsyncSession = Depends(get_db)):
  >     ...
  > ```
  > 
  > Found during project review 2026-06-01.

- [ ] **#12 [security] CORS wildcard + allow_credentials in Cloud Run deploy**
  > `.github/workflows/ci.yml:236`
  > 
  > ```yaml
  > CORS_ORIGINS=${{ vars.FRONTEND_URL || '*' }}
  > ```
  > 
  > combined with `allow_credentials=True` in `backend/app/api/router.py:80`. A `*` origin together with credentials is invalid (browsers reject it) and is a classic misconfiguration footgun.
  > 
  > **Fix:** fail closed — require `FRONTEND_URL` to be set explicitly rather than defaulting to `*`, or drop `allow_credentials` if wildcard origins are genuinely intended.
  > 
  > Found during project review 2026-06-01.

- [ ] **#13 [security] No guard on default SECRET_KEY**
  > `backend/app/core/config.py:29`
  > 
  > ```python
  > secret_key: str = "change-me-in-production"
  > ```
  > 
  > Nothing asserts this default was overridden. `docker-compose.prod.yml` correctly requires it (`${SECRET_KEY:?...}`), but a bare `python main.py` run or a misconfigured Cloud Run deploy would silently sign JWTs with a publicly-known constant.
  > 
  > **Fix:** add a startup assertion in `lifespan` (or `get_settings`) that raises if `secret_key == "change-me-in-production"` outside of dev.
  > 
  > Found during project review 2026-06-01.

- [ ] **#14 [cleanup] Delete orphaned duplicate FastAPI app endpoints.py**
  > `backend/app/api/endpoints.py` (131 lines) is an orphaned second `FastAPI()` app. Nothing imports it — `backend/main.py`, both compose files, and CI all run `app.api.router:app`.
  > 
  > It has drifted from the live `router.py`: references STL args `height_mm`/`base_thickness_mm` that no longer exist on the real handler, uses `/output/svg` paths, and has its own divergent `lifespan`. It's a maintenance trap and muddies the security surface.
  > 
  > **Fix:** delete the file.
  > 
  > Found during project review 2026-06-01.

- [ ] **#15 [hygiene] SQLite db and data/ not gitignored**
  > `.gitignore` ignores `backend/data/` but not:
  > 
  > - `backend/heart_on_a_sleeve.db` (SQLite dev db — untracked, **not** ignored)
  > - root `data/` containing `svg_output/` and `stl_output/` (untracked, **not** ignored — yet `docker-compose.yml` mounts `./data`)
  > 
  > One `git add .` from committing build artifacts and a local database.
  > 
  > **Fix:** add `*.db` and `/data/` to `.gitignore`.
  > 
  > Found during project review 2026-06-01.

- [ ] **#16 [bug] Output filename collisions at second granularity**
  > `backend/app/api/router.py` — `generate_svg` and `generate_stl` build output filenames with second-granularity timestamps:
  > 
  > ```python
  > timestamp = datetime.utcnow().strftime("%Y%m%d%H%M%S")
  > ```
  > 
  > Two requests within the same second overwrite each other. `save_svg` already uses microseconds (`%Y%m%d%H%M%S%f`), so the codebase is inconsistent.
  > 
  > **Fix:** use microseconds or a uuid4 suffix everywhere.
  > 
  > Found during project review 2026-06-01.

- [ ] **#17 [cleanup] Remove dead _current_bbox global and unused schemas**
  > - `_current_bbox` in `backend/app/api/router.py:110` is written on every generate call but never read; a module-level mutable is also concurrency-unsafe.
  > - `MerchType`, `DesignProjectCreate`, and `DesignProjectResponse` in `backend/app/models/schemas.py` appear unused (responses are built ad-hoc as dicts).
  > 
  > **Fix:** remove `_current_bbox` and prune the unused schemas (confirm no references first).
  > 
  > Found during project review 2026-06-01.

- [ ] **#18 [hygiene] Startup logs at WARNING + silent migration except**
  > `backend/app/api/router.py` `lifespan`:
  > 
  > - Routine startup is logged at `log.warning(...)` (DB driver, metadata tables, create_all result) — reads like leftover debugging; demote to `info`/`debug`.
  > - The ad-hoc column migration loop uses a bare `except Exception: pass`, which hides genuine failures. Log at `debug` so a real error isn't invisible.
  > 
  > Found during project review 2026-06-01.

- [ ] **#19 [bug] Coaster shape not enforced in 3D map ground + print baseplate**
  > The selected coaster shape (square / circle / hexagon) is applied to the SVG clip path and the STL plate outline (`stl_generator._plate_shapes`), but **not** to two 3D surfaces:
  > 
  > - **3D map ground** — `frontend/cesium/src/viewer3d.ts` uses a `PlaneGeometry` plus 4 axis-aligned clipping planes, so the ground is always rectangular.
  > - **Print baseplate** — `frontend/cesium/src/print-viewer.ts` builds the baseplate as a `BoxGeometry`, always rectangular.
  > 
  > Result: a circle/hexagon coaster shows a rectangular ground in the 3D map and a rectangular baseplate in the print preview, inconsistent with the SVG and the STL plate.
  > 
  > **Fix:** derive the ground/baseplate outline from the same shape source (circle → disc, hexagon → hex prism) so geometry is enforced consistently across SVG, 3D map, and print.
  > 
  > Found during dev 2026-06-01.


