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
    const bytes = new Uint8Array(await zipRes.arrayBuffer());
    if (!bytes.length) throw new Error("Downloaded archive is empty");

    return Response.json({
      ok:true,
      syncId,
      archiveDate:archive.date || null,
      archiveUrl:archive.url,
      archiveBytes:bytes.length,
      stage:"downloaded"
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try { await failSync(syncId, message); } catch (_) {}
    return Response.json({ok:false,error:message},{status:500});
  }
});
