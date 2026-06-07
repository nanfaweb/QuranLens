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
    sendResponse({ type: 'ANALYZING', progress: 0 });

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
    console.log('[QuranLens BG] Attempting player-context caption fetch (pot token) for currentTime:', currentTime);

    if (!skipInjection) {
      // Chrome requires exactly one of 'files' or 'func' per executeScript call
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        files: ['utils/captions_page_fetch.js']
      });
    }

    const currentTimeMs = currentTime !== undefined ? currentTime * 1000 : undefined;

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

    const transcript = results?.[0]?.result;
    if (transcript && typeof transcript === 'string' && transcript.length > 10) {
      console.log('[QuranLens BG] Player-context captions OK, length:', transcript.length);
      return transcript;
    }

    console.log('[QuranLens BG] Player-context caption fetch did not return usable text');
    return null;
  } catch (e) {
    console.warn('[QuranLens BG] Player-context caption fetch failed:', e);
    return null;
  }
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
  let intervalId = null;
  const cleanup = () => {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
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
    const scanDuration = 10000;
    let accumulatedText = '';
    let bestResult = null;
    let stabilityCount = 0;
    let lastMatchKey = null;

    const startAnchorTimeMs = currentTime * 1000;
    let inTick = false;

    await new Promise((resolve) => {
      intervalId = setInterval(async () => {
        if (inTick) return;
        inTick = true;

        try {
          const elapsed = Date.now() - scanStartTime;
          const progress = Math.min(Math.round((elapsed / scanDuration) * 100), 99);

          try {
            await chrome.tabs.sendMessage(tabId, { type: 'ANALYZING', progress });
          } catch (e) {
            console.warn('[QuranLens BG] Heartbeat send failed:', e.message);
          }

          const currentTickTimeSec = (startAnchorTimeMs + elapsed) / 1000;
          let newCaptions = null;

          // Tier 1: Player context
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
            try {
              const response = await chrome.tabs.sendMessage(tabId, {
                type: 'FETCH_CAPTIONS',
                playerResponse: playerResponse,
                currentTime: currentTickTimeSec
              });
              if (response && response.type === 'CAPTIONS_RESULT' && response.text) {
                newCaptions = response.text;
              }
            } catch (e) {
              console.warn('[QuranLens BG] Tier 3 fetch error:', e.message);
            }
          }

          if (newCaptions && newCaptions.length > 0) {
            accumulatedText = deduplicateAndAppend(accumulatedText, newCaptions);
          }

          if (accumulatedText && accumulatedText.trim().length > 0) {
            const matchResponse = await matchCaptions(accumulatedText, activeVideoDetails);
            if (matchResponse && matchResponse.type === 'MATCH_RESULT' && matchResponse.result) {
              const result = matchResponse.result;
              const currentKey = `${result.surah}:${result.ayah}`;

              if (currentKey === lastMatchKey) {
                stabilityCount++;
              } else {
                stabilityCount = 1;
                lastMatchKey = currentKey;
              }

              if (result.confidence > (bestResult?.confidence ?? 0)) {
                bestResult = result;
              }
            }
          }

          if (stabilityCount >= 3 && bestResult && bestResult.confidence >= 0.82) {
            console.log('[QuranLens BG] Early exit: stable match confirmed:', lastMatchKey, 'confidence:', bestResult.confidence);
            cleanup();
            resolve();
            return;
          }

          if (elapsed >= scanDuration) {
            cleanup();
            resolve();
            return;
          }
        } catch (err) {
          console.error('[QuranLens BG] Error in polling loop tick:', err);
        } finally {
          inTick = false;
        }
      }, 800);
    });

    let finalResult = null;
    if (bestResult) {
      finalResult = {
        type: 'MATCH_RESULT',
        result: bestResult
      };
      await chrome.storage.session.set({ lastMatch: { surah: bestResult.surah, ayah: bestResult.ayah } });
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
    // New video — could notify content script to reset
    chrome.tabs.sendMessage(tabId, { type: 'VIDEO_CHANGED' }).catch(() => {});
  }
});

console.log('[QuranLens] Service worker initialized.');
