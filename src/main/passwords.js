// Passwords: a small store of the user's sign-ins, offered for saving when
// they sign in and filled when they ask. The user's alone: no tool reaches
// any of it (src/shared/tools.js has none), Claude sessions' tabs never get
// the page script, an offer or a fill, and a fill happens only when the user
// picks an account from the key's menu, a native menu no page or Claude can
// open or click. See "Passwords" in README.md for the threat model.
//
// Storage: passwords.json in the profile. Each password and each username is
// encrypted on its own with Electron's safeStorage (DPAPI on Windows, the
// Keychain on macOS, the keyring through libsecret or KWallet on Linux).
// Origins are kept in the clear: they decide where the key shows without
// decrypting anything, and history.json already lists every site visited.
// Without real encryption (no keyring on Linux, where safeStorage would fall
// back to a fixed key) the feature stays off and nothing is written.
//
// Matching is by exact origin (scheme, host and port): a login saved on
// accounts.example.com is not offered on example.com or www.example.com, and
// one saved on an https page is never offered on http. No public-suffix
// rules are needed because nothing is shared between hosts.
//
// Saving: src/page/passwords.js (in an isolated world of its own, the top
// frame of the user's http(s) pages only) reports a sign-in attempt. It is
// offered for saving only once it went through: the page moved on to one
// without a password field, or the password field went away.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { safeStorage, Menu, clipboard, dialog, systemPreferences } = require('electron');
const { YOU } = require('./tabs');

const SCRIPT = fs.readFileSync(path.join(__dirname, '../page/passwords.js'), 'utf8');
const WORLD = 4831; // src/page/lib.js has 4812
const MARK = '\u0001loui-pw '; // see tabs.js: such console lines are never kept
const MAX = 512;
const FRESH_MS = 30000; // an attempt counts if the page moves on within this
const USER_MS = 5 * 60000; // a username typed on a first step, kept for the password step
const CLEAR_CLIPBOARD_MS = 30000;

function originOf(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.origin : null;
  } catch {
    return null;
  }
}
const siteOf = (origin) => new URL(origin).host;

// The cipher. safeStorage, unless it has no real key to use. LOUI_TEST may
// replace it, for the test suite only: LOUI_TEST_SAFESTORAGE=fake uses a
// fixed AES key (Linux test machines have no keyring), =off pretends there is
// no encryption. Values carry their cipher's prefix, so a file written by the
// test cipher never decrypts in a real run, and the other way round.
function createCipher() {
  const test = process.env.LOUI_TEST ? process.env.LOUI_TEST_SAFESTORAGE : null;
  if (test === 'off') return { available: false, why: 'test' };
  if (test === 'fake') {
    // TEST ONLY. Never reached without LOUI_TEST.
    const key = crypto.createHash('sha256').update('loui test cipher, not a secret').digest();
    return {
      available: true,
      encrypt(text) {
        const iv = crypto.randomBytes(12);
        const c = crypto.createCipheriv('aes-256-gcm', key, iv);
        const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
        return 't1:' + Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
      },
      decrypt(value) {
        if (!value.startsWith('t1:')) throw new Error('not the test cipher');
        const raw = Buffer.from(value.slice(3), 'base64');
        const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
        d.setAuthTag(raw.subarray(12, 28));
        return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
      },
    };
  }
  if (!safeStorage.isEncryptionAvailable()) return { available: false, why: 'none' };
  // On Linux without a keyring, safeStorage "encrypts" with a key built into
  // Chromium: as good as plain text.
  if (process.platform === 'linux' && ['basic_text', 'unknown'].includes(safeStorage.getSelectedStorageBackend())) {
    return { available: false, why: 'keyring' };
  }
  return {
    available: true,
    encrypt: (text) => 's1:' + safeStorage.encryptString(text).toString('base64'),
    decrypt(value) {
      if (!value.startsWith('s1:')) throw new Error('not encrypted by this system');
      return safeStorage.decryptString(Buffer.from(value.slice(3), 'base64'));
    },
  };
}

const WHY = {
  keyring: "Loui can't reach a keyring on this system (GNOME Keyring or KWallet), so it can't encrypt passwords, and it doesn't save them unencrypted.",
  none: "This system gives Loui no way to encrypt passwords, so it doesn't save them.",
  test: 'Encryption is turned off for this test run.',
};

function createPasswords({ tabs, win, home, send, changed }) {
  const file = path.join(home, 'passwords.json');
  const cipher = createCipher();
  const secret = crypto.randomBytes(24).toString('hex'); // proves a report came from the page script
  let logins = []; // { id, origin, username, password (both encrypted), created, updated, used }
  let never = []; // origins
  let next = 1;
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(saved.logins)) logins = saved.logins.filter((l) => originOf(l.origin) === l.origin);
    if (Array.isArray(saved.never)) never = saved.never.filter((o) => originOf(o) === o);
    if (Number.isInteger(saved.next)) next = saved.next;
  } catch {}

  // Writes only ever hold ciphertext; a temporary file renamed over the old
  // one, so a crash never leaves half a file.
  function save() {
    if (!cipher.available) return;
    const data = JSON.stringify({ version: 1, next, logins, never }, null, 1);
    fs.writeFileSync(file + '.tmp', data, { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
    changed();
  }

  // A value that will not decrypt (copied from another machine or account)
  // reads as null, and the login is shown as unreadable.
  const open = (value) => { try { return cipher.decrypt(value); } catch { return null; } };
  const forOrigin = (origin) => logins.filter((l) => l.origin === origin);
  const byId = (id) => logins.find((l) => l.id === id) || null;

  function put({ origin, username, password, id }) {
    const now = Date.now();
    const existing = id ? byId(id) : forOrigin(origin).find((l) => open(l.username) === username);
    if (existing) {
      existing.username = cipher.encrypt(username);
      existing.password = cipher.encrypt(password);
      existing.updated = now;
      return existing;
    }
    const login = {
      id: `p${next++}`, origin, username: cipher.encrypt(username), password: cipher.encrypt(password),
      created: now, updated: now, used: 0,
    };
    logins.push(login);
    return login;
  }

  // ── noticing sign-ins ───────────────────────────────────────────────────
  const watched = new Map(); // tab id -> { attempt, user, checking }
  const offers = []; // { id, tabId, origin, username, password, update }
  let seq = 0;
  const yours = (tab) => !!tab && tab.group === YOU && !!tab.wc && !tab.wc.isDestroyed();
  const notes = (tab) => {
    if (!watched.has(tab.id)) watched.set(tab.id, {});
    return watched.get(tab.id);
  };

  // At each page's DOM ready, in the user's own tabs on web pages, unless the
  // user said never for the site.
  function install(tab) {
    if (!cipher.available || !yours(tab)) return;
    const origin = originOf(tab.wc.getURL());
    if (!origin || never.includes(origin)) return;
    tab.wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: `${SCRIPT}\n;__louiPw.install(${JSON.stringify(secret)})` }])
      .catch(() => {});
  }

  function heard(tab, message, frame) {
    if (!message.startsWith(MARK + secret + ' ')) return;
    if (frame?.parent || !yours(tab)) return; // only the top frame has the script; only the user's tabs count
    const origin = originOf(tab.wc.getURL());
    if (!origin || never.includes(origin)) return;
    let report;
    try { report = JSON.parse(message.slice(MARK.length + secret.length + 1)); } catch { return; }
    const ok = (s) => typeof s === 'string' && s.length <= MAX;
    const n = notes(tab);
    if (report.kind === 'user' && ok(report.username) && report.username) {
      n.user = { origin, username: report.username, at: Date.now() };
    } else if (report.kind === 'try' && ok(report.username) && ok(report.password) && report.password) {
      let username = report.username;
      if (!username && n.user?.origin === origin && Date.now() - n.user.at < USER_MS) username = n.user.username;
      n.attempt = { origin, username, password: report.password, at: Date.now() };
    } else if (report.kind === 'gone') {
      offer(tab);
    }
  }

  // The page moved on after an attempt: offer, unless the new page asks for
  // a password again (the sign-in most likely failed).
  async function settled(tab) {
    const n = watched.get(tab.id);
    if (!n?.checking || !yours(tab)) return;
    n.checking = false;
    if (!n.attempt || Date.now() - n.attempt.at > FRESH_MS) return;
    const again = await tab.wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: `${SCRIPT}\n;__louiPw.hasPassword()` }])
      .catch(() => false);
    if (again) n.attempt = null;
    else offer(tab);
  }

  function offer(tab) {
    const n = watched.get(tab.id);
    const a = n?.attempt;
    if (n) n.attempt = null;
    if (!a || Date.now() - a.at > FRESH_MS || !yours(tab) || never.includes(a.origin)) return;
    const saved = forOrigin(a.origin).map((l) => ({ id: l.id, username: open(l.username), password: open(l.password) }));
    let same = saved.find((l) => l.username === a.username);
    // A password changed on a page that does not show the username: the
    // site's only login is the one changing.
    if (!same && !a.username && saved.length === 1) same = saved[0];
    if (same && same.password === a.password) return;
    drop(tab.id);
    offers.push({
      id: ++seq, tabId: tab.id, origin: a.origin, username: same ? same.username : a.username,
      password: a.password, update: same?.id || null,
    });
    changed();
  }

  const drop = (tabId) => {
    for (let i = offers.length - 1; i >= 0; i--) if (offers[i].tabId === tabId) offers.splice(i, 1);
  };

  // The user's answer, from the strip. id: the offer they saw.
  function answer({ id, choice } = {}) {
    const o = offers.find((x) => x.id === id);
    if (!o) return;
    offers.splice(offers.indexOf(o), 1);
    if (choice === 'save') {
      put({ origin: o.origin, username: o.username, password: o.password, id: o.update });
      save();
    } else if (choice === 'never') {
      if (!never.includes(o.origin)) never.push(o.origin);
      save();
    }
    changed();
  }

  tabs.on('created', (tab) => {
    const wc = tab.wc;
    wc.on('dom-ready', () => install(tab));
    wc.on('console-message', (e, ...old) => {
      const message = e.message !== undefined ? e.message : old[1];
      if (typeof message === 'string' && message.startsWith(MARK)) heard(tab, message, e.frame);
    });
    wc.on('did-navigate', () => {
      const n = watched.get(tab.id);
      if (n?.attempt) n.checking = true;
    });
    wc.on('did-stop-loading', () => settled(tab));
    wc.on('did-fail-load', (_e, code, _r, _u, isMainFrame) => {
      const n = watched.get(tab.id);
      if (isMainFrame && code !== -3 && n) { n.attempt = null; n.checking = false; }
    });
  });
  tabs.on('closing', (tab) => {
    watched.delete(tab.id);
    drop(tab.id);
  });
  // A tab handed to a session loses everything it had noticed or offered.
  tabs.on('change', () => {
    const handed = (id) => tabs.get(id)?.group !== YOU;
    const had = offers.length;
    for (const o of offers.filter((x) => handed(x.tabId))) drop(o.tabId);
    for (const id of [...watched.keys()]) if (handed(id)) watched.delete(id);
    if (offers.length !== had) changed();
  });

  // ── filling ─────────────────────────────────────────────────────────────
  // The tab on screen, if it is the user's, awake, on a web page: its origin.
  function fillable() {
    const tab = tabs.active();
    if (!cipher.available || !yours(tab) || tab.asleep) return null;
    const origin = originOf(tab.wc.getURL());
    return origin ? { tab, origin } : null;
  }

  // Only from the key's menu (a click by the user). The page's top frame only:
  // never a frame, of the same site or not.
  async function fill(tabId, loginId) {
    const tab = tabs.get(tabId);
    const login = byId(loginId);
    if (!login || !yours(tab) || tab.id !== tabs.activeId) return { filled: false };
    const origin = originOf(tab.wc.getURL());
    if (origin !== login.origin) return { filled: false };
    const username = open(login.username);
    const password = open(login.password);
    if (password == null) return { filled: false };
    const result = await tab.wc.executeJavaScriptInIsolatedWorld(WORLD, [{
      code: `${SCRIPT}\n;__louiPw.fill(${JSON.stringify({ origin, username: username || '', password })})`,
    }]).catch(() => ({ filled: false }));
    if (result?.filled) {
      login.used = Date.now();
      save();
    }
    return result;
  }

  const label = (text) => {
    const s = text.length > 60 ? text.slice(0, 59) + '…' : text;
    return s.replace(/&/g, '&&');
  };
  function menuItems() {
    const here = fillable();
    if (!here) return [];
    const items = forOrigin(here.origin).map((l) => ({
      id: l.id, label: label(open(l.username) || '(no username)'),
      click: () => fill(here.tab.id, l.id),
    }));
    items.push({ type: 'separator' }, { label: 'Manage passwords', click: () => showPanel() });
    return items;
  }
  function keyMenu({ x, y } = {}) {
    const items = menuItems();
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win, x: Math.round(x || 0), y: Math.round(y || 0) });
  }

  // ── the Passwords panel ─────────────────────────────────────────────────
  const showPanel = () => { win.webContents.focus(); send('passwords', { type: 'panel' }); };

  function list() {
    return {
      type: 'list', available: cipher.available, why: WHY[cipher.why] || '',
      items: logins.map((l) => {
        const username = open(l.username);
        return {
          id: l.id, origin: l.origin, site: siteOf(l.origin), username: username ?? '',
          unreadable: username == null || open(l.password) == null, updated: l.updated,
        };
      }).sort((a, b) => a.site.localeCompare(b.site) || a.username.localeCompare(b.username)),
      never: never.map((origin) => ({ origin, site: siteOf(origin) })),
    };
  }
  const publish = () => send('passwords', list());

  // On macOS the system confirms it is the user (Touch ID) before a password
  // is shown. Windows and Linux have no such prompt for an app like this;
  // there the click is the confirmation, and the panel hides it after 30 s.
  async function confirmUser(reason) {
    if (process.platform !== 'darwin' || !systemPreferences.canPromptTouchID?.()) return true;
    try { await systemPreferences.promptTouchID(reason); return true; } catch { return false; }
  }

  async function reveal(id) {
    const l = byId(id);
    if (!l || !(await confirmUser(`show the password for ${siteOf(l.origin)}`))) return;
    const password = open(l.password);
    if (password != null) send('passwords', { type: 'reveal', id, password });
  }

  // Straight from here to the clipboard, never through the window. Cleared
  // after 30 s if it still holds the password.
  let clearing = null;
  async function copy(id) {
    const l = byId(id);
    if (!l || !(await confirmUser(`copy the password for ${siteOf(l.origin)}`))) return;
    const password = open(l.password);
    if (password == null) return;
    clipboard.writeText(password);
    clearTimeout(clearing);
    clearing = setTimeout(() => { if (clipboard.readText() === password) clipboard.clear(); }, CLEAR_CLIPBOARD_MS);
  }

  function update({ id, username, password } = {}) {
    const l = byId(id);
    if (!l || typeof username !== 'string' || username.length > MAX) return;
    if (typeof password === 'string' && password && password.length <= MAX) l.password = cipher.encrypt(password);
    l.username = cipher.encrypt(username);
    l.updated = Date.now();
    save();
    publish();
  }

  function remove(id) {
    const i = logins.findIndex((l) => l.id === id);
    if (i < 0) return;
    logins.splice(i, 1);
    save();
    publish();
  }

  function unnever(origin) {
    never = never.filter((o) => o !== origin);
    save();
    publish();
  }

  // ── import ──────────────────────────────────────────────────────────────
  // The CSV Brave and Chrome export (name,url,username,password,note). A login
  // already saved for the same site and username is left as it is.
  function importCsv(text) {
    if (!cipher.available) throw new Error(WHY[cipher.why]);
    const rows = parseCsv(text);
    const head = (rows.shift() || []).map((h) => h.trim().toLowerCase());
    const col = (name) => head.indexOf(name);
    const [u, n, p] = [col('url'), col('username'), col('password')];
    if (u < 0 || p < 0) throw new Error("It doesn't look like a passwords file: it needs url and password columns.");
    let added = 0, skipped = 0;
    for (const row of rows) {
      const origin = originOf(row[u] || '');
      const username = (n >= 0 ? row[n] : '') || '';
      const password = row[p] || '';
      if (!origin || !password || username.length > MAX || password.length > MAX ||
        forOrigin(origin).some((l) => open(l.username) === username)) {
        skipped++;
        continue;
      }
      put({ origin, username, password });
      added++;
    }
    save();
    publish();
    return { added, skipped };
  }

  async function chooseImport() {
    if (!cipher.available) return;
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Import passwords',
      buttonLabel: 'Import',
      filters: [{ name: 'Passwords file', extensions: ['csv'] }, { name: 'All files', extensions: ['*'] }],
      properties: ['openFile'],
    });
    if (canceled || !filePaths[0]) return;
    let message, detail = '', buttons = ['OK'], done;
    try {
      done = importCsv(fs.readFileSync(filePaths[0], 'utf8'));
      message = done.added === 1 ? 'Imported 1 password.' : `Imported ${done.added} passwords.`;
      if (done.skipped) message += ` ${done.skipped} already here or not for web pages, so left out.`;
      detail = `${path.basename(filePaths[0])} holds your passwords unencrypted: anything on this computer can read it. Delete it now that they are in Loui.`;
      buttons = ['Delete the file', 'Keep it'];
    } catch (e) {
      message = `Couldn't import that file: ${e.message}`;
    }
    const { response } = await dialog.showMessageBox(win, { type: done ? 'warning' : 'info', message, detail, buttons, defaultId: 0, cancelId: buttons.length - 1 });
    if (done && response === 0) {
      try { fs.rmSync(filePaths[0]); } catch (e) {
        dialog.showMessageBox(win, { type: 'error', message: `Couldn't delete it: ${e.message}`, buttons: ['OK'] });
      }
    }
  }

  // ── requests from the window chrome ─────────────────────────────────────
  // There is deliberately no request that fills: only the key's native menu does.
  function handle(r = {}) {
    switch (r.do) {
      case 'menu': return keyMenu(r);
      case 'answer': return answer(r);
      case 'list': return publish();
      case 'reveal': return reveal(r.id);
      case 'copy': return copy(r.id);
      case 'update': return update(r);
      case 'remove': return remove(r.id);
      case 'unnever': return unnever(r.origin);
      case 'import': return chooseImport();
    }
  }

  // For the window chrome: whether the key shows, and the offer for the tab on screen.
  function state() {
    const here = fillable();
    const o = offers.find((x) => x.tabId === tabs.activeId);
    return {
      passwords: {
        available: cipher.available,
        key: here ? forOrigin(here.origin).length : 0,
        offer: o ? { id: o.id, site: siteOf(o.origin), username: o.username, update: !!o.update } : null,
      },
    };
  }

  // For the File menu in main.js.
  const fileMenu = () => [{ label: 'Passwords', click: showPanel }];

  // For the tests (LOUI_TEST only).
  const probes = {
    'passwords:menu': () => menuItems().filter((i) => i.id).map((i) => i.label),
    // As if the user chose the nth account in the key's menu.
    'passwords:choose': (n) => menuItems().filter((i) => i.id)[n || 0]?.click(),
    'passwords:list': () => list(),
    'passwords:panel': () => showPanel(),
    'passwords:import-file': (p) => importCsv(fs.readFileSync(p, 'utf8')),
    'passwords:reveal-now': (id) => open(byId(id)?.password || ''),
  };

  return { state, handle, probes, fileMenu };
}

// RFC 4180 CSV: quoted fields may hold commas, quotes ("") and line breaks.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  return rows;
}

module.exports = { createPasswords, parseCsv, WORLD };
