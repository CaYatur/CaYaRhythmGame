// CaYa Rhythm - statik site paketi (GitHub Pages)
// public/ + assets/ + oyunun kullandigi three.js dosyalarini _site/ altina kopyalar.
// Tum yollar goreli oldugundan site herhangi bir alt dizinde (/CaYaRhythmGame/) calisir.
// Calistir: node tools/build-pages.mjs   (once: npm ci && npm run make-test-song)

import { cpSync, rmSync, mkdirSync, existsSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '_site');
const r = (...p) => path.join(ROOT, ...p);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// oyun kabugu (kullanicinin yerel test sarkilari haric)
cpSync(r('public'), OUT, {
  recursive: true,
  filter: (src) => !src.includes(`${path.sep}testsongs`)
});
cpSync(r('assets'), path.join(OUT, 'assets'), { recursive: true });

// three.js: yalniz import edilen dosyalar (importmap: ./node_modules/three/...)
const three = r('node_modules', 'three');
if (!existsSync(three)) throw new Error('node_modules/three yok — once "npm ci" calistirin');
const tOut = path.join(OUT, 'node_modules', 'three');
for (const f of ['three.module.js', 'three.core.js']) {
  mkdirSync(path.join(tOut, 'build'), { recursive: true });
  cpSync(path.join(three, 'build', f), path.join(tOut, 'build', f));
}
for (const d of ['postprocessing', 'shaders']) {
  cpSync(path.join(three, 'examples', 'jsm', d), path.join(tOut, 'examples', 'jsm', d), { recursive: true });
}
cpSync(path.join(three, 'LICENSE'), path.join(tOut, 'LICENSE'));

// Jekyll'i kapat (node_modules gibi klasorler atlanmasin)
writeFileSync(path.join(OUT, '.nojekyll'), '');

const size = (dir) => readdirSync(dir).reduce((a, f) => {
  const p = path.join(dir, f), s = statSync(p);
  return a + (s.isDirectory() ? size(p) : s.size);
}, 0);
console.log(`_site hazir: ${(size(OUT) / 1048576).toFixed(1)} MB` +
  (existsSync(path.join(OUT, 'test-song.wav')) ? '' : ' (uyari: test-song.wav yok — npm run make-test-song)'));
