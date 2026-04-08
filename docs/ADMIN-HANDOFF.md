# Zitouna Bladi — Brief pour conception admin & workflows

Document à transmettre à un designer / PM / développeur pour définir un **back-office complet** et les **workflows métier**, à partir de l’état actuel de l’application web.

---

## 1. Aperçu produit (état actuel)

- **Thème :** investissement oléicole / parcelles, UI **vert foncé + or**.
- **Stack UI :** React, React Router. **Auth** : mock (pas de backend réel pour la session).
- **Persistance locale :** plusieurs modules utilisent **`localStorage`** (uniquement navigateur).
- **UX globale :** remontée du scroll au changement de route ; marges safe-area sur certains CTA fixes (mobile).

---

## 2. Navigation & en-tête (toutes les pages “app”)

### `TopBar` (header)

- Marque : logo + « ZITOUNA BLADI / Smart Agriculture ».
- **Desktop :** liens **Explorer** (`/browse`), **Mon Portfolio** (`/dashboard`) — icône **profil (utilisateur)**.
- **Actions :** **Carte** (`/maps`), **notifications** (cloche, placeholder non branché).
- **Pas d’icône de déconnexion dans le header** : la sortie de session pour l’investisseur est prévue via le **lien texte « Se déconnecter »** sur la page **Portfolio** (`/dashboard`), à côté de « Retour à Explorer ».
- **Mobile :** bouton **profil** → `/dashboard` ; sur le dashboard, le même emplacement devient **Explorer** (`/browse`, style or).

---

## 3. Routes & pages — côté public / investisseur

| Route | Page | Rôle & blocs principaux |
|--------|------|-------------------------|
| `/`, `/browse` | **Browse** | Liste **projets**, recherche, cartes projet, carte aperçu, CTA vers projet. |
| `/maps` | **Carte Tunisie** | Embed **Google My Maps** pleine hauteur ; bandeau or CTA ; retour Explorer. |
| `/project/:id` | **Projet** | Fil d’Ariane, carte, **cartes parcelles**, « Voir plus », bas de page « Finaliser avec un expert » / « Contacter nous ». |
| `/project/:projectId/plot/:plotId` | **Parcelle** | Détail parcelle, santé (rapport manuel si renseigné), composition du verger, « Voir le rapport » / « Contacter nous ». |
| `/project/:id/visite` | **Rendez-vous de visite** | Formulaire (localisation/état, date/créneau) ; enregistrement une **demande de visite** ; redirection succès. |
| `/project/:id/visite/success` | **Succès visite** | Message de confirmation, lien vers le dashboard. |
| `/dashboard` | **Portfolio investisseur** | Accueil, KPIs, synthèse investissement, **prochain paiement** (données facilités), blocs parrainage (présentation), onglets **Mes facilités** / **Mes parcelles**, lien texte **Se déconnecter**. |
| `/installments` | **Échéances** | Liste des plans ou détail d’un plan ; **Payer** → modale reçu (fichier, photo, aperçu image, note). |
| `/login`, `/register`, `/forgot-password`, `/reset-password` | **Auth** | Parcours mock puis redirection (ex. `/browse`). |
| `/admin` | **Admin** | Console à onglets (voir §5). `/owner` redirige vers `/admin`. |
| `*` | **Fallback** | Redirection vers `/browse`. |

**Legacy :** `/project/:id/mandat` → `/project/:id/visite`.

---

## 4. Routes & pages — admin (implémentation actuelle)

### `/admin` — `AdminDashboard`

Onglets :

1. **Reçus** — file de **reçus** (mock dans l’état React) : statuts soumis / approuvé / rejeté, actions approuver / rejeter avec motif, compteurs KPI.
2. **Vendre parcelle** — affectation vente : **client** (sélection ou création rapide), **projet**, **parcelle**, **comptant vs facilité**, **offre** (par projet, magasin `offersStore` + données `mockOffersByProject`), araboun ; enregistrement vente en mémoire (état local).
3. **Rendez-vous** — file des demandes **`visitRequestsStore`** ; mise à jour du statut (nouveau, contacté, planifié, etc.).
4. **Rapports santé** — par **projet + parcelle** : saisie manuelle des indicateurs (santé arbre, humidité, nutriments, CO₂, arrosage, drone, action suivante) ; persistance **`healthReportsStore`** (affichée côté **Parcelle**).
5. **Mes ventes** — historique des ventes saisies dans l’admin.

Badge de rôle : « Administrateur — Accès limité ». Même **TopBar** que le reste de l’app (sans icône logout dans le header).

---

## 5. Couche “données” côté client (important pour les workflows)

| Fichier / module | Rôle |
|------------------|------|
| `projects.js` | Référentiel **projets / parcelles** (cartes, prix, arbres…). |
| `portfolio.js` | **`myPurchases`** — parcelles possédées (mock) pour le dashboard investisseur. |
| `adminData.js` | **Utilisateurs, reçus, ventes, offres par projet** (mock + compatibilité). |
| `installmentsStore.js` | **Plans de facilités** (`localStorage`) — prochain paiement, tableau échéances, modale paiement. |
| `visitRequestsStore.js` | **Demandes de rendez-vous** depuis le formulaire visite → admin. |
| `healthReportsStore.js` | **Rapports santé manuels** par parcelle → admin + page parcelle. |
| `offersStore.js` | **Offres de facilité par projet** pour l’admin. |

---

## 6. Concepts transverses (pour schémas de workflow)

- Catalogue : **Projet → Parcelles → Fiche parcelle** (disponibilité, prix, médias).
- **Facilités :** échéances, montants, états (en attente, soumis, en révision, approuvé, rejeté), preuve (fichier / photo), note utilisateur.
- **Rendez-vous de visite :** demande → traitement → statuts finaux.
- **Rapports santé (manuel)** : clé projet + parcelle, cohérence avec la fiche publique.
- **Offres** : règles par projet (avance %, durée → mensualité).
- **Vente** : lien client + parcelle + type de paiement + offre.

---

## 7. Écarts à combler pour un admin “réel”

- Les **reçus** saisis par l’investisseur dans **`InstallmentsPage`** (`installmentsStore`) ne sont **pas** la même file que l’onglet **Reçus** admin (mock séparé). Un produit abouti doit **unifier** la queue (même identifiants : utilisateur, plan, mois, fichier, statut).
- **Sessions / rôles** : pas d’auth serveur ; l’URL `/admin` n’est pas protégée.
- **Notifications** : non fonctionnelles.
- **Parrainage / portefeuille** sur le dashboard investisseur : surtout **présentation**, peu ou pas de persistance métier.

---

## 8. Livrables attendus du prestataire / équipe design

1. **Architecture informationnelle admin** (écrans) : tableau de bord, files d’attente, catalogue, clients, finance, contenu (santé), paramètres (offres, rôles).
2. **Diagrammes de workflow** : preuve de paiement ; visite ; vente parcelle ; mise à jour rapport santé ; modification d’offre.
3. **Modèle de données** : entités + statuts (User, Project, Plot, Sale, Plan, Payment, Receipt, VisitRequest, HealthReport, Offer…).
4. **Modèle de permissions** (admin, commercial, terrain, lecture seule, etc.).

---

*Document généré à partir du dépôt « WEBAPP ZITOUNA » — à jour avec la suppression de l’icône de déconnexion dans le header ; déconnexion investisseur via la page Portfolio.*
