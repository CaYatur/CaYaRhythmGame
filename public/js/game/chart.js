// CaYa Rhythm - Nota haritasi ureticisi (v2)
// Analiz olaylarini zorluk + moda gore notalara cevirir:
//   - notalar DP vurus izlemeden gelen GERCEK vurus izgarasina yapistirilir
//   - bolge sistemi: bolge1 = serit 0-1 (yon tuslari), bolge2 = serit 2+ (simge tuslari)
//     her bolgede ayni anda en fazla 1 aktif nota; hold sirasinda bolge kilitli

// label/desc i18n anahtaridir; gosterim aninda t() ile cevrilir (bkz. main.js)
export const DIFFICULTIES = {
  easy: {
    labelKey: 'diff.easy', color: '#59d96b', lanes: 4,
    minGap: 0.42, maxNps: 2.4, chordChance: 0,
    strengthCut: 0.55, holdMin: 0.8, jackGap: 0.7, snapDiv: 2
  },
  medium: {
    labelKey: 'diff.medium', color: '#ffc83d', lanes: 4,
    minGap: 0.26, maxNps: 4.2, chordChance: 0.10,
    strengthCut: 0.35, holdMin: 0.6, jackGap: 0.45, snapDiv: 2
  },
  hard: {
    labelKey: 'diff.hard', color: '#ff5566', lanes: 4,
    minGap: 0.16, maxNps: 6.5, chordChance: 0.20,
    strengthCut: 0.16, holdMin: 0.5, jackGap: 0.28, snapDiv: 4
  },
  master: {
    labelKey: 'diff.master', color: '#b57cff', lanes: 5,
    minGap: 0.115, maxNps: 9, chordChance: 0.28,
    strengthCut: 0.05, holdMin: 0.45, jackGap: 0.2, snapDiv: 4
  }
};

export const MODES = {
  vocal: { labelKey: 'mode.vocal', iconId: 'ico-mic', descKey: 'mode.vocal.desc' },
  melody: { labelKey: 'mode.melody', iconId: 'ico-wave', descKey: 'mode.melody.desc' },
  instrument: { labelKey: 'mode.instrument', iconId: 'ico-drum', descKey: 'mode.instrument.desc' },
  mixed: { labelKey: 'mode.mixed', iconId: 'ico-music', descKey: 'mode.mixed.desc' }
};

// deterministik sozde-rastgele (ayni sarki ayni harita)
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const MELODIC = new Set(['vocal', 'melody']);

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

export function buildChart(analysis, diffKey, modeKey) {
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
  } else if (modeKey === 'instrument') {
    push(ev.kick, 'kick'); push(ev.snare, 'snare'); push(ev.hat, 'hat'); push(ev.bass, 'bass');
  } else { // mixed: melodi omurga + yalnız GÜÇLÜ vuruşlar (hat yok) — daha az karmaşa
    push(ev.melody, 'melody');
    push(ev.kick, 'kick');
    push((ev.snare || []).filter(e => e.s >= 0.45), 'snare');
  }
  pool.sort((a, b) => a.t - b.t);

  // melodik perde araligi (serit eslemesi icin yuzdelikler)
  const pitches = pool.filter(e => MELODIC.has(e.type) && e.pitch > 0).map(e => e.pitch).sort((a, b) => a - b);
  const pLo = pitches.length ? pitches[Math.floor(pitches.length * 0.08)] : 50;
  const pHi = pitches.length ? pitches[Math.floor(pitches.length * 0.92)] : 70;

  // 2) Guc esigi (melodik tipler hafif avantajli — melodi hissi korunur)
  pool = pool.filter(e => {
    const bonus = MELODIC.has(e.type) ? 0.12 : (e.type === 'kick' ? 0.06 : 0);
    return (e.s + bonus) >= cfg.strengthCut;
  });

  // 3) cakisma birlestirme (<40ms): akor adayi ya da gucluyu tut
  const merged = [];
  for (const e of pool) {
    const last = merged[merged.length - 1];
    if (last && e.t - last.t < 0.04) {
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
    if (last && e.t - last.t < minGap) {
      if (e.s > last.s * 1.2) kept[kept.length - 1] = e;
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
      case 'kick': case 'bass': lane = 0; break;
      case 'snare': lane = 1 + (snareFlip++ % 2); break;
      case 'hat': lane = L - 1 - (hatFlip++ % 2); break;
      case 'vocal': case 'melody': {
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

    // uzun nota (hold)
    let dur = 0;
    if (e.dur >= cfg.holdMin && (MELODIC.has(e.type) || e.type === 'bass')) {
      dur = Math.min(e.dur, 6);
    }

    lastLaneTime[lane] = e.t;
    zoneBusyUntil[zone] = Math.max(zoneBusyUntil[zone], e.t + (dur > 0 ? dur + HOLD_RELEASE : TAP_BLOCK));
    notes.push({ id: id++, time: e.t, lane, dur, type: dur > 0 ? 'hold' : 'tap', boost: false, s: e.s });

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

  notes.sort((a, b) => a.time - b.time || a.lane - b.lane);
  notes.forEach((n, i) => { n.id = i; });

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
  const boostNotes = notes.filter(n => n.boost).length;
  const span = notes.length > 1 ? (notes[notes.length - 1].time - notes[0].time) : 1;

  return {
    notes,
    laneCount: L,
    stats: {
      count: notes.length,
      holds,
      boostNotes,
      boostGroups,
      nps: notes.length > 1 ? +(notes.length / span).toFixed(1) : 0,
      lowVocal: modeKey === 'vocal' && notes.length < 30
    }
  };
}
