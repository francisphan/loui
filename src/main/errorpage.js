// The page a tab shows when its page can't be opened: a plain explanation and
// Try again, and, when the network is down or the address doesn't exist, a
// game with Louis to pass the time (src/ui/errorpage.*, src/ui/louis.js).
//
// It is drawn into Chromium's own error document rather than loaded as a page
// of its own. That document stands in the history in place of the address
// that failed, so the address bar, Back, Reload, history.js (which records
// only committed pages) and restored tabs all see the address that failed,
// and reloading it simply tries that address again. The document is a web
// page with an opaque origin: no preload, no bridge, no storage, no cookies.
//
// The best score lives in the main process (game.json in the profile): the
// page has no storage of its own, so it is handed the best score when it is
// drawn, and the main process waits on the page (an executeJavaScript promise
// that resolves when a round ends with a new best). The page never calls in.
// "Open anyway" on a certificate error is heard the same way (see certs.js).
//
// A page whose process crashed has nothing left to draw in, so the tab is
// reloaded with that one request refused: Chromium then puts its error
// document in the page's place in the history, and the crash is explained
// there. Reload on it opens the address again.
const fs = require('fs');
const path = require('path');
const { requestRules } = require('./requests');

const UI = path.join(__dirname, '../ui');
const FONT = path.join(__dirname, '../../node_modules/@fontsource-variable/source-sans-3/files/source-sans-3-latin-wght-normal.woff2');

// Net error codes (net/base/net_error_list.h) that mean the network is down
// or the address doesn't exist. Only these get the game.
const GAME_CODES = new Set([
  -106, // INTERNET_DISCONNECTED
  -105, // NAME_NOT_RESOLVED
  -137, // NAME_RESOLUTION_FAILED
  -21, // NETWORK_CHANGED
  -109, // ADDRESS_UNREACHABLE
  -331, // NETWORK_IO_SUSPENDED (the machine slept)
]);

let script = null;
// The page's parts, read once and put together into one script.
function source() {
  if (script) return script;
  const read = (name) => fs.readFileSync(path.join(UI, name), 'utf8');
  let font = '';
  try {
    font = `@font-face { font-family: 'Source Sans 3'; font-weight: 200 900; src: url(data:font/woff2;base64,${fs.readFileSync(FONT).toString('base64')}) format('woff2'); }\n`;
  } catch {}
  const html = `<head><meta name="color-scheme" content="dark light"><meta name="viewport" content="width=device-width">` +
    `<style>${font}${read('errorpage.css')}</style></head><body>${read('errorpage.html')}</body>`;
  // Chromium's error document has this address whatever failed; checking it
  // means a page that did load is never drawn over.
  script = `(() => {
    if (location.href !== 'chrome-error://chromewebdata/' || window.__louiErrorPage) return false;
    const PAGE = __PAGE__;
    document.documentElement.lang = 'en';
    document.documentElement.innerHTML = ${JSON.stringify(html)};
    ${read('louis.js')}
    ${read('errorpage.js')}
    return true;
  })()`;
  return script;
}

// certs: accepts a certificate when the user says so (certs.js).
function createErrorPage({ tabs, file, certs }) {
  let best = 0;
  try { best = Math.max(0, Math.floor(JSON.parse(fs.readFileSync(file, 'utf8')).best) || 0); } catch {}

  function saveBest(n) {
    if (!Number.isInteger(n) || n <= best || n > 1e6) return;
    best = n;
    try {
      fs.writeFileSync(file + '.tmp', JSON.stringify({ best }), { mode: 0o600 });
      fs.renameSync(file + '.tmp', file);
    } catch {}
  }

  const showing = new Map(); // tab -> whether it was last told it is on screen
  const onScreen = (tab) => {
    const win = tab.window?.win;
    return tabs.onScreen(tab) && !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized();
  };

  // The page runs its game only while on screen. Tabs are stacked rather than
  // hidden (see tabs.js), so a covered tab still reads as visible to the page
  // itself, and is told instead.
  function tell() {
    for (const [tab, was] of showing) {
      if (!tab.wc || tab.wc.isDestroyed()) { showing.delete(tab); continue; } // closed, or asleep (no page)
      const now = onScreen(tab);
      if (now === was) continue;
      showing.set(tab, now);
      tab.wc.executeJavaScript(`window.__louiErrorPage?.setShown(${now})`).catch(() => {});
    }
  }
  tabs.on('change', tell); // also when a window is minimized, restored, hidden or shown (see tabs.addWindow)

  // Waits for new best scores until the page goes away (it then answers null).
  function listen(tab) {
    tab.wc.executeJavaScript('window.__louiErrorPage?.nextBest()').then((n) => {
      if (n == null) return;
      saveBest(n);
      listen(tab);
    }, () => {});
  }

  // Waits for "Open anyway" (the page then answers true; null when it goes away).
  function listenProceed(tab) {
    const wc = tab.wc;
    wc.executeJavaScript('window.__louiErrorPage?.proceed()').then((yes) => {
      if (yes && tab.wc === wc && !certs.proceed(tab)) listenProceed(tab); // refused (Claude was at work): asked again later
    }, () => {});
  }

  // ── a page that crashed ─────────────────────────────────────────────────
  const crashed = new Map(); // page (WebContents id) -> why, until its reload has been refused
  // Each session: the user's, and each private one (main.js attaches those).
  const attach = (ses) => requestRules(ses).add((d) =>
    (d.resourceType === 'mainFrame' && crashed.has(d.webContentsId) ? { cancel: true } : null));
  tabs.on('crashed', (tab, details) => {
    const wc = tab.wc;
    if (!wc || wc.isDestroyed() || !/^https?:/i.test(tab.url)) return;
    crashed.set(wc.id, details.reason);
    wc.once('destroyed', () => crashed.delete(wc.id));
    // After the event: the page gets a new process, and its load is refused (above).
    setImmediate(() => { if (!wc.isDestroyed()) wc.reload(); });
  });

  let pretended = null; // for the tests: the next failure as if the network were down
  const watched = new WeakSet();
  tabs.on('failed', (tab, { code, reason, url }) => {
    if (pretended) { ({ code, reason } = pretended); pretended = null; }
    // A session's tab kept from a site whose certificate the user accepted for themselves (certs.js).
    if (certs?.refuses(tab, url)) { code = -202; reason = 'ERR_CERT_AUTHORITY_INVALID'; }
    const crash = crashed.get(tab.wc.id) || null;
    crashed.delete(tab.wc.id);
    // A page that loads replaces the error page (error pages don't fire did-navigate).
    // Watched per page: a tab that slept and woke has a new one.
    if (!watched.has(tab.wc)) {
      watched.add(tab.wc);
      tab.wc.on('did-navigate', () => showing.delete(tab));
      tab.wc.on('destroyed', () => showing.delete(tab));
    }
    const shown = onScreen(tab);
    const page = {
      url, code, reason, best, shown,
      game: !crash && GAME_CODES.has(code) && /^https?:/i.test(url),
      crash, // why the page's process went, if that is what happened
      // A certificate Chromium could not verify, in the user's own tab: "Open anyway" is offered.
      cert: !crash && !!certs?.offer(tab, url),
    };
    tab.wc.executeJavaScript(source().replace('__PAGE__', () => JSON.stringify(page))).then((drawn) => {
      if (!drawn) return;
      showing.set(tab, shown);
      if (page.game) listen(tab);
      if (page.cert) listenProceed(tab);
    }, () => {});
  });

  return { best: () => best, pretend: (code, reason) => { pretended = { code, reason }; }, attach };
}

module.exports = { createErrorPage, GAME_CODES };
