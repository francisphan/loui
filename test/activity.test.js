// Activity log: what each Claude session did, kept after it has gone, in
// activity/ in the profile, for the user alone (src/main/activity.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launch } = require('./drive');
const TOOLS = require('../src/shared/tools');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'loui-activity-'));
const dir = path.join(home, 'activity');
let b;
test.before(async () => { b = await launch({}, { home }); });
test.after(async () => {
  await b?.close();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what, ms = 8000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
    const got = await check();
    if (got) return got;
  }
  assert.fail(`timed out waiting for ${what}`);
}
const list = async () => (await b.ui('activity:list')).items;
const logOf = async (label) => {
  const s = (await list()).find((x) => x.label === label);
  return s && b.ui('activity:get', s.id);
};
const chrome = (code) => b.ui('chrome:eval', code);
const refOf = (outline, pattern) => outline.match(pattern)?.[1];

test("a session's steps are kept with their labels, pages and pictures", async () => {
  const s = b.as('a1', 'Claude Code');
  await s.text('navigate', { url: b.base + '/' });
  const outline = await s.text('snapshot');
  await s.text('click', { ref: refOf(outline, /button "Count" \[(e\d+)\]/) });
  // A picture is taken after the call returns.
  const log = await until(async () => {
    const l = await logOf('Claude Code');
    return l?.steps.filter((x) => x.thumb).length >= 2 && l;
  }, 'pictures of the acting steps');
  const labels = log.steps.map((x) => x.label);
  assert.deepEqual(labels, ['opening 127.0.0.1:' + new URL(b.base).port, 'reading the page', 'clicking button "Count"']);
  assert.equal(log.steps[0].url, b.base + '/');
  assert.equal(log.steps[0].title, 'Fixture');
  assert.ok(!log.steps[1].thumb, 'reading the page takes no picture');
  assert.match(log.steps[2].thumb, /^data:image\/jpeg;base64,/);
  assert.equal(log.source, 'code');
  assert.equal(log.live, true);
  // On disk: one JSON for the session, its pictures beside it.
  await b.ui('activity:flush');
  const saved = JSON.parse(fs.readFileSync(path.join(dir, `${log.id}.json`), 'utf8'));
  assert.equal(saved.steps.length, 3);
  const pic = fs.readFileSync(path.join(dir, log.id, saved.steps[2].thumb));
  assert.equal(pic[0], 0xff, 'a JPEG');
  assert.ok(pic.length < 60000, `a small picture (${pic.length} bytes)`);

  // A failed step says so.
  await assert.rejects(s.call('click', { ref: 'e9999' }));
  const after = await until(async () => { const l = await logOf('Claude Code'); return l.steps[3]?.ms != null && l; }, 'the failed step');
  assert.match(after.steps[3].error, /no longer on the page/);
});

test('a session that ends is still listed, with how it ended', async () => {
  b.as('a1').end();
  const ended = await until(async () => (await list()).find((x) => x.label === 'Claude Code' && x.ended), 'the session to end');
  assert.equal(ended.ended, 'ended');
  assert.equal(ended.live, false);
  assert.equal(ended.steps, 4);
  assert.equal(ended.failed, 1);
  assert.ok(ended.end >= ended.start);

  // One the user closes from its tab group.
  const s = b.as('a2', 'Claude Desktop');
  await s.text('navigate', { url: b.base + '/second.html' });
  await b.ui('group:close', 'a2');
  const closed = await until(async () => (await list()).find((x) => x.label === 'Claude Desktop' && x.ended), 'the closed session');
  assert.equal(closed.ended, 'closed');
});

test('what is typed into a password field is not kept; other typed text is', async () => {
  const s = b.as('a3', 'Typist');
  const outline = await s.text('navigate', { url: b.base + '/login.html' });
  await s.text('type', { ref: refOf(outline, /textbox "Email" \[(e\d+)\]/), text: 'me@example.com' });
  await s.text('type', { ref: refOf(outline, /textbox "Password" \[(e\d+)\]/), text: 'hunter2-secret' });
  // Guardrails would ask before a script on a page with a password field.
  await b.ui('guard:set', { on: false });
  await s.text('evaluate', { code: 'document.title\n+ " second line kept out"' });
  await b.ui('guard:set', { on: true });
  const log = await until(async () => { const l = await logOf('Typist'); return l?.steps[3]?.ms != null && l; }, 'the steps');
  assert.equal(log.steps[1].detail, 'me@example.com');
  assert.equal(log.steps[2].detail, '(14 characters)');
  assert.equal(log.steps[3].detail, 'document.title', 'only the first line of a script');
  await b.ui('activity:flush');
  const raw = fs.readFileSync(path.join(dir, `${log.id}.json`), 'utf8');
  assert.ok(!raw.includes('hunter2'), 'the password is nowhere in the file');
  assert.ok(!raw.includes('second line'), 'nor the rest of the script');
  s.end();
});

test("a session's tools cannot reach the log", async () => {
  const names = TOOLS.map((t) => t.name);
  assert.ok(!names.some((n) => /activit|sessions/i.test(n)), `no tool reads it: ${names.join(', ')}`);
  const s = b.as('a4', 'Nosy');
  const file = path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith('.json')));
  await assert.rejects(s.call('navigate', { url: `file://${file}` }), /Only http and https/);
  await s.text('navigate', { url: b.base + '/' });
  const got = await s.text('evaluate', { code: `fetch(${JSON.stringify(`file://${file}`)}).then((r) => r.text()).catch(() => 'refused')` });
  assert.match(got, /refused/);
  s.end();
});

test("clicking a step's page in the Sessions panel opens it in a new tab of the user's", async () => {
  await chrome("document.getElementById('activity-open').click()");
  await until(() => chrome("document.querySelectorAll('#activity-list .activity-row').length >= 3"), 'the session list');
  assert.equal(await chrome("document.getElementById('activity').hidden"), false);
  // The newest first; open the first session's timeline.
  await chrome(`[...document.querySelectorAll('#activity-list .activity-row')]
    .find((r) => r.querySelector('.name').textContent === 'Claude Code').querySelector('.open').click()`);
  await until(() => chrome("document.querySelectorAll('.activity-step .page img').length >= 2"), 'the timeline with pictures');
  assert.match(await chrome("document.querySelector('#activity-list .activity-summary').textContent"), /ended/);
  const before = (await b.state()).tabs.length;
  await chrome("document.querySelector('.activity-step .page .link').click()");
  const tab = await until(async () => {
    const tabs = (await b.state()).tabs;
    return tabs.length > before && tabs.find((t) => t.active);
  }, 'a new tab');
  assert.equal(tab.group, 'you');
  await until(async () => (await b.state()).tabs.find((t) => t.active).url === b.base + '/', 'the page to open');
});

test('a session can be deleted, and all of them cleared', async () => {
  const one = (await list()).find((x) => x.label === 'Nosy');
  await b.ui('activity', { do: 'delete', id: one.id });
  await until(async () => !(await list()).some((x) => x.id === one.id), 'the session to go');
  assert.ok(!fs.existsSync(path.join(dir, `${one.id}.json`)));

  // Clear all, from the panel, after confirming.
  await chrome("document.querySelector('#activity-list .activity-summary .quiet').click()"); // back to the list
  await until(() => chrome("!!document.querySelector('#activity-list .activity-row')"), 'the list');
  await chrome("document.getElementById('activity-clear').click()");
  assert.equal(await chrome("document.getElementById('activity-confirm').hidden"), false);
  await chrome("document.getElementById('activity-confirm-yes').click()");
  await until(async () => (await list()).length === 0, 'everything to be cleared');
  await until(() => chrome("document.querySelector('#activity-list .none') !== null"), 'the empty list');
  assert.deepEqual(fs.readdirSync(dir), []);
  await chrome("document.getElementById('activity-close').click()");
});

test('the log survives a restart; a session cut short says so', async () => {
  const done = b.as('r1', 'Finished');
  await done.text('navigate', { url: b.base + '/second.html' });
  done.end();
  await until(async () => (await list()).find((x) => x.label === 'Finished')?.ended, 'the session to end');
  await b.close();
  // A session still working when Loui stopped (closing the test's socket
  // ends its sessions, so its log is written as a crash would leave it).
  const start = Date.now() - 60000;
  fs.writeFileSync(path.join(dir, `${start}-r2.json`), JSON.stringify({
    id: `${start}-r2`, session: 'r2', label: 'Running', source: 'code', start, end: null, ended: null,
    steps: [{ kind: 'tool', at: start + 1000, ms: 500, label: 'reading the page', url: 'http://example.com/' }],
  }));
  b = await launch({}, { home });
  const items = await list();
  const finished = items.find((x) => x.label === 'Finished');
  const cut = items.find((x) => x.label === 'Running');
  assert.equal(finished.ended, 'ended');
  assert.equal(finished.steps, 1);
  assert.match((await b.ui('activity:get', finished.id)).steps[0].url, /\/second\.html$/);
  assert.equal(cut.ended, 'quit', 'cut short when Loui closed');
  assert.equal(cut.end, start + 1500, 'ending at its last step');
});

test('logs older than the setting, and the oldest past the size cap, are pruned', async () => {
  await b.close();
  // Three earlier sessions on disk: one ten days old, two recent with 600 KB
  // of pictures each, under a 1 MB cap.
  const write = (id, start, bytes) => {
    const data = { id, session: id, label: id, source: 'code', start, end: start + 1000, ended: 'ended', steps: [] };
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(data));
    if (bytes) {
      fs.mkdirSync(path.join(dir, id), { recursive: true });
      fs.writeFileSync(path.join(dir, id, '0.jpg'), Buffer.alloc(bytes));
    }
  };
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
  const now = Date.now();
  write('old', now - 10 * 864e5, 0);
  write('older', now - 2 * 3600e3, 600 * 1024);
  write('newer', now - 3600e3, 600 * 1024);
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ activityMaxMB: 1 }));
  b = await launch({}, { home });
  const ids = (await list()).map((x) => x.id);
  assert.deepEqual(ids, ['newer']);
  assert.ok(!fs.existsSync(path.join(dir, 'old.json')));
  assert.ok(!fs.existsSync(path.join(dir, 'older')));

  // Keeping nothing records nothing and drops what was kept.
  await b.ui('activity', { do: 'keep', days: 0 });
  await until(async () => (await list()).length === 0, 'everything to go');
  const s = b.as('z', 'Unrecorded');
  await s.text('navigate', { url: b.base + '/' });
  s.end();
  await sleep(1500);
  assert.equal((await list()).length, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')).activityDays, 0);
});

test('where the system can encrypt, logs and pictures are encrypted on disk', async () => {
  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'loui-activity-enc-'));
  const dir2 = path.join(home2, 'activity');
  const env = { LOUI_TEST_SAFESTORAGE: 'fake' };
  const sealed = (f) => fs.readFileSync(f).subarray(0, 6).toString() === 'LOUIA1';
  // A log as an earlier version left it: plain, with a picture.
  const start = Date.now() - 3600e3;
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('old-picture-bytes')]);
  fs.mkdirSync(path.join(dir2, 'old'), { recursive: true });
  fs.writeFileSync(path.join(dir2, 'old', '0.jpg'), jpeg);
  fs.writeFileSync(path.join(dir2, 'old.json'), JSON.stringify({
    id: 'old', session: 'old', label: 'Earlier session', source: 'code', start, end: start + 1000, ended: 'ended',
    steps: [{ kind: 'tool', at: start, ms: 10, label: 'opening old.example', url: 'http://old.example/', thumb: '0.jpg' }],
  }));
  let e = await launch(env, { home: home2 });
  const items = async () => (await e.ui('activity:list')).items;
  try {
    const old = await until(async () => (await items()).find((x) => x.label === 'Earlier session'), 'the earlier log');
    assert.ok(sealed(path.join(dir2, 'old.json')) && sealed(path.join(dir2, 'old', '0.jpg')), 'encrypted where it lay');
    const got = await e.ui('activity:get', old.id);
    assert.equal(got.steps[0].url, 'http://old.example/');
    assert.equal(got.steps[0].thumb, `data:image/jpeg;base64,${jpeg.toString('base64')}`);

    const s = e.as('enc', 'Encrypted session');
    await s.text('navigate', { url: e.base + '/second.html?kept-from-disk' });
    const log = await until(async () => {
      const it = (await items()).find((x) => x.label === 'Encrypted session');
      const l = it && await e.ui('activity:get', it.id);
      return l?.steps[0]?.thumb && l;
    }, 'a picture of the step');
    s.end();
    await until(async () => (await items()).find((x) => x.label === 'Encrypted session')?.ended, 'the session to end');
    await e.ui('activity:flush');
    await sleep(700); // the last write
    const raw = fs.readFileSync(path.join(dir2, `${log.id}.json`));
    assert.ok(sealed(path.join(dir2, `${log.id}.json`)));
    assert.ok(!raw.includes('kept-from-disk') && !raw.includes('Encrypted session'), 'nothing readable in the file');
    for (const f of fs.readdirSync(path.join(dir2, log.id))) assert.ok(sealed(path.join(dir2, log.id, f)), `${f} is encrypted`);
    assert.ok(fs.readFileSync(`${dir2}.key`, 'utf8').startsWith('t1:'), 'the key is itself encrypted');

    // Read back after a restart.
    await e.close();
    e = await launch(env, { home: home2 });
    const again = await e.ui('activity:get', log.id);
    assert.match(again.steps[0].url, /kept-from-disk/);
    assert.match(again.steps[0].thumb, /^data:image\/jpeg;base64,\/9j\//);

    // A key that will not open (a profile copied from elsewhere): the logs
    // under it cannot be read again, and are removed.
    await e.close();
    fs.writeFileSync(`${dir2}.key`, 'not a key');
    e = await launch(env, { home: home2 });
    assert.deepEqual(await items(), []);
    assert.deepEqual(fs.readdirSync(dir2), []);
  } finally {
    await e.close();
    fs.rmSync(home2, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
