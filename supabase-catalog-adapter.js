// Minimal Supabase REST adapter: no SDK dependency and no privileged key in clients.
const SupabaseCatalogAdapter = (() => {
  function create(config = {}) {
    const base = String(config.supabaseUrl || '').replace(/\/+$/, '');
    const key = String(config.supabaseAnonKey || '').trim();
    if (!base || !key) return null;

    const headers = { apikey: key, Authorization: `Bearer ${key}` };

    async function request(path) {
      const response = await fetch(base + '/rest/v1/' + path, { headers });
      if (!response.ok) throw new Error(`Catalog API ${response.status}`);
      return response.json();
    }

    async function offersFor(productIds) {
      if (!productIds.length) return [];
      const encoded = productIds.map(id => `"${String(id).replace(/"/g, '')}"`).join(',');
      return request(`offers?select=*&product_id=in.(${encodeURIComponent(encoded)})&order=price.asc`);
    }

    async function search(q, limit = 80) {
      const words = String(q || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
      if (!words.length) return [];
      const pattern = '*' + words.join('*') + '*';
      const products = await request(
        `products?select=id,barcode,name,brand,pack,unit,search_text&search_text=ilike.${encodeURIComponent(pattern)}&limit=${Math.max(1, Math.min(150, Number(limit) || 80))}`
      );
      if (!products.length) return [];
      const offers = await offersFor(products.map(p => p.id));
      const grouped = new Map();
      for (const offer of offers) {
        if (!grouped.has(offer.product_id)) grouped.set(offer.product_id, []);
        grouped.get(offer.product_id).push({
          id: offer.id,
          productKey: offer.product_id,
          store: offer.store,
          price: Number(offer.price) || 0,
          pack: Number(offer.pack) || 0,
          unit: offer.unit || 'kom',
          pricePer100: offer.price_per_100 == null ? null : Number(offer.price_per_100),
          onSale: !!offer.on_sale
        });
      }
      return products.map(product => ({
        product: {
          id: product.id, barcode: product.barcode || '', name: product.name || '',
          brand: product.brand || '', pack: Number(product.pack) || 0,
          unit: product.unit || 'kom', search: product.search_text || ''
        },
        offers: grouped.get(product.id) || []
      })).filter(row => row.offers.length);
    }

    async function getProduct(productKey) {
      const id = encodeURIComponent(String(productKey || ''));
      const products = await request(`products?select=id,barcode,name,brand,pack,unit,search_text&id=eq.${id}&limit=1`);
      const product = products[0];
      if (!product) return null;
      const offers = await offersFor([product.id]);
      return {
        product: {
          id: product.id, barcode: product.barcode || '', name: product.name || '',
          brand: product.brand || '', pack: Number(product.pack) || 0,
          unit: product.unit || 'kom', search: product.search_text || ''
        },
        offers: offers.map(offer => ({
          id: offer.id, productKey: offer.product_id, store: offer.store,
          price: Number(offer.price) || 0, pack: Number(offer.pack) || 0,
          unit: offer.unit || 'kom',
          pricePer100: offer.price_per_100 == null ? null : Number(offer.price_per_100),
          onSale: !!offer.on_sale
        }))
      };
    }

    return { search, getProduct };
  }

  return { create };
})();
