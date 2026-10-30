const DEBUG = false;

////////////////////////////////////////////////////////////////////////////////
// Tab Navigation & Action Listeners
////////////////////////////////////////////////////////////////////////////////

chrome.action.onClicked.addListener((tab) => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]?.id) return;
    chrome.action.setPopup({
      tabId: tabs[0].id,
      popup: "popup.html",
    });
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]?.id) return;
    chrome.action.setPopup({
      tabId: tabs[0].id,
      popup: "popup.html",
    });
  });
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.tabs.create({
      url: "https://buymeatea.in/bytanmay",
    });
  }
});

chrome.webNavigation.onCompleted.addListener((details) => {
  if (details.frameId === 0) {
    chrome.tabs.sendMessage(details.tabId, {
      action: "pageLoaded",
      url: details.url,
    }).catch(() => {});
  }
});

////////////////////////////////////////////////////////////////////////////////
// Local Storage / Database Helpers
////////////////////////////////////////////////////////////////////////////////

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("FeedRankDB", 1);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function setDBItem(key, value) {
  return openDB().then((db) => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction("settings", "readwrite");
      tx.objectStore("settings").put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  });
}

function getDBItem(key) {
  return openDB().then((db) => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction("settings", "readonly");
      const req = tx.objectStore("settings").get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  });
}

function deleteDBItem(key) {
  return openDB().then((db) => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction("settings", "readwrite");
      const req = tx.objectStore("settings").delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  });
}

////////////////////////////////////////////////////////////////////////////////
// Message Dispatcher
////////////////////////////////////////////////////////////////////////////////

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Sorting triggers — 100% open and unrestricted for all platforms
  if (message.refresh === "ON") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]?.id) return;
      chrome.tabs.sendMessage(tabs[0].id, {
        action: "refreshPage",
        sort_by: message.sort_by,
        no_items: message.no_items,
        dates_items: message.dates_items,
        outlier_scores: message.outlier_scores === true,
      });
    });
    return true;
  }

  if (message.refresh === "ON_TikTok") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]?.id) return;
      chrome.tabs.sendMessage(tabs[0].id, {
        action: "refreshPageTikTok",
        sort_by: message.sort_by,
        no_items: message.no_items,
        dates_items: message.dates_items,
        outlier_scores: message.outlier_scores === true,
      });
    });
    return true;
  }

  if (message.refresh === "ON_Facebook") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]?.id) return;
      chrome.tabs.sendMessage(tabs[0].id, {
        action: "refreshPageFacebook",
        sort_by: message.sort_by,
        no_items: message.no_items,
        dates_items: message.dates_items,
        outlier_scores: message.outlier_scores === true,
      });
    });
    return true;
  }

  if (message.refresh === "ON_YouTube") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]?.id) return;
      chrome.tabs.sendMessage(tabs[0].id, {
        action: "refreshPageYouTube",
        sort_by: message.sort_by,
        no_items: message.no_items,
        dates_items: message.dates_items,
        outlier_scores: message.outlier_scores === true,
      });
    });
    return true;
  }

  // Error notifications from content scripts
  if (message.feedrank_error || message.feedrank_error) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]?.id) return;
      chrome.tabs.sendMessage(tabs[0].id, {
        feedrank_error: true,
        feedrank_error: true,
        error_type: message.error_type,
        surface_label: message.surface_label,
      });
    });
    return true;
  }

  // Logo animations
  if (message.logo_animate_on) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]?.id) return;
      chrome.tabs.sendMessage(tabs[0].id, { logo_animate_on: true });
    });
    return true;
  }

  if (message.logo_animate_off) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]?.id) return;
      chrome.tabs.sendMessage(tabs[0].id, { logo_animate_off: true });
    });
    return true;
  }

  // TikTok scroll
  if (message.message === "scroll tiktok") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]?.id) return;
      chrome.tabs.sendMessage(tabs[0].id, { message: "scroll tiktok" });
    });
    return true;
  }

  // Items count collected
  if (message.item_collected_no) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]?.id) return;
      chrome.tabs.sendMessage(tabs[0].id, {
        item_collected_no: true,
        number_items: message.number_items,
      });
    });
    return true;
  }

  // Export clicks
  if (message.export_click) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]?.id) return;
      chrome.tabs.sendMessage(tabs[0].id, {
        export_click_background: true,
        posts_vs_reels: message.posts_vs_reels,
        sorted_data: message.sorted_data,
        export_format: message.export_format,
      });
    });
    return true;
  }

  if (message.export_click_tiktok) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]?.id) return;
      chrome.tabs.sendMessage(tabs[0].id, {
        export_click_background_tiktok: true,
        posts_vs_reels: message.posts_vs_reels,
        sorted_data: message.sorted_data,
        export_format: message.export_format,
      });
    });
    return true;
  }

  // Page loaded handshake
  if (message.page_loaded) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]?.id) return;
      chrome.tabs.sendMessage(tabs[0].id, { page_loaded_completed: "ON" });
    });
    return true;
  }

  if (message.action === "forwardMessage") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]?.id) return;
      chrome.tabs.sendMessage(tabs[0].id, { action: "receiveMessage" });
    });
    return true;
  }

  // Tab openers
  if (message.type === "OPEN_TAB_GSHEETS" && message.url) {
    chrome.tabs.create({ url: message.url });
    return true;
  }

  if (message.type === "SF_OPEN_BG_TAB" && message.url) {
    try { sendResponse({ ok: true }); } catch (_) {}
    const opts = { url: message.url, active: false };
    if (sender?.tab) {
      if (typeof sender.tab.id === "number") opts.openerTabId = sender.tab.id;
      if (typeof sender.tab.index === "number") opts.index = sender.tab.index + 1;
    }
    chrome.tabs.create(opts, () => { void chrome.runtime.lastError; });
    return true;
  }

  // Zero-state links
  if (message.zero_state === "instagram") {
    chrome.tabs.create({ url: "https://www.instagram.com/" });
    return true;
  }
  if (message.zero_state === "tiktok") {
    chrome.tabs.create({ url: "https://www.tiktok.com/" });
    return true;
  }
  if (message.zero_state === "facebook") {
    chrome.tabs.create({ url: "https://www.facebook.com/" });
    return true;
  }
  if (message.zero_state === "youtube") {
    chrome.tabs.create({ url: "https://www.youtube.com/" });
    return true;
  }

  // Transcription requests — offline response
  if (
    message.command === "InstagramReelTranscribe" ||
    message.command === "TikTokReelTranscribe" ||
    message.command === "TikTokURLTranscribe" ||
    message.command === "FacebookURLTranscribe" ||
    message.command === "FacebookReelTranscribe" ||
    message.command === "SelectMissionTranscribe" ||
    message.command === "SelectMissionTranscribeTikTok" ||
    message.command === "SelectMissionTranscribeFacebook"
  ) {
    const tabId = sender?.tab?.id ?? null;
    const jobId = message.jobId;
    if (tabId != null) {
      chrome.tabs.sendMessage(tabId, {
        type: "TRANSCRIPTION_ERROR",
        errorCode: "offline",
        error: "Offline mode: cloud transcription is not enabled.",
        jobId,
      });
    }
    return false;
  }

  if (message.command === "cancelTranscription" || message.command === "cancelSelectMission") {
    return false;
  }
});
