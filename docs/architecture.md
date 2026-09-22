# MealPro architecture

## Phase 3 target

MealPro is moving toward one shared application core for web, PWA and Android. The browser/mobile client should consume a central normalized catalog instead of downloading and processing the full cijene.dev archive on every device.

### Data flow

```
cijene.dev
   |
scheduled backend ingestion
   |
Products ----< Offers
   |             |
   |         PriceHistory
   |
MealPro API
   |
Web / PWA / Android (Capacitor-ready)
   |
Favorites -> Recipes -> Day Plan -> Shopping List
```

### Central catalog model

**products**
- `id`: canonical key (`ean:<barcode>` when EAN is valid)
- `barcode`
- `name`
- `brand`
- `pack`
- `unit`
- search metadata

**offers**
- current state only
- `id`: source/store offer id
- `product_id`
- `store`
- `price`
- `price_per_100`
- `on_sale`
- `observed_at`

**price_history**
- only actual price changes
- no full daily catalog snapshots
- bounded retention/compaction policy

### Client ownership

User data remains logically separate from the public catalog:
- favorites
- custom products
- recipes
- day plan
- settings

The current IndexedDB implementation remains the offline/local compatibility layer while the backend is introduced. Backend migration must not make recipe editing or day planning depend on network availability.

## Android/mobile principles

The Android APK should wrap the same responsive frontend rather than fork a second UI. The current mobile app shell, safe-area support and shared navigation are the baseline for a later Capacitor package.

Before packaging:
1. move public catalog sync to backend;
2. expose a small catalog/search API;
3. add network/offline state;
4. add installable PWA assets/service-worker strategy;
5. add Capacitor Android shell;
6. test keyboard, back button, dialogs, safe areas and touch targets on Android.

## Phase 3 implementation order

1. Define backend schema and migrations.
2. Add ingestion contract for cijene.dev.
3. Add catalog repository/API abstraction in the client.
4. Keep IndexedDB as fallback/cache.
5. Add Supabase implementation behind that abstraction.
6. Add PWA manifest/install assets.
7. Add Capacitor only after web/PWA navigation and offline behavior are stable.
