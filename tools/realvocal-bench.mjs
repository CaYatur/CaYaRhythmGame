// CaYa Rhythm - GERCEK vokal benchmark'i (yalniz gelistirme)
//
// tools/make-vocal-refs.py ile Demucs'tan uretilen referans vokal konturlarina
// karsi oyunun analiz worker'ini olcer (MIREX melodi cikarimi olcutleri):
//   VR   voicing recall      : referansta vokal olan karelerin yakalanan orani
//   VFA  voicing false alarm : vokal olmayan karelerin yanlis "vokal" orani
//   RPA  raw pitch accuracy  : vokal karelerinde +-1 yarim ton dogru perde
//   RCA  raw chroma accuracy : oktav farki gozetmeden
//   OA   overall accuracy    : tum kareler (dogru perde + dogru sessizlik)
//   OnF  nota baslangic F1 (+-100 ms)
//   chart: Vokal parcasi (Orta) notalarinin gercek vokale denk gelen orani
//
// Kullanim: node tools/realvocal-bench.mjs <refs_klasoru> <ses_klasoru> [<ses_klasoru> ...]
//   (referans adi = ses dosyasinin uzantisiz adi). BENCH_TUNE='{...}' ile ablasyon.
//   STEMS=<klasor>: oyundaki yapay zeka ayirmasi gibi kanallar da verilir
//   (<klasor>/<ad>.<vocals|drums|bass|other>.f32, 22050 Hz mono float32).

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [refDir, ...audioDirs] = process.argv.slice(2);
if (!refDir || !audioDirs.length) { console.log('kullanim: node tools/realvocal-bench.mjs <refs> <ses_klasoru>...'); process.exit(0); }
const TUNE = process.env.BENCH_TUNE ? JSON.parse(process.env.BENCH_TUNE) : {};
const SR = 22050;

const src = readFileSync(path.join(ROOT, 'public/js/audio/analysis-worker.js'), 'utf8');
let result = null;
const self = { postMessage(m) { if (m.type === 'result') result = m; else if (m.type === 'error') throw new Error(m.message); } };
new Function('self', src)(self);
const { buildChart } = await import('data:text/javascript,' + encodeURIComponent(readFileSync(path.join(ROOT, 'public/js/game/chart.js'), 'utf8')));

function findAudio(name) {
  for (const d of audioDirs) for (const f of readdirSync(d)) if (path.parse(f).name === name) return path.join(d, f);
  return null;
}
function decode(file, start, dur) {
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(start), '-t', String(dur), '-i', file, '-f', 'f32le', '-ac', '2', '-ar', String(SR), '-'], { maxBuffer: 1 << 28 });
  const x = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const n = x.length >> 1, L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = x[2 * i]; R[i] = x[2 * i + 1]; }
  return { L, R };
}

// referans nota baslangiclari: sesli bolge baslangici ya da >=1 yarim tonluk
// kalici (>=50 ms) perde degisimi
function refOnsets(midi, hop) {
  const on = [];
  let cur = 0, run = 0, prevV = false;
  for (let i = 0; i < midi.length; i++) {
    const v = midi[i] > 0;
    if (v && !prevV) { on.push(i * hop); cur = midi[i]; run = 0; }
    else if (v) {
      if (Math.abs(midi[i] - cur) >= 1) { run++; if (run >= 5) { on.push((i - 4) * hop); cur = midi[i]; run = 0; } }
      else { run = 0; cur = cur * 0.9 + midi[i] * 0.1; }
    }
    prevV = v;
  }
  return on;
}

function onsetF1(det, ref, tol = 0.1) {
  const used = new Set(); let tp = 0;
  for (const r of ref) {
    let best = -1, bd = tol;
    for (let k = 0; k < det.length; k++) { if (used.has(k)) continue; const d = Math.abs(det[k] - r); if (d <= bd) { bd = d; best = k; } }
    if (best >= 0) { used.add(best); tp++; }
  }
  const P = det.length ? tp / det.length : 0, R = ref.length ? tp / ref.length : 0;
  return P + R ? 2 * P * R / (P + R) : 0;
}

const pct = (x) => (x * 100).toFixed(1).padStart(5) + '%';
const rows = [];
for (const f of readdirSync(refDir).filter(f => f.endsWith('.json')).sort()) {
  const ref = JSON.parse(readFileSync(path.join(refDir, f), 'utf8'));
  const audio = findAudio(ref.name);
  if (!audio) { console.log('ses bulunamadi:', ref.name); continue; }
  const { L, R } = decode(audio, ref.start, ref.dur);
  let stems = null;
  if (process.env.STEMS) {
    stems = {};
    for (const k of ['vocals', 'drums', 'bass', 'other']) {
      const p = path.join(process.env.STEMS, ref.name + '.' + k + '.f32');
      if (!existsSync(p)) { stems = null; break; }
      const b = readFileSync(p);
      stems[k] = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
    }
  }
  self.onmessage({ data: { cmd: 'analyze', left: L, right: R, sampleRate: SR, debug: true, tune: TUNE, stems } });
  const a = result;
  if (!ref.midi && ref.vocal) ref.midi = ref.vocal.midi; // make-stem-refs.py bicimi
  const hop = ref.hop, N = ref.midi.length;
  // tahmin konturu: her vokal segmenti [t, t+len) boyunca sabit perde
  const est = new Float32Array(N);
  for (const e of a.events.vocal) {
    const i0 = Math.max(0, Math.round(e.t / hop)), i1 = Math.min(N, Math.round((e.t + (e.len || e.dur || 0.12)) / hop));
    for (let i = i0; i < i1; i++) est[i] = e.pitch;
  }
  let rv = 0, ru = 0, vr = 0, vfa = 0, rpa = 0, rca = 0, oa = 0;
  for (let i = 0; i < N; i++) {
    const r = ref.midi[i], e = est[i];
    if (r > 0) {
      rv++;
      if (e > 0) {
        vr++;
        const d = e - r;
        if (Math.abs(d) <= 1) { rpa++; oa++; }
        const c = ((d % 12) + 18) % 12 - 6; // -6..6
        if (Math.abs(c) <= 1) rca++;
      }
    } else {
      ru++;
      if (e > 0) vfa++; else oa++;
    }
  }
  const onF = onsetF1(a.events.vocal.map(e => e.t), refOnsets(ref.midi, hop));
  // oyun etkisi: vokal parcasi (Orta) notalarinin gercek vokal uzerine dusme orani
  const chart = buildChart(a, 'medium', 'vocal');
  const onVoice = chart.notes.filter(n => {
    const i = Math.round(n.time / hop);
    for (let k = Math.max(0, i - 6); k <= Math.min(N - 1, i + 8); k++) if (ref.midi[k] > 0) return true;
    return false;
  }).length / Math.max(1, chart.notes.length);
  rows.push({ name: ref.name, VR: vr / rv, VFA: vfa / ru, RPA: rpa / rv, RCA: rca / rv, OA: oa / N, OnF: onF, chart: onVoice, notes: chart.notes.length });
}

console.log('sarki                         VR    VFA    RPA    RCA     OA    OnF  chartOK  nota');
for (const r of rows) {
  console.log(r.name.slice(0, 28).padEnd(28), pct(r.VR), pct(r.VFA), pct(r.RPA), pct(r.RCA), pct(r.OA), pct(r.OnF), pct(r.chart), String(r.notes).padStart(5));
}
const mean = (k) => rows.reduce((s, r) => s + r[k], 0) / Math.max(1, rows.length);
console.log('ORTALAMA'.padEnd(28), pct(mean('VR')), pct(mean('VFA')), pct(mean('RPA')), pct(mean('RCA')), pct(mean('OA')), pct(mean('OnF')), pct(mean('chart')));
