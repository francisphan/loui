// The user's own tabs outlive a restart, and closed ones can be reopened.
//
// Only the user's tabs are kept (including ones lent to a session, which would
// have come back to the user when it ended). Claude sessions' groups are not:
// those sessions are over once Loui quits.
//
// The session file (tabs.json in the profile) is rewritten at most once a
// second while tabs change, always to a temporary file that is then renamed
// over the old one, so a crash leaves either the old file or the new one. A
// last copy is written as Loui quits, while the tabs still exist.
const fs = require('fs');
const { app } = require('electron');
const { PRESETS, YOU } = require('./tabs');

const EVERY_MS = 1000;
const MAX_ENTRIES = 50; // per tab's history
const MAX_CLOSED = 25;

function createRestore({ tabs, file }) {
  const closed = []; // most recent last
  const pending = new WeakMap(); // tab -> history it was opened with, until the page commits
  let timer = null, last = '', writing = Promise.resolve(), stopped = false;

  const mine = (tab) => tab.group === YOU || tab.lent;

  // Back/forward history, without Chromium's page state (large, and not needed).
  function history(tab) {
    if (tab.wc.isDestroyed()) return pending.get(tab) || null;
    const nav = tab.wc.navigationHistory;
    const all = nav.getAllEntries();
    if (!all.length) return pending.get(tab) || null;
    const at = nav.getActiveIndex();
    const start = Math.max(0, Math.min(at - MAX_ENTRIES / 2, all.length - MAX_ENTRIES));
    const entries = all.slice(start, start + MAX_ENTRIES).map(({ url, title }) => ({ url, title }));
    return { entries, index: at - start };
  }

  function device(tab) {
    const d = tab.device;
    if (!d) return null;
    return Object.keys(PRESETS).find((k) => PRESETS[k] === d) || { width: d.width, height: d.height, mobile: !!d.mobile };
  }

  const describe = (tab) => ({ history: history(tab), device: device(tab) });

  function snapshot() {
    const list = tabs.list.filter(mine);
    const shown = tabs.active();
    const active = list.indexOf(shown && mine(shown) ? shown : tabs.current(YOU));
    return JSON.stringify({ version: 1, active: Math.max(0, active), tabs: list.map(describe) });
  }

  function save() {
    timer = null;
    if (stopped) return;
    const text = snapshot();
    if (text === last) return;
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
    if (text === last) return;
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
    const blank = !was.history?.entries.some((e) => e.url && e.url !== 'about:blank');
    if (blank) return; // nothing worth bringing back
    closed.push({ ...was, at: tabs.list.indexOf(tab) });
    if (closed.length > MAX_CLOSED) closed.shift();
  });
  app.on('before-quit', stop);
  tabs.win.on('close', stop);

  function open(was, show) {
    const h = Array.isArray(was?.history?.entries) && was.history.entries.length ? was.history : null;
    const tab = tabs.create('', { show, device: was?.device || undefined, history: h || undefined });
    if (h) pending.set(tab, h);
    return tab;
  }

  return {
    // Opens the tabs saved last time. False if there were none.
    reopenSaved() {
      let saved;
      try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return false; }
      if (!Array.isArray(saved?.tabs) || !saved.tabs.length) return false;
      const opened = saved.tabs.map((t) => open(t, false));
      tabs.select((opened[saved.active] || opened[0]).id);
      return true;
    },

    // Reopens the tab the user closed most recently, where it was, with its history.
    reopenClosed() {
      const was = closed.pop();
      if (!was) return null;
      const tab = open(was, true);
      tabs.list.splice(tabs.list.indexOf(tab), 1);
      tabs.list.splice(Math.min(was.at, tabs.list.length), 0, tab);
      tabs.emit('change');
      return tab;
    },
  };
}

module.exports = { createRestore };
