// The user's own tabs outlive a restart, and closed ones can be reopened.
//
// Only the user's tabs are kept (including ones lent to a session, which would
// have come back to the user when it ended), window by window. Claude sessions'
// groups are not: those sessions are over once Loui quits. Private windows are
// never kept, nor are their tabs remembered as closed.
//
// The session file (tabs.json in the profile) is rewritten at most once a
// second while tabs change, always to a temporary file that is then renamed
// over the old one, so a crash leaves either the old file or the new one. A
// last copy is written as Loui quits (or its last window closes), while the
// tabs still exist. While only private windows are open nothing is written,
// so the normal windows closed before come back.
const fs = require('fs');
const { app } = require('electron');
const { PRESETS, YOU, onStart } = require('./tabs');

const EVERY_MS = 1000;
const MAX_ENTRIES = 50; // per tab's history
const MAX_CLOSED = 25;

// openWindow(): opens another normal window, with no tab of its own, for a
// second saved window and beyond (see main.js).
// settings: settings.json; "startup": "new" starts with a new tab instead of last time's.
function createRestore({ tabs, file, openWindow, settings = {} }) {
  const closed = []; // most recent last
  const pending = new WeakMap(); // tab -> history it was opened with, until the page commits
  let timer = null, last = '', writing = Promise.resolve(), stopped = false;

  // offRecord: the page Claude Code's sign-in is done on (main.js), which is not brought back.
  const mine = (tab) => (tab.group === YOU || tab.lent) && !tab.private && !tab.offRecord;
  // A tab lent to a session sits in the session's window; it belongs to the one it came from.
  const homeOf = (tab) => (tab.lent && tab.home && tabs.windows.includes(tab.home) ? tab.home : tab.window);

  // Back/forward history, without Chromium's page state (large, and not needed).
  function history(tab) {
    // A sleeping tab, or one just woken whose page has not come back yet, has the history it kept.
    const nav = tab.wc && !tab.wc.isDestroyed() ? tab.wc.navigationHistory : null;
    let all = nav ? nav.getAllEntries() : [];
    let at = nav ? nav.getActiveIndex() : 0;
    if (!all.length && tab.history) ({ entries: all, index: at } = tab.history);
    if (!all.length) return pending.get(tab) || null;
    const start = Math.max(0, Math.min(at - MAX_ENTRIES / 2, all.length - MAX_ENTRIES));
    const entries = all.slice(start, start + MAX_ENTRIES).map(({ url, title }) => ({ url, title }));
    return { entries, index: at - start };
  }

  function device(tab) {
    const d = tab.device;
    if (!d) return null;
    return Object.keys(PRESETS).find((k) => PRESETS[k] === d) || { width: d.width, height: d.height, mobile: !!d.mobile };
  }

  const describe = (tab) => ({ history: history(tab), device: device(tab), pinned: !!tab.pinned });

  // null while no normal window is open (only private ones): nothing to write.
  function snapshot() {
    const windows = tabs.windows.filter((w) => !w.private).map((w) => {
      const list = tabs.list.filter((t) => mine(t) && homeOf(t) === w);
      const shown = tabs.get(w.activeId);
      let active = list.indexOf(shown && mine(shown) ? shown : null);
      if (active < 0) active = list.indexOf(tabs.current(YOU));
      return { active: Math.max(0, active), tabs: list.map(describe) };
    }).filter((w) => w.tabs.length);
    return windows.length ? JSON.stringify({ version: 2, windows }) : null;
  }

  function save() {
    timer = null;
    if (stopped) return;
    const text = snapshot();
    if (text === null || text === last) return;
    last = text;
    const tmp = `${file}.tmp`;
    writing = writing
      .then(() => fs.promises.writeFile(tmp, text, { mode: 0o600 }))
      .then(() => !stopped && fs.promises.rename(tmp, file))
      .catch(() => {});
  }

  // Quitting: write what is open now, then nothing more (the tabs are about to go).
  function stop() {
    if (stopped) return;
    clearTimeout(timer);
    const text = snapshot();
    stopped = true;
    if (text === null || text === last) return;
    try {
      fs.writeFileSync(`${file}.quit`, text, { mode: 0o600 });
      fs.renameSync(`${file}.quit`, file);
    } catch {}
  }

  tabs.on('change', () => {
    if (!timer && !stopped) timer = setTimeout(save, EVERY_MS);
  });
  tabs.on('closing', (tab) => {
    if (!mine(tab) || stopped) return;
    const was = describe(tab);
    const blank = !was.history?.entries.some((e) => e.url && e.url !== 'about:blank' && !onStart(e.url));
    if (blank) return; // nothing worth bringing back
    closed.push({ ...was, at: tabs.in(tab.group).filter((t) => t.window === tab.window).indexOf(tab) });
    if (closed.length > MAX_CLOSED) closed.shift();
  });
  app.on('before-quit', stop);

  // asleep: the tab loads only when it is selected (or Claude uses it).
  function open(was, show, asleep = false, window) {
    const h = Array.isArray(was?.history?.entries) && was.history.entries.length ? was.history : null;
    const tab = tabs.create('', {
      show, device: was?.device || undefined, history: h || undefined, asleep, pinned: was?.pinned === true, window,
    });
    if (h) pending.set(tab, h);
    return tabs.byUser(tab);
  }

  // One saved window's tabs into w.
  function fill(w, saved) {
    // All but the one on screen start asleep, so a restart does not load every tab at
    // once. Pinned tabs load: they never sleep (see sleep.js), like a mail tab kept open.
    const opened = saved.tabs.map((t) => open(t, false, t?.pinned !== true, w));
    tabs.select((opened[saved.active] || opened[0]).id);
  }

  return {
    // Opens the windows saved last time: the first one's tabs into first
    // (already open), each other one in a new window. False if there were none.
    reopenSaved(first) {
      if (settings.startup === 'new') return false;
      let saved;
      try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return false; }
      // Version 1 kept a single window: { active, tabs }.
      const windows = (Array.isArray(saved?.windows) ? saved.windows : [saved])
        .filter((w) => Array.isArray(w?.tabs) && w.tabs.length);
      if (!windows.length) return false;
      fill(first, windows[0]);
      for (const more of windows.slice(1)) fill(openWindow(), more);
      tabs.focus(first);
      return true;
    },

    // Reopens the tab the user closed most recently, where it was, with its
    // history. Not into a private window: a normal tab's page has no place there.
    reopenClosed() {
      if (tabs.window()?.private) return null;
      const was = closed.pop();
      if (!was) return null;
      const tab = open(was, true);
      tabs.reorder(tab.id, was.at);
      return tab;
    },
    // Whether there is a closed tab to reopen (the menu offers it only then).
    canReopen: () => closed.length > 0,

    stop,
  };
}

module.exports = { createRestore };
