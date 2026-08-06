(function () {
  "use strict";

  /* =====================================================================
     DUCHESS HUB — Onglet Admin > Budgets Projets
     =====================================================================
     1 fichier Excel par artiste (sur SharePoint) = 1 budget, 1 feuillet =
     1 projet (EP/LP/single). Toute la logique de structure/calcul vit
     côté backend (backend/budget_engine.py) — ce fichier ne fait que
     charger/éditer/sauvegarder l'arbre JSON renvoyé par l'API, avec le
     même jeton de session que l'Inventaire (voir js/admin.js).

     Équivalent web de chaque macro VBA du fichier d'origine :
       Ajouter_Sous_Poste -> "+ sous-poste" (modale catégorie déjà connue
         puisqu'on est déjà dans le bloc de la catégorie)
       Ajouter_Depense     -> "+ dépense" sur un sous-poste container
       Supprimer_Sous_Poste / Supprimer_Depense -> icônes 🗑 inline
       Nouveau_Projet (duplication de feuillet) -> "+ Nouveau projet"
     ===================================================================== */
  const BACKEND_BASE_URL = "https://duchess-hub.onrender.com";
  const AUTH_KEY = "duchess-hub-admin-token";

  function getToken() { return sessionStorage.getItem(AUTH_KEY) || ""; }

  function toast(msg, type) {
    const c = document.getElementById("admin-toast-container");
    if (!c) return;
    const el = document.createElement("div");
    el.className = "admin-toast " + (type === "err" ? "err" : "ok");
    el.textContent = msg;
    c.appendChild(el);
    setTimeout(() => el.remove(), 3800);
  }

  /* ---------------------------- View switching (sidebar) ---------------------------- */
  const navInventaire = document.getElementById("admin-nav-inventaire");
  const navBudget = document.getElementById("admin-nav-budget");
  const viewInventaire = document.getElementById("admin-view-inventaire");
  const viewBudget = document.getElementById("admin-view-budget");
  const fab = document.getElementById("admin-add-row-fab");
  let budgetLoadedOnce = false;

  function showInventaireView() {
    navInventaire.classList.add("active");
    navBudget.classList.remove("active");
    viewInventaire.classList.remove("hidden");
    viewBudget.classList.add("hidden");
    if (fab) fab.classList.remove("hidden");
  }
  function showBudgetView() {
    navBudget.classList.add("active");
    navInventaire.classList.remove("active");
    viewBudget.classList.remove("hidden");
    viewInventaire.classList.add("hidden");
    if (fab) fab.classList.add("hidden");
    if (!budgetLoadedOnce) { budgetLoadedOnce = true; loadArtists(); }
  }
  if (navInventaire) navInventaire.addEventListener("click", showInventaireView);
  if (navBudget) navBudget.addEventListener("click", showBudgetView);

  /* ---------------------------- Data layer ---------------------------- */
  async function callBudget(path, options) {
    options = options || {};
    // BUG corrigé : Object.assign({headers:...}, options) écrasait entièrement
    // "headers" dès que l'appelant passait ses propres headers (cas de TOUTES
    // les écritures via callBudgetJSON, qui posent Content-Type) — le jeton
    // d'authentification partait alors silencieusement absent, et le backend
    // renvoyait 401 sur new-artist/save/new-project/delete. Seuls les GET sans
    // options.headers (chargement des listes) fonctionnaient par accident.
    // Fix : on fusionne toujours "Authorization" PAR-DESSUS les headers de
    // l'appelant, en dernier, dans le même objet.
    const headers = Object.assign({ "Authorization": "Bearer " + getToken() }, options.headers || {});
    const res = await fetch(BACKEND_BASE_URL + path, Object.assign({}, options, { headers }));
    if (res.status === 401) {
      sessionStorage.removeItem(AUTH_KEY);
      const adminTabBtn = document.querySelector('.tab-btn[data-tab-target="admin"]');
      if (adminTabBtn) adminTabBtn.click();
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
  function callBudgetJSON(path, method, body) {
    return callBudget(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
  }

  /* ---------------------------- State ---------------------------- */
  let ARTISTS = [];          // [{fileId, fileName, artist, ...}]
  let CATEGORIES = [];       // ordre fixe des 7 catégories
  let CATEGORY_PRESETS = {}; // nom catégorie -> [sous-postes prédéfinis]
  let SIMPLE_CATEGORIES = [];
  let currentArtist = null;  // entrée de ARTISTS
  let currentProjects = [];  // noms des feuillets pour l'artiste courant
  let currentProject = null; // nom du feuillet courant
  let currentTree = null;    // arbre JSON en cours d'édition
  let dirty = false;
  let addSpCategory = null;  // catégorie ciblée par la modale "+ sous-poste"

  const EUR = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" });
  function fmtEur(v) { return EUR.format(Number(v) || 0); }
  function fmtPct(v) { return v === null || v === undefined ? "—" : Math.round(v * 100) + "%"; }
  function pctClass(v) {
    if (v === null || v === undefined) return "";
    if (v > 1) return "budget-pct-over";
    if (v >= 0.9) return "budget-pct-warn";
    return "budget-pct-ok";
  }

  /* ---------------------------- Artistes ---------------------------- */
  async function loadArtists() {
    const wrap = document.getElementById("budget-artist-tabs");
    wrap.innerHTML = '<div class="admin-empty-state">Chargement…</div>';
    try {
      const resp = await callBudget("/admin/budget/artists");
      ARTISTS = resp.artists || [];
      CATEGORIES = resp.categories || [];
      CATEGORY_PRESETS = resp.categoryPresets || {};
      SIMPLE_CATEGORIES = resp.simpleCategories || [];
      renderArtistTabs();
      if (ARTISTS.length) {
        selectArtist(ARTISTS[0]);
      } else {
        document.getElementById("budget-project-bar").classList.add("hidden");
        document.getElementById("budget-content").innerHTML =
          '<div class="admin-empty-state">Aucun budget artiste pour l\'instant — clique sur « ✚ Nouvel artiste » pour commencer.</div>';
      }
    } catch (err) {
      wrap.innerHTML = "";
      toast(err.message || "Erreur de chargement des budgets.", "err");
      document.getElementById("budget-content").innerHTML =
        '<div class="admin-empty-state">Impossible de charger les budgets — ' + (err.message || "") + "</div>";
    }
  }

  function renderArtistTabs() {
    const wrap = document.getElementById("budget-artist-tabs");
    wrap.innerHTML = "";
    ARTISTS.forEach((a) => {
      const isActive = currentArtist && currentArtist.fileId === a.fileId;
      const tab = document.createElement("div");
      tab.className = "admin-sheet-tab" + (isActive ? " active" : "");
      const label = document.createElement("span");
      label.textContent = "🎤 " + a.artist;
      tab.appendChild(label);
      if (isActive) tab.appendChild(renamePencil("Renommer l'artiste", () => openRenameModal("artist", a.artist)));
      tab.addEventListener("click", () => selectArtist(a));
      wrap.appendChild(tab);
    });
  }

  async function selectArtist(artist) {
    if (dirty && !(await confirmLeave())) return;
    currentArtist = artist;
    renderArtistTabs();
    document.getElementById("budget-project-bar").classList.remove("hidden");
    document.getElementById("budget-content").innerHTML = '<div class="admin-empty-state">Chargement des projets…</div>';
    try {
      const resp = await callBudget("/admin/budget/file/" + encodeURIComponent(artist.fileId) + "/projects");
      currentProjects = resp.projects || [];
      renderProjectTabs();
      if (currentProjects.length) selectProject(currentProjects[0]);
    } catch (err) {
      toast(err.message || "Erreur de chargement des projets.", "err");
    }
  }

  function renderProjectTabs() {
    const wrap = document.getElementById("budget-project-tabs");
    wrap.innerHTML = "";
    currentProjects.forEach((name) => {
      const isActive = currentProject === name;
      const tab = document.createElement("div");
      tab.className = "admin-sheet-tab" + (isActive ? " active" : "");
      const label = document.createElement("span");
      label.textContent = name;
      tab.appendChild(label);
      if (isActive) tab.appendChild(renamePencil("Renommer le projet", () => openRenameModal("project", name)));
      tab.addEventListener("click", () => selectProject(name));
      wrap.appendChild(tab);
    });
  }

  /* Petit ✎ discret, réutilisé pour renommer artiste / projet / sous-poste. */
  function renamePencil(title, onClick) {
    const pencil = document.createElement("span");
    pencil.className = "budget-rename-pencil";
    pencil.textContent = "✎";
    pencil.title = title;
    pencil.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
    return pencil;
  }

  async function selectProject(name) {
    if (dirty && !(await confirmLeave())) return;
    currentProject = name;
    renderProjectTabs();
    const contentEl = document.getElementById("budget-content");
    contentEl.innerHTML = '<div class="admin-empty-state">Chargement…</div>';
    try {
      const tree = await callBudget(
        "/admin/budget/file/" + encodeURIComponent(currentArtist.fileId) +
        "/projects/" + encodeURIComponent(name)
      );
      currentTree = tree;
      dirty = false;
      renderTree();
    } catch (err) {
      toast(err.message || "Erreur de chargement du projet.", "err");
      contentEl.innerHTML = '<div class="admin-empty-state">Erreur : ' + (err.message || "") + "</div>";
    }
  }

  function confirmLeave() {
    return Promise.resolve(window.confirm("Des modifications non enregistrées seront perdues. Continuer ?"));
  }

  /* ---------------------------- Calcul local (miroir de compute_totals côté backend) ---------------------------- */
  function num(v) { const n = parseFloat(v); return isFinite(n) ? n : 0; }
  function ratio(a, b) { return b ? a / b : null; }

  function recomputeTree() {
    const grand = { budget: 0, previsionnel: 0, realise: 0 };
    (currentTree.categories || []).forEach((cat) => {
      let catPrevi = 0, catRealise = 0;
      (cat.sous_postes || []).forEach((sp) => {
        let spPrevi, spRealise;
        if (sp.type === "container") {
          spPrevi = (sp.depenses || []).reduce((s, d) => s + num(d.previsionnel), 0);
          spRealise = (sp.depenses || []).reduce((s, d) => s + num(d.realise), 0);
          sp.previsionnel = spPrevi; sp.realise = spRealise;
        } else {
          spPrevi = num(sp.previsionnel); spRealise = num(sp.realise);
        }
        const spBudget = num(sp.budget);
        sp.ratios = {
          previ_budget: ratio(spPrevi, spBudget),
          realise_previ: ratio(spRealise, spPrevi),
          realise_budget: ratio(spRealise, spBudget),
        };
        catPrevi += spPrevi; catRealise += spRealise;
      });
      cat.previsionnel = catPrevi; cat.realise = catRealise;
      const catBudget = num(cat.budget);
      cat.ratios = {
        previ_budget: ratio(catPrevi, catBudget),
        realise_previ: ratio(catRealise, catPrevi),
        realise_budget: ratio(catRealise, catBudget),
      };
      grand.budget += catBudget; grand.previsionnel += catPrevi; grand.realise += catRealise;
    });
    grand.ratios = {
      previ_budget: ratio(grand.previsionnel, grand.budget),
      realise_previ: ratio(grand.realise, grand.previsionnel),
      realise_budget: ratio(grand.realise, grand.budget),
    };
    currentTree.total = grand;
  }

  function markDirty() {
    dirty = true;
    recomputeTree();
    renderTree(true);
  }

  /* ---------------------------- Rendu de l'arbre ---------------------------- */
  function catByName(name) {
    return (currentTree.categories || []).find((c) => c.name === name);
  }

  function renderTree(keepFocus) {
    const contentEl = document.getElementById("budget-content");
    const t = currentTree.total || {};
    let html = "";

    html += '<div class="budget-summary-bar">';
    html += '<div class="budget-summary-item"><span>Budget</span><b>' + fmtEur(t.budget) + "</b></div>";
    html += '<div class="budget-summary-item"><span>Prévisionnel</span><b>' + fmtEur(t.previsionnel) + "</b></div>";
    html += '<div class="budget-summary-item"><span>Réalisé</span><b>' + fmtEur(t.realise) + "</b></div>";
    html += '<div class="budget-summary-item ' + pctClass(t.ratios && t.ratios.realise_budget) + '"><span>Réalisé / Budget</span><b>' + fmtPct(t.ratios && t.ratios.realise_budget) + "</b></div>";
    html += '<button type="button" class="admin-btn admin-btn-primary" id="budget-save-btn"' + (dirty ? "" : " disabled") + ">💾 " + (dirty ? "Enregistrer" : "Enregistré") + "</button>";
    html += "</div>";

    (CATEGORIES.length ? CATEGORIES : (currentTree.categories || []).map((c) => c.name)).forEach((catName) => {
      const cat = catByName(catName) || { name: catName, budget: 0, sous_postes: [], previsionnel: 0, realise: 0, ratios: {} };
      html += '<div class="budget-cat" data-cat="' + escAttr(catName) + '">';
      html += '<div class="budget-cat-head">';
      html += '<div class="budget-cat-name">' + escHtml(catName) + "</div>";
      html += '<div class="budget-row-nums">';
      html += numCell("Budget", budgetInput("cat", catName, null, "budget", cat.budget));
      html += numCell("Prévisionnel", '<div class="budget-num budget-num-ro">' + fmtEur(cat.previsionnel) + "</div>");
      html += numCell("Réalisé", '<div class="budget-num budget-num-ro budget-num-realise">' + fmtEur(cat.realise) + "</div>");
      html += ratioBadges(cat.ratios);
      html += "</div>";
      html += '<button type="button" class="admin-btn admin-btn-ghost admin-btn-sm budget-add-sp-btn" data-cat="' + escAttr(catName) + '">+ sous-poste</button>';
      html += "</div>";

      (cat.sous_postes || []).forEach((sp, spIdx) => {
        if (sp.type === "container") {
          html += '<div class="budget-sp budget-sp-container" data-cat="' + escAttr(catName) + '" data-sp="' + spIdx + '">';
          html += '<div class="budget-sp-head">';
          html += '<div class="budget-sp-name">' + escHtml(sp.name) + ' :<span class="budget-rename-pencil budget-sp-rename-btn" data-cat="' + escAttr(catName) + '" data-sp="' + spIdx + '" title="Renommer ce sous-poste">✎</span></div>';
          html += '<div class="budget-row-nums">';
          html += numCell("Budget", budgetInput("sp", catName, spIdx, "budget", sp.budget));
          html += numCell("Prévisionnel", '<div class="budget-num budget-num-ro">' + fmtEur(sp.previsionnel) + "</div>");
          html += numCell("Réalisé", '<div class="budget-num budget-num-ro budget-num-realise">' + fmtEur(sp.realise) + "</div>");
          html += ratioBadges(sp.ratios);
          html += "</div>";
          html += '<button type="button" class="admin-btn-icon budget-add-dep-btn" data-cat="' + escAttr(catName) + '" data-sp="' + spIdx + '" title="Ajouter une dépense">＋</button>';
          html += '<button type="button" class="admin-btn-icon admin-btn-icon-danger budget-del-sp-btn" data-cat="' + escAttr(catName) + '" data-sp="' + spIdx + '" title="Supprimer ce sous-poste">🗑</button>';
          html += "</div>";
          html += '<div class="budget-dep-cols"><span class="budget-dep-col-label"></span><span class="budget-dep-col-label">Fournisseur</span><span class="budget-dep-col-label">Prévisionnel</span><span class="budget-dep-col-label budget-dep-col-realise">Réalisé</span><span class="budget-dep-col-label budget-dep-col-spacer"></span></div>';
          (sp.depenses || []).forEach((dep, depIdx) => {
            html += '<div class="budget-dep" data-cat="' + escAttr(catName) + '" data-sp="' + spIdx + '" data-dep="' + depIdx + '">';
            html += '<input type="text" class="budget-dep-label" value="' + escAttr(dep.label) + '" data-field="label" placeholder="Dépense">';
            html += '<input type="text" class="budget-dep-fourn" value="' + escAttr(dep.fournisseur) + '" data-field="fournisseur" placeholder="Fournisseur" title="Fournisseur">';
            html += numInput("dep-previ", dep.previsionnel, "Prévisionnel (€)");
            html += numInput("dep-realise budget-dep-realise-input", dep.realise, "Réalisé (€)");
            html += '<button type="button" class="admin-btn-icon admin-btn-icon-danger budget-del-dep-btn" data-cat="' + escAttr(catName) + '" data-sp="' + spIdx + '" data-dep="' + depIdx + '" title="Supprimer cette dépense">🗑</button>';
            html += "</div>";
          });
          html += "</div>";
        } else {
          html += '<div class="budget-sp budget-sp-simple" data-cat="' + escAttr(catName) + '" data-sp="' + spIdx + '">';
          html += '<div class="budget-sp-name">' + escHtml(sp.name) + '<span class="budget-rename-pencil budget-sp-rename-btn" data-cat="' + escAttr(catName) + '" data-sp="' + spIdx + '" title="Renommer ce sous-poste">✎</span></div>';
          html += '<input type="text" class="budget-dep-fourn" value="' + escAttr(sp.fournisseur) + '" data-field="fournisseur" placeholder="Fournisseur" title="Fournisseur">';
          html += '<div class="budget-row-nums">';
          html += numCell("Budget", budgetInput("sp", catName, spIdx, "budget", sp.budget));
          html += numCell("Prévisionnel", budgetInput("sp", catName, spIdx, "previsionnel", sp.previsionnel));
          html += numCell("Réalisé", budgetInput("sp", catName, spIdx, "realise", sp.realise));
          html += ratioBadges(sp.ratios);
          html += "</div>";
          html += '<button type="button" class="admin-btn-icon admin-btn-icon-danger budget-del-sp-btn" data-cat="' + escAttr(catName) + '" data-sp="' + spIdx + '" title="Supprimer ce sous-poste">🗑</button>';
          html += "</div>";
        }
      });
      html += "</div>";
    });

    contentEl.innerHTML = html;
    wireTreeEvents();
  }

  function budgetInput(level, catName, spIdx, field, value) {
    return '<input type="number" step="0.01" class="budget-num-input" data-level="' + level +
      '" data-cat="' + escAttr(catName) + '"' + (spIdx !== null ? ' data-sp="' + spIdx + '"' : "") +
      ' data-field="' + field + '" value="' + (num(value) || "") + '" placeholder="0">';
  }
  function numInput(cls, value, title) {
    return '<input type="number" step="0.01" class="' + cls + '" value="' + (num(value) || "") +
      '" placeholder="0"' + (title ? ' title="' + escAttr(title) + '"' : "") + ">";
  }
  // Chaque colonne numérique (Budget/Prévisionnel/Réalisé + les 3 badges %)
  // porte son propre petit titre juste au-dessus de la valeur — plus besoin
  // d'une légende à part en haut de l'arbre pour se souvenir de l'ordre.
  function numCell(label, innerHtml, extraClass) {
    return '<div class="budget-numcell' + (extraClass ? " " + extraClass : "") + '">' +
      '<span class="budget-numcell-label">' + escHtml(label) + "</span>" + innerHtml + "</div>";
  }
  function ratioBadges(ratios) {
    ratios = ratios || {};
    return numCell("Prévi/Budget", '<div class="budget-num budget-badge ' + pctClass(ratios.previ_budget) + '" title="Prévisionnel / Budget — part du budget déjà engagée">' + fmtPct(ratios.previ_budget) + "</div>") +
      numCell("Réal/Prévi", '<div class="budget-num budget-badge ' + pctClass(ratios.realise_previ) + '" title="Réalisé / Prévisionnel — part du prévisionnel déjà payée">' + fmtPct(ratios.realise_previ) + "</div>") +
      numCell("Réal/Budget", '<div class="budget-num budget-badge ' + pctClass(ratios.realise_budget) + '" title="Réalisé / Budget — part du budget déjà payée">' + fmtPct(ratios.realise_budget) + "</div>");
  }
  function escHtml(s) { return String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
  function escAttr(s) { return escHtml(s).replace(/"/g, "&quot;"); }

  function wireTreeEvents() {
    const contentEl = document.getElementById("budget-content");

    contentEl.querySelectorAll(".budget-num-input").forEach((inp) => {
      inp.addEventListener("change", () => {
        const level = inp.dataset.level, catName = inp.dataset.cat, field = inp.dataset.field;
        const cat = catByName(catName);
        if (!cat) return;
        if (level === "cat") {
          cat[field] = num(inp.value);
        } else {
          const sp = cat.sous_postes[parseInt(inp.dataset.sp, 10)];
          if (sp) sp[field] = num(inp.value);
        }
        markDirty();
      });
    });

    contentEl.querySelectorAll(".budget-dep").forEach((row) => {
      const catName = row.dataset.cat, spIdx = parseInt(row.dataset.sp, 10), depIdx = parseInt(row.dataset.dep, 10);
      const cat = catByName(catName);
      const dep = cat && cat.sous_postes[spIdx] && cat.sous_postes[spIdx].depenses[depIdx];
      if (!dep) return;
      row.querySelector('[data-field="label"]').addEventListener("change", (e) => { dep.label = e.target.value; dirty = true; });
      row.querySelector('[data-field="fournisseur"]').addEventListener("change", (e) => { dep.fournisseur = e.target.value; dirty = true; renderTree(); });
      const previInp = row.querySelector(".dep-previ");
      const realiseInp = row.querySelector(".dep-realise");
      if (previInp) previInp.addEventListener("change", (e) => { dep.previsionnel = num(e.target.value); markDirty(); });
      if (realiseInp) realiseInp.addEventListener("change", (e) => { dep.realise = num(e.target.value); markDirty(); });
    });

    contentEl.querySelectorAll(".budget-sp-simple .budget-dep-fourn").forEach((inp) => {
      inp.addEventListener("change", (e) => {
        const row = e.target.closest(".budget-sp-simple");
        const cat = catByName(row.dataset.cat);
        const sp = cat && cat.sous_postes[parseInt(row.dataset.sp, 10)];
        if (sp) { sp.fournisseur = e.target.value; dirty = true; }
      });
    });

    contentEl.querySelectorAll(".budget-add-sp-btn").forEach((btn) => {
      btn.addEventListener("click", () => openAddSpModal(btn.dataset.cat));
    });
    contentEl.querySelectorAll(".budget-sp-rename-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const spIdx = parseInt(btn.dataset.sp, 10);
        const cat = catByName(btn.dataset.cat);
        const sp = cat && cat.sous_postes[spIdx];
        if (!sp) return;
        openRenameModal("sp", sp.name, { catName: btn.dataset.cat, spIdx });
      });
    });
    contentEl.querySelectorAll(".budget-add-dep-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const cat = catByName(btn.dataset.cat);
        const sp = cat && cat.sous_postes[parseInt(btn.dataset.sp, 10)];
        if (!sp) return;
        sp.depenses = sp.depenses || [];
        sp.depenses.push({ label: "Dépense n°" + (sp.depenses.length + 1), fournisseur: "", previsionnel: 0, realise: 0 });
        markDirty();
      });
    });
    contentEl.querySelectorAll(".budget-del-sp-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (!window.confirm("Supprimer ce sous-poste et tout son contenu ?")) return;
        const cat = catByName(btn.dataset.cat);
        if (!cat) return;
        cat.sous_postes.splice(parseInt(btn.dataset.sp, 10), 1);
        markDirty();
      });
    });
    contentEl.querySelectorAll(".budget-del-dep-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const cat = catByName(btn.dataset.cat);
        const sp = cat && cat.sous_postes[parseInt(btn.dataset.sp, 10)];
        if (!sp) return;
        sp.depenses.splice(parseInt(btn.dataset.dep, 10), 1);
        markDirty();
      });
    });

    const saveBtn = document.getElementById("budget-save-btn");
    if (saveBtn) saveBtn.addEventListener("click", saveProject);
  }

  async function saveProject() {
    const saveBtn = document.getElementById("budget-save-btn");
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "💾 Enregistrement…"; }
    try {
      const payload = {
        file_name: currentArtist.fileName,
        artist: currentArtist.artist,
        project_label: currentProject,
        tree: { categories: currentTree.categories },
      };
      const resp = await callBudgetJSON(
        "/admin/budget/file/" + encodeURIComponent(currentArtist.fileId) + "/projects/" + encodeURIComponent(currentProject),
        "PUT", payload
      );
      currentTree = resp;
      dirty = false;
      renderTree();
      toast("Budget enregistré ✅", "ok");
    } catch (err) {
      toast(err.message || "Erreur lors de l'enregistrement.", "err");
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "💾 Enregistrer"; }
    }
  }

  /* ---------------------------- Modale générique : renommer ---------------------------- */
  // Réutilisée pour artiste / projet / sous-poste — évite 3 modales quasi
  // identiques. Artiste et projet renomment tout de suite côté serveur
  // (fichier/feuillet réel sur SharePoint) ; sous-poste ne fait qu'éditer
  // l'arbre local, comme les autres champs — sauvegardé au prochain "Enregistrer".
  let renameContext = null;
  const renameOverlay = document.getElementById("budget-rename-overlay");
  const RENAME_TITLES = { artist: "Renommer l'artiste", project: "Renommer le projet", sp: "Renommer le sous-poste" };

  function openRenameModal(type, currentName, extra) {
    renameContext = Object.assign({ type }, extra || {});
    document.getElementById("budget-rename-title").textContent = RENAME_TITLES[type] || "Renommer";
    document.getElementById("budget-rename-error").textContent = "";
    const input = document.getElementById("budget-rename-input");
    input.value = currentName || "";
    renameOverlay.classList.remove("hidden");
    input.focus();
    input.select();
  }
  document.getElementById("budget-rename-cancel").addEventListener("click", () => renameOverlay.classList.add("hidden"));
  document.getElementById("budget-rename-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!renameContext) return;
    const errEl = document.getElementById("budget-rename-error");
    errEl.textContent = "";
    const newName = document.getElementById("budget-rename-input").value.trim();
    if (!newName) { errEl.textContent = "Nom requis."; return; }
    const submitBtn = e.target.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
      if (renameContext.type === "artist") {
        const resp = await callBudgetJSON("/admin/budget/artist/" + encodeURIComponent(currentArtist.fileId) + "/rename", "PUT", { new_artist: newName });
        currentArtist.artist = resp.artist;
        currentArtist.fileName = resp.fileName;
        const idx = ARTISTS.findIndex((a) => a.fileId === currentArtist.fileId);
        if (idx !== -1) ARTISTS[idx] = currentArtist;
        renderArtistTabs();
        toast("Artiste renommé ✅", "ok");
      } else if (renameContext.type === "project") {
        const resp = await callBudgetJSON(
          "/admin/budget/file/" + encodeURIComponent(currentArtist.fileId) + "/projects/" + encodeURIComponent(currentProject) + "/rename",
          "PUT", { file_name: currentArtist.fileName, new_name: newName }
        );
        currentProjects = resp.projects || currentProjects;
        currentProject = newName;
        renderProjectTabs();
        toast("Projet renommé ✅", "ok");
      } else if (renameContext.type === "sp") {
        const cat = catByName(renameContext.catName);
        const sp = cat && cat.sous_postes[renameContext.spIdx];
        if (sp) {
          sp.name = newName;
          markDirty();
          toast("Sous-poste renommé — n'oublie pas d'enregistrer.", "ok");
        }
      }
      renameOverlay.classList.add("hidden");
    } catch (err) {
      errEl.textContent = err.message || "Erreur lors du renommage.";
    } finally {
      submitBtn.disabled = false;
    }
  });

  /* ---------------------------- Modale : ajouter un sous-poste ---------------------------- */
  const addSpOverlay = document.getElementById("budget-add-sp-overlay");
  const addSpPresetSelect = document.getElementById("budget-add-sp-preset");
  const addSpCustomWrap = document.getElementById("budget-add-sp-custom-wrap");
  const addSpCustomInput = document.getElementById("budget-add-sp-custom");

  function openAddSpModal(catName) {
    addSpCategory = catName;
    document.getElementById("budget-add-sp-cat").textContent = "Catégorie : " + catName;
    document.getElementById("budget-add-sp-error").textContent = "";
    const presets = CATEGORY_PRESETS[catName] || [];
    addSpPresetSelect.innerHTML = "";
    presets.forEach((p) => {
      const opt = document.createElement("option");
      opt.value = p; opt.textContent = p;
      addSpPresetSelect.appendChild(opt);
    });
    const customOpt = document.createElement("option");
    customOpt.value = "__custom__"; customOpt.textContent = "Autre (saisir un nom)";
    addSpPresetSelect.appendChild(customOpt);
    addSpPresetSelect.value = presets.length ? presets[0] : "__custom__";
    addSpCustomWrap.classList.toggle("hidden", addSpPresetSelect.value !== "__custom__");
    addSpCustomInput.value = "";
    addSpOverlay.classList.remove("hidden");
  }
  addSpPresetSelect.addEventListener("change", () => {
    addSpCustomWrap.classList.toggle("hidden", addSpPresetSelect.value !== "__custom__");
  });
  document.getElementById("budget-add-sp-cancel").addEventListener("click", () => addSpOverlay.classList.add("hidden"));
  document.getElementById("budget-add-sp-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const errEl = document.getElementById("budget-add-sp-error");
    const name = addSpPresetSelect.value === "__custom__" ? addSpCustomInput.value.trim() : addSpPresetSelect.value;
    if (!name) { errEl.textContent = "Nom requis."; return; }
    const cat = catByName(addSpCategory);
    if (!cat) return;
    cat.sous_postes = cat.sous_postes || [];
    const isSimple = SIMPLE_CATEGORIES.indexOf(addSpCategory) !== -1;
    if (isSimple) {
      cat.sous_postes.push({ name, type: "simple", fournisseur: "", budget: 0, previsionnel: 0, realise: 0 });
    } else {
      cat.sous_postes.push({
        name, type: "container", budget: 0,
        depenses: [{ label: "Dépense n°1", fournisseur: "", previsionnel: 0, realise: 0 }],
      });
    }
    addSpOverlay.classList.add("hidden");
    markDirty();
  });

  /* ---------------------------- Modale : nouvel artiste ---------------------------- */
  const newArtistOverlay = document.getElementById("budget-new-artist-overlay");
  document.getElementById("budget-new-artist-btn").addEventListener("click", () => {
    document.getElementById("budget-new-artist-form").reset();
    document.getElementById("budget-new-artist-error").textContent = "";
    newArtistOverlay.classList.remove("hidden");
  });
  document.getElementById("budget-new-artist-cancel").addEventListener("click", () => newArtistOverlay.classList.add("hidden"));
  document.getElementById("budget-new-artist-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = document.getElementById("budget-new-artist-error");
    errEl.textContent = "";
    const artist = document.getElementById("budget-new-artist-name").value.trim();
    const projectLabel = document.getElementById("budget-new-artist-project").value.trim();
    const submitBtn = e.target.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
      await callBudgetJSON("/admin/budget/new-artist", "POST", { artist, project_label: projectLabel });
      newArtistOverlay.classList.add("hidden");
      toast("Artiste « " + artist + " » créé ✅", "ok");
      budgetLoadedOnce = false;
      await loadArtists();
    } catch (err) {
      errEl.textContent = err.message || "Erreur lors de la création.";
    } finally {
      submitBtn.disabled = false;
    }
  });

  /* ---------------------------- Modale : nouveau projet ---------------------------- */
  const newProjectOverlay = document.getElementById("budget-new-project-overlay");
  document.getElementById("budget-new-project-btn").addEventListener("click", () => {
    if (!currentArtist) return;
    document.getElementById("budget-new-project-form").reset();
    document.getElementById("budget-new-project-error").textContent = "";
    newProjectOverlay.classList.remove("hidden");
  });
  document.getElementById("budget-new-project-cancel").addEventListener("click", () => newProjectOverlay.classList.add("hidden"));
  document.getElementById("budget-new-project-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = document.getElementById("budget-new-project-error");
    errEl.textContent = "";
    const projectLabel = document.getElementById("budget-new-project-name").value.trim();
    const submitBtn = e.target.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
      const resp = await callBudgetJSON(
        "/admin/budget/file/" + encodeURIComponent(currentArtist.fileId) + "/new-project",
        "POST", { file_name: currentArtist.fileName, artist: currentArtist.artist, project_label: projectLabel }
      );
      newProjectOverlay.classList.add("hidden");
      toast("Projet « " + projectLabel + " » créé ✅", "ok");
      currentProjects = resp.projects || currentProjects;
      renderProjectTabs();
      selectProject(projectLabel);
    } catch (err) {
      errEl.textContent = err.message || "Erreur lors de la création.";
    } finally {
      submitBtn.disabled = false;
    }
  });

  /* ---------------------------- Supprimer un projet ---------------------------- */
  document.getElementById("budget-delete-project-btn").addEventListener("click", async () => {
    if (!currentArtist || !currentProject) return;
    if (currentProjects.length <= 1) {
      toast("Impossible de supprimer le dernier projet d'un artiste.", "err");
      return;
    }
    if (!window.confirm("Supprimer le projet « " + currentProject + " » et tout son contenu ? Cette action est définitive.")) return;
    try {
      const resp = await callBudget(
        "/admin/budget/file/" + encodeURIComponent(currentArtist.fileId) +
        "/projects/" + encodeURIComponent(currentProject) +
        "?file_name=" + encodeURIComponent(currentArtist.fileName),
        { method: "DELETE" }
      );
      toast("Projet supprimé.", "ok");
      currentProjects = resp.projects || [];
      dirty = false;
      renderProjectTabs();
      if (currentProjects.length) selectProject(currentProjects[0]);
    } catch (err) {
      toast(err.message || "Erreur lors de la suppression.", "err");
    }
  });

  /* Avertir avant de quitter la page avec des modifs non enregistrées. */
  window.addEventListener("beforeunload", (e) => {
    if (dirty) { e.preventDefault(); e.returnValue = ""; }
  });
})();
