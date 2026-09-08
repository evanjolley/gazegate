# Sound credits

Everything in `assets/sounds` is public domain or generated, so it ships with
the app under the same MIT license as the code. Rebuild with
`python3 scripts/build-sounds.py`.

## Field recordings

**Rain** (`rain.ogg`)

- Source https://commons.wikimedia.org/wiki/File:Light_Rain_Distant_Thunder_July_5th_2016.wav
- By kvgarlic (freesound.org)
- License CC0 1.0
- Trimmed from 11s, 90s loop, crossfaded 3s, filtered `highpass=f=130,highpass=f=130`, normalized to -20.0 LUFS

**Ocean** (`ocean.ogg`)

- Source https://commons.wikimedia.org/wiki/File:Ocean_Waves_on_a_Tropical_Beach.ogg
- By Jarrod Stanley
- License CC0 1.0
- Trimmed from 237s, 90s loop, crossfaded 3s, filtered `highpass=f=40`, normalized to -20.0 LUFS

**Stream** (`stream.ogg`)

- Source https://commons.wikimedia.org/wiki/File:433589_jackthemurray_stream-river-water-up-close.wav
- By jackthemurray (freesound.org)
- License CC0 1.0
- Trimmed from 0s, 60s loop, crossfaded 3s, filtered `highpass=f=60`, normalized to -20.0 LUFS

## Generated

Built by ffmpeg in `scripts/build-sounds.py`, no third-party material.

**Brown noise** (`brown.ogg`) — `anoisesrc=color=brown:amplitude=0.8` through `highpass=f=30`, 30s loop

**White noise** (`white.ogg`) — `anoisesrc=color=white:amplitude=0.4` through `highpass=f=30`, 30s loop

**Wind** (`wind.ogg`) — `anoisesrc=color=brown:amplitude=0.9` through `highpass=f=80,lowpass=f=1100,tremolo=f=0.11:d=0.6,tremolo=f=0.17:d=0.4`, 60s loop

## Home

`home.ogg` is not in this repo. GazeGate looks for a file named `home` (`.ogg`, `.mp3`, `.m4a`, `.wav`, `.flac`) in `assets/sounds` inside the app bundle, and failing that in `~/Library/Application Support/GazeGate/sounds`, so you can drop one in without rebuilding.
