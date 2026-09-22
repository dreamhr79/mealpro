-- Keep price history compact and make catalog publication concurrency-safe.

create or replace function public.prune_catalog_price_history(p_keep integer default 30)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare deleted_count integer;
begin
  with ranked as (
    select id, row_number() over (partition by offer_id order by recorded_at desc, id desc) as rn
    from public.price_history
  ), deleted as (
    delete from public.price_history h
    using ranked r
    where h.id=r.id and r.rn > greatest(1,p_keep)
    returning h.id
  )
  select count(*)::integer into deleted_count from deleted;
  return deleted_count;
end;
$$;

revoke all on function public.prune_catalog_price_history(integer) from public, anon, authenticated;
