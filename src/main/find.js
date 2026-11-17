// Find in page: the find bar in the window chrome searches the tab on screen.
// It follows the user to whichever tab they switch to, and closes when that
// tab navigates away (the matches would belong to a page that is gone).
// The bar belongs to the window it was opened in, and follows the tab on
// screen there; other windows have no bar open.
function createFind({ tabs, changed, focus }) {
  let open = false;
  let text = '';
  let tab = null; // the tab being searched
  let win = null; // the window whose bar is open
  let request = 0; // the latest search; results from older ones are ignored
  let matches = 0; // null while a new search has no results yet
  let active = 0;
  const watched = new WeakSet();

  const live = (t) => t && t.wc && !t.wc.isDestroyed();
  const clear = (t) => { if (live(t)) t.wc.stopFindInPage('clearSelection'); };

  function watch(t) {
    if (watched.has(t.wc)) return; // a tab that slept and woke has a new page
    watched.add(t.wc);
    t.wc.on('found-in-page', (_e, r) => {
      if (t !== tab || r.requestId !== request) return;
      matches = r.matches;
      if (r.activeMatchOrdinal) active = r.activeMatchOrdinal;
      changed();
    });
    // Esc while the page has focus closes the bar too. The page still gets the key.
    t.wc.on('before-input-event', (_e, input) => {
      if (open && t === tab && input.type === 'keyDown' && input.key === 'Escape') close();
    });
  }

  // again: go to the next (or previous) match of the same text, rather than start over.
  function search({ text: next = '', forward = true, again = false } = {}) {
    if (!open) return;
    text = next;
    if (!text) {
      clear(tab);
      request = 0;
      matches = active = 0;
      return changed();
    }
    if (!live(tab)) return;
    watch(tab);
    if (!again) { matches = null; active = 0; }
    request = tab.wc.findInPage(text, { forward, findNext: !again });
    changed();
  }

  function show() {
    if (!open || win !== tabs.window()) { // opened in another window, the bar moves here
      if (open) clear(tab);
      open = true;
      win = tabs.window();
      tab = tabs.active();
      changed();
    }
    focus();
  }

  function close() {
    if (!open) return;
    clear(tab);
    open = false;
    text = '';
    tab = win = null;
    request = matches = active = 0;
    changed();
  }

  tabs.on('change', () => {
    if (open && !tabs.windows.includes(win)) return close();
    const shown = open && tabs.get(win.activeId);
    if (!open || tab === shown) return;
    clear(tab);
    tab = shown;
    search({ text });
  });
  tabs.on('leaving', (t) => { if (t === tab) close(); });

  return {
    show,
    close,
    search,
    state: () => (open && win === tabs.window() ? { open, text, matches, active } : { open: false, text: '', matches: 0, active: 0 }),
  };
}

module.exports = { createFind };
