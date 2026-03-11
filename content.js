// Netflix Channel Surfer - Content Script
// Injects a "Surf" button into Netflix and enables cable-TV-style random playback.
// Architecture:
//   Browse/Title pages → collect video IDs → pick random → navigate to /watch/
//   Watch pages        → detect pending surf → wait for video → seek to random point

(function () {
  'use strict';

  // ─── Constants ───────────────────────────────────────────────────────────────

  const STORAGE_PENDING = 'cs_pendingSeek';
  const STORAGE_SETTINGS = 'cs_settings';

  const DEFAULT_SETTINGS = {
    seekMin: 0.15,   // earliest drop-in (15% through)
    seekMax: 0.80,   // latest  drop-in (80% through)
    contentType: 'both', // 'shows' | 'movies' | 'both'
  };

  // Netflix nav bar selectors — multiple fallbacks since Netflix updates its markup
  const NAV_SELECTORS = [
    '.pinning-header-container .navigation-tab-container',
    '.navigation-tab-container',
    '.pinning-header-container',
    '[data-uia="nav-menu-user"]',
    'header',
  ];

  // ─── State ───────────────────────────────────────────────────────────────────

  let settings = { ...DEFAULT_SETTINGS };
  let seekAttemptsLeft = 0;
  let spaObserver = null;

  // ─── Settings ────────────────────────────────────────────────────────────────

  async function loadSettings() {
    const result = await chrome.storage.local.get(STORAGE_SETTINGS);
    if (result[STORAGE_SETTINGS]) {
      settings = { ...DEFAULT_SETTINGS, ...result[STORAGE_SETTINGS] };
    }
  }

  // ─── Page helpers ─────────────────────────────────────────────────────────────

  function getPageType() {
    const p = window.location.pathname;
    if (p.startsWith('/watch/')) return 'watch';
    if (p.startsWith('/title/')) return 'title';
    return 'browse';
  }

  function getTitleIdFromPath() {
    const m = window.location.pathname.match(/\/title\/(\d+)/);
    return m ? m[1] : null;
  }

  // ─── Video ID collection ─────────────────────────────────────────────────────

  // Strategy 1: Scrape all /watch/ hrefs visible in the DOM
  function collectIdsFromDOM() {
    const ids = new Set();

    document.querySelectorAll('a[href*="/watch/"]').forEach((a) => {
      const m = a.href.match(/\/watch\/(\d+)/);
      if (m) ids.add(m[1]);
    });

    // data-videoid / data-video-id attributes on cards
    document.querySelectorAll('[data-videoid],[data-video-id]').forEach((el) => {
      const id = el.dataset.videoid || el.dataset.videoId;
      if (id && /^\d+$/.test(id)) ids.add(id);
    });

    return [...ids];
  }

  // Strategy 2: Netflix Shakti (internal Falcor) API — fetches ALL episodes for
  //             a TV show, not just what's currently visible in the DOM.
  async function collectIdsFromShakti(titleId) {
    try {
      const buildId = getNetflixBuildId();
      const authURL = getNetflixAuthURL();
      if (!buildId || !authURL) return [];

      // Fetch seasons 0-20, episodes 0-60 per season
      const paths = JSON.stringify([
        [
          'videos', parseInt(titleId, 10),
          'seasons', { from: 0, to: 20 },
          'episodes', { from: 0, to: 60 },
          ['summary'],
        ],
      ]);

      const response = await fetch(
        `https://www.netflix.com/api/shakti/${buildId}/pathEvaluator` +
          `?withSize=true&materialize=true&model=harris`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ paths, authURL }),
        }
      );

      if (!response.ok) return [];

      const data = await response.json();
      const ids = [];
      const seasons = data?.value?.videos?.[titleId]?.seasons;

      if (seasons) {
        Object.values(seasons).forEach((season) => {
          if (!season?.episodes) return;
          Object.values(season.episodes).forEach((ep) => {
            const id = ep?.summary?.id;
            if (id) ids.push(String(id));
          });
        });
      }

      return ids;
    } catch (_) {
      return [];
    }
  }

  function getNetflixBuildId() {
    // Netflix embeds the build identifier in several places
    try {
      if (window.netflix?.cadmium?.BUILD_IDENTIFIER)
        return window.netflix.cadmium.BUILD_IDENTIFIER;
      if (window.__PREFETCHED_VARIADIC_ID_DATA__?.BUILD_IDENTIFIER)
        return window.__PREFETCHED_VARIADIC_ID_DATA__.BUILD_IDENTIFIER;
    } catch (_) {}

    // Scan inline script tags
    for (const s of document.querySelectorAll('script:not([src])')) {
      const m = s.textContent.match(/"BUILD_IDENTIFIER"\s*:\s*"([^"]+)"/);
      if (m) return m[1];
    }
    return null;
  }

  function getNetflixAuthURL() {
    for (const s of document.querySelectorAll('script:not([src])')) {
      const m = s.textContent.match(/"authURL"\s*:\s*"([^"]+)"/);
      if (m) return m[1].replace(/\\/g, '');
    }
    return null;
  }

  // ─── Surf button — browse / title pages ──────────────────────────────────────

  function injectSurfButton() {
    if (document.getElementById('cs-surf-btn')) return;

    let nav = null;
    for (const sel of NAV_SELECTORS) {
      nav = document.querySelector(sel);
      if (nav) break;
    }
    if (!nav) return;

    const btn = document.createElement('button');
    btn.id = 'cs-surf-btn';
    btn.className = 'cs-surf-btn';
    btn.setAttribute('aria-label', 'Channel Surf – jump to random content');
    btn.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="2" y="7" width="20" height="15" rx="2" ry="2"/>
        <polyline points="17 2 12 7 7 2"/>
        <circle cx="12" cy="17" r="1" fill="currentColor" stroke="none"/>
      </svg>
      <span>Surf</span>`;
    btn.addEventListener('click', onSurfClick);
    nav.appendChild(btn);
  }

  async function onSurfClick() {
    const btn = document.getElementById('cs-surf-btn');
    if (btn) btn.disabled = true;

    let ids = [];

    // On a show's title page, use the Shakti API for the complete episode list
    if (getPageType() === 'title') {
      const titleId = getTitleIdFromPath();
      if (titleId) {
        ids = await collectIdsFromShakti(titleId);
      }
    }

    // Fall back to (or supplement with) DOM scraping
    if (ids.length === 0) {
      ids = collectIdsFromDOM();
    }

    if (btn) btn.disabled = false;

    if (ids.length === 0) {
      showToast('No content found on this page. Browse to a show or category first.');
      return;
    }

    const randomId = ids[Math.floor(Math.random() * ids.length)];

    // Signal the watch page to seek after load
    await chrome.storage.local.set({ [STORAGE_PENDING]: true });

    showSurfingOverlay(() => {
      window.location.href = `https://www.netflix.com/watch/${randomId}`;
    });
  }

  // ─── SPA navigation (browse pages navigate without a full reload) ─────────────

  function patchHistoryForSPA() {
    const patch = (orig) =>
      function (...args) {
        orig.apply(this, args);
        onSPANavigate();
      };

    history.pushState = patch(history.pushState);
    history.replaceState = patch(history.replaceState);
    window.addEventListener('popstate', onSPANavigate);
  }

  function onSPANavigate() {
    // Re-inject the button ~500 ms after SPA navigation settles
    setTimeout(injectSurfButton, 500);
  }

  function startButtonObserver() {
    // Re-inject if Netflix re-renders the nav and removes our button
    if (spaObserver) return;
    spaObserver = new MutationObserver(() => {
      if (!document.getElementById('cs-surf-btn')) {
        injectSurfButton();
      }
    });
    spaObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  // ─── Watch page — seek to random position ────────────────────────────────────

  async function handleWatchPage() {
    const result = await chrome.storage.local.get(STORAGE_PENDING);
    if (!result[STORAGE_PENDING]) return;

    await chrome.storage.local.remove(STORAGE_PENDING);

    seekAttemptsLeft = 50; // try for up to ~25 seconds
    scheduleSeekAttempt();

    // Also inject a floating "Surf Again" button so the user can keep surfing
    setTimeout(injectWatchSurfButton, 2000);
  }

  function scheduleSeekAttempt() {
    if (seekAttemptsLeft <= 0) return;
    seekAttemptsLeft--;

    const video = document.querySelector('video');

    if (!video || !video.duration || isNaN(video.duration) || video.duration < 30) {
      // Not ready yet — wait and retry
      setTimeout(scheduleSeekAttempt, 500);
      return;
    }

    performSeek(video);
  }

  function performSeek(video) {
    const duration = video.duration;
    const minTime = duration * settings.seekMin;
    const maxTime = duration * settings.seekMax;
    const seekTime = minTime + Math.random() * (maxTime - minTime);

    // Prefer Netflix's internal player API (respects buffering, DRM seek, etc.)
    const usedAPI = seekWithNetflixAPI(Math.round(seekTime * 1000));
    if (!usedAPI) {
      video.currentTime = seekTime;
    }

    const pct = Math.round((seekTime / duration) * 100);
    showToast(`📺  Tuned in at ${formatTime(seekTime)} · ${pct}% through`);
  }

  function seekWithNetflixAPI(timeMs) {
    try {
      const vp =
        window.netflix?.appContext?.state?.playerApp?.getAPI?.()?.videoPlayer;
      if (!vp) return false;

      const ids = vp.getAllPlayerSessionIds?.();
      if (!ids?.length) return false;

      const player = vp.getVideoPlayerBySessionId?.(ids[0]);
      if (typeof player?.seek !== 'function') return false;

      player.seek(timeMs);
      return true;
    } catch (_) {
      return false;
    }
  }

  // ─── "Surf Again" button on the watch / player page ──────────────────────────

  function injectWatchSurfButton() {
    if (document.getElementById('cs-watch-surf-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'cs-watch-surf-btn';
    btn.className = 'cs-watch-surf-btn';
    btn.setAttribute('aria-label', 'Channel Surf – switch to something else');
    btn.innerHTML = `
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="2" y="7" width="20" height="15" rx="2" ry="2"/>
        <polyline points="17 2 12 7 7 2"/>
        <circle cx="12" cy="17" r="1" fill="currentColor" stroke="none"/>
      </svg>
      <span>Surf</span>`;

    btn.addEventListener('click', onWatchSurfClick);
    document.body.appendChild(btn);
  }

  async function onWatchSurfClick() {
    // Go to the Netflix home page with the pendingSeek flag set — the home page
    // will render tiles and the user can click Surf there, OR we pick immediately
    // from the previously viewed page by going back.
    //
    // Better UX: collect IDs from the video's own "More Like This" / related row
    // if Netflix has rendered them; otherwise fall back to the home page.
    const ids = collectIdsFromDOM();

    if (ids.length > 0) {
      const randomId = ids[Math.floor(Math.random() * ids.length)];
      await chrome.storage.local.set({ [STORAGE_PENDING]: true });
      showSurfingOverlay(() => {
        window.location.href = `https://www.netflix.com/watch/${randomId}`;
      });
    } else {
      // Send user to home page; the injected button there will let them surf
      window.location.href = 'https://www.netflix.com/browse';
    }
  }

  // ─── Overlay & toast UI ───────────────────────────────────────────────────────

  function showSurfingOverlay(callback) {
    const el = document.createElement('div');
    el.id = 'cs-overlay';
    el.innerHTML = `
      <div class="cs-static-grain"></div>
      <div class="cs-overlay-label">
        <div class="cs-tv-emoji">📺</div>
        <div class="cs-overlay-text">Channel Surfing…</div>
      </div>`;
    document.body.appendChild(el);

    // Trigger fade-in on next frame, then navigate
    requestAnimationFrame(() => {
      el.classList.add('cs-overlay-on');
      setTimeout(callback, 650);
    });
  }

  function showToast(message, duration = 4500) {
    const existing = document.getElementById('cs-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'cs-toast';
    toast.textContent = message;
    document.body.appendChild(toast);

    requestAnimationFrame(() => {
      toast.classList.add('cs-toast-on');
      setTimeout(() => {
        toast.classList.remove('cs-toast-on');
        setTimeout(() => toast.remove(), 400);
      }, duration);
    });
  }

  function formatTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
  }

  // ─── Initialization ───────────────────────────────────────────────────────────

  async function init() {
    await loadSettings();

    if (getPageType() === 'watch') {
      await handleWatchPage();
    } else {
      // Browse / title page
      patchHistoryForSPA();
      startButtonObserver();
      // Try injecting immediately and again after Netflix's React app has mounted
      injectSurfButton();
      setTimeout(injectSurfButton, 1500);
      setTimeout(injectSurfButton, 3000);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
