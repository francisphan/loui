// Local control socket: a Unix socket inside the profile directory, so only
// this user can reach it and no web page can. The test suite drives the app
// through it; Claude sessions arrive through the relay (link.js). Its sessions
// are not asked about unless they opt in, so it is only served under
// LOUI_TEST, or with "localSocket": true in settings.json (main.js).
//
// One JSON object per line each way:
//   -> {"id": 1, "tool": "click", "args": {"ref": "e4"}, "session": {"id": "a", "label": "Claude Code"}}
//   <- {"id": 1, "content": [...]}   or   {"id": 1, "error": "..."}
//   -> {"end": "a"}                  the session is over: close its tab group
// A session may add "ask": true to be asked about like one from the relay
// (consent.js), and "connector": {"id", "name", "kind"} as the relay sends it.
// A request without "session" belongs to a session tied to the connection.
// Every session a connection opened ends when the connection closes.
const fs = require('fs');
const net = require('net');

// handle(request, fallback, viaRelay) -> reply, shared with the relay link.
// admit(session): asks the user before a new session first uses the browser
// (consent.js). Sessions from the relay are always asked; those on this
// socket only if they opt in with session.ask, as the tests do.
function createHandler({ run, sessions, extra, admit = async () => {} }) {
  return async function handle(request, fallback, viaRelay = false) {
    if (request.end) return void sessions.end(request.end);
    try {
      if (request.ui && extra) return { id: request.id, content: await extra(request) };
      if (viaRelay || request.session?.ask) await admit(request.session || fallback);
      const session = sessions.open(request.session || fallback);
      return { id: request.id, content: await run(request.tool, request.args || {}, session) };
    } catch (e) {
      return { id: request.id, error: e.message || String(e) };
    }
  };
}

let connections = 0;

function serve(socketPath, handle, sessions) {
  // A socket file outlives a crash and must be cleared; a Windows named pipe
  // does not exist on disk and takes no file mode.
  const isFile = process.platform !== 'win32';
  if (isFile) fs.rmSync(socketPath, { force: true });
  const server = net.createServer((conn) => {
    const fallback = { id: `local-${++connections}`, label: 'Local session', source: 'code' };
    const opened = new Set();
    let buffer = '';
    conn.setEncoding('utf8');
    conn.on('data', (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (line.trim()) answer(line);
      }
    });
    conn.on('error', () => {});
    conn.on('close', () => { for (const id of opened) sessions.end(id); });

    async function answer(line) {
      let request;
      try {
        request = JSON.parse(line);
      } catch {
        return;
      }
      if (request.tool) opened.add(request.session?.id || fallback.id);
      const reply = await handle(request, fallback);
      if (reply && !conn.destroyed) conn.write(JSON.stringify(reply) + '\n');
    }
  });
  // A pipe name that is taken (or a profile that cannot hold a socket) means
  // no control socket, not an error dialog.
  server.on('error', () => {});
  server.listen(socketPath, () => isFile && fs.chmodSync(socketPath, 0o600));
  return server;
}

module.exports = { serve, createHandler };
