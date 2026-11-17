// Claude sessions. A session is one conversation somewhere (Claude Code,
// Claude Desktop, the phone app) that is using this browser. Each one is
// responsible for a tab group of its own; when the session ends, its group
// closes. The Claude panel inside the window is the exception: it is the
// user's own co-driver and works in the user's tabs.
const { YOU } = require('./tabs');

const PAUSED =
  'The user has taken over this tab group and paused you. Stop here and tell them you are ' +
  'waiting; they will say when to continue.';

function createSessions({ tabs, changed, feed }) {
  const live = new Map(); // id -> { id, group, label, source }
  const panel = { id: 'panel', group: YOU, label: 'Claude', source: 'panel' };
  let feedId = 0;
  let asking = null; // a session waiting for the user to hand over the tab on screen

  // Two sessions from the same place get "Claude Code" and "Claude Code 2".
  function unique(label) {
    const taken = new Set([...live.values()].map((s) => s.label));
    let name = label;
    for (let n = 2; taken.has(name); n++) name = `${label} ${n}`;
    return name;
  }

  // The session for a request, created with its tab group on first sight.
  function open({ id, label, source }) {
    let s = live.get(id);
    if (!s) {
      s = { id, group: id, label: unique(label || 'Claude'), source: source || 'claude' };
      live.set(id, s);
      tabs.addGroup({ id, label: s.label, source: s.source });
    }
    return s;
  }

  function end(id) {
    if (!live.delete(id)) return;
    if (asking?.session.id === id) answer(false);
    tabs.removeGroup(id);
  }

  // Runs one tool call on behalf of a session, keeping its group's status
  // current for the window. acts: the tool changes the page, so it is refused
  // while the user has taken over.
  async function during(session, label, acts, fn) {
    const g = tabs.group(session.group);
    if (!g) throw new Error('This session has ended and its tabs are closed.');
    if (acts && g.paused) throw new Error(PAUSED);
    const entry = {
      type: 'action', id: ++feedId, session: session.id,
      who: session === panel ? null : session.label, text: label,
    };
    const show = () => {
      g.status = entry.text;
      feed(entry);
      changed();
    };
    g.busy++;
    show();
    try {
      return await fn((better) => { entry.text = better; show(); });
    } catch (e) {
      entry.failed = true;
      feed(entry);
      throw e;
    } finally {
      g.busy--;
      changed();
    }
  }

  // A session asks for the tab the user is looking at. Resolves with the tab
  // once the user allows it, or null if they decline or a minute passes.
  function request(session) {
    const tab = tabs.active();
    if (tab?.group === session.group) {
      tabs.setCurrent(session.group, tab.id);
      return Promise.resolve(tab);
    }
    if (asking) throw new Error('Another session is already asking the user for a tab.');
    return new Promise((resolve) => {
      const timer = setTimeout(() => answer(false), 60000);
      asking = { session, resolve, timer, tabId: tab?.id };
      changed();
    });
  }

  function answer(yes) {
    if (!asking) return;
    const { session, resolve, timer, tabId } = asking;
    clearTimeout(timer);
    asking = null;
    const tab = tabs.get(tabId); // the tab on screen when the session asked
    // Only the user's own tabs can be handed over, not another session's.
    if (yes && tab?.group === YOU && live.has(session.id)) {
      tabs.move(tab.id, session.group, { lent: true });
      resolve(tab);
    } else resolve(null);
    changed();
  }

  return {
    panel, open, end, during, request, answer,
    get: (id) => live.get(id),
    ids: () => [...live.keys()],
    asking: () => (asking ? { label: asking.session.label } : null),
  };
}

module.exports = { createSessions };
