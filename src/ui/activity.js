// The Sessions panel: what each Claude session did, kept after it has gone
// (src/main/activity.js). A list of recent sessions; opening one shows its
// steps with a picture of the page after each one that acted, and clicking a
// page opens it in a new tab of the user's. Takes the Claude panel's place
// while open, as history does. Loaded after ui.js, whose $, el, setIcon and
// togglePanel it uses.
(() => {
  ICON.trash = svg('<path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4"/>', 14);
  ICON.left = svg('<path d="M10 3 5 8l5 5"/>', 14);
  setIcon($('activity-close'), 'close');
  const panel = $('activity');
  const list = $('activity-list');
  const isOpen = () => document.body.classList.contains('activity-open');
  const ask = (request) => loui.send('activity', request);
  let viewing = null; // the id of the session on show, or null for the list
  const pics = new Map(); // step number -> its picture, for the session on show: each is sent once
  const view = (id) => { if (id !== viewing) pics.clear(); viewing = id; };

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
      $('activity-close').focus(); // the panel has the keyboard, so Esc closes it
    } else focusPage();
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
    deleting = null;
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
    ended: 'ended', closed: 'you ended it', lost: 'connection lost',
    quit: 'cut short when Loui closed', refused: 'not let in',
  };
  // A session still connected is idle unless it is doing something, has a
  // question for the user, or the user has taken over (the helm's words). Its group in this window is read from the window's
  // state, which is newer than the list; one in another window from the list.
  const LIVE = { working: 'working', paused: 'paused', asking: 'asking', open: 'idle' };
  const statusOf = (s) => {
    const g = state.groups.find((x) => x.id === s.session);
    return g ? (g.paused ? 'paused' : g.asking ? 'asking' : g.busy ? 'working' : 'open') : s.status || 'open';
  };
  const STOPPED = { blocked: 'You blocked this', paused: 'Paused by you', taken: 'You took the tab back', unanswered: 'You did not answer, so it was stopped' };
  const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;
  // "2:14 PM · 3 min · 12 steps, 1 failed · ended"
  function facts(s) {
    const parts = [time(s.start)];
    if (s.end) parts.push(length(s.end - s.start));
    parts.push(plural(s.steps, 'step') + (s.failed ? `, ${s.failed} failed` : ''));
    const node = el('span', 'facts', parts.join(' · '));
    const how = s.live ? LIVE[statusOf(s)] : ENDED[s.ended];
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

  // What can be done with a session that is still connected: see its tabs,
  // take over or hand back, and end it (asked twice: its tabs close for good).
  let ending = null; // the session whose row asks "End session?"
  function controls(s) {
    const box = el('div', 'activity-controls');
    const button = (label, onclick, cls = 'quiet') => {
      const b = el('button', cls, label);
      b.type = 'button';
      b.onclick = onclick;
      box.append(b);
    };
    const redraw = () => drawn && drawList(drawn);
    if (ending === s.session) {
      box.append(el('span', 'sure', 'End session? Its tabs close.'));
      button('Cancel', () => { ending = null; redraw(); });
      button('End session', () => { ending = null; loui.send('group:close', s.session); }, 'quiet danger');
      return box;
    }
    const paused = statusOf(s) === 'paused';
    button('Show tabs', () => ask({ do: 'show', id: s.session }));
    button(paused ? 'Let Claude continue' : 'Take over', () => loui.send('pause', { group: s.session, on: !paused }));
    button('End session', () => { ending = s.session; redraw(); });
    return box;
  }

  // ── the list ────────────────────────────────────────────────────────────
  let drawn = null; // the list as last received, redrawn when a session's status changes
  function drawList({ items, keepDays }) {
    drawn = { items, keepDays };
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
      open.onclick = () => { view(s.id); ask({ do: 'open', id: s.id }); };
      row.append(open, small('trash', s.unreadable ? 'Delete it' : `Delete what ${s.label} did`, () => ask({ do: 'delete', id: s.id })));
      if (s.live && s.status) row.append(controls(s));
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
  let deleting = null; // the session whose Delete asks "Delete what it did?"
  function drawSession(log) {
    $('activity-clear').hidden = true;
    const head = el('div', 'activity-summary');
    const tools = el('div', 'row');
    const tool = (icon, label, cls, onclick) => {
      const b = el('button', cls);
      b.type = 'button';
      b.innerHTML = ICON[icon];
      b.append(label);
      b.onclick = onclick;
      return b;
    };
    const all = tool('left', 'All sessions', 'quiet', back);
    // Deleting cannot be undone, so Delete asks first, as "Clear all" does.
    const sure = deleting === log.id;
    const del = tool('trash', sure ? 'Delete what it did?' : 'Delete', sure ? 'quiet danger' : 'quiet', () => {
      if (sure) { ask({ do: 'delete', id: log.id }); return back(); }
      deleting = log.id;
      drawSession(log);
      list.querySelector('.activity-summary .danger')?.focus();
    });
    del.onkeydown = (e) => { if (e.key === 'Escape' && sure) { e.stopPropagation(); deleting = null; drawSession(log); } };
    tools.append(all, del);
    const s = {
      ...log, steps: log.steps.filter((x) => x.kind === 'tool').length,
      failed: log.steps.filter((x) => x.error && x.kind === 'tool' && !x.stopped).length,
    };
    head.append(tools, el('span', 'activity-session-name', nameOf(log)), facts(s));
    const nodes = [head];
    for (const step of log.steps) {
      const row = el('div', `activity-step step-${step.kind}`);
      // Worded as in the Claude panel's feed: "Opening…", not "opening…".
      row.append(el('span', 'time', time(step.at)), el('span', 'what', step.label.charAt(0).toUpperCase() + step.label.slice(1)));
      if (step.detail) row.append(el('span', 'detail', `“${step.detail}”`));
      if (step.stopped && step.kind === 'tool') row.append(el('span', 'detail', STOPPED[step.stopped] || 'Stopped'));
      else if (step.error && step.kind === 'tool') row.append(el('span', 'error', step.error));
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

  // Working, paused or open changes with the window's state, not with the log.
  let words = '';
  loui.on('state', () => {
    if (!isOpen() || viewing || !drawn) return;
    const now = drawn.items.filter((s) => s.live).map((s) => s.session + statusOf(s)).join();
    if (now !== words) drawList(drawn);
    words = now;
  });

  loui.on('activity', (m) => {
    if (m.type === 'changed') {
      // ids: the logs that changed. Another session's steps do not redraw this one.
      if (!isOpen()) return;
      if (!viewing) ask({ do: 'list' });
      else if (!m.ids || m.ids.includes(viewing)) ask({ do: 'open', id: viewing, have: [...pics.keys()] });
    } else if (m.type === 'list') {
      if (!viewing) drawList(m);
    } else if (m.type === 'session') {
      if (m.id !== viewing) return;
      // A picture this window already has comes back as true.
      m.log?.steps.forEach((s, i) => {
        if (s.thumb === true) s.thumb = pics.get(i);
        else if (s.thumb) pics.set(i, s.thumb);
      });
      if (m.log) drawSession(m.log);
      else back(); // deleted meanwhile
    }
  });
})();
