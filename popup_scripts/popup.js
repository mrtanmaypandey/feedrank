// 🔧 Debug switch — flip to true when you want verbose logs
const DBUG = false;

// 🚩 Outlier UI preview flag — when true, the popup shows the (not-yet-wired)
// "Outlier score" sort option + info tooltip. IG wires a real click; TikTok &
// Facebook render it INERT (preview only — triggering handled in a later session).
// Flip to false to hide the whole preview until the real Outlier feature ships.
const outlierFlag = true;

// When true, slideIn() is a no-op. Used during initial popup open so restored
// tabs appear instantly instead of animating in.
let _sfSuppressSlide = false;

// Slide-in animation helper — cleans up transform stacking context after animation
function slideIn(el, direction) {
  if (_sfSuppressSlide) return;

  // Clip the slide to the containing dropdown row so the element doesn't
  // appear to fly in from outside the popup. Restored on animationend so the
  // dropdown menu can still open normally below the row.
  const clipParent = el.closest('.sf-sort-dd-row') || el.parentElement;
  const prevOverflow = clipParent ? clipParent.style.overflow : '';
  if (clipParent) clipParent.style.overflow = 'hidden';

  el.classList.remove('animate__animated', 'animate__slideInLeft', 'animate__slideInRight');
  void el.offsetWidth;
  el.classList.add('animate__animated', direction === 'left' ? 'animate__slideInLeft' : 'animate__slideInRight');
  el.style.setProperty('--animate-duration', '.2s');
  el.addEventListener('animationend', () => {
    el.classList.remove('animate__animated', 'animate__slideInLeft', 'animate__slideInRight');
    if (clipParent) clipParent.style.overflow = prevOverflow;
  }, { once: true });
}

////////////////////////////////////////////////////////////////////////////////
// listen to URL
////////////////////////////////////////////////////////////////////////////////

document.addEventListener('DOMContentLoaded', function () {
  if (DBUG) console.log("[Popup] DOMContentLoaded");

  // const { sorafy_state_type_flag } = await chrome.storage.local.get("sorafy_state_type_flag");
  // if (sorafy_state_type_flag) setView(sorafy_state_type_flag);

  feature_banner(); // ✅ show banner regardless of page

  initOutlierPreviewUI(); // 🚩 Outlier score preview (IG only, gated by outlierFlag)


  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    let currentTab = tabs[0];
    let url = currentTab.url;
    if (DBUG) console.log("[Popup] Active tab URL:", url);

    if (url.startsWith("https://www.instagram.com")) {
      if (DBUG) console.log("[Mode] Instagram ON");
      insta_mode_on();
      feature_banner("insta"); // Save library note
    } else if (url.startsWith("https://www.tiktok.com")) {
      if (DBUG) console.log("[Mode] TikTok ON");
      tiktok_mode_on();
      feature_banner("tiktok"); // no banner
    } else if (url.startsWith("https://www.facebook.com")) {
      if (DBUG) console.log("[Mode] Facebook ON");
      facebook_mode_on();
      feature_banner("facebook"); // no banner
    } else if (url.startsWith("https://www.youtube.com")) {
      if (DBUG) console.log("[Mode] YouTube ON (preview — inert)");
      youtube_mode_on();
      feature_banner("youtube"); // no banner
    } else {
      if (DBUG) console.log("[Mode] Zero State ON");
      zero_state_on();
      feature_banner("zero"); // Save library note
    }
  });
});

////////////////////////////////////////////////////////////////////////////////
// clicks on dates for TikTok
////////////////////////////////////////////////////////////////////////////////

var dateRangeButtonTikTok = document.getElementById("dateRangeButtonTikTok");
dateRangeButtonTikTok?.addEventListener("click", function () {
  if (DBUG) console.log("[TikTok] Dates button clicked");

  document.getElementById("dates_selected_tiktok")?.setAttribute("active", "on");
  if (dateRangeButtonTikTok) dateRangeButtonTikTok.className = "itemButtonClassTikTok";

  var itemButton = document.getElementById("itemButtonTikTok");
  if (itemButton) itemButton.className = "dateRangeButtonClassTikTok";

  document.getElementById("no_reels_selected_tiktok")?.setAttribute("active", "off");

  // custom dropdowns
  const ttItems = document.getElementById("sf-dd-tt-items");
  const ttDates = document.getElementById("sf-dd-tt-dates");
  if (ttItems) ttItems.style.display = 'none';
  if (ttDates) {
    ttDates.style.display = 'flex';
    slideIn(ttDates, 'right');
  }
  localStorage.setItem('sf_tt_sub_tab', 'date');
});

////////////////////////////////////////////////////////////////////////////////
// clicks on items for TikTok
////////////////////////////////////////////////////////////////////////////////

var itemButtonTikTok = document.getElementById("itemButtonTikTok");
itemButtonTikTok?.addEventListener("click", function () {
  if (DBUG) console.log("[TikTok] Items button clicked");

  if ((document.getElementById("no_reels_selected_tiktok")?.getAttribute("active")) !== 'on') {
    document.getElementById("no_reels_selected_tiktok")?.setAttribute("active", "on");

    if (itemButtonTikTok) itemButtonTikTok.className = "itemButtonClassTikTok";

    var dateRangeButton = document.getElementById("dateRangeButtonTikTok");
    if (dateRangeButton) dateRangeButton.className = "dateRangeButtonClassTikTok";

    document.getElementById("dates_selected_tiktok")?.setAttribute("active", "off");

    // custom dropdowns
    const ttItems = document.getElementById("sf-dd-tt-items");
    const ttDates = document.getElementById("sf-dd-tt-dates");
    if (ttDates) ttDates.style.display = 'none';
    if (ttItems) {
      ttItems.style.display = 'flex';
      slideIn(ttItems, 'left');
    }
    localStorage.setItem('sf_tt_sub_tab', 'item');
  }
});

////////////////////////////////////////////////////////////////////////////////
// clicks on dates for Instagram
////////////////////////////////////////////////////////////////////////////////

var dateRangeButton = document.getElementById("dateRangeButton");
dateRangeButton?.addEventListener("click", function () {
  if (DBUG) console.log("[Insta] Dates button clicked");

  document.getElementById("dates_selected")?.setAttribute("active", "on");
  if (dateRangeButton) dateRangeButton.className = "itemButtonClass";

  var itemButton = document.getElementById("itemButton");
  if (itemButton) itemButton.className = "dateRangeButtonClass";

  document.getElementById("no_reels_selected")?.setAttribute("active", "off");

  // custom dropdowns
  const igItems = document.getElementById("sf-dd-ig-items");
  const igDates = document.getElementById("sf-dd-ig-dates");
  if (igItems) igItems.style.display = 'none';
  if (igDates) {
    igDates.style.display = 'flex';
    slideIn(igDates, 'right');
  }

  localStorage.setItem('sf_ig_sub_tab', 'date');
});

////////////////////////////////////////////////////////////////////////////////
// clicks on items for Instagram
////////////////////////////////////////////////////////////////////////////////

var itemsButton = document.getElementById("itemButton");
itemsButton?.addEventListener("click", function () {
  if (DBUG) console.log("[Insta] Items button clicked");

  if ((document.getElementById("no_reels_selected")?.getAttribute("active")) !== 'on') {
    document.getElementById("no_reels_selected")?.setAttribute("active", "on");

    if (itemsButton) itemsButton.className = "itemButtonClass";

    var dateRangeButton = document.getElementById("dateRangeButton");
    if (dateRangeButton) dateRangeButton.className = "dateRangeButtonClass";

    document.getElementById("dates_selected")?.setAttribute("active", "off");

    // custom dropdowns
    const igItems = document.getElementById("sf-dd-ig-items");
    const igDates = document.getElementById("sf-dd-ig-dates");
    if (igDates) igDates.style.display = 'none';
    if (igItems) {
      igItems.style.display = 'flex';
      slideIn(igItems, 'left');
    }

    localStorage.setItem('sf_ig_sub_tab', 'item');
  }
});

////////////////////////////////////////////////////////////////////////////////
// clicks on dates for Facebook
////////////////////////////////////////////////////////////////////////////////

var dateRangeButtonFacebook = document.getElementById("dateRangeButtonFacebook");
dateRangeButtonFacebook?.addEventListener("click", function () {
  if (DBUG) console.log("[Facebook] Dates button clicked");

  document.getElementById("dates_selected_facebook")?.setAttribute("active", "on");
  if (dateRangeButtonFacebook) dateRangeButtonFacebook.className = "itemButtonClass";

  var itemButton = document.getElementById("itemButtonFacebook");
  if (itemButton) itemButton.className = "dateRangeButtonClass";

  document.getElementById("no_reels_selected_facebook")?.setAttribute("active", "off");

  // custom dropdowns
  const fbItems = document.getElementById("sf-dd-fb-items");
  const fbDates = document.getElementById("sf-dd-fb-dates");
  if (fbItems) fbItems.style.display = 'none';
  if (fbDates) {
    fbDates.style.display = 'flex';
    slideIn(fbDates, 'right');
  }

  var onlyWorks = document.getElementById("OnlyWorksPostsFacebook");
  if (onlyWorks) onlyWorks.style.display = 'none';
  localStorage.setItem('sf_fb_sub_tab', 'date');
});

////////////////////////////////////////////////////////////////////////////////
// clicks on items for Facebook
////////////////////////////////////////////////////////////////////////////////

var itemsButtonFacebook = document.getElementById("itemButtonFacebook");
itemsButtonFacebook?.addEventListener("click", function () {
  if (DBUG) console.log("[Facebook] Items button clicked");

  if ((document.getElementById("no_reels_selected_facebook")?.getAttribute("active")) !== 'on') {
    document.getElementById("no_reels_selected_facebook")?.setAttribute("active", "on");

    if (itemsButtonFacebook) itemsButtonFacebook.className = "itemButtonClass";

    var dateRangeButton = document.getElementById("dateRangeButtonFacebook");
    if (dateRangeButton) dateRangeButton.className = "dateRangeButtonClass";

    document.getElementById("dates_selected_facebook")?.setAttribute("active", "off");

    // custom dropdowns
    const fbItems = document.getElementById("sf-dd-fb-items");
    const fbDates = document.getElementById("sf-dd-fb-dates");
    if (fbDates) fbDates.style.display = 'none';
    if (fbItems) {
      fbItems.style.display = 'flex';
      slideIn(fbItems, 'left');
    }

    const onlyWorks = document.getElementById("OnlyWorksPostsFacebook");
    if (onlyWorks) onlyWorks.style.display = 'none';

    localStorage.setItem('sf_fb_sub_tab', 'item');
  }
});

////////////////////////////////////////////////////////////////////////////////
// clicks on dates for YouTube (preview — local UI only, triggers nothing)
////////////////////////////////////////////////////////////////////////////////

var dateRangeButtonYoutube = document.getElementById("dateRangeButtonYoutube");
dateRangeButtonYoutube?.addEventListener("click", function () {
  if (DBUG) console.log("[YouTube] Dates button clicked");

  document.getElementById("dates_selected_youtube")?.setAttribute("active", "on");
  if (dateRangeButtonYoutube) dateRangeButtonYoutube.className = "itemButtonClass";

  var itemButton = document.getElementById("itemButtonYoutube");
  if (itemButton) itemButton.className = "dateRangeButtonClass";

  document.getElementById("no_reels_selected_youtube")?.setAttribute("active", "off");

  // custom dropdowns
  const ytItems = document.getElementById("sf-dd-yt-items");
  const ytDates = document.getElementById("sf-dd-yt-dates");
  if (ytItems) ytItems.style.display = 'none';
  if (ytDates) {
    ytDates.style.display = 'flex';
    slideIn(ytDates, 'right');
  }

  var onlyWorks = document.getElementById("OnlyWorksPostsYoutube");
  if (onlyWorks) onlyWorks.style.display = 'none';
  localStorage.setItem('sf_yt_sub_tab', 'date');
});

////////////////////////////////////////////////////////////////////////////////
// clicks on items for YouTube (preview — local UI only, triggers nothing)
////////////////////////////////////////////////////////////////////////////////

var itemsButtonYoutube = document.getElementById("itemButtonYoutube");
itemsButtonYoutube?.addEventListener("click", function () {
  if (DBUG) console.log("[YouTube] Items button clicked");

  if ((document.getElementById("no_reels_selected_youtube")?.getAttribute("active")) !== 'on') {
    document.getElementById("no_reels_selected_youtube")?.setAttribute("active", "on");

    if (itemsButtonYoutube) itemsButtonYoutube.className = "itemButtonClass";

    var dateRangeButton = document.getElementById("dateRangeButtonYoutube");
    if (dateRangeButton) dateRangeButton.className = "dateRangeButtonClass";

    document.getElementById("dates_selected_youtube")?.setAttribute("active", "off");

    // custom dropdowns
    const ytItems = document.getElementById("sf-dd-yt-items");
    const ytDates = document.getElementById("sf-dd-yt-dates");
    if (ytDates) ytDates.style.display = 'none';
    if (ytItems) {
      ytItems.style.display = 'flex';
      slideIn(ytItems, 'left');
    }

    const onlyWorks = document.getElementById("OnlyWorksPostsYoutube");
    if (onlyWorks) onlyWorks.style.display = 'none';

    localStorage.setItem('sf_yt_sub_tab', 'item');
  }
});

////////////////////////////////////////////////////////////////////////////////
// Settings subview — Instagram / TikTok / Facebook (header gear ▸ Display)
//
// None of the three has a Sort/Actions segmented control anymore: Sort is the
// only landing view and the Display toggles are buried behind the gear that sits
// beside the Free/Pro tag. Opening/closing swaps the two sibling panels with a
// crossfade-slide while the header crossfades between the wordmark and
// "← Settings".
//
// One gear serves all three platforms, so it needs to know which pair of panels
// it currently drives — that's `_sfSettingsSurface`, set by the *_mode_on()
// functions. YouTube has no Display toggles, so it leaves the surface null and
// the gear stays hidden.
//
// The view is intentionally NOT persisted: Settings is a detour, so the popup
// always reopens on Sort.
////////////////////////////////////////////////////////////////////////////////

var sfGearBtn = document.getElementById("sfGearBtn");
var sfSettingsBackBtn = document.getElementById("sfSettingsBack");

const SF_SETTINGS_PANELS = {
  ig: { sort: "igSortContent", settings: "igDownloadContent" },
  tt: { sort: "ttSortContent", settings: "ttDownloadContent" },
  fb: { sort: "fbSortContent", settings: "fbDownloadContent" }
};

// null = no platform active (zero state / YouTube) → gear hidden, gear clicks
// are no-ops because there is nothing to swap to.
var _sfSettingsSurface = null;

// Guards against a second swap landing mid-animation (double-click on the gear,
// or Escape fired while the open animation is still running).
var _sfIgViewBusy = false;
var _sfIgViewTimers = [];
var _sfIgPendingUnclip = null;

// Resolves the active platform's panel pair, or null when there is no platform.
function _sfSettingsPanels() {
  const ids = SF_SETTINGS_PANELS[_sfSettingsSurface];
  if (!ids) return null;
  const sort = document.getElementById(ids.sort);
  const settings = document.getElementById(ids.settings);
  return (sort && settings) ? { sort, settings } : null;
}

// Called by every *_mode_on() / *_mode_off(). Closes whatever the OUTGOING
// surface had open before repointing, so a Settings view can never bleed across
// a feed switch.
function sfSetSettingsSurface(surface) {
  sfCloseSettings(true);
  _sfSettingsSurface = surface || null;
  document.body.classList.toggle("sf-gear-on", !!_sfSettingsSurface);
}

// Cancelling the swap timers would otherwise strand the temporary overflow clip
// applied below, so the pending restore runs here too.
function _sfIgClearViewTimers() {
  _sfIgViewTimers.forEach(clearTimeout);
  _sfIgViewTimers = [];
  if (_sfIgPendingUnclip) {
    _sfIgPendingUnclip();
    _sfIgPendingUnclip = null;
  }
}

// Eases `outEl` away, hands over display at the phase boundary (both panels are
// invisible there, so the popup's height snap is unnoticeable), then springs
// `inEl` in from the opposite side. Must stay in lockstep with the .sf-panel-*
// animation durations — and with the header's transition delays, which is what
// makes the wordmark and the card beneath it move as one.
const PANEL_OUT_MS = 90;
const PANEL_IN_MS  = 180;

function sfIgSwapPanels(outEl, inEl, dir) {
  const outClass = dir === 'forward' ? 'sf-panel-out-left' : 'sf-panel-out-right';
  const inClass  = dir === 'forward' ? 'sf-panel-in-right' : 'sf-panel-in-left';

  _sfIgViewBusy = true;
  _sfIgClearViewTimers();

  // Both panels are full-width, so sliding them sideways pushes past the
  // document edge. A Chrome popup sizes its window to the document and never
  // shrinks back, so that overflow would permanently widen the popup — leaving
  // white gutters either side of the footer. Clip for the duration of the swap
  // only (same trick as slideIn()), on the x axis alone so the dropdown menus
  // and tooltips can still overflow downward.
  const clip = outEl.parentElement;
  const prevOverflowX = clip ? clip.style.overflowX : '';
  if (clip) clip.style.overflowX = 'clip';
  _sfIgPendingUnclip = () => { if (clip) clip.style.overflowX = prevOverflowX; };

  outEl.classList.remove('sf-panel-in-right', 'sf-panel-in-left');
  outEl.classList.add(outClass);

  _sfIgViewTimers.push(setTimeout(() => {
    outEl.classList.remove(outClass);
    outEl.style.display = 'none';

    inEl.style.display = 'flex';
    inEl.classList.remove('sf-panel-out-left', 'sf-panel-out-right', inClass);
    void inEl.offsetWidth; // restart the animation if it was mid-flight
    inEl.classList.add(inClass);

    // animationend can be skipped entirely if the popup closes mid-swap, so the
    // timeout — not the event — is what clears the busy flag and the clip.
    inEl.addEventListener('animationend', () => inEl.classList.remove(inClass), { once: true });
    _sfIgViewTimers.push(setTimeout(() => {
      inEl.classList.remove(inClass);
      if (_sfIgPendingUnclip) { _sfIgPendingUnclip(); _sfIgPendingUnclip = null; }
      _sfIgViewBusy = false;
    }, PANEL_IN_MS + 40));
  }, PANEL_OUT_MS));
}

function sfOpenSettings() {
  const p = _sfSettingsPanels();
  if (!p) return;
  if (_sfIgViewBusy || document.body.classList.contains('sf-settings-open')) return;

  document.body.classList.add('sf-settings-open');
  if (sfGearBtn) sfGearBtn.setAttribute('aria-expanded', 'true');
  p.settings.setAttribute('aria-hidden', 'false');
  if (sfSettingsBackBtn) sfSettingsBackBtn.removeAttribute('tabindex');

  sfIgSwapPanels(p.sort, p.settings, 'forward');
  if (DBUG) console.log("[Settings] open", _sfSettingsSurface);
}

// `instant: true` skips the animation — used when the popup switches feeds so a
// leftover Settings view never bleeds into the next platform.
function sfCloseSettings(instant) {
  const p = _sfSettingsPanels();
  if (!p) return;

  const wasOpen = document.body.classList.contains('sf-settings-open');
  if (!instant && (_sfIgViewBusy || !wasOpen)) return;

  document.body.classList.remove('sf-settings-open');
  if (sfGearBtn) sfGearBtn.setAttribute('aria-expanded', 'false');
  p.settings.setAttribute('aria-hidden', 'true');
  if (sfSettingsBackBtn) sfSettingsBackBtn.setAttribute('tabindex', '-1');

  if (instant) {
    _sfIgClearViewTimers();
    _sfIgViewBusy = false;
    [p.sort, p.settings].forEach(el => el.classList.remove(
      'sf-panel-out-left', 'sf-panel-out-right', 'sf-panel-in-right', 'sf-panel-in-left'
    ));
    p.settings.style.display = 'none';
    p.sort.style.display = 'flex';
    return;
  }

  sfIgSwapPanels(p.settings, p.sort, 'back');
  if (DBUG) console.log("[Settings] close", _sfSettingsSurface);
}

if (sfGearBtn) sfGearBtn.addEventListener("click", sfOpenSettings);
if (sfSettingsBackBtn) sfSettingsBackBtn.addEventListener("click", () => sfCloseSettings(false));

// Escape backs out of Settings. Runs on the bubble phase and only when nothing
// else is open, so the dropdown/menu Escape handlers keep first claim.
document.addEventListener("keydown", function (e) {
  if (e.key !== 'Escape') return;
  if (!document.body.classList.contains('sf-settings-open')) return;
  if (document.querySelector('.sf-dd-menu.sf-dd-open, .sf-menu:not(.sf-hidden)')) return;
  sfCloseSettings(false);
});

////////////////////////////////////////////////////////////////////////////////
// TikTok Sort clicks by Views, Likes, Shares, Comments, etc.
////////////////////////////////////////////////////////////////////////////////

function handleTikTokSortClick(sort_by) {
  const no_reels_selected_input = document.getElementById("no_reels_selected_tiktok");
  const datesSelected = document.getElementById("dates_selected_tiktok");

  // Outlier scoring runs ONLY when the user sorts by Outlier score — every other
  // sort skips the baseline collection entirely (so badges + the Sort-by/Filters
  // outlier entries appear only on an outlier sort). TikTok has no Actions toggle
  // for this (unlike IG); the sort click is the sole trigger.
  const outlier_scores = sort_by === "outlier";

  if (DBUG) console.log("[TikTok] Sort click:", sort_by, { outlier_scores });

  // item sort
  if (no_reels_selected_input.getAttribute("active") === "on") {
    const item_selection = no_reels_selected_input.value;
    if (DBUG) console.log("[TikTok] Sending items sort", { sort_by, item_selection });
    chrome.runtime.sendMessage({
      refresh: 'ON_TikTok',
      sort_by,
      no_items: item_selection,
      dates_items: 'items',
      outlier_scores
    });
  }

  // date sort
  else if (datesSelected.getAttribute("active") === "on") {
    const item_selection = datesSelected.value;
    if (DBUG) console.log("[TikTok] Sending dates sort", { sort_by, item_selection });
    chrome.tabs.query({ active: true, currentWindow: true }, () => {
      chrome.runtime.sendMessage({
        refresh: 'ON_TikTok',
        sort_by,
        no_items: item_selection,
        dates_items: 'dates',
        outlier_scores
      });
    });
  }
}

document.getElementById("sortViewsClickTikTok")?.addEventListener("click", () => handleTikTokSortClick("views"));
document.getElementById("sortLikesClickTikTok")?.addEventListener("click", () => handleTikTokSortClick("likes"));
document.getElementById("sortCommentsClickTikTok")?.addEventListener("click", () => handleTikTokSortClick("comments"));
document.getElementById("sortOldestClicksTikTok")?.addEventListener("click", () => handleTikTokSortClick("oldest"));
document.getElementById("sortSavesClickTikTok")?.addEventListener("click", () => handleTikTokSortClick("saves"));
document.getElementById("sortSharesClickTikTok")?.addEventListener("click", () => handleTikTokSortClick("shares"));

////////////////////////////////////////////////////////////////////////////////
// Instagram sort by views, comments, etc.
////////////////////////////////////////////////////////////////////////////////

function handleInstagramSortClick(sort_by) {
  const no_reels_selected_input = document.getElementById("no_reels_selected");
  const datesSelected = document.getElementById("dates_selected");

  // Outlier scoring runs ONLY when the user sorts by Outlier score — every other
  // sort skips the baseline collection entirely (so badges + the Sort-by/Filters
  // outlier entries appear only on an outlier sort).
  const outlier_scores = sort_by === "outlier";

  if (DBUG) console.log("[Insta] Sort click:", sort_by, { outlier_scores });

  // item sort
  if (no_reels_selected_input.getAttribute("active") === "on") {
    const item_selection = no_reels_selected_input.value;
    if (DBUG) console.log("[Insta] Sending items sort", { sort_by, item_selection });
    chrome.runtime.sendMessage({
      refresh: 'ON',
      sort_by,
      no_items: item_selection,
      dates_items: 'items',
      outlier_scores
    });
  }

  // date sort
  else if (datesSelected.getAttribute("active") === "on") {
    const item_selection = datesSelected.value;
    if (DBUG) console.log("[Insta] Sending dates sort", { sort_by, item_selection });
    chrome.runtime.sendMessage({
      refresh: 'ON',
      sort_by,
      no_items: item_selection,
      dates_items: 'dates',
      outlier_scores
    });
  }
}

document.getElementById("sortViewsClick")?.addEventListener("click", () => handleInstagramSortClick("views"));
document.getElementById("sortLikesClick")?.addEventListener("click", () => handleInstagramSortClick("likes"));
document.getElementById("sortCommentsClick")?.addEventListener("click", () => handleInstagramSortClick("comments"));
document.getElementById("sortOldestClicks")?.addEventListener("click", () => handleInstagramSortClick("oldest"));

////////////////////////////////////////////////////////////////////////////////
// YouTube sort clicks — Phase 0.5 (gating only)
////////////////////////////////////////////////////////////////////////////////
// Sends refresh:'ON_YouTube'; the content script (YouTube/content.js)
// validates the surface and either shows a popup warning or no-ops on the happy
// path. Outlier score is a real sort (sort_by "outlier", views-based on both
// tabs) — mirrors handleFacebookOutlierClick.

function handleYoutubeSortClick(sort_by) {
  const itemsInput = document.getElementById("no_reels_selected_youtube");
  const datesInput = document.getElementById("dates_selected_youtube");
  const outlier_scores = sort_by === "outlier";

  if (DBUG) console.log("[YouTube] Sort click:", sort_by);

  if (itemsInput && itemsInput.getAttribute("active") === "on") {
    chrome.runtime.sendMessage({
      refresh: 'ON_YouTube',
      sort_by,
      no_items: itemsInput.value,
      dates_items: 'items',
      outlier_scores
    });
  } else if (datesInput && datesInput.getAttribute("active") === "on") {
    chrome.runtime.sendMessage({
      refresh: 'ON_YouTube',
      sort_by,
      no_items: datesInput.value,
      dates_items: 'dates',
      outlier_scores
    });
  }
}

document.getElementById("sortViewsClickYoutube")?.addEventListener("click", () => handleYoutubeSortClick("views"));
document.getElementById("sortLikesClickYoutube")?.addEventListener("click", () => handleYoutubeSortClick("likes"));
document.getElementById("sortOldestClicksYoutube")?.addEventListener("click", () => handleYoutubeSortClick("oldest"));
document.getElementById("sortOutlierClickYoutube")?.addEventListener("click", () => handleYoutubeSortClick("outlier"));

////////////////////////////////////////////////////////////////////////////////
// Facebook sort clicks by Views, Likes, Shares, Comments, Oldest
////////////////////////////////////////////////////////////////////////////////
// Mirrors handleInstagramSortClick / handleTikTokSortClick. The surface error
// gate (reels-tab vs profile vs elsewhere) lives in the content script
// (Facebook/content.js) and bounces back to the popup
// error renderer via `feedrank_error`, exactly like IG/TikTok.

function handleFacebookSortClick(sort_by) {
  const no_reels_selected_input = document.getElementById("no_reels_selected_facebook");
  const datesSelected = document.getElementById("dates_selected_facebook");

  // Outlier scoring runs ONLY when the user sorts by Outlier score — every other
  // sort skips the baseline collection entirely (mirrors handleInstagramSortClick).
  const outlier_scores = sort_by === "outlier";

  if (DBUG) console.log("[Facebook] Sort click:", sort_by, { outlier_scores });

  // item sort
  if (no_reels_selected_input.getAttribute("active") === "on") {
    const item_selection = no_reels_selected_input.value;
    if (DBUG) console.log("[Facebook] Sending items sort", { sort_by, item_selection });
    chrome.runtime.sendMessage({
      refresh: 'ON_Facebook',
      sort_by,
      no_items: item_selection,
      dates_items: 'items',
      outlier_scores
    });
  }

  // date sort (Phase 9) — value is a preset ("1_week"…"all_reels") or "custom_<from>_<to>"
  else if (datesSelected.getAttribute("active") === "on") {
    const date_selection = datesSelected.value;
    if (DBUG) console.log("[Facebook] Sending dates sort", { sort_by, date_selection });
    chrome.runtime.sendMessage({
      refresh: 'ON_Facebook',
      sort_by,
      no_items: date_selection,
      dates_items: 'dates',
      outlier_scores
    });
  }
}

// Facebook Outlier score row → a real sort with sort_by "outlier". The surface
// gate (profile Reels tab only) lives in Facebook/content.js and
// bounces non-profile-Reels surfaces back to the popup with their own toast.
function handleFacebookOutlierClick() {
  handleFacebookSortClick("outlier");
}

document.getElementById("sortViewsClickFacebook")?.addEventListener("click", () => handleFacebookSortClick("views"));
document.getElementById("sortLikesClickFacebook")?.addEventListener("click", () => handleFacebookSortClick("likes"));
document.getElementById("sortSharesClickFacebook")?.addEventListener("click", () => handleFacebookSortClick("shares"));
document.getElementById("sortCommentsClickFacebook")?.addEventListener("click", () => handleFacebookSortClick("comments"));
document.getElementById("sortOldestClicksFacebook")?.addEventListener("click", () => handleFacebookSortClick("oldest"));

////////////////////////////////////////////////////////////////////////////////
// Add Be Back Messsage for TikTok! 
////////////////////////////////////////////////////////////////////////////////

function add_be_back_message() {
  if (DBUG) console.log("[TikTok] add_be_back_message() called");
}

////////////////////////////////////////////////////////////////////////////////
// Handle zero state vs. instagram page vs. tiktok page
////////////////////////////////////////////////////////////////////////////////

// Each *_mode_off() unpoints the gear (closing whatever it had open) so a
// leftover Settings view can never bleed into the next feed or the zero state.
// The incoming *_mode_on() repoints it right after.
function insta_mode_off() {
  let insta_main_div = document.getElementsByClassName('InstaMain')[0];
  if (insta_main_div) insta_main_div.style.display="none";
  sfSetSettingsSurface(null);
  if (DBUG) console.log("[Mode] insta_mode_off");
}

function tiktok_mode_off() {
  let tiktok_main_div = document.getElementsByClassName('TikTokMain')[0];
  if (tiktok_main_div) tiktok_main_div.style.display="none";
  sfSetSettingsSurface(null);
  if (DBUG) console.log("[Mode] tiktok_mode_off");
}

function facebook_mode_off() {
  let facebook_main_div = document.getElementsByClassName('FacebookMain')[0];
  if (facebook_main_div) facebook_main_div.style.display="none";
  sfSetSettingsSurface(null);
  if (DBUG) console.log("[Mode] facebook_mode_off");
}

function youtube_mode_off() {
  let youtube_main_div = document.getElementsByClassName('YouTubeMain')[0];
  if (youtube_main_div) youtube_main_div.style.display="none";
  if (DBUG) console.log("[Mode] youtube_mode_off");
}

function zero_state_off() {
  let zero_state = document.getElementsByClassName('main_nav_div_zero_state')[0];
  if (zero_state) zero_state.style.display="none";
  document.body.classList.remove('sf-zero-state');
  if (DBUG) console.log("[Mode] zero_state_off");
}

// function no_taher_image() {
//   let taher_solo = document.getElementsByClassName('TaherSolo')[0];
//   if (taher_solo) taher_solo.style.display="none";
//   if (DBUG) console.log("[UI] no_taher_image()");
// }

function zero_state_on() {
  insta_mode_off();
  tiktok_mode_off();
  facebook_mode_off();
  youtube_mode_off();

  enableTikTokSection(); // prevents sticky disabled state

  let zero_state = document.getElementsByClassName('main_nav_div_zero_state')[0];
  if (zero_state) zero_state.style.display="flex";
  // Zero-state keeps the original grey footer (just without the Get Pro button);
  // the white-footer treatment is scoped to body:not(.sf-zero-state) in CSS.
  document.body.classList.add('sf-zero-state');
  if (DBUG) console.log("[Mode] zero_state_on");
}

function ensureExitAnimStyle() {
  if (document.getElementById('sf-exit-style')) return;
  const style = document.createElement('style');
  style.id = 'sf-exit-style';
  style.textContent = `
    @keyframes sfExitRight {
      0%   { transform: translateX(0); opacity: 1; filter: none; }
      40%  { transform: translateX(10px); opacity: 0.9; filter: blur(0.3px); }
      100% { transform: translateX(120%); opacity: 0; filter: blur(1px); }
    }
    .sf-exit-right {
      animation: sfExitRight 0.35s cubic-bezier(.22,1,.36,1) forwards;
      will-change: transform, opacity, filter;
    }
  `;
  document.head.appendChild(style);
  if (DBUG) console.log("[Style] ensureExitAnimStyle injected");
}


async function feature_banner(mode) {
  const banner = document.querySelector(".footer_div_again_sub_feature");
  if (!banner) return;

  const hide = () => {
    banner.style.display = "none";
    document.body.classList.remove("sf-feature-banner-open");
  };

  // One announcement only: the Similar accounts note, on the zero state and on Instagram (it replaced the
  // FeedRank note; the strip holds one note at a time). TikTok, YouTube and Facebook
  // show no banner (the player notes that used to live here are retired — user's call 2026-09-24).
  // The note is a Notion-style callout: a wash of the brand yellow, one line ("New:" a step darker than the
  // sentence it leads), and the whole block as the link. It shows to everyone, signed in or not, and opens
  // the docs article for the feature.
  //
  // It disappears in exactly three ways: the user dismisses it (a per-surface localStorage key below, set
  // for good — new keys per note, so a user who closed the MCP note still sees this one), the cutoff date
  // passes, or the popup is on a surface with no entry in `config`.
  // 2026-10-23: the Save library replaces the Similar-accounts note (new keys, so a user who closed that one sees this).
  const SAVE_NOTE = {
    lead: "New:",
    text: " Save and organize posts",
    url: "https://buymeatea.in/bytanmay",
    cutoff: "2027-01-31"
  };
  const config = {
    zero: { ...SAVE_NOTE, key: "bannerClosed_zero_save_v1" },
    insta: { ...SAVE_NOTE, key: "bannerClosed_instagram_save_v1" }
  };

  const c = config[mode];
  if (!c) return hide();

  let closeIcon = banner.querySelector(".close_banner_icon");
  const textEl = banner.querySelector(".footer_text_again_subheader_sub_bottom");
  if (!closeIcon || !textEl) return;

  // The \u00d7 ships as a PNG, which can't be recoloured, and the note wants it in the
  // same dark yellow as the info icon. Swap it once for a span that paints the
  // glyph through a mask (same class, so the CSS and the handler below don't care
  // which one they got). The pill on hover lives on the box, not the glyph.
  if (closeIcon.tagName === "IMG") {
    const box = document.createElement("span");
    box.className = "close_banner_icon sf-note-close";
    box.setAttribute("role", "button");
    box.setAttribute("aria-label", "Dismiss");
    box.tabIndex = 0;
    const glyph = document.createElement("span");
    glyph.className = "sf-note-close-ic";
    glyph.setAttribute("aria-hidden", "true");
    box.appendChild(glyph);
    box.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        box.click();
      }
    });
    closeIcon.replaceWith(box);
    closeIcon = box;
  }

  const cutoff = new Date(c.cutoff);
  const today = new Date();
  const isClosed = localStorage.getItem(c.key) === "true";
  if (isClosed || today >= cutoff) return hide();

  // show + build the note (DOM calls, no HTML strings; the link is a real anchor)
  banner.style.display = "";
  document.body.classList.add("sf-feature-banner-open");
  banner.classList.add("sf-banner--note");
  textEl.textContent = "";

  // The whole note is the link (Notion's announcement callout): the sentence is
  // the anchor text and a stretched ::after covers the block, so a click
  // anywhere on it opens the page. One line, so nothing wraps out of alignment.
  // The close icon sits above that layer and keeps its own click.
  // aria-label says where the link leads, since the sentence alone doesn't.
  const link = document.createElement("a");
  link.className = "sf-note-link";
  link.href = c.url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.setAttribute("aria-label", c.lead + c.text + " \u2014 learn more");

  const lead = document.createElement("span");
  lead.className = "sf-note-lead";
  lead.textContent = c.lead;

  link.append(lead, document.createTextNode(c.text));
  textEl.appendChild(link);

  // close handler (per-mode key) — the same slide-out as before
  const boundKey = `bound_${mode}`;
  if (!banner.dataset[boundKey]) {
    banner.dataset[boundKey] = "1";

    closeIcon.addEventListener("click", () => {
      localStorage.setItem(c.key, "true");
      ensureExitAnimStyle();
      // Drop the entrance animation first: both set `animation` on the same
      // element, and leaving it on would make the slide-out depend on which
      // stylesheet happens to come last.
      banner.classList.remove("sf-fade-banner");
      banner.classList.add("sf-exit-right");

      const done = () => {
        banner.style.display = "none";
        banner.classList.remove("sf-exit-right");
        document.body.classList.remove("sf-feature-banner-open");
      };

      banner.addEventListener("animationend", done, { once: true });
      setTimeout(done, 600);
    });
  }
}

function disableTikTokSection() {
  const tiktokMain = document.querySelector(".TikTokMain");
  // if (!tiktokMain) return;
  // tiktokMain.classList.add("sf-section-disabled");
}

function enableTikTokSection() {
  const tiktokMain = document.querySelector(".TikTokMain");
  if (!tiktokMain) return;
  tiktokMain.classList.remove("sf-section-disabled");
}

function insta_mode_on() {
  zero_state_off();
  tiktok_mode_off();
  facebook_mode_off();
  youtube_mode_off();

  enableTikTokSection(); // prevents sticky disabled state for tiktok

  // feature_banner("insta"); // shows the feature update banner notificaiton
  default_sort_selection();
  let insta_main_div = document.getElementsByClassName('InstaMain')[0];
  if (insta_main_div) insta_main_div.style.display="flex";

  // Settings is a detour, not a tab — always land on Sort and show the gear.
  sfSetSettingsSurface('ig');

  _sfSuppressSlide = true;
  try {
    if (localStorage.getItem('sf_ig_sub_tab') === 'date') dateRangeButton.click();
  } finally {
    _sfSuppressSlide = false;
  }

  if (DBUG) console.log("[Mode] insta_mode_on");
}


function showTikTokDowntimeBanner() {
  const el = document.querySelector(".footer_div_again_sub_feature");
  if (!el) return;

  // show banner
  el.style.display = "flex";

  // reuse your REAL banner structure
  el.innerHTML = `
    <div class="footer_text_with_icon">

      <!-- intentionally no starsIcon -->
      <p class="footer_text_again_subheader_sub_bottom">
        Seeing "Something went wrong" after heavy sorting? Clearing TikTok site data usually fixes it.
      </p>

      <!-- intentionally no close button -->
      <img src="Icons/close_banner.png" class="close_banner_icon" alt="Close" />

    </div>
  `;
}


function setTikTokDefaults() {
  // make "items" active by default in TikTok UI
  const items = document.getElementById("no_reels_selected_tiktok");
  const dates = document.getElementById("dates_selected_tiktok");
  if (items) items.setAttribute("active", "on");
  if (dates) dates.setAttribute("active", "off");

  // show items dropdown, hide dates dropdown
  if (items) items.style.display = "flex";
  if (dates) dates.style.display = "none";
}

function tiktok_mode_on() {
  zero_state_off();
  insta_mode_off();
  facebook_mode_off();
  youtube_mode_off();

  // ✅ show TikTok section
  const tiktok_main_div = document.getElementsByClassName("TikTokMain")[0];
  if (tiktok_main_div) tiktok_main_div.style.display = "flex";

  // ✅ set a sane TikTok default (instead of default_sort_selection())
  default_sort_selection();

  // Settings is a detour, not a tab — always land on Sort and show the gear.
  sfSetSettingsSurface('tt');

  _sfSuppressSlide = true;
  try {
    if (localStorage.getItem('sf_tt_sub_tab') === 'date') dateRangeButtonTikTok.click();
  } finally {
    _sfSuppressSlide = false;
  }

  const ttWarning = document.getElementById("tiktokItemsWarning");
  if (ttWarning) ttWarning.style.display = 'none';
  // setTikTokDefaults();

  // ✅ show your "tiktok is upgrading" banner + disable clicks
  // showTikTokDowntimeBanner();
  // disableTikTokSection();

  if (DBUG) console.log("[Mode] tiktok_mode_on (disabled)");
}

function facebook_mode_on() {
  zero_state_off();
  insta_mode_off();
  tiktok_mode_off();
  youtube_mode_off();

  enableTikTokSection(); // prevents sticky disabled state for tiktok

  default_sort_selection();
  let facebook_main_div = document.getElementsByClassName('FacebookMain')[0];
  if (facebook_main_div) facebook_main_div.style.display="flex";

  // Settings is a detour, not a tab — always land on Sort and show the gear.
  sfSetSettingsSurface('fb');

  _sfSuppressSlide = true;
  try {
    if (localStorage.getItem('sf_fb_sub_tab') === 'date') dateRangeButtonFacebook.click();
  } finally {
    _sfSuppressSlide = false;
  }

  if (DBUG) console.log("[Mode] facebook_mode_on");
}

// YouTube popup — preview only. Renders the IG-style UI but is fully INERT:
// no sort-button wiring, so clicking Likes/Views/Outlier/Oldest triggers nothing
// (no content or background scripts). Only local UI (tabs, dropdowns, tooltips)
// is interactive, exactly like the IG popup.
function youtube_mode_on() {
  zero_state_off();
  insta_mode_off();
  tiktok_mode_off();
  facebook_mode_off();

  enableTikTokSection(); // prevents sticky disabled state for tiktok

  default_sort_selection();
  let youtube_main_div = document.getElementsByClassName('YouTubeMain')[0];
  if (youtube_main_div) youtube_main_div.style.display="flex";

  _sfSuppressSlide = true;
  try {
    if (localStorage.getItem('sf_yt_sub_tab') === 'date') dateRangeButtonYoutube.click();
  } finally {
    _sfSuppressSlide = false;
  }

  if (DBUG) console.log("[Mode] youtube_mode_on");
}

// function tiktok_mode_on() {
//   zero_state_off();
//   insta_mode_off();

//   // feature_banner("tiktok"); // shows the feature update banner notificaiton 
//   default_sort_selection(); 
//   let tiktok_main_div = document.getElementsByClassName('TikTokMain')[0];
//   if (tiktok_main_div) tiktok_main_div.style.display="flex";
//   if (DBUG) console.log("[Mode] tiktok_mode_on");
// }

////////////////////////////////////////////////////////////////////////////////
// instagram vs. tiktok click on zero state
////////////////////////////////////////////////////////////////////////////////

document.getElementById("instaButton")?.addEventListener("click", function () {
  if (DBUG) console.log("[Zero] Instagram button clicked");
  chrome.tabs.query({active: true, currentWindow: true}, function(tabs){
    chrome.runtime.sendMessage({zero_state : 'instagram'});
  });
});

document.getElementById("tiktokButton")?.addEventListener("click", function () {
  if (DBUG) console.log("[Zero] TikTok button clicked");
  chrome.tabs.query({active: true, currentWindow: true}, function(tabs){
    chrome.runtime.sendMessage({zero_state : 'tiktok'});
  });
});

document.getElementById("facebookButton")?.addEventListener("click", function () {
  if (DBUG) console.log("[Zero] Facebook button clicked");
  chrome.tabs.query({active: true, currentWindow: true}, function(tabs){
    chrome.runtime.sendMessage({zero_state : 'facebook'});
  });
});

document.getElementById("youtubeButton")?.addEventListener("click", function () {
  if (DBUG) console.log("[Zero] YouTube button clicked");
  chrome.tabs.query({active: true, currentWindow: true}, function(tabs){
    chrome.runtime.sendMessage({zero_state : 'youtube'});
  });
});


////////////////////////////////////////////////////////////////////////////////
// handle clicking on the menu button
////////////////////////////////////////////////////////////////////////////////

// Every footer (signed-out, free, pro) carries the same ••• trigger, but there
// is only ONE #footerMenu in the document — on open it gets reparented under the
// trigger that was clicked, so .sf-menu's absolute positioning anchors to the
// right dots and the three links keep a single source of truth. Only one footer
// is ever visible at a time, so the menu can only be in one place that matters.
document.addEventListener('DOMContentLoaded', () => {
  const menu = document.getElementById('footerMenu')
  const triggers = Array.prototype.slice.call(document.querySelectorAll('.footer-menu-trigger'))

  if (!menu || !triggers.length) return

  let activeTrigger = null

  // Lifts the host footer above the sort panel so the upward-opening menu (and
  // the Account tooltip) aren't stacked underneath it.
  const liftFooter = (el) => {
    const footer = el && el.closest('.footer_div_again_sub')
    if (footer) footer.classList.add('sf-footer-active')
  }

  const dropFooters = () => {
    document.querySelectorAll('.footer_div_again_sub.sf-footer-active')
      .forEach((f) => f.classList.remove('sf-footer-active'))
  }

  const openMenu = (trigger) => {
    const anchor = trigger.closest('.footer-icons-left')
    if (anchor && menu.parentElement !== anchor) anchor.appendChild(menu)

    activeTrigger = trigger
    menu.classList.remove('sf-hidden')
    menu.setAttribute('aria-hidden', 'false')
    triggers.forEach((t) => t.setAttribute('aria-expanded', String(t === trigger)))
    liftFooter(trigger)
  }

  const closeMenu = () => {
    menu.classList.add('sf-hidden')
    menu.setAttribute('aria-hidden', 'true')
    triggers.forEach((t) => t.setAttribute('aria-expanded', 'false'))
    dropFooters()
    activeTrigger = null
  }

  // Toggle on button click
  triggers.forEach((trigger) => {
    trigger.addEventListener('click', (e) => {
      e.stopPropagation()
      const isOpenHere = !menu.classList.contains('sf-hidden') && activeTrigger === trigger
      if (isOpenHere) closeMenu()
      else openMenu(trigger)
    })
  })

  // Click outside closes
  document.addEventListener('click', () => closeMenu())

  // Clicking inside menu shouldn't close
  menu.addEventListener('click', (e) => e.stopPropagation())

  // ESC closes
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenu()
  })

  // Optional: close when a menu item is clicked
  menu.querySelectorAll('a').forEach((a) => {
    a.addEventListener('click', () => closeMenu())
  })

  // Boost footer z-index on Account icon hover (for tooltip)
  const accountLinks = document.querySelectorAll('.footer-icons-right .footer-icon-link');
  accountLinks.forEach((link) => {
    link.addEventListener('mouseenter', () => liftFooter(link));
    link.addEventListener('mouseleave', () => {
      // Only drop if the menu isn't holding the footer up
      if (menu.classList.contains('sf-hidden')) dropFooters();
    });
  });
})


////////////////////////////////////////////////////////////////////////////////
// popup warning toast (shared)
////////////////////////////////////////////////////////////////////////////////

const SF_WARN_DWELL_MS = 3500;     // a warning wants a beat to be read
const SF_RESORT_DWELL_MS = 2000;   // a confirmation should land and get out of the way
const SF_WARN_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
const SF_NUDGE_EASE = 'cubic-bezier(0.34, 1.56, 0.64, 1)';

// The rise-and-blur exit, shared by every popup banner. Injected once.
function _sfInjectBannerExitStyle() {
  if (document.getElementById('sf-exit-style')) return;
  const style = document.createElement('style');
  style.id = 'sf-exit-style';
  style.textContent = `
    @keyframes sfExitUp {
      0%   { transform: translateY(0); opacity: 1; filter: none; }
      40%  { transform: translateY(-6px); opacity: 0.9; filter: blur(0.3px); }
      100% { transform: translateY(-120%); opacity: 0; filter: blur(1px); }
    }
    .sf-exit-up {
      animation: sfExitUp 0.35s cubic-bezier(.22,1,.36,1) forwards;
      will-change: transform, opacity, filter;
    }
  `;
  document.head.appendChild(style);
}

// Start (or restart) the auto-close countdown. Restartable is the point: a
// banner that gets a new message deserves a full dwell for the new text, not
// whatever was left of the old one's.
function _sfArmBannerDismiss(el, dwellMs) {
  clearTimeout(el._sfCloseTimer);
  el._sfCloseTimer = setTimeout(() => {
    _sfInjectBannerExitStyle();
    el.classList.remove('animate__bounceInRight');
    el.classList.add('sf-exit-up');
    // Not { once: true }: animationend BUBBLES, so a child's animation would
    // consume a one-shot listener and the banner would never be removed.
    el._sfExitHandler = (e) => {
      if (e.target !== el) return;
      el.removeEventListener('animationend', el._sfExitHandler);
      el.remove();
    };
    el.addEventListener('animationend', el._sfExitHandler);
    if (DBUG) console.log("[Popup Banner] auto-closed:", el.id);
  }, dwellMs);
}

// Drop a banner of the OTHER family (a warning superseding a confirmation, or
// vice versa). Kills its pending dismissal too, so a timer from the banner just
// removed can't fire against a detached element.
function _sfRemoveBanner(el) {
  if (!el) return;
  clearTimeout(el._sfCloseTimer);
  el.remove();
}

// Called when a new message lands on a banner that's already flying away — the
// ~350ms window between the dwell expiring and the element being removed.
function _sfCancelBannerExit(el) {
  if (el._sfExitHandler) {
    el.removeEventListener('animationend', el._sfExitHandler);
    el._sfExitHandler = null;
  }
  el.classList.remove('sf-exit-up');
}

// Swap the message inside a banner that's already on screen. Deliberately NOT a
// dismiss-then-reopen: the banner holds its position and only the line of text
// crossfades, which is the same vertical wipe the in-page sort banners use
// (_sfSetBannerMsg). It also sidesteps re-running animate__bounceInRight, which
// opens at translate3d(3000px,0,0) — the popup's standing overflow hazard.
// `selector` picks the element holding the words — `.warning_text` for a
// warning, `.sf-resort-label` for a confirmation (whose <p> also holds the tick
// icon, so the label is wrapped separately and the tick stays put).
function _sfSwapBannerText(el, text, selector) {
  const p = el.querySelector(selector);
  if (!p) return;

  // Same message again — re-picking "Comments" when it's already sorted by
  // comments, or clicking a broken option twice. Crossfading text to identical
  // text reads as a glitch, so nudge instead: enough to say "yes, heard you,
  // still that" without pretending something changed.
  if ((p.textContent || '').trim() === text.trim()) {
    el.classList.remove('animate__animated', 'animate__bounceInRight');
    el.animate(
      [{ transform: 'translateY(0)' }, { transform: 'translateY(-3px)' }, { transform: 'translateY(0)' }],
      { duration: 200, easing: SF_NUDGE_EASE }
    );
    return;
  }

  // A third click mid-swap must re-target, not stack. cancel() fires oncancel
  // rather than onfinish, so the superseded swap simply never sets its text.
  p.getAnimations().forEach((a) => a.cancel());
  p.animate(
    [{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(-4px)' }],
    { duration: 120, easing: SF_WARN_EASE, fill: 'forwards' }
  ).onfinish = () => {
    p.textContent = text;
    p.animate(
      [{ opacity: 0, transform: 'translateY(5px)' }, { opacity: 1, transform: 'translateY(0)' }],
      { duration: 180, easing: SF_WARN_EASE, fill: 'forwards' }
    );
  };
}

// Red slide-in banner at the top of the popup. Used by the sort-error listener

//
// A second warning arriving while one is up REPLACES it in place, immediately.
// It used to no-op — so after any error the popup ignored the next one for
// ~3.9s (3.5s dwell + exit), and clicking a different broken option felt like
// the extension had hung. showPopupResorted always had this behaviour; the
// warning banner is now consistent with it.
function showPopupWarning(error_text) {
  const chromeEl = document.getElementsByClassName("main_div")[0];
  if (!chromeEl) return;

  // A "Re-sorted" confirmation may still be on screen from a previous click.
  // Both are absolutely positioned at the top, so leaving it would stack the two
  // on top of each other — and a warning always supersedes a confirmation.
  // showPopupResorted does the mirror of this.
  _sfRemoveBanner(document.getElementById('resort_message'));

  const existing = document.getElementById('error_message');
  if (existing) {
    _sfCancelBannerExit(existing);
    _sfSwapBannerText(existing, error_text, '.warning_text');
    _sfArmBannerDismiss(existing, SF_WARN_DWELL_MS);
    return;
  }

  const chrome_div = document.createElement('div');
  chrome_div.className = 'warning_message animate__animated animate__bounceInRight';
  chrome_div.style.cssText = `
    z-index: 100;
    position: absolute;
    width: 100%;
    background-color: #fbe8ea;
    padding: 0 16px;
    box-sizing: border-box;
  `;
  // AFTER cssText — assigning cssText replaces the whole style attribute, so
  // setting this first silently dropped it and animate.css fell back to its 1s
  // default. That ordering bug is why the entrance used to take 1s despite
  // asking for .5s (see the note on showPopupResorted, which had it right).
  chrome_div.style.setProperty('--animate-duration', '.5s');
  chrome_div.id = 'error_message';
  chrome_div.innerHTML = `
    <p class="warning_text">
      ${error_text}
    </p>
  `;
  chromeEl.insertBefore(chrome_div, chromeEl.firstChild);

  _sfArmBannerDismiss(chrome_div, SF_WARN_DWELL_MS);
}

////////////////////////////////////////////////////////////////////////////////
// Back-to-back sorting — the "Re-sorted" confirmation
////////////////////////////////////////////////////////////////////////////////
// A second sort re-shuffles the grid in place instead of reloading the page. The
// reload used to BE the confirmation, so without this the click looks like it
// did nothing — especially when re-picking a sort that only moves a few tiles.
//
// Shares the geometry, entrance and exit of showPopupWarning; only the palette
// and the 2s dwell differ (this is an acknowledgement, not something to read).
// Injected into .main_div like its siblings — animate__bounceInRight opens at
// translate3d(3000px,0,0), and only that element's position:relative +
// overflow-x:clip stops the popup from being permanently widened by it.

function _sfResortedMessage(message) {
  // Lower-cased so it reads as prose mid-sentence — except "TikTok(s)", which is
  // a proper noun and is capitalised everywhere else in the product.
  const rawNoun = message.noun || "Posts";
  const noun = /^tiktoks?$/i.test(rawNoun) ? rawNoun : rawNoun.toLowerCase();
  // The set changed, not just its order — say so, since the count on screen moved.
  if (message.selection_changed) {
    return `Re-sorted — showing ${message.count} ${noun}`;
  }
  const by = {
    views: "views",
    likes: "likes",
    comments: "comments",
    // TikTok-only sorts — without these a shares/saves re-sort read a bare
    // "Re-sorted", which reads like the sort didn't take.
    shares: "shares",
    saves: "saves",
    oldest: "oldest first",
    outlier: "outlier score",
  }[message.sort_by];
  return by ? `Re-sorted by ${by}` : "Re-sorted";
}

function showPopupResorted(text) {
  const chromeEl = document.getElementsByClassName("main_div")[0];
  if (!chromeEl) return;

  // One banner at a time — a stale warning must not sit above the confirmation.
  _sfRemoveBanner(document.getElementById('error_message') || document.getElementById('success_message'));

  // Already confirming? Reuse it rather than tearing it down and rebuilding.
  // Re-picking the SAME sort back to back gives the same sentence, so this is
  // usually the nudge branch — the little bounce is the whole acknowledgement,
  // since the grid itself may not visibly change when the order is unchanged.
  // Rebuilding instead would re-run animate__bounceInRight (opens at
  // translate3d(3000px,0,0)) and read as a flash rather than a reply.
  const prior = document.getElementById('resort_message');
  if (prior) {
    _sfCancelBannerExit(prior);
    _sfSwapBannerText(prior, text, '.sf-resort-label');
    _sfArmBannerDismiss(prior, SF_RESORT_DWELL_MS);
    return;
  }

  const chrome_div = document.createElement('div');
  chrome_div.className = 'sf-resort_message animate__animated animate__bounceInRight';
  // z-index above every header control (gear, Free/Pro tag) so the banner covers
  // them outright rather than sharing the space.
  chrome_div.style.cssText = `
    z-index: 1000;
    position: absolute;
    width: 100%;
    padding: 0 16px;
    box-sizing: border-box;
  `;
  // Snappier than the error banner on purpose: a confirmation should land and
  // get out of the way, where a warning wants a beat to be noticed.
  //
  // Set AFTER cssText — assigning cssText replaces the whole style attribute, so
  // setting the custom property first silently drops it and animate.css falls
  // back to its 1s default. That's exactly why the error banner runs at 1s
  // despite asking for .5s; don't copy that ordering.
  chrome_div.style.setProperty('--animate-duration', '.3s');
  chrome_div.id = 'resort_message';
  // The label is wrapped so a later swap can replace the words without
  // disturbing the tick beside them.
  chrome_div.innerHTML = `
    <p class="sf-resort_text">
      <span class="sf-resort-ic" aria-hidden="true"></span>
      <span class="sf-resort-label"></span>
    </p>
  `;
  chrome_div.querySelector('.sf-resort-label').textContent = text;
  chromeEl.insertBefore(chrome_div, chromeEl.firstChild);

  _sfArmBannerDismiss(chrome_div, SF_RESORT_DWELL_MS);
}

// Kill switch for the confirmation. A warm re-sort never reloads the page, so
// without this the click has no acknowledgement in the popup at all.
const SF_RESORT_TOAST = true;

chrome.runtime.onMessage.addListener((message) => {
  if (!SF_RESORT_TOAST) return;
  if (!message || !message.feedrank_resorted) return;
  const text = _sfResortedMessage(message);
  if (DBUG) console.log("[Re-sort] confirmation:", text, message);
  showPopupResorted(text);
});

////////////////////////////////////////////////////////////////////////////////
// Outlier score — preview UI (gated by `outlierFlag`, IG only)
////////////////////////////////////////////////////////////////////////////////

// True only on an Instagram Explore *search* results page
// (/explore/search/...?q=...). Mirrors is_explore_search_url in the IG content
// script so the popup can gate the Outlier preview without a round-trip.
function _sfIsExploreSearchUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname !== "www.instagram.com") return false;
    if (!/^\/explore\/search\//.test(u.pathname)) return false;
    const q = new URLSearchParams(u.search).get("q");
    return !!(q && q.trim().length > 0);
  } catch (e) {
    return false;
  }
}

// Search → "profile only" warning (fast path, no round-trip); everywhere else
// → a real sort with sort_by "outlier". The content script's error gating
// rejects non-profile surfaces with their own toasts.
function handleInstagramOutlierClick() {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    const url = (tabs && tabs[0] && tabs[0].url) || "";
    if (DBUG) console.log("[Outlier] click — url:", url);

    if (_sfIsExploreSearchUrl(url)) {
      showPopupWarning("Outlier score only works on profile sorting");
      return;
    }

    handleInstagramSortClick("outlier");
  });
}

// True only on a TikTok *search* results page (/search[/video|/photo]?q=...).
// Mirrors is_tt_search_url in the TikTok content script so the popup can warn
// on search without a round-trip (same fast path as _sfIsExploreSearchUrl).
function _sfIsTikTokSearchUrl(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)tiktok\.com$/.test(u.hostname)) return false;
    if (!/^\/search(\/(video|photo))?\/?$/.test(u.pathname)) return false;
    const q = new URLSearchParams(u.search).get("q");
    return !!(q && q.trim().length > 0);
  } catch (e) {
    return false;
  }
}

// TikTok Outlier row → a real sort with sort_by "outlier" (profile Videos only).
// Search → fast "profile only" warning (no round-trip); every other non-profile
// surface is rejected by the content-script gate (outlier_go_to_profiles).
// Mirrors handleInstagramOutlierClick.
function handleTikTokOutlierClick() {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    const url = (tabs && tabs[0] && tabs[0].url) || "";
    if (DBUG) console.log("[Outlier][TikTok] click — url:", url);

    if (_sfIsTikTokSearchUrl(url)) {
      showPopupWarning("Outlier score only works on profile sorting");
      return;
    }

    handleTikTokSortClick("outlier");
  });
}

// Reveal the Outlier row + wire it up when the flag is on.
function initOutlierPreviewUI() {
  if (!outlierFlag) return;

  const instaMain = document.getElementsByClassName('InstaMain')[0];
  if (instaMain) instaMain.classList.add('sf-outlier-on');

  const outlierBtn = document.getElementById('sortOutlierClick');
  if (outlierBtn) outlierBtn.addEventListener('click', handleInstagramOutlierClick);

  // The ⓘ is informational — clicking it shows the tooltip, never the row action.
  const info = outlierBtn && outlierBtn.querySelector('.sf-outlier-info');
  if (info) info.addEventListener('click', (e) => e.stopPropagation());

  // TikTok: reveal the Outlier row AND wire it to a real profile-Videos sort
  // (scored on views). The content script's error gating rejects non-profile
  // surfaces with their own toasts.
  const tiktokMain = document.getElementsByClassName('TikTokMain')[0];
  if (tiktokMain) tiktokMain.classList.add('sf-outlier-on');

  const outlierBtnTk = document.getElementById('sortOutlierClickTikTok');
  if (outlierBtnTk) outlierBtnTk.addEventListener('click', handleTikTokOutlierClick);
  const infoTk = outlierBtnTk && outlierBtnTk.querySelector('.sf-outlier-info');
  if (infoTk) infoTk.addEventListener('click', (e) => e.stopPropagation());

  // Facebook: reveal the Outlier row AND wire it to a real Outlier-score sort
  // (profile Reels tab only; the content-script gate rejects other surfaces).
  const facebookMain = document.getElementsByClassName('FacebookMain')[0];
  if (facebookMain) facebookMain.classList.add('sf-outlier-on');

  const outlierBtnFb = document.getElementById('sortOutlierClickFacebook');
  if (outlierBtnFb) outlierBtnFb.addEventListener('click', handleFacebookOutlierClick);
  const infoFb = outlierBtnFb && outlierBtnFb.querySelector('.sf-outlier-info');
  if (infoFb) infoFb.addEventListener('click', (e) => e.stopPropagation());

  // YouTube: reveal the Outlier row for visual parity with IG. The YouTube popup
  // is a pure preview, so the row is intentionally NOT wired to any handler —
  // clicking it triggers nothing (no content/background scripts). The ⓘ tooltip
  // works via CSS hover/focus, no JS needed.
  const youtubeMain = document.getElementsByClassName('YouTubeMain')[0];
  if (youtubeMain) youtubeMain.classList.add('sf-outlier-on');

  if (DBUG) console.log("[Outlier] preview UI initialized");
}

////////////////////////////////////////////////////////////////////////////////
// handel error messages
////////////////////////////////////////////////////////////////////////////////

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.feedrank_error) {
    let error_text = "";

    // 'back_to_back_sorting' is fully retired (2026-08-14). A second sort is now
    // either served in place from the already-collected items or falls through to
    // an ordinary reload, on all four platforms — and TikTok, the last sender,
    // stopped using it for the in-flight case too: interrupting a running sort
    // there now reloads and starts over, like everywhere else.
    //
    // Nothing in the extension sends this any more. The branch is kept purely as
    // a fallback, because an unknown error_type renders as an EMPTY red banner —
    // which is what happened when the string was deleted early during the
    // Instagram port. Harmless to remove once you're sure nothing sends it.
    if (message.error_type === 'back_to_back_sorting') {
      error_text = "Back-to-back sorting isn't supported yet — refresh the page to start a new sort";
    } else if (message.error_type === 'post_views') {
      error_text = "Views aren't tracked on Posts — go to the Reels tab to sort by views";
    } else if (message.error_type === 'no_posts_reels') {
      error_text = "Profile sorting works on Posts, Reels, and Saved tabs only";
    } else if (message.error_type === 'profile_pages') {
      error_text = "Go to Profiles, Search or Saved to start sorting";
    } else if (message.error_type === 'explore_views_unsupported') {
      error_text = "Views aren't tracked on Search — sort by likes, comments, or oldest instead";
    } else if (message.error_type === 'explore_all_unsupported') {
      error_text = "Search sorting isn't available for All Posts — try selecting specific number of Posts instead";
    } else if (message.error_type === 'explore_dates_unsupported') {
      error_text = "Date filters aren't available on Search — try Posts filters instead";
    } else if (message.error_type === 'saved_root_unsupported') {
      error_text = "Go to All Posts or a Collection to sort on Saved";
    } else if (message.error_type === 'saved_all_posts_comments_unsupported') {
      error_text = "Comments & views aren't tracked for all posts in Saved — sort by likes or oldest instead";
    } else if (message.error_type === 'saved_all_posts_views_unsupported') {
      error_text = "Views & comments aren't tracked for all posts in Saved — sort by likes or oldest instead";
    } else if (message.error_type === 'saved_collection_views_unsupported') {
      error_text = "Views aren't tracked for collections in Saved — sort by likes, comments or oldest instead";
    } else if (message.error_type === 'saved_dates_unsupported') {
      error_text = "Date filters aren't available on Saved — try Posts filters instead";
    } else if (message.error_type === 'latest_tab_tiktok') {
      error_text = "Profile sorting only works on the Latest tab — switch to Latest to sort";
    } else if (message.error_type === 'video_tab_tiktok') {
      error_text = "Profile sorting works on Videos, Favorites, Collection & Liked tabs only";
    } else if (message.error_type === 'dates_go_to_profiles') {
      error_text = "Go to Profiles to filter by date and start sorting";
    } else if (message.error_type === 'profile_page_tiktok') {
      error_text = "Go to Profiles, Search, Favorites or Liked to start sorting";
    } else if (message.error_type === 'tiktok_select_collection') {
      error_text = "Select an individual collection to sort";
    } else if (message.error_type === 'tiktok_fav_unsupported') {
      error_text = "Favourite sorting works on Posts & Collections only";
    } else if (message.error_type === 'tiktok_saved_dates_unsupported') {
      error_text = `Date filters aren't available on ${message.surface_label || 'this tab'} — try TikToks filter instead`;
    } else if (message.error_type === 'search_dates_unsupported_tiktok') {
      error_text = `Date filters aren't available on ${message.surface_label || 'Search'} — try TikToks filter instead`;
    } else if (message.error_type === 'search_all_unsupported_tiktok') {
      error_text = "Search sorting isn't available for All TikToks — try selecting specific number of TikToks instead";
    } else if (message.error_type === 'search_unsupported_tab_tiktok') {
      error_text = "Switch to the Top, Videos, or Photo tab to sort Search";
    } else if (message.error_type === 'outlier_go_to_profiles') {
      error_text = "Go to profiles to use outlier score sorting";
    } else if (message.error_type === 'outlier_posts_reels_tabs_only') {
      error_text = "Outlier score sorting works on Posts and Reels tabs only";
    } else if (message.error_type === 'outlier_videos_tab_only') {
      error_text = "Outlier score sorting works on the Videos tab only";
    } else if (message.error_type === 'fb_go_to_profiles') {
      error_text = "Go to Profiles to start sorting";
    } else if (message.error_type === 'fb_reels_only') {
      error_text = "Profile sorting works on the Reels tabs only";
    } else if (message.error_type === 'fb_saved_dates_unsupported') {
      error_text = `Sorting on ${message.surface_label || 'saved reels'} doesn't support date filters — Switch to posts filters instead`;
    } else if (message.error_type === 'fb_outlier_reels_only') {
      error_text = "Outlier score sorting works on the profile Reels tab only";
    } else if (message.error_type === 'yt_go_to_profiles') {
      error_text = "Go to Profiles start sorting";
    } else if (message.error_type === 'yt_videos_shorts_only') {
      error_text = "Profile sorting works on Videos and Shorts tabs only";
    } else if (message.error_type === 'yt_latest_only') {
      error_text = "Profile sorting only works on the Latest tab — switch to Latest to sort";
    }

    if (DBUG) console.warn("[Error Banner] showing:", { type: message.error_type, text: error_text });

    showPopupWarning(error_text);
  }
});

////////////////////////////////////////////////////////////////////////////////
// handle loading state 
////////////////////////////////////////////////////////////////////////////////

// (Only debug scaffolding — real loading UI handled elsewhere)
if (DBUG) console.log("[Init] Popup script loaded with DBUG on:", DBUG);

////////////////////////////////////////////////////////////////////////////////
// save last selection on IG or TikTok
////////////////////////////////////////////////////////////////////////////////
// change default selection if local storage is present 
////////////////////////////////////////////////////////////////////////////////

function default_sort_selection() {

  // Helper: sync custom dropdown UI to match the persisted value.
  // For values not in the static option list (e.g. legacy 500_reels / 2000_reels
  // or any saved Custom value), inject a dynamic Custom option and route to the
  // Custom row. Returns true if applied.
  function syncCustomDropdown(ddId, selectId, persistedVal) {
    const dd = document.getElementById(ddId);
    const sel = document.getElementById(selectId);
    if (!dd || !sel) return false;
    const val = persistedVal != null ? persistedVal : sel.value;
    const matchingOpt = dd.querySelector(`.sf-dd-opt[data-value="${val}"]`);

    if (matchingOpt && !matchingOpt.classList.contains("sf-dd-opt-custom")) {
      sel.value = val;
      // update label
      const labelText = matchingOpt.querySelector("span:first-child")?.textContent || matchingOpt.childNodes[0]?.textContent?.trim();
      if (labelText) dd.querySelector(".sf-dd-label").textContent = labelText;
      // update selected highlight
      dd.querySelectorAll(".sf-dd-opt").forEach(o => o.classList.remove("sf-dd-selected"));
      matchingOpt.classList.add("sf-dd-selected");
      return true;
    }

    // Custom date range — `custom_<fromMs>_<toMs>`
    if (typeof val === "string" && val.startsWith("custom_")) {
      const dm = /^custom_(\d+)_(\d+)$/.exec(val);
      if (!dm) return false;
      const fromMs = parseInt(dm[1], 10);
      const toMs   = parseInt(dm[2], 10);
      if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return false;
      const label = (typeof sfFormatDateRange === "function")
        ? sfFormatDateRange(fromMs, toMs)
        : `${fromMs}–${toMs}`;
      if (typeof sf_set_custom_select_value_raw === "function") {
        sf_set_custom_select_value_raw(sel, val, label);
      }
      const labelEl = dd.querySelector(".sf-dd-label");
      if (labelEl) labelEl.textContent = label;
      if (typeof sf_mark_custom_row_selected === "function") {
        sf_mark_custom_row_selected(dd, label);
      }
      return true;
    }

    // Not in static set → treat as Custom items (covers legacy 500/2K + saved customs).
    const m = /^(\d+)_reels$/.exec(val || "");
    if (!m) return false;
    const n = parseInt(m[1], 10);
    if (!Number.isFinite(n) || n < 1 || n > 10000) return false;

    if (typeof sf_set_custom_select_value === "function") {
      sf_set_custom_select_value(sel, n);
    }
    const noun = sel.dataset.itemsNoun || "Posts";
    const labelEl = dd.querySelector(".sf-dd-label");
    if (labelEl) labelEl.textContent = `Latest ${n} ${noun}`;
    if (typeof sf_mark_custom_row_selected === "function") {
      sf_mark_custom_row_selected(dd, n);
    }
    return true;
  }

  // IG items
  const igItems = localStorage.getItem("feedrank_ig_items")
  if (igItems) {
    syncCustomDropdown("sf-dd-ig-items", "no_reels_selected", igItems);
  }

  // IG dates
  const igDates = localStorage.getItem("feedrank_ig_dates")
  if (igDates) {
    const el = document.getElementById("dates_selected")
    if (el) { el.value = igDates; syncCustomDropdown("sf-dd-ig-dates", "dates_selected", igDates); }
  }

  // TikTok items
  const ttItems = localStorage.getItem("feedrank_tiktok_items")
  if (ttItems) {
    syncCustomDropdown("sf-dd-tt-items", "no_reels_selected_tiktok", ttItems);
  }

  // TikTok dates
  const ttDates = localStorage.getItem("feedrank_tiktok_dates")
  if (ttDates) {
    const el = document.getElementById("dates_selected_tiktok")
    if (el) { el.value = ttDates; syncCustomDropdown("sf-dd-tt-dates", "dates_selected_tiktok", ttDates); }
  }

  // Facebook items
  const fbItems = localStorage.getItem("feedrank_fb_items")
  if (fbItems) {
    syncCustomDropdown("sf-dd-fb-items", "no_reels_selected_facebook", fbItems);
  }

  // Facebook dates
  const fbDates = localStorage.getItem("feedrank_fb_dates")
  if (fbDates) {
    const el = document.getElementById("dates_selected_facebook")
    if (el) { el.value = fbDates; syncCustomDropdown("sf-dd-fb-dates", "dates_selected_facebook", fbDates); }
  }

  // YouTube items
  const ytItems = localStorage.getItem("feedrank_yt_items")
  if (ytItems) {
    syncCustomDropdown("sf-dd-yt-items", "no_reels_selected_youtube", ytItems);
  }

  // YouTube dates
  const ytDates = localStorage.getItem("feedrank_yt_dates")
  if (ytDates) {
    const el = document.getElementById("dates_selected_youtube")
    if (el) { el.value = ytDates; syncCustomDropdown("sf-dd-yt-dates", "dates_selected_youtube", ytDates); }
  }
}

////////////////////////////////////////////////////////////////////////////////
// save last selection on IG or TikTok
////////////////////////////////////////////////////////////////////////////////
// save to local storage 
////////////////////////////////////////////////////////////////////////////////

// save values to local storage based on change! 
function setupDropdownLogger(id) {
  const el = document.getElementById(id)
  if (!el) return

  el.addEventListener("change", () => {
    // IG items selection 
    if (id==='no_reels_selected') {
      localStorage.setItem("feedrank_ig_items", el.value); 
    } 
    // IG date selection 
    else if (id==='dates_selected') { 
       localStorage.setItem("feedrank_ig_dates", el.value); 
    }
    // tiktok items selection 
    else if (id==='no_reels_selected_tiktok') {

       localStorage.setItem("feedrank_tiktok_items", el.value); 
    } 
    // tiktok date selection
    else if (id==='dates_selected_tiktok') {
       localStorage.setItem("feedrank_tiktok_dates", el.value);
    }
    // facebook items selection
    else if (id==='no_reels_selected_facebook') {
       localStorage.setItem("feedrank_fb_items", el.value);
    }
    // facebook date selection
    else if (id==='dates_selected_facebook') {
       localStorage.setItem("feedrank_fb_dates", el.value);
    }
    // youtube items selection
    else if (id==='no_reels_selected_youtube') {
       localStorage.setItem("feedrank_yt_items", el.value);
    }
    // youtube date selection
    else if (id==='dates_selected_youtube') {
       localStorage.setItem("feedrank_yt_dates", el.value);
    }
  })
}

// call it for both
setupDropdownLogger("no_reels_selected");
setupDropdownLogger("dates_selected");
setupDropdownLogger("no_reels_selected_tiktok");
setupDropdownLogger("dates_selected_tiktok");
setupDropdownLogger("no_reels_selected_facebook");
setupDropdownLogger("dates_selected_facebook");
setupDropdownLogger("no_reels_selected_youtube");
setupDropdownLogger("dates_selected_youtube");

////////////////////////////////////////////////////////////////////////////////
// Download / Transcribe toggle persistence
////////////////////////////////////////////////////////////////////////////////

const TOGGLE_KEYS = {
  igSaveToggle:       'feedrank_ig_save_enabled',
  igDownloadToggle:   'feedrank_ig_download_enabled',
  igTranscribeToggle: 'feedrank_ig_transcribe_enabled',
  ttDownloadToggle:   'feedrank_tiktok_download_enabled',
  ttTranscribeToggle: 'feedrank_tiktok_transcribe_enabled',
  fbDownloadToggle:   'feedrank_fb_download_enabled',
  fbTranscribeToggle: 'feedrank_fb_transcribe_enabled',
};

function restoreToggleStates() {
  const keys = Object.values(TOGGLE_KEYS);
  chrome.storage.local.get(keys, (result) => {
    for (const [elId, key] of Object.entries(TOGGLE_KEYS)) {
      const el = document.getElementById(elId);
      if (!el) continue;
      el.checked = result[key] !== false;
    }
  });
}

function setupToggleListeners() {
  for (const [elId, key] of Object.entries(TOGGLE_KEYS)) {
    const el = document.getElementById(elId);
    if (!el) continue;
    el.addEventListener('change', () => {
      chrome.storage.local.set({ [key]: el.checked });
    });
  }
}

restoreToggleStates();
setupToggleListeners();
