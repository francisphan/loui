// Who may use the relay. There is one owner and one secret, the relay key
// (created on first run, in the relay's own directory, readable only by them).
//
//   - Loui browsers present the key when they connect.
//   - Claude Code on the owner's machines sends it as a bearer token.
//   - Claude's connector (Desktop, web, phone, cloud sessions) cannot be given
//     a static token, so it signs in with OAuth: the owner approves it once by
//     entering the key on a page the relay serves, and the connector then holds
//     tokens of its own.
//
// Anyone on the internet can register an OAuth client, so the approval page is
// the line of defence. Clients may only send codes to Claude's own sites or to
// this machine (LOUI_REDIRECT_HOSTS adds more), and the page names that site.
// Every token is tied to the key: replace the key file and restart the relay,
// and every connector has to be approved again.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  InvalidGrantError, InvalidTokenError, InvalidClientMetadataError,
} = require('@modelcontextprotocol/sdk/server/auth/errors.js');

const ACCESS_MS = 60 * 60 * 1000;
const REFRESH_MS = 30 * 24 * 60 * 60 * 1000; // a connector unused this long must be approved again
const CODE_MS = 5 * 60 * 1000;
const APPROVAL_MS = 10 * 60 * 1000;
const TRIES = 3; // wrong keys per approval request before it is withdrawn
const MAX_CLIENTS = 200; // when full, the oldest registration that was never approved makes way
const MAX_APPROVALS = 100; // pending approvals; the oldest makes way
const REFRESH_GRACE_MS = 2 * 60 * 1000; // a replaced refresh token still works this long (lost replies, retries)
const MIN_KEY_LENGTH = 32;
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];
const REDIRECT_HOSTS = ['claude.ai', 'claude.com', ...LOOPBACK];

const random = () => crypto.randomBytes(32).toString('base64url');
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const allowedHosts = () => [
  ...REDIRECT_HOSTS,
  ...(process.env.LOUI_REDIRECT_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
];

function createAuth(home) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const keyFile = path.join(home, 'key');
  if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, random() + '\n', { mode: 0o600 });
  const key = fs.readFileSync(keyFile, 'utf8').trim();
  // The key is the only thing between the internet and a signed-in browser, so
  // a short hand-made one is refused rather than guessed.
  if (key.length < MIN_KEY_LENGTH) {
    throw new Error(`The relay key in ${keyFile} is shorter than ${MIN_KEY_LENGTH} characters. Delete the file and restart the relay to get a new one.`);
  }
  // Stored with each refresh token, so a new key retires the old ones.
  const generation = crypto.createHash('sha256').update('loui:' + key).digest('base64url').slice(0, 16);

  const isKey = (candidate) => {
    const a = Buffer.from(String(candidate || ''));
    const b = Buffer.from(key);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  // Registered connectors and their refresh tokens survive a restart; access
  // tokens, codes and pending approvals are short-lived and kept in memory.
  const storeFile = path.join(home, 'oauth.json');
  let store = { clients: {}, refresh: {} };
  try { store = JSON.parse(fs.readFileSync(storeFile, 'utf8')); } catch {}
  const save = () => fs.writeFileSync(storeFile, JSON.stringify(store, null, 2), { mode: 0o600 });

  const access = new Map(); // token -> { clientId, expiresAt }
  const codes = new Map(); // code -> { clientId, challenge, redirectUri, expiresAt }
  const approvals = new Map(); // id -> { client, params, expiresAt, tries }

  // Expired entries are dropped, and so are registrations that never got approved.
  function sweep() {
    const now = Date.now();
    for (const m of [access, codes, approvals]) for (const [k, v] of m) if (v.expiresAt < now) m.delete(k);
    let dirty = false;
    for (const [t, r] of Object.entries(store.refresh)) {
      if (r.generation !== generation || r.expiresAt < now) { delete store.refresh[t]; dirty = true; }
    }
    const busy = inUse();
    for (const [id, c] of Object.entries(store.clients)) {
      if (!busy.has(id) && (c.client_id_issued_at || 0) * 1000 < now - APPROVAL_MS) {
        delete store.clients[id];
        dirty = true;
      }
    }
    if (dirty) save();
  }

  // Clients with a sign-in that is done or under way.
  function inUse() {
    return new Set([
      ...Object.values(store.refresh).map((r) => r.clientId),
      ...[...approvals.values()].map((a) => a.client.client_id),
      ...[...codes.values()].map((c) => c.clientId),
    ]);
  }
  sweep();
  setInterval(sweep, 60 * 1000).unref();

  function issue(clientId) {
    const token = random();
    access.set(token, { clientId, expiresAt: Date.now() + ACCESS_MS });
    const refreshToken = random();
    store.refresh[refreshToken] = { clientId, generation, expiresAt: Date.now() + REFRESH_MS };
    save();
    return { access_token: token, token_type: 'bearer', expires_in: ACCESS_MS / 1000, refresh_token: refreshToken };
  }

  const provider = {
    clientsStore: {
      getClient: (id) => store.clients[id],
      registerClient(client) {
        const hosts = allowedHosts();
        for (const uri of client.redirect_uris) {
          const { protocol, host: full } = new URL(uri);
          const host = full.replace(/:\d+$/, '').toLowerCase();
          // https only; plain http just for this machine (a local client's callback).
          if (protocol !== 'https:' && !(protocol === 'http:' && LOOPBACK.includes(host))) {
            throw new InvalidClientMetadataError(`This relay only sends sign-ins to https addresses, not ${uri}.`);
          }
          if (!hosts.includes(host)) {
            throw new InvalidClientMetadataError(`This relay only sends sign-ins to ${hosts.join(', ')}, not ${host}.`);
          }
        }
        if (Object.keys(store.clients).length >= MAX_CLIENTS) {
          const busy = inUse();
          const idle = Object.values(store.clients).filter((c) => !busy.has(c.client_id))
            .sort((a, b) => (a.client_id_issued_at || 0) - (b.client_id_issued_at || 0));
          if (!idle.length) throw new InvalidClientMetadataError('Too many connectors are registered with this relay.');
          delete store.clients[idle[0].client_id];
        }
        store.clients[client.client_id] = client;
        save();
        return client;
      },
    },

    // Hands the browser to the approval page below.
    async authorize(client, params, res) {
      const id = random();
      if (approvals.size >= MAX_APPROVALS) approvals.delete(approvals.keys().next().value);
      approvals.set(id, { client, params, expiresAt: Date.now() + APPROVAL_MS, tries: 0 });
      res.redirect(`/approve?request=${id}`);
    },

    async challengeForAuthorizationCode(client, code) {
      const c = codes.get(code);
      if (!c || c.clientId !== client.client_id) throw new InvalidGrantError('Unknown authorization code');
      return c.challenge;
    },

    async exchangeAuthorizationCode(client, code, _verifier, redirectUri) {
      const c = codes.get(code);
      codes.delete(code);
      if (!c || c.clientId !== client.client_id || c.expiresAt < Date.now()) {
        throw new InvalidGrantError('Unknown or expired authorization code');
      }
      if (redirectUri && redirectUri !== c.redirectUri) throw new InvalidGrantError('redirect_uri does not match');
      return issue(client.client_id);
    },

    // Each use of a refresh token replaces it. The old one keeps working for a
    // couple of minutes, so a reply lost on the way, or two refreshes at once,
    // do not sign the connector out.
    async exchangeRefreshToken(client, refreshToken) {
      const r = store.refresh[refreshToken];
      if (!r || r.clientId !== client.client_id || r.generation !== generation || r.expiresAt < Date.now()) {
        throw new InvalidGrantError('Unknown or expired refresh token');
      }
      r.expiresAt = Math.min(r.expiresAt, Date.now() + REFRESH_GRACE_MS);
      return issue(client.client_id);
    },

    async verifyAccessToken(token) {
      const soon = Math.floor(Date.now() / 1000) + 3600;
      if (isKey(token)) return { token, clientId: 'owner', scopes: [], expiresAt: soon };
      const a = access.get(token);
      if (!a || a.expiresAt < Date.now()) {
        access.delete(token);
        throw new InvalidTokenError('Unknown or expired token');
      }
      return { token, clientId: a.clientId, scopes: [], expiresAt: Math.floor(a.expiresAt / 1000) };
    },

    async revokeToken(_client, { token }) {
      access.delete(token);
      if (store.refresh[token]) {
        delete store.refresh[token];
        save();
      }
    },
  };

  function page(request, client, redirectUri, problem) {
    const site = new URL(redirectUri).host;
    return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect to Loui</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; color: #14242C; background: #E6EDEF; margin: 0; display: grid; place-items: center; min-height: 100vh; }
  form { background: #FBFCFC; border: 1px solid #C6D2D7; border-radius: 12px; padding: 28px; width: min(26rem, 86vw); display: grid; gap: 14px; }
  h1 { font-size: 20px; margin: 0; }
  p { margin: 0; color: #55676F; }
  .site { color: #14242C; font-weight: 700; }
  input { font: inherit; padding: 8px 10px; border: 1px solid #C6D2D7; border-radius: 8px; }
  button { font: inherit; font-weight: 650; padding: 9px 16px; border: 0; border-radius: 20px; background: #B3257F; color: #fff; justify-self: start; }
  .problem { color: #A8281F; }
</style>
<form method="post" action="/approve">
  <h1>Let ${escapeHtml(client.client_name || 'this app')} use your Loui browsers?</h1>
  <p>Access goes to <span class="site">${escapeHtml(site)}</span>. Only allow it if you started this from Claude just now.</p>
  <p>It will be able to open pages, click, type and take screenshots in a tab group of its own, with your logins. Enter your relay key to allow it.</p>
  ${problem ? `<p class="problem">${escapeHtml(problem)}</p>` : ''}
  <input type="hidden" name="request" value="${escapeHtml(request)}">
  <input type="password" name="key" placeholder="Relay key" aria-label="Relay key" autofocus required>
  <button type="submit">Allow</button>
</form>`;
  }

  // GET shows the page; POST checks the key and sends the browser back to the
  // connector with an authorization code. The page cannot be framed.
  function approve(req, res) {
    res.set('Content-Security-Policy', "frame-ancestors 'none'; default-src 'none'; style-src 'unsafe-inline'; form-action 'self'");
    res.set('X-Frame-Options', 'DENY');
    res.set('Cache-Control', 'no-store');
    const request = req.method === 'POST' ? req.body?.request : req.query.request;
    const pending = approvals.get(request);
    if (!pending || pending.expiresAt < Date.now()) {
      return res.status(400).send('This request has expired. Start the connection again from Claude.');
    }
    const { client, params } = pending;
    if (req.method !== 'POST') return res.send(page(request, client, params.redirectUri));

    if (!isKey(req.body?.key)) {
      if (++pending.tries >= TRIES) {
        approvals.delete(request);
        return res.status(403).send('That was not the relay key. This request has been withdrawn; start again from Claude.');
      }
      return res.status(403).send(page(request, client, params.redirectUri, 'That is not the relay key.'));
    }
    approvals.delete(request);
    const code = random();
    codes.set(code, {
      clientId: client.client_id, challenge: params.codeChallenge, redirectUri: params.redirectUri,
      expiresAt: Date.now() + CODE_MS,
    });
    const back = new URL(params.redirectUri);
    back.searchParams.set('code', code);
    if (params.state) back.searchParams.set('state', params.state);
    res.redirect(back.href);
  }

  // Who a session signed in as, for the browser to remember "always allow"
  // by (Loui's consent.js): the relay key, or one OAuth connector. The id is a
  // hash, so neither the client id nor anything of the key reaches the
  // browser, and it changes with the key, so a new key asks again.
  function connector(clientId) {
    const id = crypto.createHash('sha256').update(`loui-connector:${generation}:${clientId}`).digest('base64url').slice(0, 22);
    if (clientId === 'owner') return { id, name: 'the relay key', kind: 'key' };
    return { id, name: String(store.clients[clientId]?.client_name || 'Connector').slice(0, 48), kind: 'connector' };
  }

  return { key, isKey, provider, approve, connector };
}

module.exports = { createAuth };
