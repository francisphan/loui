// What Loui tells a site it is. Almost everywhere it leaves its own name and
// Electron's out of the user agent, as sites that sniff for them serve a
// broken page otherwise. Google's sign-in does the opposite: it refuses a
// browser that claims to be one it is not ("This browser or app may not be
// secure") and lets one through that says what it is. So on the hosts in
// HONEST a tab carries the full, true user agent, and the usual one again
// once it leaves. Measured 2026-11-17 against accounts.google.com: the
// stripped agent was rejected, the true one was not.
//
// Two things must agree: the request's User-Agent header and what the page
// reads from navigator.userAgent. The tab's agent is switched when a
// main-frame navigation starts, which is in time for the page but too late
// for that navigation's own request; so the header of each main-frame request
// is also set here, by host (attach).
const HONEST = ['accounts.google.com', 'accounts.youtube.com'];

// full: Electron's own user agent, with loui/ and Electron/ in it. plain: the
// same without them (the default for every session). hosts: for the tests.
function createIdentity({ tabs, full, plain, hosts = HONEST }) {
  const hostOf = (url) => { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } };
  const honest = (url) => hosts.includes(hostOf(url));

  function apply(tab, url) {
    const wc = tab.wc;
    if (!wc || wc.isDestroyed() || tab.device?.mobile) return; // a phone being emulated keeps its own agent
    const want = honest(url) ? full : plain;
    if (wc.getUserAgent() !== want) wc.setUserAgent(want);
  }

  tabs.on('created', (tab) => {
    tab.wc.on('did-start-navigation', (e) => {
      if (e.isMainFrame && !e.isSameDocument) apply(tab, e.url);
    });
  });

  // For each session a tab can have (the user's, and a private window's).
  // The only onBeforeSendHeaders listener: a session takes one.
  function attach(ses) {
    ses.webRequest.onBeforeSendHeaders((d, done) => {
      if (d.resourceType !== 'mainFrame') return done({});
      const tab = tabs.list.find((t) => t.wc && !t.wc.isDestroyed() && t.wc.id === d.webContentsId);
      if (!tab || tab.device?.mobile) return done({});
      const name = Object.keys(d.requestHeaders).find((k) => k.toLowerCase() === 'user-agent') || 'User-Agent';
      done({ requestHeaders: { ...d.requestHeaders, [name]: honest(d.url) ? full : plain } });
    });
  }

  return { honest, attach };
}

module.exports = { createIdentity, HONEST };
