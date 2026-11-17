// The user's tabs come back after a restart, and closed tabs can be reopened.
// Claude sessions' tabs do not come back: their sessions are over.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launch } = require('./drive');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'loui-test-'));
let b;
test.after(async () => {
  await b?.close();
  fs.rmSync(home, { recursive: true, force: true });
});

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const mine = async () => (await b.state()).tabs.filter((t) => t.group === 'you');
// Waits until the user's tabs have finished loading.
async function settled() {
  for (let i = 0; i < 50; i++) {
    const list = await mine();
    if (list.every((t) => !t.loading)) return list;
    await pause(100);
  }
  return mine();
}

let first;
test('before quitting: the user has two tabs, one on a phone size, and a session has a tab', async () => {
  b = await launch({}, { home });
  first = b.base;
  const blank = (await mine())[0];
  await b.ui('tab:new', first);
  await settled();
  await b.ui('go', first + '/second.html'); // this tab now has history to go back to
  await b.ui('tab:new', first + '/second.html?b');
  await settled();
  await b.ui('tab:close', blank.id);

  // Lend the tab on screen to a session, give it a phone size, take it back.
  const c = b.as('c', 'Claude Desktop');
  const asked = c.text('request_tab');
  await pause(300);
  await b.ui('handoff:answer', true);
  await asked;
  await c.text('set_viewport', { preset: 'iphone' });
  await b.as('s', 'Claude Code').text('navigate', { url: first + '/index.html?session' });
  c.end();
  await pause(300);

  const tabs = await settled();
  await b.ui('tab:select', tabs[0].id);
  const now = await mine();
  assert.deepEqual(now.map((t) => t.url), [first + '/second.html', first + '/second.html?b']);
  assert.equal(now[1].device, 'iPhone');
  assert.ok(now[0].active);
});

test('after quitting and reopening, the user\'s tabs come back as they were', async () => {
  await b.close(); // quits cleanly right after the last change
  fs.rmSync(path.join(home, 'loui.sock'), { force: true }); // else launch may find the old one
  b = await launch({}, { home });
  const state = await b.state();
  assert.deepEqual(state.groups.map((g) => g.id), ['you'], 'no session groups come back');
  const tabs = await settled();
  assert.deepEqual(tabs.map((t) => t.url), [first + '/second.html', first + '/second.html?b']);
  assert.ok(tabs[0].active, 'the same tab is on screen');
  assert.ok(tabs[0].canGoBack, 'with its history');
  assert.equal(tabs[1].device, 'iPhone', 'and its device size');
});

test('Ctrl+Shift+T reopens closed tabs, most recent first, where they were', async () => {
  for (const t of await mine()) await b.ui('tab:close', t.id);
  await b.ui('tab:new', b.base);
  await settled();
  await b.ui('go', b.base + '/second.html');
  await b.ui('tab:new', b.base + '/index.html?two');
  await b.ui('tab:new', b.base + '/index.html?three');
  let tabs = await settled();
  const urls = tabs.map((t) => t.url);
  const [, one, two] = tabs; // tabs[0] is the blank tab left when the others closed

  await b.ui('tab:close', two.id);
  await b.ui('tab:close', one.id);
  assert.equal((await mine()).length, 2);

  await b.ui('tab:reopen');
  tabs = await settled();
  assert.equal(tabs.find((t) => t.active).url, b.base + '/second.html');
  assert.ok(tabs.find((t) => t.active).canGoBack, 'with its history');
  await b.ui('tab:reopen');
  tabs = await settled();
  assert.equal(tabs.find((t) => t.active).url, b.base + '/index.html?two');
  assert.deepEqual(tabs.map((t) => t.url), urls, 'each back in its place');

  await b.ui('tab:reopen'); // the restored tabs closed earlier come back next
  assert.equal((await mine()).length, 5);
});

test('a session\'s closed tabs cannot be reopened', async () => {
  const s = b.as('s2');
  await s.text('navigate', { url: b.base + '/index.html?session' });
  const id = +(await s.text('tabs', { action: 'list' })).match(/> (\d+)/)[1];
  await s.text('tabs', { action: 'new', url: b.base });
  await s.text('tabs', { action: 'close', id });
  const before = (await b.state()).tabs.length;
  await b.ui('tab:reopen');
  const after = (await b.state()).tabs;
  assert.equal(after.length, before + 1);
  assert.ok(!after.some((t) => t.url.endsWith('?session')));
});
