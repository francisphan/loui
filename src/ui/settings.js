// The Settings window (see src/main/settings-window.js). The main process
// sends what every setting is; this page draws it, and asks for a change the
// moment a control is used (there is no Save button). It keeps nothing itself.
// Names of sites, sessions and connectors are set with textContent, never as HTML.
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};
const main = document.getElementById('st-main');
const search = document.getElementById('st-search');
const tablist = document.getElementById('st-sections');

let state = null;
let current = 'general';
const rows = []; // { id, section, group, node, words, shown(state), update(state) }

// Asks the main process, then draws how things stand afterwards.
async function send(what, arg) {
  const next = await loui.act(what, arg);
  if (next) draw(next);
  return next;
}

// A quiet word beside a control: "Saved", or what was wrong with the entry.
function say(note, text, wrong = false) {
  clearTimeout(note.timer);
  note.textContent = text;
  note.classList.toggle('st-wrong', wrong);
  if (text && !wrong) note.timer = setTimeout(() => { note.textContent = ''; }, 2500);
}

// A button that asks before it acts, in place, as the window chrome's do
// (askFirst in ui.js): while needed() holds it turns into the question for a
// few seconds, and pressing it again does it. Esc, or waiting, leaves things be.
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

// ── the kinds of setting ────────────────────────────────────────────────────
// Each takes { id, label, help, shown?(state) } and returns a row. label and
// help are also what the search box looks through.
function frame(def, { wide = false, labelFor = false } = {}) {
  const node = el('div', wide ? 'st-row st-wide' : 'st-row');
  node.dataset.setting = def.id;
  const words = el('div', 'st-words');
  const label = el(labelFor ? 'label' : 'span', 'st-label', def.label);
  label.id = `label-${def.id}`;
  if (labelFor) label.htmlFor = `set-${def.id}`;
  const help = el('p', 'st-help', def.help);
  help.id = `help-${def.id}`;
  words.append(label, help);
  const control = el('div', 'st-control');
  const note = el('span', 'st-note');
  note.setAttribute('role', 'status');
  control.append(note);
  node.append(words, control);
  const named = (input) => {
    input.id = `set-${def.id}`;
    input.setAttribute('aria-describedby', help.id);
    if (!labelFor) input.setAttribute('aria-labelledby', label.id);
    return input;
  };
  return { node, words, control, note, named };
}

// On or off. get(state) -> boolean; set(on) -> [what, arg]. seen: the change
// shows elsewhere at once (the window itself changes), so no "Saved".
function toggle(def) {
  const f = frame(def, { labelFor: true });
  const input = f.named(el('input', 'st-switch'));
  input.type = 'checkbox';
  input.setAttribute('role', 'switch');
  f.control.append(input);
  input.onchange = async () => {
    const want = input.checked;
    const next = await send(...def.set(want));
    if (next && def.get(next) === want && !def.seen) say(f.note, 'Saved');
  };
  return { ...def, node: f.node, update: (s) => { input.checked = !!def.get(s); } };
}

// One of several. options(state) -> [[value, label]…]; get(state) -> value;
// set(value) -> [what, arg], or null when choosing it changes nothing yet.
function choice(def) {
  const f = frame(def, { labelFor: true });
  const select = f.named(el('select'));
  f.control.append(select);
  let listed = '';
  select.onchange = async () => {
    const want = select.value;
    const request = def.set(want);
    if (!request) return draw(state);
    const next = await send(...request);
    if (next && String(def.get(next)) === want && !def.seen) say(f.note, 'Saved');
  };
  return {
    ...def, node: f.node,
    update: (s) => {
      const options = def.options(s);
      const key = JSON.stringify(options);
      if (key !== listed) {
        listed = key;
        select.replaceChildren(...options.map(([value, label]) => Object.assign(el('option', '', label), { value: String(value) })));
      }
      select.value = String(def.get(s));
    },
  };
}

// A line of text, or a number with unit. It applies on Enter or on leaving the
// field. get(state) -> text; set(text) -> [what, arg]; wrong(text) -> why it
// cannot be used, if it cannot.
function entry(def) {
  const f = frame(def, { labelFor: true });
  const form = el('form');
  const input = f.named(el('input'));
  input.type = def.unit ? 'number' : 'text';
  input.spellcheck = false;
  input.autocomplete = 'off';
  if (def.placeholder) input.placeholder = def.placeholder;
  if (def.unit) { input.min = def.min; input.step = 1; }
  form.append(input);
  if (def.unit) form.append(el('span', 'st-unit', def.unit));
  f.control.append(form);
  let dirty = false;
  const apply = async () => {
    if (!dirty) return;
    const want = input.value.trim();
    const why = def.wrong?.(want);
    if (why) return say(f.note, why, true);
    dirty = false;
    const next = await send(...def.set(want));
    if (!next) return;
    if (String(def.get(next)) === String(def.kept ? def.kept(want) : want)) say(f.note, 'Saved');
    else say(f.note, def.refused || 'Not changed.', true);
  };
  input.oninput = () => { dirty = true; say(f.note, ''); };
  input.onchange = apply;
  form.onsubmit = (e) => { e.preventDefault(); apply(); };
  return {
    ...def, node: f.node,
    update: (s) => { if (!dirty) input.value = def.get(s); },
  };
}

// A list with a button on each row that takes it off, and (add) a field to
// add to it. items(state) -> [{ text, detail?, button, aria, act: [what, arg] }].
function list(def) {
  const f = frame(def, { wide: true });
  f.control.remove();
  const ul = el('ul', 'st-list');
  ul.setAttribute('aria-labelledby', `label-${def.id}`);
  f.node.append(ul);
  let input = null, note = null;
  if (def.add) {
    const form = el('form', 'st-add');
    input = el('input');
    input.type = 'text';
    input.id = `set-${def.id}`;
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.placeholder = def.add.placeholder;
    input.setAttribute('aria-label', def.add.aria);
    const add = el('button', 'st-button', 'Add');
    add.type = 'submit';
    note = el('span', 'st-note');
    note.setAttribute('role', 'status');
    form.append(input, add, note);
    form.onsubmit = async (e) => {
      e.preventDefault();
      const want = input.value.trim();
      if (!want) return;
      const before = def.items(state).length;
      if (def.add.busy) say(note, def.add.busy); // an add that takes a moment (it is checked first)
      const next = await send(...def.add.act(want));
      if (next && def.items(next).length > before) { input.value = ''; say(note, ''); }
      else say(note, (typeof def.add.refused === 'function' ? def.add.refused(next) : def.add.refused) || 'That is already listed, or is not a site.', true);
    };
    input.oninput = () => say(note, '');
    f.node.append(form);
  }
  let drawn = '';
  return {
    ...def, node: f.node,
    update: (s) => {
      const items = def.items(s);
      const key = JSON.stringify(items);
      if (key === drawn) return;
      drawn = key;
      // The keyboard stays in the list when the row it was on goes.
      const at = [...ul.children].findIndex((li) => li.contains(document.activeElement));
      ul.replaceChildren(...items.map((item) => {
        const li = el('li');
        const off = el('button', 'quiet', item.button);
        off.type = 'button';
        off.setAttribute('aria-label', item.aria);
        off.onclick = () => send(...item.act);
        li.append(el('span', 'st-item', item.text));
        if (item.detail) li.append(el('span', 'st-detail', item.detail));
        li.append(off);
        return li;
      }));
      if (!items.length) ul.append(el('li', 'st-empty', def.empty));
      if (at >= 0) (ul.children[Math.min(at, items.length - 1)]?.querySelector('button') || input || search).focus();
    },
  };
}

// A place, by name: the field to type it in, and under it the place the name
// was taken to mean ("Mendoza, Mendoza, Argentina"), with "Not this one?" for
// the other places of that name. found(state) -> the place; others(state) ->
// [{ full, … }] or null before they were asked for; ask, choose(other) -> [what, arg].
function place(def) {
  const row = entry(def);
  const words = row.node.querySelector('.st-words');
  const value = el('p', 'st-value');
  value.id = `value-${def.id}`;
  const name = el('span');
  const not = el('button', 'quiet', 'Not this one?');
  not.type = 'button';
  not.id = `set-${def.id}-others`;
  value.append(name, ' ', not);
  const ul = el('ul', 'st-list');
  ul.setAttribute('aria-label', 'Other places by that name');
  words.append(value, ul);
  let open = false, drawn = '';
  not.onclick = async () => {
    open = !open;
    if (open) await send(...def.ask);
    else draw(state);
  };
  return {
    ...row,
    update: (s) => {
      row.update(s);
      const found = def.found(s);
      value.hidden = !found;
      name.textContent = found;
      if (!found) open = false;
      const others = open ? def.others(s) : null;
      not.setAttribute('aria-expanded', String(open));
      ul.hidden = !others;
      const key = JSON.stringify(others);
      if (key === drawn) return;
      drawn = key;
      ul.replaceChildren(...(others || []).map((o) => {
        const li = el('li');
        const use = el('button', 'quiet', 'Use this');
        use.type = 'button';
        use.setAttribute('aria-label', `Use ${o.full}`);
        use.onclick = async () => { open = false; await send(...def.choose(o)); not.focus(); };
        li.append(el('span', 'st-item', o.full), use);
        return li;
      }));
      if (others && !others.length) ul.append(el('li', 'st-empty', 'No other place by that name was found.'));
    },
  };
}

// Things to add with one press. items(state) -> [{ label, aria, act: [what, arg] }];
// refused(state) -> why the last one was not added.
function offers(def) {
  const f = frame(def, { wide: true });
  f.control.remove();
  const box = el('div', 'st-offers');
  box.setAttribute('role', 'group');
  box.setAttribute('aria-labelledby', `label-${def.id}`);
  const note = el('span', 'st-note');
  note.setAttribute('role', 'status');
  f.node.append(box, note);
  let drawn = '';
  return {
    ...def, node: f.node,
    update: (s) => {
      const items = def.items(s);
      const key = JSON.stringify(items);
      if (key === drawn) return;
      drawn = key;
      const at = [...box.children].indexOf(document.activeElement);
      box.replaceChildren(...items.map((item) => {
        const add = el('button', 'st-button', item.label);
        add.type = 'button';
        add.setAttribute('aria-label', item.aria);
        add.onclick = async () => {
          add.disabled = true;
          say(note, def.busy || '');
          const next = await send(...item.act);
          add.disabled = false;
          if (next && def.items(next).some((i) => i.label === item.label)) say(note, def.refused(next) || 'Not added.', true);
          else say(note, 'Added');
        };
        return add;
      }));
      if (at >= 0) (box.children[Math.min(at, items.length - 1)] || search).focus();
    },
  };
}

// Several of many, each a box to tick. items(state) -> [{ value, label, on }];
// set(value, on) -> [what, arg]; refused: what to say when a change did not take.
function ticks(def) {
  const f = frame(def, { wide: true });
  f.control.remove();
  const box = el('div', 'st-ticks');
  box.setAttribute('role', 'group');
  box.setAttribute('aria-labelledby', `label-${def.id}`);
  const note = el('span', 'st-note');
  note.setAttribute('role', 'status');
  f.node.append(box, note);
  const inputs = new Map(); // value -> its checkbox
  let listed = '';
  return {
    ...def, node: f.node,
    update: (s) => {
      const items = def.items(s);
      const key = JSON.stringify(items.map((i) => [i.value, i.label]));
      if (key !== listed) {
        listed = key;
        inputs.clear();
        box.replaceChildren(...items.map((item) => {
          const label = el('label', 'st-tick');
          const input = el('input');
          input.type = 'checkbox';
          input.onchange = async () => {
            const want = input.checked;
            const next = await send(...def.set(item.value, want));
            if (!next) return;
            if (def.items(next).find((i) => i.value === item.value)?.on === want) say(note, 'Saved');
            else say(note, def.refused || 'Not changed.', true);
          };
          inputs.set(item.value, input);
          label.append(input, el('span', '', item.label));
          return label;
        }));
      }
      for (const item of items) inputs.get(item.value).checked = !!item.on;
    },
  };
}

// Something to read, with buttons for what can be done about it.
// value(state) -> text under the label (optional); buttons: [{ id, label,
// act: [what, arg] | function, shown?(state), disabled?(state), ask?: [question, needed(state)], done? }].
function info(def) {
  const f = frame(def);
  const value = def.value ? el('p', 'st-value') : null;
  if (value) {
    value.id = `value-${def.id}`;
    f.words.append(value);
  }
  const buttons = (def.buttons || []).map((b) => {
    const button = el('button', 'st-button', b.label);
    button.type = 'button';
    button.id = `set-${b.id}`;
    button.setAttribute('aria-describedby', `help-${def.id}`);
    const go = async () => {
      const next = typeof b.act === 'function' ? await b.act(f) : await send(...b.act);
      if (next && b.done) say(f.note, b.done);
    };
    if (b.ask) askFirst(button, b.ask[0], () => b.ask[1](state), go);
    else button.onclick = go;
    f.control.append(button);
    return { ...b, button };
  });
  return {
    ...def, node: f.node,
    update: (s) => {
      if (value) value.textContent = def.value(s);
      for (const b of buttons) {
        b.button.hidden = b.shown ? !b.shown(s) : false;
        b.button.disabled = b.disabled ? !!b.disabled(s) : false;
      }
    },
  };
}

// How Claude Code is signed in, in words (the account: chat.js).
function accountWords(a) {
  if (a.signIn) return 'Signing in. Finish in your browser, or in the Claude panel.';
  if (a.checking) return 'Checking…';
  const failed = a.failed ? ` The last sign-in did not work: ${a.failed}` : '';
  if (a.state === 'ready') {
    if (a.kind === 'api-key') return 'Signed in with an API key, not a Claude subscription. Messages in the panel are billed to that key.';
    if (a.kind === 'cloud') return `Set up for a cloud provider${a.detail ? ` (${a.detail})` : ''}, not a Claude subscription.`;
    return `Signed in with your Claude subscription${a.detail ? ` (${a.detail})` : ''}.`;
  }
  if (a.state === 'signed-out') return `Not signed in.${a.detail ? ` ${a.detail}` : ''}${failed}`;
  if (a.state === 'not-installed') return `Claude Code is not installed on this computer${navigator.platform.startsWith('Win') ? ' (or in WSL)' : ''}.`;
  return `Loui could not tell. The panel says so if a message cannot be sent.${failed}`;
}

// The relay key: never shown. "Saved", and a way to put another in its place.
function relayKey(def) {
  const f = frame(def);
  const value = el('p', 'st-value');
  value.id = `value-${def.id}`;
  f.words.append(value);
  const replace = el('button', 'st-button');
  replace.type = 'button';
  replace.id = 'set-relay-key-replace';
  const form = el('form');
  const input = el('input');
  input.type = 'password';
  input.id = 'set-relay-key';
  input.autocomplete = 'new-password';
  input.setAttribute('aria-label', 'New relay key');
  const save = el('button', 'st-button', 'Save key');
  save.type = 'submit';
  const cancel = el('button', 'st-button', 'Cancel');
  cancel.type = 'button';
  form.append(input, save, cancel);
  form.hidden = true;
  f.control.append(replace, form);
  const close = () => {
    input.value = '';
    form.hidden = true;
    replace.hidden = false;
  };
  replace.onclick = () => {
    replace.hidden = true;
    form.hidden = false;
    say(f.note, '');
    input.focus();
  };
  cancel.onclick = () => { close(); replace.focus(); };
  form.onkeydown = (e) => { if (e.key === 'Escape') { e.stopPropagation(); cancel.onclick(); } };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const key = input.value.trim();
    if (!key) return;
    close();
    const next = await send('relay', { key });
    if (next?.claude.relay.hasKey) say(f.note, 'Saved');
    replace.focus();
  };
  return {
    ...def, node: f.node,
    update: (s) => {
      const has = s.claude.relay.hasKey;
      value.textContent = has ? 'Saved.' : 'Not set.';
      replace.textContent = has ? 'Replace…' : 'Set…';
    },
  };
}

// Clear browsing data: which kinds, from how far back, and a button that asks
// first. What was ticked is the page's own; nothing of it is a setting.
function clearData(def) {
  const f = frame(def, { wide: true });
  f.control.remove();
  const box = el('div', 'st-clear');
  box.setAttribute('role', 'group');
  box.setAttribute('aria-labelledby', `label-${def.id}`);
  const kinds = [
    ['history', 'Browsing history'],
    ['cookies', 'Cookies and site data (signs you out of sites; all time only)'],
    ['cache', 'Cached files (all time only)'],
  ].map(([kind, text]) => {
    const label = el('label', 'st-tick');
    const input = el('input');
    input.type = 'checkbox';
    input.id = `set-clear-${kind}`;
    input.checked = kind !== 'cookies'; // signing out of every site is asked for, not assumed
    label.append(input, el('span', '', text));
    box.append(label);
    return [kind, input];
  });
  const line = el('div', 'st-clear-line');
  const range = el('select');
  range.id = 'set-clear-range';
  range.setAttribute('aria-label', 'Time range');
  range.append(...[['hour', 'Last hour'], ['day', 'Last day'], ['all', 'All time']]
    .map(([value, label]) => Object.assign(el('option', '', label), { value })));
  const button = el('button', 'st-button', 'Clear');
  button.type = 'button';
  button.id = 'set-clear-data';
  button.setAttribute('aria-describedby', `help-${def.id}`);
  const note = el('span', 'st-note');
  note.setAttribute('role', 'status');
  line.append(range, button, note);
  f.node.append(box, line);
  const none = () => !kinds.some(([, input]) => input.checked);
  box.onchange = () => { button.disabled = none(); };
  askFirst(button, 'Clear it?', () => true, async () => {
    const asked = { range: range.value };
    for (const [kind, input] of kinds) asked[kind] = input.checked;
    note.textContent = '';
    const did = (await send('data:clear', asked))?.privacy.cleared;
    if (!did) return;
    // What was done, and what was not.
    const when = { hour: ' from the last hour', day: ' from the last day', all: '' }[asked.range];
    const done = [], failed = [];
    if ('history' in did) done.push(`${did.history === 1 ? '1 page' : `${did.history} pages`} of history${when}`);
    if ('cookies' in did) (did.cookies ? done : failed).push('cookies and site data');
    if ('cache' in did) (did.cache ? done : failed).push('cached files');
    note.textContent = [done.length ? `Cleared ${done.join(', ')}.` : '', failed.length ? `Could not clear ${failed.join(' or ')}.` : ''].filter(Boolean).join(' ');
    note.classList.toggle('st-wrong', failed.length > 0);
  });
  return { ...def, node: f.node, update: () => {} };
}

// ── what there is to set ────────────────────────────────────────────────────
const days = (n) => (n === 1 ? '1 day' : `${n} days`);
const minutes = (n) => (n === 60 ? '1 hour' : n === 120 ? '2 hours' : n === 1 ? '1 minute' : `${n} minutes`);
// The usual choices, with the one in use if it is none of them (set by hand in settings.json).
const withCurrent = (usual, now, label) => (usual.some(([v]) => v === now) ? usual : [[now, label(now)], ...usual]);
// A spell-check language by name: "British English", "Spanish (Argentina)".
const languages = new Intl.DisplayNames(undefined, { type: 'language' });
const languageName = (code) => { try { return languages.of(code); } catch { return code; } };
const speed = (r) => (r === 1 ? 'Normal' : `${r}×`);
const validSearch = (url) => /^https?:\/\/\S+$/i.test(url) && url.includes('%s');
let customSearch = false; // "Custom address" chosen, its address not yet given

// The relay's status, in the words of the window chrome's relay form (ui.js).
function relayWords(link) {
  const n = link.sessions;
  return link.status === 'connected' ? `Connected as ${link.device}. ${n === 1 ? '1 session is' : `${n} sessions are`} using this browser.`
    : link.status === 'refused' ? `The relay refused this browser: ${link.detail}`
      : link.status === 'off' ? link.detail || 'Not connected. Only the Claude panel can use this browser.'
        : link.status === 'offline' ? `Offline, retrying${link.detail ? `: ${link.detail}` : '.'}`
          : link.detail || 'Connecting…';
}

function listsWords(s) {
  if (!s.ready) return s.updating ? 'Downloading the filter lists…' : 'Not downloaded yet.';
  if (s.updating) return 'Updating…';
  const age = Math.floor((Date.now() - s.updated) / 86400e3);
  return `Updated ${age < 1 ? 'today' : age === 1 ? 'yesterday' : `${age} days ago`}.`;
}

function updateWords(u) {
  if (!u) return 'Updates are off in this copy: it runs from its source, not from the installer.';
  return {
    idle: 'Not checked yet. Loui checks shortly after it starts, and every few hours.',
    checking: 'Checking…',
    latest: `Up to date: ${u.current} is the latest version.`,
    downloading: `Downloading ${u.version}: ${u.percent}%`,
    // The command on a line of its own (the value keeps its line breaks: settings.css).
    ready: u.manual ? `${u.version} is downloaded. Loui can't install it itself: ${u.why}. ${u.again ? 'Try again, or in a terminal run:' : 'In a terminal, run:'}\n${u.manual}\nand then restart Loui.`
      : `${u.version} is ready. Restart Loui to update.`,
    installing: `Installing ${u.version}…`,
    installed: `${u.version} is installed. Restart Loui to use it.`,
    failed: `Couldn't check: ${u.error || 'no reason given'}`,
  }[u.status] || '';
}

const SECTIONS = [
  {
    id: 'general', title: 'General', groups: [
      {
        title: 'Appearance', rows: [
          choice({
            id: 'theme', label: 'Appearance', seen: true,
            help: 'How Loui looks, and the colour scheme pages are told you prefer.',
            options: () => [['dark', 'Dark'], ['light', 'Light'], ['system', 'Follow the system']],
            get: (s) => s.general.theme, set: (v) => ['theme', v],
          }),
          choice({
            id: 'zoom', label: 'Page zoom',
            help: 'How large pages open. A site you zoom from the Zoom menu keeps its own size until you choose Reset zoom there.',
            options: (s) => s.general.zoom.choices.map((p) => [p, `${p}%`]),
            get: (s) => s.general.zoom.percent, set: (v) => ['zoom', Number(v)],
          }),
        ],
      },
      {
        title: 'Languages', rows: [
          ticks({
            id: 'spelling', label: 'Check spelling in',
            help: 'The languages whose spelling is checked as you type in pages, also in private windows. ' +
              'With none ticked, nothing is checked. A dictionary may be downloaded from Google the first time its language is used.',
            shown: (s) => s.general.spelling.available.length > 0,
            items: (s) => s.general.spelling.available.map((code) => ({ value: code, label: languageName(code), on: s.general.spelling.on.includes(code) })),
            set: (code, on) => ['spelling', { code, on }],
          }),
          info({
            id: 'spelling-system', label: 'Spell checker',
            help: 'This system\'s own spell checker is used, in the languages chosen in the system\'s settings.',
            shown: (s) => !s.general.spelling.available.length,
          }),
        ],
      },
      {
        title: 'Starting up', rows: [
          choice({
            id: 'startup', label: 'When Loui starts',
            help: 'Open the windows and tabs you had last time, or begin with a new tab.',
            options: () => [['restore', 'Open the tabs from last time'], ['new', 'Open a new tab']],
            get: (s) => s.general.startup, set: (v) => ['startup', v],
          }),
          toggle({
            id: 'login', label: 'Open Loui when I sign in',
            help: 'Starts Loui when you sign in to this computer.',
            shown: (s) => !!s.general.login,
            get: (s) => !!s.general.login?.on, set: (on) => ['login', on],
          }),
          info({
            id: 'default-browser', label: 'Default browser',
            help: 'The default browser opens links from other apps.',
            value: (s) => (!s.general.defaultBrowser.can ? 'Only an installed copy of Loui (the Windows installer or the Debian package) can be made the default browser.'
              : s.general.defaultBrowser.isDefault ? 'Loui is your default browser.' : 'Loui is not your default browser.'),
            buttons: [{
              id: 'default-browser', label: 'Make Loui the default browser', act: ['default-browser'],
              shown: (s) => s.general.defaultBrowser.can && !s.general.defaultBrowser.isDefault,
            }],
          }),
        ],
      },
      {
        title: 'Downloads', rows: [
          info({
            id: 'downloads-folder', label: 'Downloads folder',
            help: 'Where the files you download are saved.',
            value: (s) => s.general.downloads.folder,
            buttons: [{ id: 'downloads-folder', label: 'Change…', act: ['downloads:folder'] }],
          }),
          toggle({
            id: 'downloads-ask', label: 'Ask where to save each file',
            help: 'Shows a Save As dialog for each download. Downloads Claude starts are saved without asking.',
            get: (s) => s.general.downloads.ask, set: (on) => ['downloads:ask', on],
          }),
        ],
      },
    ],
  },
  {
    id: 'start', title: 'Start page', groups: [
      {
        title: 'New tabs', rows: [
          choice({
            id: 'new-tab', label: 'New tabs open with',
            help: 'What a new tab or a new window shows: Loui\'s start page, a blank page, or an address of your choice.',
            options: () => [['start', 'The start page'], ['blank', 'A blank page'], ['address', 'This address']],
            get: (s) => s.general.start.choice,
            set: (v) => {
              if (v === 'address') setTimeout(() => document.getElementById('set-new-tab-address').focus());
              return ['new-tab', { choice: v }];
            },
          }),
          entry({
            id: 'new-tab-address', label: 'New tab address',
            help: 'The page a new tab opens. Until one is given, new tabs open the start page.',
            placeholder: 'https://example.com',
            shown: (s) => s.general.start.choice === 'address',
            wrong: (v) => (v && !/\s/.test(v) ? null : 'Enter the address of a page.'),
            refused: 'That is not an address Loui can open.',
            get: (s) => s.general.start.address,
            set: (v) => ['new-tab', { address: v }],
          }),
        ],
      },
      {
        title: 'Most visited', rows: [
          toggle({
            id: 'start-tiles', label: 'Show the sites you visit most',
            help: 'Up to eight sites you have been to more than once, on the start page. Your search engine is left out. Never shown in a private window.',
            get: (s) => s.general.start.tiles, set: (on) => ['start:part', { part: 'startTiles', on }],
          }),
          info({
            id: 'start-hidden', label: 'Sites taken off the start page',
            help: 'A site you removed from Most visited stays off it until you bring them back.',
            shown: (s) => s.general.start.hidden > 0,
            value: (s) => (s.general.start.hidden === 1 ? '1 site' : `${s.general.start.hidden} sites`),
            buttons: [{ id: 'start-unhide', label: 'Show them again', act: ['start:unhide'] }],
          }),
        ],
      },
      {
        title: 'Weather', rows: [
          toggle({
            id: 'start-weather', label: 'Show the weather',
            help: 'The temperature and today\'s high and low for your place, from Open-Meteo. Loui fetches it, at most every half hour.',
            get: (s) => s.general.start.weather, set: (on) => ['start:part', { part: 'startWeather', on }],
          }),
          place({
            id: 'weather-place', label: 'Your place',
            help: 'A town or city, for the weather. Loui looks it up once; it never asks where this computer is.',
            placeholder: 'Type a town or city',
            shown: (s) => s.general.start.weather,
            refused: 'No place by that name was found.',
            get: (s) => s.general.start.place,
            set: (v) => ['start:place', v],
            // Names such as Córdoba or San Juan are places in several countries.
            found: (s) => s.general.start.resolved,
            others: (s) => s.general.start.others,
            ask: ['start:place-others'],
            choose: (o) => ['start:place-choose', { lat: o.lat, lon: o.lon }],
          }),
          choice({
            id: 'weather-units', label: 'Temperature in',
            help: 'Degrees Celsius or Fahrenheit. Until you choose, Loui goes by this computer\'s region.',
            shown: (s) => s.general.start.weather,
            options: () => [['c', 'Celsius'], ['f', 'Fahrenheit']],
            get: (s) => s.general.start.units, set: (v) => ['start:units', v],
          }),
        ],
      },
      {
        title: 'News', rows: [
          toggle({
            id: 'start-news', label: 'Show news headlines',
            help: 'A few headlines from the feeds below. Loui fetches them, at most every quarter of an hour.',
            get: (s) => s.general.start.news, set: (on) => ['start:part', { part: 'startNews', on }],
          }),
          list({
            id: 'news-feeds', label: 'News feeds',
            help: 'RSS or Atom feeds the headlines come from.',
            shown: (s) => s.general.start.news,
            empty: 'None: no headlines are shown.',
            items: (s) => s.general.start.feeds.map((url) => ({
              text: url, button: 'Remove', aria: `Remove the feed ${url}`, act: ['start:feed-remove', url],
            })),
            // Loui reads the address once before listing it: one with no headlines is not kept.
            add: {
              placeholder: 'https://example.com/feed.xml', aria: 'Feed address', act: (v) => ['start:feed-add', v],
              busy: 'Checking…', refused: (s) => s?.general.start.feedTrouble || 'No headlines found at that address.',
            },
          }),
          offers({
            id: 'news-known', label: 'Well-known feeds',
            help: 'General news in English and Spanish, to add with one press.',
            shown: (s) => s.general.start.news && s.general.start.known.length > 0,
            items: (s) => s.general.start.known.map((k) => ({ label: k.name, aria: `Add the feed of ${k.name}`, act: ['start:feed-add', k.url] })),
            busy: 'Checking…', refused: (s) => s.general.start.feedTrouble,
          }),
        ],
      },
    ],
  },
  {
    id: 'tabs', title: 'Tabs', groups: [
      {
        title: 'Layout', rows: [
          toggle({
            id: 'vertical-tabs', label: 'Vertical tabs', seen: true,
            help: 'Shows tabs in a sidebar on the left instead of a strip along the top.',
            get: (s) => s.tabs.vertical, set: (on) => ['tabs:vertical', on],
          }),
          toggle({
            id: 'bookmarks-bar', label: 'Show bookmarks bar', seen: true,
            help: 'Keeps your bookmarks in a row under the address bar.',
            get: (s) => s.tabs.bookmarksBar, set: (on) => ['bookmarks:bar', on],
          }),
        ],
      },
      {
        title: 'Sleeping tabs', rows: [
          choice({
            id: 'sleep-minutes', label: 'Put tabs to sleep after',
            help: 'A tab left in the background this long is unloaded to free memory, and loads again when you return to it. ' +
              'Pinned tabs, tabs playing sound and Claude\'s tabs stay awake.',
            options: (s) => withCurrent([[5, minutes(5)], [15, minutes(15)], [30, minutes(30)], [60, minutes(60)], [120, minutes(120)], [0, 'Never']],
              s.tabs.sleep.minutes, minutes),
            get: (s) => s.tabs.sleep.minutes, set: (v) => ['sleep:minutes', Number(v)],
          }),
          list({
            id: 'keep-awake', label: 'Sites that are never put to sleep',
            help: 'Tabs on these sites stay loaded however long they are in the background.',
            empty: 'None.',
            items: (s) => s.tabs.sleep.keepAwake.map((host) => ({
              text: host, button: 'Remove', aria: `Let tabs on ${host} sleep`, act: ['sleep:unkeep', host],
            })),
            add: { placeholder: 'example.com', aria: 'Site to keep awake', act: (v) => ['sleep:keep', v] },
          }),
        ],
      },
    ],
  },
  {
    id: 'search', title: 'Search', groups: [
      {
        title: 'Address bar', rows: [
          choice({
            id: 'search-engine', label: 'Search engine',
            help: 'Where the words you type in the address bar are searched for.',
            options: (s) => [...s.search.engines.map((e) => [e.id, e.label]), ['custom', 'Custom address']],
            get: (s) => (customSearch ? 'custom' : s.search.engine),
            set: (v) => {
              customSearch = v === 'custom' && !validSearch(state.search.custom);
              if (customSearch) setTimeout(() => document.getElementById('set-search-url').focus());
              return customSearch ? null : ['search', v === 'custom' ? { engine: 'custom', url: state.search.custom } : { engine: v }];
            },
          }),
          entry({
            id: 'search-url', label: 'Search address',
            help: 'The address of a search page, with %s where the words go.',
            placeholder: 'https://example.com/search?q=%s',
            shown: (s) => customSearch || s.search.engine === 'custom',
            wrong: (v) => (validSearch(v) ? null : 'Use an http or https address with %s in it.'),
            get: (s) => s.search.custom,
            set: (v) => { customSearch = false; return ['search', { engine: 'custom', url: v }]; },
          }),
        ],
      },
    ],
  },
  {
    id: 'privacy', title: 'Privacy and security', groups: [
      {
        title: 'Shields', rows: [
          list({
            id: 'shields-off', label: 'Sites with Shields off',
            help: 'Shields blocks ads and trackers on every site but these. Turn it off for a site from the shield in the toolbar.',
            empty: 'None. Shields is on everywhere.',
            items: (s) => s.privacy.shields.off.map((site) => ({
              text: site, button: 'Remove', aria: `Turn Shields back on for ${site}`, act: ['shields:allow', site],
            })),
          }),
          info({
            id: 'shields-lists', label: 'Filter lists',
            help: 'The lists of ads and trackers that Shields blocks. Loui downloads them again every few days.',
            value: (s) => listsWords(s.privacy.shields),
            buttons: [{
              id: 'shields-update', label: 'Update now', act: ['shields:update'],
              disabled: (s) => !s.privacy.shields.can || s.privacy.shields.updating,
            }],
          }),
        ],
      },
      {
        title: 'Sites', rows: [
          info({
            id: 'popups', label: 'Pop-ups',
            help: 'A page may open a new tab only right after you click or type in it. Anything else is blocked; there is nothing to set.',
          }),
          list({
            id: 'site-permissions', label: 'Site permissions',
            help: 'Camera, microphone, location and notification choices you asked Loui to remember. ' +
              'Tabs in a Claude session\'s group are always refused, whatever is here.',
            empty: 'No remembered choices yet.',
            items: (s) => s.privacy.permissions.map((p) => ({
              text: p.site, detail: `${p.name}: ${p.allowed ? 'allowed' : 'blocked'}`,
              button: 'Forget', aria: `Forget ${p.name} for ${p.site}`, act: ['permission:forget', { origin: p.origin, kind: p.kind }],
            })),
          }),
          list({
            id: 'elsewhere', label: 'Sites that open in your other browser',
            help: 'For sites that refuse to work in Loui. Loui sends them to your other browser instead of opening them; Claude\'s tabs never open them.',
            empty: 'None. Every site opens in Loui.',
            items: (s) => s.privacy.elsewhere.sites.map((site) => ({
              text: site, button: 'Remove', aria: `Open ${site} in Loui`, act: ['elsewhere:remove', site],
            })),
            add: { placeholder: 'example.com', aria: 'Site to send to your other browser', act: (v) => ['elsewhere:add', v] },
          }),
        ],
      },
      {
        title: 'Browsing data', rows: [
          clearData({
            id: 'clear-data', label: 'Clear browsing data',
            help: 'Clears what your own windows kept; a private window clears itself when it closes. Open tabs stay open. ' +
              'Saved passwords, bookmarks, settings, what Claude sessions did and your Claude sign-in are not touched. ' +
              'Cookies, site data and cached files carry no dates Loui can go by, so they are always cleared for all time.',
          }),
        ],
      },
      {
        title: 'Private windows', rows: [
          info({
            id: 'private', label: 'Private windows',
            help: 'A private window keeps no history, cookies, cache or record of what Claude did once the last one closes. ' +
              'Bookmarks you add and files you download there stay.',
          }),
        ],
      },
    ],
  },
  {
    id: 'passwords', title: 'Passwords', groups: [
      {
        title: 'Saving', rows: [
          toggle({
            id: 'passwords-offer', label: 'Offer to save passwords',
            help: 'Asks above the page after you sign in somewhere new, or with a changed password. When off, saved passwords can still be filled.',
            get: (s) => s.passwords.offer, set: (on) => ['passwords:offer', on],
          }),
          info({
            id: 'passwords-encryption', label: 'Encryption',
            help: 'Passwords are only ever saved encrypted, with a key this system keeps for you.',
            value: (s) => (s.passwords.available ? 'Available.' : `Not available, so no passwords are saved. ${s.passwords.why}${s.passwords.plain ? ' ' + s.passwords.plain : ''}`),
          }),
          list({
            id: 'passwords-never', label: 'Sites whose passwords are never saved',
            help: 'Loui does not offer to save passwords on these sites.',
            empty: 'None. Choose "Never for this site" when Loui offers.',
            items: (s) => s.passwords.never.map((n) => ({
              text: n.site, button: 'Remove', aria: `Offer to save passwords on ${n.site} again`, act: ['passwords:unnever', n.origin],
            })),
          }),
        ],
      },
      {
        title: 'Saved passwords', rows: [
          info({
            id: 'passwords-open', label: 'Saved passwords',
            help: 'See, change and delete them in the Passwords panel of the main window.',
            value: (s) => (s.passwords.saved === 1 ? '1 password saved.' : `${s.passwords.saved} passwords saved.`),
            buttons: [{ id: 'passwords-open', label: 'Open passwords', act: ['passwords:open'] }],
          }),
          info({
            id: 'passwords-import', label: 'Import passwords',
            help: 'Reads the CSV file that Brave, Chrome and other browsers export.',
            buttons: [{ id: 'passwords-import', label: 'Import from CSV…', act: ['passwords:import'], disabled: (s) => !s.passwords.available }],
          }),
        ],
      },
    ],
  },
  {
    id: 'claude', title: 'Claude', groups: [
      {
        title: 'The Claude panel', rows: [
          info({
            id: 'claude-account', label: 'Claude account',
            help: 'The Claude panel uses your Claude subscription through Claude Code\'s own sign-in. No API key is involved, and Loui keeps nothing of the account. ' +
              'Signing out signs Claude Code out on this computer, wherever else you use it too.',
            value: (s) => accountWords(s.claude.account),
            buttons: [
              {
                id: 'claude-sign-in', label: 'Sign in', act: ['claude:sign-in'],
                shown: (s) => s.claude.account.state === 'signed-out' && !s.claude.account.signIn,
              },
              { id: 'claude-check', label: 'Check again', act: ['claude:check'], disabled: (s) => !!s.claude.account.signIn },
              {
                id: 'claude-sign-out', label: 'Sign out', act: ['claude:sign-out'], ask: ['Sign out of Claude?', () => true],
                shown: (s) => s.claude.account.state === 'ready' && s.claude.account.kind !== 'cloud' && !s.claude.account.signIn,
              },
            ],
          }),
          choice({
            id: 'claude-model', label: 'Model',
            help: 'Which Claude model answers in the panel, from your next message. Default is the one Loui usually asks for.',
            options: (s) => [['', 'Default'], ...s.claude.models.map((m) => [m, m[0].toUpperCase() + m.slice(1)])],
            get: (s) => s.claude.model, set: (v) => ['claude:model', v],
          }),
        ],
      },
      {
        title: 'Other Claude sessions', rows: [
          toggle({
            id: 'relay-on', label: 'Let other Claude sessions use this browser',
            help: 'Claude Desktop, Claude Code and the Claude apps reach Loui through your relay. Each session works in a tab group of its own.',
            get: (s) => s.claude.relay.on, set: (on) => ['relay', { on }],
          }),
          entry({
            id: 'relay-url', label: 'Relay address',
            help: 'Where your relay is, for example http://127.0.0.1:7332.',
            placeholder: 'http://127.0.0.1:7332',
            get: (s) => s.claude.relay.url, set: (v) => ['relay', { url: v }],
          }),
          relayKey({
            id: 'relay-key', label: 'Relay key',
            help: 'The secret this browser signs in to the relay with. It is never shown here.',
          }),
          info({
            id: 'relay-status', label: 'Connection',
            help: 'How the relay and this browser stand.',
            value: (s) => relayWords(s.claude.relay),
          }),
          entry({
            id: 'relay-device', label: 'This browser\'s name on the relay',
            help: 'What to call this browser when you tell Claude where to work ("on FPMoss"). Empty goes back to this computer\'s name.',
            get: (s) => s.claude.relay.device, set: (v) => ['relay:name', v],
            kept: (v) => v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '').trim().slice(0, 64) || state.claude.relay.hostName, // as link.js keeps it
          }),
          list({
            id: 'connectors', label: 'Let in without asking',
            help: 'The first time a new Claude session uses Loui, Loui asks you. Sessions from these are let in straight away.',
            empty: 'None. Every new session asks first.',
            items: (s) => s.claude.connectors.map((c) => ({
              text: c.kind === 'key' ? 'Apps signed in with the relay key' : `${c.name} (connector)`,
              button: 'Revoke', aria: `Ask again before new sessions from ${c.kind === 'key' ? 'the relay key' : c.name} use Loui`,
              act: ['consent:revoke', c.id],
            })),
          }),
        ],
      },
      {
        title: 'Guardrails', rows: [
          toggle({
            id: 'guard-on', label: 'Ask before Claude pays, buys, sends, deletes or signs in',
            help: 'Loui pauses Claude and asks you above the page first. This covers every Claude session and the Claude panel, never what you do yourself.',
            get: (s) => s.claude.guardrails.on, set: (on) => ['guard:set', on],
          }),
          list({
            id: 'guard-sites', label: 'Sites Claude asks before opening',
            help: 'Claude must ask you before it opens any page on these sites.',
            empty: 'None.',
            items: (s) => s.claude.guardrails.sites.map((site) => ({
              text: site, button: 'Remove', aria: `Stop asking before opening ${site}`, act: ['guard:site-remove', site],
            })),
            add: { placeholder: 'mybank.com', aria: 'Site Claude should ask before opening', act: (v) => ['guard:site-add', v] },
          }),
          list({
            id: 'guard-always', label: 'Allowed without asking',
            help: 'What you chose "Always on this site" for when Loui asked.',
            empty: 'Nothing yet.',
            items: (s) => s.claude.guardrails.always.map((a) => ({
              text: a.site, detail: a.name, button: 'Forget', aria: `Ask again about ${a.name.toLowerCase()} on ${a.site}`,
              act: ['guard:forget', { origin: a.origin, kind: a.kind }],
            })),
          }),
          list({
            id: 'guard-trusted', label: 'Sessions trusted until they end',
            help: 'Sessions you told Loui to stop asking about. The trust goes when the session ends.',
            empty: 'None.',
            items: (s) => s.claude.guardrails.trusted.map((t) => ({
              text: t.label, button: 'Stop trusting', aria: `Ask again before ${t.label} acts`, act: ['guard:untrust', t.id],
            })),
          }),
        ],
      },
      {
        title: 'Session log', rows: [
          choice({
            id: 'activity-days', label: 'Keep what Claude sessions did for',
            help: 'Each session\'s steps and pictures, under Claude › Claude sessions. Only you can see them; Claude cannot read them.',
            options: (s) => withCurrent([[1, days(1)], [7, days(7)], [30, days(30)], [0, 'Don\'t keep']], s.claude.activity.days, days),
            get: (s) => s.claude.activity.days, set: (v) => ['activity:keep', Number(v)],
          }),
          entry({
            id: 'activity-max', label: 'Most disk space for the log',
            help: 'When the log grows past this, the oldest sessions go first.',
            unit: 'MB', min: 1,
            wrong: (v) => (/^\d+$/.test(v) && Number(v) >= 1 ? null : 'Use a whole number of megabytes, 1 or more.'),
            get: (s) => String(Math.round(s.claude.activity.maxMB)), set: (v) => ['activity:max', Number(v)],
            kept: (v) => String(Number(v)),
          }),
          info({
            id: 'activity-clear', label: 'Clear the log',
            help: 'Deletes what every Claude session did, with its pictures. This can\'t be undone.',
            buttons: [{ id: 'activity-clear', label: 'Clear all', act: ['activity:clear'], ask: ['Clear everything?', () => true], done: 'Cleared' }],
          }),
        ],
      },
      {
        title: 'Local control', rows: [
          toggle({
            id: 'local-socket', label: 'Local control socket',
            help: 'Lets programs on this computer that run as you drive Loui directly. Sessions that come through it are not asked about first. ' +
              'Takes effect the next time Loui starts.',
            get: (s) => s.claude.socket, set: (on) => ['socket', on],
          }),
        ],
      },
      {
        title: 'Voice', rows: [
          toggle({
            id: 'voice-readback', label: 'Read replies aloud',
            help: 'Claude\'s replies in the panel are spoken as they arrive, with one of this computer\'s voices. The speaker in the panel does the same.',
            get: (s) => s.claude.voice.readBack, set: (on) => ['voice:read-back', on],
          }),
          choice({
            id: 'voice-voice', label: 'Voice',
            help: 'The voices this computer has. More can be added in the system\'s own speech settings.',
            options: (s) => withCurrent([['', 'The system\'s choice'], ...(s.claude.voice.voices || []).map((v) => [v.name, v.lang ? `${v.name} (${v.lang})` : v.name])],
              s.claude.voice.voice, (name) => name),
            get: (s) => s.claude.voice.voice, set: (v) => ['voice:voice', v],
          }),
          choice({
            id: 'voice-rate', label: 'Speed',
            help: 'How fast replies are read.',
            options: (s) => withCurrent(s.claude.voice.rates.map((r) => [r, speed(r)]), s.claude.voice.rate, speed),
            get: (s) => s.claude.voice.rate, set: (v) => ['voice:rate', Number(v)],
          }),
          info({
            id: 'voice-sample', label: 'Hear it',
            help: 'Says a sentence in the chosen voice, at the chosen speed, through the main window.',
            buttons: [{ id: 'voice-sample', label: 'Play sample', act: ['voice:sample'] }],
          }),
          toggle({
            id: 'voice-dictation', label: 'Dictation',
            help: 'A microphone beside Send in the Claude panel: what you say is written into the message box, never sent by itself. ' +
              'The sound is turned into text on this computer and goes nowhere else.',
            get: (s) => s.claude.voice.dictation, set: (on) => ['voice:dictation', on],
          }),
          ticks({
            id: 'voice-languages', label: 'Languages you dictate in',
            help: 'With more than one ticked, Loui works out which of them you are speaking each time.',
            shown: (s) => s.claude.voice.dictation,
            items: (s) => s.claude.voice.languages.map((l) => ({ value: l.code, label: l.name, on: l.on })),
            set: (code, on) => ['voice:language', { code, on }],
            refused: 'One language has to stay ticked.',
          }),
          info({
            id: 'voice-model', label: 'Speech model',
            help: 'What turns speech into text. It is fetched once and runs on this computer.',
            shown: (s) => s.claude.voice.dictation,
            value: (s) => ({
              ready: `Downloaded, ${s.claude.voice.mb} MB.`,
              downloading: `Downloading: ${s.claude.voice.percent}%`,
            }[s.claude.voice.model] || `Not downloaded. It downloads (${s.claude.voice.mb} MB) the first time you press the microphone, after asking.`),
            buttons: [{
              id: 'voice-model-remove', label: 'Remove', act: ['voice:model-remove'],
              shown: (s) => s.claude.voice.model === 'ready', ask: ['Remove the model?', () => true], done: 'Removed',
            }],
          }),
          info({
            id: 'voice-shortcut', label: 'Push to talk',
            help: 'Hold these keys in the Claude panel while you talk; let go and what you said is written down.',
            value: (s) => s.claude.voice.shortcut,
          }),
        ],
      },
    ],
  },
  {
    id: 'reading', title: 'Reading', groups: [
      {
        title: 'Reader view', rows: [
          choice({
            id: 'reader-size', label: 'Text size',
            help: 'How large reader view sets an article\'s text.',
            options: (s) => s.reading.sizes.map((px, i) => [i, `${px} px`]),
            get: (s) => s.reading.size, set: (v) => ['reader', { key: 'size', value: v }],
          }),
          choice({
            id: 'reader-face', label: 'Font',
            help: 'The typeface of articles in reader view.',
            options: (s) => s.reading.faces.map((f) => [f, f === 'sans' ? 'Sans serif' : f === 'serif' ? 'Serif' : f]),
            get: (s) => s.reading.face, set: (v) => ['reader', { key: 'face', value: v }],
          }),
          choice({
            id: 'reader-width', label: 'Line width',
            help: 'How wide the column of text is.',
            options: (s) => s.reading.widths.map((w) => [w, w[0].toUpperCase() + w.slice(1)]),
            get: (s) => s.reading.width, set: (v) => ['reader', { key: 'width', value: v }],
          }),
          info({
            id: 'reader-theme', label: 'Colours',
            help: 'Reader view is dark or light as Loui is: change it with Appearance, under General.',
          }),
        ],
      },
    ],
  },
  {
    id: 'about', title: 'About', groups: [
      {
        title: 'Loui', rows: [
          info({
            id: 'version', label: 'Version',
            help: 'This copy of Loui, and the Electron and Chromium it is built on.',
            value: (s) => `Loui ${s.about.version} · Electron ${s.about.electron} · Chromium ${s.about.chromium}`,
          }),
          info({
            id: 'updates', label: 'Updates',
            // On Linux nothing is installed as Loui quits: installing takes an administrator's password.
            help: navigator.platform.startsWith('Linux')
              ? 'New versions download in the background. One is installed when you press “Restart to update”, which asks for an administrator’s password.'
              : 'New versions download in the background and install when Loui next starts.',
            value: (s) => updateWords(s.about.update),
            buttons: [
              {
                id: 'update-check', label: 'Check for updates now', act: ['update:check'],
                shown: (s) => !['ready', 'installing', 'installed'].includes(s.about.update?.status),
                disabled: (s) => !s.about.update || ['checking', 'downloading'].includes(s.about.update.status),
              },
              {
                // Restarting closes sessions' tab groups, so it asks first while one is working, as the toolbar's button does.
                id: 'update-install', label: 'Restart to update', act: ['update:install'],
                shown: (s) => (s.about.update?.status === 'ready' && !s.about.update.manual) || s.about.update?.status === 'installed',
                ask: ['A session is working. Restart anyway?', (s) => s.about.working > 0],
              },
              {
                // Linux, after the password prompt was dismissed: asks for it again, then installs and restarts.
                id: 'update-retry', label: 'Try again', act: ['update:install'],
                shown: (s) => s.about.update?.status === 'ready' && !!s.about.update.manual && !!s.about.update.again,
                ask: ['A session is working. Restart anyway?', (s) => s.about.working > 0],
              },
              {
                id: 'update-copy', label: 'Copy the command', act: ['update:copy'], done: 'Copied',
                shown: (s) => s.about.update?.status === 'ready' && !!s.about.update.manual,
              },
            ],
          }),
          info({
            id: 'releases', label: 'Release notes',
            help: 'What changed in each version, on the releases page. Opens in a tab.',
            buttons: [{ id: 'releases', label: 'Open the releases page', act: ['releases'] }],
          }),
          info({
            id: 'profile', label: 'Profile folder',
            help: 'Where Loui keeps your settings, history, bookmarks and sign-ins.',
            value: (s) => s.about.profile,
            buttons: [{ id: 'profile-open', label: 'Open folder', act: ['profile:open'] }],
          }),
        ],
      },
    ],
  },
];

// ── drawing ─────────────────────────────────────────────────────────────────
const tabs = new Map(); // section id -> its button at the left
for (const section of SECTIONS) {
  const tab = el('button', 'st-section-tab', section.title);
  tab.type = 'button';
  tab.id = `tab-${section.id}`;
  tab.setAttribute('role', 'tab');
  tab.setAttribute('aria-controls', `section-${section.id}`);
  tab.onclick = () => show(section.id);
  tablist.append(tab);
  tabs.set(section.id, tab);

  const page = el('section', 'st-section');
  page.id = `section-${section.id}`;
  page.setAttribute('role', 'tabpanel');
  page.setAttribute('aria-labelledby', tab.id);
  page.append(el('h2', '', section.title));
  for (const group of section.groups) {
    const box = el('div', 'st-group');
    const card = el('div', 'st-card');
    box.append(el('h3', '', group.title), card);
    for (const row of group.rows) {
      card.append(row.node);
      rows.push({ ...row, section: section.id, group: box, words: `${row.label} ${row.help}`.toLowerCase() });
    }
    page.append(box);
  }
  section.page = page;
  main.insertBefore(page, document.getElementById('st-none'));
}

// Which rows, groups and sections show: the chosen section, or, while the
// search box holds words, every setting whose label or description has them all.
function arrange() {
  const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
  const finding = words.length > 0;
  const found = new Set();
  for (const row of rows) {
    const there = !row.shown || !state || row.shown(state);
    const match = there && (!finding || words.every((w) => row.words.includes(w)));
    row.node.hidden = !match;
    if (match) found.add(row.section);
  }
  for (const row of rows) row.group.hidden = ![...row.group.querySelectorAll('.st-row')].some((n) => !n.hidden);
  for (const section of SECTIONS) {
    const tab = tabs.get(section.id);
    section.page.hidden = finding ? !found.has(section.id) : section.id !== current;
    tab.setAttribute('aria-selected', String(!finding && section.id === current));
    tab.tabIndex = section.id === current ? 0 : -1;
    tab.classList.toggle('st-no-match', finding && !found.has(section.id));
  }
  const none = document.getElementById('st-none');
  none.hidden = !finding || found.size > 0;
  none.textContent = `No setting matches “${search.value.trim()}”.`;
}

function draw(next) {
  state = next;
  for (const row of rows) row.update(next);
  arrange();
}

// Choosing a section ends a search.
function show(id) {
  if (!tabs.has(id)) return;
  current = id;
  search.value = '';
  arrange();
  main.scrollTop = 0;
}

search.oninput = () => { arrange(); main.scrollTop = 0; };

// Up and Down (Home, End) move along the sections, as in any list of tabs.
tablist.addEventListener('keydown', (e) => {
  const ids = SECTIONS.map((s) => s.id);
  const at = ids.indexOf(current);
  const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: ids.length - 1 }[e.key];
  if (to === undefined) return;
  e.preventDefault();
  show(ids[Math.max(0, Math.min(ids.length - 1, to))]);
  tabs.get(current).focus();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    // Esc first empties the search box, then closes the window.
    if (search.value) { search.value = ''; arrange(); search.focus(); } else loui.close();
  } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'w') {
    e.preventDefault();
    loui.close();
  } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    search.select();
  }
});

loui.onState(draw);
// A section, or "section/Group title" for one of its groups.
loui.onShow((to) => {
  const [id, group] = String(to).split('/');
  show(id);
  tabs.get(id)?.focus();
  if (group) [...document.querySelectorAll(`#section-${id} h3`)].find((h) => h.textContent === group)?.scrollIntoView();
});
arrange();
search.focus();

// For the tests: what each section lists, and what is on show now.
const describe = (only) => SECTIONS.map((s) => ({
  id: s.id, title: s.title,
  settings: rows.filter((r) => r.section === s.id && (!only || (!r.node.hidden && !s.page.hidden))).map((r) => r.label),
})).filter((s) => !only || s.settings.length);
window.sectionsForTest = () => describe(false);
window.shownForTest = () => describe(true);
window.searchForTest = (text) => { search.value = text; search.oninput(); return describe(true); };
window.showSectionForTest = (id) => { show(id); return current; };
window.actForTest = (what, arg) => send(what, arg).then(() => 'ok');
