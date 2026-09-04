const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, systemPreferences, dialog } = require('electron');
const path = require('path');
const blocker = require('./blocker');

const UNLOCK_MINUTES = 10;
const DEV = !!process.env.GAZEGATE_DEV;

let win = null;
let tray = null;
let quitting = false;

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

  // Reveal only once the renderer has painted its first frame — otherwise the
  // window appears blank until some later event forces a repaint.
  win.once('ready-to-show', () => revealWindow());

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

// Force the compositor to actually repaint. A 1px resize is the one workaround
// that reliably beats the macOS "window stays blank until a stray paint event"
// bug; the window is fixed-size, so we flip resizable just for the nudge.
function nudgeRepaint() {
  if (!win || win.isDestroyed()) return;
  const [w, h] = win.getSize();
  const wasResizable = win.isResizable();
  if (!wasResizable) win.setResizable(true);
  win.setSize(w, h + 1);
  win.setSize(w, h);
  if (!wasResizable) win.setResizable(false);
  win.webContents.invalidate();
}

// Bring the window forward and force it to actually paint.
function revealWindow() {
  if (!win) return;
  win.show();
  win.focus();
  app.focus({ steal: true });
  nudgeRepaint();
}

function showWindow(view) {
  if (!win) createWindow();
  revealWindow();
  if (view) win.webContents.send('navigate', view);
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('GazeGate');
  const menu = Menu.buildFromTemplate([
    { label: 'Open GazeGate', click: () => showWindow('home') },
    { label: 'Unlock (30s eye contact)…', click: () => showWindow('gate-unlock') },
    { label: 'Lock now', click: () => { blocker.lockNow(); } },
    { type: 'separator' },
    { label: 'Quit GazeGate', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => showWindow('home'));
}

// ---- IPC ----
// The renderer fires this once it has painted its first view — force a repaint
// so fixed content shows without needing a manual click on the tray icon.
ipcMain.on('renderer-ready', () => { if (win && win.isVisible()) nudgeRepaint(); });

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
  };
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
