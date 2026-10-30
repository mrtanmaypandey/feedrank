// Page-world script — Saved sorting (counterpart to script_instagram.js and
// explore_sort_instagram.js).
//
// Unlike Profile and Search (which use /graphql/query), the Saved pages fetch
// their data from two REST endpoints (response shape is identical for both):
//
//   All Posts:   /api/v1/feed/saved/posts/
//   Collection:  /api/v1/feed/collection/<collection_id>/posts/   ← retired.
//                Since Sept 2026 a collection page loads through GraphQL
//                instead: POST /api/graphql, fb_api_req_friendly_name
//                PolarisSavedCollectionPageWWWQuery, variables
//                {collection_id, first: 12, after: <cursor>}, and the media
//                lives at data.fetch__MediaCollection.media.edges[].node with
//                page_info {has_next_page, end_cursor}. sfSavedNormalizeGraphql
//                folds that into the REST shape so the rest of this file is
//                shared. (Diagnosed 2026-09-28 from a captured sort — the REST
//                path is never requested any more, so nothing was intercepted
//                and the stall watchdog fired on every collection sort.)
//
// Response shape (verified against captured payloads in
// `Workers/new data/all_posts.js`, `all_posts_scroll.js`,
// `collection_posts.js`):
//
//     {
//       num_results: 21,
//       more_available: true | false,
//       next_max_id: "<cursor>",
//       items: [
//         { media: { pk, code, taken_at, media_type, like_count,
//                    comment_count, play_count, user: { username, ... },
//                    caption: { text, ... } | null, ... } },
//         ...
//       ],
//       status: "ok"
//     }
//
// Field notes vs the GraphQL flow:
//   - Items are flat (`items[].media`) — no edges, no explore_story
//     pollution to filter out.
//   - View count for reels lives on `play_count` (not `view_count`).
//   - Pagination uses `more_available` (boolean), not `page_info.has_next_page`.
//
// Gated on `sessionStorage.feedRankSurface === "saved"` so it stays dormant
// during Profile or Search sorts.

const SF_SAVED_DEBUG = false;

// Matches either of IG's two Saved REST endpoints:
//   /api/v1/feed/saved/posts/                          ← All Posts
//   /api/v1/feed/collection/<numeric_id>/posts/        ← a specific collection
function sfSavedIsGraphqlUrl(url) {
  return !!url && (url.includes("/api/graphql") || url.includes("/graphql/query"));
}

function sfSavedIsSavedUrl(url) {
  if (!url) return false;
  return (
    url.includes("/api/v1/feed/saved/posts/") ||
    /\/api\/v1\/feed\/collection\/\d+\/posts\//.test(url) ||
    // Collections (GraphQL). Every other GraphQL response on the page is
    // dropped by a substring check in sfSavedHandleResponse before any parse.
    sfSavedIsGraphqlUrl(url)
  );
}

// GraphQL collection page → the REST shape the rest of this file consumes.
// Returns null when the payload isn't a collection page.
function sfSavedNormalizeGraphql(json) {
  const coll = json?.data?.fetch__MediaCollection;
  const media = coll?.media;
  if (!media || !Array.isArray(media.edges)) return null;
  const items = [];
  for (const e of media.edges) {
    let n = e?.node;
    if (n && n.media && typeof n.media === "object" && n.media.pk) n = n.media; // tolerate a wrapped node
    if (n) items.push({ media: n });
  }
  const pi = media.page_info || {};
  if (SF_SAVED_DEBUG) {
    const n = items[0]?.media;
    if (n) {
      const scalars = {};
      Object.keys(n).forEach((k) => { const v = n[k]; if (v === null || typeof v !== "object") scalars[k] = v; });
      console.log("[FeedRank][saved] GraphQL collection page —", coll.name, "| edges:", items.length, "| has_next_page:", pi.has_next_page, "| first node scalars:", scalars, "| user:", n.user?.username, "owner:", n.owner?.username);
    }
  }
  return {
    num_results: items.length,
    more_available: !!pi.has_next_page,
    next_max_id: pi.end_cursor || null,
    items,
    status: "ok",
  };
}

const sfSavedMemory = {
  items: [],
};

function sfSavedSaveLocally(meta) {
  // Dedupe by post pk. Collection endpoints have been observed returning the
  // same item across adjacent pages (and the initial /api/v1/feed/collection/
  // request occasionally arrives twice during page hydration). Without this
  // guard the sorted grid renders duplicate tiles. Cheap O(n) check — saved
  // batches are small enough that this is fine.
  if (meta.postID != null) {
    const dup = sfSavedMemory.items.some((m) => m.postID === meta.postID);
    if (dup) {
      if (SF_SAVED_DEBUG) console.log("[FeedRank][saved] saveLocally — DUPLICATE pk", meta.postID, "code", meta.code, "— skipping");
      return sfSavedMemory.items;
    }
  }
  // Collection index, for back-to-back re-sorting. Saved is ordered by when the
  // user SAVED each post, which no field on the item can reconstruct — unlike a
  // profile, where "pinned first, then newest" recovers feed order. So narrowing
  // a re-sort (100 → latest 50) has to slice on the order they actually arrived.
  meta._sfSeq = sfSavedMemory.items.length;
  sfSavedMemory.items.push(meta);
  return sfSavedMemory.items;
}

// ── Stop Sorting — immediate abort ──────────────────────────────────────────
// Mirrors the profile flow's `_sfStop` (script_instagram.js), kept self-contained
// because the three page-world scripts are injected as independent <script> tags
// with no guaranteed execution order.
//
// The banner's Stop button raises the `feedRankStopSorting` flag AND posts
// `sf_stop_sorting`. The flag alone could only be polled — and the poll sits
// *after* `await sfSavedFindElement`, which spends up to ~3s hunting the anchor
// plus ~3.2s waiting for the tile's media before returning. This registry
// settles those waits on the click's own tick instead.
const sfSavedStop = {
  requested: false,
  waiters: new Set(),
};

function sfSavedStopRequested() {
  if (sfSavedStop.requested) return true;
  try {
    return sessionStorage.getItem("feedRankStopSorting") === "on";
  } catch (e) {
    return false;
  }
}

function sfSavedRegisterWaiter(resolve) {
  const waiter = { resolve: resolve, timer: null, settled: false };
  sfSavedStop.waiters.add(waiter);
  return waiter;
}

function sfSavedSettle(waiter, value) {
  if (waiter.settled) return;
  waiter.settled = true;
  clearTimeout(waiter.timer);
  sfSavedStop.waiters.delete(waiter);
  try {
    waiter.resolve(value);
  } catch (e) {}
}

// Cut every pending wait short and kill its timer, so no zombie poll ladder
// keeps scrolling the page after the sort is over.
function sfSavedFlushWaiters() {
  const pending = Array.from(sfSavedStop.waiters);
  sfSavedStop.waiters.clear();
  pending.forEach((w) => {
    if (w.settled) return;
    w.settled = true;
    clearTimeout(w.timer);
    try {
      w.resolve(null);
    } catch (e) {}
  });
}

// Abort everything in flight and finish from what has already been collected —
// including when Stop lands in the gap between pages, where no batch is running.
function sfSavedStopNow() {
  if (sfSavedStop.requested) return;
  sfSavedStop.requested = true;
  sfSavedFlushWaiters();
  sfSavedFinalize(sfSavedMemory.items);
}

window.addEventListener("message", (event) => {
  if (event.source !== window || !event.data || !event.data.sf_stop_sorting) return;
  // Saved only — the profile and explore scripts get this same broadcast.
  if (sessionStorage.getItem("feedRankSurface") !== "saved") return;
  sfSavedStopNow();
});

// Convert one media item into the shared metadata shape used by every renderer
// / exporter. Field names match the Profile / Search flows so downstream
// helpers need no surface-specific code.
// Post time in ms. `taken_at` (seconds) on the REST feed and most GraphQL
// nodes; failing that, the media id itself — IG ids are timestamp-prefixed
// (ms since 2011-08-24 in the top bits), and on the May captures that matches
// taken_at to the minute (median 0s, worst case 16 min). Without it, a node
// that omits taken_at sorts as "no date" and Oldest never reorders anything.
const SF_IG_ID_EPOCH_MS = 1314220021721n;
function sfSavedTakenAtMs(item) {
  const sec = item?.taken_at ?? item?.taken_at_ts;
  if (Number.isFinite(+sec) && +sec > 0) return +sec * 1000;
  try {
    const pk = String(item?.pk ?? item?.id ?? "").split("_")[0];
    if (/^\d{15,}$/.test(pk)) return Number((BigInt(pk) >> 23n) + SF_IG_ID_EPOCH_MS);
  } catch (e) {}
  return null;
}

function sfSavedCreateMetadata(item) {
  const ts = sfSavedTakenAtMs(item);
  // REST endpoint uses `play_count` for reels; GraphQL used `view_count`.
  // Coalesce both for safety so any downstream code that reads viewCount
  // gets a value regardless of which field IG populates.
  const views = item?.play_count ?? item?.view_count ?? item?.ig_play_count ?? null;
  return {
    createDate: ts ? new Date(ts).toISOString() : "",
    code: item?.code || "",
    commentsCount: item?.comment_count ?? null,
    likesCount: item?.like_count ?? null,
    mediaType: item?.media_type ?? null,
    viewCount: views,
    userName: item?.user?.username || item?.owner?.username || "",
    caption: item?.caption?.text || "",
    postID: item?.pk ?? null,
    // Poster frame for the player — widest cover candidate, same rule
    // as the profile captures in script_instagram.js.
    thumbnailUrl: (() => {
      const c = item?.image_versions2?.candidates;
      if (!Array.isArray(c) || !c.length) return null;
      let best = null, bestW = -1;
      for (const cand of c) {
        const w = cand?.width || 0;
        if (cand?.url && w > bestW) { bestW = w; best = cand.url; }
      }
      return best;
    })(),
  };
}

// Walk the items array and pluck media. The /api/v1/feed/saved/posts/
// endpoint only returns real saved posts — there's no explore_story
// interleaving to filter out, unlike the GraphQL timeline endpoint.
function sfSavedFlattenItems(response) {
  const items = response?.items || [];
  const out = [];
  let invalidCount = 0;
  for (const it of items) {
    const media = it?.media;
    if (!media || !media.pk || !media.code) {
      invalidCount++;
      continue;
    }
    out.push(media);
  }
  if (SF_SAVED_DEBUG) {
    console.log(
      "[FeedRank][saved] flattenItems — total items:", items.length,
      "valid media:", out.length,
      "invalid (filtered):", invalidCount,
    );
  }
  return out;
}

// Find the rendered tile in the saved grid for a given shortcode. Same pattern
// as the explore flow (`sfExploreFindElement`) — saved media loads lazily, so
// we scroll the anchor into view and poll for a real image (not the data: URI
// placeholder) before handing the element back.
function sfSavedFindElement(code, retries = 30, interval = 100) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const waiter = sfSavedRegisterWaiter(resolve);
    if (sfSavedStop.requested) {
      sfSavedSettle(waiter, null);
      return;
    }
    const tryFind = (attemptsLeft) => {
      if (waiter.settled) return;
      // Tiles link as /p/<code>/, /<user>/p/<code>/ or /<user>/reel/<code>/
      // (the user-prefixed forms arrived Sept 2026 — reels were never found
      // by the old /p/ lookups and timed out to a blank tile).
      const anchor =
        document.querySelector(`a[href="/p/${code}/"]`) ||
        document.querySelector(`a[href*="/p/${code}/"]`) ||
        document.querySelector(`a[href*="/reel/${code}/"]`);
      if (anchor) {
        const parentDiv = anchor.closest("div");
        parentDiv?.scrollIntoView({ behavior: "auto", block: "center" });

        const isRealUrl = (u) => u && !u.startsWith("data:image/gif");
        const hasVisualMedia = () => {
          const img = parentDiv?.querySelector("img[src]");
          const imgUrl = img?.getAttribute("src") || "";
          const bgDiv = parentDiv?.querySelector('[style*="background-image"]');
          const bgUrl =
            bgDiv?.style?.backgroundImage?.match(/url\(["']?(.*?)["']?\)/)?.[1] || "";
          return isRealUrl(imgUrl) || isRealUrl(bgUrl);
        };

        const checkMediaLoaded = () => {
          if (waiter.settled) return;
          if (hasVisualMedia()) {
            if (SF_SAVED_DEBUG) console.log("[FeedRank][saved] findElement", code, "→ FOUND with media in", Date.now() - startedAt, "ms");
            sfSavedSettle(waiter, parentDiv);
          } else if (retries-- > 0) {
            waiter.timer = setTimeout(checkMediaLoaded, interval);
          } else {
            if (SF_SAVED_DEBUG) console.log("[FeedRank][saved] findElement", code, "→ FOUND but media never loaded after", Date.now() - startedAt, "ms");
            sfSavedSettle(waiter, parentDiv);
          }
        };

        if (hasVisualMedia()) {
          if (SF_SAVED_DEBUG) console.log("[FeedRank][saved] findElement", code, "→ FOUND immediately in", Date.now() - startedAt, "ms");
          sfSavedSettle(waiter, parentDiv);
        } else {
          waiter.timer = setTimeout(checkMediaLoaded, 200);
        }
      } else if (attemptsLeft > 0) {
        waiter.timer = setTimeout(() => tryFind(attemptsLeft - 1), interval);
      } else {
        if (SF_SAVED_DEBUG) console.warn("[FeedRank][saved] findElement", code, "→ NOT FOUND after", Date.now() - startedAt, "ms (no anchor in DOM)");
        sfSavedSettle(waiter, null);
      }
    };
    tryFind(retries);
  });
}

// Saved feed ordering note: IG returns saved items in "most recently saved
// first" order, NOT chronologically by post date. So "oldest" must sort by
// `taken_at` rather than reversing the input.
function sfSavedSortItems(data, sortBy) {
  if (sortBy === "likes") {
    return [...data].sort((a, b) => (b.likesCount ?? 0) - (a.likesCount ?? 0));
  }
  if (sortBy === "comments") {
    return [...data].sort((a, b) => (b.commentsCount ?? 0) - (a.commentsCount ?? 0));
  }
  if (sortBy === "oldest") {
    return [...data].sort((a, b) => {
      const ta = a.createDate ? Date.parse(a.createDate) : 0;
      const tb = b.createDate ? Date.parse(b.createDate) : 0;
      return ta - tb;
    });
  }
  // 'views' is blocked upstream; defensive return.
  return data;
}

function sfSavedReadTarget() {
  const raw = sessionStorage.getItem("feedRankNoItems") || "";
  // Saved allows "all_reels" (unlike Search) — saved collections are finite.
  // Defensive cap keeps memory bounded if a list is unexpectedly huge.
  if (raw === "all_reels") return 10000;
  const n = parseInt(raw.replace("_reels", ""), 10);
  return Number.isFinite(n) && n > 0 ? n : 25;
}

// "All Posts" (both sub-modes — the saved feed and a collection share this
// path) has no item target, so the banner had nothing to compute a percentage
// from and its bar sat at 0% for the whole scrape before the finish animation
// snapped it to 100. Every numeric target ("50 posts") is unaffected: the
// banner's own count ÷ target still owns the bar there.
//
// Same shape as the profile's open-ended sorts (_sfScanProgress in
// script_instagram.js): a decelerating work curve — there's no date boundary to
// measure against on Saved, since date filters are blocked here — floored once
// IG reports `more_available: false`, which means the whole set is in hand and
// only per-item DOM work remains.
const SF_SAVED_SCAN_K = 60;            // knee of the work curve, in items
const SF_SAVED_SCAN_LAST_PAGE_FLOOR = 0.9;

function sfSavedScanProgress(count) {
  if ((sessionStorage.getItem("feedRankNoItems") || "") !== "all_reels") return null;
  let progress = count / (count + SF_SAVED_SCAN_K);
  if (sfSavedFeedExhausted) progress = Math.max(progress, SF_SAVED_SCAN_LAST_PAGE_FLOOR);
  return Math.max(0, Math.min(1, progress));
}

function sfSavedNotifyBanner(count) {
  const msg = { insta_banner_notification: true, count: count, type: "Posts" };
  const scan = sfSavedScanProgress(count);
  if (scan !== null) msg.scanProgress = scan;
  window.postMessage(msg, "*");
}

function sfSavedNotifyCollected(count) {
  window.postMessage(
    { item_collected_no: true, number_items: count },
    "*",
  );
}

function sfSavedRemoveBannerAndOverlay() {
  window.postMessage({ insta_banner_notification_remove: true }, "*");
}

function sfSavedFinishSort() {
  sessionStorage.removeItem("feedRankStopSorting");
  sessionStorage.removeItem("feedRankStatus");
}

// Single exit point — the natural completion chain AND the Stop express route
// both come through here, and `sfSavedDone` guarantees only the first one
// renders. (Saved previously had no completion latch at all; Stop needs one,
// since it can finalize while a batch is still unwinding.)
let sfSavedDone = false;

// True once IG reports `more_available: false` — i.e. the whole saved set is in
// hand, so a later re-sort of ANY size is already covered.
let sfSavedFeedExhausted = false;

function sfSavedFinalize(items) {
  if (sfSavedDone) return;
  sfSavedDone = true;
  sfSavedFinishSort();

  const list = Array.isArray(items) ? items : [];

  // Stopped before a single tile finished capturing — nothing to render, so
  // leave IG's own grid alone and just clear our chrome.
  if (!list.length) {
    sfSavedRemoveBannerAndOverlay();
    return;
  }

  const sortBy = sessionStorage.getItem("feedRankSortBy");
  const sorted = sfSavedSortItems(list, sortBy);

  if (SF_SAVED_DEBUG) {
    console.log(
      "[FeedRank][saved] sort complete —",
      sorted.length, "items, sorted by", sortBy,
      ". Posting to renderer.",
    );
  }

  // Sort context for back-to-back re-sorting (see resort_instagram.js). Built
  // BEFORE sfSavedRemoveBannerAndOverlay/finish clear the keys it reads. Saved
  // blocks date filters entirely, so this is always an items-mode record.
  const sfCtx = {
    mode: "items",
    selection: sessionStorage.getItem("feedRankNoItems"),
    sortBy: sortBy,
    tab: "Posts",
    surface: "saved",
    savedSubMode: sessionStorage.getItem("feedRankSavedSubMode"), // all_posts | collection
    path: location.pathname,
    search: location.search,
    collectedCount: list.length,
    deepestSeenMs: null,   // dates are blocked here — no coverage question to answer
    feedExhausted: sfSavedFeedExhausted,
    stoppedByUser: sfSavedStopRequested(),
    outlier: null,
  };

  sfSavedRemoveBannerAndOverlay();

  window.postMessage(
    {
      logo_animate_off: true,
      payload: sorted,
      sf_surface: "saved",
      sf_ctx: sfCtx,
    },
    "*",
  );
}

// Process one /api/v1/feed/saved/posts/ response. Accumulates into
// `sfSavedMemory` and resolves with the final array when the target is
// reached, the user clicks Stop, or `more_available` is false. Otherwise
// no-ops (returns null) and waits for the next response.
async function sfSavedProcessBatch(response, moreAvailable, target) {
  const flatItems = sfSavedFlattenItems(response);
  if (SF_SAVED_DEBUG) {
    console.log(
      "[FeedRank][saved] processBatch START — flat items:", flatItems.length,
      "more_available:", moreAvailable, "target:", target,
      "running total before batch:", sfSavedMemory.items.length,
    );
  }

  for (let i = 0; i < flatItems.length; i++) {
    if (!sessionStorage.getItem("feedRankStatus")) {
      if (SF_SAVED_DEBUG) console.log("[FeedRank][saved] processBatch — feedRankStatus cleared, bailing");
      return sfSavedMemory.items;
    }

    // Stop owns the finish from here on — bail without returning items (the
    // express route already finalized; sfSavedStopNow is a no-op if so).
    if (sfSavedStopRequested()) { sfSavedStopNow(); return null; }

    if (SF_SAVED_DEBUG) console.log("[FeedRank][saved] processBatch — iter", i, "/", flatItems.length - 1, "code:", flatItems[i]?.code);
    const meta = sfSavedCreateMetadata(flatItems[i]);
    const element = await sfSavedFindElement(meta.code);

    // Checked BEFORE the item is saved: an aborted wait hands back a null
    // element, and saving that would paint a blank tile.
    if (sfSavedStopRequested()) { sfSavedStopNow(); return null; }

    meta.element = element?.outerHTML;
    const items = sfSavedSaveLocally(meta);

    sfSavedNotifyCollected(items.length);
    sfSavedNotifyBanner(items.length);
    if (SF_SAVED_DEBUG) console.log("[FeedRank][saved] processBatch — after iter", i, "running total:", items.length);

    if (sessionStorage.getItem("feedRankStopSorting") === "on") {
      if (SF_SAVED_DEBUG) console.log("[FeedRank][saved] processBatch — user clicked Stop, finalizing");
      sfSavedFinishSort();
      return items;
    }

    if (items.length >= target) {
      if (SF_SAVED_DEBUG) console.log("[FeedRank][saved] processBatch — hit target", target, ", finalizing");
      sfSavedFinishSort();
      return items;
    }

    if (i === flatItems.length - 1 && !moreAvailable) {
      if (SF_SAVED_DEBUG) console.log("[FeedRank][saved] processBatch — end of batch, no more pages, finalizing with", items.length, "items");
      sfSavedFinishSort();
      return items;
    }
  }

  // Still expecting more pages — nudge IG's IntersectionObserver by scrolling
  // the last rendered anchor into view. When a batch's items aren't yet in
  // the DOM (common on Saved — IG sends metadata faster than it renders
  // thumbnails), nothing triggers IG to fetch the next page and we deadlock.
  sfSavedNudgeLoadMore();

  if (SF_SAVED_DEBUG) {
    console.log(
      "[FeedRank][saved] processBatch END — batch consumed but more pages expected.",
      "Running total:", sfSavedMemory.items.length, "/ target", target,
      ". Nudged scroll to last rendered anchor. WAITING for next response.",
    );
  }
  return null;
}

// Trigger IG's natural pagination by scrolling the last rendered post anchor
// into view. Safe no-op if nothing is rendered yet.
function sfSavedNudgeLoadMore() {
  const anchors = document.querySelectorAll('main a[href*="/p/"], main a[href*="/reel/"]');
  const last = anchors[anchors.length - 1];
  if (!last) {
    if (SF_SAVED_DEBUG) console.log("[FeedRank][saved] nudgeLoadMore — no anchors in <main> yet, skipping");
    return;
  }
  const parentDiv = last.closest("div") || last;
  parentDiv.scrollIntoView({ behavior: "auto", block: "end" });
  if (SF_SAVED_DEBUG) console.log("[FeedRank][saved] nudgeLoadMore — scrolled to last anchor:", last.getAttribute("href"));
}

// Shared handler — same parse + dispatch logic used by both XHR and fetch
// wraps. Side-effects: batches into sfSavedMemory and posts a sorted payload
// out via window.postMessage when the sort finalizes.
function sfSavedHandleResponse(responseText, urlForLog, source) {
  if (sfSavedDone) return; // already finalized (natural finish or Stop)
  if (sessionStorage.getItem("feedRankSurface") !== "saved") return;
  if (!sessionStorage.getItem("feedRankStatus")) return;

  // GraphQL: only the collection page query is ours (stories tray, timeline,
  // badges… all share the endpoint). Cheap substring test before any parse.
  const isGraphql = sfSavedIsGraphqlUrl(urlForLog);
  if (isGraphql && !String(responseText).includes('"fetch__MediaCollection"')) return;

  let jsonResponse;
  try {
    jsonResponse = JSON.parse(responseText);
  } catch (e) {
    if (SF_SAVED_DEBUG) console.warn("[FeedRank][saved]", source, "— JSON.parse failed:", e);
    return;
  }
  if (isGraphql) {
    jsonResponse = sfSavedNormalizeGraphql(jsonResponse);
    if (!jsonResponse) return;
  }

  // Sanity check — the saved endpoint always returns an `items` array.
  if (!Array.isArray(jsonResponse?.items)) {
    if (SF_SAVED_DEBUG) {
      const keys = jsonResponse ? Object.keys(jsonResponse).slice(0, 10) : [];
      console.log("[FeedRank][saved]", source, "— response has no items array. top-level keys:", keys);
    }
    return;
  }

  const moreAvailable = !!jsonResponse.more_available;
  sfSavedFeedExhausted = !moreAvailable; // reflects the latest page — see sfCtx
  const target = sfSavedReadTarget();

  if (SF_SAVED_DEBUG) {
    console.log(
      "[FeedRank][saved]", source, "— /api/v1/feed/saved/posts/ response received.",
      "num_results:", jsonResponse.num_results,
      "more_available:", moreAvailable,
      "target:", target,
    );
  }

  sfSavedProcessBatch(jsonResponse, moreAvailable, target).then((items) => {
    if (!items) return; // batch consumed, waiting for next response
    sfSavedFinalize(items);
  }).catch((e) => {
    if (SF_SAVED_DEBUG) console.error("[FeedRank][saved] processBatch threw:", e);
  });
}

// XHR wrap — catches the case where IG still uses XMLHttpRequest for the
// saved endpoint.
(function () {
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, async, user, password) {
    this._sfSavedUrl = url;
    return originalOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    this.addEventListener("load", function () {
      if (sessionStorage.getItem("feedRankSurface") !== "saved") return;
      if (!sessionStorage.getItem("feedRankStatus")) return;
      if (!sfSavedIsSavedUrl(this._sfSavedUrl)) return;
      if (this.responseType !== "" && this.responseType !== "text") return;

      if (SF_SAVED_DEBUG) console.log("[FeedRank][saved] XHR load — saved/collection endpoint response received:", this._sfSavedUrl);
      sfSavedHandleResponse(this.responseText, this._sfSavedUrl, "XHR");
    });
    return originalSend.apply(this, arguments);
  };
})();

// Fetch wrap — modern IG code paths use fetch() for REST endpoints. The
// saved page in particular fires its data via fetch(), so this is the
// primary capture path. We clone the response so the original consumer still
// gets to read the body uninterrupted.
(function () {
  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const fetchPromise = originalFetch.apply(this, args);

    // Cheap pre-filter — skip the clone+text cost when the URL isn't ours.
    const url = typeof args[0] === "string" ? args[0] : (args[0]?.url || "");
    if (!sfSavedIsSavedUrl(url)) return fetchPromise;

    fetchPromise.then((response) => {
      if (sessionStorage.getItem("feedRankSurface") !== "saved") return;
      if (!sessionStorage.getItem("feedRankStatus")) return;
      try {
        const clone = response.clone();
        clone.text().then((text) => {
          if (SF_SAVED_DEBUG) console.log("[FeedRank][saved] fetch resolved — saved/collection endpoint response received:", url);
          sfSavedHandleResponse(text, url, "fetch");
        }).catch(() => {});
      } catch (e) {
        if (SF_SAVED_DEBUG) console.warn("[FeedRank][saved] fetch — clone/text failed:", e);
      }
    }).catch(() => {});

    return fetchPromise;
  };
})();
