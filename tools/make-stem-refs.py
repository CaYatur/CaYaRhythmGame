"""CaYa Rhythm - gercek sarkilar icin TUM PARCA referanslari (yalniz gelistirme).

Demucs (htdemucs) miksten 4 kanal ayirir: davul, bas, diger (enstruman), vokal.
Temiz kanallardan oyunun her parcasi icin referans olay listesi cikarilir:
  - davul : genis bant vurus baslangiclari, alt bant enerji artisina gore
            kick / trampet / hi-hat etiketli
  - bas   : vurus baslangiclari (enerji yeniden vurusu + perde degisimi), YIN perdesi
  - diger : enstruman (gitar/synth/piyano) vurus baslangiclari
  - vokal : f0 konturu (make-vocal-refs.py ile ayni bicim)
tools/stems-bench.mjs bu referanslara karsi oyunun analiz worker'ini ve
haritalarini olcer. Oyuna dahil DEGILDIR.

Kullanim:
  python tools/make-stem-refs.py separate <onbellek> <baslangic_sn> <sure_sn> <ses1> [<ses2> ...]
  python tools/make-stem-refs.py refs <onbellek> <cikti_klasoru>
Gereksinim: ffmpeg, numpy, scipy, librosa; 'separate' icin torch + demucs
"""
import json, os, subprocess, sys
import numpy as np

SR_IN = 44100
SR = 22050
# ~10 ms izgara: TAM SAYI ornek adimi (220 @ 22050 Hz = 9.977 ms). Zamanlar bu
# gercek adimla hesaplanir; 0.01 varsaymak 90 sn'de ~0.2 sn kayma yaratiyordu.
HOP = 220 / SR
# STFT karesi i, [i*HOP, i*HOP + n) penceresidir; akis tepesi atak pencere
# ORTASINA geldiginde olusur -> olay zamani = i*HOP + n/2/SR
CEN1024 = 512 / SR
CEN2048 = 1024 / SR
STEMS = ('drums', 'bass', 'other', 'vocals')


def decode(path, start, dur):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-ss', str(start), '-t', str(dur), '-i', path,
                          '-f', 'f32le', '-ac', '2', '-ar', str(SR_IN), '-'],
                         check=True, capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).T.copy()


def separate(cache, start, dur, paths):
    import torch
    from demucs.pretrained import get_model
    from demucs.apply import apply_model
    from scipy.signal import resample_poly
    model = get_model('htdemucs')
    model.eval()
    dev = 'cuda' if torch.cuda.is_available() else 'cpu'
    print('aygit:', dev)
    os.makedirs(cache, exist_ok=True)
    for path in paths:
        name = os.path.splitext(os.path.basename(path))[0]
        if os.path.exists(os.path.join(cache, name + '.npz')):
            print('onbellekte:', name)
            continue
        mix = decode(path, start, dur)
        x = torch.from_numpy(mix)[None]
        ref = x.mean(1, keepdim=True)
        m, s = ref.mean(), ref.std() + 1e-8
        with torch.no_grad():
            out = apply_model(model, (x - m) / s, device=dev, split=True, overlap=0.25, progress=False)[0]
        out = (out * s + m).mean(1).cpu().numpy()  # (kaynak, ornek) mono
        stems = {k: resample_poly(out[model.sources.index(k)], 1, 2).astype(np.float32) for k in STEMS}
        np.savez_compressed(os.path.join(cache, name + '.npz'), name=name, start=start, dur=dur, **stems)
        print('ayrildi:', name)


# ---------- ortak sinyal araclari ----------
def stft_mag(x, n=1024, hop=None):
    hop = hop or int(round(HOP * SR))
    w = np.hanning(n).astype(np.float32)
    F = 1 + max(0, (len(x) - n) // hop)
    idx = np.arange(n)[None, :] + hop * np.arange(F)[:, None]
    return np.abs(np.fft.rfft(x[idx] * w, axis=1)).astype(np.float32)


def band(mag, lo_hz, hi_hz, n=1024):
    b0, b1 = int(lo_hz * n / SR), max(int(lo_hz * n / SR) + 1, int(hi_hz * n / SR))
    return mag[:, b0:b1]


def flux(logm, lag=2):
    # SuperFlux benzeri: frekansta maks-filtreli referansa gore pozitif fark
    from scipy.ndimage import maximum_filter1d
    ref = maximum_filter1d(logm, 3, axis=1)
    d = np.zeros(len(logm), dtype=np.float32)
    d[lag:] = np.maximum(0, logm[lag:] - ref[:-lag]).sum(1)
    return d


def peaks(env, rel, min_sep, mean_w=10):
    # esik: p99'a gore goreli + yerel ortalama; min aralik
    thr = rel * np.percentile(env, 99)
    out = []
    last = -10 ** 9
    for i in range(1, len(env) - 1):
        v = env[i]
        if v < thr or v < env[i - 1] or v < env[i + 1]:
            continue
        lo, hi = max(0, i - mean_w), min(len(env), i + mean_w + 1)
        if v < 1.3 * env[lo:hi].mean():
            continue
        if i - last < min_sep:
            continue
        out.append(i)
        last = i
    return out


def rms_frames(x, n=1024):
    hop = int(round(HOP * SR))
    F = 1 + max(0, (len(x) - n) // hop)
    idx = np.arange(n)[None, :] + hop * np.arange(F)[:, None]
    return np.sqrt((x[idx] ** 2).mean(1))


def yin(x, sr, fmin, fmax, win, thr=0.15):
    hop = int(round(HOP * sr))
    tmin, tmax = int(sr / fmax), int(sr / fmin)
    n = 1 + max(0, (len(x) - win - tmax) // hop)
    f0 = np.zeros(n, dtype=np.float32)
    ap = np.ones(n, dtype=np.float32)
    for i in range(n):
        seg = x[i * hop: i * hop + win + tmax].astype(np.float64)
        w = seg[:win]
        e0 = np.dot(w, w)
        c = np.correlate(seg[:win + tmax], w, mode='valid')[:tmax + 1]
        sq = np.cumsum(np.concatenate([[0.0], seg[:win + tmax] ** 2]))
        et = sq[win:win + tmax + 1] - sq[0:tmax + 1]
        d = e0 + et - 2 * c
        d[0] = 0
        cm = np.ones_like(d)
        cs = np.cumsum(d[1:])
        cm[1:] = d[1:] * np.arange(1, tmax + 1) / np.maximum(cs, 1e-12)
        tau = -1
        for t in range(tmin, tmax):
            if cm[t] < thr:
                while t + 1 < tmax and cm[t + 1] < cm[t]:
                    t += 1
                tau = t
                break
        if tau < 0:
            tau = tmin + int(np.argmin(cm[tmin:tmax]))
        dx = 0
        if 1 <= tau < tmax:
            a, b, c2 = cm[tau - 1], cm[tau], cm[tau + 1]
            den = a - 2 * b + c2
            dx = max(-0.5, min(0.5, 0.5 * (a - c2) / den)) if abs(den) > 1e-12 else 0
        f0[i] = sr / (tau + dx)
        ap[i] = cm[tau]
    return f0, ap


def clean_runs(v, short=4):
    v = v.astype(np.int8)
    for val in (1, 0):
        run = 0
        for i in range(len(v) + 1):
            if i < len(v) and v[i] == val:
                run += 1
                continue
            if 0 < run < short:
                v[i - run:i] = 1 - val
            run = 0
    return v


# ---------- parca referanslari ----------
def drum_refs(x):
    # Davul kanalinda bas yok: 30-120 Hz neredeyse yalniz kick'tir. Her bant
    # kendi akisiyla tespit edilir (kick ile trampet ayni anda olabilir).
    mag = stft_mag(x)
    lg = lambda lo, hi: np.log1p(band(mag, lo, hi) * 50)
    env_all = flux(lg(30, 11000))
    kick = peaks(flux(lg(30, 120)), 0.2, 8)
    sn_env = flux(lg(200, 5000))
    hi_env = flux(lg(7000, 11000))
    snare_c = peaks(sn_env, 0.2, 8)
    # trampet adayi: govde+gurultu bandindaki atak, ust banda gore baskin
    # (hi-hat agirlikli 7 kHz ustundedir; trampet/clap 200 Hz-5 kHz'i doldurur)
    def ratio(i):
        a = sn_env[max(0, i - 1):i + 2].max() / (np.percentile(sn_env, 99) + 1e-9)
        b = hi_env[max(0, i - 1):i + 2].max() / (np.percentile(hi_env, 99) + 1e-9)
        return a / (b + 1e-3)
    snare = [i for i in snare_c if ratio(i) > 0.9]
    # kick'in ust harmonik tiki trampet sanilmasin: kick ile ayni karede ve
    # zayif gurultuyse at
    ks = set(kick)
    snare = [i for i in snare if not (any(abs(i - k) <= 1 for k in ks) and ratio(i) < 1.6)]
    sset = set(snare)
    hat = [i for i in peaks(hi_env, 0.2, 5) if not any(abs(i - k) <= 2 for k in sset)]
    T = lambda arr: [round(i * HOP + CEN1024, 3) for i in arr]
    return {'all': T(peaks(env_all, 0.12, 5)), 'kick': T(kick), 'snare': T(snare), 'hat': T(hat)}


def bass_refs(x):
    f0, ap = yin(x, SR, 35.0, 400.0, 2048)
    rms = rms_frames(x, 2048)[:len(f0)]
    peak = np.percentile(rms, 99) + 1e-9
    voiced = clean_runs((ap < 0.3) & (rms > peak * 10 ** (-30 / 20)))
    midi = np.where(voiced > 0, 69 + 12 * np.log2(np.maximum(f0, 1) / 440.0), 0)
    midi = np.concatenate([np.zeros(int(round(CEN2048 / HOP))), midi])  # pencere ortasi
    # yeniden vurus: alt bant log-enerji akisi (ayni perdede tekrar eden 8'likler)
    mag = stft_mag(x, 2048)
    lg = np.log1p(band(mag, 30, 400, 2048) * 50)
    env = flux(lg)
    on = set(peaks(env, 0.15, 8))
    # perde degisimi (>=1 yarim ton, >=50 ms kalici) ya da sesli bolge baslangici
    cur, run = 0, 0
    for i in range(len(midi)):
        if midi[i] > 0 and (i == 0 or midi[i - 1] == 0):
            on.add(i); cur = midi[i]; run = 0
        elif midi[i] > 0:
            if abs(midi[i] - cur) >= 1:
                run += 1
                if run >= 5:
                    on.add(i - 4); cur = midi[i]; run = 0
            else:
                run = 0
    on = sorted(on)
    merged = []
    for i in on:
        if merged and i - merged[-1] < 6:
            continue
        merged.append(i)
    notes = []
    for i in merged:
        seg = midi[i + 2:i + 8]
        seg = seg[seg > 0]
        notes.append([round(i * HOP + CEN2048, 3), round(float(np.median(seg)), 2) if len(seg) else 0])
    return {'onsets': notes, 'midi': [round(float(m), 2) for m in midi]}


def other_refs(x):
    mag = stft_mag(x)
    lg = np.log1p(band(mag, 120, 8000) * 50)
    env = flux(lg)
    on = peaks(env, 0.15, 6)
    return {'onsets': [round(i * HOP + CEN1024, 3) for i in on]}


def vocal_refs(x, acc):
    f0, ap = yin(x, SR, 70.0, 1000.0, 1024)
    rms = rms_frames(x)[:len(f0)]
    peak = np.percentile(rms, 99) + 1e-9
    voiced = clean_runs((ap < 0.25) & (rms > peak * 10 ** (-30 / 20)) & (f0 > 70) & (f0 < 1000))
    midi = np.where(voiced > 0, 69 + 12 * np.log2(np.maximum(f0, 1) / 440.0), 0)
    midi = np.concatenate([np.zeros(int(round(CEN1024 / HOP))), midi])  # pencere ortasi
    # hece baslangiclari (rap/efektli vokal perdesiz olabilir): vokal kanali enerji
    # akisi; yalniz vokal mikste duyulur durumdayken (eslige gore > -12 dB)
    mag = stft_mag(x)
    env = flux(np.log1p(band(mag, 150, 5000) * 50))
    arms = rms_frames(acc)[:len(rms)]
    audible = (rms > peak * 10 ** (-25 / 20)) & (rms > arms * 10 ** (-12 / 20))
    syl = [i for i in peaks(env, 0.15, 8) if i < len(audible) and audible[max(0, i - 2):i + 6].any()]
    return {'midi': [round(float(m), 2) for m in midi], 'syllables': [round(i * HOP + CEN1024, 3) for i in syl],
            'audible': [0] * int(round(CEN1024 / HOP)) + [int(v) for v in audible]}


def refs(cache, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    for f in sorted(os.listdir(cache)):
        if not f.endswith('.npz'):
            continue
        z = np.load(os.path.join(cache, f))
        name = str(z['name'])
        acc = z['drums'] + z['bass'] + z['other']
        ref = {'name': name, 'start': float(z['start']), 'dur': float(z['dur']), 'hop': HOP,
               'drums': drum_refs(z['drums']), 'bass': bass_refs(z['bass']),
               'other': other_refs(z['other']), 'vocal': vocal_refs(z['vocals'], acc)}
        # vurus izgarasi: temiz davul kanalinda librosa vurus takibi (davul
        # yoksa tum enstruman kanallari)
        import librosa
        src = z['drums'] if np.sqrt(np.mean(z['drums'] ** 2)) > 0.01 else acc
        bpm, bt = librosa.beat.beat_track(y=src.astype(np.float32), sr=SR, units='time', tightness=200)
        ref['beats'] = {'bpm': round(float(np.atleast_1d(bpm)[0]), 1), 'times': [round(float(t), 3) for t in bt]}
        # kanal enerjileri (bolum bazli 'bu parca caliyor mu' icin): 10 Hz RMS
        ref['activity'] = {k: [round(float(v), 4) for v in rms_frames(z[k], 2205)[::10]] for k in STEMS}
        with open(os.path.join(out_dir, name + '.json'), 'w', encoding='utf-8') as fh:
            json.dump(ref, fh)
        d = ref['drums']
        print(f"{name[:36]:36s} bpm {ref['beats']['bpm']:6.1f} kick {len(d['kick']):4d} trampet {len(d['snare']):4d} hat {len(d['hat']):4d} "
              f"bas {len(ref['bass']['onsets']):4d} diger {len(ref['other']['onsets']):4d}")


if __name__ == '__main__':
    if sys.argv[1] == 'separate':
        separate(sys.argv[2], float(sys.argv[3]), float(sys.argv[4]), sys.argv[5:])
    else:
        refs(sys.argv[2], sys.argv[3])
