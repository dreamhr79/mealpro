const DB_NAME='cijeneMealProDB',DB_VER=5;
let _db;
function openDB(){
 if(_db)return Promise.resolve(_db);
 return new Promise((res,rej)=>{
  const r=indexedDB.open(DB_NAME,DB_VER);
  r.onupgradeneeded=()=>{
   const d=r.result;
   // v5 removes the legacy raw catalog after migration to products + offers.
   if(d.objectStoreNames.contains('catalog'))d.deleteObjectStore('catalog');
   if(!d.objectStoreNames.contains('favorites'))d.createObjectStore('favorites',{keyPath:'id'});
   if(!d.objectStoreNames.contains('custom'))d.createObjectStore('custom',{keyPath:'id'});
   if(!d.objectStoreNames.contains('recipes'))d.createObjectStore('recipes',{keyPath:'id'});
   if(!d.objectStoreNames.contains('meta'))d.createObjectStore('meta',{keyPath:'key'});
   if(!d.objectStoreNames.contains('nutritionOverlay'))d.createObjectStore('nutritionOverlay',{keyPath:'key'});
   if(!d.objectStoreNames.contains('priceHistory'))d.createObjectStore('priceHistory',{keyPath:'id',autoIncrement:true});
   if(!d.objectStoreNames.contains('products')){
    const products=d.createObjectStore('products',{keyPath:'id'});
    products.createIndex('barcode','barcode',{unique:false});
    products.createIndex('tokens','tokens',{multiEntry:true});
   }else{
    const products=r.transaction.objectStore('products');
    if(!products.indexNames.contains('tokens'))products.createIndex('tokens','tokens',{multiEntry:true});
   }
   if(!d.objectStoreNames.contains('offers')){
    const offers=d.createObjectStore('offers',{keyPath:'id'});
    offers.createIndex('productKey','productKey',{unique:false});
    offers.createIndex('store','store',{unique:false});
   }
  };
  r.onsuccess=()=>{
   _db=r.result;
   _db.onversionchange=()=>{_db.close();_db=null};
   res(_db);
  };
  r.onblocked=()=>rej(Error('Baza je otvorena u drugoj kartici. Zatvori druge kartice ekstenzije i pokušaj ponovno.'));
  r.onerror=()=>rej(r.error);
 });
}
async function dbAll(store){const d=await openDB();return new Promise((res,rej)=>{const r=d.transaction(store).objectStore(store).getAll();r.onsuccess=()=>res(r.result||[]);r.onerror=()=>rej(r.error)})}
async function dbGet(store,key){const d=await openDB();return new Promise((res,rej)=>{const r=d.transaction(store).objectStore(store).get(key);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
async function dbPut(store,val){const d=await openDB();return new Promise((res,rej)=>{const r=d.transaction(store,'readwrite').objectStore(store).put(val);r.onsuccess=()=>res(val);r.onerror=()=>rej(r.error)})}
async function dbDelete(store,key){const d=await openDB();return new Promise((res,rej)=>{const r=d.transaction(store,'readwrite').objectStore(store).delete(key);r.onsuccess=()=>res();r.onerror=()=>rej(r.error)})}
async function dbClear(store){const d=await openDB();return new Promise((res,rej)=>{const r=d.transaction(store,'readwrite').objectStore(store).clear();r.onsuccess=()=>res();r.onerror=()=>rej(r.error)})}
async function dbBulkPut(store,rows,onProgress){
 const d=await openDB(),chunk=1500;
 for(let i=0;i<rows.length;i+=chunk){
  await new Promise((res,rej)=>{
   const tx=d.transaction(store,'readwrite'),os=tx.objectStore(store);
   for(const x of rows.slice(i,i+chunk))os.put(x);
   tx.oncomplete=res;tx.onerror=()=>rej(tx.error);
  });
  onProgress?.(Math.min(i+chunk,rows.length),rows.length);
  await new Promise(r=>setTimeout(r,0));
 }
}
async function dbReplaceStore(store,rows,onProgress){
 const d=await openDB();
 return new Promise((res,rej)=>{
  const tx=d.transaction(store,'readwrite'),os=tx.objectStore(store);
  os.clear();
  let done=0;
  for(const row of rows||[]){
   const req=os.put(row);
   req.onsuccess=()=>{
    done++;
    if(done%1500===0||done===rows.length)onProgress?.(done,rows.length);
   };
  }
  tx.oncomplete=()=>res();
  tx.onerror=()=>rej(tx.error||Error('Transakcija zamjene baze nije uspjela.'));
  tx.onabort=()=>rej(tx.error||Error('Transakcija zamjene baze je prekinuta.'));
 });
}
async function dbSearchProducts(q,limit=80){
 const words=norm(q).split(/\s+/).filter(Boolean);
 if(!words.length)return [];
 const d=await openDB(),idx=d.transaction('products').objectStore('products').index('tokens');
 const prefix=words[0],range=IDBKeyRange.bound(prefix,prefix+'\uffff'),rows=[];
 return new Promise((res,rej)=>{
  const req=idx.openCursor(range);
  req.onsuccess=()=>{
   const cur=req.result;
   if(!cur||rows.length>=450){
    const out=[];
    for(const x of rows){
     if(!words.every(w=>(x.search||'').includes(w)))continue;
     out.push(x);
     if(out.length>=limit)break;
    }
    res(out);return;
   }
   rows.push(cur.value);cur.continue();
  };
  req.onerror=()=>rej(req.error||Error('Greška pri pretraživanju proizvoda.'));
 });
}

async function dbSearchProductsWithOffers(q,limit=80){
 const products=await dbSearchProducts(q,limit);
 if(!products.length)return [];
 const d=await openDB();
 const grouped=new Map();
 await new Promise((res,rej)=>{
  const tx=d.transaction('offers','readonly');
  const index=tx.objectStore('offers').index('productKey');
  for(const product of products){
   const req=index.getAll(IDBKeyRange.only(product.id));
   req.onsuccess=()=>grouped.set(product.id,req.result||[]);
   req.onerror=()=>tx.abort();
  }
  tx.oncomplete=()=>res();
  tx.onerror=()=>rej(tx.error||Error('Dohvat aktualnih ponuda nije uspio.'));
  tx.onabort=()=>rej(tx.error||Error('Dohvat aktualnih ponuda je prekinut.'));
 });
 return products.map(product=>({product,offers:grouped.get(product.id)||[]})).filter(x=>x.offers.length);
}

async function dbGetOffersByProductKey(productKey){
 if(!productKey)return [];
 const d=await openDB();
 return new Promise((res,rej)=>{
  const req=d.transaction('offers').objectStore('offers').index('productKey').getAll(IDBKeyRange.only(productKey));
  req.onsuccess=()=>res(req.result||[]);
  req.onerror=()=>rej(req.error||Error('Dohvat aktualnih ponuda nije uspio.'));
 });
}

async function dbGetProductWithOffers(productKey){
 const product=await dbGet('products',productKey);
 if(!product)return null;
 const offers=await dbGetOffersByProductKey(productKey);
 return {product,offers};
}


async function dbReplaceStores(dataByStore){
 const entries=Object.entries(dataByStore||{});
 if(!entries.length)return;
 const d=await openDB();
 return new Promise((res,rej)=>{
  const tx=d.transaction(entries.map(([store])=>store),'readwrite');
  for(const [store,rows] of entries){
   const os=tx.objectStore(store);
   os.clear();
   for(const row of rows||[])os.put(row);
  }
  tx.oncomplete=()=>res();
  tx.onerror=()=>rej(tx.error||Error('Transakcija zamjene podataka nije uspjela.'));
  tx.onabort=()=>rej(tx.error||Error('Transakcija zamjene podataka je prekinuta.'));
 });
}

async function dbRestorePersonalData(dataByStore,dayPlanValue){
 const entries=Object.entries(dataByStore||{});
 const stores=[...entries.map(([store])=>store),'meta'];
 const d=await openDB();
 return new Promise((res,rej)=>{
  const tx=d.transaction([...new Set(stores)],'readwrite');
  for(const [store,rows] of entries){
   const os=tx.objectStore(store);
   os.clear();
   for(const row of rows||[])os.put(row);
  }
  if(dayPlanValue!==undefined){
   tx.objectStore('meta').put({key:'dayPlan',val:dayPlanValue});
  }
  tx.oncomplete=()=>res();
  tx.onerror=()=>rej(tx.error||Error('Vraćanje backupa nije uspjelo.'));
  tx.onabort=()=>rej(tx.error||Error('Vraćanje backupa je prekinuto.'));
 });
}


async function dbSyncCatalogModel(products,offers,syncedAt){
 const d=await openDB();
 const oldOffers=await dbAll('offers');
 const oldById=new Map(oldOffers.map(o=>[o.id,o]));
 const newIds=new Set((offers||[]).map(o=>o.id));
 const removed=oldOffers.filter(o=>!newIds.has(o.id));
 const changed=[];
 for(const o of offers||[]){
  const prev=oldById.get(o.id);
  // The first normalized sync establishes the baseline. History records actual
  // subsequent price changes only, avoiding one history row per catalog item.
  if(prev && Number(prev.price)!==Number(o.price)){
   changed.push({
    productKey:o.productKey,offerId:o.id,store:o.store,price:o.price,
    previousPrice:Number(prev.price)||0,onSale:!!o.onSale,recordedAt:syncedAt
   });
  }
 }
 return new Promise((res,rej)=>{
  const tx=d.transaction(['products','offers','priceHistory'],'readwrite');
  const ps=tx.objectStore('products'),os=tx.objectStore('offers'),hs=tx.objectStore('priceHistory');
  // Products represent the current canonical catalog. Replace their current
  // state atomically so products that disappeared from all selected chains do
  // not accumulate forever. Favorites/recipes keep their own user snapshots.
  ps.clear();
  for(const p of products||[])ps.put(p);
  // Offers store contains current state only, so stale prices do not accumulate here.
  os.clear();
  for(const o of offers||[])os.put(o);
  // History grows only when an existing offer's price changed.
  for(const h of changed)hs.add(h);
  // A missing offer is represented by its absence from the current offers store.
  // We do not create history rows for disappearance, keeping history price-only.
  tx.oncomplete=()=>res({products:(products||[]).length,offers:(offers||[]).length,priceChanges:changed.length,removedOffers:removed.length});
  tx.onerror=()=>rej(tx.error||Error('Sinkronizacija modela proizvoda i cijena nije uspjela.'));
  tx.onabort=()=>rej(tx.error||Error('Sinkronizacija modela proizvoda i cijena je prekinuta.'));
 });
}


async function dbPrunePriceHistory(maxPerOffer=30){
 const rows=await dbAll('priceHistory');
 if(rows.length<=maxPerOffer)return 0;
 const groups=new Map();
 for(const row of rows){
  const key=row.offerId||row.productKey||'unknown';
  if(!groups.has(key))groups.set(key,[]);
  groups.get(key).push(row);
 }
 const remove=[];
 for(const group of groups.values()){
  group.sort((a,b)=>String(b.recordedAt||'').localeCompare(String(a.recordedAt||'')) || Number(b.id||0)-Number(a.id||0));
  remove.push(...group.slice(maxPerOffer));
 }
 if(!remove.length)return 0;
 const d=await openDB();
 await new Promise((res,rej)=>{
  const tx=d.transaction('priceHistory','readwrite'),os=tx.objectStore('priceHistory');
  for(const row of remove)os.delete(row.id);
  tx.oncomplete=res;
  tx.onerror=()=>rej(tx.error||Error('Čišćenje povijesti cijena nije uspjelo.'));
  tx.onabort=()=>rej(tx.error||Error('Čišćenje povijesti cijena je prekinuto.'));
 });
 return remove.length;
}
