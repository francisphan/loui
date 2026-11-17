// The one onBeforeRequest listener of a session. Electron keeps a single
// listener per webRequest event per session: registering a second silently
// replaces the first. So everything that decides about requests adds a rule
// here instead, and the rules are asked in the order they were added. The
// first to answer ({ cancel } or { redirectURL }) decides; a rule with
// nothing to say returns null. A rule may also return a promise of either,
// which holds the request until it settles (guardrails.js asks the user).
//
// tabs.js adds the relay guard (sessions' tabs never reach the relay) when
// the tabs are set up, before anything else exists, so it is always asked
// first and its refusal is final.
const listeners = new WeakMap(); // session -> rules

function requestRules(ses) {
  let rules = listeners.get(ses);
  if (!rules) {
    rules = [];
    listeners.set(ses, rules);
    ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, done) => {
      const from = (i) => {
        for (; i < rules.length; i++) {
          let answer = null;
          try { answer = rules[i](details); } catch (err) { console.error('request rule failed:', err); }
          if (typeof answer?.then === 'function') {
            const next = i + 1;
            return void answer.then((a) => (a ? done(a) : from(next)), (err) => {
              console.error('request rule failed:', err);
              from(next);
            });
          }
          if (answer) return done(answer);
        }
        done({});
      };
      from(0);
    });
  }
  return { add: (rule) => { rules.push(rule); } };
}

module.exports = { requestRules };
