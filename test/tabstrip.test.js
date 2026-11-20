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
  assert.deepEqual(labels, ['Code · tabs']); // without the "Claude" every session starts with

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
  // The icons sit in one column, the tab on screen's too.
  const lefts = await chrome(`[...document.querySelectorAll('#sidebar .yours .tab > :first-child')].map((n) => Math.round(n.getBoundingClientRect().left))`);
  assert.ok(lefts.length > 2 && lefts.every((x) => x === lefts[0]), `icons at ${lefts}`);
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
// Chromium tells the page where the window buttons are a moment after the
// window's new width: until then a narrowed window's rows run on under them
// (ui.css's --wco is 0). So the size has settled once the buttons take the
// room they took before.
const buttonsRoom = () => chrome(`(() => {
  const free = navigator.windowControlsOverlay.getTitlebarAreaRect();
  return [innerWidth, Math.round(innerWidth - free.right)];
})()`);
const size = async (width, height) => {
  const [, room] = await buttonsRoom();
  await chrome(`window.resizeTo(${width}, ${height})`);
  await until(buttonsRoom, ([w, now]) => Math.abs(w - width) < 4 && Math.abs(now - room) <= 1);
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
  // What tells the sessions apart is what is shown: the name without "Claude", whole in the tooltip.
  const shown = await chrome(`[...document.querySelectorAll('#tabs .group-name')].map((n) => [n.textContent, n.title])`);
  assert.deepEqual(shown.map(([text]) => text), ['Code · release notes for the autumn update', 'Desktop · quarterly research', 'Code · agent-b migration']);
  assert.match(shown[1][1], /^Claude Desktop · quarterly research/);
});

test('short of room, a tag is as narrow as its name and a small tab leaves its title the room of its close button', async () => {
  const brief = b.as('s4', 'A');
  await brief.text('navigate', { url: b.base + '/second.html?4' });
  const tag = (id) => until(() => boxes(`#tabs .group[data-group="${id}"] .group-tag`), (l) => l.length === 1).then(([[, left, right]]) => right - left);
  assert.ok(await tag('s4') < 60, `the tag of a session called "A" is ${await tag('s4')}px wide`);
  assert.ok(await tag('s2') <= 105, `a long name's tag gives way to ${await tag('s2')}px`);
  // Tabs not on screen, squeezed under 120px: no room kept for a close button that is not shown.
  const tabs = await chrome(`[...document.querySelectorAll('#tabs .tab:not(.pinned)')].map((t) => [t.classList.contains('active'),
    Math.round(t.getBoundingClientRect().width), getComputedStyle(t.querySelector('.close')).display, Math.round(t.querySelector('.title').getBoundingClientRect().width)])`);
  const small = tabs.filter(([active, width]) => !active && width < 120);
  assert.ok(small.length > 3, 'the strip is short of room');
  for (const [, width, display, title] of small) {
    assert.equal(display, 'none');
    assert.ok(title >= width - 50, `a ${width}px tab shows ${title}px of its title`);
  }
  assert.notEqual(tabs.find(([active]) => active)[2], 'none', 'the tab on screen keeps its own');
  brief.end();
  await until(() => b.state(), (s) => !s.groups.some((g) => g.id === 's4'));
});

test('the helm says the state first, then who, then the button', async () => {
  const idle = await until(helmSays, (h) => h[0] === 'Idle'); // once its last step has had its moment
  assert.match(idle[1], /^Code · release notes/); // as on its tag: without "Claude"
  assert.match(await chrome(`document.getElementById('helm-text').title`), /^Claude Code · release notes/);
  // With room in the window, the name keeps a good start of itself rather than giving way first.
  assert.ok(await chrome(`document.getElementById('helm-text').getBoundingClientRect().width`) >= 150);
  await b.ui('pause', { group: 's1', on: true });
  const paused = await until(helmSays, (h) => h[0] === 'Paused');
  assert.match(paused[1], /^Code · release notes/);
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
  assert.deepEqual(await b.ui('group:menu-items', { group: 's3' }),
    ['Take over', '-', 'Watch in a small window', 'Move group to window', '-', 'End session'], 'the whole menu');
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

test('a session waiting on the user is marked as asking, not working, and its question reads state first', async () => {
  const [own] = await mine();
  await b.ui('tab:select', own.id);
  const mark = (id) => chrome(`(() => { const m = document.querySelector('#tabs .group[data-group="${id}"] .group-mark'); return m ? [m.className, m.textContent, m.getAttribute('aria-label')] : null; })()`);
  // One asks for the tab on screen, another asks him to point: both wait on him.
  const handoff = s2.text('request_tab', {}).catch((e) => e.message);
  await until(helmSays, (h) => h[0] === 'Asks for this tab');
  const pick = s3.text('ask_user_to_pick', { message: 'Which button submits the order?' }).catch((e) => e.message);
  await until(() => mark('s3'), (m) => m?.[0] === 'group-mark asking');
  assert.deepEqual(await mark('s2'), ['group-mark asking', '?', 'Asking']);
  assert.equal(await mark('s1'), null);
  assert.equal((await b.state()).groups.find((g) => g.id === 's3').asking, true);
  // A short name fills the helm: no blank kept inside it.
  const [said, room] = await chrome(`(() => { const n = document.getElementById('helm-text'); const r = document.createRange(); r.selectNodeContents(n);
    return [n.textContent, n.getBoundingClientRect().width - r.getBoundingClientRect().width]; })()`);
  assert.equal(said, 'Desktop · quarterly research');
  assert.ok(room < 3, `${room}px of blank after the name`);
  await until(() => chrome(`document.getElementById('helm-no').disabled`), (d) => d === false);
  await chrome(`document.getElementById('helm-no').click()`);
  await handoff;
  await until(() => mark('s2'), (m) => m === null || m[0] !== 'group-mark asking');
  // The pointing question: state, then who, then the message, with no full stop after its question mark.
  const asks = await until(helmSays, (h) => h[0] === 'Asks you to point');
  assert.equal(asks[1], 'Code · agent-b migration: Which button submits the order? Esc cancels.');
  await b.ui('pick:cancel');
  await pick;
  await until(() => mark('s3'), (m) => m === null || m[0] !== 'group-mark asking');
  await b.ui('tab:select', own.id);
});

test('a tab without an icon shows a letter: its site\'s name\'s, or its title\'s on a tile tinted by port for a local page', async () => {
  await b.ui('tab:new', b.base + '/second.html?letter');
  const t = await until(() => b.state().then((s) => s.tabs.find((x) => x.active)), (x) => x && !x.loading && x.url.includes('letter'));
  const tile = await chrome(`(() => { const n = document.querySelector('.tab[data-id="${t.id}"] .letter'); return n && [n.textContent, n.className]; })()`);
  assert.equal(tile[0], t.title[0].toUpperCase()); // not "1" for 127.0.0.1
  assert.match(tile[1], /^letter hue-[0-4]$/);
  const letter = (title, url) => chrome(`(() => { const n = letterOf(${JSON.stringify({ title, url })}); return n.textContent + n.className.replace('letter', ''); })()`);
  assert.equal(await letter('Sign in', 'https://accounts.google.com/signin'), 'G');
  assert.equal(await letter('News', 'https://www.bbc.co.uk/news'), 'B');
  assert.equal(await letter('Diario', 'https://tienda.clarin.com.ar/'), 'C');
  assert.equal(await letter('Docs', 'https://docs.github.io/x'), 'G');
  assert.equal(await letter('Wiki', 'http://intranet/'), 'I');
  assert.equal(await letter('Pung', 'http://localhost:5173/'), 'P hue-0');
  assert.equal(await letter('Loui relay', 'http://127.0.0.1:7332/'), 'L hue-3');
  assert.equal(await letter('Router', 'http://192.168.1.1/'), 'R');
  assert.equal(await letter('http://localhost:8000/', 'http://localhost:8000/'), 'L hue-1');
  assert.equal(await letter('Notes', ''), 'N');
});

test('the address field follows the tab on screen while it has the keyboard, unless something was typed', async () => {
  const [first, second] = (await mine()).filter((x) => !x.pinned && x.url);
  const field = () => chrome(`(() => { const a = document.getElementById('address'); return [a.value, a.selectionStart, a.selectionEnd, document.activeElement === a]; })()`);
  await b.ui('tab:select', first.id);
  await until(field, ([value]) => value === first.url);
  await chrome(`document.getElementById('address').focus()`); // Ctrl+L
  await b.ui('tab:select', second.id);
  // The new tab's address, selected: Enter would not load the old one here.
  await until(field, ([value]) => value === second.url);
  assert.deepEqual(await field(), [second.url, 0, second.url.length, true]);
  // What he has typed stays, whichever tab comes on screen.
  await chrome(`(() => { const a = document.getElementById('address'); a.value = 'half an addr'; a.dispatchEvent(new InputEvent('input', { bubbles: true })); })()`);
  await b.ui('tab:select', first.id);
  await until(() => b.state(), (s) => s.tabs.find((x) => x.active)?.id === first.id);
  await pause(200);
  assert.equal((await field())[0], 'half an addr');
  await chrome(`document.getElementById('address').blur()`);
  await b.ui('tab:select', second.id);
  await until(field, ([value]) => value === second.url);
});

test('a strip with more tabs than it shows says so: faded edges, buttons that page, and sessions kept in sight', async () => {
  const before = ids(await mine());
  for (let i = 0; i < 24; i++) await b.ui('tab:new', `${b.base}/plain.html?${i}`);
  const [own] = await mine();
  await b.ui('tab:select', own.id);
  await b.ui('pause', { group: 's1', on: true });
  const strip = () => chrome(`(() => { const t = document.getElementById('tabs'); const shown = (id) => !document.getElementById(id).hidden;
    return { left: t.scrollLeft, over: t.scrollWidth - t.clientWidth, cls: t.className, back: shown('tabs-back'), on: shown('tabs-on'),
      strays: [...document.querySelectorAll('#strays .stray')].map((n) => [n.dataset.group, n.querySelector('.stray-name').textContent, n.querySelector('.group-mark')?.className ?? null]) }; })()`);
  // On his own first tab: the sessions are off to the right, and each keeps a small tag after the strip.
  // (Once the pause just asked for is drawn: the strip is read from the window, a moment behind.)
  const start = await until(strip, (s) => s.over > 200 && s.left === 0 && s.strays.length === 3 && s.strays[0][2] === 'group-mark paused' && !s.strays.some(([, , m]) => m === 'group-mark working'));
  assert.deepEqual([start.back, start.on, start.cls], [false, true, 'more-after']);
  assert.deepEqual(start.strays, [['s1', 'Code · release notes for the autumn update', 'group-mark paused'], ['s2', 'Desktop · quarterly research', null], ['s3', 'Code · agent-b migration', null]]);
  const [row] = await boxes('#tabrow');
  inOrder(await boxes('#tabs, #strays, #newtab'), row);
  assert.equal(await chrome(`document.getElementById('tabs-on').tabIndex`), 0, 'reached with the keyboard');
  // A session at work shows on its small tag too.
  const working = s2.text('wait_for', { text: 'never there', timeout: 1500 }).catch(() => {});
  await until(strip, (s) => s.strays[1]?.[2] === 'group-mark working');
  await working;
  // The button at the faded edge scrolls a page; the strip then stays where he put it when the window's state changes.
  await chrome(`document.getElementById('tabs-on').click()`);
  const paged = await until(strip, (s) => s.left > 200 && s.back);
  assert.match(paged.cls, /more-before/);
  await b.ui('pause', { group: 's1', on: false });
  await until(() => b.state(), (s) => !s.groups.find((g) => g.id === 's1').paused);
  await pause(300);
  assert.equal((await strip()).left, paged.left, 'not pulled back to the tab on screen');
  await chrome(`document.getElementById('tabs-back').click()`);
  await until(strip, (s) => s.left === 0 && !s.back);
  // A small tag brings its group into sight, and is then no longer needed.
  await chrome(`document.querySelector('#strays .stray[data-group="s2"]').click()`);
  const [box] = await boxes('#tabs');
  const [tag] = await until(() => boxes('#tabs .group[data-group="s2"] .group-tag'), ([t]) => t && t[1] >= box[1] && t[2] <= box[2]);
  assert.ok(tag);
  assert.ok(!(await strip()).strays.some(([id]) => id === 's2'));
  assert.equal(await chrome(`document.activeElement.className`), 'group-name');
  // Another tab on screen: the strip follows it again.
  const last = (await mine()).at(-1);
  await b.ui('tab:select', last.id);
  await until(() => boxes('#tabs .tab.active'), ([a]) => a && a[1] >= box[1] - 1 && a[2] <= box[2] + 1);
  for (const t of await mine()) if (!before.includes(t.id)) await b.ui('tab:close', t.id);
  await until(strip, (s) => s.over <= 0 && !s.on && !s.back && s.strays.length === 0 && s.cls === '');
});

test('the tab on screen keeps room for a start of its title while the others give way', async () => {
  await size(1100, 600);
  const own = (await mine()).find((t) => !t.pinned);
  await b.ui('tab:select', own.id);
  const widths = await until(() => chrome(`[...document.querySelectorAll('#tabs .tab:not(.pinned)')].map((n) => [n.classList.contains('active'), Math.round(n.getBoundingClientRect().width)])`),
    (list) => list.some(([active]) => active));
  const active = widths.find(([on]) => on)[1];
  const others = widths.filter(([on]) => !on).map(([, w]) => w);
  assert.ok(Math.min(...others) < 100, `the strip is short of room: ${others}`);
  assert.ok(active >= 120, `the tab on screen is ${active}px wide`);
  const shown = await chrome(`(() => { const t = document.querySelector('#tabs .tab.active .title'); return [t.getBoundingClientRect().width > 40, !!document.querySelector('#tabs .tab.active .close').getBoundingClientRect().width]; })()`);
  assert.deepEqual(shown, [true, true], 'with its title and its close button');
});

test('resting on a tab shows a card with its whole title, its site, and whose it is; the address bar has the title too', async () => {
  const hint = () => b.ui('hint');
  const rest = (id) => chrome(`document.querySelector('#tabs .tab[data-id="${id}"]').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))`);
  const leave = () => chrome(`document.getElementById('tabs').dispatchEvent(new MouseEvent('mouseleave'))`);
  const own = (await mine()).find((t) => !t.pinned && /^http/.test(t.url));
  await b.ui('tab:select', own.id);
  await until(() => chrome(`document.querySelector('#tabs .tab.active')?.dataset.id`), (id) => id === String(own.id));
  assert.equal(await chrome(`document.querySelector('#tabs .tab[data-id="${own.id}"]').title`), '', 'no tooltip of the system\'s as well');
  assert.equal(await chrome(`document.getElementById('address').title`), own.title);
  // The tab on screen, its title whole on it: the address bar and the page already say what it is, so no card.
  const fits = await chrome(`(() => { const t = document.querySelector('#tabs .tab.active .title'); return t.scrollWidth <= t.clientWidth; })()`);
  await rest(own.id);
  await pause(1300);
  assert.equal((await hint()).shown, fits ? null : 'card', `the tab on screen has a card only when its title is cut short (fits: ${fits})`);
  await leave();
  await until(hint, (h) => h.shown === null);
  // Another tab: after most of a second, not at once.
  const other = (await mine()).find((t) => !t.pinned && t.id !== own.id);
  await b.ui('tab:select', other.id);
  await until(() => chrome(`document.querySelector('#tabs .tab.active')?.dataset.id`), (id) => id === String(other.id));
  await rest(own.id);
  await pause(650);
  assert.equal((await hint()).shown, null, 'not at once, nor for a pointer passing by');
  const card = await until(hint, (h) => h.shown === 'card');
  assert.ok(card.inFront, 'in front of the page');
  assert.deepEqual(card.text.split('\n'), [own.title, new URL(own.url).host]);
  // Below its tab, and clear of the toolbar: Back, Reload and the address bar stay in reach.
  const under = await chrome(`(() => { const r = document.querySelector('#tabs .tab[data-id="${own.id}"]').getBoundingClientRect();
    return [Math.round(r.left), Math.round(r.bottom), Math.round(document.getElementById('navrow').getBoundingClientRect().bottom)]; })()`);
  assert.ok(Math.abs(card.bounds.x + 8 - under[0]) <= 1 && card.bounds.y >= under[1], `under its tab: ${JSON.stringify(card.bounds)} for a tab at ${under}`);
  assert.ok(card.bounds.y >= under[2], `under the toolbar too: ${JSON.stringify(card.bounds)}, toolbar ends at ${under[2]}`);
  await leave();
  await until(hint, (h) => h.shown === null);
  // A session's tab says whose it is.
  const theirs = (await b.state()).tabs.find((t) => t.group === 's1');
  await rest(theirs.id);
  const theirCard = await until(hint, (h) => h.shown === 'card');
  assert.equal(theirCard.text.split('\n').at(-1), "Claude Code · release notes for the autumn update's tab");
  // A press takes it away.
  await chrome(`document.querySelector('#tabs .tab[data-id="${theirs.id}"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
  await until(hint, (h) => h.shown === null);
  await leave();
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

// ── tabs picked out together ─────────────────────────────────────────────
test('Ctrl+click and Shift+click pick tabs out together; closing one of them closes them all', async () => {
  const click = (id, keys = {}) => chrome(`document.querySelector('#tabs .tab[data-id="${id}"]').dispatchEvent(new MouseEvent('click', { bubbles: true, ...${JSON.stringify(keys)} })); 1`);
  const picked = () => chrome(`[...document.querySelectorAll('#tabs .tab.picked')].map((t) => +t.dataset.id)`);
  const open = async (q) => {
    const before = ids(await mine());
    await b.ui('panel', { tool: 'tabs', args: { action: 'new', url: `${b.base}/second.html?${q}` } });
    return (await until(mine, (l) => l.length > before.length)).find((t) => !before.includes(t.id)).id;
  };
  const [a, bb, c, d] = [await open('p1'), await open('p2'), await open('p3'), await open('p4')];
  await click(a);
  await until(mine, (l) => l.find((t) => t.id === a).active);
  assert.deepEqual(await picked(), [], 'nothing is picked by a plain click');

  // Ctrl+click adds a tab to the one on screen, and takes it away again.
  await click(c, { ctrlKey: true });
  await until(picked, (p) => p.join() === [a, c].join());
  assert.equal((await mine()).find((t) => t.active).id, a, 'the tab on screen stays');
  await click(c, { ctrlKey: true });
  await until(picked, (p) => p.length === 0);

  // Shift+click takes every tab from the one on screen to the one clicked.
  await click(c, { shiftKey: true });
  await until(picked, (p) => p.join() === [a, bb, c].join());
  // The tab's menu offers to close them together.
  const menu = await b.ui('tab:menu-items', { id: bb });
  assert.ok(JSON.stringify(menu).includes('Close 3 tabs'), JSON.stringify(menu));

  // A plain click lets them go.
  await click(d);
  await until(picked, (p) => p.length === 0);
  assert.equal((await mine()).length >= 4, true);

  // Picked again, and closed from one tab's ×: all three go, the fourth stays.
  await click(a);
  await until(mine, (l) => l.find((t) => t.id === a).active);
  await click(c, { shiftKey: true });
  await until(picked, (p) => p.length === 3);
  await chrome(`document.querySelector('#tabs .tab[data-id="${bb}"] .close').click(); 1`);
  const left = await until(mine, (l) => ![a, bb, c].some((id) => l.some((t) => t.id === id)));
  assert.ok(left.some((t) => t.id === d), 'a tab that was not picked stays');
  assert.deepEqual(await picked(), []);
});
