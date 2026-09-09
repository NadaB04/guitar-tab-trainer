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
  separate screens: `mic-gate` → `calibration-panel` → `play-surface` → `play-results`. The
  `play-surface` is also reused by the `Demo` ("Hear it") mode with a `.demo-mode` class.
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

**The library is now uniform**: every song is a full-song **Songsterr vocal-track**
transcription (`snuff`, `numb`, `never-too-late`, `break`, `home`, `gone-forever`, `wake-up`,
`let-it-die`, `over-and-over`, `scared`, `animal-i-have-become`, `i-hate-everything-about-you`,
`the-diary-of-jane`), except `iron-man`, whose recognizable riff was pulled the same way from
Songsterr's guitar track. The older short riff-excerpts and the MIDI/mp3 rebuilds
(`seven-nation-army`, `nothing-else-matters`, etc.) were deleted — recover any from git history
if needed. The goal in every case: play the **melody the listener hums** (the vocal line, or the
iconic riff when the riff _is_ the hook), _not_ the rhythm-guitar accompaniment, so it sounds
like the record. Add new songs with the workflow below.

---

### Preferred method: Songsterr vocal-track workflow

Songsterr has professionally-transcribed per-instrument tracks for most well-known songs, often
including a dedicated **"<singer> - Lead Vocals"** track (`isVocalTrack: true`). That track is the
sung melody as clean machine-readable note data — no OCR, no MIDI hunting. This is how `snuff`,
`numb`, etc. were built.

All endpoints are public (no auth). `curl` gets 403 on `songsterr.com/api/*` unless you pass
`-e "https://www.songsterr.com/"` (a Referer); the CloudFront CDN needs no header.

1. **Find the song:** `GET https://www.songsterr.com/api/songs?pattern=<artist+title>&size=4`
   → array of `{songId, title, artist, tracks:[{name, hash, isVocalTrack, isEmpty, tuning}]}`.
2. **Get the revision + data key:**
   - `GET /api/meta/<songId>` → `revisionId` and the full `tracks[]` (with `isVocalTrack`).
   - `GET /api/revision/<revisionId>` → `image` (a version key like `v0-3-2-xxxxxxxx`).
3. **Fetch the notation JSON** for the vocal track (its index in `tracks[]` = `partIdx`):
   `https://dqsljvtekg760.cloudfront.net/<songId>/<revisionId>/<image>/<partIdx>.json`
   (gzipped — `curl --compressed`). Shape:
   `{ tuning:[6 MIDI ints], automations:{tempo:[{measure,bpm}]},
      measures:[ { signature:[n,d], marker:{text}, voices:[ { beats:[
        { duration:[num,den], type, rest, tuplet?, notes:[{string,fret,tie?}] } ] } ] } ] }`
   `note MIDI = tuning[string] + fret`. `duration:[n,d]` = fraction of a whole note → beats = `4n/d`
   (apply `tuplet[1]/tuplet[0]` if present). `tie:true` → merge into the previous same-pitch note.
   Section names are in `measures[i].marker.text` (Intro / Verse / Chorus / Bridge / Outro …).
   To discover the CDN URL for a new song without guessing: open the tab page in claude-in-chrome
   and read `performance.getEntriesByType('resource')` — the data loads in a web worker so a
   main-thread `fetch` hook won't see it.
4. **Quality-gate before using it** (fan transcriptions vary):
   - `chords`: count beats with >1 real note. Should be **0** for a vocal line. >0 = layered
     screams/harmonies, transcription unreliable (Slipknot's heavier songs — Duality, Before I
     Forget — fail here).
   - `badBeatMeasures`: measures whose beat durations don't sum to the time signature. Should be
     ~0. A few is fine (grace notes) — normalise them by scaling that measure's durations to fit.
   - pitch range: if it dips below ~**E2** the transcription has octave errors — reject or fix.
     (`i-hate-everything-about-you`'s vocal track is a rough fan job — octave-inconsistent bridge;
     it's the weakest of the batch.)
   - note count: <~150 for a full song = too sparse, skip (Three Days Grace "Pain").
5. **Build the JSON:** flatten `measures → voices[0] → beats`, take the lowest note per beat
   (mono; a clean vocal track has no chords so this is a no-op), tie-merge, accumulate real time
   across the tempo map (`Σ beatDur × 60/bpm`), shift so the first note lands ~0.5 s in. Map each
   MIDI to standard-tuning `{string,fret}` — open strings `{1:64,2:59,3:55,4:50,5:45,6:40}`, pick
   the position minimising `|fret − 5|` (keeps a compact hand box; the batch all came out frets
   3–7). Standard tuning always (`["E","A","D","G","B","E"]`, no `tuningOffsets`) — the user does
   not retune, and a vocal melody maps fine to standard regardless of the original's tuning.
6. **Verify:** load in-browser, check note count, and dump `freqToNoteName` per section — the
   verse/chorus contour must match the actual song (e.g. Numb verse sits on C#4, chorus hook on
   F#4). Screenshot the play surface / run "Hear it".

Known limitation: vocal-only tracks scroll through **empty gaps** during solos/breakdowns (no
vocal there). Acceptable but sparse — `animal-i-have-become` has a ~20 s gap.

Do NOT bother with **MuseScore screenshots**: its embedded viewer freezes the claude-in-chrome
screenshot/zoom tool after the first capture, won't scroll via events, and gates its page images.
Tried thoroughly, not viable.

### Fallbacks (when Songsterr has no usable vocal track)

**MIDI transcription** (the deleted `seven-nation-army.json` was the model — pull it from git
history if you need a worked example). Find a multitrack `.mid`
(bitmidi.com `uploads/<id>.mid`; prefer the original key — check a known note vs the recording,
shift all pitches by the interval). Parse with `@tonejs/midi` in a scratch dir. The melody is
usually a lone monophonic track named for a wind instrument ("tenor sax", "flute") standing in for
the absent vocal, or a piano/lead track — skip rhythm-guitar and "pad" tracks. Timing from
**ticks** (`note.ticks / header.ppq` = beats), quantise to 1/16, merge stutter, re-emit at real
BPM. Reduce chords to the **top** note. Build a real song structure: melody through the
verses/choruses, riff in the intro / long gaps / outro, solo if clean. Octave-shift into playable
range, one hand position per section.

**Tab text** (short riff excerpts only): Ultimate Guitar's tab text isn't in the WebFetch-rendered
page — `curl` the raw HTML and pull it from the `id="js-store"` element's `data-content` attribute
(HTML-entity-decode, then `JSON.parse`; text at `store.page.data.tab_view.wiki_tab.content`).
Cross-check pitches against a second source; a prior pass had a confirmed wrong note.

Scripts for any of these are throwaway Node in the session scratchpad — never checked in, only the
JSON output.

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
- `autoCorrelate(buf, sampleRate)` — ACF2+ style autocorrelation pitch detector: a _blind_ global
  search for whatever single frequency best explains the whole buffer. Two independent gates before
  it trusts a frequency: `MIN_RMS` (raw loudness floor) and `MIN_CONFIDENCE` (`maxVal / c[0]`, i.e.
  how periodic the signal is — this is what actually distinguishes a real note from noise, and is
  amplitude-invariant, so it works the same at low or high gain). Populates
  `lastPitchDebug = {rms, confidence}` every call for on-screen diagnostics.
- `correlationAtFreq(buf, sampleRate, freq)` — the non-blind counterpart: instead of asking "what's
  the one best-fitting frequency in this buffer," asks "how strongly does this buffer repeat at
  _this specific known_ frequency's period" (interpolated autocorrelation value at that one lag,
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
  A frame counts as a match if _either_ the blind `autoCorrelate` result lands in tolerance, _or_
  `targetedMatch` does: it calls `correlationAtFreq` directly against the target's own frequency
  (skipped when the blind check already passed — it's a fallback, not run every frame) and accepts
  if that correlation clears `TARGET_CORR_CONFIDENCE` _and_ clearly beats the correlation at any of
  the last couple of played notes' own frequencies (guards against accepting mere leftover ring
  from a note that hasn't finished decaying). Requires `CONFIRM_FRAMES` consecutive matching frames
  to advance (fast) or `WRONG_CONFIRM_FRAMES` consecutive out-of-tolerance _blind_ frames to log a
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
  just played . `miss()` is filtered noise;
  `clear()` is the song-complete fanfare.
- `GuitarVoice` — a plucked electric-guitar voice, used only by `Demo`. Shares `SFX`'s
  `AudioContext`. Each `note(freq, when, dur, vel)` is a **modal string model**, not a raw
  oscillator: a stack of sine partials at n×f (stretched slightly sharp by `stiffness`, an
  inharmonicity term), each with its own decay (the fundamental rings ~2.5 s, harmonics die
  progressively faster), scaled by a pluck-position comb `|sin(nπ·pluckPos)|`, plus a ~22 ms
  band-passed noise pick-attack. That feeds one shared **two-stage high-gain amp**, built once
  (`ensure`): tighten highpass + high-shelf pre-emphasis → compressor → `_drive` gain → soft clip
  (`_clip(2.5, .15)`) → highpass → ×3 gain → hard clip (`_clip(6, .05)`) → high-shelf de-emphasis
  → mid scoop → presence bump → 5 kHz cab lowpass → **brickwall limiter** → `master` (`_level`).
  `_drive` (8) is the gain knob; the limiter is load-bearing — without it dense passages peak past
  1 and clip. Tone history: two detuned saws + heavy shaper = "metallic / like bips" → pure modal
  string = "too acoustic" → modal string + mild overdrive = "not enough" → this cascaded high-gain
  chain. `panic()` fades `master` and hard-stops every tracked node.
- `Demo` — the "Hear it" mode (buttons `#demo-btn` in the play topline, `#demo-btn-gate` on the
  mic-gate; both call `Demo.toggle()`). Plays the loaded song through `GuitarVoice` while the tab
  strip scrolls continuously in sync — a worked example, no mic. Reuses the strip `PlayMode`
  already built (`notes`, `notePositions`, `chipEls`, `tailEls`). Audio is scheduled ~0.4 s ahead
  on the `AudioContext` clock (sample-accurate); the visual scroll is a `requestAnimationFrame`
  loop reading the same clock via `_xAt(t)`, so sound and picture stay locked. Each note gets ±3¢
  / ±velocity / ±10 ms wobble so it doesn't sound sequenced.
  **Tempo:** plays at whatever the `#metronome-bpm` select shows (not necessarily the song's own
  BPM). `rate = chosenBpm / song.bpm`; `playTimes[i] = notes[i].time / rate` drives both audio
  and scroll (`_xAt` multiplies `PIXELS_PER_SECOND` by `rate`). The `Metronome` is auto-started
  at the chosen BPM after the lead-in so its click lines up with the notes; the metronome toggle
  still works to mute it. Changing the BPM select mid-demo restarts the demo at the new tempo. The
  `listening-tools` bar stays visible during a demo but CSS (`#screen-play:has(.demo-mode) …`)
  hides its mic-only rows, leaving just the metronome/BPM row.
  `exit()` stops and resets the play screen via `PlayMode.load`; `stop()` is teardown-only for
  navigation. `PlayMode.load` and `Screens.show` (leaving `play`) both call `Demo.stop()`.
  `pause()`/`resume()` freeze/unfreeze playback (capture `_pausedT = ctx.currentTime - audioStart`,
  kill the rAF loop + ringing notes + metronome; on resume, re-derive `audioStart` from `_pausedT`
  and re-point `nextIdx`/`shownIdx`). `scrub(i)`/`commitScrub(i)` are the seek-slider hooks —
  live drag pauses and repaints via `_renderAt(t)` (which does NOT touch the clock), release
  seeks there and resumes iff playback was running when grabbed (`_scrubResume`).
- `Transport` — the shared pause + seek bar (`#transport-bar` under the target panel, visible on
  the practice surface AND during a demo). `inDemo` (the `.demo-mode` class) picks which it
  drives: Demo's `togglePause`/`scrub`/`commitScrub`, or `PlayMode.togglePause()` (pauses mic
  listening) / `PlayMode.seekToIndex(i)` (jumps `currentIndex`; notes skipped past keep a `null`
  result and render neutral, not as a miss). `syncSlider()` keeps the thumb+label in step with
  playback/practice progress (skipped while the slider has focus, i.e. mid-drag); called from
  `Demo._loop`, `PlayMode.updateProgress`, and the seek/pause paths. `fmtTime()` → `m:ss`.
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
`*_COOLDOWN_MS`, `DEFAULT_INPUT_GAIN`, `TARGET_CORR_CONFIDENCE`, `TUNER_CENTS_TOLERANCE`.

This environment has no real mic. When the user reports a detection problem: (1) ask what the
calibration/tuner readout actually shows (right note/Hz but not advancing? nothing at all?
unstable/wrong note?) — that separates a device/routing issue from detection logic; (2) build a
synthetic repro of that _specific_ scenario (fake `MediaStream` from an oscillator, or hand-build a
`Float32Array` and call `autoCorrelate` on it — see "Testing without hardware") before touching
anything; (3) prefer an algorithm fix over nudging a constant (e.g. `fftSize` 2048→4096 for
low-string confidence, then `correlationAtFreq`/`targetedMatch` for the note-transition blends that
change introduced).

## Open issue — detection picks a neighbouring note (do not keep reworking blindly)

The user's setup is an **acoustic/electric guitar into the laptop's built-in mic**. In that
signal the fundamental is weak and the harmonics are strong, so `autoCorrelate` often locks onto a
neighbouring pitch (a harmonic, or a blend) rather than the note played — the user has to play very
precisely to advance. This is a known, deferred TODO; the user explicitly asked that it be left
alone for now, **not** patched with more match-logic tweaks.

Three attempts this project's history to make matching more forgiving / smarter (looser constants;
an "any onset advances, right or wrong" model; the `correlationAtFreq`+`reattack` apparatus) were
all rejected and reverted — detection is currently at its long-standing baseline. When this is
picked up again, the fix belongs in the **pitch detector for weak-fundamental input** (harmonic-
product-spectrum, a sub-harmonic sanity check, or biasing toward the lower candidate lag), verified
against a synthetic buffer with a weak fundamental + strong 2nd/3rd harmonics — not in `PlayMode`.
