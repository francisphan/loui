// Site permissions: a site in the user's tab asks, the window asks the user,
// and their answer is what the site gets. Sites in a Claude session's tabs are
// refused without asking.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { launch } = require('./drive');

let b, site;
test.before(async () => {
  b = await launch();
  site = new URL(b.base).host;
});
test.after(async () => { await b.close(); });

const wait = async (what, check, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) {
    const value = await check();
    if (value) return value;
  }
  throw new Error(`timed out waiting for ${what}`);
};
const onScreen = async () => (await b.state()).tabs.find((t) => t.active);
// Opens the asking page in the user's tab on screen. Each visit is numbered, so
// that result() reads this visit's answers and not the last one's.
let visit = 0;
const open = (kinds) => b.ui('go', `${b.base}/ask.html?${kinds}&${++visit}`);
const prompt = () => wait('a prompt', async () => (await b.state()).permission);
const result = () => wait('the page to get its answer', async () => {
  const title = (await onScreen()).title;
  return title.endsWith(` (${visit})`) && title.slice(0, -` (${visit})`.length);
});
const answer = (p, allow, remember = false) => b.ui('permission:answer', { id: p.id, allow, remember });

test('a site asking for the camera gets a prompt naming the site, and Allow is honoured', async () => {
  await open('camera');
  const p = await prompt();
  assert.equal(p.site, site);
  assert.equal(p.wants, 'use your camera');
  assert.equal(p.canRemember, true);
  await answer(p, true);
  assert.equal(await result(), 'camera=allowed');
  assert.equal((await b.state()).permission, null);
});

test('Block is honoured, and is asked again on the next visit unless remembered', async () => {
  await open('geolocation');
  const p = await prompt();
  assert.equal(p.wants, 'know your location');
  await answer(p, false);
  assert.equal(await result(), 'geolocation=blocked');
  await open('geolocation');
  await answer(await prompt(), false);
  assert.equal(await result(), 'geolocation=blocked');
});

test('camera and microphone together are one question', async () => {
  await open('both');
  const p = await prompt();
  assert.equal(p.wants, 'use your camera and microphone');
  await answer(p, true);
  assert.equal(await result(), 'both=allowed');
});

test('a remembered answer is kept, used without asking, and can be forgotten', async () => {
  await open('notifications');
  const p = await prompt();
  assert.equal(p.wants, 'show notifications');
  await answer(p, true, true);
  assert.equal(await result(), 'notifications=allowed');

  const kept = (await b.state()).sitePermissions;
  assert.deepEqual(kept, [{ origin: b.base, kind: 'notifications', site, name: 'Notifications', allowed: true }]);
  const file = JSON.parse(fs.readFileSync(path.join(b.home, 'permissions.json'), 'utf8'));
  assert.deepEqual(file, { [b.base]: { notifications: 'allow' } });

  await open('notifications');
  assert.equal(await result(), 'notifications=allowed');
  assert.equal((await b.state()).permission, null, 'no prompt the second time');

  await b.ui('permission:forget', { origin: b.base, kind: 'notifications' });
  assert.deepEqual((await b.state()).sitePermissions, []);
  await open('notifications');
  await answer(await prompt(), false, true);
  assert.equal(await result(), 'notifications=blocked');
  await open('notifications');
  assert.equal(await result(), 'notifications=blocked', 'a remembered block is used without asking');
  await b.ui('permission:forget', { origin: b.base, kind: 'notifications' });
});

test('screen sharing is asked every time and cannot be remembered', async () => {
  await open('screen');
  const p = await prompt();
  assert.equal(p.wants, 'see your whole screen');
  assert.equal(p.canRemember, false);
  await answer(p, true, true);
  assert.equal(await result(), 'screen=allowed');
  assert.deepEqual((await b.state()).sitePermissions, []);
  await open('screen');
  await answer(await prompt(), false);
  assert.equal(await result(), 'screen=blocked');
});

test('questions asked together come one at a time, and a stale answer is ignored', async () => {
  await open('camera,geolocation');
  const first = await prompt();
  await answer(first, true);
  const second = await wait('the second prompt', async () => {
    const p = (await b.state()).permission;
    return p && p.id !== first.id && p;
  });
  await answer(first, false); // already answered: changes nothing
  assert.equal((await b.state()).permission?.id, second.id);
  await answer(second, false);
  // Either may arrive first; the first was allowed and the second blocked.
  const [yes, no] = first.wants === 'use your camera' ? ['camera', 'geolocation'] : ['geolocation', 'camera'];
  const title = await result();
  assert.match(title, new RegExp(`${yes}=allowed`));
  assert.match(title, new RegExp(`${no}=blocked`));
});

test('leaving the page drops its question', async () => {
  await open('camera');
  const p = await prompt();
  await b.ui('go', `${b.base}/second.html`);
  await wait('the prompt to go', async () => (await b.state()).permission === null);
  await answer(p, true); // too late: nothing to answer
  assert.equal((await b.state()).permission, null);
});

test('a session\'s tab is refused without a prompt, even where the user said yes', async () => {
  await open('notifications');
  await answer(await prompt(), true, true);
  assert.equal(await result(), 'notifications=allowed');

  const s = b.as('perm-s', 'Claude Code');
  await s.text('navigate', { url: `${b.base}/ask.html` });
  for (const kind of ['camera', 'microphone', 'geolocation', 'notifications', 'screen']) {
    assert.equal(await s.text('evaluate', { code: `askAll(['${kind}'])` }), `"${kind}=blocked"`);
  }
  assert.equal(await s.text('evaluate', { code: 'Notification.permission' }), '"denied"');
  assert.equal((await b.state()).permission, null, 'the user was never asked');
  s.end();
  await b.ui('permission:forget', { origin: b.base, kind: 'notifications' });
});

test('a question from a tab the user hands to a session is dropped', async () => {
  const s = b.as('perm-h', 'Claude Desktop');
  await s.text('navigate', { url: `${b.base}/second.html` });
  await open('camera');
  await prompt();
  const asked = s.text('request_tab');
  await wait('the hand-over question', async () => (await b.state()).asking);
  await b.ui('handoff:answer', true);
  await asked;
  await wait('the prompt to go', async () => (await b.state()).permission === null);
  const lent = (await b.state()).tabs.find((t) => t.group === 'perm-h' && t.url.includes('ask.html'));
  assert.ok(lent, 'the asking tab is now the session\'s');
  assert.equal(await s.text('evaluate', { code: 'document.title' }), `"camera=blocked (${visit})"`);
  s.end();
});
