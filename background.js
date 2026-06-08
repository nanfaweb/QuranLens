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

    // Send immediate acknowledgment to prevent channel timeout (progress starts at 0)
    sendResponse({ type: 'ANALYZING', progress: 0, confidence: null });

    // Do the actual work asynchronously and push results to the tab
    handleAnalyzeVideo(tabId, sender.tab, message.currentTime, message.videoDetails).catch(err => {
      console.error('[QuranLens BG] Analyze error:', err);
      chrome.tabs.sendMessage(tabId, {
        type: 'ERROR',
        message: err.message || 'Analysis failed.'
      }).catch(() => {});
    });

    return false; // We already called sendResponse synchronously
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

function shouldEarlyExit(stabilityCount, bestResult) {
  const c = bestResult?.confidence ?? 0;
  if (stabilityCount >= 1 && c >= 0.92) return true;
  if (stabilityCount >= 2 && c >= 0.85) return true;
  if (stabilityCount >= 3 && c >= 0.82) return true;
  return false;
}

function computeHeartbeatProgress(hasReceivedCaptions, bestResult, isFinalizing) {
  if (isFinalizing) return 99;
  if (!hasReceivedCaptions) return 0;
  if (bestResult?.confidence != null) {
    return Math.min(99, Math.round(20 + bestResult.confidence * 60));
  }
  return 20;
}

async function sendAnalyzingHeartbeat(tabId, hasReceivedCaptions, bestResult, isFinalizing) {
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'ANALYZING',
      progress: computeHeartbeatProgress(hasReceivedCaptions, bestResult, isFinalizing),
      confidence: bestResult?.confidence ?? null
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

/**
 * Fetch captions in the YouTube page MAIN world using the player's pot= timedtext URL.
 * Required when baseUrl contains exp=xpe (direct fetch returns empty body).
 * @param {number} tabId
 * @param {string} videoId
 * @param {number} [currentTime] — playback time in seconds
 * @param {boolean} [skipInjection=false] — if true, skip injecting captions_page_fetch.js
 * @returns {Promise<string|null>}
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
        if (transcript) return transcript;
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
      return result.captions;
    }

    console.log('[QuranLens BG] Player-context caption fetch did not return usable text');
    return null;
  } catch (e) {
    console.warn('[QuranLens BG] Player-context caption fetch failed:', e);
    return null;
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

// ─── Handler: Analyze Video ─────────────────────────────────────────────────

async function handleAnalyzeVideo(tabId, tab, currentTime, videoDetails) {
  let timeoutId = null;
  let scanComplete = false;
  const cleanup = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  };

  try {
    if (!tab || !tab.url || !tab.url.includes('youtube.com/watch')) {
      await pushResult(tabId, { type: 'ERROR', message: 'Please open a YouTube video first.' });
      return;
    }

    const urlObj = new URL(tab.url);
    const videoId = urlObj.searchParams.get('v');

    let activeVideoDetails = videoDetails || null;

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

    // Retrieve player response from MAIN world (with retries for SPA navigation)
    let playerResponse = null;
    try {
      if (videoId) {
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            const results = await chrome.scripting.executeScript({
              target: { tabId: tabId },
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

                if (window.ytplayer && window.ytplayer.config && window.ytplayer.config.args) {
                  const raw = window.ytplayer.config.args.raw_player_response;
                  const pRaw = sanitizeResponse(raw);
                  if (pRaw) return pRaw;
                }
                return null;
              },
              args: [videoId]
            });

            playerResponse = results?.[0]?.result;
            if (playerResponse) {
              break;
            }
          } catch (e) {
            console.warn(`[QuranLens] executeScript attempt ${attempt + 1} failed:`, e);
          }
          await new Promise(r => setTimeout(r, 300));
        }
      }
    } catch (e) {
      console.warn('[QuranLens] Failed to retrieve playerResponse from MAIN world:', e);
    }

    if (playerResponse && playerResponse.videoDetails) {
      activeVideoDetails = playerResponse.videoDetails;
    }

    const scanStartTime = Date.now();
    const FAST_SCAN_DURATION = 6000;
    const SLOW_SCAN_DURATION = 10000;
    let accumulatedText = '';
    let bestResult = null;
    let stabilityCount = 0;
    let lastMatchKey = null;
    let lastMatchedTextLength = 0;
    let lastMatchWasTied = false;
    let hasReceivedCaptions = false;
    let captionsFirstArrivedAt = null;
    let isFirstTick = true;

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
        inTick = true;

        try {
          const elapsed = Date.now() - scanStartTime;
          const currentTickTimeSec = (startAnchorTimeMs + elapsed) / 1000;

          // ── Optimisation 5: Pre-fetch match (read-only) ──
          const wordCountBefore = getWordCount(accumulatedText);
          if (wordCountBefore >= 6 && !lastMatchWasTied) {
            const earlyResponse = await matchCaptions(accumulatedText, activeVideoDetails);
            if (earlyResponse && earlyResponse.type === 'MATCH_RESULT' && earlyResponse.result) {
              const earlyKey = `${earlyResponse.result.surah}:${earlyResponse.result.ayah}`;
              if (bestResult === null) {
                bestResult = earlyResponse.result;
              }
              if (earlyKey === lastMatchKey && shouldEarlyExit(stabilityCount, bestResult)) {
                console.log('[QuranLens BG] Pre-fetch early exit: stable match confirmed:', lastMatchKey, 'confidence:', bestResult.confidence);
                scanComplete = true;
                await sendAnalyzingHeartbeat(tabId, hasReceivedCaptions, bestResult, true);
                cleanup();
                resolve();
                return;
              }
            }
          }

          // ── Caption fetch tiers ──
          let newCaptions = null;

          if (isFirstTick) {
            // Optimisation 2: parallel tier firing on tick 1
            const [t1Result, t2Result, t3Result] = await Promise.allSettled([
              videoId
                ? fetchArabicCaptionsViaPlayer(tabId, videoId, currentTickTimeSec, true)
                : Promise.resolve(null),
              playerResponse
                ? fetchArabicCaptions(playerResponse, currentTickTimeSec)
                : Promise.resolve(null),
              fetchCaptionsViaContentScript(tabId, playerResponse, currentTickTimeSec)
            ]);

            const pickTier = (r) =>
              r.status === 'fulfilled' && r.value && r.value.length > 10 ? r.value : null;
            newCaptions = pickTier(t1Result) || pickTier(t2Result) || pickTier(t3Result);
          } else {
            // Tier 1: Player context (cache hit on tick 2+)
            if (videoId) {
              try {
                newCaptions = await fetchArabicCaptionsViaPlayer(tabId, videoId, currentTickTimeSec, true);
              } catch (e) {
                console.warn('[QuranLens BG] Tier 1 injection/fetch error, continuing:', e.message);
              }
            }

            // Tier 2: Service worker direct fetch
            if ((!newCaptions || newCaptions.length <= 10) && playerResponse) {
              try {
                newCaptions = await fetchArabicCaptions(playerResponse, currentTickTimeSec);
              } catch (e) {
                console.warn('[QuranLens BG] Tier 2 fetch error:', e.message);
              }
            }

            // Tier 3: Content script fallback
            if (!newCaptions || newCaptions.length <= 10) {
              newCaptions = await fetchCaptionsViaContentScript(tabId, playerResponse, currentTickTimeSec);
            }
          }

          if (newCaptions && newCaptions.length > 0) {
            accumulatedText = deduplicateAndAppend(accumulatedText, newCaptions);
            if (!captionsFirstArrivedAt && accumulatedText.trim().length > 0) {
              captionsFirstArrivedAt = Date.now();
            }
          }

          if (getWordCount(accumulatedText) >= 6) {
            hasReceivedCaptions = true;
          }

          // ── Post-fetch match (sole writer of stability state) ──
          const wordCount = getWordCount(accumulatedText);
          if (accumulatedText && accumulatedText.trim().length > 0) {
            const matchResponse = await matchCaptions(accumulatedText, activeVideoDetails);
            if (matchResponse && matchResponse.type === 'MATCH_RESULT' && matchResponse.result) {
              const result = matchResponse.result;

              if (result.tied) {
                lastMatchWasTied = true;
                stabilityCount = 0;
                if (result.confidence > (bestResult?.confidence ?? 0)) {
                  bestResult = result;
                }
                console.log('[QuranLens BG] Tied candidates detected — suppressing early exit, continuing scan');
              } else {
                lastMatchWasTied = false;
                const currentKey = `${result.surah}:${result.ayah}`;

                if (currentKey === lastMatchKey) {
                  if (wordCount > lastMatchedTextLength) {
                    stabilityCount++;
                  }
                } else {
                  stabilityCount = 1;
                  lastMatchKey = currentKey;
                }

                if (result.confidence > (bestResult?.confidence ?? 0)) {
                  bestResult = result;
                }
                lastMatchedTextLength = wordCount;
              }
            }
          }

          // ── Heartbeat (signal-driven progress) ──
          await sendAnalyzingHeartbeat(tabId, hasReceivedCaptions, bestResult, false);

          // ── Optimisation 4: Tiered early-exit after post-fetch ──
          if (!lastMatchWasTied && shouldEarlyExit(stabilityCount, bestResult)) {
            console.log('[QuranLens BG] Early exit: stable match confirmed:', lastMatchKey, 'confidence:', bestResult.confidence);
            scanComplete = true;
            await sendAnalyzingHeartbeat(tabId, hasReceivedCaptions, bestResult, true);
            cleanup();
            resolve();
            return;
          }

          if (elapsed >= getEffectiveScanDuration()) {
            scanComplete = true;
            cleanup();
            resolve();
            return;
          }
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

    let finalResult = null;
    if (bestResult) {
      const stillTied = bestResult.tied === true && lastMatchWasTied === true;
      finalResult = {
        type: 'MATCH_RESULT',
        result: bestResult,
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

    await pushResult(tabId, finalResult);

    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => {
          window.dispatchEvent(new CustomEvent('quranlens-reset-buffer'));
        }
      });
    } catch (e) {
      console.warn('[QuranLens BG] Failed to dispatch reset buffer event:', e.message);
    }

  } catch (err) {
    cleanup();
    console.error('[QuranLens BG] Analyze error:', err);

    if (err.message && err.message.includes('Could not establish connection')) {
      await pushResult(tabId, {
        type: 'ERROR',
        message: 'Content script not ready. Please refresh the YouTube page and try again.'
      });
      return;
    }

    await pushResult(tabId, { type: 'ERROR', message: err.message || 'Failed to analyze video.' });
  }
}

// ─── Match Captions Against Corpus ──────────────────────────────────────────

async function matchCaptions(text, videoDetails) {
  let joinedText = '';
  if (Array.isArray(text)) {
    joinedText = text.filter(e => e && typeof e === 'string').join(' ').replace(/\s+/g, ' ').trim();
  } else if (typeof text === 'string') {
    if (text.startsWith('[')) {
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
          joinedText = parsed.filter(e => e && typeof e === 'string').join(' ').replace(/\s+/g, ' ').trim();
        } else {
          joinedText = text.trim();
        }
      } catch (_) {
        joinedText = text.trim();
      }
    } else {
      joinedText = text.trim();
    }
  }

  if (!joinedText || joinedText.length < 10) {
    return { type: 'NO_MATCH', message: 'Caption text too short for analysis.' };
  }

  try {
    const storageData = await chrome.storage.session.get('lastMatch');
    const lastMatch = storageData?.lastMatch || null;

    const surahHint = undefined;

    const result = await findVerse(joinedText, lastMatch, surahHint);

    if (result) {
      return {
        type: 'MATCH_RESULT',
        result: {
          ...result,
          url: getQuranUrl(result.surah, result.ayah),
          timestamp: Date.now()
        }
      };
    } else {
      return { type: 'NO_MATCH', message: 'No Quran recitation detected in the captions.' };
    }
  } catch (err) {
    console.error('[QuranLens BG] Matching error:', err);
    return { type: 'ERROR', message: 'Error matching verses: ' + err.message };
  }
}

// ─── Push Result to Content Script ──────────────────────────────────────────

async function pushResult(tabId, result) {
  try {
    await chrome.tabs.sendMessage(tabId, result);
  } catch (e) {
    console.warn('[QuranLens BG] Failed to push result to tab:', e);
  }
}

// ─── Tab URL Change Detection ───────────────────────────────────────────────

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    chrome.storage.session.remove('lastMatch').catch(() => {});
  }
  if (changeInfo.url && changeInfo.url.includes('youtube.com/watch')) {
    try {
      const newVideoId = new URL(changeInfo.url).searchParams.get('v');
      const oldVideoId = tabLastVideoId.get(tabId);
      if (oldVideoId) {
        captionUrlCache.delete(oldVideoId);
      }
      if (newVideoId) {
        captionUrlCache.delete(newVideoId);
        tabLastVideoId.set(tabId, newVideoId);
      }
    } catch (_) { /* ignore malformed URL */ }

    chrome.tabs.sendMessage(tabId, { type: 'VIDEO_CHANGED' }).catch(() => {});
  }
});

console.log('[QuranLens] Service worker initialized.');
