// Guardrails in the window chrome (see src/main/guardrails.js): the strip that
// asks before Claude pays, sends or deletes (its settings are in the Settings
// window). Uses $ and el from ui.js. The session's and site's names are set as
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

loui.on('state', (next) => drawGuard(next.guard));
