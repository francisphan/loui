// What Loui tells a site it is (src/main/identity.js): its usual user agent
// leaves out loui/ and Electron/; on the hosts that want the truth (Google's
// sign-in) a tab carries the full one, in the request and in the page alike,
// and the usual one again once it leaves. A local server stands in for those
// hosts: "localhost" is listed, "127.0.0.1" is not.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { launch } = require('./drive');

let b, server, port;
const seen = []; // { host, agent } of each page request
test.before(async () => {
  server = http.createServer((req, res) => {
    if (req.url.startsWith('/page')) seen.push({ host: req.headers.host.split(':')[0], agent: req.headers['user-agent'] });
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>Who</title><p>page</p>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  b = await launch({ LOUI_HONEST_HOSTS: 'localhost' });
});
test.after(async () => { await b?.close(); server.close(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function visit(host, mark) {
  const url = `http://${host}:${port}/page?${mark}`;
  await b.ui('go', url);
  for (const end = Date.now() + 8000; Date.now() < end; await sleep(100)) {
    const t = (await b.state()).tabs.find((x) => x.active);
    if (t.url === url && !t.loading) {
      return { sent: seen.findLast((x) => x.host === host).agent, page: await b.ui('tab:js', { id: t.id, code: 'navigator.userAgent' }) };
    }
  }
  assert.fail(`${url} did not load`);
}

test('the usual user agent names neither Loui nor Electron', async () => {
  const { sent, page } = await visit('127.0.0.1', 'a');
  assert.doesNotMatch(sent, /loui|Electron/i);
  assert.match(sent, /Chrome\/\d+/);
  assert.equal(page, sent, 'the page sees what the request said');
});

test('a host that wants the truth gets the full one, in the request and in the page', async () => {
  const { sent, page } = await visit('localhost', 'b');
  assert.match(sent, /loui\/[\d.]+ Chrome\/[\d.]+ Electron\/[\d.]+/);
  assert.equal(page, sent);
});

test('leaving that host, the tab has its usual user agent again', async () => {
  const { sent, page } = await visit('127.0.0.1', 'c');
  assert.doesNotMatch(sent, /loui|Electron/i);
  assert.equal(page, sent);
});

test('a tab opened straight on such a host has the full one from its first request', async () => {
  const url = `http://localhost:${port}/page?d`;
  const before = seen.length;
  await b.ui('tab:new', url);
  for (const end = Date.now() + 8000; Date.now() < end && seen.length === before; await sleep(100));
  assert.match(seen[seen.length - 1].agent, /Electron\//);
});

test("a Claude session's tab does the same", async () => {
  const s = b.as('id', 'Claude Code');
  await s.text('navigate', { url: `http://localhost:${port}/page?e` });
  assert.match(seen[seen.length - 1].agent, /Electron\//);
  assert.match(await s.text('evaluate', { code: 'navigator.userAgent' }), /Electron\//);
  s.end();
});
