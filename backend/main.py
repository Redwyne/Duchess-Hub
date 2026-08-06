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
- Recherche audio maître Flowstage : pas encore branchée (clé API à fournir) -> on transcrit toujours
  l'audio extrait du fichier uploadé pour l'instant. TODO une fois la clé fournie.
"""

import base64
import datetime
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
import uuid
from pathlib import Path

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
            error_message TEXT
        )"""
    )
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


def get_or_transcribe(single_cle: str, granularity: str, audio_path: Path):
    conn = db()
    row = conn.execute(
        "SELECT timing_json FROM lyrics_timing WHERE single_cle = ? AND granularite = ?",
        (single_cle, granularity),
    ).fetchone()
    if row:
        conn.close()
        return json.loads(row["timing_json"])

    words = transcribe(audio_path, granularity)
    conn.execute(
        "INSERT OR REPLACE INTO lyrics_timing VALUES (?, ?, ?, ?, ?)",
        (
            single_cle,
            granularity,
            json.dumps(words),
            "audio_uploade",  # TODO: "flowstage_master" une fois la clé API Flowstage branchée
            datetime.datetime.utcnow().isoformat(),
        ),
    )
    conn.commit()
    conn.close()
    return words


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
):
    try:
        granularity = "mot" if (option == "video" and mode != "full") else "phrase"
        single_cle = slugify_key(artiste, titre)

        audio_path = DATA_DIR / f"{job_id}_audio.wav"
        run(["ffmpeg", "-y", "-i", str(upload_path), "-vn", "-ac", "1", "-ar", "16000", str(audio_path)])

        words = get_or_transcribe(single_cle, granularity, audio_path)
        update_job(job_id, step_lyrics=1, current_label="Paroles timées")

        if not words:
            raise RuntimeError("Transcription vide — vérifie que le fichier contient bien de la voix audible.")

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


@app.post("/admin/inventaire/{action}")
async def admin_inventaire(action: str, payload: dict = Body(default={}), _ok: bool = Depends(require_admin)):
    url = MAKE_INVENTAIRE_URLS.get(action)
    if not url:
        raise HTTPException(
            status_code=500,
            detail=f"Action '{action}' inconnue ou variable d'environnement manquante côté serveur.",
        )
    try:
        r = requests.post(url, json=payload, timeout=25)
    except requests.RequestException as e:
        raise HTTPException(status_code=502, detail=f"Erreur de connexion à Make : {e}")
    try:
        data = r.json()
    except ValueError:
        data = {"raw": r.text}
    return JSONResponse(data, status_code=r.status_code if r.status_code < 500 else 502)
