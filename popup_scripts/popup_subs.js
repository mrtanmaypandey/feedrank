////////////////////////////////////////////////////////////////////////////////
// Upgrade-click helper
////////////////////////////////////////////////////////////////////////////////

const SF_PRICING_URL = "https://buymeatea.in/bytanmay";

function sfTrackUpgradeClick(eventName, meta = {}) {
  try {
    if (typeof DEBUG !== "undefined" && DEBUG) {
      console.log("[analytics]", eventName, meta);
    }
    chrome.runtime.sendMessage(
      { type: "SF_ANALYTICS", event: eventName, ...meta },
      () => void chrome.runtime.lastError   // swallow "no receiver" errors
    );
  } catch (_) { /* analytics must never break the click */ }
}

////////////////////////////////////////////////////////////////////////////////
// custom dropdown logic (Notion-style)
////////////////////////////////////////////////////////////////////////////////

// Maps custom dropdown id → hidden select id
const SF_DD_MAP = {
  "sf-dd-ig-items":  "no_reels_selected",
  "sf-dd-ig-dates":  "dates_selected",
  "sf-dd-tt-items":  "no_reels_selected_tiktok",
  "sf-dd-tt-dates":  "dates_selected_tiktok",
  "sf-dd-fb-items":  "no_reels_selected_facebook",
  "sf-dd-fb-dates":  "dates_selected_facebook",
  "sf-dd-yt-items":  "no_reels_selected_youtube",
  "sf-dd-yt-dates":  "dates_selected_youtube",
};

// Per-dropdown "Custom…" row label. Only IG overrides it; every other dropdown
// falls back to the plain "Custom…". Applied in sf_dd_init() (before first
// paint) and read back by the reset/select helpers below.
const SF_DD_CUSTOM_LABEL = {
  "sf-dd-ig-items":  "Custom Posts…",
  "sf-dd-ig-dates":  "Custom Date…",
};

// The custom row's resting label, stashed on the element in sf_dd_init().
function sf_custom_label(customOpt) {
  return customOpt?.dataset.customLabel || "Custom…";
}

// Custom range helpers (shared with popup.js migration)
function sf_set_custom_select_value_raw(selectEl, value, label) {
  selectEl.querySelector("option.sf-dd-custom-option")?.remove();
  const opt = document.createElement("option");
  opt.className = "sf-dd-custom-option";
  opt.value = value;
  opt.textContent = label;
  selectEl.appendChild(opt);
  selectEl.value = opt.value;
  selectEl.dispatchEvent(new Event("change"));
}

function sf_set_custom_select_value(selectEl, n) {
  // Items dropdown shortcut — wraps the raw helper with the `Latest N Posts` label format.
  const noun = selectEl.dataset.itemsNoun || "Posts";
  sf_set_custom_select_value_raw(selectEl, `${n}_reels`, `Latest ${n} ${noun}`);
}

function sf_reset_custom_row(menu) {
  const customOpt = menu.querySelector(".sf-dd-opt-custom");
  if (!customOpt) return;
  const lbl = customOpt.querySelector(".sf-dd-opt-label");
  if (lbl) lbl.textContent = sf_custom_label(customOpt);
  customOpt.classList.remove("sf-dd-selected");
  // Re-surface the "New" pill — Pro users see it whenever a preset is the
  // active selection (i.e. custom row is not locked and not selected).
  const pill = customOpt.querySelector(".sf-dd-new-pill");
  if (pill && !customOpt.classList.contains("sf-dd-locked")) {
    pill.classList.add("sf-show");
  }
}

function sf_mark_custom_row_selected(menu, label) {
  const customOpt = menu.querySelector(".sf-dd-opt-custom");
  if (!customOpt) return;
  const lbl = customOpt.querySelector(".sf-dd-opt-label");
  // Keep the resting noun in the selected label: "Custom Posts (347)" etc.
  const base = sf_custom_label(customOpt).replace(/…\s*$/, "");
  if (lbl) lbl.textContent = `${base} (${label})`;
  menu.querySelectorAll(".sf-dd-opt").forEach(o => o.classList.remove("sf-dd-selected"));
  customOpt.classList.add("sf-dd-selected");
  const pill = customOpt.querySelector(".sf-dd-new-pill");
  if (pill) pill.classList.remove("sf-show");
}

// Cancel resets the dropdown to the default preset (the <option selected> in HTML)
// and drops any active custom selection from both the select and the UI.
function sf_reset_to_default(dd, selectEl, menu) {
  selectEl.querySelector("option.sf-dd-custom-option")?.remove();
  const defaultOpt = selectEl.querySelector("option[selected]") || selectEl.options[0];
  if (!defaultOpt) return;
  selectEl.value = defaultOpt.value;
  selectEl.dispatchEvent(new Event("change"));

  const ddLabel = dd.querySelector(".sf-dd-label");
  if (ddLabel) ddLabel.textContent = defaultOpt.textContent;

  menu.querySelectorAll(".sf-dd-opt").forEach(o => o.classList.remove("sf-dd-selected"));
  const matchingDdOpt = menu.querySelector(`.sf-dd-opt[data-value="${defaultOpt.value}"]`);
  if (matchingDdOpt) matchingDdOpt.classList.add("sf-dd-selected");

  sf_reset_custom_row(menu);
}

////////////////////////////////////////////////////////////////////////////////
// Custom date range — calendar widget (UI preview)
////////////////////////////////////////////////////////////////////////////////

const SF_CAL_MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const SF_CAL_MONTHS_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

// Per-menu calendar state, keyed by the menu element via WeakMap.
const _sfCalState = new WeakMap();

function _sfStartOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function _sfStartOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function sfFormatDateShort(ms) {
  const d = new Date(ms);
  return `${SF_CAL_MONTHS_SHORT[d.getMonth()]} ${d.getDate()}`;
}

function sfFormatDateRange(fromMs, toMs) {
  const f = new Date(fromMs), t = new Date(toMs);
  const today = new Date();
  const sameYear = f.getFullYear() === t.getFullYear() && f.getFullYear() === today.getFullYear();
  if (sameYear) {
    return `${SF_CAL_MONTHS_SHORT[f.getMonth()]} ${f.getDate()} – ${SF_CAL_MONTHS_SHORT[t.getMonth()]} ${t.getDate()}`;
  }
  return `${SF_CAL_MONTHS_SHORT[f.getMonth()]} ${f.getDate()}, ${f.getFullYear()} – ${SF_CAL_MONTHS_SHORT[t.getMonth()]} ${t.getDate()}, ${t.getFullYear()}`;
}

function sfCalRender(panelRoot) {
  const st = _sfCalState.get(panelRoot);
  if (!st) return;
  const grid = panelRoot.querySelector(".sf-cal-grid");
  const titleEl = panelRoot.querySelector(".sf-cal-title");
  if (!grid || !titleEl) return;

  const view = st.visibleMonth; // Date at first of month
  titleEl.textContent = `${SF_CAL_MONTHS[view.getMonth()]} ${view.getFullYear()}`;

  // Build 6 weeks (42 cells) starting on Sunday
  const firstWeekday = view.getDay(); // 0..6 (Sun..Sat)
  const startDate = new Date(view);
  startDate.setDate(1 - firstWeekday);

  const today = _sfStartOfDay(new Date()).getTime();
  const fromMs = st.fromMs;
  const toMs   = st.toMs;
  const hover  = st.hoverMs;

  // Compute preview range when only From is set and user hovers a day.
  let pStart = null, pEnd = null;
  if (fromMs && !toMs && hover != null && hover !== fromMs) {
    pStart = Math.min(fromMs, hover);
    pEnd   = Math.max(fromMs, hover);
  }

  // Compute committed range
  let rStart = null, rEnd = null;
  if (fromMs && toMs) {
    rStart = Math.min(fromMs, toMs);
    rEnd   = Math.max(fromMs, toMs);
  }

  let html = "";
  for (let i = 0; i < 42; i++) {
    const d = new Date(startDate);
    d.setDate(startDate.getDate() + i);
    const dayMs = _sfStartOfDay(d).getTime();
    const otherMonth = d.getMonth() !== view.getMonth();
    const future = dayMs > today;
    const isToday = dayMs === today;
    const isFrom = fromMs != null && dayMs === fromMs;
    const isTo = toMs != null && dayMs === toMs;
    const inRange = (rStart != null && dayMs >= rStart && dayMs <= rEnd) ||
                    (pStart != null && dayMs >= pStart && dayMs <= pEnd);
    const isRangeStart = inRange && rStart != null && dayMs === rStart;
    const isRangeEnd = inRange && rEnd != null && dayMs === rEnd;

    const cls = [
      "sf-cal-day",
      otherMonth ? "sf-cal-day-other-month" : "",
      future ? "sf-cal-day-future" : "",
      isToday ? "sf-cal-day-today" : "",
      (isFrom || isTo) ? "sf-cal-day-endpoint" : "",
      inRange ? "sf-cal-day-in-range" : "",
      isRangeStart ? "sf-cal-day-range-start" : "",
      isRangeEnd ? "sf-cal-day-range-end" : "",
    ].filter(Boolean).join(" ");

    html += `<button type="button" class="${cls}" data-ms="${dayMs}" ${future ? "disabled" : ""}>${d.getDate()}</button>`;
  }
  grid.innerHTML = html;

  // Disable next button when entire next month is in the future
  const next = new Date(view.getFullYear(), view.getMonth() + 1, 1);
  const nextBtn = panelRoot.querySelector(".sf-cal-next");
  if (nextBtn) nextBtn.disabled = next.getTime() > today;
}

function _sfDatePanelSyncFields(panelRoot) {
  const st = _sfCalState.get(panelRoot);
  if (!st) return;
  const status = panelRoot.querySelector(".sf-date-status");
  if (!status) return;
  if (st.fromMs != null && st.toMs != null) {
    const a = Math.min(st.fromMs, st.toMs);
    const b = Math.max(st.fromMs, st.toMs);
    status.textContent = `${sfFormatDateShort(a)} – ${sfFormatDateShort(b)}`;
    status.classList.add("sf-date-status-range");
  } else {
    status.textContent = "";
    status.classList.remove("sf-date-status-range");
  }
}

function _sfDatePanelSyncFocusUI(_panelRoot) {
  /* No-op — From/To input fields removed; calendar conveys focus via endpoint highlight. */
}

function _sfDatePanelSyncAccept(panelRoot) {
  const st = _sfCalState.get(panelRoot);
  const acc = panelRoot.querySelector(".sf-dd-custom-accept");
  const errEl = panelRoot.querySelector(".sf-dd-custom-error");
  if (!acc) return;
  if (!st || st.fromMs == null || st.toMs == null) {
    acc.disabled = true;
    if (errEl) {
      errEl.textContent = "";
      errEl.classList.remove("sf-dd-custom-error-visible");
    }
    return;
  }
  if (st.fromMs > st.toMs) {
    acc.disabled = true;
    if (errEl) {
      errEl.textContent = "From must be on or before To";
      errEl.classList.add("sf-dd-custom-error-visible");
    }
    return;
  }
  acc.disabled = false;
  if (errEl) {
    errEl.textContent = "";
    errEl.classList.remove("sf-dd-custom-error-visible");
  }
}

function sfCalOpen(menu, selectEl) {
  let st = _sfCalState.get(menu);
  if (!st) {
    st = { visibleMonth: _sfStartOfMonth(new Date()), fromMs: null, toMs: null, hoverMs: null, focused: "from" };
    _sfCalState.set(menu, st);
  }

  // Seed from the active custom value (if any) so re-opening shows the saved range.
  const active = selectEl?.value || "";
  const m = /^custom_(\d+)_(\d+)$/.exec(active);
  if (m) {
    const fromMs = parseInt(m[1], 10);
    const toMs   = parseInt(m[2], 10);
    if (Number.isFinite(fromMs) && Number.isFinite(toMs)) {
      st.fromMs = fromMs;
      st.toMs = toMs;
      st.visibleMonth = _sfStartOfMonth(new Date(fromMs));
    }
  } else {
    st.fromMs = null;
    st.toMs = null;
    st.visibleMonth = _sfStartOfMonth(new Date());
  }
  st.focused = "from";
  st.hoverMs = null;

  _sfDatePanelSyncFields(menu);
  _sfDatePanelSyncFocusUI(menu);
  _sfDatePanelSyncAccept(menu);
  sfCalRender(menu);
  // Grow the popup so the absolute panel is fully contained.
  document.body.classList.add("sf-date-panel-open");
}

function _sfCalClose() {
  document.body.classList.remove("sf-date-panel-open");
}

function sfDatePanelInit(menu, dd, selectEl) {
  const panel = menu.querySelector(".sf-dd-custom-panel-date");
  if (!panel) return;

  // Stop clicks inside the panel from closing the dropdown.
  panel.addEventListener("click", (e) => e.stopPropagation());

  // Prev / next month nav
  const prevBtn = panel.querySelector(".sf-cal-prev");
  const nextBtn = panel.querySelector(".sf-cal-next");
  if (prevBtn) {
    prevBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const st = _sfCalState.get(menu);
      if (!st) return;
      st.visibleMonth = new Date(st.visibleMonth.getFullYear(), st.visibleMonth.getMonth() - 1, 1);
      sfCalRender(menu);
    });
  }
  if (nextBtn) {
    nextBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (nextBtn.disabled) return;
      const st = _sfCalState.get(menu);
      if (!st) return;
      st.visibleMonth = new Date(st.visibleMonth.getFullYear(), st.visibleMonth.getMonth() + 1, 1);
      sfCalRender(menu);
    });
  }

  // Day click + hover (event delegation on the grid)
  const grid = panel.querySelector(".sf-cal-grid");
  if (grid) {
    grid.addEventListener("click", (e) => {
      const cell = e.target.closest(".sf-cal-day");
      if (!cell || cell.disabled || cell.classList.contains("sf-cal-day-future")) return;
      const ms = parseInt(cell.dataset.ms, 10);
      const st = _sfCalState.get(menu);
      if (!st || !Number.isFinite(ms)) return;

      if (st.focused === "from") {
        st.fromMs = ms;
        if (st.toMs != null && st.fromMs > st.toMs) st.toMs = null;
        st.focused = "to";
      } else {
        if (st.fromMs != null && ms < st.fromMs) {
          st.toMs = st.fromMs;
          st.fromMs = ms;
        } else {
          st.toMs = ms;
        }
        st.focused = "from";
      }
      st.hoverMs = null;
      _sfDatePanelSyncFields(menu);
      _sfDatePanelSyncFocusUI(menu);
      _sfDatePanelSyncAccept(menu);
      sfCalRender(menu);
    });

    grid.addEventListener("mouseover", (e) => {
      const cell = e.target.closest(".sf-cal-day");
      if (!cell || cell.disabled) return;
      const st = _sfCalState.get(menu);
      if (!st || st.fromMs == null || st.toMs != null) return;
      const ms = parseInt(cell.dataset.ms, 10);
      if (!Number.isFinite(ms) || ms === st.hoverMs) return;
      st.hoverMs = ms;
      sfCalRender(menu);
    });

    grid.addEventListener("mouseleave", () => {
      const st = _sfCalState.get(menu);
      if (!st || st.hoverMs == null) return;
      st.hoverMs = null;
      sfCalRender(menu);
    });
  }

  // Cancel — clear any active custom date and revert to the default preset.
  const cancelBtn = panel.querySelector(".sf-dd-custom-cancel");
  if (cancelBtn) {
    cancelBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      sf_reset_to_default(dd, selectEl, menu);
      menu.classList.remove("sf-dd-show-custom");
      menu.classList.remove("sf-dd-open");
      _sfCalClose();
    });
  }

  // Accept — apply custom date range, persist via change event, close.
  const acceptBtn = panel.querySelector(".sf-dd-custom-accept");
  if (acceptBtn) {
    acceptBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (acceptBtn.disabled) return;

      const st = _sfCalState.get(menu);
      if (!st || st.fromMs == null || st.toMs == null) return;
      const fromMs = Math.min(st.fromMs, st.toMs);
      const toMs   = Math.max(st.fromMs, st.toMs);

      const value = `custom_${fromMs}_${toMs}`;
      const label = sfFormatDateRange(fromMs, toMs);

      sf_set_custom_select_value_raw(selectEl, value, label);
      const labelEl = dd.querySelector(".sf-dd-label");
      if (labelEl) labelEl.textContent = label;
      sf_mark_custom_row_selected(menu, label);

      menu.classList.remove("sf-dd-show-custom");
      menu.classList.remove("sf-dd-open");
      _sfCalClose();
    });
  }

  // Esc closes dropdown when panel is shown.
  panel.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      menu.classList.remove("sf-dd-show-custom");
      menu.classList.remove("sf-dd-open");
      _sfCalClose();
    }
  });
}

// Ensure a dropdown menu has the free-state "Get Pro" nudge row as the last
// item in its options list. IG ships it in the HTML; every other platform's
// dropdowns (TikTok/Facebook/YouTube) get it injected here, so all free
// dropdowns show the same upgrade row. sf_dd_lock()/unlock_all_options() toggle
// its visibility, and the button's click is wired below in sf_dd_init().
function sf_inject_get_pro_row(menu) {
  if (!menu || menu.querySelector(".sf-dd-get-pro")) return;
  const list = menu.querySelector(".sf-dd-options-list");
  if (!list) return;
  list.insertAdjacentHTML("beforeend",
    '<div class="sf-dd-get-pro" style="display:none;">' +
      '<div class="sf-dd-divider"></div>' +
      '<button type="button" class="sf-dd-get-pro-btn" data-sf-upgrade="dropdown_row">' +
        '<span class="sf-dd-get-pro-left">' +
          '<span class="sf-dd-get-pro-icon" aria-hidden="true"></span>' +
          '<span class="sf-dd-get-pro-label">Get Pro</span>' +
        '</span>' +
        '<span class="sf-dd-get-pro-arrow" aria-hidden="true"></span>' +
      '</button>' +
    '</div>'
  );
}

function sf_dd_init() {

  Object.keys(SF_DD_MAP).forEach((ddId) => {
    const dd = document.getElementById(ddId);
    if (!dd) return;

    const trigger = dd.querySelector(".sf-dd-trigger");
    const menu    = dd.querySelector(".sf-dd-menu");
    const selectEl = document.getElementById(SF_DD_MAP[ddId]);

    // Add the free-state Get Pro row (no-op for IG, which already has it in HTML).
    sf_inject_get_pro_row(menu);

    // Apply the per-dropdown "Custom…" label (IG only) and stash it so the
    // reset/select helpers can restore it. Runs before first paint → no flash.
    const customOpt = menu.querySelector(".sf-dd-opt-custom");
    if (customOpt) {
      const customLabel = SF_DD_CUSTOM_LABEL[ddId] || "Custom…";
      customOpt.dataset.customLabel = customLabel;
      const customLbl = customOpt.querySelector(".sf-dd-opt-label");
      if (customLbl) customLbl.textContent = customLabel;
    }

    // open / close
    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      const isOpen = menu.classList.contains("sf-dd-open");
      // close all others first (and reset their custom-panel state)
      document.querySelectorAll(".sf-dd-menu.sf-dd-open").forEach(m => {
        m.classList.remove("sf-dd-open");
        m.classList.remove("sf-dd-show-custom");
      });
      if (!isOpen) {
        // Always open on the options list, never on the custom panel.
        menu.classList.remove("sf-dd-show-custom");
        menu.classList.add("sf-dd-open");
      }
    });

    // option click
    menu.querySelectorAll(".sf-dd-opt").forEach((opt) => {
      opt.addEventListener("click", (e) => {
        // Locked "Pro" rows are inert on every platform (they look disabled);
        // only the Get Pro row at the bottom of the menu is clickable.
        if (opt.classList.contains("sf-dd-locked")) return;

        // Custom… row — slide the input panel in.
        if (opt.classList.contains("sf-dd-opt-custom")) {
          e.stopPropagation();
          menu.classList.add("sf-dd-show-custom");

          const datePanel = menu.querySelector(".sf-dd-custom-panel-date");
          if (datePanel) {
            sfCalOpen(menu, selectEl);
            return;
          }

          const input = menu.querySelector(".sf-dd-custom-input");
          const acc   = menu.querySelector(".sf-dd-custom-accept");
          if (input) {
            // Pre-fill if a custom value is currently active
            const customOpt = selectEl.querySelector("option.sf-dd-custom-option");
            if (customOpt && customOpt.value === selectEl.value) {
              input.value = String(parseInt(selectEl.value, 10));
              input.dispatchEvent(new Event("input"));
            } else {
              input.value = "";
              if (acc) acc.disabled = true;
            }
            setTimeout(() => input.focus(), 0);
          }
          return;
        }

        const val = opt.dataset.value;
        const label = opt.querySelector("span:first-child")?.textContent || opt.textContent.trim();

        dd.querySelector(".sf-dd-label").textContent = label;
        selectEl.value = val;
        selectEl.dispatchEvent(new Event("change"));

        // Picking a preset clears any active custom selection.
        selectEl.querySelector("option.sf-dd-custom-option")?.remove();
        sf_reset_custom_row(menu);

        menu.querySelectorAll(".sf-dd-opt").forEach(o => o.classList.remove("sf-dd-selected"));
        opt.classList.add("sf-dd-selected");
        menu.classList.remove("sf-dd-open");
      });
    });

    // Custom panel — preview-only wiring (input validation + buttons close the panel).
    // Real apply / save logic is added in a later phase.
    const customInput  = menu.querySelector(".sf-dd-custom-input");
    const customAccept = menu.querySelector(".sf-dd-custom-accept");
    const customCancel = menu.querySelector(".sf-dd-custom-cancel");
    const customError  = menu.querySelector(".sf-dd-custom-error");
    const customPanel  = menu.querySelector(".sf-dd-custom-panel");

    if (customInput && customAccept && customPanel) {
      customPanel.addEventListener("click", (e) => e.stopPropagation());

      const setError = (msg) => {
        if (msg) {
          customError.textContent = msg;
          customError.classList.add("sf-dd-custom-error-visible");
          customInput.classList.add("sf-dd-custom-input-error");
        } else {
          customError.textContent = "";
          customError.classList.remove("sf-dd-custom-error-visible");
          customInput.classList.remove("sf-dd-custom-input-error");
        }
      };

      const errorNoun = (selectEl?.dataset?.itemsNoun || "Posts").toLowerCase();

      customInput.addEventListener("input", () => {
        const raw = customInput.value.replace(/[^\d]/g, "");
        if (raw !== customInput.value) customInput.value = raw;
        if (raw === "") {
          setError("");
          customAccept.disabled = true;
          return;
        }
        const n = parseInt(raw, 10);
        if (n > 10000) {
          setError(`Custom ${errorNoun} can't go beyond 10K`);
          customAccept.disabled = true;
        } else if (n < 1) {
          setError(`Custom ${errorNoun} must be at least 1`);
          customAccept.disabled = true;
        } else {
          setError("");
          customAccept.disabled = false;
        }
      });

      customInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !customAccept.disabled) {
          e.preventDefault();
          customAccept.click();
        } else if (e.key === "Escape") {
          e.preventDefault();
          if (customCancel) customCancel.click();
        }
      });

      if (customCancel) {
        customCancel.addEventListener("click", (e) => {
          e.stopPropagation();
          // Cancel clears any active custom value and reverts to the default preset.
          sf_reset_to_default(dd, selectEl, menu);
          menu.classList.remove("sf-dd-show-custom");
          menu.classList.remove("sf-dd-open");
          setError("");
        });
      }

      customAccept.addEventListener("click", (e) => {
        e.stopPropagation();
        const n = parseInt((customInput.value || "").replace(/[^\d]/g, ""), 10);
        if (!Number.isFinite(n) || n < 1 || n > 10000) return; // safety net
        sf_set_custom_select_value(selectEl, n);
        const noun = selectEl.dataset.itemsNoun || "Posts";
        dd.querySelector(".sf-dd-label").textContent = `Latest ${n} ${noun}`;
        sf_mark_custom_row_selected(menu, n);
        setError("");
        menu.classList.remove("sf-dd-show-custom");
        menu.classList.remove("sf-dd-open");
      });
    }


    // Date custom panel wiring — calendar interactions (preview only for now).
    const datePanel = menu.querySelector(".sf-dd-custom-panel-date");
    if (datePanel) {
      sfDatePanelInit(menu, dd, selectEl);
    }

    // Upgrade row inside menu (Notion-style, free/signed-out only)
    const getProBtn = dd.querySelector(".sf-dd-get-pro-btn");
    if (getProBtn) {
      getProBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        sfTrackUpgradeClick("upgrade_click_dropdown_row", { dropdown: ddId });
        window.open(SF_PRICING_URL, "_blank");
      });
    }
  });

  // close on outside click
  document.addEventListener("click", () => {
    document.querySelectorAll(".sf-dd-menu.sf-dd-open").forEach(m => {
      m.classList.remove("sf-dd-open");
      m.classList.remove("sf-dd-show-custom");
    });
    _sfCalClose();
  });
}

////////////////////////////////////////////////////////////////////////////////
// feature gating — unlock all dropdown options & initialize UI
////////////////////////////////////////////////////////////////////////////////

function unlock_all_options() {
  document.body.classList.remove("sf-locked");
  ["sf-dd-ig-items","sf-dd-ig-dates","sf-dd-tt-items","sf-dd-tt-dates","sf-dd-fb-items","sf-dd-fb-dates","sf-dd-yt-items","sf-dd-yt-dates"].forEach((ddId) => {
    const dd = document.getElementById(ddId);
    if (!dd) return;
    dd.querySelectorAll(".sf-dd-opt").forEach(opt => {
      opt.classList.remove("sf-dd-locked");
      opt.querySelector(".sf-dd-pro-pill")?.remove();
    });
    const getPro = dd.querySelector(".sf-dd-get-pro");
    if (getPro) getPro.style.display = "none";
  });

  ["no_reels_selected","dates_selected","no_reels_selected_tiktok","dates_selected_tiktok","no_reels_selected_facebook","dates_selected_facebook","no_reels_selected_youtube","dates_selected_youtube"].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    for (const opt of sel.options) opt.disabled = false;
  });

  sf_apply_custom_new_pills();
}

function sf_apply_custom_new_pills() {
  document.querySelectorAll(".sf-dd-opt-custom").forEach(customOpt => {
    const pill = customOpt.querySelector(".sf-dd-new-pill");
    if (!pill) return;
    if (customOpt.classList.contains("sf-dd-selected")) {
      pill.classList.remove("sf-show");
    } else {
      pill.classList.add("sf-show");
    }
  });
}

function show_footer_based_on_state() { 
  const sub = document.getElementById("subFooter");
  if (sub) sub.style.display = "none";
  const free = document.getElementById("FreeFooter");
  if (free) free.style.display = "none";
  const paid = document.getElementById("PaidFooter");
  if (paid) paid.style.display = "none";
  const fr = document.getElementById("feedrankFooter");
  if (fr) fr.style.display = "flex";
  document.body.classList.add("sf-paid");
}

function pro_tag_added() {
  const betaSpan = document.querySelector('.beta');
  if (betaSpan) betaSpan.style.display = 'none';
}

document.addEventListener("DOMContentLoaded", async () => {
  sf_dd_init();
  unlock_all_options();
  pro_tag_added();
  show_footer_based_on_state();
  try {
    await chrome.storage.local.set({
      sort_feed_state_type_flag: "pro",
      sort_feed_user_id: null
    });
  } catch (_) {}
});