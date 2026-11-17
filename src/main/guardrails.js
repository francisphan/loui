// Guardrails: Loui asks the user before Claude pays, sends, deletes, signs in,
// or opens a site the user listed. This is the browser's own check, so it holds
// whatever Claude was told and whatever a page says to it.
//
// Two layers:
//  1. Before a tool sends input (actions.js), the target is classified: what the
//     control is called, whether it submits a form, and what that form holds
//     (card, password or one-time-code fields), or where a navigation goes. A
//     consequential one waits for the user's answer before anything reaches
//     the page. classify() holds the rules.
//  2. While a session is acting in a tab (and for a few seconds after), every
//     POST, PUT or PATCH the tab makes is read for card numbers, passwords and
//     one-time codes, whatever started it: a "Next" button whose script submits
//     a payment form, form.submit() run by evaluate, fetch(). Such a request
//     is held (see requests.js) until the user answers.
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
  script: 'Running scripts on pages with password or card fields',
};

// Sites to ask before opening (navigate, or a click on a link to one). The
// user edits the list in Settings. A site matches itself and its subdomains.
const DEFAULT_SITES = ['paypal.com', 'checkout.stripe.com', 'mercadopago.com', 'mercadopago.com.ar'];

// Control names, in English and Spanish. Matched on the accessible name,
// lowercased and without accents, only for short names: a long name is a
// sentence about something, not a verb on a button.
const PAY = /\b(pay|buy|purchase|place (my |your )?order|submit (my )?(payment|order)|complete (my )?(purchase|order|payment)|confirm (and pay|purchase|payment|order)|checkout|check out|transfer|donate|pagar|comprar|finalizar (la )?compra|realizar (el )?pedido|confirmar (la |el )?(compra|pago|pedido)|transferir|abonar)\b/;
const DELETE = /\b(delete|remove (my |the |this )?account|close (my )?account|eliminar|borrar)\b/;
const SEND = /\b(send|enviar)\b/;
const CONFIRM = /^(confirm|confirmar)\b/;
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
//   info: { role, name, submits, form: { card, password, otp }, href }
function classify(info, sites = []) {
  if (!info) return null;
  const name = plain(info.name);
  const said = `"${shorten((info.name || '').trim())}"`;
  const short = name.length <= 60 && name.split(' ').length <= 6;
  const button = BUTTONS.has(info.role) || info.submits;
  const form = info.form || {};
  if (info.submits && form.card) return { kind: 'pay', what: `submit a payment form (${said})` };
  if (short && button && PAY.test(name)) return { kind: 'pay', what: `click ${said}` };
  // A link named Delete can be a plain GET that deletes; a link named Buy or
  // Send normally leads to the page with the real button.
  if (short && (button || info.role === 'link') && DELETE.test(name)) return { kind: 'delete', what: `click ${said}` };
  if (info.submits && (form.password || form.otp)) {
    return { kind: 'sign-in', what: `submit a form with a ${form.password ? 'password' : 'one-time code'} (${said})` };
  }
  if (short && button && SEND.test(name)) return { kind: 'send', what: `click ${said}` };
  if (short && info.submits && CONFIRM.test(name)) return { kind: 'confirm', what: `click ${said}` };
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

function createGuardrails({ ses, tabs, sessions, home, changed }) {
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
    acting.set(session.id, a);
  }
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
  // tab the user has taken over is theirs.
  function actorOf(tab) {
    if (tab.group === YOU) {
      const a = acting.get(sessions.panel.id);
      return a?.n > 0 && tabs.group(YOU).current === tab.id ? sessions.panel : null;
    }
    const g = tabs.group(tab.group);
    const a = acting.get(tab.group);
    if (!g || g.paused || !a || (a.n === 0 && Date.now() > a.until)) return null;
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
      // What the allowed action sets off is not asked about again.
      if (ok) passes.set(session.id, { tabId: tab.id, until: acting.get(session.id)?.n ? Infinity : Date.now() + 3000 });
      return { ok, p };
    });
  }

  // For actions.js: throws the session's tool error if the user says no.
  async function confirm(session, tab, found, image) {
    const { ok, p } = await ask(session, tab, found, image);
    if (ok) return;
    throw new Error(p.timedOut
      ? `The user did not answer within 2 minutes, so Loui did not ${found.what} on ${p.site}. Ask the user before trying again.`
      : `The user declined: ${found.what}${found.kind === 'site' ? '' : ` on ${p.site}`}. Loui stopped it before it reached the page. Do not try another way; ask the user what they want.`);
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
  function judgeScript(session, tab, fields) {
    if (!applies(session) || !fields || !(fields.card || fields.password || fields.otp)) return null;
    if (remembered(originOf(tab.url), 'script')) return null;
    const holds = fields.card ? 'card' : fields.password ? 'password' : 'one-time code';
    return { kind: 'script', what: `run a script on a page with a ${holds} field` };
  }

  // Layer 2: requests a tab makes while Claude acts in it.
  const WRITES = new Set(['POST', 'PUT', 'PATCH']);
  requestRules(ses).add((d) => {
    if (!conf.on || !WRITES.has(d.method) || !d.uploadData?.length) return null;
    const tab = tabs.list.find((t) => t.wc && !t.wc.isDestroyed() && t.wc.id === d.webContentsId);
    const session = tab && actorOf(tab);
    if (!session || trusted.has(session.id)) return null;
    const pass = passes.get(session.id);
    if (pass && pass.tabId === tab.id && Date.now() < pass.until) return null;
    const bytes = Buffer.concat(d.uploadData.filter((u) => u.bytes).map((u) => u.bytes));
    const kind = inspectBody(bytes.subarray(0, 65536).toString('utf8'));
    if (!kind || remembered(originOf(tab.url), kind)) return null;
    const what = `send ${kind === 'pay' ? 'card details' : 'a password or code'} to ${hostOf(d.url)}`;
    const nav = d.resourceType === 'mainFrame';
    return picture(tab).then((image) => ask(session, tab, { kind, what }, image)).then(({ ok, p }) => {
      if (ok) return null;
      const list = notes.get(session.id) || [];
      list.push(`The page tried to ${what} on its own after your action. ${p.timedOut ? 'The user did not answer' : 'The user declined'}, so Loui stopped it.`);
      notes.set(session.id, list);
      // Stopping first leaves the page as it was; a cancelled navigation
      // would otherwise replace it with an error page.
      if (nav && tab.wc && !tab.wc.isDestroyed()) tab.wc.stop();
      return { cancel: true };
    });
  });

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
  const show = (id) => { const p = pending.find((q) => q.id === id); if (p) tabs.select(p.tabId); };

  // A session that ends takes its questions and trust with it; so does a tab
  // that closes or goes back to the user.
  tabs.on('change', () => {
    for (const id of trusted) if (id !== sessions.panel.id && !tabs.group(id)) trusted.delete(id);
    for (const p of [...pending]) {
      const tab = tabs.get(p.tabId);
      const gone = !tab || (p.session !== sessions.panel && tab.group !== p.session.id);
      if (gone) settle(p, false);
    }
  });

  function state() {
    const p = pending[0];
    return {
      guard: p ? {
        id: p.id, who: who(p.session), kind: p.kind, site: p.site, what: p.what, image: p.image,
        canAlways: !!p.origin, onScreen: tabs.activeId === p.tabId, more: pending.length - 1,
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
    applies, begin, end, drain, takeNotes, judge, judgeUrl, judgeScript, confirm,
    answer, set, addSite, removeSite, forget, untrust, show, state,
  };
}

module.exports = { createGuardrails, classify, inspectBody };
