// Microsoft Graph helpers: retries, paging, batching, app-folder file storage, stream URLs
import { getToken } from './auth.js';
import { sleep } from './util.js';

const BASE = 'https://graph.microsoft.com/v1.0';

export class GraphError extends Error {
  constructor(status, body) {
    let msg = body;
    try { msg = JSON.parse(body).error.message; } catch { /* keep raw */ }
    super(`Graph ${status}: ${msg}`);
    this.status = status;
    this.body = body;
  }
}

export async function gfetch(pathOrUrl, opts = {}, tries = 0) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : BASE + pathOrUrl;
  const token = await getToken(tries > 0 && opts._authRetry);
  let res;
  try {
    res = await fetch(url, { ...opts, headers: { Authorization: 'Bearer ' + token, ...(opts.headers || {}) } });
  } catch (e) {
    if (tries < 5) { await sleep(1000 * 2 ** tries); return gfetch(pathOrUrl, opts, tries + 1); }
    throw e;
  }
  if ((res.status === 429 || res.status === 503 || res.status === 502 || res.status === 504) && tries < 7) {
    const ra = parseInt(res.headers.get('Retry-After'), 10);
    await sleep((isNaN(ra) ? Math.min(30, 2 ** tries) : ra) * 1000);
    return gfetch(pathOrUrl, opts, tries + 1);
  }
  if (res.status === 401 && !opts._authRetry) {
    return gfetch(pathOrUrl, { ...opts, _authRetry: true }, tries + 1);
  }
  return res;
}

export async function gjson(path, opts) {
  const r = await gfetch(path, opts);
  if (!r.ok) throw new GraphError(r.status, await r.text());
  return r.status === 204 ? null : r.json();
}

// Up to 20 GETs in one request
export async function batchGet(paths) {
  const out = new Array(paths.length);
  let todo = paths.map((p, i) => i);
  for (let attempt = 0; todo.length && attempt < 5; attempt++) {
    const body = { requests: todo.map((i) => ({ id: String(i), method: 'GET', url: paths[i] })) };
    const j = await gjson('/$batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const retry = [];
    let wait = 0;
    for (const r of j.responses) {
      if (r.status === 429 || r.status >= 500) {
        retry.push(+r.id);
        wait = Math.max(wait, parseInt(r.headers?.['Retry-After'], 10) || 2);
      } else out[+r.id] = r;
    }
    todo = retry;
    if (todo.length) await sleep(wait * 1000);
  }
  return out;
}

// ---- Streaming URLs (pre-authenticated, valid ~1 hour) ----
const urlCache = new Map();
export function forgetUrl(id) { urlCache.delete(id); }
export async function downloadUrl(id) {
  const c = urlCache.get(id);
  if (c && c.exp > Date.now()) return c.url;
  let j = await gjson(`/me/drive/items/${id}?select=id,@microsoft.graph.downloadUrl`);
  let url = j['@microsoft.graph.downloadUrl'];
  if (!url) { j = await gjson(`/me/drive/items/${id}`); url = j['@microsoft.graph.downloadUrl']; }
  if (!url) throw new Error('No download URL for item');
  urlCache.set(id, { url, exp: Date.now() + 45 * 60e3 });
  return url;
}
export async function downloadUrls(ids) {
  const need = ids.filter((id) => !(urlCache.get(id)?.exp > Date.now()));
  for (let i = 0; i < need.length; i += 20) {
    const chunk = need.slice(i, i + 20);
    const rs = await batchGet(chunk.map((id) => `/me/drive/items/${id}?select=id,@microsoft.graph.downloadUrl`));
    rs.forEach((r, k) => {
      const url = r?.body?.['@microsoft.graph.downloadUrl'];
      if (url) urlCache.set(chunk[k], { url, exp: Date.now() + 45 * 60e3 });
    });
  }
  return ids.map((id) => urlCache.get(id)?.url || null);
}

// ---- App folder (OneDrive/Apps/Music) ----
const APP = '/me/drive/special/approot';

export async function appMeta(name) {
  const r = await gfetch(`${APP}:/${encodeURIComponent(name)}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new GraphError(r.status, await r.text());
  return r.json();
}

export async function appDownload(name) {
  const meta = await appMeta(name);
  if (!meta) return null;
  const url = meta['@microsoft.graph.downloadUrl'];
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('Download failed: ' + res.status);
  return { meta, blob: await res.blob() };
}

// Upload (simple PUT under 4 MB, resumable session above). ifMatch → 412 on conflict.
export async function appUpload(name, blob, ifMatch) {
  const path = `${APP}:/${encodeURIComponent(name)}`;
  if (blob.size < 4 * 1024 * 1024) {
    const headers = { 'Content-Type': 'application/octet-stream' };
    if (ifMatch) headers['If-Match'] = ifMatch;
    const r = await gfetch(`${path}:/content`, { method: 'PUT', headers, body: blob });
    if (!r.ok) throw new GraphError(r.status, await r.text());
    return r.json();
  }
  const headers = { 'Content-Type': 'application/json' };
  if (ifMatch) headers['If-Match'] = ifMatch;
  const sess = await gjson(`${path}:/createUploadSession`, {
    method: 'POST', headers,
    body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } }),
  });
  const CHUNK = 327680 * 16; // 5 MB, multiple of 320 KiB
  let last;
  for (let start = 0; start < blob.size; start += CHUNK) {
    const end = Math.min(blob.size, start + CHUNK);
    let ok = false;
    for (let t = 0; t < 5 && !ok; t++) {
      try {
        const r = await fetch(sess.uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Range': `bytes ${start}-${end - 1}/${blob.size}` },
          body: blob.slice(start, end),
        });
        if (r.ok) { ok = true; if (r.status === 200 || r.status === 201) last = await r.json(); }
        else if (r.status >= 500 || r.status === 429) await sleep(2000 * (t + 1));
        else throw new GraphError(r.status, await r.text());
      } catch (e) {
        if (e instanceof GraphError || t === 4) throw e;
        await sleep(2000 * (t + 1));
      }
    }
  }
  return last;
}

// Thumbnail URL for any drive item (image or audio with embedded art)
export async function thumbUrl(id) {
  const j = await gjson(`/me/drive/items/${id}/thumbnails`);
  const t = j.value && j.value[0];
  if (!t) return null;
  return (t.large || t.medium || t.small || {}).url || null;
}
