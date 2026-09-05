const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, systemPreferences, dialog, screen } = require('electron');
const path = require('path');
const blocker = require('./blocker');

const UNLOCK_MINUTES = 10;
const DEV = !!process.env.GAZEGATE_DEV;

let win = null;
let tray = null;
let quitting = false;
// Whether the panel should appear once the renderer paints. False when the
// LaunchAgent started us (login, or a respawn after a crash) — we want the
// menu-bar icon only, no panel in your face.
let pendingShow = !process.argv.includes('--hidden');

// The panel is dismissed on blur, which would otherwise let a stray click kill
// a stare in progress. The renderer flips this while the gate is running.
let gateActive = false;

const PANEL_W = 460;
const PANEL_H = 640;
const PANEL_GAP = 6; // breathing room under the menu bar

function createWindow() {
  win = new BrowserWindow({
    width: PANEL_W,
    height: PANEL_H,
    // A menu-bar panel, not an app window: no chrome, no Dock, floats above
    // everything, and macOS rounds a frameless window's corners for us.
    frame: false,
    resizable: false,
    movable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
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
  // Follow you onto other spaces and over fullscreen apps, like any status item.
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  win.once('ready-to-show', () => { if (pendingShow) showPanel(); });

  // Click anywhere else and the panel goes away. Suppressed mid-stare, and in
  // dev, where opening devtools blurs the window.
  win.on('blur', () => { if (!gateActive && !DEV) hidePanel(); });

  if (DEV) {
    win.webContents.openDevTools({ mode: 'detach' });
    win.webContents.on('console-message', (_e, level, msg) => console.log('[renderer]', msg));
    win.webContents.on('render-process-gone', (_e, d) => console.log('[render-gone]', JSON.stringify(d)));
  }

  // There is no close button on a frameless panel, but ⌘W still routes here.
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      hidePanel();
    }
  });
}

// Park the panel under the tray icon, clamped to the display it lives on.
function positionPanel() {
  if (!tray || !win || win.isDestroyed()) return;
  const t = tray.getBounds();
  const area = screen.getDisplayNearestPoint({ x: t.x, y: t.y }).workArea;
  const x = Math.round(
    Math.min(Math.max(t.x + t.width / 2 - PANEL_W / 2, area.x + 8),
             area.x + area.width - PANEL_W - 8)
  );
  win.setPosition(x, Math.round(t.y + t.height + PANEL_GAP), false);
}

function showPanel(view) {
  if (!win || win.isDestroyed()) createWindow();
  pendingShow = true;
  positionPanel();
  win.show();
  win.focus();
  app.focus({ steal: true });
  if (view) win.webContents.send('navigate', view);
}

function hidePanel() {
  if (win && !win.isDestroyed()) win.hide();
}

function togglePanel() {
  if (win && !win.isDestroyed() && win.isVisible()) hidePanel();
  else showPanel('home');
}

// Never displayed — an LSUIElement app has no menu bar — but AppKit still needs
// a main menu for ⌘X/⌘C/⌘V to work in the sites field. Deliberately carries no
// Quit: the only real exit is the tray's "Quit GazeGate Completely".
function installAppMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'GazeGate',
      submenu: [
        { label: 'Close Panel', accelerator: 'Command+W', click: () => hidePanel() },
        { label: 'Close Panel', accelerator: 'Command+Q', visible: false, click: () => hidePanel() },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
  ]));
}

// Right-click menu. NOT set with setContextMenu — on macOS that hijacks the
// left click too, and the left click has to open the panel.
function trayMenu() {
  const secs = blocker.readGateSeconds();
  return Menu.buildFromTemplate([
    { label: 'Open GazeGate', click: () => showPanel('home') },
    { label: `Unlock (${secs}s eye contact)…`, click: () => showPanel('gate-unlock') },
    { label: 'Lock now', click: () => { blocker.lockNow(); } },
    { type: 'separator' },
    { label: 'Quit GazeGate Completely', click: () => { quitting = true; app.quit(); } },
  ]);
}

function refreshTrayMenu() { /* menu is rebuilt per right-click; nothing to cache */ }

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('GazeGate');
  tray.on('click', () => togglePanel());
  tray.on('right-click', () => tray.popUpContextMenu(trayMenu()));
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

// The in-app Quit button means the same thing as the app menu's Quit: leave the
// Dock, keep the menu-bar icon. Only the tray's "Quit Completely" really exits.
// A stare must not be cancelled by a stray click elsewhere.
ipcMain.handle('set-gate-active', (_e, active) => { gateActive = !!active; return { ok: true }; });

// The in-app Quit button just dismisses the panel, same as clicking away.
ipcMain.handle('close-panel', () => { hidePanel(); return { ok: true }; });

ipcMain.handle('lock-now', () => { blocker.lockNow(); return { ok: true }; });
ipcMain.handle('get-sites', () => blocker.readSites());
ipcMain.handle('set-sites', (_e, list) => { blocker.writeSites(list); return { ok: true }; });

// Only one GazeGate instance may run — a second launch just focuses the first.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) app.quit();
app.on('second-instance', () => showPanel('home'));

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

  app.on('activate', () => showPanel('home'));
});

app.on('window-all-closed', (e) => {
  // Stay alive in the menu bar; do not quit on window close.
});

// Any quit path (menu-bar "Quit GazeGate", ⌘Q, tray, modal) funnels through
// here — allow the window's close handler to actually close instead of hiding.
app.on('before-quit', () => { quitting = true; });
