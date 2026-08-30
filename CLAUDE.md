# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

ShredType — a local, single-page web app that listens to a guitar through the mic/audio-interface
input and only advances a scrolling tab when the correct note is actually played (pitch-detected),
not on a timer or keyboard input. Spotify-styled dark UI. No build step, no framework, no dependencies.

## Commands

- Run the app: `node server.js` from this directory, then open `http://localhost:5173`
  (`server.js` is a zero-dependency static file server; there is no build/lint/test tooling).
- There are no automated tests. Verification so far has been manual, in Chrome, including
  feeding synthetic tones/noise through a fake `MediaStream` (bypassing `getUserMedia`) to test
  the pitch-detection pipeline without needing a physical mic — see "Testing without hardware" below.

## Architecture

Three files, no modules/bundler: `index.html` (structure/screens), `style.css` (Spotify-style dark
theme), `app.js` (all logic, plain globals/objects, loaded as a single script).

**Screens** (`Screens.show(id)` toggles `.active` on `#screen-<id>`):
- `menu` — song grid, loaded from `songs/manifest.json` + one JSON file per song.
- `play` — the practice screen. Has sub-states toggled by hiding/showing divs rather than
  separate screens: `mic-gate` → `calibration-panel` → `play-surface` → `play-results`.

**Song data** (`songs/*.json`, indexed by `songs/manifest.json`): `{ title, artist, bpm, difficulty,
tuning, tuningOffsets, notes: [{string, fret, duration}] }`. `string` is 1–6 using standard tab
convention (1 = high e, 6 = low E), matching `STRING_ORDER` and `STRING_OPEN_FREQ` in `app.js`.
`time`/`duration` fields exist in the data but are NOT used for pacing — progression is note-by-
note, gated only by correct pitch detection.

`tuning` is the display-only string-letter array (low-to-high, i.e. index 0 = string 6/low, index 5
= string 1/high — matches Ultimate Guitar's compact "Tuning:" field convention) used by
`stringLabel`. `tuningOffsets` is the optional array that actually matters for pitch: 6 semitone
offsets from standard EADGBE, indexed `[string1..string6]` (note: opposite order from `tuning`!),
passed as the third arg to every `noteFrequency(string, fret, tuningOffsets)` call. Omit it (or
leave all zeros) for standard tuning. Example — Drop D is `[0,0,0,0,0,-2]` (only the low string
drops a whole step); Drop C is `[-2,-2,-2,-2,-2,-4]` (whole guitar down a step, low string down a
step further). Get both arrays right and independently cross-checked before adding a drop-tuned
song — mixing up `tuning`'s low-to-high order with `tuningOffsets`' string-index order is an easy
mistake (happened once while authoring these; caught by testing against a synthetic tone of the
expected open-string frequency).

Note data was cross-checked against at least two independent sources (Ultimate Guitar,
onestringsongs.com, gtdb.org for tuning) per song, simplified to a single string/monophonic line
where the real riff uses power chords, dyads, or bends (the pitch detector can only track one note
at a time). It was NOT scraped programmatically — treat it as a one-time transcription, not
something that stays in sync if the source tabs are later edited. A prior pass (before this
verification habit existed) had at least one confirmed wrong note that had to be fixed later —
don't assume old song files are correct without spot-checking if something sounds off.

**Core modules in `app.js`:**
- `PitchEngine` — owns the mic `MediaStream`/`AudioContext`/`AnalyserNode` and the per-frame
  analysis loop (`_loop`, driven by `requestAnimationFrame`). Applies a software gain boost
  (`DEFAULT_INPUT_GAIN`, adjustable live via the Boost slider) before analysis, since a direct
  instrument signal is often much quieter than a voice. Explicitly disables the browser's
  echo-cancellation/noise-suppression/auto-gain (they're tuned for speech and distort instrument
  harmonics). Calls `onFrame(freqOrNull)` every frame — the callback is swapped depending on
  UI state (`Calibration.onFrame` during calibration, `PlayMode.onPitchFrame` during practice).
- `autoCorrelate(buf, sampleRate)` — ACF2+ style autocorrelation pitch detector. Two independent
  gates before it trusts a frequency: `MIN_RMS` (raw loudness floor) and `MIN_CONFIDENCE`
  (`maxVal / c[0]`, i.e. how periodic the signal is — this is what actually distinguishes a real
  note from noise, and is amplitude-invariant, so it works the same at low or high gain).
  Populates `lastPitchDebug = {rms, confidence}` every call for on-screen diagnostics.
- `Calibration` — ungated, continuous "here's what I currently hear" readout (note name, Hz,
  clarity, level) shown before practice starts, so it's obvious whether the pipeline hears
  anything at all vs. hears it but rejects it. Exists specifically because mic/interface signal
  chains vary wildly and blind threshold-tuning wasn't working — see "Known tuning constants" below.
- `PlayMode` — practice state machine. `onPitchFrame` compares detected pitch (in cents, via
  `centsBetween`) against the current target note's frequency (`noteFrequency(string, fret)`).
  Requires `CONFIRM_FRAMES` consecutive in-tolerance frames to advance (fast) or
  `WRONG_CONFIRM_FRAMES` consecutive out-of-tolerance frames to log a miss (slower, to ride out
  pick-attack transient noise), each followed by a short cooldown. A frame that doesn't match the
  current target but does match one of the previous 1-2 notes (`isRecentBleed`) is treated as
  neutral ring-through, not a miss. When the next target note is the same pitch as the one just
  played, `reattackNeeded`/`trackReattack` block it from re-matching on the previous note's own
  decaying ring — it needs either a silence gap or an RMS onset spike first. Renders the
  horizontal scrolling tab (`buildTrackStrip`/`updateTrackTransform`): all notes are real DOM
  elements (diamond "gem" chips) laid out left-to-right by index × `SPACING`; the strip is
  CSS-transformed so the current note sits under the fixed `.playhead`, giving the right-to-left
  scroll effect without a canvas. Tracks `combo`/`bestCombo` for the on-screen streak badge.
- `SFX` — small synthesized sounds on their own `AudioContext` (independent of `PitchEngine`'s, so
  it works pre-permission). `pluck(freq)` fires on every correct hit at the exact pitch of the note
  just played — this doubles as a lightweight "backing track": there's no way to legally or
  technically play the actual studio recording in sync with an arbitrary player's timing, but an
  echo of each note fired the instant it's played is inherently paced to them (never runs ahead,
  silently waits out pauses since it's driven by hits, not a clock). `miss()` is filtered noise;
  `clear()` is the song-complete fanfare.
- `MicDevices` — enumerates `audioinput` devices for the picker on the mic-gate screen (labels
  are blank until permission has been granted once) and remembers the last-picked device in
  `localStorage`.
- `Metronome` — independent quiet background click, own `AudioContext`, `setTimeout`-scheduled
  (not sample-accurate, but fine for a practice click). `start(bpm)`/`stop()`/`setBpm(bpm)`; BPM
  changes take effect on the next tick without needing a restart. `PlayMode.setupMetronome` (called
  from `load`) populates the `#metronome-bpm` `<select>` from `METRONOME_BPM_PRESETS` plus the
  song's own BPM if not already a preset, and defaults selection to the song's BPM. `PlayMode.stop`
  also stops it, so it doesn't keep ticking after leaving the play screen.

**Mic session persistence:** `PlayMode.stop()` (called by `Screens.show` on any navigation away
from `play`) only pauses — it does not close `PitchEngine`'s `AudioContext`/stream. `PlayMode.load`
checks `PitchEngine.ctx`: if a session is already running it skips straight to `play-surface`,
bypassing `mic-gate` and `calibration-panel`. So the permission/calibration flow only happens once
per page load, not once per song. If a genuine full mic teardown is ever needed, call
`PitchEngine.stop()` directly — it's no longer invoked automatically anywhere.

**Testing without hardware:** since this has only ever been driven from an automated browser
session with no real guitar/mic attached, verification relies on constructing a fake
`MediaStream` via `AudioContext.createMediaStreamDestination()` fed by an `OscillatorNode` (clean
tone) or a noise `AudioBufferSourceNode`, then calling `PitchEngine.start(fakeStream)` directly
(bypassing the real `getUserMedia` permission prompt) to exercise the whole detection pipeline.
Note: `requestAnimationFrame` is heavily throttled in a backgrounded/automated tab — don't trust
short waits; either wait several seconds or drive `PitchEngine._loop()` / `autoCorrelate()`
manually in a loop when checking results programmatically.

## Known tuning constants (top of `app.js`)

`MIN_RMS`, `MIN_CONFIDENCE`, `MATCH_CENTS_TOLERANCE`, `CONFIRM_FRAMES`, `WRONG_CONFIRM_FRAMES`,
`*_COOLDOWN_MS`, `DEFAULT_INPUT_GAIN`. These have been revised several times against synthetic
signals only (no real mic access from this environment) and real-hardware behavior has not yet
been confirmed working end-to-end. If the user reports detection problems again, the calibration
screen's live readout (note/Hz/clarity/level) is the fastest way to tell whether it's a
device/routing issue (nothing shows up regardless of playing) vs. a threshold issue (something
shows up but is wrong/unstable) — ask for those numbers before changing constants blindly again.
