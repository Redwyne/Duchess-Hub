(function () {
  "use strict";

  const tabBtns = document.querySelectorAll(".tab-btn");
  const panels = document.querySelectorAll(".tab-panel");
  const body = document.body;

  // Sécurité : l'onglet "admin" n'est jamais piloté par l'URL. Ni au
  // chargement (#admin dans un lien ignoré), ni une fois ouvert (pas de
  // "#admin" écrit dans la barre d'adresse) — la seule porte d'entrée est le
  // clic sur le bouton pendant la session en cours (voir js/admin.js).
  function activate(tabId) {
    tabBtns.forEach((b) => b.classList.toggle("active", b.dataset.tabTarget === tabId));
    panels.forEach((p) => p.classList.toggle("active", p.id === "tab-" + tabId));
    body.setAttribute("data-tab", tabId);
    window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
    try {
      if (tabId === "admin") {
        history.replaceState(null, "", location.pathname + location.search);
      } else {
        history.replaceState(null, "", "#" + tabId);
      }
    } catch (e) {}
  }

  tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => activate(btn.dataset.tabTarget));
  });

  const fromHash = (location.hash || "").replace("#", "");
  const initial = (fromHash !== "admin" && [...tabBtns].some((b) => b.dataset.tabTarget === fromHash)) ? fromHash : "pitch";
  activate(initial);
})();
