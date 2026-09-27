// ═══ 81|00 Segreteria AI — Edge Function 1: ASSISTENTE CONVERSAZIONALE ═══
// v11: apertura più umana e amichevole (niente "sono il segretario") per ridurre i riattacchi.

// v12 (27/09/2026): segreti solo dai Secrets; senza TWILIO_AUTH_TOKEN rifiuta invece di accettare.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const BASE = 'https://xqbhujcnjvwbwzpwjujf.supabase.co/functions/v1';
const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };
// Segreti SOLO da Supabase → Edge Functions → Secrets.
const AUTH_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN') || '';
const OPENAI_KEY = Deno.env.get('OPENAI_API_KEY') || '';

const MSG_APERTURA = 'Buongiorno, benvenuto in Ottantunocento! In questo momento Giuseppe è impegnato ma la richiama a breve. Mi dica pure in due parole come posso aiutarla.';
const MSG_NON_SENTITO = 'Scusi, non l\'ho sentita bene. Mi ripete pure con calma?';
const MSG_CONGEDO_FORZATO = 'La ringrazio! Riferisco subito tutto a Giuseppe e la faremo richiamare al più presto. A presto!';
const MSG_ADDIO = 'Arrivederci!';
const VOCE = 'Polly.Adriano-Neural';
const MAX_TURNI_UTENTE = 8;

function xmlEscape(s: string){
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function twiml(inner: string): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`,
    { headers: { 'Content-Type': 'text/xml; charset=utf-8' } });
}
function say(text: string){
  return `<Say language="it-IT" voice="${VOCE}">${xmlEscape(text)}</Say>`;
}
function gatherDialogo(prompt: string){
  return `<Gather input="speech" language="it-IT" speechTimeout="auto" speechModel="deepgram_nova-3" timeout="6" action="${xmlEscape(BASE + '/segreteria-voce?fase=dialogo')}" method="POST">` +
         say(prompt) + `</Gather>` +
         say(MSG_CONGEDO_FORZATO) + '<Hangup/>';
}

async function firmaValida(req: Request, params: URLSearchParams, urlPubblico: string): Promise<boolean> {
  if (!AUTH_TOKEN) return false; // senza token non si fida di nessuno (prima: accettava tutto)
  const firma = req.headers.get('X-Twilio-Signature') || '';
  if (!firma) return false;
  const chiavi = [...params.keys()].sort();
  let dati = urlPubblico;
  for (const k of chiavi) dati += k + (params.get(k) ?? '');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(AUTH_TOKEN),
    { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(dati));
  return btoa(String.fromCharCode(...new Uint8Array(mac))) === firma;
}

async function cercaNome(numero: string): Promise<string | null> {
  if (!numero || !numero.startsWith('+')) return null;
  try {
    const r = await fetch(`${SB_URL}/rest/v1/rubrica_segreteria?numero=eq.${encodeURIComponent(numero)}&select=nome&limit=1`, { headers: H });
    const j = await r.json();
    return Array.isArray(j) && j.length ? j[0].nome : null;
  } catch (_e) { return null; }
}

async function salvaTurno(callSid: string, ruolo: string, testo: string) {
  await fetch(`${SB_URL}/rest/v1/dialoghi_segreteria`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ call_sid: callSid, ruolo, testo })
  }).catch((e) => console.error('salvaTurno:', e));
}

async function storiaDialogo(callSid: string): Promise<{ ruolo: string; testo: string }[]> {
  const r = await fetch(`${SB_URL}/rest/v1/dialoghi_segreteria?call_sid=eq.${callSid}&select=ruolo,testo&order=id`, { headers: H });
  return await r.json().catch(() => []);
}

function promptSistema(nomeChiamante: string | null): string {
  return (
    'Sei l\'assistente telefonico personale di Giuseppe Giaquinto, direttore operativo di Ottantunocento, ' +
    'azienda di Caserta attiva dal 1994 nella produzione di eventi: service audio, video e luci, palchi e strutture temporanee, ' +
    'noleggio attrezzature, biglietteria e ticketing, allestimenti per concerti, cerimonie, eventi pubblici e privati in tutta la Campania e oltre. ' +
    'Stai parlando AL TELEFONO: frasi brevi (massimo 25 parole), UNA sola domanda alla volta, tono educato, paziente e cordiale. Dai del lei, salvo il chiamante usi il tu. ' +
    (nomeChiamante ? `Il chiamante è in rubrica come «${nomeChiamante}»: salutalo per nome. ` : 'Il numero del chiamante non è in rubrica. ') +
    'IMPORTANTE: non dare per scontato che chi chiama sia un nuovo cliente. Prima ascolta e capisci il MOTIVO della chiamata, che può essere di vario tipo: ' +
    '(a) richiesta di un nuovo lavoro o preventivo; ' +
    '(b) assistenza, problemi o aggiornamenti su un lavoro, evento o noleggio GIÀ in corso con Ottantunocento; ' +
    '(c) fornitori o collaboratori per questioni operative; ' +
    '(d) richieste di informazioni di altro genere; ' +
    '(e) questioni personali per Giuseppe. ' +
    'Poi comportati di conseguenza: ' +
    'per un NUOVO lavoro chiedi con calma tipo di evento, data, luogo, cosa serve (audio, luci, video, palco, strutture) e persone attese, e chiudi dicendo che il personale preparerà un preventivo; ' +
    'per ASSISTENZA su un lavoro attivo chiedi a quale evento o cliente si riferisce, qual è il problema o la richiesta e quanto è urgente, e assicura che riferirai subito a Giuseppe e allo staff; ' +
    'per FORNITORI prendi nota del motivo e dei riferimenti; ' +
    'per INFORMAZIONI generiche prendi nota della domanda — se non conosci la risposta NON inventarla, di\' che farai avere una risposta al più presto; ' +
    'per questioni PERSONALI prendi nota con discrezione, senza fare domande invadenti. ' +
    'In ogni caso: fatti lasciare il nome e un recapito se diverso dal numero da cui chiama, e chiudi assicurando che Giuseppe o lo staff richiameranno al più presto. ' +
    'REGOLE FERREE: mai prezzi, mai promesse di date o disponibilità, mai impegni economici — su questi temi rispondi che deve parlarne con Giuseppe. ' +
    'Se è una chiamata promozionale o un call center, congedati con cortesia e chiudi. Se il chiamante è offensivo, resta educato e chiudi. ' +
    'Non inventare informazioni su Ottantunocento che non conosci. ' +
    'Rispondi SOLO con JSON: {"risposta":"cosa dici al telefono","chiusura":true|false} — chiusura=true solo quando hai appena pronunciato il saluto finale.'
  );
}

async function rispostaAssistente(callSid: string, nomeChiamante: string | null): Promise<{ risposta: string; chiusura: boolean }> {
  const fallback = { risposta: 'Scusi, ho avuto un problema di linea. Mi ripete pure?', chiusura: false };
  if (!OPENAI_KEY) return { risposta: MSG_CONGEDO_FORZATO, chiusura: true };
  const storia = await storiaDialogo(callSid);
  const messaggi = [
    { role: 'system', content: promptSistema(nomeChiamante) },
    ...storia.map((t) => ({ role: t.ruolo === 'utente' ? 'user' : 'assistant', content: t.testo }))
  ];
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini', response_format: { type: 'json_object' }, messages: messaggi, max_tokens: 200 })
    });
    if (!r.ok) { console.error('gpt:', r.status, await r.text()); return fallback; }
    const j = await r.json();
    const out = JSON.parse(j.choices[0].message.content);
    return { risposta: String(out.risposta || '').slice(0, 400) || fallback.risposta, chiusura: !!out.chiusura };
  } catch (e) { console.error('gpt:', e); return fallback; }
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (req.method !== 'POST') {
    return new Response('Segreteria 81|00 attiva (assistente conversazionale). Webhook Voice: HTTP POST.');
  }

  const form = await req.formData().catch(() => null);
  if (!form) return twiml(say(MSG_ADDIO) + '<Hangup/>');
  const params = new URLSearchParams();
  for (const [k, v] of form.entries()) if (typeof v === 'string') params.set(k, v);

  const urlPubblico = `${BASE}/segreteria-voce${url.search}`;
  if (!(await firmaValida(req, params, urlPubblico))) {
    return new Response('firma non valida', { status: 403 });
  }

  const fase = url.searchParams.get('fase') || '';
  const callSid = params.get('CallSid') || '';
  const chiamante = params.get('From') || '';

  // ─── Dialogo a turni con l'assistente ───
  if (fase === 'dialogo') {
    const detto = (params.get('SpeechResult') || '').trim();
    if (!detto) return twiml(gatherDialogo(MSG_NON_SENTITO));

    await salvaTurno(callSid, 'utente', detto);
    const nome = await cercaNome(chiamante);
    const storia = await storiaDialogo(callSid);
    const turniUtente = storia.filter((t) => t.ruolo === 'utente').length;

    if (turniUtente >= MAX_TURNI_UTENTE) {
      await salvaTurno(callSid, 'assistente', MSG_CONGEDO_FORZATO);
      return twiml(say(MSG_CONGEDO_FORZATO) + '<Hangup/>');
    }

    const { risposta, chiusura } = await rispostaAssistente(callSid, nome);
    await salvaTurno(callSid, 'assistente', risposta);
    if (chiusura) return twiml(say(risposta) + '<Hangup/>');
    return twiml(gatherDialogo(risposta));
  }

  // ─── Chiamata in arrivo → saluto amichevole e subito dialogo ───
  await salvaTurno(callSid, 'assistente', MSG_APERTURA);
  return twiml(gatherDialogo(MSG_APERTURA));
});
