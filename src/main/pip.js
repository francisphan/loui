// Watching a session in a small window (picture in picture): a live picture
// of the tab a Claude session is working in, its name and what it is doing,
// Take over, and a click to show that tab in the main window. It floats over
// other windows so the user can keep an eye on a session from their own tabs.
//
// The picture costs no second renderer of the page. It is the session tab's
// own frames (webContents.beginFrameSubscription), scaled down to the small
// window's size and sent to it as JPEG. Chromium copies a frame each time the
// page paints while subscribed, up to 30 a second, so the subscription is
// held only until a frame arrives, then let go for a moment:
//
//   - A frame that differs from the last picture is sent, and the next is
//     taken 200 ms later (at most five pictures a second).
//   - Subscribing always delivers one frame at once. If that frame is the
//     picture already shown, the page is still, and the subscription is kept:
//     a still page paints nothing, so nothing is copied until it changes.
//   - A page that paints without looking any different (a blinking caret, an
//     animation out of sight) is looked at less and less often, down to once
//     every four seconds, rather than at every paint.
//
// Nothing is captured while the small window is closed, hidden or minimised.
// Session tabs stay in sight underneath the user's tab (tabs.rest()), and
// covered views still deliver frames, so this works while the user is in
// their own tabs. Only images leave the page: no DOM, text or URL of the page
// is sent to the small window beyond the tab's title, which the tab strip
// shows anyway.
//
// Claude sessions have no tool that opens, reads or controls this window.
const path = require('path');
const { BrowserWindow, ipcMain, nativeTheme, screen } = require('electron');
const { YOU } = require('./tabs');

const SOON = 200; // ms between pictures while the page changes (five a second)
const SLOWEST = 4000; // ms between looks at a page that repaints without changing
const ENDED_CLOSE = 4000; // ms the window says "Session ended" before closing
const MARGIN = 16; // from the screen's edge, where the window snaps to
const SNAP = 40; // closer than this to an edge, and the window snaps to it
const SIZE = { width: 360, height: 260 };

// tabs: the browser's. settings, save: settings.json (where the window was).
// pause(group, on): take over or hand back, as the helm does. focusMain():
// bring the main window forward.
function createPip({ tabs, settings, save, lockToApp, pause, focusMain }) {
  let win = null;
  let group = null; // the id of the group being watched
  let label = ''; // its session's name, kept for once it has ended
  let ended = false;
  let closeTimer = null;
  let shown = ''; // the last update sent, to send only changes
  let box = { width: SIZE.width, height: SIZE.height - 80 }; // picture area in device pixels, from the page
  let placeTimer = null;

  // The capture (see the note at the top).
  let wc = null; // the page subscribed to, or waited on
  let subscribed = false;
  let fresh = false; // the next frame is the one subscribing delivers at once
  let last = null; // bitmap of the picture last sent
  let wait = SOON;
  let again = null;
  let sent = 0; // pictures sent, for the tests

  const live = (w) => w && !w.isDestroyed();
  const watching = () => !!win && !ended && win.isVisible() && !win.isMinimized();

  function subscribe() {
    clearTimeout(again);
    again = null;
    if (!live(wc) || subscribed || !watching()) return;
    subscribed = true;
    fresh = true;
    wc.beginFrameSubscription(false, frame);
  }

  function unsubscribe() {
    clearTimeout(again);
    again = null;
    if (subscribed && live(wc)) wc.endFrameSubscription();
    subscribed = false;
  }

  // Let go of the page, and look again after ms.
  function rest(ms) {
    unsubscribe();
    again = setTimeout(subscribe, ms);
  }

  function frame(image) {
    if (!subscribed || !watching()) return;
    const first = fresh;
    fresh = false;
    const size = image.getSize();
    if (!size.width || !size.height) return;
    const scale = Math.min(1, box.width / size.width, box.height / size.height);
    const picture = image.resize({
      width: Math.max(1, Math.round(size.width * scale)),
      height: Math.max(1, Math.round(size.height * scale)),
      quality: 'good',
    });
    const bitmap = picture.toBitmap();
    if (last && bitmap.equals(last)) {
      if (first) return; // still: stay subscribed, and a still page costs nothing
      wait = Math.min(SLOWEST, wait * 2);
      return rest(wait);
    }
    last = bitmap;
    wait = SOON;
    sent++;
    send('pip:frame', `data:image/jpeg;base64,${picture.toJPEG(75).toString('base64')}`);
    rest(SOON);
  }

  // Watches page w (the group's current tab), or nothing.
  function follow(w) {
    if (w === wc && (subscribed || again)) return;
    unsubscribe();
    wc = live(w) ? w : null;
    last = null; // a new page is always drawn at once
    wait = SOON;
    subscribe();
  }

  function send(channel, payload) {
    if (live(win?.webContents)) win.webContents.send(channel, payload);
  }

  // What the small window shows besides the picture.
  function update() {
    if (!win) return;
    const g = tabs.group(group);
    if (!g && !ended) {
      ended = true;
      follow(null);
      closeTimer = setTimeout(() => win?.close(), ENDED_CLOSE);
    }
    if (!ended) follow(tabs.current(group)?.wc || null);
    const tab = ended ? null : tabs.current(group);
    if (g) label = g.label;
    const now = {
      ended,
      label,
      busy: !!g && g.busy > 0,
      status: g?.status || '',
      paused: !!g?.paused,
      title: tab ? tab.title || tab.url || 'New tab' : '',
      picture: !!live(tab?.wc), // false for a sleeping tab or none at all
    };
    const text = JSON.stringify(now);
    if (text === shown) return;
    shown = text;
    send('pip:update', now);
  }

  // Where the window goes: where it was last time, if that is still on a
  // screen, otherwise the bottom left corner of the page area of the window
  // the session's tabs are in, clear of the Claude panel on the right.
  function bounds(host) {
    const saved = settings.pip;
    if (saved && [saved.x, saved.y, saved.width, saved.height].every(Number.isFinite)) {
      const area = screen.getDisplayMatching(saved).workArea;
      const width = Math.min(saved.width, area.width);
      const height = Math.min(saved.height, area.height);
      return {
        width, height,
        x: Math.min(Math.max(saved.x, area.x), area.x + area.width - width),
        y: Math.min(Math.max(saved.y, area.y), area.y + area.height - height),
      };
    }
    const within = (area, x, y) => ({
      ...SIZE,
      x: Math.min(Math.max(x, area.x), area.x + area.width - SIZE.width),
      y: Math.min(Math.max(y, area.y), area.y + area.height - SIZE.height),
    });
    if (host && !host.win.isDestroyed() && !host.win.isMinimized()) {
      const content = host.win.getContentBounds();
      const page = host.area;
      const x = content.x + page.x + MARGIN;
      const y = content.y + page.y + page.height - SIZE.height - MARGIN;
      return within(screen.getDisplayMatching(content).workArea, x, y);
    }
    const area = screen.getPrimaryDisplay().workArea;
    return within(area, area.x + MARGIN, area.y + area.height - SIZE.height - MARGIN);
  }

  // Once the user stops moving or resizing it: near an edge, it snaps to the
  // edge; then where it is is kept for next time.
  function placed() {
    clearTimeout(placeTimer);
    placeTimer = setTimeout(() => {
      if (!win || win.isMinimized()) return;
      const b = win.getBounds();
      const area = screen.getDisplayMatching(b).workArea;
      let { x, y } = b;
      if (x - area.x < SNAP) x = area.x + MARGIN;
      if (area.x + area.width - (x + b.width) < SNAP) x = area.x + area.width - b.width - MARGIN;
      if (y - area.y < SNAP) y = area.y + MARGIN;
      if (area.y + area.height - (y + b.height) < SNAP) y = area.y + area.height - b.height - MARGIN;
      if (x !== b.x || y !== b.y) win.setPosition(x, y);
      settings.pip = { x, y, width: b.width, height: b.height };
      save();
    }, 400);
  }

  // Watch a session's group. One small window at a time: opening it for
  // another session moves it there.
  function open(id) {
    const g = tabs.group(id);
    if (!g || id === YOU) return false;
    group = id;
    ended = false;
    clearTimeout(closeTimer);
    shown = '';
    if (win) {
      follow(null);
      update();
      if (win.isMinimized()) win.restore();
      win.showInactive();
      return true;
    }
    win = new BrowserWindow({
      ...bounds(g.window),
      minWidth: 220, minHeight: 170,
      frame: false, alwaysOnTop: true, fullscreenable: false, maximizable: false,
      title: 'Watching a Claude session',
      icon: path.join(__dirname, '../ui/icon.png'),
      show: false,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#101B22' : '#E6EDEF',
      webPreferences: { preload: path.join(__dirname, 'pip-preload.js'), sandbox: true, contextIsolation: true },
    });
    win.setMenu(null);
    lockToApp(win.webContents);
    // Opened beside the user's work, it does not take the keyboard from it.
    win.once('ready-to-show', () => win?.showInactive());
    win.webContents.on('did-finish-load', () => { shown = ''; update(); subscribe(); });
    for (const event of ['minimize', 'hide']) win.on(event, unsubscribe);
    for (const event of ['restore', 'show']) win.on(event, subscribe);
    win.on('move', placed);
    win.on('resize', placed);
    win.on('closed', () => {
      follow(null);
      clearTimeout(closeTimer);
      clearTimeout(placeTimer);
      win = null;
      group = null;
      last = null;
    });
    win.loadFile(path.join(__dirname, '../ui/pip.html'));
    update();
    return true;
  }

  function close() {
    win?.close();
  }

  // Requests from the small window's page, and only from it.
  const mine = (e) => !!win && e.sender === win.webContents;
  ipcMain.on('pip:act', (e, action) => {
    if (!mine(e)) return;
    if (action === 'close') return close();
    const g = tabs.group(group);
    if (!g || ended) return;
    if (action === 'take-over') pause(g.id, true);
    else if (action === 'continue') pause(g.id, false);
    else if (action === 'show') {
      const tab = tabs.current(g.id);
      if (tab) tabs.select(tab.id);
      focusMain(tab); // the window the session's tabs are in
    }
  });
  // The picture area's size in device pixels, so pictures are made to fit it.
  ipcMain.on('pip:size', (e, size) => {
    if (!mine(e)) return;
    const width = Math.round(Number(size?.width));
    const height = Math.round(Number(size?.height));
    if (!(width > 0 && height > 0)) return;
    box = { width: Math.min(width, 4096), height: Math.min(height, 4096) };
    last = null; // redraw at the new size
    if (subscribed) rest(0);
  });

  // "Watch in a small window" on a session's tabs (right-click in the tab strip).
  tabs.on('tab-menu', (tab, items) => {
    if (tab.group === YOU) return;
    items.push({ label: 'Watch in a small window', click: () => open(tab.group) });
  });
  // Kept current by changed(), which main.js calls with every change of state
  // (tab changes included), rather than by listening to the tabs as well.

  // For the tests (LOUI_TEST only).
  const probes = {
    'pip:open': (id) => open(id),
    'pip:close': () => { close(); return 'ok'; },
    'pip:state': () => ({
      open: !!win, group, ended, subscribed, waiting: !!again, sent,
      watching: wc ? tabs.list.find((t) => t.wc === wc)?.id ?? null : null,
      bounds: win?.getBounds() || null,
    }),
    'pip:minimize': () => { win?.minimize(); return 'ok'; },
    'pip:restore': () => { win?.restore(); win?.showInactive(); return 'ok'; },
    'pip:hide': () => { win?.hide(); return 'ok'; },
    // Moves or resizes the window, as dragging its bar or edges would.
    'pip:place': (b) => { win?.setBounds(b); return 'ok'; },
    'pip:show': () => { win?.showInactive(); return 'ok'; },
    // Runs a script in the small window's page, as a click there would.
    'pip:js': (code) => (win ? win.webContents.executeJavaScript(code) : null),
    'pip:url': () => win?.webContents.getURL() ?? null,
    // The items this module adds to a tab's menu in the tab strip; with
    // click set, chooses the one so named.
    'pip:menu': ({ id, click } = {}) => {
      const tab = tabs.get(id);
      if (!tab) return null;
      const items = [];
      tabs.emit('tab-menu', tab, items);
      const item = items.find((i) => i.label === click);
      if (item) item.click();
      return items.map((i) => i.label).filter(Boolean);
    },
  };

  return { open, close, changed: update, probes, isOpen: () => !!win };
}

module.exports = { createPip };
