// The error page: a plain explanation and Try again for every failed page,
// and Louis's walk when the network is down or the address doesn't exist.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { launch } = require('./drive');

const NOWHERE = 'http://loui-does-not-exist.invalid/some/page?q=x';

let b;
test.before(async () => { b = await launch(); });
test.after(async () => { await b.close(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what, ms = 10000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) {
    const got = await check();
    if (got) return got;
  }
  assert.fail(`timed out waiting for ${what}`);
}
const ref = (outline, start) => {
  const line = outline.split('\n').find((l) => l.trim().startsWith(start));
  assert.ok(line, `no "${start}" in:\n${outline}`);
  return line.match(/\[(e\d+)\]/)[1];
};
// Opens a page in the session's tab and puts that tab on screen, as the
// game only runs in the tab the user is looking at.
async function open(url) {
  const page = await b.text('navigate', { url });
  const tab = (await b.state()).tabs.find((t) => t.group !== 'you' && t.current);
  await b.ui('tab:select', tab.id);
  return page;
}
const snapshot = () => b.text('snapshot');
const evaluate = (code) => b.text('evaluate', { code });

// A port nothing listens on, and a way to start listening on it later.
async function freePort() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

test('an address that does not exist gets the explanation, Try again and the game', async () => {
  const page = await open(NOWHERE);
  assert.match(page, /^Page: Site not found\nURL: http:\/\/loui-does-not-exist\.invalid\/some\/page/m, 'the outline names the address that failed');
  assert.match(page, /heading1 "Can't find this site"/);
  assert.match(page, /Loui couldn't find loui-does-not-exist\.invalid\./);
  assert.match(page, /button "Try again" \[e\d+\]/);
  assert.match(page, /region "Louis's walk"/);
  assert.match(page, /button "Take Louis for a walk"/);
  assert.equal(await evaluate("document.querySelector('#address').textContent"), JSON.stringify(NOWHERE));
  const tab = (await b.state()).tabs.find((t) => t.active);
  assert.equal(tab.url, NOWHERE, 'the address bar shows the address that failed');
  assert.equal(tab.title, 'Site not found');
});

test('the error page has no bridge, no Node and no storage', async () => {
  await open(NOWHERE);
  const seen = JSON.parse(await evaluate(`({
    loui: typeof window.loui, require: typeof require, process: typeof process,
    origin: location.origin,
    storage: (() => { try { localStorage.x = 1; return 'yes'; } catch { return 'no'; } })(),
  })`));
  assert.deepEqual(seen, { loui: 'undefined', require: 'undefined', process: 'undefined', origin: 'null', storage: 'no' });
});

test('picking up after Louis scores, and the best score is kept', async () => {
  let page = await open(NOWHERE);
  page = await b.text('click', { ref: ref(page, 'button "Take Louis for a walk"') });
  page = await until(async () => { const s = await snapshot(); return /button "Pick up the poop"/.test(s) && s; }, 'Louis to leave something');
  assert.match(page, /text "Picked up 0"/);
  page = await b.text('click', { ref: ref(page, 'button "Pick up the poop"') });
  assert.match(page, /text "Picked up 1"/);
  // Left alone, the lawn fills up and the round ends.
  page = await until(async () => { const s = await snapshot(); return /heading2 "New best: 1"/.test(s) && s; }, 'the round to end', 40000);
  assert.match(page, /button "Walk him again"/);
  const file = path.join(b.home, 'game.json');
  await until(() => fs.existsSync(file), 'game.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { best: 1 });
  page = await open(NOWHERE + '&again');
  assert.match(page, /text "Best 1"/, 'a new error page starts from the best score');
});

test('the game stands still while its tab is not on screen', async () => {
  const page = await open(NOWHERE + '&hidden');
  await b.text('click', { ref: ref(page, 'button "Take Louis for a walk"') });
  assert.equal(await evaluate("document.getElementById('game').classList.contains('still')"), 'false');
  const mine = (await b.state()).tabs.find((t) => t.active);
  await b.ui('tab:select', (await b.state()).tabs.find((t) => t.group === 'you').id);
  await until(async () => (await evaluate("document.getElementById('game').classList.contains('still')")) === 'true', 'the game to stop');
  const at = await evaluate("document.querySelector('.louis').style.transform");
  await sleep(500);
  assert.equal(await evaluate("document.querySelector('.louis').style.transform"), at, 'Louis has not moved');
  await b.ui('tab:select', mine.id);
  await until(async () => (await evaluate("document.getElementById('game').classList.contains('still')")) === 'false', 'the game to go on');
});

test('a refused connection gets the explanation without the game, and Try again retries the address', async () => {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}/`;
  const page = await open(url);
  assert.match(page, /heading1 "Can't open this page"/);
  assert.match(page, /127\.0\.0\.1 refused to connect/);
  assert.doesNotMatch(page, /Louis/);
  assert.equal(await evaluate("document.getElementById('game').hidden"), 'true');

  const server = http.createServer((_req, res) => res.end('<title>Up again</title><h1>Up again</h1>'));
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  try {
    const after = await b.text('click', { ref: ref(page, 'button "Try again"') });
    assert.match(after, /heading1 "Up again"/);
    assert.equal((await b.state()).tabs.find((t) => t.active).url, url);
  } finally {
    server.close();
  }
});

// The network can't be unplugged here, so a refused connection stands in for
// it: the app reads the next failure as "offline", and the site coming back
// up is the connection coming back.
async function offlinePage() {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}/`;
  await b.ui('pretend-offline');
  const page = await open(url);
  assert.match(page, /heading1 "You're offline"/);
  assert.equal((await b.state()).tabs.find((t) => t.active).title, "You're offline", 'the tab is named as the page is headed');
  assert.match(page, /region "Louis's walk"/);
  const server = http.createServer((_req, res) => res.end('<title>Back</title><h1>Back</h1>'));
  return { url, page, up: () => new Promise((r) => server.listen(port, '127.0.0.1', r)), down: () => server.close() };
}
const titleOf = async (url) => (await b.state()).tabs.find((t) => t.url === url)?.title;

test('offline, the page reloads by itself once the connection is back', async () => {
  const site = await offlinePage();
  await site.up();
  try {
    await until(async () => (await titleOf(site.url)) === 'Back', 'the page to load', 15000);
  } finally {
    site.down();
  }
});

test('offline, someone playing is offered a reload instead', async () => {
  const site = await offlinePage();
  await b.text('click', { ref: ref(site.page, 'button "Take Louis for a walk"') });
  await site.up();
  try {
    const page = await until(async () => { const s = await snapshot(); return /You're back online/.test(s) && s; }, 'the offer', 15000);
    assert.match(page, /region "Louis's walk"/, 'the game is still there');
    await b.text('click', { ref: ref(page, 'button "Open the page"') });
    await until(async () => (await titleOf(site.url)) === 'Back', 'the page to load');
  } finally {
    site.down();
  }
});

test('error pages are not kept in history', async () => {
  await b.ui('tab:select', (await b.state()).tabs.find((t) => t.group === 'you').id);
  await b.ui('go', b.base + '/second.html');
  await until(async () => (await b.state()).tabs.find((t) => t.active)?.title === 'Second', 'a real page');
  await b.ui('go', NOWHERE + '&mine');
  await until(async () => (await b.state()).tabs.find((t) => t.active)?.title === 'Site not found', 'the error page');
  await sleep(800);
  const saved = JSON.parse(fs.readFileSync(path.join(b.home, 'history.json'), 'utf8')).entries.map((e) => e.url);
  assert.ok(saved.includes(b.base + '/second.html'));
  assert.ok(!saved.some((u) => u.includes('invalid') || u.startsWith('chrome-error')), JSON.stringify(saved));
});
