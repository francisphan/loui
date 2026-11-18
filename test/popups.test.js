// A page's pop-up (window.open) opens as a tab that is still the opener's
// window: it can report back through window.opener and close itself, which is
// how sign-in pop-ups work ("Sign in with Google" on another site). And the
// built-in federated sign-in Electron cannot show is not offered to pages.
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
const tabs = async () => (await b.state()).tabs;
const js = (id, code, acted = false) => b.ui('tab:js', { id, code, acted });

test("a pop-up the user's page opens is a tab that can answer its opener, and closes itself", async () => {
  await b.ui('go', b.base + '/opener.html');
  const opener = await until(async () => { const t = (await tabs()).find((x) => x.active); return t.title === 'Opener' && !t.loading && t; }, 'the page');
  await js(opener.id, "document.getElementById('open').click(); 1", true); // the user's click
  const pop = await until(async () => (await tabs()).find((t) => t.url.includes('/popup.html') && !t.loading), 'the pop-up as a tab');
  assert.equal(pop.group, 'you');
  assert.equal(pop.active, true, 'shown, as the page on screen opened it');
  assert.equal(await js(pop.id, 'document.getElementById("opener").textContent'), 'true', 'it has its opener');
  assert.equal(await js(opener.id, '!!window.pop && !window.pop.closed'), true, 'and the opener has it');
  await js(pop.id, "document.getElementById('finish').click(); 1").catch(() => {}); // the pop-up closes under the script that pressed its button
  await until(async () => !(await tabs()).some((t) => t.id === pop.id), 'the pop-up\'s tab to close with it');
  assert.equal(await js(opener.id, 'document.getElementById("out").textContent'), 'heard: signed in');
  assert.equal(await js(opener.id, 'window.pop.closed'), true);
  assert.equal((await tabs()).find((t) => t.active).id, opener.id, 'the opener is on screen again');
});

test("a session's pop-up stays in its group, with its opener", async () => {
  const s = b.as('pop', 'Claude Code');
  const page = await s.text('navigate', { url: b.base + '/opener.html' });
  await s.text('click', { ref: /button "Sign in" \[(e\d+)\]/.exec(page)[1] });
  const pop = await until(async () => (await tabs()).find((t) => t.url.includes('/popup.html') && t.group === 'pop'), "the pop-up in the session's group");
  assert.equal(await s.text('evaluate', { code: '!!window.opener' }), 'true');
  await s.text('click', { ref: /button "Finish" \[(e\d+)\]/.exec(await s.text('snapshot'))[1] }).catch(() => {}); // its tab closes under the call
  await until(async () => !(await tabs()).some((t) => t.id === pop.id), 'its tab to close');
  assert.match(await s.text('snapshot'), /heard: signed in/);
  s.end();
});

test('the pop-up opens beside its opener, and closing itself brings the opener back', async () => {
  const before = (await tabs()).find((x) => x.active);
  await b.ui('go', b.base + '/opener.html');
  const opener = await until(async () => { const t = (await tabs()).find((x) => x.id === before.id); return t.title === 'Opener' && !t.loading && t; }, 'the page');
  await b.ui('panel', { tool: 'tabs', args: { action: 'new' } }); // other tabs after it
  await b.ui('panel', { tool: 'tabs', args: { action: 'new' } });
  await b.ui('tab:select', opener.id);
  await until(async () => (await tabs()).find((t) => t.active)?.id === opener.id, 'the opener on screen');
  await js(opener.id, "document.getElementById('open').click(); 1", true);
  const pop = await until(async () => (await tabs()).find((t) => t.url.includes('/popup.html') && !t.loading), 'the pop-up');
  const mine = (await tabs()).filter((t) => t.group === 'you').map((t) => t.id);
  assert.equal(mine[mine.indexOf(opener.id) + 1], pop.id, 'right after its opener');
  assert.ok(mine.length > mine.indexOf(pop.id) + 1, 'with other tabs after it');
  await js(pop.id, "document.getElementById('finish').click(); 1").catch(() => {});
  await until(async () => !(await tabs()).some((t) => t.id === pop.id), 'the pop-up to close');
  await until(async () => (await tabs()).find((t) => t.active)?.id === opener.id, 'the opener on screen, not the tab beside the pop-up');
});

test('a pop-up handed to someone else is cut off from the page that opened it', async () => {
  const s = b.as('cut', 'Claude Code');
  const page = await s.text('navigate', { url: b.base + '/opener.html' });
  await s.text('click', { ref: /button "Sign in" \[(e\d+)\]/.exec(page)[1] });
  const pop = await until(async () => (await tabs()).find((t) => t.url.includes('/popup.html') && t.group === 'cut' && !t.loading), 'the pop-up');
  const opener = (await tabs()).find((t) => t.group === 'cut' && t.id !== pop.id);
  await b.ui('tab:move', { id: pop.id, group: 'you' }); // the user takes the pop-up
  const moved = await until(async () => (await tabs()).find((t) => t.id === pop.id && t.group === 'you' && !t.loading && t.url.includes('/popup.html')), 'it among the user\'s tabs, on the same page');
  assert.equal(await js(moved.id, 'document.getElementById("opener").textContent'), 'false', 'it no longer has an opener');
  assert.equal(await js(opener.id, 'window.pop.closed'), true, 'and the session\'s page no longer holds it');
  await b.ui('tab:close', moved.id);
  s.end();
});

test('a page is not offered the federated sign-in Loui has no screen for', async () => {
  const t = (await tabs()).find((x) => x.active);
  assert.equal(await js(t.id, 'typeof IdentityCredential'), 'undefined');
});
