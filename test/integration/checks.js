// What an installed Loui must do on any system: the checks the Windows
// (windows.test.js) and Debian (debian.test.js) integration tests share. Each
// of those installs the app its system's way and starts it; these drive it
// over its control socket and know nothing of how it got there.
const assert = require('node:assert/strict');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, check, ms = 15000) {
  let last;
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) {
    last = await check();
    if (last) return last;
  }
  assert.fail(`timed out waiting for ${what}`);
}

// app: () => the running app, as test/drive.js's launch() or attach() gave it
// (asked each time: the tests start it more than once).
function helpers(app) {
  const onScreen = async (a = app()) => (await a.state()).tabs.find((t) => t.active);
  const mine = async (a = app()) => (await a.state()).tabs.filter((t) => t.group === 'you');
  async function visit(url) {
    await app().ui('go', url);
    return until(`${url} to load`, async () => { const t = await onScreen(); return t.url === url && !t.loading && t; });
  }
  const js = async (code) => app().ui('tab:js', { id: (await onScreen()).id, code });
  return { onScreen, mine, visit, js };
}

// The app, driven as a session and as the user. step: the file's own test()
// (it leaves a picture of the screen when one fails); base: () => the
// address of the fixture pages.
function driveChecks({ step, app, base }) {
  const { onScreen, visit } = helpers(app);

  step('a session fills a form in a background tab', async () => {
    const user = await onScreen();
    const s = app().as('s', 'Integration test');
    const page = await s.text('navigate', { url: base() });
    const ref = (re) => page.match(re)[1];
    await s.text('type', { ref: ref(/textbox "Your name" \[(e\d+)\]/), text: 'Ada', clear: true });
    assert.match(await s.text('click', { ref: ref(/button "Greet" \[(e\d+)\]/) }), /Hello, Ada/);
    assert.equal((await onScreen()).id, user.id, 'the user\'s tab stayed on screen');
    const [note, image] = await s.call('screenshot');
    assert.equal(image?.type, 'image', note?.text);
    assert.ok(Buffer.from(image.data, 'base64').length > 2000, 'a picture of a tab that is not on screen');
  });

  step('the activity log records its steps, with a picture', async () => {
    const log = await until('the log to have a step with a picture', async () => {
      const s = (await app().ui('activity:list')).items.find((x) => x.label === 'Integration test');
      const l = s && await app().ui('activity:get', s.id);
      return l?.steps.some((x) => x.thumb) && l;
    }, 20000);
    assert.ok(log.steps.length >= 3, log.steps.map((x) => x.label).join(', '));
  });

  step('picture in picture shows frames of the session\'s tab', async () => {
    await app().ui('pip:open', 's');
    await until('frames in the small window', async () => { const v = await app().ui('pip:state'); return v.open && v.sent > 0; });
    await app().ui('pip:close');
  });

  step('the command palette opens in front of the page', async () => {
    await app().ui('menu:key', 'CmdOrCtrl+K');
    const p = await until('the palette', async () => { const v = await app().ui('palette'); return v.open && v; });
    assert.ok(p.inFront);
    await app().ui('palette:key', { key: 'Escape' });
    await until('it to close', async () => !(await app().ui('palette')).open);
  });

  step('a second window and a private one; reader view in the private one', async () => {
    const two = await app().ui('window:new');
    const priv = await app().ui('window:new', { private: true });
    const ws = await app().ui('windows');
    assert.equal(ws.length, 3);
    assert.equal(ws.filter((w) => w.private).length, 1);
    const inPriv = (ui, arg) => app().ui('in-window', { window: priv, ui, arg });
    await inPriv('go', base() + '/article.html');
    const t = await until('the article to load', async () => {
      const a = (await inPriv('state')).tabs.find((x) => x.active);
      return a && !a.loading && a.url.endsWith('article.html') && a;
    });
    await inPriv('reader:toggle');
    await until('reader view', async () => (await app().ui('tab:js', { id: t.id, code: 'location.protocol' }).catch(() => '')) === 'loui-reader:');
    assert.match(await app().ui('tab:js', { id: t.id, code: 'document.body.innerText' }), /Lighthouse Keepers of Ushant/);
    await app().ui('window:close', priv);
    await app().ui('window:close', two);
    await until('one window again', async () => (await app().ui('windows')).length === 1);
  });

  step('a page\'s full screen covers the tabs and toolbar, and gives them back', async () => {
    const ft = await visit(base() + '/fullscreen.html');
    const covers = (p) => p.view.x === 0 && p.view.y === 0 && p.view.width === p.window.width && p.view.height === p.window.height;
    await app().ui('tab:press', { id: ft.id, x: 200, y: 200 });
    await until('the page to have the whole window', async () => { const p = await app().ui('tab:place', ft.id); return p.full && covers(p); });
    await app().ui('tab:press', { id: ft.id, x: 200, y: 200 });
    await until('the tabs and toolbar to come back', async () => { const p = await app().ui('tab:place', ft.id); return !p.full && !covers(p); });
  });

  step('a tab\'s icon arrives and is drawn', async () => {
    await visit(base() + '/icon.html');
    const tab = await until('the icon', async () => { const t = await onScreen(); return t.favicon && t; });
    assert.match(tab.favicon, /^loui-icon:\/\/tab\//);
    await until('the icon to be drawn in the tab strip', () => app().ui('chrome:eval',
      "[...document.querySelectorAll('.tab img')].some((i) => i.src.startsWith('loui-icon:') && i.naturalWidth > 0)"));
  });

  step('a new tab has an empty address bar', async () => {
    await app().ui('chrome:eval', "document.getElementById('address').focus()");
    const before = (await onScreen()).id;
    await app().ui('tab:new', '');
    const fresh = await until('the new tab', async () => { const t = await onScreen(); return t.id !== before && t; });
    await sleep(600);
    assert.equal(await app().ui('chrome:eval', "document.getElementById('address').value"), '');
    await app().ui('tab:close', fresh.id);
  });

  step('the Settings window opens', async () => {
    await app().ui('menu:key', 'CmdOrCtrl+,');
    await until('the Settings window', async () => (await app().ui('settings:state').catch(() => null))?.windows === 1);
    await app().ui('settings:close');
    await until('it to close', async () => (await app().ui('settings:state')).windows === 0);
  });
}

// Leaves the user with tabs on the fixture pages only, so that a restart has
// something to bring back; returns their addresses. Quit after it.
async function tabsToComeBackTo({ app, base }) {
  const { mine } = helpers(app);
  await app().ui('tab:new', base() + '/second.html');
  await app().ui('tab:new', base() + '/plain.html');
  await until('the new tabs to load', async () => (await mine()).filter((t) => /(second|plain)\.html$/.test(t.url) && !t.loading).length === 2);
  for (const t of await mine()) if (!t.url.startsWith(base())) await app().ui('tab:close', t.id);
  const before = (await mine()).map((t) => t.url);
  assert.ok(before.length >= 2 && before.every((u) => u.startsWith(base())), before.join(' '));
  await sleep(1500); // what is open is written a moment after it changes
  return before;
}

// A new tab shows the start page (settings.json says newTab: 'start').
async function startPageCheck({ app }) {
  const { onScreen } = helpers(app);
  const beforeId = (await onScreen()).id;
  await app().ui('tab:new', '');
  const tab = await until('the start page', async () => {
    const t = await onScreen();
    return t.id !== beforeId && !t.loading && (await app().ui('tab:js', { id: t.id, code: 'location.protocol' }).catch(() => '')) === 'loui-start:' && t;
  });
  assert.equal(tab.url, '', 'with an empty address bar');
  assert.equal(tab.title, 'New tab');
  assert.match(await app().ui('tab:js', { id: tab.id, code: 'document.body.innerText' }), /Loui/);
  await app().ui('tab:close', tab.id);
  await sleep(1500);
}

module.exports = { sleep, until, helpers, driveChecks, tabsToComeBackTo, startPageCheck };
