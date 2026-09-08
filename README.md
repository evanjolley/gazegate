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

That is the Blocker tab, and everything else in this README is about it. There are two
more. Focus is a pomodoro timer and Sound is a library of loops. Neither can change what
is blocked, and neither talks to the daemon.

## The one rule the whole thing follows

Making it stricter is free. Making it looser costs a stare.

Locking early, blocking your Sunday, adding a site and turning on the rising price are all
one click. Unlocking, shortening the stare, reopening a Sunday, turning off the rising
price and uninstalling all cost eye contact first.

## Rising price, off by default

Turn it on in Settings and every unlock doubles what the next one costs that day. Thirty
seconds, then sixty, then a hundred and twenty, capped at ten minutes, reset at midnight.

Turning it on is free. Turning it off costs one stare at whatever the price currently is.

## Focus timer

Twenty five minutes of focus, five of break, fifteen after every fourth block. All four
numbers are editable, and a new length applies to the next block rather than the one
already running.

Intervals do not roll into each other. When one ends you get a chime and a notification,
and the next one waits until you press start, so nothing counts down while you are away
from the desk.

The countdown lives in the main process rather than the panel, because the panel hides
itself the moment you click away, and a timer that only exists inside a hidden window is a
timer you cannot trust. Time left comes from an end timestamp instead of a tally of ticks,
so sleeping the Mac mid block gives you a finished timer rather than a paused one.

While a block runs, the menu bar drops the eye and shows the countdown on its own.

The chime is any macOS system sound, picked in the tab, with a test button beside it.

## Sound

Six loops and a slot for one of your own.

Rain, ocean and stream are CC0 field recordings from Wikimedia Commons, credited by author
and source in `assets/sounds/CREDITS.md`. Wind, brown noise and white noise are generated
by ffmpeg, wind because no wind recording with a license clean enough to redistribute
exists there.

`scripts/build-sounds.py` rebuilds the library from its sources, so the audio here is
reproducible rather than a pile of binaries you have to take on faith. Each track is cut
into a seamless loop by overlapping the material that follows the loop body onto its head
with an equal power crossfade. They are Ogg Opus rather than MP3, because MP3 carries
encoder padding that puts a silent gap at every loop point. All of them sit at minus twenty
LUFS, so switching between them does not jump.

Playback is Web Audio in the renderer, the only thing here that loops a buffer without a
seam. The panel hides rather than closes, so a loop keeps running after you click away, and
the tray offers to stop it without reopening the panel.

Drop a file named `home` into `~/Library/Application Support/GazeGate/sounds` and it turns
up in the list with no rebuild. Ogg, Opus, MP3, M4A, AAC, WAV and FLAC all work. That
folder overrides any track by name, not just home, so a real recording replaces the
synthesized wind the same way.

A decoded track is large, roughly seventy megabytes of PCM for a three minute one, so only
the playing track and the one before it are held in memory.

## Install

You need a Mac with Apple silicon, Node, the Xcode command line tools for `swiftc`, and
about five minutes.

```bash
git clone https://github.com/evanjolley/gazegate.git
cd gazegate
npm install
npm run dist
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

A root LaunchDaemon called `com.gazegate.blocker` runs `gazegated`, a small Swift binary
that rewrites `/etc/hosts` once a second, forever, whether or not the app is running.
Quitting the app does not unblock anything.

The daemon owns every piece of state the block decision depends on. It keeps that state in
a root owned `state.json` that you cannot write. The app reads it freely and asks for
changes over a unix socket at `/var/run/gazegate.sock`.

Anyone may connect to that socket, but being allowed to speak is not being allowed to act.
For each connection the daemon reads the peer's audit token with `LOCAL_PEERTOKEN`,
resolves it to a code object with `SecCodeCopyGuestWithAttributes`, and checks it with
`SecCodeCheckValidity` against this requirement.

```
identifier "com.gazegate.app" and anchor apple generic
  and certificate leaf[subject.OU] = "3ZWQQ4J23W"
```

If the caller is not genuinely GazeGate, the request is refused and logged. The audit token
is used rather than the process id, because ids can be recycled between the check and the
act.

So the app can only ask for an unlock, and it only asks once you have passed the stare.
Gaze detection is MediaPipe FaceLandmarker, using iris position, head pose and eye
direction.

The permanently blocked list is hardcoded in both `blocker.js` and `gazegated.swift`, and
the daemon unions it in unconditionally. Nothing you can do from outside the app unblocks
those sites.

### Where things live

| Thing | Path |
|---|---|
| The app you run | `/Applications/GazeGate.app` |
| Daemon binary, state and log | `/Library/Application Support/GazeGate` |
| All state, root owned, world readable | `/Library/Application Support/GazeGate/state.json` |
| Request socket | `/var/run/gazegate.sock` |
| Daemon job | `/Library/LaunchDaemons/com.gazegate.blocker.plist` |
| Menu bar job | `~/Library/LaunchAgents/com.gazegate.app.plist` |
| Timer and sound settings | `~/Library/Application Support/GazeGate` |
| Your own sound files | `~/Library/Application Support/GazeGate/sounds` |
| What you did with your unlocks | `~/Library/Application Support/GazeGate/visits.jsonl` |

Nothing under your home directory affects blocking. The timer and the sound library keep
their settings there, and neither of them can reach the daemon. Older versions kept the unlock
timestamp in `~/Library/Application Support/GazeGate`, and the installer migrates those
values once and then deletes them.

### History

Every block and unblock the daemon has ever applied is timestamped in `daemon.log`, which
is where the block history comes from. What you do with an unlock once you have earned it is
recorded separately, described below. Nothing leaves your machine.

Stretches longer than a normal unlock window are treated as the blocker having been off
rather than as unlocks, and are reported separately, so a day when the tool was broken does
not get counted against you.

Sundays and days the blocker was off are skipped when counting clean-day streaks. They
neither extend a streak nor break one.

### What the unlock buys

Knowing you unlocked ten minutes tells you nothing about whether you needed them. So while
an unlock is running, GazeGate records how long you actually spend on the sites you just
paid a stare for.

It watches the front browser and nothing else. Every three seconds it asks Launch Services
which app is frontmost, and only when that is a browser you are actually looking at does it
ask that browser for its address. A browser sitting behind another window is never asked.
Time only accrues while the display is awake and you are not idle, so a tab left open
overnight is worth nothing.

A host that does not match your blocklist is discarded before anything is written. This is a
record of the four sites you asked to be walled off from, not a log of your browsing, and the
matching happens before the write rather than after so there is no moment where the rest of
it exists on disk.

The numbers live in `visits.jsonl` next to the timer and sound settings, in your home
directory, where nothing can reach the daemon. The daemon neither knows nor cares that any of
this exists.

The one that matters is on the home panel. Ten minutes bought against four minutes spent.
Raw minutes only tell you how much and a top site only tells you where, and neither of those
is about the trade you made.

The app has to be running to see any of it. An unlock that started before the app did is
marked partial and kept out of every average, because a window we only watched half of would
otherwise read as a short one.

Your first unlock after installing this will ask permission to read the browser's address.
Refusing it costs you the numbers and nothing else.

## Honest limits

This is a commitment device, not security software.

Faking an unlock now costs you root. You can still `sudo launchctl bootout` the daemon, or
edit `/etc/hosts` by hand, or delete the whole thing. That is deliberate. The goal is to
make the disciplined path cheaper than the escape, not to build a vault you cannot leave.

One residual gap is worth naming. The requirement is pinned to the bundle identifier and
the signing team, not to an exact binary hash. You hold that signing certificate, so you
could modify the app, resign it, and it would still be trusted. Pinning to a hash would
close that and would also break the daemon on every rebuild until it was reinstalled. For
a tool you are pointing at yourself, rebuilding and resigning an app at eleven at night is
friction enough.

## Building on it

```
daemon/       gazegated.swift, the root daemon and its socket
main.js       menu bar panel, tray, window lifecycle
blocker.js    reads root state, asks the daemon for changes, installs it
pomodoro.js   the focus timer, which keeps its own clock
noise.js      finds sound files and hands their bytes to the renderer
visits.js     watches the front browser while an unlock runs
stats.js      parses daemon.log and visits.jsonl into history
preload.js    the IPC surface exposed to the renderer
renderer/     the panel UI
assets/sounds the loop library and its credits
scripts/      both launchd jobs, and the sound build
```

`npm run build:daemon` compiles the daemon on its own. `npm run dist` does that and then
packages the app, which carries the compiled binary in its Resources and copies it into
place during install.

There is a diagnostic that proves the socket and the signature check end to end without
needing a stare.

```bash
/Applications/GazeGate.app/Contents/MacOS/GazeGate --selftest
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

MP3 padding puts a silent gap at every loop point, which is why the sound library is Ogg
Opus. Rerunning `scripts/build-sounds.py` re-encodes every track, so all of them show up as
modified in git even when nothing about them changed.

The daemon refuses anything it cannot attribute to a correctly signed GazeGate. If you
change the bundle identifier or sign with a different team, update `REQUIREMENT` in
`gazegated.swift` or the app will lock itself out of its own daemon. `GAZEGATE_REQUIREMENT`,
`GAZEGATE_STATE_DIR`, `GAZEGATE_HOSTS` and `GAZEGATE_SOCKET` override the defaults, which is
how the daemon can be exercised without root.

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
