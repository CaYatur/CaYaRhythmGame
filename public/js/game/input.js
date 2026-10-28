// CaYa Rhythm - Girdi: Klavye + DualSense (Gamepad API, titresimli)
//
// DualSense esleme (kullanici tanimli):
//   Sol ok  -> 1. serit      Sag ok -> 2. serit      Kare -> 3. serit
//   Usta modunda: Ucgen -> 4. serit, Yuvarlak -> 5. serit
//   Usta degilse: Yuvarlak -> 4. serit
//   R2 -> Boost, Options -> Duraklat
// Klavye: D F J K (ustada + L), Bosluk -> Boost, Esc -> Duraklat

import { t } from '../i18n.js';

const GP_BTN = { CROSS: 0, CIRCLE: 1, SQUARE: 2, TRIANGLE: 3, L2: 6, R2: 7, OPTIONS: 9, DPAD_LEFT: 14, DPAD_RIGHT: 15 };

export const KEY_HINT_4 = 'D F J K';
export const KEY_HINT_5 = 'D F J K L';

export class Input {
  constructor(handlers) {
    this.h = handlers; // {onLane(lane, down, when), onBoost, onPause, onToast}
    // when: basisin gercek zamani (performance.now() tabani, ms). Kare
    // bekleyen okuma yerine olay/rapor zamani kullanilir: kare takilsa da
    // vurus zamanlamasi kaymaz.
    this.laneCount = 4;
    this.heldLanes = new Set();
    this.keyMap = {};
    this.gpLaneMap = {};
    this.prevButtons = [];
    this.prevR2 = false;
    this._kbBoost = false;   // boost butonu (Bosluk) klavyede basili mi
    this._padBoost = false;  // boost butonu (R2) kolda basili mi
    this.gamepadIndex = -1;
    this.enabled = false;
    this.activeDevice = null; // 'keyboard' | 'gamepad' — son kullanilan girdi kaynagi
    this._rumbleSupported = false;
    this._rumbleLockUntil = 0;   // güçlü titreşim (boost) kilidi: bitiş zamanı (ms)
    this._rumbleLockPrio = 0;    // kilidi tutan titreşimin önceliği
    this.hid = null; // DualSenseHID (varsa titreşim için öncelikli)

    this._onKeyDown = (e) => this._keyDown(e);
    this._onKeyUp = (e) => this._keyUp(e);
    this._onGpConnect = (e) => this._gpConnect(e.gamepad);
    this._onGpDisconnect = (e) => this._gpDisconnect(e.gamepad);

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('gamepadconnected', this._onGpConnect);
    window.addEventListener('gamepaddisconnected', this._onGpDisconnect);

    // sayfa yuklendiginde zaten bagli olan kollari yakala
    for (const gp of navigator.getGamepads ? navigator.getGamepads() : []) {
      if (gp) this._gpConnect(gp, true);
    }
  }

  setLaneCount(n) {
    this.laneCount = n;
    this.keyMap = n === 5
      ? { KeyD: 0, KeyF: 1, KeyJ: 2, KeyK: 3, KeyL: 4 }
      : { KeyD: 0, KeyF: 1, KeyJ: 2, KeyK: 3 };
    this.gpLaneMap = n === 5
      ? { [GP_BTN.DPAD_LEFT]: 0, [GP_BTN.DPAD_RIGHT]: 1, [GP_BTN.SQUARE]: 2, [GP_BTN.TRIANGLE]: 3, [GP_BTN.CIRCLE]: 4 }
      : { [GP_BTN.DPAD_LEFT]: 0, [GP_BTN.DPAD_RIGHT]: 1, [GP_BTN.SQUARE]: 2, [GP_BTN.CIRCLE]: 3 };
    this.heldLanes.clear();
  }

  setEnabled(v) {
    this.enabled = v;
    if (!v) { this.heldLanes.clear(); this._kbBoost = false; this._padBoost = false; }
    // Gamepad API olay vermez: oyun sirasinda kareden bagimsiz ~4 ms'de bir oku
    clearInterval(this._fastPoll);
    this._fastPoll = v ? setInterval(() => this._pollGamepad(), 4) : 0;
  }

  // boost butonu (R2 ya da Bosluk) su an fiziksel basili mi
  get boostHeld() { return this._kbBoost || this._padBoost; }

  // HID: her giris raporunda kenarlar HEMEN islenir (rapor zamani ile)
  setHid(hid) {
    if (this.hid && this.hid !== hid) this.hid.onButtons = null;
    this.hid = hid;
    if (hid) hid.onButtons = (b, when) => this._applyPad(this._hidLanes(b), b.r2, b.options, when);
  }

  // aktif girdi kaynagini guncelle; degisince HUD'a haber ver
  _useDevice(d) {
    if (this.activeDevice === d) return;
    this.activeDevice = d;
    this.h.onDevice && this.h.onDevice(d);
  }

  _keyDown(e) {
    if (e.code === 'Escape') { this._useDevice('keyboard'); this.h.onPause && this.h.onPause(); return; }
    if (!this.enabled || e.repeat) return;
    if (e.code === 'Space') { e.preventDefault(); this._useDevice('keyboard'); this._kbBoost = true; this.h.onBoost && this.h.onBoost(); return; }
    const lane = this.keyMap[e.code];
    if (lane !== undefined && !this.heldLanes.has(lane)) {
      e.preventDefault();
      this._useDevice('keyboard');
      this.heldLanes.add(lane);
      this.h.onLane(lane, true, e.timeStamp);
    }
  }

  _keyUp(e) {
    if (e.code === 'Space') { this._kbBoost = false; return; }
    const lane = this.keyMap[e.code];
    if (lane !== undefined && this.heldLanes.has(lane)) {
      this.heldLanes.delete(lane);
      this.h.onLane(lane, false, e.timeStamp);
    }
  }

  _gpConnect(gp, silent) {
    if (this.gamepadIndex === -1 || this.gamepadIndex === gp.index) {
      this.gamepadIndex = gp.index;
      this.prevButtons = [];
      this._rumbleSupported = !!(gp.vibrationActuator || (gp.hapticActuators && gp.hapticActuators.length));
      const isDS = /dualsense|dual sense|054c/i.test(gp.id);
      this.padName = isDS ? 'DualSense' : gp.id.slice(0, 28);
      if (!silent && this.h.onToast) {
        this.h.onToast(isDS ? t('toast.dsConnected') : t('toast.padConnected', { id: gp.id.slice(0, 32) }), 'ok');
      }
      this.h.onStatus && this.h.onStatus(true, this.padName, isDS, this._rumbleSupported);
      if (this._rumbleSupported) this.rumble('connect');
    }
  }

  _gpDisconnect(gp) {
    if (gp.index === this.gamepadIndex) {
      this.gamepadIndex = -1;
      // kol uzerinden basili tutulan seritleri serbest birak
      for (const lane of Array.from(this.heldLanes)) {
        if (this._padHeld && this._padHeld.has(lane)) {
          this.heldLanes.delete(lane);
          this._padHeld.delete(lane);
          this.h.onLane(lane, false);
        }
      }
      this.h.onToast && this.h.onToast(t('toast.padDisconnected'), 'warn');
      this.h.onStatus && this.h.onStatus(false);
    }
  }

  isConnected() { return this.gamepadIndex >= 0 && !!this._gamepad(); }

  _gamepad() {
    if (this.gamepadIndex < 0) return null;
    const gps = navigator.getGamepads ? navigator.getGamepads() : [];
    return gps[this.gamepadIndex] || null;
  }

  // HID buton durumundan serit kumesi cikar
  _hidLanes(b) {
    const s = new Set();
    if (b.dpadLeft) s.add(0);
    if (b.dpadRight) s.add(1);
    if (b.square) s.add(2);
    if (this.laneCount === 5) {
      if (b.triangle) s.add(3);
      if (b.circle) s.add(4);
    } else {
      if (b.circle) s.add(3);
    }
    return s;
  }

  // Gamepad API buton durumundan serit kumesi cikar
  _gpLanes(gp) {
    const s = new Set();
    for (const [btnStr, lane] of Object.entries(this.gpLaneMap)) {
      const btn = +btnStr;
      if (gp.buttons[btn] && gp.buttons[btn].pressed) s.add(lane);
    }
    return s;
  }

  // her kare ana donguden cagrilir. HID bagliysa girisi rapor olaylari isler
  // (Gamepad API DualSense tam modda guvenilmez olur); degilse Gamepad API.
  poll() {
    if (this.hid && this.hid.connected) return;
    this._pollGamepad();
  }

  _pollGamepad() {
    if (this.hid && this.hid.connected) return;
    const gp = this._gamepad();
    if (!gp) { this._padBoost = false; return; }
    // ayni durum ikinci kez islenmesin (hizli okuyucu + kare okuyucu)
    if (gp.timestamp && gp.timestamp === this._gpStamp) return;
    this._gpStamp = gp.timestamp;
    const r2 = gp.buttons[GP_BTN.R2];
    const r2On = !!r2 && (r2.pressed || r2.value > 0.45);
    const optOn = !!(gp.buttons[GP_BTN.OPTIONS] && gp.buttons[GP_BTN.OPTIONS].pressed);
    // gp.timestamp: tarayicinin kol verisini aldigi an (performance.now tabani)
    const when = gp.timestamp && gp.timestamp <= performance.now() ? gp.timestamp : performance.now();
    this._applyPad(this._gpLanes(gp), r2On, optOn, when);
  }

  // kol durumundan kenar tespiti (kaynaktan bagimsiz)
  _applyPad(lanes, r2On, optOn, when) {
    if (!this._padHeld) this._padHeld = new Set();

    // serit kenar tespiti (kaynaktan bagimsiz)
    for (let lane = 0; lane < this.laneCount; lane++) {
      const pressed = lanes.has(lane);
      const padHeld = this._padHeld.has(lane);
      if (pressed && !padHeld && this.enabled) {
        if (!this.heldLanes.has(lane)) {
          this._useDevice('gamepad');
          this.heldLanes.add(lane);
          this._padHeld.add(lane);
          this.h.onLane(lane, true, when);
        }
      } else if (!pressed && padHeld) {
        this.heldLanes.delete(lane);
        this._padHeld.delete(lane);
        this.h.onLane(lane, false, when);
      }
    }

    // R2 -> boost (kenarda aktive et; basili tutma durumunu da sakla)
    if (r2On && !this.prevR2 && this.enabled) { this._useDevice('gamepad'); this.h.onBoost && this.h.onBoost(); }
    this.prevR2 = r2On;
    this._padBoost = r2On;

    // Options -> duraklat
    if (optOn && !this.prevOptions) { this._useDevice('gamepad'); this.h.onPause && this.h.onPause(); }
    this.prevOptions = optOn;
  }

  // Motorlari dogrudan sur (0..1). Haptics karistiricisi 60 Hz'de cagirir.
  // WebHID (DualSense) oncelikli; yoksa Gamepad API 'dual-rumble' (kisa sureli,
  // karistirici canli degerleri ~60 ms'de bir yeniler).
  setMotors(strong, weak) {
    if (this.hid && this.hid.connected) {
      clearTimeout(this.hid._timer);
      this.hid.setMotors(strong * 255, weak * 255);
      return;
    }
    const gp = this._gamepad();
    if (!gp) return;
    const va = gp.vibrationActuator;
    try {
      if (va && va.playEffect) {
        if (strong <= 0 && weak <= 0) { if (va.reset) va.reset(); }
        else va.playEffect('dual-rumble', { startDelay: 0, duration: 100, strongMagnitude: strong, weakMagnitude: weak });
      } else {
        const ha = gp.hapticActuators && gp.hapticActuators[0];
        if (ha && ha.pulse && (strong > 0 || weak > 0)) ha.pulse(Math.max(strong, weak), 100);
      }
    } catch { /* destek yoksa sessizce gec */ }
  }

  // Titresim: Haptics bagliysa desen olarak calar; degilse eski tek darbe.
  rumble(kind) {
    if (this.haptics) { this.haptics.play(kind); return; }
    const presets = {
      perfect: { duration: 40, weakMagnitude: 0.35, strongMagnitude: 0.0 },
      great: { duration: 32, weakMagnitude: 0.25, strongMagnitude: 0.0 },
      good: { duration: 25, weakMagnitude: 0.15, strongMagnitude: 0.0 },
      gold: { duration: 70, weakMagnitude: 0.5, strongMagnitude: 0.25 },
      boost: { duration: 480, weakMagnitude: 0.85, strongMagnitude: 1.0, priority: 10 },
      milestone: { duration: 80, weakMagnitude: 0.4, strongMagnitude: 0.15 },
      connect: { duration: 120, weakMagnitude: 0.3, strongMagnitude: 0.2 },
      test: { duration: 400, weakMagnitude: 0.7, strongMagnitude: 0.7 }
    };
    const p = presets[kind];
    if (!p) return;

    // Öncelik kilidi: güçlü titreşim (boost) çalarken küçük nota titreşimleri
    // onu kesip bastırmasın. Boost aktive olunca hitAnyInWindow hemen nota
    // vuruşları üretir; kilit olmasa boost titreşimi aynı anda eziliyordu.
    const now = performance.now();
    const prio = p.priority || 0;
    if (now < this._rumbleLockUntil && prio < this._rumbleLockPrio) return;
    this._rumbleLockUntil = now + p.duration;
    this._rumbleLockPrio = prio;

    // WebHID (DualSense) öncelikli — en güvenilir, Bluetooth dahil
    if (this.hid && this.hid.connected) {
      this.hid.pulse(p.strongMagnitude || 0, p.weakMagnitude || 0, p.duration);
      return;
    }
    const gp = this._gamepad();
    if (!gp) return;
    // Chrome/Edge: vibrationActuator (DualSense dahil)
    if (gp.vibrationActuator && gp.vibrationActuator.playEffect) {
      try {
        gp.vibrationActuator.playEffect('dual-rumble', { startDelay: 0, ...p });
      } catch { /* destek yoksa sessizce gec */ }
      return;
    }
    // Firefox vb.: hapticActuators yedegi
    const ha = gp.hapticActuators && gp.hapticActuators[0];
    if (ha && ha.pulse) {
      try { ha.pulse(Math.max(p.weakMagnitude, p.strongMagnitude), p.duration); } catch {}
    }
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('gamepadconnected', this._onGpConnect);
    window.removeEventListener('gamepaddisconnected', this._onGpDisconnect);
  }
}
