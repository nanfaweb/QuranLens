/**
 * QuranLens — Fast Ayah Matching Engine
 * 
 * Core intelligence module. Matches transcribed Arabic text against
 * the pre-built Quran corpus using a two-stage approach:
 *   Stage 1: N-gram inverted index for fast candidate selection (~50 verses)
 *   Stage 2: Levenshtein distance (with early termination) on candidates only
 * 
 * All 114 Surah names are hardcoded — no runtime API calls needed.
 */

// Import/require normalizeArabic if in Node environment and not already defined globally
if (typeof normalizeArabic === 'undefined' && typeof require !== 'undefined') {
  globalThis.normalizeArabic = require('./arabic.js');
}

// ─── Surah Information (1–114) ──────────────────────────────────────────────

const SURAH_INFO = {
  1:   { arabic: 'الفاتحة',      english: 'Al-Fatiha',       ayahCount: 7   },
  2:   { arabic: 'البقرة',        english: 'Al-Baqarah',      ayahCount: 286 },
  3:   { arabic: 'آل عمران',      english: 'Ali Imran',       ayahCount: 200 },
  4:   { arabic: 'النساء',        english: 'An-Nisa',         ayahCount: 176 },
  5:   { arabic: 'المائدة',       english: 'Al-Ma\'idah',     ayahCount: 120 },
  6:   { arabic: 'الأنعام',       english: 'Al-An\'am',       ayahCount: 165 },
  7:   { arabic: 'الأعراف',       english: 'Al-A\'raf',       ayahCount: 206 },
  8:   { arabic: 'الأنفال',       english: 'Al-Anfal',        ayahCount: 75  },
  9:   { arabic: 'التوبة',        english: 'At-Tawbah',       ayahCount: 129 },
  10:  { arabic: 'يونس',          english: 'Yunus',           ayahCount: 109 },
  11:  { arabic: 'هود',            english: 'Hud',             ayahCount: 123 },
  12:  { arabic: 'يوسف',          english: 'Yusuf',           ayahCount: 111 },
  13:  { arabic: 'الرعد',         english: 'Ar-Ra\'d',        ayahCount: 43  },
  14:  { arabic: 'إبراهيم',       english: 'Ibrahim',         ayahCount: 52  },
  15:  { arabic: 'الحجر',         english: 'Al-Hijr',         ayahCount: 99  },
  16:  { arabic: 'النحل',         english: 'An-Nahl',         ayahCount: 128 },
  17:  { arabic: 'الإسراء',       english: 'Al-Isra',         ayahCount: 111 },
  18:  { arabic: 'الكهف',         english: 'Al-Kahf',         ayahCount: 110 },
  19:  { arabic: 'مريم',          english: 'Maryam',          ayahCount: 98  },
  20:  { arabic: 'طه',            english: 'Ta-Ha',           ayahCount: 135 },
  21:  { arabic: 'الأنبياء',      english: 'Al-Anbiya',       ayahCount: 112 },
  22:  { arabic: 'الحج',          english: 'Al-Hajj',         ayahCount: 78  },
  23:  { arabic: 'المؤمنون',      english: 'Al-Mu\'minun',    ayahCount: 118 },
  24:  { arabic: 'النور',         english: 'An-Nur',          ayahCount: 64  },
  25:  { arabic: 'الفرقان',       english: 'Al-Furqan',       ayahCount: 77  },
  26:  { arabic: 'الشعراء',       english: 'Ash-Shu\'ara',    ayahCount: 227 },
  27:  { arabic: 'النمل',         english: 'An-Naml',         ayahCount: 93  },
  28:  { arabic: 'القصص',         english: 'Al-Qasas',        ayahCount: 88  },
  29:  { arabic: 'العنكبوت',      english: 'Al-Ankabut',      ayahCount: 69  },
  30:  { arabic: 'الروم',         english: 'Ar-Rum',          ayahCount: 60  },
  31:  { arabic: 'لقمان',         english: 'Luqman',          ayahCount: 34  },
  32:  { arabic: 'السجدة',        english: 'As-Sajdah',       ayahCount: 30  },
  33:  { arabic: 'الأحزاب',       english: 'Al-Ahzab',        ayahCount: 73  },
  34:  { arabic: 'سبأ',           english: 'Saba',            ayahCount: 54  },
  35:  { arabic: 'فاطر',          english: 'Fatir',           ayahCount: 45  },
  36:  { arabic: 'يس',            english: 'Ya-Sin',          ayahCount: 83  },
  37:  { arabic: 'الصافات',       english: 'As-Saffat',       ayahCount: 182 },
  38:  { arabic: 'ص',             english: 'Sad',             ayahCount: 88  },
  39:  { arabic: 'الزمر',         english: 'Az-Zumar',        ayahCount: 75  },
  40:  { arabic: 'غافر',          english: 'Ghafir',          ayahCount: 85  },
  41:  { arabic: 'فصلت',          english: 'Fussilat',        ayahCount: 54  },
  42:  { arabic: 'الشورى',        english: 'Ash-Shura',       ayahCount: 53  },
  43:  { arabic: 'الزخرف',        english: 'Az-Zukhruf',      ayahCount: 89  },
  44:  { arabic: 'الدخان',        english: 'Ad-Dukhan',       ayahCount: 59  },
  45:  { arabic: 'الجاثية',       english: 'Al-Jathiyah',     ayahCount: 37  },
  46:  { arabic: 'الأحقاف',       english: 'Al-Ahqaf',        ayahCount: 35  },
  47:  { arabic: 'محمد',          english: 'Muhammad',        ayahCount: 38  },
  48:  { arabic: 'الفتح',         english: 'Al-Fath',         ayahCount: 29  },
  49:  { arabic: 'الحجرات',       english: 'Al-Hujurat',      ayahCount: 18  },
  50:  { arabic: 'ق',             english: 'Qaf',             ayahCount: 45  },
  51:  { arabic: 'الذاريات',      english: 'Adh-Dhariyat',    ayahCount: 60  },
  52:  { arabic: 'الطور',         english: 'At-Tur',          ayahCount: 49  },
  53:  { arabic: 'النجم',         english: 'An-Najm',         ayahCount: 62  },
  54:  { arabic: 'القمر',         english: 'Al-Qamar',        ayahCount: 55  },
  55:  { arabic: 'الرحمن',        english: 'Ar-Rahman',       ayahCount: 78  },
  56:  { arabic: 'الواقعة',       english: 'Al-Waqi\'ah',     ayahCount: 96  },
  57:  { arabic: 'الحديد',        english: 'Al-Hadid',        ayahCount: 29  },
  58:  { arabic: 'المجادلة',      english: 'Al-Mujadilah',    ayahCount: 22  },
  59:  { arabic: 'الحشر',         english: 'Al-Hashr',        ayahCount: 24  },
  60:  { arabic: 'الممتحنة',      english: 'Al-Mumtahanah',   ayahCount: 13  },
  61:  { arabic: 'الصف',          english: 'As-Saff',         ayahCount: 14  },
  62:  { arabic: 'الجمعة',        english: 'Al-Jumu\'ah',     ayahCount: 11  },
  63:  { arabic: 'المنافقون',     english: 'Al-Munafiqun',    ayahCount: 11  },
  64:  { arabic: 'التغابن',       english: 'At-Taghabun',     ayahCount: 18  },
  65:  { arabic: 'الطلاق',        english: 'At-Talaq',        ayahCount: 12  },
  66:  { arabic: 'التحريم',       english: 'At-Tahrim',       ayahCount: 12  },
  67:  { arabic: 'الملك',         english: 'Al-Mulk',         ayahCount: 30  },
  68:  { arabic: 'القلم',         english: 'Al-Qalam',        ayahCount: 52  },
  69:  { arabic: 'الحاقة',        english: 'Al-Haqqah',       ayahCount: 52  },
  70:  { arabic: 'المعارج',       english: 'Al-Ma\'arij',     ayahCount: 44  },
  71:  { arabic: 'نوح',           english: 'Nuh',             ayahCount: 28  },
  72:  { arabic: 'الجن',          english: 'Al-Jinn',         ayahCount: 28  },
  73:  { arabic: 'المزمل',        english: 'Al-Muzzammil',    ayahCount: 20  },
  74:  { arabic: 'المدثر',        english: 'Al-Muddaththir',  ayahCount: 56  },
  75:  { arabic: 'القيامة',       english: 'Al-Qiyamah',      ayahCount: 40  },
  76:  { arabic: 'الإنسان',       english: 'Al-Insan',        ayahCount: 31  },
  77:  { arabic: 'المرسلات',      english: 'Al-Mursalat',     ayahCount: 50  },
  78:  { arabic: 'النبأ',         english: 'An-Naba',         ayahCount: 40  },
  79:  { arabic: 'النازعات',      english: 'An-Nazi\'at',     ayahCount: 46  },
  80:  { arabic: 'عبس',           english: 'Abasa',           ayahCount: 42  },
  81:  { arabic: 'التكوير',       english: 'At-Takwir',       ayahCount: 29  },
  82:  { arabic: 'الانفطار',      english: 'Al-Infitar',      ayahCount: 19  },
  83:  { arabic: 'المطففين',      english: 'Al-Mutaffifin',   ayahCount: 36  },
  84:  { arabic: 'الانشقاق',      english: 'Al-Inshiqaq',     ayahCount: 25  },
  85:  { arabic: 'البروج',        english: 'Al-Buruj',        ayahCount: 22  },
  86:  { arabic: 'الطارق',        english: 'At-Tariq',        ayahCount: 17  },
  87:  { arabic: 'الأعلى',        english: 'Al-A\'la',        ayahCount: 19  },
  88:  { arabic: 'الغاشية',       english: 'Al-Ghashiyah',    ayahCount: 26  },
  89:  { arabic: 'الفجر',         english: 'Al-Fajr',         ayahCount: 30  },
  90:  { arabic: 'البلد',         english: 'Al-Balad',        ayahCount: 20  },
  91:  { arabic: 'الشمس',         english: 'Ash-Shams',       ayahCount: 15  },
  92:  { arabic: 'الليل',         english: 'Al-Layl',         ayahCount: 21  },
  93:  { arabic: 'الضحى',         english: 'Ad-Duha',         ayahCount: 11  },
  94:  { arabic: 'الشرح',         english: 'Ash-Sharh',       ayahCount: 8   },
  95:  { arabic: 'التين',         english: 'At-Tin',          ayahCount: 8   },
  96:  { arabic: 'العلق',         english: 'Al-Alaq',         ayahCount: 19  },
  97:  { arabic: 'القدر',         english: 'Al-Qadr',         ayahCount: 5   },
  98:  { arabic: 'البينة',        english: 'Al-Bayyinah',     ayahCount: 8   },
  99:  { arabic: 'الزلزلة',       english: 'Az-Zalzalah',     ayahCount: 8   },
  100: { arabic: 'العاديات',      english: 'Al-Adiyat',       ayahCount: 11  },
  101: { arabic: 'القارعة',       english: 'Al-Qari\'ah',     ayahCount: 11  },
  102: { arabic: 'التكاثر',       english: 'At-Takathur',     ayahCount: 8   },
  103: { arabic: 'العصر',         english: 'Al-Asr',          ayahCount: 3   },
  104: { arabic: 'الهمزة',        english: 'Al-Humazah',      ayahCount: 9   },
  105: { arabic: 'الفيل',         english: 'Al-Fil',          ayahCount: 5   },
  106: { arabic: 'قريش',          english: 'Quraysh',         ayahCount: 4   },
  107: { arabic: 'الماعون',       english: 'Al-Ma\'un',       ayahCount: 7   },
  108: { arabic: 'الكوثر',        english: 'Al-Kawthar',      ayahCount: 3   },
  109: { arabic: 'الكافرون',      english: 'Al-Kafirun',      ayahCount: 6   },
  110: { arabic: 'النصر',         english: 'An-Nasr',         ayahCount: 3   },
  111: { arabic: 'المسد',         english: 'Al-Masad',        ayahCount: 5   },
  112: { arabic: 'الإخلاص',       english: 'Al-Ikhlas',       ayahCount: 4   },
  113: { arabic: 'الفلق',         english: 'Al-Falaq',        ayahCount: 5   },
  114: { arabic: 'الناس',         english: 'An-Nas',          ayahCount: 6   }
};

// ─── Prefix Levenshtein Distance (with early termination) ───────────────────

/**
 * Compute prefix Levenshtein edit distance between windowText (a) and ayahText (b).
 * Matches the entire ayahText against the best prefix of windowText.
 * Uses single-row DP with optional early termination.
 * 
 * @param {string} windowText 
 * @param {string} ayahText 
 * @param {number} [maxDist=Infinity] — abort if distance exceeds this
 * @returns {number} edit distance (or maxDist+1 if exceeded)
 */
function prefixLevenshtein(windowText, ayahText, maxDist) {
  const m = windowText.length; // rows
  const n = ayahText.length;   // columns

  if (n === 0) return 0;
  if (m === 0) return n;

  let prev = new Array(n + 1);
  const isWindowShorter = m < n;
  for (let j = 0; j <= n; j++) {
    prev[j] = isWindowShorter ? 0 : j;
  }

  let minDistance = Math.max(m, n);

  for (let i = 1; i <= m; i++) {
    const curr = new Array(n + 1);
    curr[0] = isWindowShorter ? i : 0;

    let rowMin = curr[0];

    for (let j = 1; j <= n; j++) {
      const cost = windowText[i - 1] === ayahText[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,       // deletion from windowText
        curr[j - 1] + 1,   // insertion into windowText
        prev[j - 1] + cost // substitution
      );
      if (curr[j] < rowMin) rowMin = curr[j];
    }

    if (!isWindowShorter) {
      if (curr[n] < minDistance) {
        minDistance = curr[n];
      }
    }

    if (i === m) {
      if (isWindowShorter) {
        for (let j = 0; j <= n; j++) {
          if (curr[j] < minDistance) {
            minDistance = curr[j];
          }
        }
      } else {
        if (curr[n] < minDistance) {
          minDistance = curr[n];
        }
      }
    }

    // Early termination: if the best possible score in this row (rowMin)
    // already exceeds maxDist, and since minDistance also exceeds maxDist,
    // no future row can improve the match.
    if (maxDist !== undefined && rowMin > maxDist && minDistance > maxDist) {
      return maxDist + 1;
    }

    prev = curr;
  }

  return minDistance;
}

// ─── N-gram Index ───────────────────────────────────────────────────────────

const NGRAM_SIZE = 3;

/**
 * Extract character n-grams from a string.
 * @param {string} text — normalized text
 * @returns {Set<string>}
 */
function extractNgrams(text) {
  const ngrams = new Set();
  const clean = text.replace(/\s/g, ''); // Remove spaces for contiguous n-grams
  for (let i = 0; i <= clean.length - NGRAM_SIZE; i++) {
    ngrams.add(clean.substring(i, i + NGRAM_SIZE));
  }
  return ngrams;
}

// ─── Corpus Cache & Index ───────────────────────────────────────────────────

let _corpus = null;
let _ngramIndex = null;   // Map<trigram, number[]> — verse indices
let _verseNgramCounts = null; // number[] — n-gram count per verse
let _trigramIdf = null; // Map<trigram, number> — IDF weight per trigram

/**
 * Load the pre-built Quran corpus and build the n-gram inverted index.
 * Caches in memory after first load.
 * @returns {Promise<Array>}
 */
async function loadCorpus() {
  if (_corpus) return _corpus;

  try {
    const url = chrome.runtime.getURL('data/quran_normalized.json');
    const res = await fetch(url);
    _corpus = await res.json();

    // Build the n-gram inverted index
    console.time('[QuranLens] Building n-gram index');
    _ngramIndex = new Map();
    _verseNgramCounts = new Array(_corpus.length);

    for (let idx = 0; idx < _corpus.length; idx++) {
      // Re-normalize at load time to apply any updated normalizeArabic rules
      const normalizedText = normalizeArabic(_corpus[idx].normalized || _corpus[idx].text || '');
      _corpus[idx].normalized = normalizedText;

      const ngrams = extractNgrams(normalizedText);
      _verseNgramCounts[idx] = ngrams.size;

      for (const ng of ngrams) {
        let list = _ngramIndex.get(ng);
        if (!list) {
          list = [];
          _ngramIndex.set(ng, list);
        }
        list.push(idx);
      }
    }

    // Compute IDF weight for each trigram
    const totalVerses = _corpus.length;
    _trigramIdf = new Map();
    for (const [ng, list] of _ngramIndex.entries()) {
      const versesContainingTrigram = list.length;
      const idf = Math.log(1 + totalVerses / versesContainingTrigram);
      _trigramIdf.set(ng, idf);
    }

    console.timeEnd('[QuranLens] Building n-gram index');
    console.log(`[QuranLens] Index: ${_ngramIndex.size} unique trigrams for ${_corpus.length} verses`);

    return _corpus;
  } catch (err) {
    console.error('[QuranLens] Failed to load corpus:', err);
    throw new Error('Could not load Quran corpus data');
  }
}

// ─── Candidate Selection ────────────────────────────────────────────────────

const MAX_CANDIDATES = 100;
const MIN_CANDIDATES = 200; // FIX 3: minimum candidate pool size

/**
 * Use the n-gram index to find the top candidate verses for a text window.
 * Returns verse indices sorted by TF-IDF cosine similarity (descending).
 * Enforces a minimum pool of MIN_CANDIDATES by padding with highest IDF-weighted
 * verses from the full corpus.
 * 
 * @param {string} windowText — normalized text window
 * @returns {number[]} — array of corpus indices
 */
function selectCandidates(windowText) {
  const queryNgrams = extractNgrams(windowText);
  if (queryNgrams.size === 0) return [];

  // Count TF-IDF score for each verse
  const weightedHits = new Map(); // verseIdx -> sum of IDF weights

  for (const ng of queryNgrams) {
    const postings = _ngramIndex.get(ng);
    if (!postings) continue;
    const idf = _trigramIdf.get(ng) || 0;

    for (const idx of postings) {
      weightedHits.set(idx, (weightedHits.get(idx) || 0) + idf);
    }
  }

  if (weightedHits.size === 0) return [];

  // Score by raw IDF-weighted intersection normalized by queryIdfTotal
  const scored = [];
  let queryIdfTotal = 0;
  for (const ng of queryNgrams) {
    queryIdfTotal += _trigramIdf.get(ng) || 0;
  }
  if (queryIdfTotal === 0) queryIdfTotal = 1;

  for (const [idx, sumOfMatchedIdf] of weightedHits) {
    const score = sumOfMatchedIdf / queryIdfTotal;
    // Quick filter: require at least some overlap
    if (score > 0.05) {
      scored.push({ idx, score });
    }
  }

  // Sort by score descending, take top candidates
  scored.sort((a, b) => b.score - a.score);
  let selected = scored.slice(0, MAX_CANDIDATES).map(s => s.idx);

  // FIX 3: Enforce minimum candidate pool of 200
  // If fewer than MIN_CANDIDATES were selected, pad with the highest
  // IDF-weighted verses from the full corpus not already in the list.
  if (selected.length < MIN_CANDIDATES && _corpus) {
    const selectedSet = new Set(selected);

    // Build IDF score for ALL verses that had any trigram hit (incl. those
    // below the 0.05 threshold) but are not already selected
    const padding = [];
    for (const [idx, sumOfIdf] of weightedHits) {
      if (!selectedSet.has(idx)) {
        padding.push({ idx, score: sumOfIdf });
      }
    }
    padding.sort((a, b) => b.score - a.score);

    for (const p of padding) {
      if (selected.length >= MIN_CANDIDATES) break;
      selected.push(p.idx);
    }
  }

  return selected;
}

/**
 * Find the best matching Quran verse for a given transcript text.
 * 
 * Algorithm:
 *  1. Normalize the transcript
 *  2. Create sliding windows over the transcript
 *  3. For each window, use n-gram index to select ~100 candidate verses
 *  4. Run prefix Levenshtein only against candidates (with early termination)
 *  5. Return top match if confidence > 0.60
 * 
 * @param {string} transcriptText — raw Arabic transcript
 * @param {Object|null} [lastMatch] — optional { surah, ayah } of previous match
 * @returns {Promise<Object|null>} — { surah, ayah, confidence, surahName, text } or null
 */
async function findVerse(transcriptText, lastMatch) {
  console.log('[QuranLens Matcher] findVerse called with transcript length:', transcriptText?.length, 'text:', transcriptText);
  if (!transcriptText || typeof transcriptText !== 'string') {
    console.log('[QuranLens Matcher] findVerse: Empty or invalid transcript.');
    return null;
  }

  const corpus = await loadCorpus();
  const normalizedTranscript = normalizeArabic(transcriptText, true);
  const transcriptWords = normalizedTranscript.split(/\s+/).filter(Boolean);
  console.log('[QuranLens Matcher] findVerse: Normalized transcript:', normalizedTranscript);

  // CHANGE 2.B: Minimum viable transcript gate
  if (normalizedTranscript.trim().split(/\s+/).length < 6) {
    console.log('[QuranLens Matcher] findVerse: Transcript has fewer than 6 words, returning null.');
    return null;
  }

  console.log('[QuranLens Matcher] findVerse: lastMatch =', lastMatch);

  // Generate overlapping subwindows of size 60, step 15
  const subwindows = [];
  const subwindowSize = 60;
  const subwindowStep = 15;
  for (let i = 0; i < normalizedTranscript.length; i += subwindowStep) {
    const end = Math.min(i + subwindowSize, normalizedTranscript.length);
    const sub = normalizedTranscript.substring(i, end);
    if (sub.length >= 10) {
      subwindows.push(sub);
    }
  }
  if (subwindows.length === 0) {
    subwindows.push(normalizedTranscript);
  }

  console.time('[QuranLens] Verse matching');

  let lastMatchIsStale = false;
  if (lastMatch) {
    let topRawScore = 0;
    let topRawSurah = null;

    for (const subwindow of subwindows) {
      const candidates = selectCandidates(subwindow);
      for (const idx of candidates) {
        const verse = corpus[idx];
        const ayahText = verse.normalized;
        const ayahLen = ayahText.length;
        if (ayahLen < 3) continue;

        const padding = Math.max(5, Math.floor(ayahLen * 0.15));
        const compareLen = Math.min(subwindow.length, ayahLen + padding);
        const compareText = subwindow.substring(0, compareLen);
        const shorterLen = Math.min(compareText.length, ayahLen);
        const maxDist = Math.floor(shorterLen * 0.40);

        const dist = prefixLevenshtein(compareText, ayahText, maxDist);
        if (dist > maxDist) continue;

        const rawConf = 1 - (dist / shorterLen);
        if (rawConf > topRawScore) {
          topRawScore = rawConf;
          topRawSurah = verse.surah;
        }
      }
    }

    if (topRawSurah !== null && topRawSurah !== lastMatch.surah && topRawScore > 0.70) {
      lastMatchIsStale = true;
      console.log('[QuranLens Matcher] lastMatch is stale — top raw candidate surah:', topRawSurah, 'score:', topRawScore, 'vs lastMatch surah:', lastMatch.surah);
    }
  }

  const subwindowResults = [];
  const subwindowCandidatesMap = new Map();

  for (let subIdx = 0; subIdx < subwindows.length; subIdx++) {
    const subwindow = subwindows[subIdx];
    let bestMatchForSub = null;
    let bestConfForSub = 0;
    const candidatesForThisSub = [];

    const candidates = selectCandidates(subwindow);
    for (const idx of candidates) {
      const verse = corpus[idx];
      const ayahText = verse.normalized;
      const ayahLen = ayahText.length;
      if (ayahLen < 3) continue;

      const padding = Math.max(5, Math.floor(ayahLen * 0.15));
      const compareLen = Math.min(subwindow.length, ayahLen + padding);
      const compareText = subwindow.substring(0, compareLen);
      const shorterLen = Math.min(compareText.length, ayahLen);
      const maxDist = Math.floor(shorterLen * 0.40);

      const dist = prefixLevenshtein(compareText, ayahText, maxDist);
      if (dist > maxDist) continue;

      let confidence = 1 - (dist / shorterLen);

      // Require higher confidence for short verses to prevent false prefix alignments
      let minConfidence = 0.60;
      if (ayahLen < 6) {
        minConfidence = 0.85;
      } else if (ayahLen < 12) {
        minConfidence = 0.70;
      }

      // Apply temporal continuity scoring multiplier
      if (lastMatch && !lastMatchIsStale) {
        if (verse.surah === lastMatch.surah) {
          if (verse.ayah === lastMatch.ayah + 1) {
            confidence *= 1.25;
          } else if (Math.abs(verse.ayah - (lastMatch.ayah + 1)) <= 2) {
            confidence *= 1.10;
          }
        } else {
          confidence *= 0.90;
        }
      }

      // CHANGE 2.C: Penalize suspiciously short match regions
      if (compareText.length < 0.25 * ayahLen) {
        confidence -= 0.10;
      }

      // Missing-word penalty:
      const candidateWords = ayahText.split(/\s+/).filter(Boolean);
      const candidateWordCount = candidateWords.length;
      if (candidateWordCount > 0) {
        let missingWordCount = 0;
        for (const word of candidateWords) {
          if (word.length > 3 && !transcriptWords.includes(word)) {
            missingWordCount++;
          }
        }
        const missedRatio = missingWordCount / candidateWordCount;
        if (missedRatio > 0.25) {
          const multiplier = Math.max(0.70, 1 - (missedRatio * 0.4));
          confidence *= multiplier;
        }
      }

      // Temporary debug log
      console.log("[QuranLens] top candidate:", verse.surah, verse.ayah, "score:", confidence, "threshold:", minConfidence);

      if (confidence > minConfidence) {
        candidatesForThisSub.push({
          surah: verse.surah,
          ayah: verse.ayah,
          confidence: Math.round(confidence * 100) / 100,
          text: verse.text || ''
        });
      }

      if (confidence > bestConfForSub && confidence > minConfidence) {
        bestConfForSub = confidence;
        const surahInfo = SURAH_INFO[verse.surah] || { arabic: '', english: '', ayahCount: 0 };
        bestMatchForSub = {
          surah: verse.surah,
          ayah: verse.ayah,
          confidence: Math.round(confidence * 100) / 100,
          surahName: surahInfo,
          text: verse.text || ''
        };
      }
    }

    if (bestMatchForSub) {
      subwindowResults.push({
        ...bestMatchForSub,
        subIdx: subIdx
      });
    }
    subwindowCandidatesMap.set(subIdx, candidatesForThisSub);
  }

  if (subwindowResults.length === 0) {
    console.timeEnd('[QuranLens] Verse matching');
    return null;
  }

  // Apply subwindow agreement boost to subwindowResults
  for (const res of subwindowResults) {
    const cKey = `${res.surah}:${res.ayah}`;
    let matchCount = 0;
    for (const other of subwindowResults) {
      if (`${other.surah}:${other.ayah}` === cKey) {
        matchCount++;
      }
    }
    if (matchCount >= 2) {
      res.confidence = Math.min(0.99, res.confidence + 0.04);
    }
    res.confidence = Math.round(res.confidence * 100) / 100;
  }

  // Sort subwindowResults by confidence descending
  subwindowResults.sort((a, b) => b.confidence - a.confidence);

  const topResult = subwindowResults[0];

  // Get candidates for the subwindow that produced topResult
  const candidatesForBestSub = subwindowCandidatesMap.get(topResult.subIdx) || [];

  // Boost confidence for all candidates in this subwindow for consistent comparison
  for (const c of candidatesForBestSub) {
    const cKey = `${c.surah}:${c.ayah}`;
    let matchCount = 0;
    for (const res of subwindowResults) {
      if (`${res.surah}:${res.ayah}` === cKey) {
        matchCount++;
      }
    }
    if (matchCount >= 2) {
      c.confidence = Math.min(0.99, c.confidence + 0.04);
    }
    c.confidence = Math.round(c.confidence * 100) / 100;
  }

  // Sort candidates descending
  candidatesForBestSub.sort((a, b) => b.confidence - a.confidence);

  if (candidatesForBestSub.length === 0) {
    console.timeEnd('[QuranLens] Verse matching');
    return null;
  }

  const highestScore = candidatesForBestSub[0].confidence;
  const ambiguousSet = candidatesForBestSub.filter(c => (highestScore - c.confidence) <= 0.08);

  let matchResult = null;
  if (ambiguousSet.length === 1) {
    const topCandidate = ambiguousSet[0];
    const surahInfo = SURAH_INFO[topCandidate.surah] || { arabic: '', english: '', ayahCount: 0 };
    matchResult = {
      state: "match",
      surah: topCandidate.surah,
      ayah: topCandidate.ayah,
      confidence: topCandidate.confidence,
      surahName: surahInfo,
      text: topCandidate.text
    };
  } else {
    const firstNormalizedText = normalizeArabic(ambiguousSet[0].text);
    const allEqual = ambiguousSet.every(c => normalizeArabic(c.text) === firstNormalizedText);

    if (allEqual) {
      const tiedCandidates = ambiguousSet.map(c => ({
        surah: c.surah,
        ayah: c.ayah,
        surahName: SURAH_INFO[c.surah] || { arabic: '', english: '', ayahCount: 0 }
      }));
      matchResult = {
        state: "tied",
        candidates: tiedCandidates,
        surah: ambiguousSet[0].surah,
        ayah: ambiguousSet[0].ayah,
        confidence: ambiguousSet[0].confidence,
        surahName: SURAH_INFO[ambiguousSet[0].surah] || { arabic: '', english: '', ayahCount: 0 },
        text: ambiguousSet[0].text
      };
    } else {
      matchResult = {
        state: "pending",
        topCandidate: {
          surah: candidatesForBestSub[0].surah,
          ayah: candidatesForBestSub[0].ayah,
          confidence: candidatesForBestSub[0].confidence,
          surahName: SURAH_INFO[candidatesForBestSub[0].surah] || { arabic: '', english: '', ayahCount: 0 },
          text: candidatesForBestSub[0].text
        }
      };
    }
  }

  console.log('[QuranLens] Match result:', matchResult);
  console.timeEnd('[QuranLens] Verse matching');
  return matchResult;
}

/**
 * Build the quran.com URL for a specific verse.
 * @param {number} surah 
 * @param {number} ayah 
 * @returns {string}
 */
function getQuranUrl(surah, ayah) {
  return `https://quran.com/${surah}/${ayah}`;
}

// Export for use in extension context (loaded via importScripts or <script>)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    findVerse,
    getQuranUrl,
    levenshtein: prefixLevenshtein,
    prefixLevenshtein,
    SURAH_INFO,
    loadCorpus
  };
}
