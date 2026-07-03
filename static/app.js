const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => document.querySelectorAll(selector);
const state = { query: "", type: "", status: "", origin: "", view: "dashboard", items: [], jellyfinPreview: null, previewCategory: "matches", quickItem: null, providerPriority: "omdb,tmdb", musicProviders: ["musicbrainz"], settingsTab: "metadata", catalogPreview: null, catalogCategory: "new_items" };
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
  const statusClass = item.status === "Archived" ? "archived" : "";
  const providerClass = (item.metadata_provider || "").toLowerCase();
  const detailBits = [
    item.year || "Year unknown",
    item.media_type,
    item.artist || "",
    item.runtime_minutes ? `${item.runtime_minutes} min` : "",
  ].filter(Boolean).join(" · ");
  const sourceBadges = (item.sources || []).map((source) =>
    `<span class="mini-badge source">${escapeHtml(source)}</span>`
  ).join("");
  return `<article class="media-card type-${escapeHtml(item.media_type)}" data-id="${item.id}">
    <div class="cover ${item.poster_url ? "has-poster" : ""}">
      ${item.poster_url ? `<img src="${escapeHtml(item.poster_url)}" alt="" loading="lazy">` : `<span class="cover-icon">${typeIcons[item.media_type] || "MV"}</span>`}
      ${item.metadata_provider ? `<span class="provider-badge ${providerClass}">${escapeHtml(item.metadata_provider)}</span>` : ""}
      <span class="format-badge">${escapeHtml(item.format)}</span>
    </div>
    <div class="card-body"><h3 title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</h3>
      <p class="card-details">${escapeHtml(detailBits)}</p>
      ${item.overview ? `<p class="card-summary">${escapeHtml(item.overview)}</p>` : '<p class="card-summary empty">Metadata summary not available.</p>'}
      ${sourceBadges ? `<div class="card-sources">${sourceBadges}</div>` : ""}
      <div class="card-meta"><span class="status-pill ${statusClass}">${escapeHtml(item.status)}</span><span class="rating">${item.rating ? `★ ${Number(item.rating).toFixed(1)}` : escapeHtml(item.physical_location || item.condition || "")}</span></div>
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
  $("#recentGrid").innerHTML = data.recent.length ? data.recent.map(card).join("") : emptyState();
}

async function loadCollection() {
  const params = new URLSearchParams();
  if (state.query) params.set("q", state.query);
  if (state.type) params.set("type", state.type);
  if (state.status) params.set("status", state.status);
  if (state.origin) params.set("source", state.origin);
  state.items = await api(`/api/media?${params}`);
  $("#collectionGrid").innerHTML = state.items.length ? state.items.map(card).join("") : emptyState(Boolean(state.query || state.type || state.status));
  $("#collectionTitle").textContent = state.origin === "manual" ? "Manual Items" : state.type || state.status || "My Collection";
  $("#resultSummary").textContent = `${state.items.length} ${state.items.length === 1 ? "item" : "items"} found`;
}

function setView(view, filters = {}) {
  state.view = view;
  if ("type" in filters) state.type = filters.type;
  if ("status" in filters) state.status = filters.status;
  if ("origin" in filters) state.origin = filters.origin;
  $("#dashboardView").hidden = view !== "dashboard";
  $("#collectionView").hidden = view !== "collection";
  $("#settingsView").hidden = view !== "settings";
  $$(".nav-link").forEach((el) => el.classList.remove("active"));
  $(`[data-view="${view}"]`)?.classList.add("active");
  $("#typeFilter").value = state.type;
  $("#statusFilter").value = state.status;
  $(".sidebar").classList.remove("open");
  if (view === "collection") loadCollection();
  if (view === "settings") {
    setSettingsTab(state.settingsTab);
    Promise.all([loadProviderSettings(), loadSourceStatus(), loadSources()]);
  }
}

async function loadSources() {
  try {
    const data = await api("/api/sources");
    $("#localSourceCount").textContent = data.local.items;
    renderSourceAccordions(data.instances || []);
  } catch (error) { toast(error.message); }
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
  if (!instances.length) {
    $("#externalSourceCards").innerHTML = `<div class="sources-empty-state"><strong>No external sources connected.</strong><span>Connect Jellyfin or add an import source when you are ready.</span><button class="button primary" data-source-action="add">＋ Add Source</button></div>`;
    return;
  }
  $("#externalSourceCards").innerHTML = instances.map((source) => {
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
  }).join("");
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
  return { server_url: card.querySelector(".jf-source-url").value.trim(), api_key: card.querySelector(".jf-source-key").value.trim(), server_name: card.querySelector(".jf-source-name").value.trim() };
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

function setSettingsTab(tab) {
  state.settingsTab = tab;
  $$(".settings-tab").forEach((button) =>
    button.classList.toggle("active", button.dataset.settingsTab === tab)
  );
  $$("[data-settings-section]").forEach((section) => {
    section.hidden = section.id === "importPreview"
      ? tab !== "sources" || !state.jellyfinPreview
      : section.dataset.settingsSection !== tab;
  });
}

async function loadProviderSettings() {
  try {
    const data = await api("/api/settings/providers");
    state.providerPriority = data.metadata_provider_priority || "omdb,tmdb";
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
    $("#musicProviderPriority").value = data.music_provider_priority || "musicbrainz,discogs,coverartarchive,lastfm";
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
      ? `${data.last_result.processed || 0} processed · ${data.last_result.added || 0} added · ${data.last_result.updated || 0} updated · ${data.last_result.skipped || 0} skipped · ${data.last_result.failed || 0} failed`
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
  $("#jellyfinSyncStatus").innerHTML = `<p><strong>Sync complete</strong><span>${result.processed || 0} processed · ${result.added || 0} added · ${result.updated || 0} updated · ${result.skipped || 0} skipped · ${result.failed || 0} failed</span></p>${libraryLines}`;
  $("#jellyfinSyncStatus").hidden = false;
  $("#jellyfinLastSync").textContent = `Last sync: ${new Date(result.last_sync).toLocaleString()}`;
  $("#jellyfinLastResult").textContent = `${result.processed || 0} processed · ${result.added || 0} added · ${result.updated || 0} updated · ${result.skipped || 0} skipped · ${result.failed || 0} failed`;
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
    ? "Album metadata is available through MusicBrainz. Choose Change Metadata Source to find the exact release."
    : "No overview is available. Attach an OMDb or TMDB metadata provider to enrich this item.");
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
  if (data.metadata_source) sourceLabels.push(`<span class="source-chip ${escapeHtml(data.metadata_source.provider)}">${escapeHtml(data.metadata_source.provider.toUpperCase())} Metadata</span>`);
  if (data.sources.jellyfin) sourceLabels.push('<span class="source-chip jellyfin">Jellyfin</span>');
  if (collector.media_type === "Music") sourceLabels.push(`<span class="source-chip physical">${escapeHtml(collector.format)}</span>`);
  if (data.sources.physical_media && collector.media_type !== "Music") sourceLabels.push('<span class="source-chip physical">Physical Media</span>');
  $("#quickSources").innerHTML = sourceLabels.join("");
  $("#refreshMetadata").disabled = !(
    data.metadata_source || ["Movies", "Music"].includes(collector.media_type)
  );
  $("#changeMetadata").disabled = !["Movies", "Television", "Music"].includes(collector.media_type);
  $("#removeMetadata").hidden = !data.metadata_source;
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
  $("#mediaForm").reset();
  $("#formError").textContent = "";
  $("#itemId").value = item?.id || "";
  $("#modalTitle").textContent = item ? "Edit catalog item" : "Add to your vault";
  $("#saveButton").textContent = item ? "Save changes" : "Add to collection";
  $("#deleteButton").hidden = !item;
  $('[name="title"]').readOnly = Boolean(item);
  $('[name="year"]').readOnly = Boolean(item);
  $('[name="title"]').title = item ? "Title is read-only in Edit. Refresh attached metadata to update display information." : "";
  $('[name="year"]').title = item ? "Year is read-only in Edit. Refresh attached metadata to update display information." : "";
  if (item) {
    Object.entries(item).forEach(([key, value]) => {
      const field = $(`[name="${key}"]`);
      if (field) field.value = Array.isArray(value) ? value.join(", ") : (value ?? "");
    });
  } else {
    $('[name="status"]').value = "Unassigned";
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

function toast(message, duration = 2200) {
  $("#toast").textContent = message;
  $("#toast").classList.add("show");
  setTimeout(() => $("#toast").classList.remove("show"), duration);
}

document.addEventListener("click", async (event) => {
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
  const mediaCard = event.target.closest(".media-card");
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
  searchTimer = setTimeout(() => { state.query = event.target.value.trim(); state.origin = ""; setView("collection"); }, 180);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)) { event.preventDefault(); $("#searchInput").focus(); }
  if (event.key === "Escape" && !$("#metadataSearchModal").hidden) closeMetadataSearch();
  else if (event.key === "Escape" && !$("#modal").hidden) closeModal();
  else if (event.key === "Escape" && !$("#quickView").hidden) closeQuickView();
});

$$("[data-view]").forEach((el) => el.addEventListener("click", () => setView(el.dataset.view, { type: "", status: "", origin: "" })));
$$(".type-link").forEach((el) => el.addEventListener("click", () => setView("collection", { type: el.dataset.type, status: "", origin: "" })));
$$(".stat-card[data-stat-filter]").forEach((el) => el.addEventListener("click", () => setView("collection", { type: el.dataset.statFilter, status: "", origin: "" })));
$("#viewAll").addEventListener("click", () => setView("collection", { type: "", status: "", origin: "" }));
$("#typeFilter").addEventListener("change", (e) => { state.type = e.target.value; loadCollection(); });
$("#statusFilter").addEventListener("change", (e) => { state.status = e.target.value; loadCollection(); });
$("#clearFilters").addEventListener("click", () => { state.type = ""; state.status = ""; state.query = ""; $("#searchInput").value = ""; $("#typeFilter").value = ""; $("#statusFilter").value = ""; loadCollection(); });
$("#addButton").addEventListener("click", () => openModal());
$("#closeModal").addEventListener("click", closeModal);
$("#cancelButton").addEventListener("click", closeModal);
$("#modal").addEventListener("click", (e) => { if (e.target === $("#modal")) closeModal(); });
$("#closeQuickView").addEventListener("click", closeQuickView);
$("#closeQuickButton").addEventListener("click", closeQuickView);
$("#quickView").addEventListener("click", (e) => { if (e.target === $("#quickView")) closeQuickView(); });
$("#editQuickView").addEventListener("click", () => {
  if (!state.quickItem) return;
  closeQuickView();
  openModal(state.quickItem.collector);
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
        music_provider_priority: $("#musicProviderPriority").value,
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
  } finally { $("#testTmdb").disabled = false; $("#testTmdb").textContent = "Test TMDB"; }
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
  try {
    const result = await api("/api/metadata/refresh-all", { method: "POST", body: "{}" });
    $("#bulkProcessed").textContent = result.processed;
    $("#bulkEnriched").textContent = result.enriched;
    $("#bulkSkipped").textContent = result.skipped;
    $("#bulkFailed").textContent = result.failed;
    $("#bulkStatusTitle").textContent = "Metadata refresh complete";
    $("#bulkStatusNote").textContent = `${result.enriched} enriched · ${result.skipped} skipped · ${result.failed} failed`;
    $("#bulkCategoryStatus").innerHTML = Object.entries(result.categories || {}).map(([name, counts]) =>
      `<div><strong>${escapeHtml(name)}</strong><span>${counts.enriched} enriched · ${counts.skipped} skipped · ${counts.failed} failed</span></div>`
    ).join("");
    const failed = result.failures.filter((item) => item.status === "failed");
    $("#viewFailedItems").hidden = !failed.length;
    $("#failedItems").innerHTML = failed.map((item) => `<div><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.error)}</span></div>`).join("");
    await loadDashboard();
  } catch (error) {
    $("#bulkStatusTitle").textContent = "Refresh failed";
    $("#bulkStatusNote").textContent = error.message;
  } finally {
    $("#refreshAllMetadata").disabled = false;
    $("#refreshAllMetadata").textContent = "Refresh All Metadata";
  }
});
$("#viewFailedItems").addEventListener("click", () => {
  $("#failedItems").hidden = !$("#failedItems").hidden;
  $("#viewFailedItems").textContent = $("#failedItems").hidden ? "View failed items" : "Hide failed items";
});
$("#menuButton").addEventListener("click", () => $(".sidebar").classList.toggle("open"));
$("#refreshLibraryAction").addEventListener("click", async () => {
  const button = $("#refreshLibraryAction");
  const original = button.innerHTML;
  button.disabled = true;
  button.innerHTML = "<span>↻</span> Refreshing…";
  try {
    const result = await api("/api/jellyfin/sync", { method: "POST", body: "{}" });
    toast(`${result.processed || 0} processed · ${result.added || 0} added · ${result.updated || 0} updated · ${result.skipped || 0} skipped · ${result.failed || 0} failed`, 6000);
    await loadDashboard();
    if (state.view === "collection") await loadCollection();
    if (state.view === "settings") await loadSources();
  } catch (error) { toast(`Library refresh failed: ${error.message}`, 6000); }
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
$("#exportCatalogButton").addEventListener("click", () => { window.location.href = "/api/catalog/export"; });
$("#exportLocalCatalog").addEventListener("click", () => { window.location.href = "/api/catalog/export"; });
$("#syncAllSourcesButton").addEventListener("click", () => $("#refreshLibraryAction").click());
$("#sourceFullRefreshButton").addEventListener("click", async () => {
  if (!confirm("Run a full source and metadata refresh? MediaVault will not delete records or overwrite collector fields.")) return;
  try {
    const result = await api("/api/jellyfin/full-refresh", { method: "POST", body: "{}" });
    toast(`Full refresh complete · ${result.sync.added || 0} added · ${result.sync.updated || 0} updated · ${result.sync.failed || 0} failed`, 6000);
    await Promise.all([loadSources(), loadDashboard()]);
  } catch (error) { toast(error.message, 6000); }
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
  button.addEventListener("click", () => setSettingsTab(button.dataset.settingsTab))
);
$("#refreshSourceStatus").addEventListener("click", async () => {
  $("#refreshSourceStatus").disabled = true;
  $("#refreshSourceStatus").textContent = "Checking…";
  try {
    renderSourceStatus(await api("/api/source-status/refresh", { method: "POST", body: "{}" }));
    toast("Source status updated.");
  } catch (error) { toast(`Source check failed: ${error.message}`, 5000); }
  finally { $("#refreshSourceStatus").disabled = false; $("#refreshSourceStatus").textContent = "Check Now"; }
});
$("#today").textContent = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date()).toUpperCase();

loadDashboard().catch((error) => toast(error.message));
