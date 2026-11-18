// The start page: what a new tab of the user's opens with. Only the user's
// own tabs get it; a session's tab is blank, and one handed over while on it
// is blank when it arrives. A private window's shows no history or bookmarks.
// The weather and the news on it are fetched by Loui, here from a local stub.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const dns = require('dns');
const http = require('http');
const os = require('os');
const path = require('path');
const { launch } = require('./drive');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, tries = 80) {
  let last;
  for (let i = 0; i < tries; i++) {
    last = await fn().catch((e) => ({ error: e.message }) && null);
    if (last) return last;
    await wait(100);
  }
  assert.fail(`${typeof what === 'function' ? what() : what}; last ${JSON.stringify(last)}`);
}

// ── stand-ins for Open-Meteo and a news feed ────────────────────────────────
const hits = { forecast: 0, geocode: 0, feed: 0, atom: 0, bad: 0, inner: 0 };
let weatherDown = false;
let flakyDown = false; // the feed at /flaky answers until this is set
const item = (title, link, source = 'The Gazette') =>
  `<item><title>${title}</title><link>${link}</link><pubDate>${new Date(Date.now() - 3 * 3600e3).toUTCString()}</pubDate><source url="https://gazette.example">${source}</source></item>`;
const FEED = `<?xml version="1.0"?><rss version="2.0"><channel><title>Stub news</title>
${item('Harvest starts early &amp; well - The Gazette', 'https://gazette.example/harvest')}
${item('&lt;img src=x onerror=alert(1)&gt;&lt;b&gt;Bold&lt;/b&gt; claim', 'https://gazette.example/bold')}
${item('<![CDATA[<script>document.title = "pwned"</script>Scripted headline]]>', 'https://gazette.example/script')}
${item('A headline with a script link', 'javascript:alert(1)')}
${item('A headline with a file link', 'file:///etc/passwd')}
</channel></rss>`;
const ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Atom stub</title>
<entry><title>An Atom headline</title><link rel="self" href="https://atom.example/self"/><link href="https://atom.example/story"/><updated>${new Date(Date.now() - 600e3).toISOString()}</updated></entry></feed>`;
const stub = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/forecast') {
    hits.forecast++;
    if (weatherDown) return res.writeHead(500).end('down');
    const f = url.searchParams.get('temperature_unit') === 'fahrenheit';
    return res.end(JSON.stringify({
      current: { temperature_2m: f ? 71.6 : 22.2, weather_code: 2 },
      daily: { temperature_2m_max: [f ? 78.3 : 25.7], temperature_2m_min: [f ? 55.1 : 12.8] },
    }));
  }
  if (url.pathname === '/geocode') {
    hits.geocode++;
    const name = url.searchParams.get('name');
    // As Open-Meteo answers: the places of that name, as many as were asked for.
    const places = {
      Mendoza: [{ name: 'Mendoza', latitude: -32.89, longitude: -68.83, country: 'Argentina', country_code: 'AR', admin1: 'Mendoza' }],
      'Córdoba': [
        { name: 'Córdoba', latitude: -31.41, longitude: -64.18, country: 'Argentina', country_code: 'AR', admin1: 'Córdoba' },
        { name: 'Córdoba', latitude: 37.89, longitude: -4.77, country: 'Spain', country_code: 'ES', admin1: 'Andalusia' },
        { name: 'Córdoba', latitude: 18.88, longitude: -96.93, country: 'Mexico', country_code: 'MX', admin1: 'Veracruz' },
      ],
    }[name];
    return res.end(JSON.stringify(places ? { results: places.slice(0, Number(url.searchParams.get('count')) || 1) } : {}));
  }
  if (url.pathname === '/feed') { hits.feed++; return res.end(FEED); }
  if (url.pathname === '/atom') { hits.atom++; return res.end(ATOM); }
  if (url.pathname === '/moved') return res.writeHead(302, { location: '/feed' }).end();
  if (url.pathname === '/inward') return res.writeHead(302, { location: `${within}/secret` }).end();
  if (url.pathname === '/flaky' && !flakyDown) return res.end(FEED);
  if (url.pathname === '/page') return res.end('<!doctype html><title>Not a feed</title><p>Just a page.</p>');
  hits.bad++;
  res.writeHead(500).end('no');
});

// Something else on this machine, which no feed may reach: Loui is not told it is a stand-in.
const inner = http.createServer((req, res) => { hits.inner++; res.end(FEED); });
let within;

const now = Date.now();
const entry = (url, visits) => ({ url, title: url, visits, first: now - 1e9, last: now - 1e6 });
const DOT = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const HISTORY = {
  version: 1,
  entries: [
    entry('https://a.example/one', 3), entry('https://a.example/two', 2), entry('https://b.example/', 9), entry('https://www.c.example/deep/page', 2),
    entry('https://once.example/', 1), // been to once: not a site the user keeps going to
    entry('https://search.brave.com/search?q=wine', 7), // where searches land: the search engine itself is left out
  ],
  // b.example's icon, as a tab once showed it; and one that is not a picture Loui made.
  icons: { 'b.example': DOT, 'a.example': 'data:image/png;base64,AAAA" onerror="alert(1)' },
};
const BOOKMARKS = { version: 1, showBar: false, next: 5, other: [], bar: [{ id: '1', title: 'Marked place', url: 'https://marked.example/', added: now }] };
const SITES = /a\.example|b\.example|c\.example|Marked place|marked\.example/;

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'loui-test-'));
let b, at;
// A profile with history, a bookmark, and the stub as the sources.
function profile(dir, settings = {}) {
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
    newTab: 'start', weatherUnits: 'f', weatherPlace: 'Mendoza', weatherAt: { name: 'Mendoza, Argentina', lat: -32.89, lon: -68.83 },
    newsFeeds: [`${at}/feed`], ...settings,
  }));
  fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify(HISTORY));
  fs.writeFileSync(path.join(dir, 'bookmarks.json'), JSON.stringify(BOOKMARKS));
}
const env = () => ({ LOUI_WEATHER_URL: `${at}/forecast`, LOUI_GEOCODE_URL: `${at}/geocode`, LOUI_FEEDS_LOCAL: new URL(at).host });

test.before(async () => {
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  at = `http://127.0.0.1:${stub.address().port}`;
  await new Promise((r) => inner.listen(0, '127.0.0.1', r));
  within = `http://127.0.0.1:${inner.address().port}`;
  profile(home);
  b = await launch(env(), { home });
});
test.after(async () => {
  await b?.close();
  stub.close();
  inner.close();
  try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {}
});

const tabOf = async (id, app = b) => (await app.ui('state')).tabs.find((t) => t.id === id);
const onScreen = async (app = b) => (await app.state()).tabs.find((t) => t.active);
const js = (id, code, app = b) => app.ui('tab:js', { id, code });
const saved = () => JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'));
const act = (what, arg) => b.ui('settings:act', { what, arg });
const chrome = (code, app = b) => app.ui('chrome:eval', code);
const start = async () => (await b.ui('settings:state')).state.general.start;
// The tab on screen once the start page is drawn in it.
async function started(app = b) {
  return until('the start page is drawn', async () => {
    const tab = await onScreen(app);
    return tab && !tab.loading && (await js(tab.id, 'location.protocol', app)) === 'loui-start:' && tab;
  });
}
// A new tab, as Ctrl+T opens one.
async function fresh() {
  const before = (await onScreen()).id;
  await b.ui('tab:new', '');
  await until('a new tab is on screen', async () => (await onScreen()).id !== before);
  return started();
}
const words = (id, app = b) => js(id, 'document.body.innerText', app);
// The sites on its tiles, without the test's own pages (visited as the tests go, so in history too).
const names = async (id, app = b) => (await js(id, "[...document.querySelectorAll('.tiles .name')].map((n) => n.textContent)", app))
  .filter((n) => !n.startsWith('127.0.0.1'));
// A tool call from the Claude panel, which works in the user's own tabs.
const panel = async (tool, args) => (await b.ui('panel', { tool, args })).filter((c) => c.type === 'text').map((c) => c.text).join('\n');

test('the first tab and a new tab show the start page: no address, "New tab", Louis in the tab strip', async () => {
  const first = await started();
  // Loui has just started: the address bar has the keyboard, as it does in a new tab.
  await until('the address bar has the keyboard at launch', async () => (await chrome('document.hasFocus() && document.activeElement?.id')) === 'address');
  for (const tab of [first, await fresh()]) {
    assert.equal(tab.url, '', 'the address bar is empty');
    assert.equal(tab.title, 'New tab');
    assert.match(tab.favicon, /^loui-icon:\/\/tab\//, 'Louis is its icon');
    assert.equal(await js(tab.id, 'origin'), 'null', 'the page has an origin of its own, shared with nothing');
    assert.equal(await js(tab.id, 'document.scripts.length'), 0);
    assert.match(await words(tab.id), /Loui/);
  }
});

// Louis and what is under him, as drawn in a tab's start page.
const header = (id, app = b) => js(id, `(() => { const r = (s) => document.querySelector(s).getBoundingClientRect();
  return { louis: [Math.round(r('.brand img').width), Math.round(r('.brand img').height)], name: parseFloat(getComputedStyle(document.querySelector('.brand h1')).fontSize),
    under: r('.brand h1').top >= r('.brand img').bottom && r('input').top >= r('.brand h1').bottom, box: Math.round(r('input').bottom),
    high: innerHeight, wide: innerWidth, fits: document.documentElement.scrollWidth <= innerWidth }; })()`, app);
const resize = async (width, height, ui = b.ui) => {
  await ui('chrome:eval', `window.resizeTo(${width}, ${height})`);
  await until(`the window is ${width} wide`, async () => Math.abs(await ui('chrome:eval', 'window.innerWidth') - width) < 4);
};

test('Louis is large on it, his name under him to scale, and the search box well above the fold; he shrinks in a small window', async () => {
  const tab = await started();
  await resize(1400, 900);
  const big = await until('the page is laid out at 1400 wide', async () => { const h = await header(tab.id); return h.wide > 900 && h; });
  assert.deepEqual(big.louis, [160, 160]);
  assert.ok(big.name >= 42 && big.name <= 48, `"Loui" is ${big.name}px`);
  assert.ok(big.under, 'Louis, then the name, then the search box');
  assert.ok(big.box < big.high * 0.6, `the search box ends at ${big.box} of ${big.high}`);
  await resize(720, 900);
  const small = await until('the page is laid out at 720 wide', async () => { const h = await header(tab.id); return h.wide < 500 && h; });
  assert.ok(small.louis[0] >= 104 && small.louis[0] < 160 && small.louis[0] === small.louis[1], `Louis is ${small.louis}`);
  assert.ok(small.name < big.name && small.name >= 28, `"Loui" is ${small.name}px`);
  assert.ok(small.under && small.fits && small.box < small.high * 0.6, JSON.stringify(small));
  await resize(1400, 900);
});

test('most visited comes from history, most visited first, and the bookmarks bar\'s bookmarks show while the bar is hidden', async () => {
  const tab = await fresh();
  assert.deepEqual(await names(tab.id), ['b.example', 'a.example', 'c.example'], 'not the search engine, nor a site visited once');
  assert.equal(await js(tab.id, "document.querySelector('.tile').href"), 'https://b.example/');
  // A site whose icon a tab has shown wears it; the others a letter. The grid is as wide as its tiles.
  assert.deepEqual(await js(tab.id, "[...document.querySelectorAll('.tile')].slice(0, 3).map((t) => t.querySelector('img.icon')?.src || t.querySelector('.letter').textContent)"), [DOT, 'A', 'C']);
  assert.equal(await js(tab.id, "document.querySelectorAll('[onerror]').length"), 0);
  assert.match(await js(tab.id, "document.querySelector('.tiles').className"), /\bn\d\b/);
  assert.deepEqual(await js(tab.id, "[...document.querySelectorAll('.chip')].map((n) => n.textContent + ' ' + n.href)"), ['MMarked place https://marked.example/']);
});

test('hiding a site sticks, and Settings brings it back', async () => {
  const tab = await fresh();
  await js(tab.id, "document.querySelector('.hide[href*=\"a.example\"]').click()");
  await until('the tile is gone', async () => !(await names(tab.id).catch(() => ['a.example'])).includes('a.example'));
  assert.deepEqual(saved().startHidden, ['a.example']);
  // The page that follows says so, with a way back; Undo restores it.
  assert.match(await words(tab.id), /Removed a\.example · Undo/);
  await js(tab.id, "document.querySelector('.removed a').click()");
  await until('the tile is back', async () => (await names(tab.id).catch(() => [])).includes('a.example'));
  assert.equal(saved().startHidden, undefined);
  assert.doesNotMatch(await words(tab.id), /Removed/);
  await js(tab.id, "document.querySelector('.hide[href*=\"a.example\"]').click()");
  await until('the tile is gone again', async () => !(await names(tab.id).catch(() => ['a.example'])).includes('a.example'));
  const next = await fresh();
  assert.doesNotMatch(await words(next.id), /Removed/, 'offered once, on the page that followed');
  assert.deepEqual(await names(next.id), ['b.example', 'c.example']);
  assert.equal((await b.ui('settings:state')).state.general.start.hidden, 1);
  await act('start:unhide');
  assert.deepEqual(await names((await fresh()).id), ['b.example', 'a.example', 'c.example']);
});

test('the bookmarks are left off while the bookmarks bar shows, and the tiles can be switched off', async () => {
  await b.ui('bookmarks', { do: 'bar', show: true });
  await act('start:part', { part: 'startTiles', on: false });
  const tab = await fresh();
  assert.doesNotMatch(await words(tab.id), SITES);
  await b.ui('bookmarks', { do: 'bar', show: false });
  await act('start:part', { part: 'startTiles', on: true });
});

test('typing in its box and pressing Enter opens an address, or searches for words; Back returns to it', async () => {
  const tab = await fresh();
  const ref = (page) => /textbox "Search or enter an address" \[(e\d+)\]/.exec(page)[1];
  await panel('type', { ref: ref(await panel('snapshot')), text: `${b.base}/plain.html`, submit: true });
  await until('the address opens', async () => (await tabOf(tab.id)).url === `${b.base}/plain.html`);
  await b.ui('back');
  const back = await started();
  assert.equal(back.id, tab.id);
  assert.equal(back.url, '');
  assert.ok(back.canGoForward, 'the page it left is ahead');

  await b.ui('search:set', { engine: 'custom', url: `${b.base}/second.html?q=%s` });
  await panel('type', { ref: ref(await panel('snapshot')), text: 'two words', submit: true });
  await until('the words are searched for', async () => (await tabOf(tab.id)).url === `${b.base}/second.html?q=two%20words`);
  await b.ui('search:set', { engine: 'brave' });
});

test('its box hands the keyboard to the address bar: a click, or a letter typed on the page', async () => {
  const tab = await fresh();
  const focused = () => chrome('document.hasFocus() && document.activeElement?.id');
  const value = () => chrome("document.getElementById('address').value");
  // The keyboard is on the page (the user clicked it, say).
  await chrome("document.getElementById('address').blur()");
  await b.ui('page:focus');
  await until('the page has the keyboard', async () => (await focused()) !== 'address');
  // A press on the box.
  const at = await js(tab.id, "(() => { const r = document.querySelector('form input').getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]; })()");
  await b.ui('tab:press', { id: tab.id, x: at[0], y: at[1] });
  await until('the address bar has the keyboard', async () => (await focused()) === 'address');
  assert.equal((await tabOf(tab.id)).url, '', 'the page stayed where it was');
  assert.equal(await js(tab.id, 'location.protocol'), 'loui-start:');
  // Letters typed on the page: they arrive in the address bar, which completes them from history.
  await chrome("document.getElementById('address').blur()");
  await b.ui('page:focus');
  await until('the page has the keyboard again', async () => (await focused()) !== 'address');
  const type = async (key) => { for (const type of ['keyDown', 'keyUp']) await b.ui('tab:key', { id: tab.id, type, key }); };
  // Esc in the address bar: the first closes a list of suggestions, the next gives the keyboard back to the page.
  const esc = async () => {
    for (let i = 0; i < 2 && (await focused()) === 'address'; i++) {
      await chrome("document.getElementById('address').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
      await wait(200);
    }
    await until('Esc gives the keyboard back to the page', async () => (await focused()) !== 'address');
  };
  const typed = () => chrome("(() => { const a = document.getElementById('address'); return a.value.slice(0, a.selectionStart) + '|' + a.value.slice(a.selectionStart); })()");
  await type('b');
  let seen; // what the address bar held, for the message
  await until(() => `the letter is in the address bar, which completes it (keyboard on ${seen[0]}, bar ${seen[1]})`, async () => {
    seen = [await focused(), await typed()];
    return seen[0] === 'address' && seen[1] === 'b|.example';
  });
  // The next letters follow it there, though they too were typed "on the page".
  await type('.');
  await type('e');
  await until('the address bar completes that too', async () => (await typed()) === 'b.e|xample');
  assert.equal(await chrome("document.getElementById('address').selectionStart"), 3, 'three letters typed, the rest offered');
  assert.equal(await js(tab.id, "document.querySelector('form input').value"), '', 'nothing was typed in the page');
  assert.ok((await b.ui('suggestions')).open, 'with its list of suggestions');
  // A key a tool sends the page (the Claude panel's press_key) is not the user's: it stays in the page.
  await esc();
  await panel('press_key', { key: 'x' });
  await wait(300);
  assert.notEqual(await focused(), 'address');
  assert.equal(await value(), '', "nothing of the tool's is in the address bar");
  await b.ui('page:focus');
  await type('b');
  await until('the user\'s own letter still goes there', async () => (await focused()) === 'address' && (await value()).startsWith('b'));
  // Space, and keys with Ctrl, are the page's own.
  await esc();
  await type(' ');
  await b.ui('tab:key', { id: tab.id, type: 'keyDown', key: 'a', modifiers: ['control'] });
  await wait(300);
  assert.notEqual(await focused(), 'address');
});

test('the box opens web addresses and searches only: not a file, though the Claude panel can type in it', async () => {
  const tab = await fresh();
  const ref = (page) => /textbox "Search or enter an address" \[(e\d+)\]/.exec(page)[1];
  for (const address of [`file://${__filename}`, `view-source:${b.base}/plain.html`, 'file:///etc/hostname']) {
    await panel('type', { ref: ref(await panel('snapshot')), text: address, submit: true }).catch(() => {});
    await sleep(700);
    const now = await tabOf(tab.id);
    assert.equal(now.url, '', `${address} is not opened`);
    assert.doesNotMatch(await panel('snapshot'), /node:test|require\(/, 'and nothing of the file is read');
  }
});

test('the weather and the news are drawn from what Loui fetched, once for any number of start pages', async () => {
  const tab = await fresh();
  const text = await words(tab.id);
  assert.match(text, /Mendoza, Argentina\s+72\s*°F\s+Partly cloudy\s+High 78° · Low 55°/);
  // The date heads the weather's card, and is not said again at the foot.
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long' });
  assert.match(await js(tab.id, "document.querySelector('.weather .date').textContent"), new RegExp(today));
  assert.doesNotMatch(await js(tab.id, "document.querySelector('footer').textContent"), new RegExp(today));
  assert.match(text, /Harvest starts early & well\s+The Gazette · 3 hours ago/, 'the title without its source, then the source and age');
  await fresh();
  await fresh();
  assert.equal(hits.forecast, 1, 'one request for the weather, however many tabs');
  assert.equal(hits.feed, 1, 'and one for the feed');
  assert.equal(await js(tab.id, "document.querySelector('meta[http-equiv]').content.includes(\"default-src 'none'\")"), true, 'the page itself has no network access');
});

test('markup in a headline is shown as text, and a link that is not http(s) is dropped', async () => {
  const tab = await fresh();
  const text = await words(tab.id);
  assert.match(text, /<img src=x onerror=alert\(1\)><b>Bold<\/b> claim/);
  assert.match(text, /<script>document\.title = "pwned"<\/script>Scripted headline/);
  assert.equal(await js(tab.id, "document.querySelectorAll('.news img, .news b, .news script').length"), 0);
  assert.equal((await tabOf(tab.id)).title, 'New tab');
  assert.doesNotMatch(text, /script link|file link/);
  assert.deepEqual(await js(tab.id, "[...document.querySelectorAll('.news a')].map((a) => a.protocol)"), ['https:', 'https:', 'https:']);
});

test('an Atom feed is read too, and a place is looked up once by name', async () => {
  await act('start:feed-add', `${at}/atom`);
  await act('start:feed-add', 'javascript:alert(1)');
  assert.equal((await start()).feedTrouble, 'That is not a web address.');
  // An address is read once before it is listed: a page that is no feed, or one that does not answer, is not kept.
  await act('start:feed-add', `${at}/page`);
  assert.equal((await start()).feedTrouble, 'No headlines found at that address.');
  await act('start:feed-add', `${at}/missing`);
  assert.equal((await start()).feedTrouble, 'No headlines found at that address.');
  await act('start:feed-add', `${at}/atom`);
  assert.equal((await start()).feedTrouble, 'That feed is already listed.');
  assert.deepEqual(saved().newsFeeds, [`${at}/feed`, `${at}/atom`]);
  // Well-known feeds are offered, less those already listed.
  const known = (await start()).known;
  assert.ok(known.length >= 6 && known.every((k) => k.name && /^https:\/\//.test(k.url)), JSON.stringify(known));
  assert.ok(['BBC News', 'El País'].every((name) => known.some((k) => k.name === name)), 'in English and in Spanish');
  const tab = await fresh();
  assert.match(await words(tab.id), /An Atom headline\s+Atom stub · 10 minutes ago/);
  assert.equal(await js(tab.id, "[...document.querySelectorAll('.news a')].find((a) => /Atom/.test(a.textContent)).href"), 'https://atom.example/story');
  await act('start:feed-remove', `${at}/atom`);

  await act('start:place', 'Nowhere at all');
  assert.equal(saved().weatherPlace, 'Mendoza', 'a place that is not found changes nothing');
  await act('start:place', '');
  assert.equal(saved().weatherAt, undefined);
  const unset = await fresh();
  assert.match(await words(unset.id), /Set your place in Settings/);
  await js(unset.id, "document.querySelector('.weather a').click()");
  await until('Settings opens', async () => (await b.ui('settings:state')).open);
  await b.ui('settings:close');
  await act('start:place', 'Mendoza');
  assert.deepEqual(saved().weatherAt, { name: 'Mendoza, Argentina', lat: -32.89, lon: -68.83, full: 'Mendoza, Mendoza, Argentina' });
  assert.equal(hits.geocode, 2);
  assert.equal((await start()).resolved, 'Mendoza, Mendoza, Argentina', 'Settings says which Mendoza');
});

test('a name that is several places: Settings says which one was taken, and offers the others', async () => {
  await act('start:place', 'Córdoba');
  assert.equal((await start()).resolved, 'Córdoba, Córdoba, Argentina');
  assert.deepEqual((await start()).others.map((o) => o.full), ['Córdoba, Andalusia, Spain', 'Córdoba, Veracruz, Mexico']);
  await b.ui('settings:open', 'start');
  const page = (code) => b.ui('settings:js', code);
  await until('the Settings window is drawn', async () => (await page("document.querySelector('#value-weather-place span')?.textContent")) === 'Córdoba, Córdoba, Argentina');
  assert.equal(await page("document.getElementById('set-weather-place').placeholder"), 'Type a town or city');
  await page("document.getElementById('set-weather-place-others').click()");
  const others = () => page("[...document.querySelectorAll('[data-setting=weather-place] .st-list .st-item')].map((n) => n.textContent)");
  await until('the other places show', async () => (await others()).length === 2);
  assert.deepEqual(await others(), ['Córdoba, Andalusia, Spain', 'Córdoba, Veracruz, Mexico']);
  await page("[...document.querySelectorAll('[data-setting=weather-place] .st-list li')].find((li) => /Spain/.test(li.textContent)).querySelector('button').click()");
  await until('the place is the one chosen', async () => saved().weatherAt?.full === 'Córdoba, Andalusia, Spain');
  assert.deepEqual(saved().weatherAt, { name: 'Córdoba, Spain', lat: 37.89, lon: -4.77, full: 'Córdoba, Andalusia, Spain' });
  assert.equal(saved().weatherPlace, 'Córdoba');
  // A feed that is no feed is refused in the page's own words; a well-known one is a press away.
  await page("(() => { const i = document.getElementById('set-news-feeds'); i.value = '" + at + "/page'; i.form.requestSubmit(); })()");
  await until('the page says why', async () => /No headlines found at that address/.test(await page("document.querySelector('[data-setting=news-feeds] .st-note').textContent")));
  assert.ok((await page("[...document.querySelectorAll('[data-setting=news-known] .st-offers button')].map((n) => n.textContent)")).includes('BBC Mundo'));
  // The start page has a section of its own.
  assert.deepEqual((await page('window.shownForTest()')).map((s) => s.title), ['Start page']);
  await b.ui('settings:close');
  await act('start:place', 'Mendoza');
});

test('a fetch that fails is said quietly, and the page still opens; the last reading stays, in the units asked for', async () => {
  await fresh(); // a reading of Mendoza, in Fahrenheit, is at hand
  weatherDown = true;
  await act('start:units', 'c'); // other units: asked for afresh
  await act('start:feed-remove', `${at}/feed`);
  await act('start:feed-add', `${at}/flaky`);
  flakyDown = true;
  const tab = await fresh();
  const text = await words(tab.id);
  // The reading from before, in the new units, with when it is from and a way to ask again.
  assert.match(text, /Mendoza, Argentina\s+22\s*°C\s+Partly cloudy\s+High 26° · Low 13°\s+Couldn't update: this is from \d+:\d\d.*\. Try again/);
  assert.match(text, /Couldn't load the news\./);
  assert.equal(tab.title, 'New tab');
  assert.deepEqual(await names(tab.id), ['b.example', 'a.example', 'c.example']);
  const failed = hits.bad, asked = hits.forecast;
  await fresh();
  assert.equal(hits.bad, failed, 'not tried again on the next tab');
  assert.equal(hits.forecast, asked);
  // "Try again" asks at once, and the page shows what came.
  weatherDown = false;
  const again = await fresh();
  await js(again.id, "document.querySelector('.weather .stale a').click()");
  await until('the weather is asked for again', async () => hits.forecast === asked + 1);
  await until('the page shows it', async () => { const t = await words(again.id).catch(() => ''); return /22\s*°C\s+Partly cloudy\s+High 26° · Low 13°/.test(t) && !/Couldn't update|Try again/.test(t); });
  await act('start:feed-remove', `${at}/flaky`);
  await act('start:feed-add', `${at}/missing`);
  flakyDown = false;
});

test('with both switched off nothing is asked for at all', async () => {
  await act('start:part', { part: 'startWeather', on: false });
  await act('start:part', { part: 'startNews', on: false });
  await act('start:units', 'f'); // nothing kept would answer for these
  await act('start:feed-add', `${at}/feed`);
  const before = { ...hits };
  const tab = await fresh();
  assert.doesNotMatch(await words(tab.id), /Weather|News/);
  assert.deepEqual(hits, before);
  await act('start:part', { part: 'startWeather', on: true });
  await act('start:part', { part: 'startNews', on: true });
});

test('Settings: new tabs open the start page, a blank page, or an address', async () => {
  assert.equal((await b.ui('settings:state')).state.general.start.choice, 'start');
  await act('new-tab', { choice: 'blank' });
  const before = (await onScreen()).id;
  await b.ui('tab:new', '');
  const blank = await until('a blank tab opens', async () => { const t = await onScreen(); return t.id !== before && !t.loading && t; });
  assert.equal(await js(blank.id, 'location.href'), 'about:blank');
  assert.equal(blank.url, '');

  await act('new-tab', { choice: 'address' });
  assert.equal((await fresh()).url, '', 'with no address given yet, the start page');
  await act('new-tab', { address: 'not an address' });
  assert.equal(saved().newTabAddress, undefined);
  await act('new-tab', { address: `${b.base}/plain.html` });
  await b.ui('tab:new', '');
  await until('the address opens in a new tab', async () => (await onScreen()).url === `${b.base}/plain.html`);
  assert.equal(saved().newTab, 'address');
  await act('new-tab', { choice: 'start' });
});

test("a private window's start page shows no history and no bookmarks", async () => {
  const served = await b.ui('start:served');
  const w = await b.ui('window:new', { private: true });
  const inWindow = { ui: (name, arg) => b.ui('in-window', { window: w, ui: name, arg }), state: () => b.ui('in-window', { window: w, ui: 'state' }) };
  const tab = await started(inWindow);
  assert.ok(tab.private);
  assert.equal(tab.url, '');
  const text = await words(tab.id);
  assert.match(text, /Private window/);
  assert.match(text, /keeps no history/);
  await resize(1400, 900, inWindow.ui);
  const head = await until('its page is laid out at 1400 wide', async () => { const h = await header(tab.id); return h.wide > 900 && h; });
  assert.deepEqual([head.louis, head.under, head.box < head.high * 0.6], [[160, 160], true, true], 'Louis is as large there');
  assert.doesNotMatch(text, SITES);
  assert.doesNotMatch(text, /Most visited|Bookmarks\n|Claude sessions/);
  assert.match(text, /Mendoza, Argentina/, 'the weather says nothing about the user, and shows');
  assert.equal(await js(tab.id, "document.querySelectorAll('.tiles, .chips').length"), 0);
  assert.equal(await b.ui('start:served'), served, "the user's page was not served to it");
  await b.ui('window:close', w);
  await until('the private window closes', async () => (await b.ui('windows')).length === 1);
  await b.ui('window:focus', (await b.ui('windows'))[0].id);
});

test("a private window's start page asks the web for nothing: it shows what is already kept, or nothing", async () => {
  await act('start:units', 'c'); // nothing kept answers for these
  await act('start:feed-add', `${at}/atom`);
  const before = { ...hits };
  const w = await b.ui('window:new', { private: true });
  const inWindow = { ui: (name, arg) => b.ui('in-window', { window: w, ui: name, arg }), state: () => b.ui('in-window', { window: w, ui: 'state' }) };
  const tab = await started(inWindow);
  const text = await words(tab.id);
  assert.match(text, /Private window/);
  assert.doesNotMatch(text, /Weather|News|Mendoza|headline/);
  await wait(300);
  assert.deepEqual(hits, before, 'nothing was fetched for it');
  await b.ui('window:close', w);
  await until('the private window closes', async () => (await b.ui('windows')).length === 1);
  await b.ui('window:focus', (await b.ui('windows'))[0].id);
  await act('start:units', 'f');
  await act('start:feed-remove', `${at}/atom`);
});

test('a feed is fetched from the web only: not from this machine, directly or by a redirect', async () => {
  await act('start:feed-remove', `${at}/feed`);
  // A feed is tried once when it is added: these are refused there, and never listed.
  const inward = [`${at}/inward`, `${within}/secret`, `${within.replace('127.0.0.1', 'localhost')}/secret`, `${within.replace('127.0.0.1', '[::ffff:127.0.0.1]')}/secret`];
  for (const feed of inward) await act('start:feed-add', feed).catch(() => {});
  assert.equal(hits.inner, 0, 'nothing on this machine was asked');
  assert.ok(!(saved().newsFeeds || []).some((f) => inward.includes(f)), 'and none of them is kept');
  for (const feed of saved().newsFeeds || []) await act('start:feed-remove', feed);
  // A redirect to somewhere allowed is followed.
  await act('start:feed-add', `${at}/moved`);
  const tab = await fresh();
  assert.match(await words(tab.id), /Harvest starts early & well/);
  await act('start:feed-remove', `${at}/moved`);
  await act('start:feed-add', `${at}/feed`);
});

test('a name that says a public address when checked and this machine when asked again is not followed here', async () => {
  // startfeeds.js on its own, in this process: the name is looked up once for
  // the check (dns.promises.lookup) and would be again for the connection
  // (dns.lookup), and the second answer is the server on this machine.
  const feeds = require('../src/main/startfeeds');
  const first = dns.promises.lookup, second = dns.lookup;
  let again = 0;
  dns.promises.lookup = async () => [{ address: '192.0.2.1', family: 4 }]; // a documentation address: on the web as far as the check goes, and nothing answers there
  dns.lookup = (host, options, done) => {
    again++;
    const cb = typeof options === 'function' ? options : done;
    if (options?.all) cb(null, [{ address: '127.0.0.1', family: 4 }]); else cb(null, '127.0.0.1', 4);
  };
  const before = hits.inner;
  try {
    await assert.rejects(feeds.get(`http://rebound.example:${new URL(within).port}/secret`));
  } finally {
    dns.promises.lookup = first;
    dns.lookup = second;
  }
  assert.equal(hits.inner, before, 'the server on this machine was not asked');
  assert.equal(again, 0, 'and the name was not looked up a second time');
});

test('an address that stands for a private one through a gateway is refused: NAT64 and 6to4', async () => {
  const { local, get } = require('../src/main/startfeeds');
  for (const ip of ['64:ff9b::7f00:1', '64:ff9b::10.0.0.1', '64:ff9b::c0a8:101', '2002:7f00:1::1', '2002:a00:1::', '2002:c0a8:101:0:0:0:0:1', '2002:a9fe:a9fe::1']) {
    assert.equal(local(ip), true, ip);
  }
  // The same forms of an address on the web are let through, as are plain ones.
  for (const ip of ['64:ff9b::808:808', '2002:808:808::1', '2606:4700:4700::1111', '8.8.8.8']) assert.equal(local(ip), false, ip);
  for (const ip of ['::1', '::ffff:127.0.0.1', 'fd00::1', '192.168.1.1']) assert.equal(local(ip), true, ip);
  const before = hits.inner;
  const port = new URL(within).port;
  await assert.rejects(get(`http://[64:ff9b::7f00:1]:${port}/secret`), /on this machine or its network/);
  await assert.rejects(get(`http://[2002:7f00:1::1]:${port}/secret`), /on this machine or its network/);
  assert.equal(hits.inner, before);
});

test("a session's new tab is blank, and the footer counts the sessions open", async () => {
  const s = b.as('s', 'Claude Code');
  assert.match(await s.text('snapshot'), /URL: about:blank/);
  const its = (await b.state()).tabs.find((t) => t.group === 's');
  assert.equal(await js(its.id, 'location.href'), 'about:blank');
  assert.match(await s.text('navigate', { url: `${b.base}/plain.html`, new_tab: true }), /Plain page/);
  // The Claude panel's new tab is blank too.
  const count = (await b.state()).tabs.length;
  await panel('navigate', { url: 'about:blank', new_tab: true });
  const panels = (await b.state()).tabs;
  assert.equal(panels.length, count + 1);
  assert.equal(await js(panels.find((t) => t.current && t.group === 'you').id, 'location.href'), 'about:blank');

  const tab = await fresh();
  assert.match(await words(tab.id), /Claude sessions: 1 open/);
});

test('a tab on the start page handed to a session is blank when it arrives', async () => {
  const s = b.as('s', 'Claude Code');
  const tab = await fresh();
  const served = await b.ui('start:served');
  const asked = s.text('request_tab');
  await wait(300);
  await b.ui('handoff:answer', true);
  const got = await asked;
  assert.match(got, new RegExp(`handed you tab ${tab.id}`));
  assert.doesNotMatch(got, SITES, 'the outline it is given with the tab has none of the sites');
  assert.doesNotMatch(got, /loui-start/);
  const snap = await s.text('snapshot');
  assert.match(snap, /URL: about:blank/);
  assert.doesNotMatch(snap, SITES);
  assert.equal(await js(tab.id, 'location.href'), 'about:blank');
  assert.equal((await tabOf(tab.id)).group, 's');
  // Nor is the start page behind it, to go back or reload to.
  await assert.rejects(s.text('history', { action: 'back' }), /no page to go back to/);
  await s.text('history', { action: 'reload' });
  assert.equal(await js(tab.id, 'location.href'), 'about:blank');
  assert.equal(await b.ui('start:served'), served);

  // One that had been somewhere and come back to the start page keeps the rest of its history.
  const been = await fresh();
  await b.ui('go', `${b.base}/plain.html`);
  await until('the page opens', async () => (await tabOf(been.id)).url === `${b.base}/plain.html`);
  await b.ui('back');
  await started();
  const before = await b.ui('start:served');
  await b.ui('tab:move', { id: been.id, group: 's', index: 0 }); // dragged onto the session's group
  await until('it is blank', async () => (await js(been.id, 'location.href')) === 'about:blank' && !(await tabOf(been.id)).loading);
  assert.doesNotMatch(await js(been.id, 'document.documentElement.outerHTML'), SITES);
  assert.ok((await tabOf(been.id)).canGoForward);
  assert.equal(await b.ui('start:served'), before);
});

test("a session cannot open the start page, in its own tab or a handed one, and no page can embed or fetch it", async () => {
  const s = b.as('s', 'Claude Code');
  const served = await b.ui('start:served');
  for (const url of ['loui-start://tab', 'loui-start://tab/', 'LOUI-START://tab']) {
    await assert.rejects(s.text('navigate', { url }), /Only http and https/);
  }
  await s.text('navigate', { url: `${b.base}/plain.html` });
  const its = (await b.state()).tabs.find((t) => t.group === 's' && t.current);
  // A script in the session's tab heading there, opening it, framing it, fetching it.
  await s.text('evaluate', { code: "location.href = 'loui-start://tab'; 1" }).catch(() => {});
  await wait(500);
  assert.equal(await js(its.id, 'location.href'), `${b.base}/plain.html`);
  const fetched = await js(its.id, "fetch('loui-start://tab').then((r) => r.text(), (e) => 'refused: ' + e.message)");
  assert.match(fetched, /^refused/);
  await js(its.id, "const f = document.createElement('iframe'); f.src = 'loui-start://tab'; document.body.append(f); window.open('loui-start://tab'); 1");
  await wait(700);
  assert.equal(await b.ui('start:served'), served, 'nothing was served to the session');

  // The same from a web page in the user's own tab: it cannot send the tab there, nor frame or fetch it.
  const mine = await fresh();
  await b.ui('go', `${b.base}/plain.html`);
  await until('the page opens', async () => (await tabOf(mine.id)).url === `${b.base}/plain.html`);
  const after = await b.ui('start:served');
  await js(mine.id, "const f = document.createElement('iframe'); f.src = 'loui-start://tab'; document.body.append(f); 1");
  assert.match(await js(mine.id, "fetch('loui-start://tab').then((r) => r.text(), (e) => 'refused: ' + e.message)"), /^refused/);
  await js(mine.id, "location.href = 'loui-start://tab'; 1");
  await wait(700);
  assert.equal((await tabOf(mine.id)).url, `${b.base}/plain.html`);
  assert.equal(await b.ui('start:served'), after);
  s.end();
});

test("a site's icon is kept with the history once a tab of the user's has shown it, and its tile wears it", async () => {
  const tab = await fresh();
  const host = new URL(b.base).host;
  for (const page of ['icon.html', 'icon.html?again']) {
    await b.ui('go', `${b.base}/${page}`);
    // (The second visit makes it a site gone to more than once; its icon was taken on the first.)
    await until('the page with an icon', async () => { const t = await tabOf(tab.id); return t.url.endsWith(page) && !t.loading && (page !== 'icon.html' || /^loui-icon:/.test(t.favicon || '')); });
  }
  const kept = () => { try { return JSON.parse(fs.readFileSync(path.join(home, 'history.json'), 'utf8')).icons || {}; } catch { return {}; } };
  await until('the icon is written with the history', async () => /^data:image\/png;base64,/.test(kept()[host] || ''));
  assert.ok(kept()[host].length <= 8000, 'small enough to keep');
  assert.deepEqual(Object.keys(kept()).sort(), ['b.example', host].sort(), 'only sites in the history, and only what is a picture');
  const page = await fresh();
  assert.equal(await js(page.id, `[...document.querySelectorAll('.tile')].find((t) => t.textContent.includes('${host}'))?.querySelector('img.icon')?.src`), kept()[host]);
});

test('a tab on the start page sleeps and wakes on it', async () => {
  const tab = await fresh();
  const other = await fresh();
  assert.equal(await b.ui('tab:sleep', tab.id), true);
  const asleep = await tabOf(tab.id);
  assert.ok(asleep.asleep);
  assert.equal(asleep.url, '');
  assert.equal(asleep.title, 'New tab');
  await b.ui('tab:select', tab.id);
  const woke = await started();
  assert.equal(woke.id, tab.id);
  assert.deepEqual(await names(tab.id), ['b.example', 'a.example', 'c.example']);
  await b.ui('tab:close', other.id);
});

test('after a restart a tab on the start page is on it again, and a blank tab from before is still blank', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loui-test-'));
  let a;
  try {
    profile(dir, { startNews: false });
    weatherDown = true; // with no reading from before: said so, with a way to ask again
    a = await launch(env(), { home: dir });
    const first = await started(a);
    assert.match(await words(first.id, a), /Couldn't load the weather\. Try again/);
    weatherDown = false;
    // (This second Loui's window is not the one the system has in front, so only where its own keyboard is.)
    await until('the address bar has the keyboard at launch', async () => (await chrome('document.activeElement?.id', a)) === 'address');
    const page = `${a.base}/plain.html`; // the fixture server has another port next time
    await a.ui('tab:new', page);
    await until('the second tab opens', async () => (await onScreen(a)).url === page);
    await a.ui('tab:select', first.id);
    await wait(1500); // tabs.json is written at most once a second
    await a.close();
    const kept = JSON.parse(fs.readFileSync(path.join(dir, 'tabs.json'), 'utf8'));
    assert.equal(kept.windows[0].tabs[0].history.entries[0].url, 'loui-start://tab');
    // A profile from before the start page: a blank tab, kept as about:blank.
    kept.windows[0].tabs.push({ history: { entries: [{ url: 'about:blank', title: '' }], index: 0 }, device: null, pinned: false });
    fs.writeFileSync(path.join(dir, 'tabs.json'), JSON.stringify(kept));

    a = await launch(env(), { home: dir });
    const back = await started(a);
    assert.equal(back.url, '');
    assert.equal(back.title, 'New tab');
    assert.deepEqual(await names(back.id, a), ['b.example', 'a.example', 'c.example']);
    const all = (await a.state()).tabs;
    assert.deepEqual(all.map((t) => t.url), ['', page, '']);
    assert.match(all[2].favicon || '', /^$/, 'the blank tab is not dressed as the start page');
    await a.ui('tab:select', all[2].id);
    await until('the blank tab wakes', async () => (await js(all[2].id, 'location.href', a).catch(() => '')) === 'about:blank');
  } finally {
    await a?.close();
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {}
  }
});
