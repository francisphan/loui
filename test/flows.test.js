// Things that used to go quietly wrong: a guardrail question behind another
// window, a private window left blank after lending its tab (and closing it
// under the session), download rows with no way on, relay trouble that looked
// like nothing, a crashed page, a site with a certificate of its own, and a
// few small cues in the window chrome.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { start } = require('../relay/server');
const { launch } = require('./drive');

let b, relay, relayHome, files, server, url;
const held = []; // responses of slow downloads, waiting for release()

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = async (what, check, ms = 10000) => {
  for (const end = Date.now() + ms; Date.now() < end; await pause(100)) {
    const value = await check();
    if (value) return value;
  }
  throw new Error(`timed out waiting for ${what}`);
};
const ref = (outline, start) => {
  const line = outline.split('\n').find((l) => l.trim().startsWith(start));
  assert.ok(line, `no "${start}" in:\n${outline}`);
  return line.match(/\[(e\d+)\]/)[1];
};
const windows = () => b.ui('windows');
const win = async (id) => (await windows()).find((w) => w.id === id);
const stateOf = (id) => b.ui('in-window', { window: id, ui: 'state' });
const from = (id, ui, arg) => b.ui('in-window', { window: id, ui, arg });
// A line of script in a window's chrome (the first window's if none is named).
const chrome = (code, id) => (id ? from(id, 'chrome:eval', code) : b.ui('chrome:eval', code));
const js = (id, code) => b.ui('tab:js', { id, code });
const onScreen = async (id) => (await (id ? stateOf(id) : b.state())).tabs.find((t) => t.active);
const visit = async (to, id) => {
  await (id ? from(id, 'go', to) : b.ui('go', to));
  return wait(`${to} to load`, async () => { const t = await onScreen(id); return t.url === to && !t.loading && t.title && t; });
};
const colour = (selector, what = 'color', id) => chrome(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).${what}`, id);
// A colour token of the window chrome, as the browser computes it.
const token = (name, id) => chrome(`(() => { const n = document.createElement('i'); n.style.color = 'var(${name})'; document.body.append(n); const c = getComputedStyle(n).color; n.remove(); return c; })()`, id);

// /file/<name>: a small attachment. /slow/<name>: sends its first part, then
// waits for release(). /nolength/<name>: the same, without saying how big it is.
function serveFiles() {
  server = http.createServer((req, res) => {
    const [, kind, name] = req.url.split('/');
    const headers = { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${name}"` };
    if (kind === 'file') res.writeHead(200, { ...headers, 'content-length': 5 }).end('hello');
    else if (kind === 'slow' || kind === 'nolength') {
      res.writeHead(200, kind === 'slow' ? { ...headers, 'content-length': 128 * 1024 } : headers);
      res.write(Buffer.alloc(64 * 1024, 1));
      held.push(res);
    } else res.writeHead(404).end();
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)));
}
const release = () => { for (const res of held.splice(0)) res.end(Buffer.alloc(64 * 1024, 2)); };

test.before(async () => {
  url = await serveFiles();
  files = fs.mkdtempSync(path.join(os.tmpdir(), 'loui-flows-dl-'));
  relayHome = fs.mkdtempSync(path.join(os.tmpdir(), 'loui-flows-relay-'));
  relay = await start({ port: 0, home: relayHome, graceMs: 600, idleMs: 60000 });
  // The relay is given a key that is not its own, so it refuses this browser.
  b = await launch({ LOUI_DOWNLOADS: files, LOUI_RELAY_URL: relay.url, LOUI_RELAY_KEY: 'not-the-relay-key' });
});
test.after(async () => {
  release();
  await b?.close();
  await relay?.close();
  server?.close();
  for (const dir of [files, relayHome]) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {}
  }
});

// ── the relay ───────────────────────────────────────────────────────────────
test('a relay that refuses the key shows in red, and the relay form opens once', async () => {
  await wait('the relay to refuse', async () => (await b.state()).link.status === 'refused');
  await wait('the form to open', () => chrome("!document.getElementById('relay').hidden"));
  const danger = await token('--danger');
  assert.equal(await chrome("document.getElementById('link-text').textContent"), 'Refused');
  assert.equal(await colour('#link-text'), danger);
  assert.equal(await colour('#link .lamp', 'backgroundColor'), danger, 'the lamp is filled, in red');
  assert.equal(await colour('#relay-status'), danger);
  assert.match(await chrome("document.getElementById('relay-status').textContent"), /^The relay refused this browser/);
  // Closed by the user, it stays closed while the state is drawn again.
  await chrome("document.getElementById('relay-close').click()");
  await b.ui('tab:new', b.base + '/second.html');
  await pause(500);
  assert.equal(await chrome("document.getElementById('relay').hidden"), true);
});

test('a relay that cannot be reached says "Offline, retrying" in both places; off is a hollow lamp', async () => {
  await b.ui('relay:set', { url: 'ws://127.0.0.1:9', key: 'any', on: true });
  await wait('offline', async () => (await b.state()).link.status === 'offline');
  await wait('the header to say so', async () => (await chrome("document.getElementById('link-text').textContent")) === 'Offline, retrying');
  assert.match(await chrome("document.getElementById('relay-status').textContent"), /^Offline, retrying/);
  assert.equal(await colour('#link .lamp', 'backgroundColor'), await token('--danger'));
  await b.ui('relay:set', { url: 'ws://127.0.0.1:9', key: '', on: false });
  await wait('off', async () => (await b.state()).link.status === 'off');
  await wait('a hollow lamp', async () => (await colour('#link .lamp', 'backgroundColor')) === 'rgba(0, 0, 0, 0)');
});

// ── a guardrail question, with the user in another window ───────────────────
let one, two, priv, s;
test('a guardrail question shows in the window the user is in, and Show tab brings its tab up', async () => {
  one = (await b.state()).window.id;
  s = b.as('flow', 'Claude Code · flow');
  const page = await s.text('navigate', { url: `${b.base}/guard.html` });
  assert.ok((await win(one)).groups.includes('flow'));
  two = await b.ui('window:new');
  priv = await b.ui('window:new', { private: true });
  await b.ui('window:focus', two);

  const clicking = s.text('click', { ref: ref(page, 'button "Send"') });
  const there = await wait('the question in the window with the tab', async () => (await stateOf(one)).guard);
  assert.equal(there.elsewhere, null);
  const here = await wait('the question in the window the user is in', async () => (await stateOf(two)).guard);
  assert.equal(here.id, there.id);
  assert.match(here.elsewhere, /^Window with “/, 'it says which window the tab is in');
  assert.equal(here.who, 'Claude Code · flow');
  assert.equal(here.onScreen, false);
  // The window draws it a moment after the state says so.
  await wait('the question to be drawn there', async () => /Claude Code · flow wants to click "Send" on .*Its tab is in another window/
    .test(await chrome("document.getElementById('guard-text').textContent", two)));
  assert.equal((await stateOf(priv)).guard, null);

  // Never in a private window, for a tab that is not in it.
  await b.ui('window:focus', priv);
  assert.equal((await stateOf(priv)).guard, null, 'not in a private window');
  assert.equal((await stateOf(two)).guard, null, 'it follows the window the user is in');
  assert.ok((await stateOf(one)).guard, 'and stays where the tab is');
  await b.ui('window:focus', two);

  // Show tab, pressed in the window chrome, puts the session's tab on screen in its window.
  const tab = (await stateOf(one)).tabs.find((t) => t.group === 'flow');
  assert.equal(tab.active, false);
  await chrome("document.getElementById('guard-show').click()", two);
  await wait('the tab to come on screen', async () => (await stateOf(one)).tabs.find((t) => t.id === tab.id).active);

  // And the answer, pressed in the window chrome, reaches the session.
  await b.ui('window:focus', two);
  await wait('the buttons to take an answer', async () => !(await chrome("document.getElementById('guard-once').disabled", two)));
  await chrome("document.getElementById('guard-once').click()", two);
  assert.match(await clicking, /text "sent"/);
  assert.equal((await stateOf(two)).guard, null);
});

// ── lending a private window's only tab ─────────────────────────────────────
test('lending a private window\'s only tab leaves a blank tab on screen there, and the lent tab is marked', async () => {
  await b.ui('window:focus', priv);
  const handed = await visit(b.base + '/index.html?lent', priv);
  const asked = s.text('request_tab');
  await wait('the hand-over question', async () => (await stateOf(priv)).asking);
  await from(priv, 'handoff:answer', true);
  await asked;
  const left = await stateOf(priv);
  assert.equal(left.tabs.length, 1);
  assert.notEqual(left.tabs[0].id, handed.id);
  assert.equal(left.tabs[0].active, true, 'the blank tab is on screen, not nothing');
  const lent = (await stateOf(one)).tabs.find((t) => t.id === handed.id);
  assert.deepEqual([lent.group, lent.private, lent.lent], ['flow', true, true]);
  const mask = await chrome(`document.querySelector('.tab[data-id="${handed.id}"] .lent-private')?.title`, one);
  assert.match(mask, /A private tab you lent to Claude Code · flow/);
});

test('closing the last private window while a session holds its tab asks first', async () => {
  const lent = (await stateOf(one)).tabs.find((t) => t.group === 'flow' && t.private);
  await b.ui('window:close', priv);
  const asked = await wait('the question', async () => (await stateOf(priv))?.window.closing);
  assert.deepEqual(asked, { tabs: 1, who: ['Claude Code · flow'] });
  assert.match(await chrome("document.getElementById('close-ask-text').textContent", priv), /also closes the private tab you lent to Claude Code · flow/);
  // Keep this window: nothing closes.
  await chrome("document.getElementById('close-ask-no').click()", priv);
  await wait('the question to go', async () => !(await stateOf(priv)).window.closing);
  assert.ok(await win(priv));
  assert.ok((await stateOf(one)).tabs.some((t) => t.id === lent.id));
  // Close anyway: the window goes, and the lent tab with it.
  await b.ui('window:close', priv);
  await wait('the question again', async () => (await stateOf(priv))?.window.closing);
  await chrome("document.getElementById('close-ask-yes').click()", priv);
  await wait('the window to close', async () => !(await win(priv)));
  assert.ok(!(await stateOf(one)).tabs.some((t) => t.id === lent.id), 'the private tab closed with its last private window');
  await b.ui('window:close', two);
  await wait('the second window to close', async () => !(await win(two)));
});

// ── small cues ──────────────────────────────────────────────────────────────
test('an emulated device has Reset beside its name', async () => {
  await s.text('set_viewport', { preset: 'iphone' });
  const tab = (await b.state()).tabs.find((t) => t.group === 'flow' && t.current);
  await b.ui('tab:select', tab.id);
  await wait('Reset to show', () => chrome("!document.getElementById('device-reset').hidden"));
  assert.equal((await onScreen()).device, 'iPhone');
  await chrome("document.getElementById('device-reset').click()");
  await wait('the full window again', async () => (await onScreen()).device === null);
  assert.equal(await chrome("document.getElementById('device-reset').hidden"), true);
  s.end();
});

test('"No matches" in the find bar is in the danger colour', async () => {
  const mine = (await b.state()).tabs.find((t) => t.group === 'you');
  await b.ui('tab:select', mine.id);
  await b.ui('find:open');
  await b.ui('find', { text: 'surely not on this page' });
  await wait('No matches', async () => (await chrome("document.getElementById('find-count').textContent")) === 'No matches');
  assert.equal(await colour('#find-count'), await token('--danger'));
  await b.ui('find:close');
});

// ── downloads ───────────────────────────────────────────────────────────────
const listed = async () => (await b.state()).downloads.items;
const download = (name, check, what) => wait(`${name} ${what}`, async () => {
  const d = (await listed()).find((x) => x.name === name);
  return d && check(d) && d;
});
const row = (name) => `[...document.querySelectorAll('#downloads-list .download')].find((n) => n.querySelector('.name').textContent === ${JSON.stringify(name)})`;
const acts = (name) => chrome(`[...(${row(name)}?.querySelectorAll('.acts button') || [])].map((x) => x.textContent)`);
const press = (name, label) => chrome(`[...${row(name)}.querySelectorAll('.acts button')].find((x) => x.textContent === ${JSON.stringify(label)}).click()`);

test('a downloaded program says "Run…" and asks in its row; a finished row can be removed by itself', async () => {
  await b.ui('go', `${url}/file/setup-tool.exe`);
  await download('setup-tool.exe', (d) => d.state === 'completed', 'to finish');
  await b.ui('go', `${url}/file/report.pdf`);
  await download('report.pdf', (d) => d.state === 'completed', 'to finish');
  await wait('the rows', async () => (await acts('report.pdf')).length);
  assert.deepEqual(await acts('report.pdf'), ['Open', 'Show in folder', 'Remove']);
  assert.deepEqual(await acts('setup-tool.exe'), ['Run…', 'Show in folder', 'Remove']);
  await press('setup-tool.exe', 'Run…');
  assert.deepEqual(await acts('setup-tool.exe'), ['Cancel', 'Run'], 'it asks before running');
  assert.match(await chrome(`${row('setup-tool.exe')}.querySelector('.sure').textContent`), /Run this file\?/);
  await press('setup-tool.exe', 'Cancel');
  assert.deepEqual(await acts('setup-tool.exe'), ['Run…', 'Show in folder', 'Remove']);

  await press('report.pdf', 'Remove');
  await wait('the row to go', async () => !(await listed()).some((d) => d.name === 'report.pdf'));
  assert.ok((await listed()).some((d) => d.name === 'setup-tool.exe'), 'the other row stays');
  assert.ok(fs.existsSync(path.join(files, 'report.pdf')), 'the file stays on disk');
});

test('a cancelled download can be tried again', async () => {
  await b.ui('go', `${url}/slow/again.bin`);
  const first = await download('again.bin', (d) => d.received > 0, 'to start');
  await b.ui('download:act', { id: first.id, action: 'cancel' });
  await download('again.bin', (d) => d.state === 'cancelled', 'to be cancelled');
  held.splice(0);
  await wait('Retry', async () => (await acts('again.bin')).includes('Retry'));
  assert.deepEqual(await acts('again.bin'), ['Retry', 'Remove']);
  await press('again.bin', 'Retry');
  const second = await download('again.bin', (d) => d.id !== first.id && d.received > 0, 'to start again');
  assert.equal((await listed()).filter((d) => d.name === 'again.bin').length, 1, 'the new download takes the old row\'s place');
  release();
  await download('again.bin', (d) => d.id === second.id && d.state === 'completed', 'to finish');
  assert.equal(fs.statSync(path.join(files, 'again.bin')).size, 128 * 1024);
});

test('a download of unknown size has a bar that shows it is going; a row says its speed, and when it stalls', async () => {
  await b.ui('go', `${url}/nolength/stream.bin`);
  await download('stream.bin', (d) => d.received > 0 && d.state === 'progressing', 'to start');
  await wait('the travelling bar', () => chrome(`${row('stream.bin')}?.querySelector('.bar').classList.contains('unknown')`));
  release();
  await download('stream.bin', (d) => d.state === 'completed', 'to finish');

  const d = "{ state: 'progressing', received: 1048576, total: 4194304 }";
  assert.equal(await chrome(`describe(${d}, { speed: 524288, since: Date.now() })`), '1.0 MB of 4.0 MB, 512 KB/s, 6 s left');
  assert.equal(await chrome(`describe(${d}, { speed: 524288, since: Date.now() - 11000 })`), 'Stalled, 1.0 MB of 4.0 MB');
  assert.equal(await chrome(`describe(${d}, { speed: 0, since: Date.now() })`), '1.0 MB of 4.0 MB');
});

// ── a page that crashed ─────────────────────────────────────────────────────
test('a crashed page says what happened, and Reload opens it again', async () => {
  const tab = await visit(b.base + '/second.html');
  await b.ui('tab:crash', tab.id);
  await wait('the crash page', async () => (await onScreen()).title === 'Page crashed', 20000);
  const text = await js(tab.id, 'document.body.innerText');
  assert.match(text, /This page crashed/);
  assert.match(text, /Reload/);
  assert.equal((await onScreen()).url, b.base + '/second.html', 'the address bar keeps the page\'s address');
  await js(tab.id, "document.getElementById('retry').click()");
  await wait('the page again', async () => (await onScreen()).title === 'Second');
});

// ── a site with a certificate of its own ────────────────────────────────────
test('a certificate error can be opened anyway by the user, in their own tab only, until Loui quits', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loui-flows-cert-'));
  let secure;
  try {
    try {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=127.0.0.1',
        '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore' });
    } catch {
      return t.skip('no openssl here to make a certificate with');
    }
    secure = https.createServer({ key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) }, (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' }).end('<title>Own box</title><h1>Self-signed</h1>');
    });
    await new Promise((r) => secure.listen(0, '127.0.0.1', r));
    const site = `https://127.0.0.1:${secure.address().port}/`;
    const host = new URL(site).host;

    await b.ui('go', site);
    const tab = await wait('the error page', async () => { const x = await onScreen(); return x.title === 'Not secure' && x; });
    assert.equal((await b.state()).insecure, null);
    assert.equal(await js(tab.id, "document.getElementById('advanced').hidden"), false, 'Advanced is offered in the user\'s own tab');
    assert.equal(await js(tab.id, "document.getElementById('risk').hidden"), true);
    await js(tab.id, "document.getElementById('advanced').click()");
    assert.equal(await js(tab.id, "document.getElementById('risk').hidden"), false);
    const at = await js(tab.id, "(() => { const r = document.getElementById('proceed').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()");

    // The Claude panel pressing it is not the user: the page stays shut.
    const outline = (await b.ui('panel', { tool: 'snapshot' }))[0].text;
    await b.ui('panel', { tool: 'click', args: { ref: ref(outline, 'button "Open anyway"') } });
    await pause(800);
    assert.equal((await onScreen()).title, 'Not secure', 'a click of Claude\'s opens nothing');

    // The user's own press opens it, and the address bar says "Not secure".
    await b.ui('tab:press', { id: tab.id, ...at });
    await wait('the page to open', async () => (await onScreen()).title === 'Own box');
    assert.equal((await b.state()).insecure, host);
    await wait('the mark', () => chrome("!document.getElementById('insecure-label').hidden"));
    assert.equal(await colour('#insecure-label'), await token('--danger'));
    // Remembered for this run: the page reloads without asking again.
    await b.ui('reload');
    await pause(300);
    await wait('the page again', async () => { const x = await onScreen(); return x.title === 'Own box' && !x.loading; });

    // A Claude session's tab is still refused, with no way through offered.
    const c = b.as('cert', 'Claude Code · cert');
    const page = await c.text('navigate', { url: site });
    assert.match(page, /Can't open this page safely/);
    assert.doesNotMatch(page, /Advanced|Open anyway/);
    c.end();

    // Elsewhere the mark goes.
    await visit(b.base + '/second.html');
    assert.equal((await b.state()).insecure, null);
  } finally {
    secure?.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});
