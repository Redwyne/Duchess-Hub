(function () {
  "use strict";

  const tabBtns = document.querySelectorAll(".tab-btn");
  const panels = document.querySelectorAll(".tab-panel");
  const body = document.body;

  function activate(tabId) {
    tabBtns.forEach((b) => b.classList.toggle("active", b.dataset.tabTarget === tabId));
    panels.forEach((p) => p.classList.toggle("active", p.id === "tab-" + tabId));
    body.setAttribute("data-tab", tabId);
    window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
    try { history.replaceState(null, "", "#" + tabId); } catch (e) {}
  }

  tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => activate(btn.dataset.tabTarget));
  });

  const fromHash = (location.hash || "").replace("#", "");
  const initial = [...tabBtns].some((b) => b.dataset.tabTarget === fromHash) ? fromHash : "pitch";
  activate(initial);
})();
