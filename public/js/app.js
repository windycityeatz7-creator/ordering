(function () {
  "use strict";

  const db = window.WCE.db;
  const email = window.WCE.email;

  // ============================================================
  // Constants
  // ============================================================
  const ROLE_LABELS = {
    employee: "Employee",
    orderteam: "Order Team",
    receiving: "Receiving",
    admin: "Admin",
  };

  const ROLE_TABS = {
    employee: ["submit", "my-requests"],
    orderteam: ["dashboard", "review", "order-history"],
    receiving: ["receiving", "history"],
    admin: ["dashboard", "review", "receiving", "history", "settings"],
  };

  const TAB_LABELS = {
    submit: "Submit Request",
    "my-requests": "My Requests",
    dashboard: "Dashboard",
    review: "Review Requests",
    "order-history": "Order History",
    receiving: "Receive Deliveries",
    history: "History",
    settings: "Settings",
  };

  const STATUS_LABELS = {
    pending: "Pending",
    ordered: "Ordered",
    received: "Received",
    partial: "Partial",
    dismissed: "Dismissed",
  };

  const SESSION_KEY = "wce_session_v1";

  // ============================================================
  // State
  // ============================================================
  const state = {
    session: null, // { location, role }
    config: { locations: [], categories: [], suppliers: [], items: [], pins: {} },
    orders: [],
    activeTab: null,
    syncStatus: "yellow",
    booted: false,
  };

  const historyFilters = {}; // per-tab filter state, keyed by tab name
  const submitDraft = {}; // itemId -> { qty, urgent }
  let submitNotes = "";
  let realtimeChannel = null;

  // ============================================================
  // Utils
  // ============================================================
  function $(sel, root) {
    return (root || document).querySelector(sel);
  }
  function $all(sel, root) {
    return Array.from((root || document).querySelectorAll(sel));
  }
  function escapeHtml(str) {
    if (str === null || str === undefined) return "";
    return String(str).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]));
  }
  function formatDate(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    return (
      d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) +
      " " +
      d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    );
  }
  function isMonday() {
    return new Date().getDay() === 1;
  }
  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }
  function slugify(str) {
    return String(str)
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") || "item";
  }
  function uniqueId(base, existingIds) {
    let id = base;
    let n = 2;
    while (existingIds.includes(id)) {
      id = `${base}-${n}`;
      n++;
    }
    return id;
  }
  function csvEscape(val) {
    const s = String(val === null || val === undefined ? "" : val);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }
  function toast(message, type) {
    const root = $("#toast-root");
    const el = document.createElement("div");
    el.className = `toast ${type || ""}`.trim();
    el.textContent = message;
    root.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }

  // ============================================================
  // Modal helpers
  // ============================================================
  function openModal(html) {
    closeModal();
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "active-modal-overlay";
    overlay.innerHTML = `<div class="modal-box">${html}</div>`;
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeModal();
    });
    document.addEventListener("keydown", escCloseHandler);
    $("#modal-root").appendChild(overlay);
    return overlay;
  }
  function escCloseHandler(e) {
    if (e.key === "Escape") closeModal();
  }
  function closeModal() {
    const existing = $("#active-modal-overlay");
    if (existing) existing.remove();
    document.removeEventListener("keydown", escCloseHandler);
  }

  // ============================================================
  // Data helpers
  // ============================================================
  function itemsByCategory() {
    const map = {};
    state.config.categories.forEach((c) => (map[c] = []));
    state.config.items.forEach((it) => {
      if (!map[it.category]) map[it.category] = [];
      map[it.category].push(it);
    });
    return map;
  }

  function groupBatches(rows) {
    // Groups order rows sharing a batch_id + location together.
    const groups = {};
    rows.forEach((r) => {
      const key = `${r.location}||${r.batch_id}`;
      if (!groups[key]) {
        groups[key] = {
          key,
          location: r.location,
          batchId: r.batch_id,
          date: r.date,
          submittedBy: r.submitted_by,
          urgent: false,
          notes: "",
          rows: [],
        };
      }
      groups[key].rows.push(r);
      if (r.urgent) groups[key].urgent = true;
      if (!groups[key].notes && r.notes) groups[key].notes = r.notes;
      if (new Date(r.date) < new Date(groups[key].date)) groups[key].date = r.date;
    });
    return Object.values(groups);
  }

  function groupDeliveries(rows) {
    const groups = {};
    rows.forEach((r) => {
      const key = `${r.supplier}||${r.ordered_date}||${r.location}`;
      if (!groups[key]) {
        groups[key] = {
          key,
          supplier: r.supplier,
          orderedDate: r.ordered_date,
          location: r.location,
          rows: [],
        };
      }
      groups[key].rows.push(r);
    });
    return Object.values(groups);
  }

  // ============================================================
  // Render: shell
  // ============================================================
  function renderShell() {
    if (!state.session) {
      $("#login-screen").classList.remove("hidden");
      $("#app-screen").classList.add("hidden");
      return;
    }
    $("#login-screen").classList.add("hidden");
    $("#app-screen").classList.remove("hidden");

    $("#nav-location-badge").textContent = state.session.location;
    $("#nav-role-badge").textContent = ROLE_LABELS[state.session.role];
    renderSyncBadge();
    renderTabsBar();
    renderTabContent();
  }

  function renderSyncBadge() {
    const dot = $("#sync-dot");
    const label = $("#sync-label");
    if (!dot || !label) return;
    dot.className = `sync-dot ${state.syncStatus}`;
    label.textContent =
      state.syncStatus === "green" ? "Live" : state.syncStatus === "red" ? "Offline" : "Connecting";
  }

  function renderTabsBar() {
    const tabs = ROLE_TABS[state.session.role] || [];
    if (!tabs.includes(state.activeTab)) state.activeTab = tabs[0];
    const bar = $("#tabs-bar");
    bar.innerHTML = tabs
      .map(
        (t) =>
          `<button class="tab-btn ${t === state.activeTab ? "active" : ""}" data-tab="${t}">${TAB_LABELS[t]}</button>`
      )
      .join("");
    $all(".tab-btn", bar).forEach((btn) => {
      btn.addEventListener("click", () => {
        state.activeTab = btn.dataset.tab;
        renderTabsBar();
        renderTabContent();
      });
    });
  }

  const TAB_RENDERERS = {
    submit: renderSubmitTab,
    "my-requests": (c) => renderHistoryTab(c, { forcedLocation: state.session.location, title: "My Requests" }),
    dashboard: renderDashboardTab,
    review: renderReviewTab,
    "order-history": (c) => renderHistoryTab(c, { title: "Order History" }),
    receiving: renderReceivingTab,
    history: (c) => renderHistoryTab(c, { title: "History" }),
    settings: renderSettingsTab,
  };

  function renderTabContent() {
    // Tab renderers attach listeners directly to the container (event
    // delegation). Since #tab-content is a single long-lived node across
    // the whole session, reusing it would accumulate a new set of
    // listeners on every tab switch -- including "change"/"click"
    // handlers from tabs the user has since navigated away from, which
    // would then misfire on events bubbling up from the *new* tab's
    // controls. Swapping in a fresh clone (no children, no listeners)
    // before each render keeps every tab's delegation scoped to just
    // that render.
    const old = $("#tab-content");
    const container = old.cloneNode(false);
    old.replaceWith(container);
    const renderer = TAB_RENDERERS[state.activeTab];
    if (renderer) renderer(container);
  }

  function rerenderCurrentTab() {
    if (state.session) renderTabContent();
  }

  // ============================================================
  // Submit tab (Employee)
  // ============================================================
  function renderSubmitTab(container) {
    function paint() {
      const monday = isMonday();
      const grouped = itemsByCategory();
      const categories = Object.keys(grouped).filter((c) => grouped[c].length);

      const bannerHtml = monday
        ? `<div class="window-banner open">✅ Order window is open today (Monday). Regular and 🔴 urgent items can both be submitted.</div>`
        : `<div class="window-banner restricted">⏳ Today is not Monday — only 🔴 Urgent items can be submitted. Mark an item Urgent to unlock its quantity, or wait for the next Monday order window.</div>`;

      const categoriesHtml = categories
        .map((cat) => {
          const rows = grouped[cat]
            .map((item) => {
              const draft = submitDraft[item.id] || { qty: 0, urgent: false };
              const locked = !monday && !draft.urgent;
              return `
                <div class="item-row" data-item-id="${escapeHtml(item.id)}">
                  <div class="item-info">
                    <div class="name">${escapeHtml(item.name)}</div>
                    <div class="unit">${escapeHtml(item.unit)}</div>
                  </div>
                  <div class="qty-control">
                    <button type="button" class="qty-btn" data-action="dec" ${locked ? "disabled" : ""}>−</button>
                    <input type="number" class="qty-input" min="0" value="${draft.qty}" ${locked ? "disabled" : ""} />
                    <button type="button" class="qty-btn" data-action="inc" ${locked ? "disabled" : ""}>+</button>
                  </div>
                  <div class="urgent-toggle ${draft.urgent ? "on" : ""}" data-action="toggle-urgent">
                    <input type="checkbox" ${draft.urgent ? "checked" : ""} />
                    <span>🔴 Urgent</span>
                  </div>
                </div>`;
            })
            .join("");
          return `<div class="category-group"><h3>${escapeHtml(cat)}</h3>${rows}</div>`;
        })
        .join("");

      const hasQty = Object.values(submitDraft).some((d) => d.qty > 0);

      container.innerHTML = `
        ${bannerHtml}
        <div class="panel">
          <h2>Submit Inventory Request</h2>
          <p class="sub">${escapeHtml(state.session.location)}</p>
          ${categoriesHtml}
          <div class="field" style="margin-top:12px;">
            <label for="submit-notes">Notes (optional)</label>
            <textarea id="submit-notes" rows="2" style="width:100%;background:var(--surface2);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:10px;">${escapeHtml(submitNotes)}</textarea>
          </div>
          <button type="button" class="btn btn-accent btn-block" id="submit-request-btn" style="margin-top:14px;" ${hasQty ? "" : "disabled"}>Review &amp; Submit</button>
        </div>
      `;
    }

    paint();

    // Listeners are attached once, directly on the container, and rely on
    // event delegation -- paint() only ever replaces *children* of
    // container, so these keep working after every repaint without
    // needing to be re-attached (re-attaching on every interaction would
    // stack a new listener per click).
    container.addEventListener("input", (e) => {
      if (e.target.id === "submit-notes") {
        submitNotes = e.target.value;
        return;
      }
      if (e.target.classList.contains("qty-input")) {
        const row = e.target.closest(".item-row");
        const id = row.dataset.itemId;
        const val = Math.max(0, parseInt(e.target.value, 10) || 0);
        submitDraft[id] = submitDraft[id] || { qty: 0, urgent: false };
        submitDraft[id].qty = val;
        $("#submit-request-btn", container).disabled = !Object.values(submitDraft).some((d) => d.qty > 0);
      }
    });

    container.addEventListener("click", (e) => {
      const qtyBtn = e.target.closest(".qty-btn");
      if (qtyBtn) {
        const row = qtyBtn.closest(".item-row");
        const id = row.dataset.itemId;
        submitDraft[id] = submitDraft[id] || { qty: 0, urgent: false };
        if (qtyBtn.dataset.action === "inc") submitDraft[id].qty += 1;
        else submitDraft[id].qty = Math.max(0, submitDraft[id].qty - 1);
        paint();
        return;
      }
      const urgentToggle = e.target.closest('[data-action="toggle-urgent"]');
      if (urgentToggle) {
        const row = urgentToggle.closest(".item-row");
        const id = row.dataset.itemId;
        submitDraft[id] = submitDraft[id] || { qty: 0, urgent: false };
        submitDraft[id].urgent = !submitDraft[id].urgent;
        if (!submitDraft[id].urgent && !isMonday()) {
          submitDraft[id].qty = 0; // locked again outside Monday
        }
        paint();
        return;
      }
      if (e.target.id === "submit-request-btn") {
        openSubmitConfirmModal();
      }
    });
  }

  function openSubmitConfirmModal() {
    const items = state.config.items;
    const lines = Object.keys(submitDraft)
      .filter((id) => submitDraft[id].qty > 0)
      .map((id) => {
        const item = items.find((i) => i.id === id);
        return { item, ...submitDraft[id] };
      })
      .filter((l) => l.item);

    const urgentLines = lines.filter((l) => l.urgent);
    const regularLines = lines.filter((l) => !l.urgent);

    const lineHtml = (l) =>
      `<div class="batch-item-line"><span>${escapeHtml(l.item.name)}</span><span class="qty">${l.qty} × ${escapeHtml(l.item.unit)}</span></div>`;

    openModal(`
      <h3>Confirm Submission</h3>
      <p class="sub">${escapeHtml(state.session.location)} • Employee</p>
      ${urgentLines.length ? `<div class="confirm-section urgent"><h4>🔴 Urgent (${urgentLines.length})</h4>${urgentLines.map(lineHtml).join("")}</div>` : ""}
      ${regularLines.length ? `<div class="confirm-section"><h4>Regular (${regularLines.length})</h4>${regularLines.map(lineHtml).join("")}</div>` : ""}
      <div class="modal-actions">
        <button class="btn btn-ghost" data-action="cancel">Cancel</button>
        <button class="btn btn-accent" data-action="confirm">Submit Request</button>
      </div>
    `);

    $("#active-modal-overlay").addEventListener("click", async (e) => {
      if (e.target.dataset.action === "cancel") return closeModal();
      if (e.target.dataset.action === "confirm") {
        e.target.disabled = true;
        e.target.textContent = "Submitting…";
        try {
          await submitOrderBatch(lines);
          closeModal();
          toast("Request submitted", "success");
          categoriesReset();
          rerenderCurrentTab();
        } catch (err) {
          console.error(err);
          toast("Failed to submit request: " + err.message, "error");
          e.target.disabled = false;
          e.target.textContent = "Submit Request";
        }
      }
    });
  }

  function categoriesReset() {
    Object.keys(submitDraft).forEach((k) => delete submitDraft[k]);
    submitNotes = "";
  }

  async function submitOrderBatch(lines) {
    const batchId = crypto.randomUUID();
    const now = new Date().toISOString();
    const rows = lines.map((l) => ({
      batch_id: batchId,
      date: now,
      location: state.session.location,
      item_id: l.item.id,
      item_name: l.item.name,
      item_unit: l.item.unit,
      category: l.item.category,
      qty: l.qty,
      urgent: l.urgent,
      status: "pending",
      notes: submitNotes || null,
      submitted_by: state.session.role,
    }));
    const inserted = await db.insertOrders(rows);
    state.orders = inserted.concat(state.orders);

    const anyUrgent = lines.some((l) => l.urgent);
    const message =
      `Location: ${state.session.location}\n` +
      `Submitted by: Employee\n\n` +
      lines.map((l) => `${l.urgent ? "[URGENT] " : ""}${l.item.name} — ${l.qty} × ${l.item.unit}`).join("\n") +
      (submitNotes ? `\n\nNotes: ${submitNotes}` : "");
    email.sendOrderNotification({ location: state.session.location, urgent: anyUrgent, message });
  }

  // ============================================================
  // Dashboard tab (Order Team / Admin)
  // ============================================================
  function renderDashboardTab(container) {
    const orders = state.orders;
    const pending = orders.filter((o) => o.status === "pending").length;
    const urgent = orders.filter((o) => o.status === "pending" && o.urgent).length;
    const ordered = orders.filter((o) => o.status === "ordered").length;
    const received = orders.filter((o) => o.status === "received" || o.status === "partial").length;

    const recent = [...orders].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 15);

    container.innerHTML = `
      <div class="stats-grid">
        <div class="stat-card pending"><div class="num">${pending}</div><div class="label">Pending Requests</div></div>
        <div class="stat-card urgent"><div class="num">${urgent}</div><div class="label">Urgent Items</div></div>
        <div class="stat-card ordered"><div class="num">${ordered}</div><div class="label">Orders Placed</div></div>
        <div class="stat-card received"><div class="num">${received}</div><div class="label">Received</div></div>
      </div>
      <div class="panel">
        <h2>Recent Activity</h2>
        <p class="sub">Latest updates across all locations</p>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Date</th><th>Location</th><th>Item</th><th>Status</th></tr></thead>
            <tbody>
              ${
                recent.length
                  ? recent
                      .map(
                        (o) => `
                <tr>
                  <td>${formatDate(o.date)}</td>
                  <td>${escapeHtml(o.location)}</td>
                  <td>${o.urgent ? "🔴 " : ""}${escapeHtml(o.item_name)}</td>
                  <td><span class="pill pill-${o.status}">${STATUS_LABELS[o.status] || o.status}</span></td>
                </tr>`
                      )
                      .join("")
                  : `<tr><td colspan="4" class="empty-state">No activity yet</td></tr>`
              }
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  // ============================================================
  // Review tab (Order Team / Admin)
  // ============================================================
  function renderReviewTab(container) {
    const pendingRows = state.orders.filter((o) => o.status === "pending");
    const batches = groupBatches(pendingRows).sort((a, b) => {
      if (a.urgent !== b.urgent) return a.urgent ? -1 : 1;
      return new Date(b.date) - new Date(a.date);
    });

    container.innerHTML = `
      <div class="panel">
        <h2>Review Requests</h2>
        <p class="sub">${batches.length} pending batch${batches.length === 1 ? "" : "es"}</p>
        ${batches.length ? "" : `<div class="empty-state">No pending requests right now.</div>`}
        ${batches
          .map(
            (b) => `
          <div class="batch-card ${b.urgent ? "urgent" : ""}" data-batch-key="${escapeHtml(b.key)}">
            <div class="batch-head">
              <div>
                <div class="batch-title">${b.urgent ? "🔴 URGENT — " : ""}${escapeHtml(b.location)}</div>
                <div class="batch-meta">${formatDate(b.date)} • Submitted by ${escapeHtml(ROLE_LABELS[b.submittedBy] || b.submittedBy)} • ${b.rows.length} item${b.rows.length === 1 ? "" : "s"}</div>
              </div>
              <div class="batch-actions">
                <button class="btn btn-sm btn-accent" data-action="place-order">Place Order</button>
                <button class="btn btn-sm btn-ghost" data-action="dismiss">Dismiss</button>
              </div>
            </div>
            <div class="batch-items">
              ${b.rows
                .map(
                  (r) =>
                    `<div class="batch-item-line"><span>${r.urgent ? "🔴 " : ""}${escapeHtml(r.item_name)}</span><span class="qty">${r.qty} × ${escapeHtml(r.item_unit)}</span></div>`
                )
                .join("")}
            </div>
            ${b.notes ? `<div class="batch-notes">Note: ${escapeHtml(b.notes)}</div>` : ""}
          </div>`
          )
          .join("")}
      </div>
    `;

    container.addEventListener("click", (e) => {
      const card = e.target.closest(".batch-card");
      if (!card) return;
      const batch = batches.find((b) => b.key === card.dataset.batchKey);
      if (!batch) return;
      if (e.target.dataset.action === "place-order") openPlaceOrderModal(batch);
      if (e.target.dataset.action === "dismiss") dismissBatch(batch);
    });
  }

  function openPlaceOrderModal(batch) {
    const suppliers = state.config.suppliers;
    openModal(`
      <h3>Place Order</h3>
      <p class="sub">${escapeHtml(batch.location)} — select the items to include in this order</p>
      <div class="field">
        <label for="modal-supplier">Supplier</label>
        <select id="modal-supplier">
          <option value="">Select supplier…</option>
          ${suppliers.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("")}
        </select>
      </div>
      <div class="select-actions">
        <button type="button" class="btn btn-sm btn-ghost" data-action="select-all">Select All</button>
        <button type="button" class="btn btn-sm btn-ghost" data-action="clear-all">Clear All</button>
      </div>
      <div class="modal-row-list">
        ${batch.rows
          .map(
            (r) => `
          <div class="modal-item-row" data-id="${r.id}">
            <input type="checkbox" checked />
            <div class="info">
              <div class="name">${r.urgent ? "🔴 " : ""}${escapeHtml(r.item_name)}</div>
              <div class="meta">${r.qty} × ${escapeHtml(r.item_unit)} • ${escapeHtml(r.category)}</div>
            </div>
          </div>`
          )
          .join("")}
      </div>
      <div class="modal-summary" id="place-order-summary"></div>
      <div class="modal-actions">
        <button class="btn btn-ghost" data-action="cancel">Cancel</button>
        <button class="btn btn-accent" id="confirm-place-order" data-action="confirm">Place Order</button>
      </div>
    `);

    const overlay = $("#active-modal-overlay");

    function updateSummary() {
      const total = batch.rows.length;
      const selected = $all(".modal-item-row", overlay).filter((row) => $("input", row).checked).length;
      $("#place-order-summary", overlay).textContent =
        `${selected} of ${total} item${total === 1 ? "" : "s"} selected — ${total - selected} will remain pending.`;
      const supplierChosen = $("#modal-supplier", overlay).value !== "";
      $("#confirm-place-order", overlay).disabled = selected === 0 || !supplierChosen;
    }

    overlay.addEventListener("change", (e) => {
      if (e.target.id === "modal-supplier") updateSummary();
    });

    overlay.addEventListener("click", async (e) => {
      if (e.target.dataset.action === "cancel") return closeModal();

      const row = e.target.closest(".modal-item-row");
      if (row && !e.target.closest(".row-fields")) {
        const cb = $("input", row);
        cb.checked = !cb.checked;
        row.classList.toggle("off", !cb.checked);
        updateSummary();
        return;
      }

      if (e.target.dataset.action === "select-all") {
        $all(".modal-item-row", overlay).forEach((r) => {
          $("input", r).checked = true;
          r.classList.remove("off");
        });
        updateSummary();
        return;
      }
      if (e.target.dataset.action === "clear-all") {
        $all(".modal-item-row", overlay).forEach((r) => {
          $("input", r).checked = false;
          r.classList.add("off");
        });
        updateSummary();
        return;
      }

      if (e.target.dataset.action === "confirm") {
        const supplier = $("#modal-supplier", overlay).value;
        const selectedIds = $all(".modal-item-row", overlay)
          .filter((row) => $("input", row).checked)
          .map((row) => row.dataset.id);
        if (!supplier || !selectedIds.length) return;

        e.target.disabled = true;
        e.target.textContent = "Placing…";
        try {
          const orderedDate = new Date().toISOString();
          const updated = await db.updateOrdersByIds(selectedIds, {
            status: "ordered",
            supplier,
            ordered_date: orderedDate,
          });
          applyOrderUpdates(updated);
          closeModal();
          toast("Order placed", "success");
          rerenderCurrentTab();
        } catch (err) {
          console.error(err);
          toast("Failed to place order: " + err.message, "error");
          e.target.disabled = false;
          e.target.textContent = "Place Order";
        }
      }
    });

    updateSummary();
  }

  async function dismissBatch(batch) {
    if (!confirm(`Dismiss this ${batch.location} batch? This cannot be undone.`)) return;
    const ids = batch.rows.map((r) => r.id);
    try {
      const updated = await db.updateOrdersByIds(ids, { status: "dismissed" });
      applyOrderUpdates(updated);
      toast("Batch dismissed", "success");
      rerenderCurrentTab();
    } catch (err) {
      console.error(err);
      toast("Failed to dismiss batch: " + err.message, "error");
    }
  }

  function applyOrderUpdates(updatedRows) {
    updatedRows.forEach((u) => {
      const idx = state.orders.findIndex((o) => o.id === u.id);
      if (idx >= 0) state.orders[idx] = u;
    });
  }

  // ============================================================
  // Receiving tab
  // ============================================================
  function renderReceivingTab(container) {
    const orderedRows = state.orders.filter((o) => o.status === "ordered");
    const deliveries = groupDeliveries(orderedRows).sort(
      (a, b) => new Date(b.orderedDate) - new Date(a.orderedDate)
    );

    container.innerHTML = `
      <div class="panel">
        <h2>Receive Deliveries</h2>
        <p class="sub">${deliveries.length} delivery group${deliveries.length === 1 ? "" : "s"} awaiting check-in</p>
        ${deliveries.length ? "" : `<div class="empty-state">No deliveries awaiting check-in.</div>`}
        ${deliveries
          .map(
            (d) => `
          <div class="batch-card" data-group-key="${escapeHtml(d.key)}">
            <div class="batch-head">
              <div>
                <div class="batch-title">${escapeHtml(d.supplier)} — ${escapeHtml(d.location)}</div>
                <div class="batch-meta">Ordered ${formatDate(d.orderedDate)} • ${d.rows.length} item${d.rows.length === 1 ? "" : "s"}</div>
              </div>
              <div class="batch-actions">
                <button class="btn btn-sm btn-accent" data-action="check-in">Check In Delivery</button>
              </div>
            </div>
            <div class="batch-items">
              ${d.rows
                .map(
                  (r) =>
                    `<div class="batch-item-line"><span>${escapeHtml(r.item_name)}</span><span class="qty">${r.qty} × ${escapeHtml(r.item_unit)}</span></div>`
                )
                .join("")}
            </div>
          </div>`
          )
          .join("")}
      </div>
    `;

    container.addEventListener("click", (e) => {
      const card = e.target.closest(".batch-card");
      if (!card || e.target.dataset.action !== "check-in") return;
      const delivery = deliveries.find((d) => d.key === card.dataset.groupKey);
      if (delivery) openCheckInModal(delivery);
    });
  }

  function openCheckInModal(delivery) {
    openModal(`
      <h3>Check In Delivery</h3>
      <p class="sub">${escapeHtml(delivery.supplier)} — ${escapeHtml(delivery.location)}</p>
      <div class="select-actions">
        <button type="button" class="btn btn-sm btn-ghost" data-action="select-all">Select All</button>
        <button type="button" class="btn btn-sm btn-ghost" data-action="clear-all">Clear All</button>
      </div>
      <div class="modal-row-list">
        ${delivery.rows
          .map(
            (r) => `
          <div class="modal-item-row" data-id="${r.id}" data-ordered-qty="${r.qty}">
            <input type="checkbox" checked />
            <div class="info">
              <div class="name">${escapeHtml(r.item_name)}</div>
              <div class="meta">Ordered: ${r.qty} × ${escapeHtml(r.item_unit)}</div>
            </div>
            <div class="row-fields">
              <input type="number" class="qty-received" min="0" value="${r.qty}" />
              <input type="text" class="notes-input" placeholder="Notes (optional)" />
            </div>
          </div>`
          )
          .join("")}
      </div>
      <div class="modal-summary" id="checkin-summary"></div>
      <div class="modal-actions">
        <button class="btn btn-ghost" data-action="cancel">Cancel</button>
        <button class="btn btn-accent" id="confirm-checkin" data-action="confirm">Confirm Receipt</button>
      </div>
    `);

    const overlay = $("#active-modal-overlay");

    function updateSummary() {
      const total = delivery.rows.length;
      const selected = $all(".modal-item-row", overlay).filter((row) => $("input", row).checked).length;
      $("#checkin-summary", overlay).textContent =
        `${selected} of ${total} item${total === 1 ? "" : "s"} being confirmed — ${total - selected} will stay Ordered.`;
      $("#confirm-checkin", overlay).disabled = selected === 0;
    }

    overlay.addEventListener("click", async (e) => {
      if (e.target.dataset.action === "cancel") return closeModal();

      const row = e.target.closest(".modal-item-row");
      if (row && !e.target.closest(".row-fields")) {
        const cb = $("input", row);
        cb.checked = !cb.checked;
        row.classList.toggle("off", !cb.checked);
        updateSummary();
        return;
      }

      if (e.target.dataset.action === "select-all") {
        $all(".modal-item-row", overlay).forEach((r) => {
          $("input", r).checked = true;
          r.classList.remove("off");
        });
        updateSummary();
        return;
      }
      if (e.target.dataset.action === "clear-all") {
        $all(".modal-item-row", overlay).forEach((r) => {
          $("input", r).checked = false;
          r.classList.add("off");
        });
        updateSummary();
        return;
      }

      if (e.target.dataset.action === "confirm") {
        const checkedRows = $all(".modal-item-row", overlay).filter((row) => $("input", row).checked);
        if (!checkedRows.length) return;

        e.target.disabled = true;
        e.target.textContent = "Saving…";
        try {
          const now = new Date().toISOString();
          const updates = await Promise.all(
            checkedRows.map((row) => {
              const orderedQty = parseInt(row.dataset.orderedQty, 10) || 0;
              const receivedQty = Math.max(0, parseInt(row.querySelector(".qty-received").value, 10) || 0);
              const notes = row.querySelector(".notes-input").value.trim();
              const status = receivedQty < orderedQty ? "partial" : "received";
              return db.updateOrderById(row.dataset.id, {
                status,
                received_qty: receivedQty,
                received_date: now,
                receive_notes: notes || null,
              });
            })
          );
          updates.forEach((u) => applyOrderUpdates(u));
          closeModal();
          toast("Delivery checked in", "success");
          rerenderCurrentTab();
        } catch (err) {
          console.error(err);
          toast("Failed to save receipt: " + err.message, "error");
          e.target.disabled = false;
          e.target.textContent = "Confirm Receipt";
        }
      }
    });

    updateSummary();
  }

  // ============================================================
  // History tab (shared, filterable, CSV export)
  // ============================================================
  function renderHistoryTab(container, opts) {
    opts = opts || {};
    const key = opts.forcedLocation ? `${state.activeTab}-locked` : state.activeTab;
    const filters = historyFilters[key] || (historyFilters[key] = { location: "all", status: "all", category: "all" });

    function computeRows() {
      let rows = state.orders.slice();
      if (opts.forcedLocation) {
        rows = rows.filter((o) => o.location === opts.forcedLocation);
      } else if (filters.location !== "all") {
        rows = rows.filter((o) => o.location === filters.location);
      }
      if (filters.status !== "all") rows = rows.filter((o) => o.status === filters.status);
      if (filters.category !== "all") rows = rows.filter((o) => o.category === filters.category);
      rows.sort((a, b) => new Date(b.date) - new Date(a.date));
      return rows;
    }

    function paint() {
      const rows = computeRows();
      const locationFilterHtml = opts.forcedLocation
        ? ""
        : `<select id="filter-location">
            <option value="all">All Locations</option>
            ${state.config.locations.map((l) => `<option value="${escapeHtml(l)}" ${filters.location === l ? "selected" : ""}>${escapeHtml(l)}</option>`).join("")}
          </select>`;

      container.innerHTML = `
        <div class="panel">
          <h2>${escapeHtml(opts.title || "History")}</h2>
          <p class="sub">${opts.forcedLocation ? escapeHtml(opts.forcedLocation) : `${rows.length} record${rows.length === 1 ? "" : "s"}`}</p>
          <div class="filters-row">
            ${locationFilterHtml}
            <select id="filter-status">
              <option value="all">All Statuses</option>
              ${Object.keys(STATUS_LABELS)
                .map((s) => `<option value="${s}" ${filters.status === s ? "selected" : ""}>${STATUS_LABELS[s]}</option>`)
                .join("")}
            </select>
            <select id="filter-category">
              <option value="all">All Categories</option>
              ${state.config.categories
                .map((c) => `<option value="${escapeHtml(c)}" ${filters.category === c ? "selected" : ""}>${escapeHtml(c)}</option>`)
                .join("")}
            </select>
            <button type="button" class="btn btn-sm btn-ghost" id="export-csv-btn">Export CSV</button>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th><th>Location</th><th>Item</th><th>Category</th><th>Qty</th>
                  <th>Supplier</th><th>Status</th><th>Urgent</th><th>Submitted By</th>
                </tr>
              </thead>
              <tbody>
                ${
                  rows.length
                    ? rows
                        .map(
                          (o) => `
                  <tr>
                    <td>${formatDate(o.date)}</td>
                    <td>${escapeHtml(o.location)}</td>
                    <td>${escapeHtml(o.item_name)}</td>
                    <td>${escapeHtml(o.category)}</td>
                    <td>${o.qty}${o.received_qty !== null && o.received_qty !== undefined ? ` (recv ${o.received_qty})` : ""}</td>
                    <td>${escapeHtml(o.supplier || "—")}</td>
                    <td><span class="pill pill-${o.status}">${STATUS_LABELS[o.status] || o.status}</span></td>
                    <td>${o.urgent ? `<span class="pill pill-urgent">Urgent</span>` : ""}</td>
                    <td>${escapeHtml(ROLE_LABELS[o.submitted_by] || o.submitted_by)}</td>
                  </tr>`
                        )
                        .join("")
                    : `<tr><td colspan="9" class="empty-state">No records match these filters</td></tr>`
                }
              </tbody>
            </table>
          </div>
        </div>
      `;

      $("#export-csv-btn", container).addEventListener("click", () => {
        exportCsv(computeRows(), `wce-history-${new Date().toISOString().slice(0, 10)}.csv`);
      });
    }

    paint();

    // Attached once; only reacts to this tab's own filter selects, and
    // repaints in place (not a re-invocation of renderHistoryTab, which
    // would stack a duplicate listener on this same long-lived container).
    container.addEventListener("change", (e) => {
      if (e.target.id === "filter-location") filters.location = e.target.value;
      else if (e.target.id === "filter-status") filters.status = e.target.value;
      else if (e.target.id === "filter-category") filters.category = e.target.value;
      else return;
      paint();
    });
  }

  function exportCsv(rows, filename) {
    const headers = ["Date", "Location", "Item", "Category", "Qty", "Unit", "Supplier", "Status", "Urgent", "Submitted By", "Received Qty", "Notes"];
    const lines = [headers.map(csvEscape).join(",")];
    rows.forEach((r) => {
      lines.push(
        [
          formatDate(r.date),
          r.location,
          r.item_name,
          r.category,
          r.qty,
          r.item_unit,
          r.supplier || "",
          STATUS_LABELS[r.status] || r.status,
          r.urgent ? "Yes" : "No",
          ROLE_LABELS[r.submitted_by] || r.submitted_by,
          r.received_qty === null || r.received_qty === undefined ? "" : r.received_qty,
          r.receive_notes || r.notes || "",
        ]
          .map(csvEscape)
          .join(",")
      );
    });
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // ============================================================
  // Settings tab (Admin)
  // ============================================================
  function renderSettingsTab(container) {
    const cfg = state.config;

    container.innerHTML = `
      <div class="panel settings-section">
        <h2>Inventory Items</h2>
        <p class="sub">Add, remove, and categorize items available for ordering</p>
        <div class="settings-list" id="items-list">
          ${cfg.items
            .map(
              (it) => `
            <div class="settings-list-item">
              <span>${escapeHtml(it.name)} <span class="meta">— ${escapeHtml(it.unit)} • ${escapeHtml(it.category)}</span></span>
              <button type="button" class="btn btn-sm btn-ghost" data-remove-item="${escapeHtml(it.id)}">Remove</button>
            </div>`
            )
            .join("")}
        </div>
        <div class="add-row">
          <input type="text" id="new-item-name" placeholder="Item name" />
          <input type="text" id="new-item-unit" placeholder="Unit (e.g. case (x12))" />
          <select id="new-item-category">
            ${cfg.categories.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("")}
          </select>
          <button type="button" class="btn btn-sm btn-accent" id="add-item-btn">Add Item</button>
        </div>
      </div>

      <div class="panel settings-section">
        <h2>Categories</h2>
        <div class="settings-list" id="categories-list">
          ${cfg.categories
            .map(
              (c) => `
            <div class="settings-list-item">
              <span>${escapeHtml(c)}</span>
              <button type="button" class="btn btn-sm btn-ghost" data-remove-category="${escapeHtml(c)}">Remove</button>
            </div>`
            )
            .join("")}
        </div>
        <div class="add-row">
          <input type="text" id="new-category" placeholder="New category name" />
          <button type="button" class="btn btn-sm btn-accent" id="add-category-btn">Add Category</button>
        </div>
      </div>

      <div class="panel settings-section">
        <h2>Suppliers</h2>
        <div class="settings-list" id="suppliers-list">
          ${cfg.suppliers
            .map(
              (s) => `
            <div class="settings-list-item">
              <span>${escapeHtml(s)}</span>
              <button type="button" class="btn btn-sm btn-ghost" data-remove-supplier="${escapeHtml(s)}">Remove</button>
            </div>`
            )
            .join("")}
        </div>
        <div class="add-row">
          <input type="text" id="new-supplier" placeholder="New supplier name" />
          <button type="button" class="btn btn-sm btn-accent" id="add-supplier-btn">Add Supplier</button>
        </div>
      </div>

      <div class="panel settings-section">
        <h2>Locations</h2>
        <div class="settings-list" id="locations-list">
          ${cfg.locations
            .map(
              (l) => `
            <div class="settings-list-item">
              <span>${escapeHtml(l)}</span>
              <button type="button" class="btn btn-sm btn-ghost" data-remove-location="${escapeHtml(l)}">Remove</button>
            </div>`
            )
            .join("")}
        </div>
        <div class="add-row">
          <input type="text" id="new-location" placeholder="New location name" />
          <button type="button" class="btn btn-sm btn-accent" id="add-location-btn">Add Location</button>
        </div>
      </div>

      <div class="panel settings-section">
        <h2>Role PINs</h2>
        <p class="sub">Minimum 3 characters</p>
        ${["employee", "orderteam", "receiving", "admin"]
          .map(
            (role) => `
          <div class="pin-row">
            <label>${ROLE_LABELS[role]}</label>
            <input type="text" inputmode="numeric" class="pin-input" data-role="${role}" value="${escapeHtml(cfg.pins[role] || "")}" />
          </div>`
          )
          .join("")}
        <button type="button" class="btn btn-accent" id="save-pins-btn">Save PINs</button>
        <div class="error-text" id="pins-error"></div>
      </div>
    `;

    container.addEventListener("click", async (e) => {
      if (e.target.id === "add-item-btn") return addItem(container);
      if (e.target.id === "add-category-btn") return addSimple(container, "categories", "new-category");
      if (e.target.id === "add-supplier-btn") return addSimple(container, "suppliers", "new-supplier");
      if (e.target.id === "add-location-btn") return addSimple(container, "locations", "new-location");
      if (e.target.id === "save-pins-btn") return savePins(container);

      if (e.target.dataset.removeItem) return removeItem(e.target.dataset.removeItem);
      if (e.target.dataset.removeCategory) return removeSimple("categories", e.target.dataset.removeCategory);
      if (e.target.dataset.removeSupplier) return removeSimple("suppliers", e.target.dataset.removeSupplier);
      if (e.target.dataset.removeLocation) return removeSimple("locations", e.target.dataset.removeLocation);
    });
  }

  async function persistConfig(patch) {
    const saved = await db.saveConfig(patch);
    Object.assign(state.config, patch);
    return saved;
  }

  async function addItem(container) {
    const nameEl = $("#new-item-name", container);
    const unitEl = $("#new-item-unit", container);
    const catEl = $("#new-item-category", container);
    const name = nameEl.value.trim();
    const unit = unitEl.value.trim();
    const category = catEl.value;
    if (!name || !unit || !category) {
      toast("Enter a name, unit, and category", "error");
      return;
    }
    const id = uniqueId(slugify(name), state.config.items.map((i) => i.id));
    const items = state.config.items.concat([{ id, name, unit, category }]);
    try {
      await persistConfig({ items });
      toast("Item added", "success");
      rerenderCurrentTab();
    } catch (err) {
      toast("Failed to add item: " + err.message, "error");
    }
  }

  async function removeItem(id) {
    const items = state.config.items.filter((i) => i.id !== id);
    try {
      await persistConfig({ items });
      toast("Item removed", "success");
      rerenderCurrentTab();
    } catch (err) {
      toast("Failed to remove item: " + err.message, "error");
    }
  }

  async function addSimple(container, field, inputId) {
    const input = $("#" + inputId, container);
    const val = input.value.trim();
    if (!val) return;
    if (state.config[field].includes(val)) {
      toast("Already exists", "error");
      return;
    }
    const list = state.config[field].concat([val]);
    try {
      await persistConfig({ [field]: list });
      toast("Added", "success");
      rerenderCurrentTab();
    } catch (err) {
      toast("Failed to save: " + err.message, "error");
    }
  }

  async function removeSimple(field, val) {
    const list = state.config[field].filter((v) => v !== val);
    try {
      await persistConfig({ [field]: list });
      toast("Removed", "success");
      rerenderCurrentTab();
    } catch (err) {
      toast("Failed to remove: " + err.message, "error");
    }
  }

  async function savePins(container) {
    const errEl = $("#pins-error", container);
    errEl.textContent = "";
    const pins = {};
    let valid = true;
    $all(".pin-input", container).forEach((input) => {
      const val = input.value.trim();
      if (val.length < 3) valid = false;
      pins[input.dataset.role] = val;
    });
    if (!valid) {
      errEl.textContent = "Each PIN must be at least 3 characters.";
      return;
    }
    try {
      await persistConfig({ pins });
      toast("PINs updated", "success");
    } catch (err) {
      errEl.textContent = "Failed to save PINs: " + err.message;
    }
  }

  // ============================================================
  // Auth
  // ============================================================
  function populateLoginLocations() {
    const sel = $("#login-location");
    sel.innerHTML = state.config.locations.map((l) => `<option value="${escapeHtml(l)}">${escapeHtml(l)}</option>`).join("");
  }

  async function handleLoginSubmit(e) {
    e.preventDefault();
    const errEl = $("#login-error");
    errEl.textContent = "";
    const location = $("#login-location").value;
    const role = $("#login-role").value;
    const pin = $("#login-pin").value.trim();

    if (!db.isConfigured) {
      errEl.textContent = "Supabase is not configured. Contact your admin.";
      return;
    }

    const expectedPin = state.config.pins ? state.config.pins[role] : null;
    if (!expectedPin || pin !== expectedPin) {
      errEl.textContent = "Incorrect PIN.";
      return;
    }

    state.session = { location, role };
    localStorage.setItem(SESSION_KEY, JSON.stringify(state.session));
    $("#login-pin").value = "";
    await afterLogin();
  }

  async function afterLogin() {
    state.activeTab = ROLE_TABS[state.session.role][0];
    try {
      state.orders = await db.fetchOrders();
    } catch (err) {
      console.error(err);
      toast("Failed to load orders: " + err.message, "error");
    }
    startRealtime();
    renderShell();
  }

  function signOut() {
    localStorage.removeItem(SESSION_KEY);
    state.session = null;
    state.orders = [];
    stopRealtime();
    renderShell();
  }

  // ============================================================
  // Realtime
  // ============================================================
  const refetchOrders = debounce(async () => {
    try {
      state.orders = await db.fetchOrders();
      rerenderCurrentTab();
    } catch (err) {
      console.error(err);
    }
  }, 350);

  const refetchConfig = debounce(async () => {
    try {
      const cfg = await db.fetchConfig();
      state.config = cfg;
      if (state.session) rerenderCurrentTab();
    } catch (err) {
      console.error(err);
    }
  }, 350);

  function startRealtime() {
    stopRealtime();
    realtimeChannel = db.subscribeRealtime({
      onOrdersChange: refetchOrders,
      onConfigChange: refetchConfig,
      onStatus: (status) => {
        state.syncStatus = status;
        renderSyncBadge();
      },
    });
  }

  function stopRealtime() {
    if (realtimeChannel && realtimeChannel.unsubscribe) realtimeChannel.unsubscribe();
    realtimeChannel = null;
  }

  // ============================================================
  // Boot
  // ============================================================
  async function boot() {
    $("#login-form").addEventListener("submit", handleLoginSubmit);
    $("#signout-btn").addEventListener("click", signOut);

    if (!db.isConfigured) {
      $("#login-error").textContent = "Supabase is not configured (missing SUPABASE_URL / SUPABASE_ANON_KEY).";
      $("#login-location").innerHTML = `<option>Unavailable</option>`;
      return;
    }

    try {
      state.config = await db.fetchConfig();
    } catch (err) {
      console.error(err);
      $("#login-error").textContent = "Unable to connect to Supabase. Check your configuration.";
      return;
    }
    populateLoginLocations();

    const saved = localStorage.getItem(SESSION_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed && parsed.location && parsed.role) {
          state.session = parsed;
          await afterLogin();
        }
      } catch (err) {
        localStorage.removeItem(SESSION_KEY);
      }
    }
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
