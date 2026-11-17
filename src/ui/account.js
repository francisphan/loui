// The Claude panel's account card. The panel runs on Claude Code's own login
// (the owner's Claude subscription; no API key). When Claude Code is not
// signed in, or not installed, this card takes the message box's place and
// says what to do; "Sign in" starts Claude Code's own sign-in, which the main
// process follows (src/main/chat.js).
//
// All of it comes from state.claude: { state, kind, detail, checking, failed,
// signIn }. The sign-in's address and its code are never part of that: the
// address is opened by the main process, and a code typed here goes one way.
const account = (() => {
  const SETUP = 'https://code.claude.com/docs/en/setup';
  const ask = (what, more) => loui.send('claude', { do: what, ...more });
  const button = (id, cls, label, click) => {
    const b = el('button', cls, label);
    b.type = 'button';
    b.id = id;
    b.onclick = click;
    return b;
  };

  const card = el('section');
  card.id = 'account-card';
  card.hidden = true;
  card.setAttribute('aria-labelledby', 'account-title');
  const title = el('h2');
  title.id = 'account-title';
  const line = el('p');
  line.id = 'account-line';
  const note = el('p');
  note.id = 'account-note';
  note.setAttribute('role', 'status');

  // The code the sign-in page shows, when Claude Code asks for it.
  const form = el('form');
  form.id = 'account-code-form';
  const code = el('input');
  code.id = 'account-code';
  code.type = 'password'; // as Claude Code masks it in a terminal
  code.autocomplete = 'off';
  code.spellcheck = false;
  code.placeholder = 'Code from the sign-in page';
  code.setAttribute('aria-label', 'Code from the sign-in page');
  const go = el('button', 'account-main', 'Continue');
  go.type = 'submit';
  go.id = 'account-code-send';
  form.append(code, go);
  form.onsubmit = (e) => {
    e.preventDefault();
    if (!code.value.trim()) return;
    ask('code', { code: code.value });
    code.value = '';
  };

  const row = el('div');
  row.id = 'account-row';
  const signIn = button('account-sign-in', 'account-main', 'Sign in', () => ask('sign-in'));
  const install = button('account-install', 'account-main', 'Get Claude Code', () => loui.send('tab:new', SETUP));
  const open = button('account-open', 'quiet', 'Open the sign-in page here', () => ask('open'));
  const check = button('account-check', 'quiet', 'Check again', () => ask('check'));
  const cancel = button('account-cancel', 'quiet', 'Cancel', () => ask('cancel'));
  row.append(signIn, install, open, check, cancel);

  card.append(title, line, note, form, row);
  $('composer').after(card);

  const head = document.querySelector('#panel-head h1');

  function draw() {
    const a = state.claude;
    if (!a) return;
    const step = a.signIn?.step;
    const shown = !!step || a.state === 'signed-out' || a.state === 'not-installed';
    // Leaving: the keyboard, if it was in the card, goes to the message box.
    const had = card.contains(document.activeElement);
    card.hidden = !shown;
    document.body.classList.toggle('account-card', shown);
    if (!shown && had) $('prompt').focus();

    // With a key or a cloud provider instead of a subscription, the panel's
    // name says so when pointed at. Nothing is in the way: it is his machine.
    head.title = a.state !== 'ready' ? ''
      : a.kind === 'api-key' ? 'Claude Code is signed in with an API key, not a Claude subscription: messages here are billed to that key.'
        : a.kind === 'cloud' ? `Claude Code is set up for a cloud provider${a.detail ? ` (${a.detail})` : ''}, not a Claude subscription.`
          : `Signed in with your Claude subscription${a.detail ? ` (${a.detail})` : ''}.`;
    if (!shown) return;

    const missing = !step && a.state === 'not-installed';
    title.textContent = missing ? 'Claude Code is not installed' : 'Sign in to Claude to use the panel';
    line.textContent = missing
      ? 'The panel runs on Claude Code and your Claude subscription. Install Claude Code on this computer (on Windows, or in WSL) and sign in. Other Claude sessions can still use this browser.'
      : step === 'starting' ? 'Starting Claude Code’s sign-in…'
        : step === 'browser' ? 'Finish signing in in your browser…'
          : step === 'page' ? `Sign in on the page that opened.${a.signIn.code ? ' If it shows a code, paste it here.' : ''}`
            : step === 'finishing' ? 'Finishing…'
              : 'It uses your Claude subscription through Claude Code. No API key is involved.';
    // What went wrong: with the code, with the last sign-in, or with the message just sent.
    const trouble = step ? a.signIn.problem : a.failed ? `That did not work: ${a.failed}` : a.state === 'signed-out' ? a.detail : '';
    note.textContent = trouble || '';
    note.hidden = !trouble;

    form.hidden = !(step === 'page' && a.signIn.code);
    signIn.hidden = !!step || missing;
    install.hidden = !missing;
    open.hidden = !(step === 'browser' && a.signIn.canOpen);
    check.hidden = !!step;
    check.disabled = !!a.checking;
    check.textContent = a.checking ? 'Checking…' : 'Check again';
    cancel.hidden = !step || step === 'finishing';
  }

  loui.on('state', draw);
  // Asked when the panel is opened (and once now): the answer is kept for a few minutes.
  const look = () => { if (!document.body.classList.contains('panel-closed')) ask('look'); };
  $('panel-toggle').addEventListener('click', look);
  loui.on('toggle-panel', look);
  look();

  return { draw };
})();
