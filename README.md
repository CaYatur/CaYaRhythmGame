<div align="center">

<img src="assets/banner.svg" alt="CaYa Rhythm" width="100%" />

# CaYa Rhythm

**Drop any song. It gets analyzed automatically. Play it on a neon 3D highway.**

A browser rhythm game that turns any audio file into a playable note chart — no manual mapping, no downloads. Built with vanilla JavaScript and Three.js.

[![License: MIT](https://img.shields.io/badge/License-MIT-ffc83d.svg)](LICENSE)
![Three.js](https://img.shields.io/badge/Three.js-WebGL-35c4f0.svg)
![No build step](https://img.shields.io/badge/build-none-59d96b.svg)

**English** · [Türkçe](README.tr.md)

</div>

---

## ✨ Features

- **Automatic chart generation** — drop an MP3 / WAV / OGG / M4A / FLAC and a Web Worker analyzes onsets, beats, tempo, melody contour and vocals to build a note chart. No manual mapping.
- **Four difficulties** — Easy, Medium, Hard (4 lanes) and Master (5 lanes), each with its own density and snapping.
- **Four play modes** — Vocals Only, Melody, Instrumental, or Mixed, so the same song plays differently.
- **3D neon highway** — Three.js with bloom, beat-reactive rails, particles and a multiplier / boost system.
- **Keyboard & controller** — full DualSense support over **WebHID** (reliable rumble, including Bluetooth), with a Gamepad-API fallback. In-game key hints switch automatically between keyboard and controller as you play.
- **Bilingual UI** — English & Turkish, auto-detected from the browser language and switchable on the fly.
- **Zero build step** — plain ES modules served by a tiny dependency-free Node server.

## 🖼️ Preview

<div align="center">

<img src="assets/preview-menu.svg" alt="Main menu — pick a song, difficulty and mode" width="49%" />
<img src="assets/preview-gameplay.svg" alt="Gameplay — 3D note highway with HUD" width="49%" />

</div>

## 🎮 Controls

| Action | Keyboard | DualSense |
| --- | --- | --- |
| Lanes (4) | `D` `F` `J` `K` | ◄ ► ▢ ◯ |
| Lanes (5 · Master) | `D` `F` `J` `K` `L` | ◄ ► ▢ △ ◯ |
| Boost | `Space` | `R2` |
| Pause | `Esc` | `Options` |

During play, the on-screen key hints sit right under each lane and switch between keyboard and controller depending on what you last used.

## 🚀 Getting started

> Requires [Node.js](https://nodejs.org) 18+. No build tools, no bundler.

```bash
git clone https://github.com/CaYatur/CaYaRhythmGame.git
cd CaYaRhythmGame
npm install                 # installs Three.js
npm run make-test-song      # generates a built-in test track (public/test-song.wav)
npm start                   # serves on http://localhost:3000
```

Then open <http://localhost:3000>, drop a song (or hit **Try the built-in test song**), choose a difficulty and mode, and press **Start**.

> **Controller rumble:** click **Select controller & test rumble** to pair a DualSense via WebHID (Chrome / Edge). USB is the most reliable, but Bluetooth works too.

## 🧠 How it works

Your audio never leaves your machine — the whole pipeline runs in the browser:

1. **Decode & resample** the file to 22.05 kHz, splitting into center (vocals) and side channels.
2. **Analyze in a Web Worker** — spectral-flux onset detection (SuperFlux-style), beat & tempo tracking, melody / vocal pitch contour and a REPET-style vocal separation.
3. **Build the chart** — events are snapped to the detected beat grid and distributed across lanes per the chosen difficulty and mode.
4. **Render & score** — Three.js draws the highway while a scoring engine handles judgments, combo, multiplier and the boost system.

## 🏆 Scoring

- **Judgments:** Perfect (±50 ms) / Great (±105 ms) / Good (±150 ms) / Miss
- **Combo multiplier:** every 10 combo = +1× up to **6×**
- **Gold notes ★:** hitting them Perfect charges the **boost bar**
- **Boost (`R2` / `Space`):** doubles your multiplier for a few seconds (6× → 12×!)
- **Hold notes:** keep pressed for continuous points + a completion bonus
- Best scores are saved per song + difficulty + mode (localStorage)

## 🛠️ Tech stack

- **JavaScript (ES modules)** — no framework, no build step
- **[Three.js](https://threejs.org)** + EffectComposer / UnrealBloom for the 3D highway
- **Web Audio API** + **Web Workers** for the analysis pipeline
- **WebHID** for DualSense rumble, with a **Gamepad API** fallback
- **Node.js** — a tiny static file server (`server.js`), zero runtime dependencies

## 📁 Project structure

```
public/
  index.html            UI shell + SVG icon library
  css/style.css         neon theme + HUD
  js/
    main.js             app flow: menu → analysis → game → results
    i18n.js             EN/TR strings + helpers
    audio/              analyzer bridge + analysis Web Worker
    game/               chart builder, scoring, input, DualSense HID, 3D engine, HUD
assets/                 logo, banner and preview images
server.js               tiny static server
```

## 📄 License

[MIT](LICENSE) © 2026 [CaYaDev](https://cayadev.com)

---

<div align="center">

Made by **CaYaDev** · [cayadev.com](https://cayadev.com)

</div>
