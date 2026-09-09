"use strict";

/* ---------------------------------------------------------------------- *
 * Constants
 * ---------------------------------------------------------------------- */

const STRING_ORDER = [1, 2, 3, 4, 5, 6]; // top-to-bottom, matches written tab (high e -> low E)
const LANE_COLORS = {
  1: "#1ed760", 2: "#f5c945", 3: "#f19a3e",
  4: "#ef5b7a", 5: "#b06cf0", 6: "#4fb3f0",
};
// Standard tuning open-string frequencies (Hz), indexed by string number (1 = high e).
const STRING_OPEN_FREQ = { 1: 329.63, 2: 246.94, 3: 196.0, 4: 146.83, 5: 110.0, 6: 82.41 };

const ROW_HEIGHT = 56;
const SPACING = 80; // fallback spacing for notes with no meaningful time gap
const PLAYHEAD_X = 90;

// Rhythm layout: note x-position is driven by each note's real `time` (seconds) instead of
// a fixed per-index spacing, so the horizontal gap between chips reflects the actual rhythm.
// A "sustain tail" behind each chip, sized from `duration`, shows how long to hold it.
const PIXELS_PER_SECOND = 140;
const MIN_NOTE_GAP = 55;   // floor so fast passages don't visually collide
const MIN_TAIL_WIDTH = 10; // stays visible even for very short/staccato notes
const MAX_TAIL_WIDTH = 220; // cap so a long held final note doesn't dominate the strip

const MATCH_CENTS_TOLERANCE = 35;
const CONFIRM_FRAMES = 8;        // ~130ms of a stable correct pitch before it counts
const WRONG_CONFIRM_FRAMES = 18; // ~300ms of a stable wrong pitch — rides out pick-attack noise
const CORRECT_COOLDOWN_MS = 280;
const WRONG_COOLDOWN_MS = 350;
const MIN_CONFIDENCE = 0.45; // how "periodic" the signal must be — filters out noise/hum
const MIN_RMS = 0.005; // just above mic self-noise — the confidence check (below) does the real noise rejection,
                        // and it's scale-invariant, so this floor can stay low without letting noise back in

// How strongly the buffer must repeat at a *specific known* frequency (see correlationAtFreq)
// for PlayMode to accept it as a match even when blind autoCorrelate can't find one confidently.
// See PlayMode.targetedMatch for why this exists — the still-ringing previous note blends with
// a freshly-played one enough that global autocorrelation locks onto neither cleanly, especially
// on low strings which ring out the longest. Measured against a simulated ringing-note-transition
// (old note decaying under a fresh pick attack): correlation at the true new-note frequency climbs
// past this well before global autocorrelate's blended estimate gets anywhere near either note.
const TARGET_CORR_CONFIDENCE = 0.5;

// Repeated-note onset detection (see PlayMode.trackReattack): a pick-attack spike is an
// RMS jump over the recent rolling minimum; the window length trades detection latency
// against not being fooled by ordinary frame-to-frame jitter in a sustained ring.
const REATTACK_HISTORY_LEN = 10; // ~150-200ms of frames
const ONSET_RATIO = 1.6;         // new rms must exceed the recent floor by this factor
const ONSET_ABS_MULT = 3;        // ...and clear an absolute floor, so near-silent jitter can't trigger it

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

let SONGS = [];

/* ---------------------------------------------------------------------- *
 * Music helpers
 * ---------------------------------------------------------------------- */

// `tuningOffsets` is an optional per-song array of 6 semitone offsets from standard
// EADGBE, indexed [string1..string6] (string1 = high e). Lets songs in Drop D, Drop C#,
// etc. use their real fret numbers while still resolving to the correct absolute pitch —
// without this, every song's frequency math silently assumed standard tuning regardless
// of what its `tuning` display field said (see CLAUDE.md).
function noteFrequency(string, fret, tuningOffsets) {
  const offset = (tuningOffsets && tuningOffsets[string - 1]) || 0;
  return STRING_OPEN_FREQ[string] * Math.pow(2, (fret + offset) / 12);
}

function centsBetween(freqA, freqB) {
  return 1200 * Math.log2(freqA / freqB);
}

function freqToNoteName(freq) {
  const midi = Math.round(69 + 12 * Math.log2(freq / 440));
  const name = NOTE_NAMES[((midi % 12) + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;
  return `${name}${octave}`;
}

function stringLabel(song, stringNum) {
  const raw = song.tuning[6 - stringNum];
  return stringNum === 1 ? raw.toLowerCase() : raw;
}

// Display/group key for a song's tuning: high-to-low letter order (matches stringLabel's
// convention — `tuning` itself is stored low-to-high) with the high e lowercased, e.g.
// ["C","G","C","F","A","D"] (stored) -> "D A F C G C" (displayed).
function tuningKey(tuning) {
  return [...tuning].reverse().map((n, i) => (i === 0 ? n.toLowerCase() : n)).join(" ");
}

/* ---------------------------------------------------------------------- *
 * Pitch detection (autocorrelation, "ACF2+" style)
 * ---------------------------------------------------------------------- */

// Populated on every call so the UI can show live signal diagnostics — useful for
// tuning MIN_RMS / MIN_CONFIDENCE against a real mic instead of guessing blind.
const lastPitchDebug = { rms: 0, confidence: 0 };

function autoCorrelate(buf, sampleRate) {
  const SIZE = buf.length;
  let rms = 0;
  for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / SIZE);
  lastPitchDebug.rms = rms;
  lastPitchDebug.confidence = 0;
  if (rms < MIN_RMS) return -1;

  let r1 = 0, r2 = SIZE - 1;
  const thres = 0.2;
  for (let i = 0; i < SIZE / 2; i++) {
    if (Math.abs(buf[i]) < thres) { r1 = i; break; }
  }
  for (let i = 1; i < SIZE / 2; i++) {
    if (Math.abs(buf[SIZE - i]) < thres) { r2 = SIZE - i; break; }
  }

  const trimmed = buf.slice(r1, r2);
  const n = trimmed.length;
  if (n < 8) return -1;

  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = 0; j < n - i; j++) sum += trimmed[j] * trimmed[j + i];
    c[i] = sum;
  }

  let d = 0;
  while (d < n - 1 && c[d] > c[d + 1]) d++;

  let maxVal = -1, maxPos = -1;
  for (let i = d; i < n; i++) {
    if (c[i] > maxVal) { maxVal = c[i]; maxPos = i; }
  }
  let T0 = maxPos;
  if (T0 <= 0) return -1;

  // Confidence = how strongly the signal repeats at that lag vs. its own energy.
  // Real noise (hiss, hum, room sound) rarely clears this bar; a plucked string does.
  const confidence = maxVal / c[0];
  lastPitchDebug.confidence = confidence;
  if (confidence < MIN_CONFIDENCE) return -1;

  if (T0 > 0 && T0 < n - 1) {
    const x1 = c[T0 - 1], x2 = c[T0], x3 = c[T0 + 1];
    const a = (x1 + x3 - 2 * x2) / 2;
    const b = (x3 - x1) / 2;
    if (a !== 0) T0 = T0 - b / (2 * a);
  }

  if (T0 <= 0) return -1;
  const freq = sampleRate / T0;
  if (freq < 55 || freq > 1200) return -1; // outside guitar range, likely noise
  return freq;
}

// Unlike autoCorrelate (which searches the whole lag range for whatever period dominates),
// this asks a narrower, more answerable question: "how strongly does the signal repeat at
// the period for THIS specific known frequency?" — computed directly via the interpolated
// autocorrelation value at that one lag, normalized by c[0] the same way autoCorrelate's
// confidence is. Used by PlayMode to match against a known target frequency even when the
// buffer is a blend of two notes (previous one still ringing under a freshly-played one) and
// no single frequency dominates enough for autoCorrelate's global peak search to lock onto
// either cleanly — see PlayMode.targetedMatch.
function correlationAtFreq(buf, sampleRate, freq) {
  const n = buf.length;
  const lag = sampleRate / freq;
  const lagFloor = Math.floor(lag);
  if (lagFloor < 1 || lagFloor >= n - 1) return 0;
  function corrAtLag(L) {
    let sum = 0;
    for (let j = 0; j < n - L; j++) sum += buf[j] * buf[j + L];
    return sum;
  }
  const c0 = corrAtLag(0);
  if (c0 <= 0) return 0;
  const cLow = corrAtLag(lagFloor);
  const cHigh = corrAtLag(lagFloor + 1);
  const frac = lag - lagFloor;
  return (cLow + (cHigh - cLow) * frac) / c0;
}

/* ---------------------------------------------------------------------- *
 * Pitch engine — owns the mic stream / AudioContext / analysis loop
 * ---------------------------------------------------------------------- */

const DEFAULT_INPUT_GAIN = 12; // software boost — a direct-in guitar signal is often much quieter than a mic'd voice

const PitchEngine = {
  ctx: null,
  analyser: null,
  gainNode: null,
  buffer: null,
  stream: null,
  rafId: null,
  onFrame: null, // callback(freqOrNull)

  async start(streamOverride, deviceId) {
    // Voice-oriented processing (echo cancellation, noise suppression, auto-gain) actively
    // distorts an instrument's harmonic content — turn it off so pitch detection sees a clean signal.
    const audioConstraints = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    if (deviceId) audioConstraints.deviceId = { exact: deviceId };
    this.stream = streamOverride || await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints,
      video: false,
    });
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    const source = this.ctx.createMediaStreamSource(this.stream);
    this.gainNode = this.ctx.createGain();
    this.gainNode.gain.value = DEFAULT_INPUT_GAIN;
    this.analyser = this.ctx.createAnalyser();
    // 4096 (not 2048): low strings need several full cycles in the window for autocorrelation
    // to lock onto the fundamental confidently — at 2048 a clean low-E tone measured confidence
    // ~0.6-0.7 vs ~0.9 for high strings, leaving little margin before MIN_CONFIDENCE rejects it
    // under real mic noise. 4096 raises low-string confidence to ~0.82-0.86, at the cost of
    // roughly 43ms more detection latency (~85ms window instead of ~43ms at 48kHz).
    this.analyser.fftSize = 4096;
    source.connect(this.gainNode);
    this.gainNode.connect(this.analyser);
    this.buffer = new Float32Array(this.analyser.fftSize);
    this._loop();
  },

  setGain(value) {
    if (this.gainNode) this.gainNode.gain.value = value;
  },

  _loop() {
    this.analyser.getFloatTimeDomainData(this.buffer);
    const freq = autoCorrelate(this.buffer, this.ctx.sampleRate);
    updateLevelMeter(lastPitchDebug.rms);
    if (this.onFrame) this.onFrame(freq > 0 ? freq : null);
    this.rafId = requestAnimationFrame(() => this._loop());
  },

  stop() {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.ctx) this.ctx.close().catch(() => {});
    this.ctx = null;
    this.analyser = null;
    this.stream = null;
  },
};

function updateLevelMeter(rms) {
  const fill = document.getElementById("level-meter-fill");
  if (!fill) return;
  // rms of a real pluck through an interface tends to peak well under 1.0 — scale so a solid
  // signal reads as a mostly-full bar without needing to redo this once real gear is tried.
  const pct = Math.min(100, (rms / 0.35) * 100);
  fill.style.width = `${pct}%`;
  // Past this point the boosted signal is likely clipping, which hurts pitch detection —
  // flag it so "turn the boost down" is as discoverable as "turn it up".
  fill.style.background = rms > 0.9 ? "var(--red)" : "";
}

/* ---------------------------------------------------------------------- *
 * Microphone device selection
 * ---------------------------------------------------------------------- */

const MicDevices = {
  // selectId lets both the Play screen's mic-gate and the standalone Tuner's mic-gate share
  // this same device list/permission flow (there's still only one shared PitchEngine session).
  async populate(selectId = "mic-device-select") {
    const select = document.getElementById(selectId);
    const saved = localStorage.getItem("sht_mic_device_id");
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter((d) => d.kind === "audioinput");
      select.innerHTML =
        `<option value="">System default</option>` +
        inputs
          .map((d, i) => `<option value="${d.deviceId}">${d.label || `Microphone ${i + 1}`}</option>`)
          .join("");
      if (saved && inputs.some((d) => d.deviceId === saved)) select.value = saved;
    } catch {
      // enumerateDevices can fail before any permission has ever been granted — the
      // "System default" fallback option still lets Start Listening work.
    }
  },

  selectedId(selectId = "mic-device-select") {
    return document.getElementById(selectId).value || null;
  },

  remember(deviceId) {
    if (deviceId) localStorage.setItem("sht_mic_device_id", deviceId);
  },
};

/* ---------------------------------------------------------------------- *
 * Calibration — raw, ungated pitch feedback so it's obvious whether the
 * mic pipeline hears anything at all, before gating kicks in for practice.
 * ---------------------------------------------------------------------- */

const Calibration = {
  onFrame(freq) {
    const noteEl = document.getElementById("calib-note");
    const detailEl = document.getElementById("calib-detail");
    if (freq) {
      noteEl.textContent = freqToNoteName(freq);
      detailEl.textContent =
        `${freq.toFixed(1)} Hz · clarity ${lastPitchDebug.confidence.toFixed(2)} · level ${lastPitchDebug.rms.toFixed(3)}`;
    } else {
      noteEl.textContent = "—";
      detailEl.textContent =
        `Waiting for a note… (level ${lastPitchDebug.rms.toFixed(3)}, clarity ${lastPitchDebug.confidence.toFixed(2)})`;
    }
  },
};

/* ---------------------------------------------------------------------- *
 * TUNER — standalone chromatic-per-string tuner. Its tuning list is pulled
 * straight from whatever tunings actually appear in the song library (same
 * grouping as the menu's tuning filter), so "the different options" it can
 * tune to always matches what's playable. Live/ungated like Calibration —
 * no CONFIRM_FRAMES debounce, since a tuner should feel instantly responsive.
 * ---------------------------------------------------------------------- */

const TUNER_CENTS_TOLERANCE = 8; // much tighter than gameplay's MATCH_CENTS_TOLERANCE — real tuning precision

const Tuner = {
  tunings: [],        // [{ key, tuning, tuningOffsets }], derived from SONGS
  current: null,       // the tuning entry currently selected
  lockedString: null,  // 1-6 if the player picked a specific string to tune to; null = auto-detect nearest
  activeString: null,  // whichever string is currently being shown (locked, or nearest-match)
  listening: false,

  buildTunings() {
    const map = new Map();
    for (const { data } of SONGS) {
      const key = tuningKey(data.tuning);
      if (!map.has(key)) map.set(key, { key, tuning: data.tuning, tuningOffsets: data.tuningOffsets || null });
    }
    this.tunings = [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
    // Standard tuning first, if present — the expected default to land on.
    const stdIdx = this.tunings.findIndex((t) => !t.tuningOffsets || t.tuningOffsets.every((o) => o === 0));
    if (stdIdx > 0) this.tunings.unshift(this.tunings.splice(stdIdx, 1)[0]);
  },

  enter() {
    if (!this.tunings.length) this.buildTunings();
    if (!this.current) this.setTuning(this.tunings[0].key);
    else this.populateTuningSelect();

    if (PitchEngine.ctx) {
      // Mic already granted/running from Play mode (or an earlier tuner visit) — reuse it.
      document.getElementById("tuner-mic-gate").classList.add("hidden");
      document.getElementById("tuner-surface").classList.remove("hidden");
      PitchEngine.onFrame = (freq) => this.onFrame(freq);
      this.listening = true;
    } else {
      document.getElementById("tuner-mic-gate").classList.remove("hidden");
      document.getElementById("tuner-surface").classList.add("hidden");
      MicDevices.populate("tuner-mic-device-select");
    }
  },

  async beginListening() {
    const deviceId = MicDevices.selectedId("tuner-mic-device-select");
    try {
      await PitchEngine.start(null, deviceId);
      MicDevices.remember(deviceId);
      MicDevices.populate("tuner-mic-device-select");
      document.getElementById("tuner-mic-gate").classList.add("hidden");
      document.getElementById("tuner-surface").classList.remove("hidden");
      PitchEngine.onFrame = (freq) => this.onFrame(freq);
      this.listening = true;
    } catch {
      document.getElementById("tuner-mic-error").textContent =
        "Couldn't access that microphone. Check browser permissions, that a mic is connected, and try a different input device above.";
    }
  },

  stop() {
    this.listening = false;
    PitchEngine.onFrame = null;
  },

  setTuning(key) {
    this.current = this.tunings.find((t) => t.key === key) || this.tunings[0];
    this.lockedString = null;
    this.activeString = null;
    this.populateTuningSelect();
    document.getElementById("tuner-tuning-name").textContent = this.current.key;
    this.renderStrings();
  },

  populateTuningSelect() {
    const select = document.getElementById("tuner-tuning-select");
    select.innerHTML = this.tunings.map((t) => `<option value="${t.key}">${t.key}</option>`).join("");
    select.value = this.current.key;
  },

  stringFreq(stringNum) {
    return noteFrequency(stringNum, 0, this.current.tuningOffsets);
  },

  renderStrings() {
    const el = document.getElementById("tuner-strings");
    el.innerHTML = STRING_ORDER.map((s) => `
      <button class="tuner-string-btn" data-string="${s}">
        <span class="string-num">${stringLabel(this.current, s)} string</span>
        <span class="string-note">${freqToNoteName(this.stringFreq(s))}</span>
      </button>`).join("");
    el.querySelectorAll(".tuner-string-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const s = Number(btn.dataset.string);
        this.lockedString = this.lockedString === s ? null : s; // click again to release back to auto
        this.updateStringHighlights();
      });
    });
    this.updateStringHighlights();
  },

  onFrame(freq) {
    if (!this.listening) return;
    if (!freq) {
      this.activeString = this.lockedString;
      this.updateReadout(null, null);
      this.updateStringHighlights();
      return;
    }
    let targetString = this.lockedString;
    if (!targetString) {
      let best = null, bestAbsCents = Infinity;
      for (const s of STRING_ORDER) {
        const absCents = Math.abs(centsBetween(freq, this.stringFreq(s)));
        if (absCents < bestAbsCents) { bestAbsCents = absCents; best = s; }
      }
      targetString = best;
    }
    this.activeString = targetString;
    const cents = centsBetween(freq, this.stringFreq(targetString));
    this.updateReadout(freq, cents);
    this.updateStringHighlights(cents);
  },

  updateReadout(freq, cents) {
    const noteEl = document.getElementById("tuner-big-note");
    const dirEl = document.getElementById("tuner-big-direction");
    const needle = document.getElementById("tuner-big-needle");
    const readout = document.getElementById("tuner-big-readout");
    if (!freq) {
      noteEl.textContent = this.activeString ? stringLabel(this.current, this.activeString).toUpperCase() : "—";
      noteEl.classList.remove("in-tune");
      dirEl.textContent = this.lockedString ? "Pluck the string" : "Pick a string";
      needle.style.left = "50%";
      needle.style.background = "#fff";
      readout.textContent = `Listening… (level ${lastPitchDebug.rms.toFixed(3)}, clarity ${lastPitchDebug.confidence.toFixed(2)})`;
      return;
    }
    const inTune = Math.abs(cents) <= TUNER_CENTS_TOLERANCE;
    noteEl.textContent = freqToNoteName(this.stringFreq(this.activeString));
    noteEl.classList.toggle("in-tune", inTune);
    dirEl.textContent = inTune ? "In tune ✓" : cents > 0 ? "Tune down ▼" : "Tune up ▲";
    const clamped = Math.max(-50, Math.min(50, cents));
    needle.style.left = `${50 + clamped}%`;
    needle.style.background = inTune ? "var(--green-bright)" : "#fff";
    readout.textContent = `${freq.toFixed(1)} Hz · ${cents > 0 ? "+" : ""}${cents.toFixed(0)}¢`;
  },

  updateStringHighlights(cents) {
    document.querySelectorAll("#tuner-strings .tuner-string-btn").forEach((btn) => {
      const s = Number(btn.dataset.string);
      const inTune = this.activeString === s && cents != null && Math.abs(cents) <= TUNER_CENTS_TOLERANCE;
      btn.classList.toggle("locked", this.lockedString === s);
      btn.classList.toggle("auto-target", !this.lockedString && this.activeString === s);
      btn.classList.toggle("in-tune", inTune);
    });
  },
};

/* ---------------------------------------------------------------------- *
 * SFX — small synthesized sounds, own AudioContext (independent of
 * PitchEngine's mic-analysis context so it works even pre-permission).
 *
 * PlayMode.correctHit uses `pluck(targetFreq)` as the hit sound, at the exact
 * pitch of the note just played. That doubles as a lightweight "backing
 * track": there's no way to legally or technically play the actual studio
 * recording in sync with an arbitrary player's timing (no rights to it, and
 * nothing to fetch it from) — but a synthesized echo of each note, fired the
 * instant the player nails it, is inherently paced to them exactly: it can
 * never run ahead, and it silently waits out any pause since it's driven by
 * their own hits rather than a clock.
 * ---------------------------------------------------------------------- */

const SFX = {
  ctx: null,

  ensureCtx() {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === "suspended") this.ctx.resume();
    return this.ctx;
  },

  pluck(freq, { volume = 0.18, decay = 0.32 } = {}) {
    const ctx = this.ensureCtx();
    const t0 = ctx.currentTime;

    const body = ctx.createOscillator();
    body.type = "triangle";
    body.frequency.setValueAtTime(freq, t0);
    const bodyGain = ctx.createGain();
    bodyGain.gain.setValueAtTime(0, t0);
    bodyGain.gain.linearRampToValueAtTime(volume, t0 + 0.004);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, t0 + decay);
    body.connect(bodyGain).connect(ctx.destination);
    body.start(t0);
    body.stop(t0 + decay + 0.05);

    // Quiet octave-up bite so it reads as a plucked string, not a pure tone.
    const bite = ctx.createOscillator();
    bite.type = "sawtooth";
    bite.frequency.setValueAtTime(freq * 2, t0);
    const biteGain = ctx.createGain();
    biteGain.gain.setValueAtTime(0, t0);
    biteGain.gain.linearRampToValueAtTime(volume * 0.22, t0 + 0.004);
    biteGain.gain.exponentialRampToValueAtTime(0.0001, t0 + decay * 0.5);
    bite.connect(biteGain).connect(ctx.destination);
    bite.start(t0);
    bite.stop(t0 + decay * 0.5 + 0.05);
  },

  miss() {
    const ctx = this.ensureCtx();
    const t0 = ctx.currentTime;
    const size = Math.floor(ctx.sampleRate * 0.12);
    const buffer = ctx.createBuffer(1, size, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < size; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / size);

    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(350, t0);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.22, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.12);
    noise.connect(filter).connect(gain).connect(ctx.destination);
    noise.start(t0);
  },

  clear() {
    [523.25, 659.25, 783.99].forEach((f, i) => // C5 E5 G5
      setTimeout(() => this.pluck(f, { volume: 0.15, decay: 0.4 }), i * 90));
  },
};

/* ---------------------------------------------------------------------- *
 * Metronome — quiet background click, independent of note progression.
 * Runs on its own AudioContext/timer; BPM is picked up live (no restart
 * needed) since the interval is recomputed on every scheduled tick.
 * ---------------------------------------------------------------------- */

const Metronome = {
  ctx: null,
  running: false,
  bpm: 120,
  beatCount: 0,
  timerId: null,

  ensureCtx() {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === "suspended") this.ctx.resume();
    return this.ctx;
  },

  start(bpm) {
    this.stop();
    this.bpm = bpm;
    this.running = true;
    this.beatCount = 0;
    this._tick();
  },

  stop() {
    this.running = false;
    if (this.timerId) clearTimeout(this.timerId);
    this.timerId = null;
  },

  setBpm(bpm) {
    this.bpm = bpm;
  },

  _tick() {
    if (!this.running) return;
    this._click(this.beatCount % 4 === 0);
    this.beatCount++;
    this.timerId = setTimeout(() => this._tick(), 60000 / this.bpm);
  },

  _click(accent) {
    const ctx = this.ensureCtx();
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.setValueAtTime(accent ? 1600 : 1000, t0);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(accent ? 0.07 : 0.045, t0); // deliberately quiet/background
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.03);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.035);
  },
};

/* ---------------------------------------------------------------------- *
 * GuitarVoice — a plucked electric-guitar voice, used only by Demo. Shares
 * SFX's AudioContext.
 *
 * Each note is a *modal* string model rather than a raw oscillator: a stack
 * of sine partials at n×f (slightly stretched by string stiffness), each
 * with its own decay (highs die fast, the fundamental rings), scaled by a
 * pluck-position comb, plus a short filtered-noise pick attack.
 *
 * That stack feeds one shared two-stage high-gain "amp" (see `ensure`):
 * tighten/pre-emphasis → compressor → gain → soft clip → gain → hard clip →
 * scooped+present cab EQ → brickwall limiter. `_drive` is the gain knob.
 * The user's progression here: sawtooths+heavy shaper = "metallic/bips" →
 * pure modal string = "too acoustic" → modal string + mild overdrive =
 * "not enough" → this, cascaded high-gain.
 * ---------------------------------------------------------------------- */

const GuitarVoice = {
  amp: null,     // per-note graphs connect here
  master: null,
  _level: 0.16,
  _drive: 8,     // gain into the first clip stage — the main "gain" knob
  live: [],      // scheduled source nodes, tracked so a stop can silence them

  // A two-stage high-gain amp: tighten the lows and boost highs into a compressor,
  // then gain -> soft clip -> gain -> hard clip (cascaded saturation, the way a
  // real high-gain preamp stacks stages), then a scooped/present cab EQ and a
  // brickwall limiter. `_drive` is the gain knob; the limiter is load-bearing —
  // without it dense passages peak well past 1 and clip.
  ensure() {
    const ctx = SFX.ensureCtx();
    if (this.amp) return ctx;

    const input = ctx.createGain();

    const tighten = ctx.createBiquadFilter();   // no flubby low end under high gain
    tighten.type = "highpass"; tighten.frequency.value = 110;
    const preEmph = ctx.createBiquadFilter();   // push highs into the clipper -> more aggressive
    preEmph.type = "highshelf"; preEmph.frequency.value = 1400; preEmph.gain.value = 6;

    const comp = ctx.createDynamicsCompressor(); // even out attacks, feed the clipper a steady level -> sustain
    comp.threshold.value = -24; comp.knee.value = 20; comp.ratio.value = 4;
    comp.attack.value = 0.004; comp.release.value = 0.18;

    const d1 = ctx.createGain(); d1.gain.value = this._drive;
    const s1 = ctx.createWaveShaper(); s1.curve = this._clip(2.5, 0.15); s1.oversample = "4x";
    const mid = ctx.createBiquadFilter();       // clean up mud between the two stages
    mid.type = "highpass"; mid.frequency.value = 150;
    const d2 = ctx.createGain(); d2.gain.value = 3;
    const s2 = ctx.createWaveShaper(); s2.curve = this._clip(6, 0.05); s2.oversample = "4x";

    const deEmph = ctx.createBiquadFilter();    // undo the pre-emphasis + tame fizz
    deEmph.type = "highshelf"; deEmph.frequency.value = 3200; deEmph.gain.value = -5;
    const scoop = ctx.createBiquadFilter();
    scoop.type = "peaking"; scoop.frequency.value = 560; scoop.Q.value = 0.8; scoop.gain.value = -4;
    const presence = ctx.createBiquadFilter();
    presence.type = "peaking"; presence.frequency.value = 2700; presence.Q.value = 0.8; presence.gain.value = 4;
    const cab = ctx.createBiquadFilter();       // speaker roll-off
    cab.type = "lowpass"; cab.frequency.value = 5000; cab.Q.value = 0.7;

    const limiter = ctx.createDynamicsCompressor(); // brickwall — keeps dense passages from clipping
    limiter.threshold.value = -6; limiter.knee.value = 2; limiter.ratio.value = 16;
    limiter.attack.value = 0.002; limiter.release.value = 0.12;

    const master = ctx.createGain();
    master.gain.value = this._level;

    input.connect(tighten).connect(preEmph).connect(comp).connect(d1).connect(s1).connect(mid)
      .connect(d2).connect(s2).connect(deEmph).connect(scoop).connect(presence).connect(cab)
      .connect(limiter).connect(master).connect(ctx.destination);

    this.amp = input;
    this.master = master;
    return ctx;
  },

  // Asymmetric soft-clip (tanh). `bias` skews it so the positive half saturates
  // harder — generates even harmonics on top of the odd ones for a tube-ish feel.
  _clip(k, bias) {
    const n = 2048, c = new Float32Array(n);
    const off = Math.tanh(k * bias);
    const norm = Math.tanh(k * (1 + bias)) - off;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      c[i] = (Math.tanh(k * (x + bias)) - off) / norm;
    }
    return c;
  },

  // Schedule one plucked note at absolute AudioContext time `when`.
  note(freq, when, dur, velocity = 1) {
    const ctx = SFX.ctx;
    const held = Math.max(dur || 0, 0.11);
    const peak = 0.13 * (0.7 + 0.3 * velocity);
    const pluckPos = 0.1 + Math.random() * 0.06;     // fraction along the string — near the bridge, brighter
    const stiffness = 0.0004;                        // inharmonicity: partials creep sharp of n×f
    const baseDecay = 2.2 + Math.random() * 0.6;     // fundamental ring time (s) — electric sustains

    // after the notated length, ease everything down so dense passages don't turn to mud
    const rel = ctx.createGain();
    rel.gain.setValueAtTime(1, when);
    rel.gain.setValueAtTime(1, when + held);
    rel.gain.setTargetAtTime(0.32, when + held, 0.18);
    rel.connect(this.amp);

    const maxN = Math.min(14, Math.floor(6500 / freq));
    for (let n = 1; n <= maxN; n++) {
      const pf = freq * n * Math.sqrt(1 + stiffness * n * n);
      if (pf > 7200) break;
      // flatter harmonic rolloff than an acoustic — more high-partial energy for the drive to chew on
      const amp = Math.abs(Math.sin(n * Math.PI * pluckPos)) / Math.pow(n, 1.0);
      if (amp < 0.003) continue;
      const decay = Math.max(0.14, baseDecay / (1 + (n - 1) * 0.42));

      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.value = pf;
      o.detune.value = Math.random() * 5 - 2.5;

      const g = ctx.createGain();
      g.gain.setValueAtTime(0, when);
      g.gain.linearRampToValueAtTime(amp * peak, when + 0.004);
      g.gain.exponentialRampToValueAtTime(Math.max(amp * peak * 0.0008, 1e-5), when + decay);

      o.connect(g).connect(rel);
      const stopAt = when + Math.min(decay, held + 1) + 0.05;
      o.start(when);
      o.stop(stopAt);
      this.live.push(o);
    }

    // pick attack — short filtered noise "chk"
    const len = Math.floor(ctx.sampleRate * 0.022);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
    const nb = ctx.createBufferSource();
    nb.buffer = buf;
    const nf = ctx.createBiquadFilter();
    nf.type = "bandpass";
    nf.frequency.value = Math.min(Math.max(freq * 4, 1400), 3000);
    nf.Q.value = 0.7;
    const ng = ctx.createGain();
    ng.gain.value = 0.08 * (0.6 + 0.4 * velocity);
    nb.connect(nf).connect(ng).connect(rel);
    nb.start(when);
    this.live.push(nb);

    if (this.live.length > 600) this.live = this.live.slice(-320); // prune old refs
  },

  // Fade the amp and hard-stop every scheduled node — used when a demo is stopped.
  panic() {
    const ctx = SFX.ctx;
    if (!ctx || !this.master) { this.live = []; return; }
    const now = ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(this.master.gain.value, now);
    this.master.gain.linearRampToValueAtTime(0.0001, now + 0.06);
    for (const n of this.live) { try { n.stop(now + 0.09); } catch (e) { /* already stopped */ } }
    this.live = [];
    this.master.gain.setValueAtTime(this._level, now + 0.13); // restore for the next demo
  },
};

/* ---------------------------------------------------------------------- *
 * Demo — "Hear it": plays the loaded song through GuitarVoice while the
 * tab strip scrolls continuously in sync, so the player gets a worked
 * example. Reuses the strip that PlayMode already built (notes,
 * notePositions, chipEls, tailEls). No mic involved.
 *
 * Audio is scheduled a short way ahead on the AudioContext clock (sample-
 * accurate); the visual scroll is a rAF loop reading the same clock, so
 * sound and picture stay locked. Notes get small random timing/pitch/
 * velocity wobble so it doesn't sound like a sequencer.
 * ---------------------------------------------------------------------- */

const Demo = {
  running: false,
  paused: false,
  rafId: null,
  metroTimer: null,
  notes: null,
  positions: null,
  playTimes: null, // notes[i].time re-scaled to the chosen playback tempo (seconds)
  song: null,
  rate: 1,         // chosen BPM / song BPM
  audioStart: 0,
  nextIdx: 0,      // next note to schedule for audio
  shownIdx: -1,    // last note index reflected in the strip highlight
  _pausedT: 0,     // playback time (s since first note) captured when paused/scrubbing
  _scrubResume: false, // was playback running when the user grabbed the seek slider?
  LEAD_IN: 0.4,

  toggle() {
    if (this.running) this.exit();
    else this.start();
  },

  start() {
    if (!PlayMode.notes || !PlayMode.notes.length) return;
    if (this.running) this.stopInternal();

    this.notes = PlayMode.notes;
    this.positions = PlayMode.notePositions;
    this.song = PlayMode.song;
    const ctx = GuitarVoice.ensure();

    PlayMode.stop(); // pause mic listening / metronome if they were active

    // Play at whatever tempo the BPM select shows; the metronome clicks along with it.
    const bpm = Number(document.getElementById("metronome-bpm").value) || this.song.bpm || 120;
    this.rate = bpm / (this.song.bpm || bpm);
    this.playTimes = this.notes.map((n) => (n.time || 0) / this.rate);

    document.getElementById("mic-gate").classList.add("hidden");
    document.getElementById("calibration-panel").classList.add("hidden");
    document.getElementById("listening-tools").classList.remove("hidden"); // keep the BPM select reachable
    document.getElementById("play-results").classList.add("hidden");
    const surface = document.getElementById("play-surface");
    surface.classList.remove("hidden");
    surface.classList.add("demo-mode");
    document.getElementById("combo-badge").classList.add("hidden");
    document.querySelector(".target-label").textContent = "Now playing — listen & watch";
    for (const b of this._btns()) { b.textContent = "⏹ Stop"; b.classList.add("playing"); }

    for (let i = 0; i < this.notes.length; i++) this._setChip(i, "upcoming");

    this.running = true;
    this.paused = false;
    this._scrubResume = false;
    this.nextIdx = 0;
    this.shownIdx = -1;
    this.audioStart = ctx.currentTime + this.LEAD_IN;

    // start the click on the first beat (end of the lead-in), so it lines up with the notes
    const metroBtn = document.getElementById("metronome-toggle");
    this.metroTimer = setTimeout(() => {
      if (!this.running) return;
      Metronome.start(bpm);
      metroBtn.textContent = "🥁 Metronome: On";
      metroBtn.classList.add("active");
    }, this.LEAD_IN * 1000);

    this._loop();
    Transport.syncSlider();
    Transport.updateToggleLabel();
  },

  _btns() {
    return [document.getElementById("demo-btn"), document.getElementById("demo-btn-gate")];
  },

  _loop() {
    if (!this.running || this.paused) return;
    const ctx = SFX.ctx;
    const t = ctx.currentTime - this.audioStart; // seconds since the first note (negative during lead-in)

    // schedule audio ~0.4s ahead of the clock
    while (this.nextIdx < this.notes.length && this.playTimes[this.nextIdx] < t + 0.4) {
      const n = this.notes[this.nextIdx];
      const freq = noteFrequency(n.string, n.fret, this.song.tuningOffsets)
        * Math.pow(2, (Math.random() * 6 - 3) / 1200); // ±3¢ so it isn't sterile
      const jitter = Math.random() * 0.026 - 0.01;     // loose timing
      const vel = 0.72 + Math.random() * 0.28;
      const when = Math.max(ctx.currentTime + 0.02, this.audioStart + this.playTimes[this.nextIdx] + jitter);
      GuitarVoice.note(freq, when, (n.duration || 0.2) / this.rate, vel);
      this.nextIdx++;
    }

    // continuous scroll
    document.getElementById("track-strip").style.transform =
      `translateX(${PLAYHEAD_X - this._xAt(t)}px)`;

    // highlight progress (forward-only)
    let cur = -1;
    for (let i = 0; i < this.notes.length; i++) {
      if (this.playTimes[i] <= t + 0.015) cur = i; else break;
    }
    if (cur !== this.shownIdx) {
      for (let i = Math.max(0, this.shownIdx); i <= cur; i++) {
        this._setChip(i, i < cur ? "played" : "current", i === cur);
      }
      if (cur >= 0) {
        const n = this.notes[cur];
        const f = noteFrequency(n.string, n.fret, this.song.tuningOffsets);
        document.getElementById("target-note").textContent =
          `${stringLabel(this.song, n.string).toUpperCase()} — fret ${n.fret}`;
        document.getElementById("target-hint").textContent =
          `${freqToNoteName(f)} · note ${cur + 1} / ${this.notes.length}`;
      }
      this.shownIdx = cur;
      Transport.syncSlider();
    }

    if (t > this.playTimes[this.playTimes.length - 1] +
        (this.notes[this.notes.length - 1].duration || 0) / this.rate + 1.4) {
      this.exit();
      return;
    }

    this.rafId = requestAnimationFrame(() => this._loop());
  },

  _setChip(i, state, flash) {
    const cls = state === "played" ? "played-correct" : state === "current" ? "current" : "upcoming";
    for (const el of [PlayMode.chipEls[i], PlayMode.tailEls[i]]) {
      if (!el) continue;
      el.classList.remove("played-correct", "played-wrong", "current", "upcoming", "match-flash");
      el.classList.add(cls);
    }
    if (flash && PlayMode.chipEls[i]) {
      void PlayMode.chipEls[i].offsetWidth;
      PlayMode.chipEls[i].classList.add("match-flash");
    }
  },

  // Interpolated x-position for playhead time `t` (seconds since the first note). The strip's
  // pixel layout is fixed; a faster tempo just traverses it faster. `pt` = scaled note times.
  _xAt(t) {
    const pt = this.playTimes, pos = this.positions;
    const speed = PIXELS_PER_SECOND * this.rate; // px per real second at this tempo
    if (t <= pt[0]) return (pos[0].x - pt[0] * speed) + t * speed; // linear pre-roll
    let i = 0;
    for (let k = 0; k < pt.length; k++) { if (pt[k] <= t) i = k; else break; }
    if (i >= pt.length - 1) return pos[i].x + (t - pt[i]) * speed;
    if (pt[i + 1] <= pt[i]) return pos[i].x;
    return pos[i].x + (pos[i + 1].x - pos[i].x) * ((t - pt[i]) / (pt[i + 1] - pt[i]));
  },

  togglePause() {
    if (!this.running) return;
    if (this.paused) this.resume();
    else this.pause();
  },

  pause() {
    if (!this.running || this.paused) return;
    this.paused = true;
    this._pausedT = SFX.ctx.currentTime - this.audioStart;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    if (this.metroTimer) { clearTimeout(this.metroTimer); this.metroTimer = null; }
    this._stopMetro();
    GuitarVoice.panic();
    Transport.updateToggleLabel();
  },

  resume() {
    if (!this.running || !this.paused) return;
    this.paused = false;
    const ctx = GuitarVoice.ensure();
    const startT = Math.max(0, this._pausedT);
    this.audioStart = ctx.currentTime + 0.15 - startT;
    this.nextIdx = 0;
    while (this.nextIdx < this.notes.length && this.playTimes[this.nextIdx] < startT) this.nextIdx++;
    this.shownIdx = this.nextIdx - 1;
    const bpm = Number(document.getElementById("metronome-bpm").value) || this.song.bpm || 120;
    this.metroTimer = setTimeout(() => {
      if (!this.running || this.paused) return;
      this._startMetro(bpm);
    }, 150);
    Transport.updateToggleLabel();
    this._loop();
  },

  // Live drag on the seek slider: freeze playback and move the view to note `i`.
  scrub(i) {
    if (!this.running) return;
    if (!this.paused) { this._scrubResume = true; this.pause(); }
    this._pausedT = this.playTimes[i] || 0;
    this._renderAt(this._pausedT);
  },

  // Seek slider released: land the seek there, and resume if playback was running when grabbed.
  commitScrub(i) {
    if (!this.running) return;
    this._pausedT = this.playTimes[i] || 0;
    if (this._scrubResume) { this._scrubResume = false; this.resume(); }
    else this._renderAt(this._pausedT);
  },

  // Paint the strip + chip states + labels for playback time `t`, without advancing the clock.
  _renderAt(t) {
    document.getElementById("track-strip").style.transform =
      `translateX(${PLAYHEAD_X - this._xAt(t)}px)`;
    let cur = -1;
    for (let i = 0; i < this.notes.length; i++) {
      if (this.playTimes[i] <= t + 0.015) cur = i; else break;
    }
    for (let i = 0; i < this.notes.length; i++) {
      this._setChip(i, i < cur ? "played" : i === cur ? "current" : "upcoming");
    }
    this.shownIdx = cur;
    if (cur >= 0) {
      const n = this.notes[cur];
      const f = noteFrequency(n.string, n.fret, this.song.tuningOffsets);
      document.getElementById("target-note").textContent =
        `${stringLabel(this.song, n.string).toUpperCase()} — fret ${n.fret}`;
      document.getElementById("target-hint").textContent =
        `${freqToNoteName(f)} · note ${cur + 1} / ${this.notes.length}`;
    }
    Transport.syncSlider();
  },

  _startMetro(bpm) {
    Metronome.start(bpm);
    const b = document.getElementById("metronome-toggle");
    b.textContent = "🥁 Metronome: On";
    b.classList.add("active");
  },

  _stopMetro() {
    Metronome.stop();
    const b = document.getElementById("metronome-toggle");
    b.textContent = "🥁 Metronome: Off";
    b.classList.remove("active");
  },

  stopInternal() {
    this.running = false;
    this.paused = false;
    this._scrubResume = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    if (this.metroTimer) { clearTimeout(this.metroTimer); this.metroTimer = null; }
    Metronome.stop();
    const metroBtn = document.getElementById("metronome-toggle");
    metroBtn.textContent = "🥁 Metronome: Off";
    metroBtn.classList.remove("active");
    GuitarVoice.panic();
    document.getElementById("play-surface").classList.remove("demo-mode");
    document.querySelector(".target-label").textContent = "Play this note";
    for (const b of this._btns()) {
      b.textContent = b.id === "demo-btn" ? "🎧 Hear it" : "🎧 Hear an example first";
      b.classList.remove("playing");
    }
  },

  // Stop and put the play screen back to its starting state (mic-gate, or the
  // practice surface if the mic is already running).
  exit() {
    const wasRunning = this.running;
    this.stopInternal();
    if (wasRunning && PlayMode.song) PlayMode.load(PlayMode.songId, PlayMode.song);
  },

  // Teardown only — for navigation away, where the screen is changing anyway.
  stop() {
    if (this.running || this.rafId) this.stopInternal();
  },
};

/* ---------------------------------------------------------------------- *
 * Transport — the shared pause button + minimap seek bar under the target
 * panel. Drives Demo playback when a demo is running, otherwise jumps
 * PlayMode's practice position. One control, two modes (the `.demo-mode`
 * class on #play-surface says which). The minimap is a VS-Code-style
 * scaled overview of every note in the song; click/drag anywhere on it
 * to seek there.
 * ---------------------------------------------------------------------- */

function fmtTime(s) {
  s = Math.max(0, Math.round(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const Transport = {
  get inDemo() {
    return document.getElementById("play-surface").classList.contains("demo-mode");
  },

  _notes() { return this.inDemo ? Demo.notes : PlayMode.notes; },
  _index() { return this.inDemo ? Math.max(0, Demo.shownIdx) : PlayMode.currentIndex; },

  // Keep the minimap head, viewport band and time label in step with playback / practice.
  // Cheap: percentage math only, no layout reads (widths are cached at build time).
  syncSlider() {
    const notes = this._notes();
    if (!notes || !notes.length) return;
    if (this.mm._builtFor !== notes) this.mm.build(notes);
    this.mm.updateHead();
    const total = this.mm.total;
    const i = Math.min(this._index(), notes.length - 1);
    const now = this.inDemo && Demo.playTimes ? (Demo.playTimes[i] || 0) : notes[i].time;
    const end = this.inDemo && Demo.playTimes ? (Demo.playTimes[Demo.playTimes.length - 1] || 0) : total;
    document.getElementById("seek-label").textContent = `${fmtTime(now)} / ${fmtTime(end)}`;
  },

  updateToggleLabel() {
    const btn = document.getElementById("transport-toggle");
    const paused = this.inDemo ? Demo.paused : PlayMode.paused;
    btn.textContent = paused ? "▶ Resume" : "⏸ Pause";
    btn.classList.toggle("active", paused);
  },

  mm: {
    _builtFor: null,
    total: 0,
    _vpWidth: 700,

    build(notes) {
      this._builtFor = notes;
      const last = notes[notes.length - 1];
      this.total = (last.time || 0) + (last.duration || 0) || 1;
      const rows = STRING_ORDER.length;
      document.getElementById("minimap-notes").innerHTML = notes.map((n) => {
        const x = ((n.time || 0) / this.total) * 100;
        const y = ((STRING_ORDER.indexOf(n.string) + 0.5) / rows) * 100;
        return `<i style="left:${x.toFixed(3)}%;top:${y.toFixed(1)}%;background:${LANE_COLORS[n.string]}"></i>`;
      }).join("");
      this.measureViewport();
      this.updateHead();
    },

    measureViewport() {
      const vp = document.querySelector(".track-viewport");
      if (vp && vp.clientWidth) this._vpWidth = vp.clientWidth;
    },

    updateHead() {
      const notes = Transport._notes();
      if (!notes || !this.total) return;
      const t = notes[Math.min(Transport._index(), notes.length - 1)].time || 0;
      document.getElementById("minimap-head").style.left = `${((t / this.total) * 100).toFixed(3)}%`;
      // band = the slice of the song currently inside the main track viewport
      const secPerPx = 1 / (PIXELS_PER_SECOND * (Transport.inDemo ? (Demo.rate || 1) : 1));
      const t0 = t - PLAYHEAD_X * secPerPx;
      const t1 = t + (this._vpWidth - PLAYHEAD_X) * secPerPx;
      const L = Math.max(0, (t0 / this.total) * 100);
      const R = Math.min(100, (t1 / this.total) * 100);
      const band = document.getElementById("minimap-view");
      band.style.left = `${L.toFixed(3)}%`;
      band.style.width = `${Math.max(0, R - L).toFixed(3)}%`;
    },

    // Pointer x (client coords) -> nearest note index.
    idxAt(clientX) {
      const notes = Transport._notes();
      const r = document.getElementById("minimap").getBoundingClientRect();
      const targetT = Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * this.total;
      let best = 0, bd = Infinity;
      for (let k = 0; k < notes.length; k++) {
        const d = Math.abs((notes[k].time || 0) - targetT);
        if (d < bd) { bd = d; best = k; }
      }
      return best;
    },
  },
};

/* ---------------------------------------------------------------------- *
 * Screens
 * ---------------------------------------------------------------------- */

const Screens = {
  show(id) {
    document.querySelectorAll(".screen").forEach((el) => el.classList.remove("active"));
    document.getElementById(`screen-${id}`).classList.add("active");
    if (id !== "play") { PlayMode.stop(); Demo.stop(); }
    if (id !== "tuner") Tuner.stop();
    else Tuner.enter();
  },
};

/* ---------------------------------------------------------------------- *
 * Boot / song menu
 * ---------------------------------------------------------------------- */

async function boot() {
  const manifest = await fetch("/songs/manifest.json").then((r) => r.json());
  SONGS = await Promise.all(
    manifest.map(async (entry) => {
      const data = await fetch(`/songs/${entry.file}`).then((r) => r.json());
      return { id: entry.id, data };
    })
  );
  renderSongList();
}

function completions(songId) {
  return Number(localStorage.getItem(`sht_completions_${songId}`) || 0);
}
function bumpCompletions(songId) {
  localStorage.setItem(`sht_completions_${songId}`, String(completions(songId) + 1));
}

const COVER_EMOJI = ["🎸", "🤘", "🔥", "⚡"];

// null = "All Tunings". Persisted so the filter survives a reload, like the mic device pick.
let activeTuningFilter = localStorage.getItem("sht_tuning_filter") || null;

function renderTuningFilters() {
  const row = document.getElementById("tuning-filter-row");
  const counts = new Map();
  for (const { data } of SONGS) {
    const key = tuningKey(data.tuning);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1]);

  // A filter selection from a previous visit might reference a tuning no songs currently use.
  if (activeTuningFilter && !counts.has(activeTuningFilter)) activeTuningFilter = null;

  const chips = [
    `<button class="tuning-chip${activeTuningFilter ? "" : " active"}" data-tuning="">All<span class="count">${SONGS.length}</span></button>`,
    ...groups.map(([key, count]) =>
      `<button class="tuning-chip${activeTuningFilter === key ? " active" : ""}" data-tuning="${key}">${key}<span class="count">${count}</span></button>`
    ),
  ];
  row.innerHTML = chips.join("");

  row.querySelectorAll(".tuning-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      activeTuningFilter = chip.dataset.tuning || null;
      if (activeTuningFilter) localStorage.setItem("sht_tuning_filter", activeTuningFilter);
      else localStorage.removeItem("sht_tuning_filter");
      renderSongList();
    });
  });
}

function renderSongList() {
  renderTuningFilters();
  const list = document.getElementById("song-list");
  const songs = activeTuningFilter
    ? SONGS.filter(({ data }) => tuningKey(data.tuning) === activeTuningFilter)
    : SONGS;
  list.innerHTML = songs.map(({ id, data }, i) => {
    const c1 = LANE_COLORS[(i % 6) + 1];
    const c2 = LANE_COLORS[((i + 3) % 6) + 1];
    const done = completions(id);
    return `
    <div class="song-card" data-song="${id}">
      <div class="song-cover" style="background: linear-gradient(135deg, ${c1}, ${c2})">
        ${COVER_EMOJI[i % COVER_EMOJI.length]}
        <div class="play-fab">▶</div>
      </div>
      <h3>${data.title}</h3>
      <p class="artist">${data.artist}</p>
      <div class="meta">
        <span class="pill-tag">${data.difficulty}</span>
        <span class="pill-tag">${data.notes.length} notes</span>
        ${done ? `<span class="pill-tag accent">Cleared ${done}×</span>` : ""}
      </div>
    </div>
  `;
  }).join("");

  list.querySelectorAll(".song-card").forEach((card) => {
    card.addEventListener("click", () => {
      const song = SONGS.find((s) => s.id === card.dataset.song);
      Screens.show("play");
      PlayMode.load(song.id, song.data);
    });
  });
}

/* ---------------------------------------------------------------------- *
 * PLAY MODE — one unified listen-and-advance practice mode
 * ---------------------------------------------------------------------- */

const PlayMode = {
  songId: null,
  song: null,
  notes: [],
  results: [], // null | 'correct' | 'wrong-first' (advanced after at least one miss)
  currentIndex: 0,
  wrongAttempts: 0,

  matchCount: 0,
  lastWrongNoteId: null,
  wrongCandidateCount: 0,
  cooldownUntil: 0,
  hadMissOnCurrent: false,
  listening: false,
  paused: false,

  // Repeated-note handling: when the current target is the same pitch as the note just
  // played, its own decaying ring would otherwise re-satisfy the match instantly. Require
  // either a silence gap or a fresh pick-attack (RMS spike over the recent ring) first.
  reattackNeeded: false,
  reattackSeen: false,
  rmsHistory: [],

  combo: 0,
  bestCombo: 0,

  load(songId, song) {
    Demo.stop();
    this.songId = songId;
    this.song = song;
    this.notes = song.notes;
    this.results = new Array(this.notes.length).fill(null);
    this.currentIndex = 0;
    this.wrongAttempts = 0;
    this.hadMissOnCurrent = false;
    this.matchCount = 0;
    this.lastWrongNoteId = null;
    this.wrongCandidateCount = 0;
    this.listening = false;
    this.paused = false;
    this.combo = 0;
    this.bestCombo = 0;
    this.updateCombo();
    this.rmsHistory = [];
    this.updateReattackState();

    document.getElementById("play-song-name").textContent = `${song.title} — ${song.artist}`;
    document.getElementById("play-results").classList.add("hidden");
    document.getElementById("mic-error").textContent = "";

    this.buildStringLabels();
    this.buildTrackStrip();
    this.updateProgress();
    this.setupMetronome(song.bpm);

    document.getElementById("calibration-panel").classList.add("hidden");

    if (PitchEngine.ctx) {
      // Mic already granted and running from a previous song/restart — reuse it, skip calibration.
      document.getElementById("mic-gate").classList.add("hidden");
      document.getElementById("listening-tools").classList.remove("hidden");
      document.getElementById("play-surface").classList.remove("hidden");
      PitchEngine.onFrame = (freq) => this.onPitchFrame(freq);
      this.listening = true;
      this.renderTarget();
      this.updateTrackTransform();
    } else {
      document.getElementById("mic-gate").classList.remove("hidden");
      document.getElementById("listening-tools").classList.add("hidden");
      document.getElementById("play-surface").classList.add("hidden");
      MicDevices.populate();
    }
  },

  async beginListening() {
    Demo.stop();
    const deviceId = MicDevices.selectedId();
    try {
      await PitchEngine.start(null, deviceId);
      MicDevices.remember(deviceId);
      MicDevices.populate(); // labels are only readable once permission is granted
      document.getElementById("mic-gate").classList.add("hidden");
      document.getElementById("listening-tools").classList.remove("hidden");
      document.getElementById("calibration-panel").classList.remove("hidden");
      PitchEngine.onFrame = (freq) => Calibration.onFrame(freq);
    } catch (err) {
      document.getElementById("mic-error").textContent =
        "Couldn't access that microphone. Check browser permissions, that a mic is connected, and try a different input device above.";
    }
  },

  beginPracticing() {
    document.getElementById("calibration-panel").classList.add("hidden");
    document.getElementById("play-surface").classList.remove("hidden");
    PitchEngine.onFrame = (freq) => this.onPitchFrame(freq);
    this.listening = true;
    this.paused = false;
    this.renderTarget();
    this.updateTrackTransform();
    Transport.syncSlider();
    Transport.updateToggleLabel();
  },

  stop() {
    // Pause only — leave the mic stream/AudioContext running so switching songs
    // (menu -> another song) doesn't re-trigger the mic-permission gate or
    // calibration screen. PitchEngine keeps its rAF loop going harmlessly idle.
    this.listening = false;
    PitchEngine.onFrame = null;
    Metronome.stop();
    const btn = document.getElementById("metronome-toggle");
    btn.textContent = "🥁 Metronome: Off";
    btn.classList.remove("active");
  },

  setupMetronome(songBpm) {
    Metronome.stop();
    const select = document.getElementById("metronome-bpm");
    const options = METRONOME_BPM_PRESETS.includes(songBpm)
      ? METRONOME_BPM_PRESETS
      : [...METRONOME_BPM_PRESETS, songBpm].sort((a, b) => a - b);
    select.innerHTML = options.map((bpm) =>
      `<option value="${bpm}"${bpm === songBpm ? " selected" : ""}>${bpm} BPM</option>`).join("");
    const btn = document.getElementById("metronome-toggle");
    btn.textContent = "🥁 Metronome: Off";
    btn.classList.remove("active");
  },

  buildStringLabels() {
    const el = document.getElementById("string-labels");
    el.innerHTML = STRING_ORDER.map((s) => `<div class="string-label">${stringLabel(this.song, s)}</div>`).join("");
  },

  // One x-position per note, driven by its real `time` field (seconds) rather than a flat
  // per-index spacing, so the horizontal gap between chips reflects the song's actual
  // rhythm. `MIN_NOTE_GAP` keeps fast/simultaneous notes from visually overlapping.
  computeNotePositions() {
    let prevX = -Infinity;
    return this.notes.map((note) => {
      let x = PLAYHEAD_X + (note.time || 0) * PIXELS_PER_SECOND;
      if (x < prevX + MIN_NOTE_GAP) x = prevX + MIN_NOTE_GAP;
      prevX = x;
      const tailWidth = Math.max(MIN_TAIL_WIDTH, Math.min((note.duration || 0) * PIXELS_PER_SECOND, MAX_TAIL_WIDTH));
      return { x, tailWidth };
    });
  },

  buildTrackStrip() {
    const strip = document.getElementById("track-strip");
    this.notePositions = this.computeNotePositions();
    const lastX = this.notePositions.length ? this.notePositions[this.notePositions.length - 1].x : 0;
    const width = lastX + 400;
    strip.style.width = `${width}px`;

    const lines = STRING_ORDER.map(
      (s) => `<div class="staff-line" style="top:${this.rowY(s)}px; width:${width}px;"></div>`
    ).join("");

    const tails = this.notes
      .map((note, i) => {
        const { x, tailWidth } = this.notePositions[i];
        const y = this.rowY(note.string);
        return `<div class="note-tail upcoming" data-index="${i}"
          style="left:${x}px; top:${y}px; width:${tailWidth}px; background:${LANE_COLORS[note.string]};"></div>`;
      })
      .join("");

    const chips = this.notes
      .map((note, i) => {
        const { x } = this.notePositions[i];
        const y = this.rowY(note.string);
        return `<div class="note-chip upcoming" data-index="${i}"
          style="left:${x}px; top:${y}px; background:${LANE_COLORS[note.string]};"><span>${note.fret}</span></div>`;
      })
      .join("");

    strip.innerHTML = lines + tails + chips;
    this.chipEls = Array.from(strip.querySelectorAll(".note-chip"));
    this.tailEls = Array.from(strip.querySelectorAll(".note-tail"));
  },

  rowY(stringNum) {
    return (STRING_ORDER.indexOf(stringNum) + 0.5) * ROW_HEIGHT;
  },

  updateTrackTransform() {
    const strip = document.getElementById("track-strip");
    const positions = this.notePositions;
    const targetX = positions[this.currentIndex]
      ? positions[this.currentIndex].x
      : positions[positions.length - 1].x;
    strip.style.transform = `translateX(${PLAYHEAD_X - targetX}px)`;

    const setState = (el, i) => {
      el.classList.remove("played-correct", "played-wrong", "current", "upcoming", "match-flash");
      if (i < this.currentIndex) {
        const r = this.results[i];
        // null = skipped past via the seek slider — show it neutral, not as a miss.
        el.classList.add(r === "correct" ? "played-correct" : r ? "played-wrong" : "upcoming");
      } else if (i === this.currentIndex) {
        el.classList.add("current");
      } else {
        el.classList.add("upcoming");
      }
    };

    this.tailEls.forEach(setState);
    this.chipEls.forEach(setState);
  },

  renderTarget() {
    const note = this.notes[this.currentIndex];
    if (!note) return;
    const freq = noteFrequency(note.string, note.fret, this.song.tuningOffsets);
    document.getElementById("target-note").textContent =
      `${stringLabel(this.song, note.string).toUpperCase()} string — fret ${note.fret}`;
    document.getElementById("target-hint").textContent =
      `≈ ${freqToNoteName(freq)} · ${freq.toFixed(1)} Hz`;
  },

  updateProgress() {
    document.getElementById("play-song-progress").textContent =
      `${this.currentIndex} / ${this.notes.length} notes`;
    Transport.syncSlider();
  },

  togglePause() {
    if (this.paused) {
      this.paused = false;
      this.listening = true;
      this.renderTarget();
    } else {
      this.paused = true;
      this.listening = false;
      this.matchCount = 0;
      this.wrongCandidateCount = 0;
      this.setTuner(null, null);
    }
    Transport.updateToggleLabel();
  },

  // Jump practice position to note `i` (from the seek slider).
  seekToIndex(i) {
    i = Math.max(0, Math.min(this.notes.length - 1, i | 0));
    this.currentIndex = i;
    this.hadMissOnCurrent = false;
    this.matchCount = 0;
    this.wrongCandidateCount = 0;
    this.lastWrongNoteId = null;
    this.cooldownUntil = 0;
    this.rmsHistory = [];
    this.combo = 0;
    this.updateCombo();
    this.updateReattackState();
    this.renderTarget();
    this.updateTrackTransform();
    this.updateProgress();
  },

  onPitchFrame(freq) {
    if (!this.listening || this.paused || this.currentIndex >= this.notes.length) return;

    this.trackReattack(freq, lastPitchDebug.rms);

    const note = this.notes[this.currentIndex];
    const targetFreq = noteFrequency(note.string, note.fret, this.song.tuningOffsets);

    if (freq) this.setTuner(freq, centsBetween(freq, targetFreq));
    else this.setTuner(null, null);

    const now = performance.now();
    if (now < this.cooldownUntil) return;

    const blindMatch = !!freq && Math.abs(centsBetween(freq, targetFreq)) <= MATCH_CENTS_TOLERANCE;
    // If blind pitch detection didn't land on the target — often because the still-ringing
    // previous note is blended into the same analysis window and dragged the global estimate
    // off both notes — also ask directly whether the buffer shows strong evidence of the
    // target's own frequency specifically. See targetedMatch / correlationAtFreq.
    const matched = blindMatch || (!blindMatch && this.targetedMatch(targetFreq));

    if (matched) {
      if (this.reattackNeeded && !this.reattackSeen) {
        // Right pitch, but so far it's indistinguishable from the previous identical
        // note still ringing — wait for a silence gap or a fresh pick-attack spike.
        return;
      }
      this.wrongCandidateCount = 0;
      this.matchCount++;
      if (this.matchCount >= CONFIRM_FRAMES) {
        this.matchCount = 0;
        this.cooldownUntil = now + CORRECT_COOLDOWN_MS;
        this.correctHit();
      }
      return;
    }

    if (!freq) {
      this.matchCount = 0;
      this.wrongCandidateCount = 0;
      this.lastWrongNoteId = null;
      return;
    }

    if (this.isRecentBleed(freq)) {
      // Likely the previous note (or the one before it) still ringing/decaying, not a
      // wrong pick — ignore it: don't reset progress toward the current note, don't
      // count it as a wrong attempt either.
      return;
    }

    this.matchCount = 0;
    const noteId = Math.round(69 + 12 * Math.log2(freq / 440));
    if (noteId === this.lastWrongNoteId) {
      this.wrongCandidateCount++;
    } else {
      this.lastWrongNoteId = noteId;
      this.wrongCandidateCount = 1;
    }
    if (this.wrongCandidateCount >= WRONG_CONFIRM_FRAMES) {
      this.wrongCandidateCount = 0;
      this.cooldownUntil = now + WRONG_COOLDOWN_MS;
      this.wrongAttempt();
    }
  },

  // Directly tests "how strongly does the buffer repeat at the target's own frequency" rather
  // than relying on blind autoCorrelate to pick it as the single global winner — see
  // TARGET_CORR_CONFIDENCE and correlationAtFreq for why. Guards against accepting mere
  // leftover ring from a recently-played note by requiring the target to clearly out-correlate
  // any of the last couple of notes at their own frequencies (skipping ones that are the same
  // pitch as the target, which reattack logic already handles separately).
  targetedMatch(targetFreq) {
    if (lastPitchDebug.rms < MIN_RMS) return false;
    if (!PitchEngine.buffer || !PitchEngine.ctx) return false;
    const sampleRate = PitchEngine.ctx.sampleRate;
    const targetCorr = correlationAtFreq(PitchEngine.buffer, sampleRate, targetFreq);
    if (targetCorr < TARGET_CORR_CONFIDENCE) return false;
    for (const idx of [this.currentIndex - 1, this.currentIndex - 2]) {
      if (idx < 0) continue;
      const prev = this.notes[idx];
      const prevFreq = noteFrequency(prev.string, prev.fret, this.song.tuningOffsets);
      if (Math.abs(centsBetween(prevFreq, targetFreq)) <= MATCH_CENTS_TOLERANCE) continue;
      const prevCorr = correlationAtFreq(PitchEngine.buffer, sampleRate, prevFreq);
      if (prevCorr >= targetCorr) return false; // ambiguous — could just be the old note's tail
    }
    return true;
  },

  // True if `freq` matches one of the last couple of already-played notes rather than
  // the current target — i.e. probably string ringing/decay bleeding into this frame.
  isRecentBleed(freq) {
    for (const idx of [this.currentIndex - 1, this.currentIndex - 2]) {
      if (idx < 0) continue;
      const prev = this.notes[idx];
      const prevFreq = noteFrequency(prev.string, prev.fret, this.song.tuningOffsets);
      if (Math.abs(centsBetween(freq, prevFreq)) <= MATCH_CENTS_TOLERANCE) return true;
    }
    return false;
  },

  // Feeds the rolling RMS window used to detect a fresh pick-attack, and flags
  // reattackSeen the moment one shows up (a silence gap, or a level spike over the
  // recently-decaying ring) — only matters while reattackNeeded is still unsatisfied.
  trackReattack(freq, rms) {
    if (this.reattackNeeded && !this.reattackSeen) {
      if (!freq) {
        this.reattackSeen = true; // a genuine gap between the two same-pitch notes
        this.rmsHistory = [];
        return;
      }
      if (this.rmsHistory.length >= REATTACK_HISTORY_LEN) {
        const recentMin = Math.min(...this.rmsHistory);
        if (rms > recentMin * ONSET_RATIO && rms > MIN_RMS * ONSET_ABS_MULT) {
          this.reattackSeen = true;
        }
      }
    }
    this.rmsHistory.push(rms);
    if (this.rmsHistory.length > REATTACK_HISTORY_LEN) this.rmsHistory.shift();
  },

  setTuner(freq, cents) {
    const needle = document.getElementById("tuner-needle");
    const readout = document.getElementById("tuner-readout");
    if (!freq) {
      needle.style.left = "50%";
      needle.style.background = "#fff";
      readout.textContent = `Listening… (level ${lastPitchDebug.rms.toFixed(3)}, clarity ${lastPitchDebug.confidence.toFixed(2)})`;
      return;
    }
    const clamped = Math.max(-50, Math.min(50, cents));
    needle.style.left = `${50 + clamped}%`;
    const inTune = Math.abs(cents) <= MATCH_CENTS_TOLERANCE;
    needle.style.background = inTune ? "var(--green-bright)" : "#fff";
    readout.textContent = `${freqToNoteName(freq)} · ${freq.toFixed(1)} Hz · ${cents > 0 ? "+" : ""}${cents.toFixed(0)}¢`;
  },

  correctHit() {
    const chip = this.chipEls[this.currentIndex];
    chip.classList.add("match-flash");
    const justPlayed = this.notes[this.currentIndex];
    SFX.pluck(noteFrequency(justPlayed.string, justPlayed.fret, this.song.tuningOffsets));
    this.results[this.currentIndex] = this.hadMissOnCurrent ? "wrong-first" : "correct";
    if (!this.hadMissOnCurrent) {
      this.combo++;
      this.bestCombo = Math.max(this.bestCombo, this.combo);
    } else {
      this.combo = 0;
    }
    this.updateCombo();
    this.hadMissOnCurrent = false;
    this.currentIndex++;
    this.updateProgress();
    this.updateTrackTransform();
    this.rmsHistory = [];
    this.updateReattackState();

    if (this.currentIndex >= this.notes.length) {
      this.finish();
    } else {
      this.renderTarget();
    }
  },

  updateCombo() {
    const badge = document.getElementById("combo-badge");
    if (this.combo >= 2) {
      document.getElementById("combo-count").textContent = this.combo;
      badge.classList.remove("hidden", "combo-pulse");
      void badge.offsetWidth; // restart the pulse animation
      badge.classList.add("combo-pulse");
    } else {
      badge.classList.add("hidden");
    }
  },

  // Call whenever currentIndex changes: decides whether the new target note needs a
  // fresh pick-attack (it's the same pitch as the note that was just played).
  updateReattackState() {
    const prev = this.notes[this.currentIndex - 1];
    const note = this.notes[this.currentIndex];
    this.reattackNeeded =
      !!prev && !!note &&
      Math.abs(centsBetween(
        noteFrequency(note.string, note.fret, this.song.tuningOffsets),
        noteFrequency(prev.string, prev.fret, this.song.tuningOffsets)
      )) <= MATCH_CENTS_TOLERANCE;
    this.reattackSeen = !this.reattackNeeded;
  },

  wrongAttempt() {
    this.wrongAttempts++;
    this.hadMissOnCurrent = true;
    this.combo = 0;
    this.updateCombo();
    SFX.miss();
    const chip = this.chipEls[this.currentIndex];
    chip.style.boxShadow = "0 0 0 4px rgba(241, 94, 108, 0.7)";
    setTimeout(() => { chip.style.boxShadow = ""; }, 220);
    const track = document.getElementById("track-container");
    track.classList.remove("shake");
    void track.offsetWidth;
    track.classList.add("shake");
  },

  finish() {
    this.listening = false;
    PitchEngine.onFrame = null;
    document.getElementById("target-note").textContent = "🎉 All done!";
    document.getElementById("target-hint").textContent = "";
    document.getElementById("combo-badge").classList.add("hidden");
    bumpCompletions(this.songId);
    SFX.clear();
    const clean = this.wrongAttempts === 0;
    const comboNote = this.bestCombo >= this.notes.length ? " Full combo!" : ` Best streak: ${this.bestCombo}.`;
    document.getElementById("play-results-body").textContent = (clean
      ? "Clean run — every note on the first try."
      : `Cleared with ${this.wrongAttempts} missed attempt${this.wrongAttempts === 1 ? "" : "s"} along the way.`) + comboNote;
    document.getElementById("play-results").classList.remove("hidden");
  },
};

/* ---------------------------------------------------------------------- *
 * Wiring
 * ---------------------------------------------------------------------- */

document.getElementById("mic-start-btn").addEventListener("click", () => PlayMode.beginListening());
document.getElementById("calib-done-btn").addEventListener("click", () => PlayMode.beginPracticing());
document.getElementById("gain-slider").addEventListener("input", (e) => {
  const value = Number(e.target.value);
  PitchEngine.setGain(value);
  document.getElementById("gain-value").textContent = `${value}×`;
});

const METRONOME_BPM_PRESETS = [60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200];

document.getElementById("metronome-toggle").addEventListener("click", () => {
  const btn = document.getElementById("metronome-toggle");
  if (Metronome.running) {
    Metronome.stop();
    btn.textContent = "🥁 Metronome: Off";
    btn.classList.remove("active");
  } else {
    const bpm = Number(document.getElementById("metronome-bpm").value);
    Metronome.start(bpm);
    btn.textContent = "🥁 Metronome: On";
    btn.classList.add("active");
  }
});
document.getElementById("metronome-bpm").addEventListener("change", (e) => {
  Metronome.setBpm(Number(e.target.value));
  if (Demo.running) Demo.start(); // re-run the example at the newly chosen tempo
});
document.getElementById("play-back-btn").addEventListener("click", () => { Screens.show("menu"); renderSongList(); });
document.getElementById("play-menu-btn").addEventListener("click", () => { Screens.show("menu"); renderSongList(); });
document.getElementById("play-restart-btn").addEventListener("click", () => PlayMode.load(PlayMode.songId, PlayMode.song));
document.getElementById("play-replay-btn").addEventListener("click", () => PlayMode.load(PlayMode.songId, PlayMode.song));

document.getElementById("demo-btn").addEventListener("click", () => Demo.toggle());
document.getElementById("demo-btn-gate").addEventListener("click", () => Demo.toggle());

document.getElementById("transport-toggle").addEventListener("click", () => {
  if (Transport.inDemo) Demo.togglePause();
  else PlayMode.togglePause();
});

// Minimap seek: click or drag anywhere on the overview to jump there.
const minimap = document.getElementById("minimap");
let mmDragging = false;
const mmSeekTo = (clientX) => {
  const i = Transport.mm.idxAt(clientX);
  if (Transport.inDemo) Demo.scrub(i);
  else PlayMode.seekToIndex(i);
};
minimap.addEventListener("pointerdown", (e) => {
  if (!Transport._notes()) return;
  mmDragging = true;
  try { minimap.setPointerCapture(e.pointerId); } catch (_) { /* keeps drag alive outside the element */ }
  mmSeekTo(e.clientX);
});
minimap.addEventListener("pointermove", (e) => { if (mmDragging) mmSeekTo(e.clientX); });
minimap.addEventListener("pointerup", (e) => {
  if (!mmDragging) return;
  mmDragging = false;
  try { minimap.releasePointerCapture(e.pointerId); } catch (_) {}
  if (Transport.inDemo) Demo.commitScrub(Transport.mm.idxAt(e.clientX));
});
minimap.addEventListener("keydown", (e) => {
  const notes = Transport._notes();
  if (!notes) return;
  let i = Transport._index();
  if (e.key === "ArrowRight") i += 1;
  else if (e.key === "ArrowLeft") i -= 1;
  else if (e.key === "PageUp") i += 10;
  else if (e.key === "PageDown") i -= 10;
  else if (e.key === "Home") i = 0;
  else if (e.key === "End") i = notes.length - 1;
  else return;
  e.preventDefault();
  i = Math.max(0, Math.min(notes.length - 1, i));
  if (Transport.inDemo) { Demo.scrub(i); Demo.commitScrub(i); }
  else PlayMode.seekToIndex(i);
});
window.addEventListener("resize", () => { Transport.mm.measureViewport(); Transport.mm.updateHead(); });

document.getElementById("nav-tuner-btn").addEventListener("click", () => Screens.show("tuner"));
document.getElementById("tuner-back-btn").addEventListener("click", () => Screens.show("menu"));
document.getElementById("tuner-mic-start-btn").addEventListener("click", () => Tuner.beginListening());
document.getElementById("tuner-tuning-select").addEventListener("change", (e) => Tuner.setTuning(e.target.value));

boot();
