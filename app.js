const CHAINS = {
  konzum: 'Konzum', lidl: 'Lidl', spar: 'SPAR', plodine: 'Plodine', tommy: 'Tommy',
  eurospin: 'Eurospin', kaufland: 'Kaufland', studenac: 'Studenac', ktc: 'KTC',
  metro: 'Metro', ribola: 'Ribola', ntl: 'NTL'
};

let favorites = [], custom = [], recipes = [], meal = { recipeId: null, name: '', servings: 1, items: [] };
let dayPlan = { goals: { kcal: 2200, protein: 160, carbs: 220, fat: 70 }, blocks: [], settings: { kcalLocked: true, balance: 'carbs' } };
let toastTimer;

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function norm(s) { return String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').toLowerCase().trim(); }
function tokens(s) { return [...new Set(norm(s).replace(/[^a-z0-9čćžšđ]+/g, ' ').split(/\s+/).filter(x => x.length >= 2))]; }
function eur(n) { return Number(n || 0).toLocaleString('hr-HR', { style: 'currency', currency: 'EUR' }); }
function num(v, d = 1) { const n = Number(v || 0); return n.toLocaleString('hr-HR', { maximumFractionDigits: d, minimumFractionDigits: (d === 0 ? 0 : 1) }); }
function hasNoMacros(p) {
  return ![p?.kcal, p?.protein, p?.carbs, p?.fat].some(v => Number(v) > 0);
}

function id() { return crypto.randomUUID(); }

function showToast(msg) {
  const el = $('#toast'); if (!el) return;
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur.replace(/\r$/, '')); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

function nval(v) {
  const n = Number(String(v || '').replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normalizeBarcode(value) {
  const code = String(value ?? '').replace(/\D/g, '');
  return code.length >= 8 ? code : '';
}

function archiveTime(archive) {
  const candidates = [archive?.date, archive?.createdAt, archive?.created_at, archive?.timestamp];
  for (const value of candidates) {
    const t = Date.parse(value || '');
    if (Number.isFinite(t)) return t;
  }
  const urlDate = String(archive?.url || '').match(/(20\d{2})[-_/]?(\d{2})[-_/]?(\d{2})/);
  return urlDate ? Date.UTC(Number(urlDate[1]), Number(urlDate[2]) - 1, Number(urlDate[3])) : 0;
}

function newestArchive(archives) {
  const valid = (Array.isArray(archives) ? archives : []).filter(a => a?.url);
  return valid.sort((a, b) => archiveTime(b) - archiveTime(a))[0] || null;
}

function canonicalProductKey(product) {
  const barcode = normalizeBarcode(product?.barcode);
  if (barcode) return `ean:${barcode}`;
  // Products without EAN must not collide across chains when external ids overlap.
  // Prefer the already chain-qualified row id; only then fall back to external id.
  const sourceId = String(product?.id || product?.externalId || '').trim();
  return sourceId ? `source:${sourceId}` : '';
}

function offerFromCatalogRow(row) {
  return {
    id: row.id,
    productKey: canonicalProductKey(row),
    store: row.store || '',
    price: Number(row.price) || 0,
    pack: Number(row.pack) || 0,
    unit: row.unit || 'kom',
    pricePer100: Number.isFinite(Number(row.pricePer100)) ? Number(row.pricePer100) : null,
    onSale: !!row.onSale
  };
}

function sortOffersByPrice(offers) {
  return [...offers].sort((a, b) => {
    const ap = Number(a.price), bp = Number(b.price);
    const aHas = Number.isFinite(ap) && ap > 0, bHas = Number.isFinite(bp) && bp > 0;
    if (aHas && bHas && ap !== bp) return ap - bp;
    if (aHas !== bHas) return aHas ? -1 : 1;
    return getUnitValuePer100(a) - getUnitValuePer100(b);
  });
}

function favoriteOfferSnapshot(rows) {
  return sortOffersByPrice(rows).map(offerFromCatalogRow);
}

function canonicalProductFromCatalogRow(row) {
  const productKey = canonicalProductKey(row);
  return {
    id: productKey,
    barcode: normalizeBarcode(row.barcode),
    name: row.name || '',
    brand: row.brand || '',
    pack: Number(row.pack) || 0,
    unit: row.unit || 'kom',
    search: row.search || norm(`${row.name || ''} ${row.brand || ''} ${normalizeBarcode(row.barcode)}`),
    tokens: Array.isArray(row.tokens) ? row.tokens : tokens(row.search || row.name || '')
  };
}

function buildNormalizedCatalogModel(rows) {
  const products = new Map();
  const offersById = new Map();
  for (const row of rows || []) {
    const product = canonicalProductFromCatalogRow(row);
    if (!product.id) continue;

    // One canonical product per identity. Prefer the richer/newer row when the
    // same EAN appears with missing metadata in another chain.
    const existing = products.get(product.id);
    if (!existing) {
      products.set(product.id, product);
    } else {
      const merged = { ...existing };
      if (!merged.name && product.name) merged.name = product.name;
      if (!merged.brand && product.brand) merged.brand = product.brand;
      if (!(Number(merged.pack) > 0) && Number(product.pack) > 0) merged.pack = product.pack;
      if ((!merged.unit || merged.unit === 'kom') && product.unit && product.unit !== 'kom') merged.unit = product.unit;
      merged.search = norm(`${merged.name || ''} ${merged.brand || ''} ${merged.barcode || ''}`);
      merged.tokens = tokens(merged.search);
      products.set(product.id, merged);
    }

    const offer = offerFromCatalogRow(row);
    const prev = offersById.get(offer.id);
    if (!prev || (offer.price > 0 && offer.price < prev.price)) offersById.set(offer.id, offer);
  }
  return { products: [...products.values()], offers: [...offersById.values()] };
}

function packFromName(name) {
  const s = String(name || '').toLowerCase().replace(/,/g, '.').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  
  // 1. Multipack pattern: e.g. "4 x 100 g", "6 x 0.5 l", "2x500g"
  let m = s.match(/(?:^|\s)(\d{1,3})\s*[x×*]\s*(\d+(?:\.\d+)?)\s*(kg|g|l|ml)\b/i);
  if (m) {
    const count = Number(m[1]), n = Number(m[2]), u = m[3].toLowerCase();
    if (count > 0 && count <= 100 && n > 0) {
      if (u === 'kg') return { pack: count * n * 1000, unit: 'g', source: 'name-multipack' };
      if (u === 'g') return { pack: count * n, unit: 'g', source: 'name-multipack' };
      if (u === 'l') return { pack: count * n * 1000, unit: 'ml', source: 'name-multipack' };
      if (u === 'ml') return { pack: count * n, unit: 'ml', source: 'name-multipack' };
    }
  }

  // 2. Piece multipack: e.g. "10 kom", "6 komada". Keep quantity in pieces
  // so recipe costing and the shopping list can divide package price correctly.
  let pc = s.match(/(?:^|\s)(\d{1,3})\s*(?:kom|komada|komad)\b/i);
  if (pc) {
    const count = Number(pc[1]);
    if (count > 0 && count <= 200) return { pack: count, unit: 'kom', source: 'name-pieces' };
  }

  // 3. Direct weight/volume in title: e.g. "500 G", "500g", "1 kg", "250 ml", "0.5 l", "1.5 l"
  const ms = [...s.matchAll(/(\d+(?:\.\d+)?)\s*(kg|g|l|ml)\b/ig)];
  if (ms.length) {
    const z = ms[ms.length - 1], n = Number(z[1]), u = z[2].toLowerCase();
    if (n > 0) {
      if (u === 'kg') return { pack: n * 1000, unit: 'g', source: 'name' };
      if (u === 'g' && n >= 5) return { pack: n, unit: 'g', source: 'name' };
      if (u === 'l') return { pack: n * 1000, unit: 'ml', source: 'name' };
      if (u === 'ml' && n >= 5) return { pack: n, unit: 'ml', source: 'name' };
    }
  }
  return null;
}

function packFromUnitPrice(price, ppu, rawUnit = '') {
  const p = Number(price) || 0, unitPrice = Number(ppu) || 0;
  if (!(p > 0) || !(unitPrice > 0)) return null;

  const ratio = p / unitPrice; // package share of 1 kg / 1 L
  if (!(ratio > 0.005 && ratio < 50)) return null;
  const pack = Math.round(ratio * 1000);
  if (pack < 10) return null;

  const u = norm(rawUnit);
  // Unit-price math alone cannot distinguish kg from L. Preserve the source
  // unit when it tells us; otherwise do not invent grams for an unknown "kom".
  if (u === 'l' || u === 'ml') return { pack, unit: 'ml', source: 'unit-price' };
  if (u === 'kg' || u === 'g') return { pack, unit: 'g', source: 'unit-price' };
  return null;
}

function calcSmartPack(rawQty, rawUnit, name, price = 0, ppu = 0) {
  // Signal 1 (najjači): Vjerujemo nazivu artikla! Ako u nazivu piše "500 G", to je 500 g, a ne 500 komada!
  const fromName = packFromName(name);
  if (fromName) return fromName;

  // Signal 2: Izračun iz jedinične cijene u trgovini (cijena po kg / L)
  const fromPpu = packFromUnitPrice(price, ppu, rawUnit);

  let q = nval(rawQty), u = norm(rawUnit);
  let parsedUnit = (u === 'kg' || u === 'g') ? 'g' : (u === 'l' || u === 'ml') ? 'ml' : 'kom';
  let pack = q || 0;

  if (u === 'kg') pack *= 1000;
  if (u === 'l') pack *= 1000;

  // Ako izvor daje nerealnu gramažu poput 1 g ili 'kom' za namirnice, uzmi jediničnu cijenu
  if ((pack < 5 || parsedUnit === 'kom') && fromPpu) {
    return fromPpu;
  }

  if (pack >= 5 && (parsedUnit === 'g' || parsedUnit === 'ml')) {
    return { pack, unit: parsedUnit, source: 'source' };
  }

  if (fromPpu) return fromPpu;

  return { pack: pack > 0 ? pack : 100, unit: parsedUnit, source: 'fallback' };
}

function resolveMealItemProduct(it) {
  if (!it) return { id: id(), name: 'Nepoznato', pack: 100, unit: 'g', price: 0, kcal: 0, protein: 0, carbs: 0, fat: 0 };
  const snapshot = it.product && typeof it.product === 'object' ? it.product : null;
  const productId = it.productId != null ? String(it.productId) : '';
  const barcode = normalizeBarcode(snapshot?.barcode || it.barcode);

  // Always prefer the current persisted product over the recipe/day-plan snapshot.
  // This keeps prices and macros live after a favorite is refreshed by catalog sync.
  let p = favorites.find(f =>
    (productId && (String(f.id) === productId || String(f.catalogId) === productId)) ||
    (barcode && normalizeBarcode(f.barcode) === barcode)
  ) || custom.find(c =>
    (productId && String(c.id) === productId) ||
    (barcode && normalizeBarcode(c.barcode) === barcode)
  ) || snapshot;

  if (!p) {
    p = it.product || {
      id: 'unlinked:' + id(),
      name: it.name || it.rawName || 'Sastojak',
      pack: 100,
      unit: it.unit || 'g',
      price: Number(it.price) || 0,
      kcal: Number(it.kcal) || 0,
      protein: Number(it.protein) || 0,
      carbs: Number(it.carbs) || 0,
      fat: Number(it.fat) || 0
    };
  }
  return repairProductPackage(p);
}

function repairProductPackage(p) {
  if (!p) return p;
  // Ako je jedinica 'kom', ali u nazivu ima npr. "500 g", "1 l", "150g", "400ml" etc.
  if (p.unit === 'kom' || !p.unit || Number(p.pack) <= 1) {
    const fn = packFromName(p.name);
    const validNamedPack = fn && ((fn.unit === 'kom' && fn.pack >= 1) || fn.pack >= 5);
    if (validNamedPack) {
      p.pack = fn.pack;
      p.unit = fn.unit;
      if (p.price > 0 && p.pack > 0 && (p.unit === 'g' || p.unit === 'ml')) {
        p.pricePer100 = (p.price / p.pack) * 100;
      }
    }
  }
  return p;
}

// === Open Food Facts API (Macro enrichment) ===
async function fetchOffMacros(barcode) {
  const code = String(barcode || '').replace(/\D/g, '');
  if (code.length < 8) return null;
  const fields = 'code,product_name,nutriments';
  const urls = [
    `https://world.openfoodfacts.org/api/v3/product/${encodeURIComponent(code)}.json?fields=${fields}`,
    `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json?fields=${fields}`
  ];
  for (const u of urls) {
    try {
      const r = await fetch(u); if (!r.ok) continue;
      const d = await r.json(), p = d.product; if (!p) continue;
      const n = p.nutriments || {};
      const res = {
        kcal: Number(n['energy-kcal_100g'] ?? n['energy-kcal'] ?? 0) || 0,
        protein: Number(n.proteins_100g ?? n.proteins ?? 0) || 0,
        carbs: Number(n.carbohydrates_100g ?? n.carbohydrates ?? 0) || 0,
        fat: Number(n.fat_100g ?? n.fat ?? 0) || 0
      };
      if ([res.kcal, res.protein, res.carbs, res.fat].some(v => v > 0)) return res;
    } catch (_) {}
  }
  return null;
}

// === Loading State ===
async function loadAll() {
  favorites = (await dbAll('favorites')).map(repairProductPackage);
  custom = (await dbAll('custom')).map(repairProductPackage);
  recipes = (await dbAll('recipes')).map(r => {
    const safeRecipe = r && typeof r === 'object' ? r : {};
    safeRecipe.items = Array.isArray(safeRecipe.items)
      ? safeRecipe.items.map(it => ({ ...it, product: resolveMealItemProduct(it) }))
      : [];
    safeRecipe.servings = Math.max(1, Number(safeRecipe.servings) || 1);
    return safeRecipe;
  });

  // Automatsko uklanjanje privremenih fantomskih unosa iz 'Mojih proizvoda' ako su ranije nastali uvozom
  const phantomCustom = custom.filter(c => c.brand && c.brand.includes('Instagram uvoz'));
  if (phantomCustom.length) {
    for (const pc of phantomCustom) { await dbDelete('custom', pc.id); }
    custom = await dbAll('custom');
  }
  
  const mSync = await dbGet('meta', 'sync');
  if (mSync) $('#syncState').textContent = `Baza: ${mSync.date} · ${mSync.count.toLocaleString('hr-HR')} artikala`;
  
  const mDay = await dbGet('meta', 'dayPlan');
  if (mDay && mDay.val) {
    dayPlan = mDay.val;
    dayPlan.blocks = Array.isArray(dayPlan.blocks) ? dayPlan.blocks : [];
    dayPlan.goals = dayPlan.goals || { kcal: 2200, protein: 160, carbs: 220, fat: 70 };
    dayPlan.settings = dayPlan.settings || { kcalLocked: true, balance: 'carbs' };
    for (const block of dayPlan.blocks) {
      block.items = Array.isArray(block.items)
        ? block.items.map(it => ({ ...it, product: resolveMealItemProduct(it) }))
        : [];
    }
  }

  renderFavorites();
  renderCustom();
  renderRecipes();
  renderPicker();
  renderMeal();
  renderDayPlan();
  
  $('#favCount').textContent = `(${favorites.length})`;
  $('#recipeCount').textContent = `(${recipes.length})`;
}

// Tabs
$$('#tabs button').forEach(b => b.onclick = () => {
  $$('#tabs button').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  $$('.view').forEach(v => v.classList.remove('active'));
  $('#' + b.dataset.tab).classList.add('active');
  if (b.dataset.tab === 'shoplist') renderShoppingList();
});

// Picker Tabs inside Creator
$$('.pickerTabs button').forEach(b => b.onclick = () => {
  $$('.pickerTabs button').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  ['Favorites', 'Custom', 'Catalog'].forEach(t => {
    const el = $('#picker' + t);
    if (el) el.style.display = (t.toLowerCase() === b.dataset.source) ? 'block' : 'none';
  });
});

function macroText(p) {
  return `${num(p.kcal, 0)} kcal · P ${num(p.protein)} g · UH ${num(p.carbs)} g · M ${num(p.fat)} g / 100 ${p.unit || 'g'}`;
}

function itemCost(p, q) {
  const price = Number(p?.price) || 0;
  const pack = Number(p?.pack) || 0;
  const qty = Math.max(0, Number(q) || 0);
  if (!(price > 0) || !(pack > 0) || !(qty > 0)) return 0;
  // price is stored per purchasable package. This also supports multi-piece
  // packages (e.g. 10 eggs): qty is expressed in pieces and pack is pieces/package.
  return qty * (price / pack);
}

// === RENDER MEAL CREATOR ===
function updateMealTotals() {
  meal.servings = Math.max(1, Number($('#mealServings')?.value || meal.servings || 1));
  let t = { kcal: 0, protein: 0, carbs: 0, fat: 0, cost: 0 };
  for (const it of meal.items) {
    const p = resolveMealItemProduct(it);
    it.product = p;
    const q = Number(it.qty) || 0;
    const f = (p.unit === 'kom' ? q : q / 100);
    t.kcal += Number(p.kcal || 0) * f;
    t.protein += Number(p.protein || 0) * f;
    t.carbs += Number(p.carbs || 0) * f;
    t.fat += Number(p.fat || 0) * f;
    t.cost += itemCost(p, q);
  }
  const sv = meal.servings || 1;
  const totEl = $('#mealTotals');
  if (totEl) {
    totEl.innerHTML = [
      ['UKUPNA CIJENA', eur(t.cost)],
      ['PO PORCIJI', eur(t.cost / sv)],
      ['KCAL / PORCIJA', num(t.kcal / sv, 0)],
      ['PROTEINI / PORCIJA', num(t.protein / sv) + ' g'],
      ['UH / MASTI', `${num(t.carbs / sv)} / ${num(t.fat / sv)} g`]
    ].map(x => `<div class="total"><b>${x[1]}</b><span>${x[0]}</span></div>`).join('');
  }
}

function renderMeal() {
  meal.name = $('#mealName')?.value || meal.name;
  meal.servings = Math.max(1, Number($('#mealServings')?.value || meal.servings || 1));
  
  const box = $('#mealIngredients');
  if (!box) return;

  box.innerHTML = meal.items.length ? meal.items.map((it, i) => {
    const p = resolveMealItemProduct(it);
    it.product = p; // osiguraj da je povezan
    const q = Number(it.qty) || 0;
    const f = (p.unit === 'kom' ? q : q / 100);
    const scaledMacroHtml = hasNoMacros(p)
      ? `<span class="quickEditMacro editProduct" data-type="${p.store ? 'favorites' : 'custom'}" data-id="${p.id}" title="Klikni za unos makroa">&#9888;&#65039; 0 kcal &middot; Upiši makrose &#9997;&#65039;</span>`
      : `${num((Number(p.kcal)||0)*f, 0)} kcal &middot; P ${num((Number(p.protein)||0)*f)} g &middot; UH ${num((Number(p.carbs)||0)*f)} g &middot; M ${num((Number(p.fat)||0)*f)} g <span class="small" style="opacity:.75">(za ${q} ${p.unit||'g'})</span>`;

    return `
    <div class="mealIng" data-i="${i}">
      <div>
        <div class="name">${esc(p.name)}</div>
        <div class="macro rowMacro">${scaledMacroHtml}</div>
      </div>
      <div class="qtyControl">
        <button type="button" class="mealQtyMinus" data-i="${i}">−</button>
        <input class="mealQty" data-i="${i}" type="number" min="0" step="any" value="${q}">
        <button type="button" class="mealQtyPlus" data-i="${i}">+</button>
      </div>
      <div style="font-weight:700;color:var(--muted)">${esc(p.unit || 'g')}</div>
      <div class="price rowCost" style="font-size:13px">${eur(itemCost(p, q))}</div>
      <button class="danger removeMeal" data-i="${i}">×</button>
    </div>`;
  }).join('') : '<div class="empty">Dodaj namirnice iz Favorita, Mojih proizvoda ili Baze.</div>';

  updateMealTotals();
}

function updateEditingBanner() {
  const banner = $('#editingRecipeBanner');
  const copyBtn = $('#saveRecipeCopy');
  const saveBtn = $('#saveRecipe');
  if (meal && meal.recipeId) {
    if (banner) { banner.style.display = 'flex'; $('#editingRecipeName').textContent = meal.name; }
    if (copyBtn) copyBtn.style.display = 'inline-block';
    if (saveBtn) saveBtn.textContent = '💾 Ažuriraj recept';
  } else {
    if (banner) banner.style.display = 'none';
    if (copyBtn) copyBtn.style.display = 'none';
    if (saveBtn) saveBtn.textContent = '💾 Spremi u Recepte';
  }
}

$('#newMeal').onclick = () => {
  meal = { recipeId: null, name: '', servings: 1, items: [] };
  $('#mealName').value = '';
  $('#mealServings').value = 1;
  updateEditingBanner();
  renderMeal();
};

document.getElementById('cancelEditingRecipe')?.addEventListener('click', () => {
  meal.recipeId = null;
  updateEditingBanner();
  showToast('Prekinuto uređivanje. Spremanje će sada stvoriti novi recept.');
});

$('#saveRecipe').onclick = async () => {
  try {
  const name = $('#mealName').value.trim();
  if (!name) return alert('Upiši naziv obroka.');
  if (!meal.items.length) return alert('Dodaj barem jednu namirnicu.');
  const serv = Math.max(1, Number($('#mealServings').value || 1));

  // 1. Ako se uređuje već otvoreni recept -> ažuriraj postojeći zapis
  if (meal.recipeId) {
    const existing = recipes.find(x => x.id === meal.recipeId);
    if (existing) {
      existing.name = name;
      existing.servings = serv;
      existing.items = structuredClone(meal.items);
      existing.updatedAt = new Date().toISOString();
      await dbPut('recipes', existing);
      recipes = await dbAll('recipes');
      renderRecipes();
      updateEditingBanner();
      showToast(`✓ Recept "${name}" je uspješno ažuriran!`);
      return;
    }
  }

  // 2. Ako nije eksplicitno otvoren recept, provjeri postoji li već recept s istim imenom
  const sameName = recipes.find(x => norm(x.name) === norm(name));
  if (sameName) {
    if (confirm(`Recept s nazivom "${name}" već postoji u bazi.\n\nKlikni [U redu] za AŽURIRANJE postojećeg recepta,\nili [Odustani] ako želiš spremiti kao novu kopiju.`)) {
      sameName.servings = serv;
      sameName.items = structuredClone(meal.items);
      sameName.updatedAt = new Date().toISOString();
      await dbPut('recipes', sameName);
      meal.recipeId = sameName.id;
      recipes = await dbAll('recipes');
      renderRecipes();
      updateEditingBanner();
      showToast(`✓ Recept "${name}" je ažuriran!`);
      return;
    }
  }

  // 3. Inače spremi kao novi recept
  const r = {
    id: id(),
    name,
    servings: serv,
    items: structuredClone(meal.items),
    instructions: meal.instructions || '',
    authorMacros: meal.authorMacros || null,
    savedAt: new Date().toISOString()
  };
  await dbPut('recipes', r);
  meal.recipeId = r.id;
  recipes = await dbAll('recipes');
  renderRecipes();
  updateEditingBanner();
  $('#recipeCount').textContent = `(${recipes.length})`;
  showToast(`Recept "${name}" je spremljen!`);
  } catch (err) {
    console.error('Recipe save error:', err);
    showToast('Spremanje recepta nije uspjelo. Postojeći podaci nisu obrisani.');
  }
};

document.getElementById('saveRecipeCopy')?.addEventListener('click', async () => {
  try {
  const baseName = $('#mealName').value.trim() || 'Recept';
  const copyName = baseName.includes('(kopija)') ? baseName : `${baseName} (kopija)`;
  const serv = Math.max(1, Number($('#mealServings').value || 1));
  if (!meal.items.length) return alert('Dodaj barem jednu namirnicu.');

  const r = {
    id: id(),
    name: copyName,
    servings: serv,
    items: structuredClone(meal.items),
    instructions: meal.instructions || '',
    authorMacros: meal.authorMacros || null,
    savedAt: new Date().toISOString()
  };
  await dbPut('recipes', r);
  meal.recipeId = r.id;
  meal.name = copyName;
  $('#mealName').value = copyName;
  recipes = await dbAll('recipes');
  renderRecipes();
  updateEditingBanner();
  $('#recipeCount').textContent = `(${recipes.length})`;
  showToast(`Spremljeno kao novi recept: "${copyName}"!`);
  } catch (err) {
    console.error('Recipe copy save error:', err);
    showToast('Spremanje kopije recepta nije uspjelo.');
  }
});

$('#addMealToDayPlan').onclick = async () => {
  if (!meal.items.length) return alert('Obrok nema sastojaka.');
  const name = $('#mealName').value.trim() || 'Obrok';
  const divisor = Math.max(1, meal.servings || 1);
  const blockItems = meal.items.map(it => {
    const p = resolveMealItemProduct(it);
    return {
      productId: p.id || it.productId || null,
      product: { ...p },
      qty: (Number(it.qty) || 0) / divisor
    };
  });
  const block = { id: Date.now(), name, items: blockItems };
  dayPlan.blocks.push(block);
  try {
    await saveDayPlan();
  } catch (err) {
    dayPlan.blocks.pop();
    console.error('Add meal to day plan error:', err);
    showToast('Dodavanje obroka u Dnevni plan nije uspjelo.');
    return;
  }
  renderDayPlan();
  showToast(`Obrok "${name}" je dodan u Dnevni plan!`);
  $('#tabs button[data-tab="dayplan"]').click();
};

function renderPicker() {
  const row = (p, source) => {
    const valBadge = formatUnitValue(p);
    return `
    <div class="productRow">
      <div>
        <div class="name">${esc(p.name)} ${p.onSale ? '<span class="saleBadgeMini">AKCIJA</span>' : ''}</div>
        <div class="meta">${esc(p.brand || '')} ${p.store ? '· <b>' + esc(p.store) + '</b>' : ''} · ${num(p.pack, 0)} ${esc(p.unit || 'g')}</div>
        <div>${valBadge}</div>
      </div>
      <div class="price">
        <b>${p.price ? eur(p.price) : ''}</b>
      </div>
      <div class="macro" style="margin:0"><b>${num(p.protein)} g</b> P</div>
      <button class="addMeal" data-source="${source}" data-id="${p.id}">+ Dodaj</button>
    </div>`;
  };

  // Sortiraj favorite po isplativosti po gramu/100g
  const sortedFavs = [...favorites].sort((a, b) => {
    const va = getUnitValuePer100(a), vb = getUnitValuePer100(b);
    if (Number.isFinite(va) !== Number.isFinite(vb)) return Number.isFinite(va) ? -1 : 1;
    if (Number.isFinite(va) && va !== vb) return va - vb;
    return (Number(a.price) || 0) - (Number(b.price) || 0);
  });

  const sortedCustom = [...custom].sort((a, b) => {
    const va = getUnitValuePer100(a), vb = getUnitValuePer100(b);
    if (Number.isFinite(va) !== Number.isFinite(vb)) return Number.isFinite(va) ? -1 : 1;
    if (Number.isFinite(va) && va !== vb) return va - vb;
    return (Number(a.price) || 0) - (Number(b.price) || 0);
  });
  
  $('#pickerFavorites').innerHTML = sortedFavs.length ? sortedFavs.map(p => row(p, 'favorites')).join('') : '<div class="empty">Nema favorita. Dodaj ih iz Baze cjenika.</div>';
  $('#pickerCustom').innerHTML = sortedCustom.length ? sortedCustom.map(p => row(p, 'custom')).join('') : '<div class="empty">Nema osobnih proizvoda. Dodaj ih u tabu Moji proizvodi.</div>';
}

// Event Delegation for meals
document.addEventListener('click', async e => {
  const editBadge = e.target.closest('.editProduct, .quickEditMacro, .noMacroBadge');
  if (editBadge) {
    e.preventDefault();
    openProductDialog(editBadge.dataset.type || 'favorites', editBadge.dataset.id);
    return;
  }
  const b = e.target.closest('button');
  if (!b) return;

  if (b.classList.contains('addMeal')) {
    const arr = (b.dataset.source === 'favorites') ? favorites : custom;
    const p = repairProductPackage(arr.find(x => x.id === b.dataset.id));
    if (p) {
      meal.items.push({ product: { ...p }, qty: p.unit === 'kom' ? 1 : 100 });
      renderMeal();
    }
  }
  if (b.classList.contains('removeMeal')) {
    meal.items.splice(Number(b.dataset.i), 1);
    renderMeal();
  }
  if (b.classList.contains('editProduct')) openProductDialog(b.dataset.type, b.dataset.id);
  if (b.classList.contains('deleteProduct')) {
    if (confirm('Obrisati ovaj proizvod?')) {
      try {
        await dbDelete(b.dataset.type, b.dataset.id);
        await loadAll();
        showToast('Proizvod je obrisan.');
      } catch (err) {
        console.error('Product delete error:', err);
        showToast('Brisanje proizvoda nije uspjelo.');
      }
    }
  }
  if (b.classList.contains('favFromCatalog')) {
    let updatedFav = null;
    try {
      updatedFav = await favoriteFromCatalog(b.dataset.id);
    } catch (err) {
      console.error('Favorite catalog update error:', err);
      showToast('Dodavanje ili osvježavanje favorita nije uspjelo.');
    }
    if (updatedFav) {
      b.classList.add('isFavoriteBtn');
      b.textContent = '★ U favoritima';
      b.title = 'Već je u favoritima (klikni za ažuriranje ponuda)';
      const row = b.closest('.productRow');
      if (row) {
        row.classList.add('isFavRow');
        const nameEl = row.querySelector('.name');
        if (nameEl && !nameEl.querySelector('.favBadgeStar')) {
          nameEl.insertAdjacentHTML('beforeend', '<span class="favBadgeStar">★ U FAVORITIMA</span>');
        }
      }
    }
  }
  if (b.classList.contains('baseToMeal')) {
    try {
      await addCatalogToMeal(b.dataset.id);
    } catch (err) {
      console.error('Catalog to meal error:', err);
      showToast('Dodavanje proizvoda iz baze u obrok nije uspjelo.');
    }
  }
  if (b.classList.contains('deleteRecipe')) {
    if (confirm('Obrisati recept?')) {
      try {
        await dbDelete('recipes', b.dataset.id);
        recipes = await dbAll('recipes');
        if (meal.recipeId === b.dataset.id) {
          meal.recipeId = null;
          updateEditingBanner();
        }
        renderRecipes();
        $('#recipeCount').textContent = `(${recipes.length})`;
        showToast('Recept je obrisan.');
      } catch (err) {
        console.error('Recipe delete error:', err);
        showToast('Brisanje recepta nije uspjelo.');
      }
    }
  }
  if (b.classList.contains('loadRecipe')) loadRecipe(b.dataset.id);
});

document.addEventListener('input', e => {
  if (e.target.classList.contains('mealQty')) {
    const idx = Number(e.target.dataset.i);
    const val = Math.max(0, Number(e.target.value || 0));
    if (meal.items[idx]) {
      meal.items[idx].qty = val;
      const row = e.target.closest('.mealIng');
      if (row) {
        const p = meal.items[idx].product;
        const costEl = row.querySelector('.rowCost');
        if (costEl) costEl.textContent = eur(itemCost(p, val));
        const macroEl = row.querySelector('.rowMacro');
        if (macroEl) {
          if (hasNoMacros(p)) {
            macroEl.innerHTML = `<span class="quickEditMacro editProduct" data-type="${p.store ? 'favorites' : 'custom'}" data-id="${p.id}" title="Klikni za unos makroa">&#9888;&#65039; 0 kcal &middot; Upiši makrose &#9997;&#65039;</span>`;
          } else {
            const f = (p.unit === 'kom' ? val : val / 100);
            macroEl.innerHTML = `${num((Number(p.kcal)||0)*f, 0)} kcal &middot; P ${num((Number(p.protein)||0)*f)} g &middot; UH ${num((Number(p.carbs)||0)*f)} g &middot; M ${num((Number(p.fat)||0)*f)} g <span class="small" style="opacity:.75">(za ${val} ${p.unit||'g'})</span>`;
          }
        }
      }
      updateMealTotals();
    }
  }
});

document.addEventListener('click', e => {
  const minusBtn = e.target.closest('.mealQtyMinus');
  const plusBtn = e.target.closest('.mealQtyPlus');
  if (minusBtn || plusBtn) {
    const btn = minusBtn || plusBtn;
    const idx = Number(btn.dataset.i);
    if (meal.items[idx]) {
      const step = (meal.items[idx].product.unit === 'kom') ? 1 : 5;
      if (minusBtn) meal.items[idx].qty = Math.max(0, (Number(meal.items[idx].qty) || 0) - step);
      else meal.items[idx].qty = (Number(meal.items[idx].qty) || 0) + step;
      
      const row = btn.closest('.mealIng');
      if (row) {
        const val = meal.items[idx].qty;
        const p = meal.items[idx].product;
        const inp = row.querySelector('.mealQty');
        if (inp) inp.value = val;
        const costEl = row.querySelector('.rowCost');
        if (costEl) costEl.textContent = eur(itemCost(p, val));
        const macroEl = row.querySelector('.rowMacro');
        if (macroEl) {
          if (hasNoMacros(p)) {
            macroEl.innerHTML = `<span class="quickEditMacro editProduct" data-type="${p.store ? 'favorites' : 'custom'}" data-id="${p.id}" title="Klikni za unos makroa">&#9888;&#65039; 0 kcal &middot; Upiši makrose &#9997;&#65039;</span>`;
          } else {
            const f = (p.unit === 'kom' ? val : val / 100);
            macroEl.innerHTML = `${num((Number(p.kcal)||0)*f, 0)} kcal &middot; P ${num((Number(p.protein)||0)*f)} g &middot; UH ${num((Number(p.carbs)||0)*f)} g &middot; M ${num((Number(p.fat)||0)*f)} g <span class="small" style="opacity:.75">(za ${val} ${p.unit||'g'})</span>`;
          }
        }
      }
      updateMealTotals();
    }
  }
});
$('#mealName').oninput = e => meal.name = e.target.value;
$('#mealServings').oninput = e => { meal.servings = Math.max(1, Number(e.target.value || 1)); updateMealTotals(); };

// === CATALOG SEARCH & AUTO-ENRICHMENT ===
async function searchCatalog(inp, out) {
  const q = inp.value.trim();
  if (q.length < 2) { out.innerHTML = '<div class="empty">Upiši najmanje 2 znaka.</div>'; return; }
  out.innerHTML = '<div class="empty">Pretražujem cjenike…</div>';
  
  // Uvijek osvježi najnovije favorite iz baze prije prikaza
  favorites = await dbAll('favorites');
  const normalizedRows = await dbSearchProductsWithOffers(q, 150);
  const rows = normalizedRows.map(({ product, offers }) => {
    const sorted = sortOffersByPrice(offers);
    const best = sorted[0];
    return { ...product, ...best, id: best.id, barcode: product.barcode, name: product.name, brand: product.brand, pack: product.pack || best.pack, unit: product.unit || best.unit, _offers: sorted };
  });

  // Group search results by barcode (or product identity) so user gets 1 entry with all store offers
  const groupMap = new Map();
  for (const item of rows) {
    // Runtime auto-repair za artikle koji su u prethodnoj sinkronizaciji dobili krivih 1g ili 500 kom
    if (item.pack <= 1 || (item.unit === 'kom' && /pahuljic|zoben|riza|brasno|krupica|secer|sol|tjesten|jogurt|sir\b/i.test(item.name))) {
      const fixedPack = packFromName(item.name);
      if (fixedPack) {
        item.pack = fixedPack.pack;
        item.unit = fixedPack.unit;
        if (item.price > 0 && item.pack > 0) {
          item.pricePer100 = (item.price / item.pack) * 100;
        }
      }
    }
    const key = canonicalProductKey(item);
    if (!groupMap.has(key)) groupMap.set(key, []);
    const normalizedOffers = Array.isArray(item._offers) && item._offers.length ? item._offers.map(o => ({
      ...item, ...o, id: o.id, barcode: item.barcode, name: item.name, brand: item.brand,
      pack: item.pack || o.pack, unit: item.unit || o.unit
    })) : [item];
    groupMap.get(key).push(...normalizedOffers);
  }

  // Find best offer in each group and sort groups by value per 100g (cheapest per gram first)
  const groupedProducts = [];
  for (const [key, items] of groupMap.entries()) {
    items.sort((a, b) => {
      // Inside one EAN group every row is the same physical product, so the
      // cheapest store price is the offer we should present as the default.
      if (key.startsWith('ean:')) {
        const ap = Number(a.price) || Infinity, bp = Number(b.price) || Infinity;
        if (ap !== bp) return ap - bp;
      }
      const va = getUnitValuePer100(a), vb = getUnitValuePer100(b);
      if (Number.isFinite(va) && Number.isFinite(vb) && va !== vb) return va - vb;
      return (Number(a.price) || 0) - (Number(b.price) || 0);
    });
    const best = items[0];
    groupedProducts.push({ best, offers: items, productKey: key });
  }

  groupedProducts.sort((a, b) => {
    const va = getUnitValuePer100(a.best), vb = getUnitValuePer100(b.best);
    if (Number.isFinite(va) !== Number.isFinite(vb)) return Number.isFinite(va) ? -1 : 1;
    if (Number.isFinite(va) && va !== vb) return va - vb;
    return (Number(a.best.price) || 0) - (Number(b.best.price) || 0);
  });

  // Pouzdana provjera je li artikl u favoritima po barkodu ili ponudama
  function isProductInFavorites(p, offers = [], productKey = canonicalProductKey(p)) {
    const pCode = normalizeBarcode(p.barcode);
    const offerIds = new Set(offers.map(o => o.id));

    return favorites.some(f => {
      if (productKey && f.id === productKey) return true;
      const fCode = normalizeBarcode(f.barcode);
      if (pCode && fCode === pCode) return true;
      if (offerIds.has(f.catalogId)) return true;
      return Array.isArray(f.offers) && f.offers.some(fo => offerIds.has(fo.id));
    });
  }

  out.innerHTML = groupedProducts.length ? groupedProducts.map(({ best: p, offers, productKey }) => {
    const isFav = isProductInFavorites(p, offers, productKey);
    const unitVal = formatUnitValue(p);
    const multiStore = (offers.length > 1) ? ` <span class="pill" style="font-size:11px">${offers.length} trgovine</span>` : '';
    const saleTag = p.onSale ? '<span class="saleBadgeMini">🔥 AKCIJA</span>' : '';
    const favStarBadge = isFav ? '<span class="favBadgeStar">★ U FAVORITIMA</span>' : '';

    return `
    <div class="productRow ${isFav ? 'isFavRow' : ''}">
      <div>
        <div class="name" style="display:flex;align-items:center;flex-wrap:wrap;gap:4px">
          ${isFav ? '<span style="color:#137333;font-size:16px" title="Već je u favoritima">★</span>' : ''}
          ${esc(p.name)} ${saleTag}${multiStore}${favStarBadge}
        </div>
        <div class="meta">${esc(p.brand || '')} · <b>${num(p.pack, 0)} ${esc(p.unit)}</b> · <b>${esc(p.store)}</b> ${p.barcode ? `(EAN ${esc(p.barcode)})` : ''}</div>
        <div style="margin-top:2px">${unitVal}</div>
      </div>
      <div class="price">
        <div style="font-size:15px;color:var(--accent)"><b>${eur(p.price)}</b></div>
        ${offers.length > 1 ? `<div class="sub" style="font-size:11px">najniža od ${offers.length}</div>` : ''}
      </div>
      <div class="meta">${p.pricePer100 ? eur(p.pricePer100) + ' / 100' : ''}</div>
      <div style="display:flex;gap:6px;justify-content:flex-end;align-items:center">
        <button class="favFromCatalog ${isFav ? 'isFavoriteBtn' : ''}" data-id="${esc(productKey)}" title="${isFav ? 'Već je u favoritima (klikni za ažuriranje ponuda)' : 'Dodaj u favorite'}">
          ${isFav ? '★ U favoritima' : '☆ U favorite'}
        </button>
        <button class="secondary baseToMeal" data-id="${esc(productKey)}">+ Obrok</button>
      </div>
    </div>`;
  }).join('') : '<div class="empty">Nema rezultata za traženi pojam.</div>';
}

$('#catalogSearchBtn').onclick = () => searchCatalog($('#catalogSearch'), $('#catalogResults'));
$('#catalogSearch').onkeydown = e => { if (e.key === 'Enter') searchCatalog(e.target, $('#catalogResults')); };
$('#creatorCatalogBtn').onclick = () => searchCatalog($('#creatorCatalogSearch'), $('#creatorCatalogResults'));
$('#creatorCatalogSearch').onkeydown = e => { if (e.key === 'Enter') searchCatalog(e.target, $('#creatorCatalogResults')); };

async function favoriteFromCatalog(productKey) {
  const normalized = await dbGetProductWithOffers(productKey);
  if (!normalized?.product || !normalized.offers?.length) return;

  const p = normalized.product;
  const allOffers = sortOffersByPrice(normalized.offers);
  const bestOffer = allOffers[0];

  const existingFav = favorites.find(f =>
    f.id === productKey ||
    (normalizeBarcode(p.barcode) && normalizeBarcode(f.barcode) === normalizeBarcode(p.barcode)) ||
    f.catalogId === bestOffer.id
  );

  if (existingFav) {
    existingFav.catalogId = bestOffer.id;
    existingFav.name = p.name || existingFav.name;
    existingFav.brand = p.brand || existingFav.brand || '';
    existingFav.barcode = p.barcode || existingFav.barcode || '';
    existingFav.price = bestOffer.price;
    existingFav.store = bestOffer.store;
    existingFav.pack = p.pack || bestOffer.pack;
    existingFav.unit = p.unit || bestOffer.unit;
    existingFav.pricePer100 = bestOffer.pricePer100;
    existingFav.onSale = bestOffer.onSale;
    existingFav.offers = favoriteOfferSnapshot(allOffers);
    await dbPut('favorites', existingFav);
    await propagateProductUpdate(existingFav);
    await loadAll();
    showToast(`Proizvod "${existingFav.name}" je već u favoritima. Ažurirane su cijene iz ${allOffers.length} trgovina!`);
    return existingFav;
  }

  const newFav = {
    id: productKey,
    catalogId: bestOffer.id,
    barcode: p.barcode || '',
    name: p.name || '',
    brand: p.brand || '',
    pack: p.pack || bestOffer.pack,
    unit: p.unit || bestOffer.unit,
    price: bestOffer.price,
    store: bestOffer.store,
    pricePer100: bestOffer.pricePer100,
    onSale: bestOffer.onSale,
    offers: favoriteOfferSnapshot(allOffers),
    kcal: 0, protein: 0, carbs: 0, fat: 0,
    addedAt: new Date().toISOString()
  };

  if (p.barcode) {
    showToast('Dohvaćam nutritivne podatke preko Open Food Facts…');
    const off = await fetchOffMacros(p.barcode);
    if (off) {
      Object.assign(newFav, off);
      showToast(`Makronutrijenti pronađeni za ${newFav.name}!`);
    }
  }

  await dbPut('favorites', newFav);
  favorites = await dbAll('favorites');
  renderFavorites();
  renderPicker();
  $('#favCount').textContent = `(${favorites.length})`;
  showToast(`${newFav.name} je dodan u Favorite (najniža cijena: ${eur(newFav.price)} u ${newFav.store}).`);
  return newFav;
}
async function addCatalogToMeal(cid) {
  const f = await favoriteFromCatalog(cid);
  if (!f) return;
  meal.items.push({ product: { ...f }, qty: f.unit === 'kom' ? 1 : 100 });
  $('#tabs button[data-tab="creator"]').click();
  renderMeal();
}

// === FAVORITI & MOJI PROIZVODI ===
function getUnitValuePer100(p) {
  // Runtime provjera gramaže iz naziva ako je zapisana sumnjiva količina
  let pack = Number(p.pack) || 0, unit = p.unit || 'g', price = Number(p.price) || 0;
  if (pack <= 1 || (unit === 'kom' && /pahuljic|zoben|riza|brasno|secer|sir\b/i.test(p.name))) {
    const fn = packFromName(p.name);
    if (fn) { pack = fn.pack; unit = fn.unit; }
  }
  if (pack > 0 && price > 0 && (unit === 'g' || unit === 'ml')) {
    return (price / pack) * 100;
  }
  if (Number.isFinite(p.pricePer100) && p.pricePer100 > 0 && p.pricePer100 < 100) return p.pricePer100;
  return Infinity;
}

function formatUnitValue(p) {
  const v = getUnitValuePer100(p);
  if (Number.isFinite(v) && v > 0) {
    return `<span class="unitValueBadge">⚖️ ${eur(v)} / 100 ${esc(p.unit || 'g')}</span>`;
  }
  return '';
}

function productCard(p, type) {
  const unitBadge = formatUnitValue(p);
  const saleBadge = p.onSale ? '<span class="saleBadgeMini">🔥 AKCIJA</span>' : '';
  const offers = (Array.isArray(p.offers) && p.offers.length > 1) ? p.offers : null;

  let offersHtml = '';
  if (offers) {
    offersHtml = `
    <details class="offerDetails">
      <summary>Usporedba cijena u ${offers.length} trgovine (najpovoljnije: ${esc(p.store)})</summary>
      <div style="margin-top:6px">
        ${offers.map(o => `
          <div class="offerLine">
            <span><b>${esc(o.store)}</b> ${o.onSale ? '<span class="saleBadgeMini">AKCIJA</span>' : ''}</span>
            <span><b>${eur(o.price)}</b> ${Number.isFinite(o.pricePer100) && o.pricePer100 > 0 ? `(${eur(o.pricePer100)} / 100 ${esc(p.unit || 'g')})` : ''}</span>
          </div>
        `).join('')}
      </div>
    </details>`;
  }

  return `
  <div class="item favCard">
    <div>
      <div class="name" style="font-size:15px">${esc(p.name)} ${saleBadge}</div>
      <div class="meta" style="font-size:13px">
        ${esc(p.brand || '')} · <b>${num(p.pack, 0)} ${esc(p.unit)}</b> · 
        Najniža cijena: <b style="color:var(--accent);font-size:15px">${eur(p.price)}</b> (${esc(p.store || '')})
        ${p.barcode ? ` · <span style="opacity:.8">EAN: ${esc(p.barcode)}</span>` : ''}
      </div>
      <div>${unitBadge}</div>
      <div class="macro" style="margin-top:6px">${macroText(p)}</div>
      ${offersHtml}
    </div>
    <div style="display:flex;gap:6px;align-self:start">
      <button class="secondary editProduct" data-type="${type}" data-id="${p.id}">Uredi</button>
      <button class="danger deleteProduct" data-type="${type}" data-id="${p.id}">Obriši</button>
    </div>
  </div>`;
}

function getFavoriteCategory(p) {
  if (p.category && p.category.trim() && p.category !== 'Ostalo') return p.category.trim();
  const n = norm(`${p.name || ''} ${p.brand || ''}`);
  const rules = [
    ['Mliječni proizvodi & Sir', /(jogurt|skyr|mlijek|sir\b|svjezi\b|posni|vrhnj|kefir|puding|maslac|kajmak|cottage|quark)/],
    ['Meso, Perad & Riba', /(pilet|puretin|junet|goved|svin|prsut|sunka|salama|tuna|losos|sardin|riba|oslic|bakalar|meso|file\b|odrez)/],
    ['Jaja', /(jaj)/],
    ['Žitarice, Zobene & Pekara', /(zoben|riza|riz\b|tjesten|kruh|peciv|tortil|muesli|musli|granola|pahuljic|brasno|griz)/],
    ['Voće & Povrće', /(banana|jabuk|borov|jagod|malin|rajc|paprik|krastav|brokul|mrkv|krumpir|batat|salat|luk\b|tikvic|spinat)/],
    ['Dodaci prehrani & Proteini', /(whey|protein\b|kreatin|creatine|casein|kazein|bcaa|glutamin|izolat)/],
    ['Orašasti plodovi, Sjemenke & Ulja', /(badem|orah|ljesnjak|kikiriki|chia|lan\b|ulje|maslinovo|buci)/],
    ['Umaci, Začini & Slatkiši', /(kakao|med\b|sirup|vanil|umak|senf|ketchup|cimet|sol\b|papar|cokolad|slat)/]
  ];
  for (const [cat, rx] of rules) {
    if (rx.test(n)) return cat;
  }
  return 'Ostalo';
}

function renderFavorites() {
  const q = norm($('#favoritesSearch')?.value || '');
  const sort = $('#favoritesSort')?.value || 'valueAsc';
  let rows = favorites.filter(p => !q || norm(`${p.name} ${p.brand || ''} ${p.store || ''} ${p.barcode || ''}`).includes(q));
  
  rows.sort((a, b) => {
    if (sort === 'valueAsc') {
      const va = getUnitValuePer100(a), vb = getUnitValuePer100(b);
      if (Number.isFinite(va) !== Number.isFinite(vb)) return Number.isFinite(va) ? -1 : 1;
      if (Number.isFinite(va) && va !== vb) return va - vb;
      return Number(a.price || 0) - Number(b.price || 0);
    }
    if (sort === 'name') return a.name.localeCompare(b.name, 'hr');
    if (sort === 'priceAsc') return Number(a.price || 0) - Number(b.price || 0);
    if (sort === 'priceDesc') return Number(b.price || 0) - Number(a.price || 0);
    return String(b.addedAt || '').localeCompare(String(a.addedAt || ''));
  });

  const listEl = $('#favoritesList');
  if (!rows.length) {
    listEl.innerHTML = favorites.length ? '<div class="empty">Nema favorita koji odgovaraju pretrazi.</div>' : '<div class="empty">Još nema favorita. Pretraži bazu cjenika i klikni "☆ Dodaj u favorite".</div>';
    return;
  }

  // Grupiranje favorita po kategorijama
  const catMap = new Map();
  for (const p of rows) {
    const c = getFavoriteCategory(p);
    if (!catMap.has(c)) catMap.set(c, []);
    catMap.get(c).push(p);
  }

  // Poredaj kategorije tako da 'Ostalo' ide na kraj
  const sortedCategories = [...catMap.keys()].sort((a, b) => {
    if (a === 'Ostalo') return 1;
    if (b === 'Ostalo') return -1;
    return a.localeCompare(b, 'hr');
  });

  listEl.innerHTML = sortedCategories.map(cat => {
    const items = catMap.get(cat);
    return `
    <div class="favCategorySection">
      <div class="favCategoryTitle">
        <h3>📂 ${esc(cat)}</h3>
        <span class="pill">${items.length} ${items.length === 1 ? 'namirnica' : 'namirnice'}</span>
      </div>
      <div class="cards">
        ${items.map(p => productCard(p, 'favorites')).join('')}
      </div>
    </div>`;
  }).join('');
}

function renderCustom() {
  $('#customList').innerHTML = custom.length ? custom.map(p => productCard(p, 'custom')).join('') : '<div class="empty">Nema osobnih namirnica. Klikni "+ Novi proizvod".</div>';
}

$('#addCustom').onclick = () => openProductDialog('custom');

function openProductDialog(type, pid) {
  const arr = (type === 'favorites') ? favorites : custom;
  const p = arr.find(x => x.id === pid) || {};
  $('#editType').value = type;
  $('#editId').value = p.id || '';
  $('#productDialogTitle').textContent = (type === 'favorites') ? 'Uredi Favorit' : (p.id ? 'Uredi proizvod' : 'Novi proizvod');
  
  $('#pName').value = p.name || '';
  $('#pBrand').value = p.brand || '';
  $('#pPack').value = p.pack || 100;
  $('#pUnit').value = p.unit || 'g';
  $('#pPrice').value = p.price ?? '';
  $('#pStore').value = p.store || '';
  $('#pBarcode').value = p.barcode || '';
  $('#pKcal').value = p.kcal ?? '';
  $('#pProtein').value = p.protein ?? '';
  $('#pCarbs').value = p.carbs ?? '';
  $('#pFat').value = p.fat ?? '';
  $('#macroLookupStatus').textContent = '';
  
  $('#productDialog').showModal();
}

$('#lookupOffBtn').onclick = async () => {
  const code = $('#pBarcode').value.trim();
  if (!code) return alert('Upiši barkod (EAN) proizvoda.');
  $('#macroLookupStatus').textContent = 'Tražim Open Food Facts bazu…';
  const data = await fetchOffMacros(code);
  if (data) {
    $('#pKcal').value = data.kcal;
    $('#pProtein').value = data.protein;
    $('#pCarbs').value = data.carbs;
    $('#pFat').value = data.fat;
    $('#macroLookupStatus').textContent = '✓ Makronutrijenti pronađeni!';
  } else {
    $('#macroLookupStatus').textContent = 'Barkod nije pronađen u Open Food Facts. Unesi ručno.';
  }
};

async function propagateProductUpdate(updatedObj) {
  const matches = it => {
    if (!it) return false;
    const p = it.product || {};
    return String(p.id || '') === String(updatedObj.id || '') ||
      String(it.productId || '') === String(updatedObj.id || '') ||
      String(it.productId || '') === String(updatedObj.catalogId || '') ||
      (updatedObj.barcode && String(p.barcode || it.barcode || '') === String(updatedObj.barcode));
  };
  for (const r of recipes) {
    let changed = false;
    for (const it of r.items || []) {
      if (matches(it)) {
        it.productId = updatedObj.id;
        it.product = { ...updatedObj };
        changed = true;
      }
    }
    if (changed) {
      await dbPut('recipes', r);
    }
  }
  if (dayPlan && dayPlan.blocks) {
    for (const b of dayPlan.blocks) {
      for (const it of b.items || []) {
        if (matches(it)) {
          it.productId = updatedObj.id;
          it.product = { ...updatedObj };
        }
      }
    }
    await saveDayPlan();
  }
  for (const it of meal.items || []) {
    if (matches(it)) {
      it.productId = updatedObj.id;
      it.product = { ...updatedObj };
    }
  }
}

$('#productForm').onsubmit = async e => {
  if (e.submitter?.value === 'cancel') return;
  e.preventDefault();
  const type = $('#editType').value;
  const pid = $('#editId').value || id();
  const arr = (type === 'favorites') ? favorites : custom;
  const old = arr.find(x => x.id === pid) || {};
  
  const obj = {
    ...old,
    id: pid,
    name: $('#pName').value.trim(),
    brand: $('#pBrand').value.trim(),
    pack: Number($('#pPack').value || 100),
    unit: $('#pUnit').value,
    price: Number($('#pPrice').value || 0),
    store: $('#pStore').value.trim(),
    barcode: $('#pBarcode').value.trim(),
    kcal: Number($('#pKcal').value || 0),
    protein: Number($('#pProtein').value || 0),
    carbs: Number($('#pCarbs').value || 0),
    fat: Number($('#pFat').value || 0),
    updatedAt: new Date().toISOString()
  };

  try {
    await dbPut(type, obj);
    await propagateProductUpdate(obj);
    $('#productDialog').close();
    await loadAll();
    renderMeal();
    showToast('✓ Proizvod i cijene u receptima su uspješno ažurirani!');
  } catch (err) {
    console.error('Product save error:', err);
    showToast('Spremanje proizvoda nije uspjelo.');
  }
};

// === RECEPTI ===
function renderRecipes() {
  const sortedRecipes = [...recipes].sort((a, b) => {
    const da = String(a.savedAt || a.updatedAt || '');
    const db = String(b.savedAt || b.updatedAt || '');
    return db.localeCompare(da);
  });
  $('#recipesList').innerHTML = sortedRecipes.length ? sortedRecipes.map(r => {
    const items = Array.isArray(r.items) ? r.items.map(it => ({ ...it, product: resolveMealItemProduct(it) })) : [];
    const servings = Math.max(1, Number(r.servings) || 1);
    const cost = items.reduce((s, it) => s + itemCost(it.product, Number(it.qty) || 0), 0);
    
    // Izračunaj makrose iz sastojaka
    let t = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
    for (const it of items) {
      const p = it.product, q = it.qty, f = (p.unit === 'kom' ? q : q / 100);
      t.kcal += Number(p.kcal || 0) * f;
      t.protein += Number(p.protein || 0) * f;
      t.carbs += Number(p.carbs || 0) * f;
      t.fat += Number(p.fat || 0) * f;
    }
    const sv = servings;
    const calcMacroHtml = `${num(t.kcal / sv, 0)} kcal · P ${num(t.protein / sv)}g · UH ${num(t.carbs / sv)}g · M ${num(t.fat / sv)}g / porcija`;

    // Autorski makrosi ako postoje
    let authorMacroHtml = '';
    if (r.authorMacros && (r.authorMacros.kcal || r.authorMacros.protein)) {
      const am = r.authorMacros;
      const typeLabel = am.type === 'porcija' ? 'po porciji' : (am.type === 'ukupno' ? 'ukupno' : '');
      authorMacroHtml = `
      <div style="font-size:12px;color:#087a55;margin-top:4px;font-weight:700">
        🏷️ Autorski podaci iz objave: ${am.kcal ? num(am.kcal, 0) + ' kcal' : ''} ${am.protein ? '· P ' + num(am.protein) + 'g' : ''} ${am.carbs ? '· UH ' + num(am.carbs) + 'g' : ''} ${am.fat ? '· M ' + num(am.fat) + 'g' : ''} ${typeLabel ? '(' + typeLabel + ')' : ''}
      </div>`;
    }

    // Postupak pripreme ako postoji
    let instructionsHtml = '';
    if (r.instructions && r.instructions.trim()) {
      instructionsHtml = `
      <details class="offerDetails" style="margin-top:8px">
        <summary>📝 Postupak pripreme (upute)</summary>
        <div style="white-space:pre-wrap;margin-top:6px;font-size:13px;color:var(--ink);line-height:1.4">${esc(r.instructions)}</div>
      </details>`;
    }

    return `
    <div class="item">
      <div class="viewHead" style="margin-bottom:8px">
        <div>
          <div class="name" style="font-size:16px">${esc(r.name)}</div>
          <div class="meta">${servings} porcija · ${items.length} sastojaka · <b>${eur(cost)}</b> (${eur(cost / servings)} / porciji)</div>
          <div class="macro" style="margin-top:2px">${calcMacroHtml}</div>
          ${authorMacroHtml}
        </div>
        <div style="display:flex;gap:6px;align-self:start">
          <button class="secondary loadRecipe" data-id="${r.id}">Otvori u Kreatoru</button>
          <button class="danger deleteRecipe" data-id="${r.id}">Obriši</button>
        </div>
      </div>
      <div class="recipeItems" style="font-size:12px;color:var(--muted)">
        ${items.map(x => `${num(x.qty, 0)} ${esc(x.product.unit || 'g')} ${esc(x.product.name)}`).join(' · ')}
      </div>
      ${instructionsHtml}
    </div>`;
  }).join('') : '<div class="empty">Nema spremljenih recepata. Sastavi obrok u Kreatoru ili uvezi recept s Instagrama.</div>';
}

function loadRecipe(rid) {
  const r = recipes.find(x => x.id === rid);
  if (!r) return;
  const resolvedItems = (r.items || []).map(it => ({
    ...it,
    product: resolveMealItemProduct(it)
  }));
  meal = {
    recipeId: r.id,
    name: r.name,
    servings: r.servings || 1,
    items: resolvedItems,
    instructions: r.instructions || '',
    authorMacros: r.authorMacros || null
  };
  $('#mealName').value = r.name;
  $('#mealServings').value = r.servings || 1;
  updateEditingBanner();
  $('#tabs button[data-tab="creator"]').click();
  renderMeal();
  showToast(`Otvoren recept: "${r.name}". Promjene će ga ažurirati.`);
}

// === DNEVNI PLAN (DAY PLAN) ===
function dayMetricHtml(label, val, goal, unit) {
  const pct = goal > 0 ? Math.min(100, val / goal * 100) : 0;
  const rem = goal - val;
  return `
  <div class="dayMetric">
    <div class="metricTop"><span>${label}</span><b>${num(val, label === 'KCAL' ? 0 : 1)}${unit}</b></div>
    <div class="dayBar"><i style="width:${pct}%"></i></div>
    <div class="sub" style="font-size:11px;margin-top:4px">
      ${goal > 0 ? (rem >= 0 ? `preostalo ${num(rem, label === 'KCAL' ? 0 : 1)}${unit}` : `iznad cilja ${num(Math.abs(rem), label === 'KCAL' ? 0 : 1)}${unit}`) : ''}
    </div>
  </div>`;
}

function calculateDayTotals() {
  let t = { kcal: 0, protein: 0, carbs: 0, fat: 0, price: 0 };
  for (const block of dayPlan.blocks || []) {
    for (const it of block.items || []) {
      const p = resolveMealItemProduct(it);
      it.product = p;
      const q = Number(it.qty) || 0, f = (p.unit === 'kom' ? q : q / 100);
      t.kcal += Number(p.kcal || 0) * f;
      t.protein += Number(p.protein || 0) * f;
      t.carbs += Number(p.carbs || 0) * f;
      t.fat += Number(p.fat || 0) * f;
      t.price += itemCost(p, q);
    }
  }
  return t;
}

function renderDayPlan() {
  if (!$('#dayBlocks')) return;
  const g = dayPlan.goals || { kcal: 2200, protein: 160, carbs: 220, fat: 70 };
  $('#goalProtein').value = g.protein;
  $('#goalCarbs').value = g.carbs;
  $('#goalFat').value = g.fat;
  $('#goalKcal').value = g.kcal;
  
  const s = dayPlan.settings || { kcalLocked: true, balance: 'carbs' };
  $('#macroBalance').value = s.balance || 'carbs';
  $('#lockKcal').textContent = s.kcalLocked ? '🔒 Zaključano' : '🔓 Slobodno';
  $('#goalKcal').readOnly = !s.kcalLocked;
  $('#macroModeHint').textContent = s.kcalLocked ? 'Kalorije su zaključane: promjena makroa automatski prilagođava odabranu stavku.' : 'Kalorije prate zbroj: P×4 + UH×4 + M×9.';

  const recipeOpts = '<option value="">＋ Dodaj recept…</option>' + recipes.map(r => `<option value="${r.id}">${esc(r.name)}</option>`).join('');

  $('#dayBlocks').innerHTML = (dayPlan.blocks || []).map((b, bi) => {
    let bt = { kcal: 0, protein: 0, carbs: 0, fat: 0, price: 0 };
    for (const it of b.items || []) {
      const p = resolveMealItemProduct(it);
      it.product = p;
      const q = Number(it.qty) || 0, f = (p.unit === 'kom' ? q : q / 100);
      bt.kcal += Number(p.kcal || 0) * f;
      bt.protein += Number(p.protein || 0) * f;
      bt.carbs += Number(p.carbs || 0) * f;
      bt.fat += Number(p.fat || 0) * f;
      bt.price += itemCost(p, q);
    }

    return `
    <div class="card" data-bi="${bi}">
      <div class="viewHead" style="margin-bottom:10px">
        <div>
          <b style="font-size:16px">${esc(b.name || 'Obrok')}</b>
          <div class="meta">${num(bt.kcal, 0)} kcal · P ${num(bt.protein)}g · UH ${num(bt.carbs)}g · M ${num(bt.fat)}g · <b>${eur(bt.price)}</b></div>
        </div>
        <div style="display:flex;gap:6px">
          <select class="dayAddRecipe" style="width:auto;margin:0">${recipeOpts}</select>
          <button class="danger removeBlock" data-bi="${bi}">×</button>
        </div>
      </div>
      <div>
        ${(b.items || []).map((it, ii) => {
          const p = resolveMealItemProduct(it);
          it.product = p;
          return `
          <div style="display:grid;grid-template-columns:minmax(200px,1fr) 90px 40px 80px 30px;gap:8px;align-items:center;padding:7px 0;border-bottom:1px solid #edf1f5;font-size:13px">
            <div><b>${esc(p.name)}</b> <span class="meta">${esc(p.store || '')}</span></div>
            <input class="dayQtyInput" data-bi="${bi}" data-ii="${ii}" type="number" min="0" step="any" value="${it.qty}" style="margin:0;padding:6px">
            <div style="color:var(--muted)">${esc(p.unit || 'g')}</div>
            <div class="right">${eur(itemCost(p, it.qty))}</div>
            <button class="danger removeDayItem" data-bi="${bi}" data-ii="${ii}" style="padding:4px 8px;font-size:12px">×</button>
          </div>
        `;
        }).join('') || '<div class="sub" style="padding:8px 0">Blok je prazan. Dodaj recept gore desno.</div>'}
      </div>
    </div>`;
  }).join('') || '<div class="card empty">Dnevni plan je prazan. Upiši npr. "Doručak" i dodaj blok.</div>';

  const dt = calculateDayTotals();
  $('#daySummary').innerHTML = 
    dayMetricHtml('KCAL', dt.kcal, +g.kcal || 0, '') +
    dayMetricHtml('PROTEINI', dt.protein, +g.protein || 0, ' g') +
    dayMetricHtml('UH', dt.carbs, +g.carbs || 0, ' g') +
    dayMetricHtml('MASTI', dt.fat, +g.fat || 0, ' g');

  $('#dayTotalKcal').textContent = num(dt.kcal, 0) + ' kcal';
  $('#dayTotalP').textContent = num(dt.protein) + ' g';
  $('#dayTotalC').textContent = num(dt.carbs) + ' g';
  $('#dayTotalF').textContent = num(dt.fat) + ' g';
  $('#dayTotalPrice').textContent = eur(dt.price);
}

async function saveDayPlan() {
  await dbPut('meta', { key: 'dayPlan', val: dayPlan });
}

$('#addEmptyDayBlock').onclick = async () => {
  const name = ($('#dayBlockName').value || 'Obrok').trim();
  const block = { id: Date.now(), name, items: [] };
  dayPlan.blocks.push(block);
  try {
    await saveDayPlan();
    $('#dayBlockName').value = '';
    renderDayPlan();
  } catch (err) {
    dayPlan.blocks.pop();
    console.error('Add day block error:', err);
    showToast('Dodavanje bloka nije uspjelo.');
  }
};

$('#clearDayPlan').onclick = async () => {
  if (confirm('Očistiti sve obroke iz Dnevnog plana?')) {
    const previousBlocks = dayPlan.blocks;
    dayPlan.blocks = [];
    try {
      await saveDayPlan();
      renderDayPlan();
    } catch (err) {
      dayPlan.blocks = previousBlocks;
      console.error('Clear day plan error:', err);
      showToast('Brisanje Dnevnog plana nije uspjelo.');
    }
  }
};

document.addEventListener('change', async e => {
  if (e.target.classList.contains('dayAddRecipe')) {
    const rid = e.target.value;
    if (!rid) return;
    const r = recipes.find(x => x.id === rid);
    if (!r) return;
    const bi = Number(e.target.closest('.card').dataset.bi);
    const div = Math.max(1, r.servings || 1);
    const beforeLength = dayPlan.blocks[bi].items.length;
    for (const it of r.items || []) {
      const p = resolveMealItemProduct(it);
      dayPlan.blocks[bi].items.push({
        productId: p.id || it.productId || null,
        product: { ...p },
        qty: (Number(it.qty) || 0) / div
      });
    }
    try {
      await saveDayPlan();
      renderDayPlan();
    } catch (err) {
      dayPlan.blocks[bi].items.splice(beforeLength);
      console.error('Add recipe to day plan error:', err);
      showToast('Dodavanje recepta u Dnevni plan nije uspjelo.');
    }
  }
});

document.addEventListener('input', e => {
  if (e.target.classList.contains('dayQtyInput')) {
    const bi = Number(e.target.dataset.bi), ii = Number(e.target.dataset.ii);
    const item = dayPlan.blocks?.[bi]?.items?.[ii];
    if (!item) return;
    item.qty = Math.max(0, Number(e.target.value || 0));
    // Do not rebuild the whole day plan while the user is typing: replacing the
    // input element steals focus and made multi-digit quantities feel "blocked".
  }
});

document.addEventListener('change', async e => {
  if (e.target.classList.contains('dayQtyInput')) {
    try {
      await saveDayPlan();
      renderDayPlan();
    } catch (err) {
      console.error('Day quantity save error:', err);
      showToast('Spremanje količine nije uspjelo.');
    }
  }
});

document.addEventListener('click', async e => {
  if (e.target.classList.contains('removeBlock')) {
    const bi = Number(e.target.dataset.bi);
    const removed = dayPlan.blocks.splice(bi, 1)[0];
    try {
      await saveDayPlan();
      renderDayPlan();
    } catch (err) {
      if (removed) dayPlan.blocks.splice(bi, 0, removed);
      console.error('Remove day block error:', err);
      showToast('Brisanje bloka nije uspjelo.');
    }
  }
  if (e.target.classList.contains('removeDayItem')) {
    const bi = Number(e.target.dataset.bi), ii = Number(e.target.dataset.ii);
    const removed = dayPlan.blocks[bi]?.items?.splice(ii, 1)[0];
    try {
      await saveDayPlan();
      renderDayPlan();
    } catch (err) {
      if (removed && dayPlan.blocks[bi]) dayPlan.blocks[bi].items.splice(ii, 0, removed);
      console.error('Remove day item error:', err);
      showToast('Brisanje stavke nije uspjelo.');
    }
  }
});

// Macro Balancer logic
function balanceMacros(changed) {
  const g = dayPlan.goals, target = +g.kcal || 0;
  let p = +$('#goalProtein').value || 0, c = +$('#goalCarbs').value || 0, f = +$('#goalFat').value || 0;
  let bal = dayPlan.settings.balance || 'carbs';
  if (bal === changed) {
    bal = ['carbs', 'fat', 'protein'].find(x => x !== changed);
  }
  if (bal === 'carbs') c = Math.max(0, (target - p * 4 - f * 9) / 4);
  else if (bal === 'fat') f = Math.max(0, (target - p * 4 - c * 4) / 9);
  else p = Math.max(0, (target - c * 4 - f * 9) / 4);

  $('#goalProtein').value = Math.round(p * 10) / 10;
  $('#goalCarbs').value = Math.round(c * 10) / 10;
  $('#goalFat').value = Math.round(f * 10) / 10;
  g.protein = +$('#goalProtein').value; g.carbs = +$('#goalCarbs').value; g.fat = +$('#goalFat').value;
}

function onMacroInput(type) {
  const g = dayPlan.goals, s = dayPlan.settings;
  g.protein = +$('#goalProtein').value || 0;
  g.carbs = +$('#goalCarbs').value || 0;
  g.fat = +$('#goalFat').value || 0;
  if (s.kcalLocked) balanceMacros(type);
  else { g.kcal = Math.round(g.protein * 4 + g.carbs * 4 + g.fat * 9); $('#goalKcal').value = g.kcal; }
}

function persistMacroGoals() {
  saveDayPlan()
    .then(() => renderDayPlan())
    .catch(err => {
      console.error('Day plan save error:', err);
      showToast('Nije uspjelo spremanje ciljeva.');
    });
}

$('#goalProtein').oninput = () => onMacroInput('protein');
$('#goalCarbs').oninput = () => onMacroInput('carbs');
$('#goalFat').oninput = () => onMacroInput('fat');
$('#goalProtein').onchange = persistMacroGoals;
$('#goalCarbs').onchange = persistMacroGoals;
$('#goalFat').onchange = persistMacroGoals;
$('#goalKcal').oninput = () => {
  if (!dayPlan.settings.kcalLocked) {
    dayPlan.goals.kcal = +$('#goalKcal').value || 0;
    return;
  }
  dayPlan.goals.kcal = +$('#goalKcal').value || 0;
  balanceMacros('');
};
$('#goalKcal').onchange = persistMacroGoals;
$('#lockKcal').onclick = async () => {
  const previous = dayPlan.settings.kcalLocked;
  dayPlan.settings.kcalLocked = !previous;
  try {
    await saveDayPlan();
    renderDayPlan();
  } catch (err) {
    dayPlan.settings.kcalLocked = previous;
    console.error('Kcal lock save error:', err);
    showToast('Spremanje postavke kalorija nije uspjelo.');
  }
};
$('#macroBalance').onchange = async () => {
  const previous = dayPlan.settings.balance;
  const previousGoals = { ...dayPlan.goals };
  dayPlan.settings.balance = $('#macroBalance').value;
  if (dayPlan.settings.kcalLocked) balanceMacros('');
  try {
    await saveDayPlan();
    renderDayPlan();
  } catch (err) {
    dayPlan.settings.balance = previous;
    dayPlan.goals = previousGoals;
    console.error('Macro balance save error:', err);
    showToast('Spremanje postavke makro balansa nije uspjelo.');
    renderDayPlan();
  }
};

// === SMART SHOPPING LIST ===
function generateShoppingList() {
  if (!dayPlan.blocks || !dayPlan.blocks.length) return null;
  const itemMap = new Map();

  for (const b of dayPlan.blocks) {
    for (const it of b.items || []) {
      const p = resolveMealItemProduct(it);
      it.product = p;
      const pid = p.id || it.productId || `unlinked:${norm(p.name || 'item')}`;
      const cur = itemMap.get(pid) || { product: p, qty: 0 };
      cur.qty += (Number(it.qty) || 0);
      itemMap.set(pid, cur);
    }
  }

  const storeGroups = new Map();
  for (const { product: p, qty: neededQty } of itemMap.values()) {
    if (neededQty <= 0) continue;

    // Shopping list optimizes the actual basket cost, not only €/100 g.
    // For an identical EAN, evaluate how many whole packs are needed from each
    // current offer and choose the lowest total purchase cost.
    const candidates = Array.isArray(p.offers) && p.offers.length ? p.offers : [p];
    let bestPurchase = null;
    for (const offer of candidates) {
      const packSize = Number(offer.pack) || Number(p.pack) || 100;
      const price = Number(offer.price);
      if (!(packSize > 0) || !(price >= 0)) continue;
      // neededQty and packSize use the same normalized unit. For "kom",
      // packSize can be >1 (e.g. 10 eggs), so whole-package rounding applies too.
      const packsNeeded = Math.ceil(neededQty / packSize);
      const estCost = packsNeeded * price;
      if (!bestPurchase || estCost < bestPurchase.estCost ||
          (estCost === bestPurchase.estCost && getUnitValuePer100(offer) < getUnitValuePer100(bestPurchase.offer))) {
        bestPurchase = { offer, packSize, packsNeeded, estCost };
      }
    }
    if (!bestPurchase) continue;

    const offer = bestPurchase.offer;
    const storeName = offer.store || p.store || 'Ostalo / Zaliha';
    if (!storeGroups.has(storeName)) storeGroups.set(storeName, []);
    storeGroups.get(storeName).push({
      name: p.name,
      neededQty,
      packSize: bestPurchase.packSize,
      unit: offer.unit || p.unit || 'g',
      packsNeeded: bestPurchase.packsNeeded,
      pricePerPack: Number(offer.price) || 0,
      estCost: bestPurchase.estCost
    });
  }
  return storeGroups;
}

function renderShoppingList() {
  const host = $('#shopListContainer');
  if (!host) return;
  const groups = generateShoppingList();
  if (!groups || groups.size === 0) {
    host.innerHTML = '<div class="card empty">Dnevni plan je prazan. Dodaj obroke u Dnevni plan kako bi se automatski složio popis za dućan.</div>';
    return;
  }

  let grandTotal = 0;
  let html = '';

  for (const [storeName, items] of groups.entries()) {
    const storeTotal = items.reduce((s, it) => s + it.estCost, 0);
    grandTotal += storeTotal;

    html += `
    <div class="card">
      <div class="viewHead" style="border-bottom:1px solid var(--line);padding-bottom:8px;margin-bottom:10px">
        <h3 style="margin:0">🏬 ${esc(storeName)}</h3>
        <b style="font-size:16px;color:var(--accent)">${eur(storeTotal)}</b>
      </div>
      <table class="table">
        <thead>
          <tr>
            <th>Namirnica</th>
            <th class="right">Receptura</th>
            <th class="right">Kupiti pakiranja</th>
            <th class="right">Cijena</th>
            <th class="right">Ukupno</th>
          </tr>
        </thead>
        <tbody>
          ${items.map(it => `
            <tr>
              <td><b>${esc(it.name)}</b></td>
              <td class="right">${num(it.neededQty, 0)} ${esc(it.unit)}</td>
              <td class="right"><b>${it.packsNeeded} ×</b> ${num(it.packSize, 0)} ${esc(it.unit)}</td>
              <td class="right">${eur(it.pricePerPack)}</td>
              <td class="right"><b>${eur(it.estCost)}</b></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>`;
  }

  html += `
  <div class="card" style="background:#eaf2f9;text-align:right">
    <span style="font-size:14px;font-weight:700;margin-right:12px">UKUPNA PROCJENA KUPOVINE:</span>
    <b style="font-size:22px;color:var(--accent)">${eur(grandTotal)}</b>
  </div>`;

  host.innerHTML = html;
}

$('#refreshShopList').onclick = renderShoppingList;

$('#copyShopList').onclick = () => {
  const groups = generateShoppingList();
  if (!groups || groups.size === 0) return alert('Nema stavki za kopiranje.');
  let text = '🛒 POPIS ZA KUPOVINU\n\n';
  let total = 0;
  for (const [storeName, items] of groups.entries()) {
    text += `🏬 ${storeName}\n`;
    items.forEach(it => {
      text += ` • ${it.name}: ${it.packsNeeded}x (${it.neededQty} ${it.unit}) = ${eur(it.estCost)}\n`;
    });
    const sub = items.reduce((s, it) => s + it.estCost, 0);
    text += `  Ukupno: ${eur(sub)}\n\n`;
    total += sub;
  }
  text += `UKUPNO: ${eur(total)}`;

  navigator.clipboard.writeText(text).then(() => {
    showToast('Popis za kupovinu je kopiran u međuspremnik!');
  }).catch(err => {
    console.error('Shopping list clipboard error:', err);
    showToast('Kopiranje popisa nije uspjelo.');
  });
};

// === SINKRONIZACIJA CIJENE.DEV ===
$('#syncBtn').onclick = () => $('#syncDialog').showModal();
$('#quickSyncBtn').onclick = () => $('#syncDialog').showModal();
$('#syncCancel').onclick = () => $('#syncDialog').close();

$('#chainChecks').innerHTML = Object.entries(CHAINS).map(([k, v]) => `
  <label><input type="checkbox" value="${k}" ${['konzum', 'lidl', 'spar', 'plodine', 'tommy', 'eurospin', 'kaufland'].includes(k) ? 'checked' : ''}>${v}</label>
`).join('');

async function fetchWithCorsFallback(url, options = {}) {
  // 1. Probaj direktno (za Chrome ekstenziju ili ako server dopusti CORS)
  try {
    const r = await fetch(url, options);
    if (r.ok) return r;
  } catch (e) {
    console.warn('Direktni fetch nije uspio, isprobavam proxy 1...', e);
  }

  // 2. Proxy 1: corsproxy.io
  try {
    const p1 = 'https://corsproxy.io/?' + encodeURIComponent(url);
    const r1 = await fetch(p1, options);
    if (r1.ok) return r1;
  } catch (e) {
    console.warn('Proxy 1 nije uspio, isprobavam proxy 2...', e);
  }

  // 3. Proxy 2: allorigins.win
  try {
    const p2 = 'https://api.allorigins.win/raw?url=' + encodeURIComponent(url);
    const r2 = await fetch(p2, options);
    if (r2.ok) return r2;
  } catch (e) {
    console.warn('Proxy 2 nije uspio...', e);
  }

  throw Error('Neuspješno dohvaćanje podataka (CORS blokada ili prekid veze).');
}

$('#syncStart').onclick = async () => {
  const chains = $$('#chainChecks input:checked').map(x => x.value);
  if (!chains.length) return alert('Odaberi barem jedan lanac.');
  const log = m => { $('#syncProgress').textContent = m; };

  try {
    log('Dohvaćam popis arhiva s api.cijene.dev…');
    const lr = await fetchWithCorsFallback('https://api.cijene.dev/v0/list');
    if (!lr.ok) throw Error('HTTP ' + lr.status);
    const list = await lr.json(), latest = newestArchive(list.archives);
    if (!latest?.url) throw Error('Nema dostupnih arhiva.');

    const usingManualZip = !!manualZipBuffer;
    let buf = manualZipBuffer;
    if (!buf) {
      log(`Preuzimam arhivu ${latest.date}…`);
      const zr = await fetchWithCorsFallback(latest.url);
      if (!zr.ok) throw Error('Greška pri preuzimanju arhive: HTTP ' + zr.status);
      buf = await zr.arrayBuffer();
    } else {
      log('Koristim ručno učitani ZIP...');
    }

    log(`ZIP ${(buf.byteLength / 1024 / 1024).toFixed(1)} MB. Otvaram odabrane lance…`);
    const wanted = n => chains.some(c => n === `${c}/products.csv` || n === `${c}/prices.csv`);
    const files = await readZipFiles(buf, wanted);

    const all = [];
    const missingChains = [];
    for (const chain of chains) {
      const pt = files[`${chain}/products.csv`], pr = files[`${chain}/prices.csv`];
      if (!pt || !pr) {
        missingChains.push(CHAINS[chain] || chain);
        continue;
      }
      log(`Obrađujem ${CHAINS[chain]}…`);
      const prices = parseCsv(pr), best = new Map();
      for (let i = 1; i < prices.length; i++) {
        const c = prices[i], pid = (c[1] || '').trim();
        const regular = nval(c[2]), special = nval(c[6]);
        // A sale price is valid only when it is a positive amount. Zero/blank
        // must not replace the regular price or mark an item as discounted.
        const hasSpecial = Number.isFinite(special) && special > 0;
        const price = hasSpecial ? special : regular;
        if (!pid || !(price > 0)) continue;
        const prev = best.get(pid);
        if (!prev || price < prev.price) best.set(pid, { price, ppu: nval(c[3]), sale: hasSpecial });
      }
      const products = parseCsv(pt);
      for (let i = 1; i < products.length; i++) {
        const c = products[i], pid = (c[0] || '').trim(), name = (c[2] || '').trim(), bp = best.get(pid);
        if (!pid || !name || !bp) continue;
        const pu = calcSmartPack(c[6], c[5], name, bp.price, bp.ppu), barcode = normalizeBarcode(c[1]), search = norm(`${name} ${c[3] || ''} ${barcode}`);
        all.push({
          id: `${chain}:${pid}`, externalId: pid, barcode, name,
          brand: (c[3] || '').trim(), pack: pu.pack, unit: pu.unit, price: bp.price,
          pricePer100: (pu.unit === 'g' || pu.unit === 'ml') ? (bp.price / pu.pack * 100) : null,
          onSale: bp.sale, store: CHAINS[chain], search, tokens: tokens(search)
        });
      }
    }

    if (!all.length) throw Error('U odabranim lancima nisu pronađeni valjani artikli. Postojeća baza nije promijenjena.');
    if (missingChains.length) log(`Upozorenje: ZIP nema potpune CSV podatke za: ${missingChains.join(', ')}. Ti lanci nisu ažurirani.`);
    // Build the normalized model directly. We no longer persist the raw
    // per-store catalog, avoiding a duplicate copy of the same cijene.dev data.
    const normalized = buildNormalizedCatalogModel(all);
    log(`Spremam ${normalized.products.length.toLocaleString('hr-HR')} proizvoda i ${normalized.offers.length.toLocaleString('hr-HR')} aktualnih ponuda…`);
    const syncStamp = new Date().toISOString();
    const modelStats = await dbSyncCatalogModel(normalized.products, normalized.offers, syncStamp);
    const prunedHistory = await dbPrunePriceHistory(30);
    log(`Model: ${modelStats.products.toLocaleString('hr-HR')} proizvoda · ${modelStats.offers.toLocaleString('hr-HR')} aktualnih ponuda · ${modelStats.priceChanges.toLocaleString('hr-HR')} promjena cijene · ${modelStats.removedOffers.toLocaleString('hr-HR')} nestalih ponuda`);
    if (prunedHistory) log(`Povijest cijena: uklonjeno ${prunedHistory.toLocaleString('hr-HR')} zastarjelih zapisa (zadržano najviše 30 promjena po ponudi).`);

    // Refresh favorites from the normalized in-memory model without rebuilding
    // a second raw catalog copy.
    const productByKey = new Map(normalized.products.map(p => [p.id, p]));
    const offersByKey = new Map();
    for (const offer of normalized.offers) {
      if (!offersByKey.has(offer.productKey)) offersByKey.set(offer.productKey, []);
      offersByKey.get(offer.productKey).push(offer);
    }
    for (const f of favorites) {
      const productKey = f.id?.startsWith('ean:') || f.id?.startsWith('source:')
        ? f.id
        : (normalizeBarcode(f.barcode) ? `ean:${normalizeBarcode(f.barcode)}` : '');
      if (!productKey) continue;
      const product = productByKey.get(productKey);
      let offers = offersByKey.get(productKey) || [];
      if (!product || !offers.length) continue;
      offers = sortOffersByPrice(offers);
      const best = offers[0];
      Object.assign(f, {
        catalogId: best.id,
        barcode: product.barcode || f.barcode || '',
        name: product.name || f.name,
        brand: product.brand || f.brand || '',
        price: best.price,
        store: best.store,
        pack: product.pack || best.pack,
        unit: product.unit || best.unit,
        pricePer100: best.pricePer100,
        onSale: best.onSale,
        offers: favoriteOfferSnapshot(offers)
      });
      await dbPut('favorites', f);
      await propagateProductUpdate(f);
    }

    await dbPut('meta', { key: 'sync', date: latest.date, count: all.length, products: modelStats.products, offers: modelStats.offers, priceChanges: modelStats.priceChanges, removedOffers: modelStats.removedOffers, missingChains, syncedAt: syncStamp });
    await loadAll();
    log(`Gotovo! Baza sadrži ${all.length.toLocaleString('hr-HR')} ažuriranih artikala.`);
    if (usingManualZip) {
      manualZipBuffer = null;
      const manualInput = $('#manualZip');
      if (manualInput) manualInput.value = '';
      log('Ručni ZIP je potrošen i uklonjen iz memorije.');
    }
    showToast(missingChains.length ? 'Baza je ažurirana, ali dio odabranih lanaca nije bio dostupan u ZIP-u.' : 'Baza cijena je uspješno ažurirana!');
    setTimeout(() => $('#syncDialog').close(), 1200);
  } catch (err) {
    console.error(err);
    log('Greška: ' + err.message);
  }
};

// === INSTAGRAM IMPORTER ===
let igParsedItems = [];

function cleanEmoji(s) {
  return String(s || '').replace(/^[\p{Extended_Pictographic}\s]+/gu, '').trim();
}

function isMarketing(s) {
  return /(comment\s+the\s+word|link\s+in\s+bio|follow\s+(me|for)|save\s+this|DM\s+me|subscribe|like\s+and\s+share|zaprati|spremi(?:te)?\s+(?:si\s+)?recept|vaučer|kupon|popust)/iu.test(s);
}

function parseMacroType(text) {
  if (/(?:po\s+porciji|per\s+serving|per\s+portion|pro\s+portion)/iu.test(text)) return 'porcija';
  if (/(?:nutritivne\s+vrijednosti|makrosi?|macros?|nutrition(?:al)?\s+values?)\s*\(\s*1\s+(?:porcija|serving|portion)\s*\)/iu.test(text)) return 'porcija';
  if (/\(\s*1\s+(?:porcija|serving|portion)\s*\)/iu.test(text)) return 'porcija';
  if (/(?:ukupno|ukupna|total|full\s+recipe|cijeli\s+recept)/iu.test(text)) return 'ukupno';
  return 'porcija';
}

function parseMacros(text) {
  const r = { kcal: null, protein: null, carbs: null, fat: null };
  let m;
  // A: 3414 kcal // 327 g UH · 248 g P · 109 g M
  m = text.match(/(\d{2,4})\s*kcal\s*\/\/\s*(\d+(?:[.,]\d+)?)\s*g?\s*UH\s*[·•]\s*(\d+(?:[.,]\d+)?)\s*g?\s*P\s*[·•]\s*(\d+(?:[.,]\d+)?)\s*g?\s*M/iu);
  if (m) { r.kcal = +m[1]; r.carbs = nval(m[2]); r.protein = nval(m[3]); r.fat = nval(m[4]); return r; }
  
  // B: (505kcal uh:37g m:15g p:53g)
  m = text.match(/\(?\s*(\d{2,4})\s*kcal\s+uh\s*:?\s*(\d+(?:[.,]\d+)?)\s*g?\s+m\s*:?\s*(\d+(?:[.,]\d+)?)\s*g?\s+p\s*:?\s*(\d+(?:[.,]\d+)?)\s*g?/iu);
  if (m) { r.kcal = +m[1]; r.carbs = nval(m[2]); r.fat = nval(m[3]); r.protein = nval(m[4]); return r; }

  // C: Croatian/Balkan standard: 250 kcal - 30g proteina, 20g uh, 5g masti
  m = text.match(/(\d{2,4})\s*kcal\s*[-–]\s*(\d+(?:[.,]\d+)?)\s*g?\s*(?:p|prot|proteina)[,\s]+(\d+(?:[.,]\d+)?)\s*g?\s*(?:uh|c|ugljikohidrata)[,\s]+(\d+(?:[.,]\d+)?)\s*g?\s*(?:m|fat|masti)/iu);
  if (m) { r.kcal = +m[1]; r.protein = nval(m[2]); r.carbs = nval(m[3]); r.fat = nval(m[4]); return r; }

  // D: Line by line / bullet patterns (Energija: ~340 kcal, Proteini: 18g...)
  const lineMaps = {
    kcal: /(?:energija|energy|kalorije|calories?)\s*:\s*~?\s*(\d+(?:[.,]\d+)?)\s*(?:kcal|cal|cals?)?/iu,
    protein: /(?:proteini?|protein[s]?|eiweiß|beljakovine?|\bP\b)\s*:\s*~?\s*(\d+(?:[.,]\d+)?)\s*g?/iu,
    carbs: /(?:ugljikohidrati?|uh|carbs?|carbohydrates?|kohlenhydrate|\bC\b)\s*:\s*~?\s*(\d+(?:[.,]\d+)?)\s*g?/iu,
    fat: /(?:masti?|fat[s]?|fett|\bM\b)\s*:\s*~?\s*(\d+(?:[.,]\d+)?)\s*g?/iu
  };
  let hit = false;
  for (const [k, re] of Object.entries(lineMaps)) {
    const z = text.match(re);
    if (z) { r[k] = nval(z[1]); hit = true; }
  }
  if (hit) return r;

  // Generic fallback patterns
  const maps = {
    kcal: /(?:calories?|kcal|kalorij|cals?)\s*[:\-]?\s*(\d{2,4})/iu,
    protein: /(?:protein[s]?|proteina|\bP\b|Eiweiß|beljakovin)\s*[:\-]?\s*(\d+(?:[.,]\d+)?)/iu,
    carbs: /(?:carbs?|carbohydrates?|ugljikohidrata?|\bUH\b|Kohlenhydrate)\s*[:\-]?\s*(\d+(?:[.,]\d+)?)/iu,
    fat: /(?:fat[s]?|masti?|mast\b|\bFa\b|Fett)\s*[:\-]?\s*(\d+(?:[.,]\d+)?)/iu
  };
  for (const [k, re] of Object.entries(maps)) {
    const z = text.match(re);
    if (z) r[k] = nval(z[1]);
  }
  return r;
}

// Pametno pronalaženje odgovarajućeg favorita ili osobnog proizvoda
function findBestFavoriteMatch(ingredientName) {
  const n = norm(ingredientName);
  const toks = tokens(n);
  if (!toks.length) return null;

  let best = null, maxScore = 0;
  const realCustom = custom.filter(c => !c.brand || !c.brand.includes('Instagram uvoz'));
  const pool = [...favorites.map(f => ({ item: f, type: 'fav' })), ...realCustom.map(c => ({ item: c, type: 'custom' }))];

  for (const entry of pool) {
    const fn = norm(`${entry.item.name} ${entry.item.brand || ''}`);
    let score = 0;

    for (const t of toks) {
      if (fn.includes(t)) score += 1.5;
      if (t === 'posni' && (fn.includes('svjezi') || fn.includes('sir'))) score += 1;
      if (t === 'zobene' && fn.includes('pahuljice')) score += 1;
      if (t === 'skyr' && fn.includes('skyr')) score += 2.5;
      if (t === 'whey' && fn.includes('protein')) score += 2;
      if (t === 'piletina' && (fn.includes('prsa') || fn.includes('pileci'))) score += 1.5;
      if (t === 'jaje' && fn.includes('jaj')) score += 1.5;
      if (t === 'kakao' && fn.includes('kakao')) score += 2;
    }

    if (fn.includes(n)) score += 3;
    if (n.includes(fn)) score += 2;

    if (score > maxScore && score >= 1.5) {
      maxScore = score;
      best = entry.item;
    }
  }
  return best;
}

$('#igFetchBtn').onclick = async () => {
  const url = $('#igUrl').value.trim();
  if (!/^https?:\/\/(www\.)?instagram\.com\//i.test(url)) return alert('Upiši valjani link na Instagram Reel ili objavu.');
  $('#igStatus').textContent = 'Otvaram Instagram, dohvaćam naslov videa i tekst…';
  
  try {
    const tab = await chrome.tabs.create({ url, active: false });
    await new Promise(res => {
      const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(fn); res(); }, 12000);
      const fn = (id, info) => {
        if (id === tab.id && info.status === 'complete') {
          clearTimeout(timer); chrome.tabs.onUpdated.removeListener(fn); setTimeout(res, 1500);
        }
      };
      chrome.tabs.onUpdated.addListener(fn);
    });

    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const metas = [...document.querySelectorAll('meta[property="og:description"],meta[name="description"]')].map(x => x.content).filter(Boolean);
        const ogTitle = document.querySelector('meta[property="og:title"]')?.content || '';
        const pageTitle = document.title || '';
        const article = [...document.querySelectorAll('article span')].map(x => x.innerText).filter(t => t && t.length > 30);
        return {
          meta: metas[0] || '',
          article: article[0] || '',
          body: document.body?.innerText?.slice(0, 20000) || '',
          ogTitle,
          pageTitle
        };
      }
    });

    try { await chrome.tabs.remove(tab.id); } catch (_) {}

    if (!result) throw Error('Tekst objave nije pronađen.');
    
    // Izdvajanje čistog naslova videa
    let videoTitle = '';
    const rawTitle = result.ogTitle || result.pageTitle || '';
    const quoteMatch = rawTitle.match(/[:\-]\s*[“"']([^"”']{4,100})[”"']/);
    if (quoteMatch) {
      videoTitle = cleanEmoji(quoteMatch[1]);
    } else if (rawTitle && !rawTitle.toLowerCase().includes('instagram')) {
      videoTitle = cleanEmoji(rawTitle.split(/[|•-]/)[0]).trim();
    }

    let captionText = result.article || result.meta || '';
    // Instagram OG description often wraps caption in: "X likes, Y comments - account on date: "caption""
    const qm = captionText.match(/[:\-]\s*[“"]([\s\S]+)[”"]\s*$/);
    if (qm) captionText = qm[1];
    if (!captionText || captionText.length < 20) captionText = result.body;

    $('#igCaption').value = captionText;
    parseInstagramCaption(captionText, videoTitle);
    $('#igPreview').style.display = 'block';
    $('#igStatus').textContent = '✓ Objava i naslov videa uspješno dohvaćeni.';
  } catch (err) {
    console.error(err);
    $('#igStatus').textContent = 'Nije uspjelo automatsko čitanje objave. Provjeri jesi li prijavljen na Instagram u Chromeu ili zalijepi tekst ručno u polje ispod.';
    $('#igPreview').style.display = 'block';
  }
};

function renderIgIngredients() {
  const listEl = $('#igIngredientsList');
  if (!listEl) return;
  if (!igParsedItems.length) {
    listEl.innerHTML = '<div class="empty" style="padding:14px">Nema sastojaka. Klikni gumb "＋ Dodaj sastojak" iznad.</div>';
    return;
  }

  const favOpts = [
    '<option value="">-- Nije spojeno (spoji kasnije) --</option>',
    ...favorites.map(f => `<option value="${f.id}">⭐ ${esc(f.name)} (${eur(f.price)})</option>`),
    ...custom.map(c => `<option value="${c.id}">👤 ${esc(c.name)}</option>`)
  ].join('');

  listEl.innerHTML = `
    <div style="display:grid;grid-template-columns:minmax(180px,1fr) minmax(220px,1.2fr) 85px 70px 38px;gap:8px;padding:4px 0;font-size:12px;color:var(--muted);font-weight:700">
      <span>Tekst iz objave</span>
      <span>Povezani Favorit / Proizvod</span>
      <span>Količina</span>
      <span>Jedinica</span>
      <span></span>
    </div>
    ${igParsedItems.map((it, i) => {
      const isMatched = !!it.matchedProductId;
      return `
      <div class="igRow" data-i="${i}">
        <div>
          <input class="igNameInput" data-i="${i}" value="${esc(it.name)}" placeholder="npr. Skyr, posni sir">
          <div style="margin-top:2px">
            ${isMatched 
              ? '<span class="matchBadgeOk">✓ Automatski spojeno s favoritom</span>' 
              : '<span class="matchBadgePending">⚠ Nije u favoritima (spoji ili ostavi)</span>'}
          </div>
        </div>
        <div>
          <select class="igMatchSelect" data-i="${i}">
            <option value="">-- Nije spojeno (spoji kasnije) --</option>
            ${favorites.map(f => `<option value="${f.id}" ${it.matchedProductId === f.id ? 'selected' : ''}>⭐ ${esc(f.name)} (${eur(f.price)})</option>`).join('')}
            ${custom.map(c => `<option value="${c.id}" ${it.matchedProductId === c.id ? 'selected' : ''}>👤 ${esc(c.name)}</option>`).join('')}
          </select>
        </div>
        <input class="igQtyInput" data-i="${i}" type="number" min="0" step="any" value="${it.qty}" placeholder="Količina">
        <select class="igUnitSelect" data-i="${i}">
          <option value="g" ${it.unit === 'g' ? 'selected' : ''}>g</option>
          <option value="ml" ${it.unit === 'ml' ? 'selected' : ''}>ml</option>
          <option value="kom" ${it.unit === 'kom' ? 'selected' : ''}>kom</option>
        </select>
        <button class="danger igDelBtn" data-i="${i}" style="padding:6px 0;text-align:center" title="Obriši ovaj sastojak">×</button>
      </div>`;
    }).join('')}
  `;
}

function parseInstagramCaption(text, videoTitle = '') {
  const lines = text.split('\n').map(x => x.trim()).filter(Boolean);
  
  // 1. Naziv recepta: prednost ima naslov videa, inače prvi smisleni redak
  let finalTitle = videoTitle;
  if (!finalTitle || finalTitle.length < 4) {
    for (const l of lines) {
      if (!isMarketing(l) && !/^#/.test(l) && l.length >= 4) {
        finalTitle = cleanEmoji(l).slice(0, 100);
        break;
      }
    }
  }
  $('#igTitle').value = finalTitle || 'Instagram recept';

  // 2. Broj porcija
  let servings = 1;
  const sm = text.match(/(?:makes?|serves?|servings?|porcij[ae]?|osob[ae]?|za)\s*\(?\s*(\d+)/iu);
  if (sm) servings = +sm[1] || 1;
  $('#igServings').value = servings;

  // 3. Autorski makrosi
  const mac = parseMacros(text);
  const mType = parseMacroType(text);
  $('#igMacroType').value = mType;
  $('#igMacroKcal').value = mac.kcal ?? '';
  $('#igMacroProtein').value = mac.protein ?? '';
  $('#igMacroCarbs').value = mac.carbs ?? '';
  $('#igMacroFat').value = mac.fat ?? '';

  const foundAnyMacro = [mac.kcal, mac.protein, mac.carbs, mac.fat].some(v => v != null && v > 0);
  const stEl = $('#igMacroStatus');
  if (stEl) {
    stEl.textContent = foundAnyMacro 
      ? '✓ Pronađeni u objavi (autorska procjena)' 
      : 'Nisu pronađeni u objavi (možeš unijeti ručno)';
    stEl.style.color = foundAnyMacro ? '#087a55' : 'var(--muted)';
  }

  // 4. Parsiranje sastojaka i pripreme
  igParsedItems = [];
  let inIng = false, inMethod = false, methodLines = [];

  for (const raw of lines) {
    const l = cleanEmoji(raw), lc = l.toLowerCase();
    if (isMarketing(l) || (/^#\S/.test(l) && l.replace(/#\S+/g, '').trim() === '')) continue;
    
    // Provjeri zaglavlja sekcija
    if (/^(sastojci|namirnice|ingredients?|zutaten|potrebno|recipe)\b/iu.test(l) && l.length < 60) {
      inIng = true; inMethod = false; continue;
    }
    if (/^(priprema|postupak|upute|method|instructions?|directions?|zubereitung|kako pripremiti)\b/iu.test(l) && l.length < 60) {
      inIng = false; inMethod = true; continue;
    }

    if (inIng) {
      const parts = (l.match(/[•●▪︎]/u) ? l.split(/[•●▪︎]/u) : [l]).map(x => x.trim()).filter(Boolean);
      for (const p of parts) {
        const m = p.match(/([\d/.,\-\s½¼¾⅓⅔]+)?\s*(kg|g|ml|dl|l|dag|scoops?|cups?|tbsp|tsp|oz|lb|žlica|žlice|žličica|žličice|kom|komad[ae]?)?\s*(?:od\s+)?(.+)/iu);
        if (m) {
          let qty = Number(String(m[1] || '').replace(',', '.').trim()) || 100;
          let u = (m[2] || 'g').toLowerCase();
          if (u === 'kg' || u === 'l') { qty *= 1000; u = (u === 'kg' ? 'g' : 'ml'); }
          const name = (m[3] || p).replace(/[-*•]/g, '').trim();
          if (name.length > 1) {
            const matched = findBestFavoriteMatch(name);
            igParsedItems.push({ name, qty, unit: (u === 'ml' ? 'ml' : u === 'kom' ? 'kom' : 'g'), matchedProductId: matched ? matched.id : null });
          }
        }
      }
    } else if (inMethod) {
      if (l.length > 2) methodLines.push(l);
    } else {
      // Fallback: ako nema eksplicitnih zaglavlja, traži retke s brojkama i jedinicama
      const m = l.match(/^[-•*]?\s*([\d½¼¾⅓⅔]+(?:[\/.,]\d+)?)\s*(kg|g|ml|dl|l|scoop|cup|tbsp|tsp|žlic|kom)?\s+(.+)/iu);
      if (m && !isMarketing(l)) {
        let qty = Number(m[1].replace(',', '.')) || 100;
        let u = (m[2] || 'g').toLowerCase();
        if (u === 'kg' || u === 'l') { qty *= 1000; u = (u === 'kg' ? 'g' : 'ml'); }
        const name = m[3].replace(/[-*•]/g, '').trim();
        if (name.length > 1) {
          const matched = findBestFavoriteMatch(name);
          igParsedItems.push({ name, qty, unit: (u === 'ml' ? 'ml' : u === 'kom' ? 'kom' : 'g'), matchedProductId: matched ? matched.id : null });
        }
      }
    }
  }

  // 5. Postupak pripreme u textarea
  $('#igInstructions').value = methodLines.join('\n');

  renderIgIngredients();
}

$('#igCopyMethodBtn').onclick = () => {
  $('#igInstructions').value = $('#igCaption').value;
  showToast('Cijeli caption je kopiran u polje Priprema! Sada možeš urediti tekst.');
};

$('#igReparseBtn').onclick = () => parseInstagramCaption($('#igCaption').value, $('#igTitle').value);

$('#igAddIngBtn').onclick = () => {
  igParsedItems.push({ name: '', qty: 100, unit: 'g', matchedProductId: null });
  renderIgIngredients();
};

document.addEventListener('input', e => {
  if (e.target.classList.contains('igNameInput')) {
    const i = Number(e.target.dataset.i);
    if (igParsedItems[i]) {
      igParsedItems[i].name = e.target.value;
      const matched = findBestFavoriteMatch(e.target.value);
      if (matched && !igParsedItems[i].matchedProductId) {
        igParsedItems[i].matchedProductId = matched.id;
        const select = e.target.closest('.igRow')?.querySelector('.igMatchSelect');
        if (select) select.value = matched.id;
        const badge = e.target.closest('.igRow')?.querySelector('.matchBadgePending');
        if (badge) { badge.className = 'matchBadgeOk'; badge.textContent = '✓ Automatski spojeno s favoritom'; }
      }
    }
  }
  if (e.target.classList.contains('igQtyInput')) {
    const i = Number(e.target.dataset.i);
    if (igParsedItems[i]) igParsedItems[i].qty = Number(e.target.value) || 0;
  }
});

document.addEventListener('change', e => {
  if (e.target.classList.contains('igUnitSelect')) {
    const i = Number(e.target.dataset.i);
    if (igParsedItems[i]) igParsedItems[i].unit = e.target.value;
  }
  if (e.target.classList.contains('igMatchSelect')) {
    const i = Number(e.target.dataset.i);
    if (igParsedItems[i]) {
      igParsedItems[i].matchedProductId = e.target.value || null;
      renderIgIngredients();
    }
  }
});

document.addEventListener('click', e => {
  if (e.target.classList.contains('igDelBtn')) {
    const i = Number(e.target.dataset.i);
    igParsedItems.splice(i, 1);
    renderIgIngredients();
  }
});

async function resolveIgItems() {
  const resolved = [];
  const realCustom = custom.filter(c => !c.brand || !c.brand.includes('Instagram uvoz'));

  for (const it of igParsedItems) {
    const n = it.name.trim();
    if (!n) continue;

    let p = null;
    if (it.matchedProductId) {
      p = favorites.find(f => f.id === it.matchedProductId) || realCustom.find(c => c.id === it.matchedProductId);
    }
    if (!p) {
      p = findBestFavoriteMatch(n);
    }
    // Ako nije spojeno, stavka ostaje u receptu bez kreiranja lažnih proizvoda u bazi
    if (!p) {
      p = {
        id: 'unlinked:' + id(),
        name: n,
        brand: '',
        pack: 100,
        unit: it.unit || 'g',
        price: 0,
        store: '',
        kcal: 0, protein: 0, carbs: 0, fat: 0
      };
    }
    resolved.push({ product: p, qty: it.qty || (it.unit === 'kom' ? 1 : 100) });
  }
  return resolved;
}

$('#igSaveBtn').onclick = async () => {
  const title = $('#igTitle').value.trim() || 'Instagram recept';
  const serv = Math.max(1, Number($('#igServings').value || 1));
  const resolvedItems = await resolveIgItems();
  
  if (!resolvedItems.length) return alert('Dodaj barem jedan valjani sastojak.');

  const authorMacros = {
    type: $('#igMacroType').value,
    kcal: nval($('#igMacroKcal').value),
    protein: nval($('#igMacroProtein').value),
    carbs: nval($('#igMacroCarbs').value),
    fat: nval($('#igMacroFat').value)
  };

  const r = {
    id: id(),
    name: title,
    servings: serv,
    items: resolvedItems,
    instructions: $('#igInstructions').value.trim(),
    authorMacros,
    savedAt: new Date().toISOString()
  };

  try {
    await dbPut('recipes', r);
    recipes = await dbAll('recipes');
    renderRecipes();
    $('#recipeCount').textContent = `(${recipes.length})`;
    showToast(`Recept "${title}" je uspješno spremljen s uputama i makrosima!`);
    $('#tabs button[data-tab="recipes"]').click();
  } catch (err) {
    console.error('Instagram recipe save error:', err);
    showToast('Spremanje uvezenog recepta nije uspjelo.');
  }
};

$('#igOpenInCreatorBtn').onclick = async () => {
  const title = $('#igTitle').value.trim() || 'Instagram recept';
  const serv = Math.max(1, Number($('#igServings').value || 1));
  const resolvedItems = await resolveIgItems();
  
  if (!resolvedItems.length) return alert('Dodaj barem jedan valjani sastojak.');

  meal = { recipeId: null, name: title, servings: serv, items: resolvedItems };
  $('#mealName').value = title;
  $('#mealServings').value = serv;
  updateEditingBanner();
  renderMeal();
  showToast('Recept je otvoren u Kreatoru obroka!');
  $('#tabs button[data-tab="creator"]').click();
};

// === BACKUP (IMPORT / EXPORT JSON) ===
$('#exportBackupBtn').onclick = async () => {
  try {
    const payload = {
      format: 'CijeneMealProBackupV2',
      exportedAt: new Date().toISOString(),
      favorites: await dbAll('favorites'),
      custom: await dbAll('custom'),
      recipes: await dbAll('recipes'),
      dayPlan
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cijenemeal-pro-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    $('#backupStatus').textContent = '✓ Backup datoteka je uspješno preuzeta.';
  } catch (err) {
    console.error('Backup export error:', err);
    $('#backupStatus').textContent = 'Greška pri izradi backupa.';
    showToast('Izrada backup datoteke nije uspjela.');
  }
};

$('#importBackupBtn').onclick = () => $('#backupFileInput').click();
$('#backupFileInput').onchange = async e => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (!data || !Array.isArray(data.favorites) || !Array.isArray(data.recipes) || (data.custom != null && !Array.isArray(data.custom))) {
      throw Error('Neispravan format backup datoteke.');
    }
    const validRecord = x => x && typeof x === 'object' && !Array.isArray(x) && x.id != null;
    if (!data.favorites.every(validRecord) || !(data.custom || []).every(validRecord) || !data.recipes.every(validRecord)) {
      throw Error('Backup sadrži neispravne zapise.');
    }
    if (!confirm(`Učitavanjem backupa zamijenit će se osobni favoriti (${data.favorites.length}) i recepti (${data.recipes.length}). Nastaviti?`)) return;

    // Validate the full payload before destructive clears. A malformed backup must
    // never erase working local data before we discover the problem.
    const incomingFavorites = structuredClone(data.favorites);
    const incomingCustom = structuredClone(data.custom || []);
    const incomingRecipes = structuredClone(data.recipes);

    // One IndexedDB transaction: personal stores and Day Plan are restored
    // together, so a failed import cannot leave a half-restored backup.
    const incomingDayPlan = data.dayPlan ? structuredClone(data.dayPlan) : undefined;
    await dbRestorePersonalData({
      favorites: incomingFavorites,
      custom: incomingCustom,
      recipes: incomingRecipes
    }, incomingDayPlan);
    if (incomingDayPlan !== undefined) dayPlan = incomingDayPlan;
    await loadAll();
    $('#backupStatus').textContent = '✓ Backup je uspješno vraćen!';
    showToast('Podaci su uspješno vraćeni!');
  } catch (err) {
    alert('Greška pri učitavanju backupa: ' + err.message);
  } finally {
    $('#backupFileInput').value = '';
  }
};

// Initial Start
loadAll().catch(e => {
  console.error('Start error:', e);
  const syncState = $('#syncState');
  if (syncState) syncState.textContent = 'Greška pri učitavanju lokalnih podataka. Osvježi aplikaciju i pokušaj ponovno.';
  showToast('MealPro nije uspio učitati sve lokalne podatke.');
});


let manualZipBuffer = null;
document.addEventListener('change', async e => {
  if (e.target.id === 'syncZipFileInput') {
    const f = e.target.files[0];
    if (f) {
      $('#syncProgress').textContent = 'Učitavam lokalni ZIP...';
      try {
        manualZipBuffer = await f.arrayBuffer();
        $('#syncProgress').textContent = 'Lokalni ZIP je učitan! Sada klikni "Započni preuzimanje" za obradu.';
      } catch (err) {
        $('#syncProgress').textContent = 'Greška pri čitanju ZIP-a: ' + err.message;
      }
    }
  }
});



// V3.2.8 Hamburger Menu Controller
document.addEventListener('DOMContentLoaded', () => {
  const nav = $('#tabs');
  if (nav) nav.classList.add('mobileDrawer');
  
  if (!document.getElementById('mobileOverlay')) {
    const overlay = document.createElement('div');
    overlay.id = 'mobileOverlay';
    document.body.appendChild(overlay);
    
    overlay.onclick = () => {
      nav.classList.remove('open');
      overlay.classList.remove('show');
    };
  }

  const hb = $('#hamburgerBtn');
  if (hb) {
    hb.onclick = () => {
      nav.classList.toggle('open');
      $('#mobileOverlay').classList.toggle('show');
    };
  }

  // Close drawer when clicking any tab on mobile
  $$('#tabs button').forEach(b => {
    const origOnClick = b.onclick;
    b.onclick = (e) => {
      if (origOnClick) origOnClick(e);
      const navEl = $('#tabs');
      if (navEl) navEl.classList.remove('open');
      const ov = $('#mobileOverlay');
      if (ov) ov.classList.remove('show');
    };
  });
});
