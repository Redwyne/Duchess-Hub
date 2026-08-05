"""
Duchess Hub — backend de l'onglet Sous-titres.

Deux usages, un seul moteur :
- Option 1 "fichier" : upload audio (ou vidéo) -> .srt simple.
- Option 2 "video"   : upload vidéo -> vidéo rendue, sous-titres stylés incrustés (.ass + ffmpeg burn-in).

Etat v1 :
- Transcription : faster-whisper, modèle défini par la variable d'env WHISPER_MODEL (défaut "small" —
  voir docs/sous-titres.md pour l'arbitrage qualité/RAM selon le plan Render).
- Cache "Lyrics Timing" : SQLite local (fichier dans DATA_DIR). Sur le plan Starter de Render le disque
  n'est PAS persistant entre redéploiements -> le cache est reconstruit au besoin, ce n'est pas grave
  pour la mécanique mais à garder en tête (upgrade possible vers un disque persistant Render, ou Postgres,
  si le volume le justifie).
- Recherche audio maître Flowstage : pas encore branchée (clé API à fournir) -> on transcrit toujours
  l'audio extrait du fichier uploadé pour l'instant. TODO une fois la clé fournie.
"""

import datetime
import json
import os
import re
import shutil
import sqlite3
import subprocess
import threading
import uuid
from pathlib import Path

from fastapi import FastAPI, Form, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

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
# Génération .ass (Option 2) — 3 modes d'apparition
# --------------------------------------------------------------------------


def _ass_ts(t: float) -> str:
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = t % 60
    return f"{h:d}:{m:02d}:{s:05.2f}"


def build_ass(words, mode: str, font: str, font_weight: str, size_pct: float, color_hex: str, video_h: int = 1920) -> str:
    color_hex = color_hex.lstrip("#")
    r, g, b = color_hex[0:2], color_hex[2:4], color_hex[4:6]
    ass_color = f"&H00{b}{g}{r}"  # ASS = &HAABBGGRR, AA=00 -> opaque
    font_size = max(10, int(video_h * (size_pct / 100.0)))
    bold = -1 if int(font_weight) >= 700 else 0
    font_clean = font.split(",")[0].strip().strip("'").strip('"')

    header = (
        "[Script Info]\n"
        "ScriptType: v4.00+\n"
        f"PlayResX: 1080\nPlayResY: {video_h}\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, Bold, "
        "BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV\n"
        f"Style: Default,{font_clean},{font_size},{ass_color},&H00000000,{bold},1,2,1,5,60,60,120\n"
        "[Events]\n"
        "Format: Layer, Start, End, Style, Text\n"
    )

    lines = []
    if mode == "full":
        for w in words:
            lines.append(f"Dialogue: 0,{_ass_ts(w['start'])},{_ass_ts(w['end'])},Default,{w['text']}")
    elif mode == "replace":
        for w in words:
            lines.append(f"Dialogue: 0,{_ass_ts(w['start'])},{_ass_ts(w['end'])},Default,{w['text'].upper()}")
    else:  # "build" — la ligne se construit mot après mot, reset tous les 3 mots
        group = []
        for i, w in enumerate(words):
            group.append(w)
            text = r"\N".join(_wrap_build_line(group))
            # Chaque étape ne doit être visible que jusqu'à l'apparition du mot suivant —
            # sinon les étapes successives se chevauchent et s'empilent à l'écran (bug vu au test).
            start = w["start"]
            end = words[i + 1]["start"] if i + 1 < len(words) else w["end"]
            if end <= start:
                end = w["end"]
            lines.append(f"Dialogue: 0,{_ass_ts(start)},{_ass_ts(end)},Default,{text.upper()}")
            if len(group) >= 3:
                group = []

    return header + "\n".join(lines) + "\n"


def _wrap_build_line(group):
    """Découpe le texte cumulé du groupe en 1 ou 2 lignes courtes (façon 'IL REMET' / 'RENDEZ-VOUS')."""
    text = " ".join(x["text"] for x in group)
    words = text.split(" ")
    if len(words) <= 2:
        return [text]
    mid = len(words) // 2 + (len(words) % 2)
    return [" ".join(words[:mid]), " ".join(words[mid:])]


# --------------------------------------------------------------------------
# Traitement du job (thread d'arrière-plan)
# --------------------------------------------------------------------------


def run(cmd):
    subprocess.run(cmd, check=True, capture_output=True)


def process_job(job_id, option, artiste, titre, upload_path: Path, font, font_weight, size_pct, color, mode):
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
            update_job(
                job_id,
                step_srt=1,
                status="done",
                current_label="Terminé",
                download_url=f"/files/{job_id}.srt",
            )
            return

        # Option "video"
        probe = subprocess.run(
            [
                "ffprobe", "-v", "error", "-select_streams", "v:0",
                "-show_entries", "stream=height", "-of", "csv=p=0", str(upload_path),
            ],
            capture_output=True, text=True,
        )
        video_h = int((probe.stdout or "1920").strip() or 1920)

        ass_path = DATA_DIR / f"{job_id}.ass"
        ass_path.write_text(
            build_ass(words, mode, font, font_weight, float(size_pct), color, video_h),
            encoding="utf-8",
        )
        update_job(job_id, step_ass=1, current_label="Style appliqué")

        out_path = RESULTS_DIR / f"{job_id}.mp4"
        # ffmpeg a besoin d'un chemin sans caractères spéciaux problématiques dans le filtre -vf ass=...
        safe_ass = DATA_DIR / f"{job_id}_subs.ass"
        shutil.copy(ass_path, safe_ass)
        run([
            "ffmpeg", "-y", "-i", str(upload_path),
            "-vf", f"ass={safe_ass.as_posix()}",
            "-c:a", "copy", str(out_path),
        ])
        update_job(
            job_id,
            step_render=1,
            status="done",
            current_label="Terminé",
            download_url=f"/files/{job_id}.mp4",
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
