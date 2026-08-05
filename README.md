# Duchess Hub

Site interne du label (Duchess Production / ARK) regroupant les outils sur une seule page à onglets : **Pitch**, **TikTok** (Flowstage/Publer), **Stats** (à venir), **Sous-titres** (en construction), **Stratégie** (à venir).

Site statique — pas de framework, pas d'étape de build. Tout tourne en HTML/CSS/JS directement dans le navigateur, les traitements lourds (IA, automatisations) sont délégués à des scénarios Make.com (webhooks) ou, pour l'onglet Sous-titres, à un backend dédié (voir `docs/sous-titres.md`).

## Déploiement

- **Frontend** : glisser-déposer ce dossier entier sur Netlify (drag & drop) → `duchess-hub.netlify.app`. L'URL générée n'est pas indexée — c'est le seul contrôle d'accès actuel, à ne pas partager publiquement.
- **Backend (onglet Sous-titres, à venir)** : Render, déployé depuis ce même repo GitHub. Voir `docs/sous-titres.md`.

## Structure

```
index.html              shell + les 5 onglets
css/style.css            thème (couleur d'accent change selon l'onglet via body[data-tab])
css/calendar.css         calendrier de publication (onglet TikTok)
js/tabs.js               bascule entre onglets
js/shared.js             synchronisation des champs mutualisés (voir ci-dessous)
js/pitch.js              onglet Pitch (webhooks Make PITCH GENERATOR/STATUS/FEEDBACK)
js/tiktok.js             onglet TikTok (webhooks Make SINGLE GENERATOR/STATUS)
js/tiktok-calendar.js    calendrier Publer
js/subtitles.js          onglet Sous-titres (backend Render, pas encore branché)
assets/                  logos
docs/sous-titres.md      framework technique complet de l'onglet Sous-titres
```

## Principe transversal

Le hub est pensé comme un seul outil cohérent, pas cinq outils séparés : toute info saisie ou générée sur un onglet doit pouvoir être réutilisée par les autres plutôt que ressaisie.

### Champs mutualisés entre onglets

Artiste, titre et thème/ambiance sont partagés automatiquement entre tous les onglets (marqués « Synchronisé » dans le formulaire) : les remplir sur un onglet les pré-remplit sur les autres, y compris après avoir quitté puis rouvert le site (stocké en local dans le navigateur, `localStorage`). Logique dans `js/shared.js`.

Champs synchronisés actuellement :
- **Artiste** : Pitch, TikTok, Stats, Sous-titres, Stratégie
- **Titre** : Pitch, TikTok (« nom du single »), Stats, Sous-titres, Stratégie
- **Thème / ambiance** : Pitch, TikTok (« intention »)

Les paroles se synchronisent aussi, mais dans un seul sens : quand une génération TikTok récupère les paroles via Flowstage, elles sont automatiquement poussées dans le champ paroles de l'onglet Pitch (pas de saisie manuelle possible côté TikTok, ce champ n'existe pas sur cet onglet). Backend : le scénario Make `SINGLE GENERATOR` écrit désormais le texte agrégé des paroles dans le datastore de suivi, et `SINGLE GENERATOR - STATUS` le renvoie au front (`paroles` dans la réponse JSON) ; côté site, `js/tiktok.js` le pousse vers `js/shared.js` dès qu'il est disponible pendant le polling.

L'onglet Sous-titres est pensé dans la même logique : recherche du single dans la BDD déjà alimentée par l'onglet TikTok, réutilisation du cache de paroles timées entre singles déjà traités, plutôt que de tout reconstruire à chaque fois. Détail dans `docs/sous-titres.md`.

## Onglets

### Pitch — opérationnel
Génère 3 angles courts + 1 version longue à partir d'artiste/titre + contexte optionnel. Feedback réutilisé pour améliorer les prochaines générations.

### TikTok — opérationnel
Prépare le contenu TikTok d'un single (hooks, vidéos stock, légendes) via Flowstage/Pexels/Claude, puis calendrier des posts programmés (Publer).

### Stats — à venir
Dashboard Soundcharts (auditeurs, followers, playlists). Pipeline Make déjà existant (skill `soundcharts-recap`), reste à brancher un accès lecture depuis le hub.

### Sous-titres — en construction
Deux modes : fichier .srt seul (upload audio), ou vidéo sous-titrée rendue avec style choisi (upload vidéo, police/taille/couleur/mode d'apparition réglables). Interface déjà construite, backend Render à déployer. Framework complet : `docs/sous-titres.md`.

### Stratégie — à venir
Idées de stratégie de com autour d'un artiste ou d'une sortie (réseaux sociaux, IRL, presse). Spec entrées/sortie à valider avant le build.
