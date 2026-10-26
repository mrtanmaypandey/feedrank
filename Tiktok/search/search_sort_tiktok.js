// Page-world script — TikTok Search-results sorting (counterpart to
// script_tiktok.js's profile flow). Wraps `fetch` for `/api/search/item/full`
// and bails out unless `sortFeedSurfaceTikTok === "search"`, so the profile
// fetch hook in script_tiktok.js stays byte-identical.
//
// Architecture mirrors Instagram's explore_sort_instagram.js: a separate file,
// surface-gated at the top, posting a distinct done-event so the renderer in
// Phase 03 can branch without entangling the profile path.
//
// Wrapped in an IIFE so all locals (`sfSearchMemory`, helpers, etc.) stay off
// the page-world global scope and can't collide with script_tiktok.js.

(() => {
  if (window.__sfSearchFetchHooked) return;
  window.__sfSearchFetchHooked = true;

  const SF_SEARCH_DEBUG = false;
  // Known result-listing endpoints — one per tab. Enumerated (rather than
  // matching `/api/search/` broadly) so we don't accidentally short-circuit
  // autocomplete / suggestion / related-search fetches that TikTok also
  // fires from the same page.
  //   /api/search/item/full    → Videos tab
  //   /api/search/general/full → Top tab (mixed: videos, users, sounds)
  //   /api/search/photo/full   → Photo tab
  const SEARCH_URLS = [
    "/api/search/item/full",
    "/api/search/general/full",
    "/api/search/photo/full",
  ];
  const matchesSearch = (url) => SEARCH_URLS.some((u) => String(url).includes(u));

  // Local accumulator. Kept separate from script_tiktok.js's `inMemoryFeedData`
  // so profile and search sorts can't ever step on each other.
  const sfSearchMemory = { items: [] };

  // Did TikTok run out of result pages? Recorded per sort for the back-to-back
  // re-sort router (Tiktok/resort_tiktok.js) and cleared on reset_tiktok_session.
  let sfSearchExhausted = false;

  // One-shot finalize guard. TikTok search prefetches multiple pages on
  // first paint, so two `processBatch` loops can race past the target
  // threshold and both reach the finalize block. Without this latch we
  // get two banners (the second renders "undefined" because the first
  // finalize already wiped sessionStorage). Reset on reset_tiktok_session
  // so a fresh sort can finalize again.
  let sfSortFinalized = false;

  // ─── Stop Sorting — immediate abort ───────────────────────────────────
  // Mirrors script_tiktok.js's `_sfStopTk`, self-contained because this file
  // is its own IIFE. The banner's Stop raises `sortFeedStopSorting` AND posts
  // `sf_stop_sorting`; the flag alone could only be polled, and the poll sits
  // *after* `await findElement`, which backs off across 12 attempts (~9s worst
  // case) plus a 1.2s media wait.
  const sfStopSearch = { requested: false, sleepers: new Set() };

  function stopRequested() {
    if (sfStopSearch.requested) return true;
    try {
      return sessionStorage.getItem("sortFeedStopSorting") === "on";
    } catch (e) {
      return false;
    }
  }

  // Abortable sleep — the finder's pacing primitive.
  function stopSleep(ms) {
    return new Promise((resolve) => {
      if (sfStopSearch.requested) { resolve(); return; }
      const rec = { resolve: resolve, timer: null, settled: false };
      rec.timer = setTimeout(() => {
        if (rec.settled) return;
        rec.settled = true;
        sfStopSearch.sleepers.delete(rec);
        resolve();
      }, ms);
      sfStopSearch.sleepers.add(rec);
    });
  }

  function flushSleepers() {
    const pending = Array.from(sfStopSearch.sleepers);
    sfStopSearch.sleepers.clear();
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
    if (sfStopSearch.requested) return;
    sfStopSearch.requested = true;
    flushSleepers();
    finalizeSort(sfSearchMemory.items);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data || !event.data.sf_stop_sorting) return;
    // Search only — the profile and saved scripts get this same broadcast.
    if (sessionStorage.getItem("sortFeedSurfaceTikTok") !== "search") return;
    stopNow();
  });

  // ─── Data shape ───────────────────────────────────────────────────────
  // The search payload's items are byte-identical in shape to a profile
  // /api/post/item_list item, so this function is the same as
  // createMetadataJsonTikTok in script_tiktok.js. Duplicated here intentionally
  // to keep the two surfaces fully decoupled (one file = one surface).
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

  // ─── DOM lookup ───────────────────────────────────────────────────────
  // Find the rendered tile for a given video/photo id. Selector contract:
  //   - Tile container is `[data-e2e^="search_"][data-e2e$="-item"]` for all
  //     three tabs (Top / Video / Photo).
  //   - The anchor inside is absolute (`https://www.tiktok.com/@user/video/ID`)
  //     so we substring-match on `/${id}` rather than building a full URL.
  // Mirrors the cautious idle+jitter polling pattern from
  // find_element_tiktok_again so we don't hammer TikTok's anti-bot.
  function findElement(id, opts = {}) {
    // Defaults match script_tiktok.js's find_element_tiktok_again byte-for-
    // byte. Keeping them aligned with profile gives identical per-item
    // pacing, which is what makes profile sort feel smooth and fast.
    const {
      maxAttempts    = 12,
      baseDelayMs    = 220,
      maxDelayMs     = 1200,
      mediaTimeoutMs = 1200,
      scrollPadding  = 140,
    } = opts;

    // Stop makes this wait inactive immediately — the flag read alone would
    // only be seen after the current sleep finished (up to 1.2s).
    const isActive = () =>
      sessionStorage.getItem("sortFeedStatusTikTok") &&
      sessionStorage.getItem("sortFeedSurfaceTikTok") === "search" &&
      !sfStopSearch.requested;

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

    // Same per-item nudge pattern profile uses, but via scrollIntoView
    // instead of window.scrollTo. Profile pages scroll the window; search
    // pages wrap the grid in a custom scroll container (window.scrollY
    // stays 0 no matter what you do with scrollTo). scrollIntoView walks
    // the scroll-parent chain itself, so it works on both surfaces —
    // letting us keep the rest of the find-element loop byte-identical
    // to profile's find_element_tiktok_again.
    const gentleScrollToward = async (el) => {
      if (inViewport(el)) return;
      el.scrollIntoView({ block: "center", behavior: "auto" });
      await sleep(jitter(120, 0.5));
    };

    const findBlock = () => {
      // Scope tile lookup to the active search grid. TikTok's Top tab can
      // show the SAME video both in a featured carousel above the grid AND
      // in the main grid below — without scoping, querySelector returns the
      // carousel anchor first, whose tile lives in a different DOM subtree
      // with separate load timing (often empty when we capture).
      // Fall back to document if the grid hasn't mounted yet.
      const grid = document.querySelector(
        '[data-e2e^="search_"][data-e2e$="-item-list"]',
      );
      const root = grid || document;
      // /video/ID or /photo/ID — id is the suffix segment, so anchor matches
      // on `/${id}` for both URL shapes.
      const anchor =
        root.querySelector(`a[href$="/${id}"]`) ||
        root.querySelector(`a[href*="/${id}?"]`) ||
        root.querySelector(`a[href*="/${id}/"]`);
      if (!anchor) return null;
      return anchor.closest('[data-e2e^="search_"][data-e2e$="-item"]') || null;
    };

    // Check the THUMBNAIL specifically (the first <img> in DOM order, which
    // is inside the tile's <picture> wrapper). Profile tiles only have the
    // thumbnail, so its mediaLooksReady can check "first 2 imgs". Search
    // tiles also include a profile pic for the creator — and that loads
    // first. If we read mediaLooksReady against the profile pic instead of
    // the thumbnail, we capture outerHTML before the thumbnail's <img src>
    // is populated, which renders as an empty rectangle in the sorted grid.
    const mediaLooksReady = (block) => {
      const img = block.querySelector("img");
      if (!img) return true; // no media expected
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
        if (sfStopSearch.requested) return null; // Stop cut the sleep short
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

  // ─── Sort utility ─────────────────────────────────────────────────────
  // Search results come back in relevance order, so "oldest" must sort by
  // createDate ascending. Profile's `reverse()` only works because the profile
  // feed is chronological — search isn't.
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
    const value = sessionStorage.getItem("sortFeedNoItems") || "";
    if (value === "all_reels") return 10000; // blocked upstream, defensive cap
    const m = value.match(/^(\d+)_reels$/);
    return m ? parseInt(m[1], 10) : 25;
  }

  // ─── Banner / overlay postMessages (surface-agnostic — same names the
  // profile flow uses, so banner_on_tiktok.js + update_tiktok_ui.js handle
  // them with zero changes).
  const notifyOverlayOn = () => {
    if (!document.getElementById("overlay_sort_reels")) {
      window.postMessage({ overlay_on: true }, "*");
    }
  };
  const notifyCollected = (n) =>
    window.postMessage({ item_collected_no: true, number_items: n }, "*");
  const notifyBanner = (n) =>
    window.postMessage({ insta_banner_notification: true, count: n }, "*");
  const removeBanner = () =>
    window.postMessage({ insta_banner_notification_remove: true }, "*");
  const removeOverlay = () => document.getElementById("overlay_sort_reels")?.remove();

  // ─── Single exit point ────────────────────────────────────────────────
  // The natural completion chain AND the Stop express route both come through
  // here; `sfSortFinalized` guarantees only the first one renders. TikTok
  // prefetches multiple search pages on first paint, so two processBatch loops
  // can race past the target — that's what the latch was already for.
  function finalizeSort(collected) {
    if (sfSortFinalized) return;
    sfSortFinalized = true;

    sessionStorage.removeItem("sortFeedStopSorting");
    sessionStorage.removeItem("sortFeedStatusTikTok");
    // Blocks subsequent search fetches with a synthetic empty response so
    // TikTok's native infinite-scroll spinner stays dead after the sort.
    sessionStorage.setItem("sortFeedSortDoneTikTok", "true");

    const list = Array.isArray(collected) ? collected : [];

    // Stopped before a single tile finished capturing — nothing to render, so
    // leave TikTok's own results alone and just clear our chrome.
    if (!list.length) {
      removeBanner();
      removeOverlay();
      return;
    }

    const sortBy = sessionStorage.getItem("sortFeedSortBy");
    const sorted = sortItems(list, sortBy);

    removeBanner();
    removeOverlay();

    if (SF_SEARCH_DEBUG) {
      console.log("[SF][search] sort complete —", sorted.length, "items, sortBy:", sortBy);
    }

    window.postMessage(
      {
        logo_animate_off_tiktok_search: true,
        payload: sorted,
        // What this scrape covered, for the back-to-back re-sort router. The
        // keyword lives in `?q=`, so `search` is what stops a sort of "coffee"
        // from being answered out of the "tea" grid.
        sf_ctx: {
          mode: sessionStorage.getItem("sortItemsVsDates"),
          selection: sessionStorage.getItem("sortFeedNoItems"),
          sortBy: sortBy,
          surface: "search",
          path: location.pathname,
          search: location.search,
          collectedCount: list.length,
          feedExhausted: sfSearchExhausted,
          pinnedSkipped: false,      // search has no date sorts, so nothing to skip
          stoppedByUser: sfStopSearch.requested,
          outlier: null,             // outlier is profile-Videos only
        },
      },
      "*"
    );
  }

  // ─── Per-batch collection loop ────────────────────────────────────────
  // Mirrors sort_videos_tiktok in script_tiktok.js, with the three exit
  // cases (user-stop / target-reached / end-of-pages) plus the
  // keep-scrolling case that breaks out to wait for the next fetch.
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

      // Arrival index = the order TikTok ranked these results in. Relevance
      // order can't be reconstructed from anything ON the item (unlike a
      // profile's chronology), so a narrowing re-sort ("50 → latest 25") has to
      // slice on a recorded index or it would silently return the 25 most
      // recently posted instead of the top 25 results.
      meta._sfSeq = sfSearchMemory.items.length;
      sfSearchMemory.items.push(meta);

      if (!sessionStorage.getItem("sortFeedStatusTikTok")) {
        return sfSearchMemory.items;
      }

      notifyCollected(sfSearchMemory.items.length);
      notifyBanner(sfSearchMemory.items.length);

      // Case 00 — user clicked Stop Sorting on the in-page banner
      if (sessionStorage.getItem("sortFeedStopSorting") === "on") {
        sessionStorage.removeItem("sortFeedStopSorting");
        sessionStorage.removeItem("sortFeedStatusTikTok");
        removeBanner();
        return sfSearchMemory.items;
      }

      // Case 01 — collected the user's chosen count
      if (sfSearchMemory.items.length >= target) {
        sessionStorage.removeItem("sortFeedStopSorting");
        sessionStorage.removeItem("sortFeedStatusTikTok");
        return sfSearchMemory.items;
      }

      // Case 02 — last item of the batch, no more pages from TikTok
      if (i === items.length - 1 && !hasMore) {
        sessionStorage.removeItem("sortFeedStopSorting");
        sessionStorage.removeItem("sortFeedStatusTikTok");
        return sfSearchMemory.items;
      }

      // Case 03 — last item of the batch but more pages available. Same
      // shape as profile: just return null and wait for the next fetch.
      // Per-item scrollIntoView in `findElement` is aggressive enough to
      // drag the page near the load-more sentinel organically; if Top tab
      // starts stalling on some queries because of user/sound card gaps,
      // re-add the end-of-batch scrollIntoView on the last tile here.
      if (i === items.length - 1 && hasMore) {
        return null;
      }
    }
    return null;
  }

  // ─── Fetch wrap ───────────────────────────────────────────────────────
  // Coexists with script_tiktok.js's wrap. They target non-overlapping URLs
  // (/api/post/item_list vs /api/search/{item|general|photo}/full), so
  // request order doesn't affect correctness; only one wrap acts per request.
  //
  // Mirrors the profile flow's structure exactly: parse → fire-and-forget
  // processBatch().then(finalize). No concurrency latch, no scheduler —
  // profile doesn't have one either, and adding one introduced edge cases
  // that didn't show up on profile because the URL match there is tighter.
  //
  // Everything past the URL test is wrapped in try/catch so an unhandled
  // throw during page boot can't bubble out and hang the page.
  const _fetch = window.fetch;

  window.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : (input?.url || "");
    const isSearch = matchesSearch(url);

    // Short-circuit subsequent search fetches once the sort is done. Same
    // pattern profile uses for /api/post/item_list — prevents the native
    // infinite-scroll spinner from spinning forever after collection ends.
    //
    // Endpoint-aware body: /general/full uses `data: []`, the others use
    // `item_list: []`. Returning the wrong shape would risk crashing the
    // React app when it tries to read fields that aren't there.
    if (isSearch && sessionStorage.getItem("sortFeedSortDoneTikTok") === "true") {
      const body = url.includes("/general/full")
        ? '{"status_code":0,"data":[],"has_more":0}'
        : '{"status_code":0,"item_list":[],"has_more":0}';
      if (SF_SEARCH_DEBUG) console.log("[SF][search] short-circuiting (sort done)", url.slice(0, 100));
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const res = await _fetch.apply(this, arguments);
    if (!isSearch) return res;

    try {
      if (
        sessionStorage.getItem("sortFeedSurfaceTikTok") !== "search" ||
        !sessionStorage.getItem("sortFeedStatusTikTok")
      ) {
        return res;
      }

      const clone = res.clone();
      const text = await clone.text();
      if (!text.trim().startsWith("{")) return res;

      const data = JSON.parse(text);

      // Endpoint-specific response shapes seen in the wild:
      //   /api/search/item/full   → { item_list: [video items], has_more }
      //   /api/search/general/full → { data: [{ type, item }] } — Top tab,
      //                              extract only entries with a media item
      //   /api/search/photo/full   → likely { item_list } too, defensive
      // Filter to objects that look like a media item (have `id` + `stats`)
      // so we never try to sort user-cards or sound-cards.
      let items = [];
      if (Array.isArray(data?.item_list)) {
        items = data.item_list.filter((it) => it?.id && it?.stats);
      } else if (Array.isArray(data?.data)) {
        // /api/search/general/full wraps each result in { type, item } or
        // { type, item_list }. Pull media items out of either shape.
        for (const entry of data.data) {
          if (entry?.item?.id && entry?.item?.stats) items.push(entry.item);
          if (Array.isArray(entry?.item_list)) {
            items.push(...entry.item_list.filter((it) => it?.id && it?.stats));
          }
        }
      }

      if (SF_SEARCH_DEBUG) {
        console.log("[SF][search] saw fetch", {
          url: url.slice(0, 140),
          extracted: items.length,
          rawKeys: Object.keys(data || {}).slice(0, 8),
        });
      }
      if (items.length === 0) return res;

      const hasMore = !!(data?.has_more);
      // Recorded for the re-sort router: once TikTok says there are no more
      // result pages, the collected set IS everything, so a wider second sort
      // ("50 → 100") can still be served from it. Pages arrive in order, so the
      // last word wins.
      sfSearchExhausted = !hasMore;

      notifyOverlayOn();

      // Fire-and-forget — matches script_tiktok.js's pattern. If TikTok
      // fires multiple search fetches in parallel, both processBatch
      // loops will push to sfSearchMemory.items concurrently; counts only
      // grow. The `sfSortFinalized` guard ensures finalize fires once
      // even if both loops cross the target threshold.
      processBatch(items, hasMore, readTarget()).then((collected) => {
        if (!collected) return; // more pages expected, next fetch arrives
        finalizeSort(collected);
      });
    } catch (err) {
      if (SF_SEARCH_DEBUG) console.warn("[SF][search] wrap error (swallowed)", err);
    }

    return res;
  };

  // Reset accumulator + finalize guard when init script signals a fresh
  // sort. Same channel script_tiktok.js uses for its `inMemoryFeedData`.
  window.addEventListener("message", (event) => {
    if (
      event.source === window &&
      event.data?.source === "sortfeed" &&
      event.data?.type === "reset_tiktok_session"
    ) {
      sfSearchMemory.items = [];
      sfSortFinalized = false;
      sfSearchExhausted = false;
      // TikTok sorts don't always reload, so the Stop state has to be cleared
      // here too — otherwise a sort started after a Stop aborts immediately.
      sfStopSearch.requested = false;
      flushSleepers();
    }
  });
})();
