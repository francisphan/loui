// Test helper: start Loui on a throwaway profile and talk to its control socket.
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

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
async function launch(env = {}, { home: reuse } = {}) {
  const home = reuse || fs.mkdtempSync(path.join(os.tmpdir(), 'loui-test-'));
  const server = await serveFixture();
  const base = `http://127.0.0.1:${server.address().port}`;
  const app = spawn(require('electron'), [root, '--no-sandbox'], {
    env: { ...process.env, LOUI_HOME: home, LOUI_TEST: '1', LOUI_RELAY_URL: '', ...env },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const sock = path.join(home, 'loui.sock');
  for (let i = 0; i < 150 && !fs.existsSync(sock); i++) await new Promise((r) => setTimeout(r, 100));
  if (!fs.existsSync(sock)) {
    app.kill();
    server.close();
    throw new Error('Loui did not start (no control socket). Run with LOUI_DEBUG=1 to see why.');
  }
  // The socket file appears a moment before the app accepts connections on
  // it, so a refused connection is retried for a while.
  let conn;
  for (let tries = 0; ; tries++) {
    conn = net.connect(sock);
    const error = await new Promise((ok) => conn.once('connect', () => ok(null)).once('error', ok));
    if (!error) break;
    conn.destroy();
    if (tries >= 50 || error.code !== 'ECONNREFUSED') throw error;
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
  const as = (id, label = id) => {
    const session = { id, label, source: 'code' };
    return {
      call: (tool, args = {}) => ask({ tool, args, session }),
      text: async (tool, args = {}) => words(await ask({ tool, args, session })),
      end: () => conn.write(JSON.stringify({ end: id }) + '\n'),
    };
  };
  // What only the window chrome can do: ui('pause', {...}), and the window's state.
  const ui = (name, arg) => ask({ ui: name, arg });
  const state = () => ui('state');
  // Stops the app, even if it already exited (then there is no exit event to
  // wait for) or does not respond to SIGTERM.
  const close = async () => {
    conn.destroy();
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
  return { call, text, as, ui, state, close, base, home };
}

module.exports = { launch };
