// visits.js — how long you actually spend on the sites you unlocked.
//
// The stats the app already had answer "how often did you stare at the camera".
// They cannot answer "was it worth it", because nothing was watching what you
// did with the ten minutes. This does, and only that: it runs while an unlock
// window is open, it records time on the blocked sites, and it records nothing
// else. A host that is not on the blocklist is dropped before it is ever
// written down, so there is no general browsing log to leak or to regret.
//
// It lives entirely in user space. It never talks to the daemon, it never
// influences the block decision, and it writes only inside userData — the
// root-owned /Library/Application Support/GazeGate is the daemon's and stays
// that way. Turning this off costs nothing, because a tracker inside the
// daemon's trust boundary would be a worse trade than the accountability is
// worth.
//
// The frontmost app is read with lsappinfo, which needs no permission at all.
// Only once that says a supported browser is in front do we send it an Apple
// event for the URL, so a browser sitting in the background is never asked
// anything, and the Automation prompt only appears when it is actually earned.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { app, powerMonitor, shell } = require('electron');
const blocker = require('./blocker');

// Every unlock is the same length; escalation raises the price of the stare,
// never the length of the window. Only used to reconstruct the start of a window
// we were not around for. main.js owns the number and passes it to init(), because
// restating it here is a bug that waits for the day the window becomes editable.
let unlockMinutes = 10;

// Three seconds is short enough that a quick look at a feed still registers and
// long enough that two osascript calls a poll are free next to a browser.
const POLL_MS = 3000;

// A visit survives a gap this long before it is closed. A tab switch to check a
// calendar, a jump to Messages and back, a reply in Slack — the same courtesy
// the eye-contact gate extends to a blink. Twenty seconds is long enough to
// cover a glance and short enough that leaving and coming back later reads as
// two visits, which is what it was.
const GAP_MS = 20000;

// The clock stops after two minutes without input. It has to be generous,
// because watching a video is real attention that produces no keystrokes, and
// it has to exist, because a feed left open while you make coffee is not.
const IDLE_SECONDS = 120;

// Retry a browser that refused an Apple event this often, so granting the
// permission in System Settings heals the tracker without an app restart.
const PERMISSION_RETRY_MS = 5 * 60 * 1000;

// How many records the history view is handed. The file is append-only and
// grows for years; the panel only ever draws the recent end of it.
const READ_LIMIT = 2000;

// Bundle ids rather than names, because that is what lsappinfo reports and it
// is the one identifier a renamed or relocated app cannot change. The script is
// the smallest question that gets a URL out of each browser.
const BROWSERS = {
  'com.google.Chrome':        { name: 'Google Chrome', proc: 'Google Chrome', script: 'tell application "Google Chrome" to get URL of active tab of front window' },
  'com.google.Chrome.beta':   { name: 'Google Chrome Beta', proc: 'Google Chrome Beta', script: 'tell application "Google Chrome Beta" to get URL of active tab of front window' },
  'com.google.Chrome.canary': { name: 'Google Chrome Canary', proc: 'Google Chrome Canary', script: 'tell application "Google Chrome Canary" to get URL of active tab of front window' },
  'com.brave.Browser':        { name: 'Brave Browser', proc: 'Brave Browser', script: 'tell application "Brave Browser" to get URL of active tab of front window' },
  'com.microsoft.edgemac':    { name: 'Microsoft Edge', proc: 'Microsoft Edge', script: 'tell application "Microsoft Edge" to get URL of active tab of front window' },
  'com.apple.Safari':         { name: 'Safari', proc: 'Safari', script: 'tell application "Safari" to get URL of front document' },
  'com.apple.SafariTechnologyPreview': { name: 'Safari Technology Preview', proc: 'Safari Technology Preview', script: 'tell application "Safari Technology Preview" to get URL of front document' },
};

let timer = null;
let inFlight = false;          // one osascript at a time, so a stalled browser cannot pile up
let sawLockedTick = false;     // have we ever observed this Mac not being unlocked?
let win = null;                // the unlock window being watched
let cur = null;                // the visit in flight
let denied = new Map();        // bundle id -> when it last refused an Apple event
let clockStopped = false;      // system sleep or a locked screen
let st = { state: 'idle', message: '' };
let lastBrowserCheck = 0;
let anyBrowserRunning = true;  // assumed until a check says otherwise

const nowSec = () => Math.floor(Date.now() / 1000);

function setState(state, message = '') {
  st = { state, message };
}

// ---- the log ----

function logFile() {
  return path.join(app.getPath('userData'), 'visits.jsonl');
}

// Append-only, always. Nothing rewrites this file, so a crash mid-write can cost
// the tail of one line and never the history behind it — which is exactly why
// the reader below skips lines it cannot parse instead of giving up on the file.
function write(rec) {
  try { fs.appendFileSync(logFile(), JSON.stringify(rec) + '\n'); }
  catch { /* a lost record is not worth taking the app down for */ }
}

function read(limit = READ_LIMIT) {
  let text;
  try { text = fs.readFileSync(logFile(), 'utf8'); } catch { return []; }
  const out = [];
  const lines = text.split('\n');
  // Newest first, and we stop as soon as we have enough, so age costs nothing.
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const rec = JSON.parse(line);
      if (rec && typeof rec === 'object' && rec.type) out.push(rec);
    } catch { /* truncated tail or a half-written line; skip it */ }
  }
  return out;
}

// ---- matching ----

// The core list carries both bare and www. forms; the blocklist the daemon
// enforces is a set of hosts, but what we want to report is the entry you would
// recognise. Normalising both sides collapses that to one name per site.
function siteList() {
  const seen = new Set();
  for (const s of [...blocker.CORE_SITES, ...blocker.readSites()]) {
    const norm = String(s).trim().toLowerCase().replace(/^www\./, '');
    if (norm) seen.add(norm);
  }
  return [...seen];
}

function hostOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.hostname.toLowerCase().replace(/\.$/, '');
  } catch { return null; }
}

// A host matches a site if it is that site or a subdomain of it. Longest match
// wins, so an extra you added for a specific subdomain beats its parent. Nothing
// that fails this is recorded, or even kept in memory — this is the privacy
// boundary, not a filter applied later.
function matchSite(host, sites) {
  let best = null;
  for (const site of sites) {
    if (host === site || host.endsWith('.' + site)) {
      if (!best || site.length > best.length) best = site;
    }
  }
  return best;
}

// ---- asking the system what is in front ----

function run(bin, args) {
  return new Promise((resolve) => {
    // No timeout on purpose for osascript: the first Apple event to a browser
    // raises the Automation prompt and the call sits there until you answer it.
    // Killing it would teach TCC nothing and we would just prompt again.
    execFile(bin, args, { timeout: 0 }, (err, stdout, stderr) => {
      resolve({ err, out: String(stdout || '').trim(), errText: String(stderr || '').trim() });
    });
  });
}

// lsappinfo is a plain Launch Services query. It needs no Automation permission,
// which is the whole point: it is what lets us avoid speaking to a browser that
// is not in front of you.
async function frontmostBundleId() {
  const asn = await run('/usr/bin/lsappinfo', ['front']);
  if (asn.err || !asn.out) return null;
  const info = await run('/usr/bin/lsappinfo', ['info', '-only', 'bundleid', asn.out]);
  if (info.err) return null;
  const m = /"CFBundleIdentifier"="([^"]+)"/.exec(info.out);
  return m ? m[1] : null;
}

// Only ever called with a browser that lsappinfo just said is frontmost.
async function activeUrl(id, browser) {
  const r = await run('/usr/bin/osascript', ['-e', browser.script]);
  if (!r.err) {
    denied.delete(id);
    return { url: r.out };
  }
  const text = r.errText || String(r.err.message || '');
  // -1743 is errAEEventNotPermitted: the Automation checkbox is off, or you
  // said no to the prompt. It is the one failure the UI has to surface, because
  // everything downstream of it looks exactly like "you used nothing".
  if (/-1743|not authorized|not allowed assistive/i.test(text)) {
    denied.set(id, Date.now());
    return { denied: true };
  }
  // -1728 (no front window), -600 (quit between the two calls) and friends are
  // ordinary. There is simply nothing on screen to record.
  return {};
}

// Consulted only when the frontmost app is not a browser, and only every so
// often, to tell "you are working in your editor" apart from "there is no
// browser here at all" without running pgrep every three seconds.
function browserRunning() {
  if (Date.now() - lastBrowserCheck < 15000) return anyBrowserRunning;
  lastBrowserCheck = Date.now();
  anyBrowserRunning = false;
  for (const b of Object.values(BROWSERS)) {
    try {
      require('child_process').execFileSync('/usr/bin/pgrep', ['-x', b.proc], { stdio: 'ignore' });
      anyBrowserRunning = true;
      break;
    } catch { /* pgrep exits non-zero when nothing matches */ }
  }
  return anyBrowserRunning;
}

// ---- visits ----

function openVisit(site, host, at) {
  cur = { site, host, startMs: at, lastSeenMs: at, seconds: 0, idlePaid: false };
}

function closeVisit() {
  if (!cur) return;
  const seconds = Math.round(cur.seconds);
  // A visit that never survived a second poll is a tab you passed through.
  if (seconds >= 1 && win) {
    write({
      type: 'visit',
      unlock_start: win.unlockStart,
      site: cur.site,
      host: cur.host,
      start: Math.floor(cur.startMs / 1000),
      end: Math.floor(cur.lastSeenMs / 1000),
      seconds,
    });
    win.used += seconds;
    if (!win.firstSite) win.firstSite = cur.site;
  }
  cur = null;
}

// ---- unlock windows ----

function beginWindow(unlockUntil) {
  // We know the true start only if we watched the flip. Starting up in the
  // middle of an unlock leaves us reconstructing it from the fixed window
  // length, which is close enough to join on and wrong enough to flag.
  const partial = !sawLockedTick;
  win = {
    unlockStart: partial ? unlockUntil - unlockMinutes * 60 : nowSec(),
    unlockUntil,
    used: 0,
    firstSite: null,
    partial,
  };
}

function endWindow(endedAt) {
  if (!win) return;
  closeVisit();
  write({
    type: 'window',
    unlock_start: win.unlockStart,
    // An early Lock now ends the window before its time; sleeping through the
    // expiry ends it exactly on time, however late we noticed.
    unlock_end: Math.min(endedAt, win.unlockUntil),
    granted_seconds: Math.max(0, win.unlockUntil - win.unlockStart),
    used_seconds: win.used,
    first_site: win.firstSite,
    partial: win.partial,
  });
  win = null;
}

// ---- the poll ----

async function tick() {
  if (inFlight) return;

  const state = blocker.effectiveState();
  if (state.mode !== 'unlocked') {
    // Rule one: zero work outside an unlock window. Not a single subprocess.
    sawLockedTick = true;
    if (win) endWindow(nowSec());
    if (st.state !== 'idle') setState('idle');
    return;
  }

  const unlockUntil = blocker.unlockUntil();
  if (win && win.unlockUntil !== unlockUntil) {
    // A whole window ended and another began while we were asleep. Close the old
    // one on its own terms; the new one was not watched from the start.
    endWindow(win.unlockUntil);
    sawLockedTick = false;
  }
  if (!win) beginWindow(unlockUntil);

  // Nothing accrues while the Mac is asleep or the screen is locked. Display
  // sleep raises no Electron event, so idle time is what catches that one — and
  // it is also what catches you walking away with the feed still up.
  const idle = powerMonitor.getSystemIdleTime();
  if (clockStopped || idle >= IDLE_SECONDS) {
    if (cur && !cur.idlePaid) {
      // We banked the last two minutes before we could know they were idle.
      // Pay them back, and move the visit's end to where the attention stopped.
      cur.seconds = Math.max(0, cur.seconds - idle);
      cur.lastSeenMs = Math.max(cur.startMs, cur.lastSeenMs - idle * 1000);
      cur.idlePaid = true;
    }
    // The gap clock keeps running, so a long absence still closes the visit.
    if (cur && Date.now() - cur.lastSeenMs >= GAP_MS) closeVisit();
    // A stopped clock is not news, but a denied permission still is, so it is
    // not quietly overwritten by the fact that you walked away.
    if (st.state !== 'no-permission') setState('ok');
    return;
  }

  inFlight = true;
  let seen = null;
  try {
    const id = await frontmostBundleId();
    const browser = id ? BROWSERS[id] : null;

    if (browser) {
      const refusedAt = denied.get(id);
      if (refusedAt && Date.now() - refusedAt < PERMISSION_RETRY_MS) {
        setState('no-permission', `GazeGate cannot read ${browser.name}'s address bar.`);
      } else {
        const r = await activeUrl(id, browser);
        if (r.denied) {
          setState('no-permission', `GazeGate cannot read ${browser.name}'s address bar.`);
        } else {
          setState('ok');
          const host = r.url ? hostOf(r.url) : null;
          const site = host ? matchSite(host, siteList()) : null;
          if (site) seen = { site, host };
        }
      }
    } else if (!browserRunning()) {
      setState('no-browser', 'No supported browser is running.');
    } else if (st.state !== 'no-permission') {
      setState('ok');
    }
  } catch (e) {
    setState('error', String(e && e.message ? e.message : e));
  } finally {
    inFlight = false;
  }

  const now = Date.now();
  if (cur && seen && (seen.site !== cur.site || seen.host !== cur.host)) {
    // Another blocked site is in front. That is not a gap, it is a new visit.
    closeVisit();
  }
  if (cur && !seen && now - cur.lastSeenMs >= GAP_MS) closeVisit();

  if (seen) {
    if (!cur) openVisit(seen.site, seen.host, now);
    else {
      // Only credit the interval if the previous poll saw this same site too.
      // A longer delta means a gap we tolerated or a stalled tick, and neither
      // is attention. This is also the cap that stops a wake-up from paying out
      // however long the Mac was asleep.
      const delta = now - cur.lastSeenMs;
      if (delta <= POLL_MS * 2) cur.seconds += delta / 1000;
      cur.lastSeenMs = now;
      cur.idlePaid = false;
    }
  }
}

// ---- lifecycle ----

function init(opts = {}) {
  if (Number.isFinite(opts.unlockMinutes)) unlockMinutes = opts.unlockMinutes;
  if (process.platform !== 'darwin') return;
  if (timer) return;
  powerMonitor.on('suspend', () => { clockStopped = true; });
  powerMonitor.on('lock-screen', () => { clockStopped = true; });
  powerMonitor.on('resume', () => { clockStopped = false; });
  powerMonitor.on('unlock-screen', () => { clockStopped = false; });
  // One loop for the whole feature. It costs a state.json read per tick outside
  // an unlock window and nothing else.
  timer = setInterval(() => { tick().catch(() => {}); }, POLL_MS);
  tick().catch(() => {});
}

// Called when main.js already knows the state just changed, so the start and end
// of a window are recorded to the second instead of up to a poll late.
function nudge() {
  if (timer) tick().catch(() => {});
}

// A normal quit should not cost you the visit you were in the middle of. The
// window record is deliberately not written here: a window that has not ended
// has no end, and the next launch will finish it — flagged partial, because by
// then it will be true — rather than leaving two records under one key.
function flush() {
  closeVisit();
  if (timer) { clearInterval(timer); timer = null; }
}

function status() { return { ...st }; }

// The Automation pane, which is where a denied browser is un-denied. Same URL on
// macOS 26 as it has been since System Settings replaced System Preferences.
function openAutomationSettings() {
  if (process.platform !== 'darwin') return { ok: false };
  shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Automation');
  return { ok: true };
}

module.exports = {
  init, nudge, flush, status, read, openAutomationSettings,
  // Exported for testing without an Electron app around them.
  _matchSite: matchSite, _hostOf: hostOf,
};
