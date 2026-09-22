-- Atomic catalog ingestion helpers.
-- Client apps never call these functions. They are intended for a trusted
-- backend/Edge Function running with the Supabase service role.

create unlogged table if not exists public.catalog_products_stage (
  like public.products including defaults
);

create unlogged table if not exists public.catalog_offers_stage (
  like public.offers including defaults
);


create or replace function public.record_catalog_price_changes(p_observed_at timestamptz default now())
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted_count integer;
begin
  insert into public.price_history(offer_id, product_id, store, price, previous_price, on_sale, recorded_at)
  select s.id, s.product_id, s.store, s.price, o.price, s.on_sale, p_observed_at
  from public.catalog_offers_stage s
  join public.offers o on o.id = s.id
  where o.price is distinct from s.price;

  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;

revoke all on public.catalog_products_stage from anon, authenticated;
revoke all on public.catalog_offers_stage from anon, authenticated;
revoke all on function public.record_catalog_price_changes(timestamptz) from public, anon, authenticated;
