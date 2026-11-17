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
  assert.ok(!s.rows.some((r) => r.chosen), 'nothing is highlighted until the user moves to it');

  await type('secon');
  const by = await shown((urls) => urls.length === 1);
  assert.equal(by.rows[0].url, b.base + '/second.html', 'matched by title and address');
  await type('nothing like this');
  await until(async () => !(await suggestions()).open, 'the list to close when nothing matches');
});

test('arrow keys move through the suggestions and Enter opens one', async () => {
  await visit(b.base + '/second.html');
  await type('127.0.0.1');
  await shown((urls) => urls.length === 2);
  await key('Down');
  await key('Down');
  const s = await until(async () => { const got = await suggestions(); return got.rows[1]?.chosen && got; }, 'the second row to be highlighted');
  assert.deepEqual(s.rows.map((r) => r.chosen), [false, true]);
  assert.equal(await chrome("document.getElementById('address').value"), b.base + '/second.html');
  await key('Up');
  assert.equal(await chrome("document.getElementById('address').value"), b.base + '/');
  await key('Enter');
  await until(async () => (await onScreen()).url === b.base + '/', 'the suggested page to open');
  assert.equal((await suggestions()).open, false);
});

test('Esc closes the suggestions and keeps what was typed', async () => {
  await type('fixt');
  await shown((urls) => urls.length === 1);
  await key('Escape');
  await until(async () => !(await suggestions()).open, 'the list to close');
  assert.equal(await chrome("document.getElementById('address').value"), 'fixt');
  assert.equal(await chrome("document.activeElement.id"), 'address');
});

test('clicking a suggestion opens it', async () => {
  await type('second');
  await shown((urls) => urls.length === 1);
  await b.ui('suggestions:click', 0);
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
  await sleep(400);
  assert.equal((await suggestions()).open, false, 'a removed page is no longer suggested');

  await search('');
  await until(async () => (await historyRows()).length === 1, 'the rest of history');
  await chrome("document.getElementById('history-clear').click()");
  await chrome("document.getElementById('history-confirm-yes').click()");
  await until(async () => (await historyRows()).length === 0, 'history to be cleared');
  assert.match(await chrome("document.getElementById('history-list').textContent"), /Pages you visit show up here/);
  await sleep(700);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(b.home, 'history.json'), 'utf8')).entries, []);
});
