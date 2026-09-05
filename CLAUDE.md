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

**MIDI-transcription workflow** (use this when rebuilding a song). The goal the user cares about:
play the **melody line the listener hums** (the vocal, or a piano arrangement's right hand —
*not* the rhythm-guitar part), so it sounds like the record instead of generic backing music.
`seven-nation-army.json` is built this way — study it as the model.
1. Find a multitrack `.mid` (bitmidi.com `uploads/<id>.mid` — the id is in the page HTML; search
   "<song> midi" / "<song> piano midi"). Prefer one in the **original key** — many are transposed;
   check a known note against the recording and shift all pitches by the interval if needed
   (SNA's file was up a perfect 5th → −7 semitones).
2. Parse with `@tonejs/midi` (install in a scratch dir, not the repo). List every track: name,
   instrument, note count, pitch range. The melody is usually a lone monophonic track named for a
   wind instrument ("tenor sax", "flute", "recorder") standing in for the absent vocal, or a
   piano/lead track. Rhythm-guitar and "pad"/"strings" tracks are accompaniment — skip them.
3. Use MIDI **ticks** for timing, not seconds — `note.ticks / header.ppq` = beats, independent of
   the file's (often wobbly, multi-tempo) tempo map. Quantise beats + durations to a 1/16 grid,
   merge same-pitch stutter, then re-emit at the real song BPM (`beat * 60 / bpm`).
4. Reduce to monophonic if the chosen track has chords: group near-simultaneous notes (onset
   within ~40ms) and take the **top** note.
5. Build the arrangement as a real song structure. Play the melody through the verses/choruses/
   bridge; drop the **riff** into the intro, the long instrumental gaps (fill any melody rest ≥ ~3
   beats), and the outro; include the **solo** if the MIDI has a clean one. Condense long repeats.
6. Octave-shift into playable guitar range and map pitches to string/fret keeping the hand in one
   position per section (melody in E3–B3 sits on the D/G strings; the SNA riff's low B is below
   the guitar so it's played an octave up — the record's sub-octave is a Whammy pedal).
7. Generate the JSON with a throwaway Node script that reads the `.mid` directly (see gen2.js in
   the session scratchpad as a model). Scripts aren't checked in — only the JSON output.
8. Verify in-browser: load the song, check note count and `freqToNoteName` of the melody/riff/
   solo sections, screenshot the play surface.

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
- `Calibration` — ungated, continuous "here's what I currently hear" readout (note name, Hz,
  clarity, level) shown before practice starts, so it's obvious whether the pipeline hears
  anything at all vs. hears it but rejects it. Exists specifically because mic/interface signal
  chains vary wildly and blind threshold-tuning wasn't working — see "Known tuning constants" below.
- `PlayMode` — practice state machine. **The model is simple by explicit user demand: every note
  the player actually picks advances the song by one — a hit if its pitch is within
  `MATCH_CENTS_TOLERANCE` of the target, otherwise marked an error (`results[i] = 'wrong'`) — but
  it advances either way, so the song never sits stuck waiting to "get" a note.** `onPitchFrame`
  segments the audio into played notes: a confident `autoCorrelate` pitch that holds within
  `ONSET_STABLE_CENTS` for `ONSET_CONFIRM_FRAMES` is one note event, then `advance()` judges it
  and moves on. The just-registered pitch is stored in `noteHeld` and its ring-out is ignored
  until either `REARM_SILENCE_FRAMES` of no pitch, or `onsetSpike()` sees a fresh pick-attack
  (RMS jump over the recent rolling min, and only when that min is a real ring, not silence).
  `NOTE_COOLDOWN_MS` is the floor between two registrations. No `correlationAtFreq`, no
  multi-frame "confirm the wrong note", no reattack state machine — those were removed; if
  tempted to add discrimination cleverness back, re-read the user feedback memory first. Renders the
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
  hardcoded list. Live/ungated like `Calibration`, no onset debounce. Auto-detects which
  of the 6 open strings the incoming pitch is nearest to in cents (`onFrame`), or locks to a
  specific string if the player clicks one (`lockedString`) — useful when a wildly out-of-tune
  string would otherwise auto-target the wrong one. Uses its own tighter `TUNER_CENTS_TOLERANCE`
  (±8¢) than gameplay's `MATCH_CENTS_TOLERANCE` (±45¢), since a tuner needs real tuning precision
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
short waits; either wait several seconds or drive the loop manually. When driving `onPitchFrame`
directly in a test, do what `_loop` does — `autoCorrelate` returns `-1` on failure and `_loop`
passes `freq > 0 ? freq : null`, so feed `onPitchFrame` the `null`, never a raw `-1`. Reset
`PlayMode.cooldownUntil = 0` if you mock `performance.now` to a fixed clock. Good stress matrix:
all-notes-correct (expect every one a hit, ~60ms each); a wrong note each time (expect exactly
one advance per note, marked `'wrong'`, nothing stuck); one correct note held 2s straight (expect
exactly one advance); a note's long ring-out with no re-pick (expect zero extra advances); a run
of identical target notes played with legato re-picks (expect each re-pick to advance).

## Known tuning constants (top of `app.js`)

`MATCH_CENTS_TOLERANCE`, `MIN_RMS`, `MIN_CONFIDENCE`, `ONSET_CONFIRM_FRAMES`, `ONSET_STABLE_CENTS`,
`SAME_NOTE_CENTS`, `REARM_SILENCE_FRAMES`, `NOTE_COOLDOWN_MS`, `RMS_HISTORY_LEN`, `ONSET_RATIO`,
`ONSET_ABS_MULT`, `DEFAULT_INPUT_GAIN`, `TUNER_CENTS_TOLERANCE`.

**The user's standing, repeated instruction: detection must never make the song feel stuck.**
The current design answers that by advancing on every played note regardless of right/wrong (see
`PlayMode` above). Earlier attempts tried to be smart about "is this really the right note / a
real re-pick / just ring-through" (`CONFIRM_FRAMES`, `WRONG_CONFIRM_FRAMES`, `correlationAtFreq`,
`targetedMatch`, `reattackNeeded`) and every version of that got the same complaint. Don't
reintroduce it. If asked to change detection, stay in the "simpler / looser" direction.

When the user reports a specific problem: (1) ask what the calibration/tuner readout shows (right
note/Hz? nothing? unstable?) to separate a device/routing issue from logic; (2) build the
synthetic repro and drive `onPitchFrame` (see "Testing without hardware"); (3) `fftSize` is 4096
for low-string confidence — dropping it cuts latency but hurts detection on the low strings.
