// CaYa Rhythm - Sarki kutuphanesi (IndexedDB)
// Analiz edilen sarkilar ses dosyasiyla birlikte tarayicida saklanir; tekrar
// acildiginda yeniden analiz gerekmez. Hicbir veri cihazdan cikmaz.

const DB_NAME = 'caya-library';
const STORE = 'songs';
// analiz motoru surumu: degisirse eski analizler yeniden hesaplanir
export const ANALYSIS_VERSION = 8;

let dbp = null;
function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) { reject(new Error('IndexedDB yok')); return; }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

function tx(mode, fn) {
  return db().then(d => new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const st = t.objectStore(STORE);
    let out;
    Promise.resolve(fn(st)).then(r => { out = r; });
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}
const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export function songId(name, size) { return `${name}|${size}`; }

export async function saveSong({ id, name, size, type, data, analysis }) {
  const rec = {
    id, name, size, type,
    file: new Blob([data], { type: type || 'audio/mpeg' }),
    analysis, version: ANALYSIS_VERSION,
    duration: analysis.duration, bpm: analysis.bpm,
    addedAt: Date.now(), playedAt: Date.now()
  };
  return tx('readwrite', st => reqP(st.put(rec)));
}

export async function listSongs() {
  const all = await tx('readonly', st => reqP(st.getAll()));
  // liste icin hafif kopya (Blob/analiz tasima)
  return (all || [])
    .map(r => ({ id: r.id, name: r.name, duration: r.duration, bpm: r.bpm, playedAt: r.playedAt, stale: r.version !== ANALYSIS_VERSION }))
    .sort((a, b) => b.playedAt - a.playedAt);
}

export async function loadSong(id) {
  const rec = await tx('readonly', st => reqP(st.get(id)));
  if (!rec) return null;
  rec.playedAt = Date.now();
  tx('readwrite', st => reqP(st.put(rec))).catch(() => {});
  return rec;
}

export async function deleteSong(id) {
  return tx('readwrite', st => reqP(st.delete(id)));
}
