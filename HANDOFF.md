# GazeGate — handoff

Scratch file for continuing work in a fresh session. Delete when done.
Written 2026-09-05. Everything below was verified, not assumed.

## What GazeGate is

A macOS commitment device. A **root LaunchDaemon** (`com.gazegate.blocker`) rewrites
`/etc/hosts` once a second to block x/twitter/instagram/linkedin. An **Electron menu-bar
app** earns you a 10-minute unlock by making you hold continuous webcam eye contact
(MediaPipe FaceLandmarker). The app can never edit `/etc/hosts` itself — it only writes
timestamp files the daemon reads. Sundays are open by default.

Design rule the codebase already follows, keep applying it: **making it stricter is free,
making it looser is gated behind a stare.**

## Where things live

| Thing | Path |
|---|---|
| Source (git repo, local only, no remote) | `~/GazeGate` |
| **The app the user actually runs** | `/Applications/GazeGate.app` |
| Build output | `~/GazeGate/dist/mac-arm64/GazeGate.app` |
| User state (unlock/sunday/sites/gate_seconds) | `~/Library/Application Support/GazeGate` |
| Root daemon + log | `/Library/Application Support/GazeGate` |
| Daemon plist | `/Library/LaunchDaemons/com.gazegate.blocker.plist` |
| Backup of the pre-2026-09-04 app | `~/backup-GazeGate.app-20260904-161757` |

**Editing source does nothing on its own.** To ship a change:

```bash
cd ~/GazeGate && npx electron-builder --mac
# quit the running app, then:
cp -R dist/mac-arm64/GazeGate.app /Applications/GazeGate.app
open -a /Applications/GazeGate.app
```

## Current state (verified 2026-09-05)

- Git: 2 commits. `c30b7a4` baseline, `b0c11ff` the menu-bar/icon/bugfix/features work. Clean tree.
- Daemon: **v3**, loaded, blocking confirmed (`x.com` → `0.0.0.0`).
- `sites.txt` is **empty** and everything still blocks — that is correct, see v3 semantics below.
- Login item registered for GazeGate.
- The app was **not running** at time of writing, so there was no menu bar icon. That is the open task.

## THE OPEN TASK: make the menu bar icon always visible

The user wants the head icon in the menu bar "regardless of if the application is open or not."

**Key point to convey to them if it comes up:** a macOS menu bar icon cannot exist without a
running process. The icon *is* the app. So "always visible" necessarily means "the app process
is always running." There's no way around that.

Today it launches at login (`app.setLoginItemSettings` in `main.js`), but if the user quits —
and **Quit is ungated by their explicit choice** — the icon is gone until next login. That's the
gap.

### Recommended fix: a user LaunchAgent with KeepAlive

GUI apps must run in the user session, so this is a **LaunchAgent**, not a LaunchDaemon. Do not
put it in `/Library/LaunchDaemons` next to the blocker.

Create `~/Library/LaunchAgents/com.gazegate.app.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.gazegate.app</string>
    <key>ProgramArguments</key>
    <array><string>/Applications/GazeGate.app/Contents/MacOS/GazeGate</string></array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
```

Load it with (no admin password needed — this is the user domain):

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.gazegate.app.plist
```

### Two decisions to put to the user before building it

1. **`KeepAlive: true` makes the ungated Quit meaningless** — quitting respawns the app in about
   a second. They deliberately chose to leave Quit ungated in the previous session. Options:
   - `KeepAlive: true` — truly always on, Quit becomes a no-op. Matches "always visible" literally.
   - `KeepAlive: {SuccessfulExit: false}` — respawns only on crash, so a deliberate Quit still
     works. Preserves their earlier choice but doesn't literally satisfy "always visible."

   Ask which they want. Do not assume.

2. **The LaunchAgent duplicates `setLoginItemSettings`.** Both would launch it at login. The
   single-instance lock in `main.js` means the second one just exits, so it isn't broken, but it's
   redundant. If the LaunchAgent goes in, consider removing the `setLoginItemSettings` call from
   `main.js:~176` and deleting the existing login item, so there's one mechanism, not two.

## Landmines — read before touching anything

- **`launchctl disable` persists across reboots.** That's how the blocker got turned off before.
  A bare `launchctl bootstrap` then fails with `Bootstrap failed: 5: Input/output error`. You must
  `launchctl enable system/com.gazegate.blocker` **first**, then bootstrap.

- **Daemon v3 semantics.** `CORE_SITES` is hardcoded in `scripts/gazegate-daemon.sh` and unioned
  in unconditionally; `sites.txt` holds **user extras only**. In v2 the core list was merely a
  fallback for a *missing* `sites.txt`, so an empty-but-present file blocked nothing. That footgun
  bit us once already and left the user unblocked for ~30 minutes. If you change site handling,
  bump `DAEMON_VERSION` in `blocker.js` and reinstall the daemon, and never assume v2 behavior.

- **Installing a daemon needs an admin prompt** via `osascript ... with administrator privileges`.
  `blocker.installDaemon()` does this from the app. Doing it by hand means staging the resolved
  script to a temp dir and copying from there — see `blocker.js` for the exact command list.

- **Screen recording is denied to the terminal**, so `screencapture` fails with "could not create
  image from display". You cannot visually verify the menu bar or the window. Ask the user to look,
  and be honest that you haven't seen it.

- **Running from source hangs.** `./node_modules/.bin/electron .` blocks on
  `systemPreferences.askForMediaAccess('camera')` because the dev binary isn't a permitted camera
  client. Test with the packaged app instead.

- **Running from source without `GAZEGATE_DEV=1` registers a stray "Electron" login item**, because
  the `if (!DEV)` guard around `setLoginItemSettings` doesn't fire. One was created and removed
  during the last session. If you must run from source, set `GAZEGATE_DEV=1`.

- **The single-instance lock** means a second launch silently exits code 0 with no output. If the
  app "won't start," check whether `/Applications/GazeGate.app` is already running before debugging
  anything else.

- Rebuilding changes the ad-hoc signature, so macOS may **re-prompt for camera permission** on the
  first unlock after an install.

## Known-open, not yet done

- **`/etc/hosts` line 9 is corrupt**: reads `::1  localhost33336` instead of `::1  localhost`. It
  predates all of this work. Breaks IPv6 localhost resolution and can cause slow local dev. The
  user was told twice and hasn't asked for a fix — offer, don't just do it.
- **README is stale.** Says 60 seconds (code has been 30 since before this work) and describes the
  old freely-editable sites list rather than locked core + extras. User was asked, hasn't answered.
- `~/backup-GazeGate.app-20260904-161757` can be deleted once they're satisfied.
- No app icon (`.icns`) is set — the bundle uses the default Electron icon. Low value since
  `LSUIElement` means no Dock presence, but it shows in Finder.

## User preferences that apply here

- Push back when the reasoning doesn't hold; they want a thinking partner, not agreement.
- Report honestly what was and wasn't verified. Don't claim visual confirmation you can't have.
