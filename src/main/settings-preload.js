// The Settings window's bridge (see settings-window.js): it hears what the
// settings are, asks for one to be changed, and can close itself. Nothing of
// the window chrome's bridge is offered here, and no other page has this one.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('loui', {
  // Resolves with the settings as they stand once it is done.
  act(what, arg) { return ipcRenderer.invoke('settings:act', String(what), arg); },
  close() { ipcRenderer.send('settings:close'); },
  onState(fn) { ipcRenderer.on('settings:state', (_e, state) => fn(state)); },
  onShow(fn) { ipcRenderer.on('settings:show', (_e, section) => fn(section)); },
});
