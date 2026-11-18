// Bookmarks: Ctrl+D or the star keeps the page, the bar shows what is on it,
// folders hold bookmarks, the address bar suggests them before history, and a
// browser's exported bookmarks file imports. They are the user's alone:
// Claude sessions and pages have no way to them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launch } = require('./drive');
const { parseNetscape } = require('../src/main/bookmarks');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'loui-test-'));
let b;
test.before(async () => { b = await launch({}, { home }); });
test.after(async () => {
  await b?.close();
  try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {}
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
    const got = await check();
    if (got) return got;
  }
  assert.fail(`timed out waiting for ${what}`);
}
const onScreen = async () => (await b.state()).tabs.find((t) => t.active);
async function visit(url) {
  await b.ui('go', url);
  await until(async () => { const t = await onScreen(); return t.url === url && !t.loading && t.title; }, `${url} to load`);
}
const chrome = (code) => b.ui('chrome:eval', code);
const key = (accelerator) => b.ui('menu:key', accelerator);
const ask = (request) => b.ui('bookmarks', request);
const saved = () => b.ui('bookmarks:saved');
const barNames = () => chrome("[...document.querySelectorAll('#bookmarks-items .bar-item')].map((i) => i.querySelector('.name').textContent)");
const barShows = (names) => until(async () => {
  const now = await barNames();
  return JSON.stringify(now) === JSON.stringify(names) && now;
}, `the bar to show ${names.join(', ')}`);
const editor = () => chrome(`(() => {
  const strip = document.getElementById('bookmark-edit');
  return {
    open: !strip.hidden,
    heading: document.getElementById('bookmark-edit-title').textContent,
    name: document.getElementById('bookmark-name').value,
    folders: [...document.getElementById('bookmark-folder').options].map((o) => o.textContent.trim()),
  };
})()`);
const editorOpen = () => until(async () => { const e = await editor(); return e.open && e; }, 'the bookmark editor');
// Types into the editor's fields and presses Done.
const edit = ({ name, folder }) => chrome(`(() => {
  if (${JSON.stringify(name ?? null)} !== null) document.getElementById('bookmark-name').value = ${JSON.stringify(name ?? '')};
  const select = document.getElementById('bookmark-folder');
  const want = ${JSON.stringify(folder ?? null)};
  if (want) select.value = [...select.options].find((o) => o.textContent.trim() === want).value;
  document.getElementById('bookmark-done').click();
})()`);
const find = (items, title) => {
  for (const n of items) {
    if (n.title === title) return n;
    const inner = n.children && find(n.children, title);
    if (inner) return inner;
  }
  return null;
};
const all = (data) => [...data.bar, ...data.other];

test('Ctrl+D bookmarks the page on screen onto the bar, and the star lights up', async () => {
  await visit(b.base + '/');
  assert.equal((await b.state()).bookmark, null);
  assert.equal(await chrome("document.getElementById('bookmarks-bar').hidden"), true, 'no bar until there are bookmarks');
  assert.equal(await key('CmdOrCtrl+D'), 'ok');
  const id = await until(async () => (await b.state()).bookmark, 'the page to be bookmarked');
  const e = await editorOpen();
  assert.equal(e.heading, 'Bookmark added');
  assert.equal(e.name, 'Fixture');
  await barShows(['Fixture']);
  assert.equal(await chrome("document.getElementById('bookmarks-bar').hidden"), false);
  assert.equal(await chrome("document.getElementById('star').classList.contains('on')"), true);
  assert.equal((await saved()).bar[0].id, id);
  assert.equal((await saved()).bar[0].url, b.base + '/');
});

test('the editor renames a bookmark, and Esc leaves it as it was', async () => {
  await edit({ name: 'Fixture home' });
  await barShows(['Fixture home']);
  assert.equal((await editor()).open, false);

  await key('CmdOrCtrl+D'); // on a bookmarked page: edits its bookmark, adds nothing
  const e = await editorOpen();
  assert.equal(e.heading, 'Bookmark');
  assert.equal(e.name, 'Fixture home');
  await chrome(`(() => {
    const name = document.getElementById('bookmark-name');
    name.value = 'Not this';
    name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  })()`);
  await until(async () => !(await editor()).open, 'the editor to close');
  await sleep(300);
  assert.deepEqual(await barNames(), ['Fixture home']);
  assert.equal((await saved()).bar.length, 1);
});

test('the star bookmarks a page, and folders hold bookmarks and open from the bar as a menu', async () => {
  await visit(b.base + '/second.html');
  assert.equal(await chrome("document.getElementById('star').hidden"), false);
  await chrome("document.getElementById('star').click()");
  await editorOpen();
  await edit({});
  await barShows(['Fixture home', 'Second']);

  await ask({ do: 'folder', parent: 'bar' });
  assert.equal((await editorOpen()).name, 'New folder');
  await edit({ name: 'Reading' });
  await barShows(['Fixture home', 'Second', 'Reading']);

  // Second goes into Reading.
  const second = find(all(await saved()), 'Second');
  await ask({ do: 'edit', id: second.id });
  const e = await editorOpen();
  assert.deepEqual(e.folders, ['Bookmarks bar', 'Reading', 'Other bookmarks']);
  await edit({ folder: 'Reading' });
  await barShows(['Fixture home', 'Reading']);
  const reading = find(all(await saved()), 'Reading');
  assert.deepEqual(reading.children.map((n) => n.title), ['Second']);
  assert.deepEqual(await b.ui('bookmarks:menu', reading.id), ['Second']);

  // A folder cannot be put inside itself.
  await ask({ do: 'edit', id: reading.id });
  assert.deepEqual((await editorOpen()).folders, ['Bookmarks bar', 'Other bookmarks']);
  await chrome("document.getElementById('bookmark-name').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
});

test('the bookmarks panel shows folders, searches, and deletes', async () => {
  const rows = () => chrome("[...document.querySelectorAll('#bookmarks-list .bookmark-row')].map((r) => r.querySelector('.title').textContent)");
  await key('CmdOrCtrl+Shift+O');
  await until(async () => (await rows()).length === 2, 'the panel to list the bar');
  assert.deepEqual(await rows(), ['Fixture home', 'Reading']);
  assert.equal(await chrome("document.getElementById('panel').checkVisibility()"), false, 'in place of the Claude panel');

  await chrome("[...document.querySelectorAll('.bookmark-row.folder .open')][0].click()");
  await until(async () => (await rows()).length === 3, 'the folder to open');
  assert.deepEqual(await rows(), ['Fixture home', 'Reading', 'Second']);

  await chrome(`(() => {
    const box = document.getElementById('bookmarks-search');
    box.value = 'second';
    box.dispatchEvent(new Event('input'));
  })()`);
  await until(async () => JSON.stringify(await rows()) === '["Second"]', 'the search');
  await chrome(`(() => {
    const box = document.getElementById('bookmarks-search');
    box.value = '';
    box.dispatchEvent(new Event('input'));
  })()`);
  await until(async () => (await rows()).length === 3, 'the whole list');

  // A folder with something in it is deleted only once confirmed.
  await chrome("document.querySelector('.bookmark-row.folder .remove').click()");
  assert.equal(await chrome("document.getElementById('bookmarks-confirm').hidden"), false);
  await chrome("document.getElementById('bookmarks-confirm-yes').click()");
  await until(async () => JSON.stringify(await rows()) === '["Fixture home"]', 'the folder to be deleted');
  await barShows(['Fixture home']);
  assert.equal(find(all(await saved()), 'Second'), null);

  await chrome("document.getElementById('bookmarks-close').click()");
  assert.equal(await chrome("document.getElementById('panel').checkVisibility()"), true, 'the Claude panel is back');
});

test('the address bar suggests bookmarks before pages from history, under their own name', async () => {
  for (let i = 0; i < 3; i++) await visit(b.base + '/index.html?often'); // visited most, but not bookmarked
  await visit(b.base + '/second.html');
  await key('CmdOrCtrl+D');
  await editorOpen();
  await edit({ name: 'My reading spot' });
  await barShows(['Fixture home', 'My reading spot']);

  const suggestions = async (text) => {
    await b.ui('address:type', text);
    return until(async () => { const s = await b.ui('suggestions'); return s.open && s.rows.length && s.rows; }, 'suggestions');
  };
  const urls = (await suggestions('127.0.0.1')).map((r) => r.url);
  assert.deepEqual(urls.slice(0, 2), [b.base + '/', b.base + '/second.html'], 'bookmarks first');
  assert.ok(urls.indexOf(b.base + '/index.html?often') > 1, JSON.stringify(urls));
  await b.ui('address:key', 'Escape');

  const byName = await suggestions('reading spot');
  // After the row that says what Enter does (here, a search for the words).
  assert.deepEqual(byName.filter((r) => r.kind !== 'enter').map((r) => [r.url, r.title]), [[b.base + '/second.html', 'My reading spot']]);
  await b.ui('address:key', 'Escape');
  await b.ui('address:key', 'Escape');
});

test('Ctrl+Shift+B hides the bookmarks bar and shows it again', async () => {
  const hidden = () => chrome("document.getElementById('bookmarks-bar').hidden");
  assert.equal(await hidden(), false);
  await key('CmdOrCtrl+Shift+B');
  await until(hidden, 'the bar to hide');
  assert.equal((await saved()).showBar, false);
  await key('CmdOrCtrl+Shift+B');
  await until(async () => !(await hidden()), 'the bar to come back');
  assert.equal((await saved()).showBar, true);
});

test('the bookmarks bar is one Tab stop, and Left and Right move along it', async () => {
  const bar = () => chrome(`(() => {
    const all = [...document.querySelectorAll('#bookmarks-items .bar-item:not(.overflow), #bookmarks-more:not([hidden]), #bookmarks-other:not([hidden])')];
    return { stops: all.filter((x) => x.tabIndex === 0).length, at: all.indexOf(document.activeElement), count: all.length };
  })()`);
  const start = await until(async () => { const s = await bar(); return s.count >= 2 && s.stops === 1 && s; }, 'one Tab stop on the bar');
  assert.equal(start.at, -1);
  await chrome("document.querySelector('#bookmarks-items .bar-item').focus()");
  // A key arrives a moment after it is sent: each step waits for where it leads.
  const lands = (at, what) => until(async () => { const s = await bar(); return s.stops === 1 && s.at === at && s.count === start.count; }, what);
  await b.ui('address:key', 'Right');
  await lands(1, 'Right to move to the second');
  await b.ui('address:key', 'End');
  await lands(start.count - 1, 'End to move to the last');
  await b.ui('address:key', 'Left');
  await lands(start.count - 2, 'Left to move back one');
  await b.ui('address:key', 'Home');
  await lands(0, 'Home to move to the first');
});

test('a bookmarks file exported from Brave or Chrome imports onto the bar and into other bookmarks', async () => {
  const file = path.join(__dirname, 'fixture', 'bookmarks-export.html');
  assert.deepEqual(await b.ui('bookmarks:import-file', file), { added: 5, skipped: 1 }, 'the bookmarklet is left out');
  await barShows(['Fixture home', 'My reading spot', 'Example & Co', 'Recipes']);
  const data = await saved();
  const recipes = find(data.bar, 'Recipes');
  assert.deepEqual(await b.ui('bookmarks:menu', recipes.id), ['Soup', { Desserts: ['Flan <caramel>'] }]);
  assert.match(find(data.bar, 'Example & Co').icon, /^data:image\/png;base64,/);
  assert.equal(find(data.bar, 'Example & Co').added, 1700000000 * 1000);
  assert.deepEqual(data.other.map((n) => n.title), ['News', 'Travel']);
  assert.equal(await chrome("document.getElementById('bookmarks-other').hidden"), false);
  assert.match(await chrome("document.querySelector('.bar-item[title^=\"Example\"] img').src"), /^data:image\/png/);

  // The file's icon is not read in the main process: the window chrome draws
  // it small, and only that copy is kept and shown in the native menus.
  // (The file's own icon is read from the file: by now the chrome's copy may already have taken its place.)
  const raw = /ICON="([^"]+)"/.exec(fs.readFileSync(file, 'utf8'))[1];
  const kept = await until(async () => { const n = find((await saved()).bar, 'Example & Co'); return n.drawn && n; }, "the chrome's small copy of the icon to be kept");
  assert.match(kept.icon, /^data:image\/png;base64,/);
  assert.notEqual(kept.icon, raw);
  assert.equal(await chrome(`new Promise((ok) => { const i = new Image(); i.onload = () => ok(i.naturalWidth + 'x' + i.naturalHeight); i.src = ${JSON.stringify(kept.icon)}; })`), '32x32');
  assert.deepEqual(await b.ui('bookmarks:menu-icons', 'bar'), ['Example && Co']);

  assert.deepEqual(await b.ui('bookmarks:import-file', file), { added: 0, skipped: 6 }, 'importing again adds nothing');
});

test("Firefox's export: its toolbar goes on the bar, its other bookmarks into other bookmarks", () => {
  const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<H1>Bookmarks Menu</H1>
<DL><p>
    <DT><A HREF="https://menu.example/" ADD_DATE="1">In the menu</A>
    <DT><H3 ADD_DATE="1" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks Toolbar</H3>
    <DL><p>
        <DT><A HREF="https://bar.example/" ADD_DATE="1">On the toolbar</A>
    </DL><p>
    <DT><H3 ADD_DATE="1" UNFILED_BOOKMARKS_FOLDER="true">Other Bookmarks</H3>
    <DL><p>
        <DT><A HREF="https://other.example/?a=1&amp;b=2">Elsewhere &#8212; here</A>
        <DT><A HREF="place:sort=8&maxResults=10">Recent tags</A>
    </DL><p>
</DL>`;
  const top = parseNetscape(html);
  assert.deepEqual(top.map((n) => n.title), ['In the menu', 'Bookmarks Toolbar', 'Other Bookmarks']);
  assert.equal(top[1].toolbar, true);
  assert.equal(top[2].unfiled, true);
  assert.deepEqual(top[2].children.map((n) => [n.url, n.title]), [
    ['https://other.example/?a=1&b=2', 'Elsewhere — here'],
    ['place:sort=8&maxResults=10', 'Recent tags'],
  ]);
});

test('Claude sessions cannot see or change bookmarks, and neither can pages', async () => {
  const tools = require('../src/shared/tools');
  assert.ok(!tools.some((t) => /bookmark/i.test(t.name + t.description)), 'no tool mentions bookmarks');

  const before = JSON.stringify(await saved());
  const a = b.as('a', 'Claude Code');
  await a.text('navigate', { url: b.base + '/index.html?for-claude' });
  assert.equal(await a.text('evaluate', { code: 'typeof loui' }), '"undefined"', 'pages have no bridge to Loui');
  await a.text('press_key', { key: 'Control+d' });
  // The user looking at the session's tab, and the session pressing Ctrl+D in it.
  const theirs = (await b.state()).tabs.find((t) => t.group !== 'you');
  await b.ui('tab:select', theirs.id);
  await a.text('press_key', { key: 'Control+d' });
  await sleep(800);
  assert.equal(JSON.stringify(await saved()), before, 'nothing was added');
  a.end();
});

test("a bookmarked page's icon is kept as the small copy the window chrome drew", async () => {
  await visit(b.base + '/icon-data.html');
  await until(async () => (await b.state()).tabs.find((t) => t.active).favicon, "the page's icon to arrive");
  assert.equal(await key('CmdOrCtrl+D'), 'ok');
  await editorOpen();
  await edit({});
  const kept = await until(async () => { const n = find((await saved()).bar, 'Icon given'); return n?.drawn && n; }, 'the icon to be kept');
  assert.match(kept.icon, /^data:image\/png;base64,/);
  assert.deepEqual(await b.ui('bookmarks:menu-icons', 'bar'), ['Example && Co', 'Icon given']);
  await ask({ do: 'remove', id: kept.id });
  await barShows(['Fixture home', 'My reading spot', 'Example & Co', 'Recipes']);
});

test('bookmarks and the bar are still there after a restart', async () => {
  const before = await saved();
  await sleep(700); // the debounced save
  await b.close();
  b = await launch({}, { home });
  await barShows(['Fixture home', 'My reading spot', 'Example & Co', 'Recipes']);
  assert.deepEqual(await saved(), before);
  assert.equal(await chrome("document.getElementById('bookmarks-other').hidden"), false);
});
