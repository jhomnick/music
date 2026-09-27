// Walks the OneDrive music folder with the Graph delta API (fast, and incremental on later scans)
import { gjson, GraphError } from './graph.js';
import { lib, rebuild, clearPathCache, folderPath } from './library.js';
import { AUDIO_EXT, PLAYLIST_EXT } from './formats.js';

const SELECT = 'id,name,file,audio,size,parentReference,createdDateTime,lastModifiedDateTime,deleted,folder,root';

function coverScore(name) {
  const n = name.toLowerCase();
  if (!/\.(jpe?g|png|webp)$/.test(n)) return 0;
  if (/^(cover|front)\./.test(n)) return 10;
  if (/^folder\./.test(n)) return 9;
  if (/^albumart_\{.*\}_large\./.test(n)) return 8;
  if (/^(album|albumart|artwork|art)\./.test(n)) return 7;
  if (/cover|front/.test(n)) return 6;
  if (/albumart_\{.*\}_small|albumartsmall/.test(n)) return 3;
  if (/back|inlay|cd|disc|booklet/.test(n)) return 1;
  return 2;
}

const extOf = (name) => { const m = /\.([^.]+)$/.exec(name); return m ? m[1].toLowerCase() : ''; };

function songFrom(it, prev) {
  const a = it.audio || {};
  const s = {
    id: it.id,
    file: it.name,
    ext: extOf(it.name),
    size: it.size,
    parentId: it.parentReference?.id || null,
    added: it.createdDateTime,
    modified: it.lastModifiedDateTime,
    title: a.title || null,
    artist: a.artist || null,
    albumArtist: a.albumArtist || null,
    album: a.album || null,
    genre: a.genre || null,
    year: a.year || null,
    track: a.track || null,
    disc: a.disc || null,
    composer: a.composers || null,
    duration: a.duration ? Math.round(a.duration / 1000) : null,
    bitrate: a.bitrate || null,
    vbr: a.isVariableBitrate || false,
    drm: a.hasDrm || false,
    hasTags: !!it.audio,
  };
  if (prev) {
    // keep enrichment that the file itself doesn't carry
    for (const k of ['label', 'pop', 'listeners', 'mbid', 'fileRating', 'filePlays', 'genreSrc', 'tagged']) if (prev[k] != null) s[k] = prev[k];
    if (!s.genre && prev.genreSrc && prev.genre) s.genre = prev.genre;
    if (prev.tagged && prev.modified === s.modified) {
      for (const k of ['title', 'artist', 'albumArtist', 'album', 'year', 'track', 'disc', 'composer']) if (!s[k] && prev[k]) s[k] = prev[k];
    }
  }
  return s;
}

// Fill blanks from "Artist/Album/01 - Title.mp3" style layouts
export function guessFromPath(s) {
  const base = s.file.replace(/\.[^.]+$/, '');
  const path = folderPath(s.parentId).split('/').filter(Boolean);
  let title = base, artist = null, track = null;
  let m = /^(\d{1,2})[-\s._]+(\d{1,3})[\s._-]+(.*)$/.exec(title);            // 1-01 Title (disc-track)
  if (m && +m[1] < 10) { track = +m[2]; title = m[3]; }
  else if ((m = /^(\d{1,3})[\s._-]+(.*)$/.exec(title))) { track = +m[1]; title = m[2]; }
  if ((m = /^(.+?)\s+-\s+(.+)$/.exec(title))) { artist = m[1]; title = m[2]; }
  if (!s.title) { s.title = title.trim(); s.guessed = true; }
  if (!s.track && track) s.track = track;
  if (!s.album && path.length >= 1) { s.album = path[path.length - 1]; s.guessed = true; }
  if (!s.artist) {
    const a = artist || s.albumArtist || (path.length >= 2 ? path[path.length - 2] : null);
    if (a) { s.artist = a; s.guessed = true; }
  }
}

export async function scanLibrary({ rootId, rootPath, full = false, onProgress, signal }) {
  const M = lib.meta;
  const incremental = !full && M.deltaLink && M.rootId === rootId;
  const prevById = new Map(lib.songs.map((s) => [s.id, s]));
  let songs;
  if (incremental) {
    songs = prevById; // mutate in place
  } else {
    songs = new Map();
    M.folders = {}; M.covers = {}; M.playlistFiles = {};
    M.folders[rootId] = [rootPath.split('/').pop() || 'Music', null];
  }
  M.rootId = rootId; M.rootPath = rootPath;

  let url = incremental ? M.deltaLink : `/me/drive/items/${rootId}/delta?$select=${SELECT}`;
  let pages = 0, seen = 0, added = 0, removed = 0;
  const coverCandidates = {};

  while (url) {
    if (signal?.aborted) throw new DOMException('Scan cancelled', 'AbortError');
    let j;
    try {
      j = await gjson(url);
    } catch (e) {
      if (e instanceof GraphError && e.status === 410 && incremental) {
        return scanLibrary({ rootId, rootPath, full: true, onProgress, signal }); // delta token expired
      }
      throw e;
    }
    pages++;
    for (const it of j.value || []) {
      seen++;
      if (it.deleted) {
        if (songs.delete(it.id)) removed++;
        delete M.folders[it.id];
        delete M.playlistFiles[it.id];
        delete M.importedPlaylists[it.id];
        for (const [fid, c] of Object.entries(M.covers)) if (c[0] === it.id) delete M.covers[fid];
        continue;
      }
      const pid = it.parentReference?.id || null;
      if (it.folder || it.root) {
        if (it.id === rootId || it.root) M.folders[it.id] = [it.name, null];
        else M.folders[it.id] = [it.name, pid];
        continue;
      }
      if (!it.file) continue;
      const ext = extOf(it.name);
      if (AUDIO_EXT.has(ext)) {
        if (!songs.has(it.id)) added++;
        songs.set(it.id, songFrom(it, prevById.get(it.id)));
      } else if (PLAYLIST_EXT.has(ext)) {
        M.playlistFiles[it.id] = { name: it.name.replace(/\.[^.]+$/, ''), ext, parentId: pid, modified: it.lastModifiedDateTime };
      } else {
        const sc = coverScore(it.name);
        if (sc && pid) {
          const cur = coverCandidates[pid] || M.covers[pid];
          if (!cur || sc > cur[1]) coverCandidates[pid] = [it.id, sc];
        }
      }
    }
    onProgress?.({ pages, seen, songs: songs.size });
    if (j['@odata.nextLink']) url = j['@odata.nextLink'];
    else { M.deltaLink = j['@odata.deltaLink'] || null; url = null; }
  }
  Object.assign(M.covers, coverCandidates);
  lib.songs = [...songs.values()];
  lib.byId = new Map(lib.songs.map((s) => [s.id, s]));
  clearPathCache();
  for (const s of lib.songs) if (!s.title || !s.artist || !s.album) guessFromPath(s);
  M.scannedAt = Date.now();
  rebuild();
  return { songs: lib.songs.length, added: incremental ? added : lib.songs.length, removed, pages };
}

// Folder browser for choosing the music root
export async function listFolders(id) {
  const out = [];
  let url = `/me/drive/items/${id}/children?$select=id,name,folder&$top=999`;
  while (url) {
    const j = await gjson(url);
    for (const it of j.value) if (it.folder) out.push({ id: it.id, name: it.name, count: it.folder.childCount });
    url = j['@odata.nextLink'];
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
export async function specialMusicFolder() {
  try { return await gjson('/me/drive/special/music?$select=id,name'); } catch { return null; }
}
export async function rootFolder() { return gjson('/me/drive/root?$select=id,name'); }
