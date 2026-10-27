// CaYa Rhythm - Titresim motoru (DualSense / Gamepad)
//
// Tek tek "bzzt" yerine katmanli, muzige bagli dokunsal geri bildirim. 60 Hz'de
// guncellenen bir karistirici (her motor icin katmanlarin en buyugu):
//   - olaylar: kisa zarfli darbeler ve desenler (isabet, vurgu, birak, rulo...)
//   - surdurme: uzun nota basili tutulurken hafif, sabit ugultu
//   - boost: vurus izgarasina kilitli "kalp atisi" nabzi
// Motorlar: strong = sol/dusuk frekans (gumbur), weak = sag/yuksek frekans (tik).
// Kisa isabetler yalniz yuksek frekans motorla "net tik" hissi verir; agir
// olaylar (boost, kutlama, basarisizlik) dusuk frekans motorunu kullanir.

// segment: [baslangic ms, sure ms, strong, weak, sekil]
//   sekil: 'tap' (tam guc tutup hizli soner), 'flat', 'ramp' (yukselip duser)
const PATTERNS = {
  perfect:   [[0, 26, 0, 0.30, 'tap']],
  great:     [[0, 22, 0, 0.22, 'tap']],
  good:      [[0, 18, 0, 0.14, 'tap']],
  chord:     [[0, 32, 0.06, 0.34, 'tap']],
  accent:    [[0, 60, 0.28, 0.5, 'tap']],
  lift:      [[0, 16, 0, 0.36, 'flat'], [24, 18, 0, 0.18, 'tap']],          // "birakma" cift tik
  boostNote: [[0, 45, 0.12, 0.42, 'tap']],
  rollTick:  [[0, 16, 0, 0.2, 'tap']],
  rollDone:  [[0, 110, 0.32, 0.45, 'tap']],
  holdDone:  [[0, 55, 0.14, 0.34, 'tap']],
  miss:      [[0, 70, 0.2, 0, 'tap']],                                       // yumusak gumbur
  wrong:     [[0, 40, 0.12, 0, 'tap']],
  multUp:    [[0, 40, 0, 0.3, 'tap']],
  milestone: [[0, 55, 0.35, 0.5, 'tap'], [110, 55, 0.35, 0.5, 'tap']],       // cift vurus
  boostStart:[[0, 140, 0.9, 0.6, 'ramp'], [140, 380, 0.75, 0.45, 'tap']],    // "vuuush"
  boostExtend:[[0, 90, 0.4, 0.5, 'tap']],
  fail:      [[0, 750, 0.85, 0.35, 'tap']],
  connect:   [[0, 90, 0.25, 0.3, 'tap']],
  test:      [[0, 60, 0, 0.5, 'tap'], [120, 60, 0, 0.5, 'tap'], [240, 360, 0.75, 0.55, 'ramp']],
  count:     [[0, 30, 0, 0.18, 'tap']],
  go:        [[0, 90, 0.25, 0.35, 'tap']]
};

const SUSTAIN_WEAK = 0.12;   // uzun nota basiliyken
const BOOST_BEAT = 0.24;     // boost kalp atisi tepe (strong)

export class Haptics {
  // out(strong, weak): motor ciktisi (0..1). input.js saglar.
  constructor(out) {
    this.out = out;
    this.events = [];
    this.holds = 0;
    this.boostPhase = null;   // () => 0..1 vurus fazi (boost aktifken)
    this.strength = 0.8;      // kullanici ayari
    this._timer = 0;
    this._last = [0, 0];
    this._lastSend = 0;
  }

  setStrength(v) { this.strength = Math.max(0, Math.min(1, v)); }

  play(kind) {
    const p = PATTERNS[kind];
    if (!p || this.strength <= 0) return;
    const now = performance.now();
    for (const [at, dur, s, w, shape] of p) this.events.push({ t0: now + at, dur, s, w, shape });
    this._run();
    this._tick(); // HEMEN gonder: sonraki zamanlayici turunu beklerse kisa tik kaybolur
  }

  // isabet: nota turune gore desen sec
  hit(note, judgment) {
    if (note.type === 'roll') return this.play('rollDone');
    if (note.type === 'lift') return this.play('lift');
    if (note.accent && judgment !== 'good') return this.play('accent');
    if (note.boost) return this.play('boostNote');
    if (note.chord != null) return this.play('chord');
    this.play(judgment);
  }

  setHolds(n) { if (n !== this.holds) { this.holds = n; this._run(); } }
  setBoost(phaseFn) { this.boostPhase = phaseFn; this._run(); }

  // her seyi kes (duraklat / menu / bitis)
  stop() {
    this.events.length = 0;
    this.holds = 0;
    this.boostPhase = null;
    this._send(0, 0, true);
    clearInterval(this._timer);
    this._timer = 0;
  }

  _run() {
    if (!this._timer) this._timer = setInterval(() => this._tick(), 16);
  }

  _tick() {
    const now = performance.now();
    let s = 0, w = 0;
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];
      const x = (now - e.t0) / e.dur;
      if (x < 0) continue;
      if (x >= 1) { this.events.splice(i, 1); continue; }
      // tap: ilk %35 tam guc (motorlar ~15-20 ms'de doner), sonra karesel sonum
      const k = e.shape === 'flat' ? 1 : e.shape === 'ramp' ? Math.sin(Math.PI * x)
        : x < 0.35 ? 1 : Math.pow((1 - x) / 0.65, 2);
      if (e.s * k > s) s = e.s * k;
      if (e.w * k > w) w = e.w * k;
    }
    if (this.holds > 0) w = Math.max(w, SUSTAIN_WEAK + 0.02 * Math.min(2, this.holds - 1));
    if (this.boostPhase) {
      const ph = this.boostPhase();
      const beat = Math.pow(1 - ph, 3);
      s = Math.max(s, BOOST_BEAT * beat);
      w = Math.max(w, 0.08);
    }
    this._send(s * this.strength, w * this.strength);
    if (!this.events.length && !this.holds && !this.boostPhase && this._last[0] === 0 && this._last[1] === 0) {
      clearInterval(this._timer);
      this._timer = 0;
    }
  }

  // yalniz degisince gonder (HID raporu sinirli); 1/64 nicemleme
  _send(s, w, force) {
    const q = (v) => Math.round(Math.max(0, Math.min(1, v)) * 64) / 64;
    s = q(s); w = q(w);
    const now = performance.now();
    const changed = s !== this._last[0] || w !== this._last[1];
    // Gamepad API efektleri sure ile calisir: sifir olmayan degerde ~60 ms'de bir yenile
    const keepAlive = (s > 0 || w > 0) && now - this._lastSend > 60;
    if (!changed && !keepAlive && !force) return;
    this._last = [s, w];
    this._lastSend = now;
    this.out(s, w);
  }
}
