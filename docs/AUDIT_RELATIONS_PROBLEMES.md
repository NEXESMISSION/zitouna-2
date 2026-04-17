# Audit — Problèmes de relations (auth ↔ client ↔ sale ↔ commission)

> Livrable d'audit : inventaire priorisé des ruptures d'intégrité relationnelle.
> **Aucun correctif proposé.** Chaque entrée = zone · symptôme · cause probable · impact.

Chaîne critique auditée :
`auth.users.id → clients.auth_user_id → clients.id → sales.client_id / sales.seller_client_id → commission_events.beneficiary_client_id → wallet / payout`

---

## 🔴 CRITIQUE

### C1 — `clients.auth_user_id` sans contrainte d'unicité, `current_client_id()` non déterministe
- **Zone** : `database/02_schema.sql:187,203` · `database/03_functions.sql:36-46` · `src/lib/db.js:1212`
- **Symptôme** : un même utilisateur auth peut voir deux soldes différents d'un refresh à l'autre, ou voir des ventes appartenant à un autre `clients` rattaché au même `auth_user_id`.
- **Cause probable** : la colonne est seulement indexée (`create index idx_clients_auth_user ... where auth_user_id is not null`), pas `unique`. `current_client_id()` fait `select ... where auth_user_id = auth.uid() limit 1` **sans `ORDER BY`**. Le résultat dépend de l'ordre de scan (index / heap / vacuum) — non stable.
- **Impact métier** : toutes les requêtes RLS en aval (`sales`, `installment_plans`, `commission_events`, `page_access_grants`) se résolvent contre un `clients.id` potentiellement différent d'une session à l'autre → données qui « disparaissent » ou qui basculent.

### C2 — Auto-heal incomplet : `commission_events.beneficiary_client_id` jamais migré lors d'un rebind
- **Zone** : `database/03_functions.sql:168-259` · `database/02_schema.sql:441-442` (`on delete restrict`) · `src/lib/db.js` (aucune migration de ce champ)
- **Symptôme** : après rattachement tardif d'un `auth.users` à un nouveau `clients` (stub pré-signup remplacé), les gains de parrainage « disparaissent » du portefeuille même si la vente, le plan et les accès de page, eux, suivent.
- **Cause probable** : `ensure_current_client_profile()` repointe explicitement `sales.client_id`, `installment_plans.client_id` et `page_access_grants.client_id` vers le nouveau `v_client_id`, mais **ignore** `commission_events.beneficiary_client_id`. La FK est `on delete restrict`, donc toute tentative ultérieure de merge/suppression du stub échoue en dur.
- **Impact métier** : commissions orphelines, invisibles dans le dashboard (RLS filtre par `beneficiary_client_id = current_client_id()`), et impossibles à retirer. Risque de payout légitimement dû mais non visible.

### C3 — Création de commissions dépendante d'un seul point applicatif (pas de garde-fou DB)
- **Zone** : `src/lib/db.js:1451` (`insertCommissionEventsForCompletedSale`) · `src/admin/pages/NotaryDashboardPage.jsx:257` · `database/02_schema.sql` (aucun trigger sur `sales`)
- **Symptôme** : des ventes marquées `notary_completed_at` existent sans aucune ligne dans `commission_events`.
- **Cause probable** : la génération n'est déclenchée que depuis l'UI notaire. Crash front, perte de réseau entre la réponse et la finalisation, ou finalisation via un chemin alternatif (script SQL, mobile, batch) = commissions non créées, aucune trace.
- **Impact métier** : manque à gagner silencieux pour les parrains / ambassadeurs ; aucune alerte opérationnelle.

### C4 — Attribution L1 retombe sur l'acheteur si `seller_client_id` est NULL
- **Zone** : `src/lib/db.js:1320` (`let walkId = sale.sellerClientId || sale.clientId`) · `src/lib/db.js:1335`
- **Symptôme** : un acheteur apparaît comme bénéficiaire de sa propre vente ; si l'acheteur est lui-même rattaché à une `seller_relations`, son upline remonte la commission à son propre parrain.
- **Cause probable** : fallback `|| sale.clientId` câblé dans le walker d'upline. Aucune contrainte empêche `seller_client_id IS NULL` pour une vente directe staff-saisie.
- **Impact métier** : portefeuilles gonflés artificiellement, payouts sur des bases discutables, conflit de rôles acheteur/vendeur non vérifiable.

### C5 — Rattachement par téléphone peut « voler » ou « perdre » des ventes entre comptes
- **Zone** : `database/03_functions.sql:168-220` · `src/lib/AuthContext.jsx:66-77`
- **Symptôme** : deux utilisateurs partageant un téléphone (saisie, famille, ancien numéro recyclé) se voient attribuer les mêmes ventes ; un utilisateur qui change de téléphone voit ses ventes disparaître.
- **Cause probable** : `ensure_current_client_profile()` se rejoue à chaque résolution de session, re-match les ventes par `phone_canonical`, sans verrou ni contrainte `sales.client_id` unique par téléphone. Pas de détection "déjà rattaché à un autre auth_user".
- **Impact métier** : fuite de données entre utilisateurs, risque RGPD/confidentialité, ventes invisibles pour le propriétaire légitime.

### C6 — RPC `get_my_referral_summary()` masque les erreurs d'attribution par des zéros
- **Zone** : `database/03_functions.sql:314-407` · `src/lib/db.js:3087-3105` · `src/pages/DashboardPage.jsx:821-860`
- **Symptôme** : dashboard affiche `0 DT` sur le portefeuille, le crédit légal et les gains, sans distinction entre "rien gagné" et "commissions attachées au mauvais client".
- **Cause probable** : RPC `SECURITY DEFINER` qui renvoie des champs numériques à zéro quand `current_client_id()` est NULL ou pointe sur un mauvais client. Le front coalesce (`?? 0`) et affiche. Aucune vérification "ce `clients.id` est-il l'unique pour cet auth_user ?".
- **Impact métier** : l'utilisateur et le support ne peuvent pas distinguer un problème d'attribution d'un état nominal ; pertes silencieuses.

---

## 🟠 ÉLEVÉ

### H1 — Rebinding non atomique (read-then-write) + double INSERT possible
- **Zone** : `src/lib/db.js:686-691` (`upsertClient` : SELECT puis UPDATE séparés) · `database/03_functions.sql:99-129` (RPC enchaînant UPDATE → SELECT → INSERT `ON CONFLICT DO UPDATE` sans verrou explicite)
- **Symptôme** : deux `clients` créés pour un même utilisateur dans un intervalle court (re-login rapide, double onglet, flow register→auto-login).
- **Cause probable** : pas de transaction sérialisable ni de lock avisé ; entre le `SELECT` et l'`INSERT`, deux sessions peuvent toutes deux ne pas voir de client existant et insérer chacune leur ligne.
- **Impact métier** : graine du problème C1 ; se matérialise en doublons `clients`.

### H2 — Idempotence bloquant la régénération après mauvaise attribution initiale
- **Zone** : `src/lib/db.js:1453-1455` (`select id from commission_events where sale_id = X; if rows return []`)
- **Symptôme** : l'admin corrige `seller_relations` après coup → rejoue la finalisation notaire → rien ne se passe, les commissions restent fausses.
- **Cause probable** : le garde regarde uniquement l'existence de lignes pour `sale_id`, pas leur exactitude. Pas de `ON CONFLICT DO UPDATE`, pas de contrainte `unique (sale_id, beneficiary_client_id, level)`, pas de fonction de réconciliation exposée.
- **Impact métier** : aucune voie de récupération sans chirurgie SQL manuelle ; audit trail des re-tentatives inexistant.

### H3 — Dérive `client_phone_identities` ↔ `clients` (COALESCE préserve l'ancien lien)
- **Zone** : `src/lib/db.js:732-808` (`||` préservant l'existant) · `database/03_functions.sql:140-149` (`ON CONFLICT ... DO UPDATE SET client_id = coalesce(existing, excluded)`)
- **Symptôme** : un numéro recyclé continue de pointer sur l'ancien `clients` ; modification du téléphone d'un profil laisse l'ancienne ligne orpheline.
- **Cause probable** : logique "ne jamais écraser l'ancienne valeur" côté SQL et JS. Pas de suppression ni d'invalidation des anciennes lignes `client_phone_identities`.
- **Impact métier** : cross-contamination entre profils, renforce C5.

### H4 — `auth_user_id` non lié au démarrage : données inaccessibles
- **Zone** : `src/lib/AuthContext.jsx:177-182,291-305` · `database/04_rls.sql:147-150`
- **Symptôme** : écran "Profil introuvable" ou dashboard vide si `upsertClient()` asynchrone échoue/retarde ; déconnexion forcée si la RPC de récupération échoue.
- **Cause probable** : chemin critique sans retry robuste ni file d'attente ; RLS qui renvoie zéro ligne dès que `current_client_id()` est NULL, aucune distinction erreur/vide.
- **Impact métier** : utilisateur légitime bloqué au login ou sur dashboard vide pendant une fenêtre transitoire.

### H5 — Notifications ciblées par `auth.users.id`, commission portée par `clients.id` ≠
- **Zone** : `database/02_schema.sql:598-607` · `database/04_rls.sql:467-474`
- **Symptôme** : l'utilisateur reçoit "Commission créditée" en notification mais ne voit rien dans son portefeuille.
- **Cause probable** : clé de notification = auth user ; commission = `beneficiary_client_id`. En présence de doublons `clients` (C1) ou de commission non migrée (C2), les deux divergent.
- **Impact métier** : perte de confiance côté utilisateur, tickets support répétitifs, zéro info diagnostic.

### H6 — KPI "0 DT" indistinguable d'une erreur d'attribution
- **Zone** : `src/pages/DashboardPage.jsx:194-206, 821-860`
- **Symptôme** : cartes KPI (Disponible / En attente / Crédit légal) affichent `0 DT` indépendamment de la cause.
- **Cause probable** : UI ne branche que sur `referralSummary.ok`. Quand `ok = true` mais la somme est en réalité calculée sur un mauvais `clients.id`, aucune bannière n'est affichée. Aucune distinction visuelle (`—`, tooltip, état "inconnu").
- **Impact métier** : masque les cas C1/C2/C6 aux yeux de l'utilisateur final.

---

## 🟡 MOYEN

### M1 — Statut `pending` mort : `gainsAccrued` toujours à 0
- **Zone** : `src/lib/db.js:1476` (`status: 'payable'` à l'INSERT) · `database/03_functions.sql:353` (agrégation `gainsAccrued` filtrée par `status = 'pending'`) · `database/02_schema.sql:42` (enum contient `pending`)
- **Symptôme** : la carte "Gains en attente" affiche toujours 0 DT.
- **Cause probable** : écart entre l'enum schéma et l'usage réel (aucune ligne n'est jamais insérée en `pending`). Soit l'agrégation doit viser `payable`, soit le flux doit passer par `pending` puis transition.
- **Impact métier** : KPI mensonger / sémantique brouillée ; audibilité du cycle de vie commission affaiblie.

### M2 — Seuil de payout = MAX des projets, hétérogénéité bloquante
- **Zone** : `src/lib/db.js:1433-1448,1627` · `database/03_functions.sql:379-382`
- **Symptôme** : utilisateur voit `walletBalance: 250`, `minPayoutAmount: 300`, bouton payout désactivé, pas d'explication.
- **Cause probable** : sur un portefeuille multi-projets, le seuil retenu est le MAX, pas un seuil par lot ni une moyenne pondérée.
- **Impact métier** : commissions coincées sous seuil agrégé ; UX de blocage sans cause affichée.

### M3 — Comptes hybrides admin / client : résolution admin-first masque le dashboard acheteur
- **Zone** : `src/lib/AuthContext.jsx:49-60,152-157`
- **Symptôme** : une personne qui est à la fois staff et acheteur ne voit jamais son portefeuille parrainage.
- **Cause probable** : `resolveProfiles()` interroge `admin_users` en premier et sort tôt ; `clientProfile` reste `null`. Pas de mode "les deux".
- **Impact métier** : frustration, demandes de double compte, risque de fraude si contournement par email alternatif.

### M4 — Vente directe : vendeur ≠ acheteur non contraint ; upline appliquée malgré tout
- **Zone** : `src/admin/pages/SellPage.jsx:741-863` · `src/lib/db.js:1312-1376`
- **Symptôme** : un staff-vendeur qui achète ailleurs peut collecter des commissions sur ses propres ventes via une upline partagée.
- **Cause probable** : aucune contrainte DB `seller_client_id <> client_id`, et pas de filtre côté walker.
- **Impact métier** : conflit de rôles, risque conformité/audit.

### M5 — Message "Profil en cours de rattachement" sans diagnostic
- **Zone** : `src/pages/DashboardPage.jsx:803-817` · `src/lib/AuthContext.jsx:63-76,396-397`
- **Symptôme** : tous les cas (pas de client, doublon client, RLS deny, erreur réseau, téléphone en conflit) tombent sur le même texte "synchronisation en cours".
- **Cause probable** : le champ `__profileError.code` existe côté JS mais n'est ni propagé ni branché dans l'UI ; la RPC `get_my_referral_summary` prévoit `reason: 'ambiguous_client_profile'` mais ne détecte jamais les doublons.
- **Impact métier** : boucle "réessayer" infinie, escalade support sans signal exploitable.

---

## 🟢 FAIBLE

### L1 — `ambassador_wallets` défini mais non alimenté — pas de garantie transactionnelle entre commission et payout
- **Zone** : `database/02_schema.sql:266-270` · `database/03_functions.sql:360-371` · `src/lib/db.js:508-530,1620`
- **Symptôme** : le solde est recalculé à la volée à chaque appel ; si un `commission_payout_request_items` est supprimé hors workflow, la commission redevient "libre" sans audit.
- **Cause probable** : pas de trigger `commission_events → ambassador_wallets` ; la table `ambassador_wallets` est morte. Pas de transaction "payout = INSERT request + lock events".
- **Impact métier** : aujourd'hui correct en lecture, mais fragile face à toute manipulation directe SQL ou workflow "rejeté → re-soumis".

---

## Notes transversales

- **Invariant manquant** : aucune garantie DB que `(auth.users.id → clients.id)` soit 1:1. C'est la racine commune de C1, C2, C5, C6, H1, H5.
- **Génération de commission** : repose sur un unique chemin applicatif (C3) et un garde idempotent trop strict (H2). Le couple est fragile.
- **RLS + RPCs SECURITY DEFINER** : les RPCs masquent les erreurs d'attribution en retournant des zéros (C6) ; RLS masque par filtrage silencieux (C1). Aucun des deux ne produit de signal d'erreur exploitable.
- **Observabilité** : zéro diagnostic UI, zéro alerte côté admin sur "sale finalisée sans commission", zéro health check "clients dupliqués par auth_user_id".

---

## Matrice récapitulative

| Id | Titre                                                          | Sévérité | Type de cause         |
| -- | -------------------------------------------------------------- | -------- | --------------------- |
| C1 | Unicité `auth_user_id` manquante + résolution non déterministe | Critique | Schéma                |
| C2 | Auto-heal omettant `commission_events`                         | Critique | Logique SQL           |
| C3 | Commission 100% applicative, pas de trigger DB                 | Critique | Architecture          |
| C4 | L1 retombe sur l'acheteur                                      | Critique | Logique applicative   |
| C5 | Rattachement téléphone fuite / vole des ventes                 | Critique | Logique SQL           |
| C6 | RPC renvoie 0 par défaut — masque l'attribution                | Critique | Contrat RPC           |
| H1 | Rebinding non atomique — race de doublons                      | Élevée   | Concurrence           |
| H2 | Idempotence trop stricte bloque re-attribution                 | Élevée   | Logique applicative   |
| H3 | Dérive `client_phone_identities` (COALESCE)                    | Élevée   | Logique d'upsert      |
| H4 | `current_client_id` NULL au boot = dashboard vide              | Élevée   | Chemin critique       |
| H5 | Notification sur auth user, commission sur client ≠            | Élevée   | Découplage de clés    |
| H6 | KPI "0 DT" indistinguable d'une erreur                         | Élevée   | UI / observabilité    |
| M1 | Statut `pending` mort                                          | Moyenne  | Cycle de vie          |
| M2 | Seuil payout = MAX multi-projets                               | Moyenne  | Règle métier          |
| M3 | Comptes hybrides admin/client — admin gagne                    | Moyenne  | Logique de résolution |
| M4 | Vente directe : vendeur = acheteur non contraint               | Moyenne  | Contrainte manquante  |
| M5 | Message de rattachement non diagnostique                       | Moyenne  | UX                    |
| L1 | `ambassador_wallets` mort, pas de garantie transactionnelle    | Faible   | Dette architecturale  |

---

Fin du livrable d'audit. Aucun correctif proposé — la prochaine phase devra traiter ces éléments dans l'ordre (C → H → M → L) avec leurs migrations, contraintes et tests dédiés.
