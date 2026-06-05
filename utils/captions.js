/**
 * QuranLens — YouTube Caption Helpers (JSON3)
 *
 * Shared by the background service worker and content-script fallback.
 * Uses fmt=json3 timedtext format (no XML / DOMParser).
 */

/**
 * Find the Arabic caption track in a YouTube player response.
 * @param {Object} playerResponse
 * @returns {Object|null}
 */
function findArabicCaptionTrack(playerResponse) {
  const captions = playerResponse?.captions;
  if (!captions?.playerCaptionsTracklistRenderer) {
    return null;
  }

  const tracks = captions.playerCaptionsTracklistRenderer.captionTracks;
  if (!tracks || tracks.length === 0) {
    return null;
  }

  let arabicTrack = tracks.find(t => t.languageCode === 'ar');
  if (!arabicTrack) {
    arabicTrack = tracks.find(t => t.languageCode === 'ar-SA');
  }
  if (!arabicTrack) {
    arabicTrack = tracks.find(t =>
      (t.name && (t.name.simpleText || '').includes('Arabic')) ||
      (t.languageCode || '').startsWith('ar')
    );
  }

  if (!arabicTrack?.baseUrl) {
    return null;
  }

  return arabicTrack;
}

/**
 * Append fmt=json3 to a YouTube timedtext base URL.
 * @param {string} baseUrl
 * @returns {string}
 */
function buildJson3CaptionUrl(baseUrl) {
  const url = new URL(baseUrl);
  // Strip existing fmt (e.g. srv3) — duplicate fmt params break JSON3 responses
  url.searchParams.delete('fmt');
  url.searchParams.set('fmt', 'json3');
  return url.toString();
}

/**
 * Whether the track URL likely needs a player-generated pot= token.
 * @param {string} baseUrl
 * @returns {boolean}
 */
function captionUrlNeedsPot(baseUrl) {
  return typeof baseUrl === 'string' && baseUrl.includes('exp=xpe');
}

/**
 * Extract subtitle text from a YouTube JSON3 caption payload.
 * @param {Object} data — parsed JSON3 response
 * @param {number} [currentTimeMs] — target playback time in milliseconds
 * @returns {string|null}
 */
function parseJson3CaptionData(data, currentTimeMs) {
  const events = data?.events;
  if (!events || !Array.isArray(events) || events.length === 0) {
    return null;
  }

  const eventTexts = [];
  const windowRadiusMs = 3 * 1000; // ±2.5 second window (5 seconds total)

  for (const event of events) {
    if (currentTimeMs !== undefined) {
      const start = event.tStartMs || 0;
      const duration = event.dDurationMs || 0;
      const end = start + duration;

      const windowStart = currentTimeMs - windowRadiusMs;
      const windowEnd = currentTimeMs + windowRadiusMs;

      // Check overlap
      const overlaps = (start <= windowEnd && end >= windowStart);
      if (!overlaps) {
        continue;
      }
    }

    const eventSegs = [];
    if (event.segs && Array.isArray(event.segs)) {
      for (const seg of event.segs) {
        if (seg.utf8) {
          eventSegs.push(seg.utf8);
        }
      }
    } else if (event.utf8) {
      eventSegs.push(event.utf8);
    }

    const eventText = eventSegs.join('');
    if (eventText) {
      eventTexts.push(eventText.replace(/\n/g, ' ').trim());
    }
  }

  const fullTranscript = eventTexts.join(' ').replace(/\s+/g, ' ').trim();
  return fullTranscript.length > 0 ? fullTranscript : null;
}

/**
 * Fetch and parse a caption track URL as JSON3.
 * @param {string} trackBaseUrl
 * @param {string} [logPrefix='[QuranLens]']
 * @param {Object} [fetchOptions={}]
 * @param {number} [currentTimeMs] — target playback time in milliseconds
 * @returns {Promise<string|null>}
 */
async function fetchJson3Captions(trackBaseUrl, logPrefix = '[QuranLens]', fetchOptions = {}, currentTimeMs = undefined) {
  if (captionUrlNeedsPot(trackBaseUrl)) {
    console.log(`${logPrefix} baseUrl has exp=xpe — needs player pot= (skip direct SW fetch)`);
    return null;
  }

  const captionUrl = buildJson3CaptionUrl(trackBaseUrl);
  console.log(`${logPrefix} Fetching JSON3 captions:`, captionUrl);

  const response = await fetch(captionUrl, {
    credentials: 'omit',
    ...fetchOptions
  });
  if (!response.ok) {
    console.warn(`${logPrefix} Caption fetch failed: HTTP ${response.status}`);
    return null;
  }

  const rawText = await response.text();
  if (!rawText || !rawText.trim()) {
    console.warn(`${logPrefix} Caption response empty (HTTP ${response.status}, may need pot= token)`);
    return null;
  }

  let data;
  try {
    data = JSON.parse(rawText);
  } catch (e) {
    console.warn(`${logPrefix} Caption response is not valid JSON (${rawText.length} bytes):`, e.message);
    return null;
  }

  const transcript = parseJson3CaptionData(data, currentTimeMs);
  if (!transcript) {
    console.warn(`${logPrefix} JSON3 caption data contained no text events`);
    return null;
  }

  console.log(`${logPrefix} Captions parsed successfully, length:`, transcript.length);
  return transcript;
}

/**
 * Fetch Arabic captions from a player response (track discovery + JSON3 fetch).
 * @param {Object} playerResponse
 * @param {string} [logPrefix='[QuranLens BG]']
 * @param {number} [currentTimeMs] — target playback time in milliseconds
 * @returns {Promise<string|null>}
 */
async function fetchArabicCaptionsFromPlayerResponse(playerResponse, logPrefix = '[QuranLens BG]', currentTimeMs = undefined) {
  if (!playerResponse) {
    console.log(`${logPrefix} No playerResponse provided`);
    return null;
  }

  const track = findArabicCaptionTrack(playerResponse);
  if (!track) {
    console.log(`${logPrefix} No Arabic caption track in playerResponse`);
    return null;
  }

  console.log(`${logPrefix} Found Arabic track:`, track.languageCode, track.name?.simpleText || '');

  try {
    return await fetchJson3Captions(track.baseUrl, logPrefix, {}, currentTimeMs);
  } catch (err) {
    console.error(`${logPrefix} Caption fetch error:`, err);
    return null;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    findArabicCaptionTrack,
    buildJson3CaptionUrl,
    captionUrlNeedsPot,
    parseJson3CaptionData,
    fetchJson3Captions,
    fetchArabicCaptionsFromPlayerResponse
  };
}
