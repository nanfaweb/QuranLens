/**
 * QuranLens — Mutashabihat cluster regression tests
 *
 * Run: node tests/cluster_test.js
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

const { findVerse, loadCorpus } = require(path.join(ROOT, 'utils', 'matcher.js'));

function clusterContains(cluster, surah, ayah) {
  return cluster.verses.some(v => v.surah === surah && v.ayah === ayah);
}

function findClusterWithAll(clusters, refs) {
  return clusters.find(c => refs.every(r => clusterContains(c, r.surah, r.ayah)));
}

function assert(name, cond) {
  if (!cond) {
    console.error(`FAIL: ${name}`);
    process.exitCode = 1;
    return;
  }
  console.log(`PASS: ${name}`);
}

async function main() {
  const exactClusters = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'data', 'exact_duplicate_clusters.json'), 'utf8')
  );
  const prefixClusters = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'data', 'shared_prefix_clusters.json'), 'utf8')
  );

  assert('Category A file has clusters', exactClusters.length > 0);
  assert('Category B file has clusters', prefixClusters.length > 0);

  assert(
    'Ar-Rahman refrain cluster (55:13, 55:16)',
    !!findClusterWithAll(exactClusters, [
      { surah: 55, ayah: 13 },
      { surah: 55, ayah: 16 }
    ])
  );

  assert(
    'Sajdah shared-prefix cluster (2:34, 7:11, 17:61, 18:50, 20:116)',
    !!findClusterWithAll(prefixClusters, [
      { surah: 2, ayah: 34 },
      { surah: 7, ayah: 11 },
      { surah: 17, ayah: 61 },
      { surah: 18, ayah: 50 },
      { surah: 20, ayah: 116 }
    ])
  );

  assert(
    'Musa shared-prefix cluster (5:20, 14:6)',
    !!findClusterWithAll(prefixClusters, [
      { surah: 5, ayah: 20 },
      { surah: 14, ayah: 6 }
    ])
  );

  await loadCorpus();

  // Shared opening only — should not commit to a confident single match when
  // multiple cluster members score similarly (pending or tied, not plain match).
  const sajdahOpening =
    'وإذ قلنا للملائكة اسجدوا لآدم فسجدوا إلا إبليس';
  const sajdahResult = await findVerse(sajdahOpening, null);
  assert(
    'Sajdah opening-only transcript is pending or tied (not plain match)',
    sajdahResult && (sajdahResult.state === 'pending' || sajdahResult.state === 'tied')
  );

  // Divergent continuation should resolve toward a specific verse
  const sajdah234 =
    'وإذ قلنا للملائكة اسجدوا لآدم فسجدوا إلا إبليس أبى واستكبر وكان من الكافرين';
  const r234 = await findVerse(sajdah234, null);
  assert(
    'Sajdah 2:34 continuation identifies 2:34 (match or cautious pending)',
    r234 && (
      (r234.state === 'match' && r234.surah === 2 && r234.ayah === 34) ||
      (r234.state === 'pending' && r234.topCandidate?.surah === 2 && r234.topCandidate?.ayah === 34)
    )
  );

  const sajdah711 =
    'ولقد خلقناكم ثم صورناكم ثم قلنا للملائكة اسجدوا لآدم فسجدوا إلا إبليس لم يكن من الساجدين';
  const r711 = await findVerse(sajdah711, null);
  assert(
    'Sajdah 7:11 full verse identifies 7:11 (match or cautious pending)',
    r711 && (
      (r711.state === 'match' && r711.surah === 7 && r711.ayah === 11) ||
      (r711.state === 'pending' && r711.topCandidate?.surah === 7 && r711.topCandidate?.ayah === 11)
    )
  );

  console.log('\nCluster tests complete.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
