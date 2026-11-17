// The task manager window's bridge (see taskmanager.js): it hears the reports
// and can ask for a tab to be closed, put to sleep or shown. Nothing else of
// the window chrome's bridge is offered here.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('loui', {
  act(action, id) { ipcRenderer.send('taskmanager:act', { action, id }); },
  close() { ipcRenderer.send('taskmanager:close'); },
  onReport(fn) { ipcRenderer.on('taskmanager', (_e, report) => fn(report)); },
});
