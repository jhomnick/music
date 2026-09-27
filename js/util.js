// Small shared helpers
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.flush = (...a) => { clearTimeout(t); return fn(...a); };
  d.cancel = () => clearTimeout(t);
  return d;
}

export function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) {
    if (k == null || k === false) continue;
    e.append(k.nodeType ? k : document.createTextNode(k));
  }
  return e;
}

export function icon(name, cls = '') {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'i ' + cls);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(ns, 'use');
  use.setAttribute('href', '#i-' + name);
  svg.append(use);
  return svg;
}

const pad = (n) => String(n).padStart(2, '0');
export function fmtTime(s) {
  if (s == null || isNaN(s)) return '';
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return (h ? h + ':' + pad(m) : m) + ':' + pad(x);
}
export function fmtDur(s) {
  if (!s) return '0 min';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.round((s % 3600) / 60);
  if (d) return `${d} d ${h} hr`;
  if (h) return `${h} hr ${m} min`;
  return `${m} min`;
}
export function fmtSize(b) {
  if (!b) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return (i > 1 ? b.toFixed(1) : Math.round(b)) + ' ' + u[i];
}
export function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d)) return '';
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}
export function fmtNum(n) { return n == null ? '' : n.toLocaleString(); }

export function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2);
}

export function hash(str) {
  let h = 2166136261;
  str = String(str || '');
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export const norm = (s) =>
  (s == null ? '' : String(s)).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');

// Sort key: case/accents insensitive, ignores a leading "The "
export const sortText = (s) => norm(s).replace(/^the\s+/, '').trim();

// Normalize a track title for fuzzy matching against online sources
export const normTitle = (s) =>
  norm(s)
    .replace(/\s*[([{].*?(remaster|live|mono|stereo|version|edit|mix|demo|bonus|deluxe|feat|single).*?[)\]}]/g, '')
    .replace(/\s+-\s+.*(remaster|live|version|edit|mix|mono|stereo).*$/, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

export function shuffleInPlace(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export async function gzipText(str) {
  const cs = new Blob([str]).stream().pipeThrough(new CompressionStream('gzip'));
  return await new Response(cs).blob();
}
export async function gunzipText(blob) {
  const ds = blob.stream().pipeThrough(new DecompressionStream('gzip'));
  return await new Response(ds).text();
}

let toastTimer;
export function toast(msg, ms = 3200) {
  let t = document.getElementById('toast');
  if (!t) { t = el('div', { id: 'toast', role: 'status' }); document.body.append(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

export function decodeText(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { return new TextDecoder('windows-1252').decode(buf); }
}

export const isNarrow = () => window.matchMedia('(max-width: 760px)').matches;
