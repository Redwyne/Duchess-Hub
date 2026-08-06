# Duchess Hub — contexte pour créer un nouvel onglet/fonctionnalité

Ce document résume tout ce qu'il faut savoir pour reprendre le travail sur Duchess Hub dans une nouvelle conversation, sans avoir à tout redécouvrir. Écrit après le build complet de l'onglet **Admin > Budgets Projets** (référence directe la plus récente et la plus aboutie — s'en inspirer en priorité pour toute nouvelle fonctionnalité).

## 1. C'est quoi, pour qui

Site interne du label **Duchess Production** (Michel Kamel, Caen) / label urbain **ARK**. Une seule page à onglets, outils métier : Pitch, TikTok, Stats, Sous-titres, Stratégie, et un espace **Admin** protégé par mot de passe (Inventaire matériel + Budgets Projets artistes).

Consigne permanente du fondateur (Michel) : *"tout ce que tu peux faire solo, tu le fais"* — sur ce projet, aller jusqu'au bout (Make.com inclus, pas juste le code) sans attendre une validation à chaque étape, et rester **transversal** : toute info/variable/fichier généré sur un onglet doit pouvoir être réutilisé par les autres plutôt que ressaisi.

Artistes du label (utile si la feature est liée à un artiste) : Lennon, Bende, TW, Naumaur, Julien Andriana, Clément Herfort, Billie, WarEnd, Romain Mialdea, DAYSY.

## 2. Emplacements

- **Dossier de travail (repo réel)** : `/Users/michelkamel/Desktop/JARVIS 1.0/Projets/Duchess Hub` — c'est le dossier connecté (workspace). Toujours éditer directement ici avec Read/Edit/Write.
- **Vu depuis `mcp__workspace__bash`** (sandbox Linux) : le même dossier est monté à `/sessions/<session-id>/mnt/Duchess Hub/`. Les chemins ne sont PAS les mêmes entre les outils fichiers (Read/Edit/Write, chemin macOS) et le shell (chemin sandbox) — toujours faire le mapping, et `cp` les fichiers édités vers le dossier `outputs/` du sandbox avant de les servir/tester en local.
- **Important** : le dossier workspace monté interdit de **supprimer ou renommer** un fichier une fois écrit (restriction système). Ça casse par exemple SQLite (le mode journal a besoin de renommer/supprimer le fichier `-journal`). Ne jamais lancer un serveur avec état (DB locale, etc.) directement contre ce dossier monté — soit copier ailleurs (`outputs/`) avant, soit (mieux, voir §7) éviter complètement d'avoir besoin d'un backend local pour tester.

## 3. Architecture générale

```
index.html          shell + tous les onglets (topbar .tab-btn[data-tab-target=...] + panels .tab-panel)
css/style.css        thème général (couleur d'accent selon onglet via body[data-tab])
css/calendar.css     calendrier TikTok/Publer
css/admin.css        tout le CSS de la zone Admin (Inventaire + Budgets) — variables/tokens ici
js/tabs.js           bascule entre onglets top-niveau
js/shared.js         synchro des champs mutualisés entre onglets (localStorage)
js/pitch.js, js/tiktok.js, js/tiktok-calendar.js, js/subtitles.js   un fichier IIFE par onglet
js/admin.js          shell Admin (login, sidebar interne, onglet Inventaire)
js/budget.js         onglet Admin > Budgets Projets (référence à suivre pour une nouvelle feature)
backend/main.py       API FastAPI unique (Sous-titres à l'origine, Admin/Inventaire/Budget greffés dessus)
backend/budget_engine.py   moteur Excel (openpyxl) dédié au Budget — bon modèle si une feature manipule un .xlsx
docs/sous-titres.md   framework technique détaillé de l'onglet Sous-titres
docs/NOUVEL_ONGLET.md ce document
```

- **Frontend** : site statique, aucun build, déployé sur Netlify (`duchess-hub.netlify.app`, drag & drop du dossier) — mais le backend référence aussi `duchess-hub-front.onrender.com` dans ses origines autorisées, vérifier lequel est réellement actif avant de déployer.
- **Backend** : FastAPI sur **Render**, un seul service pour tout (Sous-titres + Admin + Inventaire + Budget). Fichier unique `backend/main.py`, grossit au fur et à mesure — pas de refonte en modules pour l'instant, rester cohérent avec ce qui existe (sections commentées par feature).
- **Automatisations lourdes** : tout passe par des **scénarios Make.com** (jamais de logique métier lourde côté frontend, jamais d'appel direct du frontend vers un webhook Make — toujours via le backend, qui garde les URLs Make secrètes en variables d'env Render).

## 4. Make.com — accès direct

Compte : **team 1807512**, **organisation 7829049**. Le Make MCP (outils `mcp__78a9799f-1d79-446c-a187-03310fe8fd90__*`, à charger via `ToolSearch` — ils sont nombreux, faire une recherche par mot-clé type `scenarios`, `hooks`, `data-structures`) donne un accès **complet et direct** au compte : créer/modifier/activer des scénarios, webhooks, connexions, data structures, tout sans passer par l'UI Make.

Pattern qui marche bien :
1. `scenarios_list({teamId: 1807512})` pour voir l'existant et éviter les doublons.
2. Construire un scénario par opération (LIST / DOWNLOAD / UPLOAD / ADD / UPDATE / DELETE / RENAME selon le besoin), déclenché par un `CustomWebHook` (package `gateway`), terminé par un `WebhookRespond`.
3. **Récupérer l'URL réelle du webhook sans passer par le backend/Render** : `hooks_get({hookId})` (le `hookId` est dans la sortie de `scenarios_list`) renvoie `url` (`https://hook.eu1.make.com/...`). Ça permet de tester en conditions réelles (curl direct) sans avoir besoin des identifiants admin du site ni des variables d'env Render — très utile en dev.
4. Une fois validé, référencer cette URL côté backend via une variable d'env Render (jamais en dur dans le code, jamais exposée au frontend).

## 5. Deux patterns pour manipuler des fichiers Excel/SharePoint

Le label stocke ses données métier dans des fichiers Excel sur **SharePoint** (site `duchesscompagy_group`), pas de vraie base de données.

- **Pattern Inventaire (ancien, à éviter pour du neuf)** : appels API Excel ligne par ligne via le module générique `microsoft-excel:makeApiCall` (passthrough brut Graph API). Fonctionne mais fragile, a causé des corruptions de fichier.
- **Pattern Budget (recommandé, à réutiliser)** : "télécharger le fichier entier → l'éditer en Python avec `openpyxl` → ré-uploader le fichier entier". Utilise les modules **dédiés** `onedrive` de Make (`downloadAFile`, `uploadAFile`, `searchFilesFolders`, `renameAFileFolder`, `deleteAFileFolder`) plutôt que l'API brute — connexion Make `7767472`. Beaucoup plus fiable. Binaire en entrée/sortie de webhook :
  - Téléchargement : `gateway:WebhookRespond` peut renvoyer du binaire brut directement (`body` = buffer), pas besoin de base64.
  - Upload : nécessite du `multipart/form-data` **et** une "Data Structure" Make explicite attachée au hook (`udt`), avec un champ collection `{name, mime, data:buffer}`.
- **Piège SharePoint connu** : lister un dossier vide via `searchFilesFolders` + `BasicAggregator` renvoie `[{"id":null,"name":null,...}]` (un item rempli de null) plutôt que `[]` — toujours filtrer sur `id != null` côté backend/frontend.

Si la nouvelle feature manipule un .xlsx, s'inspirer très directement de `backend/budget_engine.py` (lecture/écriture d'un arbre de données JSON <-> feuille Excel, recalcul systématique en Python plutôt que de faire confiance aux valeurs de formules mises en cache par Excel, puisque `openpyxl` ne les évalue jamais).

## 6. Backend FastAPI — conventions

- Un seul fichier `backend/main.py`. Ajouter une nouvelle feature = ajouter une nouvelle section (imiter le style des sections Inventaire/Budget déjà présentes : commentaire d'en-tête, constantes `MAKE_<FEATURE>_URLS` lues via `os.environ.get`, petites fonctions helper `_xxx_list/_xxx_download/...` qui appellent Make en `requests.post(...)` et lèvent `HTTPException` proprement, puis les routes `@app.get/post/put/delete` qui utilisent ces helpers).
- **Auth admin** : toutes les routes Admin sont derrière `Depends(require_admin)`. Jeton envoyé par le front en `Authorization: Bearer <token>`, vérifié par `_verify_token` (HMAC, secret = variable d'env `ADMIN_AUTH_SECRET`). Liste d'utilisateurs admin dans la variable d'env `ADMIN_USERS` (JSON). Le front stocke le jeton dans `sessionStorage` sous la clé `duchess-hub-admin-token`.
- **CORS** : `ALLOWED_ORIGINS` liste en dur dans `main.py` — si un nouveau domaine sert le frontend, l'ajouter ici.
- Variables d'env Render déjà utilisées (pour référence / à compléter pour la nouvelle feature) : `DATA_DIR`, `WHISPER_MODEL`, `FLOWSTAGE_API_KEY`, `ANTHROPIC_API_KEY`, `ANTHROPIC_VISION_MODEL`, `R2_ACCOUNT_ID`/`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`/`R2_BUCKET_NAME`, `ADMIN_AUTH_SECRET`, `ADMIN_USERS`, `MAKE_INVENTAIRE_LIST_URL`/`_ADD_URL`/`_UPDATE_URL`/`_DELETE_URL`, `MAKE_BUDGET_LIST_URL`/`_DOWNLOAD_URL`/`_UPLOAD_URL`/`_RENAME_URL`.

## 7. Frontend — conventions

- **Navigation à deux niveaux** : topbar (`.tab-btn[data-tab-target="admin"]` etc., géré par `js/tabs.js`) puis, à l'intérieur de l'onglet Admin, une sidebar interne (`.admin-nav-item`, ex. `#admin-nav-inventaire`/`#admin-nav-budget`) qui bascule entre des "vues" (`#admin-view-inventaire`/`#admin-view-budget`) — regarder `js/admin.js` (fonctions `showInventaireView`/`showBudgetView`) et `index.html` autour de `admin-dashboard` pour le pattern exact avant d'ajouter une 3e vue.
- **Un fichier JS par feature**, IIFE `(function () { "use strict"; ... })();`, avec en tête `const BACKEND_BASE_URL = "https://duchess-hub.onrender.com";` et `const AUTH_KEY = "duchess-hub-admin-token";`.
- **Wrapper fetch** : reprendre le pattern `callBudget`/`callBudgetJSON` de `js/budget.js`. Point d'attention critique (bug déjà rencontré et corrigé) : construire l'objet `headers` fusionné **séparément** puis le spread en dernier dans les options du `fetch` — ne jamais faire `Object.assign({headers:...}, options)` directement, ça écrase silencieusement l'en-tête `Authorization` dès que l'appelant passe son propre `Content-Type`.
- **Composants CSS réutilisables** (`css/admin.css`) : `.admin-btn` (+ `-primary`/`-ghost`/`-sm`/`-icon`/`-danger`), `.admin-modal`/`.admin-overlay` (système de modale générique, voir aussi `.admin-modal-confirm` pour les confirmations de suppression stylées — préférer ce pattern à `window.confirm()`, moins cohérent visuellement), `.admin-sheet-tabs`/`.admin-sheet-tab` (pastilles d'onglets, personnalisables par feature comme dans `budget-project-tabs` qui a un style secondaire distinct du style primaire des artistes), `.admin-toast-container` + fonction `toast(msg, type)` (à dupliquer en haut du nouveau fichier JS, chaque fichier la réimplémente actuellement plutôt que de la partager).
- **Design tokens** (variables CSS, thème sombre/clair via `data-theme` sur `<html>`) : `--accent`, `--accent-2`, `--panel`, `--panel-2`, `--card`, `--border`, `--muted`, `--text`, `--sunken`, `--radius-sm/md/lg`, `--font-head`. Toujours les utiliser plutôt que des couleurs en dur.
- **Champs mutualisés entre onglets** (`js/shared.js`, `localStorage`) : Artiste, Titre, Thème/ambiance sont synchronisés automatiquement entre onglets marqués « Synchronisé ». Si la nouvelle feature a un champ artiste/titre, s'y brancher plutôt que de dupliquer un champ de saisie.

## 8. Méthode de test (sans avoir besoin des vrais identifiants admin)

Le plus rapide et le plus sûr, utilisé pour toutes les itérations UX de Budget :

1. Servir le site statique en local dans le sandbox : `python3 -m http.server 8888` depuis le dossier `Duchess Hub` (chemin sandbox).
2. Playwright (`sync_playwright`), avec **interception de route** : `page.route(PROD_BACKEND + "/**", handler)` où `handler` répond avec du JSON mocké construit à la main (login, listes, arbres de données...) — **pas besoin** de lancer le backend FastAPI local (qui de toute façon casse à cause de la restriction suppression/renommage du dossier monté, voir §2), pas besoin des vrais identifiants admin.
3. Simuler le parcours (login bidon, clics, remplissage de champs), puis vérifier avec `page.eval_on_selector(...)` des assertions précises (position/alignement en pixels via `getBoundingClientRect()`, présence/absence de classes, contenu texte) plutôt que de juste "regarder" — c'est ce qui a permis d'attraper le bug du header `Authorization` avant que Michel ne le voie.
4. Prendre des captures d'écran (`page.screenshot(...)`, ou `page.locator(...).screenshot(...)` pour un composant précis) et les copier vers le dossier `outputs` pour pouvoir les relire avec l'outil Read et les montrer à Michel via `mcp__cowork__present_files`.
5. **Chromium dans ce sandbox** a besoin de `LD_LIBRARY_PATH=/tmp/localdeps/usr/lib/aarch64-linux-gnu` (lib `libXdamage` patchée) pour se lancer.
6. **Piège `mcp__workspace__bash`** : chaque appel est une session isolée, un process lancé en arrière-plan (`cmd &`) dans un appel **ne survit pas** à l'appel suivant — toujours démarrer le serveur HTTP et lancer le test Playwright dans le **même** appel bash. Ne **pas** entourer le `&` d'une sous-shell `(cmd &)` (ça a fait planter/timeout les appels dans cette session) — juste `cmd &` tout court, ça marche.
7. Pour tester avec de **vraies données de production** (pas du mock) sans avoir les identifiants admin : récupérer l'URL du webhook Make directement (§4, point 3) et l'appeler en `curl` — c'est comme ça qu'un projet réel ("EP1 - Souvenirs" pour l'artiste TW) a été ajouté en vrai sur SharePoint dans cette session, en contournant complètement le backend/login.

## 9. Style de collaboration avec Michel

- Répond en français, très concis, direct — pas de blabla, pas de formatage inutile.
- Donne souvent des retours sous forme de **captures d'écran annotées, numérotées** ("image 1 : ... image 2 : ..." etc.) — traiter chaque point un par un, précisément, sans sur-interpréter.
- Veut voir la **preuve** que ça marche (capture d'écran réelle après test) avant de considérer que c'est fait — toujours boucler par une vérification Playwright + capture avant de dire "c'est fait".
- Apprécie l'autonomie complète : construire les scénarios Make, tester, corriger les bugs trouvés en testant (même non demandés), plutôt que de livrer du code non vérifié.
- Insiste sur la cohérence transversale du Hub — toujours se demander si une donnée/variable/fichier généré ailleurs dans le site peut être réutilisé plutôt que redemandé.

## 10. Feature de référence : Admin > Budgets Projets

Le build le plus complet et le plus récent à ce jour — regarder son historique de bout en bout si besoin d'un exemple concret :
- **Modèle de données** : 1 fichier Excel = 1 budget d'artiste (sur SharePoint, nommé `DUCHESS_Budget_<Artiste>.xlsx`), 1 feuillet = 1 projet (EP/LP/Single). Reproduit fidèlement un ancien classeur Excel/VBA (macros) mais sans macro — toute la logique (ajouter/supprimer sous-poste ou dépense, recalcul des totaux/ratios) est portée côté serveur Python (`backend/budget_engine.py`) et rejouée côté client en JS pour un retour instantané avant sauvegarde.
- **Scénarios Make** : `DUCHESS ADMIN - Budget LIST FICHIERS` (6854076), `DOWNLOAD` (6854048), `UPLOAD` (6854058), `RENAME FILE` (6854434) — tous team 1807512.
- **Fichiers** : `backend/budget_engine.py` (moteur), section "Onglet Admin — Budgets artistes" dans `backend/main.py` (9 endpoints REST), `js/budget.js`, bloc `#admin-view-budget` dans `index.html`, styles `.budget-*` dans `css/admin.css`.
- Bon exemple de : gestion d'un arbre de données imbriqué (Catégorie > Sous-poste > Dépense), modales génériques réutilisées (renommer, confirmer suppression, ajouter), alignement de colonnes en CSS Grid partagé entre un en-tête et des lignes de données (plus robuste que du flex + `nth-child`), itérations UX en plusieurs rounds à partir de captures annotées.

---

**Pour démarrer une nouvelle feature** : lire ce fichier, lire `js/budget.js` + la section Budget de `backend/main.py` comme modèle concret, poser les questions de cadrage à Michel (source de données, 1 fichier = quoi / 1 feuillet = quoi le cas échéant, actions CRUD nécessaires), puis suivre l'ordre : Make (scénarios + test direct via `hooks_get`) → backend (endpoints) → frontend (nav + JS + CSS) → test Playwright mocké → test avec vraies données via webhook direct → capture d'écran → livraison.
