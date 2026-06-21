// Dahili test sarkisi ureticisi: 90 sn, 120 BPM, davul + bas + melodi
// Cikti: public/test-song.wav (16-bit stereo 44100 Hz)
const fs = require('fs');
const path = require('path');

const SR = 44100;
const DUR = 90;
const BPM = 120;
const BEAT = 60 / BPM;
const N = SR * DUR;
const L = new Float32Array(N);
const R = new Float32Array(N);

function addAt(t, gen, dur) {
  const start = Math.floor(t * SR);
  const len = Math.floor(dur * SR);
  for (let i = 0; i < len && start + i < N; i++) {
    const s = gen(i / SR);
    L[start + i] += s;
    R[start + i] += s;
  }
}

// enstrumanlar
const kick = (t) => Math.sin(2 * Math.PI * (55 + 80 * Math.exp(-t * 30)) * t) * Math.exp(-t * 18) * 0.9;
const snare = (t) => ((Math.random() * 2 - 1) * 0.6 + Math.sin(2 * Math.PI * 190 * t) * 0.4) * Math.exp(-t * 22) * 0.55;
const hat = (t) => (Math.random() * 2 - 1) * Math.exp(-t * 70) * 0.22;

function lead(freq, sustainDur) {
  // "Vokal benzeri" lead: 5.5 Hz vibrato (insan sesi gibi), formant ağırlıklı
  // harmonikler ve hafif nefes gürültüsü -> insan sesi kapısını geçer, REPET
  // testinde tekrar etmeyen ön plan olarak ayrışır.
  return (t) => {
    let env;
    if (sustainDur) {
      const rel = Math.max(0, t - (sustainDur - 0.25));
      env = Math.min(1, t * 40) * (0.95 - 0.15 * (t / sustainDur)) * Math.exp(-rel * 10);
    } else {
      env = Math.min(1, t * 40) * Math.exp(-t * 2.2);
    }
    const vib = 1 + 0.03 * Math.sin(2 * Math.PI * 5.5 * t); // vibrato
    const fv = freq * vib;
    // formant benzeri ağırlıklar (2. ve 3. harmonik vurgulu)
    const w = [1, 0.85, 0.7, 0.4, 0.22];
    let s = 0;
    for (let h = 1; h <= 5; h++) s += Math.sin(2 * Math.PI * fv * h * t) * w[h - 1] / h;
    const breath = (Math.random() * 2 - 1) * 0.015 * env; // hafif soluk
    return (s * 0.34 + breath) * env; // lead öne mikslenir (gerçek vokal gibi)
  };
}
function bassNote(freq) {
  return (t) => {
    const env = Math.min(1, t * 30) * Math.exp(-t * 1.4);
    return (Math.sin(2 * Math.PI * freq * t) + 0.4 * Math.sin(2 * Math.PI * freq * 2 * t)) * env * 0.17;
  };
}

const midi = (m) => 440 * Math.pow(2, (m - 69) / 12);
// A minor pentatonik melodi kaliplari (MIDI)
const phraseA = [69, 72, 74, 76, 74, 72, 69, 67];
const phraseB = [76, 79, 81, 79, 76, 74, 72, 74];
const bassLine = [45, 45, 48, 43]; // A C G (oktav asagi)

const totalBeats = Math.floor(DUR / BEAT) - 4;
for (let b = 0; b < totalBeats; b++) {
  const t = b * BEAT;
  const bar = Math.floor(b / 4);
  const beatInBar = b % 4;
  const section = Math.floor(bar / 8) % 2; // 0: sakin, 1: nakarat

  // davul
  addAt(t, kick, 0.25);
  if (section === 1 && beatInBar === 2) addAt(t + BEAT / 2, kick, 0.25); // nakaratta ekstra kick
  if (beatInBar === 1 || beatInBar === 3) addAt(t, snare, 0.2);
  addAt(t, hat, 0.08);
  addAt(t + BEAT / 2, hat, 0.08);
  if (section === 1) { addAt(t + BEAT / 4, hat, 0.06); addAt(t + 3 * BEAT / 4, hat, 0.06); }

  // bas (her vurus)
  addAt(t, bassNote(midi(bassLine[bar % 4])), BEAT * 0.9);

  // melodi: 8'lik notalar, 2 vurusta bir; nakaratta daha yogun
  const phrase = section === 1 ? phraseB : phraseA;
  if (b % 2 === 0) {
    const noteIdx = (b / 2) % phrase.length;
    const isLong = noteIdx === phrase.length - 1; // cumle sonu uzun nota (hold testi)
    const len = isLong ? BEAT * 3.5 : BEAT * 1.2;
    addAt(t, lead(midi(phrase[noteIdx]), isLong ? len : 0), len);
  } else if (section === 1) {
    addAt(t, lead(midi(phrase[(Math.floor(b / 2) + 3) % phrase.length] + 12)), BEAT * 0.6);
  }
}

// normalize + hafif limitleme
let peak = 0;
for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(L[i]));
const gain = 0.85 / (peak || 1);
for (let i = 0; i < N; i++) { L[i] *= gain; R[i] *= gain; }

// WAV yaz (16-bit PCM stereo)
const dataLen = N * 2 * 2;
const buf = Buffer.alloc(44 + dataLen);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataLen, 4); buf.write('WAVE', 8);
buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28);
buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
buf.write('data', 36); buf.writeUInt32LE(dataLen, 40);
for (let i = 0; i < N; i++) {
  buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(L[i] * 32767))), 44 + i * 4);
  buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(R[i] * 32767))), 46 + i * 4);
}

const out = path.join(__dirname, '..', 'public', 'test-song.wav');
fs.writeFileSync(out, buf);
console.log('Yazildi:', out, (buf.length / 1024 / 1024).toFixed(1) + ' MB');
