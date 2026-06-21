// CaYa Rhythm - 3D Motor (Three.js)
// Fortnite Festival tarzi perspektifli otoyol: notalar uzaktan (yukaridan) gelir,
// alt taraftaki vurus cizgisine ulasir. Bloom, parcacik ve isik efektleri.

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
    const hwMat = new THREE.MeshStandardMaterial({
      color: 0x0d0a1e, roughness: 0.35, metalness: 0.6,
      transparent: true, opacity: 0.94
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

    // yol kenari neon direkleri (beat ile parlar)
    this.pylons = [];
    for (let i = 0; i < 9; i++) {
      for (const side of [-1, 1]) {
        const mat = new THREE.MeshStandardMaterial({
          color: 0x150f2a, emissive: 0x3d2bb5, emissiveIntensity: 0.5, roughness: 0.5
        });
        const p = new THREE.Mesh(new THREE.BoxGeometry(0.3, 2.4 + (i % 3) * 0.6, 0.3), mat);
        p.position.set(side * (W / 2 + 1.6), 1.2, RECEPTOR_Z - 4 - i * 5.5);
        scene.add(p);
        this.pylons.push({ mesh: p, mat, phase: i });
      }
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
    this.headGeo = new THREE.BoxGeometry(LANE_W * 0.74, 0.12, 0.46);
    this.headTopGeo = new THREE.BoxGeometry(LANE_W * 0.56, 0.05, 0.28);
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

    for (const p of this.pylons) {
      const wave = (p.phase % 3) === (this.beatIdx % 3) ? 1 : 0.4;
      p.mat.emissiveIntensity = 0.4 + this.beatPulse * 2.2 * wave + this.bassLevel * 1.2;
    }
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
        mats.forEach(m => m.dispose());
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
