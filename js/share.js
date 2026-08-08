(function () {
  "use strict";

  /* =========================================================================
     Duchess Hub — page publique de partage (Sound Connect)
     Page 100% autonome (pas de dépendance à tabs.js/admin.js/soundconnect.js) :
     un visiteur externe n'a et ne doit avoir accès à RIEN d'autre que ce que
     l'admin a explicitement coché pour CE lien (voir permissions.streaming /
     downloadHQ / trackInfo côté backend, section "Partage externe").
     ========================================================================= */

  const BACKEND_BASE_URL = "https://duchess-hub.onrender.com";

  const params = new URLSearchParams(window.location.search);
  const shareId = params.get("id") || params.get("s") || "";

  const els = {
    loading: document.getElementById("shr-loading"),
    error: document.getElementById("shr-error"),
    errorText: document.getElementById("shr-error-text"),
    gate: document.getElementById("shr-gate"),
    gateForm: document.getElementById("shr-gate-form"),
    gatePassword: document.getElementById("shr-gate-password"),
    gateError: document.getElementById("shr-gate-error"),
    page: document.getElementById("shr-page"),
    bg: document.getElementById("shr-bg"),
    cover: document.getElementById("shr-cover"),
    coverGlow: document.getElementById("shr-cover-glow"),
    kicker: document.getElementById("shr-kicker"),
    title: document.getElementById("shr-title"),
    artist: document.getElementById("shr-artist"),
    meta: document.getElementById("shr-meta"),
    playAllBtn: document.getElementById("shr-playAllBtn"),
    downloadAllBtn: document.getElementById("shr-downloadAllBtn"),
    tracklist: document.getElementById("shr-tracklist"),
    player: document.getElementById("shr-player"),
    playerCover: document.getElementById("shr-player-cover"),
    playerTitle: document.getElementById("shr-player-title"),
    playerArtist: document.getElementById("shr-player-artist"),
    playerPlay: document.getElementById("shr-player-play"),
    playerPlayIcon: document.getElementById("shr-player-play-icon"),
    playerPrev: document.getElementById("shr-player-prev"),
    playerNext: document.getElementById("shr-player-next"),
    playerSeek: document.getElementById("shr-player-seek"),
    playerTimeCurrent: document.getElementById("shr-player-time-current"),
    playerTimeTotal: document.getElementById("shr-player-time-total"),
    playerDownload: document.getElementById("shr-player-download"),
    waveform: document.getElementById("shr-player-waveform"),
    waveformBg: document.getElementById("shr-player-waveform-bg"),
    waveformFg: document.getElementById("shr-player-waveform-fg"),
    volumeIcon: document.getElementById("shr-volumeIcon"),
    volume: document.getElementById("shr-volume"),
    audio: document.getElementById("shr-audio"),
  };

  const ICON_PLAY = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"></path></svg>`;
  const ICON_PAUSE = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14"></rect><rect x="14" y="5" width="4" height="14"></rect></svg>`;
  const ICON_DOWNLOAD = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`;
  const ICON_EQ = `<span class="shr-track-index-eq"><i></i><i></i><i></i></span>`;

  function showOnly(el) {
    [els.loading, els.error, els.gate, els.page].forEach((s) => s.classList.toggle("hidden", s !== el));
  }

  function escapeHtml(s) {
    return (s || "").toString().replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function formatTime(s) {
    if (!isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60).toString().padStart(2, "0");
    return `${m}:${sec}`;
  }

  // -------------------------------------------------------------------
  // Chargement des métadonnées + gestion du mot de passe
  // -------------------------------------------------------------------

  let state = null; // { meta, accessToken, tracks, currentIndex }
  let storedPassword = ""; // gardé en mémoire (pas de storage) le temps de la session pour ré-essayer si le jeton expire

  async function fetchMeta(password) {
    const headers = password ? { "X-Share-Password": password } : {};
    const r = await fetch(`${BACKEND_BASE_URL}/share/${encodeURIComponent(shareId)}`, { headers });
    if (r.status === 401) return { needsPassword: true };
    if (!r.ok) {
      let detail = "Ce lien de partage n'existe plus ou a été désactivé.";
      try { detail = (await r.json()).detail || detail; } catch (e) {}
      return { error: detail };
    }
    return { meta: await r.json() };
  }

  async function boot() {
    if (!shareId) {
      els.errorText.textContent = "Lien de partage invalide.";
      showOnly(els.error);
      return;
    }
    showOnly(els.loading);
    const res = await fetchMeta();
    if (res.needsPassword) {
      showOnly(els.gate);
      els.gatePassword.focus();
      return;
    }
    if (res.error) {
      els.errorText.textContent = res.error;
      showOnly(els.error);
      return;
    }
    renderMeta(res.meta);
  }

  els.gateForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const pw = els.gatePassword.value;
    els.gateError.classList.add("hidden");
    const submitBtn = document.getElementById("shr-gate-submit");
    submitBtn.disabled = true;
    try {
      const res = await fetchMeta(pw);
      if (res.needsPassword) {
        els.gateError.classList.remove("hidden");
        return;
      }
      if (res.error) {
        els.errorText.textContent = res.error;
        showOnly(els.error);
        return;
      }
      storedPassword = pw;
      renderMeta(res.meta);
    } finally {
      submitBtn.disabled = false;
    }
  });

  // -------------------------------------------------------------------
  // Rendu du contenu
  // -------------------------------------------------------------------

  function renderMeta(meta) {
    state = { meta, accessToken: meta.accessToken, currentIndex: -1, isPlaying: false };

    // Reprend la palette d'accent exacte de Sound Connect selon le workspace
    // d'origine du partage (voir body[data-share-label] dans css/share.css et
    // body[data-sc-label] dans css/style.css — même mapping ARK/THEORY/défaut).
    document.body.dataset.shareLabel = meta.labelSlug || "duchess";

    const coverUrl = `${BACKEND_BASE_URL}${meta.coverUrl}`;
    els.cover.src = coverUrl;
    els.coverGlow.style.backgroundImage = `url("${coverUrl}")`;
    els.bg.style.backgroundImage = `url("${coverUrl}")`;
    document.title = `${meta.title} — Duchess`;

    els.kicker.textContent = meta.targetType === "project"
      ? (PROJECT_TYPE_LABELS[meta.projectType] || "Projet") + " partagé"
      : "Titre partagé";
    els.title.textContent = meta.title;
    els.artist.textContent = meta.permissions.trackInfo !== false ? meta.artist || "" : "";
    els.artist.classList.toggle("hidden", !els.artist.textContent);
    els.meta.textContent = `${meta.tracks.length} titre${meta.tracks.length > 1 ? "s" : ""}`;

    if (!meta.permissions.streaming) {
      els.playAllBtn.classList.add("hidden");
    }
    if (meta.permissions.downloadHQ && meta.tracks.length > 1) {
      els.downloadAllBtn.classList.remove("hidden");
      els.downloadAllBtn.addEventListener("click", () => {
        meta.tracks.forEach((t, i) => setTimeout(() => downloadTrack(t), i * 350));
      });
    }

    renderTracklist();
    showOnly(els.page);

    els.playAllBtn.addEventListener("click", () => {
      if (!meta.permissions.streaming) return;
      playTrack(0);
    });
  }

  const PROJECT_TYPE_LABELS = { single: "Single", ep: "EP", album: "Album" };

  function trackStreamUrl(trackId) {
    return `${BACKEND_BASE_URL}/share/${encodeURIComponent(shareId)}/tracks/${encodeURIComponent(trackId)}/stream?at=${encodeURIComponent(state.accessToken)}`;
  }
  function trackDownloadUrl(trackId) {
    return `${BACKEND_BASE_URL}/share/${encodeURIComponent(shareId)}/tracks/${encodeURIComponent(trackId)}/download?at=${encodeURIComponent(state.accessToken)}`;
  }
  function downloadTrack(t) {
    const a = document.createElement("a");
    a.href = trackDownloadUrl(t.id);
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function trackCoverUrl(t) {
    // Chaque titre hérite désormais de la cover de son projet parent quand il
    // n'a pas la sienne (voir backend _resolve_cover) — mais sur cette page on
    // n'a qu'UNE cover (celle du partage) déjà chargée, donc pas besoin d'un
    // fetch par titre : on la réutilise telle quelle, résultat identique.
    return els.cover.src;
  }

  function renderTracklist() {
    const { meta } = state;
    if (!meta.permissions.streaming) {
      els.tracklist.innerHTML = `<div class="shr-track-disabled-note">L'écoute n'est pas activée pour ce lien.</div>`;
      return;
    }
    els.tracklist.innerHTML = meta.tracks.map((t, i) => `
      <div class="shr-track" data-idx="${i}">
        <div class="shr-track-index-cell">
          <span class="shr-track-index">${i + 1}</span>
          <button type="button" class="shr-track-index-playbtn" data-idx="${i}" aria-label="Lecture">
            <span class="shr-track-index-icon">${ICON_PLAY}</span>
            ${ICON_EQ}
          </button>
        </div>
        <img class="shr-track-cover" src="${trackCoverUrl(t)}" alt="" loading="lazy">
        <div class="shr-track-info">
          <div class="shr-track-title">${escapeHtml(t.title)}</div>
          ${meta.permissions.trackInfo !== false ? `<div class="shr-track-sub">${escapeHtml(t.artist)}</div>` : ""}
        </div>
        ${meta.permissions.downloadHQ ? `<button type="button" class="shr-track-action shr-track-download" data-idx="${i}" title="Télécharger" aria-label="Télécharger">${ICON_DOWNLOAD}</button>` : "<span></span>"}
      </div>
    `).join("");

    els.tracklist.querySelectorAll(".shr-track").forEach((row, i) => {
      row.style.animationDelay = `${Math.min(i, 20) * 25}ms`;
      row.addEventListener("click", (e) => {
        if (e.target.closest(".shr-track-download")) return;
        playTrack(+row.dataset.idx);
      });
    });
    els.tracklist.querySelectorAll(".shr-track-index-playbtn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        playTrack(+btn.dataset.idx);
      });
    });
    els.tracklist.querySelectorAll(".shr-track-download").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        downloadTrack(state.meta.tracks[+btn.dataset.idx]);
      });
    });
    updateTracklistHighlight();
  }

  function updateTracklistHighlight() {
    const audioPlaying = state.currentIndex >= 0 && !els.audio.paused;
    els.tracklist.querySelectorAll(".shr-track").forEach((row) => {
      const idx = +row.dataset.idx;
      const isCurrent = idx === state.currentIndex;
      row.classList.toggle("shr-track-playing", isCurrent);
      row.classList.toggle("shr-track-audio-playing", isCurrent && audioPlaying);
    });
  }

  // -------------------------------------------------------------------
  // Waveform — silhouette générée instantanément puis vraie analyse RMS (Web
  // Audio API), avec cache mémoire + serveur, EXACTEMENT comme dans Sound
  // Connect (voir js/soundconnect.js:renderWaveform et le commentaire associé
  // sur le choix du RMS plutôt que le pic). Les endpoints de cache
  // (/soundconnect/tracks/{id}/waveform) sont publics (aucune route de
  // partage n'a besoin d'y toucher), donc réutilisés tels quels ici : une
  // silhouette calculée une fois dans l'app admin sert aussi sur les liens
  // publics, et inversement.
  // -------------------------------------------------------------------

  function barsMarkup(values) {
    return values.map((v) => `<span class="shr-wave-bar" style="height:${Math.max(6, Math.round(v * 100))}%"></span>`).join("");
  }

  function generateFakePeaks(seedStr, count) {
    let seed = 0;
    for (let i = 0; i < seedStr.length; i++) seed = (seed * 31 + seedStr.charCodeAt(i)) >>> 0;
    function rand() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967295; }
    const raw = [];
    for (let i = 0; i < count; i++) raw.push(0.15 + rand() * 0.85);
    return raw.map((v, i) => {
      const prev = raw[i - 1] !== undefined ? raw[i - 1] : v;
      const next = raw[i + 1] !== undefined ? raw[i + 1] : v;
      return (prev + v * 2 + next) / 4;
    });
  }

  async function computeRealPeaks(url, count) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    const res = await fetch(url);
    if (!res.ok) throw new Error("waveform fetch failed");
    const buf = await res.arrayBuffer();
    const ctx = new AC();
    try {
      const audioBuffer = await ctx.decodeAudioData(buf);
      const data = audioBuffer.getChannelData(0);
      const bucketSize = Math.max(1, Math.floor(data.length / count));
      const energies = [];
      for (let i = 0; i < count; i++) {
        const start = i * bucketSize;
        const end = Math.min(data.length, start + bucketSize);
        let sumSq = 0;
        for (let j = start; j < end; j++) { const v = data[j]; sumSq += v * v; }
        energies.push(Math.sqrt(sumSq / Math.max(1, end - start)));
      }
      const globalMax = Math.max(0.001, ...energies);
      return energies.map((v) => v / globalMax);
    } finally {
      ctx.close();
    }
  }

  const WAVEFORM_CACHE_RESOLUTION = 240;

  function resamplePeaks(peaks, targetCount) {
    if (!peaks.length || targetCount === peaks.length) return peaks;
    const out = new Array(targetCount);
    for (let i = 0; i < targetCount; i++) {
      out[i] = peaks[Math.min(peaks.length - 1, Math.floor((i * peaks.length) / targetCount))];
    }
    return out;
  }

  const waveformMemoryCache = new Map();

  async function fetchJSON(path, options) {
    const r = await fetch(BACKEND_BASE_URL + path, options);
    if (!r.ok) throw new Error(r.statusText);
    return r.json();
  }

  async function fetchCachedWaveform(trackId) {
    if (waveformMemoryCache.has(trackId)) return waveformMemoryCache.get(trackId);
    try {
      const res = await fetchJSON(`/soundconnect/tracks/${encodeURIComponent(trackId)}/waveform`);
      if (res && Array.isArray(res.peaks) && res.peaks.length) {
        waveformMemoryCache.set(trackId, res.peaks);
        return res.peaks;
      }
    } catch (e) {} // pas encore analysé (404) — silhouette générée le temps de l'analyser
    return null;
  }

  function saveWaveformToCache(trackId, peaks) {
    waveformMemoryCache.set(trackId, peaks);
    fetchJSON(`/soundconnect/tracks/${encodeURIComponent(trackId)}/waveform`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ peaks }),
    }).catch(() => {});
  }

  let waveformToken = 0;
  function renderWaveform(track) {
    const myToken = ++waveformToken;
    const BAR_PITCH = 3;
    const count = Math.max(30, Math.floor((els.waveform.clientWidth || 480) / BAR_PITCH));

    function paint(peaks) {
      const html = barsMarkup(resamplePeaks(peaks, count));
      els.waveformBg.innerHTML = html;
      els.waveformFg.innerHTML = html;
    }

    els.waveform.style.setProperty("--progress", "0%");

    const cached = waveformMemoryCache.get(track.id);
    if (cached) { paint(cached); return; }

    paint(generateFakePeaks(String(track.id || track.title || "x"), WAVEFORM_CACHE_RESOLUTION));

    fetchCachedWaveform(track.id).then((cachedPeaks) => {
      if (myToken !== waveformToken) return;
      if (cachedPeaks) { paint(cachedPeaks); return; }
      computeRealPeaks(trackStreamUrl(track.id), WAVEFORM_CACHE_RESOLUTION)
        .then((peaks) => {
          if (!peaks || myToken !== waveformToken) return;
          paint(peaks);
          saveWaveformToCache(track.id, peaks);
        })
        .catch(() => {});
    });
  }

  // -------------------------------------------------------------------
  // Volume — même icône (mute/low/high) + même piste remplie que Sound
  // Connect (voir js/soundconnect.js:updateVolumeUI), synchronisée sur
  // audioEl.volume (source de vérité).
  // -------------------------------------------------------------------

  let volumeBeforeMute = 1;
  function updateVolumeUI() {
    const vol = els.audio.volume;
    els.volume.style.setProperty("--pct", Math.round(vol * 100));
    els.volume.value = Math.round(vol * 100);
    const level = vol === 0 ? "muted" : vol < 0.5 ? "low" : "high";
    const icons = {
      muted: '<path d="M16 9l-6 6M10 9l6 6"></path><polygon points="4 8 8 8 12 4 12 20 8 16 4 16 4 8"></polygon>',
      low: '<polygon points="4 8 8 8 12 4 12 20 8 16 4 16 4 8"></polygon><path d="M15.5 8.5a5 5 0 0 1 0 7"></path>',
      high: '<polygon points="4 8 8 8 12 4 12 20 8 16 4 16 4 8"></polygon><path d="M15.5 8.5a5 5 0 0 1 0 7"></path><path d="M18.5 6a9 9 0 0 1 0 12"></path>',
    };
    els.volumeIcon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icons[level]}</svg>`;
    els.volumeIcon.title = level === "muted" ? "Rétablir le son" : "Couper le son";
    els.volumeIcon.setAttribute("aria-label", els.volumeIcon.title);
  }
  els.audio.volume = 1;
  updateVolumeUI();
  els.volume.addEventListener("input", () => {
    els.audio.volume = (+els.volume.value) / 100;
    updateVolumeUI();
  });
  els.volumeIcon.addEventListener("click", () => {
    if (els.audio.volume > 0) { volumeBeforeMute = els.audio.volume; els.audio.volume = 0; }
    else { els.audio.volume = volumeBeforeMute || 1; }
    updateVolumeUI();
  });

  // -------------------------------------------------------------------
  // Lecteur
  // -------------------------------------------------------------------

  function playTrack(idx) {
    const t = state.meta.tracks[idx];
    if (!t) return;
    if (state.currentIndex === idx) {
      togglePlayPause();
      return;
    }
    state.currentIndex = idx;
    state.isPlaying = true;
    els.audio.src = trackStreamUrl(t.id);
    els.audio.play().catch(() => {});
    els.player.classList.remove("hidden");
    els.playerCover.src = els.cover.src;
    els.playerTitle.textContent = t.title;
    els.playerArtist.textContent = state.meta.permissions.trackInfo !== false ? t.artist : "";
    els.playerDownload.classList.toggle("hidden", !state.meta.permissions.downloadHQ);
    renderWaveform(t);
    updatePlayIcon();
    updateTracklistHighlight();
  }

  function togglePlayPause() {
    if (!els.audio.src) return;
    if (els.audio.paused) { els.audio.play().catch(() => {}); state.isPlaying = true; }
    else { els.audio.pause(); state.isPlaying = false; }
    updatePlayIcon();
    updateTracklistHighlight();
  }

  function updatePlayIcon() {
    els.playerPlayIcon.outerHTML = state.isPlaying
      ? ICON_PAUSE.replace("<svg ", '<svg id="shr-player-play-icon" ')
      : ICON_PLAY.replace("<svg ", '<svg id="shr-player-play-icon" ');
    els.playerPlayIcon = document.getElementById("shr-player-play-icon");
  }

  function playAdjacent(delta) {
    if (!state || state.currentIndex < 0) return;
    const n = state.meta.tracks.length;
    const next = (state.currentIndex + delta + n) % n;
    playTrack(next);
  }

  els.playerPlay.addEventListener("click", togglePlayPause);
  els.playerPrev.addEventListener("click", () => playAdjacent(-1));
  els.playerNext.addEventListener("click", () => playAdjacent(1));
  els.playerDownload.addEventListener("click", () => {
    if (state && state.currentIndex >= 0) downloadTrack(state.meta.tracks[state.currentIndex]);
  });

  els.audio.addEventListener("timeupdate", () => {
    if (!els.audio.duration) return;
    const pct = (els.audio.currentTime / els.audio.duration) * 100;
    els.playerSeek.value = String(pct * 10);
    els.waveform.style.setProperty("--progress", `${pct}%`);
    els.playerTimeCurrent.textContent = formatTime(els.audio.currentTime);
    els.playerTimeTotal.textContent = formatTime(els.audio.duration);
  });
  els.audio.addEventListener("loadedmetadata", () => {
    els.playerTimeTotal.textContent = formatTime(els.audio.duration);
  });
  els.audio.addEventListener("ended", () => {
    if (state.meta.tracks.length > 1) playAdjacent(1);
    else { state.isPlaying = false; updatePlayIcon(); updateTracklistHighlight(); }
  });
  els.audio.addEventListener("play", updateTracklistHighlight);
  els.audio.addEventListener("pause", updateTracklistHighlight);
  els.playerSeek.addEventListener("input", () => {
    if (!els.audio.duration) return;
    const pct = (+els.playerSeek.value / 1000) * 100;
    els.audio.currentTime = (pct / 100) * els.audio.duration;
    els.waveform.style.setProperty("--progress", `${pct}%`);
  });

  // Auto-guérison si le jeton d'accès a expiré en cours de session (rare,
  // durée de vie de 6h côté backend) : on relit /share/{token} pour en
  // obtenir un frais avant de réessayer, une seule fois.
  let triedRefreshToken = false;
  els.audio.addEventListener("error", async () => {
    if (triedRefreshToken || !state || state.currentIndex < 0) return;
    triedRefreshToken = true;
    const res = await fetchMeta(storedPassword);
    if (res.meta) {
      state.accessToken = res.meta.accessToken;
      const t = state.meta.tracks[state.currentIndex];
      els.audio.src = trackStreamUrl(t.id);
      els.audio.play().catch(() => {});
    }
  });

  boot();
})();
