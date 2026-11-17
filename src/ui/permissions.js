// Site permissions in the window chrome: the question a site in the tab on
// screen is asking (a strip above the page), and the remembered answers (a
// panel in the Claude panel's place, opened from View › Site permissions).
// Uses $, el, focusPage and sidePanel from ui.js. The site is named by its origin, set as text; no
// text from the page itself is shown.
let askingId = null;

function drawPermission(p) {
  $('perm-ask').hidden = !p;
  if (!p) { askingId = null; return; }
  if (p.id === askingId) return;
  askingId = p.id;
  const text = $('perm-text');
  text.replaceChildren(el('strong', '', p.site), ` wants to ${p.wants}`);
  if (p.within) text.append(el('span', 'within', ` (in a frame on ${p.within})`));
  $('perm-keep').checked = false;
  $('perm-keep-label').hidden = !p.canRemember;
  // A new question takes a moment to become answerable, so that a click meant
  // for the page as the strip appears cannot answer it.
  for (const b of [$('perm-allow'), $('perm-block')]) b.disabled = true;
  setTimeout(() => {
    if (askingId === p.id) for (const b of [$('perm-allow'), $('perm-block')]) b.disabled = false;
  }, 600);
}

const answerPermission = (allow) => {
  if (askingId == null) return;
  loui.send('permission:answer', { id: askingId, allow, remember: $('perm-keep').checked });
  focusPage(); // the strip goes: the page has the keyboard again
};
$('perm-allow').onclick = () => answerPermission(true);
$('perm-block').onclick = () => answerPermission(false);

function drawSitePermissions(list) {
  $('perms-none').hidden = list.length > 0;
  $('perms-list').replaceChildren(...list.map((s) => {
    const row = el('li');
    const forget = el('button', 'quiet', 'Forget');
    forget.type = 'button';
    forget.setAttribute('aria-label', `Forget ${s.name} for ${s.site}`);
    forget.onclick = () => loui.send('permission:forget', { origin: s.origin, kind: s.kind });
    row.append(el('span', 'site', s.site), el('span', 'choice', `${s.name}: ${s.allowed ? 'allowed' : 'blocked'}`), forget);
    return row;
  }));
}

const showPermissions = sidePanel('perms', $('perms'), () => $('perms-close').focus());
loui.on('show-permissions', () => showPermissions(true));

loui.on('state', (next) => {
  drawPermission(next.permission);
  drawSitePermissions(next.sitePermissions || []);
});
