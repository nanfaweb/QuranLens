/**
 * QuranLens — Offline Mutashabihat (similar verse) cluster discovery
 *
 * Reads data/quran_normalized.json and produces:
 *   - data/exact_duplicate_clusters.json   (Category A)
 *   - data/shared_prefix_clusters.json     (Category B)
 *
 * Usage: node data/discover_similar_verses.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

global.chrome = { runtime: { getURL: (p) => p } };
global.fetch = async (p) => ({
  ok: true,
  json: async () => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'))
});
global.normalizeArabic = require(path.join(ROOT, 'utils', 'arabic.js'));

const {
  loadCorpus,
  selectCandidates,
  prefixLevenshtein,
  SUBWINDOW_SIZE,
  SUBWINDOW_STEP
} = require(path.join(ROOT, 'utils', 'matcher.js'));

// 0.73 captures confirmed 5:20/14:6 (0.733) while sliding windows catch
// shared openings not at verse start (e.g. 7:11 vs 2:34 at 0.767).
const PREFIX_CONFIDENCE_THRESHOLD = 0.73;

const EXACT_OUT = path.join(__dirname, 'exact_duplicate_clusters.json');
const PREFIX_OUT = path.join(__dirname, 'shared_prefix_clusters.json');

function verseKey(surah, ayah) {
  return `${surah}:${ayah}`;
}

function longestCommonPrefix(strings) {
  if (!strings.length) return '';
  let prefix = strings[0];
  for (let i = 1; i < strings.length; i++) {
    const s = strings[i];
    let j = 0;
    while (j < prefix.length && j < s.length && prefix[j] === s[j]) j++;
    prefix = prefix.slice(0, j);
    if (!prefix) break;
  }
  return prefix;
}

function discoverExactDuplicates(corpus) {
  const byText = new Map();
  for (const v of corpus) {
    const text = v.normalized || '';
    if (!text) continue;
    if (!byText.has(text)) byText.set(text, []);
    byText.get(text).push({ surah: v.surah, ayah: v.ayah });
  }

  const clusters = [];
  for (const [normalizedText, verses] of byText.entries()) {
    if (verses.length < 2) continue;
    verses.sort((a, b) => a.surah - b.surah || a.ayah - b.ayah);
    const surahs = new Set(verses.map(v => v.surah));
    clusters.push({
      normalizedText,
      spansMultipleSurahs: surahs.size > 1,
      verses
    });
  }

  clusters.sort((a, b) => b.verses.length - a.verses.length);
  return clusters;
}

function buildExactPairSkipSet(exactClusters) {
  const skip = new Set();
  for (const cluster of exactClusters) {
    const members = cluster.verses;
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const a = members[i];
        const b = members[j];
        skip.add(`${verseKey(a.surah, a.ayah)}|${verseKey(b.surah, b.ayah)}`);
        skip.add(`${verseKey(b.surah, b.ayah)}|${verseKey(a.surah, a.ayah)}`);
      }
    }
  }
  return skip;
}

class UnionFind {
  constructor(n) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(x) {
    if (this.parent[x] !== x) this.parent[x] = this.find(this.parent[x]);
    return this.parent[x];
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
  }
}

function getPrefixWindows(normalizedText) {
  const windows = [];
  if (!normalizedText || normalizedText.length < 10) return windows;

  const opening = normalizedText.slice(0, SUBWINDOW_SIZE);
  if (opening.length >= 10) windows.push(opening);

  for (let i = SUBWINDOW_STEP; i < normalizedText.length; i += SUBWINDOW_STEP) {
    const w = normalizedText.slice(i, i + SUBWINDOW_SIZE);
    if (w.length >= 10) windows.push(w);
  }
  return windows;
}

function prefixConfidence(prefixA, prefixB) {
  const shorterLen = Math.min(prefixA.length, prefixB.length);
  if (shorterLen === 0) return 0;
  const dist = prefixLevenshtein(prefixA, prefixB);
  return 1 - dist / shorterLen;
}

function bestOpeningConfidenceWindows(windowsA, windowsB, threshold = 1) {
  let best = 0;
  for (const wa of windowsA) {
    for (const wb of windowsB) {
      best = Math.max(best, prefixConfidence(wa, wb));
      if (best >= threshold) return best;
    }
  }
  return best;
}

function bestOpeningConfidenceFromWindows(windowsA, windowsB, threshold) {
  if (!windowsA.length || !windowsB.length) return 0;
  const openingConf = prefixConfidence(windowsA[0], windowsB[0]);
  if (openingConf >= threshold) return openingConf;
  if (openingConf < 0.5) return openingConf;
  return Math.max(openingConf, bestOpeningConfidenceWindows(windowsA, windowsB, threshold));
}

function discoverSharedPrefixClusters(corpus, exactClusters) {
  const exactSkip = buildExactPairSkipSet(exactClusters);
  const n = corpus.length;
  const uf = new UnionFind(n);
  const openings = corpus.map(v => (v.normalized || '').slice(0, SUBWINDOW_SIZE));
  const windowsByIdx = corpus.map(v => getPrefixWindows(v.normalized || ''));

  let pairsCompared = 0;
  let pairsFlagged = 0;

  for (let i = 0; i < n; i++) {
    if (i > 0 && i % 500 === 0) {
      console.log(`  Category B progress: ${i}/${n} verses...`);
    }

    const prefixA = openings[i];
    if (prefixA.length < 10) continue;

    const candidateIndices = selectCandidates(prefixA);
    for (const j of candidateIndices) {
      if (j <= i) continue;
      const va = corpus[i];
      const vb = corpus[j];
      if (va.surah === vb.surah && va.ayah === vb.ayah) continue;

      const pairKey = `${verseKey(va.surah, va.ayah)}|${verseKey(vb.surah, vb.ayah)}`;
      if (exactSkip.has(pairKey)) continue;

      if (openings[j].length < 10) continue;

      pairsCompared++;
      const conf = bestOpeningConfidenceFromWindows(
        windowsByIdx[i],
        windowsByIdx[j],
        PREFIX_CONFIDENCE_THRESHOLD
      );
      if (conf >= PREFIX_CONFIDENCE_THRESHOLD) {
        pairsFlagged++;
        uf.union(i, j);
      }
    }
  }

  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const root = uf.find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  }

  const clusters = [];
  for (const indices of groups.values()) {
    if (indices.length < 2) continue;
    const verses = indices
      .map(idx => ({ surah: corpus[idx].surah, ayah: corpus[idx].ayah }))
      .sort((a, b) => a.surah - b.surah || a.ayah - b.ayah);
    const normalizedTexts = indices.map(idx => corpus[idx].normalized || '');
    clusters.push({
      sharedPrefix: longestCommonPrefix(normalizedTexts),
      verses
    });
  }

  clusters.sort((a, b) => b.verses.length - a.verses.length);
  return { clusters, pairsCompared, pairsFlagged };
}

function clusterContains(cluster, surah, ayah) {
  return cluster.verses.some(v => v.surah === surah && v.ayah === ayah);
}

function findClusterWithAll(clusters, refs) {
  return clusters.find(c => refs.every(r => clusterContains(c, r.surah, r.ayah)));
}

function printLargeClusters(label, clusters) {
  const large = clusters.filter(c => c.verses.length >= 3);
  console.log(`\n--- ${label}: clusters with 3+ verses (${large.length}) ---`);
  for (const c of large) {
    console.log(JSON.stringify(c, null, 2));
  }
}

async function main() {
  console.log('Loading corpus via loadCorpus() (same normalization as runtime)...');
  const corpus = await loadCorpus();
  console.log(`Corpus loaded: ${corpus.length} verses\n`);

  console.log('=== Category A: exact duplicate clusters ===');
  const exactClusters = discoverExactDuplicates(corpus);
  const crossSurahExact = exactClusters.filter(c => c.spansMultipleSurahs);
  const singleSurahExact = exactClusters.filter(c => !c.spansMultipleSurahs);

  console.log(`Total exact-duplicate clusters: ${exactClusters.length}`);
  console.log(`  Cross-surah (Category A priority): ${crossSurahExact.length}`);
  console.log(`  Single-surah only (e.g. Ar-Rahman refrain): ${singleSurahExact.length}`);

  printLargeClusters('Category A', exactClusters);

  console.log('\n=== Category B: shared-prefix clusters ===');
  const { clusters: prefixClusters, pairsCompared, pairsFlagged } =
    discoverSharedPrefixClusters(corpus, exactClusters);

  console.log(`Prefix pairs compared (trigram-narrowed): ${pairsCompared}`);
  console.log(`Prefix pairs flagged (>= ${PREFIX_CONFIDENCE_THRESHOLD}): ${pairsFlagged}`);
  console.log(`Total shared-prefix clusters: ${prefixClusters.length}`);

  printLargeClusters('Category B', prefixClusters);

  console.log('\n=== Sanity checks ===');
  const rahmanCluster = findClusterWithAll(exactClusters, [
    { surah: 55, ayah: 13 },
    { surah: 55, ayah: 16 }
  ]);
  console.log(`55:13 + 55:16 in same Category A cluster: ${rahmanCluster ? 'PASS' : 'FAIL'}`);
  if (rahmanCluster) {
    console.log(`  spansMultipleSurahs: ${rahmanCluster.spansMultipleSurahs} (expected false)`);
  }

  const sajdahCluster = findClusterWithAll(prefixClusters, [
    { surah: 2, ayah: 34 },
    { surah: 7, ayah: 11 },
    { surah: 17, ayah: 61 },
    { surah: 18, ayah: 50 },
    { surah: 20, ayah: 116 }
  ]);
  console.log(`2:34 + 7:11 + 17:61 + 18:50 + 20:116 in Category B cluster: ${sajdahCluster ? 'PASS' : 'FAIL'}`);

  const musaCluster = findClusterWithAll(prefixClusters, [
    { surah: 5, ayah: 20 },
    { surah: 14, ayah: 6 }
  ]);
  console.log(`5:20 + 14:6 in Category B cluster: ${musaCluster ? 'PASS' : 'FAIL'}`);

  fs.writeFileSync(EXACT_OUT, JSON.stringify(exactClusters, null, 2), 'utf8');
  fs.writeFileSync(PREFIX_OUT, JSON.stringify(prefixClusters, null, 2), 'utf8');
  console.log(`\nWrote ${EXACT_OUT}`);
  console.log(`Wrote ${PREFIX_OUT}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
