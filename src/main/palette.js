// The command palette (Ctrl+K, and Ctrl+Shift+A for open tabs only, as in
// Brave): one search over open tabs, bookmarks, history and commands, plus
// "Ask Claude" with what was typed.
//
// Where it draws: pages are native views laid over the window, so the palette
// is a view of its own in front of them, as the address bar's suggestion list
// is (suggest.js). This one covers the whole window, transparent around a card
// at the top, so a click beside the card closes it; it holds its own search box
// and takes the keyboard while open, then gives it back to whoever had it.
//
// Commands are not a second list: they are read from the application menu each
// time (label, shortcut, enabled and checked state), plus the items modules put
// in a tab's right-click menu ('tab-menu' on tabs) for the tab on screen, plus
// extras() from main.js. Each one runs by clicking its MenuItem, as the menu would.
//
// Only the user reaches it. It opens from the menu's shortcut, which ignores
// keys a Claude session presses (see key() in actions.js); its page has a
// bridge of its own (palette-preload.js) that tab pages never get; and the
// main process answers that page only.
const path = require('path');
const { WebContentsView, Menu, ipcMain, webContents } = require('electron');
const { YOU } = require('./tabs');

const KEEP_RECENT = 8; // commands remembered in settings.json
const SHOWN = { tabs: 6, bookmarks: 4, history: 4, commands: 7, recent: 5, idleTabs: 8 };

// ── fuzzy matching ──────────────────────────────────────────────────────────
// Every word typed must appear in the text with its letters in order. Letters
// at the start of a word, and letters next to each other, count for more;
// letters far apart count for less. Returns { score, marks } (marks: [start,
// end) ranges to highlight) or null.
const wordy = (c) => /[\p{L}\p{N}]/u.test(c || '');
const startsWord = (text, i) => i === 0 || (wordy(text[i]) && !wordy(text[i - 1]))
  || (/\p{Ll}/u.test(text[i - 1]) && /\p{Lu}/u.test(text[i]));

function fuzzy(query, text) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  text = String(text || '');
  if (!words.length) return { score: 0, marks: [] };
  const hay = text.toLowerCase();
  let score = 0;
  const at = new Set();
  for (const word of words) {
    const best = bestMatch(word, hay, text);
    if (!best) return null;
    score += best.score;
    for (const i of best.at) at.add(i);
  }
  if (score <= 0) return null;
  return { score: score - text.length * 0.01, marks: spans([...at].sort((a, b) => a - b)) };
}

// Is word (from letter k on) still to be found in hay after position i?
function fits(word, k, hay, i) {
  for (; k < word.length; k++) if ((i = hay.indexOf(word[k], i + 1)) < 0) return false;
  return true;
}

function bestMatch(word, hay, text) {
  let best = null;
  for (let s = hay.indexOf(word[0]); s >= 0; s = hay.indexOf(word[0], s + 1)) {
    if (!fits(word, 1, hay, s)) break; // a later start has even less text left
    const at = [s];
    for (let k = 1, i = s; k < word.length; k++) {
      // The next letter right after the last, else at the start of a later
      // word if the rest still fits after it, else wherever it comes next.
      let next = hay.indexOf(word[k], i + 1);
      if (next !== i + 1) {
        for (let j = next; j >= 0; j = hay.indexOf(word[k], j + 1)) {
          if (startsWord(text, j) && fits(word, k + 1, hay, j)) { next = j; break; }
        }
      }
      at.push((i = next));
    }
    const score = scoreOf(at, text);
    if (!best || score > best.score) best = { score, at };
  }
  return best;
}

function scoreOf(at, text) {
  let score = 0;
  at.forEach((i, k) => {
    score += 1;
    if (startsWord(text, i)) score += i === 0 ? 4 : 3;
    if (k && i === at[k - 1] + 1) score += 2;
    if (k) score -= Math.min(3, (i - at[k - 1] - 1) * 0.5);
  });
  return score;
}

function spans(at) {
  const out = [];
  for (const i of at) {
    const last = out[out.length - 1];
    if (last && last[1] === i) last[1] = i + 1;
    else out.push([i, i + 1]);
  }
  return out;
}

// A shortcut as people read it on Windows and Linux.
const shortcut = (accelerator) => (accelerator ? String(accelerator).replace(/CommandOrControl|CmdOrCtrl/g, 'Ctrl') : '');
// The address as people read it: no scheme, no "www.".
const plain = (url) => String(url || '').replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');

function createPalette({ win, tabs, sources = {}, settings, save, extras = () => [], ask, busy = () => false }) {
  const view = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'palette-preload.js'), sandbox: true, contextIsolation: true },
  });
  view.setBackgroundColor('#00000000');
  let open = false;
  let mode = 'all'; // or 'tabs'
  let before = null; // the page or chrome that had the keyboard
  let actions = new Map(); // key of a row on show -> what choosing it does
  // A view only draws if it was in sight while its page loaded (see tabs.js),
  // so it loads as one transparent pixel in the corner and hides afterwards.
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 1, height: 1 });
  const loaded = new Promise((done) => view.webContents.once('did-finish-load', () => {
    if (!open) view.setVisible(false);
    done();
  }));
  view.webContents.loadFile(path.join(__dirname, '../ui/palette.html'));

  function fit() {
    const [width, height] = win.getContentSize();
    view.setBounds({ x: 0, y: 0, width, height });
  }
  win.on('resize', () => { if (open) fit(); });

  // Tabs re-stack their views when one is selected or loads in the
  // background; the palette goes back in front of them.
  function raise() {
    const children = win.contentView.children;
    if (open && children[children.length - 1] !== view) win.contentView.addChildView(view);
  }
  tabs.on('change', raise);

  // which: 'all', or 'tabs' for open tabs only. The shortcut that opened it
  // closes it again.
  async function show(which = 'all') {
    if (open && which === mode) return hide();
    if (!open) before = webContents.getFocusedWebContents();
    mode = which;
    open = true;
    fit();
    raise();
    view.setVisible(true);
    view.webContents.focus();
    await loaded;
    view.webContents.send('palette:open', { mode });
  }

  function hide() {
    if (!open) return;
    open = false;
    view.setVisible(false);
    const back = before && !before.isDestroyed() ? before : tabs.active()?.wc || win.webContents;
    before = null;
    back.focus();
  }

  // ── commands ──────────────────────────────────────────────────────────────
  // Every item of a menu that does something: { id, title, where, shortcut,
  // enabled, checked, item }. Separators and submenus' own entries are not
  // commands; the palette's own items are left out.
  function commandsOf(menu, where = []) {
    const out = [];
    for (const item of menu?.items || []) {
      if (!item.visible || item.type === 'separator') continue;
      const label = String(item.label || '').replace(/&(?!&)/g, '');
      if (item.submenu) {
        out.push(...commandsOf(item.submenu, label ? [...where, label] : where));
        continue;
      }
      if (!label || String(item.id || '').startsWith('palette')) continue;
      out.push({
        id: [...where, label].join(' › '),
        title: label,
        where: where.join(' › '),
        shortcut: shortcut(item.accelerator || item.getDefaultRoleAccelerator?.()),
        enabled: item.enabled !== false,
        checked: item.type === 'checkbox' || item.type === 'radio' ? !!item.checked : null,
        item,
      });
    }
    return out;
  }

  function commands() {
    const all = commandsOf(Menu.getApplicationMenu());
    // What modules offer for the tab on screen (sleep it, keep it awake, ...).
    const tab = tabs.active();
    const offered = [];
    if (tab) tabs.emit('tab-menu', tab, offered);
    const more = [...offered, ...extras()];
    if (more.length) all.push(...commandsOf(Menu.buildFromTemplate(more), ['This tab']));
    // The same command from the tab menu and the app menu ("Open in Brave") is listed once.
    const seen = new Set();
    return all.filter((c) => !seen.has(c.title) && seen.add(c.title));
  }

  // Runs it as the menu would; Edit's items (copy, paste...) act on the page
  // or chrome that had the keyboard.
  function runCommand(c, target) {
    remember(c.id);
    c.item.click(undefined, win, target);
  }

  const recent = () => (Array.isArray(settings.paletteRecent) ? settings.paletteRecent : []);
  function remember(id) {
    settings.paletteRecent = [id, ...recent().filter((r) => r !== id)].slice(0, KEEP_RECENT);
    save();
  }

  // ── results ───────────────────────────────────────────────────────────────
  function results(text) {
    const q = String(text || '').trim().slice(0, 200);
    actions = new Map();
    const groups = [];
    const group = (id, label, rows) => { if (rows.length) groups.push({ id, label, items: rows }); };
    const row = (key, run, fields) => { actions.set(key, run); return { key, ...fields }; };

    // Open tabs: the user's and each session's, labelled with the session.
    const labels = new Map(tabs.groups.map((g) => [g.id, g.label]));
    const tabRows = [];
    for (const t of tabs.summary()) {
      const title = fuzzy(q, t.title);
      const url = fuzzy(q, plain(t.url));
      if (q && !title && !url) continue;
      tabRows.push({
        score: Math.max(title ? title.score + 1 : -Infinity, url ? url.score : -Infinity),
        row: row(`tab:${t.id}`, () => tabs.select(t.id), {
          kind: 'tab',
          title: t.title,
          titleMarks: title?.marks || [],
          detail: plain(t.url),
          detailMarks: title ? [] : url?.marks || [],
          badge: t.group === YOU ? null : labels.get(t.group) || 'Claude',
          hint: t.active ? 'On screen' : t.asleep ? 'Asleep' : '',
        }),
      });
    }
    if (q) tabRows.sort((a, b) => b.score - a.score);
    const tabsShown = mode === 'tabs' ? Infinity : q ? SHOWN.tabs : SHOWN.idleTabs;

    const used = recent();
    const all = mode === 'tabs' ? [] : commands();
    const commandRow = (c, marks = []) => row(`cmd:${c.id}`, (target) => runCommand(c, target), {
      kind: 'command',
      title: c.title,
      titleMarks: marks,
      detail: c.where,
      detailMarks: [],
      hint: c.shortcut,
      checked: c.checked,
      disabled: !c.enabled,
    });

    if (!q) {
      // Nothing typed: recently used commands, then the open tabs.
      const byId = new Map(all.map((c) => [c.id, c]));
      group('recent', 'Recently used', used.map((id) => byId.get(id)).filter(Boolean)
        .slice(0, SHOWN.recent).map((c) => commandRow(c)));
      group('tabs', 'Open tabs', tabRows.slice(0, tabsShown).map((t) => t.row));
      return { mode, groups };
    }
    group('tabs', 'Open tabs', tabRows.slice(0, tabsShown).map((t) => t.row));
    if (mode === 'tabs') return { mode, groups };

    // Bookmarks and history, from the same sources as the address bar.
    const open = (url) => () => {
      const tab = tabs.active();
      // A session's tab on screen is the session's work: the page opens beside it.
      if (tab?.group !== YOU) return tabs.create(url, { show: true });
      tabs.use(tab)?.wc?.loadURL(url).catch(() => {});
    };
    const pageRows = (source, kind, limit, skip) => (source?.suggest(q, limit + skip.size) || [])
      .filter((s) => !skip.has(s.url)).slice(0, limit)
      .map((s) => {
        const title = s.title || plain(s.url);
        return row(`${kind}:${s.url}`, open(s.url), {
          kind,
          title,
          titleMarks: fuzzy(q, title)?.marks || [],
          detail: plain(s.url),
          detailMarks: fuzzy(q, plain(s.url))?.marks || [],
        });
      });
    const marked = pageRows(sources.bookmarks, 'bookmark', SHOWN.bookmarks, new Set());
    group('bookmarks', 'Bookmarks', marked);
    group('history', 'History', pageRows(sources.history, 'history', SHOWN.history,
      new Set(sources.bookmarks?.suggest(q, 50).map((s) => s.url) || [])));

    // Commands: best match first; among equals, the most recently used.
    const scored = [];
    for (const c of all) {
      // "view zoom" finds View › Zoom in, below what matches by name alone.
      const byName = fuzzy(q, c.title);
      const byPlace = !byName && c.where && fuzzy(q, `${c.where} ${c.title}`);
      if (!byName && !byPlace) continue;
      const r = used.indexOf(c.id);
      const score = (byName || byPlace).score - (byName ? 0 : 3) + (r < 0 ? 0 : 2 - r * 0.2) - (c.enabled ? 0 : 3);
      scored.push({ c, titleMarks: byName?.marks || [], score });
    }
    scored.sort((a, b) => b.score - a.score);
    group('commands', 'Commands', scored.slice(0, SHOWN.commands).map((s) => commandRow(s.c, s.titleMarks)));

    // Ask Claude, in the panel, which works in the user's own tabs.
    const page = tabs.current(YOU);
    group('claude', 'Claude', [row('ask', () => ask(q), {
      kind: 'claude',
      title: `Ask Claude: ${q}`,
      titleMarks: [],
      detail: busy() ? 'Claude is still answering your last message' : `About ${page?.title || 'this page'}`,
      detailMarks: [],
      disabled: busy(),
    })]);
    return { mode, groups };
  }

  function choose(key) {
    const run = actions.get(key);
    if (!run) return;
    const target = before && !before.isDestroyed() ? before : null;
    hide(); // first, so what it runs gets the keyboard (the find bar, say)
    run(target);
  }

  ipcMain.handle('palette:query', (e, text) => (e.sender === view.webContents ? results(text) : null));
  ipcMain.on('palette:choose', (e, key) => { if (e.sender === view.webContents) choose(String(key)); });
  ipcMain.on('palette:close', (e) => { if (e.sender === view.webContents) hide(); });

  // For the tests (LOUI_TEST only): what only a person at the keyboard can do.
  const keyInto = (wc, key, modifiers = []) => {
    wc.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers });
    if (key === 'Enter') wc.sendInputEvent({ type: 'char', keyCode: '\r', modifiers });
    wc.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers });
  };
  const probes = {
    // What the palette shows, whether it is in front of every page, and who has the keyboard.
    palette: async () => {
      const children = win.contentView.children;
      return {
        open: open && view.getVisible(),
        inFront: children[children.length - 1] === view,
        mode,
        ...(await view.webContents.executeJavaScript(`({
          text: document.getElementById('palette-input').value,
          answered: document.getElementById('palette-list').dataset.answers ?? null,
          typing: document.activeElement === document.getElementById('palette-input'),
          groups: [...document.querySelectorAll('.palette-group')].map((g) => ({
            label: g.querySelector('.palette-label').textContent,
            rows: [...g.querySelectorAll('.palette-row')].map((r) => ({
              title: r.querySelector('.title').textContent,
              marked: [...r.querySelectorAll('.title mark')].map((m) => m.textContent).join(''),
              detail: r.querySelector('.detail')?.textContent || '',
              badge: r.querySelector('.badge')?.textContent || '',
              hint: r.querySelector('kbd, .hint')?.textContent || '',
              chosen: r.classList.contains('chosen'),
            })),
          })),
        })`)),
      };
    },
    // Types into the palette's search box, as if from the keyboard.
    'palette:type': async (text) => {
      await view.webContents.executeJavaScript("document.getElementById('palette-input').select()");
      if (text) view.webContents.insertText(text);
      else keyInto(view.webContents, 'Backspace');
      return 'ok';
    },
    'palette:key': ({ key, modifiers } = {}) => { keyInto(view.webContents, key, modifiers); return 'ok'; },
    // Which of Loui's pages has the keyboard: 'palette', 'chrome', a tab's id, or null.
    'focus:owner': () => {
      const wc = webContents.getFocusedWebContents();
      if (!wc) return null;
      if (wc === view.webContents) return 'palette';
      if (wc === win.webContents) return 'chrome';
      return tabs.list.find((t) => t.wc === wc)?.id || 'other';
    },
  };

  return { show, hide, probes, webContents: view.webContents };
}

module.exports = { createPalette, fuzzy };
