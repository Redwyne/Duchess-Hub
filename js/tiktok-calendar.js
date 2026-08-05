(function () {
  "use strict";

  const CALENDAR_URL = "https://hook.eu1.make.com/opyj1xxoyx29qveqheqd43b8uv2j1jpq";

  // Ajoute ici chaque nouveau compte Publer. Plusieurs comptes peuvent partager
  // le même "group" (ex: 2e compte Urbain) -> ils apparaîtront sous le même onglet.
  const ACCOUNTS = [
    { id: "6a178ee08925afaf380b3cbb", group: "Variété 2 - Chanson Fr" },
    { id: "6a183a28e97c66d2da999924", group: "Variété 1 - Editmusique_FR" },
    { id: "6a5f43f9bb340b6c5b52a03f", group: "Urbain 1 - lignes2rap" },
    { id: "6a5f443ec4b0d00a311344e9", group: "Electro 1 - Sun and Bass" },
    { id: "6a5f4331bacba2a4f861b86c", group: "Indie" },
    { id: "6a632b2263f918a7418045d0", group: "Piano" },
  ];

  const STATE_LABELS = {
    scheduled: "Programmé",
    scheduled_approved: "Approuvé",
    scheduled_pending: "En attente",
    scheduled_declined: "Refusé",
    scheduled_reauth: "Reconnexion requise",
    scheduled_locked: "Verrouillé",
    published: "Publié",
    published_posted: "Publié",
    failed: "Échec",
  };

  const tabsEl = document.getElementById("tt-calTabs");
  const gridEl = document.getElementById("tt-calGrid");
  const monthLabelEl = document.getElementById("tt-calMonthLabel");
  const statusEl = document.getElementById("tt-calStatus");
  const prevBtn = document.getElementById("tt-calPrev");
  const nextBtn = document.getElementById("tt-calNext");

  if (!tabsEl || !gridEl) return; // section calendrier absente de cette page

  let allPosts = [];
  let activeGroup = null;
  let viewDate = new Date();
  viewDate.setDate(1);

  function groupForAccount(accountId) {
    const found = ACCOUNTS.find((a) => a.id === accountId);
    return found ? found.group : "Autres";
  }

  function buildTabs() {
    const groups = [...new Set(ACCOUNTS.map((a) => a.group))];
    if (allPosts.some((p) => groupForAccount(p.account_id) === "Autres")) groups.push("Autres");

    tabsEl.innerHTML = "";
    if (!activeGroup || !groups.includes(activeGroup)) activeGroup = groups[0] || null;

    groups.forEach((g) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cal-tab" + (g === activeGroup ? " active" : "");
      btn.textContent = g;
      btn.addEventListener("click", () => {
        activeGroup = g;
        buildTabs();
        render();
      });
      tabsEl.appendChild(btn);
    });
  }

  function fetchPosts() {
    statusEl.textContent = "Chargement…";
    statusEl.className = "cal-status";
    fetch(CALENDAR_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
      .then((r) => r.json())
      .then((data) => {
        allPosts = (data && data.posts) || [];
        buildTabs();
        render();
        statusEl.textContent = allPosts.length ? "" : "Aucun post programmé pour le moment.";
        statusEl.className = "cal-status";
      })
      .catch(() => {
        statusEl.textContent = "Impossible de charger le calendrier pour l'instant.";
        statusEl.className = "cal-status err";
      });
  }

  function formatMonthLabel(d) {
    return d.toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
  }

  function render() {
    monthLabelEl.textContent = formatMonthLabel(viewDate);

    const year = viewDate.getFullYear();
    const month = viewDate.getMonth();
    const firstDay = new Date(year, month, 1);
    const startOffset = (firstDay.getDay() + 6) % 7; // lundi = 0
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    const postsByDay = {};
    allPosts
      .filter((p) => groupForAccount(p.account_id) === activeGroup)
      .forEach((p) => {
        if (!p.scheduled_at) return;
        const d = new Date(p.scheduled_at);
        if (isNaN(d) || d.getFullYear() !== year || d.getMonth() !== month) return;
        const day = d.getDate();
        (postsByDay[day] = postsByDay[day] || []).push({ post: p, date: d });
      });

    gridEl.innerHTML = "";

    for (let i = 0; i < startOffset; i++) {
      const cell = document.createElement("div");
      cell.className = "cal-cell empty";
      gridEl.appendChild(cell);
    }

    const today = new Date();
    for (let day = 1; day <= daysInMonth; day++) {
      const cell = document.createElement("div");
      const isToday =
        today.getFullYear() === year && today.getMonth() === month && today.getDate() === day;
      cell.className = "cal-cell" + (isToday ? " today" : "");

      const num = document.createElement("div");
      num.className = "cal-daynum";
      num.textContent = day;
      cell.appendChild(num);

      const entries = (postsByDay[day] || []).sort((a, b) => a.date - b.date);
      entries.forEach(({ post, date }) => {
        const chip = document.createElement("div");
        chip.className = "cal-post state-" + String(post.state || "").replace(/[^a-z_]/g, "");

        const timeEl = document.createElement("span");
        timeEl.className = "cal-post-time";
        timeEl.textContent = date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });

        const textEl = document.createElement("span");
        textEl.className = "cal-post-text";
        textEl.textContent = (post.text || "(sans légende)").slice(0, 60);

        const stateEl = document.createElement("span");
        stateEl.className = "cal-post-state";
        stateEl.textContent = STATE_LABELS[post.state] || post.state || "";

        chip.appendChild(timeEl);
        chip.appendChild(textEl);
        chip.appendChild(stateEl);

        if (post.post_link) {
          chip.style.cursor = "pointer";
          chip.title = "Voir le post publié";
          chip.addEventListener("click", () => window.open(post.post_link, "_blank", "noopener"));
        }

        cell.appendChild(chip);
      });

      gridEl.appendChild(cell);
    }
  }

  prevBtn.addEventListener("click", () => {
    viewDate.setMonth(viewDate.getMonth() - 1);
    render();
  });
  nextBtn.addEventListener("click", () => {
    viewDate.setMonth(viewDate.getMonth() + 1);
    render();
  });

  fetchPosts();
})();
