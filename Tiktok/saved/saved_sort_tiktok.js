// Page-world script — TikTok Saved-surfaces sorting (Favorites, Liked,
// Collection). Counterpart to script_tiktok.js (profile) and
// search_sort_tiktok.js (search). Wraps `fetch` for the three saved endpoints
// and bails unless a saved surface flag is active, so the profile and search
// fetch hooks stay byte-identical.
//
// ⚠️ TikTok endpoint-name inversion — the endpoint name is the OPPOSITE of the
// UI label:
//     Favorites tab → /api/user/collect/item_list/   (surface "ttfavorites")
//     Liked tab     → /api/favorite/item_list/        (surface "ttliked")
//     Collection    → /api/collection/item_list/      (surface "ttcollection")
//
// The item shape inside `itemList` is identical to a profile
// /api/post/item_list item, so buildMetadata matches createMetadataJsonTikTok.
//
// Wrapped in an IIFE so locals can't collide with script_tiktok.js /
// search_sort_tiktok.js. Coexists with their fetch wraps — the four wraps
// target non-overlapping URLs, so only one acts per request.

(() => {
  if (window.__sfSavedFetchHooked) return;
  window.__sfSavedFetchHooked = true;

  const SF_TT_SAVED_DEBUG = false;

  // surface flag → { endpoint substring, tile container, grid container }
  const SURFACE_MAP = {
    ttfavorites: {
      endpoint: "/api/user/collect/item_list",
      tile:     '[data-e2e="favorites-item"]',
      grid:     '[data-e2e="favorites-item-list"]',
    },
    ttliked: {
      endpoint: "/api/favorite/item_list",
      tile:     '[data-e2e="user-liked-item"]',
      grid:     '[data-e2e="user-liked-item-list"]',
    },
    ttcollection: {
      endpoint: "/api/collection/item_list",
      tile:     '[data-e2e="collection-item"]',
      grid:     '[data-e2e="collection-item-list"]',
    },
  };

  const activeSurface = () => {
    const s = sessionStorage.getItem("feedRankSurfaceTikTok");
    return SURFACE_MAP[s] ? s : null;
  };

  // Only the endpoint that matches the ACTIVE surface is parsed. This keeps a
  // stray fetch for a different saved endpoint (e.g. if TikTok prefetches a
  // sibling tab) from contaminating the current sort.
  const matchesActiveSaved = (url) => {
    const surface = activeSurface();
    if (!surface) return false;
    return String(url).includes(SURFACE_MAP[surface].endpoint);
  };

  // Local accumulator — separate from profile/search memories.
  const sfSavedMemory = { items: [] };

  // One-shot finalize guard (TikTok can fire parallel page fetches).
  let sfSavedFinalized = false;

  // Did the saved list run out of pages? Recorded per sort for the back-to-back
  // re-sort router (Tiktok/resort_tiktok.js) and cleared on reset_tiktok_session.
  let sfSavedExhausted = false;

  // ─── Stop Sorting — immediate abort ──────────────────────────────────────
  // Mirrors script_tiktok.js's `_sfStopTk`, self-contained because this file is
  // its own IIFE. The banner's Stop raises `feedRankStopSorting` AND posts
  // `sf_stop_sorting`; the flag alone could only be polled, and the poll sits
  // *after* `await findElement`, which backs off across 12 attempts (~9s worst
  // case) plus a 1.2s media wait.
  const sfStopSaved = { requested: false, sleepers: new Set() };

  function stopRequested() {
    if (sfStopSaved.requested) return true;
    try {
      return sessionStorage.getItem("feedRankStopSorting") === "on";
    } catch (e) {
      return false;
    }
  }

  // Abortable sleep — the finder's pacing primitive.
  function stopSleep(ms) {
    return new Promise((resolve) => {
      if (sfStopSaved.requested) { resolve(); return; }
      const rec = { resolve: resolve, timer: null, settled: false };
      rec.timer = setTimeout(() => {
        if (rec.settled) return;
        rec.settled = true;
        sfStopSaved.sleepers.delete(rec);
        resolve();
      }, ms);
      sfStopSaved.sleepers.add(rec);
    });
  }

  function flushSleepers() {
    const pending = Array.from(sfStopSaved.sleepers);
    sfStopSaved.sleepers.clear();
    pending.forEach((rec) => {
      if (rec.settled) return;
      rec.settled = true;
      clearTimeout(rec.timer);
      try { rec.resolve(); } catch (e) {}
    });
  }

  // Abort everything in flight and finish from what's already collected —
  // including when Stop lands between pages, where no batch is running.
  function stopNow() {
    if (sfStopSaved.requested) return;
    sfStopSaved.requested = true;
    flushSleepers();
    finalizeSort(sfSavedMemory.items);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data || !event.data.sf_stop_sorting) return;
    // Saved surfaces only — the profile and search scripts get this same
    // broadcast. activeSurface() is non-null exactly for favorites/liked/collection.
    if (!activeSurface()) return;
    stopNow();
  });

  // ─── Data shape (identical to profile/search items) ──────────────────────
  // ─── Player media capture ────────────────────────────────────────────────────
  // The feed payload already carries everything the in-page player needs to
  // start with NO network call: the playable URL, the duration, the 9:16 cover
  // and — for photo posts — every image. Captured here at sort time, stamped
  // into data-sf-item-json by the renderer, and preferred by the resolver
  // (Tiktok/player/player_resolve_tiktok.js) while the signed URLs are fresh.
  // `mediaAt` is the capture clock for URLs that print no expiry of their own.
  //
  // Prefer an H.264 rendition: Chrome decodes it everywhere, where the top
  // bitrate entry is often H.265 (bytevc1) and hardware-dependent. Same picker
  // as the resolver's _sfPlTkPickPlayUrl — keep the two in step.
  function _sfTkPlayerMedia(item) {
    const video = item?.video;
    let playAddr = null;
    if (video) {
      const bi = Array.isArray(video.bitrateInfo) ? video.bitrateInfo : [];
      let bestBr = -1;
      for (const b of bi) {
        const url = b?.PlayAddr?.UrlList?.[0];
        if (!url) continue;
        const codec = String(b.CodecType || "").toLowerCase();
        if (codec && !/h264|avc/.test(codec)) continue;
        const br = Number(b.Bitrate) || 0;
        if (br > bestBr) { bestBr = br; playAddr = url; }
      }
      playAddr = playAddr || video.playAddr || bi[0]?.PlayAddr?.UrlList?.[0] || video.downloadAddr || null;
    }
    const images = Array.isArray(item?.imagePost?.images) ? item.imagePost.images : null;
    const imageUrls = images ? images.map((im) => im?.imageURL?.urlList?.[0]).filter(Boolean) : null;
    return {
      playAddr,
      durationSecs: Number.isFinite(video?.duration) ? video.duration : null,
      coverUrl: (images && item?.imagePost?.cover?.imageURL?.urlList?.[0]) || video?.cover || video?.originCover || null,
      imageUrls: imageUrls && imageUrls.length ? imageUrls : null,
      mediaAt: Date.now(),
    };
  }

  function buildMetadata(item) {
    const ts = item?.createTime ? item.createTime * 1000 : null;
    const desc = typeof item?.desc === "string" && item.desc.trim() !== "" ? item.desc : " ";
    return {
      createDate:    ts ? new Date(ts).toISOString() : "",
      code:          item?.id || "",
      userName:      item?.author?.uniqueId || "",
      viewCount:     item?.stats?.playCount ?? null,
      likesCount:    item?.stats?.diggCount ?? null,
      commentsCount: item?.stats?.commentCount ?? null,
      shareCount:    item?.stats?.shareCount ?? null,
      savesCount:    item?.stats?.collectCount ?? null,
      caption:       desc,
      photoFlag:     Array.isArray(item?.imagePost?.images) && item.imagePost.images.length > 0,
      musicUrl:      item?.music?.playUrl ?? null,
      // Player media (playAddr / duration / cover / photo images / capture clock).
      ..._sfTkPlayerMedia(item),
    };
  }

  // ─── DOM lookup ───────────────────────────────────────────────────────────
  // Same cautious idle+jitter polling as profile's find_element_tiktok_again /
  // search's findElement — only the tile/grid selectors differ per surface.
  function findElement(id, opts = {}) {
    const {
      maxAttempts    = 12,
      baseDelayMs    = 220,
      maxDelayMs     = 1200,
      mediaTimeoutMs = 1200,
    } = opts;

    // Stop makes this wait inactive immediately — the flag read alone would
    // only be seen after the current sleep finished (up to 1.2s).
    const isActive = () =>
      !!sessionStorage.getItem("feedRankStatusTikTok") &&
      !!activeSurface() &&
      !sfStopSaved.requested;

    // Abortable: Stop settles every pending sleep on the click's own tick.
    const sleep = (ms) => stopSleep(ms);
    const jitter = (ms, spread = 0.35) => {
      const delta = ms * spread;
      return Math.max(0, Math.round(ms + (Math.random() * 2 - 1) * delta));
    };
    const runWhenIdle = (fn) =>
      new Promise((resolve) => {
        if (typeof requestIdleCallback === "function") {
          requestIdleCallback(() => resolve(fn()), { timeout: 300 });
        } else {
          setTimeout(() => resolve(fn()), 0);
        }
      });

    const inViewport = (el) => {
      const r = el.getBoundingClientRect();
      return r.top >= -50 && r.top <= window.innerHeight - 120;
    };
    const gentleScrollToward = async (el) => {
      if (inViewport(el)) return;
      el.scrollIntoView({ block: "center", behavior: "auto" });
      await sleep(jitter(120, 0.5));
    };

    const findBlock = () => {
      const surface = activeSurface();
      if (!surface) return null;
      const { tile, grid } = SURFACE_MAP[surface];
      const gridEl = document.querySelector(grid);
      const root = gridEl || document;
      // Saved tiles link to /video/ID or /photo/ID — match on the id suffix.
      const anchor =
        root.querySelector(`a[href$="/${id}"]`) ||
        root.querySelector(`a[href*="/${id}?"]`) ||
        root.querySelector(`a[href*="/${id}/"]`);
      if (!anchor) return null;
      return anchor.closest(tile) || null;
    };

    const mediaLooksReady = (block) => {
      const img = block.querySelector("img");
      if (!img) return true;
      const src = img.currentSrc || img.src || img.getAttribute("src") || "";
      if (!src || src.startsWith("data:")) return false;
      if (!img.complete) return false;
      return (img.naturalWidth || 0) > 0 && (img.naturalHeight || 0) > 0;
    };
    const waitForMedia = async (block) => {
      const start = performance.now();
      while (performance.now() - start < mediaTimeoutMs) {
        if (!isActive()) return null;
        if (mediaLooksReady(block)) return block;
        await sleep(jitter(180, 0.5));
        if (sfStopSaved.requested) return null; // Stop cut the sleep short
      }
      return block;
    };

    return new Promise(async (resolve) => {
      if (!isActive()) return resolve(null);
      let delay = baseDelayMs;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (!isActive()) return resolve(null);
        const block = await runWhenIdle(findBlock);
        if (!isActive()) return resolve(null);
        if (block) {
          await gentleScrollToward(block);
          if (!isActive()) return resolve(null);
          const ready = await waitForMedia(block);
          return resolve(ready);
        }
        await sleep(jitter(delay));
        if (!isActive()) return resolve(null); // Stop cut the sleep short
        delay = Math.min(maxDelayMs, Math.round(delay * 1.35));
      }
      resolve(null);
    });
  }

  // ─── Sort utility ─────────────────────────────────────────────────────────
  // Saved order is "recently saved", not chronological, so "oldest" sorts by
  // createDate ascending (same as search — NOT a reverse()).
  function sortItems(data, sortBy) {
    if (sortBy === "views")    return [...data].sort((a, b) => (b.viewCount     ?? 0) - (a.viewCount     ?? 0));
    if (sortBy === "likes")    return [...data].sort((a, b) => (b.likesCount    ?? 0) - (a.likesCount    ?? 0));
    if (sortBy === "comments") return [...data].sort((a, b) => (b.commentsCount ?? 0) - (a.commentsCount ?? 0));
    if (sortBy === "shares")   return [...data].sort((a, b) => (b.shareCount    ?? 0) - (a.shareCount    ?? 0));
    if (sortBy === "saves")    return [...data].sort((a, b) => (b.savesCount    ?? 0) - (a.savesCount    ?? 0));
    if (sortBy === "oldest") {
      return [...data].sort((a, b) => {
        const ta = a.createDate ? Date.parse(a.createDate) : 0;
        const tb = b.createDate ? Date.parse(b.createDate) : 0;
        return ta - tb;
      });
    }
    return data;
  }

  function readTarget() {
    const value = sessionStorage.getItem("feedRankNoItems") || "";
    if (value === "all_reels") return 10000; // saved lists are finite; defensive cap
    const m = value.match(/^(\d+)_reels$/);
    return m ? parseInt(m[1], 10) : 25;
  }

  // ─── Banner / overlay postMessages (same names the profile flow uses) ─────
  const notifyOverlayOn = () => {
    if (!document.getElementById("overlay_sort_reels")) {
      window.postMessage({ overlay_on: true }, "*");
    }
  };
  const notifyCollected = (n) =>
    window.postMessage({ item_collected_no: true, number_items: n }, "*");

  // "All" has no item target, so the banner had nothing to compute a percentage
  // from and its bar sat at 0% for the whole scrape before the finish animation
  // snapped it to 100. Every numeric target ("50 TikToks") is unaffected: the
  // banner's own count ÷ target still owns the bar there.
  //
  // Minimal shape of the profile's open-ended sorts (_sfTkScanProgress in
  // script_tiktok.js): a decelerating work curve — there's no date boundary to
  // measure against on the saved surfaces, since date sorts are blocked here —
  // floored once TikTok reports hasMore === false, which means the whole list is
  // in hand and only per-item DOM work remains.
  const SF_TT_SAVED_SCAN_K = 60;            // knee of the work curve, in items
  const SF_TT_SAVED_SCAN_LAST_PAGE_FLOOR = 0.9;

  function savedScanProgress(count) {
    if ((sessionStorage.getItem("feedRankNoItems") || "") !== "all_reels") return null;
    let progress = count / (count + SF_TT_SAVED_SCAN_K);
    if (sfSavedExhausted) progress = Math.max(progress, SF_TT_SAVED_SCAN_LAST_PAGE_FLOOR);
    return Math.max(0, Math.min(1, progress));
  }

  const notifyBanner = (n) => {
    const msg = { insta_banner_notification: true, count: n };
    const scan = savedScanProgress(n);
    if (scan !== null) msg.scanProgress = scan;
    window.postMessage(msg, "*");
  };
  const removeBanner = () =>
    window.postMessage({ insta_banner_notification_remove: true }, "*");
  const removeOverlay = () => document.getElementById("overlay_sort_reels")?.remove();

  // ─── Single exit point ────────────────────────────────────────────────────
  // The natural completion chain AND the Stop express route both come through
  // here; `sfSavedFinalized` guarantees only the first one renders.
  function finalizeSort(collected) {
    if (sfSavedFinalized) return;
    sfSavedFinalized = true;

    sessionStorage.removeItem("feedRankStopSorting");
    sessionStorage.removeItem("feedRankStatusTikTok");
    // Blocks subsequent saved fetches so TikTok's infinite-scroll spinner stays
    // dead after the sort.
    sessionStorage.setItem("feedRankSortDoneTikTok", "true");

    const list = Array.isArray(collected) ? collected : [];
    const surface = sessionStorage.getItem("feedRankSurfaceTikTok");

    // Stopped before a single tile finished capturing — nothing to render, so
    // leave TikTok's own grid alone and just clear our chrome.
    if (!list.length) {
      removeBanner();
      removeOverlay();
      return;
    }

    const sortBy = sessionStorage.getItem("feedRankSortBy");
    const sorted = sortItems(list, sortBy);

    removeBanner();
    removeOverlay();

    if (SF_TT_SAVED_DEBUG) {
      console.log("[SF][tt-saved] sort complete —", sorted.length, "items, surface:", surface, "sortBy:", sortBy);
    }

    window.postMessage(
      {
        logo_animate_off_tiktok_saved: true,
        payload: sorted,
        sf_tt_surface: surface,
        // What this scrape covered, for the back-to-back re-sort router.
        // Favorites and Liked share the generic /@user URL, so `surface` — not
        // the path — is what keeps the two apart.
        sf_ctx: {
          mode: sessionStorage.getItem("sortItemsVsDates"),
          selection: sessionStorage.getItem("feedRankNoItems"),
          sortBy: sortBy,
          surface: surface,          // ttfavorites | ttliked | ttcollection
          path: location.pathname,
          search: location.search,
          collectedCount: list.length,
          feedExhausted: sfSavedExhausted,
          pinnedSkipped: false,      // date sorts are blocked here, so nothing to skip
          stoppedByUser: sfStopSaved.requested,
          outlier: null,             // saved surfaces are multi-creator — no outlier
        },
      },
      "*",
    );
  }

  // ─── Per-batch collection loop (mirror search/profile exit cases) ─────────
  async function processBatch(items, hasMore, target) {
    for (let i = 0; i < items.length; i++) {
      // Stop owns the finish from here on — bail without returning items (the
      // express route already finalized; stopNow is a no-op if so).
      if (stopRequested()) { stopNow(); return null; }

      const meta = buildMetadata(items[i]);
      const element = await findElement(meta.code);

      // Checked BEFORE the item is saved: an aborted wait hands back a null
      // element, and saving that would paint a blank tile.
      if (stopRequested()) { stopNow(); return null; }

      if (element) meta.element = element.outerHTML;

      // Arrival index = "recently saved" order, which is what these grids show.
      // Nothing on the item records WHEN it was saved, so a narrowing re-sort
      // ("50 → latest 25") has to slice on this or it would return the 25 most
      // recently POSTED — a different set entirely.
      meta._sfSeq = sfSavedMemory.items.length;
      sfSavedMemory.items.push(meta);

      if (!sessionStorage.getItem("feedRankStatusTikTok")) {
        return sfSavedMemory.items;
      }

      notifyCollected(sfSavedMemory.items.length);
      notifyBanner(sfSavedMemory.items.length);

      // Case 00 — user clicked Stop Sorting
      if (sessionStorage.getItem("feedRankStopSorting") === "on") {
        sessionStorage.removeItem("feedRankStopSorting");
        sessionStorage.removeItem("feedRankStatusTikTok");
        removeBanner();
        return sfSavedMemory.items;
      }
      // Case 01 — hit the chosen count
      if (sfSavedMemory.items.length >= target) {
        sessionStorage.removeItem("feedRankStopSorting");
        sessionStorage.removeItem("feedRankStatusTikTok");
        return sfSavedMemory.items;
      }
      // Case 02 — last item, no more pages
      if (i === items.length - 1 && !hasMore) {
        sessionStorage.removeItem("feedRankStopSorting");
        sessionStorage.removeItem("feedRankStatusTikTok");
        return sfSavedMemory.items;
      }
      // Case 03 — last item, more pages → wait for next fetch
      if (i === items.length - 1 && hasMore) {
        return null;
      }
    }
    return null;
  }

  // ─── Fetch wrap ───────────────────────────────────────────────────────────
  const _fetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : (input?.url || "");
    const isSaved = matchesActiveSaved(url);

    // Short-circuit subsequent saved fetches once the sort is done, so TikTok's
    // native infinite-scroll spinner doesn't spin forever.
    if (isSaved && sessionStorage.getItem("feedRankSortDoneTikTok") === "true") {
      return new Response('{"statusCode":0,"itemList":[],"hasMore":false}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const res = await _fetch.apply(this, arguments);
    if (!isSaved) return res;

    try {
      if (!sessionStorage.getItem("feedRankStatusTikTok")) return res;

      const clone = res.clone();
      const text = await clone.text();
      if (!text.trim().startsWith("{")) return res;

      const data = JSON.parse(text);
      const items = Array.isArray(data?.itemList)
        ? data.itemList.filter((it) => it?.id && it?.stats)
        : [];

      if (SF_TT_SAVED_DEBUG) {
        console.log("[SF][tt-saved] saw fetch", {
          surface: activeSurface(), extracted: items.length, url: url.split("?")[0],
        });
      }
      if (items.length === 0) return res;

      const hasMore = !!(data?.hasMore);
      // Recorded for the re-sort router: saved lists are finite, so "no more
      // pages" means the collected set answers every later request, however wide.
      sfSavedExhausted = !hasMore;
      notifyOverlayOn();

      processBatch(items, hasMore, readTarget()).then((collected) => {
        if (!collected) return;           // more pages expected
        finalizeSort(collected);
      });
    } catch (err) {
      if (SF_TT_SAVED_DEBUG) console.warn("[SF][tt-saved] wrap error (swallowed)", err);
    }

    return res;
  };

  // Reset accumulator + finalize guard on a fresh sort.
  window.addEventListener("message", (event) => {
    if (
      event.source === window &&
      event.data?.source === "feedrank" &&
      event.data?.type === "reset_tiktok_session"
    ) {
      sfSavedMemory.items = [];
      sfSavedFinalized = false;
      sfSavedExhausted = false;
      // TikTok sorts don't always reload, so the Stop state has to be cleared
      // here too — otherwise a sort started after a Stop aborts immediately.
      sfStopSaved.requested = false;
      flushSleepers();
    }
  });
})();
