// The command palette's bridge (see palette.js): it can ask for results, choose
// one of the rows it was given, and close. Nothing else of the window chrome's
// bridge is offered here.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('palette', {
  query: (text) => ipcRenderer.invoke('palette:query', String(text)),
  choose: (key) => ipcRenderer.send('palette:choose', key),
  close: () => ipcRenderer.send('palette:close'),
  onOpen: (fn) => ipcRenderer.on('palette:open', (_e, how) => fn(how)),
});
