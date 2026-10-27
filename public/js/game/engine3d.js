// CaYa Rhythm - 3D Motor (Three.js)
// Perspektifli nota otoyolu: notalar uzaktan gelir, alttaki vurus cizgisine ulasir.
// Sahne: truss kemerleri, donen spot isiklari, canli spektrum LED duvari,
// hoparlor kuleleri ve sahne metresine tepki veren seyirci. Isiklar bolum
// yogunluguna ve enerji egrisine gore degisir. Hepsi prosedurel (harici model yok).

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

export const LANE_COLORS = [0x35c4f0, 0xf0509b, 0xffd23d, 0x59d96b, 0xb06af5];
const GOLD_COLOR = 0xffc83d;
const BLUE_COLOR = 0x3a86ff; // 6x carpan: raylar bu maviye doner (boost altininin mavi karsiligi)
const PURPLE_COLOR = 0x7c4dff; // raylarin normal rengi
// ray renk gecisi icin onceden hesaplanmis THREE renkleri (esik yerine lerp -> yumusak)
const C_BLUE = new THREE.Color(BLUE_COLOR);
const C_GOLD = new THREE.Color(GOLD_COLOR);
const LANE_W = 1.6;
const RECEPTOR_Z = 5.5;
// kamera dikey cerceveleme: vurus cizgisini ekranda yukari al (altta tus seridi
// icin yer acilir). Kamera + bakis noktasi esit kaydirilir -> aci/perspektif
// korunur, gorus YUKARI panlanir (notalar biraz daha yukarida durur).
const CAM_POS_Y = 7.15;  // onceki: 7.6 (vurus cizgisini eskisinin cok az ustune al)
const CAM_LOOK_Y = -0.85; // onceki: -0.4
const SPAWN_Z = -46;
const BASE_SPEED = 13.5;
const NOTE_Y = 0.16;

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.5)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

// otoyol dokusu: koyu gradyan + ince altigen/izgara deseni (tekrarlanir, akar)
function highwayTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const g = c.getContext('2d');
  const grd = g.createLinearGradient(0, 0, 256, 0);
  grd.addColorStop(0, '#120c2c'); grd.addColorStop(0.5, '#0a0718'); grd.addColorStop(1, '#120c2c');
  g.fillStyle = grd; g.fillRect(0, 0, 256, 256);
  g.strokeStyle = 'rgba(124,77,255,0.10)'; g.lineWidth = 1;
  for (let y = 0; y <= 256; y += 32) { g.beginPath(); g.moveTo(0, y); g.lineTo(256, y); g.stroke(); }
  g.strokeStyle = 'rgba(53,196,240,0.05)';
  for (let x = 0; x <= 256; x += 16) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 256); g.stroke(); }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// yuvarlak koseli, pahli yassi blok (XZ duzleminde yatar, Y merkezli)
function roundedSlab(w, d, h, r, bevel) {
  const s = new THREE.Shape();
  const x = -w / 2, y = -d / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + d - r); s.quadraticCurveTo(x + w, y + d, x + w - r, y + d);
  s.lineTo(x + r, y + d); s.quadraticCurveTo(x, y + d, x, y + d - r);
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  const core = Math.max(0.01, h - 2 * bevel);
  const geo = new THREE.ExtrudeGeometry(s, {
    depth: core, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel * 0.8,
    bevelSegments: 2, curveSegments: 5
  });
  geo.rotateX(-Math.PI / 2);      // ekstruzyon +Y'ye
  geo.translate(0, -core / 2, 0); // dikey merkez
  return geo;
}

// spot isik konisi icin dikey solma dokusu
function beamTexture() {
  const c = document.createElement('canvas');
  c.width = 4; c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createLinearGradient(0, 0, 0, 128);
  grd.addColorStop(0, 'rgba(255,255,255,0.9)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 4, 128);
  return new THREE.CanvasTexture(c);
}

export class Engine {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.glow = glowTexture();
    this.scene = null;
    this.running = false;
    this._onResize = () => this._resize();
    window.addEventListener('resize', this._onResize);
  }

  // ---- sahne kurulumu ----
  setup(laneCount, notes, opts) {
    this.laneCount = laneCount;
    this.notes = notes;
    this.opts = opts; // {noteSpeed, bpm, beatOffset, duration, analyser}
    this.speed = BASE_SPEED * (opts.noteSpeed || 1);
    this.lookahead = (RECEPTOR_Z - SPAWN_Z) / this.speed;

    this._disposeScene();
    const scene = new THREE.Scene();
    this.scene = scene;
    scene.fog = new THREE.Fog(0x05030f, 28, 72);
    scene.background = new THREE.Color(0x05030f);

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 200);
    this.camera.position.set(0, CAM_POS_Y, 13.2);
    this.camera.lookAt(0, CAM_LOOK_Y, -8);
    this.baseFov = 55;

    // isiklar
    scene.add(new THREE.AmbientLight(0x8888ff, 0.35));
    const dir = new THREE.DirectionalLight(0xffffff, 0.9);
    dir.position.set(4, 14, 8);
    scene.add(dir);
    this.accentLight = new THREE.PointLight(0x7c4dff, 18, 40);
    this.accentLight.position.set(0, 5, RECEPTOR_Z - 2);
    scene.add(this.accentLight);

    const W = laneCount * LANE_W;

    // otoyol zemini
    const hwGeo = new THREE.PlaneGeometry(W + 0.7, 60);
    this.hwTex = highwayTexture();
    this.hwTex.wrapS = this.hwTex.wrapT = THREE.RepeatWrapping;
    this.hwTex.repeat.set(1, 6);
    const hwMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, map: this.hwTex, roughness: 0.32, metalness: 0.55,
      transparent: true, opacity: 0.96
    });
    const hw = new THREE.Mesh(hwGeo, hwMat);
    hw.rotation.x = -Math.PI / 2;
    hw.position.set(0, 0, RECEPTOR_Z - 30 + 4);
    scene.add(hw);

    // serit cizgileri
    const lineMat = new THREE.MeshBasicMaterial({ color: 0x4a3f7a, transparent: true, opacity: 0.5 });
    for (let i = 0; i <= laneCount; i++) {
      const x = (i - laneCount / 2) * LANE_W;
      const line = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.02, 58), lineMat);
      line.position.set(x, 0.02, RECEPTOR_Z - 26);
      scene.add(line);
    }

    // yan raylar (neon, vurusla nabiz atar)
    this.railMats = [];
    for (const side of [-1, 1]) {
      const railMat = new THREE.MeshStandardMaterial({
        color: 0x1a1133, emissive: 0x7c4dff, emissiveIntensity: 0.7, roughness: 0.4
      });
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.3, 58), railMat);
      rail.position.set(side * (W / 2 + 0.45), 0.15, RECEPTOR_Z - 26);
      scene.add(rail);
      this.railMats.push(railMat);
    }

    // sahne cevresi: zemin izgarasi, truss kemerleri, spotlar, LED duvar,
    // hoparlorler, seyirci
    this.partColor = new THREE.Color(opts.partColor || '#7c4dff');
    this._buildStage(W);

    // vurus / olcu cizgileri (otoyolda akar)
    this.beatLineTimes = (opts.beats && opts.beats.length > 4) ? opts.beats : null;
    this.beatLines = [];
    const blGeo = new THREE.BoxGeometry(W, 0.012, 0.06);
    for (let i = 0; i < 48; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.15, depthWrite: false });
      const m = new THREE.Mesh(blGeo, mat);
      m.visible = false;
      scene.add(m);
      this.beatLines.push(m);
    }

    // arka plan yildizlari
    {
      const starGeo = new THREE.BufferGeometry();
      const n = 500;
      const pos = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const r = 40 + Math.random() * 50;
        const th = Math.random() * Math.PI * 2;
        const ph = Math.random() * Math.PI * 0.5;
        pos[i * 3] = r * Math.cos(th) * Math.cos(ph);
        pos[i * 3 + 1] = 2 + r * Math.sin(ph) * 0.6;
        pos[i * 3 + 2] = -10 - Math.abs(r * Math.sin(th));
      }
      starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const starMat = new THREE.PointsMaterial({
        size: 0.55, map: this.glow, color: 0x9b8cff, transparent: true,
        opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending
      });
      this.stars = new THREE.Points(starGeo, starMat);
      scene.add(this.stars);
    }

    // ufuk isimasi: otoyolun sonunda yumusak neon parilti (derinlik hissi)
    {
      this.horizonMat = new THREE.MeshBasicMaterial({
        map: this.glow, color: 0x7c4dff, transparent: true, opacity: 0.4,
        blending: THREE.AdditiveBlending, depthWrite: false
      });
      const horizon = new THREE.Mesh(new THREE.PlaneGeometry(70, 22), this.horizonMat);
      horizon.position.set(0, 3, -49);
      scene.add(horizon);
      const horizon2 = new THREE.Mesh(new THREE.PlaneGeometry(34, 10), new THREE.MeshBasicMaterial({
        map: this.glow, color: 0xf0509b, transparent: true, opacity: 0.22,
        blending: THREE.AdditiveBlending, depthWrite: false
      }));
      horizon2.position.set(0, 1.5, -48);
      scene.add(horizon2);
    }

    // vurus cizgisi (receptorlar): notalarla ayni dilde — yatay dikdortgen cerceveler
    this.receptors = [];
    const recFrameGeo = new THREE.BoxGeometry(LANE_W * 0.8, 0.06, 0.54);
    const recInnerGeo = new THREE.BoxGeometry(LANE_W * 0.66, 0.08, 0.38);
    const recFillGeo = new THREE.PlaneGeometry(LANE_W * 0.76, 0.5);
    for (let i = 0; i < laneCount; i++) {
      const x = this._laneX(i);
      const color = LANE_COLORS[i];
      const group = new THREE.Group();
      const frameMat = new THREE.MeshStandardMaterial({
        color: 0x111111, emissive: color, emissiveIntensity: 0.85, roughness: 0.3, metalness: 0.4
      });
      const frame = new THREE.Mesh(recFrameGeo, frameMat);
      const innerMat = new THREE.MeshStandardMaterial({
        color: 0x0a0818, emissive: color, emissiveIntensity: 0.06, roughness: 0.55
      });
      const inner = new THREE.Mesh(recInnerGeo, innerMat);
      inner.position.y = 0.015;
      const fillMat = new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false
      });
      const fill = new THREE.Mesh(recFillGeo, fillMat);
      fill.rotation.x = -Math.PI / 2;
      fill.position.y = 0.062;
      group.add(frame); group.add(inner); group.add(fill);
      group.position.set(x, 0.05, RECEPTOR_Z);
      scene.add(group);
      this.receptors.push({ group, frameMat, innerMat, fillMat, pressed: false, glowT: 0 });
    }

    // vurus cizgisi seridi
    {
      const stripMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.18 });
      const strip = new THREE.Mesh(new THREE.BoxGeometry(W + 0.6, 0.015, 0.1), stripMat);
      strip.position.set(0, 0.03, RECEPTOR_Z);
      scene.add(strip);
    }

    // nota materyalleri (serit basina paylasimli): govde + parlak ic plaka
    this.noteMats = LANE_COLORS.slice(0, laneCount).map(c =>
      new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0.55, roughness: 0.3, metalness: 0.35 }));
    this.noteTopMats = LANE_COLORS.slice(0, laneCount).map(c => {
      const lite = new THREE.Color(c).lerp(new THREE.Color(0xffffff), 0.55);
      return new THREE.MeshStandardMaterial({ color: lite, emissive: lite, emissiveIntensity: 0.9, roughness: 0.2 });
    });
    // boost notalari: BEYAZ parlak (govde + daha parlak ust plaka)
    this.boostMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 1.1, roughness: 0.12, metalness: 0.45
    });
    this.boostTopMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 1.5, roughness: 0.1
    });
    this.missedMat = new THREE.MeshStandardMaterial({
      color: 0x333333, emissive: 0x550000, emissiveIntensity: 0.4, transparent: true, opacity: 0.5
    });
    this.tailMats = LANE_COLORS.slice(0, laneCount).map(c =>
      new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.38, depthWrite: false }));
    this.tailActiveMats = LANE_COLORS.slice(0, laneCount).map(c =>
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending }));

    // nota mesh havuzu: yatay duzlemde yatan dikdortgen plakalar (+ parlak ic plaka)
    // pahli (bevel) mucevher notalar: yuvarlak koseli govde + parlak ic plaka
    this.headGeo = roundedSlab(LANE_W * 0.7, 0.42, 0.12, 0.06, 0.035);
    this.headTopGeo = roundedSlab(LANE_W * 0.5, 0.24, 0.08, 0.03, 0.015);
    this.tailGeo = new THREE.BoxGeometry(0.52, 0.06, 1); // z olcegi nota basina ayarlanir
    this.pool = [];
    this.meshByNote = new Map();

    // efekt havuzlari
    this._initRings();
    this._initParticles();

    // beat izgarasi (direk nabzi icin)
    this.beatTimes = [];
    if (opts.beatPeriod > 0.1) {
      for (let t = opts.beatOffset; t < opts.duration; t += opts.beatPeriod) this.beatTimes.push(t);
    }
    this.beatIdx = 0;
    this.beatPulse = 0;

    // notalarin gorunurluk pencere isaretcileri
    this.spawnPtr = 0;
    this.boostLevel = 0;
    this.maxMultLevel = 0; // 6x carpan ray-mavisi seviyesi (0..1)
    this._railColor = new THREE.Color(); // ray renk gecisi icin yeniden kullanilan tampon
    this._railGlowCur = 0.6; // raylarin yumusatilmis (eased) parlakligi
    this.bassLevel = 0;
    this.milestonePulse = 0;
    this.shake = 0;
    this._freqData = opts.analyser ? new Uint8Array(opts.analyser.frequencyBinCount) : null;

    // post-processing (bloom)
    if (this.composer) this.composer.dispose();
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.6, 0.5, 0.6);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this._resize();
  }

  _laneX(i) { return (i - (this.laneCount - 1) / 2) * LANE_W; }

  // Her seridin vurus bolgesini (receptor) ekran pikseline projekte et.
  // DOM tus etiketlerini tam o seridin altina yerlestirmek icin kullanilir.
  // zOffset > 0: kameraya dogru (ekranda biraz asagi -> vurus bolgesinin altina).
  getLaneAnchors(zOffset = 1.15) {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    if (!this.camera) return [];
    const v = new THREE.Vector3();
    const out = [];
    for (let i = 0; i < this.laneCount; i++) {
      v.set(this._laneX(i), 0, RECEPTOR_Z + zOffset);
      v.project(this.camera);
      out.push({ x: (v.x * 0.5 + 0.5) * w, y: (1 - (v.y * 0.5 + 0.5)) * h });
    }
    return out;
  }

  // ---- nota mesh havuzu ----
  _acquireMesh(note) {
    let item = this.pool.pop();
    if (!item) {
      const head = new THREE.Mesh(this.headGeo, this.noteMats[0]);
      const top = new THREE.Mesh(this.headTopGeo, this.noteTopMats[0]);
      top.position.y = 0.075;
      head.add(top);
      const tail = new THREE.Mesh(this.tailGeo, this.tailMats[0]);
      tail.visible = false;
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.glow, color: 0xffffff, transparent: true, opacity: 0.5,
        blending: THREE.AdditiveBlending, depthWrite: false
      }));
      sprite.scale.set(1.8, 1.8, 1);
      sprite.visible = false;
      this.scene.add(head); this.scene.add(tail); this.scene.add(sprite);
      item = { head, top, tail, sprite };
    }
    const lane = note.lane;
    item.head.material = note.boost ? this.boostMat : this.noteMats[lane];
    item.top.material = note.boost ? this.boostTopMat : this.noteTopMats[lane];
    item.head.visible = true;
    item.head.scale.setScalar(note.boost ? 1.12 : 1);
    item.sprite.visible = !!note.boost;
    if (note.type === 'hold') {
      item.tail.material = this.tailMats[lane];
      item.tail.visible = true;
      item.tail.scale.z = Math.max(0.01, note.dur * this.speed);
    } else {
      item.tail.visible = false;
    }
    this.meshByNote.set(note.id, item);
    return item;
  }

  _releaseMesh(note) {
    const item = this.meshByNote.get(note.id);
    if (!item) return;
    item.head.visible = false;
    item.tail.visible = false;
    item.sprite.visible = false;
    this.meshByNote.delete(note.id);
    this.pool.push(item);
  }

  // ---- halka efektleri ----
  _initRings() {
    this.rings = [];
    for (let i = 0; i < 14; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
      });
      const m = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.05, 8, 36), mat);
      m.rotation.x = -Math.PI / 2;
      m.visible = false;
      this.scene.add(m);
      this.rings.push({ mesh: m, mat, life: 0, maxLife: 0.4 });
    }
  }

  _spawnRing(lane, color, scale = 1) {
    const r = this.rings.find(r => r.life <= 0);
    if (!r) return;
    r.mesh.position.set(this._laneX(lane), 0.15, RECEPTOR_Z);
    r.mesh.scale.setScalar(0.6 * scale);
    r.mat.color.set(color);
    r.mat.opacity = 0.5;
    r.mesh.visible = true;
    r.life = r.maxLife;
    r.targetScale = 2.0 * scale;
  }

  // ---- parcaciklar ----
  _initParticles() {
    const N = 700;
    this.pN = N;
    this.pPos = new Float32Array(N * 3);
    this.pCol = new Float32Array(N * 3);
    this.pVel = new Float32Array(N * 3);
    this.pLife = new Float32Array(N);
    this.pPtr = 0;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.pCol, 3));
    const mat = new THREE.PointsMaterial({
      size: 0.26, map: this.glow, vertexColors: true, transparent: true,
      depthWrite: false, blending: THREE.AdditiveBlending
    });
    this.particles = new THREE.Points(geo, mat);
    this.particles.frustumCulled = false;
    this.scene.add(this.particles);
    this._pColor = new THREE.Color();
  }

  _burst(x, y, z, colorHex, count, power = 1) {
    this._pColor.set(colorHex);
    for (let i = 0; i < count; i++) {
      const p = this.pPtr = (this.pPtr + 1) % this.pN;
      this.pPos[p * 3] = x; this.pPos[p * 3 + 1] = y; this.pPos[p * 3 + 2] = z;
      const a = Math.random() * Math.PI * 2;
      const v = (1.5 + Math.random() * 3.5) * power;
      this.pVel[p * 3] = Math.cos(a) * v;
      this.pVel[p * 3 + 1] = 2 + Math.random() * 4 * power;
      this.pVel[p * 3 + 2] = Math.sin(a) * v * 0.6;
      this.pCol[p * 3] = this._pColor.r;
      this.pCol[p * 3 + 1] = this._pColor.g;
      this.pCol[p * 3 + 2] = this._pColor.b;
      this.pLife[p] = 0.5 + Math.random() * 0.35;
    }
  }

  // ---- oyun olaylari (main.js cagirir) ----
  onNoteHit(note, judgment) {
    const lane = note.lane;
    const color = note.boost ? 0xffffff : LANE_COLORS[lane];
    const x = this._laneX(lane);
    // geri bildirim yalniz vurulan seritte ve olculu: kucuk parcacik + receptor parlamasi
    if (note.boost) this._spawnRing(lane, 0xffffff, 1.2); // boost notasi ozel ani
    const count = judgment === 'perfect' ? 6 : judgment === 'great' ? 4 : 2;
    this._burst(x, 0.4, RECEPTOR_Z, color, count, judgment === 'perfect' ? 0.7 : 0.55);
    const r = this.receptors[lane];
    if (r) r.glowT = judgment === 'perfect' ? 1 : 0.7;
    if (note.type !== 'hold') this._releaseMesh(note);
    else {
      const item = this.meshByNote.get(note.id);
      if (item) item.tail.material = this.tailActiveMats[lane];
    }
  }

  onNoteMiss(note) {
    const item = this.meshByNote.get(note.id);
    if (item) {
      item.head.material = this.missedMat;
      item.top.material = this.missedMat;
      item.sprite.visible = false;
      if (item.tail.visible) item.tail.material = this.missedMat;
    }
    this.shake = Math.min(0.6, this.shake + 0.25);
  }

  // boost grubu bozulunca: kalan beyaz notalari normal serit rengine dondur
  revertBoostNotes(ids) {
    if (!ids) return;
    for (const id of ids) {
      const item = this.meshByNote.get(id);
      if (!item) continue;
      const n = this.notes[id];
      if (!n) continue;
      item.head.material = this.noteMats[n.lane];
      item.top.material = this.noteTopMats[n.lane];
      item.head.scale.setScalar(1);
      item.sprite.visible = false;
    }
  }

  onHoldDone(note, completed) {
    if (completed) {
      this._spawnRing(note.lane, LANE_COLORS[note.lane], 1.3);
      this._burst(this._laneX(note.lane), 0.4, RECEPTOR_Z, LANE_COLORS[note.lane], 14, 1);
    }
    this._releaseMesh(note);
  }

  onWrongHit(lane) {
    // hatalı/boş vuruş: o seritte kısa kırmızı uyarı, küçük sarsıntı
    const r = this.receptors[lane];
    if (r) { r.wrongT = 1; }
    this.shake = Math.min(0.4, this.shake + 0.12);
  }

  onComboMilestone() {
    // receptorlerden bir sey cikartmadan: yan raylarda kisa bir isik nabzi
    this.milestonePulse = 1;
  }

  onBoost(active) {
    if (active) {
      // kutlama yan raylardan gelir, oyun alani temiz kalir
      this.milestonePulse = 1.5;
      const W2 = this.laneCount * LANE_W / 2 + 0.6;
      for (const sideSign of [-1, 1]) {
        for (let k = 0; k < 6; k++) {
          this._burst(sideSign * W2, 0.5, RECEPTOR_Z - 2 - k * 5, GOLD_COLOR, 3, 0.9);
        }
      }
      this.shake = 0.3;
    }
  }

  pressLane(lane, down) {
    const r = this.receptors[lane];
    if (r) r.pressed = down;
  }

  // ---- kare guncellemesi ----
  frame(songT, dt, state) {
    if (!this.scene) return;
    const { boostActive, heldLanes, maxMult } = state;

    // gorunur pencereye giren notalara mesh ata
    while (this.spawnPtr < this.notes.length && this.notes[this.spawnPtr].time <= songT + this.lookahead) {
      const n = this.notes[this.spawnPtr];
      if (n.state === 'pending' || n.state === undefined) this._acquireMesh(n);
      this.spawnPtr++;
    }

    // aktif nota konumlari
    for (const [id, item] of this.meshByNote) {
      const n = this.notes[id];
      const zHead = n.state === 'holding' ? RECEPTOR_Z : RECEPTOR_Z - (n.time - songT) * this.speed;
      const x = this._laneX(n.lane);
      item.head.position.set(x, NOTE_Y, zHead);
      item.sprite.position.set(x, NOTE_Y + 0.1, zHead);
      if (item.tail.visible) {
        const zEnd = RECEPTOR_Z - (n.time + n.dur - songT) * this.speed;
        const zNear = Math.min(zHead, RECEPTOR_Z);
        item.tail.scale.z = Math.max(0.01, zNear - zEnd);
        item.tail.position.set(x, 0.1, (zNear + zEnd) / 2);
      }
      // gecip giden (kacirilmis) notalari temizle
      const zTailEnd = RECEPTOR_Z - (n.time + (n.dur || 0) - songT) * this.speed;
      if (zTailEnd > RECEPTOR_Z + 5 || (n.state !== 'pending' && n.state !== 'holding' && n.state !== 'missed')) {
        this._releaseMesh(n);
      }
    }

    // boost notasi nabzi (paylasimli beyaz materyal -> hepsi senkron parlar)
    this.boostMat.emissiveIntensity = 0.95 + 0.35 * Math.sin(songT * 6);

    // receptor durumlari
    for (let i = 0; i < this.receptors.length; i++) {
      const r = this.receptors[i];
      r.glowT = Math.max(0, r.glowT - dt * 4);
      r.wrongT = Math.max(0, (r.wrongT || 0) - dt * 3.5);
      const press = r.pressed ? 1 : 0;
      const target = 0.85 + press * 0.8 + r.glowT * 0.6;
      r.frameMat.emissiveIntensity += (target - r.frameMat.emissiveIntensity) * Math.min(1, dt * 14);
      // hatalı vuruşta çerçeve kırmızıya çalar
      if (r.wrongT > 0.01) r.frameMat.emissive.setRGB(1, 0.15 + 0.3 * (1 - r.wrongT), 0.2);
      else r.frameMat.emissive.setHex(LANE_COLORS[i]);
      r.innerMat.emissiveIntensity += ((0.06 + press * 0.4 + r.glowT * 0.25) - r.innerMat.emissiveIntensity) * Math.min(1, dt * 12);
      r.fillMat.opacity += ((press * 0.16 + r.glowT * 0.14) - r.fillMat.opacity) * Math.min(1, dt * 12);
      const s = 1 + press * 0.06 + r.glowT * 0.05;
      r.group.scale.setScalar(s);
    }

    // hold sirasinda receptorde kivilcim
    if (heldLanes) {
      for (const [id] of this.meshByNote) {
        const n = this.notes[id];
        if (n.state === 'holding' && Math.random() < dt * 14) {
          this._burst(this._laneX(n.lane), 0.35, RECEPTOR_Z, LANE_COLORS[n.lane], 1, 0.4);
        }
      }
    }

    // halkalar
    for (const r of this.rings) {
      if (r.life <= 0) continue;
      r.life -= dt;
      const k = 1 - r.life / r.maxLife;
      r.mesh.scale.setScalar(0.6 + (r.targetScale - 0.6) * k);
      r.mat.opacity = 0.5 * (1 - k);
      if (r.life <= 0) r.mesh.visible = false;
    }

    // parcaciklar
    for (let p = 0; p < this.pN; p++) {
      if (this.pLife[p] <= 0) continue;
      this.pLife[p] -= dt;
      const f = Math.max(0, this.pLife[p]);
      this.pVel[p * 3 + 1] -= 9.5 * dt; // yercekimi
      this.pPos[p * 3] += this.pVel[p * 3] * dt;
      this.pPos[p * 3 + 1] += this.pVel[p * 3 + 1] * dt;
      this.pPos[p * 3 + 2] += this.pVel[p * 3 + 2] * dt;
      const fade = Math.min(1, f * 2.5);
      this.pCol[p * 3] *= (0.92 + 0.08 * fade);
      this.pCol[p * 3 + 1] *= (0.92 + 0.08 * fade);
      this.pCol[p * 3 + 2] *= (0.92 + 0.08 * fade);
      if (this.pLife[p] <= 0) {
        this.pCol[p * 3] = this.pCol[p * 3 + 1] = this.pCol[p * 3 + 2] = 0;
      }
    }
    this.particles.geometry.attributes.position.needsUpdate = true;
    this.particles.geometry.attributes.color.needsUpdate = true;

    // gercek zamanli bas seviyesi (analizor)
    if (this._freqData && this.opts.analyser) {
      this.opts.analyser.getByteFrequencyData(this._freqData);
      let s = 0;
      const n = 8;
      for (let i = 1; i <= n; i++) s += this._freqData[i];
      const lvl = s / (n * 255);
      this.bassLevel += (lvl - this.bassLevel) * Math.min(1, dt * 10);
    }

    // beat nabzi (direkler)
    while (this.beatIdx < this.beatTimes.length && this.beatTimes[this.beatIdx] <= songT) {
      this.beatPulse = 1;
      this.beatIdx++;
    }
    this.beatPulse *= Math.exp(-dt * 5);

    this._updateStage(songT, dt);
    this._updateBeatLines(songT);
    // otoyol dokusu akar (hareket hissi)
    this.hwTex.offset.y = -((songT * this.speed) / (60 / 6)) % 1;
    // kilometre tasi nabzi (kombo/carpan kutlamasi raylarda yasanir)
    this.milestonePulse = (this.milestonePulse || 0) * Math.exp(-dt * 4);

    // ray rengi PURUZSUZ gecis: mor -> mavi (maxMultLevel) -> altin (boostLevel).
    // Esik atlama yok; renk ile parlaklik birlikte yumusakca akar, anlik yanip
    // sonme olmaz. 6x'te sese tepkili parlama bir miktar yumusatilir + hafif
    // sabit mavi parlaklik (asiri parlamadan).
    this._railColor.setHex(PURPLE_COLOR).lerp(C_BLUE, this.maxMultLevel).lerp(C_GOLD, this.boostLevel);
    // mor/mavide ses-tepkili TEPE parlamayi kis (sari/boost tam parlak kalir)
    const soundCalm = 1 - 0.35 * (1 - this.boostLevel);
    const soundGlow = (this.beatPulse * 1.0 + this.bassLevel * 1.2) * (1 - this.maxMultLevel * 0.3) * soundCalm;
    const railGlowTarget = 0.6 + soundGlow + this.boostLevel * 0.5 + this.maxMultLevel * 0.2 + this.milestonePulse * 1.1;
    // Yumusak yanma/sonme (mor & mavi): parlaklik hedefe ease ile yaklasir, pat
    // diye zilamaz. Yanma biraz hizli (tepe parlaklik korunur), sonme yavas.
    // Boost (sari) ise aninda kalir -> boostLevel ease'i cok hizlandirir.
    const railRise = railGlowTarget > this._railGlowCur;
    const railEase = Math.min(1, dt * ((railRise ? 12 : 3) + this.boostLevel * 40));
    this._railGlowCur += (railGlowTarget - this._railGlowCur) * railEase;
    for (const m of this.railMats) {
      m.emissiveIntensity = this._railGlowCur;
      m.emissive.copy(this._railColor);
    }
    this.accentLight.intensity = 12 + this.beatPulse * 8 + this.boostLevel * 5 + this.milestonePulse * 8;
    this.accentLight.color.setHex(this.boostLevel > 0.5 ? GOLD_COLOR : 0x7c4dff);

    // boost gorselleri: belirgin ama gorusu kapatmayan — renk degisimi on planda,
    // parlaklik artisi minimal
    const boostTarget = boostActive ? 1 : 0;
    this.boostLevel += (boostTarget - this.boostLevel) * Math.min(1, dt * 3);
    // 6x carpan: yalnizca raylar maviye doner (yukaridaki railHex). Boost varken
    // bastirilir (boost altini one cikar). Ek parlama/halo YOK.
    const maxMultTarget = (maxMult && !boostActive) ? 1 : 0;
    this.maxMultLevel += (maxMultTarget - this.maxMultLevel) * Math.min(1, dt * 2);
    // FOV YALNIZCA boost ile degisir — 6x carpan kamerayi/genisligi DEGISTIRMEZ
    this.bloom.strength = 0.6 + this.boostLevel * 0.12 + this.beatPulse * 0.06;
    this.camera.fov = this.baseFov + this.boostLevel * 3;
    if (boostActive && Math.random() < dt * 8) {
      // seyrek hiz cizgileri (yalniz kenarlardan)
      const side = Math.random() < 0.5 ? -1 : 1;
      this._burst(side * (this.laneCount * LANE_W / 2 + 1), 1 + Math.random() * 2, RECEPTOR_Z - 20 - Math.random() * 20, GOLD_COLOR, 1, 0.35);
    }
    if (this.horizonMat) {
      this.horizonMat.opacity = 0.4 + this.bassLevel * 0.25 + this.boostLevel * 0.2;
      this.horizonMat.color.setHex(this.boostLevel > 0.5 ? GOLD_COLOR : 0x7c4dff);
    }

    // kamera sarsintisi (miss)
    this.shake *= Math.exp(-dt * 7);
    const sx = (Math.random() - 0.5) * this.shake * 0.25;
    const sy = (Math.random() - 0.5) * this.shake * 0.18;
    this.camera.position.set(sx, CAM_POS_Y + sy, 13.2);
    this.camera.updateProjectionMatrix();

    // yildizlar yavasca doner
    if (this.stars) this.stars.rotation.y += dt * 0.012;

    this.composer.render();
  }

  // ---- sahne cevresi ----
  _buildStage(W) {
    const scene = this.scene;
    const side = W / 2;
    this.stageMats = [];   // isik seritleri (vurusla parlar)
    this.spots = [];
    this.speakers = [];

    // zemin: koyu yansitici duzlem + neon izgara
    {
      const c = document.createElement('canvas');
      c.width = c.height = 128;
      const g = c.getContext('2d');
      g.fillStyle = '#05030f'; g.fillRect(0, 0, 128, 128);
      g.strokeStyle = 'rgba(124,77,255,0.55)'; g.lineWidth = 2;
      g.strokeRect(0, 0, 128, 128);
      const tex = new THREE.CanvasTexture(c);
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(30, 30);
      tex.colorSpace = THREE.SRGBColorSpace;
      this.floorTex = tex;
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(160, 160), new THREE.MeshStandardMaterial({
        map: tex, color: 0x6a5acd, emissive: 0x1a0f40, emissiveIntensity: 0.4, roughness: 0.6, metalness: 0.3
      }));
      floor.rotation.x = -Math.PI / 2;
      floor.position.set(0, -0.6, -20);
      scene.add(floor);
    }

    // truss kemerleri: iki ayak + ust kiris, uzerlerinde isik seritleri
    const trussMat = new THREE.MeshStandardMaterial({ color: 0x2a2440, roughness: 0.4, metalness: 0.85 });
    const span = side + 3.4, hgt = 7.2;
    for (let k = 0; k < 5; k++) {
      const z = 2 - k * 11;
      const g = new THREE.Group();
      for (const sx of [-1, 1]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.35, hgt, 0.35), trussMat);
        leg.position.set(sx * span, hgt / 2 - 0.6, 0);
        g.add(leg);
        const strip = new THREE.Mesh(new THREE.BoxGeometry(0.08, hgt * 0.9, 0.08), this._stageMat());
        strip.position.set(sx * (span - 0.22), hgt / 2 - 0.6, 0.2);
        g.add(strip);
      }
      const beam = new THREE.Mesh(new THREE.BoxGeometry(span * 2 + 0.35, 0.4, 0.4), trussMat);
      beam.position.set(0, hgt - 0.6, 0);
      g.add(beam);
      const beamStrip = new THREE.Mesh(new THREE.BoxGeometry(span * 2, 0.07, 0.07), this._stageMat());
      beamStrip.position.set(0, hgt - 0.85, 0.22);
      g.add(beamStrip);
      g.position.z = z;
      scene.add(g);

      // ilk uc kemerde asili spotlar (konik isik huzmeleri)
      if (k >= 1 && k <= 3) {
        for (const sx of [-0.55, 0.55]) {
          const beamMat = new THREE.MeshBasicMaterial({
            map: this._beamTex || (this._beamTex = beamTexture()), color: 0xffffff,
            transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending,
            depthWrite: false, side: THREE.DoubleSide
          });
          const cone = new THREE.Mesh(new THREE.ConeGeometry(2.2, 9, 24, 1, true), beamMat);
          cone.geometry.translate(0, -4.5, 0); // tepe noktasi orijinde
          const pivot = new THREE.Group();
          pivot.position.set(sx * span, hgt - 1, z);
          pivot.add(cone);
          const head = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.36, 0.5, 12), trussMat);
          pivot.add(head);
          scene.add(pivot);
          this.spots.push({ pivot, mat: beamMat, phase: k * 1.7 + sx * 2, sx });
        }
      }
    }

    // LED duvar: canli spektrum (CanvasTexture)
    {
      const c = document.createElement('canvas');
      c.width = 512; c.height = 160;
      this.ledCanvas = c;
      this.ledCtx = c.getContext('2d');
      this.ledTex = new THREE.CanvasTexture(c);
      this.ledTex.colorSpace = THREE.SRGBColorSpace;
      const led = new THREE.Mesh(new THREE.PlaneGeometry(46, 14.4), new THREE.MeshBasicMaterial({ map: this.ledTex, transparent: true, opacity: 0.9 }));
      led.position.set(0, 8.5, -50);
      scene.add(led);
      const frame = new THREE.Mesh(new THREE.BoxGeometry(47, 15.4, 0.4), trussMat);
      frame.position.set(0, 8.5, -50.35);
      scene.add(frame);
      this._ledFrame = 0;
    }

    // hoparlor kuleleri (vurus cizgisinin iki yaninda): bas ile pompalar
    for (const sx of [-1, 1]) {
      const cab = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(1.5, 2.6, 1.2), new THREE.MeshStandardMaterial({ color: 0x0c0a16, roughness: 0.8, metalness: 0.3 }));
      body.position.y = 1.3;
      cab.add(body);
      const coneMat = new THREE.MeshStandardMaterial({ color: 0x0a0814, emissive: 0x7c4dff, emissiveIntensity: 0.08, roughness: 0.7, metalness: 0.2 });
      const cones = [];
      for (const [y, r] of [[1.95, 0.42], [0.8, 0.55]]) {
        const cn = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 0.7, 0.14, 24), coneMat);
        cn.rotation.x = Math.PI / 2;
        cn.position.set(0, y, 0.62);
        cab.add(cn);
        cones.push(cn);
      }
      cab.position.set(sx * (span + 1.6), -0.6, RECEPTOR_Z - 9);
      cab.rotation.y = -sx * 0.45;
      scene.add(cab);
      this.speakers.push({ cones, mat: coneMat });
    }

    // seyirci: iki yanda kume kume siluetler (InstancedMesh). Sahne metresi
    // yukseldikce zipliyor ve parliyorlar.
    {
      const N = 240;
      const geo = new THREE.CapsuleGeometry(0.26, 0.75, 3, 8);
      geo.translate(0, 0.64, 0);
      const mat = new THREE.MeshStandardMaterial({ color: 0x120d26, emissive: 0x7c4dff, emissiveIntensity: 0.05, roughness: 0.95 });
      const crowd = new THREE.InstancedMesh(geo, mat, N);
      crowd.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.crowdData = [];
      let i = 0;
      while (i < N) {
        const sx = i % 2 ? 1 : -1;
        const x = sx * (span + 1.2 + Math.random() * 9);
        const z = 4 - Math.random() * 40;
        this.crowdData.push({ x, z, ph: Math.random() * Math.PI * 2, amp: 0.5 + Math.random() * 0.7, s: 0.85 + Math.random() * 0.35, arms: Math.random() < 0.35 });
        i++;
      }
      this.crowd = crowd;
      this.crowdMat = mat;
      this._m4 = new THREE.Matrix4();
      this._q = new THREE.Quaternion();
      this._v = new THREE.Vector3();
      this._sc = new THREE.Vector3();
      scene.add(crowd);
    }

    this.intensity = 0.5;
    this.intensityTarget = 0.5;
    this.crowdLevel = 0.6;
    this.crowdTarget = 0.6;
  }

  _stageMat() {
    const m = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: this.partColor.clone(), emissiveIntensity: 0.8 });
    this.stageMats.push(m);
    return m;
  }

  // sahne metresi (0..1) -> seyirci coskusu
  setCrowd(m) { this.crowdTarget = m; }

  // bolum degisimi -> isik yogunlugu hedefi
  setSection(sec) {
    if (!sec) return;
    this.intensityTarget = sec.intensity != null ? sec.intensity : 0.5;
    this.sectionKick = 1; // bolum gecisinde kisa isik patlamasi
  }

  _energyAt(t) {
    const e = this.opts.energy;
    if (!e || !e.length) return 0.5;
    const i = Math.max(0, Math.min(e.length - 1, Math.round(t * 10)));
    return e[i];
  }

  _updateStage(songT, dt) {
    this.intensity += (this.intensityTarget - this.intensity) * Math.min(1, dt * 1.5);
    this.crowdLevel += (this.crowdTarget - this.crowdLevel) * Math.min(1, dt * 2);
    this.sectionKick = (this.sectionKick || 0) * Math.exp(-dt * 2.5);
    const energy = this._energyAt(Math.max(0, songT));
    const lvl = 0.35 + 0.4 * this.intensity + 0.25 * energy; // genel isik seviyesi

    // isik seritleri: parca rengi, vurusla nabiz; boost'ta altin
    for (const m of this.stageMats) {
      m.emissive.copy(this.partColor).lerp(C_GOLD, this.boostLevel);
      m.emissiveIntensity = 0.25 + lvl * 0.45 + this.beatPulse * 0.9 * lvl + this.sectionKick * 0.8;
    }

    // spotlar: yogunlukla hizlanan salinim, renk dongusu
    const sp = 0.4 + this.intensity * 1.1;
    for (const s of this.spots) {
      const a = songT * sp + s.phase;
      s.pivot.rotation.z = Math.sin(a) * 0.55 - s.sx * 0.25;
      s.pivot.rotation.x = 0.25 + Math.cos(a * 0.7) * 0.25;
      const hue = (0.72 + 0.12 * Math.sin(songT * 0.15 + s.phase) + this.boostLevel * 0.4) % 1;
      s.mat.color.setHSL(hue, 0.85, 0.6);
      s.mat.opacity = (0.04 + 0.16 * lvl + this.beatPulse * 0.08 + this.sectionKick * 0.15) * (0.6 + 0.4 * this.crowdLevel);
    }

    // hoparlor konileri: bas seviyesiyle pompa
    for (const sp2 of this.speakers) {
      const k = 1 + this.bassLevel * 0.18 + this.beatPulse * 0.08;
      for (const c of sp2.cones) c.scale.set(k, 1, k);
      sp2.mat.emissiveIntensity = 0.04 + this.bassLevel * 0.35;
      sp2.mat.emissive.copy(this.partColor);
    }

    // seyirci: vurusa senkron zipla; metre yuksekse daha cok, dusukse durgun
    if (this.crowd) {
      const hype = Math.max(0, (this.crowdLevel - 0.25) / 0.75);
      const beatPhase = this.beatPeriodPhase(songT);
      for (let i = 0; i < this.crowdData.length; i++) {
        const c = this.crowdData[i];
        const bounce = Math.max(0, Math.sin(beatPhase * Math.PI * 2 + c.ph * 0.3)) * c.amp * hype * 0.55;
        this._v.set(c.x, -0.6 + bounce, c.z);
        const sy = c.s * (c.arms && hype > 0.6 ? 1.18 : 1);
        this._sc.set(c.s, sy, c.s);
        this._q.setFromAxisAngle(this._yAxis || (this._yAxis = new THREE.Vector3(0, 1, 0)), Math.sin(songT + c.ph) * 0.3);
        this._m4.compose(this._v, this._q, this._sc);
        this.crowd.setMatrixAt(i, this._m4);
      }
      this.crowd.instanceMatrix.needsUpdate = true;
      this.crowdMat.emissiveIntensity = 0.02 + hype * 0.14 + this.beatPulse * 0.08 * hype;
      this.crowdMat.emissive.copy(this.partColor).lerp(new THREE.Color(0xff3344), Math.max(0, 0.3 - this.crowdLevel) * 3);
    }

    // LED duvar: her 2 karede bir canli spektrum
    if (this.ledCtx && (this._ledFrame++ & 1) === 0) this._drawLed(songT, lvl);
    this.floorTex.offset.y = (songT * this.speed / 160 * 30) % 1;
  }

  // vurus fazi 0..1 (seyirci senkronu)
  beatPeriodPhase(t) {
    const bp = this.opts.beatPeriod || 0.5;
    return (((t - (this.opts.beatOffset || 0)) / bp) % 1 + 1) % 1;
  }

  _drawLed(songT, lvl) {
    const g = this.ledCtx, W = 512, H = 160;
    g.fillStyle = 'rgba(5,3,15,0.55)';
    g.fillRect(0, 0, W, H);
    const fd = this._freqData;
    const n = 48, bw = W / n;
    const base = '#' + this.partColor.getHexString();
    for (let i = 0; i < n; i++) {
      // log frekans eslemesi
      let v = 0;
      if (fd) {
        const lo = Math.floor(Math.pow(fd.length * 0.7, i / n)), hi = Math.max(lo + 1, Math.floor(Math.pow(fd.length * 0.7, (i + 1) / n)));
        for (let k = lo; k < hi; k++) v = Math.max(v, fd[k] || 0);
        v /= 255;
      }
      const h = Math.max(2, v * H * 0.9);
      const grd = g.createLinearGradient(0, H, 0, H - h);
      grd.addColorStop(0, base);
      grd.addColorStop(1, this.boostLevel > 0.5 ? '#ffc83d' : '#35c4f0');
      g.fillStyle = grd;
      g.globalAlpha = 0.45 + 0.55 * lvl;
      g.fillRect(i * bw + 2, H - h, bw - 4, h);
      // ust yansima
      g.globalAlpha = 0.12;
      g.fillRect(i * bw + 2, 0, bw - 4, h * 0.25);
    }
    g.globalAlpha = 1;
    this.ledTex.needsUpdate = true;
  }

  // vurus/olcu cizgileri: gorunur penceredeki vuruslar otoyolda akar
  _updateBeatLines(songT) {
    let bt = this.beatLineTimes;
    const lines = this.beatLines;
    let used = 0;
    if (bt) {
      // ikili arama: songT'den onceki ilk vurus
      let lo = 0, hi = bt.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (bt[m] < songT - 0.3) lo = m + 1; else hi = m; }
      for (let i = lo; i < bt.length && used < lines.length; i++) {
        const dtB = bt[i] - songT;
        if (dtB > this.lookahead) break;
        const z = RECEPTOR_Z - dtB * this.speed;
        const m = lines[used++];
        const down = i % 4 === 0;
        m.visible = true;
        m.position.set(0, 0.015, z);
        m.scale.set(1, 1, down ? 2.2 : 1);
        m.material.opacity = (down ? 0.32 : 0.12) * Math.min(1, (z - SPAWN_Z) / 10);
      }
    }
    for (let i = used; i < lines.length; i++) lines[i].visible = false;
  }

  resetPlayback() {
    // yeniden baslatma: tum mesh'leri havuza geri al
    for (const id of Array.from(this.meshByNote.keys())) {
      this._releaseMesh(this.notes[id]);
    }
    this.spawnPtr = 0;
    this.beatIdx = 0;
    this.boostLevel = 0;
    this.maxMultLevel = 0;
    this._railGlowCur = 0.6;
    this.milestonePulse = 0;
    this.shake = 0;
    this.pLife.fill(0);
    this.pCol.fill(0);
    for (const r of this.rings) { r.life = 0; r.mesh.visible = false; }
  }

  _resize() {
    if (!this.camera) return;
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  _disposeScene() {
    if (!this.scene) return;
    this.scene.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach(m => { if (m.map) m.map.dispose(); m.dispose(); });
      }
    });
    this.scene = null;
    this.meshByNote = new Map();
    this.pool = [];
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    this._disposeScene();
    if (this.composer) this.composer.dispose();
    this.renderer.dispose();
  }
}
