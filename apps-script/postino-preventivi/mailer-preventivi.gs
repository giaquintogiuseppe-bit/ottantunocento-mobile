/**
 * Postino preventivi 81|00 — Web App Apps Script sul Gmail di Giuseppe.
 *
 * Riceve dalla Edge Function mcp-81100 (tool invia_preventivo_email) un POST JSON:
 *   { secret, azione: "anteprima"|"bozza"|"invia", threadId, body, to?, cc?, subject?, pdfUrl?, filename?, from? }
 * - verifica il secret (Script Property MAIL_SECRET);
 * - "anteprima": calcola solo destinatari e oggetto reali (niente PDF, niente bozza);
 * - "bozza"/"invia": scarica il PDF dal link firmato Supabase, crea la risposta nel thread con il PDF
 *   allegato e, se "invia", la spedisce.
 * Risponde { ok, mode: "preview"|"draft"|"sent", draftId, messageId, threadId, to, cc, subject } oppure { ok:false, error }.
 *
 * INSTALLAZIONE (una volta):
 *  1. script.google.com → Nuovo progetto "Postino preventivi 81|00" → incolla questo file.
 *  2. Servizi (+) → "Gmail API" → Aggiungi (identificatore: Gmail).
 *  3. Esegui impostaSegreto() → copia il valore dal registro di esecuzione → Supabase, secret PREVENTIVO_MAIL_SECRET.
 *  4. Esegui provaAutorizzazioni() → concedi i permessi Google (Gmail + connessioni esterne).
 *  5. Esegui il deployment → Nuovo deployment → Applicazione web: "Esegui come: Me", "Chi ha accesso: Chiunque"
 *     → copia l'URL che finisce con /exec → Supabase, secret APPS_SCRIPT_MAILER_URL.
 *  Ogni modifica al codice richiede: Gestisci deployment → modifica → Versione: nuova versione (l'URL resta lo stesso).
 */

// Unica sorgente ammessa per i PDF: link firmati del bucket preventivi-pdf del progetto Supabase 81|00
var PDF_PREFIX = 'https://xqbhujcnjvwbwzpwjujf.supabase.co/storage/v1/object/sign/preventivi-pdf/';
var MAX_DESTINATARI = 20;

function doPost(e) {
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var atteso = PropertiesService.getScriptProperties().getProperty('MAIL_SECRET');
    if (!atteso || !ugualiCostante_(String(req.secret || ''), atteso)) {
      return risposta_({ ok: false, error: 'forbidden (403): secret mancante o errato' });
    }
    return risposta_(gestisci_(req));
  } catch (err) {
    // Mai includere req/secret nei messaggi o nei log
    return risposta_({ ok: false, error: String((err && err.message) || err) });
  }
}

function doGet() {
  return risposta_({ ok: true, servizio: 'postino-preventivi-81100' });
}

function gestisci_(req) {
  var azione = String(req.azione || (req.invia === true ? 'invia' : 'bozza'));
  if (['anteprima', 'bozza', 'invia'].indexOf(azione) < 0) throw new Error('azione non valida: ' + azione);
  var threadId = String(req.threadId || '').trim();
  if (!threadId) throw new Error('threadId mancante');
  var body = String(req.body == null ? '' : req.body);
  if (!body.trim()) throw new Error('testo della mail vuoto');

  var thread;
  try { thread = GmailApp.getThreadById(threadId); } catch (err) { thread = null; }
  if (!thread) throw new Error('thread Gmail non trovato: ' + threadId);

  var miei = indirizziMiei_();
  var msgs = thread.getMessages();
  var rif = ultimoMessaggioRicevuto_(msgs, miei);
  var dest = destinatariDefault_(rif.msg, rif.mio, miei);

  var to = req.to != null ? validaLista_(req.to, 'to') : dest.to;
  var cc = req.cc != null ? validaLista_(req.cc, 'cc') : (req.to != null ? [] : dest.cc);
  cc = senza_(cc, to);
  if (!to.length) throw new Error('nessun destinatario: indica "to" esplicitamente');
  if (to.length + cc.length > MAX_DESTINATARI) throw new Error('troppi destinatari (max ' + MAX_DESTINATARI + ')');

  var subject = req.subject ? String(req.subject).trim() : oggettoRisposta_(rif.msg.getSubject());
  var from = null;
  if (req.from) {
    from = String(req.from).trim();
    if (miei.indexOf(estraiEmail_(from)[0] || '') < 0) throw new Error('mittente non autorizzato (non è un alias "invia come"): ' + from);
  }

  if (azione === 'anteprima') {
    return { ok: true, mode: 'preview', threadId: thread.getId(), to: to, cc: cc, subject: subject };
  }

  // PDF: solo dal bucket preventivi-pdf, scaricato ora (il link non viene mai salvato)
  var pdfUrl = String(req.pdfUrl || '');
  if (pdfUrl.indexOf(PDF_PREFIX) !== 0) throw new Error('pdfUrl non ammesso');
  var res = UrlFetchApp.fetch(pdfUrl, { muteHttpExceptions: true, followRedirects: true });
  if (res.getResponseCode() !== 200) throw new Error('download PDF fallito (HTTP ' + res.getResponseCode() + ')');
  var bytes = res.getContent();
  if (bytes.length < 5 || String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== '%PDF') throw new Error('il file scaricato non è un PDF');
  var filename = nomeFile_(req.filename);

  var msgId = rif.msg.getHeader('Message-ID') || rif.msg.getHeader('Message-Id') || '';
  var refs = ((rif.msg.getHeader('References') || '') + ' ' + msgId).replace(/\s+/g, ' ').trim();
  var mime = componiMime_({
    from: from, to: to, cc: cc, subject: subject, inReplyTo: msgId, references: refs,
    body: body, filename: filename, pdfBase64: Utilities.base64Encode(bytes),
    boundary: 'b81100_' + Utilities.getUuid().replace(/-/g, ''),
    b64utf8: function (s) { return Utilities.base64Encode(s, Utilities.Charset.UTF_8); },
  });

  var draft = Gmail.Users.Drafts.create({ message: { raw: Utilities.base64EncodeWebSafe(mime), threadId: thread.getId() } }, 'me');
  var out = { ok: true, mode: 'draft', draftId: draft.id, messageId: draft.message && draft.message.id,
    threadId: (draft.message && draft.message.threadId) || thread.getId(), to: to, cc: cc, subject: subject };
  if (azione === 'invia') {
    var sent = Gmail.Users.Drafts.send({ id: draft.id }, 'me');
    out.mode = 'sent';
    out.messageId = sent.id;
    out.threadId = sent.threadId || out.threadId;
  }
  return out;
}

// ---------- destinatari ----------
function indirizziMiei_() {
  var l = [Session.getEffectiveUser().getEmail()];
  try { l = l.concat(GmailApp.getAliases()); } catch (err) { /* nessun alias */ }
  return l.map(function (s) { return String(s).toLowerCase(); });
}

// Ultimo messaggio non scritto da me (escluse le bozze); se il thread è tutto mio, l'ultimo messaggio
function ultimoMessaggioRicevuto_(msgs, miei) {
  for (var i = msgs.length - 1; i >= 0; i--) {
    var m = msgs[i];
    if (m.isDraft && m.isDraft()) continue;
    var f = estraiEmail_(m.getFrom())[0];
    if (f && miei.indexOf(f) < 0) return { msg: m, mio: false };
  }
  for (var j = msgs.length - 1; j >= 0; j--) {
    if (!(msgs[j].isDraft && msgs[j].isDraft())) return { msg: msgs[j], mio: true };
  }
  throw new Error('thread senza messaggi');
}

// "Rispondi a tutti": mittente (o Reply-To) + gli altri in A/Cc, esclusi i miei indirizzi
function destinatariDefault_(msg, mio, miei) {
  var to, cc;
  if (!mio) {
    to = estraiEmail_(msg.getReplyTo() || msg.getFrom());
    cc = estraiEmail_(msg.getTo() + ',' + msg.getCc());
  } else {
    to = estraiEmail_(msg.getTo());
    cc = estraiEmail_(msg.getCc());
  }
  to = unici_(to.filter(function (x) { return miei.indexOf(x) < 0; }));
  cc = senza_(unici_(cc.filter(function (x) { return miei.indexOf(x) < 0; })), to);
  return { to: to, cc: cc };
}

// ---------- utilità pure (testabili fuori da Apps Script) ----------
function estraiEmail_(s) {
  var out = [];
  var re = /<([^<>\s]+@[^<>\s]+)>|([^\s<>,;"']+@[^\s<>,;"']+)/g;
  var m;
  s = String(s || '');
  while ((m = re.exec(s)) !== null) out.push((m[1] || m[2]).toLowerCase());
  return out;
}
function unici_(l) {
  var v = {};
  return l.filter(function (x) { if (v[x]) return false; v[x] = true; return true; });
}
function senza_(l, togli) {
  return l.filter(function (x) { return togli.indexOf(x) < 0; });
}
function validaLista_(x, campo) {
  var l = (Array.isArray(x) ? x : String(x).split(/[,;]/)).map(function (s) { return String(s || '').trim(); }).filter(String);
  var ok = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
  var errati = l.filter(function (s) { return !ok.test(s); });
  if (errati.length) throw new Error('indirizzi non validi in ' + campo + ': ' + errati.join(', '));
  return unici_(l.map(function (s) { return s.toLowerCase(); }));
}
function oggettoRisposta_(s) {
  s = String(s || '').trim();
  return /^(re|r)\s*:/i.test(s) ? s : 'Re: ' + s;
}
function nomeFile_(f) {
  f = String(f || 'Preventivo.pdf').replace(/[\r\n"\\\/]+/g, ' ').trim();
  return /\.pdf$/i.test(f) ? f : f + '.pdf';
}
function ugualiCostante_(a, b) {
  if (a.length !== b.length) return false;
  var d = 0;
  for (var i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
// Header non ASCII → encoded-word RFC 2047
function intestazione_(s, b64utf8) {
  s = String(s || '').replace(/[\r\n]+/g, ' ');
  return /^[\x20-\x7e]*$/.test(s) ? s : '=?UTF-8?B?' + b64utf8(s) + '?=';
}
function a76_(s) {
  return String(s).replace(/(.{76})/g, '$1\r\n');
}
function componiMime_(o) {
  var fn = intestazione_(o.filename, o.b64utf8);
  var h = [];
  if (o.from) h.push('From: ' + o.from);
  h.push('To: ' + o.to.join(', '));
  if (o.cc && o.cc.length) h.push('Cc: ' + o.cc.join(', '));
  h.push('Subject: ' + intestazione_(o.subject, o.b64utf8));
  if (o.inReplyTo) h.push('In-Reply-To: ' + o.inReplyTo);
  if (o.references) h.push('References: ' + o.references);
  h.push('MIME-Version: 1.0');
  h.push('Content-Type: multipart/mixed; boundary="' + o.boundary + '"');
  return h.concat([
    '',
    '--' + o.boundary,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    a76_(o.b64utf8(o.body)),
    '--' + o.boundary,
    'Content-Type: application/pdf; name="' + fn + '"',
    'Content-Disposition: attachment; filename="' + fn + '"',
    'Content-Transfer-Encoding: base64',
    '',
    a76_(o.pdfBase64),
    '--' + o.boundary + '--',
    '',
  ]).join('\r\n');
}

function risposta_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

// ---------- funzioni da eseguire a mano dall'editor ----------
// Crea il secret condiviso e lo mostra UNA volta nel registro: copialo in Supabase (PREVENTIVO_MAIL_SECRET).
function impostaSegreto() {
  var s = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty('MAIL_SECRET', s);
  Logger.log('MAIL_SECRET impostato. Copia questo valore nel secret Supabase PREVENTIVO_MAIL_SECRET:\n' + s);
}
// Fa comparire la richiesta dei permessi Google (Gmail, Gmail API, connessioni esterne).
function provaAutorizzazioni() {
  Logger.log('Account: ' + Session.getEffectiveUser().getEmail());
  Logger.log('Thread in Posta in arrivo: ' + GmailApp.getInboxThreads(0, 1).length);
  Logger.log('Bozze (Gmail API): ' + ((Gmail.Users.Drafts.list('me', { maxResults: 1 }).drafts) || []).length);
  Logger.log('Fetch esterno: HTTP ' + UrlFetchApp.fetch('https://xqbhujcnjvwbwzpwjujf.supabase.co/storage/v1/version', { muteHttpExceptions: true }).getResponseCode());
  Logger.log('Secret presente: ' + !!PropertiesService.getScriptProperties().getProperty('MAIL_SECRET'));
}
