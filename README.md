<div align="center">

<img src="assets/banner.svg" alt="CaYa Rhythm" width="100%" />

# CaYa Rhythm

**Drop any song. It gets analyzed automatically. Play it on a neon 3D stage.**

A browser rhythm game that turns any audio file into playable note charts for vocals, lead, bass, drums or the full band. No manual mapping: an AI model splits the song into vocals, drums, bass and instruments right in your browser, and each part gets its own chart. Built with vanilla JavaScript and Three.js.

### ▶ [Play it now on GitHub Pages](https://cayatur.github.io/CaYaRhythmGame/)

[![License: MIT](https://img.shields.io/badge/License-MIT-ffc83d.svg)](LICENSE)
![Three.js](https://img.shields.io/badge/Three.js-WebGL-35c4f0.svg)
![No build step](https://img.shields.io/badge/build-none-59d96b.svg)
[![Deploy](https://github.com/CaYatur/CaYaRhythmGame/actions/workflows/pages.yml/badge.svg)](https://github.com/CaYatur/CaYaRhythmGame/actions/workflows/pages.yml)

**English** · [Türkçe](README.tr.md)

</div>

---

## ✨ Features

### Gameplay
- **Five instrument parts.** **Vocals**, **Lead** (the instruments: guitar, synth, keys), **Bass** (lanes follow the bass pitch), **Drums** (kick / snare / cymbals) and **Full band**. Each card shows its note count and an intensity rating.
- **Four difficulties.** Easy, Medium, Hard (4 lanes) and Master (5 lanes). Note density follows the song: intense sections get busier, calm ones lighter.
- **Note types.**
  - **Note** and **sustain** (hold).
  - **Lift** (arrow): keep the lane held and release on the line, or press again on the line. Generated from short sung or played notes.
  - **Roll** (striped bar): tap rapidly for the whole bar. Generated from snare build-ups and fast repeats.
  - **Accent** (ringed): +50% points on Perfect or Great.
  - **Chords:** linked notes you press together.

  The stage panel shows how many of each type the current chart has, with a how-to tooltip for each. **Click a type to turn it off**, then choose whether a regular note takes its place (sustain → note, roll → spaced notes, chord → single note) or the spot stays empty.
- **Charts you can learn.** Lane choices come from the music itself (melodic contour, position in the bar), so a repeated chorus plays the same way every time. Easy and Medium lean on the strong beats.
- **Part feedback.** When you miss, *your* part drops out of the mix (vocal band, bass shelf or drum shelves), and it comes back as you hit again.
- **Stage meter.** Hits fill it and misses drain it. Run it empty and you lose the stage (unless **No fail** is on). The crowd cheers or turns red with it.
- **Stars.** Up to 5 stars plus gold stars, shown live in the HUD and on the results screen.
- **Practice mode.** Pick any detected section and loop it at 50–100% speed.
- **Boost.** Clear the white note groups to charge it, then double your multiplier (up to 12×).
- **Results breakdown.** An early/late timing histogram with a latency suggestion, plus accuracy per song section.
- **Latency calibration.** Tap along to a click track and the game sets the offset for you.
- **Song library.** Analyzed songs are stored in your browser (IndexedDB) and reopen instantly, with no re-analysis.
- **Lefty flip**, adjustable note speed and volume.

### Audio analysis (all in-browser)
- **AI stem separation.** With WebGPU, **HTDemucs** (Meta AI) splits the song into vocals, drums, bass and instruments before analysis, and every part is read from its own clean stem. Vocal notes come from a dedicated tracker on the vocal stem: FFT-based YIN pitch, syllable onsets, and a gate that drops vocals buried under the band. The model (~126 MB) downloads once and is cached; your audio never leaves the browser. Without WebGPU, or with the setting off, the classic analysis below runs instead.
- **Stereo center extraction** from inter-channel similarity, plus **REPET** background removal to isolate the vocal.
- **Sub-semitone pitch tracking** (harmonic salience, octave correction and Viterbi).
- **Human-voice gate.** A **formant** trace, **micro-pitch** motion (vibrato/jitter) and **harmonicity** reject synth leads and pads that only resemble vocals.
- **Drums.** SuperFlux onsets, with a kick **decay test** (rejects bass notes) and a snare **noisiness test** (rejects tonal plucks).
- **Instruments (Lead).** Onsets in the stereo-wide harmonic content, where guitars, synths and keys live while the vocal sits in the center.
- **Bass pitch.** A dedicated low-rate harmonic-sum tracker (2.7 kHz, ~190 ms window) resolves the semitones that a normal spectrum can't separate below 100 Hz.
- **Tempo & beat grid** (Ellis DP) with a **3:2 check**: syncopated songs no longer lock onto two-thirds of the real tempo. Plus **song structure** (self-similarity novelty, labeled A/B/C… with an intensity rating) and an energy curve.

### Presentation
- **3D stage.** Truss arches with light strips, sweeping spotlights, a live-spectrum **LED wall**, pumping speaker stacks, and a crowd that bounces to the beat and reacts to your stage meter.
- **Note highway.** Beveled gem notes, a scrolling highway, beat and measure lines, bloom and particles. Lighting follows section intensity and the song's energy curve.
- **Keyboard & controller.** Full DualSense support over **WebHID** (reliable rumble, including Bluetooth), with a Gamepad-API fallback. Button presses are read **as each controller report arrives** and timed with the report's own timestamp, so chords register together and a busy frame never delays a hit.
- **Layered haptics.** Crisp taps on hits, distinct patterns for accents, lifts and rolls, a low hum while you hold a sustain, and an adjustable strength. **Boost rumbles continuously** (swelling on the beat) and every note you hit still punches through on top. Boost start and end each have their own pattern. Rumble reports never queue up, so they can't delay button input.
- **Clear view.** Judgments and combo sit beside the highway, not on it. The receptors glow from the top edge when you're early and from the bottom edge when you're late.
- **Bilingual UI.** English and Turkish, auto-detected and switchable on the fly.

## 🖼️ Preview

<div align="center">

<img src="assets/preview-menu.svg" alt="Main menu — pick a song, part and difficulty" width="49%" />
<img src="assets/preview-gameplay.svg" alt="Gameplay — 3D note highway with HUD" width="49%" />

</div>

## 🎮 Controls

| Action | Keyboard | DualSense |
| --- | --- | --- |
| Lanes (4) | `D` `F` `J` `K` | ◄ ► ▢ ◯ |
| Lanes (5 · Master) | `D` `F` `J` `K` `L` | ◄ ► ▢ △ ◯ |
| Boost | `Space` | `R2` |
| Pause | `Esc` | `Options` |

## 🚀 Getting started

**Easiest:** open **<https://cayatur.github.io/CaYaRhythmGame/>**. Nothing to install, and your audio never leaves your machine.

To run it locally (requires [Node.js](https://nodejs.org) 18+; there are no build tools):

```bash
git clone https://github.com/CaYatur/CaYaRhythmGame.git
cd CaYaRhythmGame
npm install                 # installs Three.js
npm run make-test-song      # generates the built-in test track (public/test-song.wav)
npm start                   # serves on http://localhost:3000
```

| Script | What it does |
| --- | --- |
| `npm test` | Scoring and note-type tests + a quick analysis benchmark (mix and perfect-stem scenarios) |
| `npm run bench` | Full analysis benchmark (adds real songs from `public/testsongs/*.mp3` if present; needs `ffmpeg`) |
| `npm run build:pages` | Builds the static site into `_site/` (the same bundle that GitHub Pages serves) |

**Deployment:** every push to `main` runs `.github/workflows/pages.yml`. The workflow runs the tests, generates the test song, builds `_site/` and publishes it to GitHub Pages.

## 🧠 How it works

1. **Decode & resample** to 22.05 kHz stereo; the raw left/right channels go to a Web Worker.
2. **Separate (WebGPU).** A second worker runs HTDemucs with ONNX Runtime Web on 7.8 s segments. The model is a mixed-precision split into 21 pieces, so the page stays responsive. It runs at about 5× real time on a laptop GPU, so a 3½-minute song takes about 40 s. The stems are downmixed to 22.05 kHz mono and handed to the analysis worker.
3. **Analyze.** STFT on both channels, then a center mask, HPSS, REPET, pitch salience with Viterbi, voice features, drum and bass onsets, beat tracking and song structure.
4. **Build charts.** Events are snapped to the beat grid and spread across lanes per part and difficulty. Notes are tagged with their section.
5. **Play.** Three.js renders the stage, a Web Audio mixer handles part feedback and practice speed, and the scoring engine handles judgments, multiplier, boost, the stage meter and stars.

### Measured, not guessed

`tools/analysis-bench.mjs` runs the **real worker** headlessly against ground truth. The test material is a synthetic singer (glottal source, vowel formants, vibrato/jitter, consonants) mixed over synthetic beds and real songs, plus decoys that must **not** count as vocals: flat synth leads, vibrato synth leads and center pads. Every threshold in the worker was tuned on it, and `npm test` fails if the quick benchmark drops below its gates. Real vocals can't be scored without isolated stems, so treat the real-song rows as a proxy.

| Metric (v1 → v2) | v1 | v2 |
| --- | --- | --- |
| Vocal recall, synthetic singer over real backing tracks | 65% | **91%** |
| Vocal pitch accuracy (±1 semitone, same set) | 59% | **73%** |
| Vocal F1, synthetic | 0.53 | **0.84** |
| False "vocals" on synth leads / pads | 23.8 / min | **2.9 / min** |
| Kick / snare onset F1 | 61% / 28% | **71% / 41%** |

**Every part on real songs.** `tools/make-stem-refs.py` splits real songs into drums, bass, instruments and vocals with Demucs and extracts reference events from each clean stem. `tools/stems-bench.mjs` then scores the game's detection **and its charts** against them. There are 18 songs (pop, rap, R&B, EDM, phonk, rock): 8 were used for tuning, and 10 were held out and only used to check the result. The table shows tuning / held-out.

| Metric | Before | Now |
| --- | --- | --- |
| Tempo correct (half/double allowed) | 61% of songs | **100%** |
| Bass pitch class at each bass note | 27% / 29% | **63% / 51%** |
| Lead chart notes on a real instrument onset (Medium) | 81% / 80% | **90% / 84%** |
| Instrument onsets covered by the Lead chart (Master) | 37% / 41% | **56% / 55%** |
| Drum chart notes on a real drum hit (Medium) | 79% / 75% | **80% / 77%** |
| Vocal chart notes on audible vocals (Medium) | 90% / 81% | **89% / 81%** |

On **vocals**, scored with MIREX metrics against the Demucs vocal stem (`tools/realvocal-bench.mjs`): raw pitch accuracy is **54% / 52%** and overall accuracy is **67% / 63%**. Voicing recall is **69% / 68%**, with **18% / 28%** false alarms. (Earlier versions of this table reported lower numbers. The reference tool assumed a 10 ms hop when the real hop was 9.977 ms, which shifted the references by up to 0.2 s over 90 s. It is fixed, and every number above uses the corrected references.)

**AI stem separation, scored fairly.** The separation model's output can't be its own answer key, so these numbers use the **MUSDB18 test excerpts** (50 songs the model never trained on, with the real recorded stems) for references. Vocal frame metrics use **pYIN** on the true vocal stem, an algorithm the game does not use.

| Metric (MUSDB18 test) | Classic analysis | With AI separation |
| --- | --- | --- |
| Kick onset F1 | 46% | **75%** |
| Snare + cymbal onset F1 | 70% | **84%** |
| Bass onset F1 / pitch class | 49% / 68% | **67% / 76%** |
| Instrument (Lead) onset F1 | 63% | **75%** |
| Vocal pitch accuracy (±1 semitone) | 36% | **70%** |
| Vocal syllables found | 29% | **56%** |
| Master charts, notes on a real event (drums / bass / lead / vocals) | 82% / 63% / 77% / 85% | **95% / 84% / 80% / 91%** |

On **18 real songs** (pop, rap, R&B, EDM, phonk, rock; references from Demucs stems, vocals with pYIN): vocal pitch accuracy goes from **48% to 73%**, syllables found from **34% to 62%**, and Master vocal notes landing on a real syllable from **78% to 89%**. Songs without singing no longer get a vocal chart made of synths: across 31 full songs, instrumental tracks that used to get 159–599 "vocal" notes on Medium now get 2–58.

The tables above this one measure the classic analysis. It is what runs without WebGPU.

## 🏆 Scoring

- **Judgments:** Perfect (±50 ms) / Great (±105 ms) / Good (±150 ms) / Miss
- **Combo multiplier:** every 10 combo = +1×, up to **6×**; **Boost** doubles it
- **Hold notes:** keep pressed for continuous points plus a completion bonus
- **Stars:** relative to a perfect (no-boost) run; gold stars need a near-perfect score
- Best scores are saved per song + difficulty + part (localStorage)

## 📁 Project structure

```
public/
  index.html            UI shell + SVG icon library
  css/style.css         neon theme, menu, HUD, results
  js/
    main.js             app flow: library → stage → game / practice → results
    i18n.js             EN/TR strings
    audio/              AI separation worker, analysis worker, bridge, game mixer (part feedback)
    game/               charts, scoring, input, DualSense HID, 3D engine, HUD, library
tools/                  benchmark, synthetic test signals, test song, Pages builder
.github/workflows/      GitHub Pages deployment
```

## 📄 License

[MIT](LICENSE) © 2026 [CaYaDev](https://cayadev.com)

**Third-party (loaded at runtime, not bundled):**
- [HTDemucs](https://github.com/facebookresearch/demucs) by Alexandre Défossez et al., Meta AI (MIT).
- The browser ONNX export, [monteslu/htdemucs-web-onnx](https://huggingface.co/monteslu/htdemucs-web-onnx) (MIT), is fetched from Hugging Face at a pinned revision.
- [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) (MIT) is loaded from jsDelivr.

---

<div align="center">

Made by **CaYaDev** · [cayadev.com](https://cayadev.com)

</div>
