# QuranLens

**Detect Quran recitations on YouTube, identify the exact Surah and Ayah, and open the verse on Quran.com.**

QuranLens is a Chromium browser extension (Manifest V3) that analyzes YouTube videos for Quran recitation. It extracts Arabic captions, matches them against a pre-built corpus of all 6,236 Quran verses using fuzzy text matching, and links you directly to the correct verse on quran.com.

Supported browsers: **Chrome, Edge, Brave, Opera** on **Windows** and **macOS**.

---

## Features

- **Automatic Recitation Detection** — Analyzes YouTube captions for Arabic Quran text
- **Fuzzy Verse Matching** — N-gram accelerated search with prefix Levenshtein scoring
- **In-Page Overlay** — Floating panel on YouTube watch pages (no separate popup)
- **One-Click Navigation** — Open the matched verse on Quran.com instantly
- **Confidence Scoring** — Shows match confidence with visual indicators
- **Offline Corpus** — All 6,236 verses bundled locally, no runtime API calls for matching
- **Cross-Platform** — Same build works on Windows and macOS Chromium browsers

---

## Installation

### 1. Get the code

Clone or download this repository.

### 2. Load unpacked in your browser

Enable **Developer mode**, then click **Load unpacked** and select the `QuranLens/` folder.

| Browser | Extensions page (Windows & macOS) |
|---------|----------------------------------|
| Chrome  | `chrome://extensions`            |
| Edge    | `edge://extensions`            |
| Brave   | `brave://extensions`             |
| Opera   | `opera://extensions`             |

Steps (same for all browsers):

1. Open the extensions page from the table above
2. Turn on **Developer mode** (toggle in the toolbar)
3. Click **Load unpacked**
4. Select the `QuranLens/` directory
5. Pin QuranLens from the extensions menu for quick access

> **Note:** PNG icons are included in `icons/`. To regenerate from SVG sources, run `node icons/generate_icons.js`.

---

## How to Use

1. Navigate to a YouTube **watch** page with Quran recitation (`youtube.com/watch?v=...`)
2. Click the QuranLens icon in the toolbar to open the overlay
3. Click **Analyze Recitation**
4. Wait for the analysis to complete
5. View the matched Surah and Ayah with confidence score
6. Click **Open in Quran.com** to read the verse

For best results, use videos with **Arabic captions** (manual or auto-generated) and analyze while the video is **playing**.

---

## Browser notes

### Chromium (Chrome, Edge, Opera)

Works out of the box. Requires Chromium **102+** for Manifest V3 features used by this extension.

### Brave

Brave Shields can block some caption fetch paths. QuranLens uses a multi-tier strategy (player-context hook + service worker) to work around this. If you still see **No Arabic Captions**:

1. Click the Brave Shields icon on the YouTube tab
2. Allow scripts / disable aggressive blocking for `youtube.com`
3. Reload the page and try again

### macOS

Installation and usage are identical to Windows — use the same browser-specific extensions URL above. Arabic UI fonts prefer **Amiri** (loaded from Google Fonts when online); offline fallbacks include **Geeza Pro** (macOS) and **Noto Naskh Arabic**.

---

## Rebuilding the Quran Corpus

The pre-built corpus (`data/quran_normalized.json`) is included. To rebuild:

```bash
# Requires Node.js 18+ (uses built-in fetch)
node data/build_quran_data.js
```

This fetches all 6,236 verses from the [Quran.com API](https://api.quran.com/), normalizes Arabic text, and saves the result.

---

## Generating PNG Icons

PNG icons are committed for out-of-the-box loading. To regenerate from SVG:

```bash
# Optional: higher quality via node-canvas
npm install canvas
node icons/generate_icons.js
```

A zero-dependency fallback generates valid PNGs without the canvas package.

---

## Project Structure

```
QuranLens/
├── manifest.json              # Extension manifest (Manifest V3)
├── background.js              # Service worker — caption fetch & matching
├── content.js                 # Content script — in-page overlay UI
├── TESTING.md                 # Cross-browser test checklist
├── data/
│   ├── build_quran_data.js    # Node.js corpus builder
│   └── quran_normalized.json  # Pre-built corpus (6,236 verses)
├── utils/
│   ├── arabic.js              # Arabic text normalization
│   ├── captions.js            # JSON3 caption parsing
│   ├── captions_page_fetch.js # MAIN-world YouTube caption hook
│   ├── matcher.js             # Fuzzy verse matching engine
│   └── youtube.js             # Caption & metadata extraction
├── icons/
│   ├── icon-{16,32,48,128}.svg
│   ├── icon-{16,32,48,128}.png
│   └── generate_icons.js
└── README.md
```

---

## How It Works

1. **Caption Extraction** — Three-tier fetch: player-context timedtext (with `pot=` token), service worker, content script fallback
2. **Arabic Normalization** — Strips diacritics (tashkeel), normalizes letter forms (alef variants, teh marbuta)
3. **Candidate Selection** — N-gram inverted index narrows ~6,236 verses to ~100–200 candidates
4. **Fuzzy Match** — Prefix Levenshtein with confidence scoring; matches below ~0.60 are discarded
5. **Live Scan** — Polls captions for 6–10 seconds, deduplicates overlapping chunks, early-exits on high confidence

---

## Known Limitations

- **Caption dependency** — Requires Arabic captions on the YouTube video
- **www.youtube.com only** — Mobile YouTube URLs (`m.youtube.com`) are not supported
- **Safari / Firefox** — Not supported in this release (Chromium only)
- **Auto-generated captions** — YouTube ASR can be inaccurate, reducing match quality
- **Service worker lifecycle** — Browser may suspend the worker after inactivity; re-analyze if needed

---

## Permissions Explained

| Permission | Purpose |
|---|---|
| `activeTab` | Access the current YouTube tab for analysis |
| `scripting` | Inject scripts into YouTube pages (including MAIN world for captions) |
| `storage` | Save overlay position and session match state |
| `youtube.com` | Read video captions and metadata |

---

## Testing

See [TESTING.md](TESTING.md) for the cross-browser, cross-OS manual test checklist.

---

## License

MIT License — Feel free to use, modify, and share.

---

<p align="center">
  <strong>بِسْمِ ٱللَّهِ ٱلرَّحْمَـٰنِ ٱلرَّحِيمِ</strong>
</p>
