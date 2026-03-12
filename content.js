// Netflix Channel Surfer - Content Script
//
// Architecture note on Chrome extension isolated worlds:
//   Content scripts share the DOM with the page but run in a separate JS context.
//   They CANNOT read page-level variables like `window.netflix`. To access those,
//   we inject a tiny <script> (PAGE_BRIDGE) that runs in the *page* context and
//   communicates back via CustomEvents dispatched on `document`, which is shared
//   between both worlds.
//
//   Browse / Title / Genre pages
//     → collect IDs (Falcor cache → Shakti API → DOM hrefs)
//     → pick random → navigate to /watch/{id} → set chrome.storage.session flag
//   Watch pages
//     → detect session flag → wait for video readyState → seek → toast

(function () {
  'use strict';

  // ─── Constants ────────────────────────────────────────────────────────────────

  const STORAGE_PENDING  = 'cs_pendingSeek';   // chrome.storage.session
  const STORAGE_SETTINGS = 'cs_settings';       // chrome.storage.local
  const STORAGE_AUTOSURF = 'cs_autoSurf';       // chrome.storage.session
  const PENDING_TTL_MS   = 30_000;              // ignore stale flags > 30 s old

  const DEFAULT_SETTINGS = {
    seekMin: 0.15,   // earliest drop-in (fraction)
    seekMax: 0.80,   // latest  drop-in  (fraction)
    contentType: 'both', // 'shows' | 'movies' | 'both'
  };

  // Tried in order; Netflix rewrites its markup periodically
  const NAV_SELECTORS = [
    '.pinning-header-container .navigation-tab-container',
    '.navigation-tab-container',
    '.pinning-header-container',
    '[data-uia="nav-menu-user"]',
    'header',
  ];

  // ─── Page bridge ─────────────────────────────────────────────────────────────
  //
  // This script is injected as a <script> tag so it runs in the *page* JS world
  // where window.netflix is accessible. It speaks over document CustomEvents.
  //
  // Escape rules inside the template literal:
  //   \\d   → becomes \d  in the injected string (regex digit)
  //   \\/   → becomes \/  (not strictly needed but safe)

  const PAGE_BRIDGE = `(function () {
  if (window.__cs_bridge) return;
  window.__cs_bridge = true;

  function reply(name, detail) {
    document.dispatchEvent(new CustomEvent(name, { detail: detail }));
  }

  // Seek via Netflix's internal player API
  document.addEventListener('cs:seek', function (e) {
    var ok = false;
    try {
      var nflx = window.netflix;
      var vp = nflx && nflx.appContext && nflx.appContext.state &&
               nflx.appContext.state.playerApp &&
               nflx.appContext.state.playerApp.getAPI &&
               nflx.appContext.state.playerApp.getAPI().videoPlayer;
      if (vp) {
        var sids = vp.getAllPlayerSessionIds && vp.getAllPlayerSessionIds();
        if (sids && sids.length) {
          var player = vp.getVideoPlayerBySessionId(sids[0]);
          if (player && typeof player.seek === 'function') {
            player.seek(e.detail.ms);
            ok = true;
          }
        }
      }
    } catch (_) {}
    reply('cs:seek:done', { ok: ok });
  });

  // Return video IDs from Netflix's Falcor model cache (populated for all
  // loaded rows on the current page — home, genre, title, etc.)
  document.addEventListener('cs:getIds', function () {
    var ids = [];
    try {
      var videos = window.netflix && window.netflix.falcorCache &&
                   window.netflix.falcorCache.videos;
      if (videos) {
        ids = Object.keys(videos).filter(function (k) { return /^\\d{5,}$/.test(k); });
      }
    } catch (_) {}
    reply('cs:ids', { ids: ids });
  });
})();`;

  // ─── State ───────────────────────────────────────────────────────────────────

  let settings       = { ...DEFAULT_SETTINGS };
  let bridgeInjected = false;
  let navObserver    = null;
  let seekLeft       = 0;

  // ─── Bridge helpers ───────────────────────────────────────────────────────────

  function injectBridge() {
    if (bridgeInjected) return;
    bridgeInjected = true;
    const s = document.createElement('script');
    s.textContent = PAGE_BRIDGE;
    (document.head || document.documentElement).appendChild(s);
    s.remove();
  }

  // Send a CustomEvent to the page context via the shared document
  function toPage(name, detail) {
    document.dispatchEvent(new CustomEvent(name, { detail: detail || {} }));
  }

  // Wait for a CustomEvent reply from the page context
  function fromPage(name, timeoutMs = 1500) {
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      document.addEventListener(name, function h(e) {
        clearTimeout(timer);
        document.removeEventListener(name, h);
        resolve(e.detail);
      }, { once: true });
    });
  }

  // ─── Settings ─────────────────────────────────────────────────────────────────

  async function loadSettings() {
    const r = await chrome.storage.local.get(STORAGE_SETTINGS);
    if (r[STORAGE_SETTINGS]) settings = { ...DEFAULT_SETTINGS, ...r[STORAGE_SETTINGS] };
  }

  // ─── Page helpers ─────────────────────────────────────────────────────────────

  function pageType() {
    const p = window.location.pathname;
    if (p.startsWith('/watch/')) return 'watch';
    if (p.startsWith('/title/')) return 'title';
    if (/^\/browse\/genre\/\d/.test(p)) return 'genre';
    return 'browse'; // home / /browse / search / anything else
  }

  function titleId() {
    const m = window.location.pathname.match(/\/title\/(\d+)/);
    return m ? Number(m[1]) : null;
  }

  function genreId() {
    const m = window.location.pathname.match(/\/browse\/genre\/(\d+)/);
    return m ? Number(m[1]) : null;
  }

  // ─── ID collection — three strategies ────────────────────────────────────────

  // 1. Falcor cache (page context → bridge): contains every video Netflix has
  //    loaded metadata for on the current page — much richer than DOM links.
  async function idsFromFalcorCache() {
    toPage('cs:getIds');
    const r = await fromPage('cs:ids', 2000);
    return r?.ids ?? [];
  }

  // 2. DOM scraping: /watch/ href links + data-videoid attributes.
  //    Reliable fallback that needs no API or page-context access.
  function idsFromDOM() {
    const ids = new Set();
    document.querySelectorAll('a[href*="/watch/"]').forEach(a => {
      const m = a.href.match(/\/watch\/(\d+)/);
      if (m) ids.add(m[1]);
    });
    document.querySelectorAll('[data-videoid],[data-video-id]').forEach(el => {
      const id = el.dataset.videoid ?? el.dataset.videoId;
      if (id && /^\d+$/.test(id)) ids.add(id);
    });
    return [...ids];
  }

  // 3. Shakti API: Netflix's internal Falcor-over-HTTP endpoint.
  //    Works from a content script because content scripts make requests from
  //    the page origin (same-origin), so session cookies are included.
  function getBuildId() {
    // Scan inline <script> tags for the build identifier (accessible in content
    // scripts because we read .textContent — a DOM property, not a JS variable)
    for (const s of document.querySelectorAll('script:not([src])')) {
      const m = s.textContent.match(/"BUILD_IDENTIFIER"\s*:\s*"([^"]+)"/);
      if (m) return m[1];
    }
    return null;
  }

  function getAuthURL() {
    for (const s of document.querySelectorAll('script:not([src])')) {
      const m = s.textContent.match(/"authURL"\s*:\s*"([^"]+)"/);
      if (m) return m[1].replace(/\\/g, '');
    }
    return null;
  }

  async function shaktiIds(paths) {
    const buildId = getBuildId();
    const authURL = getAuthURL();
    if (!buildId || !authURL) return [];

    try {
      const resp = await fetch(
        `https://www.netflix.com/api/shakti/${buildId}/pathEvaluator` +
          `?withSize=true&materialize=true&model=harris`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ paths: JSON.stringify(paths), authURL }),
        }
      );
      if (!resp.ok) return [];

      const data = await resp.json();
      const ids  = new Set();

      // Walk the entire Falcor response tree. We don't hard-code specific key
      // paths because the structure shifts between Netflix API versions.
      (function walk(o) {
        if (!o || typeof o !== 'object') return;
        // Falcor atom wrapper — unwrap and continue
        if (o.$type === 'atom') { walk(o.value); return; }
        // A video/movie/show summary: has numeric `id` and type field
        if ((o.type === 'show' || o.type === 'movie') && typeof o.id === 'number') {
          ids.add(String(o.id));
        }
        // An episode summary: `episodeId` is the watchable video ID
        if (typeof o.episodeId === 'number') {
          ids.add(String(o.episodeId));
        }
        for (const v of Object.values(o)) walk(v);
      })(data.value);

      return [...ids];
    } catch (_) {
      return [];
    }
  }

  // ─── ID gathering — picks strategy based on current page type ─────────────────

  async function gatherIds() {
    const type = pageType();

    // Show title page → Shakti episode list (complete, all seasons)
    if (type === 'title') {
      const id = titleId();
      if (id) {
        const ids = await shaktiIds([
          ['videos', id, 'seasons', { from: 0, to: 20 },
           'episodes', { from: 0, to: 60 }, 'summary'],
        ]);
        if (ids.length) return ids;
      }
    }

    // Genre browse page → Shakti genre recs + Falcor cache (parallel)
    if (type === 'genre') {
      const id = genreId();
      const [api, cache] = await Promise.all([
        id ? shaktiIds([['genres', id, 'recs', { from: 0, to: 50 }, 'summary']]) : [],
        idsFromFalcorCache(),
      ]);
      const merged = [...new Set([...api, ...cache])];
      if (merged.length) return merged;
    }

    // Home / generic browse → Shakti lolomo (home rows) + Falcor cache (parallel)
    if (type === 'browse') {
      const [api, cache] = await Promise.all([
        // lolomo = "List Of Lists Of MOvies" — Netflix's home page row structure
        shaktiIds([['lolomo', { from: 0, to: 8 }, { from: 0, to: 24 }, 'summary']]),
        idsFromFalcorCache(),
      ]);
      const merged = [...new Set([...api, ...cache])];
      if (merged.length) return merged;
    }

    // Fallback: whatever /watch/ links happen to be in the DOM right now
    return idsFromDOM();
  }

  // ─── Surf action ──────────────────────────────────────────────────────────────

  async function surf(preloadedIds) {
    const btn = document.getElementById('cs-surf-btn');
    if (btn) btn.disabled = true;

    const ids = preloadedIds ?? await gatherIds();

    if (btn) btn.disabled = false;

    if (!ids.length) {
      showToast('No content found. Browse to a show, genre, or home first.');
      return;
    }

    const videoId = ids[Math.floor(Math.random() * ids.length)];

    // Store a timestamped flag in session storage so the watch page knows to seek.
    // Using chrome.storage.session (not local) — it's session-scoped and not
    // persisted to disk.
    await chrome.storage.session.set({ [STORAGE_PENDING]: { ts: Date.now() } });

    showSurfingOverlay(() => {
      window.location.href = `https://www.netflix.com/watch/${videoId}`;
    });
  }

  // ─── Surf button — nav bar (browse / title / genre pages) ────────────────────

  function injectSurfButton() {
    if (document.getElementById('cs-surf-btn')) return;

    let nav = null;
    for (const sel of NAV_SELECTORS) {
      nav = document.querySelector(sel);
      if (nav) break;
    }
    if (!nav) return;

    const btn = document.createElement('button');
    btn.id        = 'cs-surf-btn';
    btn.className = 'cs-surf-btn';
    btn.setAttribute('aria-label', 'Channel Surf');
    btn.innerHTML = tvSVG(17) + '<span>Surf</span>';
    btn.addEventListener('click', () => surf());
    nav.appendChild(btn);
  }

  // ─── SPA navigation ───────────────────────────────────────────────────────────
  // Netflix's browse pages navigate via the History API without full page reloads.
  // We patch pushState/replaceState to re-inject the surf button after navigation.
  // The Navigation API (Chrome 102+) is used as primary where available.

  function listenToSPANavigation() {
    if (window.navigation) {
      // Modern Navigation API — more reliable than pushState patching
      window.navigation.addEventListener('navigate', () => setTimeout(injectSurfButton, 500));
    } else {
      // Fallback: patch History API
      const wrap = fn => function (...a) { fn.apply(this, a); setTimeout(injectSurfButton, 500); };
      history.pushState   = wrap(history.pushState);
      history.replaceState = wrap(history.replaceState);
      window.addEventListener('popstate', () => setTimeout(injectSurfButton, 500));
    }
  }

  // Watch the header specifically (not the whole document) for the button being
  // removed by Netflix's re-renders. Much cheaper than document-level observation.
  function watchNavForRemoval() {
    if (navObserver) return;
    // Delay until the header actually exists
    const header = document.querySelector('header, .pinning-header-container');
    const target  = header ?? document.body;
    navObserver = new MutationObserver(() => {
      if (!document.getElementById('cs-surf-btn')) injectSurfButton();
    });
    navObserver.observe(target, { childList: true, subtree: true });
  }

  // ─── Watch page ───────────────────────────────────────────────────────────────

  async function handleWatchPage() {
    // Always inject the floating surf button on player pages (with a short delay
    // so it doesn't flash during initial DRM / loading state)
    setTimeout(injectWatchSurfButton, 3000);

    const r       = await chrome.storage.session.get(STORAGE_PENDING);
    const pending  = r[STORAGE_PENDING];

    // No flag, or stale flag (user navigated here manually)
    if (!pending || Date.now() - pending.ts > PENDING_TTL_MS) return;

    await chrome.storage.session.remove(STORAGE_PENDING);

    seekLeft = 60; // poll for up to 30 s (60 × 500 ms)
    pollForSeek();
  }

  function pollForSeek() {
    if (seekLeft-- <= 0) return;

    const video = document.querySelector('video');

    // readyState >= 2 means HAVE_CURRENT_DATA (metadata + current frame available).
    // duration < 30 filters out DRM init probes / pre-roll clips.
    if (!video || video.readyState < 2 || !video.duration ||
        isNaN(video.duration) || video.duration < 30) {
      setTimeout(pollForSeek, 500);
      return;
    }

    doSeek(video);
  }

  async function doSeek(video) {
    const dur      = video.duration;
    const seekTime = settings.seekMin * dur + Math.random() * (settings.seekMax - settings.seekMin) * dur;
    const ms       = Math.round(seekTime * 1000);

    // Try the Netflix internal API first (via page bridge).
    // It respects the player's state machine and works with DRM-encrypted streams.
    toPage('cs:seek', { ms });
    const result = await fromPage('cs:seek:done', 1500);

    if (!result?.ok) {
      // Fallback: direct video element seek (works for non-DRM or when API unavailable)
      video.currentTime = seekTime;
    }

    // Verify the seek wasn't silently reset to 0 by Netflix's player initialisation
    // (this can happen in the first few seconds). If so, re-apply after a short delay.
    setTimeout(() => {
      const v = document.querySelector('video');
      if (v && v.currentTime < 5 && seekTime > 30) {
        toPage('cs:seek', { ms });
        // best-effort only — don't loop
      }
    }, 1800);

    const pct = Math.round((seekTime / dur) * 100);
    showToast(`📺  Tuned in at ${fmtTime(seekTime)} · ${pct}% through`);
  }

  // ─── Floating surf button (watch / player page) ───────────────────────────────

  function injectWatchSurfButton() {
    if (document.getElementById('cs-watch-surf-btn')) return;
    const btn = document.createElement('button');
    btn.id        = 'cs-watch-surf-btn';
    btn.className = 'cs-watch-surf-btn';
    btn.setAttribute('aria-label', 'Channel Surf');
    btn.innerHTML = tvSVG(20) + '<span>Surf</span>';
    btn.addEventListener('click', surfFromWatch);
    document.body.appendChild(btn);
  }

  async function surfFromWatch() {
    // Use "More Like This" / related content rendered in the player page if present.
    // These are /watch/ links Netflix loads beneath the player.
    const domIds = idsFromDOM();
    if (domIds.length) {
      await surf(domIds);
    } else {
      // No related content visible — go to browse; the surf button there lets the
      // user pick, or auto-surf kicks in if set.
      await chrome.storage.session.set({ [STORAGE_AUTOSURF]: true });
      window.location.href = 'https://www.netflix.com/browse';
    }
  }

  // ─── Auto-surf on browse load (triggered from popup or watch → browse) ─────────

  async function checkAutoSurf() {
    const r = await chrome.storage.session.get(STORAGE_AUTOSURF);
    if (!r[STORAGE_AUTOSURF]) return;
    await chrome.storage.session.remove(STORAGE_AUTOSURF);
    // Give the page time to populate before collecting IDs
    setTimeout(() => surf(), 3000);
  }

  // ─── UI helpers ───────────────────────────────────────────────────────────────

  function showSurfingOverlay(callback) {
    const el = document.createElement('div');
    el.id        = 'cs-overlay';
    el.innerHTML =
      '<div class="cs-static-grain"></div>' +
      '<div class="cs-overlay-label">' +
        '<div class="cs-tv-emoji">📺</div>' +
        '<div class="cs-overlay-text">Channel Surfing\u2026</div>' +
      '</div>';
    document.body.appendChild(el);
    requestAnimationFrame(() => {
      el.classList.add('cs-overlay-on');
      setTimeout(callback, 650);
    });
  }

  function showToast(msg, durationMs = 4500) {
    document.getElementById('cs-toast')?.remove();
    const t = document.createElement('div');
    t.id        = 'cs-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(() => {
      t.classList.add('cs-toast-on');
      setTimeout(() => {
        t.classList.remove('cs-toast-on');
        setTimeout(() => t.remove(), 400);
      }, durationMs);
    });
  }

  function fmtTime(s) {
    const h  = Math.floor(s / 3600);
    const m  = Math.floor((s % 3600) / 60);
    const ss = Math.floor(s % 60);
    const p  = n => String(n).padStart(2, '0');
    return h ? `${h}:${p(m)}:${p(ss)}` : `${m}:${p(ss)}`;
  }

  function tvSVG(size) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"` +
      ` stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
      `<rect x="2" y="7" width="20" height="15" rx="2"/>` +
      `<polyline points="17 2 12 7 7 2"/>` +
      `<circle cx="12" cy="17" r="1" fill="currentColor" stroke="none"/>` +
      `</svg>`;
  }

  // ─── Initialization ───────────────────────────────────────────────────────────

  async function init() {
    await loadSettings();
    injectBridge();

    if (pageType() === 'watch') {
      await handleWatchPage();
    } else {
      listenToSPANavigation();

      // Try injecting at startup and after React hydration
      injectSurfButton();
      setTimeout(injectSurfButton, 1500);
      setTimeout(() => {
        watchNavForRemoval();
        injectSurfButton();
      }, 3000);

      // Auto-surf if triggered from popup or from watch → browse redirect
      checkAutoSurf();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
