<div align="center">

<img src="assets/banner.svg" alt="CaYa Rhythm" width="100%" />

# CaYa Rhythm

**Bir şarkı bırak. Otomatik analiz edilsin. Neon 3D otoyolda çal.**

Herhangi bir ses dosyasını çalınabilir bir nota haritasına dönüştüren tarayıcı tabanlı ritim oyunu — elle haritalama yok, indirme yok. Saf JavaScript ve Three.js ile yazıldı.

[![Lisans: MIT](https://img.shields.io/badge/Lisans-MIT-ffc83d.svg)](LICENSE)
![Three.js](https://img.shields.io/badge/Three.js-WebGL-35c4f0.svg)
![Derleme yok](https://img.shields.io/badge/derleme-yok-59d96b.svg)

[English](README.md) · **Türkçe**

</div>

---

## ✨ Özellikler

- **Otomatik harita üretimi** — bir MP3 / WAV / OGG / M4A / FLAC bırak; bir Web Worker vuruşları, tempoyu, melodi konturunu ve vokali analiz edip nota haritası çıkarır. Elle haritalama yok.
- **Dört zorluk** — Kolay, Orta, Zor (4 şerit) ve Usta (5 şerit); her biri kendi yoğunluğu ve ızgara hizasıyla.
- **Dört mod** — Sadece Vokal, Melodi, Enstrümantal veya Karışık; aynı şarkı farklı oynanır.
- **3D neon otoyol** — bloom, beat'e tepki veren raylar, parçacıklar ve çarpan / boost sistemiyle Three.js.
- **Klavye & kol** — **WebHID** üzerinden tam DualSense desteği (Bluetooth dahil güvenilir titreşim), Gamepad-API yedeğiyle. Oyun içi tuş ipuçları, kullandığın girdiye göre klavye ↔ kol arasında otomatik değişir.
- **İki dilli arayüz** — İngilizce & Türkçe; tarayıcı diline göre otomatik algılanır ve anında değiştirilebilir.
- **Derleme adımı yok** — küçük, bağımlılıksız bir Node sunucusunun servis ettiği saf ES modülleri.

## 🖼️ Önizleme

> Önizleme görselleri İngilizce arayüzü gösterir.

<div align="center">

<img src="assets/preview-menu.svg" alt="Ana menü — şarkı, zorluk ve mod seçimi" width="49%" />
<img src="assets/preview-gameplay.svg" alt="Oynanış — HUD'lu 3D nota otoyolu" width="49%" />

</div>

## 🎮 Kontroller

| İşlem | Klavye | DualSense |
| --- | --- | --- |
| Şeritler (4) | `D` `F` `J` `K` | ◄ ► ▢ ◯ |
| Şeritler (5 · Usta) | `D` `F` `J` `K` `L` | ◄ ► ▢ △ ◯ |
| Boost | `Boşluk` | `R2` |
| Duraklat | `Esc` | `Options` |

Oyun sırasında tuş ipuçları her şeridin tam altında durur ve en son kullandığın girdiye göre klavye ile kol arasında otomatik geçer.

## 🚀 Başlangıç

> [Node.js](https://nodejs.org) 18+ gerekir. Derleme aracı veya paketleyici yok.

```bash
git clone https://github.com/CaYatur/CaYaRhythmGame.git
cd CaYaRhythmGame
npm install                 # Three.js'i kurar
npm run make-test-song      # dahili test şarkısını üretir (public/test-song.wav)
npm start                   # http://localhost:3000 üzerinde servis eder
```

Ardından <http://localhost:3000> adresini aç, bir şarkı bırak (veya **Dahili test şarkısını dene**'ye bas), zorluk ve mod seç ve **BAŞLA**'ya bas.

> **Kol titreşimi:** DualSense'i WebHID ile eşlemek için **Kolu seç & titreşimi test et**'e tıkla (Chrome / Edge). USB en güvenilirdir, ama Bluetooth da çalışır.

## 🧠 Nasıl çalışır?

Sesin cihazından çıkmaz — tüm boru hattı tarayıcıda çalışır:

1. Dosyayı **çöz & yeniden örnekle** (22.05 kHz), merkez (vokal) ve yan kanallara ayır.
2. **Web Worker'da analiz et** — spektral akı ile vuruş tespiti (SuperFlux tarzı), beat & tempo takibi, melodi / vokal perde konturu ve REPET tarzı vokal ayrıştırma.
3. **Haritayı kur** — olaylar tespit edilen vuruş ızgarasına yapıştırılır ve seçilen zorluk/moda göre şeritlere dağıtılır.
4. **Çiz & puanla** — Three.js otoyolu çizerken puanlama motoru dereceleri, komboyu, çarpanı ve boost sistemini yönetir.

## 🏆 Puanlama

- **Dereceler:** Kusursuz (±50 ms) / Harika (±105 ms) / İyi (±150 ms) / Kaçtı
- **Kombo çarpanı:** her 10 kombo = +1× → en fazla **6×**
- **Altın notalar ★:** Kusursuz vurmak **boost barını** doldurur
- **Boost (`R2` / `Boşluk`):** birkaç saniye çarpanı ikiye katlar (6× → 12×!)
- **Uzun notalar:** basılı tut, sürekli puan + tamamlama bonusu
- En iyi skorlar şarkı + zorluk + mod bazında kaydedilir (localStorage)

## 🛠️ Teknolojiler

- **JavaScript (ES modülleri)** — framework yok, derleme yok
- **[Three.js](https://threejs.org)** + 3D otoyol için EffectComposer / UnrealBloom
- Analiz boru hattı için **Web Audio API** + **Web Worker**
- DualSense titreşimi için **WebHID**, **Gamepad API** yedeğiyle
- **Node.js** — küçük bir statik dosya sunucusu (`server.js`), sıfır çalışma zamanı bağımlılığı

## 📁 Proje yapısı

```
public/
  index.html            arayüz iskeleti + SVG ikon kütüphanesi
  css/style.css         neon tema + HUD
  js/
    main.js             akış: menü → analiz → oyun → sonuç
    i18n.js             EN/TR metinler + yardımcılar
    audio/              analiz köprüsü + analiz Web Worker'ı
    game/               harita üretici, puanlama, girdi, DualSense HID, 3D motor, HUD
assets/                 logo, banner ve önizleme görselleri
server.js               küçük statik sunucu
```

## 📄 Lisans

[MIT](LICENSE) © 2026 [CaYaDev](https://cayadev.com)

---

<div align="center">

**CaYaDev** tarafından yapıldı · [cayadev.com](https://cayadev.com)

</div>
