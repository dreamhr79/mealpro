const DB_NAME='cijeneMealProDB',DB_VER=2;
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
  req.onerror=()=>rej(r.error);
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
