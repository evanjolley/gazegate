const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gazegate', {
  getStatus: () => ipcRenderer.invoke('get-status'),
  installDaemon: () => ipcRenderer.invoke('install-daemon'),
  updateDaemon: () => ipcRenderer.invoke('install-daemon'),
  gatePassed: (purpose) => ipcRenderer.invoke('gate-passed', purpose),
  closePanel: () => ipcRenderer.invoke('close-panel'),
  setGateActive: (active) => ipcRenderer.invoke('set-gate-active', active),
  lockNow: () => ipcRenderer.invoke('lock-now'),
  sundayBlock: () => ipcRenderer.invoke('sunday-block'),
  sundayClear: () => ipcRenderer.invoke('sunday-clear'),
  getSites: () => ipcRenderer.invoke('get-sites'),
  setSites: (list) => ipcRenderer.invoke('set-sites', list),
  onNavigate: (cb) => ipcRenderer.on('navigate', (_e, view) => cb(view)),
  isDev: () => ipcRenderer.invoke('is-dev'),
  getGateSeconds: () => ipcRenderer.invoke('get-gate-seconds'),
  setGateSeconds: (n) => ipcRenderer.invoke('set-gate-seconds', n),
  setEscalate: (on) => ipcRenderer.invoke('set-escalate', on),
  getCoreSites: () => ipcRenderer.invoke('get-core-sites'),
  getStats: () => ipcRenderer.invoke('get-stats'),
});
