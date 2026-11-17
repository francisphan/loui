// History in the window chrome: suggestions while typing in the address bar,
// and the history panel. Loaded after ui.js, whose $, el, setIcon, svg and
// address it uses.

// ── suggestions ─────────────────────────────────────────────────────────────
// The list is drawn by a view in front of the page (src/main/suggest.js); this
// keeps what it shows. The first row is what Enter does: open the address
// (finished inline from a page visited before, as selected text, so typing on
// replaces it and Backspace removes it), or search for the words. Arrows move
// the highlight, which puts that row's address in the bar.
let typed = ''; // what the user typed, before completion and arrowing through suggestions
let offered = []; // the rows on show; the first is what Enter does
let chosen = 0; // the highlighted one
let fresh = false; // whether the rows answer what is in the bar now
let erasing = false; // the last edit deleted: nothing is completed until the next character

function drawSuggestions() {
  if (!offered.length) return loui.send('suggest:hide');
  const r = address.getBoundingClientRect();
  loui.send('suggest:show', { items: offered, chosen, rect: { x: r.x, y: r.bottom, width: r.width } });
}
function dismissSuggestions() {
  offered = [];
  chosen = 0;
  fresh = false;
  loui.send('suggest:hide');
}
// A row chosen with Enter or a click: an open tab is switched to, anything else opened here.
function openSuggestion(row) {
  dismissSuggestions();
  if (row.tab) {
    address.value = activeTab()?.url || '';
    loui.send('tab:reveal', row.tab);
  } else {
    address.value = row.url;
    loui.send('go', row.url);
  }
  address.blur();
}

address.addEventListener('input', (e) => {
  typed = address.value;
  fresh = false;
  erasing = /^delete/.test(e.inputType || '');
  if (typed.trim()) loui.send('suggest:query', typed);
  else dismissSuggestions();
});
// The list follows the address bar when the window is resized.
new ResizeObserver(() => { if (offered.length) drawSuggestions(); }).observe(address);
const shortUrl = (url) => url.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');
loui.on('suggestions', ({ text, items, enter, complete }) => {
  // The user has typed on, or left.
  if (text !== typed || address.value !== typed || document.activeElement !== address) return;
  const fill = !erasing && complete && address.selectionStart === typed.length ? complete : null;
  const first = fill ? { url: fill.url, title: fill.title, note: fill.title ? `Go to ${shortUrl(fill.url)}` : 'Go to address', fill: fill.text, source: 'enter' }
    : enter.search ? { url: enter.url, title: `Search ${enter.search} for “${typed.trim()}”`, note: '', source: 'enter' }
      : { url: enter.url, title: '', note: 'Go to address', source: 'enter' };
  offered = [first, ...items.filter((s) => s.tab || s.url !== first.url)];
  chosen = 0;
  fresh = true;
  if (fill) {
    address.value = fill.text;
    address.setSelectionRange(typed.length, fill.text.length);
  }
  drawSuggestions();
});

// Capturing on the form runs before ui.js's own key handling on the field.
$('address-form').addEventListener('keydown', (e) => {
  if (!offered.length) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = offered.length;
    chosen = (chosen + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
    const row = offered[chosen];
    // Back on the first row the bar shows what was typed again, completed as it was.
    address.value = chosen ? row.url : row.fill || typed;
    if (!chosen && row.fill) address.setSelectionRange(typed.length, row.fill.length);
    drawSuggestions();
  } else if (e.key === 'Escape') {
    e.stopPropagation(); // the first Esc only closes the list
    address.value = typed;
    dismissSuggestions();
  } else if (e.key === 'Enter' && !e.isComposing) {
    // Rows for an earlier text (Enter came before the answer) are not what
    // the user sees in the bar: what is typed is opened as it is (ui.js).
    const row = fresh ? offered[chosen] : null;
    if (!row) return dismissSuggestions();
    e.preventDefault();
    openSuggestion(row);
  }
}, true);

// Leaving the address bar (clicking the page, another window) closes the list.
// A press on the list itself arrives as 'suggest:pick', just after.
address.addEventListener('blur', () => setTimeout(() => {
  if (!document.hasFocus() || document.activeElement !== address) dismissSuggestions();
}, 150));
loui.on('suggest:pick', (picked) => openSuggestion(typeof picked === 'string' ? { url: picked } : { url: picked.url, tab: picked.tab }));

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
  } else focusPage();
}
$('history-toggle').onclick = () => showHistory(!historyOpen());
$('history-close').onclick = () => showHistory(false);
// what: 'clear' from History › Clear history… (Ctrl+Shift+Delete), which opens on the question.
loui.on('show-history', (what) => {
  showHistory(true);
  if (what !== 'clear') return;
  $('history-confirm').hidden = false;
  $('history-confirm-yes').focus();
});
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
// Esc anywhere in the panel: first out of the question, then the panel closes.
$('history').addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if ($('history-confirm').hidden) return showHistory(false);
  $('history-confirm').hidden = true;
  $('history-search').focus();
});
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
