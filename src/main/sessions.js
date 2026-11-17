// Claude sessions. A session is one conversation somewhere (Claude Code,
// Claude Desktop, the phone app) that is using this browser. Each one is
// responsible for a tab group of its own; when the session ends, its group
// closes. The Claude panel inside the window is the exception: it is the
// user's own co-driver and works in the user's tabs.
const { YOU } = require('./tabs');

const PAUSED =
  'The user has taken over this tab group and paused you. Stop here and tell them you are ' +
  'waiting; they will say when to continue.';

// prompts: the line of questions for the user (prompts.js). ended(id): told
// whenever a session ends, even one that never got a group. activity: the
// activity log (activity.js), told of each session and step.
function createSessions({ tabs, changed, feed, prompts, ended = () => {}, activity = null }) {
  const live = new Map(); // id -> { id, group, label, source }
  const panel = { id: 'panel', group: YOU, label: 'Claude', source: 'panel' };
  let feedId = 0;

  // Two sessions from the same place get "Claude Code" and "Claude Code 2".
  function unique(label) {
    const taken = new Set([...live.values()].map((s) => s.label));
    let name = label;
    for (let n = 2; taken.has(name); n++) name = `${label} ${n}`;
    return name;
  }

  // The session for a request, created with its tab group on first sight.
  function open(request) {
    const { id, label, source } = request;
    let s = live.get(id);
    if (!s) {
      // The user's own group and the panel's session are not a session's to name.
      if (id === YOU || id === panel.id) throw new Error(`A session cannot be called "${id}".`);
      s = { id, group: id, label: unique(label || 'Claude'), source: source || 'claude' };
      live.set(id, s);
      tabs.addGroup({ id, label: s.label, source: s.source });
      activity?.open(s, request);
    }
    return s;
  }

  // how: why it ended, for the activity log ('ended', 'closed' by the user, 'lost').
  function end(id, how) {
    prompts.drop(id); // its questions, including one asking whether it may come in
    ended(id);
    activity?.end(id, how);
    const s = live.get(id);
    if (!live.delete(id)) return;
    tabs.removeGroup(id);
    feed({ type: 'ended', id: ++feedId, session: id, who: s.label, how }); // the last line of its steps in the Claude panel
  }

  // Runs one tool call on behalf of a session, keeping its group's status
  // current for the window. acts: the tool changes the page, so it is refused
  // while the user has taken over. fn(say, note): say(label) improves the
  // label; note(text) gives the activity log what was typed or run.
  async function during(session, label, acts, fn) {
    const g = tabs.group(session.group);
    if (!g) throw new Error('This session has ended and its tabs are closed.');
    const who = session === panel ? null : session.label;
    if (acts && g.paused) {
      // Said once each time the user takes over, however often the session tries.
      const e = Object.assign(new Error(PAUSED), { stopped: 'paused' });
      if (!g.toldPaused && label) {
        g.toldPaused = true;
        feed({ type: 'action', id: ++feedId, session: session.id, who, text: label, stopped: 'paused' });
        activity?.step(session, label, false)?.done(e);
      }
      throw e;
    }
    if (!g.paused) g.toldPaused = false;
    const entry = { type: 'action', id: ++feedId, session: session.id, who, text: label };
    const show = () => {
      g.status = entry.text || 'working';
      if (entry.text) feed(entry); // a step with nothing to say is not drawn
      changed();
    };
    const step = activity?.step(session, label, acts);
    g.busy++;
    show();
    try {
      const out = await fn((better) => { entry.text = better; step?.label(better); show(); }, (detail) => step?.note(detail));
      step?.done(null);
      return out;
    } catch (e) {
      // Stopped by the user (e.stopped: 'blocked', 'unanswered', 'paused') is
      // not a failure; a failure says why, in the error's first line.
      if (e?.stopped) entry.stopped = e.stopped;
      else {
        entry.failed = true;
        entry.why = String(e?.message || e).split('\n')[0].slice(0, 160);
      }
      if (entry.text) feed(entry);
      step?.done(e);
      throw e;
    } finally {
      g.busy--;
      changed();
    }
  }

  // A session asks for the tab the user is looking at. The question waits its
  // turn behind any others; once shown, the user has a minute. Resolves with
  // the tab once the user allows it, or null if they decline or do not answer.
  async function request(session) {
    const tab = tabs.active();
    if (tab?.group === session.group) {
      tabs.setCurrent(session.group, tab.id);
      return tab;
    }
    const yes = await prompts.ask({ kind: 'handoff', session, limit: 60000 });
    // The tab on screen when the user answered: the question says "this tab",
    // and by its turn the user may be looking at another one. Only the user's
    // own tabs can be handed over, not another session's.
    const now = tabs.active();
    if (yes !== true || now?.group !== YOU || !live.has(session.id)) return null;
    tabs.move(now.id, session.group, { lent: true });
    return now;
  }

  // The hand-over question on show, answered from the window (or the tests).
  function answer(yes) {
    const head = prompts.head();
    if (head?.kind === 'handoff') prompts.answer(head.id, !!yes);
  }

  return {
    panel, open, end, during, request, answer,
    get: (id) => live.get(id),
    ids: () => [...live.keys()],
    asking: () => {
      const head = prompts.head();
      return head?.kind === 'handoff' ? { label: head.session.label } : null;
    },
  };
}

module.exports = { createSessions, PAUSED };
