# QuranLens — Cross-Browser / Cross-OS Test Checklist

Use this checklist when verifying QuranLens on Chromium browsers (Chrome, Edge, Brave, Opera) on **Windows** and **macOS**.

For each browser, load the unpacked extension from the repo root, then run all tests on a YouTube watch page with Arabic auto-generated or manual captions (Quran recitation video).

## Setup

- [ ] Extension loads without errors in the browser extensions page
- [ ] All four PNG icons display correctly (16, 32, 48, 128)
- [ ] Extension is pinned to the toolbar

## Core flow

- [ ] Navigate to `https://www.youtube.com/watch?v=...` (recitation with Arabic captions)
- [ ] Click QuranLens toolbar icon — overlay appears on the page
- [ ] Click **Analyze Recitation** — loading state shows progress
- [ ] Analysis completes with a match result (Surah, Ayah, confidence %)
- [ ] Arabic verse text renders legibly (font fallbacks OK if offline)
- [ ] Click **Open in Quran.com** — new tab opens to the correct verse

## Navigation and state

- [ ] Click a different video (SPA navigation, no full reload) — overlay resets to idle
- [ ] Analyze on the new video — works without reloading the extension
- [ ] Pause video, seek to another section, re-analyze — returns a result (may differ by position)
- [ ] Full page reload (F5 / Cmd+R) — extension still works on the same video

## Overlay UI

- [ ] Drag overlay by header — position updates smoothly
- [ ] Close and reopen overlay — saved position is restored
- [ ] Overlay stays within viewport on window resize

## Error paths

- [ ] Video without Arabic captions shows **No Arabic Captions** (not a crash)
- [ ] Non-YouTube page: toolbar click shows badge warning (no overlay)

## Brave-specific (spot-check one platform)

- [ ] With Shields up: caption fetch works via player-context path, or
- [ ] Document: lowering Shields for youtube.com fixes caption failures if needed

## Platform matrix

Record pass/fail for each combination tested:

| Browser | Windows | macOS | Tester | Date |
|---------|---------|-------|--------|------|
| Chrome  |         |       |        |      |
| Edge    |         |       |        |      |
| Brave   |         |       |        |      |
| Opera   |         |       |        |      |

## Notes

- Minimum Chromium version: **102+** (required for `storage.session` and MAIN-world script injection)
- Test on `www.youtube.com/watch` only — mobile (`m.youtube.com`) is not supported
- If fonts look wrong offline, confirm system Arabic fonts are installed; Google Fonts load when online
