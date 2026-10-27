"""CaYa Rhythm - gercek sarkilar icin REFERANS vokal kontur uretici (yalniz gelistirme).

Demucs (htdemucs) ile miksten vokal kanalini ayirir, temiz vokal uzerinde YIN
ile f0 + voicing cikarir ve JSON olarak yazar. tools/realvocal-bench.mjs bu
referanslara karsi oyunun analiz worker'ini olcer. Oyuna dahil DEGILDIR.

Kullanim:
  python tools/make-vocal-refs.py <cikti_klasoru> <baslangic_sn> <sure_sn> <ses1> [<ses2> ...]
Gereksinim: ffmpeg, torch, demucs (pip install demucs)
"""
import json, os, subprocess, sys
import numpy as np

SR_IN = 44100
SR = 22050
HOP = 0.01  # 10 ms


def decode(path, start, dur):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-ss', str(start), '-t', str(dur), '-i', path,
                          '-f', 'f32le', '-ac', '2', '-ar', str(SR_IN), '-'],
                         check=True, capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).T.copy()


def separate_vocals(mix):
    import torch
    from demucs.pretrained import get_model
    from demucs.apply import apply_model
    model = get_model('htdemucs')
    model.eval()
    dev = 'cuda' if torch.cuda.is_available() else 'cpu'
    x = torch.from_numpy(mix)[None]
    ref = x.mean(1, keepdim=True)
    m, s = ref.mean(), ref.std() + 1e-8
    with torch.no_grad():
        out = apply_model(model, (x - m) / s, device=dev, split=True, overlap=0.25, progress=False)[0]
    out = out * s + m
    voc = out[model.sources.index('vocals')].mean(0).cpu().numpy()
    acc = (out.sum(0) - out[model.sources.index('vocals')]).mean(0).cpu().numpy()
    return voc, acc


def yin(x, sr, fmin=70.0, fmax=1000.0, win=1024, thr=0.15):
    hop = int(round(HOP * sr))
    tmin, tmax = int(sr / fmax), int(sr / fmin)
    n = 1 + max(0, (len(x) - win - tmax) // hop)
    f0 = np.zeros(n, dtype=np.float32)
    ap = np.ones(n, dtype=np.float32)
    rms = np.zeros(n, dtype=np.float32)
    for i in range(n):
        seg = x[i * hop: i * hop + win + tmax]
        rms[i] = np.sqrt(np.mean(seg[:win] ** 2))
        # fark fonksiyonu (FFT ile)
        w = seg[:win]
        d = np.empty(tmax + 1, dtype=np.float64)
        e0 = np.dot(w, w)
        c = np.correlate(seg[:win + tmax], w, mode='valid')[:tmax + 1]
        sq = np.cumsum(np.concatenate([[0.0], seg[:win + tmax] ** 2]))
        et = sq[win:win + tmax + 1] - sq[0:tmax + 1]
        d[:] = e0 + et - 2 * c
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
        if 1 <= tau < tmax:
            a, b, c2 = cm[tau - 1], cm[tau], cm[tau + 1]
            den = a - 2 * b + c2
            dx = 0.5 * (a - c2) / den if abs(den) > 1e-12 else 0
            dx = max(-0.5, min(0.5, dx))
        else:
            dx = 0
        f0[i] = sr / (tau + dx)
        ap[i] = cm[tau]
    return f0, ap, rms


def main():
    out_dir, start, dur = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
    os.makedirs(out_dir, exist_ok=True)
    from scipy.signal import resample_poly
    for path in sys.argv[4:]:
        name = os.path.splitext(os.path.basename(path))[0]
        mix = decode(path, start, dur)
        voc, acc = separate_vocals(mix)
        voc22 = resample_poly(voc, 1, 2).astype(np.float32)
        acc22 = resample_poly(acc, 1, 2).astype(np.float32)
        f0, ap, rms = yin(voc22, SR)
        # eslik enerjisi (ayni izgarada): vokal/eslik orani -> "baskin vokal" kareleri
        hop = int(round(HOP * SR))
        arms = np.array([np.sqrt(np.mean(acc22[i * hop: i * hop + 1024] ** 2)) for i in range(len(f0))], dtype=np.float32)
        peak = np.percentile(rms, 99) + 1e-9
        voiced = (ap < 0.25) & (rms > peak * 10 ** (-30 / 20)) & (f0 > 70) & (f0 < 1000)
        # 3 kareden kisa sesli/sessiz adacilari temizle
        v = voiced.astype(np.int8)
        for val in (1, 0):
            run = 0
            for i in range(len(v) + 1):
                if i < len(v) and v[i] == val:
                    run += 1
                    continue
                if 0 < run < 4:
                    v[i - run:i] = 1 - val
                run = 0
        midi = np.where(v > 0, 69 + 12 * np.log2(np.maximum(f0, 1) / 440.0), 0)
        snr = 20 * np.log10((rms + 1e-9) / (arms + 1e-9))
        ref = {'name': name, 'start': start, 'dur': dur, 'hop': HOP,
               'midi': [round(float(m), 2) for m in midi],
               'vocSnrDb': [round(float(x), 1) for x in snr]}
        with open(os.path.join(out_dir, name + '.json'), 'w', encoding='utf-8') as f:
            json.dump(ref, f)
        print(f'{name}: voiced {v.mean() * 100:.1f}% of {len(v)} frames, median vocal/acc {np.median(snr[v > 0]):.1f} dB')


if __name__ == '__main__':
    main()
