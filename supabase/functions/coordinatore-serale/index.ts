// ═══ COORDINATORE SERALE 81100 ═══
// Layer proattivo serale sopra Jarvis ("jarvis-81100", ex "assistente-81100").
// - Endpoint ?sera=SECRET  → chiamato da pg_cron: alle 18:00 (Roma) invia il brief
//   criticità + diario di bordo + "pronto a organizzare domani?".
// - Webhook Telegram        → gestisce SOLO il flusso serale (callback "sera*/serac:",
//   testo quando pending.sera è attivo, comando /diario) e INOLTRA tutto il resto,
//   invariato, a Jarvis (con lo stesso secret del webhook).
// Segreti: SOLO da Supabase → Edge Functions → Secrets.
// Webhook: si imposta con  jarvis-81100?setup=SECRET

import { createClient } from "npm:@supabase/supabase-js@2";

const TG = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
const CRON_SECRET = Deno.env.get("BOT_CRON_SECRET") || "";
const WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") || "";
const JARVIS_URL = "https://xqbhujcnjvwbwzpwjujf.supabase.co/functions/v1/jarvis-81100";
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

// ─── util date (fuso Roma) ───
function romeParts(d = new Date()) {
  const s = d.toLocaleString("sv-SE", { timeZone: "Europe/Rome" }); // "YYYY-MM-DD HH:MM:SS"
  return { date: s.slice(0, 10), hour: parseInt(s.slice(11, 13)), min: parseInt(s.slice(14, 16)), full: s };
}
function romeOffsetMs(d = new Date()) {
  const s = d.toLocaleString("sv-SE", { timeZone: "Europe/Rome" });
  const u = d.toLocaleString("sv-SE", { timeZone: "UTC" });
  return Date.parse(s) - Date.parse(u);
}
const pad = (n: number) => String(n).padStart(2, "0");
function fdISO(iso: string) { // "2026-08-20" -> "20/08"
  const [y, m, g] = iso.split("-"); return `${g}/${m}`;
}
function addDaysISO(iso: string, n: number) {
  const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ─── Telegram ───
async function tgApi(method: string, body: any) {
  return await (await fetch(`https://api.telegram.org/bot${TG}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  })).json();
}
async function tgSend(chat: number, text: string, kb?: any) {
  for (let i = 0; i < text.length; i += 3800)
    await tgApi("sendMessage", { chat_id: chat, text: text.slice(i, i + 3800), parse_mode: "HTML", disable_web_page_preview: true, ...(kb && i === 0 ? { reply_markup: kb } : {}) });
}
async function tgAnswer(id: string, text?: string) { try { await tgApi("answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}) }); } catch (_) {} }

// ─── stato / pending ───
async function getStato() {
  const { data } = await sb.from("coordinatore_stato").select("*").eq("id", 1).maybeSingle();
  return data || { id: 1, ultimo_invio: null, prossimo_ping: null };
}
async function setStato(p: any) { await sb.from("coordinatore_stato").update({ ...p, aggiornato_il: new Date().toISOString() }).eq("id", 1); }
async function getPending(chat: number) {
  const { data } = await sb.from("assistente_utenti").select("pending").eq("telegram_id", chat).maybeSingle();
  return data?.pending || null;
}
async function setSera(chat: number, sera: any) { await sb.from("assistente_utenti").update({ pending: sera ? { sera } : null }).eq("telegram_id", chat); }

// ─── cantieri attivi (per assegnazione costi) ───
async function cantieriAttivi(): Promise<{ id: string | null; nome: string }[]> {
  const { data } = await sb.from("gestionale_dati").select("dati").eq("id", "unico").maybeSingle();
  const arr: any[] = (data?.dati?.cantieri) || [];
  const att = arr.filter((c) => c && c.nome && ["in corso", "in arrivo"].includes(c.stato))
    .map((c) => ({ id: c.id || null, nome: String(c.nome) }));
  // Deposito in cima se presente
  att.sort((a, b) => (a.nome.toLowerCase() === "deposito" ? -1 : b.nome.toLowerCase() === "deposito" ? 1 : 0));
  return att.slice(0, 12);
}

// ─── BRIEF CRITICITÀ (coordinatore) ───
async function briefCriticita(): Promise<string> {
  const oggi = romeParts().date;
  const domani = addDaysISO(oggi, 1);
  const r: string[] = [];

  // agenda in arrivo (dal blob cantieri): interventi di domani + aperture nei prossimi 10 giorni
  const { data: g } = await sb.from("gestionale_dati").select("dati").eq("id", "unico").maybeSingle();
  const cant = ((g?.dati?.cantieri) || []).filter(Boolean);
  const in10 = addDaysISO(oggi, 10);
  const intDomani: string[] = [];
  const aperture: { nome: string; inizio: string }[] = [];
  for (const c of cant) {
    for (const iv of (c.interventi || [])) {
      if (iv && iv.data === domani) {
        const sq = (iv.squadra && iv.squadra.length) ? " [" + iv.squadra.join(", ") + "]" : "";
        intDomani.push(`  • ${iv.oraInizio ? iv.oraInizio + " " : ""}<b>${c.nome}</b>${iv.descrizione ? " — " + iv.descrizione : ""}${sq}`);
      }
    }
    const pi = c.periodoInizio;
    if (pi && pi > oggi && pi <= in10 && (c.stato || "") !== "concluso") aperture.push({ nome: c.nome, inizio: pi });
  }
  if (intDomani.length) { r.push("📅 <b>Interventi di DOMANI:</b>", ...intDomani, ""); }
  if (aperture.length) {
    aperture.sort((a, b) => a.inizio.localeCompare(b.inizio));
    r.push("🚀 <b>Cantieri in apertura (prossimi 10gg):</b>");
    for (const a of aperture) r.push(`  • ${a.nome} — apre il ${fdISO(a.inizio)}`);
    r.push("");
  }

  // scadenze entro 15 gg o già scadute
  const { data: sc } = await sb.from("v_archivio_scadenze")
    .select("titolo,tipo,data_scadenza,giorni_alla_scadenza,semaforo")
    .not("giorni_alla_scadenza", "is", null).lte("giorni_alla_scadenza", 15)
    .order("giorni_alla_scadenza", { ascending: true });
  if (sc && sc.length) {
    r.push("🚨 <b>Scadenze (≤15gg / scadute):</b>");
    for (const s of sc) {
      const g = s.giorni_alla_scadenza;
      const tag = g < 0 ? `scaduto da ${-g}gg` : g === 0 ? "scade OGGI" : `tra ${g}gg`;
      r.push(`  • ${s.titolo} — <b>${tag}</b>`);
    }
  }

  // buoni non rientrati oltre la data prevista
  const { data: bu } = await sb.from("buoni_consegna")
    .select("numero_buono,cliente,cantiere_nome,data_rientro_prevista")
    .is("data_riconsegna", null).not("data_rientro_prevista", "is", null).lt("data_rientro_prevista", oggi)
    .order("data_rientro_prevista", { ascending: true });
  if (bu && bu.length) {
    r.push("", "📦 <b>Buoni non rientrati (oltre la data):</b>");
    for (const b of bu) r.push(`  • ${b.numero_buono || "buono"} — ${b.cliente || b.cantiere_nome || ""} (rientro previsto ${b.data_rientro_prevista})`);
  }

  // materiale in uscita programmato
  const { count: alloc } = await sb.from("allocazioni").select("*", { count: "exact", head: true }).eq("stato", "programmata");
  if (alloc && alloc > 0) r.push("", `🔧 <b>Allocazioni materiale da confermare:</b> ${alloc}`);

  // commerciale
  const { count: prevBozza } = await sb.from("preventivi").select("*", { count: "exact", head: true }).eq("stato", "bozza");
  const { count: richOpen } = await sb.from("richieste").select("*", { count: "exact", head: true }).eq("stato", "preventivo");
  const comm: string[] = [];
  if (prevBozza && prevBozza > 0) comm.push(`${prevBozza} preventivi in bozza`);
  if (richOpen && richOpen > 0) comm.push(`${richOpen} richieste da lavorare`);
  if (comm.length) r.push("", `📝 <b>Commerciale:</b> ${comm.join(" · ")}`);

  // proposte pianificazione in attesa
  const { count: prop } = await sb.from("pianificazioni_bot").select("*", { count: "exact", head: true }).eq("stato", "proposta");
  if (prop && prop > 0) r.push("", `🤖 <b>Proposte pianificazione in attesa:</b> ${prop} (apri il Planning per applicarle)`);

  // conflitti squadra per domani
  const { data: pdom } = await sb.from("pianificazioni_bot").select("cantiere,squadra").eq("data_rif", domani);
  if (pdom && pdom.length) {
    const cnt: Record<string, string[]> = {};
    for (const p of pdom) for (const nome of (p.squadra || [])) { (cnt[nome] = cnt[nome] || []).push(p.cantiere); }
    const conf = Object.entries(cnt).filter(([, v]) => v.length > 1);
    if (conf.length) {
      r.push("", "⚠️ <b>Conflitti squadra DOMANI:</b>");
      for (const [nome, cant2] of conf) r.push(`  • ${nome} su ${cant2.length} cantieri: ${cant2.join(", ")}`);
    }
  }

  if (!r.length) return "✅ Nessuna criticità rilevata: scadenze, buoni, materiale e commerciale sono a posto.";
  return r.join("\n");
}

// ─── lavorazioni di oggi (dal planning) ───
async function lavorazioniOggi(): Promise<{ testo: string; snapshot: any[] }> {
  const oggi = romeParts().date;
  const { data: pl } = await sb.from("pianificazioni_bot").select("cantiere,ora_inizio,squadra,stato").eq("data_rif", oggi).order("ora_inizio");
  const snapshot = pl || [];
  if (!snapshot.length) return { testo: "<i>Nessuna lavorazione registrata a planning per oggi.</i>", snapshot };
  const righe = snapshot.map((p) => `  • ${p.ora_inizio || "--"} <b>${p.cantiere}</b>${(p.squadra && p.squadra.length) ? " — " + p.squadra.join(", ") : ""}`);
  return { testo: righe.join("\n"), snapshot };
}

// ─── diario di bordo: upsert del giorno ───
async function diarioDelGiorno(data: string) {
  const { data: row } = await sb.from("diario_bordo").select("*").eq("data", data).maybeSingle();
  return row;
}
async function salvaEventi(data: string, eventi: string, snapshot: any[]) {
  const row = await diarioDelGiorno(data);
  if (row) {
    const nuovo = row.eventi ? row.eventi + "\n" + eventi : eventi;
    await sb.from("diario_bordo").update({ eventi: nuovo, lavorazioni: row.lavorazioni?.length ? row.lavorazioni : snapshot, aggiornato_il: new Date().toISOString() }).eq("id", row.id);
  } else {
    await sb.from("diario_bordo").insert({ data, eventi, lavorazioni: snapshot });
  }
}
async function aggiungiCosto(data: string, costo: any) {
  const row = await diarioDelGiorno(data);
  const costi = (row?.costi || []).concat([costo]);
  if (row) await sb.from("diario_bordo").update({ costi, aggiornato_il: new Date().toISOString() }).eq("id", row.id);
  else await sb.from("diario_bordo").insert({ data, costi });
}

// ─── tastiere ───
function kbNessunEvento() { return { inline_keyboard: [[{ text: "✅ Nessun evento oggi", callback_data: "sera_noev" }]] }; }
function kbCosto() { return { inline_keyboard: [[{ text: "💶 Sì, assegna un costo", callback_data: "sera_cost_si" }], [{ text: "➡️ No, prosegui", callback_data: "sera_cost_no" }]] }; }
function kbAltroCosto() { return { inline_keyboard: [[{ text: "➕ Aggiungi un altro costo", callback_data: "sera_cost_si" }], [{ text: "➡️ No, prosegui", callback_data: "sera_cost_no" }]] }; }
function kbPronto() { return { inline_keyboard: [[{ text: "✅ Sì, organizziamo domani", callback_data: "sera_pronto_si" }], [{ text: "🕐 Non ora, ricontattami", callback_data: "sera_pronto_no" }]] }; }
async function kbCantieri() {
  const c = await cantieriAttivi();
  const righe = c.map((x) => [{ text: x.nome.length > 40 ? x.nome.slice(0, 38) + "…" : x.nome, callback_data: `serac:${x.id || ""}` }]);
  righe.push([{ text: "✏️ Altro (lo scrivo io)", callback_data: "serac:" }]);
  return { inline_keyboard: righe, _list: c } as any;
}
function kbGiorni() {
  const oggi = romeParts().date;
  const gset = ["dom", "lun", "mar", "mer", "gio", "ven", "sab"];
  const righe: any[] = [];
  for (let i = 0; i < 7; i++) {
    const d = addDaysISO(oggi, i);
    const dow = new Date(d + "T12:00:00Z").getUTCDay();
    const lbl = i === 0 ? "Oggi " + fdISO(d) : i === 1 ? "⭐ Domani " + fdISO(d) : `${gset[dow]} ${fdISO(d)}`;
    righe.push([{ text: lbl, callback_data: `plg:${d}` }]);
  }
  return { inline_keyboard: righe };
}

// ─── avvio flusso serale verso un admin ───
async function avviaSera(chat: number) {
  const data = romeParts().date;
  const crit = await briefCriticita();
  const lav = await lavorazioniOggi();
  await tgSend(chat, `🌙 <b>Rapporto serale — ${fdISO(data)}</b>\n\n${crit}`);
  await setSera(chat, { step: "eventi", data });
  await tgSend(chat,
    `📖 <b>Diario di bordo</b>\n\n<b>Lavorazioni di oggi:</b>\n${lav.testo}\n\nCi sono stati <b>eventi di rilievo</b> oggi? (guasti, imprevisti, extra, ritardi, note sul lavoro…)\nScrivimeli pure, li registro nel diario. Altrimenti:`,
    kbNessunEvento());
}

// ─── esecuzione schedulata (?sera=) ───
async function eseguiSerale(force: boolean): Promise<Response> {
  const { date, hour } = romeParts();
  const st = await getStato();
  const fireNormal = force || (hour === 18 && st.ultimo_invio !== date);
  const fireResched = !!st.prossimo_ping && new Date(st.prossimo_ping).getTime() <= Date.now();
  if (!fireNormal && !fireResched) return new Response("skip " + date + " h" + hour);

  const { data: admins } = await sb.from("assistente_utenti").select("telegram_id,ruolo");
  const dest = (admins || []).filter((u) => (u.ruolo || "admin") === "admin");
  for (const u of dest) await avviaSera(u.telegram_id);
  await setStato({ ultimo_invio: date, prossimo_ping: null });
  return new Response("inviato a " + dest.length + (fireResched ? " (ricontatto)" : ""));
}

// ─── /diario: ultimi record ───
async function mostraDiario(chat: number) {
  const { data } = await sb.from("diario_bordo").select("*").order("data", { ascending: false }).limit(7);
  if (!data || !data.length) { await tgSend(chat, "📖 Il diario di bordo è ancora vuoto."); return; }
  const out: string[] = ["📖 <b>Diario di bordo — ultimi giorni</b>"];
  for (const d of data) {
    out.push(`\n<b>${fdISO(d.data)}</b>`);
    if (d.eventi) out.push(d.eventi);
    for (const c of (d.costi || [])) out.push(`  💶 €${c.importo} — ${c.descrizione}${c.cantiere_nome ? " → " + c.cantiere_nome : ""}`);
    if (!d.eventi && !(d.costi || []).length) out.push("<i>— nessun evento —</i>");
  }
  await tgSend(chat, out.join("\n"));
}

// ─── gestione risposte testuali del flusso serale ───
async function seraText(chat: number, testo: string, sera: any): Promise<void> {
  if (/^\/annulla/i.test(testo)) { await setSera(chat, null); await tgSend(chat, "❌ Diario serale annullato."); return; }
  const data = sera.data || romeParts().date;

  if (sera.step === "eventi") {
    const lav = await lavorazioniOggi();
    await salvaEventi(data, testo, lav.snapshot);
    await setSera(chat, { step: "costo_scelta", data });
    await tgSend(chat, "✍️ Registrato nel diario.\n\nQuesto evento ha un <b>costo</b> da mettere in gestione (es. riparazione, extra)?", kbCosto());
    return;
  }
  if (sera.step === "costo_importo") {
    // solo l'importo: prendo il primo numero (gestisce 300 / 1.250,50 / €300 / "300 euro")
    const m = testo.match(/\d{1,3}(?:[.\s]\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?/);
    const v = m ? parseFloat(m[0].replace(/[.\s](?=\d{3}\b)/g, "").replace(",", ".")) : NaN;
    if (!isFinite(v) || v <= 0) { await tgSend(chat, "✏️ Importo non valido. Scrivimi <b>solo l'importo</b> in € (es. <code>300</code>) — /annulla"); return; }
    await setSera(chat, { ...sera, step: "costo_descr", importo: v });
    await tgSend(chat, `Importo: <b>€${v}</b>. Ora una breve <b>descrizione</b> della spesa (es. «foratura e cambio gomme»).`);
    return;
  }
  if (sera.step === "costo_descr") {
    const descr = testo.trim() || "spesa";
    const v = sera.importo;
    const cid = sera.cantiere_id || null;
    let cnome = sera.cantiere_nome || null;
    if (!cnome && cid) { const c = (await cantieriAttivi()).find((x) => x.id === cid); cnome = c?.nome || null; }
    // proposta spesa (stessa tabella del flusso /spesa esistente)
    const { data: sp } = await sb.from("spese_bot").insert({ cantiere_id: cid, cantiere_nome: cnome, importo: v, oggetto: descr, data, categoria: "Varie", stato: "proposta", creato_da: "Coordinatore serale" }).select("id").maybeSingle();
    await aggiungiCosto(data, { descrizione: descr, importo: v, cantiere_id: cid, cantiere_nome: cnome, spesa_id: sp?.id || null });
    await setSera(chat, { step: "costo_scelta", data });
    await tgSend(chat, `💶 Proposta spesa registrata: <b>€${v}</b> — ${descr}${cnome ? " → " + cnome : ""}\n<i>Nel gestionale, sezione «Importa spese dal bot»: confermala e finisce nelle spese del cantiere.</i>\n\nAltro costo?`, kbAltroCosto());
    return;
  }
  if (sera.step === "costo_cantiere_manuale") {
    await setSera(chat, { step: "costo_importo", data, cantiere_id: null, cantiere_nome: testo.trim() });
    await tgSend(chat, `Cantiere: <b>${testo.trim()}</b>. Quanto è costato? Scrivimi <b>solo l'importo</b> in € (es. <code>300</code>).`);
    return;
  }
  if (sera.step === "ricontatto") {
    const m = testo.match(/(\d{1,2})[:.\s]?(\d{2})?/);
    if (!m) { await tgSend(chat, "🕐 Non ho capito l'ora. Scrivi tipo <code>20:30</code>."); return; }
    const hh = Math.min(23, parseInt(m[1])); const mm = Math.min(59, parseInt(m[2] || "0"));
    const oggi = romeParts().date;
    let target = Date.parse(`${oggi}T${pad(hh)}:${pad(mm)}:00Z`) - romeOffsetMs();
    if (target <= Date.now()) target += 864e5; // se già passata, domani
    await setStato({ prossimo_ping: new Date(target).toISOString() });
    await setSera(chat, null);
    await tgSend(chat, `👍 Ok, ti ricontatto alle <b>${pad(hh)}:${pad(mm)}</b>.`);
    return;
  }
  // fallback: stato sconosciuto
  await setSera(chat, null);
  await tgSend(chat, "Ok. (Se vuoi ripartire col rapporto serale scrivi /diario o aspetta le 18.)");
}

// ─── gestione callback del flusso serale ───
async function seraCallback(cb: any): Promise<void> {
  const chat = cb.message?.chat?.id; const d = String(cb.data || "");
  await tgAnswer(cb.id);
  const pend = await getPending(chat); const sera = pend?.sera || {}; const data = sera.data || romeParts().date;

  if (d === "sera_noev") {
    const lav = await lavorazioniOggi();
    await salvaEventi(data, "— nessun evento —", lav.snapshot);
    await setSera(chat, { step: "pronto", data });
    await tgSend(chat, "🗓️ <b>Sei pronto a organizzare il lavoro di domani?</b>", kbPronto());
    return;
  }
  if (d === "sera_cost_si") {
    const kb = await kbCantieri();
    await setSera(chat, { step: "costo_cantiere", data });
    await tgSend(chat, "🏗️ A quale cantiere assegno il costo?", { inline_keyboard: kb.inline_keyboard });
    return;
  }
  if (d === "sera_cost_no") {
    await setSera(chat, { step: "pronto", data });
    await tgSend(chat, "🗓️ <b>Sei pronto a organizzare il lavoro di domani?</b>", kbPronto());
    return;
  }
  if (d.startsWith("serac:")) {
    const cid = d.slice(6);
    if (!cid) { await setSera(chat, { step: "costo_cantiere_manuale", data }); await tgSend(chat, "✏️ Scrivi il nome del cantiere/deposito."); return; }
    const c = (await cantieriAttivi()).find((x) => x.id === cid);
    await setSera(chat, { step: "costo_importo", data, cantiere_id: cid, cantiere_nome: c?.nome || null });
    await tgSend(chat, `Cantiere: <b>${c?.nome || cid}</b>. Quanto è costato? Scrivimi <b>solo l'importo</b> in € (es. <code>300</code>).`);
    return;
  }
  if (d === "sera_pronto_si") {
    await setSera(chat, null);
    await tgSend(chat, "📅 <b>Organizziamo</b> — per quale giorno pianifichiamo?", kbGiorni());
    return;
  }
  if (d === "sera_pronto_no") {
    await setSera(chat, { step: "ricontatto", data });
    await tgSend(chat, "🕐 A che ora ti ricontatto? (es. <code>20:30</code>)");
    return;
  }
}

// ─── inoltro a Jarvis (stesso secret del webhook Telegram) ───
async function forward(rawBody: string) {
  try {
    await fetch(JARVIS_URL, { method: "POST", headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET }, body: rawBody });
  } catch (_) {}
}

// ─── WEBHOOK ───
Deno.serve(async (req) => {
  const url = new URL(req.url);

  if (CRON_SECRET && url.searchParams.get("ping") === CRON_SECRET) return new Response("coordinatore-serale ok");
  if (CRON_SECRET && url.searchParams.get("sera") === CRON_SECRET) {
    try { return await eseguiSerale(url.searchParams.get("force") === "1"); }
    catch (e) { return new Response("errore serale: " + (e as Error).message, { status: 200 }); }
  }
  if (req.method !== "POST") return new Response("coordinatore-serale");
  // solo Telegram conosce il secret impostato con setWebhook
  if (!TG || !WEBHOOK_SECRET || req.headers.get("x-telegram-bot-api-secret-token") !== WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });

  const rawBody = await req.text();
  let up: any = {};
  try { up = JSON.parse(rawBody || "{}"); } catch (_) { await forward(rawBody); return new Response("ok"); }

  try {
    if (up.callback_query) {
      const d = String(up.callback_query.data || "");
      if (d.startsWith("sera_") || d.startsWith("serac:")) { await seraCallback(up.callback_query); return new Response("ok"); }
      await forward(rawBody); return new Response("ok");
    }
    const msg = up.message;
    if (msg?.chat?.id) {
      const chat = msg.chat.id; const testo = (msg.text || "").trim();
      if (testo === "/diario") { await mostraDiario(chat); return new Response("ok"); }
      const pend = await getPending(chat); let sera = pend?.sera;
      // se lo stato serale è di un giorno precedente (non risposto), lo scado: il messaggio è traffico normale
      if (sera && sera.data && sera.data !== romeParts().date) { await setSera(chat, null); sera = null; }
      if (sera && testo && !/^\/(brief|start|timbra|pianifica|pagata|incasso|spesa|richiesta)(\s|$)/i.test(testo)) {
        await seraText(chat, testo, sera); return new Response("ok");
      }
    }
  } catch (e) {
    // in caso di errore nel layer serale, non blocco il bot: inoltro comunque
    await forward(rawBody); return new Response("ok (fwd after err)");
  }

  await forward(rawBody);
  return new Response("ok");
});
