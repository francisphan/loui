// Tabs and tab groups. One WebContentsView per tab; every tab belongs to a
// group. The 'you' group is the user's own tabs. Each Claude session gets a
// group of its own and works only inside it.
//
// All views stay attached to their window, stacked, with the tab the user is
// looking at on top and an opaque backdrop under it. A tab that is attached but
// covered can still be captured and sent input without taking focus; a detached
// or off-screen one cannot, which is why they are stacked rather than hidden.
//
// One more condition, found by experiment: a page only renders and takes
// clicks if its view was in sight while the page loaded. So while a background
// tab is loading it "peeks": it sits on top, shifted so that a single column
// of pixels shows at the right edge of the page area, and it is tucked back
// underneath when the load is done. Its size never changes, so the page
// cannot tell. A tab moved to another window peeks there the same way.
//
// Speed and memory. A covered view still counts as visible, so Chromium never
// throttles it. The user's own background tabs are therefore hidden as well
// as covered (see rest()), and throttled like in any browser; tabs in a Claude
// session's group stay in sight, unthrottled, so the session can work in them.
// A tab can also be put to sleep (sleep.js decides when): its view and page
// are destroyed and only what the tab strip shows and its history are kept,
// until it is woken by being selected or used by Claude.
//
// Windows. Loui can have several; each is a BrowserWindow with its own window
// chrome (src/ui) and its own stack of views and backdrop. One Tabs object
// keeps every tab and group of every window; each tab belongs to one window
// (tab.window). What is per window lives on the window object: which tab is
// on screen (activeId), where the page area is (area), the backdrop. The rest
// (groups, sessions, history, downloads, bookmarks, Shields...) is app-wide.
//
// A Claude session's group lives in one window (group.window): the normal
// window the user focused last when the session started. Its tabs follow it
// when it is moved to another window, and its tools work wherever it is.
//
// A private window has an in-memory session (see main.js: shared by the
// private windows open at the same time, cleared when the last one closes).
// Its tabs are the user's, marked private (tab.private), and keep that session
// for life (tab.ses): one the user hands to a Claude session moves to the
// session's window but stays private, and closes with the last private window.
//
// Code that asks about "the tab on screen" without naming a window (active(),
// activeId) gets the window being served: the one whose chrome sent the
// request, or whose state is being drawn (see as()), else the focused one.
const { WebContentsView, View, Menu, clipboard, nativeTheme } = require('electron');
const { EventEmitter } = require('events');
const path = require('path');
const { requestRules } = require('./requests');
const { searchFor, searchName } = require('./search');

const YOU = 'you';
// Loui's start page (startpage.js), which the user's new tabs open with. To
// the window it is a new tab: no address, "New tab" as its title.
const START = 'loui-start://tab';
const onStart = (url) => /^loui-start:/i.test(url || '');
const blank = (url) => !url || url === 'about:blank' || onStart(url);
const LOG_LIMIT = 500;
const ICON_BYTES = 150 * 1024; // the most a page's icon may weigh
const ICON_MS = 5000; // and the longest fetching it may take
const OPEN_WITHIN = 5000; // a page may open a tab this long after an action in it
const OPEN_MAX = 10; // and this many in a minute
const FULL_WITHIN = 3000; // a page may take the whole screen this long after the user's own input in it
const clipped = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '…' : s; };
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
  constructor(ses) {
    super();
    this.ses = ses; // the user's own session; a private tab has another (tab.ses)
    this.windows = [];
    this.focused = null; // the window the user focused last
    this.viewer = null; // the window being served just now (see as())
    this.windowSeq = 0;
    // Set by main.js: opens a window ({ private, blank }) and returns it, for
    // when one has to exist (a session's group with no window left to go to).
    this.openWindow = null;
    this.list = [];
    // busy/status/paused describe the Claude session working in the group.
    this.groups = [{ id: YOU, label: 'You', source: null, current: null, busy: 0, status: '', paused: false }];
    this.seq = 0;
    this.relayOrigins = new Set();
    this.ending = new WeakSet(); // pages Loui is ending itself (see the 'destroyed' listener in build())
    this.iconSeq = 0;
    this.setMaxListeners(50); // every module listens for changes
    this.watchNetwork(ses);
  }

  // ── windows ──

  addWindow(win, { private: priv = false, ses = this.ses } = {}) {
    const w = {
      id: ++this.windowSeq, win, ses, private: priv, activeId: null, focusedAt: Date.now(),
      area: { x: 0, y: 80, width: 800, height: 600 }, backdrop: new View(),
    };
    const tint = () => w.backdrop.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#101B22' : '#E6EDEF');
    tint();
    nativeTheme.on('updated', tint);
    win.once('closed', () => nativeTheme.off('updated', tint));
    win.contentView.addChildView(w.backdrop);
    win.on('focus', () => this.focus(w));
    // Leaving full screen by any road (F11, Esc, the system) gives Loui's own parts back.
    win.on('leave-full-screen', () => {
      w.wide = false;
      // This can arrive late: the window leaving F11 after a page has already
      // taken the screen for itself. Then it is about what came before, and
      // the page keeps the screen. Otherwise the page is told to let go too:
      // a window out of full screen with its page still "in" would show that
      // page as an ordinary one, stuck.
      const held = this.get(w.full);
      if (!held || Date.now() - (held.fullAt || 0) > 1500) this.unfull(w, { leave: true });
      const tab = this.get(w.activeId);
      if (tab?.view) this.place(tab);
      this.emit('change');
    });
    win.on('resize', () => { const tab = this.get(w.activeId); if (tab?.view && (w.full || w.wide)) this.place(tab); });
    // errorpage.js tells a page whether it is on screen, which a minimized window's is not.
    for (const event of ['minimize', 'restore', 'hide', 'show']) win.on(event, () => this.emit('change'));
    this.windows.push(w);
    this.focused = w; // a new window opens in front
    return w;
  }

  focus(w) {
    w.focusedAt = Date.now();
    if (this.focused === w) return;
    this.focused = w;
    this.emit('focus', w);
  }

  // The window is closing: its own tabs close, and sessions' groups in it
  // move to another normal window (the sessions are not over). Tabs of a
  // private session close once no private window is left.
  removeWindow(w) {
    if (!this.windows.includes(w)) return;
    this.windows = this.windows.filter((x) => x !== w);
    if (this.focused === w) this.focused = [...this.windows].sort((a, b) => b.focusedAt - a.focusedAt)[0] || null;
    if (this.viewer === w) this.viewer = null;
    const alive = (tab) => !tab.private || this.windows.some((x) => x.ses === tab.ses);
    for (const g of this.groups) {
      if (g.id === YOU || g.window !== w) continue;
      g.window = this.normalWindow();
      for (const tab of this.in(g.id)) {
        if (g.window && alive(tab)) this.relocate(tab, g.window);
        else this.discard(tab);
      }
    }
    for (const tab of this.list.filter((t) => t.window === w || !alive(t))) this.discard(tab);
    w.activeId = null;
    this.emit('change');
  }

  // Closes a tab without the rules close() keeps (a window always has a tab,
  // another tab takes the screen): its window is going away.
  discard(tab) {
    if (!this.list.includes(tab)) return;
    this.emit('closing', tab);
    this.list.splice(this.list.indexOf(tab), 1);
    this.emit('leaving', tab);
    clearTimeout(tab.tuckTimer);
    if (tab.view) {
      if (!tab.window.win.isDestroyed()) tab.window.win.contentView.removeChildView(tab.view);
      if (!tab.wc.isDestroyed()) { this.ending.add(tab.wc); tab.wc.close(); }
    }
    const g = this.group(tab.group);
    if (g?.current === tab.id) g.current = this.fallback(g)?.id || null;
  }

  // The window being served (see the note at the top).
  window() {
    return this.viewer || this.focused || this.windows[0] || null;
  }

  // Runs fn with w as the window being served, for code that asks about "the
  // tab on screen". Synchronous only: what fn starts for later runs without it.
  as(w, fn) {
    const was = this.viewer;
    this.viewer = w || was;
    try { return fn(); } finally { this.viewer = was; }
  }

  // The normal (not private) window the user focused last.
  normalWindow() {
    return this.windows.filter((w) => !w.private).sort((a, b) => b.focusedAt - a.focusedAt)[0] || null;
  }

  // The window a group's tabs go in. A session's group without one (its
  // window closed, or only private windows are open) gets the last focused
  // normal window, or a new one.
  windowFor(groupId) {
    const g = this.group(groupId);
    if (!g || g.id === YOU) return this.window();
    if (!g.window || !this.windows.includes(g.window)) g.window = this.normalWindow() || this.openWindow?.({}) || null;
    return g.window;
  }

  windowOf(webContents) {
    return this.windows.find((w) => !w.win.isDestroyed() && w.win.webContents === webContents) || null;
  }

  // For code written for a single window: the window being served.
  get win() { return this.window()?.win; }
  get activeId() { return this.window()?.activeId ?? null; }
  get area() { return this.window()?.area; }

  // Whether a tab is the one on screen in its window.
  onScreen(tab) {
    return !!tab && tab.window?.activeId === tab.id;
  }

  // A group's tab to make current when its current one goes. The Claude panel
  // works in the user's current tab, which is never a private one.
  fallback(g, near = null) {
    const ok = (t) => !!t && !(g.id === YOU && t.private);
    if (ok(near)) return near;
    return this.in(g.id).find(ok) || null;
  }

  // ── tabs ──

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
  // Never a private tab for the user's own group: that is the tab the Claude
  // panel works in, and it must not see a private window's pages.
  current(groupId) {
    const tab = this.get(this.group(groupId)?.current);
    return groupId === YOU && tab?.private ? null : tab;
  }

  // show: put the new tab on screen. Left unset, a tab opened in the group the
  // user is watching is shown, and one opened elsewhere stays in the background.
  // device and history: what a restored tab had (see restore.js). asleep: a
  // restored tab with history starts asleep unless shown, and loads when woken.
  // pinned: only for the user's own tabs (see pin()). window: for the user's
  // tabs, the window it opens in (the window being served if left out); a
  // session's tabs open in its group's window.
  // adopt: a page of Chromium's own making to put in the tab (what a page
  // opened with window.open: see the window-open handler), not one made here.
  create(url, { group = YOU, show, device, history, asleep = false, pinned = false, window, adopt = null, opener = null } = {}) {
    const w = group === YOU ? (window || this.window()) : this.windowFor(group);
    // A new tab of the user's, given no address, opens with what Settings says
    // (startpage.js). A session's new tab is blank.
    if (!url && !history && group === YOU && !adopt) url = this.newTab?.() || '';
    const tab = {
      id: ++this.seq, view: null, wc: null, group, lent: false, title: '', url: '', favicon: null,
      loading: false, console: [], network: [], pointer: null, device: null, shotScale: 1,
      asleep: false, history: null, seenAt: Date.now(), pinned: pinned && group === YOU,
      // A pop-up's page is in its opener's session whichever window it is shown
      // in (a private tab lent to a session sits in a normal window).
      window: w, ses: opener ? opener.ses : w.ses, private: opener ? opener.private : w.private,
      openerId: opener?.id || null, // the tab whose page opened this one (a pop-up)
    };
    // A pop-up sits beside the tab that opened it.
    if (opener && this.list.includes(opener)) this.list.splice(this.list.indexOf(opener) + 1, 0, tab);
    else this.list.push(tab);
    this.tidy(); // a new tab goes at the end of its group
    const g = this.group(group);
    const shown = this.get(w.activeId);
    const watching = shown?.group === group;
    if (!g.current && !(group === YOU && tab.private)) g.current = tab.id;
    // Before loading, so the first request has its user agent.
    tab.device = (typeof device === 'string' ? PRESETS[device] : device) || null;
    show = show ?? (watching || !shown);
    if (asleep && history && !show) {
      tab.asleep = true;
      tab.history = history;
      const first = history.entries[history.index] || history.entries[0];
      tab.url = first?.url || '';
      tab.title = first?.title || '';
      this.emit('change');
      return tab;
    }
    this.open(tab, show, { url, history, adopt });
    return tab;
  }

  // What every tab's page is made with.
  pagePreferences(ses) {
    return { session: ses, sandbox: true, contextIsolation: true, preload: path.join(__dirname, 'tab-preload.js') };
  }

  // Gives a tab a new view and loads its page (or its history) into it, in
  // sight while it loads (see the note at the top).
  open(tab, show, { url, history, adopt = null }) {
    this.build(tab, adopt);
    tab.window.win.contentView.addChildView(tab.view);
    if (show) this.select(tab.id);
    else this.peek(tab);
    this.rest(tab);
    const wc = tab.wc;
    // An adopted page is loaded by Chromium, for the page that opened it; the
    // agent it should carry is settled first (identity.js).
    if (adopt) this.emit('adopted', tab, url);
    else if (history) wc.navigationHistory.restore(history).catch(() => wc.isDestroyed() || wc.loadURL(toUrl(url || '')).catch(() => {}));
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
  // title, icon and history stay. A tab on screen never sleeps. sleep.js
  // decides which tabs may.
  sleep(tab) {
    // Not while a page it opened is still open: that page would go with it (a sign-in, half done).
    if (this.list.some((t) => t.openerId === tab.id && t.wc)) return;
    if (!tab || tab.asleep || this.onScreen(tab) || !tab.wc || tab.wc.isDestroyed()) return false;
    const nav = tab.wc.navigationHistory;
    const entries = nav.getAllEntries();
    // Kept with each entry's page state, which brings back the scroll position.
    tab.history = entries.length ? { entries, index: nav.getActiveIndex() } : null;
    this.emit('leaving', tab); // its page goes away, as if it navigated
    clearTimeout(tab.tuckTimer);
    tab.peeking = false;
    tab.window.win.contentView.removeChildView(tab.view);
    this.ending.add(tab.wc);
    tab.wc.close();
    tab.view = tab.wc = null;
    tab.asleep = true;
    tab.loading = false;
    tab.pointer = null;
    this.emit('change');
    return true;
  }

  // A view and its page for a tab, with the page's events wired to it.
  build(tab, adopt = null) {
    const view = new WebContentsView(adopt ? { webContents: adopt } : {
      // Throttled in the background unless a Claude session works in it (see rest()).
      // The preload gives the page itself nothing (see tab-preload.js).
      webPreferences: this.pagePreferences(tab.ses),
    });
    view.setBackgroundColor('#ffffff');
    const wc = view.webContents;
    tab.view = view;
    tab.wc = wc;
    tab.audible = false;
    tab.throttled = true; // as the view is made; rest() changes it
    if (tab.device) wc.setUserAgent(tab.device.mobile ? MOBILE_UA : tab.ses.getUserAgent());
    const changed = () => this.emit('change');

    wc.on('page-title-updated', (_e, title) => { tab.title = title; changed(); });
    wc.on('page-favicon-updated', (_e, icons) => this.icon(tab, icons[0] || null));
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
      tab.icon = null;
      tab.iconUrl = null;
      tab.actedAt = 0; // an action on the page left does not let the new one open tabs
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
      tab.icon = null;
      tab.iconUrl = null;
      this.emit('failed', tab, { code, reason, url: failedUrl }); // errorpage.js draws the page
      changed();
    });
    wc.on('console-message', (e, ...old) => {
      // Electron passes one details object; older builds passed positional args.
      const d = e.message !== undefined ? e
        : { level: ['debug', 'info', 'warning', 'error'][old[0]], message: old[1], lineNumber: old[2], sourceId: old[3] };
      keep(tab.console, {
        level: d.level, text: clipped(d.message, 2000), source: clipped(d.sourceId, 300), line: d.lineNumber, at: Date.now(),
      });
    });
    wc.on('render-process-gone', (_e, details) => {
      tab.title = `Page crashed (${details.reason})`;
      changed();
      if (details.reason !== 'clean-exit') this.emit('crashed', tab, details); // errorpage.js draws the page
    });
    // A page's new window becomes a new tab in the same group (and window).
    // Only soon after someone acted in the tab (the user's keys and mouse, or
    // a session's), and only so many: Electron has no popup blocker of its own.
    // tab.userAt: when the user's own keys or mouse last reached the page. What
    // Loui sends it (a session's tools, in actions.js) arrives here the same
    // way, inside the call that sends it, and is not the user's.
    const sendInput = wc.sendInputEvent.bind(wc);
    wc.sendInputEvent = (...args) => { tab.sending = true; try { return sendInput(...args); } finally { tab.sending = false; } };
    const acted = () => { tab.actedAt = Date.now(); if (!tab.sending) tab.userAt = tab.actedAt; };
    wc.on('before-input-event', acted);
    // Presses only: the pointer entering or crossing the page is not an action.
    wc.on('before-mouse-event', (_e, mouse) => {
      if (mouse.type === 'mouseDown' || mouse.type === 'mouseUp') acted();
      if (mouse.type === 'mouseDown' && !tab.sending) this.emit('pressed', tab); // the user's own press (the address bar lets go)
      // The pointer at the top edge of a page that has the whole window (fullscreen.js says how to leave).
      else if (mouse.type === 'mouseMove' && mouse.y <= 2 && this.isFull(tab)) this.emit('pointer-top', tab);
    });
    // A page's new window becomes a new tab in the same group and window. It
    // is the page Chromium makes for the opener, put in a tab (create's
    // adopt), so that the two can still reach each other: a sign-in pop-up
    // reports back to the page that opened it (window.opener) and then closes
    // itself. A tab made afresh for the address would have no opener, and
    // such a sign-in could never finish.
    wc.setWindowOpenHandler(({ url: to, disposition }) => {
      if (!/^https?:|^about:blank/i.test(to) || !this.mayOpen(tab)) return { action: 'deny' };
      const show = this.onScreen(tab) && disposition !== 'background-tab';
      return {
        action: 'allow',
        overrideBrowserWindowOptions: { webPreferences: this.pagePreferences(tab.ses) },
        createWindow: (options) => {
          const opened = this.create(to, { group: tab.group, window: tab.window, show, adopt: options.webContents, opener: tab });
          if (disposition !== 'background-tab' && !(tab.group === YOU && opened.private)) {
            this.group(tab.group).current = opened.id;
          }
          return opened.wc;
        },
      };
    });
    // A page that closes itself (window.close() in a pop-up, once it has done
    // its work) takes its tab with it, at once: nothing may be left holding a
    // page that is gone. A page Loui itself ends (a tab closed, put to sleep,
    // made blank) is marked in this.ending first, and is not this.
    wc.once('destroyed', () => {
      if (this.ending.has(wc) || tab.wc !== wc || !this.list.includes(tab)) return; // ended from here
      if (!this.windows.includes(tab.window) || tab.window.win.isDestroyed()) return; // its window is going, and all its pages with it
      // Its page is gone already: close() has only the empty view to take away.
      try { tab.window.win.contentView.removeChildView(tab.view); } catch {}
      tab.view = tab.wc = null;
      // And the user is back on the page it was opened from (where a sign-in
      // that just finished shows), not on whichever tab was beside it.
      const from = this.get(tab.openerId);
      const back = from && from.window === tab.window && from.group === tab.group && this.onScreen(tab);
      this.close(tab.id);
      if (back && this.list.includes(from)) { this.select(from.id); from.wc?.focus(); }
    });
    wc.on('context-menu', (_e, p) => this.contextMenu(tab, p));
    wc.on('audio-state-changed', (e) => { tab.audible = !!e.audible; this.rest(tab); });
    // A page asking for the whole screen (a video's full-screen button) gets
    // the whole window: its view covers the tabs, the toolbar and the panel
    // until it lets go (Esc). Only the tab on screen: one in the background,
    // a session's at work say, is told no. And only when the user's own click
    // or key reached the page just before: a Claude session's click cannot
    // take the window away, nor a page on its own.
    wc.on('enter-html-full-screen', () => {
      if (!this.onScreen(tab) || Date.now() - (tab.userAt || 0) > FULL_WITHIN) {
        // Told to let go, and told again: the page may not have finished going
        // in when the first word arrives, and would then stay in while Loui
        // shows it as an ordinary page.
        this.tellOut(tab);
        return;
      }
      tab.window.full = tab.id;
      tab.fullAt = Date.now();
      this.place(tab);
      tab.window.win.contentView.addChildView(tab.view); // in front of everything of Loui's
      changed();
    });
    wc.on('leave-html-full-screen', () => this.unfull(tab.window));
    // Before its first load, so other modules can watch its navigations. Also
    // when a sleeping tab wakes, since it then has a new page.
    this.emit('created', tab);
  }

  // The user asked for the address this tab now loads: the address bar, a
  // bookmark, the palette, a link from another app, a tab of theirs opened
  // or restored. Not an address a session or a page had it load. Returns the tab.
  byUser(tab) {
    if (tab) tab.loadedAt = Date.now();
    return tab;
  }

  // Whether what the tab's page does now can be put down to someone: an action
  // in the tab (keys, mouse, a session's) or an address the user had it load
  // (byUser), within ms. Downloads and hand-overs to the other browser ask this.
  recent(tab, ms = OPEN_WITHIN) {
    return Date.now() - Math.max(tab.actedAt || 0, tab.loadedAt || 0) <= ms;
  }

  // Whether a page may open a tab now: within OPEN_WITHIN of an action in the
  // tab, and at most OPEN_MAX in a minute.
  mayOpen(tab) {
    const now = Date.now();
    if (now - (tab.actedAt || 0) > OPEN_WITHIN) return false;
    tab.opened = (tab.opened || []).filter((at) => now - at < 60000);
    if (tab.opened.length >= OPEN_MAX) return false;
    tab.opened.push(now);
    return true;
  }

  // The page's icon. Its bytes are fetched through the tab's own session (a
  // private tab's never pass through another session's cache or cookies) and
  // kept here; the window chrome shows them through loui-icon: (iconResponse),
  // so it loads nothing from the web and it, a sandboxed page, does the
  // decoding. At most ICON_BYTES and ICON_MS: the address is the page's choice.
  async icon(tab, url) {
    tab.iconUrl = url;
    let icon = null;
    if (url && /^data:image\//i.test(url)) {
      const m = url.length <= ICON_BYTES * 2 && /^data:([^;,]*)[^,]*?(;base64)?,(.*)$/is.exec(url);
      try {
        if (m) icon = { type: m[1].toLowerCase(), bytes: m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3])) };
      } catch {}
    } else if (url && /^https?:/i.test(url) && !this.relayOrigins.has(new URL(url).origin)) {
      const stop = new AbortController();
      const timer = setTimeout(() => stop.abort(), ICON_MS);
      try {
        const res = await tab.ses.fetch(url, { cache: 'force-cache', signal: stop.signal });
        if (res.ok && !(Number(res.headers.get('content-length')) > ICON_BYTES)) {
          const parts = [];
          let size = 0;
          for await (const part of res.body) {
            size += part.length;
            if (size > ICON_BYTES) { stop.abort(); break; }
            parts.push(part);
          }
          if (size && size <= ICON_BYTES) {
            icon = { type: (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase(), bytes: Buffer.concat(parts) };
          }
        }
      } catch {} finally {
        clearTimeout(timer);
      }
    }
    if (icon?.bytes.length > ICON_BYTES || !icon?.bytes.length) icon = null;
    if (tab.iconUrl !== url || !this.list.includes(tab)) return; // the page moved on meanwhile
    tab.icon = icon;
    tab.favicon = icon ? `loui-icon://tab/${tab.id}/${++this.iconSeq}` : null;
    this.emit('change');
  }

  // For the loui-icon: protocol of the window chrome (main.js): a tab's icon.
  iconResponse(url) {
    const id = Number(/^loui-icon:\/\/tab\/(\d+)\//.exec(url)?.[1]);
    const icon = this.get(id)?.icon;
    if (!icon) return new Response('', { status: 404 });
    // Only pictures are served as what they say they are; anything else is left to the <img> to sniff.
    const type = /^image\/[\w.+-]+$/.test(icon.type) ? icon.type : 'application/octet-stream';
    return new Response(icon.bytes, { headers: { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
  }

  // A tab's icon as a data: URL (for a bookmark of its page), or null.
  iconData(tab) {
    const icon = tab?.icon;
    return icon && /^image\//.test(icon.type) ? `data:${icon.type};base64,${icon.bytes.toString('base64')}` : null;
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
    const visible = full || tab.peeking || this.onScreen(tab);
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

  // Puts a tab on screen and brings its window to the front.
  reveal(id) {
    const tab = this.select(id);
    const win = tab?.window?.win;
    if (!win || win.isDestroyed()) return tab;
    if (win.isMinimized()) win.restore();
    win.focus();
    return tab;
  }

  // Put a tab on screen in its window. It also becomes its group's current
  // tab (for the user's group, unless it is private: see fallback()).
  // F11: the page on screen takes the whole screen, with nothing of Loui's
  // around it, as in other browsers; F11 again gives it back.
  fullScreen(w) {
    if (!w || w.win.isDestroyed()) return;
    const on = !w.wide;
    if (!on && w.full) this.unfull(w, { leave: true });
    w.wide = on;
    w.win.setFullScreen(on);
    const tab = this.get(w.activeId);
    if (tab?.view) {
      this.place(tab);
      if (on) w.win.contentView.addChildView(tab.view);
    }
    this.emit('change');
  }

  // Whether a tab's page has the whole window, by either road.
  isFull(tab) {
    const w = tab?.window;
    return !!w && (w.full === tab.id || (!!w.wide && w.activeId === tab.id));
  }

  // Out of full screen of both kinds: Loui has something to show in the window.
  leaveFull(w) {
    if (!w || w.win.isDestroyed()) return;
    if (w.wide) this.fullScreen(w);
    else if (w.full) this.unfull(w, { leave: true });
  }

  // A page that has, or is about to have, the screen for itself is told to
  // let go, and told again for a moment: one word can arrive before the page
  // has finished going in, and it would then stay in while Loui shows it as
  // an ordinary page. Stops once the page has the screen again by right.
  tellOut(tab) {
    const wc = tab.wc;
    const w = tab.window;
    const out = () => {
      if (!wc || wc.isDestroyed() || w.full === tab.id) return;
      wc.executeJavaScript('document.fullscreenElement && document.exitFullscreen()', true).catch(() => {});
      // The window must not be left full screen on its account either.
      if (!w.full && !w.wide && !w.win.isDestroyed() && w.win.isFullScreen()) w.win.setFullScreen(false);
    };
    out();
    for (const ms of [150, 400, 1000, 2000]) setTimeout(out, ms);
  }

  // The window's page gives the whole window back: on its own (Esc), or
  // because another tab is to be shown or its tab is going.
  unfull(w, { leave = false } = {}) {
    const tab = this.get(w?.full);
    if (!w?.full) return;
    w.full = null;
    if (leave && tab) this.tellOut(tab);
    if (leave && !w.win.isDestroyed() && w.win.isFullScreen() && !w.wide) w.win.setFullScreen(false);
    if (tab?.view) this.place(tab);
    this.emit('change');
  }

  select(id) {
    const tab = this.get(id);
    if (!tab) return null;
    const w = tab.window;
    if (w.full && w.full !== id) this.unfull(w, { leave: true });
    const now = Date.now();
    const leaving = this.get(w.activeId);
    if (leaving) leaving.seenAt = now; // the tab the user is leaving was seen until now
    tab.seenAt = now;
    w.activeId = id;
    this.wake(tab);
    if (!(tab.group === YOU && tab.private)) this.group(tab.group).current = id;
    tab.peeking = false;
    const stack = w.win.contentView;
    stack.addChildView(w.backdrop);
    stack.addChildView(tab.view); // re-adding moves it to the top
    for (const other of this.list) if (other.peeking && other.window === w) stack.addChildView(other.view);
    this.place(tab);
    this.restAll();
    this.emit('change');
    return tab;
  }

  // See the note at the top of this file.
  peek(tab) {
    if (this.onScreen(tab) || !tab.wc || tab.wc.isDestroyed()) return;
    tab.peeking = true;
    tab.view.setVisible(true);
    tab.window.win.contentView.addChildView(tab.view);
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
    // A tab closed while it peeked still has its timer: its page is gone, and asking it anything throws.
    if (!tab.peeking || !tab.wc || tab.wc.isDestroyed() || tab.wc.isLoadingMainFrame?.()) return;
    tab.peeking = false;
    if (this.onScreen(tab) || tab.wc.isDestroyed() || !this.list.includes(tab)) return;
    tab.window.win.contentView.addChildView(tab.view, 0);
    this.place(tab);
    this.rest(tab);
  }

  // Point a session at one of its group's tabs. The screen follows only if the
  // user is already watching that group in the tab's window.
  setCurrent(groupId, id) {
    const tab = this.get(id);
    if (tab && this.get(tab.window.activeId)?.group === groupId) return this.select(id);
    if (!(groupId === YOU && tab?.private)) this.group(groupId).current = id;
    this.emit('change');
    return tab;
  }

  close(id) {
    const tab = this.get(id);
    if (!tab) return;
    const w = tab.window;
    const peers = this.in(tab.group).filter((t) => t.window === w);
    const next = peers[peers.indexOf(tab) + 1] || peers[peers.indexOf(tab) - 1] || null;
    if (w.full === id) this.unfull(w, { leave: true });
    this.emit('closing', tab); // still in the list, its page and history intact
    this.list.splice(this.list.indexOf(tab), 1);
    this.emit('leaving', tab);
    if (tab.view) { // a sleeping tab has no page to close
      w.win.contentView.removeChildView(tab.view);
      this.ending.add(tab.wc);
      tab.wc.close();
    }
    const g = this.group(tab.group);
    if (g && g.current === id) g.current = this.fallback(g, next)?.id || null;
    const wasOnScreen = w.activeId === id;
    if (wasOnScreen) w.activeId = null;
    this.ensure(w);
    if (wasOnScreen) this.showOther(w, next);
    this.emit('change');
  }

  // A window always has one of the user's tabs, as the single window always
  // had: a new blank one if the last goes. moved: the user moved its last tab
  // to another window, and a window left with no tab at all then closes
  // instead (main.js hears 'empty'), as in other browsers. (A tab handed to a
  // session leaves a blank one: closing a private window would end its session.)
  ensure(w, { moved = false } = {}) {
    if (!this.windows.includes(w) || this.list.some((t) => t.window === w && t.group === YOU)) return;
    if (moved && this.windows.length > 1 && !this.list.some((t) => t.window === w)) return void this.emit('empty', w);
    this.create('', { window: w, show: false });
  }

  // The tab on screen in w went (closed, or moved away): another takes its place.
  showOther(w, near) {
    if (w.activeId || !this.windows.includes(w)) return;
    const mine = (t) => t?.window === w;
    const you = this.current(YOU);
    const pick = (mine(near) && near) || (mine(you) && you) ||
      this.list.find((t) => mine(t) && t.group === YOU) || this.list.find(mine);
    if (pick) this.select(pick.id);
  }

  // Moves a tab's view into another window. It peeks there until it has drawn
  // (see the note at the top), unless the caller then puts it on screen.
  relocate(tab, w) {
    const from = tab.window;
    if (from === w) return;
    const wasOnScreen = from.activeId === tab.id;
    if (wasOnScreen) from.activeId = null;
    if (tab.view) {
      if (!from.win.isDestroyed()) from.win.contentView.removeChildView(tab.view);
      w.win.contentView.addChildView(tab.view, 0);
    }
    tab.window = w;
    if (tab.view) {
      this.peek(tab);
      this.tuckWhenDrawn(tab);
    }
    if (wasOnScreen) this.showOther(from);
  }

  // The user's tab to another window (the tab menu, or dragged out of the tab
  // strip), at index among the user's tabs there (the end if left out), on
  // screen there. A private tab goes only to another private window, and a
  // normal one only to a normal one. A session's tab takes its group along.
  toWindow(id, w, { index } = {}) {
    const tab = this.get(id);
    if (!tab || !w || !this.windows.includes(w)) return;
    if (tab.group !== YOU) return this.groupToWindow(tab.group, w);
    if (tab.private !== w.private || tab.ses !== w.ses) return;
    const from = tab.window;
    this.relocate(tab, w);
    this.reorder(id, index ?? Infinity);
    this.select(id);
    this.ensure(from, { moved: true });
    this.emit('change');
  }

  // A session's group to another window. Sessions never work in a private window.
  groupToWindow(groupId, w) {
    const g = this.group(groupId);
    if (!g || g.id === YOU || !w || w.private || !this.windows.includes(w)) return;
    const from = g.window;
    g.window = w;
    for (const tab of this.in(groupId)) this.relocate(tab, w);
    if (from) this.ensure(from);
    this.emit('change');
  }

  addGroup({ id, label, source }) {
    this.groups.push({ id, label, source, current: null, busy: 0, status: '', paused: false, window: this.normalWindow() });
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
  // A tab handed to a session goes to the session's window, and back to the
  // window it came from (if still open) when it returns.
  move(id, groupId, { lent = false, at = Infinity } = {}) {
    const tab = this.get(id);
    const from = this.group(tab?.group);
    const to = this.group(groupId);
    if (!tab || !to || from === to) return;
    let dest = tab.window;
    if (groupId !== YOU) {
      dest = this.windowFor(groupId);
      if (!dest) return;
      if (from.id === YOU) tab.home = tab.window;
    } else {
      const home = [tab.home, tab.window].find((w) => w && this.windows.includes(w) && w.ses === tab.ses);
      dest = home || this.windows.find((w) => w.ses === tab.ses) || (tab.private ? null : tab.window);
      tab.home = null;
      if (!dest) return this.close(id); // a private tab whose private windows have all closed
    }
    if (from.id === YOU) this.unstart(tab);
    this.sever(tab);
    const left = tab.window;
    this.emit('handed', tab); // whoever had it lets go of what it left in the page (actions.js)
    // What the tab logged for whoever had it is not the next one's to read.
    tab.console = [];
    tab.network = [];
    tab.pointer = null;
    tab.group = groupId;
    tab.lent = lent;
    tab.pinned = false; // pinning is for the user's own tabs, and one coming back lands among the others
    if (from.current === id) from.current = this.fallback(from)?.id || null;
    if ((!to.current || this.onScreen(tab)) && !(groupId === YOU && tab.private)) to.current = id;
    this.relocate(tab, dest);
    this.reorder(id, at);
    this.ensure(left);
    this.showOther(left); // the blank tab that took a handed-over last tab's place goes on screen
    this.restAll(); // in a session's group a tab runs at full speed; back with the user it rests
    this.emit('change');
  }

  // A tab on Loui's start page stops being the user's own (handed to a
  // session): the page lists the sites the user visits, which are not a
  // session's to read. Its page is thrown away and a blank one made in its
  // place, there and then: navigating it away would take a moment, in which a
  // session could read it. The start page goes from the tab's history too.
  // A tab changing hands must not stay joined to pages that do not: a page
  // and the pop-up it opened hold each other (window.opener, the handle
  // window.open returned) and could drive one another across the line. So
  // the tab gets a new page of its own for the same address and history.
  // Pop-ups it opened itself close with its old page.
  kin(tab) {
    return this.list.filter((t) => t !== tab && (t.openerId === tab.id || t.id === tab.openerId));
  }
  sever(tab) {
    const kin = this.kin(tab);
    tab.openerId = null;
    for (const t of kin) if (t.openerId === tab.id) t.openerId = null;
    if (!kin.some((t) => t.wc) || !tab.wc || tab.wc.isDestroyed()) return;
    const nav = tab.wc.navigationHistory;
    const entries = nav.getAllEntries();
    const history = entries.length ? { entries, index: nav.getActiveIndex() } : null;
    const shown = this.onScreen(tab);
    this.emit('leaving', tab);
    clearTimeout(tab.tuckTimer);
    tab.peeking = false;
    tab.window.win.contentView.removeChildView(tab.view);
    this.ending.add(tab.wc);
    tab.wc.close();
    tab.view = tab.wc = null;
    this.open(tab, shown, { url: tab.url, history });
  }

  unstart(tab) {
    const nav = tab.wc && !tab.wc.isDestroyed() ? tab.wc.navigationHistory : null;
    const entries = nav ? nav.getAllEntries() : tab.history?.entries || [];
    const index = nav ? nav.getActiveIndex() : tab.history?.index || 0;
    if (!onStart(tab.url) && !onStart(entries[index]?.url) && !onStart(tab.wc?.getURL())) return;
    const history = entries.length
      ? { entries: entries.map((e) => (onStart(e.url) ? { url: 'about:blank', title: '' } : e)), index } : null;
    tab.url = 'about:blank';
    tab.title = '';
    tab.favicon = tab.icon = tab.iconUrl = null;
    tab.history = history;
    if (!tab.wc) return; // asleep: it wakes on the blank page
    const shown = this.onScreen(tab);
    this.emit('leaving', tab);
    clearTimeout(tab.tuckTimer);
    tab.peeking = false;
    tab.window.win.contentView.removeChildView(tab.view);
    if (!tab.wc.isDestroyed()) { this.ending.add(tab.wc); tab.wc.close(); }
    tab.view = tab.wc = null;
    this.open(tab, shown, { url: 'about:blank', history });
  }

  // Keeps each group's tabs together, in the order of the groups, with the
  // user's pinned tabs first, so the list reads as the tab strip does (Ctrl+Tab
  // and restore.js follow the list). The sort is stable: order within a group stays.
  tidy() {
    const rank = (t) => this.groups.findIndex((g) => g.id === t.group) * 2 + (t.pinned ? 0 : 1);
    this.list.sort((a, b) => rank(a) - rank(b));
  }

  // Puts a tab at a place among its own group's tabs in its window: index
  // counts the group's other tabs there before it. Pinned tabs stay ahead of
  // the others, so the index is kept to their side of that line.
  reorder(id, index) {
    const tab = this.get(id);
    if (!tab) return;
    const peers = this.in(tab.group).filter((t) => t !== tab && t.window === tab.window);
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
    const peers = this.in(tab.group).filter((t) => t.window === tab.window);
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
    if (!this.get(id)) return; // a private tab with nowhere to go back to closed
    if (groupId === YOU && typeof pinned === 'boolean') tab.pinned = pinned;
    this.reorder(id, index);
  }

  // Pinned tabs are the user's: small, first, never put to sleep, kept across restarts.
  pin(id, on) {
    const tab = this.get(id);
    if (!tab || tab.group !== YOU || tab.pinned === !!on) return;
    tab.pinned = !!on;
    // Pinning puts it at the end of the pinned tabs, unpinning at the start of the rest.
    this.reorder(id, this.in(YOU).filter((t) => t.pinned && t !== tab && t.window === tab.window).length);
  }

  // A window tells us where its page area is; each of its tabs fills it, or
  // sits centred in it at its emulated device size.
  setArea(area, w = this.window()) {
    if (!w) return;
    w.area = area;
    w.backdrop.setBounds(area);
    for (const tab of this.list) if (tab.window === w) this.place(tab);
  }

  // An emulated device is the page zoomed out until a view of exactly the
  // device's size in CSS pixels fits the page area. (Electron's own device
  // emulation does not resize the viewport of an embedded view.)
  place(tab) {
    const w = tab.window;
    // Full screen: the page asked for it (w.full), or the user did with F11
    // (w.wide) and this is the tab on screen. Nothing of Loui's shows.
    if (tab.view && (w.full === tab.id || (w.wide && w.activeId === tab.id)) && !tab.peeking) {
      const [width, height] = w.win.getContentSize();
      return tab.view.setBounds({ x: 0, y: 0, width, height });
    }
    const a = w.area;
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
    tab.wc.setUserAgent(d?.mobile ? MOBILE_UA : tab.ses.getUserAgent());
    this.place(tab);
    // The user agent only changes what the server sends on the next load.
    if (wasMobile !== !!d?.mobile && tab.url) tab.wc.reload();
    this.emit('change');
  }

  // Each session (the user's, and each private one) is watched: the console
  // and network history the tools read, and the relay guard.
  watchNetwork(ses) {
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
    requestRules(ses).add((d) => {
      const tab = owner(d);
      let origin = '';
      try { origin = new URL(d.url).origin; } catch {}
      return !!tab && tab.group !== YOU && this.relayOrigins.has(origin) ? { cancel: true } : null;
    });
    ses.webRequest.onSendHeaders(all, (d) => started.set(d.id, Date.now()));
    ses.webRequest.onCompleted(all, (d) => record(d, { status: d.statusCode }));
    ses.webRequest.onErrorOccurred(all, (d) => record(d, { error: d.error }));
  }

  // Right-click inside a page: what was clicked first (a link, an image, the
  // selection, a text field), then the page. In a session's tab nothing here
  // takes a page out of the session's group: what opens, opens in the group.
  // Only addresses on the web are opened from here: a page can name any
  // address in a link (file:, view-source:), and in a session's group the
  // session could then read what opened.
  pageMenuItems(tab, p) {
    const wc = tab.wc;
    const mine = tab.group === YOU;
    const items = [];
    const rule = () => { if (items.length && items[items.length - 1].type !== 'separator') items.push({ type: 'separator' }); };
    // In the user's own tab what they open from here is theirs (byUser); in a session's it is not.
    const openTab = (url, show = false) => {
      const opened = this.create(url, { group: tab.group, window: tab.window, show });
      return mine ? this.byUser(opened) : opened;
    };
    const web = (url) => /^https?:/i.test(url || '');
    if (p.linkURL) {
      if (web(p.linkURL)) items.push({ label: 'Open link in new tab', click: () => openTab(p.linkURL) });
      // A private tab's link stays private.
      if (mine && web(p.linkURL)) items.push({ label: 'Open link in new window', click: () => this.emit('open-window', { url: p.linkURL, private: tab.private }) });
      if (mine && !tab.private && web(p.linkURL)) items.push({ label: 'Open link in private window', click: () => this.emit('open-window', { url: p.linkURL, private: true }) });
      items.push({ label: 'Copy link address', click: () => clipboard.writeText(p.linkURL) });
      // Asks where to save, as for an image below.
      if (/^https?:/i.test(p.linkURL)) items.push({ label: mine ? 'Save link as…' : 'Save link', click: () => { tab.saveAs = mine; wc.downloadURL(p.linkURL); } });
      rule();
    }
    if (p.mediaType === 'image' && p.srcURL) {
      items.push(
        ...(web(p.srcURL) ? [{ label: 'Open image in new tab', click: () => openTab(p.srcURL) }] : []),
        // Asks where to save; a session's tab never opens a dialog (downloads.js).
        { label: mine ? 'Save image as…' : 'Save image', click: () => { tab.saveAs = mine; wc.downloadURL(p.srcURL); } },
        { label: 'Copy image', click: () => wc.copyImageAt(p.x, p.y) },
        { label: 'Copy image address', click: () => clipboard.writeText(p.srcURL) },
      );
      rule();
    }
    const selected = (p.selectionText || '').trim();
    if (p.isEditable) {
      if (p.misspelledWord) {
        for (const word of (p.dictionarySuggestions || []).slice(0, 5)) items.push({ label: word, click: () => wc.replaceMisspelling(word) });
        items.push({ label: 'Add to dictionary', click: () => tab.ses.addWordToSpellCheckerDictionary(p.misspelledWord) });
        rule();
      }
      items.push(
        { role: 'cut', enabled: !!p.editFlags?.canCut }, { role: 'copy', enabled: !!p.editFlags?.canCopy }, { role: 'paste' },
        { role: 'pasteAndMatchStyle', label: 'Paste as plain text' }, { role: 'selectAll' },
      );
      rule();
    } else if (selected) {
      items.push(
        { role: 'copy' },
        { label: `Search ${searchName()} for “${clipped(selected.replace(/\s+/g, ' '), 30)}”`, click: () => openTab(searchFor(selected), true) },
      );
      rule();
    }
    items.push(
      { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
      { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
      { label: 'Reload', click: () => wc.reload() },
      { type: 'separator' },
      // The page as its address serves it, through the downloads list like any other file.
      ...(/^https?:/i.test(tab.url) ? [{ label: mine ? 'Save page as…' : 'Save page', click: () => { tab.saveAs = mine; wc.downloadURL(tab.url); } }] : []),
      { label: 'Print…', click: () => this.emit('print', tab) },
      ...(mine && web(tab.url) ? [{ label: 'View page source', click: () => openTab(`view-source:${tab.url}`, true) }] : []),
      ...(p.isEditable ? [] : [{ label: 'Select all', click: () => {
        // Through the page, so it does not hang on whether the page has the keyboard just now.
        wc.focus();
        wc.executeJavaScript('getSelection().selectAllChildren(document.documentElement)', true).catch(() => wc.selectAll());
      } }]),
      { type: 'separator' },
      // The Claude panel stays out of private windows.
      ...(tab.private && tab.group === YOU ? [] : [{ label: 'Point Claude at this', click: () => this.emit('point', tab, { x: p.x, y: p.y }) }]),
      { label: 'Inspect', click: () => wc.inspectElement(p.x, p.y) },
    );
    return items;
  }

  contextMenu(tab, p) {
    Menu.buildFromTemplate(this.pageMenuItems(tab, p)).popup({ window: tab.window.win });
  }

  // How a window is named in menus: by the tab on screen in it.
  windowLabel(w) {
    const shown = this.get(w.activeId);
    const title = shown?.title || shown?.url || 'New tab';
    return `${w.private ? 'Private window' : 'Window'} with “${title.length > 40 ? title.slice(0, 39) + '…' : title}”`;
  }

  // A copy of a tab beside it, with its history.
  duplicate(id) {
    const tab = this.get(id);
    if (!tab) return null;
    const nav = tab.wc?.navigationHistory;
    const entries = nav?.getAllEntries() || [];
    const history = entries.length ? { entries, index: nav.getActiveIndex() } : tab.history;
    const copy = this.create(tab.url, { group: tab.group, window: tab.window, show: this.onScreen(tab), history });
    const peers = this.in(tab.group).filter((t) => t.window === tab.window && t !== copy);
    this.reorder(copy.id, peers.indexOf(tab) + 1);
    return copy;
  }

  // The items of a tab's right-click menu in the tab strip, in four parts:
  // what is done to the tab, what Claude has to do with it, moving it to
  // another window, and closing.
  tabMenuItems(id) {
    const tab = this.get(id);
    if (!tab) return [];
    const w = tab.window;
    const g = this.group(tab.group);
    const more = [];
    this.emit('tab-menu', tab, more); // other modules add their items (sleep.js, brave.js, pip.js)
    const reload = { label: 'Reload', click: () => (tab.asleep ? this.wake(tab) : tab.wc.reload()) };
    const parts = [];
    if (tab.group === YOU) {
      const mine = this.in(YOU).filter((t) => t.window === w);
      const others = mine.filter((t) => t !== tab && !t.pinned);
      const right = mine.slice(mine.indexOf(tab) + 1).filter((t) => !t.pinned);
      const closeAll = (list) => () => { for (const t of list) this.close(t.id); };
      const there = this.windows.filter((x) => x !== w && x.private === tab.private && x.ses === tab.ses);
      parts.push(
        [
          reload,
          { label: 'Duplicate', click: () => this.duplicate(id) },
          { label: tab.pinned ? 'Unpin tab' : 'Pin tab', click: () => this.pin(id, !tab.pinned) },
          ...(/^(https?|file|ftp):/i.test(tab.url) ? [{ label: 'Bookmark this tab…', click: () => this.emit('bookmark-tab', tab) }] : []),
          ...more,
        ],
        this.groups.filter((x) => x.id !== YOU).map((x) => ({ label: `Give to ${x.label}`, click: () => this.move(id, x.id, { lent: true }) })),
        [
          { label: 'Move to new window', click: () => this.emit('to-new-window', { tab }) },
          ...(there.length ? [{
            label: 'Move to window',
            submenu: there.map((x) => ({ label: this.windowLabel(x), click: () => this.toWindow(id, x) })),
          }] : []),
        ],
        [
          ...(tab.private ? [] : [{ label: 'Reopen closed tab', click: () => this.emit('reopen-closed', w) }]),
          { label: 'Close other tabs', enabled: others.length > 0, click: closeAll(others) },
          { label: 'Close tabs to the right', enabled: right.length > 0, click: closeAll(right) },
          { label: 'Close tab', click: () => this.close(id) },
        ],
      );
    } else {
      parts.push(
        [reload, ...more],
        [
          { label: g.paused ? 'Let Claude continue' : 'Take over', click: () => { g.paused = !g.paused; this.emit('change'); } },
          { label: 'Take back', click: () => this.move(id, YOU) },
          { label: 'End session', click: () => this.emit('end-session', g.id) },
        ],
        this.groupMoveItems(tab.group),
        [{ label: 'Close tab', click: () => this.close(id) }],
      );
    }
    return parts.filter((part) => part.length).flatMap((part, i) => (i ? [{ type: 'separator' }, ...part] : part));
  }

  // Right-click on a tab in the tab strip.
  tabMenu(id) {
    const tab = this.get(id);
    if (tab) Menu.buildFromTemplate(this.tabMenuItems(id)).popup({ window: tab.window.win });
  }

  // "Move group to window" for a session's group: a new window, or another
  // normal one.
  groupMoveItems(groupId) {
    const g = this.group(groupId);
    if (!g || g.id === YOU) return [];
    const there = this.windows.filter((w) => w !== g.window && !w.private);
    return [{
      label: 'Move group to window',
      submenu: [
        { label: 'New window', click: () => this.emit('to-new-window', { group: g.id }) },
        ...there.map((w) => ({ label: this.windowLabel(w), click: () => this.groupToWindow(g.id, w) })),
      ],
    }];
  }

  // The items of a session's menu in the tab strip (right-click on its name).
  groupMenuItems(groupId) {
    const g = this.group(groupId);
    if (!g || g.id === YOU) return [];
    const items = [
      ...this.groupMoveItems(groupId),
      // ── End session (main.js passes it to the window, which asks first as the × does) ──
      { type: 'separator' },
      { label: 'End session', click: () => this.emit('end-session', g.id) },
    ];
    // Ahead of those: pip.js adds "Watch in a small window", main.js "Take over" / "Let Claude continue".
    this.emit('group-menu', g, items);
    return items;
  }

  // Right-click on a session's name in the tab strip.
  groupMenu(groupId) {
    const g = this.group(groupId);
    if (!g || g.id === YOU || !g.window) return;
    Menu.buildFromTemplate(this.groupMenuItems(groupId)).popup({ window: g.window.win });
  }

  // What the window chrome needs to draw the tab strip and toolbar: the tabs
  // of one window, or of all of them if w is left out.
  summary(w) {
    // A sleeping tab answers from the history it kept.
    const nav = (t) => t.wc?.navigationHistory || {
      canGoBack: () => !!t.history && t.history.index > 0,
      canGoForward: () => !!t.history && t.history.index < t.history.entries.length - 1,
    };
    return this.list.filter((t) => !w || t.window === w).map((t) => ({
      id: t.id,
      group: t.group,
      title: t.title || (blank(t.url) ? 'New tab' : t.url),
      url: blank(t.url) ? '' : t.url,
      favicon: t.favicon,
      loading: t.loading,
      active: this.onScreen(t),
      current: this.group(t.group)?.current === t.id,
      canGoBack: nav(t).canGoBack(),
      canGoForward: nav(t).canGoForward(),
      device: t.device ? t.device.label || `${t.device.width}×${t.device.height}` : null,
      asleep: !!t.asleep,
      pinned: !!t.pinned,
      window: t.window.id,
      private: !!t.private,
      lent: !!t.lent, // the user's tab, in a session's group until the session ends
    }));
  }
}

module.exports = { Tabs, PRESETS, toUrl, YOU, START, onStart };
