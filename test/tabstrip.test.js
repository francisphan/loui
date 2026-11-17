// The tab strip: tabs reorder by dragging and from the keyboard, a tab dragged
// onto a session's group is handed to it and dragged back is taken back,
// pinned tabs, and vertical tabs in a sidebar.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launch } = require('./drive');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'loui-test-'));
fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ sleepAfterMinutes: 0.05 }));
let b;
test.before(async () => { b = await launch({}, { home }); });
test.after(async () => {
  await b?.close();
  try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {} // helper processes may still be closing files
});

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const mine = async () => (await b.state()).tabs.filter((t) => t.group === 'you');
const ids = (list) => list.map((t) => t.id);
const chrome = (code) => b.ui('chrome:eval', code);
async function until(what, ok, ms = 10000) {
  let last;
  for (const end = Date.now() + ms; Date.now() < end; await pause(100)) {
    last = await what();
    if (ok(last)) return last;
  }
  assert.fail(`gave up waiting; last saw ${JSON.stringify(last)}`);
}
// The tab strip as drawn: the ids in each run of tabs, by the group it belongs to.
const drawn = () => chrome(`[...document.querySelectorAll('#tabs [data-group]')].map((z) =>
  [z.dataset.group, [...z.querySelectorAll('.tab')].map((t) => +t.dataset.id)])`);

// Drags tab `from` in the window chrome and drops it on tab `to`, on its
// start (side 'before') or its end ('after'), the way a mouse would: the
// same drag events at the same points.
function drag(from, to, side = 'before') {
  return chrome(`(async () => {
    const tab = (id) => document.querySelector('#tabs .tab[data-id="' + id + '"]');
    const source = tab(${from}), target = tab(${to});
    const r = target.getBoundingClientRect();
    const vertical = document.body.classList.contains('vertical') && !target.closest('.pins');
    const at = ${JSON.stringify(side)} === 'before'
      ? (vertical ? { x: r.left + r.width / 2, y: r.top + 3 } : { x: r.left + 3, y: r.top + r.height / 2 })
      : (vertical ? { x: r.left + r.width / 2, y: r.bottom - 3 } : { x: r.right - 3, y: r.top + r.height / 2 });
    const dataTransfer = new DataTransfer();
    const fire = (node, type) => {
      const e = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer, clientX: at.x, clientY: at.y });
      node.dispatchEvent(e);
      return e.defaultPrevented;
    };
    fire(source, 'dragstart');
    const over = document.elementFromPoint(at.x, at.y);
    const allowed = fire(over, 'dragover');
    const shown = !!document.querySelector('.drop-before, .drop-after');
    if (allowed) fire(over, 'drop');
    fire(source, 'dragend');
    return { allowed, shown };
  })()`);
}

let a; // a Claude session with a tab group
test('the user\'s tabs reorder by dragging', async () => {
  for (const q of ['one', 'two', 'three']) await b.ui('tab:new', `${b.base}/index.html?${q}`);
  a = b.as('a', 'Claude Code · tabs');
  await a.text('navigate', { url: b.base + '/second.html' });
  const [blank, one, two, three] = await mine();
  const done = await drag(three.id, one.id, 'before');
  assert.deepEqual(done, { allowed: true, shown: true });
  await until(mine, (l) => ids(l).join() === [blank.id, three.id, one.id, two.id].join());
  await drag(blank.id, two.id, 'after');
  await until(mine, (l) => ids(l).join() === [three.id, one.id, two.id, blank.id].join());
  // The strip draws the new order, and the session's group stays after the user's tabs.
  const yours = (z) => z.filter(([g]) => g === 'you').flatMap(([, list]) => list).join();
  const strip = await until(drawn, (z) => yours(z) === [three.id, one.id, two.id, blank.id].join());
  assert.equal(strip[strip.length - 1][0], 'a');
});

test('the keyboard moves the tab on screen: Ctrl+Shift+PageUp and PageDown', async () => {
  const [first, second] = await mine();
  await b.ui('tab:select', second.id);
  // What the View menu's "Move tab left" (Ctrl+Shift+PageUp) and "Move tab right" do.
  await b.ui('tab:nudge', -1);
  await until(mine, (l) => l[0].id === second.id && l[1].id === first.id);
  await b.ui('tab:nudge', 1);
  await until(mine, (l) => l[0].id === first.id && l[1].id === second.id);
  // At the end it stays put.
  await b.ui('tab:select', first.id);
  await b.ui('tab:nudge', -1);
  await pause(200);
  assert.equal((await mine())[0].id, first.id);
});

test('dragging the user\'s tab onto a session\'s group hands it over, and dragging it back takes it back', async () => {
  const [, given] = await mine();
  const theirs = (await b.state()).tabs.find((t) => t.group === 'a');
  const done = await drag(given.id, theirs.id, 'after');
  assert.ok(done.allowed && done.shown);
  await until(() => b.state(), (s) => s.tabs.find((t) => t.id === given.id)?.group === 'a');
  // The session sees it in its group now, after its own tab.
  assert.match(await a.text('tabs', { action: 'list' }), new RegExp(`${theirs.id} [\\s\\S]*${given.id} `));
  const [firstMine] = await mine();
  await drag(given.id, firstMine.id, 'before');
  const back = await until(mine, (l) => l[0].id === given.id);
  assert.equal(back[0].group, 'you');
  assert.ok(!(await a.text('tabs', { action: 'list' })).includes(` ${given.id} `), 'the session no longer has it');
});

test('a session\'s own tabs reorder only within their group, or come to the user as a take-back', async () => {
  await a.text('tabs', { action: 'new', url: b.base + '/index.html?a2' });
  const group = () => b.state().then((s) => s.tabs.filter((t) => t.group === 'a'));
  const [x, y] = await group();
  await drag(y.id, x.id, 'before');
  await until(group, (l) => l[0].id === y.id && l[1].id === x.id);

  // Another session's group is not a place for it.
  const c = b.as('c', 'Claude Desktop');
  await c.text('navigate', { url: b.base + '/second.html?c' });
  const theirs = (await b.state()).tabs.find((t) => t.group === 'c');
  const refused = await drag(y.id, theirs.id, 'before');
  assert.deepEqual(refused, { allowed: false, shown: false });
  assert.equal((await b.state()).tabs.find((t) => t.id === y.id).group, 'a');
  // And the main process refuses it too, however it is asked.
  await b.ui('tab:move', { id: y.id, group: 'c', index: 0 });
  await pause(200);
  assert.equal((await b.state()).tabs.find((t) => t.id === y.id).group, 'a');
  c.end();

  // Among the user's tabs it is taken back.
  const [, second] = await mine();
  await drag(x.id, second.id, 'before');
  const now = await until(mine, (l) => l[1]?.id === x.id);
  assert.equal(now[1].group, 'you');
});

let pinnedId;
test('a pinned tab is small, goes first, and Ctrl+W leaves it open', async () => {
  const list = await mine();
  const last = list[list.length - 1];
  await b.ui('tab:pin', { id: last.id, on: true });
  const after = await until(mine, (l) => l[0].id === last.id && l[0].pinned);
  pinnedId = last.id;
  // The main process knows it is pinned before the strip has redrawn it.
  const width = await until(
    () => chrome(`document.querySelector('.tab[data-id="${last.id}"]').getBoundingClientRect().width`),
    (w) => w < 50,
  );
  const wide = await chrome(`document.querySelector('.tab[data-id="${after[1].id}"]').getBoundingClientRect().width`);
  assert.ok(width < 50 && wide > width * 2, `pinned ${width}px, others ${wide}px`);
  assert.equal(await chrome(`!!document.querySelector('.tab[data-id="${last.id}"] .title')`), false, 'icon only');
  // Dropped among the pinned tabs a tab is pinned there; dropped among the others, unpinned.
  const other = after[2];
  await drag(other.id, last.id, 'before');
  await until(mine, (l) => l[0].id === other.id && l[0].pinned && l[1].id === last.id);
  await drag(other.id, after[1].id, 'after');
  await until(mine, (l) => l[0].id === last.id && l[1].id === after[1].id && l[2].id === other.id && !l[2].pinned);
  // Put ahead of the pinned tabs any other way, an unpinned tab lands right after them.
  await b.ui('tab:move', { id: other.id, group: 'you', index: 0 });
  await until(mine, (l) => l[0].id === last.id && l[1].id === other.id && !l[1].pinned);
  // Ctrl+W on the pinned tab does nothing.
  await b.ui('tab:select', last.id);
  await b.ui('tab:close-active'); // what Ctrl+W does
  await pause(200);
  assert.ok((await mine()).some((t) => t.id === last.id), 'still open');
});

test('a pinned tab never sleeps', async () => {
  await b.ui('tab:new', b.base + '/index.html?front');
  // The profile puts tabs to sleep after 3 s out of sight; others fall asleep, the pinned one does not.
  await until(mine, (l) => l.some((t) => !t.pinned && !t.active && t.asleep), 15000);
  assert.equal((await mine()).find((t) => t.id === pinnedId).asleep, false);
  assert.equal(await b.ui('tab:sleep', pinnedId), false, 'not even when asked');
});

test('vertical tabs: the same tabs and groups in a sidebar, and the page makes room', async () => {
  const stage = () => chrome(`(() => { const r = document.getElementById('stage').getBoundingClientRect(); return { x: r.x, width: r.width }; })()`);
  const before = await stage();
  const strip = await drawn();
  await b.ui('tabs:layout', { vertical: true });
  const side = await until(stage, (s) => s.x > 200);
  assert.ok(side.width < before.width - 200, 'the page area is narrower');
  assert.equal(await chrome(`document.getElementById('tabs').parentElement.id`), 'sidebar');
  assert.deepEqual(await drawn(), strip, 'the same tabs and groups, in the same order');
  const labels = await chrome(`[...document.querySelectorAll('#sidebar .group-name')].map((n) => n.textContent)`);
  assert.deepEqual(labels, ['Claude Code · tabs']);

  // A session's page still renders and takes clicks, placed in the smaller area.
  const page = await a.text('navigate', { url: b.base });
  const field = page.match(/textbox "Your name" \[(e\d+)\]/)[1];
  assert.match(await a.text('type', { ref: field, text: 'Side', clear: true, submit: true }), /Hello, Side/);
  const [, image] = await a.call('screenshot');
  assert.ok(image.data.length > 5000, 'a real picture');

  // Dragging works the same way, top to bottom.
  const list = await mine();
  const [, p, q] = list;
  await drag(q.id, p.id, 'before');
  await until(mine, (l) => l[1].id === q.id && l[2].id === p.id);

  // Collapsed: icons only, and the page gets the room back.
  await b.ui('tabs:layout', { collapsed: true });
  const narrow = await until(stage, (s) => s.x < 80);
  assert.ok(narrow.width > side.width + 150);
  assert.equal(await chrome(`getComputedStyle(document.querySelector('#sidebar .yours .tab .title')).display`), 'none');
});

test('the tab layout and the pinned tabs are remembered after a restart', async () => {
  const before = await mine();
  await pause(1500); // tabs.json is written within a second of a change
  await b.close();
  fs.rmSync(path.join(home, 'loui.sock'), { force: true });
  b = await launch({}, { home });
  const state = await b.state();
  assert.deepEqual(state.tabStrip, { vertical: true, collapsed: true });
  assert.equal(await chrome(`document.getElementById('tabs').parentElement.id`), 'sidebar');
  const after = state.tabs.filter((t) => t.group === 'you');
  assert.equal(after.length, before.length);
  assert.ok(after[0].pinned, 'the pinned tab is back, first');
  assert.equal(after.filter((t) => t.pinned).length, 1);
  assert.equal(after[0].asleep, false, 'and it loads, since it never sleeps');
  // Back to the strip along the top; the page sits right under the toolbar again.
  await b.ui('tabs:layout', { vertical: false });
  await until(() => chrome(`document.getElementById('tabs').parentElement.id`), (p) => p === 'tabrow');
  const gap = await chrome(`(() => {
    const nav = document.getElementById('navrow').getBoundingClientRect();
    const stage = document.getElementById('stage').getBoundingClientRect();
    return [Math.round(stage.top - nav.bottom), Math.round(stage.left)];
  })()`);
  assert.deepEqual(gap, [0, 0]);
});

// ── a full strip, a narrow window ───────────────────────────────────────────
// What is drawn in a row of the window chrome: [name, left, right] of each
// thing that takes room, in the order drawn.
const boxes = (selector) => chrome(`[...document.querySelectorAll(${JSON.stringify(selector)})]
  .map((n) => [n.id || n.className, n.getBoundingClientRect()])
  .filter(([, r]) => r.width > 0).map(([name, r]) => [name, Math.round(r.left), Math.round(r.right)])`);
const size = async (width, height) => {
  await chrome(`window.resizeTo(${width}, ${height})`);
  await until(() => chrome('window.innerWidth'), (w) => Math.abs(w - width) < 4);
};
// Nothing in the row lies over its neighbour or runs out of the row.
function inOrder(list, row) {
  for (let i = 0; i < list.length; i++) {
    const [name, left, right] = list[i];
    assert.ok(left >= row[1] - 1 && right <= row[2] + 1, `${name} (${left}–${right}) is inside the row (${row[1]}–${row[2]})`);
    if (i) assert.ok(left >= list[i - 1][2] - 3, `${name} starts at ${left}, after ${list[i - 1][0]} ends at ${list[i - 1][2]}`);
  }
}
const helmSays = () => chrome(`[...document.getElementById('helm').children]
  .filter((n) => !n.hidden && n.getBoundingClientRect().width > 0).map((n) => n.textContent)`);

let s1, s2, s3;
test('several sessions in a strip short of room: names and tabs give way, and nothing overprints', async () => {
  s1 = b.as('s1', 'Claude Code · release notes for the autumn update');
  s2 = b.as('s2', 'Claude Desktop · quarterly research');
  s3 = b.as('s3', 'Claude Code · agent-b migration');
  await s1.text('navigate', { url: b.base + '/second.html?1' });
  await s1.text('tabs', { action: 'new', url: b.base + '/index.html?1b' });
  await s2.text('navigate', { url: b.base + '/second.html?2' });
  await s3.text('navigate', { url: b.base + '/second.html?3' });
  await size(1240, 800); // with the Claude panel open, about 850px for the tab row
  const theirs = (await b.state()).tabs.find((t) => t.group === 's1');
  await b.ui('tab:select', theirs.id); // a session's tab on screen: the helm shows too
  await until(helmSays, (h) => h.length > 0);

  const [row] = await boxes('#tabrow');
  const [strip] = await boxes('#tabs');
  inOrder(await boxes('#tabs, #newtab, #helm'), row);
  // Within the strip, in the part of it in sight.
  const inside = (await boxes('#tabs .group-tag, #tabs .tab')).filter(([, left, right]) => right > strip[1] && left < strip[2]);
  inOrder(inside, ['', -Infinity, Infinity]);
  const names = await boxes('#tabs .group-name');
  assert.equal(names.length, 3, 'every session has its name in the strip');
  for (const [, left, right] of names) assert.ok(right - left >= 40, `a name keeps ${right - left}px`);
  // The helm keeps its state and its button whole, inside the pill.
  inOrder(await boxes('#helm > *'), (await boxes('#helm'))[0]);
});

test('the helm says the state first, then who, then the button', async () => {
  await until(helmSays, (h) => h[0] === 'Claude\'s tab'); // once its last step has had its moment
  await b.ui('pause', { group: 's1', on: true });
  const paused = await until(helmSays, (h) => h[0] === 'Paused');
  assert.match(paused[1], /^Claude Code · release notes/);
  assert.equal(paused[paused.length - 1], 'Let Claude continue');
  // The state is shown whole however long the session's name is.
  assert.equal(await chrome(`(() => { const n = document.getElementById('helm-state'); return n.scrollWidth <= n.clientWidth; })()`), true);
  await b.ui('pause', { group: 's1', on: false });
  const working = s1.text('wait_for', { text: 'never there', timeout: 1500 }).catch(() => {});
  await until(helmSays, (h) => h[0] === 'Working');
  await working;
});

test('a session at work or paused shows on its group from any tab, and its menu pauses it', async () => {
  const [own] = await mine();
  await b.ui('tab:select', own.id);
  const mark = (id) => chrome(`document.querySelector('#tabs .group[data-group="${id}"] .group-mark')?.className ?? null`);
  await until(() => mark('s2'), (m) => m === null);
  const working = s2.text('wait_for', { text: 'never there', timeout: 2500 }).catch(() => {});
  await until(() => mark('s2'), (m) => m === 'group-mark working');
  assert.ok((await boxes('#tabs .group[data-group="s2"] .group-mark'))[0], 'the dot is drawn');
  await working;
  await until(() => mark('s2'), (m) => m === null); // gone a moment after its last step

  // Right-click on the group's name: Take over, then Let Claude continue.
  assert.equal((await b.ui('group:menu-items', { group: 's3' }))[0], 'Take over');
  await b.ui('group:menu-items', { group: 's3', click: 'Take over' });
  await until(() => mark('s3'), (m) => m === 'group-mark paused');
  assert.match(await s3.text('navigate', { url: b.base }).catch((e) => e.message), /paused/);
  assert.equal(await chrome(`getComputedStyle(document.querySelector('.group.paused .group-name')).textDecorationLine`), 'none', 'not struck through');
  assert.equal((await b.ui('group:menu-items', { group: 's3' }))[0], 'Let Claude continue');

  // In the sidebar "Paused" is spelled out whole beside the name, and collapsed the mark is still there.
  await b.ui('tabs:layout', { vertical: true, collapsed: false });
  await until(() => chrome(`document.getElementById('tabs').parentElement.id`), (p) => p === 'sidebar');
  const status = await chrome(`(() => {
    const n = document.querySelector('#sidebar .group.paused .group-status');
    return [n.textContent, n.scrollWidth <= n.clientWidth, n.getBoundingClientRect().width > 20];
  })()`);
  assert.deepEqual(status, ['Paused', true, true]);
  await b.ui('tabs:layout', { collapsed: true });
  await until(() => chrome(`getComputedStyle(document.querySelector('#sidebar .group-name')).display`), (d) => d === 'none');
  assert.ok((await boxes('#sidebar .group.paused .group-mark'))[0], 'the pause sign shows in the collapsed sidebar');
  await b.ui('tabs:layout', { vertical: false, collapsed: false });
  await until(() => chrome(`document.getElementById('tabs').parentElement.id`), (p) => p === 'tabrow');
  await b.ui('group:menu-items', { group: 's3', click: 'Let Claude continue' });
  await until(() => mark('s3'), (m) => m === null);
});

test('a tab without an icon shows its site\'s first letter', async () => {
  await b.ui('tab:new', b.base + '/second.html?letter');
  const t = await until(() => b.state().then((s) => s.tabs.find((x) => x.active)), (x) => x && !x.loading && x.url.includes('letter'));
  assert.equal(await chrome(`document.querySelector('.tab[data-id="${t.id}"] .letter')?.textContent ?? null`), '1'); // 127.0.0.1
});

test('at the smallest window, with the Claude panel open, the toolbar holds and the address field stays usable', async () => {
  await size(720, 600);
  assert.equal(await chrome(`document.body.classList.contains('panel-closed')`), false);
  const [nav] = await boxes('#navrow');
  const items = await boxes('#navrow > *');
  inOrder(items, nav);
  const address = items.find(([name]) => name === 'address-form');
  assert.ok(address && address[2] - address[1] >= 150, `the address field is ${address?.[2] - address?.[1]}px wide`);
  // The tab row holds too, with a session's tab on screen and the helm showing.
  const theirs = (await b.state()).tabs.find((t) => t.group === 's1');
  await b.ui('tab:select', theirs.id);
  await until(helmSays, (h) => h.length > 0);
  const [row] = await boxes('#tabrow');
  inOrder(await boxes('#tabs, #newtab, #helm'), row);
  inOrder(await boxes('#helm > *'), (await boxes('#helm'))[0]);
  // The tab on screen is in sight in the strip, which scrolls when it is too full.
  const [strip] = await boxes('#tabs');
  const [active] = await until(() => boxes('#tabs .tab.active'), ([a]) => a && a[1] >= strip[1] - 1 && a[2] <= strip[2] + 1);
  assert.ok(active, 'the tab on screen is in sight');
  for (const s of [s1, s2, s3]) s.end();
});
