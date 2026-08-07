(function () {
  "use strict";

  /* =====================================================================
     DUCHESS HUB — Onglet Sound Connect (V2 : organisation indépendante)
     =====================================================================
     PHONO (SharePoint) n'est qu'une SOURCE de fichiers en arrière-plan (voir
     backend/main.py, section "Sound Connect — organisation indépendante").
     Cette UI navigue une structure Espace -> Dossier -> Projet/Playlist ->
     Titres qui vit dans sa propre base (JSON local + R2 côté backend, migration
     triviale vers D1 plus tard) et ne reflète JAMAIS l'arborescence SharePoint
     1:1 — un titre peut être déplacé, dupliqué dans plusieurs playlists, etc.

     Vue façon lecteur de fichiers (Home / Search / Library), inspirée
     Bridge.audio / Untitled UI : sidebar, grilles de tuiles avec mosaïque de
     couleurs (pas de vraies pochettes pour l'instant), page détail type album,
     lecteur en barre fixe avec transport complet (play/pause/prev/next/seek/volume).
     ===================================================================== */

  const BACKEND_BASE_URL = "https://duchess-hub.onrender.com";

  const root = document.getElementById("tab-soundconnect");
  if (!root) return; // onglet pas présent

  // ---------------------------------------------------------------------
  // Refs
  // ---------------------------------------------------------------------
  const navHome = document.getElementById("sc-nav-home");
  const navSearch = document.getElementById("sc-nav-search");
  const workspaceListEl = document.getElementById("sc-workspaceList");
  const addWorkspaceBtn = document.getElementById("sc-addWorkspaceBtn");
  const syncBtn = document.getElementById("sc-syncBtn");
  const syncStatusEl = document.getElementById("sc-syncStatus");
  const breadcrumbEl = document.getElementById("sc-breadcrumb");
  const topbarActionsEl = document.getElementById("sc-topbarActions");
  const contentEl = document.getElementById("sc-content");

  const player = document.getElementById("sc-player");
  const audioEl = document.getElementById("sc-audio");
  const playerArt = document.getElementById("sc-playerArt");
  const playerTitleEl = document.getElementById("sc-playerTitle");
  const playerArtistEl = document.getElementById("sc-playerArtist");
  const playerCloseBtn = document.getElementById("sc-playerClose");
  const playPauseBtn = document.getElementById("sc-playPauseBtn");
  const prevBtn = document.getElementById("sc-prevBtn");
  const nextBtn = document.getElementById("sc-nextBtn");
  const seekEl = document.getElementById("sc-seek");
  const volumeEl = document.getElementById("sc-volume");
  const timeCurrentEl = document.getElementById("sc-timeCurrent");
  const timeTotalEl = document.getElementById("sc-timeTotal");

  const addModal = document.getElementById("sc-addModal");
  const addModalClose = document.getElementById("sc-addModalClose");
  const addModalSearch = document.getElementById("sc-addModalSearch");
  const addModalResults = document.getElementById("sc-addModalResults");

  const newModal = document.getElementById("sc-newModal");
  const newModalTitle = document.getElementById("sc-newModalTitle");
  const newModalClose = document.getElementById("sc-newModalClose");
  const newModalName = document.getElementById("sc-newModalName");
  const newModalConfirm = document.getElementById("sc-newModalConfirm");

  // ---------------------------------------------------------------------
  // État
  // ---------------------------------------------------------------------
  let breadcrumbStack = [{ type: "home", name: "Home" }];
  let currentQueue = [];
  let currentIndex = -1;
  let currentFolderIdForAdd = null; // dossier ciblé par la modale "Ajouter des titres"
  let newModalMode = "workspace"; // 'workspace' | 'folder' | 'playlist' | 'rename'
  let newModalCtx = {};
  let allWorkspaces = [];

  // ---------------------------------------------------------------------
  // Utilitaires
  // ---------------------------------------------------------------------

  async function fetchJSON(path, options) {
    const r = await fetch(BACKEND_BASE_URL + path, options);
    if (!r.ok) {
      let detail = r.statusText;
      try { detail = (await r.json()).detail || detail; } catch (e) {}
      throw new Error(detail);
    }
    return r.json();
  }

  function escapeHtml(s) {
    return (s || "").toString().replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  function formatSize(bytes) {
    if (!bytes && bytes !== 0) return "";
    const mo = bytes / (1024 * 1024);
    return mo >= 1 ? `${mo.toFixed(1)} Mo` : `${(bytes / 1024).toFixed(0)} Ko`;
  }

  function formatTime(s) {
    if (!isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60).toString().padStart(2, "0");
    return `${m}:${sec}`;
  }

  function formatSyncedAt(iso) {
    if (!iso) return "Pas encore synchronisé";
    try {
      const d = new Date(iso);
      return "Synchronisé " + d.toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
    } catch (e) { return "Synchronisé"; }
  }

  function initials(str) {
    const words = (str || "?").trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return "?";
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[1][0]).toUpperCase();
  }

  function hashColor(str) {
    let h = 0;
    for (let i = 0; i < (str || "").length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
    const hue = h % 360;
    return `hsl(${hue}, 46%, 38%)`;
  }

  function badgeFor(track) {
    if (track.versionConfidence === "unresolved") return '<span class="sc-badge sc-badge-unresolved" title="Aucune version 44kHz ou non-instru trouvée">non résolu</span>';
    if (track.versionConfidence === "fallback") return '<span class="sc-badge sc-badge-fallback" title="Nommage non standard, meilleure estimation">à vérifier</span>';
    return "";
  }

  function setActiveNav(which) {
    navHome.classList.toggle("active", which === "home");
    navSearch.classList.toggle("active", which === "search");
    workspaceListEl.querySelectorAll(".sc-workspace-item").forEach((el) => el.classList.remove("active"));
  }

  function setActiveWorkspace(id) {
    navHome.classList.remove("active");
    navSearch.classList.remove("active");
    workspaceListEl.querySelectorAll(".sc-workspace-item").forEach((el) => el.classList.toggle("active", el.dataset.id === id));
  }

  function setTopbarActions(html) { topbarActionsEl.innerHTML = html || ""; }

  function renderBreadcrumb() {
    breadcrumbEl.innerHTML = breadcrumbStack.map((c, i) => {
      const isLast = i === breadcrumbStack.length - 1;
      const sep = i > 0 ? '<span class="sc-crumb-sep">/</span>' : "";
      return `${sep}<button type="button" class="sc-crumb ${isLast ? "current" : ""}" data-idx="${i}">${escapeHtml(c.name)}</button>`;
    }).join("");
    breadcrumbEl.querySelectorAll(".sc-crumb").forEach((el, i) => {
      if (i === breadcrumbStack.length - 1) return;
      el.addEventListener("click", () => gotoBreadcrumb(i));
    });
  }

  function gotoBreadcrumb(i) {
    const c = breadcrumbStack[i];
    if (c.type === "home") showHome();
    else if (c.type === "search") showSearch();
    else if (c.type === "workspace") showWorkspace(c.id, c.name);
    else if (c.type === "folder") showFolder(c.id, c.name, breadcrumbStack.slice(0, i));
  }

  function emptyStateHtml(text, sub) {
    return `<div class="sc-empty"><div class="sc-empty-icon">♪</div><p>${escapeHtml(text)}</p>${sub ? `<p class="sc-empty-sub">${escapeHtml(sub)}</p>` : ""}</div>`;
  }

  // ---------------------------------------------------------------------
  // Sidebar / espaces
  // ---------------------------------------------------------------------

  async function loadSidebar() {
    try {
      const res = await fetchJSON("/soundconnect/workspaces");
      allWorkspaces = res.workspaces;
      workspaceListEl.innerHTML = allWorkspaces.map((ws) => `
        <button type="button" class="sc-workspace-item" data-id="${ws.id}" data-name="${escapeHtml(ws.name)}">
          <span class="sc-workspace-icon">${escapeHtml(initials(ws.name))}</span>
          <span>${escapeHtml(ws.name)}</span>
        </button>
      `).join("");
      workspaceListEl.querySelectorAll(".sc-workspace-item").forEach((el) => {
        el.addEventListener("click", () => showWorkspace(el.dataset.id, el.dataset.name));
      });
    } catch (e) {
      workspaceListEl.innerHTML = `<div class="sc-empty-sub">Erreur de chargement</div>`;
    }
  }

  // ---------------------------------------------------------------------
  // Tuiles
  // ---------------------------------------------------------------------

  function tileHtml({ id, name, kind, meta, preview, showPlay }) {
    const cells = (preview && preview.length ? preview : [name]).slice(0, 4);
    const mosaicClass = cells.length <= 1 ? "sc-mosaic-1" : "";
    const coverInner = cells.map((label) => `<div class="sc-mosaic-cell" style="background:${hashColor(label)}">${escapeHtml(initials(label))}</div>`).join("");
    return `
      <div class="sc-tile" data-id="${id}" data-name="${escapeHtml(name)}" data-kind="${kind}">
        <div class="sc-tile-cover sc-cover-mosaic ${mosaicClass}">
          ${coverInner}
          ${showPlay ? `<button type="button" class="sc-tile-play" data-play-id="${id}" aria-label="Lire">▶</button>` : ""}
        </div>
        <div class="sc-tile-name">${escapeHtml(name)}</div>
        <div class="sc-tile-meta">${meta || ""}</div>
      </div>`;
  }

  function renderTileGrid(folders, { onTileClick }) {
    if (!folders.length) {
      contentEl.innerHTML = emptyStateHtml("Rien ici pour l'instant.", "Utilise les boutons en haut à droite pour créer un dossier ou une playlist.");
      return;
    }
    contentEl.innerHTML = `<div class="sc-tile-grid">${folders.map((f) => tileHtml({
      id: f.id, name: f.name, kind: f.kind,
      meta: f.childCount ? `${f.childCount} élément${f.childCount > 1 ? "s" : ""}` : `${f.trackCount} titre${f.trackCount > 1 ? "s" : ""}`,
      preview: f.preview, showPlay: f.trackCount > 0 && f.childCount === 0,
    })).join("")}</div>`;
    contentEl.querySelectorAll(".sc-tile").forEach((el) => {
      el.addEventListener("click", (e) => {
        if (e.target.closest(".sc-tile-play")) return;
        onTileClick(el.dataset.id, el.dataset.name);
      });
    });
    contentEl.querySelectorAll(".sc-tile-play").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        try {
          const detail = await fetchJSON(`/soundconnect/folders/${btn.dataset.playId}`);
          if (detail.tracks.length) playQueue(detail.tracks, 0);
        } catch (err) {}
      });
    });
  }

  // ---------------------------------------------------------------------
  // Vues : Home / Workspace / Folder / Search
  // ---------------------------------------------------------------------

  async function showHome() {
    setActiveNav("home");
    breadcrumbStack = [{ type: "home", name: "Home" }];
    renderBreadcrumb();
    setTopbarActions("");
    try {
      const res = allWorkspaces.length ? { workspaces: allWorkspaces } : await fetchJSON("/soundconnect/workspaces");
      if (!res.workspaces.length) {
        contentEl.innerHTML = emptyStateHtml("Aucun espace pour l'instant.", "Clique sur « Rafraîchir PHONO » (barre latérale) pour importer le catalogue, ou crée un espace toi-même.");
        return;
      }
      contentEl.innerHTML = `<div class="sc-tile-grid">${res.workspaces.map((ws) => tileHtml({
        id: ws.id, name: ws.name, kind: "workspace",
        meta: `${ws.folderCount} dossier${ws.folderCount > 1 ? "s" : ""}`, preview: ws.preview,
      })).join("")}</div>`;
      contentEl.querySelectorAll(".sc-tile").forEach((el) => {
        el.addEventListener("click", () => showWorkspace(el.dataset.id, el.dataset.name));
      });
    } catch (e) {
      contentEl.innerHTML = emptyStateHtml("Erreur de chargement.");
    }
  }

  async function showWorkspace(id, name) {
    setActiveWorkspace(id);
    breadcrumbStack = [{ type: "home", name: "Home" }, { type: "workspace", id, name }];
    renderBreadcrumb();
    setTopbarActions(`
      <button type="button" class="sc-btn" id="sc-newFolderTop">+ Nouveau dossier</button>
      <button type="button" class="sc-btn" id="sc-newPlaylistTop">+ Nouvelle playlist</button>
    `);
    document.getElementById("sc-newFolderTop").addEventListener("click", () => openNewModal("folder", { workspaceId: id, parentId: null, title: "Nouveau dossier" }));
    document.getElementById("sc-newPlaylistTop").addEventListener("click", () => openNewModal("playlist", { workspaceId: id, parentId: null, title: "Nouvelle playlist" }));
    try {
      const res = await fetchJSON(`/soundconnect/workspaces/${id}/folders`);
      renderTileGrid(res.folders, { onTileClick: (fid, fname) => showFolder(fid, fname, breadcrumbStack) });
    } catch (e) {
      contentEl.innerHTML = emptyStateHtml("Erreur de chargement.");
    }
  }

  async function showFolder(id, name, parentBreadcrumb) {
    setActiveWorkspace(parentBreadcrumb.find((c) => c.type === "workspace")?.id || "");
    breadcrumbStack = [...parentBreadcrumb, { type: "folder", id, name }];
    renderBreadcrumb();
    let detail;
    try {
      detail = await fetchJSON(`/soundconnect/folders/${id}`);
    } catch (e) {
      contentEl.innerHTML = emptyStateHtml("Dossier introuvable.");
      return;
    }
    const workspaceId = detail.folder.workspaceId;
    if (detail.children.length > 0) {
      setTopbarActions(`
        <button type="button" class="sc-btn" id="sc-newFolderTop">+ Nouveau dossier</button>
        <button type="button" class="sc-btn" id="sc-newPlaylistTop">+ Nouvelle playlist</button>
        <button type="button" class="sc-btn" id="sc-deleteFolderTop" title="Supprimer ce dossier">🗑</button>
      `);
      document.getElementById("sc-newFolderTop").addEventListener("click", () => openNewModal("folder", { workspaceId, parentId: id, title: "Nouveau dossier" }));
      document.getElementById("sc-newPlaylistTop").addEventListener("click", () => openNewModal("playlist", { workspaceId, parentId: id, title: "Nouvelle playlist" }));
      document.getElementById("sc-deleteFolderTop").addEventListener("click", () => deleteFolder(id, parentBreadcrumb));
      renderTileGrid(detail.children, { onTileClick: (fid, fname) => showFolder(fid, fname, breadcrumbStack) });
    } else {
      setTopbarActions(`
        <button type="button" class="sc-btn" id="sc-renameTop">Renommer</button>
        <button type="button" class="sc-btn" id="sc-deleteFolderTop" title="Supprimer">🗑 Supprimer</button>
      `);
      document.getElementById("sc-renameTop").addEventListener("click", () => renameFolder(id, name, parentBreadcrumb));
      document.getElementById("sc-deleteFolderTop").addEventListener("click", () => deleteFolder(id, parentBreadcrumb));
      renderProjectDetail(detail);
    }
  }

  function renderProjectDetail(detail) {
    const f = detail.folder;
    const tracks = detail.tracks;
    contentEl.innerHTML = `
      <div class="sc-detail-head">
        <div class="sc-detail-cover">${tracks.length ? escapeHtml(initials(f.name)) : "♪"}</div>
        <div class="sc-detail-info">
          <h2>${escapeHtml(f.name)}</h2>
          <div class="sc-detail-meta">${f.kind === "playlist" ? "Playlist" : "Projet"} · ${tracks.length} titre${tracks.length > 1 ? "s" : ""}</div>
        </div>
      </div>
      <button type="button" class="sc-add-tracks-btn" id="sc-addTracksBtn">+ Ajouter des titres</button>
      <div class="sc-track-list" id="sc-projectTracks"></div>
    `;
    document.getElementById("sc-addTracksBtn").addEventListener("click", () => openAddModal(f.id));
    renderTrackList(document.getElementById("sc-projectTracks"), tracks, { removable: true, folderId: f.id });
  }

  function renderTrackList(container, tracks, { removable, folderId }) {
    if (!tracks.length) {
      container.innerHTML = `<div class="sc-empty-sub" style="padding:20px 0;">Aucun titre ici pour l'instant.</div>`;
      return;
    }
    container.innerHTML = tracks.map((t, i) => `
      <div class="sc-track-item" data-track-id="${t.id}">
        <div class="sc-track-index">${i + 1}</div>
        <button type="button" class="sc-track-playbtn" data-idx="${i}">▶</button>
        <div class="sc-track-title-cell">
          <div class="sc-track-name">${escapeHtml(t.title)} ${badgeFor(t)}</div>
          <div class="sc-track-sub">${escapeHtml(t.artist)}</div>
        </div>
        <div class="sc-track-meta">${formatSize(t.size)}</div>
        <a class="sc-track-link" href="${t.webUrl || "#"}" target="_blank" rel="noopener" title="Ouvrir dans SharePoint" style="color:var(--muted-2);text-decoration:none;">↗</a>
        ${removable ? `<button type="button" class="sc-track-menu" data-remove-idx="${i}" title="Retirer">✕</button>` : "<span></span>"}
      </div>
    `).join("");
    container.querySelectorAll(".sc-track-playbtn, .sc-track-item").forEach((el) => {
      el.addEventListener("click", (e) => {
        if (e.target.closest(".sc-track-link") || e.target.closest(".sc-track-menu")) return;
        const item = e.currentTarget.closest(".sc-track-item") || e.currentTarget;
        const idx = [...container.querySelectorAll(".sc-track-item")].indexOf(item);
        if (idx >= 0) playQueue(tracks, idx);
      });
    });
    if (removable) {
      container.querySelectorAll("[data-remove-idx]").forEach((btn) => {
        btn.addEventListener("click", async (e) => {
          e.stopPropagation();
          const t = tracks[+btn.dataset.removeIdx];
          try {
            await fetchJSON(`/soundconnect/folders/${folderId}/tracks/${encodeURIComponent(t.id)}`, { method: "DELETE" });
            const detail = await fetchJSON(`/soundconnect/folders/${folderId}`);
            renderProjectDetail(detail);
          } catch (err) {}
        });
      });
    }
    updatePlayingHighlight();
  }

  // ---------------------------------------------------------------------
  // Recherche globale
  // ---------------------------------------------------------------------

  async function showSearch() {
    setActiveNav("search");
    breadcrumbStack = [{ type: "home", name: "Home" }, { type: "search", name: "Search" }];
    renderBreadcrumb();
    setTopbarActions("");
    contentEl.innerHTML = `
      <div class="sc-search-view">
        <div class="sc-search">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
          <input type="search" id="sc-globalSearch" placeholder="Chercher un artiste ou un titre…" autocomplete="off" />
        </div>
        <div class="sc-track-list" id="sc-searchResults"></div>
      </div>
    `;
    const input = document.getElementById("sc-globalSearch");
    input.addEventListener("input", debounce(() => runGlobalSearch(input.value), 200));
    input.focus();
    runGlobalSearch("");
  }

  async function runGlobalSearch(q) {
    const el = document.getElementById("sc-searchResults");
    if (!el) return;
    try {
      const res = await fetchJSON(`/soundconnect/tracks?q=${encodeURIComponent(q)}`);
      if (!res.tracks.length) {
        el.innerHTML = `<div class="sc-search-empty">${q ? "Aucun résultat." : "Le catalogue est vide — synchronise PHONO d'abord."}</div>`;
        return;
      }
      renderTrackList(el, res.tracks, { removable: false });
    } catch (e) {
      el.innerHTML = `<div class="sc-search-empty">Erreur de recherche.</div>`;
    }
  }

  // ---------------------------------------------------------------------
  // Création / renommage / suppression de dossiers
  // ---------------------------------------------------------------------

  function openNewModal(mode, ctx) {
    newModalMode = mode;
    newModalCtx = ctx;
    newModalTitle.textContent = ctx.title || "Nouveau";
    newModalName.value = ctx.prefill || "";
    newModal.classList.remove("hidden");
    newModalName.focus();
  }
  function closeNewModal() { newModal.classList.add("hidden"); }

  newModalClose.addEventListener("click", closeNewModal);
  newModal.addEventListener("click", (e) => { if (e.target === newModal) closeNewModal(); });

  newModalConfirm.addEventListener("click", async () => {
    const name = newModalName.value.trim();
    if (!name) return;
    try {
      if (newModalMode === "workspace") {
        await fetchJSON("/soundconnect/workspaces", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
        closeNewModal();
        await loadSidebar();
        showHome();
      } else if (newModalMode === "folder" || newModalMode === "playlist") {
        await fetchJSON("/soundconnect/folders", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceId: newModalCtx.workspaceId, parentId: newModalCtx.parentId, name, kind: newModalMode }),
        });
        closeNewModal();
        if (newModalCtx.parentId) {
          showFolder(newModalCtx.parentId, "", breadcrumbStack.slice(0, -1)); // nom réel repris via fetch
        } else {
          showWorkspace(newModalCtx.workspaceId, breadcrumbStack.find((c) => c.type === "workspace")?.name || "");
        }
      } else if (newModalMode === "rename") {
        await fetchJSON(`/soundconnect/folders/${newModalCtx.folderId}`, {
          method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
        });
        closeNewModal();
        showFolder(newModalCtx.folderId, name, newModalCtx.parentBreadcrumb);
      }
    } catch (e) { closeNewModal(); }
  });

  function renameFolder(id, currentName, parentBreadcrumb) {
    openNewModal("rename", { folderId: id, title: "Renommer", prefill: currentName, parentBreadcrumb });
  }

  async function deleteFolder(id, parentBreadcrumb) {
    if (!confirm("Supprimer ce dossier et tout son contenu (les titres restent dans le catalogue, seul le classement disparaît) ?")) return;
    try {
      await fetchJSON(`/soundconnect/folders/${id}`, { method: "DELETE" });
      const parent = parentBreadcrumb[parentBreadcrumb.length - 1];
      if (parent.type === "workspace") showWorkspace(parent.id, parent.name);
      else if (parent.type === "folder") showFolder(parent.id, parent.name, parentBreadcrumb.slice(0, -1));
      else showHome();
    } catch (e) {}
  }

  addWorkspaceBtn.addEventListener("click", () => openNewModal("workspace", { title: "Nouvel espace" }));

  // ---------------------------------------------------------------------
  // Modale "Ajouter des titres"
  // ---------------------------------------------------------------------

  function openAddModal(folderId) {
    currentFolderIdForAdd = folderId;
    addModal.classList.remove("hidden");
    addModalSearch.value = "";
    addModalResults.innerHTML = "";
    addModalSearch.focus();
    runAddModalSearch("");
  }
  function closeAddModal() { addModal.classList.add("hidden"); currentFolderIdForAdd = null; }
  addModalClose.addEventListener("click", closeAddModal);
  addModal.addEventListener("click", (e) => { if (e.target === addModal) closeAddModal(); });
  addModalSearch.addEventListener("input", debounce(() => runAddModalSearch(addModalSearch.value), 200));

  async function runAddModalSearch(q) {
    try {
      const res = await fetchJSON(`/soundconnect/tracks?q=${encodeURIComponent(q)}`);
      if (!res.tracks.length) { addModalResults.innerHTML = `<div class="sc-search-empty">Aucun résultat.</div>`; return; }
      addModalResults.innerHTML = res.tracks.slice(0, 60).map((t) => `
        <div class="sc-modal-result" data-track-id="${t.id}">
          <div class="sc-modal-result-text">
            <div class="sc-modal-result-title">${escapeHtml(t.title)}</div>
            <div class="sc-modal-result-artist">${escapeHtml(t.artist)}</div>
          </div>
          <span class="sc-modal-result-add">Ajouter</span>
        </div>
      `).join("");
      addModalResults.querySelectorAll(".sc-modal-result").forEach((el) => {
        el.addEventListener("click", async () => {
          try {
            await fetchJSON(`/soundconnect/folders/${currentFolderIdForAdd}/tracks`, {
              method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trackId: el.dataset.trackId }),
            });
            el.querySelector(".sc-modal-result-add").textContent = "Ajouté ✓";
          } catch (err) {}
        });
      });
    } catch (e) {
      addModalResults.innerHTML = `<div class="sc-search-empty">Erreur.</div>`;
    }
  }

  // ---------------------------------------------------------------------
  // Lecteur
  // ---------------------------------------------------------------------

  function updatePlayingHighlight() {
    const currentId = currentIndex >= 0 && currentQueue[currentIndex] ? currentQueue[currentIndex].id : null;
    document.querySelectorAll(".sc-track-item").forEach((el) => {
      el.classList.toggle("playing", !!currentId && el.dataset.trackId === currentId);
    });
  }

  function playQueue(tracks, index) {
    currentQueue = tracks;
    currentIndex = index;
    const t = tracks[index];
    if (!t) return;
    audioEl.src = t.downloadUrl;
    audioEl.play().catch(() => {});
    playerTitleEl.textContent = t.title;
    playerArtistEl.textContent = t.artist;
    playerArt.textContent = initials(t.title);
    player.classList.remove("hidden");
    updatePlayingHighlight();
  }

  function togglePlayPause() {
    if (!audioEl.src) return;
    if (audioEl.paused) audioEl.play().catch(() => {});
    else audioEl.pause();
  }

  function playRelative(offset) {
    if (!currentQueue.length) return;
    const next = currentIndex + offset;
    if (next < 0 || next >= currentQueue.length) return;
    playQueue(currentQueue, next);
  }

  audioEl.addEventListener("play", () => { playPauseBtn.textContent = "⏸"; });
  audioEl.addEventListener("pause", () => { playPauseBtn.textContent = "▶"; });
  audioEl.addEventListener("timeupdate", () => {
    if (!audioEl.duration) return;
    seekEl.value = String(Math.round((audioEl.currentTime / audioEl.duration) * 1000));
    timeCurrentEl.textContent = formatTime(audioEl.currentTime);
    timeTotalEl.textContent = formatTime(audioEl.duration);
  });
  audioEl.addEventListener("loadedmetadata", () => { timeTotalEl.textContent = formatTime(audioEl.duration); });
  audioEl.addEventListener("ended", () => {
    if (currentIndex + 1 < currentQueue.length) playRelative(1);
    else updatePlayingHighlight();
  });

  seekEl.addEventListener("input", () => {
    if (!audioEl.duration) return;
    audioEl.currentTime = (Number(seekEl.value) / 1000) * audioEl.duration;
  });
  volumeEl.addEventListener("input", () => { audioEl.volume = Number(volumeEl.value) / 100; });
  playPauseBtn.addEventListener("click", togglePlayPause);
  prevBtn.addEventListener("click", () => playRelative(-1));
  nextBtn.addEventListener("click", () => playRelative(1));
  playerCloseBtn.addEventListener("click", () => {
    audioEl.pause();
    audioEl.removeAttribute("src");
    player.classList.add("hidden");
    currentQueue = []; currentIndex = -1;
    updatePlayingHighlight();
  });

  // ---------------------------------------------------------------------
  // Sync PHONO
  // ---------------------------------------------------------------------

  let syncing = false;
  async function runSync() {
    if (syncing) return;
    syncing = true;
    syncBtn.disabled = true;
    syncBtn.textContent = "Synchro… (~1-2 min)";
    syncStatusEl.textContent = "Parcours de PHONO en cours…";
    try {
      const res = await fetchJSON("/soundconnect/sync", { method: "POST" });
      syncStatusEl.textContent = formatSyncedAt(res.syncedAt) + ` · ${res.count} titres`;
      await loadSidebar();
      showHome();
    } catch (e) {
      syncStatusEl.textContent = "Échec de la synchronisation — réessaie dans un instant.";
    } finally {
      syncing = false;
      syncBtn.disabled = false;
      syncBtn.textContent = "Rafraîchir PHONO";
    }
  }
  syncBtn.addEventListener("click", runSync);

  // ---------------------------------------------------------------------
  // Navigation top-niveau
  // ---------------------------------------------------------------------

  navHome.addEventListener("click", showHome);
  navSearch.addEventListener("click", showSearch);

  // ---------------------------------------------------------------------
  // Démarrage
  // ---------------------------------------------------------------------

  (async function init() {
    try {
      const cat = await fetchJSON("/soundconnect/catalog");
      syncStatusEl.textContent = cat.syncedAt ? formatSyncedAt(cat.syncedAt) + ` · ${cat.tracks.length} titres` : "Pas encore synchronisé";
    } catch (e) {}
    await loadSidebar();
    showHome();
  })();
})();
