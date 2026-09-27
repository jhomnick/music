// Per-device preferences (localStorage). Library + stats live in IndexedDB and OneDrive.
const K = 'music.prefs';
const defaults = {
  clientId: '',
  accountType: 'personal',
  lastfmKey: '',
  demo: false,
  colsWide: null,
  colsNarrow: null,
  showFilters: true,
  endless: true,
  volume: 1,
  mixSize: 25,
  lastView: 'library',
};

export const prefs = Object.assign({}, defaults, safeParse(localStorage.getItem(K)));

function safeParse(s) { try { return JSON.parse(s) || {}; } catch { return {}; } }

export function savePrefs() {
  try { localStorage.setItem(K, JSON.stringify(prefs)); } catch { /* storage full or blocked */ }
}
