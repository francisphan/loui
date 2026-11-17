// Watching a session in a small window (picture in picture): opened from a
// session's tab menu; pictures of its current tab while the page changes and
// none while it is still or the window is hidden; its status; Take over;
// following a new tab; showing the tab; the session ending; a locked page
// with a narrow bridge; and no capture at all once closed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { launch } = require('./drive');

let b;
test.before(async () => { b = await launch(); });
test.after(async () => { await b?.close(); });

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, ok, ms = 15000) {
  let last;
  for (const end = Date.now() + ms; Date.now() < end; await pause(100)) {
    last = await what();
    if (ok(last)) return last;
  }
  assert.fail(`gave up waiting; last saw ${JSON.stringify(last)}`);
}
const pip = () => b.ui('pip:state');
const js = (code) => b.ui('pip:js', code);
const shows = () => js(`({
  label: document.getElementById('pip-label').textContent,
  status: document.getElementById('pip-status').textContent,
  button: document.getElementById('pip-pause').textContent,
  ended: !document.getElementById('pip-ended').hidden,
  picture: (document.getElementById('pip-frame').getAttribute('src') || '').slice(0, 23),
})`);
const ref = (outline, start) => {
  const line = outline.split('\n').find((l) => l.trim().startsWith(start));
  assert.ok(line, `no "${start}" in:\n${outline}`);
  return line.match(/\[(e\d+)\]/)[1];
};
const groupTabs = async (id) => (await b.state()).tabs.filter((t) => t.group === id);

let w, outline;

test('a session\'s tab menu opens the small window, which shows the session\'s tab', async () => {
  w = b.as('w', 'Claude Code · pip');
  outline = await w.text('navigate', { url: b.base + '/pip.html' });
  const [tab] = await groupTabs('w');
  const mine = (await b.state()).tabs.find((t) => t.group === 'you');
  assert.ok(!(await b.ui('pip:menu', { id: mine.id })).includes('Watch in a small window'), 'nothing to watch on the user\'s own tab');
  assert.ok((await b.ui('pip:menu', { id: tab.id, click: 'Watch in a small window' })).includes('Watch in a small window'));
  const s = await until(pip, (p) => p.open && p.sent > 0);
  assert.equal(s.group, 'w');
  assert.equal(s.watching, tab.id);
  const seen = await until(shows, (v) => v?.picture === 'data:image/jpeg;base64,');
  assert.equal(seen.label, 'Claude Code · pip');
  assert.equal(seen.button, 'Take over');
  assert.ok((await b.state()).tabs.find((t) => t.active).group === 'you', 'the user stays in their own tab');
});

test('pictures come while the page changes, at most five a second, and stop when it is still', async () => {
  // The session presses the page's buttons with evaluate: a click would also
  // draw Claude's pointer, which fades out seconds later and is a change too.
  const settle = async () => {
    let last = -1;
    await until(async () => { const now = (await pip()).sent; const same = now === last; last = now; await pause(700); return same; }, Boolean);
    const s = await pip();
    assert.ok(s.subscribed && !s.waiting, 'still: subscribed, waiting for the page to paint');
    await pause(1500);
    assert.equal((await pip()).sent, s.sent, 'a still page sends nothing');
  };
  await settle();

  await w.text('evaluate', { code: 'document.getElementById("spin").click()' });
  const start = (await pip()).sent;
  await pause(2000);
  const moving = (await pip()).sent - start;
  assert.ok(moving >= 3, `pictures while the page moves: ${moving}`);
  assert.ok(moving <= 12, `no more than about five a second: ${moving} in 2 s`);

  await w.text('evaluate', { code: 'document.getElementById("still").click()' });
  await settle();
});

test('nothing is captured while the window is hidden', async () => {
  await w.text('evaluate', { code: 'document.getElementById("spin").click()' });
  await b.ui('pip:hide');
  await until(pip, (p) => !p.subscribed && !p.waiting);
  const hidden = (await pip()).sent;
  await pause(1200);
  const s = await pip();
  assert.equal(s.sent, hidden, 'no pictures while hidden');
  assert.equal(s.subscribed, false);
  await b.ui('pip:show');
  await until(pip, (p) => p.sent > hidden);
  await w.text('evaluate', { code: 'document.getElementById("still").click()' });
});

test('the status follows what the session is doing', async () => {
  const waiting = w.text('wait_for', { text: 'Never on this page', seconds: 3 }).catch(() => {});
  await until(shows, (v) => v.status === 'Waiting for "Never on this page"');
  await waiting;
  await until(shows, (v) => v.status === 'Not acting right now');
});

test('Take over pauses the session; Let Claude continue hands it back', async () => {
  await js('document.getElementById("pip-pause").click()');
  await until(async () => (await b.state()).groups.find((g) => g.id === 'w'), (g) => g.paused);
  await assert.rejects(w.text('click', { ref: ref(outline, 'button "Step"') }), /taken over this tab group/);
  const seen = await until(shows, (v) => v.button === 'Let Claude continue');
  assert.equal(seen.status, "Paused. You're driving.");
  await js('document.getElementById("pip-pause").click()');
  await until(async () => (await b.state()).groups.find((g) => g.id === 'w'), (g) => !g.paused);
  assert.match(await w.text('click', { ref: ref(outline, 'button "Step"') }), /Clicked/i);
});

test('it follows the session to a new tab, and a click shows that tab in the window', async () => {
  const sent = (await pip()).sent;
  await w.text('tabs', { action: 'new', url: b.base + '/second.html' });
  const fresh = (await groupTabs('w')).find((t) => t.current);
  await until(pip, (p) => p.watching === fresh.id && p.sent > sent);
  await js('document.getElementById("pip-view").click()');
  await until(async () => (await b.state()).tabs.find((t) => t.active), (t) => t.id === fresh.id);
  await b.ui('tab:select', (await b.state()).tabs.find((t) => t.group === 'you').id);
});

test('the page is Loui\'s own, locked, with only its narrow bridge', async () => {
  assert.match(await b.ui('pip:url'), /src\/ui\/pip\.html$/);
  assert.deepEqual(await js('Object.keys(window.loui).sort()'), ['act', 'onFrame', 'onUpdate', 'size']);
  assert.equal(await js('typeof require'), 'undefined');
  assert.equal(await js('window.open("https://example.com") === null'), true);
  await js(`location.href = ${JSON.stringify(b.base)}`).catch(() => {});
  await pause(500);
  assert.match(await b.ui('pip:url'), /src\/ui\/pip\.html$/, 'it cannot be navigated away');
});

test('it keeps where it was put, snapping to an edge it is dropped near', async () => {
  await b.ui('pip:place', { x: 300, y: 200, width: 400, height: 300 });
  await until(() => fs.promises.readFile(path.join(b.home, 'settings.json'), 'utf8').then(JSON.parse).catch(() => ({})),
    (s) => s.pip?.x === 300 && s.pip?.y === 200 && s.pip?.width === 400);
  await b.ui('pip:place', { x: 5, y: 210, width: 400, height: 300 });
  await until(pip, (p) => p.bounds.x === 16);
  await b.ui('pip:close');
  await until(pip, (p) => !p.open);
  await b.ui('pip:open', 'w');
  const s = await until(pip, (p) => p.open && p.bounds);
  assert.deepEqual(s.bounds, { x: 16, y: 210, width: 400, height: 300 });
});

test('when the session ends the window says so and closes itself, capturing nothing', async () => {
  await until(pip, (p) => p.sent > 0 && p.subscribed);
  w.end();
  const seen = await until(shows, (v) => v?.ended);
  assert.equal(seen.status, 'Session ended');
  assert.equal(seen.label, 'Claude Code · pip', 'still named');
  const s = await pip();
  assert.equal(s.subscribed, false);
  assert.equal(s.watching, null);
  await until(pip, (p) => !p.open, 8000);
});

test('closing the window stops all capture', async () => {
  const v = b.as('v', 'Claude Code · close');
  await v.text('navigate', { url: b.base + '/pip.html' });
  const before = (await pip()).sent;
  await b.ui('pip:open', 'v');
  await until(pip, (p) => p.open && p.sent > before);
  // The window closes under the script, which may then never answer.
  await js('document.getElementById("pip-close").click()').catch(() => {});
  const s = await until(pip, (p) => !p.open);
  assert.equal(s.subscribed, false);
  assert.equal(s.waiting, false);
  assert.equal(s.watching, null);
  v.end();
});
