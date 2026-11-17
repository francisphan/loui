// The small window's bridge (see pip.js): it hears pictures and the session's
// status, reports the size of its picture area, and can ask to take over, let
// Claude continue, show the tab, or close. Nothing else of the window
// chrome's bridge is offered here.
const { contextBridge, ipcRenderer } = require('electron');

const ACTIONS = new Set(['take-over', 'continue', 'show', 'close']);

contextBridge.exposeInMainWorld('loui', {
  act(action) { if (ACTIONS.has(action)) ipcRenderer.send('pip:act', action); },
  size(width, height) { ipcRenderer.send('pip:size', { width, height }); },
  onFrame(fn) { ipcRenderer.on('pip:frame', (_e, url) => fn(url)); },
  onUpdate(fn) { ipcRenderer.on('pip:update', (_e, state) => fn(state)); },
});
