// Guardrails in the window chrome (see src/main/guardrails.js): the strip that
// asks before Claude pays, sends or deletes, and its part of the Settings
// sheet. Uses $ and el from ui.js. The session's and site's names are set as
// text; the control's name in "what" comes from the page and is quoted as such.
let guardId = null;
let guardKey = null;
const GUARD_ANSWERS = ['guard-once', 'guard-always', 'guard-block'];

function drawGuard(g) {
  $('guard-ask').hidden = !g;
  if (!g) { guardId = guardKey = null; return; }
  $('guard-show').hidden = g.onScreen;
  // The same question drawn again, unless it has moved to or from another window.
  const key = `${g.id} ${g.elsewhere || ''}`;
  if (key === guardKey) return;
  const again = g.id === guardId;
  guardKey = key;
  guardId = g.id;
  const text = $('guard-text');
  text.replaceChildren(el('strong', '', g.who), ` wants to ${g.what}`);
  if (g.kind !== 'site') text.append(' on ', el('strong', '', g.site));
  // Asked in the window the user is in, about a tab in another one.
  if (g.elsewhere) text.append(el('span', 'more', `. Its tab is in another window (${g.elsewhere}).`));
  if (g.more) text.append(el('span', 'more', ` (${g.more} more waiting)`));
  $('guard-shot').hidden = !g.image;
  if (g.image) $('guard-shot').src = g.image;
  else $('guard-shot').removeAttribute('src');
  $('guard-always').hidden = !g.canAlways;
  if (again) return; // already answerable, and the tick stays as the user left it
  $('guard-trust').checked = false;
  // As with site permissions: a new question takes a moment to become
  // answerable, so a click meant for something else cannot answer it.
  for (const id of GUARD_ANSWERS) $(id).disabled = true;
  setTimeout(() => {
    if (guardId === g.id) for (const id of GUARD_ANSWERS) $(id).disabled = false;
  }, 600);
}

const answerGuard = (choice) => {
  if (guardId == null) return;
  loui.send('guard:answer', { id: guardId, choice, trust: $('guard-trust').checked });
};
$('guard-once').onclick = () => answerGuard('once');
$('guard-always').onclick = () => answerGuard('always');
$('guard-block').onclick = () => answerGuard('block');
$('guard-show').onclick = () => guardId != null && loui.send('guard:show', guardId);

// A list in the Settings sheet: one row per item, with a button that undoes it.
function guardRows(list, empty, row) {
  return list.length ? list.map((item) => {
    const [label, button, aria, send] = row(item);
    const li = el('li');
    const undo = el('button', 'quiet', button);
    undo.type = 'button';
    undo.setAttribute('aria-label', aria);
    undo.onclick = send;
    li.append(...label, undo);
    return li;
  }) : [el('li', 'none', empty)];
}

function drawGuardSettings(s) {
  $('guard-on').checked = s.on;
  $('guard-sites').replaceChildren(...guardRows(s.sites, 'None.', (site) => [
    [el('span', 'site', site)], 'Remove', `Stop asking before opening ${site}`,
    () => loui.send('guard:site-remove', site),
  ]));
  $('guard-remembered').replaceChildren(...guardRows(s.always, 'Nothing yet. Choose Always on this site when Loui asks.', (a) => [
    [el('span', 'site', a.site), el('span', 'kind', a.name)], 'Forget', `Ask again about ${a.name.toLowerCase()} on ${a.site}`,
    () => loui.send('guard:forget', { origin: a.origin, kind: a.kind }),
  ]));
  $('guard-trusted-title').hidden = $('guard-trusted').hidden = !s.trusted.length;
  $('guard-trusted').replaceChildren(...guardRows(s.trusted, '', (t) => [
    [el('span', 'site', t.label)], 'Stop trusting', `Ask again before ${t.label} acts`,
    () => loui.send('guard:untrust', t.id),
  ]));
}

$('guard-on').onchange = () => loui.send('guard:set', { on: $('guard-on').checked });
$('guard-site-add').onsubmit = (e) => {
  e.preventDefault();
  loui.send('guard:site-add', $('guard-site').value);
  $('guard-site').value = '';
};

loui.on('state', (next) => {
  drawGuard(next.guard);
  if (next.guardrails) drawGuardSettings(next.guardrails);
});
