// Who may use the relay. There is one owner and one secret, the relay key
// (created on first run, in the relay's own directory, readable only by them).
//
//   - Loui browsers present the key when they connect.
//   - Claude Code on the owner's machines sends it as a bearer token.
//   - Claude's connector (Desktop, web, phone, cloud sessions) cannot be given
//     a static token, so it signs in with OAuth: the owner approves it once by
//     entering the key on a page the relay serves, and the connector then holds
//     tokens of its own.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { InvalidGrantError, InvalidTokenError } = require('@modelcontextprotocol/sdk/server/auth/errors.js');

const ACCESS_MS = 60 * 60 * 1000;
const CODE_MS = 5 * 60 * 1000;
const APPROVAL_MS = 10 * 60 * 1000;
const MAX_WRONG_KEYS = 5; // per ten minutes, across everyone, before the approval page locks

const random = () => crypto.randomBytes(32).toString('base64url');
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function createAuth(home) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const keyFile = path.join(home, 'key');
  if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, random() + '\n', { mode: 0o600 });
  const key = fs.readFileSync(keyFile, 'utf8').trim();

  const isKey = (candidate) => {
    const a = Buffer.from(String(candidate || ''));
    const b = Buffer.from(key);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  // Registered connectors and their refresh tokens survive a restart; access
  // tokens and codes are short-lived and kept in memory.
  const storeFile = path.join(home, 'oauth.json');
  let store = { clients: {}, refresh: {} };
  try { store = JSON.parse(fs.readFileSync(storeFile, 'utf8')); } catch {}
  const save = () => fs.writeFileSync(storeFile, JSON.stringify(store, null, 2), { mode: 0o600 });

  const access = new Map(); // token -> { clientId, expiresAt }
  const codes = new Map(); // code -> { clientId, challenge, redirectUri, expiresAt }
  const approvals = new Map(); // id -> { client, params, expiresAt }
  let wrong = [];

  function issue(clientId, refreshToken) {
    const token = random();
    access.set(token, { clientId, expiresAt: Date.now() + ACCESS_MS });
    if (!refreshToken) {
      refreshToken = random();
      store.refresh[refreshToken] = { clientId };
      save();
    }
    return { access_token: token, token_type: 'bearer', expires_in: ACCESS_MS / 1000, refresh_token: refreshToken };
  }

  const provider = {
    clientsStore: {
      getClient: (id) => store.clients[id],
      registerClient(client) {
        store.clients[client.client_id] = client;
        save();
        return client;
      },
    },

    // Hands the browser to the approval page below.
    async authorize(client, params, res) {
      const id = random();
      approvals.set(id, { client, params, expiresAt: Date.now() + APPROVAL_MS });
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

    async exchangeRefreshToken(client, refreshToken) {
      if (store.refresh[refreshToken]?.clientId !== client.client_id) throw new InvalidGrantError('Unknown refresh token');
      return issue(client.client_id, refreshToken);
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

  function page(request, client, problem) {
    return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect to Loui</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; color: #14242C; background: #E6EDEF; margin: 0; display: grid; place-items: center; min-height: 100vh; }
  form { background: #FBFCFC; border: 1px solid #C6D2D7; border-radius: 12px; padding: 28px; width: min(26rem, 86vw); display: grid; gap: 14px; }
  h1 { font-size: 20px; margin: 0; }
  p { margin: 0; color: #55676F; }
  input { font: inherit; padding: 8px 10px; border: 1px solid #C6D2D7; border-radius: 8px; }
  button { font: inherit; font-weight: 650; padding: 9px 16px; border: 0; border-radius: 20px; background: #B3257F; color: #fff; justify-self: start; }
  .problem { color: #A8281F; }
</style>
<form method="post" action="/approve">
  <h1>Let ${escapeHtml(client.client_name || 'this app')} use your Loui browsers?</h1>
  <p>It will be able to open pages, click, type and take screenshots in a tab group of its own, with your logins. Enter your relay key to allow it.</p>
  ${problem ? `<p class="problem">${escapeHtml(problem)}</p>` : ''}
  <input type="hidden" name="request" value="${escapeHtml(request)}">
  <input type="password" name="key" placeholder="Relay key" aria-label="Relay key" autofocus required>
  <button type="submit">Allow</button>
</form>`;
  }

  // GET shows the page; POST checks the key and sends the browser back to the
  // connector with an authorization code.
  function approve(req, res) {
    const request = req.method === 'POST' ? req.body?.request : req.query.request;
    const pending = approvals.get(request);
    if (!pending || pending.expiresAt < Date.now()) {
      return res.status(400).send('This request has expired. Start the connection again from Claude.');
    }
    if (req.method !== 'POST') return res.send(page(request, pending.client));

    wrong = wrong.filter((t) => t > Date.now() - 10 * 60 * 1000);
    if (wrong.length >= MAX_WRONG_KEYS) {
      return res.status(429).send(page(request, pending.client, 'Too many wrong keys. Try again in ten minutes.'));
    }
    if (!isKey(req.body?.key)) {
      wrong.push(Date.now());
      return res.status(403).send(page(request, pending.client, 'That is not the relay key.'));
    }
    approvals.delete(request);
    const { client, params } = pending;
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

  return { key, isKey, provider, approve };
}

module.exports = { createAuth };
