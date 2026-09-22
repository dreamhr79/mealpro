import { listRemoteZip, readRemoteZipText } from "./zip.ts";
import { parseChain, normalizeRows } from "./normalize.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

type Archive = { url?: string; date?: string; createdAt?: string; created_at?: string; timestamp?: string };

function archiveTime(a: Archive) {
  for (const value of [a.date, a.createdAt, a.created_at, a.timestamp]) {
    const t = Date.parse(value || "");
    if (Number.isFinite(t)) return t;
  }
  const m = String(a.url || "").match(/(20\d{2})[-_/]?(\d{2})[-_/]?(\d{2})/);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : 0;
}

function newestArchive(archives: Archive[]) {
  return [...archives].filter(a => a?.url).sort((a,b) => archiveTime(b)-archiveTime(a))[0] || null;
}

async function supabase(path: string, init: RequestInit = {}) {
  const base = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!base || !key) throw new Error("Missing Supabase server secrets");
  const headers = new Headers(init.headers);
  headers.set("apikey", key);
  headers.set("Authorization", `Bearer ${key}`);
  if (init.body) headers.set("Content-Type", "application/json");
  const res = await fetch(base.replace(/\/$/, "") + "/rest/v1/" + path, {...init, headers});
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function createSync(archive: Archive) {
  const rows = await supabase("catalog_syncs", {
    method:"POST",
    headers:{"Prefer":"return=representation"},
    body:JSON.stringify({
      source:"cijene.dev",
      archive_date: archive.date || null,
      archive_url: archive.url,
      status:"running"
    })
  });
  return rows?.[0]?.id;
}

async function stageRows(table:string, rows:Record<string,unknown>[]) {
  await supabase(table + "?on_conflict=id", {
    method:"POST",
    headers:{"Prefer":"resolution=merge-duplicates,return=minimal"},
    body:JSON.stringify(rows)
  });
}
async function clearStage() {
  await supabase("catalog_offers_stage?id=not.is.null", {method:"DELETE"});
  await supabase("catalog_products_stage?id=not.is.null", {method:"DELETE"});
}
async function applyStage(syncId:number) {
  const applied = await supabase("rpc/apply_staged_catalog", {
    method:"POST",
    body:JSON.stringify({p_sync_id:syncId,p_observed_at:new Date().toISOString()})
  });
  const pruned = await supabase("rpc/prune_catalog_price_history", {
    method:"POST",
    body:JSON.stringify({p_keep:30})
  });
  return { applied, pruned };
}

async function failSync(id: number | undefined, message: string) {
  if (!id) return;
  await supabase(`catalog_syncs?id=eq.${id}`, {
    method:"PATCH",
    body:JSON.stringify({status:"failed",finished_at:new Date().toISOString(),missing_chains:[message]})
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method not allowed", {status:405, headers:corsHeaders});
  let syncId: number | undefined;
  const requestBody = await req.json().catch(() => ({}));
  try {
    const listRes = await fetch("https://api.cijene.dev/v0/list");
    if (!listRes.ok) throw new Error(`cijene.dev list failed: ${listRes.status}`);
    const list = await listRes.json();
    const archive = newestArchive(Array.isArray(list?.archives) ? list.archives : []);
    if (!archive?.url) throw new Error("No valid cijene.dev archive");
    syncId = await createSync(archive);

    const allowedChains = ["konzum","lidl","spar","plodine","tommy","eurospin","kaufland","studenac","ktc","metro","ribola","ntl"];
    const requested = Array.isArray(requestBody?.chains) ? requestBody.chains.map((x:unknown) => String(x).toLowerCase()) : [];
    const chains = (requested.length ? requested : ["konzum","lidl","spar","plodine","tommy","kaufland"])
      .filter((x:string, i:number, a:string[]) => allowedChains.includes(x) && a.indexOf(x) === i);
    if (!chains.length) throw new Error("No supported chains selected");

    // Read only the ZIP directory first, then download/inflate one chain at a time.
    // This avoids holding the complete cijene.dev archive and all CSV files in worker RAM.
    const archiveIndex = await listRemoteZip(archive.url);
    const missingChains:string[] = [];
    let productCount = 0, offerCount = 0;
    await clearStage();
    const batchSize = 500;

    for (const chain of chains) {
      const productEntry = archiveIndex.entries.get(`${chain}/products.csv`);
      const priceEntry = archiveIndex.entries.get(`${chain}/prices.csv`);
      if (!productEntry || !priceEntry) { missingChains.push(chain); continue; }

      let productsText = await readRemoteZipText(archive.url, productEntry);
      let pricesText = await readRemoteZipText(archive.url, priceEntry);
      const rows = parseChain(chain, productsText, pricesText);
      productsText = ""; pricesText = "";
      const model = normalizeRows(rows);
      rows.length = 0;

      if (!model.products.length || !model.offers.length) throw new Error(`Normalization produced an empty catalog for ${chain}`);
      if (model.offers.some(o => !o.product_id || !(Number(o.price) > 0))) throw new Error(`Normalization produced invalid offers for ${chain}`);

      for (let i=0;i<model.products.length;i+=batchSize) await stageRows("catalog_products_stage", model.products.slice(i,i+batchSize));
      for (let i=0;i<model.offers.length;i+=batchSize) await stageRows("catalog_offers_stage", model.offers.slice(i,i+batchSize));
      productCount += model.products.length;
      offerCount += model.offers.length;
    }
    if (missingChains.length) throw new Error("Incomplete archive; missing chains: " + missingChains.join(", "));
    if (!productCount || !offerCount) throw new Error("Archive contains no valid catalog rows");

    const applied = await applyStage(syncId!);

    return Response.json({
      ok:true, syncId, archiveDate:archive.date || null, archiveUrl:archive.url,
      archiveBytes:archiveIndex.size, chains, products:productCount, offers:offerCount,
      applied, stage:"published"
    }, { headers:corsHeaders });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try { await clearStage(); } catch (_) {}
    try { await failSync(syncId, message); } catch (_) {}
    return Response.json({ok:false,error:message},{status:500,headers:corsHeaders});
  }
});
