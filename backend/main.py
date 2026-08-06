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
- Transcription : faster-whisper, modèle défini par la variable d'env WHISPER_MODEL (défaut "small" —
  voir docs/sous-titres.md pour l'arbitrage qualité/RAM selon le plan Render).
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
import datetime
import difflib
import hashlib
import hmac
import json
import os
import re
import shutil
import sqlite3
import subprocess
import threading
import time
import unicodedata
import uuid
from pathlib import Path

from typing import List

import requests
from fastapi import Body, Depends, FastAPI, Form, Header, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# --------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------

APP_DIR = Path(__file__).parent
DATA_DIR = Path(os.environ.get("DATA_DIR", APP_DIR / "data"))
RESULTS_DIR = DATA_DIR / "results"
DATA_DIR.mkdir(parents=True, exist_ok=True)
RESULTS_DIR.mkdir(parents=True, exist_ok=True)

WHISPER_MODEL_NAME = os.environ.get("WHISPER_MODEL", "small")
DB_PATH = DATA_DIR / "app.db"

# Clé API Flowstage (app.theflowstage.com/api-keys) — quand elle est renseignée, le backend
# essaie de retrouver l'aesthetic Flowstage correspondante et d'en réutiliser les paroles
# vérifiées (bien plus fiables qu'une transcription automatique) avant de se rabattre sur
# faster-whisper. Voir find_flowstage_aesthetic() / get_flowstage_words() plus bas.
FLOWSTAGE_API_KEY = os.environ.get("FLOWSTAGE_API_KEY", "")
FLOWSTAGE_BASE_URL = "https://api.theflowstage.com"

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

MAKE_INVENTAIRE_URLS = {
    "list": os.environ.get("MAKE_INVENTAIRE_LIST_URL", ""),
    "add": os.environ.get("MAKE_INVENTAIRE_ADD_URL", ""),
    "update": os.environ.get("MAKE_INVENTAIRE_UPDATE_URL", ""),
    "delete": os.environ.get("MAKE_INVENTAIRE_DELETE_URL", ""),
}

# Analyse photo IA (préremplissage du formulaire d'ajout d'inventaire) — clé
# API Anthropic à définir sur Render (Dashboard > service backend > Environment).
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
ANTHROPIC_VISION_MODEL = os.environ.get("ANTHROPIC_VISION_MODEL", "claude-sonnet-5")
ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages"

# Origines autorisées à appeler ce backend depuis le navigateur.
ALLOWED_ORIGINS = [
    "https://duchess-hub-front.onrender.com",
    "https://duchess-hub.netlify.app",  # ancien hébergement, gardé au cas où
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


def find_flowstage_aesthetic(artiste: str, titre: str):
    if not (artiste or "").strip() and not (titre or "").strip():
        return None
    aesthetics = get_flowstage_aesthetics()
    if not aesthetics:
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


def get_flowstage_words(aesthetic_id: str, granularity: str, expected_duration_s: float = 0.0):
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

    return lines_abs if granularity == "phrase" else _interpolate_words(lines_abs)


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


def _merge_apostrophe_words(words):
    """Règle permanente : en français, l'apostrophe n'est jamais un séparateur de mot ("c'est",
    "s'aiment", "j'aurais" doivent rester UN SEUL mot). faster-whisper peut renvoyer ces
    contractions comme deux tokens distincts avec leurs propres timestamps (ex. "c'" puis "est")
    — on les refusionne ici, une bonne fois pour toutes, avant la mise en cache. Comme ce point
    est appelé sur tous les chemins (whisper ET Flowstage) avant `_cache_timing`, toute la suite
    (aperçu live, édition manuelle, rendu final) en profite automatiquement."""
    if not words:
        return words
    merged = []
    for w in words:
        text = (w.get("text") or "")
        prev = merged[-1] if merged else None
        if prev and prev["text"] and prev["text"][-1] in ("'", "’"):
            prev["text"] += text
            prev["end"] = w.get("end", prev["end"])
        else:
            merged.append(dict(w))
    return merged


def get_or_transcribe(single_cle: str, granularity: str, audio_path: Path, artiste: str = "", titre: str = ""):
    """Source des paroles timées, par ordre de préférence :
    1. Cache local (déjà généré une fois, peu importe la source d'origine).
    2. Flowstage (paroles vérifiées manuellement, bien plus fiables qu'une transcription
       automatique — voir find_flowstage_aesthetic / get_flowstage_words). Rejetée si la durée
       de l'audio Flowstage ne colle pas à celle de l'upload (voir get_flowstage_words) — un
       "audio" Flowstage peut n'être qu'un clip partiel du morceau, pas le morceau entier.
    3. Repli : transcription faster-whisper de l'audio uploadé."""
    conn = db()
    row = conn.execute(
        "SELECT timing_json FROM lyrics_timing WHERE single_cle = ? AND granularite = ?",
        (single_cle, granularity),
    ).fetchone()
    conn.close()
    if row:
        return json.loads(row["timing_json"])

    if FLOWSTAGE_API_KEY:
        aesthetic = find_flowstage_aesthetic(artiste, titre)
        if aesthetic:
            expected_duration = _probe_audio_duration(audio_path)
            words = get_flowstage_words(aesthetic["id"], granularity, expected_duration_s=expected_duration)
            if words:
                words = _merge_apostrophe_words(words)
                _cache_timing(single_cle, granularity, words, "flowstage")
                return words

    words = transcribe(audio_path, granularity)
    words = _merge_apostrophe_words(words)
    _cache_timing(single_cle, granularity, words, "audio_uploade")
    return words


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
    edited_words="",
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
            _cache_timing(single_cle, granularity, words, "verifie_manuellement")
        else:
            words = get_or_transcribe(single_cle, granularity, audio_path, artiste=artiste, titre=titre)
        update_job(job_id, step_lyrics=1, current_label="Paroles timées")

        if not words:
            raise RuntimeError("Transcription vide — vérifie que le fichier contient bien de la voix audible.")

        if option == "preview":
            # Transcription seule, pas de SRT/ASS/rendu — sert uniquement à alimenter
            # l'aperçu vidéo live côté front (vraie vidéo + vrai timing, pendant que
            # l'utilisateur choisit son style, avant de lancer le vrai rendu).
            update_job(
                job_id,
                status="done",
                current_label="Terminé",
                words_json=json.dumps(words),
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
            edited_words=edited_words,
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
