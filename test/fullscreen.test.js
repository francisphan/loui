// A page that asks for the whole screen (a video's full-screen button) gets
// the whole window: Loui's tabs, toolbar and panel are covered until it lets
// go. F11 does the same for the tab on screen. A tab in the background is
// told no, and so is a page whose click came from a Claude session. Loui says
// over the page whose it is and how to leave, and a question for the window
// ends the full screen.
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
// The page itself is out of full screen (it follows the window by a moment): only then does its button ask again.
const settled = (id) => until(() => b.ui('tab:js', { id, code: '!document.fullscreenElement' }), 'the page to be out of full screen');

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
  await settled(tab.id);
});

test('showing another tab ends it', async () => {
  await press(tab.id);
  await until(async () => (await place(tab.id)).full, 'full screen');
  await b.ui('tab:new', b.base + '/second.html');
  const other = await until(async () => { const t = await onScreen(); return t.id !== tab.id && !t.loading && t; }, 'the new tab');
  assert.ok(!covers(await place(other.id)), 'the new tab sits under the toolbar');
  await settled(tab.id);
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

// Loui's own note in front of the page (hints.js).
const hint = () => b.ui('hint');
const noted = (how) => until(async () => { const h = await hint(); return h.shown === 'full' && how.test(h.text) && h; }, `the note (${how})`);

test('over a page in full screen Loui says whose it is and how to leave, and again when the pointer touches the top', async () => {
  const shown = await onScreen();
  await b.ui('menu:key', 'F11');
  const note = await noted(/^127\.0\.0\.1:\d+\s+F11 to leave full screen$/);
  assert.ok(note.inFront, 'in front of the page');
  assert.equal(note.bounds.y, 0, 'at the top');
  // In the middle, also once the window has taken the screen (which it does a moment after).
  await until(async () => {
    const [{ bounds }, { window }] = [await hint(), await place(shown.id)];
    return Math.abs(bounds.x + bounds.width / 2 - window.width / 2) <= 1;
  }, 'the note to be in the middle of the window');
  await until(async () => !(await hint()).shown, 'the note to go after a few seconds', 6000);
  await b.ui('hint:top', shown.id); // the pointer at the top edge
  await noted(/F11 to leave/);
  await b.ui('menu:key', 'F11');
  await until(async () => !(await hint()).shown && !(await place(shown.id)).wide, 'the note to go with the full screen');
  // What the page asked for, Esc ends.
  await b.ui('tab:select', tab.id);
  await press(tab.id);
  await until(async () => (await place(tab.id)).full, 'full screen');
  await noted(/^127\.0\.0\.1:\d+\s+Esc to leave full screen$/);
  await press(tab.id);
  await until(async () => !(await place(tab.id)).full && !(await hint()).shown, 'the toolbar back, and the note gone');
  await settled(tab.id);
});

test('a click from a Claude session cannot take the screen; the user\'s own click in the same tab can', async () => {
  const s = b.as('fs', 'Claude Code');
  await s.call('navigate', { url: b.base + '/fullscreen.html' });
  const theirs = (await b.state()).tabs.find((t) => t.group === 'fs');
  await b.ui('tab:select', theirs.id); // on screen, so only whose click it is stands in the way
  await s.call('click', { x: 200, y: 200 });
  await sleep(700);
  assert.equal(await b.ui('tab:js', { id: theirs.id, code: '!!document.fullscreenElement' }), false);
  assert.ok(!covers(await place(theirs.id)), 'the page is still under the toolbar');
  await press(theirs.id);
  await until(async () => { const p = await place(theirs.id); return p.full && covers(p); }, 'the user\'s click to be honoured');
  await press(theirs.id);
  await until(async () => !(await place(theirs.id)).full, 'the toolbar back');
  await settled(theirs.id);
});

test('a question for the window ends full screen of either kind, so that it is seen', async () => {
  const s = b.as('fs', 'Claude Code');
  const answer = async () => {
    const { prompt } = await until(async () => { const st = await b.state(); return st.prompt && st; }, 'the question');
    assert.equal(prompt.kind, 'handoff');
    await b.ui('prompt:answer', { id: prompt.id, value: false });
  };
  // F11.
  await b.ui('tab:select', tab.id);
  await b.ui('menu:key', 'F11');
  await until(async () => (await place(tab.id)).wide, 'full screen');
  let asked = s.call('request_tab').catch(() => {});
  await until(async () => { const p = await place(tab.id); return !p.wide && !covers(p); }, 'the question to end the full screen');
  await answer();
  await asked;
  // The page's own.
  await press(tab.id);
  await until(async () => (await place(tab.id)).full, 'full screen');
  asked = s.call('request_tab').catch(() => {});
  await until(async () => { const p = await place(tab.id); return !p.full && !covers(p); }, 'the question to end the full screen');
  await settled(tab.id);
  await answer();
  await asked;
  s.end();
});
