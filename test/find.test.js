// Find in page: the find bar searches the tab on screen, steps through the
// matches, follows the user to another tab, and closes when the page changes.
const test = require('node:test');
const assert = require('node:assert/strict');
const { launch } = require('./drive');

let b;
test.before(async () => { b = await launch(); });
test.after(async () => { await b.close(); });

const found = async () => (await b.state()).find;
// Waits for the find bar to settle on a result, then returns it.
async function settle(want) {
  let last;
  for (let i = 0; i < 50; i++) {
    last = await found();
    if (want(last)) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`find bar never settled; last state ${JSON.stringify(last)}`);
}
const counted = (f) => f.matches != null && (f.matches === 0 || f.active > 0);
const onScreen = async () => (await b.state()).tabs.find((t) => t.active);
// Opens a fixture page in the user's own tab on screen, as typing it in the address bar does.
async function page(path = '/') {
  await b.ui('go', b.base + path);
  for (let i = 0; i < 50; i++) {
    const tab = await onScreen();
    if (!tab.loading && tab.url === b.base + path) return tab;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`${path} did not load`);
}
const open = () => b.ui('find:open');

test('the find bar starts closed, and Ctrl+F opens it', async () => {
  await page();
  assert.equal((await found()).open, false);
  await open();
  assert.equal((await found()).open, true);
});

test('typing counts the matches and goes to the first', async () => {
  await b.ui('find', { text: 'page' });
  const f = await settle(counted);
  assert.equal(f.matches, 3, 'Fixture page, Second page, Far down the page');
  assert.equal(f.active, 1);
});

test('Enter and Shift+Enter go to the next and previous match, and wrap around', async () => {
  await b.ui('find', { text: 'page', forward: true, again: true });
  assert.equal((await settle((f) => f.active === 2)).matches, 3);
  await b.ui('find', { text: 'page', forward: false, again: true });
  await settle((f) => f.active === 1);
  await b.ui('find', { text: 'page', forward: false, again: true });
  await settle((f) => f.active === 3);
});

test('text that is not on the page has no matches', async () => {
  await b.ui('find', { text: 'zebra crossing' });
  assert.equal((await settle(counted)).matches, 0);
  await b.ui('find', { text: '' });
  assert.equal((await found()).matches, 0);
});

test('Esc closes the bar and clears the highlight', async () => {
  await b.ui('find', { text: 'link' });
  assert.equal((await settle(counted)).matches, 2);
  await b.ui('find:close');
  assert.deepEqual(await found(), { open: false, text: '', matches: 0, active: 0 });
});

test('it follows the tab on screen when the user switches tabs', async () => {
  const first = (await onScreen()).id;
  await b.ui('tab:new');
  const second = (await page('/second.html')).id;
  await b.ui('tab:select', first);
  await open();
  await b.ui('find', { text: 'page' });
  assert.equal((await settle(counted)).matches, 3);
  await b.ui('tab:select', second);
  await settle((f) => f.open && f.text === 'page' && f.matches === 1 && f.active === 1);
  await b.ui('tab:select', first);
  await settle((f) => f.open && f.matches === 3 && f.active === 1);
});

test('it closes when the page navigates', async () => {
  assert.equal((await found()).open, true);
  await page('/second.html');
  assert.equal((await settle((f) => !f.open)).text, '');
});
