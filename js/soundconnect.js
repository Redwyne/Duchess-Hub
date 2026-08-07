(function () {
  "use strict";

  /* =====================================================================
     DUCHESS HUB — Onglet Sound Connect
     =====================================================================
     Catalogue audio PHONO (SharePoint). Le backend (voir backend/main.py,
     section "Sound Connect") fait tout le travail lourd : parcours de
     l'arborescence via Make, sélection de LA version à afficher (mix le
     plus récent en 44kHz, jamais instru/PBO/48kHz — voir _sc_pick_best_version
     côté backend). Ce fichier ne fait que : charger /soundconnect/catalog,
     l'afficher groupé par artiste, filtrer en local, et piloter un lecteur
     audio unique (barre fixe en bas, comme Bridge.audio / Spotify) branché
     directement sur le lien de téléchargement SharePoint — pas de streaming
     ni de transcodage côté serveur pour ce V1.
     ===================================================================== */

  const BACKEND_BASE_URL = "https://duchess-hub.onrender.com";

  const listEl = document.getElementById("sc-list");
  const emptyEl = document.getElementById("sc-empty");
  const searchInput = document.getElementById("sc-search");
  const countEl = document.getElementById("sc-count");
  const syncBtn = document.getElementById("sc-syncBtn");
  const syncStatusEl = document.getElementById("sc-syncStatus");
  const unresolvedWrap = document.getElementById("sc-unresolved");
  const unresolvedToggle = document.getElementById("sc-unresolvedToggle");
  const unresolvedCountEl = document.getElementById("sc-unresolvedCount");
  const unresolvedListEl = document.getElementById("sc-unresolvedList");

  const player = document.getElementById("sc-player");
  const audioEl = document.getElementById("sc-audio");
  const playerTitleEl = document.getElementById("sc-playerTitle");
  const playerArtistEl = document.getElementById("sc-playerArtist");
  const playerCloseBtn = document.getElementById("sc-playerClose");

  if (!listEl) return; // onglet pas présent (sécurité si le script est chargé ailleurs)

  let tracks = [];
  let currentRow = null;
  let syncing = false;

  // ---------------------------------------------------------------------
  // Utilitaires
  // ---------------------------------------------------------------------

  function normalize(s) {
    return (s || "")
      .toString()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase();
  }

  function formatSize(bytes) {
    if (!bytes && bytes !== 0) return "";
    const mo = bytes / (1024 * 1024);
    return mo >= 1 ? `${mo.toFixed(1)} Mo` : `${(bytes / 1024).toFixed(0)} Ko`;
  }

  function formatSyncedAt(iso) {
    if (!iso) return "Pas encore synchronisé";
    try {
      const d = new Date(iso);
      return "Synchronisé " + d.toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
    } catch (e) {
      return "Synchronisé";
    }
  }

  function escapeHtml(s) {
    return (s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ---------------------------------------------------------------------
  // Rendu
  // ---------------------------------------------------------------------

  function badgeFor(track) {
    if (track.versionConfidence === "unresolved") return '<span class="sc-badge sc-badge-unresolved" title="Aucune version 44kHz ou non-instru trouvée — à vérifier">non résolu</span>';
    if (track.versionConfidence === "fallback") return '<span class="sc-badge sc-badge-fallback" title="Nommage non standard, meilleure estimation">à vérifier</span>';
    return "";
  }

  function renderList(filterText) {
    const q = normalize(filterText);
    const byArtist = new Map();
    for (const t of tracks) {
      if (q) {
        const hay = normalize(t.artist + " " + t.title);
        if (!hay.includes(q)) continue;
      }
      if (!byArtist.has(t.artist)) byArtist.set(t.artist, []);
      byArtist.get(t.artist).push(t);
    }

    const artists = [...byArtist.keys()].sort((a, b) => a.localeCompare(b, "fr"));
    let shown = 0;

    if (artists.length === 0) {
      listEl.innerHTML = "";
      if (tracks.length > 0) {
        listEl.innerHTML = '<div class="sc-empty"><p>Aucun résultat pour cette recherche.</p></div>';
      } else {
        listEl.appendChild(emptyEl);
        emptyEl.classList.remove("hidden");
      }
      countEl.textContent = "0 titre";
      return;
    }

    emptyEl.classList.add("hidden");
    const frag = document.createDocumentFragment();
    for (const artist of artists) {
      const rows = byArtist.get(artist).sort((a, b) => a.title.localeCompare(b.title, "fr"));
      shown += rows.length;

      const group = document.createElement("div");
      group.className = "sc-artist-group";
      group.innerHTML = `<div class="sc-artist-name">${escapeHtml(artist)} <span class="sc-artist-count">${rows.length} titre${rows.length > 1 ? "s" : ""}</span></div>`;

      for (const t of rows) {
        const row = document.createElement("div");
        row.className = "sc-track-row";
        row.dataset.trackId = t.id;
        row.innerHTML = `
          <button type="button" class="sc-play-btn" aria-label="Lire ${escapeHtml(t.title)}">▶</button>
          <div class="sc-track-title">${escapeHtml(t.title)} ${badgeFor(t)}</div>
          <div class="sc-track-meta">${formatSize(t.size)}</div>
          <a class="sc-track-link" href="${t.webUrl || "#"}" target="_blank" rel="noopener" title="Ouvrir dans SharePoint">↗</a>
        `;
        row.querySelector(".sc-play-btn").addEventListener("click", () => playTrack(t, row));
        group.appendChild(row);
      }
      frag.appendChild(group);
    }
    listEl.innerHTML = "";
    listEl.appendChild(frag);
    countEl.textContent = `${shown} titre${shown > 1 ? "s" : ""}`;
  }

  function renderUnresolvedFolders(list) {
    if (!list || list.length === 0) {
      unresolvedWrap.classList.add("hidden");
      return;
    }
    unresolvedWrap.classList.remove("hidden");
    unresolvedCountEl.textContent = list.length;
    unresolvedListEl.innerHTML = list
      .map((f) => `<div>· ${escapeHtml(f.artist)} / ${escapeHtml(f.title)} — ${f.fileCount} fichier${f.fileCount > 1 ? "s" : ""}, aucun ne correspond à un format audio reconnu</div>`)
      .join("");
  }

  // ---------------------------------------------------------------------
  // Lecteur
  // ---------------------------------------------------------------------

  function playTrack(track, row) {
    if (currentRow) currentRow.classList.remove("playing");
    if (currentRow === row && !audioEl.paused) {
      audioEl.pause();
      player.classList.add("hidden");
      currentRow = null;
      return;
    }
    audioEl.src = track.downloadUrl;
    player.classList.remove("hidden");
    playerTitleEl.textContent = track.title;
    playerArtistEl.textContent = track.artist;
    audioEl.play().catch(() => {});
    row.classList.add("playing");
    currentRow = row;
  }

  playerCloseBtn.addEventListener("click", () => {
    audioEl.pause();
    audioEl.removeAttribute("src");
    player.classList.add("hidden");
    if (currentRow) currentRow.classList.remove("playing");
    currentRow = null;
  });

  audioEl.addEventListener("ended", () => {
    if (currentRow) currentRow.classList.remove("playing");
    currentRow = null;
  });

  // ---------------------------------------------------------------------
  // Chargement / synchronisation
  // ---------------------------------------------------------------------

  async function loadCatalog() {
    try {
      const r = await fetch(`${BACKEND_BASE_URL}/soundconnect/catalog`);
      const data = await r.json();
      tracks = data.tracks || [];
      syncStatusEl.textContent = formatSyncedAt(data.syncedAt);
      renderUnresolvedFolders(data.unresolvedFolders);
      renderList(searchInput.value);
    } catch (e) {
      syncStatusEl.textContent = "Erreur de connexion au serveur";
    }
  }

  async function runSync() {
    if (syncing) return;
    syncing = true;
    syncBtn.disabled = true;
    syncBtn.textContent = "Synchronisation… (~1 min)";
    syncStatusEl.textContent = "Parcours de PHONO en cours…";
    try {
      const r = await fetch(`${BACKEND_BASE_URL}/soundconnect/sync`, { method: "POST" });
      if (!r.ok) throw new Error("sync failed");
      await loadCatalog();
    } catch (e) {
      syncStatusEl.textContent = "Échec de la synchronisation — réessaie dans un instant.";
    } finally {
      syncing = false;
      syncBtn.disabled = false;
      syncBtn.textContent = "Rafraîchir le catalogue";
    }
  }

  syncBtn.addEventListener("click", runSync);
  searchInput.addEventListener("input", () => renderList(searchInput.value));
  unresolvedToggle.addEventListener("click", () => {
    const open = unresolvedToggle.classList.toggle("open");
    unresolvedListEl.classList.toggle("hidden", !open);
  });

  loadCatalog();
})();
