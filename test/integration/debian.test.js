// Loui as it is shipped for Debian: the .deb, the installed app, updates, the
// relay's package and service, a Loui with no screen, and removal. Runs on
// GitHub's runner inside a Debian container with systemd (see
// .github/workflows/integration.yml and test/integration/debian/), which is
// thrown away afterwards.
//
//   install     apt install ./loui_<v>_amd64.deb; files, sandbox helper, desktop entry, icons
//   drive       the installed /opt/Loui/loui on a virtual display with a window manager
//   desktop     the frameless window under the window manager; default browser; autostart
//   restart     tabs restored, the start page; what is kept where there is no keyring
//   relay       apt install ./loui-relay_<v>_all.deb; its service; a headless Loui as a
//               service, driven by an MCP session through the relay; upgrade, remove, purge
//   update      a newer .deb on a local server: the command to run where nothing can ask
//               for a password; "Restart to update" through polkit; a package changed by apt
//   remove      apt remove; what is left
//
// NEVER on a machine anyone uses. Installing and removing packages, starting
// services and changing the default browser act on the real system: those
// steps run only on a GitHub-hosted runner, and that is checked below, not
// left to whoever runs this (as in windows.test.js, where a test of the
// uninstaller once deleted the owner's installed copy). Elsewhere the file
// only drives an installed copy it is pointed at, on a profile of its own in
// the temp directory, with the updater pointed at nothing.
//
//   LOUI_INTEGRATION_ALLOW=1     outside CI: yes, drive the copy at LOUI_INTEGRATION_EXE
//   LOUI_INTEGRATION_EXE         the installed program (default /opt/Loui/loui)
//   LOUI_INTEGRATION_DEB         CI only: the package to install
//   LOUI_INTEGRATION_UPDATE      CI only: a folder with a newer package and its latest-linux.yml
//   LOUI_INTEGRATION_RELAY_DEB   CI only: the relay's package
//   LOUI_INTEGRATION_RELAY_NEXT  CI only: a newer one, to upgrade to
//   LOUI_INTEGRATION_HEADLESS    CI only: the user the headless Loui runs as (not the one running this)
//   LOUI_INTEGRATION_OUT         where screenshots go
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFile, execFileSync, spawn } = require('child_process');
const { launch, attach, serveFixture } = require('../drive');
const { sleep, until, helpers, driveChecks, tabsToComeBackTo, startPageCheck } = require('./checks');

const env = process.env;
const hosted = env.CI === 'true' && env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted';
const refuse = (why) => { console.error(`\ntest/integration/debian.test.js: ${why}\n`); process.exit(1); };
if (process.platform !== 'linux') refuse('this file drives the Debian package; run it on Linux.');
if (!hosted && env.LOUI_INTEGRATION_ALLOW !== '1') {
  refuse('refusing to run: this is not a GitHub-hosted runner. To drive an installed copy on this machine (nothing is installed, updated or '
    + 'removed, and the profile is a temporary one), set LOUI_INTEGRATION_ALLOW=1 and LOUI_INTEGRATION_EXE.');
}
if (!hosted && (env.LOUI_INTEGRATION_DEB || env.LOUI_INTEGRATION_UPDATE || env.LOUI_INTEGRATION_RELAY_DEB)) {
  refuse('refusing to install, update or remove packages outside a GitHub-hosted runner: they act on the real system. Unset '
    + 'LOUI_INTEGRATION_DEB, LOUI_INTEGRATION_UPDATE and LOUI_INTEGRATION_RELAY_DEB to drive an installed copy only.');
}
if (!hosted && !env.LOUI_INTEGRATION_EXE) refuse('set LOUI_INTEGRATION_EXE to the installed program to drive (/opt/Loui/loui).');
if (process.getuid() === 0) refuse('run this as an ordinary user who may use sudo without a password: Chromium does not run as root.');

const exe = env.LOUI_INTEGRATION_EXE || '/opt/Loui/loui';
const deb = hosted ? env.LOUI_INTEGRATION_DEB : null;
const updateDir = hosted ? env.LOUI_INTEGRATION_UPDATE : null;
const relayDeb = hosted ? env.LOUI_INTEGRATION_RELAY_DEB : null;
const relayNext = hosted ? env.LOUI_INTEGRATION_RELAY_NEXT : null;
const headlessUser = hosted ? env.LOUI_INTEGRATION_HEADLESS : null;
const outDir = env.LOUI_INTEGRATION_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'loui-integration-out-'));
// On the runner, the profile is where an installed Loui keeps it. Anywhere else, a temporary one.
const home = hosted ? path.join(os.homedir(), '.config', 'loui') : fs.mkdtempSync(path.join(os.tmpdir(), 'loui-integration-'));
const versionOf = (file) => path.basename(file).match(/_(\d[^_]*)_(amd64|arm64|all)\.deb$/)?.[1];
const DISPLAY = ':93';

const run = (cmd, args = [], more = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, DISPLAY }, ...more }).trim();
// What a command printed, or '' if it failed.
const say = (cmd, args) => { try { return run(cmd, args); } catch { return ''; } };
const sudo = (...args) => run('sudo', ['-n', ...args]);
const apt = (...args) => sudo('env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get', '-y', ...args);
const installed = (name = 'loui') => say('dpkg-query', ['-W', '-f', '${db:Status-Abbrev}${Version}', name]).replace(/^ii /, '');
// This user's Loui processes (the headless one is another user's).
const louis = () => say('ps', ['-u', String(process.getuid()), '-o', 'pid=,args=']).split('\n').filter((l) => l.includes(`${exe} `) || l.endsWith(exe));

// A picture of the whole screen: of a failure nobody was there to see, or of
// something a person should look at (kept with the run's logs).
let shots = 0;
function screenshot(name) {
  try {
    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, `${String(++shots).padStart(2, '0')}-${name.replace(/[^\w]+/g, '-').slice(0, 60)}.png`);
    run('import', ['-window', 'root', file]);
    console.log(`# screenshot: ${file}`);
  } catch (e) {
    console.log(`# no screenshot: ${e.message.split('\n')[0]}`);
  }
}
const step = (name, options, fn) => {
  if (typeof options === 'function') { fn = options; options = {}; }
  test(name, options, async (t) => {
    try {
      await fn(t);
    } catch (e) {
      screenshot(name);
      throw e;
    }
  });
};
const ciOnly = (have) => ({ skip: have ? false : 'only on a GitHub-hosted runner, with the packages built by the workflow' });

let site; // the fixture pages, at one address for the whole run (restored tabs load from it)
let base;
let b; // the running app
let display = []; // the virtual display and its window manager, if this file started them
const appEnv = (more = {}) => ({
  DISPLAY,
  // Never GitHub: a copy that found a real update would offer to install it.
  LOUI_UPDATE_URL: 'http://127.0.0.1:1/nothing-here',
  ...more,
});
async function start(more) {
  b = await launch(appEnv(more), { home, exe });
  return b;
}
// Quits as the user does, by closing the windows, so that what is written on the way out is written.
async function quit(app = b) {
  if (app === b) b = null;
  for (const w of await app.ui('windows')) app.ui('window:close', w.id).catch(() => {});
  await Promise.race([app.exited || app.closed, sleep(20000)]);
  if (app.close) await app.close(); else app.hangUp();
  await until('its processes to be gone', () => louis().length === 0, 20000);
  await sleep(500);
}
const { onScreen, mine, visit, js } = helpers(() => b);
// A Loui that started itself (after an update): its socket appears when it is up.
async function attachWhenUp() {
  await until('Loui to open again', () => fs.existsSync(path.join(home, 'loui.sock')), 90000);
  return attach(home, 60000);
}

test.before(async () => {
  site = await serveFixture();
  base = `http://127.0.0.1:${site.address().port}`;
  // A display to draw on, with a window manager as a desktop has (Xfce's).
  const xvfb = spawn('Xvfb', [DISPLAY, '-screen', '0', '1600x1000x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
  await sleep(1500);
  const wm = spawn('dbus-run-session', ['--', 'xfwm4', '--compositor=off'], { stdio: 'ignore', env: { ...env, DISPLAY } });
  display = [wm, xvfb];
  await until('the window manager', () => /window id/.test(say('xprop', ['-root', '_NET_SUPPORTING_WM_CHECK'])), 20000);
  console.log(`# ${hosted ? 'GitHub-hosted runner' : 'driving only'}; ${say('sh', ['-c', '. /etc/os-release; echo "$PRETTY_NAME"'])}; Loui at ${exe}; profile ${home}`);
});
test.after(async () => {
  await b?.close().catch(() => {});
  site?.close();
  for (const p of display) p.kill();
  if (!hosted) { try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {} }
});

// ── install ──────────────────────────────────────────────────────────────────
step('apt installs the package and everything it depends on', ciOnly(deb), async () => {
  assert.ok(!fs.existsSync(exe), 'nothing is installed yet');
  assert.ok(!fs.existsSync(home), 'and there is no profile yet');
  console.log(`# ${path.basename(deb)}: ${(fs.statSync(deb).size / 1e6).toFixed(1)} MB; ${run('dpkg-deb', ['-f', deb, 'Depends', 'Suggests']).replace(/\n/g, '; ')}`);
  sudo('apt-get', 'update', '-qq');
  const started = Date.now();
  apt('install', '--no-install-recommends', deb);
  console.log(`# installed in ${Math.round((Date.now() - started) / 1000)} s`);
  assert.equal(installed(), versionOf(deb));
  assert.equal(fs.realpathSync('/usr/bin/loui'), exe, 'loui on PATH is the installed program');
  assert.ok(fs.existsSync('/opt/Loui/resources/app.asar'));
  assert.equal(fs.readFileSync('/opt/Loui/resources/package-type', 'utf8').trim(), 'deb', 'the updater is told it is a .deb');
  const missing = run('ldd', [exe]).split('\n').filter((l) => l.includes('not found'));
  assert.deepEqual(missing, [], 'every library the program links is installed');
  assert.match(run('fc-match', ['monospace']), /\S/, 'and there is a font for pages to use');
  assert.equal(louis().length, 0, 'installing does not start Loui');
});

// Whether an ordinary user may make a user namespace here: Chromium's sandbox
// uses one if so, and its setuid helper if not.
// (Mapping root inside it is the part AppArmor's restriction on Ubuntu, which
// the runner is, refuses: the namespace alone is still made there.)
const userns = () => { try { run('unshare', ['--user', '--map-root-user', 'true']); return true; } catch { return false; } };

step('the sandbox helper is root\'s and setuid, for systems where user namespaces are refused', ciOnly(deb), async () => {
  const st = fs.statSync('/opt/Loui/chrome-sandbox');
  assert.equal(st.uid, 0);
  assert.equal(st.gid, 0);
  assert.equal(st.mode & 0o7777, 0o4755, (st.mode & 0o7777).toString(8));
});

step('the desktop entry is valid and says what Loui opens; the icons are in place', ciOnly(deb), async () => {
  const file = '/usr/share/applications/loui.desktop';
  run('desktop-file-validate', [file]); // exits with 1 and says why if it is not valid
  const entry = Object.fromEntries(fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  assert.equal(entry.Exec, `${exe} -- %U`, 'links follow `--`, so none can be read as a switch');
  assert.equal(entry.Icon, 'loui');
  assert.equal(entry.StartupWMClass, 'loui');
  assert.equal(entry.Name, 'Loui');
  assert.ok(entry.Categories.split(';').includes('WebBrowser'), entry.Categories);
  for (const type of ['x-scheme-handler/http', 'x-scheme-handler/https', 'text/html']) assert.ok(entry.MimeType.split(';').includes(type), `${type} in ${entry.MimeType}`);
  for (const size of [16, 24, 32, 48, 64, 128, 256, 512]) {
    const png = fs.readFileSync(`/usr/share/icons/hicolor/${size}x${size}/apps/loui.png`);
    assert.equal(png.toString('latin1', 1, 4), 'PNG');
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [size, size]);
  }
});

step('the headless service\'s unit is installed and well formed', ciOnly(deb), async () => {
  assert.ok(fs.existsSync('/usr/lib/systemd/system/loui-headless@.service'));
  // xvfb is only suggested by the package: the unit says so itself when it is missing.
  const out = run('sh', ['-c', `systemd-analyze verify loui-headless@${os.userInfo().username}.service 2>&1 || true`]);
  assert.ok(!/loui-headless/.test(out), out);
});

// ── drive ────────────────────────────────────────────────────────────────────
step('the installed app starts, sandboxed, and serves its socket', async () => {
  assert.ok(fs.existsSync(exe), `${exe} is installed`);
  await start();
  const s = await b.state();
  assert.equal(s.tabs.length, 1);
  assert.match(s.update?.current || '', /^\d+\.\d+\.\d+/, 'it is the packaged app (a checkout has no updater), and says which version');
  if (deb) assert.equal(s.update.current, versionOf(deb));
  assert.equal(s.link.status, 'off', 'no relay');
  const procs = louis();
  assert.ok(procs.length >= 4, procs.join('\n'));
  assert.ok(!procs.some((l) => l.includes('--no-sandbox')), 'no process runs without the sandbox');
  const renderer = procs.find((l) => l.includes('--type=renderer')).trim().split(/\s+/)[0];
  assert.match(fs.readFileSync(`/proc/${renderer}/status`, 'utf8'), /^Seccomp:\s+2$/m, 'a renderer is confined (seccomp filter)');
  // Which of Chromium's two sandboxes holds it depends on the system, and both must work as installed.
  const helper = say('ps', ['-u', String(process.getuid()), '-o', 'args=']).split('\n').some((l) => l.startsWith('/opt/Loui/chrome-sandbox '));
  console.log(`# sandbox: ${helper ? 'the setuid helper (this system refuses user namespaces to ordinary users)' : 'user namespaces'}`);
  if (deb) assert.equal(helper, !userns());
});

step('its window carries the class the desktop entry names, so a dock groups them', async () => {
  const id = await until('the window', () => say('xdotool', ['search', '--name', ' Loui$']).split('\n')[0]);
  assert.match(run('xprop', ['-id', id, 'WM_CLASS']), /= "loui", "loui"$/);
});

driveChecks({ step, app: () => b, base: () => base });

// ── the desktop ──────────────────────────────────────────────────────────────
step('the window has no frame but its own, and the window manager moves, maximizes and restores it', async () => {
  const id = say('xdotool', ['search', '--name', ' Loui$']).split('\n')[0];
  const x = (...args) => run('xdotool', args.map(String));
  const geometry = () => Object.fromEntries(x('getwindowgeometry', '--shell', id).split('\n').map((l) => l.split('=')).map(([k, v]) => [k, Number(v)]));
  const maximized = () => /MAXIMIZED_VERT/.test(run('xprop', ['-id', id, '_NET_WM_STATE']));
  x('windowsize', id, 1100, 700);
  x('windowmove', id, 140, 100);
  await until('the window to be placed', () => { const g = geometry(); return g.X === 140 && g.WIDTH === 1100; });
  assert.match(run('xprop', ['-id', id, '_MOTIF_WM_HINTS']), /= 0x2, 0x0, 0x0,/, 'it asks the window manager for no decorations');
  screenshot('the window under xfwm4');
  // The empty end of the tab strip is the title bar: a double click maximizes, another restores.
  const bar = () => { const g = geometry(); return [g.X + g.WIDTH - 260, g.Y + 20]; };
  x('mousemove', ...bar(), 'click', '--repeat', 2, '--delay', 80, 1);
  await until('a double click to maximize it', maximized);
  screenshot('maximized');
  x('mousemove', ...bar(), 'click', '--repeat', 2, '--delay', 80, 1);
  await until('another to restore it', () => !maximized() && geometry().WIDTH === 1100);
  // Dragging it there moves the window.
  const [bx, by] = bar();
  x('mousemove', bx, by, 'mousedown', 1);
  for (const d of [30, 60, 90]) { await sleep(150); x('mousemove', bx + d, by + d / 2); }
  await sleep(300);
  x('mouseup', 1);
  await until('the drag to move it', () => { const g = geometry(); return g.X >= 200 && g.Y >= 125 && g.WIDTH === 1100; });
  // The window's own buttons, drawn at the right end of that row: the middle one maximizes.
  const g = geometry();
  x('mousemove', g.X + g.WIDTH - 60, g.Y + 20, 'click', 1);
  await until('the maximize button to maximize it', maximized);
  const full = geometry();
  x('mousemove', full.X + full.WIDTH - 60, full.Y + 20, 'click', 1);
  await until('and to restore it', () => !maximized());
});

step('Settings makes Loui the default browser, and a link from another app opens in a new tab', ciOnly(deb), async () => {
  // Another browser, as far as the system knows, and the default one.
  const apps = path.join(os.homedir(), '.local', 'share', 'applications');
  fs.mkdirSync(apps, { recursive: true });
  fs.writeFileSync(path.join(apps, 'other-browser.desktop'), '[Desktop Entry]\nType=Application\nName=Other\nExec=/bin/true %U\n'
    + 'Categories=Network;WebBrowser;\nMimeType=x-scheme-handler/http;x-scheme-handler/https;text/html;\n');
  run('xdg-settings', ['set', 'default-web-browser', 'other-browser.desktop']);
  assert.equal(run('xdg-settings', ['get', 'default-web-browser']), 'other-browser.desktop');
  await b.ui('settings:open');
  const general = async () => (await b.ui('settings:state')).state.general;
  await until('Settings to say it is not the default', async () => { const d = (await general()).defaultBrowser; return d.can && !d.isDefault; });
  await b.ui('settings:act', { what: 'default-browser' });
  await until('Settings to say it is', async () => (await general()).defaultBrowser.isDefault);
  assert.equal(run('xdg-settings', ['get', 'default-web-browser']), 'loui.desktop');
  assert.equal(run('xdg-mime', ['query', 'default', 'x-scheme-handler/https']), 'loui.desktop');
  await b.ui('settings:close');
  // As another app opens a link: the system starts `loui -- <link>`, which hands it to the Loui that is running.
  const link = `${base}/second.html?from=another-app`;
  spawn('xdg-open', [link], { stdio: 'ignore', env: { ...env, DISPLAY, LOUI_HOME: home }, detached: true }).unref();
  const tab = await until('the link to open in a tab', async () => (await mine()).find((t) => t.url === link), 30000);
  assert.equal((await onScreen()).id, tab.id, 'and it is the tab on screen');
  await b.ui('tab:close', tab.id);
});

step('"Open Loui when I sign in" is an autostart entry the desktop accepts', ciOnly(deb), async () => {
  const file = path.join(os.homedir(), '.config', 'autostart', 'loui.desktop');
  assert.ok(!fs.existsSync(file));
  await b.ui('settings:open');
  assert.deepEqual((await b.ui('settings:state')).state.general.login, { on: false });
  await b.ui('settings:act', { what: 'login', arg: true });
  assert.deepEqual((await b.ui('settings:state')).state.general.login, { on: true });
  run('desktop-file-validate', [file]);
  assert.match(fs.readFileSync(file, 'utf8'), new RegExp(`^Exec="${exe}" --$`, 'm'));
  await b.ui('settings:act', { what: 'login', arg: false });
  assert.ok(!fs.existsSync(file), 'switched off, the entry is gone');
  await b.ui('settings:close');
});

// ── no keyring, and a restart ────────────────────────────────────────────────
const RELAY_KEY = 'integration-relay-key-7f3a';
let before; // the user's tabs when Loui was quit

step('with no keyring: no password is saved, the relay key is a file only this user can read, and Settings says so', async (t) => {
  const prefs = (await b.ui('settings:state')).state.passwords;
  if (prefs.available) return t.skip('this system has a keyring Loui can use');
  assert.match(prefs.why, /so it (can't encrypt passwords, and it )?doesn't save them/);
  assert.match(prefs.plain, /relay key .* plain files that only your user account can read/);
  await visit(base + '/login.html');
  await sleep(300); // the page script goes in at DOM ready
  await js(`(() => {
    document.getElementById('user').value = 'ana@example.com';
    document.getElementById('pass').value = 'integration-Secret!42';
    document.getElementById('form').requestSubmit();
  })()`);
  await sleep(2500);
  assert.equal((await b.state()).passwords.offer, null, 'no offer to save it');
  assert.ok(!fs.existsSync(path.join(home, 'passwords.json')) || JSON.parse(fs.readFileSync(path.join(home, 'passwords.json'), 'utf8')).logins.length === 0);
  // The relay's address and key, as entered in Settings (switched off: there is no relay here).
  await b.ui('relay:set', { url: 'http://127.0.0.1:9', key: RELAY_KEY, on: false });
  const file = path.join(home, 'relay.json');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).key, RELAY_KEY);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(home).mode & 0o077, 0, 'the profile is closed to other users');
});

step('Loui quits when its last window closes, leaving the user\'s tabs to come back to', async () => {
  before = await tabsToComeBackTo({ app: () => b, base: () => base });
  await quit();
  // From now on a new tab opens the start page, as it does for the user (the tests' default is a blank one).
  const file = path.join(home, 'settings.json');
  const settings = (() => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } })();
  fs.writeFileSync(file, JSON.stringify({ ...settings, newTab: 'start' }));
});

step('after a restart: the tabs are back, and the relay key', async () => {
  await start();
  const tabs = await until('the tabs to come back', async () => { const l = await mine(); return l.length === before.length && l; });
  assert.deepEqual(tabs.map((t) => t.url), before);
  const link = (await b.state()).link;
  if (fs.existsSync(path.join(home, 'relay.json'))) {
    assert.equal(link.hasKey, true, 'the relay key was read back');
    assert.equal(link.url, 'http://127.0.0.1:9');
  }
});

step('a new tab shows the start page', async () => {
  await startPageCheck({ app: () => b });
  await quit();
});

// ── the relay, and a Loui with no screen ─────────────────────────────────────
const RELAY = 'http://127.0.0.1:7332';
const relayKey = () => sudo('cat', '/var/lib/loui-relay/key');
const active = (unit) => say('systemctl', ['is-active', unit]);
// A Claude session, as far as the relay can tell: MCP over HTTP with the key.
async function mcpSession() {
  const key = relayKey();
  let id = 0, session = null;
  const post = async (body) => {
    const res = await fetch(`${RELAY}/mcp`, {
      method: 'POST', body: JSON.stringify(body),
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}) },
    });
    session ||= res.headers.get('mcp-session-id');
    const text = await res.text();
    if (!body.id) return null;
    assert.equal(res.status, 200, text);
    const data = /^data: /m.test(text) ? text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6))).find((m) => m.id === body.id) : JSON.parse(text);
    if (data.error) throw new Error(data.error.message);
    return data.result;
  };
  const hello = await post({ jsonrpc: '2.0', id: ++id, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'Debian integration test', version: '1' } } });
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const call = async (name, args = {}) => {
    const r = await post({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } });
    return { ...r, text: r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') };
  };
  const end = () => fetch(`${RELAY}/mcp`, { method: 'DELETE', headers: { authorization: `Bearer ${key}`, 'mcp-session-id': session } }).catch(() => {});
  return { hello, call, end };
}

step('the relay\'s package installs, and its service runs as a user of its own, for this machine only', ciOnly(relayDeb), async () => {
  apt('install', '--no-install-recommends', relayDeb);
  assert.equal(installed('loui-relay'), versionOf(relayDeb));
  console.log(`# ${path.basename(relayDeb)}: ${(fs.statSync(relayDeb).size / 1e6).toFixed(1)} MB; ${run('dpkg-deb', ['-f', relayDeb, 'Depends'])}; ${say('node', ['--version']) || say('nodejs', ['--version'])} from Debian`);
  await until('the service to be running', () => active('loui-relay') === 'active', 30000);
  assert.equal(say('systemctl', ['is-enabled', 'loui-relay']), 'enabled', 'and it starts with the machine');
  const pid = run('systemctl', ['show', '-p', 'MainPID', '--value', 'loui-relay']);
  assert.equal(run('ps', ['-o', 'user=', '-p', pid]), 'loui-relay');
  assert.equal(run('sh', ['-c', 'systemd-analyze verify /usr/lib/systemd/system/loui-relay.service 2>&1 || true']), '', 'systemd finds nothing wrong with the unit');
  console.log(`# systemd-analyze security loui-relay: ${say('sh', ['-c', 'systemd-analyze security loui-relay.service --no-pager | tail -1'])}`);
  // Its home is its own: the key is made on first start, for it alone to read.
  await until('the key', () => say('sudo', ['-n', 'stat', '-c', '%U %a', '/var/lib/loui-relay/key']) === 'loui-relay 600', 20000);
  assert.equal(sudo('stat', '-c', '%U %a', '/var/lib/loui-relay'), 'loui-relay 700');
  assert.throws(() => fs.readFileSync('/var/lib/loui-relay/key'), /EACCES/, 'another user cannot read it');
  assert.match(sudo('journalctl', '-u', 'loui-relay', '--no-pager', '-n', '20'), /Loui relay listening on http:\/\/127\.0\.0\.1:7332/, 'its log is in the journal');
  // It answers on this machine, to the key only; not on the network.
  assert.equal((await fetch(`${RELAY}/mcp`, { method: 'POST' })).status, 401);
  const outside = Object.values(os.networkInterfaces()).flat().find((i) => i.family === 'IPv4' && !i.internal)?.address;
  if (outside) await assert.rejects(fetch(`http://${outside}:7332/mcp`, { method: 'POST', signal: AbortSignal.timeout(5000) }), 'nothing listens on the network address');
  const s = await mcpSession();
  assert.equal(s.hello.serverInfo.name, 'loui');
  assert.equal(s.hello.serverInfo.version, versionOf(relayDeb));
  s.end();
});

step('a Loui with no screen runs as a service, and a session uses it through the relay', ciOnly(relayDeb && headlessUser), async (t) => {
  // What the service is told: the relay on this machine, and its key. Root's to read.
  // (LOUI_TEST is this test's hand on its window: see the question below.)
  fs.writeFileSync(path.join(os.tmpdir(), 'loui-headless'), `LOUI_RELAY_URL=${RELAY}\nLOUI_RELAY_KEY=${relayKey()}\nLOUI_TEST=1\n`, { mode: 0o600 });
  sudo('install', '-m', '600', '-o', 'root', path.join(os.tmpdir(), 'loui-headless'), '/etc/default/loui-headless');
  fs.rmSync(path.join(os.tmpdir(), 'loui-headless'));
  const unit = `loui-headless@${headlessUser}`;
  const profile = `/home/${headlessUser}/.config/loui`;
  t.after(() => { try { sudo('systemctl', 'disable', '--now', unit); } catch {} });
  sudo('systemctl', 'enable', '--now', unit);
  await until('the service to be running', () => active(unit) === 'active', 30000);
  const s = await mcpSession();
  const name = os.hostname();
  await until('the browser to sign in to the relay', async () => (await s.call('devices')).text.includes(name), 60000);
  // A new session is asked about in the window ("Let … use Loui?"), here as
  // anywhere, and its call waits. Nobody sees that window: the README says how
  // to answer it once, through the display. This answers as that person would,
  // with "Always allow", over the control socket of the user it runs as.
  const call = s.call('navigate', { url: base });
  const asked = JSON.parse(await new Promise((done, fail) => {
    execFile('sudo', ['-n', '-u', headlessUser, process.execPath, path.join(__dirname, 'debian', 'allow.js'), profile], { encoding: 'utf8' },
      (e, out, err) => (e ? fail(new Error(err || e.message)) : done(out)));
  }));
  assert.equal(asked.kind, 'consent');
  assert.equal(asked.connector.kind, 'key', 'it says the session came with the relay key');
  // The session works in it: a form filled, and a picture of the page (drawn with no GPU, on Xvfb).
  const page = (await call).text;
  const ref = (re) => page.match(re)?.[1] ?? assert.fail(`no ${re} in: ${page}`);
  await s.call('type', { ref: ref(/textbox "Your name" \[(e\d+)\]/), text: 'Ada', clear: true });
  assert.match((await s.call('click', { ref: ref(/button "Greet" \[(e\d+)\]/) })).text, /Hello, Ada/);
  const shot = (await s.call('screenshot')).content.find((c) => c.type === 'image');
  assert.ok(shot && Buffer.from(shot.data, 'base64').length > 2000, 'a screenshot of the page');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'headless-screenshot.png'), Buffer.from(shot.data, 'base64'));
  // The profile is that user's, closed to others; with no keyring the relay key came from the service's settings.
  assert.equal(sudo('stat', '-c', '%U %a', profile), `${headlessUser} 700`);
  const procs = say('ps', ['-u', headlessUser, '-o', 'args=']).split('\n');
  assert.ok(procs.some((l) => l.startsWith('Xvfb ')), 'it draws on a virtual display of its own');
  assert.ok(!procs.some((l) => l.includes('--no-sandbox')), 'and is sandboxed there too');
  s.end();
  // What it takes while nobody uses it.
  await sleep(20000);
  const bytes = Number(run('systemctl', ['show', '-p', 'MemoryCurrent', '--value', unit]));
  console.log(`# the headless Loui, idle with one blank tab: ${Math.round(bytes / 1e6)} MB (the service's cgroup, Xvfb included)`);
  // The relay restarted (as an upgrade does): the browser finds it again.
  sudo('systemctl', 'restart', 'loui-relay');
  await until('the relay to be back', () => active('loui-relay') === 'active', 20000);
  const again = await until('a session after the restart', () => mcpSession().catch(() => null), 20000);
  // (devices lists it while it is away too, as seen before: only a call says it is back.)
  // "Always allow" was kept for the relay key: this session is let in with no question.
  const second = await until('the browser to sign in again, and let the session in unasked', async () => {
    const r = await Promise.race([again.call('navigate', { url: `${base}/second.html` }), sleep(30000).then(() => assert.fail('no answer in 30 s: it was asked about again'))]);
    return /No Loui browser is online/.test(r.text) ? null : r;
  }, 90000);
  assert.match(second.text, /second\.html/);
  again.end();
  sudo('systemctl', 'disable', '--now', unit);
  await until('the headless Loui to stop', () => !say('ps', ['-u', headlessUser, '-o', 'args=']).includes(exe), 30000);

  // Started only when a session asks, as the README sets it up: the relay's
  // user may start that one unit (polkit), and launch.json names the command.
  fs.writeFileSync(path.join(os.tmpdir(), 'loui-headless.rules'), `polkit.addRule(function (action, subject) {
  if (action.id == "org.freedesktop.systemd1.manage-units" && subject.user == "loui-relay" &&
      action.lookup("unit") == "${unit}.service" && action.lookup("verb") == "start") return polkit.Result.YES;
});\n`);
  sudo('install', '-m', '644', path.join(os.tmpdir(), 'loui-headless.rules'), '/etc/polkit-1/rules.d/50-loui-headless.rules');
  sudo('-u', 'loui-relay', 'sh', '-c', `echo '{ "*": "systemctl start ${unit}" }' > /var/lib/loui-relay/launch.json`);
  t.after(() => { try { sudo('rm', '-f', '/etc/polkit-1/rules.d/50-loui-headless.rules', '/var/lib/loui-relay/launch.json'); } catch {} });
  const third = await mcpSession();
  const opened = await Promise.race([third.call('navigate', { url: `${base}/plain.html` }), sleep(60000).then(() => assert.fail('no answer in a minute'))]);
  assert.match(opened.text, /plain\.html/, 'with no browser online, the relay started one for the session');
  assert.equal(active(unit), 'active');
  third.end();
  sudo('systemctl', 'stop', unit);
  await until('the headless Loui to stop', () => !say('ps', ['-u', headlessUser, '-o', 'args=']).includes(exe), 30000);
});

step('the relay keeps its key through an upgrade and a removal; a purge takes everything', ciOnly(relayDeb && relayNext), async () => {
  const key = relayKey();
  apt('install', '--no-install-recommends', relayNext);
  assert.equal(installed('loui-relay'), versionOf(relayNext));
  await until('the new version to be serving', async () => {
    const s = await mcpSession().catch(() => null);
    s?.end();
    return s?.hello.serverInfo.version === versionOf(relayNext);
  }, 30000);
  assert.equal(relayKey(), key, 'the same key');
  apt('remove', 'loui-relay');
  assert.notEqual(active('loui-relay'), 'active');
  await assert.rejects(fetch(`${RELAY}/mcp`, { method: 'POST' }), 'nothing listens any more');
  assert.ok(!fs.existsSync('/usr/lib/loui-relay'));
  assert.equal(relayKey(), key, 'removed, its key and settings stay for a later install');
  assert.ok(fs.existsSync('/etc/default/loui-relay'));
  apt('purge', 'loui-relay');
  assert.equal(say('sudo', ['-n', 'ls', '/var/lib/loui-relay']), '', 'purged, they are gone');
  assert.ok(!fs.existsSync('/etc/default/loui-relay'));
  assert.equal(installed('loui-relay'), '');
});

// ── update ───────────────────────────────────────────────────────────────────
let next; // the version updated to
let feed; // the server the update comes from

step('an update is found and downloaded; with nothing to ask for a password, Loui gives the command instead', ciOnly(updateDir), async () => {
  next = fs.readFileSync(path.join(updateDir, 'latest-linux.yml'), 'utf8').match(/^version: (.+)$/m)[1].trim();
  assert.notEqual(next, versionOf(deb));
  const asked = [];
  feed = http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://x').pathname.slice(1));
    const file = path.join(updateDir, name);
    asked.push(`${req.method} ${name}`);
    if (name.includes('..') || name.includes('/') || !fs.existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { 'content-length': fs.statSync(file).size });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => feed.listen(0, '127.0.0.1', r));
  await start({ LOUI_UPDATE_URL: `http://127.0.0.1:${feed.address().port}/` });
  // The first check is ten seconds after launch.
  const u = await until('the update to be downloaded', async () => {
    const s = (await b.state()).update;
    if (s.status === 'failed') assert.fail(`the updater failed: ${s.error}`);
    return s.status === 'ready' && s;
  }, 5 * 60 * 1000);
  console.log(`# the updater asked the server for: ${asked.join(', ')}`);
  assert.equal(u.version, next);
  // No desktop here, so no polkit agent: Loui does not pretend it can install it.
  const file = path.join(os.homedir(), '.cache', 'loui-updater', 'pending', `loui_${next}_amd64.deb`);
  assert.equal(u.manual, `sudo apt install ${file}`);
  assert.match(u.why, /no polkit agent is running/);
  assert.ok(fs.existsSync(file));
  assert.equal(await b.ui('chrome:eval', "document.getElementById('update').textContent"), 'Update downloaded');
  assert.ok((await b.ui('chrome:eval', "document.getElementById('update').title")).includes(u.manual), 'the button\'s tooltip has the command');
  await b.ui('update:install'); // the button: it opens Settings, where the command can be copied
  await until('Settings › About', async () => (await b.ui('settings:state')).open);
  const words = await until('the words', () => b.ui('settings:js', "document.getElementById('value-updates')?.textContent").catch(() => ''));
  assert.ok(words.includes(u.manual) && words.includes('then restart Loui'), words);
  await until('the About section to be the one on show', async () => (await b.ui('settings:js', 'window.shownForTest().map((s) => s.title).join()')) === 'About');
  assert.equal(await b.ui('settings:js', "document.getElementById('set-update-install').hidden"), true, 'and no "Restart to update" that could not work');
  screenshot('update with no polkit agent');
  await b.ui('settings:close');
  assert.equal(installed(), versionOf(deb), 'nothing was installed');
  await quit();
  assert.equal(installed(), versionOf(deb), 'nor when Loui quit');
});

step('where polkit allows it, "Restart to update" installs the package and opens Loui again with its tabs', ciOnly(updateDir), async () => {
  // A rule in place of the desktop's password prompt, which nobody is here to answer.
  fs.writeFileSync(path.join(os.tmpdir(), 'loui-test.rules'),
    `polkit.addRule(function (action, subject) { if (action.id == "org.freedesktop.policykit.exec" && subject.user == "${os.userInfo().username}") return polkit.Result.YES; });\n`);
  sudo('install', '-m', '644', path.join(os.tmpdir(), 'loui-test.rules'), '/etc/polkit-1/rules.d/49-loui-test.rules');
  sudo('systemctl', 'restart', 'polkit');
  await start({ LOUI_UPDATE_URL: `http://127.0.0.1:${feed.address().port}/` });
  const u = await until('the update to be ready again', async () => { const s = (await b.state()).update; return s.status === 'ready' && s; }, 3 * 60 * 1000);
  assert.equal(u.manual, '', 'Loui can ask for it now');
  assert.equal(await b.ui('chrome:eval', "document.getElementById('update').textContent"), 'Restart to update');
  const tabs = (await mine()).map((t) => t.url);
  assert.deepEqual(tabs, before);
  const old = b;
  b = null;
  const started = Date.now();
  old.ui('update:install').catch(() => {}); // no answer comes: Loui quits
  const code = await Promise.race([old.exited, sleep(3 * 60 * 1000).then(() => 'still running')]);
  const last = code === 'still running' ? await old.state().then((s) => s.update).catch(() => null) : null;
  await old.close();
  assert.notEqual(code, 'still running', `Loui quit to be updated (${JSON.stringify(last)})`);
  assert.equal(installed(), next);
  const again = await attachWhenUp();
  console.log(`# updated and running again ${Math.round((Date.now() - started) / 1000)} s after "Restart to update"`);
  assert.equal((await again.state()).update.current, next, 'the new version is running');
  const back = await until('the tabs to come back', async () => { const l = await mine(again); return l.length === tabs.length && l; });
  assert.deepEqual(back.map((t) => t.url), tabs);
  assert.ok(!louis().some((l) => l.includes('--no-sandbox')));
  await quit(again);
  feed.close();
  feed.closeAllConnections();
  sudo('rm', '/etc/polkit-1/rules.d/49-loui-test.rules');
});

step('a version installed from a terminal while Loui runs is noticed, and a restart finishes it', ciOnly(updateDir), async () => {
  await start();
  assert.equal((await b.state()).update.current, next);
  // As the command Loui gives would, or apt on its own (here back to the first version, which is the one at hand).
  apt('install', '--allow-downgrades', deb);
  const u = await until('Loui to notice', async () => { const s = (await b.state()).update; return s.status === 'installed' && s; }, 60000);
  assert.equal(u.version, versionOf(deb));
  assert.equal(await b.ui('chrome:eval', "document.getElementById('update').textContent"), 'Restart to finish updating');
  const old = b;
  b = null;
  old.ui('update:install').catch(() => {});
  const code = await Promise.race([old.exited, sleep(30000).then(() => 'still running')]);
  await old.close();
  assert.notEqual(code, 'still running');
  const again = await attachWhenUp();
  assert.equal((await again.state()).update.current, versionOf(deb));
  await quit(again);
});

// ── remove ───────────────────────────────────────────────────────────────────
step('apt remove takes the program and leaves the profile alone', ciOnly(deb), async () => {
  assert.equal(louis().length, 0, 'Loui is not running');
  apt('remove', 'loui');
  for (const gone of [exe, '/opt/Loui', '/usr/bin/loui', '/usr/share/applications/loui.desktop', '/usr/share/icons/hicolor/256x256/apps/loui.png',
    '/usr/lib/systemd/system/loui-headless@.service', '/etc/apparmor.d/loui']) {
    assert.ok(!fs.existsSync(gone) && !fs.lstatSync(gone, { throwIfNoEntry: false }), `${gone} is gone`);
  }
  // Removed, dpkg still lists it (state "rc"): the package has a script to run at a purge, and nothing else is left.
  assert.match(installed(), /^rc /);
  assert.deepEqual(say('dpkg', ['-L', 'loui']).split('\n').filter((f) => f && fs.existsSync(f) && !fs.statSync(f).isDirectory()), []);
  apt('purge', 'loui');
  assert.equal(installed(), '', 'purged, dpkg has nothing of it');
  assert.notEqual(say('xdg-settings', ['get', 'default-web-browser']), 'loui.desktop', 'it is no longer the default browser');
  // The profile: tabs, settings, the relay's address.
  for (const file of ['tabs.json', 'settings.json', 'device.json']) assert.ok(fs.existsSync(path.join(home, file)), `${file} is still in the profile`);
  const left = ['.config/loui', '.cache/loui-updater', '.config/autostart/loui.desktop', '.config/mimeapps.list', '.local/share/applications/mimeapps.list']
    .filter((p) => fs.existsSync(path.join(os.homedir(), p)));
  console.log(`# left in the user's home: ${left.join(', ')}`);
  console.log(`# mimeapps.list: ${say('sh', ['-c', 'cat ~/.config/mimeapps.list 2>/dev/null | tr "\\n" " "'])}`);
});
