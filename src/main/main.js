// Loui: a browser Claude drives alongside the user.
//
//   window chrome (src/ui)  <-- IPC -->  this file  <-- tabs.js: views, tab groups
//   Claude sessions anywhere --> relay --> link.js --> sessions.js --> actions.js --> the page
//   Claude panel (chat.js, Agent SDK) -----------------> sessions.js --> actions.js
//   tests --> rpc.js (local socket) -------------------> sessions.js --> actions.js
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, Menu, ipcMain, session, nativeTheme } = require('electron');
const paths = require('../shared/paths');
const { Tabs, PRESETS, toUrl, YOU } = require('./tabs');
const { createSessions } = require('./sessions');
const { createActions } = require('./actions');
const { createChat } = require('./chat');
const { createLink } = require('./link');
const { createUpdater } = require('./updater');
const rpc = require('./rpc');

fs.mkdirSync(paths.home, { recursive: true, mode: 0o700 });
app.setPath('userData', paths.home);
// Claude works in this window while it sits behind others. Without these a
// covered window stops rendering: clicks no longer land and screenshots fail.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion'); // Windows
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
// Sites that refuse embedded browsers key on these tokens.
app.userAgentFallback = app.userAgentFallback.replace(/ (loui|Electron)\/\S+/gi, '');

// Appearance: 'dark' (the default), 'light', or 'system' to follow the OS.
// It applies to the window and is what pages see as prefers-color-scheme.
const settingsFile = path.join(paths.home, 'settings.json');
const settings = (() => { try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { return {}; } })();
nativeTheme.themeSource = ['dark', 'light', 'system'].includes(settings.theme) ? settings.theme : 'dark';
function setTheme(theme) {
  nativeTheme.themeSource = theme;
  settings.theme = theme;
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
  Menu.setApplicationMenu(appMenu());
}

const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen', 'pointerLock']);

let win, tabs, sessions, actions, chat, link, handle, updater;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

let stateQueued = false;
function pushState() {
  if (stateQueued) return;
  stateQueued = true;
  setImmediate(() => {
    stateQueued = false;
    send('state', currentState());
  });
}

const currentState = () => ({
  tabs: tabs.summary(),
  groups: tabs.groups.map((g) => ({
    id: g.id, label: g.label, source: g.source, busy: g.busy > 0, status: g.status, paused: g.paused,
  })),
  asking: sessions.asking(),
  picking: actions.picker.state(),
  picks: actions.picker.recent().filter((p) => p.group === YOU)
    .map((p) => ({ id: p.id, name: p.name || p.tag, thumb: p.thumb })),
  link: link.state(),
  update: updater.state(),
});

function createWindow() {
  const ses = session.fromPartition('persist:loui');
  ses.setPermissionRequestHandler((_wc, permission, allow) => allow(ALLOWED_PERMISSIONS.has(permission)));

  win = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 720,
    minHeight: 480,
    title: 'Loui',
    icon: path.join(__dirname, '../ui/icon.png'),
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#101B22' : '#E6EDEF',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), sandbox: true, contextIsolation: true,
      backgroundThrottling: false,
    },
  });

  tabs = new Tabs(win, ses);
  sessions = createSessions({ tabs, changed: pushState, feed: (entry) => send('feed', entry) });
  actions = createActions({ tabs, sessions, changed: pushState });
  handle = rpc.createHandler({ run: actions.run, sessions, extra: process.env.LOUI_TEST ? testHook : null });
  link = createLink({
    home: paths.home, version: app.getVersion(), handle, sessions, changed: pushState,
    guard: (origins) => { tabs.relayOrigins = new Set(origins); },
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
    emit: (event) => send('chat', event),
  });

  tabs.on('change', pushState);
  tabs.on('point', (tab, point) => actions.picker.at(tab, point));
  win.on('closed', () => app.quit());
  win.webContents.on('did-finish-load', () => {
    pushState();
    setTimeout(serve, 3000);
  });
  if (process.env.LOUI_DEBUG) {
    win.webContents.on('console-message', (e) => console.error('[ui]', e.message, `(${e.sourceId}:${e.lineNumber})`));
  }

  win.loadFile(path.join(__dirname, '../ui/index.html'));
  tabs.create(process.env.LOUI_START_URL || '', { show: true });
}

// ── requests from the window chrome ─────────────────────────────────────────
const active = () => tabs.active();

let serving = false;
// Sessions are let in once the page area has its real size (or, if the window
// never reports one, a few seconds after it loads).
function serve() {
  if (serving) return;
  serving = true;
  rpc.serve(paths.socketPath, handle, sessions);
  link.connect();
}
const handlers = {
  layout: (area) => {
    tabs.setArea(area);
    serve();
  },
  'tab:new': (url) => { tabs.create(url || '', { show: true }); if (!url) send('focus-address'); },
  'tab:select': (id) => tabs.select(id),
  'tab:close': (id) => tabs.close(id),
  'tab:menu': (id) => tabs.tabMenu(id),
  go: (input) => { active()?.wc.loadURL(toUrl(input)).catch(() => {}); active()?.wc.focus(); },
  back: () => active()?.wc.navigationHistory.goBack(),
  forward: () => active()?.wc.navigationHistory.goForward(),
  reload: () => { const wc = active()?.wc; if (wc?.isLoading()) wc.stop(); else wc?.reload(); },
  devtools: () => active()?.wc.toggleDevTools(),
  'pick:start': () => { const tab = active(); if (tab) actions.picker.start(tab); },
  'pick:cancel': () => actions.picker.cancel(),
  'pick:remove': (id) => actions.picker.remove(id),
  // Take over, or hand back, the session working in a tab group.
  pause: ({ group, on }) => { const g = tabs.group(group); if (g) g.paused = !!on; pushState(); },
  'handoff:answer': (yes) => sessions.answer(!!yes),
  'group:close': (id) => sessions.end(id),
  'device:menu': () => deviceMenu(),
  'relay:set': (settings) => link.configure(settings),
  'update:install': () => updater.install(),
  'chat:send': (message) => { chat.send(message); },
  'chat:stop': () => chat.stop(),
  'chat:reset': () => chat.reset(),
};

// Lets the test suite do what only the window chrome can (allow a hand-over,
// take over a group) and read the window's state. Off unless LOUI_TEST is set.
async function testHook({ ui, arg }) {
  if (ui === 'state') return currentState();
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
  ]).popup({ window: win });
}

function appMenu() {
  const cycle = (step) => {
    const i = tabs.list.indexOf(active());
    const next = tabs.list[(i + step + tabs.list.length) % tabs.list.length];
    if (next) tabs.select(next.id);
  };
  const togglePause = () => {
    const g = tabs.group(active()?.group);
    if (g) handlers.pause({ group: g.id, on: !g.paused });
  };
  return Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        { label: 'New tab', accelerator: 'CmdOrCtrl+T', click: () => handlers['tab:new']() },
        { label: 'Close tab', accelerator: 'CmdOrCtrl+W', click: () => active() && tabs.close(active().id) },
        { label: 'Go to address', accelerator: 'CmdOrCtrl+L', click: () => { win.webContents.focus(); send('focus-address'); } },
        { type: 'separator' },
        ...updateMenu(),
        ...(process.platform === 'linux' ? [] : [{
          label: 'Open Loui when I sign in', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin,
          click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
        }, { type: 'separator' }]),
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => active()?.wc.reload() },
        { label: 'Back', accelerator: 'Alt+Left', click: handlers.back },
        { label: 'Forward', accelerator: 'Alt+Right', click: handlers.forward },
        { label: 'Next tab', accelerator: 'Ctrl+Tab', click: () => cycle(1) },
        { label: 'Previous tab', accelerator: 'Ctrl+Shift+Tab', click: () => cycle(-1) },
        { type: 'separator' },
        { label: 'Zoom in', accelerator: 'CmdOrCtrl+=', click: () => zoom(0.1) },
        { label: 'Zoom out', accelerator: 'CmdOrCtrl+-', click: () => zoom(-0.1) },
        { label: 'Actual size', accelerator: 'CmdOrCtrl+0', click: () => zoom(0) },
        { type: 'separator' },
        {
          label: 'Appearance',
          submenu: [['dark', 'Dark'], ['light', 'Light'], ['system', 'Match system']].map(([theme, label]) => ({
            label, type: 'radio', checked: nativeTheme.themeSource === theme, click: () => setTheme(theme),
          })),
        },
        { type: 'separator' },
        { label: 'Developer tools', accelerator: 'F12', click: handlers.devtools },
      ],
    },
    {
      label: 'Claude',
      submenu: [
        { label: 'Point at something', accelerator: 'CmdOrCtrl+Shift+C', click: handlers['pick:start'] },
        { label: 'Show or hide the Claude panel', accelerator: 'CmdOrCtrl+Shift+L', click: () => send('toggle-panel') },
        { label: 'Take over / let Claude continue', accelerator: 'CmdOrCtrl+Shift+.', click: togglePause },
        { type: 'separator' },
        { label: 'Connection to other Claude sessions…', click: () => send('show-relay') },
      ],
    },
  ]);
}

// File menu items for updates, in installed copies only.
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
    { label, enabled: !busy, click: () => (u.status === 'ready' ? updater.install() : updater.check()) },
    { type: 'separator' },
  ];
}

function zoom(step) {
  const wc = active()?.device ? null : active()?.wc; // an emulated device owns its zoom
  if (wc) wc.setZoomFactor(step ? Math.min(3, Math.max(0.3, wc.getZoomFactor() + step)) : 1);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(() => {
    for (const [name, fn] of Object.entries(handlers)) ipcMain.on(name, (_e, arg) => fn(arg));
    Menu.setApplicationMenu(appMenu());
    createWindow();
  });
}
