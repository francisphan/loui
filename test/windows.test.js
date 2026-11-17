// More than one window, and private windows. Each window lists its own tabs;
// tabs and sessions' groups move between windows, and a session's tools work
// wherever its group is; closing a window closes its tabs, and closing the
// last one quits. A private window keeps no history and shares no cookies,
// has Shields and the relay guard, is never restored, and Claude sessions
// work in it only in a tab the user hands them. A real relay and a local
// filter list run too, as in shields.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { start } = require('../relay/server');
const { launch } = require('./drive');

let b, lists, relay, relayHome, home, env;

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = async (what, check, ms = 10000) => {
  for (const end = Date.now() + ms; Date.now() < end; await pause(100)) {
    const value = await check();
    if (value) return value;
  }
  throw new Error(`timed out waiting for ${what}`);
};
const windows = () => b.ui('windows');
const win = async (id) => (await windows()).find((w) => w.id === id);
// What a window's chrome is shown (its state), and a request from its chrome.
const stateOf = (id) => b.ui('in-window', { window: id, ui: 'state' });
const from = (id, ui, arg) => b.ui('in-window', { window: id, ui, arg });
const tabIn = async (id, pick = (t) => t.active) => (await stateOf(id)).tabs.find(pick);
const loaded = (id) => wait('the page to load', async () => {
  const tab = await tabIn(id);
  return tab && !tab.loading && tab.url && tab;
});
const js = (id, code) => b.ui('tab:js', { id, code });

test.before(async () => {
  lists = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(fs.readFileSync(path.join(__dirname, 'fixture', 'shields-list.txt')));
  });
  await new Promise((r) => lists.listen(0, '127.0.0.1', r));
  relayHome = fs.mkdtempSync(path.join(os.tmpdir(), 'loui-windows-relay-'));
  relay = await start({ port: 0, home: relayHome, graceMs: 600, idleMs: 60000 });
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'loui-windows-'));
  env = {
    LOUI_SHIELDS_LISTS: `http://127.0.0.1:${lists.address().port}/list.txt`,
    LOUI_RELAY_URL: relay.url, LOUI_RELAY_KEY: relay.key,
  };
  b = await launch(env, { home });
  await wait('Loui to connect to the relay', async () => (await b.state()).link.status === 'connected');
});
test.after(async () => {
  await b?.close();
  await relay.close();
  lists.close();
  for (const dir of [home, relayHome]) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {}
  }
});

let one, two;
test('a second window opens with a tab of its own; each window lists its own tabs', async () => {
  const first = await b.state();
  one = first.window.id;
  assert.equal(first.windows.length, 1);
  assert.equal(first.window.private, false);
  two = await b.ui('window:new');
  assert.equal((await windows()).length, 2);
  await from(two, 'go', b.base + '/index.html?two');
  await loaded(two);
  await from(two, 'tab:new', b.base + '/second.html?two');
  const there = await stateOf(two);
  assert.equal(there.window.id, two);
  assert.equal(there.tabs.length, 2);
  assert.ok(there.tabs.every((t) => t.window === two));
  assert.equal(there.tabs.filter((t) => t.active).length, 1);
  const here = await stateOf(one);
  assert.ok(here.tabs.every((t) => t.window === one), 'the first window does not list the second one\'s tabs');
  assert.equal(here.tabs.filter((t) => t.active).length, 1);
});

test('a tab moves to another window, and to a new one', async () => {
  const tab = await wait('the second tab to load', () => tabIn(two, (t) => t.url.includes('second.html?two') && !t.loading));
  await b.ui('tab:to-window', { id: tab.id, window: one });
  assert.ok((await win(one)).tabs.includes(tab.id));
  assert.ok(!(await win(two)).tabs.includes(tab.id));
  assert.equal((await win(one)).active, tab.id, 'it is on screen in the window it went to');
  assert.equal((await stateOf(two)).tabs.filter((t) => t.active).length, 1, 'the window it left shows another tab');
  // Its page still answers there.
  assert.equal(await js(tab.id, 'location.search'), '?two');

  await b.ui('to-new-window', { id: tab.id });
  const all = await windows();
  assert.equal(all.length, 3);
  const three = all.find((w) => w.id !== one && w.id !== two);
  assert.deepEqual(three.tabs, [tab.id], 'the new window holds just that tab');
  await b.ui('window:close', three.id);
  await wait('the window to close', async () => (await windows()).length === 2);
});

test('a session\'s group goes in the window focused last, its tools work there, and it can move', async () => {
  await b.ui('window:focus', two);
  const s = b.as('w', 'Claude Code · windows');
  assert.match(await s.text('navigate', { url: b.base }), /heading1 "Fixture page"/);
  assert.deepEqual((await win(two)).groups, ['w']);
  assert.ok((await stateOf(two)).groups.some((g) => g.id === 'w'));
  assert.ok(!(await stateOf(one)).groups.some((g) => g.id === 'w'), 'the other window does not show it');

  const tools = async () => {
    const page = await s.text('snapshot');
    const field = page.match(/textbox "Your name" \[(e\d+)\]/)[1];
    assert.match(await s.text('type', { ref: field, text: 'Ada', clear: true, submit: true }), /text "Hello, Ada \(s\)"/);
    const count = page.match(/button "Count" \[(e\d+)\]/)[1];
    assert.match(await s.text('click', { ref: count }), /button "Clicked 1"/);
    const [note, image] = await s.call('screenshot');
    assert.match(note.text, /^Visible page, \d+x\d+/);
    assert.ok(image.data.length > 5000, 'a real picture, not a blank one');
  };
  await tools();

  await b.ui('group:to-window', { group: 'w', window: one });
  assert.deepEqual((await win(one)).groups, ['w']);
  assert.ok((await stateOf(one)).tabs.some((t) => t.group === 'w'));
  assert.ok(!(await stateOf(two)).tabs.some((t) => t.group === 'w'));
  await s.text('navigate', { url: b.base + '/index.html?moved' });
  await tools();
});

test('closing a window closes its tabs; a session\'s group in it moves to another window', async () => {
  await b.ui('group:to-window', { group: 'w', window: two });
  const gone = (await win(two)).tabs.filter((id) => id);
  await b.ui('window:close', two);
  await wait('the window to close', async () => (await windows()).length === 1);
  const left = await b.state();
  const own = gone.filter((id) => left.tabs.some((t) => t.id === id && t.group === 'you'));
  assert.deepEqual(own, [], 'its own tabs closed');
  assert.ok(left.tabs.some((t) => t.group === 'w'), 'the session\'s tab is in the remaining window');
  assert.match(await b.as('w').text('snapshot'), /Fixture page/, 'and still works');
});

let priv;
test('a private window is marked, keeps no history, and shares no cookies', async () => {
  // The normal window first sets a cookie of its own on the same site.
  await from(one, 'go', b.base + '/index.html?normal');
  const normal = await loaded(one);
  await js(normal.id, 'document.cookie = "who=normal; path=/"');

  priv = await b.ui('window:new', { private: true });
  const p = await stateOf(priv);
  assert.equal(p.window.private, true);
  assert.ok(p.tabs.every((t) => t.private));
  assert.equal((await stateOf(one)).window.private, false);
  await from(priv, 'go', b.base + '/second.html?private-visit');
  const tab = await loaded(priv);
  assert.equal(await js(tab.id, 'document.cookie'), '', 'it does not see the normal window\'s cookies');
  await js(tab.id, 'document.cookie = "who=private; path=/"');
  assert.equal(await js(tab.id, 'document.cookie'), 'who=private');
  assert.equal(await js(normal.id, 'document.cookie'), 'who=normal', 'and the normal window does not see its own');

  // History: the normal visit is kept, the private one is not.
  await wait('history.json to be written', () => {
    try { return fs.readFileSync(path.join(home, 'history.json'), 'utf8').includes('?normal'); } catch { return false; }
  });
  await pause(1200); // history is written in batches
  assert.ok(!fs.readFileSync(path.join(home, 'history.json'), 'utf8').includes('private-visit'));
});

test('a private window has Shields on', async () => {
  await from(priv, 'go', b.base + '/shields.html');
  await loaded(priv);
  const s = await wait('blocked requests in the private window', async () => {
    const now = (await stateOf(priv)).shields;
    return now?.blocked >= 2 && now;
  }, 20000);
  assert.equal(s.on, true);
});

test('the command palette opens in the window it is asked from', async () => {
  await from(one, 'menu:key', 'CmdOrCtrl+K');
  await wait('the palette in the first window', async () => (await from(one, 'palette')).open);
  assert.equal((await from(one, 'palette')).window, one);
  await from(one, 'palette:key', { key: 'Escape' });
  await wait('the palette to close', async () => !(await from(one, 'palette')).open);
  await from(priv, 'menu:key', 'CmdOrCtrl+K');
  const p = await wait('the palette in the private window', async () => {
    const now = await from(priv, 'palette');
    return now.open && now.window === priv && now;
  });
  assert.equal(p.inFront, true, 'in front of the private window\'s pages');
  await from(priv, 'palette:key', { key: 'Escape' });
  await wait('the palette to close', async () => !(await from(priv, 'palette')).open);
});

test('reader view works in a private window', async () => {
  await from(priv, 'go', b.base + '/article.html');
  const tab = await loaded(priv);
  await from(priv, 'reader:toggle');
  await wait('reader view in the private tab', async () => (await js(tab.id, 'location.protocol').catch(() => '')) === 'loui-reader:');
  assert.ok((await js(tab.id, 'document.body.innerText.length')) > 200, 'the article is shown');
  assert.equal((await stateOf(priv)).tabs.find((t) => t.id === tab.id).private, true);
  await from(priv, 'reader:toggle');
});

test('a private window stays out of the Claude panel\'s reach, and out of a normal window\'s palette', async () => {
  await from(priv, 'go', b.base + '/index.html?private-opener');
  const opener = await loaded(priv);
  // The page opens a tab on the user's click, as a target=_blank link does.
  await b.ui('tab:js', { id: opener.id, acted: true, code: 'window.open("/second.html?secret-private"); 1' });
  await wait('the opened tab', async () => (await stateOf(priv)).tabs.find((t) => t.url.includes('secret-private') && !t.loading));
  await b.ui('window:focus', priv);
  // The panel reads the user's current tab: never one of these.
  const seen = JSON.stringify(await b.ui('panel', { tool: 'snapshot' }).catch((e) => String(e)));
  assert.ok(!seen.includes('secret-private') && !seen.includes('private-opener'), seen);
  // A tab the panel opens goes to the normal window, though the private one is focused.
  const before = (await win(priv)).tabs.length;
  await b.ui('panel', { tool: 'tabs', args: { action: 'new' } });
  assert.equal((await win(priv)).tabs.length, before);
  // The normal window's palette does not list private tabs; the private window's lists only them.
  const rows = async (id) => {
    await from(id, 'menu:key', 'CmdOrCtrl+K');
    await wait('the palette', async () => { const p = await from(id, 'palette'); return p.open && p.window === id; });
    await from(id, 'palette:type', 'second');
    const p = await wait('results', async () => { const now = await from(id, 'palette'); return now.answered === 'second' && now; });
    await from(id, 'palette:key', { key: 'Escape' });
    await wait('the palette to close', async () => !(await from(id, 'palette')).open);
    return p.groups.flatMap((g) => g.rows).map((r) => r.detail);
  };
  assert.ok(!(await rows(one)).some((d) => d.includes('secret-private')));
  assert.ok((await rows(priv)).some((d) => d.includes('secret-private')));
});

test('a private tab\'s icon is fetched in its own session and leaves nothing on disk', async () => {
  await from(priv, 'go', b.base + '/icon.html');
  const tab = await wait('the icon', async () => {
    const t = await tabIn(priv);
    return t?.favicon && t;
  });
  assert.match(tab.favicon, /^data:image\/png;base64,/, 'the window chrome is given the picture, not its address');
  await pause(1500); // anything a cache would write
  const found = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (st.size < 20e6) {
        try { if (fs.readFileSync(p).includes('private-icon-marker')) found.push(path.relative(home, p)); } catch {}
      }
    }
  };
  walk(home);
  assert.deepEqual(found, []);
});

test('a page opens tabs only after an action in it, and only so many', async () => {
  await from(one, 'go', b.base + '/index.html?opener');
  const tab = await loaded(one);
  const count = async (mark) => (await stateOf(one)).tabs.filter((t) => t.url.includes(mark)).length;
  await js(tab.id, 'window.open("/second.html?unasked"); 1');
  await pause(600);
  assert.equal(await count('unasked'), 0, 'not by itself');
  for (let i = 0; i < 13; i++) await b.ui('tab:js', { id: tab.id, acted: true, code: `window.open("/second.html?asked-${i}"); 1` });
  await pause(600);
  assert.equal(await count('asked-'), 10, 'ten in a minute');
  for (const t of (await stateOf(one)).tabs.filter((x) => x.url.includes('asked-'))) await from(one, 'tab:close', t.id);
});

test('a tab handed to a session does not bring what it logged for the user', async () => {
  const s = b.as('h', 'Claude Code · handed');
  await s.text('navigate', { url: b.base + '/second.html?own' });
  await b.ui('window:focus', one);
  await from(one, 'go', b.base + '/index.html?before-handing');
  const mine = await loaded(one);
  await js(mine.id, 'console.log("said-before-handing"); 1');
  const asked = s.text('request_tab');
  await wait('the question', async () => (await stateOf(one)).asking);
  await from(one, 'handoff:answer', true);
  await asked;
  assert.doesNotMatch(await s.text('console_logs'), /said-before-handing/);
  assert.doesNotMatch(await s.text('network_requests'), /before-handing/);
  s.end();
  await wait('the tab to come back', async () => (await stateOf(one)).tabs.some((t) => t.id === mine.id && t.group === 'you'));
});

test('Claude sessions do not work in a private window unless handed a tab, which stays private', async () => {
  // Focused on the private window, a new session still gets a normal window.
  await b.ui('window:focus', priv);
  const s = b.as('p', 'Claude Code · private');
  await s.text('navigate', { url: b.base + '/second.html?session' });
  assert.ok((await win(one)).groups.includes('p'));
  assert.ok(!(await win(priv)).groups.includes('p'));
  // Nor can its group be moved there.
  await b.ui('group:to-window', { group: 'p', window: priv });
  assert.ok((await win(one)).groups.includes('p'));
  // Its tabs do not see the private cookie.
  assert.doesNotMatch(await s.text('evaluate', { code: 'document.cookie' }), /private/);

  // The user hands it the private tab on screen: the tab goes to the
  // session's group (in the normal window), keeping its private session.
  await from(priv, 'go', b.base + '/index.html?handed');
  const handed = await loaded(priv);
  const asked = s.text('request_tab');
  await pause(300);
  assert.equal((await stateOf(priv)).asking?.label, 'Claude Code · private', 'asked in the window the user is in');
  await from(priv, 'handoff:answer', true);
  await asked;
  const now = (await b.state()).tabs.find((t) => t.id === handed.id) || (await stateOf(one)).tabs.find((t) => t.id === handed.id);
  assert.equal(now.group, 'p');
  assert.equal(now.private, true);
  assert.ok((await win(one)).tabs.includes(handed.id));
  assert.match(await s.text('evaluate', { code: 'document.cookie' }), /who=private/, 'still in the private session');
  // The relay guard covers the private session too.
  assert.match(await s.text('evaluate', {
    code: `fetch(${JSON.stringify(relay.url + '/healthz')}, { mode: 'no-cors' }).then(() => 'reached', () => 'blocked')`,
  }), /blocked/);
  // When the session ends the tab goes back to the private window.
  s.end();
  await wait('the tab to come back', async () => (await win(priv))?.tabs.includes(handed.id));
});

test('closing the private window forgets its cookies', async () => {
  await b.ui('window:close', priv);
  await wait('the window to close', async () => !(await win(priv)));
  priv = await b.ui('window:new', { private: true });
  await from(priv, 'go', b.base + '/second.html?again');
  const tab = await loaded(priv);
  assert.equal(await js(tab.id, 'document.cookie'), '');
});

test('restore brings back the normal windows, not the private one', async () => {
  two = await b.ui('window:new');
  await from(two, 'go', b.base + '/index.html?restored-two');
  await loaded(two);
  await from(one, 'go', b.base + '/index.html?restored-one');
  await loaded(one);
  await pause(1500); // tabs.json is written within a second of a change
  await b.close();
  fs.rmSync(path.join(home, 'loui.sock'), { force: true });
  b = await launch(env, { home });
  const all = await wait('two windows', async () => {
    const list = await windows();
    return list.length === 2 && list;
  });
  assert.ok(all.every((w) => !w.private));
  const urls = [];
  for (const w of all) urls.push((await stateOf(w.id)).tabs.map((t) => t.url));
  assert.ok(urls[0].some((u) => u.includes('restored-one')), 'the first window is the first one again');
  assert.ok(urls[1].some((u) => u.includes('restored-two')));
  assert.ok(!urls.flat().some((u) => /private|again|handed/.test(u)), 'no private tab came back');
});

test('closing the last window quits', async () => {
  const all = await windows();
  for (const w of all.slice(0, -1)) await b.ui('window:close', w.id);
  b.ui('window:close', all[all.length - 1].id).catch(() => {}); // no answer comes: Loui quits
  const code = await Promise.race([b.exited, pause(15000).then(() => 'still running')]);
  assert.notEqual(code, 'still running');
});
