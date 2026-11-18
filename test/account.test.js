// The Claude panel's account: whether Claude Code is signed in, the card that
// takes the message box's place when it is not, and signing in from there.
//
// The real Claude Code is never asked anything here, let alone signed in or
// out: LOUI_CLAUDE (honoured only under LOUI_TEST) points Loui's launcher at
// a stand-in (test/fixture/claude), which does what a JSON file tells it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launch } = require('./drive');
const TOOLS = require('../src/shared/tools');

let b, home, dir, program, script;
const EMAIL = 'owner@example.test';
const CODE = 'c0de-from-the-page#state';

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (check, what, ms = 15000) => {
  for (const end = Date.now() + ms; Date.now() < end; await pause(50)) {
    const value = await check();
    if (value) return value;
  }
  throw new Error(`timed out waiting for ${what}`);
};
const chrome = (code) => b.ui('chrome:eval', code);
// The stand-in's instructions, and what it wrote back.
const fake = () => JSON.parse(fs.readFileSync(script, 'utf8'));
const tell = (change) => fs.writeFileSync(script, JSON.stringify({ ...fake(), ...change }));
const account = async () => (await b.state()).claude;
// Asks afresh, as "I’ve signed in" does, and waits for the answer.
const check = async (state) => {
  await b.ui('claude', { do: 'check' });
  return until(async () => { const a = await account(); return !a.checking && (!state || a.state === state) && a; }, `the account to be ${state}`);
};
const card = () => chrome(`(() => {
  const shown = (id) => { const n = document.getElementById(id); return !n.hidden && getComputedStyle(n).display !== 'none'; };
  const text = (id) => (shown(id) ? document.getElementById(id).textContent : '');
  return {
    shown: shown('account-card'), composer: shown('composer'),
    title: text('account-title'), line: text('account-line'), note: text('account-note'),
    buttons: ['account-sign-in', 'account-install', 'account-open', 'account-check', 'account-cancel'].filter(shown).map((id) => document.getElementById(id).textContent),
    code: shown('account-code-form'),
    head: document.querySelector('#panel-head h1').title,
  };
})()`);
const press = (id) => chrome(`void document.getElementById('${id}').click()`);
const paste = (code) => chrome(`{ const f = document.getElementById('account-code'); f.value = ${JSON.stringify(code)}; document.getElementById('account-code-form').requestSubmit(); }`);
const install = () => { fs.copyFileSync(path.join(__dirname, 'fixture', 'claude'), program); fs.chmodSync(program, 0o755); };
const page = () => `${b.base}/done.html?sign-in=${Date.now()}`;
const tabWith = async (url) => (await b.state()).tabs.find((t) => t.url === url);
const closeTab = async (url) => { const t = await tabWith(url); if (t) await b.ui('tab:close', t.id); };

test.before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'loui-test-'));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loui-claude-'));
  program = path.join(dir, 'claude');
  script = path.join(dir, 'script.json');
  install();
  fs.writeFileSync(script, JSON.stringify({ status: 'subscription' }));
  b = await launch({
    LOUI_CLAUDE: program, LOUI_FAKE_CLAUDE: script,
    // A key left in the shell: Claude Code must never be handed it.
    ANTHROPIC_API_KEY: 'sk-ant-not-a-real-key', ANTHROPIC_AUTH_TOKEN: 'not-a-real-token',
  }, { home });
});
test.after(async () => {
  await b?.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('signed in: the message box is there, and the panel\'s name says how', async () => {
  const a = await check('ready');
  assert.deepEqual({ state: a.state, kind: a.kind, detail: a.detail, signIn: a.signIn }, { state: 'ready', kind: 'subscription', detail: EMAIL, signIn: null });
  let c = await card();
  assert.equal(c.shown, false);
  assert.equal(c.composer, true);
  assert.equal(c.head, `Signed in with your Claude subscription (${EMAIL}).`);
  // It was asked through the launcher, without the key from the shell.
  assert.ok(fake().calls.includes('auth status --json'));
  assert.deepEqual(fake().keys, []);

  // An API key or a cloud provider instead of a subscription: said quietly, nothing in the way.
  tell({ status: 'key' });
  assert.equal((await check()).kind, 'api-key');
  c = await card();
  assert.match(c.head, /API key, not a Claude subscription/);
  assert.equal(c.shown, false);
  tell({ status: 'cloud' });
  assert.equal((await check()).kind, 'cloud');
  c = await card();
  assert.match(c.head, /cloud provider \(bedrock\), not a Claude subscription/);
  assert.equal(c.composer, true);
});

test('signed out: the card, and signing in on a page in a new tab of the owner\'s, with a code', async () => {
  const url = page();
  tell({ status: 'out', login: { url, browser: false, code: CODE } });
  await check('signed-out');
  let c = await card();
  assert.equal(c.shown, true);
  assert.equal(c.composer, false);
  assert.equal(c.title, 'Sign in to Claude to use the panel');
  assert.equal(c.line, 'It uses your Claude subscription through Claude Code. No API key is involved.');
  assert.deepEqual(c.buttons, ['Sign in', 'I’ve signed in']);
  assert.equal(c.code, false);

  const before = (await b.state()).tabs.length;
  await press('account-sign-in');
  // The page opens in a new tab of the owner's own, on screen.
  const tab = await until(() => tabWith(url), 'the sign-in page');
  assert.equal(tab.group, 'you');
  assert.equal(tab.active, true);
  assert.equal((await b.state()).tabs.length, before + 1);
  c = await until(async () => { const now = await card(); return now.code && now; }, 'the code field');
  assert.equal(c.line, 'Sign in on the page that opened. If it shows a code, paste it here.');
  assert.deepEqual(c.buttons, ['Cancel']);
  assert.ok(fake().calls.includes('auth login --claudeai'));
  // The window is told a sign-in is under way, and nothing of it: not its address, not its code.
  const told = JSON.stringify(await account());
  assert.ok(!told.includes(url) && !told.includes('done.html'));

  // A wrong code: Claude Code says so, and asks again.
  await paste('not-the-code');
  c = await until(async () => { const now = await card(); return now.note && now; }, 'what was wrong with the code');
  assert.match(c.note, /not from this sign-in/);
  assert.equal(c.code, true);
  // The right one: signed in, and the message box is back.
  await paste(CODE);
  await until(async () => (await account()).state === 'ready' && !(await account()).signIn, 'the sign-in to finish');
  c = await card();
  assert.equal(c.shown, false);
  assert.equal(c.composer, true);
  assert.equal(JSON.stringify(await account()).includes(CODE), false);
  assert.deepEqual(fake().keys, []);
  await closeTab(url);
});

test('Claude Code opens the system\'s browser itself: Loui waits, and can open the page here instead', async () => {
  const url = page();
  tell({ status: 'out', login: { url, browser: true, code: CODE } });
  await check('signed-out');
  const before = (await b.state()).tabs.length;
  await press('account-sign-in');
  let c = await until(async () => { const now = await card(); return now.buttons.includes('Open the sign-in page here') && now; }, 'the sign-in to start');
  assert.equal(c.line, 'Finish signing in in your default browser, or open the page here.');
  assert.deepEqual(c.buttons, ['Open the sign-in page here', 'Cancel']);
  assert.equal(c.code, false);
  assert.equal((await b.state()).tabs.length, before); // no tab of Loui's: the browser is Claude Code's to open
  // The browser comes back to Claude Code by itself.
  tell({ done: true });
  await until(async () => (await account()).state === 'ready' && !(await account()).signIn, 'the sign-in to finish');
  assert.equal((await card()).shown, false);

  // Again, cancelled: Claude Code's sign-in is stopped, and nothing is said to have failed.
  tell({ status: 'out' });
  await check('signed-out');
  await press('account-sign-in');
  await until(async () => (await account()).signIn?.step === 'browser', 'the sign-in to start');
  await press('account-cancel');
  await until(async () => !(await account()).signIn, 'the sign-in to stop');
  c = await card();
  assert.deepEqual(c.buttons, ['Sign in', 'I’ve signed in']);
  assert.equal(c.note, '');
  assert.equal((await account()).state, 'signed-out');

  // Again, with the page opened here: it shows a code, which is pasted back.
  await press('account-sign-in');
  await until(async () => (await account()).signIn?.canOpen, 'the sign-in to start');
  await press('account-open');
  const tab = await until(() => tabWith(url), 'the sign-in page');
  assert.equal(tab.group, 'you');
  await until(async () => (await card()).code, 'the code field');
  // The code is masked as it is typed, shown when asked, and masked again once it is sent.
  const field = () => chrome("(() => { const s = document.getElementById('account-code-show'); return [document.getElementById('account-code').type, s.textContent, s.getAttribute('aria-label')]; })()");
  assert.deepEqual(await field(), ['password', 'Show', 'Show the code']);
  await press('account-code-show');
  assert.deepEqual(await field(), ['text', 'Hide', 'Hide the code']);
  await press('account-code-show');
  assert.deepEqual(await field(), ['password', 'Show', 'Show the code']);
  await press('account-code-show');
  await paste(CODE);
  assert.deepEqual(await field(), ['password', 'Show', 'Show the code']);
  await until(async () => (await account()).state === 'ready' && !(await account()).signIn, 'the sign-in to finish');
  await closeTab(url);
});

test('a sign-in that fails says why, and the card stays', async () => {
  const url = page();
  tell({ status: 'out', login: { url, browser: false, code: CODE, fail: 'This account has no Claude subscription.' } });
  await check('signed-out');
  await press('account-sign-in');
  await until(async () => (await card()).code, 'the code field');
  await paste(CODE);
  // The card as drawn once the sign-in is over ("Sign in" is back), not as it was a moment before.
  const c = await until(async () => { const now = await card(); return now.note && now.buttons.includes('Sign in') && !(await account()).signIn && now; }, 'the sign-in to fail');
  assert.equal(c.note, 'That did not work: This account has no Claude subscription.');
  assert.equal(c.title, 'Sign in to Claude to use the panel');
  assert.deepEqual(c.buttons, ['Sign in', 'I’ve signed in']);
  assert.equal((await account()).state, 'signed-out');
  // "I’ve signed in" forgets the failure.
  await check('signed-out');
  assert.equal((await card()).note, '');
  await closeTab(url);
});

test('not known: the message box stays, and a message turned away for want of a login brings the card', async () => {
  tell({ status: 'old', query: 'refuse' }); // a Claude Code without the status command
  const a = await check('unknown');
  assert.equal(a.kind, null);
  let c = await card();
  assert.equal(c.shown, false);
  assert.equal(c.composer, true);

  await b.ui('chat:send', { text: 'Summarize this page' });
  c = await until(async () => { const now = await card(); return now.shown && !(await account()).checking && now; }, 'the card');
  assert.equal(c.title, 'Sign in to Claude to use the panel');
  assert.equal(c.note, 'Not logged in'); // the error's first line, without the advice for a terminal
  assert.deepEqual(c.buttons, ['Sign in', 'I’ve signed in']);
  assert.equal((await account()).state, 'signed-out');
  // Not printed raw in the conversation, which keeps what was asked.
  await until(async () => !(await b.state()).groups.find((g) => g.id === 'you').busy, 'the message to end');
  assert.equal(await chrome("document.querySelectorAll('#feed .trouble').length"), 0);
  assert.equal(await chrome("document.querySelector('#feed .said').textContent"), 'Summarize this page');

  // Signed in from a terminal meanwhile: the next message is answered, and the card goes.
  tell({ status: 'subscription', query: 'answer' });
  await b.ui('chat:send', { text: 'Again' });
  await until(async () => (await account()).state === 'ready', 'the account to be ready');
  assert.equal((await card()).shown, false);
  await b.ui('chat:reset');
});

test('Claude Code not installed: the card says what to install', async () => {
  fs.rmSync(program);
  try {
    await check('not-installed');
    let c = await card();
    assert.equal(c.shown, true);
    assert.equal(c.composer, false);
    assert.equal(c.title, 'Claude Code is not installed');
    assert.match(c.line, /Install Claude Code on this computer and sign in/);
    assert.deepEqual(c.buttons, ['Get Claude Code', 'I’ve signed in']);
    // A message sent anyway (from the command palette, say) is not answered with an error in red.
    await b.ui('chat:send', { text: 'Hello' });
    await pause(400);
    assert.equal(await chrome("document.querySelectorAll('#feed .trouble').length"), 0);
    await b.ui('chat:reset');
    // Installed, and "I’ve signed in": the message box is back.
    install();
    tell({ status: 'subscription' });
    await check('ready');
    c = await card();
    assert.equal(c.shown, false);
    assert.equal(c.composer, true);
  } finally {
    install();
  }
});

test('Settings › Claude: the account in words, Check again, and Sign in', async () => {
  const url = page();
  tell({ status: 'subscription', login: { url, browser: true, code: CODE } });
  await check('ready');
  await b.ui('settings:open', 'claude');
  const js = (code) => b.ui('settings:js', code);
  const row = () => js(`(() => {
    const r = document.getElementById('value-claude-account');
    const shown = (id) => { const n = document.getElementById(id); return !!n && !n.hidden; };
    return { value: r?.textContent, signIn: shown('set-claude-sign-in'), check: shown('set-claude-check') };
  })()`);
  await until(async () => (await row())?.value?.startsWith('Signed in'), 'the Settings window');
  assert.deepEqual(await row(), { value: `Signed in with your Claude subscription (${EMAIL}).`, signIn: false, check: true });

  tell({ status: 'out' });
  await js("void document.getElementById('set-claude-check').click()");
  await until(async () => (await row()).value === 'Not signed in.', 'the row to say so');
  assert.equal((await row()).signIn, true);

  // "Sign in" is followed in the Claude panel.
  const calls = fake().calls.filter((c) => c.startsWith('auth login')).length;
  await js("void document.getElementById('set-claude-sign-in').click()");
  await until(async () => (await account()).signIn?.step === 'browser', 'the sign-in to start');
  assert.equal(fake().calls.filter((c) => c.startsWith('auth login')).length, calls + 1);
  assert.equal((await row()).value, 'Signing in. Finish in your browser, or in the Claude panel.');
  await until(async () => (await card()).line === 'Finish signing in in your default browser, or open the page here.', 'the card to say where');
  tell({ done: true });
  await until(async () => (await row()).value.startsWith('Signed in with your Claude subscription'), 'the row to say so');

  // Another page asking on the Settings window's channel is not answered, and starts nothing.
  tell({ status: 'out' });
  await check('signed-out');
  assert.equal(await b.ui('settings:stranger', { what: 'claude:sign-in' }), null);
  await pause(300);
  assert.equal((await account()).signIn, null);
  await b.ui('settings:close');
});

test('a Claude session cannot start a sign-in, see one, or read its address or code', async () => {
  const url = page();
  tell({ status: 'out', login: { url, browser: false, code: CODE } });
  await check('signed-out');
  const s = b.as('s', 'Research');
  await s.text('navigate', { url: b.base + '/second.html' });
  // No tool is about the account, and the chrome's request is not one a session can make.
  assert.ok(!TOOLS.some((t) => /claude|account|sign|auth|login/i.test(t.name)));
  await assert.rejects(s.call('claude', { do: 'sign-in' }));
  await assert.rejects(s.call('claude:sign-in', {}));
  await pause(300);
  assert.equal((await account()).signIn, null);
  // Its pages have no bridge to ask through.
  assert.equal(await s.text('evaluate', { code: 'typeof loui' }), '"undefined"');

  // The owner signs in: the session's tools show nothing of it.
  const calls = fake().calls.filter((c) => c.startsWith('auth login')).length;
  await press('account-sign-in');
  await until(() => tabWith(url), 'the sign-in page');
  assert.equal(fake().calls.filter((c) => c.startsWith('auth login')).length, calls + 1);
  const seen = [await s.text('tabs', {}), await s.text('snapshot', {}), await s.text('console_logs', {}), await s.text('network_requests', {})].join('\n');
  assert.ok(!seen.includes('sign-in=') && !seen.includes('done.html'), seen);
  await until(async () => (await card()).code, 'the code field');
  await paste(CODE);
  await until(async () => (await account()).state === 'ready' && !(await account()).signIn, 'the sign-in to finish');
  const after = [await s.text('tabs', {}), await s.text('snapshot', {}), await s.text('console_logs', {})].join('\n');
  assert.ok(!after.includes(CODE) && !after.includes(EMAIL) && !after.includes('sign-in='), after);
  s.end();
  await closeTab(url);
});

test('nothing of the account, the sign-in page or the code is written to the profile', async () => {
  // The settings, the history, the tabs to bring back and the sessions' log are written as Loui quits.
  await b.ui('go', b.base + '/second.html');
  await until(async () => (await b.state()).tabs.find((t) => t.active && !t.loading && t.url === b.base + '/second.html'), 'a page');
  await b.close();
  b = null;
  const found = [];
  const walk = (folder) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      // Chromium's own cache of the pages the owner loads, the sign-in page among them, is not Loui's writing.
      if (entry.isDirectory()) { if (!/^(Cache|Code Cache)$/.test(entry.name)) walk(file); continue; }
      if (!entry.isFile()) continue;
      const text = fs.readFileSync(file, 'latin1');
      for (const secret of [EMAIL, CODE, 'sign-in=', 'Example Org', 'sk-ant-not-a-real-key']) if (text.includes(secret)) found.push(`${secret} in ${path.relative(home, file)}`);
    }
  };
  walk(home);
  assert.deepEqual(found, []);
  // What was visited in the ordinary way is there, so the search above could have found something.
  assert.ok(fs.readFileSync(path.join(home, 'history.json'), 'utf8').includes('second.html'));
  const settings = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'));
  assert.ok(!Object.keys(settings).some((k) => /claude|account/i.test(k)));
});
