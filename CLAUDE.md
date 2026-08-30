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

**Song data** (`songs/*.json`): `{ title, artist, bpm, difficulty, tuning, notes: [{string, fret,
duration}] }`. `string` is 1–6 using standard tab convention (1 = high e, 6 = low E), matching
`STRING_ORDER` and `STRING_OPEN_FREQ` in `app.js`. `time`/`duration` fields exist in the data but
are NOT used for pacing — progression is note-by-note, gated only by correct pitch detection.

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
  pick-attack transient noise), each followed by a short cooldown. Renders the horizontal
  scrolling tab (`buildTrackStrip`/`updateTrackTransform`): all notes are real DOM elements laid
  out left-to-right by index × `SPACING`; the strip is CSS-transformed so the current note sits
  under the fixed `.playhead`, giving the right-to-left scroll effect without a canvas.
- `MicDevices` — enumerates `audioinput` devices for the picker on the mic-gate screen (labels
  are blank until permission has been granted once) and remembers the last-picked device in
  `localStorage`.

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
