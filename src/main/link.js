// The link to the relay: how Claude sessions anywhere reach this browser.
// Loui dials out and keeps one WebSocket open; the relay sends tool calls down
// it. Nothing here listens for incoming connections.
//
//   -> {"hello": {"key": "...", "device": {"id", "name", "platform", "version"}}}
//   <- {"welcome": true, "sessions": ["..."]}    or   {"denied": "why"}
//   <- {"id", "tool", "args", "session": {"id", "label", "source", "connector"}}     -> {"id", "content" | "error"}
//      connector: {"id", "name", "kind"}, who the session signed in as (see consent.js)
//   <- {"end": "session id"}
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ORPHAN_MS = 10 * 60 * 1000; // relay unreachable this long: its sessions' groups close

// "https://host" or "http://127.0.0.1:7332" as the user enters it -> the device endpoint.
function deviceUrl(base) {
  const u = new URL(base.trim());
  u.protocol = u.protocol === 'https:' || u.protocol === 'wss:' ? 'wss:' : 'ws:';
  u.pathname = u.pathname.replace(/\/+$/, '') + '/device';
  return u.href;
}

// guard(origins): told the addresses that reach the relay, which sessions' tabs must not open.
function createLink({ home, version, handle, sessions, changed, guard }) {
  const file = path.join(home, 'relay.json');
  const read = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };

  // url, key, on. The environment wins, for tests and one-off runs.
  let config = read(file, {});
  if (process.env.LOUI_RELAY_URL) config = { url: process.env.LOUI_RELAY_URL, key: process.env.LOUI_RELAY_KEY, on: true };

  const idFile = path.join(home, 'device.json');
  let device = read(idFile, null);
  if (!device) {
    device = { id: crypto.randomUUID() };
    fs.writeFileSync(idFile, JSON.stringify(device));
  }
  const wsl = process.platform === 'linux' && /microsoft/i.test(os.release());
  device = { id: device.id, name: os.hostname() + (wsl ? ' (WSL)' : ''), platform: process.platform, version };

  const mine = new Set(); // sessions that came through the relay
  let ws = null;
  let status = 'off'; // off | connecting | connected | offline | refused
  let detail = '';
  let attempt = 0;
  let retryTimer = 0;
  let orphanTimer = 0;

  const set = (next, why = '') => {
    status = next;
    detail = why;
    changed();
  };

  function connect() {
    clearTimeout(retryTimer);
    if (ws) {
      const old = ws;
      ws = null;
      old.close();
    }
    if (!config.url || !config.key || config.on === false) return set('off');
    let sock;
    try {
      sock = new WebSocket(deviceUrl(config.url));
    } catch {
      return set('offline', 'That address is not a valid URL.');
    }
    ws = sock;
    set('connecting');
    sock.onopen = () => sock.send(JSON.stringify({ hello: { key: config.key, device } }));
    sock.onmessage = async (event) => {
      const msg = JSON.parse(event.data);
      if (msg.welcome) {
        guard([...(msg.relay || []), new URL(config.url).origin]);
        attempt = 0;
        clearTimeout(orphanTimer);
        orphanTimer = 0;
        // The relay may have ended sessions while we were away.
        for (const id of [...mine]) if (!msg.sessions.includes(id)) drop(id);
        return set('connected');
      }
      if (msg.denied) return set('refused', msg.denied);
      if (msg.tool) mine.add(msg.session.id);
      if (msg.end) mine.delete(msg.end);
      const reply = await handle(msg, null, true); // true: from the relay, so asked about (consent.js)
      if (reply && sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(reply));
    };
    sock.onerror = () => {};
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      if (status === 'refused') return; // wrong key: wait for new settings
      set('offline', 'The relay is not reachable. Trying again.');
      retryTimer = setTimeout(connect, Math.min(30000, 1000 * 2 ** attempt++));
      orphanTimer ||= setTimeout(() => { for (const id of [...mine]) drop(id); }, ORPHAN_MS);
    };
  }

  function drop(id) {
    mine.delete(id);
    sessions.end(id);
  }

  function configure({ url, key, on }) {
    config = { url: (url || '').trim(), key: (key || '').trim() || config.key, on: on !== false };
    fs.writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });
    attempt = 0;
    connect();
  }

  return {
    connect, configure,
    state: () => ({ url: config.url || '', hasKey: !!config.key, on: config.on !== false, status, detail, device: device.name }),
  };
}

module.exports = { createLink };
