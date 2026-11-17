// Questions Claude sessions put to the user: may this new session use Loui
// (consent.js), may it have the tab on screen (sessions.js), and would the
// user point at something (actions.js). They wait in one line and are shown
// one at a time, oldest first, in the helm at the end of the tab row: window
// chrome, which no page can draw over. The rest are a count beside it, so a
// user who was away comes back to one question and a number, not a pile.
//
// A question's time limit runs from when it is shown, not from when it was
// asked, so one waiting its turn still gets the user's full attention. Nothing
// waits longer than MAX_WAIT in all, so the answer is back before the relay
// gives up on the call (its CALL_TIMEOUT_MS is longer).
const MAX_WAIT_MS = 8 * 60 * 1000;

function createPrompts({ changed }) {
  const line = []; // { id, kind, session, at, limit, begin, stop, resolve, timer, ... }
  let seq = 0;

  // kind: 'consent' | 'handoff' | 'pick'. session: { id, label }. limit: ms
  // once shown (none: begin() has a limit of its own). begin(item): called
  // when the question is shown. stop(): called if it is withdrawn or runs out
  // after begin. Resolves with the answer, or with null if there was none.
  function ask({ kind, session, limit, begin, stop, ...rest }) {
    return new Promise((resolve) => {
      const item = { ...rest, id: ++seq, kind, session, limit, begin, stop, resolve, at: Date.now() };
      line.push(item);
      if (line.length === 1) show();
      changed();
    });
  }

  function show() {
    const head = line[0];
    if (!head) return;
    const left = Math.max(0, MAX_WAIT_MS - (Date.now() - head.at));
    head.timer = setTimeout(() => withdraw(head), head.limit ? Math.min(head.limit, left) : left);
    head.shown = true;
    head.begin?.(head);
  }

  function settle(item, value) {
    const i = line.indexOf(item);
    if (i < 0) return;
    clearTimeout(item.timer);
    line.splice(i, 1);
    item.resolve(value);
    if (i === 0) show();
    changed();
  }

  // Unanswered: timed out, or its session ended.
  function withdraw(item) {
    if (!line.includes(item)) return;
    if (item.shown) item.stop?.();
    settle(item, null);
  }

  return {
    ask,
    answer(id, value) {
      const item = line.find((x) => x.id === id);
      if (item) settle(item, value);
    },
    // A session that ends takes its questions with it.
    drop(sessionId) {
      for (const item of line.filter((x) => x.session.id === sessionId)) withdraw(item);
    },
    head: () => line[0] || null,
    // For the window: the question on show, and who else is waiting.
    state() {
      const head = line[0];
      return {
        prompt: head ? {
          id: head.id, kind: head.kind, who: head.session.label,
          message: head.message || '', connector: head.connector || null,
        } : null,
        waiting: line.slice(1).map((x) => x.session.label),
      };
    },
  };
}

module.exports = { createPrompts };
