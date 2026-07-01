const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => document.querySelectorAll(selector);
const state = { query: "", type: "", status: "", view: "dashboard", items: [], jellyfinPreview: null, previewCategory: "matches", quickItem: null, providerPriority: "omdb,tmdb", musicProviders: ["musicbrainz"] };
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
  if (view === "settings") Promise.all([loadJellyfinSettings(), loadProviderSettings()]);
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
  if (data.sources.wishlist) sourceLabels.push('<span class="source-chip wishlist">Wishlist</span>');
  if (data.sources.upgrade_wanted) sourceLabels.push('<span class="source-chip upgrade">Upgrade Wanted</span>');
  $("#quickSources").innerHTML = sourceLabels.join("");
  $("#refreshMetadata").disabled = !(data.metadata_source || collector.media_type === "Movies");
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
    try { await openQuickView(mediaCard.dataset.id); } catch (error) { toast(error.message); }
  }
  if (event.target.closest(".empty-add")) openModal();
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
  searchTimer = setTimeout(() => { state.query = event.target.value.trim(); setView("collection"); }, 180);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)) { event.preventDefault(); $("#searchInput").focus(); }
  if (event.key === "Escape" && !$("#metadataSearchModal").hidden) closeMetadataSearch();
  else if (event.key === "Escape" && !$("#modal").hidden) closeModal();
  else if (event.key === "Escape" && !$("#quickView").hidden) closeQuickView();
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
