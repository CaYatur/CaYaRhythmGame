<div align="center">

<img src="assets/banner.svg" alt="CaYa Rhythm" width="100%" />

# CaYa Rhythm

**Bir şarkı bırak. Otomatik analiz edilsin. Neon 3D sahnede çal.**

Herhangi bir ses dosyasını vokal, lead, bas, davul ya da tam grup için çalınabilir nota haritalarına dönüştüren tarayıcı tabanlı ritim oyunu. Elle haritalama yok, indirme yok. Saf JavaScript ve Three.js ile yazıldı.

### ▶ [Hemen GitHub Pages'te oyna](https://cayatur.github.io/CaYaRhythmGame/)

[![Lisans: MIT](https://img.shields.io/badge/Lisans-MIT-ffc83d.svg)](LICENSE)
![Three.js](https://img.shields.io/badge/Three.js-WebGL-35c4f0.svg)
![Derleme yok](https://img.shields.io/badge/derleme-yok-59d96b.svg)
[![Yayın](https://github.com/CaYatur/CaYaRhythmGame/actions/workflows/pages.yml/badge.svg)](https://github.com/CaYatur/CaYaRhythmGame/actions/workflows/pages.yml)

[English](README.md) · **Türkçe**

</div>

---

## ✨ Özellikler

### Oynanış
- **Beş enstrüman parçası.** **Vokal**, **Lead** (enstrümanlar: gitar, synth, piyano), **Bas** (şeritler bas perdesini izler), **Davul** (kick / trampet / zil) ve **Tam grup**. Her kartta nota sayısı ve yoğunluk göstergesi bulunur.
- **Dört zorluk.** Kolay, Orta, Zor (4 şerit) ve Usta (5 şerit). Nota yoğunluğu şarkıyı izler: yoğun bölümler daha dolu, sakin bölümler daha hafiftir.
- **Nota türleri.**
  - **Nota** ve **uzun nota** (basılı tut).
  - **Bırak** (ok): şeridi basılı tut ve ok çizgiye gelince bırak ya da çizgide yeniden bas. Kısa süren söylenen ya da çalınan notalardan üretilir.
  - **Rulo** (çizgili bar): bar boyunca hızlı hızlı bas. Trampet build-up'larından ve hızlı tekrarlardan üretilir.
  - **Vurgu** (halkalı): Kusursuz veya Harika'da +%50 puan.
  - **Akor:** birbirine bağlı, aynı anda basılan notalar.

  Sahne panelinde mevcut haritada her türden kaç tane olduğu ve nasıl çalınacağını anlatan ipuçları görünür. **Bir türe tıklayıp kapatabilirsin**; ardından yerine normal nota mı konacağını (uzun → kısa, rulo → aralıklı notalar, akor → tek nota) yoksa yerin boş mu kalacağını seçersin.
- **Ezberlenebilir haritalar.** Şerit seçimleri müziğin kendisinden (melodi konturu, ölçüdeki konum) gelir; tekrar eden nakarat her seferinde aynı çalınır. Kolay ve Orta güçlü vuruşlara oturur.
- **Parça geri bildirimi.** Kaçırdığında *senin* parçan miksten kısılır (vokal bandı, bas rafı ya da davul rafları); isabetlerle geri gelir.
- **Sahne metresi.** İsabetle dolar, kaçırmayla boşalır. Biterse sahneyi kaybedersin (**Kaybetme yok** açık değilse). Seyirci de buna göre coşar ya da kırmızıya döner.
- **Yıldızlar.** 5 yıldız ve altın yıldızlar; HUD'da canlı, sonuç ekranında özet olarak.
- **Pratik modu.** Tespit edilen herhangi bir bölümü seç ve %50–%100 hızda döngüde çal.
- **Boost.** Beyaz nota gruplarını temiz çalarak doldur, sonra çarpanı ikiye katla (12×'e kadar).
- **Sonuç analizi.** Gecikme önerisi veren erken/geç zamanlama histogramı ve şarkı bölümü bazında doğruluk.
- **Gecikme kalibrasyonu.** Tıklamalara eşlik et, oyun ofseti senin yerine ayarlasın.
- **Şarkı kütüphanesi.** Analiz edilen şarkılar tarayıcında (IndexedDB) saklanır ve yeniden analiz gerekmeden anında açılır.
- **Solak düzen**, ayarlanabilir nota hızı ve ses.

### Ses analizi (tamamı tarayıcıda, ML'siz)
- **Stereo merkez çıkarımı** (kanal-arası benzerlik) ve vokali yalıtmak için **REPET** ile eşlik ayrıştırma.
- **Yarım-ton altı perde takibi** (harmonik belirginlik, oktav düzeltmesi ve Viterbi).
- **İnsan sesi kapısı.** **Formant** izi, **mikro perde** hareketi (vibrato/jitter) ve **harmoniklik**, yalnızca vokale benzeyen synth lead ve pad'leri eler.
- **Davul.** SuperFlux vuruş tespiti; kick için **sönüm testi** (bas notalarını eler), trampet için **gürültülük testi** (tonal pluck'ları eler).
- **Enstrümanlar (Lead).** Stereo genişlikteki harmonik içerikte vuruş tespiti; vokal ortadayken gitar, synth ve piyano genelde yanlara yayılır.
- **Bas perdesi.** Ayrı bir düşük örnekleme oranlı harmonik toplam takibi (2.7 kHz, ~190 ms pencere), normal spektrumun 100 Hz altında ayıramadığı yarım tonları çözer.
- **Tempo ve vuruş ızgarası** (Ellis DP) ve **3:2 denetimi**: senkoplu şarkılar artık gerçek tempo yerine onun 2/3'üne kilitlenmez. Ayrıca **şarkı yapısı** (öz-benzerlik yeniliği, A/B/C… harfleri ve yoğunluk) ve enerji eğrisi.

### Görsel sunum
- **3D sahne.** Işık şeritli truss kemerleri, dönen spot ışıkları, canlı spektrumlu **LED duvar**, pompalayan hoparlör kuleleri ve vuruşa göre zıplayıp sahne metrene tepki veren seyirci.
- **Nota otoyolu.** Pahlı mücevher notalar, akan otoyol, vuruş ve ölçü çizgileri, bloom ve parçacıklar. Işıklar bölüm yoğunluğunu ve şarkının enerji eğrisini izler.
- **Klavye ve kol.** **WebHID** üzerinden tam DualSense desteği (Bluetooth dahil güvenilir titreşim), Gamepad-API yedeğiyle. Tuşlar **her kol raporu geldiği anda** ve raporun kendi zaman damgasıyla işlenir: akorlar birlikte algılanır, yoğun bir kare vuruşu geciktirmez.
- **Katmanlı titreşim.** İsabette net tıklar; vurgu, bırak ve rulo için ayrı desenler; uzun nota basılıyken hafif uğultu; ayarlanabilir güç. **Boost boyunca kesintisiz gümbür** (vuruşta kabarır) ve her vurduğun nota bunun üstünde ayrıca hissedilir. Boost başlangıcı ve bitişinin kendi desenleri var. Titreşim raporları kuyrukta birikmez, tuş girişini geciktiremez.
- **Açık görüş.** İsabet ve kombo yazıları otoyolun üstünde değil yanında durur. Erken basışta nota alanı üst kenarından, geç basışta alt kenarından parlar.
- **İki dilli arayüz.** İngilizce ve Türkçe; otomatik algılanır, anında değiştirilebilir.

## 🖼️ Önizleme

> Önizleme görselleri İngilizce arayüzü gösterir.

<div align="center">

<img src="assets/preview-menu.svg" alt="Ana menü — şarkı, parça ve zorluk seçimi" width="49%" />
<img src="assets/preview-gameplay.svg" alt="Oynanış — HUD'lu 3D nota otoyolu" width="49%" />

</div>

## 🎮 Kontroller

| Eylem | Klavye | DualSense |
| --- | --- | --- |
| Şeritler (4) | `D` `F` `J` `K` | ◄ ► ▢ ◯ |
| Şeritler (5 · Usta) | `D` `F` `J` `K` `L` | ◄ ► ▢ △ ◯ |
| Boost | `Boşluk` | `R2` |
| Duraklat | `Esc` | `Options` |

## 🚀 Başlarken

**En kolayı:** **<https://cayatur.github.io/CaYaRhythmGame/>** adresini aç. Kurulum yok ve ses dosyan bilgisayarından hiç çıkmaz.

Yerelde çalıştırmak için ([Node.js](https://nodejs.org) 18+ gerekir; derleme aracı yok):

```bash
git clone https://github.com/CaYatur/CaYaRhythmGame.git
cd CaYaRhythmGame
npm install                 # Three.js'i kurar
npm run make-test-song      # dahili test şarkısını üretir (public/test-song.wav)
npm start                   # http://localhost:3000 adresinde açılır
```

| Komut | Ne yapar |
| --- | --- |
| `npm test` | Puanlama ve nota türü testleri + hızlı analiz benchmark'ı |
| `npm run bench` | Tam analiz benchmark'ı (`public/testsongs/*.mp3` varsa gerçek şarkılar da eklenir; `ffmpeg` gerekir) |
| `npm run build:pages` | Statik siteyi `_site/` klasörüne paketler (GitHub Pages'in sunduğu paketin aynısı) |

**Yayın:** `main` dalına her push'ta `.github/workflows/pages.yml` çalışır. İş akışı testleri çalıştırır, test şarkısını üretir, `_site/` paketini oluşturur ve GitHub Pages'e yayımlar.

## 🧠 Nasıl çalışır

1. **Çöz ve yeniden örnekle:** 22.05 kHz stereo; ham sol/sağ kanallar bir Web Worker'a gider.
2. **Analiz et:** iki kanalda STFT, ardından merkez maskesi, HPSS, REPET, perde belirginliği ve Viterbi, ses özellikleri, davul ve bas vuruşları, vuruş takibi ve şarkı yapısı.
3. **Harita üret:** olaylar vuruş ızgarasına hizalanır ve parçaya ve zorluğa göre şeritlere dağıtılır. Her nota bölümüyle etiketlenir.
4. **Oyna:** sahneyi Three.js çizer; parça geri bildirimini ve pratik hızını Web Audio mikseri yönetir; isabet, çarpan, boost, sahne metresi ve yıldızları puanlama motoru hesaplar.

### Tahmin değil, ölçüm

`tools/analysis-bench.mjs`, **gerçek worker'ı** Node'da yer gerçeğine karşı çalıştırır. Test malzemesi, sentetik altlıklar ve gerçek şarkılar üzerine bindirilmiş sentetik bir şarkıcıdır (glottal kaynak, sesli harf formantları, vibrato/jitter, ünsüzler). Ayrıca vokal **sayılmaması** gereken tuzaklar da vardır: düz synth lead, vibratolu synth lead ve merkez pad. Worker'daki tüm eşikler bununla ayarlandı; hızlı benchmark eşiklerin altına düşerse `npm test` başarısız olur. Gerçek vokaller ayrık kanal (stem) olmadan puanlanamadığından, gerçek şarkı satırları bir yaklaşık ölçümdür.

| Ölçüt (v1 → v2) | v1 | v2 |
| --- | --- | --- |
| Vokal duyarlılığı, gerçek eşlik üzerinde sentetik şarkıcı | %65 | **%91** |
| Vokal perde doğruluğu (±1 yarım ton, aynı set) | %59 | **%73** |
| Vokal F1, sentetik | 0.53 | **0.84** |
| Synth lead / pad'de yanlış "vokal" | 23.8 / dk | **2.9 / dk** |
| Kick / trampet vuruş F1 | %61 / %28 | **%71 / %41** |

**Gerçek şarkılarda tüm parçalar.** `tools/make-stem-refs.py` gerçek şarkıları Demucs ile davul, bas, enstrüman ve vokale ayırır ve her temiz kanaldan referans olaylar çıkarır. `tools/stems-bench.mjs` oyunun tespitini **ve haritalarını** bunlara karşı ölçer. 18 şarkı var (pop, rap, R&B, EDM, phonk, rock): 8'i ayarda kullanıldı, 10'u ayrıldı ve yalnızca sonucu doğrulamak için kullanıldı. Tablo ayar / ayrılmış set olarak gösterir.

| Ölçüt | Önce | Şimdi |
| --- | --- | --- |
| Tempo doğru (yarım/çift kabul) | şarkıların %61'i | **%100** |
| Her bas notasında perde sınıfı | %27 / %29 | **%63 / %51** |
| Lead notalarının gerçek enstrüman vuruşuna denk gelmesi (Orta) | %81 / %80 | **%90 / %84** |
| Enstrüman vuruşlarının Lead haritasınca kapsanması (Usta) | %37 / %41 | **%56 / %55** |
| Davul notalarının gerçek davul vuruşuna denk gelmesi (Orta) | %79 / %75 | **%80 / %77** |
| Vokal notalarının duyulan vokale denk gelmesi (Orta) | %90 / %81 | **%89 / %81** |

**Vokalde** Demucs vokal kanalına karşı MIREX ölçütleriyle (`tools/realvocal-bench.mjs`): ham perde doğruluğu **%54 / %52**, genel doğruluk **%67 / %63**. Voicing yakalama **%69 / %68**, yanlış alarm **%18 / %28**. (Bu tablonun eski sürümleri daha düşük değerler gösteriyordu. Referans aracı, gerçek adım 9.977 ms iken 10 ms varsayıyordu; bu da referansları 90 saniyede 0.2 saniyeye kadar kaydırıyordu. Hata düzeltildi; yukarıdaki tüm değerler düzeltilmiş referanslarla ölçüldü.)

<details><summary>Eski vokal tablosu (kayık referanslarla)</summary>


| Ölçüt | Önce | Şimdi |
| --- | --- | --- |
| Ham perde doğruluğu (±1 yarım ton) | %35.1 | **%40.9** |
| Genel doğruluk (perde + sessizlik) | %52.5 | **%56.5** |
| Vokal yakalama / yanlış alarm | %58.7 / %28.7 | **%61.3 / %26.6** |

</details>

Demucs yalnızca geliştirme sırasında ölçüm aracı olarak kullanılır; oyunun kendisi ML'siz kalır ve tamamen tarayıcıda çalışır.

## 🏆 Puanlama

- **İsabet:** Kusursuz (±50 ms) / Harika (±105 ms) / İyi (±150 ms) / Kaçtı
- **Kombo çarpanı:** her 10 kombo = +1×, en fazla **6×**; **Boost** bunu ikiye katlar
- **Uzun notalar:** basılı tut; sürekli puan ve tamamlama bonusu
- **Yıldızlar:** kusursuz (boost'suz) oyuna göre; altın yıldız için kusursuza yakın skor gerekir
- En iyi skorlar şarkı + zorluk + parça başına kaydedilir (localStorage)

## 📁 Proje yapısı

```
public/
  index.html            arayüz kabuğu + SVG ikon kütüphanesi
  css/style.css         neon tema, menü, HUD, sonuçlar
  js/
    main.js             akış: kütüphane → sahne → oyun / pratik → sonuç
    i18n.js             TR/EN metinleri
    audio/              analiz worker'ı, köprü, oyun mikseri (parça geri bildirimi)
    game/               harita, puanlama, girdi, DualSense HID, 3D motor, HUD, kütüphane
tools/                  benchmark, sentetik test sinyalleri, test şarkısı, Pages paketleyici
.github/workflows/      GitHub Pages yayını
```

## 📄 Lisans

[MIT](LICENSE) © 2026 [CaYaDev](https://cayadev.com)

---

<div align="center">

**CaYaDev** tarafından · [cayadev.com](https://cayadev.com)

</div>
