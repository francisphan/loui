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

test('what the user blocked or paused is told apart from what failed, in the feed and in the count', async () => {
  const feedOf = (id) => chrome(`[...document.querySelectorAll('#feed .did')]
    .filter((n) => n.dataset.session === ${JSON.stringify(id)}).map((n) => n.className.replace(' live', '') + ': ' + n.textContent)`);
  const s = b.as('a5', 'Careful');
  const page = await s.text('navigate', { url: b.base + '/guard.html' });
  const ref = refOf(page, /button "Delete" \[(e\d+)\]/);
  const clicking = s.text('click', { ref });
  const g = await until(async () => (await b.state()).guard, 'the guardrail question');
  await b.ui('guard:answer', { id: g.id, choice: 'block' });
  await assert.rejects(clicking, /The user declined/);
  await b.ui('pause', { group: 'a5', on: true });
  await assert.rejects(s.text('click', { ref }), /paused you/);
  await assert.rejects(s.text('click', { ref }), /paused you/); // said once in the feed, however often it tries
  await b.ui('pause', { group: 'a5', on: false });
  await assert.rejects(s.text('click', { ref: 'e9999' }), /no longer on the page/);
  await s.text('navigate', { url: b.base + '/second.html' });
  await s.text('history', { action: 'sideways' }); // a step with no label draws nothing
  const where = new URL(b.base).host;
  const lines = await until(async () => { const l = await feedOf('a5'); return l.length >= 5 && l; }, 'the steps in the feed');
  assert.deepEqual(lines, [
    `did: Opening ${where}/guard.html`,
    'did stopped: You blocked this: click "Delete"',
    'did stopped: Paused by you: clicking',
    "did failed: Clicking (didn't work: e9999 is no longer on the page. Take a new snapshot.)",
    `did: Opening ${where}/second.html`,
  ]);
  const item = await until(async () => (await list()).find((x) => x.label === 'Careful' && x.steps >= 6 && x), 'the log');
  assert.equal(item.failed, 1, 'only the click that went wrong');
  const log = await logOf('Careful');
  assert.deepEqual(log.steps.filter((x) => x.stopped).map((x) => `${x.kind} ${x.stopped}`), ['tool blocked', 'guard blocked', 'tool paused']);
  s.end();
  await until(async () => (await feedOf('a5')).at(-1) === 'did ended: Session ended', 'the line that says it ended');
});

test('the Sessions panel says whether a live session is working, paused or open, and can show, pause and end it', async () => {
  const s = b.as('a6', 'Idle');
  await s.text('navigate', { url: b.base + '/second.html' });
  await chrome("document.getElementById('activity-open').click()");
  const row = (code) => chrome(`(() => {
    const row = [...document.querySelectorAll('#activity-list .activity-row')].find((r) => r.querySelector('.name').textContent === 'Idle');
    const says = (word) => !!row && row.querySelector('.facts').textContent.endsWith(' · ' + word);
    const press = (label) => [...row.querySelectorAll('.activity-controls button')].find((x) => x.textContent === label).click();
    return ${code};
  })()`);
  await until(() => row("says('open')"), 'a connected, idle session to read "open"');
  assert.equal(await chrome(`[...document.querySelectorAll('#activity-list .activity-row')]
    .find((r) => r.querySelector('.name').textContent === 'Careful').querySelector('.activity-controls') === null`), true, 'none for one that ended');

  await row("press('Show tabs')");
  await until(async () => (await b.state()).tabs.find((t) => t.active)?.group === 'a6', "the session's tab on screen");
  await row("press('Take over')");
  await until(() => row("says('paused')"), '"paused"');
  assert.equal((await b.state()).groups.find((g) => g.id === 'a6').paused, true);
  await row("press('Let Claude continue')");
  await until(() => row("says('open')"), '"open" again');
  const pick = s.text('ask_user_to_pick', { message: 'Which?' });
  await until(() => row("says('working now')"), '"working now" while it is doing something');
  await b.ui('pick:cancel');
  await pick;

  await row("press('End session')");
  assert.match(await row("row.querySelector('.activity-controls .sure').textContent"), /End session\?/);
  await row("press('Cancel')");
  assert.ok((await b.state()).groups.some((g) => g.id === 'a6'), 'asking does not end it');
  await row("press('End session')");
  await row("press('End session')");
  await until(async () => !(await b.state()).groups.some((g) => g.id === 'a6'), 'the session to end');
  await until(async () => (await list()).find((x) => x.label === 'Idle')?.ended === 'closed', 'the log to say so');
  await until(() => row("says('you closed it') && !row.querySelector('.activity-controls')"), 'the row to say so');
  await chrome("document.getElementById('activity-close').click()");
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

test('the panel fetches the session on show again only when that one changes, and each picture once', async () => {
  const s = b.as('a5', 'Watched');
  await s.text('navigate', { url: b.base + '/' });
  const log = await until(async () => {
    const l = await logOf('Watched');
    return l?.steps[0]?.thumb && l;
  }, 'a picture of the step');
  // A picture the window says it holds is not sent again.
  const again = await b.ui('activity:get', { id: log.id, have: [0] });
  assert.equal(again.steps[0].thumb, true);
  assert.equal(again.steps[0].url, b.base + '/');

  // In the panel, on that session: another session's steps leave it as it is.
  await chrome("document.querySelector('#activity-list .activity-summary .quiet').click()");
  await until(() => chrome("[...document.querySelectorAll('#activity-list .activity-row .name')].some((n) => n.textContent === 'Watched')"), 'the list');
  await chrome(`[...document.querySelectorAll('#activity-list .activity-row')]
    .find((r) => r.querySelector('.name').textContent === 'Watched').querySelector('.open').click()`);
  await until(() => chrome("!!document.querySelector('.activity-step .page img')"), 'the timeline');
  await sleep(700); // the changes already on their way
  const mark = "document.querySelector('#activity-list .activity-summary').dataset.kept";
  await chrome(`${mark} = 'yes'`);
  const o = b.as('a6', 'Other');
  await o.text('navigate', { url: b.base + '/second.html' });
  await sleep(1500);
  assert.equal(await chrome(mark), 'yes', 'not drawn again for another session');
  // Its own next step draws it again, with the picture the window kept.
  await s.text('snapshot');
  await until(() => chrome(`${mark} !== 'yes' && document.querySelectorAll('.activity-step').length === 2`), 'the new step');
  assert.match(await chrome("document.querySelector('.activity-step .page img').src"), /^data:image\/jpeg;base64,/);
  s.end();
  o.end();
  await until(async () => (await list()).filter((x) => /Watched|Other/.test(x.label)).every((x) => x.ended), 'both to end');
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

    // Where the system cannot encrypt in this run, the encrypted logs are
    // listed as unreadable, not lost, and the key is left alone.
    await e.close();
    const key = fs.readFileSync(`${dir2}.key`, 'utf8');
    e = await launch({ LOUI_TEST_SAFESTORAGE: 'off' }, { home: home2 });
    assert.deepEqual((await items()).map((x) => x.unreadable), [true, true]);
    assert.equal(fs.readFileSync(`${dir2}.key`, 'utf8'), key);
    await e.close();
    e = await launch(env, { home: home2 });
    assert.match((await e.ui('activity:get', log.id)).steps[0].url, /kept-from-disk/, 'readable again with the key');

    // A key that will not open (a profile copied from elsewhere, or the
    // system's own key lost): it is put aside, never written over, and the
    // logs under it are not deleted at once. They are listed as unreadable,
    // so that they still go when too old or when the user clears the list.
    await e.close();
    fs.writeFileSync(`${dir2}.key`, 'not a key');
    e = await launch(env, { home: home2 });
    const unread = await items();
    assert.equal(unread.length, 2);
    assert.ok(unread.every((x) => x.unreadable), 'listed as unreadable');
    assert.equal(await e.ui('activity:get', log.id), null);
    assert.ok(fs.existsSync(path.join(dir2, `${log.id}.json`)), 'still on disk');
    const aside = fs.readdirSync(home2).filter((f) => f.startsWith('activity.key.bad-'));
    assert.equal(aside.length, 1);
    assert.equal(fs.readFileSync(path.join(home2, aside[0]), 'utf8'), 'not a key', 'the old key file is kept aside');
    assert.ok(fs.readFileSync(`${dir2}.key`, 'utf8').startsWith('t1:'), 'a new key for new logs');
    await e.ui('activity', { do: 'clear' });
    await until(async () => (await items()).length === 0, 'the unreadable logs to be cleared');
    assert.deepEqual(fs.readdirSync(dir2), []);
  } finally {
    await e.close();
    fs.rmSync(home2, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('a keyring that fails at start does not stop the log: plain files for that run', async () => {
  const { createActivity } = require('../src/main/activity');
  const home3 = fs.mkdtempSync(path.join(os.tmpdir(), 'loui-activity-key-'));
  const dir3 = path.join(home3, 'activity');
  const cipher = {
    available: true,
    encrypt() { throw new Error('the keyring is locked'); },
    decrypt() { throw new Error('the keyring is locked'); },
  };
  try {
    const a = createActivity({ dir: dir3, tabs: { current: () => null }, settings: {}, save() {}, cipher });
    assert.deepEqual((await a.list()).items, []);
    assert.ok(!fs.existsSync(`${dir3}.key`), 'no key file is made');
    const session = { id: 's', group: 's', label: 'Plain', source: 'code' };
    a.open(session);
    a.step(session, 'reading the page', false).done(null);
    await a.probes['activity:flush']();
    const [name] = fs.readdirSync(dir3).filter((f) => f.endsWith('.json'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir3, name), 'utf8')).label, 'Plain');
  } finally {
    fs.rmSync(home3, { recursive: true, force: true });
  }
});
