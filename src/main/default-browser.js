// Links from other apps: Loui as the default browser.
//
// On Windows the installer registers Loui as a browser (build/installer.nsh),
// so it is listed in Settings › Default apps; Windows 10 and 11 let only the
// user pick the default there, so the File menu takes them to that page.
// Windows then starts `Loui.exe -- "<link>"`. The `--` ends Chromium's
// switches, so a link can never be read as one, whatever it says.
//
// On Linux the Debian package's loui.desktop says Loui opens http, https and
// HTML (its MimeType line) and starts it with `loui -- <link>`. There an app
// may set the default itself: `xdg-settings set default-web-browser
// loui.desktop`, which tells whichever desktop is running (or, with none,
// records it with xdg-mime); `xdg-settings get` says what it is now.
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
const { execFile } = require('child_process');
const { app, dialog, shell } = require('electron');
const { YOU } = require('./tabs');

// Windows Settings opened at Loui's entry (the RegisteredApplications value
// name the installer writes).
const SETTINGS_URI = 'ms-settings:defaultapps?registeredAppUser=Loui';

// Linux: the desktop entry the package installs, and the tool that sets the
// default (from xdg-utils, which the package depends on). The tests name a
// stand-in for the tool.
const DESKTOP = 'loui.desktop';
const linux = process.platform === 'linux';
const standIn = process.env.LOUI_TEST ? process.env.LOUI_XDG_SETTINGS : '';
const findXdgSettings = () => (!linux ? null : standIn || (app.isPackaged && fs.existsSync(`/usr/share/applications/${DESKTOP}`)
  ? ['/usr/bin/xdg-settings', '/usr/local/bin/xdg-settings'].find((p) => fs.existsSync(p)) : null) || null);

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

// changed: what is the default was asked again and is not what state() last said (Linux).
function createDefaultBrowser({ getWin, tabs, changed = () => {} }) {
  const xdgSettings = findXdgSettings();
  const xdg = (...args) => new Promise((done) => {
    execFile(xdgSettings, args, { encoding: 'utf8', timeout: 20000 }, (error, stdout, stderr) => done({ ok: !error, out: String(stdout).trim(), err: String(stderr).trim() }));
  });
  // In the normal window the user focused last (never a private one; a new
  // normal window if only private ones are open).
  function open(urls) {
    const w = tabs.normalWindow() || tabs.openWindow({ blank: !urls.length });
    for (const url of urls) tabs.byUser(tabs.create(url, { group: YOU, show: true, window: w }));
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

  // Linux: what the system says now, asked without holding anything up.
  let isDefault = false;
  async function look() {
    if (!xdgSettings) return;
    const now = (await xdg('get', 'default-web-browser')).out === DESKTOP;
    if (now === isDefault) return;
    isDefault = now;
    changed();
  }
  look();

  // parent: the window that asked (the Settings window), otherwise the main one.
  async function makeDefault(parent) {
    if (linux) {
      if (!xdgSettings) return;
      const set = await xdg('set', 'default-web-browser', DESKTOP);
      await look();
      if (isDefault) return;
      await dialog.showMessageBox(parent?.webContents ? parent : getWin(), {
        type: 'warning',
        message: 'Loui could not be made the default browser',
        detail: `${set.err || 'The system did not take the change.'}\n\nIn a terminal: xdg-settings set default-web-browser ${DESKTOP}`,
        buttons: ['OK'],
      });
      return;
    }
    const { response } = await dialog.showMessageBox(parent?.webContents ? parent : getWin(), {
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
  const menuItems = () => ((process.platform === 'win32' && app.isPackaged) || xdgSettings
    ? [{ label: linux ? 'Make Loui your default browser' : 'Make Loui your default browser…', click: () => makeDefault() }]
    : []);

  // For the Settings window. can: the installer registered Loui (Windows or
  // the Debian package, installed). On Linux isDefault is what look() last heard.
  const state = () => {
    if (linux) return { can: !!xdgSettings, isDefault };
    const can = process.platform === 'win32' && app.isPackaged;
    return { can, isDefault: can && app.isDefaultProtocolClient('http') && app.isDefaultProtocolClient('https') };
  };

  return { open, secondInstance, menuItems, makeDefault, state, look };
}

module.exports = { createDefaultBrowser, urlsFrom, accept };
