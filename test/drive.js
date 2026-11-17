// Test helper: start Loui on a throwaway profile and talk to its control socket.
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const { socketFor } = require('../src/shared/paths');

const root = path.join(__dirname, '..');

function serveFixture() {
  const dir = path.join(__dirname, 'fixture');
  const server = http.createServer((req, res) => {
    const file = path.join(dir, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
    if (!file.startsWith(dir) || !fs.existsSync(file)) return res.writeHead(404).end('missing');
    res.writeHead(200, { 'content-type': file.endsWith('.json') ? 'application/json' : 'text/html' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

// env: extra environment for the app (for example the relay to connect to).
// args: more command-line arguments (links to open, as another app would pass),
// or a function of the fixture server's address that returns them.
// exe: an installed or packaged Loui to start instead of this checkout (the
// integration tests, test/integration/).
async function launch(env = {}, { home: reuse, args = [], exe } = {}) {
  const home = reuse || fs.mkdtempSync(path.join(os.tmpdir(), 'loui-test-'));
  const server = await serveFixture();
  const base = `http://127.0.0.1:${server.address().port}`;
  const more = typeof args === 'function' ? args(base) : args;
  const app = spawn(exe || require('electron'), exe ? more : [root, '--no-sandbox', ...more], {
    env: { ...process.env, LOUI_HOME: home, LOUI_TEST: '1', LOUI_RELAY_URL: '', ...env },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const exited = new Promise((r) => app.once('exit', (code) => r(code))); // for a test that quits it
  const sock = socketFor(home);
  // A Windows named pipe is not a file to look for: there the wait is spent connecting (attach).
  const isFile = process.platform !== 'win32';
  for (let i = 0; isFile && i < 150 && !fs.existsSync(sock); i++) await new Promise((r) => setTimeout(r, 100));
  let control;
  try {
    if (isFile && !fs.existsSync(sock)) throw new Error('no control socket');
    control = await attach(home);
  } catch (e) {
    app.kill();
    server.close();
    throw new Error(`Loui did not start (${e.message}). Run with LOUI_DEBUG=1 to see why.`);
  }
  // Stops the app, even if it already exited (then there is no exit event to
  // wait for) or does not respond to SIGTERM.
  const close = async () => {
    control.hangUp();
    server.close();
    if (app.exitCode === null && app.signalCode === null) {
      const exited = new Promise((r) => app.once('exit', r));
      app.kill();
      const timer = setTimeout(() => app.kill('SIGKILL'), 5000);
      await exited;
      clearTimeout(timer);
    }
    // Chromium's helper processes can still be closing files for a moment.
    if (!reuse) {
      try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {}
    }
  };
  return { ...control, close, base, exited };
}

// Connects to the control socket of the profile in a directory, whoever
// started the Loui that serves it, and returns what the tests drive it with.
// The socket appears a moment before the app accepts connections on it (and
// a named pipe only once the app is up), so connecting is retried for a while.
async function attach(home, ms = process.platform === 'win32' ? 30000 : 5000) {
  const sock = socketFor(home);
  let conn;
  for (const end = Date.now() + ms; ;) {
    conn = net.connect(sock);
    const error = await new Promise((ok) => conn.once('connect', () => ok(null)).once('error', ok));
    if (!error) break;
    conn.destroy();
    const notYet = error.code === 'ECONNREFUSED' || (process.platform === 'win32' && error.code === 'ENOENT');
    if (Date.now() >= end || !notYet) throw error;
    await new Promise((r) => setTimeout(r, 100));
  }
  conn.setEncoding('utf8');
  const waiting = new Map();
  let buffer = '', seq = 0;
  conn.on('data', (chunk) => {
    buffer += chunk;
    for (let end; (end = buffer.indexOf('\n')) >= 0;) {
      const msg = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      waiting.get(msg.id)?.(msg);
      waiting.delete(msg.id);
    }
  });
  const ask = (request) => new Promise((ok, no) => {
    const id = ++seq;
    waiting.set(id, (m) => (m.error ? no(new Error(m.error)) : ok(m.content)));
    conn.write(JSON.stringify({ id, ...request }) + '\n');
  });
  const words = (content) => content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  // Resolves with the tool's content blocks; rejects with its error message.
  const call = (tool, args = {}) => ask({ tool, args });
  const text = async (tool, args) => words(await call(tool, args));
  // The same tools, called as a named Claude session with a tab group of its own.
  // extra: { ask: true } to be asked about like a session from the relay, and
  // { connector: { id, name, kind } } as the relay would send it.
  const as = (id, label = id, extra = {}) => {
    const session = { id, label, source: 'code', ...extra };
    return {
      call: (tool, args = {}) => ask({ tool, args, session }),
      text: async (tool, args = {}) => words(await ask({ tool, args, session })),
      end: () => conn.write(JSON.stringify({ end: id }) + '\n'),
    };
  };
  // What only the window chrome can do: ui('pause', {...}), and the window's state.
  const ui = (name, arg) => ask({ ui: name, arg });
  const state = () => ui('state');
  // closed: the app hung up (it quit). hangUp: this end does.
  const closed = new Promise((r) => conn.once('close', r));
  return { call, text, as, ui, state, home, closed, hangUp: () => conn.destroy() };
}

// Starts Loui again on the same profile, as Windows does for a link opened in
// another app while Loui runs; resolves with its exit code once it has quit.
function again(home, args = []) {
  const second = spawn(require('electron'), [root, '--no-sandbox', ...args], {
    env: { ...process.env, LOUI_HOME: home, LOUI_TEST: '1', LOUI_RELAY_URL: '' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const timer = setTimeout(() => second.kill('SIGKILL'), 20000);
  return new Promise((r) => second.once('exit', (code) => { clearTimeout(timer); r(code); }));
}

module.exports = { launch, again, attach, serveFixture };
