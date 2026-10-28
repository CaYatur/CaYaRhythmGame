// CaYa Rhythm - Kapsamli Ses Analiz Worker'i (v4)
//
// Girdi: ham sol/sag kanal (22050 Hz). ML'siz boru hatti:
//   1. Sol ve sag kanal icin STFT (1024/256, Hann)
//   2. Kanal-arasi benzerlik (Avendano & Jot) -> bin bazli merkez maskesi
//      (vokaller mikste merkez-panli ve ayni fazlidir)
//   3. Akan HPSS (medyan filtre) -> harmonik / perkusif ayristirma
//   4. REPET (Rafii & Pardo 2013): tekrar eden eslik modeli medyanla cikarilir
//   5. Harmonik toplam belirginligi + ust-oktav duzeltmesi + Viterbi perde takibi
//   6. Ince (cent) perde + tini ozellikleri -> insan sesi kapisi:
//      formant izi, perde mikro-hareketi, harmoniklik
//   6b. Vokal PERDESI tam harmonik merkez spektrumdan (melodi yolu), vokal
//      VARLIGI (voicing) ise melodi gucu + vokal on plan gucu + harmoniklik
//      birlesik skorundan + mutlak vokal tabanindan gelir (gercek vokal
//      benchmark'i: tools/realvocal-bench.mjs, Demucs referansli)
//   7. Konturu notalara bol (perde sicramasi + cukurlu enerji yeniden vurusu)
//
// Perkusyon/tempo/yapi:
//   - SuperFlux (Bock & Widmer 2013) bant bazli vurus tespiti
//     + kick sonum testi (bas notasini ele) + trampet gurultuluk testi
//   - Otokorelasyon tempo + dinamik programlamayla vurus izleme (Ellis 2007)
//   - Oz-benzerlik yenilik egrisiyle bolum sinirlari (Foote 2000) + yogunluk
//
// Tum esikler tools/analysis-bench.mjs ile (yer gercegi bilinen sentetik
// sarkici + vokal-olmayan tuzaklar + gercek miksler) olculerek ayarlanmistir.

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
const MLO = 40, MHI = 84; // E2 .. C6 (erkek/rap vokalleri A2'ye kadar iner)
const NSTATE = MHI - MLO + 1;
// Vokal için alt sınır (C3, 131Hz): tipik bas bölgesini dışla
const VOC_LO_STATE = 50 - MLO; // vokal varsayilan alt sinir (tune.vocLo ile)
const WHITEN_W = 20; // beyazlatma penceresi (bin)
let DEBUG = false; // benchmark: segment ozelliklerini sonuca ekle

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

const FLAT_LO = hzBin(1000), FLAT_HI = hzBin(8000);
// kroma: 100 Hz - 5 kHz binlerinin perde sinifi
const PC_LO = hzBin(100), PC_HI = hzBin(5000);
const BIN_PC = (() => {
  const a = new Uint8Array(BINS);
  for (let b = 1; b < BINS; b++) a[b] = ((Math.round(69 + 12 * Math.log2(b * BIN_HZ / 440)) % 12) + 12) % 12;
  return a;
})();
const TIMBRE_EDGES = [hzBin(30), hzBin(120), hzBin(400), hzBin(1200), hzBin(3000), hzBin(6000), BINS];

function p95(arr, n) {
  n = n || arr.length;
  const s = Float32Array.from(arr.subarray ? arr.subarray(0, n) : arr.slice(0, n)).sort();
  return Math.max(1e-9, s[Math.floor(s.length * 0.95)]);
}

function percentileRanks(values) {
  // Float64: Float32 yuvarlamasi v'yi tum degerlerden buyuk gosterip >1 uretmesin
  const sorted = Float64Array.from(values).sort();
  return values.map(v => {
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < v) lo = mid + 1; else hi = mid; }
    return sorted.length > 1 ? Math.min(1, lo / (sorted.length - 1)) : 1;
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
    let v = s * (odd > 0.35 * even ? 1 : 0.08);
    out[k] = v;
  }
}
// Ust-oktav yanilgisi: aday f0 gercekte 2*f0 ise (gercek f0 bir oktav
// asagida), adayin harmonikleri ARASINDA (0.5, 1.5, 2.5 .. x f0) gercek tek
// harmonik enerjisi bulunur. Ara-harmonik enerji guclu ise aday muhtemelen
// bir oktav yuksektir -> bastir. (Yalniz perde takibinde kullanilir; vokal
// ozellikleri ham tepe uzerinden olculur.)
function octavePenalty(mag, cand, sal) {
  for (let k = 12; k < NSTATE; k++) {
    const ih = INTER[k], hb = cand[k];
    let inter = 0, harm = 0;
    for (let j = 0; j < ih.length; j++) { const e = ih[j]; inter += (mag[e[0]] > mag[e[1]] ? mag[e[0]] : mag[e[1]]); }
    for (let j = 0; j < Math.min(4, hb.length); j++) { const e = hb[j]; harm += (mag[e[0]] > mag[e[1]] ? mag[e[0]] : mag[e[1]]); }
    if (inter > 0.55 * harm) sal[k] *= 0.35;
  }
}
// ara-harmonik bin listeleri: (h - 0.5) * f0, h = 1..4
const INTER = (() => {
  const out = [];
  for (let k = 0; k < NSTATE; k++) {
    const f0 = midiHz(MLO + k), bins = [];
    for (let h = 1; h <= 4; h++) {
      const b = (h - 0.5) * f0 / BIN_HZ;
      if (b >= BINS - 1) break;
      bins.push([Math.floor(b), Math.ceil(b)]);
    }
    out.push(bins);
  }
  return out;
})();

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

// ---------- ince perde (yarim-ton alti) + tini ozellikleri ----------
// Secilen yarim-ton durumunun etrafinda harmonik tepe noktalarini parabolik
// interpolasyonla bulur; f0 = agirlikli ortalama(f_h / h). Vibrato, jitter ve
// duz (cansiz) synth tonlarini ayirt etmek icin cent hassasiyeti gerekir.
const _hAmp = new Float32Array(16), _hDb = new Float32Array(16);
function fineAnalyze(mag, k, out) {
  const f0 = midiHz(MLO + k);
  let wsum = 0, fsum = 0, nh = 0;
  for (let h = 1; h <= 12; h++) {
    const fb = h * f0 / BIN_HZ;
    if (fb >= BINS - 2 || h * f0 > 5000) break;
    let b = Math.round(fb), best = b, bv = mag[b];
    for (let d = -1; d <= 1; d++) { const bb = b + d; if (bb > 0 && bb < BINS - 1 && mag[bb] > bv) { bv = mag[bb]; best = bb; } }
    _hAmp[nh++] = bv;
    if (h <= 6 && best > 0 && best < BINS - 1 && bv > 0) {
      const a = Math.log(mag[best - 1] + 1e-9), m = Math.log(bv + 1e-9), r = Math.log(mag[best + 1] + 1e-9);
      const den = a - 2 * m + r;
      const dx = Math.abs(den) > 1e-9 ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - r) / den)) : 0;
      const fh = (best + dx) * BIN_HZ / h;
      if (Math.abs(fh / f0 - 1) < 0.06) { fsum += fh * bv; wsum += bv; }
    }
  }
  out.midi = wsum > 0 ? 69 + 12 * Math.log2((fsum / wsum) / 440) : MLO + k;
  // harmoniklik: on plan enerjisinin ne kadari bu perdenin harmoniklerinde?
  // Akor/pad'de enerji diger akor seslerine dagilir; tek sesli vokalde
  // enerji harmoniklerde yogunlasir.
  {
    const fRef = wsum > 0 ? fsum / wsum : f0;
    const b0 = Math.max(1, Math.floor(fRef * 0.7 / BIN_HZ)), b1 = Math.min(BINS - 1, Math.ceil(5000 / BIN_HZ));
    let tot = 0, on = 0;
    for (let b = b0; b <= b1; b++) {
      const e = mag[b] * mag[b];
      tot += e;
      const hf = b * BIN_HZ / fRef, d = Math.abs(hf - Math.round(hf)) * fRef / BIN_HZ;
      if (Math.round(hf) >= 1 && d <= 1.1) on += e;
    }
    out.harm = tot > 1e-12 ? on / tot : 0;
  }
  // formant izi: harmonik genliklerinin (dB) log(h)'ye dogrusal uyumundan
  // sapmasi. Testere/kare synth'te genlikler duzgun azalir (sapma ~0);
  // insan sesinde formant tepeleri duzensiz bir zarf olusturur.
  if (nh >= 5) {
    // dB, en guclu harmonigin 30 dB altinda kirpilir (eksik harmonik = taban)
    let mx = 0; for (let i = 0; i < nh; i++) if (_hAmp[i] > mx) mx = _hAmp[i];
    const top = 20 * Math.log10(mx + 1e-9);
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < nh; i++) {
      const y = Math.max(top - 30, 20 * Math.log10(_hAmp[i] + 1e-9));
      _hDb[i] = y;
      const x = Math.log2(i + 1);
      sx += x; sy += y; sxx += x * x; sxy += x * y;
    }
    const slope = (nh * sxy - sx * sy) / Math.max(1e-9, nh * sxx - sx * sx);
    const icpt = (sy - slope * sx) / nh;
    let res = 0;
    for (let i = 0; i < nh; i++) { const e = _hDb[i] - (icpt + slope * Math.log2(i + 1)); res += e * e; }
    out.formant = Math.sqrt(res / nh);
  } else out.formant = 0;
}

// Vokal nota baslangici kalibrasyonu: voicing esigi atagin ortasinda tetiklenir
// (unsuz + yumusak atak) -> benchmark'ta sistematik ~30 ms gec. Duzelt.
const VOCAL_T_OFFSET = -0.025;

// Insan sesi kapisi (segment duzeyi). tools/analysis-bench.mjs ile ayarlandi:
//  - formant izi < 3.8 dB: harmonik zarfi duzgun azalan synth (testere/kare
//    lead, vibratolu olsa bile) -> insan degil. Gercek vokallerde p10 ~5.8 dB.
//  - uzun segmentte ince perde sapmasi < 4 cent: cizgi-duz ton (pad/org/synth)
//    -> insan degil. Insan sesinde jitter/vibrato/glide her zaman vardir.
//  - harmoniklik: on plan enerjisinin perdenin harmoniklerindeki payi.
function humanGate(s) {
  const f = s.feat;
  if (!f) return true;
  if (f.formant < 3.8) return false;
  if (f.n >= 8 && f.micro < 4) return false;
  // akor/pad: enerji tek perdenin harmoniklerinde toplanmiyor (vokal p10 ~%75,
  // pad p50 ~%63). Dusuk harmoniklik + duz perde birlikte -> pad.
  if (f.harm < 0.5) return false;
  if (f.harm < 0.72 && f.n >= 5 && f.micro < 6) return false;
  return true;
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
  const { F, path, salStr, fluxPeaks, feats, gate, tOffset = 0 } = opt;
  // yeniden vurus tespiti icin enerji: verilmisse genis bant on plan enerjisi
  // (vibrato perde-belirginligini dalgalandirir ama genis bant enerjiyi degil)
  const atk = opt.energy || salStr;
  // voicing: mutlak ağırlıklı salience gücüne göre. Bas/eşlik perde-ağırlığıyla
  // zaten bastırıldığından, melodik kaynak sustuğunda güç düşer -> unvoiced.
  const strFloor = (opt.floor || 0.18) * p95(salStr);

  const voiced = new Uint8Array(F);
  if (opt.voiceScore) {
    // hazir voicing skoru (0..1) verilmisse onu kullan (vokal hatti)
    // + mutlak taban: goreli skor yalniz vokal on plani olan karelerde karar verir
    // (enstrumantal kopru/drop'larda "her bolumun ustu vokal" olmasin)
    const absFloor = (opt.absFloor != null ? opt.absFloor : 0.15) * p95(salStr);
    const pres = opt.presence, pThr = opt.presenceThr || 0;
    for (let i = 0; i < F; i++) voiced[i] = opt.voiceScore[i] > opt.voiceThr && salStr[i] > absFloor && (!pres || pres[i] > pThr) ? 1 : 0;
  } else {
    for (let i = 0; i < F; i++) voiced[i] = salStr[i] > strFloor ? 1 : 0;
  }
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

      // insan sesi ozellikleri (yalniz vokal hatti): ince perde mikro-hareketi
      // (cent) ve formant izi. Karar, tum segmentler toplandiktan sonra verilir.
      let feat = null;
      if (feats) {
        const from = segStart + 2, to = end - 2;
        const xs = [], fs = [], hs = [];
        for (let g = from; g < to; g++) {
          const fm = feats.fineMidi[g];
          // ozellikler ham tepeden; yol oktav-duzeltilmis olabilir (+12)
          if (Math.abs(fm - midi) < 1.5) xs.push(fm);
          else if (Math.abs(fm - 12 - midi) < 1.5) xs.push(fm - 12);
          fs.push(feats.formant[g]); hs.push(feats.harm[g]);
        }
        let micro = 0;
        if (xs.length >= 3) {
          // ardisik-kare farklarinin RMS'i (yavas glide'dan bagimsiz mikro hareket)
          // + toplam sapma; ikisinin buyugu
          let m = 0; for (const x of xs) m += x; m /= xs.length;
          let v = 0; for (const x of xs) v += (x - m) * (x - m);
          micro = Math.sqrt(v / xs.length) * 100;
        }
        fs.sort((a, b) => a - b);
        fs.sort((a, b) => a - b); hs.sort((a, b) => a - b);
        const med = (a) => a.length ? a[a.length >> 1] : 0;
        feat = { micro, formant: med(fs), harm: med(hs), n: xs.length };
      }
      segments.push({ frame: segStart, t: segStart * HOP_T + ONSET_OFFSET + tOffset, dur: len * HOP_T, pitch: midi, rawS: en / Math.max(1, cnt), feat });
      segStart = end;
    };

    let jump = 0;
    for (let g = i; g < runEnd; g++) {
      const segLen = g - segStart;
      // perde sıçraması: segment başına göre >=2 yarım ton (tam ton) ve 3 kare
      // sürekli -> vibrato/glide (±yarım ton) sustain'i bölmesin
      // tam oktav sicramasi (11-13) ayni sesli bolgede perde takibinin oktav
      // kaymasidir, yeni nota degil -> bolme
      const dj = Math.abs(path[g] - path[segStart]);
      if (segLen >= 4 && dj >= 2 && !(dj >= 11 && dj <= 13)) {
        jump++;
        if (jump >= 3) { closeSeg(g - 2); jump = 0; }
      } else jump = 0;
      // güç yeniden-vurusu (gerçek onset)
      if (segLen >= 5 && fluxPeaks.has(g)) {
        let before = 0, after = 0, nb = 0, na = 0;
        for (let k = Math.max(0, g - 4); k < g; k++) { before += atk[k]; nb++; }
        for (let k = g + 1; k < Math.min(F, g + 5); k++) { after += atk[k]; na++; }
        before /= Math.max(1, nb); after /= Math.max(1, na);
        // gercek yeniden-soyleme (ayni perdede yeni hece) oncesinde enerji
        // CUKURU olur (unsuz/nefes). Eslikten sizan transient (hi-hat, arp)
        // cukursuz bir sivri tepedir -> bolme.
        let dip = Infinity, pre = 0, np = 0;
        for (let k = Math.max(0, g - 3); k <= g; k++) if (atk[k] < dip) dip = atk[k];
        for (let k = Math.max(0, g - 9); k < g - 3; k++) { pre += atk[k]; np++; }
        pre = np ? pre / np : before;
        if (after > before * 1.25 && dip < 0.7 * Math.min(pre, after)) closeSeg(g);
      }
    }
    closeSeg(runEnd);
    i = runEnd;
  }

  const kept = segments.filter(s => s.dur >= 0.09 && (!gate || gate(s)));
  const ranks = percentileRanks(kept.map(s => s.rawS));
  return kept.map((s, k) => {
    const o = { t: Math.max(0, s.t), s: ranks[k], pitch: s.pitch, dur: s.dur >= 0.32 ? Math.min(s.dur, 8) : 0 };
    if (DEBUG) { if (s.feat) o.feat = s.feat; o.len = +s.dur.toFixed(3); o.frame = s.frame; o.rawS = s.rawS; }
    return o;
  });
}

// ---------- tempo + DP vuruş izleme (Ellis 2007) ----------
// 3:2 tempo yanilgisi: otokorelasyon + 120 BPM onseli, senkoplu ritimlerde
// (noktali/uc'leme kick kaliplari) gercek tempo yerine 2/3'unu secebiliyor
// (186 -> 123, 174 -> 117). Aday tempo izgarasinin GERCEK vuruslara oturmasi
// yerel pencerelerde (tempo kaymasindan etkilenmesin) faz aramasiyla olculur:
// vurus + 8'lik konumlarindaki ortalama vurus enerjisi / genel ortalama.
function gridFit(env, F, lag) {
  const W = Math.round(8 / HOP_T);
  let sum = 0, n = 0, mean = 0;
  for (let i = 0; i < F; i++) mean += env[i];
  mean = mean / Math.max(1, F) + 1e-9;
  const L = Math.max(1, Math.round(lag));
  for (let w0 = 0; w0 + W <= F; w0 += W) {
    let best = 0;
    for (let ph = 0; ph < L; ph++) {
      let b = 0, h = 0, nb = 0;
      for (let x = w0 + ph; x < w0 + W; x += lag) {
        const i = Math.round(x), j = Math.round(x + lag / 2);
        b += Math.max(env[i - 1] || 0, env[i], env[i + 1] || 0);
        if (j < F) h += Math.max(env[j - 1] || 0, env[j], env[j + 1] || 0);
        nb++;
      }
      const v = (b + 0.5 * h) / Math.max(1, nb);
      if (v > best) best = v;
    }
    sum += best; n++;
  }
  return n ? sum / n / mean : 0;
}

function trackBeats(envIn, F, tune = {}) {
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
  // 3:2 / 2:3 akrabalarindan izgaraya belirgin daha iyi oturani sec
  if (tune.tempo32 !== false) {
    // kesirli periyot sart: 8 sn'lik pencerede tam sayi yuvarlama (~0.3 kare/vurus)
    // vurus basina birikir ve hizli tempolari haksizca cezalandirir
    const fitNear = (c0) => {
      let best = 0, bl = c0;
      for (let k = -12; k <= 12; k++) { const c = c0 * (1 + k * 0.0025); const v = gridFit(env, F, c); if (v > best) { best = v; bl = c; } }
      return [best, bl];
    };
    const [base] = fitNear(bestLag);
    let pick = bestLag, pickFit = base * (tune.tempo32Margin || 1.08);
    for (const r of [2 / 3, 3 / 2]) {
      const c = bestLag * r;
      if (c < minLag || c > maxLag) continue;
      const [fit, cl] = fitNear(c);
      // cok hizli tempoya (>180 BPM) cikmak icin daha guclu kanit: uc'leme
      // hissi olan orta tempolu sarkilar aksi halde 3/2 katina kayiyordu
      const need = 60 / (cl * HOP_T) > (tune.tempoFastBpm || 180) ? (tune.tempoFastMargin || 1.2) / (tune.tempo32Margin || 1.08) : 1;
      if (fit > pickFit * need) { pick = Math.round(cl); pickFit = fit; }
    }
    bestLag = pick;
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

// ---------- bas perdesi: dusuk ornekleme oranli harmonik toplam (SHS) ----------
// 1024 noktali ana STFT'de bin araligi 21.5 Hz; 40-80 Hz'de yarim ton yalniz
// 2-5 Hz oldugundan bas perdesi tepe-bin'den kaba ve cogu kez 2. harmonikten
// geliyordu. Burada mono sinyal 1.1 kHz'de alcak geciren suzgecle 8'e
// indirgenir (2756 Hz), ~140 ms pencere sifir dolgulu 1024 FFT ile cozulur ve
// her aday f0 (E1..C4, 1/3 yarim ton) icin ilk 6 harmonigin genlik toplami
// alinir (Hermes 1988). Gercek bas kanaliyla (Demucs) olculerek ayarlandi.
function bassPitchTrack(left, right, F, tune) {
  const D = 8, SRd = SR / D, N = 1024;
  const W = tune.bassWin || 512;
  const n = left.length;
  // 4. derece Butterworth (2 biquad), fc = 1100 Hz
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = 0.5 * (left[i] + right[i]);
  const biquad = (q) => {
    const w0 = 2 * Math.PI * 1100 / SR, al = Math.sin(w0) / (2 * q), cw = Math.cos(w0);
    const a0 = 1 + al;
    const b0 = (1 - cw) / 2 / a0, b1 = (1 - cw) / a0, b2 = b0, a1 = -2 * cw / a0, a2 = (1 - al) / a0;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < n; i++) {
      const v = x[i], y = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = v; y2 = y1; y1 = y; x[i] = y;
    }
  };
  biquad(0.5412); biquad(1.3066);
  const nd = Math.floor(n / D), xd = new Float32Array(nd);
  for (let i = 0; i < nd; i++) xd[i] = x[i * D];

  const fft = makeFFT(N);
  const win = new Float32Array(W);
  for (let i = 0; i < W; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (W - 1));
  const re = new Float32Array(N), im = new Float32Array(N), mag = new Float32Array(N / 2);
  const binHz = SRd / N;
  // adaylar: MIDI 28 (E1) .. 60 (C4), 1/3 yarim ton
  const C = [];
  for (let m = 28; m <= 60; m += 1 / 3) C.push(m);
  const f0s = C.map(m => 440 * Math.pow(2, (m - 69) / 12));
  const HW = [1, 0.85, 0.7, 0.6, 0.5, 0.42];
  const at = (f) => { // dogrusal aradegerli genlik
    const b = f / binHz, i = Math.floor(b), fr = b - i;
    return i + 1 < mag.length ? mag[i] * (1 - fr) + mag[i + 1] * fr : 0;
  };
  const out = new Float32Array(F), conf = new Float32Array(F);
  const sc = new Float32Array(C.length);
  for (let c = 0; c < F; c++) {
    const center = (c * HOP + FFT_N / 2) / D;
    const st = Math.round(center - W / 2);
    re.fill(0); im.fill(0);
    let e = 0;
    for (let i = 0; i < W; i++) { const j = st + i; const v = j >= 0 && j < nd ? xd[j] * win[i] : 0; re[i] = v; e += v * v; }
    if (e < 1e-9) continue;
    fft(re, im);
    for (let b = 0; b < N / 2; b++) mag[b] = Math.sqrt(Math.sqrt(re[b] * re[b] + im[b] * im[b])); // sikistirilmis genlik
    let best = 0, bk = 0, tot = 0;
    for (let k = 0; k < C.length; k++) {
      let v = 0;
      for (let h = 0; h < HW.length; h++) { const f = f0s[k] * (h + 1); if (f > 1250) break; v += HW[h] * at(f); }
      sc[k] = v; tot += v;
      if (v > best) { best = v; bk = k; }
    }
    // alt-oktav kontrolu: f0/2 adayi neredeyse ayni gucteyse (tek harmonikleri
    // olan bas) gercek temel odur
    const ko = bk - 36;
    if (ko >= 0 && sc[ko] > best * (tune.bassSubOct || 0.92)) bk = ko;
    let m = C[bk];
    if (bk > 0 && bk < C.length - 1) {
      const a = sc[bk - 1], b = sc[bk], r = sc[bk + 1], den = a - 2 * b + r;
      if (Math.abs(den) > 1e-12) m += Math.max(-0.5, Math.min(0.5, 0.5 * (a - r) / den)) / 3;
    }
    out[c] = m;
    conf[c] = best / (tot / C.length + 1e-9);
  }
  return { midi: out, conf };
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
    DEBUG = !!msg.debug;
    // tercihen ham sol/sag kanal (gercek stereo merkez cikarimi); yoksa merkez/yan
    let L = msg.left, R = msg.right;
    if (!L || !R) {
      L = new Float32Array(msg.center.length); R = new Float32Array(msg.center.length);
      for (let i = 0; i < L.length; i++) { L[i] = msg.center[i] + msg.side[i]; R[i] = msg.center[i] - msg.side[i]; }
    }
    const result = analyze(L, R, msg.sampleRate, msg.tune || {});
    self.postMessage({ type: 'result', ...result });
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.stack || err) });
  }
};
function progress(stage, pct) { self.postMessage({ type: 'progress', stage, pct }); }

function analyze(left, right, sampleRate, tune) {
  if (Math.abs(sampleRate - SR) > 1) throw new Error('Beklenmeyen örnekleme hızı: ' + sampleRate);
  const len = left.length;
  const F = Math.max(1, Math.floor((len - FFT_N) / HOP) + 1);
  const duration = len / SR;

  const fft = makeFFT(FFT_N);
  const win = new Float32Array(FFT_N);
  for (let i = 0; i < FFT_N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (FFT_N - 1));
  const re = new Float32Array(FFT_N), im = new Float32Array(FFT_N);
  const re2 = new Float32Array(FFT_N), im2 = new Float32Array(FFT_N);

  const ringC = [], ringS = [], ringSim = [];
  for (let i = 0; i < MED_K; i++) { ringC.push(new Float32Array(BINS)); ringS.push(new Float32Array(BINS)); ringSim.push(new Float32Array(BINS)); }
  const scratch = new Float32Array(MED_K);
  const timeWin = new Float32Array(MED_K);
  const harmRow = new Float32Array(BINS), percRow = new Float32Array(BINS);
  const shRow = new Float32Array(BINS), spRow = new Float32Array(BINS);
  const shW = new Float32Array(BINS), vmW = new Float32Array(BINS); // beyazlatılmış
  const lsp = new Float32Array(BINS), prevLspMax = new Float32Array(BINS), tmpMax = new Float32Array(BINS);

  // perkusyon + tempo
  const fxKick = new Float32Array(F), fxSnare = new Float32Array(F), fxHat = new Float32Array(F);
  const fxBass = new Float32Array(F), enBass = new Float32Array(F), envBeat = new Float32Array(F);
  const enKick = new Float32Array(F);   // kick bandi toplam enerji (sonum testi)
  const bassMidi = new Float32Array(F); // kare basina bas perdesi (MIDI)
  // yapi analizi: kare basina kroma (12) + 6 bant tini + yukseklik
  const chroma = new Float32Array(F * 12), timbre = new Float32Array(F * 6), loud = new Float32Array(F);
  const snFlat = new Float32Array(F);   // perkusif 1-8 kHz spektral duzlugu (gurultuluk)
  // enstruman (vokal disi) harmonik akis: yanlara yayilmis/ters fazli harmonik
  // icerik (gitar, synth, piyano genelde stereo genistir; vokal merkezdedir)
  const fxInst = new Float32Array(F), enInst = new Float32Array(F), instMidi = new Float32Array(F);
  const instRow = new Float32Array(BINS), lInst = new Float32Array(BINS), prevInstMax = new Float32Array(BINS);
  const INST_LO = hzBin(180), INST_HI = hzBin(5000);

  // melodi (akan, REPET'siz): salience matrisi + güç + ham perde
  const cand = buildCandidates();
  const melSal = new Float32Array(F * NSTATE);
  const melStr = new Float32Array(F), melRawMidi = new Float32Array(F); // mutlak ağırlıklı güç
  const tmpSal = new Float32Array(NSTATE);

  // vokal (segment bazlı REPET): salience matrisi + güç + ham perde
  const vocSal = new Float32Array(F * NSTATE);
  const vocStr = new Float32Array(F), vocRawMidi = new Float32Array(F);
  // vokal perde-register agirligi: merkez/genislik/alt sinir ayarlanabilir
  const vocLo = tune.vocLo || 50;
  const vocPw = pitchWeights(tune.vocCenter || 67, tune.vocSigma || 11, vocLo);
  const vocLoState = Math.max(0, vocLo - MLO);
  const vocFine = new Float32Array(F), vocFormant = new Float32Array(F); // ince perde + formant izi
  const vocHarm = new Float32Array(F); // harmoniklik (0..1)
  const vocEn = new Float32Array(F);   // genis bant vokal on plan enerjisi (yeniden vurus tespiti)
  const VEN_LO = hzBin(150), VEN_HI = hzBin(4000);
  const _fine = { midi: 0, formant: 0, harm: 0 };

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
      // ham tepe: guc (voicing) + vokal ozellikleri bunun uzerinden
      let bestK = vocLoState, bestV = 0;
      for (let k = 0; k < NSTATE; k++) {
        const sv = tmpSal[k] * vocPw[k]; // algısal register ağırlığı (+ bas kesimi)
        if (sv > bestV) { bestV = sv; bestK = k; }
      }
      // perde takibi icin oktav-duzeltilmis belirginlik
      if (tune.octCheck !== false) octavePenalty(vm, cand, tmpSal);
      for (let k = 0; k < NSTATE; k++) vocSal[gf * NSTATE + k] = tmpSal[k] * vocPw[k];
      vocStr[gf] = bestV; // mutlak ağırlıklı güç (voicing için)
      vocRawMidi[gf] = MLO + bestK;
      fineAnalyze(vm, bestK, _fine);
      vocFine[gf] = _fine.midi;
      vocFormant[gf] = _fine.formant;
      vocHarm[gf] = _fine.harm;
      let ve = 0;
      for (let b = VEN_LO; b < VEN_HI; b++) ve += vm[b];
      vocEn[gf] = ve;
    }
    segBase += segCount;
    segCount = 0;
  }

  let lastPct = -1;
  for (let f = 0; f < F + MED_H; f++) {
    if (f < F) {
      const off = f * HOP;
      for (let i = 0; i < FFT_N; i++) {
        const w = win[i], j = off + i;
        re[i] = j < len ? left[j] * w : 0; im[i] = 0;
        re2[i] = j < len ? right[j] * w : 0; im2[i] = 0;
      }
      fft(re, im); fft(re2, im2);
      const magC = ringC[f % MED_K], magS = ringS[f % MED_K], sim = ringSim[f % MED_K];
      for (let b = 0; b < BINS; b++) {
        const lr = re[b], li = im[b], rr = re2[b], ri = im2[b];
        magC[b] = 0.5 * Math.hypot(lr + rr, li + ri);
        magS[b] = 0.5 * Math.hypot(lr - rr, li - ri);
        // kanal-arasi benzerlik (Avendano & Jot): 2*Re(L R*) / (|L|^2+|R|^2)
        // merkez-panli & ayni fazli kaynak -> 1; yan-panli/genis/ters faz -> 0
        const pl = lr * lr + li * li, pr = rr * rr + ri * ri;
        const cr = lr * rr + li * ri;
        sim[b] = pl + pr > 1e-12 ? Math.max(0, 2 * cr / (pl + pr)) : 0;
      }
    } else {
      ringC[f % MED_K].fill(0); ringS[f % MED_K].fill(0); ringSim[f % MED_K].fill(0);
    }

    const c = f - MED_H;
    if (c < 0 || c >= F) continue;
    const magC = ringC[c % MED_K], magS = ringS[c % MED_K], simC = ringSim[c % MED_K];

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

    // enstruman akisi: harmonik merkezin yan-panli payi + harmonik yan kanal
    {
      let e = 0;
      for (let b = 0; b < BINS; b++) {
        const h2 = harmRow[b] * harmRow[b], p2 = percRow[b] * percRow[b];
        const hm = h2 / (h2 + p2 + 1e-9), sm = simC[b];
        instRow[b] = shRow[b] * (1 - sm * sm * sm) + magS[b] * hm;
        lInst[b] = log1p20(instRow[b]);
        if (b >= INST_LO && b < INST_HI) e += instRow[b];
      }
      fxInst[c] = bandSuperFlux(lInst, prevInstMax, INST_LO, INST_HI);
      maxFilt(lInst, tmpMax); prevInstMax.set(tmpMax);
      enInst[c] = e;
      salienceRow(instRow, cand, tmpSal);
      let bk = 0, bv = 0;
      for (let k = 0; k < NSTATE; k++) { const sv = tmpSal[k] * MEL_PW[k]; if (sv > bv) { bv = sv; bk = k; } }
      instMidi[c] = bv > 0 ? MLO + bk : 0;
    }

    // perkusyon SuperFlux
    for (let b = 0; b < BINS; b++) lsp[b] = log1p20(spRow[b]);
    fxKick[c] = bandSuperFlux(lsp, prevLspMax, BAND.kick[0], BAND.kick[1]);
    fxSnare[c] = bandSuperFlux(lsp, prevLspMax, BAND.snare[0], BAND.snare[1]);
    fxHat[c] = bandSuperFlux(lsp, prevLspMax, BAND.hat[0], BAND.hat[1]);
    fxBass[c] = bandSuperFlux(lsp, prevLspMax, BAND.bass[0], BAND.bass[1]);
    maxFilt(lsp, tmpMax); prevLspMax.set(tmpMax);

    let eB = 0, bB = BAND.bass[0], bV = 0;
    for (let b = BAND.bass[0]; b < BAND.bass[1]; b++) { eB += shRow[b]; if (shRow[b] > bV) { bV = shRow[b]; bB = b; } }
    enBass[c] = eB;
    // bas perdesi: harmonik bas bandindaki tepe (parabolik interpolasyon)
    {
      const a = shRow[bB - 1] || 0, m = bV, r = shRow[bB + 1] || 0, den = a - 2 * m + r;
      const dx = Math.abs(den) > 1e-12 ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - r) / den)) : 0;
      bassMidi[c] = 69 + 12 * Math.log2(Math.max(20, (bB + dx) * BIN_HZ) / 440);
    }
    let eK = 0;
    for (let b = BAND.kick[0]; b < BAND.kick[1]; b++) eK += magC[b] * magC[b];
    enKick[c] = eK;
    {
      const cb = c * 12, tb = c * 6;
      let tot = 0;
      for (let b = PC_LO; b < PC_HI; b++) chroma[cb + BIN_PC[b]] += shRow[b];
      for (let k = 0; k < 6; k++) {
        let e = 0;
        for (let b = TIMBRE_EDGES[k]; b < TIMBRE_EDGES[k + 1]; b++) e += magC[b] * magC[b];
        timbre[tb + k] = Math.log(1e-6 + e);
        tot += e;
      }
      loud[c] = Math.log(1e-6 + tot);
    }
    // spektral duzluk (geometrik/aritmetik ortalama): trampet/hat gurultudur (~1),
    // tonal pluck/arp transientleri tepeli spektrumdur (~0)
    {
      let lg = 0, ar = 0, nn = 0;
      for (let b = FLAT_LO; b < FLAT_HI; b++) { const v = spRow[b] + 1e-9; lg += Math.log(v); ar += v; nn++; }
      snFlat[c] = Math.exp(lg / nn) / (ar / nn);
    }
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
      // merkezlik: kanal-arasi benzerlik (keskinlestirilmis); mono'da 1
      const sm = simC[b], centerness = sm * sm * sm;
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
  // kick: alcak bant transienti HIZLA sonmeli. Bas notasi surer -> elenir.
  //   oran = (E[+12] - E[-2]) / (E[+1] - E[-2]) ; benchmark: kick p50 ~0.14, bas ~0.47
  const kicks = refine(pickPeaks(fxKick, { minSep: 8, mul: 1.45 }), (p) => {
    const f = p.frame, e0 = enKick[Math.max(0, f - 2)];
    let e1 = 0; for (let g = f; g <= Math.min(F - 1, f + 2); g++) e1 = Math.max(e1, enKick[g]);
    const e12 = enKick[Math.min(F - 1, f + 12)];
    const rise = e1 - e0;
    if (rise <= 1e-9) return true; // olculemez: tut
    return (e12 - e0) / rise < (tune.kickDecay || 0.35);
  });
  // trampet: gurultulu (duz spektrumlu) transient; sentetik ~0.85, tonal ~0.5.
  // Gercek miksteki katmanli trampet/clap daha az gurultulu: 0.72 gercek sarkilarda
  // ~2-4 trampet/sn birakir (0.8 neredeyse hepsini siliyordu).
  const snares = refine(pickPeaks(fxSnare, { minSep: 8, mul: 1.4 }), (p) => {
    let fl = 0; for (let g = p.frame; g <= Math.min(F - 1, p.frame + 2); g++) fl = Math.max(fl, snFlat[g]);
    return fl > (tune.snareFlat || 0.72);
  });
  const hats = pickPeaks(fxHat, { minSep: 5, mul: 1.45 });
  const bassRaw = pickPeaks(fxBass, { minSep: 14, mul: 1.4, meanW: 16 });
  const bassTrack = tune.bassShs === false ? null : bassPitchTrack(left, right, F, tune);
  const bass = bassRaw.map((p, idx) => {
    let e0 = 0, c0 = 0;
    for (let g = p.frame + 1; g < Math.min(F, p.frame + 5); g++) { e0 += enBass[g]; c0++; }
    e0 /= Math.max(1, c0);
    let g = p.frame + 4;
    const nextOnset = idx + 1 < bassRaw.length ? bassRaw[idx + 1].frame : F;
    while (g < F && g < nextOnset - 2 && enBass[g] > 0.35 * e0) g++;
    const dur = (g - p.frame) * HOP_T;
    // perde: atak sonrasi karelerin medyani (atak gecis gurultusunden kac);
    // SHS penceresi ~140 ms oldugundan bir onceki notadan tasmamak icin biraz
    // daha geriden ve notanin icinde kalarak
    const ps = [];
    if (bassTrack) {
      const k0 = p.frame + (tune.bassK0 != null ? tune.bassK0 : 5);
      const k1 = Math.min(F, nextOnset - 2, p.frame + (tune.bassK1 != null ? tune.bassK1 : 12));
      for (let k = k0; k < Math.max(k0 + 1, k1); k++) if (k < F) ps.push(bassTrack.midi[k]);
    } else for (let k = p.frame + 2; k < Math.min(F, p.frame + 7); k++) ps.push(bassMidi[k]);
    ps.sort((x, y) => x - y);
    const pitch = ps.length ? Math.round(ps[ps.length >> 1]) : 0;
    return { t: p.t, s: p.s, dur: dur >= 0.45 ? dur : 0, pitch };
  });

  // enstruman (lead) olaylari: yan/genis harmonik akistaki ataklar
  const instRaw = pickPeaks(fxInst, { minSep: tune.instSep || 9, mul: tune.instMul || 1.5, meanW: 14 });
  const inst = instRaw.map((p, idx) => {
    const nextOnset = idx + 1 < instRaw.length ? instRaw[idx + 1].frame : F;
    let e0 = 0, c0 = 0;
    for (let g = p.frame + 1; g < Math.min(F, p.frame + 5); g++) { e0 += enInst[g]; c0++; }
    e0 /= Math.max(1, c0);
    let g = p.frame + 4;
    while (g < F && g < nextOnset - 2 && enInst[g] > 0.5 * e0) g++;
    const dur = (g - p.frame) * HOP_T;
    const ps = [];
    for (let k = p.frame + 2; k < Math.min(F, p.frame + 8, nextOnset); k++) if (instMidi[k] > 0) ps.push(instMidi[k]);
    ps.sort((x, y) => x - y);
    return { t: p.t, s: p.s, dur: dur >= 0.45 ? Math.min(dur, 6) : 0, pitch: ps.length ? ps[ps.length >> 1] : 0 };
  });

  progress('melody', 82);
  // melodi salience'ı kare-max ile normalize et (Viterbi emisyonu)
  normalizeSal(melSal, F);
  const melPath = trackPitchDP(melSal, F, 0.08);
  const melFlux = new Float32Array(F);
  for (let i = 1; i < F; i++) { const d = melStr[i] - melStr[i - 1]; melFlux[i] = d > 0 ? d : 0; }
  const melFluxPeaks = new Set(pickPeaks(melFlux, { minSep: 6, mul: 1.4, meanW: 14 }).filter(p => p.s >= 0.3).map(p => p.frame));
  const melody = segmentFromContour({ F, path: melPath, salStr: melStr, fluxPeaks: melFluxPeaks });

  progress('vocal', 90);
  normalizeSal(vocSal, F);
  // Vokal PERDESI icin birlesik belirginlik: REPET'li vokal on plani (kim
  // soyluyor) + tam harmonik merkez spektrum (REPET tekrar eden nakaratlari ve
  // stereo yankiyi da kirptigi icin perdeyi kaybeder). Gercek vokal
  // benchmark'inda (Demucs referansi) tam spektrum perdede belirgin ustun.
  const vocPitchMode = tune.vocPitch || 'mel';
  if (vocPitchMode === 'comb') {
    const w = tune.vocW != null ? tune.vocW : 0.6;
    for (let f = 0; f < F; f++) {
      const base = f * NSTATE;
      for (let k = 0; k < NSTATE; k++) vocSal[base + k] = melSal[base + k] * vocPw[k] + w * vocSal[base + k];
    }
    normalizeSal(vocSal, F);
  }
  const vocPath = vocPitchMode === 'mel' ? melPath : trackPitchDP(vocSal, F, 0.08);
  const vocFlux = new Float32Array(F);
  for (let i = 1; i < F; i++) { const d = vocEn[i] - vocEn[i - 1]; vocFlux[i] = d > 0 ? d : 0; }
  const vocFluxPeaks = new Set(pickPeaks(vocFlux, { minSep: 8, mul: 1.4, meanW: 14 }).filter(p => p.s >= 0.3).map(p => p.frame));
  const vocal = segmentFromContour({
    F, path: vocPath, salStr: vocStr, fluxPeaks: vocFluxPeaks,
    feats: { fineMidi: vocFine, formant: vocFormant, harm: vocHarm },
    energy: vocEn,
    gate: tune.noGate ? null : humanGate,
    floor: tune.vocFloor,
    voiceScore: tune.vocVoicing === false ? null : voicingScore(melStr, vocStr, vocHarm, F),
    voiceThr: tune.vocVoice != null ? tune.vocVoice : 0.4, // gercek vokal benchmark'iyla secildi
    absFloor: tune.vocAbs,
    presence: vocalPresence(vocHarm, F, tune.vocPresW || 2),
    presenceThr: tune.vocPres != null ? tune.vocPres : 0,
    tOffset: VOCAL_T_OFFSET
  });

  progress('tempo', 96);
  const beatInfo = trackBeats(envBeat, F, tune);

  progress('structure', 98);
  const structure = analyzeStructure({ F, chroma, timbre, loud, beats: beatInfo.beats, duration });

  progress('done', 100);
  return {
    events: {
      kick: kicks.map(p => ({ t: p.t, s: p.s })),
      snare: snares.map(p => ({ t: p.t, s: p.s })),
      hat: hats.map(p => ({ t: p.t, s: p.s })),
      bass, vocal, melody, inst
    },
    beats: beatInfo.beats,
    bpm: beatInfo.bpm,
    beatPeriod: beatInfo.beatPeriod,
    beatOffset: beatInfo.beatOffset,
    duration,
    sections: structure.sections,
    energy: structure.energy, // 10 Hz, 0..1 yogunluk egrisi
    ...(DEBUG ? { debug: { snFlat, enKick, envBeat, hop: HOP_T, vocPath: Array.from(vocPath, k => k + MLO), vocRaw: Array.from(vocRawMidi), vocFine: Array.from(vocFine), melPath: Array.from(melPath, k => k + MLO), vocStr: Array.from(vocStr), melStr: Array.from(melStr), vocEn: Array.from(vocEn), vocHarm: Array.from(vocHarm), vocFormant: Array.from(vocFormant) } } : {})
  };
}

// ---------- sarki yapisi: bolumler + yogunluk ----------
// Vurus-senkron ozellik vektorleri (kroma + tini) -> oz-benzerlik matrisi ->
// dama tahtasi cekirdegiyle yenilik (Foote 2000) -> bolum sinirlari.
// Bolumler ortalama vektor benzerligine gore harflenir (A, B, A, C...) ve
// yukseklik yuzdeligine gore yogunluk alir (dusuk/orta/yuksek).
function analyzeStructure({ F, chroma, timbre, loud, beats, duration }) {
  // 10 Hz yogunluk egrisi (yuksekligin yuzdelik-normalize hali)
  const step = Math.max(1, Math.round(0.1 / HOP_T));
  const eN = Math.ceil(F / step);
  const energy = new Array(eN);
  {
    const raw = new Float32Array(eN);
    for (let i = 0; i < eN; i++) {
      let s = 0, c = 0;
      for (let f = i * step; f < Math.min(F, (i + 1) * step); f++) { s += loud[f]; c++; }
      raw[i] = c ? s / c : 0;
    }
    const sorted = Float32Array.from(raw).sort();
    const lo = sorted[Math.floor(eN * 0.05)], hi = sorted[Math.floor(eN * 0.98)] || lo + 1;
    for (let i = 0; i < eN; i++) energy[i] = +Math.max(0, Math.min(1, (raw[i] - lo) / Math.max(1e-6, hi - lo))).toFixed(3);
  }

  // vurus izgarasi yoksa 0.5 sn'lik sabit izgara
  let grid = beats && beats.length > 16 ? beats.slice() : [];
  if (!grid.length) for (let t = 0; t < duration; t += 0.5) grid.push(t);
  const B = grid.length - 1;
  if (B < 24) return { sections: [{ t: 0, end: duration, label: 'A', intensity: 0.5, kind: 'mid' }], energy };

  const D = 18;
  const vec = new Float32Array(B * D), bl = new Float32Array(B);
  for (let i = 0; i < B; i++) {
    const f0 = Math.max(0, Math.min(F - 1, Math.round((grid[i] - 0.033) / HOP_T)));
    const f1 = Math.max(f0 + 1, Math.min(F, Math.round((grid[i + 1] - 0.033) / HOP_T)));
    const v = i * D;
    let ls = 0;
    for (let f = f0; f < f1; f++) {
      for (let k = 0; k < 12; k++) vec[v + k] += chroma[f * 12 + k];
      for (let k = 0; k < 6; k++) vec[v + 12 + k] += timbre[f * 6 + k];
      ls += loud[f];
    }
    const n = f1 - f0;
    bl[i] = ls / n;
    // kroma: L2 normalize; tini: ortalama, sonra z-skoru asagida
    let cn = 0; for (let k = 0; k < 12; k++) cn += vec[v + k] * vec[v + k];
    cn = Math.sqrt(cn) || 1;
    for (let k = 0; k < 12; k++) vec[v + k] /= cn;
    for (let k = 12; k < D; k++) vec[v + k] /= n;
  }
  for (let k = 12; k < D; k++) {
    let m = 0, sd = 0;
    for (let i = 0; i < B; i++) m += vec[i * D + k];
    m /= B;
    for (let i = 0; i < B; i++) sd += (vec[i * D + k] - m) ** 2;
    sd = Math.sqrt(sd / B) || 1;
    for (let i = 0; i < B; i++) vec[i * D + k] = 0.35 * (vec[i * D + k] - m) / sd; // tini agirligi
  }
  const sim = (a, b) => {
    let d = 0, na = 0, nb = 0;
    for (let k = 0; k < D; k++) { const x = vec[a * D + k], y = vec[b * D + k]; d += x * y; na += x * x; nb += y * y; }
    return d / (Math.sqrt(na * nb) || 1);
  };
  // yenilik egrisi: 2W vuruslik dama tahtasi cekirdegi (gauss agirlikli)
  const W = 16;
  const nov = new Float32Array(B);
  for (let i = W; i < B - W; i++) {
    let s = 0;
    for (let a = -W; a < W; a++) {
      for (let b = -W; b < W; b++) {
        const g = Math.exp(-((a + 0.5) ** 2 + (b + 0.5) ** 2) / (2 * (W * 0.5) ** 2));
        const sign = (a < 0) === (b < 0) ? 1 : -1;
        s += sign * g * sim(i + a, i + b);
      }
    }
    nov[i] = Math.max(0, s);
  }
  // tepe secimi: en az 16 vurus aralik, ortalamanin uzerinde
  let nm = 0; for (let i = 0; i < B; i++) nm += nov[i]; nm /= B;
  const bounds = [0];
  for (let i = W; i < B - W; i++) {
    if (nov[i] < nm * 1.2) continue;
    let isMax = true;
    for (let k = -8; k <= 8; k++) if (k && nov[i + k] > nov[i]) { isMax = false; break; }
    if (!isMax) continue;
    if (i - bounds[bounds.length - 1] < 16) continue;
    bounds.push(i);
  }
  if (B - bounds[bounds.length - 1] < 8 && bounds.length > 1) bounds.pop();
  bounds.push(B);

  // bolum ozeti + harfleme
  const segs = [];
  for (let s = 0; s < bounds.length - 1; s++) {
    const a = bounds[s], b = bounds[s + 1];
    const mv = new Float32Array(D);
    let lsum = 0;
    for (let i = a; i < b; i++) { for (let k = 0; k < D; k++) mv[k] += vec[i * D + k]; lsum += bl[i]; }
    segs.push({ a, b, mv, loud: lsum / (b - a) });
  }
  const cos = (x, y) => { let d = 0, nx = 0, ny = 0; for (let k = 0; k < D; k++) { d += x[k] * y[k]; nx += x[k] * x[k]; ny += y[k] * y[k]; } return d / (Math.sqrt(nx * ny) || 1); };
  const labels = [];
  let next = 0;
  for (let i = 0; i < segs.length; i++) {
    let lab = null, best = 0.9;
    for (let j = 0; j < i; j++) { const c = cos(segs[i].mv, segs[j].mv); if (c > best) { best = c; lab = labels[j]; } }
    labels.push(lab || String.fromCharCode(65 + Math.min(25, next++)));
  }
  const louds = segs.map(s => s.loud);
  const lr = percentileRanks(louds);
  const sections = segs.map((s, i) => {
    const intensity = segs.length > 1 ? lr[i] : 0.5;
    let kind = intensity >= 0.67 ? 'high' : intensity <= 0.33 ? 'low' : 'mid';
    if (i === 0 && intensity < 0.5) kind = 'intro';
    if (i === segs.length - 1 && segs.length > 2 && intensity < 0.5) kind = 'outro';
    return { t: +grid[s.a].toFixed(3), end: +(s.b < grid.length ? grid[s.b] : duration).toFixed(3), label: labels[i], intensity: +intensity.toFixed(2), kind };
  });
  sections[0].t = 0;
  sections[sections.length - 1].end = duration;
  return { sections, energy };
}

// tepe listesini ozellik testiyle suz; guc yuzdeliklerini yeniden hesapla
function refine(peaks, keep) {
  const out = peaks.filter(keep);
  const ranks = percentileRanks(out.map(p => p.s));
  return out.map((p, k) => ({ frame: p.frame, t: p.t, s: ranks[k] }));
}

// Vokal voicing skoru (0..1): ~170 ms yumusatilmis melodi gucu (x2), REPET'li
// vokal on plan gucu ve harmoniklik ozelliklerinin sarki-ici yuzdelik ortalamasi.
// Gercek vokal benchmark'inda (Demucs referansi, 8 sarki) tek tek ozelliklerden
// daha ayirt edici (AUC 0.806; melodi gucu tek basina 0.794, eski vokal gucu 0.771).
function voicingScore(melStr, vocStr, vocHarm, F) {
  const W = 15;
  const smooth = (a) => {
    const o = new Float32Array(F);
    let s = 0;
    for (let i = 0; i < F; i++) {
      s += a[i]; if (i >= W) s -= a[i - W];
      o[i] = s / Math.min(i + 1, W);
    }
    // merkezle (yarim pencere geri kaydir)
    const c = new Float32Array(F), h = W >> 1;
    for (let i = 0; i < F; i++) c[i] = o[Math.min(F - 1, i + h)];
    return c;
  };
  const rank = (a) => {
    const idx = new Uint32Array(F);
    for (let i = 0; i < F; i++) idx[i] = i;
    idx.sort((x, y) => a[x] - a[y]);
    const r = new Float32Array(F);
    for (let k = 0; k < F; k++) r[idx[k]] = k / Math.max(1, F - 1);
    return r;
  };
  const m = rank(smooth(melStr)), v = rank(smooth(vocStr)), h = rank(smooth(vocHarm));
  const out = new Float32Array(F);
  for (let i = 0; i < F; i++) out[i] = (2 * m[i] + v[i] + h[i]) / 4;
  return out;
}

// Sarkilar ARASI karsilastirilabilir vokal varligi: ~2 sn pencerede ortalama
// harmoniklik. Goreli voicing skoru her sarkida karelerin bir kismini "vokal"
// sayar; vokalsiz (enstrumantal/drop) bolumlerde bu mutlak olcu duser.
function vocalPresence(harm, F, sec) {
  const W = Math.max(1, Math.round(sec / HOP_T / 2));
  const cs = new Float64Array(F + 1);
  for (let i = 0; i < F; i++) cs[i + 1] = cs[i] + harm[i];
  const out = new Float32Array(F);
  for (let i = 0; i < F; i++) { const a = Math.max(0, i - W), b = Math.min(F, i + W + 1); out[i] = (cs[b] - cs[a]) / (b - a); }
  return out;
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
