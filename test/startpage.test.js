// The start page: what a new tab of the user's opens with. Only the user's
// own tabs get it; a session's tab is blank, and one handed over while on it
// is blank when it arrives. A private window's shows no history or bookmarks.
// The weather and the news on it are fetched by Loui, here from a local stub.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
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
  assert.fail(`${what}; last ${JSON.stringify(last)}`);
}

// ── stand-ins for Open-Meteo and a news feed ────────────────────────────────
const hits = { forecast: 0, geocode: 0, feed: 0, bad: 0 };
let weatherDown = false;
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
    return res.end(JSON.stringify(name === 'Mendoza'
      ? { results: [{ name: 'Mendoza', latitude: -32.89, longitude: -68.83, country: 'Argentina', country_code: 'AR', admin1: 'Mendoza' }] } : {}));
  }
  if (url.pathname === '/feed') { hits.feed++; return res.end(FEED); }
  if (url.pathname === '/atom') return res.end(ATOM);
  hits.bad++;
  res.writeHead(500).end('no');
});

const now = Date.now();
const entry = (url, visits) => ({ url, title: url, visits, first: now - 1e9, last: now - 1e6 });
const HISTORY = {
  version: 1,
  entries: [entry('https://a.example/one', 3), entry('https://a.example/two', 2), entry('https://b.example/', 9), entry('https://www.c.example/deep/page', 2)],
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
const env = () => ({ LOUI_WEATHER_URL: `${at}/forecast`, LOUI_GEOCODE_URL: `${at}/geocode` });

test.before(async () => {
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  at = `http://127.0.0.1:${stub.address().port}`;
  profile(home);
  b = await launch(env(), { home });
});
test.after(async () => {
  await b?.close();
  stub.close();
  try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {}
});

const tabOf = async (id, app = b) => (await app.ui('state')).tabs.find((t) => t.id === id);
const onScreen = async (app = b) => (await app.state()).tabs.find((t) => t.active);
const js = (id, code, app = b) => app.ui('tab:js', { id, code });
const saved = () => JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'));
const act = (what, arg) => b.ui('settings:act', { what, arg });
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
  for (const tab of [await started(), await fresh()]) {
    assert.equal(tab.url, '', 'the address bar is empty');
    assert.equal(tab.title, 'New tab');
    assert.match(tab.favicon, /^loui-icon:\/\/tab\//, 'Louis is its icon');
    assert.equal(await js(tab.id, 'origin'), 'null', 'the page has an origin of its own, shared with nothing');
    assert.equal(await js(tab.id, 'document.scripts.length'), 0);
    assert.match(await words(tab.id), /Loui/);
  }
});

test('most visited comes from history, most visited first, and the bookmarks bar\'s bookmarks show while the bar is hidden', async () => {
  const tab = await fresh();
  assert.deepEqual(await names(tab.id), ['b.example', 'a.example', 'c.example']);
  assert.equal(await js(tab.id, "document.querySelector('.tile').href"), 'https://b.example/');
  assert.deepEqual(await js(tab.id, "[...document.querySelectorAll('.chip')].map((n) => n.textContent + ' ' + n.href)"), ['MMarked place https://marked.example/']);
});

test('hiding a site sticks, and Settings brings it back', async () => {
  const tab = await fresh();
  await js(tab.id, "document.querySelector('.hide[href*=\"a.example\"]').click()");
  await until('the tile is gone', async () => !(await names(tab.id).catch(() => ['a.example'])).includes('a.example'));
  assert.deepEqual(saved().startHidden, ['a.example']);
  assert.deepEqual(await names((await fresh()).id), ['b.example', 'c.example']);
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
  assert.deepEqual(saved().newsFeeds, [`${at}/feed`, `${at}/atom`]);
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
  assert.deepEqual(saved().weatherAt, { name: 'Mendoza, Argentina', lat: -32.89, lon: -68.83 });
  assert.equal(hits.geocode, 2);
});

test('a fetch that fails is said quietly, and the page still opens', async () => {
  weatherDown = true;
  await act('start:units', 'c'); // other units: asked for afresh
  await act('start:feed-remove', `${at}/feed`);
  await act('start:feed-add', `${at}/missing`);
  const tab = await fresh();
  const text = await words(tab.id);
  assert.match(text, /Couldn't load the weather\./);
  assert.match(text, /Couldn't load the news\./);
  assert.equal(tab.title, 'New tab');
  assert.deepEqual(await names(tab.id), ['b.example', 'a.example', 'c.example']);
  const failed = hits.bad;
  await fresh();
  assert.equal(hits.bad, failed, 'not tried again on the next tab');
  weatherDown = false;
});

test('with both switched off nothing is asked for at all', async () => {
  await act('start:part', { part: 'startWeather', on: false });
  await act('start:part', { part: 'startNews', on: false });
  await act('start:units', 'f'); // nothing kept would answer for these
  await act('start:feed-remove', `${at}/missing`);
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
  assert.doesNotMatch(text, SITES);
  assert.doesNotMatch(text, /Most visited|Bookmarks\n|Claude sessions/);
  assert.match(text, /Mendoza, Argentina/, 'the weather says nothing about the user, and shows');
  assert.equal(await js(tab.id, "document.querySelectorAll('.tiles, .chips').length"), 0);
  assert.equal(await b.ui('start:served'), served, "the user's page was not served to it");
  await b.ui('window:close', w);
  await until('the private window closes', async () => (await b.ui('windows')).length === 1);
  await b.ui('window:focus', (await b.ui('windows'))[0].id);
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
    profile(dir, { startWeather: false, startNews: false });
    a = await launch(env(), { home: dir });
    const first = await started(a);
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
