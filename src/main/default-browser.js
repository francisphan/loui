// Links from other apps: Loui as the default browser.
//
// On Windows the installer registers Loui as a browser (build/installer.nsh),
// so it is listed in Settings › Default apps; Windows 10 and 11 let only the
// user pick the default there, so the File menu takes them to that page.
// Windows then starts `Loui.exe -- "<link>"`. The `--` ends Chromium's
// switches, so a link can never be read as one, whatever it says.
//
// A link arrives on the command line: at start, or, when Loui is already
// running, in the second instance that Windows starts, which hands it to this
// one ('second-instance') and quits. Each opens in a new tab of the user's.
// Only http(s) addresses and existing local .htm/.html files are accepted;
// anything else on the command line (Chromium's own switches, the app's path
// in development, stray words) is ignored.
const fs = require('fs');
const path = require('path');
const { pathToFileURL, fileURLToPath } = require('url');
const { app, dialog, shell } = require('electron');
const { YOU } = require('./tabs');

// Windows Settings opened at Loui's entry (the RegisteredApplications value
// name the installer writes).
const SETTINGS_URI = 'ms-settings:defaultapps?registeredAppUser=Loui';

// One command-line argument as an address to open, or null.
function accept(arg, cwd) {
  if (typeof arg !== 'string' || !arg || arg.length > 8192 || arg.startsWith('-')) return null;
  if (/^https?:\/\//i.test(arg)) {
    try {
      const url = new URL(arg);
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
    } catch {
      return null;
    }
  }
  let file = null;
  if (/^file:/i.test(arg)) {
    try { file = fileURLToPath(arg); } catch { return null; }
  } else if (/\.html?$/i.test(arg) && !/^[a-z][a-z0-9+.-]+:/i.test(arg)) {
    file = path.resolve(cwd, arg); // C:\… and relative paths; not other schemes
  }
  if (!file || !/\.html?$/i.test(file)) return null;
  return fs.statSync(file, { throwIfNoEntry: false })?.isFile() ? pathToFileURL(file).href : null;
}

// The addresses on a command line (argv as in process.argv).
function urlsFrom(argv, cwd) {
  return (argv || []).slice(1).map((a) => accept(a, cwd)).filter(Boolean);
}

function createDefaultBrowser({ getWin, tabs }) {
  // In the normal window the user focused last (never a private one; a new
  // normal window if only private ones are open).
  function open(urls) {
    const w = tabs.normalWindow() || tabs.openWindow({ blank: !urls.length });
    for (const url of urls) tabs.create(url, { group: YOU, show: true, window: w });
    const win = w.win;
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  // The second instance sends its addresses as additionalData (see main.js),
  // since Chromium may add to or reorder the command line it passes on. Both
  // are checked again here.
  function secondInstance(argv, cwd, data) {
    const urls = Array.isArray(data?.urls) ? data.urls.map((u) => accept(u, cwd)).filter(Boolean) : urlsFrom(argv, cwd);
    open(urls);
  }

  async function makeDefault() {
    const { response } = await dialog.showMessageBox(getWin(), {
      type: 'info',
      message: 'Choose Loui in Windows Settings',
      detail: 'Windows lets only you change the default browser. Settings opens at Loui: choose ' +
        '"Set default" (or pick Loui for HTTP, HTTPS, .htm and .html), and links from other apps will open in a new tab here.',
      buttons: ['Open Settings', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) shell.openExternal(SETTINGS_URI).catch(() => {});
  }

  // File menu items: only where the installer registered Loui.
  const menuItems = () => (process.platform === 'win32' && app.isPackaged
    ? [{ label: 'Make Loui your default browser…', click: makeDefault }]
    : []);

  return { open, secondInstance, menuItems };
}

module.exports = { createDefaultBrowser, urlsFrom, accept };
