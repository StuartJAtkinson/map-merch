// ── Road classification ──────────────────────────────────────────────────────
const MAIN_ROADS  = new Set(['motorway','trunk','primary','secondary']);
const OTHER_ROADS = new Set(['tertiary','residential','unclassified','service','living_street','road']);
const PATHS       = new Set(['footway','cycleway','path','pedestrian','track','bridleway','steps']);

const ROAD_W: Record<string,number> = {
  motorway:5, trunk:4.5, primary:4, secondary:3,
  tertiary:2, residential:1.5, unclassified:1.5,
  service:1, living_street:1.5, road:1.5,
  footway:0.7, cycleway:0.7, path:0.7,
  pedestrian:1, track:0.8, bridleway:0.8, steps:0.7,
};

// ── Landuse classification ────────────────────────────────────────────────────
const LANDUSE_GROUP: Record<string,string> = {
  farmland:'agri', farmyard:'agri', meadow:'agri', grass:'agri', heath:'agri',
  scrub:'agri', orchard:'agri', vineyard:'agri', allotments:'agri',
  park:'park', recreation_ground:'park', nature_reserve:'park',
  village_green:'park', greenfield:'park', forest:'park', wood:'park',
  residential:'urban_res', commercial:'urban_res', retail:'urban_res', civic:'urban_res',
  industrial:'urban_ind', construction:'urban_ind', quarry:'urban_ind',
  depot:'urban_ind', landfill:'urban_ind',
};
const LEISURE_PARK = new Set(['park','garden','nature_reserve','common',
  'recreation_ground','playing_fields','pitch','golf_course']);
const NATURAL_AGRI = new Set(['wood','scrub','heath','grassland','fell',
  'bare_rock','sand','beach','wetland']);

// ── Water ─────────────────────────────────────────────────────────────────────
const WATER_POLY  = new Set(['water','reservoir','basin','lagoon','lake','pond']);
const WATERWAY_W: Record<string,number> = { river:4, canal:3, stream:1.5, drain:1, ditch:0.8 };

// ── Railways ──────────────────────────────────────────────────────────────────
const RAILWAY_TYPES = new Set(['rail','tram','subway','light_rail','narrow_gauge','monorail']);
const RAILWAY_W: Record<string,number> = { rail:2, tram:1.2, subway:1.5, light_rail:1.2, narrow_gauge:1.5, monorail:1 };

// ── Style palettes (mirrors Python svg_generator.py STYLES) ──────────────────
type Palette = Record<string, string | boolean>;

const STYLES: Record<string, Palette> = {
  osm_default: {
    background:'#EAE6DC', agri:'#DDE8C0', park:'#B8D898',
    urban_res:'#E8E0D4', urban_ind:'#D4CCC0', water:'#A8C8E8',
    road_main:'#FFFFFF', road_other:'#F0EBE0', road_path:'#E0DAD0',
    railway:'#444444', building:'#CEC8C0', label:'#404040',
    show_minor_roads:true, show_paths:true, show_buildings:true,
    show_labels:false, show_railways:false,
  },
  minimalist: {
    background:'#F5F5F2', agri:'#E4EAD8', park:'#CCDABC',
    urban_res:'#EBEBEB', urban_ind:'#DCDCDC', water:'#C0D8EC',
    road_main:'#888888', road_other:'#BBBBBB', road_path:'#CCCCCC',
    railway:'#111111', building:'#D8D8D8', label:'#555555',
    show_minor_roads:false, show_paths:false, show_buildings:false,
    show_labels:false, show_railways:true,
  },
  vibrant: {
    background:'#F5E6C8', agri:'#C8E0A0', park:'#80C870',
    urban_res:'#F0D8B0', urban_ind:'#D8C090', water:'#50A8E0',
    road_main:'#FFFFFF', road_other:'#F8EDD8', road_path:'#EDE0C8',
    railway:'#222222', building:'#C8A888', label:'#202020',
    show_minor_roads:true, show_paths:true, show_buildings:true,
    show_labels:false, show_railways:true,
  },
};

// ── Merch pixel dimensions (mirrors Python MERCH_SPECS) ───────────────────────
export const SVG_SPECS: Record<string, { width_px: number; height_px: number }> = {
  placemat:  { width_px: 4200, height_px: 3000 },
  coaster:   { width_px: 1000, height_px: 1000 },
  tshirt:    { width_px: 3000, height_px: 4000 },
  mug:       { width_px: 2700, height_px:  900 },
  tote:      { width_px: 2000, height_px: 3000 },
  '3d_print':{ width_px:  800, height_px:  800 },
};

// ── Place label styles ────────────────────────────────────────────────────────
const PLACE_STYLE: Record<string, { size: number; weight: string; upper: boolean }> = {
  city:          { size:22, weight:'bold',   upper:true  },
  town:          { size:16, weight:'bold',   upper:false },
  village:       { size:13, weight:'normal', upper:false },
  hamlet:        { size:11, weight:'normal', upper:false },
  suburb:        { size:12, weight:'normal', upper:true  },
  neighbourhood: { size:11, weight:'normal', upper:true  },
  quarter:       { size:11, weight:'normal', upper:true  },
  island:        { size:13, weight:'normal', upper:false },
};

// ── Helpers ───────────────────────────────────────────────────────────────────
const NS = 'http://www.w3.org/2000/svg';

function el(tag: string, attrs: Record<string, string | number> = {}): Element {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

function hexPoints(w: number, h: number, inset = 0.01): string {
  const cx = w/2, cy = h/2, r = Math.min(w,h)/2 * (1-inset);
  return Array.from({length:6}, (_, i) => {
    const a = Math.PI/2 + i*Math.PI/3;
    return `${(cx + r*Math.cos(a)).toFixed(2)},${(cy - r*Math.sin(a)).toFixed(2)}`;
  }).join(' ');
}

function project(
  lon: number, lat: number,
  bbox: [number,number,number,number],
  W: number, H: number,
): [number, number] {
  const [west, south, east, north] = bbox;
  const midLat = (south + north) / 2;
  const cosLat = Math.cos(midLat * Math.PI / 180);
  const xM     = (lon - west) * cosLat * 111_320;
  const yM     = (lat - south) * 111_320;
  const bboxW  = (east - west) * cosLat * 111_320;
  const bboxH  = (north - south) * 111_320;
  return [xM / bboxW * W, (1 - yM / bboxH) * H];
}

function pathD(pts: [number,number][], close = false): string {
  if (!pts.length) return '';
  const d = pts.map(([x,y], i) => `${i?'L':'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  return close ? d + ' Z' : d;
}

// ── Branding stamp ──────────────────────────────────────────────────────────
export type BrandStyle = 'outline' | 'banner';
export type BrandPos   = 'top' | 'bottom' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
export interface Branding { text: string; style: BrandStyle; position: BrandPos; }
const GREEN_PARTY = '#5AB031';        // banner bar fill
const STAMP_GREEN = '#00B140';        // pure-green Impact text fill
const IMPACT_FONT = "Impact, 'Haettenschweiler', 'Franklin Gothic Bold', 'Arial Narrow', sans-serif";

// ── Public API ────────────────────────────────────────────────────────────────
export interface SvgRenderOptions {
  osmData:          { elements?: Record<string,unknown>[] };
  bbox:             [number,number,number,number];
  merchType:        string;
  width_px?:        number;
  height_px?:       number;
  style?:           string;
  coasterShape?:    string;
  paletteOverrides?:Record<string,string>;
  includeLabels?:   boolean;
  includeBuildings?:boolean;
  branding?:        Branding | null;
}

export function renderSvg(opts: SvgRenderOptions): SVGSVGElement {
  const {
    osmData, bbox, merchType,
    style = 'osm_default', coasterShape = 'square',
    paletteOverrides = {}, includeLabels = true, includeBuildings = true,
    branding = null,
  } = opts;

  const spec = SVG_SPECS[merchType] ?? SVG_SPECS['tshirt'];
  const W = opts.width_px  ?? spec.width_px;
  const H = opts.height_px ?? spec.height_px;

  // No area-scale filtering — render everything the selection contains. Selection size
  // is hard-capped at the frontend selector, so there is no need to thin out features
  // for large areas here.

  // Parse OSM
  const nodes = new Map<number, [number,number]>();
  const ways: Record<string,unknown>[] = [];
  const placeNodes: Record<string,unknown>[] = [];
  for (const e of osmData.elements ?? []) {
    if (e.type === 'node') {
      nodes.set(e.id as number, [e.lon as number, e.lat as number]);
      if ((e.tags as any)?.place) placeNodes.push(e);
    } else if (e.type === 'way') {
      ways.push(e);
    }
  }

  function wayPts(way: Record<string,unknown>): [number,number][] {
    return ((way.nodes as number[]) ?? [])
      .map(id => { const n = nodes.get(id); return n ? project(n[0], n[1], bbox, W, H) : null; })
      .filter((p): p is [number,number] => p !== null);
  }

  // Merge palette
  const palette: Record<string, string | boolean> = {
    ...(STYLES[style] ?? STYLES['osm_default']),
    ...paletteOverrides,
  };

  // Build SVG element
  const svg = el('svg', { xmlns: NS, width: W, height: H, viewBox: `0 0 ${W} ${H}` }) as SVGSVGElement;

  // Clip path
  const defs = el('defs');
  const clip = el('clipPath', { id: 'map-clip' });
  if (merchType === 'coaster' && coasterShape === 'circle') {
    const r = Math.min(W, H) / 2;
    clip.appendChild(el('circle', { cx: W/2, cy: H/2, r }));
  } else if (merchType === 'coaster' && coasterShape === 'hexagon') {
    clip.appendChild(el('polygon', { points: hexPoints(W, H) }));
  } else {
    clip.appendChild(el('rect', { x:0, y:0, width:W, height:H }));
  }
  defs.appendChild(clip);
  svg.appendChild(defs);

  const g = el('g', { 'clip-path': 'url(#map-clip)' });
  svg.appendChild(g);
  // Background lives INSIDE the clip group so non-rectangular shapes (circle/hexagon)
  // are transparent outside the shape — the canvas corners get no fill (alpha).
  g.appendChild(el('rect', { x:0, y:0, width:W, height:H, fill: palette['background'] as string }));

  function addPath(d: string, fill: string | null, stroke: string | null,
                   strokeW: number, linecap = 'butt', linejoin = 'miter') {
    if (!d) return;
    const attrs: Record<string,string|number> = { d, fill: fill ?? 'none' };
    if (stroke) {
      attrs.stroke = stroke;
      attrs['stroke-width'] = strokeW;
      attrs['stroke-linecap'] = linecap;
      attrs['stroke-linejoin'] = linejoin;
    }
    g.appendChild(el('path', attrs));
  }

  // 1. Landuse
  for (const way of ways) {
    const tags = (way.tags ?? {}) as Record<string,string>;
    let group = LANDUSE_GROUP[tags.landuse];
    if (!group && LEISURE_PARK.has(tags.leisure)) group = 'park';
    if (!group && NATURAL_AGRI.has(tags.natural)) group = 'agri';
    if (!group) continue;
    const pts = wayPts(way);
    if (pts.length >= 3) addPath(pathD(pts, true), palette[group] as string, null, 0);
  }

  // 2. Water
  for (const way of ways) {
    const tags = (way.tags ?? {}) as Record<string,string>;
    if (tags.natural === 'water' || WATER_POLY.has(tags.landuse) || tags.waterway === 'riverbank') {
      const pts = wayPts(way);
      if (pts.length >= 3) addPath(pathD(pts, true), palette['water'] as string, null, 0);
    } else if (WATERWAY_W[tags.waterway]) {
      const pts = wayPts(way);
      if (pts.length >= 2)
        addPath(pathD(pts), null, palette['water'] as string, WATERWAY_W[tags.waterway], 'round', 'round');
    }
  }

  // 3. Buildings
  if (includeBuildings && palette['show_buildings']) {
    for (const way of ways) {
      const tags = (way.tags ?? {}) as Record<string,string>;
      if (!tags.building || tags.building === 'no') continue;
      const pts = wayPts(way);
      if (pts.length >= 3) addPath(pathD(pts, true), palette['building'] as string, null, 0);
    }
  }

  // 4. Roads
  for (const way of ways) {
    const tags = (way.tags ?? {}) as Record<string,string>;
    const hw = tags.highway;
    if (!hw) continue;
    let color: string;
    if (MAIN_ROADS.has(hw))       color = palette['road_main'] as string;
    else if (OTHER_ROADS.has(hw)) { if (!palette['show_minor_roads']) continue; color = palette['road_other'] as string; }
    else if (PATHS.has(hw))       { if (!palette['show_paths']) continue; color = palette['road_path'] as string; }
    else continue;
    const pts = wayPts(way);
    if (pts.length >= 2) addPath(pathD(pts), null, color, ROAD_W[hw] ?? 1.5, 'round', 'round');
  }

  // 5. Railways
  if (palette['show_railways']) {
    for (const way of ways) {
      const tags = (way.tags ?? {}) as Record<string,string>;
      if (!RAILWAY_TYPES.has(tags.railway)) continue;
      const pts = wayPts(way);
      if (pts.length >= 2)
        addPath(pathD(pts), null, palette['railway'] as string, RAILWAY_W[tags.railway] ?? 1.5, 'butt', 'round');
    }
  }

  // 6. Labels
  if (includeLabels && palette['show_labels']) {
    for (const node of placeNodes) {
      const tags = (node.tags ?? {}) as Record<string,string>;
      const st = PLACE_STYLE[tags.place];
      if (!tags.name || !st) continue;
      const [x, y] = project(node.lon as number, node.lat as number, bbox, W, H);
      const t = el('text', {
        x, y,
        fill: palette['label'] as string,
        'font-size': st.size,
        'font-weight': st.weight,
        'font-family': 'Arial, sans-serif',
        'text-anchor': 'middle',
      });
      t.textContent = st.upper ? tags.name.toUpperCase() : tags.name;
      g.appendChild(t);
    }
  }

  // 7. Branding stamp (e.g. "WAKEFIELD GREEN PARTY") — top layer, clipped to shape.
  if (branding && branding.text.trim()) {
    const shapeKind = (merchType === 'coaster' && coasterShape === 'circle') ? 'circle'
                    : (merchType === 'coaster' && coasterShape === 'hexagon') ? 'hexagon'
                    : 'rect';
    const txt  = branding.text.toUpperCase();
    const minD = Math.min(W, H);
    // Stamp spans exactly half the shape width — centered.
    const fitW = (shapeKind === 'rect' ? W : minD) * 0.42;
    const fs   = Math.min(minD * 0.075, fitW / Math.max(8, txt.length * 0.46));
    const isTop = branding.position.startsWith('top');

    if (shapeKind === 'circle' && branding.style === 'outline') {
      // Curved text along a half-width arc on the rim.
      const cx = W/2, cy = H/2, rT = minD/2 * 0.50;
      const d = isTop
        ? `M ${cx-rT},${cy} A ${rT},${rT} 0 0 1 ${cx+rT},${cy}`
        : `M ${cx+rT},${cy} A ${rT},${rT} 0 0 1 ${cx-rT},${cy}`;
      defs.appendChild(el('path', { id: 'brand-arc', d, fill: 'none' }));
      const t = el('text', {
        'font-family': IMPACT_FONT, 'font-weight': 'bold', 'font-size': fs * 0.92,
        fill: STAMP_GREEN,
      });
      const tp = el('textPath', { href: '#brand-arc', startOffset: '50%', 'text-anchor': 'middle' });
      tp.textContent = txt;
      t.appendChild(tp);
      g.appendChild(t);
    } else if (branding.style === 'banner') {
      // Solid bar (half-width, centered) with reversed-out white text.
      const bh = fs * 1.5;
      const by = isTop ? 0 : H - bh;
      const bw = W / 2;                  // half the shape width
      const bx = (W - bw) / 2;           // centered
      g.appendChild(el('rect', { x: bx, y: by, width: bw, height: bh, fill: GREEN_PARTY }));
      const t = el('text', {
        x: W/2, y: by + bh/2, 'text-anchor': 'middle', 'dominant-baseline': 'central',
        'font-family': IMPACT_FONT, 'font-weight': 'bold', 'font-size': fs, fill: '#fff',
      });
      t.textContent = txt;
      g.appendChild(t);
    } else {
      // Straight Impact-outline text — half-width stamp, centered on the edge.
      const padY = (shapeKind === 'hexagon' ? 0.16 : 0.05) * H;
      const y = isTop ? padY + fs : H - padY;
      const t = el('text', {
        x: W/2, y, 'text-anchor': 'middle',
        'font-family': IMPACT_FONT, 'font-weight': 'bold', 'font-size': fs,
        fill: STAMP_GREEN,
      });
      t.textContent = txt;
      g.appendChild(t);
    }
  }

  // Attribution is shown in the app status bar, not baked into generated files.

  return svg as SVGSVGElement;
}

export function svgToString(svgEl: SVGSVGElement): string {
  return new XMLSerializer().serializeToString(svgEl);
}

export function svgToBlobUrl(svgEl: SVGSVGElement): string {
  const blob = new Blob([svgToString(svgEl)], { type: 'image/svg+xml' });
  return URL.createObjectURL(blob);
}
