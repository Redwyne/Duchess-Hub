(function () {
  "use strict";

  /* =====================================================================
     DUCHESS HUB — Onglet Admin (Inventaire synchronisé avec OneDrive)
     =====================================================================

     Aucun identifiant ni secret ici : le login et les URLs des webhooks Make
     sont gérés côté backend (backend/main.py, déployé sur Render), qui lit
     ADMIN_USERS / ADMIN_AUTH_SECRET / MAKE_INVENTAIRE_*_URL depuis les
     variables d'environnement Render. Ce fichier ne fait que parler à ce
     backend avec le jeton reçu après connexion.
     ===================================================================== */
  const BACKEND_BASE_URL = "https://duchess-hub.onrender.com";

  const AUTH_KEY = "duchess-hub-admin-token";

  /* Métadonnées des feuillets (nom de la table Excel + en-têtes de colonnes).
     Volontairement SANS les données de l'inventaire : on ne veut pas qu'une
     copie complète de la base (noms, n° de série, affectations...) se
     retrouve en clair dans le JS livré au navigateur, authentifié ou non.
     Les vraies données ne sont chargées qu'après connexion, en direct
     depuis OneDrive via Make. */
  const SHEET_META = {"Audio":{"table":"T_Audio","header":["Catégorie","Nom","Marque","Code Article","Prix d'achat (€)","Date d'achat","Fin de garantie","Numéro de série","Nombre","État","Fournisseur","Affectation","Lieu","Commentaire"]},"Vidéo":{"table":"T_Vid_o","header":["Catégorie","Nom","Marque","Code Article","Prix d'achat (€)","Date d'achat","Fin de garantie","Numéro de série","Nombre","État","Fournisseur","Affectation","Lieu","Commentaire"]},"IT Hardware":{"table":"T_IT_Hardware","header":["Catégorie","Nom","Marque","Modèle","Code Article","Prix Neuf (€)","Date d'achat","Fin de garantie","Numéro de série","Nombre","État","Fournisseur","Affectation","Lieu","Commentaire"]},"IT Software":{"table":"T_IT_Software","header":["Catégorie","Nom","Marque","Code Article","Prix (€)","Date d'achat","Nombre","État","Fournisseur","Affectation","Commentaire","Date renouvellement","Login","Mot de passe","Email de rattachement"]},"Maintenance - Entretien":{"table":"T_Maintenance___Entretien","header":["Catégorie","Nom","Marque","Code Article","Prix d'achat (€)","Date d'achat","Fin de garantie","Numéro de série","Nombre","État","Fournisseur","Affectation","Lieu","Commentaire"]}};

  const SHEET_ORDER = ["Audio", "Vidéo", "IT Hardware", "IT Software", "Maintenance - Entretien"];
  const SHEET_ICONS = { "Audio": "🎚️", "Vidéo": "🎥", "IT Hardware": "💻", "IT Software": "🧩", "Maintenance - Entretien": "🧰" };

  let STATE = {};
  let currentSheet = SHEET_ORDER[0];
  let editingContext = null;
  let lastNonAdminTab = "pitch";

  /* ---------------------------- DOM refs ---------------------------- */
  const overlay = document.getElementById("admin-login-overlay");
  const dashboard = document.getElementById("admin-dashboard");
  const gate = document.getElementById("admin-gate");
  const adminTabBtn = document.querySelector('.tab-btn[data-tab-target="admin"]');
  const allTabBtns = document.querySelectorAll(".tab-btn");

  // Le jeton est signé et vérifié côté serveur à chaque appel admin (voir
  // backend/main.py) — ce isAuthed() côté client n'est qu'un raccourci pour
  // l'affichage (afficher direct le dashboard ou repasser par le login), pas
  // le vrai contrôle d'accès. Si le jeton a expiré, le backend renverra 401
  // et callAdmin() renverra automatiquement vers l'écran de connexion.
  function getToken() {
    return sessionStorage.getItem(AUTH_KEY) || "";
  }
  function isAuthed() {
    return !!getToken();
  }
  function setAuthed(token) {
    sessionStorage.setItem(AUTH_KEY, token);
  }
  function clearAuthed() {
    sessionStorage.removeItem(AUTH_KEY);
  }

  function showLogin() {
    document.getElementById("admin-login-error").textContent = "";
    document.getElementById("admin-login-form").reset();
    overlay.classList.remove("hidden");
    document.getElementById("admin-login-email").focus();
  }
  function hideLogin() { overlay.classList.add("hidden"); }

  function enterDashboard() {
    hideLogin();
    gate.style.display = "none";
    dashboard.classList.add("active");
    initSheetTabs();
    loadSheet(currentSheet);
    const fab = document.getElementById("admin-add-row-fab");
    if (fab) fab.classList.remove("hidden");
  }

  function leaveToGate() {
    dashboard.classList.remove("active");
    gate.style.display = "";
    const fab = document.getElementById("admin-add-row-fab");
    if (fab) fab.classList.add("hidden");
  }

  /* Remember which tab we came from, so Cancel / not-logged-in returns there
     instead of leaving an empty admin panel behind. */
  allTabBtns.forEach((btn) => {
    if (btn.dataset.tabTarget !== "admin") {
      btn.addEventListener("click", () => { lastNonAdminTab = btn.dataset.tabTarget; });
    }
  });

  if (adminTabBtn) {
    adminTabBtn.addEventListener("click", () => {
      if (isAuthed()) { enterDashboard(); }
      else { leaveToGate(); showLogin(); }
    });
  }

  const reopenBtn = document.getElementById("admin-reopen-login");
  if (reopenBtn) reopenBtn.addEventListener("click", () => showLogin());

  document.getElementById("admin-cancel-login").addEventListener("click", () => {
    hideLogin();
    if (!isAuthed()) {
      const back = document.querySelector('.tab-btn[data-tab-target="' + lastNonAdminTab + '"]') ||
                   document.querySelector('.tab-btn[data-tab-target="pitch"]');
      if (back) back.click();
    }
  });

  document.getElementById("admin-login-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    const email = document.getElementById("admin-login-email").value.trim();
    const password = document.getElementById("admin-login-password").value;
    const errEl = document.getElementById("admin-login-error");
    errEl.textContent = "";
    const submitBtn = e.target.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;
    try {
      const res = await fetch(BACKEND_BASE_URL + "/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error((body && body.detail) || "Email ou mot de passe incorrect.");
      }
      const data = await res.json();
      setAuthed(data.token);
      enterDashboard();
    } catch (err) {
      errEl.textContent = err.message || "Email ou mot de passe incorrect.";
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });

  document.getElementById("admin-logout").addEventListener("click", () => {
    clearAuthed();
    const back = document.querySelector('.tab-btn[data-tab-target="' + lastNonAdminTab + '"]') ||
                 document.querySelector('.tab-btn[data-tab-target="pitch"]');
    if (back) back.click();
    leaveToGate();
  });

  /* ---------------------------- Toasts ---------------------------- */
  function toast(msg, type) {
    const c = document.getElementById("admin-toast-container");
    const el = document.createElement("div");
    el.className = "admin-toast " + (type === "err" ? "err" : "ok");
    el.textContent = msg;
    c.appendChild(el);
    setTimeout(() => el.remove(), 3800);
  }

  /* ---------------------------- Sheet tabs ---------------------------- */
  function initSheetTabs() {
    const wrap = document.getElementById("admin-sheet-tabs");
    wrap.innerHTML = "";
    SHEET_ORDER.forEach((name) => {
      const tab = document.createElement("div");
      tab.className = "admin-sheet-tab" + (name === currentSheet ? " active" : "");
      tab.textContent = (SHEET_ICONS[name] || "") + " " + name;
      tab.addEventListener("click", () => { currentSheet = name; loadSheet(name); });
      wrap.appendChild(tab);
    });
  }

  /* ---------------------------- Data layer ---------------------------- */
  // Passe toujours par le backend (jamais directement par les webhooks Make,
  // qui ne sont connus que du serveur). action = "list" | "add" | "update" | "delete".
  async function callAdmin(action, payload) {
    const res = await fetch(BACKEND_BASE_URL + "/admin/inventaire/" + action, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + getToken(),
      },
      body: JSON.stringify(payload),
    });

    if (res.status === 401) {
      // Session expirée (20 min) ou jeton invalide : on renvoie proprement vers le login.
      clearAuthed();
      leaveToGate();
      showLogin();
      document.getElementById("admin-login-error").textContent = "Session expirée, reconnecte-toi.";
      throw new Error("Session expirée, reconnecte-toi.");
    }

    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch (e) { json = null; }
    if (!res.ok) {
      const msg = (json && (json.detail || json.error)) || text || ("HTTP " + res.status);
      throw new Error(msg);
    }
    return json;
  }

  async function loadSheet(name) {
    currentSheet = name;
    initSheetTabs();
    document.getElementById("admin-content").innerHTML = '<div class="admin-empty-state">Chargement…</div>';
    const meta = SHEET_META[name];
    const table = meta.table;

    try {
      const resp = await callAdmin("list", { table });
      const rows = (resp && resp.value) ? resp.value.map((r) => ({ index: r.index, values: r.values[0] })) : [];
      STATE[name] = { header: meta.header, table, rows, live: true, filters: {}, selected: new Set() };
      document.getElementById("admin-sync-banner").innerHTML = "";
    } catch (err) {
      STATE[name] = { header: meta.header, table, rows: [], live: false, filters: {}, selected: new Set() };
      document.getElementById("admin-sync-banner").innerHTML =
        '<div class="admin-banner admin-banner-warn">⚠️ Connexion au fichier OneDrive impossible pour le moment. Remplace <code>DUCHESS_Inventaire.xlsx</code> sur OneDrive par la version restructurée fournie pour activer la synchro en direct (ajout/suppression désactivés en attendant).</div>';
    }
    buildFiltersPanel(name);
    renderSheet(name);
  }

  /* ---------------------------- Rendering ---------------------------- */
  function idxOf(header, name) { return header.indexOf(name); }

  function escapeHtml(s) {
    if (s === null || s === undefined) return "";
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function etatPillClass(etat) {
    if (!etat) return "admin-pill-neutral";
    const e = etat.toLowerCase();
    if (e.includes("bon") || e.includes("actif") || e.includes("neuf")) return "admin-pill-good";
    if (e.includes("vérifier") || e.includes("verifier") || e.includes("résilier")) return "admin-pill-warn";
    if (e.includes("endommag") || e.includes("défectueux") || e.includes("defectueux") || e.includes("hors service") || e.includes("perdu")) return "admin-pill-bad";
    return "admin-pill-neutral";
  }

  // Colonnes considérées numériques pour le calcul des totaux — détection par
  // nom (Prix/Nombre/Quantité), pas par contenu, pour rester stable même sur
  // un feuillet vide.
  function isNumericCol(colName) {
    return /prix|nombre|quantit/i.test(colName);
  }
  function parseNum(v) {
    if (v === null || v === undefined || v === "") return null;
    const n = parseFloat(String(v).replace(",", ".").replace(/[^\d.\-]/g, ""));
    return isNaN(n) ? null : n;
  }

  // Colonnes utilisées comme filtre "select" (peu de valeurs distinctes) vs
  // filtre texte libre (trop de valeurs distinctes pour un menu déroulant).
  const SELECT_FILTER_MAX_UNIQUE = 14;

  function buildFiltersPanel(name) {
    const { header, rows, filters } = STATE[name];
    const panel = document.getElementById("admin-filters-panel");
    let html = "";
    header.forEach((colName) => {
      const values = new Set();
      rows.forEach((r) => { const v = r.values[idxOf(header, colName)]; if (v) values.add(v); });
      const asSelect = values.size > 0 && values.size <= SELECT_FILTER_MAX_UNIQUE;
      const cur = filters[colName] || "";
      html += `<div class="admin-filter-item">`;
      html += `<label>${escapeHtml(colName)}</label>`;
      if (asSelect) {
        html += `<select data-filter-col="${escapeHtml(colName)}"><option value="">Tous</option>`;
        html += [...values].sort().map((v) => `<option value="${escapeHtml(v)}" ${cur === v ? "selected" : ""}>${escapeHtml(v)}</option>`).join("");
        html += `</select>`;
      } else {
        html += `<input type="text" data-filter-col="${escapeHtml(colName)}" value="${escapeHtml(cur)}" placeholder="Contient…">`;
      }
      html += `</div>`;
    });
    html += `<button type="button" class="admin-filters-reset" id="admin-filters-reset">Réinitialiser les filtres</button>`;
    panel.innerHTML = html;
    panel.querySelectorAll("[data-filter-col]").forEach((el) => {
      el.addEventListener(el.tagName === "SELECT" ? "change" : "input", () => {
        const col = el.getAttribute("data-filter-col");
        if (el.value) STATE[name].filters[col] = el.value;
        else delete STATE[name].filters[col];
        renderSheet(name);
      });
    });
    document.getElementById("admin-filters-reset").addEventListener("click", () => {
      STATE[name].filters = {};
      buildFiltersPanel(name);
      renderSheet(name);
    });
  }

  document.getElementById("admin-toggle-filters").addEventListener("click", () => {
    document.getElementById("admin-filters-panel").classList.toggle("hidden");
  });

  // Renvoie les lignes du feuillet après application de la recherche libre +
  // des filtres par colonne — utilisé par l'affichage, les totaux et l'export.
  function getFilteredRows(name) {
    const { header, rows, filters } = STATE[name];
    const search = document.getElementById("admin-search-input").value.trim().toLowerCase();
    return rows.filter((r) => {
      for (const colName in filters) {
        const val = filters[colName];
        const colIdx = idxOf(header, colName);
        const cellVal = r.values[colIdx];
        const asSelectSet = document.querySelector(`[data-filter-col="${CSS.escape(colName)}"]`);
        const isSelect = asSelectSet && asSelectSet.tagName === "SELECT";
        if (isSelect) {
          if (cellVal !== val) return false;
        } else {
          if (!String(cellVal || "").toLowerCase().includes(val.toLowerCase())) return false;
        }
      }
      if (search) {
        const hay = r.values.map((v) => (v === null || v === undefined) ? "" : String(v)).join(" ").toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });
  }

  function renderStatsBar(name, filtered) {
    const { header } = STATE[name];
    const bar = document.getElementById("admin-stats-bar");
    let html = `<strong>${filtered.length}</strong> élément${filtered.length > 1 ? "s" : ""}`;
    header.forEach((colName, i) => {
      if (!isNumericCol(colName)) return;
      let sum = 0, has = false;
      filtered.forEach((r) => { const n = parseNum(r.values[i]); if (n !== null) { sum += n; has = true; } });
      if (has) html += ` <span>· ${escapeHtml(colName)} : <strong>${sum.toLocaleString("fr-FR", { maximumFractionDigits: 2 })}</strong></span>`;
    });
    bar.innerHTML = html;
  }

  function updateBulkBar(name) {
    const selected = STATE[name].selected;
    const bar = document.getElementById("admin-bulk-bar");
    if (selected.size === 0) { bar.classList.add("hidden"); return; }
    bar.classList.remove("hidden");
    document.getElementById("admin-bulk-count").textContent = `${selected.size} sélectionné${selected.size > 1 ? "s" : ""}`;
  }

  function renderSheet(name) {
    const { header, selected } = STATE[name];
    const catIdx = idxOf(header, "Catégorie");
    const displayCols = header.filter((h) => h !== "Catégorie");
    const filtered = getFilteredRows(name);

    renderStatsBar(name, filtered);
    updateBulkBar(name);

    const groups = {};
    filtered.forEach((r) => {
      const cat = r.values[catIdx] || "Sans catégorie";
      (groups[cat] = groups[cat] || []).push(r);
    });

    const content = document.getElementById("admin-content");
    if (Object.keys(groups).length === 0) {
      content.innerHTML = '<div class="admin-empty-state">Aucun élément ne correspond à la recherche.</div>';
      return;
    }

    const isSoftware = name === "IT Software";

    let html = "";
    Object.keys(groups).sort().forEach((cat) => {
      const items = groups[cat];
      html += `<div class="admin-cat-group"><div class="admin-cat-head"><span>${escapeHtml(cat)}</span><span class="admin-count">${items.length} élément${items.length > 1 ? "s" : ""}</span></div>`;
      html += '<div class="admin-table-wrap"><table class="admin-table"><thead><tr><th class="admin-th-check"><input type="checkbox" data-select-all-group="1"></th>';
      displayCols.forEach((c) => html += `<th>${escapeHtml(c)}</th>`);
      html += "<th></th></tr></thead><tbody>";
      items.forEach((r) => {
        const isSel = selected.has(r.index);
        html += `<tr class="admin-row-clickable${isSel ? " admin-row-selected" : ""}" data-open="${r.index}" data-sheet="${escapeHtml(name)}">`;
        html += `<td class="admin-td-check"><input type="checkbox" data-select="${r.index}" ${isSel ? "checked" : ""}></td>`;
        displayCols.forEach((colName) => {
          const colIdx = idxOf(header, colName);
          let v = r.values[colIdx];
          if (colName === "État") {
            html += `<td>${v ? `<span class="admin-pill ${etatPillClass(v)}">${escapeHtml(v)}</span>` : ""}</td>`;
          } else if (colName === "Code Article") {
            html += `<td>${v ? `<span class="admin-code-badge">${escapeHtml(v)}</span>` : ""}</td>`;
          } else if (colName === "Mot de passe" && isSoftware) {
            const cellId = "admin-pw-" + name.replace(/\W/g, "") + "-" + r.index;
            html += `<td><span id="${cellId}" data-real="${escapeHtml(v || "")}">${v ? "••••••" : ""}</span>${v ? ` <span class="admin-mask-toggle" data-toggle-pw="${cellId}">voir</span>` : ""}</td>`;
          } else if (colName === "Nom") {
            html += `<td><strong>${escapeHtml(v)}</strong></td>`;
          } else {
            html += `<td>${escapeHtml(v)}</td>`;
          }
        });
        html += `<td class="admin-row-actions">
          <button class="admin-btn-icon admin-btn-icon-danger" title="Supprimer" data-delete="${r.index}" data-sheet="${escapeHtml(name)}">🗑</button>
        </td></tr>`;
      });
      html += "</tbody></table></div></div>";
    });
    content.innerHTML = html;

    content.querySelectorAll("[data-toggle-pw]").forEach((el) => {
      el.addEventListener("click", (e) => { e.stopPropagation(); togglePw(el.getAttribute("data-toggle-pw")); });
    });
    content.querySelectorAll("[data-open]").forEach((el) => {
      el.addEventListener("click", () => openEditRow(el.getAttribute("data-sheet"), parseInt(el.getAttribute("data-open"))));
    });
    content.querySelectorAll("[data-delete]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        confirmDelete(el.getAttribute("data-sheet"), parseInt(el.getAttribute("data-delete")));
      });
    });
    content.querySelectorAll("[data-select]").forEach((el) => {
      el.addEventListener("click", (e) => e.stopPropagation());
      el.addEventListener("change", () => {
        const idx = parseInt(el.getAttribute("data-select"));
        if (el.checked) STATE[name].selected.add(idx); else STATE[name].selected.delete(idx);
        el.closest("tr").classList.toggle("admin-row-selected", el.checked);
        updateBulkBar(name);
      });
    });
    content.querySelectorAll("[data-select-all-group]").forEach((el) => {
      el.addEventListener("click", (e) => e.stopPropagation());
      el.addEventListener("change", () => {
        const table = el.closest("table");
        table.querySelectorAll("[data-select]").forEach((cb) => {
          cb.checked = el.checked;
          const idx = parseInt(cb.getAttribute("data-select"));
          if (el.checked) STATE[name].selected.add(idx); else STATE[name].selected.delete(idx);
          cb.closest("tr").classList.toggle("admin-row-selected", el.checked);
        });
        updateBulkBar(name);
      });
    });
  }

  function togglePw(cellId) {
    const el = document.getElementById(cellId);
    if (!el) return;
    const real = el.getAttribute("data-real");
    el.textContent = el.textContent === "••••••" ? (real || "(vide)") : "••••••";
  }

  document.getElementById("admin-search-input").addEventListener("input", () => renderSheet(currentSheet));

  /* ---------------------------- Add / edit modal ---------------------------- */
  const rowOverlay = document.getElementById("admin-row-overlay");
  document.getElementById("admin-cancel-row").addEventListener("click", () => {
    rowOverlay.classList.add("hidden");
    resetPhotos();
  });
  document.getElementById("admin-add-row").addEventListener("click", () => openAddRow());

  function fieldInputType(colName) {
    if (colName === "Nombre") return "number";
    if (colName === "Commentaire") return "textarea";
    return "text";
  }

  function buildRowForm(name, values) {
    const { header } = STATE[name];
    const wrap = document.getElementById("admin-row-fields");
    wrap.innerHTML = "";
    header.forEach((colName, i) => {
      const val = values ? (values[i] ?? "") : "";
      const type = fieldInputType(colName);
      const div = document.createElement("div");
      div.className = "admin-field";
      if (colName === "État") {
        div.innerHTML = `<label>${colName}</label>
          <select data-col="${i}">
            <option value=""></option>
            ${["Neuf", "Bon état", "Endommagé", "Défectueux", "Hors service", "Perdu", "Actif", "À vérifier", "À résilier"].map((o) => `<option value="${o}" ${val === o ? "selected" : ""}>${o}</option>`).join("")}
          </select>`;
      } else if (type === "textarea") {
        div.innerHTML = `<label>${colName}</label><textarea data-col="${i}" rows="2">${escapeHtml(val)}</textarea>`;
      } else {
        div.innerHTML = `<label>${colName}</label><input type="${type}" data-col="${i}" value="${escapeHtml(val)}">`;
      }
      wrap.appendChild(div);
    });
  }

  const deleteRowBtn = document.getElementById("admin-delete-row");

  /* ---------------------------- Photos + analyse IA ---------------------------- */
  const MAX_PHOTOS = 5;
  let selectedPhotos = [];
  const photoInput = document.getElementById("admin-row-photos");
  const photoThumbsWrap = document.getElementById("admin-photo-thumbs");
  const photoAddLabel = document.getElementById("admin-photo-add-label");
  const analyzeBtn = document.getElementById("admin-analyze-photos");

  function resetPhotos() {
    selectedPhotos.forEach((p) => { if (p.previewUrl) URL.revokeObjectURL(p.previewUrl); });
    selectedPhotos = [];
    photoInput.value = "";
    renderPhotoThumbs();
  }

  function renderPhotoThumbs() {
    photoThumbsWrap.innerHTML = "";
    selectedPhotos.forEach((p, i) => {
      const div = document.createElement("div");
      div.className = "admin-photo-thumb";
      div.innerHTML = `<img src="${p.previewUrl}" alt=""><button type="button" class="admin-photo-remove" data-remove="${i}">✕</button>`;
      photoThumbsWrap.appendChild(div);
    });
    photoThumbsWrap.querySelectorAll("[data-remove]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const i = parseInt(btn.getAttribute("data-remove"));
        const [removed] = selectedPhotos.splice(i, 1);
        if (removed && removed.previewUrl) URL.revokeObjectURL(removed.previewUrl);
        renderPhotoThumbs();
      });
    });
    photoAddLabel.style.display = selectedPhotos.length >= MAX_PHOTOS ? "none" : "flex";
    analyzeBtn.disabled = selectedPhotos.length === 0;
  }

  photoInput.addEventListener("change", () => {
    const files = Array.from(photoInput.files || []);
    const room = MAX_PHOTOS - selectedPhotos.length;
    files.slice(0, room).forEach((file) => {
      selectedPhotos.push({ file, previewUrl: URL.createObjectURL(file) });
    });
    photoInput.value = "";
    renderPhotoThumbs();
  });

  analyzeBtn.addEventListener("click", async () => {
    if (selectedPhotos.length === 0) return;
    const sheet = editingContext ? editingContext.sheet : currentSheet;
    const { header } = STATE[sheet];
    const errEl = document.getElementById("admin-row-error");
    errEl.textContent = "";
    analyzeBtn.classList.add("loading");
    analyzeBtn.disabled = true;
    try {
      const fd = new FormData();
      fd.append("columns", JSON.stringify(header));
      selectedPhotos.forEach((p) => fd.append("photos", p.file, p.file.name || "photo.jpg"));
      const res = await fetch(BACKEND_BASE_URL + "/admin/inventaire/analyze-photo", {
        method: "POST",
        headers: { "Authorization": "Bearer " + getToken() },
        body: fd,
      });
      if (res.status === 401) {
        clearAuthed();
        rowOverlay.classList.add("hidden");
        leaveToGate();
        showLogin();
        document.getElementById("admin-login-error").textContent = "Session expirée, reconnecte-toi.";
        return;
      }
      const text = await res.text();
      let json; try { json = JSON.parse(text); } catch (e) { json = null; }
      if (!res.ok) throw new Error((json && json.detail) || text || "Analyse impossible.");

      const values = (json && json.values) || {};
      let filled = 0;
      header.forEach((colName, i) => {
        const v = values[colName];
        if (v === undefined || v === null || v === "") return;
        const field = document.querySelector(`#admin-row-fields [data-col="${i}"]`);
        if (!field) return;
        if (field.value) return; // ne jamais écraser une valeur déjà saisie/existante
        if (field.tagName === "SELECT") {
          const hasOption = Array.from(field.options).some((o) => o.value === v);
          if (!hasOption) return;
        }
        field.value = v;
        field.classList.add("admin-field-filled");
        filled++;
      });
      toast(filled > 0 ? `Formulaire prérempli (${filled} champ${filled > 1 ? "s" : ""} détecté${filled > 1 ? "s" : ""}) ✨` : "L'IA n'a rien pu lire de fiable sur ces photos.", filled > 0 ? "ok" : "err");
    } catch (err) {
      errEl.textContent = err.message || "Analyse impossible.";
    } finally {
      analyzeBtn.classList.remove("loading");
      analyzeBtn.disabled = selectedPhotos.length === 0;
    }
  });

  function openAddRow() {
    editingContext = null;
    document.getElementById("admin-row-modal-title").textContent = "Ajouter un élément — " + currentSheet;
    document.getElementById("admin-row-modal-sub").textContent = "Le code article n'est pas généré automatiquement : renseigne-le en suivant la nomenclature existante.";
    document.getElementById("admin-row-error").textContent = "";
    deleteRowBtn.classList.add("hidden");
    resetPhotos();
    buildRowForm(currentSheet, null);
    rowOverlay.classList.remove("hidden");
  }

  function openEditRow(name, index) {
    const row = STATE[name].rows.find((r) => r.index === index);
    if (!row) return;
    editingContext = { sheet: name, index };
    document.getElementById("admin-row-modal-title").textContent = "Modifier — " + name;
    document.getElementById("admin-row-modal-sub").textContent = "";
    document.getElementById("admin-row-error").textContent = "";
    deleteRowBtn.classList.remove("hidden");
    resetPhotos();
    buildRowForm(name, row.values);
    rowOverlay.classList.remove("hidden");
  }

  deleteRowBtn.addEventListener("click", async () => {
    if (!editingContext) return;
    const done = await deleteRow(editingContext.sheet, editingContext.index);
    if (done) rowOverlay.classList.add("hidden");
  });

  document.getElementById("admin-row-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    const sheet = editingContext ? editingContext.sheet : currentSheet;
    const { header } = STATE[sheet];
    const errEl = document.getElementById("admin-row-error");
    const inputs = document.querySelectorAll("#admin-row-fields [data-col]");
    const values = new Array(header.length).fill(null);
    inputs.forEach((inp) => { values[parseInt(inp.dataset.col)] = inp.value === "" ? null : inp.value; });

    const btn = document.getElementById("admin-save-row");
    btn.disabled = true;
    try {
      if (!STATE[sheet].live) throw new Error("Synchro OneDrive indisponible pour le moment (voir le message en haut de la page).");
      if (editingContext) {
        await callAdmin("update", { table: STATE[sheet].table, index: editingContext.index, values: [values] });
        toast("Élément mis à jour ✅", "ok");
      } else {
        await callAdmin("add", { table: STATE[sheet].table, values: [values] });
        toast("Élément ajouté ✅", "ok");
      }
      rowOverlay.classList.add("hidden");
      resetPhotos();
      await loadSheet(sheet);
    } catch (err) {
      errEl.textContent = err.message || "Erreur lors de l'enregistrement.";
    } finally {
      btn.disabled = false;
    }
  });

  /* ---------------------------- Delete ---------------------------- */
  // Retourne true si la suppression a bien eu lieu (utile pour fermer la popup d'édition).
  async function deleteRow(name, index) {
    const row = STATE[name].rows.find((r) => r.index === index);
    const nomIdx = idxOf(STATE[name].header, "Nom");
    const label = row ? (row.values[nomIdx] || "cet élément") : "cet élément";
    if (!confirm(`Êtes-vous sûr de vouloir supprimer « ${label} » ? Cette action modifie directement le fichier Excel sur OneDrive.`)) return false;
    if (!STATE[name].live) { toast("Synchro OneDrive indisponible pour le moment.", "err"); return false; }
    try {
      await callAdmin("delete", { table: STATE[name].table, index });
      toast("Élément supprimé 🗑", "ok");
      await loadSheet(name);
      return true;
    } catch (err) {
      toast("Erreur : " + (err.message || "suppression impossible"), "err");
      return false;
    }
  }

  // Conserve l'ancien nom utilisé par les icônes poubelle dans le tableau.
  function confirmDelete(name, index) { deleteRow(name, index); }

  /* ---------------------------- Bouton flottant "+ Ajouter" ---------------------------- */
  const fabBtn = document.getElementById("admin-add-row-fab");
  if (fabBtn) fabBtn.addEventListener("click", () => openAddRow());

  /* ---------------------------- Export (Excel / Texte) ---------------------------- */
  function rowsToAOA(name, rows) {
    const { header } = STATE[name];
    return [header, ...rows.map((r) => header.map((c, i) => r.values[i] ?? ""))];
  }

  function exportRowsXlsx(name, rows, suffix) {
    const aoa = rowsToAOA(name, rows);
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31));
    XLSX.writeFile(wb, `${name} - ${suffix}.xlsx`);
  }

  function exportRowsTxt(name, rows, suffix) {
    const { header } = STATE[name];
    let text = header.join("\t") + "\n";
    rows.forEach((r) => { text += header.map((c, i) => (r.values[i] ?? "")).join("\t") + "\n"; });
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name} - ${suffix}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // Le menu "Excel / Texte" est partagé entre le bouton de la toolbar (export
  // du feuillet filtré) et le bouton de la barre d'actions groupées (export de
  // la seule sélection) — pendingExportScope indique lequel a ouvert le menu.
  let pendingExportScope = "filtered";
  const exportMenu = document.getElementById("admin-export-menu");

  document.getElementById("admin-export-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    pendingExportScope = "filtered";
    exportMenu.classList.toggle("hidden");
  });

  const bulkExportBtn = document.getElementById("admin-bulk-export");
  if (bulkExportBtn) {
    bulkExportBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      pendingExportScope = "selected";
      exportMenu.classList.remove("hidden");
    });
  }

  document.addEventListener("click", (e) => {
    if (!exportMenu.classList.contains("hidden") && !exportMenu.contains(e.target) && e.target.id !== "admin-export-btn" && e.target.id !== "admin-bulk-export") {
      exportMenu.classList.add("hidden");
    }
  });

  exportMenu.querySelectorAll("[data-export-format]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const format = btn.getAttribute("data-export-format");
      exportMenu.classList.add("hidden");
      const name = currentSheet;
      let rows, suffix;
      if (pendingExportScope === "selected") {
        const sel = STATE[name].selected;
        rows = STATE[name].rows.filter((r) => sel.has(r.index));
        suffix = "sélection";
        if (rows.length === 0) { toast("Aucune ligne sélectionnée.", "err"); return; }
      } else {
        rows = getFilteredRows(name);
        suffix = "export";
      }
      if (format === "xlsx") exportRowsXlsx(name, rows, suffix); else exportRowsTxt(name, rows, suffix);
      toast(`Export ${format.toUpperCase()} généré ✅`, "ok");
    });
  });

  /* ---------------------------- Actions groupées ---------------------------- */
  document.getElementById("admin-bulk-clear").addEventListener("click", () => {
    STATE[currentSheet].selected.clear();
    renderSheet(currentSheet);
  });

  document.getElementById("admin-bulk-delete").addEventListener("click", async () => {
    const name = currentSheet;
    const sel = [...STATE[name].selected];
    if (sel.length === 0) return;
    if (!confirm(`Supprimer ${sel.length} élément${sel.length > 1 ? "s" : ""} ? Cette action modifie directement le fichier Excel sur OneDrive.`)) return;
    if (!STATE[name].live) { toast("Synchro OneDrive indisponible pour le moment.", "err"); return; }
    // Index décroissants : chaque suppression décale les index suivants vers
    // le bas, donc il faut toujours supprimer du plus grand index au plus petit.
    const sortedDesc = sel.sort((a, b) => b - a);
    try {
      for (const idx of sortedDesc) {
        await callAdmin("delete", { table: STATE[name].table, index: idx });
      }
      toast(`${sel.length} élément${sel.length > 1 ? "s" : ""} supprimé${sel.length > 1 ? "s" : ""} 🗑`, "ok");
    } catch (err) {
      toast("Erreur : " + (err.message || "suppression impossible"), "err");
    } finally {
      STATE[name].selected.clear();
      await loadSheet(name);
    }
  });

  document.getElementById("admin-bulk-duplicate").addEventListener("click", async () => {
    const name = currentSheet;
    const sel = [...STATE[name].selected];
    if (sel.length === 0) return;
    if (!STATE[name].live) { toast("Synchro OneDrive indisponible pour le moment.", "err"); return; }
    const rowsToDup = STATE[name].rows.filter((r) => sel.includes(r.index));
    try {
      for (const r of rowsToDup) {
        await callAdmin("add", { table: STATE[name].table, values: [r.values] });
      }
      toast(`${rowsToDup.length} élément${rowsToDup.length > 1 ? "s" : ""} dupliqué${rowsToDup.length > 1 ? "s" : ""} ✅`, "ok");
    } catch (err) {
      toast("Erreur : " + (err.message || "duplication impossible"), "err");
    } finally {
      STATE[name].selected.clear();
      await loadSheet(name);
    }
  });

  const bulkEditOverlay = document.getElementById("admin-bulk-edit-overlay");
  document.getElementById("admin-bulk-edit").addEventListener("click", () => {
    const name = currentSheet;
    const sel = STATE[name].selected;
    if (sel.size === 0) return;
    const { header } = STATE[name];
    const fieldSel = document.getElementById("admin-bulk-edit-field");
    fieldSel.innerHTML = header.map((c, i) => `<option value="${i}">${escapeHtml(c)}</option>`).join("");
    document.getElementById("admin-bulk-edit-sub").textContent =
      `${sel.size} élément${sel.size > 1 ? "s" : ""} sélectionné${sel.size > 1 ? "s" : ""} — la valeur choisie remplace ce champ sur toutes ces lignes.`;
    document.getElementById("admin-bulk-edit-value").value = "";
    document.getElementById("admin-bulk-edit-error").textContent = "";
    bulkEditOverlay.classList.remove("hidden");
  });

  document.getElementById("admin-bulk-edit-cancel").addEventListener("click", () => {
    bulkEditOverlay.classList.add("hidden");
  });

  document.getElementById("admin-bulk-edit-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    const name = currentSheet;
    const sel = [...STATE[name].selected];
    const errEl = document.getElementById("admin-bulk-edit-error");
    errEl.textContent = "";
    if (sel.length === 0) { errEl.textContent = "Aucune ligne sélectionnée."; return; }
    if (!STATE[name].live) { errEl.textContent = "Synchro OneDrive indisponible pour le moment."; return; }
    const colIdx = parseInt(document.getElementById("admin-bulk-edit-field").value);
    const newVal = document.getElementById("admin-bulk-edit-value").value;
    const btn = e.target.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    try {
      for (const idx of sel) {
        const row = STATE[name].rows.find((r) => r.index === idx);
        if (!row) continue;
        const values = row.values.slice();
        values[colIdx] = newVal === "" ? null : newVal;
        await callAdmin("update", { table: STATE[name].table, index: idx, values: [values] });
      }
      toast(`${sel.length} élément${sel.length > 1 ? "s" : ""} modifié${sel.length > 1 ? "s" : ""} ✅`, "ok");
      bulkEditOverlay.classList.add("hidden");
      STATE[name].selected.clear();
      await loadSheet(name);
    } catch (err) {
      errEl.textContent = err.message || "Erreur lors de la modification groupée.";
    } finally {
      if (btn) btn.disabled = false;
    }
  });
})();
