/**
 * QuranLens — Verse-lag simulation test (Node.js)
 *
 * Simulates a recitation timeline from the real corpus, generates JSON3
 * caption events, runs the parser window + matcher at many playhead
 * positions, and measures how far the returned ayah lags the ayah
 * actually playing.
 *
 * Run: node tests/lag_test.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// ─── Polyfill chrome + fetch for loadCorpus() ────────────────────────────────
global.chrome = { runtime: { getURL: (p) => p } };
global.fetch = async (p) => ({
  ok: true,
  json: async () => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'))
});

global.normalizeArabic = require(path.join(ROOT, 'utils', 'arabic.js'));
const { findVerse } = require(path.join(ROOT, 'utils', 'matcher.js'));
const { parseJson3CaptionData } = require(path.join(ROOT, 'utils', 'captions.js'));

const SECONDS_PER_WORD = 0.75; // typical recitation pace
const CHUNK_SECONDS = 3;       // ASR caption chunk size

/**
 * Build a JSON3-style event timeline for a range of verses.
 * Each verse's words are split into ~3s caption chunks, mimicking ASR.
 * Returns { events, verseSpans } where verseSpans[ayah] = { startMs, endMs }.
 */
function buildTimeline(corpus, surah, fromAyah, toAyah) {
  const verses = corpus.filter(v => v.surah === surah && v.ayah >= fromAyah && v.ayah <= toAyah);
  verses.sort((a, b) => a.ayah - b.ayah);

  const events = [];
  const verseSpans = {};
  let cursorMs = 0;

  for (const verse of verses) {
    const words = (verse.normalized || '').split(/\s+/).filter(Boolean);
    const verseStartMs = cursorMs;
    const wordsPerChunk = Math.max(1, Math.round(CHUNK_SECONDS / SECONDS_PER_WORD));

    for (let i = 0; i < words.length; i += wordsPerChunk) {
      const chunkWords = words.slice(i, i + wordsPerChunk);
      const durMs = Math.round(chunkWords.length * SECONDS_PER_WORD * 1000);
      events.push({
        tStartMs: cursorMs,
        dDurationMs: durMs,
        segs: [{ utf8: chunkWords.join(' ') }]
      });
      cursorMs += durMs;
    }
    verseSpans[verse.ayah] = { startMs: verseStartMs, endMs: cursorMs };
  }

  return { events, verseSpans };
}

/** Extract the effective ayah from a findVerse result (any state). */
function resultAyah(result) {
  if (!result) return null;
  if (result.state === 'pending') return result.topCandidate?.ayah ?? null;
  return result.ayah ?? null;
}

async function simulateSurah(corpus, surah, fromAyah, toAyah, useChainedLastMatch) {
  const { events, verseSpans } = buildTimeline(corpus, surah, fromAyah, toAyah);
  const data = { events };

  const lags = [];
  let lastMatch = null;

  // Playhead at the midpoint of each verse (skip first 2: need lookback context)
  for (let ayah = fromAyah + 2; ayah <= toAyah; ayah++) {
    const span = verseSpans[ayah];
    if (!span) continue;
    const playheadMs = Math.round((span.startMs + span.endMs) / 2);

    const transcript = parseJson3CaptionData(data, playheadMs);
    if (!transcript) {
      lags.push({ ayah, matched: null, lag: null, note: 'no transcript' });
      continue;
    }

    const result = await findVerse(transcript, useChainedLastMatch ? lastMatch : null);
    const matched = resultAyah(result);
    const lag = matched != null ? ayah - matched : null;
    lags.push({ ayah, matched, lag, state: result?.state ?? 'null' });

    if (useChainedLastMatch && matched != null && result?.state === 'match') {
      lastMatch = { surah, ayah: matched };
    }
  }

  return lags;
}

function report(label, lags) {
  const valid = lags.filter(l => l.lag != null);
  const histogram = {};
  for (const l of valid) {
    histogram[l.lag] = (histogram[l.lag] || 0) + 1;
  }
  const avg = valid.length
    ? (valid.reduce((s, l) => s + l.lag, 0) / valid.length).toFixed(2)
    : 'n/a';
  const exact = valid.filter(l => l.lag === 0).length;
  const behind = valid.filter(l => l.lag > 0).length;
  const ahead = valid.filter(l => l.lag < 0).length;

  console.log(`\n=== ${label} ===`);
  console.log(`positions tested: ${lags.length}, with result: ${valid.length}`);
  console.log(`avg lag (verses behind): ${avg}`);
  console.log(`exact: ${exact}  behind: ${behind}  ahead: ${ahead}`);
  console.log('lag histogram (lag: count):', JSON.stringify(histogram));
  const misses = lags.filter(l => l.lag == null);
  if (misses.length) console.log(`no-result positions: ${misses.map(m => m.ayah).join(', ')}`);
}

// ─── Pure window-math check ──────────────────────────────────────────────────
function windowMathCheck() {
  console.log('=== Window math check (parseJson3CaptionData) ===');
  // Events at 0-5s, 5-10s, ..., one word each, playhead at 20s
  const events = [];
  for (let i = 0; i < 10; i++) {
    events.push({ tStartMs: i * 5000, dDurationMs: 5000, segs: [{ utf8: `w${i}` }] });
  }
  const playheadMs = 20000;
  const transcript = parseJson3CaptionData({ events }, playheadMs);
  console.log(`playhead 20s → included events: ${transcript}`);
  const included = transcript.split(' ');
  const firstIdx = parseInt(included[0].slice(1), 10);
  const lastIdx = parseInt(included[included.length - 1].slice(1), 10);
  const lookbackSec = (playheadMs - firstIdx * 5000) / 1000;
  const lookaheadSec = ((lastIdx + 1) * 5000 - playheadMs) / 1000;
  console.log(`effective reach: ${lookbackSec}s back, ${lookaheadSec}s ahead of playhead`);
}

async function main() {
  windowMathCheck();

  const corpus = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'data', 'quran_normalized.json'), 'utf8')
  );

  // Al-Mulk (67): medium-length verses, distinct text
  const lags67 = await simulateSurah(corpus, 67, 1, 20, false);
  report('Surah 67 Al-Mulk, independent analyses (no lastMatch)', lags67);

  const lags67chained = await simulateSurah(corpus, 67, 1, 20, true);
  report('Surah 67 Al-Mulk, chained lastMatch (real usage)', lags67chained);

  // Ya-Sin (36): shorter verses — more verses inside the window, worst case
  const lags36 = await simulateSurah(corpus, 36, 1, 25, false);
  report('Surah 36 Ya-Sin, independent analyses (no lastMatch)', lags36);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
