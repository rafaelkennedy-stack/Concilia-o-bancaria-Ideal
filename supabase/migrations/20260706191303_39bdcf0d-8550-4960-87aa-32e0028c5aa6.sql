
-- Grouped matches: many-to-one / one-to-many
ALTER TABLE public.reconciliation_matches
  ADD COLUMN IF NOT EXISTS group_id uuid;
CREATE INDEX IF NOT EXISTS reconciliation_matches_group_id_idx
  ON public.reconciliation_matches(group_id);

-- Balances on reconciliations
ALTER TABLE public.reconciliations
  ADD COLUMN IF NOT EXISTS balance_bank numeric(14,2),
  ADD COLUMN IF NOT EXISTS balance_agrotis_previous numeric(14,2),
  ADD COLUMN IF NOT EXISTS balance_agrotis_calculated numeric(14,2);
