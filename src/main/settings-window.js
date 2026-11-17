// The Settings window (File › Settings, Ctrl+,): every option Loui has, in
// one place, like a browser's settings page.
//
// A window of its own, as the task manager is (taskmanager.js): tab pages are
// native views over the window chrome, so a page of settings cannot be drawn
// over them, and as a tab it would be a page Claude sessions could reach. It
// is made when opened and gone when closed.
//
// It owns no settings. Each one is read from, and changed through, the module
// that owns the behaviour (search.js, sleep.js, link.js…) or main.js's
// settings object, so the window chrome, the menus and this window always
// agree. main.js calls changed() whenever it pushes state to the chrome, and
// the window is sent what it shows if that differs from what it has.
//
// Only this window's page may ask for anything here: every request checks its
// sender. No secret goes to the page: the relay key and passwords are not in
// state(), and the key travels one way, from the page to link.js.
const path = require('path');
const { BrowserWindow, ipcMain, app, nativeTheme, screen, shell } = require('electron');
const { YOU } = require('./tabs');

const RELEASES = 'https://github.com/francisphan/loui/releases';
const SECTIONS = ['general', 'tabs', 'search', 'privacy', 'passwords', 'claude', 'reading', 'about'];

// A site as the user types it ("Example.com/page", "https://example.com:8080") -> its host.
function hostOf(input) {
  const text = String(input || '').trim().toLowerCase();
  if (!text) return null;
  try {
    return new URL(/^[a-z]+:\/\//.test(text) ? text : `https://${text}`).host || null;
  } catch {
    return null;
  }
}

// settings, save: settings.json (main.js). tabs: the browser's. home: the
// profile folder. setTheme, setTabStrip, tabStrip, refreshMenu: main.js's own.
// The rest are the modules whose settings are shown.
function createSettingsWindow({
  settings, save, tabs, home, lockToApp, setTheme, setTabStrip, tabStrip, refreshMenu,
  search, brave, downloads, sleep, bookmarks, shields, permissions, passwords, link, consent,
  guardrails, activity, reader, updater, defaultBrowser, startPage,
}) {
  let win = null;
  let sent = ''; // what the page was last sent, as text
  let placeTimer = null;
  // What only the system knows, asked when the window opens or comes back to
  // the front (the default browser is chosen in Windows' own settings).
  const canLogin = process.platform !== 'linux';
  let login = false; // "Open Loui when I sign in"
  let browser = { can: false, isDefault: false };
  function askSystem() {
    if (canLogin) login = app.getLoginItemSettings().openAtLogin;
    browser = defaultBrowser.state();
  }

  // Everything the page shows. No secrets: link.state() says only whether a key is saved.
  function state() {
    const p = reader.prefs();
    return {
      general: {
        theme: nativeTheme.themeSource,
        startup: settings.startup === 'new' ? 'new' : 'restore',
        start: startPage.prefs(),
        login: canLogin ? { on: login } : null,
        defaultBrowser: browser,
        downloads: downloads.prefs(),
      },
      tabs: {
        vertical: tabStrip().vertical,
        bookmarksBar: !!bookmarks.barShown(),
        sleep: sleep.prefs(),
      },
      search: search.state().search,
      privacy: {
        shields: shields.prefs(),
        permissions: permissions.state().sitePermissions,
        elsewhere: brave.state().elsewhere,
      },
      passwords: passwords.prefs(),
      claude: {
        relay: { ...link.state(), sessions: tabs.groups.filter((g) => g.id !== YOU).length },
        connectors: consent.state().allowedConnectors,
        guardrails: guardrails.state().guardrails,
        activity: activity.prefs(),
        socket: settings.localSocket === true,
      },
      reading: { size: p.size, width: p.width, face: p.face, ...reader.choices },
      about: {
        version: app.getVersion(),
        electron: process.versions.electron,
        chromium: process.versions.chrome,
        profile: home,
        update: updater.state(), // null in a copy run from source
        working: tabs.groups.filter((g) => g.busy > 0).length,
      },
    };
  }

  const live = () => win && !win.isDestroyed();
  function push(force = false) {
    if (!live()) return;
    const now = state();
    const text = JSON.stringify(now);
    if (!force && text === sent) return;
    sent = text;
    win.webContents.send('settings:state', now);
  }

  // The main window, brought to the front (for what opens there).
  function toMain(w) {
    const main = w?.win;
    if (!main || main.isDestroyed()) return;
    if (main.isMinimized()) main.restore();
    main.focus();
  }

  // What the page can ask for. Each goes to the function that owns the setting.
  const acts = {
    theme: (theme) => { if (['dark', 'light', 'system'].includes(theme)) setTheme(theme); },
    startup: (choice) => { settings.startup = choice === 'new' ? 'new' : 'restore'; save(); },
    ...startPage.acts, // new-tab, start:…
    login: (on) => {
      if (!canLogin) return;
      app.setLoginItemSettings({ openAtLogin: !!on });
      login = !!on;
      refreshMenu(); // the File menu has it too
    },
    'default-browser': async () => { await defaultBrowser.makeDefault(win); askSystem(); },
    'downloads:folder': () => downloads.chooseFolder(win),
    'downloads:ask': (on) => downloads.setAsk(on),
    'tabs:vertical': (on) => setTabStrip({ vertical: !!on }),
    'bookmarks:bar': (on) => bookmarks.handle({ do: 'bar', show: !!on }),
    'sleep:minutes': (m) => sleep.setMinutes(Number(m)),
    'sleep:keep': (site) => { const host = hostOf(site); if (host) sleep.setKeepAwake(host, true); },
    'sleep:unkeep': (host) => sleep.setKeepAwake(String(host), false),
    search: (choice) => search.set(choice),
    'shields:allow': (site) => shields.allow(String(site)),
    'shields:update': () => shields.update(),
    'permission:forget': (which) => permissions.forget(which),
    'elsewhere:add': (site) => brave.add(site),
    'elsewhere:remove': (site) => brave.remove(site),
    'passwords:offer': (on) => passwords.setOffer(on),
    'passwords:unnever': (origin) => passwords.unnever(origin),
    // The Passwords panel is the main window's: seeing a password asks there.
    'passwords:open': () => {
      const w = tabs.normalWindow() || tabs.window();
      if (!w) return;
      tabs.as(w, () => passwords.showPanel());
      toMain(w);
    },
    'passwords:import': () => passwords.chooseImport(win),
    // key: only ever a new one; an empty key keeps the one saved (link.js).
    relay: ({ url, key, on } = {}) => link.configure({
      url: typeof url === 'string' ? url : link.state().url,
      key: typeof key === 'string' ? key : '',
      on: typeof on === 'boolean' ? on : link.state().on,
    }),
    'consent:revoke': (id) => consent.revoke(id),
    'guard:set': (on) => guardrails.set({ on: !!on }),
    'guard:site-add': (site) => guardrails.addSite(site),
    'guard:site-remove': (site) => guardrails.removeSite(site),
    'guard:forget': (which) => guardrails.forget(which),
    'guard:untrust': (id) => guardrails.untrust(id),
    'activity:keep': (days) => activity.keep(Number(days)),
    'activity:max': (mb) => activity.setMax(Number(mb)),
    'activity:clear': () => activity.clear(),
    socket: (on) => { settings.localSocket = !!on; save(); },
    reader: ({ key, value } = {}) => reader.setPref(`${key}=${value}`),
    'profile:open': () => { shell.openPath(home); },
    'update:check': () => updater.check(),
    'update:install': () => updater.install(),
    // In a tab of the user's, in a normal window (a new one if only private ones are open).
    releases: () => defaultBrowser.open([RELEASES]),
  };

  // Does it, then tells the page how things stand, changed or not, so the
  // page can say "Saved" or put a control back.
  async function act(what, arg) {
    if (!Object.hasOwn(acts, what)) return null;
    try { await acts[what](arg); } catch {}
    const now = state();
    sent = JSON.stringify(now);
    return now;
  }

  // Only the Settings window's own page is answered.
  const mine = (e) => live() && e.sender === win.webContents;
  const serve = (e, what, arg) => (mine(e) ? act(String(what), arg) : null);
  ipcMain.handle('settings:act', serve);
  ipcMain.on('settings:close', (e) => { if (mine(e)) win.close(); });

  // Where it was last time, if that is still on a screen.
  function bounds() {
    const size = { width: 980, height: 720 };
    const saved = settings.settingsWindow;
    if (!saved || ![saved.x, saved.y, saved.width, saved.height].every(Number.isFinite)) return size;
    const area = screen.getDisplayMatching(saved).workArea;
    const width = Math.min(saved.width, area.width);
    const height = Math.min(saved.height, area.height);
    return {
      width, height,
      x: Math.min(Math.max(saved.x, area.x), area.x + area.width - width),
      y: Math.min(Math.max(saved.y, area.y), area.y + area.height - height),
    };
  }
  function placed() {
    clearTimeout(placeTimer);
    placeTimer = setTimeout(() => {
      if (!live() || win.isMinimized() || win.isMaximized() || win.isFullScreen()) return;
      settings.settingsWindow = win.getBounds();
      save();
    }, 400);
  }

  const backdrop = () => (nativeTheme.shouldUseDarkColors ? '#101B22' : '#E6EDEF');

  // One window: asked for again, it comes to the front. section: one to show.
  function open(section) {
    const show = SECTIONS.includes(section) ? section : null;
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
      if (show) win.webContents.send('settings:show', show);
      return;
    }
    askSystem();
    win = new BrowserWindow({
      ...bounds(), minWidth: 640, minHeight: 420,
      title: 'Settings',
      icon: path.join(__dirname, '../ui/icon.png'),
      autoHideMenuBar: true,
      backgroundColor: backdrop(),
      webPreferences: {
        preload: path.join(__dirname, 'settings-preload.js'), sandbox: true, contextIsolation: true,
      },
    });
    win.setMenu(null);
    lockToApp(win.webContents);
    win.webContents.on('did-finish-load', () => {
      push(true);
      if (show) win.webContents.send('settings:show', show);
    });
    win.loadFile(path.join(__dirname, '../ui/settings.html'));
    win.on('focus', () => { askSystem(); push(); });
    win.on('move', placed);
    win.on('resize', placed);
    win.on('closed', () => {
      clearTimeout(placeTimer);
      win = null;
      sent = '';
    });
  }

  // Appearance changed (here, in the View menu, or by the system).
  nativeTheme.on('updated', () => {
    if (!live()) return;
    win.setBackgroundColor(backdrop());
    push();
  });

  // For the tests (LOUI_TEST only).
  const js = (code) => (live() ? win.webContents.executeJavaScript(code) : null);
  const probes = {
    'settings:open': (section) => { open(section); return 'ok'; },
    'settings:close': () => { win?.close(); return 'ok'; },
    // How many Settings windows there are, and what one would show.
    'settings:state': () => ({
      open: !!win,
      windows: BrowserWindow.getAllWindows().filter((w) => w.getTitle() === 'Settings').length,
      focused: live() && win.isFocused(),
      bounds: live() ? win.getBounds() : null,
      state: state(),
    }),
    // Runs a script in the window's page, as a click there would.
    'settings:js': (code) => js(code),
    'settings:url': () => (live() ? win.webContents.getURL() : null),
    'settings:key': ({ key, modifiers = [] } = {}) => {
      if (!live()) return null;
      for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: key, modifiers });
      return 'ok';
    },
    'settings:place': (b) => { win?.setBounds(b); return 'ok'; },
    // What the page would ask for, without the page (and so without a dialog to answer).
    'settings:act': ({ what, arg } = {}) => act(what, arg).then(() => { push(true); return 'ok'; }),
    'settings:folder': (dir) => { downloads.setFolder(dir); return 'ok'; },
    // A request for the window's channel from another page (the window chrome's):
    // what it is answered, which must be nothing.
    'settings:stranger': ({ what, arg } = {}) => serve({ sender: tabs.win.webContents }, what, arg),
  };

  return { open, changed: () => push(), probes, isOpen: () => !!win, webContents: () => (live() ? win.webContents : null) };
}

module.exports = { createSettingsWindow, hostOf };
