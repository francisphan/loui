// The suggestion list's bridge (see suggest.js): it hears what to draw and
// reports a click on a row. Nothing else of the window chrome's bridge is
// offered here.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('loui', {
  send(channel, arg) {
    if (channel === 'suggest:pick') ipcRenderer.send('suggest:pick', arg);
  },
  on(channel, fn) {
    if (channel === 'suggest') ipcRenderer.on('suggest', (_e, payload) => fn(payload));
  },
});
