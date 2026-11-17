// The task manager window (see src/main/taskmanager.js). The main process
// sends a report every second and a half while the window is open; this page
// draws it and asks for actions on a tab. Titles are set with textContent,
// never as HTML.
const table = document.getElementById('tm-table');
const buttons = {
  show: document.getElementById('tm-show'),
  sleep: document.getElementById('tm-sleep'),
  close: document.getElementById('tm-close'),
};

let report = { processes: [], asleep: [] };
let sort = { key: null, down: true }; // null: Loui first, then pages, then the rest
let selected = null; // the id of the selected tab

// The order before any column is sorted: what people look for first.
const RANK = { main: 0, page: 1, process: 2, tab: 3, subframe: 4, claude: 5 };

const mb = (kb) => (kb == null ? '—' : kb < 10240 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.round(kb / 1024)} MB`);
const pct = (cpu) => (cpu == null ? '—' : cpu.toFixed(1));

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

// One entry per process, holding everything in it; sleeping tabs are
// entries of their own, with nothing running and so nothing used.
function entries() {
  const list = report.processes.map((p) => ({ ...p, label: p.members.map(name).join(' ') }));
  for (const t of report.asleep) {
    list.push({ pid: null, cpu: 0, workingSet: 0, private: 0, members: [t], label: name(t) });
  }
  const rank = (e) => Math.min(...e.members.map((m) => RANK[m.kind] ?? 9));
  const { key, down } = sort;
  if (!key) return list.sort((a, b) => rank(a) - rank(b));
  const value = (e) => (key === 'task' ? e.label.toLowerCase() : e[key] ?? -1);
  return list.sort((a, b) => {
    const x = value(a), y = value(b);
    const order = typeof x === 'string' ? x.localeCompare(y) : x - y;
    return (key === 'task' ? order : -order) * (down ? 1 : -1);
  });
}

function name(m) {
  if (m.kind === 'tab') return `Tab: ${m.title}`;
  if (m.kind === 'subframe') return `${m.label} (in ${m.in})`;
  return m.label;
}

function memberCell(m) {
  const cell = el('div', 'tm-cell');
  if (m.kind === 'tab') {
    cell.append(el('span', 'tm-kind', 'Tab'));
    if (m.group) cell.append(el('span', 'tm-group', m.group));
    cell.append(el('span', 'tm-title', m.title));
    if (m.asleep) cell.append(el('span', 'tm-asleep', 'Asleep'));
  } else {
    cell.append(el('span', 'tm-title', name(m)));
  }
  const td = el('td', 'tm-name');
  td.append(cell);
  return td;
}

function draw() {
  const bodies = entries().map((e) => {
    const body = el('tbody', e.members.length > 1 ? 'tm-shared' : '');
    e.members.forEach((m, i) => {
      const row = el('tr', m.kind === 'tab' ? 'tm-tab' : '');
      if (m.asleep) row.classList.add('tm-sleeping');
      if (m.kind === 'tab') {
        row.dataset.id = m.id;
        row.tabIndex = 0;
        if (m.id === selected) row.classList.add('tm-selected');
        row.onclick = () => choose(m.id);
        row.ondblclick = () => loui.act('show', m.id);
      }
      row.append(memberCell(m));
      if (i === 0) {
        const span = e.members.length;
        for (const text of [mb(e.private), mb(e.workingSet), pct(e.cpu), e.pid ?? '—']) {
          const cell = el('td', 'tm-num', String(text));
          cell.rowSpan = span;
          row.append(cell);
        }
        const cell = row.querySelector('.tm-cell');
        if (e.note) cell.append(el('span', 'tm-note', e.note));
        if (span > 1) cell.append(el('span', 'tm-note', `${span} share this process`));
      }
      body.append(row);
    });
    return body;
  });
  for (const old of table.querySelectorAll('tbody')) old.remove();
  table.append(...bodies);
  for (const th of table.querySelectorAll('th button')) {
    const on = th.dataset.sort === sort.key;
    th.parentElement.setAttribute('aria-sort', on ? (sort.down ? 'descending' : 'ascending') : 'none');
  }
  updateButtons();
}

function find(id) {
  for (const p of report.processes) for (const m of p.members) if (m.id === id && m.kind === 'tab') return m;
  return report.asleep.find((t) => t.id === id) || null;
}

function updateButtons() {
  const tab = selected == null ? null : find(selected);
  if (!tab) selected = null;
  buttons.show.disabled = !tab;
  buttons.close.disabled = !tab?.canClose;
  buttons.sleep.disabled = !tab?.canSleep;
}

function choose(id) {
  selected = id;
  for (const row of table.querySelectorAll('tr.tm-tab')) row.classList.toggle('tm-selected', Number(row.dataset.id) === id);
  updateButtons();
}

for (const [action, button] of Object.entries(buttons)) {
  button.onclick = () => { if (selected != null) loui.act(action, selected); };
}

for (const button of table.querySelectorAll('th button')) {
  button.onclick = () => setSort(button.dataset.sort);
}
function setSort(key) {
  // Numbers sort largest first, names A to Z; a second click turns it round.
  sort = sort.key === key ? { key, down: !sort.down } : { key, down: true };
  draw();
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') loui.close();
  if (e.key === 'Delete' && selected != null) loui.act('close', selected);
  if (e.key === 'Enter' && selected != null) loui.act('show', selected);
});

loui.onReport((next) => {
  report = next;
  draw();
});

// For the tests: what is on screen, one entry per process.
window.rowsForTest = () => [...table.querySelectorAll('tbody')].map((body) => ({
  names: [...body.querySelectorAll('td.tm-name .tm-title')].map((t) => t.textContent),
  groups: [...body.querySelectorAll('td.tm-name')].map((t) => t.querySelector('.tm-group')?.textContent || null),
  asleep: !!body.querySelector('.tm-sleeping'),
  numbers: [...body.querySelectorAll('td.tm-num')].map((t) => t.textContent),
}));
window.sortForTest = (key) => { setSort(key); return sort; };
