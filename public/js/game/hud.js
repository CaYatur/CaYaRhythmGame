// CaYa Rhythm - HUD (DOM tabanli oyun ici gosterge)

import { t, numLocale, pct } from '../i18n.js';

export class Hud {
  constructor() {
    this.el = {
      score: document.getElementById('hud-score'),
      combo: document.getElementById('hud-combo'),
      comboWrap: document.getElementById('hud-combo-wrap'),
      judgment: document.getElementById('hud-judgment'),
      mult: document.getElementById('hud-mult'),
      multRing: document.getElementById('hud-mult-ring'),
      multWrap: document.getElementById('hud-mult-wrap'),
      boostSegs: Array.from(document.querySelectorAll('#hud-boost-bar .boost-seg'))
        .map(seg => ({ seg, fill: seg.querySelector('i') })),
      boostWrap: document.getElementById('hud-boost'),
      boostHint: document.getElementById('hud-boost-hint'),
      progress: document.getElementById('hud-progress-fill'),
      song: document.getElementById('hud-song'),
      countdown: document.getElementById('hud-countdown'),
      acc: document.getElementById('hud-acc'),
      flash: document.getElementById('hud-flash'),
      meter: document.getElementById('hud-meter'),
      meterFill: document.getElementById('hud-meter-fill'),
      danger: document.getElementById('hud-danger'),
      stars: document.getElementById('hud-stars'),
      section: document.getElementById('hud-section'),
      delta: document.getElementById('hud-delta'),
      progSecs: document.getElementById('hud-progress-secs'),
      practice: document.getElementById('hud-practice'),
      milestone: document.getElementById('hud-milestone')
    };
    this._judgeTimer = null;
    this._deltaTimer = null;
    // 5 yildiz: arka plan + kirpilan on plan (kesirli dolum)
    this.el.stars.innerHTML = Array.from({ length: 5 }, () =>
      '<span class="st"><svg class="ico bg"><use href="#ico-star" /></svg><svg class="ico fg"><use href="#ico-star" /></svg></span>').join('');
    this._starEls = Array.from(this.el.stars.querySelectorAll('.fg'));
    this._lastStars = -1;
  }

  reset(songLabel, opts = {}) {
    this.setMeter(0.6);
    this.setStars(0);
    this.el.practice.hidden = !opts.practice;
    this.el.section.classList.remove('show');
    this.el.delta.className = 'hud-delta';
    // ilerleme cubugunda bolum sinirlari (yogunluga gore renk)
    const secs = opts.sections || [], dur = opts.duration || 1;
    this.el.progSecs.innerHTML = secs.map(s => {
      const w = Math.max(0, (s.end - s.t) / dur * 100);
      return `<i style="width:${w.toFixed(3)}%;background:${sectionColor(s)}"></i>`;
    }).join('');
    this.setScore(0);
    this.setCombo(0, 1);
    this.setMult(1, 0, false, false);
    this.setBoost(0, 0, false, 0);
    this.setProgress(0);
    this.setAcc(100);
    this.el.song.textContent = songLabel;
    this.el.judgment.className = 'judgment';
    this.el.judgment.textContent = '';
    this.el.countdown.textContent = '';
    this.el.countdown.classList.remove('show');
  }

  setScore(v) {
    this.el.score.textContent = v.toLocaleString(numLocale());
  }

  setAcc(acc) {
    this.el.acc.textContent = pct(acc.toFixed(1));
  }

  setCombo(combo) {
    this.el.combo.textContent = combo;
    this.el.comboWrap.classList.toggle('active', combo >= 5);
    if (combo > 0) {
      this.el.combo.classList.remove('pop');
      void this.el.combo.offsetWidth; // animasyonu yeniden tetikle
      this.el.combo.classList.add('pop');
    }
  }

  judgment(j, boost) {
    const el = this.el.judgment;
    const star = (boost && j !== 'miss') ? ' <svg class="ico"><use href="#ico-star" /></svg>' : '';
    el.innerHTML = t('judge.' + j) + star;
    el.className = 'judgment show j-' + j + (boost ? ' j-gold' : '');
    void el.offsetWidth;
    el.classList.add('anim');
    clearTimeout(this._judgeTimer);
    this._judgeTimer = setTimeout(() => el.classList.remove('show'), 450);
  }

  setMult(mult, progress, boostActive, crowned) {
    this.el.mult.textContent = 'x' + (boostActive ? mult * 2 : mult);
    this.el.mult.classList.toggle('boosted', !!boostActive);
    const deg = Math.round(progress * 360);
    this.el.multRing.style.background =
      `conic-gradient(var(--accent) ${deg}deg, rgba(255,255,255,0.08) ${deg}deg)`;
    if (crowned !== undefined) this.el.multWrap.classList.toggle('crowned', !!crowned);
  }

  setCrown(on) { this.el.multWrap.classList.toggle('crowned', !!on); }

  // bars: dolu bar sayisi (0..4); groupProgress: aktif grup ilerlemesi (0..1);
  // active: boost aktif mi; frac: aktifken kalan sure orani (0..1)
  setBoost(bars, groupProgress, active, frac = 0) {
    const segs = this.el.boostSegs;
    const n = segs.length || 1;
    for (let i = 0; i < segs.length; i++) {
      let h = 0, full = false;
      if (active) {
        // kalan sure tum segmentlere yayilir; alttan uste dogru bosalir
        const sf = Math.min(1, Math.max(0, frac * n - i));
        h = sf * 100; full = sf >= 0.999;
      } else if (i < bars) {
        h = 100; full = true;
      } else if (i === bars) {
        h = Math.max(0, Math.min(1, groupProgress)) * 100;
      }
      segs[i].fill.style.height = h.toFixed(1) + '%';
      segs[i].seg.classList.toggle('full', full);
    }
    this.el.boostWrap.classList.toggle('ready', bars >= 1 && !active);
    this.el.boostWrap.classList.toggle('active', active);
    this.el.boostHint.textContent = active ? t('hud.boostOn') : (bars >= 1 ? `${t('hud.ready')} · ${bars}` : t('hud.boost'));
  }

  boostFlash() {
    const f = this.el.flash;
    f.classList.remove('go');
    void f.offsetWidth;
    f.classList.add('go');
  }

  shakeBoostBar() {
    this.el.boostWrap.classList.remove('deny');
    void this.el.boostWrap.offsetWidth;
    this.el.boostWrap.classList.add('deny');
  }

  // sahne metresi 0..1; dusukken kirmizi uyari cercevesi
  setMeter(m) {
    this.el.meterFill.style.height = (m * 100).toFixed(1) + '%';
    this.el.meter.style.setProperty('--m', m.toFixed(3));
    this.el.danger.classList.toggle('on', m < 0.22);
  }

  // yildiz 0..6 (6 = altin)
  setStars(v) {
    const q = Math.floor(v * 20) / 20;
    if (q === this._lastStars) return;
    this._lastStars = q;
    const gold = v >= 6;
    this.el.stars.classList.toggle('gold', gold);
    for (let i = 0; i < 5; i++) {
      const f = gold ? 1 : Math.max(0, Math.min(1, v - i));
      this._starEls[i].style.setProperty('--f', (f * 100).toFixed(0) + '%');
    }
  }

  // buyuk kutlama yazisi (kombo kilometre taslari)
  milestone(text) {
    const el = this.el.milestone;
    el.textContent = text;
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
  }

  // bolum degisimi bandi
  sectionBanner(text) {
    const el = this.el.section;
    el.textContent = text;
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
  }

  // erken / gec gostergesi (yalniz kusursuz disindaki isabetlerde)
  timing(deltaMs) {
    const el = this.el.delta;
    if (Math.abs(deltaMs) < 50) { el.classList.remove('show'); return; }
    el.textContent = deltaMs < 0 ? t('hud.early') : t('hud.late');
    el.className = 'hud-delta show ' + (deltaMs < 0 ? 'early' : 'late');
    clearTimeout(this._deltaTimer);
    this._deltaTimer = setTimeout(() => el.classList.remove('show'), 420);
  }

  setProgress(p) {
    this.el.progress.style.width = (p * 100).toFixed(2) + '%';
  }

  countdown(n) {
    const el = this.el.countdown;
    if (n <= 0) {
      // yalniz sayidan 'BASLA!'ya geciste bir kez (her karede zamanlayici kurma)
      if (el.textContent !== '' && el.textContent !== t('hud.go')) {
        el.textContent = t('hud.go');
        el.classList.add('show');
        setTimeout(() => { el.classList.remove('show'); el.textContent = ''; }, 600);
      }
      return;
    }
    const txt = String(n);
    if (el.textContent !== txt) {
      el.textContent = txt;
      el.classList.remove('show');
      void el.offsetWidth;
      el.classList.add('show');
    }
  }
}

// bolum yogunluguna gore renk (menu seridi, ilerleme cubugu, sonuc grafigi)
export function sectionColor(s) {
  const k = s.intensity != null ? s.intensity : 0.5;
  // sakin: mavi -> orta: mor -> yogun: pembe/altin
  const hue = 200 - k * 175;
  return `hsl(${hue.toFixed(0)} 85% ${(52 + k * 8).toFixed(0)}%)`;
}

export function toast(msg, kind = 'ok') {
  const wrap = document.getElementById('toasts');
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  wrap.appendChild(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 400);
  }, 3500);
}
