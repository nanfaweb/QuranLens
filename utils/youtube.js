/**
 * QuranLens — YouTube Helpers
 * 
 * Extracts Arabic captions and video metadata from YouTube pages.
 * Runs in the content script context (has access to page DOM).
 * Caption fetch uses JSON3 via utils/captions.js (content-script fallback path).
 */

const CS_LOG = '[QuranLens CS]';

/**
 * Wait for ytInitialPlayerResponse to become available.
 * YouTube's SPF navigation may delay its availability.
 * 
 * @param {number} maxRetries — max attempts
 * @param {number} delayMs — ms between retries
 * @returns {Promise<Object|null>}
 */
async function waitForPlayerResponse(maxRetries = 5, delayMs = 500) {
  for (let i = 0; i < maxRetries; i++) {
    if (window.ytInitialPlayerResponse) {
      console.log(`${CS_LOG} playerResponse from ytInitialPlayerResponse (attempt ${i + 1})`);
      return window.ytInitialPlayerResponse;
    }

    if (window.ytplayer && window.ytplayer.config && window.ytplayer.config.args) {
      try {
        const raw = window.ytplayer.config.args.raw_player_response;
        if (raw) {
          console.log(`${CS_LOG} playerResponse from ytplayer.config (attempt ${i + 1})`);
          return raw;
        }
      } catch (e) { /* ignore */ }
    }

    try {
      const scripts = document.querySelectorAll('script');
      for (const script of scripts) {
        const text = script.textContent;
        if (text && text.includes('ytInitialPlayerResponse')) {
          const match = text.match(/ytInitialPlayerResponse\s*=\s*({.+?});/s);
          if (match) {
            console.log(`${CS_LOG} playerResponse parsed from inline script (attempt ${i + 1})`);
            return JSON.parse(match[1]);
          }
        }
      }
    } catch (e) { /* ignore parsing errors */ }

    if (i < maxRetries - 1) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  console.warn(`${CS_LOG} playerResponse unavailable after ${maxRetries} attempts`);
  return null;
}

/**
 * Get Arabic captions for a YouTube video (content-script fallback).
 * Uses JSON3 format; may be blocked by Brave Shields in this context.
 * 
 * @param {string} videoId 
 * @param {Object|null} passedPlayerResponse
 * @returns {Promise<string|null>} — full transcript text, or null
 */
async function getYouTubeCaptions(videoId, passedPlayerResponse, currentTime) {
  try {
    console.log(`${CS_LOG} getYouTubeCaptions start, videoId:`, videoId, "currentTime:", currentTime);

    const playerResponse = passedPlayerResponse || await waitForPlayerResponse();
    if (!playerResponse) {
      console.warn(`${CS_LOG} getYouTubeCaptions: no playerResponse`);
      return null;
    }

    const track = findArabicCaptionTrack(playerResponse);
    if (!track) {
      console.warn(`${CS_LOG} getYouTubeCaptions: no Arabic caption track`);
      return null;
    }

    console.log(`${CS_LOG} getYouTubeCaptions: Arabic track`, track.languageCode);

    if (captionUrlNeedsPot(track.baseUrl)) {
      console.warn(`${CS_LOG} getYouTubeCaptions: track requires pot= (exp=xpe); content-script direct fetch skipped`);
      return null;
    }

    const currentTimeMs = currentTime !== undefined ? currentTime * 1000 : undefined;
    const transcript = await fetchJson3Captions(track.baseUrl, CS_LOG, { credentials: 'include' }, currentTimeMs);
    if (!transcript) {
      console.warn(`${CS_LOG} getYouTubeCaptions: JSON3 fetch/parse returned empty`);
      return null;
    }

    console.log(`${CS_LOG} getYouTubeCaptions success, length:`, transcript.length);
    return transcript;

  } catch (err) {
    console.error(`${CS_LOG} getYouTubeCaptions error:`, err);
    return null;
  }
}

/**
 * Extract video metadata from the current YouTube page.
 * 
 * @returns {Promise<Object|null>} — { title, channelName, videoId }
 */
async function getVideoMetadata(passedPlayerResponse) {
  try {
    const playerResponse = passedPlayerResponse || await waitForPlayerResponse();

    const urlParams = new URLSearchParams(window.location.search);
    const videoIdFromUrl = urlParams.get('v');

    if (!playerResponse) {
      if (videoIdFromUrl) {
        console.log(`${CS_LOG} getVideoMetadata: URL-only fallback, videoId:`, videoIdFromUrl);
        return {
          title: document.title || '',
          channelName: '',
          videoId: videoIdFromUrl
        };
      }
      console.warn(`${CS_LOG} getVideoMetadata: no playerResponse and no videoId in URL`);
      return null;
    }

    const videoDetails = playerResponse.videoDetails || {};

    const meta = {
      title: videoDetails.title || document.title || '',
      channelName: videoDetails.author || '',
      videoId: videoDetails.videoId || videoIdFromUrl || ''
    };
    console.log(`${CS_LOG} getVideoMetadata:`, meta.videoId, meta.title);
    return meta;
  } catch (err) {
    console.error(`${CS_LOG} getVideoMetadata error:`, err);

    const urlParams = new URLSearchParams(window.location.search);
    const videoId = urlParams.get('v');
    return videoId ? { title: document.title, channelName: '', videoId } : null;
  }
}
