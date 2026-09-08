// pomodoro.js — the focus timer, which deliberately knows nothing about the
// blocker. Nothing in here can unlock a site, touch /etc/hosts, or talk to the
// daemon. It counts down, it chimes, and it tells the tray what to say.
//
// The timer lives in the main process on purpose. The panel hides itself on
// blur, and a countdown that only exists inside a hidden window is a countdown
// you cannot trust. Time left is derived from an end timestamp rather than
// accumulated per tick, so sleeping the Mac mid-block does not silently
// stretch the block — you come back to a finished timer, not a paused one.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { app, Notification } = require('electron');

const SOUND_DIR = '/System/Library/Sounds';

const DEFAULTS = {
  focusMinutes: 25,
  breakMinutes: 5,
  longBreakMinutes: 15,
  roundsBeforeLong: 4,
  sound: 'Glass',
};

// Guard rails, not preferences. A zero-minute focus block is a bug, not a choice.
const LIMITS = {
  focusMinutes: [1, 180],
  breakMinutes: [1, 60],
  longBreakMinutes: [1, 120],
  roundsBeforeLong: [2, 12],
};

let cfg = { ...DEFAULTS };
let daily = { date: '', count: 0 };
const listeners = [];
let ticker = null;
let lastTickSecond = -1;

const st = {
  status: 'idle',   // idle | running | paused | done
  phase: 'focus',   // the phase running now, or the one that just ended
  next: 'focus',    // what Start would begin
  endsAt: 0,        // epoch ms, meaningful only while running
  remainingMs: 0,   // authoritative while idle, paused or done
  totalMs: 0,
  round: 0,         // focus blocks finished in the current cycle
};

// ---- config ----

function configFile() {
  return path.join(app.getPath('userData'), 'pomodoro.json');
}

function clamp(key, value) {
  const [lo, hi] = LIMITS[key];
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : DEFAULTS[key];
}

function todayKey() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function load() {
  try {
    const saved = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
    for (const k of Object.keys(LIMITS)) if (saved[k] != null) cfg[k] = clamp(k, saved[k]);
    if (typeof saved.sound === 'string' && saved.sound) cfg.sound = saved.sound;
    if (saved.daily && typeof saved.daily.date === 'string') {
      daily = { date: saved.daily.date, count: parseInt(saved.daily.count, 10) || 0 };
    }
  } catch { /* first run, or a file we cannot read — defaults are fine */ }
  if (daily.date !== todayKey()) daily = { date: todayKey(), count: 0 };
}

function save() {
  try {
    fs.writeFileSync(configFile(), JSON.stringify({ ...cfg, daily }, null, 2));
  } catch { /* a lost preference is not worth crashing the app over */ }
}

// ---- phases ----

function durationMs(phase) {
  const mins = phase === 'focus' ? cfg.focusMinutes
    : phase === 'long' ? cfg.longBreakMinutes
    : cfg.breakMinutes;
  return mins * 60 * 1000;
}

// Idle and done both mean "nothing is counting", so the number on screen should
// be the length of whatever Start would begin.
function armNext(phase) {
  st.next = phase;
  st.totalMs = durationMs(phase);
  st.remainingMs = st.totalMs;
}

function completedToday() {
  return daily.date === todayKey() ? daily.count : 0;
}

// ---- the public snapshot ----

function state() {
  const remaining = st.status === 'running'
    ? Math.max(0, st.endsAt - Date.now())
    : st.remainingMs;
  return {
    status: st.status,
    phase: st.phase,
    next: st.next,
    round: st.round,
    remainingSec: Math.ceil(remaining / 1000),
    totalSec: Math.round(st.totalMs / 1000),
    completedToday: completedToday(),
    config: { ...cfg },
  };
}

// Running or paused. The tray asks this to decide between a countdown and the
// eye icon: once a block has ended, the timer is no longer worth a menu-bar slot.
function isActive() {
  return st.status === 'running' || st.status === 'paused';
}

function emit() {
  const snap = state();
  for (const cb of listeners) { try { cb(snap); } catch {} }
}

function onChange(cb) { listeners.push(cb); }

// ---- ticking ----

function startTicker() {
  if (ticker) return;
  lastTickSecond = -1;
  // Faster than once a second so the tray never skips a number, but only
  // published when the displayed second actually changes.
  ticker = setInterval(() => {
    if (st.status !== 'running') return;
    const left = st.endsAt - Date.now();
    if (left <= 0) { complete(); return; }
    const sec = Math.ceil(left / 1000);
    if (sec !== lastTickSecond) { lastTickSecond = sec; emit(); }
  }, 250);
}

function stopTicker() {
  if (ticker) { clearInterval(ticker); ticker = null; }
}

function complete() {
  const finished = st.phase;
  if (finished === 'focus') {
    st.round += 1;
    daily = { date: todayKey(), count: completedToday() + 1 };
    save();
  }

  let upcoming;
  if (finished === 'focus') {
    upcoming = st.round % cfg.roundsBeforeLong === 0 ? 'long' : 'break';
  } else {
    if (finished === 'long') st.round = 0; // a long break closes the cycle
    upcoming = 'focus';
  }

  st.status = 'done';
  stopTicker();
  armNext(upcoming);
  announce(finished, upcoming);
  emit();
}

function announce(finished, upcoming) {
  const mins = Math.round(durationMs(upcoming) / 60000);
  const plural = `${mins} minute${mins === 1 ? '' : 's'}`;
  const title = finished === 'focus' ? 'Focus block done' : 'Break over';
  const body = upcoming === 'focus'
    ? `Ready for ${plural} of focus.`
    : `Take ${plural}.`;
  playSound(cfg.sound);
  if (Notification.isSupported()) {
    // Silent, because the sound is ours to choose — see setConfig.
    try { new Notification({ title, body, silent: true }).show(); } catch {}
  }
}

// ---- sound ----

function sounds() {
  try {
    return fs.readdirSync(SOUND_DIR)
      .filter((f) => f.endsWith('.aiff'))
      .map((f) => path.basename(f, '.aiff'))
      .sort();
  } catch { return [DEFAULTS.sound]; }
}

function playSound(name) {
  const file = path.join(SOUND_DIR, `${String(name).replace(/[^\w -]/g, '')}.aiff`);
  if (!fs.existsSync(file)) return;
  try { execFile('/usr/bin/afplay', [file], () => {}); } catch {}
}

// ---- commands ----

function start() {
  if (st.status === 'paused') {
    st.endsAt = Date.now() + st.remainingMs;
    st.status = 'running';
  } else if (st.status !== 'running') {
    st.phase = st.next;
    st.totalMs = durationMs(st.phase);
    st.remainingMs = st.totalMs;
    st.endsAt = Date.now() + st.totalMs;
    st.status = 'running';
  }
  startTicker();
  emit();
}

function pause() {
  if (st.status !== 'running') return;
  st.remainingMs = Math.max(0, st.endsAt - Date.now());
  st.status = 'paused';
  stopTicker();
  emit();
}

// Back to the top of the cycle. Blocks already finished still count for the day
// — the daily tally records what you did, not what the timer is doing now.
function reset() {
  st.status = 'idle';
  st.phase = 'focus';
  st.round = 0;
  st.endsAt = 0;
  stopTicker();
  armNext('focus');
  emit();
}

function setConfig(patch) {
  for (const k of Object.keys(LIMITS)) if (patch && patch[k] != null) cfg[k] = clamp(k, patch[k]);
  if (patch && typeof patch.sound === 'string' && sounds().includes(patch.sound)) cfg.sound = patch.sound;
  save();
  // A length change applies to the next block, never to one already counting.
  if (st.status === 'idle' || st.status === 'done') armNext(st.next);
  emit();
  return state();
}

function init() {
  load();
  armNext('focus');
}

module.exports = {
  init, state, isActive, onChange,
  start, pause, reset, setConfig,
  sounds, playSound,
};
