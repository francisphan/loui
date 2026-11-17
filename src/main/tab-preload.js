// Preload of every tab. A web page gets nothing from it: the one function it
// gives out exists only in the isolated world that Loui's password script
// runs in (src/page/passwords.js), which the page's own JavaScript cannot
// reach. That script reports a sign-in through it, to the main process and
// nowhere else. The main process decides whose reports count (passwords.js).
const { contextBridge, ipcRenderer } = require('electron');

const WORLD = 4831; // as in src/main/passwords.js (a sandboxed preload cannot require it)

contextBridge.exposeInIsolatedWorld(WORLD, '__louiReport', (text) => {
  ipcRenderer.send('passwords:report', String(text).slice(0, 4096));
});
