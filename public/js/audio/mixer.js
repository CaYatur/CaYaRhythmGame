// CaYa Rhythm - Oyun ici ses zinciri
//
// kaynak -> [orta/yan matrisi -> parca filtreleri] -> analizor -> master -> cikis
//
// Parca geri bildirimi: oyuncu notalari kacirdikca CALDIGI PARCA miksten
// kisilir, isabetle geri gelir (tum sarki degil, yalniz o parca):
//   vocal: orta kanalda 1.2-3.5 kHz bolgesi (vokal varligi)
//   lead:  yan kanalda (stereo genis enstrumanlar) orta-tiz bolge; ortada hafif
//   bass:  orta kanalda alcak raf (<220 Hz)
//   drums: orta+yan alcak (kick) ve yuksek raf (trampet/hat)
//   mix:   genel ses (tam grup)

const FEEDBACK = {
  vocal: { filters: [{ type: 'peaking', f: 1900, q: 0.6, db: -16 }], side: false },
  lead: { filters: [{ type: 'peaking', f: 1400, q: 0.45, db: -16 }], side: true, midScale: 0.35 },
  bass: { filters: [{ type: 'lowshelf', f: 220, db: -18 }], side: false },
  drums: { filters: [{ type: 'lowshelf', f: 140, db: -12 }, { type: 'highshelf', f: 3500, db: -14 }], side: true },
  mix: { filters: [], side: false, broadband: -8 }
};

export class Mixer {
  constructor(ctx) {
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.7;
    this.analyser.connect(this.master);
    this.master.connect(ctx.destination);

    // orta/yan matrisi
    this.split = ctx.createChannelSplitter(2);
    this.merge = ctx.createChannelMerger(2);
    const g = (v) => { const n = ctx.createGain(); n.gain.value = v; return n; };
    // not: connect() HEDEFI dondurur; ara kazanc dugumleri ayri baglanir
    const via = (from, out, v, to, inp = 0) => { const n = g(v); from.connect(n, out); n.connect(to, 0, inp); };
    this.mid = g(1); this.side = g(1);
    via(this.split, 0, 0.5, this.mid);
    via(this.split, 1, 0.5, this.mid);
    via(this.split, 0, 0.5, this.side);
    via(this.split, 1, -0.5, this.side);
    this.midOut = g(1); this.sideOut = g(1);
    this.broad = g(1);
    // L = M + S, R = M - S
    this.midOut.connect(this.merge, 0, 0);
    this.midOut.connect(this.merge, 0, 1);
    this.sideOut.connect(this.merge, 0, 0);
    via(this.sideOut, 0, -1, this.merge, 1);
    this.merge.connect(this.broad);
    this.broad.connect(this.analyser);

    this.chainM = []; this.chainS = [];
    this.amount = 0;      // 0 = parca tam, 1 = tamamen kisik
    this.enabled = true;
    this.profile = FEEDBACK.mix;
    this.source = null;
    this._wire();
  }

  setVolume(v) { this.master.gain.value = v; }

  // parca profili sec (yeni sarki/parca basinda)
  setPart(kind) {
    this.profile = FEEDBACK[kind] || FEEDBACK.mix;
    this._wire();
    this.amount = 0;
    this._apply(true);
  }

  setFeedbackEnabled(on) { this.enabled = on; if (!on) { this.amount = 0; this._apply(true); } }

  _wire() {
    const ctx = this.ctx;
    try { this.mid.disconnect(); } catch {}
    try { this.side.disconnect(); } catch {}
    for (const f of this.chainM.concat(this.chainS)) { try { f.disconnect(); } catch {} }
    const build = (spec, scale = 1) => spec.map(s => {
      const f = ctx.createBiquadFilter();
      f.type = s.type; f.frequency.value = s.f; if (s.q) f.Q.value = s.q;
      f.gain.value = 0;
      f._db = s.db * scale;
      return f;
    });
    this.chainM = build(this.profile.filters, this.profile.midScale != null ? this.profile.midScale : 1);
    this.chainS = this.profile.side ? build(this.profile.filters) : [];
    const link = (src, chain, dst) => {
      let n = src;
      for (const f of chain) { n.connect(f); n = f; }
      n.connect(dst);
    };
    link(this.mid, this.chainM, this.midOut);
    link(this.side, this.chainS, this.sideOut);
  }

  _apply(instant) {
    const a = this.enabled ? this.amount : 0;
    const t = this.ctx.currentTime;
    const tc = instant ? 0.001 : (a > 0.5 ? 0.06 : 0.18); // hizli kis, yavas geri gel
    for (const f of this.chainM.concat(this.chainS)) f.gain.setTargetAtTime(f._db * a, t, tc);
    const bdb = (this.profile.broadband || 0) * a;
    this.broad.gain.setTargetAtTime(Math.pow(10, bdb / 20), t, tc);
  }

  // oyun olaylari: kacirma parcayi kisar, isabetler geri getirir
  onMiss() { this.amount = Math.min(1, this.amount + 0.6); this._apply(); }
  onHit() { if (this.amount > 0) { this.amount = Math.max(0, this.amount - 0.34); this._apply(); } }

  // kaynagi baslat: when = ctx zamani, offset = sarki saniyesi, rate = hiz
  play(buffer, when, offset = 0, rate = 1) {
    this.stop();
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    src.connect(this.split);
    src.start(when, Math.max(0, offset));
    this.source = src;
    this.amount = 0;
    this._apply(true);
    return src;
  }

  stop() {
    if (!this.source) return;
    try { this.source.stop(); } catch {}
    try { this.source.disconnect(); } catch {}
    this.source = null;
  }
}
