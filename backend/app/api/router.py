from fastapi import FastAPI
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
from app.services.osm_fetcher import OSMFetcher
from app.services.svg_generator import SVGGenerator
from app.services.stl_generator import STLGenerator
from app.services.license_tracker import LicenseTracker


settings = get_settings()

DATA_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "data"))

# Ensure data dir exists before StaticFiles tries to mount
os.makedirs(os.path.join(DATA_DIR, "svg_output"), exist_ok=True)
os.makedirs(os.path.join(DATA_DIR, "stl_output"), exist_ok=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield


app = FastAPI(title="Heart on a Sleeve API", lifespan=lifespan)

# Serve CesiumJS frontend directly from backend
CESIUM_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "frontend", "cesium"))
app.mount("/cesium", StaticFiles(directory=CESIUM_DIR, html=True), name="cesium")


@app.get("/")
async def root():
    """Redirect to the CesiumJS map selector."""
    return RedirectResponse(url="/cesium/", status_code=302)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

osm_fetcher = OSMFetcher(settings.overpass_endpoint)
svg_generator = SVGGenerator(MERCH_SPECS)
stl_generator = STLGenerator()
license_tracker = LicenseTracker()

# Store current bbox for SVG coordinate projection
_current_bbox: dict | None = None


@app.post("/api/osm/fetch")
async def fetch_osm(bbox: BBox):
    data = await osm_fetcher.fetch_area(bbox)
    return {"element_count": len(data.get("elements", [])), "data": data}


@app.post("/api/osm/license-info")
async def get_license_info(bbox: BBox):
    return await osm_fetcher.get_license_info(bbox)


@app.post("/api/generate/svg")
async def generate_svg(req: SVGGenerationRequest):
    global _current_bbox
    osm_data = await osm_fetcher.fetch_area(req.bbox)
    _current_bbox = req.bbox.model_dump()
    bbox_tuple = (req.bbox.west, req.bbox.south, req.bbox.east, req.bbox.north)
    loop = asyncio.get_event_loop()
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
    ))
    from datetime import datetime
    timestamp = datetime.utcnow().strftime("%Y%m%d%H%M%S")
    filename = os.path.join(DATA_DIR, "svg_output", f"design_{timestamp}.svg")
    with open(filename, "wb") as f:
        f.write(svg_io.read())
    return {"svg_path": filename, "svg_url": f"/output/svg_output/design_{timestamp}.svg", "merch_type": req.merch_type}


@app.post("/api/generate/stl")
async def generate_stl(req: STLGenerationRequest):
    global _current_bbox
    osm_data = await osm_fetcher.fetch_area(req.bbox)
    _current_bbox = req.bbox.model_dump()
    bbox_tuple = (req.bbox.west, req.bbox.south, req.bbox.east, req.bbox.north)
    loop = asyncio.get_event_loop()
    # Run in thread — STL generator is CPU-bound (shapely/trimesh) and may
    # make a blocking HTTP call to OpenTopoData for elevation data.
    parts = await loop.run_in_executor(None, functools.partial(
        stl_generator.generate,
        osm_data=osm_data,
        merch_type=req.merch_type,
        height_mm=req.height_mm,
        base_thickness_mm=req.base_thickness_mm,
        bbox=bbox_tuple,
    ))
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