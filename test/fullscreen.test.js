// A page that asks for the whole screen (a video's full-screen button) gets
// the whole window: Loui's tabs, toolbar and panel are covered until it lets
// go. F11 does the same for the tab on screen. A tab in the background is
// told no.
const test = require('node:test');
const assert = require('node:assert/strict');
const { launch } = require('./drive');

let b;
test.before(async () => { b = await launch(); });
test.after(async () => { await b?.close(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what, ms = 8000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
    const got = await check();
    if (got) return got;
  }
  assert.fail(`timed out waiting for ${what}`);
}
const onScreen = async () => (await b.state()).tabs.find((t) => t.active);
const place = (id) => b.ui('tab:place', id);
const covers = (p) => p.view.x === 0 && p.view.y === 0 && p.view.width === p.window.width && p.view.height === p.window.height;
const press = (id) => b.ui('tab:press', { id, x: 200, y: 200 }); // a real press: full screen needs one

let tab;
test('a page that asks for the whole screen covers the tabs and the toolbar, and gives them back', async () => {
  await b.ui('go', b.base + '/fullscreen.html');
  tab = await until(async () => { const t = await onScreen(); return t.title === 'Full screen' && !t.loading && t; }, 'the page');
  const before = await place(tab.id);
  assert.ok(before.view.y > 0 && !covers(before), 'under the toolbar to begin with');
  await press(tab.id);
  const full = await until(async () => { const p = await place(tab.id); return p.full && covers(p) && p; }, 'the page to cover the window');
  assert.equal(await b.ui('tab:js', { id: tab.id, code: '!!document.fullscreenElement' }), true);
  assert.deepEqual(full.view, { x: 0, y: 0, width: full.window.width, height: full.window.height });
  await press(tab.id); // the page lets go
  const after = await until(async () => { const p = await place(tab.id); return !p.full && !covers(p) && p; }, 'the toolbar back');
  assert.equal(after.view.y, before.view.y);
});

test('showing another tab ends it', async () => {
  await press(tab.id);
  await until(async () => (await place(tab.id)).full, 'full screen');
  await b.ui('tab:new', b.base + '/second.html');
  const other = await until(async () => { const t = await onScreen(); return t.id !== tab.id && !t.loading && t; }, 'the new tab');
  assert.ok(!covers(await place(other.id)), 'the new tab sits under the toolbar');
  await until(async () => (await b.ui('tab:js', { id: tab.id, code: '!document.fullscreenElement' })), 'the first page to be told');
  assert.equal((await place(tab.id)).full, false);
});

test('a tab in the background is told no', async () => {
  // The page is not on screen: its press still reaches it, as a session's would.
  await press(tab.id);
  await sleep(600);
  assert.equal(await b.ui('tab:js', { id: tab.id, code: '!!document.fullscreenElement' }), false);
  const other = await onScreen();
  assert.ok(!covers(await place(other.id)));
});

test('F11 gives the tab on screen the whole window, and F11 again gives Loui\'s parts back', async () => {
  const shown = await onScreen();
  await b.ui('menu:key', 'F11');
  await until(async () => { const p = await place(shown.id); return p.wide && covers(p); }, 'the page to cover the window');
  await b.ui('menu:key', 'F11');
  await until(async () => { const p = await place(shown.id); return !p.wide && !covers(p); }, 'the toolbar back');
});
