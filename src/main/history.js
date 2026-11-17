// History: the pages the user visits in their own tabs. Pages that Claude
// sessions open in their tab groups are left out: they are the session's
// work, not the user's browsing.
// Private windows record nothing.
//
// One entry per URL (title, visit count, first and last visit), kept in
// memory and saved to history.json in the profile. Saves are batched and run
// off the main thread's critical path, written to a temporary file and renamed
// over the old one so a crash never leaves half a file.
const fs = require('fs');
const { app } = require('electron');
const { YOU } = require('./tabs');

const KEEP = 5000; // entries; the least recently visited go first
const DAY = 24 * 60 * 60 * 1000;

function createHistory({ file, tabs, changed = () => {}, delay = 500 }) {
  const entries = new Map(); // url -> { url, title, visits, first, last }
  try {
    for (const e of JSON.parse(fs.readFileSync(file, 'utf8')).entries || []) {
      if (e && typeof e.url === 'string') entries.set(e.url, e);
    }
  } catch {}

  // ── saving ──────────────────────────────────────────────────────────────
  let timer = null;
  let writing = Promise.resolve();
  const contents = () => JSON.stringify({ version: 1, entries: [...entries.values()] });
  function save() {
    changed();
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const data = contents();
      // One write at a time, in order, so an older save never lands last.
      writing = writing.then(() => fs.promises.writeFile(file + '.tmp', data, { mode: 0o600 }))
        .then(() => fs.promises.rename(file + '.tmp', file))
        .catch((e) => console.error('[history] could not save:', e.message));
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

  // ── recording ───────────────────────────────────────────────────────────
  const worthKeeping = (url) => /^https?:\/\//i.test(url);
  // Only tabs in the user's own group. A tab the user handed to a session
  // belongs to the session until it comes back.
  // Nor a private window's tabs, which keep no history.
  const usersTab = (wc) => {
    const tab = tabs.list.find((t) => t.wc === wc);
    return tab?.group === YOU && !tab.private;
  };

  function visit(url, title) {
    if (!worthKeeping(url)) return;
    const now = Date.now();
    const e = entries.get(url) || { url, title: '', visits: 0, first: now, last: now };
    e.visits++;
    e.last = now;
    if (title) e.title = title;
    entries.delete(url); // re-inserted, so the map stays in order of last visit
    entries.set(url, e);
    if (entries.size > KEEP) entries.delete(entries.keys().next().value);
    save();
  }

  function retitle(url, title) {
    const e = entries.get(url);
    if (!e || !title || e.title === title) return;
    e.title = title;
    save();
  }

  // Every tab's page is a WebContents; this sees each one as it is made, and
  // asks which tab (and so which group) it belongs to each time it navigates.
  app.on('web-contents-created', (_e, wc) => {
    wc.on('did-navigate', (_ev, url) => { if (usersTab(wc)) visit(url, ''); });
    wc.on('did-navigate-in-page', (_ev, url, isMainFrame) => {
      if (isMainFrame && usersTab(wc)) visit(url, wc.getTitle());
    });
    wc.on('page-title-updated', (_ev, title) => { if (usersTab(wc)) retitle(wc.getURL(), title); });
  });

  // ── reading ─────────────────────────────────────────────────────────────
  // Lower case, without the scheme and "www.", which nobody types.
  const bare = (url) => url.toLowerCase().replace(/^https?:\/\/(www\.)?/, '');
  const termsOf = (query) => (query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (e, terms) => {
    const hay = e.title.toLowerCase() + ' ' + bare(e.url);
    return terms.every((t) => hay.includes(t));
  };

  // Frecency: visits, weighted by how recent the last one was.
  function frecency(e, now) {
    const age = now - e.last;
    const weight = age < 4 * DAY ? 100 : age < 14 * DAY ? 70 : age < 31 * DAY ? 50 : age < 90 * DAY ? 30 : 10;
    return e.visits * weight;
  }

  // As a suggestion source: pages matching what the user typed, best first.
  // A page whose address starts with it, or with a title word that does,
  // ranks above one that only contains it somewhere.
  function suggest(query, limit = 8) {
    const terms = termsOf(query);
    if (!terms.length) return [];
    const now = Date.now();
    const out = [];
    for (const e of entries.values()) {
      if (!matches(e, terms)) continue;
      const first = terms[0];
      const boost = bare(e.url).startsWith(first) ? 4
        : e.title.toLowerCase().split(/\W+/).some((w) => w.startsWith(first)) ? 2 : 1;
      out.push({ url: e.url, title: e.title, score: frecency(e, now) * boost, source: 'history' });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  // For the history panel: matching pages, most recent first.
  function list(query, limit = 300) {
    const terms = termsOf(query);
    const out = [];
    for (const e of [...entries.values()].reverse()) {
      if (terms.length && !matches(e, terms)) continue;
      out.push({ ...e });
      if (out.length >= limit) break;
    }
    return out;
  }

  // For the start page: the sites visited most, most visited first, as
  // { host, url (the site's front page), visits }. hidden: hosts to leave out.
  function top(limit = 8, hidden = []) {
    const sites = new Map();
    for (const e of entries.values()) {
      let u;
      try { u = new URL(e.url); } catch { continue; }
      const s = sites.get(u.host) || { host: u.host, url: u.origin + '/', visits: 0, last: 0 };
      s.visits += e.visits;
      s.last = Math.max(s.last, e.last);
      sites.set(u.host, s);
    }
    return [...sites.values()].filter((s) => !hidden.includes(s.host))
      .sort((a, b) => b.visits - a.visits || b.last - a.last).slice(0, limit);
  }

  function remove(url) {
    if (entries.delete(url)) save();
  }

  function clear() {
    entries.clear();
    save();
  }

  return { visit, suggest, list, top, remove, clear, flush };
}

module.exports = { createHistory };
