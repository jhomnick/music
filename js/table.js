// Virtualized, sortable, filterable, resizable table. Only the visible rows exist in the DOM.
import { el, icon } from './util.js';
import { COL, colText } from './view.js';
import { getArt, placeholderHue } from './art.js';
import { playable } from './formats.js';

export class VTable {
  constructor(root, o) {
    this.root = root;
    this.o = o;
    this.rowH = o.rowH || 38;
    this.rows = [];
    this.pool = [];
    this.sel = -1;
    this.cols = [];
    this.scroller = el('div', { class: 'vt-scroll', tabindex: '0' });
    this.head = el('div', { class: 'vt-head' });
    this.body = el('div', { class: 'vt-body' });
    this.empty = el('div', { class: 'vt-empty', hidden: true });
    this.scroller.append(this.head, this.body, this.empty);
    root.append(this.scroller);
    this.scroller.addEventListener('scroll', () => this.schedule(), { passive: true });
    new ResizeObserver(() => { this.updateWidth(); this.schedule(); }).observe(this.scroller);
    this.body.addEventListener('click', (e) => this.onClick(e));
    this.body.addEventListener('dblclick', (e) => this.onDbl(e));
    this.body.addEventListener('contextmenu', (e) => this.onContext(e));
    this.scroller.addEventListener('keydown', (e) => this.onKey(e));
    this.buildHeader();
  }

  // ---------- header ----------
  buildHeader() {
    this.cols = this.o.getCols().filter((c) => COL[c.key]);
    for (const c of this.cols) this.root.style.setProperty('--w-' + c.key, c.w + 'px');
    const sort = this.o.getSort();
    const hrow = el('div', { class: 'vt-hrow' });
    for (const c of this.cols) {
      const def = COL[c.key];
      const s = sort.findIndex((x) => x.key === c.key);
      const cell = el('div', { class: `vt-hc t-${def.type}${s >= 0 ? ' sorted' : ''}`, style: { width: `var(--w-${c.key})` }, 'data-key': c.key, title: def.noSort ? '' : 'Click to sort · Shift-click to add a secondary sort' },
        el('span', { class: 'lbl', text: def.key === 'art' ? '' : def.label }),
        s >= 0 ? el('span', { class: 'arrow', text: (sort[s].dir === 'desc' ? '▼' : '▲') + (sort.length > 1 ? s + 1 : '') }) : null,
        el('span', { class: 'rz', 'data-key': c.key }));
      if (!def.noSort) cell.addEventListener('click', (e) => { if (!e.target.classList.contains('rz')) this.o.onSort(c.key, e.shiftKey); });
      hrow.append(cell);
    }
    hrow.append(el('div', { class: 'vt-hc vt-tail' }));
    this.head.replaceChildren(hrow);
    if (this.o.showFilters()) {
      const frow = el('div', { class: 'vt-frow' });
      const f = this.o.getFilters();
      for (const c of this.cols) {
        const def = COL[c.key];
        const cell = el('div', { class: 'vt-fc', style: { width: `var(--w-${c.key})` } });
        if (!def.noFilter) {
          const hint = def.type === 'text' ? 'filter' : def.type === 'date' ? '<30d' : def.key === 'year' ? '1970-79' : '>3';
          const inp = el('input', { type: 'search', placeholder: hint, value: f[c.key] || '', 'aria-label': 'Filter ' + def.label, spellcheck: 'false' });
          inp.addEventListener('input', () => this.o.onFilter(c.key, inp.value));
          cell.append(inp);
        }
        frow.append(cell);
      }
      frow.append(el('div', { class: 'vt-fc vt-tail' }));
      this.head.append(frow);
    }
    this.head.querySelectorAll('.rz').forEach((h) => h.addEventListener('pointerdown', (e) => this.startResize(e, h.dataset.key)));
    this.updateWidth();
    this.pool.forEach((r) => r.remove());
    this.pool = [];
    this.schedule(true);
  }

  updateWidth() {
    // a "flex" column (Song + Artist) stretches to fill the screen
    const flex = this.cols.find((c) => COL[c.key].flex);
    let total = this.cols.reduce((t, c) => t + c.w, 0) + 40;
    if (flex) {
      const avail = (this.scroller.clientWidth || 360) - (total - flex.w);
      const w = Math.max(flex.w, avail);
      this.root.style.setProperty('--w-' + flex.key, w + 'px');
      total += w - flex.w;
    }
    this.head.style.width = this.body.style.width = total + 'px';
  }

  startResize(e, key) {
    e.preventDefault(); e.stopPropagation();
    const c = this.cols.find((x) => x.key === key);
    const x0 = e.clientX, w0 = c.w;
    const move = (ev) => {
      c.w = Math.max(36, Math.round(w0 + ev.clientX - x0));
      this.root.style.setProperty('--w-' + key, c.w + 'px');
      this.updateWidth();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      this.o.onResize(key, c.w);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // ---------- rows ----------
  setRows(rows, { keepScroll = false } = {}) {
    this.rows = rows;
    if (!keepScroll) { this.scroller.scrollTop = 0; this.sel = -1; }
    this.body.style.height = rows.length * this.rowH + 'px';
    this.empty.hidden = rows.length > 0;
    this.empty.textContent = this.o.emptyText?.() || 'No songs';
    this.schedule(true);
  }

  schedule(force = false) {
    if (force) this.force = true;
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.render(this.force); this.force = false; });
  }
  refresh() { this.schedule(true); }

  render(force) {
    const h = this.rowH, st = this.scroller.scrollTop, vh = this.scroller.clientHeight || 600;
    const start = Math.max(0, Math.floor(st / h) - 6);
    const end = Math.min(this.rows.length, Math.ceil((st + vh) / h) + 6);
    const need = end - start;
    while (this.pool.length < need) this.pool.push(this.makeRow());
    for (let k = 0; k < this.pool.length; k++) {
      const row = this.pool[k];
      const i = start + k;
      if (i >= end) { if (!row.hidden) row.hidden = true; row._i = -1; continue; }
      row.hidden = false;
      const s = this.rows[i];
      if (force || row._i !== i || row._s !== s) this.fill(row, s, i);
      row.style.transform = `translateY(${i * h}px)`;
    }
  }

  makeRow() {
    const row = el('div', { class: 'vt-row', role: 'row' });
    row._cells = this.cols.map((c) => {
      const cell = el('div', { class: 'vt-c t-' + COL[c.key].type, style: { width: `var(--w-${c.key})` }, 'data-key': c.key });
      row.append(cell);
      return cell;
    });
    row.append(el('div', { class: 'vt-c vt-tail' }, el('button', { class: 'rowmenu', 'aria-label': 'More', title: 'More' }, icon('more'))));
    this.body.append(row);
    return row;
  }

  fill(row, s, i) {
    row._i = i; row._s = s;
    const active = this.o.isActive?.(s, i);
    row.className = 'vt-row' + (active ? ' active' : '') + (i === this.sel ? ' sel' : '') + (playable(s) ? '' : ' bad') + (i % 2 ? ' odd' : '');
    this.cols.forEach((c, k) => {
      const cell = row._cells[k];
      const def = COL[c.key];
      if (def.type === 'art') return this.fillArt(cell, s, active);
      if (def.type === 'rating') {
        const v = def.get(s);
        if (!cell.firstChild) for (let n = 1; n <= 5; n++) cell.append(el('span', { class: 'star', 'data-r': n, text: '★' }));
        [...cell.children].forEach((x, n) => x.classList.toggle('on', n < v));
        return;
      }
      if (def.type === 'song') {
        if (!cell.firstChild) cell.append(el('div', { class: 's1' }), el('div', { class: 's2' }));
        cell.firstChild.textContent = def.get(s);
        cell.lastChild.textContent = def.sub(s);
        return;
      }
      if (def.type === 'pop') {
        const v = def.get(s);
        if (!cell.firstChild) cell.append(el('span', { class: 'popbar' }, el('i')), el('span', { class: 'popn' }));
        cell.firstChild.style.visibility = v == null ? 'hidden' : '';
        cell.firstChild.firstChild.style.width = (v || 0) + '%';
        cell.lastChild.textContent = v == null ? '' : v;
        return;
      }
      const t = colText(def, s);
      if (cell.textContent !== t) { cell.textContent = t; cell.title = t.length > 24 ? t : ''; }
    });
  }

  fillArt(cell, s, active) {
    const url = getArt(s);
    let img = cell.querySelector('img'), ph = cell.querySelector('.ph');
    if (!ph) {
      ph = el('div', { class: 'ph' });
      img = el('img', { alt: '', loading: 'lazy', decoding: 'async' });
      cell.append(ph, img, el('span', { class: 'playov' }, icon(active ? 'eq' : 'play')));
    } else {
      cell.querySelector('.playov').replaceChildren(icon(active ? 'eq' : 'play'));
    }
    if (url) { if (img.getAttribute('src') !== url) img.src = url; img.hidden = false; ph.hidden = true; }
    else {
      img.hidden = true; img.removeAttribute('src'); ph.hidden = false;
      ph.style.background = `hsl(${placeholderHue(s)} 35% 28%)`;
      ph.textContent = (s.album || s.title || '?').trim().charAt(0).toUpperCase();
    }
  }

  // ---------- events ----------
  hit(e) {
    const row = e.target.closest('.vt-row');
    if (!row || row._i < 0) return null;
    const cell = e.target.closest('.vt-c');
    return { row, i: row._i, s: row._s, key: cell?.dataset.key };
  }
  select(i) {
    this.sel = i;
    this.schedule(true);
  }
  onClick(e) {
    const h = this.hit(e);
    if (!h) return;
    this.select(h.i);
    if (e.target.closest('.rowmenu')) return this.o.onMenu(h.s, h.i, e);
    const star = e.target.closest('.star');
    if (star) return this.o.onRate(h.s, +star.dataset.r);
    if (h.key === 'art') return this.o.onPlay(h.s, h.i);
    this.o.onCell(h.s, h.key, h.i, e);
  }
  onDbl(e) {
    const h = this.hit(e);
    if (h && h.key !== 'art' && !e.target.closest('.star,.rowmenu')) { this.o.closeMenus?.(); this.o.onPlay(h.s, h.i); }
  }
  onContext(e) {
    const h = this.hit(e);
    if (!h) return;
    e.preventDefault();
    this.select(h.i);
    this.o.onCell(h.s, h.key, h.i, e);
  }
  onKey(e) {
    if (e.target !== this.scroller) return;
    const n = this.rows.length;
    if (!n) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      this.sel = Math.max(0, Math.min(n - 1, this.sel + (e.key === 'ArrowDown' ? 1 : -1)));
      this.scrollToIndex(this.sel);
      this.schedule(true);
    } else if (e.key === 'Enter' && this.sel >= 0) {
      this.o.onPlay(this.rows[this.sel], this.sel);
    }
  }
  scrollToIndex(i, center = false) {
    const h = this.rowH, top = i * h, st = this.scroller.scrollTop, vh = this.scroller.clientHeight - this.head.offsetHeight;
    if (center) this.scroller.scrollTop = Math.max(0, top - vh / 2);
    else if (top < st) this.scroller.scrollTop = top;
    else if (top + h > st + vh) this.scroller.scrollTop = top + h - vh;
  }
}
