// stats.js — reads the root daemon's log and turns it into history the UI can draw.
//
// The log is the only record of what actually happened, and it is append-only,
// world-readable, and owned by root. The app never writes it. Every line looks
// like "2026-09-05 15:33:29 applied ALLOW".
const fs = require('fs');
const os = require('os');
const path = require('path');

const LOG = '/Library/Application Support/GazeGate/daemon.log';

// The visit tracker lives in user space and owns this file. This layer only
// ever reads it, and nothing here can influence the block decision.
const VISITS = path.join(os.homedir(), 'Library/Application Support/GazeGate/visits.jsonl');

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

// ---- visits ---------------------------------------------------------------
// visits.jsonl is one JSON object per line, appended and never rewritten, so a
// crash mid-write leaves a torn last line. A line that does not parse is
// counted and skipped; losing one visit must never cost the whole history.

// The tracker stamps unlock_start from the app's clock, the daemon writes its
// log line from root's, and neither waits on the other. Join on the nearest
// window inside this tolerance rather than on an exact second.
const JOIN_TOLERANCE_SEC = 90;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const nonEmpty = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const site = (v) => { const s = nonEmpty(v); return s ? s.toLowerCase().replace(/^www\./, '') : null; };

// text -> { records, badLines }. Pure, and the only place the file format is
// trusted; everything downstream works on validated records.
function parseVisits(text) {
  const records = [];
  let badLines = 0;
  for (const line of String(text == null ? '' : text).split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let r;
    try { r = JSON.parse(t); } catch { badLines++; continue; }
    if (!r || typeof r !== 'object' || Array.isArray(r)) { badLines++; continue; }

    if (r.type === 'visit') {
      const start = num(r.unlock_start), secs = num(r.seconds), s = site(r.site);
      if (start === null || secs === null || !s) { badLines++; continue; }
      records.push({
        type: 'visit', unlock_start: start, site: s, host: nonEmpty(r.host),
        start: num(r.start), end: num(r.end), seconds: Math.max(0, secs),
      });
    } else if (r.type === 'window') {
      const start = num(r.unlock_start);
      if (start === null) { badLines++; continue; }
      records.push({
        type: 'window', unlock_start: start, unlock_end: num(r.unlock_end),
        granted_seconds: num(r.granted_seconds), used_seconds: num(r.used_seconds),
        first_site: site(r.first_site), partial: r.partial === true,
      });
    } else {
      badLines++;
    }
  }
  return { records, badLines };
}

// Fold validated records against the unlock windows derived from daemon.log.
// Pure: takes records and windows, returns numbers. No fs, no Electron.
//
// `unlocks` is the shape compute() already builds: { start: Date, end, minutes }.
function foldVisits(records, unlocks, badLines = 0) {
  const list = Array.isArray(records) ? records.filter((r) => r && (r.type === 'visit' || r.type === 'window')) : [];
  const wins = (Array.isArray(unlocks) ? unlocks : []).map((u) => ({
    sec: Math.round(new Date(u.start).getTime() / 1000),
    minutes: u.minutes,
  }));

  const nearest = (sec) => {
    let best = null, bestD = Infinity;
    for (const w of wins) { const d = Math.abs(w.sec - sec); if (d < bestD) { bestD = d; best = w; } }
    return bestD <= JOIN_TOLERANCE_SEC ? best : null;
  };

  const rows = new Map();     // canonical unlock second -> row
  const canon = new Map();    // raw unlock_start -> canonical second
  const bySite = new Map();

  const rowFor = (sec) => {
    if (!canon.has(sec)) { const m = nearest(sec); canon.set(sec, m ? m.sec : sec); }
    const key = canon.get(sec);
    if (!rows.has(key)) {
      const m = nearest(sec);
      const at = new Date(key * 1000);
      rows.set(key, {
        key,
        date: dayKey(at),
        time: `${pad(at.getHours())}:${pad(at.getMinutes())}`,
        matched: !!m,
        grantedSeconds: m ? Math.round(m.minutes * 60) : null,
        usedSeconds: 0,
        firstSite: null,
        partial: true,
        sites: [],
        _visits: [],
        _record: null,
      });
    }
    return rows.get(key);
  };

  for (const r of list) {
    const row = rowFor(r.unlock_start);
    if (r.type === 'visit') {
      row._visits.push(r);
      const s = bySite.get(r.site) || { site: r.site, seconds: 0, visits: 0, windows: new Set() };
      s.seconds += r.seconds;
      s.visits++;
      s.windows.add(row.key);
      bySite.set(r.site, s);
    } else {
      row._record = r;
    }
  }

  for (const row of rows.values()) {
    const rec = row._record;
    const visitSeconds = row._visits.reduce((a, v) => a + v.seconds, 0);

    // The window record is what the tracker knew when the window closed, so it
    // wins. With no record the window never closed under a running tracker —
    // the app quit or crashed mid-unlock — so the visits are real but the
    // coverage is not provable. That is exactly what partial means.
    row.usedSeconds = rec && rec.used_seconds !== null ? Math.max(0, rec.used_seconds) : visitSeconds;
    if (rec && rec.granted_seconds !== null) row.grantedSeconds = rec.granted_seconds;
    row.partial = rec ? rec.partial === true : true;
    if (row.grantedSeconds === null) row.partial = true; // no grant, nothing to divide by

    const earliest = row._visits
      .filter((v) => v.start !== null)
      .sort((a, b) => a.start - b.start)[0];
    row.firstSite = (rec && rec.first_site) || (earliest ? earliest.site : null);

    const perSite = new Map();
    for (const v of row._visits) perSite.set(v.site, (perSite.get(v.site) || 0) + v.seconds);
    row.sites = [...perSite.entries()]
      .map(([s, seconds]) => ({ site: s, seconds }))
      .sort((a, b) => b.seconds - a.seconds);

    delete row._visits;
    delete row._record;
  }

  const all = [...rows.values()].sort((a, b) => b.key - a.key); // newest first
  const complete = all.filter((w) => !w.partial && w.grantedSeconds !== null);

  const earnedSeconds = complete.reduce((a, w) => a + w.grantedSeconds, 0);
  const usedSeconds = complete.reduce((a, w) => a + w.usedSeconds, 0);

  // First touch is only honest on a window the tracker watched from the top.
  // On a partial window the first site seen is just the first one after the
  // tracker woke up, which is a different question.
  const firstCounts = new Map();
  let noTouch = 0;
  for (const w of complete) {
    if (!w.firstSite) { noTouch++; continue; }
    firstCounts.set(w.firstSite, (firstCounts.get(w.firstSite) || 0) + 1);
  }
  const firstTouch = [...firstCounts.entries()]
    .map(([s, count]) => ({ site: s, count, share: complete.length ? count / complete.length : 0 }))
    .sort((a, b) => b.count - a.count || a.site.localeCompare(b.site));

  const sites = [...bySite.values()]
    .map((s) => ({ site: s.site, seconds: s.seconds, visits: s.visits, windows: s.windows.size }))
    .sort((a, b) => b.seconds - a.seconds || a.site.localeCompare(b.site));

  // Unlocks the daemon logged that the tracker has nothing at all for. Reported
  // rather than folded in, because a silent zero here is a broken tracker
  // wearing the costume of a clean record.
  const matchedKeys = new Set([...rows.values()].filter((w) => w.matched).map((w) => w.key));
  const untrackedWindows = wins.filter((w) => !matchedKeys.has(w.sec)).length;

  return {
    records: list.length,
    badLines,
    windows: all,
    trackedWindows: all.length,
    completeWindows: complete.length,
    partialWindows: all.length - complete.length,
    untrackedWindows,
    unmatchedWindows: all.filter((w) => !w.matched).length,
    sites,
    totalSeconds: sites.reduce((a, s) => a + s.seconds, 0),
    topSite: sites.length ? { site: sites[0].site, seconds: sites[0].seconds } : null,
    earnedSeconds,
    usedSeconds,
    usedShare: earnedSeconds ? usedSeconds / earnedSeconds : null,
    avgGrantedSeconds: complete.length ? earnedSeconds / complete.length : null,
    avgUsedSeconds: complete.length ? usedSeconds / complete.length : null,
    firstTouch,
    noTouchWindows: noTouch,
  };
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

  // Visits, joined to the unlock windows above. Outages are deliberately not
  // passed in: a stretch where blocking had stopped working is not an unlock,
  // and anything browsed during one was never bought with a stare.
  let visitText = null;
  try { visitText = fs.readFileSync(VISITS, 'utf8'); } catch {}
  const parsedVisits = parseVisits(visitText);
  const visits = Object.assign(
    { hasLog: visitText !== null },
    foldVisits(parsedVisits.records, unlocks, parsedVisits.badLines)
  );

  return {
    visits,
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
  // The visits log grows on its own schedule, so it needs its own half of the
  // key or a new visit would sit unread until the next block flip.
  try { const vt = fs.statSync(VISITS); key += `|${vt.size}:${vt.mtimeMs}`; } catch { key += '|missing'; }
  if (cache && cache.key === key) return cache.value;
  const value = compute();
  cache = { key, value };
  return value;
}

module.exports = { summary, LOG, VISITS, parseVisits, foldVisits };
