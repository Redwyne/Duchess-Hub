(function () {
  "use strict";

  // Champs mutualisés entre les onglets : chaque groupe liste tous les ids
  // d'input/textarea qui représentent la même donnée sur des onglets différents.
  // Taper dans l'un remplit les autres en direct et sauvegarde la valeur en
  // local, pour qu'elle reste présente si on change d'onglet ou qu'on revient
  // plus tard sur le site.
  const FIELD_GROUPS = {
    artiste: ["artiste", "tt-artiste", "stats-artiste", "srt-artiste", "strategie-artiste"],
    titre: ["titre", "tt-single", "stats-titre", "srt-titre", "strategie-titre"],
    theme: ["theme", "tt-intention"],
    // Pas de saisie manuelle pour "paroles" côté TikTok : ce champ n'est
    // rempli que via window.DuchessShared.set("paroles", ...) une fois les
    // paroles récupérées automatiquement depuis Flowstage (voir tiktok.js).
    paroles: ["paroles"],
  };

  const STORAGE_KEY = "duchess-hub-shared-fields-v1";

  function loadStore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }

  function saveStore(store) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch (e) {
      // stockage indisponible (mode privé, quota...) — on continue sans persister
    }
  }

  const store = loadStore();

  function propagate(groupKey, value, sourceId) {
    store[groupKey] = value;
    saveStore(store);
    (FIELD_GROUPS[groupKey] || []).forEach((id) => {
      if (id === sourceId) return;
      const el = document.getElementById(id);
      if (el && el.value !== value) el.value = value;
    });
  }

  // Au chargement : pré-remplit chaque champ présent sur la page avec la
  // dernière valeur connue, puis écoute les saisies pour propager en direct.
  Object.keys(FIELD_GROUPS).forEach((groupKey) => {
    const ids = FIELD_GROUPS[groupKey];
    const existing = store[groupKey] || "";
    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      if (existing && !el.value) el.value = existing;
      el.addEventListener("input", () => propagate(groupKey, el.value, id));
    });
  });

  // API publique : permet à un autre script (ex: tiktok.js, une fois les
  // paroles récupérées automatiquement via Flowstage) de pousser une valeur
  // dans les champs mutualisés sans attendre une saisie utilisateur.
  window.DuchessShared = {
    set: function (groupKey, value) {
      propagate(groupKey, value, null);
    },
    get: function (groupKey) {
      return store[groupKey] || "";
    },
  };
})();
