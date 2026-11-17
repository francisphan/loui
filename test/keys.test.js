// The keyboard and the menus: where the keyboard goes when a panel or strip
// closes, Esc in every panel, the tab shortcuts, the application menu's groups
// and checkboxes, and the right-click menus of tabs and pages.
const test = require('node:test');
const assert = require('node:assert/strict');
const { launch } = require('./drive');

let b;
test.before(async () => { b = await launch(); });
test.after(async () => { await b?.close(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what, ms = 8000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(80)) {
    const got = await check();
    if (got) return got;
  }
  assert.fail(`timed out waiting for ${what}`);
}
const chrome = (code) => b.ui('chrome:eval', code);
const menuKey = (accelerator) => b.ui('menu:key', accelerator); // as the keyboard shortcut does
const press = (key) => b.ui('address:key', key); // a key pressed in the window chrome
const owner = () => b.ui('focus:owner');
const tabs = async () => (await b.state()).tabs;
const mine = async () => (await tabs()).filter((t) => t.group === 'you');
const onScreen = async () => (await tabs()).find((t) => t.active);
const hidden = (id) => chrome(`document.getElementById('${id}').hidden`);
const focused = () => chrome('document.activeElement.id');
// The page of the tab on screen has the keyboard.
const pageHasKeys = () => until(async () => (await owner()) === (await onScreen()).id, 'the page to have the keyboard');
async function open(url) {
  await b.ui('tab:new', url);
  return until(async () => { const t = await onScreen(); return t.url === url && !t.loading && t; }, `${url} to load`);
}

let a, second, third;

test('Esc in the address bar gives the keyboard back to the page', async () => {
  await b.ui('go', b.base + '/');
  a = await until(async () => { const t = await onScreen(); return t.url === b.base + '/' && !t.loading && t; }, 'the page');
  await b.ui('address:type', 'zzqq');
  assert.equal(await owner(), 'chrome');
  await press('Escape');
  await pageHasKeys();
  assert.equal(await chrome("document.getElementById('address').value"), b.base + '/', 'and the address is the page\'s again');
});

test('History, Bookmarks, Passwords and Sessions close on Esc from anywhere in the panel, and the page has the keyboard again', async () => {
  for (const [name, show, inside] of [
    ['history', () => menuKey('CmdOrCtrl+H'), 'history-clear'],
    ['bookmarks', () => menuKey('CmdOrCtrl+Shift+O'), 'bookmarks-import'],
    ['passwords', () => b.ui('passwords:panel'), 'passwords-close'],
    ['activity', () => chrome("document.getElementById('activity-open').click()"), 'activity-close'],
  ]) {
    await show();
    await until(async () => !(await hidden(name)), `${name} to open`);
    // Not in the search field: on a button of the panel.
    await chrome(`document.getElementById('${inside}').disabled = false; document.getElementById('${inside}').focus()`);
    assert.equal(await focused(), inside);
    await press('Escape');
    await until(() => hidden(name), `${name} to close`);
    await pageHasKeys();
  }
  // A question in the panel is what the first Esc closes.
  await menuKey('CmdOrCtrl+Shift+Delete');
  await until(async () => !(await hidden('history-confirm')), 'History to open on "Clear all?"');
  assert.equal(await focused(), 'history-confirm-yes');
  await press('Escape');
  assert.deepEqual([await hidden('history-confirm'), await hidden('history')], [true, false]);
  await press('Escape');
  await until(() => hidden('history'), 'history to close');
  await pageHasKeys();
});

test('Ctrl+J puts the keyboard in Downloads, whose × and Esc close it', async () => {
  await menuKey('CmdOrCtrl+J');
  await until(async () => (await focused()) === 'downloads', 'the strip to take the keyboard');
  assert.equal(await owner(), 'chrome');
  assert.equal(await chrome("document.getElementById('downloads-close').textContent"), '', 'a ×, not the word Close');
  assert.ok(await chrome("!!document.querySelector('#downloads-close svg')"));
  await press('Escape');
  await until(() => hidden('downloads'), 'the strip to close');
  await pageHasKeys();
});

test('the relay form and site permissions are panels like History: × at the top, Esc closes, one at a time', async () => {
  await chrome("document.getElementById('link').click()");
  await until(async () => !(await hidden('relay')), 'the relay form');
  assert.equal(await focused(), 'relay-url');
  const layout = await chrome(`(() => {
    const box = (n) => n.getBoundingClientRect();
    const panel = document.getElementById('relay'), close = document.getElementById('relay-close');
    return {
      claude: getComputedStyle(document.getElementById('panel')).display,
      tall: box(panel).height > innerHeight - 4,
      closeAtTop: box(close).top - box(panel).top < 40,
      closeIsIcon: !!close.querySelector('svg') && close.textContent === '',
      words: [...panel.querySelectorAll('button')].map((x) => x.textContent).includes('Close'),
    };
  })()`);
  assert.deepEqual(layout, { claude: 'none', tall: true, closeAtTop: true, closeIsIcon: true, words: false });
  await press('Escape');
  await until(() => hidden('relay'), 'Esc to close the relay form');
  await pageHasKeys();
  assert.notEqual(await chrome("getComputedStyle(document.getElementById('panel')).display"), 'none', 'the Claude panel is back');

  // Each opens in the other's place, and History takes the place too.
  await chrome("document.getElementById('link').click()");
  await until(async () => !(await hidden('relay')), 'the relay form');
  assert.equal(await focused(), 'relay-url');
  await chrome('showPermissions(true)');
  assert.deepEqual([await hidden('relay'), await hidden('perms')], [true, false]);
  await chrome("document.getElementById('history-toggle').click()");
  await until(() => hidden('perms'), 'History to take its place');
  assert.equal(await hidden('history'), false);
  await chrome("document.getElementById('link').click()");
  await until(() => hidden('history'), 'the relay form to take History\'s place');
  await chrome("document.getElementById('relay-close').click()");
  assert.equal(await hidden('relay'), true);
});

test('the tab strip is one Tab stop, and the arrow keys move along it', async () => {
  second = await open(b.base + '/second.html');
  third = await open(b.base + '/done.html');
  const stops = () => chrome("[...document.querySelectorAll('#tabs .tab')].filter((t) => t.tabIndex === 0).map((t) => +t.dataset.id)");
  await until(async () => (await stops()).join() === String(third.id), 'only the tab on screen to be a Tab stop');
  await chrome("document.querySelector('#tabs .tab.active').focus()");
  await press('Left');
  const at = () => chrome("document.activeElement.classList.contains('tab') ? +document.activeElement.dataset.id : null");
  assert.equal(await at(), second.id);
  await press('Left');
  assert.equal(await at(), a.id);
  // The strip is redrawn with every change of state: the keyboard stays on the tab.
  await b.ui('tabs:layout', {});
  await sleep(300);
  assert.equal(await at(), a.id);
  await press('End');
  assert.equal(await at(), third.id);
  await press('Home');
  await press('Enter');
  await until(async () => (await onScreen()).id === a.id, 'Enter to show the tab');
});

test("Ctrl+Tab stays among the user's own tabs, or within a session's group, and Ctrl+1 to 9 pick by place", async () => {
  const s = b.as('s', 'Research');
  await s.call('navigate', { url: b.base + '/' });
  await s.call('tabs', { action: 'new', url: b.base + '/second.html' });
  const theirs = await until(async () => { const l = (await tabs()).filter((t) => t.group === 's'); return l.length === 2 && l; }, 'two session tabs');
  const [x, y, z] = await mine();
  await b.ui('tab:select', z.id);
  await menuKey('Ctrl+Tab');
  await until(async () => (await onScreen()).id === x.id, 'Ctrl+Tab to wrap to the first of the user\'s tabs');
  await pageHasKeys();
  await menuKey('Ctrl+Shift+Tab');
  await until(async () => (await onScreen()).id === z.id, 'and back');
  await menuKey('Ctrl+PageUp');
  await until(async () => (await onScreen()).id === y.id, 'Ctrl+PageUp');
  await menuKey('Ctrl+PageDown');
  await until(async () => (await onScreen()).id === z.id, 'Ctrl+PageDown');
  await menuKey('CmdOrCtrl+1');
  await until(async () => (await onScreen()).id === x.id, 'Ctrl+1');
  await menuKey('CmdOrCtrl+2');
  await until(async () => (await onScreen()).id === y.id, 'Ctrl+2');
  await menuKey('CmdOrCtrl+8'); // there is no eighth
  await menuKey('CmdOrCtrl+9');
  await until(async () => (await onScreen()).id === z.id, 'Ctrl+9 to show the last');

  // From a session's tab: round its own group.
  await b.ui('tab:select', theirs[0].id);
  await menuKey('Ctrl+Tab');
  await until(async () => (await onScreen()).id === theirs[1].id, 'the next tab of the group');
  await menuKey('Ctrl+Tab');
  await until(async () => (await onScreen()).id === theirs[0].id, 'and round again');
  await b.ui('tab:select', z.id);
});

test('Ctrl+Tab does not wake a sleeping tab it only passes over', async () => {
  const [x, y, z] = await mine();
  for (const t of [x, y]) {
    await until(async () => (await b.ui('tab:sleep', t.id)) || (await mine()).find((m) => m.id === t.id).asleep, 'the tab to sleep');
  }
  await Promise.all([menuKey('Ctrl+Tab'), menuKey('Ctrl+Tab')]); // past x, on to y, as fast as keys repeat
  assert.equal((await b.state()).aimed, y.id);
  await until(async () => (await chrome("+document.querySelector('#tabs .tab.aimed')?.dataset.id")) === y.id, 'it to be marked in the strip', 300);
  await until(async () => (await onScreen()).id === y.id, 'the tab it stopped on to open');
  const now = await mine();
  assert.deepEqual(now.map((t) => t.asleep), [true, false, false], 'the one passed over still sleeps');
  assert.equal((await b.state()).aimed, null);
  assert.equal(z.id, now[2].id);
});

test("Ctrl+W on a session's tab asks first, and does nothing while the session is working", async () => {
  const s = b.as('s', 'Research');
  const theirs = (await tabs()).filter((t) => t.group === 's');
  const tab = theirs[theirs.length - 1];
  await b.ui('tab:select', tab.id);
  const sure = () => chrome("document.querySelector('#tabs .tab .close.sure')?.textContent ?? null");
  const working = s.text('wait_for', { text: 'never there', seconds: 2 }).catch(() => {});
  await until(async () => (await b.state()).groups.find((g) => g.id === 's').busy, 'the session to be at work');
  await menuKey('CmdOrCtrl+W');
  await sleep(200);
  assert.equal(await sure(), null, 'not even asked');
  assert.ok((await tabs()).some((t) => t.id === tab.id));
  await working;
  await until(async () => !(await b.state()).groups.find((g) => g.id === 's').busy, 'the session to be done');
  await menuKey('CmdOrCtrl+W');
  await until(async () => (await sure()) === 'Close tab?', 'the × to ask');
  assert.ok((await tabs()).some((t) => t.id === tab.id), 'still open');
  await menuKey('CmdOrCtrl+W');
  await until(async () => !(await tabs()).some((t) => t.id === tab.id), 'the second Ctrl+W to close it');
  assert.equal(await sure(), null);
});

test('the application menu is grouped, and its toggles are checkboxes that follow what they toggle', async () => {
  await b.ui('tab:select', (await mine())[2].id);
  const menu = await b.ui('menu');
  assert.deepEqual(menu.map((m) => m[0]), ['File', 'Edit', 'View', 'History', 'Bookmarks', 'Tab', 'Claude', 'Help']);
  const of = (name) => menu.find((m) => m[0] === name)[1];
  for (const [name, items] of menu) {
    assert.ok(items.filter((l) => l !== '-').length <= 14, `${name} is short enough to scan`);
    assert.ok(!items.some((label) => / or |\//.test(label)), `${name}: no two-way labels: ${items}`);
  }
  assert.ok(of('File').filter((l) => l === '-').length >= 3);
  assert.ok(!of('File').some((l) => /Find|Downloads|History|Bookmark|Passwords|permissions/.test(l)));
  assert.ok(of('Edit').includes('Find in page'));
  assert.ok(of('Tab').includes('Next tab') && of('Tab').includes('Pin tab'));
  assert.ok(of('History').includes('Reopen closed tab') && of('History').includes('Clear history…'));
  assert.match(of('Help').at(-1), new RegExp(`^About Loui ${require('../package.json').version.replace(/\./g, '\\.')}$`));
  for (const accelerator of ['F5', 'CmdOrCtrl+Shift+R', 'Alt+D', 'F6', 'F11', 'CmdOrCtrl+,', 'Alt+Shift+P']) {
    assert.equal(await menuKey(accelerator), 'ok', `${accelerator} is a shortcut`);
  }
  await until(async () => (await b.ui('menu:item', 'pin-tab')).checked, 'Pin tab to be ticked'); // Alt+Shift+P, just now
  await menuKey('Alt+Shift+P');
  await until(async () => !(await b.ui('menu:item', 'pin-tab')).checked, 'and unticked');
  await menuKey('F11');
  await until(async () => (await b.ui('settings:state')).open, 'Ctrl+, to have opened Settings, in its own window');
  await b.ui('settings:close');

  const item = (id) => b.ui('menu:item', id);
  assert.equal((await item('claude-panel')).checked, true);
  await chrome("document.getElementById('panel-toggle').click()");
  await until(async () => !(await item('claude-panel')).checked, 'the Claude panel item to follow the toolbar button');
  await menuKey('CmdOrCtrl+Shift+L');
  await until(async () => (await item('claude-panel')).checked, 'and its own shortcut');

  const bar = (await item('bookmarks-bar')).checked;
  await menuKey('CmdOrCtrl+Shift+B');
  await until(async () => (await item('bookmarks-bar')).checked === !bar, 'the bookmarks bar item to follow');
  await menuKey('CmdOrCtrl+Shift+B');

  assert.equal((await item('take-over')).checked, false);
  await b.ui('pause', { group: 'you', on: true });
  await until(async () => (await item('take-over')).checked, 'Take over to be ticked while paused');
  await b.ui('pause', { group: 'you', on: false });

  // On a session's tab there is nothing to pin.
  const theirs = (await tabs()).find((t) => t.group === 's');
  await b.ui('tab:select', theirs.id);
  await until(async () => !(await item('pin-tab')).enabled, 'Pin tab to be greyed out');
  await b.ui('tab:select', (await mine())[2].id);
});

test("a tab's menu has the everyday items, in four parts", async () => {
  const [x, y, z] = await mine();
  const items = (id, click) => b.ui('tab:menu-items', { id, click });
  const menu = await items(y.id);
  for (const label of ['Reload', 'Duplicate', 'Pin tab', 'Bookmark this tab…', 'Give to Research', 'Move to new window',
    'Reopen closed tab', 'Close other tabs', 'Close tabs to the right', 'Close tab']) {
    assert.ok(menu.includes(label), `${label} in ${menu}`);
  }
  assert.equal(menu.filter((l) => l === '-').length, 3);
  assert.equal(menu.at(-1), 'Close tab');
  assert.ok(menu.indexOf('Give to Research') > menu.indexOf('Duplicate') && menu.indexOf('Move to new window') > menu.indexOf('Give to Research'));

  await items(y.id, 'Duplicate');
  const copy = await until(async () => { const l = await mine(); return l.length === 4 && l[2].url === y.url && l[2]; }, 'the copy, right after it');
  assert.deepEqual((await mine()).map((t) => t.id), [x.id, y.id, copy.id, z.id]);
  await items(y.id, 'Close tabs to the right');
  await until(async () => (await mine()).length === 2, 'the two to its right to close');
  await items(y.id, 'Reopen closed tab');
  await until(async () => (await mine()).length === 3, 'the last one closed to come back');
  await items(y.id, 'Close other tabs');
  await until(async () => (await mine()).map((t) => t.id).join() === String(y.id), 'only it to stay');

  // A session's tab: Take over and End session are there, as in its group's menu.
  const theirs = (await tabs()).find((t) => t.group === 's');
  const session = await items(theirs.id);
  assert.deepEqual(session.filter((l) => !/^Open in /.test(l)),
    ['Reload', 'Watch in a small window', '-', 'Take over', 'Take back', 'End session', '-', 'Move group to window', '-', 'Close tab']);
  await items(theirs.id, 'Take over');
  await until(async () => (await b.state()).groups.find((g) => g.id === 's').paused, 'the session to be paused');
  assert.ok((await items(theirs.id)).includes('Let Claude continue'));
  await items(theirs.id, 'Let Claude continue');
  await until(async () => !(await b.state()).groups.find((g) => g.id === 's').paused, 'and let go on');
});

test("a page's menu covers images, links, selections and text fields, and a session's tab keeps to its group", async () => {
  const [y] = await mine();
  const theirs = (await tabs()).find((t) => t.group === 's');
  const items = (id, p, click) => b.ui('page:menu-items', { id, p, click });
  const link = { linkURL: b.base + '/second.html' };
  const image = { mediaType: 'image', srcURL: b.base + '/icon.png' };
  const page = ['Back', 'Forward', 'Reload', '-', 'Print…', 'View page source', '-', 'Point Claude at this', 'Inspect'];

  assert.deepEqual(await items(y.id, { ...link, ...image }), [
    'Open link in new tab', 'Open link in new window', 'Open link in private window', 'Copy link address', '-',
    'Open image in new tab', 'Save image as…', 'Copy image', 'Copy image address', '-', ...page]);
  await b.ui('search:set', { engine: 'custom', url: b.base + '/plain.html?q=%s' });
  const words = { selectionText: ' hello world ' };
  assert.deepEqual(await items(y.id, words), ['copy', 'Search 127.0.0.1 for “hello world”', '-', ...page]);
  assert.deepEqual(await items(y.id, { isEditable: true, misspelledWord: 'teh', dictionarySuggestions: ['the', 'ten'], editFlags: { canCut: true } }),
    ['the', 'ten', 'Add to dictionary', '-', 'cut', 'copy', 'paste', 'Paste as plain text', 'selectAll', '-', ...page]);

  await items(y.id, words, 'Search 127.0.0.1 for “hello world”');
  const found = await until(async () => { const t = await onScreen(); return t.id !== y.id && t.url && t; }, 'the search to open in a new tab');
  assert.equal(found.url, b.base + '/plain.html?q=hello%20world');
  assert.equal(found.group, 'you');
  await b.ui('tab:close', found.id);
  await items(y.id, image, 'Open image in new tab');
  const picture = await until(async () => (await mine()).find((t) => t.url === image.srcURL), 'the image in a tab');
  await b.ui('tab:close', picture.id);
  await items(y.id, {}, 'View page source');
  // The source opens beside the page, under the page's own address.
  const source = await until(async () => (await mine()).find((t) => t.id !== y.id && t.url === y.url && t.active), 'the source in a tab');
  await b.ui('tab:close', source.id);

  // In a session's tab: nothing that opens a window, and what opens stays in the group.
  const theirMenu = await items(theirs.id, { ...link, ...image, ...words });
  assert.ok(!theirMenu.some((l) => /window/.test(l)), String(theirMenu));
  assert.ok(theirMenu.includes('Save image') && !theirMenu.includes('Save image as…'));
  await items(theirs.id, link, 'Open link in new tab');
  await until(async () => (await tabs()).some((t) => t.group === 's' && t.url === link.linkURL && t.id !== theirs.id), 'the link in the session\'s group');
  assert.equal((await mine()).length, 1);
});

test('"New conversation" asks first once there is a conversation to lose', async () => {
  const label = () => chrome("document.getElementById('new-chat').textContent");
  const said = () => chrome("document.querySelectorAll('#feed .said').length");
  await chrome("add(el('div', 'said', 'one')); document.getElementById('new-chat').click()");
  await until(async () => (await said()) === 0, 'a short conversation to be cleared at once');
  await chrome("for (const n of [1, 2, 3, 4]) add(el('div', 'said', 'message ' + n)); document.getElementById('new-chat').click()");
  assert.equal(await label(), 'Clear this one?');
  assert.equal(await said(), 4, 'nothing is lost yet');
  await chrome("document.getElementById('new-chat').click()");
  await until(async () => (await said()) === 0, 'the second press to clear it');
  assert.equal(await label(), 'New conversation');
});

test('"Restart to update" asks first while a session is working', async () => {
  const text = await chrome(`(() => {
    state.update = { status: 'ready', version: '9.9.9' };
    state.working = 1;
    drawUpdate();
    document.getElementById('update').click();
    const asked = document.getElementById('update').textContent;
    drawUpdate(); // a change of state leaves the question up
    return [asked, document.getElementById('update').textContent, document.getElementById('update').classList.contains('sure')];
  })()`);
  assert.deepEqual(text, ['Restart now?', 'Restart now?', true]);
});

test('a tool call with bad arguments is still named sensibly', async () => {
  const s = b.as('v', 'Viewport');
  await s.call('navigate', { url: b.base + '/plain.html' });
  await assert.rejects(s.call('set_viewport', {}), /preset/);
  await s.call('set_viewport', { width: 500, height: 600 });
  const log = await until(async () => {
    const one = (await b.ui('activity:list')).items.find((x) => x.label === 'Viewport');
    const got = one && await b.ui('activity:get', one.id);
    return got?.steps.length >= 3 && got;
  }, 'the steps to be logged');
  assert.deepEqual(log.steps.slice(1).map((x) => x.label), ['changing the page size', 'switching to 500×600']);
});
