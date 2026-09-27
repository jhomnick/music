// Minimal IndexedDB key/value wrapper. Stores: kv (library, userdata, caches), art (cover images)
const DB = 'music', VER = 1;
let dbp;

function open() {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB, VER);
      r.onupgradeneeded = () => {
        const d = r.result;
        for (const s of ['kv', 'art']) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s);
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  return dbp;
}

async function tx(store, mode, fn) {
  const d = await open();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    const req = fn(s);
    t.oncomplete = () => res(req?.result);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}

export const get = (store, key) => tx(store, 'readonly', (s) => s.get(key));
export const set = (store, key, val) => tx(store, 'readwrite', (s) => s.put(val, key));
export const del = (store, key) => tx(store, 'readwrite', (s) => s.delete(key));
export const clear = (store) => tx(store, 'readwrite', (s) => s.clear());
