'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ds', {
  appInfo: () => ipcRenderer.invoke('app:info'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  startChat: (req) => ipcRenderer.invoke('chat:start', req),
  cancelChat: (id) => ipcRenderer.send('chat:cancel', id),
  onDelta: (cb) => ipcRenderer.on('chat:delta', (_e, payload) => cb(payload)),
  onDone: (cb) => ipcRenderer.on('chat:done', (_e, payload) => cb(payload)),
  onError: (cb) => ipcRenderer.on('chat:error', (_e, payload) => cb(payload)),
  onPermissionAsk: (cb) => ipcRenderer.on('permission:ask', (_e, payload) => cb(payload)),
  permissionRespond: (resp) => ipcRenderer.invoke('permission:respond', resp),
  workspacePick: () => ipcRenderer.invoke('workspace:pick'),
  mcpList: () => ipcRenderer.invoke('mcp:list'),
  mcpAdd: (cfg) => ipcRenderer.invoke('mcp:add', cfg),
  mcpRemove: (name) => ipcRenderer.invoke('mcp:remove', name),
  mcpTest: (cfg) => ipcRenderer.invoke('mcp:test', cfg),
  mcpSetToolTrust: (payload) => ipcRenderer.invoke('mcp:setToolTrust', payload),
  windowPin: (pin) => ipcRenderer.invoke('window:pin', pin),
  fileReadText: (filePath) => ipcRenderer.invoke('file:readText', filePath),
  fileWriteText: (payload) => ipcRenderer.invoke('file:writeText', payload),
  onFocusInput: (cb) => ipcRenderer.on('app:focus-input', () => cb()),
  log: (level, msg) => ipcRenderer.send('app:log', { level, msg }),
  speechSpeak: (text) => ipcRenderer.invoke('speech:speak', text),
  speechStop: () => ipcRenderer.invoke('speech:stop'),
  toHarness: (payload) => ipcRenderer.invoke('dsh:toHarness', payload),
  fsListDir: (p) => ipcRenderer.invoke('fs:listDir', p),
  fsPreview: (p) => ipcRenderer.invoke('fs:preview', p),
  exportSave: (opts) => ipcRenderer.invoke('export:save', opts),
});
