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

create or replace function public.apply_staged_catalog(p_sync_id bigint, p_observed_at timestamptz default now())
returns table(products_count integer, offers_count integer, price_changes integer, removed_offers integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_products integer;
  v_offers integer;
  v_changes integer;
  v_removed integer;
begin
  -- Transaction-scoped lock: only one publisher may replace the catalog at a time.
  if not pg_try_advisory_xact_lock(77432791) then
    raise exception 'Catalog sync already running';
  end if;

  select count(*)::integer into v_products from public.catalog_products_stage;
  select count(*)::integer into v_offers from public.catalog_offers_stage;
  if v_products = 0 or v_offers = 0 then
    raise exception 'Staged catalog is empty';
  end if;

  select count(*)::integer into v_removed
  from public.offers o
  where not exists (select 1 from public.catalog_offers_stage s where s.id = o.id);

  select public.record_catalog_price_changes(p_observed_at) into v_changes;

  delete from public.offers;
  delete from public.products;

  insert into public.products(id,barcode,name,brand,pack,unit,search_text,updated_at)
  select id,barcode,name,brand,pack,unit,search_text,p_observed_at
  from public.catalog_products_stage;

  insert into public.offers(id,product_id,store,price,pack,unit,price_per_100,on_sale,observed_at)
  select id,product_id,store,price,pack,unit,price_per_100,on_sale,p_observed_at
  from public.catalog_offers_stage;

  update public.catalog_syncs
  set products_count=v_products, offers_count=v_offers, price_changes=v_changes,
      removed_offers=v_removed, status='success', finished_at=p_observed_at
  where id=p_sync_id;

  truncate public.catalog_products_stage, public.catalog_offers_stage;

  return query select v_products,v_offers,v_changes,v_removed;
end;
$$;

revoke all on public.catalog_products_stage from anon, authenticated;
revoke all on public.catalog_offers_stage from anon, authenticated;
revoke all on function public.record_catalog_price_changes(timestamptz) from public, anon, authenticated;

revoke all on function public.apply_staged_catalog(bigint,timestamptz) from public, anon, authenticated;
