// Nota turleri dogrulamasi (headless): birak (lift), rulo (roll), vurgu (accent)
// ve harita uretimi. Calistir: node tools/note-types-test.mjs
import { readFileSync } from 'node:fs';
const load = async (p) => import('data:text/javascript,' + encodeURIComponent(readFileSync(new URL(p, import.meta.url), 'utf8')));
const { Scoring } = await load('../public/js/game/scoring.js');
const { buildChart } = await load('../public/js/game/chart.js');

let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } };
const note = (o) => Object.assign({ id: 0, lane: 0, time: 1, dur: 0, type: 'tap', boost: false, s: 1 }, o);
const ids = (arr) => arr.map((n, i) => Object.assign(n, { id: i }));
function rec() { const ev = []; return { ev, fn: (t, d) => ev.push({ t, d }) }; }
function frames(sc, t0, t1, held = new Set(), dt = 1 / 60) {
  for (let t = t0; t <= t1 + 1e-9; t += dt) sc.update(+t.toFixed(5), held, dt, false);
}

console.log('A) Birak notasi: bas -> tut -> notada birak');
{
  const r = rec();
  const ns = ids([note({ time: 1 }), note({ time: 1.5, type: 'lift' })]);
  const sc = new Scoring(ns, r.fn, 4);
  frames(sc, 0.5, 0.99, new Set());
  sc.hit(0, 1.0);
  frames(sc, 1.0, 1.49, new Set([0]));
  sc.release(0, 1.51);
  frames(sc, 1.51, 2.0, new Set());
  ok(ns[1].state === 'hit', `lift vuruldu (state=${ns[1].state})`);
  ok(sc.counts.perfect === 2 && sc.counts.miss === 0, `iki kusursuz, kacan yok (${JSON.stringify(sc.counts)})`);
  ok(sc.typeStats.lift.hit === 1, 'lift istatistigi sayildi');
  ok(sc.combo === 2, `kombo 2 (${sc.combo})`);
}

console.log('B) Erken birakilan lift kacar; birakmadaki basis cezasiz');
{
  const r = rec();
  const ns = ids([note({ time: 1 }), note({ time: 1.5, type: 'lift' })]);
  const sc = new Scoring(ns, r.fn, 4);
  sc.hit(0, 1.0);
  sc.release(0, 1.1); // cok erken
  frames(sc, 1.1, 2.0, new Set());
  ok(ns[1].state === 'missed', 'erken birakma -> lift kacti');
  const ns2 = ids([note({ time: 1.5, type: 'lift' })]);
  const sc2 = new Scoring(ns2, rec().fn, 4);
  sc2.hit(0, 1.3); // lift'e hazirlanan basis
  ok(sc2.wrongHits === 0, 'lift oncesi basis hatali sayilmadi');
  sc2.release(0, 1.52);
  ok(ns2[0].state === 'hit', 'bas-birak ile lift vuruldu');
  // erken birakan oyuncu lift aninda YENIDEN basarsa da isabet
  const ns3 = ids([note({ time: 1 }), note({ time: 1.5, type: 'lift' })]);
  const sc3 = new Scoring(ns3, rec().fn, 4);
  sc3.hit(0, 1.0); sc3.release(0, 1.1);
  sc3.hit(0, 1.51);
  frames(sc3, 1.51, 2.0, new Set([0]));
  ok(ns3[1].state === 'hit' && sc3.wrongHits === 0, 'lift yeniden basarak da calinir (cezasiz)');
}

console.log('C) Rulo: yeterli basis = Kusursuz, az = Iyi, cok az = kacti');
for (const [presses, expect] of [[6, 'perfect'], [3, 'good'], [1, 'miss']]) {
  const ns = ids([note({ time: 2, dur: 1, type: 'roll', need: 5, lane: 1 })]);
  const sc = new Scoring(ns, rec().fn, 4);
  for (let k = 0; k < presses; k++) sc.hit(1, 2.05 + k * 0.15);
  frames(sc, 2.0, 3.3);
  const got = sc.counts.perfect ? 'perfect' : sc.counts.good ? 'good' : sc.counts.miss ? 'miss' : 'none';
  ok(got === expect, `${presses} basis -> ${got} (beklenen ${expect})`);
  ok(sc.wrongHits === 0, `  rulo basislari hatali sayilmadi`);
}

console.log('D) Vurgu notasi: Kusursuz = +%50 puan, Iyi = bonus yok');
{
  const sc = new Scoring(ids([note({ time: 1, accent: true })]), rec().fn, 4);
  sc.hit(0, 1.0);
  ok(sc.score === 150, `kusursuz vurgu 150 puan (${sc.score})`);
  const sc2 = new Scoring(ids([note({ time: 1, accent: true })]), rec().fn, 4);
  sc2.hit(0, 1.13);
  ok(sc2.score === 40, `iyi vurgu bonus almaz (${sc2.score})`);
}

console.log('E) Harita: rulo, birak, vurgu ve akor uretimi');
{
  const beats = Array.from({ length: 240 }, (_, i) => i * 0.5);
  const ev = { kick: [], snare: [], hat: [], bass: [], vocal: [], melody: [] };
  for (let i = 0; i < 120; i++) {
    ev.kick.push({ t: i, s: i % 4 === 0 ? 0.95 : 0.7 });
    ev.snare.push({ t: i + 0.5, s: 0.7 });
  }
  // 30. sn'de 16'lik trampet rulosu (1.2 sn)
  for (let k = 0; k < 10; k++) ev.snare.push({ t: 30 + k * 0.12, s: 0.8 });
  // melodik: kisa surdurulen notalar (birak adayi)
  for (let i = 0; i < 60; i++) ev.melody.push({ t: 40 + i * 1.0, s: 0.8, pitch: 60 + (i % 7), dur: 0.42 });
  for (const k in ev) ev[k].sort((a, b) => a.t - b.t);
  const analysis = { duration: 120, beats, beatPeriod: 0.5, events: ev, sections: [{ t: 0, end: 120, label: 'A', intensity: 0.5, kind: 'mid' }] };
  const drums = buildChart(analysis, 'hard', 'drums');
  ok(drums.stats.rolls >= 1, `davul haritasinda rulo var (${drums.stats.rolls})`);
  const roll = drums.notes.find(n => n.type === 'roll');
  ok(roll && roll.need >= 3 && roll.dur > 0.9, `rulo suresi/basis sayisi mantikli (dur=${roll && roll.dur.toFixed(2)}, need=${roll && roll.need})`);
  ok(drums.stats.accents > 0, `vurgu notalari var (${drums.stats.accents})`);
  const mel = buildChart(analysis, 'medium', 'melody');
  ok(mel.stats.lifts > 10, `melodi haritasinda birak notasi var (${mel.stats.lifts})`);
  const lift = mel.notes.find(n => n.type === 'lift');
  const head = lift && mel.notes.find(n => n.lane === lift.lane && n.time < lift.time && lift.time - n.time < 0.6);
  ok(!!head, 'her lift ayni seritte bir bas-notasindan sonra gelir');
  const easy = buildChart(analysis, 'easy', 'melody');
  ok(easy.stats.lifts === 0 && buildChart(analysis, 'easy', 'drums').stats.rolls === 0, 'kolay zorlukta lift/rulo yok');
  ok(mel.stats.maxScore > 0, 'kusursuz skor hesaplandi');

  console.log('F) Nota turu acma/kapama: yerine nota ya da bos');
  const sum = (c) => c.notes.length;
  const offAll = { hold: false, lift: false, roll: false, accent: false, chord: false };
  const dRep = buildChart(analysis, 'hard', 'drums', { types: offAll, offMode: 'replace' });
  ok(dRep.stats.rolls === 0 && dRep.stats.accents === 0 && dRep.stats.chords === 0, 'kapali turler haritada yok');
  ok(dRep.notes.some(n => n.time >= 30 && n.time <= 31.3), 'rulo yerine aralikli notalar kondu');
  const dEmpty = buildChart(analysis, 'hard', 'drums', { types: offAll, offMode: 'empty' });
  ok(!dEmpty.notes.some(n => n.time >= 30.05 && n.time <= 31.2), 'bos birak: rulo bolgesi bos');
  const mRep = buildChart(analysis, 'medium', 'melody', { types: { lift: false }, offMode: 'replace' });
  const mEmpty = buildChart(analysis, 'medium', 'melody', { types: { lift: false }, offMode: 'empty' });
  ok(mRep.stats.lifts === 0 && sum(mRep) === sum(mel), `lift -> normal nota, sayi ayni (${sum(mRep)}/${sum(mel)})`);
  ok(mEmpty.stats.lifts === 0 && sum(mEmpty) === sum(mel) - mel.stats.lifts, 'lift bos birakilinca yalniz liftler gitti');
  const hold = buildChart(analysis, 'medium', 'melody', { types: { hold: false, lift: false } });
  ok(hold.stats.holds === 0 && hold.stats.lifts === 0, 'uzun nota kapali');

  // Kolay: notalar vurus ustunde (indirgeme kurali)
  const ez = buildChart(analysis, 'easy', 'drums').notes;
  const onBeat = ez.filter(n => Math.abs(n.time / 0.5 - Math.round(n.time / 0.5)) < 0.05).length / ez.length;
  ok(onBeat > 0.9, `kolay davul notalarinin %${Math.round(onBeat * 100)}'i vurus ustunde`);
}

console.log('G) Tutarlilik: ayni muzik sarkinin farkli yerinde ayni harita');
{
  const beats = Array.from({ length: 400 }, (_, i) => i * 0.5);
  const ev = { kick: [], snare: [], hat: [], bass: [], vocal: [], melody: [] };
  // ayni 16 vuruslik pasaj 10. ve 70. saniyede; araya farkli dolgu
  const phrase = [60, 62, 64, 62, 67, 65, 64, 62, 60, 60, 64, 67, 69, 67, 64, 62];
  for (const t0 of [10, 70]) {
    phrase.forEach((p, k) => ev.melody.push({ t: t0 + k * 0.5, s: 0.85, pitch: p, dur: k % 4 === 3 ? 0.9 : 0 }));
    for (let k = 0; k < 16; k++) { ev.kick.push({ t: t0 + k * 0.5, s: 0.9 }); if (k % 2) ev.snare.push({ t: t0 + k * 0.5 + 0.25, s: 0.8 }); }
  }
  for (let t = 30; t < 60; t += 0.5) { ev.melody.push({ t, s: 0.8, pitch: 55 + Math.round((t * 7) % 12), dur: 0 }); ev.kick.push({ t, s: 0.8 }); }
  for (const k in ev) ev[k].sort((a, b) => a.t - b.t);
  const analysis = { duration: 200, beats, beatPeriod: 0.5, events: ev, sections: [{ t: 0, end: 200, label: 'A', intensity: 0.5, kind: 'mid' }] };
  for (const [mode, diff] of [['melody', 'hard'], ['drums', 'hard'], ['mixed', 'master']]) {
    const c = buildChart(analysis, diff, mode);
    const seq = (t0) => c.notes.filter(n => n.time >= t0 && n.time < t0 + 8).map(n => `${(n.time - t0).toFixed(2)}:${n.lane}:${n.type}`).join(' ');
    const a = seq(10), b = seq(70);
    ok(a.length > 0 && a === b, `${mode}/${diff}: iki pasaj ayni (${a.split(' ').length} nota)`);
  }
}

console.log(`\nSonuc: ${pass} gecti, ${fail} kaldi`);
if (fail) process.exit(1);
