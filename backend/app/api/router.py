from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import RedirectResponse
from contextlib import asynccontextmanager
import asyncio
import functools
import os

from app.core.config import get_settings
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
CESIUM_DIR = os.environ.get("CESIUM_DIR") or os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..", "frontend", "cesium")
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

_current_bbox: dict | None = None


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
        data = await osm_fetcher.fetch_area(bbox)
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
    global _current_bbox
    try:
        osm_data = await osm_fetcher.fetch_area(req.bbox)
    except OverpassError as e:
        raise HTTPException(status_code=502, detail=str(e))

    _current_bbox = req.bbox.model_dump()
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
    timestamp = datetime.utcnow().strftime("%Y%m%d%H%M%S")
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
    global _current_bbox
    try:
        osm_data = await osm_fetcher.fetch_area(req.bbox)
    except OverpassError as e:
        raise HTTPException(status_code=502, detail=str(e))

    _current_bbox = req.bbox.model_dump()
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
    timestamp = datetime.utcnow().strftime("%Y%m%d%H%M%S")
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


app.mount("/output", StaticFiles(directory=DATA_DIR), name="output")
