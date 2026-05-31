import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';

// ── Public types ──────────────────────────────────────────────────────────────
export interface Viewer3DScene {
  west: number; south: number; east: number; north: number;
  merch: string; coasterShape: string;
  svgUrl: string | null;
  svgEntryRect: { x: number; y: number; w: number; h: number } | null;
  osmData: { elements?: any[] };
  stlBuildings?: string | null;
  stlLand?: string | null;
  stlWater?: string | null;
  stlSolid?: string | null;
  paletteOverrides?: Record<string, string> | null;
}

// ── Material colour tables ─────────────────────────────────────────────────────
const SOLID = {
  ground: 0x1a1e1a, park: 0x3a7a3a, water: 0x1a4070,
  roadOther: 0x383838, roadMain: 0x484848,
  bldgLo: 0x555550, bldgMid: 0x666660, bldgHi: 0x8a8a84,
};
const WIRE = {
  ground: 0x0a1a0a, park: 0x00ff66, water: 0x00aaff,
  roadOther: 0xff7700, roadMain: 0xffcc00,
  bldgLo: 0x00ffff, bldgMid: 0xaa44ff, bldgHi: 0xffffff,
};

const BG     = 0x0d0e0f;
const WIRE_MS = 2200, PAUSE_MS = 300, FILL_MS = 2500;
const TOTAL_MS = WIRE_MS + PAUSE_MS + FILL_MS;

function _mat(solid: number, wire: number, opts: any = {}): any {
  const Ctor = opts.roughness !== undefined ? THREE.MeshStandardMaterial : THREE.MeshLambertMaterial;
  const m: any = new Ctor({ color: solid, ...opts });
  m._solidColor = solid; m._wireColor = wire;
  return m;
}

// ── Viewer3D ───────────────────────────────────────────────────────────────────
export class Viewer3D {
  private canvasWrap: HTMLElement;
  private renderer: THREE.WebGLRenderer;

  // Recreated per loadScene
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private controls!: OrbitControls;
  private sceneW = 0;
  private sceneD = 0;

  private ground!: THREE.Mesh;
  private osmGroup!: THREE.Group;
  private fabricGroup!: THREE.Group;
  private grid!: THREE.GridHelper;

  private osmMats: any[] = [];
  private allMats: any[] = [];
  private matGround!: any;
  private matBldgLo!: any; private matBldgMid!: any; private matBldgHi!: any;

  private animMats: any[] = [];
  private groundTexPromise: Promise<void> = Promise.resolve();
  private _groundTexApplied = false;

  private entryReady = false;
  private entryDone  = false;
  private entryStart: number | null = null;
  private barStart   = 0;
  private barFinishing = false;

  private showingPreview = false;
  private fabricLoaded   = false;
  private wiresOn        = false;

  private loopRunning = false;
  private _currentScene: Viewer3DScene | null = null;

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
    this.renderer.localClippingEnabled = true;
    canvasWrap.appendChild(this.renderer.domElement);

    window.addEventListener('resize', () => {
      const W = this.canvasWrap.clientWidth;
      if (!this.camera) return;
      this.camera.aspect = W / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(W, window.innerHeight);
    });
  }

  // ── Start the loop (once) ─────────────────────────────────────────────────
  private _startLoop(): void {
    if (this.loopRunning) return;
    this.loopRunning = true;
    const loop = (now: number = 0) => {
      requestAnimationFrame(loop);
      if (!this.scene || !this.camera) return;
      if (this.entryReady && !this.entryDone) this.entryDone = this._tickEntry(now);
      this.controls?.update();
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  // ── loadScene — call this each time the user opens the 3D view ────────────
  async loadScene(s: Viewer3DScene): Promise<void> {
    const { west, south, east, north, merch, coasterShape, svgUrl, osmData } = s;
    const stlB = s.stlBuildings ?? null;
    const stlL = s.stlLand      ?? null;
    const stlW = s.stlWater     ?? null;
    const stlS = s.stlSolid     ?? null;
    const hasParts = !!(stlB && stlL && stlW);
    const is3d = ['coaster','placemat','relief','3d_print'].includes(merch);
    this._currentScene = s;

    // Reset state
    this.fabricLoaded = this.showingPreview = false;
    this.entryReady = this.entryDone = false;
    this.entryStart = null; this.barStart = 0; this.barFinishing = false;
    this._groundTexApplied = false; this.groundTexPromise = Promise.resolve();
    this.wiresOn = false;

    // Reset UI
    this._elText('status-3d', 'Loading…'); this._elText('stats-3d', '');
    this._show('loading-3d', true); this._el('load-bar-3d').style.width = '0%';
    this._el('loading-3d').style.opacity = '1'; this._el('loading-3d').style.display = 'flex';
    this._show('btn-3d-mode', false);
    this._el('btn-3d-wire').classList.remove('on'); this._elText('btn-3d-wire', '⬡ Wireframe');
    this._el('btn-3d-rotate').classList.remove('on'); this._elText('btn-3d-rotate', '▶ Auto-rotate');

    // Projection
    const cx = (east + west) / 2, cy = (north + south) / 2;
    const cosLat = Math.cos(cy * Math.PI / 180);
    const M = 111_320;
    this.sceneW = (east - west) * cosLat * M;
    this.sceneD = (north - south) * M;
    const SW = this.sceneW, SD = this.sceneD;
    const proj = (lon: number, lat: number): [number,number] =>
      [(lon - cx) * cosLat * M, (lat - cy) * M];

    // ── New Three.js scene ──────────────────────────────────────────────────
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);
    scene.fog = new THREE.Fog(BG, SW * 2, SW * 5);
    this.scene = scene;

    // Lights
    scene.add(new THREE.AmbientLight(0xffffff, 0.8));
    const sun = new THREE.DirectionalLight(0xfff5e0, 1.8);
    sun.position.set(SW * 0.4, SW * 0.8, SD * 0.3);
    sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { near:1, far:SW*4, left:-SW, right:SW, top:SD, bottom:-SD });
    sun.shadow.bias = -0.0005;
    scene.add(sun);
    scene.add(new THREE.HemisphereLight(0x334466, 0x111118, 0.5));

    // Camera
    const W = this.canvasWrap.clientWidth || (window.innerWidth - 272);
    const fitH = Math.max(SW, SD) * 0.9;
    this.camera = new THREE.PerspectiveCamera(48, W / window.innerHeight, 1, SW * 20);
    this.camera.position.set(0, fitH * 0.7, fitH);
    this.camera.lookAt(0, 0, 0);

    // Controls
    if (this.controls) this.controls.dispose();
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    Object.assign(this.controls, {
      enableDamping: true, dampingFactor: 0.07, autoRotate: false,
      maxPolarAngle: Math.PI / 2 - 0.05, minDistance: 20, maxDistance: SW * 8,
    });
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.DOLLY } as any;

    // Materials
    this.matGround  = _mat(SOLID.ground,    WIRE.ground);
    const matRoad   = _mat(SOLID.roadOther, WIRE.roadOther);
    const matRoadMn = _mat(SOLID.roadMain,  WIRE.roadMain);
    const matWater  = _mat(SOLID.water,     WIRE.water);
    const matPark   = _mat(SOLID.park,      WIRE.park);
    this.matBldgLo  = _mat(SOLID.bldgLo,  WIRE.bldgLo,  { roughness:0.8, metalness:0.05 });
    this.matBldgMid = _mat(SOLID.bldgMid, WIRE.bldgMid, { roughness:0.7, metalness:0.08 });
    this.matBldgHi  = _mat(SOLID.bldgHi,  WIRE.bldgHi,  { roughness:0.6, metalness:0.12 });
    this.osmMats = [this.matGround, matRoad, matRoadMn, matWater, matPark, this.matBldgLo, this.matBldgMid, this.matBldgHi];
    this.allMats = [...this.osmMats];
    const clip = [
      new THREE.Plane(new THREE.Vector3( 1,0, 0), SW/2),
      new THREE.Plane(new THREE.Vector3(-1,0, 0), SW/2),
      new THREE.Plane(new THREE.Vector3(0,0, 1), SD/2),
      new THREE.Plane(new THREE.Vector3(0,0,-1), SD/2),
    ];
    this.osmMats.forEach(m => { m.clippingPlanes = clip; });

    // Ground + border
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(SW, SD), this.matGround);
    this.ground.rotation.x = -Math.PI / 2; this.ground.receiveShadow = true;
    scene.add(this.ground);
    const hw = SW/2, hd = SD/2;
    scene.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-hw,0.2,-hd), new THREE.Vector3(hw,0.2,-hd),
        new THREE.Vector3(hw,0.2,hd),   new THREE.Vector3(-hw,0.2,hd),
        new THREE.Vector3(-hw,0.2,-hd),
      ]),
      new THREE.LineBasicMaterial({ color: 0x2244aa }),
    ));

    // Grid
    const gh = Math.max(SW, SD);
    this.grid = new THREE.GridHelper(gh*2, 20, 0x2244aa, 0x1a3366);
    this.grid.position.y = -0.5;
    scene.add(this.grid);

    // Groups
    this.osmGroup = new THREE.Group(); scene.add(this.osmGroup);
    this.fabricGroup = new THREE.Group(); this.fabricGroup.visible = false; scene.add(this.fabricGroup);

    // Entry animation
    this.animMats = [this.matBldgLo, this.matBldgMid, this.matBldgHi];
    this.animMats.forEach(m => { m.wireframe=true; m.transparent=true; m.opacity=0; m.color.set(m._wireColor); });

    // SVG cover
    const cover = document.getElementById('svg-cover') as HTMLImageElement|null;
    if (cover) {
      if (s.svgEntryRect) {
        const r = s.svgEntryRect;
        Object.assign(cover.style, { display:'block', left:r.x+'px', top:r.y+'px', width:r.w+'px', height:r.h+'px', opacity:'1' });
      }
      if (svgUrl) cover.src = svgUrl;
    }

    // Ground texture (load now, reveal after fold)
    this.groundTexPromise = svgUrl ? this._applyGroundTexture(svgUrl) : Promise.resolve();

    // Fake progress bar
    const km2 = (east-west)*cosLat*111.32*(north-south)*111.32;
    const tau  = Math.max(1500, Math.min(8000, 1000+km2*800)/3);
    const t0   = performance.now();
    const lb   = this._el('load-bar-3d');
    const preBar = () => { if (this.entryReady) return; lb.style.width=(50*(1-Math.exp(-(performance.now()-t0)/tau))).toFixed(1)+'%'; requestAnimationFrame(preBar); };
    preBar();

    // Parse OSM + build buildings
    const nodes = new Map<number,[number,number]>();
    const ways: any[] = [];
    for (const el of osmData.elements ?? []) {
      if (el.type==='node') nodes.set(el.id,[el.lon,el.lat]);
      else if (el.type==='way') ways.push(el);
    }
    const wayPts = (way: any): [number,number][] =>
      (way.nodes??[]).map((id:number) => { const n=nodes.get(id); return n?proj(n[0],n[1]):null; }).filter(Boolean);

    let nB = 0;
    for (const way of ways) {
      const tags = way.tags??{};
      if (tags.building && tags.building!=='no') {
        const pts=wayPts(way);
        const h=parseFloat(tags['building:height']??String(parseFloat(tags['building:levels']??'2')*3.2));
        const m=this._bldgMesh(pts,Math.max(h,3));
        if (m) { this.osmGroup.add(m); nB++; }
      }
    }
    this._elText('stats-3d', `${nB} buildings`);
    this._elText('status-3d', '');

    // Start loop + signal entry-ready
    this._startLoop();
    this.entryReady = true;

    // SVG fold animation
    if (svgUrl && cover) {
      cover.style.transition = 'opacity 0.25s ease';
      cover.style.opacity = '0';
      setTimeout(() => { cover.style.display='none'; }, 300);
      new THREE.TextureLoader().load(svgUrl, (fTex) => {
        fTex.colorSpace = THREE.SRGBColorSpace;
        const fMat = new THREE.MeshBasicMaterial({ map:fTex, side:THREE.DoubleSide, transparent:true, opacity:1, depthWrite:false, polygonOffset:true, polygonOffsetFactor:-1, polygonOffsetUnits:-1 });
        const fGrp = new THREE.Group();
        fGrp.position.set(0,0,SD/2);
        const fMesh = new THREE.Mesh(new THREE.PlaneGeometry(SW,SD), fMat);
        fMesh.position.set(0,SD/2,0);
        fGrp.add(fMesh); scene.add(fGrp);
        const t0f = performance.now();
        const fold = (now:number) => {
          const p = Math.min(1,(now-t0f)/600);
          fGrp.rotation.x = -Math.PI/2*(1-Math.pow(1-p,3));
          if (p<1) { requestAnimationFrame(fold); return; }
          const t0fd=performance.now();
          const fade=(now2:number)=>{
            const fp=Math.min(1,(now2-t0fd)/400); fMat.opacity=1-fp;
            if (fp<1){requestAnimationFrame(fade);return;}
            scene.remove(fGrp); fMat.dispose(); fMesh.geometry.dispose();
            this.groundTexPromise.then(()=>{
              if (!this.matGround.map) return;
              const t0g=performance.now();
              const fadeG=(now3:number)=>{
                const e=Math.min(1,(now3-t0g)/600);
                this.matGround.color.setRGB(e,e,e); this.matGround.needsUpdate=true;
                if (e<1) requestAnimationFrame(fadeG);
              }; fadeG(performance.now());
            });
          }; fade(performance.now());
        }; fold(performance.now());
      });
    }

    // Wire panel buttons for this scene
    this._wireButtons({ s, hasParts, is3d, stlB, stlL, stlW, stlS, wayPts, ways });
  }

  // ── Ground texture ────────────────────────────────────────────────────────
  private async _applyGroundTexture(url: string): Promise<void> {
    if (this._groundTexApplied) return;
    this._groundTexApplied = true;
    try {
      const tex = await new Promise<THREE.Texture>((res,rej)=>{
        const img=new Image();
        img.onload=()=>{
          const SIZE=2048, aspect=this.sceneW/this.sceneD;
          const cw=aspect>=1?SIZE:Math.round(SIZE*aspect);
          const ch=aspect>=1?Math.round(SIZE/aspect):SIZE;
          const cv=document.createElement('canvas'); cv.width=cw; cv.height=ch;
          cv.getContext('2d')!.drawImage(img,0,0,cw,ch);
          res(new THREE.CanvasTexture(cv));
        };
        img.onerror=()=>{this._groundTexApplied=false;rej(new Error('tex'));};
        img.src=url;
      });
      tex.colorSpace=THREE.SRGBColorSpace;
      this.matGround.map=tex; this.matGround.color.set(0x000000); this.matGround.needsUpdate=true;
    } catch { /* silent */ }
  }

  // ── Entry animation tick ──────────────────────────────────────────────────
  private _tickEntry(now: number): boolean {
    if (this.entryStart===null){ this.entryStart=now; this.barStart=parseFloat(this._el('load-bar-3d').style.width)||0; }
    const el = now - this.entryStart;
    const lb = this._el('load-bar-3d');
    if (el<TOTAL_MS && !this.barFinishing) lb.style.width=(this.barStart+(97-this.barStart)*(el/TOTAL_MS)).toFixed(1)+'%';
    if (el>=TOTAL_MS) {
      this.animMats.forEach(m=>{m.wireframe=false;m.transparent=false;m.opacity=1;m.color.set(m._solidColor);});
      this.scene.background.set(BG); if(this.scene.fog)this.scene.fog.color.set(BG);
      if(this.matGround.map){this.matGround.color.set(0xffffff);this.matGround.needsUpdate=true;}
      if (!this.barFinishing) {
        this.barFinishing=true;
        const t0f=performance.now(), loadEl=this._el('loading-3d');
        const fin=(n:number)=>{
          const t=Math.min(1,(n-t0f)/200); lb.style.width=(97+3*t)+'%';
          if(t<1){requestAnimationFrame(fin);return;}
          loadEl.style.transition='opacity 0.3s'; loadEl.style.opacity='0';
          setTimeout(()=>{loadEl.style.display='none';loadEl.style.opacity='1';loadEl.style.transition='';},350);
        }; fin(performance.now());
      }
      return true;
    }
    if (el<WIRE_MS+PAUSE_MS) {
      const t=Math.max(0,Math.min(1,el/WIRE_MS)), e=t<0.5?2*t*t:-1+(4-2*t)*t;
      this.animMats.forEach(m=>{m.opacity=e;});
    } else {
      const t=Math.min(1,(el-WIRE_MS-PAUSE_MS)/FILL_MS), e=1-Math.pow(1-t,2.5);
      this.animMats.forEach(m=>{
        m.wireframe=t<0.25;
        m.color.set(m._wireColor).lerp({r:(m._solidColor>>16&255)/255,g:(m._solidColor>>8&255)/255,b:(m._solidColor&255)/255},e);
        m.opacity=1;
      });
      const bg=new THREE.Color(BG);
      this.scene.background.set(new THREE.Color(0).lerp(bg,e));
      if(this.scene.fog)this.scene.fog.color.set(new THREE.Color(0).lerp(bg,e));
    }
    return false;
  }

  // ── Building mesh ─────────────────────────────────────────────────────────
  private _bldgMesh(pts:[number,number][], h:number): THREE.Mesh|null {
    if (pts.length<3) return null;
    try {
      const geo=new THREE.ExtrudeGeometry(new THREE.Shape(pts.map(([x,z])=>new THREE.Vector2(x,z))),{depth:h,bevelEnabled:false});
      geo.rotateX(-Math.PI/2);
      const mat=h>30?this.matBldgHi:h>12?this.matBldgMid:this.matBldgLo;
      const m=new THREE.Mesh(geo,mat); m.castShadow=m.receiveShadow=true; return m;
    } catch { return null; }
  }

  // ── Fabric preview ────────────────────────────────────────────────────────
  private async _loadFabric(svgUrl:string|null, wayPts:(w:any)=>[number,number][], ways:any[]): Promise<void> {
    if (this.fabricLoaded) return;
    this._elText('status-3d','Building fabric preview…');
    if (svgUrl) {
      try {
        const tex=await new Promise<THREE.Texture>((res,rej)=>{
          const img=new Image(); img.crossOrigin='anonymous';
          img.onload=()=>{
            const SIZE=2048, asp=this.sceneW/this.sceneD;
            const cw=asp>=1?SIZE:Math.round(SIZE*asp), ch=asp>=1?Math.round(SIZE/asp):SIZE;
            const cv=document.createElement('canvas'); cv.width=cw; cv.height=ch;
            cv.getContext('2d')!.drawImage(img,0,0,cw,ch);
            const t=new THREE.CanvasTexture(cv); t.colorSpace=THREE.SRGBColorSpace; res(t);
          }; img.onerror=rej; img.src=svgUrl;
        });
        const plane=new THREE.Mesh(new THREE.PlaneGeometry(this.sceneW,this.sceneD),new THREE.MeshBasicMaterial({map:tex}));
        plane.rotation.x=-Math.PI/2; plane.position.y=0.05; this.fabricGroup.add(plane);
      } catch { /* skip */ }
    }
    for (const way of ways) {
      const tags=way.tags??{};
      if (tags.building && tags.building!=='no') {
        const pts=wayPts(way), h=parseFloat(tags['building:height']??String(parseFloat(tags['building:levels']??'2')*3.2));
        const m=this._bldgMesh(pts,Math.max(h,3)); if(m)this.fabricGroup.add(m);
      }
    }
    this.fabricLoaded=true; this._elText('status-3d','');
  }

  // ── Wire panel buttons ─────────────────────────────────────────────────────
  private _wireButtons(ctx: {
    s:Viewer3DScene; hasParts:boolean; is3d:boolean;
    stlB:string|null; stlL:string|null; stlW:string|null; stlS:string|null;
    wayPts:(w:any)=>[number,number][]; ways:any[];
  }): void {
    const { s, hasParts, is3d, stlB, stlL, stlW, stlS, wayPts, ways } = ctx;

    const mBtn = this._freshBtn('btn-3d-mode');
    const wBtn = this._freshBtn('btn-3d-wire');
    const rBtn = this._freshBtn('btn-3d-rotate');

    if (is3d && hasParts) {
      // Navigate to 3D Print page — pass data via localStorage
      this._show('btn-3d-mode', true);
      mBtn.textContent = '🖨 3D Print →';
      mBtn.addEventListener('click', () => {
        localStorage.setItem('hoas_print_data', JSON.stringify({
          west: s.west, south: s.south, east: s.east, north: s.north,
          stl_buildings_url: stlB, stl_land_url: stlL, stl_water_url: stlW, stl_solid_url: stlS,
          svg_url: s.svgUrl, merch_type: s.merch, coaster_shape: s.coasterShape,
          palette_overrides: s.paletteOverrides ?? null,
        }));
        window.location.href = '/3d-print.html';
      });
    } else if (!is3d && s.svgUrl) {
      // Fabric preview toggle for 2D merch types
      this._show('btn-3d-mode', true);
      mBtn.textContent = '🖼 Fabric Preview';
      mBtn.addEventListener('click', async () => {
        if (!this.showingPreview) {
          mBtn.textContent = 'Loading…'; mBtn.classList.add('on');
          await this._loadFabric(s.svgUrl, wayPts, ways);
          this.fabricGroup.visible = true; this.osmGroup.visible = false;
          this.showingPreview = true; mBtn.textContent = '🌍 Map View';
        } else {
          this.showingPreview = false;
          this.osmGroup.visible = true; this.ground.visible = true;
          this.fabricGroup.visible = false;
          if (this.matGround.map) { this.matGround.color.set(0xffffff); this.matGround.needsUpdate = true; }
          mBtn.textContent = '🖼 Fabric Preview'; mBtn.classList.remove('on');
        }
      });
    }

    wBtn.addEventListener('click', () => {
      this.wiresOn=!this.wiresOn;
      this.scene.background.set(this.wiresOn?0x000000:BG);
      if(this.scene.fog)this.scene.fog.color.set(this.wiresOn?0x000000:BG);
      this.allMats.forEach(m=>{m.wireframe=this.wiresOn;m.color.set(this.wiresOn?m._wireColor:m._solidColor);});
      (this.grid.material as any[])[0].color.set(this.wiresOn?0x0055ff:0x2244aa);
      (this.grid.material as any[])[1].color.set(this.wiresOn?0x003399:0x1a3366);
      wBtn.classList.toggle('on',this.wiresOn); wBtn.textContent=this.wiresOn?'⬡ Solid':'⬡ Wireframe';
    });

    rBtn.addEventListener('click', () => {
      this.controls.autoRotate=!this.controls.autoRotate;
      rBtn.classList.toggle('on',this.controls.autoRotate);
      rBtn.textContent=this.controls.autoRotate?'⏸ Pause':'▶ Auto-rotate';
    });
  }

  // ── Called from app.ts when STL generation completes after view is open ────
  enablePrintButton(stlB: string, stlL: string, stlW: string, stlS: string | null): void {
    const s = this._currentScene;
    if (!s) return;
    const is3d = ['coaster','placemat','relief','3d_print'].includes(s.merch);
    if (!is3d) return;
    const btn = this._freshBtn('btn-3d-mode');
    this._show('btn-3d-mode', true);
    btn.textContent = '🖨 3D Print →';
    btn.addEventListener('click', () => {
      localStorage.setItem('hoas_print_data', JSON.stringify({
        west: s.west, south: s.south, east: s.east, north: s.north,
        stl_buildings_url: stlB, stl_land_url: stlL, stl_water_url: stlW, stl_solid_url: stlS,
        svg_url: s.svgUrl, merch_type: s.merch, coaster_shape: s.coasterShape,
        palette_overrides: s.paletteOverrides ?? null,
      }));
      window.location.href = '/3d-print.html';
    });
  }

  // ── Snapshot (thumbnail) ─────────────────────────────────────────────────
  getSnapshot(size = 150): string | null {
    if (!this.scene || !this.camera) return null;
    try {
      this.renderer.render(this.scene, this.camera);
      const src = this.renderer.domElement;
      const cv = document.createElement('canvas');
      cv.width = cv.height = size;
      const ctx = cv.getContext('2d')!;
      const sw = src.width, sh = src.height;
      const minDim = Math.min(sw, sh);
      const sx = (sw - minDim) / 2, sy = (sh - minDim) / 2;
      ctx.drawImage(src, sx, sy, minDim, minDim, 0, 0, size, size);
      return cv.toDataURL('image/webp', 0.7);
    } catch { return null; }
  }

  // ── DOM helpers ───────────────────────────────────────────────────────────
  private _el(id:string): HTMLElement { return document.getElementById(id) as HTMLElement; }
  private _elText(id:string,t:string): void { const el=document.getElementById(id); if(el)el.textContent=t; }
  private _show(id:string,v:boolean): void { const el=document.getElementById(id); if(el)el.style.display=v?'':'none'; }
  private _freshBtn(id:string): HTMLElement {
    const old=document.getElementById(id)!;
    const n=old.cloneNode(true) as HTMLElement;
    old.replaceWith(n); return n;
  }
}
