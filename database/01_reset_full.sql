-- =============================================================================
-- ZITOUNA — 01_reset_full.sql
-- Complete database reset: wipes auth.users AND the public schema.
--
-- After running, re-apply in order:
--   02_schema.sql → 03_functions.sql → 04_rls.sql → (optional) 05_seed.sql
--
-- Storage buckets are NOT touched here — clear them from the Supabase dashboard
-- if needed (Storage > select bucket > delete files).
-- =============================================================================

-- ---- 1. auth schema: sessions / identities / users ----
--
-- NOTE: Zitouna installs two triggers on auth.users (see 03_functions.sql)
-- that call public.trg_auth_users_autolink_clients. Because the DROP SCHEMA
-- public CASCADE below removes that function but NOT the auth.users trigger,
-- any subsequent INSERT into auth.users would fail until 03_functions.sql
-- is re-applied. Dropping the triggers here keeps the reset idempotent.
DO $$
BEGIN
  DROP TRIGGER IF EXISTS zitouna_auth_users_autolink_insert ON auth.users;
  DROP TRIGGER IF EXISTS zitouna_auth_users_autolink_update ON auth.users;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

DO $$
DECLARE
  _count bigint;
BEGIN
  DELETE FROM auth.sessions;
  DELETE FROM auth.refresh_tokens;

  BEGIN DELETE FROM auth.mfa_factors;    EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM auth.mfa_challenges; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM auth.mfa_amr_claims; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM auth.identities;     EXCEPTION WHEN undefined_table THEN NULL; END;

  DELETE FROM auth.users;
  GET DIAGNOSTICS _count = ROW_COUNT;
  RAISE NOTICE 'Deleted % auth user(s)', _count;
END $$;

-- ---- 2. public schema: drop + recreate with baseline grants ----
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
COMMENT ON SCHEMA public IS 'standard public schema';

GRANT USAGE  ON SCHEMA public TO postgres;
GRANT CREATE ON SCHEMA public TO postgres;
GRANT ALL    ON SCHEMA public TO postgres;
GRANT USAGE  ON SCHEMA public TO public;

DO $$
BEGIN
  GRANT USAGE ON SCHEMA public TO anon;
  GRANT USAGE ON SCHEMA public TO authenticated;
  GRANT USAGE ON SCHEMA public TO service_role;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES    TO postgres;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;

  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO authenticated;

  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT ON TABLES TO anon;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO anon;

  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT ALL ON TABLES    TO service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT ALL ON SEQUENCES TO service_role;
EXCEPTION WHEN insufficient_privilege THEN NULL;
END $$;

-- Ready for 02_schema.sql.
