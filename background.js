/**
 * QuranLens — Background Service Worker
 * 
 * Handles caption fetching, verse matching, and message routing.
 * Runs as a Manifest V3 service worker (no DOM access).
 * 
 * No external API calls at runtime. All matching is done against the
 * bundled Quran corpus via the n-gram accelerated matcher.
 */

// Import utilities into service worker context
importScripts('utils/arabic.js', 'utils/matcher.js', 'utils/captions.js');

// ─── Caption URL Cache ──────────────────────────────────────────────────────

const captionUrlCache = new Map(); // videoId → { url, expiresAt }
const tabLastVideoId = new Map();  // tabId → videoId (for invalidation)
const CACHE_TTL_MS = 240000;       // 4 minutes

// ─── Disambiguation Buffers ──────────────────────────────────────────────────
const tabBuffers = {};

// ─── Analysis session tracking (cancel stale runs on video change) ───────────
const tabAnalysisSession = new Map(); // tabId → generation number

function bumpAnalysisSession(tabId) {
  const next = (tabAnalysisSession.get(tabId) || 0) + 1;
  tabAnalysisSession.set(tabId, next);
  return next;
}

function isActiveSession(tabId, session) {
  return tabAnalysisSession.get(tabId) === session;
}

async function resetPageCaptionState(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        window.dispatchEvent(new CustomEvent('quranlens-video-changed'));
      }
    });
  } catch (e) {
    console.warn('[QuranLens BG] Failed to reset page caption state:', e.message);
  }
}

async function fetchFreshPlayerResponse(tabId, videoId, maxAttempts = 8) {
  if (!videoId) return null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: (targetVideoId) => {
          const sanitizeResponse = (response) => {
            if (!response) return null;
            const details = response.videoDetails || {};
            if (details.videoId === targetVideoId) {
              return {
                captions: response.captions || null,
                videoDetails: {
                  title: details.title || null,
                  shortDescription: details.shortDescription || null,
                  author: details.author || null,
                  videoId: details.videoId || null
                }
              };
            }
            return null;
          };

          const p = sanitizeResponse(window.ytInitialPlayerResponse);
          if (p) return p;

          if (window.ytplayer?.config?.args?.raw_player_response) {
            const pRaw = sanitizeResponse(window.ytplayer.config.args.raw_player_response);
            if (pRaw) return pRaw;
          }
          return null;
        },
        args: [videoId]
      });

      const playerResponse = results?.[0]?.result;
      if (playerResponse) {
        return playerResponse;
      }
    } catch (e) {
      console.warn(`[QuranLens BG] fetchFreshPlayerResponse attempt ${attempt + 1} failed:`, e.message);
    }
    if (attempt < maxAttempts - 1) {
      await new Promise(r => setTimeout(r, 150));
    }
  }

  return null;
}

async function tryFastCachedAnalysis(tabId, videoId, currentTime, session) {
  if (!videoId || !isActiveSession(tabId, session)) return null;

  const cached = captionUrlCache.get(videoId);
  if (!cached || Date.now() >= cached.expiresAt) return null;

  const liveTimeSec = await getVideoCurrentTimeSec(tabId);
  const timeSec = liveTimeSec ?? currentTime;
  const captions = await fetchCaptionsFromCachedUrl(cached.url, timeSec * 1000);
  if (!captions || captions.length <= 10) return null;

  const storageData = await chrome.storage.session.get('lastMatch');
  const lastMatch = storageData?.lastMatch || null;
  const result = await findVerse(captions, lastMatch);

  if (!result || (result.state !== 'match' && result.state !== 'tied')) return null;
  if (!isActiveSession(tabId, session)) return null;

  return { result, captions };
}

async function pushMatchResult(tabId, session, result) {
  const stillTied = result.state === 'tied';
  const payload = {
    type: 'MATCH_RESULT',
    result: {
      ...result,
      url: getQuranUrl(result.surah, result.ayah),
      timestamp: Date.now()
    },
    ambiguous: stillTied
  };
  if (!stillTied) {
    await chrome.storage.session.set({ lastMatch: { surah: result.surah, ayah: result.ayah } });
  }
  await pushResult(tabId, payload, session);
}

function handleVideoNavigation(tabId, url) {
  bumpAnalysisSession(tabId);
  chrome.storage.session.remove('lastMatch').catch(() => {});
  delete tabBuffers[tabId];

  if (!url || !url.includes('youtube.com/watch')) {
    return;
  }

  try {
    const newVideoId = new URL(url).searchParams.get('v');
    const oldVideoId = tabLastVideoId.get(tabId);
    if (oldVideoId) {
      captionUrlCache.delete(oldVideoId);
    }
    if (newVideoId) {
      captionUrlCache.delete(newVideoId);
      tabLastVideoId.set(tabId, newVideoId);
    }
  } catch (_) { /* ignore malformed URL */ }

  resetPageCaptionState(tabId).catch(() => {});
  chrome.tabs.sendMessage(tabId, { type: 'VIDEO_CHANGED' }).catch(() => {});
}

// ─── Icon Click → Toggle Overlay ────────────────────────────────────────────

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.url) return;

  // Only works on YouTube watch pages
  if (!tab.url.includes('youtube.com/watch')) {
    // Attempt to show a notification or badge on non-YouTube pages
    try {
      await chrome.action.setBadgeText({ text: '!', tabId: tab.id });
      await chrome.action.setBadgeBackgroundColor({ color: '#ef4444', tabId: tab.id });
      setTimeout(() => {
        chrome.action.setBadgeText({ text: '', tabId: tab.id }).catch(() => {});
      }, 3000);
    } catch (_) {}
    return;
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_OVERLAY' });
  } catch (err) {
    // Content script not loaded yet — inject it and retry
    console.warn('[QuranLens BG] Content script not ready, injecting...', err.message);
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['utils/arabic.js', 'utils/captions.js', 'utils/youtube.js', 'content.js']
      });
      // Small delay for script initialization
      await new Promise(r => setTimeout(r, 200));
      await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_OVERLAY' });
    } catch (injectErr) {
      console.error('[QuranLens BG] Failed to inject content script:', injectErr);
    }
  }
});

// ─── Message Router ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'ANALYZE_VIDEO') {
    // Handle analysis — push result back to content script tab
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ type: 'ERROR', message: 'Could not identify tab.' });
      return false;
    }

    const session = bumpAnalysisSession(tabId);

    // Send immediate acknowledgment to prevent channel timeout (progress starts at 0)
    sendResponse({ type: 'ANALYZING', progress: 0, confidence: null, session });

    // Do the actual work asynchronously and push results to the tab
    handleAnalyzeVideo(tabId, sender.tab, message.currentTime, session).catch(err => {
      console.error('[QuranLens BG] Analyze error:', err);
      if (!isActiveSession(tabId, session)) return;
      chrome.tabs.sendMessage(tabId, {
        type: 'ERROR',
        message: err.message || 'Analysis failed.',
        session
      }).catch(() => {});
    });

    return false; // We already called sendResponse synchronously
  }

  if (message.type === 'VIDEO_NAVIGATED') {
    const tabId = sender.tab?.id;
    if (tabId && sender.tab?.url) {
      handleVideoNavigation(tabId, sender.tab.url);
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === 'OPEN_QURAN') {
    chrome.tabs.create({ url: message.url }).catch(() => {});
    sendResponse({ type: 'SUCCESS' });
    return false;
  }

  return false;
});

// ─── Scan Helpers ───────────────────────────────────────────────────────────

function getWordCount(text) {
  return (text || '').trim().split(/\s+/).filter(Boolean).length;
}

async function buildLowConfMatch(text, lastMatch) {
  const lastResult = await findVerse(text, lastMatch);
  const topCandidate = lastResult?.topCandidate;
  if (!topCandidate) return null;
  return {
    state: 'match',
    surah: topCandidate.surah,
    ayah: topCandidate.ayah,
    confidence: topCandidate.confidence,
    surahName: topCandidate.surahName,
    text: topCandidate.text,
    lowConfidence: true
  };
}

function computeHeartbeatProgress(hasReceivedCaptions, bestResult, isFinalizing) {
  if (isFinalizing) return 99;
  if (!hasReceivedCaptions) return 0;
  if (bestResult?.confidence != null) {
    return Math.min(99, Math.round(20 + bestResult.confidence * 60));
  }
  return 20;
}

async function sendAnalyzingHeartbeat(tabId, session, hasReceivedCaptions, bestResult, isFinalizing, isPending = false) {
  if (!isActiveSession(tabId, session)) return;
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'ANALYZING',
      progress: computeHeartbeatProgress(hasReceivedCaptions, bestResult, isFinalizing),
      confidence: bestResult?.confidence ?? null,
      pending: isPending,
      session
    });
  } catch (e) {
    console.warn('[QuranLens BG] Heartbeat send failed:', e.message);
  }
}

// ─── Caption Fetch (service worker — bypasses Brave Shields / page CORS) ───

/**
 * Fetch Arabic captions via the extension service worker using JSON3 timedtext.
 * @param {Object} playerResponse — sanitized player response from the YouTube tab
 * @param {number} [currentTime] — playback time in seconds
 * @returns {Promise<string|null>}
 */
async function fetchArabicCaptions(playerResponse, currentTime) {
  const currentTimeMs = currentTime !== undefined ? currentTime * 1000 : undefined;
  return fetchArabicCaptionsFromPlayerResponse(playerResponse, '[QuranLens BG]', currentTimeMs);
}

/**
 * Fetch captions from a cached signed timedtext URL (bypasses exp=xpe guard).
 * @param {string} cachedUrl
 * @param {number} [currentTimeMs]
 * @returns {Promise<string|null>}
 */
async function fetchCaptionsFromCachedUrl(cachedUrl, currentTimeMs) {
  try {
    const json3Url = buildJson3CaptionUrl(cachedUrl);
    console.log('[QuranLens BG] Fetching cached signed URL as json3');
    const response = await fetch(json3Url, { credentials: 'omit' });
    if (!response.ok) {
      console.warn('[QuranLens BG] Cached URL fetch failed: HTTP', response.status);
      return null;
    }
    const rawText = await response.text();
    if (!rawText || !rawText.trim()) {
      console.warn('[QuranLens BG] Cached URL response empty');
      return null;
    }
    const data = JSON.parse(rawText);
    const transcript = parseJson3CaptionData(data, currentTimeMs);
    if (transcript && transcript.length > 10) {
      console.log('[QuranLens BG] Cached URL captions OK, length:', transcript.length);
      return transcript;
    }
    return null;
  } catch (e) {
    console.warn('[QuranLens BG] Cached URL fetch error:', e);
    return null;
  }
}

async function getVideoCurrentTimeSec(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const video = document.querySelector('video');
        return video && Number.isFinite(video.currentTime) ? video.currentTime : null;
      }
    });
    const t = results?.[0]?.result;
    return typeof t === 'number' && t >= 0 ? t : null;
  } catch {
    return null;
  }
}

/**
 * Fetch captions in the YouTube page MAIN world using the player's pot= timedtext URL.
 * Required when baseUrl contains exp=xpe (direct fetch returns empty body).
 * @param {number} tabId
 * @param {string} videoId
 * @param {number} [currentTime] — playback time in seconds
 * @param {boolean} [skipInjection=false] — if true, skip injecting captions_page_fetch.js
 * @returns {Promise<{ captions: string|null, noArabicTrack: boolean }>}
 */
async function fetchArabicCaptionsViaPlayer(tabId, videoId, currentTime, skipInjection = false) {
  try {
    const currentTimeMs = currentTime !== undefined ? currentTime * 1000 : undefined;

    // Cache hit — skip executeScript round-trips
    if (videoId) {
      const cached = captionUrlCache.get(videoId);
      if (cached && Date.now() < cached.expiresAt) {
        console.log('[QuranLens BG] Using cached signed timedtext URL for videoId:', videoId);
        const transcript = await fetchCaptionsFromCachedUrl(cached.url, currentTimeMs);
        if (transcript) return { captions: transcript, noArabicTrack: false };
        console.log('[QuranLens BG] Cached URL fetch failed, falling through to page script');
      }
    }

    console.log('[QuranLens BG] Attempting player-context caption fetch (pot token) for currentTime:', currentTime);

    if (!skipInjection) {
      // Chrome requires exactly one of 'files' or 'func' per executeScript call
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        files: ['utils/captions_page_fetch.js']
      });
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async (vid, timeMs) => {
        if (typeof window.QuranLensFetchArabicCaptions !== 'function') {
          return null;
        }
        return await window.QuranLensFetchArabicCaptions(vid, timeMs);
      },
      args: [videoId, currentTimeMs]
    });

    const result = results?.[0]?.result;

    // New shape: { captions, signedUrl }
    if (result && typeof result === 'object' && result.captions && result.captions.length > 10) {
      if (result.signedUrl && result.signedUrl.includes('pot=') && videoId) {
        captionUrlCache.set(videoId, {
          url: result.signedUrl,
          expiresAt: Date.now() + CACHE_TTL_MS
        });
        console.log('[QuranLens BG] Cached signed timedtext URL for videoId:', videoId);
      }
      console.log('[QuranLens BG] Player-context captions OK, length:', result.captions.length);
      return { captions: result.captions, noArabicTrack: false };
    }

    if (result?.error === 'no_arabic_track') {
      console.warn('[QuranLens BG] No Arabic caption track on this video');
      return { captions: null, noArabicTrack: true };
    }

    if (result?.error) {
      console.warn('[QuranLens BG] Player-context caption fetch failed:', result.error, result);
    } else {
      console.log('[QuranLens BG] Player-context caption fetch did not return usable text');
    }
    return { captions: null, noArabicTrack: false };
  } catch (e) {
    console.warn('[QuranLens BG] Player-context caption fetch failed:', e);
    return { captions: null, noArabicTrack: false };
  }
}

/**
 * Tier 3: fetch captions via content script message.
 * @param {number} tabId
 * @param {Object} playerResponse
 * @param {number} currentTime — playback time in seconds
 * @returns {Promise<string|null>}
 */
async function fetchCaptionsViaContentScript(tabId, playerResponse, currentTime) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: 'FETCH_CAPTIONS',
      playerResponse: playerResponse,
      currentTime: currentTime
    });
    if (response && response.type === 'CAPTIONS_RESULT' && response.text && response.text.length > 10) {
      return response.text;
    }
  } catch (e) {
    console.warn('[QuranLens BG] Tier 3 fetch error:', e.message);
  }
  return null;
}

// ─── Caption Deduplication Helper ──────────────────────────────────────────

function deduplicateAndAppend(accumulated, newChunk) {
  const cleanAccumulated = (accumulated || '').trim().replace(/\s+/g, ' ');
  const cleanNewChunk = (newChunk || '').trim().replace(/\s+/g, ' ');
  if (!cleanAccumulated) return cleanNewChunk;
  if (!cleanNewChunk) return cleanAccumulated;

  if (cleanAccumulated.includes(cleanNewChunk)) {
    return cleanAccumulated;
  }

  const accumWords = cleanAccumulated.split(' ');
  const newWords = cleanNewChunk.split(' ');

  const maxOverlap = Math.min(10, accumWords.length, newWords.length);
  let bestOverlap = 0;

  for (let len = 1; len <= maxOverlap; len++) {
    const suffix = accumWords.slice(accumWords.length - len).join(' ');
    const prefix = newWords.slice(0, len).join(' ');

    if (suffix === prefix) {
      bestOverlap = len;
    }
  }

  const nonOverlappingTail = newWords.slice(bestOverlap).join(' ');
  if (!nonOverlappingTail) {
    return cleanAccumulated;
  }
  return (cleanAccumulated + ' ' + nonOverlappingTail).trim();
}

// Cap the accumulated transcript so text from early in a long scan ages out.
// Without this, a 10-30s scan matches against captions up to ~40s stale and
// the matcher drifts to verses already finished. 80 words ≈ 60s of recitation,
// comfortably above the 50-word pending finalization threshold.
const MAX_TRANSCRIPT_WORDS = 80;

function trimTranscriptWords(text) {
  const words = (text || '').split(/\s+/).filter(Boolean);
  if (words.length <= MAX_TRANSCRIPT_WORDS) return text;
  return words.slice(-MAX_TRANSCRIPT_WORDS).join(' ');
}

// ─── Handler: Analyze Video ─────────────────────────────────────────────────

async function handleAnalyzeVideo(tabId, tab, currentTime, session) {
  let timeoutId = null;
  let scanComplete = false;
  const cleanup = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  };

  try {
    if (!isActiveSession(tabId, session)) return;

    if (!tab || !tab.url || !tab.url.includes('youtube.com/watch')) {
      await pushResult(tabId, { type: 'ERROR', message: 'Please open a YouTube video first.', session });
      return;
    }

    const urlObj = new URL(tab.url);
    const videoId = urlObj.searchParams.get('v');
    if (!videoId) {
      await pushResult(tabId, { type: 'ERROR', message: 'Could not detect video ID.', session });
      return;
    }

    // Inject captions_page_fetch.js ONCE before the loop starts
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        files: ['utils/captions_page_fetch.js']
      });
    } catch (e) {
      console.warn('[QuranLens BG] Initial captions_page_fetch.js injection failed (movie_player not ready), continuing:', e.message);
    }

    // Fast path: reuse cached signed caption URL (typical on re-analyze / same video)
    const fastHit = await tryFastCachedAnalysis(tabId, videoId, currentTime, session);
    if (fastHit) {
      console.log('[QuranLens BG] Fast path: cached captions + match');
      await pushMatchResult(tabId, session, fastHit.result);
      return;
    }

    // Fetch player response in parallel with scan start (non-blocking upfront wait)
    let playerResponse = null;
    let playerResponsePromise = fetchFreshPlayerResponse(
      tabId,
      videoId,
      captionUrlCache.has(videoId) ? 2 : 4
    );

    const scanStartTime = Date.now();
    // Timing model: FAST 6s / SLOW 10s scans; 30s absolute cap; pending inactivity 15s;
    // tick 400ms (captions flowing) / 600ms (waiting); caption window -15s/+8s in parsers.
    const FAST_SCAN_DURATION = 6000;
    const SLOW_SCAN_DURATION = 10000;
    const MAX_SCAN_DURATION = 30000;
    const PENDING_INACTIVITY_MS = 15000;
    const PENDING_ANCHOR_MAX_DRIFT_SEC = 30;
    const SEEK_DETECTION_THRESHOLD_SEC = 5;

    let accumulatedText = '';
    let bestResult = null;
    let hasReceivedCaptions = false;
    let captionsFirstArrivedAt = null;
    let isFirstTick = true;
    let skipTier1NoArabic = false;
    let lastTickTimeSec = null;
    let lastTickWallMs = null;

    // Resume pending buffer only if playback is still near the anchor position
    let isPendingMode = false;
    if (tabBuffers[tabId]) {
      const buffer = tabBuffers[tabId];
      const anchorSec = buffer.anchorTimeSec ?? currentTime;
      if (Math.abs(currentTime - anchorSec) > PENDING_ANCHOR_MAX_DRIFT_SEC) {
        console.log('[QuranLens BG] Dropping stale pending buffer (anchor drift)');
        delete tabBuffers[tabId];
      } else {
        isPendingMode = true;
        accumulatedText = buffer.text;
      }
    }

    const getEffectiveScanDuration = () => {
      if (!captionsFirstArrivedAt) return SLOW_SCAN_DURATION;
      return (captionsFirstArrivedAt - scanStartTime) <= 3000
        ? FAST_SCAN_DURATION
        : SLOW_SCAN_DURATION;
    };

    const startAnchorTimeMs = currentTime * 1000;
    let inTick = false;

    await new Promise((resolve) => {
      const tick = async () => {
        if (inTick) return;
        if (!isActiveSession(tabId, session)) {
          scanComplete = true;
          cleanup();
          resolve();
          return;
        }
        inTick = true;

        try {
          const elapsed = Date.now() - scanStartTime;
          const liveTimeSec = await getVideoCurrentTimeSec(tabId);
          const currentTickTimeSec = liveTimeSec ?? ((startAnchorTimeMs + elapsed) / 1000);

          if (!isActiveSession(tabId, session)) {
            scanComplete = true;
            cleanup();
            resolve();
            return;
          }

          // Seek detection: reset transcript if playhead jumped beyond normal playback
          if (lastTickTimeSec !== null && lastTickWallMs !== null) {
            const wallElapsedSec = (Date.now() - lastTickWallMs) / 1000;
            const videoDeltaSec = Math.abs(currentTickTimeSec - lastTickTimeSec);
            if (videoDeltaSec > wallElapsedSec + SEEK_DETECTION_THRESHOLD_SEC) {
              console.log('[QuranLens BG] Seek detected — resetting transcript and pending buffer');
              accumulatedText = '';
              if (tabBuffers[tabId]) {
                delete tabBuffers[tabId];
                isPendingMode = false;
              }
            }
          }
          lastTickTimeSec = currentTickTimeSec;
          lastTickWallMs = Date.now();

          // Absolute scan cap (includes pending mode)
          if (elapsed > MAX_SCAN_DURATION) {
            console.log('[QuranLens BG] Absolute scan cap reached (30s)');
            const storageData = await chrome.storage.session.get('lastMatch');
            const lastMatch = storageData?.lastMatch || null;
            if (isPendingMode && tabBuffers[tabId]) {
              bestResult = await buildLowConfMatch(tabBuffers[tabId].text, lastMatch);
              delete tabBuffers[tabId];
            }
            scanComplete = true;
            cleanup();
            resolve();
            return;
          }

          // Retrieve lastMatch
          const storageData = await chrome.storage.session.get('lastMatch');
          const lastMatch = storageData?.lastMatch || null;

          async function applyTier1Fetch() {
            if (!videoId || skipTier1NoArabic) return null;
            const tier1 = await fetchArabicCaptionsViaPlayer(tabId, videoId, currentTickTimeSec, true);
            if (tier1.noArabicTrack) skipTier1NoArabic = true;
            return tier1.captions;
          }

          async function ensurePlayerResponse() {
            if (playerResponse && playerResponse.videoDetails?.videoId === videoId) {
              return playerResponse;
            }
            if (!playerResponsePromise) {
              playerResponsePromise = fetchFreshPlayerResponse(tabId, videoId, 3);
            }
            playerResponse = await playerResponsePromise;
            playerResponsePromise = null;
            return playerResponse;
          }

          // ── Caption fetch tiers ──
          let newCaptions = null;

          if (isFirstTick) {
            // Tier 1 first (uses cache when available — no playerResponse needed)
            newCaptions = await applyTier1Fetch();
            if (!newCaptions || newCaptions.length <= 10) {
              const pr = await ensurePlayerResponse();
              if (pr) {
                newCaptions = await fetchArabicCaptions(pr, currentTickTimeSec);
              }
            }
            if (!newCaptions || newCaptions.length <= 10) {
              const pr = playerResponse || await ensurePlayerResponse();
              newCaptions = await fetchCaptionsViaContentScript(tabId, pr, currentTickTimeSec);
            }
          } else {
            // Tier 1: Player context / cache
            try {
              newCaptions = await applyTier1Fetch();
            } catch (e) {
              console.warn('[QuranLens BG] Tier 1 injection/fetch error, continuing:', e.message);
            }

            // Tier 2: Service worker direct fetch
            if (!newCaptions || newCaptions.length <= 10) {
              try {
                const pr = await ensurePlayerResponse();
                if (pr) {
                  newCaptions = await fetchArabicCaptions(pr, currentTickTimeSec);
                }
              } catch (e) {
                console.warn('[QuranLens BG] Tier 2 fetch error:', e.message);
              }
            }

            // Tier 3: Content script fallback
            if (!newCaptions || newCaptions.length <= 10) {
              const pr = playerResponse || await ensurePlayerResponse();
              newCaptions = await fetchCaptionsViaContentScript(tabId, pr, currentTickTimeSec);
            }
          }

          if (newCaptions && newCaptions.length > 0) {
            if (!captionsFirstArrivedAt) {
              captionsFirstArrivedAt = Date.now();
            }
          }

          if (isPendingMode) {
            // Pending inactivity timeout (15s since last pending activity)
            const buffer = tabBuffers[tabId];
            const timeSincePending = Date.now() - buffer.lastPendingTime;
            if (timeSincePending > PENDING_INACTIVITY_MS) {
              bestResult = await buildLowConfMatch(buffer.text, lastMatch);
              delete tabBuffers[tabId];
              scanComplete = true;
              cleanup();
              resolve();
              return;
            }

            if (newCaptions && newCaptions.trim().length > 0) {
              const oldText = buffer.text;
              buffer.text = trimTranscriptWords(deduplicateAndAppend(buffer.text, newCaptions));
              if (buffer.text !== oldText) {
                buffer.attempts++;
                buffer.lastPendingTime = Date.now();
              }
            }

            const wordCnt = getWordCount(buffer.text);
            if (wordCnt >= 6) {
              hasReceivedCaptions = true;
              const result = await findVerse(buffer.text, lastMatch);

              if (result) {
                if (result.state === "match") {
                  delete tabBuffers[tabId];
                  bestResult = result;
                  scanComplete = true;
                  cleanup();
                  resolve();
                  return;
                } else if (result.state === "tied") {
                  delete tabBuffers[tabId];
                  bestResult = result;
                  scanComplete = true;
                  cleanup();
                  resolve();
                  return;
                } else if (result.state === "pending") {
                  if (wordCnt >= 50) {
                    bestResult = await buildLowConfMatch(buffer.text, lastMatch);
                    delete tabBuffers[tabId];
                    scanComplete = true;
                    cleanup();
                    resolve();
                    return;
                  }
                  // Otherwise: stay in pending, do not update UI yet
                }
              } else {
                // If it returned null (NO_MATCH) but we reached >= 50 words
                if (wordCnt >= 50) {
                  delete tabBuffers[tabId];
                  bestResult = null;
                  scanComplete = true;
                  cleanup();
                  resolve();
                  return;
                }
              }
            }
          } else {
            // Normal mode (not pending)
            if (newCaptions && newCaptions.length > 0) {
              accumulatedText = trimTranscriptWords(deduplicateAndAppend(accumulatedText, newCaptions));
            }

            const wordCnt = getWordCount(accumulatedText);
            if (wordCnt >= 6) {
              hasReceivedCaptions = true;
              const result = await findVerse(accumulatedText, lastMatch);

              if (result) {
                if (result.state === "match" || result.state === "tied") {
                  bestResult = result;
                  scanComplete = true;
                  cleanup();
                  resolve();
                  return;
                } else if (result.state === "pending") {
                  // Initialize buffer anchored to current playback position
                  tabBuffers[tabId] = {
                    text: accumulatedText,
                    attempts: 1,
                    lastPendingTime: Date.now(),
                    anchorTimeSec: currentTickTimeSec
                  };
                  isPendingMode = true;
                  // Do not update UI yet, just continue loop
                }
              }
            }

            if (elapsed >= getEffectiveScanDuration()) {
              scanComplete = true;
              cleanup();
              resolve();
              return;
            }
          }

          // ── Heartbeat ──
          await sendAnalyzingHeartbeat(tabId, session, hasReceivedCaptions, bestResult, false, isPendingMode);

        } catch (err) {
          console.error('[QuranLens BG] Error in polling loop tick:', err);
        } finally {
          inTick = false;
          isFirstTick = false;
          if (!scanComplete) {
            timeoutId = setTimeout(tick, hasReceivedCaptions ? 400 : 600);
          }
        }
      };

      timeoutId = setTimeout(tick, 0);
    });

    if (!isActiveSession(tabId, session)) return;

    let finalResult = null;
    if (bestResult) {
      const stillTied = bestResult.state === "tied";
      finalResult = {
        type: 'MATCH_RESULT',
        result: {
          ...bestResult,
          url: getQuranUrl(bestResult.surah, bestResult.ayah),
          timestamp: Date.now()
        },
        ambiguous: stillTied
      };
      if (!stillTied) {
        await chrome.storage.session.set({ lastMatch: { surah: bestResult.surah, ayah: bestResult.ayah } });
      }
    } else if (accumulatedText && accumulatedText.trim().length > 0) {
      finalResult = {
        type: 'NO_MATCH',
        message: 'No Quran recitation detected in the captions.'
      };
    } else {
      finalResult = {
        type: 'NO_CAPTIONS',
        message: 'No Arabic captions found for this video. Try a video from a channel that provides Arabic subtitles.'
      };
    }

    await pushResult(tabId, finalResult, session);

  } catch (err) {
    cleanup();
    console.error('[QuranLens BG] Analyze error:', err);

    if (!isActiveSession(tabId, session)) return;

    if (err.message && err.message.includes('Could not establish connection')) {
      await pushResult(tabId, {
        type: 'ERROR',
        message: 'Content script not ready. Please refresh the YouTube page and try again.',
        session
      });
      return;
    }

    await pushResult(tabId, { type: 'ERROR', message: err.message || 'Failed to analyze video.', session });
  }
}

// ─── Push Result to Content Script ──────────────────────────────────────────

async function pushResult(tabId, result, session) {
  if (session !== undefined && !isActiveSession(tabId, session)) {
    console.log('[QuranLens BG] Dropping stale result for tab', tabId, 'session', session);
    return;
  }
  try {
    await chrome.tabs.sendMessage(tabId, { ...result, session });
  } catch (e) {
    console.warn('[QuranLens BG] Failed to push result to tab:', e);
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    handleVideoNavigation(tabId, changeInfo.url);
  }
});

// ─── Tab Close Detection ───────────────────────────────────────────────────
chrome.tabs.onRemoved.addListener((tabId) => {
  delete tabBuffers[tabId];
  tabAnalysisSession.delete(tabId);
  tabLastVideoId.delete(tabId);
});

console.log('[QuranLens] Service worker initialized.');
loadCorpus().catch(err => console.warn('[QuranLens] Corpus preload failed:', err));
