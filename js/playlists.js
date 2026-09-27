// Imports existing playlist files (.m3u/.m3u8/.pls/.wpl/.zpl) found in the music folder
import { lib, folderPath } from './library.js';
import { downloadUrls } from './graph.js';
import { decodeText, norm, normTitle } from './util.js';

export function parsePlaylist(ext, text) {
  const entries = [];
  if (ext === 'wpl' || ext === 'zpl') {
    const doc = new DOMParser().parseFromString(text.replace(/^﻿/, ''), 'application/xml');
    for (const m of doc.querySelectorAll('media')) {
      const src = m.getAttribute('src');
      if (src) entries.push({ path: src, hint: [m.getAttribute('trackArtist'), m.getAttribute('trackTitle')].filter(Boolean).join(' - ') });
    }
    return entries;
  }
  if (ext === 'pls') {
    const titles = {};
    for (const line of text.split(/\r?\n/)) {
      const m = /^Title(\d+)=(.*)$/i.exec(line.trim());
      if (m) titles[m[1]] = m[2];
    }
    for (const line of text.split(/\r?\n/)) {
      const m = /^File(\d+)=(.*)$/i.exec(line.trim());
      if (m) entries.push({ path: m[2], hint: titles[m[1]] || '' });
    }
    return entries;
  }
  let hint = '';
  for (let line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    line = line.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      const m = /^#EXTINF:[^,]*,(.*)$/i.exec(line);
      if (m) hint = m[1];
      continue;
    }
    entries.push({ path: line, hint });
    hint = '';
  }
  return entries;
}

function buildIndex() {
  const byFile = new Map(), byBase = new Map(), byAT = new Map();
  const push = (m, k, s) => { const a = m.get(k); if (a) a.push(s); else m.set(k, [s]); };
  for (const s of lib.songs) {
    const f = norm(s.file);
    push(byFile, f, s);
    push(byBase, f.replace(/\.[^.]+$/, ''), s);
    if (s.artist && s.title) push(byAT, norm(s.artist) + '|' + normTitle(s.title), s);
  }
  return { byFile, byBase, byAT };
}

function bestBySuffix(cands, segs) {
  if (cands.length === 1) return cands[0];
  let best = null, bestScore = -1;
  for (const s of cands) {
    const p = folderPath(s.parentId).split('/').map(norm).reverse();
    let sc = 0;
    for (let i = 0; i < Math.min(p.length, segs.length); i++) { if (p[i] === segs[i]) sc++; else break; }
    if (sc > bestScore) { bestScore = sc; best = s; }
  }
  return best;
}

export function matchEntries(entries, idx = buildIndex()) {
  const ids = [];
  for (const e of entries) {
    if (/^[a-z]+:\/\//i.test(e.path) && !/^file:/i.test(e.path)) continue; // streams/URLs
    let p = e.path.replace(/^file:\/+/i, '');
    try { p = decodeURIComponent(p); } catch { /* keep */ }
    const segs = p.replace(/\\/g, '/').split('/').filter((x) => x && x !== '.' && x !== '..').map(norm);
    const file = segs.pop() || '';
    const rev = segs.reverse();
    let s = null;
    let c = idx.byFile.get(file);
    if (c) s = bestBySuffix(c, rev);
    if (!s && (c = idx.byBase.get(file.replace(/\.[^.]+$/, '')))) s = bestBySuffix(c, rev);
    if (!s && e.hint) {
      const m = /^(.+?)\s+-\s+(.+)$/.exec(e.hint);
      if (m) { c = idx.byAT.get(norm(m[1]) + '|' + normTitle(m[2])); if (c) s = c[0]; }
    }
    if (s) ids.push(s.id);
  }
  return ids;
}

export async function importPlaylists(onProgress) {
  const M = lib.meta;
  const files = Object.entries(M.playlistFiles || {}).filter(([id, f]) => M.importedPlaylists[id]?.modified !== f.modified);
  if (!files.length) return 0;
  const idx = buildIndex();
  let done = 0;
  for (let i = 0; i < files.length; i += 20) {
    const chunk = files.slice(i, i + 20);
    const urls = await downloadUrls(chunk.map(([id]) => id));
    await Promise.all(chunk.map(async ([id, f], k) => {
      try {
        if (!urls[k]) return;
        const buf = await (await fetch(urls[k])).arrayBuffer();
        const entries = parsePlaylist(f.ext, decodeText(buf));
        const songIds = matchEntries(entries, idx);
        M.importedPlaylists[id] = { id, name: f.name, songIds, total: entries.length, modified: f.modified };
      } catch (e) { console.warn('Playlist import failed', f.name, e); }
      done++;
      onProgress?.(done, files.length);
    }));
  }
  return files.length;
}
