'use strict';
/* ==========================================================================
   Інтерфейс: стан, черга синхронізації, рендер, форми.
   ========================================================================== */

const APP_VERSION = self.APP_VERSION || '?';
const DEMO = !!CONFIG.DEMO || new URLSearchParams(location.search).has('demo');
const CUR_SYM = { UAH: '₴', USD: '$', EUR: '€', PLN: 'zł', GBP: '£', CHF: '₣', CZK: 'Kč' };

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const S = {
  sheetId: null,
  backend: null,
  txns: [], wallets: [], contacts: [],
  filter: LS.get('ms_filter', 'all'),
  search: '',
  limit: 100,
  editing: null,
  wEditing: null,
  lastWallet: LS.get('ms_lastWallet', ''),
  loadedAt: 0,
};

/* ------------------------------ форматування ----------------------------- */
const NF = new Intl.NumberFormat('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const sym = (cur) => CUR_SYM[cur] || cur || '';
const money = (n, cur) => NF.format(n || 0) + ' ' + sym(cur);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const walletBy = (name) => S.wallets.find((w) => w.name === name);
const curOf = (name) => walletBy(name)?.currency || CONFIG.DEFAULT_CURRENCY;
const numToInput = (n) => (n == null || n === '' ? '' : groupNumber(String(n).replace('.', ',')));

/* Розбиття великих чисел на групи по 3 цифри: 1234567,5 → «1 234 567,5».
   Працює і у виразах: «12000+3500» → «12 000+3 500». */
function groupNumber(raw) {
  return String(raw).replace(/[\s\u00a0]/g, '')
    .replace(/(\d+)([.,]\d*)?/g, (m, int, frac = '') => int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + frac);
}
// Форматує поле під час введення, не збиваючи курсор
function liveGroup(input) {
  const v = input.value;
  const pos = input.selectionStart ?? v.length;
  const before = v.slice(0, pos).replace(/\s/g, '').length;
  const nv = groupNumber(v);
  if (nv === v) return;
  input.value = nv;
  let i = 0, c = 0;
  while (i < nv.length && c < before) { if (!/\s/.test(nv[i])) c++; i++; }
  try { input.setSelectionRange(i, i); } catch { /* ignore */ }
}
function bindGrouping(input, after) {
  // Backspace перед пробілом-розділювачем видаляє цифру, а не пробіл
  input.addEventListener('beforeinput', (e) => {
    if (e.inputType !== 'deleteContentBackward') return;
    const p = input.selectionStart;
    if (p !== input.selectionEnd || p < 2 || input.value[p - 1] !== ' ') return;
    e.preventDefault();
    input.value = input.value.slice(0, p - 2) + input.value.slice(p - 1);
    input.setSelectionRange(p - 2, p - 2);
    liveGroup(input);
    after?.();
  });
  input.addEventListener('input', () => { liveGroup(input); after?.(); });
}

function dayLabel(iso) {
  const today = U.todayIso();
  const y = new Date(Date.now() - 86400000);
  const yIso = new Date(y - y.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  if (iso === today) return 'Сьогодні';
  if (iso === yIso) return 'Вчора';
  const [yy, mm, dd] = iso.split('-').map(Number);
  const d = new Date(yy, mm - 1, dd);
  const opts = { day: 'numeric', month: 'long', weekday: 'short' };
  if (yy !== new Date().getFullYear()) opts.year = 'numeric';
  return new Intl.DateTimeFormat('uk-UA', opts).format(d);
}

/* Сума з простою арифметикою: "120+35,5" → 155.5 */
function evalAmount(input) {
  const s = String(input || '').replace(/[\s ]/g, '').replace(/,/g, '.');
  if (!s || !/^[-+*/().0-9]+$/.test(s)) return NaN;
  let i = 0;
  const peek = () => s[i];
  function expr() { let v = term(); while (peek() === '+' || peek() === '-') { const o = s[i++]; const r = term(); v = o === '+' ? v + r : v - r; } return v; }
  function term() { let v = factor(); while (peek() === '*' || peek() === '/') { const o = s[i++]; const r = factor(); v = o === '*' ? v * r : v / r; } return v; }
  function factor() {
    if (peek() === '-') { i++; return -factor(); }
    if (peek() === '+') { i++; return factor(); }
    if (peek() === '(') { i++; const v = expr(); if (s[i++] !== ')') throw new Error(); return v; }
    const m = /^(\d+\.?\d*|\.\d+)/.exec(s.slice(i));
    if (!m) throw new Error();
    i += m[0].length;
    return parseFloat(m[0]);
  }
  try {
    const v = expr();
    if (i !== s.length || !isFinite(v)) return NaN;
    return Math.round(v * 100) / 100;
  } catch { return NaN; }
}

/* --------------------------------- UI utils ------------------------------ */
let toastTimer;
function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function show(screen) {
  ['login', 'setup', 'main'].forEach((n) => { $('#screen-' + n).hidden = n !== screen; });
}

function openPanel(el) {
  hidePanels();
  $('#backdrop').hidden = false;
  el.hidden = false;
  el.scrollTop = 0;
  lockBody();
  if (!history.state?.panel) history.pushState({ panel: 1 }, '');
}

/* Фіксуємо сторінку під відкритою панеллю: на iOS при появі клавіатури
   браузер інакше прокручує фон, і інтерфейс «смикається». */
let lockedY = 0;
/* На iOS при відкритій клавіатурі браузер зсуває видиму область, і навіть
   position:fixed їде вгору. Тримаємо верхню стрічку панелі в межах видимої області. */
let pinRaf = 0;
function pinSheetHead() {
  cancelAnimationFrame(pinRaf);
  pinRaf = requestAnimationFrame(() => {
    const head = document.querySelector('.sheet:not([hidden]) .sheet-head');
    if (!head) return;
    const vv = window.visualViewport;
    const off = vv && window.innerWidth < 700 ? Math.max(0, Math.round(vv.offsetTop)) : 0;
    head.style.transform = off ? `translateY(${off}px)` : '';
  });
}

function lockBody() {
  if (document.body.classList.contains('no-scroll')) return;
  lockedY = window.scrollY;
  document.body.style.top = -lockedY + 'px';
  document.body.classList.add('no-scroll');
}
function unlockBody() {
  if (!document.body.classList.contains('no-scroll')) return;
  document.body.classList.remove('no-scroll');
  document.body.style.top = '';
  window.scrollTo(0, lockedY);
}
function hidePanels() {
  $$('.sheet').forEach((s) => { s.hidden = true; });
  $('#backdrop').hidden = true;
  $('#contactSug').hidden = true;
  unlockBody();
}
function closePanels() {
  if (history.state?.panel) history.back(); // popstate сховає панелі
  else hidePanels();
}

function fieldErr(sel, msg) {
  const el = $(sel);
  el.classList.add('invalid');
  el.focus();
  el.addEventListener('input', () => el.classList.remove('invalid'), { once: true });
  el.addEventListener('change', () => el.classList.remove('invalid'), { once: true });
  toast(msg);
}

/* ------------------------------ стан і кеш ------------------------------- */
function cacheState() {
  if (!S.sheetId) return;
  LS.set('ms_state_' + S.sheetId, { txns: S.txns, wallets: S.wallets, contacts: S.contacts });
}

function applyData(d) {
  S.txns = d.txns; S.wallets = d.wallets; S.contacts = d.contacts;
  S.loadedAt = Date.now();
  cacheState();
  render();
}

function balances() {
  const b = {};
  for (const w of S.wallets) b[w.name] = w.initial || 0;
  for (const t of S.txns) {
    if (t.type === 'in') b[t.wallet] = (b[t.wallet] || 0) + t.amount;
    else if (t.type === 'out') b[t.wallet] = (b[t.wallet] || 0) - t.amount;
    else {
      b[t.wallet] = (b[t.wallet] || 0) - t.amount;
      if (t.toWallet) b[t.toWallet] = (b[t.toWallet] || 0) + (t.toAmount ?? t.amount);
    }
  }
  for (const k in b) b[k] = Math.round(b[k] * 100) / 100;
  return b;
}

/* ---------------------------- черга синхронізації ------------------------ */
const STATUS_TXT = {
  ok: 'Синхронізовано', sync: 'Синхронізація…', offline: 'Немає зʼєднання — зміни в черзі',
  auth: 'Потрібен вхід у Google', error: 'Помилка синхронізації',
};
function setStatus(state, msg) {
  const dot = $('#syncDot');
  dot.dataset.state = state;
  $('#btnRefresh').title = msg || STATUS_TXT[state];
  $('#btnRefresh').classList.toggle('spin', state === 'sync');
  updatePending();
}
function updatePending() {
  const n = Sync.queue.length;
  $('#pendingCount').textContent = n ? String(n) : '';
}
function showAuthBanner(on) { $('#authBanner').hidden = !on; }

const Sync = {
  queue: [], running: false, again: false, timer: null,

  save() { if (S.sheetId) LS.set('ms_queue_' + S.sheetId, this.queue); updatePending(); },
  push(op) { op.attempts = 0; op.ts = Date.now(); this.queue.push(op); this.save(); this.run(); },

  async run() {
    if (this.running) { this.again = true; return; }
    this.running = true;
    try {
      do { this.again = false; await this.step(); } while (this.again);
    } finally { this.running = false; }
  },

  async step() {
    if (!S.backend) return;
    if (!DEMO && !Auth.getToken()) { showAuthBanner(true); setStatus('auth'); return; }
    setStatus('sync');
    while (this.queue.length) {
      const op = this.queue[0];
      try { await S.backend.exec(op); }
      catch (e) { if (!this.fail(e, op)) return; continue; }
      this.queue.shift();
      this.save();
    }
    try {
      const d = await S.backend.load();
      if (this.queue.length) { this.again = true; return; } // зʼявились нові зміни під час читання
      applyData(d);
      setStatus('ok');
    } catch (e) { this.fail(e, null); }
  },

  // true — продовжити обробку черги, false — зупинитись
  fail(e, op) {
    console.warn('sync error', e);
    if (op) { op.attempts = (op.attempts || 0) + 1; this.save(); }
    if (e instanceof AuthError) { showAuthBanner(true); setStatus('auth'); return false; }
    if (e instanceof NetError || !navigator.onLine) { setStatus('offline'); this.later(); return false; }
    if (op && op.attempts >= 3) {
      this.queue.shift(); this.save();
      toast('Операцію скасовано: ' + e.message, 5000);
      return true;
    }
    setStatus('error', e.message);
    toast(e.message, 5000);
    this.later();
    return false;
  },

  later() { clearTimeout(this.timer); this.timer = setTimeout(() => this.run(), 30000); },
};

/* --------------------------------- рендер -------------------------------- */
function render() {
  if (S.filter !== 'all' && !walletBy(S.filter)) S.filter = 'all';
  renderChips();
  renderSummary();
  renderList();
}

function renderChips() {
  const b = balances();
  const ws = S.wallets.filter((w) => !w.archived || w.name === S.filter);
  $('#walletChips').innerHTML =
    `<button class="chip ${S.filter === 'all' ? 'on' : ''}" data-w="all"><span>Усі</span><small>${ws.length} гам.</small></button>` +
    ws.map((w) => `<button class="chip ${S.filter === w.name ? 'on' : ''}" data-w="${esc(w.name)}">
      <span>${esc(w.name)}</span><small>${money(b[w.name], w.currency)}</small></button>`).join('');
  const on = $('#walletChips .chip.on');
  if (on) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function monthFlow(walletName) {
  const ym = U.todayIso().slice(0, 7);
  const res = {}; // currency -> {inc, exp}
  for (const t of S.txns) {
    if (t.type === 'tr' || !t.date.startsWith(ym)) continue;
    if (walletName && t.wallet !== walletName) continue;
    const w = walletBy(t.wallet);
    if (!walletName && w?.archived) continue;
    const cur = curOf(t.wallet);
    res[cur] ??= { inc: 0, exp: 0 };
    if (t.type === 'in') res[cur].inc += t.amount; else res[cur].exp += t.amount;
  }
  return res;
}

function renderSummary() {
  const b = balances();
  const month = new Intl.DateTimeFormat('uk-UA', { month: 'long' }).format(new Date());
  const el = $('#summary');
  if (!S.wallets.length) { el.innerHTML = '<div class="muted">Немає гаманців. Створіть перший у меню ☰</div>'; return; }

  if (S.filter !== 'all') {
    const w = walletBy(S.filter);
    const f = monthFlow(w.name)[w.currency] || { inc: 0, exp: 0 };
    const bal = b[w.name] || 0;
    el.innerHTML = `
      <div class="sum-label">Баланс · ${esc(w.name)}${w.archived ? ' <em class="tag">архів</em>' : ''}</div>
      <div class="sum-big ${bal < 0 ? 'neg' : ''}">${money(bal, w.currency)}</div>
      <div class="sum-flow"><span class="pos">+${money(f.inc, w.currency)}</span><span class="neg">−${money(f.exp, w.currency)}</span><small>за ${esc(month)}</small></div>`;
    return;
  }

  const totals = {};
  for (const w of S.wallets) {
    if (w.archived) continue;
    totals[w.currency] = (totals[w.currency] || 0) + (b[w.name] || 0);
  }
  const flows = monthFlow(null);
  const curs = Object.keys(totals).sort((a, c) => (a === CONFIG.DEFAULT_CURRENCY ? -1 : c === CONFIG.DEFAULT_CURRENCY ? 1 : a.localeCompare(c)));
  el.innerHTML = `<div class="sum-label">Разом на всіх гаманцях · рух за ${esc(month)}</div>` + curs.map((cur) => {
    const f = flows[cur] || { inc: 0, exp: 0 };
    return `<div class="sum-cur"><b class="${totals[cur] < 0 ? 'neg' : ''}">${money(totals[cur], cur)}</b>
      <span class="sum-flow"><span class="pos">+${NF.format(f.inc)}</span><span class="neg">−${NF.format(f.exp)}</span></span></div>`;
  }).join('');
}

function filteredTxns() {
  let l = S.txns;
  if (S.filter !== 'all') l = l.filter((t) => t.wallet === S.filter || (t.type === 'tr' && t.toWallet === S.filter));
  if (S.search) {
    const q = S.search;
    const qn = q.replace(',', '.');
    l = l.filter((t) => (t.contact || '').toLowerCase().includes(q) || (t.comment || '').toLowerCase().includes(q) ||
      t.wallet.toLowerCase().includes(q) || String(t.amount).includes(qn));
  }
  return l.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.created || 0) - (a.created || 0)));
}

function txRow(t) {
  const f = S.filter;
  let cls = t.type, sign = '', amt = t.amount, cur = curOf(t.wallet);
  if (t.type === 'tr') {
    if (f !== 'all' && t.toWallet === f && t.wallet !== f) { cls = 'in'; sign = '+'; amt = t.toAmount ?? t.amount; cur = curOf(t.toWallet); }
    else if (f !== 'all') { cls = 'out'; sign = '−'; }
  } else sign = t.type === 'in' ? '+' : '−';
  const ico = t.type === 'tr' ? '⇄' : t.type === 'in' ? '+' : '−';
  const title = t.contact || t.comment || (t.type === 'tr' ? 'Переказ' : TYPE_LABEL[t.type]);
  const sub = [];
  if (t.contact && t.comment) sub.push(t.comment);
  if (t.type === 'tr') sub.push(`${t.wallet} → ${t.toWallet}`);
  else if (f === 'all') sub.push(t.wallet);
  return `<button class="tx" data-id="${esc(t.id)}">
    <span class="ico ${t.type}">${ico}</span>
    <span class="tx-main"><span class="tx-title">${esc(title)}</span>${sub.length ? `<span class="tx-sub">${esc(sub.join(' · '))}</span>` : ''}</span>
    <span class="tx-amt ${cls}">${sign}${money(amt, cur)}</span></button>`;
}

function renderList() {
  const all = filteredTxns();
  const list = all.slice(0, S.limit);
  const el = $('#txList');
  if (!list.length) {
    el.innerHTML = `<div class="empty">${S.search ? 'Нічого не знайдено' : 'Записів ще немає.<br>Натисніть «+», щоб додати перший.'}</div>`;
    return;
  }
  let html = '', cur = null;
  for (const t of list) {
    if (t.date !== cur) {
      if (cur !== null) html += '</div>';
      cur = t.date;
      html += `<div class="day"><span>${esc(dayLabel(t.date))}</span></div><div class="day-card">`;
    }
    html += txRow(t);
  }
  html += '</div>';
  if (all.length > list.length) html += `<button class="btn ghost more" id="moreBtn">Показати ще (${all.length - list.length})</button>`;
  el.innerHTML = html;
}

/* ------------------------------ форма запису ----------------------------- */
function walletOptions(sel, list, value) {
  sel.innerHTML = list.map((w) => `<option value="${esc(w.name)}">${esc(w.name)} (${esc(sym(w.currency))})</option>`).join('');
  if (value && list.some((w) => w.name === value)) sel.value = value;
}

function openTx(t) {
  S.editing = t || null;
  const usable = S.wallets.filter((w) => !w.archived || (t && (w.name === t.wallet || w.name === t.toWallet)));
  if (!usable.length) { toast('Спочатку створіть гаманець'); openWalletEdit(null); return; }

  const lw = walletBy(S.lastWallet);
  const defW = t?.wallet ||
    (S.filter !== 'all' && walletBy(S.filter) && !walletBy(S.filter).archived ? S.filter :
      (lw && !lw.archived ? lw.name : usable[0].name));

  $('#txForm').elements.type.value = t?.type || 'out';
  $('#fAmount').value = t ? numToInput(t.amount) : '';
  walletOptions($('#fWallet'), usable, defW);
  walletOptions($('#fToWallet'), usable, t?.toWallet || usable.find((w) => w.name !== defW)?.name);
  $('#fToAmount').value = t?.type === 'tr' ? numToInput(t.toAmount) : '';
  $('#fContact').value = t?.contact || '';
  $('#fComment').value = t?.comment || '';
  $('#fDate').value = t?.date || U.todayIso();
  $('#txTitle').textContent = t ? 'Редагування' : 'Новий запис';
  $('#txDelete').hidden = !t;
  $$('#txForm .invalid').forEach((e) => e.classList.remove('invalid'));
  updateTxForm();
  updateAmountHint();
  openPanel($('#txSheet'));
  if (!t) $('#fAmount').focus();
}

function updateTxForm() {
  const type = $('#txForm').elements.type.value;
  const isTr = type === 'tr';
  $('#toWalletField').hidden = !isTr;
  $('#toWalletField').parentElement.classList.toggle('one', !isTr);
  $('#walletLbl').textContent = isTr ? 'Звідки' : 'Гаманець';
  const from = $('#fWallet').value, to = $('#fToWallet').value;
  $('#fCur').textContent = sym(curOf(from));
  const diff = isTr && to && curOf(from) !== curOf(to);
  $('#toAmountField').hidden = !diff;
  $('#fToCur').textContent = sym(curOf(to));
}

function updateAmountHint() {
  const raw = $('#fAmount').value;
  const hint = $('#amountHint');
  if (/[-+*/(]/.test(raw.replace(/^[-+]/, ''))) {
    const v = evalAmount(raw);
    hint.textContent = isNaN(v) ? 'Неправильний вираз' : '= ' + money(v, curOf($('#fWallet').value));
  } else hint.textContent = '';
}

function saveTx(e) {
  e.preventDefault();
  const type = $('#txForm').elements.type.value;
  const amount = evalAmount($('#fAmount').value);
  if (!(amount > 0)) return fieldErr('#fAmount', 'Вкажіть суму більше нуля');
  const wallet = $('#fWallet').value;
  if (!wallet) return fieldErr('#fWallet', 'Оберіть гаманець');

  let toWallet = '', toAmount = null;
  if (type === 'tr') {
    toWallet = $('#fToWallet').value;
    if (!toWallet || toWallet === wallet) return fieldErr('#fToWallet', 'Оберіть інший гаманець для переказу');
    if (curOf(wallet) !== curOf(toWallet)) {
      toAmount = evalAmount($('#fToAmount').value);
      if (!(toAmount > 0)) return fieldErr('#fToAmount', 'Вкажіть суму зарахування');
    } else toAmount = amount;
  }

  const contact = $('#fContact').value.trim().replace(/\s+/g, ' ');
  const comment = $('#fComment').value.trim();
  const date = $('#fDate').value || U.todayIso();
  const now = Date.now();
  const fields = { type, amount, wallet, toWallet, toAmount, contact, comment, date, updated: now };
  const wasEdit = !!S.editing;

  if (wasEdit) {
    Object.assign(S.editing, fields);
    Sync.push({ kind: 'updTxn', txn: { ...S.editing } });
  } else {
    const t = { id: U.uid('t'), created: now, ...fields };
    S.txns.push(t);
    Sync.push({ kind: 'addTxn', txn: { ...t } });
  }

  if (contact && !S.contacts.some((c) => c.name.toLowerCase() === contact.toLowerCase())) {
    const c = { name: contact, note: '', created: now };
    S.contacts.push(c);
    Sync.push({ kind: 'addContact', contact: { ...c } });
  }

  S.lastWallet = wallet;
  LS.set('ms_lastWallet', wallet);
  cacheState();
  render();
  closePanels();
  toast(wasEdit ? 'Збережено' : 'Додано');
}

function deleteTx() {
  const t = S.editing;
  if (!t || !confirm('Видалити цей запис?')) return;
  S.txns = S.txns.filter((x) => x.id !== t.id);
  Sync.push({ kind: 'delTxn', id: t.id });
  cacheState();
  render();
  closePanels();
  toast('Видалено');
}

/* ---------------------------- підказки контактів ------------------------- */
let sugIndex = -1;
function contactIndex() {
  const m = new Map();
  for (const c of S.contacts) {
    const k = c.name.toLowerCase();
    if (!m.has(k)) m.set(k, { name: c.name, count: 0, last: 0 });
  }
  for (const t of S.txns) {
    if (!t.contact) continue;
    const k = t.contact.toLowerCase();
    let e = m.get(k);
    if (!e) { e = { name: t.contact, count: 0, last: 0 }; m.set(k, e); }
    e.count++;
    const ts = Math.max(t.created || 0, Date.parse(t.date) || 0);
    if (ts > e.last) e.last = ts;
  }
  return [...m.values()];
}

function highlight(name, q) {
  if (!q) return esc(name);
  const i = name.toLowerCase().indexOf(q);
  if (i < 0) return esc(name);
  return esc(name.slice(0, i)) + '<mark>' + esc(name.slice(i, i + q.length)) + '</mark>' + esc(name.slice(i + q.length));
}

function showSuggestions() {
  const q = $('#fContact').value.trim().toLowerCase();
  let list = contactIndex();
  if (q) {
    list = list.filter((c) => c.name.toLowerCase().includes(q));
    const starts = (c) => c.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)) ? 1 : 0;
    list.sort((a, b) => starts(b) - starts(a) || b.count - a.count || b.last - a.last);
    if (list.length === 1 && list[0].name.toLowerCase() === q) list = [];
  } else {
    list.sort((a, b) => b.last - a.last || b.count - a.count);
  }
  list = list.slice(0, 7);
  const ul = $('#contactSug');
  sugIndex = -1;
  if (!list.length) { ul.hidden = true; return; }
  ul.innerHTML = list.map((c) => `<li role="option" data-name="${esc(c.name)}"><span>${highlight(c.name, q)}</span>${c.count ? `<small>${c.count}×</small>` : ''}</li>`).join('');
  ul.hidden = false;
}

function pickSuggestion(name) {
  $('#fContact').value = name;
  $('#contactSug').hidden = true;
  $('#fComment').focus();
}

/* ------------------------------ налаштування ----------------------------- */
function openSettings() {
  const b = balances();
  const sheetUrl = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(S.sheetId)}/edit`;
  const wallets = [...S.wallets].sort((a, c) => a.archived - c.archived);
  $('#settingsBody').innerHTML = `
    <section class="set-sec">
      <h3>Гаманці</h3>
      <div class="wlist">${wallets.map((w) => `
        <button class="wrow" data-wedit="${esc(w.name)}">
          <span><b>${esc(w.name)}</b> ${w.archived ? '<em class="tag">архів</em>' : ''}<small>${esc(w.currency)} · початковий ${NF.format(w.initial || 0)}</small></span>
          <span class="amt ${(b[w.name] || 0) < 0 ? 'neg' : ''}">${money(b[w.name], w.currency)}</span>
        </button>`).join('') || '<div class="wrow muted">Ще немає гаманців</div>'}
      </div>
      <button class="btn" data-act="wadd">+ Новий гаманець</button>
    </section>
    <section class="set-sec">
      <h3>Таблиця</h3>
      ${DEMO ? `
        <p class="muted">Демо-режим: дані зберігаються лише в цьому браузері.</p>
        <button class="btn" data-act="demoreset">Скинути демо-дані</button>
        <a class="btn ghost" href="./">Вийти з демо</a>` : `
        <p class="muted">${esc(Auth.email || '')}</p>
        <a class="btn" target="_blank" rel="noopener" href="${sheetUrl}">Відкрити в Google Таблицях</a>
        <button class="btn" data-act="reload">Перечитати дані з таблиці</button>
        <button class="btn ghost" data-act="switch">Інша таблиця / створити нову</button>
        <button class="btn ghost danger-text" data-act="logout">Вийти з акаунта</button>`}
    </section>
    <section class="set-sec">
      <h3>Про додаток</h3>
      <div class="about">
        <div class="about-head"><b>MoneyControl</b><span class="tag">v${esc(APP_VERSION)}</span></div>
        <ul class="changes">${(self.APP_CHANGELOG || []).slice(0, 5).map(([v, t]) =>
          `<li><b>${esc(v)}</b> — ${esc(t)}</li>`).join('')}</ul>
      </div>
    </section>
    <p class="ver">Версія ${esc(APP_VERSION)} · записів: ${S.txns.length} · у черзі: ${Sync.queue.length}</p>`;
  openPanel($('#settingsSheet'));
}

async function onSettingsClick(e) {
  const w = e.target.closest('[data-wedit]');
  if (w) { openWalletEdit(walletBy(w.dataset.wedit)); return; }
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  if (act === 'wadd') openWalletEdit(null);
  if (act === 'reload') { closePanels(); Sync.run(); }
  if (act === 'demoreset') {
    if (!confirm('Скинути всі демо-дані?')) return;
    S.backend.reset(); Sync.queue = []; Sync.save(); closePanels(); Sync.run();
  }
  if (act === 'switch') {
    if (Sync.queue.length && !confirm(`У черзі ${Sync.queue.length} невідправлених змін. Вони залишаться для поточної таблиці. Продовжити?`)) return;
    closePanels();
    if (!Auth.getToken()) { Auth.signIn('setup').catch((err) => toast(err.message)); return; }
    goSetup();
  }
  if (act === 'logout') {
    if (Sync.queue.length && !confirm(`У черзі ${Sync.queue.length} невідправлених змін — вони будуть втрачені. Вийти?`)) return;
    if (!Sync.queue.length && !confirm('Вийти з акаунта Google?')) return;
    LS.del('ms_state_' + S.sheetId); LS.del('ms_queue_' + S.sheetId); LS.del('ms_sheet');
    Auth.signOut();
    S.sheetId = null; S.backend = null; S.txns = []; S.wallets = []; S.contacts = []; Sync.queue = [];
    closePanels();
    show('login');
  }
}

/* ------------------------------ форма гаманця ---------------------------- */
function openWalletEdit(w) {
  S.wEditing = w || null;
  $('#wTitle').textContent = w ? 'Гаманець' : 'Новий гаманець';
  $('#wName').value = w?.name || '';
  $('#wCur').value = w?.currency || CONFIG.DEFAULT_CURRENCY;
  $('#wInitial').value = w ? numToInput(w.initial || 0) : '';
  $('#wArchived').checked = !!w?.archived;
  $('#wArchived').parentElement.hidden = !w;
  $('#wDelete').hidden = !w || S.txns.some((t) => t.wallet === w.name || t.toWallet === w.name);
  $$('#wForm .invalid').forEach((e) => e.classList.remove('invalid'));
  openPanel($('#walletSheet'));
  if (!w) $('#wName').focus();
}

function saveWallet(e) {
  e.preventDefault();
  const name = $('#wName').value.trim().replace(/\s+/g, ' ');
  if (!name) return fieldErr('#wName', 'Вкажіть назву');
  const old = S.wEditing;
  if (S.wallets.some((w) => w !== old && w.name.toLowerCase() === name.toLowerCase())) return fieldErr('#wName', 'Гаманець з такою назвою вже є');
  const currency = ($('#wCur').value.trim() || CONFIG.DEFAULT_CURRENCY).toUpperCase();
  if (!/^[A-ZА-ЯІЇЄҐ$€₴£]{1,5}$/u.test(currency)) return fieldErr('#wCur', 'Вкажіть код валюти, напр. UAH');
  const rawInit = $('#wInitial').value.trim();
  const initial = rawInit ? evalAmount(rawInit) : 0;
  if (isNaN(initial)) return fieldErr('#wInitial', 'Неправильна сума');
  const archived = $('#wArchived').checked;

  if (old) {
    const oldName = old.name;
    Object.assign(old, { name, currency, initial, archived });
    if (oldName !== name) {
      S.txns.forEach((t) => { if (t.wallet === oldName) t.wallet = name; if (t.toWallet === oldName) t.toWallet = name; });
      if (S.filter === oldName) { S.filter = name; LS.set('ms_filter', name); }
      if (S.lastWallet === oldName) { S.lastWallet = name; LS.set('ms_lastWallet', name); }
    }
    Sync.push({ kind: 'updWallet', oldName, wallet: { ...old } });
  } else {
    const w = { name, currency, initial, archived: false, created: Date.now() };
    S.wallets.push(w);
    Sync.push({ kind: 'addWallet', wallet: { ...w } });
    S.filter = name; LS.set('ms_filter', name);
  }
  cacheState();
  render();
  closePanels();
  toast(old ? 'Гаманець збережено' : 'Гаманець створено');
}

function deleteWallet() {
  const w = S.wEditing;
  if (!w || !confirm(`Видалити гаманець «${w.name}»?`)) return;
  S.wallets = S.wallets.filter((x) => x !== w);
  Sync.push({ kind: 'delWallet', name: w.name });
  cacheState();
  render();
  closePanels();
  toast('Гаманець видалено');
}

/* ------------------------- вхід і вибір таблиці -------------------------- */
function onLogin() {
  $('#loginError').hidden = true;
  Auth.signIn('setup').catch((e) => { $('#loginError').textContent = e.message; $('#loginError').hidden = false; });
}

async function goSetup() {
  show('setup');
  $('#setupName').value = CONFIG.SHEET_NAME;
  $('#setupExisting').hidden = true;
  setupBusy('Шукаю ваші таблиці…');
  try {
    if (!Auth.email) { Auth.email = await Drive.email(); Auth.save(); }
    $('#setupEmail').textContent = Auth.email;
    const files = await Drive.find();
    $('#setupList').innerHTML = files.map((f) => `
      <button class="btn" data-sheet="${esc(f.id)}"><span style="flex:1">${esc(f.name)}</span>
      <small class="muted">${new Date(f.modifiedTime).toLocaleDateString('uk-UA')}</small></button>`).join('');
    $('#setupExisting').hidden = !files.length;
    setupBusy(null);
  } catch (e) {
    setupBusy(null);
    if (e instanceof AuthError) { show('login'); return; }
    toast(e.message, 5000);
  }
}

function setupBusy(msg) {
  $('#setupStatus').hidden = !msg;
  $('#setupStatus').textContent = msg || '';
  $$('#screen-setup button').forEach((b) => { b.disabled = !!msg; });
}

async function createSheet(e) {
  e.preventDefault();
  const name = $('#setupName').value.trim() || CONFIG.SHEET_NAME;
  try {
    setupBusy('Створюю таблицю…');
    const f = await Drive.create(name);
    const b = new SheetsBackend(f.id);
    setupBusy('Налаштовую аркуші…');
    await b.setup();
    await b.exec({ kind: 'addWallet', attempts: 0, wallet: { name: CONFIG.FIRST_WALLET, currency: CONFIG.DEFAULT_CURRENCY, initial: 0, archived: false, created: Date.now() } });
    setupBusy(null);
    openSheet(f.id);
    toast('Таблицю створено');
  } catch (err) {
    setupBusy(null);
    if (err instanceof AuthError) { show('login'); return; }
    toast('Не вдалося створити таблицю: ' + err.message, 6000);
  }
}

function openSheet(id) {
  S.sheetId = id;
  if (!DEMO) { S.backend = new SheetsBackend(id); LS.set('ms_sheet', id); }
  const c = LS.get('ms_state_' + id, null);
  S.txns = c?.txns || []; S.wallets = c?.wallets || []; S.contacts = c?.contacts || [];
  Sync.queue = LS.get('ms_queue_' + id, []);
  show('main');
  render();
  updatePending();
  if (DEMO || Auth.getToken()) { showAuthBanner(false); Sync.run(); }
  else { showAuthBanner(true); setStatus('auth'); }
}

/* -------------------------------- події ---------------------------------- */
function bindUI() {
  $('#btnLogin').onclick = onLogin;
  $('#setupForm').onsubmit = createSheet;
  $('#setupList').onclick = (e) => { const b = e.target.closest('[data-sheet]'); if (b) openSheet(b.dataset.sheet); };
  $('#setupLogout').onclick = () => { Auth.signOut(); LS.del('ms_sheet'); show('login'); };

  $('#fab').onclick = () => openTx(null);
  $('#btnMenu').onclick = openSettings;
  $('#btnRefresh').onclick = () => {
    if (!DEMO && !Auth.getToken()) { $('#authBtn').click(); return; }
    Sync.run();
  };
  $('#btnSearch').onclick = () => {
    const bar = $('#searchBar');
    bar.hidden = !bar.hidden;
    if (!bar.hidden) $('#searchInput').focus();
    else { $('#searchInput').value = ''; S.search = ''; renderList(); }
  };
  $('#searchInput').oninput = (e) => { S.search = e.target.value.trim().toLowerCase(); S.limit = 100; renderList(); };

  $('#walletChips').onclick = (e) => {
    const b = e.target.closest('[data-w]');
    if (!b) return;
    S.filter = b.dataset.w; S.limit = 100;
    LS.set('ms_filter', S.filter);
    render();
  };
  $('#txList').onclick = (e) => {
    if (e.target.closest('#moreBtn')) { S.limit += 100; renderList(); return; }
    const b = e.target.closest('[data-id]');
    if (b) { const t = S.txns.find((x) => x.id === b.dataset.id); if (t) openTx(t); }
  };

  $('#backdrop').onclick = closePanels;
  $$('[data-close]').forEach((b) => { b.onclick = closePanels; });
  window.addEventListener('popstate', hidePanels);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', pinSheetHead);
    window.visualViewport.addEventListener('scroll', pinSheetHead);
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#backdrop').hidden) closePanels(); });

  $('#txForm').onsubmit = saveTx;
  $('#txDelete').onclick = deleteTx;
  $$('#txForm input[name=type]').forEach((r) => { r.onchange = updateTxForm; });
  $('#fWallet').onchange = () => { updateTxForm(); updateAmountHint(); };
  $('#fToWallet').onchange = updateTxForm;
  bindGrouping($('#fAmount'), updateAmountHint);
  bindGrouping($('#fToAmount'));
  bindGrouping($('#wInitial'));
  $('#fAmount').onblur = () => {
    const raw = $('#fAmount').value;
    const v = evalAmount(raw);
    if (!isNaN(v) && /[-+*/(]/.test(raw.replace(/^[-+]/, ''))) { $('#fAmount').value = numToInput(v); updateAmountHint(); }
  };

  const fc = $('#fContact');
  fc.addEventListener('input', showSuggestions);
  fc.addEventListener('focus', showSuggestions);
  fc.addEventListener('blur', () => setTimeout(() => { $('#contactSug').hidden = true; }, 180));
  fc.addEventListener('keydown', (e) => {
    const ul = $('#contactSug');
    const items = $$('li', ul);
    if (ul.hidden || !items.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      sugIndex = (sugIndex + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items.forEach((li, i) => li.classList.toggle('active', i === sugIndex));
    } else if (e.key === 'Enter' && sugIndex >= 0) {
      e.preventDefault();
      pickSuggestion(items[sugIndex].dataset.name);
    } else if (e.key === 'Escape') {
      e.stopPropagation(); ul.hidden = true;
    }
  });
  $('#contactSug').addEventListener('mousedown', (e) => e.preventDefault()); // не втрачати фокус на десктопі
  $('#contactSug').addEventListener('click', (e) => {
    const li = e.target.closest('li');
    if (li) pickSuggestion(li.dataset.name);
  });

  $('#settingsBody').onclick = onSettingsClick;
  $('#wForm').onsubmit = saveWallet;
  $('#wDelete').onclick = deleteWallet;
  $('#curList').innerHTML = CONFIG.CURRENCIES.map((c) => `<option value="${esc(c)}">`).join('');

  $('#authBtn').onclick = () => { Auth.signIn('resume').catch((e) => toast(e.message, 4000)); };

  window.addEventListener('online', () => Sync.run());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !S.sheetId) return;
    if (!DEMO && !Auth.getToken()) { showAuthBanner(true); setStatus('auth'); return; }
    if (Sync.queue.length || Date.now() - S.loadedAt > 60000) Sync.run();
  });
}

/* --------------------------------- старт --------------------------------- */
function start() {
  bindUI();
  $('#setVer').textContent = 'v' + APP_VERSION;
  $('#loginVer').textContent = 'Версія ' + APP_VERSION;
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  if (DEMO) {
    $('#demoBadge').hidden = false;
    S.backend = new DemoBackend();
    openSheet('demo');
    return;
  }
  if (!CONFIG.CLIENT_ID) $('#loginWarn').hidden = false;
  Auth.load();
  const r = Auth.handleRedirect();
  const sid = LS.get('ms_sheet', null);
  if (r?.error) {
    $('#loginError').textContent = r.error;
    $('#loginError').hidden = false;
  }
  if (r && !r.error && (r.intent === 'setup' || !sid)) { goSetup(); return; }
  if (sid) {
    openSheet(sid);
    if (r?.error) toast(r.error, 5000);
  } else show('login');
}

start();
