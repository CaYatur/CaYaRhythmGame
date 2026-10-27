// CaYa Rhythm - Puanlama: vurus pencereleri, kombo, 1x-6x carpan, boost (x2),
// performans metresi (bitirme/basarisizlik), yildizlar, zamanlama istatistikleri.
// Nota turleri: tap, hold, lift (serit BIRAKILINCA degerlendirilir), roll (bar
// boyunca tekrarlanan basislar), accent (Kusursuz/Harika'da +%50).

export const WINDOWS = {
  perfect: 0.050,
  great: 0.105,
  good: 0.150
};

export const BASE_POINTS = { perfect: 100, great: 70, good: 40 };
const HOLD_TICK_SCORE = 12;     // 0.1 sn basina
const HOLD_TICK_DT = 0.1;
const HOLD_BONUS = 50;          // tamamlama bonusu
const MULT_STEPS = [0, 10, 20, 30, 40, 50]; // kombo esikleri -> 1x..6x
const MAX_BARS = 4;             // boost bari sayisi
const BOOST_PER_BAR = 5;        // bar basina boost suresi (sn) — 4 bar = 20 sn
const ACCENT_BONUS = 0.5;       // vurgu notasi: Kusursuz/Harika'da +%50
const ROLL_TICK = 20;           // rulo basisi basina (gerekenin 1.5 katina kadar)
const ROLL_BONUS = 60;          // rulo tamamlama bonusu
const ROLL_END_PAD = 0.06;      // rulo bitisinden sonra degerlendirme payi
// performans metresi (0..1): isabet yukseltir, kacirma dusurur; 0 = sahne kaybedildi
const METER_START = 0.6;
const METER_GAIN = { perfect: 0.022, great: 0.016, good: 0.008 };
const METER_MISS = 0.05, METER_WRONG = 0.02; // ~12 ardisik kacirma = sahne kaybi
// yildiz esikleri: kusursuz (boost'suz) puanin orani. 6 = altin yildizlar
export const STAR_STEPS = [0.08, 0.18, 0.3, 0.48, 0.7, 1.0];

export class Scoring {
  // opts: { maxScore: kusursuz puan (yildizlar), noFail: metre bitince oyun bitmez }
  constructor(notes, onEvent, laneCount, opts = {}) {
    this.notes = notes; // zamana gore sirali
    this.maxScore = opts.maxScore || 1;
    this.noFail = !!opts.noFail;
    this.meter = METER_START;
    this.failed = false;
    this.deltas = [];        // her isabetin zamanlama sapmasi (ms, + = gec)
    this.sectionStats = {};  // bolum -> { hit, miss, total }
    this.watchRolls = new Set(); // basladi/baslayabilir rulolar (bitiste degerlendirilir)
    const cnt = (f) => notes.filter(f).length;
    this.typeStats = {
      lift: { hit: 0, total: cnt(n => n.type === 'lift') },
      roll: { hit: 0, total: cnt(n => n.type === 'roll') },
      accent: { hit: 0, total: cnt(n => n.accent) }
    };
    this.onEvent = onEvent || (() => {});
    this.score = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.counts = { perfect: 0, great: 0, good: 0, miss: 0 };
    this.wrongHits = 0;      // bos serite (notasiz) basma
    this.mistakes = 0;       // miss + wrongHit (taç için: 0 ise kusursuz)
    this.boostHit = 0;       // temiz vurulan boost notasi sayisi
    this.boostTotal = notes.filter(n => n.boost).length;
    this.bars = 0;           // dolu boost bari (0..MAX_BARS)
    this.groupProgress = 0;  // aktif grubun ilerlemesi (0..1, HUD onizleme)
    this.boostActive = false;
    this.boostLeft = 0;
    this.maxBars = MAX_BARS;
    this.boostPerBar = BOOST_PER_BAR;
    this.boostCap = MAX_BARS * BOOST_PER_BAR; // HUD aktif-doluluk olcegi
    // boost grup takibi
    this.groupHits = {};     // gid -> temiz vurulan nota sayisi
    this.brokenGroups = new Set();
    this.activeGroupId = null;
    this.missPtr = 0;        // kacirma taramasi icin global isaretci
    this.activeHolds = new Set();

    // serit bazli bekleyen nota listeleri (gerçek serit sayısına göre boyutlanır;
    // notası olmayan seride basmak da "hatalı vuruş" sayılabilsin diye)
    const laneMax = Math.max(laneCount || 0, Math.max(...notes.map(n => n.lane), 0) + 1);
    this.lanes = Array.from({ length: laneMax }, () => []);
    notes.forEach((n, i) => {
      n.state = 'pending';
      n.holdAcc = 0;
      this.lanes[n.lane].push(i);
    });
    this.lanePtr = new Array(laneMax).fill(0);
    this.rollsByLane = Array.from({ length: laneMax }, () => []);
    for (const n of notes) if (n.type === 'roll') this.rollsByLane[n.lane].push(n);
  }

  get multiplier() {
    let m = 1;
    for (let i = 1; i < MULT_STEPS.length; i++) if (this.combo >= MULT_STEPS[i]) m = i + 1;
    return m;
  }
  get effMultiplier() { return this.multiplier * (this.boostActive ? 2 : 1); }
  get noMistakes() { return this.mistakes === 0; } // taç koşulu

  // bir sonraki carpana ilerleme 0..1 (HUD halkasi icin)
  get multProgress() {
    const m = this.multiplier;
    if (m >= 6) return 1;
    const lo = MULT_STEPS[m - 1], hi = MULT_STEPS[m];
    return (this.combo - lo) / (hi - lo);
  }

  // 0..6 (kesirli): yildiz ilerlemesi
  get stars() {
    const r = this.score / this.maxScore;
    let s = 0;
    for (let i = 0; i < STAR_STEPS.length; i++) {
      if (r >= STAR_STEPS[i]) s = i + 1;
      else { const lo = i ? STAR_STEPS[i - 1] : 0; s += (r - lo) / (STAR_STEPS[i] - lo); break; }
    }
    return Math.min(6, s);
  }

  _sec(n) {
    const k = n.section || 0;
    return this.sectionStats[k] || (this.sectionStats[k] = { hit: 0, miss: 0, total: 0, perfect: 0 });
  }

  _meter(d) {
    if (this.failed) return;
    this.meter = Math.max(0, Math.min(1, this.meter + d));
    this.onEvent('meter', { meter: this.meter });
    if (this.meter <= 0 && !this.noFail) {
      this.failed = true;
      this.onEvent('fail', {});
    }
  }

  judged() { return this.counts.perfect + this.counts.great + this.counts.good + this.counts.miss; }

  accuracy() {
    const j = this.judged();
    if (!j) return 100;
    const w = this.counts.perfect + this.counts.great * 0.66 + this.counts.good * 0.33;
    return (w / j) * 100;
  }

  grade() {
    const a = this.accuracy();
    if (this.counts.miss === 0 && a >= 97) return 'SS';
    if (a >= 95) return 'S';
    if (a >= 90) return 'A';
    if (a >= 80) return 'B';
    if (a >= 65) return 'C';
    return 'D';
  }

  _addScore(pts) {
    this.score += Math.round(pts);
    this.onEvent('score', { score: this.score });
  }

  _comboUp() {
    const prevMult = this.multiplier;
    this.combo++;
    if (this.combo > this.maxCombo) this.maxCombo = this.combo;
    if (this.multiplier > prevMult) this.onEvent('multiplierUp', { multiplier: this.multiplier });
    this.onEvent('combo', { combo: this.combo, multiplier: this.multiplier });
  }

  _comboBreak() {
    if (this.combo >= 8) this.onEvent('comboBreak', { combo: this.combo });
    this.combo = 0;
    this.onEvent('combo', { combo: 0, multiplier: this.multiplier });
  }

  // bir boost notasi temiz vuruldu (tap aninda, hold tamamlaninca)
  _boostNoteHit(n) {
    const gid = n.boostGroup;
    if (gid == null || this.brokenGroups.has(gid)) return;
    this.boostHit++;
    this.groupHits[gid] = (this.groupHits[gid] || 0) + 1;
    if (this.groupHits[gid] >= n.boostGroupSize) {
      // grup tamamlandi -> 1 bar
      this.activeGroupId = null;
      this.groupProgress = 0;
      if (this.boostActive) {
        // boost kullanilirken dolan bar aninda harcanir (boost uzar)
        this.boostLeft += BOOST_PER_BAR;
        this.onEvent('boostExtend', { boostLeft: this.boostLeft });
      } else {
        const was = this.bars;
        this.bars = Math.min(MAX_BARS, this.bars + 1);
        if (this.bars >= 1 && was < 1) this.onEvent('boostReady', {});
        if (this.bars >= MAX_BARS) this.onEvent('boostBarsFull', {});
      }
    } else {
      this.groupProgress = this.groupHits[gid] / n.boostGroupSize;
    }
    this.onEvent('boostCharge', { bars: this.bars, groupProgress: this.groupProgress });
  }

  // bir boost grubu bozuldu: kalan (henuz vurulmamis) beyaz notalar normale
  // doner ve boost vermez
  _breakBoostGroup(gid, reason) {
    if (gid == null || this.brokenGroups.has(gid)) return;
    this.brokenGroups.add(gid);
    if (this.activeGroupId === gid) { this.activeGroupId = null; this.groupProgress = 0; }
    const reverted = [];
    for (const n of this.notes) {
      if (n.boost && n.boostGroup === gid && n.state === 'pending') {
        n.boost = false;
        reverted.push(n.id);
      }
    }
    this.onEvent('boostGroupBroken', { gid, reverted, reason });
    this.onEvent('boostCharge', { bars: this.bars, groupProgress: this.groupProgress });
  }

  // aktive et: dolu barlarin TAMAMI harcanir, sure = bar sayisi * BOOST_PER_BAR
  activateBoost() {
    if (this.boostActive || this.bars < 1) return false;
    this.boostLeft = this.bars * BOOST_PER_BAR;
    this.bars = 0;
    this.boostActive = true;
    this.onEvent('boostStart', { boostLeft: this.boostLeft });
    return true;
  }

  // Serit vurusu: en yakin bekleyen notayi degerlendir.
  // manual=true: oyuncu o serite bizzat bastı; pencerede nota yoksa HATALI VURUŞ
  // (combo sıfırlanır). manual=false: boost taraması gibi otomatik (cezasız).
  hit(lane, t, manual = true, only = '', requireAtLine = false) {
    if (lane >= this.lanes.length) return null;
    // rulo bari uzerindeyken her basis bir rulo vurusudur (ceza yok)
    if (manual) {
      const r = this._rollAt(lane, t);
      if (r) { this._rollTick(r); return null; }
    }
    const idxs = this.lanes[lane];
    let ptr = this.lanePtr[lane];
    // tuketilmis notalari atla
    while (ptr < idxs.length && this.notes[idxs[ptr]].state !== 'pending') ptr++;
    this.lanePtr[lane] = ptr;

    let best = null, bestDt = Infinity;
    for (let i = ptr; i < idxs.length; i++) {
      const n = this.notes[idxs[i]];
      if (n.state !== 'pending') continue;
      if (n.type === 'lift' || n.type === 'roll') continue; // birakmada / rulo ile
      const dt = n.time - t;
      if (dt > WINDOWS.good) break; // cok ileride
      const adt = Math.abs(dt);
      if (adt <= WINDOWS.good && adt < bestDt) { best = n; bestDt = adt; }
    }
    if (!best) {
      // birak notasina yakin basis: oyuncu birakmaya hazirlaniyor (ceza yok)
      if (manual && this._liftNear(lane, t)) return null;
      if (manual) {
        this.wrongHits++;
        this.mistakes++;
        this._comboBreak();
        // aktif boost grubunda hatali calma -> grup bozulur
        if (this.activeGroupId != null) this._breakBoostGroup(this.activeGroupId, 'wrongHit');
        this._meter(-METER_WRONG);
        this.onEvent('wrongHit', { lane });
      }
      return null;
    }
    // only='hold': sadece HOLD notalarini degerlendir (boost otomatik baslatma).
    // only='tap':  sadece TAP notalarini degerlendir (boost aktivasyonunda).
    // requireAtLine: nota kafasi vurus cizgisine VARMADAN baslatma — boost'un
    //   otomatik basladigi uzun notalar tam cizgide ('Kusursuz') baslasin diye.
    if (only === 'hold' && best.type !== 'hold') return null;
    if (only === 'tap' && best.type === 'hold') return null;
    if (requireAtLine && best.time > t) return null;

    let judgment;
    if (bestDt <= WINDOWS.perfect) judgment = 'perfect';
    else if (bestDt <= WINDOWS.great) judgment = 'great';
    else judgment = 'good';

    if (best.type === 'hold') {
      // Hold baslar; ya fiziksel basili tutma ya da aktif boost onu sürdürür
      // (update() tik dongusune bak).
      best.state = 'holding';
      best.holdAcc = 0;
      best.holdLast = t;
      this.activeHolds.add(best);
    } else {
      best.state = 'hit';
    }
    return this._credit(best, judgment, t);
  }

  // Bir notanin isabetini isle (tap/hold-kafasi/lift/rulo ortak):
  // sayaclar, kombo, zamanlama, bolum, metre, boost kredisi, puan, olay.
  // t === null: zamanlama sapmasi kaydedilmez (rulo).
  _credit(n, judgment, t, extraPts = 0) {
    this.counts[judgment]++;
    this._comboUp();
    if (t !== null) this.deltas.push(Math.round((t - n.time) * 1000));
    const sec = this._sec(n);
    sec.hit++; sec.total++;
    if (judgment === 'perfect') sec.perfect++;
    this._meter(METER_GAIN[judgment]);

    // boost notasi: tap ise aninda kredi; hold ise tamamlaninca (_endHold).
    // grup zaten bozulduysa boost vermez.
    if (n.boost && !this.brokenGroups.has(n.boostGroup)) {
      this.activeGroupId = n.boostGroup;
      if (n.type !== 'hold') this._boostNoteHit(n);
    }

    const accented = n.accent && judgment !== 'good';
    if (accented) this.typeStats.accent.hit++;
    if (n.type === 'lift') this.typeStats.lift.hit++;
    if (n.type === 'roll') this.typeStats.roll.hit++;
    const base = n.type === 'roll' ? 0 : BASE_POINTS[judgment];
    const pts = (base * (accented ? 1 + ACCENT_BONUS : 1) + extraPts) * this.effMultiplier;
    this._addScore(pts);

    const res = { note: n, judgment, deltaMs: t === null ? 0 : Math.round((t - n.time) * 1000), score: Math.round(pts), accent: accented };
    this.onEvent('hit', res);
    return res;
  }

  _missNote(n) {
    n.state = 'missed';
    this.counts.miss++;
    this.mistakes++;
    this._comboBreak();
    const sec = this._sec(n);
    sec.miss++; sec.total++;
    this._meter(-METER_MISS);
    if (n.boost) this._breakBoostGroup(n.boostGroup, 'miss');
    this.onEvent('miss', { note: n });
  }

  // ---- birak (lift) notalari ----
  _liftNear(lane, t) {
    const idxs = this.lanes[lane];
    for (let i = this.lanePtr[lane]; i < idxs.length; i++) {
      const n = this.notes[idxs[i]];
      if (n.time - t > 0.4) break;
      if (n.type === 'lift' && n.state === 'pending' && Math.abs(n.time - t) <= 0.4) return n;
    }
    return null;
  }

  _liftJudge(lane, t) {
    if (lane >= this.lanes.length) return null;
    const idxs = this.lanes[lane];
    let best = null, bd = Infinity;
    for (let i = this.lanePtr[lane]; i < idxs.length; i++) {
      const n = this.notes[idxs[i]];
      if (n.time - t > WINDOWS.good) break;
      if (n.type !== 'lift' || n.state !== 'pending') continue;
      const d = Math.abs(n.time - t);
      if (d <= WINDOWS.good && d < bd) { best = n; bd = d; }
    }
    if (!best) return null;
    const judgment = bd <= WINDOWS.perfect ? 'perfect' : bd <= WINDOWS.great ? 'great' : 'good';
    best.state = 'hit';
    return this._credit(best, judgment, t);
  }

  // ---- rulo notalari ----
  _rollAt(lane, t) {
    for (const r of this.rollsByLane[lane] || []) {
      if ((r.state === 'pending' || r.state === 'rolling') && t >= r.time - WINDOWS.good && t <= r.time + r.dur + ROLL_END_PAD) return r;
    }
    return null;
  }

  _rollTick(r) {
    if (r.state === 'pending') { r.state = 'rolling'; r.presses = 0; this.watchRolls.add(r); }
    r.presses++;
    if (r.presses <= Math.ceil(r.need * 1.5)) this._addScore(ROLL_TICK * this.effMultiplier);
    this.onEvent('rollTick', { note: r, presses: r.presses, need: r.need });
  }

  // rulo bitti: yeterli basis -> Kusursuz (+bonus), %60+ -> Iyi, aksi halde kacti
  _resolveRoll(r) {
    const p = r.presses || 0;
    const judgment = p >= r.need ? 'perfect' : p >= Math.ceil(r.need * 0.6) ? 'good' : null;
    if (!judgment) { this._missNote(r); return; }
    r.state = 'hit';
    this._credit(r, judgment, null, judgment === 'perfect' ? ROLL_BONUS : 0);
  }

  // Boost aktivasyonunda: o an vurus penceresindeki TAP notalarini otomatik vur
  // (R2 ile ayni anda gelen tap notalari kacmasin). Hold notalari burada
  // islenmez — boost boyunca update()'teki otomatik baslatma onlari cizgiye
  // gelince baslatir ve sürdürür.
  hitAnyInWindow(t) {
    const results = [];
    for (let lane = 0; lane < this.lanes.length; lane++) {
      const r = this.hit(lane, t, false, 'tap');
      if (r) results.push(r);
    }
    return results;
  }

  // Serit birakildi: aktif hold'u bitir. Boost BUTONU basili tutulurken serit
  // birakmasi yok sayilir — boost uzun notayi senin yerine sürdürür. Boost
  // butonu birakilirsa (boostHeld=false) bu kosul dusumez, hold normal biter.
  release(lane, t, boostHeld) {
    if (!(this.boostActive && boostHeld)) {
      for (const n of this.activeHolds) {
        if (n.lane !== lane) continue;
        const end = n.time + n.dur;
        this._endHold(n, t >= end - 0.15);
        break;
      }
    }
    // birak notasi: serit birakildigi an degerlendirilir
    this._liftJudge(lane, t);
  }

  _endHold(n, completed) {
    n.state = 'done';
    this.activeHolds.delete(n);
    if (completed) this._addScore(HOLD_BONUS * this.effMultiplier);
    // boost hold notasi: tamamlandiysa grup kredisi, yarim kaldiysa grubu boz
    if (n.boost) {
      if (completed) this._boostNoteHit(n);
      else this._breakBoostGroup(n.boostGroup, 'holdIncomplete');
    }
    this.onEvent('holdDone', { note: n, completed });
  }

  // her kare cagrilir. boostHeld = boost butonu (R2/Bosluk) su an fiziksel basili mi
  update(t, heldLanes, dt, boostHeld) {
    // kacirilan notalar
    while (this.missPtr < this.notes.length && this.notes[this.missPtr].time + WINDOWS.good < t) {
      const n = this.notes[this.missPtr];
      if (n.type === 'roll') {
        // rulo gec baslanabilir: bitisinde degerlendirilir
        if (n.state === 'pending' || n.state === 'rolling') this.watchRolls.add(n);
      } else if (n.state === 'pending') {
        this._missNote(n);
      }
      this.missPtr++;
    }
    for (const r of this.watchRolls) {
      if (t > r.time + r.dur + ROLL_END_PAD) { this.watchRolls.delete(r); this._resolveRoll(r); }
    }

    // Boost uzun notalari senin yerine "basili tutar": boost aktifKEN ve boost
    // BUTONU basili tutulurken vurus cizgisine gelen her hold notasi (serit
    // fiziksel basili olmasa da) otomatik baslar. requireAtLine=true ile tam
    // cizgide ('Kusursuz') baslar. Tap notalari bundan etkilenmez. Boost butonu
    // birakilinca asagidaki tik dongusu sürdürmeyi keser, hold biter.
    if (this.boostActive && boostHeld) {
      for (let lane = 0; lane < this.lanes.length; lane++) {
        this.hit(lane, t, false, 'hold', true);
      }
    }

    // hold puan tiklari
    for (const n of Array.from(this.activeHolds)) {
      const end = n.time + n.dur;
      // serit fiziksel basili VEYA (boost aktif VE boost butonu basili) -> sürer.
      // Boost butonu birakilirsa boost sürdürmesi dusuverir; serit de basili
      // degilse hold biter.
      const sustained = heldLanes.has(n.lane) || (this.boostActive && boostHeld);
      if (!sustained) {
        this._endHold(n, t >= end - 0.15);
        continue;
      }
      const upTo = Math.min(t, end);
      n.holdAcc += Math.max(0, upTo - n.holdLast);
      n.holdLast = upTo;
      while (n.holdAcc >= HOLD_TICK_DT) {
        n.holdAcc -= HOLD_TICK_DT;
        this._addScore(HOLD_TICK_SCORE * this.effMultiplier);
        this.onEvent('holdTick', { note: n });
      }
      if (t >= end) this._endHold(n, true);
    }

    // boost tukenmesi
    if (this.boostActive) {
      this.boostLeft -= dt;
      this.onEvent('boostCharge', { bars: this.bars, groupProgress: this.groupProgress, boostLeft: this.boostLeft });
      if (this.boostLeft <= 0) {
        this.boostActive = false;
        this.boostLeft = 0;
        this.onEvent('boostEnd', {});
      }
    }
  }

  results() {
    return {
      score: this.score,
      accuracy: this.accuracy(),
      grade: this.grade(),
      maxCombo: this.maxCombo,
      counts: { ...this.counts },
      boostHit: this.boostHit,
      boostTotal: this.boostTotal,
      wrongHits: this.wrongHits,
      fullCombo: this.counts.miss === 0 && this.judged() > 0,
      stars: this.stars,
      typeStats: JSON.parse(JSON.stringify(this.typeStats)),
      failed: this.failed,
      deltas: this.deltas.slice(),
      sectionStats: { ...this.sectionStats },
      perfectRun: this.mistakes === 0 && this.judged() > 0 // taç: hiç hata yok
    };
  }
}
