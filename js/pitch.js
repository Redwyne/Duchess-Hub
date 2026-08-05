(function () {
  "use strict";

  const GENERATE_URL = "https://hook.eu1.make.com/ca54s27v5u4a3pqmj8uptb7r3crcuy95";
  const STATUS_URL = "https://hook.eu1.make.com/1ep6ypabdojakpt8ussr1aquuqglmqt8";
  const FEEDBACK_URL = "https://hook.eu1.make.com/awkf7bsbp7e4gix5i8vsxiymrvq6pafq";
  const POLL_INTERVAL_MS = 1500;
  const POLL_TIMEOUT_MS = 120000; // 2 min

  const form = document.getElementById("genForm");
  const statusEl = document.getElementById("status");
  const goBtn = document.getElementById("go");
  const progressBox = document.getElementById("progressBox");
  const progressFill = document.getElementById("progressFill");
  const progressLabel = document.getElementById("progressLabel");
  const progressPct = document.getElementById("progressPct");
  const progressSteps = document.getElementById("progressSteps");
  const resultsBox = document.getElementById("resultsBox");
  const resultsGrid = document.getElementById("resultsGrid");
  const feedbackStatus = document.getElementById("feedbackStatus");
  const sendFeedbackBtn = document.getElementById("sendFeedback");
  const regenBtn = document.getElementById("regenWithFeedback");
  const retourText = document.getElementById("retourText");
  const newPitchBtn = document.getElementById("newPitch");

  let pollTimer = null;
  let pollDeadline = 0;
  let currentJobId = null;
  let preferredKey = null;
  let lastPayload = null;

  const STEPS = [
    { key: "step_received", label: "Requête reçue" },
    { key: "step_context", label: "Contexte récupéré" },
    { key: "step_ai", label: "Pitch généré" },
  ];

  const CARD_DEFS = [
    { key: "pitch_1", label: "Angle 1", long: false },
    { key: "pitch_2", label: "Angle 2", long: false },
    { key: "pitch_3", label: "Angle 3", long: false },
    { key: "pitch_long", label: "Version longue", long: true },
  ];

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function renderSteps(data) {
    progressSteps.innerHTML = "";
    let doneCount = 0;
    STEPS.forEach((s) => { if (data && data[s.key] === true) doneCount++; });
    STEPS.forEach((s, i) => {
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

  function pollStatus(jobId) {
    pollDeadline = Date.now() + POLL_TIMEOUT_MS;

    pollTimer = setInterval(async () => {
      if (Date.now() > pollDeadline) {
        stopPolling();
        progressLabel.textContent = "Ça prend plus de temps que prévu — réessaie dans un instant.";
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
          progressLabel.textContent = "Erreur : " + data.error_message;
          progressLabel.style.color = "var(--err)";
          return;
        }

        const doneCount = renderSteps(data);
        const pct = Math.round((doneCount / STEPS.length) * 100);
        setProgress(pct, false);
        progressLabel.textContent = data.current_label || (doneCount === STEPS.length ? "Terminé ✓" : "Traitement en cours…");
        progressLabel.style.color = "var(--muted)";

        if (data.status === "done") {
          stopPolling();
          progressLabel.textContent = "Terminé ✓";
          progressLabel.style.color = "var(--ok)";
          showResults(data);
        }
      } catch (e) {
        // hoquet réseau pendant le polling — on retente au prochain tick
      }
    }, POLL_INTERVAL_MS);
  }

  function charCountLabel(text, isLong) {
    const n = (text || "").length;
    if (isLong) return n + " caractères";
    const over = n > 500;
    return n + " / 500 caractères" + (over ? " ⚠️ trop long" : "");
  }

  function showResults(data) {
    resultsGrid.innerHTML = "";
    preferredKey = null;

    CARD_DEFS.forEach((def) => {
      const text = data[def.key] || "";
      const card = document.createElement("div");
      card.className = "pitch-card" + (def.long ? " long" : "");
      card.dataset.key = def.key;

      const head = document.createElement("div");
      head.className = "pitch-card-head";
      head.innerHTML =
        '<span class="pitch-card-label">' + def.label + '</span>' +
        '<span class="pitch-card-count">' + charCountLabel(text, def.long) + '</span>';

      const body = document.createElement("div");
      body.className = "pitch-card-text";
      body.textContent = text;

      const actions = document.createElement("div");
      actions.className = "pitch-card-actions";

      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "mini-btn";
      copyBtn.textContent = "Copier";
      copyBtn.addEventListener("click", () => {
        navigator.clipboard.writeText(text).then(() => {
          copyBtn.textContent = "Copié ✓";
          setTimeout(() => { copyBtn.textContent = "Copier"; }, 1500);
        });
      });

      const preferBtn = document.createElement("button");
      preferBtn.type = "button";
      preferBtn.className = "mini-btn";
      preferBtn.textContent = "Préférer";
      preferBtn.addEventListener("click", () => {
        preferredKey = def.key;
        document.querySelectorAll(".pitch-card").forEach((c) => c.classList.remove("preferred"));
        document.querySelectorAll(".mini-btn").forEach((b) => {
          if (b.textContent === "Préféré ✓") b.textContent = "Préférer";
          b.classList.remove("active");
        });
        card.classList.add("preferred");
        preferBtn.textContent = "Préféré ✓";
        preferBtn.classList.add("active");
      });

      actions.appendChild(copyBtn);
      actions.appendChild(preferBtn);

      card.appendChild(head);
      card.appendChild(body);
      card.appendChild(actions);
      resultsGrid.appendChild(card);
    });

    resultsBox.classList.add("show");
    feedbackStatus.className = "status";
    feedbackStatus.textContent = "";
    retourText.value = "";
    resultsBox.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function readFormPayload() {
    return {
      artiste: document.getElementById("artiste").value.trim(),
      titre: document.getElementById("titre").value.trim(),
      contexte: document.getElementById("contexte").value.trim(),
      infos: document.getElementById("infos").value.trim(),
      actu: document.getElementById("actu").value.trim(),
      chiffres: document.getElementById("chiffres").value.trim(),
      theme: document.getElementById("theme").value.trim(),
      angle: document.getElementById("angle").value.trim(),
      paroles: document.getElementById("paroles").value.trim(),
    };
  }

  async function startGeneration(basePayload, retourPrecedent) {
    stopPolling();
    resultsBox.classList.remove("show");
    const jobId = uuid();
    currentJobId = jobId;
    lastPayload = basePayload;
    const payload = Object.assign(
      { job_id: jobId, retour_precedent: retourPrecedent || "" },
      basePayload
    );

    statusEl.className = "status";
    statusEl.textContent = "";

    progressBox.classList.add("show");
    renderSteps({});
    setProgress(0, true);
    progressLabel.textContent = "Envoi en cours…";
    progressLabel.style.color = "var(--muted)";
    progressBox.scrollIntoView({ behavior: "smooth", block: "start" });

    try {
      await fetch(GENERATE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      statusEl.className = "status ok";
      statusEl.textContent = "Envoyé ✓";
      pollStatus(jobId);
      return true;
    } catch (err) {
      statusEl.className = "status err";
      statusEl.textContent = "Erreur d'envoi. Réessaie.";
      progressBox.classList.remove("show");
      return false;
    }
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const payload = readFormPayload();
    if (!payload.artiste || !payload.titre) {
      statusEl.className = "status err";
      statusEl.textContent = "Artiste et titre sont requis.";
      return;
    }

    goBtn.disabled = true;
    try {
      await startGeneration(payload, "");
    } finally {
      goBtn.disabled = false;
    }
  });

  sendFeedbackBtn.addEventListener("click", async () => {
    if (!currentJobId) return;
    const retour = retourText.value.trim();
    if (!retour && !preferredKey) {
      feedbackStatus.className = "status err";
      feedbackStatus.textContent = "Choisis un favori ou écris un retour avant d'envoyer.";
      return;
    }

    sendFeedbackBtn.disabled = true;
    feedbackStatus.className = "status";
    feedbackStatus.textContent = "Envoi…";

    try {
      await fetch(FEEDBACK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          job_id: currentJobId,
          pitch_choisi: preferredKey || "aucun",
          retour: retour,
        }),
      });
      feedbackStatus.className = "status ok";
      feedbackStatus.textContent = "Merci, c'est pris en compte pour les prochains pitchs ✓";
    } catch (err) {
      feedbackStatus.className = "status err";
      feedbackStatus.textContent = "Erreur d'envoi. Réessaie.";
    } finally {
      sendFeedbackBtn.disabled = false;
    }
  });

  regenBtn.addEventListener("click", async () => {
    if (!currentJobId || !lastPayload) return;
    const retour = retourText.value.trim();
    if (!retour) {
      feedbackStatus.className = "status err";
      feedbackStatus.textContent = "Écris un retour avant de régénérer.";
      return;
    }

    regenBtn.disabled = true;
    sendFeedbackBtn.disabled = true;
    feedbackStatus.className = "status";
    feedbackStatus.textContent = "Envoi du retour et relance de la génération…";

    try {
      await fetch(FEEDBACK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          job_id: currentJobId,
          pitch_choisi: preferredKey || "aucun",
          retour: retour,
        }),
      });
    } catch (err) {
      // le retour n'a pas pu être enregistré, on tente quand même la régénération
    }

    await startGeneration(lastPayload, retour);

    regenBtn.disabled = false;
    sendFeedbackBtn.disabled = false;
  });

  newPitchBtn.addEventListener("click", () => {
    resultsBox.classList.remove("show");
    progressBox.classList.remove("show");
    form.reset();
    currentJobId = null;
    preferredKey = null;
    lastPayload = null;
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
})();
