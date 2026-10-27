// CaYa Rhythm - Analiz koprusu (ana is parcacigi)
// Dosyayi cozer, 22050 Hz stereoya yeniden ornekler ve ham sol/sag kanallari
// analiz Web Worker'ina devreder (worker kanal-arasi benzerlikle merkez/vokal
// cikarimi yapar).

const ANALYSIS_SR = 22050;

let worker = null;

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

export function analyzeSamples(left, right, onProgress) {
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
      { cmd: 'analyze', left, right, sampleRate: ANALYSIS_SR },
      [left.buffer, right.buffer]
    );
  });
}

// Tam akis: ArrayBuffer -> {audioBuffer, analysis}
export async function analyzeArrayBuffer(arrayBuffer, audioCtx, onProgress) {
  onProgress && onProgress('decoding', 2);
  const audioBuffer = await decodeAudio(arrayBuffer, audioCtx);
  onProgress && onProgress('resampling', 6);
  const { left, right } = await resampleStereo(audioBuffer);
  const analysis = await analyzeSamples(left, right, onProgress);
  return { audioBuffer, analysis };
}
