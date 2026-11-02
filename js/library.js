// In-memory library model + persistence (IndexedDB locally, gzip JSON on OneDrive)
import * as db from './db.js';
import { gzipText, gunzipText, norm } from './util.js';

export const LIB_FILE = 'library.json.gz';

export const lib = {
  songs: [],
  byId: new Map(),
  meta: emptyMeta(),
  version: 0, // bumps whenever songs change (views re-filter)
};

function emptyMeta() {
  return {
    format: 1,
    rootId: null,
    rootPath: '',
    deltaLink: null,
    scannedAt: 0,
    savedAt: 0,
    folders: {},          // folderId -> [name, parentId]
    covers: {},           // folderId -> [imageItemId, score]
    playlistFiles: {},    // itemId -> {name, parentId, modified}
    importedPlaylists: {},// itemId -> {id, name, songIds, total}
    enrich: { artists: {}, albums: {}, tagsDone: 0 },
    similar: {},          // normArtist -> [[name, match], ...]
  };
}

export function setLibrary(obj) {
  const { songs = [], ...meta } = obj || {};
  lib.meta = Object.assign(emptyMeta(), meta);
  lib.songs = songs;
  rebuild();
}

export function rebuild() {
  lib.byId = new Map(lib.songs.map((s) => [s.id, s]));
  pathCache.clear();
  for (const s of lib.songs) derive(s);
  lib.version++;
}

// ---- folder paths ----
const pathCache = new Map();
export function folderPath(id) {
  if (!id) return '';
  if (pathCache.has(id)) return pathCache.get(id);
  const f = lib.meta.folders[id];
  let p = '';
  if (f && id !== lib.meta.rootId) {
    const guard = new Set([id]);
    const parts = [f[0]];
    let pid = f[1];
    while (pid && pid !== lib.meta.rootId && lib.meta.folders[pid] && !guard.has(pid)) {
      guard.add(pid);
      parts.unshift(lib.meta.folders[pid][0]);
      pid = lib.meta.folders[pid][1];
    }
    p = parts.join('/');
  }
  pathCache.set(id, p);
  return p;
}
export function clearPathCache() { pathCache.clear(); }

// ---- genres ----
const FAMILIES = [
  ['Metal', /metal|grindcore|djent|thrash/],
  ['Punk', /punk|hardcore|\bemo\b|screamo/],
  ['Hip-Hop', /hip.?hop|\brap\b|trap\b|grime|gangsta/],
  ['R&B / Soul', /r&b|r ?n ?b|rhythm (and|&) blues|soul|funk|motown|disco|quiet storm/],
  ['Electronic', /electro|techno|house|trance|\bedm\b|dance|dubstep|drum.?(n|and).?bass|ambient|synth|idm|downtempo|chill|trip.?hop|breakbeat/],
  ['Jazz', /jazz|swing|bebop|bossa|big band|fusion/],
  ['Blues', /blues/],
  ['Country', /country|bluegrass|americana|honky|outlaw|western/],
  ['Folk', /folk|singer.?songwriter|acoustic|celtic/],
  ['Classical', /classical|baroque|opera|symphon|orchestr|chamber|concerto|sonata|choral/],
  ['Reggae', /reggae|\bska\b|\bdub\b|dancehall|rocksteady/],
  ['Latin', /latin|salsa|bachata|reggaeton|samba|tango|cumbia|merengue|mariachi|flamenco/],
  ['Soundtrack', /soundtrack|\bscore\b|musical|broadway|\bfilm\b|video game|\bost\b/],
  ['Gospel / Christian', /christian|gospel|worship|\bccm\b/],
  ['Holiday', /christmas|holiday|xmas/],
  ['World', /world|afro|k-?pop|j-?pop|bollywood|indian|african|celtic/],
  ['Pop', /\bpop\b|pop\b|^pop|teen|bubblegum/],
  ['Rock', /rock|grunge|alternative|\balt\b|indie|new wave|psychedel|\bprog|british invasion|surf|garage|shoegaze|britpop|post.?punk/],
  ['Easy Listening', /easy listening|lounge|oldies|standards|\bvocal\b|adult contemporary|crooner|big band/],
  ['Comedy / Spoken', /comedy|spoken|audiobook|podcast|speech/],
];

export function genreTokens(g) {
  if (!g) return [];
  return String(g).split(/\s*[;,/|]\s*|\s+&\s+(?=[A-Z])/).map((x) => norm(x).trim()).filter(Boolean);
}
export function genreFamilies(tokens) {
  const out = new Set();
  for (const t of tokens) for (const [name, re] of FAMILIES) if (re.test(t)) out.add(name);
  return out;
}
export const FAMILY_NAMES = FAMILIES.map((f) => f[0]);

export function derive(s) {
  if (s.year != null && s.year !== '') s.year = +s.year || undefined;
  if (s.track != null && s.track !== '') s.track = +s.track || undefined;
  s._path = folderPath(s.parentId);
  s._added = Date.parse(s.added) || 0;
  s._gen = genreTokens(s.genre);
  s._fam = genreFamilies(s._gen);
  s._search = norm([s.title, s.artist, s.albumArtist, s.album, s.genre, s.year, s.composer, s.label, s.file].filter(Boolean).join(' \u0001 '));
  if (s._plays === undefined) { s._plays = 0; s._skips = 0; s._last = null; s._rating = s.fileRating || 0; s._pl = ''; }
}

// ---- persistence ----
function replacer(k, v) {
  if (k && k.charCodeAt(0) === 95) return undefined; // "_" derived fields
  if (v === null || v === '' || v === false) return undefined;
  return v;
}
export function serialize() {
  return JSON.stringify({ ...lib.meta, savedAt: Date.now(), songs: lib.songs }, replacer);
}

export async function saveLocal(blob) {
  blob = blob || (await gzipText(serialize()));
  await db.set('kv', 'library', blob);
  return blob;
}

export async function loadLocal() {
  const b = await db.get('kv', 'library');
  if (!b) return false;
  setLibrary(JSON.parse(await gunzipText(b)));
  return true;
}

export async function parseBlob(blob) {
  return JSON.parse(await gunzipText(blob));
}

export function stats() {
  let dur = 0, size = 0;
  const artists = new Set(), albums = new Set();
  for (const s of lib.songs) {
    dur += s.duration || 0; size += s.size || 0;
    if (s.artist) artists.add(norm(s.artist));
    if (s.album) albums.add(norm((s.albumArtist || s.artist) + '|' + s.album));
  }
  return { songs: lib.songs.length, artists: artists.size, albums: albums.size, dur, size };
}
