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
const { WebContentsView, View, Menu, clipboard, nativeTheme } = require('electron');
const { EventEmitter } = require('events');

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
  return 'https://duckduckgo.com/?q=' + encodeURIComponent(text);
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
  create(url, { group = YOU, show } = {}) {
    const view = new WebContentsView({
      // Not throttled in the background: Claude works in tabs the user is not looking at.
      webPreferences: { session: this.ses, sandbox: true, contextIsolation: true, backgroundThrottling: false },
    });
    view.setBackgroundColor('#ffffff');
    const wc = view.webContents;
    const tab = {
      id: ++this.seq, view, wc, group, lent: false, title: '', url: '', favicon: null,
      loading: false, console: [], network: [], pointer: null, device: null, shotScale: 1,
    };
    this.list.push(tab);
    const changed = () => this.emit('change');

    wc.on('page-title-updated', (_e, title) => { tab.title = title; changed(); });
    wc.on('page-favicon-updated', (_e, icons) => { tab.favicon = icons[0] || null; changed(); });
    wc.on('did-start-loading', () => { tab.loading = true; changed(); });
    wc.on('did-stop-loading', () => {
      tab.loading = false;
      setTimeout(() => this.tuck(tab), 150);
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
      const message = `Can't open ${failedUrl}\n\n${reason} (${code})`;
      wc.executeJavaScript(
        `document.documentElement.style.cssText='font:16px/1.5 system-ui;padding:12vh 8vw;white-space:pre-wrap;color:#333;background:#fff';` +
        `document.body.textContent=${JSON.stringify(message)}`,
      ).catch(() => {});
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

    const g = this.group(group);
    const watching = this.active()?.group === group;
    if (!g.current) g.current = tab.id;
    this.win.contentView.addChildView(view);
    if (show ?? (watching || !this.active())) this.select(tab.id);
    else this.peek(tab);
    wc.loadURL(toUrl(url || '')).catch(() => {});
    changed();
    return tab;
  }

  // Put a tab on screen. It also becomes its group's current tab.
  select(id) {
    const tab = this.get(id);
    if (!tab) return null;
    this.activeId = id;
    this.group(tab.group).current = id;
    tab.peeking = false;
    this.win.contentView.addChildView(this.backdrop);
    this.win.contentView.addChildView(tab.view); // re-adding moves it to the top
    for (const other of this.list) if (other.peeking) this.win.contentView.addChildView(other.view);
    this.place(tab);
    this.emit('change');
    return tab;
  }

  // See the note at the top of this file.
  peek(tab) {
    if (tab.id === this.activeId || tab.wc.isDestroyed()) return;
    tab.peeking = true;
    this.win.contentView.addChildView(tab.view);
    this.place(tab);
    clearTimeout(tab.tuckTimer);
    tab.tuckTimer = setTimeout(() => this.tuck(tab), 8000); // a page that never finishes loading
  }

  tuck(tab) {
    clearTimeout(tab.tuckTimer);
    if (!tab.peeking || tab.wc.isLoadingMainFrame?.()) return;
    tab.peeking = false;
    if (tab.id === this.activeId || tab.wc.isDestroyed()) return;
    this.win.contentView.addChildView(tab.view, 0);
    this.place(tab);
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
    this.list.splice(this.list.indexOf(tab), 1);
    this.emit('leaving', tab);
    this.win.contentView.removeChildView(tab.view);
    tab.wc.close();
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
  move(id, groupId, { lent = false } = {}) {
    const tab = this.get(id);
    const from = this.group(tab?.group);
    const to = this.group(groupId);
    if (!tab || !to || from === to) return;
    tab.group = groupId;
    tab.lent = lent;
    if (from.current === id) from.current = this.in(from.id)[0]?.id || null;
    if (!to.current || id === this.activeId) to.current = id;
    if (!this.in(YOU).length) this.create('', { show: false });
    this.emit('change');
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
    if (a.width < 1 || a.height < 1) return;
    const d = tab.device;
    const peekX = a.x + a.width - 1;
    if (!d) return tab.view.setBounds(tab.peeking ? { ...a, x: peekX } : a);
    // Whole view pixels first, then the zoom that makes them exactly d.width wide.
    const width = Math.floor(d.width * Math.min(1, a.width / d.width, a.height / d.height));
    const zoom = width / d.width;
    const height = Math.round(d.height * zoom);
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
    const owner = (d) => this.list.find((t) => t.wc.id === d.webContentsId);
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
    // approval page asks for the relay key), however they get there.
    this.ses.webRequest.onBeforeRequest(all, (d, done) => {
      const tab = owner(d);
      let origin = '';
      try { origin = new URL(d.url).origin; } catch {}
      done({ cancel: !!tab && tab.group !== YOU && this.relayOrigins.has(origin) });
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
      for (const g of others) {
        items.push({ label: `Give to ${g.label}`, click: () => this.move(id, g.id, { lent: true }) });
      }
    } else {
      items.push({ label: 'Take back', click: () => this.move(id, YOU) });
    }
    if (items.length) items.push({ type: 'separator' });
    items.push({ label: 'Close tab', click: () => this.close(id) });
    Menu.buildFromTemplate(items).popup({ window: this.win });
  }

  // What the window chrome needs to draw the tab strip and toolbar.
  summary() {
    return this.list.map((t) => ({
      id: t.id,
      group: t.group,
      title: t.title || (t.url && t.url !== 'about:blank' ? t.url : 'New tab'),
      url: t.url === 'about:blank' ? '' : t.url,
      favicon: t.favicon,
      loading: t.loading,
      active: t.id === this.activeId,
      current: this.group(t.group)?.current === t.id,
      canGoBack: t.wc.navigationHistory.canGoBack(),
      canGoForward: t.wc.navigationHistory.canGoForward(),
      device: t.device ? t.device.label || `${t.device.width}×${t.device.height}` : null,
    }));
  }
}

module.exports = { Tabs, PRESETS, toUrl, YOU };
