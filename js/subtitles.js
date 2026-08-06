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
  const italicToggle = document.getElementById("srt-italicToggle");
  const groupSizeSlider = document.getElementById("srt-groupSize");
  const groupSizeVal = document.getElementById("srt-groupSizeVal");
  const modeBtns = document.querySelectorAll("#srt-modeGroup .mode-btn");

  const previewPhone = document.getElementById("srt-previewPhone");
  const previewText = document.getElementById("srt-previewText");
  const previewVideo = document.getElementById("srt-previewVideo");
  const previewCaption = document.getElementById("srt-previewCaption");
  const artisteInput = document.getElementById("srt-artiste");
  const titreInput = document.getElementById("srt-titre");

  const verifyBlock = document.getElementById("srt-verifyBlock");
  const verifyHint = document.getElementById("srt-verifyHint");
  const verifyLoadbar = document.getElementById("srt-verifyLoadbar");
  const verifyPlayBtn = document.getElementById("srt-verifyPlay");
  const waveCanvas = document.getElementById("srt-waveCanvas");
  const verifyPlayhead = document.getElementById("srt-verifyPlayhead");
  const verifyTime = document.getElementById("srt-verifyTime");
  const bulkFrom = document.getElementById("srt-bulkFrom");
  const bulkTo = document.getElementById("srt-bulkTo");
  const bulkApplyBtn = document.getElementById("srt-bulkApply");
  const verifyWordsEl = document.getElementById("srt-verifyWords");
  const verifyTextCursor = document.getElementById("srt-verifyTextCursor");
  const verifyAddWordBtn = document.getElementById("srt-verifyAddWord");
  const verifyResetBtn = document.getElementById("srt-verifyReset");
  const verifyStatus = document.getElementById("srt-verifyStatus");
  const verifyAudio = document.getElementById("srt-verifyAudio");
  const referenceLyricsEl = document.getElementById("srt-referenceLyrics");

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
  const resultVideo = document.getElementById("srt-resultVideo");

  // ---------------------------------------------------------------------
  // Etat
  // ---------------------------------------------------------------------
  let currentOption = "file"; // "file" | "video"
  let selectedFile = null;

  // Aperçu vidéo live (§16) : pendant que l'utilisateur choisit son style, on rejoue LA vraie
  // vidéo choisie (lecture locale, aucun upload nécessaire pour ça) et on incruste les sous-titres
  // par-dessus en HTML/CSS, synchronisés sur le vrai timing des paroles récupéré via un job léger
  // "preview" (transcription seule, pas de rendu ffmpeg) — voir schedulePreviewJob().
  let previewObjectUrl = null;
  let realWords = null; // [{text, start, end}] une fois le job preview terminé
  let realCues = [];    // cues reconstruits à partir de realWords, selon le mode/groupSize courant
  let previewJobId = null;
  let previewPollTimer = null;
  let previewDebounceTimer = null;
  let lastRealCueIdx = -1;

  // Vérification/correction des paroles (nouvelle section, inspirée de l'éditeur "Word
  // timeline" Flowstage) : les mots viennent du MÊME job "preview" que l'aperçu vidéo live —
  // pas besoin d'un second aller-retour serveur. editedWords est la copie modifiable ; dès
  // qu'elle change, elle est répercutée sur realWords/realCues (aperçu vidéo à jour) et envoyée
  // au job final via le champ "edited_words" pour éviter de retranscrire.
  let editedWords = null;
  let originalRealWords = null;
  let dragFromIndex = null;
  let cachedAudioBuffer = null;

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
      if (selectedFile && selectedFile.type.startsWith("video/")) {
        if (!previewObjectUrl) previewObjectUrl = URL.createObjectURL(selectedFile);
        previewVideo.src = previewObjectUrl;
        previewVideo.classList.add("show");
        previewVideo.play().catch(() => {});
      }
    } else {
      fileInput.setAttribute("accept", "audio/*,video/*");
      dzLabel.textContent = "Fichier audio";
      dzText.textContent = "Glisse ton audio ici, ou clique pour choisir";
      goBtn.textContent = "Générer le .srt";
      previewVideo.classList.remove("show");
      previewVideo.pause();
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
    dropzone.classList.add("has-file"); // masque "glisse ton fichier ici" une fois un fichier choisi

    resetRealPreview();
    if (previewObjectUrl) { URL.revokeObjectURL(previewObjectUrl); previewObjectUrl = null; }
    cachedAudioBuffer = null;
    previewObjectUrl = URL.createObjectURL(file); // sert à l'aperçu vidéo ET au lecteur audio de vérification
    verifyAudio.src = previewObjectUrl;

    if (currentOption === "video" && file.type.startsWith("video/")) {
      previewVideo.src = previewObjectUrl;
      previewVideo.classList.add("show");
      previewVideo.play().catch(() => {});
      restartPreviewAnim(); // relance la démo texte le temps que le vrai timing arrive
    } else {
      previewVideo.classList.remove("show");
      previewVideo.pause();
      previewVideo.removeAttribute("src");
    }

    // La vérification des paroles (§ Vérifier les paroles) marche pour les deux options —
    // elle ne dépend pas d'avoir choisi "Vidéo sous-titrée".
    verifyBlock.style.display = "";
    verifyHint.textContent = "Analyse des paroles en cours…";
    verifyLoadbar.style.display = "";
    verifyWordsEl.innerHTML = "";
    drawWaveform();
    schedulePreviewJob();
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

  // Retente l'aperçu vidéo live si l'artiste/titre change après coup — ça peut débloquer un
  // matching Flowstage (paroles vérifiées) là où on n'avait au départ que la transcription auto.
  [artisteInput, titreInput].forEach((el) => {
    el.addEventListener("change", () => {
      if (currentOption === "video" && selectedFile && selectedFile.type.startsWith("video/")) {
        schedulePreviewJob();
      }
    });
  });

  // Si l'utilisateur colle/modifie les vraies paroles de référence après coup (une fois
  // l'aperçu déjà généré), on relance l'analyse pour que la correction Claude s'aligne dessus —
  // voir reference_lyrics côté backend (correct_lyrics_with_claude). "change" (perte de focus)
  // plutôt que "input" pour éviter de relancer un job à chaque frappe.
  referenceLyricsEl.addEventListener("change", () => {
    if (selectedFile) schedulePreviewJob();
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

  function setItalic(on) {
    italicToggle.setAttribute("aria-pressed", on ? "true" : "false");
  }
  function isItalic() {
    return italicToggle.getAttribute("aria-pressed") === "true";
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
    setItalic(!!p.italic);
    groupSizeSlider.value = p.groupSize || 3;
    groupSizeVal.textContent = groupSizeSlider.value;
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
  italicToggle.addEventListener("click", () => { setItalic(!isItalic()); markCustom(); updatePreviewStyle(); });
  groupSizeSlider.addEventListener("input", () => {
    groupSizeVal.textContent = groupSizeSlider.value;
    markCustom();
    restartPreviewAnim();
  });
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
    if (caseSel.value === "majuscule") return s.toUpperCase();
    if (caseSel.value === "capitalize") {
      return s.split(" ").map((w) =>
        w.split("-").map((p) => (p ? p[0].toUpperCase() + p.slice(1).toLowerCase() : p)).join("-")
      ).join(" ");
    }
    return s;
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
    const groupSize = Math.max(1, Math.min(8, parseInt(groupSizeSlider.value, 10) || 3));

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
        if (group.length >= groupSize) group = [];
      });
      return frames;
    }

    if (mode === "build_vertical") {
      let group = [];
      W.forEach((w) => {
        group.push(w);
        frames.push({ lines: group.slice(), active: -1 });
        if (group.length >= groupSize) group = [];
      });
      return frames;
    }

    if (mode === "stack") {
      const chunks = [];
      for (let i = 0; i < W.length; i += groupSize) chunks.push(W.slice(i, i + groupSize).join(" "));
      let win = [];
      chunks.forEach((c) => {
        win.push(c);
        if (win.length > 3) win.shift();
        frames.push({ lines: win.slice(), active: -1 });
      });
      return frames;
    }

    if (mode === "karaoke") {
      const kSize = Math.max(2, groupSize);
      for (let g = 0; g < W.length; g += kSize) {
        const group = W.slice(g, g + kSize);
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
    previewText.style.fontStyle = isItalic() ? "italic" : "normal";
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

    if (realWords && realWords.length && realCues.length) {
      renderFrame(realCues[lastRealCueIdx >= 0 ? lastRealCueIdx : 0]);
    } else if (currentFrames.length) {
      renderFrame(currentFrames[currentFrameIdx]);
    }
  }

  function restartPreviewAnim() {
    if (previewTimer) { clearInterval(previewTimer); previewTimer = null; }
    updatePreviewStyle();

    // Si le vrai timing (Flowstage ou transcription) est déjà là, on reste sur l'aperçu
    // synchronisé à la vraie vidéo (voir rebuildRealCues / la boucle realSyncTick) — pas
    // besoin de la démo texte qui cycle toute seule.
    if (realWords && realWords.length) {
      rebuildRealCues();
      lastRealCueIdx = -1; // force un ré-affichage immédiat au prochain tick
      return;
    }

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

  // ---------------------------------------------------------------------
  // Aperçu vidéo live avec le vrai timing (§16) — lit la vidéo choisie localement (pas
  // d'upload nécessaire pour ça) et synchronise les cues sur video.currentTime. Les cues sont
  // construits avec la même logique de regroupement que buildPreviewFrames, mais à partir des
  // vrais mots + timestamps renvoyés par un job "preview" (transcription seule, ou paroles
  // Flowstage si le single est reconnu — voir get_or_transcribe côté backend).
  // ---------------------------------------------------------------------
  function resetRealPreview() {
    realWords = null;
    realCues = [];
    lastRealCueIdx = -1;
    previewJobId = null;
    editedWords = null;
    originalRealWords = null;
    if (previewPollTimer) { clearInterval(previewPollTimer); previewPollTimer = null; }
    previewCaption.textContent = "Aperçu texte (pas encore le rendu vidéo réel)";
    verifyWordsEl.innerHTML = "";
    verifyStatus.textContent = "";
  }

  function schedulePreviewJob() {
    if (previewDebounceTimer) clearTimeout(previewDebounceTimer);
    previewDebounceTimer = setTimeout(startPreviewJob, 700);
  }

  async function startPreviewJob() {
    if (!selectedFile) return;
    resetRealPreview();
    previewCaption.textContent = "Analyse des paroles en cours…";
    verifyHint.textContent = "Analyse des paroles en cours…";
    verifyLoadbar.style.display = "";

    const jobId = uuid();
    previewJobId = jobId;
    const fd = new FormData();
    fd.append("job_id", jobId);
    fd.append("option", "preview");
    fd.append("artiste", artisteInput.value.trim());
    fd.append("titre", titreInput.value.trim());
    fd.append("reference_lyrics", referenceLyricsEl.value.trim());
    fd.append("file", selectedFile);

    try {
      await fetch(BACKEND_BASE_URL + "/jobs", { method: "POST", body: fd });
      if (jobId === previewJobId) pollPreviewJob(jobId);
    } catch (e) {
      if (jobId === previewJobId) previewCaption.textContent = "Aperçu texte (pas encore le rendu vidéo réel)";
    }
  }

  function pollPreviewJob(jobId) {
    if (previewPollTimer) clearInterval(previewPollTimer);
    const deadline = Date.now() + 90000; // 90s — transcription seule, doit être rapide
    previewPollTimer = setInterval(async () => {
      if (jobId !== previewJobId) { clearInterval(previewPollTimer); previewPollTimer = null; return; }
      if (Date.now() > deadline) {
        clearInterval(previewPollTimer);
        previewPollTimer = null;
        previewCaption.textContent = "Aperçu texte (analyse indisponible)";
        verifyHint.textContent = "Analyse indisponible — réessaie plus tard.";
        verifyLoadbar.style.display = "none";
        return;
      }
      try {
        const res = await fetch(BACKEND_BASE_URL + "/jobs/" + jobId);
        const data = await res.json();
        if (jobId !== previewJobId) { clearInterval(previewPollTimer); previewPollTimer = null; return; }
        if (data.error_message) {
          clearInterval(previewPollTimer);
          previewPollTimer = null;
          previewCaption.textContent = "Aperçu texte (analyse indisponible)";
          verifyHint.textContent = "Analyse indisponible : " + data.error_message;
          verifyLoadbar.style.display = "none";
          return;
        }
        if (data.words_json) {
          clearInterval(previewPollTimer);
          previewPollTimer = null;
          realWords = JSON.parse(data.words_json);
          if (previewTimer) { clearInterval(previewTimer); previewTimer = null; }
          previewCaption.textContent = "Aperçu vidéo — vrai timing des paroles";
          rebuildRealCues();
          lastRealCueIdx = -1;
          activateVerify(realWords, data.lyrics_source);
        }
      } catch (e) {
        // hoquet réseau — on retente au prochain tick
      }
    }, 1500);
  }

  function rebuildRealCues() {
    if (!realWords || !realWords.length) { realCues = []; return; }
    const mode = state.mode;
    const groupSize = Math.max(1, Math.min(8, parseInt(groupSizeSlider.value, 10) || 3));
    const W = realWords;
    const cues = [];

    if (mode === "full") {
      cues.push({
        lines: [W.map((w) => w.text).join(" ")],
        start: W[0].start, end: W[W.length - 1].end, active: -1,
      });
    } else if (mode === "replace") {
      W.forEach((w) => cues.push({ lines: [w.text], start: w.start, end: w.end, active: -1 }));
    } else if (mode === "build") {
      let group = [];
      let groupStartIdx = 0;
      W.forEach((w, i) => {
        if (group.length === 0) groupStartIdx = i;
        group.push(w.text);
        cues.push({ lines: wrapBuildLine(group), start: W[groupStartIdx].start, end: w.end, active: -1 });
        if (group.length >= groupSize) group = [];
      });
    } else if (mode === "build_vertical") {
      let group = [];
      let groupStartIdx = 0;
      W.forEach((w, i) => {
        if (group.length === 0) groupStartIdx = i;
        group.push(w.text);
        cues.push({ lines: group.slice(), start: W[groupStartIdx].start, end: w.end, active: -1 });
        if (group.length >= groupSize) group = [];
      });
    } else if (mode === "stack") {
      const chunks = [];
      for (let i = 0; i < W.length; i += groupSize) {
        const slice = W.slice(i, i + groupSize);
        chunks.push({ text: slice.map((w) => w.text).join(" "), start: slice[0].start, end: slice[slice.length - 1].end });
      }
      let win = [];
      chunks.forEach((c) => {
        win.push(c);
        if (win.length > 3) win.shift();
        cues.push({ lines: win.map((x) => x.text), start: c.start, end: c.end, active: -1 });
      });
    } else if (mode === "karaoke") {
      const kSize = Math.max(2, groupSize);
      for (let g = 0; g < W.length; g += kSize) {
        const group = W.slice(g, g + kSize);
        group.forEach((word, i) => {
          cues.push({
            lines: [group.map((w) => w.text).join(" ")],
            start: word.start, end: word.end, active: i,
            groupWords: group.map((w) => w.text),
          });
        });
      }
    }

    realCues = cues;
  }

  function findRealCueIndex(t) {
    // Les cues sont triées par start croissant (même ordre que les mots) — le sous-titre reste
    // affiché jusqu'au début du suivant (pas de trou visuel entre deux cues).
    for (let i = realCues.length - 1; i >= 0; i--) {
      if (t >= realCues[i].start) return i;
    }
    return -1;
  }

  function realSyncTick() {
    if (realCues.length && previewVideo.classList.contains("show")) {
      const t = previewVideo.currentTime || 0;
      const idx = findRealCueIndex(t);
      if (idx !== lastRealCueIdx) {
        lastRealCueIdx = idx;
        if (idx >= 0) {
          applyPreviewEffect();
          renderFrame(realCues[idx]);
        } else {
          previewText.textContent = "";
        }
      }
    }
    requestAnimationFrame(realSyncTick);
  }

  window.addEventListener("resize", updatePreviewStyle);
  restartPreviewAnim();
  requestAnimationFrame(realSyncTick);

  // ---------------------------------------------------------------------
  // Vérification / correction des paroles — inspiré de l'éditeur "Word timeline" Flowstage
  // (waveform + mots cliquables + drag-and-drop). Réutilise les mots du job "preview" ci-dessus
  // (mêmes realWords) : pas de second aller-retour serveur. Toute correction ici est répercutée
  // sur l'aperçu vidéo live (realWords/realCues) et envoyée telle quelle au job final
  // (edited_words) pour que le backend n'ait pas besoin de retranscrire.
  // ---------------------------------------------------------------------

  function formatTime(t) {
    t = Math.max(0, t || 0);
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return m + ":" + String(s).padStart(2, "0");
  }

  // Libellés lisibles pour lyrics_source (voir get_or_transcribe/process_job côté backend) —
  // permet de savoir d'un coup d'œil d'où viennent les paroles affichées, sans deviner.
  const LYRICS_SOURCE_LABELS = {
    flowstage: "📀 Paroles Flowstage (vérifiées manuellement)",
    audio_uploade: "🎙️ Transcription automatique (whisper)",
    audio_uploade_corrige_claude: "🎙️ Transcription automatique, corrigée par IA (Claude)",
    verifie_manuellement: "✏️ Tes corrections manuelles",
    cache: "💾 Déjà généré précédemment pour ce single",
  };

  function activateVerify(words, source) {
    originalRealWords = words.map((w) => ({ text: w.text, start: w.start, end: w.end }));
    editedWords = words.map((w) => ({ text: w.text, start: w.start, end: w.end }));
    verifyHint.textContent = LYRICS_SOURCE_LABELS[source] || "";
    verifyStatus.textContent = "";
    verifyLoadbar.style.display = "none";
    renderVerifyWords();
  }

  function syncEditsToPreview() {
    // Répercute les corrections sur l'aperçu vidéo live (§16) sans repasser par le serveur.
    realWords = editedWords.map((w) => ({ ...w }));
    lastRealCueIdx = -1;
    restartPreviewAnim();
  }

  // Seuil de silence (secondes) au-delà duquel on considère qu'une nouvelle phrase/ligne
  // commence — même heuristique que _words_to_phrases() côté backend, pour que le regroupement
  // visuel colle à ce qui sera utilisé pour le mode "Phrase entière"/l'export .srt.
  const VERIFY_LINE_GAP = 0.4;

  function insertWordAfter(afterIdx) {
    const prev = editedWords[afterIdx];
    const next = editedWords[afterIdx + 1];
    const gapStart = prev ? prev.end : 0;
    const gapEnd = next ? next.start : gapStart + 0.6;
    const dur = Math.min(0.4, Math.max(0.15, (gapEnd - gapStart) * 0.6 || 0.3));
    const start = gapStart + Math.max(0, (gapEnd - gapStart - dur) / 2);
    editedWords.splice(afterIdx + 1, 0, { text: "nouveau", start, end: start + dur });
    renderVerifyWords();
    verifyStatus.textContent = "Mot ajouté — modifie son texte ✓";
    syncEditsToPreview();
    const chip = verifyWordsEl.querySelector('.verify-word[data-index="' + (afterIdx + 1) + '"]');
    if (chip) editWordChip(chip, afterIdx + 1);
  }

  function renderVerifyWords() {
    verifyWordsEl.innerHTML = "";
    if (!editedWords || !editedWords.length) {
      const addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "verify-word-add";
      addBtn.textContent = "+ Ajouter un mot";
      addBtn.addEventListener("click", () => insertWordAfter(-1));
      verifyWordsEl.appendChild(addBtn);
      verifyWordsEl.appendChild(verifyTextCursor);
      return;
    }
    let lineEl = null;
    let lineIdx = -1;
    let lastIdxInLine = -1;
    editedWords.forEach((w, i) => {
      const isNewLine = i === 0 || (w.start - editedWords[i - 1].end) > VERIFY_LINE_GAP;
      if (isNewLine) {
        if (lineEl) appendLineAddButton(lineEl, lastIdxInLine);
        lineIdx++;
        lineEl = document.createElement("div");
        lineEl.className = "verify-line verify-line-" + (lineIdx % 6);
        verifyWordsEl.appendChild(lineEl);
      }
      const chip = document.createElement("span");
      chip.className = "verify-word";
      chip.textContent = w.text;
      chip.dataset.index = String(i);
      chip.draggable = true;
      chip.title = formatTime(w.start) + " – " + formatTime(w.end) + " · clique pour corriger (Suppr efface le mot), glisse-dépose pour échanger avec un autre mot";
      chip.addEventListener("click", () => editWordChip(chip, i));
      chip.addEventListener("dragstart", (e) => {
        dragFromIndex = i;
        chip.classList.add("dragging");
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      });
      chip.addEventListener("dragend", () => chip.classList.remove("dragging"));
      chip.addEventListener("dragover", (e) => { e.preventDefault(); chip.classList.add("drag-over"); });
      chip.addEventListener("dragleave", () => chip.classList.remove("drag-over"));
      chip.addEventListener("drop", (e) => {
        e.preventDefault();
        chip.classList.remove("drag-over");
        if (dragFromIndex === null || dragFromIndex === i) { dragFromIndex = null; return; }
        // Échange le TEXTE des deux mots — les horodatages restent ancrés à leur position sur
        // la timeline, donc ça corrige un ordre mal transcrit sans jamais casser la synchro.
        const tmp = editedWords[i].text;
        editedWords[i].text = editedWords[dragFromIndex].text;
        editedWords[dragFromIndex].text = tmp;
        dragFromIndex = null;
        renderVerifyWords();
        verifyStatus.textContent = "Mots échangés ✓";
        syncEditsToPreview();
      });
      lineEl.appendChild(chip);
      lastIdxInLine = i;
    });
    if (lineEl) appendLineAddButton(lineEl, lastIdxInLine);
    verifyWordsEl.appendChild(verifyTextCursor);
  }

  function appendLineAddButton(lineEl, afterIdx) {
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "verify-word-add";
    addBtn.textContent = "+";
    addBtn.title = "Ajouter un mot à la fin de cette ligne";
    addBtn.addEventListener("click", () => insertWordAfter(afterIdx));
    lineEl.appendChild(addBtn);
  }

  function editWordChip(chip, i) {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "verify-word-edit";
    input.value = editedWords[i].text;
    chip.replaceWith(input);
    input.focus();
    input.select(); // texte présélectionné : taper remplace tout, Suppr/Retour arrière (sans avoir retapé) efface le mot entier
    let committed = false;
    const commit = () => {
      if (committed) return;
      committed = true;
      const val = input.value.trim();
      if (val) editedWords[i].text = val;
      renderVerifyWords();
      verifyStatus.textContent = "Correction enregistrée ✓";
      syncEditsToPreview();
    };
    const deleteWord = () => {
      committed = true;
      editedWords.splice(i, 1);
      renderVerifyWords();
      verifyStatus.textContent = "Mot supprimé ✓";
      syncEditsToPreview();
    };
    input.addEventListener("keydown", (e) => {
      if (
        (e.key === "Delete" || e.key === "Backspace") &&
        input.selectionStart === 0 &&
        input.selectionEnd === input.value.length
      ) {
        // Le mot est toujours entièrement sélectionné (aucune frappe depuis le clic) : Suppr /
        // Retour arrière supprime le mot au lieu d'effacer juste son texte.
        e.preventDefault();
        deleteWord();
        return;
      }
      if (e.key === "Enter") { e.preventDefault(); input.blur(); }
      if (e.key === "Escape") { committed = true; renderVerifyWords(); }
    });
    input.addEventListener("blur", commit);
  }

  function normalizeWordForMatch(s) {
    return (s || "").toLowerCase().replace(/[.,!?;:"'’()]/g, "");
  }

  // Le champ "Remplacer par" vide indique une suppression en masse plutôt qu'un remplacement —
  // le libellé du bouton s'ajuste pour que ce soit clair.
  bulkTo.addEventListener("input", () => {
    bulkApplyBtn.textContent = bulkTo.value.trim() ? "Remplacer partout" : "Supprimer partout";
  });

  bulkApplyBtn.addEventListener("click", () => {
    const from = bulkFrom.value.trim();
    const to = bulkTo.value.trim();
    if (!from || !editedWords) return;
    const fromNorm = normalizeWordForMatch(from);

    if (!to) {
      // Bulk suppression : retire tous les mots correspondants d'un coup.
      const before = editedWords.length;
      editedWords = editedWords.filter((w) => normalizeWordForMatch(w.text) !== fromNorm);
      const removed = before - editedWords.length;
      if (removed > 0) {
        renderVerifyWords();
        syncEditsToPreview();
        verifyStatus.textContent = removed + " occurrence(s) de « " + from + " » supprimée(s).";
      } else {
        verifyStatus.textContent = "Aucune occurrence de « " + from + " » trouvée.";
      }
      return;
    }

    let count = 0;
    editedWords.forEach((w) => {
      if (normalizeWordForMatch(w.text) === fromNorm) {
        w.text = to;
        count++;
      }
    });
    if (count > 0) {
      renderVerifyWords();
      syncEditsToPreview();
      verifyStatus.textContent = count + " occurrence(s) de « " + from + " » remplacée(s) par « " + to + " ».";
    } else {
      verifyStatus.textContent = "Aucune occurrence de « " + from + " » trouvée.";
    }
  });

  verifyResetBtn.addEventListener("click", () => {
    if (!originalRealWords) return;
    editedWords = originalRealWords.map((w) => ({ ...w }));
    renderVerifyWords();
    syncEditsToPreview();
    verifyStatus.textContent = "Corrections annulées.";
  });

  verifyAddWordBtn.addEventListener("click", () => {
    if (!editedWords) return;
    insertWordAfter(editedWords.length - 1);
  });

  // --- Lecteur audio + waveform -------------------------------------------------------------

  verifyPlayBtn.addEventListener("click", () => {
    if (verifyAudio.paused) verifyAudio.play().catch(() => {});
    else verifyAudio.pause();
  });
  verifyAudio.addEventListener("play", () => { verifyPlayBtn.textContent = "⏸"; });
  verifyAudio.addEventListener("pause", () => { verifyPlayBtn.textContent = "▶"; });

  waveCanvas.parentElement.addEventListener("click", (e) => {
    if (!verifyAudio.duration) return;
    const rect = waveCanvas.parentElement.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    verifyAudio.currentTime = frac * verifyAudio.duration;
  });

  function drawWordDensityFallback(ctx2d, w, h) {
    if (!editedWords || !editedWords.length) return;
    const totalDur = editedWords[editedWords.length - 1].end || 1;
    ctx2d.fillStyle = "rgba(255,255,255,.25)";
    editedWords.forEach((word) => {
      const x = (word.start / totalDur) * w;
      const bw = Math.max(2, ((word.end - word.start) / totalDur) * w);
      ctx2d.fillRect(x, h * 0.25, bw, h * 0.5);
    });
  }

  function paintWaveform(ctx2d, w, h, data) {
    const step = Math.max(1, Math.floor(data.length / w));
    ctx2d.fillStyle = "rgba(255,255,255,.35)";
    for (let x = 0; x < w; x++) {
      let min = 1, max = -1;
      const start = x * step;
      for (let i = 0; i < step; i++) {
        const v = data[start + i] || 0;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const y1 = (1 + min) * 0.5 * h;
      const y2 = (1 + max) * 0.5 * h;
      ctx2d.fillRect(x, Math.min(y1, y2), 1, Math.max(2, Math.abs(y2 - y1)));
    }
  }

  async function drawWaveform() {
    if (!selectedFile) return;
    const ctx2d = waveCanvas.getContext("2d");
    const parent = waveCanvas.parentElement;
    const w = (waveCanvas.width = parent.clientWidth || 600);
    const h = (waveCanvas.height = parent.clientHeight || 56);
    ctx2d.clearRect(0, 0, w, h);

    if (!cachedAudioBuffer) {
      try {
        const buf = await selectedFile.arrayBuffer();
        const AC = window.AudioContext || window.webkitAudioContext;
        const actx = new AC();
        cachedAudioBuffer = await actx.decodeAudioData(buf);
        actx.close();
      } catch (e) {
        // Format non décodable par le navigateur (rare) — on retombe sur une visualisation
        // basée sur la densité des mots, moins jolie mais toujours fiable.
        cachedAudioBuffer = null;
      }
    }

    if (cachedAudioBuffer) {
      paintWaveform(ctx2d, w, h, cachedAudioBuffer.getChannelData(0));
    } else {
      drawWordDensityFallback(ctx2d, w, h);
    }
  }

  window.addEventListener("resize", () => { if (selectedFile) drawWaveform(); });

  function positionVerifyTextCursor(idx, t) {
    if (idx < 0 || !editedWords || !editedWords[idx]) {
      verifyTextCursor.style.display = "none";
      return;
    }
    const chip = verifyWordsEl.querySelector('.verify-word[data-index="' + idx + '"]');
    if (!chip) { verifyTextCursor.style.display = "none"; return; }
    const w = editedWords[idx];
    // Balaie le mot actif de gauche à droite au rythme de sa propre durée ; si on est dans le
    // silence après ce mot (avant le suivant), le curseur reste figé à la fin du mot plutôt que
    // de sauter dans le vide.
    const dur = Math.max(0.05, w.end - w.start);
    const frac = Math.max(0, Math.min(1, (t - w.start) / dur));
    // offsetLeft/offsetTop d'un mot dans une .verify-line (position statique) remontent
    // directement à .verify-words, qui est le containing block positionné (position: relative).
    const x = chip.offsetLeft + chip.offsetWidth * frac;
    verifyTextCursor.style.display = "block";
    verifyTextCursor.style.left = x + "px";
    verifyTextCursor.style.top = chip.offsetTop + "px";
    verifyTextCursor.style.height = chip.offsetHeight + "px";
  }

  let lastVerifyWordIdx = -1;
  function verifyTick() {
    if (verifyAudio.duration) {
      const frac = verifyAudio.currentTime / verifyAudio.duration;
      verifyPlayhead.style.left = frac * 100 + "%";
      verifyTime.textContent = formatTime(verifyAudio.currentTime) + " / " + formatTime(verifyAudio.duration);
    }
    if (editedWords && editedWords.length) {
      const t = verifyAudio.currentTime;
      let idx = -1;
      for (let i = editedWords.length - 1; i >= 0; i--) {
        if (t >= editedWords[i].start) { idx = i; break; }
      }
      if (idx !== lastVerifyWordIdx) {
        lastVerifyWordIdx = idx;
        verifyWordsEl.querySelectorAll(".verify-word.playing").forEach((el) => el.classList.remove("playing"));
        if (idx >= 0) {
          const el = verifyWordsEl.querySelector('.verify-word[data-index="' + idx + '"]');
          if (el) { el.classList.add("playing"); el.scrollIntoView({ block: "nearest", inline: "nearest" }); }
        }
      }
      positionVerifyTextCursor(idx, t);
    } else {
      verifyTextCursor.style.display = "none";
    }
    requestAnimationFrame(verifyTick);
  }
  requestAnimationFrame(verifyTick);

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
            if (data.option === "video") {
              resultVideo.src = data.download_url;
              resultVideo.load();
            } else {
              resultVideo.removeAttribute("src");
              resultVideo.load();
            }
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
    fd.append("reference_lyrics", referenceLyricsEl.value.trim());
    fd.append("file", selectedFile);
    if (editedWords && editedWords.length) {
      // Paroles corrigées dans la section "Vérifier les paroles" — le backend les utilise
      // directement au lieu de retranscrire (voir edited_words côté /jobs).
      fd.append("edited_words", JSON.stringify(editedWords));
    }
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
      fd.append("italic", isItalic() ? "true" : "false");
      fd.append("words_per_group", groupSizeSlider.value);
    }

    goBtn.disabled = true;
    resultsBox.classList.remove("show");
    resultVideo.pause();
    resultVideo.removeAttribute("src");
    resultVideo.load();
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
