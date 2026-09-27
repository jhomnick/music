// Smart random mixes: weighted by rating, skips and recency; "similar" mixes by genre, era and related artists
import { lib } from './library.js';
import { playable } from './formats.js';
import { norm } from './util.js';
import { COL } from './view.js';

// How likely a song is to be picked (0 = never)
export function weight(s, now = Date.now()) {
  if (!playable(s)) return 0;
  const r = s._rating || 0;
  let w = r ? [1, 0.12, 0.45, 1, 1.7, 2.6][r] : 1;
  const net = (s._skips || 0) - 0.5 * (s._plays || 0);
  if (net > 0) w *= Math.max(0.02, Math.pow(0.4, net)); // each net skip ≈ 60% less likely
  if (s._last) {
    const days = (now - s._last) / 864e5;
    w *= days < 1 ? 0.08 : days < 7 ? 0.35 : days < 30 ? 0.75 : 1;
  }
  return w;
}

const artistKey = (s) => norm(s.artist || s.albumArtist || '');

// Weighted sampling without replacement (Efraimidis–Spirakis) with per-artist caps
function sample(cands, n, { maxPerArtist = 2, capFor } = {}) {
  const keyed = [];
  for (const [s, w] of cands) if (w > 0) keyed.push([Math.log(Math.random()) / w, s]);
  keyed.sort((a, b) => b[0] - a[0]);
  const out = [], per = new Map(), used = new Set();
  for (let pass = 0; pass < 3 && out.length < n; pass++) {
    const extra = pass * 2;
    for (const [, s] of keyed) {
      if (out.length >= n) break;
      if (used.has(s.id)) continue;
      const a = artistKey(s);
      const cap = (capFor ? capFor(a) : maxPerArtist) + extra;
      if ((per.get(a) || 0) >= cap) continue;
      per.set(a, (per.get(a) || 0) + 1);
      used.add(s.id);
      out.push(s);
    }
  }
  return out;
}

export function randomSize() { return 20 + Math.floor(Math.random() * 11); }

export function randomMix(n = randomSize(), pool = lib.songs, exclude = new Set()) {
  const now = Date.now();
  return sample(pool.filter((s) => !exclude.has(s.id)).map((s) => [s, weight(s, now)]), n, { maxPerArtist: 2 });
}

// Build a mix of n songs that sound like the seed songs
export function similarMix(seeds, n = 25, exclude = new Set()) {
  seeds = seeds.filter(Boolean);
  if (!seeds.length) return randomMix(n, lib.songs, exclude);

  const gcount = new Map(), fcount = new Map(), seedArtists = new Map(), years = [];
  for (const s of seeds) {
    for (const g of s._gen) gcount.set(g, (gcount.get(g) || 0) + 1);
    for (const f of s._fam) fcount.set(f, (fcount.get(f) || 0) + 1);
    const a = artistKey(s);
    if (a) seedArtists.set(a, (seedArtists.get(a) || 0) + 1);
    if (s.year > 1000) years.push(+s.year);
  }
  years.sort((a, b) => a - b);
  const center = years.length ? years[Math.floor(years.length / 2)] : null;
  const spread = years.length > 3 ? Math.max(4, (years[Math.floor(years.length * 0.85)] - years[Math.floor(years.length * 0.15)]) / 2) : 6;

  // Related artists from Last.fm (if enrichment ran)
  const related = new Map();
  const topSeed = [...seedArtists.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  for (const [a] of topSeed) for (const [name, m] of lib.meta.similar?.[a] || []) {
    const k = norm(name);
    related.set(k, Math.max(related.get(k) || 0, m));
  }
  const hasGenre = gcount.size > 0, hasYear = center != null;
  const nSeeds = seeds.length;
  const now = Date.now();
  const cands = [];
  for (const c of lib.songs) {
    if (exclude.has(c.id)) continue;
    let sc = 0;
    let gbest = 0;
    for (const g of c._gen) gbest = Math.max(gbest, (gcount.get(g) || 0) / nSeeds);
    if (gbest) sc += 2 + 2 * Math.min(1, gbest * 2);
    else { let fam = 0; for (const f of c._fam) fam = Math.max(fam, (fcount.get(f) || 0) / nSeeds); if (fam) sc += 1 + fam; }
    if (hasYear && c.year > 1000) {
      const dy = Math.abs(c.year - center) / spread;
      sc += dy <= 0.6 ? 2 : dy <= 1.2 ? 1.3 : dy <= 2 ? 0.5 : dy > 3.5 ? -1.2 : 0;
    }
    const a = artistKey(c);
    if (seedArtists.has(a)) sc += 2.2;
    const rel = related.get(a);
    if (rel) sc += 1.5 + 3 * rel;
    // must have *some* musical connection, not just era
    const connected = gbest > 0 || sc >= 3 || rel || seedArtists.has(a) || (!hasGenre && !hasYear);
    if (!connected || sc <= 0) continue;
    const w = sc * sc * weight(c, now);
    if (w > 0) cands.push([c, w]);
  }
  const seedCap = Math.max(2, Math.round(n * 0.3));
  const out = sample(cands, n, { capFor: (a) => (seedArtists.has(a) ? seedCap : 2) });
  if (out.length < n) {
    const have = new Set([...exclude, ...out.map((s) => s.id)]);
    out.push(...randomMix(n - out.length, lib.songs, have));
  }
  return out;
}

// Every library song whose column value equals the given song's value
export function matchingSongs(colKey, value) {
  const col = COL[colKey];
  if (!col) return [];
  const nv = typeof value === 'string' ? norm(value) : value;
  return lib.songs.filter((s) => {
    const v = col.get(s);
    return typeof nv === 'string' ? norm(v) === nv : v == nv;
  });
}

// Songs belonging to a genre family or a decade (for quick-play buttons)
export function familySongs(fam) { return lib.songs.filter((s) => s._fam.has(fam)); }
export function decadeSongs(d) { return lib.songs.filter((s) => s.year >= d && s.year < d + 10); }
