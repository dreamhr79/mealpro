export type CatalogRow = {
  id:string; externalId:string; barcode:string; name:string; brand:string;
  pack:number; unit:string; price:number; pricePer100:number|null;
  onSale:boolean; store:string; search:string;
};

const CHAINS:Record<string,string> = {
  konzum:"Konzum", lidl:"Lidl", spar:"SPAR", plodine:"Plodine", tommy:"Tommy",
  eurospin:"Eurospin", kaufland:"Kaufland", studenac:"Studenac", ktc:"KTC",
  metro:"Metro", ribola:"Ribola", ntl:"NTL"
};

function norm(s:unknown) {
  return String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/đ/g,"d").toLowerCase().trim();
}
function nval(v:unknown) {
  const n=Number(String(v ?? "").replace(/\s/g,"").replace(",","."));
  return Number.isFinite(n)&&n>0?n:null;
}
function barcode(v:unknown) {
  const code=String(v ?? "").replace(/\D/g,"");
  return code.length>=8?code:"";
}
function csvRows(text:string, visit:(row:string[], index:number)=>void) {
  let row:string[]=[],cur="",q=false,index=0;
  for(let i=0;i<text.length;i++){const ch=text[i];
    if(q){if(ch==='"'&&text[i+1]==='"'){cur+='"';i++;}else if(ch==='"')q=false;else cur+=ch;}
    else if(ch==='"')q=true;
    else if(ch===","){row.push(cur);cur="";}
    else if(ch==="\n"){row.push(cur.replace(/\r$/,""));visit(row,index++);row=[];cur="";}
    else cur+=ch;
  }
  if(cur||row.length){row.push(cur);visit(row,index);}
}
function packFromName(name:string){
  const s=String(name||"").toLowerCase().replace(/,/g,".").replace(/\s+/g," ").trim();
  let m=s.match(/(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*(kg|g|l|ml)\b/i);
  if(m){let p=Number(m[1])*Number(m[2]),u=m[3].toLowerCase();if(u==="kg"){p*=1000;u="g";}if(u==="l"){p*=1000;u="ml";}return{pack:p,unit:u};}
  m=s.match(/(\d+(?:\.\d+)?)\s*(kg|g|l|ml)\b/i);
  if(m){let p=Number(m[1]),u=m[2].toLowerCase();if(u==="kg"){p*=1000;u="g";}if(u==="l"){p*=1000;u="ml";}return{pack:p,unit:u};}
  m=s.match(/\b(\d{1,3})\s*(?:kom|komada)\b/i);
  return m?{pack:Number(m[1]),unit:"kom"}:null;
}
function smartPack(rawQty:string,rawUnit:string,name:string,price:number,ppu:number|null){
  const named=packFromName(name); if(named)return named;
  let q=nval(rawQty)||0,u=norm(rawUnit),unit=(u==="kg"||u==="g")?"g":(u==="l"||u==="ml")?"ml":"kom";
  if(u==="kg"||u==="l")q*=1000;
  if(q>=5&&(unit==="g"||unit==="ml"))return{pack:q,unit};
  if(ppu&&price>0&&(unit==="g"||unit==="ml"))return{pack:price/ppu*1000,unit};
  return{pack:q>0?q:100,unit};
}
export function parseChain(chain:string,productsText:string,pricesText:string):CatalogRow[]{
  const best=new Map<string,{price:number;ppu:number|null;sale:boolean}>();
  csvRows(pricesText,(c,i)=>{if(i===0)return;const pid=(c[1]||"").trim(),regular=nval(c[2]),special=nval(c[6]);
    const sale=!!special,price=sale?special:regular;if(!pid||!price)return;const prev=best.get(pid);
    if(!prev||price<prev.price)best.set(pid,{price,ppu:nval(c[3]),sale});
  });
  const out:CatalogRow[]=[];
  csvRows(productsText,(c,i)=>{if(i===0)return;const pid=(c[0]||"").trim(),name=(c[2]||"").trim(),bp=best.get(pid);
    if(!pid||!name||!bp)return;const pu=smartPack(c[6],c[5],name,bp.price,bp.ppu),code=barcode(c[1]);
    out.push({id:`${chain}:${pid}`,externalId:pid,barcode:code,name,brand:(c[3]||"").trim(),pack:pu.pack,unit:pu.unit,
      price:bp.price,pricePer100:(pu.unit==="g"||pu.unit==="ml")&&pu.pack>0?bp.price/pu.pack*100:null,onSale:bp.sale,
      store:CHAINS[chain]||chain,search:norm(`${name} ${c[3]||""} ${code}`)});
  });
  return out;
}
export function normalizeRows(rows:CatalogRow[]){
  const products=new Map<string,Record<string,unknown>>(),offers=new Map<string,Record<string,unknown>>();
  for(const r of rows){const key=r.barcode?`ean:${r.barcode}`:`source:${r.id}`;
    if(!products.has(key))products.set(key,{id:key,barcode:r.barcode||null,name:r.name,brand:r.brand,pack:r.pack,unit:r.unit,search_text:r.search});
    const o={id:r.id,product_id:key,store:r.store,price:r.price,pack:r.pack,unit:r.unit,price_per_100:r.pricePer100,on_sale:r.onSale};
    const prev=offers.get(r.id);if(!prev||Number(o.price)<Number(prev.price))offers.set(r.id,o);
  }
  return{products:[...products.values()],offers:[...offers.values()]};
}


export function createStreamingChainNormalizer(chain:string){
  const best=new Map<string,{price:number;ppu:number|null;sale:boolean}>();
  const rows:CatalogRow[]=[];
  return {
    acceptPrice(c:string[],i:number){
      if(i===0)return;
      const pid=(c[1]||"").trim(),regular=nval(c[2]),special=nval(c[6]);
      const sale=!!special,price=sale?special:regular;
      if(!pid||!price)return;
      const prev=best.get(pid);
      if(!prev||price<prev.price)best.set(pid,{price,ppu:nval(c[3]),sale});
    },
    acceptProduct(c:string[],i:number){
      if(i===0)return;
      const pid=(c[0]||"").trim(),name=(c[2]||"").trim(),bp=best.get(pid);
      if(!pid||!name||!bp)return;
      const pu=smartPack(c[6],c[5],name,bp.price,bp.ppu),code=barcode(c[1]);
      rows.push({id:`${chain}:${pid}`,externalId:pid,barcode:code,name,brand:(c[3]||"").trim(),pack:pu.pack,unit:pu.unit,
        price:bp.price,pricePer100:(pu.unit==="g"||pu.unit==="ml")&&pu.pack>0?bp.price/pu.pack*100:null,onSale:bp.sale,
        store:CHAINS[chain]||chain,search:norm(`${name} ${c[3]||""} ${code}`)});
    },
    finish(){
      best.clear();
      return normalizeRows(rows);
    }
  };
}
