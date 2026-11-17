// Words typed in the address bar go to the search engine the user chose:
// Brave Search unless they pick another, or an address of their own with %s.
// The choice is kept in settings.json and survives a restart.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launch } = require('./drive');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'loui-test-'));
let b;
test.before(async () => { b = await launch({}, { home }); });
test.after(async () => {
  await b.close();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const saved = () => JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'));

test('Brave Search is the default', async () => {
  assert.equal((await b.state()).search.engine, 'brave');
  assert.equal(await b.ui('to-url', 'hello world'), 'https://search.brave.com/search?q=hello%20world');
  assert.equal(await b.ui('to-url', 'example.com'), 'https://example.com', 'addresses are still addresses');
});

test('another engine can be chosen, and is kept', async () => {
  for (const [engine, url] of [
    ['duckduckgo', 'https://duckduckgo.com/?q=a%26b'],
    ['kagi', 'https://kagi.com/search?q=a%26b'],
    ['google', 'https://www.google.com/search?q=a%26b'],
  ]) {
    await b.ui('search:set', { engine });
    assert.equal(await b.ui('to-url', 'a&b'), url);
  }
  assert.equal((await b.state()).search.engine, 'google');
  assert.equal(saved().search, 'google');
});

test('a custom address searches with the words in place of %s', async () => {
  await b.ui('search:set', { engine: 'custom', url: 'ftp://example.com/?q=%s' });
  await b.ui('search:set', { engine: 'custom', url: 'https://example.com/search' });
  assert.equal((await b.state()).search.engine, 'google', 'addresses that are not web pages or lack %s are ignored');

  const custom = `${b.base}/second.html?q=%s`;
  await b.ui('search:set', { engine: 'custom', url: custom });
  assert.equal((await b.state()).search.engine, 'custom');
  assert.equal(saved().searchUrl, custom);
  await b.ui('go', 'find me');
  let tab;
  for (let i = 0; i < 50 && tab?.url !== `${b.base}/second.html?q=find%20me`; i++) {
    await sleep(100);
    tab = (await b.state()).tabs.find((t) => t.active);
  }
  assert.equal(tab.url, `${b.base}/second.html?q=find%20me`);
});

test('File › Settings shows the engines, the choice, and the sites that open in Brave', async () => {
  await b.ui('chrome:eval', 'showSettings(true)');
  const sheet = await b.ui('chrome:eval', `({
    hidden: document.getElementById('settings').hidden,
    engines: [...document.querySelectorAll('#search-engine option')].map((o) => o.textContent),
    chosen: document.getElementById('search-engine').value,
    custom: document.getElementById('search-url').value,
    sites: [...document.querySelectorAll('#elsewhere-list .site')].map((s) => s.textContent),
  })`);
  assert.deepEqual(sheet, {
    hidden: false,
    engines: ['Brave Search', 'DuckDuckGo', 'Google', 'Kagi', 'Custom address'],
    chosen: 'custom',
    custom: `${b.base}/second.html?q=%s`,
    sites: ['accounts.google.com'],
  });
  await b.ui('chrome:eval', 'showSettings(false)');
});

test('the choice survives a restart', async () => {
  await b.close();
  b = await launch({}, { home });
  const { search } = await b.state();
  assert.equal(search.engine, 'custom');
  assert.equal(await b.ui('to-url', 'x y'), search.custom.replace('%s', 'x%20y'));
});
