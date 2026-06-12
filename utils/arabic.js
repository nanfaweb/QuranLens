/**
 * QuranLens — Arabic Text Normalization
 *
 * Pure normalization function shared by the corpus builder (Node.js)
 * and the runtime matcher (browser extension context).
 *
 * All rules are applied in a fixed order so that both Uthmani corpus
 * text and YouTube ASR transcript input produce identical output.
 */

/**
 * Normalize Arabic text so that Uthmani corpus and ASR transcript
 * forms produce identical output.
 *
 * Pure function — same input always produces same output, no side effects.
 *
 * @param {string} text — raw Arabic text
 * @returns {string} — normalized text
 */
function normalizeArabic(text, isTranscript = false) {
  if (!text || typeof text !== 'string') return '';

  const normalized = text
    // STEP 1 — Remove all diacritics and Quranic annotation marks
    .replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E8\u06EA-\u06EF\u0640]/g, '')

    // STEP 2 — Normalize Alef variants → bare Alef \u0627
    .replace(/[\u0622\u0623\u0625\u0671]/g, '\u0627')

    // STEP 3 — Normalize Hamza-bearing letters
    .replace(/\u0624/g, '\u0648') // ؤ → و
    .replace(/\u0626/g, '\u064A') // ئ → ي

    // STEP 4 — Remove standalone Hamza
    .replace(/\u0621/g, '') // ء → empty

    // STEP 5 — Normalize Ya Maqsura → Ya
    .replace(/\u0649/g, '\u064A') // ى → ي

    // STEP 6 — Normalize Teh Marbuta → Ha
    .replace(/\u0629/g, '\u0647') // ة → ه

    // STEP 7 — Remove Arabic punctuation and Quranic marks
    .replace(/[\u060C\u061B\u061F\u06DD\u06DE\.,;:?!"'\(\)\[\]\-]/g, '')

    // STEP 8 — Post-normalization sequence cleanup
    .replace(/\u0627\u0627+/g, '\u0627') // اا → ا
    .replace(/\u0648\u0648+/g, '\u0648') // وو → و
    .replace(/\u064A\u064A+/g, '\u064A') // يي → ي

    // STEP 9 — Normalize whitespace
    .replace(/[\t\u00A0\u200B\u200C\u200D]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return isTranscript ? removeStutters(normalized) : normalized;
}

/**
 * Remove ASR stutters from normalized text.
 * @param {string} text
 * @returns {string}
 */
function removeStutters(text) {
  if (!text) return '';
  const tokens = text.split(' ');
  const result = [];
  for (let i = 0; i < tokens.length; i++) {
    if (i < tokens.length - 1) {
      const current = tokens[i];
      const next = tokens[i + 1];
      if (current === next || (next.startsWith(current) && current.length >= 3)) {
        continue;
      }
    }
    result.push(tokens[i]);
  }
  return result.join(' ');
}

// Export normalizeArabic as the sole export of arabic.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = normalizeArabic;
}
