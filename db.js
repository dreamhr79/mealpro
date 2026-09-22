const DB_NAME='cijeneMealProDB',DB_VER=3;
let _db;
function openDB(){
 if(_db)return Promise.resolve(_db);
 return new Promise((res,rej)=>{
  const r=indexedDB.open(DB_NAME,DB_VER);
  r.onupgradeneeded=()=>{
   const d=r.result;
   if(!d.objectStoreNames.contains('catalog')){
    const cat=d.createObjectStore('catalog',{keyPath:'id'});
    cat.createIndex('tokens','tokens',{multiEntry:true});
    cat.createIndex('barcode','barcode');
   }
   if(!d.objectStoreNames.contains('favorites'))d.createObjectStore('favorites',{keyPath:'id'});
   if(!d.objectStoreNames.contains('custom'))d.createObjectStore('custom',{keyPath:'id'});
   if(!d.objectStoreNames.contains('recipes'))d.createObjectStore('recipes',{keyPath:'id'});
   if(!d.objectStoreNames.contains('meta'))d.createObjectStore('meta',{keyPath:'key'});
   if(!d.objectStoreNames.contains('nutritionOverlay'))d.createObjectStore('nutritionOverlay',{keyPath:'key'});
   if(!d.objectStoreNames.contains('priceHistory'))d.createObjectStore('priceHistory',{keyPath:'id',autoIncrement:true});
   if(!d.objectStoreNames.contains('products')){
    const products=d.createObjectStore('products',{keyPath:'id'});
    products.createIndex('barcode','barcode',{unique:false});
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
async function dbSearchCatalog(q,limit=80){
 const words=norm(q).split(/\s+/).filter(Boolean);
 if(!words.length)return [];
 const d=await openDB(),idx=d.transaction('catalog').objectStore('catalog').index('tokens');
 const prefix=words[0],range=IDBKeyRange.bound(prefix,prefix+'\uffff'),rows=[];
 return new Promise((res,rej)=>{
  const req=idx.openCursor(range);
  req.onsuccess=()=>{
   const c=req.result;
   if(!c||rows.length>=450){
    const seen=new Set(),out=[];
    for(const x of rows){
     if(!words.every(w=>x.search.includes(w)))continue;
     const k=x.barcode||x.id;
     if(seen.has(k))continue;
     seen.add(k);out.push(x);
     if(out.length>=limit)break;
    }
    res(out);return;
   }
   rows.push(c.value);c.continue();
  };
  req.onerror=()=>rej(req.error || Error('Greška pri pretraživanju kataloga.'));
 });
}

async function dbGetOffersByBarcode(barcode){
 const code = String(barcode || '').replace(/\D/g, '');
 if (code.length < 8) return [];
 const d = await openDB();
 return new Promise(res => {
  const req = d.transaction('catalog').objectStore('catalog').index('barcode').getAll(IDBKeyRange.only(code));
  req.onsuccess = () => res(req.result || []);
  req.onerror = () => res([]);
 });
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
 const changed=[];
 for(const o of offers||[]){
  const prev=oldById.get(o.id);
  if(!prev || Number(prev.price)!==Number(o.price) || !!prev.onSale!==!!o.onSale){
   changed.push({
    productKey:o.productKey,offerId:o.id,store:o.store,price:o.price,
    onSale:!!o.onSale,recordedAt:syncedAt
   });
  }
 }
 return new Promise((res,rej)=>{
  const tx=d.transaction(['products','offers','priceHistory'],'readwrite');
  const ps=tx.objectStore('products'),os=tx.objectStore('offers'),hs=tx.objectStore('priceHistory');
  // Products are canonical and upserted: the same product is not duplicated on refresh.
  for(const p of products||[])ps.put(p);
  // Offers store contains current state only, so stale prices do not accumulate here.
  os.clear();
  for(const o of offers||[])os.put(o);
  // History grows only when an offer is new or its effective price/sale state changed.
  for(const h of changed)hs.add(h);
  tx.oncomplete=()=>res({products:(products||[]).length,offers:(offers||[]).length,priceChanges:changed.length});
  tx.onerror=()=>rej(tx.error||Error('Sinkronizacija modela proizvoda i cijena nije uspjela.'));
  tx.onabort=()=>rej(tx.error||Error('Sinkronizacija modela proizvoda i cijena je prekinuta.'));
 });
}
