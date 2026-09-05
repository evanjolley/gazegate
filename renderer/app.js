import { FaceLandmarker, FilesetResolver }
  from '../node_modules/@mediapipe/tasks-vision/vision_bundle.mjs';

// ---- tunable thresholds ----
// How long you must hold is user-configurable now; the main process owns the
// value and enforces the floor, this is just the last-synced copy.
let gateSeconds = 30;
let minGateSeconds = 30;
const requiredMs = () => gateSeconds * 1000;

const GRACE_MS    = 700;     // allowed lapse (blinks) before progress resets
const HEAD_YAW_MAX   = 0.38; // rad, left/right head turn
const HEAD_PITCH_MAX = 0.34; // rad, up/down head tilt
const GAZE_MAX  = 0.55;      // eye-look blendshape score away from center
const BLINK_MAX = 0.55;

const $ = (id) => document.getElementById(id);
const show = (id, on) => { $(id).style.display = on ? '' : 'none'; };
const views = ['install', 'home', 'gate', 'settings'];
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
  minGateSeconds = s.minGateSeconds;

  show('update-banner', s.needsUpdate);

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

  let stream, video = $('video'), ctx = $('ring').getContext('2d');
  try {
    await loadModel();
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
    video.srcObject = stream;
    await video.play();
  } catch (e) {
    $('gate-status').textContent = 'Camera error: ' + (e.message || e);
    $('gate-status').className = 'gate-status bad';
    return false;
  }

  gateActive = true;
  let held = 0, badSince = null, lastTs = performance.now(), lastVideoTs = -1;
  let okState = false, lastEv = null;

  return new Promise((resolve) => {
    const cleanup = (result) => {
      gateActive = false;
      if (stream) stream.getTracks().forEach(t => t.stop());
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
  $('gate-seconds').value = gateSeconds;
  $('gate-seconds').min = minGateSeconds;
  $('min-gate').textContent = minGateSeconds;
  $('gate-msg').textContent = '';
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

// Longer is free. Shorter is an escape, so it costs one stare at the *current*
// length — same rule the Sunday buttons follow.
$('btn-save-gate').onclick = async () => {
  const msg = $('gate-msg');
  const want = Math.round(Number($('gate-seconds').value));
  if (!Number.isFinite(want) || want < minGateSeconds) {
    msg.style.color = 'var(--danger)';
    msg.textContent = `Minimum is ${minGateSeconds} seconds.`;
    $('gate-seconds').value = gateSeconds;
    return;
  }
  if (want === gateSeconds) { msg.style.color = ''; msg.textContent = 'Unchanged.'; return; }

  if (want < gateSeconds) {
    const from = gateSeconds;
    const passed = await runGate('settings', 'Eye contact to shorten the stare',
      `Going from ${from}s down to ${want}s makes this easier on you. Hold ${from} seconds first.`);
    if (!passed) {
      showView('settings');
      $('gate-seconds').value = gateSeconds;
      msg.style.color = 'var(--danger)';
      msg.textContent = 'Not changed — the stare was not completed.';
      return;
    }
    showView('settings');
  }

  const r = await window.gazegate.setGateSeconds(want);
  gateSeconds = r.gateSeconds;
  $('gate-seconds').value = gateSeconds;
  msg.style.color = 'var(--accent)';
  msg.textContent = `Saved — ${gateSeconds} seconds.`;
};

$('btn-quit').onclick = async () => {
  // No gate. The daemon is root and independent, so quitting cannot unblock
  // anything — it only removes the way to unlock, which is strictly stricter.
  // Gating this would punish the safe direction.
  await window.gazegate.gatePassed('quit');
};

$('btn-uninstall').onclick = async () => {
  const passed = await runGate('uninstall', 'Eye contact to turn it all off', `This removes blocking entirely and unblocks every site. ${gateSeconds} seconds.`);
  if (passed) await window.gazegate.gatePassed('uninstall');
  else showView('settings');
};

window.gazegate.onNavigate((view) => {
  if (view === 'gate-unlock') $('btn-unlock').click();
  else showView('home');
});

// boot
refresh().then(startStatusPolling);
