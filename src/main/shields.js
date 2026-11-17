// Shields: blocks ads and trackers, in every tab.
//
// - Requests: each one a page makes is matched against the filter lists
//   (EasyList, EasyPrivacy, Peter Lowe's list and uBlock Origin's filters,
//   from Ghostery's maintained mirror) and cancelled, or answered with a
//   harmless stand-in script where the lists say so, which keeps sites that
//   expect e.g. Google Analytics working. Matching uses Ghostery's engine
//   directly: its Electron package would install session hooks of its own,
//   and a session has room for only one (see requests.js).
// - Cosmetic filtering: once the page is parsed, a stylesheet hides the
//   empty boxes ads leave behind. It is built from the rules for the site and
//   the generic rules that match the class names and ids found in the page,
//   looked for again when the page finishes loading and a moment later.
// - Per site: the toolbar button shows how many requests were blocked on the
//   page on screen, and turns Shields off for its site (the host name). Sites
//   with Shields off are kept in shields.json in the profile.
//
// The lists are not downloaded at start. The finished engine is kept in the
// profile (shields/engine.bin, about 7 MB, loaded in a few tens of ms) and
// rebuilt in the background, in a process of its own (shields-update.js),
// when it is more than four days old. Until the first download is done,
// nothing is blocked.
//
// LOUI_SHIELDS_LISTS (comma-separated URLs) replaces the lists; the tests
// point it at a small local list. The tests download nothing otherwise.
const fs = require('fs');
const path = require('path');
const { Menu, utilityProcess } = require('electron');
const { FiltersEngine, Request, adsAndTrackingLists } = require('@ghostery/adblocker');
const { requestRules } = require('./requests');

const RESOURCES = 'https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/ublock-origin/resources.json';
const MAX_AGE = 4 * 24 * 3600e3; // lists older than this are downloaded again
const RETRY = 3600e3; // after a failed download
const WORLD = 4813; // isolated world for looking at the page (actions.js uses 4812)

// The class names, ids and link targets in the page, which generic hiding
// rules are keyed on. Run in an isolated world, so the page cannot interfere.
const SCAN = `(() => {
  const classes = new Set(), ids = new Set(), hrefs = new Set();
  const all = document.querySelectorAll('[id],[class],a[href]');
  for (let i = 0; i < all.length && i < 10000; i++) {
    const el = all[i];
    if (el.id) ids.add(el.id);
    for (const c of el.classList) classes.add(c);
    if (el.tagName === 'A' && el.href) hrefs.add(el.href);
  }
  return { classes: [...classes], ids: [...ids], hrefs: [...hrefs] };
})()`;

const siteOf = (url) => {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.hostname : null;
  } catch {
    return null;
  }
};

function createShields({ ses, tabs, home, changed }) {
  const dir = path.join(home, 'shields');
  const engineFile = path.join(dir, 'engine.bin');
  const sitesFile = path.join(home, 'shields.json');
  const off = new Set((() => {
    try { return JSON.parse(fs.readFileSync(sitesFile, 'utf8')).off || []; } catch { return []; }
  })());
  const custom = process.env.LOUI_SHIELDS_LISTS;
  const lists = custom ? custom.split(',').filter(Boolean)
    : process.env.LOUI_TEST ? null : adsAndTrackingLists;

  let engine = null;
  let updated = 0; // when the engine in use was built
  let updating = null; // the update process, while it runs
  let tried = 0;
  // tab id -> the page now in it: requests blocked there, and the class
  // names, ids and links its hiding rules have been asked for.
  const pages = new Map();
  const hooked = new WeakSet();

  // Counts change many times a second while a page loads; the window hears about them at most four times.
  let soon = null;
  const later = () => { soon ??= setTimeout(() => { soon = null; changed(); }, 250); };

  function load() {
    try {
      const stat = fs.statSync(engineFile);
      engine = FiltersEngine.deserialize(new Uint8Array(fs.readFileSync(engineFile)));
      updated = stat.mtimeMs;
    } catch {
      updated = 0; // missing, or built by another version of the engine: build it again
    }
    changed();
  }

  function update() {
    if (updating || !lists) return;
    tried = Date.now();
    fs.mkdirSync(dir, { recursive: true });
    updating = utilityProcess.fork(path.join(__dirname, 'shields-update.js'),
      [engineFile, custom ? '-' : RESOURCES, ...lists], { serviceName: 'Loui filter lists' });
    updating.once('exit', (code) => {
      updating = null;
      if (code === 0) load();
    });
  }

  function check() {
    if (Date.now() - updated > MAX_AGE && Date.now() - tried > RETRY) update();
  }

  // ── requests ──
  // A sleeping tab has no page (tab.wc is null) until it wakes; see tabs.js.
  const tabOf = (id) => tabs.list.find((t) => t.wc?.id === id);
  // The page a request belongs to. Shields records each page's address when
  // its navigation starts, before any of its requests: asking the tab instead
  // can still answer about:blank for a tab that has only just been opened,
  // which made a site's "Shields off" miss its first requests.
  const topOf = (d, tab) => {
    if (d.resourceType === 'mainFrame') return d.url;
    const known = tab && pages.get(tab.id)?.url;
    if (known && /^https?:/.test(known)) return known;
    try { if (d.frame?.top?.url) return d.frame.top.url; } catch {}
    return tab?.wc?.getURL() || d.referrer || '';
  };

  const block = (d) => {
    if (!engine || !/^(https?|wss?):/.test(d.url)) return null;
    const tab = tabOf(d.webContentsId);
    const top = topOf(d, tab);
    if (off.has(siteOf(top))) return null;
    const { match, redirect } = engine.match(Request.fromRawDetails({
      requestId: String(d.id), tabId: d.webContentsId || 0, url: d.url, sourceUrl: top, type: d.resourceType || 'other',
    }));
    if (!match && !redirect) return null;
    const page = tab && pages.get(tab.id);
    if (page) {
      page.blocked++;
      later();
    }
    return redirect ? { redirectURL: redirect.dataUrl } : { cancel: true };
  };
  // Each session: the user's, and each private one (main.js attaches those).
  const attach = (s) => requestRules(s).add(block);
  attach(ses);

  // ── hiding what the ads leave behind ──
  // first: the page has just been parsed; the site's rules go in too.
  async function hide(tab, first) {
    const wc = tab.wc;
    if (!wc || wc.isDestroyed()) return;
    const page = pages.get(tab.id);
    const url = wc.getURL();
    const site = siteOf(url);
    if (!engine || !page || !site || off.has(site)) return;
    let found = { classes: [], ids: [], hrefs: [] };
    try { found = await wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: SCAN }]); } catch {}
    // The tab may have moved on (or reloaded with Shields off) while the page was looked at.
    if (wc.isDestroyed() || pages.get(tab.id) !== page || off.has(site)) return;
    const asked = page.seen;
    const fresh = (kind) => (found?.[kind] || []).filter((x) => !asked[kind].has(x) && asked[kind].add(x));
    const { hostname, domain } = Request.fromRawDetails({ url });
    const { styles } = engine.getCosmeticsFilters({
      url, hostname, domain,
      classes: fresh('classes'), ids: fresh('ids'), hrefs: fresh('hrefs'),
      getBaseRules: first, getRulesFromHostname: first, getRulesFromDOM: true,
      getInjectionRules: false, getExtendedRules: false, // page scripts from the lists are not run
    });
    if (styles) wc.insertCSS(styles, { cssOrigin: 'user' }).catch(() => {});
  }

  // A new page starts its count, and its hiding rules, from nothing. This is
  // done when the navigation starts: by the time it is reported as done, the
  // new page's first requests may already have been blocked.
  const newPage = (url) => ({ url, blocked: 0, seen: { classes: new Set(), ids: new Set(), hrefs: new Set() } });
  function hook(tab) {
    hooked.add(tab.wc);
    const wc = tab.wc;
    pages.set(tab.id, newPage(wc.getURL()));
    wc.on('did-start-navigation', (e) => {
      if (!e.isMainFrame || e.isSameDocument) return;
      pages.set(tab.id, newPage(e.url));
      later();
    });
    wc.on('did-redirect-navigation', (e) => {
      const page = pages.get(tab.id);
      if (e.isMainFrame && page) page.url = e.url;
    });
    wc.on('dom-ready', () => hide(tab, true));
    wc.on('did-finish-load', () => {
      hide(tab, false);
      setTimeout(() => { if (!wc.isDestroyed()) hide(tab, false); }, 2000); // ads that arrive late
    });
  }

  // Hooked as soon as a tab (or a woken tab's new page) exists, before it loads.
  tabs.on('created', (tab) => { if (tab.wc && !hooked.has(tab.wc)) hook(tab); });
  tabs.on('change', () => {
    for (const tab of tabs.list) if (tab.wc && !hooked.has(tab.wc)) hook(tab);
    for (const id of pages.keys()) if (!tabs.get(id)) pages.delete(id);
  });

  // ── the switch ──
  function set({ site, on } = {}) {
    if (typeof site !== 'string' || !site) return;
    if (on) off.delete(site);
    else off.add(site);
    fs.writeFileSync(sitesFile, JSON.stringify({ off: [...off].sort() }, null, 2));
    // The page on screen reloads, so that what was blocked loads, or the other way round.
    const tab = tabs.active();
    if (tab?.wc && siteOf(tab.wc.getURL()) === site) tab.wc.reload();
    changed();
  }

  // For the toolbar: the page on screen.
  function state() {
    const tab = tabs.active();
    const site = siteOf(tab?.url);
    return {
      shields: site ? { site, on: !off.has(site), blocked: pages.get(tab.id)?.blocked || 0, ready: !!engine } : null,
    };
  }

  function menu() {
    const s = state().shields;
    if (!s) return;
    const n = s.blocked;
    const age = Math.floor((Date.now() - updated) / 86400e3);
    Menu.buildFromTemplate([
      { label: `Shields for ${s.site}`, enabled: false },
      { label: 'Block ads and trackers on this site', type: 'checkbox', checked: s.on, click: () => set({ site: s.site, on: !s.on }) },
      { type: 'separator' },
      { label: s.on ? `${n} ${n === 1 ? 'item' : 'items'} blocked on this page` : 'Nothing is blocked on this site', enabled: false },
      {
        label: !engine ? (updating ? 'Downloading filter lists…' : 'Filter lists not downloaded yet')
          : `Filter lists updated ${age < 1 ? 'today' : age === 1 ? 'yesterday' : `${age} days ago`}`,
        enabled: false,
      },
    ]).popup({ window: tabs.win });
  }

  load();
  // A missing engine is fetched straight away; a stale one once startup is over.
  if (!engine) check();
  setTimeout(check, 60000);
  setInterval(check, RETRY);

  return { state, set, menu, attach };
}

module.exports = { createShields };
