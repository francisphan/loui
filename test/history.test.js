// History: what the user visits is remembered and offered back as they type
// in the address bar; Claude sessions' pages stay out of it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { launch } = require('./drive');

let b;
test.before(async () => { b = await launch(); });
test.after(async () => { await b.close(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Waits for check() to return something truthy, and returns it.
async function until(check, what, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
    const got = await check();
    if (got) return got;
  }
  assert.fail(`timed out waiting for ${what}`);
}
const onScreen = async () => (await b.state()).tabs.find((t) => t.active);
// The user opens a page in the tab on screen, and it finishes loading.
async function visit(url) {
  await b.ui('go', url);
  await until(async () => { const t = await onScreen(); return t.url === url && !t.loading && t.title; }, `${url} to load`);
}
const type = (text) => b.ui('address:type', text);
const key = (name) => b.ui('address:key', name);
const suggestions = () => b.ui('suggestions');
const shown = (urls) => until(async () => {
  const s = await suggestions();
  return s.open && urls(s.rows.map((r) => r.url)) && s;
}, 'suggestions');
const chrome = (code) => b.ui('chrome:eval', code);
const address = () => chrome("document.getElementById('address').value");
// The part of the address bar that is selected: what was completed, not typed.
const completed = () => chrome("(() => { const a = document.getElementById('address'); return a.value.slice(a.selectionStart, a.selectionEnd); })()");
const host = () => b.base.replace('http://', '');
const search = (text) => chrome(`(() => {
  const box = document.getElementById('history-search');
  box.value = ${JSON.stringify(text)};
  box.dispatchEvent(new Event('input'));
})()`);
const historyRows = () => chrome("[...document.querySelectorAll('#history-list .history-row')].map((r) => r.dataset.url)");

test('pages the user visits are remembered, with title, time and number of visits', async () => {
  await visit(b.base + '/');
  await visit(b.base + '/second.html');
  await visit(b.base + '/');
  const file = path.join(b.home, 'history.json');
  const saved = await until(() => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')).entries; } catch { return null; }
  }, 'history.json to be written');
  const home = saved.find((e) => e.url === b.base + '/');
  assert.equal(home.title, 'Fixture');
  assert.equal(home.visits, 2);
  assert.ok(Date.now() - home.last < 60000);
  assert.equal(saved.find((e) => e.url === b.base + '/second.html').title, 'Second');
});

test('pages Claude sessions visit in their own tabs are left out', async () => {
  const a = b.as('a', 'Claude Code');
  await a.text('navigate', { url: b.base + '/second.html?for-claude' });
  await b.text('navigate', { url: b.base + '/second.html?local-session' });
  await sleep(700);
  const saved = JSON.parse(fs.readFileSync(path.join(b.home, 'history.json'), 'utf8')).entries;
  assert.ok(!saved.some((e) => /for-claude|local-session/.test(e.url)), JSON.stringify(saved.map((e) => e.url)));
  a.end();
});

test('typing in the address bar suggests matching pages, most visited first', async () => {
  await type('127.0.0.1');
  const s = await shown((urls) => urls.length === 2);
  assert.deepEqual(s.rows.map((r) => r.url), [b.base + '/', b.base + '/second.html']);
  assert.equal(s.rows[0].title, 'Fixture');
  assert.ok(s.inFront, 'the list is in front of the page, not behind it');
  assert.deepEqual(s.rows.map((r) => r.chosen), [true, false], 'the first row is what Enter does');

  await type('secon');
  const by = await shown((urls) => urls.length === 2);
  assert.equal(by.rows[1].url, b.base + '/second.html', 'matched by title and address');
  await type('nothing like this');
  const none = await shown((urls) => urls.length === 1);
  assert.equal(none.rows[0].kind, 'enter', 'only the search is left when nothing matches');
});

test('the address of a page visited before is completed inline, and Enter goes there', async () => {
  // In the site's name: completed up to the site, as selected text.
  await type('127');
  const s = await shown((urls) => urls.length === 2);
  assert.equal(await address(), host());
  assert.equal(await completed(), host().slice(3));
  assert.deepEqual([s.rows[0].kind, s.rows[0].url, s.rows[0].note], ['enter', b.base + '/', `Go to ${host()}`], 'the first row says where Enter goes');
  // Typing on replaces the completion; past the slash the whole address is completed.
  await type(`${host()}/sec`);
  await until(async () => (await address()) === `${host()}/second.html`, 'the address to be completed');
  assert.equal(await completed(), 'ond.html');
  // Backspace takes the completion away, and nothing is completed until the next character.
  await key('Backspace');
  await until(async () => (await address()) === `${host()}/sec`, 'the completion to go');
  await sleep(400);
  assert.equal(await address(), `${host()}/sec`);
  const plain = await shown((urls) => urls.length === 2);
  assert.equal(plain.rows[0].url, `${b.base}/sec`, 'Enter now opens what is typed');
  // The next character completes again, and Enter opens the completed page.
  await b.ui('chrome:eval', "document.getElementById('address').setSelectionRange(99, 99)");
  await b.ui('address:insert', 'o');
  await until(async () => (await address()) === `${host()}/second.html`, 'the address to be completed again');
  await key('Enter');
  await until(async () => (await onScreen()).url === b.base + '/second.html', 'the completed page to open');
  assert.equal((await suggestions()).open, false);
  await visit(b.base + '/');
});

test('words that are not an address say that Enter searches, and name the engine', async () => {
  await type('secon');
  const s = await shown((urls) => urls.length === 2);
  assert.equal(s.rows[0].title, 'Search Brave Search for “secon”');
  assert.match(s.rows[0].url, /^https:\/\/search\.brave\.com\/search\?q=secon$/);
  assert.equal(await address(), 'secon', 'a page matched by its title is offered, not completed');
  await key('Escape');
  await key('Escape');
});

test('an open tab of the user\'s is offered as "Switch to tab", and a session\'s tab is not', async () => {
  const first = await onScreen();
  await b.ui('tab:new', b.base + '/second.html?open-tab');
  const other = await until(async () => { const t = await onScreen(); return t.id !== first.id && !t.loading && t.title && t; }, 'the new tab');
  const a = b.as('tabs', 'Claude Code');
  await a.text('navigate', { url: b.base + '/second.html?claude-tab' });
  await b.ui('tab:select', first.id);
  await type('second');
  const s = await shown((urls) => urls.some((u) => u.includes('open-tab')));
  const row = s.rows.findIndex((r) => r.url.includes('open-tab'));
  assert.equal(s.rows[row].kind, 'tab');
  assert.match(s.rows[row].note, /^Switch to tab · /);
  assert.ok(!s.rows.some((r) => r.url.includes('claude-tab')), 'a session\'s tab is not the user\'s to switch to');
  await b.ui('suggestions:click', row);
  await until(async () => (await onScreen()).id === other.id, 'the open tab to come on screen');
  assert.equal((await b.state()).tabs.filter((t) => t.url.includes('open-tab')).length, 1, 'no second copy was opened');
  a.end();
  await b.ui('history:remove', b.base + '/second.html?open-tab'); // the tests below count the pages in history
  await b.ui('tab:close', other.id);
  await until(async () => (await onScreen()).id === first.id, 'the first tab again');
});

test('arrow keys move through the suggestions and Enter opens one', async () => {
  await visit(b.base + '/second.html');
  await type('127.0.0.1');
  await shown((urls) => urls.length === 2);
  await key('Down');
  const s = await until(async () => { const got = await suggestions(); return got.rows[1]?.chosen && got; }, 'the second row to be highlighted');
  assert.deepEqual(s.rows.map((r) => r.chosen), [false, true]);
  assert.equal(await address(), b.base + '/second.html');
  await key('Up');
  assert.equal(await address(), host(), 'back on the first row: what was typed, completed');
  await key('Enter');
  await until(async () => (await onScreen()).url === b.base + '/', 'the suggested page to open');
  assert.equal((await suggestions()).open, false);
});

test('Esc closes the suggestions and keeps what was typed', async () => {
  await type('fixt');
  await shown((urls) => urls.length === 2);
  await key('Escape');
  await until(async () => !(await suggestions()).open, 'the list to close');
  assert.equal(await address(), 'fixt');
  assert.equal(await chrome("document.activeElement.id"), 'address');
});

test('clicking a suggestion opens it', async () => {
  await type('second');
  const s = await shown((urls) => urls.length === 2);
  await b.ui('suggestions:click', s.rows.findIndex((r) => r.url === b.base + '/second.html'));
  await until(async () => (await onScreen()).url === b.base + '/second.html', 'the clicked page to open');
});

test('the history panel lists, searches and deletes pages, and clears all', async () => {
  await chrome("document.getElementById('history-toggle').click()");
  assert.deepEqual(await until(async () => (await historyRows()).length === 2 && historyRows(), 'the list'),
    [b.base + '/second.html', b.base + '/'], 'most recent first');

  await search('fixture');
  await until(async () => (await historyRows()).length === 1, 'the search');
  assert.deepEqual(await historyRows(), [b.base + '/']);

  await chrome("document.querySelector('.history-row .remove').click()");
  await until(async () => (await historyRows()).length === 0, 'the page to be removed');
  assert.match(await chrome("document.getElementById('history-list').textContent"), /No pages in your history match/);
  await type('fixt');
  const left = await shown((urls) => urls.length === 1);
  await sleep(400);
  assert.deepEqual((await suggestions()).rows.map((r) => r.kind), ['enter'], 'a removed page is no longer suggested');
  assert.equal(left.rows[0].kind, 'enter');
  await key('Escape');

  await search('');
  await until(async () => (await historyRows()).length === 1, 'the rest of history');
  await chrome("document.getElementById('history-clear').click()");
  await chrome("document.getElementById('history-confirm-yes').click()");
  await until(async () => (await historyRows()).length === 0, 'history to be cleared');
  assert.match(await chrome("document.getElementById('history-list').textContent"), /Pages you visit show up here/);
  await sleep(700);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(b.home, 'history.json'), 'utf8')).entries, []);
});
