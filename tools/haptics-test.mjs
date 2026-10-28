// Titresim karistiricisi dogrulamasi (headless). Calistir: node tools/haptics-test.mjs
import { readFileSync } from 'node:fs';
const { Haptics } = await import('data:text/javascript,' + encodeURIComponent(readFileSync(new URL('../public/js/game/haptics.js', import.meta.url), 'utf8')));

let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const rec = () => { const log = []; return { log, out: (s, w) => log.push([performance.now(), s, w]) }; };

console.log('A) Kusursuz isabet: kisa, yalniz yuksek frekans motoru, sonunda sifir');
{
  const r = rec(); const h = new Haptics(r.out); h.setStrength(1);
  h.play('perfect');
  await wait(120);
  const peakW = Math.max(...r.log.map(x => x[2])), peakS = Math.max(...r.log.map(x => x[1]));
  ok(peakW > 0.2 && peakW <= 0.31, `tik tepe ${peakW.toFixed(2)}`);
  ok(peakS === 0, 'dusuk frekans motoru calismadi');
  const last = r.log[r.log.length - 1];
  ok(last[1] === 0 && last[2] === 0, 'darbe sonunda motorlar sifir');
  ok(!h._timer, 'bosta zamanlayici durdu');
}

console.log('B) Uzun nota: basili tutulurken surekli hafif ugultu, birakinca biter');
{
  const r = rec(); const h = new Haptics(r.out); h.setStrength(1);
  h.setHolds(1); await wait(150);
  const mid = r.log[r.log.length - 1];
  ok(mid[2] > 0.08 && mid[2] < 0.2 && mid[1] === 0, `surdurme ugultusu w=${mid[2].toFixed(2)}`);
  h.setHolds(0); await wait(60);
  const end = r.log[r.log.length - 1];
  ok(end[1] === 0 && end[2] === 0, 'birakinca sustu');
  h.stop();
}

console.log('C) Boost: kesintisiz gumbur, vurusta kabarir');
{
  const r = rec(); const h = new Haptics(r.out); h.setStrength(1);
  let phase = 0; h.setBoost(() => phase);
  await wait(40); const onBeat = r.log[r.log.length - 1][1];
  phase = 0.6; await wait(40); const offBeat = r.log[r.log.length - 1][1];
  ok(onBeat > offBeat + 0.15, `vurusta ${onBeat.toFixed(2)} > vurus arasi ${offBeat.toFixed(2)}`);
  ok(offBeat >= 0.15, `vurus arasinda da gumbur suruyor (${offBeat.toFixed(2)})`);
  // bir tam vurus boyunca hicbir karede motorlar durmuyor
  const t0 = performance.now(); const from = r.log.length;
  while (performance.now() - t0 < 300) { phase = ((performance.now() - t0) / 300) % 1; await wait(10); }
  const frames = r.log.slice(from);
  ok(frames.length > 5 && frames.every(x => x[1] >= 0.15), `boost boyunca ${frames.length} karenin hepsi titresimli`);
  h.stop();
  ok(r.log[r.log.length - 1][1] === 0 && r.log[r.log.length - 1][2] === 0, 'stop() motorlari sifirladi');
}

console.log('E) Boost suruyor: her nota yatagin USTUNDE ayri hissedilir');
{
  const r = rec(); const h = new Haptics(r.out); h.setStrength(1);
  h.setBoost(() => 0.5); await wait(40);
  const bedW = r.log[r.log.length - 1][2];
  const from = r.log.length;
  h.hit({ type: 'tap' }, 'perfect'); await wait(30);
  const peakW = Math.max(...r.log.slice(from).map(x => x[2]));
  ok(peakW >= bedW + 0.3, `nota tepe ${peakW.toFixed(2)} >> yatak ${bedW.toFixed(2)}`);
  await wait(80);
  const after = r.log[r.log.length - 1];
  ok(after[1] >= 0.15 && Math.abs(after[2] - bedW) < 0.02, 'nota bitince yatak devam ediyor');
  // dusuk guc ayarinda bile yatak motoru dondurecek kadar
  h.setStrength(0.2); await wait(40);
  ok(r.log[r.log.length - 1][1] >= 0.1, `guc %20: yatak ${r.log[r.log.length - 1][1].toFixed(2)} hissedilir`);
  h.stop();
}

console.log('D) Guc ayari olcekler; 0 = titresim yok');
{
  const r = rec(); const h = new Haptics(r.out); h.setStrength(0.5);
  h.play('accent'); await wait(30);
  const peak = Math.max(...r.log.map(x => x[2]));
  ok(peak <= 0.26 && peak > 0.1, `%50 guc tepe ${peak.toFixed(2)}`);
  const r2 = rec(); const h2 = new Haptics(r2.out); h2.setStrength(0);
  h2.play('accent'); await wait(30);
  ok(r2.log.length === 0, 'guc 0 iken hic cikti yok');
  h.stop();
}

console.log(`\nSonuc: ${pass} gecti, ${fail} kaldi`);
if (fail) process.exit(1);
