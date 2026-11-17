// Loui's own small notes in front of the page: what a page in full screen is
// and how to leave it, and the card under a tab the pointer rests on.
//
// Both are drawn by Loui, not by a page, in a small view of its own in front
// of the tabs' views (src/ui/hint.html), as the address bar's suggestion list
// is (suggest.js): a page in full screen covers everything of Loui's but this,
// so whatever it paints there, the note above it is Loui's word on whose page
// it is. The view only shows what it is told and reports nothing back.
//
// Full screen: the note shows for a few seconds when a page takes the whole
// window (asked for by the page, or by the user with F11), and again whenever
// the pointer touches the top edge.
const path = require('path');
const { WebContentsView } = require('electron');
const { YOU } = require('./tabs');

const FULL_MS = 3000; // how long the full-screen note stays
const FULL = { width: 460, height: 62 };
const CARD = { width: 300, height: 132 }; // room for two lines of title, the site, and two notes

const hostOf = (url) => { try { return new URL(url).host; } catch { return ''; } };

function createHints({ win, tabs }) {
  const view = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'hint-preload.js'), sandbox: true, contextIsolation: true },
  });
  view.setBackgroundColor('#00000000');
  // One view for all windows: it moves into the window that has something to say.
  let host = null;
  let shown = null; // { kind: 'full' | 'card', w, note, bounds() } while on show
  let timer = 0;
  const known = new WeakSet();
  function moveTo(target) {
    if (host === target) return;
    if (host && !host.isDestroyed()) host.contentView.removeChildView(view);
    host = target;
    target.contentView.addChildView(view);
    if (known.has(target)) return;
    known.add(target);
    // Going into full screen resizes the window after the note is up.
    target.on('resize', () => { if (shown && host === target) view.setBounds(shown.bounds()); });
    target.once('close', () => {
      if (host !== target) return;
      hide();
      target.contentView.removeChildView(view);
      host = null;
    });
  }
  // A view only draws if it was in sight while its page loaded (see tabs.js),
  // so it loads as one transparent pixel in the corner and hides afterwards.
  moveTo(win);
  view.setBounds({ x: 0, y: 0, width: 1, height: 1 });
  view.webContents.once('did-finish-load', () => { if (!shown) view.setVisible(false); });
  view.webContents.loadFile(path.join(__dirname, '../ui/hint.html'));

  function show(next) {
    if (next.w.win.isDestroyed()) return;
    shown = next;
    moveTo(next.w.win);
    view.webContents.send('hint', { ...next.note, kind: next.kind, private: next.w.private });
    view.setBounds(next.bounds());
    raise();
    view.setVisible(true);
  }

  // kind: only if that is what is on show.
  function hide(kind) {
    if (kind && shown?.kind !== kind) return;
    clearTimeout(timer);
    shown = null;
    view.setVisible(false);
  }

  // Tabs re-stack their views (a page going into full screen comes to the
  // front of everything): the note goes back in front of them.
  function raise() {
    if (!shown || !host || host.isDestroyed()) return;
    const children = host.contentView.children;
    if (children[children.length - 1] !== view) host.contentView.addChildView(view);
  }

  // ── full screen ──
  function full(w) {
    const tab = tabs.get(w.full || w.activeId);
    if (!tab || !tabs.isFull(tab)) return;
    show({
      kind: 'full', w,
      // Esc ends what the page asked for; what F11 began, F11 ends.
      note: { host: hostOf(tab.url), key: w.full ? 'Esc' : 'F11' },
      bounds: () => {
        const [width] = w.win.getContentSize();
        const wide = Math.min(FULL.width, width);
        return { x: Math.round((width - wide) / 2), y: 0, width: wide, height: FULL.height };
      },
    });
    clearTimeout(timer);
    timer = setTimeout(() => hide('full'), FULL_MS);
  }
  const was = new WeakMap(); // window -> the full screen it was last seen in
  tabs.on('change', () => {
    for (const w of tabs.windows) {
      const now = w.full ? `page ${w.full}` : w.wide ? `wide ${w.activeId}` : '';
      if (now === (was.get(w) || '')) continue;
      was.set(w, now);
      if (now) full(w);
      else if (shown?.w === w) hide('full');
    }
    raise();
  });
  tabs.on('pointer-top', (tab) => full(tab.window));

  // ── a tab's card ──
  // From the window chrome: the tab the pointer rests on and where the card
  // goes ({ id, x, y } in the window), or nothing to take it away.
  function card({ id, x, y } = {}) {
    const w = tabs.window();
    const tab = tabs.get(id);
    if (!w || !tab || tab.window !== w || w.full || w.wide || !Number.isFinite(x) || !Number.isFinite(y)) return hide('card');
    const g = tabs.group(tab.group);
    const url = tab.url === 'about:blank' ? '' : tab.url;
    show({
      kind: 'card', w, id: tab.id,
      note: {
        title: tab.title || url || 'New tab',
        host: hostOf(url) || url.slice(0, 80),
        who: g && g.id !== YOU ? `${g.label}'s tab` : '',
        more: [
          tab.private && tab.group !== YOU ? 'A private tab you lent to this session' : '',
          tab.asleep ? 'Asleep: loads when you open it' : '',
        ].filter(Boolean),
      },
      bounds: () => {
        const [width, height] = w.win.getContentSize();
        return {
          x: Math.max(0, Math.min(Math.round(x), width - CARD.width)), y: Math.max(0, Math.min(Math.round(y), height - CARD.height)),
          width: CARD.width, height: CARD.height,
        };
      },
    });
  }
  // A card is about a tab as it was when the pointer came to rest: gone with the tab.
  tabs.on('closing', (tab) => { if (shown?.kind === 'card' && shown.id === tab.id) hide('card'); });

  // For the tests (LOUI_TEST only).
  const probes = {
    // What is on show, whether it is in front of every page, and where.
    hint: async () => {
      const children = host?.contentView.children || [];
      return {
        shown: shown && view.getVisible() ? shown.kind : null,
        window: shown?.w.id ?? null,
        inFront: children[children.length - 1] === view,
        bounds: view.getBounds(),
        text: await view.webContents.executeJavaScript("document.getElementById('hint').innerText"),
      };
    },
    // The pointer at the top edge of a tab's page.
    'hint:top': (id) => { tabs.get(id)?.wc?.sendInputEvent({ type: 'mouseMove', x: 300, y: 1 }); return 'ok'; },
  };

  return { card, hide, probes, webContents: view.webContents };
}

module.exports = { createHints };
