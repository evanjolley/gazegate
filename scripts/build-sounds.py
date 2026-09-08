#!/usr/bin/env python3
"""Builds assets/sounds from public-domain field recordings and synthesis.

Everything shipped in assets/sounds is either CC0 / public domain material from
Wikimedia Commons or generated here by ffmpeg, so the whole library can be
redistributed with the repo. Rerun with `python3 scripts/build-sounds.py`.
Sources are cached, so a rerun is cheap.

Each track is made into a seamless loop by overlapping a few seconds of the
material that follows the loop body onto its head with an equal-power
crossfade. The end of the file then runs straight into its own beginning, and
Ogg Opus is used rather than MP3 because MP3's encoder padding puts a silent
gap at every loop point, while Opus records its pre-skip in the header and the
decoder removes it.
"""
import json, os, re, shutil, subprocess, sys, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'assets', 'sounds')
CACHE = os.path.join(ROOT, '.sound-cache')
UA = {'User-Agent': 'GazeGate-asset-build/1.0 (https://github.com/evanjolley/gazegate)'}
TARGET_LUFS = -20.0

# Field recordings. start/length/fade are in seconds; `filters` runs before the
# loop is cut. Rain gets a high pass because the source carries distant thunder,
# and a thunderclap repeating on a 90 second cycle is maddening.
RECORDINGS = [
    dict(id='rain', name='Rain',
         url='https://upload.wikimedia.org/wikipedia/commons/b/b6/Light_Rain_Distant_Thunder_July_5th_2016.wav',
         page='https://commons.wikimedia.org/wiki/File:Light_Rain_Distant_Thunder_July_5th_2016.wav',
         author='kvgarlic (freesound.org)', license='CC0 1.0',
         start=11, length=90, fade=3, filters='highpass=f=130,highpass=f=130'),
    dict(id='ocean', name='Ocean',
         url='https://upload.wikimedia.org/wikipedia/commons/6/64/Ocean_Waves_on_a_Tropical_Beach.ogg',
         page='https://commons.wikimedia.org/wiki/File:Ocean_Waves_on_a_Tropical_Beach.ogg',
         author='Jarrod Stanley', license='CC0 1.0',
         start=237, length=90, fade=3, filters='highpass=f=40'),
    dict(id='stream', name='Stream',
         url='https://upload.wikimedia.org/wikipedia/commons/5/54/433589_jackthemurray_stream-river-water-up-close.wav',
         page='https://commons.wikimedia.org/wiki/File:433589_jackthemurray_stream-river-water-up-close.wav',
         author='jackthemurray (freesound.org)', license='CC0 1.0',
         start=0, length=60, fade=3, filters='highpass=f=60'),
]

# Generated. No clean-licensed wind recording exists on Commons, so wind is
# built the way wind actually sounds, filtered noise gusting on two slow
# out-of-step cycles so the gusts never line up the same way twice.
GENERATED = [
    dict(id='brown', name='Brown noise', length=30, fade=2,
         src='anoisesrc=color=brown:amplitude=0.8', filters='highpass=f=30'),
    dict(id='pink', name='Pink noise', length=30, fade=2,
         src='anoisesrc=color=pink:amplitude=0.5', filters='highpass=f=30'),
    dict(id='white', name='White noise', length=30, fade=2,
         src='anoisesrc=color=white:amplitude=0.4', filters='highpass=f=30'),
    dict(id='wind', name='Wind', length=60, fade=3,
         src='anoisesrc=color=brown:amplitude=0.9',
         filters='highpass=f=80,lowpass=f=1100,tremolo=f=0.11:d=0.6,tremolo=f=0.17:d=0.4'),
]


def run(args, **kw):
    p = subprocess.run(args, capture_output=True, text=True, **kw)
    if p.returncode != 0:
        sys.exit(f"failed: {' '.join(args[:6])}…\n{p.stderr[-1500:]}")
    return p


def fetch(url, dest):
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return dest
    print(f"  downloading {os.path.basename(dest)}")
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=180) as r, open(dest, 'wb') as f:
        shutil.copyfileobj(r, f)
    return dest


def loop_filter(length, fade, pre=''):
    """Overlap the material after the loop body onto its head.

    body is [0, length), tail is [length, length+fade). The tail is faded out
    over the head's fade in, so the last sample of the result leads straight
    into the first. Quarter-sine curves keep the power constant across the
    overlap, which a linear fade would dip through.
    """
    pre = (pre + ',') if pre else ''
    return (
        f"[0:a]{pre}asplit=2[src1][src2];"
        f"[src1]atrim=0:{length},asetpts=PTS-STARTPTS,asplit=2[b1][b2];"
        f"[src2]atrim={length}:{length + fade},asetpts=PTS-STARTPTS,"
        f"afade=t=out:st=0:d={fade}:curve=qsin[tail];"
        f"[b1]atrim=0:{fade},asetpts=PTS-STARTPTS,afade=t=in:st=0:d={fade}:curve=qsin[head];"
        f"[b2]atrim={fade},asetpts=PTS-STARTPTS[rest];"
        f"[head][tail]amix=inputs=2:normalize=0[mixed];"
        f"[mixed][rest]concat=n=2:v=0:a=1[looped]"
    )


def measure_lufs(path):
    p = subprocess.run(
        ['ffmpeg', '-v', 'info', '-i', path, '-af', 'loudnorm=print_format=json', '-f', 'null', '-'],
        capture_output=True, text=True)
    m = re.findall(r'\{[^{}]*"input_i"[^{}]*\}', p.stderr, re.S)
    if not m:
        return None
    return float(json.loads(m[-1])['input_i'])


def normalize(src, dest):
    """Fixed gain to a common loudness, so switching tracks does not jump.

    A gain rather than loudnorm's compressor: these are backgrounds, and
    squashing their dynamics is what makes a loop sound like a loop.
    """
    lufs = measure_lufs(src)
    gain = 0.0 if lufs is None else TARGET_LUFS - lufs
    print(f"    measured {lufs:.1f} LUFS, applying {gain:+.1f} dB")
    run(['ffmpeg', '-y', '-v', 'error', '-i', src,
         '-af', f'volume={gain:.2f}dB,alimiter=limit=0.95:level=disabled',
         '-c:a', 'libopus', '-b:a', '96k', '-application', 'audio',
         '-ar', '48000', '-ac', '2', dest])


def build_recording(spec):
    print(f"  {spec['id']}")
    src = fetch(spec['url'], os.path.join(CACHE, spec['id'] + os.path.splitext(spec['url'])[1]))
    raw = os.path.join(CACHE, spec['id'] + '.loop.wav')
    span = spec['length'] + spec['fade']
    run(['ffmpeg', '-y', '-v', 'error', '-ss', str(spec['start']), '-t', str(span), '-i', src,
         '-filter_complex', loop_filter(spec['length'], spec['fade'], spec.get('filters', '')),
         '-map', '[looped]', raw])
    normalize(raw, os.path.join(OUT, spec['id'] + '.ogg'))


def build_generated(spec):
    print(f"  {spec['id']}")
    raw = os.path.join(CACHE, spec['id'] + '.loop.wav')
    span = spec['length'] + spec['fade']
    # Stereo from two independent noise seeds, so it has width instead of
    # sitting as a hard point between your ears.
    src = (f"{spec['src']}:seed=1:duration={span}[n1];"
           f"{spec['src']}:seed=2:duration={span}[n2];"
           f"[n1][n2]join=inputs=2:channel_layout=stereo[j]")
    run(['ffmpeg', '-y', '-v', 'error', '-filter_complex',
         src + ';' + loop_filter(spec['length'], spec['fade'], spec.get('filters', '')).replace('[0:a]', '[j]'),
         '-map', '[looped]', raw])
    normalize(raw, os.path.join(OUT, spec['id'] + '.ogg'))


def write_credits():
    lines = ["# Sound credits", "",
             "Everything in `assets/sounds` is public domain or generated, so it ships with",
             "the app under the same MIT license as the code. Rebuild with",
             "`python3 scripts/build-sounds.py`.", "", "## Field recordings", ""]
    for s in RECORDINGS:
        lines += [f"**{s['name']}** (`{s['id']}.ogg`)", "",
                  f"- Source {s['page']}", f"- By {s['author']}", f"- License {s['license']}",
                  f"- Trimmed from {s['start']}s, {s['length']}s loop, crossfaded {s['fade']}s, "
                  f"filtered `{s.get('filters', 'none')}`, normalized to {TARGET_LUFS} LUFS", ""]
    lines += ["## Generated", "",
              "Built by ffmpeg in `scripts/build-sounds.py`, no third-party material.", ""]
    for s in GENERATED:
        lines += [f"**{s['name']}** (`{s['id']}.ogg`) — `{s['src']}` through `{s.get('filters','')}`, "
                  f"{s['length']}s loop", ""]
    lines += ["## Home", "",
              "`home.ogg` is not in this repo. GazeGate looks for a file named `home` "
              "(`.ogg`, `.mp3`, `.m4a`, `.wav`, `.flac`) in `assets/sounds` inside the app "
              "bundle, and failing that in `~/Library/Application Support/GazeGate/sounds`, "
              "so you can drop one in without rebuilding.", ""]
    with open(os.path.join(OUT, 'CREDITS.md'), 'w') as f:
        f.write("\n".join(lines))


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    os.makedirs(CACHE, exist_ok=True)
    print("field recordings")
    for spec in RECORDINGS:
        build_recording(spec)
    print("generated")
    for spec in GENERATED:
        build_generated(spec)
    write_credits()
    total = sum(os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT) if f.endswith('.ogg'))
    print(f"\n{len([f for f in os.listdir(OUT) if f.endswith('.ogg')])} tracks, {total/1e6:.1f} MB total")
