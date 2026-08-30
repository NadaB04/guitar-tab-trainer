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
const SPACING = 80;
const PLAYHEAD_X = 90;

const MATCH_CENTS_TOLERANCE = 35;
const CONFIRM_FRAMES = 8;        // ~130ms of a stable correct pitch before it counts
const WRONG_CONFIRM_FRAMES = 18; // ~300ms of a stable wrong pitch — rides out pick-attack noise
const CORRECT_COOLDOWN_MS = 280;
const WRONG_COOLDOWN_MS = 350;
const MIN_CONFIDENCE = 0.45; // how "periodic" the signal must be — filters out noise/hum
const MIN_RMS = 0.005; // just above mic self-noise — the confidence check (below) does the real noise rejection,
                        // and it's scale-invariant, so this floor can stay low without letting noise back in

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

let SONGS = [];

/* ---------------------------------------------------------------------- *
 * Music helpers
 * ---------------------------------------------------------------------- */

function noteFrequency(string, fret) {
  return STRING_OPEN_FREQ[string] * Math.pow(2, fret / 12);
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
    this.analyser.fftSize = 2048;
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
  async populate() {
    const select = document.getElementById("mic-device-select");
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

  selectedId() {
    return document.getElementById("mic-device-select").value || null;
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
 * Screens
 * ---------------------------------------------------------------------- */

const Screens = {
  show(id) {
    document.querySelectorAll(".screen").forEach((el) => el.classList.remove("active"));
    document.getElementById(`screen-${id}`).classList.add("active");
    if (id !== "play") PlayMode.stop();
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

function renderSongList() {
  const list = document.getElementById("song-list");
  list.innerHTML = SONGS.map(({ id, data }, i) => {
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

  load(songId, song) {
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

    document.getElementById("play-song-name").textContent = `${song.title} — ${song.artist}`;
    document.getElementById("play-results").classList.add("hidden");
    document.getElementById("mic-error").textContent = "";

    this.buildStringLabels();
    this.buildTrackStrip();
    this.updateProgress();

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
    this.renderTarget();
    this.updateTrackTransform();
  },

  stop() {
    this.listening = false;
    PitchEngine.onFrame = null;
    PitchEngine.stop();
  },

  buildStringLabels() {
    const el = document.getElementById("string-labels");
    el.innerHTML = STRING_ORDER.map((s) => `<div class="string-label">${stringLabel(this.song, s)}</div>`).join("");
  },

  buildTrackStrip() {
    const strip = document.getElementById("track-strip");
    const width = this.notes.length * SPACING + 400;
    strip.style.width = `${width}px`;

    const lines = STRING_ORDER.map(
      (s) => `<div class="staff-line" style="top:${this.rowY(s)}px; width:${width}px;"></div>`
    ).join("");

    const chips = this.notes
      .map((note, i) => {
        const x = i * SPACING + SPACING / 2;
        const y = this.rowY(note.string);
        return `<div class="note-chip upcoming" data-index="${i}"
          style="left:${x}px; top:${y}px; background:${LANE_COLORS[note.string]};">${note.fret}</div>`;
      })
      .join("");

    strip.innerHTML = lines + chips;
    this.chipEls = Array.from(strip.querySelectorAll(".note-chip"));
  },

  rowY(stringNum) {
    return (STRING_ORDER.indexOf(stringNum) + 0.5) * ROW_HEIGHT;
  },

  updateTrackTransform() {
    const strip = document.getElementById("track-strip");
    const targetX = this.currentIndex * SPACING + SPACING / 2;
    strip.style.transform = `translateX(${PLAYHEAD_X - targetX}px)`;

    this.chipEls.forEach((el, i) => {
      el.classList.remove("played-correct", "played-wrong", "current", "upcoming", "match-flash");
      if (i < this.currentIndex) {
        el.classList.add(this.results[i] === "correct" ? "played-correct" : "played-wrong");
      } else if (i === this.currentIndex) {
        el.classList.add("current");
      } else {
        el.classList.add("upcoming");
      }
    });
  },

  renderTarget() {
    const note = this.notes[this.currentIndex];
    if (!note) return;
    const freq = noteFrequency(note.string, note.fret);
    document.getElementById("target-note").textContent =
      `${stringLabel(this.song, note.string).toUpperCase()} string — fret ${note.fret}`;
    document.getElementById("target-hint").textContent =
      `≈ ${freqToNoteName(freq)} · ${freq.toFixed(1)} Hz`;
  },

  updateProgress() {
    document.getElementById("play-song-progress").textContent =
      `${this.currentIndex} / ${this.notes.length} notes`;
  },

  onPitchFrame(freq) {
    if (!this.listening || this.currentIndex >= this.notes.length) return;

    if (!freq) {
      this.matchCount = 0;
      this.wrongCandidateCount = 0;
      this.lastWrongNoteId = null;
      this.setTuner(null, null);
      return;
    }

    const note = this.notes[this.currentIndex];
    const targetFreq = noteFrequency(note.string, note.fret);
    const cents = centsBetween(freq, targetFreq);
    this.setTuner(freq, cents);

    const now = performance.now();
    if (now < this.cooldownUntil) return;

    if (Math.abs(cents) <= MATCH_CENTS_TOLERANCE) {
      this.wrongCandidateCount = 0;
      this.matchCount++;
      if (this.matchCount >= CONFIRM_FRAMES) {
        this.matchCount = 0;
        this.cooldownUntil = now + CORRECT_COOLDOWN_MS;
        this.correctHit();
      }
    } else {
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
    }
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
    this.results[this.currentIndex] = this.hadMissOnCurrent ? "wrong-first" : "correct";
    this.hadMissOnCurrent = false;
    this.currentIndex++;
    this.updateProgress();
    this.updateTrackTransform();

    if (this.currentIndex >= this.notes.length) {
      this.finish();
    } else {
      this.renderTarget();
    }
  },

  wrongAttempt() {
    this.wrongAttempts++;
    this.hadMissOnCurrent = true;
    const chip = this.chipEls[this.currentIndex];
    chip.style.boxShadow = "0 0 0 4px rgba(241, 94, 108, 0.7)";
    setTimeout(() => { chip.style.boxShadow = ""; }, 220);
  },

  finish() {
    this.listening = false;
    PitchEngine.onFrame = null;
    document.getElementById("target-note").textContent = "🎉 All done!";
    document.getElementById("target-hint").textContent = "";
    bumpCompletions(this.songId);
    const clean = this.wrongAttempts === 0;
    document.getElementById("play-results-body").textContent = clean
      ? "Clean run — every note on the first try."
      : `Cleared with ${this.wrongAttempts} missed attempt${this.wrongAttempts === 1 ? "" : "s"} along the way.`;
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
document.getElementById("play-back-btn").addEventListener("click", () => { Screens.show("menu"); renderSongList(); });
document.getElementById("play-menu-btn").addEventListener("click", () => { Screens.show("menu"); renderSongList(); });
document.getElementById("play-restart-btn").addEventListener("click", () => PlayMode.load(PlayMode.songId, PlayMode.song));
document.getElementById("play-replay-btn").addEventListener("click", () => PlayMode.load(PlayMode.songId, PlayMode.song));

boot();
