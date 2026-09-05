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

**Screens** (`Screens.show(id)` toggles `.active` on `#screen-<id>`; also pauses/resumes whichever
of `PlayMode`/`Tuner` isn't the destination screen, since both share the one `PitchEngine` session):
- `menu` — song grid, loaded from `songs/manifest.json` + one JSON file per song. A tuning-filter
  chip row above the grid (`renderTuningFilters`) groups songs by `tuningKey(song.tuning)` (a
  display string, e.g. `"e B G D A E"` — high-to-low, high-e lowercased, same convention as
  `stringLabel`); selection persists in `localStorage` (`activeTuningFilter`).
- `play` — the practice screen. Has sub-states toggled by hiding/showing divs rather than
  separate screens: `mic-gate` → `calibration-panel` → `play-surface` → `play-results`.
- `tuner` — standalone chromatic tuner (see `Tuner` below). Has its own `mic-gate` → surface flow
  but reuses the same `PitchEngine` session if `play` already started one (no re-prompt).

**Song data** (`songs/*.json`, indexed by `songs/manifest.json`): `{ title, artist, bpm, difficulty,
tuning, tuningOffsets, notes: [{string, fret, duration}] }`. `string` is 1–6 using standard tab
convention (1 = high e, 6 = low E), matching `STRING_ORDER` and `STRING_OPEN_FREQ` in `app.js`.
`time`/`duration` (seconds) drive the track's horizontal layout and each note's sustain-tail width
(see `PlayMode.computeNotePositions` below) but are NOT used for pacing/gating — progression is
still note-by-note, advancing only on correct pitch detection regardless of how long you actually
held it or when you played it relative to the song's tempo.

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
onestringsongs.com, gtdb.org for tuning, cifraclub.com, guitaretab.com) per song, simplified to a
single string/monophonic line where the real riff uses power chords, dyads, or bends (the pitch
detector can only track one note at a time). It was NOT scraped programmatically — treat it as a
one-time transcription, not something that stays in sync if the source tabs are later edited. A
prior pass (before this verification habit existed) had at least one confirmed wrong note that had
to be fixed later — don't assume old song files are correct without spot-checking if something
sounds off.

**Song data is currently a mix of states**, not yet consistent across the library: most songs
(8–28 notes) are still a short excerpt of just the main riff; a few (`smoke-on-the-water`,
`back-in-black`, `the-diary-of-jane`, `animal-i-have-become`, 72–215 notes) were rebuilt from
tab text to cover the full structure but as a straight guitar-cover line; and `seven-nation-army`
is the first rebuilt from a **MIDI transcription**, which is now the preferred method — it sounds
noticeably more like the record because you can take the melody/lead line's actual pitches and
rhythm instead of a rhythm-guitar-only cover that reads as generic backing music.

**MIDI-transcription workflow** (use this when rebuilding a song):
1. Find a multitrack `.mid` (bitmidi.com `uploads/<id>.mid`, or search "<song> midi"). Prefer one
   in the **original key** — many are transposed; check a known riff note against the recording.
2. Parse with `@tonejs/midi` (install in a scratch dir, not the repo). List tracks: name,
   instrument, note count, pitch range. Named tracks ("Guitar 1 (Jack White)", "Solo Guitar", …)
   or a lone "sax"/"flute" track standing in for an absent vocal tell you which line is the hook.
3. Reduce to monophonic: group near-simultaneous notes (onset within ~40ms) and take the **top**
   note (melody) — power-chord tracks otherwise give you the root, not the tune.
4. Build the arrangement as a real song structure (intro/verse/chorus/solo/outro), condensing
   repeats (3–4 riff cycles per verse, not 15). Include the **solo / lead melodic peak** — that's
   what makes it recognizable and is the most fun to play.
5. Octave-shift into playable guitar range (the SNA riff's low B1 is below the guitar; it's
   played an octave up — the record's sub-octave is a Whammy pedal). Map pitches to string/fret
   keeping the hand in one position per section.
6. Generate the JSON with a throwaway Node script (`push(string,fret,dur)` + a running `time`
   cursor; scale MIDI seconds by `midiBpm/songBpm` if tempos differ). Scripts aren't checked in —
   only the JSON output. `seven-nation-army`'s generator is in the session scratchpad as a model.
7. Verify in-browser: load the song, check note count / `freqToNoteName` of the first bars and
   the solo, screenshot the play surface.

Older tab-text approach (still fine for short riff excerpts): Ultimate Guitar's tab text isn't in
the WebFetch-rendered page — `curl` the raw HTML and pull it from the `id="js-store"` element's
`data-content` attribute (HTML-entity-decode, then `JSON.parse`; text at
`store.page.data.tab_view.wiki_tab.content`). Cross-check pitches against a second source; a prior
pass had a confirmed wrong note.

**Core modules in `app.js`:**
- `PitchEngine` — owns the mic `MediaStream`/`AudioContext`/`AnalyserNode` and the per-frame
  analysis loop (`_loop`, driven by `requestAnimationFrame`). `analyser.fftSize` is `4096` (not the
  more typical `2048`) — low strings need several full cycles in the window for autocorrelation to
  lock onto the fundamental with any real confidence margin (measured: a clean low-E tone was only
  ~0.6-0.7 confidence at 2048 vs ~0.85 at 4096, against a `MIN_CONFIDENCE` of 0.45), at the cost of
  ~43ms more latency. Applies a software gain boost (`DEFAULT_INPUT_GAIN`, adjustable live via the
  Boost slider) before analysis, since a direct instrument signal is often much quieter than a
  voice. Explicitly disables the browser's echo-cancellation/noise-suppression/auto-gain (they're
  tuned for speech and distort instrument harmonics). Calls `onFrame(freqOrNull)` every frame — the
  callback is swapped depending on which screen is active (`Calibration.onFrame`,
  `PlayMode.onPitchFrame`, or `Tuner.onFrame`).
- `autoCorrelate(buf, sampleRate)` — ACF2+ style autocorrelation pitch detector: a *blind* global
  search for whatever single frequency best explains the whole buffer. Two independent gates before
  it trusts a frequency: `MIN_RMS` (raw loudness floor) and `MIN_CONFIDENCE` (`maxVal / c[0]`, i.e.
  how periodic the signal is — this is what actually distinguishes a real note from noise, and is
  amplitude-invariant, so it works the same at low or high gain). Populates
  `lastPitchDebug = {rms, confidence}` every call for on-screen diagnostics.
- `correlationAtFreq(buf, sampleRate, freq)` — the non-blind counterpart: instead of asking "what's
  the one best-fitting frequency in this buffer," asks "how strongly does this buffer repeat at
  *this specific known* frequency's period" (interpolated autocorrelation value at that one lag,
  normalized by `c[0]` the same way). Exists because when a new note is played while the previous
  one is still ringing (low strings sustain the longest, so this hits them hardest), the buffer is
  a blend of both and `autoCorrelate`'s global search locks onto neither cleanly — it settles on a
  blended, wrong frequency that satisfies no real note. Since gameplay always knows the exact
  target frequency in advance, `PlayMode.targetedMatch` uses this to sidestep that failure mode
  entirely — see below.
- `Calibration` — ungated, continuous "here's what I currently hear" readout (note name, Hz,
  clarity, level) shown before practice starts, so it's obvious whether the pipeline hears
  anything at all vs. hears it but rejects it. Exists specifically because mic/interface signal
  chains vary wildly and blind threshold-tuning wasn't working — see "Known tuning constants" below.
- `PlayMode` — practice state machine. `onPitchFrame` compares detected pitch (in cents, via
  `centsBetween`) against the current target note's frequency (`noteFrequency(string, fret)`).
  A frame counts as a match if *either* the blind `autoCorrelate` result lands in tolerance, *or*
  `targetedMatch` does: it calls `correlationAtFreq` directly against the target's own frequency
  (skipped when the blind check already passed — it's a fallback, not run every frame) and accepts
  if that correlation clears `TARGET_CORR_CONFIDENCE` *and* clearly beats the correlation at any of
  the last couple of played notes' own frequencies (guards against accepting mere leftover ring
  from a note that hasn't finished decaying). Requires `CONFIRM_FRAMES` consecutive matching frames
  to advance (fast) or `WRONG_CONFIRM_FRAMES` consecutive out-of-tolerance *blind* frames to log a
  miss (slower, to ride out pick-attack transient noise — "wrong" detection has no known target to
  check against, so it can't use the targeted path), each followed by a short cooldown. A frame
  that doesn't match the current target but does match one of the previous 1-2 notes
  (`isRecentBleed`) is treated as neutral ring-through, not a miss. When the next target note is
  the same pitch as the one just played, `reattackNeeded`/`trackReattack` block it from re-matching
  on the previous note's own decaying ring — it needs either a silence gap or an RMS onset spike
  first. Renders the
  horizontal scrolling tab (`buildTrackStrip`/`updateTrackTransform`): all notes are real DOM
  elements (diamond "gem" chips, each with a "sustain tail" bar behind it) laid out left-to-right
  via `computeNotePositions()`, which places each chip by its real `time` field (seconds) ×
  `PIXELS_PER_SECOND` rather than a flat per-index spacing — so gaps between chips reflect the
  song's actual rhythm, clamped to `MIN_NOTE_GAP` so fast passages don't visually collide. Each
  tail's width comes from the note's `duration`, clamped to `[MIN_TAIL_WIDTH, MAX_TAIL_WIDTH]`, so
  longer/shorter notes are visually distinguishable even though matching is still pitch-only (no
  timing is enforced — this is a visual cue, not a new gate). The strip is CSS-transformed so the
  current note sits under the fixed `.playhead`, giving the right-to-left scroll effect without a
  canvas. Tracks `combo`/`bestCombo` for the on-screen streak badge.
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
- `Tuner` — standalone chromatic-per-string tuner (`tuner` screen). Its tuning picker
  (`buildTunings`) is derived from whatever tunings actually appear in `SONGS` (same grouping as
  the menu's tuning filter, so the two always stay in sync automatically) — not a separate
  hardcoded list. Live/ungated like `Calibration`, no `CONFIRM_FRAMES` debounce. Auto-detects which
  of the 6 open strings the incoming pitch is nearest to in cents (`onFrame`), or locks to a
  specific string if the player clicks one (`lockedString`) — useful when a wildly out-of-tune
  string would otherwise auto-target the wrong one. Uses its own tighter `TUNER_CENTS_TOLERANCE`
  (±8¢) than gameplay's `MATCH_CENTS_TOLERANCE` (±35¢), since a tuner needs real tuning precision
  while gameplay is deliberately lenient.

**Mic session persistence:** `PlayMode.stop()`/`Tuner.stop()` (called by `Screens.show` on any
navigation away from their screen) only pause — they don't close `PitchEngine`'s
`AudioContext`/stream, and both null out `PitchEngine.onFrame` unconditionally, so whichever of
`play`/`tuner` is entered next just reassigns it (`PlayMode.load`/`Tuner.enter`) rather than
needing to coordinate who "owns" the callback. Both check `PitchEngine.ctx`: if a session is
already running they skip straight past `mic-gate`/`calibration-panel` to their surface. So the
permission/calibration flow only happens once per page load, not once per song or per screen
visit. `MicDevices.populate`/`selectedId` take an optional `selectId` param (defaulting to the Play
screen's `#mic-device-select`) so the Tuner's `#tuner-mic-device-select` can reuse the same
enumerate/remember logic against its own `<select>`. If a genuine full mic teardown is ever needed,
call `PitchEngine.stop()` directly — it's no longer invoked automatically anywhere.

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
`*_COOLDOWN_MS`, `DEFAULT_INPUT_GAIN`, `TARGET_CORR_CONFIDENCE`, `TUNER_CENTS_TOLERANCE`. This
environment still has no real mic access itself, but the user now has and has reported two real
detection problems against actual playing, both diagnosed and fixed the same way — worth repeating
for the next one: (1) get the user to describe what the calibration/tuner readout actually shows
(right note/Hz but not advancing? nothing shows up at all? unstable/wrong?) to tell a
device/routing issue from a detection-logic issue; (2) build a synthetic repro of the *specific*
scenario in the browser (a fake `MediaStream` from an oscillator, or by directly constructing a
`Float32Array` buffer and calling `autoCorrelate`/`correlationAtFreq` on it — see "Testing without
hardware" above) rather than tweaking constants blind; (3) fix the underlying detection logic, not
just retune a threshold — both real fixes so far were algorithm changes, not constant nudges:
widening `fftSize` 2048→4096 fixed low-string confidence but made note-to-note transitions worse
(the previous note's ring blends into the new one's analysis window for longer), which then needed
`correlationAtFreq`/`targetedMatch` to fix in turn. A constant-only fix is liable to trade one of
these problems for the other.
