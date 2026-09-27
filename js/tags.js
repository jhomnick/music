// Reads tags straight from the start of MP3 (ID3v2) and FLAC files using HTTP range requests.
// Used for things OneDrive doesn't index: record label, ratings/play counts saved by other players, embedded cover art.

const ID3V1_GENRES = ['Blues','Classic Rock','Country','Dance','Disco','Funk','Grunge','Hip-Hop','Jazz','Metal','New Age','Oldies','Other','Pop','R&B','Rap','Reggae','Rock','Techno','Industrial','Alternative','Ska','Death Metal','Pranks','Soundtrack','Euro-Techno','Ambient','Trip-Hop','Vocal','Jazz+Funk','Fusion','Trance','Classical','Instrumental','Acid','House','Game','Sound Clip','Gospel','Noise','AlternRock','Bass','Soul','Punk','Space','Meditative','Instrumental Pop','Instrumental Rock','Ethnic','Gothic','Darkwave','Techno-Industrial','Electronic','Pop-Folk','Eurodance','Dream','Southern Rock','Comedy','Cult','Gangsta','Top 40','Christian Rap','Pop/Funk','Jungle','Native American','Cabaret','New Wave','Psychedelic','Rave','Showtunes','Trailer','Lo-Fi','Tribal','Acid Punk','Acid Jazz','Polka','Retro','Musical','Rock & Roll','Hard Rock'];

class RangeReader {
  constructor(url) { this.url = url; this.chunks = []; this.size = null; this.requests = 0; }
  async ensure(off, len) {
    for (const c of this.chunks) if (off >= c.off && off + len <= c.off + c.buf.length) return;
    if (this.requests >= 6) throw new Error('too many range requests');
    this.requests++;
    const want = Math.max(len, 65536);
    const res = await fetch(this.url, { headers: { Range: `bytes=${off}-${off + want - 1}` } });
    if (!res.ok && res.status !== 206) throw new Error('range ' + res.status);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (res.status === 200) { this.chunks = [{ off: 0, buf }]; return; } // server ignored Range
    this.chunks.push({ off, buf });
  }
  async bytes(off, len) {
    await this.ensure(off, len);
    for (const c of this.chunks) if (off >= c.off && off + len <= c.off + c.buf.length) return c.buf.subarray(off - c.off, off - c.off + len);
    // file shorter than requested
    const c = this.chunks.find((x) => off >= x.off && off < x.off + x.buf.length);
    if (c) return c.buf.subarray(off - c.off);
    return new Uint8Array(0);
  }
}

const syncsafe = (b, i) => ((b[i] & 0x7f) << 21) | ((b[i + 1] & 0x7f) << 14) | ((b[i + 2] & 0x7f) << 7) | (b[i + 3] & 0x7f);
const be32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const le32 = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
const str = (b, a, z) => String.fromCharCode(...b.subarray(a, z));

function unsync(b) {
  const out = [];
  for (let i = 0; i < b.length; i++) { out.push(b[i]); if (b[i] === 0xff && b[i + 1] === 0) i++; }
  return Uint8Array.from(out);
}

function decodeEnc(enc, b) {
  let label = enc === 0 ? 'latin1' : enc === 3 ? 'utf-8' : enc === 2 ? 'utf-16be' : 'utf-16';
  if (enc === 1 && b[0] === 0xfe && b[1] === 0xff) label = 'utf-16be';
  if (enc === 1 && b[0] === 0xff && b[1] === 0xfe) label = 'utf-16le';
  return new TextDecoder(label === 'latin1' ? 'windows-1252' : label).decode(b).replace(/^﻿/, '');
}
function textFrame(b) {
  if (!b.length) return '';
  return decodeEnc(b[0], b.subarray(1)).split('\u0000').map((s) => s.trim()).filter(Boolean).join('; ');
}
// Find end of an encoded, null-terminated string
function termEnd(b, i, enc) {
  if (enc === 1 || enc === 2) { for (; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return i; return b.length; }
  for (; i < b.length; i++) if (b[i] === 0) return i;
  return b.length;
}

function popmToStars(v) {
  if (!v) return 0;
  return v < 32 ? 1 : v < 96 ? 2 : v < 160 ? 3 : v < 224 ? 4 : 5;
}
function cleanGenre(g) {
  return g.replace(/\((\d+)\)/g, (m, n) => (ID3V1_GENRES[+n] ? ID3V1_GENRES[+n] + ' ' : '')).replace(/^(\d+)$/, (m, n) => ID3V1_GENRES[+n] || m).trim();
}

const FRAME_MAP = {
  TIT2: 'title', TT2: 'title', TPE1: 'artist', TP1: 'artist', TPE2: 'albumArtist', TP2: 'albumArtist',
  TALB: 'album', TAL: 'album', TCON: 'genre', TCO: 'genre', TYER: 'year', TYE: 'year', TDRC: 'year', TORY: 'origYear', TDOR: 'origYear',
  TRCK: 'track', TRK: 'track', TPOS: 'disc', TPA: 'disc', TCOM: 'composer', TCM: 'composer', TPUB: 'label', TPB: 'label',
};

async function readId3(r, want) {
  const h = await r.bytes(0, 10);
  if (h.length < 10 || str(h, 0, 3) !== 'ID3') return null;
  const ver = h[3], flags = h[5];
  const tagSize = syncsafe(h, 6);
  const end = 10 + tagSize;
  const out = {};
  let tag = null, base = 0;
  if (flags & 0x80 && ver < 4) { // whole-tag unsynchronisation (rare): read it all
    tag = unsync(await r.bytes(10, Math.min(tagSize, 4 << 20)));
    base = 10;
  }
  const read = async (off, len) => (tag ? tag.subarray(off - base, off - base + len) : r.bytes(off, len));
  let pos = 10;
  if (flags & 0x40) {
    const eh = await read(pos, 4);
    pos += ver >= 4 ? syncsafe(eh, 0) : be32(eh, 0) + 4;
  }
  const idLen = ver === 2 ? 3 : 4, hdrLen = ver === 2 ? 6 : 10;
  while (pos + hdrLen < end) {
    const fh = await read(pos, hdrLen);
    if (fh.length < hdrLen || fh[0] === 0) break;
    const id = str(fh, 0, idLen);
    if (!/^[A-Z0-9]+$/.test(id)) break;
    const size = ver === 2 ? (fh[3] << 16) | (fh[4] << 8) | fh[5] : ver >= 4 ? syncsafe(fh, 4) : be32(fh, 4);
    const fflags = ver >= 3 ? fh[9] : 0;
    const dataStart = pos + hdrLen;
    pos = dataStart + size;
    if (size <= 0 || pos > end + 16) break;
    const isPic = id === 'APIC' || id === 'PIC';
    const interesting = FRAME_MAP[id] || id === 'POPM' || id === 'POP' || (isPic && want.picture && !out.picture);
    if (!interesting) continue;                    // skip over without downloading
    if (!isPic && size > 4096) continue;
    if (isPic && size > (6 << 20)) continue;
    if (ver >= 3 && (fflags & (ver === 3 ? 0xc0 : 0x0c))) continue; // compressed/encrypted
    let d = await read(dataStart, size);
    if (ver >= 4 && fflags & 0x02) d = unsync(d);
    if (ver >= 4 && fflags & 0x01) d = d.subarray(4); // data length indicator
    if (FRAME_MAP[id]) {
      const k = FRAME_MAP[id];
      const v = textFrame(d);
      if (v && !out[k]) out[k] = v;
    } else if (id === 'POPM' || id === 'POP') {
      const z = termEnd(d, 0, 0);
      const rating = d[z + 1];
      let count = 0;
      for (let i = z + 2; i < Math.min(d.length, z + 6); i++) count = count * 256 + d[i];
      const stars = popmToStars(rating);
      if (stars && (!out.rating || str(d, 0, z).includes('Windows Media'))) out.rating = stars;
      if (count) out.playcount = Math.max(out.playcount || 0, count);
    } else if (isPic) {
      const enc = d[0];
      let i = 1, mime;
      if (id === 'PIC') { mime = 'image/' + str(d, 1, 4).toLowerCase().replace('jpg', 'jpeg'); i = 4; }
      else { const z = termEnd(d, 1, 0); mime = str(d, 1, z) || 'image/jpeg'; i = z + 1; }
      const type = d[i]; i++;
      i = termEnd(d, i, enc) + (enc === 1 || enc === 2 ? 2 : 1);
      if (!out.picture || type === 3) out.picture = { mime: mime.includes('/') ? mime : 'image/' + mime, data: d.slice(i) };
    }
  }
  return out;
}

async function readFlac(r, want) {
  const h = await r.bytes(0, 4);
  if (str(h, 0, 4) !== 'fLaC') return null;
  const out = {};
  let pos = 4;
  for (let n = 0; n < 64; n++) {
    const bh = await r.bytes(pos, 4);
    if (bh.length < 4) break;
    const last = bh[0] & 0x80, type = bh[0] & 0x7f, len = (bh[1] << 16) | (bh[2] << 8) | bh[3];
    const dataStart = pos + 4;
    pos = dataStart + len;
    if (type === 4 && len < (1 << 20)) {
      const d = await r.bytes(dataStart, len);
      let i = 4 + le32(d, 0);
      const count = le32(d, i); i += 4;
      const dec = new TextDecoder('utf-8');
      for (let k = 0; k < count && i < d.length; k++) {
        const l = le32(d, i); i += 4;
        const kv = dec.decode(d.subarray(i, i + l)); i += l;
        const eq = kv.indexOf('=');
        if (eq < 0) continue;
        const key = kv.slice(0, eq).toUpperCase(), v = kv.slice(eq + 1).trim();
        const map = { TITLE: 'title', ARTIST: 'artist', ALBUMARTIST: 'albumArtist', 'ALBUM ARTIST': 'albumArtist', ALBUM: 'album', GENRE: 'genre', DATE: 'year', YEAR: 'year', ORIGINALDATE: 'origYear', TRACKNUMBER: 'track', DISCNUMBER: 'disc', COMPOSER: 'composer', LABEL: 'label', ORGANIZATION: 'label', PUBLISHER: 'label' };
        if (map[key] && !out[map[key]]) out[map[key]] = v;
        else if (key === 'RATING' || key === 'FMPS_RATING') {
          let x = parseFloat(v);
          if (!isNaN(x)) { if (key === 'FMPS_RATING' || x <= 1) x *= 5; else if (x > 5) x /= 20; out.rating = Math.max(1, Math.min(5, Math.round(x))); }
        } else if (key === 'PLAY_COUNT' || key === 'PLAYCOUNT') out.playcount = +v || 0;
      }
    } else if (type === 6 && want.picture && !out.picture && len < (6 << 20)) {
      const d = await r.bytes(dataStart, len);
      let i = 0;
      const ptype = be32(d, i); i += 4;
      const ml = be32(d, i); i += 4;
      const mime = str(d, i, i + ml); i += ml;
      const dl = be32(d, i); i += 4 + dl + 16;
      const len2 = be32(d, i); i += 4;
      if (!out.picture || ptype === 3) out.picture = { mime: mime || 'image/jpeg', data: d.slice(i, i + len2) };
    }
    if (last) break;
  }
  return out;
}

export async function readTags(url, ext, want = {}) {
  const r = new RangeReader(url);
  let t = null;
  if (ext === 'flac') t = await readFlac(r, want);
  else if (ext === 'mp3' || ext === 'aac' || ext === 'wav') t = await readId3(r, want);
  if (!t) return null;
  if (t.genre) t.genre = cleanGenre(t.genre);
  for (const k of ['year', 'origYear']) if (t[k]) { const m = /(\d{4})/.exec(t[k]); t[k] = m ? +m[1] : undefined; }
  for (const k of ['track', 'disc']) if (t[k]) t[k] = parseInt(t[k], 10) || undefined;
  return t;
}

export const TAG_EXT = new Set(['mp3', 'flac']);
