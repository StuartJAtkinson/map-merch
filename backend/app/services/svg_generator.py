import math
import svgwrite
from io import BytesIO, StringIO


# ---------------------------------------------------------------------------
# Road classification
# ---------------------------------------------------------------------------
MAIN_ROADS  = {'motorway', 'trunk', 'primary', 'secondary'}
OTHER_ROADS = {'tertiary', 'residential', 'unclassified', 'service', 'living_street', 'road'}
PATHS       = {'footway', 'cycleway', 'path', 'pedestrian', 'track', 'bridleway', 'steps'}

ROAD_WIDTH = {
    'motorway': 5, 'trunk': 4.5, 'primary': 4, 'secondary': 3,
    'tertiary': 2, 'residential': 1.5, 'unclassified': 1.5,
    'service': 1, 'living_street': 1.5, 'road': 1.5,
    'footway': 0.7, 'cycleway': 0.7, 'path': 0.7,
    'pedestrian': 1, 'track': 0.8, 'bridleway': 0.8, 'steps': 0.7,
}

RAILWAY_TYPES = {'rail', 'tram', 'subway', 'light_rail', 'narrow_gauge', 'monorail'}
RAILWAY_WIDTH = {'rail': 2, 'tram': 1.2, 'subway': 1.5, 'light_rail': 1.2,
                 'narrow_gauge': 1.5, 'monorail': 1}

# ---------------------------------------------------------------------------
# Landuse tag → group
# ---------------------------------------------------------------------------
LANDUSE_GROUP: dict[str, str] = {
    # Agriculture / open countryside
    'farmland': 'agri', 'farmyard': 'agri', 'meadow': 'agri',
    'grass': 'agri', 'heath': 'agri', 'scrub': 'agri',
    'orchard': 'agri', 'vineyard': 'agri', 'allotments': 'agri',
    # Managed green / parks
    'park': 'park', 'recreation_ground': 'park', 'nature_reserve': 'park',
    'village_green': 'park', 'greenfield': 'park', 'forest': 'park',
    'wood': 'park',
    # Residential / civic / commercial
    'residential': 'urban_res', 'commercial': 'urban_res',
    'retail': 'urban_res', 'civic': 'urban_res',
    # Industrial
    'industrial': 'urban_ind', 'construction': 'urban_ind',
    'quarry': 'urban_ind', 'depot': 'urban_ind', 'landfill': 'urban_ind',
}

# leisure=* tags → treat as park
LEISURE_PARK = {'park', 'garden', 'nature_reserve', 'common',
                'recreation_ground', 'playing_fields', 'pitch', 'golf_course'}

# natural=* tags → treat as agri
NATURAL_AGRI = {'wood', 'scrub', 'heath', 'grassland', 'fell',
                'bare_rock', 'sand', 'beach', 'wetland'}

# water polygon identifiers
WATER_POLYGON = {'water', 'reservoir', 'basin', 'lagoon', 'lake', 'pond'}
WATERWAY_LINE = {'river', 'canal', 'stream', 'drain', 'ditch'}
WATERWAY_LINE_WIDTH = {'river': 4, 'canal': 3, 'stream': 1.5, 'drain': 1, 'ditch': 0.8}

# ---------------------------------------------------------------------------
# Per-style palette + feature flags
# ---------------------------------------------------------------------------
STYLES: dict[str, dict] = {
    'osm_default': {
        'background':  '#EAE6DC',
        'agri':        '#DDE8C0',
        'park':        '#B8D898',
        'urban_res':   '#E8E0D4',
        'urban_ind':   '#D4CCC0',
        'water':       '#A8C8E8',
        'road_main':   '#FFFFFF',
        'road_other':  '#F0EBE0',
        'road_path':   '#E0DAD0',
        'railway':     '#444444',
        'building':    '#CEC8C0',
        'label':       '#404040',
        # feature flags
        'show_minor_roads': True,
        'show_paths':       False,
        'show_buildings':   True,
        'show_labels':      True,
        'show_railways':    False,
    },
    'minimalist': {
        'background':  '#F5F5F2',
        'agri':        '#E4EAD8',
        'park':        '#CCDABC',
        'urban_res':   '#EBEBEB',
        'urban_ind':   '#DCDCDC',
        'water':       '#C0D8EC',
        'road_main':   '#888888',
        'road_other':  '#BBBBBB',   # unused — minor roads off
        'road_path':   '#CCCCCC',   # unused
        'railway':     '#111111',
        'building':    '#D8D8D8',
        'label':       '#555555',
        # feature flags
        'show_minor_roads': False,
        'show_paths':       False,
        'show_buildings':   False,
        'show_labels':      False,
        'show_railways':    True,
    },
    'vibrant': {
        'background':  '#F5E6C8',
        'agri':        '#C8E0A0',
        'park':        '#80C870',
        'urban_res':   '#F0D8B0',
        'urban_ind':   '#D8C090',
        'water':       '#50A8E0',
        'road_main':   '#FFFFFF',
        'road_other':  '#F8EDD8',
        'road_path':   '#EDE0C8',
        'railway':     '#222222',
        'building':    '#C8A888',
        'label':       '#202020',
        # feature flags
        'show_minor_roads': True,
        'show_paths':       False,
        'show_buildings':   True,
        'show_labels':      True,
        'show_railways':    True,
    },
}


class SVGGenerator:
    """Converts OSM data into styled SVG for merch products."""

    def __init__(self, merch_specs: dict):
        self.merch_specs = merch_specs
        self.nodes: dict[int, tuple[float, float]] = {}
        self.ways: list[dict] = []
        self.relations: list[dict] = []
        self.place_nodes: list[dict] = []
        self._bbox: tuple[float, float, float, float] = (-0.13, 51.50, -0.11, 51.52)
        self._svg_w: int = 3000
        self._svg_h: int = 4000

    # ── Public ────────────────────────────────────────────────────────────────

    def generate(
        self,
        osm_data: dict,
        merch_type: str,
        style: str = 'osm_default',
        include_labels: bool = True,
        include_buildings: bool = True,
        include_roads: bool = True,
        include_parks: bool = True,
        bbox: tuple[float, float, float, float] | None = None,
    ) -> BytesIO:
        self._parse_elements(osm_data.get('elements', []))

        spec = self.merch_specs[merch_type]
        self._svg_w = spec['width_px']
        self._svg_h = spec['height_px']
        self._bbox  = bbox or self._bbox_from_nodes()

        palette = STYLES.get(style, STYLES['osm_default'])

        svg = svgwrite.Drawing(size=(str(self._svg_w), str(self._svg_h)))

        # Background behind clip region
        svg.add(svg.rect(insert=(0, 0), size=(self._svg_w, self._svg_h),
                         fill=palette['background']))

        # Hard clip — everything outside the canvas boundary is cut off
        clip = svg.defs.add(svg.clipPath(id='map-clip'))
        clip.add(svg.rect(insert=(0, 0), size=(self._svg_w, self._svg_h)))
        g = svg.add(svg.g(clip_path='url(#map-clip)'))

        # Draw order: land → water → buildings → roads → railways → labels
        if include_parks:
            self._draw_landuse(g, palette)

        self._draw_water(g, palette)

        if palette['show_buildings'] and include_buildings:
            self._draw_buildings(g, palette)

        if include_roads:
            self._draw_roads(g, palette)

        if palette['show_railways']:
            self._draw_railways(g, palette)

        if include_labels and palette['show_labels']:
            self._draw_labels(g, palette)

        # Attribution outside the clip (always visible)
        self._draw_attribution(svg)

        sio = StringIO()
        svg.write(sio)
        return BytesIO(sio.getvalue().encode('utf-8'))

    # ── Parsing ───────────────────────────────────────────────────────────────

    def _parse_elements(self, elements: list[dict]) -> None:
        self.nodes = {}
        self.ways = []
        self.relations = []
        self.place_nodes: list[dict] = []
        for el in elements:
            t = el.get('type')
            if t == 'node':
                self.nodes[el['id']] = (el['lon'], el['lat'])
                if 'place' in el.get('tags', {}):
                    self.place_nodes.append(el)
            elif t == 'way':
                self.ways.append(el)
            elif t == 'relation':
                self.relations.append(el)

    # ── Projection ────────────────────────────────────────────────────────────

    def _project(self, lon: float, lat: float) -> tuple[float, float]:
        """Project WGS84 lon/lat to SVG pixels with cosine-of-latitude correction.

        Without this, east-west features appear ~1/cos(lat) times too wide
        relative to north-south features (e.g. ~1.7× stretch at latitude 54°).
        """
        west, south, east, north = self._bbox
        mid_lat = (south + north) / 2
        cos_lat = math.cos(math.radians(mid_lat))
        # Convert everything to metric offsets from SW corner
        x_m = (lon - west) * cos_lat * 111_320
        y_m = (lat - south) * 111_320
        bbox_w_m = (east - west) * cos_lat * 111_320
        bbox_h_m = (north - south) * 111_320
        x = x_m / bbox_w_m * self._svg_w
        y = (1.0 - y_m / bbox_h_m) * self._svg_h
        return x, y

    def _way_points(self, way: dict) -> list[tuple[float, float]]:
        pts = []
        for nid in way.get('nodes', []):
            if nid in self.nodes:
                pts.append(self._project(*self.nodes[nid]))
        return pts

    def _path_d(self, pts: list[tuple[float, float]], close: bool = False) -> str:
        d = 'M {:.1f} {:.1f}'.format(*pts[0])
        for p in pts[1:]:
            d += ' L {:.1f} {:.1f}'.format(*p)
        if close:
            d += ' Z'
        return d

    def _bbox_from_nodes(self) -> tuple[float, float, float, float]:
        if not self.nodes:
            return (-0.13, 51.50, -0.11, 51.52)
        lons = [n[0] for n in self.nodes.values()]
        lats = [n[1] for n in self.nodes.values()]
        return (min(lons), min(lats), max(lons), max(lats))

    # ── Layers ────────────────────────────────────────────────────────────────

    def _draw_landuse(self, svg: svgwrite.Drawing, p: dict) -> None:
        for way in self.ways:
            tags = way.get('tags', {})
            group = self._landuse_group(tags)
            if not group:
                continue
            pts = self._way_points(way)
            if len(pts) < 3:
                continue
            svg.add(svg.path(d=self._path_d(pts, close=True),
                             fill=p[group], stroke='none'))

    def _landuse_group(self, tags: dict) -> str | None:
        lu = tags.get('landuse')
        if lu:
            return LANDUSE_GROUP.get(lu)
        le = tags.get('leisure')
        if le in LEISURE_PARK:
            return 'park'
        nat = tags.get('natural')
        if nat in NATURAL_AGRI:
            return 'agri'
        if nat == 'water':
            return None  # handled by water layer
        return None

    def _draw_water(self, svg: svgwrite.Drawing, p: dict) -> None:
        color = p['water']
        for way in self.ways:
            tags = way.get('tags', {})

            # Polygon water (lake, reservoir, etc.)
            nat = tags.get('natural')
            lu  = tags.get('landuse')
            ww  = tags.get('waterway')

            if nat == 'water' or lu in WATER_POLYGON or ww == 'riverbank':
                pts = self._way_points(way)
                if len(pts) >= 3:
                    svg.add(svg.path(d=self._path_d(pts, close=True),
                                     fill=color, stroke='none'))

            elif ww in WATERWAY_LINE:
                pts = self._way_points(way)
                if len(pts) >= 2:
                    w = WATERWAY_LINE_WIDTH.get(ww, 1.5)
                    svg.add(svg.path(d=self._path_d(pts),
                                     stroke=color, stroke_width=w,
                                     fill='none', stroke_linecap='round',
                                     stroke_linejoin='round'))

    def _draw_buildings(self, svg: svgwrite.Drawing, p: dict) -> None:
        for way in self.ways:
            tags = way.get('tags', {})
            if tags.get('building') in (None, 'no'):
                continue
            pts = self._way_points(way)
            if len(pts) < 3:
                continue
            svg.add(svg.path(d=self._path_d(pts, close=True),
                             fill=p['building'], stroke='none'))

    def _draw_roads(self, svg: svgwrite.Drawing, p: dict) -> None:
        for way in self.ways:
            tags = way.get('tags', {})
            hw = tags.get('highway')
            if not hw:
                continue

            if hw in MAIN_ROADS:
                color = p['road_main']
            elif hw in OTHER_ROADS:
                if not p['show_minor_roads']:
                    continue
                color = p['road_other']
            elif hw in PATHS:
                if not p['show_paths']:
                    continue
                color = p['road_path']
            else:
                continue

            pts = self._way_points(way)
            if len(pts) < 2:
                continue

            w = ROAD_WIDTH.get(hw, 1.5)
            svg.add(svg.path(d=self._path_d(pts),
                             stroke=color, stroke_width=w,
                             fill='none', stroke_linecap='round',
                             stroke_linejoin='round'))

    def _draw_railways(self, svg: svgwrite.Drawing, p: dict) -> None:
        for way in self.ways:
            tags = way.get('tags', {})
            rw = tags.get('railway')
            if rw not in RAILWAY_TYPES:
                continue
            pts = self._way_points(way)
            if len(pts) < 2:
                continue
            w = RAILWAY_WIDTH.get(rw, 1.5)
            svg.add(svg.path(d=self._path_d(pts),
                             stroke=p['railway'], stroke_width=w,
                             fill='none', stroke_linecap='butt',
                             stroke_linejoin='round'))

    def _draw_labels(self, svg: svgwrite.Drawing, p: dict) -> None:
        PLACE_STYLE = {
            'city':         {'size': 22, 'weight': 'bold',   'upper': True},
            'town':         {'size': 16, 'weight': 'bold',   'upper': False},
            'village':      {'size': 13, 'weight': 'normal', 'upper': False},
            'hamlet':       {'size': 11, 'weight': 'normal', 'upper': False},
            'suburb':       {'size': 12, 'weight': 'normal', 'upper': True},
            'neighbourhood':{'size': 11, 'weight': 'normal', 'upper': True},
            'quarter':      {'size': 11, 'weight': 'normal', 'upper': True},
            'island':       {'size': 13, 'weight': 'normal', 'upper': False},
        }
        for node in getattr(self, 'place_nodes', []):
            tags = node.get('tags', {})
            name = tags.get('name')
            place = tags.get('place')
            if not name or place not in PLACE_STYLE:
                continue
            x, y = self._project(node['lon'], node['lat'])
            style = PLACE_STYLE[place]
            label = name.upper() if style['upper'] else name
            svg.add(svg.text(
                label,
                insert=(x, y),
                font_size=str(style['size']),
                font_weight=style['weight'],
                fill=p['label'],
                font_family='Arial, sans-serif',
                text_anchor='middle',
            ))

    def _draw_attribution(self, svg: svgwrite.Drawing) -> None:
        svg.add(svg.text(
            '© OpenStreetMap contributors (ODbL)',
            insert=(10, self._svg_h - 10),
            font_size='11', fill='#888888',
            font_family='Arial, sans-serif',
        ))
