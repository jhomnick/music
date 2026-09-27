// Demo mode: a synthetic 50,000-song library with tone playback, for trying the app without OneDrive
import { setLibrary } from './library.js';
import { hash, norm } from './util.js';

const REAL = [
  ['Pink Floyd', 'Progressive Rock', 1967, 1994], ['Led Zeppelin', 'Hard Rock', 1969, 1979], ['The Beatles', 'Rock', 1963, 1970],
  ['The Rolling Stones', 'Rock', 1964, 1981], ['Fleetwood Mac', 'Rock', 1968, 1987], ['Eagles', 'Rock', 1972, 1979],
  ['Queen', 'Rock', 1973, 1991], ['David Bowie', 'Rock', 1969, 1983], ['Genesis', 'Progressive Rock', 1970, 1986],
  ['Yes', 'Progressive Rock', 1969, 1980], ['Rush', 'Progressive Rock', 1974, 1993], ['The Who', 'Rock', 1965, 1978],
  ['Steely Dan', 'Jazz Rock', 1972, 1980], ['Miles Davis', 'Jazz', 1954, 1970], ['John Coltrane', 'Jazz', 1957, 1967],
  ['Bill Evans', 'Jazz', 1958, 1977], ['Ella Fitzgerald', 'Vocal Jazz', 1950, 1970], ['Frank Sinatra', 'Vocal', 1953, 1966],
  ['Johnny Cash', 'Country', 1957, 1972], ['Willie Nelson', 'Country', 1973, 1985], ['Dolly Parton', 'Country', 1967, 1980],
  ['Chris Stapleton', 'Country', 2015, 2023], ['Taylor Swift', 'Pop', 2008, 2024], ['Madonna', 'Pop', 1983, 1998],
  ['Michael Jackson', 'Pop', 1979, 1991], ['Prince', 'Funk', 1979, 1991], ['Stevie Wonder', 'Soul', 1970, 1980],
  ['Marvin Gaye', 'Soul', 1965, 1978], ['Aretha Franklin', 'Soul', 1967, 1972], ['Nirvana', 'Grunge', 1989, 1994],
  ['Pearl Jam', 'Grunge', 1991, 1998], ['Radiohead', 'Alternative', 1993, 2016], ['R.E.M.', 'Alternative', 1983, 1998],
  ['U2', 'Rock', 1980, 2000], ['The Cure', 'New Wave', 1979, 1992], ['Depeche Mode', 'Synth-pop', 1981, 1993],
  ['Daft Punk', 'Electronic', 1997, 2013], ['Kraftwerk', 'Electronic', 1974, 1986], ['Bob Marley & The Wailers', 'Reggae', 1973, 1980],
  ['Bob Dylan', 'Folk Rock', 1963, 1976], ['Simon & Garfunkel', 'Folk', 1964, 1970], ['Joni Mitchell', 'Folk', 1968, 1976],
  ['Metallica', 'Metal', 1983, 1991], ['Black Sabbath', 'Metal', 1970, 1978], ['Beastie Boys', 'Hip-Hop', 1986, 1998],
  ['Kendrick Lamar', 'Hip-Hop', 2011, 2022], ['OutKast', 'Hip-Hop', 1994, 2003], ['Adele', 'Pop', 2008, 2021],
  ['Norah Jones', 'Jazz', 2002, 2012], ['B.B. King', 'Blues', 1960, 1980], ['Stevie Ray Vaughan', 'Blues Rock', 1983, 1990],
  ['Eric Clapton', 'Blues Rock', 1970, 1992], ['Tom Petty', 'Rock', 1976, 1994], ['Bruce Springsteen', 'Rock', 1973, 1987],
  ['Billy Joel', 'Pop Rock', 1973, 1989], ['Elton John', 'Pop Rock', 1970, 1983], ['Yo-Yo Ma', 'Classical', 1983, 2005],
  ['Hans Zimmer', 'Soundtrack', 1994, 2021], ['The Allman Brothers Band', 'Southern Rock', 1969, 1979], ['Lynyrd Skynyrd', 'Southern Rock', 1973, 1977],
  ['Creedence Clearwater Revival', 'Rock', 1968, 1972], ['Jimi Hendrix', 'Psychedelic Rock', 1967, 1970], ['The Doors', 'Psychedelic Rock', 1967, 1971],
  ['Coldplay', 'Alternative', 2000, 2021], ['Foo Fighters', 'Alternative', 1995, 2017], ['The Killers', 'Indie Rock', 2004, 2020],
  ['Arctic Monkeys', 'Indie Rock', 2006, 2022], ['Santana', 'Latin Rock', 1969, 1999], ['Buena Vista Social Club', 'Latin', 1997, 2000],
  ['Earth, Wind & Fire', 'R&B', 1972, 1981], ['Whitney Houston', 'R&B', 1985, 1992], ['Beyoncé', 'R&B', 2003, 2022],
];
const SIMILAR = {
  'pink floyd': ['Yes', 'Genesis', 'Led Zeppelin', 'The Doors', 'David Bowie', 'Rush', 'Radiohead', 'The Who'],
  'led zeppelin': ['Black Sabbath', 'The Who', 'Jimi Hendrix', 'The Rolling Stones', 'Pink Floyd', 'Queen'],
  'the beatles': ['The Rolling Stones', 'The Who', 'Simon & Garfunkel', 'Bob Dylan', 'Elton John'],
  'miles davis': ['John Coltrane', 'Bill Evans', 'Ella Fitzgerald', 'Steely Dan'],
  'johnny cash': ['Willie Nelson', 'Dolly Parton', 'Bob Dylan', 'Chris Stapleton'],
  'nirvana': ['Pearl Jam', 'Foo Fighters', 'R.E.M.', 'Radiohead', 'Metallica'],
  'stevie wonder': ['Marvin Gaye', 'Aretha Franklin', 'Earth, Wind & Fire', 'Prince', 'Michael Jackson'],
};
const W1 = 'Velvet Silver Midnight Golden Electric Paper Hollow Crimson Northern Quiet Wild Neon Broken Distant Lonely Burning Frozen Painted Rusty Secret Summer Winter Blue Black Iron Glass Stone River Desert Ocean'.split(' ');
const W2 = 'Harbor Horses Radio Kings Echoes Lanterns Rivals Saints Wolves Ghosts Parade Engines Satellites Pilots Brothers Sisters Owls Arrows Machines Dreamers Drifters Riders Tigers Hearts Shadows Canyons Lights Rebels Ramblers'.split(' ');
const T = 'Love Night Road Home Heart Fire Rain Light Dream Time Sky Dance Song Blues Train River Moon Sun Gold Wind Highway Midnight Morning City Girl Boy Ghost Angel Devil Summer Letter Shadow Paradise Thunder Stranger Memory Freedom Money Garden Island'.split(' ');
const V = 'Running Falling Waiting Dancing Breaking Burning Crying Driving Flying Holding Chasing Dreaming Leaving Coming Singing Losing Finding Calling'.split(' ');
const GEN = ['Rock', 'Pop', 'Jazz', 'Country', 'Blues', 'Soul', 'Hip-Hop', 'Electronic', 'Folk', 'Alternative', 'Metal', 'Classic Rock', 'Indie Rock', 'R&B', 'Reggae', 'Classical', 'Soundtrack', 'Latin', 'Punk', 'Funk'];
const LABELS = ['Columbia', 'Capitol', 'Atlantic', 'Warner Bros.', 'EMI', 'Island', 'Motown', 'Blue Note', 'Sony', 'Virgin', 'Geffen', 'Epic', 'Sub Pop', 'Def Jam', 'Elektra', 'Harvest', 'A&M', 'RCA', null, null];

function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = Math.imul(s ^ (s >>> 15), 2246822507) ^ Math.imul(s ^ (s >>> 13), 3266489909)), (s >>>= 0), s / 4294967296); }

export function makeDemoLibrary(target = 50000) {
  const r = rng(42);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const songs = [], folders = { root: ['Music', null] }, imported = {};
  let n = 0;
  const artists = REAL.map(([name, genre, y0, y1]) => ({ name, genre, y0, y1, albums: 10 + Math.floor(r() * 8) }));
  while (artists.reduce((t, a) => t + a.albums * 11, 0) < target) {
    const y0 = 1955 + Math.floor(r() * 65);
    artists.push({ name: `${r() < 0.4 ? 'The ' : ''}${pick(W1)} ${pick(W2)}`, genre: pick(GEN), y0, y1: Math.min(2025, y0 + Math.floor(r() * 25)), albums: 1 + Math.floor(r() * 4) });
  }
  outer: for (const a of artists) {
    const af = 'a' + hash(a.name);
    folders[af] = [a.name, 'root'];
    const label = pick(LABELS);
    for (let al = 0; al < a.albums; al++) {
      const album = r() < 0.5 ? `${pick(W1)} ${pick(T)}` : `${pick(T)} ${pick(['of', 'in the', 'and', 'on the'])} ${pick(T)}`;
      const year = a.y0 + Math.floor(r() * (a.y1 - a.y0 + 1));
      const fid = af + '_' + al;
      folders[fid] = [`${album} (${year})`, af];
      const tracks = 8 + Math.floor(r() * 7);
      const br = pick([128, 192, 256, 320, 320, 320, 1411, 900]);
      const ext = br > 400 ? 'flac' : r() < 0.85 ? 'mp3' : 'm4a';
      for (let t = 1; t <= tracks; t++) {
        const title = r() < 0.5 ? `${pick(V)} ${pick(T)}` : r() < 0.5 ? `${pick(T)} ${pick(T)}` : `The ${pick(T)}`;
        const id = 'd' + (n++).toString(36);
        songs.push({
          id, file: `${String(t).padStart(2, '0')} ${title}.${ext}`, ext, size: Math.round((br * 1000 / 8) * 240),
          parentId: fid, added: new Date(Date.UTC(2015, 0, 1) + r() * (Date.now() - Date.UTC(2015, 0, 1))).toISOString(),
          title, artist: a.name, album, albumArtist: a.name, genre: a.genre, year, track: t, disc: 1,
          duration: 120 + Math.floor(r() * 300), bitrate: br, label: label || undefined,
          pop: a.albums > 5 ? 40 + Math.floor(r() * 60) : Math.floor(r() * 45),
          fileRating: r() < 0.05 ? 1 + Math.floor(r() * 5) : undefined,
        });
        if (songs.length >= target) break outer;
      }
    }
  }
  // a couple of "imported" playlists like ones found on OneDrive
  const byArtist = (name) => songs.filter((s) => s.artist === name).map((s) => s.id);
  imported.pl1 = { id: 'pl1', name: 'Road Trip', songIds: [...byArtist('Tom Petty').slice(0, 8), ...byArtist('Eagles').slice(0, 8), ...byArtist('Fleetwood Mac').slice(0, 8)], total: 24 };
  imported.pl2 = { id: 'pl2', name: 'Late Night Jazz', songIds: [...byArtist('Miles Davis').slice(0, 10), ...byArtist('Bill Evans').slice(0, 10)], total: 20 };
  const similar = {};
  for (const [k, list] of Object.entries(SIMILAR)) similar[k] = list.map((nme, i) => [nme, Math.round((1 - i * 0.08) * 100) / 100]);
  setLibrary({ rootId: 'root', rootPath: 'Music', folders, songs, importedPlaylists: imported, similar, scannedAt: Date.now() });
}

// Demo stats so the Plays/Skips columns aren't empty
export function demoUserData(lib) {
  const r = rng(7);
  const stats = {};
  for (const s of lib.songs) {
    if (r() < 0.12) stats[s.id] = [1 + Math.floor(r() * 20), r() < 0.2 ? 1 + Math.floor(r() * 4) : 0, Date.now() - Math.floor(r() * 200) * 864e5];
  }
  return { format: 1, devices: { demo: { name: 'Demo', updated: 1, stats } }, ratings: {}, playlists: {} };
}

// Tone "audio" for demo playback: a short arpeggio derived from the song id
const urls = new Map();
export async function demoStream(s) {
  if (urls.has(s.id)) return urls.get(s.id);
  const rate = 22050, secs = 24, n = rate * secs;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o, str) => { for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  const h = hash(s.id + norm(s.title));
  const root = 196 * Math.pow(2, (h % 12) / 12);
  const steps = [0, 4, 7, 12, 7, 4];
  const noteLen = rate * (0.25 + ((h >> 4) % 3) * 0.08);
  for (let i = 0; i < n; i++) {
    const k = Math.floor(i / noteLen), p = (i % noteLen) / noteLen;
    const f = root * Math.pow(2, steps[k % steps.length] / 12);
    const env = Math.min(1, p * 20) * Math.exp(-3 * p);
    const x = Math.sin((2 * Math.PI * f * i) / rate) * 0.25 * env + Math.sin((2 * Math.PI * f * 2 * i) / rate) * 0.06 * env;
    v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, x)) * 32767, true);
  }
  const url = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  urls.set(s.id, url);
  if (urls.size > 6) { const [k, u] = urls.entries().next().value; urls.delete(k); URL.revokeObjectURL(u); }
  return url;
}
