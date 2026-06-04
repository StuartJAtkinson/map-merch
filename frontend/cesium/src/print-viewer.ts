import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { Status } from './status';

// In-SPA 3D-print preview (the 3-piece STL assembly). Ported from the old standalone
// 3d-print.html so the print view is a state inside the SPA — opening it is an overlay,
// "back" is a state pop (no page navigation, no OSM/STL re-pull).

export interface PrintScene {
  west: number; south: number; east: number; north: number;
  merch: string; coasterShape: string | null;
  stlBuildings: string | null; stlLand: string | null;
  stlWater: string | null; stlSolid: string | null;
  paletteOverrides?: Record<string, string> | null;
}

const BG = 0x0d0e0f;
const PRINT_MAT: Record<string, { solid: number; wire: number }> = {
  buildings: { solid: 0x909088, wire: 0x00ffff },
  land:      { solid: 0x4a8a4a, wire: 0x00ff66 },
  water:     { solid: 0x2a6aaa, wire: 0x00aaff },
};

function animMs(ms: number, cb: (t: number) => void): Promise<void> {
  return new Promise(resolve => {
    const t0 = performance.now();
    (function tick(now: number) {
      const t = Math.min(1, (now - t0) / ms);
      cb(t);
      if (t < 1) requestAnimationFrame(tick); else resolve();
    })(performance.now());
  });
}

export class PrintViewer {
  private canvasWrap: HTMLElement;
  private renderer: THREE.WebGLRenderer;

  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private controls!: OrbitControls;
  private sceneW = 0;
  private sceneD = 0;

  private printGroup!: THREE.Group;
  private printLayers!: { buildings: THREE.Group; water: THREE.Group; land: THREE.Group };
  private printLayerMats: { buildings: any; water: any; land: any } = { buildings: null, water: null, land: null };
  private baseplateGroup!: THREE.Group;
  private allMats: any[] = [];
  private _watRestLocalY = 4 / 3;
  private _lndRestLocalY = 8 / 3;

  private loopRunning = false;
  private wireframe = false;
  private _scene: PrintScene | null = null;

  // Called by the panel's Regenerate button (set by app.ts so it can reuse the API helper).
  onRegen: (() => Promise<void>) | null = null;

  constructor(canvasWrap: HTMLElement) {
    this.canvasWrap = canvasWrap;
    const W = canvasWrap.clientWidth || (window.innerWidth - 272);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(W, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    canvasWrap.appendChild(this.renderer.domElement);

    window.addEventListener('resize', () => {
      if (!this.camera) return;
      const W = this.canvasWrap.clientWidth;
      this.camera.aspect = W / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(W, window.innerHeight);
    });
  }

  private _startLoop(): void {
    if (this.loopRunning) return;
    this.loopRunning = true;
    const loop = () => {
      requestAnimationFrame(loop);
      if (!this.scene || !this.camera) return;
      this.controls?.update();
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  async loadScene(s: PrintScene): Promise<void> {
    this._scene = s;
    const { west, south, east, north } = s;

    const cx = (east + west) / 2, cy = (north + south) / 2;
    const cosLat = Math.cos(cy * Math.PI / 180);
    const M = 111_320;
    this.sceneW = (east - west) * cosLat * M;
    this.sceneD = (north - south) * M;
    const SW = this.sceneW, SD = this.sceneD;

    // Fresh scene each open
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(BG);
    scene.fog = new THREE.Fog(BG, SW * 2, SW * 5);
    this.scene = scene;

    scene.add(new THREE.AmbientLight(0xffffff, 0.8));
    const sun = new THREE.DirectionalLight(0xfff5e0, 1.8);
    sun.position.set(SW * 0.4, SW * 0.8, SD * 0.3);
    sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { near: 1, far: SW * 4, left: -SW, right: SW, top: SD, bottom: -SD });
    sun.shadow.bias = -0.0005;
    scene.add(sun);
    scene.add(new THREE.HemisphereLight(0x334466, 0x111118, 0.5));

    const W = this.canvasWrap.clientWidth || (window.innerWidth - 272);
    const fitH = Math.max(SW, SD) * 0.9;
    this.camera = new THREE.PerspectiveCamera(48, W / window.innerHeight, 1, SW * 20);
    this.camera.position.set(0, fitH * 0.7, fitH);
    this.camera.lookAt(0, 0, 0);

    if (this.controls) this.controls.dispose();
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    Object.assign(this.controls, {
      enableDamping: true, dampingFactor: 0.07, autoRotate: false,
      maxPolarAngle: Math.PI / 2 - 0.05, minDistance: 20, maxDistance: SW * 8,
    });
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.DOLLY } as any;

    this.printGroup = new THREE.Group();
    scene.add(this.printGroup);
    this.printLayers = { buildings: new THREE.Group(), water: new THREE.Group(), land: new THREE.Group() };
    Object.values(this.printLayers).forEach(g => { g.visible = false; this.printGroup.add(g); });
    this.baseplateGroup = new THREE.Group();
    this.baseplateGroup.visible = false;
    this.printGroup.add(this.baseplateGroup);
    this.printLayerMats = { buildings: null, water: null, land: null };
    this.allMats = [];
    this.wireframe = false;

    this._startLoop();

    const statusEl = this._el('status-print');
    // Generation progress now lives in the global bottom strip.
    Status.begin('Loading STL…');

    if (!(s.stlBuildings && s.stlLand && s.stlWater)) {
      if (statusEl) statusEl.textContent = 'No STL data yet — generate first.';
      Status.done();
      this._wireControls();
      return;
    }

    Status.message('Loading STL files…');
    const barStart = performance.now(), barDur = 3200;
    let barActive = true;
    const barLoop = (now: number) => {
      const t = Math.min(1, (now - barStart) / barDur);
      Status.set(t * 0.97);
      if (t < 1 && barActive) requestAnimationFrame(barLoop);
    };
    barLoop(performance.now());

    try {
      await this._loadParts(s.stlBuildings, s.stlLand, s.stlWater);
      Status.message('Assembling layers…');
      await this._runAnim();
      barActive = false;
      Status.set(1); Status.done();
    } catch (e: any) {
      barActive = false;
      Status.done();
      if (statusEl) statusEl.textContent = 'Failed to load STL: ' + e.message;
    }

    this._wireControls();
    this._wireDownloads();
  }

  private async _loadParts(b: string, l: string, w: string): Promise<void> {
    const loader = new STLLoader();
    for (const [url, key] of [[b, 'buildings'], [l, 'land'], [w, 'water']] as [string, 'buildings' | 'land' | 'water'][]) {
      if (!url) continue;
      try {
        const geo: any = await new Promise((res, rej) => loader.load(url, res, undefined, rej));
        geo.rotateX(-Math.PI / 2); geo.computeVertexNormals();
        const cfg = PRINT_MAT[key];
        const mat: any = new THREE.MeshStandardMaterial({ color: cfg.solid, roughness: 0.65, metalness: 0.05 });
        mat._solidColor = cfg.solid; mat._wireColor = cfg.wire;
        this.allMats.push(mat); this.printLayerMats[key] = mat;
        const mesh = new THREE.Mesh(geo, mat); mesh.castShadow = mesh.receiveShadow = true;
        this.printLayers[key].add(mesh);
      } catch (e) { console.warn(`STL ${key}:`, e); }
    }

    Object.values(this.printLayers).forEach(g => { g.visible = true; });
    const sz = new THREE.Vector3();
    new THREE.Box3().setFromObject(this.printGroup).getSize(sz);
    const scaleX = sz.x > 0 ? this.sceneW / sz.x : 1;
    const scaleZ = sz.z > 0 ? this.sceneD / sz.z : 1;
    this.printGroup.scale.set(scaleX, scaleX, scaleZ);
    const worldBox = new THREE.Box3().setFromObject(this.printGroup);
    const centre = new THREE.Vector3(); worldBox.getCenter(centre);
    this.printGroup.position.set(-centre.x, -worldBox.min.y + 1, -centre.z);

    const bldgBox = new THREE.Box3().setFromObject(this.printLayers.buildings);
    const lndBox = new THREE.Box3().setFromObject(this.printLayers.land);
    const sy = this.printGroup.scale.y;
    const py = this.printGroup.position.y;
    const bldgLocalMin = (bldgBox.min.y - py) / sy;
    const bldgLocalMax = (bldgBox.max.y - py) / sy;
    const bldgLocalH = bldgLocalMax - bldgLocalMin;
    const lndLocalH = (lndBox.max.y - lndBox.min.y) / sy;
    this._watRestLocalY = bldgLocalMin + bldgLocalH / 3;
    this._lndRestLocalY = bldgLocalMin + bldgLocalH - lndLocalH;

    const bpW = sz.x, bpD = sz.z, bpH = 0.008 * Math.max(bpW, bpD);
    const bpMat: any = new THREE.MeshStandardMaterial({ color: 0x787870, roughness: 0.85, metalness: 0.04 });
    bpMat._solidColor = 0x787870; bpMat._wireColor = 0x778899; this.allMats.push(bpMat);
    const bpMesh = new THREE.Mesh(new THREE.BoxGeometry(bpW, bpH, bpD), bpMat);
    bpMesh.castShadow = bpMesh.receiveShadow = true;
    const bldLocalMinY = (bldgBox.min.y - this.printGroup.position.y) / scaleX;
    bpMesh.position.set(centre.x / scaleX, bldLocalMinY - bpH / 2, centre.z / scaleZ);
    this.baseplateGroup.add(bpMesh);
    Object.values(this.printLayers).forEach(g => { g.visible = false; });
  }

  private async _runAnim(): Promise<void> {
    const fl = Math.max(this.sceneW, this.sceneD) * 0.14 / this.printGroup.scale.y;
    const bM = this.printLayerMats.buildings, wM = this.printLayerMats.water, lM = this.printLayerMats.land;

    this.baseplateGroup.visible = true;
    if (bM) { bM.wireframe = false; bM.transparent = true; bM.opacity = 0; bM.color.set(bM._solidColor); }
    this.printLayers.buildings.visible = true;
    await animMs(900, t => { if (bM) bM.opacity = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; });
    if (bM) { bM.transparent = false; bM.opacity = 1; }

    await new Promise(r => setTimeout(r, 200));
    if (wM) { wM.wireframe = false; wM.transparent = false; wM.color.set(wM._solidColor); }
    this.printLayers.water.position.y = this._watRestLocalY + fl;
    this.printLayers.water.visible = true;
    await animMs(900, t => { this.printLayers.water.position.y = this._watRestLocalY + fl * Math.pow(1 - t, 3); });
    this.printLayers.water.position.y = this._watRestLocalY;

    await new Promise(r => setTimeout(r, 150));
    if (lM) { lM.wireframe = false; lM.transparent = false; lM.color.set(lM._solidColor); }
    this.printLayers.land.position.y = this._lndRestLocalY + fl * 1.3;
    this.printLayers.land.visible = true;
    await animMs(900, t => { this.printLayers.land.position.y = this._lndRestLocalY + fl * 1.3 * Math.pow(1 - t, 3); });
    this.printLayers.land.position.y = this._lndRestLocalY;
  }

  // Re-load the parts (called after a regenerate). Resets group transforms first.
  async reload(): Promise<void> {
    if (!this._scene) return;
    this.printGroup.scale.set(1, 1, 1); this.printGroup.position.set(0, 0, 0);
    Object.values(this.printLayers).forEach(g => { g.clear(); g.visible = false; g.position.y = 0; });
    this.baseplateGroup.clear(); this.baseplateGroup.visible = false;
    this.allMats = [];
    const s = this._scene;
    if (s.stlBuildings && s.stlLand && s.stlWater) {
      await this._loadParts(s.stlBuildings, s.stlLand, s.stlWater);
      await this._runAnim();
    }
  }

  setScene(s: PrintScene): void { this._scene = s; }

  private _wireControls(): void {
    const wBtn = this._freshBtn('btn-print-wire');
    wBtn.addEventListener('click', () => {
      this.wireframe = !this.wireframe;
      this.scene.background.set(this.wireframe ? 0x000000 : BG);
      if (this.scene.fog) this.scene.fog.color.set(this.wireframe ? 0x000000 : BG);
      this.allMats.forEach(m => { m.wireframe = this.wireframe; m.color.set(this.wireframe ? m._wireColor : m._solidColor); });
      wBtn.classList.toggle('on', this.wireframe);
      wBtn.textContent = this.wireframe ? '⬡ Solid' : '⬡ Wireframe';
    });

    const rBtn = this._freshBtn('btn-print-rotate');
    rBtn.addEventListener('click', () => {
      this.controls.autoRotate = !this.controls.autoRotate;
      rBtn.classList.toggle('on', this.controls.autoRotate);
      rBtn.textContent = this.controls.autoRotate ? '⏸ Pause' : '▶ Auto-rotate';
    });

    const regen = this._freshBtn('btn-print-regen') as HTMLButtonElement;
    regen.addEventListener('click', async () => {
      if (!this.onRegen) return;
      const rs = this._el('regen-status-print');
      regen.disabled = true; regen.textContent = '⟳ Regenerating…'; if (rs) rs.textContent = 'Fetching…';
      try {
        await this.onRegen();
        await this.reload();
        if (rs) { rs.textContent = 'Done ✓'; setTimeout(() => { rs.textContent = ''; }, 3000); }
      } catch (e: any) {
        if (rs) rs.textContent = `Error: ${e.message}`;
      } finally {
        regen.disabled = false; regen.textContent = '⟳ Regenerate STL';
      }
    });
  }

  private _wireDownloads(): void {
    const s = this._scene; if (!s) return;
    const single = document.getElementById('dl-singlecolour-print') as HTMLAnchorElement | null;
    if (single && s.stlBuildings) single.href = s.stlBuildings;
    const multi = this._freshBtn('dl-multicolour-print');
    multi.addEventListener('click', () => {
      for (const [url, name] of [[s.stlBuildings, 'buildings.stl'], [s.stlLand, 'land.stl'], [s.stlWater, 'water.stl']] as [string | null, string][]) {
        if (!url) continue;
        const a = document.createElement('a'); a.href = url; a.download = name;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
      }
    });
  }

  getSnapshot(size = 150): string | null {
    if (!this.scene || !this.camera) return null;
    try {
      this.renderer.render(this.scene, this.camera);
      const src = this.renderer.domElement;
      const cv = document.createElement('canvas'); cv.width = cv.height = size;
      const ctx = cv.getContext('2d')!;
      const minDim = Math.min(src.width, src.height);
      ctx.drawImage(src, (src.width - minDim) / 2, (src.height - minDim) / 2, minDim, minDim, 0, 0, size, size);
      return cv.toDataURL('image/webp', 0.7);
    } catch { return null; }
  }

  private _el(id: string): HTMLElement { return document.getElementById(id) as HTMLElement; }
  private _freshBtn(id: string): HTMLElement {
    const old = document.getElementById(id)!;
    const n = old.cloneNode(true) as HTMLElement;
    old.replaceWith(n); return n;
  }
}
