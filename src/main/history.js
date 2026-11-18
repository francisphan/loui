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
const { app, nativeImage } = require('electron');
const { YOU } = require('./tabs');

const KEEP = 5000; // entries; the least recently visited go first
const ICON_MAX = 8000; // characters of a site's icon as kept (a data: address, drawn at 32px)
const ICON = /^data:image\/[\w.+-]+;base64,[A-Za-z0-9+/=]+$/;
const DAY = 24 * 60 * 60 * 1000;

function createHistory({ file, tabs, changed = () => {}, delay = 500 }) {
  const entries = new Map(); // url -> { url, title, visits, first, last }
  // Each visited site's icon, as a tab of the user's last showed it: host -> data: address.
  // Kept with the history, and gone with it (see contents()).
  const icons = new Map();
  try {
    const had = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const e of had.entries || []) {
      if (e && typeof e.url === 'string') entries.set(e.url, e);
    }
    for (const [host, icon] of Object.entries(had.icons || {})) {
      if (typeof icon === 'string' && icon.length <= ICON_MAX && ICON.test(icon)) icons.set(host, icon);
    }
  } catch {}
  const hostOf = (url) => { try { return new URL(url).host; } catch { return ''; } };

  // ── saving ──────────────────────────────────────────────────────────────
  let timer = null;
  let writing = Promise.resolve();
  let started = 0, finished = 0, flushed = 0; // saves begun, the last one done, and the last one flush() overtook
  const contents = () => {
    // An icon stays only as long as a page of its site is in the history.
    if (icons.size) {
      const hosts = new Set([...entries.keys()].map(hostOf));
      for (const host of icons.keys()) if (!hosts.has(host)) icons.delete(host);
    }
    return JSON.stringify({ version: 1, entries: [...entries.values()], ...(icons.size ? { icons: Object.fromEntries(icons) } : {}) });
  };
  function save() {
    changed();
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const data = contents();
      const n = ++started;
      // One write at a time, in order, so an older save never lands last.
      writing = writing.then(() => fs.promises.writeFile(file + '.tmp', data, { mode: 0o600 }))
        .then(() => (n > flushed ? fs.promises.rename(file + '.tmp', file) : null)) // flush() wrote something newer
        .catch((e) => console.error('[history] could not save:', e.message))
        .finally(() => { finished = n; });
    }, delay);
  }
  // On quit, a save that is pending, or still on its way to the file (Loui
  // would be gone before it got there), is written at once.
  function flush() {
    if (!timer && finished === started) return;
    clearTimeout(timer);
    timer = null;
    flushed = started;
    try {
      fs.writeFileSync(file + '.quit', contents(), { mode: 0o600 });
      fs.renameSync(file + '.quit', file);
    } catch {}
  }

  // ── recording ───────────────────────────────────────────────────────────
  const worthKeeping = (url) => /^https?:\/\//i.test(url);
  // Only tabs in the user's own group. A tab the user handed to a session
  // belongs to the session until it comes back.
  // Nor a private window's tabs, which keep no history.
  const usersTab = (wc) => {
    const tab = tabs.list.find((t) => t.wc === wc);
    return tab?.group === YOU && !tab.private && !tab.offRecord; // offRecord: Claude Code's sign-in page (main.js)
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
  const visitsBy = new WeakMap(); // a page -> Map of url -> how many of its visits were this page's
  const count = (wc, url) => {
    if (!worthKeeping(url)) return;
    const by = visitsBy.get(wc) || new Map();
    by.set(url, (by.get(url) || 0) + 1);
    visitsBy.set(wc, by);
  };
  app.on('web-contents-created', (_e, wc) => {
    wc.on('did-navigate', (_ev, url) => { if (usersTab(wc)) { count(wc, url); visit(url, ''); } });
    wc.on('did-navigate-in-page', (_ev, url, isMainFrame) => {
      if (isMainFrame && usersTab(wc)) { count(wc, url); visit(url, wc.getTitle()); }
    });
    wc.on('page-title-updated', (_ev, title) => { if (usersTab(wc)) retitle(wc.getURL(), title); });
  });
  // A pop-up that closed itself (a sign-in window, once it is done) was not a
  // page the user went to: what only it visited is forgotten.
  tabs.on('popup-closed-itself', (wc) => {
    for (const [url, n] of visitsBy.get(wc) || []) {
      const e = entries.get(url);
      if (!e) continue;
      if (e.visits > n) e.visits -= n;
      else entries.delete(url);
      save();
    }
  });

  // A site's icon, once a tab of the user's own (never a private one, nor a
  // session's) has it: shrunk to 32px, and left out if it is still too big.
  const iconFrom = new Map(); // host -> the icon address it was last taken from
  tabs.on('change', () => {
    for (const tab of tabs.list) {
      if (tab.group !== YOU || tab.private || !tab.icon || tab.loading || !tab.iconUrl || !worthKeeping(tab.url)) continue;
      const host = hostOf(tab.url);
      if (!host || iconFrom.get(host) === tab.iconUrl || !entries.has(tab.url)) continue;
      iconFrom.set(host, tab.iconUrl);
      let icon = '';
      try {
        const img = nativeImage.createFromBuffer(tab.icon.bytes);
        // What cannot be read here (SVG, and ICO outside Windows) is kept as it came, if small.
        icon = img.isEmpty() ? tabs.iconData(tab) || '' : img.resize({ width: 32, height: 32, quality: 'best' }).toDataURL();
      } catch {}
      if (!icon || icon.length > ICON_MAX || !ICON.test(icon) || icons.get(host) === icon) continue;
      icons.set(host, icon);
      save();
    }
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
  // { host, url (the site's front page), visits, icon }. hidden: hosts to
  // leave out. A site visited only once is not one the user keeps going to.
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
    return [...sites.values()].filter((s) => s.visits > 1 && !hidden.includes(s.host))
      .sort((a, b) => b.visits - a.visits || b.last - a.last).slice(0, limit)
      .map((s) => ({ ...s, icon: icons.get(s.host) || '' }));
  }

  function remove(url) {
    if (entries.delete(url)) save();
  }

  function clear() {
    entries.clear();
    icons.clear();
    iconFrom.clear();
    save();
  }

  // Forgets the pages last visited at or after a time, and says how many.
  // (One entry is kept per page, so a page also visited before then goes too.)
  function clearSince(time) {
    const before = entries.size;
    for (const e of [...entries.values()]) if (e.last >= time) entries.delete(e.url);
    iconFrom.clear(); // a site visited again has its icon taken again
    if (entries.size !== before) save();
    return before - entries.size;
  }

  return { visit, suggest, list, top, remove, clear, clearSince, flush };
}

module.exports = { createHistory };
