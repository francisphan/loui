// Passwords, inside one of the user's own pages (never a Claude session's).
// Runs in an isolated world of its own (src/main/passwords.js): it shares the
// DOM with the page but not its JavaScript, so the page can neither see nor
// call it, nor read the secret it reports with. Only the top frame gets it.
//
// Two jobs:
// - Noticing a sign-in. When a password the user typed is sent (a form
//   submitted, Enter pressed, a button clicked while a password is filled in),
//   it tells the main process what was typed, and whether the password field
//   then goes away. The main process decides whether the sign-in went through
//   before it offers to save anything.
// - Filling, when the user chose an account from the key in the address bar.
//   Only ever on that click; nothing here fills by itself.
//
// Reports go out as console messages that start with a marker and the secret.
// tabs.js keeps them out of the console history that tools can read.
//
// Evaluated more than once (each call carries the file), so it defines itself once.
(() => {
  if (globalThis.__louiPw) return;

  const MAX = 512; // longer than any real username or password
  let secret = '';
  let installed = false;
  let armed = false; // a sign-in field has been seen on this page
  let watching = 0;

  const isInput = (el) => el instanceof HTMLInputElement;
  const isPassword = (el) => isInput(el) && el.type === 'password';
  const textLike = (el) => isInput(el) && ['text', 'email', 'tel', 'search'].includes(el.type);
  const visible = (el) => {
    if (!el?.isConnected || !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 4 && r.height >= 4;
  };
  const usable = (el) => visible(el) && !el.disabled && !el.readOnly;
  const targetOf = (e) => e.composedPath()[0];
  // The form a field belongs to; without one, the page (or shadow root) it is in.
  const scopeOf = (el) => el.form || el.closest?.('form') || el.getRootNode();
  const inputsIn = (scope) => [...scope.querySelectorAll('input')];

  // The field a username goes in, for a password field: a visible text or email
  // field before it in the same form, preferring one marked as the username.
  function userFieldFor(pw, inputs, needValue) {
    const before = inputs.slice(0, inputs.indexOf(pw))
      .filter((el) => textLike(el) && visible(el) && (!needValue || el.value));
    return before.find((el) => /\busername\b/.test(el.autocomplete) || el.type === 'email') ||
      before[before.length - 1] || null;
  }
  // A username field on a page without a password field (the first step of
  // a two-step sign-in).
  const userLike = (el) => textLike(el) &&
    (/\busername\b/.test(el.autocomplete) || el.type === 'email' || /user|email|login|account/i.test(el.name + ' ' + el.id));
  const lonelyUser = (inputs) => inputs.find((el) => userLike(el) && visible(el));

  function send(kind, data = {}) {
    console.log(`\u0001loui-pw ${secret} ${JSON.stringify({ kind, ...data })}`);
  }

  // What is filled in now, in the form `scope` (or the page). With two or more
  // passwords (a change-password form), the new one is the pair that matches.
  function attempt(scope) {
    const inputs = inputsIn(scope);
    const filled = inputs.filter((el) => isPassword(el) && el.value && el.value.length <= MAX);
    if (!filled.length) {
      const user = lonelyUser(inputs);
      if (user?.value && user.value.length <= MAX) send('user', { username: user.value });
      return;
    }
    let field = filled[0];
    const [a, b] = filled.slice(-2);
    if (filled.length >= 2 && a.value === b.value) field = b;
    const user = userFieldFor(filled[0], inputs, true);
    const username = user && user.value.length <= MAX ? user.value : '';
    send('try', { username, password: field.value });
    watch(field);
  }

  // A sign-in sent without leaving the page (by fetch) shows itself by the
  // password field going away. Watched for ten seconds after each attempt.
  function watch(field) {
    clearInterval(watching);
    let n = 0;
    watching = setInterval(() => {
      if (!visible(field)) {
        clearInterval(watching);
        send('gone');
      } else if (++n >= 40) clearInterval(watching);
    }, 250);
  }

  const hasPassword = () => inputsIn(document).some((el) => isPassword(el) && visible(el));

  function install(key) {
    if (installed) return { password: hasPassword() };
    installed = true;
    secret = key;
    armed = hasPassword() || !!lonelyUser(inputsIn(document));
    // Listeners only. Until a sign-in field shows up (it may arrive later, as
    // in a sign-in dialog) keys and clicks are ignored at once.
    document.addEventListener('focusin', (e) => {
      const el = targetOf(e);
      if (!armed && (isPassword(el) || userLike(el))) armed = true;
    }, true);
    document.addEventListener('submit', (e) => {
      if (e.target instanceof HTMLFormElement) attempt(e.target);
    }, true);
    document.addEventListener('keydown', (e) => {
      const el = targetOf(e);
      if (armed && e.key === 'Enter' && isInput(el)) attempt(scopeOf(el));
    }, true);
    document.addEventListener('click', (e) => {
      if (!armed) return;
      const el = targetOf(e);
      const button = el?.closest?.('button, input[type=submit], input[type=image], [role=button]');
      if (button) attempt(scopeOf(button));
    }, true);
    return { password: hasPassword() };
  }

  function set(el, value) {
    el.focus();
    el.value = value;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertReplacementText' }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Fills a visible password field (the focused one first) and the username
  // field before it; on a page with no password field, a username field alone.
  // Nothing hidden is filled. origin: where the login was saved, checked again here.
  function fill({ origin, username, password }) {
    if (location.origin !== origin || window !== window.top) return { filled: false };
    const all = inputsIn(document);
    const focused = document.activeElement;
    const pw = isPassword(focused) && usable(focused) ? focused : all.find((el) => isPassword(el) && usable(el));
    let user = pw ? userFieldFor(pw, inputsIn(scopeOf(pw)), false) : lonelyUser(all);
    if (user && !usable(user)) user = null;
    if (!pw && !user) return { filled: false };
    if (user && username) set(user, username);
    if (pw) set(pw, password);
    return { filled: true, username: !!(user && username), password: !!pw };
  }

  globalThis.__louiPw = { install, fill, hasPassword };
})();
