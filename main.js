const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, systemPreferences, dialog } = require('electron');
const path = require('path');
const blocker = require('./blocker');

const UNLOCK_MINUTES = 10;
const DEV = !!process.env.GAZEGATE_DEV;

let win = null;
let tray = null;
let quitting = false;
// Whether the window should appear once the renderer paints. False when macOS
// launched us at login — we want the menu-bar icon only, no window in your face.
let pendingShow = true;

function createWindow() {
  win = new BrowserWindow({
    width: 460,
    height: 640,
    resizable: false,
    fullscreenable: false,
    title: 'GazeGate',
    backgroundColor: '#0f1115', // solid surface up front — avoids the macOS blank-window bug
    show: false, // wait for the first paint before revealing (see ready-to-show)
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // keep rendering while hidden so re-show isn't blank
    },
  });
  win.loadFile('renderer/index.html');

  // Reveal once painted, unless we booted at login — then stay in the menu bar
  // until the user actually asks for the window.
  win.once('ready-to-show', () => { if (pendingShow) revealWindow(); });

  if (DEV) {
    win.webContents.openDevTools({ mode: 'detach' });
    win.webContents.on('console-message', (_e, level, msg) => console.log('[renderer]', msg));
    win.webContents.on('render-process-gone', (_e, d) => console.log('[render-gone]', JSON.stringify(d)));
  }

  // Closing the window hides it (stay resident in the menu bar).
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
}

function revealWindow() {
  if (!win || win.isDestroyed()) return;
  pendingShow = true;
  win.show();
  win.focus();
  app.focus({ steal: true });
}

function showWindow(view) {
  if (!win || win.isDestroyed()) createWindow();
  revealWindow();
  if (view) win.webContents.send('navigate', view);
}

function refreshTrayMenu() {
  if (!tray) return;
  const secs = blocker.readGateSeconds();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open GazeGate', click: () => showWindow('home') },
    { label: `Unlock (${secs}s eye contact)…`, click: () => showWindow('gate-unlock') },
    { label: 'Lock now', click: () => { blocker.lockNow(); } },
    { type: 'separator' },
    { label: 'Quit GazeGate', click: () => { quitting = true; app.quit(); } },
  ]));
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('GazeGate');
  refreshTrayMenu();
  tray.on('click', () => showWindow('home'));
}

// ---- IPC ----
ipcMain.handle('is-dev', () => DEV);

ipcMain.handle('get-status', () => {
  const st = blocker.effectiveState();
  return {
    installed: blocker.isInstalled(),
    needsUpdate: blocker.needsUpdate(),
    mode: st.mode,                 // blocked | unlocked | sunday-open | sunday-blocked
    remaining: st.remaining,
    unlockMinutes: UNLOCK_MINUTES,
    isSunday: new Date().getDay() === 0,
    sites: blocker.readSites(),
    coreSites: blocker.CORE_SITES,
    gateSeconds: blocker.readGateSeconds(),
    minGateSeconds: blocker.MIN_GATE_SECONDS,
  };
});

ipcMain.handle('get-core-sites', () => blocker.CORE_SITES);
ipcMain.handle('get-gate-seconds', () => blocker.readGateSeconds());
ipcMain.handle('set-gate-seconds', (_e, n) => {
  const v = blocker.writeGateSeconds(n);
  refreshTrayMenu();
  return { ok: true, gateSeconds: v };
});

ipcMain.handle('sunday-block', () => { blocker.setSundayBlockTonight(); return { ok: true }; });
ipcMain.handle('sunday-clear', () => { blocker.clearSundayBlock(); return { ok: true }; });

ipcMain.handle('install-daemon', async () => {
  try {
    await blocker.installDaemon();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle('gate-passed', async (_e, purpose) => {
  switch (purpose) {
    case 'unlock': {
      const until = blocker.unlockFor(UNLOCK_MINUTES);
      return { ok: true, remaining: Math.max(0, until - Math.floor(Date.now() / 1000)) };
    }
    case 'settings':
      return { ok: true };
    case 'quit':
      quitting = true;
      setTimeout(() => app.quit(), 150);
      return { ok: true };
    case 'uninstall':
      try {
        await blocker.uninstallDaemon();
        quitting = true;
        setTimeout(() => app.quit(), 150);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e.message || e) };
      }
    default:
      return { ok: false, error: 'unknown purpose' };
  }
});

ipcMain.handle('lock-now', () => { blocker.lockNow(); return { ok: true }; });
ipcMain.handle('get-sites', () => blocker.readSites());
ipcMain.handle('set-sites', (_e, list) => { blocker.writeSites(list); return { ok: true }; });

// Only one GazeGate instance may run — a second launch just focuses the first.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) app.quit();
app.on('second-instance', () => showWindow('home'));

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return;
  blocker.ensureUserDir();

  // Menu-bar-only: no Dock icon, no ⌘-Tab entry. The tray is the whole UI.
  if (app.dock) app.dock.hide();

  // Keep the icon pinned across restarts. Skipped in dev, where the executable
  // is node_modules' Electron binary and registering it would be noise.
  if (!DEV) {
    try {
      app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });
      pendingShow = !app.getLoginItemSettings().wasOpenedAtLogin;
    } catch {}
  }

  // Allow camera access for the gate.
  if (systemPreferences.askForMediaAccess) {
    try { await systemPreferences.askForMediaAccess('camera'); } catch {}
  }
  const ses = require('electron').session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media'));

  createTray();
  createWindow(); // ready-to-show reveals it once painted

  app.on('activate', () => showWindow('home'));
});

app.on('window-all-closed', (e) => {
  // Stay alive in the menu bar; do not quit on window close.
});

// Any quit path (menu-bar "Quit GazeGate", ⌘Q, tray, modal) funnels through
// here — allow the window's close handler to actually close instead of hiding.
app.on('before-quit', () => { quitting = true; });
