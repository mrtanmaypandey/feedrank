// Page world (MAIN world) — injected by Facebook/inject_facebook_script.js.
// Wraps fetch/XHR to intercept FB's profile-reels GraphQL @defer stream, then
// reconstructs the reels (merging deferred chunks) and auto-scrolls to paginate.
// Mirrors Instagram/script_instagram.js. See Docs/Sort Logic/FB_Profile_Reels_Sort_Plan.md.
//
// PHASE 4 scope: COLLECT only — logs the raw reconstructed reels. parseReduced
// (Views/Shares) is Phase 5; the final {VideoID,…} object + sort is Phase 6.

(() => {
  // Dev logging only — set false before shipping.
  const SF_FB_DEBUG = false;

  // ⚠️ TEST SWITCH — must ship false. Makes the page world discard every batch it
  // parses, so a real sort genuinely collects nothing and the stall watchdog in
  // banner_on_facebook.js fires. Gated at ingest() rather than at the URL
  // matchers because FB has THREE feed paths — the XHR wrap, the fetch wrap and
  // the SSR bootstrap scan — and blocking only the network ones would still let
  // the inlined first batch through, so the sort would not actually stall.
  const SF_TEST_FORCE_STALL_FB = false;

  // Did we ever actually receive a feed response? Collecting 0 reels has two very
  // different causes that used to produce the same "no Reels available" toast:
  //   • the surface genuinely has no reels  → that message is right
  //   • we never intercepted anything at all → that message is a lie, and this is
  //     the failure the Instagram clips-key relocation caused
  // Unlike IG, FB drives its own scroll loop rather than being response-driven, so
  // a broken interception does NOT hang — it scrolls, finds nothing, and reports
  // "no reels". This flag is what tells the two apart.
  let sfAnyResponseSeen = false;

  // Guard against a double-inject in the same page load.
  if (window.__sfFbInstalled) return;
  window.__sfFbInstalled = true;

  if (SF_FB_DEBUG) console.log("[SF][FB] script_facebook.js loaded (page world)");

  // ──────────────────────────────────────────────────────────────────────────
  // State
  // ──────────────────────────────────────────────────────────────────────────
  const reelsById = new Map();    // id -> raw reel record (insertion order = API order, latest first)
  let lastHasNextPage = null;     // page_info.has_next_page from the most recent page
  let sawAnyShortsResponse = false;
  let collected = false;          // collect() runs once per load
  let handedOff = false;          // once render/remove is posted, stop ingesting + notifying so
                                  // late in-flight responses don't re-open the progress banner
  let dateModeRange = null;       // [startMs, endMs] when sorting by date range; null in items mode

  // Outlier-score state (profile Reels only; see the engine block before collect()).
  let _sfFbOutlierInv = null;         // cached CLDR inverter for parsing play_count_reduced
  let _sfFbOutlierPoolActive = false; // pool mode running → notifyProgress() stays silent (analyzing owns the banner)

  // ── No server-cached median (V2 removed 2026-08-27, mirrors IG) ────────────
  // There used to be a Cloudflare/D1 cache of each creator's median, read once
  // per sort and written back after every live compute. With SF_FB_OUTLIER_CAP
  // at 25 the local compute almost always succeeds the moment collection ends,
  // so the cached answer was being fetched and then discarded. Computing fresh
  // is also fresher (cached medians went stale for up to 7 days) and consistent
  // between users. The worker itself stays deployed, so a git revert brings the
  // outlier_cache_facebook.js bridge back.

  // One-shot sort flag: capture it for THIS page load, then clear it immediately so
  // a plain refresh (no sort click) does NOT re-trigger collection. The interceptor
  // and boot both gate on this in-memory boolean, not the (now-cleared) sessionStorage.
  const SORT_ACTIVE = sessionStorage.getItem("feedRankStatusFacebook") === "on";
  if (SORT_ACTIVE) sessionStorage.removeItem("feedRankStatusFacebook");

  // ──────────────────────────────────────────────────────────────────────────
  // Reconstruction (research doc §3.3) — exact field keys + null traps
  // ──────────────────────────────────────────────────────────────────────────
  const TARGET_KEYS = new Set([
    "permalink_url", "creation_time", "play_count_reduced",
    "share_count_reduced", "total_comment_count", "unified_reactors", "message", "owner",
    "preferred_thumbnail", "thumbnailImage",   // Phase 7.1 — tile thumbnail for render
  ]);

  // Recursively collect the FIRST useful (non-null) occurrence of each target key.
  function collectFields(node, acc) {
    if (node == null || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const x of node) collectFields(x, acc); return; }
    for (const [k, v] of Object.entries(node)) {
      if (TARGET_KEYS.has(k)) {
        if (k === "unified_reactors") {
          if (v && v.count != null && acc.likes == null) acc.likes = v.count;          // exact likes
        } else if (k === "message") {
          if (v && v.text && acc.caption == null) acc.caption = v.text;                // caption
        } else if (k === "owner") {
          if (v && v.name && acc.profileName == null) acc.profileName = v.name;        // creator / profile name
        } else if (k === "preferred_thumbnail") {
          if (v && v.image && v.image.uri && acc.preferredThumb == null) acc.preferredThumb = v.image.uri; // best thumb
        } else if (k === "thumbnailImage") {
          if (v && v.uri && acc.fallbackThumb == null) acc.fallbackThumb = v.uri;       // fallback thumb
        } else if (v != null && v !== "" && acc[k] == null) {
          acc[k] = v;
        }
      }
      collectFields(v, acc);
    }
  }

  function reelIdFromPermalink(url) {
    const m = /(?:reel|videos)\/(\d+)/.exec(url || "");
    return m ? m[1] : null;
  }

  // Locate the aggregated_fb_shorts connection ANYWHERE in a parsed line. Profile puts it
  // at data.node.aggregated_fb_shorts; Saved nests it under
  // data.node.all_collections.nodes[0].style_renderer.collection.aggregated_fb_shorts
  // (Your Reels likewise). A depth-first search finds it on every surface without
  // hard-coding the path — the edge node shape (profile_reel_node.node) is identical.
  function findAggregatedShorts(node) {
    if (!node || typeof node !== "object") return null;
    if (Array.isArray(node)) {
      for (const x of node) { const r = findAggregatedShorts(x); if (r) return r; }
      return null;
    }
    if (node.aggregated_fb_shorts && node.aggregated_fb_shorts.edges) return node.aggregated_fb_shorts;
    for (const v of Object.values(node)) { const r = findAggregatedShorts(v); if (r) return r; }
    return null;
  }

  // Parse one full @defer streamed body -> { reels, pageInfo }.
  function reconstructReels(rawBody) {
    const lines = rawBody.split("\n").map((l) => l.trim()).filter(Boolean);
    let shorts = null;
    const chunks = [];
    for (const line of lines) {
      let obj; try { obj = JSON.parse(line); } catch (_) { continue; }
      if (obj && Array.isArray(obj.path)) { chunks.push(obj); continue; } // @defer chunk
      const found = findAggregatedShorts(obj);                            // base line (any surface)
      if (found) shorts = found;
    }
    if (!shorts) return { reels: [], pageInfo: null };
    const edges = shorts.edges || [];
    const reels = edges.map((e) => {
      const acc = {};
      collectFields(e && e.profile_reel_node && e.profile_reel_node.node, acc);
      return acc;
    });
    // Merge each deferred chunk into reel N by the integer right after "edges" in its path.
    let pageInfo = shorts.page_info || null;
    for (const chunk of chunks) {
      const i = chunk.path.indexOf("edges");
      if (i === -1) {
        // page_info can be deferred on its own ({path:[…,"page_info"], data:{has_next_page}}
        // or data.page_info). Without it lastHasNextPage never turns false, and the
        // feed-end branch in _sfFbOutlierEvaluate can only be reached by stalling out.
        const last = chunk.path[chunk.path.length - 1];
        const pi = chunk.data && (chunk.data.page_info || (last === "page_info" ? chunk.data : null));
        if (pi && typeof pi.has_next_page === "boolean") pageInfo = pi;
        continue;
      }
      const idx = chunk.path[i + 1];
      if (typeof idx === "number" && reels[idx]) collectFields(chunk.data, reels[idx]);
    }
    return { reels, pageInfo };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Ingest — gated; dedupes by reel id
  // ──────────────────────────────────────────────────────────────────────────
  function ingest(rawBody) {
    if (SF_TEST_FORCE_STALL_FB) return; // deliberately BEFORE the marker below
    if (!rawBody || rawBody.indexOf("aggregated_fb_shorts") === -1) return;
    // Marked only once the REELS CONTAINER is actually present. FB routes far more
    // than the feed through /api/graphql/ — notifications, ads, the news feed — so
    // marking on "any response body" would be true on every page load and this
    // signal would never fire in the wild.
    //
    // Placed here, it means exactly "we saw the shape we understand":
    //   • container seen, 0 reels parsed → the surface really is empty
    //   • container never seen           → FB moved or renamed it, which is the
    //                                      Facebook equivalent of the Instagram
    //                                      clips-key relocation
    sfAnyResponseSeen = true;
    if (!SORT_ACTIVE) return;
    if (handedOff) return; // sort already rendered — ignore late in-flight pages
    let result;
    try { result = reconstructReels(rawBody); } catch (e) { if (SF_FB_DEBUG) console.warn("[SF][FB] reconstruct failed", e); return; }
    const { reels, pageInfo } = result;
    if (!reels.length && !pageInfo) return;
    sawAnyShortsResponse = true;
    let added = 0, filled = 0;
    for (const r of reels) {
      const id = reelIdFromPermalink(r.permalink_url);
      if (!id) continue;
      r.id = id;
      if (!reelsById.has(id)) { reelsById.set(id, r); added++; continue; }
      // Seen before — fill in whatever the first copy lacked. A reel can arrive
      // twice (the SSR bootstrap and the first scroll page overlap, and FB
      // re-sends edges across adjacent pages); when the FIRST copy was missing
      // a field the later one carries — a play count, a creation_time — the old
      // "first copy wins" rule kept the hole forever, and a reel without views
      // or a date can never qualify for the outlier median.
      const cur = reelsById.get(id);
      for (const k of Object.keys(r)) {
        if (k === "id" || r[k] == null || cur[k] != null) continue;
        cur[k] = r[k];
        filled++;
        if (k === "play_count_reduced") delete cur._sfViews; // drop a cached null parse
      }
    }
    if (pageInfo && typeof pageInfo.has_next_page === "boolean") lastHasNextPage = pageInfo.has_next_page;
    if (added) notifyProgress(); // refresh the banner as soon as each batch lands (not once per scroll round)
    if (SF_FB_DEBUG) console.log(`[SF][FB] ingest +${added} (+${filled} fields) (total ${reelsById.size}, has_next=${lastHasNextPage})`);
    // Pool mode is page-driven (mirrors IG): the page that just landed is
    // evaluated NOW, not after a fixed pause, so the pool stops the moment the
    // median has what it needs.
    if (_sfFbOutlierPool.active && (added || filled)) _sfFbOutlierPoolPageArrived();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Network wraps (research doc §3.1) — installed immediately, before FB fetches
  // ──────────────────────────────────────────────────────────────────────────
  // XHR — the CONFIRMED transport for scroll pagination.
  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u, ...rest) { this.__sfUrl = u; return _open.call(this, m, u, ...rest); };
  XMLHttpRequest.prototype.send = function (b) {
    if (typeof this.__sfUrl === "string" && this.__sfUrl.indexOf("/api/graphql/") !== -1) {
      this.addEventListener("load", () => {
        try { ingest(this.responseText || ""); } catch (_) {}
      });
    }
    return _send.call(this, b);
  };

  // fetch — safety net for the initial batch (clone before reading).
  const _fetch = window.fetch;
  window.fetch = function (...args) {
    const url = (args[0] && args[0].url) || args[0];
    const p = _fetch.apply(this, args);
    try {
      if (typeof url === "string" && url.indexOf("/api/graphql/") !== -1) {
        p.then((res) => { try { res.clone().text().then(ingest).catch(() => {}); } catch (_) {} });
      }
    } catch (_) {}
    return p;
  };

  // ──────────────────────────────────────────────────────────────────────────
  // SSR bootstrap fallback (research doc §3.6) — first batch may be inlined
  // ──────────────────────────────────────────────────────────────────────────
  function scanInlineBootstrap() {
    try {
      // On first load FB doesn't fetch page 1 — it inlines that same @defer stream as
      // separate <script type="application/json"> blobs, each wrapped in a Relay envelope.
      // Feeding a wrapped blob straight to ingest() finds nothing (reconstructReels expects
      // the un-wrapped newline stream). So unwrap every blob to its inner result object(s),
      // rejoin them into the stream reconstructReels already understands, and ingest once —
      // so page 1 counts immediately instead of waiting ~2-3s for the first scroll's fetch.
      const lines = [];
      document.querySelectorAll('script[type="application/json"]').forEach((el) => {
        const txt = el.textContent || "";
        if (txt.indexOf("aggregated_fb_shorts") === -1) return;
        let root; try { root = JSON.parse(txt); } catch (_) { return; }
        (function unwrap(n) {
          if (!n || typeof n !== "object") return;
          if (Array.isArray(n)) { n.forEach(unwrap); return; }
          // a stream "line" = the base result ({data:{node:…}}) or a deferred chunk ({path,…})
          if ((n.data && n.data.node) || Array.isArray(n.path)) { lines.push(JSON.stringify(n)); return; }
          Object.values(n).forEach(unwrap);
        })(root);
      });
      if (lines.length) {
        if (SF_FB_DEBUG) console.log(`[SF][FB] bootstrap scan: ${lines.length} inline stream line(s)`);
        ingest(lines.join("\n"));
      }
    } catch (e) { if (SF_FB_DEBUG) console.warn("[SF][FB] bootstrap scan failed", e); }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Target count from the popup's items selection
  // ──────────────────────────────────────────────────────────────────────────
  function fbTargetCount(noItems) {
    if (!noItems || noItems === "all_reels") return Infinity;
    const m = /^(\d+)/.exec(noItems);          // "25_reels" -> 25, "347" -> 347
    return m ? parseInt(m[1], 10) : Infinity;
  }

  // Date-range mode (Phase 9) — mirrors IG's return_date_range. `key` is the Dates
  // dropdown value: "1_week"|"1_month"|"3_month"|"6_month"|"1_year"|"all_reels", or a
  // custom range "custom_<fromMs>_<toMs>". Returns [startMs, endMs].
  function fbDateRange(key) {
    if (typeof key === "string" && key.startsWith("custom_")) {
      const parts = key.split("_");
      const fromMs = parseInt(parts[1], 10);
      const toMs = parseInt(parts[2], 10);
      if (Number.isFinite(fromMs) && Number.isFinite(toMs)) {
        const end = new Date(toMs);
        end.setHours(23, 59, 59, 999); // capture the full "to" day
        return [fromMs, end.getTime()];
      }
    }
    const days = { "1_week": 7, "1_month": 30, "3_month": 90, "6_month": 180, "1_year": 360, "all_reels": 3600 };
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - (days[key] != null ? days[key] : 7));
    return [start.getTime(), end.getTime()];
  }

  // Results-banner sub-header SUFFIX, matching IG's handle_sub_header exactly:
  // " from 1 Month Back", " from <Mon D – Mon D>", or "" for all_reels. Leading space so it
  // appends cleanly to "N Reels".
  function fbDateRangeLabel(key, startMs, endMs) {
    const presets = {
      "1_week": " from 1 Week Back", "1_month": " from 1 Month Back", "3_month": " from 3 Months Back",
      "6_month": " from 6 Months Back", "1_year": " from 1 Year Back", "all_reels": "",
    };
    if (key in presets) return presets[key];
    const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const s = new Date(startMs), e = new Date(endMs), now = new Date();
    const sameYear = s.getFullYear() === e.getFullYear() && s.getFullYear() === now.getFullYear();
    if (sameYear) return ` from ${MON[s.getMonth()]} ${s.getDate()} – ${MON[e.getMonth()]} ${e.getDate()}`;
    return ` from ${MON[s.getMonth()]} ${s.getDate()}, ${s.getFullYear()} – ${MON[e.getMonth()]} ${e.getDate()}, ${e.getFullYear()}`;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // findElement — locate a reel tile by VideoID (mirrors IG's
  // find_element_instagram_again_posts). Grounded in dua_lipa_reel_page.html:
  // every grid tile is <a aria-label="Reel tile preview" href="/reel/<id>/…">.
  // Scrolls the tile into view (FB's lazy-load / pagination trigger) and resolves
  // the tile container. Used as the SCROLL PROXY during collection; the render
  // phase can later layer media-load polling on top.
  // ──────────────────────────────────────────────────────────────────────────
  // Registered with the Stop registry (see _sfStopFb): this poll ladder runs up
  // to 20×100ms, and collect() only reads the Stop flag between rounds.
  function find_element_facebook(videoId, retries = 20, interval = 100) {
    return new Promise((resolve) => {
      if (_sfStopFb.requested) { resolve(null); return; }
      const rec = { resolve: resolve, timer: null, settled: false, abortValue: null };
      _sfStopFb.waiters.add(rec);

      const settle = (value) => {
        if (rec.settled) return;
        rec.settled = true;
        clearTimeout(rec.timer);
        _sfStopFb.waiters.delete(rec);
        resolve(value);
      };

      const tryFind = (attemptsLeft) => {
        if (rec.settled) return;
        const anchor =
          document.querySelector(`a[aria-label="Reel tile preview"][href*="/reel/${videoId}"]`) ||
          document.querySelector(`a[href*="/reel/${videoId}"]`);
        if (anchor) {
          const tile = anchor.closest("div") || anchor;
          tile.scrollIntoView({ behavior: "auto", block: "center" });
          settle(tile);
        } else if (attemptsLeft > 0) {
          rec.timer = setTimeout(() => tryFind(attemptsLeft - 1), interval);
        } else {
          settle(null);
        }
      };
      tryFind(retries);
    });
  }
  if (SF_FB_DEBUG) window.__sfFbFindElement = find_element_facebook; // dev: call from console

  // ──────────────────────────────────────────────────────────────────────────
  // parseReduced (research doc §4) — localized compact strings -> Number.
  // FB renders Views/Shares as "1.2M" / "١٫٢ مليون" / "120万" per the viewer's
  // locale; no exact integer exists. ONE generic CLDR inverter (via Intl) learns
  // the format. Applied to Views + Shares ONLY (Likes/Comments/Date are exact).
  // ──────────────────────────────────────────────────────────────────────────
  // One entry per DIGIT SCRIPT (not per language) — FB uses native digits even
  // for a bare lang tag (e.g. "ar" -> ١٢٣), so normalize generically.
  const DIGIT_ZEROS = [
    0x0660, 0x06F0, 0x0966, 0x09E6, 0x0A66, 0x0AE6, 0x0B66, 0x0BE6,
    0x0C66, 0x0CE6, 0x0D66, 0x0E50, 0x0ED0, 0x0F20, 0x1040, 0x17E0,
  ];
  function digitsToAscii(s) {
    return s.replace(/\p{Nd}/gu, (ch) => {
      const cp = ch.codePointAt(0);
      if (cp >= 0x30 && cp <= 0x39) return ch;                 // already ASCII
      for (const z of DIGIT_ZEROS) if (cp >= z && cp <= z + 9) return String(cp - z);
      return ch;                                               // unknown script -> NaN -> null
    });
  }

  // Learn suffix -> scale (K/M/B, lakh/crore, 万/億) by formatting known magnitudes.
  function buildInverter(locale) {
    const nf = new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 2 });
    const suffixToScale = new Map();
    for (const k of [3, 4, 5, 6, 7, 8, 9, 12]) {
      const value = Math.pow(10, k);
      const parts = nf.formatToParts(value);
      const suffix = parts.filter((p) => p.type === "compact").map((p) => p.value).join("");
      if (!suffix) continue;
      const numStr = digitsToAscii(
        parts.filter((p) => ["integer", "decimal", "fraction"].includes(p.type)).map((p) => p.value).join("")
      ).replace(/[\u066B\u060C,]/g, ".");
      const shown = parseFloat(numStr);
      if (shown > 0 && !suffixToScale.has(suffix)) suffixToScale.set(suffix, value / shown);
    }
    return suffixToScale;
  }

  // Parse ONE FB reduced string -> Number, or null if unparseable.
  function parseReduced(str, suffixToScale) {
    if (str == null) return null;
    // strip bidi/format marks (LRM/RLM/ALM, isolates/overrides) + NBSP
    let s = String(str).replace(/[\u200E\u200F\u061C\u00A0\u202A-\u202E\u2066-\u2069]/g, "").trim();
    let best = null;
    for (const [suffix, scale] of suffixToScale) {
      if (suffix && s.includes(suffix) && (!best || suffix.length > best.suffix.length)) best = { suffix, scale };
    }
    let scale = 1, numPart = s;
    if (best) { scale = best.scale; numPart = s.split(best.suffix).join(""); }
    numPart = digitsToAscii(numPart).replace(/[\u066B\u060C,]/g, ".").replace(/\s+/g, ""); // comma/Arabic decimal -> "."
    const n = parseFloat(numPart);
    return Number.isNaN(n) ? null : Math.round(n * scale);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Sort (research doc §5) — one numeric comparator; only the source differs.
  // null/NaN (e.g. an unparseable locale for Views/Shares) sinks to the bottom.
  // ──────────────────────────────────────────────────────────────────────────
  function sort_items_facebook(data, sortBy) {
    const num = (v) => (v == null || Number.isNaN(v) ? -Infinity : v);
    const arr = [...data];
    switch (sortBy) {
      case "likes":    return arr.sort((a, b) => num(b.Likes) - num(a.Likes));
      case "comments": return arr.sort((a, b) => num(b.Comments) - num(a.Comments));
      case "shares":   return arr.sort((a, b) => num(b.Shares) - num(a.Shares));
      case "oldest":   return arr.sort((a, b) => a._ts - b._ts);
      case "views":    return arr.sort((a, b) => num(b.Views) - num(a.Views));
      case "outlier":
        // One shared baseline makes the score monotonic in views, so the views
        // fallback keeps the order correct when scoring came back insufficient
        // and no OutlierScore was stamped.
        return arr.sort((a, b) => num(b.OutlierScore ?? b.Views) - num(a.OutlierScore ?? a.Views));
      default:         return arr.sort((a, b) => b._ts - a._ts); // newest
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Collect — findElement-driven scroll until target / has_next_page:false / stall
  // ──────────────────────────────────────────────────────────────────────────
  // ──────────────────────────────────────────────────────────────────────────
  // Stop Sorting — immediate abort (mirrors Instagram/script_instagram.js)
  //
  // The banner's Stop button raises `feedRankStopSortingFacebook` AND posts
  // `sf_stop_sorting` (see _sfRequestStopFacebook in banner_on_facebook.js). The
  // flag on its own can only be POLLED, and collect() polls it once per scroll
  // round — a round that costs a find_element_facebook wait (up to 20×100ms)
  // plus an 1800ms SCROLL_PAUSE. So Stop could sit for ~3.8s before the loop
  // even looked at it.
  //
  // Unlike IG/TikTok, FB needs no separate express route: collect() is one
  // linear function, so breaking out of the loop already falls through to the
  // render with whatever was collected. All that's missing is getting there
  // immediately — hence an abortable sleep + abortable tile lookup, and a check
  // after every await.
  // ──────────────────────────────────────────────────────────────────────────
  const _sfStopFb = {
    requested: false,
    waiters: new Set(),  // pending sleeps + tile lookups, so Stop can cut them short
  };

  function _sfStopFbRequested() {
    if (_sfStopFb.requested) return true;
    try {
      return sessionStorage.getItem("feedRankStopSortingFacebook") === "on";
    } catch (e) {
      return false;
    }
  }

  function _sfStopFbFlush() {
    const pending = Array.from(_sfStopFb.waiters);
    _sfStopFb.waiters.clear();
    pending.forEach((rec) => {
      if (rec.settled) return;
      rec.settled = true;
      clearTimeout(rec.timer);
      try { rec.resolve(rec.abortValue); } catch (e) {}
    });
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data || !event.data.sf_stop_sorting) return;
    _sfStopFb.requested = true;
    _sfStopFbFlush();
    // Pool mode is between pages, not inside a sleep — resolve it here so the
    // render proceeds without scores instead of waiting for the next page or
    // the watchdog to notice.
    if (_sfFbOutlierPool.active) _sfFbOutlierFinish(_sfFbOutlierMeta("cancelled", null, 0, 0));
  });

  // Abortable sleep — Stop resolves it on the click's own tick.
  const sleep = (ms) => new Promise((resolve) => {
    if (_sfStopFb.requested) { resolve(); return; }
    const rec = { resolve: resolve, timer: null, settled: false, abortValue: undefined };
    rec.timer = setTimeout(() => {
      if (rec.settled) return;
      rec.settled = true;
      _sfStopFb.waiters.delete(rec);
      resolve();
    }, ms);
    _sfStopFb.waiters.add(rec);
  });

  // ── Scan progress — the bar for sorts that have no item target ─────────────
  // A DATE sort's finish line isn't a count, it's a date. The feed is newest-
  // first, so the timestamp of the reel the scroll has reached IS the distance
  // travelled from now back toward the range's start — a real, monotonic 0..1 the
  // banner can drive its bar off. Same idea as _sfFbOutlierPoolProgress, which
  // measures how full the outlier baseline pool is. Ported from IG (_sfScanProgress
  // in Instagram/script_instagram.js); see Docs/Progress banner/.
  //
  // Two signals, maxed together (again mirroring the outlier bar, and for the same
  // reason — either one alone stalls on some accounts):
  //   • time coverage — exact whenever the range's start lies inside the feed;
  //   • a work asymptote, collected ÷ (collected + K) — takes over when time says
  //     nothing: an "All" scrape (whose finish line is "feed exhausted", not a
  //     date) or an account younger than the requested range, where coverage would
  //     top out low and then jump.
  // Plus a floor once FB reports no next page: the last page has landed, so only
  // the filter/sort/render work remains and the bar belongs near the end.
  const SF_FB_SCAN_WORK_K = 60;           // knee of the work asymptote, in reels
  const SF_FB_SCAN_LAST_PAGE_FLOOR = 0.9; // reached the final page → nearly done

  // The oldest creation_time the scroll has actually REACHED. Read off the TAIL of
  // reelsById (insertion order = API order, newest-first), never the min across the
  // whole map: FB floats a pinned reel to the head of the Reels tab whatever its
  // age, and a min would read that as "we've already scrolled back years" and slam
  // the bar to 100% on page one. The tail is the true scroll frontier — the same
  // record collect()'s date-mode break already trusts. Clamped monotonic so an
  // out-of-order page can't walk it back.
  let _sfFbScanCursorMs = null;

  function _sfFbScanAdvanceCursor() {
    const ids = [...reelsById.keys()];
    for (let i = ids.length - 1; i >= 0; i--) {
      const r = reelsById.get(ids[i]);
      const ms = r && r.creation_time ? r.creation_time * 1000 : NaN;
      if (!Number.isFinite(ms) || ms <= 0) continue; // null timestamp → look further up
      if (_sfFbScanCursorMs === null || ms < _sfFbScanCursorMs) _sfFbScanCursorMs = ms;
      return;
    }
  }

  function _sfFbScanWorkProgress() {
    const n = reelsById.size;
    return n / (n + SF_FB_SCAN_WORK_K);
  }

  // 0..1, or null when this sort has a real item target and doesn't need it.
  function _sfFbScanProgress() {
    const isDates = sessionStorage.getItem("sortItemsVsDatesFacebook") === "dates";
    const noItems = sessionStorage.getItem("feedRankNoItemsFacebook") || "";
    // Item sorts drive the bar off count ÷ target — except "All" (and anything else
    // with no parseable number), which has no target and fell into the very same
    // dead branch in the banner. Matches _sfFbSortTarget() in banner_on_facebook.js.
    const openEnded = !isDates && fbTargetCount(noItems) === Infinity;
    if (!isDates && !openEnded) return null;

    _sfFbScanAdvanceCursor();
    let progress = _sfFbScanWorkProgress();

    // Time coverage: the journey is now → the range's start, and the cursor says
    // where we are along it. One formula covers both legs of a historical custom
    // range — the "seek" down to the range's top edge takes exactly its true share
    // of the bar, so there's no discontinuity when the range itself is reached.
    // Skipped for "All", whose 10-year span is a stand-in for "everything", not a
    // real boundary to travel to.
    if (noItems !== "all_reels" && dateModeRange && _sfFbScanCursorMs !== null) {
      const now = Date.now();
      const journey = now - dateModeRange[0];
      if (Number.isFinite(journey) && journey > 0) {
        progress = Math.max(progress, (now - _sfFbScanCursorMs) / journey);
      }
    }

    if (lastHasNextPage === false) progress = Math.max(progress, SF_FB_SCAN_LAST_PAGE_FLOOR);
    return Math.max(0, Math.min(1, progress));
  }

  // Post the running count to the content-script progress banner (banner_on_facebook.js).
  // Capped at the requested target so the bar/percent read cleanly.
  function notifyProgress() {
    if (handedOff) return;
    if (_sfFbOutlierPoolActive) return; // pool mode owns the banner via sf_outlier_analyzing
    let shown;
    if (dateModeRange) {
      // Date mode: show the count of IN-RANGE reels found so far (not total collected —
      // we may be scrolling past newer-than-range reels for a custom past range).
      const [s, e] = dateModeRange;
      shown = [...reelsById.values()].filter((r) => {
        const t = (r.creation_time || 0) * 1000;
        return t >= s && t < e;
      }).length;
    } else {
      const t = fbTargetCount(sessionStorage.getItem("feedRankNoItemsFacebook"));
      shown = t === Infinity ? reelsById.size : Math.min(reelsById.size, t);
    }
    const msg = { fb_banner_notification: true, count: shown, type: "Reels" };
    // An outlier sort's DISPLAY phase drives the bar exactly like the same sort
    // without outlier — count/target for items, coverage for dates.
    //
    // It used to hand the banner window coverage instead, for both phases, so
    // the display→pool handoff was one continuous stream. That made sense when
    // the pool ran to 100 items and dwarfed the display phase. At
    // SF_FB_OUTLIER_CAP 25 the coverage signal saturates almost immediately, so
    // the bar shot to its 95% ceiling and sat there for the whole scrape
    // looking hung. (Mirrors IG.)
    //
    // Pool mode still drives its own bar (sf_outlier_analyzing →
    // _sfFbOutlierBannerAnalyzing), and it now picks up from whatever the
    // display phase had painted rather than restarting from coverage.
    const scan = _sfFbScanProgress();
    if (scan !== null) msg.scanProgress = scan;
    window.postMessage(msg, "*");
  }

  // Trip FB's reel lazy-load the way a MANUAL scroll does. window.scrollTo didn't work,
  // which means FB scrolls an inner container (not the window). So: find the grid's
  // nearest scrollable ancestor and scroll IT to the bottom, plus scrollIntoView the last
  // tile (advances a virtualized grid a window at a time) and nudge the window — belt &
  // suspenders.
  function scroll_to_load_more_facebook() {
    const tiles = document.querySelectorAll('a[aria-label="Reel tile preview"], a[href*="/reel/"]');
    const lastTile = tiles.length ? (tiles[tiles.length - 1].closest("div") || tiles[tiles.length - 1]) : null;

    let sc = null, node = lastTile ? lastTile.parentElement : null, depth = 0;
    while (node && node !== document.documentElement && depth < 24) {
      const oy = getComputedStyle(node).overflowY;
      if ((oy === "auto" || oy === "scroll") && node.scrollHeight - node.clientHeight > 40) { sc = node; break; }
      node = node.parentElement; depth++;
    }

    const se = document.scrollingElement || document.documentElement;
    if (lastTile) lastTile.scrollIntoView({ behavior: "auto", block: "end" });
    if (sc) sc.scrollTop = sc.scrollHeight;
    se.scrollTop = se.scrollHeight;
    try { window.scrollTo(0, se.scrollHeight); } catch (_) {}
    return tiles.length > 0;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Outlier score — baseline pool (Profile → Reels ONLY, gated by the
  // `feedRankOutlier` sessionStorage flag set in init_feedrank_facebook.js).
  // Mirrors Instagram/script_instagram.js's engine, adapted to FB's collection:
  //   • score = reel VIEWS ÷ baseline, baseline = MEDIAN views of the account's
  //     most recent 25 qualifying reels — qualifying = a view count plus
  //     matured: ≥72h old, OR undated, OR with ≥ SF_FB_OUTLIER_RANK_MATURE
  //     newer reels above it (rank maturity — see that constant). There is NO
  //     time window (the 90→180→365 ladder was removed
  //     2026-08-27; see _sfFbOutlierComputeMeta for why). Floor: fewer than 20
  //     qualifying in the whole feed → "insufficient", which now genuinely
  //     means a new or tiny account.
  //   • ⚠️ The cap is a STOP condition, not a target: _sfFbOutlierEvaluate
  //     returns the moment 25 reels qualify. It was 100, which forced a free
  //     user's 25-item sort to sit through ~4x the pagination it asked for. At
  //     25 the display scrape has almost always already recorded enough, so
  //     pool mode never runs. Cost: a median off ~25 samples instead of ~100 is
  //     noisier (roughly ±18% vs ±10%), which the 2×/5×/10× tiers absorb except
  //     right at a boundary. Deliberately NOT coupled to the user's selection —
  //     one baseline per creator keeps multiples stable across sorts.
  //   • FB already accumulates EVERY fetched reel in `reelsById` (deduped,
  //     newest-first), so that Map IS the pool — no separate accumulator. Views
  //     come from parseReduced(play_count_reduced) (cached per record); dates from
  //     creation_time. FB profile reels expose no "pinned" signal, so there's no
  //     pinned exclusion (every collected reel is a candidate).
  //   • Pool mode is PAGE-DRIVEN, exactly like IG's (_sfOutlierRequestNextPage /
  //     _sfOutlierPoolPageArrived in Instagram/script_instagram.js): request one
  //     page with the display loop's own scroll proxy, evaluate the instant it
  //     lands (from ingest), and stop right there when the cap is met. It used
  //     to be a timed loop — jump to the absolute bottom, sleep 1.8s, then look
  //     — which could only notice a full cap after the pause and, on a bottom
  //     jump, could trip more than one fetch per look. A watchdog re-scrolls
  //     when no page comes (the display loop's 1.8s pause); five silent
  //     attempts — the same ~9s budget as before — mean the feed is exhausted.
  //     And the pool is BUDGETED (SF_FB_OUTLIER_MAX_POOL_PAGES / _MS): a few
  //     pages past the display target, then it scores with what qualified.
  //   • metric is always "views" on FB (kept on the meta so the shared content-
  //     script helpers/tooltips work unchanged).
  // ──────────────────────────────────────────────────────────────────────────
  const SF_FB_OUTLIER_MIN_AGE_MS = 72 * 60 * 60 * 1000; // <72h = too new to have matured
  // ── Rank maturity (Facebook only, 2026-09-15) ──────────────────────────────
  // On a page that posts many reels a day (TV channels, news pages — the
  // dmctv report) the newest 72 hours hold 50–100 reels, so "the most recent
  // 25 reels at least 72h old" sits PAGES below the 25 the user asked for, and
  // the pool scrolled on and on to reach them. Age isn't the only sign a reel
  // has had its run: once this many NEWER reels exist on the page it has left
  // the top of the feed, and its views are as settled as that page's rhythm
  // allows. So a reel also qualifies when at least this many newer reels are
  // banked above it. Inert on ordinary creators (their 16th reel is days old
  // anyway); on a high-frequency page it makes the display scrape itself the
  // baseline — a 25-reel outlier sort then collects what a views sort does.
  const SF_FB_OUTLIER_RANK_MATURE = 15;
  const SF_FB_OUTLIER_FLOOR = 20;                       // min qualifying reels for a trustworthy median
  const SF_FB_OUTLIER_CAP = 25;                         // most-recent qualifying reels kept for the median (see note above)
  // ── Pool BUDGET (Facebook only) ──────────────────────────────────────────
  // IG and TikTok keep a 40-page / 90s *safety* cap because their pools all but
  // never run past a page. On Facebook a 25-reel outlier sort was seen scrolling
  // on for a long time after the grid was ready, so the pool here is a budget,
  // not a safety net: at most this many pages past the display target, then the
  // median is computed from whatever qualified — the same yardstick a small
  // account gets at feed end — or, under the 20-reel floor, `insufficient`
  // (the "needs a few more reels" toast). A sort never scrapes more than about
  // one display target's worth of extra reels.
  const SF_FB_OUTLIER_MAX_POOL_PAGES = 4;               // pool budget: pages past the display target
  const SF_FB_OUTLIER_MAX_POOL_MS = 15 * 1000;          // pool budget: wall clock
  const SF_FB_OUTLIER_PAGE_WAIT_MS = 1800;              // watchdog per scroll attempt (the display SCROLL_PAUSE)
  const SF_FB_OUTLIER_MAX_SCROLL_ATTEMPTS = 5;          // silent re-scrolls before treating the feed as exhausted (~9s)
  const SF_FB_OUTLIER_BADGE_MIN = 2;                    // score below which a reel gets no badge (mirrors tier-1)

  // Pool-mode state (page-driven; see _sfFbOutlierEnsurePool). `gen` orphans a
  // request whose tile lookup was still pending when a page landed.
  const _sfFbOutlierPool = {
    active: false, resolveFn: null, startTs: 0, pagesFetched: 0, scrollAttempts: 0,
    waitTimer: null, gen: 0,
  };

  // Every outlier meta goes through here. The three trailing fields are
  // diagnostics for the sort context (it is mirrored to sessionStorage by the
  // renderer), so a live sort can be checked from the console afterwards:
  //   JSON.parse(sessionStorage.feedRankLastSortFacebook).outlier
  //   → banked (every reel collected), qualifying (mature + counted),
  //     poolSize (the median's sample, ≤ cap), poolPages (fetched past display),
  //     fresh (banked reels under 72h — the page's posting rhythm), undated
  //     (no creation_time), uncounted (no parseable play count — these can
  //     never be scored)
  function _sfFbOutlierMeta(status, baseline, poolSize, qualifying) {
    let fresh = 0, undated = 0, uncounted = 0;
    const now = Date.now();
    reelsById.forEach((r) => {
      const d = _sfFbReelDateMs(r);
      if (d === null) undated++;
      else if (now - d < SF_FB_OUTLIER_MIN_AGE_MS) fresh++;
      if (_sfFbReelViews(r) == null) uncounted++;
    });
    return {
      status, baseline, poolSize, metric: "views",
      banked: reelsById.size, qualifying, poolPages: _sfFbOutlierPool.pagesFetched,
      fresh, undated, uncounted,
    };
  }

  // Profile Reels tab + outlier flag on.
  function _sfFbOutlierOn() {
    return sessionStorage.getItem("feedRankOutlier") === "on" &&
      sessionStorage.getItem("feedRankSurfaceFacebook") === "profile_reels";
  }

  // Lazily build + cache the CLDR inverter (shared by the display Views parse and
  // the pool). One inverter regardless of call order.
  function _sfFbGetInverter() {
    if (!_sfFbOutlierInv) _sfFbOutlierInv = buildInverter(document.documentElement.lang || "en");
    return _sfFbOutlierInv;
  }

  // Numeric views for a raw reel record — parse the localized play_count_reduced
  // once and cache it on the record (null when unparseable).
  function _sfFbReelViews(r) {
    if (r._sfViews !== undefined) return r._sfViews;
    r._sfViews = parseReduced(r.play_count_reduced, _sfFbGetInverter());
    return r._sfViews;
  }

  // The reel's creation time in ms, or null when the payload carries none.
  function _sfFbReelDateMs(r) {
    const raw = r && r.creation_time ? r.creation_time * 1000 : NaN;
    return Number.isFinite(raw) && raw > 0 ? raw : null;
  }

  // Qualifying reels: matured (≥72h), with a view count. No age ceiling — see
  // _sfFbOutlierComputeMeta.
  //
  // An UNDATED reel counts as mature and ranks by feed position (newest first,
  // since insertion order is API order). It can't be shown to be fresh, and
  // excluding it meant that if FB ever dropped creation_time from the grid
  // payload NOTHING qualified — the pool scrolled to its cap and the sort ended
  // with no scores at all. A median is better than none; the few genuinely
  // fresh reels at the top of an undated feed barely move a median of 25.
  function _sfFbOutlierQualifying() {
    const now = Date.now();
    const out = [];
    let seq = 0;
    reelsById.forEach((r) => {
      const i = seq++;
      const views = _sfFbReelViews(r);
      if (views == null) return;
      const dateMs = _sfFbReelDateMs(r);
      const ageMature = dateMs === null || now - dateMs >= SF_FB_OUTLIER_MIN_AGE_MS;
      const rankMature = i >= SF_FB_OUTLIER_RANK_MATURE; // insertion order = feed order, newest first
      if (!ageMature && !rankMature) return;
      out.push({ dateMs, seq: i, views });
    });
    return out;
  }

  // Pool progress (0..1) for the banner's bar: qualifying reels ÷ cap.
  //
  // This used to also weigh "window coverage" (oldest reel's age ÷ the window)
  // and take the max of the two, because the pool could finish either by filling
  // the cap or by scrolling past the window's edge. With the window gone there
  // is one finish line left, so there is one signal.
  function _sfFbOutlierPoolProgress() {
    return Math.max(0, Math.min(1, _sfFbOutlierQualifying().length / SF_FB_OUTLIER_CAP));
  }

  // Count sent with the pool-mode tick: QUALIFYING reels (clamped to the cap).
  // The banner ignores it these days, but it stays in the message contract.
  function _sfFbOutlierDisplayCount() {
    return Math.min(SF_FB_OUTLIER_CAP, _sfFbOutlierQualifying().length);
  }

  // Median views of the most recent SF_FB_OUTLIER_CAP qualifying reels.
  //
  // ── No time window (2026-08-27, mirrors IG) ───────────────────────────────
  // The baseline used to be "qualifying reels inside a 90-day window", widening
  // to 180 then 365 when fewer than SF_FB_OUTLIER_FLOOR qualified, and giving
  // up as `insufficient` if 365 still fell short. That ladder was built for a
  // cap of 100. At a cap of 25 it never binds on active accounts, and on slow
  // ones all it does is refuse to score (a real profile with 50 reels spanning
  // 851 days had just 10 inside a year and reported "not enough reels").
  //
  // So the window is gone. The baseline is simply the most recent 25 qualifying
  // reels, whenever they were posted, and `insufficient` now means fewer than
  // 20 mature reels in total. Trade-off: on a slow account those 25 can span a
  // long time, so "more views than usual" means "than this creator's recent
  // history" rather than "than they're doing lately" — unavoidable, and far
  // better than refusing to score at all.
  function _sfFbOutlierComputeMeta() {
    let q = _sfFbOutlierQualifying();
    const qualifying = q.length;
    if (q.length < SF_FB_OUTLIER_FLOOR) {
      return _sfFbOutlierMeta("insufficient", null, q.length, qualifying);
    }
    // Newest first; undated reels fall in by feed position after the dated ones.
    q.sort((a, b) => ((b.dateMs ?? -Infinity) - (a.dateMs ?? -Infinity)) || (a.seq - b.seq));
    if (q.length > SF_FB_OUTLIER_CAP) q = q.slice(0, SF_FB_OUTLIER_CAP);
    const vals = q.map((r) => +r.views).sort((a, b) => a - b);
    const mid = vals.length >> 1;
    const baseline = vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
    if (!(baseline > 0)) {
      return _sfFbOutlierMeta("insufficient", null, q.length, qualifying);
    }
    return _sfFbOutlierMeta("ok", baseline, q.length, qualifying);
  }

  // Decide whether the pool is complete. Returns the final meta, or null when
  // more pages are needed. Two finish lines, down from four:
  //   • the cap is full — the feed is newest-first, so these ARE the most recent;
  //   • the feed is exhausted — no more pages are coming, so compute with
  //     whatever qualified (which returns `insufficient` below the floor).
  function _sfFbOutlierEvaluate() {
    if (_sfFbOutlierQualifying().length >= SF_FB_OUTLIER_CAP) return _sfFbOutlierComputeMeta();
    if (lastHasNextPage === false) return _sfFbOutlierComputeMeta();
    return null; // more pages needed
  }

  // ── Always-on baseline: compute the median when it's FREE ──────────────────
  //
  // An ordinary sort (views / likes / comments / oldest) often ends up holding
  // everything the median needs — `reelsById` is filled by every sort, not just an
  // outlier one. When it does, compute the baseline anyway: the scores get
  // stamped and "Outlier score" appears in the banner's Sort-by, so a later
  // outlier re-sort is instant instead of a full re-scrape.
  //
  // The hard rule is that this must never make an ordinary sort slower, so it is
  // pure arithmetic over data already in memory: no scrolling, no fetching, no
  // waiting. If the pool doesn't already hold enough, we do nothing.
  //
  // Correctness rides entirely on _sfFbOutlierEvaluate() — the same gate an explicit
  // outlier sort uses. There is no second, looser path here to get wrong.
  function _sfFbOutlierFreeBaseline() {
    if (sessionStorage.getItem("feedRankSurfaceFacebook") !== "profile_reels") return null;
    // A stopped run renders a truncated set and its pool is truncated the same
    // way — a truncated pool would bias the median, so bail explicitly.
    if (_sfStopFbRequested()) return null;
    let meta = null;
    try { meta = _sfFbOutlierEvaluate(); } catch (e) { return null; }
    if (!meta || meta.status !== "ok") return null; // null ⇒ needs more pages, and we never fetch
    if (SF_FB_DEBUG) console.log("[SF][FB] free baseline computed:", meta.baseline, "from", meta.poolSize, "reels");
    return meta;
  }

  // Pool mode's per-page tick — called from ingest() for every page that lands
  // while pool mode is active. Evaluates immediately, so the pool stops on the
  // very page that fills the cap; otherwise asks for exactly one more.
  function _sfFbOutlierPoolPageArrived() {
    const P = _sfFbOutlierPool;
    if (!P.active) return;
    P.pagesFetched++;
    P.scrollAttempts = 0;
    clearTimeout(P.waitTimer);
    P.waitTimer = null;
    window.postMessage(
      { sf_outlier_analyzing: true, count: _sfFbOutlierDisplayCount(), progress: _sfFbOutlierPoolProgress() },
      "*",
    );
    if (_sfStopFbRequested()) {
      _sfFbOutlierFinish(_sfFbOutlierMeta("cancelled", null, 0, 0));
      return;
    }
    const meta = _sfFbOutlierEvaluate();
    if (meta) { _sfFbOutlierFinish(meta); return; }
    if (P.pagesFetched >= SF_FB_OUTLIER_MAX_POOL_PAGES || Date.now() - P.startTs > SF_FB_OUTLIER_MAX_POOL_MS) {
      // Budget spent — score with what qualified (≥ floor) or report
      // `insufficient`; never scroll on. `lastHasNextPage` is left alone: the
      // feed did NOT run out, and the re-sort router reads that flag.
      _sfFbOutlierFinish(_sfFbOutlierComputeMeta());
      return;
    }
    _sfFbOutlierRequestNextPage();
  }

  // Ask FB for ONE more page, the way the display loop does: bring the LAST
  // banked reel's tile into view, which trips the load-more for exactly the page
  // after it. The absolute-bottom jump (scroll_to_load_more_facebook) is only
  // the fallback for when that tile isn't rendered — FB's grid is virtualized —
  // because landing on the very bottom can fire more than one fetch.
  //
  // A page that lands while the tile lookup is still pending takes over (its
  // arrival bumps `gen`), so this continuation quietly drops out rather than
  // scrolling for a page nobody needs.
  async function _sfFbOutlierRequestNextPage() {
    const P = _sfFbOutlierPool;
    if (!P.active) return;
    const gen = ++P.gen;
    const ids = [...reelsById.keys()];
    const lastId = ids[ids.length - 1];
    const tile = lastId ? await find_element_facebook(lastId) : null;
    if (!P.active || gen !== P.gen) return;
    if (_sfStopFbRequested()) {
      _sfFbOutlierFinish(_sfFbOutlierMeta("cancelled", null, 0, 0));
      return;
    }
    if (!tile) scroll_to_load_more_facebook();
    clearTimeout(P.waitTimer);
    P.waitTimer = setTimeout(() => {
      if (!P.active || gen !== P.gen) return;
      if (_sfStopFbRequested()) {
        _sfFbOutlierFinish(_sfFbOutlierMeta("cancelled", null, 0, 0));
        return;
      }
      // No page for several scrolls (has_next never went false) → treat the feed
      // as exhausted and let evaluate() take its feed-end branch, which computes
      // with whatever qualified (or reports `insufficient` below the floor).
      if (++P.scrollAttempts >= SF_FB_OUTLIER_MAX_SCROLL_ATTEMPTS) {
        lastHasNextPage = false;
        _sfFbOutlierFinish(_sfFbOutlierEvaluate() ||
          _sfFbOutlierMeta("insufficient", null, 0, _sfFbOutlierQualifying().length));
        return;
      }
      _sfFbOutlierRequestNextPage();
    }, SF_FB_OUTLIER_PAGE_WAIT_MS);
  }

  function _sfFbOutlierFinish(meta) {
    const P = _sfFbOutlierPool;
    if (!P.active) return;
    P.active = false;
    P.gen++;                       // orphan any pending tile lookup / watchdog
    _sfFbOutlierPoolActive = false;
    clearTimeout(P.waitTimer);
    P.waitTimer = null;
    const resolve = P.resolveFn;
    P.resolveFn = null;
    if (resolve) resolve(meta);
  }

  // Display phase done → ensure the pool is complete before rendering:
  //   (1) the pool already holds enough to compute a median → compute live. At
  //       SF_FB_OUTLIER_CAP 25 this is the normal outcome — collection has
  //       usually banked more than the cap needs.
  //   (2) not enough yet → pool mode: one page at a time, evaluated as it lands
  //       (see the two functions above), until the cap fills or the feed runs
  //       out, ticking the analyzing bar per page.
  // Never rejects; resolves the outlier meta (or a cancelled/error meta on Stop /
  // the safety cap).
  function _sfFbOutlierEnsurePool() {
    return new Promise((resolve) => {
      try {
        // Stop pressed during the display phase → skip scoring entirely (no badges).
        if (_sfStopFbRequested()) {
          resolve(_sfFbOutlierMeta("cancelled", null, 0, 0));
          return;
        }
        const early = _sfFbOutlierEvaluate();
        if (early) { resolve(early); return; } // pool already holds enough — no extra wait

        if (SF_FB_DEBUG) console.log("[SF][FB] pool short of the cap → pool mode");
        const P = _sfFbOutlierPool;
        P.active = true;
        _sfFbOutlierPoolActive = true; // silence notifyProgress() — the analyzing state owns the banner now
        P.startTs = Date.now();
        P.pagesFetched = 0;
        P.scrollAttempts = 0;
        P.resolveFn = resolve;
        window.postMessage(
          { sf_outlier_analyzing: true, count: _sfFbOutlierDisplayCount(), progress: _sfFbOutlierPoolProgress() },
          "*",
        );
        _sfFbOutlierRequestNextPage();
      } catch (e) {
        _sfFbOutlierPoolActive = false;
        resolve(_sfFbOutlierMeta("error", null, 0, 0));
      }
    });
  }

  // Stamp each display object's score = its views ÷ baseline (PascalCase key to
  // match the FB export payload + worker). Objects with no views get null.
  function _sfFbOutlierStampScores(objects, meta) {
    if (!meta || meta.status !== "ok" || !(meta.baseline > 0) || !Array.isArray(objects)) return;
    objects.forEach((o) => {
      if (!o) return;
      o.OutlierScore = typeof o.Views === "number" ? o.Views / meta.baseline : null;
    });
  }

  // Post the user-facing note (if any) the banner should show on removal. Two
  // OUTCOMES, deliberately worded apart because they are not the same claim:
  //   • NO BASELINE (case B) → we never had a yardstick, so we can say nothing
  //     about consistency. Copy asks for more reels and names the fallback
  //     order. Covers `insufficient` AND `error` (a pool-mode bail: page/time/
  //     stall cap). `error` used to be silent, which left a views-ordered grid
  //     with no explanation at all.
  //   • BASELINE OK, nothing cleared the badge floor (all < 2×) (case A) → this
  //     genuinely IS "everything performed consistently"; scores exist and the
  //     cards show real multiples, so the copy must NOT claim a views fallback.
  // `cancelled` stays silent on purpose — the user pressed Stop and knows why.
  function _sfFbOutlierNotifyOutcome(objects, meta) {
    if (!meta) return;
    if ((meta.status === "insufficient" || meta.status === "error") &&
        sessionStorage.getItem("feedRankSortByFacebook") === "outlier") {
      window.postMessage({ sf_outlier_insufficient: true, metric: meta.metric }, "*");
      return;
    }
    // Both toasts belong to a sort the user actually ASKED to be an outlier sort.
    // Since the always-on baseline computes a median on ordinary sorts too, without
    // this guard a plain views sort could announce "no outliers" — a verdict on a
    // question nobody asked.
    if (meta.status === "ok" && Array.isArray(objects) &&
        sessionStorage.getItem("feedRankSortByFacebook") === "outlier") {
      const anyBadge = objects.some((o) => o && typeof o.OutlierScore === "number" && o.OutlierScore >= SF_FB_OUTLIER_BADGE_MIN);
      if (!anyBadge) window.postMessage({ sf_outlier_no_breakout: true, metric: meta.metric }, "*");
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Sort context — the record a back-to-back re-sort decides on
  // ──────────────────────────────────────────────────────────────────────────
  // Rides on the render message to dom_facebook.js, which parks it on
  // window.__sfReelsFb.ctx. Facebook/resort_facebook.js reads it to answer "can
  // this new request be served from what we already collected?".
  //
  // Two fields carry the weight:
  //   • collectedCount — EXACT: the display set after the items slice / date
  //     filter, not the raw `reelsById` size, which can hold extras the grid
  //     never showed. Every coverage test rests on it.
  //   • feedExhausted — the feed genuinely ran out (has_next_page:false), not
  //     merely "we stopped scrolling". Date mode also breaks the loop once the
  //     oldest reel predates the range, which is NOT exhaustion — hence reading
  //     lastHasNextPage rather than inferring it from the loop's exit.
  //
  // `path` + `search` locate the grid: FB's no-vanity profiles all share the
  // /profile.php pathname and differ only in ?id=/&sk=.
  function _sfFbSortContext(o) {
    return {
      mode: o.isDates ? "dates" : "items",
      selection: o.noItems,
      sortBy: o.sortBy,
      surface: sessionStorage.getItem("feedRankSurfaceFacebook") || "profile_reels",
      path: location.pathname,
      search: location.search,
      locKey: _sfFbLocationKey(),
      collectedCount: o.collectedCount,
      feedExhausted: lastHasNextPage === false,
      stoppedByUser: _sfStopFbRequested(),
      outlier: o.outlier || null,
      empty: o.empty === true,
    };
  }

  // Twin of _sfResortLocationKeyFb in the content script — keep the two in step.
  function _sfFbLocationKey() {
    try {
      const path = location.pathname;
      const first = path.split("/").filter(Boolean)[0];
      if (path.startsWith("/profile.php") || first === "people") {
        const q = new URLSearchParams(location.search);
        return path + "?id=" + (q.get("id") || "") + "&sk=" + (q.get("sk") || "");
      }
      return path;
    } catch (e) {
      return location.pathname;
    }
  }

  async function collect() {
    if (collected) return;
    collected = true;

    const noItems = sessionStorage.getItem("feedRankNoItemsFacebook");
    const isDates = sessionStorage.getItem("sortItemsVsDatesFacebook") === "dates";
    if (isDates) dateModeRange = fbDateRange(noItems);
    // Date mode has no count cap — collection is bounded by the range start instead.
    const target = isDates ? Infinity : fbTargetCount(noItems);
    if (SF_FB_DEBUG) console.log(`[SF][FB] collecting — ${isDates ? `dates ${new Date(dateModeRange[0]).toISOString().slice(0, 10)}..${new Date(dateModeRange[1]).toISOString().slice(0, 10)}` : `target=${target === Infinity ? "all" : target}`}`);

    // Start as soon as EITHER a shorts response landed OR FB rendered any reel tile —
    // on some profiles page 1 only loads after a scroll, so waiting for a network
    // response that never comes would stall the whole sort for 15s.
    let waited = 0;
    while (!sawAnyShortsResponse && !document.querySelector('a[href*="/reel/"]') && waited < 15000) {
      await sleep(250);
      if (_sfStopFbRequested()) break; // Stop cut the sleep short
      waited += 250;
    }

    // First count → upgrades the prep banner ("Getting ready to sort") into the
    // live progress banner (Phase 7.3). Posted again after every scroll round below.
    notifyProgress();

    const SCROLL_PAUSE = 1800;
    const MAX_STALLS = 6;          // ~11s of no growth -> stop
    const MAX_ROUNDS = 500;        // hard backstop
    let stalls = 0, rounds = 0, lastCount = reelsById.size;

    while (reelsById.size < target && lastHasNextPage !== false && stalls < MAX_STALLS && rounds < MAX_ROUNDS) {
      // Stop button (progress banner) — bail and render whatever we have.
      if (_sfStopFbRequested()) {
        if (SF_FB_DEBUG) console.log("[SF][FB] stop requested → ending collection early");
        break;
      }
      // Scroll proxy: bring the last collected reel's tile into view to trip FB's
      // infinite-scroll. Targeting the bottom-most tile also stays ahead of FB's
      // grid virtualization (data-virtualized), which prunes tiles off the top.
      const ids = [...reelsById.keys()];
      const lastId = ids[ids.length - 1];
      const tile = lastId ? await find_element_facebook(lastId) : null;
      if (_sfStopFbRequested()) break; // Stop settled that lookup — don't scroll on
      // No collected reel to target yet → scroll FB's actual scroll container (trips
      // lazy-load like a manual scroll).
      if (!tile) scroll_to_load_more_facebook();
      await sleep(SCROLL_PAUSE);
      if (_sfStopFbRequested()) break; // Stop cut the pause short
      rounds++;
      if (reelsById.size > lastCount) { lastCount = reelsById.size; stalls = 0; }
      else { stalls++; }
      notifyProgress(); // tick the progress banner with the new count
      if (SF_FB_DEBUG) console.log(`[SF][FB] scroll ${rounds} (${tile ? "findElement" : "loadmore"}) — total=${reelsById.size} has_next=${lastHasNextPage} stalls=${stalls}`);
      // Date mode: reels arrive newest-first, so once the OLDEST collected reel predates the
      // range start, everything beyond is older too — stop scrolling.
      if (isDates) {
        // Stop once the oldest reel WITH a valid timestamp predates the range start. Guard on a
        // truthy creation_time so a missing/null one can't falsely trip an early stop (which would
        // collect almost nothing and filter to 0).
        const allIds = [...reelsById.keys()];
        const oldest = reelsById.get(allIds[allIds.length - 1]);
        if (oldest && oldest.creation_time && oldest.creation_time * 1000 < dateModeRange[0]) break;
      }
    }

    let reels;
    if (isDates) {
      const [s, e] = dateModeRange;
      reels = [...reelsById.values()].filter((r) => {
        const t = (r.creation_time || 0) * 1000;
        return t >= s && t < e;
      });
    } else {
      reels = [...reelsById.values()];
      if (target !== Infinity) reels = reels.slice(0, target);
    }

    if (!reels.length) {
      handedOff = true;
      // Nothing rendered ⇒ no grid to re-shuffle. The marker rides along so a
      // later re-sort refuses outright rather than trusting a stale context.
      // (Belt and braces: an empty result never mounts a banner either, and the
      // router's caller only runs when the banner is present.)
      const emptyCtx = _sfFbSortContext({ isDates, noItems, sortBy: sessionStorage.getItem("feedRankSortByFacebook") || "views", collectedCount: 0, empty: true });
      if (isDates) {
        // Date range matched nothing — leave the feed exactly as it is (don't hide
        // it behind an empty sorted grid) and turn the progress banner into a
        // friendly "no Reels in this date range" toast. Mirrors IG/TikTok.
        if (SF_FB_DEBUG) console.warn("[SF][FB] 0 reels in the selected date range");
        window.postMessage({ fb_sort_empty: true, dateEmpty: true, noData: !sfAnyResponseSeen, sf_ctx: emptyCtx }, "*");
      } else {
        // No reels on this surface (or FB shape changed). Don't render/hide anything — just
        // tell the progress banner to swap to a friendly "no reels" message and dismiss
        // itself (banner_on_facebook.js). The page is left untouched. Profile/saved/owner alike.
        if (SF_FB_DEBUG) console.warn("[SF][FB] collected 0 reels — surface has no reels (or FB shape changed)");
        window.postMessage({ fb_sort_empty: true, noData: !sfAnyResponseSeen, sf_ctx: emptyCtx }, "*");
      }
      return;
    }

    // ── Phase 5: convert Views + Shares (localized strings) -> numbers. ONLY these two.
    const inv = _sfFbGetInverter();

    // ── Outlier score (profile Reels only): the display set above is now frozen, so
    // extend the scroll collection into a baseline pool, compute the account median,
    // and stamp OutlierScore on the display objects. Pool mode reuses
    // scroll_to_load_more_facebook() (metadata-only). null when scoring is off.
    let sfOutlierMeta = null;
    if (_sfFbOutlierOn()) {
      sfOutlierMeta = await _sfFbOutlierEnsurePool();
    } else {
      // Not an outlier sort — but if the median is already computable from what we
      // collected, take it. Free, and it makes a later outlier re-sort instant.
      sfOutlierMeta = _sfFbOutlierFreeBaseline();
    }

    // ── Phase 6: build the deliverable object, sort by the clicked metric.
    // `_sfSeq` is the arrival index — FEED order, before any metric sort. Only
    // profile Reels is chronological; Saved is ordered by when you saved it and
    // Your Reels by FB's own collection order, and nothing on the item
    // reconstructs either. Recording it here is what lets a back-to-back re-sort
    // narrow "100 → the latest 50" and get the same 50 a fresh sort would
    // (Facebook/resort_facebook.js). Ignored by every export — they all map
    // explicit columns.
    const objects = reels.map((r, i) => ({
      Profile:  r.profileName ?? null,
      VideoID:  r.id,
      _sfSeq:   i,
      Thumb:    r.preferredThumb || r.fallbackThumb || null, // Phase 7.1 — render tile (not an export column)
      Likes:    r.likes ?? null,
      Comments: r.total_comment_count ?? null,
      Date:     r.creation_time ? new Date(r.creation_time * 1000).toISOString() : null, // full ISO; export slices for CSV / toLocaleString for Excel+JSON (mirrors IG)
      Caption:  r.caption || "",
      Views:    parseReduced(r.play_count_reduced, inv),
      Shares:   parseReduced(r.share_count_reduced, inv),
      _ts:      r.creation_time || 0,   // internal sort key (stripped before handoff)
    }));

    // Score = views ÷ account median (no-op unless the pool resolved "ok"); then post
    // the insufficient / no-breakout banner note BEFORE the render removes the banner.
    _sfFbOutlierStampScores(objects, sfOutlierMeta);
    _sfFbOutlierNotifyOutcome(objects, sfOutlierMeta);

    const sortBy = sessionStorage.getItem("feedRankSortByFacebook") || "views";
    const sorted = sort_items_facebook(objects, sortBy);
    const out = sorted.map(({ _ts, ...rest }) => rest);   // drop the internal key (keeps OutlierScore)

    if (SF_FB_DEBUG) {
      console.log(`%c[SF][FB] ✅ sorted ${out.length} reels by "${sortBy}"`, "color:#1877f2;font-weight:bold");
      console.table(out.map(({ Thumb, ...rest }) => rest)); // omit long thumb URLs from the table
    }

    // ── Phase 7.0 / 9 — hand the sorted array to the content-script renderer (dom_facebook.js).
    const rangeLabel = isDates ? fbDateRangeLabel(noItems, dateModeRange[0], dateModeRange[1]) : null;
    handedOff = true; // stop further ingest/notify before we post (late pages must not re-open the banner)
    window.postMessage({
      fb_render: true, payload: out, sortBy, rangeLabel, sf_outlier: sfOutlierMeta,
      // Back-to-back re-sorting: what this scrape actually covered, so a SECOND
      // popup sort can be answered from the rendered grid instead of reloading
      // (Facebook/resort_facebook.js). collect() is one linear function with no
      // express Stop route — an abort just breaks the loop and falls through to
      // here — so this single site covers natural completion AND Stop.
      sf_ctx: _sfFbSortContext({ isDates, noItems, sortBy, collectedCount: out.length, outlier: sfOutlierMeta }),
    }, "*");
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Boot — arm the collector only during an active sort
  // ──────────────────────────────────────────────────────────────────────────
  if (SORT_ACTIVE) {
    if (SF_FB_DEBUG) console.log("[SF][FB] sort active → collector armed");
    const start = () => { scanInlineBootstrap(); collect(); };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
      start();
    }
  }
})();
