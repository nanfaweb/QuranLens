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

    // Send immediate acknowledgment to prevent channel timeout
    sendResponse({ type: 'ANALYZING' });

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
 * @returns {Promise<string|null>}
 */
async function fetchArabicCaptionsViaPlayer(tabId, videoId, currentTime) {
  try {
    console.log('[QuranLens BG] Attempting player-context caption fetch (pot token) for currentTime:', currentTime);

    // Chrome requires exactly one of 'files' or 'func' per executeScript call
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      files: ['utils/captions_page_fetch.js']
    });

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

// ─── Handler: Analyze Video ─────────────────────────────────────────────────

async function handleAnalyzeVideo(tabId, tab, currentTime, videoDetails) {
  try {
    if (!tab || !tab.url || !tab.url.includes('youtube.com/watch')) {
      await pushResult(tabId, { type: 'ERROR', message: 'Please open a YouTube video first.' });
      return;
    }

    const urlObj = new URL(tab.url);
    const videoId = urlObj.searchParams.get('v');

    let activeVideoDetails = videoDetails || null;

    // Primary path: player-generated timedtext URL with pot= (fixes empty JSON body)
    if (videoId) {
      const playerCaptions = await fetchArabicCaptionsViaPlayer(tabId, videoId, currentTime);
      if (playerCaptions && playerCaptions.length > 10) {
        const result = await matchCaptions(playerCaptions, activeVideoDetails);
        await pushResult(tabId, result);
        return;
      }
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

    // Secondary path: service worker direct fetch (works when pot= not required)
    if (playerResponse) {
      console.log('[QuranLens BG] Attempting service-worker caption fetch...');
      const bgCaptions = await fetchArabicCaptions(playerResponse, currentTime);
      if (bgCaptions && bgCaptions.length > 10) {
        console.log('[QuranLens BG] Captions retrieved in service worker, running match');
        const result = await matchCaptions(bgCaptions, activeVideoDetails);
        await pushResult(tabId, result);
        return;
      }
      console.log('[QuranLens BG] Service-worker caption fetch did not yield usable text, falling back to content script');
    } else {
      console.log('[QuranLens BG] No playerResponse — falling back to content script');
    }

    // Fallback: content script (page context) caption extraction
    try {
      const response = await chrome.tabs.sendMessage(tabId, { 
        type: 'FETCH_CAPTIONS',
        playerResponse: playerResponse,
        currentTime: currentTime
      });

      if (response && response.type === 'CAPTIONS_RESULT' && response.text) {
        const result = await matchCaptions(response.text, activeVideoDetails);
        await pushResult(tabId, result);
        return;
      }
    } catch (e) {
      console.warn('[QuranLens BG] Content script caption fetch failed:', e);
    }

    // All caption paths failed — send the specific no-captions message
    await pushResult(tabId, {
      type: 'NO_CAPTIONS',
      message: 'No Arabic captions found for this video. Try a video from a channel that provides Arabic subtitles.'
    });

  } catch (err) {
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
  if (!text || text.length < 10) {
    return { type: 'NO_MATCH', message: 'Caption text too short for analysis.' };
  }

  try {
    const storageData = await chrome.storage.session.get('lastMatch');
    const lastMatch = storageData?.lastMatch || null;
    const surahHint = detectSurahHint(videoDetails);

    const result = await findVerse(text, lastMatch, surahHint);

    if (result) {
      await chrome.storage.session.set({ lastMatch: { surah: result.surah, ayah: result.ayah } });
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
