// CaYa Rhythm - TUM PARCALAR icin gercek sarki benchmark'i (yalniz gelistirme)
//
// tools/make-stem-refs.py ile Demucs kanallarindan uretilen referanslara karsi
// oyunun analiz worker'ini ve haritalarini olcer:
//   davul : kick F1, ust davul (trampet+hat) F1, tum davul F1      (+-50 ms)
//   bas   : vurus F1 (+-60 ms), eslesen vuruslarda perde sinifi dogrulugu
//   lead  : enstruman ("diger" kanal) vurus F1; vokal vurusuna denk gelme orani
//   harita: her parca (Orta + Usta) notalarinin kendi kanalindaki gercek bir
//           olaya denk gelme orani (P) ve o kanalin olaylarini kapsama orani (R)
//
// Kullanim: node tools/stems-bench.mjs <refs_klasoru> <ses_klasoru> [<ses_klasoru> ...]
//   BENCH_TUNE='{...}' worker'a ayar gecirir (ablasyon). --json sonucu JSON basar.

import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const asJson = process.argv.includes('--json');
const [refDir, ...audioDirs] = args;
if (!refDir || !audioDirs.length) { console.log('kullanim: node tools/stems-bench.mjs <refs> <ses_klasoru>...'); process.exit(0); }
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

// tek-tek eslestirme (her referans en fazla bir tespitle); eslesen ciftleri dondurur
function match(det, ref, tol) {
  const d = [...det].map((t, i) => [t, i]).sort((a, b) => a[0] - b[0]);
  const used = new Uint8Array(d.length);
  const pairs = [];
  let j0 = 0;
  for (let r = 0; r < ref.length; r++) {
    const t = ref[r];
    while (j0 < d.length && d[j0][0] < t - tol) j0++;
    let best = -1, bd = tol + 1e-9;
    for (let j = j0; j < d.length && d[j][0] <= t + tol; j++) {
      if (used[j]) continue;
      const dd = Math.abs(d[j][0] - t);
      if (dd < bd) { bd = dd; best = j; }
    }
    if (best >= 0) { used[best] = 1; pairs.push([d[best][1], r]); }
  }
  return pairs;
}
function prf(det, ref, tol) {
  const tp = match(det, ref, tol).length;
  const P = det.length ? tp / det.length : 0, R = ref.length ? tp / ref.length : 0;
  return { P, R, F: P + R ? 2 * P * R / (P + R) : 0 };
}
// yalniz yakinlik (tek-tek degil): harita notasi bir referans olaya yakin mi
function nearFrac(times, ref, tol) {
  if (!times.length) return 0;
  const r = [...ref].sort((a, b) => a - b);
  let ok = 0;
  for (const t of times) {
    let lo = 0, hi = r.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (r[m] < t) lo = m + 1; else hi = m; }
    const d = Math.min(lo < r.length ? Math.abs(r[lo] - t) : 9, lo > 0 ? Math.abs(r[lo - 1] - t) : 9);
    if (d <= tol) ok++;
  }
  return ok / times.length;
}
// vokal referans konturundan nota baslangiclari (realvocal-bench ile ayni kural)
function vocalOnsets(midi, hop) {
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

// librosa'nin da 2/3'e kaydigi, dinleyerek bilinen tempolar
const BPM_FIX = process.env.BPM_FIX ? JSON.parse(readFileSync(process.env.BPM_FIX, 'utf8')) : {};
const pct = (x) => (x * 100).toFixed(1).padStart(5);
const rows = [];
for (const f of readdirSync(refDir).filter(f => f.endsWith('.json')).sort()) {
  const ref = JSON.parse(readFileSync(path.join(refDir, f), 'utf8'));
  const audio = findAudio(ref.name);
  if (!audio) { console.log('ses bulunamadi:', ref.name); continue; }
  const { L, R } = decode(audio, ref.start, ref.dur);
  self.onmessage({ data: { cmd: 'analyze', left: L, right: R, sampleRate: SR, debug: false, tune: TUNE } });
  const a = result, ev = a.events;
  const T = (arr) => (arr || []).map(e => e.t);
  const d = ref.drums;
  const upperRef = [...d.snare, ...d.hat].sort((x, y) => x - y);
  const vocOn = vocalOnsets(ref.vocal.midi, ref.hop);
  const bassRefT = ref.bass.onsets.map(o => o[0]);

  const row = { name: ref.name };
  // tempo: referans (librosa, temiz davul kanali) ile %4 icinde; acc2 oktav (x2, /2) hatasini da kabul eder
  if (ref.beats) {
    const rb = BPM_FIX[ref.name] || ref.beats.bpm, gb = a.bpm;
    const near = (x) => Math.abs(x / rb - 1) < 0.04;
    row.tempo1 = near(gb) ? 1 : 0;
    row.tempo2 = near(gb) || near(gb * 2) || near(gb / 2) ? 1 : 0;
    row.bpm = gb; row.refBpm = rb;
  }
  const kp = prf(T(ev.kick), d.kick, 0.05);
  row.kick = kp.F; row.kickP = kp.P; row.kickR = kp.R;
  const up = prf([...T(ev.snare), ...T(ev.hat)], upperRef, 0.05);
  row.upper = up.F; row.upperP = up.P; row.upperR = up.R;
  const bpr = prf(T(ev.bass), bassRefT, 0.06);
  row.bassP = bpr.P; row.bassR = bpr.R;
  row.drumAll = prf([...T(ev.kick), ...T(ev.snare), ...T(ev.hat)], d.all, 0.05).F;
  const bp = match(T(ev.bass), bassRefT, 0.06);
  row.bass = prf(T(ev.bass), bassRefT, 0.06).F;
  let pcOk = 0, pcN = 0;
  for (const [i, r] of bp) {
    const rp = ref.bass.onsets[r][1], gp = ev.bass[i].pitch;
    if (rp > 0 && gp > 0) { pcN++; const c = ((Math.round(gp - rp) % 12) + 18) % 12 - 6; if (Math.abs(c) <= 0) pcOk++; }
  }
  row.bassPC = pcN ? pcOk / pcN : 0;
  const leadEv = ev.inst || ev.melody; // Lead parcasi enstruman akisini kullanir
  const lp = prf(T(leadEv), ref.other.onsets, 0.06);
  row.lead = lp.F; row.leadP = lp.P; row.leadR = lp.R;
  row.leadOnVoc = nearFrac(T(leadEv), vocOn, 0.06);

  // harita: kanalina denk gelme (P) ve kanal olaylarini kapsama (R)
  const chartRefs = {
    drums: d.all,
    bass: bassRefT,
    melody: ref.other.onsets,
    vocal: [...vocOn, ...(ref.vocal.syllables || [])].sort((x, y) => x - y),
    mixed: [...d.all, ...ref.other.onsets, ...vocOn]
  };
  for (const mode of ['drums', 'bass', 'melody', 'vocal', 'mixed']) {
    for (const diff of ['medium', 'master']) {
      const ch = buildChart(a, diff, mode);
      const times = ch.notes.filter(n => n.type !== 'lift').map(n => n.time);
      const refT = chartRefs[mode];
      row[`${mode}.${diff}.P`] = nearFrac(times, refT, 0.07);
      row[`${mode}.${diff}.R`] = match(times, refT, 0.07).length / Math.max(1, refT.length);
      row[`${mode}.${diff}.n`] = ch.notes.length;
    }
  }
  // vokal haritasi: notalarin vokalin DUYULDUGU yere dusme orani (rap dahil)
  if (ref.vocal.audible) {
    const au = ref.vocal.audible;
    const ch = buildChart(a, 'medium', 'vocal');
    row.vocAudible = ch.notes.filter(n => { const i = Math.round(n.time / ref.hop); for (let k = Math.max(0, i - 3); k <= Math.min(au.length - 1, i + 8); k++) if (au[k]) return true; return false; }).length / Math.max(1, ch.notes.length);
  }
  rows.push(row);
}

const keys = Object.keys(rows[0] || {}).filter(k => k !== 'name');
const mean = {};
for (const k of keys) mean[k] = rows.reduce((s, r) => s + r[k], 0) / Math.max(1, rows.length);
if (asJson) { console.log(JSON.stringify({ rows, mean })); process.exit(0); }

console.log('ALGILAMA (F1 %)              kick  ustDv  davul    bas basPC   lead leadVok   BPM (ref)');
for (const r of rows) console.log(r.name.slice(0, 26).padEnd(26), pct(r.kick), pct(r.upper), pct(r.drumAll), pct(r.bass), pct(r.bassPC), pct(r.lead), pct(r.leadOnVoc), '  ', r.bpm, `(${r.refBpm})`, r.tempo2 ? '' : 'X');
console.log('  tempo dogru:', pct(mean.tempo1 || 0), ' oktav dahil:', pct(mean.tempo2 || 0));
console.log('ORTALAMA'.padEnd(26), pct(mean.kick), pct(mean.upper), pct(mean.drumAll), pct(mean.bass), pct(mean.bassPC), pct(mean.lead), pct(mean.leadOnVoc));
console.log('  vokal haritasi (Orta) notalarin duyulur vokale dusme orani:', pct(mean.vocAudible || 0));
console.log('  P/R: kick', pct(mean.kickP), pct(mean.kickR), '| ustDv', pct(mean.upperP), pct(mean.upperR), '| bas', pct(mean.bassP), pct(mean.bassR), '| lead', pct(mean.leadP), pct(mean.leadR));
console.log('\nHARITA (ortalama)   Orta P   Orta R  nota |  Usta P   Usta R  nota');
for (const m of ['drums', 'bass', 'melody', 'vocal', 'mixed']) {
  console.log(m.padEnd(18), pct(mean[`${m}.medium.P`]), '  ', pct(mean[`${m}.medium.R`]), String(Math.round(mean[`${m}.medium.n`])).padStart(5), '|',
    pct(mean[`${m}.master.P`]), '  ', pct(mean[`${m}.master.R`]), String(Math.round(mean[`${m}.master.n`])).padStart(5));
}
