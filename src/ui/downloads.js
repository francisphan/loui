// The downloads list: a strip under the toolbar (the page shrinks to make room,
// since nothing can be drawn over the page itself), and the toolbar button that
// shows a download is running. Uses $, el and svg from ui.js.
const DOWNLOAD_ICON = svg('<path d="M8 2v8M4.5 6.5 8 10l3.5-3.5M2.5 13.5h11"/>');
$('downloads-toggle').querySelector('.glyph').innerHTML = DOWNLOAD_ICON;

const strip = $('downloads');
setIcon($('downloads-close'), 'close');
strip.tabIndex = -1;
// Opened, the strip takes the keyboard (so Esc closes it); closed, the page has it back.
const showDownloads = (show) => {
  strip.hidden = !show;
  $('downloads-toggle').classList.toggle('on', show);
  $('downloads-toggle').setAttribute('aria-expanded', show);
  if (show) strip.focus();
  else focusPage();
};
$('downloads-toggle').onclick = () => showDownloads(strip.hidden);
$('downloads-close').onclick = () => showDownloads(false);
strip.onkeydown = (e) => { if (e.key === 'Escape') showDownloads(false); };
loui.on('toggle-downloads', () => showDownloads(strip.hidden));
$('downloads-ask').onchange = (e) => loui.send('download:ask', e.target.checked);
$('downloads-clear').onclick = () => loui.send('download:clear');

function size(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let n = bytes / 1024, i = 0;
  for (; n >= 1024 && i < units.length - 1; i++) n /= 1024;
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

// Files that run when opened: programs, scripts and shortcuts. "Open" on one
// of these is "Run…", and asks once more in the row before it does.
const RUNS = /\.(exe|msi|bat|cmd|ps1|lnk|url|scr|com|jar|vbs|js)$/i;
const STALLED_MS = 10000;

function lasts(seconds) {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s left`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min left`;
  return `${Math.round(seconds / 3600)} h left`;
}

// pace: { speed (bytes a second, 0 if not known yet), since (when bytes last arrived) }.
function describe(d, pace, now = Date.now()) {
  const sofar = d.total > 0 ? `${size(d.received)} of ${size(d.total)}` : size(d.received);
  if (d.gone) return 'Moved or deleted';
  if (d.state === 'progressing' && pace) {
    if (now - pace.since >= STALLED_MS) return `Stalled, ${sofar}`;
    if (pace.speed > 0 && now - pace.since < 3000) { // a speed measured a while ago says nothing now
      const left = d.total > d.received ? `, ${lasts((d.total - d.received) / pace.speed)}` : '';
      return `${sofar}, ${size(Math.round(pace.speed))}/s${left}`;
    }
  }
  return {
    progressing: sofar,
    paused: `Paused, ${sofar}`,
    completed: size(d.total || d.received),
    cancelled: 'Cancelled',
    interrupted: "Didn't finish",
    blocked: 'Blocked: this page tried to download more files',
  }[d.state] || '';
}

// What each state lets the user do, as [action, label] pairs.
// stalled: it is running, but nothing has arrived for a while.
function choices(d, stalled) {
  if (d.state === 'progressing' && stalled) return [['retry', 'Retry'], ['pause', 'Pause'], ['cancel', 'Cancel']];
  if (d.state === 'progressing') return [['pause', 'Pause'], ['cancel', 'Cancel']];
  if (d.state === 'paused' || d.live) return [['resume', 'Resume'], ['cancel', 'Cancel']];
  if (d.state === 'completed' && !d.gone) return [RUNS.test(d.name) ? ['run', 'Run…'] : ['open', 'Open'], ['show', 'Show in folder'], ['remove', 'Remove']];
  if (d.state === 'completed') return [['remove', 'Remove']];
  if (d.state === 'blocked') return [['allow', 'Download anyway'], ['remove', 'Remove']];
  return [['retry', 'Retry'], ['remove', 'Remove']];
}

// Rows are kept and updated in place: progress arrives several times a second,
// and rebuilding would drop the focus and hover from the buttons.
const rows = new Map(); // id -> { node, key, pace, sure }
let paceTimer = 0;
let lastDownloads = null;
function drawDownloads(downloads) {
  lastDownloads = downloads;
  const now = Date.now();
  const items = downloads?.items || [];
  if (document.activeElement !== $('downloads-ask')) $('downloads-ask').checked = !!downloads?.ask;
  $('downloads-empty').hidden = items.length > 0;
  $('downloads-clear').hidden = !items.some((d) => d.state !== 'progressing' && d.state !== 'paused');

  const seen = new Set();
  const nodes = items.map((d) => {
    seen.add(d.id);
    let row = rows.get(d.id);
    if (!row) {
      const node = el('li', 'download');
      node.append(el('span', 'name'), el('span', 'by'), el('span', 'detail'), el('span', 'bar'), el('span', 'acts'));
      node.querySelector('.bar').append(el('span'));
      row = { node, key: '', pace: { received: d.received, at: now, since: now, speed: 0 }, sure: false };
      rows.set(d.id, row);
    }
    const { node, pace } = row;
    // How fast it is going, from one report to the next (smoothed), and when bytes last came.
    if (d.received !== pace.received) {
      const dt = (now - pace.at) / 1000;
      if (d.received > pace.received && dt > 0.2) {
        const speed = (d.received - pace.received) / dt;
        pace.speed = pace.speed ? pace.speed * 0.7 + speed * 0.3 : speed;
        pace.received = d.received;
        pace.at = now;
      } else if (d.received < pace.received) { // started over
        pace.received = d.received;
        pace.at = now;
        pace.speed = 0;
      }
      pace.since = now;
    }
    if (d.state !== 'progressing') { pace.since = now; pace.at = now; pace.received = d.received; pace.speed = 0; }
    const stalled = d.state === 'progressing' && now - pace.since >= STALLED_MS;
    node.className = `download ${d.state}${d.gone ? ' gone' : ''}${stalled ? ' stalled' : ''}`;
    node.querySelector('.name').textContent = d.name;
    node.querySelector('.name').title = d.name;
    node.querySelector('.by').textContent = d.by || '';
    node.querySelector('.by').title = d.by ? `Downloaded in ${d.by}'s tab` : '';
    node.querySelector('.detail').textContent = describe(d, pace, now);
    const live = d.state === 'progressing' || d.state === 'paused';
    node.querySelector('.bar').hidden = !live;
    // A download that does not say how big it is has a bar that only shows it is going.
    node.querySelector('.bar').classList.toggle('unknown', d.state === 'progressing' && !(d.total > 0) && !stalled);
    node.querySelector('.bar span').style.width = d.total > 0 ? `${Math.min(100, (100 * d.received) / d.total)}%` : '0';
    const acts = choices(d, stalled);
    if (!acts.some((a) => a[0] === 'run')) row.sure = false;
    const key = acts.map((a) => a[0]).join() + (row.sure ? ' sure' : '');
    if (key !== row.key) {
      row.key = key;
      const act = (action, label, name = `${label} ${d.name}`) => {
        const button = el('button', 'quiet', label);
        button.type = 'button';
        button.setAttribute('aria-label', name);
        button.onclick = () => loui.send('download:act', { id: d.id, action });
        return button;
      };
      // "Run…" asks in the row first: a program from the web can do anything on this computer.
      const sure = (on) => () => {
        row.sure = on;
        drawDownloads(lastDownloads);
        node.querySelector(on ? '.acts .quiet' : '.acts .run')?.focus();
      };
      if (row.sure) {
        const ask = el('span', 'sure', 'Run this file? It can change this computer.');
        const no = el('button', 'quiet', 'Cancel');
        no.type = 'button';
        no.onclick = sure(false);
        const yes = act('open', 'Run', `Run ${d.name}`);
        yes.classList.add('danger');
        yes.addEventListener('click', sure(false));
        node.querySelector('.acts').replaceChildren(ask, no, yes);
        node.querySelector('.acts').onkeydown = (e) => { if (e.key === 'Escape') { e.stopPropagation(); sure(false)(); } };
      } else {
        node.querySelector('.acts').onkeydown = null;
        node.querySelector('.acts').replaceChildren(...acts.map(([action, label]) => {
          if (action !== 'run') return act(action, label, action === 'remove' ? `Remove ${d.name} from the list` : undefined);
          const run = el('button', 'quiet run', label);
          run.type = 'button';
          run.setAttribute('aria-label', `Run ${d.name}`);
          run.title = 'This file is a program or shortcut: opening it runs it';
          run.onclick = sure(true);
          return run;
        }));
      }
    }
    return node;
  });
  for (const id of rows.keys()) if (!seen.has(id)) rows.delete(id);
  // Moving a node out of the page drops its focus, so only reorder on a change.
  const list = $('downloads-list');
  if (nodes.length !== list.children.length || nodes.some((n, i) => list.children[i] !== n)) list.replaceChildren(...nodes);

  // Speed, time left and "Stalled" change with the clock too, not only when bytes arrive.
  clearTimeout(paceTimer);
  if (items.some((d) => d.state === 'progressing')) paceTimer = setTimeout(() => drawDownloads(lastDownloads), 1000);

  // The toolbar button: how far along the running downloads are, together.
  const running = items.filter((d) => d.state === 'progressing');
  const known = running.every((d) => d.total > 0);
  const total = running.reduce((n, d) => n + d.total, 0);
  const received = running.reduce((n, d) => n + d.received, 0);
  const toggle = $('downloads-toggle');
  // Stalled: none of them has had anything arrive for a while. A percentage would say it is going.
  const stalled = running.length > 0 && running.every((d) => now - rows.get(d.id).pace.since >= STALLED_MS);
  toggle.classList.toggle('running', running.length > 0);
  toggle.classList.toggle('stalled', stalled);
  $('downloads-progress').textContent = !running.length ? ''
    : stalled ? 'Stalled'
      : known && total ? `${Math.floor((100 * received) / total)}%` : 'Downloading';
  const what = running.length === 1 ? running[0].name : `${running.length} files`;
  toggle.title = stalled ? `Stalled: ${what}. Open the list to retry (Ctrl+J)`
    : running.length ? `Downloading ${what} (Ctrl+J)`
      : 'Downloads (Ctrl+J)';
}

loui.on('state', (next) => drawDownloads(next.downloads));
