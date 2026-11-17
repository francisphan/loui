// Find in page: the find bar in the window chrome searches the tab on screen.
// It follows the user to whichever tab they switch to, and closes when that
// tab navigates away (the matches would belong to a page that is gone).
function createFind({ tabs, changed, focus }) {
  let open = false;
  let text = '';
  let tab = null; // the tab being searched
  let request = 0; // the latest search; results from older ones are ignored
  let matches = 0; // null while a new search has no results yet
  let active = 0;
  const watched = new WeakSet();

  const live = (t) => t && !t.wc.isDestroyed();
  const clear = (t) => { if (live(t)) t.wc.stopFindInPage('clearSelection'); };

  function watch(t) {
    if (watched.has(t)) return;
    watched.add(t);
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
    if (!open) {
      open = true;
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
    tab = null;
    request = matches = active = 0;
    changed();
  }

  tabs.on('change', () => {
    if (!open || tab === tabs.active()) return;
    clear(tab);
    tab = tabs.active();
    search({ text });
  });
  tabs.on('leaving', (t) => { if (t === tab) close(); });

  return {
    show,
    close,
    search,
    state: () => ({ open, text, matches, active }),
  };
}

module.exports = { createFind };
