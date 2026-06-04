import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { renderSvg, svgToString, svgToBlobUrl, SVG_SPECS } from './svg-renderer';
import { Status } from './status';

Cesium.Ion.defaultAccessToken = '';

// ---------------------------------------------------------------------------
// Viewer
// ---------------------------------------------------------------------------
const viewer = new Cesium.Viewer('cesiumContainer', {
  imageryProvider: false as unknown as Cesium.ImageryProvider,
  terrainProvider: new Cesium.EllipsoidTerrainProvider(),
  baseLayerPicker: false as unknown as boolean, geocoder: false as unknown as boolean,
  homeButton: false as unknown as boolean, sceneModePicker: false as unknown as boolean,
  navigationHelpButton: false as unknown as boolean, animation: false as unknown as boolean,
  timeline: false as unknown as boolean, fullscreenButton: false as unknown as boolean,
  selectionIndicator: false as unknown as boolean, infoBox: false as unknown as boolean,
  contextOptions: { webgl: { preserveDrawingBuffer: true } },
} as unknown as Cesium.Viewer.ConstructorOptions);

viewer.imageryLayers.addImageryProvider(new Cesium.UrlTemplateImageryProvider({
  url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  credit: '© OpenStreetMap contributors', maximumLevel: 19,
}));

viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#1a1a24');
viewer.scene.backgroundColor = Cesium.Color.fromCssColorString('#0a0a0a');
viewer.scene.globe.translucency.enabled = false;
viewer.camera.constrainedAxis = Cesium.Cartesian3.UNIT_Z;
viewer.scene.screenSpaceCameraController.maximumZoomDistance = 20_000_000;
viewer.scene.screenSpaceCameraController.minimumZoomDistance = 100;

const PITCH_MAX = -(Math.PI * 20) / 180, PITCH_MIN = -Math.PI / 2;
let _validCam = { position: viewer.camera.position.clone(), pitch: viewer.camera.pitch };
viewer.scene.postRender.addEventListener(() => {
  const p = viewer.camera.pitch;
  const h = viewer.camera.heading;
  // Lock heading to north — snap back if user rotated the globe
  if (Math.abs(h) > 1e-4) {
    viewer.camera.setView({
      destination: viewer.camera.position.clone(),
      orientation: { heading: 0, pitch: p, roll: 0 },
    });
    return;
  }
  if (p > PITCH_MAX || p < PITCH_MIN) {
    viewer.camera.setView({ destination: _validCam.position.clone(),
      orientation: { heading: 0, pitch: _validCam.pitch, roll: 0 } });
  } else {
    _validCam = { position: viewer.camera.position.clone(), pitch: p };
  }
});

// Wakefield council area — top-down flat start, ~50 km altitude
viewer.camera.setView({
  destination: Cesium.Cartesian3.fromDegrees(-1.49, 53.68, 50_000),
  orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
});
_validCam = { position: viewer.camera.position.clone(), pitch: viewer.camera.pitch };

// ---------------------------------------------------------------------------
// Selection state — rotated rectangle stored as centre + half-dims + angle
// ---------------------------------------------------------------------------
type BBox  = { north: number; south: number; east: number; west: number };
type Corner = 'nw' | 'ne' | 'se' | 'sw';
// RotSel: cx/cy = centre lon/lat, hw/hh = half-width/height in °lon/°lat, rot = radians CW from north
type RotSel = { cx: number; cy: number; hw: number; hh: number; rot: number };

const CORNERS: Corner[] = ['nw', 'ne', 'se', 'sw'];
const MERCH_RATIO: Record<string, number> = {
  tshirt: 3000/4000, mug: 2700/900, placemat: 4200/3000,
  coaster: 1, tote: 2000/3000, '3d_print': 1,
};

let confirmed: RotSel | null = null;
let _live: RotSel | null = null;
let editState: 'idle' | 'drawing' | 'editing' = 'idle';
let merchType = 'tshirt';

// Coaster shape cycling
const COASTER_SHAPES = ['square', 'circle', 'hexagon'] as const;
type CoasterShape = typeof COASTER_SHAPES[number];
const COASTER_ICONS: Record<CoasterShape, string>  = { square: '⬜', circle: '⬤', hexagon: '⬡' };
const COASTER_LABELS: Record<CoasterShape, string> = { square: 'Square', circle: 'Circle', hexagon: 'Hexagon' };
let coasterShapeIdx = 0;
let coasterShape: CoasterShape = 'square';

// ---------------------------------------------------------------------------
// Auto save-name — "Place — Merch (Shape)"; the #NN is derived at display time
// (see displayName), so the stored name carries no number and identity is the id.
// ---------------------------------------------------------------------------
const MERCH_LABELS: Record<string, string> = {
  tshirt: 'T-Shirt', mug: 'Mug', tote: 'Tote Bag',
  coaster: 'Coaster', placemat: 'Placemat', '3d_print': 'Relief',
};
// Only merch with more than one shape get a (Shape) token — today just the coaster.
function merchHasVariableShape(m: string): boolean { return m === 'coaster'; }

// Most-specific place from the reverse-geocode pre-flight, set in generate().
let lastPlaceLabel: string | null = null;

function placeLabel(): string {
  if (lastPlaceLabel) return lastPlaceLabel;
  const typed = (document.getElementById('place-search') as HTMLInputElement | null)?.value.trim();
  return typed || '';
}

function buildBaseName(): string {
  const merch = MERCH_LABELS[merchType] ?? merchType;
  const shape = merchHasVariableShape(merchType) ? ` (${COASTER_LABELS[coasterShape]})` : '';
  const place = placeLabel();
  return place ? `${place} — ${merch}${shape}` : `${merch}${shape}`;
}

// Show the auto-generated name (read-only) above a panel's Save button.
function setSaveNamePreview(id: string): void {
  const el = document.getElementById(id);
  if (el) el.textContent = buildBaseName();
}

// Compose the displayed name: append a 2-digit ordinal only when ≥2 saves share the
// same stored base name. A lone save shows no number ("start without one at all").
function displayName(p: any, all: any[]): string {
  const group = all.filter(x => x.name === p.name)
                   .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  if (group.length < 2) return p.name;
  const idx = group.findIndex(x => x.id === p.id);
  return `${p.name} #${String(idx + 1).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// RotSel geometry
// ---------------------------------------------------------------------------
function rotSelCorners(s: RotSel): { lon: number; lat: number }[] {
  const cosL = Math.cos(s.cy * Math.PI / 180);
  const ca = Math.cos(s.rot), sa = Math.sin(s.rot);
  return ([ [-s.hw, s.hh], [s.hw, s.hh], [s.hw, -s.hh], [-s.hw, -s.hh] ] as [number,number][])
    .map(([dx, dy]) => {
      const ix = dx * cosL, iy = dy;      // isotropic space
      const rx = ix * ca - iy * sa;       // rotate
      const ry = ix * sa + iy * ca;
      return { lon: s.cx + rx / cosL, lat: s.cy + ry }; // back to deg
    });
}

function selCirclePoints(s: RotSel, n = 64): { lon: number; lat: number }[] {
  const cosL = Math.cos(s.cy * Math.PI / 180);
  const r = s.hh;
  return Array.from({ length: n }, (_, i) => {
    const a = s.rot + (Math.PI * 2 * i) / n;
    return { lon: s.cx + Math.sin(a) * r / cosL, lat: s.cy + Math.cos(a) * r };
  });
}

function selHexagonPoints(s: RotSel): { lon: number; lat: number }[] {
  const cosL = Math.cos(s.cy * Math.PI / 180);
  const r = s.hh;
  return Array.from({ length: 6 }, (_, i) => {
    const a = s.rot + (Math.PI * 2 * i) / 6 + Math.PI / 6;
    return { lon: s.cx + Math.sin(a) * r / cosL, lat: s.cy + Math.cos(a) * r };
  });
}

function selShapePoints(s: RotSel): { lon: number; lat: number }[] {
  if (merchType === 'coaster') {
    if (coasterShape === 'circle')  return selCirclePoints(s);
    if (coasterShape === 'hexagon') return selHexagonPoints(s);
  }
  return rotSelCorners(s);
}

// The actual rendered shape of the current selection — drives the true-area maths so the
// 0→MAX_AREA_KM2 scale measures the real shape, not its bounding box. Circle & hexagon are
// radial (defined by a single radius = half-height); everything else is a ratio'd rect.
const HEX_AREA_K = 3 * Math.sqrt(3) / 2;  // regular-hexagon area = K · circumradius²
function selShapeKind(): 'circle' | 'hexagon' | 'rect' {
  if (merchType === 'coaster') {
    if (coasterShape === 'circle')  return 'circle';
    if (coasterShape === 'hexagon') return 'hexagon';
  }
  return 'rect';
}

function rotSelAabb(s: RotSel): BBox {
  const c = rotSelCorners(s);
  return {
    west:  Math.min(...c.map(p => p.lon)), east:  Math.max(...c.map(p => p.lon)),
    south: Math.min(...c.map(p => p.lat)), north: Math.max(...c.map(p => p.lat)),
  };
}

function bboxToRotSel(b: BBox): RotSel {
  return { cx: (b.west+b.east)/2, cy: (b.south+b.north)/2,
           hw: (b.east-b.west)/2, hh: (b.north-b.south)/2, rot: 0 };
}

function cornerOf(c: Corner, s: RotSel): { lon: number; lat: number } {
  const idx = { nw:0, ne:1, se:2, sw:3 }[c];
  return rotSelCorners(s)[idx];
}

// Apply the merch aspect ratio while drawing/resizing: expand the short axis to match,
// then cap the TRUE shape area at MAX_AREA_KM2. (Switching merch/shape preserves area
// instead — see selectMerch / stepCoasterShape, which capture the area first.)
// selAreaKm2 and shapeForArea are hoisted function declarations defined further below.
function enforceRatio(s: RotSel, ratio: number): RotSel {
  const cosL = Math.cos(s.cy * Math.PI / 180);
  const wM = s.hw * cosL * 111_320 * 2, hM = s.hh * 111_320 * 2;
  const next: RotSel = (wM / hM > ratio)
    ? { ...s, hh: (wM / ratio) / 111_320 / 2 }
    : { ...s, hw: (hM * ratio) / (cosL * 111_320) / 2 };
  return selAreaKm2(next) > MAX_AREA_KM2 ? shapeForArea(next, ratio, MAX_AREA_KM2) : next;
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------
const canvas = viewer.scene.canvas;
const handler = new Cesium.ScreenSpaceEventHandler(canvas);

const selEntity = viewer.entities.add({
  show: false,
  polygon: {
    hierarchy: new Cesium.CallbackProperty(() => {
      if (!_live) return null;
      const positions = selShapePoints(_live).map(c => Cesium.Cartesian3.fromDegrees(c.lon, c.lat));
      return new Cesium.PolygonHierarchy(positions);
    }, false),
    material: Cesium.Color.fromCssColorString('#4a9eff').withAlpha(0.15),
    height: 0,
  } as unknown as Cesium.PolygonGraphics,
  polyline: {
    positions: new Cesium.CallbackProperty(() => {
      if (!_live) return [];
      const c = selShapePoints(_live);
      return [...c, c[0]].map(p => Cesium.Cartesian3.fromDegrees(p.lon, p.lat));
    }, false),
    width: 2,
    material: new Cesium.ColorMaterialProperty(Cesium.Color.fromCssColorString('#4a9eff')),
    clampToGround: true,
  },
});

// Hover state drives handle colours via CallbackProperty
let hovResize: Corner | null = null;
let hovRotate: Corner | null = null;

function makeResizeHandle(c: Corner): Cesium.Entity {
  return viewer.entities.add({
    show: false,
    position: new Cesium.CallbackProperty(() => {
      if (!_live) return Cesium.Cartesian3.ZERO;
      const p = cornerOf(c, _live);
      return Cesium.Cartesian3.fromDegrees(p.lon, p.lat);
    }, false) as unknown as Cesium.PositionProperty,
    point: {
      pixelSize: 11,
      color: new Cesium.CallbackProperty(() =>
        hovResize === c ? Cesium.Color.fromCssColorString('#4a9eff') : Cesium.Color.WHITE, false),
      outlineColor: Cesium.Color.fromCssColorString('#4a9eff'),
      outlineWidth: 2,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  });
}

// Rotate handle: same corner position but rendered as a ring billboard, offset outward 22px
function makeRotateHandle(c: Corner): Cesium.Entity {
  return viewer.entities.add({
    show: false,
    position: new Cesium.CallbackProperty(() => {
      if (!_live) return Cesium.Cartesian3.ZERO;
      const p = cornerOf(c, _live);
      return Cesium.Cartesian3.fromDegrees(p.lon, p.lat);
    }, false) as unknown as Cesium.PositionProperty,
    billboard: {
      image: makeRotateCursorCanvas(),
      pixelOffset: new Cesium.Cartesian2(
        c.includes('e') ? 18 : -18,
        c.includes('s') ? 18 : -18,
      ),
      color: new Cesium.CallbackProperty(() =>
        hovRotate === c ? Cesium.Color.fromCssColorString('#4a9eff') : Cesium.Color.WHITE.withAlpha(0.9), false),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      scale: 1,
    },
  });
}

function makeRotateCursorCanvas(): HTMLCanvasElement {
  const s = 22;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d')!;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2.5;
  // Draw arc (270° arc = 3/4 circle)
  ctx.beginPath();
  ctx.arc(s/2, s/2, s/2 - 3, -Math.PI * 0.75, Math.PI * 0.5);
  ctx.stroke();
  // Arrow head
  const ex = s/2 + (s/2 - 3) * Math.cos(Math.PI * 0.5);
  const ey = s/2 + (s/2 - 3) * Math.sin(Math.PI * 0.5);
  ctx.beginPath();
  ctx.moveTo(ex - 4, ey - 4);
  ctx.lineTo(ex, ey);
  ctx.lineTo(ex + 4, ey - 4);
  ctx.stroke();
  return cv;
}

const resizeHandles = Object.fromEntries(CORNERS.map(c => [c, makeResizeHandle(c)])) as Record<Corner, Cesium.Entity>;
const rotateHandles = Object.fromEntries(CORNERS.map(c => [c, makeRotateHandle(c)])) as Record<Corner, Cesium.Entity>;

function showHandles(show: boolean): void {
  CORNERS.forEach(c => { resizeHandles[c].show = show; rotateHandles[c].show = show; });
}

// ---------------------------------------------------------------------------
// Picking & hover zones
// ---------------------------------------------------------------------------
const INNER_PX = 14, OUTER_PX = 30;

function pickLatLon(pos: Cesium.Cartesian2): { lon: number; lat: number } | null {
  const ray = viewer.camera.getPickRay(pos);
  if (!ray) return null;
  const hit = viewer.scene.globe.pick(ray, viewer.scene);
  if (!hit) return null;
  const c = Cesium.Cartographic.fromCartesian(hit);
  return { lon: Cesium.Math.toDegrees(c.longitude), lat: Cesium.Math.toDegrees(c.latitude) };
}

function worldToScreen(lon: number, lat: number): Cesium.Cartesian2 | null {
  return Cesium.SceneTransforms.worldToWindowCoordinates(viewer.scene,
    Cesium.Cartesian3.fromDegrees(lon, lat)) ?? null;
}

type HoverZone = { type: 'none' } | { type: 'inside' } | { type: 'resize'; corner: Corner } | { type: 'rotate'; corner: Corner };

function getZone(screenPos: Cesium.Cartesian2): HoverZone {
  if (!_live) return { type: 'none' };
  for (const c of CORNERS) {
    const p = cornerOf(c, _live);
    const sc = worldToScreen(p.lon, p.lat);
    if (!sc) continue;
    const d = Math.hypot(screenPos.x - sc.x, screenPos.y - sc.y);
    if (d <= INNER_PX)  return { type: 'resize', corner: c };
    if (d <= OUTER_PX)  return { type: 'rotate', corner: c };
  }
  const w = pickLatLon(screenPos);
  if (w && _live) {
    if (pointInPolygon(w.lon, w.lat, selShapePoints(_live))) return { type: 'inside' };
  }
  return { type: 'none' };
}

function pointInPolygon(lon: number, lat: number, poly: { lon: number; lat: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].lon, yi = poly[i].lat, xj = poly[j].lon, yj = poly[j].lat;
    if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

const CURSOR: Record<Corner, string> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize' };
function setCursor(c: string) { canvas.style.cursor = c; }

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------
function enterDrawing(): void {
  editState = 'drawing';
  confirmed = null; _live = null;
  selEntity.show = false; showHandles(false);
  viewer.scene.screenSpaceCameraController.enableRotate = false;
  setCursor('crosshair');
  const genBtn = document.getElementById('generate-btn') as HTMLButtonElement;
  genBtn.disabled = true; genBtn.onclick = generate;
  document.getElementById('bbox-display')!.textContent = 'Left-drag on the map to draw your area';
  document.getElementById('status')!.textContent = '';

  let anchor: { lon: number; lat: number } | null = null;

  handler.setInputAction((e: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
    anchor = pickLatLon(e.position);
    if (anchor) selEntity.show = true;
  }, Cesium.ScreenSpaceEventType.LEFT_DOWN);

  handler.setInputAction((e: Cesium.ScreenSpaceEventHandler.MotionEvent) => {
    if (!anchor) return;
    const cur = pickLatLon(e.endPosition);
    if (!cur) return;
    const raw = bboxToRotSel({
      west: Math.min(anchor.lon, cur.lon), east: Math.max(anchor.lon, cur.lon),
      south: Math.min(anchor.lat, cur.lat), north: Math.max(anchor.lat, cur.lat),
    });
    _live = enforceRatio({ ...raw, cx: anchor.lon + (cur.lon - anchor.lon)/2,
                                   cy: anchor.lat + (cur.lat - anchor.lat)/2 }, MERCH_RATIO[merchType] ?? 1);
    updateBboxDisplay();
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

  handler.setInputAction((_e: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
    if (!anchor || !_live) { anchor = null; return; }
    const result = { ..._live };
    anchor = null;
    clearHandlers();
    enterEditing(result);
  }, Cesium.ScreenSpaceEventType.LEFT_UP);
}

function clearHandlers(): void {
  handler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_DOWN);
  handler.removeInputAction(Cesium.ScreenSpaceEventType.MOUSE_MOVE);
  handler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_UP);
  viewer.scene.screenSpaceCameraController.enableRotate = true;
}

// ---------------------------------------------------------------------------
// Editing — single handler set, dragMode controls behaviour
// ---------------------------------------------------------------------------
type DragMode = 'none' | 'move' | { kind: 'resize'; corner: Corner } | { kind: 'rotate'; corner: Corner };
let dragMode: DragMode = 'none';
let dragMoveAnchor: { lon: number; lat: number } | null = null;
let dragMoveStart: RotSel | null = null;
let dragResizeFixed: { lon: number; lat: number } | null = null;
let dragRotStart: RotSel | null = null;
let dragRotAnchorAngle = 0;

function enterEditing(s: RotSel): void {
  editState = 'editing';
  confirmed = { ...s }; _live = { ...s };
  selEntity.show = true; showHandles(true);
  viewer.scene.screenSpaceCameraController.enableRotate = true;
  setCursor('default'); updateBboxDisplay();
  const genBtn = document.getElementById('generate-btn') as HTMLButtonElement;
  genBtn.onclick = generate;

  handler.setInputAction((e: Cesium.ScreenSpaceEventHandler.MotionEvent) => {
    if (editState !== 'editing') return;

    // Active drag
    if (dragMode !== 'none') {
      const cur = pickLatLon(e.endPosition);
      if (!cur || !_live) return;

      if (dragMode === 'move' && dragMoveAnchor && dragMoveStart) {
        _live = { ...dragMoveStart,
          cx: dragMoveStart.cx + cur.lon - dragMoveAnchor.lon,
          cy: dragMoveStart.cy + cur.lat - dragMoveAnchor.lat,
        };
      } else if (typeof dragMode === 'object' && dragMode.kind === 'resize' && dragResizeFixed) {
        // Project mouse into rotated frame, compute new half-dims
        const cosL = Math.cos(_live.cy * Math.PI / 180);
        const ca = Math.cos(-_live.rot), sa = Math.sin(-_live.rot);
        const dx = (cur.lon - _live.cx) * cosL;
        const dy = cur.lat - _live.cy;
        const px = (dx * ca - dy * sa) / cosL;  // projected onto W axis
        const py = dx * sa + dy * ca;            // projected onto H axis
        let hw = Math.abs(px), hh = Math.abs(py);
        const ratio = MERCH_RATIO[merchType] ?? 1;
        const wM = hw * cosL * 111_320, hM = hh * 111_320;
        if (wM / hM > ratio) hh = wM / ratio / 111_320; else hw = hM * ratio / (cosL * 111_320);
        let next: RotSel = { ..._live, hw, hh };
        // Hard cap: cannot resize beyond MAX_AREA_KM2 — clamp to the ratio-correct max rect.
        if (selAreaKm2(next) > MAX_AREA_KM2) next = shapeForArea(next, ratio, MAX_AREA_KM2);
        _live = next;
      } else if (typeof dragMode === 'object' && dragMode.kind === 'rotate' && dragRotStart) {
        const cosL = Math.cos(dragRotStart.cy * Math.PI / 180);
        const angle = Math.atan2((cur.lon - dragRotStart.cx) * cosL, cur.lat - dragRotStart.cy);
        _live = { ...dragRotStart, rot: dragRotStart.rot + (angle - dragRotAnchorAngle) };
        dragRotAnchorAngle = angle;
        dragRotStart = { ..._live };
      }
      updateBboxDisplay();
      return;
    }

    // Hover — update cursor and handle highlights
    const zone = getZone(e.endPosition);
    hovResize = zone.type === 'resize' ? zone.corner : null;
    hovRotate = zone.type === 'rotate' ? zone.corner : null;
    if (zone.type === 'resize')      setCursor(CURSOR[zone.corner]);
    else if (zone.type === 'rotate') setCursor('alias');
    else if (zone.type === 'inside') setCursor('move');
    else                             setCursor('default');
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

  handler.setInputAction((e: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
    if (editState !== 'editing' || !_live) return;
    const zone = getZone(e.position);
    if (zone.type === 'none') return;
    viewer.scene.screenSpaceCameraController.enableRotate = false;

    if (zone.type === 'inside') {
      dragMode = 'move';
      dragMoveAnchor = pickLatLon(e.position);
      dragMoveStart = { ..._live };
    } else if (zone.type === 'resize') {
      dragMode = { kind: 'resize', corner: zone.corner };
      const opp: Corner = zone.corner === 'nw' ? 'se' : zone.corner === 'ne' ? 'sw' : zone.corner === 'se' ? 'nw' : 'ne';
      dragResizeFixed = cornerOf(opp, _live);
    } else if (zone.type === 'rotate') {
      const cosL = Math.cos(_live.cy * Math.PI / 180);
      const clicked = pickLatLon(e.position);
      if (!clicked) return;
      dragMode = { kind: 'rotate', corner: zone.corner };
      dragRotStart = { ..._live };
      dragRotAnchorAngle = Math.atan2((clicked.lon - _live.cx) * cosL, clicked.lat - _live.cy);
    }
  }, Cesium.ScreenSpaceEventType.LEFT_DOWN);

  handler.setInputAction((_e: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
    if (dragMode === 'none') return;
    confirmed = _live ? { ..._live } : null;
    clearGeneratedState();
    dragMode = 'none'; dragMoveAnchor = null; dragMoveStart = null;
    dragResizeFixed = null; dragRotStart = null;
    viewer.scene.screenSpaceCameraController.enableRotate = true;
  }, Cesium.ScreenSpaceEventType.LEFT_UP);
}

function exitEditing(): void {
  clearHandlers();
  dragMode = 'none'; hovResize = null; hovRotate = null;
  selEntity.show = false; _live = null; showHandles(false);
  setCursor('default');
}

const MAX_AREA_KM2 = 100;

// True area of the actual rendered shape (rotation-invariant), in km². Circle/hexagon use
// their radius (= half-height); rect uses w·h. So the cap and the readout measure the real
// shape, and circle/hex/square all cover the SAME km² at a given scale setting.
function selAreaKm2(sel: RotSel): number {
  const kind = selShapeKind();
  const rM = sel.hh * 111_320;  // radial shapes: radius = half-height in metres
  if (kind === 'circle')  return (Math.PI * rM * rM) / 1e6;
  if (kind === 'hexagon') return (HEX_AREA_K * rM * rM) / 1e6;
  const cosLat = Math.cos(sel.cy * Math.PI / 180);
  const wM = sel.hw * cosLat * 111_320 * 2, hM = sel.hh * 111_320 * 2;
  return (wM * hM) / 1e6;
}

// Half-dims for a selection of the given TRUE area (km²) under the current shape, at the
// selection's latitude. The basis for the 0→MAX_AREA_KM2 scale: every shape (any rect
// ratio, circle, hexagon) is re-derived to hit the same real area.
function shapeForArea(sel: RotSel, ratio: number, areaKm2: number): RotSel {
  const cosL = Math.cos(sel.cy * Math.PI / 180);
  const areaM2 = Math.max(areaKm2, 0) * 1e6;
  const kind = selShapeKind();
  if (kind === 'circle' || kind === 'hexagon') {
    // Solve radius from the shape's area formula; bounding box is a square (hw=hh in m).
    const rM = Math.sqrt(areaM2 / (kind === 'circle' ? Math.PI : HEX_AREA_K));
    return { ...sel, hw: rM / (cosL * 111_320), hh: rM / 111_320 };
  }
  const hM = Math.sqrt(areaM2 / ratio);
  const wM = ratio * hM;
  return { ...sel, hw: wM / 2 / (cosL * 111_320), hh: hM / 2 / 111_320 };
}

function updateBboxDisplay(): void {
  if (!_live) return;
  const b = rotSelAabb(_live);
  const km2 = selAreaKm2(_live);
  const overLimit = km2 > MAX_AREA_KM2;
  document.getElementById('bbox-display')!.innerHTML =
    `N:&nbsp;${b.north.toFixed(4)} &nbsp; S:&nbsp;${b.south.toFixed(4)}<br>` +
    `E:&nbsp;${b.east.toFixed(4)} &nbsp; W:&nbsp;${b.west.toFixed(4)}` +
    (_live.rot !== 0 ? ` &nbsp; ↻&nbsp;${(_live.rot * 180 / Math.PI).toFixed(1)}°` : '') +
    `<br><span style="color:${overLimit ? '#ff6060' : '#888'}">${Math.round(km2 * 10) / 10}&nbsp;km²${overLimit ? ' — max 100km²' : ''}</span>`;
  const genBtn = document.getElementById('generate-btn') as HTMLButtonElement;
  if (overLimit) genBtn.disabled = true;
  else if (confirmed) genBtn.disabled = false;
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------
function clearGeneratedState(): void {
  if (svgCurrentUrl.startsWith('blob:')) URL.revokeObjectURL(svgCurrentUrl);
  _cachedSvgResult = null;
  _cachedOsmData = null;
  svgCurrentStl = null;
  svgCurrentUrl = '';
  svgCurrentText = '';

  document.getElementById('viewer-3d-view')!.style.display = 'none';

  if (svgView.style.display !== 'none') {
    svgView.style.display = 'none';
    document.getElementById('svg-save-section')!.style.display = 'none';
    (document.getElementById('svg-save-status') as HTMLElement).textContent = '';
    document.getElementById('panel')!.style.visibility = 'visible';
    const ov = document.getElementById('transition-overlay') as HTMLCanvasElement;
    ov.style.display = 'none'; ov.style.opacity = '1'; ov.style.transition = '';
    _transFrame = null; _transSel = null; _transPixCanvas = null;
    _transFitBounds = null; _transSvgImg = null;
  }

  const _btn = document.getElementById('generate-btn') as HTMLButtonElement;
  (document.getElementById('btn-text') as HTMLElement).textContent = 'Generate Design';
  (document.getElementById('spinner') as HTMLElement).style.display = 'none';
  _btn.disabled = !confirmed || !!(confirmed && selAreaKm2(confirmed) > MAX_AREA_KM2);
  _btn.onclick = generate;
}

function selectMerch(el: HTMLElement): void {
  const newType = el.dataset.type!;
  const sameType = newType === merchType;
  // Capture the current TRUE shape area before the merch type (and thus shape) changes.
  const prevArea = (editState === 'editing' && _live) ? selAreaKm2(_live) : null;
  document.querySelectorAll('.merch-btn').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  merchType = newType;

  clearGeneratedState();

  if (editState === 'editing' && !sameType && prevArea !== null) {
    // Different merch: re-shape the SAME real area under the new ratio/shape — never grow
    // an axis. So a 100 km² placemat → a 100 km² coaster (square / circle / hexagon).
    _live = shapeForArea(_live!, MERCH_RATIO[merchType] ?? 1, Math.min(prevArea, MAX_AREA_KM2));
    confirmed = { ..._live };
    updateBboxDisplay();
  } else {
    // No selection, or re-clicking active type: start/restart drawing
    if (editState === 'editing') exitEditing();
    else if (editState === 'drawing') { clearHandlers(); editState = 'idle'; }
    enterDrawing();
  }
}

// ---------------------------------------------------------------------------
// SVG-viewer layout geometry — landing rect for the inline SVG view transition
// ---------------------------------------------------------------------------
const SVG_PANEL_W = 272;

function getSvgViewerFitBounds(
  W: number, H: number, ratio: number,
): { x: number; y: number; w: number; h: number } {
  const vw = W - SVG_PANEL_W, m = 40;
  let svgW: number, svgH: number;
  if ((vw - m * 2) / (H - m * 2) > ratio) {
    svgH = H - m * 2; svgW = svgH * ratio;
  } else {
    svgW = vw - m * 2; svgH = svgW / ratio;
  }
  return { x: SVG_PANEL_W + (vw - svgW) / 2, y: (H - svgH) / 2, w: svgW, h: svgH };
}

function estimateGenMs(bbox: BBox): number {
  const cosL = Math.cos((bbox.north + bbox.south) / 2 * Math.PI / 180);
  const km2 = (bbox.east - bbox.west) * cosL * 111.32 * (bbox.north - bbox.south) * 111.32;
  return Math.min(30_000, 1_000 + km2 * 1_200);
}

async function fetchEstimate(bbox: BBox, merchType: string): Promise<{
  osm_estimate_ms: number; svg_estimate_ms: number; stl_estimate_ms: number;
  area_km2: number; element_count: number; complexity: string;
} | null> {
  try {
    const r = await fetch('/api/estimate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bbox, merch_type: merchType }),
    });
    if (r.ok) return r.json();
  } catch { /* ignore */ }
  return null;
}

// ---------------------------------------------------------------------------
// Transition animation helpers
// ---------------------------------------------------------------------------
function loadImg(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = src;
  });
}

function animPhase(ms: number, cb: (t: number) => void): Promise<void> {
  return new Promise(res => {
    const t0 = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - t0) / ms);
      cb(t);
      if (t < 1) requestAnimationFrame(tick); else res();
    };
    requestAnimationFrame(tick);
  });
}

function getSelAabb(): { x: number; y: number; w: number; h: number } | null {
  if (!confirmed) return null;
  const pts = selShapePoints(confirmed)
    .map(c => worldToScreen(c.lon, c.lat))
    .filter((p): p is Cesium.Cartesian2 => !!p);
  if (pts.length < 3) return null;
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

function drawTransFrame(
  ctx: CanvasRenderingContext2D,
  frame: HTMLImageElement,
  W: number, H: number,
  sel: { x: number; y: number; w: number; h: number } | null,
  darkAlpha: number, pixelSize: number,
): void {
  ctx.drawImage(frame, 0, 0, W, H);
  if (!sel) return;
  const { x, y, w, h } = sel;
  if (pixelSize > 1) {
    const tmp = document.createElement('canvas');
    tmp.width  = Math.max(1, Math.round(w / pixelSize));
    tmp.height = Math.max(1, Math.round(h / pixelSize));
    const t = tmp.getContext('2d')!;
    t.drawImage(frame, x, y, w, h, 0, 0, tmp.width, tmp.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, x, y, w, h);
    ctx.imageSmoothingEnabled = true;
  }
  if (darkAlpha > 0) {
    ctx.fillStyle = `rgba(0,0,0,${darkAlpha})`;
    ctx.fillRect(0, 0, W, y);
    ctx.fillRect(0, y, x, h);
    ctx.fillRect(x + w, y, W - x - w, h);
    ctx.fillRect(0, y + h, W, H - y - h);
  }
}

async function runTransition(
  svgP: Promise<any>,
  estimatedMs = 6_000,
): Promise<any> {
  const ov  = document.getElementById('transition-overlay') as HTMLCanvasElement;
  const ctx = ov.getContext('2d')!;
  const W = window.innerWidth, H = window.innerHeight;
  ov.width = W; ov.height = H;

  ov.style.display = 'block';
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);

  let frame: HTMLImageElement | null = null;
  try {
    viewer.render();
    frame = await loadImg((viewer.scene.canvas as HTMLCanvasElement).toDataURL('image/jpeg', 0.85));
  } catch { }
  _transFrame = frame;

  const sel = getSelAabb();
  _transSel = sel;
  const fitBounds = getSvgViewerFitBounds(W, H, MERCH_RATIO[merchType] ?? 1);
  _transFitBounds = fitBounds;

  const PEAK_DIV = 20;
  const sx = sel?.x ?? 0, sy = sel?.y ?? 0, sw = sel?.w ?? W, sh = sel?.h ?? H;

  // Full-res snapshot of the selection area — downsampled per-frame for pixelation
  const selSnap = document.createElement('canvas');
  selSnap.width  = Math.max(1, Math.round(sw));
  selSnap.height = Math.max(1, Math.round(sh));
  if (frame) {
    const sCtx = selSnap.getContext('2d')!;
    if (sel) sCtx.drawImage(frame, sx, sy, sw, sh, 0, 0, sw, sh);
    else     sCtx.drawImage(frame, 0, 0, W, H);
  }

  // Peak-pixelated selection snapshot kept for reverse transition
  const pixCanvas = document.createElement('canvas');
  pixCanvas.width  = Math.max(1, Math.round(sw / PEAK_DIV));
  pixCanvas.height = Math.max(1, Math.round(sh / PEAK_DIV));
  if (frame) {
    const pc = pixCanvas.getContext('2d')!;
    if (sel) pc.drawImage(frame, sx, sy, sw, sh, 0, 0, pixCanvas.width, pixCanvas.height);
    else     pc.drawImage(frame, 0, 0, W, H, 0, 0, pixCanvas.width, pixCanvas.height);
  }
  _transPixCanvas = pixCanvas;

  let svgDone = false, svgResult: any = null, svgError: any = null;
  svgP.then(r => { svgResult = r; }).catch(e => { svgError = e; }).finally(() => { svgDone = true; });

  const scratch = document.createElement('canvas');
  const scratchCtx = scratch.getContext('2d')!;

  Status.begin('Generating map…');
  // Time constant for asymptotic approach — animation stays in perpetual motion
  const TAU = 600;
  const t0 = performance.now();

  await new Promise<void>(resolve => {
    function loop(ts: number) {
      const elapsed = ts - t0;
      // Single t (0→1) drives both zoom position and pixelation simultaneously
      const t = 1 - Math.exp(-elapsed / TAU);

      // Dest rect interpolated sel → fitBounds
      const dx = sx + (fitBounds.x - sx) * t;
      const dy = sy + (fitBounds.y - sy) * t;
      const dw = sw + (fitBounds.w - sw) * t;
      const dh = sh + (fitBounds.h - sh) * t;

      // Block size: 1 (sharp) at t=0 → PEAK_DIV (blocky) at t=1
      const blockSize = 1 + (PEAK_DIV - 1) * t;
      const bW = Math.max(1, Math.round(sw / blockSize));
      const bH = Math.max(1, Math.round(sh / blockSize));

      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = '#0d0e12';
      ctx.fillRect(0, 0, W, H);

      if (frame) {
        // Full globe frame fades out as t crosses 0→0.3
        const fadeAlpha = Math.max(0, 1 - t / 0.3);
        if (fadeAlpha > 0) {
          ctx.globalAlpha = fadeAlpha;
          ctx.drawImage(frame, 0, 0, W, H);
          ctx.globalAlpha = 1;
        }
      }

      // Selection snapshot: zooms from sel to fitBounds, pixelates as t grows
      if (scratch.width !== bW || scratch.height !== bH) {
        scratch.width = bW; scratch.height = bH;
      }
      scratchCtx.drawImage(selSnap, 0, 0, bW, bH);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(scratch, 0, 0, bW, bH, dx, dy, dw, dh);
      ctx.imageSmoothingEnabled = true;

      const prog = svgDone ? 1 : Math.min(0.95, elapsed / Math.max(1, estimatedMs));
      Status.set(prog);

      if (svgDone && t >= 0.75) { resolve(); return; }
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
  });

  if (svgError) throw svgError;

  const svgImg = await loadImg(svgResult.svg_url);
  _transSvgImg = svgImg;

  // Dissolve: peak-pixelated sel at fitBounds → SVG at fitBounds (550 ms)
  await animPhase(550, dissolveT => {
    const ease = 1 - Math.pow(1 - dissolveT, 3);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0d0e12'; ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 1 - ease;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(pixCanvas, 0, 0, pixCanvas.width, pixCanvas.height, fitBounds.x, fitBounds.y, fitBounds.w, fitBounds.h);
    ctx.imageSmoothingEnabled = true;
    ctx.globalAlpha = 1;
    ctx.globalAlpha = ease;
    ctx.drawImage(svgImg, fitBounds.x, fitBounds.y, fitBounds.w, fitBounds.h);
    ctx.globalAlpha = 1;
  });

  Status.done();
  return svgResult;
}

async function runReverseTransition(): Promise<void> {
  if (!_transSvgImg || !_transFitBounds) return;

  const ov  = document.getElementById('transition-overlay') as HTMLCanvasElement;
  const ctx = ov.getContext('2d')!;
  const W = window.innerWidth, H = window.innerHeight;
  ov.width = W; ov.height = H;
  ov.style.display = 'block';

  const fitBounds = _transFitBounds;
  const sel = _transSel;
  const frame = _transFrame;
  const pixCanvas = _transPixCanvas;
  const svgImg = _transSvgImg!;
  const PEAK_DIV = 20;

  const sx = sel?.x ?? 0, sy = sel?.y ?? 0, sw = sel?.w ?? W, sh = sel?.h ?? H;

  // Phase R1: SVG fades out, peak-pixelated selection fades in at fitBounds (400 ms)
  await animPhase(400, t => {
    const ease = 1 - Math.pow(1 - t, 3);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0d0e12'; ctx.fillRect(0, 0, W, H);
    if (pixCanvas) {
      ctx.globalAlpha = ease;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(pixCanvas, 0, 0, pixCanvas.width, pixCanvas.height, fitBounds.x, fitBounds.y, fitBounds.w, fitBounds.h);
      ctx.imageSmoothingEnabled = true;
      ctx.globalAlpha = 1;
    }
    ctx.globalAlpha = 1 - ease;
    ctx.drawImage(svgImg, fitBounds.x, fitBounds.y, fitBounds.w, fitBounds.h);
    ctx.globalAlpha = 1;
  });

  // Phase R2: reverse zoom — fitBounds → sel, sharpening as t drops (same TAU, mirrored)
  const selSnap = document.createElement('canvas');
  selSnap.width  = Math.max(1, Math.round(sw));
  selSnap.height = Math.max(1, Math.round(sh));
  if (frame) {
    const sCtx = selSnap.getContext('2d')!;
    if (sel) sCtx.drawImage(frame, sx, sy, sw, sh, 0, 0, sw, sh);
    else     sCtx.drawImage(frame, 0, 0, W, H);
  }

const scratch = document.createElement('canvas');
  const scratchCtx = scratch.getContext('2d')!;
  // 1 second full reverse animation (t reaches 0.08 at ~1035ms with exp decay)
  const TAU_REV = 435;
  const t0 = performance.now();

  await new Promise<void>(resolve => {
    function loop(ts: number) {
      const elapsed = ts - t0;
      // t runs 1→0: blocky/fitBounds at start, sharp/sel at end
      const t = Math.exp(-elapsed / TAU_REV);

      const dx = sx + (fitBounds.x - sx) * t;
      const dy = sy + (fitBounds.y - sy) * t;
      const dw = sw + (fitBounds.w - sw) * t;
      const dh = sh + (fitBounds.h - sh) * t;

      const blockSize = 1 + (PEAK_DIV - 1) * t;
      const bW = Math.max(1, Math.round(sw / blockSize));
      const bH = Math.max(1, Math.round(sh / blockSize));

      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = '#0d0e12'; ctx.fillRect(0, 0, W, H);

      if (frame) {
        // Full globe fades back in as t drops below 0.3
        const fadeAlpha = Math.max(0, 1 - t / 0.3);
        if (fadeAlpha > 0) {
          ctx.globalAlpha = fadeAlpha;
          ctx.drawImage(frame, 0, 0, W, H);
          ctx.globalAlpha = 1;
        }
      }

      if (scratch.width !== bW || scratch.height !== bH) {
        scratch.width = bW; scratch.height = bH;
      }
      scratchCtx.drawImage(selSnap, 0, 0, bW, bH);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(scratch, 0, 0, bW, bH, dx, dy, dw, dh);
      ctx.imageSmoothingEnabled = true;

      if (t <= 0.08) { resolve(); return; }
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
  });

  ov.style.transition = 'opacity 0.25s';
  ov.style.opacity = '0';
  await new Promise(r => setTimeout(r, 250));
  ov.style.display = 'none';
  ov.style.opacity = '1';
  ov.style.transition = '';
}

// ---------------------------------------------------------------------------
// SVG → 3D exit transition
// ---------------------------------------------------------------------------
async function runSvgTo3dTransition(): Promise<void> {
  // Snapshot the SVG viewport rect so 3d-viewer can start its cover in the
  // exact same screen position — no fade needed, the cover provides continuity.
  const r = svgVp.getBoundingClientRect();
  sessionStorage.setItem('hoas_svg_entry', JSON.stringify(
    { x: r.left, y: r.top, w: r.width, h: r.height }
  ));
}

// ---------------------------------------------------------------------------
// Inline SVG viewer
// ---------------------------------------------------------------------------
const SVG_COLOUR_DEFS = [
  { key: 'background', label: 'Land',
    swatches: ['#EAE6DC','#C8A878','#A07848','#D0C898','#C0D4A0','#90B868'] },
  { key: 'water',      label: 'Water',
    swatches: ['#A8C8E8','#6898C8','#2D5F8A','#7BBFBF','#4A9898','#3878A8'] },
  { key: 'park',       label: 'Parks',
    swatches: ['#B8D898','#D0E890','#80C870','#50A858','#407838','#305828'] },
  { key: 'urban_res',  label: 'Urban',
    swatches: ['#E8E0D4','#D8C8B0','#E0E0E0','#C8C8C8','#D8B8D8','#B898C8'] },
  { key: 'building',   label: 'Buildings',
    swatches: ['#CEC8C0','#A8A098','#C8906C','#B07050','#D8A840','#C88820'] },
  { key: 'road_main',  label: 'Roads',
    swatches: ['#FFFFFF','#C8C8C8','#F8E040','#E8A820','#E84848','#C82020'] },
];
const svgSelIdx = SVG_COLOUR_DEFS.map(() => 0);
const svgInclLabels = true, svgInclBuildings = true;
let svgNatW = 0, svgNatH = 0, svgTx = 0, svgTy = 0, svgScl = 1;
let svgCurrentUrl = '';
let svgCurrentStl: any = null;
let svgRegenTimer: ReturnType<typeof setTimeout> | null = null;

// STL parts arrive from the server as base64 (never persisted server-side). We decode each
// to an in-memory blob URL the rest of the app treats like a normal URL — STLLoader.load,
// download anchors, etc. The blobs live for the session, so revisiting/regenerating reuses
// them with no refetch. Old URLs are revoked on replacement to avoid leaks.
function b64ToBlobUrl(b64: string, mime = 'model/stl'): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}

function stlRespToUrls(r: any): any {
  if (svgCurrentStl) for (const k of ['stl_buildings_url', 'stl_land_url', 'stl_water_url', 'stl_solid_url']) {
    if (typeof svgCurrentStl[k] === 'string' && svgCurrentStl[k].startsWith('blob:')) URL.revokeObjectURL(svgCurrentStl[k]);
  }
  const o: any = {};
  if (r.stl_buildings) o.stl_buildings_url = b64ToBlobUrl(r.stl_buildings);
  if (r.stl_land)      o.stl_land_url      = b64ToBlobUrl(r.stl_land);
  if (r.stl_water)     o.stl_water_url     = b64ToBlobUrl(r.stl_water);
  if (r.stl_solid)     o.stl_solid_url     = b64ToBlobUrl(r.stl_solid);
  return o;
}

// Saved forward-transition state — used to drive the reverse animation
let _transFrame: HTMLImageElement | null = null;
let _transSel: ReturnType<typeof getSelAabb> = null;
let _transPixCanvas: HTMLCanvasElement | null = null;
let _transFitBounds: { x: number; y: number; w: number; h: number } | null = null;
let _transSvgImg: HTMLImageElement | null = null;
let svgRegenAbort: AbortController | null = null;
let _cachedOsmData: { elements?: Record<string, unknown>[] } | null = null;
let _cachedSvgResult: { svg_url: string; svgText: string } | null = null;
let svgCurrentText = '';

const svgView    = document.getElementById('svg-view')!;
const svgVp      = document.getElementById('svg-vp')!;
const svgWrapEl  = document.getElementById('svg-wrap')!;
const svgScaleEl = document.getElementById('svg-scale-display')!;
const svgSizeEl  = document.getElementById('svg-size-display')!;
const svgRegenEl = document.getElementById('svg-regen-status')!;
const svgDlBtn   = document.getElementById('svg-btn-dl') as HTMLAnchorElement;
const svg3dBtn   = document.getElementById('svg-btn-3d') as HTMLButtonElement;

function svgApply() {
  svgWrapEl.style.transform = `translate(${svgTx}px,${svgTy}px) scale(${svgScl})`;
  svgScaleEl.textContent = Math.round(svgScl * 100) + '%';
}

function svgFit() {
  if (!svgNatW || !svgNatH) return;
  const m = 40, vw = svgVp.clientWidth, vh = svgVp.clientHeight;
  svgScl = Math.min((vw - m*2) / svgNatW, (vh - m*2) / svgNatH);
  svgTx = (vw - svgNatW * svgScl) / 2;
  svgTy = (vh - svgNatH * svgScl) / 2;
  svgApply();
}

async function svgShow(text: string, initial: boolean) {
  const doc   = new DOMParser().parseFromString(text, 'image/svg+xml');
  const svgEl = doc.documentElement;
  svgNatW = parseFloat(svgEl.getAttribute('width') || '0');
  svgNatH = parseFloat(svgEl.getAttribute('height') || '0');
  const vb = svgEl.getAttribute('viewBox');
  if (vb) {
    const p = vb.trim().split(/[\s,]+/).map(Number);
    if (p.length >= 4) { if (!svgNatW) svgNatW = p[2]; if (!svgNatH) svgNatH = p[3]; }
  }
  if (!svgNatW) svgNatW = 1000; if (!svgNatH) svgNatH = 1000;
  svgEl.setAttribute('width',  String(svgNatW));
  svgEl.setAttribute('height', String(svgNatH));
  if (!initial) {
    svgWrapEl.style.transition = 'opacity 0.22s'; svgWrapEl.style.opacity = '0';
    await new Promise(r => setTimeout(r, 180));
  }
  svgWrapEl.innerHTML = ''; svgWrapEl.appendChild(svgEl);
  svgSizeEl.textContent = `${Math.round(svgNatW)} × ${Math.round(svgNatH)} px`;
  svgFit();
  if (!initial) {
    svgWrapEl.style.opacity = '1';
    setTimeout(() => { svgWrapEl.style.transition = ''; }, 250);
  }
}

function svgOverrides(): Record<string, string> {
  const hexShade = (hex: string, d: number) => {
    const parse = (s: number, e: number) => Math.max(0, Math.min(255, parseInt(hex.slice(s, e), 16) + d));
    return '#' + [parse(1,3), parse(3,5), parse(5,7)].map(v => v.toString(16).padStart(2,'0')).join('');
  };
  const o: Record<string,string> = {};
  SVG_COLOUR_DEFS.forEach((def, i) => {
    const c = def.swatches[svgSelIdx[i]];
    o[def.key] = c;
    if (def.key === 'background') o.agri       = c;
    if (def.key === 'urban_res')  o.urban_ind  = hexShade(c, -20);
    if (def.key === 'road_main')  o.road_other = hexShade(c, -15);
  });
  return o;
}

function svgInitPicker() {
  const el = document.getElementById('svg-colour-picker')!;
  el.innerHTML = SVG_COLOUR_DEFS.map((def, i) =>
    `<div class="colour-row"><span class="colour-key-label">${def.label}</span>` +
    `<div class="swatch-row">${def.swatches.map((c, j) =>
      `<div class="swatch${j===svgSelIdx[i]?' active':''}" style="background:${c}" data-cat="${i}" data-idx="${j}"></div>`
    ).join('')}</div></div>`
  ).join('');
  el.addEventListener('click', e => {
    const t = (e.target as HTMLElement).closest('.swatch') as HTMLElement | null;
    if (!t) return;
    const cat = +t.dataset.cat!, idx = +t.dataset.idx!;
    svgSelIdx[cat] = idx;
    el.querySelectorAll(`.swatch[data-cat="${cat}"]`).forEach((s, j) =>
      (s as HTMLElement).classList.toggle('active', j === idx));
    svgScheduleRegen();
  });
}

function svgScheduleRegen() {
  if (svgRegenTimer) clearTimeout(svgRegenTimer);
  svgRegenTimer = setTimeout(svgRegen, 80);
}

async function svgRegen() {
  if (!confirmed || !_cachedOsmData) return;
  const bbox = rotSelAabb(confirmed);
  svgRegenEl.textContent = 'Updating…';
  try {
    const bboxArr: [number, number, number, number] = [bbox.west, bbox.south, bbox.east, bbox.north];
    const svgEl = renderSvg({
      osmData: _cachedOsmData,
      bbox: bboxArr,
      merchType,
      coasterShape,
      includeLabels:    svgInclLabels,
      includeBuildings: svgInclBuildings,
      paletteOverrides: svgOverrides(),
    });
    const text = svgToString(svgEl);
    const blobUrl = svgToBlobUrl(svgEl);
    if (svgCurrentUrl.startsWith('blob:')) URL.revokeObjectURL(svgCurrentUrl);
    svgCurrentUrl = blobUrl; svgCurrentText = text;
    svgDlBtn.href = blobUrl;
    await svgShow(text, false);
    svgRegenEl.textContent = '';
  } catch (e: any) {
    if (e.name !== 'AbortError') svgRegenEl.textContent = `Error: ${e.message}`;
  }
}

async function openSvgView(url: string, text: string, stlResult: any) {
  svgCurrentUrl = url; svgCurrentText = text; svgCurrentStl = stlResult;
  svgDlBtn.href = url;
  const is3d = ['coaster','placemat','3d_print'].includes(merchType);
  svg3dBtn.style.display = is3d ? 'block' : 'none';
  if (!is3d) { svgDlBtn.style.borderColor = '#4a9eff'; svgDlBtn.style.color = '#4a9eff'; }
  else        { svgDlBtn.style.borderColor = ''; svgDlBtn.style.color = ''; }

  // Show save section in sidebar: immediately for 2D, or 3D when STL already present
  const saveSection = document.getElementById('svg-save-section')!;
  const saveStatus  = document.getElementById('svg-save-status')!;
  saveStatus.textContent = '';
  saveSection.style.display = (!is3d || stlResult) ? '' : 'none';
  setSaveNamePreview('svg-save-name-preview');
  // Show STL download links immediately if we already have them
  if (is3d && stlResult) onStlReady();

  svgView.style.display = 'flex';
  // Wait two frames so the browser has done a layout pass before measuring clientWidth
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r as FrameRequestCallback)));
  await svgShow(text, true);
  svgInitPicker();
}

// ── SVG viewer event listeners ────────────────────────────────────────────────
document.getElementById('btn-back')!.addEventListener('click', async () => {
  svgView.style.display = 'none';
  const panel = document.getElementById('panel')!;
  panel.style.visibility = 'visible';
  await runReverseTransition();
  genBtn.disabled = false;
  genBtn.onclick = _cachedSvgResult ? showCachedSvg : generate;
  (document.getElementById('btn-text') as HTMLElement).textContent = _cachedSvgResult ? 'View SVG →' : 'Generate Design';
  (document.getElementById('spinner') as HTMLElement).style.display = 'none';
});

async function showCachedSvg(): Promise<void> {
  if (!_cachedSvgResult) return;
  const panel = document.getElementById('panel')!;
  panel.style.visibility = 'hidden';
  try {
    const svgResult = await runTransition(Promise.resolve(_cachedSvgResult), 0);
    await openSvgView(svgResult.svg_url, svgResult.svgText, svgCurrentStl);
    const ov = document.getElementById('transition-overlay') as HTMLCanvasElement;
    ov.style.transition = 'opacity 0.3s';
    ov.style.opacity = '0';
    await new Promise(r => setTimeout(r, 300));
    ov.style.display = 'none';
    ov.style.opacity = '1';
    ov.style.transition = '';
  } catch {
    panel.style.visibility = '';
  }
}

let _viewer3d: any = null;

svg3dBtn.addEventListener('click', async () => {
  if (!confirmed) return;
  const bbox = rotSelAabb(confirmed);
  const view3dEl = document.getElementById('viewer-3d-view')!;
  view3dEl.style.display = 'flex';
  setSaveNamePreview('stl-save-name-preview');

  const r = svgVp.getBoundingClientRect();

  if (!_viewer3d) {
    const mod = await import('./viewer3d');
    _viewer3d = new mod.Viewer3D(document.getElementById('canvas-wrap-3d')!);
    _viewer3d.onPrint = openPrintView;
  }

  _viewer3d.loadScene({
    west: bbox.west, south: bbox.south, east: bbox.east, north: bbox.north,
    merch: merchType, coasterShape,
    svgUrl: svgCurrentUrl || null,
    svgEntryRect: { x: r.left, y: r.top, w: r.width, h: r.height },
    osmData: _cachedOsmData ?? { elements: [] },
    stlBuildings: svgCurrentStl?.stl_buildings_url ?? null,
    stlLand: svgCurrentStl?.stl_land_url ?? null,
    stlWater: svgCurrentStl?.stl_water_url ?? null,
    stlSolid: svgCurrentStl?.stl_solid_url ?? null,
    paletteOverrides: svgOverrides(),
  });
  // (No /api/save-svg — the SVG is a client-side blob; nothing is persisted server-side.)
});

document.getElementById('btn-3d-back')!.addEventListener('click', () => {
  document.getElementById('viewer-3d-view')!.style.display = 'none';
});

// ── In-SPA 3D-print view (state push from the 3D map; back = state pop, no re-pull) ──
let _printViewer: any = null;
let _printScene: any = null;

async function openPrintView(scene: any): Promise<void> {
  _printScene = scene;
  document.getElementById('viewer-print-view')!.style.display = 'flex';
  setSaveNamePreview('print-save-name-preview');
  if (!_printViewer) {
    const mod = await import('./print-viewer');
    _printViewer = new mod.PrintViewer(document.getElementById('canvas-wrap-print')!);
    _printViewer.onRegen = regenPrintStl;
  } else {
    _printViewer.setScene(scene);
  }
  await _printViewer.loadScene(scene);
}

// Regenerate the STL parts for the current print scene; updates the cached URLs in place.
async function regenPrintStl(): Promise<void> {
  if (!_printScene) return;
  const { west, south, east, north, merch, coasterShape } = _printScene;
  const r = await fetch('/api/generate/stl', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bbox: { west, south, east, north }, merch_type: merch, coaster_shape: coasterShape }),
  });
  if (!r.ok) throw new Error(`Server ${r.status}`);
  const res = await r.json();
  for (const [field, key] of [['stlBuildings', 'stl_buildings'], ['stlLand', 'stl_land'],
                              ['stlWater', 'stl_water'], ['stlSolid', 'stl_solid']] as const) {
    const cur = _printScene[field];
    if (typeof cur === 'string' && cur.startsWith('blob:')) URL.revokeObjectURL(cur);
    _printScene[field] = res[key] ? b64ToBlobUrl(res[key]) : null;
  }
  _printViewer?.setScene(_printScene);
}

document.getElementById('btn-print-back')!.addEventListener('click', () => {
  // State pop — hide the print overlay, revealing the 3D map underneath. No re-pull.
  document.getElementById('viewer-print-view')!.style.display = 'none';
});

document.getElementById('print-save-btn')!.addEventListener('click', async () => {
  const token = localStorage.getItem('hoas_token');
  if (!token) { location.href = '/login.html?returnTo=' + encodeURIComponent(location.href); return; }
  const statusEl = document.getElementById('print-save-status')!;
  const s = _printScene;
  if (!s) return;
  const name = buildBaseName();
  statusEl.textContent = 'Saving…';
  const thumbnail = _printViewer?.getSnapshot(150) ?? null;
  try {
    const resp = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        name, merch_type: s.merch,
        bbox_west: s.west, bbox_south: s.south, bbox_east: s.east, bbox_north: s.north,
        coaster_shape: s.coasterShape, palette_overrides: s.paletteOverrides ?? null,
        thumbnail_data_url: thumbnail,
      }),
    });
    if (resp.status === 401) { localStorage.removeItem('hoas_token'); location.href = '/login.html'; return; }
    if (!resp.ok) throw new Error(`Server ${resp.status}`);
    statusEl.textContent = 'Saved!';
    setTimeout(() => { statusEl.textContent = ''; }, 2500);
  } catch (e: any) { statusEl.textContent = `Error: ${e.message}`; }
});

// Pan/zoom on SVG viewport
svgVp.addEventListener('wheel', (e: WheelEvent) => {
  e.preventDefault();
  const f = e.deltaY < 0 ? 1.12 : 1 / 1.12;
  const r = svgVp.getBoundingClientRect();
  svgTx = (e.clientX - r.left) - ((e.clientX - r.left) - svgTx) * f;
  svgTy = (e.clientY - r.top)  - ((e.clientY - r.top)  - svgTy) * f;
  svgScl *= f;
  svgApply();
}, { passive: false });

let svgDrag = false, svgDragX = 0, svgDragY = 0;
svgVp.addEventListener('mousedown', (e: MouseEvent) => {
  if (e.button !== 0) return;
  svgDrag = true; svgDragX = e.clientX; svgDragY = e.clientY;
  svgVp.classList.add('dragging');
});
window.addEventListener('mousemove', (e: MouseEvent) => {
  if (!svgDrag) return;
  svgTx += e.clientX - svgDragX; svgTy += e.clientY - svgDragY;
  svgDragX = e.clientX; svgDragY = e.clientY;
  svgApply();
});
window.addEventListener('mouseup', () => {
  if (!svgDrag) return;
  svgDrag = false; svgVp.classList.remove('dragging');
});

// ---------------------------------------------------------------------------
// Generate — transition then show inline SVG viewer
// ---------------------------------------------------------------------------
const genBtn = document.getElementById('generate-btn') as HTMLButtonElement;

function tPost(label: string, ms: number, extra = '') {
  fetch('/api/timing', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label, ms, extra }) }).catch(() => {});
}

async function generate(): Promise<void> {
  if (!confirmed) return;
  const bbox   = rotSelAabb(confirmed);
  const spinner = document.getElementById('spinner')!;
  const btnText = document.getElementById('btn-text')!;
  const status  = document.getElementById('status')!;
  const panel   = document.getElementById('panel')!;

  genBtn.disabled = true; genBtn.onclick = null;
  spinner.style.display = 'block';
  btnText.textContent = 'Generating…'; status.textContent = '';
  panel.style.visibility = 'hidden';

  const _t0 = performance.now();
  const _cosLat = Math.cos((bbox.south + bbox.north) / 2 * Math.PI / 180);
  const _km2 = Math.round((bbox.east - bbox.west) * _cosLat * 111.32 * (bbox.north - bbox.south) * 111.32 * 100) / 100;
  // Guard on TRUE selection area (rotation-invariant), matching the selector's hard cap.
  if (selAreaKm2(confirmed) > MAX_AREA_KM2) { clearGeneratedState(); return; }
  const _area = `km2=${_km2}`;
  tPost('generate_start', 0, _area);

const abort = new AbortController();
  setTimeout(() => abort.abort(), 90_000);

  async function fetchJson(url: string, body: object, signal?: AbortSignal) {
    const r = await fetch(url, {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      let msg = `Server ${r.status}`;
      try { const j = await r.json(); if (j.detail) msg = j.detail; } catch { /* ignore */ }
      throw new Error(msg);
    }
    return r.json();
  }

  const bboxArr: [number, number, number, number] = [bbox.west, bbox.south, bbox.east, bbox.north];

  // Place-name pre-flight — runs in parallel with the OSM fetch; result feeds the auto
  // save-name. Best-effort and non-blocking (falls back to search text / merch label).
  lastPlaceLabel = null;
  fetch(`/api/geocode/reverse?lat=${(bbox.south + bbox.north) / 2}&lon=${(bbox.west + bbox.east) / 2}`)
    .then(r => r.ok ? r.json() : null)
    .then(loc => { if (loc && loc.label) lastPlaceLabel = loc.label; })
    .catch(() => { /* non-critical */ });

  // Start OSM fetch immediately — don't wait for the estimate pre-flight.
  // The estimate makes its own Overpass count query (up to 30s); awaiting it
  // before the real fetch would serialise two Overpass round-trips.
  tPost('osm_request_start', performance.now() - _t0, _area);
  const osmP = fetch(`/api/osm/features?${new URLSearchParams({
    west: String(bbox.west), south: String(bbox.south),
    east: String(bbox.east), north: String(bbox.north),
  })}`, { signal: abort.signal })
    .then(async r => {
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error((j as any).detail ?? `Backend ${r.status}`);
      }
      return r.json();
    })
    .then((osmData: { elements?: Record<string, unknown>[] }) => {
      tPost('osm_data_received', performance.now() - _t0, `${_area} elements=${(osmData.elements||[]).length}`);
      _cachedOsmData = osmData;
      const t1 = performance.now();
      const svgEl = renderSvg({
        osmData, bbox: bboxArr, merchType,
        coasterShape, includeLabels: true, includeBuildings: true,
      });
      tPost('svg_rendered', performance.now() - _t0, `${_area} render=${Math.round(performance.now()-t1)}ms`);
      return { svg_url: svgToBlobUrl(svgEl), svgText: svgToString(svgEl) };
    });

  // Fire STL only after OSM data is cached — avoids a simultaneous double-Overpass hit
  osmP.then(() => {
    fetchJson('/api/generate/stl', {
      bbox, merch_type: merchType, coaster_shape: coasterShape,
    }).then((r: any) => { svgCurrentStl = stlRespToUrls(r); onStlReady(); }).catch(() => { /* ignore */ });
  }).catch(() => { /* osmP already handles its own error */ });

  // Estimate runs in background — updates status bar and refines progress bar when it resolves.
  // Use local formula as initial estimate so runTransition can start immediately.
  let estimatedMs = estimateGenMs(bbox) * 2; // rough: osm + svg
  fetchEstimate(bbox, merchType).then(estimate => {
    if (!estimate) return;
    estimatedMs = (estimate.svg_estimate_ms ?? estimateGenMs(bbox)) + (estimate.osm_estimate_ms ?? estimateGenMs(bbox));
    const label: Record<string, string> = { low: 'Simple area', medium: 'Medium density', high: 'Complex area', very_high: 'Very complex — may be slow' };
    Status.message(`Generating map… · ${estimate.area_km2} km² · ${(estimate.element_count / 1000).toFixed(1)}k elements · ${label[estimate.complexity] ?? estimate.complexity}`);
  }).catch(() => { /* non-critical */ });

  // Fly camera to fit the selection in view — runs in parallel with the OSM fetch.
  // Must complete before runTransition takes the Cesium canvas snapshot.
  await flyTobbox(bbox.west, bbox.south, bbox.east, bbox.north);

  try {
    const svgResult = await runTransition(osmP, estimatedMs);
    _cachedSvgResult = svgResult;

    await openSvgView(svgResult.svg_url, svgResult.svgText, svgCurrentStl);

    const ov = document.getElementById('transition-overlay') as HTMLCanvasElement;
    ov.style.transition = 'opacity 0.3s';
    ov.style.opacity = '0';
    await new Promise(r => setTimeout(r, 300));
    ov.style.display = 'none';
    ov.style.opacity = '1';
    ov.style.transition = '';

  } catch (err: any) {
    Status.done();
    const ov = document.getElementById('transition-overlay') as HTMLCanvasElement;
    ov.style.display = 'none';
    ov.style.opacity = '1';
    ov.style.transition = '';
    panel.style.visibility = '';
    status.textContent = err.name === 'AbortError' ? 'Timed out — try a smaller area' : `Error: ${err.message}`;
    genBtn.disabled = false; btnText.textContent = 'Retry';
    spinner.style.display = 'none';
    genBtn.onclick = generate;
  }
}

// ---------------------------------------------------------------------------
// Coaster shape cycling
// ---------------------------------------------------------------------------
function stepCoasterShape(dir: 1 | -1): void {
  // Capture the real area before the shape changes so we can preserve it after.
  const prevArea = (editState === 'editing' && _live) ? selAreaKm2(_live) : null;
  coasterShapeIdx = (coasterShapeIdx + dir + COASTER_SHAPES.length) % COASTER_SHAPES.length;
  coasterShape = COASTER_SHAPES[coasterShapeIdx];
  document.getElementById('coaster-icon')!.textContent  = COASTER_ICONS[coasterShape];
  document.getElementById('coaster-shape-label')!.textContent = COASTER_LABELS[coasterShape];
  // Re-derive geometry so the new shape covers the SAME real km² (square↔circle↔hexagon
  // all cover equal area at a given scale; the bounding box grows/shrinks to suit).
  if (prevArea !== null) {
    _live = shapeForArea(_live!, MERCH_RATIO[merchType] ?? 1, Math.min(prevArea, MAX_AREA_KM2));
    confirmed = { ..._live };
    updateBboxDisplay();
  }
}

document.getElementById('coaster-prev')!.addEventListener('click', (e) => { e.stopPropagation(); stepCoasterShape(-1); });
document.getElementById('coaster-next')!.addEventListener('click', (e) => { e.stopPropagation(); stepCoasterShape(1); });

// ---------------------------------------------------------------------------
// Place search — Nominatim OSM geocoder (debounced, 500 ms)
// ---------------------------------------------------------------------------
function flyTobbox(west: number, south: number, east: number, north: number): Promise<void> {
  return new Promise(resolve => {
    const cosLat = Math.cos((south + north) / 2 * Math.PI / 180);
    const spanM  = Math.max((east - west) * cosLat * 111_320, (north - south) * 111_320);
    const altM   = Math.max(spanM * 1.4, 2_000);
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees((west + east) / 2, (south + north) / 2, altM),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      duration: 1.5,
      complete: resolve,
    });
  });
}

const placeInput   = document.getElementById('place-search')   as HTMLInputElement;
const placeResults = document.getElementById('search-results') as HTMLUListElement;
let searchTimer: ReturnType<typeof setTimeout> | null = null;

placeInput.addEventListener('input', () => {
  if (searchTimer) clearTimeout(searchTimer);
  const q = placeInput.value.trim();
  if (q.length < 3) { placeResults.style.display = 'none'; return; }
  searchTimer = setTimeout(async () => {
    try {
      const res  = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=5`);
      const data = await res.json();
      placeResults.innerHTML = '';
      if (!data.length) { placeResults.style.display = 'none'; return; }
      for (const item of data) {
        const li = document.createElement('li');
        li.textContent = item.display_name;
        li.addEventListener('click', () => {
          const [s, n, w, e] = (item.boundingbox as string[]).map(Number);
          flyTobbox(w, s, e, n);
          placeInput.value = item.display_name.split(',')[0].trim();
          placeResults.style.display = 'none';
        });
        placeResults.appendChild(li);
      }
      placeResults.style.display = 'block';
    } catch { /* silently ignore network errors */ }
  }, 500);
});

placeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { placeResults.style.display = 'none'; placeInput.blur(); }
});

document.addEventListener('click', (e) => {
  if (!placeInput.contains(e.target as Node) && !placeResults.contains(e.target as Node)) {
    placeResults.style.display = 'none';
  }
});

// ---------------------------------------------------------------------------
// Save project
// ---------------------------------------------------------------------------
async function captureSvgThumbnail(size = 150): Promise<string | null> {
  if (!svgCurrentUrl) return null;
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = svgCurrentUrl;
    });
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const ctx = cv.getContext('2d')!;
    const iw = img.naturalWidth || size, ih = img.naturalHeight || size;
    const minDim = Math.min(iw, ih);
    ctx.drawImage(img, (iw - minDim) / 2, (ih - minDim) / 2, minDim, minDim, 0, 0, size, size);
    return cv.toDataURL('image/webp', 0.7);
  } catch { return null; }
}

async function saveProject(): Promise<void> {
  const token = localStorage.getItem('hoas_token');
  if (!token) {
    window.location.href = '/login.html?returnTo=' + encodeURIComponent(window.location.href);
    return;
  }
  if (!confirmed) return;

  const is3dOpen = document.getElementById('viewer-3d-view')!.style.display !== 'none';
  const statusEl = document.getElementById(is3dOpen ? 'stl-save-status' : 'svg-save-status') as HTMLElement;
  const name     = buildBaseName();
  statusEl.textContent = 'Saving…';

  const bbox = rotSelAabb(confirmed);

  let thumbnailDataUrl: string | null = null;
  if (is3dOpen && _viewer3d) thumbnailDataUrl = _viewer3d.getSnapshot(150);
  if (!thumbnailDataUrl) thumbnailDataUrl = await captureSvgThumbnail(150);

  try {
    const resp = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        name,
        merch_type:         merchType,
        bbox_west:          bbox.west,
        bbox_south:         bbox.south,
        bbox_east:          bbox.east,
        bbox_north:         bbox.north,
        coaster_shape:      coasterShape,
        palette_overrides:  svgOverrides(),
        thumbnail_data_url: thumbnailDataUrl,
      }),
    });
    if (resp.status === 401) {
      localStorage.removeItem('hoas_token');
      window.location.href = '/login.html?returnTo=' + encodeURIComponent(window.location.href);
      return;
    }
    if (!resp.ok) throw new Error(`Server ${resp.status}`);
    statusEl.textContent = 'Saved!';
    setTimeout(() => { statusEl.textContent = ''; }, 2500);
  } catch (e: any) {
    statusEl.textContent = `Error: ${e.message}`;
  }
}

document.getElementById('svg-save-btn')!.addEventListener('click', saveProject);
document.getElementById('stl-save-btn')!.addEventListener('click', saveProject);

// ---------------------------------------------------------------------------
// User nav
// ---------------------------------------------------------------------------
function doLogout(): void {
  localStorage.removeItem('hoas_token');
  localStorage.removeItem('hoas_refresh');
  localStorage.removeItem('hoas_email');
  window.location.href = '/login.html';
}

function updateUserNav(): void {
  const email = localStorage.getItem('hoas_email') || '';
  document.querySelectorAll<HTMLElement>('.user-nav-slot').forEach(el => {
    el.innerHTML = email
      ? `<div class="user-email-display">${email}</div>
         <button class="btn nav-designs-btn">⊞ My Designs</button>
         <button class="btn-secondary nav-logout-btn">↩ Logout</button>`
      : `<a href="/login.html" class="btn">Sign in</a>`;
    el.querySelector<HTMLElement>('.nav-designs-btn')?.addEventListener('click', openDesignsPanel);
    el.querySelector<HTMLElement>('.nav-logout-btn')?.addEventListener('click', doLogout);
  });
}
updateUserNav();

// ---------------------------------------------------------------------------
// STL ready — reveal save section for 3D designs
// ---------------------------------------------------------------------------
function onStlReady(): void {
  if (!['coaster','placemat','3d_print'].includes(merchType)) return;
  if (svgView.style.display === 'none') return;
  document.getElementById('svg-save-section')!.style.display = '';
  const statusEl = document.getElementById('svg-save-status')!;
  statusEl.textContent = '3D model ready — save your design';
  setTimeout(() => { if (statusEl.textContent.startsWith('3D model')) statusEl.textContent = ''; }, 3500);

  // If 3D viewer is already open, enable the print button now that STL is ready
  if (_viewer3d && svgCurrentStl &&
      document.getElementById('viewer-3d-view')!.style.display !== 'none') {
    _viewer3d.enablePrintButton(
      svgCurrentStl.stl_buildings_url,
      svgCurrentStl.stl_land_url,
      svgCurrentStl.stl_water_url,
      svgCurrentStl.stl_solid_url ?? null,
    );
  }
}

// ---------------------------------------------------------------------------
// My Designs floating panel
// ---------------------------------------------------------------------------
let _designsCache: any[] = [];

const designsBackdrop = document.getElementById('designs-backdrop')!;
const designsPanel    = document.getElementById('designs-panel')!;
designsBackdrop.addEventListener('click', closeDesignsPanel);
document.getElementById('designs-close')!.addEventListener('click', closeDesignsPanel);

function openDesignsPanel(): void {
  const token = localStorage.getItem('hoas_token');
  if (!token) { window.location.href = '/login.html?returnTo=' + encodeURIComponent(window.location.href); return; }
  document.getElementById('designs-email')!.textContent = localStorage.getItem('hoas_email') || '';
  designsBackdrop.classList.add('open');
  designsPanel.classList.add('open');
  renderDesigns();
}

function closeDesignsPanel(): void {
  designsBackdrop.classList.remove('open');
  designsPanel.classList.remove('open');
}

window.addEventListener('message', (e: MessageEvent) => {
  if (!e.data) return;
  if (e.data.type === 'open-designs') openDesignsPanel();
  if (e.data.type === 'logout') doLogout();
});

async function renderDesigns(): Promise<void> {
  const token     = localStorage.getItem('hoas_token')!;
  const contentEl = document.getElementById('designs-content')!;
  contentEl.innerHTML = '<div class="designs-loading">Loading…</div>';

  try {
    const resp = await fetch('/api/projects', { headers: { 'Authorization': `Bearer ${token}` } });
    if (resp.status === 401) {
      localStorage.removeItem('hoas_token');
      window.location.href = '/login.html?returnTo=' + encodeURIComponent(window.location.href);
      return;
    }
    if (!resp.ok) throw new Error(`Server ${resp.status}`);

    const projects: any[] = await resp.json();
    _designsCache = projects;

    if (!projects.length) {
      contentEl.innerHTML = '<div class="designs-empty">No saved designs yet.</div>';
      return;
    }

    const MERCH_EMOJI: Record<string, string> = {
      tshirt: '👕', mug: '☕', tote: '👜', coaster: '⬜', placemat: '🟫', '3d_print': '⛰',
    };

    function esc(s: string): string {
      return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    contentEl.innerHTML = `<div class="designs-grid">${projects.map(p => {
      const date  = new Date(p.created_at).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' });
      const emoji = MERCH_EMOJI[p.merch_type] || '🗺';
      const thumb = p.thumbnail_data_url
        ? `<img src="${p.thumbnail_data_url}" alt="" loading="lazy">`
        : `<span class="no-thumb">${emoji}</span>`;
      return `
        <div class="design-card">
          <div class="design-thumb">${thumb}</div>
          <div class="design-name">${esc(displayName(p, projects))}</div>
          <div class="design-meta">${emoji} ${p.merch_type}<br>${date}</div>
          <div class="design-actions">
            <button class="btn design-load-btn" data-id="${p.id}">↩ Load</button>
            <button class="btn-danger design-del-btn"  data-id="${p.id}">✕</button>
          </div>
        </div>`;
    }).join('')}</div>`;

    contentEl.querySelectorAll<HTMLElement>('.design-load-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const project = _designsCache.find(p => p.id === +btn.dataset.id!);
        if (project) loadDesign(project);
      });
    });
    contentEl.querySelectorAll<HTMLButtonElement>('.design-del-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this design?')) return;
        btn.disabled = true;
        const id = +btn.dataset.id!;
        const r = await fetch(`/api/projects/${id}`, {
          method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` },
        });
        if (r.ok || r.status === 204) {
          _designsCache = _designsCache.filter(p => p.id !== id);
          btn.closest('.design-card')?.remove();
          if (!contentEl.querySelector('.design-card'))
            contentEl.innerHTML = '<div class="designs-empty">No saved designs yet.</div>';
        } else { btn.disabled = false; }
      });
    });

  } catch (e: any) {
    contentEl.innerHTML = `<div class="designs-loading">Error: ${e.message}</div>`;
  }
}

function restorePalette(overrides: Record<string, string>): void {
  SVG_COLOUR_DEFS.forEach((def, i) => {
    const saved = overrides[def.key];
    if (!saved) return;
    const idx = def.swatches.findIndex(s => s.toLowerCase() === saved.toLowerCase());
    if (idx !== -1) svgSelIdx[i] = idx;
  });
}

async function loadDesign(project: any): Promise<void> {
  closeDesignsPanel();
  clearGeneratedState();

  // Restore merch type
  const newMerch = project.merch_type as string;
  document.querySelectorAll<HTMLElement>('.merch-btn').forEach(el =>
    el.classList.toggle('active', el.dataset.type === newMerch));
  merchType = newMerch;

  // Restore coaster shape
  if (project.coaster_shape) {
    const idx = COASTER_SHAPES.indexOf(project.coaster_shape as CoasterShape);
    if (idx !== -1) {
      coasterShapeIdx = idx; coasterShape = COASTER_SHAPES[idx];
      document.getElementById('coaster-icon')!.textContent        = COASTER_ICONS[coasterShape];
      document.getElementById('coaster-shape-label')!.textContent = COASTER_LABELS[coasterShape];
    }
  }

  // Restore palette
  if (project.palette_overrides) restorePalette(project.palette_overrides);

  // Restore bbox selection on map
  const bbox: BBox = project.bbox;
  const sel = bboxToRotSel(bbox);
  if (editState === 'editing') exitEditing();
  else if (editState === 'drawing') { clearHandlers(); editState = 'idle'; }
  enterEditing(sel);

  // Re-generate from settings (no stored URLs needed)
  generate();
}

// ---------------------------------------------------------------------------
// Wire up
// ---------------------------------------------------------------------------
genBtn.onclick = generate;
document.querySelectorAll<HTMLElement>('.merch-btn').forEach(el => el.addEventListener('click', () => selectMerch(el)));

// (The old hoas_return_to_3d restore shim is gone: the 3D-print view is now an in-SPA
// overlay state, so "back" is a state pop with no navigation and no re-pull.)

// Deep-link: /index.html?design=<id> (used by the dashboard "Open" button) loads that
// saved design straight into the SPA — fetch the config, then loadDesign regenerates it.
(function () {
  const id = new URLSearchParams(location.search).get('design');
  if (!id) return;
  const token = localStorage.getItem('hoas_token');
  if (!token) return;
  fetch('/api/projects', { headers: { Authorization: `Bearer ${token}` } })
    .then(r => r.ok ? r.json() : [])
    .then((projects: any[]) => {
      const p = projects.find(x => String(x.id) === id);
      if (p) loadDesign(p);
    })
    .catch(() => { /* ignore — user can still draw a fresh selection */ });
})();

