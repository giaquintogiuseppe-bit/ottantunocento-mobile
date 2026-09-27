// ═══ 81|00 Segreteria AI — Edge Function 2: rendiconto e notifica ═══
// v7: rubrica auto-apprendente — se il chiamante sconosciuto si presenta, il nome viene salvato in rubrica.
// v8: aggancio commerciale — le chiamate di clienti che chiedono un preventivo/servizio creano una richiesta (Preventivi → Richieste).

// v9 (27/09/2026): verifica della firma Twilio; segreti solo dai Secrets.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };

// Segreti SOLO da Supabase → Edge Functions → Secrets (mai scritti nel codice).
const TWILIO_SID = Deno.env.get('TWILIO_ACCOUNT_SID') || '';
const TWILIO_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN') || '';
const OPENAI_KEY = Deno.env.get('OPENAI_API_KEY') || '';
// bot Telegram delle notifiche (lo stesso del bot scontrini)
const TG_TOKEN = Deno.env.get('TELEGRAM_BOT_SCONTRINI_TOKEN') || '';
const TG_CHAT = Deno.env.get('SEGRETERIA_CHAT_ID') || '8864587607';
const BASE = 'https://xqbhujcnjvwbwzpwjujf.supabase.co/functions/v1';

// Firma Twilio (stesso algoritmo di segreteria-voce): HMAC-SHA1 di URL pubblico + parametri ordinati.
// Senza token o senza firma valida la richiesta è rifiutata: solo Twilio può attivare l'elaborazione.
async function firmaValida(req: Request, params: URLSearchParams, urlPubblico: string): Promise<boolean> {
  if (!TWILIO_TOKEN) return false;
  const firma = req.headers.get('X-Twilio-Signature') || '';
  if (!firma) return false;
  const chiavi = [...params.keys()].sort();
  let dati = urlPubblico;
  for (const k of chiavi) dati += k + (params.get(k) ?? '');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(TWILIO_TOKEN),
    { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(dati));
  return btoa(String.fromCharCode(...new Uint8Array(mac))) === firma;
}

async function telegram(testo: string) {
  if (!TG_CHAT || !TG_TOKEN) return;
  for (let i = 0; i < testo.length; i += 3900) {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text: testo.slice(i, i + 3900) })
    }).catch((e) => console.error('telegram:', e));
  }
}

async function cercaNome(numero: string): Promise<string | null> {
  if (!numero || !numero.startsWith('+')) return null;
  try {
    const r = await fetch(`${SB_URL}/rest/v1/rubrica_segreteria?numero=eq.${encodeURIComponent(numero)}&select=nome&limit=1`, { headers: H });
    const j = await r.json();
    return Array.isArray(j) && j.length ? j[0].nome : null;
  } catch (_e) { return null; }
}

async function aggiungiInRubrica(numero: string, nome: string): Promise<boolean> {
  if (!numero.startsWith('+') || !nome) return false;
  const r = await fetch(`${SB_URL}/rest/v1/rubrica_segreteria?on_conflict=numero`, {
    method: 'POST', headers: { ...H, Prefer: 'resolution=ignore-duplicates' },
    body: JSON.stringify({ numero, nome: nome.slice(0, 80), origine: 'segreteria' })
  }).catch(() => null);
  return !!(r && r.ok);
}

// Aggancio commerciale: crea una richiesta dalla chiamata (anti-doppione sul call_sid nelle note).
async function creaRichiestaDaChiamata(callSid: string, numero: string, nome: string | null, s: Sintesi): Promise<string> {
  try {
    const chk = await fetch(`${SB_URL}/rest/v1/richieste?select=numero&note=ilike.*${encodeURIComponent(callSid)}*&limit=1`, { headers: H });
    const ex = await chk.json().catch(() => []);
    if (Array.isArray(ex) && ex.length) return ex[0].numero || '';
  } catch (_e) { /* prosegue e prova a inserire */ }
  const dataEvento = (s.dataEvento && /^\d{4}-\d{2}-\d{2}$/.test(s.dataEvento)) ? s.dataEvento : null;
  const budget = (typeof s.budget === 'number' && isFinite(s.budget) && s.budget > 0) ? s.budget : null;
  const body = {
    canale: 'segreteria',
    stato: 'nuova',
    tipo: 'preventivo',
    priorita: s.urgenza === 'alta' ? 'alta' : 'media',
    richiedente_nome: nome || null,
    contatto_telefono: (numero && numero.startsWith('+')) ? numero : null,
    oggetto: String(s.oggetto || s.sintesi || 'Richiesta da telefonata').slice(0, 140),
    descrizione: s.sintesi || null,
    luogo: s.luogo || null,
    data_evento_prevista: dataEvento,
    budget_indicativo: budget,
    creato_da: 'segreteria',
    note: `Da segreteria vocale · call ${callSid}`
  };
  try {
    const r = await fetch(`${SB_URL}/rest/v1/richieste`, {
      method: 'POST', headers: { ...H, Prefer: 'return=representation' },
      body: JSON.stringify(body)
    });
    const j = await r.json().catch(() => []);
    return Array.isArray(j) && j.length ? (j[0].numero || '') : '';
  } catch (_e) { return ''; }
}

function intestazioneChiamante(numero: string, nome: string | null): string {
  return nome ? `👤 ${nome} (${numero})` : `👤 ${numero} · non in rubrica`;
}

async function scaricaAudio(recUrl: string): Promise<Blob | null> {
  const auth = 'Basic ' + btoa(`${TWILIO_SID}:${TWILIO_TOKEN}`);
  for (const suffisso of ['.mp3', '']) {
    try {
      const r = await fetch(recUrl + suffisso, { headers: { Authorization: auth } });
      if (r.ok) return await r.blob();
    } catch (_e) { /* tenta il formato successivo */ }
  }
  return null;
}

async function trascrivi(audio: Blob): Promise<string> {
  if (!OPENAI_KEY) return '';
  const fd = new FormData();
  fd.append('file', audio, 'messaggio.mp3');
  fd.append('model', 'whisper-1');
  fd.append('language', 'it');
  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST', headers: { Authorization: `Bearer ${OPENAI_KEY}` }, body: fd
  });
  if (!r.ok) { console.error('whisper:', r.status, await r.text()); return ''; }
  const j = await r.json();
  return (j.text || '').trim();
}

interface Sintesi {
  sintesi: string;
  urgenza: string;
  categoria: string;
  nomeDichiarato: string | null;
  eRichiesta: boolean;
  oggetto: string | null;
  luogo: string | null;
  dataEvento: string | null;
  budget: number | null;
}

async function sintetizza(testo: string): Promise<Sintesi> {
  const vuoto: Sintesi = { sintesi: '', urgenza: 'media', categoria: 'altro', nomeDichiarato: null, eRichiesta: false, oggetto: null, luogo: null, dataEvento: null, budget: null };
  if (!OPENAI_KEY || !testo) return vuoto;
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content:
          'Sei la segreteria di Ottantunocento S.r.l. (produzione eventi, service audio-video-luci, noleggio attrezzature, Caserta). ' +
          'Ricevi la trascrizione di una chiamata (messaggio vocale o conversazione con l\'assistente). Rispondi SOLO con JSON: ' +
          '{"sintesi": "2-3 frasi in italiano: chi chiama, cosa vuole, dati raccolti (evento, data, luogo, esigenze, recapiti)", ' +
          '"urgenza": "bassa|media|alta", ' +
          '"categoria": "cliente|fornitore|spam|altro", ' +
          '"nome_dichiarato": "nome e cognome (ed eventuale azienda) con cui IL CHIAMANTE si è presentato, con iniziali maiuscole, oppure null se non si è presentato", ' +
          '"e_richiesta": true SOLO se il chiamante sta chiedendo un preventivo, un servizio o sta organizzando un evento/noleggio (potenziale nuova commessa); false per solleciti, richieste di informazioni generiche, fornitori, spam o chiamate senza una richiesta commerciale, ' +
          '"oggetto": "titolo breve della richiesta, es. «Service audio-luci matrimonio» (null se e_richiesta è false)", ' +
          '"luogo": "località o venue dell\'evento, oppure null", ' +
          '"data_evento": "data dell\'evento in formato YYYY-MM-DD, oppure null se non indicata", ' +
          '"budget": budget indicativo in euro come numero, oppure null}' },
        { role: 'user', content: testo }
      ]
    })
  });
  if (!r.ok) { console.error('sintesi:', r.status, await r.text()); return vuoto; }
  try {
    const j = await r.json();
    const out = JSON.parse(j.choices[0].message.content);
    const nd = typeof out.nome_dichiarato === 'string' && out.nome_dichiarato.trim() && out.nome_dichiarato.toLowerCase() !== 'null'
      ? out.nome_dichiarato.trim() : null;
    const bud = typeof out.budget === 'number' ? out.budget : (typeof out.budget === 'string' ? parseFloat(out.budget.replace(/[^\d.,]/g, '').replace(',', '.')) : NaN);
    return {
      sintesi: String(out.sintesi || ''),
      urgenza: ['bassa','media','alta'].includes(out.urgenza) ? out.urgenza : 'media',
      categoria: ['cliente','fornitore','spam','altro'].includes(out.categoria) ? out.categoria : 'altro',
      nomeDichiarato: nd,
      eRichiesta: out.e_richiesta === true,
      oggetto: typeof out.oggetto === 'string' && out.oggetto.trim() && out.oggetto.toLowerCase() !== 'null' ? out.oggetto.trim() : null,
      luogo: typeof out.luogo === 'string' && out.luogo.trim() && out.luogo.toLowerCase() !== 'null' ? out.luogo.trim() : null,
      dataEvento: typeof out.data_evento === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(out.data_evento) ? out.data_evento : null,
      budget: isFinite(bud) ? bud : null
    };
  } catch (_e) { return vuoto; }
}

function dataOraIT(){
  return new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Segreteria 81|00 — elaborazione attiva.');

  const url = new URL(req.url);
  const form = await req.formData().catch(() => null);
  if (!form) return new Response('ok');
  const params = new URLSearchParams();
  for (const [k, v] of form.entries()) if (typeof v === 'string') params.set(k, v);
  if (!(await firmaValida(req, params, `${BASE}/segreteria-elabora${url.search}`))) {
    console.error('segreteria-elabora: firma Twilio non valida o TWILIO_AUTH_TOKEN mancante');
    return new Response('firma non valida', { status: 403 });
  }
  const p = (k: string) => params.get(k) || '';

  // ─── Evento: chiamata terminata ───
  if (url.searchParams.get('evento') === 'chiusura') {
    if (p('CallStatus') !== 'completed') return new Response('ok');
    const callSid = p('CallSid');
    const chiamante = p('From') || 'sconosciuto';
    const durata = parseInt(p('CallDuration') || '0');
    if (!callSid) return new Response('ok');

    await new Promise((r) => setTimeout(r, 12000));

    const q = await fetch(`${SB_URL}/rest/v1/chiamate_segreteria?call_sid=eq.${callSid}&select=id`, { headers: H });
    const esiste = await q.json().catch(() => []);
    if (Array.isArray(esiste) && esiste.length) return new Response('ok');

    const nome = await cercaNome(chiamante);

    const d = await fetch(`${SB_URL}/rest/v1/dialoghi_segreteria?call_sid=eq.${callSid}&select=ruolo,testo&order=id`, { headers: H });
    const turni = await d.json().catch(() => []);
    const turniUtente = Array.isArray(turni) ? turni.filter((t: {ruolo:string}) => t.ruolo === 'utente') : [];

    if (turniUtente.length) {
      const trascrizione = turni.map((t: {ruolo:string;testo:string}) =>
        (t.ruolo === 'utente' ? 'Chiamante: ' : 'Assistente: ') + t.testo).join('\n');
      const s = await sintetizza(trascrizione);
      const { sintesi, urgenza, categoria, nomeDichiarato } = s;

      // Rubrica auto-apprendente: sconosciuto che si è presentato → memorizza
      let notaRubrica = '';
      let nomeFinale = nome;
      if (!nome && nomeDichiarato && categoria !== 'spam') {
        const ok = await aggiungiInRubrica(chiamante, nomeDichiarato);
        if (ok) { notaRubrica = `\n📇 Salvato in rubrica come «${nomeDichiarato}»`; nomeFinale = nomeDichiarato; }
      }

      // Aggancio commerciale: cliente che chiede un preventivo/servizio → richiesta
      let notaRichiesta = '';
      if (categoria === 'cliente' && s.eRichiesta) {
        const num = await creaRichiestaDaChiamata(callSid, chiamante, nomeFinale, s);
        if (num) notaRichiesta = `\n📥 Richiesta ${num} creata → completala in Preventivi → Richieste`;
      }

      await fetch(`${SB_URL}/rest/v1/chiamate_segreteria?on_conflict=call_sid`, {
        method: 'POST', headers: { ...H, Prefer: 'resolution=ignore-duplicates' },
        body: JSON.stringify({
          call_sid: callSid, numero_chiamante: chiamante, nome_chiamante: nomeFinale, numero_chiamato: p('To') || '',
          durata_sec: durata, trascrizione, sintesi: sintesi || null, urgenza, categoria
        })
      });

      const badge = urgenza === 'alta' ? '🔴' : urgenza === 'bassa' ? '⚪️' : '🟡';
      await telegram(
        `🗣️ L'assistente ha gestito una chiamata\n` +
        `${intestazioneChiamante(chiamante, nome)}\n` +
        `🕒 ${dataOraIT()} · ${durata}s · ${badge} ${urgenza} · ${categoria}` +
        notaRubrica + notaRichiesta + `\n\n` +
        (sintesi ? `💡 ${sintesi}\n\n` : '') +
        `💬 Conversazione:\n${trascrizione}`
      );
      return new Response('ok');
    }

    await fetch(`${SB_URL}/rest/v1/chiamate_segreteria?on_conflict=call_sid`, {
      method: 'POST', headers: { ...H, Prefer: 'resolution=ignore-duplicates' },
      body: JSON.stringify({
        call_sid: callSid, numero_chiamante: chiamante, nome_chiamante: nome, numero_chiamato: p('To') || '',
        durata_sec: durata, sintesi: 'Nessun messaggio lasciato', categoria: 'altro', urgenza: 'bassa'
      })
    });
    await telegram(`📵 Chiamata senza conversazione\n${intestazioneChiamante(chiamante, nome)}\n🕒 ${dataOraIT()} · ${durata}s in linea\n\nNon ha detto nulla o ha riagganciato subito.`);
    return new Response('ok');
  }

  // ─── Evento: registrazione completata (ramo di riserva) ───
  if (p('RecordingStatus') && p('RecordingStatus') !== 'completed') return new Response('ok');

  const recUrl = p('RecordingUrl');
  const callSid = p('CallSid');
  if (!recUrl || !callSid) return new Response('ok');

  const chiamante = decodeURIComponent(url.searchParams.get('from') || '') || p('From') || 'sconosciuto';
  const chiamato = decodeURIComponent(url.searchParams.get('to') || '') || p('To') || '';
  const durata = parseInt(p('RecordingDuration') || '0');

  const ins = await fetch(`${SB_URL}/rest/v1/chiamate_segreteria?on_conflict=call_sid`, {
    method: 'POST',
    headers: { ...H, Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({
      call_sid: callSid, recording_sid: p('RecordingSid'),
      numero_chiamante: chiamante, numero_chiamato: chiamato,
      durata_sec: durata, audio_url: recUrl + '.mp3'
    })
  });
  const righe = await ins.json().catch(() => []);
  if (!Array.isArray(righe) || !righe.length) return new Response('ok');
  const riga = righe[0];
  if (riga.trascrizione) return new Response('ok');
  const rigaId = riga.id;

  const nome = await cercaNome(chiamante);
  const audio = await scaricaAudio(recUrl);
  const trascrizione = audio ? await trascrivi(audio) : '';
  const s = await sintetizza(trascrizione);
  const { sintesi, urgenza, categoria, nomeDichiarato } = s;

  let notaRubrica = '';
  let nomeFinale = nome;
  if (!nome && nomeDichiarato && categoria !== 'spam') {
    const ok = await aggiungiInRubrica(chiamante, nomeDichiarato);
    if (ok) { notaRubrica = `\n📇 Salvato in rubrica come «${nomeDichiarato}»`; nomeFinale = nomeDichiarato; }
  }

  // Aggancio commerciale: cliente che chiede un preventivo/servizio → richiesta
  let notaRichiesta = '';
  if (categoria === 'cliente' && s.eRichiesta) {
    const num = await creaRichiestaDaChiamata(callSid, chiamante, nomeFinale, s);
    if (num) notaRichiesta = `\n📥 Richiesta ${num} creata → completala in Preventivi → Richieste`;
  }

  await fetch(`${SB_URL}/rest/v1/chiamate_segreteria?id=eq.${rigaId}`, {
    method: 'PATCH', headers: H,
    body: JSON.stringify({ trascrizione: trascrizione || null, sintesi: sintesi || null, urgenza, categoria, nome_chiamante: nomeFinale })
  });

  const badge = urgenza === 'alta' ? '🔴' : urgenza === 'bassa' ? '⚪️' : '🟡';
  await telegram(
    `📞 Nuovo messaggio in segreteria\n` +
    `${intestazioneChiamante(chiamante, nome)}\n` +
    `🕒 ${dataOraIT()} · ${durata}s · ${badge} ${urgenza} · ${categoria}` +
    notaRubrica + notaRichiesta + `\n\n` +
    (sintesi ? `💡 ${sintesi}\n\n` : '') +
    (trascrizione ? `📝 «${trascrizione}»` : '📝 (trascrizione non disponibile)')
  );

  return new Response('ok');
});
