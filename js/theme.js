(function () {
  "use strict";

  var STORAGE_KEY = "duchess-hub-theme";
  var root = document.documentElement;
  var btn = document.getElementById("theme-toggle");

  function apply(theme) {
    root.setAttribute("data-theme", theme);
    try { localStorage.setItem(STORAGE_KEY, theme); } catch (e) {}
  }

  if (btn) {
    btn.addEventListener("click", function () {
      var current = root.getAttribute("data-theme") === "light" ? "light" : "dark";
      apply(current === "light" ? "dark" : "light");
    });
  }
})();
