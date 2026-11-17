// The command palette, drawn in a view of its own in front of the page (see
// src/main/palette.js). The main process does the searching and runs what is
// chosen; this page draws the results and keeps the highlight. Titles from web
// pages are set with textContent, never as HTML.
const card = document.getElementById('palette');
const input = document.getElementById('palette-input');
const list = document.getElementById('palette-list');

const PLACEHOLDER = {
  all: 'Search tabs, bookmarks, history and commands',
  tabs: 'Search open tabs',
};

let rows = []; // every row on show, in order: { item, node, group }
let chosen = 0;
let asked = 0; // the latest query, so an older answer arriving late is dropped

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

// text with the ranges in marks ([start, end)) wrapped in <mark>.
function marked(className, text, marks = []) {
  const node = el('span', className);
  let at = 0;
  for (const [start, end] of marks) {
    if (start < at || end > text.length) continue;
    node.append(text.slice(at, start), el('mark', null, text.slice(start, end)));
    at = end;
  }
  node.append(text.slice(at));
  return node;
}

function choose(i) {
  if (!rows.length) return;
  chosen = (i + rows.length) % rows.length;
  rows.forEach((r, n) => {
    r.node.classList.toggle('chosen', n === chosen);
    r.node.setAttribute('aria-selected', n === chosen);
  });
  const node = rows[chosen].node;
  input.setAttribute('aria-activedescendant', node.id);
  node.scrollIntoView({ block: 'nearest' });
}

function draw(groups) {
  rows = [];
  list.replaceChildren(...groups.map((g, gi) => {
    const section = el('div', 'palette-group');
    section.setAttribute('role', 'group');
    const label = el('div', 'palette-label', g.label);
    label.id = `palette-g${gi}`;
    section.setAttribute('aria-labelledby', label.id);
    section.append(label);
    for (const item of g.items) {
      const n = rows.length;
      const node = el('div', `palette-row kind-${item.kind}${item.disabled ? ' disabled' : ''}`);
      node.id = `palette-r${n}`;
      node.setAttribute('role', 'option');
      if (item.disabled) node.setAttribute('aria-disabled', 'true');
      const text = el('span', 'text');
      text.append(marked('title', item.title, item.titleMarks));
      if (item.detail) text.append(marked('detail', item.detail, item.detailMarks));
      node.append(text);
      if (item.badge) node.append(el('span', 'badge', item.badge));
      if (item.checked != null) node.append(el('span', 'state' + (item.checked ? ' on' : ''), item.checked ? 'On' : 'Off'));
      if (item.hint && item.kind === 'command') node.append(el('kbd', null, item.hint));
      else if (item.hint) node.append(el('span', 'hint', item.hint));
      // On press, not on click, so the search box keeps the keyboard.
      node.onmousedown = (e) => {
        e.preventDefault();
        if (e.button === 0) { choose(n); run(); }
      };
      node.onmousemove = () => { if (chosen !== n) choose(n); };
      section.append(node);
      rows.push({ item, node, group: gi });
    }
    return section;
  }));
  if (!rows.length) list.append(el('div', 'palette-empty', input.value.trim() ? 'Nothing matches' : 'No open tabs'));
  choose(0);
}

async function refresh() {
  const mine = ++asked;
  const text = input.value;
  const answer = await palette.query(text);
  if (mine !== asked || !answer) return;
  list.dataset.answers = text; // what the rows on show were found for
  draw(answer.groups);
}

function run() {
  const row = rows[chosen];
  if (row && !row.item.disabled) palette.choose(row.item.key);
}

// Tab and Shift+Tab: the first row of the next (or previous) group.
function jump(step) {
  if (!rows.length) return;
  const here = rows[chosen].group;
  const groups = [...new Set(rows.map((r) => r.group))];
  const to = groups[(groups.indexOf(here) + step + groups.length) % groups.length];
  choose(rows.findIndex((r) => r.group === to));
}

input.oninput = refresh;
input.onkeydown = (e) => {
  if (e.isComposing) return;
  const keys = {
    ArrowDown: () => choose(chosen + 1),
    ArrowUp: () => choose(chosen - 1),
    Tab: () => jump(e.shiftKey ? -1 : 1),
    PageDown: () => choose(Math.min(rows.length - 1, chosen + 5)),
    PageUp: () => choose(Math.max(0, chosen - 5)),
    Enter: run,
    Escape: () => palette.close(),
  };
  if (!keys[e.key]) return;
  e.preventDefault();
  keys[e.key]();
};

// A press anywhere beside the card closes it; inside it, the search box keeps
// the keyboard.
document.addEventListener('mousedown', (e) => {
  if (!card.contains(e.target)) palette.close();
  else if (e.target !== input) e.preventDefault();
});

palette.onOpen(({ mode }) => {
  input.placeholder = PLACEHOLDER[mode] || PLACEHOLDER.all;
  input.setAttribute('aria-label', input.placeholder);
  input.value = '';
  // Last time's results go at once rather than when the new ones arrive.
  rows = [];
  list.replaceChildren();
  delete list.dataset.answers;
  input.focus();
  refresh();
});
