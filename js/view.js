// Column definitions, filtering and sorting
import { fmtTime, fmtSize, fmtDate, norm, sortText } from './util.js';

const txt = (k) => (s) => s[k];
export const COLUMNS = [
  { key: 'art', label: 'Cover', w: 44, type: 'art', noSort: true, noFilter: true },
  { key: 'title', label: 'Title', w: 280, type: 'text', get: (s) => s.title || s.file },
  { key: 'song', label: 'Song + Artist', w: 220, type: 'song', flex: true, get: (s) => s.title || s.file, sub: (s) => [s.artist, s.album].filter(Boolean).join(' — ') },
  { key: 'artist', label: 'Artist', w: 190, type: 'text', get: txt('artist'), sortBy: 'artistSort' },
  { key: 'album', label: 'Album', w: 210, type: 'text', get: txt('album') },
  { key: 'albumArtist', label: 'Album Artist', w: 170, type: 'text', get: txt('albumArtist'), sortBy: 'artistSort' },
  { key: 'genre', label: 'Genre', w: 130, type: 'text', get: txt('genre') },
  { key: 'year', label: 'Year', w: 64, type: 'num', get: txt('year') },
  { key: 'track', label: '#', w: 46, type: 'num', get: txt('track') },
  { key: 'disc', label: 'Disc', w: 52, type: 'num', get: txt('disc') },
  { key: 'duration', label: 'Time', w: 68, type: 'time', get: txt('duration'), fmt: fmtTime },
  { key: 'bitrate', label: 'Bitrate', w: 84, type: 'num', get: txt('bitrate'), fmt: (v) => (v ? v + ' kbps' : '') },
  { key: 'ext', label: 'Format', w: 70, type: 'text', get: (s) => (s.ext || '').toUpperCase() },
  { key: 'size', label: 'Size', w: 80, type: 'num', get: txt('size'), fmt: fmtSize },
  { key: 'label', label: 'Label', w: 170, type: 'text', get: txt('label') },
  { key: 'pop', label: 'Public Rating', w: 110, type: 'pop', get: txt('pop') },
  { key: 'rating', label: 'My Rating', w: 104, type: 'rating', get: (s) => s._rating || 0 },
  { key: 'plays', label: 'Plays', w: 62, type: 'num', get: (s) => s._plays || 0 },
  { key: 'skips', label: 'Skips', w: 62, type: 'num', get: (s) => s._skips || 0 },
  { key: 'lastPlayed', label: 'Last Played', w: 112, type: 'date', get: (s) => s._last || null },
  { key: 'added', label: 'Date Added', w: 108, type: 'date', get: (s) => s._added || null },
  { key: 'composer', label: 'Composer', w: 160, type: 'text', get: txt('composer') },
  { key: 'playlists', label: 'Playlists', w: 190, type: 'text', get: (s) => s._pl },
  { key: 'path', label: 'Folder', w: 280, type: 'text', get: (s) => s._path },
  { key: 'file', label: 'File Name', w: 240, type: 'text', get: txt('file') },
];
export const COL = Object.fromEntries(COLUMNS.map((c) => [c.key, c]));

export const DEFAULT_WIDE = ['art', 'title', 'artist', 'album', 'genre', 'year', 'duration', 'bitrate', 'rating', 'plays', 'skips'];
export const DEFAULT_NARROW = ['art', 'song', 'duration'];

export function colText(col, s) {
  const v = col.get(s);
  if (v == null || v === '') return '';
  if (col.fmt) return col.fmt(v);
  if (col.type === 'date') return fmtDate(v);
  if (col.type === 'rating') return v ? '★'.repeat(v) : '';
  if (col.type === 'pop') return String(v);
  return String(v);
}

// ---- filter parsing ----
function parseNum(str, isTime) {
  str = str.trim();
  if (isTime && /^\d+:\d{1,2}$/.test(str)) { const [m, s] = str.split(':'); return +m * 60 + +s; }
  const n = parseFloat(str);
  return isNaN(n) ? null : n;
}
function parseDate(str) {
  str = str.trim();
  const rel = /^(\d+)\s*([dwmy])$/i.exec(str);
  if (rel) {
    const mult = { d: 1, w: 7, m: 30, y: 365 }[rel[2].toLowerCase()];
    return Date.now() - rel[1] * mult * 864e5;
  }
  const t = Date.parse(str.length === 4 ? str + '-01-01' : str);
  return isNaN(t) ? null : t;
}

// Returns predicate(song) for a column filter string. Supports:
//  text:  word (contains) · =exact · !notcontains · ^startswith · = (blank)
//  numbers/dates: >5, <=1990, 1970-1979, =3, 1970..1979 ; dates also "<30d" (within 30 days)
export function buildMatcher(col, q) {
  q = (q || '').trim();
  if (!q) return null;
  const get = col.get;
  if (col.type === 'num' || col.type === 'time' || col.type === 'rating' || col.type === 'pop' || col.type === 'date') {
    const isDate = col.type === 'date', isTime = col.type === 'time';
    const P = isDate ? parseDate : (x) => parseNum(x, isTime);
    let m;
    if (isDate && (m = /^<\s*(\d+\s*[dwmy])$/i.exec(q))) { const t = P(m[1]); return (s) => (get(s) || 0) >= t; }
    if (isDate && (m = /^>\s*(\d+\s*[dwmy])$/i.exec(q))) { const t = P(m[1]); return (s) => { const v = get(s); return v != null && v < t; }; }
    if ((m = /^(>=|<=|>|<|=|!=)\s*(.+)$/.exec(q))) {
      const n = P(m[2]);
      if (n != null) {
        const op = m[1];
        return (s) => {
          let v = get(s);
          if (v == null || v === '') { if (op === '<' || op === '<=' ) v = 0; else return op === '!='; }
          if (isDate) v = +v;
          return op === '>' ? v > n : op === '<' ? v < n : op === '>=' ? v >= n : op === '<=' ? v <= n : op === '=' ? (isDate ? sameDay(v, n) : v == n) : v != n;
        };
      }
    }
    if ((m = /^(.+?)\s*(?:\.\.|–|-(?=\s*\d))\s*(.+)$/.exec(q)) && !isDate) {
      const a = P(m[1]), b = P(m[2]);
      if (a != null && b != null) return (s) => { const v = get(s); return v != null && v >= a && v <= b; };
    }
    if (!isDate && col.type !== 'pop') {
      const n = P(q);
      if (n != null && /^[\d.:]+$/.test(q)) return (s) => get(s) == n;
    }
    const nq = norm(q);
    return (s) => norm(colText(col, s)).includes(nq);
  }
  if (col.type === 'song') { const t = norm(q); return (s) => norm(get(s) + ' ' + col.sub(s)).includes(t); }
  if (q === '=') return (s) => !get(s);
  if (q === '!=' || q === '!') return (s) => !!get(s);
  if (q[0] === '=') { const t = norm(q.slice(1)); return (s) => norm(get(s)) === t; }
  if (q[0] === '!') { const t = norm(q.slice(1)); return (s) => !norm(get(s)).includes(t); }
  if (q[0] === '^') { const t = norm(q.slice(1)); return (s) => norm(get(s)).startsWith(t); }
  const t = norm(q);
  return (s) => norm(get(s)).includes(t);
}
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

export function searchTokens(q) {
  const out = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m;
  while ((m = re.exec(q || ''))) out.push(norm(m[1] || m[2]));
  return out;
}

export function applyView(list, { search = '', filters = {}, sort = [] } = {}) {
  const preds = [];
  const toks = searchTokens(search);
  if (toks.length) preds.push((s) => toks.every((t) => s._search.includes(t)));
  for (const [k, q] of Object.entries(filters)) {
    const col = COL[k];
    const p = col && buildMatcher(col, q);
    if (p) preds.push(p);
  }
  let rows = preds.length ? list.filter((s) => preds.every((p) => p(s))) : list.slice();
  if (sort.length) rows = sortRows(rows, sort);
  return rows;
}

function sortValue(col, s) {
  const v = col.get(s);
  if (col.type === 'text' || col.type === 'song') {
    if (!v) return null;
    return col.sortBy === 'artistSort' ? sortText(v) : norm(v);
  }
  return v == null || v === '' ? null : +v;
}

export function sortRows(rows, sort) {
  const specs = sort.map(({ key, dir }) => ({ col: COL[key], dir: dir === 'desc' ? -1 : 1 })).filter((x) => x.col);
  // Implicit tie-breakers keep albums in track order
  for (const k of ['artist', 'year', 'album', 'disc', 'track', 'title']) if (!specs.some((x) => x.col.key === k)) specs.push({ col: COL[k], dir: 1, tie: true });
  const keyed = rows.map((s, i) => ({ s, i, k: specs.map((x) => sortValue(x.col, s)) }));
  keyed.sort((a, b) => {
    for (let j = 0; j < specs.length; j++) {
      const x = a.k[j], y = b.k[j];
      if (x === y) continue;
      if (x == null) return 1;      // blanks last regardless of direction
      if (y == null) return -1;
      const c = typeof x === 'number' ? x - y : x < y ? -1 : 1;
      if (c) return c * specs[j].dir;
    }
    return a.i - b.i;
  });
  return keyed.map((x) => x.s);
}
