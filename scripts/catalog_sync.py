#!/usr/bin/env python3
import csv, io, json, os, re, tempfile, urllib.request, urllib.error, zipfile

SYNC_URL=os.environ["CATALOG_SYNC_URL"]
TOKEN=os.environ["CATALOG_SYNC_TOKEN"]
CHAINS=[x.strip().lower() for x in os.environ.get("CHAINS","konzum,lidl,spar,plodine,tommy,kaufland").split(",") if x.strip()]
NAMES={"konzum":"Konzum","lidl":"Lidl","spar":"SPAR","plodine":"Plodine","tommy":"Tommy","kaufland":"Kaufland","studenac":"Studenac","eurospin":"Eurospin","ktc":"KTC","metro":"Metro","ribola":"Ribola","ntl":"NTL"}

def post(payload):
    data=json.dumps(payload,separators=(",",":")).encode()
    req=urllib.request.Request(SYNC_URL,data=data,method="POST",headers={"Authorization":f"Bearer {TOKEN}","Content-Type":"application/json"})
    try:
        with urllib.request.urlopen(req,timeout=120) as r:
            out=json.load(r)
    except urllib.error.HTTPError as e:
        body=e.read().decode("utf-8","replace")
        raise RuntimeError(f"Catalog API HTTP {e.code}: {body}") from e
    if not out.get("ok"): raise RuntimeError(out)
    return out

def num(v):
    try:
        n=float(str(v or "").replace(" ","").replace(",","."))
        return n if n>0 else None
    except: return None

def barcode(v):
    x=re.sub(r"\D","",str(v or ""))
    return x if len(x)>=8 else ""

def pack(name,qty,unit,price,ppu):
    s=str(name or "").lower().replace(",",".")
    m=re.search(r"(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*(kg|g|l|ml)\b",s)
    if m:
        p=float(m.group(1))*float(m.group(2)); u=m.group(3)
        if u=="kg": p*=1000; u="g"
        if u=="l": p*=1000; u="ml"
        return p,u
    m=re.search(r"(\d+(?:\.\d+)?)\s*(kg|g|l|ml)\b",s)
    if m:
        p=float(m.group(1)); u=m.group(2)
        if u=="kg": p*=1000; u="g"
        if u=="l": p*=1000; u="ml"
        return p,u
    q=num(qty) or 0; u=str(unit or "").lower().strip()
    out="g" if u in ("kg","g") else "ml" if u in ("l","ml") else "kom"
    if u in ("kg","l"): q*=1000
    if q>=5 and out in ("g","ml"): return q,out
    if ppu and price and out in ("g","ml"): return price/ppu*1000,out
    return (q if q>0 else 100),out

def norm(s):
    import unicodedata
    s=unicodedata.normalize("NFD",str(s or "")).encode("ascii","ignore").decode().lower()
    return " ".join(s.split())

start=post({"mode":"start"})
sync_id=start["syncId"]; archive=start["archiveUrl"]
print(f"Sync {sync_id}: downloading {archive}")
with tempfile.NamedTemporaryFile(suffix=".zip") as tmp:
    urllib.request.urlretrieve(archive,tmp.name)
    with zipfile.ZipFile(tmp.name) as z:
        for chain in CHAINS:
            pp=f"{chain}/products.csv"; pr=f"{chain}/prices.csv"
            if pp not in z.namelist() or pr not in z.namelist():
                raise RuntimeError(f"Missing chain files: {chain}")
            best={}
            with z.open(pr) as raw:
                rows=csv.reader(io.TextIOWrapper(raw,encoding="utf-8-sig",newline=""))
                header=next(rows,None)
                for c in rows:
                    if len(c)<3: continue
                    pid=c[1].strip(); price=num(c[2]); ppu=num(c[3]) if len(c)>3 else None
                    if not pid or not price: continue
                    old=best.get(pid)
                    if old is None or price<old[0]: best[pid]=(price,ppu)
            products=[]; offers=[]
            with z.open(pp) as raw:
                rows=csv.reader(io.TextIOWrapper(raw,encoding="utf-8-sig",newline=""))
                next(rows,None)
                for c in rows:
                    if len(c)<3: continue
                    pid=c[0].strip(); name=c[2].strip(); bp=best.get(pid)
                    if not pid or not name or not bp: continue
                    code=barcode(c[1] if len(c)>1 else "")
                    brand=(c[3] if len(c)>3 else "").strip()
                    unit=(c[5] if len(c)>5 else "")
                    qty=(c[6] if len(c)>6 else "")
                    pk,u=pack(name,qty,unit,bp[0],bp[1])
                    key=f"ean:{code}" if code else f"source:{chain}:{pid}"
                    products.append({"id":key,"barcode":code or None,"name":name,"brand":brand,"pack":pk,"unit":u,"search_text":norm(f"{name} {brand} {code}")})
                    offers.append({"id":f"{chain}:{pid}","product_id":key,"store":NAMES.get(chain,chain),"price":bp[0],"pack":pk,"unit":u,"price_per_100":bp[0]/pk*100 if u in ("g","ml") and pk>0 else None,"on_sale":False})
                    if len(products)>=300:
                        unique_products=list({p["id"]:p for p in products}.values())
                        post({"mode":"stage","products":unique_products,"offers":offers}); products=[]; offers=[]
            if products or offers:
                unique_products=list({p["id"]:p for p in products}.values())
                post({"mode":"stage","products":unique_products,"offers":offers})
            print(f"Staged {chain}: {len(best)} priced product ids")
result=post({"mode":"publish","syncId":sync_id})
print(json.dumps(result,ensure_ascii=False))
