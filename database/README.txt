ZITOUNA — database (PostgreSQL / Supabase)

==============================================================================
RECOMMENDED FLOW
==============================================================================

INITIAL SETUP (run ONCE on a fresh Supabase project, in this exact order):

  In the SQL Editor, each step is a separate run. Paste the file and press
  "Run". Steps 1 and 2 must be pasted into the SAME SQL editor tab so the
  session-scoped guard token carries across.

  1) SET app.allow_destructive_reset = 'I_UNDERSTAND_THIS_WIPES_DATA';
  2) database/dev/01_reset_full.sql
  3) database/02_schema.sql
  4) database/03_functions.sql
  5) database/04_rls.sql
  6) database/07_hardening.sql
  7) database/08_notifications.sql
  8) database/06_seed_dev.sql     ← this seeds data + creates login accounts


DAILY DEVELOPMENT RESET (ONE FILE — wipes data, keeps schema):

  1) SET app.allow_destructive_reset = 'I_UNDERSTAND_THIS_WIPES_DATA';
  2) database/06_seed_dev.sql

`06_seed_dev.sql` does everything needed for daily dev:
  - wipes auth + business + catalog data
  - seeds 4 projects
  - seeds 20 parcels per project (80 parcels total)
  - seeds offers + visit slot options
  - creates 2 SUPER_ADMIN login accounts


==============================================================================
LOGIN CREDENTIALS (after 06_seed_dev.sql)
==============================================================================

Password for BOTH accounts: 123456

  lassad@gmail.com   SUPER_ADMIN
  saif@gmail.com     SUPER_ADMIN

Note: Supabase enforces a minimum password length (default 6 chars)
on sign-in, not just sign-up. An earlier version of this seed used
"13456" (5 chars) and sign-in failed with "Invalid login credentials"
even when the row existed. If you want a different password, either
keep it 6+ chars, or lower the minimum in:
Authentication → Providers → Email → Password policy.


==============================================================================
File index
==============================================================================

  dev/01_reset_full.sql            DEV ONLY — full wipe, guard-gated
  dev/01b_reset_keep_accounts.sql  DEV ONLY — data wipe, keep accounts, guard-gated
  02_schema.sql                    REQUIRED — tables, enums, indexes, constraints, touch triggers
  03_functions.sql                 REQUIRED — helpers, RPCs, autolink + sale-invariant triggers
  04_rls.sql                       REQUIRED — RLS policies (staff + delegated seller)
  05_seed.sql                      legacy optional catalogue seed (kept for compatibility)
  06_seed_dev.sql                  PRIMARY DEV SCRIPT (reset + seed in one run)
  07_hardening.sql                 REQUIRED — consolidated hardening:
                                   (A) RLS perf patch
                                   (B) per-table grants, catalog views, lookup RPC, MFA
                                   (C) status/money CHECKs, FKs, commission audit,
                                       plan_status 'cancelled', audit retention
                                   (D) commission model v2: sale-based pyramid,
                                       link at notary completion, reverse-sale guard
                                   (E) parcels.label (text ID like "a1", "A-42") +
                                       project_offers.mode/cash_amount/price_per_sqm
                                   (F) sales.client_{name,phone,cin,email,city}_snapshot
                                       + BEFORE trigger → historical buyer label
                                       survives RLS filtering and buyer deletion
  08_notifications.sql             REQUIRED — notifications infra: triggers, scans,
                                   channels catalog, prefs, outbox (SMS/email/push-ready)
  09_one_shot_recovery.sql         OPTIONAL — auth↔client recovery, guard-gated, one-shot


==============================================================================
What gets seeded
==============================================================================

Projects (4):
  tunis   — Projet Olivier — La Marsa        parcels 101..120
  sousse  — Projet Olivier — El Kantaoui     parcels 201..220
  sfax    — Projet Olivier — Thyna           parcels 301..320
  nabeul  — Projet Olivier — Hammamet        parcels 401..420

Each project has:
  - 20 parcels, status='available', seeded with area / trees / total price
  - one tree batch per parcel (current year)
  - workflow settings (48h reservation, 5%/2% fees, 100 TND payout threshold)
  - checklist items (contract / cahier / seller_contract)
  - commission rules (L1 60%, L2 20%)

Offers (5 across projects):
  tunis  — Standard 72 000 TND / 20% / 24 mois
  tunis  — Confort  85 000 TND / 15% / 36 mois
  sousse — Premium 112 500 TND / 10% / 60 mois
  sfax   — Classique 55 000 TND / 25% / 18 mois
  nabeul — Standard 78 000 TND / 20% / 24 mois

Visit slots: 09-11h, 11-13h, 14-16h, 16-18h.


==============================================================================
Recovery (one-shot auto-link by phone/email, only if needed)
==============================================================================

  SET app.allow_one_shot_recovery = 'I_UNDERSTAND';
  -- paste: database/09_one_shot_recovery.sql


==============================================================================
Notification scans (pg_cron auto-wired when available)
==============================================================================

Fallback manual trigger:
  SELECT public.run_notification_scans();

Enabling a channel later (SMS / email / push):
  1. UPDATE public.notification_channels SET enabled=true WHERE channel_key='sms';
  2. Deploy a worker (edge function) that reads notification_outbox WHERE
     status='pending' AND channel_key='sms' AND next_attempt_at <= now().
  3. Worker resolves the target, calls the provider, UPDATEs status.
  No app or trigger changes needed.


==============================================================================
Notes
==============================================================================

- Scripts check prerequisites and refuse to run if the prior step is missing.
- Every function/policy uses CREATE OR REPLACE / DROP IF EXISTS — safe to re-run.
- Storage buckets are NOT touched by any script; clear them from the Supabase
  dashboard (Storage → bucket → delete files) if you want a truly fresh start.
- The destructive-reset safety token is session-scoped: it only holds for the
  current SQL editor tab. Closing the tab resets it — another layer of
  protection.
- Parcel labels + offer payment modes (Section E of 07_hardening.sql) are
  defensive at the app layer too: db.js retries on 42703 `undefined_column`
  errors, so the UI won't crash if 07_hardening is missed.
- Buyer snapshot on sales (Section F of 07_hardening.sql) removes the empty
  "Nom" field in Coordination/Finance/Legal when RLS hides the joined client,
  and preserves the historical buyer label if the client row is deleted.
