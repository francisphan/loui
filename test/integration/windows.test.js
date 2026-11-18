// Loui as it is shipped for Windows: the installer, the installed app, an
// update to the next version, and the uninstaller. Runs on GitHub's Windows
// runner (.github/workflows/integration.yml), which is thrown away afterwards.
//
//   install     Loui-Setup-<v>.exe /S; files, uninstall entry, shortcut
//   drive       the installed Loui.exe on its named pipe, as a session and as the user
//   restart     real DPAPI encryption read back, tabs restored, the start page
//   update      a newer installer on a local server, found, downloaded, "Restart to update"
//   uninstall   the uninstaller, silently; the profile is left alone
//
// NEVER on a machine anyone uses. Installing, updating and uninstalling here
// act on the real per-user install of Loui: on its owner's PC a test of the
// uninstaller once deleted his installed copy. So those steps run only on a
// GitHub-hosted runner, and that is checked below, not left to whoever runs
// this. Elsewhere the file only drives an installed copy it is pointed at
// (`npm run test:integration:windows`, see the README), on a profile of its
// own in the temp directory, with the updater pointed at nothing.
//
//   LOUI_INTEGRATION_ALLOW=1     outside CI: yes, drive the copy at LOUI_INTEGRATION_EXE
//   LOUI_INTEGRATION_EXE         the installed Loui.exe (default: where the installer puts it)
//   LOUI_INTEGRATION_INSTALLER   CI only: the installer to install
//   LOUI_INTEGRATION_UPDATE      CI only: a folder with a newer installer and its latest.yml
//   LOUI_INTEGRATION_OUT         where screenshots of failures go
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync, spawn } = require('child_process');
const { launch, attach, serveFixture } = require('../drive');
const { sleep, until, helpers, driveChecks, tabsToComeBackTo, startPageCheck } = require('./checks');
const pkg = require('../../package.json');

const env = process.env;
const hosted = env.CI === 'true' && env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted';
const refuse = (why) => { console.error(`\ntest/integration/windows.test.js: ${why}\n`); process.exit(1); };
if (process.platform !== 'win32') refuse('this file drives the Windows app; run it with Node for Windows.');
if (!hosted && env.LOUI_INTEGRATION_ALLOW !== '1') {
  refuse('refusing to run: this is not a GitHub-hosted runner. To drive an installed copy on this machine (nothing is installed, updated or '
    + 'uninstalled, and the profile is a temporary one), set LOUI_INTEGRATION_ALLOW=1 and LOUI_INTEGRATION_EXE.');
}
if (!hosted && (env.LOUI_INTEGRATION_INSTALLER || env.LOUI_INTEGRATION_UPDATE)) {
  refuse('refusing to run an installer, an update or an uninstaller outside a GitHub-hosted runner. They act on the real '
    + 'install of Loui for this user: a test of the uninstaller once deleted its owner\'s installed copy. Unset '
    + 'LOUI_INTEGRATION_INSTALLER and LOUI_INTEGRATION_UPDATE to drive an installed copy only.');
}
if (!hosted && !env.LOUI_INTEGRATION_EXE) refuse('set LOUI_INTEGRATION_EXE to the Loui.exe to drive.');

const installDir = path.join(env.LOCALAPPDATA || '', 'Programs', 'loui');
const exe = env.LOUI_INTEGRATION_EXE || path.join(installDir, 'Loui.exe');
const installer = hosted ? env.LOUI_INTEGRATION_INSTALLER : null;
const updateDir = hosted ? env.LOUI_INTEGRATION_UPDATE : null;
const outDir = env.LOUI_INTEGRATION_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'loui-integration-out-'));
// On the runner, the profile is where an installed Loui keeps it, so the
// update and the uninstaller meet the real thing. Anywhere else, a temporary one.
const home = hosted ? path.join(env.APPDATA, 'loui') : fs.mkdtempSync(path.join(os.tmpdir(), 'loui-integration-'));
const versionOf = (file) => path.basename(file).match(/^Loui-Setup-(.+)\.exe$/)?.[1];
const shortcut = path.join(env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Loui.lnk');

const ps = (script) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' }).trim();
const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;
// A picture of the whole screen, for a failure nobody was there to see.
let shots = 0;
function screenshot(name) {
  try {
    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, `${String(++shots).padStart(2, '0')}-${name.replace(/[^\w]+/g, '-').slice(0, 60)}.png`);
    ps(`Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $s = [System.Windows.Forms.SystemInformation]::VirtualScreen; `
      + `$b = New-Object System.Drawing.Bitmap $s.Width, $s.Height; $g = [System.Drawing.Graphics]::FromImage($b); `
      + `$g.CopyFromScreen($s.Left, $s.Top, 0, 0, $b.Size); $b.Save(${quote(file)})`);
    console.log(`# screenshot: ${file}`);
  } catch (e) {
    console.log(`# no screenshot: ${e.message.split('\n')[0]}`);
  }
}
// A test that leaves a picture of the screen behind when it fails.
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
const ciOnly = (have) => ({ skip: have ? false : 'only on a GitHub-hosted runner, with the installers built by the workflow' });

// What Windows knows about the installed Loui: its entry under "Installed apps".
function uninstallEntry() {
  const out = ps("$e = Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | "
    + "Where-Object { $_.DisplayName -like 'Loui*' } | Select-Object DisplayName, DisplayVersion, UninstallString, QuietUninstallString, InstallLocation, DisplayIcon; "
    + 'if ($e) { ConvertTo-Json @($e) -Compress } else { \'[]\' }');
  return JSON.parse(out);
}
const regValue = (key, name = '(default)') => ps(`$k = Get-Item -LiteralPath ${quote('Registry::' + key)} -ErrorAction SilentlyContinue; if ($k) { $k.GetValue(${name === '(default)' ? "''" : quote(name)}) }; exit 0`);
const running = () => ps("@(Get-Process -Name 'Loui' -ErrorAction SilentlyContinue | Where-Object { $_.Path -like " + quote(installDir + '\\*') + ' }).Count') | 0;
const fileVersion = (file) => ps(`(Get-Item -LiteralPath ${quote(file)}).VersionInfo.ProductVersion`);

// An NSIS program checks itself when it starts: a CRC32 over the file from
// byte 512 up to where the checksum is stored. An uninstaller that fails this
// is refused by Windows NSIS, and every uninstall and update with it (the bug
// of 0.1.0; scripts/nowine/wine explains). The same sum, done here.
function nsisChecksum(file) {
  const b = fs.readFileSync(file);
  const sig = Buffer.from('efbeadde4e756c6c736f6674496e7374', 'hex');
  for (let i = b.indexOf(sig); i >= 0; i = b.indexOf(sig, i + 1)) {
    const header = i - 4;
    if (header % 512) continue;
    if (b.readUInt32LE(header) & 4) return { stored: null, computed: null };
    const at = header + b.readUInt32LE(header + 24) - 4;
    return { stored: b.readUInt32LE(at), computed: zlib.crc32(b.subarray(512, at)) >>> 0 };
  }
  throw new Error(`${file} is not an NSIS program`);
}

let site; // the fixture pages, at one address for the whole run (restored tabs load from it)
let base;
let b; // the running app
const appEnv = (more = {}) => ({
  // Never GitHub: a copy that found a real update would install it when it quits.
  LOUI_UPDATE_URL: 'http://127.0.0.1:9/nothing-here',
  ...more,
});
async function start(more) {
  b = await launch(appEnv(more), { home, exe });
  return b;
}
// Quits as the user does, by closing the windows, so that what is written on the way out is written.
async function quit() {
  const app = b;
  b = null;
  for (const w of await app.ui('windows')) app.ui('window:close', w.id).catch(() => {});
  const code = await Promise.race([app.exited, sleep(20000).then(() => 'still running')]);
  await app.close();
  assert.notEqual(code, 'still running', 'Loui quit when its last window closed');
  await until('its processes to be gone', () => !hosted || running() === 0, 20000);
  await sleep(500);
}
const { mine, visit, js } = helpers(() => b);

test.before(async () => {
  site = await serveFixture();
  base = `http://127.0.0.1:${site.address().port}`;
  console.log(`# ${hosted ? 'GitHub-hosted runner' : 'driving only'}; Loui at ${exe}; profile ${home}`);
});
test.after(async () => {
  await b?.close().catch(() => {});
  site?.close();
  if (!hosted) { try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {} }
});

// ── install ──────────────────────────────────────────────────────────────────
step('the installer installs silently, for this user', ciOnly(installer), async () => {
  assert.ok(!fs.existsSync(exe), 'nothing is installed yet');
  assert.ok(!fs.existsSync(home), 'and there is no profile yet');
  const started = Date.now();
  execFileSync(installer, ['/S'], { stdio: 'inherit', timeout: 5 * 60 * 1000 });
  await until('Loui.exe to be there', () => fs.existsSync(exe), 60000);
  console.log(`# installed in ${Math.round((Date.now() - started) / 1000)} s`);
  console.log(`# Loui.exe says it is version ${fileVersion(exe)}`);
  assert.ok(fs.existsSync(path.join(installDir, 'resources', 'app.asar')));
  assert.equal(running(), 0, 'a silent install does not start Loui');
});

step('Windows lists it as installed, with an uninstaller that passes its own check', ciOnly(installer), async () => {
  const entries = uninstallEntry();
  assert.equal(entries.length, 1, JSON.stringify(entries));
  const [e] = entries;
  assert.equal(e.DisplayVersion, versionOf(installer));
  assert.match(e.DisplayName, /^Loui /);
  const uninstaller = e.UninstallString.match(/^"([^"]+)"/)[1];
  assert.equal(path.dirname(uninstaller).toLowerCase(), installDir.toLowerCase());
  assert.ok(fs.existsSync(uninstaller), uninstaller);
  assert.match(e.QuietUninstallString, /\/S\b/);
  const sum = nsisChecksum(uninstaller);
  assert.notEqual(sum.stored, null, 'the uninstaller carries a checksum');
  assert.equal(sum.stored, sum.computed, 'and it is the right one: Windows refuses to run an NSIS program whose checksum is wrong');
});

step('the Start menu shortcut is there, under the id the app gives its windows', ciOnly(installer), async () => {
  assert.ok(fs.existsSync(shortcut), shortcut);
  const lnk = fs.readFileSync(shortcut);
  const id = pkg.build.appId;
  assert.ok(lnk.includes(Buffer.from(id, 'utf16le')), `the shortcut carries the AppUserModelID ${id}`);
  // The same id in the app (main.js): Windows groups the windows with the pinned shortcut by it.
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'main.js'), 'utf8');
  assert.equal(main.match(/setAppUserModelId\('([^']+)'\)/)?.[1], id);
  assert.ok(lnk.includes(Buffer.from('Loui.exe', 'utf16le')) || lnk.includes(Buffer.from('Loui.exe', 'latin1')), 'and points at Loui.exe');
});

step('it is registered as a web browser Windows can make the default', ciOnly(installer), async () => {
  assert.equal(regValue('HKEY_CURRENT_USER\\Software\\Classes\\LouiHTML\\shell\\open\\command').toLowerCase(), `"${exe}" -- "%1"`.toLowerCase());
  assert.equal(regValue('HKEY_CURRENT_USER\\Software\\RegisteredApplications', 'Loui'), 'Software\\Clients\\StartMenuInternet\\Loui\\Capabilities');
  assert.equal(regValue('HKEY_CURRENT_USER\\Software\\Clients\\StartMenuInternet\\Loui\\Capabilities\\URLAssociations', 'https'), 'LouiHTML');
});

// ── drive ────────────────────────────────────────────────────────────────────
step('the installed app starts and serves its named pipe', async () => {
  assert.ok(fs.existsSync(exe), `${exe} is installed`);
  await start();
  const s = await b.state();
  assert.equal(s.tabs.length, 1);
  assert.match(s.update?.current || '', /^\d+\.\d+\.\d+/, 'it is the packaged app (a checkout has no updater), and says which version');
  if (installer) assert.equal(s.update.current, versionOf(installer));
  assert.equal(s.link.status, 'off', 'no relay');
});

driveChecks({ step, app: () => b, base: () => base });

// ── real encryption, and a restart ───────────────────────────────────────────
const PASSWORD = 'integration-Secret!42';
const RELAY_KEY = 'integration-relay-key-7f3a';
let before; // the user's tabs when Loui was quit

step('a saved password and the relay key are encrypted on disk by Windows (DPAPI)', async () => {
  await visit(base + '/login.html');
  await sleep(300); // the page script goes in at DOM ready
  await js(`(() => {
    document.getElementById('user').value = 'ana@example.com';
    document.getElementById('pass').value = ${JSON.stringify(PASSWORD)};
    document.getElementById('form').requestSubmit();
  })()`);
  const offer = await until('an offer to save the password', async () => (await b.state()).passwords.offer);
  await b.ui('passwords', { do: 'answer', id: offer.id, choice: 'save' });
  await until('the offer to go', async () => !(await b.state()).passwords.offer);
  const logins = JSON.parse(fs.readFileSync(path.join(home, 'passwords.json'), 'utf8')).logins;
  assert.equal(logins.length, 1);
  assert.match(logins[0].password, /^s1:/, 'encrypted with the system\'s key, not the test cipher');
  assert.match(logins[0].username, /^s1:/);

  // The relay's address and key, as entered in Settings (switched off: there is no relay here).
  await b.ui('relay:set', { url: 'http://127.0.0.1:9', key: RELAY_KEY, on: false });
  const relay = JSON.parse(fs.readFileSync(path.join(home, 'relay.json'), 'utf8'));
  assert.match(relay.keyEnc, /^s1:/);
  assert.equal(relay.key, undefined);
  for (const file of ['passwords.json', 'relay.json']) {
    const raw = fs.readFileSync(path.join(home, file));
    for (const secret of [PASSWORD, RELAY_KEY, 'ana@example.com']) {
      assert.ok(!raw.includes(secret) && !raw.includes(Buffer.from(secret, 'utf16le')), `${secret} is not in ${file}`);
    }
  }
  // The profile's own key is made on first use and reaches the disk some
  // seconds later; what was encrypted is only readable after a restart once it has.
  await until('the profile\'s key to reach Local State', () => {
    try { return /"encrypted_key"/.test(fs.readFileSync(path.join(home, 'Local State'), 'utf8')); } catch { return false; }
  }, 60000);
});

step('Loui quits when its last window closes, leaving the user\'s tabs to come back to', async () => {
  before = await tabsToComeBackTo({ app: () => b, base: () => base });
  await quit();
  // From now on a new tab opens the start page, as it does for the user (the tests' default is a blank one).
  const file = path.join(home, 'settings.json');
  const settings = (() => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } })();
  fs.writeFileSync(file, JSON.stringify({ ...settings, newTab: 'start' }));
});

step('after a restart: the tabs are back, and the password and the relay key decrypt', async () => {
  await start();
  const tabs = await until('the tabs to come back', async () => { const l = await mine(); return l.length === before.length && l; });
  assert.deepEqual(tabs.map((t) => t.url), before);
  const list = await b.ui('passwords:list');
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].username, 'ana@example.com');
  assert.equal(await b.ui('passwords:reveal-now', list.items[0].id), PASSWORD);
  const link = (await b.state()).link;
  assert.equal(link.hasKey, true, 'the relay key was read back');
  assert.equal(link.url, 'http://127.0.0.1:9');
});

step('a new tab shows the start page', async () => {
  await startPageCheck({ app: () => b });
  await quit();
});

// ── update ───────────────────────────────────────────────────────────────────
let next; // the version updated to

step('an update is found on the server, downloaded, and checked', ciOnly(updateDir), async () => {
  const yml = fs.readFileSync(path.join(updateDir, 'latest.yml'), 'utf8');
  next = yml.match(/^version: (.+)$/m)[1].trim();
  assert.notEqual(next, versionOf(installer));
  const asked = [];
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://x').pathname.slice(1));
    const file = path.join(updateDir, name);
    asked.push(`${req.method} ${name}${req.headers.range ? ' (range)' : ''}`);
    if (name.includes('..') || name.includes('/') || !fs.existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { 'content-length': fs.statSync(file).size });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    await start({ LOUI_UPDATE_URL: `http://127.0.0.1:${server.address().port}/` });
    assert.equal((await b.state()).update.current, versionOf(installer));
    // The first check is ten seconds after launch.
    const u = await until('the update to be downloaded', async () => {
      const s = (await b.state()).update;
      if (s.status === 'failed') assert.fail(`the updater failed: ${s.error}`);
      return s.status === 'ready' && s;
    }, 5 * 60 * 1000);
    assert.equal(u.version, next);
  } finally {
    console.log(`# the updater asked the server for: ${asked.join(', ')}`);
    server.close();
    server.closeAllConnections();
  }
});

step('"Restart to update" installs it and opens Loui again, on the same profile, with its tabs', ciOnly(updateDir), async () => {
  const tabs = (await mine()).map((t) => t.url);
  assert.deepEqual(tabs, before);
  // The installer opens Loui through the desktop's shell, so what this
  // process's environment says may not reach it: the test hooks are asked for
  // in the user's environment too, which the shell passes on. (Removed below.)
  execFileSync('setx.exe', ['LOUI_TEST', '1'], { stdio: 'ignore' });
  const old = b;
  b = null;
  const started = Date.now();
  old.ui('update:install').catch(() => {}); // no answer comes: Loui quits
  const code = await Promise.race([old.exited, sleep(60000).then(() => 'still running')]);
  await old.close();
  assert.notEqual(code, 'still running', 'Loui quit to be updated');
  // The installer runs with its progress window, which nobody is there to click: it needs no clicks.
  screenshot('while-updating');
  await until(`version ${next} to be installed`, () => {
    const [e] = uninstallEntry();
    return e?.DisplayVersion === next && fs.existsSync(exe);
  }, 5 * 60 * 1000);
  const again = await attach(home, 3 * 60 * 1000);
  console.log(`# updated and running again ${Math.round((Date.now() - started) / 1000)} s after "Restart to update"`);
  const s = await again.state();
  assert.equal(s.update.current, next, 'the new version is running');
  // Which environment it was started with: this test's (its updater is still pointed at the
  // server above, now closed, and fails) or the desktop's (it asks GitHub, and is up to date).
  const checked = await until('its first check for updates', async () => { const u = (await again.state()).update; return ['failed', 'latest', 'ready'].includes(u.status) && u; }, 40000);
  console.log(`# the updated Loui's own check for updates: ${checked.status}${checked.error ? ` (${checked.error.split('\n')[0]})` : ''}`);
  const back = await until('the tabs to come back', async () => { const l = await mine(again); return l.length === tabs.length && l; });
  assert.deepEqual(back.map((t) => t.url), tabs);
  assert.equal(await again.ui('passwords:reveal-now', (await again.ui('passwords:list')).items[0].id), PASSWORD, 'and its saved password still decrypts');
  const sum = nsisChecksum(uninstallEntry()[0].UninstallString.match(/^"([^"]+)"/)[1]);
  assert.equal(sum.stored, sum.computed, 'the new uninstaller passes its own check too');
  assert.ok(fs.existsSync(shortcut), 'the shortcut is still there');
  // Quit it as the user would.
  await sleep(1500);
  for (const w of await again.ui('windows')) again.ui('window:close', w.id).catch(() => {});
  await Promise.race([again.closed, sleep(20000)]);
  again.hangUp();
  await until('Loui to have quit', () => running() === 0, 30000);
});

// ── uninstall ────────────────────────────────────────────────────────────────
step('the uninstaller removes the program and leaves the profile alone', ciOnly(installer), async () => {
  try { execFileSync('reg.exe', ['delete', 'HKCU\\Environment', '/v', 'LOUI_TEST', '/f'], { stdio: 'ignore' }); } catch {}
  assert.equal(running(), 0, 'Loui is not running');
  const [e] = uninstallEntry();
  const uninstaller = e.UninstallString.match(/^"([^"]+)"/)[1];
  // As "Installed apps" runs it, plus /S. It copies itself to the temp
  // directory and returns at once, so the wait is for the files to go.
  execFileSync(uninstaller, ['/currentuser', '/S'], { stdio: 'inherit', timeout: 2 * 60 * 1000 });
  await until('the program files to be gone', () => !fs.existsSync(exe) && !fs.existsSync(uninstaller), 2 * 60 * 1000);
  await until('the install folder to be gone', () => !fs.existsSync(installDir), 30000);
  // The files go first; what Windows knows about the program a moment after.
  await until('Loui to be no longer listed as installed', () => uninstallEntry().length === 0, 30000);
  await until('the shortcut to be gone', () => !fs.existsSync(shortcut), 30000);
  await until('the uninstaller to have finished', () => running() === 0 && regValue('HKEY_CURRENT_USER\\Software\\RegisteredApplications', 'Loui') === '', 30000);
  assert.equal(regValue('HKEY_CURRENT_USER\\Software\\Classes\\LouiHTML\\shell\\open\\command'), '', 'no longer registered as a browser');
  assert.equal(regValue('HKEY_CURRENT_USER\\Software\\RegisteredApplications', 'Loui'), '');
  // The profile: passwords, tabs, settings, all still there.
  for (const file of ['passwords.json', 'tabs.json', 'settings.json', 'relay.json', 'Local State']) {
    assert.ok(fs.existsSync(path.join(home, file)), `${file} is still in the profile`);
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'passwords.json'), 'utf8')).logins.length, 1);
});
