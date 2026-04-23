-- ============================================================================
-- Dev migration — add project_offers.price_per_sqm (+ sibling optional cols).
--
-- Why: the offer editor persists `usePricePerSqm` + `pricePerSqm` (the
-- "Calcul au prix du m²" toggle in /admin/projects/:id → Offres → Modifier).
-- Without this column, src/lib/db.js `upsertOffer()` detects a 42703 /
-- PGRST204 on the first write and silently retries without the field —
-- the offer saves, but the price/m² is dropped. On re-open the checkbox
-- is off and the offer card has no DT/m² chip, so SellPage can't compute
-- a total for m²-priced projects (m² × area).
--
-- This file only ADDs — it doesn't drop or rewrite anything. Safe to run
-- multiple times. The full canonical definition still lives in
-- database/07_hardening.sql (Section E2); this is just the isolated
-- slice for environments that haven't applied 07 yet.
-- ============================================================================

ALTER TABLE public.project_offers
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'installments';
ALTER TABLE public.project_offers
  ADD COLUMN IF NOT EXISTS cash_amount numeric(14,2);
ALTER TABLE public.project_offers
  ADD COLUMN IF NOT EXISTS price_per_sqm numeric(14,2);
ALTER TABLE public.project_offers
  ADD COLUMN IF NOT EXISTS note text;

-- Mode check-constraint — idempotent.
DO $zit_offer_mode$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'project_offers_mode_check'
  ) THEN
    ALTER TABLE public.project_offers
      ADD CONSTRAINT project_offers_mode_check
      CHECK (mode IN ('installments','cash'));
  END IF;
END
$zit_offer_mode$;

-- Force PostgREST to refresh its schema cache so the next write accepts
-- the new columns without a round-trip through the 42703 retry loop.
NOTIFY pgrst, 'reload schema';
