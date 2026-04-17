# Sell Page - Workflow and Copy Spec

This document is a design handoff for the Sell page (`/admin/sell`) so a UI/UX designer can redesign it without changing business logic.

## 1) Purpose

The Sell page is used by commercial/admin users to:

- create a new sale
- edit an existing sale
- move a sale through workflow statuses
- cancel eligible sales
- quickly review today activity and all sales

Business logic must stay unchanged.

## 2) Global Page Structure

The page has 2 tabs:

- `Terrain` (field view / quick creation + today cards)
- `Toutes les ventes` (catalog/list view)

Shared top-level elements:

- Back button (global admin back behavior)
- Header with current user info
- KPI wallet card ("Acomptes encaisses aujourd'hui")
- Main CTA button ("Nouvelle vente")
- Bottom tab navigation (Terrain / Toutes les ventes)

## 3) User Roles and Visibility Rules

- Agent:
  - sees only own sales in list/cards (`sale.agentId === adminUser.id`)
  - can cancel only statuses: `draft`, `pending_finance`
  - cannot perform workflow advance actions
- Other commercial/admin roles:
  - see all sales
  - can perform workflow advance actions
  - can cancel according to existing button rules

## 4) Sale Workflow Status Model

Status map:

- `draft` -> label: `Brouillon`
- `pending_finance` -> label: `En attente finance`
- `pending_legal` -> label: `En attente notaire`
- `active` -> label: `Actif`
- `completed` -> label: `Termine`
- `cancelled` -> label: `Annule`
- `rejected` -> label: `Refuse`

Transitions:

- `draft` -> `pending_finance`
- `pending_finance` -> `pending_legal`
- `pending_legal` -> `active` (or final completion logic for full payment)

Advance button labels:

- From `draft`: `Envoyer a la finance`
- From `pending_finance`: `Confirmer le paiement et envoyer au notaire`
- From `pending_legal`: `Finaliser le contrat`

## 5) "Terrain" Tab - Copy Inventory

### Header area

- User display name
- Role/city line: `Agent commercial` / `Responsable commercial` / `Equipe commerciale`
- Notification button (icon-only)

### KPI Wallet Card

- Label: `Acomptes encaisses aujourd'hui`
- Value: `X TND`
- Caption: `N dossier(s) cree(s) aujourd'hui (hors annules)`

### Primary CTA

- Title: `Nouvelle vente sur le terrain`
- Subtitle: `Projet, parcelles, client, acompte, mode de paiement`

### Section title

- `Creees aujourd'hui`

### Empty states

- If no sales today:
  - `Aucune vente enregistree aujourd'hui. Le bouton vert ouvre le formulaire complet.`

### Today sale cards (per sale)

Display fields:

- Client initials + `clientName`
- Parcel count + optional total area
- Optional prepayment badges:
  - arabon amount
  - avance caisse amount
- Status hint line:
  - `Vente cloturee`
  - `Contrat actif - echeancier en cours`
  - `A traiter par la finance (caisse)`
  - `Chez le notaire - signature`
  - `Brouillon - completer la vente`
  - fallback: status label
- Sale code/reference

## 6) "Toutes les ventes" Tab - Copy Inventory

### Header

- `Toutes les ventes`

### Mini stats

- `Total`
- `Actives`
- `Comptant`
- `Echelon`

### Revenue helper

- `CA confirme : X TND`

### Filters/search

- Search placeholder: `Rechercher...`
- Status select default: `Statuts`

### List empty states

- If no sales in system:
  - `Aucune vente. Utilisez le bouton vert pour creer une vente (projet, parcelles, client, acompte).`
- If filtered list empty:
  - `Aucun resultat - modifiez la recherche ou le filtre.`

### Row actions

- Advance action label from status map
- Cancel action: `Annuler`

## 7) Sale Drawer Wizard - Functional Steps (6)

Drawer title:

- Create: `Nouvelle vente`
- Edit: `Modifier la vente`

Drawer subtitle (edit): `Mettre a jour le dossier et les montants.`

Step count:

- `Etape X sur 6`

Step labels:

1. `Projet`
2. `Parcelles`
3. `Client`
4. `Arabon terrain`
5. `Mode & offre`
6. `Notes et envoi`

Navigation buttons:

- Back: `Retour`
- Next: `Continuer`
- Cancel (final step): `Annuler`
- Final submit:
  - Edit: `Enregistrer`
  - Create: `Creer la vente (N parcelle(s))`

### Step 1 - Project

- Field label: `Projet`
- Select placeholder: `Choisir un projet...`
- Option format: `<Project title> - <City>`

Validation on next:

- Toast: `Choisissez un projet.`

### Step 2 - Parcelles

- Grid of parcel number boxes only
- Box states:
  - available
  - selected
  - unavailable (taken/reserved/sold)

Unavailable click toast:

- `Cette parcelle est indisponible (reservee, vendue ou liee a une vente non brouillon).`

Validation on next:

- `Selectionnez au moins une parcelle.`

### Step 3 - Client

- Label: `Client - recherche par telephone`
- Input placeholder: `Saisir telephone...`
- Secondary button: `+ Nouveau`

Found state:

- Success chip with client identity and `OK`

Not found state:

- `Aucun client avec ce telephone`
- `Utilisez "Nouveau" pour creer une fiche`

Validation on next:

- `Identifiez le client par telephone ou creez une fiche.`

### Step 4 - Arabon

- Label: `العربون - versement terrain (TND)`
- Numeric input placeholder: `ex. 500`

### Step 5 - Mode & Offre

- Label: `Mode de paiement`
- Cards:
  - `Comptant` + hint `Montant total en especes`
  - `Echelonne` + hint `Acompte + mensualites`

Offer select (installments):

- Label: `Offre de paiement`
- Placeholder: `Choisir une offre...`
- Option format: `<name> - <price>, <downPayment>% acompte, <duration> mois`

No offers warning:

- `Aucune offre pour ce projet - passez en comptant ou configurez les offres.`

Installment financial recap block:

- `Detail des echeances - N parcelle(s)`
- `Prix convenu`
- `1er versement (%)`
- `Reste`
- `Mensualite`
- optional prepaid deductions:
  - `العربون (terrain)`
  - `Avance caisse`
- final line:
  - `Solde a encaisser (finance)`

Full payment recap block:

- `Resume comptant - N parcelle(s)`
- `Montant total`
- same optional prepaid deductions
- `Solde a encaisser (finance)`

Validations on next:

- If installments and no offer selected:
  - `Choisissez une offre de paiement ou passez en comptant.`
- If installments and project has no offers:
  - `Aucune offre pour ce projet : passez en comptant ou configurez les offres.`

### Step 6 - Notes and Send

Main sections in recap:

- `Suivi & horodatage`
- `Commercial (vendeur)`
- `Client`
- `Parrainage (automatique)`
- `Projet & parcelles`
- `Offre & encaissements`

Parrainage helper text:

- `Deduit de la fiche client (parrain enregistre). Plus d'etape manuelle compte vendeur.`

Important totals:

- `Prix convenu`
- `العربون (terrain)`
- `Solde a encaisser (finance)`

Notes field:

- Label: `Notes internes`
- Placeholder: `Notes internes...`

## 8) Client Creation Modal (from Step 3)

Title:

- `Nouveau client`

Fields:

- `Nom complet *`
- `CIN (optionnel)`
- `Telephone *`
- `E-mail`
- `Ville`

Actions:

- `Annuler`
- `Creer le client`
- loading: `Creation...`

Validation to create:

- name required
- phone required

Toasts:

- `Le nom est obligatoire`
- `Le telephone est obligatoire`
- `Client deja existant (telephone) - selectionne automatiquement`
- `Client cree`

## 9) Action Confirmation Modals

### Cancel modal

- Title: `Annuler la vente`
- Body:
  - `Annuler la vente de ... pour <client> ?`
  - warning that parcel(s) become available again
- Buttons:
  - `Conserver`
  - `Annuler la vente`

### Advance modal

- Title: `Faire avancer la vente`
- Shows next transition and consequences.
- Buttons:
  - `Annuler`
  - `✓ <next action label>`

## 10) Submission and Error Messages

Create/edit success:

- Edit: `Vente mise a jour`
- Create: `Vente creee - N parcelle(s)`

Save blocking/error toasts:

- `Prix convenu invalide : verifiez les parcelles et l'offre.`
- `L'acompte terrain et l'avance encaissee ne peuvent pas depasser le prix convenu.`
- `Projet, client ou parcelles : ne peuvent plus etre modifies apres transmission a la finance ou au notaire.`
- Duplicate/reservation conflict:
  - `Une ou plusieurs parcelles sont deja liees a une vente en cours. La liste a ete actualisee.`

Workflow actions:

- Finance -> legal:
  - `Dossier transmis au notaire : <client>`
- Full payment completion:
  - `Paiement confirme - vente terminee`
- Installments activation:
  - `Vente activee - echeancier cree`
- Generic status update:
  - `Statut mis a jour : <label>`
- Cancel done:
  - `Vente annulee`

## 11) Non-negotiable Logic Constraints for Designers

Designer can change layout/visual hierarchy/copy tone, but must keep:

- 6-step wizard structure and validations
- role behavior (Agent restrictions)
- status transition rules
- parcel availability logic
- automatic parrain attribution from buyer client record
- financial recap calculations and final `Solde a encaisser (finance)` semantics

## 12) Recommended Deliverables From Designer

Ask designer to provide:

- full mobile-first screen set (Terrain tab, List tab, all 6 wizard steps, modals)
- component states (default, hover, active, disabled, error, loading, empty)
- spacing/type/color tokens
- responsive behavior notes (small phone, normal phone, tablet)
- exact copy replacements (if they want revised wording)

Then implementation can be done 1:1 in code without business logic changes.

