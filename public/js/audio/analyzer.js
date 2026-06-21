// CaYa Rhythm - Analiz koprusu (ana is parcacigi)
// Dosyayi cozer, 22050 Hz stereoya yeniden ornekler, merkez/yan kanallari cikarir
// (vokaller tipik olarak merkez kanaldadir) ve analizi Web Worker'a devreder.

const ANALYSIS_SR = 22050;

let worker = null;

function getWorker() {
  if (!worker) {
    worker = new Worker('/js/audio/analysis-worker.js');
  }
  return worker;
}

export async function decodeAudio(arrayBuffer, audioCtx) {
  // decodeAudioData tamponu tuketebilir; kopya ver
  return await audioCtx.decodeAudioData(arrayBuffer.slice(0));
}

// 22050 Hz'e yeniden ornekle, merkez=(L+R)/2 ve yan=(L-R)/2 dondur
export async function resampleCenterSide(audioBuffer) {
  const frames = Math.ceil(audioBuffer.duration * ANALYSIS_SR);
  const off = new OfflineAudioContext(2, frames, ANALYSIS_SR);
  const src = off.createBufferSource();
  src.buffer = audioBuffer;
  src.connect(off.destination);
  src.start(0);
  const rendered = await off.startRendering();
  const L = rendered.getChannelData(0);
  const R = rendered.numberOfChannels > 1 ? rendered.getChannelData(1) : L;
  const center = new Float32Array(L.length);
  const side = new Float32Array(L.length);
  for (let i = 0; i < L.length; i++) {
    center[i] = (L[i] + R[i]) * 0.5;
    side[i] = (L[i] - R[i]) * 0.5;
  }
  return { center, side };
}

export function analyzeSamples(center, side, onProgress) {
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
    w.postMessage(
      { cmd: 'analyze', center, side, sampleRate: ANALYSIS_SR },
      [center.buffer, side.buffer]
    );
  });
}

// Tam akis: ArrayBuffer -> {audioBuffer, analysis}
export async function analyzeArrayBuffer(arrayBuffer, audioCtx, onProgress) {
  onProgress && onProgress('decoding', 2);
  const audioBuffer = await decodeAudio(arrayBuffer, audioCtx);
  onProgress && onProgress('resampling', 6);
  const { center, side } = await resampleCenterSide(audioBuffer);
  const analysis = await analyzeSamples(center, side, onProgress);
  return { audioBuffer, analysis };
}
