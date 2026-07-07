const $ = (selector) => document.querySelector(selector);
let musicProviderPriority = "musicbrainz,discogs,coverartarchive,lastfm";
let lastFailures = [];

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = response.status === 204
    ? null
    : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error || "Something went wrong.");
  return data;
}

function escapeHtml(value = "") {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

function toast(message, duration = 3500) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove("show"), duration);
}

const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function startAndPollMetadataRefresh(onUpdate) {
  let result = await api("/api/metadata/refresh-all", {
    method: "POST", body: "{}",
  });
  onUpdate(result);
  while (result.status === "running") {
    await wait(1500);
    result = await api("/api/metadata/refresh-all/status");
    onUpdate(result);
  }
  return result;
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

function updateProviderRow(provider, hasCredential) {
  const row = document.querySelector(`[data-provider-row="${provider}"]`);
  if (!row) return;
  const secret = row.querySelector(`[data-secret-for="${provider}"]`);
  const status = row.querySelector(`[data-status-for="${provider}"]`);
  if (secret) secret.textContent = hasCredential ? "••••••••••••••••" : "Missing";
  if (status) {
    status.textContent = hasCredential ? "Active" : "Missing";
    status.className = `provider-status ${hasCredential ? "active" : "missing"}`;
  }
}

function markProviderTested(provider, result) {
  const tested = document.querySelector(`[data-tested-for="${provider}"]`);
  const status = document.querySelector(`[data-status-for="${provider}"]`);
  if (tested) tested.textContent = `${new Date().toLocaleString()} · ${result}`;
  if (status && result === "Success") {
    status.textContent = "Active";
    status.className = "provider-status active";
  }
}

async function loadSourceStatus() {
  renderSourceStatus(await api("/api/source-status"));
}

async function loadProviderSettings() {
  const data = await api("/api/settings/providers");
  musicProviderPriority = data.music_provider_priority
    || "musicbrainz,discogs,coverartarchive,lastfm";
  $("#omdbKey").value = "";
  $("#tmdbKey").value = "";
  $("#discogsToken").value = "";
  $("#lastfmKey").value = "";
  $("#rawgKey").value = "";
  $("#providerPriority").value = data.metadata_provider_priority || "omdb,tmdb";
  $("#omdbKey").placeholder = data.has_omdb_api_key
    ? "OMDb key saved — leave blank to keep it" : "Enter your OMDb API key";
  $("#omdbKeyHint").textContent = data.has_omdb_api_key
    ? "An OMDb key is stored locally on the server."
    : "Primary movie metadata provider.";
  $("#tmdbKey").placeholder = data.has_tmdb_api_key
    ? "TMDB credential saved — leave blank to keep it"
    : "Enter your TMDB credential";
  $("#tmdbKeyHint").textContent = data.has_tmdb_api_key
    ? "A TMDB credential is stored locally on the server."
    : "Used for Movies and Television metadata.";
  $("#discogsToken").placeholder = data.has_discogs_token
    ? "Discogs token saved — leave blank to keep it" : "Optional";
  $("#lastfmKey").placeholder = data.has_lastfm_api_key
    ? "Last.fm key saved — leave blank to keep it" : "Optional";
  $("#rawgKey").placeholder = data.has_rawg_api_key
    ? "RAWG key saved — leave blank to keep it" : "Optional";
  updateProviderRow("omdb", data.has_omdb_api_key);
  updateProviderRow("tmdb", data.has_tmdb_api_key);
  updateProviderRow("discogs", data.has_discogs_token);
  updateProviderRow("lastfm", data.has_lastfm_api_key);
  updateProviderRow("rawg", data.has_rawg_api_key);
}

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
        music_provider_priority: musicProviderPriority,
        discogs_token: $("#discogsToken").value.trim(),
        lastfm_api_key: $("#lastfmKey").value.trim(),
        rawg_api_key: $("#rawgKey").value.trim(),
      }),
    });
    await loadProviderSettings();
    toast("Metadata provider settings saved.");
  } catch (error) {
    $("#providerError").textContent = error.message;
  }
});

async function testProvider(provider, button, successLabel) {
  $("#providerError").textContent = "";
  button.disabled = true;
  const original = button.textContent;
  button.textContent = "Testing…";
  try {
    await api(`/api/metadata/${provider}/test`, {
      method: "POST",
      body: "{}",
    });
    $("#tmdbBadge").textContent = successLabel;
    $("#tmdbBadge").classList.add("connected");
    markProviderTested(provider, "Success");
  } catch (error) {
    $("#tmdbBadge").textContent = "Connection failed";
    $("#tmdbBadge").classList.remove("connected");
    $("#providerError").textContent = error.message;
    markProviderTested(provider, "Failed");
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

$("#testOmdb").addEventListener("click", () =>
  testProvider("omdb", $("#testOmdb"), "OMDb connected")
);
$("#testTmdb").addEventListener("click", () =>
  testProvider("tmdb", $("#testTmdb"), "TMDb connected")
);

document.querySelectorAll("[data-manage-provider]").forEach((button) => {
  button.addEventListener("click", () => {
    const provider = button.dataset.manageProvider;
    const panel = document.querySelector(`[data-provider-panel="${provider}"]`);
    if (!panel) return;
    panel.hidden = !panel.hidden;
    button.textContent = panel.hidden ? "Manage" : "Close";
  });
});

$("#addProviderKey").addEventListener("click", () => {
  const firstClosed = document.querySelector(".provider-manage-panel[hidden]");
  if (!firstClosed) {
    toast("All provider key panels are already open.");
    return;
  }
  firstClosed.hidden = false;
  const provider = firstClosed.dataset.providerPanel;
  const button = document.querySelector(`[data-manage-provider="${provider}"]`);
  if (button) button.textContent = "Close";
  firstClosed.querySelector("input")?.focus();
});

$("#refreshSourceStatus").addEventListener("click", async () => {
  const button = $("#refreshSourceStatus");
  button.disabled = true;
  button.textContent = "Checking…";
  try {
    renderSourceStatus(await api("/api/source-status/refresh", {
      method: "POST", body: "{}",
    }));
    toast("Provider status updated.");
  } catch (error) {
    toast(`Provider check failed: ${error.message}`, 5000);
  } finally {
    button.disabled = false;
    button.textContent = "Check Now";
  }
});

$("#refreshAllMetadata").addEventListener("click", async () => {
  const button = $("#refreshAllMetadata");
  $("#bulkStatus").hidden = false;
  $("#bulkStatusTitle").textContent = "Refresh started";
  $("#bulkStatusNote").textContent = "Checking library items against configured providers…";
  button.disabled = true;
  const renderResult = (result) => {
    ["Processed", "Enriched", "Skipped", "Failed"].forEach((name) => {
      $(`#bulk${name}`).textContent = result[name.toLowerCase()] || 0;
    });
    $("#bulkStatusTitle").textContent = result.status === "running"
      ? "Refresh in progress"
      : result.status === "failed"
        ? "Refresh failed"
        : result.warnings || result.failed
          ? "Refresh completed with warnings"
          : "Refresh complete";
    $("#bulkStatusNote").textContent = result.message || "";
    $("#bulkCategoryStatus").innerHTML = Object.entries(result.categories || {})
      .map(([name, counts]) =>
        `<span><strong>${escapeHtml(name)}</strong> ${counts.enriched || 0} enriched · ${counts.skipped || 0} skipped · ${counts.failed || 0} failed · ${counts.warnings || 0} warnings</span>`
      ).join("");
    lastFailures = [
      ...(result.failures || []),
      ...(result.warning_details || []),
    ];
    $("#viewFailedItems").hidden = lastFailures.length === 0;
    $("#viewFailedItems").textContent = "View warning/error details";
  };
  try {
    const result = await startAndPollMetadataRefresh(renderResult);
    toast(result.message || "Metadata refresh complete.", 7000);
  } catch (error) {
    // Preserve the last useful progress snapshot if polling is interrupted.
    $("#bulkStatusNote").textContent =
      "Connection interrupted. Refresh status is still saved on the server.";
    toast("Could not retrieve the latest refresh status.", 5000);
  } finally {
    button.disabled = false;
  }
});

$("#viewFailedItems").addEventListener("click", () => {
  const list = $("#failedItems");
  list.hidden = !list.hidden;
  list.innerHTML = lastFailures.map((item) =>
    `<p><strong>${escapeHtml(item.title || "Refresh job")}</strong>${item.provider ? ` · ${escapeHtml(item.provider)}` : ""} — ${escapeHtml(item.error || item.status || "Not enriched")}</p>`
  ).join("");
});

Promise.all([loadProviderSettings(), loadSourceStatus()]).catch((error) => {
  $("#providerError").textContent = error.message;
});
