# GazeGate

Blocks distracting sites (x.com, twitter.com, instagram.com, linkedin.com) across
**every browser** — Chrome, Safari, all of them. To unlock them for 10 minutes you
hold **30 seconds of continuous eye contact** with your webcam. Look away and the
timer resets.

Sundays are open by default.

## Install

The app you run is `/Applications/GazeGate.app`. Editing source does nothing on its
own — you have to build and replace the bundle:

```bash
cd ~/GazeGate
npx electron-builder --mac
launchctl bootout gui/$(id -u)/com.gazegate.app
rm -rf /Applications/GazeGate.app
cp -R dist/mac-arm64/GazeGate.app /Applications/GazeGate.app
launchctl enable gui/$(id -u)/com.gazegate.app
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.gazegate.app.plist
```

First launch: click **Install & start blocking**. macOS asks for your admin password
**once**, to install the root blocker.

## How it works

- A root **LaunchDaemon** (`com.gazegate.blocker`) rewrites `/etc/hosts` once a second,
  always, whether or not the app is running. It reads timestamp files and nothing else.
  **Quitting the app does not unblock anything.**
- The app is unprivileged and can never touch `/etc/hosts`. It can only *ask* for an
  unlock by writing a timestamp, and it only does that after you pass the stare
  (MediaPipe FaceLandmarker: iris + head pose + eye direction).
- The design rule: **making it stricter is free, making it looser is gated behind a
  stare.** Locking now, re-arming Sunday, adding a site — all free. Unlocking, editing
  the gate length, uninstalling — all cost eye contact.

### Core sites can't be removed

`CORE_SITES` is hardcoded in both `blocker.js` and `scripts/gazegate-daemon.sh`, and the
daemon unions it in unconditionally. `~/Library/Application Support/GazeGate/sites.txt`
holds **your extras only** — an empty file still blocks the core list.

### The menu bar icon

`~/Library/LaunchAgents/com.gazegate.app.plist` starts the app at login and respawns it
if it crashes or is killed (`KeepAlive: {SuccessfulExit: false}`). It passes `--hidden`
so a login or post-crash start is menu-bar only.

Quit means two different things on purpose:

| Path | Result |
|---|---|
| Top-left menu → Quit, ⌘Q, close button, in-app Quit button | Leaves the Dock, stays in the menu bar. Process alive. |
| Tray right-click → **Quit GazeGate Completely** | Really exits. Stays exited until next login. |

The bundle declares `LSUIElement`, so it starts with no Dock icon and promotes itself
with `app.dock.show()` when you open the window. That promotion is what gives it a Dock
icon and a top-left menu.

None of this is done by cancelling `before-quit` — that event also fires on logout and
restart, and cancelling it would hang a shutdown.

## Honest limits

This is a **commitment device, not security software.** A determined you can open
Terminal and boot out the daemon or edit `/etc/hosts` by hand. The point is friction,
not a vault.

## Tuning the stare

Length is set in the app (Settings → gate seconds, floor of 30, enforced in the main
process). The detection thresholds are constants at the top of `renderer/app.js`:

- `GRACE_MS` — blink/lapse tolerance before reset (default 700)
- `HEAD_YAW_MAX` / `HEAD_PITCH_MAX` — how far you can turn your head (rad)
- `GAZE_MAX` — how far your eyes can drift from the lens
- `BLINK_MAX` — blink sensitivity

The live `yaw / pitch / gaze / blink` readout under the camera helps dial these in.

## Landmines

Things that have already cost time once:

- **The camera needs an entitlement.** The bundle is signed with the hardened runtime, so
  `com.apple.security.device.camera` must be in `build/entitlements.mac.plist` *and*
  `build/entitlements.mac.inherit.plist` (the helper process is what opens the device).
  Without it the stare silently can never pass. This broke the 2026-09-04 build.
- **`launchctl disable` persists across reboots.** A bare `bootstrap` then fails with
  `Bootstrap failed: 5: Input/output error`. Always `launchctl enable` first.
- **Bump `DAEMON_VERSION` in `blocker.js`** whenever `scripts/gazegate-daemon.sh` changes
  behavior, and reinstall the daemon. v2 treated `sites.txt` as the whole list; v3 treats
  it as extras. Assuming v2 semantics left the machine unblocked for half an hour once.
- **Single-instance lock.** A second launch exits 0 silently. If the app "won't start,"
  check whether one is already running before debugging anything else.
- **Running from source hangs** on `askForMediaAccess`, because the dev Electron binary
  isn't a permitted camera client. Test with the packaged app. If you must, set
  `GAZEGATE_DEV=1`.
- **Relaunching by hand after "Quit Completely" leaves launchd out of the loop**, so
  `KeepAlive` won't cover that process until the next login. `launchctl kickstart
  gui/$(id -u)/com.gazegate.app` re-arms it.
- **launchd throttles respawns to ~10s.** When testing crash recovery, wait longer than
  that before concluding it failed.

## Turn it off

Settings → **Turn off blocking completely (uninstall)** (stare + admin password). Or:

```bash
sudo launchctl bootout system /Library/LaunchDaemons/com.gazegate.blocker.plist
sudo rm -f /Library/LaunchDaemons/com.gazegate.blocker.plist
sudo rm -rf "/Library/Application Support/GazeGate"
launchctl bootout gui/$(id -u)/com.gazegate.app
rm -f ~/Library/LaunchAgents/com.gazegate.app.plist
# then remove the GAZEGATE-START..END section from /etc/hosts
```
