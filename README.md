# GazeGate

A macOS commitment device. It blocks distracting sites in every browser, and the only way
to unlock them is to hold continuous eye contact with your webcam for thirty seconds.

Look away and the timer resets. Earn the unlock and you get ten minutes.

## What it blocks

x.com, twitter.com, instagram.com and linkedin.com are permanently blocked and cannot be
removed from inside the app. You can add your own domains on top of those.

Sundays are open by default. You can close them again for the rest of the day if you want.

## How you use it

GazeGate lives in the menu bar and nowhere else. There is no Dock icon and no ordinary app
window.

Click the icon and a panel drops down underneath it. Click anywhere else and the panel goes
away. Right click the icon for a short menu with the real quit in it.

The panel shows whether you are blocked or unlocked, how much unlock time is left, a dial
of the hours you tend to reach for it, and your current run of clean days. Click the stats
and you get the full history.

To unlock, press Unlock and stare into the lens until the ring fills. To lock back up
early, press Lock now, which is free, because making things stricter always is.

## The one rule the whole thing follows

Making it stricter is free. Making it looser costs a stare.

Locking early, blocking your Sunday, adding a site and turning on the rising price are all
one click. Unlocking, shortening the stare, reopening a Sunday, turning off the rising
price and uninstalling all cost eye contact first.

## Rising price, off by default

Turn it on in Settings and every unlock doubles what the next one costs that day. Thirty
seconds, then sixty, then a hundred and twenty, capped at ten minutes, reset at midnight.

Turning it on is free. Turning it off costs one stare at whatever the price currently is.

## Install

You need a Mac with Apple silicon, Node, and about five minutes.

```bash
git clone https://github.com/evanjolley/gazegate.git
cd gazegate
npm install
npx electron-builder --mac
cp -R dist/mac-arm64/GazeGate.app /Applications/GazeGate.app
open -a /Applications/GazeGate.app
```

On first launch press Install and start blocking. macOS asks for your admin password once,
so the root blocker can be installed. That is the only time it asks.

Grant camera access when prompted. Without it the stare can never pass.

### Keeping the icon there

```bash
cp scripts/com.gazegate.app.plist ~/Library/LaunchAgents/
launchctl enable gui/$(id -u)/com.gazegate.app
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.gazegate.app.plist
```

That starts GazeGate at login and brings it back if it ever crashes or gets killed. It does
not bring it back after you deliberately quit, which is the point.

## How it actually works

A root LaunchDaemon called `com.gazegate.blocker` rewrites `/etc/hosts` once a second,
forever, whether or not the app is running. It reads two timestamp files and nothing else.
Quitting the app does not unblock anything.

The app runs unprivileged and can never touch `/etc/hosts`. All it can do is write a
timestamp asking for an unlock, and it only does that once you have passed the stare. Gaze
detection is MediaPipe FaceLandmarker, using iris position, head pose and eye direction.

The permanently blocked list is hardcoded in both `blocker.js` and the daemon script, and
the daemon unions it in unconditionally. Emptying `sites.txt` by hand does not unblock
those sites.

### Where things live

| Thing | Path |
|---|---|
| The app you run | `/Applications/GazeGate.app` |
| Your state, unlock and settings | `~/Library/Application Support/GazeGate` |
| Root daemon and its log | `/Library/Application Support/GazeGate` |
| Daemon job | `/Library/LaunchDaemons/com.gazegate.blocker.plist` |
| Menu bar job | `~/Library/LaunchAgents/com.gazegate.app.plist` |

### History

Every block and unblock the daemon has ever applied is timestamped in `daemon.log`, which
is where all the stats come from. Nothing is tracked anywhere else and nothing leaves your
machine.

Stretches longer than a normal unlock window are treated as the blocker having been off
rather than as unlocks, and are reported separately, so a day when the tool was broken does
not get counted against you.

Sundays and days the blocker was off are skipped when counting clean-day streaks. They
neither extend a streak nor break one.

## Honest limits

This is a commitment device, not security software.

The unlock timestamp lives in a file you own and can write. One line in a terminal defeats
the entire gate, with no password. Everything else here is careful, and that is still true,
so treat the friction as the product rather than the enforcement.

A determined version of you can also boot out the daemon or edit `/etc/hosts` by hand. The
point is to make the easy path the disciplined one, not to build a vault.

## Building on it

```
main.js       menu bar panel, tray, window lifecycle
blocker.js    state files, daemon install, the rising price
stats.js      parses daemon.log into history
preload.js    the IPC surface exposed to the renderer
renderer/     the panel UI
scripts/      the root daemon and both launchd jobs
```

Editing source does nothing on its own. The app you run is the one in `/Applications`, so
every change needs a rebuild and a bundle replace.

### Tuning the stare

Length is set in Settings, with a floor of thirty seconds enforced in the main process
rather than the renderer. Detection thresholds are constants at the top of
`renderer/app.js`.

| Constant | Meaning |
|---|---|
| `GRACE_MS` | blink tolerance before progress resets |
| `HEAD_YAW_MAX` | how far you can turn left or right |
| `HEAD_PITCH_MAX` | how far you can tilt up or down |
| `GAZE_MAX` | how far your eyes can drift from the lens |
| `BLINK_MAX` | blink sensitivity |

The live readout under the camera helps you dial these in.

### Things that have already cost time once

The bundle is signed with the hardened runtime, so `com.apple.security.device.camera` has
to be in both entitlement files. The helper process is what opens the capture device. Miss
it and the stare silently never passes.

`launchctl disable` survives reboots, so a bare `bootstrap` fails with an input output
error. Always `launchctl enable` first.

Bump `DAEMON_VERSION` in `blocker.js` whenever the daemon script changes behavior, then
reinstall it.

Only one instance may run. A second launch exits quietly, so check whether it is already
running before debugging a launch that seems to do nothing.

Running from source hangs on the camera permission request, because the development
Electron binary is not a permitted camera client. Test with the packaged app.

launchd throttles respawns to about ten seconds, so wait longer than that before deciding
crash recovery is broken.

## Turning it off

Settings, then Turn off blocking completely. It needs a stare and your admin password.

By hand, if you must.

```bash
sudo launchctl bootout system /Library/LaunchDaemons/com.gazegate.blocker.plist
sudo rm -f /Library/LaunchDaemons/com.gazegate.blocker.plist
sudo rm -rf "/Library/Application Support/GazeGate"
launchctl bootout gui/$(id -u)/com.gazegate.app
rm -f ~/Library/LaunchAgents/com.gazegate.app.plist
```

Then delete the GAZEGATE block from `/etc/hosts`.

## License

MIT
