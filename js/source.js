// OneDrive-backed audio + art sources
import { lib } from './library.js';
import { downloadUrl, forgetUrl, thumbUrl } from './graph.js';
import { readTags, TAG_EXT } from './tags.js';

export const streamFor = (s) => downloadUrl(s.id);
export const onStreamError = (s) => forgetUrl(s.id);

async function fetchImage(url) {
  if (!url) return null;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const b = await r.blob();
    return b.size > 200 ? b : null;
  } catch {
    return url; // CORS-blocked: show it without caching
  }
}

export async function artFor(s) {
  const cover = lib.meta.covers?.[s.parentId];
  if (cover) {
    const b = await fetchImage(await thumbUrl(cover[0]).catch(() => null));
    if (b) return b;
  }
  if (TAG_EXT.has(s.ext)) {
    try {
      const t = await readTags(await downloadUrl(s.id), s.ext, { picture: true });
      if (t?.picture?.data?.length > 200) return new Blob([t.picture.data], { type: t.picture.mime });
    } catch { /* fall through */ }
  } else {
    const b = await fetchImage(await thumbUrl(s.id).catch(() => null));
    if (b) return b;
  }
  if (s.mbid) {
    const b = await fetchImage(`https://coverartarchive.org/release/${s.mbid}/front-250`);
    if (b) return b;
  }
  return null;
}
