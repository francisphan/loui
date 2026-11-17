// Small pieces of the window chrome that belong to no panel: the question
// before the last private window closes with tabs lent from it, the "Not
// secure" mark beside the address bar, and Reset beside an emulated device's
// name. All state comes from the main process. Uses $ from ui.js.
(() => {
  // ── closing the last private window while a session holds its tabs ──────
  // Those tabs are private: they cannot outlive their last private window,
  // so they would close under the session (see openWindow in main.js).
  const ask = $('close-ask');
  let asking = false;
  function drawCloseAsk(c) {
    ask.hidden = !c;
    if (!c) { asking = false; return; }
    const who = c.who.length === 1 ? c.who[0] : 'Claude sessions';
    $('close-ask-text').textContent = c.tabs === 1
      ? `Closing this window also closes the private tab you lent to ${who}: a private tab can't stay open without a private window.`
      : `Closing this window also closes the ${c.tabs} private tabs you lent to ${who}: private tabs can't stay open without a private window.`;
    if (!asking) $('close-ask-no').focus();
    asking = true;
  }
  $('close-ask-no').onclick = () => loui.send('window:close-answer', false);
  $('close-ask-yes').onclick = () => loui.send('window:close-answer', true);
  ask.onkeydown = (e) => { if (e.key === 'Escape') loui.send('window:close-answer', false); };

  // ── a page opened despite its certificate ───────────────────────────────
  const insecure = $('insecure-label');

  // ── an emulated device ──────────────────────────────────────────────────
  // Claude can set one (set_viewport) and it stays on the tab: Reset puts the
  // page back at the full window, without the menu.
  $('device-reset').onclick = () => loui.send('device:reset');

  loui.on('state', (next) => {
    drawCloseAsk(next.window?.closing || null);
    insecure.hidden = !next.insecure;
    insecure.title = next.insecure
      ? `You opened ${next.insecure} although its certificate could not be verified. Loui accepts it until you quit.`
      : '';
    const tab = next.tabs.find((t) => t.active);
    $('device-reset').hidden = !tab?.device;
  });
})();
