# Issues — Heart on a Sleeve

## Open

- [ ] **Local dev: port 8000 blocked by WSL SSH tunnel** — `ssh` process in Ubuntu WSL binds 127.0.0.1:8000 preventing Docker backend from being reached via `localhost:8000`; only affects Vite dev-server workflow; `--profile full` (nginx) unaffected as it uses internal Docker network. Kill tunnel or temporarily remap docker-compose port *(found 2026-05-28)*
- [ ] **Coaster shape not enforced across all 3D** — square/circle/hexagon is applied to the SVG clip and the STL plate outline (`_plate_shapes`), but the 3D-MAP ground (`viewer3d.ts` — `PlaneGeometry` + 4 axis-aligned clip planes) and the PRINT baseplate (`print-viewer.ts` — `BoxGeometry`) are always rectangular. A circle/hexagon coaster shows a rectangular ground in the 3D map and a rectangular baseplate in the print preview. Conform both to the selected shape. *(found 2026-06-01)*
- [ ] **No server-side bbox-area cap** — backend `/api/generate/svg` (+stl/osm) accepts any bbox; only the frontend enforces `MAX_AREA_KM2`. A huge bbox ties the server up ~2 min (Overpass 60s primary + 60s mirror) and makes `test_generate_svg__bbox_too_large` flaky (client `ReadTimeout` > 120s). Add an area guard that 422s oversized bboxes before fetching. Resource/DoS concern. *(found 2026-06-01)*

## Resolved (2026-06-01 session)

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
