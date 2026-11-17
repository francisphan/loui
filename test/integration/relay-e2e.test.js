// One continuous story, end to end, as it happens for real: the relay runs as
// a process of its own, a real Loui signs in to it with the relay key, and
// real MCP clients work in the browser through it: first Claude Code with the
// key, then Claude's connector through the whole OAuth flow, driven with plain
// HTTP as claude.ai drives it.
//
// test/relay.test.js checks the relay's rules one at a time, against a relay
// started inside the test process; this file checks that the pieces make one
// working whole. Run with `npm run test:integration`.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { launch } = require('../drive');

const root = path.join(__dirname, '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, check, ms = 10000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
    const got = await check();
    if (got) return got;
  }
  assert.fail(`timed out waiting for ${what}`);
}
const ref = (outline, start) => {
  const line = outline.split('\n').find((l) => l.trim().startsWith(start));
  assert.ok(line, `no "${start}" in:\n${outline}`);
  return line.match(/\[(e\d+)\]/)[1];
};

let relay, b; // relay: { url, key, home, process }

// The relay as `npm run relay` starts it, on a port and a home of its own.
async function startRelay() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'loui-e2e-relay-'));
  const child = spawn(process.execPath, [path.join(root, 'relay', 'server.js')], {
    env: { ...process.env, LOUI_RELAY_PORT: '0', LOUI_RELAY_HOME: home, LOUI_PUBLIC_URL: '', LOUI_LAUNCH: '', LOUI_PRIMARY: '' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let out = '';
  child.stdout.setEncoding('utf8').on('data', (d) => { out += d; });
  const url = await until('the relay to say where it listens', () => {
    if (child.exitCode !== null) assert.fail(`the relay exited with ${child.exitCode}`);
    return out.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
  });
  // The key is where the relay says it is: the file its owner reads it from.
  const keyFile = (await until('the relay to say where its key is', () => out.match(/Relay key: (.+)/)))[1].trim();
  return { url, key: fs.readFileSync(keyFile, 'utf8').trim(), home, process: child };
}

// A Claude session: an MCP client signed in with a bearer token.
async function connect(name, token) {
  const transport = new StreamableHTTPClientTransport(new URL(relay.url + '/mcp'), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(transport);
  const call = async (tool, args = {}) => {
    const r = await client.callTool({ name: tool, arguments: args });
    const words = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (r.isError) throw new Error(words);
    return r.content;
  };
  const text = async (tool, args) => (await call(tool, args)).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  return { client, transport, call, text };
}
const groups = async () => (await b.state()).groups.filter((g) => g.id !== 'you');
const linked = async (status) => until(`the link to be ${status}`, async () => (await b.state()).link.status === status);
// The browser asks the user before a new session first uses it; the user answers in the window.
async function letIn(value, expected) {
  const p = await until('the browser to ask the user', async () => {
    const q = (await b.state()).prompt;
    return q?.kind === 'consent' && q;
  });
  assert.equal(p.connector.kind, expected);
  await b.ui('prompt:answer', { id: p.id, value });
  return p;
}

test.before(async () => {
  relay = await startRelay();
  b = await launch(); // not connected to anything yet
});
test.after(async () => {
  await b?.close();
  if (relay) {
    relay.process.kill();
    try { fs.rmSync(relay.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {}
  }
});

test('the relay turns away a caller who is not signed in, and says where to sign in', async () => {
  assert.equal((await (await fetch(relay.url + '/healthz')).json()).ok, true);
  const res = await fetch(relay.url + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate'), /resource_metadata=/);
});

test('the user signs the browser in to the relay with the key', async () => {
  // Before the browser is there, a session signed in with the key is told so.
  const early = await connect('claude-code', relay.key);
  await assert.rejects(early.text('snapshot'), /No Loui browser is online/);
  await early.transport.terminateSession();

  // The relay's address and key, as entered in Settings: a wrong key first.
  await b.ui('relay:set', { url: relay.url, key: 'not-the-key', on: true });
  await linked('refused');
  await b.ui('relay:set', { url: relay.url, key: relay.key, on: true });
  await linked('connected');
  const saved = JSON.parse(fs.readFileSync(path.join(b.home, 'relay.json'), 'utf8'));
  assert.equal(saved.url, relay.url);
});

let code; // the Claude Code session, for the tests that follow

test('Claude Code connects with the key, and the user lets it in', async () => {
  code = await connect('claude-code', relay.key);
  const names = (await code.client.listTools()).tools.map((t) => t.name);
  for (const name of ['navigate', 'snapshot', 'click', 'type', 'screenshot', 'read_article', 'request_tab', 'devices']) {
    assert.ok(names.includes(name), name);
  }
  assert.match(code.client.getInstructions(), /tab group/);

  const first = code.text('navigate', { url: b.base });
  const asked = await letIn('allow', 'key');
  assert.equal(asked.who, 'Claude Code');
  assert.ok(!JSON.stringify(asked).includes(relay.key), 'the key itself never reaches the window');
  assert.match(await first, /heading1 "Fixture page"/);
  assert.deepEqual((await groups()).map((g) => g.label), ['Claude Code']);
  assert.match(await code.text('devices', { action: 'list' }), new RegExp(`> ${os.hostname()}`));
});

test('it works in its own tab, in the background: snapshot, type, click, screenshot, read_article', async () => {
  const mine = (await b.state()).tabs.find((t) => t.group === 'you' && t.active);
  const page = await code.text('snapshot');
  await code.text('type', { ref: ref(page, 'textbox "Your name"'), text: 'Ada', clear: true });
  assert.match(await code.text('click', { ref: ref(page, 'button "Greet"') }), /Hello, Ada/);

  const shot = await code.call('screenshot');
  const image = shot.find((c) => c.type === 'image');
  assert.ok(image, 'a picture came back through the relay');
  assert.ok(Buffer.from(image.data, 'base64').length > 2000, 'and is not empty');

  await code.text('navigate', { url: b.base + '/article.html' });
  const article = await code.text('read_article');
  assert.match(article, /The Lighthouse Keepers of Ushant/);
  assert.match(article, /Marguerite Penhoat/);
  assert.doesNotMatch(article, /discount widgets/, 'without the ad beside it');

  // The user's own tab stayed on screen throughout, and the session sees only its own.
  assert.ok((await b.state()).tabs.find((t) => t.id === mine.id).active);
  assert.equal((await code.text('tabs', { action: 'list' })).match(/^[> ] \d+ {2}/gm).length, 1);
});

test('before it sends something, the user is asked in the window, and their answer decides', async () => {
  const page = await code.text('navigate', { url: b.base + '/guard.html' });
  const tab = (await b.state()).tabs.find((t) => t.group !== 'you' && t.current);
  const out = () => b.ui('tab:js', { id: tab.id, code: "document.getElementById('out').textContent" });
  const guard = () => until('a guardrail question', async () => (await b.state()).guard);

  const blocked = code.text('click', { ref: ref(page, 'button "Delete"') });
  const first = await guard();
  assert.equal(first.who, 'Claude Code');
  assert.equal(first.what, 'click "Delete"');
  assert.equal(await out(), 'nothing yet', 'nothing reaches the page while the user is asked');
  await b.ui('guard:answer', { id: first.id, choice: 'block' });
  await assert.rejects(blocked, /The user declined/);
  assert.equal(await out(), 'nothing yet');

  const allowed = code.text('click', { ref: ref(page, 'button "Send"') });
  await b.ui('guard:answer', { id: (await guard()).id, choice: 'once' });
  assert.match(await allowed, /text "sent"/);
  assert.equal((await b.state()).guard, null);
});

test('the user takes over, the session is told to wait, and carries on when handed back', async () => {
  const [g] = await groups();
  await b.ui('pause', { group: g.id, on: true });
  await assert.rejects(code.text('navigate', { url: b.base + '/second.html' }), /taken over this tab group/);
  assert.match(await code.text('snapshot'), /Things Claude should ask about/, 'it can still read');
  await b.ui('pause', { group: g.id, on: false });
  assert.match(await code.text('navigate', { url: b.base + '/second.html' }), /Second page/);
});

test('the user hands it the tab they are looking at, and gets it back when the session ends', async () => {
  await b.ui('go', b.base + '/plain.html');
  const lent = await until('the user\'s page to load', async () => {
    const t = (await b.state()).tabs.find((x) => x.active);
    return t.url.endsWith('/plain.html') && !t.loading && t;
  });
  const asked = code.text('request_tab');
  await until('the browser to ask about the hand-over', async () => (await b.state()).asking);
  await b.ui('handoff:answer', true);
  assert.match(await asked, new RegExp(`handed you tab ${lent.id}`));
  const [g] = await groups();
  assert.equal((await b.state()).tabs.find((t) => t.id === lent.id).group, g.id);

  // The session ends: its group closes, and the lent tab is the user's again.
  await code.transport.terminateSession();
  await until('the group to close', async () => (await groups()).length === 0);
  const tabs = (await b.state()).tabs;
  assert.equal(tabs.find((t) => t.id === lent.id)?.group, 'you');
  assert.ok(tabs.every((t) => t.group === 'you'), 'none of the session\'s own tabs are left');
});

// ── Claude's connector: OAuth, as claude.ai does it ─────────────────────────
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const form = (fields) => ({ method: 'POST', body: new URLSearchParams(fields) });
let oauth; // { meta, client, tokens }

test('the connector finds the sign-in, registers, and the owner approves it with the key', async () => {
  // Discovery, from the 401: the resource names its authorization server, which names its endpoints.
  const refused = await fetch(relay.url + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const resource = await (await fetch(refused.headers.get('www-authenticate').match(/resource_metadata="([^"]+)"/)[1])).json();
  assert.equal(new URL(resource.resource).origin, relay.url);
  const issuer = resource.authorization_servers[0];
  const meta = await (await fetch(new URL('/.well-known/oauth-authorization-server', issuer))).json();
  for (const endpoint of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint']) {
    assert.equal(new URL(meta[endpoint]).origin, relay.url, endpoint);
  }
  assert.ok(meta.code_challenge_methods_supported.includes('S256'));

  // Dynamic client registration.
  const registered = await fetch(meta.registration_endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
  });
  assert.equal(registered.status, 201);
  const client = await registered.json();

  // Authorize: the owner's browser is sent to the approval page.
  const verifier = crypto.randomBytes(32).toString('base64url');
  const state = crypto.randomBytes(8).toString('hex');
  const authorize = new URL(meta.authorization_endpoint);
  authorize.search = new URLSearchParams({
    response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, state,
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
  });
  const toApproval = await fetch(authorize, { redirect: 'manual' });
  assert.equal(toApproval.status, 302);
  const approval = new URL(toApproval.headers.get('location'), relay.url);
  const page = await (await fetch(approval)).text();
  assert.match(page, /claude\.ai/, 'the page names where access goes');

  // The owner types the key into it. A wrong key gets nothing.
  const answer = (key) => fetch(relay.url + '/approve', { ...form({ request: approval.searchParams.get('request'), key }), redirect: 'manual' });
  assert.equal((await answer('a guess')).status, 403);
  const approved = await answer(relay.key);
  assert.equal(approved.status, 302);
  const back = new URL(approved.headers.get('location'));
  assert.equal(back.origin + back.pathname, REDIRECT);
  assert.equal(back.searchParams.get('state'), state);

  // The code is exchanged for tokens; the wrong verifier gets none.
  const exchange = (code_verifier) => fetch(meta.token_endpoint, form({
    grant_type: 'authorization_code', code: back.searchParams.get('code'), code_verifier, client_id: client.client_id, redirect_uri: REDIRECT,
  }));
  assert.equal((await exchange('not-the-verifier')).status, 400);
  const tokens = await (await exchange(verifier)).json();
  assert.ok(tokens.access_token && tokens.refresh_token);
  assert.notEqual(tokens.access_token, relay.key);
  oauth = { meta, client, tokens };
});

test('the connector works in the browser with its token, asked about on its own', async () => {
  const s = await connect('claude-ai', oauth.tokens.access_token);
  const first = s.text('navigate', { url: b.base });
  const asked = await letIn('allow', 'connector');
  assert.equal(asked.connector.name, 'Claude');
  assert.match(await first, /heading1 "Fixture page"/);
  assert.deepEqual((await groups()).map((g) => g.label), ['Claude']);
  const page = await s.text('snapshot');
  assert.match(await s.text('click', { ref: ref(page, 'button "Count"') }), /Clicked 1/);

  // Its token wears out: a refresh gives a new pair, and the new token carries on in a new session.
  const renewed = await fetch(oauth.meta.token_endpoint, form({
    grant_type: 'refresh_token', refresh_token: oauth.tokens.refresh_token, client_id: oauth.client.client_id,
  }));
  assert.equal(renewed.status, 200);
  const next = await renewed.json();
  assert.ok(next.access_token && next.refresh_token !== oauth.tokens.refresh_token);
  await s.transport.terminateSession();
  await until('the connector\'s group to close', async () => (await groups()).length === 0);

  const again = await connect('claude-ai', next.access_token);
  const second = again.text('navigate', { url: b.base + '/second.html' });
  await letIn('allow', 'connector'); // "Allow" was for that one session
  assert.match(await second, /Second page/);
  await again.transport.terminateSession();
  await until('its group to close', async () => (await groups()).length === 0);
});

test('when the relay goes away the browser says so, and nothing of the sessions is left', async () => {
  relay.process.kill();
  await linked('offline');
  assert.equal((await groups()).length, 0);
  assert.equal((await b.state()).prompt, null);
});
