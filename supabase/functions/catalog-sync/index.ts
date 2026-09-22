import { readZipFiles } from "./zip.ts";
import { parseChain, normalizeRows } from "./normalize.ts";

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

async function failSync(id: number | undefined, message: string) {
  if (!id) return;
  await supabase(`catalog_syncs?id=eq.${id}`, {
    method:"PATCH",
    body:JSON.stringify({status:"failed",finished_at:new Date().toISOString(),missing_chains:[message]})
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", {status:405});
  let syncId: number | undefined;
  try {
    const listRes = await fetch("https://api.cijene.dev/v0/list");
    if (!listRes.ok) throw new Error(`cijene.dev list failed: ${listRes.status}`);
    const list = await listRes.json();
    const archive = newestArchive(Array.isArray(list?.archives) ? list.archives : []);
    if (!archive?.url) throw new Error("No valid cijene.dev archive");
    syncId = await createSync(archive);

    // The archive download is deliberately performed server-side. Parsing and
    // normalization are the next isolated step; clients never receive the ZIP.
    const zipRes = await fetch(archive.url);
    if (!zipRes.ok) throw new Error(`Archive download failed: ${zipRes.status}`);
    const buffer = await zipRes.arrayBuffer();
    if (!buffer.byteLength) throw new Error("Downloaded archive is empty");

    const chains = ["konzum","lidl","spar","plodine","tommy","eurospin","kaufland","studenac","ktc","metro","ribola","ntl"];
    const files = await readZipFiles(buffer, name => chains.some(chain =>
      name === `${chain}/products.csv` || name === `${chain}/prices.csv`
    ));
    const rows = [];
    const missingChains = [];
    for (const chain of chains) {
      const products = files[`${chain}/products.csv`];
      const prices = files[`${chain}/prices.csv`];
      if (!products || !prices) { missingChains.push(chain); continue; }
      rows.push(...parseChain(chain, products, prices));
    }
    if (!rows.length) throw new Error("Archive contains no valid catalog rows");
    if (missingChains.length) throw new Error("Incomplete archive; missing chains: " + missingChains.join(", "));

    const model = normalizeRows(rows);
    if (!model.products.length || !model.offers.length) throw new Error("Normalization produced an empty catalog");
    if (model.offers.some(o => !o.product_id || !(Number(o.price) > 0))) throw new Error("Normalization produced invalid offers");

    return Response.json({
      ok:true, syncId, archiveDate:archive.date || null, archiveUrl:archive.url,
      archiveBytes:buffer.byteLength, products:model.products.length, offers:model.offers.length,
      stage:"normalized"
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try { await failSync(syncId, message); } catch (_) {}
    return Response.json({ok:false,error:message},{status:500});
  }
});
