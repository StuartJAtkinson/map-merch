from datetime import datetime
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from ..core.config import get_settings
from ..models.schemas import (
    BBox,
    MERCH_SPECS,
    SVGGenerationRequest,
    STLGenerationRequest,
    LicenseCheckRequest,
)
from ..services.osm_fetcher import OSMFetcher
from ..services.svg_generator import SVGGenerator
from ..services.stl_generator import STLGenerator
from ..services.license_tracker import LicenseTracker

OUTPUT_DIR = Path(__file__).resolve().parents[2] / "output"


settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    (OUTPUT_DIR / "svg").mkdir(parents=True, exist_ok=True)
    (OUTPUT_DIR / "stl").mkdir(parents=True, exist_ok=True)
    yield


app = FastAPI(title="Heart on a Sleeve API", lifespan=lifespan)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Services
osm_fetcher = OSMFetcher(settings.overpass_endpoint)
svg_generator = SVGGenerator(MERCH_SPECS)
stl_generator = STLGenerator()
license_tracker = LicenseTracker()


# ─── OSM ────────────────────────────────────────────────────────────────────

@app.post("/api/osm/fetch")
async def fetch_osm(bbox: BBox):
    """Fetch OSM data for a bounding box."""
    data = await osm_fetcher.fetch_area(bbox)
    return {"element_count": len(data.get("elements", [])), "data": data}


@app.post("/api/osm/license-info")
async def get_license_info(bbox: BBox):
    """Get license/attribution info for a bounding box."""
    return await osm_fetcher.get_license_info(bbox)


# ─── SVG ────────────────────────────────────────────────────────────────────

@app.post("/api/generate/svg")
async def generate_svg(req: SVGGenerationRequest):
    """Generate SVG from OSM data for a merch type."""
    osm_data = await osm_fetcher.fetch_area(req.bbox)
    svg_io = svg_generator.generate(
        osm_data=osm_data,
        merch_type=req.merch_type,
        style=req.style,
        include_labels=req.include_labels,
        include_roads=req.include_roads,
        include_parks=req.include_parks,
        bbox=(req.bbox.west, req.bbox.south, req.bbox.east, req.bbox.north),
    )
    timestamp = datetime.utcnow().strftime("%Y%m%d%H%M%S")
    fname = f"design_{timestamp}.svg"
    out_path = OUTPUT_DIR / "svg" / fname
    out_path.write_bytes(svg_io.read())
    return {"svg_url": f"/output/svg/{fname}", "merch_type": req.merch_type}


# ─── STL ────────────────────────────────────────────────────────────────────

@app.post("/api/generate/stl")
async def generate_stl(req: STLGenerationRequest):
    """Generate STL from OSM data for 3D printing."""
    osm_data = await osm_fetcher.fetch_area(req.bbox)
    stl_io = stl_generator.generate(
        osm_data=osm_data,
        merch_type=req.merch_type,
        height_mm=req.height_mm,
        base_thickness_mm=req.base_thickness_mm,
    )
    timestamp = datetime.utcnow().strftime("%Y%m%d%H%M%S")
    fname = f"design_{timestamp}.stl"
    out_path = OUTPUT_DIR / "stl" / fname
    out_path.write_bytes(stl_io.read())
    return {"stl_url": f"/output/stl/{fname}", "merch_type": req.merch_type}


# ─── License ─────────────────────────────────────────────────────────────────

@app.post("/api/license/check")
async def check_licenses(req: LicenseCheckRequest):
    """Check license compliance for data sources."""
    return await license_tracker.check_licenses(
        bbox=req.bbox.model_dump(),
        data_sources=req.data_sources,
    )


# ─── Health ──────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok"}


# Serve generated files
app.mount("/output", StaticFiles(directory=str(OUTPUT_DIR)), name="output")