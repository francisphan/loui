// The start page: what a new tab of the user's opens with. Louis, a box that
// does what the address bar does, the sites visited most, the bookmarks bar's
// bookmarks while the bar is hidden, the weather and a few headlines, and a
// line with the date. The page itself loads nothing from the web: the weather
// and the headlines are fetched by Loui (startfeeds.js) and written into it.
//
// It is a page of Loui's own under the `loui-start:` scheme, made as reader
// view's is (reader.js): not registered as privileged or standard, so it has
// an opaque origin and no storage; the tab has no bridge; and every response
// carries a policy that runs no script at all and cannot be framed. What is
// on the page is written into its HTML when it is served: one small static
// document, nothing kept running. Its box and its few controls are a plain
// form and plain links to loui-start://…, caught in will-navigate here, as
// reader view's are.
//
// It lists sites the user visits, so who gets it matters:
// - Only the user's own tabs. Each request is checked as it is made (the
//   request rule below knows which tab is asking): one from a session's tab,
//   or from a frame or a fetch inside any page, is cancelled, and the page is
//   served only against a request just let through that way.
// - No page can send a tab there: a page's own navigation to loui-start: is
//   stopped (will-navigate), a session's `navigate` refuses the scheme
//   (actions.js), and a page's new window never opens one (tabs.js).
// - A tab handed to a session while on it is given a blank page first
//   (tabs.unstart), and one that still commits it in a session's group (a
//   load already on its way) is blanked the same way.
// - A private window's start page has no history and no bookmarks on it at
//   all: its session's handler has none to give. The weather and the news
//   say nothing about the user, and show there too.
//
// Settings › General › Start page: what new tabs open with (this page, the
// default; a blank page; or an address: "newTab", "newTabAddress" in
// settings.json), and a switch for each part ("startTiles", "startWeather",
// "startNews"). Sites taken off the page with its × are in "startHidden".
const fs = require('fs');
const path = require('path');
const { nativeImage, nativeTheme } = require('electron');
const { requestRules } = require('./requests');
const { YOU, START, onStart, toUrl } = require('./tabs');
const { createFeeds } = require('./startfeeds');

const SCHEME = 'loui-start';
const TILES = 8;
const TICKET_MS = 5000; // how long a request let through may take to reach the handler
const WAIT_MS = 1500; // how long a page being served waits for the weather and the news, if they are not at hand
const UI = path.join(__dirname, '../ui');
const FONT = path.join(__dirname, '../../node_modules/@fontsource-variable/source-sans-3/files/source-sans-3-latin-wght-normal.woff2');

const POLICY = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; " +
  `base-uri 'none'; form-action ${SCHEME}:`;
const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let parts = null;
// The page's style, font and pictures, read once.
function assets() {
  if (parts) return parts;
  let font = '';
  try {
    font = `@font-face { font-family: 'Source Sans 3'; font-weight: 200 900; src: url(data:font/woff2;base64,${fs.readFileSync(FONT).toString('base64')}) format('woff2'); }\n`;
  } catch {}
  const louis = nativeImage.createFromPath(path.join(UI, 'icon.png'));
  parts = {
    style: font + fs.readFileSync(path.join(UI, 'startpage.css'), 'utf8'),
    louis: louis.toDataURL(), // whole (256px): drawn at up to 160px
    icon: { type: 'image/png', bytes: louis.resize({ width: 32, height: 32, quality: 'best' }).toPNG() }, // for the tab strip
  };
  return parts;
}

// The letter a site without an icon is marked by, as in the tab strip (ui.js):
// the first of its own name ("G" for accounts.google.com).
const TWO_PART = /\.(com?|org|net|gov|edu|ac)\.[a-z]{2}$/;
function letterOf(host) {
  const name = host.replace(/^www\./, '').replace(/:\d+$/, '');
  if (name === 'localhost' || /^[\d.]+$|^\[/.test(name)) return name[0].toUpperCase();
  const labels = name.split('.');
  return (labels[Math.max(0, labels.length - (TWO_PART.test(name) ? 3 : 2))][0] || '').toUpperCase();
}
const hostOf = (url) => { try { return new URL(url).host; } catch { return ''; } };

function render({ priv, body }) {
  const a = assets();
  return `<!doctype html>
<html lang="en"${priv ? ' class="private"' : ''}>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${POLICY}">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width">
<title>New tab</title>
<style>${a.style}</style>
</head>
<body>
<main>
<header class="brand">
  <img src="${a.louis}" alt="">
  <h1>Loui</h1>
  ${priv ? '<span class="private">Private window</span>' : ''}
</header>
<form action="${SCHEME}://go" method="get" role="search">
  <input name="q" type="text" placeholder="Search or enter an address" aria-label="Search or enter an address" autocomplete="off" autocapitalize="off" spellcheck="false">
</form>
${body}
</body>
</html>`;
}

// How long ago, in words.
function age(at) {
  const min = Math.round((Date.now() - at) / 60000);
  if (!at || min < 0) return '';
  if (min < 60) return min <= 1 ? 'just now' : `${min} minutes ago`;
  const hours = Math.round(min / 60);
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

// history, bookmarks: as main.js has them. sessions(): how many Claude
// sessions are open. showSessions(w): opens the Sessions panel in a window.
// openSettings(): opens the Settings window at General.
function createStartPage({ tabs, ses, settings, save, changed, history, bookmarks, sessions, showSessions, openSettings }) {
  const feeds = createFeeds({ settings, save });
  const on = (key) => settings[key] !== false; // each part of the page shows unless switched off
  // The existing tests open blank tabs throughout: under LOUI_TEST a new tab
  // is blank unless the test's settings.json says otherwise.
  const choice = () => (['start', 'blank', 'address'].includes(settings.newTab) ? settings.newTab
    : process.env.LOUI_TEST ? 'blank' : 'start');
  const validAddress = (text) => typeof text === 'string' && !!text.trim() && !/\s/.test(text.trim()) &&
    /^https?:\/\//i.test(toUrl(text));
  const hidden = () => (Array.isArray(settings.startHidden) ? settings.startHidden.filter((h) => typeof h === 'string') : []);

  // What a new tab of the user's loads ('' is a blank page).
  tabs.newTab = () => {
    const c = choice();
    if (c === 'blank') return '';
    return c === 'address' && validAddress(settings.newTabAddress) ? settings.newTabAddress.trim() : START;
  };

  // The user's own: the sites visited most, and the bookmarks bar's bookmarks.
  function ownParts() {
    let body = '';
    const sites = on('startTiles') ? history.top(TILES, hidden()) : [];
    if (sites.length) {
      body += `<section aria-labelledby="most"><h2 id="most">Most visited</h2><ul class="tiles">${sites.map((s) => {
        const name = escape(s.host.replace(/^www\./, ''));
        return `<li><a class="tile" href="${escape(s.url)}"><span class="letter" aria-hidden="true">${escape(letterOf(s.host))}</span>` +
          `<span class="name">${name}</span></a>` +
          `<a class="hide" href="${SCHEME}://hide?h=${encodeURIComponent(s.host)}" title="Don't show ${name} here" aria-label="Don't show ${name} here">×</a></li>`;
      }).join('')}</ul></section>\n`;
    }
    const marks = bookmarks.barShown() ? [] : bookmarks.bar().filter((b) => /^https?:\/\//i.test(b.url));
    if (marks.length) {
      body += `<section aria-labelledby="marks"><h2 id="marks">Bookmarks</h2><ul class="chips">${marks.map((b) => {
        const title = b.title || hostOf(b.url);
        const icon = /^data:image\/[\w.+-]+;base64,[A-Za-z0-9+/=]+$/.test(b.icon || '')
          ? `<img src="${b.icon}" alt="">` : `<span class="letter" aria-hidden="true">${escape([...title.trim()][0]?.toUpperCase() || '')}</span>`;
        return `<li><a class="chip" href="${escape(b.url)}" title="${escape(b.url)}">${icon}<span>${escape(title)}</span></a></li>`;
      }).join('')}</ul></section>\n`;
    }
    return body;
  }

  // The weather and the news, side by side. w, n: what startfeeds.js had for
  // each (null: nothing to show; { failed }: it could not be had).
  function widgets(w, n) {
    let weather = '';
    if (on('startWeather') && (w || !feeds.place())) { // a place whose weather is still on its way: the next start page has it
      const deg = feeds.units() === 'f' ? '°F' : '°C';
      weather = '<section class="weather" aria-labelledby="weather"><h2 id="weather">Weather</h2><div class="card">' +
        (!w ? `<a class="quiet" href="${SCHEME}://settings">Set your place in Settings</a>`
          : w.failed ? `<p class="place">${escape(feeds.place())}</p><p class="quiet">Couldn't load the weather.</p>`
            : `<p class="place">${escape(w.place)}</p><p class="now">${w.now}<span>${deg}</span></p>` +
              (w.sky ? `<p class="sky">${escape(w.sky)}</p>` : '') + `<p class="range">High ${w.high}° · Low ${w.low}°</p>`) +
        '</div></section>';
    }
    let news = '';
    if (on('startNews') && n) {
      news = '<section class="news" aria-labelledby="news"><h2 id="news">News</h2>' +
        (n.failed || !n.items.length ? `<div class="card"><p class="quiet">${n.failed ? "Couldn't load the news." : 'No headlines just now.'}</p></div>`
          : `<ul class="card">${n.items.map((i) => `<li><a href="${escape(i.url)}"><span class="headline">${escape(i.title)}</span>` +
            `<span class="meta">${escape([i.source, age(i.at)].filter(Boolean).join(' · '))}</span></a></li>`).join('')}</ul>`) +
        '</section>';
    }
    return weather || news ? `<div class="widgets${weather && news ? '' : ' one'}">${weather}${news}</div>\n` : '';
  }

  function page(priv, w, n) {
    if (priv) {
      return render({
        priv: true,
        body: '<p class="about">Loui keeps no history of the pages you open in a private window, and forgets their cookies ' +
          'and site data when you close the last one. Files you download and bookmarks you add are kept. ' +
          `The Claude panel does not work here.</p>\n${widgets(w, n)}</main>`,
      });
    }
    const date = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
    const open = sessions();
    return render({
      priv: false,
      body: `${ownParts()}${widgets(w, n)}</main>\n<footer>${escape(date)}` +
        (open ? ` · <a href="${SCHEME}://sessions">Claude sessions: ${open} open</a>` : '') + '</footer>',
    });
  }

  // What is at hand is used at once; what has to be fetched is waited for a
  // moment, then left for the next start page (the fetch carries on).
  const soon = (promise) => Promise.race([promise, new Promise((r) => setTimeout(() => r(null), WAIT_MS))]);

  let served = 0; // for the tests: how often the page with the user's sites on it was sent
  // Each session a tab can have: the user's, and a private window's (main.js).
  function attach(s, { private: priv = false } = {}) {
    const tickets = []; // when each request for the page was let through, oldest first
    requestRules(s).add((d) => {
      if (!onStart(d.url)) return null;
      const tab = tabs.list.find((t) => t.wc?.id === d.webContentsId);
      if (tab?.group !== YOU || d.resourceType !== 'mainFrame') return { cancel: true };
      tickets.push(Date.now());
      return null;
    });
    s.protocol.handle(SCHEME, async (request) => {
      while (tickets.length && Date.now() - tickets[0] > TICKET_MS) tickets.shift();
      const headers = {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': `${POLICY}; frame-ancestors 'none'`,
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
      };
      if (tickets.shift() === undefined || !request.url.startsWith(START)) return new Response('', { status: 403, headers });
      // Asked for only now that a start page is being shown, and only the parts switched on.
      const [w, n] = await Promise.all([
        on('startWeather') ? soon(feeds.weather()) : null,
        on('startNews') ? soon(feeds.news()) : null,
      ]);
      if (!priv) served++;
      return new Response(page(priv, w, n), { headers });
    });
  }
  attach(ses);

  // The page's own box and controls.
  function command(tab, to) {
    let u;
    try { u = new URL(to); } catch { return; }
    if (u.host === 'go') {
      const text = (u.searchParams.get('q') || '').trim();
      // Typed in the page's box. Unlike the address bar, this box is in the
      // page, where the Claude panel's tools can type too: so it opens web
      // addresses and searches only, never a file: or view-source: address
      // (the panel has no way to read local files, and must not get one here).
      const url = text && toUrl(text);
      if (url && /^https?:\/\//i.test(url)) tabs.byUser(tab).wc.loadURL(url).catch(() => {});
    } else if (u.host === 'hide' && !tab.private) {
      const host = u.searchParams.get('h') || '';
      if (!host || hidden().includes(host)) return;
      settings.startHidden = [...hidden(), host];
      save();
      changed();
      tab.wc.reload();
    } else if (u.host === 'sessions' && !tab.private) {
      showSessions(tab.window);
    } else if (u.host === 'settings') {
      openSettings();
    }
  }

  const backdrop = (tab, dark) => (tab.private ? (dark ? '#17152A' : '#DDDBEB') : (dark ? '#101B22' : '#E6EDEF'));
  tabs.on('created', (tab) => { // also when a sleeping tab wakes with a new page
    const wc = tab.wc;
    // A page heading for loui-start: is stopped, whoever's tab it is in. The
    // start page's own form and links are its controls.
    const stop = (e, legacyUrl) => {
      const to = e.url || legacyUrl || '';
      if (!onStart(to)) return;
      e.preventDefault();
      if (e.isMainFrame !== false && tab.group === YOU && tab.wc === wc && onStart(wc.getURL())) command(tab, to);
    };
    wc.on('will-navigate', stop);
    wc.on('will-redirect', (e, legacyUrl) => { if (onStart(e.url || legacyUrl || '')) e.preventDefault(); });
    wc.on('did-start-navigation', (e) => {
      if (!e.isMainFrame || e.isSameDocument || tab.view?.webContents !== wc) return;
      // Loui's own colour behind the start page from before its first paint; white behind a web page (tabs.build).
      tab.view.setBackgroundColor(onStart(e.url) ? backdrop(tab, nativeTheme.shouldUseDarkColors) : '#ffffff');
    });
    // Committed in a tab that is no longer the user's (handed over as it loaded): blanked.
    wc.on('did-navigate', (_e, to) => { if (onStart(to) && tab.group !== YOU && tab.wc === wc) tabs.unstart(tab); });
  });

  // The tab strip shows Louis for a tab on the start page, asleep or not.
  tabs.on('change', () => {
    for (const tab of tabs.list) {
      if (!onStart(tab.url) || tab.favicon || tab.group !== YOU) continue;
      tab.icon = assets().icon;
      tab.favicon = `loui-icon://tab/${tab.id}/${++tabs.iconSeq}`;
    }
  });

  // For the Settings window.
  const prefs = () => ({
    choice: choice(), address: typeof settings.newTabAddress === 'string' ? settings.newTabAddress : '',
    tiles: on('startTiles'), hidden: hidden().length,
    weather: on('startWeather'), place: typeof settings.weatherPlace === 'string' ? settings.weatherPlace : '', found: feeds.place(), units: feeds.units(),
    news: on('startNews'), feeds: feeds.feeds(),
  });
  // What the Settings window can ask for, by name.
  const acts = {
    'new-tab': ({ choice: c, address } = {}) => {
      if (['start', 'blank', 'address'].includes(c)) settings.newTab = c;
      if (typeof address === 'string') {
        if (!validAddress(address)) return;
        settings.newTabAddress = address.trim();
      }
      save();
    },
    'start:part': ({ part, on: show } = {}) => {
      if (!['startTiles', 'startWeather', 'startNews'].includes(part)) return;
      settings[part] = !!show;
      save();
    },
    'start:unhide': () => { delete settings.startHidden; save(); },
    'start:place': (name) => feeds.setPlace(name),
    'start:units': (u) => feeds.setUnits(u),
    'start:feed-add': (url) => feeds.addFeed(url),
    'start:feed-remove': (url) => feeds.removeFeed(String(url)),
  };

  return {
    attach, prefs, acts,
    probes: { 'start:served': () => served },
  };
}

module.exports = { createStartPage, SCHEME };
