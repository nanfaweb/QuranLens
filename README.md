# QuranLens 🔍

**Detect Quran recitations on YouTube, identify the exact Surah and Ayah, and open the verse on Quran.com.**

QuranLens is a Chrome extension (Manifest V3) that analyzes YouTube videos for Quran recitation. It extracts Arabic captions, matches them against a pre-built corpus of all 6,236 Quran verses using fuzzy text matching, and links you directly to the correct verse on quran.com.

---

## ✨ Features

- **Automatic Recitation Detection** — Analyzes YouTube captions for Arabic Quran text
- **Fuzzy Verse Matching** — Sliding-window Levenshtein algorithm identifies verses even with transcription imperfections
- **Audio Fallback** — Optional Whisper API integration for videos without captions
- **Beautiful UI** — Dark emerald popup with Arabic typography (Amiri font)
- **One-Click Navigation** — Open the matched verse on Quran.com instantly
- **Confidence Scoring** — Shows match confidence with visual indicators
- **Offline Corpus** — All 6,236 verses bundled locally, no runtime fetching

---

## 🚀 Installation

### Load Unpacked in Chrome

1. Clone or download this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable **Developer mode** (toggle in the top-right corner)
4. Click **"Load unpacked"**
5. Select the `QuranLens/` directory
6. The QuranLens icon (ق) will appear in your extensions toolbar

### Pin the Extension

Click the puzzle piece icon in Chrome's toolbar and pin QuranLens for easy access.

---

## 🎯 How to Use

1. Navigate to a YouTube video with Quran recitation
2. Click the QuranLens icon (ق) in the toolbar
3. Click **"Analyze Recitation"**
4. Wait for the analysis to complete
5. View the matched Surah and Ayah with confidence score
6. Click **"Open in Quran.com"** to read the verse

---

## 🔑 Optional: Gemini Setup

For videos **without Arabic captions**, QuranLens can use Google's Gemini 3.5 Flash API to transcribe the audio:

1. Get a free API key from [Google AI Studio](https://aistudio.google.com/)
2. Click the gear icon (⚙) in the QuranLens popup
3. Paste your API key and click **Save**

The API key is stored securely in `chrome.storage.sync` and is never sent anywhere except the Gemini API.

> **Note:** Without an API key, QuranLens only works with videos that have Arabic captions (either manual or auto-generated).

---

## 🔧 Rebuilding the Quran Corpus

The pre-built corpus (`data/quran_normalized.json`) is included in the repository. To rebuild it:

```bash
# Requires Node.js 18+ (uses built-in fetch)
node data/build_quran_data.js
```

This fetches all 6,236 verses from the [Quran.com API](https://api.quran.com/), normalizes the Arabic text (strips diacritics, normalizes letter forms), and saves the result.

---

## 🖼️ Generating PNG Icons

SVG icons are included and work natively. To generate PNG versions:

```bash
# Install canvas package (one-time)
npm install canvas

# Generate PNGs
node icons/generate_icons.js
```

The script includes a zero-dependency fallback that generates valid PNGs without the canvas package.

---

## 📁 Project Structure

```
QuranLens/
├── manifest.json              # Extension manifest (Manifest V3)
├── background.js              # Service worker — message routing & API calls
├── content.js                 # Content script — YouTube page integration
├── popup/
│   ├── popup.html             # Popup UI — dark emerald design
│   └── popup.js               # Popup state machine
├── data/
│   ├── build_quran_data.js    # Node.js corpus builder
│   └── quran_normalized.json  # Pre-built corpus (6,236 verses)
├── utils/
│   ├── arabic.js              # Arabic text normalization
│   ├── matcher.js             # Fuzzy verse matching engine
│   └── youtube.js             # Caption & metadata extraction
├── icons/
│   ├── icon-{16,32,48,128}.svg  # SVG icons
│   ├── icon-{16,32,48,128}.png  # PNG icons (generated)
│   └── generate_icons.js       # PNG generation script
└── README.md
```

---

## ⚙️ How It Works

1. **Caption Extraction** — When you click "Analyze", QuranLens reads the YouTube video's Arabic caption track
2. **Arabic Normalization** — Strips diacritics (tashkeel), normalizes letter forms (alef variants, teh marbuta)
3. **Sliding Window Match** — Compares the normalized text against all 6,236 verses using overlapping text windows
4. **Levenshtein Distance** — Wagner-Fischer algorithm computes edit distance between transcript windows and corpus verses
5. **Confidence Scoring** — `1 - (distance / max_length)` gives a 0–1 confidence score; matches below 0.60 are discarded

---

## ⚠️ Known Limitations

- **Caption Dependency** — Best results require Arabic captions (manual or auto-generated) on the YouTube video
- **captureStream()** — Audio fallback via `captureStream()` may not work on all browsers or with DRM-protected content
- **Partial Verse Matching** — Very short recitations (< 10 characters) may not match reliably
- **Multiple Verses** — Currently identifies the single best-matching verse; continuous recitation spanning multiple verses may show only the strongest match
- **Auto-generated Captions** — YouTube's auto-generated Arabic captions can be inaccurate, reducing match quality
- **Service Worker Lifecycle** — Chrome may suspend the service worker after inactivity; the extension handles this gracefully

---

## 📋 Permissions Explained

| Permission | Purpose |
|---|---|
| `activeTab` | Access the current YouTube tab for analysis |
| `scripting` | Inject content script on YouTube pages |
| `storage` | Save API key and analysis results |
| `youtube.com` | Read video captions and metadata |
| `api.quran.com` | Fetch verse text for display |
| `generativelanguage.googleapis.com` | Google Gemini audio transcription API |

---

## 📄 License

MIT License — Feel free to use, modify, and share.

---

<p align="center">
  <strong>بِسْمِ ٱللَّهِ ٱلرَّحْمَـٰنِ ٱلرَّحِيمِ</strong>
</p>
