ZITOUNA — database (PostgreSQL / Supabase)

Run the files in order in the Supabase SQL Editor (role: postgres).

  01_reset_full.sql            (optional) full wipe: auth.users + public schema
  01b_reset_keep_accounts.sql  (optional) wipe data, keep auth + admin_users + linked clients
  02_schema.sql                REQUIRED — tables, enums, indexes, triggers
  03_functions.sql             REQUIRED — helper predicates, RPCs (is_active_staff, etc.)
  04_rls.sql                   REQUIRED — RLS policies, grants, auth↔client recovery
  05_seed.sql                  optional — demo catalogue (projects, parcels, offers, slots)

Fresh start from zero:
  01_reset_full.sql → 02 → 03 → 04 → 05

Rebuild app data but keep users:
  01b_reset_keep_accounts.sql → 02 → 03 → 04 → (05 optional)

Notes:
- Scripts 03/04/05 check that 02 was applied and refuse to run otherwise.
- All functions/policies use CREATE OR REPLACE / DROP IF EXISTS — safe to re-run.
- Storage buckets are not touched; clear them from the Supabase dashboard if needed.
- user_notifications references auth.users (Supabase-specific).
