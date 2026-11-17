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
const fs = require('fs');
const path = require('path');

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

function createErrorPage({ tabs, file }) {
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

  let pretended = null; // for the tests: the next failure as if the network were down
  const watched = new WeakSet();
  tabs.on('failed', (tab, { code, reason, url }) => {
    if (pretended) { ({ code, reason } = pretended); pretended = null; }
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
      game: GAME_CODES.has(code) && /^https?:/i.test(url),
    };
    tab.wc.executeJavaScript(source().replace('__PAGE__', () => JSON.stringify(page))).then((drawn) => {
      if (!drawn) return;
      showing.set(tab, shown);
      if (page.game) listen(tab);
    }, () => {});
  });

  return { best: () => best, pretend: (code, reason) => { pretended = { code, reason }; } };
}

module.exports = { createErrorPage, GAME_CODES };
