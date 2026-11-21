// Preload of every tab. A web page gets nothing from it: the one function it
// gives out exists only in the isolated world that Loui's password script
// runs in (src/page/passwords.js), which the page's own JavaScript cannot
// reach. That script reports a sign-in through it, to the main process and
// nowhere else. The main process decides whose reports count (passwords.js).
const { contextBridge, ipcRenderer, webFrame } = require('electron');

const WORLD = 4831; // as in src/main/passwords.js (a sandboxed preload cannot require it)

// (The tab's own page only: this runs in every frame, for what follows.)
if (process.isMainFrame) {
  contextBridge.exposeInIsolatedWorld(WORLD, '__louiReport', (text) => {
    ipcRenderer.send('passwords:report', String(text).slice(0, 4096));
  });
}

// The one thing a page is told differently: that this browser does not play
// HLS streams (.m3u8) by itself. Chromium now says it "maybe" does, and a
// player that believes it hands the stream's address straight to <video>, as
// it would in Safari. Chromium's own HLS player then refuses a stream whose
// parts come from another host than its list unless the page asked for them
// with crossorigin, which such players do not: the video never starts (seen
// on Patreon, whose videos are Mux streams). Told no, a player streams the
// way it does in Chrome, through its own script. A page that sets a stream's
// address on <video> itself still gets Chromium's player, as before.
webFrame.executeJavaScript(`(() => {
  const real = HTMLMediaElement.prototype.canPlayType;
  HTMLMediaElement.prototype.canPlayType = function canPlayType(type) {
    return /mpegurl/i.test(String(type)) ? '' : real.apply(this, arguments);
  };
})()`).catch(() => {});
