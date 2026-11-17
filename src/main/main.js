// Loui: a browser Claude drives alongside the user.
//
//   window chrome (src/ui)  <-- IPC -->  this file  <-- tabs.js: views, tab groups
//   Claude sessions anywhere --> relay --> link.js --> sessions.js --> actions.js --> the page
//   Claude panel (chat.js, Agent SDK) -----------------> sessions.js --> actions.js
//   tests --> rpc.js (local socket) -------------------> sessions.js --> actions.js
//
// Windows (see the note in tabs.js). There can be several, each with its own
// chrome; the modules below are made once and serve all of them. A request
// from a window's chrome, and the state drawn for it, run with that window as
// "the window being served" (tabs.as()), so code that asks for the tab on
// screen gets that window's. A second window costs a chrome renderer, and a
// private window an in-memory session; neither exists until the user opens one.
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, Menu, ipcMain, session, nativeTheme } = require('electron');
const paths = require('../shared/paths');
const { Tabs, PRESETS, toUrl, YOU } = require('./tabs');
const { createSessions } = require('./sessions');
const { createPrompts } = require('./prompts');
const { createConsent } = require('./consent');
const { createActions } = require('./actions');
const { createChat } = require('./chat');
const { createLink } = require('./link');
const { createUpdater } = require('./updater');
const { createRestore } = require('./restore');
const { createFind } = require('./find');
const { createDownloads } = require('./downloads');
const { createPermissions } = require('./permissions');
const { createHistory } = require('./history');
const { createSuggest } = require('./suggest');
const { createSleep } = require('./sleep');
const { createShields } = require('./shields');
const { createSearch } = require('./search');
const { createBrave } = require('./brave');
const { createPrint } = require('./print');
const { createBookmarks } = require('./bookmarks');
const { createErrorPage } = require('./errorpage');
const { createGuardrails } = require('./guardrails');
const { createCerts } = require('./certs');
const { createPasswords, createCipher } = require('./passwords');
const { createIdentity, HONEST } = require('./identity');
const { createTaskManager } = require('./taskmanager');
const { createActivity } = require('./activity');
const { createPip } = require('./pip');
const { createDefaultBrowser, urlsFrom } = require('./default-browser');
const { createReader } = require('./reader');
const { createPalette } = require('./palette');
const rpc = require('./rpc');

fs.mkdirSync(paths.home, { recursive: true, mode: 0o700 });
app.setPath('userData', paths.home);
// Loui's own pages (the window chrome, the suggestion list) carry the bridge to
// the main process, so they must never turn into a web page: dropping a link
// on the toolbar, for one, would otherwise navigate the chrome to it.
function lockToApp(wc) {
  wc.on('will-navigate', (e) => e.preventDefault());
  wc.on('will-redirect', (e) => e.preventDefault());
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
}

// Claude works in this window while it sits behind others. Without these a
// covered window stops rendering: clicks no longer land and screenshots fail.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion'); // Windows
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
// Sites that sniff for these tokens serve a broken page; the few that want
// the truth get it (identity.js).
const fullUserAgent = app.userAgentFallback;
app.userAgentFallback = fullUserAgent.replace(/ (loui|Electron)\/\S+/gi, '');

// Appearance: 'dark' (the default), 'light', or 'system' to follow the OS.
// It applies to the window and is what pages see as prefers-color-scheme.
const settingsFile = path.join(paths.home, 'settings.json');
const settings = (() => { try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { return {}; } })();
const saveSettings = () => fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
nativeTheme.themeSource = ['dark', 'light', 'system'].includes(settings.theme) ? settings.theme : 'dark';
function setTheme(theme) {
  nativeTheme.themeSource = theme;
  settings.theme = theme;
  saveSettings();
  Menu.setApplicationMenu(appMenu());
}

let tabs, sessions, actions, chat, link, handle, updater, restore, find, downloads, permissions, history, suggest, sleep;
let shields;
let search, brave, print;
let bookmarks;
let errorPage;
let prompts, consent;
let guardrails;
let certs;
let passwords;
let taskManager, defaultBrowser;
let reader;
let identity;
let activity;
let palette;
let pip;
let userSes;
// Links Loui was started with (from another app, when it is the default browser).
const launched = urlsFrom(process.argv, process.cwd());

// To the chrome of the window being served (see tabs.as()).
function send(channel, payload) {
  const w = tabs?.window();
  if (w && !w.win.isDestroyed()) w.win.webContents.send(channel, payload);
}

// To every window's chrome; with privateToo false, not to private windows
// (the Claude panel and its feed stay out of them).
function broadcast(channel, payload, privateToo = true) {
  for (const w of tabs?.windows || []) {
    if ((privateToo || !w.private) && !w.win.isDestroyed()) w.win.webContents.send(channel, payload);
  }
}

let stateQueued = false;
let flashedGuard = null; // the guardrail question whose window was last flashed
function pushState() {
  if (stateQueued) return;
  stateQueued = true;
  setImmediate(() => {
    stateQueued = false;
    syncMenu();
    for (const w of tabs.windows) {
      if (w.win.isDestroyed()) continue;
      const s = tabs.as(w, () => currentState(w));
      w.win.webContents.send('state', s);
      // A guardrail question about a tab in a window the user is not in: that
      // window's frame flashes, once, as for a session's other questions.
      if (s.guard && !s.guard.elsewhere && s.guard.id !== flashedGuard) {
        flashedGuard = s.guard.id;
        if (!w.win.isFocused()) w.win.flashFrame(true);
      }
    }
    pip?.changed(); // the small window watching a session shows its status too
  });
}

// Which window a question from a session shows in: "point at something" in
// the window with the session's tabs, the others in the window the user
// focused last.
function promptWindow() {
  const head = prompts.head();
  if (!head) return null;
  const g = head.kind === 'pick' ? tabs.group(head.session.group) : null;
  return (g && g.id !== YOU && g.window) || tabs.focused;
}

// What one window's chrome draws. Run inside tabs.as(w), so modules that
// report on "the tab on screen" report on w's.
const currentState = (w = tabs.window()) => {
  const asks = promptWindow() === w;
  return {
    window: { id: w.id, private: w.private, windows: tabs.windows.length, closing: w.closing ? lentPrivate(w) : null },
    tabs: tabs.summary(w),
    aimed: w.aim?.id ?? null, // a sleeping tab Ctrl+Tab is passing over (see cycle())
    working: tabs.groups.filter((g) => g.busy > 0).length, // in every window: "Restart to update" asks first
    groups: tabs.groups.filter((g) => g.id === YOU || g.window === w).map((g) => ({
      id: g.id, label: g.label, source: g.source, busy: g.busy > 0, status: g.status, paused: g.paused,
    })),
    asking: asks ? sessions.asking() : null,
    ...(asks ? prompts.state() : { prompt: null, waiting: [] }),
    ...consent.state(),
    picking: actions.picker.state(),
    picks: w.private ? [] : actions.picker.recent().filter((p) => p.group === YOU)
      .map((p) => ({ id: p.id, name: p.name || p.tag, thumb: p.thumb })),
    link: link.state(),
    update: updater.state(),
    find: find.state(),
    downloads: downloads.state(),
    ...permissions.state(),
    ...shields.state(),
    ...search.state(),
    ...brave.state(),
    ...bookmarks.state(),
    tabStrip: tabStrip(),
    ...guardrails.state(),
    ...passwords.state(),
    ...reader.state(),
    ...certs.state(),
  };
};

// The private tabs of w's session that Claude sessions hold (the user handed
// them over). They close with the last private window, so closing it asks
// first: { tabs, who } or null.
function lentPrivate(w) {
  const lent = tabs.list.filter((t) => t.ses === w.ses && t.group !== YOU);
  if (!w.private || !lent.length || tabs.windows.some((x) => x !== w && x.ses === w.ses)) return null;
  return { tabs: lent.length, who: [...new Set(lent.map((t) => tabs.group(t.group)?.label || 'a Claude session'))] };
}
let quitting = false;

// Where the tabs are: a strip along the top (the default) or a sidebar on the
// left, which can be collapsed to icons. Both kept in settings.json.
const tabStrip = () => ({ vertical: settings.verticalTabs === true, collapsed: settings.sidebarCollapsed === true });
function setTabStrip({ vertical, collapsed } = {}) {
  if (typeof vertical === 'boolean') settings.verticalTabs = vertical;
  if (typeof collapsed === 'boolean') settings.sidebarCollapsed = collapsed;
  saveSettings();
  pushState();
  Menu.setApplicationMenu(appMenu());
}

// ── private windows ──────────────────────────────────────────────────────────
// The private windows open at one time share one session kept in memory only
// (a partition without the persist: prefix): no cookies, cache or storage on
// disk. When the last one closes its data is cleared, and the next private
// window gets a new session, so nothing carries over.
let privateSes = null;
let privateCount = 0;
// A new session each time: one used before keeps more than can be cleared
// from here (the zoom chosen for a site, for one), and nothing may carry over
// from one round of private windows to the next. Electron keeps the old one,
// emptied, until Loui quits.
function privateSession() {
  if (privateSes) return privateSes;
  const ses = session.fromPartition(`loui-private-${++privateCount}`);
  // The same watchers as the user's session, in the same order: the relay
  // guard first (tabs.js), then Shields, and the guardrails' hold last.
  tabs.watchNetwork(ses);
  shields.attach(ses);
  downloads.attach(ses, { private: true });
  permissions.attach(ses);
  sleep.attach(ses);
  guardrails.attach(ses);
  errorPage.attach(ses);
  certs.attach(ses);
  reader.attach(ses);
  identity.attach(ses);
  privateSes = ses;
  return ses;
}
function endPrivate(ses) {
  if (privateSes === ses) privateSes = null;
  certs.forget(ses);
  downloads.forgetPrivate();
  shields.forgetPrivate();
  ses.clearStorageData().catch(() => {});
  ses.clearCache().catch(() => {});
  ses.clearAuthCache().catch(() => {});
  ses.closeAllConnections().catch(() => {});
}

// ── windows ─────────────────────────────────────────────────────────────────
let firstWindow = true;
// private: a private window. blank: with a new tab of the user's (otherwise
// the caller fills it). at: a point on screen to open it at (a tab dragged out).
function openWindow({ private: priv = false, blank = true, at } = {}) {
  const win = new BrowserWindow({
    width: 1440,
    height: 940,
    ...(at ? { x: Math.round(at.x - 120), y: Math.round(at.y - 20) } : {}),
    minWidth: 720,
    minHeight: 480,
    title: priv ? 'Loui · Private' : 'Loui',
    icon: path.join(__dirname, '../ui/icon.png'),
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#101B22' : '#E6EDEF',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), sandbox: true, contextIsolation: true,
      backgroundThrottling: false,
    },
  });
  lockToApp(win.webContents);
  const w = tabs.addWindow(win, { private: priv, ses: priv ? privateSession() : userSes });
  const first = firstWindow;
  firstWindow = false;

  win.on('close', (e) => {
    // The last private window, while a Claude session holds a tab of it: the
    // tab would close under the session, so the window asks first (in its chrome).
    if (!quitting && !w.sure && lentPrivate(w)) {
      e.preventDefault();
      w.closing = true;
      win.focus();
      return pushState();
    }
    if (tabs.windows.length === 1) restore?.stop(); // the last window: written as when quitting
    tabs.removeWindow(w);
    if (priv && !tabs.windows.some((x) => x.ses === w.ses)) endPrivate(w.ses);
    pushState();
    Menu.setApplicationMenu(appMenu());
  });
  win.on('closed', () => { if (!tabs.windows.length) app.quit(); }); // closing the last window quits, as always
  win.webContents.on('did-finish-load', () => {
    tabs.emit('chrome-loaded', w);
    pushState();
    if (first) setTimeout(serve, 10000); // last resort: the window reports its layout as soon as its script runs
    else if (blank) win.webContents.send('focus-address'); // Ctrl+N: ready to type, as a new tab is
  });
  if (process.env.LOUI_DEBUG) {
    win.webContents.on('console-message', (e) => console.error('[ui]', e.message, `(${e.sourceId}:${e.lineNumber})`));
  }
  win.loadFile(path.join(__dirname, '../ui/index.html'));
  if (blank) tabs.create('', { window: w, show: true });
  if (!first) Menu.setApplicationMenu(appMenu());
  return w;
}

// The window whose bounds hold a point on screen (where a dragged tab was let go).
const windowAt = ({ x, y }) => tabs.windows.find((w) => {
  if (w.win.isDestroyed() || w.win.isMinimized()) return false;
  const b = w.win.getBounds();
  return x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height;
});

// A tab (or a session's group) dragged out of the tab strip and let go at a
// point on screen: into the window there, or a new window at that point.
function detach({ id, group, x, y } = {}) {
  const tab = tabs.get(id);
  const groupId = group || (tab && tab.group !== YOU ? tab.group : null);
  const from = groupId ? tabs.group(groupId)?.window : tab?.window;
  if (!from || !Number.isFinite(x) || !Number.isFinite(y)) return;
  const there = windowAt({ x, y });
  if (there === from) return;
  if (groupId) {
    if (there) return tabs.groupToWindow(groupId, there);
    return tabs.groupToWindow(groupId, openWindow({ at: { x, y } }));
  }
  if (there) return tabs.toWindow(id, there);
  tabs.toWindow(id, openWindow({ private: tab.private, blank: false, at: { x, y } }));
}

function start() {
  userSes = session.fromPartition('persist:loui');
  search = createSearch({ settings, save: saveSettings, changed: pushState });
  tabs = new Tabs(userSes);
  identity = createIdentity({
    tabs, full: fullUserAgent, plain: app.userAgentFallback,
    hosts: process.env.LOUI_TEST && process.env.LOUI_HONEST_HOSTS ? process.env.LOUI_HONEST_HOSTS.split(',') : HONEST,
  });
  identity.attach(userSes);
  // Tabs' icons, for the window chrome's <img> (tabs.icon): bytes held in memory, never from the web.
  session.defaultSession.protocol.handle('loui-icon', (request) => tabs.iconResponse(request.url));
  tabs.openWindow = openWindow;
  const first = openWindow({ blank: false });
  shields = createShields({ ses: userSes, tabs, home: paths.home, changed: pushState }); // after Tabs: the relay guard is asked first
  brave = createBrave({ tabs, settings, save: saveSettings, changed: pushState });
  print = createPrint({ win: () => tabs.win, active: () => tabs.active() });
  restore = createRestore({ tabs, file: path.join(paths.home, 'tabs.json'), openWindow: () => openWindow({ blank: false }) });
  downloads = createDownloads({ ses: userSes, tabs, home: paths.home, changed: pushState });
  permissions = createPermissions({ ses: userSes, tabs, home: paths.home, changed: pushState });
  sleep = createSleep({
    tabs, ses: userSes, settings, permissions, save: () => fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2)),
  });
  history = createHistory({ file: path.join(paths.home, 'history.json'), tabs, changed: () => broadcast('history:changed') });
  suggest = createSuggest({
    win: first.win, tabs, send, sources: [history],
    engine: () => { const s = search.state().search; return s.engines.find((e) => e.id === s.engine)?.label || ''; },
  });
  certs = createCerts({ tabs, changed: pushState });
  errorPage = createErrorPage({ tabs, file: path.join(paths.home, 'game.json'), certs });
  errorPage.attach(userSes);
  certs.attach(userSes);
  lockToApp(suggest.webContents);
  bookmarks = createBookmarks({ file: path.join(paths.home, 'bookmarks.json'), tabs, ses: userSes, send, broadcast, changed: pushState });
  suggest.add(bookmarks);
  passwords = createPasswords({ tabs, home: paths.home, send, changed: pushState });
  prompts = createPrompts({
    changed: () => {
      pushState();
      const win = prompts.head() && promptWindow()?.win;
      if (win && !win.isDestroyed() && !win.isFocused()) win.flashFrame(true);
    },
  });
  reader = createReader({ tabs, ses: userSes, settings, save: saveSettings, changed: pushState });
  activity = createActivity({
    dir: path.join(paths.home, 'activity'), tabs, settings, save: saveSettings,
    changed: (ids) => broadcast('activity', { type: 'changed', ids }, false),
    cipher: createCipher(),
  });
  consent = createConsent({ file: path.join(paths.home, 'consent.json'), prompts, changed: pushState, decided: activity.consent });
  sessions = createSessions({
    tabs, changed: pushState, feed: (entry) => broadcast('feed', entry, false), prompts, ended: (id) => consent.forget(id), activity,
  });
  guardrails = createGuardrails({ ses: userSes, tabs, sessions, home: paths.home, changed: pushState, asked: activity.guard });
  actions = createActions({ tabs, sessions, prompts, changed: pushState, refuse: brave.refuse, guard: guardrails });
  find = createFind({ tabs, changed: pushState, focus: () => { tabs.win?.webContents.focus(); send('focus-find'); } });
  handle = rpc.createHandler({ run: actions.run, sessions, admit: consent.admit, extra: process.env.LOUI_TEST ? testHook : null });
  link = createLink({
    home: paths.home, version: app.getVersion(), handle, sessions, changed: pushState,
    guard: (origins) => { tabs.relayOrigins = new Set(origins); },
    cipher: createCipher(),
  });
  let shown = '';
  updater = createUpdater({
    changed: () => {
      pushState();
      // The menu names the status (and progress in tens of percent); progress events come many times a second.
      const u = updater.state();
      const now = `${u.status}:${Math.floor(u.percent / 10)}`;
      if (now !== shown) { shown = now; Menu.setApplicationMenu(appMenu()); }
    },
  });
  chat = createChat({
    run: (name, args) => actions.run(name, args, sessions.panel),
    tabs,
    picker: actions.picker,
    describePick: actions.describePick,
    cwd: paths.home,
    emit: (event) => broadcast('chat', event, false),
  });

  palette = createPalette({
    win: first.win, tabs, settings, save: saveSettings, sources: { bookmarks, history },
    // Shields has no menu item of its own (its menu is the toolbar's).
    extras: () => {
      const s = shields.state().shields;
      return s ? [{ label: `Turn Shields ${s.on ? 'off' : 'on'} for ${s.site}`, click: () => shields.set({ site: s.site, on: !s.on }) }] : [];
    },
    ask: (text) => { send('toggle-panel', true); chat.send({ text }); },
    busy: () => chat.busy(),
  });
  lockToApp(palette.webContents);

  taskManager = createTaskManager({
    tabs, sleep, lockToApp,
    pages: () => [
      ...tabs.windows.map((w, i) => ({
        label: w.private ? 'Private window chrome' : tabs.windows.length > 1 ? `Window chrome ${i + 1}` : 'Window chrome',
        wc: w.win.webContents,
      })),
      { label: 'Address suggestions', wc: suggest.webContents },
      { label: 'Command palette', wc: palette.webContents },
    ],
    claude: () => chat.process(),
    focusMain: (tab) => {
      const win = (tab?.window || tabs.window())?.win;
      if (!win || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.focus();
    },
  });
  defaultBrowser = createDefaultBrowser({ getWin: () => (tabs.normalWindow() || tabs.window())?.win, tabs });
  pip = createPip({
    tabs, settings, save: saveSettings, lockToApp,
    pause: (group, on) => handlers.pause({ group, on }),
    focusMain: (tab) => {
      const win = (tab?.window || tabs.normalWindow() || tabs.window())?.win;
      if (!win || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.focus();
    },
  });

  tabs.on('change', pushState);
  tabs.on('focus', pushState); // questions follow the window the user is in
  tabs.on('end-session', (id) => handlers['group:end'](id)); // "End session" in a group's menu
  // A session's group is paused and let go on from its menu, whichever tab is on screen.
  tabs.on('group-menu', (g, items) => items.unshift(
    { label: g.paused ? 'Let Claude continue' : 'Take over', click: () => handlers.pause({ group: g.id, on: !g.paused }) },
    { type: 'separator' },
  ));
  tabs.on('point', (tab, point) => actions.picker.at(tab, point));
  // From a tab's menu and the page's.
  tabs.on('bookmark-tab', (tab) => tabs.as(tab.window, () => { tabs.select(tab.id); bookmarks.handle({ do: 'star' }); }));
  tabs.on('reopen-closed', (w) => tabs.as(w, () => restore.reopenClosed()));
  tabs.on('print', (tab) => tabs.as(tab.window, () => print.print()));
  tabs.on('open-window', ({ url, private: priv }) => tabs.create(url, { window: openWindow({ private: !!priv, blank: false }), show: true }));
  // A window left without tabs (its last one moved away) closes.
  tabs.on('empty', (w) => setImmediate(() => { if (!w.win.isDestroyed()) w.win.close(); }));
  // "Move to new window" in a tab's menu, for a tab or a session's group.
  tabs.on('to-new-window', ({ tab, group }) => {
    if (group) tabs.groupToWindow(group, openWindow());
    else if (tab && tabs.get(tab.id)) tabs.toWindow(tab.id, openWindow({ private: tab.private, blank: false }));
  });

  if (!restore.reopenSaved(first) && !launched.length) tabs.create(process.env.LOUI_START_URL || '', { show: true, window: first });
  if (launched.length) defaultBrowser.open(launched);
}

// ── requests from the window chrome ─────────────────────────────────────────
// Each runs with its window as the window being served (see the bottom).
const active = () => tabs.active();

let serving = false;
// Sessions are let in once the page area has its real size (or, if the window
// never reports one, a few seconds after it loads).
function serve() {
  if (serving) return;
  serving = true;
  if (process.env.LOUI_TEST || settings.localSocket === true) rpc.serve(paths.socketPath, handle, sessions);
  link.connect();
}
const handlers = {
  layout: (area) => {
    tabs.setArea(area);
    serve();
  },
  'tab:new': (url) => { tabs.create(url || '', { show: true }); if (!url) send('focus-address'); },
  'tab:select': (id) => {
    const w = tabs.window();
    clearTimeout(w?.aim?.timer); // a tab chosen by hand: Ctrl+Tab's aim (see cycle()) is off
    if (w) w.aim = null;
    tabs.select(id);
  },
  // "Switch to tab" in the address bar's suggestions: one of the user's own tabs, in whichever
  // window of the same kind it is (a private window's tabs stay among private windows).
  'tab:reveal': (id) => { const t = tabs.get(id); if (t && t.group === YOU && t.ses === tabs.window()?.ses) tabs.reveal(id); },
  'tab:close': (id) => tabs.close(id),
  'tab:reopen': () => restore.reopenClosed(),
  'tab:menu': (id) => tabs.tabMenu(id),
  // Ctrl+W. A pinned tab stays: Ctrl+W does nothing on it, as in Brave; its menu still closes it.
  // A session's tab is not closed under a session at work, and otherwise its × asks first.
  'tab:close-active': () => {
    const tab = active();
    if (!tab || tab.pinned) return;
    if (tab.group === YOU) return tabs.close(tab.id);
    const g = tabs.group(tab.group);
    if (g.busy > 0 && !g.paused) return;
    send('tab:ask-close', tab.id);
  },
  // The keyboard goes back to the page: a panel or strip closed, or Esc in the address bar.
  'page:focus': () => active()?.wc?.focus(),
  'panel:shown': (on) => { const w = tabs.window(); if (w) w.panelShown = !!on; syncMenu(); },
  'tab:nudge': (step) => active() && tabs.nudge(active().id, step), // Ctrl+Shift+PageUp/PageDown
  'tab:move': ({ id, group, index, pinned } = {}) => tabs.drop(id, group, index, { pinned }), // dragged in the tab strip
  'tab:pin': ({ id, on } = {}) => tabs.pin(id, on),
  'tab:detach': (where) => detach(where), // dragged out of the tab strip
  'group:detach': (where) => detach(where),
  'group:menu': (id) => tabs.groupMenu(id),
  'window:new': (choice) => openWindow({ private: !!choice?.private }),
  'window:close': () => tabs.win?.close(),
  // The answer to "close this private window, and the tabs lent from it?" (see openWindow).
  'window:close-answer': (yes) => {
    const w = tabs.window();
    if (!w?.closing) return;
    w.closing = false;
    if (yes) { w.sure = true; w.win.close(); } else pushState();
  },
  'tabs:layout': (choice) => setTabStrip(choice),
  go: (input) => { active()?.wc.loadURL(toUrl(input)).catch(() => {}); active()?.wc.focus(); },
  back: () => active()?.wc.navigationHistory.goBack(),
  forward: () => active()?.wc.navigationHistory.goForward(),
  reload: () => { const wc = active()?.wc; if (wc?.isLoading()) wc.stop(); else wc?.reload(); },
  devtools: () => active()?.wc.toggleDevTools(),
  'pick:start': () => { const tab = active(); if (tab && !(tab.private && tab.group === YOU)) actions.picker.start(tab); },
  'pick:cancel': () => actions.picker.cancel(),
  'pick:remove': (id) => actions.picker.remove(id),
  // Take over, or hand back, the session working in a tab group.
  pause: ({ group, on }) => { const g = tabs.group(group); if (g) g.paused = !!on; pushState(); },
  'handoff:answer': (yes) => sessions.answer(!!yes),
  // A question from a Claude session (prompts.js): value is what the user chose.
  'prompt:answer': ({ id, value }) => prompts.answer(id, value),
  'prompt:next': () => prompts.next(), // "N more" in the helm: the next waiting question
  'consent:revoke': (id) => consent.revoke(id),
  'group:close': (id) => sessions.end(id, 'closed'),
  // "End session" in a group's menu: its window's chrome ends it, asking first where the × would.
  'group:end': (id) => { const w = tabs.group(id)?.window; if (w) tabs.as(w, () => send('group:end', id)); },
  'pip:open': (id) => pip.open(id), // watch a session in a small window
  'device:menu': () => deviceMenu(),
  'device:reset': () => { const tab = active(); if (tab?.wc && tab.device) tabs.setDevice(tab, null); }, // back to the full window
  'relay:set': (settings) => link.configure(settings),
  'update:install': () => updater.install(),
  'chat:send': (message) => { chat.send(message); },
  'chat:stop': () => chat.stop(),
  'chat:reset': () => chat.reset(),
  'find:open': () => find.show(),
  // Closed by the user: the page they were reading takes the keyboard back.
  'find:close': () => { find.close(); active()?.wc.focus(); },
  find: (query) => find.search(query),
  'download:act': (request) => downloads.act(request),
  'download:ask': (on) => downloads.setAsk(on),
  'download:clear': () => downloads.clear(),
  'permission:answer': (answer) => permissions.answer(answer),
  'permission:forget': (which) => permissions.forget(which),
  'suggest:query': (text) => suggest.query(text),
  'suggest:show': (shown) => suggest.show(shown),
  'suggest:hide': () => suggest.hide(),
  'suggest:pick': (url) => send('suggest:pick', url), // a click in the list, handled like Enter
  'history:list': (query) => send('history', { query, items: history.list(query) }),
  'history:remove': (url) => history.remove(url),
  'history:clear': () => history.clear(),
  'shields:menu': () => shields.menu(),
  'shields:set': (choice) => shields.set(choice),
  print: () => print.print(),
  'print:save-pdf': () => print.savePdf(),
  'search:set': (choice) => search.set(choice),
  'brave:open': () => brave.open(active()?.url),
  'brave:add': (site) => brave.add(site),
  'brave:remove': (site) => brave.remove(site),
  bookmarks: (request) => bookmarks.handle(request),
  'guard:answer': (answer) => guardrails.answer(answer),
  'guard:show': (id) => guardrails.show(id),
  'guard:set': (choice) => guardrails.set(choice),
  'guard:site-add': (site) => guardrails.addSite(site),
  'guard:site-remove': (site) => guardrails.removeSite(site),
  'guard:forget': (which) => guardrails.forget(which),
  'guard:untrust': (id) => guardrails.untrust(id),
  passwords: (request) => passwords.handle(request),
  'reader:toggle': () => reader.toggle(),
  activity: (request) => activityRequest(request),
};

// The Sessions panel (src/ui/activity.js). Only the window chrome reaches
// the activity log: no tool reads it.
async function activityRequest({ do: what, id, url, days, have } = {}) {
  // The answer goes to the window that asked, which an await would forget (tabs.as()).
  const w = tabs.window();
  const reply = (payload) => tabs.as(w, () => send('activity', payload));
  // A session still connected: working, paused by the user, or just open.
  const status = (s) => {
    const g = s?.live && tabs.group(s.session);
    if (g) s.status = g.paused ? 'paused' : g.busy > 0 ? 'working' : 'open';
    return s;
  };
  if (what === 'list') {
    const got = await activity.list();
    got.items.forEach(status);
    reply({ type: 'list', ...got });
  } else if (what === 'open') reply({ type: 'session', id, log: status(await activity.get(id, have)) });
  // "Show tabs" on a live session (id: the session's): its current tab, in the window its group is in.
  else if (what === 'show') {
    const g = id !== YOU && tabs.group(id);
    const tab = g && (tabs.get(g.current) || tabs.in(id)[0]);
    if (!tab) return;
    tabs.reveal(tab.id);
  }
  else if (what === 'delete') await activity.remove(id);
  else if (what === 'clear') await activity.clear();
  else if (what === 'keep') activity.keep(days);
  // A page a session visited opens in a new tab of the user's own.
  else if (what === 'visit' && /^https?:\/\//i.test(url || '')) tabs.create(url, { show: true });
}

// For the tests: every window, as the window chrome cannot see the others.
const describeWindows = () => tabs.windows.map((w) => ({
  id: w.id, private: w.private, focused: tabs.focused === w, active: w.activeId,
  tabs: tabs.list.filter((t) => t.window === w).map((t) => t.id),
  groups: tabs.groups.filter((g) => g.id !== YOU && g.window === w).map((g) => g.id),
}));
const windowById = (id) => tabs.windows.find((w) => w.id === id) || null;

// Lets the test suite do what only the window chrome can (allow a hand-over,
// take over a group) and read the window's state. Off unless LOUI_TEST is set.
async function testHook({ ui, arg }) {
  if (ui === 'state') return { ...currentState(), windows: describeWindows() };
  // Runs another hook with a given window as the one being served, as its chrome would.
  if (ui === 'in-window') return tabs.as(windowById(arg.window), () => testHook({ ui: arg.ui, arg: arg.arg }));
  if (ui === 'windows') return describeWindows();
  if (ui === 'window:new') return openWindow({ private: !!arg?.private }).id;
  if (ui === 'window:focus') { tabs.focus(windowById(arg)); return 'ok'; }
  if (ui === 'window:close') { windowById(arg)?.win.close(); return 'ok'; }
  if (ui === 'tab:to-window') { tabs.toWindow(arg.id, windowById(arg.window)); return 'ok'; }
  if (ui === 'group:to-window') { tabs.groupToWindow(arg.group, windowById(arg.window)); return 'ok'; }
  if (ui === 'to-new-window') { tabs.emit('to-new-window', { tab: tabs.get(arg.id), group: arg.group }); return 'ok'; }
  if (suggest.probes[ui]) return suggest.probes[ui](arg);
  // The items of a session group's right-click menu; with click set, chooses the one so named.
  if (ui === 'group:menu-items') {
    const items = [];
    tabs.emit('group-menu', tabs.group(arg.group), items);
    if (arg.click) items.find((i) => i.label === arg.click)?.click();
    return items.map((i) => i.label).filter(Boolean);
  }
  // The items of a tab's right-click menu in the tab strip, and of a page's (p: what
  // was clicked, as Electron describes it); with click set, chooses the one so named.
  if (ui === 'tab:menu-items' || ui === 'page:menu-items') {
    const tab = tabs.get(arg.id);
    const items = ui === 'tab:menu-items' ? tabs.tabMenuItems(arg.id) : tabs.pageMenuItems(tab, { x: 5, y: 5, ...arg.p });
    if (arg.click) items.find((i) => i.label === arg.click)?.click();
    return items.map((i) => (i.type === 'separator' ? '-' : i.label || i.role));
  }
  // The application menu as it reads: each menu's name and the items listed in it.
  if (ui === 'menu') {
    return Menu.getApplicationMenu().items.map((m) => [
      m.label, m.submenu.items.filter((i) => i.visible).map((i) => (i.type === 'separator' ? '-' : i.label)),
    ]);
  }
  // An item of the application menu, by its id.
  if (ui === 'menu:item') {
    const item = Menu.getApplicationMenu().getMenuItemById(arg);
    return item && { label: item.label, checked: item.checked, enabled: item.enabled };
  }
  if (ui === 'tab:crash') { tabs.get(arg)?.wc?.forcefullyCrashRenderer(); return 'ok'; } // as a page's process dying
  // A real press of the mouse in a tab's page, at a point in it, as the user's own.
  if (ui === 'tab:press') {
    const wc = tabs.get(arg.id)?.wc;
    for (const type of ['mouseDown', 'mouseUp']) wc?.sendInputEvent({ type, x: arg.x, y: arg.y, button: 'left', clickCount: 1 });
    return 'ok';
  }
  if (ui === 'tab:sleep') return sleep.sleepNow(arg); // as "Sleep this tab now" in the tab menu
  // Runs a script in any tab's page, which the tools only allow in a session's own tabs.
  // acted: as if the user had just clicked or typed in the tab (a page may then open a tab).
  if (ui === 'tab:js') {
    const tab = tabs.get(arg.id);
    if (tab && arg.acted) tab.actedAt = Date.now();
    return tab?.wc?.executeJavaScript(arg.code);
  }
  // Memory in use by all of Loui's processes, in KB, and how many there are.
  if (ui === 'memory') {
    const metrics = app.getAppMetrics();
    return { kb: metrics.reduce((sum, m) => sum + m.memory.workingSetSize, 0), processes: metrics.length };
  }
  if (brave.probes[ui]) return brave.probes[ui](arg);
  if (print.probes[ui]) return print.probes[ui](arg);
  if (ui === 'to-url') return toUrl(arg);
  // A tool call from the Claude panel, which works in the user's own tabs.
  if (ui === 'panel') return actions.run(arg.tool, arg.args || {}, sessions.panel);
  if (bookmarks.probes[ui]) return bookmarks.probes[ui](arg);
  if (passwords.probes[ui]) return passwords.probes[ui](arg);
  if (taskManager.probes[ui]) return taskManager.probes[ui](arg);
  if (reader.probes[ui]) return reader.probes[ui](arg);
  if (activity.probes[ui]) return activity.probes[ui](arg);
  if (palette.probes[ui]) return palette.probes[ui](arg);
  if (pip.probes[ui]) return pip.probes[ui](arg);
  // The next failed page reads as the network being down (the tests can't unplug it).
  if (ui === 'pretend-offline') { errorPage.pretend(-106, 'ERR_INTERNET_DISCONNECTED'); return 'ok'; }
  // A page trying to take over the window chrome, as a dropped link would.
  if (ui === 'chrome-navigate') {
    const chrome = tabs.win.webContents;
    await chrome.executeJavaScript(`location.href = ${JSON.stringify(arg)}`).catch(() => {});
    await new Promise((r) => setTimeout(r, 500));
    return chrome.getURL();
  }
  handlers[ui](arg);
  return 'ok';
}

function deviceMenu() {
  const tab = active();
  if (!tab) return;
  const item = (label, device, checked) => ({
    label, type: 'radio', checked, click: () => tabs.setDevice(tab, device),
  });
  Menu.buildFromTemplate([
    item('Full window', null, !tab.device),
    ...Object.entries(PRESETS).map(([key, p]) =>
      item(`${p.label}  ${p.width}×${p.height}`, key, tab.device === p)),
  ]).popup({ window: tab.window.win });
}

// Menu items act in the window they were chosen in.
function inWindow(items) {
  return items.map((i) => ({
    ...i,
    ...(i.click ? { click: (item, win, e) => tabs.as(tabs.windows.find((w) => w.win === win), () => i.click(item, win, e)) } : {}),
    ...(Array.isArray(i.submenu) ? { submenu: inWindow(i.submenu) } : {}),
  }));
}

// Ctrl+Tab and Ctrl+Shift+Tab: the next of the user's own tabs in this window
// (from a session's tab, the next in that session's group). A sleeping tab is
// only aimed at, shown as such in the tab strip, and wakes if the user stays
// on it for a moment: holding Ctrl and pressing Tab past several sleeping
// tabs loads none of them but the one it stops on.
const AIM_MS = 350;
// The tab the keyboard chose is shown, and its page has the keyboard.
const land = (id) => tabs.select(id)?.wc?.focus();
function cycle(step) {
  const w = tabs.window();
  const from = tabs.get(w?.aim?.id) || active();
  if (!from) return;
  const peers = tabs.in(from.group).filter((t) => t.window === w);
  const next = peers[(peers.indexOf(from) + step + peers.length) % peers.length];
  clearTimeout(w.aim?.timer);
  w.aim = null;
  if (!next || next === active()) return pushState();
  if (!next.asleep) return land(next.id);
  w.aim = { id: next.id, timer: setTimeout(() => { w.aim = null; land(next.id); }, AIM_MS) };
  pushState();
}
// Ctrl+1 to Ctrl+8: the nth of the user's own tabs in this window; Ctrl+9: the last.
function nthTab(n) {
  const mine = tabs.in(YOU).filter((t) => t.window === tabs.window());
  const tab = n === 9 ? mine[mine.length - 1] : mine[n - 1];
  if (tab) land(tab.id);
}

// The application menu's checkbox items follow the window the user is in:
// what they toggle also changes from the toolbar, a tab's menu and the helm.
function syncMenu(menu = Menu.getApplicationMenu()) {
  if (!menu || !tabs?.focused) return;
  tabs.as(tabs.focused, () => {
    const tab = active();
    const set = (id, checked, enabled = true) => {
      const item = menu.getMenuItemById(id);
      if (item) { item.checked = !!checked; item.enabled = enabled; }
    };
    set('pin-tab', tab?.pinned, tab?.group === YOU);
    set('take-over', tabs.group(tab?.group)?.paused);
    set('claude-panel', tabs.focused.panelShown !== false, !tabs.focused.private);
    set('bookmarks-bar', bookmarks?.barShown());
  });
}

function appMenu() {
  const togglePause = () => {
    const g = tabs.group(active()?.group);
    if (g) handlers.pause({ group: g.id, on: !g.paused });
  };
  // To the window chrome, which takes the keyboard for what it then shows.
  const show = (channel, arg) => () => { tabs.win.webContents.focus(); send(channel, arg); };
  // A second shortcut for a command: not listed (nor in the command palette), but its keys work.
  const also = (accelerator, click) => ({ label: accelerator, accelerator, visible: false, click });
  const menu = Menu.buildFromTemplate(inWindow([
    {
      label: 'File',
      submenu: [
        { label: 'New tab', accelerator: 'CmdOrCtrl+T', click: () => handlers['tab:new']() },
        { label: 'New window', accelerator: 'CmdOrCtrl+N', click: () => openWindow() },
        { label: 'New private window', accelerator: 'CmdOrCtrl+Shift+N', click: () => openWindow({ private: true }) },
        { type: 'separator' },
        { label: 'Print…', accelerator: 'CmdOrCtrl+P', click: handlers.print },
        { label: 'Save as PDF…', click: handlers['print:save-pdf'] },
        { label: `Open in ${brave?.name() || 'Brave'}`, click: handlers['brave:open'] },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: show('show-settings') },
        ...defaultBrowser.menuItems(),
        ...(process.platform === 'linux' ? [] : [{
          label: 'Open Loui when I sign in', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin,
          click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
        }]),
        { type: 'separator' },
        { label: 'Close tab', accelerator: 'CmdOrCtrl+W', click: handlers['tab:close-active'] },
        { label: 'Close window', accelerator: 'CmdOrCtrl+Shift+W', click: handlers['window:close'] },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'pasteAndMatchStyle', label: 'Paste as plain text' },
        { role: 'delete' }, { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find in page', accelerator: 'CmdOrCtrl+F', click: () => handlers['find:open']() },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => active()?.wc.reload() },
        also('F5', () => active()?.wc.reload()),
        { label: 'Reload without the cache', accelerator: 'CmdOrCtrl+Shift+R', click: () => active()?.wc.reloadIgnoringCache() },
        { type: 'separator' },
        { label: 'Zoom in', accelerator: 'CmdOrCtrl+=', click: () => zoom(0.1) },
        { label: 'Zoom out', accelerator: 'CmdOrCtrl+-', click: () => zoom(-0.1) },
        { label: 'Actual size', accelerator: 'CmdOrCtrl+0', click: () => zoom(0) },
        { label: 'Full screen', accelerator: 'F11', click: () => tabs.win.setFullScreen(!tabs.win.isFullScreen()) },
        { label: 'Reader view', accelerator: 'F9', click: handlers['reader:toggle'] },
        { type: 'separator' },
        {
          label: 'Vertical tabs', type: 'checkbox', checked: tabStrip().vertical,
          click: (item) => setTabStrip({ vertical: item.checked }),
        },
        {
          label: 'Appearance',
          submenu: [['dark', 'Dark'], ['light', 'Light'], ['system', 'Match system']].map(([theme, label]) => ({
            label, type: 'radio', checked: nativeTheme.themeSource === theme, click: () => setTheme(theme),
          })),
        },
        { type: 'separator' },
        { label: 'Downloads', accelerator: 'CmdOrCtrl+J', click: show('toggle-downloads') },
        ...passwords.fileMenu(),
        { label: 'Site permissions…', click: show('show-permissions') },
        { type: 'separator' },
        { label: 'Task manager', accelerator: 'Shift+Esc', click: () => taskManager.open() },
        { label: 'Developer tools', accelerator: 'F12', click: handlers.devtools },
      ],
    },
    {
      label: 'History',
      submenu: [
        { label: 'Back', accelerator: 'Alt+Left', click: handlers.back },
        { label: 'Forward', accelerator: 'Alt+Right', click: handlers.forward },
        { type: 'separator' },
        { label: 'History', accelerator: 'CmdOrCtrl+H', click: show('show-history') },
        { label: 'Clear history…', accelerator: 'CmdOrCtrl+Shift+Delete', click: show('show-history', 'clear') },
        { type: 'separator' },
        { label: 'Reopen closed tab', accelerator: 'CmdOrCtrl+Shift+T', click: handlers['tab:reopen'] },
      ],
    },
    { label: 'Bookmarks', submenu: bookmarks.menuItems() },
    {
      label: 'Tab',
      submenu: [
        { label: 'Go to address', accelerator: 'CmdOrCtrl+L', click: show('focus-address') },
        also('Alt+D', show('focus-address')),
        also('F6', show('focus-address')),
        { label: 'Command palette…', id: 'palette', accelerator: 'CmdOrCtrl+K', click: () => palette.show() },
        { label: 'Search tabs…', id: 'palette-tabs', accelerator: 'CmdOrCtrl+Shift+A', click: () => palette.show('tabs') },
        { type: 'separator' },
        { label: 'Next tab', accelerator: 'Ctrl+Tab', click: () => cycle(1) },
        { label: 'Previous tab', accelerator: 'Ctrl+Shift+Tab', click: () => cycle(-1) },
        also('Ctrl+PageDown', () => cycle(1)),
        also('Ctrl+PageUp', () => cycle(-1)),
        ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => also(`CmdOrCtrl+${n}`, () => nthTab(n))),
        { type: 'separator' },
        {
          label: 'Pin tab', id: 'pin-tab', type: 'checkbox', accelerator: 'Alt+Shift+P',
          click: () => active() && tabs.pin(active().id, !active().pinned),
        },
        // The keyboard's way to do what dragging a tab does.
        { label: 'Move tab left', accelerator: 'Ctrl+Shift+PageUp', click: () => handlers['tab:nudge'](-1) },
        { label: 'Move tab right', accelerator: 'Ctrl+Shift+PageDown', click: () => handlers['tab:nudge'](1) },
        { label: 'Move tab to new window', click: () => active() && tabs.emit('to-new-window', { tab: active() }) },
      ],
    },
    {
      label: 'Claude',
      submenu: [
        { label: 'Claude panel', id: 'claude-panel', type: 'checkbox', accelerator: 'CmdOrCtrl+Shift+L', click: () => send('toggle-panel') },
        { label: 'Point at something', accelerator: 'CmdOrCtrl+Shift+C', click: handlers['pick:start'] },
        { label: 'Take over', id: 'take-over', type: 'checkbox', accelerator: 'CmdOrCtrl+Shift+.', click: togglePause },
        { type: 'separator' },
        { label: 'Claude sessions…', click: show('show-activity') },
        { label: 'Connection to other Claude sessions…', click: show('show-relay') },
      ],
    },
    {
      label: 'Help',
      submenu: [
        ...updateMenu(),
        { label: `About Loui ${app.getVersion()}`, click: () => app.showAboutPanel() },
      ],
    },
  ]));
  syncMenu(menu);
  return menu;
}

// Help menu items for updates, in installed copies only.
function updateMenu() {
  const u = updater?.state();
  if (!u) return [];
  const label = {
    ready: `Restart to update to ${u.version}`,
    downloading: `Downloading ${u.version}… ${u.percent}%`,
    checking: 'Checking for updates…',
    latest: `Check for updates (you have the latest, ${u.current})`,
    failed: "Check for updates (the last check didn't work)",
  }[u.status] || 'Check for updates';
  const busy = u.status === 'checking' || u.status === 'downloading';
  return [
    // Restarting closes sessions' tab groups: the toolbar's button asks first while one is working.
    { label, enabled: !busy, click: () => (u.status === 'ready' ? send('update:ask') : updater.check()) },
    { type: 'separator' },
  ];
}

function zoom(step) {
  const wc = active()?.device ? null : active()?.wc; // an emulated device owns its zoom
  if (wc) wc.setZoomFactor(step ? Math.min(3, Math.max(0.3, wc.getZoomFactor() + step)) : 1);
}

// A second Loui started (a link opened in another app, say) hands its links to
// this one and quits.
if (!app.requestSingleInstanceLock({ urls: launched })) {
  app.quit();
} else {
  app.on('before-quit', () => { quitting = true; history?.flush(); bookmarks?.flush(); activity?.flush(); });
  app.on('second-instance', (_e, argv, cwd, data) => defaultBrowser?.secondInstance(argv, cwd, data));
  app.whenReady().then(() => {
    // Each request runs with the window whose chrome sent it as the one being served.
    // Only a window's chrome may ask (and the suggestion list, to pick a row):
    // never a tab's page, nor the chrome of a window that has closed.
    for (const [name, fn] of Object.entries(handlers)) {
      ipcMain.on(name, (e, arg) => {
        const w = tabs.windowOf(e.sender);
        if (!w && !(name === 'suggest:pick' && e.sender === suggest?.webContents)) return;
        tabs.as(w, () => fn(arg));
      });
    }
    start();
    Menu.setApplicationMenu(appMenu()); // after the window: some items come from modules it creates
  });
}
