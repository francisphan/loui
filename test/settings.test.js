// The Settings window (File › Settings, Ctrl+,): one window with every
// setting in sections; a change there takes effect at once and is written
// down; a change made elsewhere shows in it; the search box filters; and no
// page or Claude session can reach it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { launch } = require('./drive');
const TOOLS = require('../src/shared/tools');

const files = fs.mkdtempSync(path.join(os.tmpdir(), 'loui-downloads-'));
let b;
test.before(async () => { b = await launch({ LOUI_DOWNLOADS: files }); });
test.after(async () => {
  await b?.close();
  fs.rmSync(files, { recursive: true, force: true });
});

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what, ms = 10000) {
  for (const end = Date.now() + ms; Date.now() < end; await pause(100)) {
    const got = await check();
    if (got) return got;
  }
  assert.fail(`timed out waiting for ${what}`);
}
const saved = (home = b.home) => { try { return JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')); } catch { return {}; } };
const win = () => b.ui('settings:state');
const js = (code) => b.ui('settings:js', code);
const chrome = (code) => b.ui('chrome:eval', code);
const menuKey = (accelerator) => b.ui('menu:key', accelerator);
// The window, open and drawn.
async function open() {
  await b.ui('settings:open');
  await until(() => js("!!document.querySelector('#set-theme option')").catch(() => false), 'the Settings window to draw');
}
// The user uses a control: flips a switch, picks from a list, or types and leaves the field.
const use = (id, value) => js(`(() => {
  const c = document.getElementById('set-${id}');
  if (c.type === 'checkbox' || c.tagName === 'BUTTON') return void c.click();
  c.value = ${JSON.stringify(value === undefined ? '' : String(value))};
  c.dispatchEvent(new Event('input', { bubbles: true }));
  c.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
// Adds to a list through its field and Add button.
const add = (id, value) => js(`(() => {
  const input = document.getElementById('set-${id}');
  input.value = ${JSON.stringify(value)};
  input.form.requestSubmit();
})()`);
const row = (id) => js(`(() => {
  const r = document.querySelector('[data-setting="${id}"]');
  return {
    hidden: r.hidden,
    note: r.querySelector('.st-note')?.textContent || '',
    value: r.querySelector('.st-value')?.textContent ?? null,
    items: [...r.querySelectorAll('.st-list li:not(.st-empty)')].map((li) => li.querySelector('.st-item').textContent),
    control: (() => { const c = document.getElementById('set-${id}'); return c ? (c.type === 'checkbox' ? c.checked : c.value) : null; })(),
  };
})()`);
// Presses the button on a list's row.
const take = (id, text) => js(`[...document.querySelectorAll('[data-setting="${id}"] .st-list li')]
  .find((li) => li.querySelector('.st-item')?.textContent === ${JSON.stringify(text)}).querySelector('button').click()`);

test('Ctrl+, opens one Settings window, and the old panel in the window chrome is gone', async () => {
  assert.equal((await win()).open, false);
  await menuKey('CmdOrCtrl+,');
  await until(async () => (await win()).open, 'Ctrl+, to open Settings');
  await open();
  assert.match(await b.ui('settings:url'), /src\/ui\/settings\.html$/);
  await menuKey('CmdOrCtrl+,');
  await b.ui('settings:open');
  await pause(300);
  assert.equal((await win()).windows, 1, 'asked for again, the same window comes forward');
  assert.equal(await chrome("document.getElementById('settings')"), null);
  assert.equal(await chrome("document.activeElement?.id === 'search-engine'"), false);
  assert.equal(await js('document.activeElement.id'), 'st-search', 'the search box has the keyboard');
  const menu = Object.fromEntries(await b.ui('menu'));
  assert.ok(menu.File.includes('Settings…'));
});

test('the command palette opens it too', async () => {
  await b.ui('settings:close');
  await until(async () => !(await win()).open, 'the window to close');
  await menuKey('CmdOrCtrl+K');
  await until(async () => (await b.ui('palette')).open, 'the palette to open');
  await b.ui('palette:type', 'Settings');
  const chosen = (p) => p.groups.flatMap((g) => g.rows).find((r) => r.chosen)?.title;
  await until(async () => { const p = await b.ui('palette'); return p.answered === 'Settings' && chosen(p); }, 'its results');
  for (let i = 0; i < 20 && chosen(await b.ui('palette')) !== 'Settings…'; i++) {
    await b.ui('palette:key', { key: 'Down' });
    await pause(40);
  }
  assert.equal(chosen(await b.ui('palette')), 'Settings…');
  await b.ui('palette:key', { key: 'Enter' });
  await until(async () => (await win()).open, 'the palette\'s Settings command to open the window');
  await open();
});

test('each section lists its settings', async () => {
  const sections = await js('window.sectionsForTest()');
  assert.deepEqual(sections.map((s) => s.title),
    ['General', 'Tabs', 'Search', 'Privacy and security', 'Passwords', 'Claude', 'Reading', 'About']);
  const of = (title) => sections.find((s) => s.title === title).settings;
  assert.deepEqual(of('General'), [
    'Appearance', 'When Loui starts', 'Open Loui when I sign in', 'Default browser',
    'New tabs open with', 'New tab address', 'Show the sites you visit most', 'Sites taken off the start page',
    'Show the weather', 'Your place', 'Temperature in', 'Show news headlines', 'News feeds',
    'Downloads folder', 'Ask where to save each file',
  ]);
  assert.deepEqual(of('Tabs'), ['Vertical tabs', 'Show the bookmarks bar', 'Put tabs to sleep after', 'Sites that are never put to sleep']);
  assert.deepEqual(of('Search'), ['Search engine', 'Search address']);
  assert.deepEqual(of('Privacy and security'), ['Sites with Shields off', 'Filter lists', 'Pop-ups', 'Site permissions', 'Sites that open in your other browser', 'Private windows']);
  assert.deepEqual(of('Passwords'), ['Offer to save passwords', 'Encryption', 'Sites whose passwords are never saved', 'Saved passwords', 'Import passwords']);
  assert.deepEqual(of('Claude'), [
    'Let other Claude sessions use this browser', 'Relay address', 'Relay key', 'Connection', 'This browser\'s name on the relay', 'Let in without asking',
    'Ask before Claude pays, buys, sends, deletes or signs in', 'Sites Claude asks before opening', 'Allowed without asking', 'Sessions trusted until they end',
    'Keep what Claude sessions did for', 'Most disk space for the log', 'Clear the log', 'Local control socket',
  ]);
  assert.deepEqual(of('Reading'), ['Text size', 'Font', 'Line width', 'Colours']);
  assert.deepEqual(of('About'), ['Version', 'Updates', 'Release notes', 'Profile folder']);
  // Every setting says what it is and what it does, and only one section shows at a time.
  assert.equal(await js("[...document.querySelectorAll('.st-row')].every((r) => r.querySelector('.st-label').textContent && r.querySelector('.st-help').textContent)"), true);
  assert.deepEqual((await js('window.shownForTest()')).map((s) => s.id), ['general']);
});

test('General: appearance, what opens at start, and where downloads go', async () => {
  await use('theme', 'light');
  await until(() => chrome("matchMedia('(prefers-color-scheme: light)').matches"), 'the window chrome to turn light');
  assert.equal(saved().theme, 'light');
  assert.equal(await js("matchMedia('(prefers-color-scheme: light)').matches"), true, 'the Settings window follows');
  await use('theme', 'dark');
  await until(() => chrome("matchMedia('(prefers-color-scheme: dark)').matches"), 'dark again');

  await use('startup', 'new');
  await until(() => saved().startup === 'new', 'the choice to be written');
  assert.equal((await row('startup')).note, 'Saved');
  await use('startup', 'restore');
  await until(() => saved().startup === 'restore', 'and back');

  assert.equal((await row('downloads-folder')).value, files);
  await use('downloads-ask');
  await until(async () => (await b.state()).downloads.ask, 'downloads to ask where to save');
  await use('downloads-ask');
  await until(async () => !(await b.state()).downloads.ask, 'and not');
  const other = path.join(files, 'elsewhere');
  await b.ui('settings:folder', other); // as Change… does once a folder is picked
  await until(async () => (await row('downloads-folder')).value === other, 'the new folder to show');
  assert.equal(JSON.parse(fs.readFileSync(path.join(b.home, 'downloads.json'), 'utf8')).folder, other);
  // Not on Windows, or not installed: no button, and why.
  const browser = await row('default-browser');
  assert.match(browser.value, /installed on Windows/);
  assert.equal(await js("document.getElementById('set-default-browser').hidden"), true);
});

test('Tabs: vertical tabs, the bookmarks bar, and sleeping', async () => {
  await use('vertical-tabs');
  await until(async () => (await b.state()).tabStrip.vertical, 'the tabs to move to the sidebar');
  assert.equal(saved().verticalTabs, true);
  assert.equal(await chrome("document.getElementById('sidebar').hidden"), false);
  await use('vertical-tabs');
  await until(async () => !(await b.state()).tabStrip.vertical, 'and back to the top');

  await use('bookmarks-bar');
  await until(async () => (await b.ui('menu:item', 'bookmarks-bar')).checked, 'the bookmarks bar to show');
  await use('bookmarks-bar');
  await until(async () => !(await b.ui('menu:item', 'bookmarks-bar')).checked, 'and hide');

  await use('sleep-minutes', 30);
  await until(() => saved().sleepAfterMinutes === 30, 'the time to be written');
  assert.equal((await row('sleep-minutes')).note, 'Saved');
  await use('sleep-minutes', 0);
  await until(() => saved().sleepAfterMinutes === 0, '"Never" to be written');
  assert.equal(await js("document.getElementById('set-sleep-minutes').selectedOptions[0].textContent"), 'Never');

  await add('keep-awake', 'https://Mail.Example.com/inbox');
  await until(async () => (await row('keep-awake')).items.includes('mail.example.com'), 'the site to be listed');
  assert.deepEqual(saved().keepAwake, ['mail.example.com']);
  await add('keep-awake', 'not a site');
  await until(async () => /not a site/.test(await js("document.querySelector('[data-setting=\"keep-awake\"] .st-add .st-note').textContent")), 'it to say why not');
  await take('keep-awake', 'mail.example.com');
  await until(() => saved().keepAwake.length === 0, 'the site to be removed');
});

test('Search: the engine, and an address of your own', async () => {
  await js("window.showSectionForTest('search')");
  assert.deepEqual(await js("[...document.querySelectorAll('#set-search-engine option')].map((o) => o.textContent)"),
    ['Brave Search', 'DuckDuckGo', 'Google', 'Kagi', 'Custom address']);
  assert.equal((await row('search-url')).hidden, true);
  await use('search-engine', 'duckduckgo');
  await until(async () => (await b.state()).search.engine === 'duckduckgo', 'DuckDuckGo to be chosen');
  assert.equal(saved().search, 'duckduckgo');
  assert.equal(await b.ui('to-url', 'two words'), 'https://duckduckgo.com/?q=two%20words');

  await use('search-engine', 'custom');
  await until(async () => !(await row('search-url')).hidden, 'the address field to show');
  assert.equal((await b.state()).search.engine, 'duckduckgo', 'nothing changes until there is an address');
  await use('search-url', 'https://example.com/search');
  await until(async () => /%s/.test((await row('search-url')).note), 'it to ask for %s');
  await use('search-url', `${b.base}/second.html?q=%s`);
  await until(async () => (await b.state()).search.engine === 'custom', 'the custom address to be used');
  assert.equal(saved().searchUrl, `${b.base}/second.html?q=%s`);
  assert.equal(await b.ui('to-url', 'x y'), `${b.base}/second.html?q=x%20y`);
  await use('search-engine', 'brave');
  await until(async () => (await b.state()).search.engine === 'brave', 'Brave Search again');
});

test('Privacy and security: sites that open elsewhere, Shields, site permissions', async () => {
  await add('elsewhere', 'https://LocalHost/some/page');
  await until(async () => (await b.state()).elsewhere.sites.includes('localhost'), 'the site to be listed');
  assert.deepEqual(saved().openInBrave, ['localhost']);
  assert.deepEqual((await row('elsewhere')).items, ['localhost']);
  assert.match(await js("document.querySelector('[data-setting=\"elsewhere\"] .st-help').textContent"), /refuse to work in Loui/);
  assert.equal(await js("document.getElementById('set-elsewhere').placeholder"), 'example.com');
  assert.doesNotMatch(await js('document.body.textContent'), /Google sign-in/);
  await take('elsewhere', 'localhost');
  await until(async () => !(await b.state()).elsewhere.sites.length, 'the site to be removed');

  // Shields turned off for a site from the toolbar shows here, and is turned back on here.
  await b.ui('go', b.base + '/');
  await until(async () => (await b.state()).shields?.site, 'Shields to know the site');
  const site = (await b.state()).shields.site;
  await b.ui('shields:set', { site, on: false });
  await until(async () => (await row('shields-off')).items.includes(site), 'the site to be listed with Shields off');
  await take('shields-off', site);
  await until(async () => (await b.state()).shields?.on, 'Shields to be back on');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(b.home, 'shields.json'), 'utf8')).off, []);
  assert.equal(await js("document.getElementById('set-shields-update').disabled"), true, 'no lists to download in a test run');
  assert.match(await js("document.querySelector('[data-setting=\"popups\"] .st-help').textContent"), /right after you click or type/);
});

test('Passwords: offering to save, and the Passwords panel', async () => {
  await use('passwords-offer');
  await until(() => saved().offerPasswords === false, 'the choice to be written');
  assert.equal((await row('passwords-offer')).control, false);
  await use('passwords-offer');
  await until(() => saved().offerPasswords === true, 'and back on');
  assert.match((await row('passwords-encryption')).value, /^(Available\.|Not available)/);
  await use('passwords-open');
  await until(() => chrome("!document.getElementById('passwords').hidden"), 'the Passwords panel to open in the main window');
  await chrome("document.getElementById('passwords-close').click()");
});

test('Claude: the relay (its key is never shown), guardrails, the session log, the local socket', async () => {
  await js("window.showSectionForTest('claude')");
  await use('relay-url', 'http://127.0.0.1:9');
  await until(async () => (await b.state()).link.url === 'http://127.0.0.1:9', 'the relay address to be set');
  assert.equal((await row('relay-key')).value, 'Not set.');
  const KEY = 'a-relay-key-nobody-should-see';
  await use('relay-key-replace');
  await js(`(() => { const i = document.getElementById('set-relay-key'); i.value = ${JSON.stringify(KEY)}; i.form.requestSubmit(); })()`);
  await until(async () => (await b.state()).link.hasKey, 'the key to be saved');
  await until(async () => (await row('relay-key')).value === 'Saved.', 'the window to say it is saved');
  assert.equal(await js("document.getElementById('set-relay-key').value"), '', 'the field is emptied');
  assert.ok(!JSON.stringify(await win()).includes(KEY), 'the key is not in what the window is sent');
  assert.ok(!(await js('document.documentElement.outerHTML')).includes(KEY), 'nor anywhere in its page');
  assert.equal(await js("document.getElementById('set-relay-key').type"), 'password');
  // The same words as the relay form in the window chrome.
  await until(async () => (await row('relay-status')).value === await chrome("document.getElementById('relay-status').textContent"), 'the same status words');
  // The key is for the relay it was given for. Another path there keeps it;
  // another address does not get it, and both places say the key is needed.
  await use('relay-url', 'http://127.0.0.1:9/loui');
  await until(async () => (await b.state()).link.url === 'http://127.0.0.1:9/loui', 'the path to be set');
  assert.equal((await b.state()).link.hasKey, true);
  await use('relay-url', 'http://127.0.0.1:10');
  await until(async () => (await b.state()).link.url === 'http://127.0.0.1:10', 'the new address to be set');
  assert.equal((await b.state()).link.hasKey, false, 'the saved key is not kept for a new address');
  assert.ok(!fs.readFileSync(path.join(b.home, 'relay.json'), 'utf8').includes(KEY), 'nor left in the file');
  await until(async () => (await row('relay-key')).value === 'Not set.', 'Settings to say the key is not set');
  assert.equal((await row('relay-status')).value, 'This address has no relay key yet. Enter the key to connect.');
  assert.equal(await chrome("document.getElementById('relay-status').textContent"), (await row('relay-status')).value);
  await use('relay-key-replace');
  await js(`(() => { const i = document.getElementById('set-relay-key'); i.value = ${JSON.stringify(KEY)}; i.form.requestSubmit(); })()`);
  await until(async () => (await b.state()).link.hasKey && (await b.state()).link.status !== 'off', 'the key to be saved again');
  await use('relay-on');
  await until(async () => (await b.state()).link.status === 'off', 'the relay to be turned off');
  assert.equal((await row('relay-status')).value, 'Not connected. Only the Claude panel can use this browser.');
  assert.ok((await row('relay-device')).control.length > 0);

  await use('guard-on');
  await until(async () => (await b.state()).guardrails.on === false, 'guardrails to turn off');
  await use('guard-on');
  await until(async () => (await b.state()).guardrails.on === true, 'and on');
  await add('guard-sites', 'http://LocalHost/whatever');
  await until(async () => (await b.state()).guardrails.sites.includes('localhost'), 'the site to be listed');
  await take('guard-sites', 'localhost');
  await until(async () => !(await b.state()).guardrails.sites.includes('localhost'), 'and removed');

  await use('activity-days', 30);
  await until(() => saved().activityDays === 30, 'the days to be written');
  await use('activity-max', 50);
  await until(() => saved().activityMaxMB === 50, 'the size to be written');
  assert.equal((await row('activity-max')).note, 'Saved');
  await use('activity-max', 'lots');
  await until(async () => /whole number/.test((await row('activity-max')).note), 'it to refuse words');
  assert.equal(saved().activityMaxMB, 50);
  // "Clear all" asks first, in place.
  const s = b.as('logged', 'Logged');
  await s.text('navigate', { url: b.base + '/second.html' });
  s.end();
  await b.ui('activity:flush');
  await until(async () => (await b.ui('activity:list')).items.length > 0, 'a session to be in the log');
  await use('activity-clear');
  assert.equal(await js("document.getElementById('set-activity-clear').textContent"), 'Clear everything?');
  assert.ok((await b.ui('activity:list')).items.length > 0, 'nothing is cleared yet');
  await use('activity-clear');
  await until(async () => (await b.ui('activity:list')).items.length === 0, 'the log to be cleared');

  await use('local-socket');
  await until(() => saved().localSocket === true, 'the socket to be turned on');
  assert.match(await js("document.querySelector('[data-setting=\"local-socket\"] .st-help').textContent"), /not asked about.*next time Loui starts/);
  await use('local-socket');
  await until(() => saved().localSocket === false, 'and off');
});

test("Claude: this browser's name on the relay can be changed, and the relay hears the new one", async () => {
  await js("window.showSectionForTest('claude')");
  const device = () => JSON.parse(fs.readFileSync(path.join(b.home, 'device.json'), 'utf8'));
  const { id } = device();
  const own = (await b.state()).link.device; // the computer's name
  assert.equal((await row('relay-device')).control, own);
  // A stand-in relay that notes who says hello.
  const hellos = [];
  const standIn = new WebSocket.Server({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => standIn.on('listening', resolve));
  standIn.on('connection', (ws) => ws.on('message', (data) => {
    const msg = JSON.parse(data);
    if (msg.hello) { hellos.push(msg.hello.device); ws.send(JSON.stringify({ welcome: true, sessions: [], relay: [] })); }
    if (msg.ping) ws.send(JSON.stringify({ pong: msg.ping }));
  }));
  try {
    await use('relay-url', `http://127.0.0.1:${standIn.address().port}`);
    await until(async () => !(await b.state()).link.hasKey, 'the address to change');
    await use('relay-key-replace');
    await js("(() => { const i = document.getElementById('set-relay-key'); i.value = 'k'; i.form.requestSubmit(); })()");
    await until(async () => (await b.state()).link.hasKey, 'the key to be saved');
    if (!(await b.state()).link.on) await use('relay-on');
    await until(async () => (await b.state()).link.status === 'connected', 'the browser to connect');
    assert.deepEqual([hellos.at(-1).id, hellos.at(-1).name], [id, own]);

    await use('relay-device', '  Study\u0007 desk  ');
    await until(() => hellos.at(-1).name === 'Study desk', 'the relay to hear the new name');
    assert.equal(hellos.at(-1).id, id, 'the same browser');
    assert.deepEqual(device(), { id, name: 'Study desk' });
    assert.equal((await row('relay-device')).control, 'Study desk');
    assert.equal((await row('relay-device')).note, 'Saved');
    await until(async () => /^Connected as Study desk\./.test((await row('relay-status')).value), 'the status to use the name');
    // No longer than a relay would take.
    await use('relay-device', 'x'.repeat(200));
    await until(() => hellos.at(-1).name === 'x'.repeat(64), 'a long name to be cut');
    // Emptied, it is the computer's name again.
    await use('relay-device', '');
    await until(() => hellos.at(-1).name === own, 'the relay to hear the old name');
    assert.deepEqual(device(), { id });
    await until(async () => (await row('relay-device')).control === own, 'the field to show it');
  } finally {
    if ((await b.state()).link.on) await use('relay-on');
    await until(async () => (await b.state()).link.status === 'off', 'the relay to be turned off');
    for (const ws of standIn.clients) ws.terminate();
    standIn.close();
  }
});

test('Reading and About', async () => {
  await use('reader-size', 4);
  await until(() => saved().reader?.size === 4, 'the text size to be written');
  await use('reader-face', 'serif');
  await until(() => saved().reader?.face === 'serif', 'the font to be written');
  await use('reader-width', 'wide');
  await until(() => saved().reader?.width === 'wide', 'the width to be written');

  const version = require('../package.json').version;
  assert.match((await row('version')).value, new RegExp(`^Loui ${version.replace(/\./g, '\\.')} · Electron [\\d.]+ · Chromium [\\d.]+$`));
  assert.equal((await row('profile')).value, b.home);
  assert.match((await row('updates')).value, /^Updates are off in this copy/);
  assert.equal(await js("document.getElementById('set-update-check').disabled"), true);
  assert.equal(await js("document.getElementById('set-update-install').hidden"), true);
  // The releases page opens in a tab of the main window.
  await use('releases');
  await until(async () => (await b.state()).tabs.some((t) => /github\.com\/francisphan\/loui\/releases/.test(t.url)), 'the releases page to open in a tab');
  const tab = (await b.state()).tabs.find((t) => /releases/.test(t.url));
  await b.ui('tab:close', tab.id);
});

test('a change made elsewhere shows in the open window', async () => {
  await b.ui('tabs:layout', { vertical: true }); // as View › Vertical tabs does
  await until(async () => (await row('vertical-tabs')).control === true, 'the switch to follow the View menu');
  await b.ui('tabs:layout', { vertical: false });
  await until(async () => (await row('vertical-tabs')).control === false, 'and back');
  await b.ui('search:set', { engine: 'kagi' });
  await until(async () => (await row('search-engine')).control === 'kagi', 'the engine to follow');
  await b.ui('search:set', { engine: 'brave' });
  await b.ui('download:ask', true); // the tick in the downloads strip
  await until(async () => (await row('downloads-ask')).control === true, 'the downloads switch to follow');
  await b.ui('download:ask', false);
  await b.ui('guard:site-add', 'bank.example');
  await until(async () => (await row('guard-sites')).items.includes('bank.example'), 'the list to follow');
  await b.ui('guard:site-remove', 'bank.example');
});

test('the search box finds settings by label and description, across sections', async () => {
  assert.deepEqual(await js("window.searchForTest('sleep')"), [
    { id: 'tabs', title: 'Tabs', settings: ['Put tabs to sleep after', 'Sites that are never put to sleep'] },
  ]);
  const found = await js("window.searchForTest('RELAY')");
  assert.deepEqual(found.map((s) => s.id), ['claude']);
  assert.ok(found[0].settings.includes('Relay key') && !found[0].settings.includes('Local control socket'));
  // A word from a description, and words from two sections.
  assert.deepEqual((await js("window.searchForTest('memory')"))[0].settings, ['Put tabs to sleep after']);
  assert.deepEqual((await js("window.searchForTest('folder')")).map((s) => s.id), ['general', 'about']);
  assert.deepEqual(await js("window.searchForTest('zzqq')"), []);
  assert.equal(await js("document.getElementById('st-none').textContent"), 'No setting matches “zzqq”.');
  assert.equal(await js("document.getElementById('st-none').hidden"), false);
  // Emptying the box brings the chosen section back.
  await js("window.searchForTest('')");
  assert.equal((await js('window.shownForTest()')).length, 1);
});

test('the sections are reached with the arrow keys, and Esc and Ctrl+W close the window', async () => {
  await js("window.showSectionForTest('general'); document.getElementById('tab-general').focus()");
  await b.ui('settings:key', { key: 'Down' });
  await until(async () => (await js('document.activeElement.id')) === 'tab-tabs', 'Down to move to Tabs');
  assert.deepEqual((await js('window.shownForTest()')).map((s) => s.id), ['tabs']);
  await b.ui('settings:key', { key: 'End' });
  await until(async () => (await js('document.activeElement.id')) === 'tab-about', 'End to move to About');
  assert.equal(await js("document.querySelectorAll('.st-section-tab[tabindex=\"0\"]').length"), 1, 'the list of sections is one Tab stop');

  // Esc empties the search box first.
  await js("window.searchForTest('sleep'); document.getElementById('st-search').focus()");
  await b.ui('settings:key', { key: 'Escape' });
  await until(async () => (await js("document.getElementById('st-search').value")) === '', 'Esc to empty the search box');
  assert.equal((await win()).open, true);
  await b.ui('settings:key', { key: 'Escape' });
  await until(async () => !(await win()).open, 'Esc to close the window');
  await open();
  await b.ui('settings:key', { key: 'w', modifiers: ['control'] });
  await until(async () => !(await win()).open, 'Ctrl+W to close the window');
});

test('it opens where it was left', async () => {
  await open();
  await b.ui('settings:place', { x: 140, y: 90, width: 800, height: 600 });
  await until(() => saved().settingsWindow?.width === 800, 'its place to be written');
  await b.ui('settings:close');
  await until(async () => !(await win()).open, 'the window to close');
  await open();
  const { x, y, width, height } = (await win()).bounds;
  assert.deepEqual({ x, y, width, height }, { x: 140, y: 90, width: 800, height: 600 });
});

test('the page is Loui\'s own, locked, with only its narrow bridge; pages and sessions cannot reach it', async () => {
  assert.deepEqual(await js('Object.keys(window.loui).sort()'), ['act', 'close', 'onShow', 'onState']);
  assert.equal(await js('typeof require'), 'undefined');
  assert.equal(await js('window.open("https://example.com") === null'), true);
  await js(`location.href = ${JSON.stringify(b.base)}`).catch(() => {});
  await pause(500);
  assert.match(await b.ui('settings:url'), /src\/ui\/settings\.html$/, 'it cannot be navigated away');

  // Its channel answers only its own page: the same request from the window chrome's page gets nothing.
  const before = saved();
  assert.equal(await b.ui('settings:stranger', { what: 'theme', arg: 'light' }), null);
  assert.equal(await b.ui('settings:stranger', { what: 'socket', arg: true }), null);
  assert.deepEqual(saved(), before);
  // The window chrome's bridge has no way to it, and a tab's page has no bridge at all.
  assert.equal(await chrome('typeof loui.act + typeof loui.onState'), 'undefinedundefined');
  await b.ui('go', b.base + '/');
  const tab = await until(async () => (await b.state()).tabs.find((t) => t.active && !t.loading && t.url === b.base + '/'), 'the page');
  assert.equal(await b.ui('tab:js', { id: tab.id, code: 'typeof loui + typeof require' }), 'undefinedundefined');
  // A Claude session: no bridge in its pages, no tool about settings, and its Ctrl+, opens nothing.
  await b.ui('settings:close');
  await until(async () => !(await win()).open, 'the window to close');
  const s = b.as('s', 'Research');
  await s.text('navigate', { url: b.base + '/second.html' });
  assert.equal(await s.text('evaluate', { code: 'typeof loui' }), '"undefined"');
  await s.call('press_key', { key: 'Control+,' });
  await pause(500);
  assert.equal((await win()).open, false);
  assert.ok(!TOOLS.some((t) => /setting|preference/i.test(t.name)));
  s.end();
});

test('with "Open a new tab" chosen, the tabs from last time are not reopened', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'loui-test-'));
  let c = await launch({}, { home });
  try {
    await c.ui('go', c.base + '/second.html');
    await until(async () => (await c.state()).tabs.some((t) => t.url.endsWith('/second.html') && !t.loading), 'the page');
    await c.ui('settings:act', { what: 'startup', arg: 'new' });
    assert.equal(saved(home).startup, 'new');
    await pause(1200); // tabs.json is written at most once a second
    await c.close();
    fs.rmSync(path.join(home, 'loui.sock'), { force: true });
    c = await launch({}, { home });
    const tabs = (await c.state()).tabs;
    assert.equal(tabs.length, 1);
    assert.ok(!tabs[0].url.includes('second.html'), `started with a new tab, not ${tabs[0].url}`);
  } finally {
    await c.close();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('it works with only a private window open, and shows nothing of it', async () => {
  const first = (await b.ui('windows'))[0].id;
  const priv = await b.ui('window:new', { private: true });
  await until(async () => (await b.ui('windows')).length === 2, 'the private window');
  await b.ui('in-window', { window: priv, ui: 'go', arg: b.base + '/second.html?private' });
  await b.ui('window:close', first);
  await until(async () => (await b.ui('windows')).length === 1, 'only the private window to be left');
  await open();
  assert.equal((await js('window.sectionsForTest()')).length, 8);
  await use('sleep-minutes', 15);
  await until(() => saved().sleepAfterMinutes === 15, 'a setting to change');
  assert.ok(!JSON.stringify(await win()).includes('?private'), 'nothing of the private window is in what it is sent');
  assert.ok(!(await js('document.body.textContent')).includes('?private'));
});
