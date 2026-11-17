// The bridge for the hidden page that turns speech into text
// (src/ui/voice-page.js). It can only take sound from the main process and
// hand text back.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('host', {
  send: (msg) => ipcRenderer.send('voice-page', msg),
  on: (fn) => ipcRenderer.on('voice-page', (_e, msg) => fn(msg)),
});
