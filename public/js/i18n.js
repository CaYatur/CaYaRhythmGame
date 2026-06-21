// CaYa Rhythm - i18n (TR / EN)
// Dil: kayitli tercih > tarayici dili > EN. Elle degistirilebilir (setLang).
// t(key, vars) ile metin alinir; statik HTML [data-i18n] / [data-i18n-html] ile doldurulur.

const STR = {
  tr: {
    'mast.sub': 'otomatik ritim çıkarıcı — sürükle, analiz et, çal',
    'panel.song': 'Şarkı',
    'panel.diff': 'Zorluk',
    'panel.mode': 'Mod',
    'panel.settings': 'Ayarlar',
    'dz.main': 'Dosyayı buraya sürükle<br>ya da <b>tıkla</b> ve seç',
    'btn.testSong': 'Dahili test şarkısını dene',
    'analysis.preparing': 'Hazırlanıyor',
    'set.speed': 'Nota hızı',
    'set.latency': 'Gecikme ayarı',
    'set.volume': 'Ses',
    'btn.rumbleTest': 'Kolu seç & titreşimi test et',
    'hiscore.title': 'En iyi skor',
    'btn.start': 'BAŞLA',
    'controls.keyboard': 'Klavye',
    'controls.controller': 'Kol',
    'controls.boost': 'Boost',
    'controls.pause': 'Duraklat',
    'kbd.space': 'Boşluk',
    'kbd.esc': 'Esc',
    'hud.mult': 'ÇARPAN',
    'hud.boost': 'BOOST',
    'hud.combo': 'KOMBO',
    'hud.ready': 'HAZIR',
    'hud.boostOn': 'BOOST!',
    'hud.go': 'BAŞLA!',
    'ctl.pause': 'DURAKLAT',
    'res.fullCombo': 'TAM KOMBO',
    'res.newRecord': 'YENİ REKOR!',
    'res.retry': 'Yeniden Oyna',
    'res.menu': 'Menü',
    'pause.title': 'Duraklatıldı',
    'pause.resume': 'Devam Et',
    'pause.restart': 'Yeniden Başlat',
    'pause.quit': 'Menüye Dön',

    // zorluk / mod
    'diff.easy': 'Kolay',
    'diff.medium': 'Orta',
    'diff.hard': 'Zor',
    'diff.master': 'Usta',
    'mode.vocal': 'Sadece Vokal',
    'mode.vocal.desc': 'Yalnız insan sesi — söylenen melodiyi çal',
    'mode.melody': 'Melodi',
    'mode.melody.desc': 'Baskın melodik hat (vokal veya lead enstrüman)',
    'mode.instrument': 'Enstrümantal',
    'mode.instrument.desc': 'Davul, bas ve ritim bölümü',
    'mode.mixed': 'Karışık',
    'mode.mixed.desc': 'Melodi + ritim — şarkının tamamı',

    // kartlar / meta
    'card.keys': '{n} tuş',
    'card.stats': '{count} nota · {nps} n/sn',
    'song.meta': '{min}:{sec} · {bpm} BPM · {n} olay tespit edildi',

    // istatistikler (sonuc)
    'stat.accuracy': 'Doğruluk',
    'stat.maxCombo': 'Maks. kombo',
    'stat.perfect': 'Kusursuz',
    'stat.great': 'Harika',
    'stat.good': 'İyi',
    'stat.miss': 'Kaçan',
    'stat.boost': 'Boost notası',

    // yargi (judgment)
    'judge.perfect': 'KUSURSUZ',
    'judge.great': 'HARİKA',
    'judge.good': 'İYİ',
    'judge.miss': 'KAÇTI',

    // kol durumu
    'pad.hid': '{name} bağlı · titreşim aktif (WebHID)',
    'pad.connected': '{name} bağlı · titreşim için "Kolu seç"e bas',
    'pad.none': 'Kol bağlı değil — kolda bir tuşa bas (USB önerilir)',

    // bildirimler (toast)
    'toast.analysisDone': 'Analiz tamamlandı — hazır!',
    'toast.analysisFail': 'Dosya analiz edilemedi: {msg}',
    'toast.testMissing': 'test-song.wav bulunamadı (npm run make-test-song çalıştırın)',
    'toast.noNotes': 'Bu mod için nota üretilemedi — başka mod deneyin',
    'toast.lowVocal': 'Bu şarkıda az insan vokali algılandı — Melodi modu daha dolu olabilir',
    'toast.boostReady': 'Boost hazır! {key}',
    'toast.boostFull': '4 bar dolu! {key} ile patlat',
    'toast.ctrlSelected': '{name} seçildi!',
    'toast.notSelected': 'Kol seçilmedi',
    'toast.rumbleFelt': 'Bzzt! Titreşimi hissettin mi?',
    'toast.rumbleGamepad': 'Bzzt! (Gamepad API)',
    'toast.connectFirst': 'Önce kolu USB ile bağla ya da kolda bir tuşa bas',
    'toast.dsConnected': '🎮 DualSense bağlandı!',
    'toast.padConnected': '🎮 Oyun kolu bağlandı: {id}',
    'toast.padDisconnected': '🎮 Oyun kolu bağlantısı kesildi',

    // analiz asamalari
    'stage.decoding': 'Ses dosyası çözülüyor',
    'stage.resampling': 'Yeniden örnekleniyor',
    'stage.spectrum': 'Spektrum ayrıştırılıyor',
    'stage.beats': 'Vuruşlar tespit ediliyor',
    'stage.melody': 'Melodi konturu izleniyor',
    'stage.vocal': 'Vokal ayrıştırılıyor (REPET)',
    'stage.tempo': 'Tempo ve vuruş ızgarası hesaplanıyor',
    'stage.done': 'Tamamlandı'
  },

  en: {
    'mast.sub': 'automatic rhythm extractor — drop, analyze, play',
    'panel.song': 'Song',
    'panel.diff': 'Difficulty',
    'panel.mode': 'Mode',
    'panel.settings': 'Settings',
    'dz.main': 'Drag a file here<br>or <b>click</b> to choose',
    'btn.testSong': 'Try the built-in test song',
    'analysis.preparing': 'Preparing',
    'set.speed': 'Note speed',
    'set.latency': 'Offset (latency)',
    'set.volume': 'Volume',
    'btn.rumbleTest': 'Select controller & test rumble',
    'hiscore.title': 'Best score',
    'btn.start': 'START',
    'controls.keyboard': 'Keyboard',
    'controls.controller': 'Controller',
    'controls.boost': 'Boost',
    'controls.pause': 'Pause',
    'kbd.space': 'Space',
    'kbd.esc': 'Esc',
    'hud.mult': 'MULTIPLIER',
    'hud.boost': 'BOOST',
    'hud.combo': 'COMBO',
    'hud.ready': 'READY',
    'hud.boostOn': 'BOOST!',
    'hud.go': 'GO!',
    'ctl.pause': 'PAUSE',
    'res.fullCombo': 'FULL COMBO',
    'res.newRecord': 'NEW RECORD!',
    'res.retry': 'Play Again',
    'res.menu': 'Menu',
    'pause.title': 'Paused',
    'pause.resume': 'Resume',
    'pause.restart': 'Restart',
    'pause.quit': 'Back to Menu',

    'diff.easy': 'Easy',
    'diff.medium': 'Medium',
    'diff.hard': 'Hard',
    'diff.master': 'Master',
    'mode.vocal': 'Vocals Only',
    'mode.vocal.desc': 'Human voice only — play the sung melody',
    'mode.melody': 'Melody',
    'mode.melody.desc': 'Dominant melodic line (vocals or lead instrument)',
    'mode.instrument': 'Instrumental',
    'mode.instrument.desc': 'Drums, bass and rhythm section',
    'mode.mixed': 'Mixed',
    'mode.mixed.desc': 'Melody + rhythm — the whole song',

    'card.keys': '{n} keys',
    'card.stats': '{count} notes · {nps} n/s',
    'song.meta': '{min}:{sec} · {bpm} BPM · {n} events detected',

    'stat.accuracy': 'Accuracy',
    'stat.maxCombo': 'Max combo',
    'stat.perfect': 'Perfect',
    'stat.great': 'Great',
    'stat.good': 'Good',
    'stat.miss': 'Missed',
    'stat.boost': 'Boost notes',

    'judge.perfect': 'PERFECT',
    'judge.great': 'GREAT',
    'judge.good': 'GOOD',
    'judge.miss': 'MISS',

    'pad.hid': '{name} connected · rumble active (WebHID)',
    'pad.connected': '{name} connected · press "Select controller" for rumble',
    'pad.none': 'No controller — press any button on it (USB recommended)',

    'toast.analysisDone': 'Analysis complete — ready!',
    'toast.analysisFail': 'Could not analyze file: {msg}',
    'toast.testMissing': 'test-song.wav not found (run npm run make-test-song)',
    'toast.noNotes': 'No notes for this mode — try another mode',
    'toast.lowVocal': 'Little human vocal detected — Melody mode may be fuller',
    'toast.boostReady': 'Boost ready! {key}',
    'toast.boostFull': '4 bars full! Fire with {key}',
    'toast.ctrlSelected': '{name} selected!',
    'toast.notSelected': 'No controller selected',
    'toast.rumbleFelt': 'Bzzt! Did you feel the rumble?',
    'toast.rumbleGamepad': 'Bzzt! (Gamepad API)',
    'toast.connectFirst': 'Connect a controller via USB first, or press a button on it',
    'toast.dsConnected': '🎮 DualSense connected!',
    'toast.padConnected': '🎮 Controller connected: {id}',
    'toast.padDisconnected': '🎮 Controller disconnected',

    'stage.decoding': 'Decoding audio',
    'stage.resampling': 'Resampling',
    'stage.spectrum': 'Analyzing spectrum',
    'stage.beats': 'Detecting beats',
    'stage.melody': 'Tracking melody contour',
    'stage.vocal': 'Separating vocals (REPET)',
    'stage.tempo': 'Computing tempo & beat grid',
    'stage.done': 'Done'
  }
};

function detect() {
  try {
    const saved = localStorage.getItem('caya-lang');
    if (saved === 'tr' || saved === 'en') return saved;
  } catch {}
  const nav = ((navigator.languages && navigator.languages[0]) || navigator.language || 'en').toLowerCase();
  return nav.startsWith('tr') ? 'tr' : 'en';
}

let lang = detect();

export function getLang() { return lang; }

export function setLang(l) {
  if (l !== 'tr' && l !== 'en') return;
  lang = l;
  try { localStorage.setItem('caya-lang', l); } catch {}
  document.documentElement.lang = l;
}

// sayi gruplama yereli (1.000 / 1,000)
export function numLocale() { return lang === 'tr' ? 'tr-TR' : 'en-US'; }

// yuzde bicimi: TR "%80", EN "80%"
export function pct(v) { return lang === 'tr' ? '%' + v : v + '%'; }

export function t(key, vars) {
  let s = (STR[lang] && STR[lang][key]) ?? STR.en[key] ?? key;
  if (vars) for (const k in vars) s = s.replaceAll('{' + k + '}', vars[k]);
  return s;
}

// Statik HTML'i doldur: [data-i18n] -> textContent, [data-i18n-html] -> innerHTML
export function applyStatic(root = document) {
  root.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.getAttribute('data-i18n')); });
  root.querySelectorAll('[data-i18n-html]').forEach(el => { el.innerHTML = t(el.getAttribute('data-i18n-html')); });
}
