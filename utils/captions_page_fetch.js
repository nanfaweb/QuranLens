/**
 * QuranLens — In-page caption fetch (MAIN world only)
 *
 * Loaded via chrome.scripting.executeScript. YouTube timedtext URLs often
 * require a player-generated pot= token; direct baseUrl fetches return empty.
 */

(function () {
  if (typeof window.QuranLensFetchArabicCaptions === 'function') {
    return;
  }

  const LOG = '[QuranLens Page]';

  const consumedStartTimes = new Set();
  let lastBufferStartTimes = [];

  window.addEventListener('quranlens-reset-buffer', () => {
    console.log(LOG, 'Resetting caption buffer (marking current buffer events as consumed)', lastBufferStartTimes);
    for (const t of lastBufferStartTimes) {
      consumedStartTimes.add(t);
    }
    lastBufferStartTimes = [];
  });

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
    const eventTexts = [];
    const currentBufferStartTimes = [];

    console.log(LOG, 'parseJson3ToTranscript: currentTimeMs =', currentTimeMs, 'total events =', events.length);

    for (const event of events) {
      if (currentTimeMs !== undefined) {
        const start = event.tStartMs || 0;
        // FIX 3: reduced rolling buffer window from 10s to 6s
        const inWindow = (start >= currentTimeMs - 6000 && start <= currentTimeMs);
        if (!inWindow || consumedStartTimes.has(start)) {
          continue;
        }
        currentBufferStartTimes.push(start);
      }

      const eventSegs = [];
      if (event.segs && Array.isArray(event.segs)) {
        for (const seg of event.segs) {
          if (seg.utf8) eventSegs.push(seg.utf8);
        }
      } else if (event.utf8) {
        eventSegs.push(event.utf8);
      }
      const eventText = eventSegs.join('');
      if (eventText) {
        eventTexts.push(eventText.replace(/\n/g, ' ').trim());
      }
    }

    if (currentTimeMs !== undefined) {
      lastBufferStartTimes = currentBufferStartTimes;
      console.log(LOG, 'Matched events in window count:', currentBufferStartTimes.length, 'startTimes:', currentBufferStartTimes);
    }

    // Return all matched caption entries joined into a single string.
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

  window.QuranLensFetchArabicCaptions = async function (videoId, currentTimeMs) {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const player = document.getElementById('movie_player');

    if (!player?.getOption || !player?.setOption) {
      console.warn(LOG, 'movie_player or captions API unavailable');
      return null;
    }

    let track = null;
    for (let i = 0; i < 20; i++) {
      track = pickArabicTrack(getArabicTrackCandidates(player));
      if (track) break;
      await sleep(500);
    }
    if (!track) {
      console.warn(LOG, 'no Arabic caption track on player');
      return null;
    }

    console.log(LOG, 'selected track:', track.languageCode, track.displayName);

    const originalFetch = globalThis.fetch;
    const boundFetch = originalFetch?.bind(globalThis);
    const OriginalXHR = globalThis.XMLHttpRequest;
    let capturedJson3Text = '';
    let capturedUrl = '';

    try {
      if (boundFetch) {
        globalThis.fetch = async (...args) => {
          const response = await boundFetch(...args);
          try {
            const req = args[0];
            const reqUrl = typeof req === 'string' ? req : req?.url || '';
            if (isValidTimedtextUrl(reqUrl, track, videoId) && response?.ok) {
              if (!capturedUrl) capturedUrl = reqUrl;

              if (reqUrl.includes('fmt=json3')) {
                const text = await response.clone().text();
                if (text && !capturedJson3Text) capturedJson3Text = text;
              }
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

                if (!capturedUrl) capturedUrl = url;

                if (url.includes('fmt=json3')) {
                  const text = this.responseText || '';
                  if (text && !capturedJson3Text) capturedJson3Text = text;
                }
              } catch (_) { /* ignore */ }
            });
            return super.send(...args);
          }
        };
      }

      try { player.loadModule?.('captions'); } catch (_) { /* ignore */ }
      await sleep(500);
      try { player.setOption('captions', 'track', track); } catch (_) { /* ignore */ }

      for (let i = 0; i < 30; i++) {
        await sleep(500);

        if (capturedJson3Text) {
          const parsed = parseJson3ToTranscript(capturedJson3Text, currentTimeMs);
          if (parsed.transcript) {
            console.log(LOG, 'captured via fetch hook, length:', parsed.transcript.length);
            return { captions: parsed.transcript, signedUrl: capturedUrl || '' };
          }
        }

        const url = capturedUrl || findTimedtextUrl(track, videoId);
        if (url) {
          const parsed = await fetchTranscriptFromUrl(url, currentTimeMs);
          if (parsed.transcript) {
            console.log(LOG, 'fetched timedtext URL, length:', parsed.transcript.length);
            return { captions: parsed.transcript, signedUrl: capturedUrl || url || '' };
          }
          console.warn(LOG, 'timedtext URL fetch failed:', parsed.error);
        }
      }

      console.warn(LOG, 'timed out waiting for player timedtext');
      return null;
    } finally {
      if (originalFetch) globalThis.fetch = originalFetch;
      if (OriginalXHR) globalThis.XMLHttpRequest = OriginalXHR;
    }
  };
})();
