// Updates for installed copies of Loui. New versions are published as GitHub
// releases (see .github/workflows/release.yml); an installed copy checks for
// one shortly after launch and every few hours, downloads it in the
// background, and installs it when Loui next quits, or at once if the user
// chooses "Restart to update".
//
// The builds are unsigned, so there is no publisher check; each download is
// still checked against the SHA-512 published with the release.
//
// LOUI_UPDATE_URL points the updater at another server (a folder with
// latest.yml and the installer), for testing an update without publishing one.
const { app } = require('electron');

const FIRST_CHECK_MS = 10 * 1000;
const EVERY_MS = 6 * 60 * 60 * 1000;

function createUpdater({ changed }) {
  // `electron .` during development has nothing to update.
  if (!app.isPackaged) {
    return { state: () => null, check() {}, install() {} };
  }
  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;
  if (process.env.LOUI_UPDATE_URL) {
    autoUpdater.setFeedURL({ provider: 'generic', url: process.env.LOUI_UPDATE_URL });
  }

  // status: idle | checking | downloading | ready | latest | failed
  // checked: when the last check ended (the Settings window says how it went).
  let state = { status: 'idle', version: null, percent: 0, error: '', checked: 0 };
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
  autoUpdater.on('update-downloaded', (info) => set({ status: 'ready', version: info.version }));
  autoUpdater.on('error', (e) => {
    if (state.status !== 'ready') set({ status: 'failed', error: e?.message || String(e), checked: Date.now() });
  });

  // Errors arrive through the 'error' event; the promise only repeats them.
  const check = () => {
    if (state.status === 'ready' || state.status === 'downloading') return;
    autoUpdater.checkForUpdates().catch(() => {});
  };
  setTimeout(check, FIRST_CHECK_MS);
  setInterval(check, EVERY_MS).unref();

  return {
    state: () => ({ ...state, current: app.getVersion() }),
    check,
    install() {
      if (state.status === 'ready') autoUpdater.quitAndInstall(true, true);
    },
  };
}

module.exports = { createUpdater };
