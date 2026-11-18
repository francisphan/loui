// Window chrome: tab strip, toolbar, and the Claude panel. All state comes from
// the main process as one 'state' object; this file only draws it and sends
// the user's intentions back. Text from web pages is always set with
// textContent, never as HTML.
// `loui` is the bridge that src/main/preload.js puts on the window.
const $ = (id) => document.getElementById(id);
const YOU = 'you';

const svg = (body, size = 16) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 16 16" aria-hidden="true">${body}</svg>`;
const ICON = {
  back: svg('<path d="M10 3 5 8l5 5"/>'),
  forward: svg('<path d="m6 3 5 5-5 5"/>'),
  reload: svg('<path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M13 2.5v3h-3"/>'),
  stop: svg('<path d="m4 4 8 8M12 4l-8 8"/>'),
  plus: svg('<path d="M8 3v10M3 8h10"/>'),
  close: svg('<path d="m4.5 4.5 7 7M11.5 4.5l-7 7"/>', 12),
  point: svg('<circle cx="8" cy="8" r="4.5"/><path d="M8 1v3M8 12v3M1 8h3M12 8h3"/>'),
  device: svg('<rect x="4.5" y="1.5" width="7" height="13" rx="1.5"/><path d="M7.2 12.2h1.6"/>'),
  devtools: svg('<path d="m5 4.5-3.5 3.5L5 11.5M11 4.5l3.5 3.5-3.5 3.5M9.2 3 6.8 13"/>'),
  panel: svg('<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M10 2.5v11"/>'),
  menu: svg('<path d="M8 3.5v.01M8 8v.01M8 12.5v.01" stroke-width="2.4"/>'),
  mask: svg('<path d="M1.5 5.5c2.2-1 4.3-1 6.5 0 2.2-1 4.3-1 6.5 0-.2 3.2-1.6 5-3.6 5-1.3 0-2-.9-2.9-.9s-1.6.9-2.9.9c-2 0-3.4-1.8-3.6-5z"/><path d="M4.5 7.5h1.8M9.7 7.5h1.8"/>', 13),
};
const setIcon = (el, name) => { el.innerHTML = ICON[name]; };
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

let state = { tabs: [], groups: [], asking: null, prompt: null, waiting: [], picking: {}, picks: [], link: {} };
let running = false; // a panel conversation turn is in flight

const activeTab = () => state.tabs.find((t) => t.active);
const groupOf = (id) => state.groups.find((g) => g.id === id);

// The keyboard goes back to the page once nothing in the window chrome holds
// it: after Esc in the address bar, and when a panel or strip closes (unless
// another one opened in its place and took the keyboard).
const focusPage = () => setTimeout(() => {
  const at = document.activeElement;
  if (!at || at === document.body || at.closest('[hidden]')) loui.send('page:focus');
}, 0);

// A button whose action cannot be undone asks first, in place: while needed()
// holds it turns into the question for a few seconds, and pressing it again
// does it. Esc, or waiting, leaves things as they are.
function askFirst(button, question, needed, act) {
  let timer = 0, label = '';
  const rest = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = 0;
    button.textContent = label;
    button.classList.remove('sure');
  };
  button.addEventListener('click', () => {
    if (timer || !needed()) { rest(); return act(); }
    label = button.textContent;
    button.textContent = question;
    button.classList.add('sure');
    timer = setTimeout(rest, 5000);
  });
  button.addEventListener('keydown', (e) => { if (e.key === 'Escape' && timer) { e.stopPropagation(); rest(); } });
}

// ── toolbar ─────────────────────────────────────────────────────────────────
setIcon($('newtab'), 'plus');
setIcon($('back'), 'back');
setIcon($('forward'), 'forward');
setIcon($('panel-toggle'), 'panel');
setIcon($('menu'), 'menu');
setIcon($('point').querySelector('.glyph'), 'point');
setIcon($('point-here').querySelector('.glyph'), 'point');
setIcon($('device').querySelector('.glyph'), 'device');

$('newtab').onclick = () => loui.send('tab:new');
$('back').onclick = () => loui.send('back');
$('forward').onclick = () => loui.send('forward');
$('reload').onclick = () => loui.send('reload');
$('device').onclick = () => loui.send('device:menu');
$('point').onclick = $('point-here').onclick = () =>
  loui.send(state.picking.active ? 'pick:cancel' : 'pick:start');

// The window has no menu bar: the application menu drops from this button.
$('menu').onclick = () => {
  const r = $('menu').getBoundingClientRect();
  loui.send('menu:show', { x: r.left, y: r.bottom + 2 });
};
loui.on('show-menu', () => $('menu').click()); // Alt+F, F10
// Louis, at the top left, drops Loui's own menu: how it looks and is set up.
$('brand').onclick = () => {
  const r = $('brand').firstElementChild.getBoundingClientRect();
  $('brand').setAttribute('aria-expanded', 'true');
  loui.send('louis:menu', { x: r.left, y: r.bottom + 2 });
};
loui.on('show-louis', () => $('brand').click()); // Alt+L
loui.on('louis:closed', () => $('brand').setAttribute('aria-expanded', 'false'));

const address = $('address');
$('address-form').onsubmit = (e) => {
  e.preventDefault();
  loui.send('go', address.value);
  address.blur();
};
address.onfocus = () => address.select();
let addressTyped = false; // the owner has typed in the field since it took the keyboard
let addressTab = null; // the tab whose address it shows
address.addEventListener('focus', () => { addressTyped = false; });
address.addEventListener('input', () => { addressTyped = true; });
address.onkeydown = (e) => {
  if (e.key !== 'Escape') return;
  address.value = activeTab()?.url || '';
  address.blur();
  focusPage();
};
// text: what was typed on the start page, which has no address bar of its own
// (startpage.js): it goes in as if typed here, so the suggestions follow.
loui.on('focus-address', (text) => {
  if (document.activeElement !== address) address.focus(); // selects what is there: typing replaces it
  if (typeof text !== 'string' || !text) return;
  address.setRangeText(text, address.selectionStart, address.selectionEnd, 'end');
  address.dispatchEvent(new Event('input', { bubbles: true }));
});

const panelOpen = () => !document.body.classList.contains('panel-closed');
const togglePanel = (open) => {
  document.body.classList.toggle('panel-closed', open === true ? false : undefined);
  $('panel-toggle').classList.toggle('on', panelOpen());
  loui.send('panel:shown', panelOpen()); // the Claude menu's checkbox follows
};
$('panel-toggle').onclick = () => togglePanel();
$('panel-toggle').classList.add('on');
loui.on('toggle-panel', (open) => togglePanel(open)); // open: true from "Ask Claude" in the command palette

// The page is a native view placed over #stage; tell the main process where
// that is. Once straight away (measuring forces layout, so this needs no
// repaint, which a covered or busy window may not get for a while), and again
// whenever it changes.
const sendLayout = () => {
  const r = $('stage').getBoundingClientRect();
  loui.send('layout', {
    x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height),
  });
};
sendLayout();
new ResizeObserver(sendLayout).observe($('stage'));

// A page without an icon is marked by a letter on a small tile: the first of
// its site's own name ("G" for accounts.google.com), or of its title for a
// page with no address. A page on this machine (localhost, an IP address) is
// marked by its title's letter on a tile tinted by its port, so that the pages
// being developed do not all look the same.
const TWO_PART = /\.(com?|org|net|gov|edu|ac)\.[a-z]{2}$/; // co.uk, com.ar, com.au: the name is the label before
function letterOf(t) {
  let name = t.title, hue = '';
  try {
    const u = new URL(t.url);
    const host = u.hostname.replace(/^www\./, '');
    if (host === 'localhost' || host.endsWith('.localhost') || /^[\d.]+$|^\[/.test(host)) {
      if (!name || name === t.url) name = host; // no title yet
      if (u.port) hue = ` hue-${u.port % 7 % 5}`;
    } else if (host) {
      const labels = host.split('.');
      name = labels[Math.max(0, labels.length - (TWO_PART.test(host) ? 3 : 2))];
    }
  } catch {}
  return el('span', 'letter' + hue, [...(name || '').trim()][0]?.toUpperCase() || '');
}

// Most sessions' labels start with "Claude", which tells none of them apart:
// where room is short (a group's tag, the helm) the label is shown without
// it, and whole in the tooltip.
const shortName = (label) => label.replace(/^Claude\s+(?=[\p{L}\p{N}])/u, '');
// The width some text takes when set like a given element.
const ruler = document.createElement('canvas').getContext('2d');
const widthOf = (text, like) => {
  ruler.font = getComputedStyle(like).font;
  return ruler.measureText(text).width;
};
// What a session is doing, as the mark on its tag: 'paused' once the user has
// taken over, 'asking' while it has a question for them, 'working', or ''.
// Working lingers as in the helm: no flicker between one step and the next.
const markOf = (g) => (g.paused ? 'paused' : g.asking ? 'asking' : g.busy || lingerUntil.get(g.id) > Date.now() ? 'working' : '');
const MARKS = { paused: 'Paused', asking: 'Asking', working: 'Working' };
function drawMark(g) {
  const mark = el('span', 'group-mark ' + markOf(g), markOf(g) === 'asking' ? '?' : '');
  mark.setAttribute('role', 'img');
  mark.setAttribute('aria-label', MARKS[markOf(g)]);
  return mark;
}
const tipOf = (g) => (g.paused ? `${g.label} is paused` : g.asking ? `${g.label} is asking you something`
  : g.busy ? `${g.label} is ${g.status}` : `${g.label}'s tabs`);

function drawTab(t) {
  const tab = el('div', 'tab' + (t.active ? ' active' : '') + (t.loading ? ' loading' : '') + (t.asleep ? ' asleep' : '') + (t.pinned ? ' pinned' : '')
    + (t.id === state.aimed ? ' aimed' : ''));
  tab.setAttribute('role', 'tab');
  tab.setAttribute('aria-selected', t.active);
  tab.setAttribute('aria-label', t.title); // pinned tabs, and all of them in a collapsed sidebar, show no title
  tab.tabIndex = t.active ? 0 : -1; // one Tab stop for the strip; the arrow keys move within it
  tab.draggable = true;
  tab.dataset.id = t.id; // its whole title shows in a card under it (see "a tab's card" below)

  let mark;
  if (t.favicon && !t.loading) {
    mark = el('img');
    mark.src = t.favicon;
    mark.alt = '';
    mark.draggable = false; // the tab is what gets dragged, not its icon
    mark.onerror = () => mark.replaceWith(letterOf(t));
  } else {
    mark = t.loading ? el('span', 'dot') : letterOf(t);
  }
  tab.append(mark);
  // A private tab the user lent to a session sits in the session's group, in a
  // normal window: a small mask says what it is and what becomes of it.
  if (t.private && t.group !== YOU) {
    const mask = el('span', 'lent-private');
    mask.innerHTML = ICON.mask;
    mask.setAttribute('role', 'img');
    mask.title = `A private tab you lent to ${groupOf(t.group)?.label || 'this session'}. It goes back to your private window when the session ends, and closes if you close your last private window first.`;
    mask.setAttribute('aria-label', 'Private tab, lent to this session');
    tab.append(mask);
  }
  // A pinned tab is its icon alone: it is closed from its menu, and Ctrl+W leaves it be.
  if (!t.pinned) {
    const close = el('button', 'close');
    close.type = 'button';
    close.draggable = false;
    close.setAttribute('aria-label', `Close ${t.title}`);
    setIcon(close, 'close');
    close.onclick = (e) => { e.stopPropagation(); loui.send('tab:close', t.id); };
    // Ctrl+W on a session's tab: its × asks first.
    if (closing?.id === t.id) {
      close.className = 'close sure';
      close.textContent = 'Close tab?';
      close.title = `Close this tab of ${groupOf(t.group)?.label || 'Claude'}'s. Esc cancels.`;
      close.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Escape') { closeTab(null); focusPage(); } };
    }
    tab.append(el('span', 'title', t.title), close);
  }
  tab.onclick = () => loui.send('tab:select', t.id);
  tab.onauxclick = (e) => { if (e.button === 1) loui.send('tab:close', t.id); };
  tab.oncontextmenu = (e) => { e.preventDefault(); loui.send('tab:menu', t.id); };
  tab.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') loui.send('tab:select', t.id); };
  return tab;
}

// Where the tabs go: along the top, or in the sidebar on the left. The same
// #tabs element moves between the two, so everything below draws either way.
const sidebar = $('sidebar');
function placeTabs() {
  const { vertical = false, collapsed = false } = state.tabStrip || {};
  const box = $('tabs');
  if (vertical && box.parentElement !== sidebar) sidebar.append(box);
  if (!vertical && box.parentElement !== $('tabrow')) $('tabs-back').after(box);
  // The top row of the window is the tab strip; with the tabs in the sidebar it
  // is the toolbar, which then holds what else the tab row had.
  if (vertical && $('sidebar-toggle').parentElement !== $('navrow')) {
    $('navrow').prepend($('sidebar-toggle'));
    $('reload').after($('private-label'));
    $('address-form').after($('helm'));
  }
  if (!vertical && $('private-label').parentElement !== $('tabrow')) {
    $('tabrow').prepend($('sidebar-toggle'), $('private-label'));
    $('tabrow').append($('helm'));
  }
  box.setAttribute('aria-orientation', vertical ? 'vertical' : 'horizontal');
  sidebar.hidden = $('sidebar-toggle').hidden = !vertical;
  document.body.classList.toggle('vertical', vertical);
  document.body.classList.toggle('sidebar-collapsed', vertical && collapsed);
  if (!vertical || !collapsed) document.body.classList.remove('sidebar-peek');
  $('sidebar-toggle').title = collapsed ? 'Expand the sidebar' : 'Collapse the sidebar';
  $('sidebar-toggle').setAttribute('aria-label', $('sidebar-toggle').title);
  $('sidebar-toggle').setAttribute('aria-expanded', !collapsed);
}

// The user's pinned tabs first, then their other tabs, then one cluster per
// Claude session with its name on it. Each run of tabs that a tab can be
// dropped into carries its group's id (see the dragging below).
let markTimer = 0;
let shownActive = null; // the tab on screen as last drawn
let following = true; // the strip keeps that tab in sight, until the user scrolls it themselves
function drawTabs() {
  if (dragging) return; // redrawing would lose the tab being dragged; dragend draws
  // A tab that has the keyboard keeps it through the redraw.
  const at = document.activeElement;
  const held = at?.classList.contains('tab') && $('tabs').contains(at) ? at.dataset.id : null;
  const sure = document.activeElement?.matches?.('.group-tag .close.sure'); // redrawn below: it keeps the keyboard
  placeTabs();
  const vertical = !!state.tabStrip?.vertical;
  const nodes = [];
  for (const g of state.groups) {
    const tabs = state.tabs.filter((t) => t.group === g.id);
    if (g.id === YOU) {
      const pins = el('div', 'pins');
      const yours = el('div', 'yours');
      pins.dataset.group = yours.dataset.group = YOU;
      pins.append(...tabs.filter((t) => t.pinned).map(drawTab));
      yours.append(...tabs.filter((t) => !t.pinned).map(drawTab));
      if (vertical) {
        const add = el('button', 'side-new');
        add.type = 'button';
        add.title = 'New tab (Ctrl+T)';
        add.innerHTML = ICON.plus;
        add.append(el('span', 'title', 'New tab'));
        add.onclick = () => loui.send('tab:new');
        yours.append(add);
      }
      nodes.push(pins, yours);
      continue;
    }
    const busy = g.busy || lingerUntil.get(g.id) > Date.now(); // as the helm: no flicker between one step and the next
    const cluster = el('div', 'group' + (busy ? ' busy' : '') + (g.paused ? ' paused' : ''));
    cluster.dataset.group = g.id;
    cluster.setAttribute('aria-label', `${g.label}'s tabs`);
    const name = el('button', 'group-name', shortName(g.label));
    name.type = 'button';
    name.title = tipOf(g);
    name.setAttribute('aria-label', name.title);
    const current = tabs.find((t) => t.current) || tabs[0];
    name.onclick = () => current && loui.send('tab:select', current.id);
    // Its menu moves the group to another window (as dragging it out of the strip does).
    name.oncontextmenu = (e) => { e.preventDefault(); loui.send('group:menu', g.id); };
    const close = el('button', 'close');
    close.type = 'button';
    close.title = `Close ${g.label}'s tabs`;
    close.setAttribute('aria-label', close.title);
    setIcon(close, 'close');
    close.onclick = () => endGroup(g.id);
    // Asked to end a session that is working or has several tabs: the × asks first.
    if (ending?.id === g.id) {
      close.className = 'close sure';
      close.textContent = 'End session?';
      close.title = `End ${g.label} and close its ${tabs.length === 1 ? 'tab' : `${tabs.length} tabs`}. This can't be undone. Esc cancels.`;
      close.setAttribute('aria-label', close.title);
      close.onkeydown = (e) => { if (e.key === 'Escape') endGroup(null); };
    }
    const tag = el('div', 'group-tag');
    tag.title = name.title;
    tag.draggable = true;
    // The sidebar has room for what the session is doing; along the top the helm says it.
    const status = el('span', 'group-status', g.paused ? 'Paused' : g.asking ? 'Asking' : g.busy ? g.status : '');
    // Seen from any tab, and in a collapsed sidebar: a dot while it works, a
    // question mark while it waits on the user, a pause sign while paused.
    if (markOf(g)) tag.append(drawMark(g));
    tag.append(name, status, close);
    cluster.append(tag, ...tabs.map(drawTab));
    nodes.push(cluster);
  }
  $('tabs').replaceChildren(...nodes);
  if (held) $('tabs').querySelector(`.tab[data-id="${held}"]`)?.focus();
  if (sure) $('tabs').querySelector('.group-tag .close.sure')?.focus();
  // Along the top a tag is as narrow as its name allows and, short of room,
  // gives way down to a start of the name (less beside "End session?"). It is
  // measured here, drawn whole, since CSS cannot say "the name's width, at most".
  if (!vertical) {
    const widthNow = (node) => node.getBoundingClientRect().width;
    const least = [...$('tabs').querySelectorAll('.group-tag')].map((tag) => {
      const name = widthNow(tag.querySelector('.group-name'));
      return [tag, Math.ceil(widthNow(tag) - name + Math.min(name, tag.querySelector('.sure') ? 40 : 60))];
    });
    for (const [tag, width] of least) tag.style.minWidth = `${width}px`;
  }
  // A dot that only lingers is taken away once its time is up.
  clearTimeout(markTimer);
  if (state.groups.some((g) => !g.busy && lingerUntil.get(g.id) > Date.now())) markTimer = setTimeout(drawTabs, 1450);
  const active = activeTab()?.id;
  if (active !== shownActive) following = true;
  shownActive = active;
  if (following) showActive();
  drawOverflow();
}
// A strip along the top that is too full to show every tab scrolls: the tab
// on screen stays in sight, also when the window or the helm leaves it less
// room. Once the user has scrolled the strip themselves it stays where they
// put it, until another tab comes on screen.
function showActive() {
  if (!state.tabStrip?.vertical) $('tabs').querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
new ResizeObserver(() => {
  if (following) showActive();
  drawOverflow();
}).observe($('tabs'));

// What says that the strip has more than it shows: the edge with tabs beyond
// it fades and has a button that scrolls a page that way; and a session whose
// tag is scrolled out of sight keeps a small one after the strip, with its
// state on it, which brings its group back into sight.
let strays = '';
function drawOverflow() {
  const box = $('tabs');
  const flat = !state.tabStrip?.vertical;
  const before = flat && box.scrollLeft > 1;
  const after = flat && box.scrollLeft + box.clientWidth < box.scrollWidth - 1;
  box.classList.toggle('more-before', before);
  box.classList.toggle('more-after', after);
  // The button in use goes away at the end of the strip: the keyboard moves to the other one.
  if (document.activeElement === $('tabs-on') && !after && before) $('tabs-back').focus();
  if (document.activeElement === $('tabs-back') && !before && after) $('tabs-on').focus();
  $('tabs-back').hidden = !before;
  $('tabs-on').hidden = !after;
  const sight = box.getBoundingClientRect();
  const away = !flat ? [] : [...box.querySelectorAll('.group')].filter((n) => {
    const r = n.querySelector('.group-tag').getBoundingClientRect();
    return r.right < sight.left + 30 || r.left > sight.right - 30;
  }).map((n) => groupOf(n.dataset.group)).filter(Boolean);
  const now = JSON.stringify(away.map((g) => [g.id, g.label, markOf(g), tipOf(g)]));
  if (now === strays) return;
  strays = now;
  $('strays').replaceChildren(...away.map((g) => {
    const stray = el('button', 'stray' + (g.paused ? ' paused' : ''));
    stray.type = 'button';
    stray.dataset.group = g.id;
    stray.title = `${tipOf(g)}. Show its tabs.`;
    stray.setAttribute('aria-label', stray.title);
    if (markOf(g)) stray.append(drawMark(g));
    stray.append(el('span', 'stray-name', shortName(g.label)));
    stray.onclick = () => {
      const group = [...box.querySelectorAll('.group')].find((n) => n.dataset.group === g.id);
      following = false;
      group?.querySelector('.group-tag').scrollIntoView({ block: 'nearest', inline: 'start' });
      drawOverflow();
      group?.querySelector('.group-name').focus(); // this button has just gone
    };
    stray.oncontextmenu = (e) => { e.preventDefault(); loui.send('group:menu', g.id); };
    return stray;
  }));
}
$('tabs').addEventListener('scroll', drawOverflow, { passive: true });
$('tabs-back').innerHTML = ICON.back;
$('tabs-on').innerHTML = ICON.forward;
const pageTabs = (way) => () => {
  const box = $('tabs');
  following = false;
  box.scrollBy({ left: way * Math.max(120, box.clientWidth - 90) });
  drawOverflow();
};
$('tabs-back').onclick = pageTabs(-1);
$('tabs-on').onclick = pageTabs(1);

// Ending a session closes all its tabs and cannot be undone, so for one that
// is working or has more than one tab the × on its tag (and "End session" in
// its menu) first turns into "End session?", for a few seconds; pressing that
// ends it. id null: never mind.
// The question appears right under the pointer that asked for it, so for half
// a second it takes no answer: a second click meant for the × does not end
// the session. Never mind (Esc, or its time is up) puts the keyboard back
// where it was before the question took it.
let ending = null; // { id, timer, at, back } while a group's tag asks
function endGroup(id) {
  const g = groupOf(id);
  const sure = ending?.id === id;
  if (g && sure && Date.now() - ending.at < 500) return;
  const was = ending;
  const held = document.activeElement?.matches?.('.group-tag .close.sure');
  clearTimeout(ending?.timer);
  ending = null;
  if (g && (sure || !(g.busy || state.tabs.filter((t) => t.group === id).length > 1))) loui.send('group:close', id);
  else if (g) ending = { id, at: Date.now(), back: was?.back || keyboardPlace(), timer: setTimeout(() => endGroup(null), 5000) };
  drawTabs();
  $('tabs').querySelector('.group-tag .close.sure')?.focus();
  if (!g && was && held) was.back();
}
// Where the keyboard is now, as a way back to it after the strip has been redrawn.
function keyboardPlace() {
  const at = document.activeElement;
  const tab = at?.closest?.('#tabs .tab');
  const group = at?.closest?.('#tabs .group');
  const find = tab ? `.tab[data-id="${tab.dataset.id}"]`
    : group ? `.group[data-group="${CSS.escape(group.dataset.group)}"] .${at.classList[0]}` : null;
  return () => (find ? $('tabs').querySelector(find) : at)?.focus?.();
}
loui.on('group:end', endGroup);

// Ctrl+W on a session's tab asks the same way: the tab's × turns into
// "Close tab?" for a few seconds, and Ctrl+W again (or pressing it) closes.
let closing = null; // { id, timer } while a tab's × asks
function closeTab(id) {
  const sure = id != null && closing?.id === id;
  clearTimeout(closing?.timer);
  closing = null;
  if (sure) return loui.send('tab:close', id);
  if (id != null) closing = { id, timer: setTimeout(() => closeTab(null), 5000) };
  drawTabs();
  $('tabs').querySelector('.tab .close.sure')?.focus();
}
loui.on('tab:ask-close', closeTab);

// The tab strip is one Tab stop: the arrow keys (and Home and End) move
// between its tabs, Enter or Space shows the one that has the keyboard.
$('tabs').addEventListener('keydown', (e) => {
  if (!e.target.classList.contains('tab')) return;
  const all = [...$('tabs').querySelectorAll('.tab')];
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
  const to = step ? all[all.indexOf(e.target) + step] : e.key === 'Home' ? all[0] : e.key === 'End' ? all[all.length - 1] : null;
  if (!to) return;
  e.preventDefault();
  to.focus();
});

// ── dragging tabs ───────────────────────────────────────────────────────────
// Within a group a dragged tab is reordered. The user's tab dropped on a
// session's group is handed to it ("Give to" in the tab menu), and a session's
// tab dropped among the user's is taken back. A session's tab cannot go to
// another session. Dropped among the pinned tabs a tab is pinned, and among
// the others unpinned. The main process applies the same rules (tabs.drop).
// The keyboard does the same with Ctrl+Shift+PageUp/PageDown and the tab menu.
// Let go outside this window, a tab goes to the Loui window there or to a new
// window (a private tab only to a private one); a session's group, dragged by
// its name, goes along whole, and its tabs stay in its group wherever it is.
let dragging = null; // { id, group } while a tab is dragged; { group, whole: true } for a group
let marked = [];

function clearDrop() {
  for (const node of marked) node.classList.remove('drop-before', 'drop-after', 'drop-into');
  marked = [];
}
const flag = (node, cls) => { node.classList.add(cls); marked.push(node); };

// Where the pointer would drop the tab: { zone, group, index, before, last } or null.
function dropSpot(e) {
  const zone = e.target.closest?.('[data-group]');
  if (!zone || !dragging || dragging.whole) return null; // a group only goes to another window
  const group = zone.dataset.group;
  if (group !== dragging.group && group !== YOU && dragging.group !== YOU) return null;
  const pinning = zone.classList.contains('pins');
  // A list in the sidebar reads top to bottom; a strip, or the pinned icons, in rows.
  const column = !!state.tabStrip?.vertical && !pinning;
  const tabs = [...zone.querySelectorAll('.tab')].filter((n) => +n.dataset.id !== dragging.id);
  const before = tabs.find((n) => {
    const r = n.getBoundingClientRect();
    if (column) return e.clientY < r.top + r.height / 2;
    return e.clientY < r.top || (e.clientY < r.bottom && e.clientX < r.left + r.width / 2);
  });
  const order = state.tabs.filter((t) => t.group === group && t.id !== dragging.id);
  const last = tabs[tabs.length - 1];
  const index = before ? order.findIndex((t) => t.id === +before.dataset.id)
    : last ? order.findIndex((t) => t.id === +last.dataset.id) + 1
      : group === YOU && !pinning ? order.filter((t) => t.pinned).length : 0;
  return { zone, group, index, before, last, pinned: group === YOU ? pinning : undefined };
}

const tabsBox = $('tabs');
// The wheel moves a strip along the top that is too full to show every tab.
tabsBox.addEventListener('wheel', (e) => {
  if (state.tabStrip?.vertical) return;
  following = false; // the user is looking along the strip: it stays where they leave it
  if (!e.deltaX) tabsBox.scrollLeft += e.deltaY;
}, { passive: true });
tabsBox.addEventListener('dragstart', (e) => {
  const tag = e.target.closest?.('.group-tag');
  if (tag) {
    dragging = { group: tag.parentElement.dataset.group, whole: true };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-loui-group', dragging.group);
    return;
  }
  const node = e.target.closest?.('.tab');
  const t = node && state.tabs.find((x) => x.id === +node.dataset.id);
  if (!t) return;
  dragging = { id: t.id, group: t.group };
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('application/x-loui-tab', String(t.id));
  node.classList.add('dragged');
});
tabsBox.addEventListener('dragover', (e) => {
  const spot = dropSpot(e);
  clearDrop();
  if (!spot) return; // not a place this tab can go: the drop is refused
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (spot.group !== dragging.group) flag(spot.zone, 'drop-into');
  if (spot.before) flag(spot.before, 'drop-before');
  else if (spot.last) flag(spot.last, 'drop-after');
});
tabsBox.addEventListener('dragleave', (e) => {
  if (!tabsBox.contains(e.relatedTarget)) clearDrop();
});
tabsBox.addEventListener('drop', (e) => {
  const spot = dropSpot(e);
  clearDrop();
  if (!spot) return;
  e.preventDefault();
  loui.send('tab:move', { id: dragging.id, group: spot.group, index: spot.index, pinned: spot.pinned });
});
// Whether a point on screen lies outside this window.
const outside = (x, y) => x < window.screenX || y < window.screenY ||
  x >= window.screenX + window.outerWidth || y >= window.screenY + window.outerHeight;
tabsBox.addEventListener('dragend', (e) => {
  const was = dragging;
  dragging = null;
  clearDrop();
  drawTabs(); // also puts back the tab that was drawn as being dragged
  // Let go where nothing took it, outside this window (a real drag, not a script's).
  if (!was || !e.isTrusted || e.dataTransfer.dropEffect !== 'none' || !outside(e.screenX, e.screenY)) return;
  if (was.whole) loui.send('group:detach', { group: was.group, x: e.screenX, y: e.screenY });
  else loui.send('tab:detach', { id: was.id, x: e.screenX, y: e.screenY });
});

// ── a tab's card ────────────────────────────────────────────────────────────
// The window has no title bar, and a tab shows only a start of its title: the
// pointer resting on a tab brings up a small card with the whole title, the
// site, and whose tab it is. The main process draws it in a view in front of
// the page (hints.js), since the page cannot be drawn over from here.
let hovered = null; // the tab the pointer is on
let cardTimer = 0;
let carded = false; // a card is on show
function dropCard() {
  clearTimeout(cardTimer);
  if (carded) loui.send('tab:card');
  carded = false;
}
tabsBox.addEventListener('mouseover', (e) => {
  const node = e.target.closest?.('.tab');
  const id = node ? +node.dataset.id : null;
  if (id === hovered) return;
  hovered = id;
  dropCard();
  if (id == null) return;
  cardTimer = setTimeout(() => {
    const now = tabsBox.querySelector(`.tab[data-id="${id}"]`);
    if (!now || dragging) return;
    // The tab on screen says what it is in the address bar and on the page:
    // it gets a card only if its title does not fit on it.
    const title = now.querySelector('.title');
    if (now.classList.contains('active') && title && title.scrollWidth <= title.clientWidth) return;
    const r = now.getBoundingClientRect();
    carded = true;
    // Beside a tab in the sidebar. Along the top the card would lie over the
    // toolbar (Back, Reload, the address bar), so it goes under the toolbar, below its tab.
    const under = Math.max(r.bottom + 3, $('stage').getBoundingClientRect().top + 4);
    loui.send('tab:card', state.tabStrip?.vertical ? { id, x: r.right - 4, y: r.top - 2 } : { id, x: r.left - 8, y: under });
  }, 900);
});
tabsBox.addEventListener('mouseleave', () => { hovered = null; dropCard(); });
// A press is the start of something else (a click, a drag, the tab's menu):
// the card goes, and stays away until the pointer comes to another tab.
tabsBox.addEventListener('mousedown', dropCard);
window.addEventListener('blur', dropCard);

// A collapsed sidebar opens while the pointer rests on it, as Brave's does.
// The page is a native view that nothing can be drawn over, so it makes room
// rather than being covered; the short wait keeps a passing pointer from
// resizing it.
let peekTimer = 0;
const peek = (on, wait) => {
  clearTimeout(peekTimer);
  peekTimer = setTimeout(() => {
    document.body.classList.toggle('sidebar-peek', on && document.body.classList.contains('sidebar-collapsed'));
  }, wait);
};
sidebar.addEventListener('mouseenter', () => peek(true, 300));
sidebar.addEventListener('mouseleave', () => peek(false, 150));
sidebar.addEventListener('dragenter', () => peek(true, 0));
window.addEventListener('blur', () => peek(false, 0));
$('sidebar-toggle').innerHTML = ICON.panel;
$('sidebar-toggle').onclick = () => {
  document.body.classList.remove('sidebar-peek');
  loui.send('tabs:layout', { collapsed: !state.tabStrip?.collapsed });
};

// Who is driving the tab on screen, or a question from a Claude session
// (src/main/prompts.js): one at a time, with a count of those waiting. The
// status lingers briefly after Claude's last step so it does not flicker
// between one tool call and the next.
const lingerUntil = new Map(); // group id -> time
let lingerTimer = 0;
let shownPrompt = null;
function drawHelm() {
  const { picking, prompt } = state;
  const g = groupOf(activeTab()?.group) || { id: YOU, label: 'You' };
  const who = g.id === YOU ? 'Claude' : shortName(g.label);
  for (const each of state.groups) if (each.busy) lingerUntil.set(each.id, Date.now() + 1400);
  const lingering = (lingerUntil.get(g.id) || 0) > Date.now();
  if (lingering) {
    clearTimeout(lingerTimer);
    lingerTimer = setTimeout(drawHelm, 1450);
  }
  const driving = !g.paused && (g.busy || lingering);
  const answer = (value) => () => loui.send('prompt:answer', { id: prompt.id, value });
  // what: the state in a word or two, shown whole ahead of the text, which is what gets cut short.
  // named: the session the text starts with, shown without a leading "Claude" and whole in the tooltip.
  let what = '', text = '', named = '', label = '', act = null, decline = null, no = 'Not now', always = null;
  const asked = prompt && !(picking.active && prompt.kind !== 'pick'); // the user's own pointing comes first
  if (picking.active && !asked) {
    text = picking.message || 'Click the thing you mean. Esc cancels.';
    label = 'Cancel';
    act = () => loui.send('pick:cancel');
  } else if (asked && prompt.kind === 'consent') {
    text = `Let ${prompt.who} use Loui?`;
    label = 'Allow';
    act = () => loui.send('prompt:answer', { id: prompt.id, value: $('helm-always').checked ? 'always' : 'allow' });
    decline = answer('deny');
    no = 'Deny';
    always = prompt.connector;
  } else if (asked && prompt.kind === 'handoff') {
    // Only the user's own tabs can be handed over: the one on screen when they answer.
    const theirs = activeTab()?.group === YOU;
    what = theirs ? 'Asks for this tab' : 'Asks for a tab';
    named = prompt.who;
    text = theirs ? shortName(named) : `${shortName(named)}. Open one of your tabs to hand it over.`;
    if (theirs) {
      label = 'Hand it over';
      act = answer(true);
    }
    decline = answer(false);
  } else if (asked) {
    what = 'Asks you to point';
    named = prompt.who;
    text = shortName(named) + (prompt.message ? `: ${prompt.message}` : '');
    text += `${/[.!?…]$/.test(text) ? '' : '.'} Esc cancels.`; // a message that ends in a question mark gets no full stop after it
    label = 'Cancel';
    act = () => loui.send('pick:cancel');
  } else if (g.paused) {
    what = 'Paused';
    named = g.id === YOU ? '' : g.label;
    text = `${who}. You're driving.`;
    label = 'Let Claude continue';
    act = () => loui.send('pause', { group: g.id, on: false });
  } else if (g.asking) {
    // Its question is on show in another window, or waits behind the user's own pointing.
    what = 'Asking';
    named = g.label;
    text = who;
    label = 'Take over';
    act = () => loui.send('pause', { group: g.id, on: true });
  } else if (driving) {
    what = 'Working';
    named = g.id === YOU ? '' : g.label;
    text = `${who}: ${g.status}`;
    label = 'Take over';
    act = () => loui.send('pause', { group: g.id, on: true });
  } else if (g.id !== YOU) {
    what = 'Idle';
    named = g.label;
    text = who;
    label = 'Take over';
    act = () => loui.send('pause', { group: g.id, on: true });
  }
  const helm = $('helm');
  helm.hidden = !act && !decline;
  helm.classList.toggle('moving', driving && !picking.active && !prompt);
  helm.classList.toggle('asking', !!asked);
  $('helm-state').textContent = what;
  $('helm-text').textContent = text;
  // Also on the helm itself: with the tabs in the sidebar the text can give way altogether.
  helm.title = $('helm-text').title = named.slice(0, named.length - shortName(named).length) + text;
  // The text keeps room for a start of itself before the tabs give way, and never more room than it fills.
  $('helm-text').style.setProperty('--full', `${Math.ceil(widthOf(text, $('helm-text'))) + 1}px`);
  $('helm-btn').hidden = !act;
  $('helm-btn').textContent = label;
  $('helm-btn').onclick = act;
  $('helm-no').hidden = !decline;
  $('helm-no').textContent = no;
  $('helm-no').onclick = decline;
  $('helm-always-label').hidden = !always;
  if (always) {
    $('helm-always-text').textContent = always.kind === 'key' ? 'Always allow the relay key' : `Always allow the ${always.name} connector`;
    $('helm-always-label').title = always.kind === 'key'
      ? 'Sessions signed in with the relay key, such as Claude Code on your machines, will not be asked again. Revoke in File › Settings.'
      : `New sessions from the ${always.name} connector will not be asked again. Revoke in File › Settings.`;
  }
  // Questions waiting behind the one on show, named in the tooltip. Pressing
  // the count shows the next one (the one on show goes to the back of the
  // line), so any of them can be answered first.
  const more = state.waiting.length + (prompt && !asked ? 1 : 0);
  $('helm-more').hidden = !more;
  $('helm-more').textContent = `${more} more`;
  $('helm-more').title = `Also waiting: ${[...(asked ? [] : prompt ? [prompt.who] : []), ...state.waiting].join(', ')}. Show the next question.`;
  // While the user is pointing for themselves the question is behind that: stopping it shows it.
  $('helm-more').onclick = () => loui.send(asked ? 'prompt:next' : 'pick:cancel');
  // A new question takes a moment to become answerable, so that a click meant
  // for something else as it appears cannot answer it.
  const shown = asked ? prompt.id : null;
  if (shown !== shownPrompt) {
    shownPrompt = shown;
    $('helm-always').checked = false;
    if (shown) {
      for (const b of [$('helm-btn'), $('helm-no')]) b.disabled = true;
      setTimeout(() => {
        if (shownPrompt === shown) for (const b of [$('helm-btn'), $('helm-no')]) b.disabled = false;
      }, 600);
    } else {
      for (const b of [$('helm-btn'), $('helm-no')]) b.disabled = false;
    }
  }
  // A busy session can be watched from a small window while the user goes back to their own tabs.
  $('helm-pip').hidden = g.id === YOU || !driving || !!asked || picking.active;
  $('helm-pip').title = `Watch ${g.label} in a small window`;
  $('helm-pip').onclick = () => loui.send('pip:open', g.id);
  document.body.classList.toggle('driving', driving);
  placeHelm();
}

// With the tabs in the sidebar the helm sits in the toolbar, which is then
// the top row and ends at the window buttons. It gives way there down to its
// state and its buttons (a question, or text with no state before it, stays
// whole). In a window too narrow for that as well, it takes a row of its own
// under the toolbar: nothing of the toolbar may end up under the window
// buttons. Measured, since what the toolbar holds varies.
function placeHelm() {
  const helm = $('helm');
  helm.classList.remove('split');
  if (!document.body.classList.contains('vertical') || helm.hidden) return;
  const wide = (node) => node.getBoundingClientRect().width;
  const row = $('navrow');
  const inRow = helm.parentElement === row;
  const whole = helm.classList.contains('asking') || !$('helm-state').textContent;
  const need = wide(helm) - (whole ? 0 : wide($('helm-text'))) + 6;
  const spare = wide($('address-form')) - 130 + (inRow ? wide(helm) + 6 : 0);
  const end = row.getBoundingClientRect().right - parseFloat(getComputedStyle(row).paddingRight);
  const fits = need <= spare && !(inRow && $('menu').getBoundingClientRect().right > end + 0.5);
  if (fits && !inRow) $('address-form').after(helm);
  if (!fits && inRow) $('helmrow').append(helm);
  // In its own row a long question wraps: its buttons go to the next line together, not one by one.
  const acts = [...helm.querySelectorAll(':scope > label, :scope > button')].filter((n) => !n.hidden);
  if (!fits && acts.some((n) => Math.abs(n.offsetTop - acts[0].offsetTop) > 8))helm.classList.add('split');
}
new ResizeObserver(placeHelm).observe($('navrow'));
// With the tabs in the sidebar, the strips under the toolbar (the bookmarks
// bar, a question's row) take up some of the room Louis has below it: the
// sidebar starts lower by the rest (ui.css).
new ResizeObserver(() => document.body.style.setProperty('--strips', `${$('bar').offsetHeight}px`)).observe($('bar'));

function drawChips() {
  $('chips').replaceChildren(...state.picks.map((p) => {
    const chip = el('div', 'chip');
    if (p.thumb) {
      const img = el('img');
      img.src = p.thumb;
      img.alt = '';
      chip.append(img);
    }
    const drop = el('button');
    drop.type = 'button';
    drop.setAttribute('aria-label', `Remove ${p.name}`);
    setIcon(drop, 'close');
    drop.onclick = () => loui.send('pick:remove', p.id);
    chip.append(el('span', 'name', p.name), drop);
    return chip;
  }));
}

// ── side panels ─────────────────────────────────────────────────────────────
// The relay form and site permissions each take the Claude panel's
// place while open, as History, Bookmarks, Passwords and Sessions do: one at
// a time, with a × at the top, and Esc closes. opened(): once it is on show.
// Returns show(open, quiet): quiet opens it without taking the keyboard.
const SIDE_PANELS = ['history', 'bookmarks', 'passwords', 'activity', 'relay', 'perms'];
function sidePanel(name, node, opened) {
  const cls = document.body.classList;
  const isOpen = () => cls.contains(`${name}-open`);
  const show = (open, quiet = false) => {
    if (!open && !isOpen()) return;
    if (open) {
      for (const other of SIDE_PANELS) if (other !== name && cls.contains(`${other}-open`)) $(`${other}-close`).click();
    }
    cls.toggle(`${name}-open`, open);
    node.hidden = !open;
    $('panel-toggle').classList.toggle('on', !open && panelOpen());
    if (open && !quiet) opened?.();
    else if (!open) focusPage();
  };
  setIcon($(`${name}-close`), 'close');
  $(`${name}-close`).onclick = () => show(false);
  node.addEventListener('keydown', (e) => { if (e.key === 'Escape') show(false); });
  // Asking for the Claude panel brings it back; another panel opening here closes this one.
  const claudeInstead = () => {
    if (!isOpen()) return;
    show(false);
    togglePanel(true);
  };
  $('panel-toggle').addEventListener('click', claudeInstead);
  loui.on('toggle-panel', claudeInstead);
  new MutationObserver(() => {
    if (isOpen() && SIDE_PANELS.some((other) => other !== name && cls.contains(`${other}-open`))) show(false);
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  return show;
}

// Esc closes the side panel that is open from anywhere in the window chrome,
// not only from inside it (the keyboard may have moved on, to the tab strip
// say), and the page gets the keyboard back. Unless something nearer has a
// use for Esc: the panel itself (it closes its question first), the address
// bar, a strip under the toolbar, a question, or a button that is asking.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const open = SIDE_PANELS.find((name) => document.body.classList.contains(`${name}-open`));
  if (!open || $(open).contains(e.target)) return;
  if (e.target.closest?.('#address-form, #find, #downloads, #bookmark-edit, [role="alertdialog"], .sure')) return;
  document.activeElement?.blur?.(); // so that closing hands the keyboard to the page (focusPage)
  $(`${open}-close`).click();
});

// ── connection to other Claude sessions ─────────────────────────────────────
const LINK_WORDS = { connected: 'Connected', connecting: 'Connecting', offline: 'Offline, retrying', refused: 'Refused', off: 'Not connected' };
let linkWas = ''; // the status last drawn
const relay = $('relay');
function drawLink() {
  const link = state.link;
  $('link').className = `quiet link-${link.status}`;
  $('link-text').textContent = LINK_WORDS[link.status] || '';
  // In a narrow panel the lamp stands alone: the tooltip says what it means.
  $('link').title = `Connection to other Claude sessions: ${(LINK_WORDS[link.status] || 'not known').toLowerCase()}`;
  const others = state.groups.length - 1;
  $('relay-status').textContent =
    link.status === 'connected' ? `Connected as ${link.device}. ${others === 1 ? '1 session is' : `${others} sessions are`} using this browser.`
      : link.status === 'refused' ? `The relay refused this browser: ${link.detail}`
        : link.status === 'off' ? link.detail || 'Not connected. Only the Claude panel can use this browser.'
          : link.status === 'offline' ? `Offline, retrying${link.detail ? `: ${link.detail}` : '.'}`
            : link.detail || 'Connecting…';
  if (relay.hidden) {
    $('relay-url').value = link.url || '';
    $('relay-on').checked = link.on !== false;
    $('relay-key').placeholder = link.hasKey ? 'Saved. Enter a new key to replace it.' : '';
  }
  // Refused: no Claude session can reach this browser until the key is put
  // right, so the form opens, once, when it happens (never in a private
  // window, which has no panel; nor taking the keyboard from what the user is typing).
  $('relay-status').classList.toggle('refused', link.status === 'refused');
  if (link.status === 'refused' && linkWas !== 'refused' && !state.window?.private && relay.hidden) {
    showRelay(true, true);
  }
  linkWas = link.status;
}
const showRelay = sidePanel('relay', relay, () => $('relay-url').focus());
$('link').onclick = () => showRelay(relay.hidden);
loui.on('show-relay', () => showRelay(true));
relay.onsubmit = (e) => {
  e.preventDefault();
  loui.send('relay:set', { url: $('relay-url').value, key: $('relay-key').value, on: $('relay-on').checked });
  $('relay-key').value = '';
};

// A new version on its way shows how far its download has come; once it is
// here the button restarts Loui. Until there is one, updates stay out of the way.
function drawUpdate() {
  const u = state.update;
  // On Linux: installing (apt is at work), installed (a restart is all that
  // is left), and manual (Loui cannot install it here; Settings has the command).
  const ready = u?.status === 'ready' || u?.status === 'installed';
  const coming = u?.status === 'downloading' || u?.status === 'installing';
  $('update').hidden = !ready && !coming;
  $('update').disabled = !ready;
  // A download is only said, quietly: nothing of Loui changes until it restarts, and there is nothing to press.
  $('update').classList.toggle('coming', coming);
  if (u?.status === 'installing') {
    $('update').textContent = 'Installing update…';
    $('update').title = `Version ${u.version} is being installed. Loui restarts when it is done.`;
    return;
  }
  if (coming) {
    $('update').textContent = `Downloading update ${u.percent || 0}%`;
    $('update').title = `Version ${u.version} is downloading in the background. Loui will offer to restart when it is here.`;
    return;
  }
  if (!ready || $('update').classList.contains('sure')) return; // not while it asks
  if (u.status === 'installed') {
    $('update').textContent = 'Restart to finish updating';
    $('update').title = `Version ${u.version} is installed. Loui closes and reopens as the new version; Claude sessions' tab groups close.`;
    return;
  }
  if (u.manual) {
    $('update').textContent = 'Update downloaded';
    $('update').title = `Version ${u.version} is downloaded, but Loui can't install it itself: ${u.why}. In a terminal, run:  ${u.manual}  and then restart Loui. (Click for Settings, where the command can be copied.)`;
    return;
  }
  $('update').textContent = 'Restart to update';
  if (navigator.platform.startsWith('Linux')) {
    $('update').title = `Version ${u.version} is ready. Loui asks for an administrator's password to install the package, then closes and reopens; Claude sessions' tab groups close.`;
    return;
  }
  $('update').title = `Version ${u.version} is ready. Loui closes, the installer shows its progress for a few seconds, and Loui reopens; Claude sessions' tab groups close.`;
}
// Restarting closes sessions' tab groups, so while one is working (in any window) it asks first.
askFirst($('update'), 'A session is working. Restart anyway?', () => state.working > 0 && !state.update?.manual, () => loui.send('update:install'));
loui.on('update:ask', () => $('update').click()); // "Restart to update" in the Help menu

loui.on('state', (next) => {
  const fresh = state.picks.length < next.picks.length;
  state = next;
  const tab = activeTab();
  drawTabs();
  drawHelm();
  drawChips();
  drawLink();
  drawUpdate();
  if (!state.groups.some((g) => g.busy)) liveStep?.classList.remove('live');
  // The field counts as in use only while the window's own chrome has the
  // keyboard, or he has typed in it: it stays the chrome's active element
  // after a click in the page, and would otherwise never follow the page again.
  const using = document.activeElement === address && (document.hasFocus() || addressTyped);
  if (!using) address.value = tab?.url || '';
  // Another tab came on screen while the field has the keyboard: it shows that
  // tab's address, selected, so that Enter cannot load the old one in the new
  // tab. What the owner has typed there stays.
  else if (tab?.id !== addressTab && !addressTyped) {
    address.value = tab?.url || '';
    address.select();
  }
  addressTab = tab?.id;
  address.title = tab?.title || ''; // the page's whole title: the window has no title bar to show it
  $('back').disabled = !tab?.canGoBack;
  $('forward').disabled = !tab?.canGoForward;
  setIcon($('reload'), tab?.loading ? 'stop' : 'reload');
  $('reload').title = tab?.loading ? 'Stop loading' : 'Reload (Ctrl+R)';
  $('device-label').textContent = tab?.device || '';
  $('device').classList.toggle('on', !!tab?.device);
  $('device').hidden = !tab?.device; // only while a device is emulated; choosing one is in the menu (the three dots)
  $('point').classList.toggle('on', !!state.picking.active);
  // A private window is tinted and labelled, and says so in its title.
  const priv = !!state.window?.private;
  document.body.classList.toggle('private', priv);
  $('private-label').hidden = !priv;
  document.title = (tab?.title ? `${tab.title} · Loui` : 'Loui') + (priv ? ' · Private' : '');
  // Pointing at something is usually followed by saying something about it.
  if (fresh && panelOpen()) $('prompt').focus();
  setSend();
});

// ── panel ───────────────────────────────────────────────────────────────────
const feed = $('feed');
const empty = $('empty');

function add(node) {
  const pinned = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;
  empty.remove();
  feed.append(node);
  if (pinned) feed.scrollTop = feed.scrollHeight;
  return node;
}

// Just enough Markdown for chat replies, built as DOM nodes.
function inline(parent, text) {
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g;
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    parent.append(text.slice(last, m.index));
    const t = m[0];
    if (t[0] === '`') parent.append(el('code', '', t.slice(1, -1)));
    else if (t.startsWith('**')) parent.append(el('strong', '', t.slice(2, -2)));
    else if (t[0] === '*') parent.append(el('em', '', t.slice(1, -1)));
    else {
      const [, label, url] = t.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      const a = el('a', '', label);
      a.href = url;
      a.onclick = (e) => { e.preventDefault(); loui.send('tab:new', url); };
      parent.append(a);
    }
    last = m.index + t.length;
  }
  parent.append(text.slice(last));
}

// A Markdown table: a row of cells, then a rule (|---|---|), then more rows.
const tableRule = (line) => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line || '') && line.includes('|');
const tableStart = (lines, i) => lines[i].includes('|') && tableRule(lines[i + 1]);
const cellsOf = (row) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));

function markdown(target, source) {
  const out = [];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (tableStart(lines, i)) {
      // A small grid, which scrolls sideways when it is wider than the panel. Text only, as the rest.
      const table = el('table');
      const head = table.appendChild(el('thead')).appendChild(el('tr'));
      const width = cellsOf(line).length;
      for (const cell of cellsOf(line)) inline(head.appendChild(el('th')), cell);
      const body = table.appendChild(el('tbody'));
      for (i += 2; i < lines.length && lines[i].trim() && lines[i].includes('|'); i++) {
        const tr = body.appendChild(el('tr'));
        const cells = cellsOf(lines[i]);
        for (let c = 0; c < Math.max(width, cells.length); c++) inline(tr.appendChild(el('td')), cells[c] || '');
      }
      const wrap = el('div', 'table');
      wrap.tabIndex = 0; // the arrow keys scroll it
      wrap.append(table);
      out.push(wrap);
    } else if (line.startsWith('```')) {
      const code = [];
      for (i++; i < lines.length && !lines[i].startsWith('```'); i++) code.push(lines[i]);
      i++;
      const pre = el('pre');
      pre.append(el('code', '', code.join('\n')));
      out.push(pre);
    } else if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const list = el(/^\s*\d+\./.test(line) ? 'ol' : 'ul');
      for (; i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i]); i++) {
        inline(list.appendChild(el('li')), lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ''));
      }
      out.push(list);
    } else if (/^#{1,4}\s/.test(line)) {
      inline(out[out.push(el('p')) - 1].appendChild(el('strong')), line.replace(/^#+\s/, ''));
      i++;
    } else if (!line.trim()) {
      i++;
    } else {
      const para = [];
      for (; i < lines.length && lines[i].trim() && !/^(```|\s*([-*]|\d+\.)\s+|#{1,4}\s)/.test(lines[i]) && !(para.length && tableStart(lines, i)); i++) para.push(lines[i]);
      inline(out[out.push(el('p')) - 1], para.join('\n'));
    }
  }
  target.replaceChildren(...out);
}

// Claude's steps: the panel conversation's own, and those of other sessions,
// each run of which is headed by the session's name.
const steps = new Map();
let liveStep = null;
// A step the user stopped is not one that failed.
const STOPPED = { blocked: 'You blocked this', paused: 'Paused by you', taken: 'You took the tab back', unanswered: 'You did not answer, so it was stopped' };
const ENDED = { closed: 'You ended it', lost: 'Session ended: connection lost' };
loui.on('feed', (entry) => {
  if (entry.type === 'ended') {
    // The last line of a session's steps: its tab group has closed.
    const last = feed.lastElementChild;
    if (!(last?.classList.contains('did') && last.dataset.session === entry.session)) add(el('div', 'from', entry.who));
    add(el('div', 'did ended', ENDED[entry.how] || 'Session ended')).dataset.session = entry.session;
    liveStep?.classList.remove('live');
    reply = null;
    return;
  }
  if (!entry.text?.trim()) return; // nothing to say: no empty bullet
  let node = steps.get(entry.id);
  if (!node) {
    const last = feed.lastElementChild;
    const follows = last?.classList.contains('did') && last.dataset.session === entry.session;
    if (entry.who && !follows) add(el('div', 'from', entry.who));
    node = add(el('div', 'did'));
    node.dataset.session = entry.session;
    node.append(el('span', 'what'));
    steps.set(entry.id, node);
    liveStep?.classList.remove('live');
    liveStep = node;
    node.classList.add('live');
    reply = null; // text after a step starts a new paragraph block
  }
  const text = entry.text.charAt(0).toUpperCase() + entry.text.slice(1);
  node.querySelector('.what').textContent = entry.stopped ? `${STOPPED[entry.stopped] || 'Stopped'}: ${entry.text}`
    : entry.failed ? `${text} (didn't work${entry.why ? `: ${entry.why}` : ''})` : text;
  node.classList.toggle('failed', !!entry.failed);
  node.classList.toggle('stopped', !!entry.stopped);
});

let reply = null; // { node, text } for the reply being streamed
let waiting = null;
function setSend() {
  const send = $('send');
  send.textContent = running ? 'Stop' : 'Send';
  send.disabled = !running && !$('prompt').value.trim() && !state.picks.length;
}

loui.on('chat', (e) => {
  if (e.type === 'user') {
    const node = el('div', 'said');
    if (e.picks.length) {
      const thumbs = el('div', 'thumbs');
      for (const p of e.picks) {
        if (!p.thumb) continue;
        const img = el('img');
        img.src = p.thumb;
        img.alt = p.name;
        thumbs.append(img);
      }
      node.append(thumbs);
    }
    node.append(e.text);
    add(node);
    feed.scrollTop = feed.scrollHeight;
  } else if (e.type === 'start') {
    running = true;
    waiting = add(el('div', 'reply waiting'));
  } else if (e.type === 'text-start') {
    reply = null;
  } else if (e.type === 'text') {
    waiting?.remove();
    waiting = null;
    liveStep?.classList.remove('live');
    if (!reply) reply = { node: add(el('div', 'reply')), text: '' };
    const pinned = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;
    reply.text += e.text;
    markdown(reply.node, reply.text);
    if (pinned) feed.scrollTop = feed.scrollHeight;
  } else if (e.type === 'error') {
    add(el('div', 'trouble', e.text));
  } else if (e.type === 'stopped') {
    add(el('div', 'did stopped', 'Stopped')); // the Stop button: one quiet line
  } else if (e.type === 'done') {
    running = false;
    reply = null;
    waiting?.remove();
    waiting = null;
    liveStep?.classList.remove('live');
  } else if (e.type === 'reset') {
    steps.clear();
    feed.replaceChildren(empty);
  }
  setSend();
});

const prompt = $('prompt');
function sendMessage(text) {
  if (running) return loui.send('chat:stop');
  text = text.trim();
  if (!text && !state.picks.length) return;
  loui.send('chat:send', {
    text: text || 'Take a look at what I pointed at.',
    pickIds: state.picks.map((p) => p.id),
  });
  prompt.value = '';
  setSend();
}
$('composer').onsubmit = (e) => { e.preventDefault(); sendMessage(prompt.value); };
prompt.oninput = setSend;
prompt.onkeydown = (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (!running) sendMessage(prompt.value);
  }
};
for (const starter of document.querySelectorAll('.starter')) {
  starter.onclick = () => sendMessage(starter.textContent);
}
// A new conversation wipes this one: asked first while Claude is answering,
// or once there is more than a few messages to lose.
askFirst($('new-chat'), 'Clear this one?',
  () => running || feed.querySelectorAll('.said, .reply').length > 3,
  () => loui.send('chat:reset'));
setSend();
