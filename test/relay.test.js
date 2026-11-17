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
const { spawn } = require('child_process');
const { socketFor } = require('../src/shared/paths');

let relay, b, home;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (check, what, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await check()) return;
  assert.fail(`timed out waiting for ${what}`);
};

// A Claude session: an MCP client signed in with a bearer token.
async function connect(name = 'claude-code', token = relay.key, again = true, r = relay) {
  const transport = new StreamableHTTPClientTransport(new URL(r.url + '/mcp'), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name, version: '1.0.0' });
  try {
    await client.connect(transport);
  } catch (e) {
    // After a long gap, fetch can pick a kept-alive connection the relay has
    // since closed; nothing was sent, so once more.
    if (again && /fetch failed/.test(String(e?.message))) return connect(name, token, false, r);
    throw e;
  }
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
  try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {} // helper processes may still be closing files
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

// A stand-in for a browser, signed in. options: as ws takes them.
function device(r, id, options) {
  const ws = new WebSocket(r.url.replace('http', 'ws') + '/device', options);
  ws.on('error', () => {});
  ws.on('open', () => ws.send(JSON.stringify({ hello: { key: r.key, device: { id, name: id } } })));
  return ws;
}

test('a message that is not what the relay expects closes that connection, and the relay carries on', async () => {
  // Before signing in, and after.
  for (const bad of ['null', '7', '"hello"', 'not json', '{"hello":null}', '{"hello":{"key":7,"device":null}}']) {
    const ws = new WebSocket(relay.url.replace('http', 'ws') + '/device');
    await new Promise((resolve) => {
      ws.on('open', () => ws.send(bad));
      ws.on('close', resolve);
    });
  }
  const ws = device(relay, 'odd');
  await until(() => relay.devices.has('odd'), 'the stand-in to sign in');
  ws.send('null');
  await until(() => !relay.devices.has('odd'), 'the stand-in to be dropped');
  assert.equal((await fetch(relay.url + '/healthz')).status, 200);
});

test('a web page cannot open the browsers\' connection', async () => {
  const ws = new WebSocket(relay.url.replace('http', 'ws') + '/device', { origin: 'http://localhost:8000' });
  const outcome = await new Promise((resolve) => {
    ws.on('open', () => resolve('opened'));
    ws.on('error', () => resolve('refused'));
  });
  ws.terminate();
  assert.equal(outcome, 'refused');
});

test('a browser that stops answering pings is taken offline', async () => {
  const r = await start({ port: 0, home: fs.mkdtempSync(path.join(os.tmpdir(), 'loui-relay-test-')), pingMs: 150 });
  try {
    const well = device(r, 'well');
    const gone = device(r, 'gone', { autoPong: false }); // as if its network had gone
    await until(() => r.devices.size === 2, 'both to sign in');
    await until(() => !r.devices.has('gone'), 'the silent one to be dropped', 3000);
    await sleep(400);
    assert.ok(r.devices.has('well'), 'one that answers stays');
    // What Loui sends to hear that the relay is there.
    const pong = new Promise((resolve) => well.on('message', (data) => resolve(JSON.parse(data))));
    well.send(JSON.stringify({ ping: 1 }));
    assert.deepEqual(await pong, { pong: 1 });
    well.terminate();
  } finally {
    await r.close();
    fs.rmSync(r.home, { recursive: true, force: true });
  }
});

test('one sign-in can hold only so many sessions', async () => {
  const r = await start({ port: 0, home: fs.mkdtempSync(path.join(os.tmpdir(), 'loui-relay-test-')), maxSessions: 3 });
  const initialize = () => fetch(r.url + '/mcp', {
    method: 'POST',
    headers: { authorization: `Bearer ${r.key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'claude-code', version: '1' } },
    }),
  });
  try {
    const all = await Promise.all(Array.from({ length: 12 }, initialize)); // at once, as a flood would be
    assert.equal(all.filter((res) => res.status === 200).length, 3);
    const refused = all.find((res) => res.status !== 200);
    assert.equal(refused.status, 429);
    assert.match((await refused.json()).error.message, /already has 3 sessions open/);
    assert.equal(r.sessions.size, 3);
    // Ending one makes room for another.
    const id = all.find((res) => res.status === 200).headers.get('mcp-session-id');
    await fetch(r.url + '/mcp', { method: 'DELETE', headers: { authorization: `Bearer ${r.key}`, 'mcp-session-id': id } });
    assert.equal((await initialize()).status, 200);
  } finally {
    await r.close();
    fs.rmSync(r.home, { recursive: true, force: true });
  }
});

test('at the cap, the idlest session nobody is using makes room; the key may hold more than twenty', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loui-relay-test-'));
  const r = await start({ port: 0, home: dir, maxSessions: 3, spareMs: 300 });
  const headers = { authorization: `Bearer ${r.key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const initialize = (at = r) => fetch(at.url + '/mcp', {
    method: 'POST', headers: { ...headers, authorization: `Bearer ${at.key}` },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'claude-code', version: '1' } },
    }),
  });
  const stream = new AbortController();
  let many;
  try {
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const res = await initialize();
      assert.equal(res.status, 200);
      ids.push(res.headers.get('mcp-session-id'));
      await new Promise((ok) => setTimeout(ok, 30));
    }
    // All three were heard from a moment ago: none is spared for a fourth.
    assert.equal((await initialize()).status, 429);
    // The first holds its event stream open; the second is then the idlest without one.
    fetch(r.url + '/mcp', { headers: { ...headers, 'mcp-session-id': ids[0] }, signal: stream.signal }).catch(() => {});
    for (let i = 0; i < 50 && !r.sessions.get(ids[0]).streams; i++) await new Promise((ok) => setTimeout(ok, 20));
    assert.equal(r.sessions.get(ids[0]).streams, 1);
    await new Promise((ok) => setTimeout(ok, 400));
    const fourth = await initialize();
    assert.equal(fourth.status, 200, 'room was made');
    assert.equal(r.sessions.size, 3);
    assert.ok(r.sessions.has(ids[0]), 'the one with a stream open stays');
    assert.ok(!r.sessions.has(ids[1]), 'the idlest one without a stream was ended');
    assert.ok(r.sessions.has(ids[2]));

    // By default the relay key, which every Claude Code session shares, may hold more than twenty.
    many = await start({ port: 0, home: fs.mkdtempSync(path.join(os.tmpdir(), 'loui-relay-test-')) });
    const all = await Promise.all(Array.from({ length: 24 }, () => initialize(many)));
    assert.equal(all.filter((res) => res.status === 200).length, 24);
  } finally {
    stream.abort();
    await r.close();
    fs.rmSync(dir, { recursive: true, force: true });
    if (many) { await many.close(); fs.rmSync(many.home, { recursive: true, force: true }); }
  }
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

// The browser asks the user before a new session first uses it (consent.js).
const question = async () => {
  await until(async () => (await b.state()).prompt?.kind === 'consent', 'the browser to ask the user');
  return (await b.state()).prompt;
};
let keyConnector;

test('a new session waits for the user, who can always allow sessions signed in with the key', async () => {
  const s = await connect('claude-code');
  const call = s.text('navigate', { url: b.base });
  const p = await question();
  assert.equal(p.who, 'Claude Code');
  assert.equal(p.connector.kind, 'key');
  assert.match(p.connector.id, /^[\w-]{22}$/);
  assert.ok(!p.connector.id.includes('owner') && !JSON.stringify(p).includes(relay.key), 'nothing secret reaches the browser');
  keyConnector = p.connector.id;
  assert.equal((await groups()).length, 0, 'no group until the user answers');
  await b.ui('prompt:answer', { id: p.id, value: 'always' });
  assert.match(await call, /Fixture page/);
  await s.transport.terminateSession();
  await until(async () => (await groups()).length === 0, 'the group to close');

  // The next session with the key is the same connector, so it is let straight in.
  const again = await connect('claude-code');
  assert.match(await again.text('navigate', { url: b.base }), /Fixture page/);
  assert.equal((await b.state()).prompt, null);
  await again.transport.terminateSession();
  await until(async () => (await groups()).length === 0, 'the group to close');
});

test('a session the user denies is told so, and gets no group', async () => {
  await b.ui('consent:revoke', keyConnector);
  const s = await connect('claude-code');
  const call = s.text('navigate', { url: b.base });
  await b.ui('prompt:answer', { id: (await question()).id, value: 'deny' });
  await assert.rejects(call, /did not allow this session/);
  assert.equal((await groups()).length, 0);
  await s.transport.terminateSession();
  // Back as it was for the tests that follow.
  const t = await connect('claude-code');
  const next = t.text('navigate', { url: b.base });
  await b.ui('prompt:answer', { id: (await question()).id, value: 'always' });
  await next;
  await t.transport.terminateSession();
  await until(async () => (await groups()).length === 0, 'the group to close');
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

const register = (redirect, r = relay) => fetch(r.url + '/register', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ client_name: 'Claude', redirect_uris: [redirect], token_endpoint_auth_method: 'none' }),
});

// Registers a client and starts a sign-in; returns what the approval step needs.
// client: one already registered, to sign in again.
async function startSignIn(redirect, r = relay, client) {
  const registered = client || await (await register(redirect, r)).json();
  assert.ok(registered.client_id);
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const authorize = new URL(r.url + '/authorize');
  authorize.search = new URLSearchParams({
    response_type: 'code', client_id: registered.client_id, redirect_uri: redirect,
    code_challenge: challenge, code_challenge_method: 'S256', state: 'abc',
  });
  const toApproval = await fetch(authorize, { redirect: 'manual' });
  assert.equal(toApproval.status, 302);
  const approvePage = new URL(toApproval.headers.get('location'), r.url);
  if (approvePage.searchParams.get('error')) return { registered, refused: approvePage.searchParams.get('error') };
  const answer = (key) => fetch(r.url + '/approve', {
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
  // The right host is not enough: https, or plain http on this machine only.
  for (const uri of ['http://claude.ai/api/mcp/auth_callback', 'someapp://claude.ai/callback', 'someapp://localhost/callback']) {
    const res = await register(uri);
    assert.equal(res.status, 400, uri);
    assert.match((await res.json()).error_description, /only sends sign-ins to https/);
  }
  assert.equal((await register('https://claude.ai/api/mcp/auth_callback')).status, 201);
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

  // A connector is asked about on its own, not let in by the key's "always allow".
  const s = await connect('claude-ai', tokens.access_token);
  const call = s.text('navigate', { url: b.base });
  const p = await question();
  assert.deepEqual({ kind: p.connector.kind, name: p.connector.name }, { kind: 'connector', name: 'Claude' });
  assert.notEqual(p.connector.id, keyConnector);
  assert.ok(!p.connector.id.includes(registered.client_id), 'the client id stays with the relay');
  await b.ui('prompt:answer', { id: p.id, value: 'allow' });
  assert.match(await call, /Fixture page/);

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

// A relay with small limits and a short grace period, and a connector signed in to it.
async function small(limits) {
  const r = await start({ port: 0, home: fs.mkdtempSync(path.join(os.tmpdir(), 'loui-relay-test-')), auth: limits });
  const stop = async () => { await r.close(); fs.rmSync(r.home, { recursive: true, force: true }); };
  return { r, stop };
}
const redirect = 'https://claude.ai/api/mcp/auth_callback';
async function signIn(r) {
  const { registered, verifier, answer } = await startSignIn(redirect, r);
  const back = new URL((await answer(r.key)).headers.get('location'));
  const tokens = await (await fetch(r.url + '/token', {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code', code: back.searchParams.get('code'), code_verifier: verifier,
      client_id: registered.client_id, redirect_uri: redirect,
    }),
  })).json();
  const refresh = (token) => fetch(r.url + '/token', {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token, client_id: registered.client_id }),
  });
  const works = async (token) => (await fetch(r.url + '/mcp', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })).status !== 401;
  return { tokens, refresh, works };
}

test('refreshes at the same moment get the same new tokens, not one set each', async () => {
  const { r, stop } = await small({ refreshGraceMs: 400 });
  try {
    const { tokens, refresh, works } = await signIn(r);
    const three = await Promise.all([1, 2, 3].map(async () => (await refresh(tokens.refresh_token)).json()));
    assert.ok(three[0].refresh_token && three[0].refresh_token !== tokens.refresh_token);
    assert.deepEqual(three.map((t) => t.refresh_token), Array(3).fill(three[0].refresh_token));
    assert.deepEqual(three.map((t) => t.access_token), Array(3).fill(three[0].access_token));
    const stored = JSON.parse(fs.readFileSync(path.join(r.home, 'oauth.json'), 'utf8')).refresh;
    assert.equal(Object.values(stored).filter((x) => !x.retiredAt).length, 1, 'one refresh token in use');

    // A replaced token that turns up after the grace period was copied by
    // someone: every token from that approval stops working.
    assert.ok(await works(three[0].access_token));
    await sleep(500);
    assert.equal((await refresh(tokens.refresh_token)).status, 400);
    assert.equal((await refresh(three[0].refresh_token)).status, 400, 'the newest one is withdrawn too');
    assert.equal(await works(three[0].access_token), false);
    assert.equal(await works(tokens.access_token), false);

    // Another approval of the same relay is not touched by it.
    const other = await signIn(r);
    assert.equal((await other.refresh(other.tokens.refresh_token)).status, 200);
  } finally {
    await stop();
  }
});

test("other sign-ins cannot push out an approval the owner is in the middle of", async () => {
  const { r, stop } = await small({ maxApprovals: 3, maxClients: 5 });
  try {
    const owner = await startSignIn(redirect, r);
    const crowd = [];
    for (let i = 0; i < 4; i++) crowd.push(await startSignIn(redirect, r));
    assert.deepEqual(crowd.map((c) => c.refused), [undefined, undefined, 'temporarily_unavailable', 'temporarily_unavailable']);
    // Nor can registrations push out one made a moment ago.
    assert.equal((await register(redirect, r)).status, 400);

    // A client asking again replaces its own request rather than adding one.
    const again = await startSignIn(redirect, r, crowd[0].registered);
    assert.equal(again.refused, undefined);
    assert.equal((await crowd[0].answer(r.key)).status, 400, 'its first request is gone');

    assert.equal((await owner.answer(r.key)).status, 302, 'the owner\'s approval is still there');
  } finally {
    await stop();
  }
});

test('Loui dials again when a relay it is connected to goes silent', async () => {
  // A relay that welcomes the browser, answers its first ping, and then says nothing more.
  const silent = new WebSocket.Server({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => silent.on('listening', resolve));
  let dials = 0;
  silent.on('connection', (ws) => {
    dials++;
    let pings = 0;
    ws.on('message', (data) => {
      const msg = JSON.parse(data);
      if (msg.hello) ws.send(JSON.stringify({ welcome: true, sessions: [], relay: [] }));
      if (msg.ping && !pings++) ws.send(JSON.stringify({ pong: msg.ping }));
    });
  });
  const other = await launch({ LOUI_RELAY_URL: `http://127.0.0.1:${silent.address().port}`, LOUI_RELAY_KEY: 'k', LOUI_LINK_QUIET_MS: '900' });
  try {
    await until(async () => (await other.state()).link.status === 'connected', 'the browser to connect');
    await until(() => dials >= 2, 'the browser to dial again', 6000);
  } finally {
    await other.close();
    for (const ws of silent.clients) ws.terminate();
    silent.close();
  }
});

test('the local control socket is only served to the tests, or when a setting turns it on', async () => {
  // Loui as it runs day to day (no LOUI_TEST). It dials the relay right after
  // the point where it would open the socket, so a stand-in relay hears when.
  const standIn = new WebSocket.Server({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => standIn.on('listening', resolve));
  let dialled = 0;
  standIn.on('connection', () => dialled++);
  const run = async (settings) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loui-test-'));
    if (settings) fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings));
    const before = dialled;
    const app = spawn(require('electron'), [path.join(__dirname, '..'), '--no-sandbox'], {
      env: {
        ...process.env, LOUI_HOME: dir, LOUI_TEST: '', LOUI_RELAY_URL: `http://127.0.0.1:${standIn.address().port}`, LOUI_RELAY_KEY: 'k',
        LOUI_SHIELDS_LISTS: 'http://127.0.0.1:1/none', // nothing to download
      },
      stdio: 'ignore',
    });
    try {
      await until(() => dialled > before, 'Loui to start', 20000);
      await sleep(300);
      return fs.existsSync(socketFor(dir));
    } finally {
      const exited = new Promise((resolve) => app.once('exit', resolve));
      app.kill('SIGKILL');
      await exited;
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {}
    }
  };
  try {
    assert.equal(await run(null), false, 'no socket in a normal run');
    assert.equal(await run({ localSocket: true }), true, 'served when the setting is on');
  } finally {
    for (const ws of standIn.clients) ws.terminate();
    standIn.close();
  }
});

test("a session's tabs cannot open the relay itself", async () => {
  const s = await connect();
  const page = await s.text('navigate', { url: relay.url + '/healthz' });
  assert.doesNotMatch(page, /"ok":true/);
  assert.match(await s.text('evaluate', { code: 'fetch(' + JSON.stringify(relay.url + '/healthz') + ').then(() => "reached", () => "blocked")' }), /blocked/);
  await s.transport.terminateSession();
});

// ── several devices: remembered, named, started ─────────────────────────────
// A stand-in browser with a name of its own. It answers every tool call with its name.
function named(r, id, name, more = {}) {
  const ws = new WebSocket(r.url.replace('http', 'ws') + '/device');
  ws.on('error', () => {});
  ws.on('open', () => ws.send(JSON.stringify({ hello: { key: r.key, device: { id, name, platform: 'test', version: '1', ...more } } })));
  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    if (msg.tool) ws.send(JSON.stringify({ id: msg.id, content: [{ type: 'text', text: `from ${name}` }] }));
  });
  return ws;
}
// The same as a program: what a launch command runs. It leaves a file behind each time it starts.
const STAND_IN = `
const fs = require('fs');
const path = require('path');
const [ws, url, key, id, name] = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, 'started-' + id), 'x');
const sock = new (require(ws))(url.replace('http', 'ws') + '/device');
sock.on('error', () => process.exit(0));
sock.on('close', () => process.exit(0));
sock.on('open', () => sock.send(JSON.stringify({ hello: { key, device: { id, name, platform: 'test', version: '1' } } })));
sock.on('message', (data) => {
  const msg = JSON.parse(data);
  if (msg.tool) sock.send(JSON.stringify({ id: msg.id, content: [{ type: 'text', text: 'from ' + name }] }));
});
setTimeout(() => process.exit(0), 60000);
`;
// A relay home with the stand-in program in it, and the command that runs it as a device.
function launchHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loui-relay-test-'));
  fs.writeFileSync(path.join(dir, 'stand-in.js'), STAND_IN);
  const command = (r, id, name) => [process.execPath, path.join(dir, 'stand-in.js'), require.resolve('ws'), r.url, r.key, id, name]
    .map((a) => `'${a}'`).join(' ');
  const started = (id) => { try { return fs.readFileSync(path.join(dir, 'started-' + id), 'utf8').length; } catch { return 0; } };
  return { dir, command, started };
}
const remembered = (r) => JSON.parse(fs.readFileSync(path.join(r.home, 'devices.json'), 'utf8'));
const deviceOf = (r) => [...r.sessions.values()].map((x) => x.deviceName);

test('devices lists browsers online and offline, and a session moves by name or the start of one', async () => {
  const { dir } = launchHome();
  let r = await start({ port: 0, home: dir });
  try {
    const mac = named(r, 'k1', 'Kitchen Mac');
    await until(() => r.devices.has('k1'), 'the first to sign in');
    const kite = named(r, 'k2', 'Kit');
    await until(() => r.devices.has('k2'), 'the second to sign in');
    const s = await connect('claude-code', r.key, true, r);
    const list = await s.text('devices');
    assert.match(list, /^ {2}Kitchen Mac {2}\(test\) {2}online$/m);
    assert.match(list, /^ {2}Kit {2}\(test\) {2}online$/m);
    // Before its first tool call, the session says where it wants to be.
    assert.match(await s.text('devices', { name: 'kit' }), /^> Kit /m, 'the whole name wins over a longer one it begins');
    assert.equal(await s.text('snapshot'), 'from Kit');
    assert.match(await s.text('devices', { action: 'use', name: 'KITC' }), /^> Kitchen Mac /m);
    assert.equal(await s.text('snapshot'), 'from Kitchen Mac');
    await assert.rejects(s.text('devices', { name: 'ki' }), /"ki" could be "Kitchen Mac" or "Kit"\. Say which\./);
    await assert.rejects(s.text('devices', { name: 'pantry' }), /knows no Loui browser called "pantry"/);
    await assert.rejects(s.text('devices', { action: 'use' }), /Say which device/);
    assert.deepEqual(deviceOf(r), ['Kitchen Mac'], 'a name that finds nothing moves nothing');

    // One goes offline: still listed, with when it was last seen, and not startable.
    kite.terminate();
    await until(() => !r.devices.has('k2'), 'it to go offline');
    assert.match(await s.text('devices'), /^ {2}Kit {2}\(test\) {2}offline, last seen \d{4}-\d\d-\d\d \d\d:\d\d UTC \(just now\); the relay cannot start it/m);
    await assert.rejects(s.text('devices', { name: 'Kit', start: true }),
      /Loui on Kit is offline, and the relay cannot start it.*Ask the user to open Loui on Kit.*Open Loui when I sign in/s);
    assert.deepEqual(deviceOf(r), ['Kitchen Mac']);
    await s.transport.terminateSession();

    // The list outlives the relay.
    mac.terminate();
    await r.close();
    r = await start({ port: 0, home: dir });
    const again = await connect('claude-code', r.key, true, r);
    const after = await again.text('devices');
    assert.match(after, /^ {2}Kitchen Mac {2}\(test\) {2}offline, last seen /m);
    assert.match(after, /^ {2}Kit {2}\(test\) {2}offline, last seen /m);
    await assert.rejects(again.text('snapshot'), /No Loui browser is online/);
    // Back under the same id with another name: one entry, the new name.
    const renamed = named(r, 'k2', 'Glider');
    await until(() => r.devices.has('k2'), 'it to sign in again');
    const now = await again.text('devices');
    assert.match(now, /^ {2}Glider {2}\(test\) {2}online$/m);
    assert.doesNotMatch(now, /^ {2}Kit {2}/m);
    assert.deepEqual(remembered(r).map((d) => d.name).sort(), ['Glider', 'Kitchen Mac']);
    renamed.terminate();
    await again.transport.terminateSession();
  } finally {
    await r.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a session can ask for a device that is closed, and the relay starts the ones it has a command for', async () => {
  const { dir, command, started } = launchHome();
  const r = await start({ port: 0, home: dir, startMs: 15000 });
  // The relay's own configuration: a file in its home.
  fs.writeFileSync(path.join(dir, 'launch.json'), JSON.stringify({ Garage: command(r, 'g1', 'Garage') }));
  try {
    const s = await connect('claude-code', r.key, true, r);
    assert.match(await s.text('devices'), /^ {2}Garage {2}offline, never seen by this relay; the relay can start it \(start: true\)$/m);
    await assert.rejects(s.text('devices', { name: 'gar' }), /Loui on Garage is offline\. The relay can start it: call devices with name "Garage" and start: true\./);
    assert.equal(started('g1'), 0, 'naming it does not start it');
    // The first thing the session does: say where, and have it opened.
    assert.match(await s.text('devices', { name: 'garage', start: true }), /^> Garage {2}\(test\) {2}online; the relay can start it if it closes$/m);
    assert.equal(started('g1'), 1);
    assert.equal(await s.text('snapshot'), 'from Garage');
    // Already open: nothing is run again.
    const other = await connect('claude-code', r.key, true, r);
    assert.match(await other.text('devices', { name: 'Garage', start: true }), /^> Garage /m);
    assert.equal(started('g1'), 1);

    // A command that brings up nothing of that name: said plainly, after the wait.
    fs.writeFileSync(path.join(dir, 'launch.json'), JSON.stringify({ Garage: command(r, 'g1', 'Garage'), Attic: 'true' }));
    const quick = await start({ port: 0, home: dir, startMs: 600 });
    try {
      const q = await connect('claude-code', quick.key, true, quick);
      await assert.rejects(q.text('devices', { name: 'Attic', start: true }), /ran its command for Attic, but Loui there did not come online within 1 seconds\. Ask the user to open Loui on Attic/);
      await q.transport.terminateSession();
    } finally {
      await quick.close();
    }
    await s.transport.terminateSession();
    await other.transport.terminateSession();
  } finally {
    await r.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('LOUI_LAUNCH_<NAME> names a device in any case, and plain LOUI_LAUNCH still opens a browser when none is online', async () => {
  const { dir, command, started } = launchHome();
  const port = await new Promise((resolve) => {
    const probe = require('net').createServer().listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); });
  });
  const at = { url: `http://127.0.0.1:${port}`, key: 'k'.repeat(40) };
  fs.writeFileSync(path.join(dir, 'key'), at.key, { mode: 0o600 });
  // As the environment gives them: the name in capitals, and a default for any.
  const r = await start({ port, home: dir, startMs: 15000, launch: command(at, 'a1', 'Anywhere'), launchers: { SHED: command(at, 's1', 'Shed') } });
  try {
    assert.equal(r.key, at.key);
    const s = await connect('claude-code', r.key, true, r);
    assert.equal(await s.text('snapshot'), 'from Anywhere', 'a session that names no device gets the default started');
    assert.equal(started('a1'), 1);
    assert.match(await s.text('devices'), /^ {2}SHED {2}offline, never seen by this relay; the relay can start it/m);
    assert.match(await s.text('devices', { name: 'shed', start: true }), /^> Shed {2}\(test\) {2}online/m);
    assert.equal(await s.text('snapshot'), 'from Shed');
    // The default is for "any", never for a device by name.
    assert.match(await s.text('devices'), /^ {2}Anywhere {2}\(test\) {2}online$/m);
    await s.transport.terminateSession();
  } finally {
    await r.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('a launch command comes only from the relay\'s own configuration: no tool argument or browser can give one', async () => {
  const { dir, command, started } = launchHome();
  const mark = path.join(dir, 'ran');
  const touch = `touch '${mark}'`;
  const r = await start({ port: 0, home: dir, startMs: 600 });
  fs.writeFileSync(path.join(dir, 'launch.json'), JSON.stringify({ Garage: command(r, 'g1', 'Garage') }));
  try {
    // A browser that says how to start itself is not believed.
    const loud = named(r, 'p1', 'Porch', { launch: touch, command: touch, start: touch });
    await until(() => r.devices.has('p1'), 'it to sign in');
    assert.deepEqual(Object.keys(remembered(r)[0]).sort(), ['id', 'name', 'platform', 'seen', 'version']);
    loud.terminate();
    await until(() => !r.devices.has('p1'), 'it to go offline');
    const s = await connect('claude-code', r.key, true, r);
    const tries = [
      { name: 'Porch', start: true, command: touch, launch: touch },
      { name: 'Porch', start: touch },
      { name: `Porch; ${touch}`, start: true },
      { name: `$(${touch})`, start: true },
      { name: touch, start: true },
      { name: '*', start: true },
      // A device the relay can start, with a command of the caller's beside it.
      { name: 'Garage', command: touch, launch: touch },
    ];
    for (const args of tries) {
      const said = await s.text('devices', args).catch((e) => e.message);
      assert.doesNotMatch(said, /^> /m, `${JSON.stringify(args)} moved the session`);
    }
    await sleep(500);
    assert.ok(!fs.existsSync(mark), 'nothing of the caller\'s was run');
    assert.equal(started('g1'), 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'launch.json'), 'utf8')), { Garage: command(r, 'g1', 'Garage') });
    await s.transport.terminateSession();
  } finally {
    await r.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('what a browser calls itself is kept short and on one line, and only so many are remembered', async () => {
  const { dir } = launchHome();
  const r = await start({ port: 0, home: dir });
  try {
    const odd = named(r, 'odd', `  Den\n> Forged  (test)  online\u0000\u001b[31m\u2028${'x'.repeat(300)}`, { platform: 'p'.repeat(300), version: 'v\n'.repeat(300) });
    await until(() => r.devices.has('odd'), 'it to sign in');
    const kept = remembered(r)[0];
    assert.equal(kept.name.length, 64);
    assert.match(kept.name, /^Den> Forged {2}\(test\) {2}online\[31mx+$/);
    assert.equal(kept.platform.length, 20);
    assert.ok(kept.version.length <= 20 && !/\s/.test(kept.version));
    const s = await connect('claude-code', r.key, true, r);
    const list = await s.text('devices');
    assert.equal(list.split('\n').length, 2, 'a heading and one line');
    // A name that is nothing but control characters is "Loui".
    const blank = named(r, 'blank', '\u0000\n\t');
    await until(() => r.devices.has('blank'), 'it to sign in');
    assert.equal(r.devices.get('blank').name, 'Loui');
    odd.terminate();
    blank.terminate();
    await until(() => r.devices.size === 0, 'both to go');
    // Sixty more come and go: fifty are kept, the latest ones.
    for (let i = 0; i < 60; i++) {
      const ws = named(r, `many-${i}`, `Many ${i}`);
      await until(() => r.devices.has(`many-${i}`), 'it to sign in');
      ws.terminate();
      await until(() => !r.devices.has(`many-${i}`), 'it to go');
    }
    const all = remembered(r);
    assert.equal(all.length, 50);
    assert.ok(all.some((d) => d.id === 'many-59') && !all.some((d) => d.id === 'many-9' || d.id === 'odd'));
    await s.transport.terminateSession();
  } finally {
    await r.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
