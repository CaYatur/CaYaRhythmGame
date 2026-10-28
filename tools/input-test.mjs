// Kol girdisi + titresim cikisi dogrulamasi (headless). Calistir: node tools/input-test.mjs
import { readFileSync } from 'node:fs';
const load = async (p, patch = (s) => s) => import('data:text/javascript,' + encodeURIComponent(patch(readFileSync(new URL(p, import.meta.url), 'utf8'))));
globalThis.window = globalThis.window || { addEventListener() {} };
// Node 20'de global navigator yok (CI); Node 21+'da var ama getGamepads/hid yok
if (typeof navigator === 'undefined') globalThis.navigator = {};
const { Input } = await load('../public/js/game/input.js', (s) => s.replace(/import \{ t \} from '\.\.\/i18n\.js';/, 'const t = (k) => k;'));
const { DualSenseHID } = await load('../public/js/game/dualsense-hid.js');

let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const btn = (o = {}) => Object.assign({ square: false, cross: false, circle: false, triangle: false, dpadLeft: false, dpadRight: false, r2: false, options: false }, o);

function rig() {
  const ev = [];
  const inp = new Input({ onLane: (lane, down, when) => ev.push({ lane, down, when }), onBoost: () => ev.push({ boost: true }) });
  inp.setLaneCount(4);
  const hid = new DualSenseHID();
  hid.device = { opened: true, collections: [], sendReport: async () => {} };
  inp.setHid(hid);
  inp.setEnabled(true);
  // giris raporu: _parseInput yerine dogrudan ayrismis butonlarla
  const report = (b, ts) => { hid.buttons = b; hid.onButtons(b, ts); };
  return { ev, inp, hid, report };
}

console.log('A) HID: akor (iki tus ayni raporda) kare beklemeden, ayni zamanla');
{
  const { ev, inp, report } = rig();
  report(btn({ dpadRight: true, square: true }), 1234.5);
  const downs = ev.filter(e => e.down);
  ok(downs.length === 2 && downs.some(e => e.lane === 1) && downs.some(e => e.lane === 2), `iki serit basildi (${downs.map(e => e.lane)})`);
  ok(downs.every(e => e.when === 1234.5), 'ikisi de raporun zaman damgasiyla');
  report(btn({ dpadRight: true, square: true }), 1238.5);
  ok(ev.filter(e => e.down).length === 2, 'tekrar eden rapor ikinci basis uretmez');
  report(btn({ square: true }), 1300);
  ok(ev.some(e => e.lane === 1 && e.down === false && e.when === 1300), 'birakma da rapor zamaniyla');
  ok(inp.heldLanes.has(2) && !inp.heldLanes.has(1), 'basili seritler dogru');
  inp.setEnabled(false);
}

console.log('B) HID: boost (R2) basiliyken notalar etkilenmez');
{
  const { ev, inp, report } = rig();
  report(btn({ r2: true }), 10);
  report(btn({ r2: true, dpadLeft: true }), 20);
  report(btn({ r2: true, dpadLeft: true, circle: true }), 30);
  ok(ev.filter(e => e.boost).length === 1, 'boost bir kez tetiklendi');
  ok(ev.filter(e => e.down).length === 2 && inp.boostHeld, 'R2 basiliyken iki serit de algilandi');
  inp.setEnabled(false);
}

console.log('C) HID titresim: rapor kuyruklanmaz, en son deger kazanir');
{
  const hid = new DualSenseHID();
  const sent = [];
  let inFlight = 0, maxInFlight = 0;
  hid.device = { opened: true, collections: [], sendReport: async (id, buf) => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await wait(8); sent.push([buf[3], buf[2]]); inFlight--; } };
  for (let i = 0; i < 120; i++) { hid.setMotors(i, 255 - i); if (i % 10 === 0) await wait(1); }
  hid.setMotors(40, 50);
  await wait(200);
  ok(maxInFlight === 1, `ayni anda en fazla 1 rapor (${maxInFlight})`);
  ok(sent.length <= 12, `120 istek -> ${sent.length} rapor`);
  const last = sent[sent.length - 1];
  ok(last[0] === 40 && last[1] === 50, `son gonderilen = son istek (${last})`);
  const n = sent.length;
  hid.setMotors(40, 50); await wait(60);
  ok(sent.length === n, 'ayni deger tekrar gonderilmez');
}

console.log(`\nSonuc: ${pass} gecti, ${fail} kaldi`);
if (fail) process.exit(1);
