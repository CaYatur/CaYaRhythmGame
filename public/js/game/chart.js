// CaYa Rhythm - Nota haritasi ureticisi (v4)
// Analiz olaylarini zorluk + enstruman parcasina gore notalara cevirir.
// Nota turleri:
//   tap    - normal nota
//   hold   - uzun nota (basili tut)
//   lift   - birak notasi: serit basiliyken TAM notada birakilir (kisa surdurulen
//            melodik notalarin bitisinden uretilir: bas -> tut -> birak)
//   roll   - rulo: bar boyunca hizlica tekrar tekrar bas (yogun trampet/hat
//            dizileri ya da ayni perdede hizli tekrarlar)
//   accent - (bayrak) guclu, vurusa denk gelen nota: Kusursuz/Harika = +%50 puan
//   chord  - (bayrak) ayni anda iki seritte nota; gorselde birbirine baglanir
//   - notalar DP vurus izlemeden gelen GERCEK vurus izgarasina yapistirilir
//   - bolge sistemi: bolge1 = serit 0-1 (yon tuslari), bolge2 = serit 2+ (simge tuslari)
//     her bolgede ayni anda en fazla 1 aktif nota; hold sirasinda bolge kilitli

// label/desc i18n anahtaridir; gosterim aninda t() ile cevrilir (bkz. main.js)
export const DIFFICULTIES = {
  easy: {
    labelKey: 'diff.easy', color: '#59d96b', lanes: 4,
    minGap: 0.42, maxNps: 2.4, chordChance: 0,
    strengthCut: 0.55, holdMin: 0.8, jackGap: 0.7, snapDiv: 2,
    lifts: 0, rolls: false, rollRate: 0
  },
  medium: {
    labelKey: 'diff.medium', color: '#ffc83d', lanes: 4,
    minGap: 0.26, maxNps: 4.2, chordChance: 0.10,
    strengthCut: 0.35, holdMin: 0.6, jackGap: 0.45, snapDiv: 2,
    lifts: 0.7, rolls: true, rollRate: 4
  },
  hard: {
    labelKey: 'diff.hard', color: '#ff5566', lanes: 4,
    minGap: 0.16, maxNps: 6.5, chordChance: 0.20,
    strengthCut: 0.16, holdMin: 0.5, jackGap: 0.28, snapDiv: 4,
    lifts: 0.85, rolls: true, rollRate: 5.5
  },
  master: {
    labelKey: 'diff.master', color: '#b57cff', lanes: 5,
    minGap: 0.115, maxNps: 9, chordChance: 0.28,
    strengthCut: 0.05, holdMin: 0.45, jackGap: 0.2, snapDiv: 4,
    lifts: 1, rolls: true, rollRate: 7
  }
};

// Enstruman parcalari. feedback: kacirinca miksin hangi kismi kisilir (mixer.js)
export const MODES = {
  vocal: { labelKey: 'mode.vocal', iconId: 'ico-mic', descKey: 'mode.vocal.desc', feedback: 'vocal', color: '#f0509b' },
  melody: { labelKey: 'mode.melody', iconId: 'ico-wave', descKey: 'mode.melody.desc', feedback: 'vocal', color: '#35c4f0' },
  bass: { labelKey: 'mode.bass', iconId: 'ico-bass', descKey: 'mode.bass.desc', feedback: 'bass', color: '#59d96b' },
  drums: { labelKey: 'mode.drums', iconId: 'ico-drum', descKey: 'mode.drums.desc', feedback: 'drums', color: '#ffc83d' },
  mixed: { labelKey: 'mode.mixed', iconId: 'ico-band', descKey: 'mode.mixed.desc', feedback: 'mix', color: '#b57cff' }
};
// eski kayitlar ('instrument' modu) -> yeni davul parcasi
export const LEGACY_MODES = { instrument: 'drums' };

// deterministik sozde-rastgele (ayni sarki ayni harita)
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const MELODIC = new Set(['vocal', 'melody', 'bass']);

// Nota zamanini gercek vurus izgarasina yapistir (DP vurus listesi uzerinden).
// div: vurus basina bolme (2 = 8'lik, 4 = 16'lik). Tolerans disindaysa dokunma.
function makeSnapper(beats, beatPeriod, div) {
  if (!beats || beats.length < 4) {
    return (t) => t; // izgara yoksa oldugu gibi birak
  }
  return (t) => {
    // ikili arama: t'yi saran vurus cifti
    let lo = 0, hi = beats.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (beats[mid] <= t) lo = mid; else hi = mid;
    }
    let b0 = beats[lo], b1 = beats[hi];
    if (t < beats[0]) { b1 = beats[0]; b0 = b1 - (beats[1] - beats[0]); }
    else if (t >= beats[beats.length - 1]) {
      b0 = beats[beats.length - 1];
      b1 = b0 + (b0 - beats[beats.length - 2]);
    }
    const period = Math.max(0.1, b1 - b0);
    const step = period / div;
    const k = Math.round((t - b0) / step);
    const g = b0 + k * step;
    const tol = Math.min(0.05, step * 0.35);
    return Math.abs(g - t) <= tol ? g : t;
  };
}

// opts: { lefty: seritleri aynala, range: [t0, t1] yalniz bu araliktaki notalar (pratik) }
export function buildChart(analysis, diffKey, modeKey, opts = {}) {
  modeKey = LEGACY_MODES[modeKey] || modeKey;
  const cfg = DIFFICULTIES[diffKey];
  const L = cfg.lanes;
  const ev = analysis.events;
  const rng = makeRng(Math.floor(analysis.duration * 1000) ^ (diffKey.length << 8) ^ modeKey.length);
  const snap = makeSnapper(analysis.beats, analysis.beatPeriod, cfg.snapDiv);

  // 1) Aday havuzu (mod filtresi)
  let pool = [];
  const push = (arr, type) => (arr || []).forEach(e =>
    pool.push({ t: snap(e.t), s: e.s, type, pitch: e.pitch || 0, dur: e.dur || 0 }));

  if (modeKey === 'vocal') {
    push(ev.vocal, 'vocal');
  } else if (modeKey === 'melody') {
    push(ev.melody, 'melody');
    if (pool.length < 16) push(ev.vocal, 'vocal');
  } else if (modeKey === 'bass') {
    push(ev.bass, 'bass');
  } else if (modeKey === 'drums') {
    push(ev.kick, 'kick'); push(ev.snare, 'snare'); push(ev.hat, 'hat');
  } else { // mixed: melodi omurga + yalnız GÜÇLÜ vuruşlar (hat yok) — daha az karmaşa
    push(ev.melody, 'melody');
    push(ev.kick, 'kick');
    push((ev.snare || []).filter(e => e.s >= 0.45), 'snare');
  }
  pool.sort((a, b) => a.t - b.t);

  // bolum yogunlugu (0..1): yogun bolumler daha dolu, sakin bolumler daha seyrek
  const sections = analysis.sections || [];
  const intensityAt = (t) => {
    if (!sections.length) return 0.5;
    let i = 0;
    while (i + 1 < sections.length && sections[i + 1].t <= t) i++;
    return sections[i].intensity != null ? sections[i].intensity : 0.5;
  };

  // 1b) RULO: ayni turde, aralari <=170 ms olan >=4 olaylik ve >=0.45 sn'lik
  // diziler tek bir rulo notasina doner (melodikte ayni perde +-1 sart).
  if (cfg.rolls) pool = detectRolls(pool);

  // melodik perde araligi (serit eslemesi icin yuzdelikler)
  const pitches = pool.filter(e => MELODIC.has(e.type) && e.pitch > 0).map(e => e.pitch).sort((a, b) => a - b);
  const pLo = pitches.length ? pitches[Math.floor(pitches.length * 0.08)] : 50;
  const pHi = pitches.length ? pitches[Math.floor(pitches.length * 0.92)] : 70;

  // 2) Guc esigi (melodik tipler hafif avantajli — melodi hissi korunur)
  pool = pool.filter(e => {
    if (e.roll) return true;
    const bonus = MELODIC.has(e.type) ? 0.12 : (e.type === 'kick' ? 0.06 : 0);
    const dyn = (intensityAt(e.t) - 0.5) * 0.14; // yogun bolumde esik duser
    return (e.s + bonus + dyn) >= cfg.strengthCut;
  });

  // 3) cakisma birlestirme (<40ms): akor adayi ya da gucluyu tut
  const merged = [];
  for (const e of pool) {
    const last = merged[merged.length - 1];
    if (last && e.t - last.t < 0.04) {
      if (e.roll || last.roll) { if (e.roll && !last.roll) merged[merged.length - 1] = e; continue; }
      if (cfg.chordChance > 0 && e.type !== last.type && !last.chordWith) {
        last.chordWith = e;
      } else if (e.s > last.s) {
        const cw = last.chordWith;
        merged[merged.length - 1] = e;
        if (cw && cw.type !== e.type) e.chordWith = cw;
      }
      continue;
    }
    merged.push(e);
  }

  // 4) minGap + NPS siniri (mixed mod biraz daha seyrek: çok katman karışmasın)
  const gapScale = modeKey === 'mixed' ? 1.3 : 1;
  const npsScale = modeKey === 'mixed' ? 0.8 : 1;
  const minGap = cfg.minGap * gapScale;
  const maxNps = cfg.maxNps * npsScale;
  const kept = [];
  const windowTimes = [];
  for (const e of merged) {
    const last = kept[kept.length - 1];
    const gap = minGap * (1.18 - 0.36 * intensityAt(e.t)); // yogun: 0.82x, sakin: 1.18x
    // rulo bitene kadar yeni nota yok
    if (last && last.roll && e.t < last.t + last.dur + gap) continue;
    if (last && e.t - last.t < gap) {
      if (e.roll || (!last.roll && e.s > last.s * 1.2)) kept[kept.length - 1] = e;
      continue;
    }
    while (windowTimes.length && e.t - windowTimes[0] > 2) windowTimes.shift();
    if (windowTimes.length >= maxNps * 2) continue;
    kept.push(e);
    windowTimes.push(e.t);
  }

  // 5) serit atama
  const lastLaneTime = new Array(L).fill(-99);
  let snareFlip = 0, hatFlip = 0;
  const laneOf = (e) => {
    let lane;
    switch (e.type) {
      case 'kick': lane = 0; break;
      case 'snare': lane = 1 + (snareFlip++ % 2); break;
      case 'hat': lane = L - 1 - (hatFlip++ % 2); break;
      case 'bass': case 'vocal': case 'melody': {
        if (e.pitch > 0 && pHi > pLo) {
          const p = Math.max(0, Math.min(1, (e.pitch - pLo) / (pHi - pLo)));
          lane = Math.round(p * (L - 1));
        } else {
          lane = Math.floor(rng() * L);
        }
        break;
      }
      default: lane = Math.floor(rng() * L);
    }
    return Math.max(0, Math.min(L - 1, lane));
  };

  const fixJack = (lane, t) => {
    if (t - lastLaneTime[lane] >= cfg.jackGap) return lane;
    let best = lane, bestAge = t - lastLaneTime[lane];
    for (const d of [-1, 1, -2, 2]) {
      const l2 = lane + d;
      if (l2 < 0 || l2 >= L) continue;
      const age = t - lastLaneTime[l2];
      if (age > bestAge) { best = l2; bestAge = age; }
    }
    return best;
  };

  // Bolge sistemi:
  //   Bolge 1 = serit 0,1  -> DualSense yon tuslari (sol/sag ok), klavyede D F
  //   Bolge 2 = serit 2..L-1 -> simge tuslari (kare/ucgen/yuvarlak), klavyede J K L
  //   Kurallar:
  //   - Bir bolgede ayni anda en fazla 1 aktif nota (toplam en fazla 2, bolge basina 1)
  //   - Bir bolgede hold (basili tutulan) nota varken o bolgeye yeni nota gelemez
  //   - Iki bolge de mesgulse nota atilir
  const TAP_BLOCK = 0.1;     // tap sonrasi bolgenin "es zamanli" sayildigi pencere
  const HOLD_RELEASE = 0.12; // hold bitince parmagin kalkma payi
  const zoneLanes = [[0, 1], []];
  for (let i = 2; i < L; i++) zoneLanes[1].push(i);
  const zoneBusyUntil = [-99, -99];

  const oldestLane = (lanes, t) => {
    let best = lanes[0], bestAge = -Infinity;
    for (const l of lanes) {
      const age = t - lastLaneTime[l];
      if (age > bestAge) { best = l; bestAge = age; }
    }
    return { lane: best, age: bestAge };
  };

  const notes = [];
  let id = 0;
  for (const e of kept) {
    let lane = fixJack(laneOf(e), e.t);
    let zone = lane <= 1 ? 0 : 1;
    if (e.t < zoneBusyUntil[zone]) {
      const other = 1 - zone;
      if (e.t < zoneBusyUntil[other]) continue; // iki bolge de mesgul: nota atilir
      zone = other;
      lane = oldestLane(zoneLanes[zone], e.t).lane;
    }

    // rulo: bar boyunca tekrar tekrar bas
    if (e.roll) {
      const dur = Math.min(e.dur, 3);
      lastLaneTime[lane] = e.t + dur;
      zoneBusyUntil[zone] = Math.max(zoneBusyUntil[zone], e.t + dur + HOLD_RELEASE);
      notes.push({ id: id++, time: e.t, lane, dur, type: 'roll', need: Math.max(3, Math.round(dur * cfg.rollRate)), boost: false, s: e.s });
      continue;
    }

    // uzun nota (hold) ya da bas-tut-birak (lift)
    let dur = 0, liftAt = 0;
    if (MELODIC.has(e.type) && e.dur > 0) {
      const end = snap(e.t + e.dur);
      // kisa surdurulen nota -> birak notasi; uzunlarin bir kismi da (cesitlilik)
      const shortSus = e.dur < cfg.holdMin;
      if (cfg.lifts > 0 && end - e.t >= 0.28 && e.dur <= 1.4 && (shortSus || rng() < 0.22) && rng() < cfg.lifts) {
        liftAt = end;
      } else if (e.dur >= cfg.holdMin) {
        dur = Math.min(e.dur, 6);
      }
    }

    const busyEnd = liftAt ? liftAt + TAP_BLOCK : e.t + (dur > 0 ? dur + HOLD_RELEASE : TAP_BLOCK);
    lastLaneTime[lane] = liftAt || e.t;
    zoneBusyUntil[zone] = Math.max(zoneBusyUntil[zone], busyEnd);
    notes.push({ id: id++, time: e.t, lane, dur, type: dur > 0 ? 'hold' : 'tap', boost: false, s: e.s });
    if (liftAt) notes.push({ id: id++, time: liftAt, lane, dur: 0, type: 'lift', boost: false, s: e.s });

    // akor: ikinci nota yalniz karsi bolge bossa eklenir (boylece her el 1 nota)
    if (e.chordWith && rng() < cfg.chordChance && e.s > 0.5) {
      const oz = 1 - zone;
      if (e.t >= zoneBusyUntil[oz]) {
        const c = oldestLane(zoneLanes[oz], e.t);
        if (c.age >= cfg.jackGap * 0.8) {
          lastLaneTime[c.lane] = e.t;
          zoneBusyUntil[oz] = Math.max(zoneBusyUntil[oz], e.t + TAP_BLOCK);
          notes.push({ id: id++, time: e.t, lane: c.lane, dur: 0, type: 'tap', boost: false, s: e.chordWith.s });
        }
      }
    }
  }

  // 6) uzun notalarin ayni seritteki bir sonraki notaya tasmasini engelle
  const byLane = new Map();
  for (const n of notes) {
    if (!byLane.has(n.lane)) byLane.set(n.lane, []);
    byLane.get(n.lane).push(n);
  }
  for (const arr of byLane.values()) {
    arr.sort((a, b) => a.time - b.time);
    for (let i = 0; i < arr.length - 1; i++) {
      const n = arr[i];
      if (n.dur > 0) {
        const maxDur = arr[i + 1].time - n.time - 0.18;
        if (maxDur < 0.35) { n.dur = 0; n.type = 'tap'; }
        else if (n.dur > maxDur) n.dur = maxDur;
      }
    }
  }

  // solak duzeni: seritleri aynala (zor pasajlar diger ele gecer)
  if (opts.lefty) for (const n of notes) n.lane = L - 1 - n.lane;

  // bolum etiketi (sonuc ekranindaki bolum bazli dogruluk icin)
  for (const n of notes) {
    let si = 0;
    while (si + 1 < sections.length && sections[si + 1].t <= n.time) si++;
    n.section = si;
  }

  // pratik: yalniz secili zaman araligi
  if (opts.range) {
    const [r0, r1] = opts.range;
    for (let i = notes.length - 1; i >= 0; i--) if (notes[i].time < r0 || notes[i].time > r1) notes.splice(i, 1);
  }

  notes.sort((a, b) => a.time - b.time || a.lane - b.lane);
  notes.forEach((n, i) => { n.id = i; });

  // akor gruplari (ayni zaman, farkli serit): gorselde baglanir
  for (let i = 0; i < notes.length; i++) {
    let j = i;
    while (j + 1 < notes.length && Math.abs(notes[j + 1].time - notes[i].time) < 0.002) j++;
    if (j > i) {
      for (let k = i; k <= j; k++) notes[k].chord = i;
      notes[i].chordLead = true;
      notes[i].chordLanes = [notes[i].lane, notes[j].lane];
    }
    i = j;
  }

  // vurgu (accent): en guclu %~10, vurus izgarasina denk gelen, aralarinda >=2.4 sn
  if (notes.length > 8) {
    const beats = analysis.beats || [];
    const onBeat = (t) => {
      let lo = 0, hi = beats.length - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (beats[m] < t) lo = m + 1; else hi = m; }
      return beats.length ? Math.min(Math.abs(beats[lo] - t), lo ? Math.abs(beats[lo - 1] - t) : 9) < 0.04 : true;
    };
    const cands = notes.filter(n => (n.type === 'tap' || n.type === 'lift') && n.chord == null && onBeat(n.time))
      .sort((a, b) => b.s - a.s);
    const maxAcc = Math.round(notes.length * 0.1);
    const picked = [];
    for (const n of cands) {
      if (picked.length >= maxAcc || n.s < 0.75) break;
      if (picked.some(p => Math.abs(p.time - n.time) < 2.4)) continue;
      n.accent = true;
      picked.push(n);
    }
  }

  // 7) BOOST notalari (beyaz): zaman ekseninde ardisik notalardan olusan gruplar.
  // Bir grubun TAMAMI temiz calinirsa +1 bar; gruptan biri kacirilir, hatali
  // calinir ya da hold tamamlanmazsa grubun KALANI normale doner (boost vermez).
  // Gruplar araliklarla serpistirilir; her grup tam olarak 1 bar doldurur.
  const GROUP_PERIOD = 14;  // ~her bu kadar sn'de bir yeni grup
  const GROUP_SIZE = 4;     // grup basina ardisik nota (en fazla)
  let boostGroups = 0;
  let nextGroupAt = Math.min(6, analysis.duration * 0.1);
  for (let i = 0; i < notes.length; i++) {
    if (notes[i].time < nextGroupAt) continue;
    const size = Math.min(GROUP_SIZE, notes.length - i);
    if (size < 2) break;
    for (let k = 0; k < size; k++) {
      const n = notes[i + k];
      n.boost = true;
      n.boostGroup = boostGroups;
      n.boostIndex = k;
      n.boostGroupSize = size;
    }
    boostGroups++;
    nextGroupAt = notes[i + size - 1].time + GROUP_PERIOD;
    i += size - 1;
  }

  const holds = notes.filter(n => n.type === 'hold').length;
  const lifts = notes.filter(n => n.type === 'lift').length;
  const rolls = notes.filter(n => n.type === 'roll').length;
  const accents = notes.filter(n => n.accent).length;
  const chords = notes.filter(n => n.chordLead).length;
  const boostNotes = notes.filter(n => n.boost).length;
  const span = notes.length > 1 ? (notes[notes.length - 1].time - notes[0].time) : 1;

  return {
    notes,
    laneCount: L,
    stats: {
      count: notes.length,
      holds,
      lifts,
      rolls,
      accents,
      chords,
      boostNotes,
      boostGroups,
      nps: notes.length > 1 ? +(notes.length / span).toFixed(1) : 0,
      lowVocal: modeKey === 'vocal' && notes.length < 30,
      maxScore: idealScore(notes)
    }
  };
}

// Kusursuz oyunun (boost'suz) puani: yildiz esikleri buna gore hesaplanir.
// scoring.js ile ayni kurallar: 100 * carpan (vurgu x1.5), carpan her 10 komboda
// +1 (6x'e kadar); hold: 0.1 sn basina 12 + 50 tamamlama; rulo: gereken basis
// sayisi kadar 20 + 60 tamamlama (hepsi * carpan).
export function idealScore(notes) {
  let s = 0;
  notes.forEach((n, i) => {
    const m = Math.min(6, 1 + Math.floor((i + 1) / 10));
    if (n.type === 'roll') { s += (n.need * 20 + 60) * m; return; }
    s += 100 * m * (n.accent ? 1.5 : 1);
    if (n.type === 'hold') s += (Math.floor(n.dur / 0.1) * 12 + 50) * m;
  });
  return s;
}

// Yogun ayni-tur dizilerini rulo olaylarina cevir.
// Davul: trampet/hat; melodik: ayni perdede (+-1) hizli tekrarlar.
function detectRolls(pool) {
  const out = [];
  const byType = new Map();
  for (const e of pool) {
    if (!byType.has(e.type)) byType.set(e.type, []);
    byType.get(e.type).push(e);
  }
  const used = new Set();
  for (const [type, arr] of byType) {
    if (type === 'kick' || arr.length < 8) continue;
    // rulo = cevresindeki akistan belirgin HIZLI bir patlama. Sabit 16'lik
    // hi-hat gibi surekli yogun groove rulo degildir: esik, bu turun medyan
    // araliginin %60'i (ve en fazla 170 ms); dizi en fazla 8 sn (3 sn'lik parcalar).
    const ivs = [];
    for (let k = 1; k < arr.length; k++) ivs.push(arr[k].t - arr[k - 1].t);
    ivs.sort((x, y) => x - y);
    const maxIv = Math.min(0.17, 0.6 * ivs[ivs.length >> 1]);
    let i = 0;
    while (i < arr.length) {
      let j = i;
      while (j + 1 < arr.length && arr[j + 1].t - arr[j].t <= maxIv &&
        (!MELODIC.has(type) || Math.abs((arr[j + 1].pitch || 0) - (arr[i].pitch || 0)) <= 1)) j++;
      const span = arr[j].t - arr[i].t;
      if (j - i + 1 >= 4 && span >= 0.45 && span <= 8) {
        // uzun build-up rulolari <=3 sn'lik parcalara bolunur
        let a = i;
        while (a < j) {
          let e = a;
          while (e + 1 <= j && arr[e + 1].t - arr[a].t <= 3) e++;
          const sp = arr[e].t - arr[a].t;
          if (e - a + 1 >= 4 && sp >= 0.45) {
            let smax = 0;
            for (let k = a; k <= e; k++) { used.add(arr[k]); smax = Math.max(smax, arr[k].s); }
            out.push({ t: arr[a].t, s: Math.max(smax, 0.6), type, pitch: arr[a].pitch || 0, dur: sp + 0.08, roll: true });
          }
          a = e + 1;
        }
      }
      i = j + 1;
    }
  }
  for (const e of pool) if (!used.has(e)) out.push(e);
  return out.sort((a, b) => a.t - b.t);
}
