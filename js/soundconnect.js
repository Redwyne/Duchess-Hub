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
  const waveformEl = document.getElementById("sc-waveform");
  const waveformBgEl = document.getElementById("sc-waveformBg");
  const waveformFgEl = document.getElementById("sc-waveformFg");
  const volumeEl = document.getElementById("sc-volume");
  const volumeIconBtn = document.getElementById("sc-volumeIcon");
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
  const newModalCoverWrap = document.getElementById("sc-newModalCoverWrap");
  const newModalCoverBtn = document.getElementById("sc-newModalCoverBtn");
  const newModalCoverInput = document.getElementById("sc-newModalCoverInput");
  const newModalCoverPreview = document.getElementById("sc-newModalCoverPreview");
  const newModalCoverLabel = document.getElementById("sc-newModalCoverLabel");
  let newModalCoverFile = null;

  const projectTypeModal = document.getElementById("sc-projectTypeModal");
  const projectTypeModalClose = document.getElementById("sc-projectTypeModalClose");

  const pickerModal = document.getElementById("sc-pickerModal");
  const pickerModalTitle = document.getElementById("sc-pickerModalTitle");
  const pickerModalClose = document.getElementById("sc-pickerModalClose");
  const pickerModalSearch = document.getElementById("sc-pickerModalSearch");
  const pickerModalResults = document.getElementById("sc-pickerModalResults");

  const shareModal = document.getElementById("sc-shareModal");
  const shareModalClose = document.getElementById("sc-shareModalClose");
  const shareModalTarget = document.getElementById("sc-shareModalTarget");
  const shareModalLinks = document.getElementById("sc-shareModalLinks");
  const shareModalNewLinkBtn = document.getElementById("sc-shareModalNewLinkBtn");
  const shareModalForm = document.getElementById("sc-shareModalForm");
  const shareModalName = document.getElementById("sc-shareModalName");
  const shareModalStreaming = document.getElementById("sc-shareModalStreaming");
  const shareModalDownload = document.getElementById("sc-shareModalDownload");
  const shareModalTrackInfo = document.getElementById("sc-shareModalTrackInfo");
  const shareModalPwToggle = document.getElementById("sc-shareModalPwToggle");
  const shareModalPassword = document.getElementById("sc-shareModalPassword");
  const shareModalCreateBtn = document.getElementById("sc-shareModalCreateBtn");
  const shareModalFormTitle = document.getElementById("sc-shareModalFormTitle");
  const shareModalCancelEditBtn = document.getElementById("sc-shareModalCancelEditBtn");

  const scGate = document.getElementById("sc-gate");
  const scProtectedArea = document.getElementById("sc-protectedArea");
  const scReopenLoginBtn = document.getElementById("sc-reopen-login");

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
  let allFoldersFlat = []; // tous les dossiers/projets/playlists, tous espaces (arbre sidebar + pickers)
  const expandedTreeIds = new Set(); // ids d'espaces/dossiers dépliés dans l'arbre sidebar
  let pickerOnPick = null;
  let pickerItemsSource = [];
  let scInitialized = false;

  // Cache très court des détails de dossier (utilisé pour le pré-chargement au
  // survol — voir plus bas) : évite de refaire l'aller-retour réseau si
  // l'utilisateur a déjà survolé la tuile juste avant de cliquer. Invalidé à
  // chaque mutation (renommage, déplacement, ajout/retrait de titre...) pour
  // ne jamais afficher de données périmées.
  const folderDetailCache = new Map();
  const FOLDER_CACHE_TTL_MS = 20000;
  function invalidateFolderCache() { folderDetailCache.clear(); }
  async function getFolderDetailCached(id) {
    const hit = folderDetailCache.get(id);
    if (hit && Date.now() - hit.at < FOLDER_CACHE_TTL_MS) return hit.detail;
    const detail = await fetchJSON(`/soundconnect/folders/${id}`);
    folderDetailCache.set(id, { at: Date.now(), detail });
    return detail;
  }

  // NB : on a tenté de "préchauffer" le lien audio temporaire au survol via un
  // second <audio> caché (même URL que la lecture réelle), mais les liens
  // SharePoint temporaires n'aiment visiblement pas être requêtés deux fois —
  // ça a cassé la lecture en prod (plus aucun son ne démarrait). Retiré.
  // Seul le cache de métadonnées ci-dessus (getFolderDetailCached, qui ne
  // touche jamais au fichier audio lui-même) est conservé.

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

  // ---------------------------------------------------------------------
  // Covers (générées côté backend si absentes, uploadables depuis n'importe
  // quelle tuile / en-tête / ligne de titre — même URL stable dans les deux cas).
  // ---------------------------------------------------------------------

  function coverUrl(kind, id) {
    return `${BACKEND_BASE_URL}/soundconnect/covers/${kind}/${encodeURIComponent(id)}`;
  }

  function coverBlockHtml(kind, id, editSize) {
    return `
      <div class="sc-cover-wrap" data-cover-kind="${kind}" data-cover-id="${escapeHtml(id)}">
        <img class="sc-cover-img" src="${coverUrl(kind, id)}" alt="" loading="lazy" />
        <button type="button" class="sc-cover-edit-btn ${editSize || ""}" title="Changer la cover" aria-label="Changer la cover">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
        </button>
      </div>`;
  }

  const coverFileInput = document.createElement("input");
  coverFileInput.type = "file";
  coverFileInput.accept = "image/*";
  coverFileInput.style.display = "none";
  document.body.appendChild(coverFileInput);
  let pendingCoverTarget = null;

  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".sc-cover-edit-btn");
    if (!btn) return;
    e.stopPropagation();
    e.preventDefault();
    const wrap = btn.closest("[data-cover-kind]");
    if (!wrap) return;
    pendingCoverTarget = { kind: wrap.dataset.coverKind, id: wrap.dataset.coverId };
    coverFileInput.value = "";
    coverFileInput.click();
  });

  coverFileInput.addEventListener("change", async () => {
    const file = coverFileInput.files[0];
    const target = pendingCoverTarget;
    pendingCoverTarget = null;
    if (!file || !target) return;
    const fd = new FormData();
    fd.append("file", file);
    try {
      const r = await fetch(coverUrl(target.kind, target.id), { method: "POST", body: fd });
      if (!r.ok) {
        let detail = "";
        try { detail = (await r.json()).detail || ""; } catch (_) { /* ignore */ }
        throw new Error(detail || "upload échoué");
      }
      const data = await r.json();
      const freshUrl = BACKEND_BASE_URL + data.coverUrl;
      document
        .querySelectorAll(`[data-cover-kind="${target.kind}"][data-cover-id="${CSS.escape(target.id)}"] .sc-cover-img`)
        .forEach((img) => { img.src = freshUrl; });
    } catch (e) {
      alert(e.message && e.message !== "upload échoué" ? e.message : "Échec de l'upload de la cover — réessaie dans un instant.");
    }
  });

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
    applyLabelTheme();
    pushScHistory();
  }

  // ---------------------------------------------------------------------
  // Bouton précédent/suivant du navigateur = naviguer dans les dossiers
  // ---------------------------------------------------------------------
  // Chaque vue (Home / Search / Espace / Dossier·Projet) pousse une entrée
  // d'historique contenant tout le breadcrumbStack — pas besoin de rejouer des
  // appels réseau pour reconstruire la vue au popstate, l'état est déjà là.
  // suppressScHistoryPush évite de ré-empiler une entrée quand on est en train
  // de RESTAURER une vue suite à un clic précédent/suivant (sinon chaque
  // retour arrière recréerait une entrée en avant, cassant le bouton retour).
  let suppressScHistoryPush = false;
  function sameScView(a, b) {
    return !!a && !!b && a.type === b.type && a.id === b.id;
  }
  function pushScHistory() {
    if (suppressScHistoryPush) return;
    // Ne jamais empiler tant que l'onglet Sound Connect n'est pas VISIBLE à
    // l'écran (ex. le chargement initial du sidebar/Home tourne en fond dès
    // l'authentification, avant même que l'utilisateur ait cliqué l'onglet) —
    // sinon cette entrée "fantôme" se fait aussitôt écraser par le prochain
    // clic d'onglet (tabs.js fait un replaceState à data-tab non-soundconnect),
    // laissant un trou (state null) qui cassait le tout premier retour arrière.
    if (document.body.getAttribute("data-tab") !== "soundconnect") return;
    const cur = history.state;
    const newLast = breadcrumbStack[breadcrumbStack.length - 1];
    const curLast = cur && cur.scView ? cur.scView[cur.scView.length - 1] : null;
    try {
      if (sameScView(curLast, newLast)) {
        // Même vue qu'avant (ex. réouverture du même dossier) : on remplace
        // plutôt que d'empiler, pour ne pas polluer l'historique de doublons.
        history.replaceState({ scView: breadcrumbStack, tab: "soundconnect" }, "", "#soundconnect");
      } else {
        history.pushState({ scView: breadcrumbStack, tab: "soundconnect" }, "", "#soundconnect");
      }
    } catch (e) {}
  }
  window.addEventListener("popstate", (e) => {
    const state = e.state;
    if (!state || !state.scView) return; // pas une vue Sound Connect : on laisse faire (retour normal du navigateur)
    // Suppression AVANT de cliquer l'onglet : ce clic déclenche aussi le
    // listener plus bas qui appelle pushScHistory() (pour créer l'entrée du
    // tout premier chargement de l'onglet) — sans cette suppression précoce,
    // il empilerait l'ANCIENNE vue (celle d'avant le retour arrière) au lieu
    // de laisser la restauration ci-dessous poser la bonne.
    suppressScHistoryPush = true;
    if (document.body.getAttribute("data-tab") !== "soundconnect") {
      const btn = document.querySelector('.tab-btn[data-tab-target="soundconnect"]');
      if (btn) btn.click(); // active l'onglet — tabs.js fait au passage un replaceState(null, ...)
    }
    const stack = state.scView;
    const last = stack[stack.length - 1];
    if (last.type === "home") showHome();
    else if (last.type === "search") showSearch();
    else if (last.type === "workspace") showWorkspace(last.id, last.name);
    else if (last.type === "folder") showFolder(last.id, last.name, stack.slice(0, -1));
    suppressScHistoryPush = false;
    // tabs.js a pu remettre le state à null en activant l'onglet ci-dessus —
    // on le restaure pour que d'éventuels aller-retours suivants restent cohérents.
    try { history.replaceState({ scView: breadcrumbStack, tab: "soundconnect" }, "", "#soundconnect"); } catch (e) {}
  });

  // Fond + palette d'accent qui suivent l'espace (librairie) actif : ARK et
  // THEORY ont leur propre logo/couleur, DUCHESS (et Home/Search) gardent
  // l'identité Duchess Hub par défaut. Basé sur le slug de l'espace courant
  // (breadcrumbStack contient toujours l'entrée "workspace" une fois qu'on y
  // est entré, y compris dans les dossiers/projets qu'il contient).
  const KNOWN_LABELS = new Set(["ark", "theory"]);
  const BRAND_NAMES = { ark: "ARK", theory: "THEORY" };
  const brandTextEl = document.querySelector(".brand-text");
  function applyLabelTheme() {
    const wsCrumb = breadcrumbStack.find((c) => c.type === "workspace");
    const ws = wsCrumb ? allWorkspaces.find((w) => w.id === wsCrumb.id) : null;
    const slug = ((ws && (ws.slug || ws.name)) || "").toLowerCase();
    const label = KNOWN_LABELS.has(slug) ? slug : null;
    if (label) document.body.setAttribute("data-sc-label", label);
    else document.body.removeAttribute("data-sc-label");
    // Le nom affiché en haut à gauche suit la librairie choisie (persiste même
    // en quittant l'onglet Sound Connect, contrairement au fond/à la palette
    // qui eux ne s'appliquent que dans l'onglet) — reste "DUCHESS" par défaut.
    if (brandTextEl) {
      brandTextEl.innerHTML = `${BRAND_NAMES[label] || "DUCHESS"} <em>· Hub</em>`;
    }
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
  // Petit retour visuel transitoire (succès d'une action drag and drop / menu clic droit)
  // ---------------------------------------------------------------------

  function flashToast(msg) {
    let el = document.getElementById("sc-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "sc-toast";
      el.style.cssText = "position:fixed;bottom:110px;left:50%;transform:translateX(-50%);"
        + "background:var(--panel);border:1px solid var(--border);color:var(--text);padding:10px 16px;"
        + "border-radius:8px;font-size:13px;z-index:90;box-shadow:0 10px 30px -10px rgba(0,0,0,.5);"
        + "opacity:0;transition:opacity .2s ease;pointer-events:none;";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = "1";
    clearTimeout(flashToast._t);
    flashToast._t = setTimeout(() => { el.style.opacity = "0"; }, 1800);
  }

  // ---------------------------------------------------------------------
  // Drag and drop (titres -> projets, projets -> artistes, artistes -> espaces)
  // ---------------------------------------------------------------------
  // On encode le "type" de ce qui est glissé directement dans le type MIME du
  // dataTransfer (ex. "application/x-sc-track") plutôt que dans son contenu : c'est le
  // seul moyen fiable de savoir, pendant un dragover, si l'élément survolé peut accepter
  // ce qui est en train d'être déposé (le contenu, lui, n'est lisible qu'au drop).

  function attachDragSource(el, payload) {
    el.classList.add("sc-draggable");
    el.draggable = true;
    el.addEventListener("dragstart", (e) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData(`application/x-sc-${payload.type}`, JSON.stringify(payload));
      requestAnimationFrame(() => el.classList.add("sc-dragging"));
    });
    el.addEventListener("dragend", () => el.classList.remove("sc-dragging"));
  }

  function attachDropTarget(el, acceptType, onDrop) {
    const mime = `application/x-sc-${acceptType}`;
    el.addEventListener("dragover", (e) => {
      if (!e.dataTransfer.types.includes(mime)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      el.classList.add("sc-drop-target-active");
    });
    el.addEventListener("dragleave", () => el.classList.remove("sc-drop-target-active"));
    el.addEventListener("drop", (e) => {
      if (!e.dataTransfer.types.includes(mime)) return;
      e.preventDefault();
      el.classList.remove("sc-drop-target-active");
      const raw = e.dataTransfer.getData(mime);
      if (!raw) return;
      try { onDrop(JSON.parse(raw)); } catch (err) {}
    });
  }

  // ---------------------------------------------------------------------
  // Menu clic droit générique
  // ---------------------------------------------------------------------

  function closeContextMenu() {
    const el = document.getElementById("sc-ctxMenu");
    if (el) el.remove();
    document.removeEventListener("keydown", onCtxEscClose);
  }
  function onCtxEscClose(e) { if (e.key === "Escape") closeContextMenu(); }

  function showContextMenu(x, y, items) {
    closeContextMenu();
    const el = document.createElement("div");
    el.className = "sc-ctx-menu";
    el.id = "sc-ctxMenu";
    el.innerHTML = items.map((it, i) => it.sep
      ? `<div class="sc-ctx-sep"></div>`
      : `<button type="button" class="sc-ctx-item ${it.danger ? "danger" : ""}" ${it.disabled ? "disabled" : ""} data-idx="${i}">${escapeHtml(it.label)}</button>`
    ).join("");
    document.body.appendChild(el);
    const rect = el.getBoundingClientRect();
    el.style.left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 8)) + "px";
    el.style.top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 8)) + "px";
    el.querySelectorAll("[data-idx]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const it = items[+btn.dataset.idx];
        closeContextMenu();
        if (it.onClick) it.onClick();
      });
    });
    setTimeout(() => {
      document.addEventListener("click", closeContextMenu, { once: true, capture: true });
      document.addEventListener("contextmenu", closeContextMenu, { once: true, capture: true });
      document.addEventListener("keydown", onCtxEscClose);
    }, 0);
  }

  // ---------------------------------------------------------------------
  // Modale générique "choisir un dossier/projet/playlist/espace"
  // ---------------------------------------------------------------------

  function openPicker(title, items, onPick) {
    pickerModalTitle.textContent = title;
    pickerItemsSource = items;
    pickerOnPick = onPick;
    pickerModalSearch.value = "";
    renderPickerResults("");
    pickerModal.classList.remove("hidden");
    pickerModalSearch.focus();
  }
  function closePicker() { pickerModal.classList.add("hidden"); pickerOnPick = null; }
  pickerModalClose.addEventListener("click", closePicker);
  pickerModal.addEventListener("click", (e) => { if (e.target === pickerModal) closePicker(); });
  pickerModalSearch.addEventListener("input", debounce(() => renderPickerResults(pickerModalSearch.value), 150));

  function renderPickerResults(q) {
    const ql = q.trim().toLowerCase();
    const filtered = !ql ? pickerItemsSource : pickerItemsSource.filter((f) =>
      f.name.toLowerCase().includes(ql)
      || (f.parentName || "").toLowerCase().includes(ql)
      || (f.workspaceName || "").toLowerCase().includes(ql)
    );
    if (!filtered.length) { pickerModalResults.innerHTML = `<div class="sc-search-empty">Aucun résultat.</div>`; return; }
    pickerModalResults.innerHTML = filtered.slice(0, 150).map((f, i) => `
      <div class="sc-modal-result" data-idx="${i}">
        <div class="sc-modal-result-text">
          <div class="sc-modal-result-title">${escapeHtml(f.name)}</div>
          <div class="sc-modal-result-artist">${escapeHtml(f.workspaceName || "")}${f.parentName ? " · " + escapeHtml(f.parentName) : ""}</div>
        </div>
        <span class="sc-modal-result-add">Choisir</span>
      </div>
    `).join("");
    pickerModalResults.querySelectorAll("[data-idx]").forEach((el) => {
      el.addEventListener("click", () => {
        const f = filtered[+el.dataset.idx];
        const cb = pickerOnPick;
        closePicker();
        if (cb) cb(f);
      });
    });
  }

  function pickableProjects() { return allFoldersFlat.filter((f) => f.kind === "project" || f.kind === "playlist"); }
  function pickableArtistFolders() { return allFoldersFlat.filter((f) => f.kind === "folder"); }

  // true si candidateId EST ancestorId, ou se trouve à l'intérieur de lui —
  // sert à interdire de déplacer un projet dans lui-même ou dans l'un de ses
  // propres sous-projets (ce qui créerait une boucle sans fin), maintenant que
  // les projets peuvent être imbriqués les uns dans les autres (comme des
  // dossiers dans un Finder).
  function isDescendantOrSelf(candidateId, ancestorId) {
    let cur = findFlatFolder(candidateId);
    while (cur) {
      if (cur.id === ancestorId) return true;
      cur = cur.parentId ? findFlatFolder(cur.parentId) : null;
    }
    return false;
  }

  // Cibles valides pour "Déplacer « projet » vers…" : un artiste, OU un autre
  // projet (imbrication façon Finder) — jamais le projet lui-même ni l'un de
  // ses propres sous-projets.
  function pickableProjectTargets(excludeId) {
    return allFoldersFlat.filter((f) => {
      if (f.kind !== "folder" && f.kind !== "project" && f.kind !== "playlist") return false;
      return !isDescendantOrSelf(f.id, excludeId);
    });
  }

  // ---------------------------------------------------------------------
  // Actions de réorganisation partagées par le drag and drop ET le menu clic droit
  // ---------------------------------------------------------------------

  async function moveFolderToWorkspace(folderId, workspaceId, targetName) {
    try {
      await fetchJSON(`/soundconnect/folders/${folderId}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, parentId: null }),
      });
      flashToast(targetName ? `Déplacé vers « ${targetName} ».` : "Déplacé.");
      await refreshAfterOrgChange();
    } catch (e) { alert("Impossible de déplacer : " + e.message); }
  }

  async function moveProjectToFolder(projectId, folderId, workspaceId, targetName) {
    if (isDescendantOrSelf(folderId, projectId)) {
      flashToast("Impossible : ce projet est déjà à l'intérieur de celui-ci.");
      return;
    }
    try {
      await fetchJSON(`/soundconnect/folders/${projectId}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, parentId: folderId }),
      });
      flashToast(targetName ? `Déplacé vers « ${targetName} ».` : "Déplacé.");
      await refreshAfterOrgChange();
    } catch (e) { alert("Impossible de déplacer : " + e.message); }
  }

  async function addTrackToFolder(trackId, folderId, folderName) {
    try {
      await fetchJSON(`/soundconnect/folders/${folderId}/tracks`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trackId }),
      });
      invalidateFolderCache();
      flashToast(folderName ? `Ajouté à « ${folderName} ».` : "Ajouté.");
    } catch (e) { alert("Impossible d'ajouter : " + e.message); }
  }

  async function moveTrackToFolder(trackId, fromFolderId, toFolderId, toFolderName) {
    try {
      await fetchJSON(`/soundconnect/folders/${fromFolderId}/tracks/${encodeURIComponent(trackId)}`, { method: "DELETE" });
      await fetchJSON(`/soundconnect/folders/${toFolderId}/tracks`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trackId }),
      });
      flashToast(toFolderName ? `Déplacé vers « ${toFolderName} ».` : "Déplacé.");
      refreshCurrentView();
    } catch (e) { alert("Impossible de déplacer : " + e.message); }
  }

  async function quickRenameFolder(id, currentName) {
    const name = prompt("Nouveau nom :", currentName);
    if (!name || !name.trim() || name.trim() === currentName) return;
    try {
      await fetchJSON(`/soundconnect/folders/${id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name.trim() }),
      });
      await refreshAfterOrgChange();
    } catch (e) { alert("Échec du renommage : " + e.message); }
  }

  async function quickDeleteFolder(id) {
    if (!confirm("Supprimer cet élément et tout son contenu (les titres restent dans le catalogue, seul le classement disparaît) ?")) return;
    try {
      await fetchJSON(`/soundconnect/folders/${id}`, { method: "DELETE" });
      await refreshAfterOrgChange();
    } catch (e) { alert("Échec de la suppression : " + e.message); }
  }

  function downloadTrack(t) {
    window.open(`${BACKEND_BASE_URL}/soundconnect/tracks/${encodeURIComponent(t.id)}/download`, "_blank");
  }

  async function removeTrackFromFolder(t, folderId) {
    try {
      await fetchJSON(`/soundconnect/folders/${folderId}/tracks/${encodeURIComponent(t.id)}`, { method: "DELETE" });
      invalidateFolderCache();
      refreshCurrentView();
    } catch (err) {}
  }

  function triggerNewVersionUpload(t) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "audio/*,.wav,.aiff,.aif,.flac,.mp3";
    input.style.display = "none";
    document.body.appendChild(input);
    input.addEventListener("change", async () => {
      const file = input.files[0];
      input.remove();
      if (!file) return;
      if (!confirm(`Uploader « ${file.name} » comme nouvelle version de « ${t.title} » dans PHONO ?\n\nLe fichier sera ajouté à côté des versions existantes (numéro de mix incrémenté), jamais à leur place.`)) return;
      flashToast("Upload de la nouvelle version en cours…");
      const fd = new FormData();
      fd.append("file", file);
      try {
        const r = await fetch(`${BACKEND_BASE_URL}/soundconnect/tracks/${encodeURIComponent(t.id)}/new-version`, { method: "POST", body: fd });
        if (!r.ok) { let detail = r.statusText; try { detail = (await r.json()).detail || detail; } catch (e) {} throw new Error(detail); }
        const data = await r.json();
        flashToast(`Nouvelle version envoyée : ${data.track.filename}`);
        refreshCurrentView();
      } catch (e) {
        alert("Échec de l'upload de la nouvelle version : " + e.message);
      }
    });
    input.click();
  }

  function openPickerForAddTrack(t) {
    openPicker(`Ajouter « ${t.title} » à…`, pickableProjects(), (target) => addTrackToFolder(t.id, target.id, target.name));
  }

  function openPickerForMoveTrack(t, currentFolderId) {
    openPicker(`Déplacer « ${t.title} » vers…`, pickableProjects().filter((f) => f.id !== currentFolderId), (target) => moveTrackToFolder(t.id, currentFolderId, target.id, target.name));
  }

  function openPickerForMoveFolderToWorkspace(id, name) {
    const items = allWorkspaces.filter((w) => true).map((w) => ({ id: w.id, name: w.name, workspaceName: "Espace", parentName: null }));
    openPicker(`Déplacer « ${name} » vers…`, items, (target) => moveFolderToWorkspace(id, target.id, target.name));
  }

  function openPickerForMoveProjectToFolder(id, name) {
    openPicker(`Déplacer « ${name} » vers…`, pickableProjectTargets(id), (target) => moveProjectToFolder(id, target.id, target.workspaceId, target.name));
  }

  // ---------------------------------------------------------------------
  // Sidebar / arbre Library (espace -> artiste -> projet/playlist)
  // ---------------------------------------------------------------------

  function findFlatFolder(id) { return allFoldersFlat.find((f) => f.id === id); }

  function breadcrumbAncestorsFor(folderId) {
    const chain = [];
    let cur = findFlatFolder(folderId);
    while (cur) { chain.unshift(cur); cur = cur.parentId ? findFlatFolder(cur.parentId) : null; }
    const ws = chain.length ? allWorkspaces.find((w) => w.id === chain[0].workspaceId) : null;
    const stack = [{ type: "home", name: "Home" }];
    if (ws) stack.push({ type: "workspace", id: ws.id, name: ws.name });
    chain.forEach((f, i) => { if (i < chain.length - 1) stack.push({ type: "folder", id: f.id, name: f.name }); });
    return stack;
  }

  function openFromTree(folderId) {
    const f = findFlatFolder(folderId);
    if (!f) return;
    showFolder(folderId, f.name, breadcrumbAncestorsFor(folderId));
  }

  function refreshCurrentView() {
    invalidateFolderCache();
    const last = breadcrumbStack[breadcrumbStack.length - 1];
    if (!last || last.type === "home") showHome();
    else if (last.type === "search") showSearch();
    else if (last.type === "workspace") showWorkspace(last.id, last.name);
    else if (last.type === "folder") showFolder(last.id, last.name, breadcrumbStack.slice(0, -1));
  }

  async function refreshAfterOrgChange() {
    await loadSidebar();
    refreshCurrentView();
  }

  function groupFoldersByParent(folders) {
    const map = new Map();
    for (const f of folders) {
      const key = `${f.workspaceId}::${f.parentId || "root"}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(f);
    }
    return map;
  }

  function renderTreeChildren(workspaceId, parentId, grouped, depth) {
    const items = (grouped.get(`${workspaceId}::${parentId || "root"}`) || []).slice().sort((a, b) => a.name.localeCompare(b.name));
    return items.map((f) => renderTreeNode(f, grouped, depth)).join("");
  }

  function renderTreeNode(f, grouped, depth) {
    const hasChildren = grouped.has(`${f.workspaceId}::${f.id}`);
    const expanded = expandedTreeIds.has(f.id);
    const treeKind = f.kind === "folder" ? "folder" : "project";
    return `
      <div class="sc-tree-row" data-tree-kind="${treeKind}" data-id="${f.id}" data-workspace-id="${f.workspaceId}" data-name="${escapeHtml(f.name)}" style="padding-left:${depth * 10}px;">
        ${hasChildren ? `<button type="button" class="sc-tree-toggle ${expanded ? "expanded" : ""}" data-toggle-id="${f.id}">▸</button>` : `<span class="sc-tree-toggle spacer">▸</span>`}
        <button type="button" class="sc-tree-item-btn" data-open-id="${f.id}" data-open-kind="${f.kind}"><span class="sc-tree-dot"></span>${escapeHtml(f.name)}</button>
      </div>
      ${hasChildren && expanded ? `<div class="sc-tree-children" data-children-for="${f.id}">${renderTreeChildren(f.workspaceId, f.id, grouped, depth + 1)}</div>` : ""}
    `;
  }

  function renderTreeWorkspace(ws, grouped) {
    const hasChildren = grouped.has(`${ws.id}::root`);
    const expanded = expandedTreeIds.has(ws.id);
    return `
      <div class="sc-tree-row sc-workspace-row" data-tree-kind="workspace" data-id="${ws.id}" data-name="${escapeHtml(ws.name)}">
        ${hasChildren ? `<button type="button" class="sc-tree-toggle ${expanded ? "expanded" : ""}" data-toggle-id="${ws.id}">▸</button>` : `<span class="sc-tree-toggle spacer">▸</span>`}
        <button type="button" class="sc-workspace-item" data-open-id="${ws.id}" data-open-kind="workspace">
          <span class="sc-workspace-icon"><img src="${coverUrl("workspace", ws.id)}" alt="" loading="lazy" /></span>
          <span>${escapeHtml(ws.name)}</span>
        </button>
      </div>
      ${hasChildren && expanded ? `<div class="sc-tree-children" data-children-for="${ws.id}">${renderTreeChildren(ws.id, null, grouped, 1)}</div>` : ""}
    `;
  }

  function renderSidebarTree() {
    const grouped = groupFoldersByParent(allFoldersFlat);
    workspaceListEl.innerHTML = allWorkspaces.map((ws) => renderTreeWorkspace(ws, grouped)).join("");

    workspaceListEl.querySelectorAll("[data-toggle-id]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.dataset.toggleId;
        if (expandedTreeIds.has(id)) expandedTreeIds.delete(id); else expandedTreeIds.add(id);
        renderSidebarTree();
      });
    });
    workspaceListEl.querySelectorAll("[data-open-id]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const row = btn.closest("[data-tree-kind]");
        if (btn.dataset.openKind === "workspace") showWorkspace(btn.dataset.openId, row.dataset.name);
        else openFromTree(btn.dataset.openId);
      });
    });
    workspaceListEl.querySelectorAll('.sc-tree-row[data-tree-kind="workspace"]').forEach((row) => {
      attachDropTarget(row, "folder", (payload) => moveFolderToWorkspace(payload.id, row.dataset.id, row.dataset.name));
    });
    workspaceListEl.querySelectorAll('.sc-tree-row[data-tree-kind="folder"]').forEach((row) => {
      attachDropTarget(row, "project", (payload) => moveProjectToFolder(payload.id, row.dataset.id, row.dataset.workspaceId, row.dataset.name));
    });
    workspaceListEl.querySelectorAll('.sc-tree-row[data-tree-kind="project"]').forEach((row) => {
      attachDropTarget(row, "track", (payload) => addTrackToFolder(payload.id, row.dataset.id, row.dataset.name));
      // Un projet glissé sur un autre projet s'imbrique dedans (comme un
      // dossier dans un dossier sur Finder) — moveProjectToFolder refuse déjà
      // toute boucle (drop sur soi-même ou sur l'un de ses propres sous-projets).
      attachDropTarget(row, "project", (payload) => moveProjectToFolder(payload.id, row.dataset.id, row.dataset.workspaceId, row.dataset.name));
    });
  }

  async function loadSidebar() {
    try {
      const [wsRes, foldersRes] = await Promise.all([
        fetchJSON("/soundconnect/workspaces"),
        fetchJSON("/soundconnect/folders"),
      ]);
      allWorkspaces = wsRes.workspaces;
      allFoldersFlat = foldersRes.folders;
      renderSidebarTree();
    } catch (e) {
      workspaceListEl.innerHTML = `<div class="sc-empty-sub">Erreur de chargement</div>`;
    }
  }

  // ---------------------------------------------------------------------
  // Tuiles
  // ---------------------------------------------------------------------

  function tileHtml({ id, name, kind, coverKind, meta, showPlay }) {
    return `
      <div class="sc-tile" data-id="${id}" data-name="${escapeHtml(name)}" data-kind="${kind}">
        <div class="sc-tile-cover">
          ${coverBlockHtml(coverKind, id)}
          ${showPlay ? `<button type="button" class="sc-tile-play" data-play-id="${id}" aria-label="Lire">▶</button>` : ""}
        </div>
        <div class="sc-tile-name">${escapeHtml(name)}</div>
        <div class="sc-tile-meta">${meta || ""}</div>
      </div>`;
  }

  function renderTileGrid(folders, { onTileClick, container, emptyTitle, emptySub }) {
    const target = container || contentEl;
    if (!folders.length) {
      target.innerHTML = emptyStateHtml(emptyTitle || "Rien ici pour l'instant.", emptySub || "Utilise les boutons en haut à droite pour créer un dossier ou un projet.");
      return;
    }
    target.innerHTML = `<div class="sc-tile-grid">${folders.map((f) => {
      const typeLabel = f.projectType && PROJECT_TYPE_LABELS[f.projectType] ? PROJECT_TYPE_LABELS[f.projectType] + " · " : "";
      const meta = f.childCount
        ? `${f.childCount} élément${f.childCount > 1 ? "s" : ""}`
        : `${typeLabel}${f.trackCount} titre${f.trackCount > 1 ? "s" : ""}`;
      return tileHtml({ id: f.id, name: f.name, kind: f.kind, coverKind: "folder", meta, showPlay: f.trackCount > 0 && f.childCount === 0 });
    }).join("")}</div>`;
    target.querySelectorAll(".sc-tile").forEach((el) => {
      el.addEventListener("click", (e) => {
        if (e.target.closest(".sc-tile-play") || e.target.closest(".sc-cover-edit-btn")) return;
        onTileClick(el.dataset.id, el.dataset.name);
      });
      // Pré-charge le détail du dossier dès le survol — par le temps que le
      // clic arrive, l'aller-retour réseau est déjà fait (métadonnées
      // seulement, jamais le fichier audio lui-même).
      el.addEventListener("mouseenter", () => {
        getFolderDetailCached(el.dataset.id).catch(() => {});
      });
    });
    target.querySelectorAll(".sc-tile-play").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        try {
          const detail = await getFolderDetailCached(btn.dataset.playId);
          if (detail.tracks.length) playQueue(detail.tracks, 0);
        } catch (err) {}
      });
    });
    // Drag and drop : un dossier artiste se glisse dans un espace (sidebar), un
    // projet/playlist se glisse dans un dossier artiste OU dans un autre projet
    // (sidebar, ou directement tuile sur tuile ici) — voir attachDropTarget.
    // Clic droit = équivalent accessible sans glisser-déposer.
    target.querySelectorAll('.sc-tile[data-kind="folder"]').forEach((el) => {
      attachDragSource(el, { type: "folder", id: el.dataset.id });
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, [
          { label: "Déplacer vers un autre espace…", onClick: () => openPickerForMoveFolderToWorkspace(el.dataset.id, el.dataset.name) },
          { label: "Renommer…", onClick: () => quickRenameFolder(el.dataset.id, el.dataset.name) },
          { sep: true },
          { label: "Supprimer", danger: true, onClick: () => quickDeleteFolder(el.dataset.id) },
        ]);
      });
    });
    target.querySelectorAll('.sc-tile[data-kind="project"], .sc-tile[data-kind="playlist"]').forEach((el) => {
      attachDragSource(el, { type: "project", id: el.dataset.id });
      // Un projet déposé directement sur une autre tuile-projet du même écran
      // s'imbrique dedans — exactement comme glisser un dossier sur un autre
      // dossier dans le Finder, sans avoir besoin de passer par la sidebar.
      attachDropTarget(el, "project", (payload) => {
        const targetFolder = findFlatFolder(el.dataset.id);
        moveProjectToFolder(payload.id, el.dataset.id, targetFolder ? targetFolder.workspaceId : undefined, el.dataset.name);
      });
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, [
          { label: "Déplacer vers…", onClick: () => openPickerForMoveProjectToFolder(el.dataset.id, el.dataset.name) },
          { label: "Renommer…", onClick: () => quickRenameFolder(el.dataset.id, el.dataset.name) },
          { label: "Partager…", onClick: () => openShareModal("project", el.dataset.id, el.dataset.name) },
          { sep: true },
          { label: "Supprimer", danger: true, onClick: () => quickDeleteFolder(el.dataset.id) },
        ]);
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
        id: ws.id, name: ws.name, kind: "workspace", coverKind: "workspace",
        meta: `${ws.folderCount} dossier${ws.folderCount > 1 ? "s" : ""}`,
      })).join("")}</div>`;
      contentEl.querySelectorAll(".sc-tile").forEach((el) => {
        el.addEventListener("click", (e) => {
          if (e.target.closest(".sc-cover-edit-btn")) return;
          showWorkspace(el.dataset.id, el.dataset.name);
        });
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
      <button type="button" class="sc-btn" id="sc-newPlaylistTop">+ Nouveau projet</button>
    `);
    document.getElementById("sc-newFolderTop").addEventListener("click", () => openNewModal("folder", { workspaceId: id, parentId: null, title: "Nouveau dossier" }));
    document.getElementById("sc-newPlaylistTop").addEventListener("click", () => openProjectTypeModal({ workspaceId: id, parentId: null }));
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
      detail = await getFolderDetailCached(id);
    } catch (e) {
      contentEl.innerHTML = emptyStateHtml("Dossier introuvable.");
      return;
    }
    const workspaceId = detail.folder.workspaceId;
    const isArtist = detail.folder.kind === "folder";
    if (isArtist && detail.children.length > 0) {
      // Dossier artiste : ses enfants sont des projets, jamais de titres directs.
      setTopbarActions(`
        <button type="button" class="sc-btn" id="sc-newFolderTop">+ Nouveau dossier</button>
        <button type="button" class="sc-btn" id="sc-newPlaylistTop">+ Nouveau projet</button>
        <button type="button" class="sc-btn" id="sc-deleteFolderTop" title="Supprimer ce dossier">🗑</button>
      `);
      document.getElementById("sc-newFolderTop").addEventListener("click", () => openNewModal("folder", { workspaceId, parentId: id, title: "Nouveau dossier" }));
      document.getElementById("sc-newPlaylistTop").addEventListener("click", () => openProjectTypeModal({ workspaceId, parentId: id }));
      document.getElementById("sc-deleteFolderTop").addEventListener("click", () => deleteFolder(id, parentBreadcrumb));
      renderTileGrid(detail.children, { onTileClick: (fid, fname) => showFolder(fid, fname, breadcrumbStack) });
    } else if (isArtist) {
      setTopbarActions(`
        <button type="button" class="sc-btn" id="sc-renameTop">Renommer</button>
        <button type="button" class="sc-btn" id="sc-deleteFolderTop" title="Supprimer">🗑 Supprimer</button>
      `);
      document.getElementById("sc-renameTop").addEventListener("click", () => renameFolder(id, name, parentBreadcrumb));
      document.getElementById("sc-deleteFolderTop").addEventListener("click", () => deleteFolder(id, parentBreadcrumb));
      renderProjectDetail(detail);
    } else {
      // Projet/playlist : peut contenir à la fois des sous-projets imbriqués
      // (glissés dedans, façon Finder) ET ses propres titres — les deux sont
      // affichés ensemble, jamais l'un au détriment de l'autre.
      setTopbarActions(`
        <button type="button" class="sc-btn" id="sc-renameTop">Renommer</button>
        <button type="button" class="sc-btn" id="sc-newPlaylistTop">+ Nouveau projet</button>
        <button type="button" class="sc-btn" id="sc-shareTop">Partager</button>
        <button type="button" class="sc-btn" id="sc-deleteFolderTop" title="Supprimer">🗑 Supprimer</button>
      `);
      document.getElementById("sc-renameTop").addEventListener("click", () => renameFolder(id, name, parentBreadcrumb));
      document.getElementById("sc-newPlaylistTop").addEventListener("click", () => openProjectTypeModal({ workspaceId, parentId: id }));
      document.getElementById("sc-shareTop").addEventListener("click", () => openShareModal("project", id, name));
      document.getElementById("sc-deleteFolderTop").addEventListener("click", () => deleteFolder(id, parentBreadcrumb));
      renderProjectMixed(detail, breadcrumbStack);
    }
  }

  function folderKindLabel(f) {
    if (f.kind === "playlist") return "Playlist";
    if (f.projectType && PROJECT_TYPE_LABELS[f.projectType]) return PROJECT_TYPE_LABELS[f.projectType];
    return "Projet";
  }

  function renderProjectDetail(detail) {
    const f = detail.folder;
    const tracks = detail.tracks;
    contentEl.innerHTML = `
      <div class="sc-detail-head">
        <div class="sc-detail-cover">${coverBlockHtml("folder", f.id)}</div>
        <div class="sc-detail-info">
          <h2>${escapeHtml(f.name)}</h2>
          <div class="sc-detail-meta">${folderKindLabel(f)} · ${tracks.length} titre${tracks.length > 1 ? "s" : ""}</div>
        </div>
      </div>
      <button type="button" class="sc-add-tracks-btn" id="sc-addTracksBtn">+ Ajouter des titres</button>
      <div class="sc-track-list" id="sc-projectTracks"></div>
    `;
    document.getElementById("sc-addTracksBtn").addEventListener("click", () => openAddModal(f.id));
    renderTrackList(document.getElementById("sc-projectTracks"), tracks, { removable: true, folderId: f.id });
  }

  // Comme renderProjectDetail, mais pour un projet qui peut aussi contenir des
  // sous-projets imbriqués (glissés dedans) — affiche les deux à la fois :
  // la grille des sous-projets en haut (si présents), les titres en dessous.
  function renderProjectMixed(detail, breadcrumbForChildren) {
    const f = detail.folder;
    const children = detail.children || [];
    const tracks = detail.tracks || [];
    const metaParts = [folderKindLabel(f)];
    if (children.length) metaParts.push(`${children.length} sous-projet${children.length > 1 ? "s" : ""}`);
    metaParts.push(`${tracks.length} titre${tracks.length > 1 ? "s" : ""}`);
    contentEl.innerHTML = `
      <div class="sc-detail-head">
        <div class="sc-detail-cover">${coverBlockHtml("folder", f.id)}</div>
        <div class="sc-detail-info">
          <h2>${escapeHtml(f.name)}</h2>
          <div class="sc-detail-meta">${metaParts.join(" · ")}</div>
        </div>
      </div>
      ${children.length ? `<div class="sc-subsection-label">Sous-projets</div><div id="sc-projectChildren"></div>` : ""}
      <div class="sc-subsection-label">Titres</div>
      <button type="button" class="sc-add-tracks-btn" id="sc-addTracksBtn">+ Ajouter des titres</button>
      <div class="sc-track-list" id="sc-projectTracks"></div>
    `;
    if (children.length) {
      renderTileGrid(children, {
        container: document.getElementById("sc-projectChildren"),
        onTileClick: (fid, fname) => showFolder(fid, fname, breadcrumbForChildren),
      });
    }
    document.getElementById("sc-addTracksBtn").addEventListener("click", () => openAddModal(f.id));
    renderTrackList(document.getElementById("sc-projectTracks"), tracks, { removable: true, folderId: f.id });
  }

  const DRAG_HANDLE_SVG = `<svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" aria-hidden="true">
    <circle cx="2.5" cy="2.5" r="1.4"></circle><circle cx="7.5" cy="2.5" r="1.4"></circle>
    <circle cx="2.5" cy="8" r="1.4"></circle><circle cx="7.5" cy="8" r="1.4"></circle>
    <circle cx="2.5" cy="13.5" r="1.4"></circle><circle cx="7.5" cy="13.5" r="1.4"></circle>
  </svg>`;

  // Icônes d'action de la liste de titres (téléchargement / partage / infos /
  // plus d'options) — remplacent l'ancien lien SharePoint (↗) et la taille en
  // Mo, jugés peu utiles à l'affichage par Michel. Partage et infos sont des
  // emplacements réservés pour l'instant (pas encore de fonctionnalité derrière).
  const TRACK_ICON_DOWNLOAD = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`;
  const TRACK_ICON_SHARE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line></svg>`;
  const TRACK_ICON_INFO = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`;
  const TRACK_ICON_MORE = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"></circle><circle cx="12" cy="12" r="2"></circle><circle cx="19" cy="12" r="2"></circle></svg>`;
  const SHARE_ICON_COPY = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
  const SHARE_ICON_EDIT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>`;
  const SHARE_ICON_TRASH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"></path></svg>`;

  // Liste d'actions partagée entre le clic droit ET le bouton "..." de chaque
  // ligne — une seule source de vérité pour ne jamais désynchroniser les deux.
  function trackMenuItems(t, { removable, folderId }) {
    const items = [{ label: "Ajouter au projet…", onClick: () => openPickerForAddTrack(t) }];
    if (removable && folderId) items.push({ label: "Déplacer vers…", onClick: () => openPickerForMoveTrack(t, folderId) });
    items.push({ sep: true });
    items.push({ label: "Télécharger (WAV)", onClick: () => downloadTrack(t) });
    items.push({ label: "Partager…", onClick: () => openShareModal("track", t.id, `${t.title} — ${t.artist}`) });
    items.push({ label: "Nouvelle version…", onClick: () => triggerNewVersionUpload(t) });
    if (removable && folderId) {
      items.push({ sep: true });
      items.push({ label: "Retirer de ce projet", onClick: () => removeTrackFromFolder(t, folderId) });
    }
    return items;
  }

  // Réordonnancement des titres d'un projet, par glisser-déposer à partir de la
  // poignée à 6 points — l'ordre vit dans folderTracks côté backend (aucune
  // incidence sur PHONO). Optimiste côté UI : on réordonne localement tout de
  // suite, l'appel réseau part en arrière-plan ; en cas d'échec on revient à
  // l'état serveur via refreshCurrentView().
  async function reorderTracksInFolder(folderId, orderedTrackIds) {
    try {
      await fetchJSON(`/soundconnect/folders/${folderId}/tracks/reorder`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trackIds: orderedTrackIds }),
      });
      invalidateFolderCache();
    } catch (e) {
      flashToast("Impossible de réordonner : " + (e.message || ""));
      refreshCurrentView();
    }
  }

  function renderTrackList(container, tracks, { removable, folderId }) {
    if (!tracks.length) {
      container.innerHTML = `<div class="sc-empty-sub" style="padding:20px 0;">Aucun titre ici pour l'instant.</div>`;
      return;
    }
    const reorderable = !!(removable && folderId);
    container.innerHTML = tracks.map((t, i) => `
      <div class="sc-track-item" data-track-id="${t.id}">
        ${reorderable ? `<span class="sc-track-drag-handle" draggable="true" title="Glisser pour réordonner" aria-label="Réordonner">${DRAG_HANDLE_SVG}</span>` : `<span class="sc-track-drag-handle-spacer"></span>`}
        <div class="sc-track-index">${i + 1}</div>
        <button type="button" class="sc-track-playbtn" data-idx="${i}" aria-label="Lecture/Pause">
          <span class="sc-track-playbtn-icon">▶</span>
          <span class="sc-track-eq" aria-hidden="true"><i></i><i></i><i></i></span>
        </button>
        <div class="sc-track-cover">${coverBlockHtml("track", t.id, "sc-cover-edit-btn--sm")}</div>
        <div class="sc-track-title-cell">
          <div class="sc-track-name">${escapeHtml(t.title)} ${badgeFor(t)}</div>
          <div class="sc-track-sub">${escapeHtml(t.artist)}</div>
        </div>
        <button type="button" class="sc-track-action sc-track-action-download" data-idx="${i}" title="Télécharger" aria-label="Télécharger">${TRACK_ICON_DOWNLOAD}</button>
        <button type="button" class="sc-track-action sc-track-action-share" title="Partager" aria-label="Partager">${TRACK_ICON_SHARE}</button>
        <button type="button" class="sc-track-action sc-track-action-info" title="Infos du titre" aria-label="Infos du titre">${TRACK_ICON_INFO}</button>
        <button type="button" class="sc-track-action sc-track-action-more" data-idx="${i}" title="Plus d'options" aria-label="Plus d'options">${TRACK_ICON_MORE}</button>
      </div>
    `).join("");
    // Un seul listener, posé sur la LIGNE (pas aussi sur .sc-track-playbtn) :
    // le bouton est un descendant de la ligne, un clic dessus déclenche déjà le
    // listener de la ligne par bubbling. Les deux étaient posés avant, ce qui
    // exécutait ce code DEUX FOIS pour un même clic sur le bouton (une fois
    // pour le bouton, une fois pour la ligne) — la 1re lançait la lecture, la
    // 2e la retrouvait "déjà en cours" et la remettait aussitôt en pause via
    // togglePlayPause(), d'où le titre qui ne démarrait qu'après un appui sur
    // espace juste après.
    container.querySelectorAll(".sc-track-item").forEach((el) => {
      el.addEventListener("click", (e) => {
        if (e.target.closest(".sc-track-action") || e.target.closest(".sc-cover-edit-btn") || e.target.closest(".sc-track-drag-handle")) return;
        const item = e.currentTarget.closest(".sc-track-item") || e.currentTarget;
        const idx = [...container.querySelectorAll(".sc-track-item")].indexOf(item);
        if (idx < 0) return;
        const t = tracks[idx];
        // Reclique sur le titre déjà chargé (celui avec l'icône ▶/égaliseur
        // synchronisée) = pause/reprise en place, comme l'espace ou le bouton
        // du lecteur — jamais un redémarrage depuis 0 (même bug que corrigé
        // précédemment pour la barre d'espace, ici côté clic sur la liste).
        const isCurrent = currentIndex >= 0 && currentQueue[currentIndex] && currentQueue[currentIndex].id === t.id;
        if (isCurrent) togglePlayPause();
        else playQueue(tracks, idx);
      });
    });
    // Icônes d'action à droite de chaque ligne : téléchargement direct, deux
    // emplacements réservés (partage / infos du titre — pas encore branchés,
    // demandés par Michel pour plus tard), et "..." qui ouvre le même menu que
    // le clic droit (voir trackMenuItems ci-dessous, partagé entre les deux
    // pour ne jamais avoir deux listes d'actions différentes selon l'entrée).
    container.querySelectorAll(".sc-track-action-download").forEach((btn) => {
      btn.addEventListener("click", (e) => { e.stopPropagation(); downloadTrack(tracks[+btn.dataset.idx]); });
    });
    container.querySelectorAll(".sc-track-action-share").forEach((btn, i) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const t = tracks[i];
        openShareModal("track", t.id, `${t.title} — ${t.artist}`);
      });
    });
    container.querySelectorAll(".sc-track-action-info").forEach((btn) => {
      btn.addEventListener("click", (e) => { e.stopPropagation(); }); // pas encore implémenté
    });
    container.querySelectorAll(".sc-track-action-more").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const t = tracks[+btn.dataset.idx];
        const rect = btn.getBoundingClientRect();
        showContextMenu(rect.right, rect.bottom + 4, trackMenuItems(t, { removable, folderId }));
      });
    });
    // Drag and drop : un titre se glisse dans un projet/playlist de l'arbre sidebar
    // (ajout, jamais retrait automatique de la vue courante). Clic droit = mêmes
    // actions accessibles sans glisser-déposer, plus téléchargement et nouvelle version.
    container.querySelectorAll(".sc-track-item").forEach((el, i) => {
      const t = tracks[i];
      attachDragSource(el, { type: "track", id: t.id });
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, trackMenuItems(t, { removable, folderId }));
      });
    });

    if (reorderable) {
      const rows = [...container.querySelectorAll(".sc-track-item")];
      let dragFromIndex = -1;

      const clearIndicators = () => rows.forEach((r) => r.classList.remove("sc-reorder-over-above", "sc-reorder-over-below"));

      container.querySelectorAll(".sc-track-drag-handle").forEach((handle, i) => {
        const row = rows[i];
        handle.addEventListener("dragstart", (e) => {
          dragFromIndex = i;
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("application/x-sc-track-reorder", String(i));
          // On veut voir la ligne entière suivre le curseur, pas juste la petite poignée.
          e.dataTransfer.setDragImage(row, 16, row.offsetHeight / 2);
          requestAnimationFrame(() => row.classList.add("sc-dragging"));
        });
        handle.addEventListener("dragend", () => {
          row.classList.remove("sc-dragging");
          clearIndicators();
          dragFromIndex = -1;
        });
      });

      rows.forEach((row, i) => {
        row.addEventListener("dragover", (e) => {
          if (!e.dataTransfer.types.includes("application/x-sc-track-reorder")) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          const rect = row.getBoundingClientRect();
          const above = e.clientY - rect.top < rect.height / 2;
          clearIndicators();
          row.classList.add(above ? "sc-reorder-over-above" : "sc-reorder-over-below");
        });
        row.addEventListener("dragleave", (e) => {
          if (!row.contains(e.relatedTarget)) row.classList.remove("sc-reorder-over-above", "sc-reorder-over-below");
        });
        row.addEventListener("drop", (e) => {
          if (!e.dataTransfer.types.includes("application/x-sc-track-reorder")) return;
          e.preventDefault();
          clearIndicators();
          const from = dragFromIndex;
          if (from < 0 || from === i) return;
          const rect = row.getBoundingClientRect();
          const above = e.clientY - rect.top < rect.height / 2;
          let to = above ? i : i + 1;
          if (to > from) to -= 1; // le retrait de l'élément source décale les index suivants
          if (to === from) return;
          const reordered = tracks.slice();
          const [moved] = reordered.splice(from, 1);
          reordered.splice(to, 0, moved);
          renderTrackList(container, reordered, { removable, folderId });
          reorderTracksInFolder(folderId, reordered.map((tr) => tr.id));
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

  const PROJECT_TYPE_LABELS = { single: "Single", ep: "EP", album: "Album" };

  function resetNewModalCover() {
    newModalCoverFile = null;
    newModalCoverInput.value = "";
    newModalCoverBtn.classList.remove("has-file");
    newModalCoverLabel.textContent = "Choisir une cover (obligatoire)";
    newModalCoverPreview.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><path d="M21 15l-5-5L5 21"></path></svg>`;
  }

  function openNewModal(mode, ctx) {
    newModalMode = mode;
    newModalCtx = ctx;
    newModalTitle.textContent = ctx.title || "Nouveau";
    newModalName.value = ctx.prefill || "";
    resetNewModalCover();
    newModalCoverWrap.classList.toggle("hidden", mode !== "project");
    newModal.classList.remove("hidden");
    newModalName.focus();
  }
  function closeNewModal() { newModal.classList.add("hidden"); }

  newModalCoverBtn.addEventListener("click", () => newModalCoverInput.click());
  newModalCoverInput.addEventListener("change", () => {
    const file = newModalCoverInput.files[0];
    if (!file) return;
    newModalCoverFile = file;
    newModalCoverBtn.classList.add("has-file");
    newModalCoverLabel.textContent = file.name;
    const reader = new FileReader();
    reader.onload = () => { newModalCoverPreview.innerHTML = `<img src="${reader.result}" alt="" />`; };
    reader.readAsDataURL(file);
  });

  newModalClose.addEventListener("click", closeNewModal);
  newModal.addEventListener("click", (e) => { if (e.target === newModal) closeNewModal(); });

  // "+ Nouveau projet" : étape 1 (choisir Single / EP / Album) avant de nommer.
  // Le type n'est qu'une métadonnée d'affichage — même dossier "carré" ensuite,
  // dans lequel on peut mettre des titres comme n'importe quel autre projet.
  let pendingProjectCtx = null;
  function openProjectTypeModal(ctx) {
    pendingProjectCtx = ctx;
    projectTypeModal.classList.remove("hidden");
  }
  function closeProjectTypeModal() { projectTypeModal.classList.add("hidden"); pendingProjectCtx = null; }
  projectTypeModalClose.addEventListener("click", closeProjectTypeModal);
  projectTypeModal.addEventListener("click", (e) => { if (e.target === projectTypeModal) closeProjectTypeModal(); });
  projectTypeModal.querySelectorAll("[data-project-type]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const type = btn.dataset.projectType;
      const ctx = pendingProjectCtx || {};
      closeProjectTypeModal();
      openNewModal("project", {
        workspaceId: ctx.workspaceId, parentId: ctx.parentId, projectType: type,
        title: `Nouveau projet — ${PROJECT_TYPE_LABELS[type]}`, prefill: PROJECT_TYPE_LABELS[type],
      });
    });
  });

  newModalConfirm.addEventListener("click", async () => {
    const name = newModalName.value.trim();
    if (!name) return;
    if (newModalMode === "project" && !newModalCoverFile) {
      alert("Choisis une cover pour le projet avant de le créer.");
      return;
    }
    try {
      invalidateFolderCache();
      if (newModalMode === "workspace") {
        await fetchJSON("/soundconnect/workspaces", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
        closeNewModal();
        await loadSidebar();
        showHome();
      } else if (newModalMode === "folder" || newModalMode === "project") {
        const created = await fetchJSON("/soundconnect/folders", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId: newModalCtx.workspaceId, parentId: newModalCtx.parentId, name,
            kind: newModalMode, projectType: newModalMode === "project" ? newModalCtx.projectType : null,
          }),
        });
        if (newModalMode === "project" && newModalCoverFile) {
          try {
            const fd = new FormData();
            fd.append("file", newModalCoverFile);
            const r = await fetch(coverUrl("folder", created.id), { method: "POST", body: fd });
            if (!r.ok) {
              let detail = "";
              try { detail = (await r.json()).detail || ""; } catch (_) { /* ignore */ }
              throw new Error(detail || "Échec de l'upload de la cover.");
            }
          } catch (coverErr) {
            // On ne laisse jamais un projet sans cover : on annule sa création.
            try { await fetchJSON(`/soundconnect/folders/${created.id}`, { method: "DELETE" }); } catch (_) { /* ignore */ }
            invalidateFolderCache();
            alert(`${coverErr.message} Le projet n'a pas été créé — réessaie.`);
            return;
          }
        }
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
      invalidateFolderCache();
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
            invalidateFolderCache();
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
    // "playing" = ce titre est celui chargé (en pause ou en lecture) — état déjà
    // existant. "playing-audio" = le son est RÉELLEMENT en train de jouer (pas en
    // pause) — pilote l'icône ▶ vs le petit égaliseur animé (voir sc-track-eq
    // dans le gabarit + CSS), synchronisée sur le vrai état de audioEl (source de
    // vérité), jamais l'inverse.
    const audioPlaying = !!currentId && !audioEl.paused;
    document.querySelectorAll(".sc-track-item").forEach((el) => {
      const isCurrent = !!currentId && el.dataset.trackId === currentId;
      el.classList.toggle("playing", isCurrent);
      el.classList.toggle("playing-audio", isCurrent && audioPlaying);
    });
  }

  // Waveform : d'abord une silhouette générée instantanément (retour visuel
  // immédiat + filet de sécurité), puis remplacée par la VRAIE forme d'onde
  // décodée depuis le fichier audio (Web Audio API) dès qu'elle est prête.
  // Requête d'analyse séparée du <audio> de lecture — si elle échoue (CORS,
  // format, etc.) on garde simplement la silhouette générée, la lecture
  // elle-même n'est jamais affectée.
  function barsMarkup(values) {
    return values.map((v) => `<span class="sc-wave-bar" style="height:${Math.max(6, Math.round(v * 100))}%"></span>`).join("");
  }

  function generateFakePeaks(seedStr, count) {
    let seed = 0;
    for (let i = 0; i < seedStr.length; i++) seed = (seed * 31 + seedStr.charCodeAt(i)) >>> 0;
    function rand() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967295; }
    const raw = [];
    for (let i = 0; i < count; i++) raw.push(0.15 + rand() * 0.85);
    return raw.map((v, i) => {
      const prev = raw[i - 1] !== undefined ? raw[i - 1] : v;
      const next = raw[i + 1] !== undefined ? raw[i + 1] : v;
      return (prev + v * 2 + next) / 4;
    });
  }

  async function computeRealPeaks(url, count) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    const res = await fetch(url);
    if (!res.ok) throw new Error("waveform fetch failed");
    const buf = await res.arrayBuffer();
    const ctx = new AC();
    try {
      const audioBuffer = await ctx.decodeAudioData(buf);
      const data = audioBuffer.getChannelData(0);
      const bucketSize = Math.max(1, Math.floor(data.length / count));
      // RMS (énergie moyenne) par tranche plutôt que le simple pic (max) : sur
      // un titre mastérisé moderne, le pic de quasiment CHAQUE tranche frôle
      // déjà le maximum (loudness normalisée) — un seul sample fort suffit à
      // saturer toute une tranche à 100%. Résultat mesuré sur un vrai titre du
      // catalogue : 82% des tranches au-dessus de 80% de hauteur en pic, contre
      // 46% en RMS. Ça donnait une silhouette dense, quasi plate, qui "effaçait"
      // la belle silhouette générée affichée le temps du chargement (voir
      // generateFakePeaks) dès que l'analyse réelle arrivait ~1s plus tard — vu
      // par Michel comme la silhouette qui "revient dans sa forme d'avant". Le
      // RMS reflète le volume perçu sur la tranche et fait ressortir les vrais
      // écarts calme/fort (intro, couplet/refrain...), bien plus dynamique.
      const energies = [];
      for (let i = 0; i < count; i++) {
        const start = i * bucketSize;
        const end = Math.min(data.length, start + bucketSize);
        let sumSq = 0;
        for (let j = start; j < end; j++) { const v = data[j]; sumSq += v * v; }
        energies.push(Math.sqrt(sumSq / Math.max(1, end - start)));
      }
      // Normalise sur la tranche la plus "forte" de la piste pour occuper
      // toute la hauteur disponible même si le morceau n'est jamais mixé à fond.
      const globalMax = Math.max(0.001, ...energies);
      return energies.map((v) => v / globalMax);
    } finally {
      ctx.close();
    }
  }

  // Résolution FIXE utilisée pour l'analyse et le cache — indépendante de la
  // largeur d'écran (qui ne sert qu'à choisir combien de barres AFFICHER, via
  // resamplePeaks juste en dessous). Une silhouette calculée une fois reste
  // valable pour tout le monde, quelle que soit la taille de sa fenêtre.
  const WAVEFORM_CACHE_RESOLUTION = 240;

  // Rééchantillonne un tableau de pics vers un nombre cible de barres, par
  // plus proche voisin — largement suffisant pour une silhouette visuelle,
  // pas besoin d'interpolation fine.
  function resamplePeaks(peaks, targetCount) {
    if (!peaks.length || targetCount === peaks.length) return peaks;
    const out = new Array(targetCount);
    for (let i = 0; i < targetCount; i++) {
      out[i] = peaks[Math.min(peaks.length - 1, Math.floor((i * peaks.length) / targetCount))];
    }
    return out;
  }

  // Cache mémoire (dure tant que l'onglet reste ouvert) par-dessus le cache
  // serveur persistant (voir /soundconnect/tracks/{id}/waveform, backend/main.py)
  // — demande de Michel après avoir remarqué que la silhouette "réinitialisait"
  // sa forme quelques secondes après le début de la lecture (le temps que le
  // fetch + décodage du fichier entier se termine) : plutôt que de refaire ce
  // calcul coûteux à CHAQUE lecture, on l'analyse une seule fois puis on la
  // garde — pour cette session immédiatement, et pour toutes les prochaines
  // lectures (par n'importe qui) une fois sauvegardée côté serveur.
  const waveformMemoryCache = new Map();

  async function fetchCachedWaveform(trackId) {
    if (waveformMemoryCache.has(trackId)) return waveformMemoryCache.get(trackId);
    try {
      const res = await fetchJSON(`/soundconnect/tracks/${encodeURIComponent(trackId)}/waveform`);
      if (res && Array.isArray(res.peaks) && res.peaks.length) {
        waveformMemoryCache.set(trackId, res.peaks);
        return res.peaks;
      }
    } catch (e) {} // pas encore analysé (404) ou backend indisponible — silhouette générée le temps de l'analyser
    return null;
  }

  function saveWaveformToCache(trackId, peaks) {
    waveformMemoryCache.set(trackId, peaks);
    // Best-effort : si la sauvegarde échoue, seule cette session garde le
    // bénéfice du cache (perdu au rechargement) — jamais bloquant pour la lecture.
    fetchJSON(`/soundconnect/tracks/${encodeURIComponent(trackId)}/waveform`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ peaks }),
    }).catch(() => {});
  }

  let waveformToken = 0;
  function renderWaveform(track) {
    const myToken = ++waveformToken;
    const BAR_PITCH = 3; // largeur + espace visés par barre — barres calées exactement sur la largeur réelle du conteneur, jamais de vide résiduel sur le côté.
    const count = Math.max(30, Math.floor((waveformEl.clientWidth || 480) / BAR_PITCH));

    function paint(peaks) {
      const html = barsMarkup(resamplePeaks(peaks, count));
      waveformBgEl.innerHTML = html;
      waveformFgEl.innerHTML = html;
    }

    waveformEl.style.setProperty("--progress", "0%");

    const cached = waveformMemoryCache.get(track.id);
    if (cached) { paint(cached); return; } // déjà connue : correcte dès la 1re image, jamais de "reset" visible

    // Silhouette générée immédiatement, le temps de vérifier le cache serveur
    // ou (à défaut) d'analyser le fichier — filet de sécurité, jamais un blanc.
    paint(generateFakePeaks(String(track.id || track.title || "x"), WAVEFORM_CACHE_RESOLUTION));

    fetchCachedWaveform(track.id).then((cachedPeaks) => {
      if (myToken !== waveformToken) return; // piste changée entretemps, on ignore le résultat
      if (cachedPeaks) { paint(cachedPeaks); return; } // déjà calculée avant (par cette session ou une autre)
      if (!track.downloadUrl) return;
      computeRealPeaks(track.downloadUrl, WAVEFORM_CACHE_RESOLUTION)
        .then((peaks) => {
          if (!peaks || myToken !== waveformToken) return;
          paint(peaks);
          saveWaveformToCache(track.id, peaks);
        })
        .catch(() => {}); // échec d'analyse (CORS, format...) : silhouette générée conservée telle quelle
    });
  }

  // Icône + piste remplie : synchronise l'affichage sur audioEl.volume (source
  // de vérité), jamais l'inverse — la logique audio elle-même ne change pas.
  let volumeBeforeMute = 1;
  function updateVolumeUI() {
    const vol = audioEl.volume;
    volumeEl.style.setProperty("--pct", Math.round(vol * 100));
    const level = vol === 0 ? "muted" : vol < 0.5 ? "low" : "high";
    const icons = {
      muted: '<path d="M16 9l-6 6M10 9l6 6"></path><polygon points="4 8 8 8 12 4 12 20 8 16 4 16 4 8"></polygon>',
      low: '<polygon points="4 8 8 8 12 4 12 20 8 16 4 16 4 8"></polygon><path d="M15.5 8.5a5 5 0 0 1 0 7"></path>',
      high: '<polygon points="4 8 8 8 12 4 12 20 8 16 4 16 4 8"></polygon><path d="M15.5 8.5a5 5 0 0 1 0 7"></path><path d="M18.5 6a9 9 0 0 1 0 12"></path>',
    };
    volumeIconBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icons[level]}</svg>`;
    volumeIconBtn.title = level === "muted" ? "Rétablir le son" : "Couper le son";
    volumeIconBtn.setAttribute("aria-label", volumeIconBtn.title);
  }

  // Le lien SharePoint mis en cache (t.downloadUrl, rempli au dernier
  // "Rafraîchir PHONO") expire au bout d'environ 1h (token temporaire) — passé
  // ce délai il renvoie 401 et le son ne démarre plus du tout. On tente d'abord
  // ce lien en cache (rapide, marche la plupart du temps), et si le navigateur
  // signale une erreur de chargement sur LE TITRE EN COURS, on retente une
  // seule fois via /soundconnect/tracks/{id}/download, qui va rechercher un
  // lien frais côté serveur avant de rediriger dessus (même mécanisme que le
  // bouton Télécharger, qui lui n'a jamais eu ce problème).
  let triedFreshForCurrent = false;

  function freshDownloadUrl(trackId) {
    return `${BACKEND_BASE_URL}/soundconnect/tracks/${encodeURIComponent(trackId)}/download`;
  }

  // ---------------------------------------------------------------------
  // Pré-chargement du titre SUIVANT dans une file de lecture (projet) — pour
  // un démarrage quasi instantané au clic "suivant"/à la fin naturelle du
  // titre courant. Différent de la tentative précédente (retirée plus haut
  // dans ce fichier, voir le commentaire à ce sujet) : ici on télécharge le
  // fichier entier dans un Blob totalement séparé de la lecture en cours —
  // jamais un second <audio> pointant sur la même URL que celle réellement
  // lue, donc aucune interférence possible avec la lecture active. Le Blob
  // n'est utilisé comme source réelle qu'une fois prêt ET seulement au
  // moment de jouer CE titre ; s'il n'est pas prêt à temps (connexion lente),
  // on retombe simplement sur le chemin normal (lien direct/frais), sans
  // jamais bloquer ni casser la lecture.
  const preloadCache = new Map(); // trackId -> { blobUrl: string|null }
  const preloadOrder = []; // limite la mémoire vive utilisée (WAV/FLAC entiers)

  function schedulePreload(trackId) {
    if (!trackId || preloadCache.has(trackId)) return;
    const entry = { blobUrl: null };
    preloadCache.set(trackId, entry);
    preloadOrder.push(trackId);
    while (preloadOrder.length > 2) {
      const oldId = preloadOrder.shift();
      const old = preloadCache.get(oldId);
      if (old && old.blobUrl) URL.revokeObjectURL(old.blobUrl);
      preloadCache.delete(oldId);
    }
    fetch(freshDownloadUrl(trackId))
      .then((r) => (r.ok ? r.blob() : Promise.reject()))
      .then((blob) => {
        if (!preloadCache.has(trackId)) return; // évincé entre-temps (file très rapide)
        entry.blobUrl = URL.createObjectURL(blob);
      })
      .catch(() => {}); // échec silencieux : le titre se chargera normalement le moment venu
  }

  function consumePreload(trackId) {
    const entry = preloadCache.get(trackId);
    return entry && entry.blobUrl ? entry.blobUrl : null;
  }

  function loadAndPlay(t, { forceFresh } = {}) {
    const preloaded = !forceFresh ? consumePreload(t.id) : null;
    audioEl.src = preloaded || (forceFresh ? freshDownloadUrl(t.id) : (t.downloadUrl || freshDownloadUrl(t.id)));
    audioEl.play().catch(() => {});
  }

  audioEl.addEventListener("error", () => {
    const t = currentQueue[currentIndex];
    if (!t || triedFreshForCurrent) return;
    triedFreshForCurrent = true;
    loadAndPlay(t, { forceFresh: true });
  });

  function playQueue(tracks, index) {
    currentQueue = tracks;
    currentIndex = index;
    const t = tracks[index];
    if (!t) return;
    triedFreshForCurrent = false;
    loadAndPlay(t);
    playerTitleEl.textContent = t.title;
    playerArtistEl.textContent = t.artist;
    playerArt.innerHTML = `<img src="${coverUrl("track", t.id)}" alt="" />`;
    renderWaveform(t);
    player.classList.remove("hidden");
    updatePlayingHighlight();
    const next = tracks[index + 1];
    if (next) schedulePreload(next.id);
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

  audioEl.addEventListener("play", () => { playPauseBtn.textContent = "⏸"; updatePlayingHighlight(); });
  audioEl.addEventListener("pause", () => { playPauseBtn.textContent = "▶"; updatePlayingHighlight(); });
  audioEl.addEventListener("timeupdate", () => {
    if (!audioEl.duration) return;
    const pct = (audioEl.currentTime / audioEl.duration) * 100;
    seekEl.value = String(Math.round(pct * 10));
    waveformEl.style.setProperty("--progress", pct + "%");
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
    waveformEl.style.setProperty("--progress", (Number(seekEl.value) / 10) + "%");
  });
  volumeEl.addEventListener("input", () => {
    audioEl.volume = Number(volumeEl.value) / 100;
    if (audioEl.volume > 0) volumeBeforeMute = audioEl.volume;
    updateVolumeUI();
  });
  volumeIconBtn.addEventListener("click", () => {
    if (audioEl.volume > 0) {
      volumeBeforeMute = audioEl.volume;
      audioEl.volume = 0;
    } else {
      audioEl.volume = volumeBeforeMute || 1;
    }
    volumeEl.value = String(Math.round(audioEl.volume * 100));
    updateVolumeUI();
  });
  updateVolumeUI();
  playPauseBtn.addEventListener("click", togglePlayPause);
  prevBtn.addEventListener("click", () => playRelative(-1));
  nextBtn.addEventListener("click", () => playRelative(1));

  // Barre d'espace = pause/lecture, comme sur Spotify/YouTube. Sans ce
  // handler global, la touche espace se contentait de re-cliquer l'élément
  // qui avait le focus (ex. le bouton ▶ d'un titre tout juste lancé), ce qui
  // rappelait playQueue() et relançait le titre depuis le début au lieu de le
  // mettre en pause. On intercepte donc l'espace au niveau du document et on
  // empêche son comportement par défaut (clic simulé + scroll de page), sauf
  // si l'utilisateur est en train d'écrire dans un champ (recherche, modales).
  document.addEventListener("keydown", (e) => {
    if (e.code !== "Space" && e.key !== " ") return;
    if (!root.classList.contains("active")) return; // onglet Sound Connect pas actif
    if (player.classList.contains("hidden")) return; // pas de lecteur actif
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select" || e.target.isContentEditable) return;
    e.preventDefault();
    togglePlayPause();
  });
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

  async function initSoundConnect() {
    try {
      const cat = await fetchJSON("/soundconnect/catalog");
      syncStatusEl.textContent = cat.syncedAt ? formatSyncedAt(cat.syncedAt) + ` · ${cat.tracks.length} titres` : "Pas encore synchronisé";
    } catch (e) {}
    await loadSidebar();
    showHome();
  }

  // ---------------------------------------------------------------------
  // Partage externe — lien public vers un titre ou un projet.
  //
  // Les routes /soundconnect/shares/* sont, elles, protégées côté backend
  // (Depends(require_admin) — contrairement au reste de l'API Sound Connect)
  // : on doit donc systématiquement attacher le jeton admin, contrairement à
  // fetchJSON() utilisé partout ailleurs dans ce fichier. Piège déjà rencontré
  // et corrigé une fois sur js/budget.js : construire l'objet headers fusionné
  // À PART, puis le spread EN DERNIER dans les options du fetch, jamais
  // Object.assign({headers:...}, options) qui écraserait silencieusement notre
  // Authorization dès que l'appelant passe son propre Content-Type.
  // ---------------------------------------------------------------------

  function shareAuthHeaders(extra) {
    const token = window.DuchessAuth && window.DuchessAuth.getToken ? window.DuchessAuth.getToken() : null;
    return Object.assign({}, extra || {}, token ? { Authorization: `Bearer ${token}` } : {});
  }
  // Contrairement au reste de Sound Connect, ces routes vérifient VRAIMENT le
  // jeton côté serveur (Depends(require_admin)) — c'est le premier endroit de
  // cet onglet où un jeton expiré (20 min, voir js/admin.js) peut réellement
  // se voir renvoyer un 401, alors que jusque-là scIsAuthed() ne faisait
  // qu'un contrôle côté client (présence du jeton, jamais son expiration).
  // Même traitement que callAdmin() dans js/admin.js : sur 401, on renvoie
  // proprement vers l'écran de connexion plutôt que de laisser un simple
  // toast d'erreur sans issue.
  async function fetchShareJSON(path, options) {
    const opts = options || {};
    const headers = shareAuthHeaders(opts.headers);
    const r = await fetch(BACKEND_BASE_URL + path, Object.assign({}, opts, { headers }));
    if (r.status === 401) {
      closeShareModal();
      if (window.DuchessAuth) window.DuchessAuth.requestLogin("soundconnect");
      const err = new Error("Session expirée — reconnecte-toi, puis rouvre le partage.");
      err.isAuthExpired = true;
      throw err;
    }
    if (!r.ok) {
      let detail = r.statusText;
      try { detail = (await r.json()).detail || detail; } catch (e) {}
      throw new Error(detail);
    }
    return r.json();
  }

  let shareModalCtx = null; // { targetType, targetId, displayName }
  let shareModalEditingId = null; // id du lien en cours d'édition, sinon null (= création)

  function shareModalResetForm() {
    shareModalEditingId = null;
    shareModalName.value = "";
    shareModalStreaming.checked = true;
    shareModalDownload.checked = false;
    shareModalTrackInfo.checked = true;
    shareModalPwToggle.checked = false;
    shareModalPassword.value = "";
    shareModalPassword.classList.add("hidden");
    shareModalPassword.placeholder = "Mot de passe…";
    shareModalFormTitle.textContent = "Nouveau lien";
    shareModalCreateBtn.textContent = "Créer le lien";
    shareModalForm.classList.add("hidden");
  }

  function shareModalOpenFormForCreate() {
    shareModalResetForm();
    shareModalForm.classList.remove("hidden");
    shareModalName.focus();
  }

  function shareModalOpenFormForEdit(share) {
    shareModalEditingId = share.id;
    shareModalName.value = share.name || "";
    shareModalStreaming.checked = !!share.permissions.streaming;
    shareModalDownload.checked = !!share.permissions.downloadHQ;
    shareModalTrackInfo.checked = !!share.permissions.trackInfo;
    shareModalPwToggle.checked = !!share.hasPassword;
    shareModalPassword.value = "";
    shareModalPassword.placeholder = share.hasPassword ? "Laisser vide pour ne pas changer" : "Mot de passe…";
    shareModalPassword.classList.toggle("hidden", !share.hasPassword);
    shareModalFormTitle.textContent = "Modifier le lien";
    shareModalCreateBtn.textContent = "Enregistrer";
    shareModalForm.classList.remove("hidden");
    shareModalName.focus();
  }

  function shareLinkRowHtml(share) {
    const label = share.name || (shareModalCtx && shareModalCtx.displayName) || "Lien sans nom";
    return `
      <div class="sc-share-link-row ${share.enabled ? "" : "sc-share-link-disabled"}" data-id="${share.id}">
        <div class="sc-share-link-info">
          <div class="sc-share-link-name">${escapeHtml(label)}${share.hasPassword ? " 🔒" : ""}</div>
          <div class="sc-share-link-url">${escapeHtml(share.url)}</div>
        </div>
        <button type="button" class="sc-share-link-icon-btn sc-share-link-copy" title="Copier le lien" aria-label="Copier le lien">${SHARE_ICON_COPY}</button>
        <button type="button" class="sc-share-link-icon-btn sc-share-link-edit" title="Modifier" aria-label="Modifier">${SHARE_ICON_EDIT}</button>
        <label class="sc-toggle sc-toggle-sm" title="${share.enabled ? "Désactiver" : "Activer"}">
          <input type="checkbox" class="sc-share-link-enable" ${share.enabled ? "checked" : ""} />
          <span></span>
        </label>
        <button type="button" class="sc-share-link-icon-btn sc-share-link-delete" title="Supprimer" aria-label="Supprimer">${SHARE_ICON_TRASH}</button>
      </div>`;
  }

  async function shareModalLoadLinks() {
    if (!shareModalCtx) return;
    shareModalLinks.innerHTML = `<div class="sc-empty-sub">Chargement…</div>`;
    try {
      const res = await fetchShareJSON(`/soundconnect/shares?targetType=${shareModalCtx.targetType}&targetId=${encodeURIComponent(shareModalCtx.targetId)}`);
      shareModalRenderLinks(res.shares);
    } catch (e) {
      shareModalLinks.innerHTML = `<div class="sc-empty-sub">Erreur de chargement des liens.</div>`;
    }
  }

  function shareModalRenderLinks(shares) {
    if (!shares.length) {
      shareModalLinks.innerHTML = `<div class="sc-empty-sub">Aucun lien pour l'instant.</div>`;
      return;
    }
    shareModalLinks.innerHTML = shares.map(shareLinkRowHtml).join("");
    shareModalLinks.querySelectorAll(".sc-share-link-copy").forEach((btn) => {
      btn.addEventListener("click", () => {
        const row = btn.closest(".sc-share-link-row");
        const share = shares.find((s) => s.id === row.dataset.id);
        if (!share) return;
        navigator.clipboard?.writeText(share.url).then(
          () => flashToast("Lien copié dans le presse-papiers."),
          () => flashToast("Impossible de copier le lien.")
        );
      });
    });
    shareModalLinks.querySelectorAll(".sc-share-link-edit").forEach((btn) => {
      btn.addEventListener("click", () => {
        const row = btn.closest(".sc-share-link-row");
        const share = shares.find((s) => s.id === row.dataset.id);
        if (share) shareModalOpenFormForEdit(share);
      });
    });
    shareModalLinks.querySelectorAll(".sc-share-link-enable").forEach((input) => {
      input.addEventListener("change", async () => {
        const row = input.closest(".sc-share-link-row");
        try {
          await fetchShareJSON(`/soundconnect/shares/${row.dataset.id}`, {
            method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: input.checked }),
          });
          row.classList.toggle("sc-share-link-disabled", !input.checked);
        } catch (e) {
          flashToast("Impossible de mettre à jour le lien : " + (e.message || ""));
          input.checked = !input.checked;
        }
      });
    });
    shareModalLinks.querySelectorAll(".sc-share-link-delete").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const row = btn.closest(".sc-share-link-row");
        if (!confirm("Supprimer ce lien de partage ? Il cessera de fonctionner immédiatement.")) return;
        try {
          await fetchShareJSON(`/soundconnect/shares/${row.dataset.id}`, { method: "DELETE" });
          shareModalLoadLinks();
          flashToast("Lien supprimé.");
        } catch (e) {
          flashToast("Impossible de supprimer : " + (e.message || ""));
        }
      });
    });
  }

  function openShareModal(targetType, targetId, displayName) {
    shareModalCtx = { targetType, targetId, displayName };
    shareModalTarget.textContent = displayName;
    shareModalResetForm();
    shareModal.classList.remove("hidden");
    shareModalLoadLinks();
  }
  function closeShareModal() {
    shareModal.classList.add("hidden");
    shareModalCtx = null;
  }
  if (shareModalClose) shareModalClose.addEventListener("click", closeShareModal);
  if (shareModal) shareModal.addEventListener("click", (e) => { if (e.target === shareModal) closeShareModal(); });
  if (shareModalNewLinkBtn) shareModalNewLinkBtn.addEventListener("click", shareModalOpenFormForCreate);
  if (shareModalCancelEditBtn) shareModalCancelEditBtn.addEventListener("click", shareModalResetForm);
  if (shareModalPwToggle) {
    shareModalPwToggle.addEventListener("change", () => {
      shareModalPassword.classList.toggle("hidden", !shareModalPwToggle.checked);
      if (shareModalPwToggle.checked) shareModalPassword.focus();
    });
  }
  if (shareModalCreateBtn) {
    shareModalCreateBtn.addEventListener("click", async () => {
      if (!shareModalCtx) return;
      const permissions = {
        streaming: shareModalStreaming.checked,
        downloadHQ: shareModalDownload.checked,
        trackInfo: shareModalTrackInfo.checked,
      };
      shareModalCreateBtn.disabled = true;
      try {
        if (shareModalEditingId) {
          const body = { name: shareModalName.value.trim() || null, permissions };
          if (!shareModalPwToggle.checked) body.clearPassword = true;
          else if (shareModalPassword.value) body.password = shareModalPassword.value;
          await fetchShareJSON(`/soundconnect/shares/${shareModalEditingId}`, {
            method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
          });
          flashToast("Lien mis à jour.");
        } else {
          const body = {
            targetType: shareModalCtx.targetType, targetId: shareModalCtx.targetId,
            name: shareModalName.value.trim() || null, permissions,
          };
          if (shareModalPwToggle.checked && shareModalPassword.value) body.password = shareModalPassword.value;
          await fetchShareJSON("/soundconnect/shares", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
          });
          flashToast("Lien de partage créé.");
        }
        shareModalResetForm();
        shareModalLoadLinks();
      } catch (e) {
        flashToast("Impossible d'enregistrer le lien : " + (e.message || ""));
      } finally {
        shareModalCreateBtn.disabled = false;
      }
    });
  }

  // ---------------------------------------------------------------------
  // Verrou d'accès — même session que l'onglet Admin (voir window.DuchessAuth
  // exposé par js/admin.js). C'est un verrou d'affichage : les endpoints
  // /soundconnect/* restent des routes publiques côté backend comme avant,
  // exactement comme le bouton "🔒 Admin" n'est lui-même qu'une porte d'entrée
  // — la vraie protection des données Admin, elle, vient du jeton vérifié par
  // le backend à chaque appel /admin/*.
  // ---------------------------------------------------------------------
  function scIsAuthed() {
    return !!(window.DuchessAuth && window.DuchessAuth.isAuthed());
  }
  function applyScLock() {
    if (!scGate || !scProtectedArea) return;
    if (scIsAuthed()) {
      scGate.style.display = "none";
      scProtectedArea.classList.remove("hidden");
      if (!scInitialized) {
        scInitialized = true;
        initSoundConnect();
      }
    } else {
      scGate.style.display = "";
      scProtectedArea.classList.add("hidden");
    }
  }
  if (scReopenLoginBtn) {
    scReopenLoginBtn.addEventListener("click", () => {
      if (window.DuchessAuth) window.DuchessAuth.requestLogin("soundconnect");
    });
  }
  // Même comportement que l'onglet Admin : cliquer sur l'onglet quand on n'est
  // pas connecté ouvre directement le login, sans étape intermédiaire.
  const scTabBtn = document.querySelector('.tab-btn[data-tab-target="soundconnect"]');
  if (scTabBtn) {
    scTabBtn.addEventListener("click", () => {
      if (!scIsAuthed() && window.DuchessAuth) window.DuchessAuth.requestLogin("soundconnect");
      // Crée (ou rafraîchit) l'entrée d'historique de la vue courante pile au
      // moment où l'onglet devient réellement visible — tabs.js vient de
      // faire un replaceState(null, ...) juste avant (même clic, listener
      // enregistré plus tôt), donc pushScHistory() référence maintenant bien
      // data-tab="soundconnect" et peut poser une entrée saine.
      else pushScHistory();
    });
  }
  if (window.DuchessAuth) window.DuchessAuth.onChange(applyScLock);
  applyScLock();
})();
