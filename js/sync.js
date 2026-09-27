// OneDrive sync for library.json.gz and userdata.json (stored in OneDrive/Apps/Music)
import { appDownload, appUpload, appMeta } from './graph.js';
import * as U from './userdata.js';
import { LIB_FILE, saveLocal, parseBlob, setLibrary } from './library.js';

const ETAG_KEY = 'music.libEtag';
let udEtag = null;
let pulled = false;

export async function pullUserData() {
  const r = await appDownload(U.UD_FILE);
  pulled = true;
  if (!r) { udEtag = null; return false; }
  udEtag = r.meta.eTag;
  try { U.adoptMerged(JSON.parse(await r.blob.text())); } catch (e) { console.warn('Bad userdata file', e); }
  return true;
}

export async function pushUserData() {
  if (!pulled) await pullUserData();
  for (let t = 0; t < 4; t++) {
    try {
      const blob = new Blob([JSON.stringify(U.getUd())], { type: 'application/json' });
      const res = await appUpload(U.UD_FILE, blob, udEtag || undefined);
      udEtag = res?.eTag || null;
      return;
    } catch (e) {
      if (e.status === 412 || e.status === 409) { await pullUserData(); continue; } // someone else wrote: merge + retry
      if (e.status === 404) { udEtag = null; continue; }
      throw e;
    }
  }
}

export const remoteUserData = { push: pushUserData, pull: pullUserData };

export function localLibEtag() { return localStorage.getItem(ETAG_KEY); }

export async function remoteLibraryMeta() {
  return appMeta(LIB_FILE);
}

export async function downloadLibrary(onStatus) {
  onStatus?.('Downloading library from OneDrive…');
  const r = await appDownload(LIB_FILE);
  if (!r) return false;
  onStatus?.('Unpacking library…');
  const obj = await parseBlob(r.blob);
  setLibrary(obj);
  await saveLocal(r.blob);
  try { localStorage.setItem(ETAG_KEY, r.meta.eTag); } catch { /* ignore */ }
  return true;
}

export async function uploadLibrary() {
  const blob = await saveLocal();
  const res = await appUpload(LIB_FILE, blob);
  if (res?.eTag) try { localStorage.setItem(ETAG_KEY, res.eTag); } catch { /* ignore */ }
  return res;
}
