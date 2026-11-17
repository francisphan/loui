// Tab groups: each Claude session works in a group of its own, cannot reach
// anyone else's tabs, and takes its tabs with it when it ends.
const test = require('node:test');
const assert = require('node:assert/strict');
const { launch } = require('./drive');

let b;
test.before(async () => { b = await launch(); });
test.after(async () => { await b.close(); });

const tabsOf = async (group) => (await b.state()).tabs.filter((t) => t.group === group);
const onScreen = async () => (await b.state()).tabs.find((t) => t.active);
const idsIn = (listing) => [...listing.matchAll(/^[> ] (\d+) {2}/gm)].map((m) => +m[1]);

test('a session works in the background, in its own group', async () => {
  const a = b.as('a', 'Claude Code · pung');
  const before = await onScreen();
  assert.match(await a.text('navigate', { url: b.base }), /heading1 "Fixture page"/);
  const state = await b.state();
  assert.deepEqual(state.groups.map((g) => g.label), ['You', 'Claude Code · pung']);
  assert.equal((await tabsOf('a')).length, 1);
  assert.equal((await onScreen()).id, before.id, 'the user is still looking at their own tab');
  assert.equal(before.group, 'you');
});

test('a tab that is not on screen can be typed in, clicked and captured', async () => {
  const a = b.as('a');
  const page = await a.text('snapshot');
  const field = page.match(/textbox "Your name" \[(e\d+)\]/)[1];
  const after = await a.text('type', { ref: field, text: 'Ada', clear: true, submit: true });
  assert.match(after, /text "Hello, Ada \(s\)"/);
  const [note, image] = await a.call('screenshot');
  assert.match(note.text, /^Visible page, \d+x\d+/);
  assert.ok(image.data.length > 5000, 'a real picture, not a blank one');
  assert.equal((await onScreen()).group, 'you');
});

test('sessions cannot see or touch each other\'s tabs', async () => {
  const a = b.as('a');
  const c = b.as('c', 'Claude Desktop');
  assert.match(await c.text('navigate', { url: b.base + '/second.html' }), /heading1 "Second page"/);
  const mine = idsIn(await a.text('tabs', { action: 'list' }));
  const theirs = idsIn(await c.text('tabs', { action: 'list' }));
  assert.equal(mine.length, 1);
  assert.equal(theirs.length, 1);
  assert.notEqual(mine[0], theirs[0]);
  await assert.rejects(a.text('tabs', { action: 'close', id: theirs[0] }), /No tab \d+ in your group/);
  await assert.rejects(a.text('tabs', { action: 'select', id: theirs[0] }), /No tab \d+ in your group/);
  const userTab = (await tabsOf('you'))[0].id;
  await assert.rejects(a.text('tabs', { action: 'close', id: userTab }), /No tab \d+ in your group/);
  // Each still reads its own page.
  assert.match(await a.text('snapshot'), /Fixture page/);
  assert.match(await c.text('snapshot'), /Second page/);
});

test('two sessions can work at the same time', async () => {
  const a = b.as('a');
  const c = b.as('c');
  const [one, two] = await Promise.all([
    a.text('navigate', { url: b.base }),
    c.text('navigate', { url: b.base + '/second.html' }),
  ]);
  assert.match(one, /Fixture page/);
  assert.match(two, /Second page/);
});

test('taking over pauses one group and leaves the others working', async () => {
  const a = b.as('a');
  const c = b.as('c');
  await b.ui('pause', { group: 'a', on: true });
  await assert.rejects(a.text('scroll', { direction: 'bottom' }), /taken over this tab group/);
  assert.match(await a.text('snapshot'), /Fixture page/, 'reading still works');
  assert.match(await c.text('scroll', { direction: 'top' }), /^Scrolled/);
  await b.ui('pause', { group: 'a', on: false });
  assert.match(await a.text('scroll', { direction: 'top' }), /^Scrolled/);
});

test('the user can hand the tab on screen to a session, and gets it back when the session ends', async () => {
  const c = b.as('c');
  const lent = await onScreen();
  const asked = c.text('request_tab');
  await new Promise((r) => setTimeout(r, 300));
  assert.match((await b.state()).asking.label, /Claude Desktop/);
  await b.ui('handoff:answer', true);
  assert.match(await asked, new RegExp(`handed you tab ${lent.id}`));
  assert.ok((await tabsOf('c')).some((t) => t.id === lent.id));
  assert.ok((await tabsOf('you')).length >= 1, 'the user is never left without a tab');

  c.end();
  await new Promise((r) => setTimeout(r, 400));
  const state = await b.state();
  assert.ok(!state.groups.some((g) => g.id === 'c'), 'the group is gone');
  assert.equal(state.tabs.find((t) => t.id === lent.id)?.group, 'you', 'the lent tab went back to the user');
  assert.ok(!state.tabs.some((t) => t.group === 'c'), 'the tabs it opened are closed');
});

test('a call in flight stops when the user takes the tab back', async () => {
  const d = b.as('d', 'Claude Code · wait');
  const lent = await onScreen();
  const asked = d.text('request_tab');
  await new Promise((r) => setTimeout(r, 300));
  await b.ui('handoff:answer', true);
  assert.match(await asked, new RegExp(`handed you tab ${lent.id}`));
  await d.text('navigate', { url: b.base });
  // Waiting for words that are on another page: the user takes the tab back
  // and opens that page in it. The session must not be given its outline.
  const waiting = d.text('wait_for', { text: 'Not an article', seconds: 10 });
  await new Promise((r) => setTimeout(r, 600));
  await b.ui('tab:move', { id: lent.id, group: 'you' }); // dragged back in the tab strip
  await b.ui('tab:js', { id: lent.id, code: `location.href = ${JSON.stringify(b.base + '/plain.html')}` });
  await assert.rejects(waiting, /The user took this tab back/);
  assert.equal((await b.state()).tabs.find((t) => t.id === lent.id)?.group, 'you');
  // Its group is where its next call works, in a tab of its own.
  assert.match(await d.text('navigate', { url: b.base }), /Fixture page/);
  assert.ok(!(await tabsOf('d')).some((t) => t.id === lent.id));
  d.end();
  await new Promise((r) => setTimeout(r, 400));
});

test('a session cannot take the name of the user\'s own group', async () => {
  const before = (await tabsOf('you')).length;
  await assert.rejects(b.as('you', 'Impostor').text('snapshot'), /cannot be called "you"/);
  await assert.rejects(b.as('panel', 'Impostor').text('snapshot'), /cannot be called "panel"/);
  assert.equal((await tabsOf('you')).length, before);
});

test('a declined hand-over leaves the tab with the user', async () => {
  const a = b.as('a');
  const asked = a.text('request_tab');
  await new Promise((r) => setTimeout(r, 300));
  await b.ui('handoff:answer', false);
  assert.match(await asked, /did not hand over/);
  assert.equal((await onScreen()).group, 'you');
});

test('ending a session closes its tab group', async () => {
  const a = b.as('a');
  await a.text('tabs', { action: 'new', url: b.base + '/second.html' });
  assert.equal((await tabsOf('a')).length, 2);
  a.end();
  await new Promise((r) => setTimeout(r, 400));
  const state = await b.state();
  assert.deepEqual(state.groups.map((g) => g.id), ['you']);
  assert.ok(state.tabs.every((t) => t.group === 'you'));
  // The same session id starts afresh rather than failing.
  assert.match(await a.text('navigate', { url: b.base }), /Fixture page/);
});
