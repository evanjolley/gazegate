import { FaceLandmarker, FilesetResolver }
  from '../node_modules/@mediapipe/tasks-vision/vision_bundle.mjs';

// ---- tunable thresholds ----
// How long you must hold is user-configurable now; the main process owns the
// value and enforces the floor, this is just the last-synced copy.
let gateSeconds = 30;      // what the next stare costs (may be escalated)
let baseGateSeconds = 30;  // what Settings edits
let escalate = false;
let maxGateSeconds = 600;
let minGateSeconds = 30;
const requiredMs = () => gateSeconds * 1000;

const GRACE_MS    = 700;     // allowed lapse (blinks) before progress resets
const HEAD_YAW_MAX   = 0.38; // rad, left/right head turn
const HEAD_PITCH_MAX = 0.34; // rad, up/down head tilt
const GAZE_MAX  = 0.55;      // eye-look blendshape score away from center
const BLINK_MAX = 0.55;

const $ = (id) => document.getElementById(id);
const show = (id, on) => { $(id).style.display = on ? '' : 'none'; };
const views = ['install', 'home', 'pomodoro', 'noise', 'gate', 'settings', 'history'];
let currentView = null;
function showView(name) {
  currentView = name;
  views.forEach(v => $(`view-${v}`).classList.toggle('active', v === name));
}

// ---------- status / home ----------
let statusTimer = null;
let primaryAction = 'unlock'; // what the one primary button currently does
async function refresh() {
  const s = await window.gazegate.getStatus();
  if (!s.installed) { showView('install'); return; }

  // Land on home from a cold boot (nothing shown yet) or straight after install.
  // Any other view — gate, settings — is the user's, so polling must not steal it.
  if (currentView === null || currentView === 'install') showTab('home');

  gateSeconds = s.gateSeconds;
  baseGateSeconds = s.baseGateSeconds;
  minGateSeconds = s.minGateSeconds;
  maxGateSeconds = s.maxGateSeconds;
  escalate = s.escalate;

  show('update-banner', s.needsUpdate);
  refreshVisitStatus().catch(() => {});
  window.gazegate.getStats().then(paintHomeStats).catch(() => {});

  const badge = $('status-badge');
  const setBadge = (cls, label) =>
    badge.innerHTML = `<span class="dot ${cls}"></span><span>${label}</span>`;

  // reset, then enable per mode
  show('countdown-wrap', false);
  show('sunday-note', false);
  show('btn-sunday-open', false);

  // The primary button is whichever of lock/unlock is actually available. They
  // are never both meaningful: you can only lock while an unlock is running,
  // and only unlock while you are blocked.
  const primary = (action, label) => {
    primaryAction = action;
    $('btn-primary').textContent = label;
  };

  switch (s.mode) {
    case 'unlocked': {
      setBadge('unlocked', 'Unlocked');
      show('countdown-wrap', true);
      const m = Math.floor(s.remaining / 60), sec = s.remaining % 60;
      $('countdown').textContent = `${m}:${String(sec).padStart(2, '0')}`;
      primary('lock', 'Lock now');
      break;
    }
    case 'sunday-open':
      setBadge('unlocked', 'Sunday — open all day');
      show('sunday-note', true);
      // Nothing to lock — the day is open by design — so the strict move is
      // re-arming blocking for the rest of it.
      primary('sunday-block', 'Block for the rest of today');
      break;
    case 'sunday-blocked':
      setBadge('blocked', 'Blocked · on for today');
      primary('unlock', `Unlock — hold eye contact ${gateSeconds}s`);
      show('btn-sunday-open', true);
      break;
    default: // 'blocked'
      setBadge('blocked', 'Blocked');
      primary('unlock', `Unlock — hold eye contact ${gateSeconds}s`);
  }
}
function startStatusPolling() {
  if (statusTimer) clearInterval(statusTimer);
  statusTimer = setInterval(refresh, 1000);
}

// ---------- gaze model ----------
let landmarker = null;
async function loadModel() {
  if (landmarker) return landmarker;
  const fileset = await FilesetResolver.forVisionTasks('../assets/wasm');
  const opts = {
    baseOptions: { modelAssetPath: '../assets/face_landmarker.task' },
    runningMode: 'VIDEO',
    numFaces: 1,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
  };
  try {
    landmarker = await FaceLandmarker.createFromOptions(fileset, { ...opts, baseOptions: { ...opts.baseOptions, delegate: 'GPU' } });
  } catch {
    landmarker = await FaceLandmarker.createFromOptions(fileset, { ...opts, baseOptions: { ...opts.baseOptions, delegate: 'CPU' } });
  }
  return landmarker;
}

function eulerFromMatrix(m) {
  // column-major 4x4
  const r02 = m[8], r12 = m[9], r22 = m[10], r10 = m[1], r11 = m[5];
  const yaw = Math.atan2(r02, r22);
  const pitch = Math.atan2(-r12, Math.hypot(r10, r11));
  return { yaw, pitch };
}

function evaluate(result) {
  const hasFace = result.faceBlendshapes && result.faceBlendshapes.length > 0;
  if (!hasFace) return { ok: false, face: false, yaw: 0, pitch: 0, gaze: 1, blink: 0 };
  const cats = result.faceBlendshapes[0].categories;
  const g = {};
  for (const c of cats) g[c.categoryName] = c.score;
  const gaze = Math.max(
    g.eyeLookInLeft || 0, g.eyeLookInRight || 0,
    g.eyeLookOutLeft || 0, g.eyeLookOutRight || 0,
    g.eyeLookUpLeft || 0, g.eyeLookUpRight || 0,
    g.eyeLookDownLeft || 0, g.eyeLookDownRight || 0,
  );
  const blink = Math.max(g.eyeBlinkLeft || 0, g.eyeBlinkRight || 0);
  let yaw = 0, pitch = 0;
  const mats = result.facialTransformationMatrixes;
  if (mats && mats.length) ({ yaw, pitch } = eulerFromMatrix(mats[0].data));
  const ok = Math.abs(yaw) < HEAD_YAW_MAX &&
             Math.abs(pitch) < HEAD_PITCH_MAX &&
             gaze < GAZE_MAX &&
             blink < BLINK_MAX;
  return { ok, face: true, yaw, pitch, gaze, blink };
}

function drawRing(ctx, frac, good) {
  const w = ctx.canvas.width, r = w / 2 - 10, c = w / 2;
  ctx.clearRect(0, 0, w, w);
  ctx.lineWidth = 8; ctx.lineCap = 'round';
  ctx.strokeStyle = '#2a2f3a';
  ctx.beginPath(); ctx.arc(c, c, r, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = good ? '#4ade80' : '#f87171';
  ctx.beginPath();
  ctx.arc(c, c, r, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
  ctx.stroke();
}

// ---------- the gate ----------
let gateActive = false;
async function runGate(purpose, title, sub) {
  $('gate-title').textContent = title;
  $('gate-sub').textContent = sub;
  $('gate-status').textContent = 'Starting camera…';
  $('gate-status').className = 'gate-status';
  $('gate-count').textContent = String(gateSeconds);
  showView('gate');

  // Pin the panel open — it dismisses on blur, and a stray click must not be
  // able to cancel a stare in progress.
  await window.gazegate.setGateActive(true);

  let stream, video = $('video'), ctx = $('ring').getContext('2d');
  try {
    await loadModel();
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
    video.srcObject = stream;
    await video.play();
  } catch (e) {
    $('gate-status').textContent = 'Camera error: ' + (e.message || e);
    $('gate-status').className = 'gate-status bad';
    await window.gazegate.setGateActive(false);
    return false;
  }

  gateActive = true;
  let held = 0, badSince = null, lastTs = performance.now(), lastVideoTs = -1;
  let okState = false, lastEv = null;

  return new Promise((resolve) => {
    const cleanup = (result) => {
      gateActive = false;
      if (stream) stream.getTracks().forEach(t => t.stop());
      window.gazegate.setGateActive(false);
      resolve(result);
    };
    $('btn-gate-cancel').onclick = () => cleanup(false);

    function loop() {
      if (!gateActive) return;
      const now = performance.now();
      const dt = now - lastTs; lastTs = now;

      // Re-evaluate gaze only when a fresh camera frame is ready…
      if (video.currentTime !== lastVideoTs) {
        lastVideoTs = video.currentTime;
        const res = landmarker.detectForVideo(video, now);
        lastEv = evaluate(res);
        okState = lastEv.ok;
        if (okState) badSince = null;
        else if (badSince === null) badSince = now;
      }

      // …but account real wall-clock time every animation frame.
      const inGrace = badSince !== null && (now - badSince) <= GRACE_MS;
      if (okState) held += dt;
      else if (badSince !== null && (now - badSince) > GRACE_MS) held = 0;
      held = Math.min(Math.max(held, 0), requiredMs());

      drawRing(ctx, held / requiredMs(), okState || inGrace);
      $('gate-count').textContent = Math.max(0, Math.ceil((requiredMs() - held) / 1000));

      const st = $('gate-status'), ev = lastEv;
      if (ev) {
        if (!ev.face) { st.textContent = 'No face detected — center yourself'; st.className = 'gate-status bad'; }
        else if (ev.ok) { st.textContent = 'Hold it…'; st.className = 'gate-status good'; }
        else if (ev.blink >= BLINK_MAX) { st.textContent = 'Hold it…'; st.className = 'gate-status good'; }
        else if (Math.abs(ev.yaw) >= HEAD_YAW_MAX || Math.abs(ev.pitch) >= HEAD_PITCH_MAX) { st.textContent = 'Face the camera straight on'; st.className = 'gate-status bad'; }
        else { st.textContent = 'Look right at the lens'; st.className = 'gate-status bad'; }
        $('debug').textContent =
          `yaw ${ev.yaw.toFixed(2)}  pitch ${ev.pitch.toFixed(2)}  gaze ${ev.gaze.toFixed(2)}  blink ${ev.blink.toFixed(2)}`;
      }

      if (held >= requiredMs()) {
        st.textContent = 'Unlocked ✓'; st.className = 'gate-status good';
        cleanup(true);
        return;
      }
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
  });
}

// ---------- wiring ----------
$('btn-install').onclick = async () => {
  $('btn-install').disabled = true;
  $('btn-install').textContent = 'Waiting for admin password…';
  const r = await window.gazegate.installDaemon();
  if (r.ok) { await refresh(); showTab('home'); }
  else {
    $('install-err').textContent = r.error || 'Install failed';
    $('btn-install').disabled = false;
    $('btn-install').textContent = 'Install & start blocking';
  }
};

async function startUnlock() {
  const passed = await runGate('unlock', 'Hold eye contact', `Look straight into the lens for ${gateSeconds} seconds. Look away and it resets.`);
  if (passed) {
    const r = await window.gazegate.gatePassed('unlock');
    // The daemon can refuse. Never swallow that after the stare has been held.
    if (r && r.ok === false) {
      $('home-error').textContent = `The blocker refused the unlock (${r.error}). Your stare was not wasted, nothing changed.`;
      show('home-error', true);
    } else {
      show('home-error', false);
    }
  }
  await refresh();
  showTab('home');
}

$('btn-primary').onclick = async () => {
  switch (primaryAction) {
    case 'lock':          // free, it only ever makes things stricter
      await window.gazegate.lockNow();
      await refresh();
      break;
    case 'sunday-block':  // also free, same reason
      await window.gazegate.sundayBlock();
      await refresh();
      break;
    default:
      await startUnlock();
  }
};

$('btn-update').onclick = async () => {
  $('btn-update').textContent = 'Applying…';
  const r = await window.gazegate.updateDaemon();
  if (r.ok) await refresh();
  else $('btn-update').textContent = 'Update failed — retry';
};

// Sunday: undo that and open back up — gated, since it's an escape.
$('btn-sunday-open').onclick = async () => {
  const passed = await runGate('sunday-open', 'Eye contact to open Sunday',
    `You turned blocking on for today. Opening back up needs ${gateSeconds} seconds of eye contact.`);
  if (passed) await window.gazegate.sundayClear();
  await refresh();
  showTab('home');
};

$('btn-settings').onclick = async () => {
  const passed = await runGate('settings', 'Eye contact to open settings', `Changing what gets blocked needs the same commitment. ${gateSeconds} seconds.`);
  if (!passed) { showTab('home'); return; }
  await window.gazegate.gatePassed('settings');

  const [core, sites] = await Promise.all([
    window.gazegate.getCoreSites(),
    window.gazegate.getSites(),
  ]);
  $('core-sites').innerHTML = core.map(s => `<li>${s}</li>`).join('');
  $('sites').value = sites.join('\n');
  $('gate-seconds').value = baseGateSeconds;
  $('gate-seconds').min = minGateSeconds;
  $('min-gate').textContent = minGateSeconds;
  $('gate-msg').textContent = '';
  paintEscalate();
  showView('settings');
};

$('btn-settings-back').onclick = () => showTab('home');

$('btn-save-sites').onclick = async () => {
  const list = $('sites').value.split('\n').map(s => s.trim()).filter(Boolean);
  await window.gazegate.setSites(list);
  $('sites').value = (await window.gazegate.getSites()).join('\n');
  $('btn-save-sites').textContent = 'Saved ✓';
  setTimeout(() => ($('btn-save-sites').textContent = 'Save extra sites'), 1200);
};

function paintEscalate() {
  $('esc-toggle').checked = escalate;
  $('esc-max').textContent = maxGateSeconds;
  const b = baseGateSeconds;
  $('esc-curve').textContent = `${b}s, ${b * 2}s, ${b * 4}s`;
  $('esc-label').textContent = escalate
    ? `On — the next unlock costs ${gateSeconds}s`
    : 'Off';
  $('esc-msg').textContent = '';
}

// On is stricter, so it is free. Off is an escape, so it costs one stare at
// whatever the price is right now.
$('esc-toggle').onchange = async () => {
  const want = $('esc-toggle').checked;
  if (!want) {
    const from = gateSeconds;
    const passed = await runGate('settings', 'Eye contact to stop the price rising',
      `Turning this off makes unlocking cheaper. Hold ${from} seconds first.`);
    showView('settings');
    if (!passed) {
      $('esc-toggle').checked = true;
      $('esc-msg').style.color = 'var(--danger)';
      $('esc-msg').textContent = 'Not changed — the stare was not completed.';
      return;
    }
  }
  const r = await window.gazegate.setEscalate(want);
  escalate = r.escalate;
  gateSeconds = r.gateSeconds;
  paintEscalate();
  $('esc-msg').style.color = 'var(--accent)';
  $('esc-msg').textContent = want ? 'On.' : 'Off.';
};

// Longer is free. Shorter is an escape, so it costs one stare at the *current*
// length — same rule the Sunday buttons follow.
$('btn-save-gate').onclick = async () => {
  const msg = $('gate-msg');
  const want = Math.round(Number($('gate-seconds').value));
  if (!Number.isFinite(want) || want < minGateSeconds) {
    msg.style.color = 'var(--danger)';
    msg.textContent = `Minimum is ${minGateSeconds} seconds.`;
    $('gate-seconds').value = baseGateSeconds;
    return;
  }
  if (want === baseGateSeconds) { msg.style.color = ''; msg.textContent = 'Unchanged.'; return; }

  if (want < baseGateSeconds) {
    const from = gateSeconds;
    const passed = await runGate('settings', 'Eye contact to shorten the stare',
      `Going from ${from}s down to ${want}s makes this easier on you. Hold ${from} seconds first.`);
    if (!passed) {
      showView('settings');
      $('gate-seconds').value = baseGateSeconds;
      msg.style.color = 'var(--danger)';
      msg.textContent = 'Not changed — the stare was not completed.';
      return;
    }
    showView('settings');
  }

  const r = await window.gazegate.setGateSeconds(want);
  baseGateSeconds = r.baseGateSeconds;
  gateSeconds = r.gateSeconds;
  $('gate-seconds').value = baseGateSeconds;
  paintEscalate();
  msg.style.color = 'var(--accent)';
  msg.textContent = escalate && gateSeconds !== baseGateSeconds
    ? `Saved — ${baseGateSeconds}s base, ${gateSeconds}s for the next unlock today.`
    : `Saved — ${baseGateSeconds} seconds.`;
};

$('btn-quit').onclick = async () => {
  // Same as clicking away from the panel. Ungated — the daemon is root and
  // independent, so nothing here can unblock a site. The real exit is the
  // tray's right-click menu.
  await window.gazegate.closePanel();
};

$('btn-uninstall').onclick = async () => {
  const passed = await runGate('uninstall', 'Eye contact to turn it all off', `This removes blocking entirely and unblocks every site. ${gateSeconds} seconds.`);
  if (passed) await window.gazegate.gatePassed('uninstall');
  else showView('settings');
};

// ---- Stats ----
const SVG = 'http://www.w3.org/2000/svg';
const el = (name, attrs) => {
  const n = document.createElementNS(SVG, name);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
};

// Colour ramp shared by the day dots and the history grid.
function dayFill(d) {
  if (d.off) return '#3a3f4a';                       // blocker was not working
  if (!d.count) return 'transparent';                // clean
  if (d.count <= 2) return 'rgba(74,222,128,0.45)';
  if (d.count <= 5) return 'rgba(74,222,128,0.75)';
  return 'var(--accent)';
}
const dayStroke = (d) => (!d.off && !d.count ? '1px solid #2a2f3a' : 'none');

// 24 spokes round a dial, midnight at the top, length by unlock count.
function drawClock(hours) {
  const svg = $('clock');
  svg.innerHTML = '';
  const cx = 100, cy = 100, rIn = 44, rOut = 90;
  const peak = Math.max(1, ...hours);

  svg.appendChild(el('circle', { cx, cy, r: rIn, class: 'clock-face' }));

  hours.forEach((n, h) => {
    const a = (h / 24) * Math.PI * 2 - Math.PI / 2;
    const len = n ? rIn + 6 + (rOut - rIn - 6) * (n / peak) : rIn + 3;
    svg.appendChild(el('line', {
      x1: cx + Math.cos(a) * rIn, y1: cy + Math.sin(a) * rIn,
      x2: cx + Math.cos(a) * len, y2: cy + Math.sin(a) * len,
      'stroke-width': 5,
      stroke: n ? 'var(--accent)' : 'var(--ring-bg)',
      class: 'clock-bar',
    }));
  });

  [[0, '12a'], [6, '6a'], [12, '12p'], [18, '6p']].forEach(([h, label]) => {
    const a = (h / 24) * Math.PI * 2 - Math.PI / 2;
    svg.appendChild(Object.assign(el('text', {
      x: cx + Math.cos(a) * 26, y: cy + Math.sin(a) * 26 + 4,
      'text-anchor': 'middle', class: 'clock-tick',
    }), { textContent: label }));
  });

  // A small mark for the hour it is now, so the dial reads as a clock.
  const na = (new Date().getHours() / 24) * Math.PI * 2 - Math.PI / 2;
  svg.appendChild(el('circle', {
    cx: cx + Math.cos(na) * (rOut + 4), cy: cy + Math.sin(na) * (rOut + 4),
    r: 2.5, class: 'clock-now',
  }));
}

// ---- Visits ----
// Unlocks say how often the gate opened. Visits say what came through it. The
// numbers arrive already folded by stats.js; nothing here recomputes them.

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Seconds as something you can read at a glance. Under ten minutes the seconds
// still matter, because the whole point is that four minutes is not ten.
function dur(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return m < 10 && s % 60 ? `${m}m ${pad2(s % 60)}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}
const pad2 = (n) => String(n).padStart(2, '0');

// A tracker that cannot see the browser must say so. Zeros from a broken
// tracker read exactly like a clean week, which is the one lie this feature
// could tell.
const VISIT_TROUBLE = {
  'no-permission': 'Visits are not being recorded. Automation permission for your browser was denied.',
  'no-browser': 'Visits are not being recorded. No supported browser is running.',
  error: 'Visits are not being recorded. The tracker stopped.',
};
let visitStatus = null;
let visitStatusAt = 0;

async function refreshVisitStatus(force) {
  if (typeof window.gazegate.getVisitStatus !== 'function') return null;
  if (!force && Date.now() - visitStatusAt < 5000) return visitStatus;
  visitStatusAt = Date.now();
  try { visitStatus = await window.gazegate.getVisitStatus(); }
  catch { visitStatus = { state: 'error', message: '' }; }
  return visitStatus;
}
const visitTrouble = () =>
  !!(visitStatus && visitStatus.state && visitStatus.state !== 'ok' && visitStatus.state !== 'idle');
// Never offer the recovery button unless there is something behind it.
const canFixPermission = () =>
  visitStatus && visitStatus.state === 'no-permission' &&
  typeof window.gazegate.openAutomationSettings === 'function';

// The single number on home is used against earned.
//
// Raw minutes on a site only say how much, and the top site only says where.
// Used against earned says whether the thing he paid thirty seconds of eye
// contact for was the thing he wanted: ten minutes bought, four minutes spent,
// six minutes he did not actually need. It is the only one of these numbers
// that is about the trade rather than the appetite, and it is the one that gets
// better on its own as the habit does. First touch and per-site totals are
// interesting, but they are history, and history lives in the history view.
function paintHomeVisits(v) {
  const line = $('st-visits');

  if (visitTrouble()) {
    line.className = 'streak trouble';
    line.style.display = '';
    const short = {
      'no-permission': 'no Automation permission',
      'no-browser': 'no supported browser running',
      error: String(visitStatus.message || '').trim() || 'the tracker stopped',
    }[visitStatus.state] || 'the tracker is not running';
    line.innerHTML = `Visits not tracked — ${esc(short)}.` +
      (canFixPermission() ? ' <a class="link" id="st-visit-fix">Open settings</a>' : '');
    const fix = $('st-visit-fix');
    // The stats block itself opens history, so the link has to keep its click.
    if (fix) fix.onclick = (e) => { e.stopPropagation(); window.gazegate.openAutomationSettings(); };
    return;
  }

  line.className = 'streak';
  if (!v || v.usedShare === null || !v.completeWindows) { line.style.display = 'none'; return; }
  line.style.display = '';
  line.innerHTML = `<b>${dur(v.avgUsedSeconds)}</b> used of each ${dur(v.avgGrantedSeconds)} unlocked`;
}

function paintVisits(v) {
  // Tracker state first. Whatever follows it is only as true as the tracker is.
  const status = $('h-visit-status');
  if (visitTrouble()) {
    status.style.display = '';
    const state = visitStatus.state;
    const msg = VISIT_TROUBLE[state] || 'Visits are not being recorded.';
    // The message comes from the tracker, so it may or may not end in a full
    // stop. Give it one rather than running it into the sentence after it.
    const raw = String(visitStatus.message || '').trim();
    const detail = state === 'error' && raw ? ` ${esc(/[.?]$/.test(raw) ? raw : raw + '.')}` : '';
    status.innerHTML = `<div>${msg}${detail} The numbers below stop where the tracker did.</div>` +
      (canFixPermission() ? '<button class="tiny fix" id="btn-visit-perm">Open Automation settings</button>' : '');
    const btn = $('btn-visit-perm');
    if (btn) btn.onclick = () => window.gazegate.openAutomationSettings();
  } else {
    status.style.display = 'none';
  }

  const empty = '<p class="hint">Nothing recorded yet.</p>';
  if (!v || !v.records) {
    $('h-visit-summary').textContent = 'Nothing recorded yet.';
    $('h-sites').innerHTML = '';
    $('h-first').innerHTML = empty;
    $('h-windows').innerHTML = empty;
    return;
  }

  // The headline. Partial and untracked windows are named here rather than
  // folded into the averages above them.
  const parts = [];
  if (v.completeWindows) {
    parts.push(`${dur(v.earnedSeconds)} earned and ${dur(v.usedSeconds)} used across ` +
      `${v.completeWindows} fully watched unlock${v.completeWindows === 1 ? '' : 's'}.`);
  } else {
    parts.push('No unlock has been watched end to end yet.');
  }
  if (v.partialWindows) parts.push(`${v.partialWindows} partial, left out of the averages.`);
  if (v.untrackedWindows) parts.push(`${v.untrackedWindows} not tracked at all.`);
  if (v.badLines) parts.push(`${v.badLines} unreadable line${v.badLines === 1 ? '' : 's'} skipped.`);
  $('h-visit-summary').textContent = parts.join(' ');

  const sPeak = Math.max(1, ...v.sites.map((s) => s.seconds));
  $('h-sites').innerHTML = v.sites.length ? v.sites.map((s) => `<div class="month-row"
      title="${esc(s.site)} · ${s.visits} visit${s.visits === 1 ? '' : 's'} across ${s.windows} unlock${s.windows === 1 ? '' : 's'}">
      <span class="name site">${esc(s.site)}</span>
      <span class="bar" style="width:${Math.round((s.seconds / sPeak) * 45)}%"></span>
      <span class="dur">${dur(s.seconds)}</span></div>`).join('') : empty;

  const fPeak = Math.max(1, ...v.firstTouch.map((f) => f.count));
  const firstRows = v.firstTouch.map((f) => `<div class="month-row">
      <span class="name site">${esc(f.site)}</span>
      <span class="bar" style="width:${Math.round((f.count / fPeak) * 45)}%"></span>
      <span class="n">${f.count} · ${Math.round(f.share * 100)}%</span></div>`);
  if (v.noTouchWindows) {
    firstRows.push(`<div class="month-row quiet">
      <span class="name site">nothing opened</span>
      <span class="n">${v.noTouchWindows} · ${Math.round((v.noTouchWindows / Math.max(1, v.completeWindows)) * 100)}%</span></div>`);
  }
  $('h-first').innerHTML = firstRows.length ? firstRows.join('') : empty;

  // Newest first, and only as far back as the panel is worth scrolling.
  const SHOWN = 40;
  const rows = v.windows.slice(0, SHOWN).map((w) => {
    const frac = w.grantedSeconds ? Math.min(1, w.usedSeconds / w.grantedSeconds) : 0;
    const detail = w.sites.length
      ? w.sites.map((s) => `${s.site} ${dur(s.seconds)}`).join(', ')
      : 'nothing opened';
    return `<div class="month-row${w.partial ? ' partial' : ''}" title="${esc(detail)}">
      <span class="when">${esc(w.date.slice(5))} ${esc(w.time)}</span>
      <span class="meter"><i style="width:${Math.round(frac * 100)}%"></i></span>
      <span class="dur">${dur(w.usedSeconds)} / ${w.grantedSeconds ? dur(w.grantedSeconds) : '—'}</span>
      ${w.partial ? '<span class="tag">partial</span>' : ''}</div>`;
  });
  if (v.windows.length > SHOWN) {
    rows.push(`<p class="hint" style="margin-top:6px">Showing the last ${SHOWN} of ${v.windows.length}.</p>`);
  }
  $('h-windows').innerHTML = rows.length ? rows.join('') : empty;
}

function paintHomeStats(st) {
  const box = $('stats');
  if (!st || !st.hasLog) { box.style.display = 'none'; return; }
  box.style.display = 'flex';
  $('st-today').textContent = st.today;
  $('st-week').textContent = st.week;
  $('st-all').textContent = st.allTime;

  drawClock(st.hours);

  // Current streak only. The best-ever number lives in the history view, where
  // it is context rather than a consolation prize on the screen you see daily.
  $('st-streak').innerHTML =
    `<b>${st.currentStreak}</b> clean day${st.currentStreak === 1 ? '' : 's'} in a row`;

  const last30 = st.days.slice(-30);
  $('st-dots').innerHTML = '';
  for (const d of last30) {
    const dot = document.createElement('div');
    dot.className = 'dot-day';
    dot.style.background = dayFill(d);
    dot.style.border = dayStroke(d);
    dot.title = `${d.date} · ${d.off ? 'blocker off' : d.count + ' unlocks'}`;
    $('st-dots').appendChild(dot);
  }

  paintHomeVisits(st.visits);
}

function paintHistory(st) {
  $('hist-since').textContent = `Since ${st.since}. ${st.allTime} unlocks, ${st.unlockMinutes} minutes each.`;
  $('h-all').textContent = st.allTime;
  $('h-clean').textContent = st.cleanDays;
  $('h-long').textContent = st.longestStreak;

  // Calendar, one column per week, Sunday at the top.
  const grid = $('h-grid');
  grid.innerHTML = '';
  let col = null;
  st.days.forEach((d, i) => {
    if (d.weekday === 0 || i === 0) {
      col = document.createElement('div');
      col.className = 'grid-col';
      // Pad the first column so weekdays line up across rows.
      if (i === 0) for (let k = 0; k < d.weekday; k++) {
        const blank = document.createElement('div');
        blank.className = 'grid-cell';
        col.appendChild(blank);
      }
      grid.appendChild(col);
    }
    const cell = document.createElement('div');
    cell.className = 'grid-cell';
    cell.style.background = dayFill(d);
    cell.style.border = dayStroke(d);
    cell.title = `${d.date} · ${d.off ? 'blocker off' : d.count + ' unlocks'}`;
    col.appendChild(cell);
  });

  const peak = Math.max(1, ...st.hours);
  $('h-hours').innerHTML = st.hours.map((n, h) =>
    `<div class="hour-bar${n ? '' : ' empty'}" style="height:${n ? Math.round((n / peak) * 100) : 2}%" title="${h}:00 · ${n}"></div>`
  ).join('');
  if (!$('h-hours').nextElementSibling?.classList.contains('hour-axis')) {
    const axis = document.createElement('div');
    axis.className = 'hour-axis';
    axis.innerHTML = '<span>12a</span><span>6a</span><span>12p</span><span>6p</span><span>11p</span>';
    $('h-hours').after(axis);
  }

  const byMonth = new Map();
  for (const d of st.days) {
    const k = d.date.slice(0, 7);
    byMonth.set(k, (byMonth.get(k) || 0) + d.count);
  }
  const mPeak = Math.max(1, ...byMonth.values());
  $('h-months').innerHTML = [...byMonth.entries()].map(([k, n]) => {
    const name = new Date(k + '-01T00:00:00').toLocaleString('en-US', { month: 'long', year: 'numeric' });
    return `<div class="month-row"><span class="name">${name}</span>
      <span class="bar" style="width:${Math.round((n / mPeak) * 60)}%"></span>
      <span class="n">${n}</span></div>`;
  }).join('');

  paintVisits(st.visits);

  $('h-outages').innerHTML = st.outages.length
    ? st.outages.map(o => {
        const len = o.minutes >= 60 ? `${Math.round(o.minutes / 60)}h` : `${o.minutes}m`;
        return `<div class="month-row"><span class="name">${o.start}</span>
          <span class="n">${len}</span></div>`;
      }).join('')
    : '<p class="hint">None recorded.</p>';
}

$('stats').onclick = async () => {
  const st = await window.gazegate.getStats();
  if (!st.hasLog) return;
  await refreshVisitStatus(true).catch(() => {});
  paintHistory(st);
  showView('history');
};

$('btn-history-back').onclick = () => showTab('home');

window.gazegate.onNavigate((view) => {
  if (view === 'gate-unlock') startUnlock();
  else if (view === 'pomodoro') showTab('pomodoro');
  // Clicking the menu bar while a countdown is showing means you came for the
  // countdown, so open on it rather than on the blocker.
  else showTab(pomo && pomo.status !== 'idle' ? 'pomodoro' : 'home');
});

// ---------- focus timer ----------
// The countdown itself belongs to the main process. Everything here paints
// what it is told and sends button presses back. It never touches the blocker.

const POMO_LABEL = { focus: 'Focus', break: 'Break', long: 'Long break' };
const DIAL_C = 2 * Math.PI * 88;
let pomo = null;
let configOpen = false;

const clock = (sec) => {
  const m = Math.floor(Math.max(0, sec) / 60);
  const s = Math.max(0, sec) % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
};

function showTab(name) {
  document.querySelectorAll('.tabs button').forEach(b =>
    b.classList.toggle('on', b.dataset.tab === name));
  showView(name);
  if (name === 'pomodoro') window.gazegate.pomoGet().then(paintPomodoro);
  if (name === 'noise') paintNoiseList();
}
document.querySelectorAll('.tabs button').forEach(b => {
  b.onclick = () => showTab(b.dataset.tab);
});

function paintPomodoro(s) {
  if (!s) return;
  pomo = s;
  const counting = s.status === 'running' || s.status === 'paused';
  const phase = counting ? s.phase : s.next;

  $('pomo-phase').textContent = POMO_LABEL[phase] + (s.status === 'paused' ? ' · paused' : '');
  $('pomo-phase').className = 'pomo-phase' + (phase === 'focus' ? ' focus' : '');
  $('pomo-time').textContent = clock(s.remainingSec);

  const frac = s.totalSec ? Math.max(0, Math.min(1, s.remainingSec / s.totalSec)) : 1;
  const arc = $('pomo-arc');
  arc.setAttribute('stroke-dasharray', DIAL_C);
  arc.setAttribute('stroke-dashoffset', String(DIAL_C * (1 - frac)));
  arc.classList.toggle('rest', phase !== 'focus');

  // Dots for where you are in the cycle. A finished fourth block fills all four
  // rather than wrapping straight back to none.
  const per = s.config.roundsBeforeLong;
  const done = s.round === 0 ? 0 : ((s.round - 1) % per) + 1;
  $('pomo-rounds').innerHTML = Array.from({ length: per },
    (_, i) => `<div class="round-dot${i < done ? ' done' : ''}"></div>`).join('');

  const note = $('pomo-note');
  if (s.status === 'running') {
    const end = new Date(Date.now() + s.remainingSec * 1000);
    note.textContent = 'Ends at ' + end.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } else if (s.status === 'paused') {
    note.textContent = 'Paused. The clock is stopped.';
  } else if (s.status === 'done') {
    note.textContent = s.phase === 'focus' ? 'Focus block done.' : 'Break over.';
  } else {
    note.textContent = `${s.config.focusMinutes} minutes, then a ${s.config.breakMinutes} minute break.`;
  }

  $('pomo-today').textContent = s.completedToday
    ? `${s.completedToday} focus block${s.completedToday === 1 ? '' : 's'} today`
    : '';

  $('btn-pomo-primary').textContent =
    s.status === 'running' ? 'Pause'
    : s.status === 'paused' ? 'Resume'
    : `Start ${POMO_LABEL[s.next].toLowerCase()}`;
  $('btn-pomo-reset').disabled = s.status === 'idle';

  if (!configOpen) fillPomoConfig(s.config);
}

function fillPomoConfig(c) {
  $('pomo-focus').value = c.focusMinutes;
  $('pomo-break').value = c.breakMinutes;
  $('pomo-long').value = c.longBreakMinutes;
  $('pomo-rounds-n').value = c.roundsBeforeLong;
  const sel = $('pomo-sound');
  if (sel.value !== c.sound && [...sel.options].some(o => o.value === c.sound)) sel.value = c.sound;
}

$('btn-pomo-primary').onclick = async () => {
  const s = pomo && pomo.status === 'running'
    ? await window.gazegate.pomoPause()
    : await window.gazegate.pomoStart();
  paintPomodoro(s);
};
$('btn-pomo-reset').onclick = async () => paintPomodoro(await window.gazegate.pomoReset());

$('btn-pomo-config').onclick = () => {
  configOpen = !configOpen;
  show('pomo-config', configOpen);
  $('view-pomodoro').classList.toggle('configuring', configOpen);
  $('btn-pomo-config').textContent = configOpen ? 'Done' : 'Lengths & sound';
  if (configOpen && pomo) fillPomoConfig(pomo.config);
};

async function savePomoConfig() {
  const s = await window.gazegate.pomoSetConfig({
    focusMinutes: $('pomo-focus').value,
    breakMinutes: $('pomo-break').value,
    longBreakMinutes: $('pomo-long').value,
    roundsBeforeLong: $('pomo-rounds-n').value,
    sound: $('pomo-sound').value,
  });
  // The main process clamps, so paint back whatever it actually kept.
  paintPomodoro(s);
  fillPomoConfig(s.config);
}
['pomo-focus', 'pomo-break', 'pomo-long', 'pomo-rounds-n', 'pomo-sound']
  .forEach(id => { $(id).onchange = savePomoConfig; });

$('btn-pomo-test').onclick = () => window.gazegate.pomoTestSound($('pomo-sound').value);

// Pushed from the main process on every displayed second, so the panel and the
// menu bar can never disagree about how much time is left.
window.gazegate.onPomodoro(paintPomodoro);

async function bootPomodoro() {
  const names = await window.gazegate.pomoSounds();
  $('pomo-sound').innerHTML = names.map(n => `<option value="${n}">${n}</option>`).join('');
  paintPomodoro(await window.gazegate.pomoGet());
}

// ---------- sound library ----------
// Playback lives here rather than in the main process because only Web Audio
// can loop a buffer without a seam. The window is hidden, never closed, when
// you click away, so a loop keeps running while the panel is out of sight.

let audioCtx = null;      // created on the first play, so no suspended context sits idle
let masterGain = null;    // volume
let current = null;       // { src, gain } of whatever is playing
let playingId = null;
let noiseVolume = 0.6;
let noiseEntries = [];
// Decoded audio is big — a three minute stereo track is about 70MB of PCM —
// so only the playing track and the one before it are kept. This is a menu bar
// app that runs all day; caching all eight would be a couple hundred MB.
const buffers = new Map();
const BUFFER_CACHE = 2;
const FADE = 0.6;         // seconds, long enough that starting a loop is not a click

// A linear slider that behaves like a volume knob rather than jumping to loud
// in the first third of its travel.
const volCurve = (v) => v * v;

function ensureAudio() {
  if (!audioCtx) {
    audioCtx = new AudioContext();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = volCurve(noiseVolume);
    masterGain.connect(audioCtx.destination);
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function remember(id, buf) {
  buffers.delete(id);
  buffers.set(id, buf); // re-inserting puts it last, so the map is in use order
  for (const key of [...buffers.keys()]) {
    if (buffers.size <= BUFFER_CACHE) break;
    if (key === id || key === playingId) continue;
    buffers.delete(key);
  }
}

async function loadBuffer(id) {
  if (buffers.has(id)) {
    const hit = buffers.get(id);
    remember(id, hit);
    return hit;
  }
  const bytes = await window.gazegate.noiseRead(id);
  if (!bytes || !bytes.byteLength) throw new Error('file missing');
  // The IPC copy arrives as a view into a larger buffer; decodeAudioData wants
  // its own ArrayBuffer, and it detaches whatever it is given.
  const arr = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const buf = await ensureAudio().decodeAudioData(arr);
  remember(id, buf);
  return buf;
}

function fadeOut(node) {
  if (!node) return;
  const t = audioCtx.currentTime;
  node.gain.gain.cancelScheduledValues(t);
  node.gain.gain.setValueAtTime(node.gain.gain.value, t);
  node.gain.gain.linearRampToValueAtTime(0.0001, t + FADE);
  // Stopping before the ramp finishes is what makes a click.
  setTimeout(() => { try { node.src.stop(); node.src.disconnect(); } catch {} }, FADE * 1000 + 120);
}

async function playNoise(id) {
  ensureAudio();
  let buf;
  try {
    buf = await loadBuffer(id);
  } catch (e) {
    const row = document.querySelector(`.sound[data-id="${id}"] span`);
    if (row) row.textContent = 'Could not play that file';
    return;
  }
  fadeOut(current);
  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  const gain = audioCtx.createGain();
  gain.gain.value = 0.0001;
  src.connect(gain).connect(masterGain);
  src.start();
  gain.gain.linearRampToValueAtTime(1, audioCtx.currentTime + FADE);
  current = { src, gain };
  playingId = id;
  window.gazegate.noisePlaying(id);
  window.gazegate.noiseSetConfig({ lastId: id });
  paintNoiseList();
}

function stopNoise() {
  fadeOut(current);
  current = null;
  playingId = null;
  window.gazegate.noisePlaying(null);
  paintNoiseList();
}

function paintNoiseList() {
  const ul = $('noise-list');
  if (!ul) return;
  ul.innerHTML = noiseEntries.map((e) => {
    const note = !e.available
      ? (e.id === 'home' ? 'Drop a file named home into the sounds folder' : 'File missing')
      : (e.custom && e.id !== 'home') ? e.note + ' · your file'
      : e.note;
    return `<li class="sound${e.id === playingId ? ' on' : ''}${e.available ? '' : ' off'}" data-id="${e.id}">
      <div class="sound-main"><b>${e.name}</b><span>${note}</span></div>
      <div class="bars"><i></i><i></i><i></i></div>
    </li>`;
  }).join('');
  ul.querySelectorAll('.sound').forEach((li) => {
    if (li.classList.contains('off')) return;
    li.onclick = () => (li.dataset.id === playingId ? stopNoise() : playNoise(li.dataset.id));
  });
  $('btn-noise-stop').disabled = !playingId;
  // Eight tracks do not quite fit, and the one playing is the one you want to
  // see — particularly Home, which sits at the bottom.
  const active = ul.querySelector('.sound.on');
  if (active && currentView === 'noise') active.scrollIntoView({ block: 'nearest' });
}

$('noise-vol').oninput = () => {
  noiseVolume = Number($('noise-vol').value) / 100;
  $('noise-vol-n').textContent = String(Math.round(noiseVolume * 100));
  if (masterGain) masterGain.gain.value = volCurve(noiseVolume);
};
$('noise-vol').onchange = () => window.gazegate.noiseSetConfig({ volume: noiseVolume });

$('btn-noise-stop').onclick = () => stopNoise();
$('btn-noise-folder').onclick = () => window.gazegate.noiseFolder();

// The tray can stop playback without the panel being open.
window.gazegate.onNoiseStop(() => stopNoise());

async function bootNoise() {
  const [entries, cfg] = await Promise.all([
    window.gazegate.noiseList(),
    window.gazegate.noiseConfig(),
  ]);
  noiseEntries = entries;
  noiseVolume = cfg.volume;
  $('noise-vol').value = Math.round(noiseVolume * 100);
  $('noise-vol-n').textContent = String(Math.round(noiseVolume * 100));
  paintNoiseList();
}

// boot
bootNoise();
bootPomodoro();
refresh().then(startStatusPolling);
