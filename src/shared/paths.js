// Where Loui keeps its profile and its local control socket.
const os = require('os');
const path = require('path');

const win = process.platform === 'win32';
const configDir = win
  ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
const home = process.env.LOUI_HOME || path.join(configDir, 'loui');

// Windows has no socket files; a named pipe is the local equivalent. Its name
// carries the profile path so that separate profiles get separate pipes.
const socketPath = win
  ? '\\\\.\\pipe\\loui-' + home.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
  : path.join(home, 'loui.sock');

module.exports = { home, socketPath };
