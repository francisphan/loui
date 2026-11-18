// Guardrails: Loui asks the user before Claude pays, sends, deletes, signs in,
// or opens a site the user listed. This is the browser's own check, so it holds
// whatever Claude was told and whatever a page says to it.
//
// Two layers:
//  1. Before a tool sends input (actions.js), the target is classified: what the
//     control is called, whether it submits a form, and what that form holds
//     (card, password or one-time-code fields), or where a navigation goes. A
//     consequential one waits for the user's answer before anything reaches
//     the page. classify() holds the rules. A click is judged on what it will
//     land on, and again just before it is sent; what a script of Claude's
//     clicks or submits is held in the page and judged the same way, from
//     its first run until the page is left. A script that reads like one
//     that clicks, submits or calls a handler is asked about before it runs
//     on a page with such a control (a handler called directly sends no
//     event to hold).
//  2. While a session is acting in a tab (and for a few seconds after), every
//     POST, PUT, PATCH or DELETE the tab makes is read for card numbers,
//     passwords and one-time codes, whatever started it: a "Next" button whose
//     script submits a payment form, form.submit() run by evaluate, fetch().
//     Such a request is held (see requests.js) until the user answers. So is
//     the tab going to a listed site by any way but the ones in layer 1 (a
//     script setting location, a form, a redirect), and a form a script posts.
//
// The prompt is a strip in the window chrome, so no page can draw it or click
// it. It names the session, the site and the action, with a picture of the
// target. Allow once, Always on this site (for that kind of action), or Block;
// no answer in two minutes counts as Block. The user can also trust a session
// for the rest of its life. Settings and remembered answers are kept in
// guardrails.json in the profile.
//
// Applies to Claude sessions and to the Claude panel (which acts in the user's
// tabs, so there only while it is acting). The user's own clicks never pass
// through here: the tools are the only way in, and the request check only
// runs while Claude is acting.
const fs = require('fs');
const path = require('path');
const { YOU } = require('./tabs');
const { requestRules } = require('./requests');

const WAIT_MS = 2 * 60 * 1000;
// A page may act a moment after the click that set it off (a timer, an awaited
// fetch); requests from a session's tab are still checked this long after.
const GRACE_MS = 10000;

const KINDS = {
  pay: 'Paying or buying',
  send: 'Sending',
  delete: 'Deleting',
  'sign-in': 'Signing in',
  confirm: 'Confirming',
  site: 'Opening this site',
  frame: 'Clicking inside embedded parts of a page that Loui cannot read',
  script: 'Running scripts on pages with password or card fields',
};

// Sites to ask before opening (navigate, or a click on a link to one). The
// user edits the list in Settings. A site matches itself and its subdomains.
const DEFAULT_SITES = ['paypal.com', 'checkout.stripe.com', 'mercadopago.com', 'mercadopago.com.ar'];

// Control names, in English and Spanish. Matched on the accessible name,
// lowercased and without accents, only for short names: a long name is a
// sentence about something, not a verb on a button. Verbs that are also
// everyday nouns (order, book, post, share) only count at the start.
const PAY = /\b(pay|buy|purchase|place (my |your )?order|submit (my )?(payment|order)|complete (my )?(purchase|order|payment)|confirm (and pay|purchase|payment|order|booking|reservation)|checkout|check out|transfer|donate|pagar|comprar|finalizar (la )?compra|realizar (el )?pedido|confirmar (la |el )?(compra|pago|pedido|reserva)|transferir|abonar|donar)\b|^(order|book|reserve|pedir|reservar|ordenar)( now| ahora| ya)?$/;
// A button may say more than six words when it starts with one of these
// ("Pay $45.00 now with the card ending 4242").
const PAY_START = /^(pay|buy|purchase|place (my |your )?order|donate|pagar|comprar|abonar|donar)\b/;
const DELETE = /\b(delete|remove (my |the |this )?account|close (my )?account|unsubscribe|cancel (my |the )?subscription|empty (the )?(trash|bin)|eliminar|borrar|darse de baja|darme de baja|cancelar (mi |la )?suscripcion|vaciar (la )?papelera)\b|^(discard|descartar)\b/;
const SEND = /\b(send|enviar)\b|^(post|publish|tweet|publicar)\b/;
// Everyday controls that mostly open something (a share menu, a reply box, a
// page of plans, a free newsletter): they only count where they finish the
// job, on a form's own submit button or in a dialog.
const PAY_LAST = /\b(subscribe|suscribirse|suscribirme|suscribete|suscribite)\b|^(upgrade|mejorar (mi |el |tu )?plan)\b/;
const SEND_LAST = /^(share|reply|compartir|responder)\b/;
const CONFIRM = /^(confirm|confirmar)\b/;
// In a dialog about paying or deleting, Yes confirms as well.
const YES = /^(yes|si)\b/;
// A button beside a text box that Enter in the box would press (a chat's Send).
const ENTER_SEND = /\b(send|enviar)\b|^(post|reply|comment|tweet|publicar|responder|comentar)\b/;
// Any of them: lib.js picks out with it what a script's click may set off, to be judged here.
const WORDS = [PAY, DELETE, SEND, PAY_LAST, SEND_LAST, CONFIRM, YES, ENTER_SEND].map((r) => r.source).join('|');
// A script that reads like one that clicks, submits, sends an event, or reads
// a handler (on<event>) other than to set it. Not proof either way: it only
// decides whether the user is asked first (judgeScript).
// Any case: frameworks name the handlers a script would call onClick, onSubmit.
const PRESSES = /\.\s*click\s*\(|\.\s*submit\s*\(|requestSubmit\s*\(|dispatchEvent\s*\(|\.\s*(handler|trigger|emit)\s*\(|(\.|\[\s*['"`])on[a-z]{4,}\b(?!\s*=(?!=))/i;
const BUTTONS = new Set(['button', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'switch']);

const plain = (s) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const shorten = (s, n = 40) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function originOf(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.origin : null;
  } catch {
    return null;
  }
}
const hostOf = (url) => { try { return new URL(url).host || url; } catch { return url; } };

// A site as the user typed it ("https://www.PayPal.com/x" -> "www.paypal.com").
function siteOf(input) {
  const s = String(input || '').trim().toLowerCase();
  if (!s) return null;
  try { return new URL(/^[a-z]+:\/\//.test(s) ? s : `https://${s}`).hostname || null; } catch { return null; }
}
const listed = (sites, url) => {
  let h;
  try { h = new URL(url).hostname.toLowerCase(); } catch { return null; }
  return sites.find((s) => h === s || h.endsWith('.' + s)) || null;
};

// What an action on an element would do, from the facts lib.js gathers
// (guardOf): { kind, what } if it is consequential, or null.
//   info: { role, name, submits, form: { card, password, otp }, href,
//     clickable: not a button or a link, but it takes clicks (onclick, cursor: pointer),
//     near: the words of the dialog it is in,
//     beside: names of the buttons next to a text box outside a form, for Enter in it }
function classify(info, sites = []) {
  if (!info) return null;
  // Loui cannot see what a press inside a frame from another site lands on (a
  // card form's Pay button, a sign-in button), so the press is asked about.
  if (info.frame) return { kind: 'frame', what: `click inside a part of the page that comes from ${info.frame}, which Loui cannot read` };
  const name = plain(info.name);
  const said = `"${shorten((info.name || '').trim())}"`;
  const short = name.length <= 60 && name.split(' ').length <= 6;
  const button = BUTTONS.has(info.role) || info.submits;
  const press = button || info.clickable;
  const form = info.form || {};
  const near = plain(info.near);
  const last = info.submits || !!near; // it finishes something: see PAY_LAST
  if (info.submits && form.card) return { kind: 'pay', what: `submit a payment form (${said})` };
  if (PAY.test(name) && (short ? press : button && PAY_START.test(name))) return { kind: 'pay', what: `click ${said}` };
  if (short && button && last && PAY_LAST.test(name)) return { kind: 'pay', what: `click ${said}` };
  // A link named Delete can be a plain GET that deletes; a link named Buy or
  // Send normally leads to the page with the real button.
  if (short && (press || info.role === 'link') && DELETE.test(name)) return { kind: 'delete', what: `click ${said}` };
  if (info.submits && (form.password || form.otp)) {
    return { kind: 'sign-in', what: `submit a form with a ${form.password ? 'password' : 'one-time code'} (${said})` };
  }
  if (short && press && SEND.test(name)) return { kind: 'send', what: `click ${said}` };
  if (short && button && last && SEND_LAST.test(name)) return { kind: 'send', what: `click ${said}` };
  const sends = (info.beside || []).find((n) => plain(n).split(' ').length <= 6 && ENTER_SEND.test(plain(n)));
  if (sends) return { kind: 'send', what: `press Enter in ${said} (next to "${shorten(sends.trim())}")` };
  // Confirm on a form's own button, or in a dialog that speaks of paying or
  // deleting (those are run by script and submit nothing).
  const grave = !!near && (PAY.test(near) || DELETE.test(near));
  if (short && ((info.submits && CONFIRM.test(name)) || (press && grave && (CONFIRM.test(name) || YES.test(name))))) {
    return { kind: 'confirm', what: `click ${said}` };
  }
  const site = info.href && listed(sites, info.href);
  if (site) return { kind: 'site', what: `open ${hostOf(info.href)}`, site: hostOf(info.href), origin: originOf(info.href) };
  return null;
}

// What a request body carries: { kind, what } or null. Field names from
// form-encoded, multipart and JSON bodies; a card number only counts under a
// name that could hold one (random IDs pass the Luhn check one time in ten).
const CARD_NAME = /card.?(number|num|no)\b|cardnumber|cc.?(num|number)|\bcvc|\bcvv|\bcsc\b|security.?code|card\]?\[(number|cvc)|tarjeta/i;
const NUMBER_NAME = /card|\bcc|pan\b|number|numero|tarjeta/i;
const PASSWORD_NAME = /password|passwd|\bpwd\b|^pass$|contrasena|contraseña|^clave$/i;
const OTP_NAME = /\botp\b|one.?time|\btotp\b|2fa|mfa.?code|verification.?code/i;

function luhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = +digits[digits.length - 1 - i];
    if (i % 2) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}
const isCard = (v) => {
  const d = String(v).replace(/[ -]/g, '');
  return /^\d{15,16}$/.test(d) && /^(4|5[1-5]|2[2-7]|3[47]|6(011|5))/.test(d) && luhn(d);
};
const decode = (s) => { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; } };

function pairsOf(body) {
  const pairs = [];
  for (const m of body.matchAll(/name="([^"]{1,80})"[^\r\n]*\r?\n(?:[^\r\n]+\r?\n)*\r?\n([^\r\n]{0,40})/g)) pairs.push([m[1], m[2]]);
  for (const m of body.matchAll(/"([^"\\]{1,80})"\s*:\s*("([^"\\]{0,40})"|[\d.]+)?/g)) pairs.push([m[1], m[3] ?? m[2] ?? '']);
  if (!/^\s*[{[]/.test(body)) {
    for (const part of body.split('&')) {
      const i = part.indexOf('=');
      if (i > 0 && i <= 120) pairs.push([decode(part.slice(0, i)), decode(part.slice(i + 1, i + 120))]);
    }
  }
  return pairs;
}

function inspectBody(body) {
  const pairs = pairsOf(body);
  if (pairs.some(([k, v]) => (CARD_NAME.test(k) && v) || (NUMBER_NAME.test(k) && isCard(v)))) return 'pay';
  if (pairs.some(([k, v]) => v && (PASSWORD_NAME.test(k) || OTP_NAME.test(k)))) return 'sign-in';
  return null;
}

// asked(session, {what, site, ok, timedOut}): each answer, for the activity log.
function createGuardrails({ ses, tabs, sessions, home, changed, asked = () => {} }) {
  const file = path.join(home, 'guardrails.json');
  const kept = (() => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { return {}; } })();
  const conf = {
    on: kept.on !== false,
    sites: Array.isArray(kept.sites) ? kept.sites : [...DEFAULT_SITES],
    always: kept.always && typeof kept.always === 'object' ? kept.always : {}, // origin -> [kind]
  };
  const save = () => fs.writeFileSync(file, JSON.stringify(conf, null, 2), { mode: 0o600 });

  const trusted = new Set(); // session ids the user trusts until they end
  const acting = new Map(); // session id -> { n: actions in flight, until: grace end }
  const passes = new Map(); // session id -> { tabId, until }: the user allowed this action
  const notes = new Map(); // session id -> [text]: what was stopped during its action
  const pending = []; // prompts, oldest first
  let seq = 0;

  const remembered = (origin, kind) => !!origin && (conf.always[origin] || []).includes(kind);
  const who = (session) => (session === sessions.panel ? 'Claude in the panel' : session.label);
  const applies = (session) => conf.on && !trusted.has(session.id);

  // A session starts or finishes a tool call (actions.js).
  function begin(session) {
    const a = acting.get(session.id) || { n: 0, until: 0 };
    a.n++;
    a.script = false;
    acting.set(session.id, a);
  }
  // The call in flight runs a script of Claude's in the page (evaluate, a
  // select_option in a form that holds more than the select): until its next
  // call, a form the tab posts is asked about.
  // What it sends is its own: an action the user allowed in an earlier call
  // does not cover it. posts: false for a select that is all its form holds.
  function scripting(session, posts = true) {
    const a = acting.get(session.id);
    if (a) a.script = posts;
    if (passes.get(session.id)?.until !== Infinity) passes.delete(session.id);
  }
  // What lib.js needs to pick out the clicks of such a script that may matter.
  const hints = () => ({ words: WORDS });
  function end(session) {
    const a = acting.get(session.id);
    if (a) { a.n = Math.max(0, a.n - 1); a.until = Date.now() + GRACE_MS; }
    const p = passes.get(session.id);
    if (p && !a?.n) p.until = Date.now() + 3000; // the page's answer to the allowed action
  }
  // Notes about what was stopped while the session acted, for its tool result.
  function takeNotes(session) {
    const list = notes.get(session.id) || [];
    notes.delete(session.id);
    return list;
  }
  // Waits until no question for this session is open.
  async function drain(session) {
    for (let p; (p = pending.find((q) => q.session.id === session.id));) await p.done;
  }

  // The session acting in a tab right now, if any. In the user's own tabs only
  // the panel acts, and only while a call of its is running in that tab; a
  // tab the user has taken over is theirs. A session's tab whose page a
  // script of the session's ran in (tab.watched, actions.js) stays acted in
  // until that page is left: what the script left behind may act at any time.
  function actorOf(tab) {
    if (tab.group === YOU) {
      const a = acting.get(sessions.panel.id);
      return a?.n > 0 && tabs.group(YOU).current === tab.id ? sessions.panel : null;
    }
    const g = tabs.group(tab.group);
    const a = acting.get(tab.group);
    if (!g || g.paused || !a || (a.n === 0 && Date.now() > a.until && !tab.watched)) return null;
    return sessions.get(tab.group) || null;
  }

  function settle(p, ok) {
    const i = pending.indexOf(p);
    if (i < 0) return;
    pending.splice(i, 1);
    clearTimeout(p.timer);
    p.resolve(ok);
    changed();
  }

  // Asks the user. Resolves { ok, p }: ok is false if they blocked it or did
  // not answer; p is the question asked.
  function ask(session, tab, found, image) {
    if (trusted.has(session.id)) return Promise.resolve({ ok: true, p: null });
    let resolve;
    const done = new Promise((r) => { resolve = r; });
    const site = found.site || hostOf(tab.wc && !tab.wc.isDestroyed() ? tab.wc.getURL() : tab.url) || 'this page';
    const p = {
      id: ++seq, session, tabId: tab.id, kind: found.kind, what: found.what, site,
      origin: found.origin !== undefined ? found.origin : originOf(tab.url), image, resolve, done,
      timedOut: false,
    };
    p.timer = setTimeout(() => { p.timedOut = true; settle(p, false); }, WAIT_MS);
    pending.push(p);
    changed();
    return done.then((ok) => {
      asked(session, { what: found.what, site, ok, timedOut: p.timedOut });
      // What the allowed action sets off is not asked about again.
      if (ok) passes.set(session.id, { tabId: tab.id, until: acting.get(session.id)?.n ? Infinity : Date.now() + 3000 });
      return { ok, p };
    });
  }

  // For actions.js: throws the session's tool error if the user says no.
  async function confirm(session, tab, found, image) {
    const { ok, p } = await ask(session, tab, found, image);
    if (ok) return;
    // stopped: the user's doing, not a failure (sessions.js, activity.js).
    throw Object.assign(new Error(p.timedOut
      ? `The user did not answer within 2 minutes, so Loui did not ${found.what} on ${p.site}. Ask the user before trying again.`
      : `The user declined: ${found.what}${found.kind === 'site' ? '' : ` on ${p.site}`}. Loui stopped it before it reached the page. Do not try another way; ask the user what they want.`),
    { stopped: p.timedOut ? 'unanswered' : 'blocked' });
  }

  // Before input: the consequential action this would be, or null if it is
  // not one, or the user's settings let it through without asking.
  function judge(session, tab, info) {
    if (!applies(session)) return null;
    const found = classify(info, conf.sites);
    if (!found) return null;
    const origin = found.origin !== undefined ? found.origin : originOf(tab.url);
    return remembered(origin, found.kind) ? null : found;
  }
  function judgeUrl(session, tab, url) {
    if (!applies(session) || !listed(conf.sites, url)) return null;
    const origin = originOf(url);
    return remembered(origin, 'site') ? null : { kind: 'site', what: `open ${hostOf(url)}`, site: hostOf(url), origin };
  }
  // Whether a script reads like one that clicks, submits or calls a handler.
  const presses = (code) => PRESSES.test(String(code));
  // controls: for such a script, the page's controls that may matter (lib.js guardControls).
  function judgeScript(session, tab, fields, controls) {
    if (!applies(session) || remembered(originOf(tab.url), 'script')) return null;
    if (fields && (fields.card || fields.password || fields.otp)) {
      const holds = fields.card ? 'card' : fields.password ? 'password' : 'one-time code';
      return { kind: 'script', what: `run a script on a page with a ${holds} field` };
    }
    const grave = (controls || []).find((info) => { const f = classify(info); return f && f.kind !== 'site'; });
    if (!grave) return null;
    return { kind: 'script', what: `run a script that clicks or submits, on a page with "${shorten((grave.name || '').trim())}"` };
  }

  // Layer 2: requests a tab makes while Claude acts in it.
  const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
  const MAX_READ = 2 * 1024 * 1024; // of a longer body, the first and the last half of this
  let fieldsOf = async () => null; // the card, password and code fields on a tab's page (actions.js)
  const reads = (fn) => { fieldsOf = fn; };
  const inspect = (buffers) => {
    const all = Buffer.concat(buffers);
    const half = MAX_READ / 2;
    const body = all.length > MAX_READ ? Buffer.concat([all.subarray(0, half), all.subarray(all.length - half)]) : all;
    return inspectBody(body.toString('utf8'));
  };
  const hold = (d) => {
    if (!conf.on) return null;
    const nav = d.resourceType === 'mainFrame';
    const write = WRITES.has(d.method);
    if (!write && !(nav && listed(conf.sites, d.url))) return null;
    const tab = tabs.list.find((t) => t.wc && !t.wc.isDestroyed() && t.wc.id === d.webContentsId);
    const session = tab && actorOf(tab);
    if (!session || trusted.has(session.id)) return null;
    const pass = passes.get(session.id);
    if (pass && pass.tabId === tab.id && Date.now() < pass.until) return null;
    const stop = (found) => picture(tab).then((image) => ask(session, tab, found, image)).then(({ ok, p }) => {
      if (ok) return null;
      const list = notes.get(session.id) || [];
      list.push(`The page tried to ${found.what} on its own after your action. ${p.timedOut ? 'The user did not answer' : 'The user declined'}, so Loui stopped it.`);
      notes.set(session.id, list);
      // Stopping first leaves the page as it was; a cancelled navigation
      // would otherwise replace it with an error page.
      if (nav && tab.wc && !tab.wc.isDestroyed()) tab.wc.stop();
      return { cancel: true };
    });
    // A listed site, reached some other way than navigate or a link to it
    // (those are asked about before they start): a script setting location,
    // a form, a redirect. Not from one page of such a site to another.
    const site = nav && listed(conf.sites, d.url) !== listed(conf.sites, tab.wc.getURL()) && judgeUrl(session, tab, d.url);
    if (site) return stop(site);
    if (!write) return null;
    const origin = originOf(tab.url);
    // A form posted by a script of Claude's (evaluate, select_option) sends
    // something, whatever it holds.
    const scripted = nav && acting.get(session.id)?.script && !remembered(origin, 'send');
    const parts = d.uploadData || [];
    // A DELETE says what it does without a body: asked about from a page a
    // script of Claude's ran in (fetch(url, { method: 'DELETE' })).
    if (!parts.length && d.method === 'DELETE' && tab.watched && !remembered(origin, 'delete')) {
      return stop({ kind: 'delete', what: `send a DELETE request to ${hostOf(d.url)}` });
    }
    if (!parts.length && !scripted) return null;
    const found = (kind) => {
      if (kind && !remembered(origin, kind)) {
        return { kind, what: `send ${kind === 'pay' ? 'card details' : 'a password or code'} to ${hostOf(d.url)}` };
      }
      return scripted ? { kind: 'send', what: `submit a form to ${hostOf(d.url)}` } : null;
    };
    if (parts.every((u) => u.bytes)) {
      const f = found(inspect(parts.map((u) => u.bytes)));
      return f ? stop(f) : null;
    }
    // A part sent as a Blob is read from the session. A file, or a blob that
    // cannot be read, is not: then the fields on the page decide.
    const blob = (id) => Promise.race([
      tab.wc.session.getBlobData(id).catch(() => null),
      new Promise((r) => setTimeout(r, 5000, null)),
    ]);
    return Promise.all(parts.map((u) => u.bytes || (u.blobUUID ? blob(u.blobUUID) : null))).then(async (buffers) => {
      let f = found(inspect(buffers.filter(Boolean)));
      if ((!f || f.kind === 'send') && buffers.some((x) => !x)) {
        const fields = (await fieldsOf(tab).catch(() => null)) || {};
        const holds = fields.card ? 'card' : fields.password ? 'password' : fields.otp ? 'one-time code' : null;
        const kind = fields.card ? 'pay' : 'sign-in';
        if (holds && !remembered(origin, kind)) {
          f = { kind, what: `send something Loui could not read to ${hostOf(d.url)} from a page with a ${holds} field` };
        }
      }
      return f ? stop(f) : null;
    });
  };
  // Each session: the user's, and each private one (a tab of it can be handed to a session).
  const attach = (s) => requestRules(s).add(hold);
  attach(ses);
  // The watch on what a script left behind (tab.watched) ends with its page.
  tabs.on('created', (tab) => tab.wc.on('did-navigate', () => { tab.watched = false; }));

  // A small picture of the page, for prompts that have no element to show.
  async function picture(tab) {
    try {
      const img = await tab.wc.capturePage();
      const { width } = img.getSize();
      return width ? img.resize({ width: Math.min(width, 360) }).toDataURL() : null;
    } catch {
      return null;
    }
  }

  // The user's answer, from the strip. id: the prompt they saw.
  function answer({ id, choice, trust } = {}) {
    const p = pending.find((q) => q.id === id);
    if (!p) return;
    const ok = choice === 'once' || choice === 'always';
    if (ok && choice === 'always' && p.origin) {
      const kinds = conf.always[p.origin] || [];
      if (!kinds.includes(p.kind)) conf.always[p.origin] = [...kinds, p.kind];
      save();
    }
    if (ok && trust) {
      trusted.add(p.session.id);
      for (const q of pending.filter((q) => q.session.id === p.session.id && q !== p)) settle(q, true);
    }
    settle(p, ok);
  }

  // Settings.
  function set({ on } = {}) {
    conf.on = !!on;
    save();
    changed();
  }
  function addSite(input) {
    const s = siteOf(input);
    if (!s || conf.sites.includes(s)) return;
    conf.sites.push(s);
    save();
    changed();
  }
  function removeSite(site) {
    conf.sites = conf.sites.filter((s) => s !== site);
    save();
    changed();
  }
  function forget({ origin, kind } = {}) {
    if (!conf.always[origin]) return;
    conf.always[origin] = conf.always[origin].filter((k) => k !== kind);
    if (!conf.always[origin].length) delete conf.always[origin];
    save();
    changed();
  }
  function untrust(id) {
    trusted.delete(id);
    changed();
  }
  const show = (id) => { const p = pending.find((q) => q.id === id); if (p) tabs.reveal(p.tabId); };

  // A session that ends takes its questions and trust with it; so does a tab
  // that closes or goes back to the user.
  tabs.on('change', () => {
    for (const kept of [trusted, acting, passes, notes]) {
      for (const id of [...kept.keys()]) if (id !== sessions.panel.id && !tabs.group(id)) kept.delete(id);
    }
    for (const p of [...pending]) {
      const tab = tabs.get(p.tabId);
      const gone = !tab || (p.session !== sessions.panel && tab.group !== p.session.id);
      if (gone) settle(p, false);
    }
  });

  // The question shows in the window that holds its tab (the window being
  // served, see tabs.as()), and in the window the user is in if that is
  // another one, so a session never waits behind a window nobody looks at.
  // Never in a private window for a tab that is not in it.
  function state() {
    const p = pending[0];
    const w = tabs.window();
    const holder = p ? tabs.get(p.tabId)?.window : null;
    const here = !!holder && holder === w;
    const elsewhere = !!holder && !here && !!w && tabs.focused === w && !w.private;
    return {
      guard: here || elsewhere ? {
        id: p.id, who: who(p.session), kind: p.kind, site: p.site, what: p.what, image: p.image,
        canAlways: !!p.origin, onScreen: here && tabs.activeId === p.tabId, more: pending.length - 1,
        // Asked from another window: which one the tab is in.
        elsewhere: elsewhere ? tabs.windowLabel(holder) : null,
      } : null,
      guardrails: {
        on: conf.on,
        sites: conf.sites,
        always: Object.entries(conf.always).flatMap(([origin, kinds]) =>
          kinds.map((kind) => ({ origin, kind, site: hostOf(origin), name: KINDS[kind] || kind }))),
        trusted: [...trusted].map((id) => ({
          id, label: id === sessions.panel.id ? 'Claude in the panel' : sessions.get(id)?.label || id,
        })),
      },
    };
  }

  return {
    applies, begin, end, drain, takeNotes, judge, judgeUrl, judgeScript, presses, confirm, scripting, hints, reads,
    answer, set, addSite, removeSite, forget, untrust, show, state, attach,
  };
}

module.exports = { createGuardrails, classify, inspectBody };
