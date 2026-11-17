// Reader view: an article shown on its own, in Loui's type and colours, and
// the same article as text for Claude (the read_article tool).
//
// Finding the article: Mozilla's Readability (the library Firefox's reader
// view uses), run with src/page/reader.js in an isolated world of its own, on
// a clone of the page's document. The page's JavaScript never sees it. A
// cheap check (isProbablyReaderable) runs when a page in the user's own tabs
// finishes loading, and offers the book button in the address bar.
//
// Showing it: the article, already cleaned to an allow-list of tags (see
// src/page/reader.js), is served from Loui's own `loui-reader:` scheme and
// opened in the same tab, as a new history entry. Back returns to the page,
// Forward to the article, as anyone would expect of a page. The scheme is
// not registered as privileged or standard, so its pages have an opaque
// origin: no storage, no cookies, nothing shared with the article's site.
// The tab has no preload, so there is no bridge either. Every response
// carries a policy that runs no scripts at all, loads images over http(s)
// only, and cannot be framed.
//
// A data: URL (as brave.js uses for its short note) was the other choice: it
// puts the whole article, fonts included, into the tab's history, which
// restore.js then writes to tabs.json. With a scheme of Loui's own, the
// history holds a short address; the article stays in memory, and an address
// whose article is gone (after a restart) shows a link to the page instead.
//
// The address bar keeps showing the article's own address: tab.url is set
// back to it whenever the reader page commits, as brave.js does for its note.
//
// The reader page's own controls (text size, width, typeface) are plain links
// to loui-reader:set?…, caught in will-navigate and kept in settings.json;
// the open reader pages restyle at once (insertCSS), without reloading. The
// article itself can never hold such a link: it keeps http(s) links only.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { YOU } = require('./tabs');

const SCHEME = 'loui-reader';
const WORLD = 4840; // lib.js 4812, shields 4813, passwords 4831
const KEEP = 30; // articles kept in memory for Back and Forward
const TEXT_LIMIT = 40000; // characters of article text given to Claude

const MODULES = path.join(__dirname, '../../node_modules');
const read = (p) => fs.readFileSync(p, 'utf8');
let script = null;
// Readability and its check, then Loui's part, in one function scope so the
// page-side file can use them. Their licence headers stay with them.
function source() {
  if (script) return script;
  const lib = path.join(MODULES, '@mozilla/readability');
  script = `(function () {\n${read(path.join(lib, 'Readability.js'))}\n` +
    `${read(path.join(lib, 'Readability-readerable.js'))}\n` +
    `${read(path.join(__dirname, '../page/reader.js'))}\n})();`;
  return script;
}

// Calls a function of src/page/reader.js in a tab's page. A hung page
// would otherwise hold the caller for good.
function call(wc, fn, arg = {}) {
  const run = wc.executeJavaScriptInIsolatedWorld(WORLD, [
    { code: `${source()}\n;__louiReader.${fn}(${JSON.stringify(arg)})` },
  ]);
  let timer;
  const late = new Promise((_, no) => {
    timer = setTimeout(() => no(new Error('The page did not respond within 15 seconds.')), 15000);
  });
  return Promise.race([run, late]).finally(() => clearTimeout(timer));
}

// For read_article: the article in a tab, as text for Claude.
async function articleText(tab) {
  const a = await call(tab.wc, 'extract', { html: false, text: true }).catch(() => null);
  // Readability finds something on almost any page; a short find on a page
  // that does not read as an article is not one.
  if (!a?.text || (!a.readable && a.length < 500)) {
    throw new Error("This page has no article that reader view can find. snapshot reads the whole page.");
  }
  let body = a.text;
  if (body.length > TEXT_LIMIT) {
    const cut = body.lastIndexOf('\n', TEXT_LIMIT);
    body = body.slice(0, cut > TEXT_LIMIT / 2 ? cut : TEXT_LIMIT);
    body += `\n\n… cut off here, after ${body.length} of ${a.length} characters. snapshot and scroll read the rest of the page.`;
  }
  return (
    `Title: ${a.title || '(none)'}\n` +
    (a.byline ? `By: ${a.byline}\n` : '') +
    (a.siteName ? `Site: ${a.siteName}\n` : '') +
    `URL: ${tab.url}\n\n${body}`
  );
}

// ── the reader page ──────────────────────────────────────────────────────
const SIZES = [16, 18, 20, 22, 25, 28]; // px
const WIDTHS = { narrow: '56ch', medium: '66ch', wide: '80ch' };
const FACES = {
  sans: "'Source Sans 3', 'Segoe UI', system-ui, sans-serif",
  serif: "'Iowan Old Style', 'Charter', 'Sitka Text', Cambria, Georgia, 'Noto Serif', serif",
};
const DEFAULTS = { size: 2, width: 'medium', face: 'sans' };

const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const POLICY = "default-src 'none'; img-src http: https:; style-src 'unsafe-inline'; font-src data:; " +
  "base-uri 'none'; form-action 'none'";

let fonts = null;
function fontFaces() {
  if (fonts != null) return fonts;
  const face = (style) => {
    const file = path.join(MODULES, `@fontsource-variable/source-sans-3/files/source-sans-3-latin-wght-${style}.woff2`);
    return `@font-face { font-family: 'Source Sans 3'; font-style: ${style}; font-weight: 200 900; ` +
      `src: url(data:font/woff2;base64,${fs.readFileSync(file).toString('base64')}) format('woff2'); }\n`;
  };
  try { fonts = face('normal') + face('italic'); } catch { fonts = ''; }
  return fonts;
}

// What the reader settings change. The same rules are drawn into each page and,
// when a setting changes, inserted into the open ones with more specific
// selectors (boost), so they win over what the page was drawn with.
function prefsCss(p, boost = false) {
  const more = boost ? 'html:root ' : '';
  const on = (key, value) => `${more}a.opt[data-set="${key}=${value}"]`;
  const options = [
    ...Object.keys(WIDTHS).map((w) => [on('width', w), p.width === w]),
    ...Object.keys(FACES).map((f) => [on('face', f), p.face === f]),
  ];
  return `${boost ? 'html:root' : ':root'} { --size: ${SIZES[p.size]}px; --measure: ${WIDTHS[p.width]}; --face: ${FACES[p.face]}; }\n` +
    options.map(([sel, chosen]) => `${sel} { ${chosen ? 'background: var(--chip); color: var(--ink);' : 'background: none; color: var(--ink-2);'} }`).join('\n') +
    `\n${more}a.opt[data-set="size=down"] { opacity: ${p.size === 0 ? 0.4 : 1}; }` +
    `\n${more}a.opt[data-set="size=up"] { opacity: ${p.size === SIZES.length - 1 ? 0.4 : 1}; }`;
}

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #FBFCFC; --ink: #14242C; --ink-2: #55676F; --rule: #C6D2D7; --chip: #D3E5EA; --link: #2B7A93;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #101B22; --ink: #E3EBEE; --ink-2: #93A6AF; --rule: #2B3E4A; --chip: #23404D; --link: #7CC4DA; }
}
html { background: var(--bg); color: var(--ink); -webkit-text-size-adjust: 100%; }
body { margin: 0; padding: 0 24px 96px; font: 400 var(--size)/1.6 var(--face); }
main, .bar { max-width: var(--measure); margin: 0 auto; }
.bar {
  display: flex; flex-wrap: wrap; align-items: center; gap: 4px 14px; padding: 14px 0 10px;
  border-bottom: 1px solid var(--rule);
}
/* The bar keeps the article's font size, so its ch measure matches the column below. */
.bar > * { font: 500 13.5px/1.2 'Source Sans 3', system-ui, sans-serif; }
.bar .group { display: flex; gap: 2px; }
.bar .end { margin-left: auto; }
a.opt, .bar a {
  display: inline-block; padding: 5px 9px; border-radius: 6px; color: var(--ink-2); text-decoration: none;
}
a.opt:hover, .bar a:hover { background: var(--chip); color: var(--ink); }
a:focus-visible { outline: 2px solid var(--link); outline-offset: 2px; }
header.article { margin: 40px 0 28px; }
.site { margin: 0 0 10px; color: var(--ink-2); font: 600 13.5px/1.3 'Source Sans 3', system-ui, sans-serif; letter-spacing: .02em; text-transform: uppercase; }
h1.title { margin: 0; font-size: 1.85em; line-height: 1.18; font-weight: 700; text-wrap: balance; }
.byline { margin: 12px 0 0; color: var(--ink-2); font-size: .85em; }
main h1, main h2, main h3, main h4, main h5, main h6 { line-height: 1.25; margin: 1.6em 0 .5em; text-wrap: balance; }
main h1 { font-size: 1.5em; } main h2 { font-size: 1.32em; } main h3 { font-size: 1.15em; }
main h4, main h5, main h6 { font-size: 1em; }
main p, main ul, main ol, main dl, main blockquote, main pre, main figure, main table { margin: 0 0 1.1em; }
main a { color: var(--link); text-underline-offset: .15em; }
main img { display: block; max-width: 100%; height: auto; margin: 1.2em auto; border-radius: 4px; }
main figure { margin-inline: 0; }
main figcaption { color: var(--ink-2); font-size: .82em; text-align: center; }
main blockquote { margin-inline: 0; padding-left: 1em; border-left: 3px solid var(--rule); color: var(--ink-2); }
main pre { overflow-x: auto; padding: .8em 1em; border-radius: 6px; background: var(--chip); font-size: .82em; line-height: 1.45; }
main code { font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace; font-size: .9em; }
main table { display: block; overflow-x: auto; border-collapse: collapse; font-size: .9em; }
main th, main td { padding: .35em .6em; border: 1px solid var(--rule); text-align: start; }
main hr { border: 0; border-top: 1px solid var(--rule); margin: 2em 0; }
::selection { background: var(--chip); }
@media (prefers-reduced-motion: no-preference) {
  a.opt, .bar a { transition: background-color .12s ease, color .12s ease; }
}
`;

function page({ title, byline, siteName, lang, dir, html, url }, prefs) {
  const words = html.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
  const minutes = Math.max(1, Math.round(words / 230));
  let site = siteName;
  if (!site) { try { site = new URL(url).hostname.replace(/^www\./, ''); } catch { site = ''; } }
  const opt = (key, value, label, hint) =>
    `<a class="opt" href="${SCHEME}:set?${key}=${value}" data-set="${key}=${value}" title="${hint}">${label}</a>`;
  return `<!doctype html>
<html lang="${escape(lang || 'en')}" dir="${dir === 'rtl' ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${POLICY}">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width">
<title>${escape(title || site || 'Reader view')}</title>
<style>${fontFaces()}${STYLE}${prefsCss(prefs)}</style>
</head>
<body>
<nav class="bar" aria-label="Reader view">
  <span class="group">${opt('size', 'down', 'Smaller', 'Smaller text')}${opt('size', 'up', 'Larger', 'Larger text')}</span>
  <span class="group">${opt('width', 'narrow', 'Narrow', 'Narrow column')}${opt('width', 'medium', 'Medium', 'Medium column')}${opt('width', 'wide', 'Wide', 'Wide column')}</span>
  <span class="group">${opt('face', 'sans', 'Sans', 'Sans-serif type')}${opt('face', 'serif', 'Serif', 'Serif type')}</span>
  <a class="end" href="${SCHEME}:leave" title="Leave reader view">Original page</a>
</nav>
<main>
<header class="article">
  ${site ? `<p class="site">${escape(site)} · ${minutes} min read</p>` : ''}
  <h1 class="title">${escape(title || 'Untitled')}</h1>
  ${byline ? `<p class="byline">${escape(byline)}</p>` : ''}
</header>
${html}
</main>
</body>
</html>`;
}

// For an address whose article is no longer kept (after a restart).
function gone(url) {
  const link = url ? `<p><a href="${escape(url)}">Open ${escape(url)}</a></p>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${POLICY}"><title>Reader view</title>
<style>${fontFaces()}${STYLE}${prefsCss(DEFAULTS)}</style></head>
<body><main><header class="article"><h1 class="title">This reader view has closed</h1></header>
<p>Reader view keeps an article only while Loui is open.</p>${link}</main></body></html>`;
}

// tabs, ses: as main.js has them. settings/save: settings.json (settings.reader).
function createReader({ tabs, ses, settings, save, changed }) {
  const prefs = () => {
    const p = { ...DEFAULTS, ...(settings.reader || {}) };
    if (!Number.isInteger(p.size) || !SIZES[p.size]) p.size = DEFAULTS.size;
    if (!WIDTHS[p.width]) p.width = DEFAULTS.width;
    if (!FACES[p.face]) p.face = DEFAULTS.face;
    return p;
  };

  const articles = new Map(); // id -> article (and its url); oldest first
  const offered = new WeakMap(); // wc -> the address its page was found readable at
  const reading = new WeakMap(); // wc -> the article's own address, while it shows reader view
  const styled = new WeakMap(); // wc -> key of the CSS inserted for a settings change

  const idOf = (url) => {
    try { return new URL(url).pathname; } catch { return ''; }
  };
  const originalOf = (url) => {
    try { return new URL(url).searchParams.get('u') || ''; } catch { return ''; }
  };

  // Served in each session a tab can have: the user's, and a private window's (attach).
  const attach = (s) => s.protocol.handle(SCHEME, (request) => {
    const id = idOf(request.url);
    const a = articles.get(id);
    const html = a ? page(a, prefs()) : gone(originalOf(request.url));
    return new Response(html, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': `${POLICY}; frame-ancestors 'none'`,
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
      },
    });
  });
  attach(ses);

  const web = (url) => /^https?:\/\//i.test(url || '');
  const yours = (tab) => !!tab && tab.group === YOU && !!tab.wc && !tab.wc.isDestroyed();

  // The cheap check, after a page in the user's own tabs has loaded.
  async function check(tab) {
    const wc = tab.wc;
    if (!yours(tab) || reading.has(wc)) return;
    const url = wc.getURL();
    if (!web(url)) return;
    const ok = await call(wc, 'readable').catch(() => false);
    if (wc.isDestroyed() || wc.getURL() !== url) return;
    if (ok === true) offered.set(wc, url); else offered.delete(wc);
    changed();
  }

  async function open(tab) {
    if (!yours(tab) || reading.has(tab.wc)) return false;
    const wc = tab.wc;
    const url = wc.getURL();
    if (!web(url)) return false;
    const a = await call(wc, 'extract', { html: true }).catch(() => null);
    if (!a?.html || wc.isDestroyed() || wc.getURL() !== url) return false;
    const id = crypto.randomUUID();
    articles.set(id, { ...a, url });
    while (articles.size > KEEP) articles.delete(articles.keys().next().value);
    await wc.loadURL(`${SCHEME}:${id}?u=${encodeURIComponent(url)}`).catch(() => {});
    return true;
  }

  // Back to the page: the entry before reader view if that is the page, as
  // Back would; otherwise (a restored tab, say) the page is opened again.
  function leave(tab) {
    const wc = tab?.wc;
    const url = wc && reading.get(wc);
    if (!url) return false;
    const h = wc.navigationHistory;
    const i = h.getActiveIndex();
    if (i > 0 && h.getEntryAtIndex(i - 1)?.url === url) h.goBack();
    else wc.loadURL(url).catch(() => {});
    return true;
  }

  const toggle = (tab = tabs.active()) => (reading.has(tab?.wc) ? leave(tab) : open(tab));

  function setPref(query) {
    const p = prefs();
    const [key, value] = query.split('=');
    if (key === 'size') p.size = Math.max(0, Math.min(SIZES.length - 1, p.size + (value === 'up' ? 1 : -1)));
    else if (key === 'width' && WIDTHS[value]) p.width = value;
    else if (key === 'face' && FACES[value]) p.face = value;
    else return;
    settings.reader = p;
    save();
    restyle();
  }

  // Open reader pages take the new settings at once.
  function restyle() {
    const css = prefsCss(prefs(), true);
    for (const tab of tabs.list) {
      const wc = tab.wc;
      if (!wc || wc.isDestroyed() || !reading.has(wc)) continue;
      const old = styled.get(wc);
      if (old) wc.removeInsertedCSS(old).catch(() => {});
      wc.insertCSS(css).then((key) => styled.set(wc, key), () => {});
    }
  }

  const hooked = new WeakSet();
  function hook(tab) {
    const wc = tab.wc;
    if (!wc || hooked.has(wc)) return;
    hooked.add(wc);
    // After tabs.js's own listener (added when the page was made), so the
    // address it recorded is put back to the article's.
    wc.on('did-navigate', (_e, to) => {
      offered.delete(wc);
      styled.delete(wc);
      if (to.startsWith(SCHEME + ':')) {
        const url = articles.get(idOf(to))?.url || originalOf(to);
        reading.set(wc, url);
        if (url) tab.url = url;
      } else {
        reading.delete(wc);
      }
      changed();
    });
    wc.on('did-navigate-in-page', (_e, _to, isMainFrame) => {
      if (isMainFrame && offered.delete(wc)) changed();
    });
    wc.on('did-stop-loading', () => check(tab));
    // The reader page's own links to loui-reader: are its controls. Any other
    // page heading there (a site linking to one) is stopped.
    wc.on('will-navigate', (e, legacyUrl) => {
      const to = e.url || legacyUrl || '';
      if (!to.startsWith(SCHEME + ':')) return;
      e.preventDefault();
      if (!reading.has(wc) || !wc.getURL().startsWith(SCHEME + ':')) return;
      const rest = to.slice(SCHEME.length + 1);
      if (rest === 'leave') setImmediate(() => leave(tab));
      else if (rest.startsWith('set?')) setPref(rest.slice(4));
    });
  }
  tabs.on('created', hook); // also when a sleeping tab wakes with a new page

  // For the window: what the address bar's book button shows for the tab on screen.
  function state() {
    const tab = tabs.active();
    const wc = tab?.wc;
    const on = !!wc && reading.has(wc);
    const can = on || (yours(tab) && !tab.asleep && offered.get(wc) === wc.getURL());
    return { reader: { can, on } };
  }

  return {
    state, toggle, open, leave, prefs, attach,
    probes: {
      'reader:toggle': () => toggle(),
      'reader:set': (q) => { setPref(q); return prefs(); },
    },
  };
}

module.exports = { createReader, articleText, SCHEME };
