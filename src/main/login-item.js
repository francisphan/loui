// "Open Loui when I sign in". Windows and macOS keep this for the app
// (Electron's login item). A Linux desktop starts whatever has an entry in
// ~/.config/autostart (the XDG autostart folder: GNOME, KDE, Xfce and the
// rest read it), so there the setting is that file: written when on, removed
// when off. Only for an installed copy: one run from its source has no
// program of its own to start.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');

const linux = process.platform === 'linux';
// The tests name a folder of their own.
const testDir = process.env.LOUI_TEST ? process.env.LOUI_AUTOSTART_DIR : '';
const file = path.join(testDir || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart'), 'loui.desktop');

// A program's path as a .desktop file's Exec wants it: quoted, with the
// characters the format reserves escaped, and % doubled.
const execArg = (s) => `"${s.replace(/(["`$\\])/g, '\\$1').replace(/%/g, '%%')}"`;

const can = () => !linux || app.isPackaged || !!testDir;

function get() {
  if (!can()) return false;
  if (!linux) return app.getLoginItemSettings().openAtLogin;
  try {
    // A desktop's own "startup applications" list switches an entry off by adding Hidden=true.
    return !/^Hidden\s*=\s*true/mi.test(fs.readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
}

function set(on) {
  if (!can()) return;
  if (!linux) return app.setLoginItemSettings({ openAtLogin: !!on });
  if (!on) return fs.rmSync(file, { force: true });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // `--` ends Chromium's switches, as in the installed loui.desktop.
  fs.writeFileSync(file, [
    '[Desktop Entry]', 'Type=Application', 'Name=Loui', 'Comment=Open Loui when I sign in',
    `Exec=${execArg(process.execPath)} --`, 'Icon=loui', 'Terminal=false', 'X-GNOME-Autostart-enabled=true', '',
  ].join('\n'));
}

module.exports = { can, get, set, file };
