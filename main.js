const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, systemPreferences, dialog } = require('electron');
const path = require('path');
const blocker = require('./blocker');

const UNLOCK_MINUTES = 10;
const DEV = !!process.env.GAZEGATE_DEV;

let win = null;
let tray = null;
let quitting = false;
// Whether the window should appear once the renderer paints. False when the
// LaunchAgent started us (login, or a respawn after a crash) — we want the
// menu-bar icon only, no window in your face.
let pendingShow = !process.argv.includes('--hidden');

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
    { label: `Quit GazeGate (${secs}s eye contact)\u2026`, click: () => showWindow('gate-quit') },
  ]));
}

// The default Electron menu carries a ⌘Q that quits without the stare, which
// would make the gated tray Quit pointless. Replace it with an Edit-only menu:
// clipboard shortcuts keep working in the sites field, ⌘Q does nothing. This is
// deliberately NOT done by cancelling 'before-quit' — that fires on logout and
// restart too, and blocking it would hang a shutdown.
function installAppMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
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

  // Launch-at-login and crash recovery are owned by the LaunchAgent
  // (~/Library/LaunchAgents/com.gazegate.app.plist), not by this process.
  // setLoginItemSettings used to live here; it registered whichever bundle
  // happened to be running, which is how the login item ended up pointing at
  // a build inside dist/ instead of /Applications. One mechanism, not two.

  // Allow camera access for the gate.
  if (systemPreferences.askForMediaAccess) {
    try { await systemPreferences.askForMediaAccess('camera'); } catch {}
  }
  const ses = require('electron').session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media'));

  installAppMenu();
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
