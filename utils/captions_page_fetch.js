/**
 * QuranLens — In-page caption fetch (MAIN world only)
 *
 * Loaded via chrome.scripting.executeScript. YouTube timedtext URLs often
 * require a player-generated pot= token; direct baseUrl fetches return empty.
 *
 * Timing model (must stay aligned with utils/captions.js):
 *   - Caption window: 15s lookback / 8s lookahead around playhead
 *   - Nearest-event fallback: up to 8 events within 45s of playhead
 *   - Track discovery wait: 20 × 300ms on first attempt per video
 */

(function () {
  const LOG = '[QuranLens Page]';

  const CAPTION_LOOKBACK_MS = 15000;
  const CAPTION_LOOKAHEAD_MS = 8000;
  const FALLBACK_MAX_DISTANCE_MS = 45000;
  const FALLBACK_MAX_EVENTS = 8;

  /** @type {Map<string, 'no_arabic_track'>} */
  const videoCaptionStatus = new Map();

  if (!window.__quranLensCaptionListeners) {
    window.__quranLensCaptionListeners = true;

    window.addEventListener('quranlens-video-changed', () => {
      videoCaptionStatus.clear();
      console.log(LOG, 'Video changed — caption status cache cleared');
    });
  }

  if (typeof window.QuranLensFetchArabicCaptions === 'function') {
    return;
  }

  function parseJson3ToTranscript(text, currentTimeMs) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return { error: 'invalid JSON: ' + e.message };
    }
    const events = data?.events;
    if (!Array.isArray(events) || events.length === 0) {
      return { error: 'no events in JSON3' };
    }

    function extractEventText(event) {
      const eventSegs = [];
      if (event.segs && Array.isArray(event.segs)) {
        for (const seg of event.segs) {
          if (seg.utf8) eventSegs.push(seg.utf8);
        }
      } else if (event.utf8) {
        eventSegs.push(event.utf8);
      }
      return eventSegs.join('').replace(/\n/g, ' ').trim();
    }

    function eventOverlapsWindow(event, timeMs) {
      const start = event.tStartMs || 0;
      const duration = event.dDurationMs || 3000;
      const end = start + duration;
      const windowStart = timeMs - CAPTION_LOOKBACK_MS;
      const windowEnd = timeMs + CAPTION_LOOKAHEAD_MS;
      return end >= windowStart && start <= windowEnd;
    }

    console.log(LOG, 'parseJson3ToTranscript: currentTimeMs =', currentTimeMs, 'total events =', events.length);

    let eventTexts = [];
    for (const event of events) {
      if (currentTimeMs !== undefined && !eventOverlapsWindow(event, currentTimeMs)) continue;
      const eventText = extractEventText(event);
      if (eventText) eventTexts.push(eventText);
    }

    // Fallback: auto-generated captions often lag — nearest events within distance cap
    if (eventTexts.length === 0 && currentTimeMs !== undefined) {
      const ranked = events
        .map(event => {
          const start = event.tStartMs || 0;
          const text = extractEventText(event);
          if (!text) return null;
          const distance = Math.abs(start - currentTimeMs);
          if (distance > FALLBACK_MAX_DISTANCE_MS) return null;
          return { text, distance };
        })
        .filter(Boolean)
        .sort((a, b) => a.distance - b.distance)
        .slice(0, FALLBACK_MAX_EVENTS);

      eventTexts = ranked.map(r => r.text);
      console.log(LOG, 'parseJson3ToTranscript: nearest-event fallback, count:', eventTexts.length);
    }

    const transcript = eventTexts.join(' ').replace(/\s+/g, ' ').trim();
    if (!transcript) return { error: 'no text in JSON3 events' };
    return { transcript };
  }

  function captionTrackToPlayerTrack(track) {
    if (!track?.languageCode) return null;
    const name = track.name?.simpleText
      || (Array.isArray(track.name?.runs)
        ? track.name.runs.map(r => r?.text || '').join('')
        : '')
      || track.languageCode;
    return {
      displayName: name,
      languageCode: track.languageCode,
      kind: track.kind || '',
      vss_id: track.vssId || ((track.kind === 'asr' ? 'a.' : '.') + track.languageCode)
    };
  }

  function getArabicTrackCandidates(player) {
    const tracklist = player?.getOption?.('captions', 'tracklist');
    if (Array.isArray(tracklist) && tracklist.length > 0) {
      return tracklist.filter(t =>
        t.languageCode === 'ar' ||
        t.languageCode === 'ar-SA' ||
        (t.languageCode || '').startsWith('ar')
      );
    }
    const captionTracks = player?.getPlayerResponse?.()
      ?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!Array.isArray(captionTracks)) return [];
    return captionTracks
      .filter(t =>
        t.languageCode === 'ar' ||
        t.languageCode === 'ar-SA' ||
        (t.languageCode || '').startsWith('ar') ||
        (t.name?.simpleText || '').includes('Arabic')
      )
      .map(captionTrackToPlayerTrack)
      .filter(Boolean);
  }

  function pickArabicTrack(tracks) {
    if (!tracks?.length) return null;
    return tracks.find(t => t.languageCode === 'ar') ||
      tracks.find(t => t.languageCode === 'ar-SA') ||
      tracks[0];
  }

  function timedtextMatchesVideo(url, videoId) {
    if (!videoId) return true;
    try {
      return new URL(url, location.origin).searchParams.get('v') === videoId;
    } catch {
      return false;
    }
  }

  function isValidTimedtextUrl(url, track, videoId) {
    if (!url || typeof url !== 'string') return false;
    if (!url.includes('/api/timedtext')) return false;
    if (!timedtextMatchesVideo(url, videoId)) return false;
    if (!track?.languageCode) return true;
    try {
      const got = new URL(url, location.origin).searchParams.get('lang') || '';
      const wanted = track.languageCode;
      return got === wanted || got.split('-')[0] === wanted.split('-')[0];
    } catch {
      return false;
    }
  }

  function findTimedtextUrl(track, videoId) {
    const urls = performance.getEntriesByType('resource')
      .map(e => e.name)
      .filter(url => isValidTimedtextUrl(url, track, videoId));
    return urls.length ? urls[urls.length - 1] : '';
  }

  function buildJson3CaptionUrl(baseUrl) {
    try {
      const url = new URL(baseUrl, location.origin);
      url.searchParams.delete('fmt');
      url.searchParams.set('fmt', 'json3');
      return url.toString();
    } catch {
      return baseUrl;
    }
  }

  async function fetchTranscriptFromUrl(url, currentTimeMs) {
    const json3Url = buildJson3CaptionUrl(url);
    const resp = await fetch(json3Url, { credentials: 'include' });
    if (!resp.ok) {
      return { error: 'HTTP ' + resp.status };
    }
    const text = await resp.text();
    if (!text || !text.trim()) {
      return { error: 'empty body' };
    }
    return parseJson3ToTranscript(text, currentTimeMs);
  }

  function getLiveVideoTimeMs() {
    const video = document.querySelector('video');
    if (video && Number.isFinite(video.currentTime)) {
      return Math.round(video.currentTime * 1000);
    }
    return undefined;
  }

  window.QuranLensFetchArabicCaptions = async function (videoId, currentTimeMs) {
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    if (videoId && videoCaptionStatus.get(videoId) === 'no_arabic_track') {
      return { error: 'no_arabic_track', cached: true };
    }

    const player = document.getElementById('movie_player');
    if (!player?.getOption || !player?.setOption) {
      console.warn(LOG, 'movie_player or captions API unavailable');
      return { error: 'player_unavailable' };
    }

    const liveTimeMs = getLiveVideoTimeMs();
    const effectiveTimeMs = liveTimeMs ?? currentTimeMs;

    let track = null;
    for (let i = 0; i < 20; i++) {
      track = pickArabicTrack(getArabicTrackCandidates(player));
      if (track) break;
      await sleep(300);
    }
    if (!track) {
      console.warn(LOG, 'no Arabic caption track on player');
      if (videoId) videoCaptionStatus.set(videoId, 'no_arabic_track');
      return { error: 'no_arabic_track' };
    }

    console.log(LOG, 'selected track:', track.languageCode, track.displayName, 'effectiveTimeMs:', effectiveTimeMs);

    const originalFetch = globalThis.fetch;
    const boundFetch = originalFetch?.bind(globalThis);
    const OriginalXHR = globalThis.XMLHttpRequest;
    let capturedJson3Text = '';
    let capturedUrl = '';

    function captureTimedtextResponse(url, bodyText) {
      if (!bodyText || !bodyText.trim()) return;
      if (!capturedUrl) capturedUrl = url;
      const trimmed = bodyText.trim();
      if (trimmed.startsWith('{') && !capturedJson3Text) {
        capturedJson3Text = trimmed;
      }
    }

    try {
      if (boundFetch) {
        globalThis.fetch = async (...args) => {
          const response = await boundFetch(...args);
          try {
            const req = args[0];
            const reqUrl = typeof req === 'string' ? req : req?.url || '';
            if (isValidTimedtextUrl(reqUrl, track, videoId) && response?.ok) {
              const text = await response.clone().text();
              captureTimedtextResponse(reqUrl, text);
            }
          } catch (_) { /* ignore */ }
          return response;
        };
      }

      if (OriginalXHR) {
        globalThis.XMLHttpRequest = class extends OriginalXHR {
          open(method, url, ...rest) {
            this._qlTimedtextUrl = typeof url === 'string' ? url : '';
            return super.open(method, url, ...rest);
          }
          send(...args) {
            this.addEventListener('load', () => {
              try {
                const url = this._qlTimedtextUrl || this.responseURL || '';
                if (!isValidTimedtextUrl(url, track, videoId)) return;
                if (this.status < 200 || this.status >= 300) return;
                captureTimedtextResponse(url, this.responseText || '');
              } catch (_) { /* ignore */ }
            });
            return super.send(...args);
          }
        };
      }

      try { player.loadModule?.('captions'); } catch (_) { /* ignore */ }
      await sleep(300);

      try { player.setOption('captions', 'track', null); } catch (_) { /* ignore */ }
      await sleep(150);
      try { player.setOption('captions', 'track', track); } catch (_) { /* ignore */ }
      try { player.setOption('captions', 'reload', true); } catch (_) { /* ignore */ }

      const maxAttempts = 12;
      for (let i = 0; i < maxAttempts; i++) {
        await sleep(300);

        if (capturedJson3Text) {
          const parsed = parseJson3ToTranscript(capturedJson3Text, effectiveTimeMs);
          if (parsed.transcript) {
            console.log(LOG, 'captured via network hook, length:', parsed.transcript.length);
            return { captions: parsed.transcript, signedUrl: capturedUrl || '' };
          }
        }

        const url = capturedUrl || findTimedtextUrl(track, videoId);
        if (url) {
          const parsed = await fetchTranscriptFromUrl(url, effectiveTimeMs);
          if (parsed.transcript) {
            console.log(LOG, 'fetched timedtext URL, length:', parsed.transcript.length);
            return { captions: parsed.transcript, signedUrl: capturedUrl || url || '' };
          }
        }
      }

      console.warn(LOG, 'timed out waiting for player timedtext', { hadUrl: !!capturedUrl, effectiveTimeMs });
      return { error: 'timed_out', hadUrl: !!capturedUrl };
    } finally {
      if (originalFetch) globalThis.fetch = originalFetch;
      if (OriginalXHR) globalThis.XMLHttpRequest = OriginalXHR;
    }
  };
})();
