// History in the window chrome: suggestions while typing in the address bar,
// and the history panel. Loaded after ui.js, whose $, el, setIcon, svg and
// address it uses.

// ── suggestions ─────────────────────────────────────────────────────────────
// The list is drawn by a view in front of the page (src/main/suggest.js); this
// keeps what it shows. Arrows move the highlight, which puts that page's
// address in the bar, so Enter (ui.js's submit) opens it.
let typed = ''; // what the user typed, before arrowing through suggestions
let offered = []; // the suggestions on show
let chosen = -1; // the highlighted one, or -1 for none

function drawSuggestions() {
  if (!offered.length) return loui.send('suggest:hide');
  const r = address.getBoundingClientRect();
  loui.send('suggest:show', { items: offered, chosen, rect: { x: r.x, y: r.bottom, width: r.width } });
}
function dismissSuggestions() {
  offered = [];
  chosen = -1;
  loui.send('suggest:hide');
}

address.addEventListener('input', () => {
  typed = address.value;
  if (typed.trim()) loui.send('suggest:query', typed);
  else dismissSuggestions();
});
// The list follows the address bar when the window is resized.
new ResizeObserver(() => { if (offered.length) drawSuggestions(); }).observe(address);
loui.on('suggestions', ({ text, items }) => {
  if (text !== typed || document.activeElement !== address) return; // the user has typed on, or left
  offered = items;
  chosen = -1;
  drawSuggestions();
});

// Capturing on the form runs before ui.js's own key handling on the field.
$('address-form').addEventListener('keydown', (e) => {
  if (!offered.length) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    // Positions run from "none" (what was typed) through each suggestion and round again.
    const n = offered.length + 1;
    chosen = ((chosen + 1 + (e.key === 'ArrowDown' ? 1 : -1) + n) % n) - 1;
    address.value = chosen < 0 ? typed : offered[chosen].url;
    drawSuggestions();
  } else if (e.key === 'Escape') {
    e.stopPropagation(); // the first Esc only closes the list
    address.value = typed;
    dismissSuggestions();
  } else if (e.key === 'Enter') {
    dismissSuggestions();
  }
}, true);

// Leaving the address bar (clicking the page, another window) closes the list.
// A press on the list itself arrives as 'suggest:pick', just after.
address.addEventListener('blur', () => setTimeout(() => {
  if (!document.hasFocus() || document.activeElement !== address) dismissSuggestions();
}, 150));
loui.on('suggest:pick', (url) => {
  dismissSuggestions();
  address.value = url;
  loui.send('go', url);
  address.blur();
});

// ── history panel ───────────────────────────────────────────────────────────
// Takes the Claude panel's place while open.
ICON.history = svg('<circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/>');
setIcon($('history-toggle'), 'history');
setIcon($('history-close'), 'close');

const historyOpen = () => document.body.classList.contains('history-open');
function showHistory(show) {
  document.body.classList.toggle('history-open', show);
  $('history').hidden = !show;
  $('history-toggle').classList.toggle('on', show);
  $('panel-toggle').classList.toggle('on', !show && panelOpen());
  $('history-confirm').hidden = true;
  if (show) {
    loui.send('history:list', $('history-search').value);
    $('history-search').focus();
  }
}
$('history-toggle').onclick = () => showHistory(!historyOpen());
$('history-close').onclick = () => showHistory(false);
loui.on('show-history', () => showHistory(true));
// Asking for the Claude panel while this one is open brings it back.
const claudeInstead = () => {
  if (!historyOpen()) return;
  showHistory(false);
  togglePanel(true);
};
$('panel-toggle').addEventListener('click', claudeInstead);
loui.on('toggle-panel', claudeInstead);
loui.on('show-relay', claudeInstead);

$('history-search').oninput = () => loui.send('history:list', $('history-search').value);
$('history-search').onkeydown = (e) => { if (e.key === 'Escape') showHistory(false); };
$('history-clear').onclick = () => { $('history-confirm').hidden = false; };
$('history-confirm-no').onclick = () => { $('history-confirm').hidden = true; };
$('history-confirm-yes').onclick = () => {
  $('history-confirm').hidden = true;
  loui.send('history:clear');
};
loui.on('history:changed', () => { if (historyOpen()) loui.send('history:list', $('history-search').value); });

const dayOf = (time) => {
  const d = new Date(time);
  const today = new Date();
  const yesterday = new Date(Date.now() - 864e5);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
};
const plainUrl = (url) => url.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');

loui.on('history', ({ query, items }) => {
  if (query !== $('history-search').value) return; // an older search
  const nodes = [];
  let day = '';
  for (const h of items) {
    const label = dayOf(h.last);
    if (label !== day) nodes.push(el('h2', '', (day = label)));
    const row = el('div', 'history-row');
    row.dataset.url = h.url;
    const open = el('button', 'open');
    open.type = 'button';
    open.title = h.url;
    open.append(el('span', 'title', h.title || plainUrl(h.url)), el('span', 'url', plainUrl(h.url)));
    open.onclick = () => loui.send('go', h.url);
    const when = el('span', 'when', new Date(h.last).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }));
    when.title = h.visits === 1 ? 'Visited once' : `Visited ${h.visits} times`;
    const remove = el('button', 'remove');
    remove.type = 'button';
    remove.title = 'Remove from history';
    remove.setAttribute('aria-label', `Remove ${h.title || plainUrl(h.url)} from history`);
    setIcon(remove, 'close');
    remove.onclick = () => loui.send('history:remove', h.url);
    row.append(open, when, remove);
    nodes.push(row);
  }
  if (!nodes.length) {
    nodes.push(el('p', 'none', query.trim() ? 'No pages in your history match that.' : 'Pages you visit show up here.'));
  }
  $('history-list').replaceChildren(...nodes);
  $('history-clear').disabled = !items.length && !query.trim();
});
