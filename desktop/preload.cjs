const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('nte', {
  start: (url, delaySeconds) => ipcRenderer.invoke('nte:start', { url, delaySeconds }), status: () => ipcRenderer.invoke('nte:status'),
  resume: jobId => ipcRenderer.invoke('nte:resume', { jobId }), cancel: jobId => ipcRenderer.invoke('nte:cancel', { jobId }),
  folder: () => ipcRenderer.invoke('nte:folder'),
});
