// Downloads: files land in the downloads folder without a dialog, never over
// an existing file, and show in the window's downloads list with their
// progress. The folder is a throwaway one (LOUI_DOWNLOADS), never ~/Downloads.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { launch } = require('./drive');

const SLOW_SIZE = 256 * 1024;
let b, server, files, home, url;
let served = 0;
const held = []; // responses of slow downloads, waiting for release()

// /file/<name>: a small attachment whose body says which request it was.
// /slow/<name>: sends its first part, then waits until release() is called.
function serveFiles() {
  server = http.createServer((req, res) => {
    const [, kind, name] = req.url.split('/');
    const headers = { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${name}"` };
    if (kind === 'file') {
      const body = `request ${++served}`;
      res.writeHead(200, { ...headers, 'content-length': body.length }).end(body);
    } else if (kind === 'slow') {
      res.writeHead(200, { ...headers, 'content-length': SLOW_SIZE });
      res.write(Buffer.alloc(64 * 1024, 1));
      held.push(res);
    } else {
      res.writeHead(404).end();
    }
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)));
}
const release = () => { for (const res of held.splice(0)) res.end(Buffer.alloc(SLOW_SIZE - 64 * 1024, 2)); };

const listed = async () => (await b.state()).downloads.items;
// The newest download with this name, once it matches the check.
async function waitFor(name, check, what) {
  for (let i = 0; i < 100; i++) {
    const d = (await listed()).find((x) => x.name === name);
    if (d && check(d)) return d;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`${name} never ${what}: ${JSON.stringify(await listed())}`);
}
const finished = (name) => waitFor(name, (d) => d.state === 'completed', 'finished');

test.before(async () => {
  url = await serveFiles();
  files = fs.mkdtempSync(path.join(os.tmpdir(), 'loui-downloads-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'loui-test-'));
  b = await launch({ LOUI_DOWNLOADS: files }, { home });
});
test.after(async () => {
  release();
  await b?.close();
  server.close();
  fs.rmSync(files, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test('a download is saved to the downloads folder without asking, and listed', async () => {
  await b.ui('go', `${url}/file/report.pdf`);
  const d = await finished('report.pdf');
  assert.equal(fs.readFileSync(path.join(files, 'report.pdf'), 'utf8'), 'request 1');
  assert.equal(d.by, null, 'started in the user\'s own tab');
  assert.equal(d.received, 'request 1'.length);
});

test('a second file with the same name gets a number instead of replacing the first', async () => {
  await b.ui('go', `${url}/file/report.pdf`);
  await finished('report (1).pdf');
  assert.equal(fs.readFileSync(path.join(files, 'report.pdf'), 'utf8'), 'request 1');
  assert.equal(fs.readFileSync(path.join(files, 'report (1).pdf'), 'utf8'), 'request 2');
});

test('a running download shows its progress, pauses, resumes and finishes', async () => {
  await b.ui('go', `${url}/slow/big.bin`);
  const running = await waitFor('big.bin', (d) => d.received > 0, 'made progress');
  assert.equal(running.state, 'progressing');
  assert.equal(running.total, SLOW_SIZE);
  assert.ok(running.received < SLOW_SIZE);
  assert.ok(running.live);

  await b.ui('download:act', { id: running.id, action: 'pause' });
  await waitFor('big.bin', (d) => d.state === 'paused', 'paused');
  await b.ui('download:act', { id: running.id, action: 'resume' });
  await waitFor('big.bin', (d) => d.state === 'progressing', 'resumed');
  release();
  await finished('big.bin');
  assert.equal(fs.statSync(path.join(files, 'big.bin')).size, SLOW_SIZE);
});

test('cancelling a download stops it and leaves no file', async () => {
  await b.ui('go', `${url}/slow/stopped.bin`);
  const d = await waitFor('stopped.bin', (x) => x.received > 0, 'made progress');
  await b.ui('download:act', { id: d.id, action: 'cancel' });
  await waitFor('stopped.bin', (x) => x.state === 'cancelled', 'was cancelled');
  // The partial file is deleted just after the download reports it was cancelled.
  for (let i = 0; i < 30 && fs.existsSync(path.join(files, 'stopped.bin')); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(!fs.existsSync(path.join(files, 'stopped.bin')));
  release();
});

test('a download from a Claude session\'s tab is saved too, marked with the session', async () => {
  const s = b.as('dl', 'Claude Code · demo');
  await s.call('navigate', { url: `${url}/file/data.csv` }).catch(() => {});
  const d = await finished('data.csv');
  assert.equal(d.by, 'Claude Code · demo');
  assert.ok(fs.existsSync(path.join(files, 'data.csv')));
  s.end();
});

test('finished downloads can be cleared from the list, and the files stay', async () => {
  const before = await listed();
  assert.ok(before.length >= 4);
  await b.ui('download:clear');
  assert.deepEqual(await listed(), []);
  assert.ok(fs.existsSync(path.join(files, 'report.pdf')));
});

test('the list and the "ask where to save" choice survive a restart', async () => {
  await b.ui('go', `${url}/file/kept.txt`);
  await finished('kept.txt');
  await b.ui('download:ask', true);
  await b.close();
  fs.rmSync(path.join(home, 'loui.sock'), { force: true }); // left by the app it stopped
  b = await launch({ LOUI_DOWNLOADS: files }, { home });
  const { downloads } = await b.state();
  assert.equal(downloads.ask, true);
  assert.deepEqual(downloads.items.map((d) => [d.name, d.state]), [['kept.txt', 'completed']]);
});
