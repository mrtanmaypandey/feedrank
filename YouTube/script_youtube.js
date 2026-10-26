// YouTube — page-world sort engine (Phase 1)
// Injected into the MAIN world by inject_youtube_script.js so it can read
// window.ytInitialData / window.ytcfg and call YouTube's own InnerTube APIs.
//
// Flow on a fresh load after a sort reload (flags set by init_sortfeed_youtube.js):
//   1) COLLECT the roster (videoIds + feed order) — page 1 from ytInitialData,
//      further pages via direct POST /youtubei/v1/browse continuation calls
//      (no fetch-wrap, no scrolling — same technique as the player calls).
//   2) ENRICH every item via POST /youtubei/v1/player (throttled) → exact
//      views, likes, publishDate, description, category, duration. Proven in
//      Phase 0 (YT_Phase0_console_test.js).
//   3) SORT (views / likes / oldest) + apply date filter, then postMessage the
//      result to the content script (dom_youtube.js) to render.
//
// Talks to the isolated world ONLY via window.postMessage({ sf_yt: true, ... }).

(function () {
  "use strict";
  const DEBUG = false;

  // Gate: only run right after a sort reload.
  let STATUS, SURFACE, SORT_BY, NO_ITEMS, ITEMS_VS_DATES;
  try {
    STATUS = sessionStorage.getItem("sortFeedStatusYouTube");
    SURFACE = sessionStorage.getItem("sortFeedSurfaceYouTube");       // 'ytshorts' | 'ytvideos'
    SORT_BY = sessionStorage.getItem("sortFeedSortByYouTube");         // 'views' | 'likes' | 'oldest'
    NO_ITEMS = sessionStorage.getItem("sortFeedNoItemsYouTube");       // '25_reels' … 'all_reels'
    ITEMS_VS_DATES = sessionStorage.getItem("sortItemsVsDatesYouTube"); // 'items' | 'dates'
  } catch (e) { return; }
  if (STATUS !== "on") return;

  // ⚠️ TEST SWITCH — must ship false. Returns before run() ever starts and before
  // the "alive" ping below, simulating the page world failing to load at all —
  // the one failure the banner's stall watchdog exists to catch. Mirrors
  // SF_TEST_FORCE_STALL in Instagram/script_instagram.js.
  const SF_TEST_FORCE_STALL_YT = false;
  if (SF_TEST_FORCE_STALL_YT) return;

  const IS_SHORTS = SURFACE === "ytshorts";
  const log = (...a) => { if (DEBUG) console.log("[SF][YT]", ...a); };
  const post = (obj) => window.postMessage(Object.assign({ sf_yt: true }, obj), "*");
  // Every terminal path must clear the run flag — leaving it "on" made a plain
  // manual refresh silently re-run the sort after a failed attempt.
  // noData = we never managed to READ anything (no ytcfg, empty roster, thrown
  // run). That is not an empty channel, and saying "no videos available to sort"
  // would be a lie — the banner routes it to the stall message instead.
  const postEmpty = (dateEmpty, noData) => {
    try { sessionStorage.removeItem("sortFeedStatusYouTube"); } catch (e) {}
    const msg = { kind: "empty" };
    if (dateEmpty) msg.dateEmpty = true;
    if (noData) msg.noData = true;
    post(msg);
  };

  // ── No server-cached median (V2 removed 2026-08-27, mirrors IG) ──────────
  // There used to be a Cloudflare/D1 cache of each channel's median, read once
  // per sort (via the outlier_cache_youtube.js bridge) and written back after
  // every live compute. With OUTLIER_CAP at 25 the local compute almost always
  // succeeds off the always-enrich pipeline, so the cached answer was being
  // fetched and then discarded. Computing fresh is also fresher (cached medians
  // went stale for up to 7 days) and consistent between users. The worker
  // itself stays deployed, so a git revert brings the bridge back.

  // ── knobs ──────────────────────────────────────────────────────────────
  const CONCURRENCY = 3;
  const MIN_DELAY = 150, MAX_DELAY = 400;
  const HARD_CAP = 1000;              // safety ceiling on enrichment calls
  const COLLECT_CAP = 2000;          // safety ceiling on roster size

  // ── Outlier score (SORT_BY === "outlier") — tuning IDENTICAL to IG/FB ────
  // score = item VIEWS ÷ baseline; baseline = MEDIAN views of the channel's
  // most recent 25 qualifying uploads — qualifying = matured ≥72h with a view
  // count. There is NO time window (the 90→180→365 ladder was removed
  // 2026-08-27; see outlierComputeMeta for why). YouTube's always-enrich
  // pipeline IS the pool — enrichment just keeps going past the display need
  // until the cap fills or the channel runs out.
  //
  // ⚠️ The cap is a STOP condition, not a target: outlierEvaluate returns the
  // moment 25 uploads qualify. It was 100, which forced a free user's 25-item
  // sort to enrich ~4x the items it asked for. Cost: a median off ~25 samples
  // instead of ~100 is noisier (roughly ±18% vs ±10%), which the 2×/5×/10×
  // tiers absorb except right at a boundary. Deliberately NOT coupled to the
  // user's selection — one baseline per channel keeps multiples stable.
  const IS_OUTLIER = SORT_BY === "outlier";
  const OUTLIER_MIN_AGE_MS = 72 * 60 * 60 * 1000; // <72h = too new to have matured
  const OUTLIER_FLOOR = 20;                       // min qualifying items for a trustworthy median
  const OUTLIER_CAP = 25;                         // most-recent qualifying items kept for the median (see note above)
  const OUTLIER_BADGE_MIN = 2;                    // score below which an item gets no badge (tier-1 floor)
  const OUTLIER_ROSTER_HEADROOM = 300;            // roster pre-collected for the pool; extended lazily after

  // ── Stop Sorting — immediate abort (mirrors Instagram/script_instagram.js) ──
  // The banner's Stop raises `sortFeedStopSortingYouTube` AND posts
  // `sf_stop_sorting` (see _sfRequestStopYouTube in banner_on_youtube.js). The
  // flag on its own can only be POLLED, and the enrichment workers only poll it
  // at the top of each iteration — after an `await sleep(jitter())` and an
  // InnerTube fetch. With CONCURRENCY workers all parked mid-request, Stop had
  // to wait for the slowest of them before Promise.all could settle.
  //
  // Like Facebook, YouTube needs no separate express route: the code after the
  // worker pool already renders whatever was enriched (and already treats a
  // stopped run's outlier verdict as cancelled). It just has to get there now.
  //   • pending sleeps resolve on the click's own tick;
  //   • the shared AbortController kills in-flight browse/player fetches, which
  //     surface as ordinary errors the existing catch blocks already handle.
  const _sfStopYt = {
    requested: false,
    sleepers: new Set(),
    controller: typeof AbortController === "function" ? new AbortController() : null,
  };

  const _sfStopYtFlush = () => {
    const pending = Array.from(_sfStopYt.sleepers);
    _sfStopYt.sleepers.clear();
    pending.forEach((rec) => {
      if (rec.settled) return;
      rec.settled = true;
      clearTimeout(rec.timer);
      try { rec.resolve(); } catch (e) {}
    });
  };

  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data || !event.data.sf_stop_sorting) return;
    _sfStopYt.requested = true;
    _sfStopYtFlush();
    try { if (_sfStopYt.controller) _sfStopYt.controller.abort(); } catch (e) {}
  });

  // Abortable sleep — Stop settles every pending one immediately.
  const sleep = (ms) => new Promise((resolve) => {
    if (_sfStopYt.requested) { resolve(); return; }
    const rec = { resolve: resolve, timer: null, settled: false };
    rec.timer = setTimeout(() => {
      if (rec.settled) return;
      rec.settled = true;
      _sfStopYt.sleepers.delete(rec);
      resolve();
    }, ms);
    _sfStopYt.sleepers.add(rec);
  });
  const jitter = () => MIN_DELAY + Math.floor(Math.random() * (MAX_DELAY - MIN_DELAY));
  const toNum = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
  const stopRequested = () => {
    if (_sfStopYt.requested) return true;
    try { return sessionStorage.getItem("sortFeedStopSortingYouTube") === "on"; } catch (e) { return false; }
  };
  // Signal for the InnerTube fetches, so Stop cancels them mid-flight.
  const _sfStopYtSignal = () => (_sfStopYt.controller ? _sfStopYt.controller.signal : undefined);

  function targetCount() {
    if (ITEMS_VS_DATES === "dates" || NO_ITEMS === "all_reels") return Infinity;
    const n = parseInt(NO_ITEMS, 10);
    return Number.isFinite(n) ? n : 25;
  }

  // Date-range cutoff (ms) for date mode — feed is newest-first, so we stop
  // enriching once items fall before the cutoff.
  function dateCutoffMs() {
    if (ITEMS_VS_DATES !== "dates") return null;
    const now = Date.now();
    const DAY = 86400000;
    switch (NO_ITEMS) {
      case "1_week": return now - 7 * DAY;
      case "1_month": return now - 30 * DAY;
      case "3_month": return now - 90 * DAY;
      case "6_month": return now - 180 * DAY;
      case "1_year": return now - 365 * DAY;
      default: return null; // all_reels → no lower bound
    }
  }

  // ── ytcfg (InnerTube key + context) ──────────────────────────────────────
  // ⚠️ Resolved LAZILY inside run(), never at eval time: this script is injected
  // at document_start and can evaluate BEFORE YouTube's inline ytcfg.set() runs.
  // Capturing undefined here once meant the whole sort died with "no videos
  // available" even though the feed was fine (intermittent, timing-dependent).
  function ytcfgGet(k) {
    try { if (window.ytcfg && window.ytcfg.get) return window.ytcfg.get(k); } catch (e) {}
    try { return window.ytcfg && window.ytcfg.data_ && window.ytcfg.data_[k]; } catch (e) {}
    return undefined;
  }
  let API_KEY = null, CONTEXT = null, STS = null;
  function resolveYtcfg() {
    // STS re-read outside the early return so it backfills even after
    // key+context already resolved. Never gates the run — the playbackContext
    // just omits it when absent.
    if (!STS) STS = ytcfgGet("STS");
    if (API_KEY && CONTEXT) return true;
    API_KEY = ytcfgGet("INNERTUBE_API_KEY");
    CONTEXT = ytcfgGet("INNERTUBE_CONTEXT");
    return !!(API_KEY && CONTEXT);
  }

  // ── roster parsing (dual-format: new lockup + legacy renderer) ───────────
  // Returns { items: [{videoId, listTitle}], token }.
  function parseGridItems(contents) {
    const items = [];
    let token = null;
    for (const c of contents || []) {
      const cont = c && c.continuationItemRenderer;
      if (cont) {
        token = cont.continuationEndpoint &&
          cont.continuationEndpoint.continuationCommand &&
          cont.continuationEndpoint.continuationCommand.token || token;
        continue;
      }
      // Rendered polymer data can wrap items in grid rows (Videos tab).
      const row = c && c.richGridRowRenderer && c.richGridRowRenderer.contents;
      if (row) {
        const sub = parseGridItems(row);
        for (const it of sub.items) items.push(it);
        token = sub.token || token;
        continue;
      }
      const content = c && c.richItemRenderer && c.richItemRenderer.content;
      if (!content) continue;

      // Shorts — new
      const sl = content.shortsLockupViewModel;
      if (sl) {
        const id = sl.onTap && sl.onTap.innertubeCommand &&
          sl.onTap.innertubeCommand.reelWatchEndpoint &&
          sl.onTap.innertubeCommand.reelWatchEndpoint.videoId;
        if (id) items.push({ videoId: id, listTitle: sl.overlayMetadata && sl.overlayMetadata.primaryText && sl.overlayMetadata.primaryText.content || null });
        continue;
      }
      // Videos — new
      const lv = content.lockupViewModel;
      if (lv && lv.contentId) {
        items.push({ videoId: lv.contentId, listTitle: lv.metadata && lv.metadata.lockupMetadataViewModel && lv.metadata.lockupMetadataViewModel.title && lv.metadata.lockupMetadataViewModel.title.content || null });
        continue;
      }
      // Legacy shapes
      const ri = content.reelItemRenderer;
      if (ri && ri.videoId) { items.push({ videoId: ri.videoId, listTitle: ri.headline && ri.headline.simpleText || null }); continue; }
      const vr = content.videoRenderer;
      if (vr && vr.videoId) { items.push({ videoId: vr.videoId, listTitle: vr.title && vr.title.runs && vr.title.runs[0] && vr.title.runs[0].text || null }); continue; }
    }
    return { items, token };
  }

  function readInitialGrid() {
    const data = window.ytInitialData;
    const tabs = data && data.contents && data.contents.twoColumnBrowseResultsRenderer && data.contents.twoColumnBrowseResultsRenderer.tabs || [];
    let grid = null;
    for (const t of tabs) {
      const tr = t.tabRenderer || t.expandableTabRenderer;
      if (tr && tr.selected && tr.content && tr.content.richGridRenderer) { grid = tr.content.richGridRenderer; break; }
    }
    if (!grid) for (const t of tabs) {
      const tr = t.tabRenderer || t.expandableTabRenderer;
      if (tr && tr.content && tr.content.richGridRenderer) { grid = tr.content.richGridRenderer; break; }
    }
    return parseGridItems(grid && grid.contents || []);
  }

  function channelName() {
    try {
      const md = window.ytInitialData && window.ytInitialData.metadata && window.ytInitialData.metadata.channelMetadataRenderer;
      if (md && md.title) return md.title;
    } catch (e) {}
    return "";
  }

  // ── InnerTube calls ──────────────────────────────────────────────────────
  async function browseContinuation(token) {
    const res = await fetch(`/youtubei/v1/browse?key=${API_KEY}&prettyPrint=false`, {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ context: CONTEXT, continuation: token }),
      signal: _sfStopYtSignal(), // Stop aborts in-flight paging
    });
    if (!res.ok) { const e = new Error("HTTP " + res.status); e.status = res.status; throw e; }
    const data = await res.json();
    const acts = data.onResponseReceivedActions || [];
    for (const a of acts) {
      if (a.appendContinuationItemsAction && a.appendContinuationItemsAction.continuationItems) {
        return parseGridItems(a.appendContinuationItemsAction.continuationItems);
      }
    }
    return { items: [], token: null };
  }

  async function playerCall(videoId) {
    // ⚠️ signatureTimestamp is REQUIRED since ~2026-07-17: without it the
    // player API answers UNPLAYABLE "Video unavailable" for EVERY video
    // (verified live — even dQw4w9WgXcQ; adding STS flips it to OK with full
    // microformat). Without this, enrichment silently degrades to placeholders.
    const cpc = { html5Preference: "HTML5_PREF_WANTS" };
    if (STS) cpc.signatureTimestamp = STS;
    const res = await fetch(`/youtubei/v1/player?key=${API_KEY}&prettyPrint=false`, {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        context: CONTEXT, videoId, contentCheckOk: true, racyCheckOk: true,
        playbackContext: { contentPlaybackContext: cpc },
      }),
      signal: _sfStopYtSignal(), // Stop aborts in-flight enrichment
    });
    if (!res.ok) { const e = new Error("HTTP " + res.status); e.status = res.status; throw e; }
    return res.json();
  }

  // Best thumbnail from the player response — these URLs are SIGNED and always
  // render. The constructed /vi/<id>/oardefault.jpg guess returns a grey "…"
  // placeholder with HTTP 200 for recent shorts (no onerror), which is what
  // produced the grey tiles on date sorts. Shorts: microformat carries portrait
  // oar2 variants; Videos: videoDetails carries hq/maxres variants.
  function bestThumb(mf, vd) {
    const pick = (arr) => {
      if (!arr || !arr.length) return null;
      let best = arr[0];
      for (const t of arr) {
        if (t && t.width && t.width <= 1000 && (!best.width || t.width > best.width || best.width > 1000)) best = t;
      }
      return best && best.url || arr[arr.length - 1].url || null;
    };
    return (IS_SHORTS && mf.thumbnail && pick(mf.thumbnail.thumbnails)) ||
      (vd.thumbnail && pick(vd.thumbnail.thumbnails)) ||
      (mf.thumbnail && pick(mf.thumbnail.thumbnails)) || null;
  }

  function mapEnriched(videoId, listTitle, pr) {
    const mf = (pr && pr.microformat && pr.microformat.playerMicroformatRenderer) || {};
    const vd = (pr && pr.videoDetails) || {};
    const iso = mf.publishDate || mf.uploadDate || null;
    return {
      VideoID: videoId,
      URL: IS_SHORTS ? `https://www.youtube.com/shorts/${videoId}` : `https://www.youtube.com/watch?v=${videoId}`,
      Title: vd.title || (mf.title && mf.title.simpleText) || listTitle || "",
      Channel: mf.ownerChannelName || vd.author || "",
      ChannelID: vd.channelId || mf.externalChannelId || "",
      Views: toNum(mf.viewCount != null ? mf.viewCount : vd.viewCount),
      Likes: toNum(mf.likeCount),
      Comments: null,                       // not in player (needs /next) — Phase 1 leaves blank
      Date: iso,                            // ISO timestamp
      DateMs: iso ? Date.parse(iso) : null,
      Description: (mf.description && mf.description.simpleText) || vd.shortDescription || "",
      Category: mf.category || "",
      DurationSec: toNum(mf.lengthSeconds != null ? mf.lengthSeconds : vd.lengthSeconds),
      Thumb: bestThumb(mf, vd) || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      isShort: IS_SHORTS,
      _playability: pr && pr.playabilityStatus && pr.playabilityStatus.status || null,
    };
  }

  // Fallback #1: the rendered grid's POLYMER DATA. On service-worker app-shell
  // loads window.ytInitialData can be stale/empty for the tab even though the
  // feed is on screen — but the grid element's .data (page world can read it)
  // holds the same richGridRenderer payload, INCLUDING the continuation token,
  // so paging still works.
  function readGridFromPolymer() {
    try {
      const browse = document.querySelector("ytd-browse:not([hidden])");
      if (!browse) return { items: [], token: null };
      const grid = browse.querySelector(IS_SHORTS
        ? "ytd-rich-grid-renderer[is-shorts-grid]"
        : "ytd-rich-grid-renderer[is-default-grid]") ||
        browse.querySelector("ytd-rich-grid-renderer");
      const contents = grid && grid.data && grid.data.contents;
      if (!contents || !contents.length) return { items: [], token: null };
      return parseGridItems(contents);
    } catch (e) { return { items: [], token: null }; }
  }

  // Fallback #2: scrape the RENDERED tiles' anchor hrefs (locale-invariant).
  // Last resort — recovers the visible roster but no continuation token.
  function readGridFromDOM() {
    const out = [], seen = new Set();
    const anchors = document.querySelectorAll(
      IS_SHORTS
        ? 'ytd-browse:not([hidden]) ytd-rich-grid-renderer a[href^="/shorts/"]'
        : 'ytd-browse:not([hidden]) ytd-rich-grid-renderer a[href*="/watch?v="]'
    );
    anchors.forEach((a) => {
      const href = a.getAttribute("href") || "";
      const m = IS_SHORTS ? href.match(/\/shorts\/([\w-]{6,})/) : href.match(/[?&]v=([\w-]{6,})/);
      if (m && !seen.has(m[1])) { seen.add(m[1]); out.push({ videoId: m[1], listTitle: a.getAttribute("title") || null }); }
    });
    return out;
  }

  // ── main ─────────────────────────────────────────────────────────────────
  async function run() {
    // Tell the banner we exist. YouTube can legitimately spend ~15s waiting for
    // ytcfg and ~8s for ytInitialData before it posts any progress, so a flat 10s
    // stall timer would fire on a healthy-but-slow sort. This cancels it: from
    // here on every failure path ends in postEmpty(…, noData), which shows the
    // same message with the same animation.
    post({ kind: "alive" });

    const deadline = Date.now() + 15000;

    // ytcfg can land after us (we're injected at document_start) — wait for it.
    while (!resolveYtcfg() && Date.now() < deadline) await sleep(150);
    if (!resolveYtcfg()) { log("no ytcfg"); postEmpty(false, true); return; }

    const channel = channelName();
    const target = targetCount();
    const cutoff = dateCutoffMs();

    // The outlier verdict for this run, decided by the live pool below (no
    // server cache anymore — see the note at the top of the file).
    let outlierMeta = null;

    // 1) COLLECT roster — ytInitialData first, then (retrying until the
    // deadline, service-worker shell loads render the feed late) the grid's
    // polymer data (keeps the continuation token), then the rendered hrefs.
    let { items: roster, token } = readInitialGrid();
    let rosterFromDom = false; // fallback #2 has no continuation token — see ctxFeedEnd
    while (!roster.length && Date.now() < deadline && !stopRequested()) {
      const pg = readGridFromPolymer();
      if (pg.items.length) { roster = pg.items; token = pg.token; break; }
      const scraped = readGridFromDOM();
      if (scraped.length) { roster = scraped; token = null; rosterFromDom = true; break; }
      await sleep(250);
      ({ items: roster, token } = readInitialGrid()); // may be assigned late
    }

    const seen = new Set(roster.map((r) => r.videoId));
    post({ kind: "progress", phase: "collect", done: roster.length, total: 0, channel });
    if (!roster.length) { postEmpty(false, true); return; }

    // Roster need is DYNAMIC: outlier sorts want pool HEADROOM beyond the
    // display target only while the baseline is undecided; once the verdict
    // lands (including cache hits) the need collapses back to the display
    // target, so the collector stops paging for a pool nobody needs anymore.
    const rosterNeed = () => (IS_OUTLIER && outlierMeta == null && target !== Infinity)
      ? Math.max(target, OUTLIER_ROSTER_HEADROOM)
      : target;

    // 2) ENRICH (throttled) — starts on PAGE 1 while the rest of the roster
    // pages in, in the background (see the collector below), so the banner
    // count starts moving right away instead of waiting out the whole
    // (silent) paging phase. Date mode stops once items pass the cutoff;
    // outlier sorts keep enriching past the display need until the baseline
    // pool decides. Display slicing happens at the end — workers simply never
    // claim indices nobody needs.
    const out = new Array(roster.length);
    let idx = 0, done = 0, stopped = false, pastCutoff = false;
    let displaySettled = 0, analyzingShown = false;
    let feedExhausted = !token;
    let collectorHalt = false;
    // Back-to-back re-sorting: the HONEST end-of-feed signal, for the sort
    // context recorded at render (see sfCtx below). `feedExhausted` above can't
    // serve that purpose — it doubles as "stop trying" and the catch blocks
    // raise it on a FAILED browse call, where the truth is the opposite: we did
    // not see the rest of the feed. This one is raised only where YouTube
    // itself said there is no more (a successful call with no continuation
    // token), and starts false when the roster came from the DOM-scrape
    // fallback, which never has a token to begin with.
    let ctxFeedEnd = !token && !rosterFromDom;
    const enrichTotal = ITEMS_VS_DATES === "dates" ? roster.length : Math.min(roster.length, HARD_CAP);

    // ── Outlier pool over the enriched items (mirrors FB's engine 1:1) ──────
    // Qualifying = matured (≥72h) with a view count. No age ceiling — see
    // outlierComputeMeta.
    const outlierQualifying = () => {
      const now = Date.now(), q = [];
      for (const it of out) {
        if (!it || it.DateMs == null || it.Views == null) continue;
        if (now - it.DateMs >= OUTLIER_MIN_AGE_MS) q.push({ dateMs: it.DateMs, views: +it.Views });
      }
      return q;
    };
    // Median views of the most recent OUTLIER_CAP qualifying uploads.
    //
    // ── No time window (2026-08-27, mirrors IG) ────────────────────────────
    // The baseline used to be "qualifying uploads inside a 90-day window",
    // widening to 180 then 365 when fewer than OUTLIER_FLOOR qualified, and
    // giving up as `insufficient` if 365 still fell short. That ladder was
    // built for a cap of 100. At a cap of 25 it never binds on active
    // channels, and on slow ones all it does is refuse to score. So the window
    // is gone: the baseline is simply the most recent 25 qualifying uploads,
    // whenever they were posted, and `insufficient` now means fewer than 20
    // mature uploads in total. Trade-off: on a slow channel those 25 can span
    // a long time, so "more views than usual" means "than this channel's
    // recent history" — unavoidable, and far better than refusing to score.
    const outlierComputeMeta = () => {
      let q = outlierQualifying();
      if (q.length < OUTLIER_FLOOR) return { status: "insufficient", baseline: null, poolSize: q.length, metric: "views" };
      q.sort((a, b) => b.dateMs - a.dateMs);          // newest first
      if (q.length > OUTLIER_CAP) q = q.slice(0, OUTLIER_CAP);
      const vals = q.map((r) => r.views).sort((a, b) => a - b);
      const mid = vals.length >> 1;
      const baseline = vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
      if (!(baseline > 0)) return { status: "insufficient", baseline: null, poolSize: q.length, metric: "views" };
      return { status: "ok", baseline, poolSize: q.length, metric: "views" };
    };
    // Verdict, or null when more items are needed. Two finish lines, down from
    // four: the cap is full (the feed is newest-first, so these ARE the most
    // recent), or the whole channel is enriched — compute with whatever
    // qualified (insufficient below the floor).
    const outlierEvaluate = () => {
      if (outlierQualifying().length >= OUTLIER_CAP) return outlierComputeMeta();
      if (feedExhausted && done >= roster.length) return outlierComputeMeta();
      return null; // more items needed
    };
    // Pool progress (0..1) for the banner's bar: qualifying uploads ÷ cap. The
    // old "window coverage" term went with the window itself.
    const outlierPoolProgress = () =>
      Math.max(0, Math.min(1, outlierQualifying().length / OUTLIER_CAP));
    const outlierDisplayCount = () => Math.min(OUTLIER_CAP, outlierQualifying().length);

    // ── Scan progress — the bar for sorts that have NO item target ───────────
    // Ported from Instagram/script_instagram.js (_sfScanProgress). A DATE sort's
    // finish line isn't a count, it's a date; the feed is newest-first, so the
    // publish date of the item the enrich loop has reached IS the distance
    // travelled from now back toward the range's start — a real, monotonic 0..1
    // the banner can drive its bar off. Without it the banner had nothing to
    // compute a percentage from and sat at 0% for the whole scrape (the
    // indeterminate crawl meant to cover this lives in a branch the prep banner
    // makes unreachable — see injectSortFeedBannerYT).
    //
    // Two signals, maxed together:
    //   • time coverage — exact whenever the range's start lies inside the feed;
    //   • a work asymptote, enriched ÷ (enriched + K) — takes over where time
    //     says nothing: an "All" scrape (finish line is "feed exhausted", not a
    //     date) and channels younger than the requested range, where coverage
    //     alone would top out low and then jump.
    // Plus a floor once YouTube reports no next page: the last page has landed,
    // so only the remaining player calls stand between us and the render.
    //
    // No pinned-item exception is needed here, unlike IG/FB: a channel's pinned
    // video lives on its Home tab, and the Videos/Shorts grids on "Latest" are
    // plain chronological — nothing old floats over the top to make item one
    // read as "we've already scrolled back years". Same reasoning as
    // _sfResortOldestKeptMsYt in dom_youtube.js.
    const SCAN_WORK_K = 60;            // knee of the work asymptote, in items
    const SCAN_LAST_PAGE_FLOOR = 0.9;  // reached the final page → nearly done
    // targetCount() returns Infinity for exactly the two targetless sorts:
    // date mode and "All". Everything else divides count ÷ target in the banner.
    const SCAN_ACTIVE = target === Infinity;

    // The oldest publish date the ENRICH loop has actually REACHED. Deliberately
    // not the roster's depth: the roster jumps a whole page ahead the moment a
    // browse continuation lands, so the bar would leap and then sit still
    // through the per-item player calls. This advances one item at a time, which
    // is what makes the bar move smoothly.
    let scanCursorMs = null;
    const noteScanCursor = (ms) => {
      if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return;
      if (scanCursorMs === null || ms < scanCursorMs) scanCursorMs = ms;
    };

    // 0..1, or null when this sort has a real item target and doesn't need it.
    const scanProgress = () => {
      if (!SCAN_ACTIVE) return null;
      let progress = done / (done + SCAN_WORK_K);
      // Time coverage: the journey is now → the range's start, and the cursor
      // says where along it we are. Skipped for "All", which has no lower bound
      // at all (dateCutoffMs returns null for it) — "everything" is not a date
      // to travel to.
      if (cutoff != null && scanCursorMs !== null) {
        const now = Date.now();
        const journey = now - cutoff;
        if (journey > 0) progress = Math.max(progress, (now - scanCursorMs) / journey);
      }
      if (feedExhausted) progress = Math.max(progress, SCAN_LAST_PAGE_FLOOR);
      return Math.max(0, Math.min(1, progress));
    };

    // Lazily fetch another roster page while the pool is undecided (single
    // fetch at a time — workers share the same promise).
    let extending = null;
    const extendRoster = () => {
      if (extending) return extending;
      extending = (async () => {
        if (!token) { feedExhausted = true; return; }
        try {
          await sleep(jitter());
          const page = await browseContinuation(token);
          const fresh = page.items.filter((f) => f.videoId && !seen.has(f.videoId));
          fresh.forEach((f) => { seen.add(f.videoId); roster.push(f); });
          token = fresh.length ? page.token : null;
          if (!token) { feedExhausted = true; ctxFeedEnd = true; } // YouTube said there is no more
        } catch (e) {
          token = null; feedExhausted = true; // a failed call is NOT an exhausted feed — ctxFeedEnd stays
        } finally {
          extending = null;
        }
      })();
      return extending;
    };

    // Background roster collector — pages continuations toward `rosterNeed`
    // IN PARALLEL with enrichment (workers wait briefly at the roster edge
    // while this runs; the outlier pool's beyond-need paging stays with
    // extendRoster). Also stops paging the moment a date sort passes its
    // cutoff — the old blocking loop walked the WHOLE channel up front.
    let collecting = false;
    const needMoreRoster = () =>
      !!token && !stopped && !collectorHalt && !stopRequested() &&
      roster.length < COLLECT_CAP &&
      !(cutoff != null && pastCutoff && !(IS_OUTLIER && outlierMeta == null)) &&
      (rosterNeed() === Infinity || roster.length < rosterNeed());
    (async () => {
      if (!needMoreRoster()) return;
      collecting = true;
      try {
        while (needMoreRoster()) {
          let page;
          try { await sleep(jitter()); page = await browseContinuation(token); }
          catch (e) { log("browse err", e.status || e.message); token = null; feedExhausted = true; return; } // error ⇒ ctxFeedEnd stays false
          const fresh = page.items.filter((f) => f.videoId && !seen.has(f.videoId));
          fresh.forEach((f) => { seen.add(f.videoId); roster.push(f); });
          token = fresh.length ? page.token : null;
          if (!token) { feedExhausted = true; ctxFeedEnd = true; } // YouTube said there is no more
          post({ kind: "progress", phase: "collect", done: roster.length, total: 0, channel });
        }
      } finally {
        collecting = false;
      }
    })();

    async function worker() {
      while (!stopped) {
        if (stopRequested()) { stopped = true; return; }
        if (idx >= roster.length) {
          if (collecting) { await sleep(150); continue; } // collector still paging — more roster incoming (Stop settles this sleep)
          if (IS_OUTLIER && outlierMeta == null && token && roster.length < COLLECT_CAP) {
            await extendRoster();
            continue;
          }
          return;
        }
        const i = idx++;
        if (i >= HARD_CAP) return;

        // Still needed? Display need (count / date range) OR an undecided pool.
        const needDisplay = cutoff != null ? !pastCutoff : (target === Infinity || i < target);
        const needPool = IS_OUTLIER && outlierMeta == null;
        if (!needDisplay && !needPool) return;

        await sleep(jitter());
        // Stop cut that sleep short — don't issue another request.
        if (stopRequested()) { stopped = true; return; }
        try {
          const pr = await playerCall(roster[i].videoId);
          out[i] = mapEnriched(roster[i].videoId, roster[i].listTitle, pr);
          // Feed order, recorded rather than inferred. The roster IS the
          // channel's Latest order, so its index is authoritative — where a
          // date is not, for same-day uploads and for premieres/scheduled
          // items YouTube places its own way. A warm re-sort that narrows
          // ("latest 100" → "latest 50") slices on this; see _sfResortFeedOrderYt.
          out[i]._sfSeq = i;
          // How far back in time the scrape has actually reached — drives the
          // progress bar on date / "All" sorts (see scanProgress above).
          noteScanCursor(out[i].DateMs);
        } catch (e) {
          if (e.status === 429) { stopped = true; log("429 — pausing enrichment"); return; }
          out[i] = null; // private/deleted/region — skip
        }
        done++;
        if (target === Infinity || i < target) displaySettled++;

        if (IS_OUTLIER && outlierMeta == null) outlierMeta = outlierEvaluate();

        // Banner phases mirror IG/FB's order. The DISPLAY phase drives the bar
        // exactly like the same sort without outlier — count/target for items,
        // coverage for dates/"All". (It used to hand the banner window coverage
        // for both phases so the display→pool handoff was one continuous
        // stream; at OUTLIER_CAP 25 that signal saturates almost immediately
        // and pinned the bar at its 95% ceiling. Mirrors IG.)
        //
        // Once the display set is enriched but the pool is still growing, the
        // pool ticks (outlier_analyzing) own the banner until render — the
        // message no longer changes, only the bar moves, picking up from
        // whatever the display phase had painted.
        const displayComplete = cutoff != null
          ? pastCutoff
          : (target !== Infinity && displaySettled >= target);
        if (IS_OUTLIER && displayComplete && (outlierMeta == null || analyzingShown)) {
          analyzingShown = true;
          post({ kind: "outlier_analyzing", count: outlierDisplayCount(), progress: outlierPoolProgress(), channel });
        } else {
          // Count is the DISPLAY tally (clamped to the target) — pool extras
          // must never read "103 Shorts sorted" on a 50-item sort.
          const shown = target === Infinity ? done : Math.min(displaySettled, target);
          const msg = { kind: "progress", phase: "enrich", done: shown, total: enrichTotal, channel };
          // Date sorts and "All" have no item target, so the banner has
          // nothing to compute a percentage from — send it real coverage.
          const scan = scanProgress();
          if (scan !== null) msg.scanProgress = scan;
          post(msg);
        }

        // Date mode: feed is newest-first — once we're past the cutoff the
        // display set is complete (an undecided outlier pool keeps workers
        // alive via needPool above).
        if (cutoff != null && out[i] && out[i].DateMs != null && out[i].DateMs < cutoff) {
          pastCutoff = true;
          if (!IS_OUTLIER) { stopped = true; return; }
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    collectorHalt = true; // sort settled — stop any in-flight background paging

    // Outlier verdict fallback for interrupted runs (Stop / 429 / hard cap):
    // a truncated pool would bias the median, so treat those as cancelled.
    if (IS_OUTLIER && outlierMeta == null) {
      outlierMeta = (stopped || stopRequested())
        ? { status: "cancelled", baseline: null, poolSize: 0, metric: "views" }
        : (outlierEvaluate() || outlierComputeMeta());
    }

    // ── Always-on baseline — ORDINARY sorts only ────────────────────────────
    // When a plain views/likes/oldest sort happens to have collected enough to
    // compute this channel's median, compute it anyway: stamp the scores and
    // let the banner offer "Outlier score" without a re-scrape.
    //
    // Strictly free, by construction: pure arithmetic over items we already
    // enriched — outlierEvaluate() never fetches, and returns null when it
    // would need more. If it doesn't pay out, nothing happens at all and
    // picking Outlier later still refreshes, exactly as today.
    //
    // Skipped after a Stop: a stopped run's pool is truncated the same way its
    // display set is, and a truncated pool would bias the median.
    if (!IS_OUTLIER && outlierMeta == null && !stopped && !stopRequested()) {
      const local = outlierEvaluate();
      // Only a real computed baseline is worth anything here. "Insufficient" is
      // a useful answer to a question the user ASKED, but on an ordinary sort it
      // is noise — show nothing rather than a hedge nobody requested.
      if (local && local.status === "ok" && local.baseline > 0) outlierMeta = local;
    }

    // Display set: items mode shows the first `target` feed items — anything
    // enriched past that (the outlier pool, in-flight stragglers) only fed the
    // median and is sliced off. The roster is never pre-sliced anymore (it
    // grows during enrichment), so this is the single display gate.
    let items = (target !== Infinity ? out.slice(0, target) : out).filter(Boolean);
    if (cutoff != null) items = items.filter((it) => it.DateMs != null && it.DateMs >= cutoff);

    if (!items.length) { postEmpty(ITEMS_VS_DATES === "dates"); return; }

    // Stamp each display item's score (views ÷ baseline) and queue the outcome
    // note the banner shows on removal (insufficient / no-breakout).
    //
    // This now runs on ordinary sorts too, whenever the block above got a
    // baseline for free — the exports pick their Outlier Score column up off the
    // data, and the banner can offer "Outlier score" with no re-scrape. What
    // does NOT carry over to an ordinary sort is the talking: the outcome
    // toasts belong to a sort the user asked to have scored.
    // Two outcome notes, deliberately worded apart in the banner because they
    // are not the same claim:
    //   • case B (no baseline): `insufficient` OR `error` — we never had a
    //     yardstick, so the toast asks for more uploads and names the views
    //     fallback. `error` used to be silent.
    //   • case A (baseline OK, nothing ≥2×): genuinely "all consistent".
    // `cancelled` stays silent — the user pressed Stop and knows why.
    if (outlierMeta) {
      if (outlierMeta.status === "ok" && outlierMeta.baseline > 0) {
        items.forEach((it) => {
          it.OutlierScore = typeof it.Views === "number" ? it.Views / outlierMeta.baseline : null;
        });
        if (IS_OUTLIER) {
          const anyBadge = items.some((it) => typeof it.OutlierScore === "number" && it.OutlierScore >= OUTLIER_BADGE_MIN);
          if (!anyBadge) post({ kind: "outlier_no_breakout" });
        }
      } else if (IS_OUTLIER && (outlierMeta.status === "insufficient" || outlierMeta.status === "error")) {
        post({ kind: "outlier_insufficient" });
      }
    }

    // 3) SORT
    const cmp = {
      views: (a, b) => (b.Views || 0) - (a.Views || 0),
      likes: (a, b) => (b.Likes || 0) - (a.Likes || 0),
      oldest: (a, b) => (a.DateMs || Infinity) - (b.DateMs || Infinity),
      // Scores are stamped all-or-nothing; the Views fallback keeps the order
      // sensible when they're absent (insufficient/cancelled → views order).
      outlier: (a, b) => {
        const va = a.OutlierScore != null ? a.OutlierScore : a.Views;
        const vb = b.OutlierScore != null ? b.OutlierScore : b.Views;
        return (vb == null ? -Infinity : +vb) - (va == null ? -Infinity : +va);
      },
    }[SORT_BY] || ((a, b) => (b.Views || 0) - (a.Views || 0));
    items.sort(cmp);

    if (DEBUG) { console.log("[SF][YT] sorted result:", items); window.__sfYtResult = items; }

    // Clear the run flag so a later manual refresh doesn't re-sort.
    try { sessionStorage.removeItem("sortFeedStatusYouTube"); } catch (e) {}

    // ── Back-to-back re-sorting — the sort-context record ───────────────────
    // Describes the scrape that produced THIS grid, so a second popup sort can
    // be answered from what is already on screen instead of reloading (the
    // router is _sfResortEvaluateYt in dom_youtube.js). Every field is measured
    // rather than assumed, because the two ways of being wrong are not equal: a
    // wrong "we already have it" is SILENT — the user gets too few items with
    // no hint anything is off — while a wrong "we don't" merely costs a reload.
    const sfCtx = {
      mode: ITEMS_VS_DATES,   // "items" | "dates"
      selection: NO_ITEMS,    // "100_reels" | "3_month" | "all_reels" | …
      sortBy: SORT_BY,
      surface: SURFACE,       // "ytvideos" | "ytshorts"
      path: location.pathname,
      // The ENRICHED display set, never the roster. The roster is a list of ids
      // we may or may not have fetched metadata for, and on an outlier sort it
      // runs hundreds of items past the display need — counting it would claim
      // coverage this grid does not have.
      collectedCount: items.length,
      // "Everything this channel has is on screen." Both halves are required:
      // ctxFeedEnd says YouTube ran out of pages, and the rest says we actually
      // enriched every one of them. A date sort that stopped at its cutoff, a
      // 429, a Stop, or the HARD_CAP all leave roster items behind, and any of
      // those would otherwise let a WIDER request be served from a partial set.
      feedExhausted: ctxFeedEnd && !pastCutoff && !stopped && !stopRequested() && done >= roster.length,
      stoppedByUser: stopRequested(),
    };

    // Outlier meta rides on the render message → badges/labels paint with the
    // grid (no races). It is no longer gated on IS_OUTLIER: an ordinary sort
    // that earned a free baseline sends it too, which is what lets the banner
    // offer "Outlier score" and the router answer a later outlier request
    // without reloading. The context record rides along for the same reason —
    // the renderer stores it on window.__sfReelsYt as the tiles go in.
    post({ kind: "render", payload: items, sortBy: SORT_BY, surface: SURFACE, channel, count: items.length, sf_outlier: outlierMeta, sf_ctx: sfCtx });
  }

  // ytInitialData is usually present by document_idle — but on service-worker
  // shell loads it can arrive very late or never, so don't wait forever: after
  // the deadline run() anyway and let the polymer/DOM fallbacks recover.
  function boot() {
    const t0 = Date.now();
    const tick = () => {
      if (!window.ytInitialData && Date.now() - t0 < 8000) { setTimeout(tick, 120); return; }
      run().catch((e) => { log("run error", e); postEmpty(false, true); });
    };
    tick();
  }
  boot();
})();
