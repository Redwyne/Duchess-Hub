# Sous-titres — Framework technique

Onglet **duchess-hub.netlify.app**, fusion de l'ex-placeholder "Sous-titres SRT" et du projet "Sous-titres Auto". Un seul onglet, deux options clairement visibles dès l'arrivée (deux boutons/panneaux en haut, l'utilisateur choisit avant d'uploader).

Hors scope pour ce projet : le "hook" statique (ligne fixe en haut, présente sur toutes les vidéos Flowstage analysées) n'est pas concerné — on ne le reproduit pas, on l'ignore complètement dans tout ce qui suit.

## 0. Les deux options

### Option 1 — Fichier de sous-titres seul
- Entrée : upload d'un audio (ou vidéo — on extrait juste la piste son).
- Sortie : **.srt, systématiquement, sans style**. Pas de format alternatif qui bundlerait le style : le seul format de sous-titres qui embarque vraiment typo/taille/couleur/animation dans le fichier lui-même est l'ASS, et il n'est pas assez portable (voir §0bis) pour servir de sortie "simple" — autant garder l'Option 1 strictement simple et universelle.

### Option 2 — Notre projet : vidéo sous-titrée rendue
- Entrée : upload vidéo + recherche du single (BDD) + réglages de style (police / taille / couleur / mode d'apparition, voir §4).
- Sortie : la vidéo elle-même, sous-titres synchronisés déjà incrustés.
- Détail complet : voir §2.

### 0bis. Pourquoi l'ASS reste réservé à l'Option 2
Le .ass (Advanced SubStation Alpha) est le seul format qui porte nativement le style dans le fichier — mais CapCut et Premiere Pro (sans plugin) l'ouvrent en texte brut et perdent toute la mise en forme. Il n'est fiable que quand c'est **notre propre backend** qui l'interprète (ffmpeg, pour le burn-in). Donc : ASS = format de travail interne pour "nos propres créations" (Option 2 uniquement), jamais exposé comme export à quelqu'un qui irait l'importer ailleurs.

### Ce qui est commun aux deux (partagé, transversal)
- Le moteur de transcription (faster-whisper hébergé, même moteur que le skill `srt-auto`).
- La table "Lyrics Timing" (cache par single, §3) — si l'audio uploadé correspond à un single déjà transcrit, réutilisation immédiate sans repasser par la transcription, même en Option 1.

Ça répond aussi à la question laissée en suspens sur l'ancien onglet "Sous-titres SRT" (comparer API cloud vs faster-whisper) : plus besoin de choisir, on héberge faster-whisper nous-mêmes, en interne, accessible à toute l'entreprise.

## 1. Architecture retenue

Backend "fait maison" (Python/ffmpeg), hébergé sur Render — pas sur le poste de Michel, accessible en HTTPS par toute l'entreprise via le frontend Netlify.

- **Backend hébergé** (pas Make + API tierce). Le hub appelle ce backend en HTTPS pour : upload, statut de job, téléchargement du résultat.
- **Hébergement** : Render — déploiement Git (voir racine du repo), stockage temporaire des fichiers.
- **UX** : même logique que l'onglet TikTok actuel — barre de progression qui suit le job en direct.

## 2. Pipeline Option 2 (vidéo sous-titrée rendue)

1. Upload vidéo → stocké temporairement côté backend.
2. Recherche du single (autocomplete) dans la BDD transversale des singles déjà alimentée par l'onglet TikTok (`single_cle`, `single`, `artiste`).
3. Réglages de style (§4) : police, taille, couleur, mode d'apparition — soit choisis un par un, soit via un préréglage rapide (menu déroulant avec preview GIF 3-4s, construit à partir des styles maison identifiés en §4bis).
4. Le backend vérifie si des paroles timées existent déjà pour ce `single_cle`, à la granularité requise par le mode choisi (mot par mot vs ligne/phrase) :
   - **Oui** → réutilisation directe, aucune retranscription.
   - **Non** → transcription (faster-whisper hébergé), de préférence sur l'audio maître Flowstage si disponible, sinon sur la vidéo elle-même. Résultat stocké (§3) pour ne plus jamais retranscrire ce single.
5. Construction des "cues" (texte + timing par cue) selon le mode d'apparition choisi (§4bis — la logique diffère structurellement entre les 3 modes).
6. Génération du fichier **.ass** correspondant.
7. Rendu ffmpeg : incrustation (burn-in) du .ass sur la vidéo source.
8. Sortie : vidéo finale téléchargeable + option (à activer plus tard) de dépôt direct dans le dossier OneDrive `TIKTOK EDITS`.

**Pipeline Option 1** : étape 4 (recherche single facultative + transcription si besoin) → génération .srt directement à partir des mots/lignes timés, pas d'étape 5-8.

## 3. BDD à étendre (transversal)

Nouvelle table "Lyrics Timing" (Postgres Render), clé = `single_cle` :

| Champ | Type | Contenu |
|---|---|---|
| single_cle | Text | même code 4 chiffres que Captions BDD |
| single / artiste | Text | idem |
| granularite | Text | "mot" ou "phrase" |
| timing_json | Text (multiline) | `[{text, start, end}, ...]` |
| source_audio | Text | "flowstage_master" ou "audio/video_uploade" |
| date_generation | Date | audit |

Une ligne par (single, granularité) — générée à la demande la première fois, réutilisée ensuite par les deux options.

## 4. Système de styles — contrôles précis + préréglages

Décision : pas seulement une bibliothèque de styles figés. L'utilisateur peut régler précisément, indépendamment les uns des autres :

- **Police** — 15 polices installées côté backend (Docker : téléchargées + `fc-cache` au build), réparties en 5 familles : sans-serif (Poppins, Montserrat, Space Grotesk, Inter), serif (Playfair Display), condensé (Bebas Neue, Anton, Oswald, Roboto Condensed), display/impact (Archivo Black, Bangers, Righteous, Luckiest Guy), manuscrite (Caveat, Permanent Marker). Voir `FONT_META` dans `backend/main.py`.
- **Taille de la police** (en % de la hauteur vidéo — s'adapte à tous les formats), avec **auto-fit anti-débordement** : la taille effective est recalculée par cue si le mot/la ligne la plus longue dépasserait le cadre, sans changer la taille globale demandée pour le reste (`_fit_font_size`).
- **Couleur du texte**, **casse** (MAJUSCULES ou normale — utile pour les polices manuscrites).
- **Position à l'écran** (bas / centre / haut).
- **Fond derrière le texte** : contour seul, plaque colorée (BorderStyle=3), ou texte nu — avec couleur et épaisseur de contour réglables.
- **Effet d'apparition** : aucun, fondu, pop (petit zoom), glissade — via tags ASS (`\fad`, `\t` sur `\fscx/\fscy`, `\move`).
- **Mode d'apparition / mise en page** — 6 modes :
  1. **Mot remplace l'autre** — un mot à la fois, big, centré.
  2. **Construction horizontale** — les mots s'ajoutent dans la ligne, wrap sur 2 lignes max, reset tous les 3 mots.
  3. **Construction verticale** — chaque mot sur sa propre ligne, empilé verticalement, reset tous les 3 mots.
  4. **Pile qui défile** ("l'une au-dessus de l'autre") — fenêtre glissante des 3 dernières mini-lignes (2 mots chacune), la plus récente en bas.
  5. **Phrase entière** — sous-titrage classique, un segment = un cue statique.
  6. **Karaoké** — la ligne complète reste affichée, le mot en cours de lecture est surligné dans une couleur d'accent dédiée.

Un style = un objet {police, taille, couleur, casse, position, fond, contour, effet, mode, couleur d'accent} — indépendant du code, envoyé tel quel au backend (`POST /jobs`), sert à la fois à écrire le `.ass` (Option 2 uniquement, voir §0bis) et à construire les préréglages du menu déroulant (5 préréglages actuellement, `PRESETS` dans `js/subtitles.js`).

### 4bis. Vérification sur le catalogue existant

Les 3 modes ci-dessus ne sont pas théoriques — les 2 premiers sont déjà utilisés tels quels dans le catalogue Duchess (confirmé en comparant des séquences de frames rapprochées, pas juste des captures isolées) :

| Mode | Vidéos où c'est confirmé | Police observée | Remplissage |
|---|---|---|---|
| 1 — mot remplace l'autre | TOLVY BANG "Bullet" (Electro, x2 vidéos) | serif fine et haute | texture vidéo (le mot est rempli par l'image en mouvement en dessous, pas une couleur plate) |
| 2 — build cumulatif par ligne | Toi & Moi (Urbain), TOLVY EMILY (Electro) | sans-serif très grasse, arrondie | texture vidéo également |
| 3 — phrase entière | pas encore vu dans le catalogue existant — mode standard, pas besoin d'exemple pour le définir |

## 5. État d'avancement

### Fait — en production

- Backend FastAPI + faster-whisper + ffmpeg déployé sur Render (Docker Web Service), `https://duchess-hub.onrender.com`, plan Pro. Frontend sur Render Static Site, `https://duchess-hub-front.onrender.com`.
- Les deux options fonctionnent en bout en bout (testées en direct) : Option 1 (fichier → `.srt`) et Option 2 (vidéo → vidéo incrustée, `.ass` + burn-in ffmpeg).
- Système de styles v2 complet (§4) : 15 polices, taille avec auto-fit anti-débordement, couleur, casse, position, fond (contour/plaque/aucun), effet d'apparition, 6 modes, couleur d'accent karaoké. 5 préréglages rapides.
- Aperçu texte en direct dans `js/subtitles.js` — reproduit fidèlement la logique du backend (mêmes découpages par mode, même heuristique d'auto-fit, même surlignage karaoké), avec animation CSS pour les effets d'apparition.
- Cache "Lyrics Timing" (SQLite) : réutilise les paroles déjà timées pour un single déjà traité ailleurs sur le hub.
- Champs single (artiste/titre) branchés sur la synchronisation existante du hub (`js/shared.js`).

### Reste à faire

1. Clé API Flowstage branchée côté backend (pour aller chercher l'audio maître au lieu de transcrire l'upload).
2. Stockage persistant pour le cache "Lyrics Timing" — SQLite actuel n'est pas persistant entre redéploiements sur le plan Render en cours (disque non persistant) : Postgres Render ou disque persistant à évaluer si le volume le justifie.
3. ~~Vérifier si 2 workers uvicorn chargent le modèle whisper deux fois~~ — fait : `--workers 1` forcé explicitement dans le `CMD` du Dockerfile pour éliminer le doute.
4. Test end-to-end sur plusieurs singles réels avec les nouveaux modes/effets (fait en local via rendu ffmpeg synthétique — reste à valider sur de la vraie vidéo/voix).
5. **OOM confirmé sur fichier réel** (Render : "Ran out of memory (used over 4Go)") pendant le burn-in ffmpeg d'une vidéo longue/lourde. Deux garde-fous ajoutés dans `process_job()` : downscale de sécurité si la source dépasse 1920px sur son plus grand côté (les exports téléphone dépassent souvent 1080p, inutile pour du rendu social et ça fait grimper la RAM), et refus explicite (message clair) au-delà de 10 min de vidéo au lieu d'un crash silencieux. `-preset veryfast -threads 2` ajoutés à l'encodage pour brider la RAM du burn-in. Confirmé réglé sur un test réel (55s, 40 Mo, 1080×1920).
6. **Stockage résultats persistant : fait.** Les `.srt`/`.mp4` générés sont uploadés vers un bucket Cloudflare R2 (`duchess-hub-subtitles`, gratuit jusqu'à 10 Go) via `boto3` (`upload_to_r2()` dans `main.py`), et `download_url` pointe vers une URL présignée valable 7 jours — ne disparaît plus au redéploiement suivant. Variables d'env Render : `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`. Sans ces 4 variables, le backend se rabat automatiquement sur le stockage local `/files/...` (comportement d'avant, non persistant). Testé et confirmé en direct (SRT + MP4, upload + téléchargement réels).
7. **Bug frontend corrigé** : `js/subtitles.js` comparait les booléens de progression (`step_lyrics`, `step_ass`, etc.) avec `=== true`, alors que SQLite les renvoie en entiers (0/1) — la comparaison stricte ne matchait jamais, donc la barre de progression restait bloquée à 0% et le bloc résultat ne s'affichait jamais, même quand le job avait réellement fini. Remplacé par une comparaison "truthy" (`!!data[s.key]`). Un deuxième bug corrigé au passage : un nouveau sondage (`pollStatus`) ne coupait pas un sondage précédent encore actif, ce qui pouvait mélanger l'affichage de deux jobs différents en cas de double soumission.

## 6. Points encore ouverts

- Formats vidéo à supporter en entrée (9:16 uniquement, ou aussi 16:9 / 1:1) — impacte le calcul de taille de police en %.
- Limite de poids/durée d'upload (contrainte du plan Render en cours).
- Karaoké et pile qui défile groupent les mots par paquets fixes (5 mots / 2 mots) plutôt que par vraie coupure de phrase — pourrait être affiné avec la ponctuation détectée par whisper.
