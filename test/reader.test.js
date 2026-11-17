// Reader view: the book button is offered on articles only, reader view shows
// the article cleaned of scripts and handlers in an unprivileged page, Back
// returns, the settings persist, and read_article gives Claude the text
// without counting as acting.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { launch } = require('./drive');

let b;
test.before(async () => { b = await launch(); });
test.after(async () => { await b.close(); });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, tries = 60) {
  let last;
  for (let i = 0; i < tries; i++) {
    last = await fn();
    if (last) return last;
    await wait(100);
  }
  assert.fail(`${what}; last ${JSON.stringify(last)}`);
}
const onScreen = async () => (await b.state()).tabs.find((t) => t.active);
const js = async (code) => b.ui('tab:js', { id: (await onScreen()).id, code });
// Opens a fixture page in the user's own tab on screen, as the address bar does.
async function page(p) {
  await b.ui('go', b.base + p);
  return until(`${p} loads`, async () => {
    const tab = await onScreen();
    return !tab.loading && tab.url === b.base + p && tab;
  });
}
const reader = async () => (await b.state()).reader;
async function openReader() {
  await b.ui('reader:toggle');
  await until('reader view opens', async () => (await reader()).on && !(await onScreen()).loading);
  await until('reader page is drawn', async () => (await js('location.protocol').catch(() => '')) === 'loui-reader:');
}

test('the book button is offered on an article and not on other pages', async () => {
  await page('/plain.html');
  await wait(800); // the check runs once the page has loaded
  assert.equal((await reader()).can, false);
  await page('/article.html');
  await until('the button is offered', async () => (await reader()).can);
  assert.equal((await reader()).on, false);
  assert.equal(await js('document.documentElement.dataset.page'), 'page script ran', 'the page itself runs as usual');
});

test('reader view shows the article, not the page around it, and keeps the address', async () => {
  await openReader();
  const tab = await onScreen();
  assert.equal(tab.url, b.base + '/article.html', 'the address bar shows the article address');
  assert.equal(tab.title, 'The Lighthouse Keepers of Ushant');
  const body = await js('document.body.innerText');
  assert.match(body, /keepers wrote everything down/);
  assert.match(body, /Wind the clockwork every two hours/);
  assert.doesNotMatch(body, /Sponsored/, 'the ad is left out');
  assert.doesNotMatch(body, /Copyright the fixture/, 'the footer is left out');
  const link = await js(`[...document.querySelectorAll('main a')].find((a) => a.textContent.includes('own accounts'))?.href`);
  assert.equal(link, b.base + '/second.html', 'relative links are made absolute');
});

test('scripts, handlers, frames and forms in the article are stripped and never run', async () => {
  const html = await js('document.documentElement.outerHTML');
  for (const bad of ['<script', 'onerror', '<iframe', '<form', '<input', 'javascript:']) {
    assert.ok(!html.toLowerCase().includes(bad), `no ${bad} in the reader page`);
  }
  const img = await js(`document.querySelector('main img')?.getAttribute('src')`);
  assert.equal(img, b.base + '/missing-photo.png', 'images keep their http(s) address');
  await wait(300); // time for the image to fail
  const marks = await js('({ ...document.documentElement.dataset })');
  assert.deepEqual(marks, {}, 'neither the inline script nor the onerror handler ran');
});

test('the reader page has no bridge and no storage', async () => {
  const probe = await js(`(() => {
    let storage = 'available';
    try { localStorage.setItem('x', '1'); } catch { storage = 'blocked'; }
    let cookie;
    try { document.cookie = 'a=1'; cookie = document.cookie; } catch { cookie = 'blocked'; }
    return { loui: typeof loui, require: typeof require, process: typeof process, origin: location.origin, storage, cookie };
  })()`);
  assert.deepEqual(probe, { loui: 'undefined', require: 'undefined', process: 'undefined', origin: 'null', storage: 'blocked', cookie: probe.cookie === 'blocked' ? 'blocked' : '' });
});

test('text size, width and typeface are set from the page and kept in settings.json', async () => {
  const size = () => js('getComputedStyle(document.body).fontSize');
  assert.equal(await size(), '20px');
  // The page's own controls are links that Loui catches; no script involved.
  await js(`document.querySelector('a[data-set="size=up"]').click()`);
  await until('text grows', async () => (await size()) === '22px');
  const width = () => js(`parseFloat(getComputedStyle(document.querySelector('main')).maxWidth)`);
  const before = await width();
  await js(`document.querySelector('a[data-set="width=wide"]').click()`);
  await until('the column widens', async () => (await width()) > before);
  await js(`document.querySelector('a[data-set="face=serif"]').click()`);
  await until('the type turns serif', async () => (await js('getComputedStyle(document.body).fontFamily')).includes('Georgia'));
  assert.equal(await js('location.protocol'), 'loui-reader:', 'still in reader view');
  const saved = JSON.parse(fs.readFileSync(path.join(b.home, 'settings.json'), 'utf8'));
  assert.deepEqual(saved.reader, { size: 3, width: 'wide', face: 'serif' });
  await b.ui('reader:set', 'size=down');
  await until('text shrinks back', async () => (await size()) === '20px');
});

test('Back returns to the page, and Forward to reader view', async () => {
  await b.ui('back');
  await until('the page is back', async () => (await js('location.protocol').catch(() => '')) === 'http:');
  assert.equal((await onScreen()).url, b.base + '/article.html');
  await until('reader view is off and offered again', async () => {
    const r = await reader();
    return !r.on && r.can;
  });
  await b.ui('forward');
  await until('reader view again', async () => (await reader()).on);
  assert.match(await js('document.body.innerText'), /keepers wrote everything down/);
  // The button leaves it too, by going back.
  await b.ui('reader:toggle');
  await until('the page is back', async () => !(await reader()).on && (await js('location.protocol').catch(() => '')) === 'http:');
});

test('a page cannot send itself to a reader address', async () => {
  await js(`location.href = 'loui-reader:set?size=up'`);
  await wait(400);
  assert.equal(await js('location.protocol'), 'http:');
  const saved = JSON.parse(fs.readFileSync(path.join(b.home, 'settings.json'), 'utf8'));
  assert.equal(saved.reader.size, 2);
});

test('read_article gives a session the article text from its own tab', async () => {
  await page('/plain.html'); // the user's tab is elsewhere
  const s = b.as('reader-s', 'Reader');
  await s.text('navigate', { url: b.base + '/article.html' });
  const out = await s.text('read_article');
  assert.match(out, /^Title: The Lighthouse Keepers of Ushant$/m);
  assert.match(out, /^By: .*Marguerite Penhoat/m);
  assert.match(out, new RegExp(`^URL: ${b.base}/article\\.html$`, 'm'));
  assert.match(out, /^## A day in the tower$/m);
  assert.match(out, /^- Wind the clockwork every two hours$/m);
  assert.match(out, new RegExp(`keepers' own accounts \\(${b.base}/second\\.html\\)`));
  assert.doesNotMatch(out, /Sponsored|Copyright the fixture|hidden field|Send it/);
  assert.doesNotMatch(out, /Sign in/, "the user's tab is not read");
  // The session's tab is never offered the button: it is the user's to use.
  const tab = (await b.state()).tabs.find((t) => t.group === 'reader-s');
  await b.ui('tab:select', tab.id);
  assert.equal((await reader()).can, false);
  s.end();
});

test('read_article says so on a page with no article, and works while the session is paused', async () => {
  const s = b.as('reader-p', 'Reader 2');
  await s.text('navigate', { url: b.base + '/plain.html' });
  await assert.rejects(s.text('read_article'), /no article/);
  await s.text('navigate', { url: b.base + '/article.html' });
  await b.ui('pause', { group: 'reader-p', on: true });
  assert.match(await s.text('read_article'), /keepers wrote everything down/);
  await assert.rejects(s.text('scroll', { direction: 'down' }), /paused/, 'acting is still refused');
  s.end();
});
