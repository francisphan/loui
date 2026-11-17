// The link to the relay: how Claude sessions anywhere reach this browser.
// Loui dials out and keeps one WebSocket open; the relay sends tool calls down
// it. Nothing here listens for incoming connections.
//
//   -> {"hello": {"key": "...", "device": {"id", "name", "platform", "version"}}}
//   <- {"welcome": true, "sessions": ["..."]}    or   {"denied": "why"}
//   <- {"id", "tool", "args", "session": {"id", "label", "source", "connector"}}     -> {"id", "content" | "error"}
//      connector: {"id", "name", "kind"}, who the session signed in as (see consent.js)
//   <- {"end": "session id"}
//   -> {"ping": 1}    <- {"pong": 1}    is the relay still there? (below)
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ORPHAN_MS = 10 * 60 * 1000; // relay unreachable this long: its sessions' groups close
// A connection whose network path changed can stay "open" for ever without a
// word. Loui asks the relay for a sign of life three times in this long, and
// dials again if nothing at all arrived. (The relay's own pings are answered
// by the WebSocket itself and never reach this code.)
const QUIET_MS = Number(process.env.LOUI_LINK_QUIET_MS) || 90 * 1000;

// "https://host" or "http://127.0.0.1:7332" as the user enters it -> the device endpoint.
function deviceUrl(base) {
  const u = new URL(base.trim());
  u.protocol = u.protocol === 'https:' || u.protocol === 'wss:' ? 'wss:' : 'ws:';
  u.pathname = u.pathname.replace(/\/+$/, '') + '/device';
  return u.href;
}

// guard(origins): told the addresses that reach the relay, which sessions' tabs must not open.
// cipher: as passwords.js makes it. Where the system can encrypt, the key is
// kept encrypted in relay.json ("keyEnc"); where it cannot, as plain "key" in
// a file only this user can read.
function createLink({ home, version, handle, sessions, changed, guard, cipher = { available: false } }) {
  const file = path.join(home, 'relay.json');
  const read = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };
  function store() {
    const { key, ...rest } = config;
    const out = cipher.available && key ? { ...rest, keyEnc: cipher.encrypt(key) } : config;
    fs.writeFileSync(file, JSON.stringify(out, null, 2), { mode: 0o600 });
  }

  // url, key, on. The environment wins, for tests and one-off runs.
  let config = read(file, {});
  if (config.keyEnc) {
    // A key that will not decrypt (a profile copied from elsewhere) is asked for again.
    try { config.key = cipher.decrypt(config.keyEnc); } catch { config.key = ''; }
    delete config.keyEnc;
  } else if (config.key && cipher.available) {
    // A key saved as plain text by an earlier version. The system's own key
    // for this profile is made on first use and reaches the disk some seconds
    // later (six, measured on Windows), so the plain copy is only replaced
    // after that: a crash in between must not lose the relay key.
    try { cipher.encrypt(''); } catch {}
    setTimeout(() => { try { store(); } catch {} }, process.env.LOUI_TEST ? 200 : 30000).unref();
  }
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
    // An address without its key (a new one, or one the address was changed to: see configure).
    if (config.url && !config.key && config.on !== false) return set('off', 'This address has no relay key yet. Enter the key to connect.');
    if (!config.url || !config.key || config.on === false) return set('off');
    let sock;
    try {
      sock = new WebSocket(deviceUrl(config.url));
    } catch {
      return set('offline', 'That address is not a valid URL.');
    }
    ws = sock;
    set('connecting');
    let heard = Date.now();
    let answers = false; // a relay from before pings does not answer them, and is left alone
    const beat = setInterval(() => {
      if (ws !== sock) return clearInterval(beat);
      if (sock.readyState !== WebSocket.OPEN || status !== 'connected') return;
      if (answers && Date.now() - heard > QUIET_MS) return lost();
      sock.send(JSON.stringify({ ping: 1 }));
    }, QUIET_MS / 3);
    sock.onopen = () => sock.send(JSON.stringify({ hello: { key: config.key, device } }));
    sock.onmessage = async (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      heard = Date.now();
      if (msg.pong) return void (answers = true);
      if (msg.welcome) {
        guard([...(Array.isArray(msg.relay) ? msg.relay : []), new URL(config.url).origin]);
        attempt = 0;
        clearTimeout(orphanTimer);
        orphanTimer = 0;
        // The relay may have ended sessions while we were away.
        for (const id of [...mine]) if (Array.isArray(msg.sessions) && !msg.sessions.includes(id)) drop(id);
        return set('connected');
      }
      if (msg.denied) return set('refused', msg.denied);
      if (msg.tool && typeof msg.session?.id !== 'string') return;
      if (msg.tool) mine.add(msg.session.id);
      if (msg.end) mine.delete(msg.end);
      const reply = await handle(msg, null, true); // true: from the relay, so asked about (consent.js)
      if (reply && sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(reply));
    };
    sock.onerror = () => {};
    sock.onclose = () => lost();
    function lost() {
      if (ws !== sock) return;
      ws = null;
      clearInterval(beat);
      try { sock.close(); } catch {}
      if (status === 'refused') return; // wrong key: wait for new settings
      set('offline', 'The relay is not reachable. Trying again.');
      retryTimer = setTimeout(connect, Math.min(30000, 1000 * 2 ** attempt++));
      orphanTimer ||= setTimeout(() => { for (const id of [...mine]) drop(id); }, ORPHAN_MS);
    }
  }

  function drop(id) {
    mine.delete(id);
    sessions.end(id, 'lost');
  }

  // An empty key keeps the one saved, for the relay it was saved for: at
  // another address (another origin) it is dropped, never sent there.
  const relayOf = (url) => { try { return new URL(deviceUrl(url)).origin; } catch { return url; } };
  function configure({ url, key, on }) {
    url = (url || '').trim();
    const moved = !!config.url && relayOf(url) !== relayOf(config.url);
    config = { url, key: (key || '').trim() || (moved ? '' : config.key), on: on !== false };
    store();
    attempt = 0;
    connect();
  }

  return {
    connect, configure,
    state: () => ({ url: config.url || '', hasKey: !!config.key, on: config.on !== false, status, detail, device: device.name }),
  };
}

module.exports = { createLink };
