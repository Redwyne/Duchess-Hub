"""
Duchess Hub — backend de l'onglet Sous-titres.

Deux usages, un seul moteur :
- Option 1 "fichier" : upload audio (ou vidéo) -> .srt simple.
- Option 2 "video"   : upload vidéo -> vidéo rendue, sous-titres stylés incrustés (.ass + ffmpeg burn-in).

Etat v2 (styles étendus) :
- 6 modes d'apparition : mot remplace l'autre (replace), ligne qui se construit horizontalement
  (build), ligne qui se construit verticalement (build_vertical), pile de lignes qui se déroule
  (stack, "l'une au-dessus de l'autre"), phrase entière (full), karaoké mot surligné (karaoke).
- Réglages : police (15 polices installées côté Docker), taille, couleur, position (bas/centre/haut),
  effet d'apparition (fade/pop/slide), fond (contour/plaque/aucun) + couleur de contour, casse
  (majuscule/normale), couleur d'accent (surlignage karaoké).
- Anti-débordement : la taille de police est recalculée par cue (auto-fit) pour que les mots/lignes
  longs ne sortent jamais du cadre, sans changer la taille demandée par l'utilisateur pour le reste.
- Transcription : faster-whisper, modèle défini par la variable d'env WHISPER_MODEL (défaut
  "large-v3-turbo" via le repo CT2 "deepdml/faster-whisper-large-v3-turbo-ct2" — voir
  docs/sous-titres.md round 7 pour l'arbitrage qualité/RAM selon le plan Render).
- Cache "Lyrics Timing" : SQLite local (fichier dans DATA_DIR). Sur le plan Starter de Render le disque
  n'est PAS persistant entre redéploiements -> le cache est reconstruit au besoin, ce n'est pas grave
  pour la mécanique mais à garder en tête (upgrade possible vers un disque persistant Render, ou Postgres,
  si le volume le justifie).
- Recherche audio maître Flowstage : si FLOWSTAGE_API_KEY est renseignée, on cherche d'abord une
  aesthetic Flowstage correspondant à l'artiste/titre (matching flou, tolère accents/casse/code
  numérique en tête) et on réutilise ses paroles + timing de ligne (texte garanti juste, timing mot
  par mot interpolé au prorata des caractères) avant de retomber sur faster-whisper.
"""

import base64
import colorsys
import datetime
import difflib
import hashlib
import hmac
import json
import mimetypes
import os
import re
import secrets
import shutil
import sqlite3
import subprocess
import threading
import time
import unicodedata
import uuid
from pathlib import Path

from typing import List, Optional

import requests
from fastapi import Body, Depends, FastAPI, Form, Header, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import budget_engine as be

# --------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------

APP_DIR = Path(__file__).parent
DATA_DIR = Path(os.environ.get("DATA_DIR", APP_DIR / "data"))
RESULTS_DIR = DATA_DIR / "results"
DATA_DIR.mkdir(parents=True, exist_ok=True)
RESULTS_DIR.mkdir(parents=True, exist_ok=True)

# Historique : "small" -> "medium" (voir docs) puis, le 2026-08-07 (round 7), "medium" ->
# "large-v3-turbo" à la demande de Michel ("desactive la correction Claude et teste un whisper
# bien puissant pour voir"). Testé en direct : ~2,5 Go de RAM en int8 (large-v3 plein, lui,
# sature une machine à 3,8 Go dès le chargement du modèle — écarté), transcription quasi
# instantanée, français détecté avec confiance 1.00. Repo CT2 public utilisé explicitement
# ("deepdml/faster-whisper-large-v3-turbo-ct2") plutôt que l'alias "turbo" intégré à
# faster-whisper (mobiuslabsgmbh/...) qui n'a pas été validé par un test direct.
# Note importante : ce changement ne corrige PAS l'erreur récurrente "il s'aime"/"ils s'aiment"
# (attribuée à tort à la taille du modèle par le passé) — "il s'aime" et "ils s'aiment" se
# prononcent IDENTIQUEMENT en français, c'est un vrai homophone acoustique. Turbo produit
# exactement la même transcription que "small"/"medium" sur ce point précis malgré sa puissance
# largement supérieure : aucun modèle whisper ne peut lever cette ambiguïté depuis l'audio seul.
# Seuls un texte de référence fiable (Flowstage / paroles collées) ou un raisonnement contextuel
# (correction Claude, désactivée pour l'instant, voir ENABLE_CLAUDE_CORRECTION) peuvent trancher.
WHISPER_MODEL_NAME = os.environ.get("WHISPER_MODEL", "deepdml/faster-whisper-large-v3-turbo-ct2")
DB_PATH = DATA_DIR / "app.db"

# Clé API Flowstage (app.theflowstage.com/api-keys) — quand elle est renseignée, le backend
# essaie de retrouver l'aesthetic Flowstage correspondante et d'en réutiliser les paroles
# vérifiées (bien plus fiables qu'une transcription automatique) avant de se rabattre sur
# faster-whisper. Voir find_flowstage_aesthetic() / get_flowstage_words() plus bas.
FLOWSTAGE_API_KEY = os.environ.get("FLOWSTAGE_API_KEY", "")
FLOWSTAGE_BASE_URL = "https://api.theflowstage.com"

# Clé API Anthropic (console.anthropic.com) — quand elle est renseignée ET que
# ENABLE_CLAUDE_CORRECTION est vraie, une passe de correction grammaticale/orthographique via
# Claude est appliquée sur les paroles issues de whisper (JAMAIS sur les paroles Flowstage,
# déjà vérifiées humainement, ni sur une correction manuelle de Michel dans "Vérifier les
# paroles"). Corrige en théorie les homophones/fautes de transcription ("il s'aime"/"ils
# s'aiment"...) sans reformuler le style ou l'argot volontaire.
# DÉSACTIVÉE (2026-08-07) à la demande de Michel : "la correction IA claude change des choses
# qui ne fonctionnent pas" — en test réel elle modifiait parfois des lignes déjà correctes.
# Décision d'origine était "pas d'option par job, si je vois que ça crée trop de soucis je
# l'enlèverai" (voir correct_lyrics_with_claude()) — c'est ce cas de figure. Gardée dans le code
# (pas supprimée) pour pouvoir la remettre en un flag si les tests whisper seul ne suffisent
# pas. `ENABLE_CLAUDE_CORRECTION=true` en variable d'env sur Render la réactive.
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
ENABLE_CLAUDE_CORRECTION = os.environ.get("ENABLE_CLAUDE_CORRECTION", "false").strip().lower() in ("1", "true", "on", "yes")
# Sonnet plutôt que Haiku : la tâche (repérer un accord singulier/pluriel fautif à partir du
# sens et de la cohérence d'un refrain répété) demande un vrai raisonnement contextuel, pas
# juste de la reconnaissance de motifs — et le volume de texte par appel (les paroles d'un
# extrait) est trop faible pour que le coût Sonnet vs Haiku soit significatif.
CLAUDE_LYRICS_MODEL = "claude-sonnet-5"

# --------------------------------------------------------------------------
# Stockage distant (Cloudflare R2) — les résultats générés (.srt / .mp4) sont
# uploadés ici quand c'est configuré, car le disque du conteneur Render n'est
# PAS persistant : à chaque redéploiement, tout ce qui est sous DATA_DIR (donc
# RESULTS_DIR) est effacé, y compris les fichiers déjà générés. Sans R2, un
# fichier généré juste avant un nouveau déploiement devient introuvable dès
# que le conteneur redémarre. Avec R2, l'URL de téléchargement pointe vers le
# bucket et reste valable même après un redéploiement du backend.
# Variables d'env à définir sur Render (Dashboard > service backend > Environment) :
# R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME.
# Tant qu'elles ne sont pas toutes les 4 renseignées, le backend se rabat
# automatiquement sur le stockage local /files/... comme avant.
R2_ACCOUNT_ID = os.environ.get("R2_ACCOUNT_ID", "")
R2_ACCESS_KEY_ID = os.environ.get("R2_ACCESS_KEY_ID", "")
R2_SECRET_ACCESS_KEY = os.environ.get("R2_SECRET_ACCESS_KEY", "")
R2_BUCKET_NAME = os.environ.get("R2_BUCKET_NAME", "")
R2_ENABLED = bool(R2_ACCOUNT_ID and R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY and R2_BUCKET_NAME)

_r2_client = None


def get_r2_client():
    global _r2_client
    if _r2_client is None:
        import boto3

        _r2_client = boto3.client(
            "s3",
            endpoint_url=f"https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com",
            aws_access_key_id=R2_ACCESS_KEY_ID,
            aws_secret_access_key=R2_SECRET_ACCESS_KEY,
            region_name="auto",
        )
    return _r2_client


def upload_to_r2(local_path: Path, key: str):
    """Upload le résultat vers R2 et renvoie une URL de téléchargement valable 7 jours.
    Renvoie None si R2 n'est pas configuré ou si l'upload échoue — dans ce cas
    process_job() se rabat sur l'URL locale /files/... (perdue au prochain redéploiement,
    mais ça ne bloque jamais un job qui a fini de rendre)."""
    if not R2_ENABLED:
        return None
    try:
        client = get_r2_client()
        client.upload_file(str(local_path), R2_BUCKET_NAME, key)
        return client.generate_presigned_url(
            "get_object",
            Params={"Bucket": R2_BUCKET_NAME, "Key": key},
            ExpiresIn=7 * 24 * 3600,  # 7 jours, largement suffisant pour aller récupérer le fichier
        )
    except Exception as e:  # noqa: BLE001
        print(f"[R2] upload échoué pour {key}: {e}")
        return None

# --------------------------------------------------------------------------
# Onglet Admin — auth + proxy vers les scénarios Make (inventaire OneDrive)
# --------------------------------------------------------------------------
# Rien de secret ici : ADMIN_AUTH_SECRET, ADMIN_USERS et les 4 URLs de webhook
# Make sont lus depuis les variables d'environnement Render (Dashboard Render
# > service backend > Environment). Ne JAMAIS les committer dans le repo — le
# front (js/admin.js) ne connaît plus aucun de ces secrets, il ne parle qu'à
# ce backend, qui parle à Make.
ADMIN_AUTH_SECRET = os.environ.get("ADMIN_AUTH_SECRET", "")
ADMIN_USERS_JSON = os.environ.get("ADMIN_USERS", "[]")
ADMIN_TOKEN_TTL_S = 20 * 60  # 20 min

# Base publique de la page de partage externe (Sound Connect) — un service
# Render STATIQUE SÉPARÉ de duchess-hub-front (root directory "public-share/"
# dans le même repo), volontairement sur un autre sous-domaine sans aucun lien
# ni ressource partagée avec le site interne. Raison : un destinataire qui
# tronque l'URL reçue (ex. il ne garde que le domaine) ne doit JAMAIS retomber
# sur le Hub interne (Pitch/Admin/Sound Connect...) — seulement sur cette page
# de partage minimaliste, qui n'affiche rien sans un ?id= valide. Variable
# d'env pour permettre un futur domaine personnalisé sans redéploiement du code.
PUBLIC_SHARE_BASE_URL = os.environ.get("PUBLIC_SHARE_BASE_URL", "https://duchess-share.onrender.com")

MAKE_INVENTAIRE_URLS = {
    "list": os.environ.get("MAKE_INVENTAIRE_LIST_URL", ""),
    "add": os.environ.get("MAKE_INVENTAIRE_ADD_URL", ""),
    "update": os.environ.get("MAKE_INVENTAIRE_UPDATE_URL", ""),
    "delete": os.environ.get("MAKE_INVENTAIRE_DELETE_URL", ""),
}

# Budgets artistes — 3 scénarios Make génériques (fichier entier, pas ligne par ligne, voir
# backend/budget_engine.py pour le pourquoi) : LIST (fichiers du dossier SharePoint dédié),
# DOWNLOAD (contenu binaire brut d'un fichier par itemId), UPLOAD (dépôt binaire multipart,
# conflictBehavior=replace -> upsert par nom de fichier dans ce même dossier).
MAKE_BUDGET_URLS = {
    "list": os.environ.get("MAKE_BUDGET_LIST_URL", ""),
    "download": os.environ.get("MAKE_BUDGET_DOWNLOAD_URL", ""),
    "upload": os.environ.get("MAKE_BUDGET_UPLOAD_URL", ""),
    "rename": os.environ.get("MAKE_BUDGET_RENAME_URL", ""),
}
BUDGET_LOGO_PATH = APP_DIR.parent / "assets" / "logo-white-bg.png"

# Sound Connect — catalogue audio PHONO (voir section dédiée plus bas pour le détail).
# Un seul scénario Make générique "liste le contenu d'un dossier SharePoint donné",
# appelé récursivement par ce backend (pas de logique de parcours côté Make).
MAKE_SOUNDCONNECT_LIST_FOLDER_URL = os.environ.get("MAKE_SOUNDCONNECT_LIST_FOLDER_URL", "")
# Scénario Make "DUCHESS SOUND CONNECT - UPLOAD VERSION" : webhook multipart (file +
# folderId + filename) -> onedrive:uploadAFile dans PHONO (conflictBehavior=rename,
# donc n'écrase jamais un fichier existant). Seul endpoint qui écrit dans PHONO.
MAKE_SOUNDCONNECT_UPLOAD_VERSION_URL = os.environ.get("MAKE_SOUNDCONNECT_UPLOAD_VERSION_URL", "")
PHONO_ROOT_FOLDER_ID = "01B23DVXZSZKHPS7B5PBAJOCZHT5W3RGC5"

# Analyse photo IA (préremplissage du formulaire d'ajout d'inventaire) — clé
# API Anthropic à définir sur Render (Dashboard > service backend > Environment).
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
ANTHROPIC_VISION_MODEL = os.environ.get("ANTHROPIC_VISION_MODEL", "claude-sonnet-5")
ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages"

# Origines autorisées à appeler ce backend depuis le navigateur.
ALLOWED_ORIGINS = [
    "https://duchess-hub-front.onrender.com",
    "https://duchess-hub.netlify.app",  # ancien hébergement, gardé au cas où
    "https://duchess-share.onrender.com",  # page publique de partage externe, service Render séparé (voir PUBLIC_SHARE_BASE_URL)
    "http://localhost:8888",
    "http://127.0.0.1:8888",
]

app = FastAPI(title="Duchess Hub — Sous-titres backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/files", StaticFiles(directory=str(RESULTS_DIR)), name="files")


@app.get("/")
def health():
    return {"ok": True, "service": "duchess-hub-subtitles"}


# --------------------------------------------------------------------------
# Stockage (SQLite — simple, suffisant pour démarrer)
# --------------------------------------------------------------------------


def db():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = db()
    conn.execute(
        """CREATE TABLE IF NOT EXISTS jobs (
            job_id TEXT PRIMARY KEY,
            option TEXT,
            status TEXT,
            current_label TEXT,
            step_received INTEGER DEFAULT 0,
            step_lyrics INTEGER DEFAULT 0,
            step_ass INTEGER DEFAULT 0,
            step_srt INTEGER DEFAULT 0,
            step_render INTEGER DEFAULT 0,
            download_url TEXT,
            error_message TEXT,
            words_json TEXT
        )"""
    )
    # words_json ajouté après coup — ALTER TABLE idempotent pour les bases déjà créées avec
    # l'ancien schéma (le CREATE TABLE IF NOT EXISTS ci-dessus ne migre pas les tables
    # existantes). Utilisé par l'option "preview" (transcription seule, pour l'aperçu vidéo
    # live côté front, sans passer par tout le pipeline SRT/ASS/rendu).
    try:
        conn.execute("ALTER TABLE jobs ADD COLUMN words_json TEXT")
    except sqlite3.OperationalError:
        pass  # colonne déjà présente
    # lyrics_source : diagnostic — flowstage / audio_uploade / audio_uploade_corrige_claude /
    # verifie_manuellement / cache (voir get_or_transcribe/process_job). Permet de savoir, pour
    # un job donné, quel chemin a réellement produit les paroles affichées — sans avoir à deviner.
    try:
        conn.execute("ALTER TABLE jobs ADD COLUMN lyrics_source TEXT")
    except sqlite3.OperationalError:
        pass  # colonne déjà présente
    conn.execute(
        """CREATE TABLE IF NOT EXISTS lyrics_timing (
            single_cle TEXT,
            granularite TEXT,
            timing_json TEXT,
            source_audio TEXT,
            date_generation TEXT,
            PRIMARY KEY (single_cle, granularite)
        )"""
    )
    conn.commit()
    conn.close()


init_db()


def update_job(job_id: str, **fields):
    conn = db()
    keys = ", ".join(f"{k} = ?" for k in fields)
    conn.execute(f"UPDATE jobs SET {keys} WHERE job_id = ?", (*fields.values(), job_id))
    conn.commit()
    conn.close()


def slugify_key(artiste: str, titre: str) -> str:
    s = f"{artiste}_{titre}".lower()
    s = re.sub(r"[^a-z0-9]+", "", s)
    return s[:40] or "single-" + uuid.uuid4().hex[:8]


# --------------------------------------------------------------------------
# Transcription (faster-whisper) + cache par single
# --------------------------------------------------------------------------

_whisper_model = None


def get_whisper_model():
    global _whisper_model
    if _whisper_model is None:
        from faster_whisper import WhisperModel

        _whisper_model = WhisperModel(WHISPER_MODEL_NAME, device="cpu", compute_type="int8")
    return _whisper_model


def transcribe(audio_path: Path, granularity: str):
    model = get_whisper_model()
    segments, _info = model.transcribe(str(audio_path), word_timestamps=True)
    words = []
    for seg in segments:
        if granularity == "mot":
            for w in seg.words or []:
                words.append({"text": w.word.strip(), "start": w.start, "end": w.end})
        else:
            words.append({"text": seg.text.strip(), "start": seg.start, "end": seg.end})
    return words


# --------------------------------------------------------------------------
# Flowstage — retrouver l'aesthetic correspondante + réutiliser ses paroles
# --------------------------------------------------------------------------
# Avant : il fallait taper l'intitulé EXACT (casse comprise) de l'aesthetic Flowstage pour
# la retrouver (limite déjà connue côté Make, voir docs/sous-titres.md). Ici on fait un
# matching flou (accents/casse/ponctuation ignorés, tolère les variations, ignore le code
# numérique en tête du nom style "0006 Toi & Moi") — plus besoin de coller exactement.

_flowstage_aesthetics_cache = {"data": None, "ts": 0.0}


def _normalize_match(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode("ascii")
    s = re.sub(r"^\d{3,6}\s+", "", s)  # retire un éventuel code numérique en tête (ex: "0006 ")
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


def get_flowstage_aesthetics():
    if not FLOWSTAGE_API_KEY:
        return []
    now = time.time()
    if _flowstage_aesthetics_cache["data"] is not None and now - _flowstage_aesthetics_cache["ts"] < 300:
        return _flowstage_aesthetics_cache["data"]
    try:
        r = requests.get(
            f"{FLOWSTAGE_BASE_URL}/v1/aesthetics",
            headers={"X-API-Key": FLOWSTAGE_API_KEY},
            timeout=15,
        )
        r.raise_for_status()
        data = r.json().get("aesthetics", [])
        _flowstage_aesthetics_cache["data"] = data
        _flowstage_aesthetics_cache["ts"] = now
        return data
    except Exception as e:  # noqa: BLE001
        print(f"[Flowstage] liste aesthetics échouée: {e}")
        return []


def find_flowstage_aesthetic(artiste: str, titre: str, aesthetic_hint: str = ""):
    aesthetics = get_flowstage_aesthetics()
    if not aesthetics:
        return None
    # Si l'utilisateur donne directement le nom (ou un fragment) de l'aesthetic Flowstage visée,
    # on la cherche en priorité avec un seuil plus permissif (0.5 au lieu de 0.55) — c'est un
    # choix délibéré de l'utilisateur, pas une devinette artiste/titre, donc moins de risque de
    # faux positif même avec un score plus bas. Si rien de concluant, on retombe sur le matching
    # artiste/titre habituel ci-dessous plutôt que d'abandonner.
    hint_norm = _normalize_match(aesthetic_hint)
    if hint_norm:
        best_hint, best_hint_score = None, 0.0
        for a in aesthetics:
            name_norm = _normalize_match(a.get("name", ""))
            if not name_norm:
                continue
            score = difflib.SequenceMatcher(None, hint_norm, name_norm).ratio()
            if len(hint_norm) >= 3 and hint_norm in name_norm:
                score = max(score, 0.95)
            if score > best_hint_score:
                best_hint_score, best_hint = score, a
        if best_hint and best_hint_score >= 0.5:
            return best_hint

    if not (artiste or "").strip() and not (titre or "").strip():
        return None
    target_full = _normalize_match(f"{artiste} {titre}")
    target_titre = _normalize_match(titre)
    if not target_full and not target_titre:
        return None
    best, best_score = None, 0.0
    for a in aesthetics:
        name_norm = _normalize_match(a.get("name", ""))
        if not name_norm:
            continue
        score = max(
            difflib.SequenceMatcher(None, target_full, name_norm).ratio(),
            difflib.SequenceMatcher(None, target_titre, name_norm).ratio(),
        )
        if target_titre and len(target_titre) >= 3 and target_titre in name_norm:
            score = max(score, 0.9)  # le titre apparaît tel quel dans le nom -> quasi certain
        if score > best_score:
            best_score, best = score, a
    return best if best_score >= 0.55 else None


def _interpolate_words(lines_abs):
    """Découpe chaque ligne Flowstage (texte vérifié, timing de ligne) en mots avec un timing
    interpolé au prorata du nombre de caractères — pas aussi précis qu'un vrai timing mot par
    mot, mais le texte lui-même est garanti juste (contrairement à une transcription auto)."""
    words = []
    for line in lines_abs:
        tokens = line["text"].split()
        if not tokens:
            continue
        total_chars = sum(len(t) for t in tokens) or 1
        duration = max(line["end"] - line["start"], 0.05)
        t = line["start"]
        for tok in tokens:
            frac = len(tok) / total_chars
            w_dur = duration * frac
            words.append({"text": tok, "start": t, "end": t + w_dur})
            t += w_dur
    return words


_WHISPERX_LANG = "fr"


def _whisperx_align_words(phrases, audio_path):
    """Aligne un texte DÉJÀ CONNU comme juste (lignes Flowstage vérifiées, ou lignes corrigées
    par Claude) sur l'audio réel via WhisperX (modèle wav2vec2 de forced alignment) — un timing
    mot par mot bien plus précis (<100ms, testé en direct) que l'interpolation au prorata des
    caractères de `_interpolate_words`, qui n'a elle aucune idée de l'audio réel. Contrairement
    au modèle whisper principal, le modèle d'alignement N'EST PAS gardé en mémoire en permanence
    (~1,4 Go le temps de l'appel, chargé à la demande puis explicitement libéré) pour ne pas
    cumuler avec le modèle whisper (~1,5 Go) + un éventuel burn-in ffmpeg sur le même conteneur
    (risque d'OOM déjà rencontré une fois sur ce projet, voir docs). Renvoie None si l'alignement
    échoue pour n'importe quelle raison (dépendance absente, erreur modèle...) — jamais bloquant,
    l'appelant retombe alors sur `_interpolate_words`."""
    if not phrases or not audio_path:
        return None
    model_a = None
    try:
        import gc
        import whisperx

        model_a, metadata = whisperx.load_align_model(language_code=_WHISPERX_LANG, device="cpu")
        audio = whisperx.load_audio(str(audio_path))
        segments = [{"text": p["text"], "start": p["start"], "end": p["end"]} for p in phrases]
        result = whisperx.align(segments, model_a, metadata, audio, "cpu", return_char_alignments=False)
        words = []
        for seg in result.get("segments", []):
            for w in seg.get("words", []):
                if "start" not in w or "end" not in w:
                    continue  # whisperx omet le timing d'un mot si son score de confiance est trop bas
                words.append({"text": w["word"], "start": float(w["start"]), "end": float(w["end"])})
        return words or None
    except Exception as e:  # noqa: BLE001
        print(f"[WhisperX] alignement échoué, repli sur l'interpolation par caractères: {e}")
        return None
    finally:
        if model_a is not None:
            del model_a
        try:
            import gc
            gc.collect()
        except Exception:  # noqa: BLE001
            pass


def get_flowstage_words(aesthetic_id: str, granularity: str, expected_duration_s: float = 0.0, audio_path=None):
    """Récupère les paroles de l'aesthetic Flowstage donnée.

    Piège découvert en test réel : le champ "audios" d'une aesthetic ne contient pas forcément
    le morceau entier — certaines entrées sont en fait un CLIP découpé du single (nom du type
    "... -clip-51s-84s", quelques dizaines de secondes) dont les timestamps de lignes sont
    relatifs au DÉBUT DU CLIP, pas au morceau original. Si on applique ces temps tels quels à
    une vidéo qui couvre une autre portion (ou la totalité) du morceau, les sous-titres tombent
    n'importe quand et la majorité de la vidéo n'a plus aucune ligne (symptômes rapportés :
    "pas du tout dans les temps" + "beaucoup manquent"). Pour éviter ça, on ne fait confiance à
    un audio Flowstage que si sa durée colle à peu près à celle de l'audio réellement uploadé
    (`expected_duration_s`, calculée juste avant l'appel) — sinon on laisse `get_or_transcribe`
    retomber sur faster-whisper plutôt que de servir un timing garanti faux."""
    try:
        r = requests.get(
            f"{FLOWSTAGE_BASE_URL}/v1/aesthetics/{aesthetic_id}/audios",
            headers={"X-API-Key": FLOWSTAGE_API_KEY},
            timeout=20,
        )
        r.raise_for_status()
        audios = r.json().get("audios", [])
    except Exception as e:  # noqa: BLE001
        print(f"[Flowstage] récupération paroles échouée: {e}")
        return None

    if not audios:
        return None

    # S'il y a plusieurs entrées "audios" pour cette aesthetic, on prend celle dont la durée
    # colle le mieux à l'audio uploadé (le plus souvent il n'y en a qu'une, mais autant être
    # robuste). Tolérance : 3s ou 3% de la durée attendue, le plus grand des deux — assez
    # serré pour distinguer un clip de 30s du morceau entier de 3 min, assez large pour
    # absorber les petits écarts d'encodage entre l'audio Flowstage et l'upload de Michel.
    best_audio, best_diff = None, None
    for audio in audios:
        dur = audio.get("duration") or 0
        diff = abs(dur - expected_duration_s) if expected_duration_s else 0
        if best_diff is None or diff < best_diff:
            best_audio, best_diff = audio, diff

    if expected_duration_s and best_audio is not None:
        tolerance = max(3.0, 0.03 * expected_duration_s)
        if best_diff is not None and best_diff > tolerance:
            print(
                f"[Flowstage] audio '{best_audio.get('name')}' rejeté : durée "
                f"{best_audio.get('duration')}s vs upload {expected_duration_s:.1f}s "
                f"(écart {best_diff:.1f}s > tolérance {tolerance:.1f}s) — probablement un clip "
                f"partiel du morceau, pas le fichier uploadé. Repli sur la transcription."
            )
            return None

    lines_abs = []
    for section in (best_audio or {}).get("sections", []):
        sec_start = section.get("start_time", 0) or 0
        for line in section.get("lines", []):
            text = (line.get("text") or "").strip()
            if not text:
                continue
            lines_abs.append({
                "text": text,
                "start": sec_start + (line.get("start_time", 0) or 0),
                "end": sec_start + (line.get("end_time", 0) or 0),
            })
    lines_abs.sort(key=lambda l: l["start"])
    if not lines_abs:
        return None

    if granularity == "phrase":
        return lines_abs
    return _whisperx_align_words(lines_abs, audio_path) or _interpolate_words(lines_abs)


def get_flowstage_reference_text(aesthetic_id: str) -> str:
    """Texte brut des paroles Flowstage d'une aesthetic, SANS tenir compte du garde-fou de durée
    de get_flowstage_words() — utilisé comme `reference_lyrics` automatique quand l'aesthetic est
    bien trouvée mais qu'aucun audio Flowstage ne correspond en durée à l'upload (cas réel
    rencontré : un extrait TikTok de 32s pour un morceau Flowstage de 147s — le garde-fou rejette
    à raison le TIMING de l'audio complet, mais le TEXTE, lui, reste juste et vaut la peine
    d'être récupéré plutôt que jeté). On prend l'audio de plus longue durée (le plus souvent le
    morceau complet plutôt qu'un extrait) et on renvoie ses lignes telles quelles, une par ligne
    — à charge de correct_lyrics_with_claude() de n'aligner que les lignes qui correspondent
    réellement à l'extrait transcrit. Renvoie "" si indisponible (jamais bloquant)."""
    try:
        r = requests.get(
            f"{FLOWSTAGE_BASE_URL}/v1/aesthetics/{aesthetic_id}/audios",
            headers={"X-API-Key": FLOWSTAGE_API_KEY},
            timeout=20,
        )
        r.raise_for_status()
        audios = r.json().get("audios", [])
    except Exception as e:  # noqa: BLE001
        print(f"[Flowstage] récupération texte de référence échouée: {e}")
        return ""
    if not audios:
        return ""
    best_audio = max(audios, key=lambda a: a.get("duration") or 0)
    lines = []
    for section in (best_audio or {}).get("sections", []):
        for line in section.get("lines", []):
            text = (line.get("text") or "").strip()
            if text:
                lines.append(text)
    return "\n".join(lines)


def _cache_timing(single_cle: str, granularity: str, words, source: str):
    conn = db()
    conn.execute(
        "INSERT OR REPLACE INTO lyrics_timing VALUES (?, ?, ?, ?, ?)",
        (single_cle, granularity, json.dumps(words), source, datetime.datetime.utcnow().isoformat()),
    )
    conn.commit()
    conn.close()


def _probe_audio_duration(audio_path: Path) -> float:
    try:
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(audio_path)],
            capture_output=True, text=True,
        )
        return float((probe.stdout or "0").strip() or 0)
    except Exception:  # noqa: BLE001
        return 0.0


_GLUE_CHARS = ("'", "’", "-")


def _merge_apostrophe_words(words):
    """Règle permanente : en français, l'apostrophe (et le trait d'union dans un mot composé)
    ne sont jamais des séparateurs de mot ("c'est", "s'aiment", "j'aurais", "rendez-vous"
    doivent rester UN SEUL mot). faster-whisper peut renvoyer ces contractions comme deux tokens
    distincts avec leurs propres timestamps — et pas toujours dans le même sens : parfois le
    fragment précédent se termine par l'apostrophe ("c'" puis "est"), parfois c'est le fragment
    suivant qui COMMENCE par elle ("c" puis "'est", constaté en test réel — d'où le bug initial
    qui ne vérifiait que le premier cas). On fusionne ici dans les deux sens, une bonne fois pour
    toutes, avant la mise en cache. Comme ce point est appelé sur tous les chemins (whisper ET
    Flowstage) avant `_cache_timing`, toute la suite (aperçu live, édition manuelle, rendu final)
    en profite automatiquement."""
    if not words:
        return words
    merged = []
    for w in words:
        text = (w.get("text") or "")
        stripped = text.strip()
        starts_with_glue = len(stripped) > 1 and stripped[0] in _GLUE_CHARS
        prev = merged[-1] if merged else None
        prev_ends_with_glue = bool(prev and prev["text"] and prev["text"][-1] in _GLUE_CHARS)
        if prev and (starts_with_glue or prev_ends_with_glue):
            prev["text"] += stripped
            prev["end"] = w.get("end", prev["end"])
        else:
            merged.append(dict(w))
    return merged


def get_or_transcribe(single_cle: str, granularity: str, audio_path: Path, artiste: str = "", titre: str = "", reference_lyrics: str = "", aesthetic_hint: str = ""):
    """Source des paroles timées, par ordre de préférence :
    1. Cache local (déjà généré une fois, peu importe la source d'origine).
    2. Flowstage (paroles vérifiées manuellement, bien plus fiables qu'une transcription
       automatique — voir find_flowstage_aesthetic / get_flowstage_words). Rejetée si la durée
       de l'audio Flowstage ne colle pas à celle de l'upload (voir get_flowstage_words) — un
       "audio" Flowstage peut n'être qu'un clip partiel du morceau, pas le morceau entier.
    3. Repli : transcription faster-whisper de l'audio uploadé, puis passée à
       _apply_claude_correction() si ANTHROPIC_API_KEY est configurée (corrige les homophones
       classiques du français sans jamais toucher au style/argot volontaire).

    `reference_lyrics` (optionnel) : vraies paroles collées par l'utilisateur — voir
    correct_lyrics_with_claude(). Testé en direct : rattrape des erreurs qu'aucun réglage whisper
    ni correction grammaticale seule ne peut deviner (mot entier mal entendu, "il" à la place de
    "elle"...). Un plafond de qualité a été confirmé empiriquement : passer whisper de "medium" à
    "large-v3" et/ou activer `vad_filter` n'améliore PAS la transcription sur l'audio ARK réel
    (voix + instru chargée) — `vad_filter=True` a même dégradé un test réel (26s de paroles
    réduites à une seule ligne bâclée). Le vrai levier quand l'écart persiste, c'est ce paramètre.

    Renvoie un tuple (words, source) — `source` sert uniquement au diagnostic (exposé via
    `lyrics_source` dans /jobs/{job_id}, voir process_job) pour savoir sans deviner par quel
    chemin les paroles affichées sont réellement passées."""
    conn = db()
    row = conn.execute(
        "SELECT timing_json, source_audio FROM lyrics_timing WHERE single_cle = ? AND granularite = ?",
        (single_cle, granularity),
    ).fetchone()
    conn.close()
    if row:
        words = json.loads(row["timing_json"])
        source = row["source_audio"] or "cache"
        # Un hint d'aesthetic Flowstage fourni APRÈS coup (le cache contient une transcription
        # whisper parce que le matching flou automatique n'avait rien trouvé) doit pouvoir
        # débloquer les vraies paroles Flowstage sans attendre — on retente Flowstage en priorité
        # avant l'upgrade paresseux ci-dessous.
        if aesthetic_hint.strip() and source != "flowstage" and source != "verifie_manuellement" and FLOWSTAGE_API_KEY:
            aesthetic = find_flowstage_aesthetic(artiste, titre, aesthetic_hint)
            if aesthetic:
                expected_duration = _probe_audio_duration(audio_path)
                fs_words = get_flowstage_words(aesthetic["id"], granularity, expected_duration_s=expected_duration, audio_path=audio_path)
                if fs_words:
                    fs_words = _merge_apostrophe_words(fs_words)
                    _cache_timing(single_cle, granularity, fs_words, "flowstage")
                    return fs_words, "flowstage"
                # Aesthetic trouvée mais timing Flowstage rejeté (durée ne colle pas — cas réel :
                # extrait TikTok de 32s pour un morceau Flowstage de 147s). Le TEXTE reste juste,
                # lui — on l'utilise comme référence automatique pour la correction Claude plutôt
                # que de tout jeter (voir get_flowstage_reference_text).
                if not reference_lyrics.strip():
                    reference_lyrics = get_flowstage_reference_text(aesthetic["id"])
        # Upgrade paresseux : une entrée déjà en cache en "audio_uploade" (whisper brut, jamais
        # corrigé — soit un cache antérieur à l'ajout de la correction Claude, soit une tentative
        # de correction qui avait échoué à l'époque) est retentée maintenant si une clé Anthropic
        # est disponible, au lieu de servir indéfiniment le même texte non corrigé. Sans ça, un
        # single déjà transcrit une fois avant ce fix restait bloqué en whisper brut pour toujours,
        # même après un redéploiement avec la correction Claude qui fonctionne. Un bloc de
        # référence nouvellement fourni redéclenche aussi la correction même si une passe
        # grammaticale seule avait déjà tourné ("audio_uploade_corrige_claude") — la référence
        # peut rattraper des erreurs que la grammaire seule ne pouvait pas voir.
        needs_retry = source == "audio_uploade" or (source == "audio_uploade_corrige_claude" and reference_lyrics.strip())
        if needs_retry and ANTHROPIC_API_KEY:
            corrected = _apply_claude_correction(words, granularity, artiste, titre, reference_lyrics, audio_path)
            if corrected:
                words = corrected
                source = "audio_uploade_corrige_claude"
                _cache_timing(single_cle, granularity, words, source)
        return words, source

    if FLOWSTAGE_API_KEY:
        aesthetic = find_flowstage_aesthetic(artiste, titre, aesthetic_hint)
        if aesthetic:
            expected_duration = _probe_audio_duration(audio_path)
            words = get_flowstage_words(aesthetic["id"], granularity, expected_duration_s=expected_duration, audio_path=audio_path)
            if words:
                words = _merge_apostrophe_words(words)
                _cache_timing(single_cle, granularity, words, "flowstage")
                return words, "flowstage"
            # Aesthetic trouvée mais timing Flowstage rejeté (durée ne colle pas — cas réel :
            # extrait TikTok de 32s pour un morceau Flowstage de 147s). Le TEXTE reste juste,
            # lui — on l'utilise comme référence automatique pour la correction Claude plutôt
            # que de tout jeter (voir get_flowstage_reference_text).
            if not reference_lyrics.strip():
                reference_lyrics = get_flowstage_reference_text(aesthetic["id"])

    words = transcribe(audio_path, granularity)
    words = _merge_apostrophe_words(words)
    source = "audio_uploade"
    corrected = _apply_claude_correction(words, granularity, artiste, titre, reference_lyrics, audio_path)
    if corrected:
        words = corrected
        source = "audio_uploade_corrige_claude"
    _cache_timing(single_cle, granularity, words, source)
    return words, source


def _words_to_phrases(words, gap_threshold: float = 0.4):
    """Reconstruit des "phrases" (comme la granularité "phrase") à partir d'une liste de MOTS —
    utilisé quand l'utilisateur a corrigé les paroles dans l'éditeur de vérification (§ Vérifier
    les paroles), qui travaille toujours au niveau mot, mais que le mode "Phrase entière" ou
    l'export .srt attendent des lignes complètes. Heuristique simple : un silence de plus de
    `gap_threshold` secondes entre deux mots marque une nouvelle ligne."""
    if not words:
        return []
    phrases = []
    cur = [words[0]]
    for w in words[1:]:
        if w["start"] - cur[-1]["end"] > gap_threshold:
            phrases.append(cur)
            cur = []
        cur.append(w)
    if cur:
        phrases.append(cur)
    return [
        {"text": " ".join(w["text"] for w in p), "start": p[0]["start"], "end": p[-1]["end"]}
        for p in phrases
    ]


def correct_lyrics_with_claude(phrases, artiste: str = "", titre: str = "", reference_lyrics: str = ""):
    """Corrige les fautes de transcription whisper (homophones classiques du français —
    "il s'aime"/"ils s'aiment", "ces"/"ses"/"c'est"...) via l'API Claude, ligne par ligne, avec
    tout le contexte du morceau dans le même appel. Ne touche volontairement PAS au style : les
    lyrics ARK sont urbaines/argot, le langage familier est intentionnel et doit rester tel quel
    — seule une vraie erreur de transcription doit être corrigée. Renvoie None (repli silencieux
    sur le texte whisper d'origine, jamais bloquant) si la clé n'est pas configurée, si l'appel
    échoue, ou si Claude ne renvoie pas exactement le même nombre de lignes qu'en entrée.

    `reference_lyrics` (optionnel) : bloc de texte fourni par l'utilisateur avec les VRAIES
    paroles du morceau (ou d'un extrait plus large) — quand fourni, Claude aligne en priorité
    chaque ligne transcrite sur la ligne de référence correspondante quand il est raisonnablement
    sûr qu'elles correspondent, ce qui rattrape des erreurs qu'une correction purement
    grammaticale ne peut pas deviner (mot entier mal entendu, confusion il/elle non homophone,
    etc.) — testé en direct : la correction seule ratait "il remet" au lieu de "elle remet" et
    "et le matin" au lieu de "dès le matin" (aucune des deux n'est une simple faute d'accord),
    la version avec référence corrige les deux. Les lignes transcrites qui ne correspondent à
    aucune ligne de la référence (partie du morceau non couverte par l'extrait fourni) retombent
    sur la correction grammaticale habituelle, jamais sur une invention."""
    if not ANTHROPIC_API_KEY or not phrases or not ENABLE_CLAUDE_CORRECTION:
        return None
    try:
        import anthropic

        client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
        numbered = "\n".join(f"{i + 1}. {p['text']}" for i, p in enumerate(phrases))
        contexte = ""
        if titre:
            contexte += f' du morceau "{titre}"'
        if artiste:
            contexte += f" de {artiste}"
        prompt = (
            "Voici une transcription automatique (whisper) de paroles de chanson"
            f"{contexte}, ligne par ligne. C'est un premier jet imparfait : whisper confond "
            "régulièrement des homophones français qui changent le SENS grammatical, en "
            "particulier le singulier/pluriel et les accords sujet-verbe — par exemple "
            "\"il s'aime\" transcrit à la place de \"ils s'aiment\" (identiques à l'oreille), "
            "\"ces\"/\"ses\"/\"c'est\", \"la\"/\"là\"/\"l'a\", des verbes conjugués au mauvais "
            "nombre, des mots entiers mal entendus dans le bruit.\n\n"
            "Ta tâche : repérer et corriger ces vraies erreurs de transcription, en particulier "
            "les erreurs d'accord (singulier/pluriel, sujet-verbe) — ce sont les plus fréquentes "
            "et les plus faciles à rater. Aide-toi du CONTEXTE ENTIER : si une même ligne (ou "
            "une ligne très proche) revient plusieurs fois dans l'extrait comme un refrain, "
            "vérifie qu'elle est transcrite de façon cohérente partout ; si le sens général de "
            "l'extrait suggère clairement un sujet pluriel ailleurs, corrige les occurrences "
            "isolées qui ont été transcrites au singulier par erreur acoustique.\n\n"
            "Ce qu'il ne faut PAS toucher : le style, l'argot, les tournures familières ou les "
            "libertés grammaticales VOLONTAIRES du langage parlé/rap (ex: \"j'connais pas\", "
            "double négation absente, mots de verlan) — ça, c'est le choix de l'artiste, laisse-le "
            "tel quel. La différence à faire : une erreur d'ACCORD GRAMMATICAL (nombre, genre, "
            "conjugaison) presque toujours involontaire dans un texte écrit → tu corriges. Un "
            "choix de VOCABULAIRE ou de REGISTRE familier → tu laisses.\n\n"
            "L'extrait fourni peut être très court — parfois une seule ligne isolée, sans "
            "refrain ni contexte autour. C'est normal et volontaire (c'est un extrait, pas la "
            "chanson entière) : ne demande JAMAIS plus de contexte, ne pose AUCUNE question, "
            "ne renvoie AUCUN commentaire, préambule ou explication, même si une seule ligne "
            "est fournie. Corrige cette ligne unique du mieux que tu peux avec ce que tu as "
            "(bon sens grammatical), ou renvoie-la identique si tu n'es pas sûr — mais renvoie "
            "TOUJOURS exactement une ligne corrigée par ligne reçue, jamais une question, "
            "jamais un refus.\n\n"
        )
        if reference_lyrics.strip():
            prompt += (
                "Voici aussi, séparément, les VRAIES paroles de ce morceau (ou d'un extrait plus "
                "large de ce morceau), fournies par l'utilisateur — à traiter comme la source de "
                "vérité ABSOLUE quand une ligne transcrite correspond à l'une d'elles, prioritaire "
                "sur toute autre règle de correction ci-dessus :\n\n"
                f"{reference_lyrics.strip()}\n\n"
                "Pour CHAQUE ligne transcrite numérotée : si tu es raisonnablement sûr qu'elle "
                "correspond à une ligne des vraies paroles (même approximativement — refrain "
                "répété plusieurs fois, ordre des mots légèrement différent à cause du "
                "découpage whisper, etc.), remplace-la par le texte EXACT de la vraie ligne "
                "correspondante, même si la différence n'est pas une simple faute d'accord "
                "(mot entier mal entendu, pronom différent, ordre des mots...). Si une ligne "
                "transcrite ne correspond à AUCUNE ligne des vraies paroles fournies "
                "(probablement une partie du morceau non couverte par cet extrait de "
                "référence), applique seulement les règles de correction grammaticale "
                "habituelles ci-dessus — n'invente jamais une ligne de référence qui n'existe "
                "pas dans le bloc fourni.\n\n"
            )
        prompt += (
            "Renvoie EXACTEMENT le même nombre de lignes, dans le même ordre, numérotées "
            "pareil, sans aucun commentaire ni explication avant/après — juste les lignes, "
            "corrigées ou identiques si rien à corriger.\n\n"
            f"{numbered}"
        )
        resp = client.messages.create(
            model=CLAUDE_LYRICS_MODEL,
            max_tokens=4000,
            system=(
                "Tu es un outil de transformation de texte automatisé, pas un assistant "
                "conversationnel. Tu reçois toujours une liste de lignes numérotées et tu dois "
                "TOUJOURS renvoyer exactement le même nombre de lignes numérotées, sans jamais "
                "poser de question ni demander de contexte supplémentaire, même face à une "
                "seule ligne isolée sans contexte. Aucune réponse de type question, refus ou "
                "commentaire n'est acceptable : seules des lignes numérotées en sortie le sont."
            ),
            # claude-sonnet-5 réfléchit par défaut avant de répondre (bloc "thinking" séparé du
            # bloc "text" dans resp.content, décompté du même budget max_tokens) — testé en
            # direct : sur ce genre de tâche de correction ciblée, la réflexion étendue n'apporte
            # rien (même qualité de correction avec/sans) mais coûte ~15x plus de tokens et peut
            # carrément manger tout le budget avant d'écrire la réponse sur un petit extrait
            # (vécu : max_tokens=2000, stop_reason="max_tokens", aucun bloc texte -> crash). On
            # la désactive explicitement.
            thinking={"type": "disabled"},
            messages=[{"role": "user", "content": prompt}],
        )
        # Ne pas supposer que content[0] est le texte (robuste même si un bloc "thinking"
        # apparaissait malgré tout) — on va chercher explicitement le(s) bloc(s) "text".
        raw = "".join(getattr(b, "text", "") or "" for b in resp.content if getattr(b, "type", None) == "text")
        if not raw.strip():
            print(f"[Claude] pas de bloc texte dans la réponse (stop_reason={resp.stop_reason}) — correction ignorée.")
            return None
        cleaned = [re.sub(r"^\d+[.)]\s*", "", l.strip()) for l in raw.strip().splitlines() if l.strip()]
        if len(cleaned) != len(phrases):
            print(f"[Claude] nombre de lignes différent ({len(cleaned)} vs {len(phrases)}) — correction ignorée.")
            return None
        return cleaned
    except Exception as e:  # noqa: BLE001
        print(f"[Claude] correction échouée: {e}")
        return None


def _apply_claude_correction(words, granularity: str, artiste: str = "", titre: str = "", reference_lyrics: str = "", audio_path=None):
    """Applique correct_lyrics_with_claude() sur une liste de mots OU de phrases (selon
    `granularity`) et reconstruit le même format en sortie. Pour la granularité "mot", le
    timing mot par mot est recalculé à partir des lignes corrigées via WhisperX (alignement
    forcé sur l'audio réel, <100ms de précision — voir _whisperx_align_words) si `audio_path`
    est fourni, sinon on retombe sur l'interpolation au prorata des caractères
    (_interpolate_words, moins précise mais ne dépend pas d'avoir le fichier audio sous la
    main). Renvoie None si la correction n'a pas pu être appliquée (clé absente, échec API,
    désaccord de nombre de lignes)."""
    if not ANTHROPIC_API_KEY or not words or not ENABLE_CLAUDE_CORRECTION:
        return None
    phrases = words if granularity == "phrase" else _words_to_phrases(words)
    if not phrases:
        return None
    corrected_texts = correct_lyrics_with_claude(phrases, artiste, titre, reference_lyrics)
    if not corrected_texts:
        return None
    corrected_phrases = [
        {"text": t, "start": p["start"], "end": p["end"]}
        for t, p in zip(corrected_texts, phrases)
    ]
    if granularity == "phrase":
        return corrected_phrases
    return _whisperx_align_words(corrected_phrases, audio_path) or _interpolate_words(corrected_phrases)


# --------------------------------------------------------------------------
# Génération .srt (Option 1)
# --------------------------------------------------------------------------


def _srt_ts(t: float) -> str:
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = t % 60
    return f"{h:02d}:{m:02d}:{s:06.3f}".replace(".", ",")


def build_srt(words) -> str:
    lines = []
    for i, w in enumerate(words, start=1):
        lines.append(f"{i}\n{_srt_ts(w['start'])} --> {_srt_ts(w['end'])}\n{w['text']}\n")
    return "\n".join(lines)


# --------------------------------------------------------------------------
# Génération .ass (Option 2) — 6 modes d'apparition, réglages étendus
# --------------------------------------------------------------------------

# Métadonnées par police : ratio largeur-caractère/taille (heuristique, pour l'auto-fit
# qui empêche les mots longs de déborder du cadre) + casse par défaut la plus lisible.
# Ces polices doivent être installées dans l'image Docker du backend (voir Dockerfile) —
# sinon libass substitue une police par défaut et le rendu ne correspond plus au choix fait
# côté front.
FONT_META = {
    "Poppins": {"ratio": 0.62, "allcaps": True, "category": "Sans"},
    "Playfair Display": {"ratio": 0.60, "allcaps": True, "category": "Serif"},
    "Bebas Neue": {"ratio": 0.42, "allcaps": True, "category": "Condensé"},
    "Space Grotesk": {"ratio": 0.58, "allcaps": True, "category": "Sans"},
    "Inter": {"ratio": 0.56, "allcaps": True, "category": "Sans"},
    "Anton": {"ratio": 0.48, "allcaps": True, "category": "Condensé"},
    "Oswald": {"ratio": 0.46, "allcaps": True, "category": "Condensé"},
    "Caveat": {"ratio": 0.42, "allcaps": False, "category": "Manuscrite"},
    "Montserrat": {"ratio": 0.58, "allcaps": True, "category": "Sans"},
    "Archivo Black": {"ratio": 0.64, "allcaps": True, "category": "Display"},
    "Bangers": {"ratio": 0.50, "allcaps": True, "category": "Display"},
    "Righteous": {"ratio": 0.55, "allcaps": True, "category": "Display"},
    "Roboto Condensed": {"ratio": 0.46, "allcaps": True, "category": "Condensé"},
    "Luckiest Guy": {"ratio": 0.56, "allcaps": True, "category": "Display"},
    "Permanent Marker": {"ratio": 0.52, "allcaps": False, "category": "Manuscrite"},
}
DEFAULT_FONT_META = {"ratio": 0.58, "allcaps": True, "category": "Sans"}


def _ass_ts(t: float) -> str:
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = t % 60
    return f"{h:d}:{m:02d}:{s:05.2f}"


def _ass_color(hex_str: str) -> str:
    h = (hex_str or "#ffffff").lstrip("#")
    if len(h) != 6:
        h = "ffffff"
    r, g, b = h[0:2], h[2:4], h[4:6]
    return f"&H00{b}{g}{r}"  # ASS = &HAABBGGRR, AA=00 -> opaque


def _fit_font_size(text_lines, base_size, ratio, avail_width, min_ratio=0.35):
    """Réduit la taille de police pour ce cue précis si le mot/la ligne la plus longue
    dépasserait la largeur du cadre — évite le clipping des mots longs (ex: TRANSCRIPTION)
    sans toucher à la taille globale choisie par l'utilisateur pour les autres cues."""
    longest = max((len(l) for l in text_lines), default=0)
    if longest == 0:
        return base_size
    est_width = longest * base_size * ratio
    if est_width <= avail_width:
        return base_size
    scaled = avail_width / (longest * ratio)
    return max(int(base_size * min_ratio), int(scaled))


def _position_anchor(position, video_h, marginv):
    x = 540  # PlayResX / 2
    if position == "bas":
        y = video_h - marginv
    elif position == "haut":
        y = marginv
    else:
        y = video_h // 2
    return x, y


def _effect_tag(effect, duration_s, x, y):
    """Tags ASS additionnels appliqués à un cue pour l'effet d'apparition choisi."""
    if effect == "fade":
        ms = max(60, min(220, int(duration_s * 1000 * 0.3)))
        return f"\\fad({ms},{ms})"
    if effect == "pop":
        return "\\t(0,110,\\fscx116\\fscy116)\\t(110,200,\\fscx100\\fscy100)"
    if effect == "slide":
        return f"\\move({x},{y + 55},{x},{y},0,160)"
    return ""


def _wrap_build_line(group):
    """Découpe le texte cumulé du groupe en 1 ou 2 lignes courtes (façon 'IL REMET' / 'RENDEZ-VOUS')."""
    text = " ".join(x["text"] for x in group)
    words = text.split(" ")
    if len(words) <= 2:
        return [text]
    mid = len(words) // 2 + (len(words) % 2)
    return [" ".join(words[:mid]), " ".join(words[mid:])]


def build_ass(
    words,
    mode: str,
    font: str,
    font_weight: str,
    size_pct: float,
    color_hex: str,
    video_h: int = 1920,
    position: str = "centre",
    effect: str = "none",
    outline_color_hex: str = "#000000",
    outline_width: str = "normal",
    fond: str = "contour",
    text_case: str = "majuscule",
    accent_color_hex: str = "#ffd400",
    italic: bool = False,
    words_per_group: int = 3,
) -> str:
    words_per_group = max(1, min(8, int(words_per_group or 3)))
    karaoke_group_size = max(2, words_per_group)  # une ligne karaoké d'1 seul mot n'a pas de sens
    primary = _ass_color(color_hex)
    outline_c = _ass_color(outline_color_hex)
    accent = _ass_color(accent_color_hex)

    font_clean = font.split(",")[0].strip().strip("'").strip('"')
    meta = FONT_META.get(font_clean, DEFAULT_FONT_META)
    ratio = meta["ratio"]

    base_size = max(10, int(video_h * (size_pct / 100.0)))
    bold = -1 if int(font_weight) >= 700 else 0

    align = {"bas": 2, "haut": 8}.get(position, 5)
    marginv = max(60, int(video_h * 0.06))
    margin_lr = 36
    avail_width = 1080 - (margin_lr * 2)

    width_map = {"fin": 1, "normal": 2, "epais": 4, "aucun": 0}
    outline_px = width_map.get(outline_width, 2)
    border_style = 3 if fond == "plaque" else 1
    if fond == "aucun":
        outline_px = 0
        shadow = 0
    else:
        shadow = 1 if border_style == 1 else 0
    if border_style == 3:
        outline_px = max(outline_px, 6)  # padding minimum autour du texte pour que la plaque soit lisible

    back_colour = outline_c if border_style == 3 else "&HFF000000"

    header = (
        "[Script Info]\n"
        "ScriptType: v4.00+\n"
        f"PlayResX: 1080\nPlayResY: {video_h}\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Italic, "
        "BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV\n"
        f"Style: Default,{font_clean},{base_size},{primary},{outline_c},{back_colour},{bold},{-1 if italic else 0},"
        f"{border_style},{outline_px},{shadow},{align},{margin_lr},{margin_lr},{marginv}\n"
        "[Events]\n"
        "Format: Layer, Start, End, Style, Text\n"
    )

    x_anchor, y_anchor = _position_anchor(position, video_h, marginv)

    def apply_case(s):
        """Appliqué mot par mot (jamais sur un bloc multi-lignes déjà joint par \\N — sinon la
        casse "Première lettre" ne capitalise que le tout premier caractère du bloc entier)."""
        if text_case == "majuscule":
            return s.upper()
        if text_case == "capitalize":
            def cap_word(w):
                return "-".join((p[:1].upper() + p[1:].lower()) if p else p for p in w.split("-"))
            return " ".join(cap_word(w) for w in s.split(" "))
        return s

    def cue(start, end, text_lines):
        cased_lines = [apply_case(l) for l in text_lines]
        text = r"\N".join(cased_lines)
        fit_size = _fit_font_size(cased_lines, base_size, ratio, avail_width)
        tags = f"\\fs{fit_size}" + _effect_tag(effect, max(end - start, 0.05), x_anchor, y_anchor)
        return f"Dialogue: 0,{_ass_ts(start)},{_ass_ts(end)},Default,{{{tags}}}{text}"

    def next_start(items, i, fallback_end):
        end = items[i + 1]["start"] if i + 1 < len(items) else fallback_end
        return end if end > items[i]["start"] else items[i]["end"]

    lines = []

    if mode == "full":
        for w in words:
            lines.append(cue(w["start"], w["end"], [w["text"]]))

    elif mode == "replace":
        for w in words:
            lines.append(cue(w["start"], w["end"], [w["text"]]))

    elif mode == "build_vertical":
        # Chaque mot s'ajoute sur sa PROPRE ligne, empilé verticalement (reset tous les
        # `words_per_group` mots).
        group = []
        for i, w in enumerate(words):
            group.append(w)
            end = next_start(words, i, w["end"])
            lines.append(cue(w["start"], end, [x["text"] for x in group]))
            if len(group) >= words_per_group:
                group = []

    elif mode == "stack":
        # "L'une au-dessus de l'autre" : pile déroulante des 3 dernières mini-lignes
        # (`words_per_group` mots chacune), la plus récente en bas, les précédentes remontent
        # au-dessus.
        chunks, cur = [], []
        for w in words:
            cur.append(w)
            if len(cur) >= words_per_group:
                chunks.append(cur)
                cur = []
        if cur:
            chunks.append(cur)
        window = []
        for ci, chunk in enumerate(chunks):
            window.append(chunk)
            if len(window) > 3:
                window.pop(0)
            start = chunk[0]["start"]
            end = chunks[ci + 1][0]["start"] if ci + 1 < len(chunks) else chunk[-1]["end"]
            if end <= start:
                end = chunk[-1]["end"]
            text_lines = [" ".join(x["text"] for x in c) for c in window]
            lines.append(cue(start, end, text_lines))

    elif mode == "karaoke":
        # La ligne complète reste affichée, le mot en cours de lecture est surligné (couleur accent).
        groups, cur = [], []
        for w in words:
            cur.append(w)
            if len(cur) >= karaoke_group_size:
                groups.append(cur)
                cur = []
        if cur:
            groups.append(cur)
        for group in groups:
            plain_line = " ".join(apply_case(gw["text"]) for gw in group)
            fit_size = _fit_font_size([plain_line], base_size, ratio, avail_width)
            for i, w in enumerate(group):
                start = w["start"]
                end = group[i + 1]["start"] if i + 1 < len(group) else w["end"]
                if end <= start:
                    end = w["end"]
                parts = []
                for gw in group:
                    t = apply_case(gw["text"])
                    parts.append(f"{{\\c{accent}}}{t}{{\\c{primary}}}" if gw is w else t)
                text = " ".join(parts)
                tags = f"\\fs{fit_size}" + _effect_tag(effect, max(end - start, 0.05), x_anchor, y_anchor)
                lines.append(f"Dialogue: 0,{_ass_ts(start)},{_ass_ts(end)},Default,{{{tags}}}{text}")

    else:  # "build" (défaut) — la ligne se construit mot après mot, wrap sur 2 lignes max,
        # reset tous les `words_per_group` mots
        group = []
        for i, w in enumerate(words):
            group.append(w)
            end = next_start(words, i, w["end"])
            lines.append(cue(w["start"], end, _wrap_build_line(group)))
            if len(group) >= words_per_group:
                group = []

    return header + "\n".join(lines) + "\n"


# --------------------------------------------------------------------------
# Traitement du job (thread d'arrière-plan)
# --------------------------------------------------------------------------


def run(cmd):
    subprocess.run(cmd, check=True, capture_output=True)


def process_job(
    job_id, option, artiste, titre, upload_path: Path, font, font_weight, size_pct, color, mode,
    position="centre", effect="none", outline_color="#000000", outline_width="normal",
    fond="contour", text_case="majuscule", accent_color="#ffd400", italic=False, words_per_group=3,
    edited_words="", reference_lyrics="", aesthetic_hint="",
):
    try:
        if option == "preview":
            granularity = "mot"  # le live-preview a besoin du timing mot par mot, quel que soit le mode
        else:
            granularity = "mot" if (option == "video" and mode != "full") else "phrase"
        single_cle = slugify_key(artiste, titre)

        audio_path = DATA_DIR / f"{job_id}_audio.wav"
        run(["ffmpeg", "-y", "-i", str(upload_path), "-vn", "-ac", "1", "-ar", "16000", str(audio_path)])

        # Si l'utilisateur a corrigé les paroles dans l'éditeur de vérification (mots + timing,
        # toujours au niveau mot), on utilise SA version telle quelle au lieu de retranscrire —
        # et on l'enregistre dans le cache pour que les prochains jobs sur ce single en profitent
        # aussi. L'éditeur travaille au niveau mot : si la granularité demandée ici est "phrase"
        # (mode "Phrase entière" ou export .srt), on reconstruit des lignes à partir des mots
        # corrigés (silence > 0.6s = nouvelle ligne) plutôt que de perdre les corrections.
        edited = None
        if edited_words:
            try:
                edited = json.loads(edited_words)
            except (TypeError, ValueError):
                edited = None

        if edited:
            words = edited if granularity == "mot" else _words_to_phrases(edited)
            lyrics_source = "verifie_manuellement"
            _cache_timing(single_cle, granularity, words, lyrics_source)
        else:
            words, lyrics_source = get_or_transcribe(
                single_cle, granularity, audio_path, artiste=artiste, titre=titre,
                reference_lyrics=reference_lyrics, aesthetic_hint=aesthetic_hint,
            )
        update_job(job_id, step_lyrics=1, current_label="Paroles timées")

        if not words:
            raise RuntimeError("Transcription vide — vérifie que le fichier contient bien de la voix audible.")

        if option == "preview":
            # Transcription seule, pas de SRT/ASS/rendu — sert uniquement à alimenter
            # l'aperçu vidéo live côté front (vraie vidéo + vrai timing, pendant que
            # l'utilisateur choisit son style, avant de lancer le vrai rendu).
            # lyrics_source (flowstage / audio_uploade / audio_uploade_corrige_claude / cache /
            # verifie_manuellement) permet de savoir sans deviner quel chemin a été pris.
            update_job(
                job_id,
                status="done",
                current_label="Terminé",
                words_json=json.dumps(words),
                lyrics_source=lyrics_source,
            )
            return

        if option == "file":
            out_path = RESULTS_DIR / f"{job_id}.srt"
            out_path.write_text(build_srt(words), encoding="utf-8")
            remote_url = upload_to_r2(out_path, f"{job_id}.srt")
            update_job(
                job_id,
                step_srt=1,
                status="done",
                current_label="Terminé",
                download_url=remote_url or f"/files/{job_id}.srt",
                lyrics_source=lyrics_source,
            )
            return

        # Option "video"
        probe = subprocess.run(
            [
                "ffprobe", "-v", "error", "-select_streams", "v:0",
                "-show_entries", "stream=width,height:format=duration",
                "-of", "csv=p=0", str(upload_path),
            ],
            capture_output=True, text=True,
        )
        probe_lines = [l for l in (probe.stdout or "").strip().splitlines() if l]
        video_w, video_h = 1080, 1920
        duration_s = 0.0
        if probe_lines:
            parts = probe_lines[0].split(",")
            if len(parts) >= 2:
                video_w = int(parts[0] or 1080)
                video_h = int(parts[1] or 1920)
        if len(probe_lines) > 1:
            try:
                duration_s = float(probe_lines[1])
            except ValueError:
                pass

        # Garde-fou : un burn-in ffmpeg sur une source trop longue peut dépasser la RAM du
        # conteneur (observé : "Ran out of memory (used over 4GB)" sur un test réel) — on
        # préfère un message clair plutôt qu'un crash silencieux qui efface le job (SQLite
        # non persistant -> "job inconnu" au prochain poll).
        MAX_DURATION_S = 600  # 10 min, largement au-dessus d'un single/clip TikTok
        if duration_s > MAX_DURATION_S:
            raise RuntimeError(
                f"Vidéo trop longue ({int(duration_s // 60)} min) pour le rendu en ligne "
                f"— limite actuelle {MAX_DURATION_S // 60} min. Coupe le fichier ou repasse par un export plus court."
            )

        ass_path = DATA_DIR / f"{job_id}.ass"
        ass_path.write_text(
            build_ass(
                words, mode, font, font_weight, float(size_pct), color, video_h,
                position=position, effect=effect, outline_color_hex=outline_color,
                outline_width=outline_width, fond=fond, text_case=text_case,
                accent_color_hex=accent_color, italic=italic, words_per_group=int(words_per_group),
            ),
            encoding="utf-8",
        )
        update_job(job_id, step_ass=1, current_label="Style appliqué")

        out_path = RESULTS_DIR / f"{job_id}.mp4"
        # ffmpeg a besoin d'un chemin sans caractères spéciaux problématiques dans le filtre -vf ass=...
        safe_ass = DATA_DIR / f"{job_id}_subs.ass"
        shutil.copy(ass_path, safe_ass)

        # Downscale de sécurité : les exports iPhone/Android dépassent souvent 1080p en
        # hauteur (parfois 4K) — inutile pour un rendu social, et ça fait grimper la RAM du
        # burn-in (décodage + filtre + encodage) bien au-delà de ce qu'un conteneur à 4 Go
        # peut tenir. On plafonne le plus grand côté à 1920px, l'autre suit au prorata.
        MAX_DIM = 1920
        vf_chain = f"ass={safe_ass.as_posix()}"
        if max(video_w, video_h) > MAX_DIM:
            if video_h >= video_w:
                scale = f"scale=-2:{MAX_DIM}"
            else:
                scale = f"scale={MAX_DIM}:-2"
            vf_chain = f"{scale},{vf_chain}"

        run([
            "ffmpeg", "-y", "-i", str(upload_path),
            "-vf", vf_chain,
            "-c:v", "libx264", "-preset", "veryfast", "-threads", "2",
            "-c:a", "copy", str(out_path),
        ])
        remote_url = upload_to_r2(out_path, f"{job_id}.mp4")
        update_job(
            job_id,
            step_render=1,
            status="done",
            current_label="Terminé",
            download_url=remote_url or f"/files/{job_id}.mp4",
            lyrics_source=lyrics_source,
        )
    except subprocess.CalledProcessError as e:
        update_job(job_id, status="error", error_message=(e.stderr or b"").decode(errors="ignore")[:500])
    except Exception as e:  # noqa: BLE001
        update_job(job_id, status="error", error_message=str(e)[:500])
    finally:
        for p in (upload_path, DATA_DIR / f"{job_id}_audio.wav"):
            try:
                Path(p).unlink(missing_ok=True)
            except Exception:  # noqa: BLE001
                pass


# --------------------------------------------------------------------------
# Endpoints
# --------------------------------------------------------------------------


@app.post("/jobs")
async def create_job(
    job_id: str = Form(...),
    option: str = Form(...),
    artiste: str = Form(""),
    titre: str = Form(""),
    font: str = Form("'Poppins', sans-serif"),
    font_weight: str = Form("700"),
    size_pct: str = Form("10"),
    color: str = Form("#ffffff"),
    mode: str = Form("replace"),
    position: str = Form("centre"),
    effect: str = Form("none"),
    outline_color: str = Form("#000000"),
    outline_width: str = Form("normal"),
    fond: str = Form("contour"),
    text_case: str = Form("majuscule"),
    accent_color: str = Form("#ffd400"),
    italic: str = Form("false"),
    words_per_group: str = Form("3"),
    edited_words: str = Form(""),
    reference_lyrics: str = Form(""),
    aesthetic_hint: str = Form(""),
    file: UploadFile = File(...),
):
    conn = db()
    conn.execute(
        "INSERT OR REPLACE INTO jobs (job_id, option, status, current_label, step_received) "
        "VALUES (?, ?, 'processing', 'Fichier reçu', 1)",
        (job_id, option),
    )
    conn.commit()
    conn.close()

    upload_path = DATA_DIR / f"{job_id}_{Path(file.filename or 'upload').name}"
    with open(upload_path, "wb") as f:
        shutil.copyfileobj(file.file, f)

    threading.Thread(
        target=process_job,
        args=(job_id, option, artiste, titre, upload_path, font, font_weight, size_pct, color, mode),
        kwargs=dict(
            position=position, effect=effect, outline_color=outline_color,
            outline_width=outline_width, fond=fond, text_case=text_case, accent_color=accent_color,
            italic=str(italic).lower() in ("1", "true", "on", "yes"), words_per_group=words_per_group,
            edited_words=edited_words, reference_lyrics=reference_lyrics, aesthetic_hint=aesthetic_hint,
        ),
        daemon=True,
    ).start()

    return {"job_id": job_id}


@app.get("/jobs/{job_id}")
async def job_status(job_id: str):
    conn = db()
    row = conn.execute("SELECT * FROM jobs WHERE job_id = ?", (job_id,)).fetchone()
    conn.close()
    if not row:
        return JSONResponse({"error_message": "job inconnu"}, status_code=404)
    return dict(row)


# --------------------------------------------------------------------------
# Onglet Admin — endpoints
# --------------------------------------------------------------------------
# Jeton signé (HMAC-SHA256), pas de session en base : "email:expiration:signature"
# encodé en base64url. Auto-vérifiable, pas de secret transmis au front autre que
# le jeton lui-même, qui expire tout seul après ADMIN_TOKEN_TTL_S.


def _make_token(email: str) -> str:
    exp = int(time.time()) + ADMIN_TOKEN_TTL_S
    payload = f"{email}:{exp}"
    sig = hmac.new(ADMIN_AUTH_SECRET.encode(), payload.encode(), hashlib.sha256).hexdigest()
    return base64.urlsafe_b64encode(f"{payload}:{sig}".encode()).decode()


def _verify_token(token: str) -> bool:
    if not ADMIN_AUTH_SECRET or not token:
        return False
    try:
        email, exp, sig = base64.urlsafe_b64decode(token.encode()).decode().rsplit(":", 2)
        expected = hmac.new(ADMIN_AUTH_SECRET.encode(), f"{email}:{exp}".encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, expected):
            return False
        return int(exp) >= int(time.time())
    except Exception:  # noqa: BLE001
        return False


def require_admin(authorization: str = Header(default="")):
    token = authorization.replace("Bearer ", "").strip()
    if not _verify_token(token):
        raise HTTPException(status_code=401, detail="Session admin invalide ou expirée — reconnecte-toi.")
    return True


class AdminLoginBody(BaseModel):
    email: str
    password: str


@app.post("/admin/login")
async def admin_login(body: AdminLoginBody):
    if not ADMIN_AUTH_SECRET:
        raise HTTPException(status_code=500, detail="ADMIN_AUTH_SECRET n'est pas configuré côté serveur (Render > Environment).")
    try:
        users = json.loads(ADMIN_USERS_JSON)
    except Exception:  # noqa: BLE001
        users = []
    email = body.email.strip().lower()
    match = next(
        (u for u in users if str(u.get("email", "")).strip().lower() == email and u.get("password") == body.password),
        None,
    )
    if not match:
        raise HTTPException(status_code=401, detail="Identifiants incorrects.")
    return {"token": _make_token(body.email)}


def _resize_image_for_vision(raw: bytes, max_dim: int = 1568) -> bytes:
    """Redimensionne/compresse une photo avant envoi à Claude : réduit le poids
    de la requête (coût + vitesse, important sur mobile en 4G) sans perdre la
    lisibilité d'une étiquette ou d'un QR code. Si Pillow n'est pas disponible
    ou que le décodage échoue, renvoie l'image d'origine telle quelle plutôt
    que de bloquer l'analyse."""
    try:
        from PIL import Image
        import io as _io

        img = Image.open(_io.BytesIO(raw))
        img = img.convert("RGB")
        w, h = img.size
        scale = min(1.0, max_dim / max(w, h))
        if scale < 1.0:
            img = img.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)
        buf = _io.BytesIO()
        img.save(buf, format="JPEG", quality=88)
        return buf.getvalue()
    except Exception as e:  # noqa: BLE001
        print(f"[vision] redimensionnement échoué, envoi de l'original : {e}")
        return raw


@app.post("/admin/inventaire/analyze-photo")
async def admin_inventaire_analyze_photo(
    columns: str = Form(...),
    photos: List[UploadFile] = File(...),
    _ok: bool = Depends(require_admin),
):
    """Reçoit une ou plusieurs photos d'un objet d'inventaire + la liste des
    colonnes du feuillet courant (envoyée par le front, qui seul connaît le
    header exact de chaque feuillet — voir SHEET_META dans js/admin.js), et
    demande à Claude de lire l'objet et tout QR code / code-barres / étiquette
    visible pour préremplir le formulaire. L'utilisateur garde toujours la main
    pour corriger avant d'enregistrer — rien n'est envoyé à l'Excel ici."""
    if not ANTHROPIC_API_KEY:
        raise HTTPException(
            status_code=500,
            detail="ANTHROPIC_API_KEY n'est pas configurée côté serveur (Render > Environment).",
        )
    try:
        cols = json.loads(columns)
        if not isinstance(cols, list) or not cols:
            raise ValueError
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Paramètre 'columns' invalide.")
    if not photos:
        raise HTTPException(status_code=400, detail="Aucune photo reçue.")
    if len(photos) > 5:
        raise HTTPException(status_code=400, detail="5 photos maximum par analyse.")

    content_blocks = []
    for photo in photos:
        raw = await photo.read()
        if not raw:
            continue
        resized = _resize_image_for_vision(raw)
        content_blocks.append({
            "type": "image",
            "source": {"type": "base64", "media_type": "image/jpeg", "data": base64.b64encode(resized).decode()},
        })
    if not content_blocks:
        raise HTTPException(status_code=400, detail="Photos vides ou illisibles.")

    columns_list = ", ".join(f'"{c}"' for c in cols)
    prompt = (
        "Tu analyses des photos d'un objet destiné à un inventaire de matériel professionnel "
        "(audio, vidéo, informatique, ou entretien). Regarde attentivement l'objet ET toute "
        "étiquette, marquage, plaque signalétique, QR code ou code-barres visible sur les photos "
        "(zoome mentalement dessus, lis le texte même petit).\n\n"
        f"Réponds UNIQUEMENT avec un objet JSON strict, sans aucun texte autour, avec exactement "
        f"ces clés : [{columns_list}].\n"
        "Règles :\n"
        "- Remplis chaque champ avec ce que tu peux déduire ou lire sur les photos.\n"
        "- Si un champ correspond à une catégorie/type d'objet, choisis une valeur courte et cohérente "
        "avec les autres champs.\n"
        "- Si un champ est un numéro de série, code article, ou identifiant lu sur une étiquette ou un "
        "QR code, recopie-le exactement tel qu'il apparaît (respecte majuscules/minuscules et tirets).\n"
        "- Si tu ne peux vraiment pas déterminer un champ, laisse une chaîne vide \"\" — n'invente jamais "
        "une valeur que tu ne peux pas justifier par ce que tu vois.\n"
        "- Les champs numériques (prix, nombre, quantité) : chiffres seuls, vide si inconnu.\n"
        "- Pas de commentaire, pas de markdown, juste l'objet JSON."
    )
    content_blocks.append({"type": "text", "text": prompt})

    try:
        r = requests.post(
            ANTHROPIC_API_URL,
            headers={
                "x-api-key": ANTHROPIC_API_KEY,
                "anthropic-version": "2023-06-01",
                "Content-Type": "application/json",
            },
            json={
                "model": ANTHROPIC_VISION_MODEL,
                "max_tokens": 1024,
                "messages": [{"role": "user", "content": content_blocks}],
            },
            timeout=60,
        )
    except requests.RequestException as e:
        raise HTTPException(status_code=502, detail=f"Erreur de connexion à Claude : {e}")

    if r.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Erreur Claude ({r.status_code}) : {r.text[:400]}")

    data = r.json()
    text = "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text").strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\n?", "", text)
        text = re.sub(r"```\s*$", "", text).strip()
    try:
        values = json.loads(text)
    except ValueError:
        raise HTTPException(status_code=502, detail="Réponse IA illisible, réessaie ou remplis manuellement.")
    if not isinstance(values, dict):
        raise HTTPException(status_code=502, detail="Réponse IA mal formée, réessaie ou remplis manuellement.")

    # Ne renvoie que les colonnes demandées — jamais de clé inattendue même
    # si le modèle en a ajouté une de son propre chef.
    clean = {c: str(values.get(c, "") or "") for c in cols}
    return {"values": clean}


# NOTE ordre des routes : "/admin/inventaire/{action}" est un chemin générique
# qui matcherait aussi "/admin/inventaire/analyze-photo" si elle était déclarée
# avant lui (FastAPI/Starlette matche dans l'ordre de déclaration) — d'où le
# routing "analyze-photo" -> ce handler générique et l'erreur 500 observée.
# Cette route générique doit donc rester déclarée APRÈS toutes les routes
# littérales sous /admin/inventaire/.
@app.post("/admin/inventaire/{action}")
async def admin_inventaire(action: str, payload: dict = Body(default={}), _ok: bool = Depends(require_admin)):
    url = MAKE_INVENTAIRE_URLS.get(action)
    if not url:
        raise HTTPException(
            status_code=500,
            detail=f"Action '{action}' inconnue ou variable d'environnement manquante côté serveur.",
        )
    forward_payload = dict(payload)
    # Make corrompt silencieusement les tableaux imbriqués passés en JSON natif
    # au module microsoft-excel:makeApiCall (le body Graph arrive vide côté
    # Excel, sans erreur). On pré-sérialise donc nous-mêmes le corps exact
    # attendu par Microsoft Graph et on le transmet comme simple texte, que
    # Make n'a plus qu'à recopier tel quel — aucune coercion de type requise.
    if action in ("add", "update") and "values" in payload:
        forward_payload["graph_body"] = json.dumps({"values": payload["values"]})
    try:
        r = requests.post(url, json=forward_payload, timeout=25)
    except requests.RequestException as e:
        raise HTTPException(status_code=502, detail=f"Erreur de connexion à Make : {e}")
    try:
        data = r.json()
    except ValueError:
        data = {"raw": r.text}
    return JSONResponse(data, status_code=r.status_code if r.status_code < 500 else 502)


# --------------------------------------------------------------------------
# Onglet Admin — Budgets artistes
# --------------------------------------------------------------------------
# 1 fichier Excel par artiste (dans le dossier SharePoint dédié aux budgets),
# 1 feuillet par projet (EP/LP/single). Toute la logique de structure/calcul
# vit dans budget_engine.py — ce backend ne fait que : télécharger le fichier
# entier via Make (binaire brut), le modifier avec budget_engine, le renvoyer
# entier via Make (upsert par nom de fichier). Voir le docstring de
# budget_engine.py pour le détail du modèle de données.

ARTIST_FILE_PREFIX = "DUCHESS_Budget_"
_UNSAFE_FILENAME_CHARS = re.compile(r'[\\/:*?"<>|]')


def _artist_filename(artist: str) -> str:
    safe = _UNSAFE_FILENAME_CHARS.sub("", (artist or "").strip()) or "SansNom"
    return f"{ARTIST_FILE_PREFIX}{safe}.xlsx"


def _artist_from_filename(filename: str) -> str:
    name = filename or ""
    if name.startswith(ARTIST_FILE_PREFIX):
        name = name[len(ARTIST_FILE_PREFIX):]
    return re.sub(r"\.xlsx?$", "", name, flags=re.IGNORECASE)


def _budget_list_files() -> list:
    if not MAKE_BUDGET_URLS["list"]:
        raise HTTPException(status_code=500, detail="MAKE_BUDGET_LIST_URL n'est pas configurée côté serveur (Render > Environment).")
    try:
        r = requests.post(MAKE_BUDGET_URLS["list"], json={}, timeout=25)
        r.raise_for_status()
    except requests.RequestException as e:
        raise HTTPException(status_code=502, detail=f"Erreur de connexion à Make (liste budgets) : {e}")
    try:
        files = r.json()
    except ValueError:
        raise HTTPException(status_code=502, detail="Réponse Make illisible (liste budgets).")
    return [f for f in files if isinstance(f, dict) and f.get("id")]


def _budget_download(item_id: str) -> bytes:
    if not MAKE_BUDGET_URLS["download"]:
        raise HTTPException(status_code=500, detail="MAKE_BUDGET_DOWNLOAD_URL n'est pas configurée côté serveur (Render > Environment).")
    try:
        r = requests.post(MAKE_BUDGET_URLS["download"], json={"itemId": item_id}, timeout=40)
        r.raise_for_status()
    except requests.RequestException as e:
        raise HTTPException(status_code=502, detail=f"Erreur de connexion à Make (téléchargement budget) : {e}")
    if not r.content:
        raise HTTPException(status_code=502, detail="Fichier budget vide reçu de Make — itemId invalide ?")
    return r.content


def _budget_upload(filename: str, data: bytes) -> dict:
    if not MAKE_BUDGET_URLS["upload"]:
        raise HTTPException(status_code=500, detail="MAKE_BUDGET_UPLOAD_URL n'est pas configurée côté serveur (Render > Environment).")
    try:
        r = requests.post(
            MAKE_BUDGET_URLS["upload"],
            files={"file": (filename, data, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
            timeout=60,
        )
        r.raise_for_status()
    except requests.RequestException as e:
        raise HTTPException(status_code=502, detail=f"Erreur de connexion à Make (envoi budget) : {e}")
    try:
        return r.json()
    except ValueError:
        return {"raw": r.text}


def _budget_logo_path() -> Optional[str]:
    return str(BUDGET_LOGO_PATH) if BUDGET_LOGO_PATH.exists() else None


def _budget_rename(item_id: str, new_name: str) -> dict:
    if not MAKE_BUDGET_URLS["rename"]:
        raise HTTPException(status_code=500, detail="MAKE_BUDGET_RENAME_URL n'est pas configurée côté serveur (Render > Environment).")
    try:
        r = requests.post(MAKE_BUDGET_URLS["rename"], json={"itemId": item_id, "newName": new_name}, timeout=30)
        r.raise_for_status()
    except requests.RequestException as e:
        raise HTTPException(status_code=502, detail=f"Erreur de connexion à Make (renommage) : {e}")
    try:
        return r.json()
    except ValueError:
        return {"raw": r.text}


@app.get("/admin/budget/artists")
async def budget_artists(_ok: bool = Depends(require_admin)):
    files = _budget_list_files()
    return {
        "artists": [
            {
                "fileId": f["id"],
                "fileName": f.get("name"),
                "artist": _artist_from_filename(f.get("name") or ""),
                "size": f.get("size"),
                "lastModified": f.get("lastModifiedDateTime"),
                "webUrl": f.get("webUrl"),
            }
            for f in files
        ],
        "categories": be.CATEGORIES,
        "categoryPresets": be.CATEGORY_PRESETS,
        "simpleCategories": sorted(be.SIMPLE_CATEGORIES),
    }


@app.get("/admin/budget/file/{file_id}/projects")
async def budget_projects(file_id: str, _ok: bool = Depends(require_admin)):
    data = _budget_download(file_id)
    wb = be.workbook_from_bytes(data)
    return {"projects": wb.sheetnames}


@app.get("/admin/budget/file/{file_id}/projects/{sheet_name}")
async def budget_project_tree(file_id: str, sheet_name: str, _ok: bool = Depends(require_admin)):
    data = _budget_download(file_id)
    try:
        tree = be.read_project_tree(data, sheet_name)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Projet '{sheet_name}' introuvable dans ce fichier.")
    return tree


class BudgetSaveBody(BaseModel):
    file_name: str
    artist: str
    project_label: str
    tree: dict


@app.put("/admin/budget/file/{file_id}/projects/{sheet_name}")
async def budget_save_project(file_id: str, sheet_name: str, body: BudgetSaveBody, _ok: bool = Depends(require_admin)):
    data = _budget_download(file_id)
    new_data = be.write_project_tree(
        data, sheet_name, body.artist, body.project_label, body.tree, logo_path=_budget_logo_path(),
    )
    upload_result = _budget_upload(body.file_name, new_data)
    tree = be.read_project_tree(new_data, sheet_name)
    return {"saved": True, "upload": upload_result, **tree}


class BudgetNewArtistBody(BaseModel):
    artist: str
    project_label: str = "Projet 1"


@app.post("/admin/budget/new-artist")
async def budget_new_artist(body: BudgetNewArtistBody, _ok: bool = Depends(require_admin)):
    artist = (body.artist or "").strip()
    if not artist:
        raise HTTPException(status_code=400, detail="Nom d'artiste requis.")
    filename = _artist_filename(artist)
    existing = {f.get("name") for f in _budget_list_files()}
    if filename in existing:
        raise HTTPException(status_code=409, detail=f"Un fichier budget existe déjà pour « {artist} ».")
    wb = be.new_artist_workbook(artist, body.project_label or "Projet 1", logo_path=_budget_logo_path())
    data = be.workbook_to_bytes(wb)
    result = _budget_upload(filename, data)
    return {"created": True, "fileName": filename, "fileId": result.get("id"), "artist": artist}


class BudgetNewProjectBody(BaseModel):
    file_name: str
    artist: str
    project_label: str


@app.post("/admin/budget/file/{file_id}/new-project")
async def budget_new_project(file_id: str, body: BudgetNewProjectBody, _ok: bool = Depends(require_admin)):
    data = _budget_download(file_id)
    wb = be.workbook_from_bytes(data)
    sheet_name = (body.project_label or "Projet").strip()[:31]
    if not sheet_name:
        raise HTTPException(status_code=400, detail="Nom de projet requis.")
    if sheet_name in wb.sheetnames:
        raise HTTPException(status_code=409, detail=f"Un projet « {sheet_name} » existe déjà pour cet artiste.")
    be.new_project_sheet(wb, sheet_name, body.artist, body.project_label, logo_path=_budget_logo_path())
    new_data = be.workbook_to_bytes(wb)
    upload_result = _budget_upload(body.file_name, new_data)
    return {"created": True, "projects": wb.sheetnames, "upload": upload_result}


class BudgetRenameArtistBody(BaseModel):
    new_artist: str


@app.put("/admin/budget/artist/{file_id}/rename")
async def budget_rename_artist(file_id: str, body: BudgetRenameArtistBody, _ok: bool = Depends(require_admin)):
    new_artist = (body.new_artist or "").strip()
    if not new_artist:
        raise HTTPException(status_code=400, detail="Nouveau nom d'artiste requis.")
    new_filename = _artist_filename(new_artist)
    existing = {f.get("name") for f in _budget_list_files() if f.get("id") != file_id}
    if new_filename in existing:
        raise HTTPException(status_code=409, detail=f"Un fichier budget existe déjà pour « {new_artist} ».")
    result = _budget_rename(file_id, new_filename)
    return {"renamed": True, "artist": new_artist, "fileName": result.get("name") or new_filename}


class BudgetRenameProjectBody(BaseModel):
    file_name: str
    new_name: str


@app.put("/admin/budget/file/{file_id}/projects/{sheet_name}/rename")
async def budget_rename_project(file_id: str, sheet_name: str, body: BudgetRenameProjectBody, _ok: bool = Depends(require_admin)):
    new_name = (body.new_name or "").strip()[:31]
    if not new_name:
        raise HTTPException(status_code=400, detail="Nouveau nom de projet requis.")
    data = _budget_download(file_id)
    wb = be.workbook_from_bytes(data)
    if sheet_name not in wb.sheetnames:
        raise HTTPException(status_code=404, detail=f"Projet '{sheet_name}' introuvable.")
    if new_name != sheet_name and new_name in wb.sheetnames:
        raise HTTPException(status_code=409, detail=f"Un projet « {new_name} » existe déjà pour cet artiste.")
    # Renomme uniquement le titre du feuillet (pas de macro/rebuild nécessaire — la structure
    # et les données du feuillet sont inchangées, seul son nom d'onglet Excel change).
    wb[sheet_name].title = new_name
    new_data = be.workbook_to_bytes(wb)
    upload_result = _budget_upload(body.file_name, new_data)
    return {"renamed": True, "projects": wb.sheetnames, "upload": upload_result}


@app.delete("/admin/budget/file/{file_id}/projects/{sheet_name}")
async def budget_delete_project(file_id: str, sheet_name: str, file_name: str, _ok: bool = Depends(require_admin)):
    data = _budget_download(file_id)
    wb = be.workbook_from_bytes(data)
    if sheet_name not in wb.sheetnames:
        raise HTTPException(status_code=404, detail=f"Projet '{sheet_name}' introuvable.")
    if len(wb.sheetnames) <= 1:
        raise HTTPException(
            status_code=400,
            detail="Impossible de supprimer le dernier projet d'un artiste — supprime plutôt le fichier artiste entier.",
        )
    del wb[sheet_name]
    new_data = be.workbook_to_bytes(wb)
    upload_result = _budget_upload(file_name, new_data)
    return {"deleted": True, "projects": wb.sheetnames, "upload": upload_result}


# --------------------------------------------------------------------------
# Onglet Sound Connect — catalogue audio PHONO (accessible à toute l'équipe,
# pas sous /admin/, pas de require_admin)
# --------------------------------------------------------------------------
# Base de données = l'arborescence SharePoint PHONO (site "Partage Externe"),
# organisée Artiste / Titre / versions (mix v1, v2, v3, instru, PBO...). Un
# seul scénario Make générique ("DUCHESS SOUND CONNECT - LIST FOLDER") liste
# le contenu d'un dossier donné par son itemId — c'est ce backend qui fait la
# récursion Artiste -> Titre -> fichiers, et qui applique la règle métier de
# Michel : pour chaque titre, ne garder QUE le mix le plus récent (numéro le
# plus élevé après un "#") en 44kHz — jamais 48kHz, jamais INSTRU, jamais PBO.
# Résultat mis en cache localement (le crawl complet fait ~1 appel Make par
# artiste + ~1 par titre, soit plusieurs dizaines de secondes) : GET
# /soundconnect/catalog sert ce cache, POST /soundconnect/sync le reconstruit.
SOUNDCONNECT_CACHE_PATH = DATA_DIR / "soundconnect_catalog.json"
# Couche d'organisation indépendante (espaces / dossiers / projets / playlists) — voir
# section "Organisation indépendante" plus bas. PHONO (et plus tard un second dossier
# SharePoint pour les démos/maquettes) n'est qu'une SOURCE de fichiers parmi d'autres ;
# cette organisation ne reflète jamais 1:1 l'arborescence SharePoint, elle est éditable
# librement par l'équipe et ne fait que référencer les titres ingérés.
SOUNDCONNECT_ORG_PATH = DATA_DIR / "soundconnect_org.json"

# Un nom de fichier "44Khz" fait foi ; "44.1khz"/"44 khz" tolérés aussi. Tout
# fichier INSTRU/PBO/ACAP est une variante technique, jamais LA version du titre.
_SC_44KHZ_RE = re.compile(r"44[.,]?1?\s*khz", re.IGNORECASE)
_SC_VERSION_NUM_RE = re.compile(r"#\s*(\d+)")
_SC_EXCLUDE_RE = re.compile(r"instru|pbo|acap", re.IGNORECASE)
_SC_AUDIO_EXT = (".wav", ".aiff", ".aif", ".flac", ".mp3")


def _sc_list_folder(folder_id: str) -> list:
    if not MAKE_SOUNDCONNECT_LIST_FOLDER_URL:
        raise HTTPException(status_code=500, detail="MAKE_SOUNDCONNECT_LIST_FOLDER_URL n'est pas configurée côté serveur (Render > Environment).")
    try:
        r = requests.post(MAKE_SOUNDCONNECT_LIST_FOLDER_URL, json={"folderId": folder_id}, timeout=30)
        r.raise_for_status()
    except requests.RequestException as e:
        raise HTTPException(status_code=502, detail=f"Erreur de connexion à Make (Sound Connect) : {e}")
    try:
        items = r.json()
    except ValueError:
        raise HTTPException(status_code=502, detail="Réponse Make illisible (Sound Connect).")
    # Dossier vide -> Make/SharePoint renvoie [{"id": null, ...}] plutôt que [] (piège connu, voir doc).
    return [it for it in items if isinstance(it, dict) and it.get("id")]


_SC_48KHZ_RE = re.compile(r"48\s*khz", re.IGNORECASE)


def _sc_pick_best_version(files: list) -> Optional[dict]:
    """Parmi les fichiers audio d'un dossier titre, choisit LA version à exposer.

    Règle de Michel, en 3 paliers (le nommage réel du catalogue n'est pas homogène —
    ex. "TW - Dernière Danse-24bits-M.wav" n'a ni "#NN" ni "44Khz" dans son nom, alors
    que la grande majorité des titres suivent "TITRE #NN 44Khz 24Bit.wav") :
      1. Strict  : 44kHz explicite, jamais instru/PBO/acap -> le numéro de mix le plus élevé.
      2. Souple  : aucun 44kHz explicite trouvé -> tout fichier audio qui n'est ni marqué
         48kHz ni instru/PBO/acap (évite de faire disparaître un titre du catalogue
         juste parce qu'il ne suit pas la convention de nommage habituelle).
      3. Dernier recours : uniquement des fichiers exclus/48kHz -> on prend quand même
         le plus gros (souvent le master), avec confidence="unresolved" pour que le
         front puisse le signaler visuellement à l'équipe plutôt que de le cacher.
    """
    audio = [f for f in files if (f.get("name") or "").lower().endswith(_SC_AUDIO_EXT)]
    if not audio:
        return None

    def with_version(items):
        out = []
        for f in items:
            m = _SC_VERSION_NUM_RE.search(f.get("name") or "")
            out.append((int(m.group(1)) if m else -1, f))
        out.sort(key=lambda c: c[0], reverse=True)
        return out

    strict = [f for f in audio if _SC_44KHZ_RE.search(f["name"]) and not _SC_EXCLUDE_RE.search(f["name"])]
    if strict:
        best = with_version(strict)[0][1]
        return {**best, "versionConfidence": "strict"}

    souple = [f for f in audio if not _SC_48KHZ_RE.search(f["name"]) and not _SC_EXCLUDE_RE.search(f["name"])]
    if souple:
        best = with_version(souple)[0][1]
        return {**best, "versionConfidence": "fallback"}

    best = max(audio, key=lambda f: f.get("size") or 0)
    return {**best, "versionConfidence": "unresolved"}


def _sc_build_catalog() -> dict:
    catalog = []
    unresolved_folders = []  # dossiers "titre" sans fichier audio exploitable (structure non standard)
    artists = [it for it in _sc_list_folder(PHONO_ROOT_FOLDER_ID) if it.get("isFolder")]
    for artist in artists:
        titles = [it for it in _sc_list_folder(artist["id"]) if it.get("isFolder")]
        for title in titles:
            files = [it for it in _sc_list_folder(title["id"]) if not it.get("isFolder")]
            best = _sc_pick_best_version(files)
            if not best:
                unresolved_folders.append({"artist": artist["name"], "title": title["name"], "fileCount": len(files)})
                continue
            catalog.append({
                "id": best["id"],
                "artist": artist["name"],
                "title": title["name"],
                "filename": best["name"],
                "size": best.get("size"),
                "downloadUrl": best.get("downloadUrl"),
                "webUrl": best.get("webUrl"),
                "lastModified": best.get("lastModifiedDateTime"),
                "versionConfidence": best.get("versionConfidence", "strict"),
                # Dossier PHONO du titre (pas le fichier) — nécessaire pour retrouver un lien
                # de téléchargement frais (les liens Graph expirent) et pour uploader une
                # "nouvelle version" au bon endroit (seul cas où on écrit dans PHONO).
                "parentFolderId": title["id"],
            })
    return {"tracks": catalog, "unresolvedFolders": unresolved_folders}


def _sc_save_cache(payload: dict):
    SOUNDCONNECT_CACHE_PATH.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    if R2_ENABLED:
        # Le disque Render n'est pas persistant entre redéploiements (voir plus haut) : sans
        # ceci, un redéploiement backend forcerait un nouveau sync complet (~1-2 min) avant que
        # le catalogue ne réapparaisse. Best-effort : un échec R2 ne bloque jamais le sync,
        # le cache local suffit tant que le conteneur ne redémarre pas.
        try:
            client = get_r2_client()
            client.put_object(
                Bucket=R2_BUCKET_NAME,
                Key="soundconnect/catalog.json",
                Body=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                ContentType="application/json",
            )
        except Exception as e:  # noqa: BLE001
            print(f"[R2] sauvegarde catalogue Sound Connect échouée : {e}")


def _sc_load_cache() -> Optional[dict]:
    if SOUNDCONNECT_CACHE_PATH.exists():
        return json.loads(SOUNDCONNECT_CACHE_PATH.read_text(encoding="utf-8"))
    if R2_ENABLED:
        try:
            client = get_r2_client()
            obj = client.get_object(Bucket=R2_BUCKET_NAME, Key="soundconnect/catalog.json")
            data = json.loads(obj["Body"].read().decode("utf-8"))
            # Reconstruit le cache local pour éviter de retaper R2 à chaque requête.
            SOUNDCONNECT_CACHE_PATH.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            return data
        except Exception:  # noqa: BLE001 — pas de cache R2 = pas encore synchronisé, rien d'anormal
            return None
    return None


@app.get("/soundconnect/catalog")
def soundconnect_catalog():
    data = _sc_load_cache()
    if not data:
        return {"tracks": [], "unresolvedFolders": [], "syncedAt": None, "needsSync": True}
    return {
        "tracks": data.get("tracks", []),
        "unresolvedFolders": data.get("unresolvedFolders", []),
        "syncedAt": data.get("syncedAt"),
        "needsSync": False,
    }


@app.post("/soundconnect/sync")
def soundconnect_sync():
    # Synchrone et volontairement simple pour le V1 : un crawl complet de PHONO
    # (~1 appel Make par artiste + ~1 par titre) prend de l'ordre de la minute.
    # Déclenché à la demande (bouton "Rafraîchir" côté front), pas en arrière-plan
    # pour l'instant — à revoir (job + polling, comme /jobs pour les sous-titres)
    # si le catalogue grossit au point de dépasser le timeout du proxy Render.
    result = _sc_build_catalog()
    payload = {
        "tracks": result["tracks"],
        "unresolvedFolders": result["unresolvedFolders"],
        "syncedAt": datetime.datetime.utcnow().isoformat() + "Z",
    }
    _sc_save_cache(payload)
    # Ingestion dans la couche d'organisation indépendante (espaces/dossiers/projets) —
    # voir section dédiée juste en dessous. N'écrase jamais une réorganisation déjà faite
    # par l'équipe : seuls les NOUVEAUX titres (jamais vus) sont classés automatiquement.
    _org_ingest(result["tracks"])
    return {
        "synced": True,
        "count": len(payload["tracks"]),
        "unresolvedCount": len(payload["unresolvedFolders"]),
        "syncedAt": payload["syncedAt"],
    }


# --------------------------------------------------------------------------
# Sound Connect — organisation indépendante (espaces / dossiers / projets / playlists)
# --------------------------------------------------------------------------
# PHONO (ci-dessus) n'est qu'une SOURCE de fichiers ("masters") parmi d'autres à venir
# (ex. un futur dossier SharePoint "démos/maquettes"). Cette section gère une couche
# d'organisation totalement indépendante de l'arborescence SharePoint : des "espaces"
# (ex. label ARK / label Duchess), contenant des "dossiers" (ex. un artiste), pouvant
# eux-mêmes contenir des "projets"/"playlists" (ex. un EP, une sélection) qui référencent
# des titres. Un titre peut être lié à plusieurs projets/playlists à la fois (many-to-many).
#
# Stockage : pour l'instant un simple JSON (local + R2, même pattern que le cache
# catalogue ci-dessus) plutôt qu'une vraie base — la base D1 Cloudflare "duchess-sound-
# connect" a été créée et est prête, mais nécessite un token API Cloudflare en variable
# d'env Render pour que CE backend (hébergé sur Render, pas sur Cloudflare) puisse la
# lire/écrire. Migration triviale le jour où ce token est fourni : le schéma JSON
# ci-dessous correspond exactement aux tables prévues (workspaces/folders/tracks/
# folderTracks).
ARK_ARTISTS = {
    "BENDE", "LENNON", "NAUMAUR", "TW", "WAREND",
}  # reste du roster (BILLIE, CLEMENT HERFORT, COBALT, DAYSY, HEROE, JOSEPH KAMEL,
   # JULIEN ANDRIANA, PIERRE GARNIER, ROMAIN MIALDEA...) -> espace "DUCHESS"


def _now_iso() -> str:
    return datetime.datetime.utcnow().isoformat() + "Z"


def _slugify(name: str) -> str:
    norm = unicodedata.normalize("NFD", name or "").encode("ascii", "ignore").decode("ascii")
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", norm.lower())).strip("-")


def _org_default() -> dict:
    return {"workspaces": {}, "folders": {}, "tracks": {}, "folderTracks": {}, "shares": {}}


def _org_with_defaults(data: dict) -> dict:
    """Complète un org.json déjà existant (créé avant l'ajout d'une nouvelle
    clé racine, ex. "shares") avec les clés manquantes, sans jamais écraser
    les données déjà présentes."""
    for k, v in _org_default().items():
        data.setdefault(k, v)
    return data


def _org_load() -> dict:
    if SOUNDCONNECT_ORG_PATH.exists():
        return _org_with_defaults(json.loads(SOUNDCONNECT_ORG_PATH.read_text(encoding="utf-8")))
    if R2_ENABLED:
        try:
            client = get_r2_client()
            obj = client.get_object(Bucket=R2_BUCKET_NAME, Key="soundconnect/org.json")
            data = _org_with_defaults(json.loads(obj["Body"].read().decode("utf-8")))
            SOUNDCONNECT_ORG_PATH.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            return data
        except Exception:  # noqa: BLE001 — pas encore de sauvegarde, organisation vide
            return _org_default()
    return _org_default()


def _org_save(data: dict):
    SOUNDCONNECT_ORG_PATH.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    if R2_ENABLED:
        try:
            client = get_r2_client()
            client.put_object(
                Bucket=R2_BUCKET_NAME,
                Key="soundconnect/org.json",
                Body=json.dumps(data, ensure_ascii=False).encode("utf-8"),
                ContentType="application/json",
            )
        except Exception as e:  # noqa: BLE001
            print(f"[R2] sauvegarde organisation Sound Connect échouée : {e}")


def _org_workspace_for_artist(artist: str) -> str:
    norm = unicodedata.normalize("NFD", artist or "").encode("ascii", "ignore").decode("ascii").upper().strip()
    return "ARK" if norm in ARK_ARTISTS else "DUCHESS"


def _org_ensure_workspace(data: dict, name: str) -> str:
    for ws in data["workspaces"].values():
        if ws["name"].lower() == name.lower():
            return ws["id"]
    wid = str(uuid.uuid4())
    data["workspaces"][wid] = {"id": wid, "name": name, "slug": _slugify(name), "sortOrder": len(data["workspaces"]), "createdAt": _now_iso()}
    return wid


def _org_ensure_folder(data: dict, workspace_id: str, parent_id: Optional[str], name: str, kind: str, project_type: Optional[str] = None) -> str:
    for f in data["folders"].values():
        if f["workspaceId"] == workspace_id and (f.get("parentId") or None) == (parent_id or None) and f["kind"] == kind and f["name"].lower() == name.lower():
            return f["id"]
    fid = str(uuid.uuid4())
    data["folders"][fid] = {
        "id": fid, "workspaceId": workspace_id, "parentId": parent_id, "name": name,
        "kind": kind, "sortOrder": len(data["folders"]), "createdAt": _now_iso(),
        # Uniquement pour kind="project" : "single" | "ep" | "album" — pure métadonnée
        # d'affichage (badge sur la tuile), aucune logique différente selon la valeur.
        "projectType": project_type,
    }
    data["folderTracks"].setdefault(fid, [])
    return fid


def _org_upsert_track(data: dict, raw: dict) -> str:
    tid = f"phono:{raw['id']}"
    data["tracks"][tid] = {
        "id": tid,
        "sourceKind": "phono_master",
        "externalId": raw["id"],
        "artist": raw["artist"],
        "title": raw["title"],
        "filename": raw["filename"],
        "size": raw.get("size"),
        "downloadUrl": raw.get("downloadUrl"),
        "webUrl": raw.get("webUrl"),
        "lastModified": raw.get("lastModified"),
        "versionConfidence": raw.get("versionConfidence"),
        "parentFolderId": raw.get("parentFolderId"),
        "syncedAt": _now_iso(),
    }
    return tid


def _org_link_track(data: dict, folder_id: str, track_id: str):
    lst = data["folderTracks"].setdefault(folder_id, [])
    if track_id not in lst:
        lst.append(track_id)


def _org_descendant_ids(data: dict, folder_id: str) -> set:
    """IDs du dossier lui-même + tous ses descendants (projets/playlists/sous-dossiers)."""
    to_collect = {folder_id}
    grew = True
    while grew:
        grew = False
        for child in data["folders"].values():
            if child.get("parentId") in to_collect and child["id"] not in to_collect:
                to_collect.add(child["id"])
                grew = True
    return to_collect


def _org_move_folder_workspace(data: dict, folder_id: str, new_workspace_id: str):
    """Change l'espace d'un dossier ET cascade sur tous ses descendants — utilisé pour
    le drag and drop d'un artiste vers un autre espace (Library) et pour la
    réconciliation automatique du roster ARK/DUCHESS. Les titres liés (folderTracks)
    ne référencent que des IDs de dossier, jamais d'espace : rien à faire de leur côté."""
    for fid in _org_descendant_ids(data, folder_id):
        if fid in data["folders"]:
            data["folders"][fid]["workspaceId"] = new_workspace_id


def _org_reconcile_workspaces(data: dict) -> bool:
    """Auto-corrige les dossiers artiste déjà créés dont l'espace (ARK/DUCHESS) ne
    correspond plus au roster ARK_ARTISTS courant (ex. roster corrigé après coup).
    Déplace le dossier artiste ET tous ses descendants (projets/playlists) vers le
    bon espace, sans toucher aux titres liés. Appelé à chaque sync pour rester
    auto-réparant."""
    ws_by_name = {ws["name"]: wid for wid, ws in data["workspaces"].items()}
    changed_any = False
    for f in list(data["folders"].values()):
        if f["kind"] != "folder" or f.get("parentId") is not None:
            continue  # seuls les dossiers artiste (racine) sont classés par roster
        correct_ws_name = _org_workspace_for_artist(f["name"])
        correct_ws_id = ws_by_name.get(correct_ws_name)
        if not correct_ws_id:
            correct_ws_id = _org_ensure_workspace(data, correct_ws_name)
            ws_by_name[correct_ws_name] = correct_ws_id
        if f["workspaceId"] == correct_ws_id:
            continue
        _org_move_folder_workspace(data, f["id"], correct_ws_id)
        changed_any = True
    return changed_any


def _org_ingest(raw_tracks: list) -> dict:
    """Classe automatiquement les NOUVEAUX titres PHONO : espace (ARK/DUCHESS selon le
    roster) -> dossier artiste -> projet titre. Un titre déjà connu garde sa métadonnée
    à jour (ex. downloadUrl, qui expire côté SharePoint) mais n'est jamais redéplacé —
    si l'équipe l'a réorganisé ailleurs entretemps, ce choix est respecté."""
    data = _org_load()
    _org_reconcile_workspaces(data)  # corrige d'abord les classements existants avant
    # de traiter les nouveaux titres, pour ne jamais créer de dossier artiste en double.
    for raw in raw_tracks:
        ws_id = _org_ensure_workspace(data, _org_workspace_for_artist(raw["artist"]))
        artist_folder_id = _org_ensure_folder(data, ws_id, None, raw["artist"], "folder")
        project_id = _org_ensure_folder(data, ws_id, artist_folder_id, raw["title"], "project")
        track_id = _org_upsert_track(data, raw)
        _org_link_track(data, project_id, track_id)
    _org_save(data)
    return data


def _org_folder_summary(data: dict, f: dict) -> dict:
    children = [c for c in data["folders"].values() if c.get("parentId") == f["id"]]
    track_ids = data["folderTracks"].get(f["id"], [])
    if children:
        preview = [c["name"] for c in sorted(children, key=lambda c: c["name"].lower())[:4]]
    else:
        preview = [data["tracks"][tid]["title"] for tid in track_ids[:4] if tid in data["tracks"]]
    return {
        "id": f["id"], "name": f["name"], "kind": f["kind"], "parentId": f.get("parentId"),
        "workspaceId": f["workspaceId"], "childCount": len(children), "trackCount": len(track_ids),
        "preview": preview, "projectType": f.get("projectType"),
    }


@app.get("/soundconnect/workspaces")
def soundconnect_list_workspaces():
    data = _org_load()
    out = []
    for ws in sorted(data["workspaces"].values(), key=lambda w: w.get("sortOrder", 0)):
        top_folders = [f for f in data["folders"].values() if f["workspaceId"] == ws["id"] and f.get("parentId") is None]
        preview = [f["name"] for f in sorted(top_folders, key=lambda f: f["name"].lower())[:4]]
        out.append({**ws, "folderCount": len(top_folders), "preview": preview})
    return {"workspaces": out}


class SCWorkspaceBody(BaseModel):
    name: str


@app.post("/soundconnect/workspaces")
def soundconnect_create_workspace(body: SCWorkspaceBody):
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Nom d'espace requis.")
    data = _org_load()
    wid = _org_ensure_workspace(data, name)
    _org_save(data)
    return data["workspaces"][wid]


@app.get("/soundconnect/workspaces/{workspace_id}/folders")
def soundconnect_workspace_folders(workspace_id: str, parentId: Optional[str] = None):
    data = _org_load()
    ws = data["workspaces"].get(workspace_id)
    if not ws:
        raise HTTPException(status_code=404, detail="Espace introuvable.")
    items = [
        _org_folder_summary(data, f) for f in data["folders"].values()
        if f["workspaceId"] == workspace_id and (f.get("parentId") or None) == (parentId or None)
    ]
    items.sort(key=lambda x: x["name"].lower())
    return {"workspace": ws, "folders": items}


class SCFolderBody(BaseModel):
    workspaceId: str
    name: str
    kind: str = "folder"  # 'folder' | 'project' | 'playlist'
    parentId: Optional[str] = None
    projectType: Optional[str] = None  # 'single' | 'ep' | 'album' — pour kind="project" seulement


@app.post("/soundconnect/folders")
def soundconnect_create_folder(body: SCFolderBody):
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Nom requis.")
    data = _org_load()
    if body.workspaceId not in data["workspaces"]:
        raise HTTPException(status_code=404, detail="Espace introuvable.")
    fid = _org_ensure_folder(data, body.workspaceId, body.parentId, name, body.kind, body.projectType)
    _org_save(data)
    return data["folders"][fid]


@app.get("/soundconnect/folders/{folder_id}")
def soundconnect_folder_detail(folder_id: str):
    data = _org_load()
    f = data["folders"].get(folder_id)
    if not f:
        raise HTTPException(status_code=404, detail="Dossier introuvable.")
    children = sorted(
        (_org_folder_summary(data, c) for c in data["folders"].values() if c.get("parentId") == folder_id),
        key=lambda x: x["name"].lower(),
    )
    track_ids = data["folderTracks"].get(folder_id, [])
    tracks = [data["tracks"][tid] for tid in track_ids if tid in data["tracks"]]
    return {"folder": f, "children": children, "tracks": tracks}


class SCFolderUpdateBody(BaseModel):
    name: Optional[str] = None
    parentId: Optional[str] = None
    workspaceId: Optional[str] = None


@app.put("/soundconnect/folders/{folder_id}")
def soundconnect_update_folder(folder_id: str, body: SCFolderUpdateBody):
    data = _org_load()
    f = data["folders"].get(folder_id)
    if not f:
        raise HTTPException(status_code=404, detail="Dossier introuvable.")
    if body.name is not None and body.name.strip():
        f["name"] = body.name.strip()
    if body.workspaceId is not None and body.workspaceId != f["workspaceId"]:
        # Déplacement vers un autre espace (drag and drop artiste -> Library, ou
        # projet -> artiste d'un autre espace) : cascade sur tous les descendants.
        if body.workspaceId not in data["workspaces"]:
            raise HTTPException(status_code=404, detail="Espace introuvable.")
        _org_move_folder_workspace(data, folder_id, body.workspaceId)
    if body.parentId is not None:
        f["parentId"] = body.parentId or None
    _org_save(data)
    return f


@app.delete("/soundconnect/folders/{folder_id}")
def soundconnect_delete_folder(folder_id: str):
    data = _org_load()
    if folder_id not in data["folders"]:
        raise HTTPException(status_code=404, detail="Dossier introuvable.")
    to_delete = {folder_id}
    changed = True
    while changed:
        changed = False
        for f in data["folders"].values():
            if f.get("parentId") in to_delete and f["id"] not in to_delete:
                to_delete.add(f["id"])
                changed = True
    for fid in to_delete:
        data["folders"].pop(fid, None)
        data["folderTracks"].pop(fid, None)
    _org_save(data)
    return {"deleted": True, "ids": list(to_delete)}


class SCAddTrackBody(BaseModel):
    trackId: str


@app.post("/soundconnect/folders/{folder_id}/tracks")
def soundconnect_add_track_to_folder(folder_id: str, body: SCAddTrackBody):
    data = _org_load()
    if folder_id not in data["folders"]:
        raise HTTPException(status_code=404, detail="Dossier introuvable.")
    if body.trackId not in data["tracks"]:
        raise HTTPException(status_code=404, detail="Titre introuvable.")
    _org_link_track(data, folder_id, body.trackId)
    _org_save(data)
    return {"added": True}


@app.delete("/soundconnect/folders/{folder_id}/tracks/{track_id}")
def soundconnect_remove_track_from_folder(folder_id: str, track_id: str):
    data = _org_load()
    lst = data["folderTracks"].get(folder_id, [])
    if track_id in lst:
        lst.remove(track_id)
        _org_save(data)
    return {"removed": True}


class SCReorderTracksBody(BaseModel):
    trackIds: List[str]


@app.put("/soundconnect/folders/{folder_id}/tracks/reorder")
def soundconnect_reorder_folder_tracks(folder_id: str, body: SCReorderTracksBody):
    """Change l'ordre d'affichage des titres d'un projet (glisser-déposer par la
    poignée à gauche, côté frontend) — l'ordre dans folderTracks[folder_id] EST
    l'ordre d'affichage, aucun autre champ à mettre à jour. Ne touche jamais PHONO."""
    data = _org_load()
    if folder_id not in data["folders"]:
        raise HTTPException(status_code=404, detail="Dossier introuvable.")
    current = data["folderTracks"].get(folder_id, [])
    # Le nouvel ordre doit contenir exactement les mêmes titres que l'actuel —
    # un reorder ne doit jamais servir à ajouter/retirer un titre en douce.
    if set(body.trackIds) != set(current):
        raise HTTPException(status_code=400, detail="La liste envoyée ne correspond pas aux titres actuels de ce dossier.")
    data["folderTracks"][folder_id] = body.trackIds
    _org_save(data)
    return {"reordered": True}


@app.get("/soundconnect/folders")
def soundconnect_list_all_folders(kind: Optional[str] = None):
    """Liste à plat TOUS les dossiers/projets/playlists, tous espaces confondus, avec le
    nom de leur espace et de leur parent — sert à construire l'arbre de la sidebar
    (drag and drop) et les pickers "Déplacer" / "Ajouter au projet X" du menu clic droit,
    en un seul appel plutôt qu'un aller-retour par niveau."""
    data = _org_load()
    kinds = set(kind.split(",")) if kind else None
    out = []
    for f in data["folders"].values():
        if kinds and f["kind"] not in kinds:
            continue
        ws = data["workspaces"].get(f["workspaceId"])
        parent = data["folders"].get(f.get("parentId")) if f.get("parentId") else None
        out.append({
            "id": f["id"], "name": f["name"], "kind": f["kind"], "parentId": f.get("parentId"),
            "workspaceId": f["workspaceId"], "workspaceName": ws["name"] if ws else "",
            "parentName": parent["name"] if parent else None, "projectType": f.get("projectType"),
        })
    out.sort(key=lambda x: (x["workspaceName"].lower(), (x["parentName"] or "").lower(), x["name"].lower()))
    return {"folders": out}


@app.get("/soundconnect/tracks")
def soundconnect_search_tracks(q: str = ""):
    data = _org_load()
    tracks = list(data["tracks"].values())
    if q:
        ql = q.lower()
        tracks = [t for t in tracks if ql in t["artist"].lower() or ql in t["title"].lower()]
    tracks.sort(key=lambda t: (t["artist"].lower(), t["title"].lower()))
    return {"tracks": tracks}


def _sc_find_in_folder(folder_id: str, *, external_id: Optional[str] = None, filename: Optional[str] = None) -> Optional[dict]:
    """Reliste un dossier PHONO (toujours à jour côté Make/Graph, contrairement au cache)
    et retrouve un fichier précis par id puis, à défaut, par nom exact (insensible à la
    casse). Utilisé pour rafraîchir un lien de téléchargement expiré et pour relire les
    métadonnées d'un fichier qui vient d'être uploadé (nouvelle version)."""
    items = [it for it in _sc_list_folder(folder_id) if not it.get("isFolder")]
    if external_id:
        match = next((it for it in items if it.get("id") == external_id), None)
        if match:
            return match
    if filename:
        fl = filename.lower()
        match = next((it for it in items if (it.get("name") or "").lower() == fl), None)
        if match:
            return match
    return None


def _fresh_track_download_url(track: dict) -> Optional[str]:
    """Les liens SharePoint (`@microsoft.graph.downloadUrl`) sont temporaires — le lien
    mis en cache lors du dernier sync PHONO a très probablement expiré. On relit le
    dossier d'origine pour en obtenir un frais avant de l'utiliser. Partagée par le
    téléchargement admin ET les endpoints publics de partage externe, pour ne jamais
    dupliquer cette logique (ni le risque d'oublier de la rafraîchir quelque part)."""
    fresh_url = None
    if track.get("parentFolderId"):
        try:
            match = _sc_find_in_folder(track["parentFolderId"], external_id=track.get("externalId"), filename=track.get("filename"))
            if match:
                fresh_url = match.get("downloadUrl")
        except HTTPException:
            pass  # Make/PHONO indisponible -> on retombe sur le lien en cache ci-dessous
    return fresh_url or track.get("downloadUrl")


@app.get("/soundconnect/tracks/{track_id}/download")
def soundconnect_track_download(track_id: str):
    data = _org_load()
    track = data["tracks"].get(track_id)
    if not track:
        raise HTTPException(status_code=404, detail="Titre introuvable.")
    fresh_url = _fresh_track_download_url(track)
    if not fresh_url:
        raise HTTPException(status_code=404, detail="Aucun lien de téléchargement disponible — resynchronise le catalogue.")
    return RedirectResponse(fresh_url)


# --------------------------------------------------------------------------
# Silhouette de waveform (analyse RMS) — calculée une fois côté navigateur
# (Web Audio API, voir js/soundconnect.js:computeRealPeaks) puis mise en cache
# ICI pour que PERSONNE n'ait plus jamais à retélécharger/redécoder le fichier
# entier juste pour l'afficher : demande de Michel après avoir remarqué que la
# silhouette "réinitialisait" sa forme après quelques secondes à chaque lecture
# (le temps que le fetch+decode se termine) — même chose vue par un autre
# auditeur, ou au rechargement de la page. Un point fixe de résolution (voir
# WAVEFORM_CACHE_RESOLUTION côté JS) est stocké une fois pour toutes ; le
# nombre de barres affichées (qui dépend de la largeur d'écran) est rééchantillonné
# à l'affichage à partir de ce point fixe, jamais recalculé depuis l'audio.
SOUNDCONNECT_WAVEFORMS_PATH = DATA_DIR / "soundconnect_waveforms.json"


def _waveforms_load() -> dict:
    if SOUNDCONNECT_WAVEFORMS_PATH.exists():
        return json.loads(SOUNDCONNECT_WAVEFORMS_PATH.read_text(encoding="utf-8"))
    if R2_ENABLED:
        try:
            client = get_r2_client()
            obj = client.get_object(Bucket=R2_BUCKET_NAME, Key="soundconnect/waveforms.json")
            data = json.loads(obj["Body"].read().decode("utf-8"))
            SOUNDCONNECT_WAVEFORMS_PATH.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            return data
        except Exception:  # noqa: BLE001 — pas encore de cache, on repart de zéro
            return {}
    return {}


def _waveforms_save(data: dict):
    SOUNDCONNECT_WAVEFORMS_PATH.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    if R2_ENABLED:
        try:
            client = get_r2_client()
            client.put_object(
                Bucket=R2_BUCKET_NAME,
                Key="soundconnect/waveforms.json",
                Body=json.dumps(data, ensure_ascii=False).encode("utf-8"),
                ContentType="application/json",
            )
        except Exception as e:  # noqa: BLE001
            print(f"[R2] sauvegarde waveforms Sound Connect échouée : {e}")


@app.get("/soundconnect/tracks/{track_id}/waveform")
def soundconnect_get_waveform(track_id: str):
    entry = _waveforms_load().get(track_id)
    if not entry:
        raise HTTPException(status_code=404, detail="Pas encore analysé.")
    return entry


class WaveformSaveBody(BaseModel):
    peaks: list[float]


@app.post("/soundconnect/tracks/{track_id}/waveform")
def soundconnect_save_waveform(track_id: str, body: WaveformSaveBody):
    data = _waveforms_load()
    data[track_id] = {"peaks": body.peaks, "computedAt": _now_iso()}
    _waveforms_save(data)
    return {"ok": True}


def _sc_next_version_filename(current_filename: str, files_in_folder: list, uploaded_filename: str) -> str:
    """Détermine le nom de fichier à utiliser pour une nouvelle version PHONO.

    Règle de Michel : on repère le numéro de mix le plus élevé actuellement présent
    (souvent après un '#', ex. '#06') et on construit le même nom de fichier avec ce
    numéro incrémenté ('#07'), en conservant tout le reste du nom (44khz, 24Bit, etc.)
    à l'identique. Si le fichier déposé par l'équipe porte déjà exactement ce nom
    attendu, on le garde tel quel plutôt que de le renommer nous-mêmes.
    """
    audio_files = [f for f in files_in_folder if (f.get("name") or "").lower().endswith(_SC_AUDIO_EXT)]
    max_version, pad = 0, 2
    for f in audio_files:
        m = _SC_VERSION_NUM_RE.search(f.get("name") or "")
        if m and int(m.group(1)) > max_version:
            max_version, pad = int(m.group(1)), len(m.group(1))
    next_str = str(max_version + 1).zfill(pad)

    m_cur = _SC_VERSION_NUM_RE.search(current_filename or "")
    if m_cur:
        expected = current_filename[:m_cur.start()] + f"#{next_str}" + current_filename[m_cur.end():]
    else:
        # Le fichier de référence ne suit pas la convention "#NN" (cas déjà connu, ex.
        # "TW - Dernière Danse-24bits-M.wav") : on ne peut pas incrémenter proprement,
        # on ajoute le numéro de version en filet de sécurité plutôt que d'échouer.
        base, ext = os.path.splitext(current_filename or uploaded_filename or "nouvelle-version.wav")
        expected = f"{base} #{next_str}{ext}"

    def _norm(s):
        return re.sub(r"\s+", " ", (s or "").strip()).lower()

    if uploaded_filename and _norm(uploaded_filename) == _norm(expected):
        return uploaded_filename  # déjà nommé correctement par l'équipe, on ne renomme pas
    return expected


@app.post("/soundconnect/tracks/{track_id}/new-version")
async def soundconnect_new_version(track_id: str, file: UploadFile = File(...)):
    """Seul endpoint qui écrit dans PHONO (SharePoint), sur demande explicite de
    l'équipe (clic droit -> Nouvelle version). N'écrase jamais un fichier existant
    (conflictBehavior=rename côté Make) : le nouveau mix s'ajoute toujours à côté des
    précédents, jamais à leur place."""
    if not MAKE_SOUNDCONNECT_UPLOAD_VERSION_URL:
        raise HTTPException(status_code=500, detail="MAKE_SOUNDCONNECT_UPLOAD_VERSION_URL n'est pas configurée côté serveur (Render > Environment).")
    data = _org_load()
    track = data["tracks"].get(track_id)
    if not track:
        raise HTTPException(status_code=404, detail="Titre introuvable.")
    parent_folder_id = track.get("parentFolderId")
    if not parent_folder_id:
        raise HTTPException(status_code=400, detail="Dossier PHONO d'origine inconnu pour ce titre — resynchronise le catalogue puis réessaie.")

    raw_bytes = await file.read()
    if not raw_bytes:
        raise HTTPException(status_code=400, detail="Fichier vide.")
    if len(raw_bytes) > 200 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="Fichier trop volumineux (200 Mo max).")

    siblings = [it for it in _sc_list_folder(parent_folder_id) if not it.get("isFolder")]
    new_filename = _sc_next_version_filename(track.get("filename") or "", siblings, file.filename or "")

    try:
        r = requests.post(
            MAKE_SOUNDCONNECT_UPLOAD_VERSION_URL,
            files={"file": (new_filename, raw_bytes, file.content_type or "application/octet-stream")},
            data={"folderId": parent_folder_id, "filename": new_filename},
            timeout=180,
        )
        r.raise_for_status()
        result = r.json()
    except requests.RequestException as e:
        raise HTTPException(status_code=502, detail=f"Erreur lors de l'upload vers SharePoint (Make) : {e}")
    if not result.get("ok"):
        raise HTTPException(status_code=502, detail="L'upload SharePoint a échoué côté Make.")

    # Relit le dossier pour récupérer un downloadUrl frais et cohérent avec le reste du
    # catalogue (la réponse d'upload elle-même n'expose pas forcément ce champ).
    fresh = _sc_find_in_folder(parent_folder_id, external_id=result.get("id"), filename=result.get("name"))

    track["filename"] = result.get("name", new_filename)
    track["size"] = (fresh or {}).get("size", result.get("size"))
    track["webUrl"] = (fresh or {}).get("webUrl", result.get("webUrl"))
    track["downloadUrl"] = (fresh or {}).get("downloadUrl")
    track["lastModified"] = (fresh or {}).get("lastModifiedDateTime", result.get("lastModifiedDateTime"))
    track["externalId"] = result.get("id", track.get("externalId"))
    track["versionConfidence"] = "strict"
    track["syncedAt"] = _now_iso()
    _org_save(data)
    return {"ok": True, "track": track}


# --------------------------------------------------------------------------
# Sound Connect — covers (auto-générées si absentes, uploadables sinon)
# --------------------------------------------------------------------------
# Chaque espace / dossier / projet / playlist / titre a une "cover" accessible à la
# même URL stable GET /soundconnect/covers/{kind}/{id}, qu'elle ait été uploadée par
# l'équipe ou non : si aucun fichier perso n'existe, un design simple (dégradé +
# initiales, dérivé de façon déterministe de l'id) est généré à la volée en SVG — pas
# de dépendance lourde (Pillow) requise. L'upload (POST, multipart) remplace ce
# placeholder par une vraie image ; le DELETE revient au design généré.
COVER_KINDS = {"workspace", "folder", "track"}
COVERS_DIR = DATA_DIR / "covers"
COVERS_DIR.mkdir(parents=True, exist_ok=True)


def _xml_escape(s: str) -> str:
    return (s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _cover_initials(name: str) -> str:
    words = [w for w in re.split(r"\s+", (name or "").strip()) if w]
    if not words:
        return "?"
    if len(words) == 1:
        return words[0][:2].upper()
    return (words[0][0] + words[1][0]).upper()


def _hsl_hex(hue_deg: float, sat_pct: float, light_pct: float) -> str:
    """HSL -> #rrggbb. On évite hsl(...) dans le SVG : pas garanti supporté par tous
    les moteurs de rendu (ex. rasterizers serveur), contrairement au hex qui l'est partout."""
    r, g, b = colorsys.hls_to_rgb(hue_deg / 360.0, light_pct / 100.0, sat_pct / 100.0)
    return f"#{int(round(r * 255)):02x}{int(round(g * 255)):02x}{int(round(b * 255)):02x}"


def _cover_svg(seed: str, label: str) -> bytes:
    h = 0
    for ch in seed or "":
        h = (h * 31 + ord(ch)) & 0xFFFFFFFF
    hue1 = h % 360
    hue2 = (hue1 + 46) % 360
    blob_hue = (hue1 + 190) % 360
    initials = _xml_escape(_cover_initials(label))
    c1, c2 = _hsl_hex(hue1, 58, 40), _hsl_hex(hue2, 58, 24)
    blob1, blob2 = _hsl_hex(blob_hue, 60, 55), _hsl_hex(hue2, 60, 18)
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="{c1}" />
      <stop offset="100%" stop-color="{c2}" />
    </linearGradient>
  </defs>
  <rect width="512" height="512" fill="url(#g)" />
  <circle cx="404" cy="104" r="150" fill="{blob1}" opacity="0.16" />
  <circle cx="86" cy="432" r="190" fill="{blob2}" opacity="0.28" />
  <text x="256" y="290" font-family="Helvetica Neue, Arial, sans-serif" font-size="168"
        font-weight="700" fill="rgba(255,255,255,0.92)" text-anchor="middle"
        dominant-baseline="middle" letter-spacing="2">{initials}</text>
</svg>"""
    return svg.encode("utf-8")


def _cover_entity_name(data: dict, kind: str, entity_id: str) -> Optional[str]:
    if kind == "workspace":
        ws = data["workspaces"].get(entity_id)
        return ws["name"] if ws else None
    if kind == "folder":
        f = data["folders"].get(entity_id)
        return f["name"] if f else None
    if kind == "track":
        t = data["tracks"].get(entity_id)
        return f'{t["artist"]} {t["title"]}' if t else None
    return None


def _cover_r2_key(kind: str, entity_id: str, ext: str) -> str:
    return f"soundconnect/covers/{kind}_{entity_id}{ext}"


def _cover_local_file(kind: str, entity_id: str) -> Optional[Path]:
    matches = list(COVERS_DIR.glob(f"{kind}_{entity_id}.*"))
    return matches[0] if matches else None


def _cover_raw_bytes(kind: str, entity_id: str) -> Optional[tuple]:
    """Renvoie (bytes, media_type) si une cover a été uploadée pour cette entité
    (fichier local, ou repli R2 avec mise en cache locale au passage), sinon None.
    Ne génère jamais de placeholder — c'est le rôle de _resolve_cover()."""
    local = _cover_local_file(kind, entity_id)
    if local:
        media_type = mimetypes.guess_type(local.name)[0] or "application/octet-stream"
        return local.read_bytes(), media_type
    if R2_ENABLED:
        try:
            client = get_r2_client()
            for ext in (".jpg", ".jpeg", ".png", ".webp", ".gif"):
                try:
                    obj = client.get_object(Bucket=R2_BUCKET_NAME, Key=_cover_r2_key(kind, entity_id, ext))
                    body = obj["Body"].read()
                    (COVERS_DIR / f"{kind}_{entity_id}{ext}").write_bytes(body)
                    media_type = mimetypes.guess_type(ext)[0] or "application/octet-stream"
                    return body, media_type
                except Exception:  # noqa: BLE001 — pas cette extension, tente la suivante
                    continue
        except Exception:  # noqa: BLE001 — R2 indisponible, on retombe sur le placeholder
            pass
    return None


def _cover_track_parent_folder(data: dict, track_id: str) -> Optional[str]:
    """Un titre appartient normalement à un seul dossier/projet — on retrouve ce
    parent via folderTracks (pas de référence directe stockée sur le titre)."""
    for fid, track_ids in data["folderTracks"].items():
        if track_id in track_ids:
            return fid
    return None


def _cover_placeholder_tile(seed: str, label: str, size: int = 512):
    """Version PIL (raster, pas SVG) du même visuel dégradé + initiales, utilisée
    comme tuile dans un montage composite (impossible de composer une image
    raster à partir de SVG sans dépendance de rasterisation supplémentaire)."""
    from PIL import Image, ImageDraw, ImageFont

    h = 0
    for ch in seed or "":
        h = (h * 31 + ord(ch)) & 0xFFFFFFFF
    hue1 = h % 360
    hue2 = (hue1 + 46) % 360
    c1 = tuple(int(round(x * 255)) for x in colorsys.hls_to_rgb(hue1 / 360.0, 0.40, 0.58))
    c2 = tuple(int(round(x * 255)) for x in colorsys.hls_to_rgb(hue2 / 360.0, 0.24, 0.58))
    img = Image.new("RGB", (size, size), c1)
    # dégradé diagonal simple : mélange linéaire coin haut-gauche -> bas-droit
    px = img.load()
    for y in range(size):
        t = y / max(1, size - 1)
        row = tuple(int(c1[i] + (c2[i] - c1[i]) * t) for i in range(3))
        for x in range(size):
            px[x, y] = row
    draw = ImageDraw.Draw(img)
    initials = _cover_initials(label)
    font_size = int(size * 0.34)
    try:
        font = ImageFont.load_default(size=font_size)
    except TypeError:
        font = ImageFont.load_default()
    bbox = draw.textbbox((0, 0), initials, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    draw.text(((size - tw) / 2 - bbox[0], (size - th) / 2 - bbox[1]), initials, font=font, fill=(255, 255, 255))
    return img


def _cover_tile_image(kind: str, entity_id: str, label: str, size: int = 512):
    """Image PIL carrée (recadrée/redimensionnée) pour une tuile de montage :
    la vraie cover uploadée si elle existe, sinon un placeholder dégradé+initiales."""
    from PIL import Image
    import io as _io

    raw = _cover_raw_bytes(kind, entity_id)
    if raw:
        try:
            img = Image.open(_io.BytesIO(raw[0])).convert("RGB")
            w, h = img.size
            side = min(w, h)
            img = img.crop(((w - side) // 2, (h - side) // 2, (w - side) // 2 + side, (h - side) // 2 + side))
            return img.resize((size, size), Image.LANCZOS)
        except Exception:  # noqa: BLE001 — fichier corrompu, on retombe sur le placeholder
            pass
    return _cover_placeholder_tile(entity_id, label, size)


def _cover_montage_png(children: list, size: int = 512) -> bytes:
    """Grille 2x2 façon 'dossier' Spotify/Apple Music : jusqu'à 4 covers des
    projets enfants, dans l'ordre existant ; les cases restantes (si <4 enfants)
    sont laissées en fond neutre plutôt que remplies artificiellement."""
    from PIL import Image
    import io as _io

    canvas = Image.new("RGB", (size, size), (30, 30, 34))
    half = size // 2
    positions = [(0, 0), (half, 0), (0, half), (half, half)]
    for (x, y), child in zip(positions, children[:4]):
        tile = _cover_tile_image("folder", child["id"], child["name"], half)
        canvas.paste(tile, (x, y))
    buf = _io.BytesIO()
    canvas.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def _resolve_cover(data: dict, kind: str, entity_id: str, _depth: int = 0) -> tuple:
    """Point d'entrée unique pour résoudre la cover d'une entité Sound Connect :
    1) une vraie cover uploadée pour CETTE entité gagne toujours ;
    2) sinon, pour un titre : on hérite de la cover de son projet parent ;
    3) sinon, pour un dossier artiste (kind="folder", pas "project") qui a des
       enfants : montage 2x2 des covers de ces projets ;
    4) sinon : le placeholder dégradé + initiales généré à la volée (SVG, léger).
    Renvoie (bytes, media_type)."""
    raw = _cover_raw_bytes(kind, entity_id)
    if raw:
        return raw

    if kind == "track" and _depth < 4:
        parent_id = _cover_track_parent_folder(data, entity_id)
        if parent_id and parent_id in data["folders"]:
            return _resolve_cover(data, "folder", parent_id, _depth + 1)

    if kind == "folder":
        f = data["folders"].get(entity_id)
        if f is None:
            raise HTTPException(status_code=404, detail="Élément introuvable.")
        if f.get("kind") == "folder":
            children = sorted(
                (c for c in data["folders"].values() if c.get("parentId") == entity_id),
                key=lambda c: c.get("sortOrder", 0),
            )
            if children:
                return _cover_montage_png(children), "image/png"
        return _cover_svg(entity_id, f["name"]), "image/svg+xml"

    name = _cover_entity_name(data, kind, entity_id)
    if name is None:
        raise HTTPException(status_code=404, detail="Élément introuvable.")
    return _cover_svg(entity_id, name), "image/svg+xml"


@app.get("/soundconnect/covers/{kind}/{entity_id}")
def soundconnect_get_cover(kind: str, entity_id: str):
    if kind not in COVER_KINDS:
        raise HTTPException(status_code=404, detail="Type de cover inconnu.")
    data = _org_load()
    body, media_type = _resolve_cover(data, kind, entity_id)
    # Cache court pour tout ce qui est généré à la volée (placeholder ou montage,
    # qui peuvent changer dès qu'un enfant change de cover), long pour un vrai upload.
    is_generated = _cover_local_file(kind, entity_id) is None
    cache = "public, max-age=300" if is_generated else "public, max-age=3600"
    return Response(content=body, media_type=media_type, headers={"Cache-Control": cache})


def _cover_process_upload(raw: bytes) -> tuple:
    """Normalise toute image uploadée via ffmpeg (déjà utilisé ailleurs dans ce
    backend pour Sous-titres, donc disponible sur Render) : redimensionne à
    1600px max (aucun agrandissement, aspect conservé, rotation EXIF respectée)
    et recompresse en JPEG léger — jamais un rejet pour poids d'origine, juste
    une réduction. ffmpeg lit aussi des formats que Pillow ne sait pas décoder
    (HEIC export iPhone notamment). Renvoie (bytes, ext, content_type). Lève
    ValueError si le fichier est illisible même par ffmpeg."""
    import io as _io
    import tempfile

    has_alpha = False
    try:
        from PIL import Image
        probe = Image.open(_io.BytesIO(raw))
        has_alpha = probe.mode in ("RGBA", "LA") or (probe.mode == "P" and "transparency" in probe.info)
    except Exception:  # noqa: BLE001 — Pillow ne sait pas lire ce format (ex. HEIC), ffmpeg tentera quand même
        pass

    ext_out, content_type = (".png", "image/png") if has_alpha else (".jpg", "image/jpeg")
    with tempfile.TemporaryDirectory() as tmp:
        in_path = Path(tmp) / "in"
        out_path = Path(tmp) / f"out{ext_out}"
        in_path.write_bytes(raw)
        cmd = [
            "ffmpeg", "-y", "-i", str(in_path),
            "-frames:v", "1",
            "-vf", "scale='min(1600,iw)':'min(1600,ih)':force_original_aspect_ratio=decrease",
        ]
        if ext_out == ".jpg":
            cmd += ["-q:v", "3"]  # qualité ffmpeg JPEG (échelle 2-5, 3 = très bon rendu, fichier léger)
        cmd += [str(out_path)]
        try:
            subprocess.run(cmd, check=True, capture_output=True, timeout=60)
            return out_path.read_bytes(), ext_out, content_type
        except Exception as e:  # noqa: BLE001
            raise ValueError("Format d'image non reconnu — exporte en JPEG ou PNG et réessaie.") from e


@app.post("/soundconnect/covers/{kind}/{entity_id}")
async def soundconnect_upload_cover(kind: str, entity_id: str, file: UploadFile = File(...)):
    if kind not in COVER_KINDS:
        raise HTTPException(status_code=404, detail="Type de cover inconnu.")
    data = _org_load()
    if _cover_entity_name(data, kind, entity_id) is None:
        raise HTTPException(status_code=404, detail="Élément introuvable.")
    raw = await file.read()
    if len(raw) > 100 * 1024 * 1024:
        # Garde-fou anti-abus uniquement — ffmpeg réduit ensuite n'importe quelle image
        # réelle (photo, export Canva/Photoshop...) sans jamais rejeter pour le poids.
        raise HTTPException(status_code=400, detail="Fichier trop lourd (100 Mo max).")
    try:
        processed, ext, content_type = _cover_process_upload(raw)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    for old in COVERS_DIR.glob(f"{kind}_{entity_id}.*"):
        old.unlink(missing_ok=True)
    (COVERS_DIR / f"{kind}_{entity_id}{ext}").write_bytes(processed)
    if R2_ENABLED:
        try:
            client = get_r2_client()
            client.put_object(
                Bucket=R2_BUCKET_NAME,
                Key=_cover_r2_key(kind, entity_id, ext),
                Body=processed,
                ContentType=content_type,
            )
        except Exception as e:  # noqa: BLE001
            print(f"[R2] sauvegarde cover Sound Connect échouée : {e}")
    return {"coverUrl": f"/soundconnect/covers/{kind}/{entity_id}?v={int(time.time())}"}


@app.delete("/soundconnect/covers/{kind}/{entity_id}")
def soundconnect_delete_cover(kind: str, entity_id: str):
    if kind not in COVER_KINDS:
        raise HTTPException(status_code=404, detail="Type de cover inconnu.")
    removed = False
    for old in COVERS_DIR.glob(f"{kind}_{entity_id}.*"):
        old.unlink(missing_ok=True)
        removed = True
    if R2_ENABLED:
        try:
            client = get_r2_client()
            for ext in (".jpg", ".jpeg", ".png", ".webp", ".gif"):
                try:
                    client.delete_object(Bucket=R2_BUCKET_NAME, Key=_cover_r2_key(kind, entity_id, ext))
                except Exception:  # noqa: BLE001
                    pass
        except Exception:  # noqa: BLE001
            pass
    return {"removed": removed}


# --------------------------------------------------------------------------
# Partage externe — liens publics pour un titre ou un projet (Sound Connect)
#
# Un "share" pointe vers un titre OU un projet (kind="project"/"playlist") déjà
# organisé dans Sound Connect. Il ne duplique JAMAIS le fichier : au moment où
# quelqu'un écoute/télécharge via le lien public, on relit PHONO pour obtenir
# un lien SharePoint frais (_fresh_track_download_url, la même fonction que le
# téléchargement admin) — donc aucune donnée binaire n'est stockée côté
# partage, et rien n'est jamais écrit dans PHONO/SharePoint par ce mécanisme
# (cf. garantie donnée à Michel : seul le flux "Nouvelle version" écrit dans
# PHONO, jamais le classement/suppression/partage côté Sound Connect).
#
# Le "token" public ET l'id admin sont la MÊME valeur (uuid4.hex, 122 bits
# d'aléatoire — largement suffisant pour ne pas être devinable), pour rester
# simple : pas de mapping supplémentaire à maintenir. La page publique
# (share.html, frontend statique) lit ce token en query string et n'appelle
# que les routes /share/... ci-dessous, jamais les routes admin authentifiées.
# --------------------------------------------------------------------------

SHARE_ACCESS_TOKEN_TTL_S = 6 * 3600  # durée de vie du jeton d'accès (?at=) utilisé pour
# les redirections stream/download : elles ne peuvent pas porter de header personnalisé
# (balise <audio src=...>, téléchargement direct par clic du navigateur), donc le
# contrôle de mot de passe se fait une fois sur GET /share/{token} (header
# X-Share-Password), qui délivre ensuite ce jeton court à réutiliser en query string.


def _share_new_id() -> str:
    return uuid.uuid4().hex


def _share_hash_password(password: str, salt: str) -> str:
    return hashlib.sha256(f"{salt}:{password}".encode("utf-8")).hexdigest()


def _share_make_access_token(share_id: str) -> str:
    exp = int(time.time()) + SHARE_ACCESS_TOKEN_TTL_S
    payload = f"{share_id}:{exp}"
    sig = hmac.new(ADMIN_AUTH_SECRET.encode(), payload.encode(), hashlib.sha256).hexdigest()
    return base64.urlsafe_b64encode(f"{payload}:{sig}".encode()).decode()


def _share_verify_access_token(token: str, share_id: str) -> bool:
    if not ADMIN_AUTH_SECRET or not token:
        return False
    try:
        sid, exp, sig = base64.urlsafe_b64decode(token.encode()).decode().rsplit(":", 2)
        if sid != share_id:
            return False
        expected = hmac.new(ADMIN_AUTH_SECRET.encode(), f"{sid}:{exp}".encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, expected):
            return False
        return int(exp) >= int(time.time())
    except Exception:  # noqa: BLE001
        return False


def _share_target_exists(data: dict, target_type: str, target_id: str) -> bool:
    if target_type == "track":
        return target_id in data["tracks"]
    if target_type == "project":
        f = data["folders"].get(target_id)
        return bool(f and f["kind"] in ("project", "playlist"))
    return False


def _share_collect_track_ids(data: dict, folder_id: str) -> list:
    """Titres d'un projet ET de tous ses sous-projets imbriqués (le partage d'un
    projet suit exactement ce qui est affiché dans renderProjectMixed côté
    frontend), dédupliqués dans l'ordre de première rencontre — un même titre
    peut se trouver dans plusieurs sous-projets à la fois."""
    seen: list = []

    def walk(fid: str):
        for tid in data["folderTracks"].get(fid, []):
            if tid not in seen:
                seen.append(tid)
        for child in data["folders"].values():
            if child.get("parentId") == fid:
                walk(child["id"])

    walk(folder_id)
    return seen


def _share_target_track_ids(data: dict, share: dict) -> set:
    if share["targetType"] == "track":
        return {share["targetId"]}
    return set(_share_collect_track_ids(data, share["targetId"]))


def _share_project_artist_name(data: dict, folder: dict) -> Optional[str]:
    """Remonte la chaîne de parents jusqu'au dossier artiste racine (kind="folder",
    sans parent) pour afficher le nom de l'artiste sur la page publique."""
    cur = folder
    seen_ids = set()
    while cur and cur.get("parentId") and cur["id"] not in seen_ids:
        seen_ids.add(cur["id"])
        cur = data["folders"].get(cur["parentId"])
    return cur["name"] if cur else None


def _share_public_track(track: dict) -> dict:
    return {"id": track["id"], "title": track["title"], "artist": track["artist"]}


def _share_admin_view(share: dict) -> dict:
    """Vue admin d'un lien de partage : jamais le hash du mot de passe, juste s'il
    y en a un ou non."""
    v = {k: val for k, val in share.items() if k != "password"}
    v["hasPassword"] = bool(share.get("password"))
    v["url"] = f"{PUBLIC_SHARE_BASE_URL}/?id={share['id']}"
    return v


class SCSharePermissions(BaseModel):
    streaming: bool = True
    downloadHQ: bool = False
    trackInfo: bool = True


class SCShareCreateBody(BaseModel):
    targetType: str  # "track" | "project"
    targetId: str
    name: Optional[str] = None
    permissions: Optional[SCSharePermissions] = None
    password: Optional[str] = None


class SCShareUpdateBody(BaseModel):
    name: Optional[str] = None
    enabled: Optional[bool] = None
    permissions: Optional[SCSharePermissions] = None
    password: Optional[str] = None  # nouveau mot de passe à définir
    clearPassword: Optional[bool] = False  # true -> retire la protection existante


@app.get("/soundconnect/shares", dependencies=[Depends(require_admin)])
def soundconnect_list_shares(targetType: Optional[str] = None, targetId: Optional[str] = None):
    data = _org_load()
    shares = list(data.get("shares", {}).values())
    if targetType:
        shares = [s for s in shares if s["targetType"] == targetType]
    if targetId:
        shares = [s for s in shares if s["targetId"] == targetId]
    shares.sort(key=lambda s: s.get("createdAt") or "", reverse=True)
    return {"shares": [_share_admin_view(s) for s in shares]}


@app.post("/soundconnect/shares", dependencies=[Depends(require_admin)])
def soundconnect_create_share(body: SCShareCreateBody):
    if body.targetType not in ("track", "project"):
        raise HTTPException(status_code=400, detail="Type de partage invalide.")
    data = _org_load()
    if not _share_target_exists(data, body.targetType, body.targetId):
        raise HTTPException(status_code=404, detail="Élément à partager introuvable.")
    share_id = _share_new_id()
    password_rec = None
    if body.password:
        salt = secrets.token_hex(8)
        password_rec = {"salt": salt, "hash": _share_hash_password(body.password, salt)}
    perms = (body.permissions or SCSharePermissions()).dict()
    share = {
        "id": share_id,
        "targetType": body.targetType,
        "targetId": body.targetId,
        "name": (body.name or "").strip() or None,
        "enabled": True,
        "permissions": perms,
        "password": password_rec,
        "createdAt": _now_iso(),
        "updatedAt": _now_iso(),
    }
    data.setdefault("shares", {})[share_id] = share
    _org_save(data)
    return _share_admin_view(share)


@app.put("/soundconnect/shares/{share_id}", dependencies=[Depends(require_admin)])
def soundconnect_update_share(share_id: str, body: SCShareUpdateBody):
    data = _org_load()
    share = data.get("shares", {}).get(share_id)
    if not share:
        raise HTTPException(status_code=404, detail="Lien de partage introuvable.")
    if body.name is not None:
        share["name"] = body.name.strip() or None
    if body.enabled is not None:
        share["enabled"] = body.enabled
    if body.permissions is not None:
        share["permissions"] = body.permissions.dict()
    if body.clearPassword:
        share["password"] = None
    elif body.password:
        salt = secrets.token_hex(8)
        share["password"] = {"salt": salt, "hash": _share_hash_password(body.password, salt)}
    share["updatedAt"] = _now_iso()
    _org_save(data)
    return _share_admin_view(share)


@app.delete("/soundconnect/shares/{share_id}", dependencies=[Depends(require_admin)])
def soundconnect_delete_share(share_id: str):
    data = _org_load()
    if share_id in data.get("shares", {}):
        del data["shares"][share_id]
        _org_save(data)
    return {"deleted": True}


# --- Endpoints publics (aucune auth admin — protection par mot de passe optionnel) ---


def _share_get_enabled_or_404(data: dict, token: str) -> dict:
    share = data.get("shares", {}).get(token)
    if not share or not share.get("enabled", True):
        raise HTTPException(status_code=404, detail="Ce lien n'existe pas ou a été désactivé.")
    if not _share_target_exists(data, share["targetType"], share["targetId"]):
        raise HTTPException(status_code=404, detail="Le contenu partagé n'existe plus.")
    return share


def _share_check_password(share: dict, provided: Optional[str]) -> bool:
    pw = share.get("password")
    if not pw:
        return True
    if not provided:
        return False
    return hmac.compare_digest(_share_hash_password(provided, pw["salt"]), pw["hash"])


@app.get("/share/{token}")
def share_public_view(token: str, x_share_password: str = Header(default="")):
    data = _org_load()
    share = _share_get_enabled_or_404(data, token)
    if share.get("password") and not _share_check_password(share, x_share_password):
        raise HTTPException(status_code=401, detail="Mot de passe requis ou incorrect.")
    target_type = share["targetType"]
    if target_type == "track":
        track = data["tracks"][share["targetId"]]
        title, artist = track["title"], track["artist"]
        cover_url = f"/soundconnect/covers/track/{track['id']}"
        track_ids = [track["id"]]
        project_type = None
    else:
        folder = data["folders"][share["targetId"]]
        title, artist = folder["name"], (_share_project_artist_name(data, folder) or "")
        cover_url = f"/soundconnect/covers/folder/{folder['id']}"
        track_ids = _share_collect_track_ids(data, folder["id"])
        project_type = folder.get("projectType")
    tracks = [_share_public_track(data["tracks"][tid]) for tid in track_ids if tid in data["tracks"]]
    return {
        "id": share["id"],
        "name": share.get("name") or title,
        "targetType": target_type,
        "title": title,
        "artist": artist,
        "projectType": project_type,
        "coverUrl": cover_url,
        "tracks": tracks,
        "permissions": share["permissions"],
        "accessToken": _share_make_access_token(share["id"]),
    }


@app.get("/share/{token}/tracks/{track_id}/stream")
def share_public_stream(token: str, track_id: str, at: str = ""):
    data = _org_load()
    share = _share_get_enabled_or_404(data, token)
    if not share["permissions"].get("streaming", True):
        raise HTTPException(status_code=403, detail="La lecture n'est pas activée pour ce lien.")
    if not _share_verify_access_token(at, share["id"]):
        raise HTTPException(status_code=401, detail="Accès expiré — recharge la page de partage.")
    if track_id not in _share_target_track_ids(data, share):
        raise HTTPException(status_code=404, detail="Ce titre ne fait pas partie de ce partage.")
    track = data["tracks"].get(track_id)
    fresh_url = _fresh_track_download_url(track) if track else None
    if not fresh_url:
        raise HTTPException(status_code=404, detail="Lien audio indisponible.")
    return RedirectResponse(fresh_url)


@app.get("/share/{token}/tracks/{track_id}/download")
def share_public_download(token: str, track_id: str, at: str = ""):
    data = _org_load()
    share = _share_get_enabled_or_404(data, token)
    if not share["permissions"].get("downloadHQ", False):
        raise HTTPException(status_code=403, detail="Le téléchargement n'est pas activé pour ce lien.")
    if not _share_verify_access_token(at, share["id"]):
        raise HTTPException(status_code=401, detail="Accès expiré — recharge la page de partage.")
    if track_id not in _share_target_track_ids(data, share):
        raise HTTPException(status_code=404, detail="Ce titre ne fait pas partie de ce partage.")
    track = data["tracks"].get(track_id)
    fresh_url = _fresh_track_download_url(track) if track else None
    if not fresh_url:
        raise HTTPException(status_code=404, detail="Lien audio indisponible.")
    return RedirectResponse(fresh_url)
