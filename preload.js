const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wiki', {
  get: (endpoint) => ipcRenderer.invoke('wiki:get', endpoint)
});
