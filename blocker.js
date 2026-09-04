// blocker.js — talks to the root daemon by writing user-writable state files,
// and installs/uninstalls the daemon (the only steps that need admin).
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const USER_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'GazeGate');
const UNLOCK_FILE = path.join(USER_DIR, 'unlock_until');
const SUNDAY_FILE = path.join(USER_DIR, 'sunday_block_until');
const SITES_FILE = path.join(USER_DIR, 'sites.txt');
const GATE_FILE = path.join(USER_DIR, 'gate_seconds');

// Bump when scripts/gazegate-daemon.sh changes behavior; drives the update prompt.
const DAEMON_VERSION = 3;

// Floor for the stare. Enforced here, in the trusted main process, rather than
// in the renderer — the renderer only ever asks.
const MIN_GATE_SECONDS = 30;
const DEFAULT_GATE_SECONDS = 30;

const SYS_DIR = '/Library/Application Support/GazeGate';
const SYS_DAEMON = path.join(SYS_DIR, 'gazegate-daemon.sh');
const PLIST_DST = '/Library/LaunchDaemons/com.gazegate.blocker.plist';
const DAEMON_LABEL = 'com.gazegate.blocker';

// Permanently blocked. Not editable from the UI, and the daemon unions these in
// regardless of what sites.txt says — so hand-editing the file can't drop them.
const CORE_SITES = [
  'x.com', 'www.x.com', 'twitter.com', 'www.twitter.com',
  'instagram.com', 'www.instagram.com',
  'linkedin.com', 'www.linkedin.com',
];
const isCore = (s) => CORE_SITES.includes(s.trim().toLowerCase());

function ensureUserDir() {
  fs.mkdirSync(USER_DIR, { recursive: true });
  if (!fs.existsSync(UNLOCK_FILE)) fs.writeFileSync(UNLOCK_FILE, '0');
  if (!fs.existsSync(SUNDAY_FILE)) fs.writeFileSync(SUNDAY_FILE, '0');
  if (!fs.existsSync(GATE_FILE)) fs.writeFileSync(GATE_FILE, String(DEFAULT_GATE_SECONDS));
  // sites.txt now holds *extras only*. Older installs listed the core sites
  // here too; strip them so the settings list doesn't offer to remove them.
  if (!fs.existsSync(SITES_FILE)) fs.writeFileSync(SITES_FILE, '');
  else {
    const extras = rawSites().filter(s => !isCore(s));
    if (extras.length !== rawSites().length) {
      fs.writeFileSync(SITES_FILE, extras.length ? extras.join('\n') + '\n' : '');
    }
  }
}

function rawSites() {
  try {
    return fs.readFileSync(SITES_FILE, 'utf8')
      .split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'));
  } catch { return []; }
}

function readGateSeconds() {
  try {
    const v = parseInt(fs.readFileSync(GATE_FILE, 'utf8').trim(), 10);
    return Number.isFinite(v) ? Math.max(MIN_GATE_SECONDS, v) : DEFAULT_GATE_SECONDS;
  } catch { return DEFAULT_GATE_SECONDS; }
}

function writeGateSeconds(n) {
  ensureUserDir();
  const v = Math.max(MIN_GATE_SECONDS, Math.round(Number(n) || DEFAULT_GATE_SECONDS));
  fs.writeFileSync(GATE_FILE, String(v));
  return v;
}

function isInstalled() {
  return fs.existsSync(SYS_DAEMON) && fs.existsSync(PLIST_DST);
}

function installedDaemonVersion() {
  try {
    const s = fs.readFileSync(SYS_DAEMON, 'utf8');
    const m = s.match(/GAZEGATE_DAEMON_VERSION=(\d+)/);
    return m ? parseInt(m[1], 10) : 1;
  } catch { return 0; }
}

function needsUpdate() {
  return isInstalled() && installedDaemonVersion() < DAEMON_VERSION;
}

// ---- Sunday "re-arm for the rest of today" ----
function readSundayBlockUntil() {
  try {
    const v = parseInt(fs.readFileSync(SUNDAY_FILE, 'utf8').trim(), 10);
    return Number.isFinite(v) ? v : 0;
  } catch { return 0; }
}

function setSundayBlockTonight() {
  ensureUserDir();
  const d = new Date();
  d.setHours(24, 0, 0, 0); // upcoming local midnight
  const epoch = Math.floor(d.getTime() / 1000);
  fs.writeFileSync(SUNDAY_FILE, String(epoch));
  return epoch;
}

function clearSundayBlock() {
  ensureUserDir();
  fs.writeFileSync(SUNDAY_FILE, '0');
}

// Mirror of the daemon's decision, for the UI.
function effectiveState() {
  const now = Math.floor(Date.now() / 1000);
  const uu = unlockUntil();
  if (now < uu) return { mode: 'unlocked', remaining: uu - now };
  const isSunday = new Date().getDay() === 0; // 0 = Sunday in JS
  if (isSunday) {
    return now < readSundayBlockUntil()
      ? { mode: 'sunday-blocked', remaining: 0 }
      : { mode: 'sunday-open', remaining: 0 };
  }
  return { mode: 'blocked', remaining: 0 };
}

// Grant a browsing window: daemon unblocks while now < unlock_until.
function unlockFor(minutes) {
  ensureUserDir();
  const until = Math.floor(Date.now() / 1000) + Math.round(minutes * 60);
  fs.writeFileSync(UNLOCK_FILE, String(until));
  return until;
}

function lockNow() {
  ensureUserDir();
  fs.writeFileSync(UNLOCK_FILE, '0');
}

function unlockUntil() {
  try {
    const v = parseInt(fs.readFileSync(UNLOCK_FILE, 'utf8').trim(), 10);
    return Number.isFinite(v) ? v : 0;
  } catch { return 0; }
}

function secondsRemaining() {
  return Math.max(0, unlockUntil() - Math.floor(Date.now() / 1000));
}

// Extras only — the core list is separate and always applied.
function readSites() {
  return rawSites().filter(s => !isCore(s));
}

function writeSites(list) {
  ensureUserDir();
  const extras = [...new Set(
    list.map(s => s.trim().toLowerCase()).filter(s => s && !s.startsWith('#') && !isCore(s))
  )];
  fs.writeFileSync(SITES_FILE, extras.length ? extras.join('\n') + '\n' : '');
}

function resourcePath(rel) {
  // Works both in dev (__dirname) and packaged (process.resourcesPath).
  const devPath = path.join(__dirname, rel);
  if (fs.existsSync(devPath)) return devPath;
  return path.join(process.resourcesPath, rel);
}

// Run a shell script with one macOS admin prompt.
function runAsAdmin(script) {
  return new Promise((resolve, reject) => {
    const osaScript = `do shell script ${JSON.stringify(script)} with administrator privileges`;
    execFile('/usr/bin/osascript', ['-e', osaScript], (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

async function installDaemon() {
  ensureUserDir();
  lockNow(); // start blocked

  const daemonTemplate = fs.readFileSync(resourcePath('scripts/gazegate-daemon.sh'), 'utf8');
  const daemonResolved = daemonTemplate.replace(/__SUPPORT_DIR__/g, USER_DIR);
  const plist = fs.readFileSync(resourcePath('scripts/com.gazegate.blocker.plist'), 'utf8');

  // Stage resolved files in a temp dir the admin script will copy from.
  const stage = path.join(os.tmpdir(), 'gazegate-install-' + process.pid);
  fs.mkdirSync(stage, { recursive: true });
  fs.writeFileSync(path.join(stage, 'gazegate-daemon.sh'), daemonResolved);
  fs.writeFileSync(path.join(stage, 'plist'), plist);

  const script = [
    `mkdir -p '${SYS_DIR}'`,
    `cp '${path.join(stage, 'gazegate-daemon.sh')}' '${SYS_DAEMON}'`,
    `chown root:wheel '${SYS_DAEMON}'`,
    `chmod 755 '${SYS_DAEMON}'`,
    `cp '${path.join(stage, 'plist')}' '${PLIST_DST}'`,
    `chown root:wheel '${PLIST_DST}'`,
    `chmod 644 '${PLIST_DST}'`,
    `launchctl bootout system '${PLIST_DST}' 2>/dev/null || true`,
    `launchctl bootstrap system '${PLIST_DST}'`,
  ].join(' && ');

  await runAsAdmin(script);
  try { fs.rmSync(stage, { recursive: true, force: true }); } catch {}
}

async function uninstallDaemon() {
  const script = [
    `launchctl bootout system '${PLIST_DST}' 2>/dev/null || true`,
    `rm -f '${PLIST_DST}'`,
    `rm -rf '${SYS_DIR}'`,
    // Strip any lingering block section from /etc/hosts.
    `awk 'BEGIN{s=0} /# GAZEGATE-START/{s=1} s==0{print} /# GAZEGATE-END/{s=0}' /etc/hosts > /tmp/gazegate.hosts && cat /tmp/gazegate.hosts > /etc/hosts && rm -f /tmp/gazegate.hosts`,
    `dscacheutil -flushcache 2>/dev/null || true`,
    `killall -HUP mDNSResponder 2>/dev/null || true`,
  ].join(' && ');
  await runAsAdmin(script);
}

module.exports = {
  USER_DIR, CORE_SITES, MIN_GATE_SECONDS,
  isInstalled, needsUpdate, installDaemon, uninstallDaemon,
  unlockFor, lockNow, secondsRemaining, unlockUntil,
  readSites, writeSites, ensureUserDir,
  readGateSeconds, writeGateSeconds,
  setSundayBlockTonight, clearSundayBlock, readSundayBlockUntil, effectiveState,
};
