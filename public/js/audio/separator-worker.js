// CaYa Rhythm - Yapay zeka kaynak ayirma worker'i (modul worker)
//
// HTDemucs v4 (Defossez ve dig., Meta AI, MIT lisansi) miksi 4 kanala ayirir:
// davul, bas, diger (enstruman), vokal. ONNX Runtime Web ile WebGPU uzerinde
// calisir. Model: huggingface.co/monteslu/htdemucs-web-onnx (MIT) - resmi
// htdemucs agirliklarinin karisik hassasiyetli (fp16, evrisimler fp32) ve 21
// parcaya bolunmus ONNX'i: her parca kisa bir GPU isi oldugu icin ayirma
// surerken arayuz donmaz. WebGPU yoksa ayirma yapilmaz ('no-webgpu' hatasi);
// analiz klasik (yapay zekasiz) yola duser.
//
// Girdi : 44100 Hz stereo sol/sag kanal
// Cikti : her kanal icin 22050 Hz MONO Float32Array (analiz worker'inin hizi)
//
// Model ~126 MB; ilk kullanimda indirilir ve Cache API'de saklanir.
// STFT/iSTFT burada (model yalniz ag kismini icerir): n_fft 4096, hop 1024,
// Hann, normalized (1/sqrt(N)), merkezli + yansitmali dolgu - demucs'un
// spectro()/ispectro() ve HTDemucs._spec/_ispec ile ayni cerceve hizalamasi.

const ORT_VERSION = '1.24.3';
const ORT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
// sabit revizyon: depo guncellense de ayni dosyalar
const MODEL_BASE = 'https://huggingface.co/monteslu/htdemucs-web-onnx/resolve/a4a57cc0cf707e5b9a3e6ad3c2c4b21fcbe608c1/';
const MODEL_BYTES = 125881245; // 21 parcanin toplam boyutu (ilerleme cubugu icin)
// parca 0'in girdi normalizasyonu fp16'da WebGPU'da NaN uretir -> CPU'da (model karti)
const CPU_NODES = ['/ReduceMean', '/Sub', '/Pow', '/ReduceMean_1', '/Clip', '/Sqrt', '/Add', '/Div',
  '/ReduceMean_2', '/Sub_1', '/Pow_1', '/ReduceMean_3', '/Clip_1', '/Sqrt_1', '/Add_1', '/Div_1'];
const CACHE_NAME = 'caya-models-v1';

const SR = 44100;
const SEG = 343980;          // modelin egitim segmenti (7.8 sn)
const NFFT = 4096, HOPF = 1024, BINS = 2048, FRAMES = 336;
const PAD = (HOPF >> 1) * 3; // HTDemucs._spec dolgusu (1536)
const CPAD = NFFT >> 1;      // torch.stft center dolgusu (2048)
const OVERLAP = 0.25;
const TRACKS = ['drums', 'bass', 'other', 'vocals'];

let ort = null, pieces = null, outNames = null;

function post(type, extra) { self.postMessage(Object.assign({ type }, extra)); }

// ---------- FFT (radix-2, yerinde) ----------
function makeFFT(n) {
  const lg = Math.log2(n);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < lg; b++) r |= ((i >> b) & 1) << (lg - 1 - b); rev[i] = r; }
  const cs = new Float64Array(n / 2), sn = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cs[i] = Math.cos(2 * Math.PI * i / n); sn[i] = Math.sin(2 * Math.PI * i / n); }
  // inv=false: e^{-i}, inv=true: e^{+i} (olceksiz)
  return (re, im, inv) => {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0; j < half; j++) {
          const k = j * step, wr = cs[k], wi = inv ? sn[k] : -sn[k];
          const a = i + j, b = a + half;
          const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  };
}
const fft = makeFFT(NFFT);
const HANN = new Float64Array(NFFT);
for (let i = 0; i < NFFT; i++) HANN[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / NFFT);

// yansitmali indeks (numpy/torch 'reflect': kenar ornegi tekrarlanmaz)
function reflectIdx(i, n) {
  if (n === 1) return 0;
  const p = 2 * (n - 1);
  i = ((i % p) + p) % p;
  return i < n ? i : p - i;
}

// Segmentin model girdisi spektrumu: [4 (Lre, Lim, Rre, Rim), BINS, FRAMES]
// Cerceve f (0..FRAMES-1) = dolgulu sinyalde (f+2). cerceve; ornek t'nin
// dolgulu konumu t + PAD + CPAD (HTDemucs._spec: pad, sonra torch center).
function specInput(segL, segR) {
  const out = new Float32Array(4 * BINS * FRAMES);
  const le = Math.ceil(SEG / HOPF);
  const padR = PAD + le * HOPF - SEG;
  const innerLen = PAD + SEG + padR;
  const re = new Float64Array(NFFT), im = new Float64Array(NFFT);
  const scale = 1 / Math.sqrt(NFFT);
  const chans = [segL, segR];
  for (let c = 0; c < 2; c++) {
    const x = chans[c];
    // ic dolgu (yansitma, SEG uzerinden), sonra center dolgusu (ic sinyal uzerinden)
    const padded = new Float32Array(innerLen + 2 * CPAD);
    for (let j = 0; j < padded.length; j++) padded[j] = x[reflectIdx(reflectIdx(j - CPAD, innerLen) - PAD, SEG)];
    for (let f = 0; f < FRAMES; f++) {
      const start = (f + 2) * HOPF;
      for (let i = 0; i < NFFT; i++) { re[i] = padded[start + i] * HANN[i]; im[i] = 0; }
      fft(re, im, false);
      const base = c * 2 * BINS * FRAMES;
      for (let b = 0; b < BINS; b++) {
        out[base + b * FRAMES + f] = re[b] * scale;
        out[base + BINS * FRAMES + b * FRAMES + f] = im[b] * scale;
      }
    }
  }
  return out;
}

// Frekans dali ciktisi -> MONO zaman sinyali (iki iz tek karmasik IFFT'de:
// z = A + iB -> gercek kisim a, sanal kisim b). Sol+sag karmasik toplanir
// (dogrusal) -> (L+R)/2.
// freq: [1, 4 iz, 4 kanal, BINS, FRAMES]; dondurur: 4 x Float32Array(SEG)
function freqToMono(freq) {
  const out = TRACKS.map(() => new Float32Array(SEG));
  const total = (FRAMES + 4 - 1) * HOPF + NFFT;
  const off = CPAD + PAD;
  const re = new Float64Array(NFFT), im = new Float64Array(NFFT);
  const scale = Math.sqrt(NFFT) / NFFT; // normalized istft + IFFT 1/N
  const plane = BINS * FRAMES;
  for (let pair = 0; pair < 2; pair++) {
    const ta = pair * 2, tb = ta + 1;
    const accA = new Float64Array(total), accB = new Float64Array(total), wsum = new Float64Array(total);
    // dolgulu cerceveler: 2 bos + FRAMES + 2 bos; bos cerceveler sifir katki
    for (let f = 0; f < FRAMES; f++) {
      re.fill(0); im.fill(0);
      for (let b = 0; b < BINS; b++) {
        const i = b * FRAMES + f;
        const baseA = ta * 4 * plane, baseB = tb * 4 * plane;
        const aR = 0.5 * (freq[baseA + i] + freq[baseA + 2 * plane + i]);
        const aI = 0.5 * (freq[baseA + plane + i] + freq[baseA + 3 * plane + i]);
        const bR = 0.5 * (freq[baseB + i] + freq[baseB + 2 * plane + i]);
        const bI = 0.5 * (freq[baseB + plane + i] + freq[baseB + 3 * plane + i]);
        // Z[k] = A[k] + iB[k]; Z[N-k] = conj(A[k]) + i conj(B[k])
        // DC kutusunun sanal kismi gercek sinyalde anlamsiz (irfft yok sayar)
        if (b === 0) { re[0] = aR; im[0] = bR; continue; }
        re[b] = aR - bI; im[b] = aI + bR;
        re[NFFT - b] = aR + bI; im[NFFT - b] = -aI + bR;
      }
      // Nyquist kutusu (2048) modelde yok -> 0
      fft(re, im, true);
      const start = (f + 2) * HOPF;
      for (let i = 0; i < NFFT; i++) {
        const w = HANN[i];
        accA[start + i] += re[i] * scale * w;
        accB[start + i] += im[i] * scale * w;
      }
    }
    for (let f = 0; f < FRAMES + 4; f++) {
      const start = f * HOPF;
      for (let i = 0; i < NFFT; i++) wsum[start + i] += HANN[i] * HANN[i];
    }
    for (let t = 0; t < SEG; t++) {
      const j = t + off, w = wsum[j] > 1e-8 ? wsum[j] : 1;
      out[ta][t] = accA[j] / w;
      out[tb][t] = accB[j] / w;
    }
  }
  return out;
}

// 2:1 indirgeme (44100 -> 22050): 63 musluk pencereli sinc, kesim 10 kHz
const DEC_TAPS = (() => {
  const n = 63, h = new Float64Array(n), fc = 10000 / SR;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const m = i - (n - 1) / 2;
    const sinc = m === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * m) / (Math.PI * m);
    const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)) + 0.08 * Math.cos(4 * Math.PI * i / (n - 1));
    h[i] = sinc * w; s += h[i];
  }
  for (let i = 0; i < n; i++) h[i] /= s;
  return h;
})();
function decimate2(x) {
  const n = x.length >> 1, y = new Float32Array(n), H = DEC_TAPS, half = (H.length - 1) >> 1;
  for (let i = 0; i < n; i++) {
    const c = 2 * i; let acc = 0;
    for (let k = 0; k < H.length; k++) { const j = c + k - half; if (j >= 0 && j < x.length) acc += H[k] * x[j]; }
    y[i] = acc;
  }
  return y;
}


async function loadOrt() {
  if (ort) return;
  ort = await import(ORT_BASE + 'ort.webgpu.min.mjs');
  ort.env.wasm.wasmPaths = ORT_BASE;
  ort.env.logLevel = 'error'; // dugum-yerlesimi uyarilari kullanici konsolunu doldurmasin
  // GitHub Pages COOP/COEP gondermez -> SharedArrayBuffer yok -> tek is parcacigi
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
}

async function openCache() {
  try { return await caches.open(CACHE_NAME); } catch { return null; }
}

// Parcalari indir (onbellekten ya da agdan); ilerleme toplam bayta gore
async function fetchPieces() {
  const cache = await openCache();
  const getBuf = async (url, onChunk) => {
    if (cache) {
      const hit = await cache.match(url);
      if (hit) { const b = await hit.arrayBuffer(); onChunk(b.byteLength); return b; }
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error('model indirilemedi: HTTP ' + res.status);
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); got += value.length; onChunk(value.length);
    }
    const buf = new Uint8Array(got);
    let o = 0;
    for (const c of chunks) { buf.set(c, o); o += c.length; }
    if (cache) { try { await cache.put(url, new Response(buf.slice(0))); } catch { /* kota dolu: onbelleksiz devam */ } }
    return buf.buffer;
  };
  const manifest = JSON.parse(new TextDecoder().decode(await getBuf(MODEL_BASE + 'htdemucs_split_manifest.json', () => {})));
  let got = 0, lastPct = -1;
  const onChunk = (n) => {
    got += n;
    const pct = Math.min(100, Math.floor(got / MODEL_BYTES * 100));
    if (pct !== lastPct) { lastPct = pct; post('progress', { stage: 'model', pct }); }
  };
  const bufs = [];
  for (const p of manifest.pieces) bufs.push(await getBuf(MODEL_BASE + p.file, onChunk));
  return { manifest, bufs };
}

async function ensureSession() {
  if (pieces) return;
  if (!(self.navigator && navigator.gpu)) throw new Error('no-webgpu');
  await loadOrt();
  const { manifest, bufs } = await fetchPieces();
  post('progress', { stage: 'init', pct: 0 });
  const list = [];
  for (let i = 0; i < manifest.pieces.length; i++) {
    const ep = i === 0 ? { name: 'webgpu', forceCpuNodeNames: CPU_NODES } : 'webgpu';
    const s = await ort.InferenceSession.create(bufs[i], {
      executionProviders: [ep], graphOptimizationLevel: 'all', preferredOutputLocation: 'gpu-buffer'
    });
    list.push({ s, inputs: manifest.pieces[i].inputs });
    bufs[i] = null;
    post('progress', { stage: 'init', pct: Math.round((i + 1) / manifest.pieces.length * 100) });
  }
  pieces = list;
  outNames = manifest.outputs; // { freq: 'x', time: 'xt' }
}

// Bir segmenti parca zinciri boyunca calistir; ara tensorler GPU'da kalir
async function runChain(wave, mag) {
  const map = {
    mix: new ort.Tensor('float32', wave, [1, 2, SEG]),
    mag: new ort.Tensor('float32', mag, [1, 4, BINS, FRAMES])
  };
  const owned = [];
  try {
    for (const p of pieces) {
      const feeds = {};
      for (const n of p.inputs) feeds[n] = map[n];
      const out = await p.s.run(feeds);
      for (const [k, v] of Object.entries(out)) { map[k] = v; owned.push(v); }
    }
    const xt = await map[outNames.time].getData();
    const xf = await map[outNames.freq].getData();
    return { xt, xf };
  } finally {
    for (const t of owned) { try { t.dispose(); } catch { /* zaten birakildi */ } }
  }
}

async function separate(left, right) {
  const total = left.length;
  const stride = Math.floor(SEG * (1 - OVERLAP));
  const nSeg = Math.max(1, Math.ceil(Math.max(0, total - SEG) / stride) + 1);
  const acc = TRACKS.map(() => new Float32Array(total));
  const wsum = new Float32Array(total);
  // ucgen agirlik (demucs apply_model, transition_power=1)
  const wt = new Float32Array(SEG);
  for (let i = 0; i < SEG; i++) wt[i] = Math.min(i + 1, SEG - i);
  const segL = new Float32Array(SEG), segR = new Float32Array(SEG);
  const t0 = performance.now();
  const prof = { pre: 0, run: 0, post: 0 };
  for (let s = 0; s < nSeg; s++) {
    let tp = performance.now();
    const start = s * stride;
    const len = Math.min(SEG, total - start);
    segL.fill(0); segR.fill(0);
    segL.set(left.subarray(start, start + len)); segR.set(right.subarray(start, start + len));
    const wave = new Float32Array(2 * SEG);
    wave.set(segL, 0); wave.set(segR, SEG);
    const mag = specInput(segL, segR);
    prof.pre += performance.now() - tp; tp = performance.now();
    const { xt, xf } = await runChain(wave, mag);
    prof.run += performance.now() - tp; tp = performance.now();
    const fmono = freqToMono(xf);
    for (let k = 0; k < 4; k++) {
      const a = acc[k], tl = k * 2 * SEG, tr = tl + SEG, fm = fmono[k];
      for (let i = 0; i < len; i++) a[start + i] += (0.5 * (xt[tl + i] + xt[tr + i]) + fm[i]) * wt[i];
    }
    for (let i = 0; i < len; i++) wsum[start + i] += wt[i];
    prof.post += performance.now() - tp;
    const el = (performance.now() - t0) / 1000;
    post('progress', { stage: 'separating', pct: Math.round((s + 1) / nSeg * 100), eta: el / (s + 1) * (nSeg - s - 1) });
  }
  const stems = {};
  for (let k = 0; k < 4; k++) {
    const a = acc[k];
    for (let i = 0; i < total; i++) if (wsum[i] > 0) a[i] /= wsum[i];
    stems[TRACKS[k]] = decimate2(a);
    acc[k] = null;
  }
  return { stems, seconds: (performance.now() - t0) / 1000, prof };
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.cmd === 'probe') {
      // model onbellekte mi? (indirme gerekmeden kullanilabilir mi)
      let cached = false;
      const c = await openCache();
      if (c) { try { cached = !!(await c.match(MODEL_BASE + 'htdemucs_p20.onnx')); } catch { /* yok */ } }
      post('probe', { cached, webgpu: !!(self.navigator && navigator.gpu) });
      return;
    }
    if (m.cmd === 'separate') {
      await ensureSession();
      const out = await separate(m.left, m.right);
      self.postMessage({ type: 'result', stems: out.stems, seconds: out.seconds, prof: out.prof },
        Object.values(out.stems).map(s => s.buffer));
    }
  } catch (err) {
    post('error', { message: (err && err.message) || String(err) });
  }
};
