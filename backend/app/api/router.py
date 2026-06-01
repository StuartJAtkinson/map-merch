from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import RedirectResponse
from contextlib import asynccontextmanager
import asyncio
import functools
import math
import os
import httpx

from app.core.config import get_settings
from app.core.database import engine
from app.models import db_models  # noqa: F401 — registers ORM models with Base.metadata
from app.models.schemas import (
    BBox,
    MERCH_SPECS,
    SVGGenerationRequest,
    STLGenerationRequest,
    LicenseCheckRequest,
)
from app.services.osm_fetcher import OSMFetcher, OverpassError
from app.services.svg_generator import SVGGenerator
from app.services.stl_generator import STLGenerator
from app.services.license_tracker import LicenseTracker
from app.api.auth import router as auth_router
from app.api.projects import router as projects_router
from app import timing_utils


settings = get_settings()

DATA_DIR = os.environ.get("DATA_DIR") or os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "data")
)

os.makedirs(os.path.join(DATA_DIR, "svg_output"), exist_ok=True)
os.makedirs(os.path.join(DATA_DIR, "stl_output"), exist_ok=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    import logging
    log = logging.getLogger("startup")
    if settings.environment == "production" and settings.secret_key == "change-me-in-production":
        raise RuntimeError(
            "SECRET_KEY is still the default placeholder in production — "
            "set the SECRET_KEY environment variable."
        )
    from app.core.database import Base
    log.info("DB URL driver: %s", engine.url.drivername)
    log.info("Metadata tables before create_all: %s", list(Base.metadata.tables.keys()))
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        log.info("create_all finished — tables now: %s", list(Base.metadata.tables.keys()))
    except Exception as exc:
        log.error("create_all FAILED: %s", exc, exc_info=True)
        raise
    # Add columns introduced after initial schema without a full migration tool
    from sqlalchemy import text as _text
    _migrations = [
        ("thumbnail_data_url", "ALTER TABLE design_projects ADD COLUMN thumbnail_data_url TEXT"),
    ]
    driver = str(engine.url.drivername)
    async with engine.begin() as conn:
        for col, sql in _migrations:
            try:
                if 'postgresql' in driver:
                    await conn.execute(_text(
                        f"ALTER TABLE design_projects ADD COLUMN IF NOT EXISTS {col} TEXT"
                    ))
                else:
                    await conn.execute(_text(sql))
            except Exception as exc:
                log.debug("migration for column %s skipped (likely exists): %s", col, exc)
    yield


app = FastAPI(title="Heart on a Sleeve API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.get_cors_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve generated SVG/STL files at /output/svg_output/... and /output/stl_output/...
app.mount("/output", StaticFiles(directory=DATA_DIR), name="output")

# Mount CesiumJS frontend only when running outside Docker (source tree present)
# CESIUM_DIR is set by main.py to frontend/cesium/dist; fallback uses __file__ resolution.
# __file__ is backend/app/api/router.py → 4 up = backend/ → frontend/cesium/dist
CESIUM_DIR = os.environ.get("CESIUM_DIR") or os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..", "frontend", "cesium", "dist")
)
if os.path.isdir(CESIUM_DIR):
    app.mount("/cesium", StaticFiles(directory=CESIUM_DIR, html=True), name="cesium")

    @app.get("/")
    async def root():
        return RedirectResponse(url="/cesium/", status_code=302)

app.include_router(auth_router)
app.include_router(projects_router)
app.include_router(timing_utils.router)

osm_fetcher = OSMFetcher(settings.overpass_endpoint)
svg_generator = SVGGenerator(MERCH_SPECS)
stl_generator = STLGenerator()
license_tracker = LicenseTracker()


@app.post("/api/osm/fetch")
async def fetch_osm(bbox: BBox):
    data = await osm_fetcher.fetch_area(bbox)
    return {"element_count": len(data.get("elements", [])), "data": data}


@app.get("/api/osm/features")
async def get_osm_features(west: float, south: float, east: float, north: float):
    import time as _t
    bbox = BBox(west=west, south=south, east=east, north=north)
    t0 = _t.perf_counter()
    try:
        data = await osm_fetcher.fetch_area(bbox, force_buildings=True)
        timing_utils.tlog("osm_features_total", (_t.perf_counter() - t0) * 1000,
                          f"elements={len(data.get('elements', []))}")
        return data
    except OverpassError as e:
        timing_utils.tlog("osm_features_error", (_t.perf_counter() - t0) * 1000, str(e))
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/api/osm/license-info")
async def get_license_info(bbox: BBox):
    return await osm_fetcher.get_license_info(bbox)


@app.post("/api/generate/svg")
async def generate_svg(req: SVGGenerationRequest):
    try:
        osm_data = await osm_fetcher.fetch_area(req.bbox)
    except OverpassError as e:
        raise HTTPException(status_code=502, detail=str(e))

    bbox_tuple = (req.bbox.west, req.bbox.south, req.bbox.east, req.bbox.north)
    loop = asyncio.get_event_loop()
    try:
        svg_io = await loop.run_in_executor(None, functools.partial(
            svg_generator.generate,
            osm_data=osm_data,
            merch_type=req.merch_type,
            style=req.style,
            include_labels=req.include_labels,
            include_buildings=req.include_buildings,
            include_roads=req.include_roads,
            include_parks=req.include_parks,
            bbox=bbox_tuple,
            coaster_shape=req.coaster_shape,
            palette_overrides=req.palette_overrides or None,
        ))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"SVG generation failed: {e}")

    from datetime import datetime
    timestamp = datetime.utcnow().strftime("%Y%m%d%H%M%S%f")
    filename = os.path.join(DATA_DIR, "svg_output", f"design_{timestamp}.svg")
    with open(filename, "wb") as f:
        f.write(svg_io.read())
    return {"svg_path": filename, "svg_url": f"/output/svg_output/design_{timestamp}.svg", "merch_type": req.merch_type}


@app.post("/api/save-svg")
async def save_svg(payload: dict):
    """Accept SVG text from the client renderer and persist it to /output/svg_output/."""
    svg_text: str = payload.get("svg_text", "")
    if not svg_text:
        raise HTTPException(status_code=400, detail="svg_text is required")
    from datetime import datetime
    timestamp = datetime.utcnow().strftime("%Y%m%d%H%M%S%f")
    filename = os.path.join(DATA_DIR, "svg_output", f"design_{timestamp}.svg")
    with open(filename, "w", encoding="utf-8") as f:
        f.write(svg_text)
    return {"svg_url": f"/output/svg_output/design_{timestamp}.svg"}


@app.post("/api/generate/stl")
async def generate_stl(req: STLGenerationRequest):
    try:
        osm_data = await osm_fetcher.fetch_area(req.bbox, force_buildings=True)
    except OverpassError as e:
        raise HTTPException(status_code=502, detail=str(e))

    bbox_tuple = (req.bbox.west, req.bbox.south, req.bbox.east, req.bbox.north)
    loop = asyncio.get_event_loop()
    try:
        # CPU-bound + blocking HTTP (OpenTopoData elevation) — run in thread pool
        parts = await loop.run_in_executor(None, functools.partial(
            stl_generator.generate,
            osm_data=osm_data,
            merch_type=req.merch_type,
            bbox=bbox_tuple,
            bldg_height=req.bldg_height,
            water_start=req.water_start,
            water_end=req.water_end,
            land_start=req.land_start,
            land_end=req.land_end,
            gap_close_mm=req.gap_close_mm,
            water_expand_mm=req.water_expand_mm,
            min_bldg_mm=req.min_bldg_mm,
            collar_mm=req.collar_mm,
            coaster_shape=req.coaster_shape,
        ))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"STL generation failed: {e}")

    from datetime import datetime
    timestamp = datetime.utcnow().strftime("%Y%m%d%H%M%S%f")
    urls = {}
    for part_name, bio in parts.items():
        fname = f"design_{timestamp}_{part_name}.stl"
        with open(os.path.join(DATA_DIR, "stl_output", fname), "wb") as f:
            f.write(bio.read())
        urls[f"stl_{part_name}_url"] = f"/output/stl_output/{fname}"
    return {**urls, "merch_type": req.merch_type}


@app.post("/api/license/check")
async def check_licenses(req: LicenseCheckRequest):
    return await license_tracker.check_licenses(
        bbox=req.bbox.model_dump(),
        data_sources=req.data_sources,
    )


@app.get("/health")
async def health():
    return {"status": "ok"}


# ─── Estimate ─────────────────────────────────────────────────────────────────

@app.post("/api/estimate")
async def estimateGeneration(req: SVGGenerationRequest):
    """Fast pre-flight estimate for SVG and STL generation time + complexity.

    Runs a lightweight Overpass count (no geometry) to gauge element count,
    then estimates SVG and STL generation time based on area and element density.
    """
    import time as _t
    t0 = _t.perf_counter()

    bbox = req.bbox
    cos_lat = math.cos((bbox.north + bbox.south) / 2 * math.pi / 180)
    km2 = round((bbox.east - bbox.west) * cos_lat * 111.32 * (bbox.north - bbox.south) * 111.32, 2)

    # Lightweight count query — no geometry, just element counts per type
    bb = f"{bbox.south},{bbox.west},{bbox.north},{bbox.east}"
    count_query = f"""
    [out:json][timeout:25];
    (
      way["highway"]({bb});
      way["building"]({bb});
      way["landuse"]({bb});
      way["natural"]({bb});
      way["waterway"]({bb});
      way["railway"]({bb});
      way["leisure"]({bb});
    );
    out count;
    """
    element_count = 0
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(connect=8, read=30, write=5)) as client:
            r = await client.post(
                os.environ.get("OVERPASS_ENDPOINT", "https://overpass.kumi.systems/api/interpreter"),
                data={"data": count_query},
                headers={"User-Agent": "heart-on-a-sleeve/1.0"},
            )
            if r.is_success:
                data = r.json()
                elements = data.get("elements", [])
                # out count returns one element with tags.total = combined count
                if elements and "total" in elements[0].get("tags", {}):
                    element_count = int(elements[0]["tags"]["total"])
                elif elements:
                    # Fallback: sum individual counts from each element
                    element_count = sum(int(e.get("tags", {}).get("total", 0)) for e in elements)
    except Exception:
        pass  # estimate stays based on km2 only

    # ── SVG estimate ────────────────────────────────────────────────────────────
    # Based on element count + area. Elements drive SVG generation time linearly.
    # Small  : <5k elements, <0.5 km² → fast (2s)
    # Medium : 5k–20k elements, 0.5–5 km² → moderate (5–12s)
    # Large  : 20k–60k elements, 5–20 km² → slow (12–25s)
    # Huge   : >60k elements, >20 km² → very slow (>25s), suggest smaller area
    if km2 < 0.5 and element_count < 5_000:
        svg_ms = 2_000
        complexity = "low"
    elif km2 < 5 and element_count < 20_000:
        svg_ms = min(12_000, 3_000 + element_count * 0.4)
        complexity = "medium"
    elif km2 < 20 and element_count < 60_000:
        svg_ms = min(25_000, 8_000 + element_count * 0.25)
        complexity = "high"
    else:
        svg_ms = 30_000
        complexity = "very_high"

    # ── OSM fetch estimate ───────────────────────────────────────────────────────
    # Overpass response time depends on area and server load.
    # Use a separate lightweight timeout-based estimate.
    # Small areas: ~2s, medium: 4–8s, large: 8–20s, huge: >20s
    if km2 < 0.5:
        osm_ms = 3_000
    elif km2 < 5:
        osm_ms = min(12_000, 4_000 + km2 * 1_500)
    elif km2 < 20:
        osm_ms = min(20_000, 8_000 + km2 * 800)
    else:
        osm_ms = 25_000

    # ── STL estimate ────────────────────────────────────────────────────────────
    # Buildings are the primary cost. Estimate building count as ~30% of total ways.
    # Each building way has ~8 nodes on average.
    bldg_est = max(10, int(element_count * 0.25))
    stl_ms = min(45_000, 3_000 + bldg_est * 15 + km2 * 400)

    elapsed = (_t.perf_counter() - t0) * 1000
    timing_utils.tlog("estimate_preflight", elapsed, f"km2={km2} elements={element_count} svg_ms={svg_ms} stl_ms={stl_ms}")

    return {
        "osm_estimate_ms":  osm_ms,
        "svg_estimate_ms":  svg_ms,
        "stl_estimate_ms":  stl_ms,
        "area_km2":         km2,
        "element_count":    element_count,
        "complexity":      complexity,
    }
