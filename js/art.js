// Cover art: folder image → OneDrive thumbnail → embedded tag art → Cover Art Archive. Cached in IndexedDB at 300px.
import * as db from './db.js';
import { norm } from './util.js';

const mem = new Map();     // key -> objectURL or '' (none)
const pending = new Map(); // key -> song
const inflight = new Set();
const listeners = new Set();
let resolver = null;       // async (song) => Blob|null
let active = 0;
const MAX = 3;
const NONE_TTL = 7 * 864e5;

export function setArtResolver(fn) { resolver = fn; }
export function onArt(fn) { listeners.add(fn); }
export const artKey = (s) => (s.parentId || '') + '|' + norm(s.album || '');

export function getArt(s, priority = false) {
  if (!s) return null;
  const k = artKey(s);
  const v = mem.get(k);
  if (v !== undefined) return v || null;
  if (inflight.has(k)) return null;
  if (!pending.has(k)) pending.set(k, s);
  else if (priority) { pending.delete(k); pending.set(k, s); }
  while (pending.size > 80) pending.delete(pending.keys().next().value); // drop rows scrolled past
  pump();
  return null;
}
export function artNow(s) {
  return new Promise((res) => {
    const u = getArt(s, true);
    if (u !== null || mem.has(artKey(s))) return res(u || null);
    const k = artKey(s);
    const f = (key) => { if (key === k) { listeners.delete(f); res(mem.get(k) || null); } };
    listeners.add(f);
  });
}

function pump() {
  while (active < MAX && pending.size) {
    // most recently requested first (what's on screen now)
    const k = [...pending.keys()].pop();
    const s = pending.get(k);
    pending.delete(k);
    inflight.add(k);
    active++;
    resolve(k, s).finally(() => { active--; inflight.delete(k); pump(); });
  }
}

async function resolve(k, s) {
  let url = '';
  try {
    const cached = await db.get('art', k);
    if (cached && cached.blob) url = URL.createObjectURL(cached.blob);
    else if (cached && cached.none && Date.now() - cached.t < NONE_TTL) url = '';
    else if (resolver) {
      const blob = await resolver(s).catch(() => null);
      if (typeof blob === 'string') url = blob; // not cacheable (cross-origin), use directly
      else if (blob) {
        const small = await downscale(blob).catch(() => blob);
        url = URL.createObjectURL(small);
        db.set('art', k, { blob: small, t: Date.now() }).catch(() => {});
      } else db.set('art', k, { none: true, t: Date.now() }).catch(() => {});
    }
  } catch (e) { console.warn('art', e); }
  mem.set(k, url);
  for (const f of [...listeners]) f(k, url);
}

async function downscale(blob, size = 300) {
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, size / Math.max(bmp.width, bmp.height));
  if (scale >= 1 && blob.size < 80000) return blob;
  const c = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return c.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
}

export async function clearArtCache() {
  await db.clear('art');
  for (const u of mem.values()) if (u) URL.revokeObjectURL(u);
  mem.clear();
}

// Placeholder color for songs without art
export function placeholderHue(s) {
  const t = (s.album || s.artist || s.title || '').toString();
  let h = 0;
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) % 360;
  return h;
}
