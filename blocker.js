// blocker.js — the app's half of the conversation with the root daemon.
//
// The app is unprivileged and no longer owns any state that the block decision
// depends on. It reads a root-owned state.json, which is world readable, and it
// asks for changes over a unix socket. The daemon checks the caller's code
// signature before honouring anything, so a hand-written request is refused.
//
// Before this, unlock_until lived in a file the user owned, and one `echo`
// defeated the entire eye-contact gate with no password.
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { execFile } = require('child_process');

const SYS_DIR = '/Library/Application Support/GazeGate';
const STATE_FILE = path.join(SYS_DIR, 'state.json');
const SYS_DAEMON = path.join(SYS_DIR, 'gazegated');
const VERSION_FILE = path.join(SYS_DIR, 'daemon_version');
const SOCKET = '/var/run/gazegate.sock';
const PLIST_DST = '/Library/LaunchDaemons/com.gazegate.blocker.plist';

// Where state used to live, kept only so an existing install can be carried over
// once. Nothing reads these after the migration.
const LEGACY_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'GazeGate');

// Bump whenever the daemon changes behavior; drives the update prompt.
const DAEMON_VERSION = 4;

const MIN_GATE_SECONDS = 30;
const DEFAULT_GATE_SECONDS = 30;
const MAX_GATE_SECONDS = 600;

// Permanently blocked. The daemon unions these in unconditionally, so removing
// them from the extras list cannot unblock them. Keep in step with gazegated.swift.
const CORE_SITES = [
  'x.com', 'www.x.com', 'twitter.com', 'www.twitter.com',
  'instagram.com', 'www.instagram.com',
  'linkedin.com', 'www.linkedin.com',
];
const isCore = (s) => CORE_SITES.includes(s.trim().toLowerCase());

// ---- Reads. Plain file reads; the state is world readable on purpose. ----

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}

function todayKey() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function readGateSeconds() {
  const v = parseInt(readState().gate_seconds, 10);
  return Number.isFinite(v) ? Math.max(MIN_GATE_SECONDS, v) : DEFAULT_GATE_SECONDS;
}

function readEscalate() { return readState().escalate === true; }

function unlocksToday() {
  const s = readState();
  if (s.unlocks_date !== todayKey()) return 0;
  const v = parseInt(s.unlocks_count, 10);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

// Mirror of the daemon's own sum, so the UI can label a button without a round trip.
function effectiveGateSeconds() {
  const base = readGateSeconds();
  if (!readEscalate()) return base;
  return Math.min(MAX_GATE_SECONDS, base * Math.pow(2, unlocksToday()));
}

function unlockUntil() {
  const v = parseInt(readState().unlock_until, 10);
  return Number.isFinite(v) ? v : 0;
}

function readSundayBlockUntil() {
  const v = parseInt(readState().sunday_block_until, 10);
  return Number.isFinite(v) ? v : 0;
}

function readSites() {
  const list = readState().sites;
  return Array.isArray(list) ? list.filter((s) => !isCore(s)) : [];
}

function secondsRemaining() {
  return Math.max(0, unlockUntil() - Math.floor(Date.now() / 1000));
}

// Mirror of the daemon's decision, for the UI.
function effectiveState() {
  const now = Math.floor(Date.now() / 1000);
  const uu = unlockUntil();
  if (now < uu) return { mode: 'unlocked', remaining: uu - now };
  if (new Date().getDay() === 0) {
    return now < readSundayBlockUntil()
      ? { mode: 'sunday-blocked', remaining: 0 }
      : { mode: 'sunday-open', remaining: 0 };
  }
  return { mode: 'blocked', remaining: 0 };
}

// ---- Writes. Every one of these is a request the daemon may refuse. ----

function request(msg) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(SOCKET);
    let buf = '';
    let settled = false;
    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch {}
      err ? reject(err) : resolve(val);
    };
    sock.setTimeout(5000, () => finish(new Error('daemon did not answer')));
    // A refusal arrives just before the daemon hangs up, so a reply already in
    // the buffer beats the transport error that follows it.
    sock.on('error', (e) => { if (!buf) finish(e); });
    sock.on('connect', () => sock.end(JSON.stringify(msg)));
    sock.on('data', (d) => { buf += d.toString(); });
    sock.on('close', () => {
      if (!buf) return finish(new Error('daemon closed without answering'));
      try {
        const r = JSON.parse(buf);
        if (r && r.ok === false) return finish(new Error(r.error || 'refused'));
        finish(null, r);
      } catch (e) { finish(new Error('bad reply from daemon')); }
    });
  });
}

const unlockFor = (minutes) => request({ cmd: 'unlock', minutes: Math.round(minutes) });
const lockNow = () => request({ cmd: 'lock' });
const setSundayBlockTonight = () => request({ cmd: 'sundayBlock' });
const clearSundayBlock = () => request({ cmd: 'sundayClear' });
const writeEscalate = (on) => request({ cmd: 'setEscalate', on: !!on });

async function writeGateSeconds(n) {
  const want = Math.max(MIN_GATE_SECONDS, Math.round(Number(n) || DEFAULT_GATE_SECONDS));
  const r = await request({ cmd: 'setGateSeconds', seconds: want });
  return r.gate_seconds;
}

async function writeSites(list) {
  const sites = list.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  await request({ cmd: 'setSites', sites });
}

// ---- Install ----

function isInstalled() {
  return fs.existsSync(SYS_DAEMON) && fs.existsSync(PLIST_DST);
}

function installedDaemonVersion() {
  try { return parseInt(fs.readFileSync(VERSION_FILE, 'utf8').trim(), 10) || 0; }
  catch { return fs.existsSync(SYS_DAEMON) ? 3 : 0; } // pre-v4 installs had no marker
}

function needsUpdate() {
  return isInstalled() && installedDaemonVersion() < DAEMON_VERSION;
}

// Anything the previous, user-writable install had, so an upgrade does not reset
// your settings. Only consulted when the daemon has no state of its own yet.
function legacyState() {
  const read = (name, fallback) => {
    try { return fs.readFileSync(path.join(LEGACY_DIR, name), 'utf8').trim(); }
    catch { return fallback; }
  };
  const num = (name, fallback) => {
    const v = parseInt(read(name, ''), 10);
    return Number.isFinite(v) ? v : fallback;
  };
  const [date, count] = read('unlocks_today', '').split(/\s+/);
  return {
    unlock_until: num('unlock_until', 0),
    sunday_block_until: num('sunday_block_until', 0),
    gate_seconds: Math.max(MIN_GATE_SECONDS, num('gate_seconds', DEFAULT_GATE_SECONDS)),
    escalate: read('escalate', '0') === '1',
    unlocks_date: date || '',
    unlocks_count: parseInt(count, 10) || 0,
    sites: read('sites.txt', '').split('\n').map((s) => s.trim().toLowerCase())
      .filter((s) => s && !s.startsWith('#') && !isCore(s)),
  };
}

function ensureUserDir() { /* the daemon owns state now; nothing to seed */ }

function resourcePath(rel) {
  const devPath = path.join(__dirname, rel);
  if (fs.existsSync(devPath)) return devPath;
  return path.join(process.resourcesPath, rel);
}

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
  const binary = resourcePath('daemon/gazegated');
  const plist = fs.readFileSync(resourcePath('scripts/com.gazegate.blocker.plist'), 'utf8');

  // Stage everything the admin step needs, including a seed state built from any
  // previous install, so upgrading does not silently wipe your settings.
  const stage = path.join(os.tmpdir(), 'gazegate-install-' + process.pid);
  fs.mkdirSync(stage, { recursive: true });
  fs.copyFileSync(binary, path.join(stage, 'gazegated'));
  fs.writeFileSync(path.join(stage, 'plist'), plist);
  fs.writeFileSync(path.join(stage, 'seed.json'), JSON.stringify(legacyState(), null, 2));
  fs.writeFileSync(path.join(stage, 'version'), String(DAEMON_VERSION));

  const script = [
    `mkdir -p '${SYS_DIR}'`,
    `launchctl bootout system '${PLIST_DST}' 2>/dev/null || true`,
    `cp '${path.join(stage, 'gazegated')}' '${SYS_DAEMON}'`,
    `chown root:wheel '${SYS_DAEMON}'`,
    `chmod 755 '${SYS_DAEMON}'`,
    // Never clobber state the daemon is already keeping.
    `[ -f '${STATE_FILE}' ] || cp '${path.join(stage, 'seed.json')}' '${STATE_FILE}'`,
    `chown root:wheel '${STATE_FILE}'`,
    `chmod 644 '${STATE_FILE}'`,
    `cp '${path.join(stage, 'version')}' '${VERSION_FILE}'`,
    `chown root:wheel '${VERSION_FILE}'`,
    // The old bash daemon and the files it read are dead weight now, and leaving
    // an inert unlock_until lying around invites confusion about what is trusted.
    `rm -f '${SYS_DIR}/gazegate-daemon.sh'`,
    `cp '${path.join(stage, 'plist')}' '${PLIST_DST}'`,
    `chown root:wheel '${PLIST_DST}'`,
    `chmod 644 '${PLIST_DST}'`,
    `launchctl enable system/com.gazegate.blocker`,
    `launchctl bootstrap system '${PLIST_DST}'`,
  ].join(' && ');

  await runAsAdmin(script);
  try { fs.rmSync(stage, { recursive: true, force: true }); } catch {}

  // Only once the daemon owns the state do the old user-writable files go, so a
  // failed install leaves the previous settings recoverable.
  for (const f of ['unlock_until', 'sunday_block_until', 'gate_seconds', 'escalate', 'unlocks_today', 'sites.txt']) {
    try { fs.rmSync(path.join(LEGACY_DIR, f), { force: true }); } catch {}
  }
}

async function uninstallDaemon() {
  const script = [
    `launchctl bootout system '${PLIST_DST}' 2>/dev/null || true`,
    `rm -f '${PLIST_DST}'`,
    `rm -rf '${SYS_DIR}'`,
    `rm -f '${SOCKET}'`,
    `awk 'BEGIN{s=0} /# GAZEGATE-START/{s=1} s==0{print} /# GAZEGATE-END/{s=0}' /etc/hosts > /tmp/gazegate.hosts && cat /tmp/gazegate.hosts > /etc/hosts && rm -f /tmp/gazegate.hosts`,
    `dscacheutil -flushcache 2>/dev/null || true`,
    `killall -HUP mDNSResponder 2>/dev/null || true`,
  ].join(' && ');
  await runAsAdmin(script);
}

module.exports = {
  CORE_SITES, MIN_GATE_SECONDS, MAX_GATE_SECONDS, STATE_FILE, SOCKET,
  isInstalled, needsUpdate, installDaemon, uninstallDaemon, ensureUserDir,
  unlockFor, lockNow, secondsRemaining, unlockUntil, effectiveState,
  readSites, writeSites,
  readGateSeconds, writeGateSeconds, effectiveGateSeconds,
  readEscalate, writeEscalate, unlocksToday,
  setSundayBlockTonight, clearSundayBlock, readSundayBlockUntil,
};
