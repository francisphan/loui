// Downloads. Files go straight to the Downloads folder (or, if the user turned
// it on, a Save As dialog asks where), never over an existing file, and are
// listed in the window with their progress. Downloads that start in a Claude
// session's tab are saved and listed too, marked with the session's name.
//
// Opening a file or showing it in its folder happens only here, on the user's
// click in the window chrome. Sessions have no tool for it, so a page that
// Claude visits cannot get a downloaded file run.
const fs = require('fs');
const path = require('path');
const { app, shell } = require('electron');
const { YOU } = require('./tabs');

const KEEP = 50; // finished downloads remembered across restarts

// On Windows, tags a downloaded file as coming from the internet (the "Mark of
// the Web", an alternate data stream that every browser writes). Windows
// SmartScreen and Office's Protected View check it before a downloaded program
// or document runs. Electron does not write it, so Loui does.
function markOfTheWeb(file, url, referrer) {
  if (process.platform !== 'win32') return;
  const safe = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : ''; } catch { return ''; } };
  const lines = ['[ZoneTransfer]', 'ZoneId=3'];
  if (safe(referrer)) lines.push(`ReferrerUrl=${safe(referrer)}`);
  if (safe(url)) lines.push(`HostUrl=${safe(url)}`);
  try { fs.writeFileSync(`${file}:Zone.Identifier`, lines.join('\r\n') + '\r\n'); } catch {}
}

// name, or "name (1).ext", "name (2).ext"… whichever is free on disk and not
// already promised to a download still in progress.
function freePath(dir, name, taken) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 0; ; n++) {
    const file = path.join(dir, n ? `${stem} (${n})${ext}` : name);
    if (!taken.has(file) && !fs.existsSync(file)) return file;
  }
}

function createDownloads({ ses, tabs, home, changed }) {
  const listFile = path.join(home, 'downloads.json');
  const saved = (() => { try { return JSON.parse(fs.readFileSync(listFile, 'utf8')); } catch { return {}; } })();
  let ask = !!saved.ask;
  // Newest first. A download that was running when Loui quit cannot be resumed.
  let items = (Array.isArray(saved.items) ? saved.items : []).map((d) =>
    (d.state === 'progressing' || d.state === 'paused' ? { ...d, state: 'interrupted' } : d));
  let seq = items.reduce((max, d) => Math.max(max, d.id || 0), 0);
  const running = new Map(); // id -> DownloadItem
  // A page may start a download when someone just acted in its tab (or Loui
  // loaded the address), and one more per page load; the rest are stopped and
  // listed as blocked, where the user can let one through.
  const started = new WeakMap(); // a tab's page -> downloads it started since it loaded
  const allowed = new Set(); // addresses the user chose "Download anyway" for
  function mayStart(tab, wc) {
    if (!started.has(wc)) wc.on('did-navigate', () => started.set(wc, 0));
    const n = started.get(wc) || 0;
    started.set(wc, n + 1);
    return tabs.recent(tab) || n === 0;
  }

  const folder = () => process.env.LOUI_DOWNLOADS || app.getPath('downloads');
  // A private window's downloads are listed while it is open, never written
  // down; nor are blocked ones, which belong to a tab as it is now.
  const save = () => {
    try {
      fs.writeFileSync(listFile, JSON.stringify({ ask, items: items.filter((d) => !d.private && d.state !== 'blocked').slice(0, KEEP) }, null, 2));
    } catch {}
  };

  // Each session: the user's, and each private one (main.js attaches those).
  const attach = (s, { private: priv = false } = {}) => s.on('will-download', (e, item, wc) => {
    const tab = wc && tabs.list.find((t) => t.wc === wc);
    const g = tab && tab.group !== YOU ? tabs.group(tab.group) : null;
    const name = path.basename(item.getFilename() || '') || 'download';
    const anyway = item.getURLChain().filter((u) => allowed.delete(u)).length > 0;
    if (tab && !anyway && !mayStart(tab, wc)) {
      e.preventDefault();
      // One row per page however often it tries.
      if (!items.some((d) => d.state === 'blocked' && d.tab === tab.id)) {
        const d = {
          id: ++seq, name, file: '', url: item.getURLChain()[0] || item.getURL(), by: g ? g.label : null,
          private: priv, tab: tab.id, state: 'blocked', received: 0, total: 0, at: Date.now(),
        };
        items.unshift(d);
        save();
        changed();
      }
      return;
    }
    const dir = folder();
    fs.mkdirSync(dir, { recursive: true });
    const taken = new Set(items.filter((d) => running.has(d.id)).map((d) => d.file));
    const file = freePath(dir, name, taken);
    // A session's download never pops up a dialog: the user did not start it.
    if (ask && !g) item.setSaveDialogOptions({ defaultPath: file });
    else item.setSavePath(file);

    const d = {
      id: ++seq, name: path.basename(file), file, url: item.getURL(), by: g ? g.label : null,
      private: priv,
      state: 'progressing', received: 0, total: item.getTotalBytes(), at: Date.now(),
    };
    items.unshift(d);
    running.set(d.id, item);
    if (items.length > KEEP) items = items.filter((x, i) => i < KEEP || running.has(x.id));
    const update = () => {
      const chosen = item.getSavePath();
      if (chosen && chosen !== d.file) { d.file = chosen; d.name = path.basename(chosen); }
      d.received = item.getReceivedBytes();
      d.total = item.getTotalBytes();
    };
    item.on('updated', (_ev, state) => {
      update();
      d.state = state === 'interrupted' ? 'interrupted' : item.isPaused() ? 'paused' : 'progressing';
      changed();
    });
    item.once('done', (_ev, state) => {
      update();
      d.state = state; // completed, cancelled or interrupted
      if (state === 'completed') markOfTheWeb(d.file, item.getURL(), item.getReferrer?.() || '');
      running.delete(d.id);
      save();
      changed();
    });
    save();
    changed();
  });
  attach(ses);

  // What the user asked for in the downloads list.
  function act({ id, action }) {
    const d = items.find((x) => x.id === id);
    if (!d) return;
    const item = running.get(id);
    if (action === 'pause') item?.pause();
    else if (action === 'resume') item?.resume();
    else if (action === 'cancel') item?.cancel();
    else if (action === 'remove' && !item) items = items.filter((x) => x !== d);
    else if (action === 'allow' && d.state === 'blocked') {
      items = items.filter((x) => x !== d);
      // From the session of the tab it came from; a private one's only while that tab is open.
      const from = tabs.get(d.tab)?.ses || (d.private ? null : ses);
      if (from) {
        allowed.add(d.url);
        from.downloadURL(d.url);
      }
    }
    else if ((action === 'open' || action === 'show') && d.state === 'completed') {
      if (!fs.existsSync(d.file)) d.gone = true;
      else if (action === 'open') shell.openPath(d.file);
      else shell.showItemInFolder(d.file);
    }
    if (item && action === 'pause') d.state = 'paused';
    if (item && action === 'resume') d.state = 'progressing';
    save();
    changed();
  }

  function setAsk(on) {
    ask = !!on;
    save();
    changed();
  }

  // Forget everything that has finished; downloads in progress stay.
  function clear() {
    items = items.filter((d) => running.has(d.id));
    save();
    changed();
  }

  // A private window lists its own downloads, a normal one the others.
  const state = () => ({
    ask,
    items: items.filter((d) => !!d.private === !!tabs.window()?.private).slice(0, KEEP).map((d) => ({
      id: d.id, name: d.name, by: d.by, state: d.state, received: d.received, total: d.total, gone: !!d.gone, live: running.has(d.id),
    })),
  });

  // The last private window closed: its downloads leave the list (finished
  // files stay on disk; one still running is cancelled, as its session is gone).
  function forgetPrivate() {
    for (const d of items) if (d.private) running.get(d.id)?.cancel();
    items = items.filter((d) => !d.private);
    changed();
  }

  return { state, act, setAsk, clear, attach, forgetPrivate };
}

module.exports = { createDownloads };
