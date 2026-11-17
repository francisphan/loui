// The downloads list: a strip under the toolbar (the page shrinks to make room,
// since nothing can be drawn over the page itself), and the toolbar button that
// shows a download is running. Uses $, el and svg from ui.js.
const DOWNLOAD_ICON = svg('<path d="M8 2v8M4.5 6.5 8 10l3.5-3.5M2.5 13.5h11"/>');
$('downloads-toggle').querySelector('.glyph').innerHTML = DOWNLOAD_ICON;

const strip = $('downloads');
const showDownloads = (show) => {
  strip.hidden = !show;
  $('downloads-toggle').classList.toggle('on', show);
  $('downloads-toggle').setAttribute('aria-expanded', show);
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

function describe(d) {
  const sofar = d.total > 0 ? `${size(d.received)} of ${size(d.total)}` : size(d.received);
  if (d.gone) return 'Moved or deleted';
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
function choices(d) {
  if (d.state === 'progressing') return [['pause', 'Pause'], ['cancel', 'Cancel']];
  if (d.state === 'paused' || d.live) return [['resume', 'Resume'], ['cancel', 'Cancel']];
  if (d.state === 'completed' && !d.gone) return [['open', 'Open'], ['show', 'Show in folder']];
  if (d.state === 'blocked') return [['allow', 'Download anyway'], ['remove', 'Remove']];
  return [['remove', 'Remove']];
}

// Rows are kept and updated in place: progress arrives several times a second,
// and rebuilding would drop the focus and hover from the buttons.
const rows = new Map(); // id -> { node, key }
function drawDownloads(downloads) {
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
      row = { node, key: '' };
      rows.set(d.id, row);
    }
    const { node } = row;
    node.className = `download ${d.state}${d.gone ? ' gone' : ''}`;
    node.querySelector('.name').textContent = d.name;
    node.querySelector('.name').title = d.name;
    node.querySelector('.by').textContent = d.by || '';
    node.querySelector('.by').title = d.by ? `Downloaded in ${d.by}'s tab` : '';
    node.querySelector('.detail').textContent = describe(d);
    const live = d.state === 'progressing' || d.state === 'paused';
    node.querySelector('.bar').hidden = !live;
    node.querySelector('.bar span').style.width = d.total > 0 ? `${Math.min(100, (100 * d.received) / d.total)}%` : '0';
    const acts = choices(d);
    const key = acts.map((a) => a[0]).join();
    if (key !== row.key) {
      row.key = key;
      node.querySelector('.acts').replaceChildren(...acts.map(([action, label]) => {
        const button = el('button', 'quiet', label);
        button.type = 'button';
        button.setAttribute('aria-label', `${label} ${d.name}`);
        button.onclick = () => loui.send('download:act', { id: d.id, action });
        return button;
      }));
    }
    return node;
  });
  for (const id of rows.keys()) if (!seen.has(id)) rows.delete(id);
  // Moving a node out of the page drops its focus, so only reorder on a change.
  const list = $('downloads-list');
  if (nodes.length !== list.children.length || nodes.some((n, i) => list.children[i] !== n)) list.replaceChildren(...nodes);

  // The toolbar button: how far along the running downloads are, together.
  const running = items.filter((d) => d.state === 'progressing');
  const known = running.every((d) => d.total > 0);
  const total = running.reduce((n, d) => n + d.total, 0);
  const received = running.reduce((n, d) => n + d.received, 0);
  const toggle = $('downloads-toggle');
  toggle.classList.toggle('running', running.length > 0);
  $('downloads-progress').textContent = !running.length ? ''
    : known && total ? `${Math.floor((100 * received) / total)}%` : 'Downloading';
  toggle.title = running.length
    ? `Downloading ${running.length === 1 ? running[0].name : `${running.length} files`} (Ctrl+J)`
    : 'Downloads (Ctrl+J)';
}

loui.on('state', (next) => drawDownloads(next.downloads));
