from pydantic import BaseModel, Field


class BBox(BaseModel):
    north: float = Field(..., ge=-90, le=90)
    south: float = Field(..., ge=-90, le=90)
    east: float = Field(..., ge=-180, le=180)
    west: float = Field(..., ge=-180, le=180)


MERCH_SPECS = {
    "placemat": {"ratio_x": 14, "ratio_y": 10, "dpi": 300, "width_px": 4200, "height_px": 3000},
    "coaster": {"ratio_x": 1, "ratio_y": 1, "dpi": 300, "width_px": 1000, "height_px": 1000},
    "tshirt": {"ratio_x": 3, "ratio_y": 4, "dpi": 300, "width_px": 3000, "height_px": 4000},
    "mug": {"ratio_x": 9, "ratio_y": 3, "dpi": 300, "width_px": 2700, "height_px": 900},
    "tote": {"ratio_x": 2, "ratio_y": 3, "dpi": 300, "width_px": 2000, "height_px": 3000},
    "3d_print": {"ratio_x": 1, "ratio_y": 1, "dpi": 150, "width_px": 800, "height_px": 800},
}


class SVGGenerationRequest(BaseModel):
    bbox: BBox
    merch_type: str = Field(
        ..., pattern="^(placemat|coaster|tshirt|mug|tote|3d_print)$"
    )
    style: str = "osm_default"
    include_labels: bool = True
    include_buildings: bool = True
    include_roads: bool = True
    include_parks: bool = True
    coaster_shape: str = "square"           # 'square' | 'circle' | 'hexagon'
    palette_overrides: dict[str, str] = {}  # per-category hex colour overrides


class STLGenerationRequest(BaseModel):
    bbox: BBox
    merch_type: str = "3d_print"
    coaster_shape: str = "square"   # 'square' | 'circle' | 'hexagon'
    # Layer heights (mm) — equal thirds so assembled coaster is flat-topped
    bldg_height: float = 4.0             # total height; buildings poke full height
    water_start: float = 4.0 / 3        # ≈ 1.333 mm
    water_end:   float = 4.0 * 2 / 3   # ≈ 2.667 mm
    land_start:  float = 4.0 * 2 / 3   # ≈ 2.667 mm (= water_end, flat-top)
    land_end:    float = 4.0            # = bldg_height
    # Geometry processing
    gap_close_mm:    float = 0.8   # merge buildings with gap < this
    water_expand_mm: float = 0.5   # expand water bodies by this amount
    min_bldg_mm:     float = 1.0   # minimum building height
    collar_mm:       float = 1.0   # outer collar width on base + lid
    # Moat text — "WAKEFIELD GREEN PARTY" carved through land, surrounded by blue water
    moat_text: str | None = None
    # Legacy (ignored — kept for backward compat with old callers)
    height_mm: float = 4.0
    base_thickness_mm: float = 2.0


class LicenseCheckRequest(BaseModel):
    bbox: BBox
    data_sources: list[str]  # e.g. ["osm", "nasa_srtm", "custom_upload"]