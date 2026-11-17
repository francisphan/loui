// Bookmarks in the window chrome: the star in the address bar, the bookmarks
// bar under the toolbar, the strip that edits a bookmark, and the bookmarks
// panel. The bookmarks live in the main process (src/main/bookmarks.js); this
// draws what it sends and sends the user's intentions back. Titles come from
// web pages and imported files, so they are always set as text.
// Loaded after history.js; uses $, el, svg, ICON, setIcon, activeTab,
// panelOpen and togglePanel from ui.js, historyOpen and showHistory from history.js.
(() => {
  ICON.star = svg('<path d="m8 1.9 1.85 3.85 4.2.55-3.07 2.92.78 4.18L8 11.36 4.24 13.4l.78-4.18L1.95 6.3l4.2-.55z"/>');
  ICON.folder = svg('<path d="M1.75 3.25h4.5l1.5 1.75h6.5v7.75H1.75z"/>');
  ICON.page = svg('<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2.2 2.2 2.2 9.8 0 12M8 2C5.8 4.2 5.8 11.8 8 14"/>');
  ICON.more = svg('<path d="m4 4 4 4-4 4M8.5 4l4 4-4 4"/>');
  ICON.edit = svg('<path d="M10.5 2.5l3 3-8 8h-3v-3z"/>', 14);

  const ask = (request) => loui.send('bookmarks', request);
  let data = { showBar: false, bar: [], other: 0, folders: [] };

  // ── the star ────────────────────────────────────────────────────────────
  const star = $('star');
  setIcon(star, 'star');
  star.onclick = () => ask({ do: 'star' });
  loui.on('state', (next) => {
    star.hidden = !/^(https?|file|ftp):/i.test(activeTab()?.url || '');
    star.classList.toggle('on', !!next.bookmark);
    const what = next.bookmark ? 'Edit bookmark (Ctrl+D)' : 'Bookmark this page (Ctrl+D)';
    star.title = what;
    star.setAttribute('aria-label', what);
  });

  // ── the bar ─────────────────────────────────────────────────────────────
  // One button per bookmark on the bar; folders open as menus drawn by the
  // main process (they have to cover the page). What does not fit goes in »'s menu.
  const bar = $('bookmarks-bar');
  const items = $('bookmarks-items');
  setIcon($('bookmarks-more'), 'more');
  setIcon($('bookmarks-other').querySelector('.glyph'), 'folder');

  const menuUnder = (node, id, from) => {
    const r = node.getBoundingClientRect();
    ask({ do: 'menu', id, from, x: r.left, y: r.bottom });
  };
  const mark = (b) => {
    if (!b.icon) {
      const glyph = el('span', 'glyph');
      setIcon(glyph, b.folder ? 'folder' : 'page');
      return glyph;
    }
    const img = el('img');
    img.src = b.icon;
    img.alt = '';
    img.onerror = () => img.replaceWith(mark({ ...b, icon: null }));
    return img;
  };
  function barItem(b) {
    const item = el('button', 'bar-item' + (b.folder ? ' folder' : ''));
    item.type = 'button';
    item.tabIndex = -1; // the bar is one Tab stop (see rove())
    item.dataset.id = b.id;
    item.title = b.folder ? b.title : `${b.title}\n${b.url}`;
    item.append(mark(b), el('span', 'name', b.title));
    if (b.folder) {
      item.onclick = () => menuUnder(item, b.id);
    } else {
      item.onclick = (e) => ask({ do: 'open', id: b.id, newTab: e.ctrlKey || e.metaKey || e.shiftKey });
      item.onauxclick = (e) => { if (e.button === 1) ask({ do: 'open', id: b.id, newTab: true }); };
    }
    item.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      ask({ do: 'context', id: b.id });
    };
    return item;
  }

  let firstHidden = -1;
  function fit() {
    const kids = [...items.children];
    for (const k of kids) k.classList.remove('overflow');
    const room = items.clientWidth;
    firstHidden = kids.findIndex((k) => k.offsetLeft + k.offsetWidth > room);
    if (firstHidden >= 0) for (const k of kids.slice(firstHidden)) k.classList.add('overflow');
    $('bookmarks-more').hidden = firstHidden < 0;
    if (!stops().some((s) => s.tabIndex === 0)) rove(stops()[0]);
  }
  // The bar is one Tab stop: Left and Right (Home and End) move between its
  // items, the » and "Other bookmarks" included.
  const stops = () => [...items.children].filter((k) => !k.classList.contains('overflow'))
    .concat([$('bookmarks-more'), $('bookmarks-other')].filter((b) => !b.hidden));
  function rove(to) {
    for (const s of [...items.children, $('bookmarks-more'), $('bookmarks-other')]) s.tabIndex = s === to ? 0 : -1;
  }
  rove(null); // fit() gives the first item the Tab stop
  bar.addEventListener('keydown', (e) => {
    const all = stops();
    const at = all.indexOf(e.target);
    if (at < 0) return;
    const to = e.key === 'ArrowRight' ? all[at + 1] : e.key === 'ArrowLeft' ? all[at - 1]
      : e.key === 'Home' ? all[0] : e.key === 'End' ? all[all.length - 1] : null;
    if (!to) return;
    e.preventDefault();
    rove(to);
    to.focus();
  });
  new ResizeObserver(fit).observe(items);
  $('bookmarks-more').onclick = () => menuUnder($('bookmarks-more'), 'bar', firstHidden);
  $('bookmarks-other').onclick = () => menuUnder($('bookmarks-other'), 'other');
  $('bookmarks-other').oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); ask({ do: 'context' }); };
  bar.oncontextmenu = (e) => { e.preventDefault(); ask({ do: 'context' }); };
  $('bookmarks-hint-import').onclick = () => ask({ do: 'import' });

  function drawBar() {
    bar.hidden = !data.showBar;
    items.replaceChildren(...data.bar.map(barItem));
    $('bookmarks-hint').hidden = data.bar.length > 0;
    $('bookmarks-other').hidden = !data.other;
    fit();
  }

  // ── editing ─────────────────────────────────────────────────────────────
  // A strip under the toolbar, as the find bar is: the page moves down for it.
  // Done (or Enter) keeps the changes, as does leaving the strip; Esc drops them.
  const editor = $('bookmark-edit');
  const name = $('bookmark-name');
  const url = $('bookmark-url');
  const where = $('bookmark-folder');
  let editing = null; // the item being edited

  function openEditor(item) {
    editing = item;
    $('bookmark-edit-title').textContent = item.folder ? 'Folder' : item.fresh ? 'Bookmark added' : 'Bookmark';
    name.value = item.title;
    url.value = item.url || '';
    $('bookmark-url-label').hidden = !!item.folder;
    // A folder cannot go inside itself.
    where.replaceChildren(...data.folders
      .filter((f) => !item.folder || (f.id !== item.id && !f.path.includes(item.id)))
      .map((f) => {
        const option = el('option', '', ' '.repeat(f.depth) + f.title);
        option.value = f.id;
        return option;
      }));
    where.value = item.parent;
    editor.hidden = false;
    name.focus();
    name.select();
  }
  function closeEditor(keep) {
    if (!editing) return;
    if (keep) ask({ do: 'update', id: editing.id, title: name.value, url: url.value, parent: where.value });
    editing = null;
    editor.hidden = true;
  }
  editor.onsubmit = (e) => {
    e.preventDefault();
    closeEditor(true);
    ask({ do: 'closed' });
  };
  editor.onkeydown = (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    closeEditor(false);
    ask({ do: 'closed' });
  };
  $('bookmark-remove').onclick = () => {
    if (editing) ask({ do: 'remove', id: editing.id });
    editing = null;
    editor.hidden = true;
    ask({ do: 'closed' });
  };
  // Clicking elsewhere in the window keeps what was typed and closes the strip.
  editor.addEventListener('focusout', (e) => {
    if (editor.contains(e.relatedTarget)) return;
    setTimeout(() => {
      if (document.hasFocus() && !editor.contains(document.activeElement)) closeEditor(true);
    }, 0);
  });

  // ── the panel ───────────────────────────────────────────────────────────
  // All bookmarks, in their folders. Takes the Claude panel's place while
  // open, as the history panel does; only one of the two is open at a time.
  setIcon($('bookmarks-close'), 'close');
  const list = $('bookmarks-list');
  const search = $('bookmarks-search');
  const unfolded = new Set(); // folders the user opened in the panel
  const bookmarksOpen = () => document.body.classList.contains('bookmarks-open');
  const refresh = () => ask({ do: 'list', query: search.value });

  function showBookmarks(show) {
    if (show && historyOpen()) showHistory(false);
    document.body.classList.toggle('bookmarks-open', show);
    $('bookmarks').hidden = !show;
    $('bookmarks-confirm').hidden = true;
    $('panel-toggle').classList.toggle('on', !show && !historyOpen() && panelOpen());
    if (show) {
      refresh();
      search.focus();
    } else focusPage();
  }
  $('bookmarks-close').onclick = () => showBookmarks(false);
  $('bookmarks-new-folder').onclick = () => ask({ do: 'folder', parent: 'bar' });
  $('bookmarks-import').onclick = () => ask({ do: 'import' });
  search.oninput = refresh;
  // Esc anywhere in the panel: first out of the question, then the panel closes.
  $('bookmarks').addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if ($('bookmarks-confirm').hidden) return showBookmarks(false);
    $('bookmarks-confirm').hidden = true;
    search.focus();
  });
  // Opening history, or asking for the Claude panel, closes this one.
  const historyInstead = () => { if (bookmarksOpen() && historyOpen()) showBookmarks(false); };
  $('history-toggle').addEventListener('click', historyInstead);
  loui.on('show-history', historyInstead);
  const claudeInstead = () => {
    if (!bookmarksOpen()) return;
    showBookmarks(false);
    togglePanel(true);
  };
  $('panel-toggle').addEventListener('click', claudeInstead);
  loui.on('toggle-panel', claudeInstead);
  loui.on('show-relay', claudeInstead);

  let removing = null;
  $('bookmarks-confirm-no').onclick = () => { $('bookmarks-confirm').hidden = true; };
  $('bookmarks-confirm-yes').onclick = () => {
    $('bookmarks-confirm').hidden = true;
    if (removing) ask({ do: 'remove', id: removing });
  };
  function remove(n) {
    if (!n.folder || !n.children?.length) return ask({ do: 'remove', id: n.id });
    removing = n.id;
    $('bookmarks-confirm-text').textContent = `Delete "${n.title}" and everything in it?`;
    $('bookmarks-confirm').hidden = false;
  }

  const plainUrl = (u) => u.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');
  const small = (className, icon, label, onclick) => {
    const b = el('button', className);
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    setIcon(b, icon);
    b.onclick = onclick;
    return b;
  };
  // One row, and for an open folder its contents under it.
  function rows(n, depth) {
    const row = el('div', 'bookmark-row' + (n.folder ? ' folder' : ''));
    row.dataset.id = n.id;
    row.style.setProperty('--depth', depth);
    const open = el('button', 'open');
    open.type = 'button';
    if (n.folder) {
      const shown = unfolded.has(n.id);
      open.setAttribute('aria-expanded', shown);
      open.append(mark(n), el('span', 'title', n.title));
      open.onclick = () => {
        if (shown) unfolded.delete(n.id);
        else unfolded.add(n.id);
        refresh();
      };
    } else {
      open.title = n.url;
      open.append(el('span', 'title', n.title || plainUrl(n.url)), el('span', 'url', plainUrl(n.url)));
      open.onclick = () => ask({ do: 'open', id: n.id });
      open.onauxclick = (e) => { if (e.button === 1) ask({ do: 'open', id: n.id, newTab: true }); };
    }
    row.append(open,
      small('edit', 'edit', `Edit ${n.title}`, () => ask({ do: 'edit', id: n.id })),
      small('remove', 'close', `Delete ${n.title}`, () => remove(n)));
    const out = [row];
    if (n.folder && unfolded.has(n.id)) {
      for (const c of n.children) out.push(...rows(c, depth + 1));
    }
    return out;
  }

  function drawList({ query, items: found }) {
    if (query !== search.value) return; // an older search
    const nodes = [];
    if (query.trim()) {
      for (const n of found) nodes.push(...rows(n, 0));
      if (!nodes.length) nodes.push(el('p', 'none', 'No bookmarks match that.'));
    } else {
      for (const root of found) {
        nodes.push(el('h2', '', root.title));
        for (const n of root.children) nodes.push(...rows(n, 0));
        if (!root.children.length) nodes.push(el('p', 'none', 'Empty'));
      }
    }
    list.replaceChildren(...nodes);
  }

  loui.on('bookmarks', (m) => {
    if (m.type === 'data') {
      data = m;
      drawBar();
      if (bookmarksOpen()) refresh();
    } else if (m.type === 'edit') {
      openEditor(m.item);
    } else if (m.type === 'list') {
      drawList(m);
    } else if (m.type === 'panel') {
      showBookmarks(!bookmarksOpen());
    } else if (m.type === 'icon') {
      // An icon as a page or a file gave it: drawn small here, where a page's
      // bytes may be read, and handed back for the main process to keep.
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 32;
        canvas.getContext('2d').drawImage(img, 0, 0, 32, 32);
        loui.send('bookmarks', { do: 'icon', id: m.id, icon: canvas.toDataURL('image/png') });
      };
      img.src = m.icon;
    }
  });
})();
