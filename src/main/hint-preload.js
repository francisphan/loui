// The bridge of the view Loui draws its notes in (see hints.js): it hears what
// to show. It can send nothing, and nothing else of the window chrome's
// bridge is offered here.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('loui', {
  on(channel, fn) {
    if (channel === 'hint') ipcRenderer.on('hint', (_e, payload) => fn(payload));
  },
});
