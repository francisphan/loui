// The task manager (Shift+Esc): every tab, the window chrome and Loui's own
// processes with their memory and CPU; sleeping tabs shown asleep at zero;
// Claude's tabs labelled with their group; closing or sleeping a tab from it;
// sorting; and no measuring at all while it is closed.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const { launch } = require('./drive');

let b;
test.before(async () => { b = await launch(); });
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
const state = () => b.state();
const onScreen = async () => (await state()).tabs.find((t) => t.active);
const rows = () => b.ui('taskmanager:rows');
const named = (list, name) => list?.find((r) => r.names.some((n) => n.includes(name)));
async function open(url) {
  await b.ui('tab:new', url);
  const id = (await onScreen()).id;
  return until(async () => (await state()).tabs.find((t) => t.id === id), (t) => !t.loading && t.url && t.title);
}
const mb = (text) => (text === '—' ? -1 : parseFloat(text));

test('nothing is measured while the task manager is closed', async () => {
  assert.deepEqual(await b.ui('taskmanager:state'), { open: false, measuring: false });
});

test('it lists Loui, the window chrome, the GPU and utility processes, and each tab, with memory and CPU', async () => {
  const first = await onScreen();
  await b.ui('go', b.base);
  const page = await open(b.base + '/second.html');
  await b.ui('taskmanager:open');
  const list = await until(rows, (l) => named(l, 'Second') && named(l, 'Loui (main process)'));
  const main = named(list, 'Loui (main process)');
  assert.ok(mb(main.numbers[1]) > 10, `Loui's working set: ${main.numbers[1]}`);
  assert.ok(named(list, 'Window chrome'), 'the window chrome');
  assert.ok(named(list, 'GPU process'), 'the GPU process');
  assert.ok(named(list, 'Network Service'), 'the network service');
  const tab = named(list, page.title);
  assert.equal(tab.groups[tab.names.indexOf(page.title)], null, 'the user\'s tab carries no group');
  assert.ok(mb(tab.numbers[1]) > 1, `the tab's working set: ${tab.numbers[1]}`);
  assert.match(tab.numbers[3], /^\d+$/, 'its process ID');
  assert.ok(named(list, (await state()).tabs.find((t) => t.id === first.id).title || first.url), 'the other tab');
  const measured = await b.ui('taskmanager:measure');
  for (const t of (await state()).tabs) {
    const holding = measured.processes.filter((p) => p.members.some((m) => m.kind === 'tab' && m.id === t.id));
    assert.equal(holding.length, 1, `tab ${t.id} is in exactly one process`);
  }
});

test('a Claude session\'s tab is labelled with its group', async () => {
  const a = b.as('a', 'Claude Code · tm');
  await a.text('navigate', { url: b.base + '/index.html?claude' });
  const list = await until(rows, (l) => l.some((r) => r.groups.includes('Claude Code · tm')));
  const row = list.find((r) => r.groups.includes('Claude Code · tm'));
  assert.ok(mb(row.numbers[1]) > 1);
  a.end();
  await until(rows, (l) => !l.some((r) => r.groups.includes('Claude Code · tm')));
});

test('a sleeping tab is shown asleep, using nothing; Put to sleep and Close tab act on the selected tab', async () => {
  const shown = await onScreen();
  const other = await open(b.base + '/index.html?to-sleep');
  await b.ui('tab:select', shown.id);
  await until(rows, (l) => named(l, other.title));
  // As a person would: select the row, then press the button.
  await until(() => b.ui('taskmanager:js', `!!document.querySelector('tr[data-id="${other.id}"]')`), Boolean);
  await b.ui('taskmanager:js', `document.querySelector('tr[data-id="${other.id}"]').click(); document.getElementById('tm-sleep').disabled`)
    .then((disabled) => assert.equal(disabled, false, 'a background tab of the user\'s can sleep'));
  await b.ui('taskmanager:js', 'document.getElementById("tm-sleep").click()');
  await until(async () => (await state()).tabs.find((t) => t.id === other.id), (t) => t.asleep);
  const asleep = await until(rows, (l) => l.find((r) => r.asleep && r.names.includes(other.title)));
  const row = asleep.find((r) => r.asleep && r.names.includes(other.title));
  assert.deepEqual(row.numbers, ['0.0 MB', '0.0 MB', '0.0', '—']);
  // The tab on screen cannot sleep.
  await until(() => b.ui('taskmanager:js', `!!document.querySelector('tr[data-id="${shown.id}"]')`), Boolean);
  assert.equal(await b.ui('taskmanager:js',
    `document.querySelector('tr[data-id="${shown.id}"]').click(); document.getElementById('tm-sleep').disabled`), true);
  await b.ui('taskmanager:js', `document.querySelector('tr[data-id="${other.id}"]').click(); document.getElementById('tm-close').click()`);
  await until(async () => (await state()).tabs, (l) => !l.some((t) => t.id === other.id));
});

test('sorting by a column puts the largest first, and a second click turns it round', async () => {
  await b.ui('taskmanager:sort', 'workingSet');
  const down = (await rows()).map((r) => mb(r.numbers[1]));
  assert.deepEqual(down, [...down].sort((x, y) => y - x));
  await b.ui('taskmanager:sort', 'workingSet');
  const up = (await rows()).map((r) => mb(r.numbers[1]));
  assert.deepEqual(up, [...up].sort((x, y) => x - y));
  await b.ui('taskmanager:sort', 'task');
  const names = (await rows()).map((r) => r.names.join(' ').toLowerCase());
  assert.ok(names.length > 3);
});

test('the Claude panel\'s Claude Code process is listed while it runs', async () => {
  const child = spawn(process.execPath, ['-e', 'const a = []; setInterval(() => a.push(Buffer.alloc(1e5)), 50); setTimeout(() => {}, 60000)']);
  try {
    await b.ui('taskmanager:watch', { pid: child.pid });
    const list = await until(rows, (l) => named(l, 'Claude Code (the Claude panel)'));
    const row = named(list, 'Claude Code (the Claude panel)');
    assert.equal(row.numbers[3], String(child.pid));
    assert.ok(mb(row.numbers[1]) > 5, `its working set: ${row.numbers[1]}`);
  } finally {
    child.kill();
  }
  await until(rows, (l) => !named(l, 'Claude Code (the Claude panel)'));
});

test('its page is locked to Loui, and closing it stops the measuring', async () => {
  const url = await b.ui('taskmanager:url');
  await b.ui('taskmanager:js', 'location.href = "https://example.com/"; 1');
  await pause(500);
  assert.equal(await b.ui('taskmanager:url'), url);
  await b.ui('taskmanager:close');
  await until(() => b.ui('taskmanager:state'), (s) => !s.open && !s.measuring);
});
