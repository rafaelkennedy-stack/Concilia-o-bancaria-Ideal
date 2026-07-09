
CREATE TABLE public.bank_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bank text NOT NULL,
  agency text,
  account_number text,
  entity_name text NOT NULL,
  notes text,
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.bank_accounts TO authenticated;
GRANT ALL ON public.bank_accounts TO service_role;

ALTER TABLE public.bank_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated read bank_accounts"
ON public.bank_accounts FOR SELECT TO authenticated USING (true);

CREATE POLICY "diretor insert bank_accounts"
ON public.bank_accounts FOR INSERT TO authenticated
WITH CHECK (public.has_role(auth.uid(), 'diretor'));

CREATE POLICY "diretor update bank_accounts"
ON public.bank_accounts FOR UPDATE TO authenticated
USING (public.has_role(auth.uid(), 'diretor'))
WITH CHECK (public.has_role(auth.uid(), 'diretor'));

CREATE POLICY "diretor delete bank_accounts"
ON public.bank_accounts FOR DELETE TO authenticated
USING (public.has_role(auth.uid(), 'diretor'));

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER update_bank_accounts_updated_at
BEFORE UPDATE ON public.bank_accounts
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.reconciliations
  ADD COLUMN bank_account_id uuid REFERENCES public.bank_accounts(id);
