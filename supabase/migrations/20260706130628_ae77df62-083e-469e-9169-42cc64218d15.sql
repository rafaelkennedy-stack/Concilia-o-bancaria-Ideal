
revoke execute on function public.has_role(uuid, public.app_role) from authenticated;

create policy "auth read reconciliacao files" on storage.objects for select to authenticated
  using (bucket_id = 'conciliacao-arquivos');
create policy "auth upload reconciliacao files" on storage.objects for insert to authenticated
  with check (bucket_id = 'conciliacao-arquivos' and owner = auth.uid());
