// What Loui does the Linux way: the default browser through xdg-settings,
// "Open Loui when I sign in" as an XDG autostart entry, and finding an
// installed Claude Code when the desktop gave Loui a short PATH. The tools of
// the system are stood in for (test/fixture/xdg-settings, a folder for the
// autostart entry): the real ones are met by the installed package in
// test/integration/debian.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launch } = require('./drive');
const { findClaude } = require('../src/main/claude-path');

const linux = { skip: process.platform === 'linux' ? false : 'Linux only' };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loui-linux-'));
const stateFile = path.join(dir, 'default-browser');
const autostart = path.join(dir, 'autostart dir'); // a space, as a home folder may have
let b;
test.before(async () => {
  if (linux.skip) return;
  b = await launch({
    LOUI_XDG_SETTINGS: path.join(__dirname, 'fixture', 'xdg-settings'), LOUI_XDG_STATE: stateFile, LOUI_AUTOSTART_DIR: autostart,
  });
});
test.after(async () => {
  await b?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what, ms = 10000) {
  for (const end = Date.now() + ms; Date.now() < end; await pause(100)) {
    const got = await check();
    if (got) return got;
  }
  assert.fail(`timed out waiting for ${what}`);
}
const js = (code) => b.ui('settings:js', code);
// The window asks the system when it opens.
async function open() {
  if ((await b.ui('settings:state')).open) {
    await b.ui('settings:close');
    await until(async () => !(await b.ui('settings:state')).open, 'the Settings window to close');
  }
  await b.ui('settings:open');
  await until(() => js("!!document.querySelector('#set-theme option')").catch(() => false), 'the Settings window to draw');
}
const row = (id) => js(`(() => {
  const r = document.querySelector('[data-setting="${id}"]');
  const c = document.getElementById('set-${id}');
  return { hidden: r.hidden, value: r.querySelector('.st-value')?.textContent ?? null, control: c ? (c.type === 'checkbox' ? c.checked : c.hidden) : null };
})()`);

test('Settings says whether Loui is the default browser, and makes it so with xdg-settings', linux, async () => {
  await open();
  const before = await row('default-browser');
  assert.equal(before.value, 'Loui is not your default browser.');
  assert.equal(before.control, false, 'the button is offered');
  await js("document.getElementById('set-default-browser').click()");
  await until(async () => (await row('default-browser')).value === 'Loui is your default browser.', 'Settings to say it is the default');
  assert.equal(fs.readFileSync(stateFile, 'utf8').trim(), 'loui.desktop');
  assert.equal((await row('default-browser')).control, true, 'and the button goes');
  // Changed elsewhere (the desktop's own settings): seen when the window is next asked about.
  fs.writeFileSync(stateFile, 'firefox-esr.desktop\n');
  await open();
  await until(async () => (await row('default-browser')).value === 'Loui is not your default browser.', 'Settings to notice the change');
});

test('"Open Loui when I sign in" writes an autostart entry, and removes it', linux, async () => {
  const file = path.join(autostart, 'loui.desktop');
  const login = await row('login');
  assert.equal(login.hidden, false);
  assert.equal(login.control, false);
  await js("document.getElementById('set-login').click()");
  await until(() => fs.existsSync(file), 'the entry to be written');
  const entry = fs.readFileSync(file, 'utf8');
  assert.match(entry, /^\[Desktop Entry\]\nType=Application\nName=Loui\n/);
  const exec = entry.match(/^Exec=(.*)$/m)[1];
  assert.match(exec, /^"[^"]+" --$/, 'the program quoted, and `--` so that nothing after it is a switch');
  assert.ok(fs.existsSync(exec.slice(1, exec.indexOf('"', 1))), 'it names a program that exists');
  await until(async () => (await row('login')).control === true, 'the switch to be on');
  // Switched off in the desktop's own list of startup programs: Loui says off too.
  fs.writeFileSync(file, entry + 'Hidden=true\n');
  await open();
  await until(async () => (await row('login')).control === false, 'the switch to follow the file');
  await js("document.getElementById('set-login').click()");
  await until(async () => (await row('login')).control === true && !/Hidden/.test(fs.readFileSync(file, 'utf8')), 'on again, written afresh');
  await js("document.getElementById('set-login').click()");
  await until(() => !fs.existsSync(file), 'the entry to be removed');
});

test('an installed Claude Code is found where PATH does not reach', linux, async () => {
  const home = path.join(dir, 'höme of ana'); // not ASCII, and a space
  const program = (...parts) => {
    const file = path.join(...parts);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '#!/bin/sh\n', { mode: 0o755 });
    return file;
  };
  const env = { PATH: '/nowhere:relative/dir:', SHELL: '/nowhere/sh' };
  // Nothing anywhere. (/usr/local/bin and /usr/bin are looked in too: this machine may have one there.)
  const system = ['/usr/local/bin/claude', '/usr/bin/claude', '/opt/homebrew/bin/claude'].find((p) => fs.existsSync(p)) || null;
  assert.equal(await findClaude({ env, home }), system);
  if (system) return; // the rest is about a machine without one

  // Where the user's shell keeps it (nvm, say): asked of a login shell.
  const nvm = program(home, '.nvm', 'versions', 'node', 'v22', 'bin', 'claude');
  const shell = path.join(dir, 'shell');
  fs.writeFileSync(shell, `#!/bin/sh\n[ "$1" = "-lic" ] || exit 1\necho "a line from the profile"\nPATH="${path.dirname(nvm)}:/usr/bin"\neval "$2"\n`, { mode: 0o755 });
  assert.equal(await findClaude({ env: { ...env, SHELL: shell }, home }), nvm);
  // A file that cannot be run is not it.
  fs.mkdirSync(path.join(home, '.npm-global', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(home, '.npm-global', 'bin', 'claude'), '', { mode: 0o644 });
  assert.equal(await findClaude({ env, home }), null);
  // npm's global folder, then the native installer's, then PATH: each wins over the one before.
  fs.chmodSync(path.join(home, '.npm-global', 'bin', 'claude'), 0o755);
  assert.equal(await findClaude({ env, home }), path.join(home, '.npm-global', 'bin', 'claude'));
  const local = program(home, '.local', 'bin', 'claude');
  assert.equal(await findClaude({ env, home }), local);
  const onPath = program(dir, 'on path', 'claude');
  assert.equal(await findClaude({ env: { ...env, PATH: `/nowhere:${path.dirname(onPath)}` }, home }), onPath);
});
