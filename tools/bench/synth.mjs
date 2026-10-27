// CaYa Rhythm - Analiz benchmark'i icin sentetik sinyaller (yer gercegi bilinen)
//
// singer(): insan sesine yakin sentetik sarkici — glottal darbe spektrumu,
//   sesli harf formantlari, gecikmeli vibrato, jitter/shimmer, legato glide,
//   unsuz harf gurultusu ve hafif stereo yanki. Nota zamanlari/perdeleri bilinir.
// decoys(): vokal OLMAYAN ama vokale benzeyen tuzaklar — duz synth lead,
//   duzenli vibratolu synth lead (formantsiz testere), merkez pad akoru.
// synthBed(): tekrar eden 4 olcu dongulu enstrumantal yatak (davul/bas/akor/arp).

export const SR = 22050;

export function makeRng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

// sesli harf formantlari (F1,F2,F3 Hz, bant genislikleri)
const VOWELS = [
  [[730, 90], [1090, 110], [2440, 170]], // a
  [[530, 70], [1840, 100], [2480, 160]], // e
  [[300, 50], [2290, 100], [3010, 180]], // i
  [[570, 70], [840, 80], [2410, 160]],   // o
  [[440, 60], [1020, 90], [2240, 150]]   // u
];
function formantGain(f, vowel) {
  let g = 0.08;
  const amps = [1, 0.7, 0.35];
  for (let k = 0; k < 3; k++) {
    const [fc, bw] = vowel[k];
    const x = (f - fc) / bw;
    g += amps[k] / (1 + x * x);
  }
  return g;
}

// Sarkici melodisi uret: ifadeler (4-8 nota) + aralarda sus. Yer gercegi dondurur.
export function makeMelody(rng, { start, end, bpm = 120, lo = 55, hi = 74 }) {
  const beat = 60 / bpm;
  const notes = [];
  let t = start;
  let midi = Math.round((lo + hi) / 2);
  while (t < end - 2) {
    const phraseLen = 4 + Math.floor(rng() * 5);
    for (let i = 0; i < phraseLen && t < end - 1; i++) {
      const durBeats = [0.5, 0.5, 1, 1, 1, 1.5, 2, 3][Math.floor(rng() * 8)];
      const dur = durBeats * beat * (0.85 + rng() * 0.1);
      // adim: cogunlukla kucuk aralik, bazen sicrama
      const step = rng() < 0.75 ? Math.round((rng() - 0.5) * 5) : Math.round((rng() - 0.5) * 12);
      midi = Math.max(lo, Math.min(hi, midi + step));
      notes.push({ t, dur, midi, legato: rng() < 0.4 && i > 0 });
      t += durBeats * beat;
    }
    t += (2 + Math.floor(rng() * 4)) * beat; // nefes / sus
  }
  return notes;
}

// Sarkiciyi L/R'ye ekle (gain: dogrusal). Notalar arasi legato'da perde kayar.
export function renderSinger(L, R, notes, rng, gain = 0.25) {
  const n = L.length;
  const mono = new Float32Array(n);
  let phase = 0;
  for (let ni = 0; ni < notes.length; ni++) {
    const nt = notes[ni];
    const prev = ni > 0 ? notes[ni - 1] : null;
    const glideFrom = nt.legato && prev && Math.abs(prev.t + prev.dur - nt.t) < 0.25 ? prev.midi : nt.midi;
    const vowel = VOWELS[Math.floor(rng() * VOWELS.length)];
    const s0 = Math.floor(nt.t * SR), len = Math.floor(nt.dur * SR);
    const vibRate = 4.8 + rng() * 1.8, vibDepth = 0.25 + rng() * 0.35; // yarim ton
    let jit = 0, shim = 0;
    // unsuz: notanin basinda kisa bantli gurultu (legato degilse)
    if (!nt.legato) {
      const cl = Math.floor((0.02 + rng() * 0.04) * SR);
      let y1 = 0, y2 = 0;
      for (let i = 0; i < cl && s0 - cl + i >= 0; i++) {
        const w = (rng() * 2 - 1);
        const y = w - 0.6 * y1 + 0.2 * y2; y2 = y1; y1 = y; // kaba yuksek-geciren
        mono[s0 - cl + i] += y * 0.09 * Math.sin(Math.PI * i / cl);
      }
    }
    for (let i = 0; i < len && s0 + i < n; i++) {
      const tt = i / SR;
      // perde: glide (ilk 70ms) + gecikmeli vibrato + jitter (rastgele yuruyus)
      const g = Math.min(1, tt / 0.07);
      let m = glideFrom + (nt.midi - glideFrom) * (g * g * (3 - 2 * g));
      const vibOn = Math.min(1, Math.max(0, (tt - 0.18) / 0.25));
      m += vibOn * vibDepth * Math.sin(2 * Math.PI * vibRate * tt);
      jit += (rng() - 0.5) * 0.004; jit *= 0.995;
      shim += (rng() - 0.5) * 0.01; shim *= 0.99;
      const f0 = midiHz(m + jit * 12);
      phase += 2 * Math.PI * f0 / SR;
      // genlik zarfi: atak 25ms, hafif dusus, birakma 60ms
      const rel = Math.max(0, tt - (nt.dur - 0.06));
      const env = Math.min(1, tt / 0.025) * (1 - 0.15 * tt / nt.dur) * Math.max(0, 1 - rel / 0.06) * (1 + shim);
      let s = 0;
      for (let h = 1; h <= 24; h++) {
        const fh = f0 * h;
        if (fh > 9000) break;
        const tilt = 1 / Math.pow(h, 1.1); // glottal ~ -6..-7 dB/oct
        s += Math.sin(phase * h) * tilt * formantGain(fh, vowel);
      }
      mono[s0 + i] += s * env;
    }
  }
  // stereo: merkez + kisa dekorele yanki (gercek miks vokali gibi)
  const dL = Math.floor(0.023 * SR), dR = Math.floor(0.031 * SR);
  for (let i = 0; i < n; i++) {
    const v = mono[i] * gain;
    const eL = i >= dL ? mono[i - dL] * gain * 0.18 : 0;
    const eR = i >= dR ? mono[i - dR] * gain * 0.18 : 0;
    L[i] += v + eL; R[i] += v + eR;
  }
  return mono;
}

// Vokal olmayan tuzaklar: [{kind, t, dur, midi}] — bunlarin bolgesinde
// tespit edilen vokal olaylari YANLIS POZITIFTIR.
export function renderDecoys(L, R, regions, rng, gain = 0.2) {
  const n = L.length;
  const out = [];
  for (const reg of regions) {
    const notes = makeMelody(rng, { start: reg.start, end: reg.end, lo: 57, hi: 76 });
    for (const nt of notes) {
      const s0 = Math.floor(nt.t * SR), len = Math.floor(nt.dur * SR);
      let ph = 0;
      for (let i = 0; i < len && s0 + i < n; i++) {
        const tt = i / SR;
        let m = nt.midi;
        if (reg.kind === 'vibLead') m += 0.3 * Math.sin(2 * Math.PI * 5.5 * tt); // DUZENLI vibrato
        const f0 = midiHz(m);
        ph += 2 * Math.PI * f0 / SR;
        const env = Math.min(1, tt / 0.01) * Math.max(0, 1 - Math.max(0, tt - nt.dur + 0.04) / 0.04);
        let s = 0;
        if (reg.kind === 'pad') {
          // merkez pad: kok + 3'lu + 5'li, yumusak
          for (const iv of [0, 4, 7]) s += Math.sin(ph * Math.pow(2, iv / 12)) * 0.5 + Math.sin(ph * 2 * Math.pow(2, iv / 12)) * 0.2;
        } else {
          for (let h = 1; h <= 20; h++) { if (f0 * h > 9000) break; s += Math.sin(ph * h) / h; } // testere
        }
        const v = s * env * gain * (reg.kind === 'pad' ? 0.5 : 0.6);
        L[s0 + i] += v; R[s0 + i] += v;
      }
    }
    out.push({ kind: reg.kind, start: reg.start, end: reg.end });
  }
  return out;
}

// Sentetik enstrumantal yatak: 120 BPM, 4 olculuk dongu (REPET'in bekledigi
// tekrar yapisi), stereo genis akorlar, merkez davul/bas.
export function synthBed(seconds, rng, bpm = 120) {
  const n = Math.floor(seconds * SR);
  const L = new Float32Array(n), R = new Float32Array(n);
  const beat = 60 / bpm;
  const add = (t, dur, gen, panL = 1, panR = 1) => {
    const s0 = Math.floor(t * SR), len = Math.floor(dur * SR);
    for (let i = 0; i < len && s0 + i < n; i++) { const v = gen(i / SR); L[s0 + i] += v * panL; R[s0 + i] += v * panR; }
  };
  const noise = new Float32Array(SR);
  for (let i = 0; i < SR; i++) noise[i] = rng() * 2 - 1;
  // hi-hat: gercekci olarak yuksek-geciren (2x fark ~ +12 dB/oct) gurultu
  const hpNoise = new Float32Array(SR);
  for (let i = 2; i < SR; i++) hpNoise[i] = (noise[i] - 2 * noise[i - 1] + noise[i - 2]) * 0.25;
  const kick = (t) => Math.sin(2 * Math.PI * (50 + 90 * Math.exp(-t * 35)) * t) * Math.exp(-t * 14) * 0.8;
  const snare = (t) => (noise[Math.floor(t * SR) % SR] * 0.5 + Math.sin(2 * Math.PI * 185 * t) * 0.3) * Math.exp(-t * 20) * 0.45;
  const hat = (t) => hpNoise[(Math.floor(t * SR) * 7) % SR] * Math.exp(-t * 60) * 0.5;
  const prog = [[45, 52, 57, 60, 64], [41, 48, 53, 57, 60], [48, 55, 60, 64, 67], [43, 50, 55, 59, 62]]; // Am F C G
  const bars = Math.ceil(seconds / (beat * 4));
  const drums = { kick: [], snare: [] };
  for (let b = 0; b < bars; b++) {
    const t0 = b * beat * 4;
    const ch = prog[b % 4];
    for (let k = 0; k < 4; k++) {
      add(t0 + k * beat, 0.5, kick);
      if (t0 + k * beat < seconds) drums.kick.push(t0 + k * beat);
      if (k % 2 === 1) { add(t0 + k * beat, 0.3, snare); if (t0 + k * beat < seconds) drums.snare.push(t0 + k * beat); }
      add(t0 + k * beat + beat / 2, 0.08, hat, 0.7, 1);
      add(t0 + k * beat, 0.08, hat, 1, 0.7);
      // bas: kok, 8'lik
      for (const off of [0, 0.5]) {
        const f = midiHz(ch[0] - 12);
        add(t0 + (k + off) * beat, beat * 0.45, (t) => Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 3) * 0.35);
      }
    }
    // akor: genis stereo (L/R farkli ses dagilimi)
    for (let v = 1; v < ch.length; v++) {
      const f = midiHz(ch[v]);
      const pl = v % 2 ? 1 : 0.35, pr = v % 2 ? 0.35 : 1;
      add(t0, beat * 4, (t) => (Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(4 * Math.PI * f * t)) * 0.06 * Math.min(1, t * 8), pl, pr);
    }
    // arpej: 16'lik, sag tarafa yakin
    for (let k = 0; k < 16; k++) {
      const f = midiHz(ch[1 + (k % 4)] + 12);
      add(t0 + k * beat / 4, beat / 4, (t) => Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 12) * 0.07, 0.4, 1);
    }
  }
  return { L, R, drums, bpm };
}
