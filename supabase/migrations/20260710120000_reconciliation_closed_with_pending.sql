-- Permite fechar a conciliação do dia mesmo com lançamentos ainda pendentes
-- (sugestões não confirmadas / sem par confirmado). O registro fica com
-- status = 'fechada' e closed_with_pending = true, deixando claro que o
-- fechamento não conciliou tudo. Os lançamentos suggested/pending permanecem
-- salvos para tratamento posterior.
--
-- OBS: executar diretamente no SQL Editor do Supabase (não pelo CLI).
alter table public.reconciliations
  add column if not exists closed_with_pending boolean default false;
