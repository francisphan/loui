// Brave, the user's other browser: "Open in Brave" hands the page over, and
// sites on a list (empty to begin with) go to
// Brave instead of opening in the user's tabs. Claude sessions never make Loui
// open another program: their tabs just don't open those sites. Under
// LOUI_TEST nothing is launched; Loui records what it would have opened.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { launch } = require('./drive');

let b, listed;
test.before(async () => {
  b = await launch();
  // 'localhost' reaches the same test pages under another host name.
  listed = `http://localhost:${new URL(b.base).port}/second.html`;
});
test.after(async () => { await b.close(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what, ms = 8000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
    const got = await check();
    if (got) return got;
  }
  assert.fail(`timed out waiting for ${what}`);
}
const onScreen = async () => (await b.state()).tabs.find((t) => t.active);
const opened = () => b.ui('brave:opened');
const sites = async () => (await b.state()).elsewhere.sites;
async function visit(url) {
  await b.ui('go', url);
  return until(async () => { const t = await onScreen(); return t.url === url && !t.loading && t; }, `${url} to load`);
}

test('no site is on the list to begin with (Google sign-in works in Loui: identity.test.js)', async () => {
  assert.deepEqual(await sites(), []);
});

test('Open in Brave hands over the page on screen, and only web pages', async () => {
  await b.ui('go', '');
  await until(async () => (await onScreen()).url === '' && !(await onScreen()).loading, 'a blank page');
  await b.ui('brave:open');
  assert.deepEqual(await opened(), [], 'a blank tab has nothing to hand over');
  await visit(`${b.base}/second.html`);
  await b.ui('brave:open');
  assert.deepEqual(await opened(), [`${b.base}/second.html`]);
});

test('a listed site goes to Brave, and the tab says so', async () => {
  await b.ui('brave:add', 'https://LocalHost/some/page');
  assert.deepEqual(await sites(), ['localhost'], 'kept as a host name');
  const file = JSON.parse(fs.readFileSync(path.join(b.home, 'settings.json'), 'utf8'));
  assert.deepEqual(file.openInBrave, ['localhost']);

  await b.ui('go', listed);
  await until(async () => (await opened()).includes(listed), 'the hand-over');
  const tab = await until(async () => { const t = await onScreen(); return /^Opened in/.test(t.title) && t; }, 'the note');
  assert.equal(tab.url, listed, 'the address bar names the page that was sent');
  assert.match(await b.ui('tab:eval', 'document.body.innerText'), /localhost is on your list/);
});

test('a page that keeps trying is handed over once every few seconds at most', async () => {
  const before = (await opened()).length;
  await visit(`${b.base}/second.html`);
  await b.ui('tab:eval', `location.href = ${JSON.stringify(listed + '?again')}`);
  await until(async () => (await onScreen()).title === 'Not opened', 'the note');
  assert.equal((await opened()).length, before);
});

test('a link to a listed site, followed after a pause, goes to Brave', async () => {
  await sleep(3100);
  await visit(`${b.base}/second.html`);
  await b.ui('tab:eval', `location.href = ${JSON.stringify(listed + '?link')}`);
  await until(async () => (await opened()).includes(listed + '?link'), 'the hand-over');
  await until(async () => /^Opened in/.test((await onScreen()).title), 'the note');
});

test("the note's link takes the site off the list and opens it in Loui", async () => {
  await b.ui('tab:eval', "document.querySelector('a').click()");
  await until(async () => !(await sites()).includes('localhost'), 'the site to come off the list');
  await until(async () => (await onScreen()).url === listed + '?link', 'the page to open in Loui');
});

test("a page can't take a site off the list by imitating the note's link", async () => {
  await b.ui('brave:add', 'localhost');
  await visit(`${b.base}/second.html`);
  await b.ui('tab:eval', "location.href = 'https://loui.invalid/undo/0123456789abcdef01234567'");
  await sleep(500);
  assert.ok((await sites()).includes('localhost'));
});

test("a Claude session can't open a listed site or make Loui open Brave", async () => {
  const before = (await opened()).length;
  const s = b.as('brave-s', 'Claude Code');
  await assert.rejects(s.text('navigate', { url: listed }), /Ask the user to do this step themselves/);
  await s.text('navigate', { url: `${b.base}/second.html` });
  await s.call('evaluate', { code: `location.href = ${JSON.stringify(listed)}` }).catch(() => {});
  await until(async () => /Not opened/.test(await s.text('snapshot')), 'the note in the session\'s tab');
  assert.match(await s.text('snapshot'), /doesn't open it in Claude's tabs/);
  assert.equal((await opened()).length, before);
  s.end();
});

test('a site can be taken off the list', async () => {
  await b.ui('brave:remove', 'localhost');
  assert.deepEqual(await sites(), []);
  await visit(listed);
});
