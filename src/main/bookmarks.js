// Bookmarks: the user's, and only the user's. Nothing here is reachable from
// a tool (src/shared/tools.js has none) or from a page (tabs get no preload);
// only the window chrome asks for them, over the 'bookmarks' channel.
//
// Two folders at the top, as in Brave: the bookmarks bar and other bookmarks.
// A bookmark is { id, url, title, added, icon? }; a folder is { id, title,
// added, children }. Kept in memory and saved to bookmarks.json in the
// profile, batched and written to a temporary file that is renamed over the
// old one (as history.js does), so a crash never leaves half a file.
//
// Folders on the bar open as native menus: they draw over the page, which
// the window chrome's own HTML cannot, and cost nothing until opened.
// Icons are small data: URLs, taken from an imported file or fetched once
// for a bookmarked page the user has open; the bar never goes to the network.
const fs = require('fs');
const { Menu, dialog, nativeImage } = require('electron');
const { YOU, toUrl } = require('./tabs');

const BAR = 'bar';
const OTHER = 'other';
const ROOT_TITLES = { [BAR]: 'Bookmarks bar', [OTHER]: 'Other bookmarks' };
const ICON_MAX = 6000; // characters of a data: URL; a 32-pixel PNG is well under
const BOOKMARK = 1e9; // a bookmark outranks any page from history that matches as well
const OPENABLE = /^(https?|file|ftp):/i;

const isFolder = (n) => Array.isArray(n.children);

function createBookmarks({ file, tabs, ses, send, broadcast = send, changed = () => {}, delay = 500 }) {
  const roots = {
    [BAR]: { id: BAR, title: ROOT_TITLES[BAR], children: [] },
    [OTHER]: { id: OTHER, title: ROOT_TITLES[OTHER], children: [] },
  };
  // Whether the bar shows: the user's choice (Ctrl+Shift+B), or until they
  // make one, whenever there are bookmarks to show.
  let showBar = null;
  let next = 1;
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(saved.bar)) roots[BAR].children = saved.bar;
    if (Array.isArray(saved.other)) roots[OTHER].children = saved.other;
    if (typeof saved.showBar === 'boolean') showBar = saved.showBar;
    if (Number.isInteger(saved.next)) next = saved.next;
  } catch {}

  // id -> { node, parent }, and url -> the first bookmark with it. Rebuilt
  // after every change; a few thousand bookmarks take well under a millisecond.
  let byId = new Map();
  let byUrl = new Map();
  function reindex() {
    byId = new Map();
    byUrl = new Map();
    const walk = (folder) => {
      for (const n of folder.children) {
        byId.set(n.id, { node: n, parent: folder });
        if (isFolder(n)) walk(n);
        else if (!byUrl.has(n.url)) byUrl.set(n.url, n);
      }
    };
    for (const root of Object.values(roots)) {
      byId.set(root.id, { node: root, parent: null });
      walk(root);
    }
  }
  reindex();

  // ── saving ──────────────────────────────────────────────────────────────
  let timer = null;
  let writing = Promise.resolve();
  const contents = () => JSON.stringify({
    version: 1, showBar, next, bar: roots[BAR].children, other: roots[OTHER].children,
  });
  function save() {
    reindex();
    publish();
    changed();
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const data = contents();
      // One write at a time, in order, so an older save never lands last.
      writing = writing.then(() => fs.promises.writeFile(file + '.tmp', data, { mode: 0o600 }))
        .then(() => fs.promises.rename(file + '.tmp', file))
        .catch((e) => console.error('[bookmarks] could not save:', e.message));
    }, delay);
  }
  // On quit, a pending save is written at once.
  function flush() {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    try {
      fs.writeFileSync(file + '.tmp', contents(), { mode: 0o600 });
      fs.renameSync(file + '.tmp', file);
    } catch {}
  }

  // ── changing ────────────────────────────────────────────────────────────
  const newId = () => `b${next++}`;
  const folder = (id) => { const n = byId.get(id)?.node; return n && isFolder(n) ? n : null; };
  // Whether `id` is `ancestor` or inside it.
  function within(id, ancestor) {
    for (let at = byId.get(id); at; at = at.parent && byId.get(at.parent.id)) {
      if (at.node.id === ancestor) return true;
    }
    return false;
  }

  function add({ url, title, parent = BAR, icon }) {
    if (!OPENABLE.test(url || '')) return null;
    const node = { id: newId(), url, title: title || url, added: Date.now() };
    if (icon) node.icon = icon;
    (folder(parent) || roots[BAR]).children.push(node);
    save();
    return node;
  }

  function addFolder({ title = 'New folder', parent = BAR } = {}) {
    const node = { id: newId(), title, added: Date.now(), children: [] };
    (folder(parent) || roots[BAR]).children.push(node);
    save();
    return node;
  }

  // A new parent puts the item at the end of that folder. The two top folders
  // stay as they are.
  function update(id, { title, url, parent } = {}) {
    const at = byId.get(id);
    if (!at || !at.parent) return;
    const n = at.node;
    if (typeof title === 'string' && title.trim()) n.title = title.trim();
    if (!isFolder(n) && typeof url === 'string' && url.trim()) {
      const to = toUrl(url);
      if (OPENABLE.test(to)) n.url = to;
    }
    const to = parent && folder(parent);
    if (to && to !== at.parent && !within(to.id, id)) {
      at.parent.children.splice(at.parent.children.indexOf(n), 1);
      to.children.push(n);
    }
    save();
  }

  function remove(id) {
    const at = byId.get(id);
    if (!at || !at.parent) return;
    at.parent.children.splice(at.parent.children.indexOf(at.node), 1);
    save();
  }

  const barShown = () => showBar ?? (roots[BAR].children.length + roots[OTHER].children.length > 0);
  function setBar(show) {
    showBar = !!show;
    save();
  }

  // ── import ──────────────────────────────────────────────────────────────
  // The bookmarks file Chrome, Brave, Edge and Firefox export (the Netscape
  // format). The browser's own bar goes onto the bar; everything else into
  // other bookmarks. A folder that is already there with the same name is
  // merged into, and an address already in the same folder is skipped, so
  // importing the same file twice adds nothing.
  function importHtml(html) {
    const parsed = parseNetscape(html);
    let added = 0, skipped = 0;
    const merge = (items, into) => {
      for (const item of items) {
        if (item.children) {
          let target = into.children.find((n) => isFolder(n) && n.title === item.title);
          if (!target) {
            target = { id: newId(), title: item.title || 'Folder', added: item.added || Date.now(), children: [] };
            into.children.push(target);
          }
          merge(item.children, target);
        } else if (!OPENABLE.test(item.url) || into.children.some((n) => n.url === item.url)) {
          skipped++;
        } else {
          const node = { id: newId(), url: item.url, title: item.title || item.url, added: item.added || Date.now() };
          if (item.icon) node.icon = item.icon;
          into.children.push(node);
          added++;
        }
      }
    };
    for (const item of parsed) {
      if (item.toolbar) merge(item.children, roots[BAR]);
      else if (item.unfiled) merge(item.children, roots[OTHER]);
      else merge([item], roots[OTHER]);
    }
    save();
    return { added, skipped };
  }
  const importFile = (path) => importHtml(fs.readFileSync(path, 'utf8'));

  async function chooseImport() {
    const { canceled, filePaths } = await dialog.showOpenDialog(tabs.win, {
      title: 'Import bookmarks',
      buttonLabel: 'Import',
      filters: [{ name: 'Bookmarks file', extensions: ['html', 'htm'] }, { name: 'All files', extensions: ['*'] }],
      properties: ['openFile'],
    });
    if (canceled || !filePaths[0]) return;
    let message;
    try {
      const { added, skipped } = importFile(filePaths[0]);
      message = added === 1 ? 'Imported 1 bookmark.' : `Imported ${added} bookmarks.`;
      if (skipped) message += ` ${skipped} already here or not web pages, so left out.`;
    } catch (e) {
      message = `Couldn't read that file: ${e.message}`;
    }
    dialog.showMessageBox(tabs.win, { type: 'info', message, buttons: ['OK'] });
  }

  // ── icons ───────────────────────────────────────────────────────────────
  // A bookmarked page the user has open gives its icon once: fetched through
  // the tabs' own session (normally straight from its cache), shrunk, and kept.
  const tried = new Set();
  async function iconFrom(url) {
    if (url.startsWith('data:image/')) {
      if (url.length <= ICON_MAX) return url;
      // A tab's icon as the page gave it: shrunk to keep, if it can be read here.
      const img = nativeImage.createFromDataURL(url);
      const icon = img.isEmpty() ? '' : img.resize({ width: 32, height: 32, quality: 'best' }).toDataURL();
      return icon && icon.length <= ICON_MAX ? icon : null;
    }
    if (!/^https?:/i.test(url)) return null;
    try {
      const res = await ses.fetch(url, { cache: 'force-cache' });
      if (!res.ok) return null;
      const bytes = Buffer.from(await res.arrayBuffer());
      const img = nativeImage.createFromBuffer(bytes);
      if (!img.isEmpty()) {
        const icon = img.resize({ width: 32, height: 32, quality: 'best' }).toDataURL();
        return icon.length <= ICON_MAX ? icon : null;
      }
      // Formats nativeImage cannot read here (SVG, and ICO outside Windows), if small.
      const type = (res.headers.get('content-type') || '').split(';')[0];
      const icon = `data:${type};base64,${bytes.toString('base64')}`;
      return type.startsWith('image/') && icon.length <= ICON_MAX ? icon : null;
    } catch {
      return null;
    }
  }
  tabs.on('change', () => {
    const tab = tabs.active();
    if (!tab || tab.group !== YOU || !tab.icon || tab.loading) return;
    const node = byUrl.get(tab.url);
    if (!node || node.icon || tried.has(node.url)) return;
    tried.add(node.url);
    iconFrom(tabs.iconData(tab) || '').then((icon) => {
      if (icon && byId.has(node.id) && !node.icon) {
        node.icon = icon;
        save();
      }
    });
  });

  // ── reading ─────────────────────────────────────────────────────────────
  const bare = (url) => url.toLowerCase().replace(/^https?:\/\/(www\.)?/, '');
  const termsOf = (query) => (query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (n, terms) => {
    const hay = n.title.toLowerCase() + ' ' + bare(n.url);
    return terms.every((t) => hay.includes(t));
  };

  // As a suggestion source. Every bookmark that matches ranks above every page
  // from history; among bookmarks, an address or title word that starts with
  // what was typed first, then shorter addresses.
  function suggest(query, limit = 8) {
    const terms = termsOf(query);
    if (!terms.length) return [];
    const out = [];
    for (const n of byUrl.values()) {
      if (!matches(n, terms)) continue;
      const first = terms[0];
      const boost = bare(n.url).startsWith(first) ? 3
        : n.title.toLowerCase().split(/\W+/).some((w) => w.startsWith(first)) ? 2 : 1;
      out.push({ url: n.url, title: n.title, score: BOOKMARK * boost - n.url.length, source: 'bookmark' });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  // For the window chrome: what the bar shows, and the folders a bookmark can go in.
  const brief = (n) => (isFolder(n)
    ? { id: n.id, title: n.title, folder: true }
    : { id: n.id, title: n.title, url: n.url, icon: n.icon || null });
  function data() {
    const folders = [];
    const walk = (f, path) => {
      folders.push({ id: f.id, title: f.title, depth: path.length, path });
      for (const n of f.children) if (isFolder(n)) walk(n, [...path, f.id]);
    };
    walk(roots[BAR], []);
    walk(roots[OTHER], []);
    return { type: 'data', showBar: barShown(), bar: roots[BAR].children.map(brief), other: roots[OTHER].children.length, folders };
  }
  // The bar's contents go to every window, and to each new one once its chrome has loaded.
  const publish = () => broadcast('bookmarks', data());
  tabs.on('chrome-loaded', publish);

  // For the bookmarks panel: the whole tree (without icons), or the bookmarks
  // matching a search.
  function list(query) {
    const terms = termsOf(query);
    if (terms.length) {
      return [...byUrl.values()].filter((n) => matches(n, terms)).slice(0, 300).map(brief)
        .map(({ icon, ...n }) => n);
    }
    const tree = (f) => f.children.map((n) => (isFolder(n)
      ? { id: n.id, title: n.title, folder: true, children: tree(n) }
      : { id: n.id, title: n.title, url: n.url }));
    return [BAR, OTHER].map((id) => ({ id, title: roots[id].title, folder: true, root: true, children: tree(roots[id]) }));
  }

  // fresh: just added, from the star or Ctrl+D.
  function editing(id, fresh = false) {
    const at = byId.get(id);
    if (!at || !at.parent) return;
    const { icon, ...item } = brief(at.node);
    tabs.win.webContents.focus();
    send('bookmarks', { type: 'edit', item: { ...item, parent: at.parent.id, fresh } });
  }

  // ── opening ─────────────────────────────────────────────────────────────
  // In the tab on screen, unless asked for a new tab or the tab on screen is a
  // Claude session's: a bookmark is the user's, and opens in a tab of theirs.
  function open(url, inNewTab) {
    const tab = tabs.active();
    if (inNewTab) return tabs.create(url, { show: false });
    if (!tab || tab.group !== YOU) return tabs.create(url, { show: true });
    tab.wc.loadURL(url).catch(() => {});
    tab.wc.focus();
  }

  // Ctrl+D and the star: bookmark the page on screen (onto the bar), or edit
  // its bookmark if it has one.
  function star() {
    const tab = tabs.active();
    if (!tab || !OPENABLE.test(tab.url || '')) return;
    const had = byUrl.get(tab.url);
    if (had) return editing(had.id);
    const node = add({ url: tab.url, title: tab.title });
    if (!node) return;
    editing(node.id, true);
    if (tab.icon) {
      tried.add(node.url);
      iconFrom(tabs.iconData(tab) || '').then((icon) => { if (icon && byId.has(node.id)) { node.icon = icon; save(); } });
    }
  }

  // ── menus ───────────────────────────────────────────────────────────────
  const label = (text) => {
    const s = text.length > 70 ? text.slice(0, 69) + '…' : text;
    return s.replace(/&/g, '&&'); // a lone & marks a shortcut letter on Windows
  };
  const iconOf = (n) => {
    if (!n.icon) return undefined;
    const img = nativeImage.createFromDataURL(n.icon);
    return img.isEmpty() ? undefined : img.resize({ width: 16, height: 16 });
  };
  // A folder's contents as a menu; nested folders as submenus.
  function folderMenu(items) {
    if (!items.length) return [{ label: '(empty)', enabled: false }];
    return items.map((n) => (isFolder(n)
      ? { label: label(n.title), submenu: folderMenu(n.children) }
      : {
        label: label(n.title), icon: iconOf(n),
        click: (_item, _win, e) => open(n.url, !!(e?.ctrlKey || e?.metaKey || e?.shiftKey)),
      }));
  }

  async function confirmRemove(id) {
    const n = byId.get(id)?.node;
    if (!n) return;
    if (isFolder(n) && n.children.length) {
      const { response } = await dialog.showMessageBox(tabs.win, {
        type: 'question',
        message: `Delete "${n.title}" and everything in it?`,
        buttons: ['Delete', 'Cancel'], defaultId: 1, cancelId: 1,
      });
      if (response !== 0) return;
    }
    remove(id);
  }

  // Right-click on the bar, or on something on it.
  function contextMenu(id) {
    const n = id && byId.get(id)?.node;
    const items = [];
    if (n && !isFolder(n)) {
      items.push(
        { label: 'Open in new tab', click: () => open(n.url, true) },
        { label: 'Edit…', click: () => editing(n.id) },
        { label: 'Delete', click: () => remove(n.id) },
        { type: 'separator' },
      );
    } else if (n) {
      items.push(
        { label: 'Rename…', click: () => editing(n.id) },
        { label: 'Delete', click: () => confirmRemove(n.id) },
        { type: 'separator' },
      );
    }
    items.push(
      { label: 'Add folder', click: () => editing(addFolder().id) },
      { type: 'separator' },
      { label: 'Show bookmarks bar', type: 'checkbox', checked: barShown(), click: () => setBar(!barShown()) },
      { label: 'Bookmark manager', click: () => send('bookmarks', { type: 'panel' }) },
      { label: 'Import bookmarks…', click: chooseImport },
    );
    Menu.buildFromTemplate(items).popup({ window: tabs.win });
  }

  // The Bookmarks menu in main.js, which keeps the checkbox current (barShown).
  const menuItems = () => [
    { label: 'Bookmark this page', accelerator: 'CmdOrCtrl+D', click: star },
    { label: 'Bookmarks', accelerator: 'CmdOrCtrl+Shift+O', click: () => { tabs.win.webContents.focus(); send('bookmarks', { type: 'panel' }); } },
    { type: 'separator' },
    { label: 'Show bookmarks bar', id: 'bookmarks-bar', type: 'checkbox', checked: barShown(), accelerator: 'CmdOrCtrl+Shift+B', click: () => setBar(!barShown()) },
    { type: 'separator' },
    { label: 'Import bookmarks…', click: chooseImport },
  ];

  // ── requests from the window chrome ─────────────────────────────────────
  // (x, y): where a folder's menu opens, in window coordinates.
  function handle(r = {}) {
    switch (r.do) {
      case 'star': return star();
      case 'open': {
        const n = byId.get(r.id)?.node;
        if (n && !isFolder(n)) open(n.url, !!r.newTab);
        return;
      }
      case 'menu': {
        const f = folder(r.id);
        if (!f) return;
        Menu.buildFromTemplate(folderMenu(f.children.slice(r.from || 0)))
          .popup({ window: tabs.win, x: Math.round(r.x), y: Math.round(r.y) });
        return;
      }
      case 'context': return contextMenu(r.id);
      case 'edit': return editing(r.id);
      case 'update': return update(r.id, r);
      case 'remove': return remove(r.id);
      case 'folder': return editing(addFolder({ parent: r.parent }).id);
      case 'bar': return setBar(r.show);
      case 'import': return chooseImport();
      case 'list': return send('bookmarks', { type: 'list', query: r.query || '', items: list(r.query) });
      // The editor closed: the page the user was reading takes the keyboard back.
      case 'closed': return tabs.active()?.wc.focus();
    }
  }

  // For the tests (LOUI_TEST only).
  const probes = {
    'bookmarks:import-file': (path) => importFile(path),
    'bookmarks:saved': () => JSON.parse(contents()),
    // What a folder's menu would hold, without opening it.
    'bookmarks:menu': (id) => {
      const names = (items) => items.map((i) => (i.submenu ? { [i.label]: names(i.submenu) } : i.label));
      return names(folderMenu(folder(id)?.children || []));
    },
    // Runs an item of the app menu by its shortcut, as the keyboard would.
    'menu:key': (accelerator) => {
      const find = (menu) => {
        for (const item of menu.items) {
          if (item.accelerator === accelerator) return item;
          const inner = item.submenu && find(item.submenu);
          if (inner) return inner;
        }
        return null;
      };
      const item = find(Menu.getApplicationMenu());
      if (!item) return 'none';
      item.click();
      return 'ok';
    },
  };

  return {
    suggest, handle, flush, probes, menuItems, barShown,
    state: () => ({ bookmark: byUrl.get(tabs.active()?.url)?.id || null }),
  };
}

// ── the bookmarks file format ───────────────────────────────────────────────
// <DT><H3 ...>Folder</H3> followed by <DL> ... </DL> for its contents;
// <DT><A HREF="..." ADD_DATE="..." ICON="data:...">Title</A> for a bookmark.
// Returns the top level as [{ title, children, toolbar?, unfiled? } | { url, title, icon? }].
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] === '#') {
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    try { return String.fromCodePoint(code); } catch { return m; }
  }
  return ENTITIES[e.toLowerCase()] ?? m;
});
const attrsOf = (s) => {
  const out = {};
  for (const [, name, value] of s.matchAll(/([\w-]+)\s*=\s*"([^"]*)"/g)) out[name.toUpperCase()] = decode(value);
  return out;
};
const textOf = (s) => decode(s.replace(/<[^>]*>/g, '')).trim();

function parseNetscape(html) {
  const top = { children: [] };
  const stack = [top];
  let pending = null; // a folder whose <DL> comes next
  const tokens = /<DT>\s*<H3([^>]*)>([\s\S]*?)<\/H3>|<DT>\s*<A\s([^>]*)>([\s\S]*?)<\/A>|<DL\b[^>]*>|<\/DL>/gi;
  for (const m of html.matchAll(tokens)) {
    const here = stack[stack.length - 1];
    if (m[1] !== undefined) {
      const a = attrsOf(m[1]);
      pending = { title: textOf(m[2]), children: [], added: seconds(a.ADD_DATE) };
      if (a.PERSONAL_TOOLBAR_FOLDER === 'true') pending.toolbar = true;
      if (a.UNFILED_BOOKMARKS_FOLDER === 'true') pending.unfiled = true;
      here.children.push(pending);
    } else if (m[3] !== undefined) {
      const a = attrsOf(m[3]);
      if (!a.HREF) continue;
      const item = { url: a.HREF, title: textOf(m[4]), added: seconds(a.ADD_DATE) };
      if (/^data:image\//i.test(a.ICON || '') && a.ICON.length <= ICON_MAX) item.icon = a.ICON;
      here.children.push(item);
    } else if (m[0][1] !== '/') {
      // The outermost list belongs to no folder; it stands for the top level.
      stack.push(pending || here);
      pending = null;
    } else if (stack.length > 1) {
      stack.pop();
    }
  }
  return top.children;
}
const seconds = (s) => (/^\d+$/.test(s || '') ? Number(s) * 1000 : undefined);

module.exports = { createBookmarks, parseNetscape };
