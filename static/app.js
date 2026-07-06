const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => document.querySelectorAll(selector);
const savedDisplayView = localStorage.getItem("mediavault_display_view");
const sortableKeys = ["title", "year", "media_type", "runtime", "format", "status", "provider", "rating", "enrichment"];
const savedSortKey = localStorage.getItem("mediavault_sort_key");
const savedSortDirection = localStorage.getItem("mediavault_sort_direction");
const state = { query: "", type: "", status: "", origin: "", view: "dashboard", displayView: ["poster", "list"].includes(savedDisplayView) ? savedDisplayView : "poster", sortKey: sortableKeys.includes(savedSortKey) ? savedSortKey : "", sortDirection: ["asc", "desc"].includes(savedSortDirection) ? savedSortDirection : "asc", items: [], wishlistItems: [], wishlistDetailItem: null, returnToWishlistDetail: false, jellyfinPreview: null, previewCategory: "matches", quickItem: null, providerPriority: "omdb,tmdb", musicProviderPriority: "musicbrainz,discogs,coverartarchive,lastfm", musicProviders: ["musicbrainz"], settingsTab: "sources", catalogPreview: null, catalogCategory: "new_items" };
const typeIcons = { Movies: "▶", Television: "TV", Music: "♫", Games: "✦", Books: "B", Other: "MV" };

async function api(url, options = {}) {
  const response = await fetch(url, { headers: { "Content-Type": "application/json" }, ...options });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "Something went wrong.");
  }
  return response.status === 204 ? null : response.json();
}

const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function startAndPollMetadataRefresh(onUpdate = () => {}) {
  let result = await api("/api/metadata/refresh-all", {
    method: "POST",
    body: "{}",
  });
  onUpdate(result);
  while (result.status === "running") {
    await wait(1500);
    result = await api("/api/metadata/refresh-all/status");
    onUpdate(result);
  }
  return result;
}

function escapeHtml(value = "") {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

function wishlistStatusDisplay(item) {
  const status = ["wanted", "acquired", "dismissed"].includes(item.wishlist_status)
    ? item.wishlist_status
    : "wanted";
  return { status, label: status.charAt(0).toUpperCase() + status.slice(1) };
}

function card(item, options = {}) {
  const isWishlist = Boolean(options.wishlist);
  const wishlistStatus = isWishlist ? wishlistStatusDisplay(item) : null;
  const statusClass = item.status === "Archived" ? "archived" : "";
  const primarySource = (item.sources || [])[0] || "";
  const topBadge = primarySource || item.metadata_provider || "";
  const providerClass = topBadge.toLowerCase();
  const detailBits = [
    item.year || "Year unknown",
    item.media_type,
    item.artist || "",
    item.runtime_minutes ? `${item.runtime_minutes} min` : "",
  ].filter(Boolean).join(" · ");
  const summary = item.overview || item.notes || "";
  const enrichmentStatus = item.enrichment_status || item.metadata_status || "";
  return `<article class="media-card media-item-entry type-${escapeHtml(item.media_type)}${isWishlist ? " wishlist-card wishlist-item-entry" : ""}" ${isWishlist ? `data-wishlist-id="${item.id}"` : `data-id="${item.id}"`}>
    <div class="cover ${item.poster_url ? "has-poster" : ""}">
      ${item.poster_url ? `<img src="${escapeHtml(item.poster_url)}" alt="" loading="lazy">` : `<span class="cover-icon">${typeIcons[item.media_type] || "MV"}</span>`}
      ${isWishlist ? '<span class="wishlist-badge">♡ Wishlist</span>' : ""}
      ${topBadge ? `<span class="provider-badge ${providerClass}">${escapeHtml(topBadge)}</span>` : ""}
      ${item.format ? `<span class="format-badge">${escapeHtml(item.format)}</span>` : ""}
    </div>
    <div class="card-body"><h3 title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</h3>
      <p class="card-details">${escapeHtml(detailBits)}</p>
      ${summary ? `<p class="card-summary">${escapeHtml(summary)}</p>` : `<p class="card-summary empty">${enrichmentStatus === "Pending" ? "Metadata pending…" : enrichmentStatus === "Failed" ? "Metadata enrichment failed." : "Metadata not found."}</p>`}
      ${isWishlist ? `<div class="card-meta wishlist-card-meta"><span class="wishlist-card-status ${wishlistStatus.status}">♡ Wishlist · ${escapeHtml(wishlistStatus.label)}</span><span>${escapeHtml(enrichmentStatus)}</span></div>` : ""}
      <div class="catalog-card-meta card-meta"><span class="status-pill ${statusClass}">${escapeHtml(item.status)}</span><span class="rating">${item.rating ? `★ ${Number(item.rating).toFixed(1)}` : escapeHtml(item.physical_location || item.condition || "")}</span></div>
    </div></article>`;
}

function emptyState(isFiltered = false) {
  return `<div class="empty-state"><strong>${isFiltered ? "Nothing matches that search." : "Your vault is ready."}</strong>
    <span>${isFiltered ? "Try another title, UPC, tag, or filter." : "Add your first movie, album, game, book, or treasured oddity."}</span>
    ${isFiltered ? "" : '<br><button class="button primary empty-add">＋ Add your first item</button>'}</div>`;
}

function compactListItem(item, options = {}) {
  const isWishlist = Boolean(options.wishlist);
  const wishlistStatus = isWishlist ? wishlistStatusDisplay(item) : null;
  const details = [
    item.year || "Year unknown", item.media_type, item.artist || "",
    item.runtime_minutes ? `${item.runtime_minutes} min` : "",
  ].filter(Boolean).join(" · ");
  const status = isWishlist ? `Wishlist · ${wishlistStatus.label}` : (item.status || "Unassigned");
  const provider = item.metadata_provider || "";
  const enrichment = item.enrichment_status || item.metadata_status || "";
  return `<article class="compact-media-row media-item-entry${isWishlist ? " wishlist-item-entry" : ""}" ${isWishlist ? `data-wishlist-id="${item.id}"` : `data-id="${item.id}"`}>
    <div class="compact-media-poster type-${escapeHtml(item.media_type)}">
      ${item.poster_url ? `<img src="${escapeHtml(item.poster_url)}" alt="" loading="lazy">` : `<span>${typeIcons[item.media_type] || "MV"}</span>`}
    </div>
    <div class="compact-media-title"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(details)}</small></div>
    <div class="compact-media-badges">
      ${item.format ? `<span class="compact-badge format">${escapeHtml(item.format)}</span>` : ""}
      ${provider ? `<span class="compact-badge provider">${escapeHtml(provider)}</span>` : ""}
    </div>
    <div class="compact-media-status${isWishlist ? ` wishlist-status-${wishlistStatus.status}` : ""}"><strong>${escapeHtml(status)}</strong>${isWishlist && enrichment ? `<small>${escapeHtml(enrichment)}</small>` : ""}</div>
    <div class="compact-media-rating">${item.rating ? `★ ${Number(item.rating).toFixed(1)}` : ""}</div>
  </article>`;
}

function syncDisplayViewControls() {
  $$("[data-display-view]").forEach((button) => {
    const active = button.dataset.displayView === state.displayView;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function compactSortableListItem(item, options = {}) {
  const isWishlist = Boolean(options.wishlist);
  const wishlistStatus = isWishlist ? wishlistStatusDisplay(item) : null;
  const provider = item.metadata_provider || "";
  const enrichment = item.enrichment_status || item.metadata_status || "";
  const status = isWishlist
    ? `Wishlist · ${wishlistStatus.label}`
    : (item.status || "Unassigned");
  return `<article class="compact-media-row sortable-row media-item-entry${isWishlist ? " wishlist-item-entry wishlist-sortable-row" : ""}" ${isWishlist ? `data-wishlist-id="${item.id}"` : `data-id="${item.id}"`}>
    <div class="compact-media-poster type-${escapeHtml(item.media_type)}">${item.poster_url ? `<img src="${escapeHtml(item.poster_url)}" alt="" loading="lazy">` : `<span>${typeIcons[item.media_type] || "MV"}</span>`}</div>
    <div class="compact-media-title"><strong>${escapeHtml(item.title)}</strong>${item.artist ? `<small>${escapeHtml(item.artist)}</small>` : ""}</div>
    <div class="compact-list-value numeric">${item.year || "—"}</div>
    <div class="compact-list-value">${escapeHtml(item.media_type || "—")}</div>
    <div class="compact-list-value numeric">${item.runtime_minutes ? `${item.runtime_minutes} min` : "—"}</div>
    <div class="compact-list-value">${escapeHtml(item.format || "—")}</div>
    <div class="compact-media-status${isWishlist ? ` wishlist-status-${wishlistStatus.status}` : ""}"><strong>${escapeHtml(status)}</strong></div>
    <div class="compact-list-value provider-value">${escapeHtml(provider || "—")}</div>
    <div class="compact-media-rating">${item.rating !== null && item.rating !== undefined && item.rating !== "" ? `★ ${Number(item.rating).toFixed(1)}` : "—"}</div>
    ${isWishlist ? `<div class="compact-list-value enrichment-value">${escapeHtml(enrichment || "—")}</div>` : ""}
  </article>`;
}

function sortHeaderButton(key, label) {
  const active = state.sortKey === key;
  const arrow = active ? (state.sortDirection === "asc" ? " ↑" : " ↓") : "";
  return `<button type="button" data-sort-key="${key}" class="${active ? "active" : ""}" aria-label="Sort by ${label}">${label}${arrow}</button>`;
}

function compactListHeader(isWishlist = false) {
  return `<div class="compact-list-header${isWishlist ? " wishlist-sortable-row" : ""}">
    <span aria-hidden="true"></span>
    ${sortHeaderButton("title", "Title")}
    ${sortHeaderButton("year", "Year")}
    ${sortHeaderButton("media_type", "Media Type")}
    ${sortHeaderButton("runtime", "Runtime")}
    ${sortHeaderButton("format", "Format")}
    ${sortHeaderButton("status", "Status")}
    ${sortHeaderButton("provider", "Provider")}
    ${sortHeaderButton("rating", "Rating")}
    ${isWishlist ? sortHeaderButton("enrichment", "Enrichment") : ""}
  </div>`;
}

function sortValue(item, key, isWishlist) {
  if (key === "runtime") return item.runtime_minutes;
  if (key === "provider") return item.metadata_provider;
  if (key === "enrichment") return item.enrichment_status || item.metadata_status;
  if (key === "status" && isWishlist) return wishlistStatusDisplay(item).status;
  return item[key];
}

function sortedListItems(items, isWishlist = false) {
  if (!state.sortKey) return [...items];
  const numericKeys = new Set(["year", "runtime", "rating"]);
  return items.map((item, index) => ({ item, index })).sort((left, right) => {
    const a = sortValue(left.item, state.sortKey, isWishlist);
    const b = sortValue(right.item, state.sortKey, isWishlist);
    const aMissing = a === null || a === undefined || a === "";
    const bMissing = b === null || b === undefined || b === "";
    if (aMissing !== bMissing) return aMissing ? 1 : -1;
    if (aMissing && bMissing) return left.index - right.index;
    let comparison;
    if (numericKeys.has(state.sortKey)) {
      comparison = Number(a) - Number(b);
    } else {
      comparison = String(a).localeCompare(String(b), undefined, {
        sensitivity: "base", numeric: true,
      });
    }
    if (comparison === 0) return left.index - right.index;
    return state.sortDirection === "asc" ? comparison : -comparison;
  }).map(({ item }) => item);
}

function setSortKey(key) {
  if (!sortableKeys.includes(key)) return;
  if (state.sortKey === key) {
    state.sortDirection = state.sortDirection === "asc" ? "desc" : "asc";
  } else {
    state.sortKey = key;
    state.sortDirection = "asc";
  }
  localStorage.setItem("mediavault_sort_key", state.sortKey);
  localStorage.setItem("mediavault_sort_direction", state.sortDirection);
  if (state.view === "collection") renderCollectionItems();
  if (state.view === "wishlist") renderWishlistItems();
}

function renderCollectionItems() {
  const container = $("#collectionGrid");
  container.classList.toggle("compact-list", state.displayView === "list");
  container.innerHTML = state.items.length
    ? (state.displayView === "list"
      ? compactListHeader() + sortedListItems(state.items).map((item) =>
        compactSortableListItem(item)).join("")
      : state.items.map(card).join(""))
    : emptyState(Boolean(state.query || state.type || state.status));
}

function renderWishlistItems() {
  const container = $("#wishlistGrid");
  container.classList.toggle("compact-list", state.displayView === "list");
  const mappedItems = state.wishlistItems.map(wishlistCardData);
  container.innerHTML = state.wishlistItems.length
    ? (state.displayView === "list"
      ? compactListHeader(true) + sortedListItems(mappedItems, true).map((item) =>
        compactSortableListItem(item, { wishlist: true })).join("")
      : mappedItems.map((item) => card(item, { wishlist: true })).join(""))
    : `<div class="empty-state"><strong>Your Wishlist is empty.</strong><span>Add a title you want to remember.</span><br><button class="button primary" data-add-wishlist>＋ Add Wishlist Item</button></div>`;
}

function setDisplayView(view) {
  if (!["poster", "list"].includes(view)) return;
  state.displayView = view;
  localStorage.setItem("mediavault_display_view", view);
  syncDisplayViewControls();
  if (state.view === "collection") renderCollectionItems();
  if (state.view === "wishlist") renderWishlistItems();
}

async function loadDashboard() {
  const data = await api("/api/dashboard");
  $("#totalCount").textContent = data.total;
  $("#movieCount").textContent = data.movies;
  $("#televisionCount").textContent = data.television;
  $("#musicCount").textContent = data.music;
  $("#gameCount").textContent = data.games;
  $("#dashboardWishlistCount").textContent = data.wishlist;
  $("#recentGrid").innerHTML = data.recent.length ? data.recent.map(card).join("") : emptyState();
}

async function loadCollection() {
  const params = new URLSearchParams();
  if (state.query) params.set("q", state.query);
  if (state.type) params.set("type", state.type);
  if (state.status) params.set("status", state.status);
  if (state.origin) params.set("source", state.origin);
  state.items = await api(`/api/media?${params}`);
  renderCollectionItems();
  $("#collectionTitle").textContent = state.origin === "manual" ? "Manual Items" : state.type || state.status || "My Library";
  $("#resultSummary").textContent = `${state.items.length} ${state.items.length === 1 ? "item" : "items"} found`;
}

function wishlistRow(item) {
  const details = [item.year, item.media_type].filter(Boolean).join(" · ");
  return `<article class="wishlist-row" data-wishlist-id="${item.id}">
    <div class="wishlist-row-icon">♡</div>
    <div class="wishlist-row-main"><h3>${escapeHtml(item.title)}</h3>${details ? `<p>${escapeHtml(details)}</p>` : ""}${item.notes ? `<span>${escapeHtml(item.notes)}</span>` : ""}</div>
    <span class="wishlist-metadata-status">${escapeHtml(item.metadata_status)}</span>
    <div class="wishlist-row-actions"><button class="text-button" data-wishlist-action="edit">Edit</button><button class="text-button danger-text" data-wishlist-action="delete">Delete</button></div>
  </article>`;
}

function wishlistCardData(item) {
  const mediaTypes = {
    Movie: "Movies", Television: "Television", Music: "Music",
    Game: "Games", Book: "Books", Other: "Other",
  };
  return {
    ...item,
    media_type: mediaTypes[item.media_type] || item.media_type || "Other",
    metadata_provider: item.provider || "",
    format: "",
    sources: [],
  };
}

let wishlistRefreshTimer;
async function loadWishlist() {
  state.wishlistItems = await api("/api/wishlist");
  if (!$("#wishlistDetail").hidden && state.wishlistDetailItem) {
    const refreshedDetail = state.wishlistItems.find(
      (item) => item.id === state.wishlistDetailItem.id
    );
    if (refreshedDetail) openWishlistDetail(refreshedDetail);
  }
  $("#wishlistCount").textContent = `${state.wishlistItems.length} ${state.wishlistItems.length === 1 ? "item" : "items"}`;
  $("#wishlistGrid").innerHTML = state.wishlistItems.length
    ? state.wishlistItems.map((item) =>
      card(wishlistCardData(item), { wishlist: true })
    ).join("")
    : `<div class="empty-state"><strong>Your Wishlist is empty.</strong><span>Add a title you want to remember.</span><br><button class="button primary" data-add-wishlist>＋ Add Wishlist Item</button></div>`;
  renderWishlistItems();
  scheduleWishlistRefresh();
}

function scheduleWishlistRefresh() {
  clearTimeout(wishlistRefreshTimer);
  if (state.view === "wishlist" && state.wishlistItems.some((item) =>
    (item.enrichment_status || item.metadata_status) === "Pending"
  )) {
    wishlistRefreshTimer = setTimeout(loadWishlist, 2500);
  }
}

const mediaTypeRoutes = {
  Movies: "movies",
  Television: "television",
  Music: "music",
  Games: "games",
  Books: "books",
  Other: "other",
};
const routeMediaTypes = Object.fromEntries(
  Object.entries(mediaTypeRoutes).map(([type, route]) => [route, type])
);

function navigationSnapshot() {
  return {
    mediavault: true,
    view: state.view,
    type: state.type,
    status: state.status,
    origin: state.origin,
    query: state.query,
    settingsTab: state.settingsTab,
  };
}

function navigationHash() {
  if (state.view === "collection") {
    return `#/${mediaTypeRoutes[state.type] || "library"}`;
  }
  if (state.view === "wishlist") return "#/wishlist";
  if (state.view === "settings") return `#/settings/${state.settingsTab}`;
  return "#/dashboard";
}

function updateNavigationHistory(mode = "push") {
  if (mode === "none") return;
  const target = `${window.location.pathname}${window.location.search}${navigationHash()}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (mode === "replace" || target === current) {
    window.history.replaceState(navigationSnapshot(), "", target);
  } else {
    window.history.pushState(navigationSnapshot(), "", target);
  }
}

function navigationFromLocation(historyState = null) {
  if (historyState?.mediavault) return historyState;
  const parts = window.location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "wishlist") return { view: "wishlist" };
  if (parts[0] === "settings") {
    return {
      view: "settings",
      settingsTab: parts[1] === "preferences" ? "preferences" : "sources",
    };
  }
  if (routeMediaTypes[parts[0]]) {
    return { view: "collection", type: routeMediaTypes[parts[0]] };
  }
  if (parts[0] === "library") return { view: "collection", type: "" };
  return { view: "dashboard" };
}

function setView(view, filters = {}, options = {}) {
  state.view = view;
  if ("type" in filters) state.type = filters.type;
  if ("status" in filters) state.status = filters.status;
  if ("origin" in filters) state.origin = filters.origin;
  if ("query" in filters) state.query = filters.query;
  if ("settingsTab" in filters) state.settingsTab = filters.settingsTab;
  $("#dashboardView").hidden = view !== "dashboard";
  $("#collectionView").hidden = view !== "collection";
  $("#wishlistView").hidden = view !== "wishlist";
  $("#settingsView").hidden = view !== "settings";
  $$(".nav-link").forEach((el) => el.classList.remove("active"));
  $(`[data-view="${view}"]`)?.classList.add("active");
  $("#typeFilter").value = state.type;
  $("#statusFilter").value = state.status;
  $("#searchInput").value = state.query;
  $(".sidebar").classList.remove("open");
  updateNavigationHistory(options.historyMode || "push");
  if (view === "dashboard") loadDashboard().catch((error) => toast(error.message));
  if (view === "collection") loadCollection();
  if (view === "wishlist") loadWishlist();
  else clearTimeout(wishlistRefreshTimer);
  if (view === "settings") {
    setSettingsTab(state.settingsTab, { historyMode: "none" });
    if (state.settingsTab === "sources") loadSources();
  }
}

async function loadSources() {
  try {
    const [data, services] = await Promise.all([
      api("/api/sources"),
      api("/api/metadata/services"),
    ]);
    $("#localSourceCount").textContent = data.local.items;
    const metadataRefresh = data.local.metadata_refresh;
    $("#localMetadataLastRefresh").textContent = metadataRefresh?.completed_at
      ? new Date(metadataRefresh.completed_at).toLocaleString()
      : "Never";
    $("#localMetadataEnriched").textContent = metadataRefresh
      ? `${metadataRefresh.enriched || 0} / ${metadataRefresh.processed || 0}`
      : "—";
    renderCatalogSourceHealth(data);
    renderSourceAccordions(data.instances || []);
    renderMetadataServices(services || []);
  } catch (error) { toast(error.message); }
}

function renderMetadataServices(services) {
  const target = $("#metadataServicesGrid");
  if (!target) return;
  target.innerHTML = services.map((service) => {
    const status = service.enabled ? "Enabled"
      : service.coming_soon ? "Coming soon" : "Disabled";
    return `<article class="metadata-service-row">
      <span class="metadata-service-icon">${escapeHtml(service.code)}</span>
      <div><strong>${escapeHtml(service.name)}</strong><small>${escapeHtml(service.description)}</small></div>
      <span class="service-availability ${service.enabled ? "enabled" : "disabled"}">${status}</span>
    </article>`;
  }).join("");
}

function renderCatalogSourceHealth(data) {
  const instances = data.instances || [];
  const sources = [
    {
      name: "MediaVault Database",
      status: "Active",
      detail: `${data.local.items || 0} catalog items`,
    },
    ...instances.map((source) => ({
      name: source.name,
      status: source.status || "Not Configured",
      detail: source.type_label || source.type || "Catalog source",
    })),
  ];
  $("#catalogSourceCount").textContent =
    `${sources.length} ${sources.length === 1 ? "source" : "sources"}`;
  $("#catalogSourceHealthGrid").innerHTML = sources.map((source) => {
    const statusClass = source.status.toLowerCase().replaceAll(" ", "-");
    return `<article class="source-health-card">
      <div><strong>${escapeHtml(source.name)}</strong><span class="health-status ${statusClass}"><i></i>${escapeHtml(source.status)}</span></div>
      <small>${escapeHtml(source.detail)}</small>
    </article>`;
  }).join("");
}

function renderExternalSourceCards(instances) {
  if (!instances.length) {
    $("#externalSourceCards").innerHTML = `<div class="sources-empty-state">
      <strong>No external sources connected.</strong>
      <span>Connect Jellyfin or add an import source when you are ready.</span>
      <button class="button primary" data-source-action="add">＋ Add Source</button>
    </div>`;
    return;
  }
  $("#externalSourceCards").innerHTML = instances.map((source) => {
    const jellyfin = source.type === "jellyfin";
    const details = source.details || {};
    const icon = jellyfin ? "J" : "⇩";
    const detailLines = jellyfin
      ? `<span>Libraries: ${details.libraries || 0}</span><span>Last sync: ${details.last_sync ? new Date(details.last_sync).toLocaleString() : "Never"}</span>`
      : `<span>Items: ${details.items || 0}</span><span>Imported: ${details.last_import ? new Date(details.last_import).toLocaleString() : "Unknown"}</span>`;
    return `<article class="source-model-card external-instance" data-source-type="${escapeHtml(source.type)}" data-source-id="${escapeHtml(source.id)}">
      <div class="source-card-head"><span class="source-card-icon ${jellyfin ? "jellyfin" : "import"}">${icon}</span><div><h3>${escapeHtml(source.name)}</h3><small>TYPE: ${escapeHtml(source.type_label)}</small></div><span class="source-state ${source.status.toLowerCase().replaceAll(" ", "-")}">${escapeHtml(source.status)}</span></div>
      <div class="source-card-details">${detailLines}</div>
      <div class="source-card-actions">
        ${jellyfin ? '<button class="text-button" data-source-action="configure">Configure</button><button class="text-button" data-source-action="sync">Sync</button><button class="text-button" data-source-action="disable">Disable</button>' : '<button class="text-button" data-source-action="view">View</button>'}
        <button class="text-button danger-text" data-source-action="delete">Delete</button>
      </div>
    </article>`;
  }).join("");
}

function renderSourceAccordions(instances) {
  const connectedJellyfin = instances.find((source) => source.type === "jellyfin");
  const importedSources = instances.filter((source) => source.type !== "jellyfin");
  const jellyfinMarkup = connectedJellyfin ? [connectedJellyfin].map((source) => {
    const jellyfin = source.type === "jellyfin";
    const details = source.details || {};
    const lastActivity = jellyfin ? details.last_sync : details.last_import;
    return `<article class="source-model-card source-accordion external-instance" data-source-type="${escapeHtml(source.type)}" data-source-id="${escapeHtml(source.id)}">
      <div class="source-accordion-summary" data-source-action="toggle" role="button" tabindex="0" aria-expanded="false">
        <span class="source-card-icon ${jellyfin ? "jellyfin" : "import"}">${jellyfin ? "J" : "⇩"}</span>
        <div class="source-summary-name"><h3>${escapeHtml(source.name)}</h3><small>${escapeHtml(source.type_label)}</small></div>
        <span class="source-state ${source.status.toLowerCase().replaceAll(" ", "-")}">${escapeHtml(source.status)}</span>
        <span class="source-summary-stat"><small>LAST SYNC</small><strong>${lastActivity ? new Date(lastActivity).toLocaleString() : "Never"}</strong></span>
        <span class="source-summary-stat"><small>ITEMS</small><strong>${details.items || 0}</strong></span>
        ${jellyfin ? '<button class="button primary compact-sync" data-source-action="sync">Sync</button>' : '<button class="button secondary compact-sync" data-source-action="view">View</button>'}
        <span class="accordion-chevron">⌄</span>
      </div>
      <div class="source-accordion-panel" hidden>${jellyfin ? jellyfinConfigurationMarkup(source) : '<p class="source-panel-note">This imported source has no connection settings.</p><div class="source-panel-actions"><button class="text-button danger-text" data-source-action="delete">Delete</button></div>'}</div>
    </article>`;
  }).join("") : `<button class="user-source-row source-placeholder" data-source-action="add">
    <span class="user-source-icon jellyfin">J</span><span><strong>Jellyfin</strong><small>Media Server</small></span>
    <span class="source-state">Not connected</span><b>›</b>
  </button>`;
  const placeholders = [
    ["P", "Plex", "Media Server", "Coming soon"],
    ["S", "Steam", "Game Library", "Coming soon"],
    ["▰", "Folder Import", "Local Folders", "Coming soon"],
  ].map(([icon, name, type, status]) => `<div class="user-source-row source-placeholder disabled">
    <span class="user-source-icon">${icon}</span><span><strong>${name}</strong><small>${type}</small></span>
    <span class="source-state">${status}</span><b>›</b>
  </div>`).join("");
  const imports = importedSources.map((source) => {
    const details = source.details || {};
    return `<article class="user-source-row imported-source external-instance" data-source-type="${escapeHtml(source.type)}" data-source-id="${escapeHtml(source.id)}">
      <span class="user-source-icon import">⇩</span><span><strong>${escapeHtml(source.name)}</strong><small>${escapeHtml(source.type_label)}</small></span>
      <span class="source-state imported">${details.items || 0} items</span>
      <button class="text-button" data-source-action="view">View</button>
    </article>`;
  }).join("");
  $("#externalSourceCards").innerHTML = jellyfinMarkup + placeholders + imports;
}

function jellyfinConfigurationMarkup(source = {}) {
  const details = source.details || {};
  const frequencies = [["manual","Manual only"],["startup","On startup"],["hourly","Every 1 hour"],["six_hours","Every 6 hours"],["daily","Daily"],["weekly","Weekly"]];
  return `<div class="source-config-grid">
    <label class="wide">Server URL<input class="jf-source-url" type="url" value="${escapeHtml(details.server_url || "")}" placeholder="https://192.168.1.10:8096"></label>
    <label>API Key<input class="jf-source-key" type="password" placeholder="${details.server_url ? "Saved — leave blank to keep" : "Enter API key"}" autocomplete="new-password"></label>
    <label>Server Name<input class="jf-source-name" value="${escapeHtml(source.name === "New Jellyfin Source" ? "" : source.name || "")}" placeholder="Home Jellyfin"></label>
  </div>
  <div class="source-config-section"><div class="source-config-heading"><div><strong>Enabled libraries</strong><small>Choose which libraries feed MediaVault.</small></div><button class="text-button" data-source-action="refresh-libraries">Refresh Libraries</button></div><div class="source-library-list"><span class="source-panel-note">Refresh to discover libraries.</span></div></div>
  <div class="source-config-section"><label class="toggle-label"><input type="checkbox" class="jf-use-metadata" ${details.use_metadata !== false ? "checked" : ""}> Use Jellyfin metadata when available</label><p class="source-panel-note">Jellyfin syncs library items and provides metadata when available. External providers fill any gaps.</p></div>
  <div class="source-automation-row"><label class="toggle-label"><input type="checkbox" class="jf-source-auto" ${details.auto_sync ? "checked" : ""}> Automation enabled</label><label>Sync frequency<select class="jf-source-frequency">${frequencies.map(([value,label]) => `<option value="${value}" ${details.frequency === value ? "selected" : ""}>${label}</option>`).join("")}</select></label></div>
  <p class="form-error source-config-error"></p>
  <div class="source-panel-actions"><button class="button secondary" data-source-action="test">Test Connection</button><button class="button primary" data-source-action="save">Save</button><button class="button secondary" data-source-action="sync">Sync Now</button><button class="text-button" data-source-action="disable">Disable</button><button class="text-button danger-text" data-source-action="delete">Delete</button></div>`;
}

function renderSourceLibraries(card, libraries) {
  const categories = ["Movies", "Television", "Music", "Books", "Games", "Other"];
  card.querySelector(".source-library-list").innerHTML = libraries.length ? libraries.map((library) => `<div class="source-library-row" data-library-id="${escapeHtml(library.library_id)}"><label><input type="checkbox" class="jf-library-enabled" ${library.enabled ? "checked" : ""} ${library.supported ? "" : "disabled"}> ${escapeHtml(library.name)}</label>${library.supported ? `<select class="jf-library-category">${categories.map((category) => `<option value="${category}" ${library.media_category === category ? "selected" : ""}>${category}</option>`).join("")}</select>` : "<small>Not mapped</small>"}<small>${library.imported_count || 0} imported</small></div>`).join("") : '<span class="source-panel-note">No libraries discovered yet.</span>';
}

async function loadSourceAccordion(card) {
  if (card.dataset.sourceType !== "jellyfin" || card.dataset.loaded === "true" || card.dataset.sourceId === "new") return;
  const data = await api("/api/jellyfin/libraries");
  renderSourceLibraries(card, data.libraries || []);
  card.querySelector(".jf-source-auto").checked = Boolean(data.auto_sync);
  card.querySelector(".jf-source-frequency").value = data.frequency || "manual";
  card.dataset.loaded = "true";
}

function sourceJellyfinPayload(card) {
  return { server_url: card.querySelector(".jf-source-url").value.trim(), api_key: card.querySelector(".jf-source-key").value.trim(), server_name: card.querySelector(".jf-source-name").value.trim(), use_metadata: card.querySelector(".jf-use-metadata")?.checked !== false };
}

async function saveSourceLibraries(card) {
  const libraries = Array.from(card.querySelectorAll(".source-library-row")).map((row) => ({ library_id: row.dataset.libraryId, enabled: row.querySelector(".jf-library-enabled")?.checked || false, media_category: row.querySelector(".jf-library-category")?.value || null }));
  await api("/api/jellyfin/libraries", { method: "PUT", body: JSON.stringify({ libraries, auto_sync: card.querySelector(".jf-source-auto").checked, frequency: card.querySelector(".jf-source-frequency").value }) });
}

function openNewJellyfinSource() {
  $("#externalSourceCards").innerHTML = `<article class="source-model-card source-accordion external-instance expanded" data-source-type="jellyfin" data-source-id="new">
    <div class="source-accordion-summary" data-source-action="toggle" role="button" tabindex="0" aria-expanded="true">
      <span class="source-card-icon jellyfin">J</span><div class="source-summary-name"><h3>New Jellyfin Source</h3><small>Jellyfin</small></div>
      <span class="source-state">Setup</span><span class="source-summary-stat"><small>LAST SYNC</small><strong>Never</strong></span><span class="source-summary-stat"><small>ITEMS</small><strong>0</strong></span><button class="button primary compact-sync" data-source-action="save">Save</button><span class="accordion-chevron">⌄</span>
    </div>
    <div class="source-accordion-panel">${jellyfinConfigurationMarkup({ name: "New Jellyfin Source", details: {} })}</div>
  </article>`;
  $("#externalSourceCards .jf-source-url")?.focus();
}

async function loadSourceStatus() {
  try {
    const statuses = await api("/api/source-status");
    renderSourceStatus(statuses);
    if (statuses.some((source) => source.status === "Checking")) {
      setTimeout(() => {
        if (state.view === "settings") loadSourceStatus();
      }, 3500);
    }
  } catch (error) { toast(error.message); }
}

function renderSourceStatus(statuses) {
  $("#sourceHealthGrid").innerHTML = statuses
    .filter((source) => source.source_name !== "Jellyfin")
    .map((source) => {
    const statusClass = source.status.toLowerCase().replaceAll(" ", "-");
    const checked = source.last_checked
      ? new Date(source.last_checked).toLocaleString()
      : "Not checked yet";
    return `<article class="source-health-card">
      <div><strong>${escapeHtml(source.source_name)}</strong><span class="health-status ${statusClass}"><i></i>${escapeHtml(source.status)}</span></div>
      <small>Last checked ${escapeHtml(checked)}</small>
      ${source.last_error ? `<p title="${escapeHtml(source.last_error)}">${escapeHtml(source.last_error)}</p>` : ""}
    </article>`;
    }).join("");
}

function setSettingsTab(tab, options = {}) {
  state.settingsTab = tab === "preferences" ? "preferences" : "sources";
  $$(".settings-tab").forEach((button) =>
    button.classList.toggle("active", button.dataset.settingsTab === state.settingsTab)
  );
  $$("[data-settings-section]").forEach((section) => {
    section.hidden = section.id === "importPreview"
      ? state.settingsTab !== "sources" || !state.jellyfinPreview
      : section.dataset.settingsSection !== state.settingsTab;
  });
  if (state.view === "settings") {
    updateNavigationHistory(options.historyMode || "push");
  }
}

async function loadProviderSettings() {
  try {
    const data = await api("/api/settings/providers");
    state.providerPriority = data.metadata_provider_priority || "omdb,tmdb";
    state.musicProviderPriority = data.music_provider_priority || "musicbrainz,discogs,coverartarchive,lastfm";
    state.musicProviders = ["musicbrainz"];
    if (data.has_discogs_token) state.musicProviders.push("discogs");
    if (data.has_lastfm_api_key) state.musicProviders.push("lastfm");
    $("#omdbKey").value = "";
    $("#tmdbKey").value = "";
    $("#discogsToken").value = "";
    $("#lastfmKey").value = "";
    $("#rawgKey").value = "";
    $("#tmdbKey").placeholder = data.has_tmdb_api_key ? "TMDB credential saved — leave blank to keep it" : "Enter your TMDB credential";
    $("#discogsToken").placeholder = data.has_discogs_token ? "Discogs token saved — leave blank to keep it" : "Coming next";
    $("#lastfmKey").placeholder = data.has_lastfm_api_key ? "Last.fm key saved — leave blank to keep it" : "Optional";
    $("#rawgKey").placeholder = data.has_rawg_api_key ? "RAWG key saved — leave blank to keep it" : "Optional";
    $("#tmdbKeyHint").textContent = data.has_tmdb_api_key ? "A TMDB credential is stored locally on the server." : "Used for Movies and Television metadata.";
    $("#omdbKey").placeholder = data.has_omdb_api_key ? "OMDb key saved — leave blank to keep it" : "Enter your OMDb API key";
    $("#omdbKeyHint").textContent = data.has_omdb_api_key ? "An OMDb key is stored locally on the server." : "Primary movie metadata provider.";
    $("#providerPriority").value = state.providerPriority;
  } catch (error) { $("#providerError").textContent = error.message; }
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
    if (data.server_url && data.has_api_key) await loadJellyfinLibraries();
  } catch (error) { $("#jellyfinError").textContent = error.message; }
}

async function loadJellyfinLibraries() {
  try {
    const data = await api("/api/jellyfin/libraries");
    $("#jellyfinAutoSync").checked = Boolean(data.auto_sync);
    $("#jellyfinSyncFrequency").value = data.frequency || "manual";
    $("#jellyfinSyncFrequency").disabled = !data.auto_sync;
    renderJellyfinLibraries(data.libraries || []);
    $("#jellyfinLastSync").textContent = `Last sync: ${data.last_sync ? new Date(data.last_sync).toLocaleString() : "Never"}`;
    $("#jellyfinLastResult").textContent = data.last_result
      ? `${data.last_result.processed || 0} processed · ${data.last_result.added || 0} added · ${data.last_result.updated || 0} updated · ${data.last_result.restored || 0} restored · ${data.last_result.skipped || 0} skipped · ${data.last_result.failed || 0} failed`
      : "No sync results yet.";
  } catch (error) { $("#jellyfinError").textContent = error.message; }
}

function renderJellyfinLibraries(libraries) {
  const categories = ["Movies", "Television", "Music", "Books", "Games", "Other"];
  $("#jellyfinLibraryRows").innerHTML = libraries.length ? libraries.map((library) => {
    const options = categories.map((category) =>
      `<option value="${category}" ${library.media_category === category ? "selected" : ""}>${category}</option>`
    ).join("");
    return `<div class="jellyfin-library-row" data-library-id="${escapeHtml(library.library_id)}">
      <label class="library-enable"><input type="checkbox" class="jf-library-enabled" ${library.enabled ? "checked" : ""} ${library.supported ? "" : "disabled"}><span></span></label>
      <div class="library-identity"><strong>${escapeHtml(library.name)}</strong><small>${escapeHtml(library.collection_type || "mixed")}</small></div>
      <span class="library-arrow">→</span>
      ${library.supported ? `<select class="jf-library-category">${options}</select>` : '<span class="unsupported-library">Not mapped</span>'}
      <div class="library-sync-count"><strong>${library.imported_count || 0}</strong><small>imported</small></div>
    </div>`;
  }).join("") : '<div class="library-empty">No libraries discovered yet.</div>';
}

async function saveJellyfinLibraryConfig() {
  const selections = Array.from($$(".jellyfin-library-row")).map((row) => ({
    library_id: row.dataset.libraryId,
    enabled: row.querySelector(".jf-library-enabled")?.checked || false,
    media_category: row.querySelector(".jf-library-category")?.value || null,
  }));
  await api("/api/jellyfin/libraries", {
    method: "PUT",
    body: JSON.stringify({
      libraries: selections,
      auto_sync: $("#jellyfinAutoSync").checked,
      frequency: $("#jellyfinSyncFrequency").value,
    }),
  });
}

function renderJellyfinSyncStatus(result) {
  const libraryLines = (result.libraries || []).map((library) =>
    `<div><strong>${escapeHtml(library.name)}</strong><span>${library.imported_count || 0} imported${library.failed ? ` · ${library.failed} failed` : ""}</span></div>`
  ).join("");
  $("#jellyfinSyncStatus").innerHTML = `<p><strong>Sync complete</strong><span>${result.processed || 0} processed · ${result.added || 0} added · ${result.updated || 0} updated · ${result.restored || 0} restored · ${result.skipped || 0} skipped · ${result.failed || 0} failed</span></p>${libraryLines}`;
  $("#jellyfinSyncStatus").hidden = false;
  $("#jellyfinLastSync").textContent = `Last sync: ${new Date(result.last_sync).toLocaleString()}`;
  $("#jellyfinLastResult").textContent = `${result.processed || 0} processed · ${result.added || 0} added · ${result.updated || 0} updated · ${result.restored || 0} restored · ${result.skipped || 0} skipped · ${result.failed || 0} failed`;
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

function fact(label, value) {
  if (value === null || value === undefined || value === "" || (Array.isArray(value) && !value.length)) return "";
  const display = Array.isArray(value) ? value.join(", ") : value;
  return `<div><small>${escapeHtml(label)}</small><strong>${escapeHtml(String(display))}</strong></div>`;
}

function formatDuration(seconds) {
  const value = Number(seconds);
  if (!value) return "";
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const remaining = Math.floor(value % 60);
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}` : `${minutes}:${String(remaining).padStart(2, "0")}`;
}

async function openQuickView(itemId) {
  const data = await api(`/api/media/${itemId}/quick-view`);
  state.quickItem = data;
  const collector = data.collector;
  const metadata = data.metadata || {};
  $("#quickTitle").textContent = metadata.title || collector.title;
  $("#quickType").textContent = `${collector.media_type} · ${collector.format}`;
  $("#quickSubtitle").textContent = [metadata.year || collector.year, metadata.runtime_minutes ? `${metadata.runtime_minutes} min` : "", metadata.rating ? `★ ${Number(metadata.rating).toFixed(1)}` : ""].filter(Boolean).join("  ·  ");
  $("#quickOverview").textContent = metadata.overview || (collector.media_type === "Music"
    ? "No additional album overview is available."
    : "No overview is available. Use Refresh Metadata to enrich this item.");
  $("#quickMetadataProvider").textContent = metadata.metadata_source || "Manual / none";
  $("#metadataGrid").innerHTML = [
    fact("Last refreshed", metadata.refreshed_at ? new Date(metadata.refreshed_at).toLocaleString() : ""),
    fact("Artist", metadata.artist),
    fact("Genres", metadata.genres),
    fact("Track count", metadata.track_count),
    fact("Duration", metadata.duration_seconds ? formatDuration(metadata.duration_seconds) : ""),
    fact("Label", metadata.label),
    fact("Catalog number", metadata.catalog_number),
    fact("Edition", metadata.edition),
    fact("Release type", metadata.release_type),
    fact("Director", metadata.director),
    fact("Cast", metadata.cast),
    fact("Studio", metadata.studio),
    fact("Release date", metadata.release_date),
  ].join("") || fact("Metadata", "No external metadata attached");
  $("#collectorGrid").innerHTML = [
    fact("Status", collector.status),
    fact("Format", collector.format),
    fact("Condition", collector.condition),
    fact("UPC", collector.upc),
    fact("Purchase date", collector.purchase_date),
    fact("Purchase price", collector.purchase_price !== null ? `$${Number(collector.purchase_price).toFixed(2)}` : ""),
    fact("Purchased from", collector.purchase_location),
    fact("Physical location", collector.physical_location),
    fact("Tags", collector.tags),
  ].join("");
  const sourceLabels = [];
  if (data.sources.jellyfin) sourceLabels.push('<span class="source-chip jellyfin">Jellyfin</span>');
  if (collector.media_type === "Music") sourceLabels.push(`<span class="source-chip physical">${escapeHtml(collector.format)}</span>`);
  if (data.sources.physical_media && collector.media_type !== "Music") sourceLabels.push('<span class="source-chip physical">Physical Media</span>');
  $("#quickSources").innerHTML = sourceLabels.join("");
  $("#refreshMetadata").disabled = !(
    data.metadata_source || ["Movies", "Music"].includes(collector.media_type)
  );
  $("#changeMetadata").hidden = true;
  $("#removeMetadata").hidden = true;
  $("#quickPoster").style.backgroundImage = metadata.poster_url ? `url("${metadata.poster_url}")` : "";
  $("#quickPoster").classList.toggle("has-image", Boolean(metadata.poster_url));
  const heroImage = metadata.backdrop_url || metadata.artist_image_url || "";
  $("#quickBackdrop").style.backgroundImage = heroImage ? `linear-gradient(to bottom,rgba(10,11,14,.15),#15161a),url("${heroImage}")` : "";
  $("#quickBackdrop").classList.toggle("has-image", Boolean(heroImage));
  $("#quickNotes").hidden = !collector.notes;
  $("#quickNotes p").textContent = collector.notes || "";
  const tracks = metadata.track_listing || [];
  $("#quickTracks").hidden = !tracks.length;
  $("#trackSummary").textContent = tracks.length ? `${tracks.length} tracks${metadata.duration_seconds ? ` · ${formatDuration(metadata.duration_seconds)}` : ""}` : "";
  $("#trackList").innerHTML = tracks.map((track) => `<li><span>${escapeHtml(track.number || "")}</span><strong>${escapeHtml(track.title)}</strong><em>${track.duration_seconds ? formatDuration(track.duration_seconds) : ""}</em></li>`).join("");
  $("#quickView").hidden = false;
  document.body.style.overflow = "hidden";
}

function openMetadataSearch() {
  if (!state.quickItem) return;
  $("#metadataQuery").value = state.quickItem.collector.title || "";
  $("#metadataYear").value = state.quickItem.collector.year || "";
  const isMusic = state.quickItem.collector.media_type === "Music";
  $("#metadataProvider").innerHTML = isMusic
    ? state.musicProviders.map((provider) => `<option value="${provider}">${({musicbrainz:"MusicBrainz",discogs:"Discogs",lastfm:"Last.fm"})[provider]}</option>`).join("")
    : '<option value="omdb">OMDb</option><option value="tmdb">TMDB</option>';
  $("#metadataProvider").value = isMusic ? "musicbrainz" : (state.providerPriority.split(",")[0] || "omdb");
  $("#metadataQuery").placeholder = isMusic ? "Album title" : "Movie title";
  $("#metadataArtist").hidden = !isMusic;
  $("#metadataArtist").value = state.quickItem.metadata?.artist || "";
  $("#metadataSearchButton").textContent = `Search ${$("#metadataProvider").selectedOptions[0].text}`;
  $("#metadataSearchError").textContent = "";
  $("#metadataResults").innerHTML = '<div class="empty-state"><strong>Ready to search.</strong><span>Choose the provider and correct release; MediaVault will keep collector data unchanged.</span></div>';
  $("#metadataSearchModal").hidden = false;
  document.body.style.overflow = "hidden";
}

function closeMetadataSearch() {
  $("#metadataSearchModal").hidden = true;
  document.body.style.overflow = $("#quickView").hidden ? "" : "hidden";
}

function renderMetadataResults(results) {
  $("#metadataResults").innerHTML = results.length ? results.map((item) => `
    <article class="metadata-result">
      <div class="result-poster">${item.poster_url ? `<img src="${escapeHtml(item.poster_url)}" alt="">` : "<span>MV</span>"}</div>
      <div class="result-copy"><small>${escapeHtml(item.metadata_source)} · ${item.year || "Year unknown"}</small><strong>${escapeHtml(item.title)}</strong>${item.artist ? `<span class="result-artist">${escapeHtml(item.artist)}</span>` : ""}<p>${escapeHtml(item.overview || "No overview available.")}</p></div>
      <div class="result-rating">${item.rating ? `★ ${Number(item.rating).toFixed(1)}` : ""}</div>
      <button class="button secondary attach-metadata" data-provider="${escapeHtml(item.metadata_source.toLowerCase())}" data-external-id="${escapeHtml(item.external_id)}">Use this metadata</button>
    </article>`).join("") : '<div class="empty-state"><strong>No matches found.</strong><span>Try a broader title or remove the year.</span></div>';
}

function openCatalogFilePicker() {
  $("#catalogImportFile").value = "";
  $("#catalogImportFile").click();
}

async function previewCatalogFile(file) {
  const form = new FormData();
  form.append("file", file);
  $("#catalogImportError").textContent = "";
  const response = await fetch("/api/catalog/import/preview", {
    method: "POST", body: form,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Catalog preview failed.");
  state.catalogPreview = data;
  state.catalogCategory = data.counts.new_items ? "new_items"
    : data.counts.matches ? "matches" : "possible_duplicates";
  $("#catalogImportCounts").innerHTML = `<strong>${file.name}</strong><span>${data.items.length} reviewable items</span>`;
  $$(".catalog-preview-tabs .preview-tab").forEach((tab) => {
    const count = data.counts[tab.dataset.catalogPreview] || 0;
    tab.querySelector("b").textContent = count;
  });
  renderCatalogPreview();
  $("#catalogImportModal").hidden = false;
  document.body.style.overflow = "hidden";
}

function renderCatalogPreview(category = state.catalogCategory) {
  state.catalogCategory = category;
  $$(".catalog-preview-tabs .preview-tab").forEach((tab) =>
    tab.classList.toggle("active", tab.dataset.catalogPreview === category)
  );
  const items = (state.catalogPreview?.items || []).filter(
    (item) => item.category === category && !item.handled
  );
  $("#catalogPreviewRows").innerHTML = items.length ? items.map((item) => {
    const collector = item.collector;
    const match = item.match;
    return `<article class="catalog-preview-row" data-import-index="${item.index}">
      <div><small>${escapeHtml(collector.media_type || "Other")} · ${collector.year || "Year unknown"}</small><strong>${escapeHtml(collector.title)}</strong><span>${escapeHtml(collector.format || "Other")}</span></div>
      ${match ? `<div class="catalog-match"><small>MEDIAVAULT ${item.confidence || ""}%</small><strong>${escapeHtml(match.title)}</strong><span>${match.year || "Year unknown"} · ${escapeHtml(match.format)}</span></div>` : '<div class="catalog-match empty"><small>MEDIAVAULT</small><strong>New catalog item</strong></div>'}
      <div class="catalog-row-actions">
        ${match ? `<button class="button secondary catalog-import-action" data-action="attach" data-media-id="${match.id}">Attach Import Source</button>` : ""}
        <button class="button secondary catalog-import-action" data-action="create">Create Item</button>
        <button class="text-button catalog-import-action" data-action="ignore">Ignore</button>
      </div>
    </article>`;
  }).join("") : '<div class="empty-state"><strong>Nothing waiting here.</strong><span>All items in this group have been reviewed.</span></div>';
}

function closeCatalogImport() {
  $("#catalogImportModal").hidden = true;
  document.body.style.overflow = "";
}

function closeQuickView() {
  $("#quickView").hidden = true;
  document.body.style.overflow = "";
}

function openModal(item = null) {
  const form = $("#mediaForm");
  const field = (name) => form.elements.namedItem(name);
  form.reset();
  $("#formError").textContent = "";
  $("#itemId").value = item?.id || "";
  $("#editMetadataProvider").value = item?.metadata_source || "";
  $("#editProviderId").value = item?.provider_id || "";
  $("#modalTitle").textContent = item ? "Edit catalog item" : "Add to your vault";
  $("#saveButton").textContent = item ? "Save changes" : "Add to library";
  $("#deleteButton").hidden = !item;
  field("title").readOnly = Boolean(item);
  field("year").readOnly = Boolean(item);
  field("title").title = item ? "Title is read-only in Edit. Refresh attached metadata to update display information." : "";
  field("year").title = item ? "Year is read-only in Edit. Refresh attached metadata to update display information." : "";
  if (item) {
    if (!item.id) {
      toast("This catalog item could not be selected for editing.");
      return false;
    }
    [
      "title", "year", "media_type", "format", "status", "condition",
      "upc", "tags", "notes", "purchase_price", "purchase_date",
      "purchase_location", "physical_location",
    ].forEach((name) => {
      const input = field(name);
      const value = item[name];
      if (input) input.value = Array.isArray(value) ? value.join(", ") : (value ?? "");
    });
  } else {
    field("status").value = "Unassigned";
    field("condition").value = "Good";
  }
  $("#modal").hidden = false;
  document.body.style.overflow = "hidden";
  setTimeout(() => field("title").focus(), 30);
  return true;
}

function closeModal() {
  $("#modal").hidden = true;
  document.body.style.overflow = $("#quickView").hidden ? "" : "hidden";
}

function openWishlistModal(item = null) {
  if (!item) state.returnToWishlistDetail = false;
  const form = $("#wishlistForm");
  form.reset();
  form.elements.id.value = item?.id || "";
  form.elements.title.value = item?.title || "";
  form.elements.artist.value = item?.artist || "";
  form.elements.year.value = item?.year || "";
  form.elements.media_type.value = item?.media_type || "";
  form.elements.notes.value = item?.notes || "";
  $("#wishlistModalTitle").textContent = item ? "Edit Wishlist Item" : "Add Wishlist Item";
  $("#wishlistError").textContent = "";
  $("#wishlistModal").hidden = false;
  document.body.style.overflow = "hidden";
  setTimeout(() => form.elements.title.focus(), 30);
}

function closeWishlistModal() {
  $("#wishlistModal").hidden = true;
  if (state.returnToWishlistDetail && state.wishlistDetailItem) {
    $("#wishlistDetail").hidden = false;
    document.body.style.overflow = "hidden";
  } else {
    document.body.style.overflow = $("#wishlistDetail").hidden ? "" : "hidden";
  }
}

function openWishlistDetail(item) {
  if (!item) {
    toast("That Wishlist item is no longer available.");
    return;
  }
  state.wishlistDetailItem = item;
  const wishlistStatus = item.wishlist_status || "wanted";
  $("#wishlistDetailTitle").textContent = item.title;
  $("#wishlistDetailType").textContent = `${item.media_type || "WISHLIST"} · WISHLIST`;
  $("#wishlistDetailSubtitle").textContent = [
    item.artist, item.year,
    item.runtime_minutes ? `${item.runtime_minutes} min` : "",
  ].filter(Boolean).join(" · ");
  $("#wishlistDetailOverview").textContent = item.overview
    || (item.enrichment_status === "Pending"
      ? "Metadata enrichment is pending."
      : "No metadata summary is available.");
  $("#wishlistDetailProvider").textContent = item.provider || "Manual / none";
  const wishlistStatusLabel =
    wishlistStatus[0].toUpperCase() + wishlistStatus.slice(1);
  $("#wishlistDetailMetadata").innerHTML = [
    fact("Artist", item.artist),
    fact("Year", item.year),
    fact("Media type", item.media_type),
    fact("Runtime", item.runtime_minutes ? `${item.runtime_minutes} min` : ""),
    fact("Genres", item.genres),
    fact("Enrichment", item.enrichment_status || item.metadata_status),
    fact("Wishlist status", wishlistStatusLabel),
    fact("Acquired", item.acquired_at ? new Date(item.acquired_at).toLocaleString() : ""),
    fact("Dismissed", item.dismissed_at ? new Date(item.dismissed_at).toLocaleString() : ""),
    fact("Last enriched", item.enriched_at ? new Date(item.enriched_at).toLocaleString() : ""),
  ].join("");
  $("#wishlistDetailChips").innerHTML =
    `<span class="source-chip wishlist-source ${wishlistStatus}">♡ Wishlist · ${escapeHtml(wishlistStatusLabel)}</span>`;
  $("#wishlistDetailPoster").style.backgroundImage = item.poster_url
    ? `url("${item.poster_url}")` : "";
  $("#wishlistDetailPoster").classList.toggle("has-image", Boolean(item.poster_url));
  $("#wishlistDetailNotes").hidden = !item.notes;
  $("#wishlistDetailNotes p").textContent = item.notes || "";
  $("#markWishlistAcquired").hidden = wishlistStatus !== "wanted";
  $("#markWishlistDismissed").hidden = wishlistStatus !== "wanted";
  $("#restoreWishlistWanted").hidden = wishlistStatus === "wanted";
  $("#wishlistDetail").hidden = false;
  document.body.style.overflow = "hidden";
}

async function updateWishlistStatus(wishlistStatus) {
  const item = state.wishlistDetailItem;
  if (!item) return;
  const updated = await api(`/api/wishlist/${item.id}/status`, {
    method: "PATCH",
    body: JSON.stringify({ wishlist_status: wishlistStatus }),
  });
  state.wishlistDetailItem = updated;
  const index = state.wishlistItems.findIndex(
    (candidate) => candidate.id === updated.id
  );
  if (index >= 0) state.wishlistItems[index] = updated;
  openWishlistDetail(updated);
  renderWishlistItems();
  toast(`Wishlist status changed to ${updated.wishlist_status}.`);
}

function closeWishlistDetail() {
  $("#wishlistDetail").hidden = true;
  state.returnToWishlistDetail = false;
  document.body.style.overflow = "";
}

async function deleteWishlistItem(item) {
  if (!item || !confirm(`Delete "${item.title}" from Wishlist?`)) return;
  await api(`/api/wishlist/${item.id}`, { method: "DELETE" });
  if (!$("#wishlistDetail").hidden) closeWishlistDetail();
  state.wishlistDetailItem = null;
  toast("Wishlist item deleted.");
  await loadWishlist();
}

function toast(message, duration = 2200) {
  $("#toast").textContent = message;
  $("#toast").classList.add("show");
  setTimeout(() => $("#toast").classList.remove("show"), duration);
}

function downloadCatalogExport() {
  const link = document.createElement("a");
  link.href = "/api/catalog/export";
  link.download = "";
  link.hidden = true;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

document.addEventListener("click", async (event) => {
  const sortButton = event.target.closest("[data-sort-key]");
  if (sortButton) {
    setSortKey(sortButton.dataset.sortKey);
    return;
  }
  const displayViewButton = event.target.closest("[data-display-view]");
  if (displayViewButton) {
    setDisplayView(displayViewButton.dataset.displayView);
    return;
  }
  if (event.target.closest("[data-add-wishlist]")) {
    openWishlistModal();
    return;
  }
  const wishlistAction = event.target.closest("[data-wishlist-action]");
  if (wishlistAction) {
    const row = wishlistAction.closest("[data-wishlist-id]");
    const item = state.wishlistItems.find(
      (value) => String(value.id) === row?.dataset.wishlistId
    );
    if (!item) return;
    if (wishlistAction.dataset.wishlistAction === "edit") {
      openWishlistModal(item);
    } else if (wishlistAction.dataset.wishlistAction === "delete") {
      try {
        await deleteWishlistItem(item);
      } catch (error) { toast(error.message, 5000); }
    }
    return;
  }
  const wishlistCard = event.target.closest(".wishlist-item-entry[data-wishlist-id]");
  if (wishlistCard) {
    const item = state.wishlistItems.find(
      (value) => String(value.id) === wishlistCard.dataset.wishlistId
    );
    openWishlistDetail(item);
    return;
  }
  const sourceInstanceAction = event.target.closest("[data-source-action]");
  if (sourceInstanceAction) {
    const action = sourceInstanceAction.dataset.sourceAction;
    const sourceCard = sourceInstanceAction.closest("[data-source-type]");
    if (action === "add") {
      $("#addSourceButton").click();
      return;
    }
    if (!sourceCard) return;
    const sourceType = sourceCard.dataset.sourceType;
    const sourceId = sourceCard.dataset.sourceId;
    const errorBox = sourceCard.querySelector(".source-config-error");
    if (action === "toggle" || action === "configure") {
      const panel = sourceCard.querySelector(".source-accordion-panel");
      const opening = panel.hidden;
      panel.hidden = !opening;
      sourceCard.classList.toggle("expanded", opening);
      sourceCard.querySelector(".source-accordion-summary")?.setAttribute("aria-expanded", String(opening));
      if (opening) loadSourceAccordion(sourceCard).catch((error) => { if (errorBox) errorBox.textContent = error.message; });
    } else if (action === "sync") {
      if (sourceId === "new") { toast("Save the Jellyfin connection before syncing."); return; }
      $("#refreshLibraryAction").click();
    } else if (action === "test") {
      if (errorBox) errorBox.textContent = "";
      sourceInstanceAction.disabled = true;
      try {
        const result = await api("/api/jellyfin/test", { method: "POST", body: JSON.stringify(sourceJellyfinPayload(sourceCard)) });
        toast(`Connected${result.server_name ? ` to ${result.server_name}` : ""}.`);
      } catch (error) { if (errorBox) errorBox.textContent = error.message; }
      finally { sourceInstanceAction.disabled = false; }
    } else if (action === "refresh-libraries") {
      if (sourceId === "new") { if (errorBox) errorBox.textContent = "Save the connection before refreshing libraries."; return; }
      sourceInstanceAction.disabled = true;
      try {
        const data = await api("/api/jellyfin/libraries/refresh", { method: "POST", body: "{}" });
        renderSourceLibraries(sourceCard, data.libraries || []);
        sourceCard.dataset.loaded = "true";
        toast(`${(data.libraries || []).length} libraries found.`);
      } catch (error) { if (errorBox) errorBox.textContent = error.message; }
      finally { sourceInstanceAction.disabled = false; }
    } else if (action === "save") {
      if (errorBox) errorBox.textContent = "";
      sourceInstanceAction.disabled = true;
      try {
        await api("/api/settings/jellyfin", { method: "POST", body: JSON.stringify(sourceJellyfinPayload(sourceCard)) });
        await api("/api/sources/jellyfin/enable", { method: "POST", body: "{}" });
        if (sourceId !== "new") await saveSourceLibraries(sourceCard);
        toast("Jellyfin source saved.");
        await loadSources();
      } catch (error) { if (errorBox) errorBox.textContent = error.message; }
      finally { sourceInstanceAction.disabled = false; }
    } else if (action === "disable") {
      if (sourceId === "new") { sourceCard.remove(); return; }
      try {
        await api("/api/sources/jellyfin/disable", { method: "POST", body: "{}" });
        toast("Jellyfin source disabled.");
        await loadSources();
      } catch (error) { toast(error.message, 5000); }
    } else if (action === "view") {
      setView("collection", { type: "", status: "", origin: "" });
    } else if (action === "delete") {
      if (sourceId === "new") { sourceCard.remove(); return; }
      if (!confirm("Delete this source connection? MediaVault catalog records will be kept.")) return;
      try {
        await api(`/api/sources/${sourceType}/${sourceId}`, { method: "DELETE" });
        toast("Source removed. Catalog records were kept.");
        await loadSources();
      } catch (error) { toast(error.message, 5000); }
    }
    return;
  }
  const mediaCard = event.target.closest(".media-item-entry[data-id]");
  if (mediaCard) {
    try { await openQuickView(mediaCard.dataset.id); } catch (error) { toast(error.message); }
  }
  if (event.target.closest(".empty-add")) openModal();
  const catalogAction = event.target.closest(".catalog-import-action");
  if (catalogAction && state.catalogPreview) {
    const row = catalogAction.closest(".catalog-preview-row");
    const index = Number(row.dataset.importIndex);
    catalogAction.disabled = true;
    try {
      await api("/api/catalog/import/apply", {
        method: "POST",
        body: JSON.stringify({
          token: state.catalogPreview.token,
          index,
          action: catalogAction.dataset.action,
          media_id: catalogAction.dataset.mediaId || null,
        }),
      });
      const item = state.catalogPreview.items.find((value) => value.index === index);
      if (item) item.handled = true;
      renderCatalogPreview();
      await Promise.all([loadDashboard(), loadSources()]);
      toast("Import decision saved.");
    } catch (error) { $("#catalogImportError").textContent = error.message; catalogAction.disabled = false; }
  }
  const metadataButton = event.target.closest(".attach-metadata");
  if (metadataButton && state.quickItem) {
    metadataButton.disabled = true;
    metadataButton.textContent = "Attaching…";
    try {
      const id = state.quickItem.collector.id;
      await api(`/api/media/${id}/metadata`, {
        method: "POST",
        body: JSON.stringify({
          provider: metadataButton.dataset.provider,
          external_id: metadataButton.dataset.externalId,
        }),
      });
      closeMetadataSearch();
      await openQuickView(id);
      toast(`${metadataButton.dataset.provider.toUpperCase()} metadata attached.`);
    } catch (error) {
      $("#metadataSearchError").textContent = error.message;
      metadataButton.disabled = false;
      metadataButton.textContent = "Use this metadata";
    }
  }
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
    if (id && state.quickItem?.collector?.id === Number(id)) {
      await openQuickView(id);
    }
  } catch (error) { $("#formError").textContent = error.message; }
});

$("#deleteButton").addEventListener("click", async () => {
  const id = $("#itemId").value;
  if (!id || !confirm("Remove this item from your catalog?")) return;
  const button = $("#deleteButton");
  button.disabled = true;
  try {
    await api(`/api/media/${id}`, { method: "DELETE" });
    state.items = state.items.filter((item) => String(item.id) !== String(id));
    document.querySelector(`.media-item-entry[data-id="${CSS.escape(String(id))}"]`)?.remove();
    closeModal();
    if (state.quickItem?.collector?.id === Number(id)) {
      state.quickItem = null;
      closeQuickView();
    }
    toast("Item removed.");
    await Promise.all([loadDashboard(), state.view === "collection" ? loadCollection() : Promise.resolve()]);
  } catch (error) {
    console.error("Catalog delete failed", {
      id,
      title: $("#mediaForm").elements.namedItem("title")?.value,
      provider: $("#editMetadataProvider").value,
      providerId: $("#editProviderId").value,
      error,
    });
    $("#formError").textContent = error.message === "Delete failed. See server logs."
      ? error.message : "Unable to delete item.";
  } finally {
    button.disabled = false;
  }
});

let searchTimer;
$("#searchInput").addEventListener("input", (event) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.query = event.target.value.trim(); state.origin = ""; setView("collection"); }, 180);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)) { event.preventDefault(); $("#searchInput").focus(); }
  if (event.key === "Escape" && !$("#metadataSearchModal").hidden) closeMetadataSearch();
  else if (event.key === "Escape" && !$("#wishlistModal").hidden) closeWishlistModal();
  else if (event.key === "Escape" && !$("#wishlistDetail").hidden) closeWishlistDetail();
  else if (event.key === "Escape" && !$("#modal").hidden) closeModal();
  else if (event.key === "Escape" && !$("#quickView").hidden) closeQuickView();
});

$$("[data-view]").forEach((el) => el.addEventListener("click", () => setView(el.dataset.view, { type: "", status: "", origin: "" })));
$$(".type-link").forEach((el) => el.addEventListener("click", () => setView("collection", { type: el.dataset.type, status: "", origin: "" })));
$$(".stat-card[data-stat-filter]").forEach((el) => el.addEventListener("click", () => setView("collection", { type: el.dataset.statFilter, status: "", origin: "" })));
$$(".stat-card[data-stat-view]").forEach((el) => el.addEventListener("click", () => setView(el.dataset.statView, { type: "", status: "", origin: "" })));
$("#viewAll").addEventListener("click", () => setView("collection", { type: "", status: "", origin: "" }));
$("#addWishlistItem").addEventListener("click", () => openWishlistModal());
$("#closeWishlistModal").addEventListener("click", closeWishlistModal);
$("#cancelWishlistModal").addEventListener("click", closeWishlistModal);
$("#wishlistModal").addEventListener("click", (event) => {
  if (event.target === $("#wishlistModal")) closeWishlistModal();
});
$("#closeWishlistDetail").addEventListener("click", closeWishlistDetail);
$("#closeWishlistDetailButton").addEventListener("click", closeWishlistDetail);
$("#wishlistDetail").addEventListener("click", (event) => {
  if (event.target === $("#wishlistDetail")) closeWishlistDetail();
});
$("#editWishlistDetail").addEventListener("click", () => {
  if (!state.wishlistDetailItem) return;
  state.returnToWishlistDetail = true;
  $("#wishlistDetail").hidden = true;
  openWishlistModal(state.wishlistDetailItem);
});
$("#refreshWishlistMetadata").addEventListener("click", async () => {
  const item = state.wishlistDetailItem;
  if (!item) return;
  const button = $("#refreshWishlistMetadata");
  button.disabled = true;
  try {
    await api(`/api/wishlist/${item.id}/refresh`, { method: "POST" });
    item.metadata_status = "Pending";
    item.enrichment_status = "Pending";
    openWishlistDetail(item);
    toast("Wishlist metadata refresh started.");
    await loadWishlist();
  } catch (error) { toast(error.message, 5000); }
  finally { button.disabled = false; }
});
$("#deleteWishlistDetail").addEventListener("click", async () => {
  try { await deleteWishlistItem(state.wishlistDetailItem); }
  catch (error) { toast(error.message, 5000); }
});
$("#markWishlistAcquired").addEventListener("click", async () => {
  try { await updateWishlistStatus("acquired"); }
  catch (error) { toast(error.message, 5000); }
});
$("#markWishlistDismissed").addEventListener("click", async () => {
  try { await updateWishlistStatus("dismissed"); }
  catch (error) { toast(error.message, 5000); }
});
$("#restoreWishlistWanted").addEventListener("click", async () => {
  try { await updateWishlistStatus("wanted"); }
  catch (error) { toast(error.message, 5000); }
});
syncDisplayViewControls();
$("#wishlistForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#wishlistError").textContent = "";
  const values = Object.fromEntries(new FormData(event.currentTarget));
  const itemId = values.id;
  delete values.id;
  const submit = event.currentTarget.querySelector("button:not([type])");
  submit.disabled = true;
  try {
    await api(itemId ? `/api/wishlist/${itemId}` : "/api/wishlist", {
      method: itemId ? "PUT" : "POST",
      body: JSON.stringify(values),
    });
    const returnToDetail = state.returnToWishlistDetail;
    state.returnToWishlistDetail = false;
    closeWishlistModal();
    toast(itemId ? "Wishlist item updated." : "Added to Wishlist.");
    await loadWishlist();
    if (returnToDetail && itemId) {
      const updated = state.wishlistItems.find(
        (item) => String(item.id) === String(itemId)
      );
      openWishlistDetail(updated);
    }
  } catch (error) { $("#wishlistError").textContent = error.message; }
  finally { submit.disabled = false; }
});
$("#typeFilter").addEventListener("change", (e) => {
  state.type = e.target.value;
  updateNavigationHistory("replace");
  loadCollection();
});
$("#statusFilter").addEventListener("change", (e) => {
  state.status = e.target.value;
  updateNavigationHistory("replace");
  loadCollection();
});
$("#clearFilters").addEventListener("click", () => {
  state.type = "";
  state.status = "";
  state.query = "";
  $("#searchInput").value = "";
  $("#typeFilter").value = "";
  $("#statusFilter").value = "";
  updateNavigationHistory("replace");
  loadCollection();
});
$("#addButton").addEventListener("click", () => openModal());
$("#closeModal").addEventListener("click", closeModal);
$("#cancelButton").addEventListener("click", closeModal);
$("#modal").addEventListener("click", (e) => { if (e.target === $("#modal")) closeModal(); });
$("#closeQuickView").addEventListener("click", closeQuickView);
$("#closeQuickButton").addEventListener("click", closeQuickView);
$("#quickView").addEventListener("click", (e) => { if (e.target === $("#quickView")) closeQuickView(); });
$("#editQuickView").addEventListener("click", async () => {
  const selectedId = state.quickItem?.collector?.id;
  if (!selectedId) {
    toast("Select a catalog item before editing collector information.");
    return;
  }
  try {
    const collector = await api(`/api/media/${selectedId}`);
    openModal(collector);
  } catch (error) {
    toast(`Could not open collector information: ${error.message}`, 5000);
  }
});
$("#refreshMetadata").addEventListener("click", async () => {
  if (!state.quickItem) return;
  const id = state.quickItem.collector.id;
  $("#refreshMetadata").disabled = true;
  $("#refreshMetadata").textContent = "Refreshing…";
  try {
    await api(`/api/media/${id}/refresh-metadata`, { method: "POST", body: "{}" });
    await openQuickView(id);
    toast("Metadata refreshed.");
  } catch (error) { toast(error.message); }
  finally { $("#refreshMetadata").textContent = "Refresh Metadata"; $("#refreshMetadata").disabled = !(state.quickItem?.metadata_source || state.quickItem?.sources?.jellyfin); }
});
$("#changeMetadata").addEventListener("click", openMetadataSearch);
$("#removeMetadata").addEventListener("click", async () => {
  if (!state.quickItem || !confirm("Detach this metadata source? Your MediaVault catalog item and collector data will be kept.")) return;
  const id = state.quickItem.collector.id;
  try {
    await api(`/api/media/${id}/metadata`, { method: "DELETE" });
    await openQuickView(id);
    toast("Metadata source removed. Collector data was kept.");
  } catch (error) { toast(error.message); }
});
$("#closeMetadataSearch").addEventListener("click", closeMetadataSearch);
$("#metadataSearchModal").addEventListener("click", (event) => {
  if (event.target === $("#metadataSearchModal")) closeMetadataSearch();
});
$("#metadataSearchForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#metadataSearchError").textContent = "";
  const provider = $("#metadataProvider").value;
  const providerLabel = $("#metadataProvider").selectedOptions[0].text;
  $("#metadataResults").innerHTML = `<div class="empty-state"><strong>Searching ${providerLabel}…</strong><span>Looking for the best matches.</span></div>`;
  const params = new URLSearchParams({ q: $("#metadataQuery").value.trim() });
  if ($("#metadataYear").value) params.set("year", $("#metadataYear").value);
  if (!$("#metadataArtist").hidden && $("#metadataArtist").value.trim()) params.set("artist", $("#metadataArtist").value.trim());
  try { renderMetadataResults(await api(`/api/metadata/${provider}/search?${params}`)); }
  catch (error) { $("#metadataSearchError").textContent = error.message; $("#metadataResults").innerHTML = ""; }
});
$("#metadataProvider").addEventListener("change", () => {
  $("#metadataSearchButton").textContent = `Search ${$("#metadataProvider").selectedOptions[0].text}`;
});
if ($("#providerForm")) {
$("#providerForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#providerError").textContent = "";
  try {
    await api("/api/settings/providers", {
      method: "POST",
      body: JSON.stringify({
        omdb_api_key: $("#omdbKey").value.trim(),
        tmdb_api_key: $("#tmdbKey").value.trim(),
        metadata_provider_priority: $("#providerPriority").value,
        music_provider_priority: state.musicProviderPriority,
        discogs_token: $("#discogsToken").value.trim(),
        lastfm_api_key: $("#lastfmKey").value.trim(),
        rawg_api_key: $("#rawgKey").value.trim(),
      }),
    });
    await loadProviderSettings();
    toast("Metadata provider settings saved.");
  } catch (error) { $("#providerError").textContent = error.message; }
});
$("#testOmdb").addEventListener("click", async () => {
  $("#providerError").textContent = "";
  $("#testOmdb").disabled = true;
  $("#testOmdb").textContent = "Testing…";
  try {
    await api("/api/metadata/omdb/test", { method: "POST", body: "{}" });
    $("#tmdbBadge").textContent = "OMDb connected";
    $("#tmdbBadge").classList.add("connected");
  } catch (error) {
    $("#tmdbBadge").textContent = "OMDb failed";
    $("#tmdbBadge").classList.remove("connected");
    $("#providerError").textContent = error.message;
  } finally { $("#testOmdb").disabled = false; $("#testOmdb").textContent = "Test OMDb"; }
});
$("#testTmdb").addEventListener("click", async () => {
  $("#providerError").textContent = "";
  $("#testTmdb").disabled = true;
  $("#testTmdb").textContent = "Testing…";
  try {
    await api("/api/metadata/tmdb/test", { method: "POST", body: "{}" });
    $("#tmdbBadge").textContent = "Connected";
    $("#tmdbBadge").classList.add("connected");
  } catch (error) {
    $("#tmdbBadge").textContent = "Connection failed";
    $("#tmdbBadge").classList.remove("connected");
    $("#providerError").textContent = error.message;
  } finally { $("#testTmdb").disabled = false; $("#testTmdb").textContent = "Test TMDb"; }
});
$("#refreshAllMetadata").addEventListener("click", async () => {
  $("#bulkStatus").hidden = false;
  $("#bulkStatusTitle").textContent = "Refresh started";
  $("#bulkStatusNote").textContent = "Checking movie titles against configured providers…";
  ["Processed", "Enriched", "Skipped", "Failed"].forEach((name) => $(`#bulk${name}`).textContent = "0");
  $("#viewFailedItems").hidden = true;
  $("#failedItems").hidden = true;
  $("#bulkCategoryStatus").innerHTML = "";
  $("#refreshAllMetadata").disabled = true;
  $("#refreshAllMetadata").textContent = "Refreshing…";
  const renderResult = (result) => {
    $("#bulkProcessed").textContent = result.processed || 0;
    $("#bulkEnriched").textContent = result.enriched || 0;
    $("#bulkSkipped").textContent = result.skipped || 0;
    $("#bulkFailed").textContent = result.failed || 0;
    $("#bulkStatusTitle").textContent = result.status === "running"
      ? "Refresh in progress"
      : result.status === "failed"
        ? "Refresh failed"
        : result.warnings || result.failed
          ? "Metadata refresh completed with warnings"
          : "Metadata refresh complete";
    $("#bulkStatusNote").textContent = result.message || "";
    $("#bulkCategoryStatus").innerHTML = Object.entries(result.categories || {}).map(([name, counts]) =>
      `<div><strong>${escapeHtml(name)}</strong><span>${counts.enriched || 0} enriched · ${counts.skipped || 0} skipped · ${counts.failed || 0} failed · ${counts.warnings || 0} warnings</span></div>`
    ).join("");
    const details = [
      ...(result.failures || []),
      ...(result.warning_details || []),
    ];
    $("#viewFailedItems").hidden = !details.length;
    $("#viewFailedItems").textContent = "View warning/error details";
    $("#failedItems").innerHTML = details.map((item) =>
      `<div><strong>${escapeHtml(item.title || "Refresh job")}</strong><span>${item.provider ? `${escapeHtml(item.provider)} · ` : ""}${escapeHtml(item.error || item.status || "Not enriched")}</span></div>`
    ).join("");
  };
  try {
    const result = await startAndPollMetadataRefresh(renderResult);
    toast(result.message || "Metadata refresh complete.", 7000);
    await loadDashboard();
  } catch (error) {
    $("#bulkStatusNote").textContent =
      "Connection interrupted. Refresh status is still saved on the server.";
  } finally {
    $("#refreshAllMetadata").disabled = false;
    $("#refreshAllMetadata").textContent = "Refresh All Metadata";
  }
});
$("#viewFailedItems").addEventListener("click", () => {
  $("#failedItems").hidden = !$("#failedItems").hidden;
  $("#viewFailedItems").textContent = $("#failedItems").hidden ? "View failed items" : "Hide failed items";
});
}
$("#menuButton").addEventListener("click", () => $(".sidebar").classList.toggle("open"));
$("#refreshLibraryAction").addEventListener("click", async () => {
  const button = $("#refreshLibraryAction");
  const original = button.innerHTML;
  button.disabled = true;
  button.innerHTML = "<span>↻</span> Refreshing…";
  try {
    const result = await api("/api/jellyfin/sync", {
      method: "POST",
      credentials: "same-origin",
      body: "{}",
    });
    toast(`${result.processed || 0} processed · ${result.added || 0} added · ${result.updated || 0} updated · ${result.restored || 0} restored · ${result.skipped || 0} skipped · ${result.failed || 0} failed`, 6000);
    await loadDashboard();
    if (state.view === "collection") await loadCollection();
    if (state.view === "settings") await loadSources();
  } catch (error) {
    console.error("Library refresh failed", error);
    toast("Library refresh failed. Check server logs.", 6000);
  }
  finally { button.disabled = false; button.innerHTML = original; }
});
$("#addSourceButton").addEventListener("click", () => {
  $("#addSourceModal").hidden = false;
  document.body.style.overflow = "hidden";
});
$("#closeAddSource").addEventListener("click", () => {
  $("#addSourceModal").hidden = true; document.body.style.overflow = "";
});
$("#addSourceModal").addEventListener("click", (event) => {
  if (event.target === $("#addSourceModal")) {
    $("#addSourceModal").hidden = true; document.body.style.overflow = "";
  }
});
$$("[data-source-choice]").forEach((button) => button.addEventListener("click", () => {
  $("#addSourceModal").hidden = true;
  document.body.style.overflow = "";
  if (button.dataset.sourceChoice === "jellyfin") {
    openNewJellyfinSource();
  }
  if (button.dataset.sourceChoice === "json") openCatalogFilePicker();
  if (!["jellyfin", "json"].includes(button.dataset.sourceChoice)) {
    toast(`${button.querySelector("strong").textContent} setup is coming next.`);
  }
}));
$("#importCatalogButton").addEventListener("click", openCatalogFilePicker);
$$(".source-import-trigger").forEach((button) => button.addEventListener("click", openCatalogFilePicker));
$("#catalogImportFile").addEventListener("change", (event) => {
  const file = event.target.files[0];
  if (file) previewCatalogFile(file).catch((error) => toast(error.message, 5000));
});
$("#exportCatalogButton").addEventListener("click", downloadCatalogExport);
$("#exportLocalCatalog").addEventListener("click", downloadCatalogExport);
$("#syncAllSourcesButton").addEventListener("click", () => $("#refreshLibraryAction").click());
$("#sourceFullRefreshButton").addEventListener("click", async () => {
  const button = $("#sourceFullRefreshButton");
  button.disabled = true;
  button.textContent = "Refreshing…";
  toast("Metadata refresh started.", 3000);
  try {
    const result = await startAndPollMetadataRefresh();
    toast(result.message || "Metadata refresh complete.", 7000);
    await Promise.all([loadSources(), loadDashboard()]);
  } catch (error) {
    console.error("Master catalog metadata refresh failed:", error);
    toast("Metadata refresh failed. Check server logs.", 6000);
  } finally {
    button.disabled = false;
    button.textContent = "Refresh Metadata";
  }
});
$("#viewLocalItems").addEventListener("click", () => setView("collection", { type: "", status: "", origin: "" }));
$("#closeCatalogImport").addEventListener("click", closeCatalogImport);
$("#catalogImportModal").addEventListener("click", (event) => {
  if (event.target === $("#catalogImportModal")) closeCatalogImport();
});
$$(".catalog-preview-tabs .preview-tab").forEach((tab) =>
  tab.addEventListener("click", () => renderCatalogPreview(tab.dataset.catalogPreview))
);
$$(".settings-tab").forEach((button) =>
  button.addEventListener("click", () => {
    setSettingsTab(button.dataset.settingsTab);
    if (button.dataset.settingsTab === "sources") loadSources();
  })
);
$("#refreshSourceStatus")?.addEventListener("click", async () => {
  $("#refreshSourceStatus").disabled = true;
  $("#refreshSourceStatus").textContent = "Checking…";
  try {
    renderSourceStatus(await api("/api/source-status/refresh", { method: "POST", body: "{}" }));
    toast("Source status updated.");
  } catch (error) { toast(`Source check failed: ${error.message}`, 5000); }
  finally { $("#refreshSourceStatus").disabled = false; $("#refreshSourceStatus").textContent = "Check Now"; }
});
$("#today").textContent = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date()).toUpperCase();

function restoreNavigation(historyState = null, historyMode = "none") {
  const navigation = navigationFromLocation(historyState);
  setView(
    navigation.view || "dashboard",
    {
      type: navigation.type || "",
      status: navigation.status || "",
      origin: navigation.origin || "",
      query: navigation.query || "",
      settingsTab: navigation.settingsTab || "sources",
    },
    { historyMode },
  );
}

window.addEventListener("popstate", (event) => {
  restoreNavigation(event.state, "none");
});

restoreNavigation(window.history.state, "replace");
