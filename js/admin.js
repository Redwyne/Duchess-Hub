(function () {
  "use strict";

  /* =====================================================================
     DUCHESS HUB — Onglet Admin (Inventaire synchronisé avec OneDrive)
     =====================================================================

     LOGINS — modifie cette liste pour changer/ajouter des comptes.
     Vérification côté client (le site est déployé en drag-and-drop sur
     Netlify, sans build ni fonctions serveur, donc pas de backend
     disponible pour cacher ces identifiants — cohérent avec le seul
     contrôle d'accès actuel du site, qui est une URL non indexée).
     ===================================================================== */
  const ADMIN_USERS = [
    { email: "admin", password: "admin" },
  ];

  const WEBHOOKS = {
    list:   "https://hook.eu1.make.com/sqwmn3f52d6ugm71wcmnlcy43sujqnvu",
    add:    "https://hook.eu1.make.com/ff0sr74ewpz21nn9poksq28uwmr3h1ct",
    update: "https://hook.eu1.make.com/qelms6yd59248qwtmwkpw907vtuhaexg",
    delete: "https://hook.eu1.make.com/18htmisexordvx2dox5cge689pqm3ik1",
  };

  const AUTH_KEY = "duchess-hub-admin-authed";

  /* Aperçu de secours (snapshot) tant que le fichier OneDrive n'a pas été
     remplacé par la version restructurée fournie — voir bannière dans l'UI. */
  const SEED = {"Audio":{"table":"T_Audio","header":["Catégorie","Nom","Marque","Code Article","Prix d'achat (€)","Date d'achat","Fin de garantie","Numéro de série","Nombre","État","Fournisseur","Affectation","Lieu","Commentaire"],"rows":[["BACKLINE / DI PATCH","Câbles XLR",null,"DCH-AUD-BKL-001",null,null,null,null,1,"Bon état",null,"CABINE 1","Cabieu",null],["BACKLINE / DI PATCH","Câbles Jack",null,"DCH-AUD-BKL-002",null,null,null,null,1,"Bon état",null,"CABINE 1","Cabieu",null],["BACKLINE / DI PATCH","Câbles XLR",null,"DCH-AUD-BKL-003",null,null,null,null,3,"Bon état",null,"CABINE 2","Cabieu",null],["BACKLINE / DI PATCH","Câble Jack",null,"DCH-AUD-BKL-004",null,null,null,null,1,"Bon état",null,"CABINE 2","Cabieu",null],["BACKLINE / DI PATCH","Accessoires - PS-1 Power Supply","Furman","DCH-AUD-BKL-005",null,null,null,null,1,"Bon état",null,"RÉSERVE","Cabieu","Alimentation rack"],["BACKLINE / DI PATCH","Ampli - MARSHALL","Marshall","DCH-AUD-BKL-006",null,null,null,null,2,"Bon état",null,"RÉSERVE","Cabieu",null],["BACKLINE / DI PATCH","Ampli - Hartke","Hartke","DCH-AUD-BKL-007",null,null,null,null,1,"Bon état",null,"RÉSERVE","Cabieu",null],["BACKLINE / DI PATCH","DI - Behringer Model DI 100","Behringer","DCH-AUD-BKL-008",null,null,null,null,2,"Bon état",null,"RÉSERVE","Cabieu",null],["BACKLINE / DI PATCH","Pied de micro",null,"DCH-AUD-BKL-009",null,null,null,null,6,"Bon état",null,"RÉSERVE","Cabieu",null],["BACKLINE / DI PATCH","DI - J48","Radial","DCH-AUD-BKL-010",null,null,null,null,1,"Bon état",null,"RÉGIE","Cabieu",null],["BACKLINE / DI PATCH","Câble Jack",null,"DCH-AUD-BKL-011",null,null,null,null,1,"Bon état",null,"RÉGIE","Cabieu",null],["BACKLINE / DI PATCH","Prolongation Jack",null,"DCH-AUD-BKL-012",null,null,null,null,1,"Bon état",null,"RÉGIE","Cabieu",null],["BACKLINE / DI PATCH","Accessoires - Barre de couple stéréo",null,"DCH-AUD-BKL-013",null,null,null,null,4,"Bon état",null,"ESPACE COMPO","Cabieu",null],["BACKLINE / DI PATCH","DI - Radial SGI TX","Radial","DCH-AUD-BKL-014",null,null,null,null,4,"Bon état",null,"ESPACE COMPO","Cabieu",null],["BACKLINE / DI PATCH","DI - Radial X Amp","Radial","DCH-AUD-BKL-015",null,null,null,null,1,"Bon état",null,"ESPACE COMPO","Cabieu",null],["BACKLINE / DI PATCH","DI - Ultra-DI Behringer","Behringer","DCH-AUD-BKL-016",null,null,null,null,1,"Bon état",null,"ESPACE COMPO","Cabieu",null],["BACKLINE / DI PATCH","DI - Radial Pro DI","Radial","DCH-AUD-BKL-017",null,null,null,null,3,"Bon état",null,"ESPACE COMPO","Cabieu",null],["BACKLINE / DI PATCH","DI - Radial Pro D2","Radial","DCH-AUD-BKL-018",null,null,null,null,1,"Bon état",null,"ESPACE COMPO","Cabieu",null],["BACKLINE / DI PATCH","Pied de micro",null,"DCH-AUD-BKL-019",null,null,null,null,6,"Bon état",null,"GRANDE CABINE","Cabieu",null],["BACKLINE / DI PATCH","XLR / Raccord Casque",null,"DCH-AUD-BKL-020",null,null,null,null,1,"Bon état",null,"GRANDE CABINE","Cabieu",null],["MICROPHONES","Electro-Voice RE20","Electro-Voice","DCH-AUD-MIC-001",null,null,null,null,1,"Bon état",null,"CABINE 1","Cabieu",null],["MICROPHONES","Electro-Voice RE20","Electro-Voice","DCH-AUD-MIC-002",null,null,null,null,1,"Bon état",null,"ESPACE COMPO","Cabieu",null],["MICROPHONES","MXL 770","MXL","DCH-AUD-MIC-003",null,null,null,null,1,"Bon état",null,"RÉSERVE","Cabieu",null],["MICROPHONES","AKG P170","AKG","DCH-AUD-MIC-004",null,null,null,null,2,"Bon état",null,"RÉSERVE","Cabieu",null],["MICROPHONES","Superlux E205","Superlux","DCH-AUD-MIC-005",null,null,null,null,2,"Bon état",null,"RÉSERVE","Cabieu",null],["MICROPHONES","LCT 640 TS","Lewitt","DCH-AUD-MIC-006",null,null,null,null,1,"Bon état",null,"RÉSERVE","Cabieu","Marque Lewitt, série LCT"],["MICROPHONES","AKG Perception 220","AKG","DCH-AUD-MIC-007",null,null,null,null,2,"Bon état",null,"RÉSERVE","Cabieu",null],["MICROPHONES","Sennheiser e604","Sennheiser","DCH-AUD-MIC-008",null,null,null,null,3,"Bon état",null,"RÉSERVE","Cabieu",null],["MICROPHONES","Sennheiser e614","Sennheiser","DCH-AUD-MIC-009",null,null,null,null,2,"Bon état",null,"RÉSERVE","Cabieu",null],["MICROPHONES","Audio-Technica P48","Audio-Technica","DCH-AUD-MIC-010",null,null,null,null,2,"Bon état",null,"RÉSERVE","Cabieu",null],["MICROPHONES","AKG Perception 120","AKG","DCH-AUD-MIC-011",null,null,null,null,2,"Bon état",null,"RÉSERVE","Cabieu","(+1 boîte)"],["MICROPHONES","Sennheiser E840","Sennheiser","DCH-AUD-MIC-012",null,null,null,null,3,"Bon état",null,"RÉSERVE","Cabieu",null],["MICROPHONES","Shure SM57","Shure","DCH-AUD-MIC-013",null,null,null,null,1,"Bon état",null,"ESPACE COMPO","Cabieu",null],["MICROPHONES","Sennheiser e609","Sennheiser","DCH-AUD-MIC-014",null,null,null,null,2,"Bon état",null,"ESPACE COMPO","Cabieu",null],["MICROPHONES","Sennheiser MD421","Sennheiser","DCH-AUD-MIC-015",null,null,null,null,2,"Bon état",null,"ESPACE COMPO","Cabieu",null],["MICROPHONES","Sennheiser E840","Sennheiser","DCH-AUD-MIC-016",null,null,null,null,1,"Bon état",null,"ESPACE COMPO","Cabieu",null],["MICROPHONES","Neumann KM184","Neumann","DCH-AUD-MIC-017",null,null,null,null,2,"Bon état",null,"ESPACE COMPO","Cabieu",null],["MICROPHONES","Neumann KM185","Neumann","DCH-AUD-MIC-018",null,null,null,null,2,"Bon état",null,"ESPACE COMPO","Cabieu",null],["MICROPHONES","Filtre anti-pop - Neumann PS 20 A","Neumann","DCH-AUD-MIC-019",null,null,null,null,4,"Bon état",null,"ESPACE COMPO","Cabieu","Filtre anti-pop"],["MICROPHONES","Telefunken U47","Telefunken","DCH-AUD-MIC-020",null,null,null,null,1,"Bon état",null,"GRANDE CABINE","Cabieu",null],["MICROPHONES","Telefunken C12","Telefunken","DCH-AUD-MIC-021",null,null,null,null,2,"Bon état",null,"GRANDE CABINE","Cabieu",null],["MICROPHONES","Neumann KM185 MT Stereo Set","Neumann","DCH-AUD-MIC-022",null,null,null,null,1,"Bon état",null,"GRANDE CABINE","Cabieu","Set stéréo"],["MICROPHONES","Shure SM57","Shure","DCH-AUD-MIC-023",null,null,null,null,1,"Bon état",null,"GRANDE CABINE","Cabieu",null],["MICROPHONES","Neumann M149 Tube","Neumann","DCH-AUD-MIC-024",null,null,null,null,1,"Bon état",null,"GRANDE CABINE","Cabieu",null],["INSTRUMENTS","Guitare","Stall","DCH-AUD-INS-001",null,null,null,null,1,"Bon état",null,"RÉSERVE","Cabieu","Marque Stall"],["INSTRUMENTS","Basse",null,"DCH-AUD-INS-002",null,null,null,null,1,"Bon état",null,"RÉSERVE","Cabieu","Marque inconnue"],["INSTRUMENTS","Guitare électrique","Gibson","DCH-AUD-INS-003",null,null,null,null,1,"Bon état",null,"RÉGIE","Cabieu",null],["INSTRUMENTS","Guitare électrique","Gibson","DCH-AUD-INS-004",null,null,null,null,1,"Bon état",null,"RÉGIE","Cabieu",null],["INSTRUMENTS","Guitare électrique","Fender","DCH-AUD-INS-005",null,null,null,null,1,"Bon état",null,"RÉGIE","Cabieu",null],["INSTRUMENTS","Basse électrique","Fender","DCH-AUD-INS-006",null,null,null,null,1,"Bon état",null,"RÉGIE","Cabieu",null],["INSTRUMENTS","Guitare électrique","Gibson","DCH-AUD-INS-007",null,null,null,null,1,"Bon état",null,"ESPACE COMPO","Cabieu",null],["INSTRUMENTS","Piano numérique","Kawai","DCH-AUD-INS-008",null,null,null,null,1,"Bon état",null,"ESPACE COMPO","Cabieu","Modèle K. KAWAI"],["INSTRUMENTS","Clavier maître - Komplete Kontrol M32","Native Instruments","DCH-AUD-INS-009",null,null,null,null,1,"Bon état",null,"ESPACE COMPO","Cabieu",null],["INSTRUMENTS","Guitare acoustique",null,"DCH-AUD-INS-010",null,null,null,null,1,"Bon état",null,"GRANDE CABINE","Cabieu","Marque inconnue"],["INSTRUMENTS","Guitare électrique","Gretsch","DCH-AUD-INS-011",null,null,null,null,1,"Bon état",null,"GRANDE CABINE","Cabieu",null],["INSTRUMENTS","Piano acoustique","Yamaha","DCH-AUD-INS-012",null,null,null,null,1,"Bon état",null,"GRANDE CABINE","Cabieu","Modèle b1 PE-Silent"],["ENCEINTES","Focal Alpha 80 Evo (paire)","Focal","DCH-AUD-ENC-001",null,null,null,null,1,"Bon état",null,"CABINE 1","Cabieu","Beryllium — vérifier modèle exact"],["ENCEINTES","Focal Alpha 80 Evo (paire)","Focal","DCH-AUD-ENC-002",null,null,null,null,1,"Bon état",null,"CABINE 2","Cabieu","Beryllium — vérifier modèle exact"],["ENCEINTES","Focal Trio6 Be","Focal","DCH-AUD-ENC-003",null,null,null,null,2,"Bon état",null,"RÉGIE","Cabieu",null],["ENCEINTES","Auratone 5C","Auratone","DCH-AUD-ENC-004",null,null,null,null,1,"Bon état",null,"RÉGIE","Cabieu",null],["ENCEINTES","Focal Sub One","Focal","DCH-AUD-ENC-005",null,null,null,null,1,"Bon état",null,"RÉGIE","Cabieu","Caisson de basses"],["ENCEINTES","Focal Twin6 Be (paire)","Focal","DCH-AUD-ENC-006",null,null,null,null,1,"Bon état",null,"ESPACE COMPO","Cabieu",null],["INTERFACES","Interface audio - Apollo X4","Universal Audio","DCH-AUD-INT-001",null,null,null,null,1,"Bon état",null,"CABINE 1","Cabieu",null],["INTERFACES","Clavier maître - Komplete Kontrol","Native Instruments","DCH-AUD-INT-002",null,null,null,null,1,"Bon état",null,"CABINE 1","Cabieu","Taille non précisée"],["INTERFACES","Interface audio - Apollo X4","Universal Audio","DCH-AUD-INT-003",null,null,null,null,1,"Bon état",null,"CABINE 2","Cabieu",null],["INTERFACES","Clavier maître - Komplete Kontrol","Native Instruments","DCH-AUD-INT-004",null,null,null,null,1,"Bon état",null,"CABINE 2","Cabieu","Taille non précisée"],["INTERFACES","Casque audio - Focal","Focal","DCH-AUD-INT-005",null,null,null,null,1,"Bon état",null,"CABINE 1","Cabieu",null],["INTERFACES","Casque audio - DT 770 PRO","Beyerdynamic","DCH-AUD-INT-006",null,null,null,null,1,"Bon état",null,"CABINE 1","Cabieu",null],["INTERFACES","Casque audio - ATH (modèle non précisé)","Audio-Technica","DCH-AUD-INT-007",null,null,null,null,1,"Bon état",null,"CABINE 1","Cabieu",null],["INTERFACES","Casque audio - ATH (modèle non précisé)","Audio-Technica","DCH-AUD-INT-008",null,null,null,null,1,"Bon état",null,"CABINE 2","Cabieu",null],["INTERFACES","Casque audio - K-Series (modèle non précisé)","AKG","DCH-AUD-INT-009",null,null,null,null,1,"Bon état",null,"CABINE 2","Cabieu",null],["INTERFACES","Casque audio - Focal (modèle non précisé)","Focal","DCH-AUD-INT-010",null,null,null,null,1,"Bon état",null,"CABINE 2","Cabieu",null],["INTERFACES","Ampli casque - S-Phone","Samson","DCH-AUD-INT-011",null,null,null,null,1,"Bon état",null,"RÉSERVE","Cabieu","Headphone mixer/amp"],["INTERFACES","Interface audio - Apollo 8","Universal Audio","DCH-AUD-INT-012",null,null,null,null,1,"Bon état",null,"RÉSERVE","Cabieu",null],["INTERFACES","Table de mixage - ATB (modèle non précisé)","Toft Audio","DCH-AUD-INT-013",null,null,null,null,1,"Bon état",null,"RÉSERVE","Cabieu","Toft Audio Designs"],["INTERFACES","Clavier maître - Komplete Kontrol","Native Instruments","DCH-AUD-INT-014",null,null,null,null,1,"Bon état",null,"RÉSERVE","Cabieu","Taille non précisée"],["INTERFACES","Préampli - Tube Mic Preamp",null,"DCH-AUD-INT-015",null,null,null,null,2,"Bon état",null,"RÉSERVE","Cabieu","Marque non précisée"],["INTERFACES","Préampli - Tube Pre",null,"DCH-AUD-INT-016",null,null,null,null,1,"Bon état",null,"RÉSERVE","Cabieu","Marque non précisée"],["INTERFACES","Casque audio - Studio M","Steinberg","DCH-AUD-INT-017",null,null,null,null,1,"Bon état",null,"RÉSERVE","Cabieu","Modèle Studio M"],["INTERFACES","Casque audio - Steinberg (modèle non précisé)","Steinberg","DCH-AUD-INT-018",null,null,null,null,1,"Bon état",null,"RÉSERVE","Cabieu",null],["INTERFACES","Interface audio - RME Fireface UFX III","RME","DCH-AUD-INT-019",null,null,null,null,1,"Bon état",null,"RÉSERVE","Cabieu",null],["INTERFACES","DSP Accelerator - UAD-2 Satellite","Universal Audio","DCH-AUD-INT-020",null,null,null,null,1,"Bon état",null,"RÉGIE","Cabieu",null],["INTERFACES","Interface audio - Apollo x8p","Universal Audio","DCH-AUD-INT-021",null,null,null,null,1,"Bon état",null,"RÉGIE","Cabieu",null],["INTERFACES","Préampli micro - TG2 Dual Mono","Chandler Limited","DCH-AUD-INT-022",null,null,null,null,1,"Bon état",null,"RÉGIE","Cabieu","En cours d'achat"],["INTERFACES","Interface audio - Apollo Twin X","Universal Audio","DCH-AUD-INT-023",null,null,null,null,1,"Bon état",null,"RÉGIE","Cabieu",null],["INTERFACES","Préampli - Clarett OctoPre","Focusrite","DCH-AUD-INT-024",null,null,null,null,1,"Bon état",null,"RÉGIE","Cabieu",null],["INTERFACES","Clavier maître - Komplete Kontrol (petit)","Native Instruments","DCH-AUD-INT-025",null,null,null,null,1,"Bon état",null,"RÉGIE","Cabieu",null],["INTERFACES","Clavier maître - Komplete Kontrol (moyen)","Native Instruments","DCH-AUD-INT-026",null,null,null,null,1,"Bon état",null,"RÉGIE","Cabieu",null],["INTERFACES","Clavier maître - Komplete Kontrol (grand)","Native Instruments","DCH-AUD-INT-027",null,null,null,null,1,"Bon état",null,"RÉGIE","Cabieu",null],["INTERFACES","Ampli casque - Powerplay Pro XL","Behringer","DCH-AUD-INT-028",null,null,null,null,4,"Bon état",null,"RÉGIE","Cabieu",null],["INTERFACES","Casque audio - DT 770 Pro","Beyerdynamic","DCH-AUD-INT-029",null,null,null,null,1,"Bon état",null,"RÉGIE","Cabieu",null],["INTERFACES","Casque audio - Audeze (modèle non précisé)","Audeze","DCH-AUD-INT-030",null,null,null,null,1,"Bon état",null,"RÉGIE","Cabieu",null],["INTERFACES","Interface audio - Apollo Twin X","Universal Audio","DCH-AUD-INT-031",null,null,null,null,1,"Bon état",null,"ESPACE COMPO","Cabieu",null],["INTERFACES","DSP Accelerator - UAD-2 Satellite","Universal Audio","DCH-AUD-INT-032",null,null,null,null,1,"Bon état",null,"ESPACE COMPO","Cabieu",null],["INTERFACES","Casque audio - DT 770 PRO","Beyerdynamic","DCH-AUD-INT-033",null,null,null,null,3,"Bon état",null,"ESPACE COMPO","Cabieu",null],["INTERFACES","Casque audio - ATH (modèle non précisé)","Audio-Technica","DCH-AUD-INT-034",null,null,null,null,1,"Bon état",null,"ESPACE COMPO","Cabieu",null],["INTERFACES","Préampli - Auratones",null,"DCH-AUD-INT-035",null,null,null,null,1,"Bon état",null,"RÉGIE","Cabieu","Préampli dédié aux Auratones"],["INTERFACES","Casque audio - DT 770 Pro","Beyerdynamic","DCH-AUD-INT-036",null,null,null,null,3,"Bon état",null,"GRANDE CABINE","Cabieu",null],["DIVERS","Pédale sustain",null,"DCH-AUD-DIV-001",null,null,null,null,1,"Bon état",null,"CABINE 1","Cabieu",null],["DIVERS","Pédale sustain",null,"DCH-AUD-DIV-002",null,null,null,null,2,"Bon état",null,"RÉGIE","Cabieu",null]]},"Vidéo":{"table":"T_Vid_o","header":["Catégorie","Nom","Marque","Code Article","Prix d'achat (€)","Date d'achat","Fin de garantie","Numéro de série","Nombre","État","Fournisseur","Affectation","Lieu","Commentaire"],"rows":[["CAMÉRAS",null,null,"DCH-VID-CAM-001",null,null,null,null,null,null,null,null,null,null],["CAMÉRAS",null,null,"DCH-VID-CAM-002",null,null,null,null,null,null,null,null,null,null],["CAMÉRAS",null,null,"DCH-VID-CAM-003",null,null,null,null,null,null,null,null,null,null],["PIEDS & SUPPORTS",null,null,"DCH-VID-PDS-001",null,null,null,null,null,null,null,null,null,null],["PIEDS & SUPPORTS",null,null,"DCH-VID-PDS-002",null,null,null,null,null,null,null,null,null,null],["PIEDS & SUPPORTS",null,null,"DCH-VID-PDS-003",null,null,null,null,null,null,null,null,null,null],["CÂBLES & STOCKAGE",null,null,"DCH-VID-CAB-001",null,null,null,null,null,null,null,null,null,null],["CÂBLES & STOCKAGE",null,null,"DCH-VID-CAB-002",null,null,null,null,null,null,null,null,null,null],["CÂBLES & STOCKAGE",null,null,"DCH-VID-CAB-003",null,null,null,null,null,null,null,null,null,null],["FONDS & DÉCORS",null,null,"DCH-VID-FND-001",null,null,null,null,null,null,null,null,null,null],["FONDS & DÉCORS",null,null,"DCH-VID-FND-002",null,null,null,null,null,null,null,null,null,null],["FONDS & DÉCORS",null,null,"DCH-VID-FND-003",null,null,null,null,null,null,null,null,null,null],["ÉCLAIRAGES",null,null,"DCH-VID-ECL-001",null,null,null,null,null,null,null,null,null,null],["ÉCLAIRAGES",null,null,"DCH-VID-ECL-002",null,null,null,null,null,null,null,null,null,null],["ÉCLAIRAGES",null,null,"DCH-VID-ECL-003",null,null,null,null,null,null,null,null,null,null],["DIVERS",null,null,"DCH-VID-DIV-001",null,null,null,null,null,null,null,null,null,null],["DIVERS",null,null,"DCH-VID-DIV-002",null,null,null,null,null,null,null,null,null,null],["DIVERS",null,null,"DCH-VID-DIV-003",null,null,null,null,null,null,null,null,null,null]]},"IT Hardware":{"table":"T_IT_Hardware","header":["Catégorie","Nom","Marque","Modèle","Code Article","Prix Neuf (€)","Date d'achat","Fin de garantie","Numéro de série","Nombre","État","Fournisseur","Affectation","Lieu","Commentaire"],"rows":[["MAC & ORDINATEURS","MacBook Air 13\"","Apple","M5 2026 — 16 Go","DCH-IT-HW-MAC-001",1099,null,null,"GMK9J2ND95",1,"Neuf",null,"Nathan Guivarch",null,"macOS Tahoe 26.4.1 — puce M5"],["MAC & ORDINATEURS","MacBook Air 13\"","Apple","M3 2024 — 24 Go","DCH-IT-HW-MAC-002",1499,null,null,"M65W0FK00D",1,"Bon état",null,"Maëlle",null,"macOS Sequoia 15.7.7 — puce M3"],["MAC & ORDINATEURS","MacBook Air 13\"","Apple","M2 2022 — 8 Go","DCH-IT-HW-MAC-003",1199,null,null,"VK61WQK690",1,"Bon état",null,"Margaux",null,"macOS Sequoia 15.5 — puce M2"],["MAC & ORDINATEURS","MacBook Air 13\"","Apple","M3 2024 — 16 Go","DCH-IT-HW-MAC-004",1299,null,null,"F7Y3YY94CM",1,"Neuf",null,"Orlane",null,"macOS Sequoia 15.2 — puce M3"],["MAC & ORDINATEURS","MacBook Pro 16\"","Apple","M1 Max 2021 — 32 Go","DCH-IT-HW-MAC-005",3499,null,null,"NG75TJ2W0J",1,"Bon état",null,"Anaïs",null,"macOS Sequoia 15.5 — puce M1 Max"],["MAC & ORDINATEURS","MacBook Air 13\"","Apple","M5 2026 — 16 Go","DCH-IT-HW-MAC-006",1099,null,null,"JCM9G27YGG",1,"Neuf",null,"Grégoire Rouaud",null,"macOS Tahoe 26.4.1 — puce M5"],["MAC & ORDINATEURS","MacBook Air 15\"","Apple","M3 2024 — 16 Go","DCH-IT-HW-MAC-007",1599,null,null,"J6PYJN39HV",1,"Bon état",null,"Michel Kamel",null,"macOS Tahoe 26.3 — puce M3"],["MAC & ORDINATEURS","MacBook Air 13\"","Apple","M3 2024 — 24 Go","DCH-IT-HW-MAC-008",1499,null,null,"KL0G2L3XYC",1,"Bon état",null,"Chloé Mourgeon",null,"macOS Sequoia 15.6.1 — puce M3"],["MAC & ORDINATEURS","MacBook Pro 14\"","Apple","M4 Max nov. 2024 — 36 Go","DCH-IT-HW-MAC-009",3899,null,null,"DWQ4R2RC6W",1,"Bon état",null,"Léo Chatelier",null,"macOS Tahoe 26.3.1 (a) — puce M4 Max"],["MAC & ORDINATEURS","iMac 27\"","Apple","A2115 — iMac 27\" 2019/2020","DCH-IT-HW-MAC-013",2299,null,null,"H12D8JT0PN7C",1,"Bon état",null,"Bureau Admin","Bellivet","iMac Retina 5K Intel"],["MAC & ORDINATEURS","MacBook Air 13\"","Apple","M3 2024 — 24 Go","DCH-IT-HW-MAC-010",1499,null,null,"TFY9X9212F",1,"Bon état",null,"Livio Bruscolini",null,"macOS Sequoia 15.5 — puce M3"],["MAC & ORDINATEURS","MacBook Pro 16\"","Apple","M3 Max nov. 2023 — 48 Go","DCH-IT-HW-MAC-011",3999,null,null,"FD7CV4126Q",1,"Bon état",null,"Naumaur - Nicolas Marques",null,"macOS Sequoia 15.6.1 — puce M3 Max"],["MAC & ORDINATEURS","MacBook Air 13\"","Apple","M3 2024 — 16 Go","DCH-IT-HW-MAC-012",1299,null,null,"K9TLCQGDPG",1,"Bon état",null,"Axell",null,"macOS Sequoia 15.6.1 — puce M3"],["MAC & ORDINATEURS","MacBook Pro 16\"","Apple","M1 2021 - 32 Go","DCH-IT-HW-MAC-014",null,null,null,"WJQ1H2N4CW",1,"Bon état",null,"Heroe - Mehdi Nacer",null,"macOS Sequoia 15.7.2 — puce M1"],["MAC & ORDINATEURS","Mac Studio","Apple","A3389 — EMC 8859","DCH-IT-HW-MAC-016",2299,null,null,"RC6X3R4LT4",1,"Bon état",null,"Cabine 2","Cabieu","Prix = config. de base M4 Max, config exacte à confirmer"],["MAC & ORDINATEURS","iPad (A16) 128 Go","Apple","MD3Y4TY/A","DCH-IT-HW-MAC-017",509,null,null,"L99MY204JQ",1,"Bon état",null,"Régie","Cabieu",null],["ÉCRANS & DISPLAYS","Studio Display","Apple","A2525","DCH-IT-HW-SCR-001",1749,null,null,"VFN4Y6L1PV",1,"Bon état",null,"Bureau CDP","Bellivet","Pied standard"],["ÉCRANS & DISPLAYS","Studio Display","Apple","A2525","DCH-IT-HW-SCR-001",1749,null,null,"K03KG67J0L",1,"Bon état",null,"Bureau CDP","Bellivet","Adaptateur VESA"],["ÉCRANS & DISPLAYS","Studio Display","Apple","A2525","DCH-IT-HW-SCR-001",1749,null,null,"GPQJNHN260",1,"Bon état",null,"Bureau CDP","Bellivet","Pied standard"],["ÉCRANS & DISPLAYS","Studio Display","Apple","A2525","DCH-IT-HW-SCR-001",1749,null,null,"LT07V034XC",1,"Bon état",null,"Bureau Admin","Bellivet","Pied standard"],["ÉCRANS & DISPLAYS","Studio Display","Apple","A2525","DCH-IT-HW-SCR-001",1749,null,null,"X5C97MVR93",1,"Bon état",null,"Bureau Visio","Bellivet","Pied standard"],["ÉCRANS & DISPLAYS","Studio Display","Apple","A2525","DCH-IT-HW-SCR-001",1749,null,null,"G7W6CQQWPK",1,"Bon état",null,"Open Space","Bellivet",null],["ÉCRANS & DISPLAYS","Studio Display","Apple","A2525","DCH-IT-HW-SCR-001",1749,null,null,"X5GZ6D41R5",1,"Bon état",null,"Open Space","Bellivet",null],["ÉCRANS & DISPLAYS","Studio Display","Apple","A2525","DCH-IT-HW-SCR-001",1749,null,null,"X0RHKWW92N",1,"Bon état",null,"Open Space","Bellivet",null],["ÉCRANS & DISPLAYS","Studio Display","Apple","A2525","DCH-IT-HW-SCR-001",1749,null,null,"GHKG6903HK",1,"Bon état",null,"Open Space","Bellivet",null],["ÉCRANS & DISPLAYS","Studio Display","Apple","A2525","DCH-IT-HW-SCR-001",1749,null,null,"JDR7RC219N",1,"Bon état",null,"Open Space","Bellivet",null],["ÉCRANS & DISPLAYS","Écran Curved 27\" Odyssey G5","Samsung","C27G55TQBU","DCH-IT-HW-SCR-002",350,null,null,"008FHK2W502733Y",2,"Bon état",null,"Bureau Admin","Bellivet","008FHK2W502733Y (écran 1) — écran 2 à relever"],["ÉCRANS & DISPLAYS","Studio Display","Apple","A2525","DCH-IT-HW-SCR-001",1749,null,null,"D92TWVGH4JC",1,"Bon état",null,"Régie","Cabieu",null],["ÉCRANS & DISPLAYS","Studio Display","Apple","A2525","DCH-IT-HW-SCR-001",1749,null,null,"C9R1X9DHH6",1,"Bon état",null,"Accueil","Cabieu",null],["ÉCRANS & DISPLAYS","Studio Display","Apple","A2525","DCH-IT-HW-SCR-001",1749,null,null,"D46T702JNQ",1,"Bon état",null,"Accueil","Cabieu",null],["ÉCRANS & DISPLAYS","Studio Display","Apple","A2525","DCH-IT-HW-SCR-001",1749,null,null,"C3RH25JW13",1,"Bon état",null,"Accueil","Cabieu",null],["ÉCRANS & DISPLAYS","Studio Display","Apple","A2525","DCH-IT-HW-SCR-001",1749,null,null,"CW3P6T7J22",1,"Bon état",null,"Accueil","Cabieu",null],["ÉCRANS & DISPLAYS","Studio Display","Apple","A2525","DCH-IT-HW-SCR-001",1749,null,null,"D4J4C52FK",1,"Bon état",null,"Bureau","Cabieu","S/N à reconfirmer sur place (lecture sur photo inversée)"],["ÉCRANS & DISPLAYS","Studio Display","Apple","A2525","DCH-IT-HW-SCR-001",1749,null,null,"JJHPJQGMWV",1,"Bon état",null,"Espace Compo","Cabieu",null],["ÉCRANS & DISPLAYS","Studio Display","Apple","A2525","DCH-IT-HW-SCR-001",1749,null,null,"JCRQR4DNHC",1,"Bon état",null,"Cabine 2","Cabieu",null],["ÉCRANS & DISPLAYS","TV","Hisense","Modèle/taille à confirmer","DCH-IT-HW-SCR-004",null,null,null,"39647-316322-232R-B4519R",1,"Bon état",null,"Salon","Cabieu","Étiquette illisible (photo floue/inversée) — S/N partiel ; modèle, taille et prix à relever sur place"],["ÉCRANS & DISPLAYS","Webcam clipée sur TV","TOALLIN",null,"DCH-IT-HW-SCR-005",null,null,null,null,1,"Bon état",null,"Salon","Cabieu","Marque peu courante — modèle et prix non trouvés en ligne, à relever sur place"],["RÉSEAU","Routeur professionnel ONE521","OneAccess / Ekinops","ONE521 Gb5TWac — ONE500 Series","DCH-IT-HW-NET-001",800,null,null,"T2501008254205886",1,"Bon état",null,"Open Space","Bellivet","MAC : 70FC8C68F010 — Made in Belgium 01/2025"],["RÉSEAU","ONT Fibre optique G-010G-Q","Nokia","G-010G-Q","DCH-IT-HW-NET-002",null,null,null,"ALCLF9741ED7",1,"Bon état",null,"Open Space","Bellivet","Propriété Bouygues Télécom — MAC : F40B9FBF7CD0"],["RÉSEAU","Switch Gigabit 5 ports PoE+","TP-Link","TL-SG1005P","DCH-IT-HW-NET-003",70,null,null,"224C0B4002290",1,"Bon état",null,"Open Space","Bellivet",null],["RÉSEAU","Point d'accès WiFi","HPE Aruba Networking","Modèle à confirmer (Instant On AP2x / 500 Series)","DCH-IT-HW-NET-008",null,null,null,"CNSBLBM6PR",1,"Bon état",null,"Grande régie","Cabieu","MAC : 48:00:20:CF:D2:FC — modèle exact non lisible sur étiquette, prix à confirmer (~150-250 €)"],["RÉSEAU","Point d'accès WiFi","HPE Aruba Networking","Modèle à confirmer (Instant On AP2x / 500 Series)","DCH-IT-HW-NET-008",null,null,null,"CNSBLBM6PJ",1,"Bon état",null,"Accueil","Cabieu","MAC : 48:00:20:CF:E8:50 — modèle exact non lisible sur étiquette, prix à confirmer (~150-250 €)"],["RÉSEAU","Point d'accès WiFi","HPE Aruba Networking","Modèle à confirmer (Instant On AP2x / 500 Series)","DCH-IT-HW-NET-008",null,null,null,"CNSBLBM6PY",1,"Bon état",null,"Salon","Cabieu","MAC : 54:F0:B1:C0:10:A4 (lecture à reconfirmer) — modèle exact non lisible, prix à confirmer"],["RÉSEAU","Point d'accès WiFi","HPE Aruba Networking","Modèle à confirmer (Instant On AP2x / 500 Series)","DCH-IT-HW-NET-008",null,null,null,"CNSBLBM8PK",1,"Bon état",null,"Espace Compo","Cabieu","MAC : 48:00:20:CF:B8:C4 — modèle exact non lisible sur étiquette, prix à confirmer (~150-250 €)"],["CÂBLES","Câble Thunderbolt 4","Apple","TB4 Pro Cable 1m","DCH-IT-HW-CAB-001",79,null,null,null,3,"Bon état",null,"Bureau CDP","Bellivet",null],["CÂBLES","Câble Thunderbolt 4","Apple","TB4 Pro Cable 1m","DCH-IT-HW-CAB-001",79,null,null,null,1,"Bon état",null,"Bureau Admin","Bellivet",null],["CÂBLES","Câble Thunderbolt 4","Apple","TB4 Pro Cable 1m","DCH-IT-HW-CAB-001",79,null,null,null,1,"Bon état",null,"Bureau Visio","Bellivet",null],["CÂBLES","Câble Thunderbolt 4","Apple","TB4 Pro Cable 1m","DCH-IT-HW-CAB-001",79,null,null,null,3,"Bon état",null,"Open Space","Bellivet",null],["CÂBLES","Câble Thunderbolt 5","Cable Matters","TB5","DCH-IT-HW-CAB-002",50,null,null,null,2,"Bon état",null,"Open Space","Bellivet",null],["CÂBLES","Câble USB-C vers Lightning","Apple","USB-C to Lightning 1m","DCH-IT-HW-CAB-003",19,null,null,null,2,"Bon état",null,"Open Space","Bellivet",null],["CÂBLES","Câble Thunderbolt 4","Apple","TB4 Pro Cable 1m","DCH-IT-HW-CAB-001",79,null,null,null,3,"Bon état",null,"Accueil","Cabieu",null],["CÂBLES","Câble Thunderbolt 4","Apple","TB4 Pro Cable 1m","DCH-IT-HW-CAB-001",79,null,null,null,2,"Bon état",null,"Espace Compo","Cabieu",null],["CÂBLES","Câble Thunderbolt 4","Apple","TB4 Pro Cable 1m","DCH-IT-HW-CAB-001",79,null,null,null,1,"Bon état",null,"Cabine 2","Cabieu","Noir"],["CÂBLES","Câble Thunderbolt 5","Cable Matters","TB5","DCH-IT-HW-CAB-002",50,null,null,null,1,"Bon état",null,"Cabine 2","Cabieu","Gaine bleue, connecteur noir — marque à confirmer sur place (rattachement à CAB-002 probable)"],["CÂBLES","Câble USB-C","Belkin",null,"DCH-IT-HW-CAB-005",null,null,null,null,1,"Bon état",null,"Accueil","Cabieu","Code CAB-005 réservé à la session 1 (Cabine 1) — à créer ; modèle et prix (10-20 €) à confirmer"],["CÂBLES","Câble USB-C","Belkin",null,"DCH-IT-HW-CAB-005",null,null,null,null,1,"Bon état",null,"Bureau","Cabieu","Code CAB-005 réservé à la session 1 (Cabine 1) — à créer ; si modèle différent → CAB-006"],["STOCKAGE & PÉRIPHÉRIQUES","Clavier Magic Keyboard ","Apple","A1843 — AZERTY","DCH-IT-HW-STK-001",129,null,null,"FNP751600A3JKP61H",1,"Bon état",null,"Bureau CDP","Bellivet","Sans Touch ID"],["STOCKAGE & PÉRIPHÉRIQUES","Souris M240 Silent","Logitech","MU0055","DCH-IT-HW-STK-002",45,null,null,"2346HS04DWP8",1,"Bon état",null,"Bureau Admin","Bellivet",null],["STOCKAGE & PÉRIPHÉRIQUES","Clavier filaire K120 — AZERTY","Logitech","K120 / YU0042","DCH-IT-HW-STK-003",25,null,null,"2421MR28A568",1,"Bon état",null,"Bureau Admin","Bellivet",null],["STOCKAGE & PÉRIPHÉRIQUES","Souris gaming W60 Max","Bloody (A4Tech)","W60 Max","DCH-IT-HW-STK-004",50,null,null,"PS211100",1,"Bon état",null,"Bureau Admin","Bellivet",null],["STOCKAGE & PÉRIPHÉRIQUES","Clavier Magic Keyboard ","Apple","A1843 — AZERTY","DCH-IT-HW-STK-005",129,null,null,"FNP9042000GJKP6A1",1,"Bon état",null,"Bureau Admin","Bellivet","Sans Touch ID"],["STOCKAGE & PÉRIPHÉRIQUES","Imprimante multifonction DeskJet 4120e","HP","DeskJet 4120e","DCH-IT-HW-STK-006",90,null,null,"CN35GGFM49",1,"Bon état",null,"Bureau Admin","Bellivet",null],["STOCKAGE & PÉRIPHÉRIQUES","Clavier Magic Keyboard ","Apple","A1843 — AZERTY","DCH-IT-HW-STK-007",129,null,null,"FNP82950084JKP6A6",1,"Bon état",null,"Open Space","Bellivet","Sans Touch ID"],["STOCKAGE & PÉRIPHÉRIQUES","Clavier Magic Keyboard ","Apple","A2520 — AZERTY","DCH-IT-HW-STK-008",199,null,null,"F0T3455RLJ70PKGAH",1,"Bon état",null,"Open Space","Bellivet","Avec Touch ID"],["STOCKAGE & PÉRIPHÉRIQUES","Magic Mouse 2","Apple","A1657","DCH-IT-HW-STK-009",85,null,null,"CC2308308T017YMA8",1,"Bon état",null,"Open Space","Bellivet",null],["STOCKAGE & PÉRIPHÉRIQUES","Magic Mouse 2","Apple","A1657","DCH-IT-HW-STK-010",85,null,null,"CC222331EST17YMAR",1,"Bon état",null,"Open Space","Bellivet",null],["STOCKAGE & PÉRIPHÉRIQUES","Magic Mouse 2","Apple","A1657","DCH-IT-HW-STK-011",85,null,null,"CC2322504DN17YMAC",1,"Bon état",null,"Open Space","Bellivet",null],["STOCKAGE & PÉRIPHÉRIQUES","Magic Mouse 2","Apple","A1657","DCH-IT-HW-STK-012",85,null,null,"CC2344304AK17YMAJ",1,"Bon état",null,"Open Space","Bellivet",null],["STOCKAGE & PÉRIPHÉRIQUES","Clavier Magic Keyboard","Apple","A2520 — AZERTY","DCH-IT-HW-STK-013",199,null,null,"F0T2527RHBN0PKGA1",1,"Bon état",null,"Open Space","Bellivet","Avec Touch ID"],["STOCKAGE & PÉRIPHÉRIQUES","Magic Mouse 2","Apple","A1657","DCH-IT-HW-STK-014",85,null,null,"CC222120NZE17YMAK",1,"Bon état",null,"Open Space","Bellivet",null],["STOCKAGE & PÉRIPHÉRIQUES","Magic Trackpad 2","Apple","A1535 — Space Gray","DCH-IT-HW-STK-015",149,null,null,"CC2317500E11G30AH",1,"Bon état",null,"Open Space","Bellivet",null],["STOCKAGE & PÉRIPHÉRIQUES","Clavier MX Keys for Mac","Logitech","MX Keys for Mac — YR0073 — AZERTY","DCH-IT-HW-STK-016",119,null,null,null,1,"Bon état",null,"Open Space","Bellivet","S/N non visible"],["STOCKAGE & PÉRIPHÉRIQUES","Clavier Magic Keyboard","Apple","A2520 — QWERTY","DCH-IT-HW-STK-017",199,null,null,"F0T34B6RJXY0KR3AC",1,"Neuf",null,"Open Space","Bellivet","Neuf en boîte — QWERTY"],["STOCKAGE & PÉRIPHÉRIQUES","Clavier Magic Keyboard","Apple","A2520 — AZERTY","DCH-IT-HW-STK-008",199,null,null,"F0T3455RLGP0PKGA7",1,"Bon état",null,"Accueil","Cabieu","Avec Touch ID"],["STOCKAGE & PÉRIPHÉRIQUES","Clavier Magic Keyboard","Apple","A2520 — AZERTY","DCH-IT-HW-STK-008",199,null,null,"F0T3455RLEZ0PKGA3",1,"Bon état",null,"Bureau","Cabieu","Avec Touch ID"],["STOCKAGE & PÉRIPHÉRIQUES","Magic Mouse 2","Apple","A1657","DCH-IT-HW-STK-009",85,null,null,"CC292G202RDJ2XFAR",1,"Bon état",null,"Accueil","Cabieu",null],["STOCKAGE & PÉRIPHÉRIQUES","Magic Mouse 2","Apple","A1657","DCH-IT-HW-STK-009",85,null,null,"CC2328602WVOGTHAJ",1,"Bon état",null,"Accueil","Cabieu",null],["STOCKAGE & PÉRIPHÉRIQUES","Magic Mouse 2","Apple","A1657","DCH-IT-HW-STK-009",85,null,null,"CC230750A5017YMA5",1,"Bon état",null,"Accueil","Cabieu",null],["STOCKAGE & PÉRIPHÉRIQUES","Magic Mouse 2","Apple","A1657","DCH-IT-HW-STK-009",85,null,null,"CC272741DGZJ2XFAK",1,"Bon état",null,"Bureau","Cabieu",null],["STOCKAGE & PÉRIPHÉRIQUES","Magic Mouse 2","Apple","A1657","DCH-IT-HW-STK-009",85,null,null,"CC241030S9R0GTHB2",1,"Bon état",null,"Cabine 2","Cabieu",null],["STOCKAGE & PÉRIPHÉRIQUES","Hub USB-C","Panda",null,"DCH-IT-HW-STK-019",null,null,null,null,1,"Bon état",null,"Accueil","Cabieu","Code STK-019 réservé à la session 1 (Local technique / Cabine 1) — à créer"],["STOCKAGE & PÉRIPHÉRIQUES","Hub USB-C","Panda",null,"DCH-IT-HW-STK-019",null,null,null,null,1,"Bon état",null,"Bureau","Cabieu","Code STK-019 réservé à la session 1 — à créer"],["STOCKAGE & PÉRIPHÉRIQUES","Hub USB-C","SINEHO",null,"DCH-IT-HW-STK-020",null,null,null,null,1,"Bon état",null,"Cabine 2","Cabieu","Code STK-020 réservé à la session 1 — à créer"],["STOCKAGE & PÉRIPHÉRIQUES","Magic Mouse (USB-C)","Apple","A3204","DCH-IT-HW-STK-021",85,null,null,"CC2HB0035JA0000855",1,"Bon état",null,"Régie","Cabieu","Prix retenu = coloris blanc ; noir 99-119 €"],["STOCKAGE & PÉRIPHÉRIQUES","Magic Mouse (USB-C)","Apple","A3204","DCH-IT-HW-STK-021",85,null,null,"CC2HB07ZXA0000555",1,"Bon état",null,"Accueil","Cabieu","Prix retenu = coloris blanc ; noir 99-119 €"],["STOCKAGE & PÉRIPHÉRIQUES","Clavier Magic Keyboard Touch ID (USB-C)","Apple","A3119","DCH-IT-HW-STK-022",150,null,null,"F0TH8304KMA0000MQ2",1,"Bon état",null,"Régie","Cabieu","Prix retenu = version sans pavé numérique ; à vérifier sur place (205 € si pavé)"],["STOCKAGE & PÉRIPHÉRIQUES","Clavier Magic Keyboard Touch ID (USB-C)","Apple","A3119","DCH-IT-HW-STK-022",150,null,null,"F0TH7Y0FJDA0000MQ7",1,"Bon état",null,"Régie","Cabieu","Prix retenu = version sans pavé numérique ; à vérifier sur place"],["STOCKAGE & PÉRIPHÉRIQUES","Clavier Magic Keyboard Touch ID (USB-C)","Apple","A3119","DCH-IT-HW-STK-022",150,null,null,"F0TH8G0F1HA0000MQ2",1,"Bon état",null,"Accueil","Cabieu","Prix retenu = version sans pavé numérique ; à vérifier sur place"],["STOCKAGE & PÉRIPHÉRIQUES","Clavier Magic Keyboard Touch ID (USB-C)","Apple","A3119","DCH-IT-HW-STK-022",150,null,null,"F0TH7Y0AS8A0000MQ2",1,"Bon état",null,"Accueil","Cabieu","Prix retenu = version sans pavé numérique ; à vérifier sur place"],["STOCKAGE & PÉRIPHÉRIQUES","Clavier Magic Keyboard Touch ID (USB-C)","Apple","A3119","DCH-IT-HW-STK-022",150,null,null,"F0TH8304S8A0000MQ2",1,"Bon état",null,"Accueil","Cabieu","Prix retenu = version sans pavé numérique ; à vérifier sur place"],["STOCKAGE & PÉRIPHÉRIQUES","Clavier Magic Keyboard Touch ID (USB-C)","Apple","A3119","DCH-IT-HW-STK-022",150,null,null,"F0TH7YQATJA0000MQ2",1,"Bon état",null,"Cabine 2","Cabieu","Prix retenu = version sans pavé numérique ; à vérifier sur place"],["DIVERS","Support ordinateur portable","Gokeda","Laptop Stand aluminium","DCH-IT-HW-DIV-001",25,null,null,null,1,"Bon état",null,"Bureau CDP","Bellivet",null],["DIVERS","Support ordinateur portable","Inconnue",null,"DCH-IT-HW-DIV-002",20,null,null,null,1,"Bon état",null,"Bureau CDP","Bellivet","Marque non identifiée"],["DIVERS","HomePod mini","Apple","HomePod mini — Space Gray","DCH-IT-HW-DIV-003",109,null,null,"HG5KG49RPQ71",1,"Bon état",null,"Open Space","Bellivet",null],["DIVERS","HomePod mini","Apple","HomePod mini — Yellow","DCH-IT-HW-DIV-004",109,null,null,"JNDJLF6X0D",1,"Bon état",null,"Open Space","Bellivet",null],["DIVERS","Interphone vidéo sans fil WL-1ME","Aiphone","WL-1ME + base WLW-C.E","DCH-IT-HW-DIV-005",300,null,null,2404056077,1,"Bon état",null,"Open Space","Bellivet","S/N = base WLW-C.E"],["DIVERS","Centrale d'alarme Hub","Ajax Systems","Hub / Hub 2 (à confirmer)","DCH-IT-HW-DIV-006",200,null,null,null,1,"Bon état",null,"Open Space","Bellivet","Système alarme — modèle à confirmer"],["DIVERS","Répéteur alarme Ajax","Ajax Systems","ReX ou Hub 2 (à confirmer)","DCH-IT-HW-DIV-007",100,null,null,null,1,"Bon état",null,"Open Space","Bellivet","2ème appareil Ajax — modèle à confirmer"],["DIVERS","Support ordinateur portable","Inconnue",null,"DCH-IT-HW-DIV-008",20,null,null,null,1,"Bon état",null,"Open Space","Bellivet","Marque non identifiée"],["DIVERS","Prise connectée Smart Wi-Fi Plug Mini","Meross","MSS110","DCH-IT-HW-DIV-009",12,null,null,null,10,"Bon état",null,"Bellivet","Bellivet","Réparties dans les locaux"],["DIVERS","Support ordinateur portable métal mesh","Inconnue",null,"DCH-IT-HW-DIV-010",20,null,null,null,3,"Bon état",null,"Open Space","Bellivet","Support mesh noir générique"],["DIVERS","Détecteur de mouvement avec caméra ","Ajax Systems","MotionCam","DCH-IT-HW-DIV-011",120,null,null,null,1,"Bon état",null,"Open Space","Bellivet","Lié à la centrale Ajax"],["DIVERS","Clavier de code alarme KeyPad","Ajax Systems","KeyPad","DCH-IT-HW-DIV-012",100,null,null,null,1,"Bon état",null,"Open Space","Bellivet","Lié à la centrale Ajax"],["DIVERS","Caméra intérieure (type turret)","Ajax Systems","MotionCam (à confirmer)","DCH-IT-HW-DIV-015",120,null,null,null,1,"Bon état",null,"Accueil","Cabieu","Sous-modèle à confirmer sur place — prix aligné sur DIV-011"],["DIVERS","Caméra intérieure (type turret)","Ajax Systems","MotionCam (à confirmer)","DCH-IT-HW-DIV-015",120,null,null,null,1,"Bon état",null,"Couloir","Cabieu","Sous-modèle à confirmer sur place"],["DIVERS","Caméra intérieure (type turret)","Ajax Systems","MotionCam (à confirmer)","DCH-IT-HW-DIV-015",120,null,null,null,2,"Bon état",null,"Espace Compo","Cabieu","Sous-modèle à confirmer sur place"],["DIVERS","Caméra intérieure (type turret)","Ajax Systems","MotionCam (à confirmer)","DCH-IT-HW-DIV-015",120,null,null,null,1,"Bon état",null,"Grande cabine","Cabieu","Marque non confirmée sur cette unité — à vérifier sur place"],["DIVERS","Caméra dôme / fisheye","Ajax Systems",null,"DCH-IT-HW-DIV-016",120,null,null,null,1,"Bon état",null,"Accueil","Cabieu","Intérieur — modèle à confirmer"],["DIVERS","Caméra dôme / fisheye","Ajax Systems",null,"DCH-IT-HW-DIV-016",120,null,null,null,1,"Bon état",null,"Rooftop","Cabieu","Extérieur — variante outdoor probablement plus chère, prix à confirmer"],["DIVERS","Clavier de code alarme KeyPad","Ajax Systems","KeyPad","DCH-IT-HW-DIV-017",100,null,null,null,1,"Bon état",null,"Accueil","Cabieu","Lié à la centrale Ajax — prix aligné sur DIV-012"],["DIVERS","Sirène intérieure","Ajax Systems","HomeSiren (à confirmer)","DCH-IT-HW-DIV-018",86,null,null,null,1,"Bon état",null,"Cuisine","Cabieu","Modèle HomeSiren vs StreetSiren à confirmer — prix 49-86 €"],["DIVERS","Moniteur d'interphone intérieur","Akuvox","Modèle non lisible","DCH-IT-HW-DIV-019",null,null,null,null,1,"Bon état",null,"Accueil","Cabieu","Référence non lisible sur photo — modèle et prix à relever sur place"],["DIVERS","Platine de rue (caméra + clavier + badge)","Akuvox","Modèle non lisible","DCH-IT-HW-DIV-020",null,null,null,null,1,"Bon état",null,"Accueil","Cabieu","Référence non lisible sur photo — modèle et prix à relever sur place"],["DIVERS","Boîtier fibre optique","3M","PT 4375","DCH-IT-HW-DIV-021",0,null,null,null,1,"Bon état",null,"Cuisine","Cabieu","Probable matériel opérateur (0 €) comme Ekinops / Nokia en base — à confirmer"],["DIVERS","Objet non identifié (housse noire)","GiMars",null,"DCH-IT-HW-DIV-022",null,null,null,null,1,"Bon état",null,"Régie","Cabieu","Non sorti de sa housse sur les photos — nature exacte à vérifier sur place"]]},"IT Software":{"table":"T_IT_Software","header":["Catégorie","Nom","Marque","Code Article","Prix (€)","Date d'achat","Nombre","État","Fournisseur","Affectation","Commentaire","Date renouvellement","Login","Mot de passe","Email de rattachement"],"rows":[["AUDIO & PLUGINS","Slate Digital","Slate Digital","DCH-IT-SW-AUD-001","19,99 USD",null,1,"À vérifier","Slate Digital","DPR",null,"Le 02 du mois",null,null,null],["AUDIO & PLUGINS","Waves","Waves","DCH-IT-SW-AUD-002","24,99 USD",null,1,"À vérifier","Waves","DPR",null,"Le 25 du mois",null,null,null],["AUDIO & PLUGINS","Waves (Libeo)","Waves","DCH-IT-SW-AUD-003","24,99 USD",null,1,"À résilier","Waves","DPR",null,"Le 25 du mois",null,null,null],["AUDIO & PLUGINS","Baby Audio (Paddle)","Baby Audio","DCH-IT-SW-AUD-004","12,49 EUR",null,1,"À vérifier","Baby Audio","DPR",null,"Le 27 du mois",null,null,null],["AUDIO & PLUGINS","Paddle ADBL","Paddle/ADBL","DCH-IT-SW-AUD-005","29,17 EUR",null,1,"À vérifier","Paddle/ADBL","DPR",null,"Le 27 du mois",null,null,null],["AUDIO & PLUGINS","SP Universal","Universal Audio (?)","DCH-IT-SW-AUD-006","20,61 EUR",null,1,"À vérifier","Universal Audio (?)","DPR",null,"Le 15 du mois",null,null,null],["AUDIO & PLUGINS","Output","Output","DCH-IT-SW-AUD-007","12,99 EUR",null,1,"À vérifier","Output","DPR",null,null,null,null,null],["AUDIO & PLUGINS","Splice","Splice","DCH-IT-SW-AUD-008",null,null,1,"Actif","Splice","DPR",null,null,null,null,null],["AUDIO & PLUGINS","Landr Audio","Landr","DCH-IT-SW-AUD-009","38,39 EUR",null,1,"À vérifier","Landr","DPU",null,"Le 18 du mois",null,null,null],["AUDIO & PLUGINS","Plugin Alliance","Plugin Alliance","DCH-IT-SW-AUD-010","25,58 EUR",null,1,"À vérifier","Plugin Alliance","DPU",null,"Le 24 du mois",null,null,null],["AUDIO & PLUGINS","Output (DPU)","Output","DCH-IT-SW-AUD-011","12,99 EUR",null,1,"À vérifier","Output","DPU",null,null,null,null,null],["ADMIN - UTILITAIRES","Microsoft 365","Microsoft","DCH-IT-SW-ADM-001",null,null,1,"Actif","Microsoft","DPR",null,null,null,null,null],["ADMIN - UTILITAIRES","OVH","OVH","DCH-IT-SW-ADM-002",null,null,1,"Actif","OVH","DPR",null,null,null,null,null],["ADMIN - UTILITAIRES","Nordpass","NordPass","DCH-IT-SW-ADM-003","574,56 USD / an",null,1,"Actif","NordPass","DPR",null,"Le 02 du mois",null,null,null],["ADMIN - UTILITAIRES","Yousign","Yousign","DCH-IT-SW-ADM-004",null,null,1,"Actif","Yousign","DPU",null,null,null,null,null],["ADMIN - UTILITAIRES","Soundcharts","Soundcharts","DCH-IT-SW-ADM-005","154,80 USD",null,1,"Actif","Soundcharts","DPR",null,"Le 23 du mois",null,null,null],["ADMIN - UTILITAIRES","Mailmaestro","Mailmaestro","DCH-IT-SW-ADM-006","25,00 EUR",null,1,"Actif","Mailmaestro","DPR",null,"Le 27 du mois",null,null,null],["ADMIN - UTILITAIRES","Feature FM","Feature FM","DCH-IT-SW-ADM-007",null,null,1,"Actif","Feature FM","DPR",null,null,null,null,null],["ADMIN - UTILITAIRES","Linktree","Linktree","DCH-IT-SW-ADM-008","13,00 EUR",null,1,"À résilier","Linktree","DPR"," compte à localiser puis supprimer","Le 05 du mois",null,null,null],["ADMIN - UTILITAIRES","Prosec Whatspot","Whatspot","DCH-IT-SW-ADM-009","43,00 EUR",null,1,"A résilier","Whatspot","DPR",null,"Le 03 du mois",null,null,null],["ADMIN - UTILITAIRES","ChatGPT","OpenAI","DCH-IT-SW-ADM-010",null,null,1,"À vérifier","OpenAI","DPR","Moins utilisé — bascule progressive vers Claude en cours",null,null,null,null],["ADMIN - UTILITAIRES","MsBill Info","?","DCH-IT-SW-ADM-011",null,null,1,"À vérifier","?","DPU",null,null,null,null,null],["ADMIN - UTILITAIRES","Claude (Anthropic)","Anthropic","DCH-IT-SW-ADM-012",null,null,1,"En cours de déploiement","Anthropic","DPR","IA — en cours de déploiement, remplace progressivement ChatGPT",null,null,null,null],["VIDEO / CRÉA","Adobe Creative Cloud","Adobe","DCH-IT-SW-VID-001","35,99 EUR",null,1,"À vérifier","Adobe","DPR",null,"Le 15 du mois",null,null,null],["VIDEO / CRÉA","Adobe (DPU - 1)","Adobe","DCH-IT-SW-VID-002","29,99 EUR",null,1,"À vérifier","Adobe","DPU",null,"Le 05 du mois",null,null,null],["VIDEO / CRÉA","Adobe (DPU - 2)","Adobe","DCH-IT-SW-VID-003","65,54 EUR",null,1,"À vérifier","Adobe","DPU",null,"Le 17 du mois",null,null,null],["VIDEO / CRÉA","Vimeo","Vimeo","DCH-IT-SW-VID-004",null,null,1,"Actif","Vimeo","DPR",null,null,null,null,null],["VIDEO / CRÉA","Motion Array","Motion Array","DCH-IT-SW-VID-005",null,null,1,"A résilier","Motion Array","DPU",null,null,null,null,null]]},"Maintenance - Entretien":{"table":"T_Maintenance___Entretien","header":["Catégorie","Nom","Marque","Code Article","Prix d'achat (€)","Date d'achat","Fin de garantie","Numéro de série","Nombre","État","Fournisseur","Affectation","Lieu","Commentaire"],"rows":[["",null,null,null,null,null,null,null,null,null,null,null,null,null]]}};

  const SHEET_ORDER = ["Audio", "Vidéo", "IT Hardware", "IT Software", "Maintenance - Entretien"];
  const SHEET_ICONS = { "Audio": "🎚️", "Vidéo": "🎥", "IT Hardware": "💻", "IT Software": "🧩", "Maintenance - Entretien": "🧰" };

  let STATE = {};
  let currentSheet = SHEET_ORDER[0];
  let editingContext = null;
  let lastNonAdminTab = "pitch";

  /* ---------------------------- DOM refs ---------------------------- */
  const overlay = document.getElementById("admin-login-overlay");
  const dashboard = document.getElementById("admin-dashboard");
  const gate = document.getElementById("admin-gate");
  const adminTabBtn = document.querySelector('.tab-btn[data-tab-target="admin"]');
  const allTabBtns = document.querySelectorAll(".tab-btn");

  function isAuthed() {
    return sessionStorage.getItem(AUTH_KEY) === "1";
  }

  function showLogin() {
    document.getElementById("admin-login-error").textContent = "";
    document.getElementById("admin-login-form").reset();
    overlay.classList.remove("hidden");
    document.getElementById("admin-login-email").focus();
  }
  function hideLogin() { overlay.classList.add("hidden"); }

  function enterDashboard() {
    hideLogin();
    gate.style.display = "none";
    dashboard.classList.add("active");
    initSheetTabs();
    loadSheet(currentSheet);
  }

  function leaveToGate() {
    dashboard.classList.remove("active");
    gate.style.display = "";
  }

  /* Remember which tab we came from, so Cancel / not-logged-in returns there
     instead of leaving an empty admin panel behind. */
  allTabBtns.forEach((btn) => {
    if (btn.dataset.tabTarget !== "admin") {
      btn.addEventListener("click", () => { lastNonAdminTab = btn.dataset.tabTarget; });
    }
  });

  if (adminTabBtn) {
    adminTabBtn.addEventListener("click", () => {
      if (isAuthed()) { enterDashboard(); }
      else { leaveToGate(); showLogin(); }
    });
  }

  // Direct load on #admin (bookmark/refresh)
  if ((location.hash || "").replace("#", "") === "admin") {
    if (isAuthed()) { enterDashboard(); } else { showLogin(); }
  }

  const reopenBtn = document.getElementById("admin-reopen-login");
  if (reopenBtn) reopenBtn.addEventListener("click", () => showLogin());

  document.getElementById("admin-cancel-login").addEventListener("click", () => {
    hideLogin();
    if (!isAuthed()) {
      const back = document.querySelector('.tab-btn[data-tab-target="' + lastNonAdminTab + '"]') ||
                   document.querySelector('.tab-btn[data-tab-target="pitch"]');
      if (back) back.click();
    }
  });

  document.getElementById("admin-login-form").addEventListener("submit", function (e) {
    e.preventDefault();
    const email = document.getElementById("admin-login-email").value.trim().toLowerCase();
    const password = document.getElementById("admin-login-password").value;
    const errEl = document.getElementById("admin-login-error");
    const match = ADMIN_USERS.find(
      (u) => u.email.toLowerCase() === email && u.password === password
    );
    if (!match) {
      errEl.textContent = "Email ou mot de passe incorrect.";
      return;
    }
    sessionStorage.setItem(AUTH_KEY, "1");
    enterDashboard();
  });

  document.getElementById("admin-logout").addEventListener("click", () => {
    sessionStorage.removeItem(AUTH_KEY);
    const back = document.querySelector('.tab-btn[data-tab-target="' + lastNonAdminTab + '"]') ||
                 document.querySelector('.tab-btn[data-tab-target="pitch"]');
    if (back) back.click();
    leaveToGate();
  });

  /* ---------------------------- Toasts ---------------------------- */
  function toast(msg, type) {
    const c = document.getElementById("admin-toast-container");
    const el = document.createElement("div");
    el.className = "admin-toast " + (type === "err" ? "err" : "ok");
    el.textContent = msg;
    c.appendChild(el);
    setTimeout(() => el.remove(), 3800);
  }

  /* ---------------------------- Sheet tabs ---------------------------- */
  function initSheetTabs() {
    const wrap = document.getElementById("admin-sheet-tabs");
    wrap.innerHTML = "";
    SHEET_ORDER.forEach((name) => {
      const tab = document.createElement("div");
      tab.className = "admin-sheet-tab" + (name === currentSheet ? " active" : "");
      tab.textContent = (SHEET_ICONS[name] || "") + " " + name;
      tab.addEventListener("click", () => { currentSheet = name; loadSheet(name); });
      wrap.appendChild(tab);
    });
  }

  /* ---------------------------- Data layer ---------------------------- */
  async function callWebhook(url, payload) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch (e) { json = null; }
    if (!res.ok) {
      const msg = (json && json.error && json.error.message) || text || ("HTTP " + res.status);
      throw new Error(msg);
    }
    return json;
  }

  async function loadSheet(name) {
    currentSheet = name;
    initSheetTabs();
    document.getElementById("admin-content").innerHTML = '<div class="admin-empty-state">Chargement…</div>';
    const seed = SEED[name];
    const table = seed.table;

    try {
      const resp = await callWebhook(WEBHOOKS.list, { table });
      const rows = (resp && resp.value) ? resp.value.map((r) => ({ index: r.index, values: r.values[0] })) : [];
      STATE[name] = { header: seed.header, table, rows, live: true };
      document.getElementById("admin-sync-banner").innerHTML = "";
    } catch (err) {
      const rows = seed.rows.map((v, i) => ({ index: i, values: v }));
      STATE[name] = { header: seed.header, table, rows, live: false };
      document.getElementById("admin-sync-banner").innerHTML =
        '<div class="admin-banner admin-banner-warn">⚠️ Connexion au fichier OneDrive impossible pour le moment — aperçu basé sur la dernière extraction. Remplace <code>DUCHESS_Inventaire.xlsx</code> sur OneDrive par la version restructurée fournie pour activer la synchro en direct (ajout/suppression désactivés en attendant).</div>';
    }
    populateEtatFilter(name);
    renderSheet(name);
  }

  /* ---------------------------- Rendering ---------------------------- */
  function idxOf(header, name) { return header.indexOf(name); }

  function escapeHtml(s) {
    if (s === null || s === undefined) return "";
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function etatPillClass(etat) {
    if (!etat) return "admin-pill-neutral";
    const e = etat.toLowerCase();
    if (e.includes("bon") || e.includes("actif") || e.includes("neuf")) return "admin-pill-good";
    if (e.includes("vérifier") || e.includes("verifier") || e.includes("résilier")) return "admin-pill-warn";
    if (e.includes("endommag") || e.includes("défectueux") || e.includes("defectueux") || e.includes("hors service") || e.includes("perdu")) return "admin-pill-bad";
    return "admin-pill-neutral";
  }

  function populateEtatFilter(name) {
    const { header, rows } = STATE[name];
    const etatIdx = idxOf(header, "État");
    const sel = document.getElementById("admin-filter-etat");
    const cur = sel.value;
    const values = new Set();
    rows.forEach((r) => { const v = r.values[etatIdx]; if (v) values.add(v); });
    sel.innerHTML = '<option value="">Tous les états</option>' +
      [...values].sort().map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("");
    sel.value = [...values].includes(cur) ? cur : "";
  }

  function renderSheet(name) {
    const { header, rows } = STATE[name];
    const catIdx = idxOf(header, "Catégorie");
    const search = document.getElementById("admin-search-input").value.trim().toLowerCase();
    const etatFilter = document.getElementById("admin-filter-etat").value;
    const etatIdx = idxOf(header, "État");
    const displayCols = header.filter((h) => h !== "Catégorie");

    let filtered = rows.filter((r) => {
      if (etatFilter && r.values[etatIdx] !== etatFilter) return false;
      if (search) {
        const hay = r.values.map((v) => (v === null || v === undefined) ? "" : String(v)).join(" ").toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });

    const groups = {};
    filtered.forEach((r) => {
      const cat = r.values[catIdx] || "Sans catégorie";
      (groups[cat] = groups[cat] || []).push(r);
    });

    const content = document.getElementById("admin-content");
    if (Object.keys(groups).length === 0) {
      content.innerHTML = '<div class="admin-empty-state">Aucun élément ne correspond à la recherche.</div>';
      return;
    }

    const isSoftware = name === "IT Software";

    let html = "";
    Object.keys(groups).sort().forEach((cat) => {
      const items = groups[cat];
      html += `<div class="admin-cat-group"><div class="admin-cat-head"><span>${escapeHtml(cat)}</span><span class="admin-count">${items.length} élément${items.length > 1 ? "s" : ""}</span></div>`;
      html += '<div class="admin-table-wrap"><table class="admin-table"><thead><tr>';
      displayCols.forEach((c) => html += `<th>${escapeHtml(c)}</th>`);
      html += "<th></th></tr></thead><tbody>";
      items.forEach((r) => {
        html += `<tr>`;
        displayCols.forEach((colName) => {
          const colIdx = idxOf(header, colName);
          let v = r.values[colIdx];
          if (colName === "État") {
            html += `<td>${v ? `<span class="admin-pill ${etatPillClass(v)}">${escapeHtml(v)}</span>` : ""}</td>`;
          } else if (colName === "Code Article") {
            html += `<td>${v ? `<span class="admin-code-badge">${escapeHtml(v)}</span>` : ""}</td>`;
          } else if (colName === "Mot de passe" && isSoftware) {
            const cellId = "admin-pw-" + name.replace(/\W/g, "") + "-" + r.index;
            html += `<td><span id="${cellId}" data-real="${escapeHtml(v || "")}">${v ? "••••••" : ""}</span>${v ? ` <span class="admin-mask-toggle" data-toggle-pw="${cellId}">voir</span>` : ""}</td>`;
          } else if (colName === "Nom") {
            html += `<td><strong>${escapeHtml(v)}</strong></td>`;
          } else {
            html += `<td>${escapeHtml(v)}</td>`;
          }
        });
        html += `<td class="admin-row-actions">
          <button class="admin-btn-icon" title="Modifier" data-edit="${r.index}" data-sheet="${escapeHtml(name)}">✎</button>
          <button class="admin-btn-icon" title="Supprimer" data-delete="${r.index}" data-sheet="${escapeHtml(name)}">🗑</button>
        </td></tr>`;
      });
      html += "</tbody></table></div></div>";
    });
    content.innerHTML = html;

    content.querySelectorAll("[data-toggle-pw]").forEach((el) => {
      el.addEventListener("click", () => togglePw(el.getAttribute("data-toggle-pw")));
    });
    content.querySelectorAll("[data-edit]").forEach((el) => {
      el.addEventListener("click", () => openEditRow(el.getAttribute("data-sheet"), parseInt(el.getAttribute("data-edit"))));
    });
    content.querySelectorAll("[data-delete]").forEach((el) => {
      el.addEventListener("click", () => confirmDelete(el.getAttribute("data-sheet"), parseInt(el.getAttribute("data-delete"))));
    });
  }

  function togglePw(cellId) {
    const el = document.getElementById(cellId);
    if (!el) return;
    const real = el.getAttribute("data-real");
    el.textContent = el.textContent === "••••••" ? (real || "(vide)") : "••••••";
  }

  document.getElementById("admin-search-input").addEventListener("input", () => renderSheet(currentSheet));
  document.getElementById("admin-filter-etat").addEventListener("change", () => renderSheet(currentSheet));

  /* ---------------------------- Add / edit modal ---------------------------- */
  const rowOverlay = document.getElementById("admin-row-overlay");
  document.getElementById("admin-cancel-row").addEventListener("click", () => rowOverlay.classList.add("hidden"));
  document.getElementById("admin-add-row").addEventListener("click", () => openAddRow());

  function fieldInputType(colName) {
    if (colName === "Nombre") return "number";
    if (colName === "Commentaire") return "textarea";
    return "text";
  }

  function buildRowForm(name, values) {
    const { header } = STATE[name];
    const wrap = document.getElementById("admin-row-fields");
    wrap.innerHTML = "";
    header.forEach((colName, i) => {
      const val = values ? (values[i] ?? "") : "";
      const type = fieldInputType(colName);
      const div = document.createElement("div");
      div.className = "admin-field";
      if (colName === "État") {
        div.innerHTML = `<label>${colName}</label>
          <select data-col="${i}">
            <option value=""></option>
            ${["Neuf", "Bon état", "Endommagé", "Défectueux", "Hors service", "Perdu", "Actif", "À vérifier", "À résilier"].map((o) => `<option value="${o}" ${val === o ? "selected" : ""}>${o}</option>`).join("")}
          </select>`;
      } else if (type === "textarea") {
        div.innerHTML = `<label>${colName}</label><textarea data-col="${i}" rows="2">${escapeHtml(val)}</textarea>`;
      } else {
        div.innerHTML = `<label>${colName}</label><input type="${type}" data-col="${i}" value="${escapeHtml(val)}">`;
      }
      wrap.appendChild(div);
    });
  }

  function openAddRow() {
    editingContext = null;
    document.getElementById("admin-row-modal-title").textContent = "Ajouter un élément — " + currentSheet;
    document.getElementById("admin-row-modal-sub").textContent = "Le code article n'est pas généré automatiquement : renseigne-le en suivant la nomenclature existante.";
    document.getElementById("admin-row-error").textContent = "";
    buildRowForm(currentSheet, null);
    rowOverlay.classList.remove("hidden");
  }

  function openEditRow(name, index) {
    const row = STATE[name].rows.find((r) => r.index === index);
    if (!row) return;
    editingContext = { sheet: name, index };
    document.getElementById("admin-row-modal-title").textContent = "Modifier — " + name;
    document.getElementById("admin-row-modal-sub").textContent = "";
    document.getElementById("admin-row-error").textContent = "";
    buildRowForm(name, row.values);
    rowOverlay.classList.remove("hidden");
  }

  document.getElementById("admin-row-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    const sheet = editingContext ? editingContext.sheet : currentSheet;
    const { header } = STATE[sheet];
    const errEl = document.getElementById("admin-row-error");
    const inputs = document.querySelectorAll("#admin-row-fields [data-col]");
    const values = new Array(header.length).fill(null);
    inputs.forEach((inp) => { values[parseInt(inp.dataset.col)] = inp.value === "" ? null : inp.value; });

    const btn = document.getElementById("admin-save-row");
    btn.disabled = true;
    try {
      if (!STATE[sheet].live) throw new Error("Synchro OneDrive indisponible pour le moment (voir le message en haut de la page).");
      if (editingContext) {
        await callWebhook(WEBHOOKS.update, { table: STATE[sheet].table, index: editingContext.index, values: [values] });
        toast("Élément mis à jour ✅", "ok");
      } else {
        await callWebhook(WEBHOOKS.add, { table: STATE[sheet].table, values: [values] });
        toast("Élément ajouté ✅", "ok");
      }
      rowOverlay.classList.add("hidden");
      await loadSheet(sheet);
    } catch (err) {
      errEl.textContent = err.message || "Erreur lors de l'enregistrement.";
    } finally {
      btn.disabled = false;
    }
  });

  /* ---------------------------- Delete ---------------------------- */
  async function confirmDelete(name, index) {
    const row = STATE[name].rows.find((r) => r.index === index);
    const nomIdx = idxOf(STATE[name].header, "Nom");
    const label = row ? (row.values[nomIdx] || "cet élément") : "cet élément";
    if (!confirm(`Supprimer « ${label} » ? Cette action modifie directement le fichier Excel sur OneDrive.`)) return;
    if (!STATE[name].live) { toast("Synchro OneDrive indisponible pour le moment.", "err"); return; }
    try {
      await callWebhook(WEBHOOKS.delete, { table: STATE[name].table, index });
      toast("Élément supprimé 🗑", "ok");
      await loadSheet(name);
    } catch (err) {
      toast("Erreur : " + (err.message || "suppression impossible"), "err");
    }
  }
})();
