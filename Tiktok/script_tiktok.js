


(() => {
  if (window.__sfFetchHooked) return;
  window.__sfFetchHooked = true;

  const t0 = performance.now();
  const ts = () => (performance.now() - t0).toFixed(1) + "ms";

  // ⚠️ TEST SWITCH — must ship false. Makes this wrap treat no response as a feed
  // page, so a real sort intercepts nothing, the collect loop never starts, the
  // page never scrolls, and the stall watchdog in banner_on_tiktok.js fires.
  // Mirrors SF_TEST_FORCE_STALL in Instagram/script_instagram.js.
  const SF_TEST_FORCE_STALL_TK = false;

  const _fetch = window.fetch;

  // console.log(`[SF][FETCH] installed in PAGE world @ ${ts()}`);

  window.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : (input?.url || "");
    const isTarget = !SF_TEST_FORCE_STALL_TK && String(url).includes("/api/post/item_list");

    // After a date-mode sort completes, short-circuit any subsequent item_list
    // fetches with a synthetic "no more items" response. TikTok's infinite-scroll
    // observer keeps firing requests otherwise, leaving the native loading
    // spinner spinning forever. Items-mode sorts don't trigger this behaviour.
    // The flag is cleared on page load (init script) and on SPA navigation
    // (history hook below) so it never bleeds into a different profile or a
    // fresh refresh.
    if (isTarget && sessionStorage.getItem("sortFeedSortDoneTikTok") === "true") {
      return new Response('{"itemList":[],"hasMore":false,"statusCode":0}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const res = await _fetch.apply(this, arguments);

    if (!isTarget) return res;

    const statusOn = !!sessionStorage.getItem("sortFeedStatusTikTok");
    // Outlier pool mode keeps recording pages AFTER the display phase clears
    // sortFeedStatusTikTok (the recorder gates on _sfOutlierRecordOnTk, which
    // stays true while pool.active). So parse when EITHER is on.
    //
    // ⚠️ _sfOutlierRecordOnTk, not _sfOutlierSessionOn: the pool now fills on
    // EVERY profile sort, not just outlier ones, so an ordinary views/likes sort
    // can compute a median for free (and capture the creator id the cache lookup
    // needs). Costs one Map.set per item on responses already being parsed.
    const recordOn = (typeof _sfOutlierRecordOnTk === "function") && _sfOutlierRecordOnTk();
    if (!statusOn && !recordOn) {
      // console.log(`[SF][FETCH] ⛔ skipped parse (flag missing) @ ${ts()}`);
      return res;
    }

    try {
      const clone = res.clone();
      const text = await clone.text();

      if (!text.trim().startsWith("{")) return res;

      const data = JSON.parse(text);

      const items =
        data?.itemList ??
        data?.item_list ??
        data?.aweme_list;

      // ✅ SAFE FILTER (never return nothing)
      if (!Array.isArray(items) || items.length === 0) {
        // console.log(`[SF][FETCH] ignoring empty payload @ ${ts()}`);
        return res; // <-- CRITICAL
      }

      const hasMore =
        data?.hasMore ??
        data?.has_more ??
        data?.has_more === 1 ??
        false;

      // console.log(`[SF][FETCH] ✅ valid payload @ ${ts()}`, {
      //   items: items.length
      // });

      // Outlier passive recorder — every item_list page (display phase AND pool
      // mode). Runs before the display post so pages 1..k feed the pool for free.
      if (recordOn) {
        try { _sfOutlierRecordResponse(items, !!hasMore); } catch (e) {}
      }

      // Normal display path — only while the display phase is collecting.
      if (statusOn) {
        window.postMessage(
          {
            source: "tiktokApiObserver",
            action: "tiktokApiData",
            numberItems: items.length,
            jsonResponse: items,
            nextPage: !!hasMore,
            url,
          },
          "*"
        );
      }
    } catch (e) {

    }

    return res;
  };
})();

// Clear the date-sort-done block flag on any SPA navigation. TikTok routes
// between profiles via history.pushState (no full page load), so without this
// the block would carry over to whichever profile you click next.
(() => {
  if (window.__sfHistoryHooked) return;
  window.__sfHistoryHooked = true;
  const _push = history.pushState;
  const _replace = history.replaceState;
  const clearBlock = () => sessionStorage.removeItem("sortFeedSortDoneTikTok");
  history.pushState = function () {
    clearBlock();
    return _push.apply(this, arguments);
  };
  history.replaceState = function () {
    clearBlock();
    return _replace.apply(this, arguments);
  };
  window.addEventListener("popstate", clearBlock);
})();


const DBUG = false;

let isSortingSessionActive = false;

window.__sfSortInProgress = false;


const inMemoryFeedData = {
  items: [],
};

// ── Back-to-back re-sorting — what this scrape is recording about itself ─────
// A second popup sort is answered from the collected set whenever that set is a
// superset of the new request (see Tiktok/resort_tiktok.js). These three globals
// are everything the decision needs that can't be read off the items afterwards.
//
// ⚠️ Profile sorts DON'T reload (mimicTikTokVisit soft-navigates), so all three
// must be cleared in `reset_tiktok_session` below — the same checklist as the
// feed data, the outlier pool, the Stop state and the render latch.
let _sfTkFeedExhausted = false;      // the last page said hasMore === false
let _sfTkDatePinnedSkipped = false;  // a date sort stepped OVER an out-of-range pinned item
let _sfTkDeepestSeenMs = null;       // ⚠️ DIAGNOSTIC ONLY — never a coverage test.
                                     // "Seen" is not "kept": a 1-week sort reads
                                     // pages reaching months back and throws all
                                     // of it away. Coverage is computed from the
                                     // items actually retained (see the router).

function save_data_locally_again(singleNodeJSON) {
  // Feed order, recorded rather than derived. TikTok hands pages back in feed
  // order and this is the only push site, so the arrival index IS the order the
  // profile shows — including pinned videos, which float to the top regardless
  // of date. A narrowing re-sort ("100 → latest 50") slices on this, so it picks
  // the same 50 a fresh sort would. Date sorts skip out-of-range items, which
  // only leaves gaps in the numbering — the order stays monotonic, which is all
  // the slice needs. Ignored by every export (they map explicit fields).
  singleNodeJSON._sfSeq = inMemoryFeedData.items.length;
  inMemoryFeedData.items.push(singleNodeJSON);
  return inMemoryFeedData.items;
}

function reset_in_memory_feed_data() {
  inMemoryFeedData.items = [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Stop Sorting — immediate abort (mirrors Instagram/script_instagram.js)
//
// The banner's Stop button raises `sortFeedStopSorting` AND posts
// `sf_stop_sorting` (see _sfRequestStopTikTok in banner_on_tiktok.js). The flag
// on its own can only be POLLED, and the loops poll it *after*
// `await find_element_tiktok_again` — which backs off across 12 attempts
// (220ms → 1200ms, ~9s worst case) and then waits up to 1.2s for the thumbnail.
// On a shallow scrape the tile is already there so Stop felt instant; deep into
// a long scrape those waits run in full and Stop appeared to hang.
//
// So the message is the real signal:
//   1. `_sfStopTk.requested` flips synchronously — every checkpoint sees it;
//   2. every pending sleep inside the finder resolves on the spot;
//   3. the render happens straight from what's already collected, so a Stop in
//      the gap BETWEEN pages doesn't wait for the next fetch either.
// ─────────────────────────────────────────────────────────────────────────────

const _sfStopTk = {
  requested: false,
  sleepers: new Set(), // pending abortable sleeps, so Stop can cut them short
};

function _sfStopTkRequested() {
  if (_sfStopTk.requested) return true;
  try {
    return sessionStorage.getItem("sortFeedStopSorting") === "on";
  } catch (e) {
    return false;
  }
}

// Abortable sleep — the finder's pacing primitive. Resolves normally on the
// timer, or immediately (with the timer cleared) when Stop fires.
function _sfStopTkSleep(ms) {
  return new Promise((resolve) => {
    if (_sfStopTk.requested) { resolve(); return; }
    const rec = { resolve: resolve, timer: null, settled: false };
    rec.timer = setTimeout(() => {
      if (rec.settled) return;
      rec.settled = true;
      _sfStopTk.sleepers.delete(rec);
      resolve();
    }, ms);
    _sfStopTk.sleepers.add(rec);
  });
}

function _sfStopTkFlushSleepers() {
  const pending = Array.from(_sfStopTk.sleepers);
  _sfStopTk.sleepers.clear();
  pending.forEach((rec) => {
    if (rec.settled) return;
    rec.settled = true;
    clearTimeout(rec.timer);
    try { rec.resolve(); } catch (e) {}
  });
}

// The express route: abort everything in flight and finish from what has
// already been collected. Idempotent.
function _sfStopTkNow() {
  if (_sfStopTk.requested) return;
  _sfStopTk.requested = true;
  _sfStopTkFlushSleepers();
  const outlierMeta = _sfOutlierCancelTk();
  _sfTkRenderSorted(inMemoryFeedData.items, outlierMeta);
}

window.addEventListener("message", (event) => {
  if (event.source !== window || !event.data || !event.data.sf_stop_sorting) return;
  // Profile surface only. Search and Saved run in their own page-world scripts
  // with their own memory, and all three receive this same broadcast — the
  // surface flag (unset on profile) decides which one owns the abort.
  if (sessionStorage.getItem("sortFeedSurfaceTikTok")) return;
  _sfStopTkNow();
});

// Stop pressed during an outlier sort: kill pool mode and its watchdog on the
// spot (it otherwise only noticed when a page landed or on the watchdog tick).
// Returns the meta the render should use, or null when no scoring session is on.
function _sfOutlierCancelTk() {
  const P = _sfOutlierPool;
  P.stoppedByUser = true;
  P.active = false;
  clearTimeout(P.waitTimer);
  P.waitTimer = null;

  const cancelled = { status: "cancelled", baseline: null, poolSize: 0 };

  const resolveFn = P.resolveFn;
  P.resolveFn = null;
  if (resolveFn) resolveFn(cancelled);

  return sessionStorage.getItem("sortFeedOutlierTikTok") === "on" ? cancelled : null;
}

// ── One render, ever ────────────────────────────────────────────────────────
// Both the natural completion chains and the Stop express route funnel through
// _sfTkRenderSorted / _sfTkFinalizeEmptyRange; whichever arrives first wins.
let _sfTkSortFinalized = false;

function _sfTkRenderSorted(items, sfOutlierMeta) {
  if (_sfTkSortFinalized) return;
  _sfTkSortFinalized = true;

  // Read the sort config BEFORE the removeItem calls below wipe it — this is the
  // record a second popup sort is decided against (Tiktok/resort_tiktok.js).
  const _sfCtx = _sfTkBuildCtx(items, sfOutlierMeta);

  // Captured for the same reason: the opportunistic-baseline work below would
  // otherwise read these once they're gone.
  const scoreable = _sfOutlierScorableSurfaceTk();
  const stoppedShort = _sfStopTkRequested() || _sfOutlierPool.stoppedByUser;

  sessionStorage.removeItem("sortFeedStopSorting");
  sessionStorage.removeItem("sortFeedStatusTikTok");
  // Tells the fetch hook to start blocking further item_list requests. Must be
  // set on the Stop path too, or TikTok keeps feeding us pages after the render.
  sessionStorage.setItem("sortFeedSortDoneTikTok", "true");

  const list = Array.isArray(items) ? items : [];

  // Stopped before a single tile finished capturing — nothing to render, so
  // leave TikTok's own feed alone and just clear our chrome.
  if (!list.length) {
    removeSortFeedBannerMessage();
    remove_overlay();
    return;
  }

  // ── Opportunistic baseline ──
  // The user sorted by views/likes, but if the pages we already read happen to
  // hold enough qualifying items, the median is pure arithmetic on data in
  // memory — no extra fetch, no delay. Compute it, so Outlier becomes available
  // in the banner's Sort-by list without a re-collect.
  //
  // Skipped after a Stop: that pool is truncated the same way the display set is,
  // and a truncated pool would bias the median.
  //
  // `_sfOutlierEvaluate` is the same gate an explicit outlier sort uses — so this
  // cannot invent a baseline that a real outlier sort wouldn't have produced.
  let opportunistic = null;
  if (!sfOutlierMeta && scoreable && !stoppedShort) {
    const free = _sfOutlierEvaluate();
    if (free && free.status === "ok" && free.baseline > 0) opportunistic = free;
  }

  const meta = sfOutlierMeta || opportunistic;
  _sfCtx.outlier = meta; // record what actually scored this grid, however it arrived

  // Why an ordinary sort did (or didn't) get a baseline for free. Set DBUG at
  // the top of this file to see it.
  if (DBUG && scoreable) {
    const P = _sfOutlierPool;
    console.log("[sf-outlier] baseline at render:", meta ? meta.status : "none", {
      source: sfOutlierMeta ? "requested sort" : opportunistic ? "computed free" : "—",
      baseline: meta ? meta.baseline : null,
      poolSize: P.map.size,                        // videos recorded
      qualifying: _sfOutlierQualifying().length,   // unpinned, ≥72h
      needed: `${SF_OUTLIER_FLOOR} min / ${SF_OUTLIER_CAP} caps it`,
      morePagesExist: P.hasNext,
      stoppedByUser: stoppedShort,
    });
  }

  _sfOutlierStampScores(list, meta);
  // Toasts stay tied to a REQUESTED outlier sort — "not enough videos" or "no
  // breakout" would be baffling on a plain likes sort the user never asked to score.
  _sfOutlierNotifyOutcome(list, sfOutlierMeta);

  const sort_by = sessionStorage.getItem("sortFeedSortBy");
  const sorted_items = sort_items_tiktok(list, sort_by);

  removeSortFeedBannerMessage();
  remove_overlay();

  window.postMessage(
    { logo_animate_off_tiktok: true, payload: sorted_items, sf_outlier: meta, sf_ctx: _sfCtx },
    "*",
  );
}

// The sort-context record — what this scrape covered, so the next popup sort can
// tell whether it's already holding the answer. One builder, called from the
// single render choke point (so the Stop route records itself too) and from the
// empty-range finalizer.
//
// `collectedCount` is exact: aborted items are dropped before the save, never
// half-written, so it always equals the tiles on screen.
function _sfTkBuildCtx(items, sfOutlierMeta) {
  const list = Array.isArray(items) ? items : [];
  let stopped = false;
  try {
    stopped = _sfStopTk.requested || sessionStorage.getItem("sortFeedStopSorting") === "on";
  } catch (e) {}
  return {
    mode: sessionStorage.getItem("sortItemsVsDates"),      // "items" | "dates"
    selection: sessionStorage.getItem("sortFeedNoItems"),  // "100_reels" | "3_month" | "custom_…"
    sortBy: sessionStorage.getItem("sortFeedSortBy"),
    // Profile is the only surface with no flag — search/favorites/liked/
    // collection each run in their own page-world script and stamp their own.
    surface: sessionStorage.getItem("sortFeedSurfaceTikTok") || "profile",
    path: location.pathname,
    search: location.search,
    collectedCount: list.length,
    deepestSeenMs: _sfTkDeepestSeenMs,  // diagnostic only — see the declaration
    feedExhausted: _sfTkFeedExhausted,
    pinnedSkipped: _sfTkDatePinnedSkipped,
    stoppedByUser: stopped,
    outlier: sfOutlierMeta || null,
  };
}

// Date sorts that matched nothing: leave the feed as it is and turn the
// progress banner into a friendly toast. Shares the render latch.
function _sfTkFinalizeEmptyRange() {
  if (_sfTkSortFinalized) return;
  _sfTkSortFinalized = true;

  // Marked empty so a following sort refreshes instead of trying to re-shuffle a
  // grid that was never built. (No banner mounts on this path either, so the
  // router would go cold regardless — this keeps the record honest.)
  const _sfCtx = Object.assign(_sfTkBuildCtx([], null), { empty: true });

  sessionStorage.removeItem("sortFeedStopSorting");
  sessionStorage.removeItem("sortFeedStatusTikTok");
  sessionStorage.setItem("sortFeedSortDoneTikTok", "true");

  window.postMessage({ tiktok_date_range_empty: true, sf_ctx: _sfCtx }, "*");
}

window.addEventListener("message", (event) => {
  if (event.data?.source === "sortfeed" && event.data?.type === "reset_tiktok_session") {
    // console.log("[SF] reset_tiktok_session received");
    reset_in_memory_feed_data();
    window.__sfSeenIds = new Set(); // optional dedupe if you add it
    // Profile sorts don't reload (mimicTikTokVisit soft-navigates), so wipe the
    // outlier baseline pool here or a prior profile's data would leak into it.
    _sfOutlierResetPool();
    // Same reason for the Stop state: IG can rely on the reload to clear these,
    // TikTok can't. Without this a sort started after a Stop would abort at its
    // first checkpoint and never render.
    _sfStopTk.requested = false;
    _sfStopTkFlushSleepers();
    _sfTkSortFinalized = false;
    // Same reason again: the sort-context trackers describe ONE scrape, and
    // without a reload the next one would inherit "the feed ran out" from the
    // last profile — which would serve a warm re-sort from a set that doesn't
    // cover the request.
    _sfTkFeedExhausted = false;
    _sfTkDatePinnedSkipped = false;
    _sfTkDeepestSeenMs = null;
    // Same reason once more: the scan bar's cursor describes ONE scrape. Left
    // behind, the next sort would open with "we already reached 2019" and paint
    // a full bar on its first item.
    _sfTkScanCursorMs = null;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Outlier score — baseline pool (Profile → Videos only, gated by the
// `sortFeedOutlierTikTok` sessionStorage flag set in init_sortfeed_tiktok.js).
//
// Mirrors the Instagram engine (Instagram/script_instagram.js) 1:1, simplified
// to a single metric: TikTok is VIEWS-only (playCount), so there's no Posts/
// likes branch. score = item views ÷ baseline, where baseline = MEDIAN views of
// the account's most recent 25 qualifying videos — qualifying = unpinned and at
// least 72h old. There is NO time window (the 90→180→365 ladder was removed
// 2026-08-27; see _sfOutlierComputeMeta for why). Floor: fewer than 20
// qualifying in the whole feed → status "insufficient", no badges, which now
// genuinely means a new or tiny account.
//
// ⚠️ The cap is a STOP condition, not a target: _sfOutlierEvaluate returns the
// moment 25 videos qualify. It was 100, which forced a free user's 25-item sort
// to sit through ~4x the pagination it asked for, watching a "collecting…"
// banner for data it would never display. At 25 the display scrape has almost
// always already recorded enough — it parses WHOLE pages while the display loop
// stops mid-page — so the free compute hits at the end of collection and pool
// mode never runs. Cost: a median off ~25 samples instead of ~100 is noisier
// (roughly ±18% vs ±10% for a log-normal view distribution), which the
// 2×/5×/10× tiers are coarse enough to absorb except right at a boundary.
//
// The cap is deliberately NOT coupled to the user's item selection (25/50/100):
// one baseline per creator keeps the same video showing the same multiple
// across sorts.
//
// Collection: every /api/post/item_list page the display sort scrolls through is
// recorded for free (deduped by id); if the display phase ends with fewer than
// the cap banked, "pool mode" keeps TikTok paginating with one lightweight
// scroll per page (same infinite-scroll trigger, no find_element media wait)
// until the cap is full or the feed runs out. The render waits on
// `_sfOutlierEnsurePool` so badges paint with the grid.
//
// ⚠️ TikTok-specific vs IG: profile sorts use mimicTikTokVisit (soft nav, no
// reload), so this module PERSISTS across sorts. `_sfOutlierResetPool()` is
// called on every `reset_tiktok_session` so a prior profile's pool can't leak.
// ─────────────────────────────────────────────────────────────────────────────

const SF_OUTLIER_MIN_AGE_MS = 72 * 60 * 60 * 1000; // <72h = too new to have matured
const SF_OUTLIER_FLOOR = 20;                       // min qualifying videos for a trustworthy median
const SF_OUTLIER_CAP = 25;                         // most-recent qualifying videos kept for the median (see note above)
const SF_OUTLIER_MAX_POOL_PAGES = 40;              // safety: runaway pagination
const SF_OUTLIER_MAX_POOL_MS = 90 * 1000;          // safety: wall-clock cap
const SF_OUTLIER_PAGE_WAIT_MS = 3500;              // watchdog per scroll attempt
const SF_OUTLIER_MAX_SCROLL_ATTEMPTS = 4;          // re-scrolls before treating the feed as stalled

const _sfOutlierPool = {
  map: new Map(),        // id → { dateMs, metricVal, pinned }
  active: false,         // pool mode running (display phase done, still paginating)
  hasNext: true,
  lastCode: null,        // id of the deepest-fetched item (pool mode's scroll target)
  stoppedByUser: false,  // Stop Sorting clicked during the display phase
  pagesFetched: 0,
  startTs: 0,
  waitTimer: null,
  scrollAttempts: 0,
  resolveFn: null,
};

// ── No server-cached median (V2 removed 2026-08-27, mirrors IG) ─────────────
// There used to be a Cloudflare/D1 cache of each creator's median, read once per
// sort and written back after every live compute. With SF_OUTLIER_CAP at 25 the
// local compute almost always succeeds the moment collection ends, so the cached
// answer was being fetched and then discarded — a worker round-trip plus a D1
// write per sort, for a value nothing read.
//
// Computing fresh every time is also simply better: a cached baseline could be
// up to 7 days stale on a growing account, and two people sorting the same
// profile on the same day could see different multiples depending on who hit the
// cache. The score is now a pure function of the feed as it stands right now.
//
// What this costs: an account that was active a year ago and went quiet (few
// recent items, deep back catalogue) can't reach 25 qualifying from the display
// scrape, so pool mode paginates instead of taking the short-circuit. Bounded by
// SF_OUTLIER_MAX_POOL_PAGES / _MS.
//
// The worker itself is still deployed, so this is reversible: git revert brings
// the outlier_cache_tiktok.js bridge back.

// TikTok scores on views only — no Posts/likes branch (unlike IG). Kept as a
// function so the meta carries `metric` and the shared content-script helpers/
// tooltips (which read meta.metric) work unchanged.
function _sfOutlierMetric() {
  return "views";
}

// Can this surface be scored at all? Profile Videos only — search and the three
// saved surfaces are multi-creator, so a median across them would be meaningless.
// They each set sortFeedSurfaceTikTok; profile is the one with no flag.
//
// ⚠️ Deliberately does NOT test `sortFeedStatusTikTok`. Every collect loop clears
// that flag just BEFORE it resolves, so by render time the sort no longer looks
// "in flight". Gating the render-time baseline work on it is what silently
// disabled tiers 1 and 2 on Instagram — likes→outlier always re-collected, while
// outlier→likes worked (that path carries its own meta and never consults this).
function _sfOutlierScorableSurfaceTk() {
  return !sessionStorage.getItem("sortFeedSurfaceTikTok");
}

// Whether to RECORD a response into the pool — a scorable surface with a sort
// actually in flight (or pool mode running, which outlives the display phase).
// The in-flight test belongs here and only here, so TikTok's own background
// fetches after a sort can't leak into the pool.
//
// Deliberately weaker than _sfOutlierSessionOn: the recorder runs on every
// profile sort now, not just outlier ones, so an ordinary views/likes sort can
// compute a median for free when it happens to have read enough pages.
function _sfOutlierRecordOnTk() {
  return (
    _sfOutlierScorableSurfaceTk() &&
    (sessionStorage.getItem("sortFeedStatusTikTok") !== null || _sfOutlierPool.active)
  );
}

// The user explicitly asked for an outlier sort. Drives pool mode + the toasts;
// everything opportunistic goes through _sfOutlierRecordOnTk instead.
function _sfOutlierSessionOn() {
  return sessionStorage.getItem("sortFeedOutlierTikTok") === "on" && _sfOutlierRecordOnTk();
}

// Profile sorts don't reload on TikTok (mimicTikTokVisit soft-navigates), so the
// pool must be wiped at the start of every sort — driven by reset_tiktok_session.
function _sfOutlierResetPool() {
  const P = _sfOutlierPool;
  clearTimeout(P.waitTimer);
  P.map = new Map();
  P.active = false;
  P.hasNext = true;
  P.lastCode = null;
  P.stoppedByUser = false;
  P.pagesFetched = 0;
  P.startTs = 0;
  P.waitTimer = null;
  P.scrollAttempts = 0;
  P.resolveFn = null;
}

// Record every item of an /api/post/item_list page into the pool (deduped by id)
// and track the cursor state. Runs for display-phase pages AND pool-mode pages.
// metricVal = views (playCount); date = createTime (secs → ms); pinned =
// isPinnedItem. `items` is the raw item array; `hasNext` is the page's hasMore.
function _sfOutlierRecordResponse(items, hasNext) {
  if (!Array.isArray(items)) return;
  for (const raw of items) {
    if (!raw) continue;
    const pk = raw.id;
    if (pk === null || pk === undefined) continue;
    const key = String(pk);
    if (!_sfOutlierPool.map.has(key)) {
      const metricVal = raw?.stats?.playCount ?? null;
      const dateMs = raw.createTime ? raw.createTime * 1000 : NaN;
      const pinned = !!raw.isPinnedItem;
      _sfOutlierPool.map.set(key, { dateMs, metricVal, pinned });
    }
    _sfOutlierPool.lastCode = key; // deepest id seen → pool-mode scroll anchor
  }
  _sfOutlierPool.hasNext = !!hasNext;
  if (_sfOutlierPool.active) _sfOutlierPoolPageArrived();
}

// Qualifying items: unpinned, matured (≥72h), with a views value. No age
// ceiling — see _sfOutlierComputeMeta.
function _sfOutlierQualifying() {
  const now = Date.now();
  const out = [];
  _sfOutlierPool.map.forEach((r) => {
    if (r.pinned || r.metricVal === null || !Number.isFinite(r.dateMs)) return;
    if (now - r.dateMs >= SF_OUTLIER_MIN_AGE_MS) out.push(r);
  });
  return out;
}

// Pool progress (0..1) for the banner's bar: qualifying items ÷ cap.
//
// This used to also weigh "window coverage" (oldest item's age ÷ the window) and
// take the max of the two, because the pool could finish either by filling the
// cap or by scrolling past the window's edge. With the window gone there is one
// finish line left, so there is one signal.
function _sfOutlierPoolProgress() {
  return Math.max(0, Math.min(1, _sfOutlierQualifying().length / SF_OUTLIER_CAP));
}

// Count sent with the pool-mode tick: the QUALIFYING videos (unpinned, ≥72h)
// that feed the median — NOT the raw pool — clamped to the cap. The banner
// ignores it these days, but it stays in the message contract.
function _sfOutlierDisplayCount() {
  return Math.min(SF_OUTLIER_CAP, _sfOutlierQualifying().length);
}

// Median of the most recent SF_OUTLIER_CAP qualifying views.
//
// ── No time window (2026-08-27, mirrors IG) ─────────────────────────────────
// The baseline used to be "qualifying videos inside a 90-day window", widening
// to 180 then 365 when fewer than SF_OUTLIER_FLOOR qualified, and giving up as
// `insufficient` if 365 still fell short. That ladder was built for a cap of
// 100. At a cap of 25 it does almost nothing useful and one thing actively
// harmful: on any account posting even weekly the window never binds, and on a
// SLOW account it is the only thing that binds — and what it does is refuse to
// score (a real profile with 50 reels spanning 851 days had just 10 inside a
// year and reported "not enough").
//
// So the window is gone. The baseline is simply the most recent 25 qualifying
// videos, whenever they were posted, and `insufficient` now means what the
// toast says it means: fewer than 20 mature videos in total.
//
// The trade-off, stated plainly: on a slow account those 25 can span a long
// time, so "more views than usual" means "than this creator's recent history"
// rather than "than they're doing lately". Unavoidable — there is no way to
// score a creator who posts ten times a year AND keep the baseline tight — and
// far better than refusing to score at all.
function _sfOutlierComputeMeta() {
  const metric = _sfOutlierMetric();
  let q = _sfOutlierQualifying();
  if (q.length < SF_OUTLIER_FLOOR) {
    return { status: "insufficient", baseline: null, poolSize: q.length, metric };
  }
  q.sort((a, b) => b.dateMs - a.dateMs);          // newest first
  if (q.length > SF_OUTLIER_CAP) q = q.slice(0, SF_OUTLIER_CAP);
  const vals = q.map((r) => +r.metricVal).sort((a, b) => a - b);
  const mid = vals.length >> 1;
  const baseline = vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
  if (!(baseline > 0)) {
    return { status: "insufficient", baseline: null, poolSize: q.length, metric };
  }
  return { status: "ok", baseline, poolSize: q.length, metric };
}

// Decide whether the pool is complete. Returns the final meta, or null when more
// pages are needed. Two finish lines, down from four:
//   • the cap is full — the feed is newest-first, so these ARE the most recent;
//   • the feed is exhausted — no more pages are coming, so compute with whatever
//     qualified (which returns `insufficient` below the floor).
function _sfOutlierEvaluate() {
  const P = _sfOutlierPool;
  if (_sfOutlierQualifying().length >= SF_OUTLIER_CAP) return _sfOutlierComputeMeta();
  if (!P.hasNext) return _sfOutlierComputeMeta();
  return null; // more pages needed
}

function _sfOutlierFinish(meta) {
  const P = _sfOutlierPool;
  P.active = false;
  clearTimeout(P.waitTimer);
  P.waitTimer = null;
  const resolveFn = P.resolveFn;
  P.resolveFn = null;
  // No "finishing" step — resolving hands straight to the render, which removes
  // the banner (animating the bar to 100% then fading) as the sorted feed appears.
  if (resolveFn) resolveFn(meta);
}

// Pool mode's per-page tick — called from the recorder for every item_list page
// that lands while pool mode is active.
function _sfOutlierPoolPageArrived() {
  const P = _sfOutlierPool;
  if (!P.active) return;
  P.pagesFetched++;
  P.scrollAttempts = 0;
  clearTimeout(P.waitTimer);
  window.postMessage(
    { sf_outlier_analyzing: true, count: _sfOutlierDisplayCount(), progress: _sfOutlierPoolProgress() },
    "*",
  );

  // Stop button pressed during pool mode → render without badges.
  if (sessionStorage.getItem("sortFeedStopSorting") === "on") {
    sessionStorage.removeItem("sortFeedStopSorting");
    _sfOutlierFinish({ status: "cancelled", baseline: null, poolSize: 0 });
    return;
  }

  const meta = _sfOutlierEvaluate();
  if (meta) { _sfOutlierFinish(meta); return; }

  if (P.pagesFetched >= SF_OUTLIER_MAX_POOL_PAGES || Date.now() - P.startTs > SF_OUTLIER_MAX_POOL_MS) {
    // A truncated pool would bias the median — bail to the no-badge state.
    _sfOutlierFinish({ status: "error", baseline: null, poolSize: 0 });
    return;
  }
  _sfOutlierRequestNextPage();
}

// Trigger TikTok's own infinite scroll for the next item_list page. Jump to the
// BOTTOM of the loaded grid (the reliable "load more" trigger) and NO media wait
// — pool items are metadata-only, so this is the lightweight scroll proxy the IG
// engine uses, reusing TikTok's existing scroll-to-load-more behaviour.
function _sfOutlierRequestNextPage() {
  const P = _sfOutlierPool;
  if (!P.active) return;
  // Nudge the deepest-known tile into view first (helps virtualized grids render
  // the tail), then jump to the absolute bottom to trip the infinite scroll.
  const anchor = P.lastCode ? document.querySelector(`a[href*="${P.lastCode}"]`) : null;
  if (anchor) anchor.scrollIntoView({ behavior: "auto", block: "end" });
  window.scrollTo(0, document.body.scrollHeight);
  clearTimeout(P.waitTimer);
  P.waitTimer = setTimeout(() => {
    if (!P.active) return;
    if (sessionStorage.getItem("sortFeedStopSorting") === "on") {
      sessionStorage.removeItem("sortFeedStopSorting");
      _sfOutlierFinish({ status: "cancelled", baseline: null, poolSize: 0 });
      return;
    }
    if (++P.scrollAttempts >= SF_OUTLIER_MAX_SCROLL_ATTEMPTS) {
      _sfOutlierFinish({ status: "error", baseline: null, poolSize: 0 });
    } else {
      _sfOutlierRequestNextPage();
    }
  }, SF_OUTLIER_PAGE_WAIT_MS);
}

// Display phase finished → decide the baseline before rendering:
//   (1) the pool already holds enough to compute a median → compute live. At
//       SF_OUTLIER_CAP 25 this is the normal outcome: the recorder takes WHOLE
//       pages while the display loop stops mid-page, so collection has usually
//       banked more than the cap needs.
//   (2) not enough yet → pool mode (keep paginating).
// Resolves with the outlier meta, or null when no scoring session is on. Never
// rejects, so it can sit inline in the render chain.
function _sfOutlierEnsurePool() {
  return new Promise((resolve) => {
    try {
      if (sessionStorage.getItem("sortFeedOutlierTikTok") !== "on") { resolve(null); return; }
      const P = _sfOutlierPool;
      if (P.stoppedByUser || _sfStopTkRequested()) {
        resolve({ status: "cancelled", baseline: null, poolSize: 0 });
        return;
      }
      // (1) Pool already holds enough → compute live, no extra pagination.
      const early = _sfOutlierEvaluate();
      if (early) { resolve(early); return; }

      // (2) Not enough yet → pool mode.
      if (DBUG) console.log("[sf-outlier] pool short of the cap → pool mode");
      P.active = true;
      P.startTs = Date.now();
      P.pagesFetched = 0;
      P.scrollAttempts = 0;
      P.resolveFn = resolve;
      window.postMessage(
        { sf_outlier_analyzing: true, count: _sfOutlierDisplayCount(), progress: _sfOutlierPoolProgress() },
        "*",
      );
      _sfOutlierRequestNextPage();
    } catch (e) {
      resolve({ status: "error", baseline: null, poolSize: 0 });
    }
  });
}

// Score below which an item gets no badge — mirrors _sfOutlierTier's tier-1
// cutoff (2×) in update_tiktok_ui.js. Lets the page world tell when a sort
// produced ZERO badges without importing the content-script code.
const SF_OUTLIER_BADGE_MIN = 2;

// After an outlier sort resolves, post the user-facing note (if any) the banner
// should show on removal. Two OUTCOMES, deliberately worded apart because they
// are not the same claim:
//   • NO BASELINE (case B) → we never had a yardstick, so we can say nothing
//     about consistency. Copy asks for more TikToks and names the fallback
//     order. Covers `insufficient` AND `error` (a pool-mode bail: page/time/
//     stall cap). `error` used to be silent, which left a views-ordered grid
//     with no explanation at all.
//   • BASELINE OK, nothing cleared the badge floor (all < 2×) (case A) → this
//     genuinely IS "everything performed consistently"; scores exist and the
//     cards show real multiples, so the copy must NOT claim a views fallback.
// `cancelled` stays silent on purpose — the user pressed Stop and knows why.
function _sfOutlierNotifyOutcome(items, meta) {
  if (!meta) return;
  if (
    (meta.status === "insufficient" || meta.status === "error") &&
    sessionStorage.getItem("sortFeedSortBy") === "outlier"
  ) {
    window.postMessage({ sf_outlier_insufficient: true, metric: meta.metric }, "*");
    return;
  }
  if (meta.status === "ok" && Array.isArray(items)) {
    const anyBadge = items.some(
      (it) => it && typeof it.outlierScore === "number" && it.outlierScore >= SF_OUTLIER_BADGE_MIN,
    );
    if (!anyBadge) window.postMessage({ sf_outlier_no_breakout: true, metric: meta.metric }, "*");
  }
}

// Stamp each display item's score = its views ÷ baseline. Scores ride the items
// through the render postMessage, so badges/sort/filters never need a second
// round-trip. Items excluded from the BASELINE (pinned / <72h / out-of-window)
// still get scored.
function _sfOutlierStampScores(items, meta) {
  if (!meta || meta.status !== "ok" || !(meta.baseline > 0) || !Array.isArray(items)) return;
  const key = "viewCount"; // TikTok is views-only
  items.forEach((it) => {
    if (!it) return;
    it.outlierScore = it[key] != null ? +it[key] / meta.baseline : null;
  });
}

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

function createMetadataJsonTikTok(jsonResponse) {
  let metadataPerPost = {};

  // Create date
  let createDate = jsonResponse?.createTime;
  let timestamp = createDate ? createDate * 1000 : null;
  metadataPerPost.createDate = timestamp
    ? new Date(timestamp).toISOString()
    : "";

  // Video ID
  metadataPerPost.code = jsonResponse?.id || "";

  // Username
  metadataPerPost.userName = jsonResponse?.author?.uniqueId || "";

  // Views
  metadataPerPost.viewCount = jsonResponse?.stats?.playCount ?? null;

  // Likes
  metadataPerPost.likesCount = jsonResponse?.stats?.diggCount ?? null;

  // Comments
  metadataPerPost.commentsCount = jsonResponse?.stats?.commentCount ?? null;

  // Shares
  metadataPerPost.shareCount = jsonResponse?.stats?.shareCount ?? null;

  // Saves
  metadataPerPost.savesCount = jsonResponse?.stats?.collectCount ?? null;

  // Caption
  const desc =
    typeof jsonResponse?.desc === "string" && jsonResponse.desc.trim() !== ""
      ? jsonResponse.desc
      : " ";
  metadataPerPost.caption = desc;

  // photo vs. video
  metadataPerPost.photoFlag = Array.isArray(jsonResponse?.imagePost?.images) && jsonResponse.imagePost.images.length > 0;

  // Pinned — TikTok floats up to 3 pinned videos to the top of a profile
  // whatever their age. The outlier pool + the date loop already read this field
  // off the raw item; this puts it on the display item too, where the re-sort
  // router needs it: one ancient pinned video would otherwise make a 25-item
  // scrape look four years deep. Ignored by every export (they map explicit fields).
  metadataPerPost.pinned = !!jsonResponse?.isPinnedItem;

  // Audio URL for fast server-side transcription
  metadataPerPost.musicUrl = jsonResponse?.music?.playUrl ?? null;

  // Player media (playAddr / duration / cover / photo images / capture clock).
  Object.assign(metadataPerPost, _sfTkPlayerMedia(jsonResponse));

  return metadataPerPost;
}

// Save feed data locally, init and append
function save_data_locally_tiktok(singleNodeJSON) {
  if (sessionStorage.getItem("sortFeedData") !== null) {
    let itemsCleaned = JSON.parse(sessionStorage.getItem("sortFeedData"));
    itemsCleaned.push(singleNodeJSON);
    sessionStorage.setItem("sortFeedData", JSON.stringify(itemsCleaned));
    return itemsCleaned;
  } else {
    let itemsCleaned = [];
    itemsCleaned.push(singleNodeJSON);
    sessionStorage.setItem("sortFeedData", JSON.stringify(itemsCleaned));
    return itemsCleaned;
  }
}

function startSmartScroll() {
  let lastHeight = 0;
  let attempts = 0;
  const maxAttempts = 15;
  const intervalMs = 100;
  let timeoutId = null;
  let stopped = false;

  function smartScrollToBottom() {
    if (stopped) return;

    const newHeight = document.body.scrollHeight;

    if (newHeight > lastHeight) {
      window.scrollTo(0, newHeight);
      lastHeight = newHeight;
      attempts = 0;
    } else {
      window.scrollBy(0, 200);
      attempts++;
    }

    if (attempts < maxAttempts) {
      timeoutId = setTimeout(smartScrollToBottom, intervalMs);
    } else {
      if (DBUG) console.log("No more content to load or hit max attempts.");
    }
  }

  smartScrollToBottom();

  return function stop() {
    stopped = true;
    if (timeoutId) clearTimeout(timeoutId);
    if (DBUG) console.log("Smart scroll manually stopped.");
  };
}

function send_items_collected_no(itemsCleaned) {
  if (itemsCleaned !== null) {
    try {
      let items_collected_no = itemsCleaned.length;
      // console.log('SEND MESSAGE');
      // send message to content script UI (unable to use webhook to send messages directly to background)
      window.postMessage(
        { item_collected_no: true, number_items: items_collected_no },
        "*",
      );
    } catch (e) {
      if (DBUG) console.error("Error sending message", e);
    }
  }
}

// ── Scan progress — the bar for sorts that have no item target ───────────────
// A DATE sort's finish line isn't a count, it's a date. The profile feed is
// newest-first, so the createTime of the video the collect loop is on IS the
// distance travelled from now back toward the range's start — a real, monotonic
// 0..1 the banner can drive its bar off. Same idea as _sfOutlierPoolProgress,
// which measures how full the outlier baseline pool is. Port of _sfScanProgress
// in Instagram/script_instagram.js.
//
// Two signals, maxed together (again mirroring the outlier bar, and for the same
// reason — either one alone stalls on some accounts):
//   • time coverage — exact whenever the range's start lies inside the feed;
//   • a work asymptote, collected ÷ (collected + K) — takes over when time says
//     nothing: an "All" scrape (whose finish line is "feed exhausted", not a
//     date) or an account younger than the requested range, where coverage would
//     top out low and then jump.
// Plus a floor once TikTok reports hasMore === false: the last page has landed,
// so only per-item DOM work remains and the bar belongs near the end.
const SF_TK_SCAN_WORK_K = 60;            // knee of the work asymptote, in items
const SF_TK_SCAN_LAST_PAGE_FLOOR = 0.9;  // reached the final page → nearly done

// The oldest createDate the collect loop has actually REACHED. Deliberately not
// _sfTkDeepestSeenMs: that one jumps a whole page ahead the moment a response
// lands, so the bar would leap then sit still through the per-item DOM work.
// This advances one item at a time, which is what makes the bar move smoothly.
// Cleared in reset_tiktok_session — profile sorts soft-navigate, so nothing else
// would zero it between two sorts.
let _sfTkScanCursorMs = null;

function _sfNoteTkScanCursor(createDate) {
  const ms = Number(new Date(createDate));
  if (!Number.isFinite(ms) || ms <= 0) return;
  if (_sfTkScanCursorMs === null || ms < _sfTkScanCursorMs) _sfTkScanCursorMs = ms;
}

function _sfTkScanWorkProgress() {
  const n = (inMemoryFeedData.items || []).length;
  return n / (n + SF_TK_SCAN_WORK_K);
}

// 0..1, or null when this sort has a real item target and doesn't need it.
function _sfTkScanProgress() {
  const mode = sessionStorage.getItem("sortItemsVsDates");
  const selection = sessionStorage.getItem("sortFeedNoItems") || "";
  const openEnded = selection === "all_reels";

  // Item sorts drive the bar off count ÷ target — except "All", which has no
  // target (parseInt("all_reels") is NaN) and fell into the very same dead
  // branch in the banner.
  if (mode !== "dates" && !openEnded) return null;

  let progress = _sfTkScanWorkProgress();

  // Time coverage: the journey is now → the range's start, and the cursor says
  // where we are along it. One formula covers both legs of a historical custom
  // range — the "seek" down to the range's top edge takes exactly its true share
  // of the bar, so there's no discontinuity when the range itself is reached.
  // Skipped for "All", whose 10-year span is a stand-in for "everything", not a
  // real boundary to travel to.
  if (!openEnded && _sfTkScanCursorMs !== null) {
    let range = null;
    try { range = return_date_range(selection); } catch (e) {}
    const now = Date.now();
    const journey = range ? now - Number(range[0]) : NaN;
    if (Number.isFinite(journey) && journey > 0) {
      progress = Math.max(progress, (now - _sfTkScanCursorMs) / journey);
    }
  }

  if (_sfTkFeedExhausted) progress = Math.max(progress, SF_TK_SCAN_LAST_PAGE_FLOOR);
  return Math.max(0, Math.min(1, progress));
}

function insta_banner_notification(itemsCleaned) {
  if (itemsCleaned !== null) {
    try {
      let items_collected_no = itemsCleaned.length;
      const msg = { insta_banner_notification: true, count: items_collected_no };
      // An outlier sort's DISPLAY phase drives the bar exactly like the same
      // sort without outlier — count/target for items, coverage for dates.
      //
      // It used to hand the banner window coverage instead, for both phases, so
      // the display→pool handoff was one continuous stream. That made sense when
      // the pool ran to 100 items and dwarfed the display phase. At
      // SF_OUTLIER_CAP 25 the coverage signal saturates almost immediately, so
      // the bar shot to its 95% ceiling and sat there for the whole scrape
      // looking hung. (Mirrors IG.)
      //
      // Pool mode still drives its own bar (sf_outlier_analyzing →
      // _sfOutlierBannerAnalyzingTk), and it now picks up from whatever the
      // display phase had painted rather than restarting from coverage.
      const scan = _sfTkScanProgress();
      if (scan !== null) msg.scanProgress = scan;
      window.postMessage(msg, "*");
    } catch (e) {
      if (DBUG) console.error("Error sending message", e);
    }
  }
}

function removeSortFeedBannerMessage() {
  window.postMessage({ insta_banner_notification_remove: true }, "*");
}

function update_data_object_with_element_tiktok(singleNodeJSON, element) {
  // create user name (profile name)
  singleNodeJSON.element = element.outerHTML;
  return singleNodeJSON;
}


function quickHumanScroll(element) {
  const rect = element.getBoundingClientRect();
  const offset = (Math.random() - 0.5) * 80; // Slight randomness
  const targetY = window.scrollY + rect.top - (window.innerHeight / 2) + offset;
  
  window.scrollTo({ top: targetY, behavior: "auto" });
}

// function find_element_tiktok_again(id, retries = 30, interval = 100) {
//   return new Promise((resolve) => {

//     // ⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐
//     // ⭐ NEW — SESSION GUARD (IG-style)
//     // ⭐ If sorting is no longer active,
//     // ⭐ immediately resolve and stop everything.
//     // ⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐
//     const isActive = () =>
//       !!sessionStorage.getItem("sortFeedStatusTikTok");


//     const tryFind = (attemptsLeft) => {

//       // ⭐ NEW — STOP BEFORE RETRY
//       if (!isActive()) return resolve(null);

//       const targetAnchor = document.querySelector(`a[href*="${id}"]`);

//       if (targetAnchor) {
//         const parent = targetAnchor.closest('[data-e2e="user-post-item-list"]');

//         let fullPostBlock = targetAnchor;
//         while (fullPostBlock && fullPostBlock.parentElement !== parent) {
//           fullPostBlock = fullPostBlock.parentElement;
//         }

//         if (!fullPostBlock) return resolve(null);

//         quickHumanScroll(fullPostBlock);

//         const isGoodSrc = (src) => {
//           if (!src) return false;
//           if (src.startsWith("data:")) return false;
//           if (src.includes("transparent") || src.includes("blank")) return false;
//           return true;
//         };

//         const isImgActuallyLoaded = (img) => {
//           if (!img) return false;

//           const src =
//             img.currentSrc || img.src || img.getAttribute("src") || "";

//           if (!isGoodSrc(src)) return false;
//           if (!img.complete) return false;

//           if ((img.naturalWidth || 0) === 0 || (img.naturalHeight || 0) === 0)
//             return false;

//           return true;
//         };

//         const hasVisualMedia = () => {
//           const imgs = Array.from(fullPostBlock.querySelectorAll("img"));
//           if (imgs.some(isImgActuallyLoaded)) return true;

//           const bg = getComputedStyle(fullPostBlock).backgroundImage || "";
//           if (bg && bg !== "none" && !bg.includes("data:")) return true;

//           return false;
//         };

//         const checkMediaLoaded = () => {

//           // ⭐ NEW — STOP BEFORE MEDIA POLL
//           if (!isActive()) return resolve(null);

//           if (hasVisualMedia()) {
//             resolve(fullPostBlock);
//           } 
//           else if (retries-- > 0) {

//             // ⭐ NEW — STOP BEFORE SCHEDULING NEXT TIMEOUT
//             if (!isActive()) return resolve(null);

//             setTimeout(checkMediaLoaded, interval);
//           } 
//           else {
//             resolve(fullPostBlock);
//           }
//         };

//         checkMediaLoaded();

//       } else if (attemptsLeft > 0) {

//         // ⭐ NEW — STOP BEFORE RETRY LOOP
//         if (!isActive()) return resolve(null);

//         setTimeout(() => tryFind(attemptsLeft - 1), interval);

//       } else {
//         resolve(null);
//       }
//     };

//     tryFind(retries);
//   });
// }

function find_element_tiktok_again(id, opts = {}) {
  const {
    maxAttempts = 12,          // fewer attempts, each attempt is calmer
    baseDelayMs = 220,         // slower than 100ms
    maxDelayMs = 1200,
    mediaTimeoutMs = 1200,     // don't poll forever for images
    scrollPadding = 140,       // keep it near viewport, not centered
  } = opts;

  // Stop makes this wait inactive immediately — the flag read alone would only
  // be seen after the current sleep finished (up to 1.2s).
  const isActive = () =>
    !!sessionStorage.getItem("sortFeedStatusTikTok") && !_sfStopTk.requested;

  // Abortable: Stop settles every pending sleep on the click's own tick.
  const sleep = (ms) => _sfStopTkSleep(ms);

  // jitter helper (human-ish)
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
    // "mostly visible" check
    return r.top >= -50 && r.top <= (window.innerHeight - 120);
  };

  const gentleScrollToward = async (el) => {
    // only scroll if it's not already visible
    if (inViewport(el)) return;

    const r = el.getBoundingClientRect();
    const targetY = window.scrollY + r.top - scrollPadding;

    // clamp small movement (avoid huge jumps that trigger lots of loading)
    const delta = targetY - window.scrollY;
    const step = Math.max(-500, Math.min(500, delta)); // at most 500px each time

    window.scrollTo({ top: window.scrollY + step, behavior: "auto" });

    // tiny pause to let layout/network settle
    await sleep(jitter(120, 0.5));
  };

  const findBlock = () => {
    const a = document.querySelector(`a[href*="${id}"]`);
    if (!a) return null;

    const parent = a.closest('[data-e2e="user-post-item-list"]');
    if (!parent) return null;

    // walk up until direct child of parent (same as your logic)
    let node = a;
    while (node && node.parentElement !== parent) node = node.parentElement;
    return node || null;
  };

  const mediaLooksReady = (block) => {
    // Keep this cheap: check only a couple images
    const imgs = block.querySelectorAll("img");
    for (let i = 0; i < Math.min(imgs.length, 2); i++) {
      const img = imgs[i];
      const src = img.currentSrc || img.src || img.getAttribute("src") || "";
      if (!src || src.startsWith("data:")) continue;
      if (!img.complete) continue;
      if ((img.naturalWidth || 0) > 0 && (img.naturalHeight || 0) > 0) return true;
    }
    return imgs.length === 0 ? true : false; // if no img, don't block
  };

  const waitForMedia = async (block) => {
    const start = performance.now();
    while (performance.now() - start < mediaTimeoutMs) {
      if (!isActive()) return null;
      if (mediaLooksReady(block)) return block;

      // backoff a bit each loop (human-ish)
      await sleep(jitter(180, 0.5));
      if (_sfStopTk.requested) return null; // Stop cut the sleep short
    }
    return block; // give up waiting, but still return element
  };

  return new Promise(async (resolve) => {
    if (!isActive()) return resolve(null);

    let delay = baseDelayMs;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (!isActive()) return resolve(null);

      const block = await runWhenIdle(findBlock);
      if (!isActive()) return resolve(null);

      if (block) {
        // only scroll if needed, and gently
        await gentleScrollToward(block);
        if (!isActive()) return resolve(null);

        // optional: wait briefly for media without tight polling
        const ready = await waitForMedia(block);
        return resolve(ready);
      }

      // If not found: wait with jitter + mild backoff
      await sleep(jitter(delay));
      if (!isActive()) return resolve(null); // Stop cut the sleep short
      delay = Math.min(maxDelayMs, Math.round(delay * 1.35));
    }

    resolve(null);
  });
}


function update_data_object_with_element_tiktok_again(postJson, element) {
  if (element) {
    postJson.element = element.outerHTML;
  }
  return postJson;
}

function scrollLikeHumanToBottom(speed = 5, step = 50) {
  const scroll = () => {
    const maxScroll = document.body.scrollHeight - window.innerHeight;
    if (window.scrollY < maxScroll) {
      window.scrollBy(0, step);
      setTimeout(scroll, speed);
    }
  };
  scroll();
}

async function sort_videos_tiktok(
  numberItems,
  jsonResponse,
  sort_selected,
  nextPage,
) {
  // console.log(`sort_videos_tiktok STARTED - numberItems: ${numberItems}, sort_selected: ${sort_selected}, nextPage: ${nextPage}`);
  return new Promise(async (resolve) => {
    for (let i = 0; i < numberItems; i++) {
      // Stop owns the finish from here on — bail without resolving (the express
      // route already rendered; _sfStopTkNow is a no-op if so).
      if (_sfStopTkRequested()) { _sfStopTkNow(); return; }

      // console.log(`Processing video ${i}/${numberItems}, itemsCleaned so far: ${inMemoryFeedData.items.length}`);
      let singleNode = jsonResponse[i];
      let singleNodeJSON = createMetadataJsonTikTok(singleNode);
      // get the tiktok video
      let element = await find_element_tiktok_again(singleNodeJSON.code);

      // Checked BEFORE the item is saved: an aborted wait hands back a null
      // element, and saving that would paint a blank tile.
      if (_sfStopTkRequested()) { _sfStopTkNow(); return; }

      // console.log('find_element_tiktok_again');
      // console.log(element);
      // update the video object
      let singleNodeJSONUpdated = update_data_object_with_element_tiktok_again(
        singleNodeJSON,
        element,
      );
      // save final data to main object 
      let itemsCleaned = save_data_locally_again(singleNodeJSONUpdated);

      if (sessionStorage.getItem("sortFeedStatusTikTok")) {
        send_items_collected_no(itemsCleaned);
        // show loading banner by sending message to banner_on_tiktok
        // console.log('itemsCleaned'); 
        // console.log(itemsCleaned); 
        // console.log(itemsCleaned.length); 

        insta_banner_notification(itemsCleaned);
        let sort_feed_sorting = sessionStorage.getItem("sortFeedStopSorting");

        // ✅ Case 00 -- user clicked stop sorting
        if (sort_feed_sorting === "on") {
          // console.log("CASE 00");
          // console.log("user clicked stop sorting");
          _sfOutlierPool.stoppedByUser = true; // aborted sort → skip outlier scoring
          sessionStorage.removeItem("sortFeedStopSorting");
          sessionStorage.removeItem("sortFeedStatusTikTok");
          removeSortFeedBannerMessage();
          resolve({ itemsCleaned });
          return;
        } else {
          // ✅ Case 01 -- scrapped same length chosen
          if (itemsCleaned.length === sort_selected) {
            // console.log("CASE 01");
            // console.log("scrapped same length chosen");
            sessionStorage.removeItem("sortFeedStopSorting");
            sessionStorage.removeItem("sortFeedStatusTikTok");
            resolve({ itemsCleaned });
            return;
          }
          // ✅ Case 02 -- no more next pages and reached end of network length
          else if (i === numberItems - 1 && nextPage === false) {
            // console.log("CASE 02");
            // console.log("no more next pages and reached end of network length");
            sessionStorage.removeItem("sortFeedStopSorting");
            sessionStorage.removeItem("sortFeedStatusTikTok");
            resolve({ itemsCleaned });
            return;
          }

          // ✅ Case 03 -- keep scrapping!
          else if (i === numberItems - 1 && nextPage === true) {
            // console.log("CASE 03");
            // console.log("keep scrapping");
            break;
          }
        }
      }
    }
  });
}

function return_sort_selection() {
  const value = sessionStorage.getItem("sortFeedNoItems");
  if (value === "all_reels") {
    return 10000;
  }
  const match = value.match(/^(\d+)_reels$/);
  if (match) {
    return parseInt(match[1], 10);
  }
  return null; // fallback if value doesn't match expected format
}

function sort_items_tiktok(data, sortBy) {
  if (sortBy === "outlier") {
    // Outlier order ≡ views order (one shared baseline → score is monotonic in
    // views); viewCount fallback keeps unscored items ordered if a stamp is
    // missing. Without this branch an "outlier" sort would hit the else → 0.
    return [...data].sort(
      (a, b) => ((b.outlierScore ?? b.viewCount) || 0) - ((a.outlierScore ?? a.viewCount) || 0),
    );
  } else if (sortBy === "views") {
    return [...data].sort((a, b) => b.viewCount - a.viewCount);
  } else if (sortBy === "likes") {
    return [...data].sort((a, b) => b.likesCount - a.likesCount);
  } else if (sortBy === "comments") {
    return [...data].sort((a, b) => b.commentsCount - a.commentsCount);
  } else if (sortBy === "saves") {
    return [...data].sort((a, b) => b.savesCount - a.savesCount);
  } else if (sortBy === "shares") {
    return [...data].sort((a, b) => b.shareCount - a.shareCount);
  } else if (sortBy === "oldest") {
    return [...data].reverse();
  } else {
    return 0;
  }
}

function return_date_range(sort_selected) {
  // Custom range — encoded as `custom_<fromMs>_<toMs>`
  if (typeof sort_selected === "string" && sort_selected.startsWith("custom_")) {
    const parts = sort_selected.split("_");
    const fromMs = parseInt(parts[1], 10);
    const toMs = parseInt(parts[2], 10);
    if (Number.isFinite(fromMs) && Number.isFinite(toMs)) {
      const start_date = new Date(fromMs);
      const end_date = new Date(toMs);
      end_date.setHours(23, 59, 59, 999);
      return [start_date, end_date];
    }
  }
  let start_date = new Date(); // Current date
  let end_date = new Date(); // Copy current date
  if (sort_selected === "1_week") {
    start_date.setDate(end_date.getDate() - 7);
    return [start_date, end_date];
  } else if (sort_selected === "1_month") {
    start_date.setDate(end_date.getDate() - 30);
    return [start_date, end_date];
  } else if (sort_selected === "3_month") {
    start_date.setDate(end_date.getDate() - 90);
    return [start_date, end_date];
  } else if (sort_selected === "6_month") {
    start_date.setDate(end_date.getDate() - 180);
    return [start_date, end_date];
  } else if (sort_selected === "1_year") {
    start_date.setDate(end_date.getDate() - 360);
    return [start_date, end_date];
  } else if (sort_selected === "all_reels") {
    start_date.setDate(end_date.getDate() - 3600); // 10 years ago
    return [start_date, end_date];
  }
}

function is_create_date_in_range(createDate, startDate, endDate) {
  const createDateObj = new Date(createDate);
  if (isNaN(createDateObj) || isNaN(startDate) || isNaN(endDate)) {
    throw new Error("Invalid date format");
  }
  return createDateObj >= startDate && createDateObj < endDate;
}

async function sort_videos_tiktok_dates(
  numberItems,
  jsonResponse,
  sort_selected,
  nextPage,
  startDate,
  endDate,
) {
  return new Promise(async (resolve) => {
    // Show the sort banner immediately so the user sees feedback even when the
    // first batch of TikToks is all newer than the requested range (skipped via continue).
    insta_banner_notification(inMemoryFeedData.items || []);
    for (let i = 0; i < numberItems; i++) {
      // Stop owns the finish from here on — see sort_videos_tiktok.
      if (_sfStopTkRequested()) { _sfStopTkNow(); return; }

      let singleNode = jsonResponse[i];
      let singleNodeJSON = createMetadataJsonTikTok(singleNode);
      let element = await find_element_tiktok_again(singleNodeJSON.code);

      // Before the save — an aborted wait hands back a null element.
      if (_sfStopTkRequested()) { _sfStopTkNow(); return; }

      let singleNodeJSONUpdated = update_data_object_with_element_tiktok_again(singleNodeJSON,element);
      let createDate = singleNodeJSONUpdated.createDate;

      // Advance the progress cursor — but never off a PINNED video. TikTok
      // floats up to 3 of those to the top whatever their age, so a pinned 2019
      // video would read as "we've already scrolled back years" and slam the bar
      // to 100% on item one.
      if (!singleNode.isPinnedItem) {
        _sfNoteTkScanCursor(createDate);
      }

      let sort_feed_sorting = sessionStorage.getItem("sortFeedStopSorting");

      // 1st check that status is on 
      // users click stop:  Resolve & remove banner etc & 

      if (sessionStorage.getItem("sortFeedStatusTikTok")) {

        // ✅ Case 00 -- user clicked stop sorting
        if (sort_feed_sorting === "on") {
          _sfOutlierPool.stoppedByUser = true; // aborted sort → skip outlier scoring
          sessionStorage.removeItem("sortFeedStopSorting");
          // Only save the in-progress post if it's in range — see IG comment.
          let itemsCleaned;
          try {
            if (is_create_date_in_range(createDate, startDate, endDate)) {
              itemsCleaned = save_data_locally_again(singleNodeJSONUpdated);
            } else {
              itemsCleaned = inMemoryFeedData.items;
            }
          } catch (e) {
            itemsCleaned = inMemoryFeedData.items;
          }
          removeSortFeedBannerMessage();
          sessionStorage.removeItem("sortFeedStatusTikTok");
          resolve({ itemsCleaned });
          return;
        } else {
          // ✅ Case 01 — In range, more items ahead
          if (is_create_date_in_range(createDate, startDate, endDate) && i !== numberItems - 1) {
            // console.log("CASE 01");
            let itemsCleaned = save_data_locally_again(singleNodeJSONUpdated);
            send_items_collected_no(itemsCleaned);
            insta_banner_notification(itemsCleaned);
          }

          // 02 In range, last item, no next page, need to resolve
          else if (
            is_create_date_in_range(createDate, startDate, endDate) &&
            i === numberItems - 1 &&
            nextPage === false
          ) {
            // if (DBUG) console.log("case 02");
            let itemsCleaned = save_data_locally_again(singleNodeJSONUpdated);
            send_items_collected_no(itemsCleaned);
            insta_banner_notification(itemsCleaned);
            sessionStorage.removeItem("sortFeedStatusTikTok");
            resolve({ itemsCleaned });
            // return;
          }

          // 03 In range, last item, but more pages
          else if (
            is_create_date_in_range(createDate, startDate, endDate) &&
            i === numberItems - 1 &&
            nextPage === true
          ) {
            // if (DBUG) console.log("case 03");
            let itemsCleaned = save_data_locally_again(singleNodeJSONUpdated);
            send_items_collected_no(itemsCleaned);
            insta_banner_notification(itemsCleaned);
          }

          // 04 out of range
          else if (!is_create_date_in_range(createDate, startDate, endDate)) {
            // if (DBUG) console.log("case 04");

            // ignore if pinned, btw pinned in range was already saved in the previous section
            if (singleNode.isPinnedItem) {
              // Recorded because it disqualifies this scrape from answering a
              // later "latest N" request: that N would be missing a video the
              // profile puts FIRST. Only a real skip sets it, so an account whose
              // pinned videos are all in range stays eligible.
              _sfTkDatePinnedSkipped = true;
              continue;
            }

            // Newer than the end of the range — skip and keep scrolling toward older posts.
            // (For relative-back ranges where end ≈ now this branch never fires.)
            if (new Date(createDate) > endDate) {
              // Tick the banner anyway. Nothing is collected on this leg, so
              // without it the seek down to a historical range is completely
              // silent — the count stays put (the message no-ops on an unchanged
              // number) but the scan progress moves, which is the whole point.
              insta_banner_notification(inMemoryFeedData.items || []);
              continue;
            }

            // Older than the start — stop the scroll.
            let itemsCleaned = inMemoryFeedData.items;
            sessionStorage.removeItem("sortFeedStatusTikTok");
            resolve({ itemsCleaned });
            break;
          }
        }
      }
    }
  });
}

// remove overlay
// function remove_overlay() {
//   document.getElementById("overlay_sort_reels").remove();
// }

function remove_overlay() {
  const el = document.getElementById("overlay_sort_reels");
  if (!el) return;          // ✅ nothing to remove
  el.remove();
}

// One call per intercepted item_list page — the two facts about the SCRAPE (as
// opposed to the items) that the re-sort router reads. Pages arrive in order, so
// the last one's `hasMore` is the feed's final word: false means everything the
// profile has is in hand, and any later request is servable without re-fetching.
function _sfTkTrackPage(items, nextPage) {
  _sfTkFeedExhausted = nextPage === false;
  if (!Array.isArray(items)) return;
  for (const raw of items) {
    const secs = raw && raw.createTime;
    if (!Number.isFinite(secs)) continue;
    const ms = secs * 1000;
    if (_sfTkDeepestSeenMs === null || ms < _sfTkDeepestSeenMs) _sfTkDeepestSeenMs = ms;
  }
}

function send_add_overlay_msg() {
  // if overlay is showing up then do nothing
  if (document.getElementById("overlay_sort_reels")) {
    return;
  } else {
    window.postMessage({ overlay_on: true }, "*");
  }
}

// listen to events coming from api/post/item_list 
// async function safeFetch(...args) {
//   try {
//     const response = await originalFetch.apply(this, args);

//     if (!response.ok) {
//       // console.log('SORT FEED'); 
//       if (DBUG) console.error(
//         `Fetch failed! Status: ${response.status} ${response.statusText}`
//       );
//     } else {
//       // console.log('SORT FEED'); 
//       // console.log("✅ Fetch success!", response.url);
//     }

//     return response; // always return so the page can still use it
//   } catch (err) {
//     if (DBUG) console.error("❌ Network error during fetch:", err.message, err);
//     return Promise.reject(err); // rethrow if you want the caller to know
//   }
// }



function remove_uneeded_stuff() {
  sessionStorage.removeItem("sortFeedSortBy");
  sessionStorage.removeItem("sortFeedNoItems");
  sessionStorage.removeItem("sortFeedStatus");
  sessionStorage.removeItem("sortFeedStatusTikTok");
  sessionStorage.removeItem("sortFeedData");
  sessionStorage.removeItem("sortFeedDataSorted"); // should I remove this
  sessionStorage.removeItem("sortItemsVsDates");
  // console.log('items removed!');
  reset_in_memory_feed_data();
}


// // Main listening function
window.addEventListener("message", (event) => {
  if (event.data.source === "tiktokApiObserver" && event.data.action === "tiktokApiData") {
    // console.log('📦 Received TikTok data:', event.data.jsonResponse);

    let url=event.data.url;
    // console.log(`API Response received - sortFeedStatusTikTok: ${sessionStorage.getItem("sortFeedStatusTikTok")}`);

    // Sort-context tracking, before either branch so items and dates both get it.
    if (url.includes("api/post/item_list") && sessionStorage.getItem("sortFeedStatusTikTok")) {
      _sfTkTrackPage(event.data.jsonResponse, event.data.nextPage);
    }

    if (
        url.includes("api/post/item_list") &&
        sessionStorage.getItem("sortFeedStatusTikTok") &&
        sessionStorage.getItem("sortItemsVsDates") === "items"
      ) {
        
        // console.log('STARTING sort_videos_tiktok'); 

        // reset_in_memory_feed_data();

        // show loading banner right away! 
        // window.postMessage({ insta_banner_notification: true, count: 0 },"*",);
        send_add_overlay_msg();

        let numberItems = event.data.numberItems;
        let jsonResponse = event.data.jsonResponse;
        let nextPage = event.data.nextPage;
        let sort_selected = return_sort_selection(); // return 100K if users selected all reels else returns selected amount
        // sort_videos_tiktok: loops through reach response and figures out if we are case 01,02,03, etc. 
        // console.log('sort_selected'); 
        // console.log(sort_selected); 

        // COMMENT OUT 
        sort_videos_tiktok(
          numberItems,
          jsonResponse,
          sort_selected,
          nextPage,
        ).then(({ itemsCleaned }) => {
          // Outlier: finish the baseline pool first (pool mode keeps TikTok
          // paginating past the display count until the window is covered), then
          // stamp scores, emit the insufficient/no-breakout note, and render with
          // the sf_outlier meta. Resolves null instantly when scoring is off, so
          // non-outlier sorts are byte-identical to before. IMPORTANT: set
          // sortFeedSortDoneTikTok AFTER the pool so pool-mode fetches aren't
          // short-circuited by the fetch hook.
          // _sfTkRenderSorted stamps the scores, emits the note, sets
          // sortFeedSortDoneTikTok (so the fetch hook starts blocking further
          // item_list requests) and renders — behind the one-render latch it
          // shares with the Stop express route.
          _sfOutlierEnsurePool().then((sfOutlierMeta) => {
            _sfTkRenderSorted(itemsCleaned, sfOutlierMeta);
          });
        });


      } 
      else if (
        url.includes("api/post/item_list") &&
        sessionStorage.getItem("sortFeedStatusTikTok")  &&
        sessionStorage.getItem("sortItemsVsDates") === "dates"
      ) {
        // reset_in_memory_feed_data(); 

        send_add_overlay_msg();
        let numberItems = event.data.numberItems;
        let jsonResponse = event.data.jsonResponse;
        let nextPage = event.data.nextPage;
        let sort_selected = sessionStorage.getItem("sortFeedNoItems");
        let [start_date, end_date] = return_date_range(sort_selected);
        sort_videos_tiktok_dates(
          numberItems,
          jsonResponse,
          sort_selected,
          nextPage,
          start_date,
          end_date,
        ).then(({ itemsCleaned }) => {
          // means NO tiktok were uploaded in that time-period
          if (!itemsCleaned || itemsCleaned.length === 0) {
            // Date range matched nothing — leave the feed exactly as it is (don't
            // hide it behind an empty sorted grid) and turn the progress banner
            // into a friendly "no TikToks in this date range" toast. Mirrors IG.
            // Nothing to score → skip pool mode entirely.
            _sfTkFinalizeEmptyRange();
            return;
          }

          // Outlier: finish the baseline pool first (deep/short date ranges still
          // get a full 90/180/365-day baseline via pool mode), then stamp scores,
          // emit the note, and render with the sf_outlier meta. Resolves null
          // instantly when scoring is off. Set sortFeedSortDoneTikTok AFTER the
          // pool so pool-mode fetches aren't short-circuited by the fetch hook.
          _sfOutlierEnsurePool().then((sfOutlierMeta) => {
            _sfTkRenderSorted(itemsCleaned, sfOutlierMeta);
          });
        });
      }
  }
});

