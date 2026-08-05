FROM python:3.11-slim

# ffmpeg est indispensable (extraction audio + burn-in des sous-titres) et n'est pas
# inclus dans les runtimes Python natifs de Render — d'où l'image Docker.
# fontconfig + curl servent à installer les polices custom ci-dessous.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg fontconfig curl \
    && rm -rf /var/lib/apt/lists/*

# Polices custom (Google Fonts) utilisées par le styliseur de sous-titres (backend/main.py,
# FONT_META). Sans elles, libass (le moteur qui incruste le .ass dans la vidéo) substitue une
# police système par défaut et le rendu ne correspond plus à la typo choisie côté front.
RUN mkdir -p /usr/share/fonts/truetype/custom && cd /usr/share/fonts/truetype/custom \
    && curl -fsSL -o Poppins-Bold.ttf "https://raw.githubusercontent.com/google/fonts/main/ofl/poppins/Poppins-Bold.ttf" \
    && curl -fsSL -o Poppins-ExtraBold.ttf "https://raw.githubusercontent.com/google/fonts/main/ofl/poppins/Poppins-ExtraBold.ttf" \
    && curl -fsSL -o PlayfairDisplay.ttf "https://raw.githubusercontent.com/google/fonts/main/ofl/playfairdisplay/PlayfairDisplay%5Bwght%5D.ttf" \
    && curl -fsSL -o BebasNeue-Regular.ttf "https://raw.githubusercontent.com/google/fonts/main/ofl/bebasneue/BebasNeue-Regular.ttf" \
    && curl -fsSL -o SpaceGrotesk.ttf "https://raw.githubusercontent.com/google/fonts/main/ofl/spacegrotesk/SpaceGrotesk%5Bwght%5D.ttf" \
    && curl -fsSL -o Inter.ttf "https://raw.githubusercontent.com/google/fonts/main/ofl/inter/Inter%5Bopsz%2Cwght%5D.ttf" \
    && curl -fsSL -o Anton-Regular.ttf "https://raw.githubusercontent.com/google/fonts/main/ofl/anton/Anton-Regular.ttf" \
    && curl -fsSL -o Oswald.ttf "https://raw.githubusercontent.com/google/fonts/main/ofl/oswald/Oswald%5Bwght%5D.ttf" \
    && curl -fsSL -o Caveat.ttf "https://raw.githubusercontent.com/google/fonts/main/ofl/caveat/Caveat%5Bwght%5D.ttf" \
    && curl -fsSL -o Montserrat.ttf "https://raw.githubusercontent.com/google/fonts/main/ofl/montserrat/Montserrat%5Bwght%5D.ttf" \
    && curl -fsSL -o ArchivoBlack-Regular.ttf "https://raw.githubusercontent.com/google/fonts/main/ofl/archivoblack/ArchivoBlack-Regular.ttf" \
    && curl -fsSL -o Bangers-Regular.ttf "https://raw.githubusercontent.com/google/fonts/main/ofl/bangers/Bangers-Regular.ttf" \
    && curl -fsSL -o Righteous-Regular.ttf "https://raw.githubusercontent.com/google/fonts/main/ofl/righteous/Righteous-Regular.ttf" \
    && curl -fsSL -o RobotoCondensed.ttf "https://raw.githubusercontent.com/google/fonts/main/ofl/robotocondensed/RobotoCondensed%5Bwght%5D.ttf" \
    && curl -fsSL -o LuckiestGuy-Regular.ttf "https://raw.githubusercontent.com/google/fonts/main/apache/luckiestguy/LuckiestGuy-Regular.ttf" \
    && curl -fsSL -o PermanentMarker-Regular.ttf "https://raw.githubusercontent.com/google/fonts/main/apache/permanentmarker/PermanentMarker-Regular.ttf" \
    && fc-cache -f

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV DATA_DIR=/app/data
ENV WHISPER_MODEL=small

EXPOSE 8000

CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]
