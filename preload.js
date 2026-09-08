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

  // Focus timer. Read-only from the renderer's point of view — the countdown
  // itself lives in the main process and is pushed here.
  pomoGet: () => ipcRenderer.invoke('pomo-get'),
  pomoStart: () => ipcRenderer.invoke('pomo-start'),
  pomoPause: () => ipcRenderer.invoke('pomo-pause'),
  pomoReset: () => ipcRenderer.invoke('pomo-reset'),
  pomoSetConfig: (patch) => ipcRenderer.invoke('pomo-set-config', patch),
  pomoSounds: () => ipcRenderer.invoke('pomo-sounds'),
  pomoTestSound: (name) => ipcRenderer.invoke('pomo-test-sound', name),
  onPomodoro: (cb) => ipcRenderer.on('pomodoro', (_e, s) => cb(s)),

  // Sound library. The main process finds the files and reads them; the
  // renderer decodes and loops them, because only Web Audio loops gaplessly.
  noiseList: () => ipcRenderer.invoke('noise-list'),
  noiseRead: (id) => ipcRenderer.invoke('noise-read', id),
  noiseConfig: () => ipcRenderer.invoke('noise-config'),
  noiseSetConfig: (patch) => ipcRenderer.invoke('noise-set-config', patch),
  noisePlaying: (id) => ipcRenderer.invoke('noise-playing', id),
  noiseFolder: () => ipcRenderer.invoke('noise-folder'),
  onNoiseStop: (cb) => ipcRenderer.on('noise-stop', () => cb()),

  // Time spent on the sites you unlocked. The tracker is in the main process
  // because the panel is not open for most of an unlock window.
  getVisitStatus: () => ipcRenderer.invoke('get-visit-status'),
  getVisits: () => ipcRenderer.invoke('get-visits'),
  openAutomationSettings: () => ipcRenderer.invoke('open-automation-settings'),
});
