// Personal data: play/skip counts, ratings, custom playlists.
// Conflict-free sync across devices: each device only writes its own counters (summed on read);
// ratings and playlists are last-writer-wins by timestamp.
import * as db from './db.js';
import { lib } from './library.js';
import { uid, debounce } from './util.js';

export const UD_FILE = 'userdata.json';
const DEV_KEY = 'music.device';

export const deviceId = localStorage.getItem(DEV_KEY) || (() => {
  const id = uid();
  try { localStorage.setItem(DEV_KEY, id); } catch { /* ignore */ }
  return id;
})();

export let ud = empty();
function empty() { return { format: 1, devices: {}, ratings: {}, playlists: {} }; }

export const events = new EventTarget();
const emit = (type, detail) => events.dispatchEvent(new CustomEvent(type, { detail }));

let remote = null; // { push(ud) , pull() } set by sync layer
export function setRemote(r) { remote = r; }

function deviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Mac/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  return 'Browser';
}
function mine() {
  return (ud.devices[deviceId] ||= { name: deviceName(), updated: 0, stats: {} });
}

export let dirtyRemote = false;
function touch(kind, id) {
  mine().updated = Date.now();
  dirtyRemote = true;
  saveLocalSoon();
  pushSoon();
  emit('change', { kind, id });
}

// ---- recording ----
export function recordPlay(id) {
  const a = (mine().stats[id] ||= [0, 0, 0]);
  a[0]++; a[2] = Date.now();
  applySong(id);
  touch('play', id);
}
export function recordSkip(id) {
  const a = (mine().stats[id] ||= [0, 0, 0]);
  a[1]++;
  applySong(id);
  touch('skip', id);
}
export function setRating(id, r) {
  ud.ratings[id] = [r, Date.now()];
  applySong(id);
  touch('rating', id);
}
export function resetStats(id) {
  for (const d of Object.values(ud.devices)) if (d.stats[id]) { d.stats[id] = [0, 0, 0]; d.updated = Date.now(); }
  applySong(id);
  touch('stats', id);
}

// ---- playlists ----
export function playlists() {
  return Object.values(ud.playlists).filter((p) => !p.deleted).sort((a, b) => a.name.localeCompare(b.name));
}
export function createPlaylist(name, songIds) {
  const id = 'p' + uid().replace(/-/g, '').slice(0, 12);
  const now = Date.now();
  ud.playlists[id] = { id, name, songIds: [...songIds], created: now, updated: now };
  applyMembership();
  touch('playlist', id);
  return id;
}
export function updatePlaylist(id, patch) {
  const p = ud.playlists[id];
  if (!p) return;
  Object.assign(p, patch, { updated: Date.now() });
  applyMembership();
  touch('playlist', id);
}
export function deletePlaylist(id) {
  const p = ud.playlists[id];
  if (!p) return;
  ud.playlists[id] = { id, name: p.name, deleted: true, songIds: [], updated: Date.now() };
  applyMembership();
  touch('playlist', id);
}

// ---- derived fields on songs ----
export function applySong(id) {
  const s = lib.byId.get(id);
  if (!s) return;
  let p = 0, k = 0, l = 0;
  for (const d of Object.values(ud.devices)) {
    const a = d.stats[id];
    if (a) { p += a[0]; k += a[1]; if (a[2] > l) l = a[2]; }
  }
  s._plays = p; s._skips = k; s._last = l || null;
  const r = ud.ratings[id];
  s._rating = r ? r[0] : s.fileRating || 0;
}

export function applyAll() {
  for (const s of lib.songs) { s._plays = 0; s._skips = 0; s._last = null; s._rating = s.fileRating || 0; }
  for (const d of Object.values(ud.devices)) {
    for (const [id, a] of Object.entries(d.stats)) {
      const s = lib.byId.get(id);
      if (!s) continue;
      s._plays += a[0]; s._skips += a[1];
      if (a[2] && (!s._last || a[2] > s._last)) s._last = a[2];
    }
  }
  for (const [id, r] of Object.entries(ud.ratings)) {
    const s = lib.byId.get(id);
    if (s) s._rating = r[0];
  }
  applyMembership();
}

export function applyMembership() {
  const m = new Map();
  const add = (ids, name) => { for (const id of ids) { const a = m.get(id); if (a) { if (!a.includes(name)) a.push(name); } else m.set(id, [name]); } };
  for (const p of playlists()) add(p.songIds, p.name);
  for (const p of Object.values(lib.meta.importedPlaylists || {})) add(p.songIds, p.name);
  for (const s of lib.songs) { const a = m.get(s.id); s._pl = a ? a.join(', ') : ''; }
  lib.version++;
}

// ---- merge ----
export function merge(a, b) {
  const out = empty();
  const ids = new Set([...Object.keys(a.devices || {}), ...Object.keys(b.devices || {})]);
  for (const id of ids) {
    const x = a.devices?.[id], y = b.devices?.[id];
    out.devices[id] = !x ? y : !y ? x : (y.updated > x.updated ? y : x);
  }
  for (const src of [a.ratings || {}, b.ratings || {}])
    for (const [id, r] of Object.entries(src)) if (!out.ratings[id] || r[1] > out.ratings[id][1]) out.ratings[id] = r;
  for (const src of [a.playlists || {}, b.playlists || {}])
    for (const [id, p] of Object.entries(src)) if (!out.playlists[id] || p.updated > out.playlists[id].updated) out.playlists[id] = p;
  return out;
}

// ---- persistence ----
let storeKey = 'userdata';
export function setStoreKey(k) { storeKey = k; }
export async function loadLocal() {
  const v = await db.get('kv', storeKey);
  if (v) ud = merge(empty(), v);
}
const saveLocalSoon = debounce(() => db.set('kv', storeKey, ud).catch(() => {}), 800);
export function flushLocal() { return saveLocalSoon.flush(); }

export function adoptMerged(remoteUd) {
  ud = merge(ud, remoteUd);
  applyAll();
  saveLocalSoon();
  emit('change', { kind: 'sync' });
}

const pushSoon = debounce(() => pushNow(), 15000);
export async function pushNow() {
  if (!remote || !dirtyRemote) return;
  dirtyRemote = false;
  try {
    await remote.push();
  } catch (e) {
    dirtyRemote = true;
    console.warn('Sync failed', e);
    setTimeout(pushSoon, 60000);
  }
}
export function getUd() { return ud; }
