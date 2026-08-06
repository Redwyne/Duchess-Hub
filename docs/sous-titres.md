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

1. ~~Clé API Flowstage branchée côté backend~~ — **fait.** `get_or_transcribe()` essaie maintenant, dans l'ordre : cache local → Flowstage (si `FLOWSTAGE_API_KEY` renseignée) → faster-whisper. Le matching aesthetic ↔ single se fait par comparaison floue (`find_flowstage_aesthetic()` : accents/casse/ponctuation ignorés, code numérique en tête du nom ignoré, ex. "0006 Toi & Moi", seuil de similarité + détection de sous-chaîne) — plus besoin de taper l'intitulé exact comme c'était le cas côté Make. Flowstage ne donne le timing qu'au niveau ligne (`GET /v1/aesthetics/{id}/audios`) : le texte des lignes est repris tel quel (garanti juste, zéro erreur de transcription), et le timing mot par mot est interpolé au prorata du nombre de caractères de chaque mot (`_interpolate_words()`) — précision du timing légèrement approximative sur le mot par mot, mais texte toujours exact. Testé en direct avec la vraie clé et l'aesthetic "Toi & Moi" (43 lignes / 284 mots récupérés, matching flou validé sur plusieurs variantes du titre, faux positifs écartés).
   - **Bug corrigé après premier retour terrain de Michel** ("sous-titres pas du tout dans les temps et beaucoup manquent") : certaines entrées "audios" Flowstage ne sont pas le morceau entier mais un CLIP découpé (ex. nom `"...-clip-51s-84s"`, 33s au lieu des 148s du morceau), avec des timestamps de lignes relatifs au DÉBUT DU CLIP — appliqués tels quels à une vidéo qui couvre une autre portion du morceau, ça décale tout et laisse le reste sans aucune ligne. Repéré en creusant l'API réelle (aesthetic "S'aimer" : audio "clip-51s-84s" vs morceau de 147s). Fix (`get_flowstage_words()`) : on compare maintenant la durée de l'audio Flowstage à la durée réelle de l'audio uploadé (`_probe_audio_duration()`, ffprobe) — écart au-delà de 3s (ou 3% de la durée, le plus grand des deux) → on rejette Flowstage pour ce job et `get_or_transcribe()` retombe sur whisper au lieu de servir un timing garanti faux. Testé en direct : accepté quand la durée colle (147.6s ↔ 148s mesurés), rejeté proprement quand elle ne colle pas (32.88s vs 90s/180s), ré-accepté sur le même clip quand l'upload correspond vraiment au clip (32.9s).
   - **`FLOWSTAGE_API_KEY` : confirmé en place sur Render et service redéployé** (Michel, 2026-08-06).
   - **Bug apostrophe (round 2)** : le premier fix ne fusionnait que dans un sens ("c'" + "est"). Un vrai test sur "Toi & Moi" a montré que whisper "small" scinde en fait le plus souvent dans l'AUTRE sens ("c" puis "'est", "s" puis "'aime") — fragments jamais fusionnés, visibles tels quels dans "Vérifier les paroles". `_merge_apostrophe_words()` fusionne maintenant dans les deux sens (fragment précédent finissant par `'`/`’`/`-`, OU fragment suivant commençant par l'un de ces caractères) — couvre aussi les mots composés coupés comme "rendez" + "-vous". Testé avec les tokens exacts du screenshot de Michel (43 fragments → plus aucun fragment isolé, "c'est"/"s'aime"×3/"s'en"/"rendez-vous" tous reconstruits).
   - **Modèle whisper relevé à `medium`** (était `small`) : Michel a confirmé Flowstage actif, donc les erreurs visibles venaient bien du repli whisper pour un single/segment non couvert par le catalogue — "small" produit trop d'homophones ratés ("il s'aime" au lieu de "ils s'aiment"). `medium` en int8 (~1.5 Go) reste large sur le plan Pro Render (4 Go).
   - **Correction grammaticale via Claude : ajoutée, toujours active si `ANTHROPIC_API_KEY` est configurée** (confirmé en place par Michel). `correct_lyrics_with_claude()` envoie toutes les lignes whisper (regroupées via `_words_to_phrases()`) en un seul appel avec le contexte artiste/titre, et renvoie EXACTEMENT le même nombre de lignes sinon la correction est ignorée silencieusement (jamais bloquant). Pour la granularité "mot", le timing est ré-interpolé à partir des lignes corrigées via `_interpolate_words()` (même mécanique que pour les lignes Flowstage). S'applique UNIQUEMENT au repli whisper — jamais aux paroles Flowstage (déjà vérifiées humainement) ni aux corrections manuelles de Michel dans "Vérifier les paroles".
   - **Round 2 (nouveau retour terrain avec comparaison paroles réelles vs sortie)** : les fusions d'apostrophe étaient bien visibles et correctes ("s'aime", "c'est", "rendez-vous" tous fusionnés), mais le fond restait faux — "il s'aime" au lieu de "ils s'aiment" persistait malgré la correction Claude censée l'attraper. Deux changements :
     - **`CLAUDE_LYRICS_MODEL` passé de Haiku à `claude-sonnet-5`** : repérer un accord singulier/pluriel fautif à partir du sens et de la cohérence d'un refrain répété demande un vrai raisonnement contextuel — le volume de texte par appel (les paroles d'un extrait) est trop faible pour que le coût Sonnet vs Haiku soit significatif.
     - **Prompt durci** : consigne explicite de prioriser les erreurs d'ACCORD GRAMMATICAL (singulier/pluriel, sujet-verbe — "presque toujours involontaires dans un texte écrit") et de s'appuyer sur les refrains répétés dans l'extrait pour trancher par cohérence, tout en gardant la distinction stricte avec les choix de VOCABULAIRE/registre familier (ceux-là, on ne les touche pas).
   - **Diagnostic ajouté : `lyrics_source`** — nouvelle colonne sur `jobs` (idempotent comme `words_json`), renseignée par `process_job()` à chaque étape (`flowstage` / `audio_uploade` / `audio_uploade_corrige_claude` / `verifie_manuellement`, ou la source d'origine si servi depuis le cache — `get_or_transcribe()` renvoie maintenant un tuple `(words, source)`). Exposée dans la réponse `GET /jobs/{job_id}` et affichée directement dans le bandeau "Vérifier les paroles" du frontend (`LYRICS_SOURCE_LABELS` dans `js/subtitles.js`) — permet de savoir d'un coup d'œil par quel chemin les paroles affichées sont passées, sans deviner. Testé en local (cache-hit renvoie bien la source d'origine, pas un "cache" générique).
   - Testé en local avec un client Anthropic simulé : correction propre, repli sur désaccord de nombre de lignes, bout-en-bout mot→ligne→correction→ré-interpolation mot, et le tuple `(words, source)` sur tous les chemins (cache/Flowstage/whisper/edited_words).
   - **Round 3 (test en direct avec la vraie clé Anthropic) — 3 bugs trouvés et corrigés :**
     - **`fs_...` collée par erreur à la place de la clé Anthropic** : Michel avait donné sa clé Flowstage (`fs_...`) en la nommant "clé anthropic" — repéré immédiatement (une vraie clé Anthropic commence par `sk-ant-`), donc `ANTHROPIC_API_KEY` était en fait invalide côté test (et probablement aussi sur Render au moment du screenshot montrant encore `audio_uploade` au lieu de `audio_uploade_corrige_claude`). Michel a fourni la vraie clé (`sk-ant-api03-...`) ensuite.
     - **Bug bloquant "extended thinking"** : `claude-sonnet-5` réfléchit par défaut avant de répondre (bloc `thinking` séparé du bloc `text`, décompté du même budget `max_tokens`). Avec `max_tokens=2000`, la réflexion consommait TOUT le budget avant d'écrire une seule ligne de réponse (`stop_reason="max_tokens"`, `resp.content[0]` = bloc thinking sans texte) → crash (`'NoneType' object has no attribute 'strip'`), donc la correction échouait silencieusement à chaque appel, même avec la bonne clé. Fix : `thinking={"type": "disabled"}` passé explicitement à `messages.create()`, extraction du texte robuste (recherche du bloc `type == "text"` au lieu de supposer `content[0]`). A nécessité de monter le SDK `anthropic` de `0.40.0` (ne supportait même pas le paramètre `thinking`) à `0.120.2` (`requirements.txt` mis à jour). Vérifié en A/B en direct : qualité identique avec/sans réflexion étendue, mais ~15x moins de tokens sans (202 contre ~2987) et beaucoup plus rapide.
     - **Ligne unique = Claude refuse et pose une question** : sur un extrait d'une seule ligne (`"il s'aime pas comme toi et moi"`), Claude ne renvoyait pas de correction mais un texte demandant "le reste de la transcription" pour pouvoir juger — nombre de lignes en sortie forcément différent de 1, donc rejeté par le garde-fou et correction perdue. Fix : prompt explicite ("l'extrait peut être une seule ligne isolée, c'est normal, ne demande jamais de contexte, ne pose jamais de question, renvoie toujours exactement une ligne corrigée") + `system` prompt dédié qui cadre `correct_lyrics_with_claude()` comme un outil de transformation de texte strict, jamais conversationnel.
   - **Validé en direct avec la vraie clé et `claude-sonnet-5`**, sur une reconstruction fidèle de l'extrait réel de Michel (9 lignes, refrain "il s'aime pas comme toi et moi" ×2 + "il s'en regarde pas" une fois) : les 3 occurrences corrigées correctement en "Ils s'aiment pas.../Ils se regardent pas..." (accord sujet-verbe capté via la cohérence du refrain), plus corrections bonus (accents, majuscules de début de ligne). Testé aussi 3 fois de suite sur le cas ligne unique (répétable, plus de non-déterminisme observé) et sur le chemin mot-par-mot complet (`_apply_claude_correction` avec granularité "mot" → ré-interpolation du timing) : "il"/"s'aime" → "ils"/"s'aiment" avec un timing cohérent. `lyrics_source` doit maintenant afficher `audio_uploade_corrige_claude` sur les prochains tests réels une fois redéployé.
2. Stockage persistant pour le cache "Lyrics Timing" — SQLite actuel n'est pas persistant entre redéploiements sur le plan Render en cours (disque non persistant) : Postgres Render ou disque persistant à évaluer si le volume le justifie.
3. ~~Vérifier si 2 workers uvicorn chargent le modèle whisper deux fois~~ — fait : `--workers 1` forcé explicitement dans le `CMD` du Dockerfile pour éliminer le doute.
4. Test end-to-end sur plusieurs singles réels avec les nouveaux modes/effets (fait en local via rendu ffmpeg synthétique — reste à valider sur de la vraie vidéo/voix).
4bis. **Aperçu vidéo live pendant le choix de style : fait.** Dès qu'un fichier vidéo est choisi (option "Vidéo sous-titrée"), il est lu localement dans le téléphone d'aperçu (`URL.createObjectURL`, aucun upload nécessaire pour ça) et un job léger `option="preview"` (transcription seule, pas de rendu ffmpeg, voir `words_json` dans `process_job()`) récupère le vrai timing des paroles (Flowstage si reconnu, sinon whisper) en tâche de fond. Une fois reçu, les sous-titres affichés par-dessus la vidéo sont resynchronisés en direct sur `video.currentTime` (boucle `requestAnimationFrame`, `js/subtitles.js`) au lieu de l'ancienne démo qui cyclait sur des mots factices — la démo texte reste affichée le temps que l'analyse se termine. Redéclenché automatiquement si l'artiste/titre change après coup (peut débloquer un matching Flowstage).
4ter. **Section "Vérifier les paroles" : fait**, puis peaufinée sur plusieurs retours de Michel. État actuel :
    - Placée juste sous l'upload (avant les options de style), visible dès qu'un fichier est choisi quelle que soit l'option.
    - Barre de chargement (réutilise `.progress-fill.indeterminate`) pendant l'analyse ; le texte d'invite du dropzone ("glisse ton fichier ici...") disparaît une fois un fichier choisi (classe `.has-file`), ne reste que le nom du fichier.
    - Mots affichés regroupés par ligne/phrase (retour à la ligne détecté par un silence entre deux mots — voir seuil ci-dessous), avec un léger fond coloré par ligne façon éditeur "Word timeline" Flowstage.
    - **Un seul clic** sur un mot l'ouvre en édition (texte présélectionné) ; **Suppr/Retour arrière** tant que rien n'a été retapé supprime le mot entier ; **glisser-déposer** un mot sur un autre échange leur texte sans toucher au timing (corrige un ordre mal transcrit) ; bouton **"+ Ajouter un mot"** (un par ligne + un global) insère un nouveau mot avec un timing interpolé dans le silence disponible, et ouvre directement son édition.
    - Remplacement en masse **et suppression en masse** : le champ "Remplacer par" vide + clic sur "Supprimer partout" retire toutes les occurrences d'un mot d'un coup (le libellé du bouton s'ajuste automatiquement).
    - **Curseur vertical** qui balaie le mot en cours de lecture au rythme réel de la musique (interpolé entre `start`/`end` du mot actif, positionné via `chip.offsetLeft/offsetWidth` relatif à `.verify-words`, qui est le containing block positionné).
    - Réutilise le job "preview" déjà lancé pour l'aperçu vidéo live (§4bis) — pas de second aller-retour serveur. Toute correction est immédiatement répercutée sur l'aperçu vidéo (mêmes `realWords`/`realCues`) et envoyée au job final via le champ `edited_words` (JSON) sur `POST /jobs` — `process_job()` utilise alors ces mots tels quels (cache sous la source `"verifie_manuellement"`) au lieu de retranscrire ; si le mode/l'export demandé est au niveau ligne (mode "Phrase entière" ou export `.srt`), les mots corrigés sont regroupés en phrases via `_words_to_phrases()`.
    - **Seuil de retour à la ligne : 0.4s** (silence entre deux mots), aligné entre le frontend (`VERIFY_LINE_GAP`) et le backend (`_words_to_phrases`) — abaissé depuis 0.6s à la demande de Michel pour des retours à la ligne plus fréquents/naturels.
    - **Règle permanente : l'apostrophe n'est jamais un séparateur de mot.** faster-whisper peut renvoyer des contractions françaises ("c'est", "s'aiment"...) comme deux tokens distincts ("c'" + "est") avec chacun leur timing — `_merge_apostrophe_words()` les refusionne systématiquement (whisper ET Flowstage) avant la mise en cache dans `get_or_transcribe()`, donc tout ce qui suit (aperçu live, édition manuelle, rendu final) en profite automatiquement.
    - Testé en local : reconstruction de phrases par silence, bout-en-bout `create_job`→`process_job` avec `edited_words` (le `.ass` généré contient bien le texte corrigé), fusion des mots à apostrophe, calcul de timing d'insertion de mot.
5. **OOM confirmé sur fichier réel** (Render : "Ran out of memory (used over 4Go)") pendant le burn-in ffmpeg d'une vidéo longue/lourde. Deux garde-fous ajoutés dans `process_job()` : downscale de sécurité si la source dépasse 1920px sur son plus grand côté (les exports téléphone dépassent souvent 1080p, inutile pour du rendu social et ça fait grimper la RAM), et refus explicite (message clair) au-delà de 10 min de vidéo au lieu d'un crash silencieux. `-preset veryfast -threads 2` ajoutés à l'encodage pour brider la RAM du burn-in. Confirmé réglé sur un test réel (55s, 40 Mo, 1080×1920).
6. **Stockage résultats persistant : fait.** Les `.srt`/`.mp4` générés sont uploadés vers un bucket Cloudflare R2 (`duchess-hub-subtitles`, gratuit jusqu'à 10 Go) via `boto3` (`upload_to_r2()` dans `main.py`), et `download_url` pointe vers une URL présignée valable 7 jours — ne disparaît plus au redéploiement suivant. Variables d'env Render : `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`. Sans ces 4 variables, le backend se rabat automatiquement sur le stockage local `/files/...` (comportement d'avant, non persistant). Testé et confirmé en direct (SRT + MP4, upload + téléchargement réels).
7. **Bug frontend corrigé** : `js/subtitles.js` comparait les booléens de progression (`step_lyrics`, `step_ass`, etc.) avec `=== true`, alors que SQLite les renvoie en entiers (0/1) — la comparaison stricte ne matchait jamais, donc la barre de progression restait bloquée à 0% et le bloc résultat ne s'affichait jamais, même quand le job avait réellement fini. Remplacé par une comparaison "truthy" (`!!data[s.key]`). Un deuxième bug corrigé au passage : un nouveau sondage (`pollStatus`) ne coupait pas un sondage précédent encore actif, ce qui pouvait mélanger l'affichage de deux jobs différents en cas de double soumission.

## 6. Points encore ouverts

- Formats vidéo à supporter en entrée (9:16 uniquement, ou aussi 16:9 / 1:1) — impacte le calcul de taille de police en %.
- Limite de poids/durée d'upload (contrainte du plan Render en cours).
- Karaoké et pile qui défile groupent les mots par paquets fixes (5 mots / 2 mots) plutôt que par vraie coupure de phrase — pourrait être affiné avec la ponctuation détectée par whisper.
