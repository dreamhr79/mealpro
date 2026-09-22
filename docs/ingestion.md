# cijene.dev ingestion contract

The catalog importer runs on trusted server infrastructure, never inside the Android APK.

## Required environment

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

The service-role key must exist only in server/Edge Function secrets.

## Run

1. Fetch `https://api.cijene.dev/v0/list`.
2. Select the newest valid archive explicitly by archive date/URL date.
3. Download the ZIP.
4. Parse selected chain `products.csv` and `prices.csv`.
5. Normalize into canonical products and current offers using the same rules as the client importer.
6. Validate that every offer has a product id and positive price.
7. Load normalized rows into the two staging tables.
8. Record price history by comparing staged offers to current offers.
9. Replace current `products` and `offers` atomically.
10. Record a `catalog_syncs` success/failure row.

A failed or incomplete import must not replace the last known-good catalog.

## History rule

Price history stores a row only when an existing offer's numeric price changes. Sale-flag-only changes do not create history. Current `offers.on_sale` is still updated.

The retention target remains at most 30 recent price changes per offer. The backend cleanup job will enforce this centrally.

## Mobile consequence

Web/PWA/Android clients query the normalized central catalog. They do not download or unzip the full cijene.dev archive. IndexedDB remains an offline fallback/cache for catalog reads and the primary local store for personal data until account sync is introduced.
