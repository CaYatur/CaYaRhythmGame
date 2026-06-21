// CaYa Rhythm - Ana akis: menu -> analiz -> oyun -> sonuc

import { analyzeArrayBuffer } from './audio/analyzer.js';
import { buildChart, DIFFICULTIES, MODES } from './game/chart.js';
import { Scoring } from './game/scoring.js';
import { Input, KEY_HINT_4, KEY_HINT_5 } from './game/input.js';
import { DualSenseHID } from './game/dualsense-hid.js';
import { Engine } from './game/engine3d.js';
import { Hud, toast } from './game/hud.js';
import { t, getLang, setLang, applyStatic, numLocale, pct } from './i18n.js';

const $ = (id) => document.getElementById(id);

// SVG ikon yardimcisi (emoji yerine) — index.html'deki <symbol> kutuphanesine baglanir
const svgIco = (id, cls = '', style = '') =>
  `<svg class="ico ${cls}"${style ? ` style="${style}"` : ''}><use href="#${id}" /></svg>`;

// ---------- kalici ayarlar ----------
const settings = Object.assign(
  { noteSpeed: 1.0, latency: 0, volume: 80 },
  JSON.parse(localStorage.getItem('caya-settings') || '{}')
);
function saveSettings() { localStorage.setItem('caya-settings', JSON.stringify(settings)); }

const scores = JSON.parse(localStorage.getItem('caya-scores') || '{}');
function scoreKey() {
  return `${state.songName}|${(state.audioBuffer ? state.audioBuffer.duration : 0).toFixed(1)}|${state.difficulty}|${state.mode}`;
}
function saveScore(res) {
  const key = scoreKey();
  const prev = scores[key];
  const isRecord = !prev || res.score > prev.score;
  if (isRecord) {
    scores[key] = { score: res.score, acc: +res.accuracy.toFixed(1), grade: res.grade, date: new Date().toISOString().slice(0, 10) };
    localStorage.setItem('caya-scores', JSON.stringify(scores));
  }
  return isRecord;
}

// ---------- durum ----------
const state = {
  audioCtx: null,
  audioBuffer: null,
  analysis: null,
  songName: '',
  difficulty: 'medium',
  mode: 'mixed',
  playing: false,
  paused: false,
  resuming: false,    // duraklatma sonrasi 3 sn geri sayim sirasinda true
  resumeAt: 0,
  engine: null,
  scoring: null,
  input: null,
  hid: new DualSenseHID(),
  hud: new Hud(),
  master: null,
  analyser: null,
  source: null,
  startCtxTime: 0,
  pausedAt: 0,
  raf: 0,
  lastFrameT: 0,
  chart: null,
  finished: false
};

function audioCtx() {
  if (!state.audioCtx) state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return state.audioCtx;
}

// ---------- ekran yonetimi ----------
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id));
}

// ---------- menu kurulumu ----------
function renderCards() {
  const diffWrap = $('diff-cards');
  diffWrap.innerHTML = '';
  for (const [key, d] of Object.entries(DIFFICULTIES)) {
    const btn = document.createElement('button');
    btn.className = 'card' + (state.difficulty === key ? ' selected' : '');
    btn.dataset.key = key;
    let sub = t('card.keys', { n: d.lanes });
    if (state.analysis) {
      const c = buildChart(state.analysis, key, state.mode);
      sub += ' · ' + t('card.stats', { count: c.stats.count, nps: c.stats.nps });
    }
    btn.innerHTML = `<div class="c-title">${svgIco('ico-dot', 'diff-dot', 'color:' + d.color)}${t(d.labelKey)}</div><div class="c-sub">${sub}</div>`;
    btn.onclick = () => { state.difficulty = key; renderCards(); updateHints(); updateHiscore(); };
    diffWrap.appendChild(btn);
  }

  const modeWrap = $('mode-cards');
  modeWrap.innerHTML = '';
  for (const [key, m] of Object.entries(MODES)) {
    const btn = document.createElement('button');
    btn.className = 'card' + (state.mode === key ? ' selected' : '');
    btn.innerHTML = `<div class="c-title">${svgIco(m.iconId)}${t(m.labelKey)}</div><div class="c-sub">${t(m.descKey)}</div>`;
    btn.onclick = () => { state.mode = key; renderCards(); updateHiscore(); };
    modeWrap.appendChild(btn);
  }
}

function updateHints() {
  const five = DIFFICULTIES[state.difficulty].lanes === 5;
  // klavye: harfleri keycap olarak goster
  const keys = (five ? KEY_HINT_5 : KEY_HINT_4).split(' ');
  $('hint-keys').innerHTML = keys.map(k => `<kbd>${k}</kbd>`).join('');
  // kol: DualSense yon + yuz tuslari SVG glyph olarak
  const padGlyphs = five
    ? ['ico-arrow-left|ps-dir', 'ico-arrow-right|ps-dir', 'ico-ps-square|ps-square', 'ico-ps-triangle|ps-triangle', 'ico-ps-circle|ps-circle']
    : ['ico-arrow-left|ps-dir', 'ico-arrow-right|ps-dir', 'ico-ps-square|ps-square', 'ico-ps-circle|ps-circle'];
  $('hint-pad').innerHTML = padGlyphs
    .map(g => { const [id, cls] = g.split('|'); return svgIco(id, 'ps-glyph ' + cls); })
    .join('');
}

// ---------- oyun ici dinamik kontrol gostergesi ----------
// Klavye ve kol esleme verisi (input.js ile ayni siralama: serit 0..n)
const CTL_KEYS = { 4: ['D', 'F', 'J', 'K'], 5: ['D', 'F', 'J', 'K', 'L'] };
const CTL_PAD = {
  4: ['ico-arrow-left|ps-dir', 'ico-arrow-right|ps-dir', 'ico-ps-square|ps-square', 'ico-ps-circle|ps-circle'],
  5: ['ico-arrow-left|ps-dir', 'ico-arrow-right|ps-dir', 'ico-ps-square|ps-square', 'ico-ps-triangle|ps-triangle', 'ico-ps-circle|ps-circle']
};
let ctlLaneEls = []; // canli vurgulama icin serit tus etiketleri

// Serit tuslarini ekranin EN ALTINA, her seridin TAM ALTINA hizalar.
// Perspektifte seritler asagi dogru acilir; tusu seridin dipteki gercek ekran
// X'ine koymak icin serit cizgisini iki noktadan projekte edip hedef Y'de
// (ekran dibi) X'i interpole ederiz -> her tus kendi seridine tam ortalanir.
function layoutLaneKeys() {
  if (!state.engine || !state.engine.scene) return;
  const near = state.engine.getLaneAnchors(0); // receptor hizasi
  const far = state.engine.getLaneAnchors(5);   // kameraya daha yakin (ekranda daha asagi)
  const H = window.innerHeight;
  const chipH = ctlLaneEls[0] ? ctlLaneEls[0].offsetHeight : 30;
  const targetY = H - chipH / 2 - 10; // tus merkezleri ekranin en dibinde
  for (let i = 0; i < ctlLaneEls.length; i++) {
    const a = near[i], b = far[i];
    if (!a || !b) continue;
    // serit ekran cizgisi a->b boyunca; hedef Y'deki X (perspektif acilimi dahil)
    const t = (targetY - a.y) / (b.y - a.y);
    const x = a.x + t * (b.x - a.x);
    ctlLaneEls[i].style.left = x.toFixed(1) + 'px';
    ctlLaneEls[i].style.top = targetY.toFixed(1) + 'px';
  }
}

function updateGameControls(device) {
  const laneWrap = $('hud-lane-keys');
  if (!laneWrap) return;
  const lanes = state.chart ? state.chart.laneCount : DIFFICULTIES[state.difficulty].lanes;
  const isPad = device === 'gamepad';

  laneWrap.classList.toggle('kbd', !isPad);
  laneWrap.classList.toggle('pad', isPad);

  // her serit icin ayri tus etiketi (vurus bolgesinin altinda konumlanir)
  if (isPad) {
    laneWrap.innerHTML = CTL_PAD[lanes].map(g => {
      const [id, cls] = g.split('|');
      return `<div class="lane-key">${svgIco(id, 'ps-glyph ' + cls)}</div>`;
    }).join('');
  } else {
    laneWrap.innerHTML = CTL_KEYS[lanes].map(k => `<div class="lane-key"><kbd>${k}</kbd></div>`).join('');
  }
  ctlLaneEls = Array.from(laneWrap.children);

  // boost tusu: boost barinin yaninda; duraklat tusu: kosede
  $('hud-boost-key').textContent = isPad ? 'R2' : t('kbd.space');
  $('hud-pause-key').querySelector('kbd').textContent = isPad ? 'Options' : t('kbd.esc');

  layoutLaneKeys();

  // cihaz degisince kisa bir vurgu
  laneWrap.classList.remove('flash');
  void laneWrap.offsetWidth;
  laneWrap.classList.add('flash');
  clearTimeout(updateGameControls._t);
  updateGameControls._t = setTimeout(() => laneWrap.classList.remove('flash'), 900);
}

// her karede basili seritleri parlat
function highlightControls(heldLanes) {
  for (let i = 0; i < ctlLaneEls.length; i++) {
    ctlLaneEls[i].classList.toggle('on', heldLanes.has(i));
  }
}

function updateHiscore() {
  const box = $('hiscore-box');
  if (!state.analysis) { box.hidden = true; return; }
  const s = scores[scoreKey()];
  if (!s) { box.hidden = true; return; }
  box.hidden = false;
  $('hiscore-text').textContent = `${s.score.toLocaleString(numLocale())} · ${pct(s.acc)} · ${s.grade} (${s.date})`;
}

// ---------- ayar kontrolleri ----------
// ayar deger etiketleri (dil degisince yeniden cizilebilir: % isareti yeri vb.)
function syncSettingsLabels() {
  const speed = $('set-speed'), latency = $('set-latency'), volume = $('set-volume');
  if (!speed) return;
  $('set-speed-val').textContent = (+speed.value).toFixed(2).replace(/0$/, '') + 'x';
  $('set-latency-val').textContent = latency.value + ' ms';
  $('set-volume-val').textContent = pct(volume.value);
}

function bindSettings() {
  const speed = $('set-speed'), latency = $('set-latency'), volume = $('set-volume');
  speed.value = settings.noteSpeed;
  latency.value = settings.latency;
  volume.value = settings.volume;
  const sync = syncSettingsLabels;
  sync();
  speed.oninput = () => { settings.noteSpeed = +speed.value; sync(); saveSettings(); };
  latency.oninput = () => { settings.latency = +latency.value; sync(); saveSettings(); };
  volume.oninput = () => {
    settings.volume = +volume.value; sync(); saveSettings();
    if (state.master) state.master.gain.value = settings.volume / 100;
  };
}

// ---------- dosya yukleme & analiz ----------
async function handleFile(name, arrayBuffer) {
  $('btn-start').disabled = true;
  $('song-info').hidden = true;
  $('analysis').hidden = false;
  const fill = $('analysis-fill'), stage = $('analysis-stage');
  fill.style.width = '0%';

  try {
    const { audioBuffer, analysis } = await analyzeArrayBuffer(arrayBuffer, audioCtx(), (st, pct) => {
      stage.textContent = t('stage.' + st) + '…';
      fill.style.width = pct + '%';
    });
    state.audioBuffer = audioBuffer;
    state.analysis = analysis;
    state.songName = name.replace(/\.[^.]+$/, '');

    $('analysis').hidden = true;
    $('song-info').hidden = false;
    $('si-name').textContent = state.songName;
    renderSongMeta();
    $('btn-start').disabled = false;
    renderCards();
    updateHiscore();
    toast(t('toast.analysisDone'), 'ok');
  } catch (err) {
    console.error(err);
    $('analysis').hidden = true;
    toast(t('toast.analysisFail', { msg: err.message }), 'warn');
  }
}

// secili sarkinin meta satiri (dil degisince yeniden cizilebilir)
function renderSongMeta() {
  if (!state.analysis || !state.audioBuffer) return;
  const dur = state.audioBuffer.duration;
  const min = Math.floor(dur / 60), sec = Math.round(dur % 60);
  const evTotal = Object.values(state.analysis.events).reduce((a, b) => a + b.length, 0);
  $('si-meta').textContent = t('song.meta', {
    min, sec: String(sec).padStart(2, '0'), bpm: state.analysis.bpm, n: evTotal
  });
}

function bindFileInputs() {
  const dz = $('dropzone'), fi = $('file-input');
  dz.onclick = () => fi.click();
  fi.onchange = async () => {
    if (fi.files && fi.files[0]) {
      const f = fi.files[0];
      await handleFile(f.name, await f.arrayBuffer());
    }
  };
  ['dragover', 'dragenter'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('over'); }));
  dz.addEventListener('drop', async e => {
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) await handleFile(f.name, await f.arrayBuffer());
  });
  $('btn-test-song').onclick = async () => {
    try {
      const resp = await fetch('/test-song.wav');
      if (!resp.ok) throw new Error(t('toast.testMissing'));
      await handleFile('CaYa Test Şarkısı.wav', await resp.arrayBuffer());
    } catch (err) {
      toast(err.message, 'warn');
    }
  };
}

// ---------- oyun ----------
function songTime() {
  const ctx = state.audioCtx;
  const raw = ctx.currentTime - state.startCtxTime;
  const outLat = ctx.outputLatency || ctx.baseLatency || 0;
  return raw - outLat + settings.latency / 1000;
}

function startGame() {
  const ctx = audioCtx();
  ctx.resume();

  state.chart = buildChart(state.analysis, state.difficulty, state.mode);
  if (!state.chart.notes.length) {
    toast(t('toast.noNotes'), 'warn');
    return;
  }
  if (state.chart.stats.lowVocal) {
    toast(t('toast.lowVocal'), 'warn');
  }

  // ses zinciri: kaynak -> analizor -> master gain -> cikis
  if (!state.master) {
    state.master = ctx.createGain();
    state.analyser = ctx.createAnalyser();
    state.analyser.fftSize = 256;
    state.analyser.connect(state.master);
    state.master.connect(ctx.destination);
  }
  state.master.gain.value = settings.volume / 100;

  // motor
  if (!state.engine) state.engine = new Engine($('game-canvas'));
  state.engine.setup(state.chart.laneCount, state.chart.notes, {
    noteSpeed: settings.noteSpeed,
    bpm: state.analysis.bpm,
    beatOffset: state.analysis.beatOffset,
    beatPeriod: state.analysis.beatPeriod,
    duration: state.audioBuffer.duration,
    analyser: state.analyser
  });

  // puanlama
  state.scoring = new Scoring(state.chart.notes, onScoringEvent, state.chart.laneCount);

  // girdi
  state.input.setLaneCount(state.chart.laneCount);
  state.input.setEnabled(true);

  // baslat: 3 sn geri sayim
  state.source = ctx.createBufferSource();
  state.source.buffer = state.audioBuffer;
  state.source.connect(state.analyser);
  const startAt = ctx.currentTime + 3;
  state.startCtxTime = startAt;
  state.source.start(startAt);

  state.hud.reset(`${state.songName} · ${t(DIFFICULTIES[state.difficulty].labelKey)} · ${t(MODES[state.mode].labelKey)}`);
  // baslangic kontrol gostergesi: son kullanilan cihaz, yoksa bagli kol varsa kol
  const startDev = state.input.activeDevice
    || (((state.hid && state.hid.connected) || state.input.isConnected()) ? 'gamepad' : 'keyboard');
  updateGameControls(startDev);
  state.playing = true;
  state.paused = false;
  state.resuming = false;
  state.finished = false;
  showScreen('screen-game');
  $('overlay-pause').hidden = true;
  state.lastFrameT = performance.now();
  cancelAnimationFrame(state.raf);
  loop();
}

function onLane(lane, down) {
  if (!state.playing || state.paused) return;
  const t = songTime();
  state.engine.pressLane(lane, down);
  if (down) {
    state.scoring.hit(lane, t);
  } else {
    state.scoring.release(lane, t, state.input.boostHeld);
  }
}

function onBoost() {
  if (!state.playing || state.paused) return;
  if (state.scoring.activateBoost()) {
    // boost aktive oldu: R2'ye basıldığı an vuruş penceresindeki notalara da
    // basılmış sayılsın (notalar boost yüzünden kaçmasın)
    state.scoring.hitAnyInWindow(songTime());
  } else if (!state.scoring.boostActive) {
    state.hud.shakeBoostBar();
  }
}

function onPauseKey() {
  if (!state.playing) return;
  if (state.paused) resumeGame(); else pauseGame();
}

// boost aktifken HUD doluluk orani (kalan sure / azami kapasite)
function boostFrac(s) {
  return s.boostCap ? Math.min(1, s.boostLeft / s.boostCap) : 0;
}

function onScoringEvent(type, data) {
  const s = state.scoring, hud = state.hud;
  switch (type) {
    case 'hit': {
      hud.setScore(s.score);
      hud.setCombo(s.combo);
      hud.judgment(data.judgment, data.note.boost);
      hud.setMult(s.multiplier, s.multProgress, s.boostActive, s.noMistakes);
      hud.setAcc(s.accuracy());
      state.engine.onNoteHit(data.note, data.judgment);
      state.input.rumble(data.note.boost ? 'gold' : data.judgment);
      if (s.combo > 0 && s.combo % 50 === 0) {
        state.engine.onComboMilestone();
        state.input.rumble('milestone');
      }
      break;
    }
    case 'miss':
      hud.setCombo(0);
      hud.judgment('miss', false);
      hud.setMult(s.multiplier, s.multProgress, s.boostActive, s.noMistakes);
      hud.setAcc(s.accuracy());
      state.engine.onNoteMiss(data.note);
      break;
    case 'wrongHit':
      hud.setCombo(0);
      hud.setMult(s.multiplier, s.multProgress, s.boostActive, s.noMistakes);
      state.engine.onWrongHit(data.lane);
      break;
    case 'score':
      hud.setScore(s.score);
      break;
    case 'combo':
      hud.setMult(s.multiplier, s.multProgress, s.boostActive);
      break;
    case 'multiplierUp':
      state.engine.onComboMilestone();
      break;
    case 'boostCharge':
      hud.setBoost(s.bars, s.groupProgress, s.boostActive, boostFrac(s));
      break;
    case 'boostReady':
      toast(t('toast.boostReady', { key: 'R2 / ' + t('kbd.space') }), 'ok');
      break;
    case 'boostStart':
      hud.setBoost(0, 0, true, 1);
      hud.setMult(s.multiplier, s.multProgress, true);
      hud.boostFlash();
      state.engine.onBoost(true);
      state.input.rumble('boost');
      break;
    case 'boostExtend':
      // boost sirasinda yeni bar doldu -> sure uzadi
      hud.boostFlash();
      state.input.rumble('milestone');
      break;
    case 'boostGroupBroken':
      // grup bozuldu: kalan beyaz notalar normale doner
      state.engine.revertBoostNotes(data.reverted);
      break;
    case 'boostBarsFull':
      toast(t('toast.boostFull', { key: 'R2 / ' + t('kbd.space') }), 'ok');
      break;
    case 'boostEnd':
      hud.setBoost(s.bars, s.groupProgress, false, 0);
      hud.setMult(s.multiplier, s.multProgress, false);
      break;
    case 'holdDone':
      state.engine.onHoldDone(data.note, data.completed);
      break;
  }
}

function loop() {
  if (!state.playing) return;
  state.raf = requestAnimationFrame(loop);
  const now = performance.now();
  const dt = Math.min(0.05, (now - state.lastFrameT) / 1000);
  state.lastFrameT = now;

  // duraklatmadan sonra devam: 3 sn hazirlik geri sayimi (ses hala suspended)
  if (state.resuming) {
    const remain = (state.resumeAt - now) / 1000;
    if (remain > 0) { state.hud.countdown(Math.ceil(remain)); return; }
    state.resuming = false;
    state.paused = false;
    state.audioCtx.resume();
    state.lastFrameT = now;
    return; // sonraki kareden itibaren normal akis (countdown(0) 'BAŞLA!' gosterir)
  }

  if (state.paused) return;

  const t = songTime();
  state.input.poll();
  highlightControls(state.input.heldLanes);
  state.scoring.update(t, state.input.heldLanes, dt, state.input.boostHeld);
  state.engine.frame(t, dt, {
    boostActive: state.scoring.boostActive,
    heldLanes: state.input.heldLanes,
    maxMult: state.scoring.multiplier >= 6
  });
  layoutLaneKeys(); // serit tuslarini vurus bolgelerinin altinda tut (boyut/FOV degisse de)

  // geri sayim
  if (t < 0) state.hud.countdown(Math.ceil(-t));
  else state.hud.countdown(0);

  const dur = state.audioBuffer.duration;
  state.hud.setProgress(Math.max(0, Math.min(1, t / dur)));

  if (t > dur + 1.5 && !state.finished) {
    state.finished = true;
    finishGame();
  }
}

function pauseGame() {
  if (state.paused) return;
  state.paused = true;
  state.audioCtx.suspend();
  $('overlay-pause').hidden = false;
}

function resumeGame() {
  if (!state.paused || state.resuming) return;
  // hemen baslatma: 3 sn hazirlik geri sayimi. Ses sayim boyunca suspended kalir;
  // sayim bitince sarki kaldigi yerden devam eder. Geri sayim loop()'ta islenir.
  $('overlay-pause').hidden = true;
  state.resuming = true;
  state.resumeAt = performance.now() + 3000;
}

function stopAudio() {
  if (state.source) {
    try { state.source.stop(); } catch {}
    try { state.source.disconnect(); } catch {}
    state.source = null;
  }
}

function finishGame() {
  state.playing = false;
  state.input.setEnabled(false);
  stopAudio();
  cancelAnimationFrame(state.raf);

  const res = state.scoring.results();
  const isRecord = saveScore(res);

  $('res-grade').textContent = res.grade;
  $('res-score').textContent = res.score.toLocaleString(numLocale());
  $('res-fc').hidden = !res.fullCombo;
  $('res-newrecord').hidden = !isRecord;
  const stats = [
    [t('stat.accuracy'), pct(res.accuracy.toFixed(1))],
    [t('stat.maxCombo'), res.maxCombo],
    [t('stat.perfect'), res.counts.perfect],
    [t('stat.great'), res.counts.great],
    [t('stat.good'), res.counts.good],
    [t('stat.miss'), res.counts.miss],
    [t('stat.boost'), `${res.boostHit}/${res.boostTotal}`]
  ];
  $('res-stats').innerHTML = stats.map(([k, v]) => `<div class="k">${k}</div><div class="v">${v}</div>`).join('');
  showScreen('screen-results');
  updateHiscore();
}

function quitToMenu() {
  state.playing = false;
  state.paused = false;
  if (state.input) state.input.setEnabled(false);
  stopAudio();
  cancelAnimationFrame(state.raf);
  if (state.audioCtx && state.audioCtx.state === 'suspended') state.audioCtx.resume();
  $('overlay-pause').hidden = true;
  showScreen('screen-menu');
  renderCards();
  updateHiscore();
}

function restartGame() {
  state.playing = false;
  state.paused = false;
  stopAudio();
  cancelAnimationFrame(state.raf);
  if (state.audioCtx && state.audioCtx.state === 'suspended') state.audioCtx.resume();
  $('overlay-pause').hidden = true;
  startGame();
}

function setPadStatus(connected, name, isDS, rumbleOk) {
  const el = $('pad-status');
  const txt = $('pad-status-text');
  if (!el || !txt) return;
  if (state.hid && state.hid.connected) {
    txt.textContent = t('pad.hid', { name: state.hid.name });
    el.classList.add('ok');
  } else if (connected) {
    txt.textContent = t('pad.connected', { name });
    el.classList.add('ok');
  } else {
    txt.textContent = t('pad.none');
    el.classList.remove('ok');
  }
}

// ---------- dil ----------
function updateLangButtons() {
  document.querySelectorAll('#lang-switch button').forEach(b =>
    b.classList.toggle('active', b.dataset.lang === getLang()));
}

function applyLang(l) {
  setLang(l);
  applyStatic();          // statik HTML (data-i18n / data-i18n-html)
  updateLangButtons();
  renderCards();          // zorluk/mod etiketleri + kart istatistikleri
  updateHints();
  updateHiscore();
  renderSongMeta();       // yuklenmis sarki meta satiri
  syncSettingsLabels();   // ayar deger etiketleri (% yeri)
  if (state.input) setPadStatus(state.input.isConnected(), state.input.padName);
}

function bindLangSwitch() {
  document.querySelectorAll('#lang-switch button').forEach(b => {
    b.onclick = () => applyLang(b.dataset.lang);
  });
}

// ---------- baglama ----------
function init() {
  setLang(getLang());     // <html lang> + kalici tercih
  applyStatic();          // statik metinleri sec dile gore doldur
  bindLangSwitch();
  updateLangButtons();
  renderCards();
  updateHints();
  bindSettings();
  bindFileInputs();

  // girdi yoneticisi en bastan kurulur: kol baglantisi menudeyken de algilanir
  state.input = new Input({
    onLane: onLane,
    onBoost: onBoost,
    onPause: onPauseKey,
    onToast: toast,
    onStatus: setPadStatus,
    onDevice: (d) => { if (state.playing) updateGameControls(d); }
  });
  // önceki izinli kolu sessizce yeniden bağla (sayfa yenilemede)
  state.hid.onDisconnect = () => { state.input.setHid(null); setPadStatus(state.input.isConnected(), state.input.padName); };
  state.hid.tryReconnect().then(ok => {
    if (ok) { state.input.setHid(state.hid); setPadStatus(true); }
  });
  setPadStatus(state.input.isConnected(), state.input.padName, false, true);

  // WebHID ile kolu seç + titreşimi test et (DualSense için en güvenilir yol)
  $('btn-rumble-test').onclick = async () => {
    if (state.hid.supported && !state.hid.connected) {
      try {
        const dev = await state.hid.requestDevice();
        if (dev) {
          state.input.setHid(state.hid);
          setPadStatus(true);
          toast(t('toast.ctrlSelected', { name: state.hid.name }), 'ok');
        } else {
          toast(t('toast.notSelected'), 'warn');
          return;
        }
      } catch (e) {
        toast(e.message, 'warn');
        return;
      }
    }
    if (state.hid.connected) {
      state.input.rumble('test');
      toast(t('toast.rumbleFelt'), 'ok');
    } else if (state.input.isConnected()) {
      state.input.rumble('test'); // HID yok: Gamepad API yedeği
      toast(t('toast.rumbleGamepad'), 'ok');
    } else {
      toast(t('toast.connectFirst'), 'warn');
    }
  };

  $('btn-start').onclick = startGame;
  $('btn-resume').onclick = resumeGame;
  $('btn-restart').onclick = restartGame;
  $('btn-quit').onclick = quitToMenu;
  $('btn-retry').onclick = () => { showScreen('screen-game'); restartGame(); };
  $('btn-menu').onclick = quitToMenu;

  // sekme arka plana gecince otomatik duraklat
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state.playing && !state.paused) pauseGame();
  });

  // pencere boyutu degisince serit tuslarini yeniden hizala
  window.addEventListener('resize', () => { if (state.playing) layoutLaneKeys(); });

  // otomasyon/test kancasi
  window.__game = { state, startGame, buildChart, songTime };
}

init();
