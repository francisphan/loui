// The relay: Claude sessions connect to it over MCP, Loui connects to it as a
// browser, and each session ends up with its own tab group. Runs a real relay
// and a real app.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { start } = require('../relay/server');
const { launch } = require('./drive');

let relay, b, home;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (check, what, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await check()) return;
  assert.fail(`timed out waiting for ${what}`);
};

// A Claude session: an MCP client signed in with a bearer token.
async function connect(name = 'claude-code', token = relay.key) {
  const transport = new StreamableHTTPClientTransport(new URL(relay.url + '/mcp'), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(transport);
  const text = async (tool, args = {}) => {
    const r = await client.callTool({ name: tool, arguments: args });
    const words = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (r.isError) throw new Error(words);
    return words;
  };
  return { client, transport, text };
}
const groups = async () => (await b.state()).groups.filter((g) => g.id !== 'you');

test.before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'loui-relay-test-'));
  relay = await start({ port: 0, home, graceMs: 600, idleMs: 60000 });
});
test.after(async () => {
  await b?.close();
  await relay.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test('nothing gets in without signing in', async () => {
  const res = await fetch(relay.url + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate'), /resource_metadata=/);
  await assert.rejects(connect('claude-code', 'not-the-key'));
});

test('a browser with the wrong key is turned away', async () => {
  const ws = new WebSocket(relay.url.replace('http', 'ws') + '/device');
  const reply = await new Promise((resolve) => {
    ws.on('open', () => ws.send(JSON.stringify({ hello: { key: 'wrong', device: { id: 'x', name: 'Intruder' } } })));
    ws.on('message', (data) => resolve(JSON.parse(data)));
  });
  assert.match(reply.denied, /key is wrong/);
  assert.equal(relay.devices.size, 0);
});

test('with no browser online, a session is told so', async () => {
  const s = await connect();
  await assert.rejects(s.text('snapshot'), /No Loui browser is online/);
  await s.transport.terminateSession();
});

test('Loui connects to the relay as a browser', async () => {
  b = await launch({ LOUI_RELAY_URL: relay.url, LOUI_RELAY_KEY: relay.key });
  await until(async () => (await b.state()).link.status === 'connected', 'the browser to connect');
  assert.equal(relay.devices.size, 1);
});

test('a session gets the browser tools and a tab group named after it', async () => {
  const s = await connect('claude-code');
  const { tools } = await s.client.listTools();
  const names = tools.map((t) => t.name);
  for (const name of ['navigate', 'snapshot', 'click', 'request_tab', 'devices']) assert.ok(names.includes(name), name);
  assert.match(s.client.getInstructions(), /tab group/);

  assert.match(await s.text('navigate', { url: b.base }), /heading1 "Fixture page"/);
  assert.deepEqual((await groups()).map((g) => g.label), ['Claude Code']);
  assert.match(await s.text('devices', { action: 'list' }), new RegExp(`> ${os.hostname()}`));
  await s.transport.terminateSession();
  await until(async () => (await groups()).length === 0, 'the group to close');
});

test('two sessions get two groups, and each sees only its own tabs', async () => {
  const one = await connect('claude-code');
  const two = await connect('claude-ai');
  await one.text('navigate', { url: b.base });
  await two.text('navigate', { url: b.base + '/second.html' });
  assert.deepEqual((await groups()).map((g) => g.label).sort(), ['Claude', 'Claude Code']);
  assert.match(await one.text('snapshot'), /Fixture page/);
  assert.match(await two.text('snapshot'), /Second page/);
  const mine = await one.text('tabs', { action: 'list' });
  assert.equal(mine.match(/^[> ] \d+ {2}/gm).length, 1);

  // Ending one session closes its group and leaves the other alone.
  await one.transport.terminateSession();
  await until(async () => (await groups()).length === 1, 'the first group to close');
  assert.match(await two.text('snapshot'), /Second page/);
  await two.transport.terminateSession();
  await until(async () => (await groups()).length === 0, 'the second group to close');
});

test('a session that just disappears is closed after the grace period', async () => {
  const s = await connect();
  await s.text('navigate', { url: b.base });
  assert.equal((await groups()).length, 1);
  await s.transport.close(); // no goodbye: the connection simply goes away
  await until(async () => (await groups()).length === 0, 'the abandoned group to close', 6000);
});

const register = (redirect) => fetch(relay.url + '/register', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ client_name: 'Claude', redirect_uris: [redirect], token_endpoint_auth_method: 'none' }),
});

// Registers a client and starts a sign-in; returns what the approval step needs.
async function startSignIn(redirect) {
  const registered = await (await register(redirect)).json();
  assert.ok(registered.client_id);
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const authorize = new URL(relay.url + '/authorize');
  authorize.search = new URLSearchParams({
    response_type: 'code', client_id: registered.client_id, redirect_uri: redirect,
    code_challenge: challenge, code_challenge_method: 'S256', state: 'abc',
  });
  const toApproval = await fetch(authorize, { redirect: 'manual' });
  assert.equal(toApproval.status, 302);
  const approvePage = new URL(toApproval.headers.get('location'), relay.url);
  const answer = (key) => fetch(relay.url + '/approve', {
    method: 'POST', redirect: 'manual',
    body: new URLSearchParams({ request: approvePage.searchParams.get('request'), key }),
  });
  return { registered, verifier, approvePage, answer };
}

test('sign-ins can only be sent to Claude or to this machine', async () => {
  const refused = await register('https://evil.example/callback');
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error_description, /not evil\.example/);
  assert.equal((await register('http://localhost:33418/callback')).status, 201);
});

test('the approval page names where access goes, and cannot be framed', async () => {
  const { approvePage } = await startSignIn('https://claude.ai/api/mcp/auth_callback');
  const res = await fetch(approvePage);
  const html = await res.text();
  assert.match(html, /Let Claude use your Loui browsers\?/);
  assert.match(html, /Access goes to <span class="site">claude\.ai<\/span>/);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});

test('wrong keys withdraw that one request, without locking out the owner', async () => {
  const attacker = await startSignIn('https://claude.ai/api/mcp/auth_callback');
  for (let i = 0; i < 2; i++) assert.equal((await attacker.answer('guess')).status, 403);
  assert.match(await (await attacker.answer('guess')).text(), /withdrawn/);
  assert.equal((await attacker.answer(relay.key)).status, 400, 'the withdrawn request is gone');
  const owner = await startSignIn('https://claude.ai/api/mcp/auth_callback');
  assert.equal((await owner.answer(relay.key)).status, 302);
});

test("Claude's connector signs in with OAuth, approved with the relay key", async () => {
  const redirect = 'https://claude.ai/api/mcp/auth_callback';
  const { registered, verifier, answer } = await startSignIn(redirect);
  assert.equal((await answer('guess')).status, 403);
  const approved = await answer(relay.key);
  assert.equal(approved.status, 302);
  const back = new URL(approved.headers.get('location'));
  assert.equal(back.origin + back.pathname, redirect);
  assert.equal(back.searchParams.get('state'), 'abc');

  const tokens = await (await fetch(relay.url + '/token', {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code', code: back.searchParams.get('code'), code_verifier: verifier,
      client_id: registered.client_id, redirect_uri: redirect,
    }),
  })).json();
  assert.ok(tokens.access_token && tokens.refresh_token);

  const s = await connect('claude-ai', tokens.access_token);
  assert.match(await s.text('navigate', { url: b.base }), /Fixture page/);

  // Using a refresh token gives a new pair. The old one keeps working for a
  // couple of minutes, for a client whose reply got lost.
  const refresh = (token) => fetch(relay.url + '/token', {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token, client_id: registered.client_id }),
  });
  const renewed = await refresh(tokens.refresh_token);
  assert.equal(renewed.status, 200);
  assert.notEqual((await renewed.json()).refresh_token, tokens.refresh_token);
  assert.equal((await refresh(tokens.refresh_token)).status, 200);
  assert.equal((await refresh('made-up')).status, 400);

  // A session belongs to whoever opened it: the key cannot drive the connector's session.
  const res = await fetch(relay.url + '/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${relay.key}`, 'mcp-session-id': s.transport.sessionId,
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }),
  });
  assert.equal(res.status, 404);
  await s.transport.terminateSession();
});

test("a session's tabs cannot open the relay itself", async () => {
  const s = await connect();
  const page = await s.text('navigate', { url: relay.url + '/healthz' });
  assert.doesNotMatch(page, /"ok":true/);
  assert.match(await s.text('evaluate', { code: 'fetch(' + JSON.stringify(relay.url + '/healthz') + ').then(() => "reached", () => "blocked")' }), /blocked/);
  await s.transport.terminateSession();
});
