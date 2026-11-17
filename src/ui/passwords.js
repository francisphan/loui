// Passwords in the window chrome: the key in the address bar, the offer to
// save (a strip above the page, which no page can draw in or cover), and the
// Passwords panel. The store is in the main process (src/main/passwords.js).
// A password reaches this window only when the user asks to see one; the key
// opens a native menu in the main process, and filling happens there.
// Loaded after bookmarks.js; uses $, el, svg, ICON, setIcon, activeTab,
// panelOpen and togglePanel from ui.js. Sites and usernames are set as text.
(() => {
  ICON.key = svg('<circle cx="5.5" cy="10.5" r="3"/><path d="m7.6 8.4 6-6M11.5 4.5l2 2M9.8 6.2l1.5 1.5"/>');
  ICON.eye = svg('<path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>', 14);
  ICON.copy = svg('<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.5v-1h-8v8h1"/>', 14);

  const ask = (request) => loui.send('passwords', request);
  const SHOWN_MS = 30000;

  // ── the key ─────────────────────────────────────────────────────────────
  const key = $('key');
  setIcon(key, 'key');
  key.onclick = () => {
    const r = key.getBoundingClientRect();
    ask({ do: 'menu', x: r.left, y: r.bottom });
  };

  // ── the offer ───────────────────────────────────────────────────────────
  let offerId = null;
  const buttons = [$('pw-offer-save'), $('pw-offer-never'), $('pw-offer-later')];
  function drawOffer(o) {
    $('pw-offer').hidden = !o;
    if (!o) { offerId = null; return; }
    if (o.id === offerId) return;
    offerId = o.id;
    const text = $('pw-offer-text');
    if (o.update) {
      text.replaceChildren('Update the password for ', el('strong', '', o.username || 'your account'), ' on ', el('strong', '', o.site), '?');
    } else {
      text.replaceChildren('Save password for ', el('strong', '', o.site), '?');
      if (o.username) text.append(el('span', 'who', o.username));
    }
    $('pw-offer-save').textContent = o.update ? 'Update' : 'Save';
    $('pw-offer-never').hidden = !!o.update;
    // As with permission prompts: a click meant for the page as the strip
    // appears cannot answer it.
    for (const b of buttons) b.disabled = true;
    setTimeout(() => { if (offerId === o.id) for (const b of buttons) b.disabled = false; }, 600);
  }
  const answer = (choice) => { if (offerId != null) ask({ do: 'answer', id: offerId, choice }); };
  $('pw-offer-save').onclick = () => answer('save');
  $('pw-offer-never').onclick = () => answer('never');
  $('pw-offer-later').onclick = () => answer('later');

  loui.on('state', (next) => {
    const p = next.passwords || {};
    key.hidden = !p.key;
    drawOffer(p.offer);
  });

  // ── the panel ───────────────────────────────────────────────────────────
  // Takes the Claude panel's place while open, as History and Bookmarks do;
  // one of the three at a time.
  setIcon($('passwords-close'), 'close');
  const panel = $('passwords');
  const search = $('passwords-search');
  const shown = new Map(); // id -> { password, timer }: passwords on show
  let data = { available: true, items: [], never: [] };
  let editing = null, deleting = null;
  const isOpen = () => document.body.classList.contains('passwords-open');

  function hideAll() {
    for (const s of shown.values()) clearTimeout(s.timer);
    shown.clear();
  }
  function showPasswords(show) {
    if (show) {
      if (!$('history').hidden) $('history-close').click();
      if (!$('bookmarks').hidden) $('bookmarks-close').click();
    } else {
      hideAll();
      editing = deleting = null;
    }
    document.body.classList.toggle('passwords-open', show);
    panel.hidden = !show;
    $('panel-toggle').classList.toggle('on', !show && panelOpen());
    if (show) {
      ask({ do: 'list' });
      search.focus();
    }
  }
  $('passwords-close').onclick = () => showPasswords(false);
  $('passwords-import').onclick = () => ask({ do: 'import' });
  search.oninput = () => draw();
  search.onkeydown = (e) => { if (e.key === 'Escape') showPasswords(false); };
  // Opening another panel, or asking for Claude's, closes this one.
  const instead = (claude) => () => {
    if (!isOpen()) return;
    showPasswords(false);
    if (claude) togglePanel(true);
  };
  $('panel-toggle').addEventListener('click', instead(true));
  loui.on('toggle-panel', instead(true));
  loui.on('show-relay', instead(true));
  $('history-toggle').addEventListener('click', instead(false));
  loui.on('show-history', instead(false));
  loui.on('bookmarks', (m) => { if (m.type === 'panel') instead(false)(); });

  const small = (className, icon, label, onclick) => {
    const b = el('button', className);
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    setIcon(b, icon);
    b.onclick = onclick;
    return b;
  };
  const textButton = (label, onclick, className = 'quiet') => {
    const b = el('button', className, label);
    b.type = 'button';
    b.onclick = onclick;
    return b;
  };

  function editor(p) {
    const form = el('form', 'password-edit');
    const user = el('input');
    user.type = 'text';
    user.value = p.username;
    user.autocomplete = 'off';
    user.spellcheck = false;
    user.setAttribute('aria-label', 'Username');
    const pass = el('input');
    pass.type = 'password';
    pass.autocomplete = 'new-password';
    pass.placeholder = 'New password (empty keeps it)';
    pass.setAttribute('aria-label', 'New password');
    const row = el('div', 'row');
    row.append(textButton('Cancel', () => { editing = null; draw(); }), textButton('Save', null, 'quiet strong'));
    row.lastChild.type = 'submit';
    form.append(user, pass, row);
    form.onsubmit = (e) => {
      e.preventDefault();
      ask({ do: 'update', id: p.id, username: user.value, password: pass.value });
      pass.value = '';
      editing = null;
    };
    form.onkeydown = (e) => { if (e.key === 'Escape') { e.stopPropagation(); editing = null; draw(); } };
    setTimeout(() => user.focus(), 0);
    return form;
  }

  function row(p) {
    if (editing === p.id) return editor(p);
    const node = el('div', 'password-row');
    node.dataset.id = p.id;
    if (deleting === p.id) {
      node.classList.add('confirm');
      node.append(el('span', 'ask', `Delete the password for ${p.username || 'this login'}?`),
        textButton('Cancel', () => { deleting = null; draw(); }),
        textButton('Delete', () => { deleting = null; ask({ do: 'remove', id: p.id }); }, 'quiet danger'));
      return node;
    }
    const who = el('div', 'who');
    who.append(el('span', 'user', p.username || '(no username)'));
    const secret = shown.get(p.id);
    who.append(el('span', 'secret' + (secret ? ' on' : ''), p.unreadable ? "Can't be read on this computer" : secret ? secret.password : '••••••••'));
    node.append(who);
    if (!p.unreadable) {
      node.append(
        small('reveal', 'eye', secret ? `Hide the password for ${p.username}` : `Show the password for ${p.username}`, () => {
          if (shown.has(p.id)) { clearTimeout(shown.get(p.id).timer); shown.delete(p.id); draw(); } else ask({ do: 'reveal', id: p.id });
        }),
        small('copy', 'copy', `Copy the password for ${p.username}`, () => ask({ do: 'copy', id: p.id })),
        small('edit', 'edit', `Edit ${p.username}`, () => { editing = p.id; deleting = null; draw(); }),
      );
    }
    node.append(small('remove', 'close', `Delete ${p.username}`, () => { deleting = p.id; editing = null; draw(); }));
    return node;
  }

  function draw() {
    $('passwords-off').hidden = data.available;
    $('passwords-off').textContent = data.available ? '' : `Passwords are off. ${data.why}`;
    $('passwords-import').disabled = !data.available;
    search.hidden = !data.available;
    const terms = search.value.toLowerCase().split(/\s+/).filter(Boolean);
    const items = data.items.filter((p) => terms.every((t) => `${p.site} ${p.username}`.toLowerCase().includes(t)));
    const nodes = [];
    let site = '';
    for (const p of items) {
      if (p.site !== site) {
        const h = el('h2', '', (site = p.site));
        h.title = p.origin;
        nodes.push(h);
      }
      nodes.push(row(p));
    }
    if (!items.length && data.available) {
      nodes.push(el('p', 'none', terms.length ? 'No saved passwords match that.'
        : 'Passwords you save when you sign in show up here. Import brings them over from Brave or Chrome.'));
    }
    if (data.never.length && !terms.length) {
      nodes.push(el('h2', '', 'Never saved for'));
      for (const n of data.never) {
        const r = el('div', 'password-row never');
        r.append(el('span', 'user', n.site), textButton('Remove', () => ask({ do: 'unnever', origin: n.origin })));
        nodes.push(r);
      }
    }
    $('passwords-list').replaceChildren(...nodes);
  }

  loui.on('passwords', (m) => {
    if (m.type === 'list') {
      data = m;
      for (const id of [...shown.keys()]) if (!m.items.some((p) => p.id === id)) shown.delete(id);
      if (isOpen()) draw();
    } else if (m.type === 'reveal') {
      if (!isOpen()) return;
      clearTimeout(shown.get(m.id)?.timer);
      shown.set(m.id, { password: m.password, timer: setTimeout(() => { shown.delete(m.id); draw(); }, SHOWN_MS) });
      draw();
    } else if (m.type === 'panel') {
      showPasswords(true);
    }
  });
})();
