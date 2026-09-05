// stats.js — reads the root daemon's log and turns it into history the UI can draw.
//
// The log is the only record of what actually happened, and it is append-only,
// world-readable, and owned by root. The app never writes it. Every line looks
// like "2026-09-05 15:33:29 applied ALLOW".
const fs = require('fs');

const LOG = '/Library/Application Support/GazeGate/daemon.log';

// An earned unlock runs exactly UNLOCK_MINUTES. Anything meaningfully longer was
// the blocker being off — a disabled daemon, a bad sites.txt, a Sunday. Counting
// those as unlocks would report a broken day as a 24-hour binge.
const UNLOCK_MINUTES = 10;
const MAX_UNLOCK_MIN = 15;

let cache = null; // { key, value } keyed on the log's size+mtime

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => { const c = new Date(d); c.setDate(c.getDate() + n); return c; };

function parseEvents(text) {
  const out = [];
  const re = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d) applied (ALLOW|BLOCK)$/;
  for (const line of text.split('\n')) {
    const m = re.exec(line.trim());
    if (!m) continue;
    out.push({
      at: new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]),
      state: m[7],
    });
  }
  out.sort((a, b) => a.at - b.at);
  return out;
}

// The daemon rewrites /etc/hosts on any content change, not just on a state
// flip, so BLOCK can follow BLOCK. Collapse to real transitions first.
function transitions(events) {
  const out = [];
  for (const e of events) if (!out.length || out[out.length - 1].state !== e.state) out.push(e);
  return out;
}

function compute() {
  let text;
  try { text = fs.readFileSync(LOG, 'utf8'); }
  catch { return { hasLog: false }; }

  const events = parseEvents(text);
  if (!events.length) return { hasLog: false };

  const flips = transitions(events);
  const now = new Date();

  // Every ALLOW window, split into earned unlocks and outages by duration.
  const unlocks = [];
  const outages = [];
  for (let i = 0; i < flips.length; i++) {
    if (flips[i].state !== 'ALLOW') continue;
    const start = flips[i].at;
    const end = i + 1 < flips.length ? flips[i + 1].at : now;
    const minutes = (end - start) / 60000;
    (minutes > MAX_UNLOCK_MIN ? outages : unlocks).push({ start, end, minutes });
  }

  const firstDay = new Date(events[0].at); firstDay.setHours(0, 0, 0, 0);
  const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);

  // Per-day unlock counts, and which days the blocker was off at all.
  const perDay = new Map();
  for (const u of unlocks) perDay.set(dayKey(u.start), (perDay.get(dayKey(u.start)) || 0) + 1);
  const offDays = new Set();
  for (const o of outages) {
    for (let d = new Date(o.start); d <= o.end; d = addDays(d, 1)) offDays.add(dayKey(d));
  }

  // A dense day series from first log line to today, so the UI never has gaps.
  const days = [];
  for (let d = new Date(firstDay); d <= todayStart; d = addDays(d, 1)) {
    const key = dayKey(d);
    days.push({
      date: key,
      weekday: d.getDay(),           // 0 = Sunday
      count: perDay.get(key) || 0,
      off: offDays.has(key),
      sunday: d.getDay() === 0,
    });
  }

  // Streaks. A day is clean if the blocker was enforcing and you did not unlock.
  // Sundays are open by design and outage days were the tool's fault, so neither
  // counts toward a streak nor breaks one — they are skipped.
  const scoreable = days.filter((d) => !d.sunday && !d.off);
  let longest = 0, run = 0;
  for (const d of scoreable) { run = d.count === 0 ? run + 1 : 0; longest = Math.max(longest, run); }
  let current = 0;
  for (let i = scoreable.length - 1; i >= 0; i--) {
    if (scoreable[i].count !== 0) break;
    current++;
  }

  const weekAgo = addDays(todayStart, -6);
  const inRange = (u, from) => u.start >= from;

  const hours = new Array(24).fill(0);
  for (const u of unlocks) hours[u.start.getHours()]++;

  const busiest = days.reduce((a, b) => (b.count > (a ? a.count : 0) ? b : a), null);

  return {
    hasLog: true,
    since: dayKey(firstDay),
    today: unlocks.filter((u) => inRange(u, todayStart)).length,
    week: unlocks.filter((u) => inRange(u, weekAgo)).length,
    allTime: unlocks.length,
    unlockMinutes: UNLOCK_MINUTES,
    currentStreak: current,
    longestStreak: longest,
    cleanDays: scoreable.filter((d) => d.count === 0).length,
    scoredDays: scoreable.length,
    hours,
    days,
    busiest: busiest && busiest.count ? { date: busiest.date, count: busiest.count } : null,
    offDays: offDays.size,
    outages: outages.map((o) => ({
      start: dayKey(o.start),
      minutes: Math.round(o.minutes),
    })),
  };
}

// Recompute only when the log has actually changed; the home panel polls once a
// second and this file grows for years.
function summary() {
  let key = 'missing';
  try { const st = fs.statSync(LOG); key = `${st.size}:${st.mtimeMs}`; } catch {}
  if (cache && cache.key === key) return cache.value;
  const value = compute();
  cache = { key, value };
  return value;
}

module.exports = { summary, LOG };
