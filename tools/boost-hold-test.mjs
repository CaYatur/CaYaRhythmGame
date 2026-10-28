// Boost + uzun nota mantigi dogrulamasi (headless). Calistir: node tools/boost-hold-test.mjs
// scoring.js tarayicida ESM (type="module") ama package.json type=commonjs; bu yuzden
// kaynagi data-URL ile ESM olarak yukluyoruz (gercek oyun dosyasinin aynisi).
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../public/js/game/scoring.js', import.meta.url), 'utf8');
const { Scoring } = await import('data:text/javascript,' + encodeURIComponent(src));

let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } };

const note = (o) => Object.assign({ id: 0, lane: 0, time: 1, dur: 0, type: 'tap', boost: false, s: 1 }, o);
function rec() { const ev = []; return { ev, fn: (t, d) => ev.push({ t, d }) }; }

// t0..t1 arasi kareleri sur. boostHeld = boost butonu basili mi
function frames(sc, t0, t1, held, boostHeld, dt = 1 / 60) {
  for (let t = t0; t <= t1 + 1e-9; t += dt) sc.update(+t.toFixed(5), held, dt, boostHeld);
}

// --- A: Boost aktif + boost BUTONU basili -> hold girdisiz otomatik oynanir ---
console.log('A) Boost aktif + buton basili: hold otomatik oynanir (girdi yok):');
{
  const r = rec();
  const sc = new Scoring([note({ id: 0, time: 1, dur: 2, type: 'hold', lane: 0 })], r.fn, 4);
  sc.bars = 1; sc.activateBoost();
  frames(sc, 0.5, 3.3, new Set(), true);           // boost butonu basili tutuluyor
  const head = sc.counts.perfect + sc.counts.great + sc.counts.good;
  const done = r.ev.find(e => e.t === 'holdDone');
  ok(head === 1, `kafa degerlendirildi (perfect=${sc.counts.perfect})`);
  ok(sc.counts.miss === 0, `kacan yok (miss=${sc.counts.miss})`);
  ok(done && done.d.completed === true, 'hold TAMAMLANDI (completed=true)');
  ok(sc.score > 0, `puan kazanildi (score=${sc.score})`);
}

// --- B: Boost yokken hold, girdi yoksa KACAR (regresyon yok) ---
console.log('B) Boost yokken hold, girdi yoksa kacar:');
{
  const r = rec();
  const sc = new Scoring([note({ id: 0, time: 1, dur: 2, type: 'hold', lane: 0 })], r.fn, 4);
  frames(sc, 0.5, 3.3, new Set(), false);
  ok(sc.counts.miss === 1, `hold kacti (miss=${sc.counts.miss})`);
}

// --- C: Boost aktivasyonunda tap otomatik vurulur (regresyon yok) ---
console.log('C) Boost aktivasyonunda tap otomatik vurulur:');
{
  const r = rec();
  const sc = new Scoring([note({ id: 0, time: 1, dur: 0, type: 'tap', lane: 2 })], r.fn, 4);
  sc.bars = 1; sc.activateBoost();
  sc.hitAnyInWindow(1.0);
  ok(sc.counts.perfect === 1, `tap kusursuz vuruldu (perfect=${sc.counts.perfect})`);
}

// --- D: Boost BUTONU basiliyken serit birakmasi yok sayilir, hold sürer ---
console.log('D) Boost butonu basiliyken serit birakma yok sayilir:');
{
  const r = rec();
  const sc = new Scoring([note({ id: 0, time: 1, dur: 2, type: 'hold', lane: 0 })], r.fn, 4);
  sc.bars = 1; sc.activateBoost();
  sc.hit(0, 1.0);                 // oyuncu elle baslatti
  sc.release(0, 1.4, true);      // erken birakti AMA boost butonu basili -> yok say
  ok(sc.activeHolds.size === 1, 'birakma yok sayildi (hold hala aktif)');
  frames(sc, 1.0, 3.3, new Set(), true);
  const done = r.ev.find(e => e.t === 'holdDone');
  ok(done && done.d.completed === true, 'hold yine de tamamlandi (boost sürdürdü)');
}

// --- E (DUZELTME): Boost BUTONU birakilinca hold biter (boost gucu aktif olsa bile) ---
console.log('E) Boost butonu birakilinca hold biter (gücü aktif olsa bile):');
{
  const r = rec();
  const sc = new Scoring([note({ id: 0, time: 1, dur: 3, type: 'hold', lane: 0 })], r.fn, 4);
  sc.bars = 1; sc.activateBoost();              // boostLeft=2.5, hold end=4
  frames(sc, 0.5, 2.0, new Set(), true);        // buton basili -> hold otomatik basladi
  ok(sc.activeHolds.size === 1 && sc.boostActive, 'buton basiliyken hold aktif, boost gücü hala acik');
  frames(sc, 2.0, 2.6, new Set(), false);       // BUTON BIRAKILDI (boost gücü hala aktif)
  const done = r.ev.find(e => e.t === 'holdDone');
  ok(sc.activeHolds.size === 0, 'buton birakilinca hold bitti');
  ok(done && done.d.completed === false, 'erken birakildi -> tamamlanmadi (yarim)');
  ok(sc.boostActive === true, 'boost GÜCÜ (x2) süresi dolmadigi icin acik kaldi');
}

// --- F: Boost gücü süresi dolunca tutulmayan hold takilmaz ---
console.log('F) Boost gücü bitince tutulmayan hold takilmaz:');
{
  const r = rec();
  const sc = new Scoring([note({ id: 0, time: 1, dur: 6, type: 'hold', lane: 0 })], r.fn, 4);
  sc.bars = 1; sc.activateBoost();              // boostLeft=2.5, hold end=7
  frames(sc, 0.5, 7.5, new Set(), true);        // buton basili ama güç ~3.0'te biter
  const boostEnd = r.ev.find(e => e.t === 'boostEnd');
  ok(!!boostEnd, 'boost gücü bitti (boostEnd)');
  ok(sc.activeHolds.size === 0, 'hold takilmadi (aktif hold kalmadi)');
}

console.log(`\nSonuc: ${pass} gecti, ${fail} kaldi`);
process.exit(fail ? 1 : 0);
