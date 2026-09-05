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
const views = ['install', 'home', 'gate', 'settings', 'history'];
let currentView = null;
function showView(name) {
  currentView = name;
  views.forEach(v => $(`view-${v}`).classList.toggle('active', v === name));
}

// ---------- status / home ----------
let statusTimer = null;
async function refresh() {
  const s = await window.gazegate.getStatus();
  if (!s.installed) { showView('install'); return; }

  // Land on home from a cold boot (nothing shown yet) or straight after install.
  // Any other view — gate, settings — is the user's, so polling must not steal it.
  if (currentView === null || currentView === 'install') showView('home');

  gateSeconds = s.gateSeconds;
  baseGateSeconds = s.baseGateSeconds;
  minGateSeconds = s.minGateSeconds;
  maxGateSeconds = s.maxGateSeconds;
  escalate = s.escalate;

  show('update-banner', s.needsUpdate);
  window.gazegate.getStats().then(paintHomeStats).catch(() => {});

  const badge = $('status-badge');
  const setBadge = (cls, label) =>
    badge.innerHTML = `<span class="dot ${cls}"></span><span>${label}</span>`;

  // reset, then enable per mode
  show('countdown-wrap', false);
  show('sunday-note', false);
  show('btn-unlock', false);
  show('btn-sunday-block', false);
  show('btn-sunday-open', false);
  show('btn-lock', true);

  switch (s.mode) {
    case 'unlocked': {
      setBadge('unlocked', 'Unlocked');
      show('countdown-wrap', true);
      const m = Math.floor(s.remaining / 60), sec = s.remaining % 60;
      $('countdown').textContent = `${m}:${String(sec).padStart(2, '0')}`;
      show('btn-unlock', true);
      $('btn-unlock').textContent = `Unlock again — hold eye contact ${gateSeconds}s`;
      break;
    }
    case 'sunday-open':
      setBadge('unlocked', 'Sunday — open all day');
      show('sunday-note', true);
      show('btn-sunday-block', true);
      show('btn-lock', false);
      break;
    case 'sunday-blocked':
      setBadge('blocked', 'Blocked · on for today');
      show('btn-unlock', true);
      $('btn-unlock').textContent = `Unlock — hold eye contact ${gateSeconds}s`;
      show('btn-sunday-open', true);
      show('btn-lock', false);
      break;
    default: // 'blocked'
      setBadge('blocked', 'Blocked');
      show('btn-unlock', true);
      $('btn-unlock').textContent = `Unlock — hold eye contact ${gateSeconds}s`;
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
  if (r.ok) { await refresh(); showView('home'); }
  else {
    $('install-err').textContent = r.error || 'Install failed';
    $('btn-install').disabled = false;
    $('btn-install').textContent = 'Install & start blocking';
  }
};

$('btn-unlock').onclick = async () => {
  const passed = await runGate('unlock', 'Hold eye contact', `Look straight into the lens for ${gateSeconds} seconds. Look away and it resets.`);
  if (passed) { await window.gazegate.gatePassed('unlock'); }
  await refresh();
  showView('home');
};

$('btn-lock').onclick = async () => { await window.gazegate.lockNow(); await refresh(); };

$('btn-update').onclick = async () => {
  $('btn-update').textContent = 'Applying…';
  const r = await window.gazegate.updateDaemon();
  if (r.ok) await refresh();
  else $('btn-update').textContent = 'Update failed — retry';
};

// Sunday: re-arm blocking for the rest of today — no gate (making it stricter is free).
$('btn-sunday-block').onclick = async () => {
  await window.gazegate.sundayBlock();
  await refresh();
};

// Sunday: undo that and open back up — gated, since it's an escape.
$('btn-sunday-open').onclick = async () => {
  const passed = await runGate('sunday-open', 'Eye contact to open Sunday',
    `You turned blocking on for today. Opening back up needs ${gateSeconds} seconds of eye contact.`);
  if (passed) await window.gazegate.sundayClear();
  await refresh();
  showView('home');
};

$('btn-settings').onclick = async () => {
  const passed = await runGate('settings', 'Eye contact to open settings', `Changing what gets blocked needs the same commitment. ${gateSeconds} seconds.`);
  if (!passed) { showView('home'); return; }
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

$('btn-settings-back').onclick = () => showView('home');

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
  paintHistory(st);
  showView('history');
};

$('btn-history-back').onclick = () => showView('home');

window.gazegate.onNavigate((view) => {
  if (view === 'gate-unlock') $('btn-unlock').click();
  else showView('home');
});

// boot
refresh().then(startStatusPolling);
