// Claude sessions let in without asking, listed in File › Settings with a way
// to revoke each (src/main/consent.js). The question itself is drawn in the
// helm by ui.js. Uses $ and el from ui.js; names come from the relay and are
// set as text.
function drawConsent(list) {
  $('consent-list').replaceChildren(...list.map((c) => {
    const row = el('li');
    const name = c.kind === 'key' ? 'Apps signed in with the relay key' : `${c.name} (connector)`;
    const revoke = el('button', 'quiet', 'Revoke');
    revoke.type = 'button';
    revoke.setAttribute('aria-label', `Ask again before new sessions from ${c.kind === 'key' ? 'the relay key' : c.name} use Loui`);
    revoke.onclick = () => loui.send('consent:revoke', c.id);
    row.append(el('span', 'site', name), revoke);
    return row;
  }));
  if (!list.length) $('consent-list').append(el('li', 'none', 'None. Every new session asks first.'));
}

loui.on('state', (next) => drawConsent(next.allowedConnectors || []));
