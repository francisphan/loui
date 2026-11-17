// The command palette: Ctrl+K opens one search over open tabs (the user's and
// each session's), bookmarks, history and the menu's commands, in front of the
// page. It is the user's alone: no tool a Claude session has can open or use it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { launch } = require('./drive');
const TOOLS = require('../src/shared/tools');
const { fuzzy } = require('../src/main/palette');

let b;
test.before(async () => { b = await launch(); });
test.after(async () => { await b.close(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what, ms = 5000) {
  let last;
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
    last = await check();
    if (last) return last;
  }
  assert.fail(`timed out waiting for ${what}`);
}
const onScreen = async () => (await b.state()).tabs.find((t) => t.active);
async function visit(url) {
  await b.ui('go', url);
  await until(async () => { const t = await onScreen(); return t.url === url && !t.loading && t.title; }, `${url} to load`);
}
const menuKey = (accelerator) => b.ui('menu:key', accelerator);
const palette = () => b.ui('palette');
const key = (name, modifiers) => b.ui('palette:key', { key: name, modifiers });
const group = (p, label) => p.groups.find((g) => g.label === label);
const titles = (p, label) => group(p, label)?.rows.map((r) => r.title) || [];
const chosen = (p) => p.groups.flatMap((g) => g.rows).find((r) => r.chosen);
// Opens the palette with Ctrl+K (if it is not open) and types text; waits for
// the results to answer that text and to satisfy ready.
async function search(text, ready = () => true) {
  if (!(await palette()).open) await menuKey('CmdOrCtrl+K');
  await until(async () => (await palette()).open, 'the palette to open');
  await b.ui('palette:type', text);
  return until(async () => {
    const p = await palette();
    return p.answered === text && ready(p) && p;
  }, `results for "${text}"`);
}
// Arrows down to the row with this title.
async function arrowTo(title) {
  for (let i = 0; i < 30; i++) {
    const p = await palette();
    if (chosen(p)?.title === title) return;
    await key('Down');
    await sleep(30);
  }
  assert.fail(`never reached "${title}"`);
}
// Opens it (without typing) and waits for its first results.
async function opened(accelerator = 'CmdOrCtrl+K') {
  await menuKey(accelerator);
  return until(async () => { const s = await palette(); return s.open && s.answered === '' && s; }, 'the palette to open');
}
const closed = () => until(async () => !(await palette()).open, 'the palette to close');

test('Ctrl+K opens the palette in front of the page, with its search box taking the keyboard', async () => {
  await visit(b.base + '/');
  const p = await opened();
  assert.ok(p.typing, 'its search box has the keyboard');
  assert.ok(p.inFront, 'in front of every tab view');
  assert.equal(p.text, '');
  assert.deepEqual(titles(p, 'Open tabs'), ['Fixture']);
  assert.equal(group(p, 'Open tabs').rows[0].hint, 'On screen');
  assert.equal(await b.ui('focus:owner'), 'palette');
});

test('Esc closes it and gives the keyboard back to the page', async () => {
  await key('Escape');
  await closed();
  assert.equal(await b.ui('focus:owner'), (await onScreen()).id);
  // Ctrl+K a second time closes it too.
  await menuKey('CmdOrCtrl+K');
  await until(async () => (await palette()).open, 'the palette to open');
  await menuKey('CmdOrCtrl+K');
  await closed();
});

test("finds a session's tab and the user's own, labelled, and selecting one shows it", async () => {
  const a = b.as('a', 'Research');
  await a.text('navigate', { url: b.base + '/second.html' });
  const mine = await onScreen();

  let p = await search('secon', (s) => titles(s, 'Open tabs').includes('Second'));
  const row = group(p, 'Open tabs').rows.find((r) => r.title === 'Second');
  assert.equal(row.badge, 'Research', "labelled with the session's name");
  assert.equal(row.marked, 'Secon', 'the matched letters are highlighted');
  assert.equal(chosen(p).title, 'Second', 'the best match is chosen');
  await key('Enter');
  await closed();
  const shown = await until(async () => { const t = await onScreen(); return t.id !== mine.id && t; }, 'the session tab on screen');
  assert.equal(shown.url, b.base + '/second.html');

  p = await search('fixture', (s) => titles(s, 'Open tabs')[0] === 'Fixture');
  assert.equal(group(p, 'Open tabs').rows[0].badge, '', "the user's own tab has no label");
  await key('Enter');
  await closed();
  await until(async () => (await onScreen()).id === mine.id, "the user's tab on screen");
});

test('finds a bookmark and a page from history, and opens it', async () => {
  await visit(b.base + '/welcome.html');
  await menuKey('CmdOrCtrl+D'); // bookmark it
  await visit(b.base + '/done.html');
  await visit(b.base + '/');

  let p = await search('welc', (s) => titles(s, 'Bookmarks').includes('Welcome'));
  assert.ok(!titles(p, 'History').includes('Welcome'), 'a bookmarked page is listed once, as a bookmark');
  assert.deepEqual(titles(p, 'Claude'), ['Ask Claude: welc']);

  p = await search('done', (s) => titles(s, 'History').includes('Done'));
  await arrowTo('Done');
  await key('Enter');
  await closed();
  await until(async () => (await onScreen()).url === b.base + '/done.html', 'the page from history to open');
  await visit(b.base + '/');
});

test('runs a menu command, as the menu would', async () => {
  const p = await search('find in', (s) => titles(s, 'Commands')[0] === 'Find in page');
  const row = group(p, 'Commands').rows[0];
  assert.equal(row.hint, 'Ctrl+F', 'shows its shortcut');
  assert.equal(row.detail, 'File', 'and where it is in the menu');
  await arrowTo('Find in page');
  await key('Enter');
  await closed();
  await until(async () => (await b.state()).find.open, 'the find bar to open');
  await b.ui('find:close');
});

test("runs a module's command for the tab on screen", async () => {
  const p = await search('keep awake', (s) => titles(s, 'Commands').some((t) => /^Keep 127\.0\.0\.1.* awake$/.test(t)));
  const row = group(p, 'Commands').rows.find((r) => /^Keep 127/.test(r.title));
  assert.equal(row.detail, 'This tab');
  await arrowTo(row.title);
  await key('Enter');
  await closed();
  const settings = () => JSON.parse(fs.readFileSync(path.join(b.home, 'settings.json'), 'utf8'));
  await until(() => (settings().keepAwake || []).some((h) => h.startsWith('127.0.0.1')), 'the host to be kept awake');
});

test('fuzzy matching ranks word starts and runs of letters first', async () => {
  let p = await search('zoin', (s) => titles(s, 'Commands').length);
  assert.equal(titles(p, 'Commands')[0], 'Zoom in');
  assert.equal(group(p, 'Commands').rows[0].marked, 'Zoin');
  p = await search('vt', (s) => titles(s, 'Commands').length);
  assert.equal(titles(p, 'Commands')[0], 'Vertical tabs');
  p = await search('ntab', (s) => titles(s, 'Commands').length);
  assert.equal(titles(p, 'Commands')[0], 'New tab');
  p = await search('qqqzzz', (s) => s.groups.length);
  assert.deepEqual(p.groups.map((g) => g.label), ['Claude'], 'nothing else matches nonsense');
  await key('Escape');
  await closed();

  // The scorer on its own.
  assert.equal(fuzzy('xyz', 'Zoom in'), null);
  assert.ok(fuzzy('zi', 'Zoom in').score > fuzzy('zi', 'Fuzzier').score, 'word starts beat letters inside words');
  assert.deepEqual(fuzzy('page find', 'Find in page').marks, [[0, 4], [8, 12]], 'words match in any order');
});

test('recently used commands come first', async () => {
  for (const name of ['Zoom out', 'Actual size']) {
    await search(name.toLowerCase(), (s) => titles(s, 'Commands')[0] === name);
    await arrowTo(name);
    await key('Enter');
    await closed();
  }
  const p = await opened();
  assert.equal(p.groups[0].label, 'Recently used');
  assert.deepEqual(p.groups[0].rows.slice(0, 2).map((r) => r.title), ['Actual size', 'Zoom out']);
  assert.equal(chosen(p).title, 'Actual size');
  const z = await search('zoom', (s) => titles(s, 'Commands').length >= 2);
  assert.deepEqual(titles(z, 'Commands').slice(0, 2), ['Zoom out', 'Zoom in'], 'a recent command wins a tie');
  await key('Escape');
  await closed();
});

test('Tab moves between groups, and Ctrl+Shift+A searches open tabs only', async () => {
  let p = await search('second', (s) => s.groups.length >= 2);
  assert.equal(chosen(p).title, p.groups[0].rows[0].title);
  await key('Tab');
  p = await palette();
  assert.equal(chosen(p).title, p.groups[1].rows[0].title, 'Tab goes to the next group');
  await key('Tab', ['shift']);
  p = await palette();
  assert.equal(chosen(p).title, p.groups[0].rows[0].title, 'Shift+Tab comes back');
  await key('Escape');
  await closed();

  p = await opened('CmdOrCtrl+Shift+A');
  assert.equal(p.mode, 'tabs');
  assert.deepEqual(p.groups.map((g) => g.label), ['Open tabs']);
  p = await search('zoom');
  assert.deepEqual(p.groups.map((g) => g.label), [], 'no commands in tab search');
  await key('Escape');
  await closed();
});

test('no Claude session can open or reach the palette', async () => {
  // Ctrl+K pressed by a session in its own tab, and by the Claude panel in the user's.
  const a = b.as('a', 'Research');
  await a.call('press_key', { key: 'Control+K' });
  await b.ui('panel', { tool: 'press_key', args: { key: 'Control+K' } });
  await sleep(600);
  assert.equal((await palette()).open, false);
  // Pages have no bridge to it, and no tool is about it.
  assert.equal(await a.text('evaluate', { code: 'typeof palette + typeof loui' }), '"undefinedundefined"');
  assert.ok(!TOOLS.some((t) => /palette|command/i.test(t.name + t.description)));
  a.end();
});
