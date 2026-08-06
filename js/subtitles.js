(function () {
  "use strict";

  const BACKEND_BASE_URL = "https://duchess-hub.onrender.com";
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
  const caseSel = document.getElementById("srt-case");
  const positionSel = document.getElementById("srt-position");
  const effectSel = document.getElementById("srt-effect");
  const fondSel = document.getElementById("srt-fond");
  const outlineColorInput = document.getElementById("srt-outlineColor");
  const outlineWidthSel = document.getElementById("srt-outlineWidth");
  const outlineLabel = document.getElementById("srt-outlineLabel");
  const accentField = document.getElementById("srt-accentField");
  const accentColorInput = document.getElementById("srt-accentColor");
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
    "build-rond": {
      font: "'Poppins', sans-serif", weight: 800, size: 13, color: "#ffffff", mode: "build",
      position: "centre", effect: "pop", fond: "contour", outlineColor: "#000000", outlineWidth: "normal", textCase: "majuscule",
    },
    "replace-serif": {
      font: "'Playfair Display', serif", weight: 700, size: 15, color: "#e8e0d0", mode: "replace",
      position: "centre", effect: "fade", fond: "contour", outlineColor: "#000000", outlineWidth: "fin", textCase: "majuscule",
    },
    "phrase-plate": {
      font: "'Inter', sans-serif", weight: 600, size: 7, color: "#f3c6e0", mode: "full",
      position: "bas", effect: "fade", fond: "plaque", outlineColor: "#1a1a22", outlineWidth: "normal", textCase: "normal",
    },
    "karaoke-punch": {
      font: "'Anton', sans-serif", weight: 400, size: 11, color: "#ffffff", mode: "karaoke",
      position: "bas", effect: "pop", fond: "contour", outlineColor: "#000000", outlineWidth: "epais", textCase: "majuscule",
      accentColor: "#ffd400",
    },
    "manuscrite-pile": {
      font: "'Caveat', cursive", weight: 700, size: 10, color: "#ffe8b0", mode: "stack",
      position: "centre", effect: "fade", fond: "aucun", outlineColor: "#000000", outlineWidth: "aucun", textCase: "normal",
    },
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

  function updateOutlineLabel() {
    outlineLabel.textContent = fondSel.value === "plaque" ? "Couleur de la plaque" : "Couleur du contour";
  }

  function setMode(mode, silent) {
    state.mode = mode;
    modeBtns.forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
    accentField.style.display = mode === "karaoke" ? "" : "none";
    if (!silent) {
      markCustom();
      // Casse par défaut la plus lisible selon le mode : "normale" pour la phrase entière
      // (façon sous-titre classique), MAJUSCULES pour les modes punchy mot-à-mot.
      caseSel.value = mode === "full" ? "normal" : "majuscule";
    }
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
    positionSel.value = p.position || "centre";
    effectSel.value = p.effect || "none";
    fondSel.value = p.fond || "contour";
    outlineColorInput.value = p.outlineColor || "#000000";
    outlineWidthSel.value = p.outlineWidth || "normal";
    caseSel.value = p.textCase || "majuscule";
    accentColorInput.value = p.accentColor || "#ffd400";
    updateOutlineLabel();
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
  caseSel.addEventListener("change", () => { markCustom(); restartPreviewAnim(); });
  positionSel.addEventListener("change", () => { markCustom(); updatePreviewStyle(); });
  effectSel.addEventListener("change", () => { markCustom(); restartPreviewAnim(); });
  fondSel.addEventListener("change", () => { markCustom(); updateOutlineLabel(); updatePreviewStyle(); });
  outlineColorInput.addEventListener("input", () => { markCustom(); updatePreviewStyle(); });
  outlineWidthSel.addEventListener("change", () => { markCustom(); updatePreviewStyle(); });
  accentColorInput.addEventListener("input", () => { markCustom(); restartPreviewAnim(); });
  updateOutlineLabel();

  // ---------------------------------------------------------------------
  // Aperçu texte en direct (proxy en attendant le vrai moteur de rendu vidéo)
  // — reproduit fidèlement la logique du backend (build_ass) : mêmes découpages
  // par mode, même auto-fit anti-débordement, même surlignage karaoké.
  // ---------------------------------------------------------------------
  const PREVIEW_WORDS = ["Il", "remet", "rendez-vous", "à", "demain", "transcription", "automatique"];

  let previewTimer = null;
  let currentFrames = [];
  let currentFrameIdx = 0;

  function applyCase(s) {
    return caseSel.value === "majuscule" ? s.toUpperCase() : s;
  }

  function wrapBuildLine(group) {
    const text = group.join(" ");
    const parts = text.split(" ");
    if (parts.length <= 2) return [text];
    const mid = Math.ceil(parts.length / 2);
    return [parts.slice(0, mid).join(" "), parts.slice(mid).join(" ")];
  }

  function buildPreviewFrames(mode) {
    const W = PREVIEW_WORDS;
    const frames = [];

    if (mode === "full") {
      return [{ lines: ["Il remet rendez-vous", "à demain"], active: -1 }];
    }

    if (mode === "replace") {
      W.forEach((w) => frames.push({ lines: [w], active: -1 }));
      return frames;
    }

    if (mode === "build") {
      let group = [];
      W.forEach((w) => {
        group.push(w);
        frames.push({ lines: wrapBuildLine(group), active: -1 });
        if (group.length >= 3) group = [];
      });
      return frames;
    }

    if (mode === "build_vertical") {
      let group = [];
      W.forEach((w) => {
        group.push(w);
        frames.push({ lines: group.slice(), active: -1 });
        if (group.length >= 3) group = [];
      });
      return frames;
    }

    if (mode === "stack") {
      const chunks = [];
      for (let i = 0; i < W.length; i += 2) chunks.push(W.slice(i, i + 2).join(" "));
      let win = [];
      chunks.forEach((c) => {
        win.push(c);
        if (win.length > 3) win.shift();
        frames.push({ lines: win.slice(), active: -1 });
      });
      return frames;
    }

    if (mode === "karaoke") {
      for (let g = 0; g < W.length; g += 5) {
        const group = W.slice(g, g + 5);
        group.forEach((_, i) => frames.push({ lines: [group.join(" ")], active: i, groupWords: group }));
      }
      return frames;
    }

    return [{ lines: [W[0]], active: -1 }];
  }

  function fitPreviewFontSize(lines, basePx) {
    const longest = Math.max(0, ...lines.map((l) => l.length));
    if (!longest) return basePx;
    const availPx = Math.max(40, (previewPhone.clientWidth || 190) - 28);
    const ratio = 0.58; // heuristique générique, même esprit que FONT_META côté backend
    const estWidth = longest * basePx * ratio;
    if (estWidth <= availPx) return basePx;
    return Math.max(basePx * 0.4, availPx / (longest * ratio));
  }

  function renderFrame(frame) {
    if (!frame) return;
    const lines = frame.lines.map(applyCase);
    const basePx = Math.round((previewPhone.clientHeight || 320) * (parseInt(sizeSlider.value, 10) / 100));
    const px = Math.round(fitPreviewFontSize(lines, basePx));
    previewText.style.fontSize = px + "px";

    if (frame.active >= 0 && frame.groupWords) {
      const parts = frame.groupWords.map((w, i) => {
        const t = applyCase(w);
        return i === frame.active ? '<span style="color:' + accentColorInput.value + '">' + t + "</span>" : t;
      });
      previewText.innerHTML = parts.join(" ");
    } else {
      previewText.textContent = lines.join("\n");
    }
  }

  function applyPreviewEffect() {
    previewText.classList.remove("anim-fade", "anim-pop", "anim-slide");
    void previewText.offsetWidth; // force le reflow pour rejouer l'animation à chaque frame
    const eff = effectSel.value;
    if (eff === "fade") previewText.classList.add("anim-fade");
    else if (eff === "pop") previewText.classList.add("anim-pop");
    else if (eff === "slide") previewText.classList.add("anim-slide");
  }

  function updatePreviewStyle() {
    previewText.style.fontFamily = fontSel.value;
    previewText.style.fontWeight = selectedFontWeight();
    previewText.style.color = colorInput.value;

    const posMap = { haut: "flex-start", centre: "center", bas: "flex-end" };
    previewPhone.style.alignItems = posMap[positionSel.value] || "center";

    const fond = fondSel.value;
    if (fond === "plaque") {
      previewText.style.background = outlineColorInput.value;
      previewText.style.padding = "6px 12px";
      previewText.style.borderRadius = "6px";
      previewText.style.webkitTextStroke = "0px";
      previewText.style.textShadow = "none";
    } else if (fond === "aucun") {
      previewText.style.background = "transparent";
      previewText.style.padding = "0";
      previewText.style.webkitTextStroke = "0px";
      previewText.style.textShadow = "none";
    } else {
      const widthPx = { fin: "0.5px", normal: "1px", epais: "2px", aucun: "0px" }[outlineWidthSel.value] || "1px";
      previewText.style.background = "transparent";
      previewText.style.padding = "0";
      previewText.style.webkitTextStroke = widthPx + " " + outlineColorInput.value;
      previewText.style.textShadow = "0 2px 10px rgba(0,0,0,.5), 0 0 1px rgba(0,0,0,.8)";
    }

    if (currentFrames.length) renderFrame(currentFrames[currentFrameIdx]);
  }

  function restartPreviewAnim() {
    if (previewTimer) { clearInterval(previewTimer); previewTimer = null; }
    updatePreviewStyle();

    currentFrames = buildPreviewFrames(state.mode);
    currentFrameIdx = 0;
    applyPreviewEffect();
    renderFrame(currentFrames[0]);

    if (currentFrames.length <= 1) return;
    previewTimer = setInterval(() => {
      currentFrameIdx = (currentFrameIdx + 1) % currentFrames.length;
      applyPreviewEffect();
      renderFrame(currentFrames[currentFrameIdx]);
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
    // SQLite stocke ces colonnes en INTEGER (0/1), pas en booléen — le JSON renvoyé par le
    // backend porte donc des nombres, pas des `true`/`false`. Une comparaison stricte à `true`
    // ne matchait jamais (1 === true est faux en JS), ce qui bloquait la barre à 0% et
    // empêchait le bloc résultat/téléchargement de s'afficher même quand le job était fini.
    steps.forEach((s) => { if (data && !!data[s.key]) doneCount++; });
    steps.forEach((s, i) => {
      const isDone = data && !!data[s.key];
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
    // Toujours couper un éventuel sondage précédent avant d'en démarrer un nouveau — sinon,
    // en cas de double soumission (ex: on relance avant que le job précédent soit fini), les
    // deux minuteurs tournent en parallèle et se marchent dessus sur les mêmes éléments du DOM
    // (ex: le label affiche "Terminé" d'un ancien job pendant que la barre reste à 0%).
    stopPolling();
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
    stopPolling(); // coupe tout sondage résiduel d'une soumission précédente avant de repartir
    statusEl.className = "status";
    statusEl.textContent = "";

    if (!selectedFile) {
      statusEl.className = "status err";
      statusEl.textContent = "Choisis d'abord un fichier.";
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
      fd.append("position", positionSel.value);
      fd.append("effect", effectSel.value);
      fd.append("outline_color", outlineColorInput.value);
      fd.append("outline_width", outlineWidthSel.value);
      fd.append("fond", fondSel.value);
      fd.append("text_case", caseSel.value);
      fd.append("accent_color", accentColorInput.value);
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
