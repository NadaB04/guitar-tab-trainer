#!/usr/bin/env node
/*
 * songsterr-import.js — pull a song's sung melody from Songsterr's "Lead Vocals"
 * track and turn it into a ShredType song JSON. See CLAUDE.md ("Songsterr
 * vocal-track workflow") for the why; this is the how.
 *
 *   node tools/songsterr-import.js "linkin park numb"
 *       → find the song, fetch its vocal track, print a quality report +
 *         verse/chorus pitch contour. Writes nothing — eyeball it first.
 *
 *   node tools/songsterr-import.js "linkin park numb" --write numb "Numb" "Linkin Park" Beginner
 *       → also write songs/numb.json and register it in songs/manifest.json.
 *
 * The search pattern can be a Songsterr numeric songId instead.
 * Node 18+ (uses global fetch). No dependencies.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const SONGS_DIR = path.join(REPO, 'songs');
const HDRS = { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.songsterr.com/' };
const CDN = 'https://dqsljvtekg760.cloudfront.net';

const NN = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (m) => NN[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
const OPEN = { 1: 64, 2: 59, 3: 55, 4: 50, 5: 45, 6: 40 }; // standard-tuning open-string MIDI

async function getJSON(url) {
  const r = await fetch(url, { headers: HDRS });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${url}`);
  return r.json();
}

// --- locate the song + its vocal track ------------------------------------------------
async function resolveVocalTrack(query) {
  let songId, songMeta;
  if (/^\d+$/.test(query.trim())) {
    songId = Number(query.trim());
  } else {
    const hits = await getJSON(`https://www.songsterr.com/api/songs?pattern=${encodeURIComponent(query)}&size=4`);
    if (!hits.length) throw new Error(`no Songsterr match for "${query}"`);
    songId = hits[0].songId;
    console.log(`matched: ${hits[0].title} — ${hits[0].artist} (songId ${songId})`);
  }
  const meta = await getJSON(`https://www.songsterr.com/api/meta/${songId}`);
  const rev = meta.revisionId;
  const revData = await getJSON(`https://www.songsterr.com/api/revision/${rev}`);
  const image = revData.image; // data-version key, e.g. "v0-3-2-xxxxxxxx"

  const tracks = meta.tracks || [];
  let idx = tracks.findIndex((t) => t.isVocalTrack && !t.isEmpty && /lead/i.test(t.name || ''));
  if (idx < 0) idx = tracks.findIndex((t) => t.isVocalTrack && !t.isEmpty);
  if (idx < 0) idx = tracks.findIndex((t) => /lead vocal/i.test(t.name || ''));
  if (idx < 0) {
    console.log('tracks:', tracks.map((t, i) => `${i}:${t.name}`).join('  '));
    throw new Error('no vocal track on this revision — try the MIDI/tab fallback (see CLAUDE.md)');
  }
  // The CloudFront part index matches the track's position in meta.tracks[].
  const part = await getJSON(`${CDN}/${songId}/${rev}/${image}/${idx}.json`);
  return { part, songId, rev, image, idx, trackName: tracks[idx].name };
}

// --- flatten measures -> a monophonic note list --------------------------------------
// first voice only; lowest note per beat (a clean vocal track has no chords, so this is
// a no-op there; for a guitar-track pull it takes the riff root); tie:true merges into
// the previous same-pitch note; each measure's beat durations are scaled to fill its
// time signature (rides out stray grace notes).
function flatten(part) {
  const T = part.tuning;
  const flat = [];
  let beatBase = 0;
  for (const m of part.measures) {
    const sig = m.signature || [4, 4];
    const mLen = (4 * sig[0]) / sig[1];
    const beats = (m.voices[0] && m.voices[0].beats) || [];
    const rawLen = (b) => (4 * b.duration[0]) / b.duration[1] * (b.tuplet ? b.tuplet[1] / b.tuplet[0] : 1);
    const sum = beats.reduce((a, b) => a + rawLen(b), 0);
    const scale = sum > 0 && Math.abs(sum - mLen) > 0.02 ? mLen / sum : 1;
    let mb = 0;
    for (const b of beats) {
      const dur = rawLen(b) * scale;
      const real = (b.notes || []).filter((n) => !n.rest && n.fret != null);
      if (real.length) {
        const midi = Math.min(...real.map((n) => T[n.string] + n.fret));
        const prev = flat[flat.length - 1];
        if (real.some((n) => n.tie) && prev && prev.midi === midi) prev.dur += dur;
        else flat.push({ beat: beatBase + mb, midi, dur });
      }
      mb += dur;
    }
    beatBase += mLen;
  }
  return flat;
}

// --- quality gate -------------------------------------------------------------------
function analyze(part) {
  const flat = flatten(part);
  let chords = 0, badBeats = 0;
  for (const m of part.measures) {
    for (const v of m.voices) for (const b of v.beats || []) {
      const real = (b.notes || []).filter((n) => !n.rest && n.fret != null);
      if (real.length > 1) chords++;
    }
    const s = (m.voices[0].beats || []).reduce((a, b) => a + (4 * b.duration[0]) / b.duration[1], 0);
    const mLen = (4 * (m.signature ? m.signature[0] : 4)) / (m.signature ? m.signature[1] : 4);
    if (Math.abs(s - mLen) > 0.05) badBeats++;
  }
  const midis = flat.map((n) => n.midi);
  const lo = Math.min(...midis), hi = Math.max(...midis);
  const markers = part.measures.map((m) => (m.marker ? m.marker.text : null)).filter(Boolean);
  const verdict = chords === 0 && badBeats <= 2 && flat.length >= 150 && lo >= 40 /* E2 */
    && /chorus/i.test(markers.join(' '))
    ? 'GOOD' : 'SUSPECT';
  return { flat, chords, badBeats, notes: flat.length, measures: part.measures.length,
    lo, hi, range: `${noteName(lo)}-${noteName(hi)}`, markers, verdict,
    tempo: (part.automations && part.automations.tempo) || null };
}

// --- MIDI -> compact, stable standard-tuning fingering -------------------------------
function place(midi) {
  let best = null;
  for (let s = 1; s <= 6; s++) {
    const fret = midi - OPEN[s];
    if (fret < 0 || fret > 12) continue;
    const cost = Math.abs(fret - 5) + (s === 1 || s === 6 ? 1 : 0); // hug the middle of the neck
    if (!best || cost < best.cost) best = { string: s, fret };
  }
  if (!best) return place(midi < 40 ? midi + 12 : midi - 12); // fold out-of-range octave in
  return best;
}

// --- build the song JSON -----------------------------------------------------------
function build(part, { title, artist, difficulty }) {
  const flat = flatten(part);
  const tempo = (part.automations && part.automations.tempo) || [{ measure: 0, bpm: 120 }];
  tempo.sort((a, b) => a.measure - b.measure);
  const bpmAt = (beat) => {
    const mi = Math.floor(beat / 4); // assumes 4/4; fine for essentially all rock
    let bpm = tempo[0].bpm;
    for (const t of tempo) if (t.measure <= mi) bpm = t.bpm;
    return bpm;
  };
  const beat0 = flat[0].beat;
  const LEAD = 0.5;
  let prevBeat = beat0, tSec = LEAD;
  const notes = flat.map((n) => {
    for (let b = prevBeat; b < n.beat - 1e-9; ) {
      const step = Math.min(0.25, n.beat - b);
      tSec += step * (60 / bpmAt(b));
      b += step;
    }
    prevBeat = n.beat;
    const p = place(n.midi);
    return { time: +tSec.toFixed(3), string: p.string, fret: p.fret,
      duration: +Math.min(n.dur * (60 / bpmAt(n.beat)), 2.0).toFixed(3) };
  });
  return { title, artist, bpm: tempo[0].bpm, difficulty: difficulty || 'Intermediate',
    tuning: ['E', 'A', 'D', 'G', 'B', 'E'], notes };
}

function addToManifest(id, file) {
  const p = path.join(SONGS_DIR, 'manifest.json');
  const man = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (man.some((e) => e.id === id)) { console.log(`manifest already has "${id}"`); return; }
  man.push({ id, file });
  const body = man.map((e) => `  { "id": "${e.id}", "file": "${e.file}" }`).join(',\n');
  fs.writeFileSync(p, `[\n${body}\n]\n`);
  console.log(`manifest += ${id}`);
}

// --- CLI ---------------------------------------------------------------------------
(async () => {
  const [query, ...rest] = process.argv.slice(2);
  if (!query) {
    console.error('usage: node tools/songsterr-import.js "<artist title>|<songId>" [--write <id> "<Title>" "<Artist>" [Difficulty]]');
    process.exit(1);
  }
  const { part, trackName, songId, rev } = await resolveVocalTrack(query);
  const a = analyze(part);

  console.log(`\ntrack: ${trackName}  (songId ${songId}, rev ${rev})`);
  console.log(`${a.verdict}  —  ${a.notes} notes | ${a.measures} measures | chords ${a.chords} | badBeats ${a.badBeats} | range ${a.range}`);
  console.log(`tempo: ${JSON.stringify(a.tempo && a.tempo.map((t) => `m${t.measure}:${t.bpm}`))}`);
  console.log(`sections: ${a.markers.join(' / ')}`);
  for (const m of part.measures.map((mm, i) => (mm.marker ? [i, mm.marker.text] : null)).filter(Boolean)) {
    if (!/verse|chorus/i.test(m[1])) continue;
    const seg = a.flat.filter((n) => n.beat >= m[0] * 4).slice(0, 12).map((n) => noteName(n.midi));
    console.log(`   ${m[1]}: ${seg.join(' ')}`);
  }
  if (a.verdict !== 'GOOD') console.log('\n^ SUSPECT: check chords/badBeats/range/structure before trusting this. See CLAUDE.md.');

  const w = rest.indexOf('--write');
  if (w >= 0) {
    const [id, title, artist, difficulty] = rest.slice(w + 1);
    if (!id || !title || !artist) throw new Error('--write needs: <id> "<Title>" "<Artist>" [Difficulty]');
    const song = build(part, { title, artist, difficulty });
    fs.writeFileSync(path.join(SONGS_DIR, `${id}.json`), JSON.stringify(song, null, 2) + '\n');
    addToManifest(id, `${id}.json`);
    console.log(`\nwrote songs/${id}.json — ${song.notes.length} notes, ${song.bpm} bpm, ends ${song.notes.at(-1).time.toFixed(0)}s`);
    console.log('now: node server.js, load the song, run "Hear it", confirm the contour matches the record.');
  }
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
