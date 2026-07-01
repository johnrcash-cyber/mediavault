const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => document.querySelectorAll(selector);
const state = { query: "", type: "", status: "", view: "dashboard", items: [], jellyfinPreview: null, previewCategory: "matches" };
const typeIcons = { Movies: "▶", Television: "TV", Music: "♫", Games: "✦", Books: "B", Other: "MV" };

async function api(url, options = {}) {
  const response = await fetch(url, { headers: { "Content-Type": "application/json" }, ...options });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "Something went wrong.");
  }
  return response.status === 204 ? null : response.json();
}

function escapeHtml(value = "") {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

function card(item) {
  const statusClass = item.status === "Wishlist" ? "wishlist" : item.status === "Upgrade Candidate" ? "upgrade" : "";
  return `<article class="media-card type-${escapeHtml(item.media_type)}" data-id="${item.id}">
    <div class="cover"><span class="cover-icon">${typeIcons[item.media_type] || "MV"}</span><span class="format-badge">${escapeHtml(item.format)}</span></div>
    <div class="card-body"><h3 title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</h3>
      <p>${item.year || "Year unknown"} · ${escapeHtml(item.media_type)}</p>
      <div class="card-meta"><span class="status-pill ${statusClass}">${escapeHtml(item.status)}</span><span>${escapeHtml(item.physical_location || item.condition || "")}</span></div>
    </div></article>`;
}

function emptyState(isFiltered = false) {
  return `<div class="empty-state"><strong>${isFiltered ? "Nothing matches that search." : "Your vault is ready."}</strong>
    <span>${isFiltered ? "Try another title, UPC, tag, or filter." : "Add your first movie, album, game, book, or treasured oddity."}</span>
    ${isFiltered ? "" : '<br><button class="button primary empty-add">＋ Add your first item</button>'}</div>`;
}

async function loadDashboard() {
  const data = await api("/api/dashboard");
  $("#totalCount").textContent = data.total;
  $("#movieCount").textContent = data.movies;
  $("#musicCount").textContent = data.music;
  $("#gameCount").textContent = data.games;
  $("#wishlistCount").textContent = data.wishlist;
  $("#recentGrid").innerHTML = data.recent.length ? data.recent.map(card).join("") : emptyState();
}

async function loadCollection() {
  const params = new URLSearchParams();
  if (state.query) params.set("q", state.query);
  if (state.type) params.set("type", state.type);
  if (state.status) params.set("status", state.status);
  state.items = await api(`/api/media?${params}`);
  $("#collectionGrid").innerHTML = state.items.length ? state.items.map(card).join("") : emptyState(Boolean(state.query || state.type || state.status));
  $("#collectionTitle").textContent = state.type || state.status || "My Collection";
  $("#resultSummary").textContent = `${state.items.length} ${state.items.length === 1 ? "item" : "items"} found`;
}

function setView(view, filters = {}) {
  state.view = view;
  if ("type" in filters) state.type = filters.type;
  if ("status" in filters) state.status = filters.status;
  $("#dashboardView").hidden = view !== "dashboard";
  $("#collectionView").hidden = view !== "collection";
  $("#settingsView").hidden = view !== "settings";
  $$(".nav-link").forEach((el) => el.classList.remove("active"));
  $(`[data-view="${view}"]`)?.classList.add("active");
  $("#typeFilter").value = state.type;
  $("#statusFilter").value = state.status;
  $(".sidebar").classList.remove("open");
  if (view === "collection") loadCollection();
  if (view === "settings") loadJellyfinSettings();
}

async function loadJellyfinSettings() {
  try {
    const data = await api("/api/settings/jellyfin");
    $("#jellyfinUrl").value = data.server_url || "";
    $("#jellyfinName").value = data.server_name || "";
    $("#jellyfinKey").value = "";
    $("#jellyfinKey").placeholder = data.has_api_key ? "API key saved — leave blank to keep it" : "Enter your Jellyfin API key";
    $("#apiKeyHint").textContent = data.has_api_key ? "An API key is stored locally. Enter a new one to replace it." : "Stored locally in MediaVault.";
    $("#importJellyfin").disabled = !(data.server_url && data.has_api_key);
  } catch (error) { $("#jellyfinError").textContent = error.message; }
}

function jellyfinFormData() {
  return {
    server_url: $("#jellyfinUrl").value.trim(),
    api_key: $("#jellyfinKey").value.trim(),
    server_name: $("#jellyfinName").value.trim(),
  };
}

function setConnectionStatus(ok, message = "") {
  $("#jellyfinBadge").textContent = ok ? "Connected" : message || "Connection failed";
  $("#jellyfinBadge").classList.toggle("connected", ok);
  $("#connectionResult").hidden = !ok;
}

function renderLibraries(libraries) {
  $("#libraryList").innerHTML = libraries.length
    ? libraries.map((library) => `<span><i></i>${escapeHtml(library.name)} <small>${escapeHtml(library.type)}</small></span>`).join("")
    : "<span>No libraries found</span>";
}

function renderPreview(category = state.previewCategory) {
  state.previewCategory = category;
  $$(".preview-tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.preview === category));
  const items = state.jellyfinPreview?.[category] || [];
  $("#previewRows").innerHTML = items.length ? items.map((item) => {
    const match = item.media_match;
    const matchText = match
      ? `<div class="match-target"><small>MEDIAVAULT MATCH</small><strong>${escapeHtml(match.title)}</strong><span>${match.year || "Year unknown"} · ${escapeHtml(match.format)}</span></div>`
      : `<div class="match-target empty"><small>MEDIAVAULT</small><strong>No catalog match</strong><span>A new record can be created explicitly.</span></div>`;
    return `<article class="preview-row" data-source-id="${escapeHtml(item.jellyfin_item_id)}">
      <div class="source-title"><span class="integration-mark small">J</span><div><small>${escapeHtml(item.library_name)}</small><strong>${escapeHtml(item.title)}</strong><span>${item.year || "Year unknown"}</span></div></div>
      <span class="match-arrow">→</span>${matchText}
      <div class="preview-actions">
        ${match ? `<button class="button secondary source-action" data-action="attach" data-media-id="${match.id}">Attach Jellyfin Source</button>` : ""}
        <button class="button secondary source-action" data-action="create">Create MediaVault Item</button>
        <button class="text-button source-action" data-action="ignore">Ignore</button>
      </div>
    </article>`;
  }).join("") : `<div class="empty-state"><strong>Nothing waiting here.</strong><span>All items in this category have been reviewed.</span></div>`;
}

async function loadImportPreview() {
  $("#jellyfinError").textContent = "";
  $("#importJellyfin").disabled = true;
  $("#importJellyfin").textContent = "Scanning Movies…";
  try {
    state.jellyfinPreview = await api("/api/jellyfin/import-preview", { method: "POST", body: "{}" });
    $("#matchCount").textContent = state.jellyfinPreview.matches.length;
    $("#possibleCount").textContent = state.jellyfinPreview.possible_matches.length;
    $("#newCount").textContent = state.jellyfinPreview.new_items.length;
    $("#previewCount").textContent = `${state.jellyfinPreview.total} TO REVIEW`;
    $("#importPreview").hidden = false;
    state.previewCategory = state.jellyfinPreview.matches.length ? "matches" : state.jellyfinPreview.possible_matches.length ? "possible_matches" : "new_items";
    renderPreview();
  } catch (error) { $("#jellyfinError").textContent = error.message; }
  finally { $("#importJellyfin").disabled = false; $("#importJellyfin").textContent = "Import Library"; }
}

function openModal(item = null) {
  $("#mediaForm").reset();
  $("#formError").textContent = "";
  $("#itemId").value = item?.id || "";
  $("#modalTitle").textContent = item ? "Edit catalog item" : "Add to your vault";
  $("#saveButton").textContent = item ? "Save changes" : "Add to collection";
  $("#deleteButton").hidden = !item;
  if (item) {
    Object.entries(item).forEach(([key, value]) => {
      const field = $(`[name="${key}"]`);
      if (field) field.value = Array.isArray(value) ? value.join(", ") : (value ?? "");
    });
  } else {
    $('[name="status"]').value = "In Collection";
    $('[name="condition"]').value = "Good";
  }
  $("#modal").hidden = false;
  document.body.style.overflow = "hidden";
  setTimeout(() => $('[name="title"]').focus(), 30);
}

function closeModal() {
  $("#modal").hidden = true;
  document.body.style.overflow = "";
}

function toast(message) {
  $("#toast").textContent = message;
  $("#toast").classList.add("show");
  setTimeout(() => $("#toast").classList.remove("show"), 2200);
}

document.addEventListener("click", async (event) => {
  const mediaCard = event.target.closest(".media-card");
  if (mediaCard) {
    try { openModal(await api(`/api/media/${mediaCard.dataset.id}`)); } catch (error) { toast(error.message); }
  }
  if (event.target.closest(".empty-add")) openModal();
  const sourceButton = event.target.closest(".source-action");
  if (sourceButton) {
    const row = sourceButton.closest(".preview-row");
    const categories = ["matches", "possible_matches", "new_items"];
    const item = categories.flatMap((key) => state.jellyfinPreview?.[key] || [])
      .find((candidate) => candidate.jellyfin_item_id === row.dataset.sourceId);
    if (!item) return;
    sourceButton.disabled = true;
    try {
      await api("/api/jellyfin/import-action", {
        method: "POST",
        body: JSON.stringify({
          action: sourceButton.dataset.action,
          media_id: sourceButton.dataset.mediaId || null,
          item,
        }),
      });
      state.jellyfinPreview[state.previewCategory] = state.jellyfinPreview[state.previewCategory]
        .filter((candidate) => candidate.jellyfin_item_id !== item.jellyfin_item_id);
      state.jellyfinPreview.total -= 1;
      const countIds = { matches: "#matchCount", possible_matches: "#possibleCount", new_items: "#newCount" };
      $(countIds[state.previewCategory]).textContent = state.jellyfinPreview[state.previewCategory].length;
      $("#previewCount").textContent = `${state.jellyfinPreview.total} TO REVIEW`;
      renderPreview();
      loadDashboard();
      toast(sourceButton.dataset.action === "ignore" ? "Jellyfin item ignored." : "Jellyfin source handled.");
    } catch (error) { toast(error.message); sourceButton.disabled = false; }
  }
});

$("#mediaForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = Object.fromEntries(new FormData(event.currentTarget));
  const id = $("#itemId").value;
  try {
    await api(id ? `/api/media/${id}` : "/api/media", { method: id ? "PUT" : "POST", body: JSON.stringify(formData) });
    closeModal();
    toast(id ? "Item updated." : "Added to your vault.");
    await Promise.all([loadDashboard(), state.view === "collection" ? loadCollection() : Promise.resolve()]);
  } catch (error) { $("#formError").textContent = error.message; }
});

$("#deleteButton").addEventListener("click", async () => {
  const id = $("#itemId").value;
  if (!id || !confirm("Remove this item from your catalog?")) return;
  try {
    await api(`/api/media/${id}`, { method: "DELETE" });
    closeModal(); toast("Item removed.");
    await Promise.all([loadDashboard(), state.view === "collection" ? loadCollection() : Promise.resolve()]);
  } catch (error) { $("#formError").textContent = error.message; }
});

let searchTimer;
$("#searchInput").addEventListener("input", (event) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.query = event.target.value.trim(); setView("collection"); }, 180);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)) { event.preventDefault(); $("#searchInput").focus(); }
  if (event.key === "Escape" && !$("#modal").hidden) closeModal();
});

$$("[data-view]").forEach((el) => el.addEventListener("click", () => setView(el.dataset.view, { type: "", status: "" })));
$$(".type-link").forEach((el) => el.addEventListener("click", () => setView("collection", { type: el.dataset.type, status: "" })));
$$(".status-link").forEach((el) => el.addEventListener("click", () => setView("collection", { type: "", status: el.dataset.status })));
$$(".stat-card[data-stat-filter]").forEach((el) => el.addEventListener("click", () => setView("collection", { type: el.dataset.statFilter, status: "" })));
$("#wishlistCard").addEventListener("click", () => setView("collection", { type: "", status: "Wishlist" }));
$("#viewAll").addEventListener("click", () => setView("collection", { type: "", status: "" }));
$("#typeFilter").addEventListener("change", (e) => { state.type = e.target.value; loadCollection(); });
$("#statusFilter").addEventListener("change", (e) => { state.status = e.target.value; loadCollection(); });
$("#clearFilters").addEventListener("click", () => { state.type = ""; state.status = ""; state.query = ""; $("#searchInput").value = ""; $("#typeFilter").value = ""; $("#statusFilter").value = ""; loadCollection(); });
$("#addButton").addEventListener("click", () => openModal());
$("#closeModal").addEventListener("click", closeModal);
$("#cancelButton").addEventListener("click", closeModal);
$("#modal").addEventListener("click", (e) => { if (e.target === $("#modal")) closeModal(); });
$("#menuButton").addEventListener("click", () => $(".sidebar").classList.toggle("open"));
$("#jellyfinForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#jellyfinError").textContent = "";
  try {
    await api("/api/settings/jellyfin", { method: "POST", body: JSON.stringify(jellyfinFormData()) });
    $("#jellyfinKey").value = "";
    $("#jellyfinKey").placeholder = "API key saved — leave blank to keep it";
    $("#importJellyfin").disabled = false;
    toast("Jellyfin settings saved.");
  } catch (error) { $("#jellyfinError").textContent = error.message; }
});
$("#testJellyfin").addEventListener("click", async () => {
  $("#jellyfinError").textContent = "";
  $("#testJellyfin").disabled = true;
  $("#testJellyfin").textContent = "Connecting…";
  setConnectionStatus(false, "Testing…");
  try {
    const data = await api("/api/jellyfin/test", { method: "POST", body: JSON.stringify(jellyfinFormData()) });
    setConnectionStatus(true);
    $("#connectedServer").textContent = `${data.server_name}${data.version ? ` · Jellyfin ${data.version}` : ""}`;
    if (!$("#jellyfinName").value) $("#jellyfinName").value = data.server_name;
    renderLibraries(data.libraries);
    $("#importJellyfin").disabled = false;
  } catch (error) { setConnectionStatus(false); $("#jellyfinError").textContent = error.message; }
  finally { $("#testJellyfin").disabled = false; $("#testJellyfin").textContent = "Test Connection"; }
});
$("#importJellyfin").addEventListener("click", loadImportPreview);
$$(".preview-tab").forEach((tab) => tab.addEventListener("click", () => renderPreview(tab.dataset.preview)));
$("#today").textContent = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date()).toUpperCase();

loadDashboard().catch((error) => toast(error.message));
