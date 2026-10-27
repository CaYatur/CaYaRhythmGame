// CaYa Rhythm - Ana akis: kutuphane/menu -> analiz -> oyun (ya da pratik) -> sonuc

import { analyzeArrayBuffer, decodeAudio } from './audio/analyzer.js';
import { Mixer } from './audio/mixer.js';
import { buildChart, DIFFICULTIES, MODES, LEGACY_MODES } from './game/chart.js';
import { Scoring } from './game/scoring.js';
import { Input, KEY_HINT_4, KEY_HINT_5 } from './game/input.js';
import { DualSenseHID } from './game/dualsense-hid.js';
import { Engine } from './game/engine3d.js';
import { Hud, toast, sectionColor } from './game/hud.js';
import { saveSong, listSongs, loadSong, deleteSong, songId, ANALYSIS_VERSION } from './game/library.js';
import { t, getLang, setLang, applyStatic, numLocale, pct } from './i18n.js';

const $ = (id) => document.getElementById(id);

// SVG ikon yardimcisi — index.html'deki <symbol> kutuphanesine baglanir
const svgIco = (id, cls = '', style = '') =>
  `<svg class="ico ${cls}"${style ? ` style="${style}"` : ''}><use href="#${id}" /></svg>`;
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- kalici ayarlar ----------
function readJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || '') || fallback; } catch { return fallback; }
}
function writeJSON(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch {} }

const settings = Object.assign(
  { noteSpeed: 1.0, latency: 0, volume: 80, feedback: true, noFail: false, lefty: false },
  readJSON('caya-settings', {})
);
function saveSettings() { writeJSON('caya-settings', settings); }

// skorlar: eski 'instrument' modu kayitlari yeni 'drums' parcasina tasinir
const scores = readJSON('caya-scores', {});
for (const k of Object.keys(scores)) {
  for (const [old, neu] of Object.entries(LEGACY_MODES)) {
    if (k.endsWith('|' + old)) {
      const nk = k.slice(0, -old.length) + neu;
      if (!scores[nk] || scores[nk].score < scores[k].score) scores[nk] = scores[k];
      delete scores[k];
    }
  }
}
writeJSON('caya-scores', scores);
function scoreKey(mode = state.mode, diff = state.difficulty) {
  return `${state.songName}|${(state.audioBuffer ? state.audioBuffer.duration : 0).toFixed(1)}|${diff}|${mode}`;
}
function saveScore(res) {
  const key = scoreKey();
  const prev = scores[key];
  const isRecord = !prev || res.score > prev.score;
  if (isRecord) {
    scores[key] = { score: res.score, acc: +res.accuracy.toFixed(1), grade: res.grade, stars: +res.stars.toFixed(2), date: new Date().toISOString().slice(0, 10) };
    writeJSON('caya-scores', scores);
  }
  return isRecord;
}

// ---------- durum ----------
const state = {
  audioCtx: null,
  audioBuffer: null,
  analysis: null,
  songName: '',
  songId: null,
  difficulty: 'medium',
  mode: 'mixed',
  playing: false,
  paused: false,
  resuming: false,
  resumeAt: 0,
  engine: null,
  scoring: null,
  input: null,
  mixer: null,
  hid: new DualSenseHID(),
  hud: new Hud(),
  startCtxTime: 0,
  songOffset: 0,   // ses kaynaginin basladigi sarki saniyesi (pratik)
  rate: 1,         // calma hizi (pratik)
  practice: null,  // { range: [t0, t1], rate, sectionIdx } | null
  curSection: -1,
  raf: 0,
  lastFrameT: 0,
  chart: null,
  finished: false
};

function audioCtx() {
  if (!state.audioCtx) state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return state.audioCtx;
}
function mixer() {
  if (!state.mixer) state.mixer = new Mixer(audioCtx());
  return state.mixer;
}

// ---------- ekran yonetimi ----------
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id));
}

// sarki adindan deterministik kapak gradyani
function artStyle(name) {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) { h ^= name.charCodeAt(i); h = Math.imul(h, 16777619); }
  const a = (h >>> 0) % 360, b = (a + 70 + ((h >>> 9) % 90)) % 360;
  return `background: radial-gradient(circle at 30% 25%, rgba(255,255,255,.35), transparent 40%), linear-gradient(135deg, hsl(${a} 85% 55%), hsl(${b} 80% 35%));`;
}

// ---------- menu: parca + zorluk ----------
const NPS_PIPS = [0.8, 1.8, 3, 4.5, 6.5];
function chartFor(mode, diff) {
  return buildChart(state.analysis, diff, mode, { lefty: settings.lefty });
}

function renderCards() {
  const modeWrap = $('mode-cards');
  modeWrap.innerHTML = '';
  for (const [key, m] of Object.entries(MODES)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'part' + (state.mode === key ? ' selected' : '');
    btn.style.setProperty('--c', m.color);
    btn.title = t(m.descKey);
    let sub = '', pips = 0;
    if (state.analysis) {
      const c = chartFor(key, state.difficulty);
      sub = t('card.notes', { count: c.stats.count });
      pips = NPS_PIPS.filter(x => c.stats.nps >= x).length;
      if (!c.stats.count) btn.disabled = true;
    }
    btn.innerHTML = `${svgIco(m.iconId, 'p-ico')}<div class="p-name">${t(m.labelKey)}</div>` +
      `<div class="p-sub">${sub}</div>` +
      `<div class="pips">${Array.from({ length: 5 }, (_, i) => `<i class="${i < pips ? 'on' : ''}"></i>`).join('')}</div>`;
    btn.onclick = () => { state.mode = key; renderCards(); updateHiscore(); };
    modeWrap.appendChild(btn);
  }

  const diffWrap = $('diff-cards');
  diffWrap.innerHTML = '';
  for (const [key, d] of Object.entries(DIFFICULTIES)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = state.difficulty === key ? 'selected' : '';
    btn.style.setProperty('--c', d.color);
    let sub = t('card.keys', { n: d.lanes });
    if (state.analysis) sub = t('card.nps', { nps: chartFor(state.mode, key).stats.nps });
    btn.innerHTML = `${t(d.labelKey)}<small>${sub}</small>`;
    btn.onclick = () => { state.difficulty = key; renderCards(); updateHints(); updateHiscore(); };
    diffWrap.appendChild(btn);
  }
}

function updateHints() {
  const five = DIFFICULTIES[state.difficulty].lanes === 5;
  const keys = (five ? KEY_HINT_5 : KEY_HINT_4).split(' ');
  $('hint-keys').innerHTML = keys.map(k => `<kbd>${k}</kbd>`).join('');
  const padGlyphs = five
    ? ['ico-arrow-left|ps-dir', 'ico-arrow-right|ps-dir', 'ico-ps-square|ps-square', 'ico-ps-triangle|ps-triangle', 'ico-ps-circle|ps-circle']
    : ['ico-arrow-left|ps-dir', 'ico-arrow-right|ps-dir', 'ico-ps-square|ps-square', 'ico-ps-circle|ps-circle'];
  $('hint-pad').innerHTML = padGlyphs
    .map(g => { const [id, cls] = g.split('|'); return svgIco(id, 'ps-glyph ' + cls); })
    .join('');
}

function starsHtml(v, cls = '') {
  const gold = v >= 6;
  return `<span class="${cls}${gold ? ' gold' : ''}">` +
    Array.from({ length: 5 }, (_, i) => svgIco('ico-star', (gold || v >= i + 1) ? 'on' : '')).join('') + '</span>';
}

function updateHiscore() {
  const box = $('hiscore-box');
  if (!state.analysis) { box.hidden = true; return; }
  const s = scores[scoreKey()];
  if (!s) { box.hidden = true; return; }
  box.hidden = false;
  $('hiscore-stars').innerHTML = s.stars != null ? starsHtml(s.stars) : '';
  $('hiscore-text').textContent = `${s.score.toLocaleString(numLocale())} · ${pct(s.acc)} · ${s.grade}`;
}

// ---------- sahne: sarki karti + yapi seridi ----------
function sectionName(s) {
  return `${t('sec.name', { label: s.label })} · ${t('sec.' + s.kind)}`;
}

function renderSongInfo() {
  const has = !!(state.analysis && state.audioBuffer);
  $('song-info').hidden = !has;
  $('stage-empty').hidden = has;
  $('btn-start').disabled = !has;
  $('btn-practice').disabled = !has;
  if (!has) return;
  const dur = state.audioBuffer.duration;
  const min = Math.floor(dur / 60), sec = Math.round(dur % 60);
  const secs = state.analysis.sections || [];
  $('si-name').textContent = state.songName;
  $('song-art').setAttribute('style', artStyle(state.songName));
  $('si-meta').textContent = t('song.meta2', { min, sec: String(sec).padStart(2, '0'), bpm: state.analysis.bpm, secs: secs.length });
  const strip = $('sec-strip');
  if (!secs.length) { strip.innerHTML = `<span class="sec-none">${t('stage.structure.none')}</span>`; return; }
  strip.innerHTML = secs.map(s => {
    const w = (s.end - s.t) / dur * 100;
    return `<div class="sec-block" style="flex:${w.toFixed(3)};background:${sectionColor(s)}" title="${esc(sectionName(s))}"><span>${w > 5 ? s.label : ''}</span></div>`;
  }).join('');
}

// ---------- kutuphane ----------
async function renderLibrary() {
  const list = $('library-list');
  let songs = [];
  try { songs = await listSongs(); } catch { /* IndexedDB yok: kutuphane devre disi */ }
  $('library-empty').hidden = songs.length > 0;
  list.innerHTML = songs.slice(0, 40).map(s => {
    const m = Math.floor(s.duration / 60), sec = String(Math.round(s.duration % 60)).padStart(2, '0');
    return `<li class="lib-item${s.id === state.songId ? ' current' : ''}" data-id="${esc(s.id)}">` +
      `<div class="lib-art" style="${artStyle(s.name)}"></div>` +
      `<div class="lib-text"><div class="lib-name">${esc(s.name)}</div>` +
      `<div class="lib-meta">${m}:${sec} · ${s.bpm} BPM${s.stale ? ` · <span class="stale">${t('lib.stale')}</span>` : ''}</div></div>` +
      `<button class="lib-del" type="button" title="${esc(t('lib.delete'))}" data-del="${esc(s.id)}">${svgIco('ico-trash')}</button></li>`;
  }).join('');
  list.querySelectorAll('.lib-item').forEach(li => {
    li.onclick = (e) => {
      const del = e.target.closest('[data-del]');
      if (del) { e.stopPropagation(); deleteSong(del.dataset.del).then(renderLibrary).catch(() => {}); return; }
      openFromLibrary(li.dataset.id);
    };
  });
}

async function openFromLibrary(id) {
  const rec = await loadSong(id).catch(() => null);
  if (!rec) return;
  const data = await rec.file.arrayBuffer();
  if (rec.version !== ANALYSIS_VERSION) { await handleFile(rec.name, data, { size: rec.size, type: rec.type, force: true }); return; }
  try {
    state.audioBuffer = await decodeAudio(data, audioCtx());
    state.analysis = rec.analysis;
    state.songName = rec.name.replace(/\.[^.]+$/, '');
    state.songId = rec.id;
    onSongReady();
    toast(t('toast.loadedLib'), 'ok');
  } catch (err) {
    toast(t('toast.analysisFail', { msg: err.message }), 'warn');
  }
}

// ---------- ayar kontrolleri ----------
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
  syncSettingsLabels();
  speed.oninput = () => { settings.noteSpeed = +speed.value; syncSettingsLabels(); saveSettings(); };
  latency.oninput = () => { settings.latency = +latency.value; syncSettingsLabels(); saveSettings(); };
  volume.oninput = () => {
    settings.volume = +volume.value; syncSettingsLabels(); saveSettings();
    if (state.mixer) state.mixer.setVolume(settings.volume / 100);
  };
  const toggle = (id, key, after) => {
    const el = $(id);
    el.checked = !!settings[key];
    el.onchange = () => { settings[key] = el.checked; saveSettings(); after && after(); };
  };
  toggle('set-feedback', 'feedback', () => state.mixer && state.mixer.setFeedbackEnabled(settings.feedback));
  toggle('set-nofail', 'noFail');
  toggle('set-lefty', 'lefty', renderCards);
}

// ---------- dosya yukleme & analiz ----------
async function handleFile(name, arrayBuffer, meta = {}) {
  const size = meta.size != null ? meta.size : arrayBuffer.byteLength;
  const id = songId(name, size);
  // daha once analiz edildiyse kutuphaneden ac (yeniden analiz yok)
  if (!meta.force) {
    const rec = await loadSong(id).catch(() => null);
    if (rec && rec.version === ANALYSIS_VERSION) { await openFromLibrary(id); return; }
  }

  $('btn-start').disabled = true;
  $('btn-practice').disabled = true;
  $('analysis').hidden = false;
  const fill = $('analysis-fill'), stage = $('analysis-stage');
  fill.style.width = '0%';
  const keep = arrayBuffer.slice(0); // kutuphaneye kaydetmek icin kopya (decode tamponu tuketebilir)

  try {
    const { audioBuffer, analysis } = await analyzeArrayBuffer(arrayBuffer, audioCtx(), (st, p) => {
      stage.textContent = t('stage.' + st) + '…';
      fill.style.width = p + '%';
    });
    state.audioBuffer = audioBuffer;
    state.analysis = analysis;
    state.songName = name.replace(/\.[^.]+$/, '');
    state.songId = id;
    $('analysis').hidden = true;
    onSongReady();
    toast(t('toast.analysisDone'), 'ok');
    // analiz sonucu (ham ses dahil) kutuphaneye — basarisizlik oyunu engellemez
    const { type, ...plain } = analysis; // worker mesaj tipini sakla(ma)
    saveSong({ id, name, size, type: meta.type || '', data: keep, analysis: plain })
      .then(renderLibrary).catch(() => {});
  } catch (err) {
    console.error(err);
    $('analysis').hidden = true;
    renderSongInfo();
    toast(t('toast.analysisFail', { msg: err.message }), 'warn');
  }
}

function onSongReady() {
  // bos parcayi secili birakma: secili parcada nota yoksa tam gruba gec
  if (!chartFor(state.mode, state.difficulty).stats.count) state.mode = 'mixed';
  renderSongInfo();
  renderCards();
  updateHiscore();
  renderLibrary();
}

function bindFileInputs() {
  const dz = $('dropzone'), fi = $('file-input');
  dz.onclick = () => fi.click();
  dz.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fi.click(); } };
  fi.onchange = async () => {
    if (fi.files && fi.files[0]) {
      const f = fi.files[0];
      await handleFile(f.name, await f.arrayBuffer(), { size: f.size, type: f.type });
      fi.value = '';
    }
  };
  ['dragover', 'dragenter'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('over'); }));
  dz.addEventListener('drop', async e => {
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) await handleFile(f.name, await f.arrayBuffer(), { size: f.size, type: f.type });
  });
  $('btn-test-song').onclick = async () => {
    try {
      const resp = await fetch('test-song.wav');
      if (!resp.ok) throw new Error(t('toast.testMissing'));
      await handleFile('CaYa Test Şarkısı.wav', await resp.arrayBuffer(), { type: 'audio/wav' });
    } catch (err) {
      toast(err.message, 'warn');
    }
  };
}

// ---------- oyun ici kontrol gostergesi ----------
const CTL_KEYS = { 4: ['D', 'F', 'J', 'K'], 5: ['D', 'F', 'J', 'K', 'L'] };
const CTL_PAD = {
  4: ['ico-arrow-left|ps-dir', 'ico-arrow-right|ps-dir', 'ico-ps-square|ps-square', 'ico-ps-circle|ps-circle'],
  5: ['ico-arrow-left|ps-dir', 'ico-arrow-right|ps-dir', 'ico-ps-square|ps-square', 'ico-ps-triangle|ps-triangle', 'ico-ps-circle|ps-circle']
};
let ctlLaneEls = [];

// Serit tuslarini ekranin EN ALTINA, her seridin TAM ALTINA hizalar (perspektif
// acilimi: serit cizgisi iki noktadan projekte edilip hedef Y'de interpole edilir).
function layoutLaneKeys() {
  if (!state.engine || !state.engine.scene) return;
  const near = state.engine.getLaneAnchors(0);
  const far = state.engine.getLaneAnchors(5);
  const H = window.innerHeight;
  const chipH = ctlLaneEls[0] ? ctlLaneEls[0].offsetHeight : 30;
  const targetY = H - chipH / 2 - 10;
  for (let i = 0; i < ctlLaneEls.length; i++) {
    const a = near[i], b = far[i];
    if (!a || !b) continue;
    const k = (targetY - a.y) / (b.y - a.y);
    const x = a.x + k * (b.x - a.x);
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
  if (isPad) {
    laneWrap.innerHTML = CTL_PAD[lanes].map(g => {
      const [id, cls] = g.split('|');
      return `<div class="lane-key">${svgIco(id, 'ps-glyph ' + cls)}</div>`;
    }).join('');
  } else {
    laneWrap.innerHTML = CTL_KEYS[lanes].map(k => `<div class="lane-key"><kbd>${k}</kbd></div>`).join('');
  }
  ctlLaneEls = Array.from(laneWrap.children);
  $('hud-boost-key').textContent = isPad ? 'R2' : t('kbd.space');
  $('hud-pause-key').querySelector('kbd').textContent = isPad ? 'Options' : t('kbd.esc');
  layoutLaneKeys();
  laneWrap.classList.remove('flash');
  void laneWrap.offsetWidth;
  laneWrap.classList.add('flash');
  clearTimeout(updateGameControls._t);
  updateGameControls._t = setTimeout(() => laneWrap.classList.remove('flash'), 900);
}

function highlightControls(heldLanes) {
  for (let i = 0; i < ctlLaneEls.length; i++) ctlLaneEls[i].classList.toggle('on', heldLanes.has(i));
}

// ---------- oyun ----------
// sarki zamani: ses saati * hiz + baslangic ofseti - cikis gecikmesi + kullanici ayari
function songTime() {
  const ctx = state.audioCtx;
  const raw = (ctx.currentTime - state.startCtxTime) * state.rate + state.songOffset;
  const outLat = ctx.outputLatency || ctx.baseLatency || 0;
  return raw - outLat + settings.latency / 1000;
}

// practice: { range: [t0, t1], rate, sectionIdx }; leadIn: geri sayim (sn)
function startGame(practice = null, leadIn = 3) {
  const ctx = audioCtx();
  ctx.resume();
  state.practice = practice;
  state.rate = practice ? practice.rate : 1;

  state.chart = buildChart(state.analysis, state.difficulty, state.mode, {
    lefty: settings.lefty,
    range: practice ? practice.range : null
  });
  if (!state.chart.notes.length) {
    toast(t('toast.noNotes'), 'warn');
    if (state.playing) quitToMenu(); // pratik dongusu bos bir araliga denk geldiyse durdur
    return;
  }
  if (state.chart.stats.lowVocal && !practice) toast(t('toast.lowVocal'), 'warn');

  const mx = mixer();
  mx.setVolume(settings.volume / 100);
  mx.setPart(MODES[state.mode].feedback);
  mx.setFeedbackEnabled(settings.feedback);

  if (!state.engine) state.engine = new Engine($('game-canvas'));
  state.engine.setup(state.chart.laneCount, state.chart.notes, {
    noteSpeed: settings.noteSpeed,
    bpm: state.analysis.bpm,
    beatOffset: state.analysis.beatOffset,
    beatPeriod: state.analysis.beatPeriod,
    beats: state.analysis.beats,
    duration: state.audioBuffer.duration,
    analyser: mx.analyser,
    energy: state.analysis.energy,
    sections: state.analysis.sections,
    partColor: MODES[state.mode].color
  });

  state.scoring = new Scoring(state.chart.notes, onScoringEvent, state.chart.laneCount, {
    maxScore: state.chart.stats.maxScore,
    noFail: settings.noFail || !!practice
  });

  state.input.setLaneCount(state.chart.laneCount);
  state.input.setEnabled(true);

  // pratikte bolumden 2 sn once baslat (hazirlik)
  state.songOffset = practice ? Math.max(0, practice.range[0] - 2) : 0;
  const startAt = ctx.currentTime + leadIn;
  state.startCtxTime = startAt;
  mx.play(state.audioBuffer, startAt, state.songOffset, state.rate);

  const label = `${state.songName} · ${t(MODES[state.mode].labelKey)} · ${t(DIFFICULTIES[state.difficulty].labelKey)}` +
    (practice && practice.rate !== 1 ? ` · ${Math.round(practice.rate * 100)}%` : '');
  state.hud.reset(label, { practice: !!practice, sections: state.analysis.sections, duration: state.audioBuffer.duration });
  const startDev = state.input.activeDevice
    || (((state.hid && state.hid.connected) || state.input.isConnected()) ? 'gamepad' : 'keyboard');
  updateGameControls(startDev);
  state.playing = true;
  state.paused = false;
  state.resuming = false;
  state.finished = false;
  state.curSection = -1;
  showScreen('screen-game');
  $('overlay-pause').hidden = true;
  state.lastFrameT = performance.now();
  cancelAnimationFrame(state.raf);
  loop();
}

function onLane(lane, down) {
  if (!state.playing || state.paused) return;
  const st = songTime();
  state.engine.pressLane(lane, down);
  if (down) state.scoring.hit(lane, st);
  else state.scoring.release(lane, st, state.input.boostHeld);
}

function onBoost() {
  if (!state.playing || state.paused) return;
  if (state.scoring.activateBoost()) {
    state.scoring.hitAnyInWindow(songTime());
  } else if (!state.scoring.boostActive) {
    state.hud.shakeBoostBar();
  }
}

function onPauseKey() {
  if (!state.playing) return;
  if (state.paused) resumeGame(); else pauseGame();
}

function boostFrac(s) { return s.boostCap ? Math.min(1, s.boostLeft / s.boostCap) : 0; }

function onScoringEvent(type, data) {
  const s = state.scoring, hud = state.hud;
  if (!s) return; // kurucu icindeki erken olaylar
  switch (type) {
    case 'hit': {
      hud.setScore(s.score);
      hud.setCombo(s.combo);
      hud.judgment(data.judgment, data.note.boost);
      hud.timing(data.deltaMs);
      hud.setMult(s.multiplier, s.multProgress, s.boostActive, s.noMistakes);
      hud.setAcc(s.accuracy());
      hud.setStars(s.stars);
      state.engine.onNoteHit(data.note, data.judgment);
      state.mixer.onHit();
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
      state.mixer.onMiss();
      break;
    case 'wrongHit':
      hud.setCombo(0);
      hud.setMult(s.multiplier, s.multProgress, s.boostActive, s.noMistakes);
      state.engine.onWrongHit(data.lane);
      break;
    case 'score':
      hud.setScore(s.score);
      hud.setStars(s.stars);
      break;
    case 'combo':
      hud.setMult(s.multiplier, s.multProgress, s.boostActive);
      break;
    case 'multiplierUp':
      state.engine.onComboMilestone();
      break;
    case 'meter':
      hud.setMeter(data.meter);
      state.engine.setCrowd(data.meter);
      break;
    case 'fail':
      toast(t('toast.failed'), 'warn');
      state.input.rumble('boost');
      finishGame(true);
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
      hud.boostFlash();
      state.input.rumble('milestone');
      break;
    case 'boostGroupBroken':
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

function sectionAt(time) {
  const secs = state.analysis.sections || [];
  let i = 0;
  while (i + 1 < secs.length && secs[i + 1].t <= time) i++;
  return secs.length ? i : -1;
}

function loop() {
  if (!state.playing) return;
  state.raf = requestAnimationFrame(loop);
  const now = performance.now();
  const dt = Math.min(0.05, (now - state.lastFrameT) / 1000);
  state.lastFrameT = now;

  // duraklatma sonrasi 3 sn hazirlik geri sayimi (ses hala suspended)
  if (state.resuming) {
    const remain = (state.resumeAt - now) / 1000;
    if (remain > 0) { state.hud.countdown(Math.ceil(remain)); return; }
    state.resuming = false;
    state.paused = false;
    state.audioCtx.resume();
    state.lastFrameT = now;
    return;
  }
  if (state.paused) return;

  const st = songTime();
  state.input.poll();
  highlightControls(state.input.heldLanes);
  state.scoring.update(st, state.input.heldLanes, dt, state.input.boostHeld);
  if (!state.playing) return; // update icinde 'fail' -> finishGame
  state.engine.frame(st, dt, {
    boostActive: state.scoring.boostActive,
    heldLanes: state.input.heldLanes,
    maxMult: state.scoring.multiplier >= 6
  });
  layoutLaneKeys();

  // geri sayim: ses kaynaginin baslamasina kalan gercek sure
  const pre = state.startCtxTime - state.audioCtx.currentTime;
  state.hud.countdown(pre > 0 ? Math.ceil(pre) : 0);

  // bolum degisimi: bant + sahne yogunlugu
  const si = sectionAt(Math.max(0, st));
  if (si !== state.curSection && si >= 0 && pre <= 0) {
    state.curSection = si;
    const sec = state.analysis.sections[si];
    if (si > 0 || state.practice) state.hud.sectionBanner(sectionName(sec));
    state.engine.setSection(sec);
  }

  const dur = state.audioBuffer.duration;
  state.hud.setProgress(Math.max(0, Math.min(1, st / dur)));

  if (state.practice) {
    // bolum sonu: ayni bolumu kisa geri sayimla yeniden baslat (dongu)
    if (st > Math.min(dur, state.practice.range[1]) + 1.2) startGame(state.practice, 1.5);
    return;
  }
  if (st > dur + 1.5 && !state.finished) {
    state.finished = true;
    finishGame(false);
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
  $('overlay-pause').hidden = true;
  state.resuming = true;
  state.resumeAt = performance.now() + 3000;
}

function stopAudio() { if (state.mixer) state.mixer.stop(); }

function finishGame(failed) {
  state.playing = false;
  state.finished = true;
  state.input.setEnabled(false);
  stopAudio();
  cancelAnimationFrame(state.raf);

  const res = state.scoring.results();
  const isRecord = !failed && !state.practice && saveScore(res);
  renderResults(res, isRecord, failed);
  showScreen('screen-results');
  updateHiscore();
}

// ---------- sonuc ekrani ----------
function renderResults(res, isRecord, failed) {
  $('res-song').textContent = `${state.songName} · ${t(MODES[state.mode].labelKey)} · ${t(DIFFICULTIES[state.difficulty].labelKey)}`;
  $('res-grade').textContent = failed ? 'F' : res.grade;
  $('res-score').textContent = res.score.toLocaleString(numLocale());
  $('res-failed').hidden = !failed;
  $('res-fc').hidden = !res.fullCombo || failed;
  $('res-newrecord').hidden = !isRecord;
  $('res-stars').innerHTML = starsHtml(failed ? 0 : res.stars, 'res-stars-inner');
  $('res-stars').className = 'res-stars' + (res.stars >= 6 && !failed ? ' gold' : '');
  $('res-stars').querySelectorAll('.ico.on').forEach((el, i) => { el.style.animationDelay = (0.15 + i * 0.12) + 's'; });

  const stats = [
    [t('stat.accuracy'), pct(res.accuracy.toFixed(1))],
    [t('stat.maxCombo'), res.maxCombo],
    [t('stat.stars'), (failed ? 0 : Math.floor(res.stars)) + '/5'],
    [t('stat.boost'), `${res.boostHit}/${res.boostTotal}`],
    [t('stat.perfect'), res.counts.perfect],
    [t('stat.great'), res.counts.great],
    [t('stat.good'), res.counts.good],
    [t('stat.miss'), res.counts.miss + (res.wrongHits ? ` · ${res.wrongHits}✕` : '')]
  ];
  $('res-stats').innerHTML = stats.map(([k, v]) => `<div class="cell"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');

  // zamanlama histogrami: -150..+150 ms, 10 ms kutular
  const d = res.deltas;
  const bins = new Array(30).fill(0);
  for (const x of d) bins[Math.max(0, Math.min(29, Math.floor((x + 150) / 10)))]++;
  const mx = Math.max(1, ...bins);
  const binColor = (i) => { const c = Math.abs(i * 10 - 150 + 5); return c <= 50 ? '#35c4f0' : c <= 105 ? '#59d96b' : '#ffc83d'; };
  $('res-hist').innerHTML = bins.map((b, i) => `<i style="height:${(b / mx * 100).toFixed(1)}%;background:${binColor(i)}"></i>`).join('');
  let note = t('res.noHits');
  if (d.length >= 8) {
    const sorted = d.slice().sort((a, b) => a - b);
    const med = sorted[sorted.length >> 1];
    const tip = Math.abs(med) >= 12
      ? t('res.tipLatency', { v: Math.max(-200, Math.min(200, Math.round((settings.latency - med) / 5) * 5)) })
      : t('res.tipOk');
    note = t('res.timingNote', { ms: Math.abs(med), dir: med < 0 ? t('res.early') : t('res.late'), tip });
  }
  $('res-timing-note').textContent = note;

  // bolum bazli dogruluk
  const secs = state.analysis.sections || [];
  const rows = secs.map((s, i) => ({ s, st: res.sectionStats[i] })).filter(r => r.st && r.st.total > 0);
  $('res-sections').innerHTML = rows.map(({ s, st }) => {
    const acc = st.hit / st.total;
    return `<div class="res-sec" title="${esc(sectionName(s))} · ${Math.round(acc * 100)}%">` +
      `<div class="b" style="height:${Math.max(3, acc * 100).toFixed(1)}%;background:${sectionColor(s)}"></div><div class="l">${s.label}</div></div>`;
  }).join('') || `<span class="sec-none">${t('res.noHits')}</span>`;
}

function quitToMenu() {
  state.playing = false;
  state.paused = false;
  state.practice = null;
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
  startGame(state.practice);
}

// ---------- pratik penceresi ----------
const PRACTICE_SPEEDS = [0.5, 0.6, 0.75, 0.9, 1];
const practiceSel = { idx: -1, rate: 0.75 };

function openPractice() {
  const secs = state.analysis.sections || [];
  const wrap = $('practice-sections');
  const items = [{ i: -1, name: t('practice.whole'), sub: '', c: 'var(--accent)' }].concat(secs.map((s, i) => ({
    i, name: sectionName(s), sub: `${fmtTime(s.t)}–${fmtTime(s.end)}`, c: sectionColor(s)
  })));
  wrap.innerHTML = items.map(it =>
    `<button type="button" data-i="${it.i}" class="${practiceSel.idx === it.i ? 'selected' : ''}" style="--c:${it.c}"><b>${esc(it.name)}</b><small>${it.sub}</small></button>`).join('');
  wrap.querySelectorAll('button').forEach(b => b.onclick = () => { practiceSel.idx = +b.dataset.i; openPractice(); });
  const sp = $('practice-speeds');
  sp.innerHTML = PRACTICE_SPEEDS.map(r => `<button type="button" data-r="${r}" class="${practiceSel.rate === r ? 'selected' : ''}">${Math.round(r * 100)}%</button>`).join('');
  sp.querySelectorAll('button').forEach(b => b.onclick = () => { practiceSel.rate = +b.dataset.r; openPractice(); });
  $('overlay-practice').hidden = false;
}
function fmtTime(s) { return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`; }

function goPractice() {
  const secs = state.analysis.sections || [];
  const dur = state.audioBuffer.duration;
  const s = practiceSel.idx >= 0 ? secs[practiceSel.idx] : null;
  const range = s ? [s.t, s.end] : [0, dur];
  $('overlay-practice').hidden = true;
  startGame({ range, rate: practiceSel.rate, sectionIdx: practiceSel.idx });
}

// ---------- gecikme kalibrasyonu ----------
// 100 BPM'de 4 hazirlik + 8 olculen tik; oyuncunun basis zamani ile tik zamani
// arasindaki medyan fark -> gecikme ayari (songTime ile ayni saat referansi).
const calib = { running: false, clicks: [], taps: [], suggestion: null };

function openCalib() {
  calib.suggestion = null;
  $('btn-calib-apply').disabled = true;
  $('calib-result').textContent = '';
  $('calib-beats').innerHTML = Array.from({ length: 8 }, () => '<i></i>').join('');
  $('overlay-calib').hidden = false;
}

function runCalib() {
  const ctx = audioCtx();
  ctx.resume();
  const period = 0.6, t0 = ctx.currentTime + 0.4;
  calib.clicks = [];
  calib.taps = [];
  calib.running = true;
  $('btn-calib-start').disabled = true;
  const dots = Array.from($('calib-beats').children);
  dots.forEach(d => d.className = '');
  for (let i = 0; i < 12; i++) {
    const at = t0 + i * period;
    const osc = ctx.createOscillator(), g = ctx.createGain();
    osc.frequency.value = i < 4 ? 660 : 1320;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(0.5, at + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.09);
    osc.connect(g).connect(ctx.destination);
    osc.start(at); osc.stop(at + 0.1);
    if (i >= 4) calib.clicks.push(at);
    const delay = (at - ctx.currentTime) * 1000;
    setTimeout(() => {
      if (!calib.running) return;
      $('calib-result').textContent = i < 4 ? t('calib.listen', { n: 4 - i }) : t('calib.tap');
      if (i >= 4) { const d = dots[i - 4]; d.classList.add('tick'); setTimeout(() => d.classList.remove('tick'), 120); }
    }, delay);
  }
  setTimeout(finishCalib, (t0 + 12 * period - ctx.currentTime) * 1000 + 300);
}

function calibTap(e) {
  if (!calib.running) return;
  if (!['Space', 'KeyD', 'KeyF', 'KeyJ', 'KeyK', 'KeyL'].includes(e.code)) return;
  e.preventDefault();
  e.stopPropagation();
  const ctx = state.audioCtx;
  const at = ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0);
  calib.taps.push(at);
  let k = 0, best = Infinity;
  calib.clicks.forEach((c, i) => { const d = Math.abs(c - at); if (d < best) { best = d; k = i; } });
  if (best < 0.3) $('calib-beats').children[k].classList.add('hit');
}

function finishCalib() {
  calib.running = false;
  $('btn-calib-start').disabled = false;
  const ds = [];
  for (const tap of calib.taps) {
    let best = null;
    for (const c of calib.clicks) { const d = tap - c; if (Math.abs(d) < 0.3 && (best === null || Math.abs(d) < Math.abs(best))) best = d; }
    if (best !== null) ds.push(best * 1000);
  }
  if (ds.length < 4) { $('calib-result').textContent = t('calib.fail'); return; }
  ds.sort((a, b) => a - b);
  const med = ds[ds.length >> 1];
  // basis gec (med > 0) ise sarki saati geri cekilmeli -> ayar = mevcut - med
  const v = Math.max(-200, Math.min(200, Math.round((settings.latency - med) / 5) * 5));
  calib.suggestion = v;
  $('calib-result').textContent = t('calib.result', { ms: Math.round(med), v });
  $('btn-calib-apply').disabled = false;
}

function applyCalib() {
  if (calib.suggestion == null) return;
  settings.latency = calib.suggestion;
  $('set-latency').value = settings.latency;
  syncSettingsLabels();
  saveSettings();
  $('overlay-calib').hidden = true;
  toast(t('toast.calibApplied', { v: settings.latency }), 'ok');
}

// ---------- kol durumu ----------
function setPadStatus(connected, name) {
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
  applyStatic();
  updateLangButtons();
  renderCards();
  updateHints();
  updateHiscore();
  renderSongInfo();
  renderLibrary();
  syncSettingsLabels();
  if (state.input) setPadStatus(state.input.isConnected(), state.input.padName);
}

function bindLangSwitch() {
  document.querySelectorAll('#lang-switch button').forEach(b => { b.onclick = () => applyLang(b.dataset.lang); });
}

// ---------- baglama ----------
function init() {
  setLang(getLang());
  applyStatic();
  bindLangSwitch();
  updateLangButtons();
  renderCards();
  updateHints();
  bindSettings();
  bindFileInputs();
  renderSongInfo();
  renderLibrary();

  state.input = new Input({
    onLane,
    onBoost,
    onPause: onPauseKey,
    onToast: toast,
    onStatus: setPadStatus,
    onDevice: (d) => { if (state.playing) updateGameControls(d); }
  });
  state.hid.onDisconnect = () => { state.input.setHid(null); setPadStatus(state.input.isConnected(), state.input.padName); };
  state.hid.tryReconnect().then(ok => {
    if (ok) { state.input.setHid(state.hid); setPadStatus(true); }
  });
  setPadStatus(state.input.isConnected(), state.input.padName);

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
      state.input.rumble('test');
      toast(t('toast.rumbleGamepad'), 'ok');
    } else {
      toast(t('toast.connectFirst'), 'warn');
    }
  };

  $('btn-start').onclick = () => startGame(null);
  $('btn-practice').onclick = openPractice;
  $('btn-practice-go').onclick = goPractice;
  $('btn-practice-close').onclick = () => { $('overlay-practice').hidden = true; };
  $('btn-calibrate').onclick = openCalib;
  $('btn-calib-start').onclick = runCalib;
  $('btn-calib-apply').onclick = applyCalib;
  $('btn-calib-close').onclick = () => { calib.running = false; $('overlay-calib').hidden = true; };
  window.addEventListener('keydown', calibTap, true);
  $('btn-resume').onclick = resumeGame;
  $('btn-restart').onclick = restartGame;
  $('btn-quit').onclick = quitToMenu;
  $('btn-retry').onclick = () => { showScreen('screen-game'); restartGame(); };
  $('btn-menu').onclick = quitToMenu;

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state.playing && !state.paused) pauseGame();
  });
  window.addEventListener('resize', () => { if (state.playing) layoutLaneKeys(); });

  // otomasyon/test kancasi
  window.__game = { state, startGame, buildChart, songTime, handleFile, settings };
}

init();
