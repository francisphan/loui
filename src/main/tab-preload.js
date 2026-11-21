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

// And the other: that it has no list of passkeys to offer in a sign-in field
// ("conditional mediation"). Chromium says it has, but the list is drawn by
// the browser around it, and Loui draws none. A sign-in page that believes
// it asks for the list as it loads; that request then waits for a choice
// nobody can make, and while it waits the page's own "Sign in with a
// passkey" button is refused ("A request is already pending"). Seen on
// Amazon. A passkey asked for outright still goes to the system (Windows
// Hello, a security key), as before. A page that asks for the list anyway
// gets a request that waits, as it should, without holding up the next one.
webFrame.executeJavaScript(`(() => {
  if (typeof PublicKeyCredential === 'undefined' || !navigator.credentials) return;
  PublicKeyCredential.isConditionalMediationAvailable = async () => false;
  const caps = PublicKeyCredential.getClientCapabilities;
  if (caps) {
    PublicKeyCredential.getClientCapabilities = async () => (
      { ...(await caps.call(PublicKeyCredential)), conditionalGet: false, conditionalCreate: false, immediateGet: false });
  }
  const own = Object.getPrototypeOf(navigator.credentials);
  const get = own.get, create = own.create;
  const waits = (signal) => new Promise((_, no) => {
    const stop = () => no(signal.reason || new DOMException('The request was aborted.', 'AbortError'));
    if (signal?.aborted) stop(); else signal?.addEventListener('abort', stop, { once: true });
  });
  own.get = function (options) {
    return options?.publicKey && options.mediation === 'conditional' ? waits(options.signal) : get.apply(this, arguments);
  };
  own.create = function (options) {
    return options?.publicKey && options.mediation === 'conditional'
      ? Promise.reject(new DOMException('Not available in this browser.', 'NotAllowedError')) : create.apply(this, arguments);
  };
})()`).catch(() => {});
