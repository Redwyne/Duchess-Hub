(function () {
  "use strict";

  // TODO Michel : remplacer par l'URL du backend une fois déployé sur Render
  // (endpoints attendus : POST {BASE}/jobs  →  {job_id}
  //                        GET  {BASE}/jobs/{job_id}  →  {step_*: bool, download_url, error_message})
  const BACKEND_BASE_URL = "https://REMPLACE-MOI.onrender.com";
  const POLL_INTERVAL_MS = 1500;
  const POLL_TIMEOUT_MS = 240000; // 4 min (transcription + rendu vidéo peut prendre du temps)

  // ---------------------------------------------------------------------
  // Refs
  // ---------------------------------------------------------------------
  const optionBtns = document.querySelectorAll("#srt-optionToggle .option-btn");
  const styleBlock = document.getElementById("srt-styleBlock");
  const dzLabel = document.getElementById("srt-dzLabel");
  const dropzone = document.getElementById("srt-dropzone");
  const fileInput = document.getElementById("srt-fileInput");
  const dzText = document.getElementById("srt-dzText");
  const dzFile = document.getElementById("srt-dzFile");

  const presetChips = document.querySelectorAll(".preset-chip");
  const fontSel = document.getElementById("srt-font");
  const sizeSlider = document.getElementById("srt-size");
  const sizeVal = document.getElementById("srt-sizeVal");
  const colorInput = document.getElementById("srt-color");
  const modeBtns = document.querySelectorAll("#srt-modeGroup .mode-btn");

  const previewPhone = document.getElementById("srt-previewPhone");
  const previewText = document.getElementById("srt-previewText");

  const form = document.getElementById("srt-genForm");
  const goBtn = document.getElementById("srt-go");
  const statusEl = document.getElementById("srt-status");
  const progressBox = document.getElementById("srt-progressBox");
  const progressFill = document.getElementById("srt-progressFill");
  const progressLabel = document.getElementById("srt-progressLabel");
  const progressPct = document.getElementById("srt-progressPct");
  const progressSteps = document.getElementById("srt-progressSteps");
  const resultsBox = document.getElementById("srt-resultsBox");
  const downloadLink = document.getElementById("srt-downloadLink");

  // ---------------------------------------------------------------------
  // Etat
  // ---------------------------------------------------------------------
  let currentOption = "file"; // "file" | "video"
  let selectedFile = null;

  const PRESETS = {
    "build-rond": { font: "'Poppins', sans-serif", weight: 800, size: 13, color: "#ffffff", mode: "build" },
    "replace-serif": { font: "'Playfair Display', serif", weight: 700, size: 15, color: "#e8e0d0", mode: "replace" },
    "phrase-plate": { font: "'Inter', sans-serif", weight: 600, size: 7, color: "#f3c6e0", mode: "full" },
  };

  const state = { mode: "replace" };

  // ---------------------------------------------------------------------
  // Option toggle (Fichier de sous-titres / Vidéo sous-titrée)
  // ---------------------------------------------------------------------
  function setOption(opt) {
    currentOption = opt;
    optionBtns.forEach((b) => b.classList.toggle("active", b.dataset.option === opt));
    styleBlock.style.display = opt === "video" ? "" : "none";
    if (opt === "video") {
      fileInput.setAttribute("accept", "video/*");
      dzLabel.textContent = "Fichier vidéo";
      dzText.textContent = "Glisse ta vidéo ici, ou clique pour choisir";
      goBtn.textContent = "Générer la vidéo sous-titrée";
    } else {
      fileInput.setAttribute("accept", "audio/*,video/*");
      dzLabel.textContent = "Fichier audio";
      dzText.textContent = "Glisse ton audio ici, ou clique pour choisir";
      goBtn.textContent = "Générer le .srt";
    }
  }
  optionBtns.forEach((btn) => btn.addEventListener("click", () => setOption(btn.dataset.option)));
  setOption("file");

  // ---------------------------------------------------------------------
  // Dropzone
  // ---------------------------------------------------------------------
  function pickFile(file) {
    if (!file) return;
    selectedFile = file;
    dzFile.textContent = file.name + " · " + (file.size / (1024 * 1024)).toFixed(1) + " Mo";
  }
  dropzone.addEventListener("click", () => fileInput.click());
  dropzone.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") fileInput.click(); });
  fileInput.addEventListener("change", () => pickFile(fileInput.files[0]));
  ["dragenter", "dragover"].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add("dragover"); })
  );
  ["dragleave", "drop"].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove("dragover"); })
  );
  dropzone.addEventListener("drop", (e) => {
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) pickFile(file);
  });

  // ---------------------------------------------------------------------
  // Préréglages + contrôles de style
  // ---------------------------------------------------------------------
  function markCustom() {
    presetChips.forEach((c) => c.classList.toggle("active", c.dataset.preset === "custom"));
  }

  function setMode(mode, silent) {
    state.mode = mode;
    modeBtns.forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
    if (!silent) markCustom();
    restartPreviewAnim();
  }

  function selectedFontWeight() {
    const opt = fontSel.options[fontSel.selectedIndex];
    return (opt && opt.dataset.weight) || "700";
  }

  function applyPreset(key) {
    presetChips.forEach((c) => c.classList.toggle("active", c.dataset.preset === key));
    if (key === "custom") return;
    const p = PRESETS[key];
    fontSel.value = p.font;
    sizeSlider.value = p.size;
    sizeVal.textContent = p.size + "%";
    colorInput.value = p.color;
    setMode(p.mode, true);
    updatePreviewStyle();
  }

  presetChips.forEach((chip) => chip.addEventListener("click", () => applyPreset(chip.dataset.preset)));
  modeBtns.forEach((btn) => btn.addEventListener("click", () => setMode(btn.dataset.mode, false)));

  fontSel.addEventListener("change", () => { markCustom(); updatePreviewStyle(); });
  sizeSlider.addEventListener("input", () => {
    sizeVal.textContent = sizeSlider.value + "%";
    markCustom();
    updatePreviewStyle();
  });
  colorInput.addEventListener("input", () => { markCustom(); updatePreviewStyle(); });

  // ---------------------------------------------------------------------
  // Aperçu texte en direct (proxy en attendant le vrai moteur de rendu)
  // ---------------------------------------------------------------------
  const SAMPLE_BUILD_STEPS = ["IL", "IL REMET", "IL REMET\nRENDEZ-VOUS", "À", "À DEMAIN"];
  const SAMPLE_REPLACE_WORDS = ["IL", "REMET", "RENDEZ-VOUS", "À", "DEMAIN"];
  const SAMPLE_FULL_TEXT = "Il remet\nrendez-vous\nà demain";

  let previewTimer = null;

  function updatePreviewStyle() {
    previewText.style.fontFamily = fontSel.value;
    previewText.style.fontWeight = selectedFontWeight();
    previewText.style.color = colorInput.value;
    const px = Math.round((previewPhone.clientHeight || 320) * (parseInt(sizeSlider.value, 10) / 100));
    previewText.style.fontSize = px + "px";
  }

  function restartPreviewAnim() {
    if (previewTimer) { clearInterval(previewTimer); previewTimer = null; }
    updatePreviewStyle();

    if (state.mode === "full") {
      previewText.textContent = SAMPLE_FULL_TEXT;
      return;
    }

    const seq = state.mode === "build" ? SAMPLE_BUILD_STEPS : SAMPLE_REPLACE_WORDS;
    let i = 0;
    previewText.textContent = seq[0];
    previewTimer = setInterval(() => {
      i = (i + 1) % seq.length;
      previewText.textContent = seq[i];
    }, 850);
  }

  window.addEventListener("resize", updatePreviewStyle);
  restartPreviewAnim();

  // ---------------------------------------------------------------------
  // Envoi + polling (même logique que les autres onglets du hub)
  // ---------------------------------------------------------------------
  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  const FILE_STEPS = [
    { key: "step_received", label: "Fichier reçu" },
    { key: "step_lyrics", label: "Paroles timées" },
    { key: "step_srt", label: ".srt généré" },
  ];
  const VIDEO_STEPS = [
    { key: "step_received", label: "Fichier reçu" },
    { key: "step_lyrics", label: "Paroles timées" },
    { key: "step_ass", label: "Style appliqué" },
    { key: "step_render", label: "Vidéo rendue" },
  ];

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

  let pollTimer = null;
  let pollDeadline = 0;
  function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  function pollStatus(jobId, steps) {
    pollDeadline = Date.now() + POLL_TIMEOUT_MS;
    pollTimer = setInterval(async () => {
      if (Date.now() > pollDeadline) {
        stopPolling();
        progressLabel.textContent = "Ça prend plus de temps que prévu.";
        progressLabel.style.color = "var(--warn)";
        return;
      }
      try {
        const res = await fetch(BACKEND_BASE_URL + "/jobs/" + jobId);
        const data = await res.json();

        if (data.error_message) {
          stopPolling();
          progressLabel.textContent = "Erreur : " + data.error_message;
          progressLabel.style.color = "var(--err)";
          return;
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
          if (data.download_url) {
            downloadLink.href = data.download_url;
            resultsBox.classList.add("show");
          }
        }
      } catch (e) {
        // hoquet réseau — on retente au prochain tick
      }
    }, POLL_INTERVAL_MS);
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    statusEl.className = "status";
    statusEl.textContent = "";

    if (!selectedFile) {
      statusEl.className = "status err";
      statusEl.textContent = "Choisis d'abord un fichier.";
      return;
    }

    if (BACKEND_BASE_URL.indexOf("REMPLACE-MOI") !== -1) {
      statusEl.className = "status err";
      statusEl.textContent = "Backend pas encore branché — cette partie sera active dès que le service de rendu est déployé.";
      return;
    }

    const jobId = uuid();
    const fd = new FormData();
    fd.append("job_id", jobId);
    fd.append("option", currentOption);
    fd.append("artiste", document.getElementById("srt-artiste").value.trim());
    fd.append("titre", document.getElementById("srt-titre").value.trim());
    fd.append("file", selectedFile);
    if (currentOption === "video") {
      fd.append("font", fontSel.value);
      fd.append("font_weight", selectedFontWeight());
      fd.append("size_pct", sizeSlider.value);
      fd.append("color", colorInput.value);
      fd.append("mode", state.mode);
    }

    goBtn.disabled = true;
    resultsBox.classList.remove("show");
    const steps = currentOption === "video" ? VIDEO_STEPS : FILE_STEPS;
    progressBox.classList.add("show");
    renderSteps(steps, {});
    setProgress(0, true);
    progressLabel.textContent = "Envoi en cours…";
    progressLabel.style.color = "var(--muted)";

    try {
      await fetch(BACKEND_BASE_URL + "/jobs", { method: "POST", body: fd });
      statusEl.className = "status ok";
      statusEl.textContent = "Envoyé ✓";
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
