// Shields: ads and trackers on the filter lists are blocked and counted, the
// boxes they leave are hidden, and the user can turn Shields off for a site.
// The lists come from a small local list served here, never the network.
// A real relay runs too, to check that Shields never lets a Claude session's
// tab reach it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { start } = require('../relay/server');
const { launch } = require('./drive');

let b, me, lists, listUrl, relay, relayHome, home, env;
let fetched = 0; // how many times the app downloaded the list

const wait = async (what, check, ms = 10000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) {
    const value = await check();
    if (value) return value;
  }
  throw new Error(`timed out waiting for ${what}`);
};
const shields = async () => (await b.state()).shields;
const page = () => `${b.base}/shields.html`;
// The pages are opened by a session, whose tab is then put on screen: the
// Shields button reports on the tab on screen, whoever's it is.
const open = async (url) => {
  await me.text('navigate', { url });
  const tab = (await b.state()).tabs.find((t) => t.group === 'shields' && t.current);
  if (!tab.active) await b.ui('tab:select', tab.id);
};
const run = async (code) => JSON.parse(await me.text('evaluate', { code }));
const shown = (id) => run(`getComputedStyle(document.getElementById('${id}')).display !== 'none'`);
const start1 = async () => {
  b = await launch(env, { home });
  me = b.as('shields', 'Claude Code');
  await wait('Loui to connect to the relay', async () => (await b.state()).link.status === 'connected');
};

test.before(async () => {
  lists = http.createServer((req, res) => {
    fetched++;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(fs.readFileSync(path.join(__dirname, 'fixture', 'shields-list.txt')));
  });
  await new Promise((r) => lists.listen(0, '127.0.0.1', r));
  listUrl = `http://127.0.0.1:${lists.address().port}/list.txt`;
  relayHome = fs.mkdtempSync(path.join(os.tmpdir(), 'loui-shields-relay-'));
  relay = await start({ port: 0, home: relayHome, graceMs: 600, idleMs: 60000 });
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'loui-shields-'));
  env = { LOUI_SHIELDS_LISTS: listUrl, LOUI_RELAY_URL: relay.url, LOUI_RELAY_KEY: relay.key };
  await start1();
});
test.after(async () => {
  await b?.close();
  await relay.close();
  lists.close();
  for (const dir of [home, relayHome]) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {}
  }
});

test('the lists are downloaded once and kept in the profile', async () => {
  await open(`${b.base}/second.html`);
  await wait('the lists to be ready', async () => (await shields())?.ready);
  assert.equal(fetched, 1);
  assert.ok(fs.statSync(path.join(home, 'shields', 'engine.bin')).size > 0);
});

test('a request on the list is blocked and counted on the Shields button', async () => {
  await open(page());
  assert.equal(await run('window.trackerRan === true'), false, 'the tracker did not run');
  const s = await wait('two blocked requests', async () => {
    const now = await shields();
    return now.blocked === 2 && now;
  });
  assert.equal(s.site, '127.0.0.1');
  assert.equal(s.on, true);
  const net = await me.text('network_requests');
  assert.match(net, /ERR_BLOCKED_BY_CLIENT .*shields-tracker\.js/);
});

test('cosmetic rules hide ad boxes, generic and for this site, and leave the rest', async () => {
  await open(page());
  await wait('the generic ad box to be hidden', async () => !(await shown('generic')));
  await wait('the site\'s ad box to be hidden', async () => !(await shown('specific')));
  assert.equal(await shown('story'), true);
});

test('the count starts again on the next page', async () => {
  await open(page());
  await wait('two blocked requests', async () => (await shields()).blocked === 2);
  await open(`${b.base}/second.html`);
  await wait('the count to go back to nothing', async () => (await shields()).blocked === 0);
});

test('turning Shields off for the site lets everything through, and is remembered', async () => {
  await open(page());
  await b.ui('shields:set', { site: '127.0.0.1', on: false });
  await wait('the tracker to run after the reload', async () => run('window.trackerRan === true'));
  assert.equal(await shown('generic'), true);
  assert.equal(await shown('specific'), true);
  const s = await shields();
  assert.equal(s.on, false);
  assert.equal(s.blocked, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'shields.json'), 'utf8')), { off: ['127.0.0.1'] });

  // After a restart: still off, and the lists come from the profile, not the network.
  await b.close();
  await start1();
  await open(page());
  assert.equal((await shields()).on, false);
  assert.equal(await run('window.trackerRan === true'), true);
  assert.equal(fetched, 1, 'the lists were not downloaded again');

  await b.ui('shields:set', { site: '127.0.0.1', on: true });
  await wait('the tracker to be blocked after the reload', async () => (await shields()).blocked === 2);
  assert.equal(await run('window.trackerRan === true'), false);
});

test('a Claude session\'s tab is kept off the relay, with Shields on and off', async () => {
  const s = b.as('shields-s', 'Claude Code');
  const reach = () => s.text('evaluate', {
    code: `fetch(${JSON.stringify(relay.url + '/healthz')}, { mode: 'no-cors' }).then(() => 'reached', () => 'blocked')`,
  });
  for (const on of [true, false]) {
    // The relay is on 127.0.0.1 too, so turning Shields off there must not open it up.
    await b.ui('shields:set', { site: '127.0.0.1', on });
    await s.text('navigate', { url: `${b.base}/second.html` });
    assert.match(await reach(), /blocked/, `fetch with Shields ${on ? 'on' : 'off'}`);
    assert.doesNotMatch(await s.text('navigate', { url: relay.url + '/healthz' }), /"ok":true/);
  }
  s.end();
  await b.ui('shields:set', { site: '127.0.0.1', on: true });
});
