// Playback engine: queue, shuffle, repeat, play/skip counting, lock-screen controls
import { lib } from './library.js';
import * as U from './userdata.js';
import { playable } from './formats.js';
import { similarMix } from './mix.js';
import { shuffleInPlace, toast } from './util.js';
import { prefs, savePrefs } from './prefs.js';

export const player = new EventTarget();
const emit = (t, d) => player.dispatchEvent(new CustomEvent(t, { detail: d }));

export const audio = new Audio();
audio.preload = 'auto';
audio.volume = prefs.volume ?? 1;

export const st = {
  queue: [],       // song ids in play order
  orig: null,      // unshuffled order (to restore when shuffle is turned off)
  idx: -1,
  shuffle: false,
  repeat: 'off',   // off | all | one
  listened: 0, lastT: 0, counted: false, started: false, failed: false,
  loadedId: null, resumeAt: 0, fails: 0,
};

let urlFor = async () => { throw new Error('No source'); };
let onUrlError = () => {};
export function setSource(fn, onError) { urlFor = fn; onUrlError = onError || (() => {}); }

export const current = () => lib.byId.get(st.queue[st.idx]) || null;

// ---- counting ----
const threshold = (dur) => Math.min((dur || 240) * 0.5, 240); // Last.fm-style: half the song or 4 minutes

function finalize(manual) {
  const id = st.loadedId;
  if (id && !st.counted && !st.failed && st.started && manual) U.recordSkip(id);
  st.loadedId = null;
}

audio.addEventListener('playing', () => { st.started = true; st.fails = 0; emit('state'); });
audio.addEventListener('pause', () => emit('state'));
audio.addEventListener('timeupdate', () => {
  const t = audio.currentTime;
  // audio.played covers exactly the stretches actually heard (seeking past doesn't count)
  const pr = audio.played;
  let heard = 0;
  for (let i = 0; i < pr.length; i++) heard += pr.end(i) - pr.start(i);
  st.listened = heard;
  st.lastT = t;
  if (!st.counted && st.loadedId && audio.duration > 0 && st.listened >= threshold(audio.duration)) {
    st.counted = true;
    U.recordPlay(st.loadedId);
  }
  emit('time');
  positionStateSoon();
});
audio.addEventListener('seeked', () => { st.lastT = audio.currentTime; });
audio.addEventListener('loadedmetadata', () => {
  const s = current();
  if (s && !s.duration && isFinite(audio.duration)) s.duration = Math.round(audio.duration);
  if (st.resumeAt) { try { audio.currentTime = st.resumeAt; } catch { /* ignore */ } st.lastT = st.resumeAt; st.resumeAt = 0; }
  emit('time');
});
audio.addEventListener('ended', () => {
  if (st.loadedId && !st.counted) { st.counted = true; U.recordPlay(st.loadedId); }
  next(false);
});
let retried = null;
audio.addEventListener('error', async () => {
  const s = current();
  if (!s || !audio.getAttribute('src')) return;
  if (retried !== s.id) { // download URLs expire after ~1 hour: refresh once
    retried = s.id;
    onUrlError(s);
    const pos = audio.currentTime;
    return load(true, pos);
  }
  st.failed = true;
  s._bad = true;
  st.fails++;
  toast(`Can't play “${s.title || s.file}” (${(s.ext || '').toUpperCase()})`);
  if (st.fails < 6) setTimeout(() => next(false), 700);
});

let loadToken = 0;
async function load(autoplay = true, startAt = 0) {
  const s = current();
  const token = ++loadToken;
  st.listened = 0; st.lastT = startAt || 0; st.counted = false; st.started = false; st.failed = false;
  st.resumeAt = startAt || 0;
  if (!s) { audio.pause(); audio.removeAttribute('src'); st.loadedId = null; emit('track', null); return; }
  st.loadedId = s.id;
  if (retried && retried !== s.id) retried = null;
  emit('track', s);
  updateMediaSession(s);
  saveState();
  try {
    const url = await urlFor(s);
    if (token !== loadToken) return;
    audio.src = url;
    if (autoplay) {
      await audio.play().catch((e) => { if (e.name !== 'NotAllowedError' && e.name !== 'AbortError') throw e; });
    }
    prefetchNext();
  } catch (e) {
    if (token !== loadToken) return;
    console.warn(e);
    st.failed = true;
    st.fails++;
    toast('Playback error: ' + (e.message || e));
    if (st.fails < 6) setTimeout(() => next(false), 900);
  }
}

function prefetchNext() {
  const n = lib.byId.get(st.queue[st.idx + 1]);
  if (n) setTimeout(() => urlFor(n).catch(() => {}), 4000);
}

// ---- public controls ----
export function playList(songsOrIds, start = null, { shuffle, autoplay = true } = {}) {
  let ids = songsOrIds.map((x) => (typeof x === 'string' ? x : x.id)).filter((id) => playable(lib.byId.get(id)));
  if (!ids.length) { toast('Nothing playable in that list'); return; }
  if (shuffle !== undefined) st.shuffle = shuffle;
  const firstId = start != null ? (typeof start === 'string' ? start : ids[start]) : null;
  st.orig = ids.slice();
  let q = ids.slice(), i = 0;
  if (st.shuffle) {
    shuffleInPlace(q);
    if (firstId && q.includes(firstId)) { q.splice(q.indexOf(firstId), 1); q.unshift(firstId); }
  } else if (firstId) i = Math.max(0, q.indexOf(firstId));
  finalize(true);
  st.queue = q; st.idx = i; st.fails = 0;
  emit('queue'); emit('state');
  if (autoplay) load(true);
  else { audio.pause(); audio.removeAttribute('src'); st.loadedId = null; st.resumeAt = 0; emit('track', current()); updateMediaSession(current()); saveState(); }
}

// Reorder the queue (e.g. sorted by a column) keeping the current song playing
export function setOrder(ids) {
  const cur = st.queue[st.idx];
  st.queue = ids.slice();
  st.orig = ids.slice();
  st.shuffle = false;
  st.idx = Math.max(0, st.queue.indexOf(cur));
  emit('queue'); emit('state'); saveState();
}

export function toggle() {
  if (!current()) return emit('needmix');
  if (!audio.getAttribute('src')) return load(true, st.resumeAt);
  if (audio.paused) audio.play().catch(() => {}); else audio.pause();
}
export function pause() { audio.pause(); }

export function next(manual = true) {
  if (!st.queue.length) return;
  if (!manual && st.repeat === 'one') {
    load(true); // reload so this pass is counted as a fresh play
    return;
  }
  finalize(manual);
  let i = st.idx + 1;
  if (i >= st.queue.length) {
    if (st.repeat === 'all') i = 0;
    else if (prefs.endless) {
      const recent = st.queue.slice(-6).map((id) => lib.byId.get(id));
      const more = similarMix(recent, 20, new Set(st.queue));
      if (!more.length) { audio.pause(); return; }
      st.queue.push(...more.map((s) => s.id));
      if (st.orig) st.orig.push(...more.map((s) => s.id));
      emit('queue');
      toast('Added 20 similar songs to keep the music going');
    } else { audio.pause(); audio.currentTime = 0; return; }
  }
  st.idx = i;
  emit('queue');
  load(true);
}

export function prev() {
  if (audio.currentTime > 4 || st.idx <= 0) { audio.currentTime = 0; return; }
  finalize(false); // going back isn't a skip
  st.idx--;
  emit('queue');
  load(true);
}

export function jump(i) {
  if (i < 0 || i >= st.queue.length) return;
  finalize(true);
  st.idx = i;
  emit('queue');
  load(true);
}

export function seek(sec) { if (isFinite(sec)) audio.currentTime = Math.max(0, sec); }
export function setVolume(v) { audio.volume = v; prefs.volume = v; savePrefs(); }

export function setShuffle(on) {
  st.shuffle = on;
  const cur = st.queue[st.idx];
  if (on) {
    const rest = st.queue.slice(st.idx + 1);
    shuffleInPlace(rest);
    st.queue = st.queue.slice(0, st.idx + 1).concat(rest);
  } else if (st.orig) {
    const inQ = new Set(st.queue), inO = new Set(st.orig);
    st.queue = st.orig.filter((id) => inQ.has(id)).concat(st.queue.filter((id) => !inO.has(id)));
    st.idx = Math.max(0, st.queue.indexOf(cur));
  }
  emit('queue'); emit('state'); saveState();
}

export function cycleRepeat() {
  st.repeat = st.repeat === 'off' ? 'all' : st.repeat === 'all' ? 'one' : 'off';
  emit('state'); saveState();
  return st.repeat;
}

export function enqueue(songs, { playNext = false } = {}) {
  const ids = songs.map((s) => s.id).filter((id) => playable(lib.byId.get(id)));
  if (!ids.length) return;
  if (!st.queue.length) return playList(ids, 0, { shuffle: false });
  const at = playNext ? st.idx + 1 : st.queue.length;
  st.queue.splice(at, 0, ...ids);
  if (st.orig) st.orig.push(...ids);
  emit('queue'); saveState();
  toast(`${playNext ? 'Playing next' : 'Added to queue'}: ${ids.length} song${ids.length > 1 ? 's' : ''}`);
}

export function removeAt(indices) {
  const set = new Set(indices);
  const cur = st.queue[st.idx];
  const removingCurrent = set.has(st.idx);
  st.queue = st.queue.filter((_, i) => !set.has(i));
  if (removingCurrent) {
    st.idx = Math.min(st.idx - [...set].filter((i) => i < st.idx).length, st.queue.length - 1);
    emit('queue');
    load(!audio.paused);
  } else {
    st.idx = st.queue.indexOf(cur);
    emit('queue');
  }
  saveState();
}

// ---- persistence of the session ----
const QKEY = 'music.session';
export function saveState() {
  try {
    localStorage.setItem(QKEY, JSON.stringify({
      queue: st.queue, orig: st.orig, idx: st.idx, shuffle: st.shuffle, repeat: st.repeat,
      pos: Math.floor(audio.currentTime || st.resumeAt || 0), at: Date.now(),
    }));
  } catch { /* ignore */ }
}
setInterval(() => { if (!audio.paused) saveState(); }, 10000);

export function restoreState(maxAgeMs = Infinity) {
  try {
    const s = JSON.parse(localStorage.getItem(QKEY) || 'null');
    if (!s || !s.queue?.length) return false;
    if (!(Date.now() - (s.at || 0) < maxAgeMs)) return false;
    st.queue = s.queue.filter((id) => lib.byId.has(id));
    if (!st.queue.length) return false;
    st.orig = s.orig?.filter((id) => lib.byId.has(id)) || null;
    st.idx = Math.min(Math.max(0, s.idx), st.queue.length - 1);
    st.shuffle = !!s.shuffle; st.repeat = s.repeat || 'off';
    st.resumeAt = s.pos || 0;
    st.loadedId = null;
    emit('queue'); emit('track', current()); emit('state');
    updateMediaSession(current());
    return true;
  } catch { return false; }
}

// ---- lock screen / media keys ----
let artUrlFor = () => null;
export function setArtResolver(fn) { artUrlFor = fn; }
export function updateMediaSession(s) {
  if (!('mediaSession' in navigator) || !s) return;
  const art = artUrlFor(s);
  navigator.mediaSession.metadata = new MediaMetadata({
    title: s.title || s.file, artist: s.artist || '', album: s.album || '',
    artwork: art ? [{ src: art, sizes: '300x300', type: 'image/jpeg' }] : [],
  });
}
if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  const h = (a, f) => { try { ms.setActionHandler(a, f); } catch { /* unsupported */ } };
  h('play', () => toggle());
  h('pause', () => pause());
  h('nexttrack', () => next(true));
  h('previoustrack', () => prev());
  h('seekto', (d) => seek(d.seekTime));
  h('seekbackward', (d) => seek(audio.currentTime - (d.seekOffset || 10)));
  h('seekforward', (d) => seek(audio.currentTime + (d.seekOffset || 10)));
}
let psTimer = 0;
function positionStateSoon() {
  const now = Date.now();
  if (now - psTimer < 5000 || !('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  psTimer = now;
  try {
    if (isFinite(audio.duration)) navigator.mediaSession.setPositionState({ duration: audio.duration, position: Math.min(audio.currentTime, audio.duration), playbackRate: 1 });
  } catch { /* ignore */ }
}
