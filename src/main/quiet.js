// A tab brought back with its history (the tabs of the last session, a tab
// woken from sleep) does not start playing by itself. A video that was on
// when Loui closed would otherwise start again on launch, behind whatever
// the user came to do. Media in such a page stays paused until the user does
// something in the page (pressing play is enough); pages he opens himself
// play as they always did.
//
// Run in the page and each of its frames. navigator.userActivation tells a
// press or key in the page, by the user or by Claude, from the page's own start.
const HOLD = `(() => {
  if (window.__louiQuiet) return;
  window.__louiQuiet = true;
  const hold = (m) => { if (m && m.pause && !navigator.userActivation.hasBeenActive) m.pause(); };
  document.addEventListener('play', (e) => hold(e.target), true);
  for (const m of document.querySelectorAll('video,audio')) hold(m);
})()`;

function createQuiet({ tabs }) {
  tabs.on('created', (tab) => {
    const wc = tab.wc;
    if (!tab.quiet) return; // set by tabs.open() for a page loaded from kept history
    const run = () => {
      if (!tab.quiet || wc.isDestroyed()) return;
      for (const frame of wc.mainFrame.framesInSubtree) frame.executeJavaScript(HOLD).catch(() => {});
    };
    wc.on('dom-ready', run);
    wc.on('did-frame-finish-load', run);
    // Only the page that was brought back: the next one he goes to plays as usual.
    let loaded = false;
    wc.on('did-finish-load', () => { loaded = true; });
    wc.on('did-start-navigation', (e) => { if (loaded && e.isMainFrame && !e.isSameDocument) tab.quiet = false; });
  });
}

module.exports = { createQuiet };
