// Music — app shell: start-up, navigation, table, player UI, dialogs
import { $, $$, el, icon, debounce, fmtTime, fmtDur, fmtSize, fmtDate, fmtNum, norm, toast, isNarrow, sleep } from './util.js';
import { prefs, savePrefs } from './prefs.js';
import { initAuth, login, logout, getAccount, redirectUri } from './auth.js';
import { lib, loadLocal, saveLocal, stats as libStats, FAMILY_NAMES } from './library.js';
import * as U from './userdata.js';
import { remoteUserData, pullUserData, remoteLibraryMeta, localLibEtag, downloadLibrary, uploadLibrary } from './sync.js';
import { COLUMNS, COL, DEFAULT_WIDE, DEFAULT_NARROW, applyView, colText, sortRows } from './view.js';
import { VTable } from './table.js';
import * as P from './player.js';
import { randomMix, similarMix, matchingSongs, familySongs, decadeSongs, randomSize } from './mix.js';
import { getArt, artNow, onArt, artKey, setArtResolver as setArtSource, placeholderHue, clearArtCache } from './art.js';
import { setPlayAll, playable } from './formats.js';
import { scanLibrary, listFolders, specialMusicFolder, rootFolder } from './scanner.js';
import { importPlaylists } from './playlists.js';
import { streamFor, onStreamError, artFor } from './source.js';
import * as E from './enrich.js';

const S = {
  mode: 'graph',
  viewId: 'queue',
  view: null,
  rows: [],
  rowIdx: null,     // queue view: row -> queue index
  search: '',
  filters: {},
  sorts: {},        // viewId -> [{key, dir}]
  table: null,
  narrow: isNarrow(),
};

// =====================================================================
// Start-up
// =====================================================================
function showScreen(name) {
  for (const s of ['loading', 'setup', 'signin']) $('#screen-' + s).hidden = s !== name;
  $('#app').hidden = name !== 'app';
}
function loading(text) { showScreen('loading'); $('#loading-text').textContent = text; }

async function boot() {
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  $('#setup-redirect').textContent = redirectUri();
  wireSetup();
  if (prefs.demo) return startDemo();
  if (!prefs.clientId) return showScreen('setup');
  loading('Signing in…');
  let account = null;
  try {
    account = await initAuth(prefs.clientId, prefs.accountType);
  } catch (e) {
    showScreen('signin');
    const err = $('#signin-error');
    err.hidden = false;
    err.textContent = 'Sign-in problem: ' + (e.errorMessage || e.message || e);
    return;
  }
  if (!account) return showScreen('signin');
  startGraph();
}

function wireSetup() {
  $('#setup-client').value = prefs.clientId || '';
  $('#setup-lastfm').value = prefs.lastfmKey || '';
  $('#setup-acct').value = prefs.accountType || 'personal';
  $('#setup-form').addEventListener('submit', (e) => {
    e.preventDefault();
    prefs.clientId = $('#setup-client').value.trim();
    prefs.lastfmKey = $('#setup-lastfm').value.trim();
    prefs.accountType = $('#setup-acct').value;
    prefs.demo = false;
    savePrefs();
    location.reload();
  });
  const demo = (e) => { e.preventDefault(); prefs.demo = true; savePrefs(); location.reload(); };
  $('#setup-demo').addEventListener('click', demo);
  $('#signin-demo').addEventListener('click', demo);
  $('#signin-setup').addEventListener('click', (e) => { e.preventDefault(); showScreen('setup'); });
  $('#signin-btn').addEventListener('click', () => login().catch((e) => { const x = $('#signin-error'); x.hidden = false; x.textContent = e.message; }));
}

async function startDemo() {
  S.mode = 'demo';
  $('#demo-badge').hidden = false;
  setPlayAll(true);
  const { makeDemoLibrary, demoUserData, demoStream } = await import('./demo.js');
  P.setSource(demoStream);
  loading('Building a 50,000-song demo library…');
  await sleep(30);
  makeDemoLibrary(50000);
  U.setStoreKey('userdata-demo');
  await U.loadLocal();
  if (!Object.keys(U.getUd().devices).length) U.adoptMerged(demoUserData(lib));
  enterApp();
}

async function startGraph() {
  S.mode = 'graph';
  P.setSource(streamFor, onStreamError);
  setArtSource(artFor);
  U.setRemote(remoteUserData);
  loading('Opening your library…');
  await U.loadLocal();
  let hasLocal = false;
  try { hasLocal = await loadLocal(); } catch (e) { console.warn('Local library unreadable', e); }
  if (hasLocal) {
    enterApp();
    backgroundSync();
    return;
  }
  let got = false;
  try { got = await downloadLibrary(loading); } catch (e) { console.warn(e); }
  try { await pullUserData(); } catch (e) { console.warn(e); }
  enterApp();
  if (!got) setTimeout(() => chooseFolderAndScan(true), 300);
}

async function backgroundSync() {
  const job = setJob('sync', 'Syncing with OneDrive…');
  try {
    await pullUserData();
    const meta = await remoteLibraryMeta();
    if (meta && meta.eTag !== localLibEtag()) {
      job.update('Downloading updated library…');
      await downloadLibrary();
      U.applyAll();
      refreshAll(true);
      toast('Library updated from OneDrive');
    } else if (!meta && lib.songs.length) {
      job.update('Saving library to OneDrive…');
      await uploadLibrary();
    }
    // Pick up new/changed music (cheap incremental check) at most every 12 hours
    if (lib.meta.rootId && Date.now() - (lib.meta.scannedAt || 0) > 12 * 3600e3) {
      job.update('Checking for new music…');
      const r = await scanLibrary({ rootId: lib.meta.rootId, rootPath: lib.meta.rootPath });
      if (Object.keys(lib.meta.playlistFiles).length) await importPlaylists();
      U.applyAll();
      await uploadLibrary();
      refreshAll(true);
      if (r.added || r.removed) toast(`Library updated: ${r.added} new, ${r.removed} removed`);
    }
  } catch (e) {
    console.warn('Background sync', e);
  } finally {
    job.done();
  }
}

// =====================================================================
// App shell
// =====================================================================
function enterApp() {
  showScreen('app');
  U.applyAll();
  wireChrome();
  wirePlayer();
  buildTable();
  const restored = P.restoreState(6 * 3600e3);
  if (!restored && lib.songs.length) {
    P.playList(randomMix(randomSize()), null, { shuffle: true, autoplay: false });
  }
  setView('queue');
  buildNav();
  updatePlayer();
  U.events.addEventListener('change', (e) => {
    const k = e.detail?.kind;
    if (k === 'sync' || k === 'playlist') { buildNav(); refreshView(true); }
    else S.table?.refresh();
    if (k === 'rating') renderRating();
  });
  onArt((key) => {
    S.table?.refresh();
    const c = P.current();
    if (c && artKey(c) === key) updateArt(c);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { P.saveState(); U.flushLocal(); U.pushNow(); }
  });
  window.addEventListener('pagehide', () => { P.saveState(); U.flushLocal(); });
  matchMedia('(max-width: 760px)').addEventListener('change', () => { S.narrow = isNarrow(); buildTable(); refreshView(true); });
}

function refreshAll(keepScroll) { buildNav(); refreshView(keepScroll); renderRating(); }

// ---------- views ----------
const DAY = 864e5;
const SMART = {
  recent: { title: 'Recently Added', icon: 'new', songs: () => { const t = Date.now() - 90 * DAY; return lib.songs.filter((s) => s._added > t); }, sort: [{ key: 'added', dir: 'desc' }] },
  played: { title: 'Recently Played', icon: 'clock', songs: () => lib.songs.filter((s) => s._last), sort: [{ key: 'lastPlayed', dir: 'desc' }] },
  most: { title: 'Most Played', icon: 'fire', songs: () => lib.songs.filter((s) => s._plays > 0), sort: [{ key: 'plays', dir: 'desc' }] },
  top: { title: 'Top Rated', icon: 'star', songs: () => lib.songs.filter((s) => s._rating >= 4), sort: [{ key: 'rating', dir: 'desc' }] },
  never: { title: 'Never Played', icon: 'ghost', songs: () => lib.songs.filter((s) => !s._plays && playable(s)) },
  skipped: { title: 'Often Skipped', icon: 'skip', songs: () => lib.songs.filter((s) => s._skips >= 2), sort: [{ key: 'skips', dir: 'desc' }] },
};

function viewDef(id) {
  if (id === 'library') return { id, title: 'Library', songs: () => lib.songs };
  if (id === 'queue') return { id, title: 'Now Playing', queue: true, songs: () => P.st.queue.map((x) => lib.byId.get(x)).filter(Boolean) };
  const [kind, arg] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];
  if (kind === 'smart' && SMART[arg]) return { id, ...SMART[arg] };
  if (kind === 'genre') return { id, title: arg, songs: () => familySongs(arg) };
  if (kind === 'decade') return { id, title: arg + 's', songs: () => decadeSongs(+arg) };
  if (kind === 'pl') {
    const p = U.getUd().playlists[arg];
    if (p && !p.deleted) return { id, title: p.name, playlist: p, songs: () => p.songIds.map((x) => lib.byId.get(x)).filter(Boolean), keepOrder: true };
  }
  if (kind === 'imp') {
    const p = lib.meta.importedPlaylists[arg];
    if (p) return { id, title: p.name, imported: p, songs: () => p.songIds.map((x) => lib.byId.get(x)).filter(Boolean), keepOrder: true };
  }
  return viewDef('library');
}

function setView(id, { search = '', filters = {} } = {}) {
  S.viewId = id;
  S.view = viewDef(id);
  S.viewId = S.view.id;
  S.search = search;
  S.filters = { ...filters };
  $('#search').value = search;
  if (!S.sorts[S.viewId]) S.sorts[S.viewId] = S.view.sort ? S.view.sort.slice() : (S.view.queue || S.view.keepOrder ? [] : [{ key: 'artist', dir: 'asc' }]);
  $('#view-title').textContent = S.view.title;
  S.table?.buildHeader();
  refreshView(false);
  markNav();
  $('#app').classList.remove('drawer');
  if (id === 'queue') setTimeout(() => S.table?.scrollToIndex(Math.max(0, S.rowIdx ? S.rowIdx.indexOf(P.st.idx) : 0), true), 30);
}

function refreshView(keepScroll) {
  if (!S.view) return;
  S.view = viewDef(S.viewId);
  const base = S.view.songs();
  const sort = S.sorts[S.viewId] || [];
  if (S.view.queue) {
    const shown = applyView(base, { search: S.search, filters: S.filters, sort: [] });
    // map back to queue positions (order preserved, duplicates walked in sequence)
    const idx = [];
    let j = 0;
    for (const s of shown) { while (j < base.length && base[j] !== s) j++; idx.push(j++); }
    S.rows = shown; S.rowIdx = idx;
  } else {
    S.rows = applyView(base, { search: S.search, filters: S.filters, sort });
    S.rowIdx = null;
  }
  S.table.setRows(S.rows, { keepScroll });
  const dur = S.rows.reduce((t, s) => t + (s.duration || 0), 0);
  const filtered = S.rows.length !== base.length;
  $('#view-meta').textContent = `${fmtNum(S.rows.length)}${filtered ? ' of ' + fmtNum(base.length) : ''} songs · ${fmtDur(dur)}`;
  $('#btn-mix').title = S.search || Object.keys(S.filters).length || S.viewId !== 'library' ? 'Mix of songs similar to this list' : 'Random mix of ' + prefs.mixSize + ' songs';
  updateChips();
  updateNavCounts();
}
const refreshViewSoon = debounce(() => refreshView(false), 160);

// ---------- table ----------
function colPrefs() {
  const keyName = S.narrow ? 'colsNarrow' : 'colsWide';
  if (!prefs[keyName]) prefs[keyName] = (S.narrow ? DEFAULT_NARROW : DEFAULT_WIDE).map((k) => ({ key: k, w: COL[k].w }));
  return prefs[keyName];
}
function buildTable() {
  const root = $('#table');
  root.replaceChildren();
  S.table = new VTable(root, {
    rowH: S.narrow ? 52 : 38,
    getCols: () => colPrefs(),
    getSort: () => S.sorts[S.viewId] || [],
    getFilters: () => S.filters,
    showFilters: () => prefs.showFilters && !S.narrow,
    onSort: (key, add) => sortBy(key, add),
    onFilter: (key, v) => { if (v) S.filters[key] = v; else delete S.filters[key]; refreshViewSoon(); },
    onResize: (key, w) => { const c = colPrefs().find((x) => x.key === key); if (c) c.w = w; savePrefs(); },
    onPlay: (s, i) => playRow(i),
    onCell: (s, key, i, e) => cellMenu(s, key, i, e),
    onMenu: (s, i, e) => cellMenu(s, null, i, e),
    onRate: (s, r) => rate(s, r),
    isActive: (s, i) => (S.rowIdx ? S.rowIdx[i] === P.st.idx : s.id === P.st.queue[P.st.idx]),
    emptyText: () => (lib.songs.length ? 'No matching songs' : 'Your library is empty — open Settings to choose your OneDrive music folder.'),
    closeMenus: () => closeMenu(),
  });
  $('#btn-filters').classList.toggle('on', !!prefs.showFilters);
}

function sortBy(key, add) {
  let sort = (S.sorts[S.viewId] || []).slice();
  const i = sort.findIndex((x) => x.key === key);
  const numericFirstDesc = ['num', 'date', 'rating', 'pop', 'time'].includes(COL[key].type) && key !== 'year' && key !== 'track' && key !== 'disc';
  if (i >= 0) {
    if (sort[i].dir === (numericFirstDesc ? 'desc' : 'asc')) sort[i] = { key, dir: numericFirstDesc ? 'asc' : 'desc' };
    else sort.splice(i, 1);
  } else {
    const n = { key, dir: numericFirstDesc ? 'desc' : 'asc' };
    sort = add ? [...sort, n] : [n];
  }
  if (S.view.queue) {
    // sorting "Now Playing" reorders what plays next
    const ids = sortRows(S.view.songs(), sort.length ? sort : []).map((s) => s.id);
    P.setOrder(ids);
    toast(sort.length ? `Queue sorted by ${COL[key].label}` : 'Queue order kept');
    S.sorts[S.viewId] = [];
    S.table.buildHeader();
    return refreshView(true);
  }
  S.sorts[S.viewId] = sort;
  S.table.buildHeader();
  refreshView(true);
}

function playRow(i) {
  if (S.view.queue) return P.jump(S.rowIdx[i]);
  P.playList(S.rows, i, { shuffle: P.st.shuffle && S.rows.length > 1 ? true : undefined });
}

function rate(s, r) {
  U.setRating(s.id, s._rating === r ? 0 : r);
  S.table.refresh();
  renderRating();
}

// ---------- chrome / toolbar ----------
let chromeWired = false;
function wireChrome() {
  if (chromeWired) return;
  chromeWired = true;
  $('#search').addEventListener('input', (e) => { S.search = e.target.value; refreshViewSoon(); });
  $('#search').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.target.value = ''; S.search = ''; refreshView(false); e.target.blur(); } });
  $('#btn-play').addEventListener('click', () => {
    if (!S.rows.length) return;
    if (S.view.queue) return P.jump(S.rowIdx[0]);
    P.playList(S.rows, 0, { shuffle: false });
  });
  $('#btn-shuffle').addEventListener('click', () => {
    if (!S.rows.length) return;
    if (S.view.queue) { P.setShuffle(true); if (P.audio.paused) P.toggle(); return toast('Shuffled what’s up next'); }
    P.playList(S.rows, null, { shuffle: true });
  });
  $('#btn-mix').addEventListener('click', () => mixFromView());
  $('#btn-save').addEventListener('click', () => saveListAsPlaylist(S.rows, S.view.queue ? 'Mix ' + fmtDate(Date.now()) : S.search ? S.search : S.view.title));
  $('#btn-filters').addEventListener('click', () => { prefs.showFilters = !prefs.showFilters; savePrefs(); $('#btn-filters').classList.toggle('on', prefs.showFilters); if (!prefs.showFilters && Object.keys(S.filters).length) { S.filters = {}; refreshView(true); } S.table.buildHeader(); });
  $('#btn-cols').addEventListener('click', () => columnsDialog());
  $('#btn-settings').addEventListener('click', () => settingsDialog());
  $('#btn-menu').addEventListener('click', () => $('#app').classList.toggle('drawer'));
  $('#scrim').addEventListener('click', () => $('#app').classList.remove('drawer'));
  document.addEventListener('keydown', onKey);
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#menu')) closeMenu(); }, true);
  window.addEventListener('resize', () => closeMenu());
}

function onKey(e) {
  const t = e.target;
  if (e.key === 'Escape') { closeMenu(); if (!$('#sheet').hidden) closeSheet(); return; }
  if (t.closest('input, textarea, select, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (document.querySelector('dialog[open]')) return;
  if (e.key === ' ') { e.preventDefault(); P.toggle(); }
  else if (e.key === 'n' || e.key === 'N') P.next(true);
  else if (e.key === 'p' || e.key === 'P') P.prev();
  else if (e.key === '/') { e.preventDefault(); $('#search').focus(); }
  else if (e.key === 's' || e.key === 'S') P.setShuffle(!P.st.shuffle);
  else if (e.key === 'r' || e.key === 'R') toast('Replay: ' + P.cycleRepeat());
}

function mixFromView() {
  const filtered = S.search || Object.keys(S.filters).length || (S.viewId !== 'library' && S.viewId !== 'queue');
  let mix;
  if (filtered && S.rows.length) {
    const seeds = S.rows.length > 400 ? sampleArr(S.rows, 400) : S.rows;
    mix = similarMix(seeds, prefs.mixSize);
    toast(`Mix: ${mix.length} songs like “${S.search || S.view.title}”`);
  } else {
    mix = randomMix(randomSize());
    toast(`Fresh random mix: ${mix.length} songs`);
  }
  P.playList(mix, null, { shuffle: true });
  setView('queue');
}
const sampleArr = (a, n) => { const c = a.slice(); for (let i = 0; i < n; i++) { const j = i + Math.floor(Math.random() * (c.length - i)); [c[i], c[j]] = [c[j], c[i]]; } return c.slice(0, n); };

// ---------- suggestion chips ----------
function chip(label, ic, fn, hot = false) {
  return el('button', { class: 'chip' + (hot ? ' hot' : ''), onclick: fn }, icon(ic), label);
}
function updateChips() {
  const box = $('#chips');
  const out = [];
  if (S.narrow && !S.view.queue) {
    const cur = (S.sorts[S.viewId] || [])[0];
    out.push(chip(`Sort: ${cur ? COL[cur.key].label + (cur.dir === 'desc' ? ' ↓' : ' ↑') : 'None'}`, 'list', (e) => sortMenu(e)));
  }
  const q = norm(S.search.trim());
  if (q.length >= 2 && S.rows.length) {
    // artist match → play all + similar mix ("search Pink Floyd, get a quick similar playlist")
    const counts = new Map();
    for (const s of S.rows) {
      const a = s.artist || s.albumArtist;
      if (a && norm(a).includes(q)) counts.set(a, (counts.get(a) || 0) + 1);
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2);
    for (const [a] of top) {
      const songs = matchingSongs('artist', a);
      out.push(chip(`Mix like ${a}`, 'spark', () => { P.playList(similarMix(songs, prefs.mixSize), null, { shuffle: true }); setView('queue'); toast(`Mix inspired by ${a}`); }, true));
      out.push(chip(`All ${a} (${songs.length})`, 'play', () => P.playList(sortRows(songs, [{ key: 'year', dir: 'asc' }, { key: 'album', dir: 'asc' }]), 0, { shuffle: false })));
    }
    const fams = FAMILY_NAMES.filter((f) => norm(f).includes(q));
    for (const f of fams.slice(0, 1)) out.push(chip(`${f} mix`, 'spark', () => quickMix(familySongs(f), f)));
    const y = /^(19|20)\d\d$/.exec(q);
    if (y) out.push(chip(`All from ${q}`, 'play', () => P.playList(matchingSongs('year', +q), null, { shuffle: true })));
    const dec = /^(?:19)?([2-9]0)'?s$/.exec(q) || /^(20[0-2]0)'?s$/.exec(q);
    if (dec) { const d = dec[1].length === 2 ? 1900 + +dec[1] : +dec[1]; out.push(chip(`${d}s mix`, 'spark', () => quickMix(decadeSongs(d), d + 's'))); }
  }
  if (S.view.queue) {
    out.push(chip('New random mix', 'spark', () => { P.playList(randomMix(randomSize()), null, { shuffle: true }); refreshView(false); }));
    if (P.current()) out.push(chip('More like this song', 'spark', () => similarToSong(P.current())));
  }
  box.replaceChildren(...out);
}

function quickMix(songs, label, n = 30) {
  if (!songs.length) return toast('No songs found');
  const mix = randomMix(n, songs);
  P.playList(mix, null, { shuffle: true });
  toast(`${label}: ${mix.length} songs`);
  if (S.viewId === 'queue') refreshView(false);
}

function similarToSong(s) {
  const mix = similarMix([s], prefs.mixSize - 1, new Set([s.id]));
  const cur = P.current();
  if (cur && cur.id === s.id) {
    // keep this song playing, replace what's next
    P.setOrder([s.id, ...mix.map((x) => x.id)]);
  } else P.playList([s, ...mix], 0, { shuffle: false });
  toast(`Mix of songs like “${s.title}”`);
  setView('queue');
}

function sortMenu(e) {
  const cur = (S.sorts[S.viewId] || [])[0];
  const items = [{ header: 'Sort by' }];
  for (const c of COLUMNS) if (!c.noSort) items.push({ label: c.label + (cur?.key === c.key ? (cur.dir === 'desc' ? '  ↓' : '  ↑') : ''), action: () => sortBy(c.key, false) });
  showMenu(e, items);
}

// ---------- navigation ----------
function navItem(id, label, ic, cnt, quick) {
  const b = el('button', { class: 'nav-i', 'data-view': id, onclick: () => setView(id) }, icon(ic), el('span', { class: 'lbl', text: label }), cnt != null ? el('span', { class: 'cnt', text: fmtNum(cnt) }) : null);
  if (quick) {
    const q = el('span', { class: 'qp', title: 'Play a mix', role: 'button' }, icon('play'));
    q.addEventListener('click', (e) => { e.stopPropagation(); quick(); });
    b.append(q);
  }
  return b;
}
function buildNav() {
  const nav = $('#nav');
  const items = [];
  items.push(navItem('queue', 'Now Playing', 'queue', P.st.queue.length));
  items.push(navItem('library', 'Library', 'library', lib.songs.length));
  items.push(el('button', { class: 'nav-i mix', onclick: () => { P.playList(randomMix(randomSize()), null, { shuffle: true }); setView('queue'); } }, icon('spark'), el('span', { class: 'lbl', text: 'New Random Mix' })));

  items.push(el('div', { class: 'nav-h', text: 'Smart lists' }));
  for (const [k, v] of Object.entries(SMART)) items.push(navItem('smart:' + k, v.title, v.icon, null, () => quickMix(v.songs(), v.title)));

  // Genre-first quick mixes
  const famCount = new Map();
  for (const s of lib.songs) for (const f of s._fam) famCount.set(f, (famCount.get(f) || 0) + 1);
  const fams = [...famCount.entries()].filter((x) => x[1] >= 10).sort((a, b) => b[1] - a[1]);
  if (fams.length) {
    items.push(el('div', { class: 'nav-h', text: 'Genres' }));
    const grid = el('div', { class: 'chipgrid' });
    for (const [f, n] of fams) {
      const b = el('button', { class: 'gchip', 'data-view': 'genre:' + f, title: `${fmtNum(n)} songs — click to browse, double-click to play a mix` , text: f });
      b.addEventListener('click', () => setView('genre:' + f));
      b.addEventListener('dblclick', () => quickMix(familySongs(f), f));
      grid.append(b);
    }
    items.push(grid);
  }
  const decs = new Map();
  for (const s of lib.songs) if (s.year > 1900) { const d = Math.floor(s.year / 10) * 10; decs.set(d, (decs.get(d) || 0) + 1); }
  const dlist = [...decs.entries()].filter((x) => x[1] >= 10).sort((a, b) => a[0] - b[0]);
  if (dlist.length) {
    items.push(el('div', { class: 'nav-h', text: 'Decades' }));
    const grid = el('div', { class: 'chipgrid' });
    for (const [d, n] of dlist) {
      const b = el('button', { class: 'gchip', 'data-view': 'decade:' + d, title: `${fmtNum(n)} songs — double-click to play a mix`, text: `${d}s` });
      b.addEventListener('click', () => setView('decade:' + d));
      b.addEventListener('dblclick', () => quickMix(decadeSongs(d), d + 's'));
      grid.append(b);
    }
    items.push(grid);
  }

  const newBtn = el('button', { title: 'New playlist', onclick: () => saveListAsPlaylist([], 'New Playlist') }, '+ New');
  items.push(el('div', { class: 'nav-h' }, el('span', { text: 'Playlists' }), newBtn));
  for (const p of U.playlists()) items.push(navItem('pl:' + p.id, p.name, 'list', p.songIds.length, () => P.playList(viewDef('pl:' + p.id).songs(), null, { shuffle: true })));
  const imp = Object.values(lib.meta.importedPlaylists || {}).filter((p) => p.songIds.length).sort((a, b) => a.name.localeCompare(b.name));
  if (imp.length) {
    items.push(el('div', { class: 'nav-h', text: 'From OneDrive' }));
    for (const p of imp) items.push(navItem('imp:' + p.id, p.name, 'cloud', p.songIds.length, () => P.playList(viewDef('imp:' + p.id).songs(), null, { shuffle: true })));
  }
  nav.replaceChildren(...items);
  markNav();
}
function markNav() {
  $$('#nav [data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === S.viewId));
}
function updateNavCounts() {
  const q = $('#nav [data-view="queue"] .cnt');
  if (q) q.textContent = fmtNum(P.st.queue.length);
}

// =====================================================================
// Menus
// =====================================================================
function closeMenu() { const m = $('#menu'); if (!m.hidden) { m.hidden = true; m.replaceChildren(); } }

function showMenu(e, items) {
  const m = $('#menu');
  m.replaceChildren();
  for (const it of items) {
    if (!it) continue;
    if (it.sep) { m.append(el('hr')); continue; }
    if (it.header) { m.append(el('div', { class: 'mh', html: it.header })); continue; }
    const b = el('button', { role: 'menuitem' }, it.icon ? icon(it.icon) : el('span', { class: 'i' }), el('span', { text: it.label }), it.n != null ? el('span', { class: 'n', text: it.n }) : null);
    b.addEventListener('click', (ev) => { ev.stopPropagation(); if (!it.keep) closeMenu(); it.action?.(ev); });
    m.append(b);
  }
  m.hidden = false;
  const r = m.getBoundingClientRect();
  let x, y;
  if (e && e.clientX != null && (e.clientX || e.clientY)) { x = e.clientX; y = e.clientY; }
  else { const t = (e?.target || document.body).getBoundingClientRect(); x = t.left; y = t.bottom + 4; }
  x = Math.min(x, innerWidth - r.width - 8);
  y = y + r.height > innerHeight - 8 ? Math.max(8, y - r.height) : y;
  m.style.left = Math.max(8, x) + 'px';
  m.style.top = Math.max(8, y) + 'px';
}

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Clicking any cell: play the song, or act on every song sharing that value (e.g. Year = 1973)
function cellMenu(s, key, i, e) {
  const col = key && COL[key];
  const items = [{ header: `<b>${esc(s.title || s.file)}</b>` }];
  items.push({ label: 'Play', icon: 'play', action: () => playRow(i) });
  items.push({ label: 'Play next', icon: 'queue', action: () => P.enqueue([s], { playNext: true }) });
  items.push({ label: 'Add to queue', icon: 'list', action: () => P.enqueue([s]) });
  items.push({ label: 'Mix of songs like this', icon: 'spark', action: () => similarToSong(s) });

  const valueCol = col && !['art', 'rating', 'playlists', 'title', 'song', 'file'].includes(col.key);
  if (valueCol) {
    const v = col.get(s);
    if (v != null && v !== '' && !(col.key === 'plays' && v === 0)) {
      items.push({ sep: true }, { header: `${esc(col.label)}: <b>${esc(colText(col, s))}</b>` });
      items.push(...valueActions(col, v));
    }
  } else {
    // clicked the song itself: offer its artist / album / year / genre
    items.push({ sep: true }, { header: 'Everything with the same…' });
    for (const k of ['artist', 'album', 'year', 'genre']) {
      const c = COL[k], v = c.get(s);
      if (v == null || v === '') continue;
      items.push({ label: `${c.label}: ${colText(c, s)}`, icon: 'down', n: fmtNum(matchingSongs(k, v).length), keep: true, action: (ev) => showMenu(ev, [{ header: `${esc(c.label)}: <b>${esc(colText(c, s))}</b>` }, ...valueActions(c, v)]) });
    }
  }
  if (col && col.key === 'playlists' && s._pl) {
    items.push({ sep: true }, { header: 'On playlists' });
    for (const name of s._pl.split(', ')) {
      const p = U.playlists().find((x) => x.name === name);
      const ip = Object.values(lib.meta.importedPlaylists).find((x) => x.name === name);
      items.push({ label: name, icon: p ? 'list' : 'cloud', action: () => setView(p ? 'pl:' + p.id : 'imp:' + ip.id) });
    }
  }
  items.push({ sep: true });
  items.push({ label: 'Add to playlist…', icon: 'save', action: (ev) => addToPlaylistMenu([s], ev) });
  if (s.artist) items.push({ label: `Go to ${s.artist}`, icon: 'library', action: () => setView('library', { filters: { artist: '=' + s.artist } }) });
  if (s.album) items.push({ label: `Go to album`, icon: 'disc', action: () => { setView('library', { filters: { album: '=' + s.album } }); S.sorts.library = [{ key: 'disc', dir: 'asc' }, { key: 'track', dir: 'asc' }]; S.table.buildHeader(); refreshView(false); } });
  if (S.view.queue && S.rowIdx) items.push({ label: 'Remove from queue', icon: 'x', action: () => P.removeAt([S.rowIdx[i]]) });
  if (S.view.playlist) items.push({ label: 'Remove from playlist', icon: 'x', action: () => { const p = S.view.playlist; const ids = p.songIds.slice(); const k = ids.indexOf(s.id); if (k >= 0) ids.splice(k, 1); U.updatePlaylist(p.id, { songIds: ids }); } });
  items.push({ header: `Rating · played ${s._plays || 0}× · skipped ${s._skips || 0}×` });
  items.push({ label: '★★★★★  ' + (s._rating ? `(yours: ${s._rating})` : ''), icon: 'star', action: (ev) => ratingMenu(s, ev) });
  if (s._plays || s._skips) items.push({ label: 'Reset play & skip counts', icon: 'x', action: () => { U.resetStats(s.id); S.table.refresh(); } });
  showMenu(e, items);
}

// Play / shuffle / mix / show every song whose column equals this value (e.g. Year = 1973)
function valueActions(col, v) {
  const matches = matchingSongs(col.key, v);
  return [
    { label: 'Play all', icon: 'play', n: fmtNum(matches.length), action: () => P.playList(sortRows(matches, [{ key: 'artist', dir: 'asc' }, { key: 'year', dir: 'asc' }]), 0, { shuffle: false }) },
    { label: 'Shuffle all', icon: 'shuffle', n: fmtNum(matches.length), action: () => P.playList(matches, null, { shuffle: true }) },
    { label: 'Similar mix', icon: 'spark', action: () => { P.playList(similarMix(matches.length > 400 ? sampleArr(matches, 400) : matches, prefs.mixSize), null, { shuffle: true }); setView('queue'); } },
    { label: 'Show all in library', icon: 'search', action: () => setView('library', { filters: { [col.key]: col.type === 'text' ? '=' + v : String(col.type === 'date' ? fmtDate(v) : v) } }) },
  ];
}

function ratingMenu(s, e) {
  const items = [{ header: 'Your rating' }];
  for (let r = 5; r >= 1; r--) items.push({ label: '★'.repeat(r) + '☆'.repeat(5 - r), action: () => rate(s, r) });
  items.push({ label: 'Clear rating', action: () => { U.setRating(s.id, 0); S.table.refresh(); renderRating(); } });
  showMenu(e, items);
}

function addToPlaylistMenu(songs, e) {
  const items = [{ header: `Add ${songs.length} song${songs.length > 1 ? 's' : ''} to` }];
  items.push({ label: 'New playlist…', icon: 'new', action: () => saveListAsPlaylist(songs, 'New Playlist') });
  for (const p of U.playlists()) items.push({ label: p.name, icon: 'list', n: p.songIds.length, action: () => { U.updatePlaylist(p.id, { songIds: [...p.songIds, ...songs.map((s) => s.id).filter((id) => !p.songIds.includes(id))] }); toast(`Added to ${p.name}`); } });
  showMenu(e, items);
}

async function saveListAsPlaylist(songs, suggested) {
  const name = await promptDialog('Save as playlist', 'Playlist name', suggested);
  if (!name) return;
  const existing = U.playlists().find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    U.updatePlaylist(existing.id, { songIds: songs.map((s) => s.id) });
    toast(`Updated “${name}” (${songs.length} songs)`);
  } else {
    const id = U.createPlaylist(name, songs.map((s) => s.id));
    toast(`Saved “${name}” (${songs.length} songs)`);
    if (!songs.length) setView('pl:' + id);
  }
  buildNav();
}

// =====================================================================
// Player UI
// =====================================================================
let playerWired = false;
function wirePlayer() {
  if (playerWired) return;
  playerWired = true;
  const on = (id, f) => $(id).addEventListener('click', f);
  on('#c-play', () => P.toggle()); on('#s-play', () => P.toggle());
  on('#c-next', () => P.next(true)); on('#s-next', () => P.next(true));
  on('#c-prev', () => P.prev()); on('#s-prev', () => P.prev());
  on('#c-shuffle', () => P.setShuffle(!P.st.shuffle)); on('#s-shuffle', () => P.setShuffle(!P.st.shuffle));
  const rep = () => toast('Replay: ' + { off: 'off', all: 'whole list', one: 'this song' }[P.cycleRepeat()]);
  on('#c-repeat', rep); on('#s-repeat', rep);
  on('#c-queue', () => setView('queue')); on('#s-queue', () => { closeSheet(); setView('queue'); });
  on('#c-similar', () => P.current() && similarToSong(P.current()));
  on('#s-similar', () => { if (P.current()) { closeSheet(); similarToSong(P.current()); } });
  on('#p-art', () => openSheet());
  on('#sheet-close', () => closeSheet());
  $('.p-text').addEventListener('click', (e) => {
    const a = e.target.closest('a[data-f]');
    if (a) { e.preventDefault(); setView('library', { filters: { [a.dataset.f]: '=' + a.dataset.v } }); }
    else if (S.narrow) openSheet();
  });
  const seekFrom = (input) => () => { const d = P.audio.duration; if (isFinite(d)) P.seek((input.value / 1000) * d); };
  for (const id of ['#seek', '#s-seek']) {
    const inp = $(id);
    inp.addEventListener('input', () => { seeking = true; paintRange(inp); });
    inp.addEventListener('change', () => { seekFrom(inp)(); seeking = false; });
  }
  const vol = $('#vol');
  vol.value = P.audio.volume;
  paintRange(vol);
  vol.addEventListener('input', () => { P.setVolume(+vol.value); paintRange(vol); });

  P.player.addEventListener('track', () => { updatePlayer(); S.table?.refresh(); if (S.view?.queue) updateChips(); });
  P.player.addEventListener('state', () => updateControls());
  P.player.addEventListener('time', () => updateTime());
  P.player.addEventListener('queue', () => { if (S.view?.queue) refreshView(true); updateNavCounts(); });
  P.player.addEventListener('needmix', () => { P.playList(randomMix(randomSize()), null, { shuffle: true }); });
  P.setArtResolver((s) => getArt(s));

  // swipe down to close the sheet on phones
  let y0 = null;
  $('#sheet').addEventListener('touchstart', (e) => { y0 = e.touches[0].clientY; }, { passive: true });
  $('#sheet').addEventListener('touchend', (e) => { if (y0 != null && e.changedTouches[0].clientY - y0 > 90) closeSheet(); y0 = null; });
}
let seeking = false;
const paintRange = (inp) => inp.style.setProperty('--p', ((inp.value - inp.min) / (inp.max - inp.min)) * 100 + '%');

function updatePlayer() {
  const s = P.current();
  $('#p-title').textContent = s ? s.title || s.file : 'Nothing playing';
  const sub = $('#p-sub');
  sub.replaceChildren();
  if (s) {
    if (s.artist) sub.append(el('a', { href: '#', 'data-f': 'artist', 'data-v': s.artist, text: s.artist }));
    if (s.album) sub.append(' — ', el('a', { href: '#', 'data-f': 'album', 'data-v': s.album, text: s.album }));
    if (s.year) sub.append(` (${s.year})`);
  }
  $('#sheet-title').textContent = s ? s.title || s.file : '';
  $('#sheet-sub').textContent = s ? [s.artist, s.album, s.year].filter(Boolean).join(' · ') : '';
  document.title = s ? `${s.title || s.file} · ${s.artist || ''} — Music` : 'Music';
  renderRating();
  updateArt(s);
  updateControls();
  updateTime();
}

function renderRating() {
  const s = P.current();
  for (const id of ['#p-rate', '#sheet-rate']) {
    const box = $(id);
    box.replaceChildren();
    if (!s) continue;
    for (let n = 1; n <= 5; n++) {
      const st = el('span', { class: 'star' + (n <= (s._rating || 0) ? ' on' : ''), text: '★', title: `Rate ${n}` });
      st.addEventListener('click', () => rate(s, n));
      box.append(st);
    }
  }
}

async function updateArt(s) {
  const pa = $('#p-art'), sa = $('#sheet-art'), bg = $('#sheet-bg');
  const set = (url) => {
    for (const x of [pa, sa]) {
      x.style.backgroundImage = url ? `url("${url}")` : '';
      x.style.backgroundColor = url || !s ? '' : `hsl(${placeholderHue(s)} 35% 28%)`;
      x.textContent = url || !s ? '' : (s.album || s.title || '?').trim().charAt(0).toUpperCase();
    }
    bg.style.backgroundImage = url ? `url("${url}")` : '';
    if (s) P.updateMediaSession(s);
  };
  if (!s) return set(null);
  const u = getArt(s, true);
  set(u);
  if (!u) { const url = await artNow(s); if (P.current() === s) set(url); }
}

function updateControls() {
  const playing = !P.audio.paused;
  for (const id of ['#c-play', '#s-play']) $(id).replaceChildren(icon(playing ? 'pause' : 'play'));
  for (const id of ['#c-shuffle', '#s-shuffle']) $(id).classList.toggle('on', P.st.shuffle);
  for (const id of ['#c-repeat', '#s-repeat']) {
    const b = $(id);
    b.classList.toggle('on', P.st.repeat !== 'off');
    b.replaceChildren(icon(P.st.repeat === 'one' ? 'repeat1' : 'repeat'));
    b.title = 'Replay: ' + { off: 'off', all: 'whole list', one: 'this song' }[P.st.repeat];
  }
}

function updateTime() {
  const a = P.audio;
  const s = P.current();
  const d = isFinite(a.duration) && a.duration > 0 ? a.duration : s?.duration || 0;
  const t = a.currentTime || P.st.resumeAt || 0;
  for (const [c, dd, sk] of [['#t-cur', '#t-dur', '#seek'], ['#s-cur', '#s-dur', '#s-seek']]) {
    $(c).textContent = fmtTime(t);
    $(dd).textContent = fmtTime(d);
    if (!seeking) { const inp = $(sk); inp.value = d ? Math.round((t / d) * 1000) : 0; paintRange(inp); }
  }
  $('#player').style.setProperty('--prog', d ? (t / d) * 100 + '%' : '0%');
}

function openSheet() { if (!P.current()) return; $('#sheet').hidden = false; updatePlayer(); }
function closeSheet() { $('#sheet').hidden = true; }

// =====================================================================
// Dialogs
// =====================================================================
function dialog(title, body, buttons = [{ label: 'Close', value: null }]) {
  const dlg = el('dialog');
  const foot = el('div', { class: 'dlg-f' });
  let resolveFn;
  const done = new Promise((r) => (resolveFn = r));
  const close = (v) => { resolveFn(v); dlg.close(); dlg.remove(); };
  for (const b of buttons) {
    const btn = el('button', { class: 'btn ' + (b.cls || ''), type: 'button', text: b.label });
    btn.addEventListener('click', () => (b.onClick ? b.onClick(close) : close(b.value)));
    foot.append(btn);
    b.el = btn;
  }
  dlg.append(el('div', { class: 'dlg-h' }, el('h2', { text: title }), el('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => close(null) }, icon('x'))), el('div', { class: 'dlg-b' }, body), foot);
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(null); });
  document.body.append(dlg);
  dlg.showModal();
  return { dlg, close, done, foot };
}

function promptDialog(title, label, value = '') {
  const inp = el('input', { type: 'text', value, autocomplete: 'off' });
  const d = dialog(title, el('label', { class: 'f' }, label, inp), [
    { label: 'Cancel', value: null, cls: 'ghost' },
    { label: 'Save', cls: 'primary', onClick: (close) => close(inp.value.trim() || null) },
  ]);
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') d.close(inp.value.trim() || null); });
  setTimeout(() => { inp.focus(); inp.select(); }, 30);
  return d.done;
}

function columnsDialog() {
  const cols = colPrefs();
  const list = el('div', { class: 'collist' });
  const order = [...cols.map((c) => c.key), ...COLUMNS.map((c) => c.key).filter((k) => !cols.some((c) => c.key === k))];
  const shown = new Set(cols.map((c) => c.key));
  const render = () => {
    list.replaceChildren(...order.map((k, i) => {
      const cb = el('input', { type: 'checkbox', checked: shown.has(k) });
      cb.addEventListener('change', () => { if (cb.checked) shown.add(k); else shown.delete(k); });
      const up = el('button', { class: 'icon-btn', title: 'Move up', text: '↑', onclick: () => { if (i > 0) { [order[i - 1], order[i]] = [order[i], order[i - 1]]; render(); } } });
      const dn = el('button', { class: 'icon-btn', title: 'Move down', text: '↓', onclick: () => { if (i < order.length - 1) { [order[i + 1], order[i]] = [order[i], order[i + 1]]; render(); } } });
      return el('label', { class: 'colitem' }, cb, el('span', { class: 'grow', text: COL[k].label }), up, dn);
    }));
  };
  render();
  const d = dialog(`Columns (${S.narrow ? 'phone' : 'desktop'} layout)`, el('div', {}, el('p', { class: 'muted small', text: 'Tick the columns to show; arrows change the order. Drag a column edge in the header to resize.' }), list), [
    { label: 'Reset', cls: 'ghost', onClick: (close) => { prefs[S.narrow ? 'colsNarrow' : 'colsWide'] = null; savePrefs(); S.table.buildHeader(); refreshView(true); close(); } },
    { label: 'Apply', cls: 'primary', onClick: (close) => {
      const widths = Object.fromEntries(cols.map((c) => [c.key, c.w]));
      prefs[S.narrow ? 'colsNarrow' : 'colsWide'] = order.filter((k) => shown.has(k)).map((k) => ({ key: k, w: widths[k] || COL[k].w }));
      savePrefs(); S.table.buildHeader(); refreshView(true); close();
    } },
  ]);
  return d.done;
}

// ---------- folder picker + scan ----------
async function chooseFolderAndScan(firstRun = false) {
  if (S.mode === 'demo') return toast('Not available in the demo');
  const folder = await folderPicker(firstRun);
  if (!folder) return;
  await runScan({ rootId: folder.id, rootPath: folder.path, full: true });
}

function folderPicker(firstRun) {
  const crumbs = el('div', { class: 'crumbs' });
  const list = el('div', { class: 'folders' });
  const status = el('p', { class: 'muted small' });
  let path = [];
  const body = el('div', {},
    el('p', { text: firstRun ? 'Welcome! Pick the OneDrive folder that holds your music. Everything inside it (including subfolders) will be indexed.' : 'Pick the OneDrive folder that holds your music.' }),
    crumbs, status, list);
  let d;
  const open = async (id, name, reset) => {
    if (reset) path = [];
    path.push({ id, name });
    crumbs.replaceChildren(...path.flatMap((p, i) => [i ? ' / ' : '', el('button', { text: p.name, onclick: () => { path = path.slice(0, i); open(p.id, p.name); } })]));
    list.replaceChildren();
    status.textContent = 'Loading…';
    try {
      const kids = await listFolders(id);
      status.textContent = kids.length ? '' : 'No subfolders here.';
      list.replaceChildren(...kids.map((k) => el('button', { onclick: () => open(k.id, k.name) }, icon('folder'), el('span', { text: k.name }), el('span', { class: 'cnt', text: k.count ? k.count + ' items' : '' }))));
    } catch (e) { status.textContent = 'Could not list folders: ' + e.message; }
    if (d) d.foot.lastChild.textContent = `Use “${name}”`;
  };
  d = dialog('Choose music folder', body, [
    { label: 'Cancel', value: null, cls: 'ghost' },
    { label: 'Use this folder', cls: 'primary', onClick: (close) => { const cur = path[path.length - 1]; close({ id: cur.id, path: path.slice(1).map((p) => p.name).join('/') || cur.name }); } },
  ]);
  (async () => {
    const root = await rootFolder().catch(() => null);
    if (!root) { status.textContent = 'Could not reach OneDrive.'; return; }
    await open(root.id, 'OneDrive', true);
    const music = await specialMusicFolder();
    if (music) list.prepend(el('button', { onclick: () => open(music.id, music.name) }, icon('spark'), el('span', { html: `<b>${esc(music.name)}</b> <span class="muted">— your OneDrive Music folder</span>` })));
  })();
  return d.done;
}

let scanning = false;
async function runScan({ rootId, rootPath, full }) {
  if (scanning) return;
  scanning = true;
  const bar = el('div', { class: 'progress indet' }, el('i'));
  const line = el('p', { text: 'Reading your OneDrive music folder…' });
  const sub = el('p', { class: 'muted small', text: full ? 'The first scan of a large library (50,000 songs) takes a few minutes. You can keep using the app afterwards while details are filled in.' : 'Looking for new, changed and removed files…' });
  const ac = new AbortController();
  const d = dialog(full ? 'Building your library' : 'Checking for new music', el('div', {}, line, bar, sub), [{ label: 'Cancel', cls: 'ghost', onClick: () => ac.abort() }]);
  const t0 = Date.now();
  try {
    const r = await scanLibrary({ rootId, rootPath, full, signal: ac.signal, onProgress: (p) => { line.textContent = `Found ${fmtNum(p.songs)} songs (${fmtNum(p.seen)} items checked)…`; } });
    d.foot.replaceChildren();
    if (Object.keys(lib.meta.playlistFiles).length) {
      line.textContent = 'Importing playlists found in the folder…';
      await importPlaylists((a, b) => { line.textContent = `Importing playlists ${a}/${b}…`; });
    }
    U.applyAll();
    line.textContent = 'Saving library to OneDrive (Apps/Music)…';
    try { await uploadLibrary(); } catch (e) { await saveLocal(); toast('Saved on this device; OneDrive upload will retry later'); console.warn(e); }
    d.close();
    refreshAll(false);
    if (full && !P.st.queue.length) P.playList(randomMix(randomSize()), null, { shuffle: true, autoplay: false });
    toast(full ? `Library ready: ${fmtNum(r.songs)} songs in ${Math.round((Date.now() - t0) / 1000)}s` : `${r.added} new · ${r.removed} removed`);
    if (full) setTimeout(() => offerEnrich(), 1200);
  } catch (e) {
    d.close();
    if (e.name !== 'AbortError') { console.error(e); toast('Scan failed: ' + e.message, 6000); }
  } finally { scanning = false; }
}

async function offerEnrich() {
  const d = dialog('Fill in more details?', el('div', {},
    el('p', { text: 'OneDrive already gave us artist, album, genre, year, bitrate and length. Optionally, the app can now also:' }),
    el('ul', {}, el('li', { text: 'read record labels and ratings saved by other players from your MP3/FLAC tags,' }),
      el('li', { text: prefs.lastfmKey ? 'look up public popularity and similar artists on Last.fm,' : 'look up public popularity and similar artists on Last.fm (add a free API key in Settings first),' }),
      el('li', { text: 'look up record labels on MusicBrainz.' })),
    el('p', { class: 'muted small', text: 'It runs in the background while the app is open and picks up where it left off next time.' })),
    [{ label: 'Not now', value: false, cls: 'ghost' }, { label: 'Start', value: true, cls: 'primary' }]);
  if (await d.done) startEnrich(['tags', 'lastfm', 'mb']);
}

function startEnrich(steps) {
  if (S.mode === 'demo') return toast('Not available in the demo');
  if (E.isRunning()) return toast('Already running');
  const job = setJob('enrich', 'Starting…', () => E.stop());
  E.enrich({
    steps, lastfmKey: prefs.lastfmKey,
    onProgress: (p) => {
      if (p.step === 'done') {
        job.done();
        toast(p.fatal ? p.fatal : p.aborted ? 'Enrichment paused — resume from Settings' : 'Library details updated');
        U.applyAll(); refreshAll(true);
        return;
      }
      job.update(`${p.label}: ${fmtNum(p.done)} / ${fmtNum(p.total)}`, p.total ? p.done / p.total : 0);
    },
    save: async (final) => {
      U.applyAll();
      if (final) { try { await uploadLibrary(); } catch { await saveLocal(); } }
      else await saveLocal();
      S.table.refresh();
    },
  });
}

// ---------- background job widget ----------
const jobs = new Map();
function setJob(id, text, onStop) {
  const box = $('#jobs');
  let j = jobs.get(id);
  if (!j) {
    const label = el('span');
    const bar = el('div', { class: 'bar' }, el('i'));
    const row = el('div', { class: 'jl' }, label, onStop ? el('button', { text: 'Stop', onclick: onStop }) : null);
    const node = el('div', { class: 'job' }, row, bar);
    box.append(node);
    j = {
      update(t, frac) { label.textContent = t; bar.firstChild.style.width = frac == null ? '100%' : Math.round(frac * 100) + '%'; bar.style.opacity = frac == null ? 0.35 : 1; },
      done() { node.remove(); jobs.delete(id); },
    };
    jobs.set(id, j);
  }
  j.update(text);
  return j;
}

// ---------- settings ----------
function settingsDialog() {
  const st = libStats();
  const acct = getAccount();
  const lastfm = el('input', { type: 'text', value: prefs.lastfmKey || '', placeholder: 'optional', spellcheck: 'false' });
  lastfm.addEventListener('change', () => { prefs.lastfmKey = lastfm.value.trim(); savePrefs(); toast('Last.fm key saved'); });
  const endless = el('input', { type: 'checkbox', checked: prefs.endless });
  endless.addEventListener('change', () => { prefs.endless = endless.checked; savePrefs(); });
  const mixSize = el('input', { type: 'number', min: '5', max: '200', value: prefs.mixSize, style: { width: '80px' } });
  mixSize.addEventListener('change', () => { prefs.mixSize = Math.max(5, Math.min(200, +mixSize.value || 25)); savePrefs(); });
  const steps = { tags: el('input', { type: 'checkbox', checked: true }), lastfm: el('input', { type: 'checkbox', checked: !!prefs.lastfmKey }), mb: el('input', { type: 'checkbox', checked: true }) };
  const demo = S.mode === 'demo';
  let d;
  const act = (label, fn, cls = '') => el('button', { class: 'btn ' + cls, type: 'button', text: label, onclick: () => { d.close(); fn(); } });
  const tagged = lib.songs.filter((s) => s.tagged).length;
  const body = el('div', {},
    el('div', { class: 'stats' },
      el('div', {}, el('b', { text: fmtNum(st.songs) }), el('span', { text: 'songs' })),
      el('div', {}, el('b', { text: fmtNum(st.artists) }), el('span', { text: 'artists' })),
      el('div', {}, el('b', { text: fmtNum(st.albums) }), el('span', { text: 'albums' })),
      el('div', {}, el('b', { text: fmtDur(st.dur) }), el('span', { text: 'of music' })),
      el('div', {}, el('b', { text: fmtSize(st.size) }), el('span', { text: 'on OneDrive' }))),
    el('h3', { text: 'Library' }),
    el('p', { class: 'muted small', text: demo ? 'Demo library (generated).' : `Folder: OneDrive/${lib.meta.rootPath || '—'} · last checked ${lib.meta.scannedAt ? new Date(lib.meta.scannedAt).toLocaleString() : 'never'} · stored in OneDrive/Apps/Music` }),
    el('div', { class: 'btnrow' },
      act('Check for new music', () => runScan({ rootId: lib.meta.rootId, rootPath: lib.meta.rootPath, full: false }), demo || !lib.meta.rootId ? 'hidden' : ''),
      act('Full rescan', () => runScan({ rootId: lib.meta.rootId, rootPath: lib.meta.rootPath, full: true }), demo || !lib.meta.rootId ? 'hidden' : ''),
      act('Change music folder…', () => chooseFolderAndScan(false), demo ? 'hidden' : ''),
      act('Choose columns…', () => columnsDialog())),
    el('h3', { text: 'Extra details (label, public rating, similar artists)' }),
    el('p', { class: 'muted small', text: `File tags read: ${fmtNum(tagged)} of ${fmtNum(lib.songs.filter((s) => s.ext === 'mp3' || s.ext === 'flac').length)} MP3/FLAC · Last.fm artists done: ${fmtNum(Object.keys(lib.meta.enrich?.artists || {}).length)} · MusicBrainz albums done: ${fmtNum(Object.keys(lib.meta.enrich?.albums || {}).length)}` }),
    el('label', { class: 'check' }, steps.tags, 'Read file tags (labels, ratings & play counts from other players)'),
    el('label', { class: 'check' }, steps.lastfm, 'Last.fm popularity, similar artists, missing genres'),
    el('label', { class: 'check' }, steps.mb, 'MusicBrainz record labels & album art'),
    el('label', { class: 'f' }, el('span', {}, 'Last.fm API key ', el('a', { href: 'https://www.last.fm/api/account/create', target: '_blank', rel: 'noopener', text: '(get one free)' })), lastfm),
    el('div', { class: 'btnrow' },
      E.isRunning() ? act('Stop enrichment', () => E.stop()) : act('Start / resume', () => startEnrich(Object.keys(steps).filter((k) => steps[k].checked)), demo ? 'hidden' : 'primary')),
    el('h3', { text: 'Playback' }),
    el('label', { class: 'check' }, endless, 'When a list ends, keep going with similar songs'),
    el('label', { class: 'check' }, mixSize, 'songs in a “similar” mix (random mixes pick 20–30)'),
    el('p', { class: 'muted small', html: 'Skipping a song early counts as a skip; songs you skip come up much less often in mixes. Listening past half the song (or 4 minutes) counts as a play.<br>Keys: <b>Space</b> play/pause · <b>N</b> next · <b>P</b> previous · <b>S</b> shuffle · <b>R</b> replay mode · <b>/</b> search' }),
    el('h3', { text: 'Storage & account' }),
    el('div', { class: 'btnrow' },
      act('Save library to OneDrive now', async () => { const j = setJob('up', 'Uploading library…'); try { await uploadLibrary(); await U.pushNow(); toast('Saved to OneDrive/Apps/Music'); } catch (e) { toast('Upload failed: ' + e.message); } j.done(); }, demo ? 'hidden' : ''),
      act('Clear cover-art cache', async () => { await clearArtCache(); S.table.refresh(); toast('Cover art will reload'); }),
      demo ? act('Exit demo', () => { prefs.demo = false; savePrefs(); location.reload(); }, 'primary') : act('Sign out', () => logout(), 'danger'),
      act('App settings…', () => { $('#app').hidden = true; showScreen('setup'); })),
    el('p', { class: 'muted small', text: acct ? `Signed in as ${acct.username || acct.name}` : demo ? 'Demo mode — nothing is saved to OneDrive.' : '' }),
  );
  d = dialog('Library & settings', body);
}

boot().catch((e) => { console.error(e); loading('Something went wrong: ' + e.message); });
