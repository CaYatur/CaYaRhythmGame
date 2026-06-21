// CaYa Rhythm - Kapsamlı Ses Analiz Worker'i (v3)
//
// Vokal/melodi için profesyonel, ML'siz boru hattı:
//   1. STFT (1024/256), pencere: Hann
//   2. Akan HPSS (medyan filtre) -> harmonik / perkusif ayrıştırma
//   3. Stereo merkez izolasyonu: vokaller mikste merkez-panlıdır
//   4. REPET (Rafii & Pardo 2013): segment bazlı tekrar eden arka plan modeli
//      medyanla çıkarılır -> geriye tekrar etmeyen ön plan (vokal) kalır
//   5. Harmonik toplam perde belirginliği (salience) + Viterbi (DP) perde takibi
//      -> pürüzsüz, oktav-hatasız f0 konturu
//   6. Voicing + insan sesi kapısı (vibrato/jitter, kontur pürüzsüzlüğü)
//   7. Konturu notalara böl (perde sıçraması + enerji başlangıcı sınırları)
//
// Perkusyon/tempo:
//   - SuperFlux (Böck & Widmer 2013) bant bazlı vuruş tespiti
//   - Otokorelasyon tempo + dinamik programlamayla vuruş izleme (Ellis 2007)

'use strict';

const SR = 22050;
const FFT_N = 1024;
const HOP = 256;
const BINS = FFT_N / 2;
const BIN_HZ = SR / FFT_N;
const HOP_T = HOP / SR;
const MED_K = 11;
const MED_H = (MED_K - 1) / 2;
const ONSET_OFFSET = 0.033; // STFT grup gecikmesi kalibrasyonu (kalibre edildi)

// Perde aday aralığı (Viterbi durumları): A2(110Hz) .. C6(1047Hz)
const MLO = 45, MHI = 84;
const NSTATE = MHI - MLO + 1;
// Vokal için alt sınır (C3, 131Hz): tipik bas bölgesini dışla
const VOC_LO_STATE = 50 - MLO; // MIDI 50
const WHITEN_W = 20; // beyazlatma penceresi (bin)

// Algısal perde-register ağırlığı (Melodia tarzı): melodi/vokal tipik orta
// register'dadır. Bu, harmonik-toplamın düşük-perde (bas) yanlılığını ve
// oktav-akraba bası lead enerjisini emme sorununu dengeler.
function pitchWeights(center, sigma, loCut) {
  const w = new Float32Array(NSTATE);
  for (let k = 0; k < NSTATE; k++) {
    const midi = MLO + k;
    if (loCut && midi < loCut) { w[k] = 0; continue; }
    const z = (midi - center) / sigma;
    w[k] = Math.exp(-0.5 * z * z);
  }
  return w;
}
const MEL_PW = pitchWeights(64, 10.5, 0); // melodi: E4 merkez, bası bastırır
const VOC_PW = pitchWeights(67, 11, 50);  // vokal: G4 merkez, bas kesimli

// ---------- FFT ----------
function makeFFT(n) {
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let x = i, r = 0;
    for (let b = 1; b < n; b <<= 1) { r = (r << 1) | (x & 1); x >>= 1; }
    rev[i] = r;
  }
  const cosT = new Float32Array(n / 2), sinT = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cosT[i] = Math.cos(-2 * Math.PI * i / n);
    sinT[i] = Math.sin(-2 * Math.PI * i / n);
  }
  return function transform(re, im) {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1, step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let k = 0; k < half; k++) {
          const tw = k * step, wr = cosT[tw], wi = sinT[tw];
          const a = i + k, b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  };
}

function median(arr, len, scratch) {
  for (let i = 0; i < len; i++) scratch[i] = arr[i];
  for (let i = 1; i < len; i++) {
    const v = scratch[i]; let j = i - 1;
    while (j >= 0 && scratch[j] > v) { scratch[j + 1] = scratch[j]; j--; }
    scratch[j + 1] = v;
  }
  return scratch[(len - 1) >> 1];
}

const hzBin = (hz) => Math.max(0, Math.min(BINS - 1, Math.round(hz / BIN_HZ)));
const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

const BAND = {
  kick: [hzBin(35), hzBin(110)],   // gerçek kick thump'ı (bas sızıntısını azalt)
  snare: [hzBin(200), hzBin(2400)],
  hat: [hzBin(5000), hzBin(11000)],
  mel: [hzBin(150), hzBin(5000)],
  bass: [hzBin(45), hzBin(260)]
};

function p95(arr, n) {
  n = n || arr.length;
  const s = Float32Array.from(arr.subarray ? arr.subarray(0, n) : arr.slice(0, n)).sort();
  return Math.max(1e-9, s[Math.floor(s.length * 0.95)]);
}

function percentileRanks(values) {
  const sorted = Float32Array.from(values).sort();
  return values.map(v => {
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < v) lo = mid + 1; else hi = mid; }
    return sorted.length > 1 ? lo / (sorted.length - 1) : 1;
  });
}

// ---------- aday harmonik bin listeleri (salience) ----------
function buildCandidates() {
  const cand = [];
  for (let k = 0; k < NSTATE; k++) {
    const f0 = midiHz(MLO + k);
    const bins = [];
    for (let h = 1; h <= 10; h++) {
      const f = f0 * h;
      if (f >= 10500) break;
      const b = f / BIN_HZ;
      bins.push([Math.floor(b), Math.min(BINS - 1, Math.ceil(b)), Math.pow(0.8, h - 1)]);
    }
    cand.push(bins);
  }
  return cand;
}
function salienceRow(mag, cand, out) {
  for (let k = 0; k < NSTATE; k++) {
    let s = 0, odd = 0, even = 0; const hb = cand[k];
    for (let j = 0; j < hb.length; j++) {
      const e = hb[j];
      const v = mag[e[0]] > mag[e[1]] ? mag[e[0]] : mag[e[1]];
      s += v * e[2];
      // h=1,3,5,... (tek harmonik, j çift) vs h=2,4,6,... (çift harmonik, j tek)
      if ((j & 1) === 0) odd += v; else even += v;
    }
    // Tek/çift harmonik dengesi ile alt-oktav yanılgısını kır: gerçek f0'da
    // temel + tek harmonikler güçlüdür; bir oktav aşağıdaki sahte adayda enerji
    // ağırlıkla ÇİFT harmoniklerden (= gerçek f0) gelir, tek harmonikler zayıftır.
    out[k] = s * (odd > 0.35 * even ? 1 : 0.08);
  }
}

// Spektral beyazlatma (Klapuri): yerel spektral zarfa böl -> güçlü düşük
// harmoniklerin baskınlığı (bas/düşük-f0 yanlılığı) kırılır, harmonik
// VARLIĞI öne çıkar. Belirginlik bunun üzerinde hesaplanınca melodi/vokal
// bası yenebilir.
const _wPrefix = new Float32Array(BINS + 1);
function whiten(mag, out, W) {
  _wPrefix[0] = 0;
  for (let b = 0; b < BINS; b++) _wPrefix[b + 1] = _wPrefix[b] + mag[b];
  const rowMean = _wPrefix[BINS] / BINS;
  // global taban: sessiz bölgelerde sızıntı/gürültü şişmesin (sahte temel olmasın)
  const floor = 0.2 * rowMean + 1e-7;
  for (let b = 0; b < BINS; b++) {
    const lo = Math.max(0, b - W), hi = Math.min(BINS, b + W + 1);
    const avg = (_wPrefix[hi] - _wPrefix[lo]) / (hi - lo);
    out[b] = mag[b] / (avg + floor);
  }
}

// SuperFlux bant akısı (log-genlik, referans maks-filtreli)
function bandSuperFlux(curLog, prevLogMax, b0, b1) {
  let s = 0;
  for (let b = b0; b < b1; b++) { const d = curLog[b] - prevLogMax[b]; if (d > 0) s += d; }
  return s;
}

function pickPeaks(flux, opts) {
  const { meanW = 12, mul = 1.35, add = 0.012, minSep = 8, localW = 3 } = opts || {};
  const F = flux.length;
  const norm = p95(flux);
  const f = new Float32Array(F);
  for (let i = 0; i < F; i++) f[i] = flux[i] / norm;
  const peaks = [];
  let lastPeak = -minSep;
  for (let i = 2; i < F - 2; i++) {
    let isMax = true;
    for (let k = -localW; k <= localW; k++) {
      if (k !== 0 && i + k >= 0 && i + k < F && f[i + k] > f[i]) { isMax = false; break; }
    }
    if (!isMax) continue;
    let m = 0, c = 0;
    for (let k = Math.max(0, i - meanW); k <= Math.min(F - 1, i + meanW); k++) { m += f[k]; c++; }
    m /= c;
    if (f[i] < m * mul + add) continue;
    const a = f[i - 1], mm = f[i], r = f[i + 1];
    const den = a - 2 * mm + r;
    const dx = Math.abs(den) > 1e-9 ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - r) / den)) : 0;
    const t = (i + dx) * HOP_T + ONSET_OFFSET;
    if (i - lastPeak < minSep) {
      if (peaks.length && f[i] > peaks[peaks.length - 1].v) { peaks[peaks.length - 1] = { i, t, v: f[i] }; lastPeak = i; }
      continue;
    }
    peaks.push({ i, t, v: f[i] });
    lastPeak = i;
  }
  const ranks = percentileRanks(peaks.map(p => p.v));
  return peaks.map((p, k) => ({ frame: p.i, t: Math.max(0, p.t), s: ranks[k] }));
}

// ---------- Viterbi perde takibi ----------
// salMat: F*NSTATE (kare başına normalize edilmiş belirginlik)
// Geçiş cezası DOĞRUSAL (|perde farkı|): küçük adımlar (vibrato/glide) ucuz ama
// melodideki büyük meşru sıçramalar (eşlik<->lead) emisyon destekliyorsa olur.
// Çok küçük adımlara ek minik karesel terim -> vibrato pürüzsüzlüğü.
function trackPitchDP(salMat, F, lambda) {
  const score = new Float32Array(F * NSTATE);
  const back = new Int16Array(F * NSTATE);
  for (let s = 0; s < NSTATE; s++) score[s] = salMat[s];
  for (let f = 1; f < F; f++) {
    const base = f * NSTATE, prev = (f - 1) * NSTATE;
    for (let s = 0; s < NSTATE; s++) {
      let best = -1e18, bi = 0;
      for (let ps = 0; ps < NSTATE; ps++) {
        const d = s - ps, ad = d < 0 ? -d : d;
        const v = score[prev + ps] - lambda * ad - 0.02 * (ad <= 2 ? d * d : 0);
        if (v > best) { best = v; bi = ps; }
      }
      score[base + s] = best + salMat[base + s];
      back[base + s] = bi;
    }
  }
  // son kare en iyi durum
  let bestS = 0, bestV = -1e18;
  const last = (F - 1) * NSTATE;
  for (let s = 0; s < NSTATE; s++) if (score[last + s] > bestV) { bestV = score[last + s]; bestS = s; }
  const path = new Int16Array(F);
  let s = bestS;
  for (let f = F - 1; f >= 0; f--) { path[f] = s; s = back[f * NSTATE + s]; }
  return path;
}

// ---------- melodik segmentasyon (Viterbi yolu + voicing) ----------
function segmentFromContour(opt) {
  const { F, path, midiRaw, salStr, fluxPeaks, humanGate } = opt;
  // voicing: mutlak ağırlıklı salience gücüne göre. Bas/eşlik perde-ağırlığıyla
  // zaten bastırıldığından, melodik kaynak sustuğunda güç düşer -> unvoiced.
  const strFloor = 0.18 * p95(salStr);

  const voiced = new Uint8Array(F);
  for (let i = 0; i < F; i++) voiced[i] = salStr[i] > strFloor ? 1 : 0;
  // küçük boşlukları kapat (<=3 kare)
  for (let i = 1; i < F - 3; i++) {
    if (!voiced[i] && voiced[i - 1]) {
      let g = i; while (g < F && g < i + 4 && !voiced[g]) g++;
      if (g < F && voiced[g]) for (let k = i; k < g; k++) voiced[k] = 1;
    }
  }

  const segments = [];
  let i = 0;
  while (i < F) {
    if (!voiced[i]) { i++; continue; }
    let runEnd = i; while (runEnd < F && voiced[runEnd]) runEnd++;

    let segStart = i;
    const closeSeg = (end) => {
      const len = end - segStart;
      if (len < 4) { segStart = end; return; }
      // perde: yol modu (en sık durum)
      const counts = {};
      let bestMidi = path[segStart], bestC = 0;
      for (let g = segStart; g < end; g++) {
        const m = path[g]; counts[m] = (counts[m] || 0) + 1;
        if (counts[m] > bestC) { bestC = counts[m]; bestMidi = m; }
      }
      const midi = MLO + bestMidi;
      let en = 0, cnt = 0;
      for (let g = segStart; g < Math.min(end, segStart + 9); g++) { en += salStr[g]; cnt++; }

      // insan sesi kapısı: REPET zaten ana enstrüman/vokal ayracıdır.
      // Bu kapı yalnız REPET'ten sızan CANSIZ-DÜZ sentez/enstrüman tonlarını eler:
      // insan sesinde her zaman doğal perde mikro-hareketi (jitter/vibrato/glide)
      // vardır; tamamen düz bir kontur insan değildir.
      let human = true;
      if (humanGate && len >= 7) {
        const from = segStart + 1, to = end - 1;
        let mean = 0, n = 0;
        for (let g = from; g < to; g++) { mean += midiRaw[g]; n++; }
        mean /= Math.max(1, n);
        let varr = 0;
        for (let g = from; g < to; g++) { const dd = midiRaw[g] - mean; varr += dd * dd; }
        const std = Math.sqrt(varr / Math.max(1, n));
        if (std < 0.05) human = false; // cizgi-duz ton: insan degil
      }
      if (human) {
        segments.push({ frame: segStart, t: segStart * HOP_T + ONSET_OFFSET, dur: len * HOP_T, pitch: midi, rawS: en / Math.max(1, cnt) });
      }
      segStart = end;
    };

    let jump = 0;
    for (let g = i; g < runEnd; g++) {
      const segLen = g - segStart;
      // perde sıçraması: segment başına göre >=2 yarım ton (tam ton) ve 3 kare
      // sürekli -> vibrato/glide (±yarım ton) sustain'i bölmesin
      if (segLen >= 4 && Math.abs(path[g] - path[segStart]) >= 2) {
        jump++;
        if (jump >= 3) { closeSeg(g - 2); jump = 0; }
      } else jump = 0;
      // güç yeniden-vurusu (gerçek onset)
      if (segLen >= 5 && fluxPeaks.has(g)) {
        let before = 0, after = 0, nb = 0, na = 0;
        for (let k = Math.max(0, g - 4); k < g; k++) { before += salStr[k]; nb++; }
        for (let k = g + 1; k < Math.min(F, g + 5); k++) { after += salStr[k]; na++; }
        before /= Math.max(1, nb); after /= Math.max(1, na);
        if (after > before * 1.25) closeSeg(g);
      }
    }
    closeSeg(runEnd);
    i = runEnd;
  }

  const kept = segments.filter(s => s.dur >= 0.09);
  const ranks = percentileRanks(kept.map(s => s.rawS));
  return kept.map((s, k) => ({ t: Math.max(0, s.t), s: ranks[k], pitch: s.pitch, dur: s.dur >= 0.32 ? Math.min(s.dur, 8) : 0 }));
}

// ---------- tempo + DP vuruş izleme (Ellis 2007) ----------
function trackBeats(envIn, F) {
  const norm = p95(envIn);
  const env = new Float32Array(F);
  for (let i = 1; i < F - 1; i++) env[i] = Math.min(4, (envIn[i - 1] * 0.25 + envIn[i] * 0.5 + envIn[i + 1] * 0.25) / norm);

  const minLag = Math.max(6, Math.round(60 / 200 / HOP_T));
  const maxLag = Math.min(F - 1, Math.round(60 / 60 / HOP_T));
  const maxN = Math.min(F, Math.round(150 / HOP_T));
  const rs = new Float32Array(maxLag * 3 + 3);
  for (let lag = minLag; lag <= Math.min(F - 1, maxLag * 3); lag++) {
    let s = 0, c = 0;
    for (let i = 0; i + lag < maxN; i++) { s += env[i] * env[i + lag]; c++; }
    rs[lag] = c > 0 ? s / c : 0;
  }
  let bestLag = minLag, bestScore = -1;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = 60 / (lag * HOP_T);
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
    const h2 = lag * 2 <= maxLag * 3 ? rs[lag * 2] : 0;
    const h3 = lag * 3 <= maxLag * 3 ? rs[lag * 3] : 0;
    const score = (rs[lag] + 0.5 * h2 + 0.33 * h3) * prior;
    if (score > bestScore) { bestScore = score; bestLag = lag; }
  }
  let tau = bestLag;
  if (bestLag > minLag && bestLag < maxLag) {
    const a = rs[bestLag - 1], m = rs[bestLag], r = rs[bestLag + 1];
    const den = a - 2 * m + r;
    if (Math.abs(den) > 1e-12) tau = bestLag + Math.max(-0.5, Math.min(0.5, 0.5 * (a - r) / den));
  }

  const ALPHA = 60;
  const C = new Float32Array(F);
  const P = new Int32Array(F).fill(-1);
  const lo = Math.max(1, Math.round(tau * 0.5));
  const hi = Math.round(tau * 2);
  for (let t = 0; t < F; t++) {
    let best = -1e9, bp = -1;
    for (let d = lo; d <= hi; d++) {
      const p = t - d; if (p < 0) break;
      const ln = Math.log(d / tau);
      const sc = C[p] - ALPHA * ln * ln;
      if (sc > best) { best = sc; bp = p; }
    }
    C[t] = env[t] + (best > 0 ? best : 0);
    P[t] = best > 0 ? bp : -1;
  }
  let end = F - 1, bestC = -1;
  for (let t = Math.max(0, F - 1 - hi); t < F; t++) if (C[t] > bestC) { bestC = C[t]; end = t; }
  const beatFrames = [];
  for (let t = end; t >= 0; t = P[t]) { beatFrames.push(t); if (P[t] < 0) break; }
  beatFrames.reverse();

  const beats = beatFrames.map(f => f * HOP_T + ONSET_OFFSET);
  let bpm = 60 / (tau * HOP_T);
  if (beats.length > 8) {
    const ivs = [];
    for (let k = 1; k < beats.length; k++) ivs.push(beats[k] - beats[k - 1]);
    ivs.sort((a, b) => a - b);
    const medIv = ivs[(ivs.length - 1) >> 1];
    if (medIv > 0.2) bpm = 60 / medIv;
  }
  return { beats, bpm: Math.round(bpm * 10) / 10, beatPeriod: 60 / bpm, beatOffset: beats.length ? beats[0] : 0 };
}

// ---------- REPET: segment içi tekrar eden arka planı çıkar ----------
// seg: segCount*BINS genlik spektrumu; çıktı: aynı yere tekrar-etmeyen ön plan yazar
function repetSegment(seg, segCount, scratchMed) {
  const segSh = seg;
  // 1D enerji zarfı
  const env = new Float32Array(segCount);
  for (let f = 0; f < segCount; f++) {
    let s = 0; const base = f * BINS;
    for (let b = 0; b < BINS; b++) s += segSh[base + b];
    env[f] = s;
  }
  // tekrar periyodu: zarf otokorelasyonu (0.4s .. min(seg/3, 10s))
  const minLag = Math.max(Math.round(0.4 / HOP_T), 8);
  const maxLag = Math.min(Math.floor(segCount / 3), Math.round(10 / HOP_T));
  let p = 0, bestR = 0;
  let mean = 0; for (let f = 0; f < segCount; f++) mean += env[f]; mean /= segCount;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0, c = 0;
    for (let f = 0; f + lag < segCount; f++) { s += (env[f] - mean) * (env[f + lag] - mean); c++; }
    const r = c > 0 ? s / c : 0;
    if (r > bestR) { bestR = r; p = lag; }
  }
  if (p < minLag) return; // belirgin tekrar yok: ön plan = sh (dokunma)

  // tekrar modeli: her (faz, bin) için tekrarlar boyunca medyan
  const reps = Math.ceil(segCount / p);
  const col = new Float32Array(reps);
  const model = new Float32Array(p * BINS);
  for (let r = 0; r < p; r++) {
    const mbase = r * BINS;
    for (let b = 0; b < BINS; b++) {
      let n = 0;
      for (let f = r; f < segCount; f += p) col[n++] = segSh[f * BINS + b];
      model[mbase + b] = median(col, n, scratchMed);
    }
  }
  // ön plan (vokal) = max(0, sh - min(sh, model))  [yumuşak maske eşdeğeri]
  for (let f = 0; f < segCount; f++) {
    const base = f * BINS, mbase = (f % p) * BINS;
    for (let b = 0; b < BINS; b++) {
      const v = segSh[base + b];
      const bg = Math.min(v, model[mbase + b]);
      segSh[base + b] = v - bg; // yerinde: artık vokal ön plan
    }
  }
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.cmd !== 'analyze') return;
  try {
    const result = analyze(msg.center, msg.side, msg.sampleRate);
    self.postMessage({ type: 'result', ...result });
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.stack || err) });
  }
};
function progress(stage, pct) { self.postMessage({ type: 'progress', stage, pct }); }

function analyze(center, side, sampleRate) {
  if (Math.abs(sampleRate - SR) > 1) throw new Error('Beklenmeyen örnekleme hızı: ' + sampleRate);
  const len = center.length;
  const F = Math.max(1, Math.floor((len - FFT_N) / HOP) + 1);
  const duration = len / SR;

  const fft = makeFFT(FFT_N);
  const win = new Float32Array(FFT_N);
  for (let i = 0; i < FFT_N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (FFT_N - 1));
  const re = new Float32Array(FFT_N), im = new Float32Array(FFT_N);

  const ringC = [], ringS = [];
  for (let i = 0; i < MED_K; i++) { ringC.push(new Float32Array(BINS)); ringS.push(new Float32Array(BINS)); }
  const scratch = new Float32Array(MED_K);
  const timeWin = new Float32Array(MED_K);
  const harmRow = new Float32Array(BINS), percRow = new Float32Array(BINS);
  const shRow = new Float32Array(BINS), spRow = new Float32Array(BINS);
  const shW = new Float32Array(BINS), vmW = new Float32Array(BINS); // beyazlatılmış
  const lsp = new Float32Array(BINS), prevLspMax = new Float32Array(BINS), tmpMax = new Float32Array(BINS);

  // perkusyon + tempo
  const fxKick = new Float32Array(F), fxSnare = new Float32Array(F), fxHat = new Float32Array(F);
  const fxBass = new Float32Array(F), enBass = new Float32Array(F), envBeat = new Float32Array(F);

  // melodi (akan, REPET'siz): salience matrisi + güç + ham perde
  const cand = buildCandidates();
  const melSal = new Float32Array(F * NSTATE);
  const melStr = new Float32Array(F), melRawMidi = new Float32Array(F); // mutlak ağırlıklı güç
  const tmpSal = new Float32Array(NSTATE);

  // vokal (segment bazlı REPET): salience matrisi + güç + ham perde
  const vocSal = new Float32Array(F * NSTATE);
  const vocStr = new Float32Array(F), vocRawMidi = new Float32Array(F);

  // REPET segment tamponu:
  //   segMag = TAM merkez genlik (davullar dahil -> güçlü tekrar periyodu)
  //   segW   = harmonik maske * merkezlik (REPET sonrası ön plana uygulanır;
  //            perkusif kalıntıyı ve yan-panlı içeriği eler)
  const SEG = Math.round(16 / HOP_T); // ~16 sn
  const segMag = new Float32Array(SEG * BINS);
  const segW = new Float32Array(SEG * BINS);
  const segMedScratch = new Float32Array(Math.ceil(SEG / 8) + 2);
  let segCount = 0, segBase = 0;

  const log1p20 = (x) => Math.log(1 + 20 * x);
  const maxFilt = (src, dst) => {
    dst[0] = Math.max(src[0], src[1]);
    for (let b = 1; b < BINS - 1; b++) dst[b] = Math.max(src[b - 1], src[b], src[b + 1]);
    dst[BINS - 1] = Math.max(src[BINS - 2], src[BINS - 1]);
  };

  // bir segment dolunca/bitince REPET + vokal özellik çıkarımı
  function flushSegment() {
    if (segCount === 0) return;
    repetSegment(segMag, segCount, segMedScratch); // segMag artık ön plan (tekrar etmeyen)
    const vm = new Float32Array(BINS);
    for (let f = 0; f < segCount; f++) {
      const gf = segBase + f, base = f * BINS;
      for (let b = 0; b < BINS; b++) {
        vm[b] = segMag[base + b] * segW[base + b]; // ön plan * (harmonik*merkezlik)
      }
      salienceRow(vm, cand, tmpSal);
      let bestK = VOC_LO_STATE, bestV = 0;
      for (let k = 0; k < NSTATE; k++) {
        const sv = tmpSal[k] * VOC_PW[k]; // algısal register ağırlığı (+ bas kesimi)
        vocSal[gf * NSTATE + k] = sv;
        if (sv > bestV) { bestV = sv; bestK = k; }
      }
      vocStr[gf] = bestV; // mutlak ağırlıklı güç (voicing için)
      vocRawMidi[gf] = MLO + bestK;
    }
    segBase += segCount;
    segCount = 0;
  }

  let lastPct = -1;
  for (let f = 0; f < F + MED_H; f++) {
    if (f < F) {
      const off = f * HOP;
      for (let i = 0; i < FFT_N; i++) { const s = off + i < len ? center[off + i] : 0; re[i] = s * win[i]; im[i] = 0; }
      fft(re, im);
      const magC = ringC[f % MED_K];
      for (let b = 0; b < BINS; b++) magC[b] = Math.hypot(re[b], im[b]);
      for (let i = 0; i < FFT_N; i++) { const s = off + i < len ? side[off + i] : 0; re[i] = s * win[i]; im[i] = 0; }
      fft(re, im);
      const magS = ringS[f % MED_K];
      for (let b = 0; b < BINS; b++) magS[b] = Math.hypot(re[b], im[b]);
    } else {
      ringC[f % MED_K].fill(0); ringS[f % MED_K].fill(0);
    }

    const c = f - MED_H;
    if (c < 0 || c >= F) continue;
    const magC = ringC[c % MED_K], magS = ringS[c % MED_K];

    // HPSS
    for (let b = 0; b < BINS; b++) {
      for (let k = 0; k < MED_K; k++) {
        const fr = c - MED_H + k;
        timeWin[k] = (fr >= 0 && fr < F) ? ringC[((fr % MED_K) + MED_K) % MED_K][b] : 0;
      }
      harmRow[b] = median(timeWin, MED_K, scratch);
    }
    for (let b = 0; b < BINS; b++) {
      let n = 0;
      for (let k = -MED_H; k <= MED_H; k++) { const bb = b + k; if (bb >= 0 && bb < BINS) timeWin[n++] = magC[bb]; }
      percRow[b] = median(timeWin, n, scratch);
    }
    for (let b = 0; b < BINS; b++) {
      const h2 = harmRow[b] * harmRow[b], p2 = percRow[b] * percRow[b];
      const hm = h2 / (h2 + p2 + 1e-9);
      shRow[b] = magC[b] * hm;   // harmonik merkez
      spRow[b] = magC[b] * (1 - hm); // perkusif
    }

    // perkusyon SuperFlux
    for (let b = 0; b < BINS; b++) lsp[b] = log1p20(spRow[b]);
    fxKick[c] = bandSuperFlux(lsp, prevLspMax, BAND.kick[0], BAND.kick[1]);
    fxSnare[c] = bandSuperFlux(lsp, prevLspMax, BAND.snare[0], BAND.snare[1]);
    fxHat[c] = bandSuperFlux(lsp, prevLspMax, BAND.hat[0], BAND.hat[1]);
    fxBass[c] = bandSuperFlux(lsp, prevLspMax, BAND.bass[0], BAND.bass[1]);
    maxFilt(lsp, tmpMax); prevLspMax.set(tmpMax);

    let eB = 0;
    for (let b = BAND.bass[0]; b < BAND.bass[1]; b++) eB += shRow[b];
    enBass[c] = eB;
    envBeat[c] = fxKick[c] * 1.0 + fxSnare[c] * 0.8 + fxHat[c] * 0.4;

    // melodi (akan): sh üzerinde salience (HAM — beyazlatma temel kapısını bozar)
    salienceRow(shRow, cand, tmpSal);
    let mBestK = 0, mBestV = 0;
    for (let k = 0; k < NSTATE; k++) { const sv = tmpSal[k] * MEL_PW[k]; melSal[c * NSTATE + k] = sv; if (sv > mBestV) { mBestV = sv; mBestK = k; } }
    melStr[c] = mBestV; // mutlak ağırlıklı güç (voicing için)
    melRawMidi[c] = MLO + mBestK;

    // REPET segment tamponuna it: tam merkez genlik + (harmonik*merkezlik) ağırlık
    const sbase = segCount * BINS;
    for (let b = 0; b < BINS; b++) {
      const h = harmRow[b], pp = percRow[b];
      const hm = (h * h) / (h * h + pp * pp + 1e-9); // harmonik maske
      const sh = shRow[b];
      const centerness = sh / (sh + magS[b] + 1e-9); // merkezlik (mono'da 1)
      segMag[sbase + b] = magC[b];
      segW[sbase + b] = hm * centerness;
    }
    segCount++;
    if (segCount >= SEG) flushSegment();

    const pct = Math.floor(((c + 1) / F) * 70);
    if (pct !== lastPct && pct % 2 === 0) { lastPct = pct; progress('spectrum', pct); }
  }
  flushSegment();

  progress('beats', 72);
  const kicks = pickPeaks(fxKick, { minSep: 8, mul: 1.45 });
  const snares = pickPeaks(fxSnare, { minSep: 8, mul: 1.4 });
  const hats = pickPeaks(fxHat, { minSep: 5, mul: 1.45 });
  const bassRaw = pickPeaks(fxBass, { minSep: 14, mul: 1.4, meanW: 16 });
  const bass = bassRaw.map((p, idx) => {
    let e0 = 0, c0 = 0;
    for (let g = p.frame + 1; g < Math.min(F, p.frame + 5); g++) { e0 += enBass[g]; c0++; }
    e0 /= Math.max(1, c0);
    let g = p.frame + 4;
    const nextOnset = idx + 1 < bassRaw.length ? bassRaw[idx + 1].frame : F;
    while (g < F && g < nextOnset - 2 && enBass[g] > 0.35 * e0) g++;
    const dur = (g - p.frame) * HOP_T;
    return { t: p.t, s: p.s, dur: dur >= 0.45 ? dur : 0 };
  });

  progress('melody', 82);
  // melodi salience'ı kare-max ile normalize et (Viterbi emisyonu)
  normalizeSal(melSal, F);
  const melPath = trackPitchDP(melSal, F, 0.08);
  const melFlux = new Float32Array(F);
  for (let i = 1; i < F; i++) { const d = melStr[i] - melStr[i - 1]; melFlux[i] = d > 0 ? d : 0; }
  const melFluxPeaks = new Set(pickPeaks(melFlux, { minSep: 6, mul: 1.4, meanW: 14 }).filter(p => p.s >= 0.3).map(p => p.frame));
  const melody = segmentFromContour({ F, path: melPath, midiRaw: melRawMidi, salStr: melStr, fluxPeaks: melFluxPeaks, humanGate: false });

  progress('vocal', 90);
  normalizeSal(vocSal, F);
  const vocPath = trackPitchDP(vocSal, F, 0.08);
  const vocFlux = new Float32Array(F);
  for (let i = 1; i < F; i++) { const d = vocStr[i] - vocStr[i - 1]; vocFlux[i] = d > 0 ? d : 0; }
  const vocFluxPeaks = new Set(pickPeaks(vocFlux, { minSep: 8, mul: 1.4, meanW: 14 }).filter(p => p.s >= 0.3).map(p => p.frame));
  const vocal = segmentFromContour({ F, path: vocPath, midiRaw: vocRawMidi, salStr: vocStr, fluxPeaks: vocFluxPeaks, humanGate: true });

  progress('tempo', 96);
  const beatInfo = trackBeats(envBeat, F);

  progress('done', 100);
  return {
    events: {
      kick: kicks.map(p => ({ t: p.t, s: p.s })),
      snare: snares.map(p => ({ t: p.t, s: p.s })),
      hat: hats.map(p => ({ t: p.t, s: p.s })),
      bass, vocal, melody
    },
    beats: beatInfo.beats,
    bpm: beatInfo.bpm,
    beatPeriod: beatInfo.beatPeriod,
    beatOffset: beatInfo.beatOffset,
    duration
  };
}

function normalizeSal(sal, F) {
  for (let f = 0; f < F; f++) {
    const base = f * NSTATE;
    let mx = 0;
    for (let k = 0; k < NSTATE; k++) if (sal[base + k] > mx) mx = sal[base + k];
    if (mx > 1e-9) for (let k = 0; k < NSTATE; k++) sal[base + k] /= mx;
    else for (let k = 0; k < NSTATE; k++) sal[base + k] = 0;
  }
}
function salAtPath(sal, path, F) {
  const out = new Float32Array(F);
  for (let f = 0; f < F; f++) out[f] = sal[f * NSTATE + path[f]];
  return out;
}
