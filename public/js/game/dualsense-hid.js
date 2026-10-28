// CaYa Rhythm - DualSense WebHID titreşimi
// Gamepad API'nin vibrationActuator'ı (özellikle Bluetooth'ta) güvenilmez.
// WebHID ile kullanıcı tarayıcıdan kolu seçer, biz de motorlara doğrudan
// HID çıktı raporu göndeririz. USB (rapor 0x02) ve Bluetooth (rapor 0x31 + CRC32)
// destekli.

const SONY_VID = 0x054c;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) crc = (CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// titreşim çıkış raporları arası en kısa süre (ms) — giriş raporlarına bant bırak
const OUT_GAP = 24;

export class DualSenseHID {
  constructor() {
    this.device = null;
    this.bluetooth = false;
    this._timer = null;
    this.onDisconnect = null;
    // ayrıştırılmış güncel buton durumu
    this.buttons = null;
    // her giriş raporunda HEMEN çağrılır (buttons, zaman damgası ms): input.js
    // kenarları kare beklemeden ve raporun gerçek zamanıyla işler
    this.onButtons = null;
    // titreşim çıkışı: aynı anda tek rapor, en son değer kazanır (bkz. setMotors)
    this._want = null;
    this._busy = false;
    this._sent = null;
    this._lastOut = 0;
    this._onInput = (e) => this._parseInput(e);
    if (this.supported) {
      navigator.hid.addEventListener('disconnect', (e) => {
        if (e.device === this.device) {
          this._teardown();
          this.onDisconnect && this.onDisconnect();
        }
      });
    }
  }

  get supported() { return 'hid' in navigator; }
  get connected() { return !!(this.device && this.device.opened); }
  get name() { return this.device ? (this.device.productName || 'DualSense') : ''; }

  // Daha önce izin verilmiş kolu sessizce yeniden aç (sayfa yenilemede)
  async tryReconnect() {
    if (!this.supported) return false;
    try {
      const devices = await navigator.hid.getDevices();
      const dev = devices.find(d => d.vendorId === SONY_VID);
      if (dev) { await this._use(dev); return true; }
    } catch {}
    return false;
  }

  // Tarayıcı seçim penceresini aç (kullanıcı tıklamasından çağrılmalı)
  async requestDevice() {
    if (!this.supported) throw new Error('Tarayıcı WebHID desteklemiyor (Chrome/Edge gerekli)');
    const devices = await navigator.hid.requestDevice({ filters: [{ vendorId: SONY_VID }] });
    if (!devices.length) return null; // kullanıcı iptal etti
    await this._use(devices[0]);
    return this.device;
  }

  async _use(dev) {
    if (!dev.opened) await dev.open();
    this.device = dev;
    // Bluetooth bağlantısında çıktı raporu 0x31 bulunur
    this.bluetooth = dev.collections.some(c =>
      (c.outputReports || []).some(r => r.reportId === 0x31));
    // Giriş raporlarını DOĞRUDAN HID'den oku: kola çıktı raporu gönderince
    // DualSense "tam mod"a geçer ve Gamepad API girişi güvenilmez olur.
    dev.addEventListener('inputreport', this._onInput);
    // Bluetooth'ta tam mod giriş raporlarını (0x31) tetikle
    if (this.bluetooth) {
      try { await dev.receiveFeatureReport(0x05); } catch {}
    }
  }

  _teardown() {
    if (this.device) {
      try { this.device.removeEventListener('inputreport', this._onInput); } catch {}
    }
    this.device = null;
    this.buttons = null;
  }

  // DualSense giriş raporunu ayrıştır (USB rapor 0x01, BT tam mod 0x31)
  _parseInput(e) {
    const d = e.data; // DataView, reportId hariç
    let off;
    if (e.reportId === 0x31) off = 1;       // Bluetooth tam mod
    else if (e.reportId === 0x01) off = 0;  // USB
    else return;
    if (d.byteLength < off + 10) return;
    const r2axis = d.getUint8(off + 5);
    const b0 = d.getUint8(off + 7); // dpad(düşük nibble) + kare/çarpı/yuvarlak/üçgen
    const b1 = d.getUint8(off + 8); // L1/R1/L2/R2/Create/Options/L3/R3
    const hat = b0 & 0x0F;
    this.buttons = {
      square:   !!(b0 & 0x10),
      cross:    !!(b0 & 0x20),
      circle:   !!(b0 & 0x40),
      triangle: !!(b0 & 0x80),
      dpadUp:    hat === 7 || hat === 0 || hat === 1,
      dpadRight: hat === 1 || hat === 2 || hat === 3,
      dpadDown:  hat === 3 || hat === 4 || hat === 5,
      dpadLeft:  hat === 5 || hat === 6 || hat === 7,
      l1: !!(b1 & 0x01),
      r1: !!(b1 & 0x02),
      r2: !!(b1 & 0x08) || r2axis > 100,
      options: !!(b1 & 0x20)
    };
    if (this.onButtons) this.onButtons(this.buttons, e.timeStamp || performance.now());
  }

  // Titreşim isteği. Çıkış raporları KUYRUKLANMAZ: bir rapor yoldayken gelen
  // istekler yalnız son değeri günceller; aynı değer tekrar gönderilmez ve
  // raporlar arasında en az OUT_GAP ms vardır. (Aksi halde 60 Hz karıştırıcı,
  // özellikle Bluetooth'ta, rapor birikimiyle giriş raporlarını geciktiriyordu:
  // akorlarda ve boost sırasında tuşlar geç algılanıyordu.)
  setMotors(left, right) {
    if (!this.connected) return;
    const l = Math.max(0, Math.min(255, Math.round(left)));
    const r = Math.max(0, Math.min(255, Math.round(right)));
    this._want = [l, r];
    if (!this._busy) this._pump();
  }

  async _pump() {
    this._busy = true;
    while (this._want && this.connected) {
      const [l, r] = this._want;
      this._want = null;
      if (this._sent && this._sent[0] === l && this._sent[1] === r) continue;
      const wait = OUT_GAP - (performance.now() - this._lastOut);
      if (wait > 0) {
        this._want = this._want || [l, r];
        await new Promise(res => setTimeout(res, wait));
        continue; // beklerken gelen daha yeni deger varsa o gonderilir
      }
      this._lastOut = performance.now();
      await this._sendMotors(l, r);
      this._sent = [l, r];
    }
    this._busy = false;
  }

  async _sendMotors(l, r) {
    try {
      if (this.bluetooth) {
        // Linux hid-playstation sürücüsüne göre BT çıktı raporu 0x31:
        //   payload[0]=seq, [1]=tag(0x10), [2]=flag0, [3]=flag1, [4]=sağ, [5]=sol
        const buf = new Uint8Array(77); // reportId hariç gönderilen yük
        buf[0] = (this._seq = ((this._seq || 0) + 1) & 0x0F) << 4; // sıra etiketi
        buf[1] = 0x10; // DS_OUTPUT_TAG
        buf[2] = 0x03; // flag0: uyumlu titreşim + haptic seçimi
        buf[3] = 0x00; // flag1: LED/lightbar'a dokunma
        buf[4] = r;    // sağ motor (zayıf/yüksek frekans)
        buf[5] = l;    // sol motor (güçlü/düşük frekans)
        // CRC32 girişi: [0xA2, 0x31, payload[0..72]]
        const crcIn = new Uint8Array(75);
        crcIn[0] = 0xA2; crcIn[1] = 0x31;
        crcIn.set(buf.subarray(0, 73), 2);
        const crc = crc32(crcIn);
        buf[73] = crc & 0xFF;
        buf[74] = (crc >>> 8) & 0xFF;
        buf[75] = (crc >>> 16) & 0xFF;
        buf[76] = (crc >>> 24) & 0xFF;
        await this.device.sendReport(0x31, buf);
      } else {
        const buf = new Uint8Array(47);
        buf[0] = 0x03; // flag0
        buf[1] = 0x00; // flag1
        buf[2] = r;    // sağ motor
        buf[3] = l;    // sol motor
        await this.device.sendReport(0x02, buf);
      }
    } catch { /* sendReport hatası: yoksay */ }
  }

  // kısa darbe (strong/weak 0..1)
  pulse(strong, weak, durationMs) {
    if (!this.connected) return;
    clearTimeout(this._timer);
    this.setMotors(strong * 255, weak * 255);
    this._timer = setTimeout(() => this.setMotors(0, 0), durationMs);
  }
}
