// Certificates the user chose to accept. A site whose certificate Chromium
// cannot verify (a self-signed one on a box or dev server of the user's own)
// does not open; its error page (errorpage.js) offers "Open anyway" in the
// user's own tabs. Saying yes accepts that one certificate (by fingerprint)
// for that host, in that tab's session (the user's, or the private one), until
// Loui quits: nothing is written down. A different certificate for the same
// host is refused again.
//
// Only the user's own tabs are let through. A tab in a Claude session's group
// is always refused, also for a host the user accepted, and nothing a session
// or the Claude panel does can accept one (see proceed(): it takes input in
// the tab within the last second, and none of the panel's work there in the
// last ten). Chromium does not
// check a certificate again while it still has a connection to the site open,
// so a session's tab is also kept from every host accepted here by a request
// rule (attach()): what it gets is the same "can't open this page safely".
const { app } = require('electron');
const { YOU } = require('./tabs');
const { requestRules } = require('./requests');

function createCerts({ tabs, changed }) {
  const accepted = new WeakMap(); // session -> Map(host -> fingerprint)
  const refused = new WeakMap(); // page -> { host, fingerprint, url }: the certificate that stopped its last load
  const of = (ses) => accepted.get(ses) || accepted.set(ses, new Map()).get(ses);
  const hostOf = (url) => { try { const u = new URL(url); return u.protocol === 'https:' || u.protocol === 'wss:' ? u.host : ''; } catch { return ''; } };

  app.on('certificate-error', (event, wc, url, _error, certificate, callback, isMainFrame) => {
    const tab = tabs.list.find((t) => t.wc === wc);
    const host = hostOf(url);
    if (!tab || !host) return; // refused, as Chromium does by default
    if (tab.group === YOU && of(tab.ses).get(host) === certificate.fingerprint) {
      event.preventDefault();
      return callback(true);
    }
    if (isMainFrame) refused.set(wc, { host, fingerprint: certificate.fingerprint, url });
  });

  // Each session: the user's, and each private one (main.js attaches those).
  const refuses = (tab, url) => !!tab && tab.group !== YOU && !!accepted.get(tab.ses)?.has(hostOf(url) || '-');
  const attach = (ses) => requestRules(ses).add((d) =>
    (refuses(tabs.list.find((t) => t.wc && !t.wc.isDestroyed() && t.wc.id === d.webContentsId), d.url) ? { cancel: true } : null));

  // Whether the error page for this failed address may offer "Open anyway":
  // the user's own tab, stopped by a certificate for this very address.
  const offer = (tab, url) => !!tab?.wc && tab.group === YOU && refused.get(tab.wc)?.url === url;

  // The user pressed "Open anyway" on the error page. Only a press of their
  // own counts: keys or mouse that reached the tab within the last second
  // (tab.userAt, tabs.js), so not a click a script makes, and not while the
  // Claude panel is at work in the tab or within ten seconds of it (tab.panelAt,
  // actions.js), so not a click of its tools, or of a timer its script left.
  function proceed(tab) {
    const r = tab?.wc && !tab.wc.isDestroyed() && refused.get(tab.wc);
    const you = tabs.group(YOU);
    const now = Date.now();
    const pressed = now - (tab?.userAt || 0) <= 1000 && now - (tab?.panelAt || 0) > 10000;
    if (!r || tab.group !== YOU || !pressed || (you.busy > 0 && you.current === tab.id)) return false;
    of(tab.ses).set(r.host, r.fingerprint);
    refused.delete(tab.wc);
    tab.wc.loadURL(r.url).catch(() => {});
    changed();
    return true;
  }

  // A private session that ended is used again later (main.js): it starts clean.
  const forget = (ses) => accepted.delete(ses);

  // For the window chrome: whether the tab on screen shows a page let through here.
  const state = () => {
    const tab = tabs.active();
    const host = tab ? hostOf(tab.url) : '';
    return { insecure: !!host && tab.group === YOU && accepted.get(tab.ses)?.has(host) ? host : null };
  };

  return { attach, refuses, offer, proceed, forget, state };
}

module.exports = { createCerts };
