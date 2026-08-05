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

Décision : pas seulement une bibliothèque de styles figés. L'utilisateur doit pouvoir régler précisément, indépendamment les uns des autres :

- **Police** (sélecteur de typo)
- **Taille de la police** (en % de la hauteur vidéo — s'adapte à tous les formats)
- **Couleur de la police**
- **Mode d'apparition / mise en page** — 3 modes de base pour cette v1 :
  1. **Mot unique remplace l'autre, big, centré** — un mot (ou très court groupe) affiché à la fois, chaque nouveau mot remplace entièrement le précédent.
  2. **Phrase qui se construit mot après mot** — les mots s'ajoutent un par un dans la ligne ("IL" → "IL REMET" → "IL REMET RENDEZ-VOUS"), retour à la ligne automatique, puis la ligne se vide et la suivante démarre. Logique déjà codée dans le skill `srt-linebuild` (export "Line build preview") — réutilisable telle quelle pour ce mode.
  3. **Phrase entière affichée d'un coup** — sous-titrage classique, une ligne/phrase = un seul cue statique du début à la fin de la ligne.

"Plus tard, plus précis" (noté pour itération future, pas construit dans cette v1) : position (bas/centre/haut), contour/ombre, transitions d'apparition (fade/pop/slide), nombre de mots groupés en mode 1, highlight du mot actif façon karaoké en mode 3.

Un style = un objet JSON {police, taille, couleur, mode} — indépendant du code, stocké et réutilisable, sert à la fois à écrire le .ass (Option 2 uniquement, voir §0bis) et à construire les préréglages du menu déroulant.

### 4bis. Vérification sur le catalogue existant

Les 3 modes ci-dessus ne sont pas théoriques — les 2 premiers sont déjà utilisés tels quels dans le catalogue Duchess (confirmé en comparant des séquences de frames rapprochées, pas juste des captures isolées) :

| Mode | Vidéos où c'est confirmé | Police observée | Remplissage |
|---|---|---|---|
| 1 — mot remplace l'autre | TOLVY BANG "Bullet" (Electro, x2 vidéos) | serif fine et haute | texture vidéo (le mot est rempli par l'image en mouvement en dessous, pas une couleur plate) |
| 2 — build cumulatif par ligne | Toi & Moi (Urbain), TOLVY EMILY (Electro) | sans-serif très grasse, arrondie | texture vidéo également |
| 3 — phrase entière | pas encore vu dans le catalogue existant — mode standard, pas besoin d'exemple pour le définir |

## 5. État d'avancement

### Fait

L'onglet "Sous-titres" est construit dans `index.html` / `css/style.css` / `js/subtitles.js` :

- Bascule Option 1 (fichier) / Option 2 (vidéo) avec dropzone drag & drop.
- Champs single (artiste/titre) branchés sur la synchronisation existante du hub (`js/shared.js`).
- Réglages police / taille / couleur / mode d'apparition (3 modes), avec préréglages rapides basés sur les styles repérés dans le catalogue.
- Aperçu texte en direct (proxy en attendant le vrai moteur de rendu — anime les 3 modes sur un exemple réel des paroles de "Toi & Moi").
- Scaffold d'envoi + polling de statut, identique au pattern déjà utilisé sur les onglets Pitch/TikTok.

Rien de tout ça n'est encore branché à un vrai backend — le bouton Go affiche un message clair ("backend pas encore branché") tant que `BACKEND_BASE_URL` dans `js/subtitles.js` n'est pas renseignée avec l'URL Render réelle.

### Reste à faire

1. Backend Render (upload, transcription faster-whisper, génération ASS/SRT, burn-in ffmpeg, statut de job) — voir `docs/backend-render.md` une fois créé.
2. Clé API Flowstage branchée côté backend.
3. Table "Lyrics Timing" (Postgres Render) + logique de cache par single.
4. Remplacement de `BACKEND_BASE_URL` dans `js/subtitles.js` par l'URL Render réelle.
5. Test end-to-end sur 2-3 singles réels.

### Render : quel plan

Le Starter (7 $/mois, 512 Mo RAM / 0,5 CPU) est correct pour démarrer mais trop juste pour le modèle faster-whisper large-v3 utilisé en local (~2-3 Go nécessaires). Départ recommandé : Starter + modèle whisper allégé, upgrade vers Standard (25 $/mois, 2 Go RAM) seulement si la qualité/vitesse testée sur un vrai single ne suffit pas.

## 6. Points encore ouverts

- Formats vidéo à supporter en entrée (9:16 uniquement, ou aussi 16:9 / 1:1) — impacte le calcul de taille de police en %.
- Limite de poids/durée d'upload (contrainte d'hébergement du backend).
- Nom d'affichage définitif de l'onglet fusionné sur le hub ("Sous-titres" tout court ?).
