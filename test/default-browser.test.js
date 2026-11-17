// Links from other apps: Loui started with a link opens it in a tab of the
// user's; a link opened while Loui runs reaches the running Loui through a
// second launch, which quits; anything on the command line that is not an
// http(s) address or a local .html file is ignored, switches above all.
// (The Windows registry entries are in build/installer.nsh and are not tested
// here.)
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const { launch, again } = require('./drive');
const { accept } = require('../src/main/default-browser');

const fixture = path.join(__dirname, 'fixture');
let b;
test.before(async () => {
  b = await launch({}, {
    args: (base) => [base + '/second.html', '--loui-test-switch=https://example.com/', 'javascript:alert(1)', 'ftp://example.com/'],
  });
});
test.after(async () => { await b?.close(); });

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, ok, ms = 15000) {
  let last;
  for (const end = Date.now() + ms; Date.now() < end; await pause(200)) {
    last = await what();
    if (ok(last)) return last;
  }
  assert.fail(`gave up waiting; last saw ${JSON.stringify(last)}`);
}
const tabs = async () => (await b.state()).tabs;

test('only http(s) addresses and existing local .html files are taken from the command line', () => {
  const page = path.join(fixture, 'second.html');
  assert.equal(accept('https://example.com/a?b=c', '/'), 'https://example.com/a?b=c');
  assert.equal(accept('HTTP://Example.com', '/'), 'http://example.com/');
  assert.equal(accept(page, '/'), pathToFileURL(page).href);
  assert.equal(accept('second.html', fixture), pathToFileURL(page).href, 'relative to where it was started');
  assert.equal(accept(pathToFileURL(page).href, '/'), pathToFileURL(page).href);
  for (const bad of [
    '--gpu-launcher=calc.exe', '--user-data-dir=https://example.com/', '-x', '--', 'javascript:alert(1)',
    'file:///etc/passwd', '/etc/hostname', path.join(fixture, 'missing.html'), 'ftp://example.com/',
    'mailto:a@example.com', 'data:text/html,<h1>hi</h1>', 'notes.txt', fixture, 'http://', '',
  ]) {
    assert.equal(accept(bad, fixture), null, bad);
  }
});

test('Loui started with a link opens it in a tab of the user\'s, on screen, and ignores the rest', async () => {
  const list = await until(tabs, (l) => l.some((t) => t.url === b.base + '/second.html' && !t.loading));
  const shown = list.find((t) => t.active);
  assert.equal(shown.url, b.base + '/second.html');
  assert.equal(shown.group, 'you');
  assert.equal(list.length, 1, 'no blank tab besides it, nothing for the other arguments');
});

test('a link opened while Loui runs opens in a new tab of the running Loui', async () => {
  const before = (await tabs()).length;
  assert.equal(await again(b.home, [b.base + '/index.html?from-another-app']), 0, 'the second launch quits');
  const list = await until(tabs, (l) => l.some((t) => t.url === b.base + '/index.html?from-another-app'));
  assert.equal(list.length, before + 1);
  const opened = list.find((t) => t.url === b.base + '/index.html?from-another-app');
  assert.ok(opened.active, 'on screen');
  assert.equal(opened.group, 'you');
});

test('a local .html file opens too', async () => {
  const page = path.join(fixture, 'second.html');
  await again(b.home, [page]);
  const list = await until(tabs, (l) => l.some((t) => t.url === pathToFileURL(page).href && !t.loading));
  assert.equal(list.find((t) => t.active).title, 'Second');
});

test('a second launch with no link, or only things that are not links, opens nothing', async () => {
  const before = (await tabs()).map((t) => t.id);
  assert.equal(await again(b.home, []), 0);
  assert.equal(await again(b.home, [
    '--loui-test-switch=https://example.com/', 'javascript:alert(1)', 'file:///etc/passwd', '/etc/hostname', 'mailto:a@example.com',
  ]), 0);
  await pause(1500);
  assert.deepEqual((await tabs()).map((t) => t.id), before);
});
