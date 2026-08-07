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
    audio: document.getElementById("shr-audio"),
  };

  const ICON_PLAY = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"></path></svg>`;
  const ICON_PAUSE = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14"></rect><rect x="14" y="5" width="4" height="14"></rect></svg>`;
  const ICON_DOWNLOAD = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`;

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

  function renderTracklist() {
    const { meta } = state;
    if (!meta.permissions.streaming) {
      els.tracklist.innerHTML = `<div class="shr-track-disabled-note">L'écoute n'est pas activée pour ce lien.</div>`;
      return;
    }
    els.tracklist.innerHTML = meta.tracks.map((t, i) => `
      <div class="shr-track" data-idx="${i}">
        <button type="button" class="shr-track-playbtn" data-idx="${i}" aria-label="Lecture">${ICON_PLAY}</button>
        <div class="shr-track-info">
          <div class="shr-track-title">${escapeHtml(t.title)}</div>
          ${meta.permissions.trackInfo !== false ? `<div class="shr-track-sub">${escapeHtml(t.artist)}</div>` : ""}
        </div>
        ${meta.permissions.downloadHQ ? `<button type="button" class="shr-track-action shr-track-download" data-idx="${i}" title="Télécharger" aria-label="Télécharger">${ICON_DOWNLOAD}</button>` : "<span></span>"}
      </div>
    `).join("");

    els.tracklist.querySelectorAll(".shr-track").forEach((row) => {
      row.addEventListener("click", (e) => {
        if (e.target.closest(".shr-track-download")) return;
        playTrack(+row.dataset.idx);
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
    els.tracklist.querySelectorAll(".shr-track").forEach((row) => {
      const idx = +row.dataset.idx;
      const isCurrent = idx === state.currentIndex;
      row.classList.toggle("shr-track-playing", isCurrent);
      const btn = row.querySelector(".shr-track-playbtn");
      if (btn) btn.innerHTML = isCurrent && state.isPlaying ? ICON_PAUSE : ICON_PLAY;
    });
  }

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
    els.playerSeek.value = String((els.audio.currentTime / els.audio.duration) * 1000);
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
  els.playerSeek.addEventListener("input", () => {
    if (!els.audio.duration) return;
    els.audio.currentTime = (+els.playerSeek.value / 1000) * els.audio.duration;
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
