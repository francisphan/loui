// Where Loui keeps its profile and its local control socket.
const crypto = require('crypto');
const os = require('os');
const path = require('path');

const win = process.platform === 'win32';
const configDir = win
  ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
const home = process.env.LOUI_HOME || path.join(configDir, 'loui');

// The control socket of the profile in a directory (rpc.js; the tests look
// for it with this too). Windows has no socket files; a named pipe is the
// local equivalent. Its name is made from a hash of the profile path, so
// separate profiles get separate pipes whatever characters their paths have.
const socketFor = (dir) => (win
  ? '\\\\.\\pipe\\loui-' + crypto.createHash('sha256').update(path.resolve(dir).toLowerCase()).digest('hex').slice(0, 24)
  : path.join(dir, 'loui.sock'));
const socketPath = socketFor(home);

module.exports = { home, socketPath, socketFor };
