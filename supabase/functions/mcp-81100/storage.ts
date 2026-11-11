// Archivio PDF su Supabase Storage (bucket privato, link firmati a scadenza)
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
export const BUCKET = "preventivi-pdf";
const H = () => ({ apikey: SRK, Authorization: `Bearer ${SRK}` });

let _bucketOk = false;
async function assicuraBucket(): Promise<void> {
  if (_bucketOk) return;
  const r = await fetch(`${SB_URL}/storage/v1/bucket/${BUCKET}`, { headers: H() });
  if (!r.ok) {
    const c = await fetch(`${SB_URL}/storage/v1/bucket`, {
      method: "POST",
      headers: { ...H(), "Content-Type": "application/json" },
      body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false, allowed_mime_types: ["application/pdf"] }),
    });
    if (!c.ok && c.status !== 409) throw new Error(`Storage: creazione bucket fallita (${c.status}): ${await c.text()}`);
  } else await r.body?.cancel();
  _bucketOk = true;
}

// Carica (sovrascrivendo) e restituisce un link firmato valido `giorni` giorni
export async function salvaPdf(path: string, bytes: Uint8Array, giorni = 30): Promise<string> {
  await assicuraBucket();
  const p = path.split("/").map(encodeURIComponent).join("/");
  const up = await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${p}`, {
    method: "POST",
    headers: { ...H(), "Content-Type": "application/pdf", "x-upsert": "true", "cache-control": "no-cache" },
    body: new Blob([bytes as BlobPart], { type: "application/pdf" }),
  });
  if (!up.ok) throw new Error(`Storage: upload fallito (${up.status}): ${await up.text()}`);
  await up.body?.cancel();
  const s = await fetch(`${SB_URL}/storage/v1/object/sign/${BUCKET}/${p}`, {
    method: "POST",
    headers: { ...H(), "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn: giorni * 86400 }),
  });
  if (!s.ok) throw new Error(`Storage: link firmato fallito (${s.status}): ${await s.text()}`);
  const j = await s.json();
  const rel = j.signedURL || j.signedUrl || "";
  return rel.startsWith("http") ? rel : `${SB_URL}/storage/v1${rel}`;
}
