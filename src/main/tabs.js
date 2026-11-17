// Tabs and tab groups. One WebContentsView per tab; every tab belongs to a
// group. The 'you' group is the user's own tabs. Each Claude session gets a
// group of its own and works only inside it.
//
// All views stay attached to the window, stacked, with the tab the user is
// looking at on top and an opaque backdrop under it. A tab that is attached but
// covered can still be captured and sent input without taking focus; a detached
// or off-screen one cannot, which is why they are stacked rather than hidden.
//
// One more condition, found by experiment: a page only renders and takes
// clicks if its view was in sight while the page loaded. So while a background
// tab is loading it "peeks": it sits on top, shifted so that a single column
// of pixels shows at the right edge of the page area, and it is tucked back
// underneath when the load is done. Its size never changes, so the page
// cannot tell.
//
// Speed and memory. A covered view still counts as visible, so Chromium never
// throttles it. The user's own background tabs are therefore hidden as well
// as covered (see rest()), and throttled like in any browser; tabs in a Claude
// session's group stay in sight, unthrottled, so the session can work in them.
// A tab can also be put to sleep (sleep.js decides when): its view and page
// are destroyed and only what the tab strip shows and its history are kept,
// until it is woken by being selected or used by Claude.
const { WebContentsView, View, Menu, clipboard, nativeTheme } = require('electron');
const { EventEmitter } = require('events');
const { requestRules } = require('./requests');
const { searchFor } = require('./search');

const YOU = 'you';
const LOG_LIMIT = 500;
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

const PRESETS = {
  iphone: { width: 393, height: 852, mobile: true, label: 'iPhone' },
  android: { width: 412, height: 915, mobile: true, label: 'Android phone' },
  ipad: { width: 820, height: 1180, mobile: true, label: 'iPad' },
  'ipad-landscape': { width: 1180, height: 820, mobile: true, label: 'iPad, landscape' },
};

const keep = (list, item) => {
  list.push(item);
  if (list.length > LOG_LIMIT) list.shift();
};

// What the user typed in the address bar, as a URL.
function toUrl(input) {
  const text = input.trim();
  if (!text) return 'about:blank';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^(about|data|file|view-source):/i.test(text)) return text;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(text)) return 'http://' + text;
  if (!/\s/.test(text) && /^[^/]+\.[^/]+/.test(text)) return 'https://' + text;
  return searchFor(text);
}

class Tabs extends EventEmitter {
  constructor(win, ses) {
    super();
    this.win = win;
    this.ses = ses;
    this.list = [];
    // busy/status/paused describe the Claude session working in the group.
    this.groups = [{ id: YOU, label: 'You', source: null, current: null, busy: 0, status: '', paused: false }];
    this.activeId = null; // the tab on screen
    this.area = { x: 0, y: 80, width: 800, height: 600 };
    this.seq = 0;
    this.relayOrigins = new Set();
    this.backdrop = new View();
    const tint = () => this.backdrop.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#101B22' : '#E6EDEF');
    tint();
    nativeTheme.on('updated', tint);
    win.contentView.addChildView(this.backdrop);
    this.watchNetwork();
  }

  active() {
    return this.get(this.activeId);
  }

  get(id) {
    return this.list.find((t) => t.id === id) || null;
  }

  group(id) {
    return this.groups.find((g) => g.id === id) || null;
  }

  in(groupId) {
    return this.list.filter((t) => t.group === groupId);
  }

  // The tab a group's session is working in.
  current(groupId) {
    return this.get(this.group(groupId)?.current);
  }

  // show: put the new tab on screen. Left unset, a tab opened in the group the
  // user is watching is shown, and one opened elsewhere stays in the background.
  // device and history: what a restored tab had (see restore.js). asleep: a
  // restored tab with history starts asleep unless shown, and loads when woken.
  // pinned: only for the user's own tabs (see pin()).
  create(url, { group = YOU, show, device, history, asleep = false, pinned = false } = {}) {
    const tab = {
      id: ++this.seq, view: null, wc: null, group, lent: false, title: '', url: '', favicon: null,
      loading: false, console: [], network: [], pointer: null, device: null, shotScale: 1,
      asleep: false, history: null, seenAt: Date.now(), pinned: pinned && group === YOU,
    };
    this.list.push(tab);
    this.tidy(); // a new tab goes at the end of its group
    const g = this.group(group);
    const watching = this.active()?.group === group;
    if (!g.current) g.current = tab.id;
    // Before loading, so the first request has its user agent.
    tab.device = (typeof device === 'string' ? PRESETS[device] : device) || null;
    show = show ?? (watching || !this.active());
    if (asleep && history && !show) {
      tab.asleep = true;
      tab.history = history;
      const shown = history.entries[history.index] || history.entries[0];
      tab.url = shown?.url || '';
      tab.title = shown?.title || '';
      this.emit('change');
      return tab;
    }
    this.open(tab, show, { url, history });
    return tab;
  }

  // Gives a tab a new view and loads its page (or its history) into it, in
  // sight while it loads (see the note at the top).
  open(tab, show, { url, history }) {
    this.build(tab);
    this.win.contentView.addChildView(tab.view);
    if (show) this.select(tab.id);
    else this.peek(tab);
    this.rest(tab);
    const wc = tab.wc;
    if (history) wc.navigationHistory.restore(history).catch(() => wc.isDestroyed() || wc.loadURL(toUrl(url || '')).catch(() => {}));
    else wc.loadURL(toUrl(url || '')).catch(() => {});
    this.emit('change');
  }

  // Wakes a sleeping tab: its page loads again, with its history and scroll
  // position. Returns the tab.
  wake(tab) {
    if (!tab?.asleep) return tab;
    tab.asleep = false;
    tab.seenAt = Date.now();
    this.open(tab, false, { url: tab.url, history: tab.history });
    return tab;
  }

  // Puts a tab to sleep: its page and renderer go, its place in the tab strip,
  // title, icon and history stay. The tab on screen never sleeps. sleep.js
  // decides which tabs may.
  sleep(tab) {
    if (!tab || tab.asleep || tab.id === this.activeId || !tab.wc || tab.wc.isDestroyed()) return false;
    const nav = tab.wc.navigationHistory;
    const entries = nav.getAllEntries();
    // Kept with each entry's page state, which brings back the scroll position.
    tab.history = entries.length ? { entries, index: nav.getActiveIndex() } : null;
    this.emit('leaving', tab); // its page goes away, as if it navigated
    clearTimeout(tab.tuckTimer);
    tab.peeking = false;
    this.win.contentView.removeChildView(tab.view);
    tab.wc.close();
    tab.view = tab.wc = null;
    tab.asleep = true;
    tab.loading = false;
    tab.pointer = null;
    this.emit('change');
    return true;
  }

  // A view and its page for a tab, with the page's events wired to it.
  build(tab) {
    const view = new WebContentsView({
      // Throttled in the background unless a Claude session works in it (see rest()).
      webPreferences: { session: this.ses, sandbox: true, contextIsolation: true },
    });
    view.setBackgroundColor('#ffffff');
    const wc = view.webContents;
    tab.view = view;
    tab.wc = wc;
    tab.audible = false;
    tab.throttled = true; // as the view is made; rest() changes it
    if (tab.device) wc.setUserAgent(tab.device.mobile ? MOBILE_UA : this.ses.getUserAgent());
    const changed = () => this.emit('change');

    wc.on('page-title-updated', (_e, title) => { tab.title = title; changed(); });
    wc.on('page-favicon-updated', (_e, icons) => { tab.favicon = icons[0] || null; changed(); });
    wc.on('did-start-loading', () => { tab.loading = true; changed(); });
    wc.on('did-stop-loading', () => {
      tab.loading = false;
      this.tuckWhenDrawn(tab);
      changed();
    });
    wc.on('did-start-navigation', (e) => {
      if (e.isSameDocument) return;
      this.peek(tab); // frames within the page get new renderers too
      if (e.isMainFrame) this.emit('leaving', tab);
    });
    wc.on('did-navigate', (_e, to) => {
      tab.url = to;
      tab.favicon = null;
      tab.pointer = null;
      tab.history = null; // the page keeps its own history from here (see wake())
      const mark = { mark: true, text: `navigated to ${to}`, at: Date.now() };
      keep(tab.console, mark);
      keep(tab.network, mark);
      changed();
    });
    wc.on('did-navigate-in-page', (_e, to, isMainFrame) => {
      if (isMainFrame) { tab.url = to; changed(); }
    });
    wc.on('did-fail-load', (_e, code, reason, failedUrl, isMainFrame) => {
      if (!isMainFrame || code === -3) return; // -3: superseded by another navigation
      tab.url = failedUrl;
      tab.title = "Can't open this page";
      tab.favicon = null;
      this.emit('failed', tab, { code, reason, url: failedUrl }); // errorpage.js draws the page
      changed();
    });
    wc.on('console-message', (e, ...old) => {
      // Electron passes one details object; older builds passed positional args.
      const d = e.message !== undefined ? e
        : { level: ['debug', 'info', 'warning', 'error'][old[0]], message: old[1], lineNumber: old[2], sourceId: old[3] };
      keep(tab.console, {
        level: d.level, text: d.message, source: d.sourceId, line: d.lineNumber, at: Date.now(),
      });
    });
    wc.on('render-process-gone', (_e, details) => {
      tab.title = `Page crashed (${details.reason})`;
      changed();
    });
    // A page's new window becomes a new tab in the same group.
    wc.setWindowOpenHandler(({ url: to, disposition }) => {
      if (/^https?:|^about:blank/i.test(to)) {
        const opened = this.create(to, { group: tab.group, show: tab.id === this.activeId && disposition !== 'background-tab' });
        if (disposition !== 'background-tab') this.group(tab.group).current = opened.id;
      }
      return { action: 'deny' };
    });
    wc.on('context-menu', (_e, p) => this.contextMenu(tab, p));
    wc.on('audio-state-changed', (e) => { tab.audible = !!e.audible; this.rest(tab); });
    // Before its first load, so other modules can watch its navigations. Also
    // when a sleeping tab wakes, since it then has a new page.
    this.emit('created', tab);
  }

  // A user's tab out of sight is hidden and throttled; it stays in sight and
  // at full speed while a Claude session works in it (any tab in a session's
  // group, or the user's tab the Claude panel is busy in), and while it plays
  // sound. Hidden views cannot be captured or clicked, hence the exceptions.
  rest(tab) {
    if (!tab.wc || tab.wc.isDestroyed()) return;
    const you = this.group(YOU);
    const claude = tab.group !== YOU || (you.busy > 0 && you.current === tab.id);
    const full = claude || tab.audible;
    const visible = full || tab.peeking || tab.id === this.activeId;
    if (tab.throttled !== !full) tab.wc.setBackgroundThrottling(tab.throttled = !full);
    if (tab.view.getVisible() !== visible) tab.view.setVisible(visible);
  }

  restAll() {
    for (const tab of this.list) this.rest(tab);
  }

  // A Claude session is about to work in this tab: wake it if it sleeps, and
  // bring it into sight if it was hidden (peeking until it has drawn a frame,
  // so input lands; callers wait with settled()).
  use(tab) {
    if (!tab) return tab;
    tab.seenAt = Date.now(); // in use counts as seen, for sleep.js
    if (tab.asleep) return this.wake(tab);
    if (!tab.view.getVisible()) {
      this.peek(tab);
      this.tuckWhenDrawn(tab);
    }
    return tab;
  }

  // Put a tab on screen. It also becomes its group's current tab.
  select(id) {
    const tab = this.get(id);
    if (!tab) return null;
    const now = Date.now();
    if (this.active()) this.active().seenAt = now; // the tab the user is leaving was seen until now
    tab.seenAt = now;
    this.activeId = id;
    this.wake(tab);
    this.group(tab.group).current = id;
    tab.peeking = false;
    this.win.contentView.addChildView(this.backdrop);
    this.win.contentView.addChildView(tab.view); // re-adding moves it to the top
    for (const other of this.list) if (other.peeking) this.win.contentView.addChildView(other.view);
    this.place(tab);
    this.restAll();
    this.emit('change');
    return tab;
  }

  // See the note at the top of this file.
  peek(tab) {
    if (tab.id === this.activeId || !tab.wc || tab.wc.isDestroyed()) return;
    tab.peeking = true;
    tab.view.setVisible(true);
    this.win.contentView.addChildView(tab.view);
    this.place(tab);
    clearTimeout(tab.tuckTimer);
    tab.tuckTimer = setTimeout(() => this.tuck(tab), 8000); // a page that never finishes loading
  }

  // Resolves once the tab is not peeking (it has settled in its place), or
  // after 4 s. Input is sent only then: moving a view while a click is on its
  // way can lose the click.
  async settled(tab) {
    for (let waited = 0; tab.peeking && waited < 4000; waited += 25) {
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  // Tucks a peeking tab away once its page has drawn a frame while in sight
  // (two animation frames have passed), or after 3 s if it never does. A
  // fixed delay was not enough on slow machines: the tab went under before
  // drawing anything, and then clicks sent to it went nowhere.
  tuckWhenDrawn(tab) {
    if (!tab.peeking || !tab.wc || tab.wc.isDestroyed()) return;
    const drawn = tab.wc.executeJavaScript(
      'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))', true,
    ).catch(() => false);
    Promise.race([drawn, new Promise((r) => setTimeout(r, 3000))]).then(() => this.tuck(tab));
  }

  tuck(tab) {
    clearTimeout(tab.tuckTimer);
    if (!tab.peeking || !tab.wc || tab.wc.isLoadingMainFrame?.()) return;
    tab.peeking = false;
    if (tab.id === this.activeId || tab.wc.isDestroyed()) return;
    this.win.contentView.addChildView(tab.view, 0);
    this.place(tab);
    this.rest(tab);
  }

  // Point a session at one of its group's tabs. The screen follows only if the
  // user is already watching that group.
  setCurrent(groupId, id) {
    if (this.active()?.group === groupId) return this.select(id);
    this.group(groupId).current = id;
    this.emit('change');
    return this.get(id);
  }

  close(id) {
    const tab = this.get(id);
    if (!tab) return;
    const peers = this.in(tab.group);
    const next = peers[peers.indexOf(tab) + 1] || peers[peers.indexOf(tab) - 1] || null;
    this.emit('closing', tab); // still in the list, its page and history intact
    this.list.splice(this.list.indexOf(tab), 1);
    this.emit('leaving', tab);
    if (tab.view) { // a sleeping tab has no page to close
      this.win.contentView.removeChildView(tab.view);
      tab.wc.close();
    }
    const g = this.group(tab.group);
    if (g && g.current === id) g.current = next?.id || null;
    const wasOnScreen = this.activeId === id;
    if (wasOnScreen) this.activeId = null;
    if (!this.in(YOU).length) this.create('', { show: false }); // the user always has a tab
    if (wasOnScreen) this.select((next || this.current(YOU)).id);
    this.emit('change');
  }

  addGroup({ id, label, source }) {
    this.groups.push({ id, label, source, current: null, busy: 0, status: '', paused: false });
    this.emit('change');
    return this.group(id);
  }

  // Ends a session's group: the tabs it opened are closed, and tabs the user
  // handed to it go back to the user.
  removeGroup(id) {
    if (id === YOU || !this.group(id)) return;
    for (const tab of this.in(id)) {
      if (tab.lent) this.move(tab.id, YOU);
      else this.close(tab.id);
    }
    this.groups = this.groups.filter((g) => g.id !== id);
    this.emit('change');
  }

  // lent: the user handed this tab to a session, so it returns to them when the session ends.
  // at: where among the group's tabs it goes (see reorder()); the end if left out.
  move(id, groupId, { lent = false, at = Infinity } = {}) {
    const tab = this.get(id);
    const from = this.group(tab?.group);
    const to = this.group(groupId);
    if (!tab || !to || from === to) return;
    tab.group = groupId;
    tab.lent = lent;
    tab.pinned = false; // pinning is for the user's own tabs, and one coming back lands among the others
    if (from.current === id) from.current = this.in(from.id)[0]?.id || null;
    if (!to.current || id === this.activeId) to.current = id;
    this.reorder(id, at);
    if (!this.in(YOU).length) this.create('', { show: false });
    this.restAll(); // in a session's group a tab runs at full speed; back with the user it rests
    this.emit('change');
  }

  // Keeps each group's tabs together, in the order of the groups, with the
  // user's pinned tabs first, so the list reads as the tab strip does (Ctrl+Tab
  // and restore.js follow the list). The sort is stable: order within a group stays.
  tidy() {
    const rank = (t) => this.groups.findIndex((g) => g.id === t.group) * 2 + (t.pinned ? 0 : 1);
    this.list.sort((a, b) => rank(a) - rank(b));
  }

  // Puts a tab at a place among its own group's tabs: index counts the
  // group's other tabs before it. Pinned tabs stay ahead of the others, so the
  // index is kept to their side of that line.
  reorder(id, index) {
    const tab = this.get(id);
    if (!tab) return;
    const peers = this.in(tab.group).filter((t) => t !== tab);
    const pins = peers.filter((t) => t.pinned).length;
    const at = Math.round(Math.max(tab.pinned ? 0 : pins, Math.min(tab.pinned ? pins : peers.length, Number(index) || 0)));
    this.list.splice(this.list.indexOf(tab), 1);
    const before = peers[at];
    if (before) this.list.splice(this.list.indexOf(before), 0, tab);
    else if (peers.length) this.list.splice(this.list.indexOf(peers[peers.length - 1]) + 1, 0, tab);
    else this.list.push(tab);
    this.tidy();
    this.emit('change');
  }

  // One place left (-1) or right (+1) within its group, from the keyboard.
  nudge(id, step) {
    const tab = this.get(id);
    if (!tab) return;
    const peers = this.in(tab.group);
    this.reorder(id, peers.indexOf(tab) + step);
  }

  // A tab dropped in the tab strip. Within its group it is reordered. The
  // user's tab dropped on a session's group is handed to it, and a session's
  // tab dropped among the user's is taken back, as the tab menu's "Give to"
  // and "Take back" do. A session's tab never goes to another session.
  // pinned: dropped among the user's pinned tabs (true) or the others (false).
  drop(id, groupId, index, { pinned } = {}) {
    const tab = this.get(id);
    if (!tab || !this.group(groupId)) return;
    if (tab.group !== groupId) {
      if (groupId === YOU) this.move(id, YOU);
      else if (tab.group === YOU) this.move(id, groupId, { lent: true });
      else return;
    }
    if (groupId === YOU && typeof pinned === 'boolean') tab.pinned = pinned;
    this.reorder(id, index);
  }

  // Pinned tabs are the user's: small, first, never put to sleep, kept across restarts.
  pin(id, on) {
    const tab = this.get(id);
    if (!tab || tab.group !== YOU || tab.pinned === !!on) return;
    tab.pinned = !!on;
    // Pinning puts it at the end of the pinned tabs, unpinning at the start of the rest.
    this.reorder(id, this.in(YOU).filter((t) => t.pinned && t !== tab).length);
  }

  // The window tells us where the page area is; each tab fills it, or sits
  // centred in it at its emulated device size.
  setArea(area) {
    this.area = area;
    this.backdrop.setBounds(area);
    for (const tab of this.list) this.place(tab);
  }

  // An emulated device is the page zoomed out until a view of exactly the
  // device's size in CSS pixels fits the page area. (Electron's own device
  // emulation does not resize the viewport of an embedded view.)
  place(tab) {
    const a = this.area;
    if (a.width < 1 || a.height < 1 || !tab.view) return;
    const d = tab.device;
    const peekX = a.x + a.width - 1;
    if (!d) return tab.view.setBounds(tab.peeking ? { ...a, x: peekX } : a);
    // The page sees (view pixels / zoom), rounded down, as its size. Pick
    // whole view pixels and a zoom so that comes out exactly d.width by
    // d.height: the zoom makes the width exact, and a width is chosen for
    // which some whole number of pixels gives exactly d.height too.
    let width = Math.floor(d.width * Math.min(1, a.width / d.width, a.height / d.height));
    let zoom, height;
    for (;; width--) {
      zoom = width / d.width;
      height = Math.ceil(d.height * zoom - 1e-9);
      if (height / zoom < d.height + 1 - 1e-9 || width <= 1) break;
    }
    tab.view.setBounds({
      x: tab.peeking ? peekX : a.x + Math.round((a.width - width) / 2),
      y: a.y + Math.round((a.height - height) / 2),
      width, height,
    });
    tab.wc.setZoomFactor(zoom);
  }

  // device: a preset name, {width, height, mobile}, or null for the full window.
  setDevice(tab, device) {
    const d = typeof device === 'string' ? PRESETS[device] : device;
    const wasMobile = !!tab.device?.mobile;
    tab.device = d || null;
    if (!d) tab.wc.setZoomFactor(1);
    tab.wc.setUserAgent(d?.mobile ? MOBILE_UA : this.ses.getUserAgent());
    this.place(tab);
    // The user agent only changes what the server sends on the next load.
    if (wasMobile !== !!d?.mobile && tab.url) tab.wc.reload();
    this.emit('change');
  }

  watchNetwork() {
    const started = new Map();
    const owner = (d) => this.list.find((t) => t.wc?.id === d.webContentsId);
    const record = (d, extra) => {
      const begun = started.get(d.id);
      started.delete(d.id);
      const tab = owner(d);
      if (!tab || /^(data|blob|devtools|chrome-extension):/.test(d.url)) return;
      if (d.error === 'net::ERR_CACHE_MISS') return; // a cache probe, followed by the real request
      keep(tab.network, {
        method: d.method, url: d.url, type: d.resourceType, at: Date.now(),
        ms: begun ? Date.now() - begun : null, cached: !!d.fromCache, ...extra,
      });
    };
    const all = { urls: ['<all_urls>'] };
    // Tabs that Claude sessions work in never reach the relay itself (its
    // approval page asks for the relay key), however they get there. Added
    // first, so no other rule is asked before it (see requests.js).
    requestRules(this.ses).add((d) => {
      const tab = owner(d);
      let origin = '';
      try { origin = new URL(d.url).origin; } catch {}
      return !!tab && tab.group !== YOU && this.relayOrigins.has(origin) ? { cancel: true } : null;
    });
    this.ses.webRequest.onSendHeaders(all, (d) => started.set(d.id, Date.now()));
    this.ses.webRequest.onCompleted(all, (d) => record(d, { status: d.statusCode }));
    this.ses.webRequest.onErrorOccurred(all, (d) => record(d, { error: d.error }));
  }

  // Right-click inside a page.
  contextMenu(tab, p) {
    const wc = tab.wc;
    const items = [];
    if (p.linkURL) {
      items.push(
        { label: 'Open link in new tab', click: () => this.create(p.linkURL, { group: tab.group, show: false }) },
        { label: 'Copy link address', click: () => clipboard.writeText(p.linkURL) },
        { type: 'separator' },
      );
    }
    if (p.isEditable) items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { type: 'separator' });
    else if (p.selectionText) items.push({ role: 'copy' }, { type: 'separator' });
    items.push(
      { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
      { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
      { label: 'Reload', click: () => wc.reload() },
      { type: 'separator' },
      { label: 'Point Claude at this', click: () => this.emit('point', tab, { x: p.x, y: p.y }) },
      { label: 'Inspect', click: () => wc.inspectElement(p.x, p.y) },
    );
    Menu.buildFromTemplate(items).popup({ window: this.win });
  }

  // Right-click on a tab in the tab strip: hand it to a session, or take it back.
  tabMenu(id) {
    const tab = this.get(id);
    if (!tab) return;
    const others = this.groups.filter((g) => g.id !== YOU && g.id !== tab.group);
    const items = [];
    if (tab.group === YOU) {
      items.push({ label: tab.pinned ? 'Unpin tab' : 'Pin tab', click: () => this.pin(id, !tab.pinned) });
      for (const g of others) {
        items.push({ label: `Give to ${g.label}`, click: () => this.move(id, g.id, { lent: true }) });
      }
    } else {
      items.push({ label: 'Take back', click: () => this.move(id, YOU) });
    }
    this.emit('tab-menu', tab, items); // other modules add their items (sleep.js, brave.js)
    if (items.length) items.push({ type: 'separator' });
    items.push({ label: 'Close tab', click: () => this.close(id) });
    Menu.buildFromTemplate(items).popup({ window: this.win });
  }

  // What the window chrome needs to draw the tab strip and toolbar.
  summary() {
    // A sleeping tab answers from the history it kept.
    const nav = (t) => t.wc?.navigationHistory || {
      canGoBack: () => !!t.history && t.history.index > 0,
      canGoForward: () => !!t.history && t.history.index < t.history.entries.length - 1,
    };
    return this.list.map((t) => ({
      id: t.id,
      group: t.group,
      title: t.title || (t.url && t.url !== 'about:blank' ? t.url : 'New tab'),
      url: t.url === 'about:blank' ? '' : t.url,
      favicon: t.favicon,
      loading: t.loading,
      active: t.id === this.activeId,
      current: this.group(t.group)?.current === t.id,
      canGoBack: nav(t).canGoBack(),
      canGoForward: nav(t).canGoForward(),
      device: t.device ? t.device.label || `${t.device.width}×${t.device.height}` : null,
      asleep: !!t.asleep,
      pinned: !!t.pinned,
    }));
  }
}

module.exports = { Tabs, PRESETS, toUrl, YOU };
