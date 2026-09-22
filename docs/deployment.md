# Catalog sync deployment

The repository contains the Supabase schema and `catalog-sync` Edge Function. If the Supabase project is linked to this GitHub repository, use that integration/CI to apply migrations and deploy the function.

Required server secrets:
- Supabase function: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- GitHub Actions: `CATALOG_SYNC_URL`, `CATALOG_SYNC_TOKEN`

`CATALOG_SYNC_URL` is the deployed `catalog-sync` function endpoint. `CATALOG_SYNC_TOKEN` must be a token accepted by the deployed function/JWT gateway. Never use the service-role key as the browser/Android catalog key.

The workflow runs daily at 03:20 UTC and can also be started manually with `workflow_dispatch`. GitHub concurrency prevents overlapping workflow runs; PostgreSQL also serializes the final atomic publication.

Deployment is not proven merely by committing these files. Confirm the linked Supabase project has applied migrations `001`–`003` and deployed `catalog-sync` before enabling the daily trigger.
