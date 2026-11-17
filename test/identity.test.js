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
    const host = req.headers.host.split(':')[0];
    if (req.url.startsWith('/page') || req.url.startsWith('/sub')) seen.push({ host, path: req.url, agent: req.headers['user-agent'] });
    // /to-other: a redirect to the same page on the other host, as a sign-in link makes.
    if (req.url.startsWith('/to-other')) {
      const other = host === 'localhost' ? '127.0.0.1' : 'localhost';
      res.writeHead(302, { location: `http://${other}:${port}/page?${req.url.split('?')[1]}` });
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>Who</title><p>page</p><script>fetch("/sub?" + location.search.slice(1))</script>');
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

// Arrives at `host` through a redirect from the other one.
async function redirected(host, mark) {
  const from = host === 'localhost' ? '127.0.0.1' : 'localhost';
  const url = `http://${host}:${port}/page?${mark}`;
  await b.ui('go', `http://${from}:${port}/to-other?${mark}`);
  for (const end = Date.now() + 8000; Date.now() < end; await sleep(100)) {
    const t = (await b.state()).tabs.find((x) => x.active);
    const sub = seen.find((x) => x.path === `/sub?${mark}`);
    if (t.url === url && !t.loading && sub) {
      return {
        sent: seen.find((x) => x.path === `/page?${mark}`).agent, sub: sub.agent,
        page: await b.ui('tab:js', { id: t.id, code: 'navigator.userAgent' }),
      };
    }
  }
  assert.fail(`${url} did not load`);
}

test('reached through a redirect, such a host gets the full one throughout', async () => {
  const { sent, sub, page } = await redirected('localhost', 'r1');
  assert.match(sent, /Electron\//);
  assert.equal(page, sent, 'the page reads what the request said');
  assert.equal(sub, sent, 'and so do the page\'s own requests');
});

test('left through a redirect, the next site gets the usual one throughout', async () => {
  const { sent, sub, page } = await redirected('127.0.0.1', 'r2');
  assert.doesNotMatch(sent, /loui|Electron/i);
  assert.equal(page, sent);
  assert.equal(sub, sent, 'nothing of the full one leaks to it');
});

test("a Claude session's tab does the same", async () => {
  const s = b.as('id', 'Claude Code');
  await s.text('navigate', { url: `http://localhost:${port}/page?e` });
  assert.match(seen[seen.length - 1].agent, /Electron\//);
  assert.match(await s.text('evaluate', { code: 'navigator.userAgent' }), /Electron\//);
  s.end();
});
