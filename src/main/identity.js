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
// reads from navigator.userAgent. The header of each main-frame request is
// set by its own host (attach). The tab's agent, which the page and its
// other requests use, is set when a navigation starts, and a redirect across
// the line starts a new one (see below).
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
    const wc = tab.wc;
    wc.on('did-start-navigation', (e) => { if (e.isMainFrame && !e.isSameDocument) apply(tab, e.url); });
    // A redirect that crosses between the two kinds of host (a sign-in link
    // usually reaches Google through one, and "Sign in with Google" leaves
    // through one). The agent cannot be changed under a navigation in flight:
    // Chromium abandons it. So the redirect is not followed; the tab takes
    // the agent its target wants and loads the target afresh, which is what
    // following a 301, 302 or 303 does anyway.
    wc.on('will-redirect', (e, ...old) => {
      const d = e.url !== undefined ? e : { url: old[0], isMainFrame: old[2] };
      if (!d.isMainFrame || tab.device?.mobile) return;
      const want = honest(d.url) ? full : plain;
      if (wc.getUserAgent() === want) return;
      e.preventDefault();
      setImmediate(() => {
        if (wc.isDestroyed()) return;
        wc.setUserAgent(want);
        // The page's redirect, not the user's doing: it does not count as an
        // address Loui was asked to load (tabs.recent).
        const was = tab.loadedAt;
        wc.loadURL(d.url).catch(() => {});
        tab.loadedAt = was;
      });
    });
    // The last word, for what the above cannot catch (a redirect that keeps
    // its request body, device emulation switched off on such a page): once
    // nothing is loading, when changing it disturbs nothing.
    wc.on('did-stop-loading', () => apply(tab, wc.getURL()));
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
