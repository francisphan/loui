// Asking before a new Claude session first uses the browser. The relay tells
// Loui who each session is ("Claude Code · pung") and which connector it
// signed in with: a stable identifier the relay derives from the OAuth client
// or the relay key, never the session. The first tool call of a session Loui
// has not seen waits while the user is asked "Let … use Loui?"; until they
// allow it, it gets no tab group.
//
// "Always allow" is remembered per connector in consent.json in the profile
// and can be revoked in File › Settings. A session the user denied is refused
// for the rest of its life; one they did not answer (away, two minutes) is
// asked again on its next call.
//
// Where nobody can see the window (Loui on a server, on a virtual display)
// the owner answers from a terminal instead: every connector that asked is
// noted in asked.json beside consent.json, and `loui --let-in`, run by the
// same user, lists them and allows them from then on (main.js). It is the
// owner's own explicit answer, given another way; nothing is let in unasked.
//
// Only sessions that come through the relay are asked. The Claude panel and
// the local control socket are the user's own (the socket is reachable only
// by this user); tests on the socket opt in with session.ask.
const fs = require('fs');

const LIMIT_MS = 2 * 60 * 1000;
const ASKED_FOR_MS = 24 * 60 * 60 * 1000; // how long a connector that asked can still be let in from a terminal
const DENIED =
  'The user did not allow this session to use their browser. Do not try again; tell them, and ' +
  'they can let a new session in.';
const UNANSWERED =
  'The user did not answer whether this session may use their browser (they may be away). ' +
  'Tell them you are waiting, and try again later.';

// decided(session, choice): told each answer, for the activity log.
function createConsent({ file, prompts, changed, decided = () => {} }) {
  // connector id -> { name, kind, since }
  const saved = (() => { try { return JSON.parse(fs.readFileSync(file, 'utf8')).connectors || {}; } catch { return {}; } })();
  const save = () => fs.writeFileSync(file, JSON.stringify({ connectors: saved }, null, 2), { mode: 0o600 });
  // Connectors that asked and are not always allowed: id -> { name, kind, who, at }.
  const askedFile = file.replace(/consent\.json$/, 'asked.json');
  const asked = {};
  const note = () => { try { fs.writeFileSync(askedFile, JSON.stringify({ connectors: asked }, null, 2), { mode: 0o600 }); } catch {} };
  const allowed = new Set(); // session ids let in
  const denied = new Set();
  const asking = new Map(); // session id -> the answer on its way, shared by calls made meanwhile

  // Resolves once the session may go ahead; throws the refusal otherwise.
  async function admit(session) {
    const { id } = session;
    if (allowed.has(id)) return;
    if (denied.has(id)) throw new Error(DENIED);
    const connector = validConnector(session.connector);
    if (connector && saved[connector.id]) {
      allowed.add(id);
      return;
    }
    if (!asking.has(id)) {
      if (connector) {
        asked[connector.id] = { name: connector.name, kind: connector.kind, who: session.label || 'Claude', at: Date.now() };
        note();
      }
      asking.set(id, prompts.ask({
        kind: 'consent', session: { id, label: session.label || 'Claude' }, limit: LIMIT_MS,
        connector: connector && { id: connector.id, name: connector.name, kind: connector.kind },
      }).then((choice) => {
        asking.delete(id);
        if (choice === 'always' && connector) {
          saved[connector.id] = { name: connector.name, kind: connector.kind, since: Date.now() };
          save();
          delete asked[connector.id];
          note();
        }
        if (choice === 'allow' || choice === 'always') allowed.add(id);
        else if (choice === 'deny') {
          denied.add(id);
          if (connector && asked[connector.id]) { delete asked[connector.id]; note(); } // refused in the window: not for a terminal to overturn
        }
        decided(session, choice);
        changed();
        return choice;
      }));
    }
    const choice = await asking.get(id);
    if (choice === 'allow' || choice === 'always') return;
    throw new Error(choice === 'deny' ? DENIED : UNANSWERED);
  }

  return {
    admit,
    // The session ended: a new one with the same id (the test socket reuses them) starts afresh.
    forget(id) {
      allowed.delete(id);
      denied.delete(id);
    },
    // `loui --let-in`: the connectors named, of those that asked, are always
    // allowed from now on, and their sessions waiting on the question go ahead.
    letIn(ids) {
      const now = [];
      for (const cid of Array.isArray(ids) ? ids : []) {
        const c = asked[cid];
        if (!c || Date.now() - c.at > ASKED_FOR_MS) continue;
        saved[cid] = { name: c.name, kind: c.kind, since: Date.now() };
        delete asked[cid];
        now.push(cid);
      }
      if (!now.length) return;
      save();
      note();
      prompts.answerWhere((item) => item.kind === 'consent' && now.includes(item.connector?.id), 'always');
      changed();
    },
    revoke(connectorId) {
      if (!saved[connectorId]) return;
      delete saved[connectorId];
      save();
      changed();
    },
    state: () => ({
      allowedConnectors: Object.entries(saved).map(([id, c]) => ({ id, name: c.name, kind: c.kind, since: c.since })),
    }),
  };
}

// Only what the relay sends, in the shape it sends it; anything else counts as
// no connector, and then there is no "always allow".
function validConnector(c) {
  if (!c || typeof c.id !== 'string' || !/^[\w-]{8,64}$/.test(c.id)) return null;
  return { id: c.id, name: String(c.name || 'Connector').slice(0, 48), kind: c.kind === 'key' ? 'key' : 'connector' };
}

module.exports = { createConsent, ASKED_FOR_MS };
