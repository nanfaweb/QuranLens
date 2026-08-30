/**
 * QuranLens — In-page caption fetch (MAIN world only)
 *
 * Loaded via chrome.scripting.executeScript. YouTube timedtext URLs often
 * require a player-generated pot= token; direct baseUrl fetches return empty.
 */

(function () {
  const LOG = '[QuranLens Page]';

  const consumedStartTimes = new Set();
  let lastBufferStartTimes = [];

  function clearCaptionBuffer() {
    consumedStartTimes.clear();
    lastBufferStartTimes = [];
    console.log(LOG, 'Caption buffer fully cleared');
  }

  // Always register lifecycle listeners (survives re-injection guard below)
  if (!window.__quranLensCaptionListeners) {
    window.__quranLensCaptionListeners = true;

    window.addEventListener('quranlens-video-changed', () => {
      clearCaptionBuffer();
    });

    window.addEventListener('quranlens-analysis-start', () => {
      clearCaptionBuffer();
    });

    window.addEventListener('quranlens-reset-buffer', () => {
      console.log(LOG, 'Resetting caption buffer (marking current buffer events as consumed)', lastBufferStartTimes);
      for (const t of lastBufferStartTimes) {
        consumedStartTimes.add(t);
      }
      lastBufferStartTimes = [];
    });
  }

  if (typeof window.QuranLensFetchArabicCaptions === 'function') {
    return;
  }

  function parseJson3ToTranscript(text, currentTimeMs, options = {}) {
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

    const lookbackMs = options.lookbackMs ?? 15000;
    const lookaheadMs = options.lookaheadMs ?? 8000;
    const skipConsumed = options.skipConsumed !== false;

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
      const windowStart = timeMs - lookbackMs;
      const windowEnd = timeMs + lookaheadMs;
      return end >= windowStart && start <= windowEnd;
    }

    function collectEvents(filterFn) {
      const eventTexts = [];
      const currentBufferStartTimes = [];

      for (const event of events) {
        const start = event.tStartMs || 0;
        if (skipConsumed && consumedStartTimes.has(start)) continue;

        const eventText = extractEventText(event);
        if (!eventText) continue;

        if (currentTimeMs === undefined || filterFn(event, currentTimeMs)) {
          eventTexts.push(eventText);
          if (currentTimeMs !== undefined) currentBufferStartTimes.push(start);
        }
      }

      return { eventTexts, currentBufferStartTimes };
    }

    console.log(LOG, 'parseJson3ToTranscript: currentTimeMs =', currentTimeMs, 'total events =', events.length);

    let { eventTexts, currentBufferStartTimes } = collectEvents(eventOverlapsWindow);

    // Fallback: auto-generated captions often lag — take nearest events to playback time
    if (eventTexts.length === 0 && currentTimeMs !== undefined) {
      const ranked = events
        .map(event => {
          const start = event.tStartMs || 0;
          const text = extractEventText(event);
          if (!text || (skipConsumed && consumedStartTimes.has(start))) return null;
          return { start, text, distance: Math.abs(start - currentTimeMs) };
        })
        .filter(Boolean)
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 8);

      eventTexts = ranked.map(r => r.text);
      currentBufferStartTimes = ranked.map(r => r.start);
      console.log(LOG, 'parseJson3ToTranscript: using nearest-event fallback, count:', eventTexts.length);
    }

    if (currentTimeMs !== undefined) {
      lastBufferStartTimes = currentBufferStartTimes;
      console.log(LOG, 'Matched events count:', currentBufferStartTimes.length, 'startTimes:', currentBufferStartTimes);
    }

    const transcript = eventTexts.join(' ').replace(/\s+/g, ' ').trim();
    console.log(LOG, 'Final joined transcript:', transcript);
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
    console.log(LOG, 'Fetching timedtext URL as json3:', json3Url);
    const resp = await fetch(json3Url, { credentials: 'include' });
    if (!resp.ok) {
      return { error: 'HTTP ' + resp.status };
    }
    const text = await resp.text();
    if (!text || !text.trim()) {
      return { error: 'empty body (length ' + text.length + ')' };
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
    const player = document.getElementById('movie_player');

    if (!player?.getOption || !player?.setOption) {
      console.warn(LOG, 'movie_player or captions API unavailable');
      return { error: 'player_unavailable' };
    }

    // Prefer live playback time — background anchor time can drift during long fetches
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

      // Toggle track to force a fresh timedtext request with pot= token
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
          console.warn(LOG, 'captured JSON3 but parse failed:', parsed.error);
        }

        const url = capturedUrl || findTimedtextUrl(track, videoId);
        if (url) {
          const parsed = await fetchTranscriptFromUrl(url, effectiveTimeMs);
          if (parsed.transcript) {
            console.log(LOG, 'fetched timedtext URL, length:', parsed.transcript.length);
            return { captions: parsed.transcript, signedUrl: capturedUrl || url || '' };
          }
          if (parsed.error) {
            console.warn(LOG, 'timedtext URL fetch failed:', parsed.error);
          }
        }
      }

      console.warn(LOG, 'timed out waiting for player timedtext', {
        hadUrl: !!capturedUrl,
        hadJson: !!capturedJson3Text,
        effectiveTimeMs
      });
      return { error: 'timed_out', hadUrl: !!capturedUrl, hadJson: !!capturedJson3Text };
    } finally {
      if (originalFetch) globalThis.fetch = originalFetch;
      if (OriginalXHR) globalThis.XMLHttpRequest = OriginalXHR;
    }
  };
})();
