// noise.js — the sound library's half in the main process. It resolves which
// files exist, hands their bytes to the renderer, and remembers the volume.
//
// Playback itself lives in the renderer, because Web Audio is the only thing
// here that can loop a buffer without a seam. The window is hidden rather than
// closed when you click away, so the audio keeps running.
//
// Like the focus timer, this touches nothing the blocker depends on.

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// Order is the order they appear in the panel. `note` is the one-line
// description under the name.
const LIBRARY = [
  { id: 'rain',   name: 'Rain',        note: 'Steady, thunder filtered out' },
  { id: 'ocean',  name: 'Ocean',       note: 'Waves on a beach' },
  { id: 'stream', name: 'Stream',      note: 'Water close over rocks' },
  { id: 'wind',   name: 'Wind',        note: 'Gusting. Synthesized, not recorded' },
  { id: 'brown',  name: 'Brown noise', note: 'Deep and dull, the usual pick' },
  { id: 'white',  name: 'White noise', note: 'Bright and flat' },
  { id: 'home',   name: 'Home',        note: 'Your own track' },
];

// Bundled first, then a folder you can drop files into without rebuilding.
// `home` is expected to arrive that way, but any id can be overridden.
const EXTS = ['.ogg', '.opus', '.mp3', '.m4a', '.aac', '.wav', '.flac'];

const DEFAULTS = { volume: 0.6, lastId: null };
let cfg = { ...DEFAULTS };

function userSoundDir() {
  return path.join(app.getPath('userData'), 'sounds');
}

function bundledDir() {
  return path.join(__dirname, 'assets', 'sounds');
}

function locate(id) {
  for (const dir of [userSoundDir(), bundledDir()]) {
    for (const ext of EXTS) {
      const p = path.join(dir, id + ext);
      try { if (fs.statSync(p).isFile()) return p; } catch {}
    }
  }
  return null;
}

// A user file wins over the bundled one, so replacing the synthesized wind with
// a real recording is a matter of dropping a file in.
function list() {
  return LIBRARY.map((entry) => {
    const file = locate(entry.id);
    return {
      ...entry,
      available: !!file,
      custom: !!file && file.startsWith(userSoundDir()),
    };
  });
}

function read(id) {
  if (!LIBRARY.some((e) => e.id === id)) return null;
  const file = locate(id);
  if (!file) return null;
  return fs.readFileSync(file);
}

function configFile() {
  return path.join(app.getPath('userData'), 'noise.json');
}

function load() {
  try {
    const saved = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
    const v = Number(saved.volume);
    if (Number.isFinite(v)) cfg.volume = Math.min(1, Math.max(0, v));
    if (typeof saved.lastId === 'string') cfg.lastId = saved.lastId;
  } catch { /* first run */ }
}

function save() {
  try { fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2)); } catch {}
}

function setConfig(patch) {
  if (patch && patch.volume != null) {
    const v = Number(patch.volume);
    if (Number.isFinite(v)) cfg.volume = Math.min(1, Math.max(0, v));
  }
  if (patch && 'lastId' in patch) cfg.lastId = patch.lastId || null;
  save();
  return { ...cfg };
}

function config() { return { ...cfg }; }

// What the renderer says is playing right now, so the tray can offer to stop it
// without opening the panel. Set from the renderer, never inferred.
let playing = null;
function setPlaying(id) { playing = id || null; }
function nowPlaying() {
  if (!playing) return null;
  const entry = LIBRARY.find((e) => e.id === playing);
  return entry ? { id: entry.id, name: entry.name } : null;
}

function init() {
  load();
  try { fs.mkdirSync(userSoundDir(), { recursive: true }); } catch {}
}

module.exports = { init, list, read, config, setConfig, setPlaying, nowPlaying, userSoundDir };
