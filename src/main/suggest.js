// Suggestions under the address bar.
//
// Sources: each one has suggest(text, limit) -> [{ url, title, score, source }].
// History is the first; bookmarks can be added as another with add(). The
// best of all sources are shown, each address once.
// Above them, the first row says what Enter will do (open an address, or
// search), and the user's own open tabs that match are offered to switch to.
//
// The list itself: pages are native views laid over the window, in front of
// the window chrome's own HTML, so a dropdown drawn by the chrome would be
// hidden behind the page. The list is therefore a small view of its own
// (src/ui/suggestions.html) placed in front of the page, under the address
// bar. The chrome keeps what is typed, the suggestions and the highlight, and
// tells this view what to draw; the view only reports a click.
const path = require('path');
const { WebContentsView } = require('electron');
const { toUrl, YOU } = require('./tabs');
const { searchFor } = require('./search');

const SHOWN = 6;
// Must match .suggestion's height and #suggestions' padding, border and margin in history.css.
const ROW = 44;
const PAD = 5;
const BORDER = 1;
const MARGIN = 10; // room for the list's shadow
const GAP = 4; // between the address bar and the list

// The address as people type it: no scheme, no "www.".
const bare = (url) => url.replace(/^https?:\/\/(www\.)?/i, '');

// What to finish the typed text with, as Chrome and Brave do: the best
// suggestion whose address starts with it. While the user is still in the
// site's name it is finished up to the site (its front page); after a slash,
// up to the whole address. Returns { text, url, title } or null; text is what
// the address bar shows (it starts with what was typed), url what Enter opens.
function completion(typed, ranked) {
  if (!typed || /\s/.test(typed)) return null;
  const low = typed.toLowerCase();
  for (const s of ranked) {
    const rest = bare(s.url);
    if (!rest.toLowerCase().startsWith(low) || rest.length === typed.length) continue;
    const slash = rest.indexOf('/');
    const site = slash < 0 ? rest : rest.slice(0, slash);
    if (typed.length >= site.length && rest.slice(typed.length) === '/') continue; // nothing to add but the slash
    if (typed.length < site.length) {
      const url = s.url.slice(0, s.url.length - rest.length) + site + '/';
      return { text: typed + site.slice(typed.length), url, title: ranked.find((x) => x.url === url)?.title || '' };
    }
    return { text: typed + rest.slice(typed.length), url: s.url, title: s.title || '' };
  }
  return null;
}

// engine: the name of the search engine words go to, for the row that says so.
function createSuggest({ win, tabs, send, sources = [], engine = () => '' }) {
  function query(text) {
    const best = new Map();
    for (const source of sources) {
      for (const s of source.suggest(text, SHOWN)) {
        const had = best.get(s.url);
        if (!had || s.score > had.score) best.set(s.url, { ...s, title: s.title || had?.title || '' });
      }
    }
    const ranked = [...best.values()].sort((a, b) => b.score - a.score);
    // The user's own open tabs that match, to switch to rather than open
    // again: those of windows like the one asking (a private window is
    // offered private tabs only, and a normal one never a private tab), and
    // never a tab a Claude session has.
    const w = tabs.window();
    const terms = text.toLowerCase().split(/\s+/).filter(Boolean);
    const open = [];
    for (const t of w && terms.length ? tabs.list : []) {
      if (t.group !== YOU || t.private !== w.private || t.ses !== w.ses || t.id === w.activeId) continue;
      if (!/^https?:/i.test(t.url) || open.some((o) => o.url === t.url)) continue;
      const hay = `${t.title} ${bare(t.url)}`.toLowerCase();
      if (terms.every((term) => hay.includes(term))) open.push({ url: t.url, title: t.title, source: 'tab', tab: t.id });
      if (open.length === 2) break;
    }
    const items = [...open, ...ranked.filter((s) => !open.some((o) => o.url === s.url))].slice(0, SHOWN)
      .map(({ url, title, source, tab }) => ({ url, title, source, tab }));
    // What Enter does with the text as typed: open it as an address, or search for it.
    const url = toUrl(text);
    const enter = { url, search: url === searchFor(text.trim()) ? engine() || 'the web' : null };
    send('suggestions', { text, items, enter, complete: completion(text, ranked) });
  }

  const view = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'suggest-preload.js'), sandbox: true, contextIsolation: true },
  });
  view.setBackgroundColor('#00000000');
  let open = false;
  // One list for all windows: it moves into the window whose address bar
  // asks for it (a second view would cost a renderer per window).
  let host = null;
  const left = new WeakSet();
  function moveTo(target) {
    if (host === target) return;
    if (host && !host.isDestroyed()) host.contentView.removeChildView(view);
    host = target;
    target.contentView.addChildView(view);
    if (left.has(target)) return;
    left.add(target);
    target.once('close', () => { if (host === target) { target.contentView.removeChildView(view); host = null; } });
  }
  // A view only draws if it was in sight while its page loaded (see tabs.js),
  // so it loads as one transparent pixel in the corner and hides afterwards.
  moveTo(win);
  view.setBounds({ x: 0, y: 0, width: 1, height: 1 });
  view.webContents.once('did-finish-load', () => { if (!open) view.setVisible(false); });
  view.webContents.loadFile(path.join(__dirname, '../ui/suggestions.html'));

  // rect: the address bar, in window coordinates.
  function show({ items, chosen, rect }) {
    if (!items?.length) return hide();
    moveTo(tabs.win); // the window being served (see tabs.as())
    view.webContents.send('suggest', { items, chosen });
    view.setBounds({
      x: Math.round(rect.x) - MARGIN,
      y: Math.round(rect.y) + GAP,
      width: Math.round(rect.width) + 2 * MARGIN,
      height: items.length * ROW + 2 * (PAD + BORDER) + MARGIN,
    });
    open = true;
    raise();
    view.setVisible(true);
  }

  function hide() {
    open = false;
    view.setVisible(false);
  }

  // Tabs re-stack their views when one is selected or loads in the
  // background; the list goes back in front of them.
  function raise() {
    if (!open || !host || host.isDestroyed()) return;
    const children = host.contentView.children;
    if (children[children.length - 1] !== view) host.contentView.addChildView(view);
  }
  tabs.on('change', raise);

  // For the tests (LOUI_TEST only): what only a person at the keyboard can do.
  const probes = {
    // Types into the address bar, as if from the keyboard.
    'address:type': async (text) => {
      const chrome = tabs.win.webContents; // before the await, which leaves tabs.as()
      chrome.focus();
      await chrome.executeJavaScript("document.getElementById('address').focus(); document.getElementById('address').select()");
      chrome.insertText(text);
      return 'ok';
    },
    // Types on from where the caret is (address:type starts over).
    'address:insert': (text) => { tabs.win.webContents.insertText(text); return 'ok'; },
    'address:key': (key) => {
      tabs.win.webContents.focus();
      tabs.win.webContents.sendInputEvent({ type: 'keyDown', keyCode: key });
      if (key === 'Enter') tabs.win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
      tabs.win.webContents.sendInputEvent({ type: 'keyUp', keyCode: key });
      return 'ok';
    },
    // Runs a line of script in the window chrome.
    'chrome:eval': (code) => tabs.win.webContents.executeJavaScript(code),
    // What the suggestions list shows, and whether it is in front of every page.
    suggestions: async () => {
      const children = host?.contentView.children || [];
      return {
        open: open && view.getVisible(),
        inFront: children[children.length - 1] === view,
        rows: await view.webContents.executeJavaScript(
          "[...document.querySelectorAll('.suggestion')].map((r) => ({ title: r.querySelector('.title').textContent, note: r.querySelector('.url').textContent, url: r.dataset.url, kind: r.dataset.kind, chosen: r.classList.contains('chosen') }))",
        ),
      };
    },
    'suggestions:click': (n) => view.webContents.executeJavaScript(
      `document.querySelectorAll('.suggestion')[${Number(n)}].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))`,
    ),
  };

  return { query, show, hide, add: (source) => sources.push(source), probes, webContents: view.webContents };
}

module.exports = { createSuggest, completion };
