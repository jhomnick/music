// Which files the current browser can play
const MIME = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', m4b: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', alac: 'audio/mp4',
  flac: 'audio/flac', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg; codecs=opus',
  webm: 'audio/webm', aif: 'audio/aiff', aiff: 'audio/aiff', wma: 'audio/x-ms-wma', ape: 'audio/ape', wv: 'audio/wavpack',
};
export const AUDIO_EXT = new Set(Object.keys(MIME));
export const PLAYLIST_EXT = new Set(['m3u', 'm3u8', 'pls', 'wpl', 'zpl']);

const cache = {};
let probe;
let forceAll = false;
export function setPlayAll(v) { forceAll = v; }

export function canPlayExt(ext) {
  if (forceAll) return true;
  if (!(ext in cache)) {
    probe ||= document.createElement('audio');
    cache[ext] = !!(MIME[ext] && probe.canPlayType(MIME[ext]));
    // Safari reports '' for audio/flac on some versions but plays it fine
    if (!cache[ext] && ext === 'flac' && /Safari/.test(navigator.userAgent)) cache[ext] = true;
    if (!cache[ext] && ext === 'mp3') cache[ext] = true; // universally supported
  }
  return cache[ext];
}

export function playable(s) {
  return !!s && !s.drm && !s._bad && canPlayExt(s.ext);
}
