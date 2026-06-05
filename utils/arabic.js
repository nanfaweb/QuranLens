/**
 * QuranLens — Arabic Text Normalization
 * 
 * Shared normalization function used by both the corpus builder (Node.js)
 * and the runtime matcher (browser extension context).
 * 
 * Normalization rules:
 *  1. Strip Tashkeel diacritics (U+0610–U+061A, U+064B–U+065F)
 *  2. Remove Tatweel / Kashida (U+0640)
 *  3. Normalize Alef variants (U+0622, U+0623, U+0625) → plain Alef (U+0627)
 *  4. Normalize Teh Marbuta (U+0629) → Heh (U+0647)
 *  5. Collapse multiple whitespace into single space and trim
 */

// Regex: all Arabic tashkeel / diacritical marks
const TASHKEEL_RE = /[\u0610-\u061A\u064B-\u065F\u0670]/g;

// Regex: Tatweel (elongation character)
const TATWEEL_RE = /\u0640/g;

// Regex: Alef variants — Alef Madda, Alef Hamza Above, Alef Hamza Below, Alef Wasla
const ALEF_VARIANTS_RE = /[\u0622\u0623\u0625\u0671]/g;

// Plain Alef
const ALEF = '\u0627';

// Teh Marbuta
const TEH_MARBUTA_RE = /\u0629/g;

// Heh
const HEH = '\u0647';

// Alef Maksura
const ALEF_MAKSURA_RE = /\u0649/g;

// Yeh
const YEH = '\u064a';

// Multiple whitespace
const MULTI_SPACE_RE = /\s+/g;

function normalizeArabic(text) {
  if (!text || typeof text !== 'string') return '';

  return text
    .replace(/\u0671/g, '\u0627')
    .replace(/[\u0622\u0623\u0625]/g, '\u0627')
    .replace(/\u0624/g, '\u0648')
    .replace(/\u0626/g, '\u064a')
    .replace(/\u0621/g, '')
    .replace(/\u0649/g, '\u064a')
    .replace(/[،؟؛.]/g, '')
    .replace(TASHKEEL_RE, '')
    .replace(TATWEEL_RE, '')
    .replace(ALEF_VARIANTS_RE, ALEF)
    .replace(TEH_MARBUTA_RE, HEH)
    .replace(ALEF_MAKSURA_RE, YEH)
    .replace(MULTI_SPACE_RE, ' ')
    .trim();
}

// Support both Node.js (CommonJS) and browser (ES module-like) environments
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { normalizeArabic };
}
