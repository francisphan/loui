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
