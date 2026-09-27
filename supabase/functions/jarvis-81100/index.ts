// ═══ JARVIS 81100 — assistente unico di Ottantunocento S.r.l. ═══
// Evoluzione di "assistente-81100" v9.1: tutti i flussi a comandi restano identici
// (/brief /timbra /pianifica /pagata /spesa /richiesta, foto distinte, vocali);
// le richieste in linguaggio libero passano all'agente Jarvis (in fondo al file),
// che legge i dati e PROPONE le scritture: nulla viene salvato senza il ✅ su Telegram.
// Segreti: SOLO da Supabase → Edge Functions → Secrets (mai scritti nel codice).
import { createClient } from "npm:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk@0.128.0";

const TG = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") || "";
const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY") || "";
const PAROLA = Deno.env.get("BOT_PAROLA") || "";
const CRON_SECRET = Deno.env.get("BOT_CRON_SECRET") || "";
const WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") || "";
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const oggi = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Rome" });
const fd = (s: string) => s ? s.split("-").reverse().join("/") : "—";
const hhmm = (t: string | Date) => new Date(t).toLocaleTimeString("it-IT", { timeZone: "Europe/Rome", hour: "2-digit", minute: "2-digit" });
const norm = (s: string) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const operativo = (c: any) => c && c.stato !== "perso" && c.stato !== "concluso" && !c.archiviato;
const fmtE = (n: number) => (Math.round(n * 100) / 100).toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
function romeIso(hh: number, mm: number): string {
  const now = new Date();
  const rome = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Rome" }));
  const utc = new Date(now.toLocaleString("en-US", { timeZone: "UTC" }));
  const off = Math.round((rome.getTime() - utc.getTime()) / 3600000);
  return `${oggi()}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00${off >= 0 ? "+" : "-"}${String(Math.abs(off)).padStart(2, "0")}:00`;
}

async function tgApi(method: string, body: any) {
  return await (await fetch(`https://api.telegram.org/bot${TG}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  })).json();
}
async function tgSend(chat: number, text: string, kb?: any) {
  for (let i = 0; i < text.length; i += 3800)
    await tgApi("sendMessage", { chat_id: chat, text: text.slice(i, i + 3800), parse_mode: "HTML", disable_web_page_preview: true, ...(kb && i === 0 ? { reply_markup: kb } : {}) });
}
async function sql(q: string): Promise<any> {
  const { data, error } = await sb.rpc("assistente_sql", { q });
  if (error) throw new Error(error.message);
  return data;
}
async function blob(): Promise<any> {
  const { data } = await sb.from("gestionale_dati").select("dati").eq("id", "unico").single();
  return data?.dati || {};
}

// ─── TIMBRATURE ───
async function statoOggi(): Promise<Record<string, any>> {
  const { data } = await sb.from("timbrature").select("dip_id,dip_nome,cantiere,cantiere_id,tipo,ts")
    .gte("ts", oggi() + "T00:00:00+02:00").order("ts", { ascending: true });
  const st: Record<string, any> = {};
  (data || []).forEach((t: any) => { st[t.dip_id] = t; });
  return st;
}
async function kbTimbra(): Promise<any> {
  const B = await blob(); const st = await statoOggi();
  const righe = (B.personale || []).slice().sort((a: any, b: any) => a.nome.localeCompare(b.nome)).map((p: any) => {
    const s = st[p.id]; const dentro = s && s.tipo === "ingresso";
    return [{ text: `${dentro ? "🟢" : "⚪"} ${p.nome}${dentro ? " · " + (s.cantiere || "").slice(0, 16) + " " + hhmm(s.ts) : ""}`, callback_data: "tb:" + p.id }];
  });
  righe.push([{ text: "👥 Squadra intera su un cantiere", callback_data: "ts:" }]);
  righe.push([{ text: "📋 Situazione di adesso", callback_data: "tst:" }]);
  return { inline_keyboard: righe };
}
function kbCantieri(B: any, prefix: string, escludiId?: string): any {
  const cc = (B.cantieri || []).filter((c: any) => ["in corso", "in arrivo", "da confermare", "fermo"].includes(c.stato) && !c.archiviato && c.id !== escludiId);
  cc.sort((a: any, b: any) => (a.stato === "in corso" ? 0 : 1) - (b.stato === "in corso" ? 0 : 1) || (a.nome || "").localeCompare(b.nome));
  const righe = cc.slice(0, 24).map((c: any) => [{ text: (c.stato === "in corso" ? "🔨 " : "⏳ ") + (c.nome || "").slice(0, 34), callback_data: prefix + c.id }]);
  righe.push([{ text: "↩️ indietro", callback_data: "tk:" }]);
  return { inline_keyboard: righe };
}
function kbOrario(prefix: string): any {
  return { inline_keyboard: [
    [{ text: "🕐 Adesso", callback_data: prefix + "0" }],
    [{ text: "30 minuti fa", callback_data: prefix + "-30" }, { text: "1 ora fa", callback_data: prefix + "-60" }],
    [{ text: "2 ore fa", callback_data: prefix + "-120" }, { text: "✏️ Scrivo io l'orario", callback_data: "tw:" + prefix.slice(3) }],
    [{ text: "↩️ indietro", callback_data: "tk:" }],
  ] };
}
function kbOrariPl(): any {
  return { inline_keyboard: [
    [{ text: "07:00", callback_data: "plo:0700" }, { text: "07:30", callback_data: "plo:0730" }, { text: "08:00", callback_data: "plo:0800" }],
    [{ text: "08:30", callback_data: "plo:0830" }, { text: "09:00", callback_data: "plo:0900" }, { text: "10:00", callback_data: "plo:1000" }],
    [{ text: "14:00", callback_data: "plo:1400" }, { text: "15:00", callback_data: "plo:1500" }, { text: "16:00", callback_data: "plo:1600" }],
    [{ text: "⏭ Senza orario", callback_data: "plo:-" }],
    [{ text: "❌ annulla", callback_data: "tk:" }],
  ] };
}
async function timbra(dipId: string, tipo: string, cantId: string | null, cantNome: string | null, da: string, ts?: string) {
  const B = await blob();
  const p = (B.personale || []).find((x: any) => x.id === dipId);
  const rec: any = { dip_id: dipId, dip_nome: p?.nome || dipId, cantiere_id: cantId, cantiere: cantNome, tipo, registrata_da: da };
  if (ts) rec.ts = ts;
  await sb.from("timbrature").insert(rec);
  return p?.nome || dipId;
}
async function cambioCantiere(dipId: string, nuovoCantId: string, da: string, ts: string): Promise<string> {
  const B = await blob(); const st = await statoOggi();
  const s = st[dipId];
  const c = (B.cantieri || []).find((x: any) => x.id === nuovoCantId);
  if (s && s.tipo === "ingresso") await timbra(dipId, "uscita", s.cantiere_id, s.cantiere, da, ts);
  const nome = await timbra(dipId, "ingresso", nuovoCantId, c?.nome || "", da, ts);
  return `🔄 <b>${nome}</b>: ${s?.cantiere ? "uscita da <b>" + s.cantiere + "</b> + " : ""}ingresso su <b>${c?.nome}</b> alle <b>${hhmm(ts)}</b> ✓`;
}
async function setPending(chat: number, p: any) { await sb.from("assistente_utenti").update({ pending: p }).eq("telegram_id", chat); }
async function insertRichiesta(row: any): Promise<string> {
  const { data } = await sb.from("richieste").insert({ canale: "telegram", stato: "nuova", ...row }).select("numero").maybeSingle();
  return (data && data.numero) || "";
}
async function creaRichiestaVeloce(chat: number, testo: string, da: string) {
  try {
    const num = await insertRichiesta({ oggetto: testo.slice(0, 140), descrizione: testo, richiedente_nome: da, note: "Inserita da Telegram" });
    await tgSend(chat, "✅ Richiesta <b>" + (num || "creata") + "</b> registrata.\nLa completi e la trasformi in preventivo nell'app <b>Preventivi → 📥 Richieste</b>.");
  } catch (e) { await tgSend(chat, "⚠ Non sono riuscito a salvare la richiesta: " + String(((e as any) && (e as any).message) || e).slice(0, 80)); }
}
async function gestisciTestoRichiesta(chat: number, testo: string, st: any, da: string): Promise<boolean> {
  if (testo === "/annulla") { await setPending(chat, null); await tgSend(chat, "Ok, annullato. /richiesta per ripartire."); return true; }
  st.d = st.d || {};
  if (st.attesa === "oggetto") {
    st.d.oggetto = testo.slice(0, 140); st.d.descrizione = testo; st.attesa = "cliente";
    await setPending(chat, { richiesta: st });
    await tgSend(chat, "👤 Chi è il <b>cliente / richiedente</b>? (nome)\nScrivi «-» se non lo sai.");
    return true;
  }
  if (st.attesa === "cliente") {
    if (testo !== "-") st.d.cliente_nome = testo.slice(0, 120);
    st.attesa = "budget";
    await setPending(chat, { richiesta: st });
    await tgSend(chat, "💶 <b>Budget indicativo</b> in €? (solo numero)\nScrivi «-» se non definito.");
    return true;
  }
  if (st.attesa === "budget") {
    const b = parseFloat(String(testo).replace(/[^\d.,]/g, "").replace(",", "."));
    if (!isNaN(b)) st.d.budget_indicativo = b;
    await setPending(chat, null);
    const num = await insertRichiesta({ ...st.d, richiedente_nome: da, note: "Inserita da Telegram (guidata)" });
    await tgSend(chat, "✅ Richiesta <b>" + (num || "creata") + "</b> registrata.\nLa completi e la trasformi in preventivo nell'app <b>Preventivi → 📥 Richieste</b>.");
    return true;
  }
  return false;
}

// ─── PIANIFICA ───
function kbGiorni(): any {
  const gsett = ["dom", "lun", "mar", "mer", "gio", "ven", "sab"];
  const righe: any[] = [];
  for (let i = 0; i < 7; i++) {
    const dRoma = new Date(Date.now() + i * 864e5).toLocaleDateString("sv-SE", { timeZone: "Europe/Rome" });
    const g = new Date(dRoma + "T12:00");
    const lbl = i === 0 ? "Oggi " + fd(dRoma).slice(0, 5) : i === 1 ? "⭐ Domani " + fd(dRoma).slice(0, 5) : gsett[g.getDay()] + " " + fd(dRoma).slice(0, 5);
    righe.push([{ text: lbl, callback_data: "plg:" + dRoma }]);
  }
  righe.push([{ text: "❌ annulla", callback_data: "tk:" }]);
  return { inline_keyboard: righe };
}
async function kbOperaiPl(pl: any): Promise<any> {
  const B = await blob();
  const righe = (B.personale || []).slice().sort((a: any, b: any) => a.nome.localeCompare(b.nome)).map((p: any) => {
    const dentro = (pl.sq || []).includes(p.nome);
    return [{ text: `${dentro ? "🟢" : "⚪"} ${p.nome}`, callback_data: "plp:" + p.id }];
  });
  righe.push([{ text: "✅ Salva la proposta", callback_data: "plok" }]);
  righe.push([{ text: "❌ annulla", callback_data: "tk:" }]);
  return { inline_keyboard: righe };
}
function riepPl(pl: any): string {
  return `📅 <b>${fd(pl.d)}</b> · 📍 <b>${pl.cn || "?"}</b>${pl.nuovo ? " <i>(NUOVO)</i>" : ""}${pl.o ? " · ore " + pl.o : ""}\n👷 ${(pl.sq || []).length ? (pl.sq || []).join(", ") : "<i>tocca chi lavora</i>"}`;
}

// ─── PAGAMENTI FATTURE (da foto distinta, con verifica) ───
function accTot(f: any): number { return Array.isArray(f.acconti) ? f.acconti.reduce((s: number, a: any) => s + (+a.importo || 0), 0) : 0; }
function residuoFatt(f: any): number { return Math.max(0, (+f.importo || 0) - accTot(f)); }

async function tgFileUrl(fileId: string): Promise<string | null> {
  const r = await tgApi("getFile", { file_id: fileId });
  const path = r?.result?.file_path;
  return path ? `https://api.telegram.org/file/bot${TG}/${path}` : null;
}
async function fotoB64(fileId: string): Promise<{ b64: string; mime: string } | null> {
  const url = await tgFileUrl(fileId);
  if (!url) return null;
  const resp = await fetch(url);
  const buf = new Uint8Array(await resp.arrayBuffer());
  let bin = ""; for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  const b64 = btoa(bin);
  const mime = url.toLowerCase().endsWith(".png") ? "image/png" : url.toLowerCase().endsWith(".pdf") ? "application/pdf" : "image/jpeg";
  return { b64, mime };
}
async function trascriviVoce(fileId: string): Promise<string> {
  try {
    const url = await tgFileUrl(fileId);
    if (!url) return "";
    const audioResp = await fetch(url);
    const blob = await audioResp.blob();
    const fd = new FormData();
    fd.append("file", blob, "voce.oga");
    fd.append("model", "whisper-1");
    fd.append("language", "it");
    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST", headers: { Authorization: `Bearer ${OPENAI_KEY}` }, body: fd,
    });
    if (!r.ok) return "";
    const j = await r.json();
    return (j.text || "").trim();
  } catch (_) { return ""; }
}
async function estraiDistinta(b64: string, mime: string): Promise<any> {
  const media = mime === "application/pdf"
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } }
    : { type: "image", source: { type: "base64", media_type: mime, data: b64 } };
  const prompt = "Questa è la distinta/ricevuta di un bonifico o pagamento ricevuto da Ottantunocento S.r.l. Estrai SOLO i dati e rispondi con UN oggetto JSON puro (niente altro testo): {\"importo\": numero (l'importo accreditato, punto decimale), \"data\": \"YYYY-MM-DD\" (data del pagamento/valuta), \"ordinante\": \"chi ha pagato / ordinante\", \"beneficiario\": \"beneficiario\", \"causale\": \"causale o descrizione\"}. Se un campo non c'è metti null.";
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 500, messages: [{ role: "user", content: [media, { type: "text", text: prompt }] }] }),
  });
  const data = await resp.json();
  const txt = (data.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("lettura non riuscita");
  return JSON.parse(m[0]);
}
async function candidatiFatture(importo: number, testoRif: string): Promise<any[]> {
  const { data } = await sb.from("fatture").select("id,numero,cliente,importo,acconti,stato,data_fattura").eq("stato", "emessa");
  const rif = norm(testoRif || "");
  const arr = (data || []).map((f: any) => {
    const res = residuoFatt(f);
    const dSaldo = Math.abs(res - importo);
    const dImpon = Math.abs(res - importo * 1.22); // enti: pagano l'imponibile
    let score = 0;
    if (dSaldo <= Math.max(1, res * 0.02)) score += 100;         // salda esatto
    else if (dImpon <= Math.max(1, res * 1.22 * 0.02)) score += 90; // split payment
    else if (importo <= res + 0.01) score += 40;                  // possibile acconto
    else score -= 50;
    const cli = norm(f.cliente || "");
    if (cli && rif) { const tok = cli.split(" ").filter((t: string) => t.length >= 4); if (tok.some((t: string) => rif.includes(t))) score += 25; }
    return { f, res, score, dSaldo };
  }).filter((x: any) => x.score > 0).sort((a: any, b: any) => b.score - a.score || a.dSaldo - b.dSaldo);
  return arr.slice(0, 4);
}
function riepPay(pay: any): string {
  return `🧾 <b>Distinta letta</b>\n💶 Importo: <b>${pay.importo != null ? fmtE(pay.importo) : "?"}</b>\n📅 Data: <b>${pay.data ? fd(pay.data) : "?"}</b>\n👤 Ordinante: ${pay.ordinante || "—"}\n📝 Causale: ${pay.causale || "—"}`;
}
async function kbCandidati(pay: any): Promise<any> {
  const cand = await candidatiFatture(+pay.importo || 0, [pay.ordinante, pay.causale, pay.beneficiario].filter(Boolean).join(" "));
  pay._cand = cand.map((c: any) => c.f.id);
  const righe = cand.map((c: any) => [{ text: `${c.f.numero} · ${(c.f.cliente || "").slice(0, 20)} · resta ${fmtE(c.res)}`, callback_data: "pgf:" + c.f.id }]);
  righe.push([{ text: "🔢 Scrivo io il numero fattura", callback_data: "pgn:" }]);
  righe.push([{ text: "❌ annulla", callback_data: "pgx:" }]);
  return { inline_keyboard: righe };
}
async function applicaPagamento(fatturaId: string, modo: "saldo" | "acconto", importoAcc: number, dataPag: string, causale: string, mezzo: string): Promise<string> {
  const { data: f } = await sb.from("fatture").select("*").eq("id", fatturaId).single();
  if (!f) return "⚠ Fattura non trovata.";
  const dp = dataPag || oggi();
  const mz = mezzo || "bonifico";
  if (modo === "saldo") {
    const nota = `${f.note ? f.note + " · " : ""}pagata da bot (${mz} ${fmtE(+f.importo || 0)} del ${fd(dp)})`;
    await sb.from("fatture").update({ stato: "pagata", data_pagamento: dp, note: nota }).eq("id", fatturaId);
    return `✅ <b>${f.numero}</b> (${f.cliente}) segnata <b>PAGATA</b> il ${fd(dp)} — ${fmtE(+f.importo || 0)}.`;
  } else {
    const acc = Array.isArray(f.acconti) ? f.acconti.slice() : [];
    acc.push({ data: dp, importo: importoAcc, nota: mz + " (bot)" + (causale ? " · " + causale.slice(0, 40) : "") });
    const tot = acc.reduce((s: number, a: any) => s + (+a.importo || 0), 0);
    const saldato = tot >= (+f.importo || 0) - 0.01;
    const upd: any = { acconti: acc };
    if (saldato) { upd.stato = "pagata"; upd.data_pagamento = dp; }
    await sb.from("fatture").update(upd).eq("id", fatturaId);
    const resta = Math.max(0, (+f.importo || 0) - tot);
    return saldato
      ? `✅ Acconto di ${fmtE(importoAcc)} registrato: con questo la <b>${f.numero}</b> risulta <b>SALDATA</b> il ${fd(dp)}.`
      : `💶 Acconto di ${fmtE(importoAcc)} registrato sulla <b>${f.numero}</b> (${f.cliente}). Resta da incassare <b>${fmtE(resta)}</b>.`;
  }
}
function kbDataPag(): any {
  return { inline_keyboard: [
    [{ text: "🕐 Oggi", callback_data: "pgd:0" }, { text: "Ieri", callback_data: "pgd:-1" }],
    [{ text: "✏️ Scrivo io la data", callback_data: "pgdw:" }],
    [{ text: "❌ annulla", callback_data: "pgx:" }],
  ] };
}
function kbModalita(): any {
  return { inline_keyboard: [
    [{ text: "🏦 Bonifico", callback_data: "pgm:bonifico" }, { text: "🧾 Assegno", callback_data: "pgm:assegno" }],
    [{ text: "💵 Contanti", callback_data: "pgm:contanti" }, { text: "🔁 Compensazione", callback_data: "pgm:compensazione" }],
    [{ text: "❌ annulla", callback_data: "pgx:" }],
  ] };
}

// ─── SPESE CANTIERE (bot propone → gestionale importa) ───
function kbDataSpesa(): any {
  return { inline_keyboard: [
    [{ text: "🕐 Oggi", callback_data: "spd:0" }, { text: "Ieri", callback_data: "spd:-1" }],
    [{ text: "✏️ Scrivo io la data", callback_data: "spdw:" }],
    [{ text: "❌ annulla", callback_data: "pgx:" }],
  ] };
}
async function insertSpesaBot(spesa: any, da: string): Promise<string> {
  await sb.from("spese_bot").insert({ cantiere_id: spesa.cid || null, cantiere_nome: spesa.cnome || "", importo: spesa.importo, oggetto: spesa.oggetto || "", data: spesa.data || oggi(), creato_da: da, stato: "proposta" });
  return `✅ <b>Spesa registrata</b> (in attesa di import)\n📍 ${spesa.cnome}\n💶 ${fmtE(spesa.importo)} · 📅 ${fd(spesa.data || oggi())}\n📝 ${spesa.oggetto || "—"}\n\n<i>Nel gestionale, sezione «Importa spese dal bot»: confermala e finisce nelle spese del cantiere.</i>`;
}
async function gestisciTestoSpesa(chat: number, testo: string, spesa: any, da: string): Promise<boolean> {
  if (testo === "/annulla") { await setPending(chat, null); await tgSend(chat, "Ok, annullato. /spesa per ripartire."); return true; }
  if (spesa.attesa === "importo") {
    const v = parseFloat(testo.replace(/\./g, "").replace(",", ".").replace(/[^\d.]/g, ""));
    if (!isFinite(v) || v <= 0) { await tgSend(chat, "✏️ Importo non valido, riprova (es. 120 o 1.250,50) — /annulla"); return true; }
    spesa.importo = v; spesa.attesa = "oggetto"; await setPending(chat, { spesa });
    await tgSend(chat, "📝 Cos'è la spesa? Scrivimi l'<b>oggetto/descrizione</b> (es. <code>nolo bagno chimico</code>)"); return true;
  }
  if (spesa.attesa === "oggetto") {
    spesa.oggetto = testo.slice(0, 120); delete spesa.attesa; await setPending(chat, { spesa });
    await tgSend(chat, "📅 Di che <b>data</b> è la spesa?", kbDataSpesa()); return true;
  }
  if (spesa.attesa === "data") {
    const m = testo.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/);
    if (!m) { await tgSend(chat, "✏️ Data non valida — scrivila come 05/08/2026 (o /annulla)"); return true; }
    const yy = m[3].length === 2 ? "20" + m[3] : m[3];
    spesa.data = `${yy}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`; delete spesa.attesa;
    const t = await insertSpesaBot(spesa, da); await setPending(chat, null); await tgSend(chat, t); return true;
  }
  return false;
}

async function gestisciCallback(cb: any) {
  const chat = cb.message?.chat?.id; const msgId = cb.message?.message_id;
  const d = String(cb.data || ""); const da = [cb.from?.first_name, cb.from?.last_name].filter(Boolean).join(" ");
  const rispondi = async (t?: string) => { try { await tgApi("answerCallbackQuery", { callback_query_id: cb.id, ...(t ? { text: t } : {}) }); } catch (_) {} };
  const edit = async (text: string, kb: any) => { try { await tgApi("editMessageText", { chat_id: chat, message_id: msgId, text, parse_mode: "HTML", reply_markup: kb }); } catch (_) {} };
  const { data: aut } = await sb.from("assistente_utenti").select("telegram_id,ruolo,pending").eq("telegram_id", chat).maybeSingle();
  if (!aut) { await rispondi("🔒 non autorizzato"); return; }
  const admin = (aut.ruolo || "admin") === "admin";
  const pend = aut.pending || {};

  // ── PAGAMENTI ──
  if (d === "pgx:") { await rispondi(); await setPending(chat, null); await edit("Ok, annullato.", { inline_keyboard: [] }); return; }
  // spese cantiere (callback)
  if (d.startsWith("sp:")) {
    const cantId = d.slice(3); const B = await blob();
    const c = (B.cantieri || []).find((x: any) => x.id === cantId);
    const spesa = { cid: cantId, cnome: c?.nome || "", attesa: "importo" };
    await setPending(chat, { spesa }); await rispondi();
    await edit(`🧾 <b>Spesa · ${c?.nome || "?"}</b>\nScrivimi l'<b>importo</b> (es. <code>120</code> o <code>1.250,50</code>)\n/annulla per uscire`, { inline_keyboard: [] }); return;
  }
  if (d.startsWith("spd:")) {
    const off = parseInt(d.slice(4), 10) || 0;
    const spesa = pend.spesa || {}; spesa.data = new Date(Date.now() + off * 864e5).toLocaleDateString("sv-SE", { timeZone: "Europe/Rome" });
    await rispondi();
    const t = await insertSpesaBot(spesa, da); await setPending(chat, null); await edit(t, { inline_keyboard: [] }); return;
  }
  if (d === "spdw:") {
    const spesa = pend.spesa || {}; spesa.attesa = "data"; await setPending(chat, { spesa });
    await rispondi(); await edit("✏️ Scrivimi la <b>data</b> della spesa (es. <code>05/08/2026</code>)\n/annulla per uscire", { inline_keyboard: [] }); return;
  }
  if (d === "pgok:") {
    await rispondi();
    const pay = pend.pay || {};
    await edit(riepPay(pay) + "\n\n🔎 Cerco la fattura da abbinare…", { inline_keyboard: [] });
    const kb = await kbCandidati(pay);
    await setPending(chat, { pay });
    await tgApi("editMessageText", { chat_id: chat, message_id: msgId, text: riepPay(pay) + "\n\n<b>Quale fattura sto pagando?</b>", parse_mode: "HTML", reply_markup: kb });
    return;
  }
  if (d === "pgc:") {
    const pay = pend.pay || {}; pay.attesa = "importo";
    await setPending(chat, { pay });
    await rispondi();
    await edit("✏️ Scrivimi l'<b>importo corretto</b> (es. <code>732</code> o <code>1.049,20</code>)\n/annulla per uscire", { inline_keyboard: [] });
    return;
  }
  if (d === "pgn:") {
    const pay = pend.pay || {}; pay.attesa = "numfatt";
    await setPending(chat, { pay });
    await rispondi();
    await edit("🔢 Scrivimi il <b>numero della fattura</b> (es. <code>192/2026</code>)\n/annulla per uscire", { inline_keyboard: [] });
    return;
  }
  if (d.startsWith("pgf:")) {
    const fid = d.slice(4);
    const { data: f } = await sb.from("fatture").select("*").eq("id", fid).single();
    await rispondi();
    if (!f) { await edit("⚠ Fattura non trovata, riprova.", { inline_keyboard: [[{ text: "❌ annulla", callback_data: "pgx:" }]] }); return; }
    const pay = pend.pay || {}; pay.fid = fid; pay.fnum = f.numero; pay.fcli = f.cliente; pay.fres = residuoFatt(f);
    await setPending(chat, { pay });
    const imp = +pay.importo || 0; const res = pay.fres;
    const quasiSaldo = Math.abs(res - imp) <= Math.max(1, res * 0.02) || Math.abs(res - imp * 1.22) <= Math.max(1, res * 1.22 * 0.02);
    const righe: any[] = [];
    if (quasiSaldo) righe.push([{ text: `✅ Salda tutto (${fmtE(res)})`, callback_data: "pgs:" + fid }]);
    righe.push([{ text: `💶 Acconto di ${fmtE(imp)}`, callback_data: "pga:" + fid }]);
    if (!quasiSaldo) righe.push([{ text: `✅ Salda comunque (${fmtE(res)})`, callback_data: "pgs:" + fid }]);
    righe.push([{ text: "↩️ un'altra fattura", callback_data: "pgok:" }, { text: "❌ annulla", callback_data: "pgx:" }]);
    await edit(`🧾 <b>${f.numero}</b> — ${f.cliente}\nTotale ${fmtE(+f.importo || 0)} · resta da incassare <b>${fmtE(res)}</b>\nBonifico letto: <b>${fmtE(imp)}</b> del ${pay.data ? fd(pay.data) : "?"}\n\nCome lo registro?`, { inline_keyboard: righe });
    return;
  }
  if (d.startsWith("pgs:") || d.startsWith("pga:")) {
    const fid = d.slice(4); const pay = pend.pay || {}; pay.fid = fid;
    pay.op = d.startsWith("pgs:") ? "saldo" : "acconto";
    if (pay.op === "saldo") pay.importo = pay.fres != null ? pay.fres : (+pay.importo || 0);
    await rispondi();
    if (pay.op === "acconto" && !(+pay.importo)) { pay.attesa = "importo_acc"; await setPending(chat, { pay }); await edit("💶 <b>Acconto</b> — scrivimi l'<b>importo</b> ricevuto (es. <code>300</code> o <code>1.049,20</code>)\n/annulla per uscire", { inline_keyboard: [] }); return; }
    await setPending(chat, { pay });
    if (!pay.data) { await edit("📅 Di che <b>data</b> è il pagamento?", kbDataPag()); return; }
    await edit("💳 Con quale <b>modalità</b>?", kbModalita()); return;
  }
  if (d.startsWith("pgd:")) {
    const off = parseInt(d.slice(4), 10) || 0;
    const pay = pend.pay || {}; pay.data = new Date(Date.now() + off * 864e5).toLocaleDateString("sv-SE", { timeZone: "Europe/Rome" });
    await setPending(chat, { pay }); await rispondi();
    await edit(`📅 ${fd(pay.data)} · 💳 Con quale <b>modalità</b>?`, kbModalita()); return;
  }
  if (d === "pgdw:") {
    const pay = pend.pay || {}; pay.attesa = "data"; await setPending(chat, { pay });
    await rispondi(); await edit("✏️ Scrivimi la <b>data</b> del pagamento (es. <code>05/08/2026</code>)\n/annulla per uscire", { inline_keyboard: [] }); return;
  }
  if (d.startsWith("pgm:")) {
    const mezzo = d.slice(4); const pay = pend.pay || {};
    if (!pay.fid) { await rispondi("sessione scaduta"); await setPending(chat, null); await edit("Sessione scaduta, ricomincia con /pagata o una foto.", { inline_keyboard: [] }); return; }
    await rispondi("registro…");
    const msgTxt = await applicaPagamento(pay.fid, pay.op === "saldo" ? "saldo" : "acconto", +pay.importo || 0, pay.data || oggi(), pay.causale || "", mezzo);
    await setPending(chat, null);
    await edit(msgTxt + `\n💳 ${mezzo}\n\n<i>Lo rivedi nel gestionale (dato sul cloud).</i>`, { inline_keyboard: [] });
    return;
  }

  if (d === "tk:") { await rispondi(); await setPending(chat, null); await edit("⏱ <b>Timbrature</b> — tocca un nome · /pianifica per organizzare le giornate", await kbTimbra()); return; }
  if (d === "pl:") { await rispondi(); await setPending(chat, null); await edit("📅 <b>Pianifica</b> — per quale giorno?", kbGiorni()); return; }
  if (d.startsWith("plg:")) {
    const dataRif = d.slice(4);
    await setPending(chat, { pl: { d: dataRif, sq: [] } });
    await rispondi();
    const B = await blob();
    const kb = kbCantieri(B, "plc:");
    kb.inline_keyboard.unshift([{ text: "➕ Cantiere NUOVO (lo scrivo io)", callback_data: "pln:" }]);
    await edit(`📅 <b>${fd(dataRif)}</b> — su quale cantiere?`, kb); return;
  }
  if (d === "pln:") {
    const pl = pend.pl || { sq: [] }; pl.attesa = "nomecant";
    await setPending(chat, { pl });
    await rispondi();
    await edit("✏️ Scrivimi il <b>nome del nuovo cantiere</b> (es. <code>Festa patronale Capua — Comune</code>)\n/annulla per lasciar perdere", { inline_keyboard: [] }); return;
  }
  if (d.startsWith("plu:")) {
    const cantId = d.slice(4); const B = await blob();
    const c = (B.cantieri || []).find((x: any) => x.id === cantId);
    const pl = pend.pl || {}; pl.c = cantId; pl.cn = c?.nome || ""; pl.nuovo = false;
    await setPending(chat, { pl });
    await rispondi("✓ uso quello esistente");
    await edit(`📅 <b>${fd(pl.d)}</b> · <b>${pl.cn}</b> — orario d'inizio?`, kbOrariPl()); return;
  }
  if (d === "plf:") {
    const pl = pend.pl || {};
    await rispondi();
    await edit(`📅 <b>${fd(pl.d)}</b> · <b>${pl.cn}</b> <i>(NUOVO)</i> — orario d'inizio?`, kbOrariPl()); return;
  }
  if (d.startsWith("plc:")) {
    const cantId = d.slice(4); const B = await blob();
    const c = (B.cantieri || []).find((x: any) => x.id === cantId);
    const pl = pend.pl || {}; pl.c = cantId; pl.cn = c?.nome || ""; pl.nuovo = false;
    await setPending(chat, { pl });
    await rispondi();
    await edit(`📅 <b>${fd(pl.d)}</b> · <b>${pl.cn}</b> — orario d'inizio?`, kbOrariPl()); return;
  }
  if (d.startsWith("plo:")) {
    const v = d.slice(4);
    const pl = pend.pl || {};
    pl.o = v === "-" ? "" : v.slice(0, 2) + ":" + v.slice(2);
    await setPending(chat, { pl });
    await rispondi();
    await edit(riepPl(pl), await kbOperaiPl(pl)); return;
  }
  if (d.startsWith("plp:")) {
    const id = d.slice(4); const B = await blob();
    const p = (B.personale || []).find((x: any) => x.id === id);
    const pl = pend.pl || {}; pl.sq = pl.sq || [];
    if (p) { const i = pl.sq.indexOf(p.nome); if (i >= 0) pl.sq.splice(i, 1); else pl.sq.push(p.nome); }
    await setPending(chat, { pl });
    await rispondi(p ? p.nome : "");
    await edit(riepPl(pl), await kbOperaiPl(pl)); return;
  }
  if (d === "plok") {
    const pl = pend.pl || {};
    if (!pl.d || !pl.cn) { await rispondi("proposta incompleta"); return; }
    await sb.from("pianificazioni_bot").insert({ data_rif: pl.d, cantiere_id: pl.c || null, cantiere: pl.cn, ora_inizio: pl.o || null, squadra: pl.sq || [], note: pl.nuovo ? "NUOVO CANTIERE" : null, creato_da: da });
    await setPending(chat, null);
    await rispondi("✅ salvata");
    await edit(`✅ <b>Proposta salvata!</b>\n\n${riepPl(pl)}\n\n<i>${pl.nuovo ? "Il cantiere è NUOVO: il Planning lo creerà come «da confermare» col tuo OK. " : ""}Alla prossima apertura del Planning te la propone — l'ultima parola resta alle app.</i>`, { inline_keyboard: [
      [{ text: "➕ Un'altra giornata", callback_data: "pl:" }],
      [{ text: "⏱ Timbrature", callback_data: "tk:" }],
    ] }); return;
  }
  if (d === "tst:") {
    await rispondi();
    const st = await statoOggi();
    const dentro = Object.values(st).filter((s: any) => s.tipo === "ingresso");
    const perCant: Record<string, string[]> = {};
    dentro.forEach((s: any) => { const k = s.cantiere || "?"; (perCant[k] = perCant[k] || []).push(s.dip_nome + " (" + hhmm(s.ts) + ")"); });
    const txt = dentro.length ? "📋 <b>In cantiere adesso:</b>\n" + Object.entries(perCant).map(([c, pp]) => `📍 <b>${c}</b>\n` + pp.map(x => "  • " + x).join("\n")).join("\n") : "📋 Nessuno risulta in cantiere adesso.";
    await edit(txt, await kbTimbra()); return;
  }
  if (d.startsWith("tb:")) {
    const id = d.slice(3); const st = await statoOggi(); const s = st[id]; const B = await blob();
    const p = (B.personale || []).find((x: any) => x.id === id);
    await rispondi();
    if (s && s.tipo === "ingresso") {
      if (admin) await edit(`🟢 <b>${p?.nome}</b> è su <b>${s.cantiere}</b> dalle ${hhmm(s.ts)}. Che facciamo?`, { inline_keyboard: [
        [{ text: "🔴 Uscita (fine giornata)", callback_data: "tuo:" + id }],
        [{ text: "🔄 Cambio cantiere", callback_data: "tcx:" + id }],
        [{ text: "↩️ indietro", callback_data: "tk:" }],
      ] });
      else { const nome = await timbra(id, "uscita", s.cantiere_id, s.cantiere, da); await edit(`🔴 ${nome} → uscita ${hhmm(new Date())}`, await kbTimbra()); }
    } else {
      await edit(`⚪ <b>${p?.nome}</b> — su quale cantiere entra?`, kbCantieri(B, "tc:" + id + ":"));
    }
    return;
  }
  if (d.startsWith("tuo:")) {
    const id = d.slice(4);
    await rispondi();
    await edit(`🔴 <b>Uscita</b> — a che ora è uscito?`, kbOrario("th:u:" + id + "::")); return;
  }
  if (d.startsWith("tcx:")) {
    const id = d.slice(4); const B = await blob(); const st = await statoOggi();
    await rispondi();
    await edit(`🔄 <b>Cambio cantiere</b> — dove va?`, kbCantieri(B, "tcc:" + id + ":", st[id]?.cantiere_id)); return;
  }
  if (d.startsWith("tcc:")) {
    const [, id, cantId] = d.split(":"); const B = await blob();
    const c = (B.cantieri || []).find((x: any) => x.id === cantId);
    await rispondi();
    await edit(`🔄 Passa su <b>${c?.nome}</b> — a che ora?\n<i>(stessa ora: uscita dal cantiere attuale + nuovo ingresso)</i>`, kbOrario("th:x:" + id + ":" + cantId + ":")); return;
  }
  if (d.startsWith("tc:")) {
    const [, id, cantId] = d.split(":");
    await rispondi();
    if (admin) { const B = await blob(); const c = (B.cantieri || []).find((x: any) => x.id === cantId);
      await edit(`🟢 <b>Ingresso</b> su <b>${c?.nome}</b> — a che ora è entrato?`, kbOrario("th:i:" + id + ":" + cantId + ":"));
    } else {
      const B = await blob(); const c = (B.cantieri || []).find((x: any) => x.id === cantId);
      const nome = await timbra(id, "ingresso", cantId, c?.nome || "", da);
      await edit(`🟢 ${nome} → ingresso ${hhmm(new Date())}`, await kbTimbra());
    }
    return;
  }
  if (d.startsWith("th:")) {
    const [, op, id, cantId, offS] = d.split(":");
    const off = parseInt(offS || "0", 10) || 0;
    const ts = new Date(Date.now() + off * 60000).toISOString();
    await rispondi();
    if (op === "x") { const msgTxt = await cambioCantiere(id, cantId, da, ts); await edit(msgTxt, await kbTimbra()); return; }
    const B = await blob(); const st = await statoOggi();
    let cId = cantId || null, cNome: string | null = null;
    if (op === "i") { const c = (B.cantieri || []).find((x: any) => x.id === cantId); cNome = c?.nome || ""; }
    else { const s = st[id]; cId = s?.cantiere_id || null; cNome = s?.cantiere || null; }
    const nome = await timbra(id, op === "i" ? "ingresso" : "uscita", cId, cNome, da, ts);
    await edit((op === "i" ? "🟢 " : "🔴 ") + `<b>${nome}</b> → ` + (op === "i" ? "ingresso" : "uscita") + " alle <b>" + hhmm(ts) + "</b> ✓", await kbTimbra()); return;
  }
  if (d.startsWith("tw:")) {
    const [, op, id, cantId] = d.split(":");
    await setPending(chat, { op, dip: id, cant: cantId || null });
    await rispondi();
    await edit("✏️ Scrivimi l'orario " + (op === "i" ? "di <b>ingresso</b>" : op === "x" ? "del <b>cambio cantiere</b>" : "di <b>uscita</b>") + " (es. <code>7:30</code> o <code>18.45</code>)\n/annulla per lasciar perdere", { inline_keyboard: [] }); return;
  }
  if (d === "ts:") { await rispondi(); const B = await blob(); await edit("👥 <b>Squadra intera</b> — su quale cantiere?", kbCantieri(B, "tsg:")); return; }
  if (d.startsWith("tsg:")) {
    const cantId = d.slice(4);
    await rispondi();
    await edit("👥 A che ora è entrata la squadra?", { inline_keyboard: [
      [{ text: "🕐 Adesso", callback_data: "tsq:" + cantId + ":0" }],
      [{ text: "30 min fa", callback_data: "tsq:" + cantId + ":-30" }, { text: "1 ora fa", callback_data: "tsq:" + cantId + ":-60" }, { text: "2 ore fa", callback_data: "tsq:" + cantId + ":-120" }],
      [{ text: "↩️ indietro", callback_data: "tk:" }],
    ] }); return;
  }
  if (d.startsWith("tsq:")) {
    const [, cantId, offS] = d.split(":"); const B = await blob(); const st = await statoOggi();
    const c = (B.cantieri || []).find((x: any) => x.id === cantId);
    const righe = (B.personale || []).slice().sort((a: any, b: any) => a.nome.localeCompare(b.nome)).map((p: any) => {
      const s = st[p.id]; const dentroQui = s && s.tipo === "ingresso" && s.cantiere_id === cantId;
      return [{ text: `${dentroQui ? "🟢" : "⚪"} ${p.nome}`, callback_data: "tsi:" + p.id + ":" + cantId + ":" + (offS || "0") }];
    });
    righe.push([{ text: "🔴 USCITA di tutti da questo cantiere", callback_data: "tso:" + cantId }]);
    righe.push([{ text: "✅ fatto", callback_data: "tk:" }]);
    await rispondi();
    await edit(`👥 <b>${c?.nome}</b> — tocca chi ENTRA (⚪→🟢)${offS && offS !== "0" ? " · orario: " + hhmm(new Date(Date.now() + parseInt(offS) * 60000)) : ""}`, { inline_keyboard: righe }); return;
  }
  if (d.startsWith("tsi:")) {
    const [, id, cantId, offS] = d.split(":"); const B = await blob();
    const c = (B.cantieri || []).find((x: any) => x.id === cantId);
    const st = await statoOggi(); const s = st[id];
    if (s && s.tipo === "ingresso" && s.cantiere_id === cantId) { await rispondi("già dentro qui"); return; }
    const off = parseInt(offS || "0", 10) || 0;
    const ts = new Date(Date.now() + off * 60000).toISOString();
    if (s && s.tipo === "ingresso") { await cambioCantiere(id, cantId, da, ts); await rispondi("🔄 " + (s.dip_nome || "")); }
    else { const nome = await timbra(id, "ingresso", cantId, c?.nome || "", da, ts); await rispondi("🟢 " + nome + " " + hhmm(ts)); }
    await gestisciCallback({ ...cb, data: "tsq:" + cantId + ":" + (offS || "0"), id: cb.id + "x" }); return;
  }
  if (d.startsWith("tso:")) {
    const cantId = d.slice(4); const st = await statoOggi();
    const dentro = Object.entries(st).filter(([, s]: any) => s.tipo === "ingresso" && s.cantiere_id === cantId);
    for (const [id, s] of dentro as any) await timbra(id, "uscita", cantId, s.cantiere, da);
    await rispondi("🔴 usciti: " + dentro.length);
    await edit("⏱ <b>Timbrature</b> — tocca un nome", await kbTimbra()); return;
  }
  await rispondi();
}

async function gestisciTestoPagamento(chat: number, testo: string, pay: any): Promise<boolean> {
  if (testo === "/annulla") { await setPending(chat, null); await tgSend(chat, "Ok, annullato. /pagata o una foto per ripartire."); return true; }
  if (pay.attesa === "importo_acc") {
    const v = parseFloat(testo.replace(/\./g, "").replace(",", ".").replace(/[^\d.]/g, ""));
    if (!isFinite(v) || v <= 0) { await tgSend(chat, "✏️ Importo non valido, riprova (es. 300) — /annulla"); return true; }
    pay.importo = v; delete pay.attesa; await setPending(chat, { pay });
    if (!pay.data) { await tgSend(chat, "📅 Di che data è il pagamento?", kbDataPag()); return true; }
    await tgSend(chat, "💳 Con quale modalità?", kbModalita()); return true;
  }
  if (pay.attesa === "data") {
    const m = testo.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/);
    if (!m) { await tgSend(chat, "✏️ Data non valida — scrivila come 05/08/2026 (o /annulla)"); return true; }
    const yy = m[3].length === 2 ? "20" + m[3] : m[3];
    pay.data = `${yy}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`; delete pay.attesa; await setPending(chat, { pay });
    await tgSend(chat, `📅 ${fd(pay.data)} · 💳 Con quale modalità?`, kbModalita()); return true;
  }
  if (pay.attesa === "importo") {
    const v = parseFloat(testo.replace(/\./g, "").replace(",", ".").replace(/[^\d.]/g, ""));
    if (!isFinite(v) || v <= 0) { await tgSend(chat, "✏️ Importo non valido, riprova (es. 732 o 1.049,20) — /annulla per uscire"); return true; }
    pay.importo = v; delete pay.attesa;
    await setPending(chat, { pay });
    const kb = await kbCandidati(pay);
    await setPending(chat, { pay });
    await tgSend(chat, riepPay(pay) + "\n\n<b>Quale fattura sto pagando?</b>", kb);
    return true;
  }
  if (pay.attesa === "numfatt") {
    const num = testo.trim();
    const { data: fs } = await sb.from("fatture").select("*").eq("numero", num);
    const f = (fs || [])[0];
    if (!f) { await tgSend(chat, `⚠ Non trovo la fattura <b>${num}</b>. Riscrivila (es. 192/2026) o /annulla`); return true; }
    delete pay.attesa; pay.fid = f.id; pay.fnum = f.numero; pay.fcli = f.cliente; pay.fres = residuoFatt(f);
    await setPending(chat, { pay });
    const imp = +pay.importo || 0; const res = pay.fres;
    const righe: any[] = [
      [{ text: `✅ Salda tutto (${fmtE(res)})`, callback_data: "pgs:" + f.id }],
      [{ text: imp > 0 ? `💶 Acconto di ${fmtE(imp)}` : "💶 Acconto (scrivo l'importo)", callback_data: "pga:" + f.id }],
      [{ text: "❌ annulla", callback_data: "pgx:" }],
    ];
    await tgSend(chat, `🧾 <b>${f.numero}</b> — ${f.cliente}\nTotale ${fmtE(+f.importo || 0)} · resta da incassare <b>${fmtE(res)}</b>${imp > 0 ? `\nBonifico letto: <b>${fmtE(imp)}</b> del ${pay.data ? fd(pay.data) : "?"}` : ""}\n\nCome lo registro?`, { inline_keyboard: righe });
    return true;
  }
  return false;
}

async function gestisciFotoDistinta(chat: number, fileId: string) {
  await tgSend(chat, "🧾 Sto leggendo la distinta…");
  let pay: any;
  try {
    const foto = await fotoB64(fileId);
    if (!foto) { await tgSend(chat, "⚠ Non sono riuscito a scaricare l'immagine, riprova."); return; }
    pay = await estraiDistinta(foto.b64, foto.mime);
  } catch (e) {
    await tgSend(chat, "⚠ Non sono riuscito a leggere la distinta (" + (e as Error).message + "). Puoi segnare il pagamento dal gestionale, oppure riprova con una foto più nitida.");
    return;
  }
  await setPending(chat, { pay });
  await tgSend(chat, riepPay(pay) + "\n\n<b>Ho letto bene?</b>", { inline_keyboard: [
    [{ text: "✅ Sì, cerca la fattura", callback_data: "pgok:" }],
    [{ text: "✏️ Correggi l'importo", callback_data: "pgc:" }],
    [{ text: "❌ annulla", callback_data: "pgx:" }],
  ] });
}

// ─── BRIEF ───
async function brief(): Promise<string> {
  const d = oggi();
  const B = await blob();
  const cantieri = (B.cantieri || []).filter(operativo);   // 🛑 i rifiutati (persi), conclusi e archiviati NON sono lavorazioni
  const r: string[] = [`🌅 <b>Buongiorno! Il quadro di oggi ${fd(d)}</b>`];
  const att: string[] = [];
  cantieri.forEach((c: any) => (c.interventi || []).forEach((iv: any) => {
    if (iv.data === d) {
      const sq = Array.isArray(iv.squadra) ? iv.squadra.filter(Boolean) : [];
      att.push(`• <b>${c.nome}</b>${iv.oraInizio ? " " + iv.oraInizio : ""}${iv.oraFine ? "–" + iv.oraFine : ""}${iv.descrizione ? " · " + iv.descrizione : ""}${sq.length ? " · 👷 " + sq.join(", ") : " · ⚠ <i>squadra da assegnare</i>"}`);
    }
  }));
  r.push("", `🔨 <b>In lavorazione oggi</b> (${att.length})`, ...(att.length ? att : ["• niente in programma"]));
  const lim = new Date(Date.now() - 7 * 864e5).toLocaleDateString("sv-SE", { timeZone: "Europe/Rome" });
  const rev = cantieri.filter((c: any) => {
    if (c.stato !== "in corso") return false;
    if (c.revisioneSnooze && c.revisioneSnooze > d) return false;
    const gg = (c.interventi || []).map((iv: any) => iv.data).filter(Boolean).sort();
    if (gg.some((x: string) => x >= d)) return false;
    const ult = gg.length ? gg[gg.length - 1] : (c.periodoFine || c.periodoInizio || "");
    return ult && ult < lim;
  });
  if (rev.length) r.push("", `❓ <b>Da rivedere</b> (fermi da +7gg): ${rev.map((c: any) => c.nome).slice(0, 5).join(" · ")}${rev.length > 5 ? " …" : ""}`);
  try {
    const pb = await sql("select count(*) n from pianificazioni_bot where stato='proposta'");
    if (pb[0]?.n > 0) r.push("", `🤖 <b>Proposte di pianificazione in attesa:</b> ${pb[0].n} — apri il Planning per applicarle`);
  } catch (_) {}
  try {
    const dc = await sql("select count(*) n from da_confermare where stato='aperta'");
    if (dc[0]?.n > 0) r.push("", `🟡 <b>Da confermare nel planning:</b> ${dc[0].n} voci in attesa`);
  } catch (_) {}
  try {
    const sv = await sql("select nome, round(saldo) s from saldi_veri where saldo > 0.009 order by saldo desc");
    if (sv.length) r.push("", `💶 <b>Da pagare ai dipendenti:</b> ${sv.reduce((a: number, x: any) => a + Number(x.s), 0)} € — ${sv.map((x: any) => x.nome + " " + x.s + "€").join(" · ")}`);
  } catch (_) {}
  try {
    const tOggi = await sql(`select count(distinct dip_id) n from timbrature where ts >= '${d}T00:00:00+02:00'`);
    if (tOggi[0]?.n > 0) r.push("", `⏱ Timbrature di oggi: ${tOggi[0].n} persone — /timbra per gestirle`);
  } catch (_) {}
  try {
    const mov = await sql(`select r.nome, a.qty, a.cantiere_nome, a.da_tipo, a.da_nome from allocazioni a join risorse r on r.id=a.risorsa_id where a.data_uscita='${d}'`);
    if (mov.length) r.push("", `📦 <b>Materiale in movimento oggi:</b>`, ...mov.map((m: any) => `• ${m.qty} ${m.nome} → ${m.cantiere_nome}${m.da_tipo === "cantiere" ? " (da " + m.da_nome + ")" : ""}`));
    const ri = await sql(`select r.nome, a.qty, a.cantiere_nome from allocazioni a join risorse r on r.id=a.risorsa_id where a.data_rientro='${d}'`);
    if (ri.length) r.push(`↩️ <b>Rientri previsti oggi:</b> ${ri.map((m: any) => m.qty + " " + m.nome + " da " + m.cantiere_nome).join(" · ")}`);
  } catch (_) {}
  try {
    const ieri = new Date(Date.now() - 864e5).toLocaleDateString("sv-SE", { timeZone: "Europe/Rome" });
    const sc = await sql(`select count(*) n from scontrini_telegram where ts::date='${ieri}'`);
    if (sc[0]?.n > 0) r.push("", `🧾 Scontrini arrivati ieri: ${sc[0].n}`);
  } catch (_) {}
  try {
    const ub = await sql("select creato_il, dimensione_kb from backup_snapshots order by creato_il desc limit 1");
    if (ub[0]) r.push("", `🛡 Ultimo backup: ${new Date(ub[0].creato_il).toLocaleString("it-IT", { timeZone: "Europe/Rome", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })} (${ub[0].dimensione_kb} KB)`);
  } catch (_) {}
  r.push("", `<i>/timbra · /pianifica · /pagata (o foto distinta) · /spesa · chiedimi qualsiasi cosa.</i>`);
  return r.join("\n");
}

// ─── CONOSCENZA DEL MODELLO DATI (usata nel prompt di Jarvis) ───
const SCHEMA = `Sei l'Assistente 81100 di Ottantunocento S.r.l. (produzione eventi, Caserta). Rispondi in italiano, breve e concreto, con numeri precisi. Usa il tool sql (SOLO SELECT, PostgreSQL) per rispondere con dati veri. Data odierna: {OGGI}.
SCRITTURE: tu non puoi scrivere nulla nel database (solo lettura). Se l'utente chiede di REGISTRARE timbrature → indica /timbra. Se chiede di PIANIFICARE giornate, squadre o CREARE UN CANTIERE NUOVO → indica /pianifica (bottone «Cantiere NUOVO» con controllo anti-doppione; il Planning applica al prossimo avvio col suo OK). Se chiede di SEGNARE un PAGAMENTO/incasso di una fattura → digli di mandarti la FOTO della distinta di bonifico oppure di usare /pagata. Se chiede di registrare una SPESA di cantiere → indica /spesa. NON dire mai che c'è un problema col database. Per altre scritture indica il gestionale.
CANTIERI RIFIUTATI: i cantieri con stato 'perso' sono lavori RIFIUTATI o non acquisiti: NON citarli MAI come lavorazioni attive o in programma, anche se hanno interventi con date future; menzionali solo se l'utente chiede espressamente dei lavori persi/rifiutati.
REGOLA D'ORO SALDI: per qualunque domanda su saldi/paghe dovute usa SEMPRE la vista saldi_veri(nome, dip_id, maturato, anticipi, pagamenti, trattenute, saldo) — ricalcolo dai movimenti; NON fidarti del campo dati->saldi. saldo>0 = azienda DEVE al dipendente.
DATI — tabella gestionale_dati (id='unico'), colonna dati (jsonb):
- cantieri[]: {id,nome,stato,periodoInizio,periodoFine,committente,statoPag,interventi[]:{data,oraInizio,oraFine,descrizione,squadra[]}}
- presenze: {data:{dipId:{turni[]:{cantiere,oraI,oraF,importo,notturno},totale}}} (vecchi: {cantiere,base,straord,totale})
- personale[]:{id,nome,ruolo,anagrafica:{cf,natoIl,natoA,residenza,docNumero,docScadenza,permesso,patente,tesseraSanitariaScad},sicurezza:{visitaMedica:{data,esito,scadenza},corsi[],limitazioni}} · personaleHR[]: schede HR planning con visite/corsi/patenti
- anticipi[] (escludi metodo='Anticipo da pagamento') · pagamenti[] · addebiti[] · carburante[] · speseCantiere[] · incassi[]
- oneri: 25€/giornata-uomo divisi equamente tra i cantieri del giorno
COSTI DI UN CANTIERE (query pesanti sul JSON, calcola coi COMPONENTI, UNA query per componente): manodopera = SUM presenze->data->dipId->turni[].importo dove lower(turni.cantiere) ILIKE il nome (jsonb_each su presenze, poi su ogni dip, poi jsonb_array_elements su 'turni'); + spese = SUM speseCantiere[].importo con quel cantiere; + carburante[]. Se dopo 2-3 query non hai il totale, RISPONDI subito coi componenti calcolati (non ritentare all'infinito).
TABELLE: timbrature(dip_id,dip_nome,cantiere_id,cantiere,tipo,ts,registrata_da,importata); pianificazioni_bot(data_rif,cantiere,ora_inizio,squadra,note,stato); attrezzeria(nome,tipo,matricola,stato,ubicazione,custode) — registro attrezzi; allocazioni(risorsa_id,cantiere_id,cantiere_nome,qty,data_uscita,data_rientro,da_tipo,da_nome); risorse; giacenze; depositi; scontrini_telegram; da_confermare; preventivi; fatture; salvataggi_log; backup_snapshots; saldi_veri (vista).
Orari sempre in Europe/Rome. Non inventare MAI numeri. Massimo 2-3 frasi + i numeri.`;

async function gestisciOrarioScritto(chat: number, testo: string, pending: any, da: string): Promise<boolean> {
  if (testo === "/annulla") { await setPending(chat, null); await tgSend(chat, "Ok, annullato. /timbra per ripartire."); return true; }
  const m = testo.match(/^([0-2]?\d)[:. ]([0-5]\d)$/);
  if (!m) { await tgSend(chat, "✏️ Non ho capito l'orario — scrivilo così: <code>7:30</code> (oppure /annulla)"); return true; }
  const hh = parseInt(m[1], 10), mm = parseInt(m[2], 10);
  if (hh > 23) { await tgSend(chat, "✏️ Ora non valida, riprova (es. 7:30)"); return true; }
  const ts = romeIso(hh, mm);
  await setPending(chat, null);
  if (pending.op === "x") { const msgTxt = await cambioCantiere(pending.dip, pending.cant, da, ts); await tgSend(chat, msgTxt + "\n/timbra per continuare"); return true; }
  const B = await blob(); const st = await statoOggi();
  let cId = pending.cant || null, cNome: string | null = null;
  if (pending.op === "i") { const c = (B.cantieri || []).find((x: any) => x.id === pending.cant); cNome = c?.nome || ""; }
  else { const s = st[pending.dip]; cId = s?.cantiere_id || null; cNome = s?.cantiere || null; }
  const nome = await timbra(pending.dip, pending.op === "i" ? "ingresso" : "uscita", cId, cNome, da, ts);
  await tgSend(chat, (pending.op === "i" ? "🟢 " : "🔴 ") + `<b>${nome}</b> → ` + (pending.op === "i" ? "ingresso" : "uscita") + " alle <b>" + String(hh).padStart(2, "0") + ":" + String(mm).padStart(2, "0") + "</b> ✓\n/timbra per continuare");
  return true;
}


// ═══════════════════════════════════════════════════════════════════════════
// ═══ JARVIS — agente in linguaggio libero ═══
// Legge i dati con `sql` (sola lettura, RPC assistente_sql) e, quando serve
// scrivere, usa gli strumenti proponi_*: ognuno salva una PROPOSTA in
// jarvis_azioni e Giuseppe la conferma col bottone ✅. Solo allora viene
// eseguita, riusando le stesse funzioni dei comandi (applicaPagamento,
// insertSpesaBot, insertRichiesta, timbra, pianificazioni_bot).
// ═══════════════════════════════════════════════════════════════════════════

const JARVIS_MODEL = "claude-opus-5";
const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });
const PROPOSTA_VALIDA_ORE = 24;

const JARVIS_SYSTEM = `Sei JARVIS, l'assistente personale di Giuseppe Giaquinto per Ottantunocento S.r.l. (produzione eventi, service audio-luci, strutture temporanee — Caserta). Giuseppe ti scrive o ti detta a voce su Telegram, spesso in fretta e con refusi: interpreta con buon senso.

COME LAVORI
- Rispondi in italiano, breve e concreto, con numeri precisi. Non inventare MAI numeri: usa lo strumento sql (solo SELECT PostgreSQL) per leggere i dati veri.
- Un messaggio può contenere più richieste ("sposta Roberto su Gaeta martedì e segna pagata la 143"): gestiscile tutte.
- Per SCRIVERE usa gli strumenti proponi_*: creano una PROPOSTA che Giuseppe conferma con un bottone. Non dire mai che hai già registrato/salvato qualcosa: di' che hai preparato la proposta da confermare. Prima di proporre verifica i dati (fattura giusta, cantiere giusto, persona libera).
- Se uno strumento restituisce un errore o più candidati, non tirare a indovinare: chiedi a Giuseppe quale intende.
- Cose che NON puoi fare (per ora): modificare ricavi/budget dei cantieri, cancellare dati, fatture fornitori, preventivi, contratti sponsor. Per queste indica l'app giusta (Gestionale, Preventivi, Contratti JC21) oppure di lavorarci con Claude.
- Se ti chiede lettere, email, diffide, comunicati o consigli (legali, marketing, lavoro, fisco): rispondi da consulente esperto con i dati aziendali, in modo pratico; per documenti lunghi o contratti completi proponi di prepararli con Claude.

FORMATO (Telegram HTML)
- Usa solo <b>, <i>, <code>. Niente Markdown (niente **, #, tabelle). Scrivi &lt; e &gt; per i simboli minore/maggiore.
- Massimo poche righe + i numeri. Date gg/mm/aaaa, importi 1.234,56 €.

DATI AZIENDALI: OTTANTUNOCENTO S.R.L., Via Gemito 95, 81100 Caserta (CE), P.IVA/C.F. 02187720616, PEC 81100@open.legalmail.it, email ottantunocentogroup@gmail.com. Legale rappresentante: De Candiziis Ivo (Amministratore). IVA standard 22%; gli enti pubblici pagano in split payment (versano l'imponibile).

REGOLE D'ORO DEI DATI
- Il ricavo di un cantiere vive in budgetCantieri (getBudget/setBudget), MAI nel campo ricavo del cantiere.
- Nomi del personale identici in tutte le app: usa quelli di dati->personale.
- Cantieri 'perso' = lavori rifiutati: mai citarli come attivi.

` + SCHEMA.split("\n").filter((r) => !r.startsWith("SCRITTURE:") && !r.startsWith("Sei l'Assistente")).join("\n");

// strict: true → gli input rispettano sempre lo schema (tutti i campi required, null se assenti)
const JARVIS_TOOLS: Anthropic.Tool[] = [
  {
    name: "sql",
    description: "Esegue UNA query SELECT PostgreSQL (sola lettura, timeout 6s) e restituisce le righe in JSON. Usala per ogni dato: cantieri, presenze, fatture, planning, materiali.",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
    strict: true,
  },
  {
    name: "proponi_pagamento",
    description: "Prepara la registrazione di un incasso su una fattura CLIENTE emessa (tabella fatture): saldo completo o acconto. Giuseppe conferma col bottone.",
    input_schema: {
      type: "object",
      properties: {
        numero_fattura: { type: "string", description: "numero come scritto da Giuseppe, es. 143 o 143/2026" },
        modo: { type: "string", enum: ["saldo", "acconto"] },
        importo: { type: ["number", "null"], description: "obbligatorio per acconto; null per saldo" },
        data: { type: ["string", "null"], description: "YYYY-MM-DD; null = oggi" },
        mezzo: { type: "string", enum: ["bonifico", "assegno", "contanti", "compensazione"] },
      },
      required: ["numero_fattura", "modo", "importo", "data", "mezzo"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "proponi_pianificazione",
    description: "Prepara una giornata di lavoro (cantiere + data + orario + squadra) come proposta per il Planning, che la applica alla prossima apertura. Controlla da solo nomi e sovrapposizioni.",
    input_schema: {
      type: "object",
      properties: {
        data: { type: "string", description: "YYYY-MM-DD" },
        cantiere: { type: "string", description: "nome (anche parziale) o id del cantiere" },
        cantiere_nuovo: { type: "boolean", description: "true SOLO se Giuseppe dice che è un cantiere nuovo che non esiste ancora" },
        ora_inizio: { type: ["string", "null"], description: "HH:MM" },
        squadra: { type: "array", items: { type: "string" }, description: "nomi delle persone (anche solo nome o cognome)" },
        note: { type: ["string", "null"] },
      },
      required: ["data", "cantiere", "cantiere_nuovo", "ora_inizio", "squadra", "note"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "proponi_spesa",
    description: "Prepara una spesa di cantiere (va in spese_bot come proposta; il Gestionale la importa).",
    input_schema: {
      type: "object",
      properties: {
        cantiere: { type: "string", description: "nome (anche parziale) o id del cantiere, oppure Deposito" },
        importo: { type: "number" },
        oggetto: { type: "string" },
        data: { type: ["string", "null"], description: "YYYY-MM-DD; null = oggi" },
      },
      required: ["cantiere", "importo", "oggetto", "data"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "proponi_richiesta",
    description: "Prepara una nuova richiesta commerciale (tabella richieste, numero REQ assegnato dal database): un cliente che chiede un servizio o un preventivo.",
    input_schema: {
      type: "object",
      properties: {
        oggetto: { type: "string" },
        cliente_nome: { type: ["string", "null"] },
        descrizione: { type: ["string", "null"] },
        luogo: { type: ["string", "null"] },
        data_evento_prevista: { type: ["string", "null"], description: "YYYY-MM-DD" },
        budget_indicativo: { type: ["number", "null"] },
        priorita: { type: "string", enum: ["alta", "media", "bassa"] },
        contatto_telefono: { type: ["string", "null"] },
      },
      required: ["oggetto", "cliente_nome", "descrizione", "luogo", "data_evento_prevista", "budget_indicativo", "priorita", "contatto_telefono"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "proponi_timbratura",
    description: "Prepara un ingresso o un'uscita di oggi per un dipendente (tabella timbrature). Un ingresso su un altro cantiere mentre è già dentro diventa un cambio cantiere.",
    input_schema: {
      type: "object",
      properties: {
        dipendente: { type: "string" },
        tipo: { type: "string", enum: ["ingresso", "uscita"] },
        cantiere: { type: ["string", "null"], description: "obbligatorio per ingresso" },
        ora: { type: ["string", "null"], description: "HH:MM di oggi; null = adesso" },
      },
      required: ["dipendente", "tipo", "cantiere", "ora"],
      additionalProperties: false,
    },
    strict: true,
  },
];

// ─── risoluzione nomi (persone, cantieri, fatture) ───
function trovaPersona(B: any, nome: string): { ok: any } | { err: string } {
  const pers: any[] = B.personale || [];
  const n = norm(nome);
  if (!n) return { err: "nome vuoto" };
  const esatto = pers.filter((p) => norm(p.nome) === n || p.id === nome);
  if (esatto.length === 1) return { ok: esatto[0] };
  const parz = pers.filter((p) => norm(p.nome).split(" ").some((t) => t === n) || norm(p.nome).includes(n));
  if (parz.length === 1) return { ok: parz[0] };
  if (parz.length > 1) return { err: `«${nome}» è ambiguo: ${parz.map((p) => p.nome).join(", ")}` };
  return { err: `nessun dipendente «${nome}». Personale: ${pers.map((p) => p.nome).join(", ")}` };
}
function trovaCantiere(B: any, q: string): { ok: any } | { err: string } {
  const cc: any[] = (B.cantieri || []).filter((c: any) => c && !c.archiviato && c.stato !== "perso");
  const byId = cc.find((c) => c.id === q);
  if (byId) return { ok: byId };
  const n = norm(q);
  const esatto = cc.filter((c) => norm(c.nome) === n);
  if (esatto.length === 1) return { ok: esatto[0] };
  const parz = cc.filter((c) => norm(c.nome).includes(n) || (n.length > 4 && n.split(" ").every((t) => norm(c.nome).includes(t))));
  const attivi = parz.filter((c) => c.stato !== "concluso");
  const scelta = attivi.length ? attivi : parz;
  if (scelta.length === 1) return { ok: scelta[0] };
  if (scelta.length > 1) return { err: `più cantieri corrispondono a «${q}»: ${scelta.slice(0, 8).map((c) => `${c.nome} [${c.stato}, id ${c.id}]`).join("; ")}` };
  return { err: `nessun cantiere «${q}». Attivi: ${cc.filter((c) => ["in corso", "in arrivo", "da confermare", "fermo"].includes(c.stato)).map((c) => c.nome).join("; ")}` };
}
async function trovaFattura(numero: string): Promise<{ ok: any } | { err: string }> {
  const num = numero.trim();
  const { data: esatte } = await sb.from("fatture").select("*").eq("numero", num);
  let lista: any[] = esatte || [];
  if (!lista.length) {
    const base = num.split("/")[0].replace(/[^\dA-Za-z-]/g, "");
    const { data: simili } = await sb.from("fatture").select("*").ilike("numero", `${base}/%`).order("data_fattura", { ascending: false });
    lista = simili || [];
  }
  if (!lista.length) return { err: `fattura «${num}» non trovata` };
  const aperte = lista.filter((f) => f.stato === "emessa");
  if (aperte.length === 1) return { ok: aperte[0] };
  if (aperte.length > 1) return { err: `più fatture aperte «${num}»: ${aperte.map((f) => `${f.numero} ${f.cliente} ${fmtE(+f.importo || 0)}`).join("; ")}` };
  return { err: `la fattura ${lista[0].numero} (${lista[0].cliente}) è già «${lista[0].stato}»` };
}
const isoOk = (s: string | null) => !s || /^\d{4}-\d{2}-\d{2}$/.test(s);
const oraOk = (s: string | null) => !s || /^([01]?\d|2[0-3]):[0-5]\d$/.test(s);

// ─── costruzione delle proposte (validano, NON scrivono sui dati) ───
async function preparaAzione(nome: string, inp: any): Promise<{ tipo: string; payload: any; riepilogo: string } | { err: string }> {
  if (nome === "proponi_pagamento") {
    if (!isoOk(inp.data)) return { err: "data non valida (YYYY-MM-DD)" };
    const r = await trovaFattura(String(inp.numero_fattura || ""));
    if ("err" in r) return r;
    const f = r.ok; const res = residuoFatt(f);
    if (inp.modo === "acconto") {
      const imp = +inp.importo || 0;
      if (imp <= 0) return { err: "per un acconto serve l'importo" };
      if (imp > res + 0.01) return { err: `l'acconto di ${fmtE(imp)} supera il residuo della ${f.numero} (${fmtE(res)}): forse è un saldo o un'altra fattura?` };
    }
    const dp = inp.data || oggi();
    const payload = { fattura_id: f.id, numero: f.numero, modo: inp.modo, importo: inp.modo === "acconto" ? +inp.importo : res, data: dp, mezzo: inp.mezzo };
    const riep = inp.modo === "saldo"
      ? `💶 <b>Segna PAGATA la ${f.numero}</b> — ${f.cliente}\nTotale ${fmtE(+f.importo || 0)} · incasso ${fmtE(res)} · ${inp.mezzo} del ${fd(dp)}`
      : `💶 <b>Acconto di ${fmtE(+inp.importo)}</b> sulla ${f.numero} — ${f.cliente}\nTotale ${fmtE(+f.importo || 0)} · dopo resteranno ${fmtE(Math.max(0, res - +inp.importo))} · ${inp.mezzo} del ${fd(dp)}`;
    return { tipo: "pagamento", payload, riepilogo: riep };
  }
  if (nome === "proponi_pianificazione") {
    if (!isoOk(inp.data) || !inp.data) return { err: "data non valida (YYYY-MM-DD)" };
    if (inp.data < oggi()) return { err: "la data è nel passato" };
    if (!oraOk(inp.ora_inizio)) return { err: "orario non valido (HH:MM)" };
    const B = await blob();
    let cant: any = null;
    if (inp.cantiere_nuovo) {
      const r = trovaCantiere(B, inp.cantiere);
      if ("ok" in r) return { err: `esiste già il cantiere «${r.ok.nome}» [${r.ok.stato}]: usa quello o conferma a Giuseppe che è davvero un altro` };
    } else {
      const r = trovaCantiere(B, inp.cantiere);
      if ("err" in r) return r;
      cant = r.ok;
    }
    const squadra: string[] = [];
    for (const n of inp.squadra || []) {
      const p = trovaPersona(B, n);
      if ("err" in p) return p;
      if (!squadra.includes(p.ok.nome)) squadra.push(p.ok.nome);
    }
    // sovrapposizioni: interventi già in agenda + proposte non ancora applicate
    const avvisi: string[] = [];
    for (const c of (B.cantieri || []).filter(operativo)) {
      if (cant && c.id === cant.id) continue;
      for (const iv of c.interventi || []) {
        if (iv?.data !== inp.data) continue;
        for (const nomeP of squadra) if ((iv.squadra || []).includes(nomeP)) avvisi.push(`${nomeP} è già su ${c.nome}${iv.oraInizio ? " (" + iv.oraInizio + ")" : ""}`);
      }
    }
    const { data: altre } = await sb.from("pianificazioni_bot").select("cantiere,squadra").eq("data_rif", inp.data).eq("stato", "proposta");
    for (const a of altre || []) for (const nomeP of squadra) if ((a.squadra || []).includes(nomeP) && a.cantiere !== (cant?.nome || inp.cantiere)) avvisi.push(`${nomeP} è già proposto su ${a.cantiere}`);
    const cn = cant ? cant.nome : String(inp.cantiere).slice(0, 80);
    const payload = { data: inp.data, cantiere_id: cant?.id || null, cantiere: cn, ora_inizio: inp.ora_inizio || null, squadra, nuovo: !cant, note: inp.note || null };
    const riep = `📅 <b>${fd(inp.data)}</b> · 📍 <b>${cn}</b>${cant ? "" : " <i>(NUOVO)</i>"}${inp.ora_inizio ? " · ore " + inp.ora_inizio : ""}\n👷 ${squadra.length ? squadra.join(", ") : "<i>squadra da definire</i>"}${inp.note ? "\n📝 " + inp.note : ""}${avvisi.length ? "\n⚠️ " + avvisi.join("\n⚠️ ") + "\n<i>(se va spostato, toglilo dall'altro cantiere nel Planning)</i>" : ""}`;
    return { tipo: "pianificazione", payload, riepilogo: riep };
  }
  if (nome === "proponi_spesa") {
    if (!isoOk(inp.data)) return { err: "data non valida (YYYY-MM-DD)" };
    if (!(+inp.importo > 0)) return { err: "importo non valido" };
    const B = await blob();
    let cid: string | null = null; let cnome = String(inp.cantiere);
    if (norm(inp.cantiere) !== "deposito") {
      const r = trovaCantiere(B, inp.cantiere);
      if ("err" in r) return r;
      cid = r.ok.id; cnome = r.ok.nome;
    } else cnome = "Deposito";
    const dt = inp.data || oggi();
    const payload = { cid, cnome, importo: +inp.importo, oggetto: String(inp.oggetto).slice(0, 120), data: dt };
    return { tipo: "spesa", payload, riepilogo: `🧾 <b>Spesa ${fmtE(+inp.importo)}</b> — ${payload.oggetto}\n📍 ${cnome} · 📅 ${fd(dt)}` };
  }
  if (nome === "proponi_richiesta") {
    if (!isoOk(inp.data_evento_prevista)) return { err: "data evento non valida (YYYY-MM-DD)" };
    const row: any = { oggetto: String(inp.oggetto).slice(0, 140), priorita: inp.priorita };
    for (const k of ["cliente_nome", "descrizione", "luogo", "data_evento_prevista", "budget_indicativo", "contatto_telefono"]) if (inp[k] != null && inp[k] !== "") row[k] = inp[k];
    const riep = `📥 <b>Nuova richiesta</b> — ${row.oggetto}${row.cliente_nome ? "\n👤 " + row.cliente_nome : ""}${row.luogo ? "\n📍 " + row.luogo : ""}${row.data_evento_prevista ? "\n📅 " + fd(row.data_evento_prevista) : ""}${row.budget_indicativo ? "\n💶 budget " + fmtE(+row.budget_indicativo) : ""}\nPriorità: ${inp.priorita}`;
    return { tipo: "richiesta", payload: row, riepilogo: riep };
  }
  if (nome === "proponi_timbratura") {
    if (!oraOk(inp.ora)) return { err: "orario non valido (HH:MM)" };
    const B = await blob();
    const p = trovaPersona(B, inp.dipendente);
    if ("err" in p) return p;
    const st = await statoOggi(); const s = st[p.ok.id];
    let ts: string | null = null;
    if (inp.ora) { const [hh, mm] = inp.ora.split(":").map((x: string) => parseInt(x, 10)); ts = romeIso(hh, mm); }
    if (inp.tipo === "uscita") {
      if (!s || s.tipo !== "ingresso") return { err: `${p.ok.nome} oggi non risulta entrato: niente uscita da registrare` };
      return { tipo: "timbratura", payload: { dip: p.ok.id, tipo: "uscita", ts }, riepilogo: `🔴 <b>Uscita</b> di ${p.ok.nome} da ${s.cantiere} alle ${inp.ora || "adesso"}` };
    }
    if (!inp.cantiere) return { err: "per un ingresso serve il cantiere" };
    const r = trovaCantiere(B, inp.cantiere);
    if ("err" in r) return r;
    const cambio = s && s.tipo === "ingresso" && s.cantiere_id !== r.ok.id;
    if (s && s.tipo === "ingresso" && s.cantiere_id === r.ok.id) return { err: `${p.ok.nome} è già dentro su ${r.ok.nome} dalle ${hhmm(s.ts)}` };
    return { tipo: "timbratura", payload: { dip: p.ok.id, tipo: cambio ? "cambio" : "ingresso", cid: r.ok.id, cnome: r.ok.nome, ts },
      riepilogo: cambio ? `🔄 <b>Cambio cantiere</b>: ${p.ok.nome} da ${s.cantiere} a <b>${r.ok.nome}</b> alle ${inp.ora || "adesso"}` : `🟢 <b>Ingresso</b> di ${p.ok.nome} su <b>${r.ok.nome}</b> alle ${inp.ora || "adesso"}` };
  }
  return { err: "strumento sconosciuto" };
}

// ─── esecuzione di una proposta confermata ───
async function eseguiAzione(az: any, da: string): Promise<string> {
  const p = az.payload || {};
  if (az.tipo === "pagamento") {
    const { data: f } = await sb.from("fatture").select("stato,acconti,importo").eq("id", p.fattura_id).single();
    if (!f || f.stato !== "emessa") throw new Error("la fattura non è più aperta (stato: " + (f?.stato || "?") + ")");
    if (p.modo === "acconto" && +p.importo > residuoFatt(f) + 0.01) throw new Error("l'acconto supera il residuo attuale");
    return await applicaPagamento(p.fattura_id, p.modo, +p.importo || 0, p.data, "", p.mezzo);
  }
  if (az.tipo === "pianificazione") {
    const { error } = await sb.from("pianificazioni_bot").insert({ data_rif: p.data, cantiere_id: p.cantiere_id, cantiere: p.cantiere, ora_inizio: p.ora_inizio, squadra: p.squadra || [], note: [p.nuovo ? "NUOVO CANTIERE" : null, p.note].filter(Boolean).join(" · ") || null, creato_da: "Jarvis · " + da });
    if (error) throw new Error(error.message);
    return `✅ Proposta di planning salvata: ${fd(p.data)} · ${p.cantiere}.\n<i>${p.nuovo ? "Cantiere NUOVO: il Planning lo crea «da confermare» col tuo OK. " : ""}Alla prossima apertura del Planning la applichi.</i>`;
  }
  if (az.tipo === "spesa") return await insertSpesaBot(p, "Jarvis · " + da);
  if (az.tipo === "richiesta") {
    const num = await insertRichiesta({ ...p, richiedente_nome: da, creato_da: "Jarvis", note: "Inserita da Jarvis (Telegram)" });
    if (!num) throw new Error("il database non ha restituito il numero");
    return `✅ Richiesta <b>${num}</b> registrata.\nLa completi e la trasformi in preventivo in <b>Preventivi → 📥 Richieste</b>.`;
  }
  if (az.tipo === "timbratura") {
    const ts = p.ts || new Date().toISOString();
    if (p.tipo === "cambio") return await cambioCantiere(p.dip, p.cid, "Jarvis · " + da, ts);
    if (p.tipo === "uscita") {
      const s = (await statoOggi())[p.dip];
      if (!s || s.tipo !== "ingresso") throw new Error("risulta già uscito");
      const nome = await timbra(p.dip, "uscita", s.cantiere_id, s.cantiere, "Jarvis · " + da, ts);
      return `🔴 <b>${nome}</b> → uscita alle <b>${hhmm(ts)}</b> ✓`;
    }
    const nome = await timbra(p.dip, "ingresso", p.cid, p.cnome, "Jarvis · " + da, ts);
    return `🟢 <b>${nome}</b> → ingresso su <b>${p.cnome}</b> alle <b>${hhmm(ts)}</b> ✓`;
  }
  throw new Error("tipo di azione sconosciuto");
}

// ─── invio "sicuro": se l'HTML non è valido per Telegram, reinvia come testo semplice ───
async function tgSendSafe(chat: number, text: string, kb?: any) {
  for (let i = 0; i < text.length; i += 3800) {
    const parte = text.slice(i, i + 3800);
    const extra = kb && i === 0 ? { reply_markup: kb } : {};
    const r = await tgApi("sendMessage", { chat_id: chat, text: parte, parse_mode: "HTML", disable_web_page_preview: true, ...extra });
    if (!r?.ok) await tgApi("sendMessage", { chat_id: chat, text: parte.replace(/<\/?(b|i|code)>/g, ""), disable_web_page_preview: true, ...extra });
  }
}
const kbAzione = (id: string) => ({ inline_keyboard: [[{ text: "✅ Conferma", callback_data: "jx:" + id }, { text: "❌ Annulla", callback_data: "jn:" + id }]] });

// ─── il ciclo dell'agente ───
async function jarvis(chat: number, testo: string, da: string) {
  tgApi("sendChatAction", { chat_id: chat, action: "typing" }).catch(() => {});
  const { data: storia } = await sb.from("assistente_messaggi").select("ruolo,testo").eq("telegram_id", chat).order("ts", { ascending: false }).limit(10);
  const messages: Anthropic.Beta.BetaMessageParam[] = (storia || []).reverse()
    .filter((m: any) => m.testo && (m.ruolo === "user" || m.ruolo === "assistant"))
    .map((m: any) => ({ role: m.ruolo, content: m.testo }));
  // la storia deve iniziare con un turno utente e alternare i ruoli
  while (messages.length && messages[0].role !== "user") messages.shift();
  const adesso = new Date().toLocaleString("it-IT", { timeZone: "Europe/Rome", weekday: "long", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  messages.push({ role: "user", content: `[${adesso} · oggi ISO ${oggi()}]\n${testo}` });

  const lotto = crypto.randomUUID().slice(0, 12);
  const proposte: { id: string; riepilogo: string }[] = [];
  let risposta = "";

  for (let giro = 0; giro < 10; giro++) {
    const ultimo = giro === 9;
    let resp: any;
    try {
      resp = await anthropic.beta.messages.create({
        model: JARVIS_MODEL,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        thinking: { type: "adaptive" },
        output_config: { effort: "medium" },
        cache_control: { type: "ephemeral" },
        system: JARVIS_SYSTEM,
        tools: JARVIS_TOOLS,
        ...(ultimo ? { tool_choice: { type: "none" } } : {}),
        messages,
      } as any);
    } catch (e) {
      const msg = e instanceof Anthropic.RateLimitError ? "sono sovraccarico, riprova tra un minuto"
        : e instanceof Anthropic.AuthenticationError ? "chiave Anthropic non valida (controlla i Secrets)"
        : e instanceof Anthropic.APIError ? `errore AI ${e.status}` : "errore di rete verso l'AI";
      risposta = "⚠ " + msg + ".";
      break;
    }
    if (resp.stop_reason === "refusal") { risposta = "Su questa richiesta non posso aiutarti."; break; }
    messages.push({ role: "assistant", content: resp.content });
    const toolUses = resp.content.filter((b: any) => b.type === "tool_use");
    const txt = resp.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim();
    if (resp.stop_reason === "pause_turn") continue;
    if (!toolUses.length) { risposta = txt; break; }

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      let out: string; let isErr = false;
      try {
        if (tu.name === "sql") {
          out = JSON.stringify(await sql(String(tu.input?.query || ""))).slice(0, 30000);
        } else {
          const prep = await preparaAzione(tu.name, tu.input || {});
          if ("err" in prep) { out = "NON PROPOSTO: " + prep.err; isErr = true; }
          else {
            const { data: row, error } = await sb.from("jarvis_azioni").insert({ telegram_id: chat, tipo: prep.tipo, payload: prep.payload, riepilogo: prep.riepilogo, lotto }).select("id").single();
            if (error || !row) throw new Error(error?.message || "salvataggio proposta fallito");
            proposte.push({ id: row.id, riepilogo: prep.riepilogo });
            out = "PROPOSTA PRONTA (in attesa del ✅ di Giuseppe, NON ancora eseguita):\n" + prep.riepilogo.replace(/<\/?(b|i|code)>/g, "");
          }
        }
      } catch (e) { out = "ERRORE: " + (e as Error).message; isErr = true; }
      results.push({ type: "tool_result", tool_use_id: tu.id, content: out, ...(isErr ? { is_error: true } : {}) });
    }
    messages.push({ role: "user", content: results });
  }

  if (!risposta && !proposte.length) risposta = "Non sono riuscito a completare la risposta, riprova riformulando.";
  if (risposta) await tgSendSafe(chat, risposta);
  for (let i = 0; i < proposte.length; i++) {
    const pr = proposte[i];
    await tgSendSafe(chat, `${proposte.length > 1 ? `📝 <b>Proposta ${i + 1}/${proposte.length}</b>\n` : "📝 <b>Proposta</b>\n"}${pr.riepilogo}`, kbAzione(pr.id));
  }
  if (proposte.length > 1) await tgSendSafe(chat, `Confermo tutte e ${proposte.length}?`, { inline_keyboard: [[{ text: `✅ Conferma tutte (${proposte.length})`, callback_data: "jxa:" + lotto }]] });

  const memo = (risposta || "") + (proposte.length ? `\n[Proposte inviate: ${proposte.map((p) => p.riepilogo.replace(/<\/?(b|i|code)>/g, "").split("\n")[0]).join(" | ")}]` : "");
  await sb.from("assistente_messaggi").insert([{ telegram_id: chat, ruolo: "user", testo }, { telegram_id: chat, ruolo: "assistant", testo: memo.slice(0, 4000) }]);
}

// ─── bottoni ✅ / ❌ delle proposte ───
async function confermaAzione(id: string, chat: number, da: string): Promise<string> {
  // presa in carico atomica: un doppio tocco non esegue due volte
  const { data: az } = await sb.from("jarvis_azioni").update({ stato: "in_esecuzione" }).eq("id", id).eq("telegram_id", chat).eq("stato", "proposta").select("*").maybeSingle();
  if (!az) {
    const { data: gia } = await sb.from("jarvis_azioni").select("stato,esito").eq("id", id).maybeSingle();
    return gia ? `ℹ️ Proposta già ${gia.stato}.${gia.esito ? "\n" + gia.esito : ""}` : "⚠ Proposta non trovata.";
  }
  if (Date.now() - new Date(az.creato_il).getTime() > PROPOSTA_VALIDA_ORE * 3600e3) {
    await sb.from("jarvis_azioni").update({ stato: "scaduta", chiusa_il: new Date().toISOString() }).eq("id", id);
    return "⌛ Proposta scaduta (più di " + PROPOSTA_VALIDA_ORE + " ore): richiedimela, ricontrollo i dati.";
  }
  try {
    const esito = await eseguiAzione(az, da);
    await sb.from("jarvis_azioni").update({ stato: "eseguita", esito: esito.replace(/<\/?(b|i|code)>/g, "").slice(0, 1000), chiusa_il: new Date().toISOString() }).eq("id", id);
    return esito;
  } catch (e) {
    const m = (e as Error).message;
    await sb.from("jarvis_azioni").update({ stato: "errore", esito: m.slice(0, 500), chiusa_il: new Date().toISOString() }).eq("id", id);
    return "⚠ Non eseguita: " + m;
  }
}
async function gestisciCallbackJarvis(cb: any): Promise<boolean> {
  const d = String(cb.data || "");
  if (!/^(jx|jn|jxa):/.test(d)) return false;
  const chat = cb.message?.chat?.id; const msgId = cb.message?.message_id;
  const da = [cb.from?.first_name, cb.from?.last_name].filter(Boolean).join(" ");
  const risp = async (t?: string) => { try { await tgApi("answerCallbackQuery", { callback_query_id: cb.id, ...(t ? { text: t } : {}) }); } catch (_) {} };
  const { data: aut } = await sb.from("assistente_utenti").select("ruolo").eq("telegram_id", chat).maybeSingle();
  if (!aut || (aut.ruolo || "admin") !== "admin") { await risp("🔒 non autorizzato"); return true; }
  const testoOrig = cb.message?.text || "";
  const edit = async (t: string) => {
    const r = await tgApi("editMessageText", { chat_id: chat, message_id: msgId, text: t, parse_mode: "HTML", reply_markup: { inline_keyboard: [] } });
    if (!r?.ok) await tgApi("editMessageText", { chat_id: chat, message_id: msgId, text: t.replace(/<\/?(b|i|code)>/g, ""), reply_markup: { inline_keyboard: [] } });
  };
  if (d.startsWith("jn:")) {
    const id = d.slice(3);
    await sb.from("jarvis_azioni").update({ stato: "annullata", chiusa_il: new Date().toISOString() }).eq("id", id).eq("telegram_id", chat).eq("stato", "proposta");
    await risp("annullata");
    await edit("❌ <s>" + testoOrig.replace(/[<>&]/g, "") + "</s>\nAnnullata.");
    return true;
  }
  if (d.startsWith("jx:")) {
    await risp("eseguo…");
    const esito = await confermaAzione(d.slice(3), chat, da);
    await edit(esito);
    return true;
  }
  // jxa: conferma tutte le proposte ancora aperte dello stesso messaggio
  await risp("eseguo tutte…");
  const { data: lista } = await sb.from("jarvis_azioni").select("id").eq("lotto", d.slice(4)).eq("telegram_id", chat).eq("stato", "proposta").order("creato_il");
  const esiti: string[] = [];
  for (const a of lista || []) esiti.push(await confermaAzione(a.id, chat, da));
  await edit(esiti.length ? esiti.join("\n\n") : "ℹ️ Nessuna proposta ancora aperta in questo gruppo.");
  return true;
}

// ─── WEBHOOK ───
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };
const COORDINATORE_URL = "https://xqbhujcnjvwbwzpwjujf.supabase.co/functions/v1/coordinatore-serale";

Deno.serve(async (req) => {
  const url = new URL(req.url);
  // diagnostica: dice solo QUALI segreti sono configurati (mai il loro valore)
  if (url.searchParams.has("diag")) {
    const nomi = ["TELEGRAM_BOT_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "BOT_PAROLA", "BOT_CRON_SECRET", "TELEGRAM_WEBHOOK_SECRET"];
    return Response.json(Object.fromEntries(nomi.map((n) => [n, !!Deno.env.get(n)])));
  }
  if (CRON_SECRET && url.searchParams.get("setup") === CRON_SECRET) {
    // Telegram → coordinatore-serale (flusso serale) → inoltra qui tutto il resto
    const r = await tgApi("setWebhook", { url: COORDINATORE_URL, secret_token: WEBHOOK_SECRET, allowed_updates: ["message", "callback_query"] });
    return new Response("setWebhook: " + JSON.stringify(r));
  }
  if (CRON_SECRET && url.searchParams.get("cron") === CRON_SECRET) {
    const { data: utenti } = await sb.from("assistente_utenti").select("telegram_id");
    const testo = await brief();
    for (const u of utenti || []) await tgSend(u.telegram_id, testo);
    await sb.from("jarvis_update_visti").delete().lt("visto_il", new Date(Date.now() - 7 * 864e5).toISOString());
    await sb.from("jarvis_azioni").update({ stato: "scaduta", chiusa_il: new Date().toISOString() }).eq("stato", "proposta").lt("creato_il", new Date(Date.now() - PROPOSTA_VALIDA_ORE * 3600e3).toISOString());
    return new Response("ok brief");
  }
  if (req.method !== "POST") return new Response("Jarvis 81100");
  // solo Telegram (o il coordinatore che inoltra) conosce il secret del webhook
  if (!TG || !WEBHOOK_SECRET || req.headers.get("x-telegram-bot-api-secret-token") !== WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });

  const up = await req.json().catch(() => ({}));
  // Telegram ritenta se non rispondiamo in fretta: ogni update si elabora una volta sola
  if (typeof up.update_id === "number") {
    const { error } = await sb.from("jarvis_update_visti").insert({ update_id: up.update_id });
    if (error && error.code === "23505") return new Response("ok (già visto)");
  }
  // rispondo subito a Telegram, il lavoro continua in background
  EdgeRuntime.waitUntil(gestisciUpdate(up).catch((e) => console.error("jarvis:", e)));
  return new Response("ok");
});

async function gestisciUpdate(up: any) {
  if (up.callback_query) {
    if (await gestisciCallbackJarvis(up.callback_query)) return;
    // gli utenti "campo" possono usare solo i bottoni delle timbrature (t…)
    const cq = up.callback_query;
    const { data: a } = await sb.from("assistente_utenti").select("ruolo").eq("telegram_id", cq.message?.chat?.id).maybeSingle();
    if (a && (a.ruolo || "admin") !== "admin" && !/^t/.test(String(cq.data || ""))) {
      await tgApi("answerCallbackQuery", { callback_query_id: cq.id, text: "🔒 solo amministratore" }); return;
    }
    await gestisciCallback(cq); return;
  }
  const msg = up.message; if (!msg?.chat?.id) return;
  const chat = msg.chat.id; const testo = (msg.text || "").trim();
  const da = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ");
  const { data: aut } = await sb.from("assistente_utenti").select("telegram_id,ruolo,pending").eq("telegram_id", chat).maybeSingle();
  if (!aut) {
    if (PAROLA && (testo.toLowerCase() === `/start ${PAROLA}`.toLowerCase() || testo.toLowerCase() === PAROLA.toLowerCase())) {
      // i nuovi utenti entrano come "campo": timbrano, ma non confermano proposte di Jarvis
      await sb.from("assistente_utenti").insert({ telegram_id: chat, nome: da, ruolo: "campo" });
      await tgSend(chat, "✅ Benvenuto! Sono <b>Jarvis</b>, l'assistente di Ottantunocento.\n\n• /timbra — ingressi e uscite dai cantieri");
    } else await tgSend(chat, "🔒 Assistente riservato. Scrivi: /start + parola d'ordine");
    return;
  }
  const admin = (aut.ruolo || "admin") === "admin";
  // foto: distinta di bonifico → pagamento fattura
  if (admin && msg.photo && msg.photo.length) { await gestisciFotoDistinta(chat, msg.photo[msg.photo.length - 1].file_id); return; }
  if (admin && msg.document && /pdf|image/i.test(msg.document.mime_type || "")) { await gestisciFotoDistinta(chat, msg.document.file_id); return; }
  // voce: trascrivo e passo a Jarvis
  if (msg.voice || msg.audio) {
    if (!admin) { await tgSend(chat, "🎤 I vocali li gestisce solo l'amministratore. Usa /timbra."); return; }
    await tgSend(chat, "🎤 Sto ascoltando…");
    const testoV = await trascriviVoce((msg.voice || msg.audio).file_id);
    if (!testoV) { await tgSend(chat, "⚠ Non sono riuscito a capire l'audio, riprova o scrivimelo."); return; }
    await tgSendSafe(chat, "🎤 <i>" + testoV.replace(/[<>&]/g, "") + "</i>");
    await jarvis(chat, testoV, da);
    return;
  }
  // blindatura: un comando /... esce SEMPRE da qualsiasi procedura in sospeso (/annulla resta gestito dai singoli flussi)
  if (aut.pending && /^\/(brief|start|timbra|pianifica|pagata|incasso|spesa|richiesta)(\s|$)/i.test(testo)) {
    await setPending(chat, null); aut.pending = null;
  }
  if (aut.pending && aut.pending.pay && aut.pending.pay.attesa && testo) {
    if (await gestisciTestoPagamento(chat, testo, aut.pending.pay)) return;
  }
  if (aut.pending && aut.pending.spesa && aut.pending.spesa.attesa && testo) {
    if (await gestisciTestoSpesa(chat, testo, aut.pending.spesa, da)) return;
  }
  if (aut.pending && aut.pending.richiesta && aut.pending.richiesta.attesa && testo) {
    if (await gestisciTestoRichiesta(chat, testo, aut.pending.richiesta, da)) return;
  }
  if (aut.pending && aut.pending.pl && aut.pending.pl.attesa === "nomecant" && testo) {
    if (testo === "/annulla") { await setPending(chat, null); await tgSend(chat, "Ok, annullato. /pianifica per ripartire."); return; }
    if (!testo.startsWith("/")) {
      const pl = aut.pending.pl; pl.cn = testo.slice(0, 80); pl.c = null; pl.nuovo = true; delete pl.attesa;
      const B = await blob();
      const simile = (B.cantieri || []).find((x: any) => !x.archiviato && (norm(x.nome) === norm(testo) || norm(x.nome).includes(norm(testo)) || (norm(testo).length > 5 && norm(testo).includes(norm(x.nome)))));
      await setPending(chat, { pl });
      if (simile) {
        await tgSend(chat, `⚠ <b>Esiste già un cantiere simile:</b>\n📍 <b>${simile.nome}</b> <i>(${simile.stato})</i>\n\nUso quello o ne creo davvero uno nuovo?`, { inline_keyboard: [
          [{ text: "✅ Usa «" + simile.nome.slice(0, 30) + "»", callback_data: "plu:" + simile.id }],
          [{ text: "➕ No, crea NUOVO «" + pl.cn.slice(0, 25) + "»", callback_data: "plf:" }],
          [{ text: "❌ annulla", callback_data: "tk:" }],
        ] });
      } else {
        await tgSend(chat, `📅 <b>${fd(pl.d)}</b> · <b>${pl.cn}</b> <i>(NUOVO)</i> — orario d'inizio?`, kbOrariPl());
      }
      return;
    }
  }
  if (aut.pending && aut.pending.op && testo) { if (await gestisciOrarioScritto(chat, testo, aut.pending, da)) return; }
  if (testo === "/timbra") { await tgSend(chat, "⏱ <b>Timbrature</b> — tocca un nome", await kbTimbra()); return; }
  if (!admin) { if (testo) await tgSend(chat, "Posso aiutarti con /timbra."); return; }
  if (testo === "/brief" || testo === "/start") { await tgSend(chat, await brief()); return; }
  if (testo === "/pianifica") { await setPending(chat, null); await tgSend(chat, "📅 <b>Pianifica</b> — per quale giorno?", kbGiorni()); return; }
  if (testo === "/pagata" || testo === "/incasso") { await setPending(chat, { pay: { attesa: "numfatt" } }); await tgSend(chat, "💶 <b>Segna un pagamento</b> — scrivimi il <b>numero della fattura</b> (es. <code>192/2026</code>)\n/annulla per uscire"); return; }
  if (testo === "/spesa") { await setPending(chat, null); const B = await blob(); await tgSend(chat, "🧾 <b>Spesa di cantiere</b> — su quale cantiere?", kbCantieri(B, "sp:")); return; }
  if (testo && /^\/richiesta(\s|$)/i.test(testo)) {
    const resto = testo.replace(/^\/richiesta/i, "").trim();
    if (resto) { await creaRichiestaVeloce(chat, resto, da); }
    else { await setPending(chat, { richiesta: { attesa: "oggetto", d: {} } }); await tgSend(chat, "📥 <b>Nuova richiesta</b> — qual è l'oggetto?\n<i>Es. «Service audio-luci festa Cellole 10/09»</i>\n\n/annulla per uscire"); }
    return;
  }
  if (testo) await jarvis(chat, testo, da);
}
