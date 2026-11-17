// The Sessions panel: what each Claude session did, kept after it has gone
// (src/main/activity.js). A list of recent sessions; opening one shows its
// steps with a picture of the page after each one that acted, and clicking a
// page opens it in a new tab of the user's. Takes the Claude panel's place
// while open, as history does. Loaded after ui.js, whose $, el, setIcon and
// togglePanel it uses.
(() => {
  ICON.trash = svg('<path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4"/>', 14);
  setIcon($('activity-close'), 'close');
  const panel = $('activity');
  const list = $('activity-list');
  const isOpen = () => document.body.classList.contains('activity-open');
  const ask = (request) => loui.send('activity', request);
  let viewing = null; // the id of the session on show, or null for the list

  function show(open) {
    if (open) {
      for (const other of ['history', 'bookmarks', 'passwords']) {
        if ($(other) && !$(other).hidden) $(`${other}-close`).click();
      }
    }
    document.body.classList.toggle('activity-open', open);
    panel.hidden = !open;
    $('activity-confirm').hidden = true;
    $('panel-toggle').classList.toggle('on', !open && panelOpen());
    if (open) {
      viewing = null;
      ask({ do: 'list' });
    }
  }
  $('activity-open').onclick = () => show(true);
  $('activity-close').onclick = () => show(false);
  loui.on('show-activity', () => show(true));
  panel.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (viewing) back();
    else show(false);
  });
  // Asking for the Claude panel brings it back.
  const claudeInstead = () => {
    if (!isOpen()) return;
    show(false);
    togglePanel(true);
  };
  $('panel-toggle').addEventListener('click', claudeInstead);
  loui.on('toggle-panel', claudeInstead);
  loui.on('show-relay', claudeInstead);
  // Another panel taking this place (history, bookmarks, passwords) closes this one.
  new MutationObserver(() => {
    const cls = document.body.classList;
    if (isOpen() && ['history-open', 'bookmarks-open', 'passwords-open'].some((c) => cls.contains(c))) show(false);
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });

  $('activity-clear').onclick = () => { $('activity-confirm').hidden = false; };
  $('activity-confirm-no').onclick = () => { $('activity-confirm').hidden = true; };
  $('activity-confirm-yes').onclick = () => {
    $('activity-confirm').hidden = true;
    viewing = null;
    ask({ do: 'clear' });
  };
  $('activity-keep').onchange = () => ask({ do: 'keep', days: Number($('activity-keep').value) });

  function back() {
    viewing = null;
    ask({ do: 'list' });
  }

  // ── words ───────────────────────────────────────────────────────────────
  const time = (t) => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const dayOf = (t) => {
    const d = new Date(t);
    if (d.toDateString() === new Date().toDateString()) return 'Today';
    if (d.toDateString() === new Date(Date.now() - 864e5).toDateString()) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  };
  const length = (ms) => {
    const min = Math.round(ms / 60000);
    if (min < 1) return 'under a minute';
    if (min < 60) return `${min} min`;
    return `${Math.floor(min / 60)} h ${min % 60} min`;
  };
  const ENDED = {
    ended: 'ended', closed: 'you closed it', lost: 'connection lost',
    quit: 'cut short when Loui closed', refused: 'not let in',
  };
  const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;
  // "2:14 PM · 3 min · 12 steps, 1 failed · ended"
  function facts(s) {
    const parts = [time(s.start)];
    if (s.end) parts.push(length(s.end - s.start));
    parts.push(plural(s.steps, 'step') + (s.failed ? `, ${s.failed} failed` : ''));
    const node = el('span', 'facts', parts.join(' · '));
    const how = s.live ? 'working now' : ENDED[s.ended];
    if (how) node.append(' · ', el('span', s.live ? 'activity-live' : s.ended === 'ended' ? '' : 'activity-bad', how));
    return node;
  }
  const nameOf = (s) => (s.connector && s.connector !== s.label ? `${s.label} · ${s.connector}` : s.label);
  const plainUrl = (url) => url.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');

  function small(icon, label, onclick) {
    const b = el('button', 'remove');
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    setIcon(b, icon);
    b.onclick = onclick;
    return b;
  }

  // ── the list ────────────────────────────────────────────────────────────
  function drawList({ items, keepDays }) {
    $('activity-keep').value = String(keepDays);
    $('activity-clear').hidden = false;
    $('activity-clear').disabled = !items.length;
    const nodes = [];
    let day = '';
    for (const s of items) {
      const label = dayOf(s.start);
      if (label !== day) nodes.push(el('h2', '', (day = label)));
      const row = el('div', 'activity-row');
      row.dataset.id = s.id;
      const open = el('button', 'open');
      open.type = 'button';
      open.append(el('span', 'name', nameOf(s)), facts(s));
      open.onclick = () => { viewing = s.id; ask({ do: 'open', id: s.id }); };
      row.append(open, small('trash', `Delete what ${s.label} did`, () => ask({ do: 'delete', id: s.id })));
      nodes.push(row);
    }
    if (!nodes.length) {
      nodes.push(el('p', 'none', keepDays
        ? 'When a Claude session uses Loui, what it did shows up here, and stays after it has gone.'
        : 'Loui is set not to keep what Claude sessions do.'));
    }
    list.replaceChildren(...nodes);
  }

  // ── one session ─────────────────────────────────────────────────────────
  function drawSession(log) {
    $('activity-clear').hidden = true;
    const head = el('div', 'activity-summary');
    const tools = el('div', 'row');
    const all = el('button', 'quiet', 'All sessions');
    all.type = 'button';
    all.onclick = back;
    const del = el('button', 'quiet', 'Delete');
    del.type = 'button';
    del.onclick = () => { ask({ do: 'delete', id: log.id }); back(); };
    tools.append(all, del);
    const s = {
      ...log, steps: log.steps.filter((x) => x.kind === 'tool').length, failed: log.steps.filter((x) => x.error).length,
    };
    head.append(tools, el('span', 'activity-session-name', nameOf(log)), facts(s));
    const nodes = [head];
    for (const step of log.steps) {
      const row = el('div', `activity-step step-${step.kind}`);
      row.append(el('span', 'time', time(step.at)), el('span', 'what', step.label));
      if (step.detail) row.append(el('span', 'detail', `“${step.detail}”`));
      if (step.error && step.kind === 'tool') row.append(el('span', 'error', step.error));
      if (step.url && /^https?:/i.test(step.url)) {
        // The page's title opens it in a new tab of the user's; so does its picture.
        const page = el('div', 'page');
        const visit = () => ask({ do: 'visit', url: step.url });
        const link = el('button', 'link', step.title || plainUrl(step.url));
        link.type = 'button';
        link.title = `Open ${step.url} in a new tab`;
        link.onclick = visit;
        page.append(link);
        if (step.thumb) {
          const img = el('img');
          img.src = step.thumb;
          img.alt = `The page after this step: ${step.title || plainUrl(step.url)}`;
          img.title = link.title;
          img.onclick = visit;
          page.append(img);
        }
        row.append(page);
      }
      nodes.push(row);
    }
    if (!log.steps.length) nodes.push(el('p', 'none', 'It did nothing in Loui.'));
    list.replaceChildren(...nodes);
  }

  loui.on('activity', (m) => {
    if (m.type === 'changed') {
      if (isOpen()) ask(viewing ? { do: 'open', id: viewing } : { do: 'list' });
    } else if (m.type === 'list') {
      if (!viewing) drawList(m);
    } else if (m.type === 'session') {
      if (m.id !== viewing) return;
      if (m.log) drawSession(m.log);
      else back(); // deleted meanwhile
    }
  });
})();
