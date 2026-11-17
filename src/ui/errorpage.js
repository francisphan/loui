// Loui's error page: what went wrong, Try again, and (when the network is
// down or the address doesn't exist) Louis's walk, plus noticing when the
// connection is back. Put together with louis.js by src/main/errorpage.js,
// which hands it PAGE = { url, code, reason, best, shown, game }.
//
// Everything that came from the failed address is shown as text, never as
// markup. Try again reloads this history entry, which is the address that
// failed, so it can't be pointed anywhere else.
const OFFLINE_CODES = [-106, -137, -21, -109, -331];
const el = (id) => document.getElementById(id);

let host = '';
try { host = new URL(PAGE.url).hostname; } catch {}

// [tab title, heading, explanation]. The explanation's parts alternate plain
// text and the site's name, which is shown in bold.
function describe(code) {
  const site = host || 'this site';
  if (OFFLINE_CODES.includes(code)) {
    return ['No connection', "You're offline", ["Loui can't reach the internet, so this page didn't open. Check your Wi-Fi or network cable."]];
  }
  if (code === -105) {
    return ['Site not found', "Can't find this site", ["Loui couldn't find ", site, '. Check the address for typos, or check your connection.']];
  }
  if (code <= -200 && code > -300) {
    return ['Not secure', "Can't open this page safely", ['', site, "'s security certificate isn't valid, so Loui stopped before opening it. Someone could be pretending to be the site."]];
  }
  const why = {
    [-102]: ' refused to connect. The site may be down, or not running at this address.',
    [-7]: ' took too long to answer.',
    [-118]: ' took too long to answer.',
    [-100]: ' closed the connection unexpectedly.',
    [-101]: ' reset the connection.',
  }[code];
  return ["Can't open this page", "Can't open this page", why ? ['', site, why] : ['Something went wrong while opening this page.']];
}

const [title, heading, why] = describe(PAGE.code);
document.title = title;
el('what').textContent = heading;
why.forEach((part, i) => {
  if (!part) return;
  el('why').append(i % 2 ? Object.assign(document.createElement('b'), { textContent: part }) : part);
});
el('address').textContent = PAGE.url;
el('detail').textContent = PAGE.reason ? `${PAGE.reason} (${PAGE.code})` : `Error ${PAGE.code}`;
el('retry').addEventListener('click', () => location.reload());
el('reload').addEventListener('click', () => location.reload());

// ── the game, and the main process waiting for new best scores ──────────
let shown = PAGE.shown;
const visible = () => shown && document.visibilityState === 'visible';
let waiting = null, unsent = null; // nextBest's caller, and a best score nobody has asked for yet
function reportBest(n) {
  if (waiting) { waiting(n); waiting = null; } else unsent = n;
}
addEventListener('pagehide', () => reportBest(null));

const game = PAGE.game ? createLouis(el('game'), { best: PAGE.best, onBest: reportBest }) : null;

// ── when the connection is back ─────────────────────────────────────────
// A cheap check of the site's front door, more and more rarely, and at once
// when the system says it is online again. Only while the page is on screen.
let back = false, wait = 5000, timer = 0;
async function check() {
  timer = 0;
  if (back || !visible()) return;
  if (navigator.onLine) {
    try {
      await fetch(new URL(PAGE.url).origin + '/', { method: 'HEAD', mode: 'no-cors', cache: 'no-store' });
      return reconnected();
    } catch {}
  }
  wait = Math.min(wait * 2, 30000);
  later();
}
function later() {
  if (game && !timer && !back && visible()) timer = setTimeout(check, wait);
}
function reconnected() {
  back = true;
  // Someone who has started playing keeps their game until they choose.
  if (!game.played()) location.reload();
  else el('back').hidden = false;
}
addEventListener('online', () => {
  if (!game) return;
  clearTimeout(timer);
  timer = 0;
  wait = 5000;
  check();
});

function update() {
  game?.setRunning(visible());
  if (visible()) later();
  else { clearTimeout(timer); timer = 0; }
}
document.addEventListener('visibilitychange', update);
update();

// Called by the main process only (src/main/errorpage.js).
window.__louiErrorPage = {
  setShown(on) { shown = !!on; update(); },
  nextBest() {
    if (unsent != null) { const n = unsent; unsent = null; return n; }
    return new Promise((resolve) => { waiting = resolve; });
  },
};
