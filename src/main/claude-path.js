// Where Claude Code is installed, on Linux and macOS (chat.js; Windows has
// its own lookup there, WSL included). A copy of Loui started from the
// desktop's menu, or by systemd, is not given the PATH a terminal has, so
// PATH alone misses the usual places: the native installer's ~/.local/bin,
// npm's global folder, and whatever the user's shell adds (nvm and the like).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const isProgram = (p) => {
  try { return fs.statSync(p).isFile() && (fs.accessSync(p, fs.constants.X_OK), true); } catch { return false; }
};

// PATH as the user's login shell has it, asked of an interactive login shell
// (it reads the profile and rc files, where version managers add theirs).
// Resolves with '' if the shell cannot say within a few seconds.
function shellPath(shell, env) {
  return new Promise((done) => {
    execFile(shell, ['-lic', 'printf "\\n@@%s\\n" "$PATH"'], { env, encoding: 'utf8', timeout: 15000 }, (_e, stdout) => {
      done(String(stdout || '').split('\n').find((l) => l.startsWith('@@'))?.slice(2).trim() || '');
    }).stdin?.end();
  });
}

// The claude program's full path, or null. Looks in PATH, then the usual
// places, then the login shell's PATH. env, home: for the tests.
async function findClaude({ env = process.env, home = os.homedir() } = {}) {
  // Empty and relative PATH entries would mean the directory Loui runs in.
  const split = (p) => String(p || '').split(path.delimiter).filter((d) => d && path.isAbsolute(d));
  const look = (dirs) => dirs.map((d) => path.join(d, 'claude')).find(isProgram) || null;
  const usual = [
    path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local'), path.join(home, '.npm-global', 'bin'),
    '/usr/local/bin', '/usr/bin', '/opt/homebrew/bin',
  ];
  const found = look([...split(env.PATH), ...usual]);
  if (found) return found;
  const shell = env.SHELL && path.isAbsolute(env.SHELL) ? env.SHELL : (() => { try { return os.userInfo().shell; } catch { return null; } })() || '/bin/sh';
  if (!isProgram(shell)) return null;
  return look(split(await shellPath(shell, env)));
}

module.exports = { findClaude };
