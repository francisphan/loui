// Guardrails: before a Claude session pays, sends, deletes, signs in or opens
// a listed site, Loui asks the user in the window, and nothing reaches the
// page until they allow it. Ordinary browsing is not interrupted, and the
// user's own clicks never are.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { launch } = require('./drive');
const { classify, inspectBody } = require('../src/main/guardrails');

// ── the rules, without the app ────────────────────────────────────────────
test('controls are classified by name, in English and Spanish', () => {
  const button = (name) => classify({ role: 'button', name, submits: false, form: {} });
  for (const name of ['Pay $45.00', 'Buy now', 'Place order', 'Purchase', 'Checkout', 'Transfer', 'Pagar', 'Comprar', 'Finalizar compra', 'Transferir', 'Confirmar pago']) {
    assert.equal(button(name)?.kind, 'pay', name);
  }
  for (const name of ['Delete', 'Remove account', 'Eliminar', 'Borrar']) assert.equal(button(name)?.kind, 'delete', name);
  for (const name of ['Send', 'Send message', 'Enviar']) assert.equal(button(name)?.kind, 'send', name);
  for (const name of ['Next', 'Search', 'Add to cart', 'Payment methods', 'Buying guide', 'Sender settings',
    'Learn how to delete your account and everything in it']) {
    assert.equal(button(name), null, name);
  }
  assert.equal(classify({ role: 'link', name: 'Buy now', form: {} }), null, 'a link leads to the page with the real button');
  assert.equal(classify({ role: 'link', name: 'Delete', form: {} })?.kind, 'delete', 'a link can delete by itself');
  assert.equal(classify({ role: 'button', name: 'Confirm', submits: false, form: {} }), null);
  assert.equal(classify({ role: 'button', name: 'Confirm', submits: true, form: {} })?.kind, 'confirm');
});

test('submitting a form is classified by the fields it holds', () => {
  const submit = (form) => classify({ role: 'button', name: 'Continue', submits: true, form });
  assert.equal(submit({ card: true })?.kind, 'pay');
  assert.equal(submit({ password: true })?.kind, 'sign-in');
  assert.equal(submit({ otp: true })?.kind, 'sign-in');
  assert.equal(submit({}), null);
  assert.equal(classify({ role: 'button', name: 'Continue', submits: false, form: { card: true } }), null);
  const link = { role: 'link', name: 'Wallet', form: {}, href: 'https://www.paypal.com/signin' };
  assert.equal(classify(link, ['paypal.com'])?.kind, 'site');
  assert.equal(classify(link, ['stripe.com']), null);
});

test('request bodies are read for card numbers, passwords and codes', () => {
  assert.equal(inspectBody('cardnumber=4242+4242+4242+4242&cvc=123'), 'pay');
  assert.equal(inspectBody('{"card":{"number":"4242424242424242"}}'), 'pay');
  assert.equal(inspectBody('------x\r\nContent-Disposition: form-data; name="cvc"\r\n\r\n123\r\n------x--'), 'pay');
  assert.equal(inspectBody('user=ada&password=hunter2'), 'sign-in');
  assert.equal(inspectBody('{"otp":"123456"}'), 'sign-in');
  assert.equal(inspectBody('id=4242424242424242&t=1763337600000'), null, 'a number that could be a card, under a name that is not');
  assert.equal(inspectBody('{"event":"click","ts":1763337600000,"page":"/checkout"}'), null);
  assert.equal(inspectBody('q=pay+now'), null);
});

// ── in the app ─────────────────────────────────────────────────────────────
let b, site;
test.before(async () => {
  b = await launch();
  site = new URL(b.base).host;
});
test.after(async () => { await b.close(); });

const ref = (outline, start) => {
  const line = outline.split('\n').find((l) => l.trim().startsWith(start));
  assert.ok(line, `no "${start}" in:\n${outline}`);
  return line.match(/\[(e\d+)\]/)[1];
};
const wait = async (what, check, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) {
    const value = await check();
    if (value) return value;
  }
  throw new Error(`timed out waiting for ${what}`);
};
const prompt = () => wait('a guardrail prompt', async () => (await b.state()).guard);
const noPrompt = async () => assert.equal((await b.state()).guard, null, 'nobody was asked');
const answer = (g, choice, trust = false) => b.ui('guard:answer', { id: g.id, choice, trust });
// The session's tab, read from outside (evaluate would itself be asked on some of these pages).
const tabOf = async (group) => (await b.state()).tabs.find((t) => t.group === group && t.current);
const read = async (group, code = "document.getElementById('out')?.textContent") =>
  b.ui('tab:js', { id: (await tabOf(group)).id, code });

test('a click on Send is paused and asked about; Allow lets it through', async () => {
  const s = b.as('g-send', 'Claude Code');
  const page = await s.text('navigate', { url: `${b.base}/guard.html` });
  const clicking = s.text('click', { ref: ref(page, 'button "Send"') });
  const g = await prompt();
  assert.equal(g.who, 'Claude Code');
  assert.equal(g.site, site);
  assert.equal(g.what, 'click "Send"');
  assert.match(g.image, /^data:image\//, 'a picture of the button');
  assert.equal(await read('g-send'), 'nothing yet', 'nothing reached the page while asking');
  await answer(g, 'once');
  assert.match(await clicking, /text "sent"/);
  await noPrompt();
  s.end();
});

test('Block keeps the page unchanged, and the session is told the user declined', async () => {
  const s = b.as('g-block', 'Claude Code');
  const page = await s.text('navigate', { url: `${b.base}/guard.html` });
  const clicking = s.text('click', { ref: ref(page, 'button "Delete"') });
  await answer(await prompt(), 'block');
  await assert.rejects(clicking, /The user declined: click "Delete" on /);
  assert.equal(await read('g-block'), 'nothing yet');
  s.end();
});

test('Always on this site is remembered for that kind of action, and can be forgotten', async () => {
  const s = b.as('g-always', 'Claude Code');
  const page = await s.text('navigate', { url: `${b.base}/guard.html` });
  const first = s.text('click', { ref: ref(page, 'button "Eliminar cuenta"') });
  const g = await prompt();
  assert.equal(g.what, 'click "Eliminar cuenta"');
  assert.equal(g.canAlways, true);
  await answer(g, 'always');
  assert.match(await first, /text "eliminado"/);

  const file = JSON.parse(fs.readFileSync(path.join(b.home, 'guardrails.json'), 'utf8'));
  assert.deepEqual(file.always, { [b.base]: ['delete'] });
  assert.deepEqual((await b.state()).guardrails.always, [{ origin: b.base, kind: 'delete', site, name: 'Deleting' }]);

  // Deleting again on this site goes through; sending is still asked.
  assert.match(await s.text('click', { ref: ref(page, 'button "Delete"') }), /text "deleted"/);
  await noPrompt();
  const sending = s.text('click', { ref: ref(page, 'button "Send"') });
  await answer(await prompt(), 'block');
  await assert.rejects(sending, /declined/);

  await b.ui('guard:forget', { origin: b.base, kind: 'delete' });
  const again = s.text('click', { ref: ref(page, 'button "Delete"') });
  await answer(await prompt(), 'once');
  await again;
  s.end();
});

test('ordinary clicks, typing and navigation are not interrupted', async () => {
  const s = b.as('g-plain', 'Claude Code');
  const start = Date.now();
  let page = await s.text('navigate', { url: `${b.base}/guard.html` });
  assert.match(await s.text('click', { ref: ref(page, 'button "Next"') }), /text "next"/);
  page = await s.text('snapshot');
  await s.text('type', { ref: ref(page, 'textbox "Search"'), text: 'shoes', submit: true }); // a GET form
  assert.match((await tabOf('g-plain')).url, /second\.html\?q=shoes/);
  page = await s.text('navigate', { url: b.base });
  await s.text('click', { ref: ref(page, 'link "Second page"') });
  await s.text('press_key', { key: 'Enter' });
  await noPrompt();
  assert.ok(Date.now() - start < 15000, 'and not slowed down');
  s.end();
});

test('submitting a password form is asked about', async () => {
  const s = b.as('g-pass', 'Claude Code');
  const page = await s.text('navigate', { url: `${b.base}/guard.html` });
  await s.text('type', { ref: ref(page, 'textbox "Password"'), text: 'hunter2' }); // typing alone is not asked
  await noPrompt();
  const signing = s.text('click', { ref: ref(page, 'button "Sign in"') });
  const g = await prompt();
  assert.equal(g.what, 'submit a form with a password ("Sign in")');
  await answer(g, 'block');
  await assert.rejects(signing, /declined/);
  assert.match((await tabOf('g-pass')).url, /guard\.html$/);
  // Enter in the password field submits the form too.
  const entering = s.text('type', { ref: ref(page, 'textbox "Password"'), text: '!', submit: true });
  await answer(await prompt(), 'block');
  await assert.rejects(entering, /declined/);
  assert.match((await tabOf('g-pass')).url, /guard\.html$/);
  s.end();
});

test('placing an order with card fields is asked once, and Allow submits it', async () => {
  const s = b.as('g-order', 'Claude Code');
  const page = await s.text('navigate', { url: `${b.base}/checkout.html` });
  const ordering = s.text('click', { ref: ref(page, 'button "Place order"') });
  const g = await prompt();
  assert.equal(g.what, 'submit a payment form ("Place order")');
  await answer(g, 'once');
  // The card number in the request that follows is not asked about again.
  assert.match(await ordering, /Thank you/);
  await noPrompt();
  s.end();
});

test('a harmless button whose script submits a payment is caught at the request', async () => {
  const s = b.as('g-next', 'Claude Code');
  const page = await s.text('navigate', { url: `${b.base}/checkout.html` });
  const clicking = s.text('click', { ref: ref(page, 'button "Next"') });
  const g = await prompt();
  assert.equal(g.what, `send card details to ${site}`);
  await answer(g, 'block');
  const result = await clicking;
  assert.match(result, /The page tried to send card details to .* on its own after your action\. The user declined, so Loui stopped it\./);
  const tab = await tabOf('g-next');
  assert.match(tab.url, /checkout\.html$/, 'the page stayed');
  assert.equal(tab.title, 'Checkout');
  assert.equal(await read('g-next', "document.querySelector('[name=cardnumber]').value"), '4242 4242 4242 4242', 'as it was');

  // The same through fetch.
  const fetching = s.text('click', { ref: ref(page, 'button "Continue"') });
  await answer(await prompt(), 'block');
  assert.match(await fetching, /The user declined, so Loui stopped it/);
  assert.equal(await wait('the fetch to fail', async () => (await read('g-next')) === 'fetch stopped' && 'ok'), 'ok');
  s.end();
});

test('evaluate on a page with card or password fields is asked about first', async () => {
  const s = b.as('g-eval', 'Claude Code');
  await s.text('navigate', { url: `${b.base}/checkout.html` });
  const running = s.text('evaluate', { code: "document.getElementById('pay').submit()" });
  const g = await prompt();
  assert.equal(g.what, 'run a script on a page with a card field');
  await answer(g, 'block');
  await assert.rejects(running, /declined/);
  assert.match((await tabOf('g-eval')).url, /checkout\.html$/);
  // Elsewhere evaluate runs without asking.
  await s.text('navigate', { url: `${b.base}/second.html` });
  assert.equal(await s.text('evaluate', { code: 'document.title' }), '"Second"');
  await noPrompt();
  s.end();
});

test('opening a site the user listed is asked about', async () => {
  const s = b.as('g-site', 'Claude Code');
  await b.ui('guard:site-add', 'http://LocalHost/whatever');
  assert.ok((await b.state()).guardrails.sites.includes('localhost'));
  const other = b.base.replace('127.0.0.1', 'localhost');
  const opening = s.text('navigate', { url: `${other}/second.html`, new_tab: true });
  const g = await prompt();
  assert.equal(g.what, `open ${new URL(other).host}`);
  assert.equal(g.kind, 'site');
  await answer(g, 'block');
  await assert.rejects(opening, /The user declined: open localhost:\d+\. /);
  assert.equal((await b.state()).tabs.filter((t) => t.group === 'g-site').length, 0, 'the tab opened for it is closed');
  await b.ui('guard:site-remove', 'localhost');
  await s.text('navigate', { url: `${other}/second.html` });
  await noPrompt();
  s.end();
});

test('a session the user trusts is not asked again until it ends', async () => {
  const s = b.as('g-trust', 'Claude Desktop');
  const page = await s.text('navigate', { url: `${b.base}/guard.html` });
  const first = s.text('click', { ref: ref(page, 'button "Send"') });
  await answer(await prompt(), 'once', true);
  await first;
  assert.deepEqual((await b.state()).guardrails.trusted, [{ id: 'g-trust', label: 'Claude Desktop' }]);
  assert.match(await s.text('click', { ref: ref(page, 'button "Delete"') }), /text "deleted"/);
  await noPrompt();
  s.end();
  await wait('the trust to end with the session', async () => !(await b.state()).guardrails.trusted.length);
});

test('guardrails can be turned off in settings', async () => {
  await b.ui('guard:set', { on: false });
  const s = b.as('g-off', 'Claude Code');
  const page = await s.text('navigate', { url: `${b.base}/guard.html` });
  assert.match(await s.text('click', { ref: ref(page, 'button "Delete"') }), /text "deleted"/);
  await noPrompt();
  await b.ui('guard:set', { on: true });
  assert.equal(JSON.parse(fs.readFileSync(path.join(b.home, 'guardrails.json'), 'utf8')).on, true);
  s.end();
});

test('the Claude panel is asked about too, in the user\'s own tabs', async () => {
  await b.ui('panel', { tool: 'navigate', args: { url: `${b.base}/guard.html` } });
  const page = await b.ui('panel', { tool: 'snapshot' }).then((c) => c[0].text);
  const clicking = b.ui('panel', { tool: 'click', args: { ref: ref(page, 'button "Send"') } });
  const g = await prompt();
  assert.equal(g.who, 'Claude in the panel');
  await answer(g, 'block');
  await assert.rejects(clicking, /declined/);
});

test('the user\'s own actions are never interrupted', async () => {
  await b.ui('go', `${b.base}/checkout.html`);
  const mine = await wait('the checkout page', async () => {
    const t = (await b.state()).tabs.find((x) => x.active);
    return t.title === 'Checkout' && t;
  });
  await b.ui('tab:js', { id: mine.id, code: "document.querySelector('#pay button').click()" });
  await wait('the order to go through', async () => (await b.state()).tabs.find((x) => x.id === mine.id).title === 'Done');
  await noPrompt();
});

// ── gaps found by the audit ────────────────────────────────────────────────
test('controls that are not plain short-named buttons are classified too', () => {
  const button = (name, more = {}) => classify({ role: 'button', name, submits: false, form: {}, ...more });
  // Something that takes clicks without being a button.
  assert.equal(classify({ role: 'div', name: 'Pay now', clickable: true, form: {} })?.kind, 'pay');
  assert.equal(classify({ role: 'div', name: 'Pay now', form: {} }), null, 'plain text is not a control');
  // A long name that starts with a pay verb.
  assert.equal(button('Pay $1,234.56 now with the card ending 4242')?.kind, 'pay');
  assert.equal(button('Learn how to pay less for the things you buy every single day'), null);
  // Confirm, in a dialog about paying or deleting.
  assert.equal(button('Confirm', { near: 'Delete 3 files? This cannot be undone.' })?.kind, 'confirm');
  assert.equal(button('Sí', { near: '¿Eliminar la cuenta?' })?.kind, 'confirm');
  assert.equal(button('Confirm', { near: 'Choose a language' }), null);
  assert.equal(button('Cancel', { near: 'Delete 3 files?' }), null);
  for (const name of ['Subscribe', 'Order now', 'Book now', 'Reserve', 'Upgrade to Pro', 'Suscribirse', 'Suscribite', 'Reservar', 'Pedir ahora']) {
    assert.equal(button(name)?.kind, 'pay', name);
  }
  for (const name of ['Post', 'Post comment', 'Publish', 'Share', 'Reply', 'Publicar', 'Compartir', 'Responder']) {
    assert.equal(button(name)?.kind, 'send', name);
  }
  for (const name of ['Unsubscribe', 'Discard', 'Discard draft', 'Empty trash', 'Cancel subscription', 'Darse de baja', 'Descartar', 'Vaciar papelera']) {
    assert.equal(button(name)?.kind, 'delete', name);
  }
  for (const name of ['Order history', 'Sort order', 'Bookmark', 'Book reviews', 'New post', 'View post', 'Shared with me', 'Replies',
    'Subscriptions', 'Ordenar por precio', 'Reservas', 'Yes', 'OK', 'Continue']) {
    assert.equal(button(name), null, name);
  }
  // Enter in a chat box, next to a Send button.
  const box = (beside) => classify({ role: 'textbox', name: 'Message', submits: false, form: {}, beside });
  assert.equal(box(['Attach', 'Send message'])?.kind, 'send');
  assert.equal(box(['Enviar'])?.kind, 'send');
  assert.equal(box(['Bold', 'Italic', 'Share']), null);
  assert.equal(box(null), null);
});

const promptAfter = (g) => wait('another guardrail prompt', async () => {
  const now = (await b.state()).guard;
  return now && now.id !== g.id && now;
});
const js = async (group, code) => b.ui('tab:js', { id: (await tabOf(group)).id, code });

test('a click is judged where it lands, not only on the element named', async () => {
  const s = b.as('g-cover', 'Claude Code');
  const page = await s.text('navigate', { url: `${b.base}/guard2.html` });
  const clicking = s.text('click', { ref: ref(page, 'link "Next page"') });
  const g = await prompt();
  assert.equal(g.what, 'click "Delete"', 'the invisible button on top of the link');
  await answer(g, 'block');
  await assert.rejects(clicking, /declined/);
  assert.equal(await read('g-cover'), 'nothing yet');
  s.end();
});

test('a click is judged again if the page changed while the user was asked', async () => {
  const s = b.as('g-moved', 'Claude Code');
  const page = await s.text('navigate', { url: `${b.base}/guard2.html` });
  const clicking = s.text('click', { ref: ref(page, 'button "Send" [') });
  const g = await prompt();
  assert.equal(g.what, 'click "Send"');
  // While the question is open the page moves another control under the point.
  await js('g-moved', `(() => { const d = document.getElementById('cover'), r = document.getElementById('send').getBoundingClientRect();
    document.body.appendChild(d);
    d.style.cssText = 'position:fixed;opacity:0;left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px'; })()`);
  await answer(g, 'once');
  const again = await promptAfter(g);
  assert.equal(again.what, 'click "Delete"');
  await answer(again, 'block');
  await assert.rejects(clicking, /declined/);
  assert.equal(await read('g-moved'), 'nothing yet');

  // And if the target is gone by then, the click fails instead of landing on what took its place.
  const next = await s.text('snapshot');
  const buying = s.text('click', { ref: ref(next, 'button "Buy now"') });
  const q = await promptAfter(again);
  await js('g-moved', "document.getElementById('buy').remove()");
  await answer(q, 'once');
  await assert.rejects(buying, /no longer on the page/);
  assert.equal(await read('g-moved'), 'nothing yet');
  s.end();
});

test('a click a script makes on a consequential control is held and asked about', async () => {
  const s = b.as('g-script', 'Claude Code');
  await s.text('navigate', { url: `${b.base}/guard2.html` });
  // A harmless one runs at once, as before.
  assert.equal(await s.text('evaluate', { code: "(document.getElementById('next').click(), document.getElementById('out').textContent)" }), '"next"');
  await noPrompt();

  const running = s.text('evaluate', { code: "(document.getElementById('buy').click(), 'ran')" });
  const g = await prompt();
  assert.equal(g.what, 'click "Buy now"');
  assert.equal(await read('g-script'), 'next', 'the click did not reach the page');
  await answer(g, 'block');
  await assert.rejects(running, /declined/);
  assert.equal(await read('g-script'), 'next');

  const allowed = s.text('evaluate', { code: "(document.getElementById('buy').click(), 'ran')" });
  await answer(await promptAfter(g), 'once');
  assert.match(await allowed, /Loui held the script's attempt to click "Buy now" until the user allowed it\.\n"ran"/);
  assert.equal(await read('g-script'), 'bought', 'and then it went through');

  // One left for later is stopped, and the session is told with its next call.
  await js('g-script', "document.getElementById('out').textContent = 'reset'");
  assert.equal(await s.text('evaluate', { code: "(setTimeout(() => document.getElementById('buy').click(), 300), 1)" }), '1');
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(await read('g-script'), 'reset');
  assert.match(await s.text('snapshot'), /A script you ran earlier tried to click "Buy now" after it returned\. Loui stopped it/);
  await noPrompt();
  s.end();
});

test('a form a script submits, and a select that acts when changed, are asked about', async () => {
  const s = b.as('g-auto', 'Claude Code');
  const page = await s.text('navigate', { url: `${b.base}/guard2.html` });
  const choosing = s.text('select_option', { ref: ref(page, 'select "Plan"'), value: 'Pro' });
  const g = await prompt();
  assert.equal(g.what, 'click "Buy now"');
  await answer(g, 'block');
  await assert.rejects(choosing, /declined/);
  assert.equal(await read('g-auto'), 'nothing yet');

  // form.submit() fires no event: it is caught when the page is posted.
  const running = s.text('evaluate', { code: "document.getElementById('msg').submit()" });
  const q = await promptAfter(g);
  assert.equal(q.what, `submit a form to ${site}`);
  await answer(q, 'block');
  assert.match(await running, /The page tried to submit a form to .* The user declined, so Loui stopped it/);
  assert.match((await tabOf('g-auto')).url, /guard2\.html$/);
  s.end();
});

test('controls that are not buttons, long names, dialogs and other verbs are asked about', async () => {
  const s = b.as('g-names', 'Claude Code');
  const page = await s.text('navigate', { url: `${b.base}/guard2.html` });
  let last = { id: 0 };
  for (const [start, what] of [
    ['clickable "Pay now"', 'click "Pay now"'],
    ['clickable "Comprar"', 'click "Comprar"'],
    ['button "Pay $1,234.56', 'click "Pay $1,234.56 now with the card ending …"'],
    ['button "Post"', 'click "Post"'],
    ['button "Confirm"', 'click "Confirm"'],
  ]) {
    const clicking = s.text('click', { ref: ref(page, start) });
    last = await promptAfter(last);
    assert.equal(last.what, what);
    await answer(last, 'block');
    await assert.rejects(clicking, /declined/);
  }
  assert.equal(await read('g-names'), 'nothing yet');
  s.end();
});

test('Enter in a chat box next to a Send button is asked about; in a plain text area it is not', async () => {
  const s = b.as('g-chat', 'Claude Code');
  const page = await s.text('navigate', { url: `${b.base}/guard2.html` });
  const typing = s.text('type', { ref: ref(page, 'textbox "Message"'), text: 'hello', submit: true });
  const g = await prompt();
  assert.equal(g.what, 'press Enter in "Message" (next to "Send message")');
  assert.equal(g.kind, 'send');
  await answer(g, 'block');
  await assert.rejects(typing, /declined/);
  await s.text('type', { ref: ref(page, 'textbox "Message"'), text: 'hello' });
  await noPrompt();
  const pressing = s.text('press_key', { key: 'Enter' });
  await answer(await promptAfter(g), 'block');
  await assert.rejects(pressing, /declined/);
  assert.equal(await read('g-chat'), 'nothing yet');
  await s.text('type', { ref: ref(page, 'textbox "Notes"'), text: 'a line', submit: true });
  await noPrompt();
  s.end();
});

test('request bodies sent as a blob, with DELETE, or past the first 64 KB are read', async () => {
  const s = b.as('g-body', 'Claude Code');
  const page = await s.text('navigate', { url: `${b.base}/guard2.html` });
  let last = { id: 0 };
  for (const name of ['Save', 'Refresh', 'Load more']) {
    const clicking = s.text('click', { ref: ref(page, `button "${name}"`) });
    last = await promptAfter(last);
    assert.equal(last.what, `send card details to ${site}`, name);
    await answer(last, 'block');
    assert.match(await clicking, /The user declined, so Loui stopped it/);
    assert.equal(await wait('the request to fail', async () => (await read('g-body')) === 'request stopped' && 'ok'), 'ok');
    await js('g-body', "document.getElementById('out').textContent = 'nothing yet'");
  }
  s.end();
});

test('a listed site is asked about however the page gets there', async () => {
  const s = b.as('g-ways', 'Claude Code');
  await b.ui('guard:site-add', 'localhost');
  const other = b.base.replace('127.0.0.1', 'localhost');
  const page = await s.text('navigate', { url: `${b.base}/guard2.html` });
  // A button whose script sets location.
  const clicking = s.text('click', { ref: ref(page, 'button "Open wallet"') });
  const g = await prompt();
  assert.equal(g.kind, 'site');
  assert.equal(g.what, `open ${new URL(other).host}`);
  await answer(g, 'block');
  assert.match(await clicking, /The page tried to open localhost:\d+ on its own after your action\. The user declined, so Loui stopped it/);
  assert.match((await tabOf('g-ways')).url, /guard2\.html$/);
  // A form that goes there; allowed, it does.
  await js('g-ways', `document.getElementById('wallet').action = '${other}/second.html'`);
  const submitting = s.text('click', { ref: ref(page, 'button "Wallet"') });
  await answer(await promptAfter(g), 'once');
  await submitting;
  assert.match((await tabOf('g-ways')).url, /^http:\/\/localhost:\d+\/second\.html/);
  await b.ui('guard:site-remove', 'localhost');
  s.end();
});
