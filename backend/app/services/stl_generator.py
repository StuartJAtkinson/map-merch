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
    Polygon, MultiPolygon, LineString,
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

# Height constants (mm)
BLDG_H_FLAT  = 5.0   # uniform building height for flat mode
WATER_H      = 1.5   # water layer thickness
MIN_BLDG_H   = 1.0   # minimum height for any building
GAP_CLOSE_MM = 0.8   # gaps smaller than this between buildings are merged
WATER_EXPAND = 0.5   # how much water expands beyond its OSM boundary


class STLGenerator:

    def generate(
        self,
        osm_data: dict,
        merch_type: str,
        height_mm: float = 5.0,
        base_thickness_mm: float = 2.0,
        bbox: tuple[float, float, float, float] | None = None,
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

        bldg_h = height_mm if topology else BLDG_H_FLAT

        return self._build(
            ways, way_pts, plate_w, plate_h,
            bldg_h, topology, elev_grid,
        )

    # ── Main build ─────────────────────────────────────────────────────────────

    def _build(
        self, ways, way_pts,
        plate_w, plate_h, bldg_h,
        topology, elev_grid,
    ) -> dict[str, BytesIO]:

        # ── 1. Collect raw shapes ──────────────────────────────────────────────
        raw_bldgs:   list[tuple[Polygon, float]] = []  # (poly, height_mm)
        raw_roads:   list[Polygon]               = []
        raw_water:   list[Polygon]               = []

        for way in ways:
            tags = way.get('tags', {})
            pts  = way_pts(way)

            # Buildings
            if tags.get('building') not in (None, 'no') and len(pts) >= 3:
                poly = _make_poly(pts)
                if poly:
                    if topology:
                        levels = float(tags.get('building:levels', 2))
                        h = float(tags.get('building:height', levels * 3.2))
                        h = max(h / 40.0 * bldg_h, MIN_BLDG_H)
                    else:
                        h = bldg_h
                    raw_bldgs.append((poly, h))
                continue

            # Roads
            hw = tags.get('highway')
            if hw in ROAD_WIDTH_MM and len(pts) >= 2:
                poly = _buffer_line(pts, ROAD_WIDTH_MM[hw])
                if poly:
                    raw_roads.append(poly)
                continue

            # Water polygons
            if (tags.get('natural') == 'water' or
                    tags.get('landuse') in WATER_POLY_TAGS) and len(pts) >= 3:
                poly = _make_poly(pts, buffer=WATER_EXPAND)
                if poly:
                    raw_water.append(poly)
                continue

            # Waterways
            ww = tags.get('waterway')
            if ww in WATERWAY_WIDTH_MM and len(pts) >= 2:
                # Expand waterways by extra amount so thin streams are printable
                poly = _buffer_line(pts, WATERWAY_WIDTH_MM[ww] + WATER_EXPAND)
                if poly:
                    raw_water.append(poly)

        # ── 2. Simplify & merge buildings ──────────────────────────────────────
        # Simplify individual outlines first
        bldg_polys = []
        bldg_heights = []
        for poly, h in raw_bldgs:
            s = poly.simplify(0.4, preserve_topology=True)
            s = make_valid(s)
            for p in _geom_parts(s):
                if p.area > 0.1:
                    bldg_polys.append(p)
                    bldg_heights.append(h)

        # Close gaps < GAP_CLOSE_MM between buildings
        if bldg_polys:
            half = GAP_CLOSE_MM / 2
            expanded = [p.buffer(half, join_style=2) for p in bldg_polys]
            merged = make_valid(unary_union(expanded))
            # Shrink back slightly less than we expanded so merges stick
            merged = merged.buffer(-half * 0.85, join_style=2)
            merged = make_valid(merged)
            bldg_union = merged
        else:
            bldg_union = Polygon()

        road_union  = make_valid(unary_union(raw_roads))  if raw_roads  else Polygon()
        water_union = make_valid(unary_union(raw_water))  if raw_water  else Polygon()

        # Urban structures (buildings + roads) combined for cutout purposes
        urban_union = make_valid(bldg_union.union(road_union)) if not road_union.is_empty else bldg_union

        # ── 3. Build three pieces ──────────────────────────────────────────────
        return {
            'buildings': _export(self._buildings_piece(
                bldg_polys, bldg_heights, raw_roads, bldg_h, topology
            )),
            'water':  _export(self._water_piece(
                water_union, urban_union, plate_w, plate_h, bldg_h
            )),
            'land':   _export(self._land_piece(
                urban_union, water_union, plate_w, plate_h,
                bldg_h, topology, elev_grid
            )),
        }

    # ── Buildings piece ────────────────────────────────────────────────────────

    def _buildings_piece(
        self, bldg_polys, bldg_heights, raw_roads, bldg_h, topology,
    ) -> list[trimesh.Trimesh]:
        meshes = []

        # Building pillars
        for poly, h in zip(bldg_polys, bldg_heights):
            h = max(h, MIN_BLDG_H)
            for p in _geom_parts(poly):
                m = _extrude(p, h)
                if m: meshes.append(m)

        # Road pillars — same height as uniform bldg_h (structural)
        for poly in raw_roads:
            for p in _geom_parts(make_valid(poly)):
                m = _extrude(p, bldg_h)
                if m: meshes.append(m)

        return meshes

    # ── Water piece ────────────────────────────────────────────────────────────

    def _water_piece(
        self, water_union, urban_union,
        plate_w, plate_h, bldg_h,
    ) -> list[trimesh.Trimesh]:
        if water_union.is_empty:
            return []

        # Clip water to plate boundary
        plate_rect = shapely_box(0, 0, plate_w, plate_h)
        water = make_valid(water_union.intersection(plate_rect))

        # Punch holes where buildings/roads are (pillars slot through)
        if not urban_union.is_empty:
            water = make_valid(water.difference(urban_union))

        meshes = []
        for p in _geom_parts(water):
            m = _extrude(p, WATER_H)
            if m: meshes.append(m)
        return meshes

    # ── Land piece (locking lid) ───────────────────────────────────────────────

    def _land_piece(
        self, urban_union, water_union,
        plate_w, plate_h, bldg_h,
        topology, elev_grid,
    ) -> list[trimesh.Trimesh]:
        plate_rect = shapely_box(0, 0, plate_w, plate_h)

        # Land = everything not urban and not water
        land = plate_rect
        if not urban_union.is_empty:
            land = make_valid(land.difference(urban_union))
        if not water_union.is_empty:
            land = make_valid(land.difference(water_union.intersection(plate_rect)))

        land_thickness = bldg_h - WATER_H

        if not topology or elev_grid is None:
            # Flat lid: extrude from WATER_H to BLDG_H
            meshes = []
            for p in _geom_parts(land):
                m = _extrude(p, land_thickness, z_base=WATER_H)
                if m: meshes.append(m)
            return meshes
        else:
            # Topology lid: terrain top surface, flat bottom at WATER_H
            return self._terrain_lid(land, elev_grid, plate_w, plate_h,
                                     WATER_H, bldg_h)

    def _terrain_lid(
        self, land_shape, elev_grid,
        plate_w, plate_h, z_bottom, z_max,
    ) -> list[trimesh.Trimesh]:
        """Build a terrain surface lid for the land piece."""
        terrain = _build_terrain_mesh(elev_grid, plate_w, plate_h, z_bottom, z_max - z_bottom)
        # We return just the terrain — in practice a slicer will close the bottom
        # TODO: add side walls and bottom face for a fully watertight solid
        return [terrain] if terrain else []


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
