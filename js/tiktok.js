(function () {
  "use strict";

  const WEBHOOK_URL = "https://hook.eu1.make.com/ykvap20whfrgrshzi8gd1b9jecs3mw5p";
  const STATUS_URL = "https://hook.eu1.make.com/zc6em1f9y7lylnexnhkjsphjzx9p52i4";
  const POLL_INTERVAL_MS = 1200;
  const POLL_TIMEOUT_MS = 180000; // 3 min

  // ---- Mode buttons (Hooks / Vidéos / Légendes) ----
  const modeBtns = document.querySelectorAll(".mode-btn");
  const videosCountHint = document.getElementById("tt-videosCountHint");

  function updateCountsVisibility() {
    document.querySelectorAll(".count-item").forEach((item) => {
      const gen = item.dataset.countFor;
      const btn = document.querySelector('[data-gen="' + gen + '"]');
      const active = btn && btn.classList.contains("active");
      item.classList.toggle("show", !!active);
    });
    const videosActive = document.querySelector('[data-gen="videos"]').classList.contains("active");
    videosCountHint.classList.toggle("show", videosActive);
  }

  modeBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      btn.classList.toggle("active");
      updateCountsVisibility();
    });
  });
  document.getElementById("tt-selectAll").addEventListener("click", () => {
    const allActive = [...modeBtns].every((b) => b.classList.contains("active"));
    modeBtns.forEach((b) => b.classList.toggle("active", !allActive));
    updateCountsVisibility();
  });
  updateCountsVisibility();

  // ---- Count sliders (live value display) ----
  document.querySelectorAll(".vslider").forEach((slider) => {
    const out = document.getElementById(slider.id + "Val");
    if (!out) return;
    out.textContent = slider.value;
    slider.addEventListener("input", () => { out.textContent = slider.value; });
  });

  // ---- Language toggle ----
  const langBtns = document.querySelectorAll(".lang-btn");
  let selectedLang = "français";
  langBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      langBtns.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      selectedLang = btn.dataset.lang;
    });
  });

  const form = document.getElementById("tt-genForm");
  const statusEl = document.getElementById("tt-status");
  const goBtn = document.getElementById("tt-go");
  const progressBox = document.getElementById("tt-progressBox");
  const progressFill = document.getElementById("tt-progressFill");
  const progressLabel = document.getElementById("tt-progressLabel");
  const progressPct = document.getElementById("tt-progressPct");
  const progressSteps = document.getElementById("tt-progressSteps");

  let pollTimer = null;
  let pollDeadline = 0;
  let parolesInjected = false;

  function buildStepList(gen_videos, gen_hooks, gen_legendes) {
    const steps = [
      { key: "step_received", label: "Requête reçue" },
      { key: "step_aesthetic", label: "Aesthetic trouvée" },
      { key: "step_lyrics", label: "Paroles récupérées" },
      { key: "step_ai", label: "Génération IA" },
    ];
    if (gen_videos) steps.push({ key: "step_videos", label: "Vidéos ajoutées" });
    if (gen_hooks) steps.push({ key: "step_hooks", label: "Hooks injectés" });
    if (gen_legendes) steps.push({ key: "step_legendes", label: "Légendes enregistrées" });
    return steps;
  }

  function renderSteps(steps, data) {
    progressSteps.innerHTML = "";
    let doneCount = 0;
    steps.forEach((s) => { if (data && data[s.key] === true) doneCount++; });
    steps.forEach((s, i) => {
      const isDone = data && data[s.key] === true;
      const isActive = !isDone && i === doneCount;
      const div = document.createElement("div");
      div.className = "progress-step" + (isDone ? " done" : "") + (isActive ? " active" : "");
      div.innerHTML = '<span class="dot">' + (isDone ? "✓" : "") + "</span><span>" + s.label + "</span>";
      progressSteps.appendChild(div);
    });
    return doneCount;
  }

  function setProgress(pct, indeterminate) {
    progressFill.classList.toggle("indeterminate", !!indeterminate);
    if (!indeterminate) {
      progressFill.style.width = pct + "%";
      progressPct.textContent = pct + "%";
    } else {
      progressPct.textContent = "…";
    }
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function pollStatus(jobId, steps) {
    pollDeadline = Date.now() + POLL_TIMEOUT_MS;

    pollTimer = setInterval(async () => {
      if (Date.now() > pollDeadline) {
        stopPolling();
        progressLabel.textContent = "Ça prend plus de temps que prévu — vérifie le nom exact du single, ou regarde dans Make.";
        progressLabel.style.color = "var(--warn)";
        return;
      }
      try {
        const res = await fetch(STATUS_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ job_id: jobId }),
        });
        const data = await res.json();

        if (data.error_message) {
          stopPolling();
          progressLabel.textContent = "Erreur côté Make : " + data.error_message;
          progressLabel.style.color = "var(--err)";
          return;
        }

        const anySignal = steps.some((s) => data[s.key] === true);
        if (!anySignal) {
          setProgress(0, true);
          progressLabel.textContent = "Envoi en cours…";
          return;
        }

        // Dès que Flowstage a rendu les paroles, on les pousse dans le champ
        // mutualisé "paroles" (utilisé sur l'onglet Pitch) sans attendre la
        // fin complète de la génération.
        if (!parolesInjected && data.paroles && data.paroles.trim() && window.DuchessShared) {
          window.DuchessShared.set("paroles", data.paroles.trim());
          parolesInjected = true;
        }

        const doneCount = renderSteps(steps, data);
        const pct = Math.round((doneCount / steps.length) * 100);
        setProgress(pct, false);
        progressLabel.textContent = data.current_label || (doneCount === steps.length ? "Terminé ✓" : "Traitement en cours…");
        progressLabel.style.color = "var(--muted)";

        if (doneCount >= steps.length) {
          stopPolling();
          progressLabel.textContent = "Terminé ✓";
          progressLabel.style.color = "var(--ok)";
        }
      } catch (e) {
        // hoquet réseau pendant le polling — on retente au prochain tick
      }
    }, POLL_INTERVAL_MS);
  }

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const single = document.getElementById("tt-single").value.trim();
    const artiste = document.getElementById("tt-artiste").value.trim();
    const intention = document.getElementById("tt-intention").value.trim();
    const keywords = document.getElementById("tt-keywords").value.trim();

    const gen_hooks = document.querySelector('[data-gen="hooks"]').classList.contains("active");
    const gen_videos = document.querySelector('[data-gen="videos"]').classList.contains("active");
    const gen_legendes = document.querySelector('[data-gen="legendes"]').classList.contains("active");

    if (!gen_hooks && !gen_videos && !gen_legendes) {
      statusEl.className = "status err";
      statusEl.textContent = "Choisis au moins un type de génération.";
      return;
    }
    if (!single) {
      statusEl.className = "status err";
      statusEl.textContent = "Le nom du single est requis.";
      return;
    }

    function countOrDefault(id, fallback) {
      const v = parseInt(document.getElementById(id).value, 10);
      return Number.isFinite(v) && v > 0 ? v : fallback;
    }

    stopPolling();
    parolesInjected = false;
    const jobId = uuid();
    const payload = {
      job_id: jobId,
      single, artiste, intention, keywords,
      gen_hooks, gen_videos, gen_legendes,
      language: selectedLang,
      hooks_count: countOrDefault("tt-hooksCount", 50),
      legendes_count: countOrDefault("tt-legendesCount", 50),
      videos_count: countOrDefault("tt-videosCount", 3),
    };

    goBtn.disabled = true;
    statusEl.className = "status";
    statusEl.textContent = "";

    const steps = buildStepList(gen_videos, gen_hooks, gen_legendes);
    progressBox.classList.add("show");
    renderSteps(steps, {});
    setProgress(0, true);
    progressLabel.textContent = "Envoi en cours…";
    progressLabel.style.color = "var(--muted)";

    try {
      await fetch(WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      statusEl.className = "status ok";
      statusEl.textContent = "Envoyé à Make ✓";
      pollStatus(jobId, steps);
    } catch (err) {
      statusEl.className = "status err";
      statusEl.textContent = "Erreur d'envoi. Réessaie.";
      progressBox.classList.remove("show");
    } finally {
      goBtn.disabled = false;
    }
  });
})();
