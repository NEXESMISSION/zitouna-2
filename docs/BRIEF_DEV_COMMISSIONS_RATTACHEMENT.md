# Brief dev — Inscription, rattachement client & portefeuille parrainage

> Ce document **décrit les problèmes et les résultats attendus**. Il ne prescrit pas la solution.
> L'implémentation est à la discrétion du dev — mais les critères d'acceptation doivent être atteints.

---

## 1. Contexte observé

### 1.1 Erreur bloquante à l'inscription
À la création de compte, le flux `signUp → upsertClient` peut remonter :

```
duplicate key value violates unique constraint "clients_phone_normalized_key"
```

Chemin du problème : `src/pages/RegisterPage.jsx` → `src/lib/AuthContext.jsx` → `src/lib/db.js` → Supabase/Postgres.

**Effet utilisateur** : l'inscription échoue techniquement ; l'utilisateur reste dans un état partiel (auth créé, client non créé ou non lié).

### 1.2 Dashboard bloqué sur un état "en cours"
Dans `src/pages/DashboardPage.jsx`, la carte Parrainage affiche :

- « **Profil client en cours de rattachement** »
- Bouton « Réessayer » qui ne débloque rien
- KPIs figés sur `0 filleul` / `0 DT`

Ce message revient quelles que soient les causes (profil absent, doublon, RLS, RPC zéro-safe…).

### 1.3 Audit de cohérence relationnelle
Référence : [`docs/AUDIT_RELATIONS_PROBLEMES.md`](./AUDIT_RELATIONS_PROBLEMES.md) — inventaire complet des ruptures auth↔client↔sales↔commissions (6 critiques, 6 élevés, 5 moyens, 1 faible).

---

## 2. Problèmes à traiter (niveau produit)

| # | Problème | Niveau |
|---|---|---|
| A | **Inscription non fiable** — conflit d'unicité téléphone casse le flux d'upsert et la création du profil client. | Bloquant |
| B | **Rattachement client instable** — après signup/login, l'utilisateur peut rester sans `clientProfile` exploitable (boucle "Réessayer"). | Bloquant |
| C | **Portefeuille parrainage non fiable** — affichage à `0 DT` pouvant masquer un défaut de liaison plutôt qu'une vraie absence de gains. | Haut |
| D | **Chaîne relationnelle fragile** — incohérences possibles entre `auth.users.id`, `clients`, `sales`, `commission_events`, payout. | Haut |
| E | **Signalement UX insuffisant** — cas distincts (conflit téléphone, profil ambigu, RLS/RPC, profil manquant) réduits à un message unique. | Moyen |

> **Important** : le comportement attendu ne doit pas se contenter de "ne plus crasher". Il doit être **déterministe** et **traçable**.

---

## 3. Résultats attendus (ce que le dev doit livrer)

### R1 — Inscription robuste
Un utilisateur qui s'inscrit avec un téléphone déjà connu en base obtient un **comportement déterministe** :
- pas de crash technique exposé,
- pas d'état partiellement cassé (auth OK / client KO),
- un résultat clairement l'un des deux : soit rattachement automatique sûr, soit refus explicite avec message adapté.

### R2 — Rattachement fiable
Après inscription ou reconnexion, un utilisateur légitime est **rattaché à un profil client unique et stable**, sans avoir à cliquer « Réessayer » en boucle.

### R3 — Commissions correctes
Le portefeuille parrainage reflète les **bonnes commissions pour le bon client** — les gains ne doivent pas disparaître silencieusement lors d'un rebind tardif, d'un changement de téléphone, ou d'une re-création de profil.

### R4 — Erreurs explicites
Les cas fonctionnels distincts ont **des messages utilisateur et support différenciés et actionnables** :
- téléphone déjà utilisé,
- profil ambigu (plusieurs clients pour un auth),
- profil introuvable,
- erreur technique (RLS / RPC / réseau).

### R5 — Cohérence bout-en-bout
Notifications, solde wallet, demandes de retrait **pointent tous vers la même identité métier**. Pas de notification "commission créditée" pour un wallet qui affiche 0.

---

## 4. Priorisation

- **P0 — à livrer en premier**
  - Corriger le flux inscription/rattachement qui produit l'erreur d'unicité téléphone.
  - Empêcher l'état « session active sans profil » qui bloque le dashboard.

- **P1 — suivant**
  - Garantir la cohérence d'attribution des commissions lors des rebinds tardifs (migration ou re-pointage des `commission_events`).
  - Rendre les états du dashboard **diagnostiques** — distinguer « zéro réel » de « donnée indisponible / mal rattachée ».

- **P2 — consolidation**
  - Traiter les écarts produits listés dans l'audit : cycle de vie `pending/payable`, seuil de payout multi-projets, comptes hybrides admin/client, vente directe vendeur = acheteur.

---

## 5. Critères d'acceptation (à vérifier au moment du recettage)

### CA1 — Inscription avec téléphone existant
Un scénario d'inscription où le téléphone est déjà connu :
- ne produit **plus d'erreur technique bloquante** visible par l'utilisateur,
- se termine dans un état utilisateur **compréhensible** (soit accès normal, soit refus motivé avec marche à suivre),
- ne laisse **jamais** un `auth.users` sans `clients` rattaché ni un `clients` dupliqué sur le même téléphone.

### CA2 — Dashboard stable après inscription
Un utilisateur nouvellement inscrit voit son espace client et sa carte parrainage se charger de manière **stable** — sans osciller entre "en cours de rattachement" et le contenu, sans nécessiter un refresh manuel.

### CA3 — Montants de commissions cohérents
Les montants visibles dans le portefeuille parrainage :
- correspondent à la réalité des ventes éligibles,
- restent **stables après refresh / déconnexion / reconnexion**,
- ne varient pas selon l'ordre d'apparition des lignes en base.

### CA4 — Messages d'erreur différenciés
Les messages d'erreur distinguent les **causes principales** :
- téléphone déjà utilisé,
- profil manquant,
- profil ambigu (doublon),
- erreur technique.

Le message générique unique « profil en cours de rattachement » n'est plus acceptable comme seule sortie.

### CA5 — Signal support
Le support dispose de **signaux suffisants** pour diagnostiquer rapidement un cas de liaison ambiguë :
- log serveur clair avec identifiants (auth_user_id, phone_canonical, client_id candidats),
- trace accessible (audit_logs / console), pas seulement un `console.warn` côté client.

---

## 6. Hors scope de ce ticket

- Refonte visuelle du dashboard parrainage.
- Changement du modèle de commission multi-niveaux.
- Migration vers un autre fournisseur d'auth.

Ces sujets peuvent être évoqués mais ne conditionnent pas la livraison.

---

## 7. Liberté laissée au dev

Le dev choisit l'implémentation : schéma (contraintes `unique`, index partiels, triggers), logique SQL (RPC, fonctions SECURITY DEFINER), logique app (transactions, retries, état d'erreur). Les critères d'acceptation orientent le résultat, **pas la technique**.

En revanche, avant de livrer :
- décrire l'approche retenue en une page,
- indiquer quels items de l'audit sont adressés,
- indiquer ce qui est repoussé en P2 et pourquoi.

---

## 8. Références

- [`src/lib/AuthContext.jsx`](../src/lib/AuthContext.jsx)
- [`src/lib/db.js`](../src/lib/db.js)
- [`src/pages/RegisterPage.jsx`](../src/pages/RegisterPage.jsx)
- [`src/pages/DashboardPage.jsx`](../src/pages/DashboardPage.jsx)
- [`database/02_schema.sql`](../database/02_schema.sql)
- [`database/03_functions.sql`](../database/03_functions.sql)
- [`database/04_rls.sql`](../database/04_rls.sql)
- [`docs/AUDIT_RELATIONS_PROBLEMES.md`](./AUDIT_RELATIONS_PROBLEMES.md)
