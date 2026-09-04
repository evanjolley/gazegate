# GazeGate

Blocks distracting sites (x.com, instagram.com, linkedin.com by default) across **every browser** — Chrome, Safari, all of them. To unlock them for 10 minutes, you hold **60 seconds of continuous eye contact** with your webcam. Look away and the timer resets.

## Run it

Double-click **`GazeGate.command`** in Finder, or in Terminal:

```bash
cd ~/GazeGate
npm start
```

First launch:
1. Click **Install & start blocking** — macOS asks for your admin password **once** to install the background blocker (a root LaunchDaemon that owns `/etc/hosts`).
2. The sites are now blocked in every browser.
3. To unlock: click **Unlock**, look into your camera for 60 continuous seconds.

## How it works

- A root **LaunchDaemon** (`com.gazegate.blocker`) runs always, even when the app is closed. It watches a timestamp file and keeps `/etc/hosts` blocked unless you're inside an unlock window. **Quitting the app does not unblock anything.**
- The app (unprivileged) can only *ask* for an unlock by writing a timestamp — and it only does that after you pass the 60-second gaze gate (Google MediaPipe FaceLandmarker: iris + head-pose + eye-direction).
- Changing the blocked sites, and quitting the app, are gated behind the same 60-second stare.

## Honest limits

This is a **commitment device, not security software.** A determined you can still open Terminal and run `sudo launchctl bootout system /Library/LaunchDaemons/com.gazegate.blocker.plist` or edit `/etc/hosts` by hand. The point is friction, not a locked vault.

## Tuning the gaze gate

If it feels too strict or too loose, edit the thresholds at the top of `renderer/app.js`:

- `REQUIRED_MS` — how long you must hold (default 60000)
- `GRACE_MS` — blink/lapse tolerance before reset (default 700)
- `HEAD_YAW_MAX` / `HEAD_PITCH_MAX` — how far you can turn your head
- `GAZE_MAX` — how far your eyes can drift from the lens
- `BLINK_MAX` — blink sensitivity

The live `yaw / pitch / gaze / blink` readout under the camera helps you dial these in.

## Turn it off

Settings → **Turn off blocking completely (uninstall)** (requires the gaze gate + admin password). Or manually:

```bash
sudo launchctl bootout system /Library/LaunchDaemons/com.gazegate.blocker.plist
sudo rm -f /Library/LaunchDaemons/com.gazegate.blocker.plist
sudo rm -rf "/Library/Application Support/GazeGate"
# then remove the block section from /etc/hosts if present
```
