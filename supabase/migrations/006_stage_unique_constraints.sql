-- Make catalog staging rows safely upsertable by canonical/source id.
-- LIKE in 002_ingestion copied defaults but not PK/unique constraints, so
-- PostgREST on_conflict=id could not be used by retryable batch ingestion.

delete from public.catalog_products_stage a
using public.catalog_products_stage b
where a.ctid < b.ctid and a.id = b.id;

delete from public.catalog_offers_stage a
using public.catalog_offers_stage b
where a.ctid < b.ctid and a.id = b.id;

create unique index if not exists catalog_products_stage_id_uidx
  on public.catalog_products_stage(id);

create unique index if not exists catalog_offers_stage_id_uidx
  on public.catalog_offers_stage(id);
