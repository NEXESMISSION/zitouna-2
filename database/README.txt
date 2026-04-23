ZITOUNA — database (PostgreSQL / Supabase)

==============================================================================
FULL RESET + SETUP (run ONCE, in this exact order)
==============================================================================

In the Supabase SQL Editor, paste each file as a separate run. Steps 1 and 2
must be in the SAME tab — the safety token is session-scoped.

  1) SET app.allow_destructive_reset = 'I_UNDERSTAND_THIS_WIPES_DATA';
  2) database/dev/01_reset_full.sql    ← wipes auth.users + public schema
  3) database/02_schema.sql            ← tables, enums, indexes, constraints
  4) database/03_functions.sql         ← RPCs, triggers, helpers
  5) database/04_rls.sql               ← row-level security policies
  6) database/07_hardening.sql         ← grants, CHECKs, audit, perf
  7) database/08_notifications.sql     ← notifications infra
  8) database/06_seed_dev.sql          ← dev data + login accounts


==============================================================================
LOGIN CREDENTIALS (after 06_seed_dev.sql)
==============================================================================

Password for BOTH accounts: 123456

  lassad@gmail.com   SUPER_ADMIN
  saif@gmail.com     SUPER_ADMIN

Note: Supabase enforces a 6-char minimum on sign-in. Keep the password 6+ chars
or lower the minimum in Authentication → Providers → Email → Password policy.


==============================================================================
DAILY DEV RESET (one file — wipes data, keeps schema)
==============================================================================

  1) SET app.allow_destructive_reset = 'I_UNDERSTAND_THIS_WIPES_DATA';
  2) database/06_seed_dev.sql

`06_seed_dev.sql` does everything needed for daily dev:
  - wipes auth + business + catalog data
  - seeds 4 projects, 20 parcels per project (80 total)
  - seeds offers + visit slot options
  - creates 2 SUPER_ADMIN login accounts


==============================================================================
File index (7 files — this is the whole pipeline)
==============================================================================

  dev/01_reset_full.sql    DEV ONLY — full wipe, guard-gated
  02_schema.sql            tables, enums, indexes, constraints, touch triggers,
                           phone_change_requests, harvest system tables,
                           project tree/health + address + workflow cadence
  03_functions.sql         helpers, RPCs, autolink + sale-invariant triggers,
                           phone-change RPCs, harvest distribution engine
  04_rls.sql               RLS policies (staff, delegated seller, client),
                           phone-change + harvest policies, public views
  06_seed_dev.sql          reset + seed in one run (primary dev driver)
  07_hardening.sql         consolidated hardening — RLS perf, grants, CHECKs,
                           commission model v2, buyer snapshots on sales
  08_notifications.sql     notifications infra (triggers, scans, outbox)


==============================================================================
What gets seeded (06_seed_dev.sql)
==============================================================================

Projects (4):
  tunis   — Projet Olivier — La Marsa        parcels 101..120
  sousse  — Projet Olivier — El Kantaoui     parcels 201..220
  sfax    — Projet Olivier — Thyna           parcels 301..320
  nabeul  — Projet Olivier — Hammamet        parcels 401..420

Each project: 20 parcels (available), tree batches, workflow settings
(48h reservation, 5%/2% fees, 100 TND payout threshold), checklist items,
commission rules (L1 60%, L2 20%).

Offers (5 across projects):
  tunis  — Standard   72 000 TND / 20% / 24 mois
  tunis  — Confort    85 000 TND / 15% / 36 mois
  sousse — Premium   112 500 TND / 10% / 60 mois
  sfax   — Classique  55 000 TND / 25% / 18 mois
  nabeul — Standard   78 000 TND / 20% / 24 mois

Visit slots: 09-11h, 11-13h, 14-16h, 16-18h.


==============================================================================
Notification scans
==============================================================================

pg_cron is auto-wired when available. Fallback manual trigger:

  SELECT public.run_notification_scans();

Enabling a channel later (SMS / email / push):
  1. UPDATE public.notification_channels SET enabled=true WHERE channel_key='sms';
  2. Deploy a worker (edge function) that reads notification_outbox WHERE
     status='pending' AND channel_key='sms' AND next_attempt_at <= now().
  3. Worker resolves the target, calls the provider, UPDATEs status.


==============================================================================
Notes
==============================================================================

- Every function/policy uses CREATE OR REPLACE / DROP IF EXISTS — safe to re-run.
- Storage buckets are NOT touched by any script; clear them from the Supabase
  dashboard (Storage → bucket → delete files) for a truly fresh start.
- The destructive-reset safety token is session-scoped: closing the SQL editor
  tab resets it — another layer of protection.
