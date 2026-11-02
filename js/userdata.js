// Personal data: play/skip counts, ratings, custom playlists.
// Conflict-free sync across devices: each device only writes its own counters (summed on read);
// ratings and playlists are last-writer-wins by timestamp.
import * as db from './db.js';
import { lib, derive } from './library.js';
import { uid, debounce } from './util.js';

export const UD_FILE = 'userdata.json';
const DEV_KEY = 'music.device';

export const deviceId = localStorage.getItem(DEV_KEY) || (() => {
  const id = uid();
  try { localStorage.setItem(DEV_KEY, id); } catch { /* ignore */ }
  return id;
})();

export let ud = empty();
function empty() { return { format: 1, devices: {}, ratings: {}, playlists: {}, edits: {} }; }

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

// ---- song info corrections ----
// Stored as per-field overrides ({songId: {field: [value, time, original]}}) rather than in the
// library itself, so they survive rescans and sync to every device. value === null means "restored".
export const EDITABLE = ['title', 'artist', 'albumArtist', 'album', 'genre', 'year', 'track'];

export function editSongs(ids, patch) {
  const now = Date.now();
  for (const id of ids) {
    const s = lib.byId.get(id);
    if (!s) continue;
    const rec = (ud.edits[id] ||= {});
    for (const [f, v] of Object.entries(patch)) {
      if (!EDITABLE.includes(f)) continue;
      const prev = rec[f];
      const orig = prev ? prev[2] : s[f] ?? null;
      if (v === null) { if (prev) rec[f] = [null, now, orig]; continue; } // restore
      if ((s[f] ?? '') === v) continue;
      rec[f] = [v, now, orig];
    }
    applyEdit(s);
  }
  touch('edit', ids.length === 1 ? ids[0] : null);
}

export function revertSong(id) {
  const rec = ud.edits[id];
  if (!rec) return;
  editSongs([id], Object.fromEntries(Object.keys(rec).map((f) => [f, null])));
}

export function hasEdits(id) {
  const rec = ud.edits[id];
  return !!rec && Object.values(rec).some((x) => x[0] !== null);
}

export function originalValue(id, f) {
  const x = ud.edits[id]?.[f];
  return x ? x[2] : undefined;
}

function applyEdit(s) {
  const rec = ud.edits[s.id];
  if (!rec) return false;
  let changed = false;
  for (const [f, [v, , orig]] of Object.entries(rec)) {
    const val = v === null ? orig : v;
    if ((s[f] ?? null) !== (val ?? null)) { s[f] = val ?? undefined; changed = true; }
  }
  if (changed) { s.edited = 1; derive(s, true); }
  return changed;
}
export function applyEdits() {
  for (const id of Object.keys(ud.edits)) { const s = lib.byId.get(id); if (s) applyEdit(s); }
  lib.version++;
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
  applyEdits();
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
  for (const src of [a.edits || {}, b.edits || {}])
    for (const [id, rec] of Object.entries(src)) {
      const o = (out.edits[id] ||= {});
      for (const [f, x] of Object.entries(rec)) if (!o[f] || x[1] > o[f][1]) o[f] = x;
    }
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
