ZITOUNA — database/dev/

DESTRUCTIVE scripts. NEVER run against production.

Each file refuses to run unless the safety token is set in the same session:

  SET app.allow_destructive_reset = 'I_UNDERSTAND_THIS_WIPES_DATA';

Without that line, the script raises an exception immediately. The token is
session-scoped — it lives only in the current SQL editor tab.

Files:
  01_reset_full.sql            Full wipe: auth.users + entire public schema.
                               After running, re-apply 02 → 03 → 04 → 07 → 08
                               (and optionally 05) to rebuild.
  01b_reset_keep_accounts.sql  Soft wipe: business data only. Preserves
                               auth.users, admin_users, and clients linked
                               to an auth account.
  ../06_seed_dev.sql           Recommended daily script (single run): wipes
                               auth+business+catalog and reseeds clean dev
                               data (4 accounts + projects + 20 parcels/project).

Quick full reset (paste as ONE block in the SQL editor):

  SET app.allow_destructive_reset = 'I_UNDERSTAND_THIS_WIPES_DATA';
  -- then paste the contents of 01_reset_full.sql below this line

Then rebuild with 02_schema → 03_functions → 04_rls → 07_hardening →
08_notifications. See database/README.txt for the full sequence.

Fast daily dev reset (recommended):

  SET app.allow_destructive_reset = 'I_UNDERSTAND_THIS_WIPES_DATA';
  -- then paste: database/06_seed_dev.sql

Audit ref: docs/AUDIT/01_SECURITY_FINDINGS.md S-M7.
