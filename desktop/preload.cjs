const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('nte', {
  start: url => ipcRenderer.invoke('nte:start', { url }), status: () => ipcRenderer.invoke('nte:status'),
  resume: jobId => ipcRenderer.invoke('nte:resume', { jobId }), cancel: jobId => ipcRenderer.invoke('nte:cancel', { jobId }),
  folder: () => ipcRenderer.invoke('nte:folder'),
});
