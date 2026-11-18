// Updates for installed copies of Loui. New versions are published as GitHub
// releases (see .github/workflows/release.yml); an installed copy checks for
// one shortly after launch and every few hours, downloads it in the
// background, and installs it when Loui next quits, or at once if the user
// chooses "Restart to update".
//
// The builds are unsigned, so there is no publisher check; each download is
// still checked against the SHA-512 published with the release.
//
// On Debian the release is a .deb (latest-linux.yml names it). Installing one
// takes root: "Restart to update" asks for that through polkit (pkexec), which
// shows the desktop's password prompt, and installs with apt-get. Where
// nothing can show that prompt (a server with no desktop, or no pkexec), Loui
// says so and gives the command to run instead, and nothing is installed when
// Loui quits. A prompt that was dismissed can be asked for again ("Try
// again" in Settings, beside the command). However the new version got
// there (that command, or apt from elsewhere), Loui notices that what is
// installed is no longer what is running, and offers to restart.
//
// LOUI_UPDATE_URL points the updater at another server (a folder with
// latest.yml or latest-linux.yml and the installer), for testing an update
// without publishing one.
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { app } = require('electron');

const linux = process.platform === 'linux';
// By full path: desktop apps are not always given a PATH with /usr/sbin and the like.
const program = (name) => ['/usr/bin', '/usr/sbin', '/bin', '/sbin', '/usr/local/bin'].map((d) => path.join(d, name)).find((p) => fs.existsSync(p));
const run = (file, args) => new Promise((done) => {
  execFile(file, args, { encoding: 'utf8', maxBuffer: 4 << 20 }, (error, stdout, stderr) => done({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, stdout, stderr }));
});
// For a line the user pastes into a shell.
const quote = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);

// Linux: quits, and starts Loui again once this one has gone. Not
// app.relaunch(): where Chromium's sandbox needs its setuid helper (a system
// that refuses user namespaces to ordinary users) the copy Electron's helper
// starts never comes up, most likely because that helper's children may not
// gain privileges (no_new_privs). Seen on the integration tests' Debian 12.
// A shell waits for this process to go, a minute at most, and starts it.
function restart() {
  spawn('/bin/sh', ['-c', 'i=0; while kill -0 "$0" 2>/dev/null && [ $i -lt 300 ]; do sleep 0.2; i=$((i+1)); done; exec "$@"',
    String(process.pid), process.execPath, ...process.argv.slice(1)], { detached: true, stdio: 'ignore' }).unref();
  app.quit();
}

// Whether asking polkit for root can work here, and if not, why (in words
// that finish "Loui can't install it itself: …"). Root needs no asking. An
// answer of 0 from pkcheck is a rule that allows it with no questions;
// otherwise something must be running in this session to ask for the
// password: the desktop's own agent (GNOME's and Cinnamon's shells have one
// built in; the others run a program with polkit in its name).
async function elevation() {
  if (process.getuid() === 0) return { ok: true, root: true };
  const pkexec = program('pkexec');
  if (!pkexec) return { ok: false, why: 'pkexec is not installed' };
  const pkcheck = program('pkcheck');
  if (pkcheck && (await run(pkcheck, ['--action-id', 'org.freedesktop.policykit.exec', '--process', String(process.pid)])).code === 0) return { ok: true, pkexec };
  const uid = process.getuid();
  const agent = fs.readdirSync('/proc').some((pid) => {
    if (!/^\d+$/.test(pid)) return false;
    try {
      if (fs.statSync(`/proc/${pid}`).uid !== uid) return false;
      return /polkit|policykit|gnome-shell|cinnamon/i.test(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')[0]);
    } catch {
      return false;
    }
  });
  return agent ? { ok: true, pkexec } : { ok: false, why: 'nothing in this session can ask for an administrator\'s password (no polkit agent is running)' };
}

const FIRST_CHECK_MS = 10 * 1000;
const EVERY_MS = 60 * 60 * 1000;

function createUpdater({ changed }) {
  // `electron .` during development has nothing to update.
  if (!app.isPackaged) {
    return { state: () => null, check() {}, install() {} };
  }
  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = true;
  // On Linux installing asks for a password: never as Loui quits, with its windows already gone.
  autoUpdater.autoInstallOnAppQuit = !linux;
  autoUpdater.logger = null;
  if (process.env.LOUI_UPDATE_URL) {
    autoUpdater.setFeedURL({ provider: 'generic', url: process.env.LOUI_UPDATE_URL });
  }

  // status: idle | checking | downloading | ready | latest | failed, and on
  // Linux also installing (apt is at work) and installed (the new version is
  // on disk; this one is still running).
  // checked: when the last check ended (the Settings window says how it went).
  // manual: on Linux, the command that installs the update, once Loui knows it
  // cannot (why: the reason, or how its own try ended; again: the password
  // prompt was dismissed, so asking once more can work).
  let state = { status: 'idle', version: null, percent: 0, error: '', checked: 0, manual: '', why: '', again: false };
  let deb = null; // the downloaded package
  let debSum = ''; // its sha512 as the release states it, in hex
  const set = (next) => {
    state = { ...state, ...next };
    changed();
  };

  autoUpdater.on('checking-for-update', () => {
    if (state.status !== 'ready') set({ status: 'checking' });
  });
  autoUpdater.on('update-not-available', () => set({ status: 'latest', checked: Date.now() }));
  autoUpdater.on('update-available', (info) => set({ status: 'downloading', version: info.version, percent: 0 }));
  autoUpdater.on('download-progress', (p) => set({ percent: Math.round(p.percent) }));
  const held = () => state.status === 'installing' || state.status === 'installed';
  const command = () => `sudo apt install ${quote(deb)}`;
  autoUpdater.on('update-downloaded', async (info) => {
    if (!linux) return set({ status: 'ready', version: info.version });
    if (held()) return;
    deb = info.downloadedFile;
    const entry = (info.files || []).find((f) => path.basename(f.url || '') === path.basename(deb)) || info;
    debSum = entry.sha512 ? Buffer.from(entry.sha512, 'base64').toString('hex') : '';
    const can = await elevation();
    if (held()) return;
    set({ status: 'ready', version: info.version, again: false, ...(can.ok ? { manual: '', why: '' } : { manual: command(), why: can.why }) });
  });
  autoUpdater.on('error', (e) => {
    if (state.status !== 'ready' && !held()) set({ status: 'failed', error: e?.message || String(e), checked: Date.now() });
  });

  // Linux: what dpkg says is installed, when the program's files change under
  // this running copy (an update installed from a terminal, or by apt).
  if (linux) {
    const dpkgQuery = program('dpkg-query');
    // dpkg may still be at work when the file changes: asked again for a minute.
    let asking = 0;
    const ask = async () => {
      if (state.status === 'installing' || state.status === 'installed') return (asking = 0);
      const { code, stdout } = await run(dpkgQuery, ['-W', '-f', '${Version}', 'loui']);
      const version = stdout.trim();
      if (code === 0 && version && version !== app.getVersion()) {
        asking = 0;
        return set({ status: 'installed', version, manual: '', why: '', again: false });
      }
      if (--asking > 0) setTimeout(ask, 5000).unref();
    };
    fs.watchFile(path.join(process.resourcesPath, 'app.asar'), { interval: 5000 }, () => {
      if (!dpkgQuery) return;
      const idle = asking <= 0;
      asking = 12;
      if (idle) ask();
    });
  }

  // Linux: installs the downloaded package as root and starts Loui again.
  async function installDeb() {
    const can = await elevation();
    if (state.status !== 'ready') return;
    if (!can.ok) return set({ manual: command(), why: can.why, again: false });
    set({ status: 'installing', manual: '', why: '', again: false });
    // The package was checked when it was downloaded, into a folder any of
    // the user's programs can write to, and may sit there for hours before
    // this. So what is installed is a copy root has taken and checked again:
    // nothing can swap the file between the check and the install.
    if (!/^[0-9a-f]{128}$/.test(debSum)) return set({ status: 'ready', manual: command(), why: 'the downloaded package has no checksum to check it against' });
    const script = 'set -e; d=$(mktemp -d); trap \'rm -rf "$d"\' EXIT; cp -- "$1" "$d/loui.deb"; '
      + 'echo "$2  $d/loui.deb" | sha512sum -c --status -; "$3" install -y --allow-downgrades "$d/loui.deb"';
    const apt = ['/bin/sh', '-c', script, 'sh', deb, debSum, program('apt-get') || 'apt-get'];
    const { code, stderr } = can.root ? await run(apt[0], apt.slice(1)) : await run(can.pkexec, ['--disable-internal-agent', ...apt]);
    if (code === 0) return restart();
    // 126: the password prompt was dismissed. 127: polkit refused, or had nothing to ask with.
    const why = code === 126 ? 'the request for an administrator\'s password was dismissed'
      : code === 127 ? `the system did not allow it${/agent/i.test(stderr) ? ' (no polkit agent is running)' : ''}`
        : `apt-get did not finish (${(stderr.trim().split('\n').pop() || `exit code ${code}`).slice(0, 200)})`;
    set({ status: 'ready', manual: command(), why, again: code === 126 });
  }

  // Errors arrive through the 'error' event; the promise only repeats them.
  const check = () => {
    if (state.status === 'ready' || state.status === 'downloading' || held()) return;
    autoUpdater.checkForUpdates().catch(() => {});
  };
  setTimeout(check, FIRST_CHECK_MS);
  setInterval(check, EVERY_MS).unref();

  return {
    state: () => ({ ...state, current: app.getVersion() }),
    check,
    install() {
      // Not silently: the installer shows its progress while Loui is closed,
      // so the wait is not a blank; then it opens Loui again.
      if (linux) {
        if (state.status === 'installed') restart(); else if (state.status === 'ready') installDeb();
        return;
      }
      if (state.status === 'ready') autoUpdater.quitAndInstall(false, true);
    },
  };
}

module.exports = { createUpdater };
