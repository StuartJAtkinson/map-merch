"""
3-colour interlocking STL generator.

Three separate printable pieces that assemble into a complete map model:

  buildings.stl (grey)
      All building pillars + road ribbons, Z=0 → BLDG_H.
      Simplified polygons, small gaps closed, minimum 1 mm height.

  water.stl (blue)
      All water bodies + buffered waterways, Z=0 → WATER_H.
      Building/road shapes punched out so the grey pillars slot through.

  land.stl (green) — the locking lid
      Everything that isn't buildings, roads, or water.
      Z=WATER_H → BLDG_H (slides down over building tops, sits on water layer).
      Flat for coaster/placemat; terrain surface for relief/topology mode.

Assembly: lay blue water disc → slot grey buildings through holes → slide green
lid down over building tops. The lid physically locks the stack.
"""

import math
import requests
import trimesh
import numpy as np
from shapely.geometry import (
    Polygon, MultiPolygon, LineString, Point,
    box as shapely_box,
)
from shapely.ops import unary_union
from shapely.validation import make_valid
from io import BytesIO


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

# Road widths in mm (for building layer — roads are structural pillars too)
ROAD_WIDTH_MM: dict[str, float] = {
    'motorway': 3.0, 'trunk': 2.8, 'primary': 2.5, 'secondary': 2.0,
    'tertiary': 1.5, 'residential': 1.2, 'unclassified': 1.2, 'service': 0.8,
}
WATER_POLY_TAGS = {'water', 'reservoir', 'lake', 'pond', 'basin', 'lagoon'}
WATERWAY_WIDTH_MM: dict[str, float] = {
    'river': 4.0, 'canal': 3.0, 'stream': 1.5, 'drain': 1.0,
}

# Default height constants (mm) — all overridable via STLGenerationRequest
BLDG_H_DEFAULT   = 4.0   # buildings + roads: 0 → BLDG_H
WATER_START_DEF  = 1.0   # water layer bottom
WATER_END_DEF    = 2.0   # water layer top (sea level)
LAND_START_DEF   = 2.0   # land layer bottom
LAND_END_DEF     = 3.0   # land layer top
MIN_BLDG_H       = 1.0   # minimum building height
GAP_CLOSE_MM     = 0.8   # gaps smaller than this between buildings are merged
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

        return self._build(
            ways, way_pts, plate_w, plate_h,
            bldg_height, water_start, water_end, land_start, land_end,
            gap_close_mm, water_expand_mm, min_bldg_mm, self._collar,
            topology, elev_grid, active_shape,
        )

    # ── Main build ─────────────────────────────────────────────────────────────

    def _build(
        self, ways, way_pts,
        plate_w, plate_h,
        bldg_h, water_start, water_end, land_start, land_end,
        gap_close, water_expand, min_bldg, collar,
        topology, elev_grid, coaster_shape: str = 'square',
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
            if hw in ROAD_WIDTH_MM and len(pts) >= 2:
                poly = _buffer_line(pts, ROAD_WIDTH_MM[hw])
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
            if ww in WATERWAY_WIDTH_MM and len(pts) >= 2:
                poly = _buffer_line(pts, WATERWAY_WIDTH_MM[ww] + water_expand)
                if poly:
                    raw_water.append(poly)

        # ── 2. Simplify & merge buildings ──────────────────────────────────────
        bldg_polys, bldg_heights = [], []
        for poly, h in raw_bldgs:
            s = make_valid(poly.simplify(0.4, preserve_topology=True))
            for p in _geom_parts(s):
                if p.area > 0.1:
                    bldg_polys.append(p)
                    bldg_heights.append(max(h, min_bldg))

        if bldg_polys:
            half = gap_close / 2
            merged = make_valid(unary_union([p.buffer(half, join_style=2) for p in bldg_polys]))
            merged = make_valid(merged.buffer(-half * 0.85, join_style=2))
            bldg_union = merged
        else:
            bldg_union = Polygon()

        road_union  = make_valid(unary_union(raw_roads)) if raw_roads else Polygon()
        water_union = make_valid(unary_union(raw_water)) if raw_water else Polygon()
        urban_union = make_valid(bldg_union.union(road_union)) if not road_union.is_empty else bldg_union

        # ── 3. Build three pieces ──────────────────────────────────────────────
        plate_shape, outer_shape = _plate_shapes(plate_w, plate_h, collar, coaster_shape)

        return {
            'buildings': _export(self._buildings_piece(
                bldg_polys, bldg_heights, raw_roads,
                bldg_union, road_union, urban_union,
                plate_shape, outer_shape, bldg_h, topology
            )),
            'water': _export(self._water_piece(
                water_union, urban_union, plate_shape, water_start, water_end
            )),
            'land': _export(self._land_piece(
                urban_union, water_union, plate_shape, outer_shape,
                land_start, land_end, topology, elev_grid
            )),
        }

    # ── Buildings piece ────────────────────────────────────────────────────────
    # Flat mode: extrudes the MERGED urban union (terraced rows → single cuboid).
    # Topology mode: individual buildings at proportional heights.
    # Both modes: outer collar ring = frame walls at bldg_h so water + lid sit inside.

    def _buildings_piece(
        self, bldg_polys, bldg_heights, raw_roads,
        bldg_union, road_union, urban_union,
        plate_shape, outer_shape, bldg_h, topology,
    ) -> list[trimesh.Trimesh]:
        meshes = []
        # Outer collar walls — frame that water and lid sit inside
        collar_ring = make_valid(outer_shape.difference(plate_shape))
        m = _extrude(collar_ring, bldg_h)
        if m:
            meshes.append(m)

        if topology:
            # Individual buildings at proportional heights
            for poly, h in zip(bldg_polys, bldg_heights):
                for p in _geom_parts(poly):
                    m = _extrude(p, h)
                    if m:
                        meshes.append(m)
            for poly in raw_roads:
                for p in _geom_parts(make_valid(poly)):
                    m = _extrude(p, bldg_h)
                    if m:
                        meshes.append(m)
        else:
            # Flat mode: extrude the fully merged urban union
            # → terrace rows merge into single cuboids, no hairline gaps
            for p in _geom_parts(urban_union):
                m = _extrude(p, bldg_h)
                if m:
                    meshes.append(m)

        return meshes

    # ── Water piece ────────────────────────────────────────────────────────────
    # Thin layer within the plate bounds (inside the collar walls).
    # Buildings and roads punch through it as holes.

    def _water_piece(
        self, water_union, urban_union,
        plate_shape, water_start, water_end,
    ) -> list[trimesh.Trimesh]:
        if water_union.is_empty:
            return []
        water = make_valid(water_union.intersection(plate_shape))
        if not urban_union.is_empty:
            water = make_valid(water.difference(urban_union))
        thickness = max(water_end - water_start, 0.5)
        meshes = []
        for p in _geom_parts(water):
            m = _extrude(p, thickness, z_base=water_start)
            if m:
                meshes.append(m)
        return meshes

    # ── Land piece (locking lid) ───────────────────────────────────────────────
    # Same outer footprint as the collar (plate + collar_mm on all sides).
    # Inner area has holes for building protrusions.
    # The collar portion of the lid is always solid — creates the outer frame.

    def _land_piece(
        self, urban_union, water_union,
        plate_shape, outer_shape,
        land_start, land_end,
        topology, elev_grid,
    ) -> list[trimesh.Trimesh]:
        # Collar ring — always solid, creates the outer frame of the lid
        collar_ring = make_valid(outer_shape.difference(plate_shape))

        # Inner land — plate area minus buildings/roads (and water if present)
        inner = plate_shape
        if not urban_union.is_empty:
            inner = make_valid(inner.difference(urban_union))
        if not water_union.is_empty:
            inner = make_valid(inner.difference(water_union.intersection(plate_shape)))

        # Combine inner land + collar ring = full lid shape
        lid_shape = make_valid(inner.union(collar_ring))

        thickness = max(land_end - land_start, 0.5)

        if not topology or elev_grid is None:
            meshes = []
            for p in _geom_parts(lid_shape):
                m = _extrude(p, thickness, z_base=land_start)
                if m:
                    meshes.append(m)
            return meshes
        else:
            bounds = plate_shape.bounds  # (minx, miny, maxx, maxy)
            pw, ph = bounds[2] - bounds[0], bounds[3] - bounds[1]
            return self._terrain_lid(lid_shape, elev_grid, pw, ph,
                                     land_start, land_end)

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
    elif len(meshes) == 1:
        mesh = meshes[0]
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
