"""
3-colour interlocking STL generator.

Three separate printable pieces that assemble into a complete map model:

  buildings.stl (grey)
      All building pillars + road ribbons, Z=0 → BLDG_H.
      Simplified polygons, small gaps closed, minimum 1 mm height.

  water.stl (blue)
      Full plate footprint (Z=WATER_START → WATER_END) with building/road
      shapes punched through as holes — the background base disc.
      Land areas are covered by the land lid; open areas remain as water.

  land.stl (green) — the locking lid
      Everything that isn't buildings, roads, or water.
      Z=WATER_H → BLDG_H (slides down over building tops, sits on water layer).
      Flat for coaster/placemat; terrain surface for relief/topology mode.

Assembly: lay blue water disc → slot grey buildings through holes → slide green
lid down over building tops. The lid physically locks the stack.
"""

import math
import os
import requests
import trimesh
import numpy as np
from shapely.geometry import (
    Polygon, MultiPolygon, LineString, Point,
    box as shapely_box,
)
from shapely.ops import unary_union
from shapely.affinity import translate as shapely_translate
from shapely.validation import make_valid
from io import BytesIO

# ── Moat text rendering ────────────────────────────────────────────────────────
# Converts a string to a centred shapely Polygon using a bundled Roboto Slab WOFF2.
# Each character is extracted as an SVG path via fontTools' SVGPathPen, parsed into
# coordinate rings, and converted to a shapely Polygon.  Characters are assembled
# left-to-right using their advance widths, then the whole assembly is centred in
# the plate and placed near the bottom with a small margin.

_FONT_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "fonts", "RobotoSlab-Regular.woff2")
_FONT_CACHE: "TTFont | None" = None  # type: ignore[name-defined]


def _get_font():
    """Lazy-load (and cache) the Roboto Slab WOFF2."""
    global _FONT_CACHE
    if _FONT_CACHE is None:
        from fontTools.ttLib import TTFont
        _FONT_CACHE = TTFont(_FONT_PATH)
    return _FONT_CACHE


def _parse_svg_path(d: str) -> list[tuple[float, float]]:
    """Parse a fontTools SVG path string into an ordered list of (x, y) points.

    Handles M, L, H, V, C (cubic bezier), Q (quadratic bezier), Z.
    Q curves are approximated via midpoint subdivision (10 segments).
    """
    import re
    rings: list[tuple[float, float]] = []
    cur_x, cur_y = 0.0, 0.0
    # Split into command groups: letter + following numbers
    tokens = re.findall(r'[MLHVCSQZ][^MLHVCSQZ]*', d)
    for tok in tokens:
        c = tok[0]
        nums = list(map(float, re.findall(r'-?\d+\.?\d*', tok)))
        if c == 'M':
            cur_x, cur_y = nums[0], nums[1]
            rings.append((cur_x, cur_y))
        elif c == 'L':
            cur_x, cur_y = nums[0], nums[1]
            rings.append((cur_x, cur_y))
        elif c == 'H':
            cur_x = nums[0]
            rings.append((cur_x, cur_y))
        elif c == 'V':
            cur_y = nums[0]
            rings.append((cur_x, cur_y))
        elif c == 'C':
            # Cubic bezier: (x1,y1,x2,y2,x,y) × ncurves
            for i in range(0, len(nums), 6):
                x1, y1, x2, y2, x, y = nums[i:i+6]
                for t in [0.25, 0.5, 0.75]:
                    px = (1-t)**3*cur_x + 3*(1-t)**2*t*x1 + 3*(1-t)*t*t*x2 + t**3*x
                    py = (1-t)**3*cur_y + 3*(1-t)**2*t*y1 + 3*(1-t)*t*t*y2 + t**3*y
                    rings.append((px, py))
                cur_x, cur_y = x, y
        elif c == 'Q':
            # Quadratic bezier: (x1,y1,x,y) × ncurves
            for i in range(0, len(nums), 4):
                x1, y1, x, y = nums[i:i+4]
                for t in [0.25, 0.5, 0.75]:
                    px = (1-t)**2*cur_x + 2*(1-t)*t*x1 + t**2*x
                    py = (1-t)**2*cur_y + 2*(1-t)*t*y1 + t**2*y
                    rings.append((px, py))
                cur_x, cur_y = x, y
        elif c == 'Z':
            pass  # closed by Polygon handling
    return rings


def _glyph_to_polygon(glyph, units_per_em: float, adv_mm: float) -> Polygon | None:
    """Extract one glyph's outline as a shapely Polygon.

    glyph is a fontTools _TTGlyphGlyf.  adv_mm is the advance width in plate-mm.
    Returns None on failure; caller uses a fallback rect.
    """
    try:
        from fontTools.pens.svgPathPen import SVGPathPen
        glyph_set = glyph.glyphSet
        pen = SVGPathPen(glyph_set)
        glyph.draw(pen)
        d = pen.getCommands()
        if not d or d == 'Z':
            return None
        pts = _parse_svg_path(d)
        if len(pts) < 3:
            return None
        # Scale: font-units → plate-mm
        pts = [(x / units_per_em * adv_mm, y / units_per_em * adv_mm) for x, y in pts]
        p = Polygon(pts)
        if not p.is_valid:
            p = make_valid(p)
        return p if not p.is_empty else None
    except Exception:
        return None


def _make_text_polygon(
    text: str,
    plate_w: float,
    plate_h: float,
    target_width_mm: float | None = None,
) -> tuple[Polygon, tuple[float, float, float, float]]:
    """Convert text string to a centred shapely Polygon in plate-mm coords.

    Returns (polygon, bounds) where bounds = (minx, miny, maxx, maxy) in mm.
    The polygon is centred horizontally and sits at the bottom with a 2 mm margin.
    """
    target_w = target_width_mm or plate_w * 0.70  # 70 % of plate width

    try:
        tt = _get_font()
        glyph_set = tt.getGlyphSet()
        cmap = tt.getBestCmap()
        units_per_em = float(tt["head"].unitsPerEm)

        char_polys: list[Polygon] = []
        cur_x = 0.0
        total_adv = 0.0

        for ch in text:
            code = ord(ch)
            glyph_name = cmap.get(code) if cmap else None
            if glyph_name is None:
                glyph_name = ".notdef"

            glyph = glyph_set[glyph_name]
            # Advance width in font-units
            adv_fu = float(tt["hmtx"].metrics.get(glyph_name, (0, 0))[0])
            if adv_fu <= 0:
                adv_fu = units_per_em * 0.6  # fallback for space chars etc.
            total_adv += adv_fu

        # Scale factor: total text width in font-units → target_w mm
        scale = target_w / total_adv if total_adv > 0 else 1.0

        for ch in text:
            code = ord(ch)
            glyph_name = cmap.get(code) if cmap else None
            if glyph_name is None:
                glyph_name = ".notdef"

            glyph = glyph_set[glyph_name]
            adv_fu = float(tt["hmtx"].metrics.get(glyph_name, (0, 0))[0])
            if adv_fu <= 0:
                adv_fu = units_per_em * 0.6
            adv_mm = adv_fu * scale

            p = _glyph_to_polygon(glyph, units_per_em, adv_mm)
            if p is None or p.is_empty:
                p = shapely_box(cur_x, 0, cur_x + adv_mm, adv_mm * 0.7)
            else:
                # Translate to cursor position (shapely_translate handles Polygon + MultiPolygon)
                p = shapely_translate(p, xoff=cur_x)
            char_polys.append(p)
            cur_x += adv_mm

        if not char_polys:
            return shapely_box(0, 0, 1, 1), (0, 0, 1, 1)

        merged = unary_union(char_polys) if len(char_polys) > 1 else char_polys[0]

        # Centre horizontally and snap to bottom with 2 mm margin
        b = merged.bounds
        text_w = b[2] - b[0]
        text_h = b[3] - b[1]
        shift_x = (plate_w - text_w) / 2 - b[0]
        shift_y = 2.0 - b[1]  # 2 mm bottom margin

        centred = Polygon(
            [(px + shift_x, py + shift_y) for px, py in merged.exterior.coords]
        ) if hasattr(merged, "exterior") else merged

        return centred, centred.bounds

    except Exception as exc:
        return shapely_box(0, 0, plate_w * 0.5, 2), (0, 0, plate_w * 0.5, 2)


# Physical plate size (mm) per merch type
PLATE_MM: dict[str, tuple[float, float]] = {
    'tshirt':   (100.0, 133.0),
    'mug':      (150.0,  50.0),
    'placemat': (150.0, 107.0),
    'coaster':  ( 95.0,  95.0),
    'tote':     (100.0, 150.0),
    '3d_print': (100.0, 100.0),
}
TOPOLOGY_TYPES = {'3d_print'}

# Road & waterway stroke widths — these MUST mirror frontend/cesium/src/svg-renderer.ts
# (ROAD_W / WATERWAY_W) so the printed STL roads are IDENTICAL to the 3D-map preview.
# Values are SVG user-units on a canvas of SVG_CANVAS_W[merch] px; they are converted to
# plate-mm at generation time:  width_mm = svg_units * plate_w / SVG_CANVAS_W[merch].
# The full road set is included (incl. paths) to match the map's "show everything" mode.
SVG_ROAD_W: dict[str, float] = {
    'motorway': 5.0, 'trunk': 4.5, 'primary': 4.0, 'secondary': 3.0,
    'tertiary': 2.0, 'residential': 1.5, 'unclassified': 1.5,
    'service': 1.0, 'living_street': 1.5, 'road': 1.5,
    'footway': 0.7, 'cycleway': 0.7, 'path': 0.7,
    'pedestrian': 1.0, 'track': 0.8, 'bridleway': 0.8, 'steps': 0.7,
}
SVG_WATERWAY_W: dict[str, float] = {
    'river': 4.0, 'canal': 3.0, 'stream': 1.5, 'drain': 1.0, 'ditch': 0.8,
}
# SVG canvas width (px) per merch type — mirrors SVG_SPECS width_px in svg-renderer.ts.
SVG_CANVAS_W: dict[str, float] = {
    'placemat': 4200, 'coaster': 1000, 'tshirt': 3000,
    'mug': 2700, 'tote': 2000, '3d_print': 800,
}
WATER_POLY_TAGS = {'water', 'reservoir', 'lake', 'pond', 'basin', 'lagoon'}

# Default height constants (mm) — all overridable via STLGenerationRequest
# Three equal layers so the assembled coaster is flat-topped:
#   0..1/3  → buildings + roads + collar frame
#   1/3..2/3 → water plate (inside collar)
#   2/3..1  → land lid (inside collar, flush with building tops)
BLDG_H_DEFAULT   = 4.0
WATER_START_DEF  = BLDG_H_DEFAULT / 3       # ≈ 1.333 mm
WATER_END_DEF    = BLDG_H_DEFAULT * 2 / 3   # ≈ 2.667 mm
LAND_START_DEF   = BLDG_H_DEFAULT * 2 / 3   # ≈ 2.667 mm
LAND_END_DEF     = BLDG_H_DEFAULT            # = 4.0 mm (flush with buildings)
MIN_BLDG_H       = 1.0   # minimum building height
GAP_CLOSE_MM     = 0.8   # kept for API compat; gap-close processing removed
WATER_EXPAND     = 0.5   # how much water expands beyond its OSM boundary


class STLGenerator:

    def generate(
        self,
        osm_data: dict,
        merch_type: str,
        bbox: tuple[float, float, float, float] | None = None,
        # Tunable layer heights
        bldg_height:     float = BLDG_H_DEFAULT,
        water_start:     float = WATER_START_DEF,
        water_end:       float = WATER_END_DEF,
        land_start:      float = LAND_START_DEF,
        land_end:        float = LAND_END_DEF,
        gap_close_mm:    float = GAP_CLOSE_MM,
        water_expand_mm: float = WATER_EXPAND,
        min_bldg_mm:     float = MIN_BLDG_H,
        collar_mm:       float = 1.0,
        coaster_shape:   str   = 'square',
        # Moat text: "WAKEFIELD GREEN PARTY" carved through land, surrounded by blue water
        moat_text: str | None = None,
        # Legacy compat
        height_mm: float = BLDG_H_DEFAULT,
        base_thickness_mm: float = 2.0,
    ) -> dict[str, BytesIO]:
        west, south, east, north = bbox or (-0.13, 51.50, -0.11, 51.52)
        plate_w, plate_h = PLATE_MM.get(merch_type, (100.0, 100.0))
        lon_span = east - west
        lat_span = north - south

        def proj(lon: float, lat: float) -> tuple[float, float]:
            return ((lon - west) / lon_span * plate_w,
                    (lat - south) / lat_span * plate_h)

        def way_pts(way: dict) -> list[tuple[float, float]]:
            return [proj(*nodes[nid]) for nid in way.get('nodes', []) if nid in nodes]

        nodes: dict[int, tuple[float, float]] = {}
        ways: list[dict] = []
        for el in osm_data.get('elements', []):
            t = el.get('type')
            if t == 'node':
                nodes[el['id']] = (el.get('lon', 0.0), el.get('lat', 0.0))
            elif t == 'way':
                ways.append(el)

        topology = merch_type in TOPOLOGY_TYPES
        elev_grid = _fetch_elevation(west, south, east, north) if topology else None
        self._collar = collar_mm

        # For coasters, the plate outline may be non-rectangular
        active_shape = coaster_shape if merch_type == 'coaster' else 'square'

        # Scale the SVG stroke widths (user-units) to plate-mm so printed roads/waterways
        # match the 3D-map preview exactly (same width as a fraction of the plate).
        svg_canvas_w = SVG_CANVAS_W.get(merch_type, 1000.0)
        road_scale = plate_w / svg_canvas_w
        road_widths = {hw: w * road_scale for hw, w in SVG_ROAD_W.items()}
        waterway_widths = {ww: w * road_scale for ww, w in SVG_WATERWAY_W.items()}

        return self._build(
            ways, way_pts, plate_w, plate_h,
            bldg_height, water_start, water_end, land_start, land_end,
            gap_close_mm, water_expand_mm, min_bldg_mm, self._collar,
            road_widths, waterway_widths,
            topology, elev_grid, active_shape,
            moat_text=moat_text,
        )

    # ── Main build ─────────────────────────────────────────────────────────────

    def _build(
        self, ways, way_pts,
        plate_w, plate_h,
        bldg_h, water_start, water_end, land_start, land_end,
        gap_close, water_expand, min_bldg, collar,
        road_widths, waterway_widths,
        topology, elev_grid, coaster_shape: str = 'square',
        moat_text: str | None = None,
    ) -> dict[str, BytesIO]:

        # ── 1. Collect raw shapes ──────────────────────────────────────────────
        raw_bldgs: list[tuple[Polygon, float]] = []
        raw_roads: list[Polygon] = []
        raw_water: list[Polygon] = []

        for way in ways:
            tags = way.get('tags', {})
            pts  = way_pts(way)

            if tags.get('building') not in (None, 'no') and len(pts) >= 3:
                poly = _make_poly(pts)
                if poly:
                    if topology:
                        levels = float(tags.get('building:levels', 2))
                        h = float(tags.get('building:height', levels * 3.2))
                        h = max(h / 40.0 * bldg_h, min_bldg)
                    else:
                        h = bldg_h
                    raw_bldgs.append((poly, h))
                continue

            hw = tags.get('highway')
            if hw in road_widths and len(pts) >= 2:
                poly = _buffer_line(pts, road_widths[hw])
                if poly:
                    raw_roads.append(poly)
                continue

            if (tags.get('natural') == 'water' or
                    tags.get('landuse') in WATER_POLY_TAGS) and len(pts) >= 3:
                poly = _make_poly(pts, buffer=water_expand)
                if poly:
                    raw_water.append(poly)
                continue

            ww = tags.get('waterway')
            if ww in waterway_widths and len(pts) >= 2:
                # Waterway-line stroke matches the map exactly (no extra expand —
                # water_expand still applies to polygon water bodies above).
                poly = _buffer_line(pts, waterway_widths[ww])
                if poly:
                    raw_water.append(poly)

        # ── 2. Collect buildings as-is ────────────────────────────────────────
        bldg_polys, bldg_heights = [], []
        for poly, h in raw_bldgs:
            for p in _geom_parts(make_valid(poly)):
                if p.area > 0.1:
                    bldg_polys.append(p)
                    bldg_heights.append(max(h, min_bldg))

        bldg_union = make_valid(unary_union(bldg_polys)) if bldg_polys else Polygon()

        road_union  = make_valid(unary_union(raw_roads)) if raw_roads else Polygon()
        water_union = make_valid(unary_union(raw_water)) if raw_water else Polygon()
        urban_union = make_valid(bldg_union.union(road_union)) if not road_union.is_empty else bldg_union

        # ── 3. Build four pieces ──────────────────────────────────────────────
        plate_shape, outer_shape = _plate_shapes(plate_w, plate_h, collar, coaster_shape)

        # Guarantee land top is always flush with building tops regardless of caller values
        land_end = bldg_h

        bldg_meshes  = self._buildings_piece(
            bldg_polys, bldg_heights, raw_roads,
            bldg_union, road_union, urban_union,
            plate_shape, outer_shape, bldg_h, topology,
            base_h=water_start,
        )
        water_meshes = self._water_piece(
            water_union, urban_union, plate_shape, water_start, water_end,
        )
        land_meshes, moat_channel = self._land_piece(
            urban_union, water_union, plate_shape, outer_shape,
            land_start, land_end, topology, elev_grid,
            moat_text=moat_text,
        )
        # Add moat channel to the water piece so it renders blue (water material)
        if moat_channel is not None and not moat_channel.is_empty:
            chan_thick = max(land_end - land_start, 0.5)
            for p in _geom_parts(moat_channel):
                m = _extrude(p, chan_thick, z_base=land_start)
                if m:
                    water_meshes.append(m)
        return {
            'buildings': _export(bldg_meshes),
            'water':     _export(water_meshes),
            'land':      _export(land_meshes),
            'solid':     _export(bldg_meshes + water_meshes + land_meshes),
        }

    # ── Buildings piece ────────────────────────────────────────────────────────
    # Flat mode: individual building polygons + roads, each at bldg_h.
    # Topology mode: individual buildings at proportional heights.
    # Both modes: outer collar ring = frame walls at bldg_h so water + lid sit inside.

    def _buildings_piece(
        self, bldg_polys, bldg_heights, raw_roads,
        bldg_union, road_union, urban_union,
        plate_shape, outer_shape, bldg_h, topology,
        base_h: float = 0.0,
    ) -> list[trimesh.Trimesh]:
        meshes = []
        # Outer collar walls — frame that water and lid sit inside
        collar_ring = make_valid(outer_shape.difference(plate_shape))
        m = _extrude(collar_ring, bldg_h)
        if m:
            meshes.append(m)
        # Solid base plate — joins all pillars and provides the floor for water/land
        if base_h > 0:
            m = _extrude(plate_shape, base_h)
            if m:
                meshes.append(m)

        if topology:
            for poly, h in zip(bldg_polys, bldg_heights):
                for p in _geom_parts(make_valid(poly.intersection(plate_shape))):
                    m = _extrude(p, h)
                    if m:
                        meshes.append(m)
            for poly in raw_roads:
                for p in _geom_parts(make_valid(poly.intersection(plate_shape))):
                    m = _extrude(p, bldg_h)
                    if m:
                        meshes.append(m)
        else:
            # Flat mode: buildings/roads span only through water+land (upper 2/3rds).
            # The base plate (0→base_h) is a clean flat slab; extrusions start above it.
            bldg_span = max(bldg_h - base_h, 0.5)
            for poly, h in zip(bldg_polys, bldg_heights):
                for p in _geom_parts(make_valid(poly.intersection(plate_shape))):
                    m = _extrude(p, bldg_span, z_base=base_h)
                    if m:
                        meshes.append(m)
            for poly in raw_roads:
                for p in _geom_parts(make_valid(poly.intersection(plate_shape))):
                    m = _extrude(p, bldg_span, z_base=base_h)
                    if m:
                        meshes.append(m)

        return meshes

    # ── Water piece ────────────────────────────────────────────────────────────
    # Full plate footprint with building/road holes — the background base disc.
    # Land lid sits on top in non-water areas; water bodies remain uncovered.

    def _water_piece(
        self, water_union, urban_union,
        plate_shape, water_start, water_end,
    ) -> list[trimesh.Trimesh]:
        # 0.1 mm inset so water sits flush against the collar inner wall
        inner_plate = plate_shape.buffer(-0.1)
        water = inner_plate if not inner_plate.is_empty else plate_shape
        if not urban_union.is_empty:
            water = make_valid(water.difference(urban_union))
        water = _simplify_for_extrusion(water)
        thickness = max(water_end - water_start, 0.5)
        meshes = []
        for p in _geom_parts(water):
            m = _extrude(p, thickness, z_base=water_start)
            if m:
                meshes.append(m)
        return meshes

    # ── Land piece (top lid) ──────────────────────────────────────────────────
    # Fits inside the collar (buildings layer handles the frame).
    # Holes for buildings/roads (they protrude through) and water bodies (recessed).
    # If moat_text is set, the text polygon is carved from the land lid; the
    # expanded channel shape is returned separately so _build can add it to the
    # water piece (blue) — creating green letters surrounded by blue water.
    #
    # Returns (land_meshes, moat_channel_shape | None)

    def _land_piece(
        self, urban_union, water_union,
        plate_shape, outer_shape,
        land_start, land_end,
        topology, elev_grid,
        moat_text: str | None = None,
    ) -> tuple[list[trimesh.Trimesh], Polygon | None]:
        # 0.1 mm inset — land sits flush against the collar inner wall
        inner_plate = plate_shape.buffer(-0.1)
        lid_shape = inner_plate if not inner_plate.is_empty else plate_shape
        if not urban_union.is_empty:
            lid_shape = make_valid(lid_shape.difference(urban_union))
        if not water_union.is_empty:
            lid_shape = make_valid(lid_shape.difference(water_union.intersection(plate_shape)))

        # Moat text: carve the text polygon from the land lid
        moat_channel_shape: Polygon | None = None
        if moat_text:
            bounds = plate_shape.bounds
            pw = bounds[2] - bounds[0]
            ph = bounds[3] - bounds[1]
            text_poly, _ = _make_text_polygon(moat_text, pw, ph)
            if text_poly and not text_poly.is_empty:
                lid_shape = make_valid(lid_shape.difference(text_poly))
                # 1.5 mm margin around text → the water channel that surrounds it
                moat_channel_shape = text_poly.buffer(1.5)

        # Simplify before extrusion — dense urban areas on small plates (e.g. coaster)
        # produce complex polygons with many tight holes that can cause trimesh failures.
        lid_shape = _simplify_for_extrusion(lid_shape)

        thickness = max(land_end - land_start, 0.5)

        if not topology or elev_grid is None:
            meshes = []
            for p in _geom_parts(lid_shape):
                m = _extrude(p, thickness, z_base=land_start)
                if m:
                    meshes.append(m)
            return meshes, moat_channel_shape
        else:
            bounds = plate_shape.bounds  # (minx, miny, maxx, maxy)
            pw, ph = bounds[2] - bounds[0], bounds[3] - bounds[1]
            terrain_meshes = self._terrain_lid(lid_shape, elev_grid, pw, ph,
                                               land_start, land_end)
            return terrain_meshes, moat_channel_shape

    def _terrain_lid(self, land_shape, elev_grid, plate_w, plate_h, z_bottom, z_top):
        terrain = _build_terrain_mesh(elev_grid, plate_w, plate_h, z_bottom, z_top - z_bottom)
        return [terrain] if terrain else []


# ── Shape helpers ─────────────────────────────────────────────────────────────

def _plate_shapes(w: float, h: float, collar: float, shape: str) -> tuple[Polygon, Polygon]:
    """Return (plate_shape, outer_shape) for the given coaster_shape."""
    if shape == 'circle':
        cx, cy, r = w / 2, h / 2, min(w, h) / 2
        return (Point(cx, cy).buffer(r, resolution=64),
                Point(cx, cy).buffer(r + collar, resolution=64))
    if shape == 'hexagon':
        def _hex(r: float) -> Polygon:
            cx, cy = w / 2, h / 2
            return Polygon([
                (cx + r * math.cos(math.pi / 2 + i * math.pi / 3),
                 cy + r * math.sin(math.pi / 2 + i * math.pi / 3))
                for i in range(6)
            ])
        return _hex(min(w, h) / 2), _hex(min(w, h) / 2 + collar)
    # Default: square
    return (shapely_box(0, 0, w, h),
            shapely_box(-collar, -collar, w + collar, h + collar))


# ── Geometry primitives ───────────────────────────────────────────────────────

def _make_poly(pts, buffer=0.0) -> Polygon | None:
    try:
        p = make_valid(Polygon(pts))
        if p.is_empty or p.area < 0.05:
            return None
        if buffer:
            p = p.buffer(buffer)
            p = make_valid(p)
        return p if not p.is_empty else None
    except Exception:
        return None

def _buffer_line(pts, width) -> Polygon | None:
    try:
        line = LineString(pts)
        p = make_valid(line.buffer(width / 2, cap_style=2, join_style=2))
        return p if not p.is_empty else None
    except Exception:
        return None

def _geom_parts(geom) -> list[Polygon]:
    if geom is None or geom.is_empty:
        return []
    if isinstance(geom, MultiPolygon):
        return [p for p in geom.geoms if not p.is_empty and p.area > 0.05]
    if isinstance(geom, Polygon) and not geom.is_empty and geom.area > 0.05:
        return [geom]
    return []


def _simplify_for_extrusion(geom, tolerance: float = 0.08) -> object:
    """Simplify a Shapely geometry before extrusion.

    Reduces vertex count on dense urban polygons (coaster plates) where many
    tight building holes can cause trimesh's earcut triangulator to fail or
    produce non-flat faces.  A 0.08 mm tolerance is negligible at print scale.
    """
    try:
        s = geom.simplify(tolerance, preserve_topology=True)
        return make_valid(s) if not s.is_empty else geom
    except Exception:
        return geom


def _extrude(poly: Polygon, height: float, z_base: float = 0.0) -> trimesh.Trimesh | None:
    if height <= 0.01 or poly.is_empty or poly.area < 0.05:
        return None
    try:
        m = trimesh.creation.extrude_polygon(poly, height)
        if z_base:
            m.apply_translation([0, 0, z_base])
        return m
    except Exception:
        return None

def _export(meshes: list) -> BytesIO:
    meshes = [m for m in meshes if m is not None]
    if not meshes:
        mesh = trimesh.creation.box([10, 10, 1])
    else:
        try:
            mesh = trimesh.util.concatenate(meshes)
        except Exception:
            mesh = meshes[0]
    mesh.vertices[:, 2] -= mesh.bounds[0][2]
    out = BytesIO()
    mesh.export(out, file_type='stl')
    out.seek(0)
    return out


# ── Elevation (SRTM via OpenTopoData) ─────────────────────────────────────────

def _fetch_elevation(
    west, south, east, north, nx=10, ny=10,
) -> list[list[float]] | None:
    lons = [west  + (east  - west)  * i / (nx - 1) for i in range(nx)]
    lats = [south + (north - south) * j / (ny - 1) for j in range(ny)]
    locs = '|'.join(
        f'{lat:.5f},{lon:.5f}'
        for lat in lats for lon in lons
    )
    try:
        r = requests.get(
            f'https://api.opentopodata.org/v1/srtm90m?locations={locs}',
            timeout=20,
        )
        data = r.json()
        elevs = [res.get('elevation') or 0.0 for res in data.get('results', [])]
        if len(elevs) != nx * ny:
            return None
        mn, mx = min(elevs), max(elevs)
        rng = mx - mn or 1.0
        norm = [(e - mn) / rng for e in elevs]
        return [[norm[j * nx + i] for i in range(nx)] for j in range(ny)]
    except Exception:
        return None

def _build_terrain_mesh(
    grid, plate_w, plate_h, z_base, z_range,
) -> trimesh.Trimesh | None:
    ny, nx = len(grid), len(grid[0])
    verts = []
    for j in range(ny):
        for i in range(nx):
            x = i / (nx - 1) * plate_w
            y = j / (ny - 1) * plate_h
            z = z_base + grid[j][i] * z_range
            verts.append([x, y, z])
    faces = []
    for j in range(ny - 1):
        for i in range(nx - 1):
            v0, v1 = j*nx+i, j*nx+(i+1)
            v2, v3 = (j+1)*nx+i, (j+1)*nx+(i+1)
            faces += [[v0,v1,v2],[v1,v3,v2]]
    try:
        return trimesh.Trimesh(
            vertices=np.array(verts, dtype=float),
            faces=np.array(faces),
        )
    except Exception:
        return None
