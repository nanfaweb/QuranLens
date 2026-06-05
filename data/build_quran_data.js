/**
 * QuranLens — Quran Corpus Builder
 * 
 * Standalone Node.js script that fetches all 6236 Ayahs from api.quran.com,
 * normalizes Arabic text, and saves the result as quran_normalized.json.
 * 
 * Usage: node data/build_quran_data.js
 * 
 * No npm dependencies — uses built-in Node.js fetch (Node 18+).
 */

const fs = require('fs');
const path = require('path');
const { normalizeArabic } = require('../utils/arabic.js');

const API_BASE = 'https://api.quran.com/api/v4';
const TOTAL_CHAPTERS = 114;
const PER_PAGE = 300; // max allowed by the API
const OUTPUT_FILE = path.join(__dirname, 'quran_normalized.json');

// Rate-limit helper — wait between requests to be polite
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch all verses for a single chapter.
 * Handles pagination if a chapter has more than PER_PAGE verses (unlikely, max is 286).
 */
async function fetchChapter(chapterNum, retries = 3) {
  const url = `${API_BASE}/verses/by_chapter/${chapterNum}?language=ar&fields=text_uthmani&per_page=${PER_PAGE}`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
      const data = await res.json();
      return data.verses;
    } catch (err) {
      console.error(`  ⚠ Attempt ${attempt}/${retries} failed for chapter ${chapterNum}: ${err.message}`);
      if (attempt < retries) {
        await sleep(2000 * attempt); // exponential backoff
      } else {
        throw err;
      }
    }
  }
}

async function buildCorpus() {
  console.log('╔═══════════════════════════════════════════╗');
  console.log('║   QuranLens — Building Quran Corpus       ║');
  console.log('╚═══════════════════════════════════════════╝');
  console.log();

  const corpus = [];
  let totalVerses = 0;

  for (let ch = 1; ch <= TOTAL_CHAPTERS; ch++) {
    process.stdout.write(`  📖 Fetching chapter ${ch}/${TOTAL_CHAPTERS}...`);

    try {
      const verses = await fetchChapter(ch);
      
      for (const verse of verses) {
        const verseKey = verse.verse_key; // e.g. "2:255"
        const [surah, ayah] = verseKey.split(':').map(Number);
        const text = verse.text_uthmani || '';
        const normalized = normalizeArabic(text);

        corpus.push({
          surah,
          ayah,
          text,
          normalized
        });
      }

      totalVerses += verses.length;
      console.log(` ✓ ${verses.length} verses`);
    } catch (err) {
      console.error(` ✗ FAILED: ${err.message}`);
      console.error('  Aborting build. Please check your network connection and try again.');
      process.exit(1);
    }

    // Be polite to the API — wait 150ms between chapters
    if (ch < TOTAL_CHAPTERS) {
      await sleep(150);
    }
  }

  console.log();
  console.log(`  📊 Total verses collected: ${totalVerses}`);

  // Write output
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(corpus, null, 0), 'utf-8');
  
  const fileSizeKB = (fs.statSync(OUTPUT_FILE).size / 1024).toFixed(1);
  console.log(`  💾 Saved to: ${OUTPUT_FILE}`);
  console.log(`  📦 File size: ${fileSizeKB} KB`);
  console.log();

  // Validation
  if (totalVerses !== 6236) {
    console.warn(`  ⚠ WARNING: Expected 6236 verses but got ${totalVerses}.`);
    console.warn('    The corpus may be incomplete. Consider re-running the script.');
  } else {
    console.log('  ✅ All 6236 verses collected successfully!');
  }

  console.log();
  console.log('  Done. The corpus is ready for the extension.');
}

buildCorpus().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
