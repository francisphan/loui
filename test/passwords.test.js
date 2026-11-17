// Passwords: offered for saving after the user signs in, kept encrypted, filled
// only when the user picks an account from the key, and out of Claude's reach.
//
// Linux test machines have no keyring, so these runs use the test-only cipher
// (LOUI_TEST_SAFESTORAGE=fake, honoured only with LOUI_TEST); the last test
// runs with encryption unavailable.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launch } = require('./drive');
const TOOLS = require('../src/shared/tools');

let b;
test.before(async () => {
  b = await launch({ LOUI_TEST_SAFESTORAGE: 'fake' });
  // Guardrails would (rightly) stop a session's evaluate on a page with a
  // password field and wait for the user; these tests check the password
  // manager's own isolation, so they turn guardrails off.
  await b.ui('guard:set', { on: false });
});
test.after(async () => { await b?.close(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what, ms = 8000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
    const got = await check();
    if (got) return got;
  }
  assert.fail(`timed out waiting for ${what}`);
}
const onScreen = async () => (await b.state()).tabs.find((t) => t.active);
const pw = async () => (await b.state()).passwords;
// The user opens a page in the tab on screen, and it finishes loading.
async function visit(url, title) {
  await b.ui('go', url);
  await until(async () => { const t = await onScreen(); return t.url === url && !t.loading && t.title === title; }, `${url} to load`);
  await sleep(200); // the page script goes in at DOM ready
}
// Runs in the page on screen, in its own world (as the page itself would).
const js = async (code) => b.ui('tab:js', { id: (await onScreen()).id, code });
// The user types into the sign-in form and sends it.
const signIn = (user, pass, how = 'form.requestSubmit()') => js(`(() => {
  const form = document.getElementById('form');
  document.getElementById('user').value = ${JSON.stringify(user)};
  document.getElementById('pass').value = ${JSON.stringify(pass)};
  ${how};
})()`);
const offer = () => until(async () => (await pw()).offer, 'an offer to save');
const noOffer = async () => { await sleep(1500); assert.equal((await pw()).offer, null); };
const answer = async (choice) => {
  const o = await offer();
  await b.ui('passwords', { do: 'answer', id: o.id, choice });
  await until(async () => !(await pw()).offer, 'the offer to go');
  return o;
};
const list = () => b.ui('passwords:list');
const secrets = new Set(); // every password and username used, to look for on disk

test('signing in offers to save, and Save keeps it encrypted', async () => {
  const site = new URL(b.base).host;
  await visit(`${b.base}/login.html`, 'Sign in');
  secrets.add('ana@example.com').add('hunter2-Secret!');
  await signIn('ana@example.com', 'hunter2-Secret!');
  const o = await offer();
  assert.equal(o.site, site);
  assert.equal(o.username, 'ana@example.com');
  assert.equal(o.update, false);
  assert.equal((await onScreen()).title, 'Welcome');
  await answer('save');

  const l = await list();
  assert.deepEqual(l.items.map((i) => [i.site, i.username]), [[site, 'ana@example.com']]);
  const file = JSON.parse(fs.readFileSync(path.join(b.home, 'passwords.json'), 'utf8'));
  assert.equal(file.logins.length, 1);
  assert.equal(file.logins[0].origin, b.base);
  assert.match(file.logins[0].password, /^t1:/);
  assert.match(file.logins[0].username, /^t1:/);
  const raw = fs.readFileSync(path.join(b.home, 'passwords.json'), 'utf8');
  assert.ok(!raw.includes('hunter2') && !raw.includes('ana@example.com'));
  assert.equal(await b.ui('passwords:reveal-now', l.items[0].id), 'hunter2-Secret!');
});

test('a sign-in that comes back to the form is not offered', async () => {
  await visit(`${b.base}/login.html?fail`, 'Sign in');
  secrets.add('wrong-password');
  await signIn('ana@example.com', 'wrong-password');
  await until(async () => (await onScreen()).url === `${b.base}/login.html`, 'the form again');
  await noOffer();
});

test('the same password offers nothing; a new one offers an update', async () => {
  await visit(`${b.base}/login.html`, 'Sign in');
  await signIn('ana@example.com', 'hunter2-Secret!');
  await until(async () => (await onScreen()).title === 'Welcome', 'the welcome page');
  await noOffer();

  await visit(`${b.base}/login.html`, 'Sign in');
  secrets.add('even-better-Secret#2');
  await signIn('ana@example.com', 'even-better-Secret#2', 'document.getElementById("go").click()');
  const o = await offer();
  assert.equal(o.update, true);
  await answer('save');
  const l = await list();
  assert.equal(l.items.length, 1);
  assert.equal(await b.ui('passwords:reveal-now', l.items[0].id), 'even-better-Secret#2');
});

test('a sign-in sent by script, where the form goes away, is offered too', async () => {
  await visit(`${b.base}/login-fetch.html`, 'Sign in by script');
  secrets.add('bo-the-user').add('fetch-Secret-77');
  await js(`(() => {
    document.getElementById('user').value = 'bo-the-user';
    document.getElementById('pass').value = 'fetch-Secret-77';
    document.getElementById('go').click();
  })()`);
  const o = await offer();
  assert.equal(o.username, 'bo-the-user');
  await answer('later');
  assert.equal((await list()).items.length, 1, 'Not now saves nothing');
});

test('Never for this site stops the offers, until it is removed from the list', async () => {
  const other = b.base.replace('127.0.0.1', 'localhost');
  await visit(`${other}/login.html`, 'Sign in');
  secrets.add('cy@example.com').add('never-Secret-1');
  await signIn('cy@example.com', 'never-Secret-1');
  await answer('never');
  assert.deepEqual((await list()).never.map((n) => n.origin), [other]);

  await visit(`${other}/login.html`, 'Sign in');
  await signIn('cy@example.com', 'never-Secret-1');
  await until(async () => (await onScreen()).title === 'Welcome', 'the welcome page');
  await noOffer();

  await b.ui('passwords', { do: 'unnever', origin: other });
  assert.deepEqual((await list()).never, []);
});

test('the key shows where there are saved logins, and fills only when an account is chosen', async () => {
  await visit(`${b.base.replace('127.0.0.1', 'localhost')}/login.html`, 'Sign in');
  assert.equal((await pw()).key, 0, 'no key on a site with nothing saved');
  await visit(`${b.base}/login.html`, 'Sign in');
  assert.equal((await pw()).key, 1);
  assert.deepEqual(await b.ui('passwords:menu'), ['ana@example.com']);

  await sleep(1000);
  const values = () => js(`[document.getElementById('user').value, document.getElementById('pass').value, window.inputs]`);
  assert.deepEqual(await values(), ['', '', 0], 'nothing is filled when the page loads');

  const result = await b.ui('passwords:choose', 0);
  assert.deepEqual(result, { filled: true, username: true, password: true });
  assert.deepEqual(await values(), ['ana@example.com', 'even-better-Secret#2', 2], 'filled, with input events');
});

test('nothing is filled into a frame from another site, or into fields no one can see', async () => {
  await visit(`${b.base}/login-frame.html`, 'Framed sign in');
  await until(() => js('window.got.includes("ready")'), 'the frame to load');
  assert.equal((await pw()).key, 1, 'the page itself has a login saved');
  assert.deepEqual(await b.ui('passwords:choose', 0), { filled: false });
  await sleep(300);
  assert.deepEqual(await js('window.got'), ['ready'], 'the frame got nothing');

  await visit(`${b.base}/login-hidden.html`, 'Hidden sign in');
  assert.deepEqual(await b.ui('passwords:choose', 0), { filled: false });
  assert.deepEqual(await js(`['user', 'pass', 'pass2'].map((id) => document.getElementById(id).value)`), ['', '', '']);
});

test("Claude sessions' tabs get no offers, no key and no fills, and no tool reaches passwords", async () => {
  assert.deepEqual(TOOLS.map((t) => t.name).filter((n) => /pass|login|credential|secret/i.test(n)), []);
  const s = b.as('pw-session', 'Claude Code');
  await s.call('navigate', { url: `${b.base}/login.html` });
  const tab = (await b.state()).tabs.find((t) => t.group === 'pw-session');
  await b.ui('tab:select', tab.id);
  assert.equal((await pw()).key, 0, 'no key in a session tab, though the site has a login saved');
  assert.deepEqual(await b.ui('passwords:menu'), []);

  // The session signs in with a password of its own.
  secrets.add('session-Secret-9');
  await s.call('evaluate', { code: `(() => {
    document.getElementById('user').value = 'claude@example.com';
    document.getElementById('pass').value = 'session-Secret-9';
  })()` });
  const outline = await s.text('snapshot');
  assert.ok(!outline.includes('session-Secret-9') && outline.includes('••••'), 'snapshots mask passwords');
  await s.call('evaluate', { code: `document.getElementById('form').requestSubmit()` });
  await until(async () => (await b.state()).tabs.find((t) => t.id === tab.id).title === 'Welcome', 'the session to sign in');
  await noOffer();
  assert.equal((await list()).items.length, 1);

  // A tab of the user's handed over, after the user signed in in it: what the
  // page script reported stays out of the console the session can read.
  await b.ui('tab:select', (await b.state()).tabs.find((t) => t.group === 'you').id);
  secrets.add('dee@example.com').add('handed-Secret-3');
  await visit(`${b.base}/login.html`, 'Sign in');
  const mine = (await onScreen()).id;
  await signIn('dee@example.com', 'handed-Secret-3');
  await offer();
  const asked = s.call('request_tab');
  await until(async () => (await b.state()).asking, 'the hand-over question');
  await b.ui('tab:select', mine);
  await b.ui('handoff:answer', true);
  await asked;
  assert.equal((await pw()).offer, null, 'the offer went with the tab');
  const logs = await s.text('console_logs');
  assert.ok(!logs.includes('handed-Secret-3') && !logs.includes('loui-pw'), logs);
  s.end();
  await until(async () => !(await b.state()).groups.some((g) => g.id === 'pw-session'), 'the session to end');
});

test('the Passwords panel lists, edits and deletes', async () => {
  await b.ui('passwords:panel');
  const rows = () => b.ui('chrome:eval', `[...document.querySelectorAll('#passwords-list .password-row')].map((r) => r.textContent)`);
  const shown = await until(async () => (await rows()).length && rows(), 'the panel to list');
  assert.equal(shown.length, 1);
  assert.ok(shown[0].includes('ana@example.com') && !shown[0].includes('even-better'), 'the password is not in the window until revealed');

  const [item] = (await list()).items;
  await b.ui('passwords', { do: 'update', id: item.id, username: 'ana.b@example.com', password: 'edited-Secret-4' });
  secrets.add('ana.b@example.com').add('edited-Secret-4');
  assert.equal((await list()).items[0].username, 'ana.b@example.com');
  assert.equal(await b.ui('passwords:reveal-now', item.id), 'edited-Secret-4');

  await b.ui('passwords', { do: 'reveal', id: item.id });
  await until(async () => (await rows())[0]?.includes('edited-Secret-4'), 'the revealed password');

  await b.ui('passwords', { do: 'remove', id: item.id });
  assert.deepEqual((await list()).items, []);
  await until(async () => (await rows()).length === 0, 'the row to go');
  assert.equal((await pw()).key, 0);
});

test('importing the CSV from Brave or Chrome', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loui-csv-'));
  const csv = path.join(dir, 'Brave Passwords.csv');
  secrets.add('csv-Secret,with "quotes"').add('csv-Second-5');
  fs.writeFileSync(csv, [
    'name,url,username,password,note',
    `127.0.0.1,${b.base}/login.html,eve@example.com,"csv-Secret,with ""quotes""",`,
    'example,https://accounts.example.com/signin?x=1,eve,csv-Second-5,"a note,\nover two lines"',
    'app,android://abc@com.example/,eve,csv-App-6,',
    `again,${b.base}/,eve@example.com,other-password,`,
  ].join('\r\n'));
  try {
    assert.deepEqual(await b.ui('passwords:import-file', csv), { added: 2, skipped: 2 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const items = (await list()).items;
  assert.deepEqual(items.map((i) => [i.origin, i.username]), [
    [b.base, 'eve@example.com'],
    ['https://accounts.example.com', 'eve'],
  ]);
  assert.equal(await b.ui('passwords:reveal-now', items[0].id), 'csv-Secret,with "quotes"');
  // Exact origins: the https login is not offered anywhere else.
  await visit(`${b.base}/login.html`, 'Sign in');
  assert.deepEqual(await b.ui('passwords:menu'), ['eve@example.com']);
});

test('no password or username is anywhere in the profile in plain text', async () => {
  await sleep(1500); // other files (tabs.json, history.json) are written in batches
  const found = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && st.size < 50e6) {
        let bytes;
        try { bytes = fs.readFileSync(p); } catch { continue; }
        for (const s of secrets) {
          if (bytes.includes(Buffer.from(s, 'utf8')) || bytes.includes(Buffer.from(s, 'utf16le'))) found.push(`${s} in ${path.relative(b.home, p)}`);
        }
      }
    }
  };
  walk(b.home);
  assert.deepEqual(found, []);
});

test('without encryption, passwords stay off and nothing is written', async () => {
  const off = await launch({ LOUI_TEST_SAFESTORAGE: 'off' });
  try {
    const state = async () => (await off.state()).passwords;
    assert.equal((await state()).available, false);
    await off.ui('go', `${off.base}/login.html`);
    await until(async () => (await off.state()).tabs.find((t) => t.active)?.title === 'Sign in', 'the page');
    const id = (await off.state()).tabs.find((t) => t.active).id;
    await off.ui('tab:js', { id, code: `document.getElementById('user').value = 'x@example.com'; document.getElementById('pass').value = 'off-Secret-8'; document.getElementById('form').requestSubmit()` });
    await until(async () => (await off.state()).tabs.find((t) => t.active)?.title === 'Welcome', 'the welcome page');
    await sleep(1500);
    assert.equal((await state()).offer, null);
    const l = await off.ui('passwords:list');
    assert.equal(l.available, false);
    assert.match(l.why, /turned off/);
    await assert.rejects(off.ui('passwords:import-file', __filename));
    assert.equal(fs.existsSync(path.join(off.home, 'passwords.json')), false);
  } finally {
    await off.close();
  }
});
