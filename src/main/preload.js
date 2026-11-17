// The only bridge between the window chrome and the main process. Web pages
// in tabs never get this: tab views have no preload.
const { contextBridge, ipcRenderer } = require('electron');

const SEND = new Set([
  'layout', 'tab:new', 'tab:select', 'tab:close', 'tab:menu', 'tab:move', 'tab:pin', 'tabs:layout', 'go', 'back', 'forward', 'reload',
  'devtools', 'pick:start', 'pick:cancel', 'pick:remove', 'pause', 'handoff:answer',
  'group:close', 'device:menu', 'relay:set', 'update:install', 'chat:send', 'chat:stop', 'chat:reset',
  'find', 'find:open', 'find:close',
  'download:act', 'download:ask', 'download:clear',
  'permission:answer', 'permission:forget',
  'suggest:query', 'suggest:show', 'suggest:hide', 'suggest:pick', 'history:list', 'history:remove', 'history:clear',
  'shields:menu', 'shields:set',
  'print', 'print:save-pdf', 'search:set', 'brave:open', 'brave:add', 'brave:remove',
  'bookmarks', 'passwords', 'reader:toggle',
  'prompt:answer', 'consent:revoke',
  'activity',
  'pip:open',
]);
const LISTEN = new Set([
  'state', 'feed', 'chat', 'focus-address', 'toggle-panel', 'show-relay', 'focus-find', 'toggle-downloads',
  'show-permissions', 'suggestions', 'suggest', 'suggest:pick', 'history', 'history:changed', 'show-history',
  'show-settings',
  'bookmarks', 'passwords',
  'activity', 'show-activity',
]);

contextBridge.exposeInMainWorld('loui', {
  send(channel, arg) {
    if (SEND.has(channel)) ipcRenderer.send(channel, arg);
  },
  on(channel, fn) {
    if (LISTEN.has(channel)) ipcRenderer.on(channel, (_e, payload) => fn(payload));
  },
});
