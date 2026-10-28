// CaYa Rhythm - Analiz koprusu (ana is parcacigi)
// Dosyayi cozer, 22050 Hz stereoya yeniden ornekler ve ham sol/sag kanallari
// analiz Web Worker'ina devreder (worker kanal-arasi benzerlikle merkez/vokal
// cikarimi yapar). Yapay zeka ayirmasi aciksa once separator-worker.js miksi
// davul/bas/enstruman/vokal kanallarina ayirir; kanallar analize eklenir.

const ANALYSIS_SR = 22050;
const SEP_SR = 44100; // ayirma modelinin ornekleme hizi

let worker = null;
let sepWorker = null;

function getSepWorker() {
  if (!sepWorker) sepWorker = new Worker(new URL('./separator-worker.js', import.meta.url), { type: 'module' });
  return sepWorker;
}

// Yapay zeka ayirmasi kullanilabilir mi (WebGPU) ve model onbellekte mi
export function separationSupport() {
  return new Promise((resolve) => {
    if (!navigator.gpu) { resolve({ webgpu: false, cached: false }); return; }
    const w = getSepWorker();
    const onMsg = (e) => { if (e.data.type === 'probe') { w.removeEventListener('message', onMsg); resolve(e.data); } };
    w.addEventListener('message', onMsg);
    w.postMessage({ cmd: 'probe' });
  });
}

// Miksi 4 kanala ayir -> { vocals, drums, bass, other } (22050 Hz mono)
export async function separateStems(audioBuffer, onProgress) {
  const frames = Math.ceil(audioBuffer.duration * SEP_SR);
  const off = new OfflineAudioContext(2, frames, SEP_SR);
  const src = off.createBufferSource();
  src.buffer = audioBuffer;
  src.connect(off.destination);
  src.start(0);
  const r = await off.startRendering();
  const left = r.getChannelData(0).slice();
  const right = r.numberOfChannels > 1 ? r.getChannelData(1).slice() : left.slice();
  return new Promise((resolve, reject) => {
    const w = getSepWorker();
    const done = () => { w.removeEventListener('message', onMsg); w.onerror = null; };
    const onMsg = (e) => {
      const m = e.data;
      if (m.type === 'progress') onProgress && onProgress(m.stage, m.pct, m.eta);
      else if (m.type === 'result') { done(); resolve(m.stems); }
      else if (m.type === 'error') {
        done();
        // oturum bozulduysa bir sonraki denemede temiz worker
        sepWorker = null;
        try { w.terminate(); } catch {}
        reject(new Error(m.message));
      }
    };
    w.addEventListener('message', onMsg);
    w.onerror = (err) => { done(); sepWorker = null; reject(new Error('Ayırma worker hatası: ' + (err.message || 'bilinmeyen'))); };
    w.postMessage({ cmd: 'separate', left, right }, [left.buffer, right.buffer]);
  });
}

function getWorker() {
  if (!worker) {
    // goreli yol: GitHub Pages alt dizininde (/CaYaRhythmGame/) de calisir
    worker = new Worker(new URL('./analysis-worker.js', import.meta.url));
  }
  return worker;
}

export async function decodeAudio(arrayBuffer, audioCtx) {
  // decodeAudioData tamponu tuketebilir; kopya ver
  return await audioCtx.decodeAudioData(arrayBuffer.slice(0));
}

// 22050 Hz stereoya yeniden ornekle; {left, right} dondur (mono'da ikisi ayni)
export async function resampleStereo(audioBuffer) {
  const frames = Math.ceil(audioBuffer.duration * ANALYSIS_SR);
  const off = new OfflineAudioContext(2, frames, ANALYSIS_SR);
  const src = off.createBufferSource();
  src.buffer = audioBuffer;
  src.connect(off.destination);
  src.start(0);
  const rendered = await off.startRendering();
  const left = rendered.getChannelData(0).slice();
  const right = rendered.numberOfChannels > 1 ? rendered.getChannelData(1).slice() : left.slice();
  return { left, right };
}

export function analyzeSamples(left, right, onProgress, stems = null) {
  return new Promise((resolve, reject) => {
    const w = getWorker();
    const onMsg = (e) => {
      const m = e.data;
      if (m.type === 'progress') {
        onProgress && onProgress(m.stage, m.pct);
      } else if (m.type === 'result') {
        w.removeEventListener('message', onMsg);
        resolve(m);
      } else if (m.type === 'error') {
        w.removeEventListener('message', onMsg);
        worker = null;
        try { w.terminate(); } catch {}
        reject(new Error(m.message));
      }
    };
    w.addEventListener('message', onMsg);
    w.onerror = (err) => {
      w.removeEventListener('message', onMsg);
      worker = null;
      reject(new Error('Analiz worker hatası: ' + (err.message || 'bilinmeyen')));
    };
    const transfer = [left.buffer, right.buffer];
    if (stems) for (const k of Object.keys(stems)) transfer.push(stems[k].buffer);
    w.postMessage({ cmd: 'analyze', left, right, sampleRate: ANALYSIS_SR, stems }, transfer);
  });
}

// Tam akis: ArrayBuffer -> {audioBuffer, analysis}
// opts.separate: yapay zeka ayirmasini dene (basarisizsa klasik analiz).
// Ilerleme: ayirma varken %0-75 ayirma (model indirme dahil), %75-100 analiz.
export async function analyzeArrayBuffer(arrayBuffer, audioCtx, onProgress, opts = {}) {
  const prog = (st, p, eta) => onProgress && onProgress(st, p, eta);
  prog('decoding', 2);
  const audioBuffer = await decodeAudio(arrayBuffer, audioCtx);
  let stems = null, sepError = null;
  if (opts.separate) {
    try {
      stems = await separateStems(audioBuffer, (st, p, eta) => {
        if (st === 'model') prog('model', 3 + p * 0.12);
        else if (st === 'init') prog('init', 15);
        else prog('separating', 15 + p * 0.6, eta);
      });
    } catch (err) {
      sepError = err.message;
      console.warn('Yapay zeka ayirmasi kullanilamadi, klasik analiz:', err);
    }
  }
  const base = stems ? 75 : 6;
  prog('resampling', base);
  const { left, right } = await resampleStereo(audioBuffer);
  const analysis = await analyzeSamples(left, right, (st, p) => prog(st, base + p * (100 - base) / 100), stems);
  analysis.sepMode = stems ? 'ai' : 'dsp';
  if (sepError) analysis.sepError = sepError;
  return { audioBuffer, analysis };
}
