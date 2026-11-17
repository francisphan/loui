// The task manager (Shift+Esc, View › Task manager): what each tab, the window
// and Loui's background processes cost in memory and CPU, like Brave's.
//
// It is a small window of its own rather than part of the window chrome. Tab
// pages are native views stacked over the chrome, so anything the chrome
// draws in the page area is hidden under the page; a sheet in the panel would
// have to squeeze the page area of every tab while open. A window of its own
// can sit beside the tab being watched, and it is created when opened and
// destroyed when closed: the measuring timer runs only while it exists, so a
// closed task manager costs nothing.
//
// Chromium reports processes, not tabs (app.getAppMetrics). Each process is
// matched to what runs in it through getOSProcessId() of every page Loui
// knows of, and through each tab's frames (a frame from another site may run
// in a process of its own). Several tabs can share one process, and its
// memory cannot be split between them, so a process is one entry listing
// everything in it, with its numbers once.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { BrowserWindow, ipcMain, app, nativeTheme, webContents } = require('electron');
const { YOU } = require('./tabs');

const EVERY = 1500; // ms between measurements while the window is open

// Electron's process types, as people would name them.
const KIND = {
  Browser: 'Loui (main process)',
  GPU: 'GPU process',
  Zygote: 'Process launcher',
  'Sandbox helper': 'Sandbox helper',
  Utility: 'Utility process',
};

// Private memory of a process on Linux, in KB, where /proc lets us read it
// (Chromium's sandboxed processes can refuse). Electron reports it only on Windows.
async function linuxPrivate(pid) {
  try {
    const text = await fs.promises.readFile(`/proc/${pid}/smaps_rollup`, 'utf8');
    let kb = 0;
    for (const m of text.matchAll(/^Private_(?:Clean|Dirty):\s+(\d+) kB/gm)) kb += Number(m[1]);
    return kb;
  } catch {
    return null;
  }
}

// A process outside Chromium (the Claude panel's Claude Code), measured from
// the outside. cpu is cumulative seconds; the caller turns it into a rate.
async function measureOther(pid) {
  if (process.platform === 'win32') {
    // tasklist reports CPU time to the second only, so the rate is coarse.
    return new Promise((resolve) => {
      execFile('tasklist', ['/V', '/FO', 'CSV', '/NH', '/FI', `PID eq ${pid}`], { windowsHide: true, timeout: 5000 },
        (err, out) => {
          const cells = !err && out.match(/"[^"]*"/g)?.map((c) => c.slice(1, -1));
          if (!cells || Number(cells[1]) !== pid) return resolve(null);
          const [h, m, s] = cells[7].split(':').map(Number);
          resolve({ workingSet: Number(cells[4].replace(/\D/g, '')), private: null, cpu: h * 3600 + m * 60 + s });
        });
    });
  }
  try {
    const stat = await fs.promises.readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' '); // the name may hold spaces
    const status = await fs.promises.readFile(`/proc/${pid}/status`, 'utf8');
    const rss = Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] || 0);
    // utime and stime, in clock ticks of 1/100 s on Linux.
    return { workingSet: rss, private: await linuxPrivate(pid), cpu: (Number(fields[11]) + Number(fields[12])) / 100 };
  } catch {
    return null;
  }
}

// tabs, sleep: the browser's. pages(): Loui's own pages, [{ label, wc }].
// claude(): the Claude panel's Claude Code process while it runs, { pid, wsl }.
function createTaskManager({ tabs, sleep, pages, claude, lockToApp, focusMain }) {
  let win = null;
  let timer = null;
  let measuring = false;
  const watched = []; // test only: other processes to list (see probes)
  const lastCpu = new Map(); // pid -> { cpu, at }, for processes measured from outside

  const live = (wc) => wc && !wc.isDestroyed();
  const groupLabel = (id) => (id === YOU ? null : tabs.group(id)?.label || 'Claude');

  // What runs where, and what it costs: { processes, asleep }.
  async function measure() {
    const metrics = app.getAppMetrics();
    const byPid = new Map(metrics.map((m) => [m.pid, {
      pid: m.pid,
      type: m.type,
      name: m.name || m.serviceName || '',
      cpu: m.cpu.percentCPUUsage,
      workingSet: m.memory.workingSetSize,
      private: m.memory.privateBytes ?? null,
      members: [],
    }]));
    const add = (pid, member) => byPid.get(pid)?.members.push(member);
    const known = new Set();

    const own = win ? [{ label: 'Task manager', wc: win.webContents }] : [];
    for (const p of [...pages(), ...own]) {
      if (!live(p.wc)) continue;
      known.add(p.wc.id);
      add(p.wc.getOSProcessId(), { kind: 'page', label: p.label });
    }
    const asleep = [];
    for (const tab of tabs.list) {
      const tag = { group: groupLabel(tab.group), title: tab.title || tab.url || 'New tab' };
      if (tab.asleep || !live(tab.wc)) {
        asleep.push({ kind: 'tab', id: tab.id, ...tag, asleep: true, canClose: true, canSleep: false });
        continue;
      }
      known.add(tab.wc.id);
      const pid = tab.wc.getOSProcessId();
      add(pid, {
        kind: 'tab', id: tab.id, ...tag,
        canClose: true, canSleep: !!sleep.mayRest?.(tab),
      });
      // Frames from other sites that Chromium put in processes of their own.
      const seen = new Set([pid]);
      for (const frame of tab.wc.mainFrame?.framesInSubtree || []) {
        const fp = frame.osProcessId;
        if (seen.has(fp)) continue;
        seen.add(fp);
        add(fp, { kind: 'subframe', label: `Frame from ${frame.origin || frame.url}`, in: tag.title });
      }
    }
    for (const wc of webContents.getAllWebContents()) {
      if (known.has(wc.id) || !live(wc)) continue;
      const devtools = wc.getType() === 'remote' || wc.getURL().startsWith('devtools:');
      add(wc.getOSProcessId(), { kind: 'page', label: devtools ? 'Developer tools' : `Page: ${wc.getURL() || 'blank'}` });
    }

    const processes = [...byPid.values()];
    for (const p of processes) {
      if (p.members.length) continue;
      // A renderer with nothing in it is the spare Chromium keeps ready for the next page.
      const label = p.type === 'Tab' ? 'Spare page process' : p.type === 'Utility' && p.name ? p.name : KIND[p.type] || p.type;
      p.members.push({ kind: p.type === 'Browser' ? 'main' : 'process', label });
    }
    if (process.platform !== 'win32') {
      await Promise.all(processes.map(async (p) => { p.private = await linuxPrivate(p.pid); }));
    }

    // The Claude panel's Claude Code, which Chromium does not know about.
    const others = [claude(), ...watched].filter(Boolean);
    const now = Date.now();
    for (const o of others) {
      const label = o.label || 'Claude Code (the Claude panel)';
      if (o.wsl) {
        // Started through wsl.exe: Claude Code itself runs inside WSL's
        // virtual machine, where Windows cannot measure it on its own.
        processes.push({ pid: o.pid, type: 'Claude', cpu: null, workingSet: null, private: null,
          note: 'Runs inside WSL; its use counts toward WSL (VmmemWSL)', members: [{ kind: 'claude', label }] });
        continue;
      }
      const m = await measureOther(o.pid);
      if (!m) continue;
      const before = lastCpu.get(o.pid);
      lastCpu.set(o.pid, { cpu: m.cpu, at: now });
      const cpu = before ? Math.max(0, ((m.cpu - before.cpu) / ((now - before.at) / 1000)) * 100) : 0;
      processes.push({ pid: o.pid, type: 'Claude', cpu, workingSet: m.workingSet, private: m.private,
        members: [{ kind: 'claude', label }] });
    }
    for (const pid of lastCpu.keys()) if (!others.some((o) => o.pid === pid)) lastCpu.delete(pid);

    return { processes: processes.map(({ members, ...p }) => ({ ...p, members })), asleep };
  }

  async function refresh() {
    if (!win || measuring) return;
    measuring = true;
    try {
      const report = await measure();
      if (live(win?.webContents)) win.webContents.send('taskmanager', report);
    } finally {
      measuring = false;
    }
  }

  function open() {
    if (win) {
      if (win.isMinimized()) win.restore();
      return win.focus();
    }
    win = new BrowserWindow({
      width: 820, height: 540, minWidth: 560, minHeight: 300,
      title: 'Task manager',
      icon: path.join(__dirname, '../ui/icon.png'),
      autoHideMenuBar: true,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#101B22' : '#E6EDEF',
      webPreferences: {
        preload: path.join(__dirname, 'taskmanager-preload.js'), sandbox: true, contextIsolation: true,
      },
    });
    win.setMenu(null);
    lockToApp(win.webContents);
    win.webContents.on('did-finish-load', refresh);
    win.loadFile(path.join(__dirname, '../ui/taskmanager.html'));
    timer = setInterval(refresh, EVERY);
    win.on('closed', () => {
      clearInterval(timer);
      timer = null;
      win = null;
      lastCpu.clear();
    });
  }

  function act({ action, id } = {}) {
    const tab = tabs.get(id);
    if (!tab) return false;
    let done = true;
    if (action === 'close') tabs.close(id);
    else if (action === 'sleep') done = sleep.sleepNow(id);
    else if (action === 'show') { tabs.select(id); focusMain(); }
    else return false;
    setTimeout(refresh, 100);
    return done;
  }

  // Only the task manager's own page may ask.
  ipcMain.on('taskmanager:act', (e, request) => {
    if (win && e.sender === win.webContents) act(request);
  });
  ipcMain.on('taskmanager:close', (e) => {
    if (win && e.sender === win.webContents) win.close();
  });

  // For the tests (LOUI_TEST only).
  const probes = {
    'taskmanager:open': () => { open(); return 'ok'; },
    'taskmanager:close': () => { win?.close(); return 'ok'; },
    'taskmanager:state': () => ({ open: !!win, measuring: !!timer }),
    'taskmanager:measure': () => measure(),
    // What the window shows: its rows as text, once it has drawn a report.
    'taskmanager:rows': () => (win ? win.webContents.executeJavaScript('window.rowsForTest?.() || null') : null),
    'taskmanager:act': (request) => act(request),
    'taskmanager:sort': (key) => (win ? win.webContents.executeJavaScript(`window.sortForTest(${JSON.stringify(key)})`) : null),
    // Runs a script in the window's page, as a click there would.
    'taskmanager:js': (code) => (win ? win.webContents.executeJavaScript(code) : null),
    'taskmanager:url': () => win?.webContents.getURL() ?? null,
    // Lists another process as if it were the Claude panel's (which needs a Claude login).
    'taskmanager:watch': (other) => { watched.push(other); return 'ok'; },
  };

  return { open, probes, isOpen: () => !!win };
}

module.exports = { createTaskManager };
