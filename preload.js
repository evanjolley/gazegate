const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gazegate', {
  getStatus: () => ipcRenderer.invoke('get-status'),
  installDaemon: () => ipcRenderer.invoke('install-daemon'),
  updateDaemon: () => ipcRenderer.invoke('install-daemon'),
  gatePassed: (purpose) => ipcRenderer.invoke('gate-passed', purpose),
  lockNow: () => ipcRenderer.invoke('lock-now'),
  sundayBlock: () => ipcRenderer.invoke('sunday-block'),
  sundayClear: () => ipcRenderer.invoke('sunday-clear'),
  getSites: () => ipcRenderer.invoke('get-sites'),
  setSites: (list) => ipcRenderer.invoke('set-sites', list),
  onNavigate: (cb) => ipcRenderer.on('navigate', (_e, view) => cb(view)),
  notifyReady: () => ipcRenderer.send('renderer-ready'),
  isDev: () => ipcRenderer.invoke('is-dev'),
});
