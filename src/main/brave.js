// Brave, the user's other browser. Some sites refuse to work in Loui: Google
// will not sign in from a browser it considers embedded, and Loui does not
// pretend to be another browser to get past that. Instead:
//
// - "Open in Brave" (tab menu, File menu) hands the page's address to Brave.
// - Sites on a list (accounts.google.com unless the user changes it) are sent
//   to Brave when one of the user's own tabs tries to open them; the tab shows
//   a short note saying so, with a link that takes the site off the list.
//
// Only http(s) addresses are handed over, as a single argument to Brave's
// program, never through a shell. Claude never makes Loui open another
// program: in a session's tabs, and while the Claude panel is working in the
// user's tabs, a listed site is simply not opened, and the note says why.
//
// Without Brave, the system's default browser is used. Under LOUI_TEST nothing
// is opened: the addresses are recorded for the tests to read.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { shell } = require('electron');
const { YOU } = require('./tabs');

const DEFAULT_SITES = ['accounts.google.com'];
const UNDO = 'https://loui.invalid/undo/'; // the note's link; never loaded (.invalid does not resolve)

// Brave's program, in the places its installers put it, or on PATH.
function findBrave() {
  const env = process.env;
  if (process.platform === 'win32') {
    return [env.LOCALAPPDATA, env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean)
      .map((dir) => path.join(dir, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'))
      .find((file) => fs.existsSync(file)) || null;
  }
  for (const dir of (env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const name of ['brave-browser', 'brave']) {
      try {
        fs.accessSync(path.join(dir, name), fs.constants.X_OK);
        return path.join(dir, name);
      } catch {}
    }
  }
  return null;
}

// A web address as Brave should get it, or null.
function webUrl(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

// What the user typed as a site ("accounts.google.com", or an address on it), as a host name.
function hostOf(input) {
  const text = String(input || '').trim().toLowerCase();
  try {
    const host = new URL(/^[a-z]+:\/\//.test(text) ? text : `https://${text}`).hostname;
    return /^[a-z0-9.-]+$/.test(host) && /[a-z0-9]/.test(host) ? host : null;
  } catch {
    return null;
  }
}

const escape = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// The page left in the tab. No script; the only link is the one Loui handles.
function note({ title, lines, link }) {
  const html = `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">` +
    `<title>${escape(title)}</title><style>` +
    `:root{color-scheme:light dark}body{font:16px/1.5 system-ui,sans-serif;padding:12vh 8vw;max-width:40em;color:#14242C;background:#FBFCFC}` +
    `h1{font-size:22px;font-weight:650;margin:0 0 12px}p{margin:0 0 12px}a{color:#2B7A93}.where{overflow-wrap:anywhere;color:#55676F}` +
    `@media (prefers-color-scheme:dark){body{color:#E3EBEE;background:#1A2832}a{color:#7CC4DA}.where{color:#93A6AF}}` +
    `</style></head><body><h1>${escape(title)}</h1>` +
    lines.map(([text, cls]) => `<p${cls ? ` class="${cls}"` : ''}>${escape(text)}</p>`).join('') +
    (link ? `<p><a href="${escape(link.href)}">${escape(link.text)}</a></p>` : '') +
    `</body></html>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

// settings: the object kept in settings.json; save writes it.
function createBrave({ tabs, settings, save, changed }) {
  let exe;
  const program = () => (exe === undefined ? (exe = findBrave()) : exe);
  const name = () => (program() ? 'Brave' : 'your default browser');
  const opened = []; // LOUI_TEST: what would have been opened
  let lastHandOff = 0;

  // Hands an address to Brave. Returns false if it is not a web address.
  function open(url) {
    const href = webUrl(url);
    if (!href) return false;
    if (process.env.LOUI_TEST) {
      opened.push(href);
      return true;
    }
    const file = program();
    if (!file) {
      shell.openExternal(href).catch(() => {});
      return true;
    }
    const child = spawn(file, [href], { detached: true, stdio: 'ignore' });
    child.on('error', () => shell.openExternal(href).catch(() => {}));
    child.unref();
    return true;
  }

  // ── the list of sites ───────────────────────────────────────────────────
  const sites = () => (Array.isArray(settings.openInBrave) ? settings.openInBrave : DEFAULT_SITES);
  function setSites(list) {
    settings.openInBrave = [...new Set(list)];
    save();
    changed();
  }
  const add = (input) => { const host = hostOf(input); if (host && !sites().includes(host)) setSites([...sites(), host]); };
  const remove = (host) => setSites(sites().filter((s) => s !== host));

  // The listed site this address is on (the site itself or a subdomain of it), or null.
  function listed(url) {
    const href = webUrl(url);
    if (!href) return null;
    const host = new URL(href).hostname;
    return sites().find((s) => host === s || host.endsWith('.' + s)) || null;
  }

  // For the navigate tool: why a session may not open this address, or null.
  function refuse(url) {
    const site = listed(url);
    return site && `${site} is on the user's list of sites that open in their other browser, ` +
      "so Loui doesn't open it in Claude's tabs. Ask the user to do this step themselves.";
  }

  // ── the user's tabs and sessions' tabs ──────────────────────────────────
  const undo = new Map(); // nonce -> { tabId, site, url }: the note's link

  function divert(tab, url, site) {
    // Only the user, in their own tab, sends a page to Brave; a page that keeps
    // trying is handed over once every few seconds at most.
    const yours = tab.group === YOU && !(tabs.group(YOU).busy > 0);
    const handOff = yours && Date.now() - lastHandOff > 3000;
    let page;
    if (handOff) {
      lastHandOff = Date.now();
      open(url);
      const nonce = crypto.randomBytes(12).toString('hex');
      undo.set(nonce, { tabId: tab.id, site, url });
      page = note({
        title: `Opened in ${name() === 'Brave' ? 'Brave' : 'your other browser'}`,
        lines: [
          [`Loui sent this page to ${name()}, because ${site} is on your list of sites that open there. ` +
            'Some sites, Google sign-in among them, refuse browsers like Loui.'],
          [url, 'where'],
        ],
        link: { href: UNDO + nonce, text: `Open ${site} in Loui from now on` },
      });
    } else {
      page = note({
        title: 'Not opened',
        lines: [
          [yours ? `${site} opens in ${name()}, and Loui only sends it there when you open it yourself.`
            : `${site} opens in the user's other browser, so Loui doesn't open it in Claude's tabs.`],
          [url, 'where'],
        ],
      });
    }
    notes.get(tab).set(page, url);
    // After the event that brought us here has returned.
    setImmediate(() => { if (tab.wc && !tab.wc.isDestroyed()) tab.wc.loadURL(page).catch(() => {}); });
  }

  const notes = new WeakMap(); // tab -> Map(note page -> the address it stands in for)

  function watch(tab) {
    const wc = tab.wc;
    notes.set(tab, new Map());
    // The address bar shows the address the note stands in for, as it would
    // for a page that failed to load, rather than the note's own data: address.
    wc.on('did-navigate', (_e, to) => {
      const url = notes.get(tab).get(to);
      if (url) { tab.url = url; tabs.emit('change'); }
    });
    // The note's link, followed in the tab Loui left it in. A page linking
    // here itself has no nonce Loui gave out, so it changes nothing.
    wc.on('will-navigate', (e) => {
      if (!e.url.startsWith(UNDO)) return;
      e.preventDefault();
      const u = undo.get(e.url.slice(UNDO.length));
      if (!u || u.tabId !== tab.id || tab.group !== YOU || !wc.getURL().startsWith('data:')) return;
      undo.delete(e.url.slice(UNDO.length));
      remove(u.site);
      setImmediate(() => wc.loadURL(u.url).catch(() => {}));
    });
    // A site that redirects to a listed one.
    wc.on('will-redirect', (e) => {
      const site = e.isMainFrame && listed(e.url);
      if (site) { e.preventDefault(); divert(tab, e.url, site); }
    });
    // Every other way a page opens (links, script, the address bar, a new tab,
    // back and forward): replaced by the note as soon as it starts.
    wc.on('did-start-navigation', (e) => {
      const site = e.isMainFrame && !e.isSameDocument && listed(e.url);
      if (site) divert(tab, e.url, site);
    });
  }
  for (const tab of tabs.list) watch(tab);
  tabs.on('created', watch);

  tabs.on('tab-menu', (tab, items) => {
    if (webUrl(tab.url)) items.push({ label: `Open in ${name()}`, click: () => open(tab.url) });
  });

  return {
    open, add, remove, refuse, name,
    state: () => ({ elsewhere: { browser: name(), sites: sites() } }),
    probes: {
      'brave:opened': () => opened,
      // Runs a line of script in the tab on screen, as a person's click would.
      'tab:eval': (code) => tabs.active().wc.executeJavaScript(code, true),
    },
  };
}

module.exports = { createBrave };
