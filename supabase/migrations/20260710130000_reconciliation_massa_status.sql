-- Status "massa": conciliação de vários dias em um único fluxo de revisão.
-- Ao fechar, a conciliação massa é dividida em conciliações diárias "fechada"
-- (ver closeMassReconciliation em src/lib/reconciliation.functions.ts).
--
-- period_end_date (data do movimento mais recente do período) já foi adicionada
-- manualmente; usada no cálculo de prazo médio do painel.
--
-- OBS: executar diretamente no SQL Editor do Supabase (não pelo CLI).
-- ALTER TYPE ... ADD VALUE não pode rodar dentro de um bloco de transação.
alter type public.reconciliation_status add value if not exists 'massa';
