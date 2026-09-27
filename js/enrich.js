// Background enrichment:
//  1. File tags  – record label, ratings & play counts saved by other players, missing info (MP3/FLAC)
//  2. Last.fm    – public popularity (listeners), similar artists, genre for untagged songs (needs free API key)
//  3. MusicBrainz – record label + release id (for cover art) per album
import { lib } from './library.js';
import { downloadUrls } from './graph.js';
import { readTags, TAG_EXT } from './tags.js';
import { applySong } from './userdata.js';
import { norm, normTitle, sleep } from './util.js';

const popFromListeners = (l) => Math.max(0, Math.min(100, Math.round(((Math.log10(l + 1) - 2) / 4.5) * 100)));

// ---------- 1. file tags ----------
async function runTags(ctx) {
  const todo = lib.songs.filter((s) => TAG_EXT.has(s.ext) && !s.tagged);
  ctx.total = todo.length; ctx.done = 0;
  for (let i = 0; i < todo.length; i += 20) {
    if (ctx.signal.aborted) return;
    const chunk = todo.slice(i, i + 20);
    let urls;
    try { urls = await downloadUrls(chunk.map((s) => s.id)); } catch (e) { ctx.errors++; await sleep(3000); continue; }
    let next = 0;
    const worker = async () => {
      while (next < chunk.length) {
        const k = next++;
        const s = chunk[k];
        try {
          if (urls[k]) {
            const t = await readTags(urls[k], s.ext, {});
            if (t) applyTags(s, t);
          }
          s.tagged = 1;
        } catch { ctx.errors++; }
        ctx.done++;
      }
    };
    await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);
    ctx.report();
    ctx.changed = true;
  }
}

function applyTags(s, t) {
  if (t.label && !s.label) s.label = t.label;
  if (t.rating) s.fileRating = t.rating;
  if (t.playcount) s.filePlays = t.playcount;
  const fill = (k) => { if (t[k] && (!s[k] || (s.guessed && ['title', 'artist', 'album'].includes(k)))) s[k] = t[k]; };
  ['title', 'artist', 'albumArtist', 'album', 'genre', 'track', 'disc', 'composer'].forEach(fill);
  if (!s.year && (t.year || t.origYear)) s.year = t.year || t.origYear;
  if (t.title && t.artist && t.album) delete s.guessed;
  applySong(s.id);
}

// ---------- 2. Last.fm ----------
async function lfm(key, params) {
  const q = new URLSearchParams({ ...params, api_key: key, format: 'json', autocorrect: '1' });
  for (let t = 0; t < 4; t++) {
    const r = await fetch('https://ws.audioscrobbler.com/2.0/?' + q);
    const j = await r.json().catch(() => ({}));
    if (j.error === 29 || r.status === 429) { await sleep(5000 * (t + 1)); continue; }
    if (j.error === 10 || j.error === 26) throw new Error('Last.fm API key was rejected');
    return j;
  }
  return {};
}
const BAD_TAGS = /seen live|favou?rite|beautiful|awesome|love|my |albums i own|best|under \d|\d{4}s?$|male vocalists|female vocalists|american|british|english|canadian|swedish|german|french|australian|irish/i;
const titleCase = (s) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\bAnd\b/g, 'and').replace(/\bN\b/g, 'n');

async function runLastfm(ctx) {
  const key = ctx.lastfmKey;
  if (!key) return;
  const byArtist = new Map();
  for (const s of lib.songs) {
    const a = s.artist || s.albumArtist;
    if (!a) continue;
    const k = norm(a);
    if (!byArtist.has(k)) byArtist.set(k, { name: a, songs: [] });
    byArtist.get(k).songs.push(s);
  }
  const done = lib.meta.enrich.artists;
  const todo = [...byArtist.entries()].filter(([k]) => !done[k]).sort((a, b) => b[1].songs.length - a[1].songs.length);
  ctx.total = todo.length; ctx.done = 0;
  for (const [k, { name, songs }] of todo) {
    if (ctx.signal.aborted) return;
    try {
      const top = await lfm(key, { method: 'artist.gettoptracks', artist: name, limit: '500' });
      const map = new Map();
      for (const t of top?.toptracks?.track || []) {
        const nt = normTitle(t.name);
        if (!map.has(nt)) map.set(nt, +t.listeners || 0);
      }
      for (const s of songs) {
        const l = map.get(normTitle(s.title));
        if (l != null) { s.listeners = l; s.pop = popFromListeners(l); }
      }
      await sleep(220);
      const sim = await lfm(key, { method: 'artist.getsimilar', artist: name, limit: '40' });
      const list = (sim?.similarartists?.artist || []).map((a) => [a.name, Math.round(+a.match * 100) / 100]).filter((x) => x[1] > 0);
      if (list.length) lib.meta.similar[k] = list;
      if (songs.some((s) => !s.genre)) {
        await sleep(220);
        const tags = await lfm(key, { method: 'artist.gettoptags', artist: name });
        const tag = (tags?.toptags?.tag || []).find((t) => !BAD_TAGS.test(t.name) && t.name.length < 30);
        if (tag) for (const s of songs) if (!s.genre) { s.genre = titleCase(tag.name); s.genreSrc = 'lastfm'; }
      }
      done[k] = Date.now();
    } catch (e) {
      ctx.errors++;
      if (/rejected/.test(e.message)) { ctx.fatal = e.message; return; }
    }
    ctx.done++;
    ctx.changed = true;
    if (ctx.done % 10 === 0) ctx.report();
    await sleep(220);
  }
}

// ---------- 3. MusicBrainz ----------
const luc = (s) => s.replace(/([+\-&|!(){}[\]^"~*?:\\/])/g, '\\$1');
async function runMusicBrainz(ctx) {
  const albums = new Map();
  for (const s of lib.songs) {
    if (!s.album || s.guessed) continue;
    const artist = s.albumArtist || s.artist;
    if (!artist) continue;
    const k = norm(artist) + '|' + norm(s.album);
    if (!albums.has(k)) albums.set(k, { artist, album: s.album, songs: [] });
    albums.get(k).songs.push(s);
  }
  const done = lib.meta.enrich.albums;
  const todo = [...albums.entries()].filter(([k]) => !done[k]).sort((a, b) => b[1].songs.length - a[1].songs.length);
  ctx.total = todo.length; ctx.done = 0;
  for (const [k, a] of todo) {
    if (ctx.signal.aborted) return;
    const start = Date.now();
    try {
      const q = `release:"${luc(a.album)}" AND artist:"${luc(a.artist)}"`;
      const r = await fetch(`https://musicbrainz.org/ws/2/release/?fmt=json&limit=5&query=${encodeURIComponent(q)}`);
      if (r.status === 503 || r.status === 429) { await sleep(5000); continue; }
      const j = await r.json();
      const rel = (j.releases || []).filter((x) => x.score >= 85).sort((x, y) => (y['label-info']?.length ? 1 : 0) - (x['label-info']?.length ? 1 : 0))[0];
      if (rel) {
        const label = rel['label-info']?.map((li) => li.label?.name).find((n) => n && !/^\[no label\]$/i.test(n));
        const year = parseInt(rel.date, 10);
        for (const s of a.songs) {
          if (label && !s.label) s.label = label;
          if (!s.mbid) s.mbid = rel.id;
          if (!s.year && year) s.year = year;
        }
      }
      done[k] = Date.now();
    } catch { ctx.errors++; }
    ctx.done++;
    ctx.changed = true;
    if (ctx.done % 5 === 0) ctx.report();
    const wait = 1100 - (Date.now() - start); // MusicBrainz allows 1 request/second
    if (wait > 0) await sleep(wait);
  }
}

export const STEPS = [
  { id: 'tags', label: 'Reading file tags', run: runTags },
  { id: 'lastfm', label: 'Last.fm popularity & similar artists', run: runLastfm },
  { id: 'mb', label: 'MusicBrainz labels', run: runMusicBrainz },
];

let running = null;
export const isRunning = () => !!running;
export function stop() { running?.abort(); }

// onProgress({step,label,done,total,errors}); save() persists the library periodically
export async function enrich({ steps = ['tags', 'lastfm', 'mb'], lastfmKey, onProgress, save }) {
  if (running) return;
  running = new AbortController();
  const ctx = { signal: running.signal, lastfmKey, errors: 0, done: 0, total: 0, changed: false, fatal: null };
  let lastSave = Date.now();
  try {
    for (const st of STEPS.filter((x) => steps.includes(x.id))) {
      if (st.id === 'lastfm' && !lastfmKey) continue;
      ctx.report = () => {
        onProgress?.({ step: st.id, label: st.label, done: ctx.done, total: ctx.total, errors: ctx.errors });
        if (ctx.changed && Date.now() - lastSave > 120000) { lastSave = Date.now(); ctx.changed = false; save?.(false); }
      };
      ctx.report();
      await st.run(ctx);
      ctx.report();
      if (ctx.fatal) break;
    }
  } finally {
    running = null;
    await save?.(true);
    onProgress?.({ step: 'done', errors: ctx.errors, fatal: ctx.fatal, aborted: ctx.signal.aborted });
  }
}
