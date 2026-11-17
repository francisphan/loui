// The one onBeforeRequest listener of a session. Electron keeps a single
// listener per webRequest event per session: registering a second silently
// replaces the first. So everything that decides about requests adds a rule
// here instead, and the rules are asked in the order they were added. The
// first to answer ({ cancel } or { redirectURL }) decides; a rule with
// nothing to say returns null.
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
      for (const rule of rules) {
        let answer = null;
        try { answer = rule(details); } catch (err) { console.error('request rule failed:', err); }
        if (answer) return done(answer);
      }
      done({});
    });
  }
  return { add: (rule) => { rules.push(rule); } };
}

module.exports = { requestRules };
