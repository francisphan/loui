// The only bridge between the window chrome and the main process. Web pages
// in tabs never get this: tab views have no preload.
const { contextBridge, ipcRenderer } = require('electron');

const SEND = new Set([
  'layout', 'tab:new', 'tab:select', 'tab:close', 'tab:menu', 'go', 'back', 'forward', 'reload',
  'devtools', 'pick:start', 'pick:cancel', 'pick:remove', 'pause', 'handoff:answer',
  'group:close', 'device:menu', 'relay:set', 'chat:send', 'chat:stop', 'chat:reset',
]);
const LISTEN = new Set(['state', 'feed', 'chat', 'focus-address', 'toggle-panel', 'show-relay']);

contextBridge.exposeInMainWorld('loui', {
  send(channel, arg) {
    if (SEND.has(channel)) ipcRenderer.send(channel, arg);
  },
  on(channel, fn) {
    if (LISTEN.has(channel)) ipcRenderer.on(channel, (_e, payload) => fn(payload));
  },
});
