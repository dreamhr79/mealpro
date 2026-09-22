// Catalog access boundary.
// Today it reads IndexedDB; Phase 3 can switch the remote implementation to
// Supabase without coupling screens, favorites or recipes to a vendor SDK.
const CatalogRepository = (() => {
  let remote = null;

  function setRemote(adapter) {
    remote = adapter || null;
  }

  function isOnline() {
    return typeof navigator === 'undefined' || navigator.onLine !== false;
  }

  async function search(q, limit = 80) {
    if (remote && isOnline()) {
      try {
        const rows = await remote.search(q, limit);
        if (Array.isArray(rows)) return rows;
      } catch (err) {
        console.warn('Remote catalog search failed; using IndexedDB fallback.', err);
      }
    }
    return dbSearchProductsWithOffers(q, limit);
  }

  async function getProduct(productKey) {
    if (remote && isOnline()) {
      try {
        const row = await remote.getProduct(productKey);
        if (row?.product && Array.isArray(row.offers)) return row;
      } catch (err) {
        console.warn('Remote catalog product lookup failed; using IndexedDB fallback.', err);
      }
    }
    return dbGetProductWithOffers(productKey);
  }

  return { setRemote, search, getProduct, isOnline };
})();
