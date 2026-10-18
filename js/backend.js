'use strict';
/* ==========================================================================
   Бекенд: авторизація Google, Drive (пошук/створення таблиці), Sheets API,
   а також демо-бекенд на localStorage з тим самим інтерфейсом.
   ========================================================================== */

const SHEET = { tx: 'Транзакції', w: 'Гаманці', c: 'Контакти' };
const TYPE_LABEL = { in: 'Надходження', out: 'Витрата', tr: 'Переказ' };
const LABEL_TYPE = { 'надходження': 'in', 'витрата': 'out', 'переказ': 'tr' };
const HEADERS = {
  tx: ['ID', 'Дата', 'Тип', 'Гаманець', 'Сума', 'Гаманець-отримувач', 'Сума зарахування', 'Контакт', 'Коментар', 'Створено', 'Змінено'],
  w: ['Назва', 'Валюта', 'Початковий залишок', 'Баланс', 'Архів', 'Створено'],
  c: ["Ім'я", 'Примітка', 'Створено'],
};
const DRIVE_PROP_KEY = 'moneySheets';
const DRIVE_PROP_VAL = '1';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';

class AuthError extends Error { constructor(m) { super(m || 'Потрібен вхід у Google'); this.name = 'AuthError'; } }
class NetError extends Error { constructor(m) { super(m || 'Немає зʼєднання'); this.name = 'NetError'; } }

const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* quota/private */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------ утиліти ---------------------------------- */
const U = {
  tzOff(ms) { return new Date(ms).getTimezoneOffset() * 60000; },
  // Google Sheets зберігає дату як кількість днів від 30.12.1899
  msToSerial(ms) { return (ms - U.tzOff(ms)) / 86400000 + 25569; },
  serialToMs(v) { const utc = (v - 25569) * 86400000; return utc + U.tzOff(utc); },
  isoToSerial(iso) { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d) / 86400000 + 25569; },
  serialToIso(v) {
    if (typeof v === 'number' && isFinite(v)) {
      return new Date(Math.round((Math.floor(v) - 25569) * 86400000)).toISOString().slice(0, 10);
    }
    if (typeof v === 'string') {
      let m = v.match(/^\s*(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);
      if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
      m = v.match(/^\s*(\d{4})-(\d{2})-(\d{2})/);
      if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    }
    return '';
  },
  todayIso() { const d = new Date(); return new Date(d.getTime() - U.tzOff(d.getTime())).toISOString().slice(0, 10); },
  // Префікс ' змушує Таблиці зберегти значення як текст (без формул і автоперетворень)
  txt(s) { s = s == null ? '' : String(s); return s === '' ? '' : "'" + s; },
  str(v) { return v == null ? '' : String(v).trim(); },
  num(v) {
    if (typeof v === 'number') return v;
    const n = parseFloat(String(v ?? '').replace(/[\s ]/g, '').replace(',', '.'));
    return isFinite(n) ? n : 0;
  },
  uid(p) { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); },
};

/* ---------------------- перетворення рядок <-> обʼєкт -------------------- */
function balanceFormula() {
  const T = `'${SHEET.tx}'!`;
  const key = 'INDEX(A:A,ROW())';
  const s = (sumCol, critCol, type) =>
    `SUMIFS(${T}${sumCol}:${sumCol},${T}${critCol}:${critCol},${key},${T}C:C,"${type}")`;
  return `=INDEX(C:C,ROW())+${s('E', 'D', TYPE_LABEL.in)}-${s('E', 'D', TYPE_LABEL.out)}` +
    `-${s('E', 'D', TYPE_LABEL.tr)}+${s('G', 'F', TYPE_LABEL.tr)}`;
}

const Rows = {
  txTo(t) {
    const tr = t.type === 'tr';
    return [
      U.txt(t.id), U.isoToSerial(t.date), U.txt(TYPE_LABEL[t.type]), U.txt(t.wallet), t.amount,
      tr ? U.txt(t.toWallet) : '', tr ? (t.toAmount ?? t.amount) : '',
      U.txt(t.contact), U.txt(t.comment),
      U.msToSerial(t.created || Date.now()), U.msToSerial(t.updated || t.created || Date.now()),
    ];
  },
  txFrom(r) {
    const rawAmount = U.num(r[4]);
    const date = U.serialToIso(r[1]);
    if (!date && !rawAmount && !U.str(r[3])) return null;
    let type = LABEL_TYPE[U.str(r[2]).toLowerCase()];
    if (!type) type = rawAmount < 0 ? 'out' : (U.str(r[5]) ? 'tr' : 'out');
    const amount = Math.abs(rawAmount);
    const toAmountRaw = r[6];
    return {
      id: U.str(r[0]),
      date: date || U.todayIso(),
      type,
      wallet: U.str(r[3]),
      amount,
      toWallet: type === 'tr' ? U.str(r[5]) : '',
      toAmount: type === 'tr' ? (toAmountRaw === '' || toAmountRaw == null ? amount : Math.abs(U.num(toAmountRaw))) : null,
      contact: U.str(r[7]),
      comment: U.str(r[8]),
      created: typeof r[9] === 'number' ? U.serialToMs(r[9]) : 0,
      updated: typeof r[10] === 'number' ? U.serialToMs(r[10]) : 0,
    };
  },
  wTo(w) {
    return [U.txt(w.name), U.txt(w.currency), w.initial || 0, balanceFormula(),
      w.archived ? U.txt('Так') : '', U.msToSerial(w.created || Date.now())];
  },
  wFrom(r) {
    const name = U.str(r[0]);
    if (!name) return null;
    return {
      name,
      currency: (U.str(r[1]).replace(/[^A-Za-zА-Яа-яІіЇїЄєҐґ$€₴£]/g, '').slice(0, 5) || CONFIG.DEFAULT_CURRENCY).toUpperCase(),
      initial: U.num(r[2]),
      archived: /^(так|yes|true|1|x|\+)$/i.test(U.str(r[4])),
      created: typeof r[5] === 'number' ? U.serialToMs(r[5]) : 0,
    };
  },
  cTo(c) { return [U.txt(c.name), U.txt(c.note || ''), U.msToSerial(c.created || Date.now())]; },
  cFrom(r) {
    const name = U.str(r[0]);
    if (!name) return null;
    return { name, note: U.str(r[1]), created: typeof r[2] === 'number' ? U.serialToMs(r[2]) : 0 };
  },
};

/* ------------------------------ авторизація ------------------------------ */
/* OAuth 2.0 через перенаправлення сторінки (без popup) — надійно працює на iOS/Android,
   у режимі «на головному екрані» і при відкритті посилань з месенджерів. */
const Auth = {
  token: null, exp: 0, email: '',

  load() { Object.assign(this, LS.get('ms_auth', {})); },
  save() { LS.set('ms_auth', { token: this.token, exp: this.exp, email: this.email }); },
  getToken() { return this.token && Date.now() < this.exp - 30000 ? this.token : null; },
  invalidate() { this.token = null; this.exp = 0; this.save(); },

  // Канонічний шлях додатку: без index.html, з кінцевим «/», малими літерами.
  // Саме ця адреса має бути в Authorized redirect URIs.
  canonicalPath() {
    let p = location.pathname.replace(/index\.html$/i, '');
    if (!p.endsWith('/')) p += '/';
    return p.toLowerCase();
  },
  redirectUri() {
    return CONFIG.REDIRECT_URI || (location.origin + this.canonicalPath());
  },

  // Переходить на сторінку входу Google. intent — що робити після повернення: 'setup' | 'resume'
  signIn(intent = 'resume') {
    if (!CONFIG.CLIENT_ID) return Promise.reject(new Error('Не вказано CLIENT_ID у js/config.js'));
    const state = U.uid('s');
    LS.set('ms_oauth', { state, intent, ts: Date.now() });
    const p = new URLSearchParams({
      client_id: CONFIG.CLIENT_ID,
      redirect_uri: this.redirectUri(),
      response_type: 'token',
      scope: SCOPE,
      include_granted_scopes: 'true',
      state,
    });
    if (this.email) p.set('login_hint', this.email);
    else p.set('prompt', 'select_account');
    location.assign('https://accounts.google.com/o/oauth2/v2/auth?' + p.toString());
    return new Promise(() => {}); // сторінка йде на Google
  },

  // Викликається при старті: забирає токен з #access_token=... після повернення від Google
  handleRedirect() {
    const hash = location.hash.slice(1);
    if (!/(^|&)(access_token|error)=/.test(hash)) return null;
    const h = new URLSearchParams(hash);
    history.replaceState(null, '', location.pathname + location.search);
    const saved = LS.get('ms_oauth', null);
    LS.del('ms_oauth');
    if (!saved || saved.state !== h.get('state')) return { error: 'Не вдалося завершити вхід, спробуйте ще раз' };
    if (h.get('error')) return { error: h.get('error') === 'access_denied' ? 'Вхід скасовано' : 'Помилка входу: ' + h.get('error'), intent: saved.intent };
    if (!(h.get('scope') || '').includes('drive.file')) {
      return { error: 'Потрібно дозволити доступ до файлів, створених додатком', intent: saved.intent };
    }
    this.token = h.get('access_token');
    this.exp = Date.now() + (Number(h.get('expires_in')) || 3600) * 1000;
    this.save();
    return { intent: saved.intent };
  },

  signOut() {
    if (this.token) {
      fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(this.token), { method: 'POST', mode: 'no-cors' }).catch(() => {});
    }
    this.token = null; this.exp = 0; this.email = '';
    this.save();
  },
};

async function gfetch(url, opts = {}) {
  const token = Auth.getToken();
  if (!token) throw new AuthError();
  let res;
  try {
    res = await fetch(url, {
      ...opts,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...(opts.headers || {}) },
    });
  } catch (e) {
    throw new NetError();
  }
  if (res.status === 401) { Auth.invalidate(); throw new AuthError('Сесія Google завершилась'); }
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error.message || msg; } catch { /* ignore */ }
    const e = new Error(`Google API ${res.status}: ${msg}`);
    e.status = res.status;
    throw e;
  }
  return res.status === 204 ? null : res.json();
}

/* --------------------------------- Drive --------------------------------- */
const Drive = {
  async find() {
    const q = `appProperties has { key='${DRIVE_PROP_KEY}' and value='${DRIVE_PROP_VAL}' } and trashed=false`;
    const url = 'https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent(q) +
      '&fields=' + encodeURIComponent('files(id,name,modifiedTime)') +
      '&orderBy=' + encodeURIComponent('modifiedTime desc') + '&pageSize=20';
    const j = await gfetch(url);
    return j.files || [];
  },
  async create(name) {
    return gfetch('https://www.googleapis.com/drive/v3/files?fields=id,name', {
      method: 'POST',
      body: JSON.stringify({
        name, mimeType: 'application/vnd.google-apps.spreadsheet',
        appProperties: { [DRIVE_PROP_KEY]: DRIVE_PROP_VAL },
      }),
    });
  },
  async email() {
    try {
      const j = await gfetch('https://www.googleapis.com/drive/v3/about?fields=' + encodeURIComponent('user(emailAddress)'));
      return j.user?.emailAddress || '';
    } catch (e) {
      if (e instanceof AuthError || e instanceof NetError) throw e;
      return '';
    }
  },
};

/* -------------------------------- Sheets --------------------------------- */
class SheetsBackend {
  constructor(spreadsheetId) { this.id = spreadsheetId; this.sheetIds = null; }

  base() { return `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(this.id)}`; }
  rng(sheet, a1) { return `'${sheet}'!${a1}`; }

  async get(ranges) {
    const qs = ranges.map((r) => 'ranges=' + encodeURIComponent(r)).join('&');
    const j = await gfetch(`${this.base()}/values:batchGet?${qs}&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`);
    return j.valueRanges.map((v) => v.values || []);
  }
  append(sheet, cols, rows) {
    const range = encodeURIComponent(this.rng(sheet, cols));
    return gfetch(`${this.base()}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=OVERWRITE`,
      { method: 'POST', body: JSON.stringify({ values: rows }) });
  }
  setValues(data) {
    return gfetch(`${this.base()}/values:batchUpdate`,
      { method: 'POST', body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }) });
  }
  batch(requests) {
    return gfetch(`${this.base()}:batchUpdate`, { method: 'POST', body: JSON.stringify({ requests }) });
  }
  async sheetId(title) {
    if (!this.sheetIds) {
      const j = await gfetch(`${this.base()}?fields=${encodeURIComponent('sheets.properties(sheetId,title)')}`);
      this.sheetIds = Object.fromEntries(j.sheets.map((s) => [s.properties.title, s.properties.sheetId]));
    }
    if (!(title in this.sheetIds)) throw new Error(`У таблиці немає аркуша «${title}»`);
    return this.sheetIds[title];
  }
  async findRow(sheet, key) {
    const [vals] = await this.get([this.rng(sheet, 'A2:A')]);
    const k = String(key).trim();
    const i = vals.findIndex((r) => String(r[0] ?? '').trim() === k);
    return i < 0 ? 0 : i + 2;
  }
  async deleteRow(sheet, row) {
    const sid = await this.sheetId(sheet);
    await this.batch([{ deleteDimension: { range: { sheetId: sid, dimension: 'ROWS', startIndex: row - 1, endIndex: row } } }]);
  }

  /* Початкове оформлення щойно створеної таблиці */
  async setup() {
    const meta = await gfetch(`${this.base()}?fields=${encodeURIComponent('sheets.properties(sheetId,title)')}`);
    const first = meta.sheets[0].properties.sheetId;
    const ids = { tx: first, w: 1001, c: 1002 };
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Kyiv';
    const header = (sid, n) => ({
      repeatCell: {
        range: { sheetId: sid, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: n },
        cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.87, green: 0.94, blue: 0.93 } } },
        fields: 'userEnteredFormat(textFormat,backgroundColor)',
      },
    });
    const fmt = (sid, c0, c1, type, pattern) => ({
      repeatCell: {
        range: { sheetId: sid, startRowIndex: 1, startColumnIndex: c0, endColumnIndex: c1 },
        cell: { userEnteredFormat: { numberFormat: { type, pattern } } },
        fields: 'userEnteredFormat.numberFormat',
      },
    });
    const width = (sid, c0, c1, px) => ({
      updateDimensionProperties: {
        range: { sheetId: sid, dimension: 'COLUMNS', startIndex: c0, endIndex: c1 },
        properties: { pixelSize: px }, fields: 'pixelSize',
      },
    });
    const walletList = (col) => ({
      setDataValidation: {
        range: { sheetId: ids.tx, startRowIndex: 1, startColumnIndex: col, endColumnIndex: col + 1 },
        rule: { condition: { type: 'ONE_OF_RANGE', values: [{ userEnteredValue: `='${SHEET.w}'!A2:A` }] }, showCustomUi: true, strict: false },
      },
    });
    const money = '#,##0.00';
    await this.batch([
      { updateSpreadsheetProperties: { properties: { locale: 'uk_UA', timeZone: tz }, fields: 'locale,timeZone' } },
      { updateSheetProperties: { properties: { sheetId: ids.tx, title: SHEET.tx, gridProperties: { frozenRowCount: 1 } }, fields: 'title,gridProperties.frozenRowCount' } },
      { addSheet: { properties: { sheetId: ids.w, title: SHEET.w, gridProperties: { frozenRowCount: 1 } } } },
      { addSheet: { properties: { sheetId: ids.c, title: SHEET.c, gridProperties: { frozenRowCount: 1 } } } },
      header(ids.tx, HEADERS.tx.length), header(ids.w, HEADERS.w.length), header(ids.c, HEADERS.c.length),
      fmt(ids.tx, 1, 2, 'DATE', 'dd.mm.yyyy'),
      fmt(ids.tx, 4, 5, 'NUMBER', money), fmt(ids.tx, 6, 7, 'NUMBER', money),
      fmt(ids.tx, 9, 11, 'DATE_TIME', 'dd.mm.yyyy hh:mm'),
      fmt(ids.w, 2, 4, 'NUMBER', money), fmt(ids.w, 5, 6, 'DATE_TIME', 'dd.mm.yyyy hh:mm'),
      fmt(ids.c, 2, 3, 'DATE_TIME', 'dd.mm.yyyy hh:mm'),
      {
        setDataValidation: {
          range: { sheetId: ids.tx, startRowIndex: 1, startColumnIndex: 2, endColumnIndex: 3 },
          rule: { condition: { type: 'ONE_OF_LIST', values: Object.values(TYPE_LABEL).map((v) => ({ userEnteredValue: v })) }, showCustomUi: true, strict: false },
        },
      },
      walletList(3), walletList(5),
      width(ids.tx, 0, 1, 110), width(ids.tx, 1, 2, 95), width(ids.tx, 2, 3, 120), width(ids.tx, 3, 4, 140),
      width(ids.tx, 4, 5, 100), width(ids.tx, 5, 6, 150), width(ids.tx, 6, 7, 130), width(ids.tx, 7, 8, 170),
      width(ids.tx, 8, 9, 260), width(ids.tx, 9, 11, 130),
      width(ids.w, 0, 1, 170), width(ids.w, 2, 4, 140), width(ids.w, 5, 6, 130),
      width(ids.c, 0, 1, 200), width(ids.c, 1, 2, 260), width(ids.c, 2, 3, 130),
    ]);
    await this.setValues([
      { range: this.rng(SHEET.tx, 'A1:K1'), values: [HEADERS.tx] },
      { range: this.rng(SHEET.w, 'A1:F1'), values: [HEADERS.w] },
      { range: this.rng(SHEET.c, 'A1:C1'), values: [HEADERS.c] },
    ]);
    this.sheetIds = null;
  }

  async load() {
    const [tx, w, c] = await this.get([this.rng(SHEET.tx, 'A2:K'), this.rng(SHEET.w, 'A2:F'), this.rng(SHEET.c, 'A2:C')]);
    const txns = [];
    const fixIds = [];
    tx.forEach((r, i) => {
      const t = Rows.txFrom(r);
      if (!t) return;
      if (!t.id) { // рядок додано вручну в таблиці — присвоюємо ID
        t.id = U.uid('t');
        fixIds.push({ range: this.rng(SHEET.tx, `A${i + 2}`), values: [[U.txt(t.id)]] });
      }
      txns.push(t);
    });
    if (fixIds.length) await this.setValues(fixIds);
    return {
      txns,
      wallets: w.map(Rows.wFrom).filter(Boolean),
      contacts: c.map(Rows.cFrom).filter(Boolean),
    };
  }

  async exec(op) {
    switch (op.kind) {
      case 'addTxn': {
        if (op.attempts > 0 && await this.findRow(SHEET.tx, op.txn.id)) return; // захист від дубля при повторі
        await this.append(SHEET.tx, 'A:K', [Rows.txTo(op.txn)]);
        return;
      }
      case 'updTxn': {
        const row = await this.findRow(SHEET.tx, op.txn.id);
        if (!row) { await this.append(SHEET.tx, 'A:K', [Rows.txTo(op.txn)]); return; }
        await this.setValues([{ range: this.rng(SHEET.tx, `A${row}:K${row}`), values: [Rows.txTo(op.txn)] }]);
        return;
      }
      case 'delTxn': {
        const row = await this.findRow(SHEET.tx, op.id);
        if (row) await this.deleteRow(SHEET.tx, row);
        return;
      }
      case 'addWallet': {
        if (await this.findRow(SHEET.w, op.wallet.name)) return;
        await this.append(SHEET.w, 'A:F', [Rows.wTo(op.wallet)]);
        return;
      }
      case 'updWallet': {
        const row = await this.findRow(SHEET.w, op.oldName);
        const w = op.wallet;
        if (!row) { await this.append(SHEET.w, 'A:F', [Rows.wTo(w)]); }
        else {
          await this.setValues([
            { range: this.rng(SHEET.w, `A${row}:C${row}`), values: [[U.txt(w.name), U.txt(w.currency), w.initial || 0]] },
            { range: this.rng(SHEET.w, `E${row}`), values: [[w.archived ? U.txt('Так') : '']] },
          ]);
        }
        if (op.oldName !== w.name) {
          const [vals] = await this.get([this.rng(SHEET.tx, 'D2:F')]);
          const data = [];
          vals.forEach((r, i) => {
            if (U.str(r[0]) === op.oldName) data.push({ range: this.rng(SHEET.tx, `D${i + 2}`), values: [[U.txt(w.name)]] });
            if (U.str(r[2]) === op.oldName) data.push({ range: this.rng(SHEET.tx, `F${i + 2}`), values: [[U.txt(w.name)]] });
          });
          if (data.length) await this.setValues(data);
        }
        return;
      }
      case 'delWallet': {
        const row = await this.findRow(SHEET.w, op.name);
        if (row) await this.deleteRow(SHEET.w, row);
        return;
      }
      case 'addContact': {
        if (await this.findRow(SHEET.c, op.contact.name)) return;
        await this.append(SHEET.c, 'A:C', [Rows.cTo(op.contact)]);
        return;
      }
      default:
        throw new Error('Невідома операція ' + op.kind);
    }
  }
}

/* ------------------------- демо-бекенд (localStorage) -------------------- */
class DemoBackend {
  constructor() {
    this.key = 'ms_demo_db';
    this.db = LS.get(this.key, null) || DemoBackend.seed();
    this.save();
  }
  static seed() {
    const now = Date.now();
    const day = (n) => { const d = new Date(now - n * 86400000); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
    const t = (n, type, wallet, amount, contact, comment, extra = {}) => ({
      id: U.uid('t'), date: day(n), type, wallet, amount, toWallet: '', toAmount: null,
      contact, comment, created: now - n * 86400000, updated: now - n * 86400000, ...extra,
    });
    return {
      wallets: [
        { name: 'Готівка', currency: 'UAH', initial: 2500, archived: false, created: now },
        { name: 'Картка', currency: 'UAH', initial: 18000, archived: false, created: now },
        { name: 'Долари', currency: 'USD', initial: 400, archived: false, created: now },
      ],
      contacts: [
        { name: 'Олександр Петренко', note: '', created: now },
        { name: 'Сільпо', note: '', created: now },
        { name: 'Нова пошта', note: '', created: now },
      ],
      txns: [
        t(0, 'out', 'Готівка', 345.5, 'Сільпо', 'Продукти'),
        t(0, 'in', 'Картка', 12000, 'Олександр Петренко', 'Оплата за плату контролера'),
        t(1, 'out', 'Картка', 120, 'Нова пошта', 'Доставка компонентів'),
        t(2, 'tr', 'Картка', 3000, '', 'Зняв готівку', { toWallet: 'Готівка', toAmount: 3000 }),
        t(3, 'out', 'Долари', 45, 'PCBWay', 'Плати, 5 шт'),
        t(4, 'in', 'Готівка', 800, 'Ірина', 'Повернула борг'),
        t(6, 'out', 'Картка', 1890, 'Rozetka', 'Паяльна станція — передоплата'),
      ],
    };
  }
  save() { LS.set(this.key, this.db); }
  reset() { this.db = DemoBackend.seed(); this.save(); }
  async load() { await sleep(120); return JSON.parse(JSON.stringify(this.db)); }
  async exec(op) {
    await sleep(80);
    const d = this.db;
    switch (op.kind) {
      case 'addTxn': if (!d.txns.some((t) => t.id === op.txn.id)) d.txns.push({ ...op.txn }); break;
      case 'updTxn': { const i = d.txns.findIndex((t) => t.id === op.txn.id); if (i >= 0) d.txns[i] = { ...op.txn }; else d.txns.push({ ...op.txn }); break; }
      case 'delTxn': d.txns = d.txns.filter((t) => t.id !== op.id); break;
      case 'addWallet': if (!d.wallets.some((w) => w.name === op.wallet.name)) d.wallets.push({ ...op.wallet }); break;
      case 'updWallet': {
        const i = d.wallets.findIndex((w) => w.name === op.oldName);
        if (i >= 0) d.wallets[i] = { ...op.wallet }; else d.wallets.push({ ...op.wallet });
        if (op.oldName !== op.wallet.name) d.txns.forEach((t) => {
          if (t.wallet === op.oldName) t.wallet = op.wallet.name;
          if (t.toWallet === op.oldName) t.toWallet = op.wallet.name;
        });
        break;
      }
      case 'delWallet': d.wallets = d.wallets.filter((w) => w.name !== op.name); break;
      case 'addContact': if (!d.contacts.some((c) => c.name === op.contact.name)) d.contacts.push({ ...op.contact }); break;
      default: throw new Error('Невідома операція ' + op.kind);
    }
    this.save();
  }
}
