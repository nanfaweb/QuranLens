/**
 * QuranLens — Content Script + In-Page Overlay
 * 
 * Injected into every youtube.com/watch page.
 * Responsibilities:
 *  - Render a floating overlay panel directly on the YouTube page
 *  - Handle TOGGLE_OVERLAY, FETCH_CAPTIONS, and result messages from background
 *  - Manage UI state: idle, loading, result, no-match, no-captions, error
 *  - No external API calls — all display data comes from local corpus
 */

// ─── Prevent Double-Injection ───────────────────────────────────────────────

if (window.__quranLensInjected) {
  // Already injected — just listen for messages
} else {
  window.__quranLensInjected = true;
  initQuranLens();
}

function initQuranLens() {
  const QL_LOG = '[QuranLens]';
  let overlayRoot = null;
  let shadowRoot = null;
  let currentState = 'idle';
  let currentResult = null;
  let isVisible = false;

  // ─── Overlay Injection ──────────────────────────────────────────────────

  function createOverlay() {
    if (overlayRoot) return;

    overlayRoot = document.createElement('div');
    overlayRoot.id = 'quranlens-overlay-host';
    shadowRoot = overlayRoot.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = getOverlayCSS();
    shadowRoot.appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'ql-panel';
    panel.className = 'ql-panel ql-hidden';
    panel.innerHTML = getOverlayHTML();
    shadowRoot.appendChild(panel);

    document.body.appendChild(overlayRoot);

    // Bind events
    bindEvents(panel);

    // Load and apply overlay position
    loadOverlayPosition();

    console.log(`${QL_LOG} Overlay injected`);
  }

  function loadOverlayPosition() {
    chrome.storage.local.get('ql_overlay_pos', (data) => {
      const pos = data?.ql_overlay_pos;
      const overlayWidth = 360;
      const defaultLeft = window.innerWidth - overlayWidth - 20;
      const defaultTop = 80;

      let left = defaultLeft;
      let top = defaultTop;

      if (pos && typeof pos.top === 'number' && typeof pos.left === 'number') {
        left = pos.left;
        top = pos.top;
      }

      if (overlayRoot) {
        overlayRoot.style.left = `${left}px`;
        overlayRoot.style.top = `${top}px`;
      }
    });
  }

  function getOverlayCSS() {
    return `
      @import url('https://fonts.googleapis.com/css2?family=Amiri:wght@400;700&family=Inter:wght@300;400;500;600;700&display=swap');

      :host {
        all: initial;
        position: fixed;
        z-index: 2147483647;
        pointer-events: none;
      }

      /* ─── Design Tokens ──────────────────────────────────────────── */
      .ql-panel {
        --emerald-900: #064e3b;
        --emerald-800: #065f46;
        --emerald-700: #047857;
        --emerald-600: #059669;
        --emerald-500: #10b981;
        --emerald-400: #34d399;
        --emerald-300: #6ee7b7;
        --gold-400: #fbbf24;
        --gold-300: #fcd34d;
        --cream-50: #fefdf8;
        --cream-100: #fdf6e3;
        --cream-200: #f5e6c8;
        --dark-950: #0a0f0d;
        --dark-900: #0f1a15;
        --dark-800: #162419;
        --dark-700: #1e3324;
        --dark-600: #27402e;
        --red-400: #f87171;
        --red-500: #ef4444;
        --amber-400: #fbbf24;
        --amber-500: #f59e0b;
        --font-arabic: 'Amiri', serif;
        --font-ui: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
        --radius-sm: 8px;
        --radius-md: 12px;
        --radius-lg: 16px;
        --radius-full: 9999px;

        position: absolute;
        top: 0;
        left: 0;
        width: 360px;
        max-height: calc(100vh - 120px);
        overflow-y: auto;
        overflow-x: hidden;
        font-family: var(--font-ui);
        background: rgba(15, 26, 21, 0.92);
        backdrop-filter: blur(24px) saturate(180%);
        -webkit-backdrop-filter: blur(24px) saturate(180%);
        border: 1px solid rgba(16, 185, 129, 0.15);
        border-radius: var(--radius-lg);
        box-shadow:
          0 8px 40px rgba(0, 0, 0, 0.5),
          0 0 0 1px rgba(16, 185, 129, 0.05),
          inset 0 1px 0 rgba(255, 255, 255, 0.03);
        color: var(--cream-50);
        -webkit-font-smoothing: antialiased;
        pointer-events: auto;
        transform: translateX(0);
        opacity: 1;
        transition: transform 0.35s cubic-bezier(0.16, 1, 0.3, 1),
                    opacity 0.35s cubic-bezier(0.16, 1, 0.3, 1);
        user-select: none;
      }

      .ql-panel::-webkit-scrollbar { width: 4px; }
      .ql-panel::-webkit-scrollbar-track { background: transparent; }
      .ql-panel::-webkit-scrollbar-thumb {
        background: rgba(16, 185, 129, 0.3);
        border-radius: 9999px;
      }

      .ql-panel.ql-hidden {
        transform: translateX(calc(100% + 40px));
        opacity: 0;
        pointer-events: none;
      }

      /* ─── Header ─────────────────────────────────────────────────── */
      .ql-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 14px 16px;
        border-bottom: 1px solid rgba(16, 185, 129, 0.1);
        position: relative;
        overflow: hidden;
        cursor: grab;
        user-select: none;
      }

      .ql-header::before {
        content: '';
        position: absolute;
        top: -50%;
        right: -20%;
        width: 100px;
        height: 100px;
        background: radial-gradient(circle, rgba(16, 185, 129, 0.08), transparent 70%);
        pointer-events: none;
      }

      .ql-header-left {
        display: flex;
        align-items: center;
        gap: 8px;
        z-index: 1;
      }

      .ql-logo {
        width: 28px;
        height: 28px;
        flex-shrink: 0;
      }

      .ql-title {
        font-size: 15px;
        font-weight: 700;
        color: var(--cream-50);
        letter-spacing: -0.3px;
      }

      .ql-subtitle {
        font-size: 9px;
        font-weight: 400;
        color: var(--emerald-400);
        letter-spacing: 1.2px;
        text-transform: uppercase;
        margin-top: 1px;
      }

      .ql-close-btn {
        background: none;
        border: none;
        cursor: pointer;
        color: var(--cream-200);
        opacity: 0.5;
        transition: all 150ms ease;
        padding: 5px;
        border-radius: var(--radius-sm);
        z-index: 1;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .ql-close-btn:hover {
        opacity: 1;
        color: var(--red-400);
        background: rgba(248, 113, 113, 0.1);
      }

      /* ─── Content Area ───────────────────────────────────────────── */
      .ql-content {
        padding: 20px 16px;
        min-height: 200px;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
      }

      .ql-state { display: none; width: 100%; }
      .ql-state.ql-active { display: flex; flex-direction: column; align-items: center; }

      /* ─── State: Idle ─────────────────────────────────────────────── */
      .ql-idle { text-align: center; }

      .ql-mosque-icon {
        width: 64px;
        height: 64px;
        margin: 0 auto 16px;
        opacity: 0.9;
        filter: drop-shadow(0 0 10px rgba(16, 185, 129, 0.2));
      }

      .ql-idle-title {
        font-size: 17px;
        font-weight: 600;
        color: var(--cream-50);
        margin-bottom: 4px;
      }

      .ql-idle-desc {
        font-size: 12px;
        color: var(--cream-200);
        opacity: 0.7;
        margin-bottom: 20px;
        line-height: 1.5;
      }

      /* ─── Buttons ─────────────────────────────────────────────────── */
      .ql-btn-primary {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        padding: 12px 24px;
        font-family: var(--font-ui);
        font-size: 13px;
        font-weight: 600;
        color: white;
        background: linear-gradient(135deg, var(--emerald-600), var(--emerald-700));
        border: none;
        border-radius: var(--radius-full);
        cursor: pointer;
        transition: all 250ms ease;
        box-shadow: 0 4px 12px rgba(5, 150, 105, 0.4);
        letter-spacing: 0.3px;
      }

      .ql-btn-primary:hover {
        background: linear-gradient(135deg, var(--emerald-500), var(--emerald-600));
        box-shadow: 0 6px 20px rgba(5, 150, 105, 0.5);
        transform: translateY(-1px);
      }

      .ql-btn-primary:active {
        transform: translateY(0);
        box-shadow: 0 2px 8px rgba(5, 150, 105, 0.3);
      }

      .ql-btn-secondary {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 9px 16px;
        font-family: var(--font-ui);
        font-size: 12px;
        font-weight: 500;
        color: var(--emerald-400);
        background: rgba(16, 185, 129, 0.1);
        border: 1px solid rgba(16, 185, 129, 0.2);
        border-radius: var(--radius-full);
        cursor: pointer;
        transition: all 250ms ease;
      }

      .ql-btn-secondary:hover {
        background: rgba(16, 185, 129, 0.15);
        border-color: rgba(16, 185, 129, 0.3);
      }

      .ql-btn-text {
        background: none;
        border: none;
        font-family: var(--font-ui);
        font-size: 11px;
        font-weight: 500;
        color: var(--emerald-400);
        cursor: pointer;
        padding: 4px 8px;
        transition: color 150ms ease;
      }

      .ql-btn-text:hover { color: var(--emerald-300); }

      .ql-btn-quran {
        width: 100%;
        justify-content: center;
        padding: 12px;
        font-size: 13px;
        border-radius: var(--radius-md);
      }

      .ql-btn-quran svg { width: 14px; height: 14px; }

      /* ─── State: Loading ──────────────────────────────────────────── */
      .ql-loading { text-align: center; }

      .ql-waveform {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 3px;
        height: 48px;
        margin-bottom: 16px;
      }

      .ql-waveform-bar {
        width: 3px;
        border-radius: 9999px;
        background: linear-gradient(to top, var(--emerald-600), var(--emerald-400));
        animation: ql-wave 1.2s ease-in-out infinite;
      }

      .ql-waveform-bar:nth-child(1) { height: 16px; animation-delay: 0s; }
      .ql-waveform-bar:nth-child(2) { height: 28px; animation-delay: 0.1s; }
      .ql-waveform-bar:nth-child(3) { height: 40px; animation-delay: 0.2s; }
      .ql-waveform-bar:nth-child(4) { height: 28px; animation-delay: 0.3s; }
      .ql-waveform-bar:nth-child(5) { height: 36px; animation-delay: 0.4s; }
      .ql-waveform-bar:nth-child(6) { height: 24px; animation-delay: 0.5s; }
      .ql-waveform-bar:nth-child(7) { height: 32px; animation-delay: 0.6s; }

      @keyframes ql-wave {
        0%, 100% { transform: scaleY(0.4); opacity: 0.5; }
        50%      { transform: scaleY(1);   opacity: 1; }
      }

      .ql-loading-text {
        font-size: 13px;
        font-weight: 500;
        color: var(--cream-100);
        margin-bottom: 4px;
      }

      .ql-loading-subtext {
        font-size: 10px;
        color: var(--cream-200);
        opacity: 0.5;
      }

      /* ─── State: Result ───────────────────────────────────────────── */
      .ql-result { width: 100%; }

      .ql-result-card {
        background: linear-gradient(145deg, rgba(22, 36, 25, 0.8), rgba(30, 51, 36, 0.8));
        border: 1px solid rgba(16, 185, 129, 0.15);
        border-radius: var(--radius-lg);
        padding: 16px;
        margin-bottom: 12px;
        position: relative;
        overflow: hidden;
        animation: ql-slide-up 0.4s ease forwards;
      }

      .ql-result-card::before {
        content: '';
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        height: 2px;
        background: linear-gradient(90deg, var(--emerald-600), var(--emerald-400), var(--gold-400));
      }

      @keyframes ql-slide-up {
        from { opacity: 0; transform: translateY(16px); }
        to   { opacity: 1; transform: translateY(0); }
      }

      .ql-surah-header { text-align: center; margin-bottom: 12px; }

      .ql-surah-arabic {
        font-family: var(--font-arabic);
        font-size: 28px;
        font-weight: 700;
        color: var(--cream-50);
        direction: rtl;
        margin-bottom: 3px;
        line-height: 1.3;
      }

      .ql-surah-english {
        font-size: 13px;
        font-weight: 600;
        color: var(--emerald-400);
        margin-bottom: 2px;
      }

      .ql-surah-meta {
        font-size: 10px;
        color: var(--cream-200);
        opacity: 0.6;
      }

      .ql-confidence-row {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        margin: 10px 0;
      }

      .ql-confidence-bar {
        flex: 1;
        max-width: 140px;
        height: 3px;
        background: var(--dark-600);
        border-radius: 9999px;
        overflow: hidden;
      }

      .ql-confidence-fill {
        height: 100%;
        border-radius: 9999px;
        transition: width 1s ease;
        width: 0%;
      }

      .ql-confidence-fill.high {
        background: linear-gradient(90deg, var(--emerald-500), var(--emerald-400));
      }

      .ql-confidence-fill.medium {
        background: linear-gradient(90deg, var(--amber-500), var(--amber-400));
      }

      .ql-confidence-value {
        font-size: 11px;
        font-weight: 600;
        color: var(--cream-100);
        min-width: 36px;
      }

      .ql-confidence-badge {
        display: none;
        align-items: center;
        gap: 3px;
        font-size: 9px;
        font-weight: 600;
        padding: 2px 6px;
        border-radius: 9999px;
        letter-spacing: 0.5px;
        text-transform: uppercase;
        background: rgba(251, 191, 36, 0.15);
        color: var(--amber-400);
        border: 1px solid rgba(251, 191, 36, 0.25);
      }

      .ql-confidence-badge.ql-show { display: inline-flex; }

      .ql-divider {
        height: 1px;
        background: linear-gradient(90deg, transparent, rgba(16, 185, 129, 0.15), transparent);
        margin: 10px 0;
      }

      .ql-ayah-text {
        font-family: var(--font-arabic);
        font-size: 20px;
        line-height: 2;
        color: var(--cream-100);
        direction: rtl;
        text-align: center;
        padding: 6px 4px;
        word-spacing: 4px;
      }

      .ql-result-actions {
        display: flex;
        flex-direction: column;
        gap: 8px;
        align-items: center;
      }

      /* ─── State: No Match ─────────────────────────────────────────── */
      .ql-no-match { text-align: center; }

      .ql-no-match-icon {
        font-size: 40px;
        margin-bottom: 12px;
        opacity: 0.7;
      }

      .ql-no-match-title {
        font-size: 15px;
        font-weight: 600;
        color: var(--cream-50);
        margin-bottom: 6px;
      }

      .ql-no-match-desc {
        font-size: 12px;
        color: var(--cream-200);
        opacity: 0.6;
        line-height: 1.5;
        margin-bottom: 18px;
      }

      /* ─── State: No Captions ──────────────────────────────────────── */
      .ql-no-captions { text-align: center; }

      .ql-no-captions-icon {
        font-size: 40px;
        margin-bottom: 12px;
        opacity: 0.7;
      }

      .ql-no-captions-title {
        font-size: 15px;
        font-weight: 600;
        color: var(--cream-50);
        margin-bottom: 6px;
      }

      .ql-no-captions-desc {
        font-size: 12px;
        color: var(--cream-200);
        opacity: 0.7;
        line-height: 1.6;
        margin-bottom: 18px;
        padding: 0 8px;
      }

      /* ─── State: Error ────────────────────────────────────────────── */
      .ql-error { text-align: center; }

      .ql-error-icon {
        width: 40px;
        height: 40px;
        margin: 0 auto 12px;
        background: rgba(248, 113, 113, 0.1);
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .ql-error-icon svg {
        width: 20px;
        height: 20px;
        color: var(--red-400);
      }

      .ql-error-title {
        font-size: 14px;
        font-weight: 600;
        color: var(--cream-50);
        margin-bottom: 6px;
      }

      .ql-error-message {
        font-size: 11px;
        color: var(--cream-200);
        opacity: 0.7;
        line-height: 1.5;
        margin-bottom: 16px;
        max-width: 280px;
      }

      /* ─── Footer ──────────────────────────────────────────────────── */
      .ql-footer {
        padding: 10px 16px;
        text-align: center;
        border-top: 1px solid rgba(16, 185, 129, 0.06);
      }

      .ql-footer-text {
        font-size: 9px;
        color: var(--cream-200);
        opacity: 0.3;
        letter-spacing: 0.5px;
      }

      .ql-progress-container {
        width: 100%;
        height: 6px;
        background: rgba(16, 185, 129, 0.1);
        border-radius: 4px;
        margin-top: 12px;
        overflow: hidden;
      }
      .ql-progress-bar {
        width: 0%;
        height: 100%;
        background-color: #1D9E75;
        border-radius: 4px;
        transition: width 0.5s ease;
      }

      /* ─── Animations ──────────────────────────────────────────────── */
      .ql-fade-in {
        animation: ql-fade-in 0.3s ease forwards;
      }

      @keyframes ql-fade-in {
        from { opacity: 0; transform: translateY(6px); }
        to   { opacity: 1; transform: translateY(0); }
      }
    `;
  }

  function getOverlayHTML() {
    return `
      <!-- Header -->
      <div class="ql-header">
        <div class="ql-header-left">
          <svg class="ql-logo" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="16" cy="16" r="15" fill="#065f46" stroke="#10b981" stroke-width="1"/>
            <text x="16" y="22" text-anchor="middle" fill="#fefdf8" font-family="'Amiri', serif" font-size="18" font-weight="700">ق</text>
          </svg>
          <div>
            <div class="ql-title">QuranLens</div>
            <div class="ql-subtitle">Quran Recitation Detector</div>
          </div>
        </div>
        <button class="ql-close-btn" id="ql-close" title="Close">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>

      <!-- Content -->
      <div class="ql-content">

        <!-- State: Idle -->
        <div class="ql-state ql-idle ql-active" id="ql-state-idle">
          <svg class="ql-mosque-icon" viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <linearGradient id="ql-mg" x1="40" y1="0" x2="40" y2="80" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stop-color="#34d399" stop-opacity="0.9"/>
                <stop offset="100%" stop-color="#065f46" stop-opacity="0.9"/>
              </linearGradient>
            </defs>
            <rect x="10" y="55" width="60" height="20" rx="3" fill="url(#ql-mg)" opacity="0.8"/>
            <path d="M20 55 Q20 30 40 20 Q60 30 60 55" fill="url(#ql-mg)" opacity="0.9"/>
            <circle cx="40" cy="17" r="3" fill="#fcd34d"/><circle cx="41.5" cy="16.5" r="2.5" fill="#162419"/>
            <rect x="12" y="35" width="6" height="20" rx="1" fill="url(#ql-mg)" opacity="0.7"/>
            <path d="M12 35 Q15 28 18 35" fill="url(#ql-mg)" opacity="0.8"/>
            <circle cx="15" cy="30" r="1.5" fill="#fcd34d" opacity="0.7"/>
            <rect x="62" y="35" width="6" height="20" rx="1" fill="url(#ql-mg)" opacity="0.7"/>
            <path d="M62 35 Q65 28 68 35" fill="url(#ql-mg)" opacity="0.8"/>
            <circle cx="65" cy="30" r="1.5" fill="#fcd34d" opacity="0.7"/>
            <path d="M35 75 L35 62 Q40 56 45 62 L45 75" fill="#0a0f0d" opacity="0.5"/>
            <circle cx="30" cy="48" r="2.5" fill="#fefdf8" opacity="0.2"/>
            <circle cx="50" cy="48" r="2.5" fill="#fefdf8" opacity="0.2"/>
            <circle cx="8" cy="12" r="0.8" fill="#fcd34d" opacity="0.5"/>
            <circle cx="72" cy="8" r="0.6" fill="#fcd34d" opacity="0.4"/>
            <circle cx="25" cy="6" r="0.5" fill="#fcd34d" opacity="0.3"/>
            <circle cx="60" cy="14" r="0.7" fill="#fcd34d" opacity="0.45"/>
          </svg>
          <div class="ql-idle-title">Detect Quran Recitation</div>
          <div class="ql-idle-desc">Identify the Surah and Ayah being recited in this video.</div>
          <button id="ql-btn-analyze" class="ql-btn-primary">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
              <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
              <line x1="12" y1="19" x2="12" y2="23"/>
              <line x1="8" y1="23" x2="16" y2="23"/>
            </svg>
            Analyze Recitation
          </button>
        </div>

        <!-- State: Loading -->
        <div class="ql-state ql-loading" id="ql-state-loading">
          <div class="ql-waveform">
            <div class="ql-waveform-bar"></div>
            <div class="ql-waveform-bar"></div>
            <div class="ql-waveform-bar"></div>
            <div class="ql-waveform-bar"></div>
            <div class="ql-waveform-bar"></div>
            <div class="ql-waveform-bar"></div>
            <div class="ql-waveform-bar"></div>
          </div>
          <div class="ql-loading-text" id="ql-loading-text">Analyzing recitation...</div>
          <div class="ql-loading-subtext">Searching captions & matching verses</div>
          <div class="ql-progress-container">
            <div class="ql-progress-bar" id="ql-progress-bar"></div>
          </div>
        </div>

        <!-- State: Result -->
        <div class="ql-state ql-result" id="ql-state-result">
          <div class="ql-result-card" id="ql-result-card">
            <div class="ql-surah-header">
              <div class="ql-surah-arabic" id="ql-surah-arabic" dir="rtl"></div>
              <div class="ql-surah-english" id="ql-surah-english"></div>
              <div class="ql-surah-meta" id="ql-surah-meta"></div>
            </div>
            <div class="ql-confidence-row">
              <div class="ql-confidence-bar">
                <div class="ql-confidence-fill" id="ql-conf-fill"></div>
              </div>
              <span class="ql-confidence-value" id="ql-conf-value"></span>
              <span class="ql-confidence-badge" id="ql-conf-badge">⚠ Low</span>
            </div>
            <div class="ql-divider"></div>
            <div class="ql-ayah-text" id="ql-ayah-text" dir="rtl"></div>
            <div id="ql-ambiguous-note" style="display:none; font-size:11px; color:#BA7517; text-align:center; margin-top:8px; line-height:1.4; opacity:0.85;"></div>
          </div>
          <div class="ql-result-actions">
            <button id="ql-btn-quran" class="ql-btn-primary ql-btn-quran">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                <polyline points="15 3 21 3 21 9"/>
                <line x1="10" y1="14" x2="21" y2="3"/>
              </svg>
              Open in Quran.com
            </button>
            <button id="ql-btn-reanalyze" class="ql-btn-text">↻ Re-analyze</button>
          </div>
        </div>

        <!-- State: No Match -->
        <div class="ql-state ql-no-match" id="ql-state-no-match">
          <div class="ql-no-match-icon">🔍</div>
          <div class="ql-no-match-title">No Recitation Detected</div>
          <div class="ql-no-match-desc">We couldn't identify a Quran recitation in this video. Make sure the video contains clear Arabic Quran audio.</div>
          <button id="ql-btn-retry-nomatch" class="ql-btn-secondary">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
            </svg>
            Try Again
          </button>
        </div>

        <!-- State: No Captions -->
        <div class="ql-state ql-no-captions" id="ql-state-no-captions">
          <div class="ql-no-captions-icon">📝</div>
          <div class="ql-no-captions-title">No Arabic Captions</div>
          <div class="ql-no-captions-desc">No Arabic captions found for this video. Try a video from a channel that provides Arabic subtitles.</div>
          <button id="ql-btn-retry-nocaptions" class="ql-btn-secondary">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
            </svg>
            Try Again
          </button>
        </div>

        <!-- State: Error -->
        <div class="ql-state ql-error" id="ql-state-error">
          <div class="ql-error-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
            </svg>
          </div>
          <div class="ql-error-title">Something Went Wrong</div>
          <div class="ql-error-message" id="ql-error-message"></div>
          <button id="ql-btn-retry-error" class="ql-btn-secondary">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
            </svg>
            Retry
          </button>
        </div>

      </div>

      <!-- Footer -->
      <div class="ql-footer">
        <div class="ql-footer-text">QuranLens v1.0 — بِسْمِ ٱللَّهِ ٱلرَّحْمَـٰنِ ٱلرَّحِيمِ</div>
      </div>
    `;
  }

  // ─── Event Binding ────────────────────────────────────────────────────

  function bindEvents(panel) {
    const $ = (id) => shadowRoot.getElementById(id);

    // Close button
    $('ql-close').addEventListener('click', () => hideOverlay());

    // Analyze button
    $('ql-btn-analyze').addEventListener('click', () => startAnalysis());

    // Re-analyze button
    $('ql-btn-reanalyze').addEventListener('click', () => startAnalysis());

    // Retry buttons
    $('ql-btn-retry-nomatch').addEventListener('click', () => startAnalysis());
    $('ql-btn-retry-nocaptions').addEventListener('click', () => startAnalysis());
    $('ql-btn-retry-error').addEventListener('click', () => startAnalysis());

    // Open in Quran.com
    $('ql-btn-quran').addEventListener('click', () => {
      if (currentResult && currentResult.url) {
        chrome.runtime.sendMessage({ type: 'OPEN_QURAN', url: currentResult.url });
      }
    });

    // Drag-and-drop overlay listeners
    const header = panel.querySelector('.ql-header');
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;

    header.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return; // Only left click

      isDragging = true;
      const rect = overlayRoot.getBoundingClientRect();
      dragStartX = e.clientX - rect.left;
      dragStartY = e.clientY - rect.top;

      document.body.style.cursor = 'grabbing';
      const originalUserSelect = document.body.style.userSelect;
      document.body.style.userSelect = 'none';

      const onMouseMove = (moveEvent) => {
        if (!isDragging) return;

        let left = moveEvent.clientX - dragStartX;
        let top = moveEvent.clientY - dragStartY;

        const overlayWidth = 360;
        const overlayHeight = panel.offsetHeight || 300;

        // Clamp to viewport
        left = Math.max(0, Math.min(left, window.innerWidth - overlayWidth));
        top = Math.max(0, Math.min(top, window.innerHeight - overlayHeight));

        overlayRoot.style.left = `${left}px`;
        overlayRoot.style.top = `${top}px`;
      };

      const onMouseUp = () => {
        isDragging = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = originalUserSelect;

        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);

        // Save position
        const finalRect = overlayRoot.getBoundingClientRect();
        chrome.storage.local.set({
          ql_overlay_pos: {
            top: finalRect.top,
            left: finalRect.left
          }
        });
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  }

  // ─── State Management ─────────────────────────────────────────────────

  function setState(stateName) {
    currentState = stateName;

    const states = shadowRoot.querySelectorAll('.ql-state');
    states.forEach(el => {
      el.classList.remove('ql-active', 'ql-fade-in');
    });

    const target = shadowRoot.getElementById(`ql-state-${stateName}`);
    if (target) {
      target.classList.add('ql-active');
      requestAnimationFrame(() => target.classList.add('ql-fade-in'));
    }
  }

  // ─── Show / Hide Overlay ──────────────────────────────────────────────

  function showOverlay() {
    createOverlay();
    const panel = shadowRoot.getElementById('ql-panel');
    if (panel) {
      panel.classList.remove('ql-hidden');
      isVisible = true;
    }
  }

  function hideOverlay() {
    if (!shadowRoot) return;
    const panel = shadowRoot.getElementById('ql-panel');
    if (panel) {
      panel.classList.add('ql-hidden');
      isVisible = false;
    }
  }

  function toggleOverlay() {
    if (!overlayRoot || !isVisible) {
      showOverlay();
    } else {
      hideOverlay();
    }
  }

  // ─── Analysis Flow ────────────────────────────────────────────────────

  async function startAnalysis() {
    setState('loading');

    // Reset progress bar to 0% and label to "Analyzing recitation..."
    if (shadowRoot) {
      const bar = shadowRoot.getElementById('ql-progress-bar');
      if (bar) bar.style.width = '0%';
      const label = shadowRoot.getElementById('ql-loading-text');
      if (label) label.textContent = 'Listening...';
    }

    // Query the active video element to get current playback time (in seconds)
    const video = document.querySelector('video');
    const currentTime = video ? video.currentTime : 0;
    console.log(`${QL_LOG} startAnalysis at currentTime:`, currentTime);

    chrome.runtime.sendMessage({ 
      type: 'ANALYZE_VIDEO',
      currentTime: currentTime
    }).catch(err => {
      console.error(`${QL_LOG} Analysis message error:`, err);
      showError(err.message || 'Failed to communicate with the extension.');
    });
  }

  // ─── Render Result ────────────────────────────────────────────────────

  function renderResult(result) {
    if (!result) return;

    currentResult = result;
    const $ = (id) => shadowRoot.getElementById(id);

    const surahInfo = result.surahName || {};

    // Surah name
    $('ql-surah-arabic').textContent = surahInfo.arabic || `سورة ${result.surah}`;
    $('ql-surah-english').textContent = surahInfo.english || `Surah ${result.surah}`;
    $('ql-surah-meta').textContent = `Surah ${result.surah} · Ayah ${result.ayah}`;

    // Confidence
    const confPercent = Math.round((result.confidence || 0) * 100);
    $('ql-conf-value').textContent = `${confPercent}%`;

    const isLow = result.confidence < 0.75;
    const fill = $('ql-conf-fill');
    fill.className = `ql-confidence-fill ${isLow ? 'medium' : 'high'}`;
    setTimeout(() => { fill.style.width = `${confPercent}%`; }, 80);

    // Low confidence badge
    const badge = $('ql-conf-badge');
    if (result.confidence >= 0.60 && result.confidence < 0.75) {
      badge.classList.add('ql-show');
    } else {
      badge.classList.remove('ql-show');
    }

    // Ayah text — from local corpus (no API call)
    $('ql-ayah-text').textContent = result.text || `﴿ ${result.surah}:${result.ayah} ﴾`;

    // Reset ambiguous UI artifacts
    const card = $('ql-result-card');
    if (card) card.style.borderTop = '';
    const note = $('ql-ambiguous-note');
    if (note) note.style.display = 'none';
    const quranBtn = $('ql-btn-quran');
    if (quranBtn) quranBtn.style.display = '';

    setState('result');
  }

  function renderAmbiguousResult(result) {
    if (!result) return;

    currentResult = result;
    const $ = (id) => shadowRoot.getElementById(id);

    const surahInfo = result.surahName || {};
    if (result.surah === 55) {
      $('ql-surah-arabic').textContent = surahInfo.arabic || `سورة ${result.surah}`;
      $('ql-surah-english').textContent = surahInfo.english || 'Surah Ar-Rahman';
      $('ql-surah-meta').textContent = `Surah ${result.surah} · Ayah ${result.ayah}`;
    } else {
      $('ql-surah-arabic').textContent = '';
      $('ql-surah-english').textContent = 'Multiple surahs — context unclear';
      $('ql-surah-meta').textContent = '';
    }

    const confPercent = Math.round((result.confidence || 0) * 100);
    $('ql-conf-value').textContent = `${confPercent}%`;

    const isLow = result.confidence < 0.75;
    const fill = $('ql-conf-fill');
    fill.className = `ql-confidence-fill ${isLow ? 'medium' : 'high'}`;
    setTimeout(() => { fill.style.width = `${confPercent}%`; }, 80);

    const badge = $('ql-conf-badge');
    if (result.confidence >= 0.60 && result.confidence < 0.75) {
      badge.classList.add('ql-show');
    } else {
      badge.classList.remove('ql-show');
    }

    $('ql-ayah-text').textContent = result.text || `﴿ ${result.surah}:${result.ayah} ﴾`;

    const note = $('ql-ambiguous-note');
    if (note) {
      note.textContent = result.surah === 55
        ? 'This verse repeats throughout Surah Ar-Rahman. Analyse again for a more precise ayah match.'
        : 'This verse appears identically in multiple surahs. The recitation context was insufficient to determine which. Try analysing a few seconds earlier or later.';
      note.style.display = 'block';
    }

    const quranBtn = $('ql-btn-quran');
    if (quranBtn) quranBtn.style.display = 'none';

    const card = $('ql-result-card');
    if (card) card.style.borderTop = '2px solid #BA7517';

    setState('result');
  }

  // ─── Error Display ────────────────────────────────────────────────────

  function showError(message) {
    const el = shadowRoot.getElementById('ql-error-message');
    if (el) el.textContent = message || 'An unknown error occurred.';
    setState('error');
  }

  // ─── Message Handler ──────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
      case 'TOGGLE_OVERLAY':
        toggleOverlay();
        sendResponse({ ok: true });
        return false;

      case 'FETCH_CAPTIONS':
        // Background is asking us to fetch captions via content script
        handleFetchCaptions(message.playerResponse, message.currentTime)
          .then(result => sendResponse(result))
          .catch(err => sendResponse({ type: 'ERROR', message: err.message }));
        return true; // async

      case 'MATCH_RESULT':
        showOverlay();
        if (message.ambiguous) {
          renderAmbiguousResult(message.result);
        } else {
          renderResult(message.result);
        }
        window.dispatchEvent(new CustomEvent('quranlens-reset-buffer'));
        return false;

      case 'NO_MATCH':
        showOverlay();
        setState('no-match');
        return false;

      case 'NO_CAPTIONS':
        showOverlay();
        setState('no-captions');
        return false;

      case 'ERROR':
        showOverlay();
        showError(message.message);
        return false;

      case 'ANALYZING':
        // If overlay is not in loading state, transition to it
        showOverlay();
        if (currentState !== 'loading') {
          setState('loading');
        }
        
        // Update progress bar width and label via direct DOM mutation
        if (shadowRoot) {
          const bar = shadowRoot.getElementById('ql-progress-bar');
          if (bar) {
            let displayProgress;
            if (message.confidence != null) {
              displayProgress = message.progress === 99
                ? 99
                : Math.min(99, Math.round(20 + message.confidence * 60));
            } else if (typeof message.progress === 'number' && message.progress > 0) {
              displayProgress = message.progress;
            } else {
              displayProgress = message.progress ?? 0;
            }
            bar.style.width = `${displayProgress}%`;
            
            const label = shadowRoot.getElementById('ql-loading-text');
            if (label) {
              if (displayProgress === 99) {
                label.textContent = 'Finalizing match...';
              } else if (message.confidence != null) {
                const confPercent = Math.round(message.confidence * 100);
                label.textContent = `Verifying... (${confPercent}% confident)`;
              } else if (displayProgress > 0) {
                label.textContent = 'Analysing...';
              } else {
                label.textContent = 'Listening...';
              }
            }
          }
        }
        return false;

      case 'VIDEO_CHANGED':
        // New video — reset to idle if overlay is visible
        currentResult = null;
        if (isVisible) {
          setState('idle');
        }
        // On VIDEO_CHANGED: restore position from storage (do not reset to default)
        loadOverlayPosition();
        return false;

      default:
        return false;
    }
  });

  // ─── Content Script Caption Fetch ─────────────────────────────────────

  async function handleFetchCaptions(passedPlayerResponse, currentTime) {
    const CS_LOG = '[QuranLens CS]';
    try {
      console.log(`${CS_LOG} handleFetchCaptions: content-script fallback path for currentTime:`, currentTime);

      const metadata = await getVideoMetadata(passedPlayerResponse);
      if (!metadata || !metadata.videoId) {
        console.warn(`${CS_LOG} handleFetchCaptions: could not detect video`);
        return { type: 'ERROR', message: 'Could not detect video on this page.' };
      }

      console.log(`${CS_LOG} handleFetchCaptions: attempting caption extraction (JSON3)...`);
      const captions = await getYouTubeCaptions(metadata.videoId, passedPlayerResponse, currentTime);

      if (captions && captions.length > 10) {
        console.log(`${CS_LOG} handleFetchCaptions: captions OK, length:`, captions.length);
        return { type: 'CAPTIONS_RESULT', text: captions };
      }

      console.warn(`${CS_LOG} handleFetchCaptions: no Arabic captions available`);
      return { type: 'NO_CAPTIONS' };

    } catch (err) {
      console.error(`${CS_LOG} handleFetchCaptions error:`, err);
      return { type: 'ERROR', message: err.message || 'Caption fetch failed' };
    }
  }

  console.log(`${QL_LOG} Content script initialized`);
}
