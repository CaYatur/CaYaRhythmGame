// CaYa Rhythm - Ses analiz motoru benchmark'i (headless)
//
// Gercek analiz worker'ini (public/js/audio/analysis-worker.js) Node'da calistirir
// ve yer gercegi bilinen senaryolarda olcer:
//   A) sentetik yatak + sentetik sarkici + vokal-olmayan tuzaklar (duz lead,
//      vibratolu lead, merkez pad) -> kesinlik / duyarlilik / yanlis alarm
//   B) public/testsongs/*.mp3 gercek miksler + uzerine bindirilmis sarkici
//      -> gercek eslik altinda duyarlilik ve perde dogrulugu
//   C) A'nin yapay zeka ayirmali hali: worker'a kusursuz kanallar verilir
//      (vokal = sarkici, diger = yatak + tuzaklar, davul/bas = sessiz) ->
//      ayrilmis vokal izleyicisi + sessiz kanal korumasi
//
// Calistir:  node tools/analysis-bench.mjs [--quick] [--json out.json]
// Gercek sarkilar icin ffmpeg gerekir (yoksa B atlanir).

import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SR, makeRng, makeMelody, renderSinger, renderDecoys, synthBed } from './bench/synth.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const QUICK = args.includes('--quick');
// ablasyon: BENCH_TUNE='{"octCheck":false}' gibi worker ayarlari
const TUNE = process.env.BENCH_TUNE ? JSON.parse(process.env.BENCH_TUNE) : {};
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;

// ---- gercek worker'i yukle (tarayicidaki dosyanin aynisi) ----
function loadWorker() {
  const src = readFileSync(path.join(ROOT, 'public/js/audio/analysis-worker.js'), 'utf8');
  let result = null;
  const self = {
    postMessage(m) { if (m.type === 'result') result = m; else if (m.type === 'error') throw new Error(m.message); }
  };
  new Function('self', src)(self);
  return (left, right, stems = null) => {
    result = null;
    const center = new Float32Array(left.length), side = new Float32Array(left.length);
    for (let i = 0; i < left.length; i++) { center[i] = (left[i] + right[i]) * 0.5; side[i] = (left[i] - right[i]) * 0.5; }
    self.onmessage({ data: { cmd: 'analyze', center, side, left: Float32Array.from(left), right: Float32Array.from(right), sampleRate: SR, tune: TUNE, stems } });
    return result;
  };
}
const analyze = loadWorker();
const chartSrc = readFileSync(path.join(ROOT, 'public/js/game/chart.js'), 'utf8');
const { buildChart } = await import('data:text/javascript,' + encodeURIComponent(chartSrc));

// ---- yardimcilar ----
function rms(a, from = 0, to = a.length) {
  let s = 0; for (let i = from; i < to; i++) s += a[i] * a[i];
  return Math.sqrt(s / Math.max(1, to - from));
}
function decode(file, start, dur) {
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(start), '-t', String(dur), '-i', file,
    '-f', 'f32le', '-ac', '2', '-ar', String(SR), '-'], { maxBuffer: 1 << 28 });
  const inter = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const n = inter.length >> 1;
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = inter[2 * i]; R[i] = inter[2 * i + 1]; }
  return { L, R };
}
function hasFfmpeg() { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } }

// sarkiciyi yataga gore seviyelendir: sesli bolgedeki RMS = ratio * yatak RMS
function overlaySinger(L, R, notes, rng, ratio) {
  const n = L.length;
  const tmpL = new Float32Array(n), tmpR = new Float32Array(n);
  const mono = renderSinger(tmpL, tmpR, notes, rng, 1);
  let s = 0, c = 0;
  for (const nt of notes) {
    const a = Math.floor(nt.t * SR), b = Math.min(n, Math.floor((nt.t + nt.dur) * SR));
    for (let i = a; i < b; i++) { s += mono[i] * mono[i]; c++; }
  }
  const vr = Math.sqrt(s / Math.max(1, c));
  const bed = Math.sqrt((rms(L) ** 2 + rms(R) ** 2) / 2);
  const g = ratio * bed / Math.max(1e-9, vr);
  const voc = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] += tmpL[i] * g; R[i] += tmpR[i] * g; voc[i] = 0.5 * (tmpL[i] + tmpR[i]) * g; }
  return voc; // kusursuz ayrilmis vokal kanali (C senaryosu)
}

// ---- metrikler ----
function evaluate(events, gt, opts = {}) {
  const tol = opts.tol || 0.1;
  const used = new Set();
  let tp = 0, pitchOk = 0, pitchOct = 0;
  for (const g of gt) {
    let best = -1, bd = tol;
    for (let k = 0; k < events.length; k++) {
      if (used.has(k)) continue;
      const d = Math.abs(events[k].t - g.t);
      if (d <= bd) { bd = d; best = k; }
    }
    if (best >= 0) {
      used.add(best); tp++;
      const dp = Math.round(events[best].pitch - g.midi);
      if (Math.abs(dp) <= 1) pitchOk++;
      const m = ((dp % 12) + 12) % 12;
      if (m <= 1 || m >= 11) pitchOct++;
    }
  }
  // sesli zaman kapsami (10 ms izgara)
  const step = 0.01;
  const span = (e) => [e.t, e.t + Math.max(e.dur || 0, 0.2)];
  const inside = (t, arr, f) => arr.some(e => { const [a, b] = f(e); return t >= a && t < b; });
  let gtT = 0, cov = 0;
  for (const g of gt) for (let t = g.t; t < g.t + g.dur; t += step) { gtT++; if (inside(t, events, span)) cov++; }
  // GT notalarinin disinda kalan olaylar (yanlis alarm adayi)
  const outside = events.filter(e => !gt.some(g => e.t >= g.t - 0.15 && e.t <= g.t + g.dur + 0.05)).length;
  const P = events.length ? tp / events.length : 0, Rr = gt.length ? tp / gt.length : 0;
  return {
    gt: gt.length, det: events.length, tp,
    precision: P, recall: Rr, f1: P + Rr ? 2 * P * Rr / (P + Rr) : 0,
    pitchAcc: tp ? pitchOk / tp : 0, pitchOctAcc: tp ? pitchOct / tp : 0,
    coverage: gtT ? cov / gtT : 0, outside
  };
}
function chartFit(analysis, gt, diff = 'medium') {
  const c = buildChart(analysis, diff, 'vocal');
  const notes = c.notes;
  const onVoice = notes.filter(n => gt.some(g => n.time >= g.t - 0.1 && n.time <= g.t + g.dur + 0.05)).length;
  return { notes: notes.length, onVoice: notes.length ? onVoice / notes.length : 0 };
}
const inRegion = (events, r) => events.filter(e => e.t >= r.start && e.t < r.end).length;

// ---- senaryolar ----
const report = { scenarios: [] };
const pct = (x) => (x * 100).toFixed(1).padStart(5) + '%';

function runSynth(seed) {
  const rng = makeRng(seed);
  const DUR = 120;
  const { L, R, drums } = synthBed(DUR, rng);
  const gt = [
    ...makeMelody(rng, { start: 6, end: 36 }),
    ...makeMelody(rng, { start: 64, end: 94 })
  ];
  const decoyRegions = [
    { kind: 'flatLead', start: 36, end: 50 },
    { kind: 'vibLead', start: 50, end: 64 },
    { kind: 'pad', start: 94, end: 108 }
  ];
  renderDecoys(L, R, decoyRegions, rng, 0.22);
  overlaySinger(L, R, gt, rng, 0.7);
  const t0 = performance.now();
  const a = analyze(L, R);
  const ms = performance.now() - t0;
  const ev = evaluate(a.events.vocal, gt);
  const fit = chartFit(a, gt);
  const fp = {};
  for (const r of decoyRegions) fp[r.kind] = inRegion(a.events.vocal, r) / ((r.end - r.start) / 60);
  fp.silence = inRegion(a.events.vocal, { start: 108, end: 120 }) / 0.2;
  // davul vurus F1 (+-50 ms) ve tempo
  const onsetF = (det, ref) => {
    const g = ref.map(t => ({ t, midi: 0 }));
    return evaluate(det.map(e => ({ t: e.t, pitch: 0 })), g, { tol: 0.05 }).f1;
  };
  const drum = { kickF1: onsetF(a.events.kick, drums.kick), snareF1: onsetF(a.events.snare, drums.snare), bpmErr: Math.abs(a.bpm - 120) };
  return { name: `synth#${seed}`, ...ev, ...{ chartNotes: fit.notes, chartOnVoice: fit.onVoice }, fpPerMin: fp, drum, sections: a.sections, msPerMin: ms / (DUR / 60), bpm: a.bpm };
}

// C) ayni sentetik sarki, kusursuz kanallarla (yapay zeka ayirmasi yolu)
function runSynthStems(seed) {
  const rng = makeRng(seed);
  const DUR = 120;
  const { L, R } = synthBed(DUR, rng);
  const gt = [...makeMelody(rng, { start: 6, end: 36 }), ...makeMelody(rng, { start: 64, end: 94 })];
  const decoyRegions = [
    { kind: 'flatLead', start: 36, end: 50 },
    { kind: 'vibLead', start: 50, end: 64 },
    { kind: 'pad', start: 94, end: 108 }
  ];
  renderDecoys(L, R, decoyRegions, rng, 0.22);
  const other = new Float32Array(L.length);
  for (let i = 0; i < L.length; i++) other[i] = 0.5 * (L[i] + R[i]);
  const vocals = overlaySinger(L, R, gt, rng, 0.7);
  const silent = new Float32Array(L.length);
  const a = analyze(L, R, { vocals, other, drums: silent, bass: Float32Array.from(silent) });
  const ev = evaluate(a.events.vocal, gt);
  const fp = {};
  // bolge sonu 0.15 sn kirpilir: sonraki gercek notanin unsuz basi bir an once baslayabilir
  for (const r of decoyRegions) fp[r.kind] = inRegion(a.events.vocal, { start: r.start, end: r.end - 0.15 }) / ((r.end - r.start) / 60);
  fp.silence = inRegion(a.events.vocal, { start: 108, end: 120 }) / 0.2;
  const silentEvents = a.events.kick.length + a.events.snare.length + a.events.hat.length + a.events.bass.length;
  return { name: `stems#${seed}`, ...ev, fpPerMin: fp, silentEvents, chartNotes: 0, chartOnVoice: chartFit(a, gt).onVoice, msPerMin: 0 };
}

function runReal(file) {
  const name = path.basename(file, '.mp3');
  const DUR = 90;
  const { L, R } = decode(file, 30, DUR);
  // eslik tek basina (bindirmesiz): kac vokal olayi cikiyor (bilgi amacli)
  const base = analyze(Float32Array.from(L), Float32Array.from(R));
  const rng = makeRng(name.length * 977);
  const gt = makeMelody(rng, { start: 4, end: DUR - 4, bpm: base.bpm > 60 ? base.bpm : 120 });
  overlaySinger(L, R, gt, rng, 0.7);
  const t0 = performance.now();
  const a = analyze(L, R);
  const ms = performance.now() - t0;
  const ev = evaluate(a.events.vocal, gt);
  const fit = chartFit(a, gt);
  return { name, ...ev, chartNotes: fit.notes, chartOnVoice: fit.onVoice, bedVocalPerMin: base.events.vocal.length / (DUR / 60), msPerMin: ms / (DUR / 60), bpm: base.bpm };
}

console.log('CaYa Rhythm — analiz benchmark\n');
const rows = [];
for (const seed of QUICK ? [7] : [7, 21, 99]) rows.push(runSynth(seed));
const stemRows = (QUICK ? [7] : [7, 21, 99]).map(runSynthStems);
const songDir = path.join(ROOT, 'public/testsongs');
if (!QUICK && existsSync(songDir) && hasFfmpeg()) {
  for (const f of readdirSync(songDir).filter(f => f.endsWith('.mp3')).sort()) rows.push(runReal(path.join(songDir, f)));
} else if (!QUICK) {
  console.log('(gercek sarkilar atlandi: public/testsongs veya ffmpeg yok)\n');
}

console.log('senaryo          GT  tesp  kesin  duyarl    F1  perde  p(okt) kapsam chartOK  ms/dk disi ek');
for (const r of rows) {
  const extra = r.fpPerMin
    ? `FP/dk flat=${r.fpPerMin.flatLead.toFixed(1)} vib=${r.fpPerMin.vibLead.toFixed(1)} pad=${r.fpPerMin.pad.toFixed(1)} sess=${r.fpPerMin.silence.toFixed(1)}`
    : `yatakVokal/dk=${r.bedVocalPerMin.toFixed(1)}`;
  console.log(
    r.name.slice(0, 15).padEnd(15),
    String(r.gt).padStart(4), String(r.det).padStart(5),
    pct(r.precision), pct(r.recall), pct(r.f1), pct(r.pitchAcc), pct(r.pitchOctAcc), pct(r.coverage), pct(r.chartOnVoice),
    String(Math.round(r.msPerMin)).padStart(6), String(r.outside).padStart(4), ' ', extra
  );
}
for (const r of stemRows) {
  console.log(`  ${r.name} (kusursuz kanallar): vokal F1 ${pct(r.f1)}  perde ${pct(r.pitchAcc)}  ` +
    `FP/dk flat=${r.fpPerMin.flatLead.toFixed(1)} vib=${r.fpPerMin.vibLead.toFixed(1)} pad=${r.fpPerMin.pad.toFixed(1)} sess=${r.fpPerMin.silence.toFixed(1)}  sessiz kanal olayi ${r.silentEvents}`);
}
for (const r of rows.filter(r => r.drum)) {
  console.log(`  ${r.name} davul: kick F1 ${pct(r.drum.kickF1)}  snare F1 ${pct(r.drum.snareF1)}  BPM hata ${r.drum.bpmErr.toFixed(1)}` +
    (r.sections ? `  bolumler: ${r.sections.map(s => s.label + '@' + s.t.toFixed(0)).join(' ')}` : ''));
}
const mean = (k, list) => list.reduce((a, r) => a + r[k], 0) / Math.max(1, list.length);
const synth = rows.filter(r => r.fpPerMin), real = rows.filter(r => !r.fpPerMin);
const summary = {
  synthF1: mean('f1', synth), synthPitch: mean('pitchAcc', synth), synthCoverage: mean('coverage', synth),
  synthFpDecoyPerMin: mean('fpd', synth.map(r => ({ fpd: (r.fpPerMin.flatLead + r.fpPerMin.vibLead + r.fpPerMin.pad) / 3 }))),
  realRecall: mean('recall', real), realF1: mean('f1', real), realPitch: mean('pitchAcc', real), realCoverage: mean('coverage', real),
  chartOnVoice: mean('chartOnVoice', rows), msPerMin: mean('msPerMin', rows),
  kickF1: mean('k', synth.map(r => ({ k: r.drum.kickF1 }))), snareF1: mean('k', synth.map(r => ({ k: r.drum.snareF1 })))
};
console.log('\nOZET', Object.fromEntries(Object.entries(summary).map(([k, v]) => [k, +v.toFixed(3)])));
report.scenarios = rows; report.summary = summary;
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 2));

// Regresyon kapisi (--quick = npm test / CI): deterministik seed-7 sonuclarinin
// altinda pay birakan esikler. Motor degisikligi bunlari bozarsa test kalir.
if (QUICK) {
  const r = synth[0];
  const decoyFp = (r.fpPerMin.flatLead + r.fpPerMin.vibLead + r.fpPerMin.pad) / 3;
  const checks = [
    ['vokal F1 >= 0.75', r.f1 >= 0.75],
    ['vokal perde >= 0.85', r.pitchAcc >= 0.85],
    ['tuzak FP/dk <= 8', decoyFp <= 8],
    ['kick F1 >= 0.60', r.drum.kickF1 >= 0.6],
    ['snare F1 >= 0.33', r.drum.snareF1 >= 0.33],
    ['BPM hata <= 1', r.drum.bpmErr <= 1]
  ];
  const st = stemRows[0];
  const stFp = (st.fpPerMin.flatLead + st.fpPerMin.vibLead + st.fpPerMin.pad) / 3;
  checks.push(
    ['kanallarla vokal F1 >= 0.85', st.f1 >= 0.85],
    ['kanallarla vokal perde >= 0.9', st.pitchAcc >= 0.9],
    ['kanallarla tuzak FP/dk <= 1', stFp <= 1],
    ['sessiz davul/bas kanalinda olay yok', st.silentEvents === 0]
  );
  let bad = 0;
  for (const [name, ok] of checks) { console.log(`  ${ok ? '✓' : '✗'} ${name}`); if (!ok) bad++; }
  if (bad) { console.log(`
${bad} esik asildi`); process.exit(1); }
}
