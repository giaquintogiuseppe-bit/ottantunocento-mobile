/**
 * Antifrode carte DKV 81|00 — Apps Script sul Gmail di Giuseppe (NON è una web app).
 *
 * Contesto: carte carburante DKV (cliente 4301665111). Su DKV Cockpit la notifica "Autorizzazioni LIVE"
 * manda un'email immediata a ogni rifornimento. Questo script:
 *   1. INGEST  (processaGiornata, trigger ogni 30 min): legge i thread con label LABEL_IN, li trasforma in
 *      righe (parseEmailDKV), valuta i sospetti, fa upsert su Supabase (tabella dkv_autorizzazioni, idempotente
 *      su gmail_message_id), poi etichetta LABEL_DONE e ARCHIVIA il thread. Non cancella e non cestina mai.
 *   2. REPORT  (reportSerale, trigger giornaliero ~21:00 Europe/Rome): SOLA LETTURA su Supabase; invia a REPORT_TO
 *      un'email HTML con le transazioni del giorno e, in cima in rosso, quelle sospette.
 *
 * SCELTA DEI TRIGGER: ingest e report sono separati di proposito. Ingest frequente (30 min) = i dati restano
 * freschi e la inbox pulita; il report è uno solo, la sera, e non scrive nulla (né DB né Gmail oltre alla mail di report).
 *
 * La tabella dkv_autorizzazioni è SOLO antifrode: questo script NON scrive in DB.carburante e non tocca
 * il gestionale; la fonte costi autorevole resta l'import xlsx.
 *
 * Script Properties (vedi impostaProprieta()): SUPABASE_URL, SUPABASE_SERVICE_KEY, REPORT_TO, LABEL_IN, LABEL_DONE
 * + soglie (SOGLIA_*), tutte con default documentati in DEFAULTS_ qui sotto.
 * La service-role key NON viene mai loggata né inviata via email.
 *
 * INSTALLAZIONE: vedi README.md. Riassunto: incolla il file, esegui impostaProprieta() (poi sostituisci i valori
 * nelle Proprietà script), setup(), provaAutorizzazioni(), creaTrigger().
 */

// ---------- CONFIG ----------
// Default documentati. Ogni valore può essere sovrascritto da una Script Property con lo stesso nome.
// Nessuna soglia è scritta altrove nel codice.
var DEFAULTS_ = {
  SUPABASE_URL: 'https://xqbhujcnjvwbwzpwjujf.supabase.co',
  SUPABASE_SERVICE_KEY: '',                       // OBBLIGATORIA, solo in Script Properties
  REPORT_TO: 'giaquinto.giuseppe@gmail.com',
  LABEL_IN: 'DKV/da-processare',
  LABEL_DONE: 'DKV/processata',
  TIMEZONE: 'Europe/Rome',
  MAX_THREAD_PER_GIRO: '50',                      // thread processati per esecuzione dell'ingest
  SOGLIA_IMPORTO_MAX: '300',                      // EUR: sopra questo importo la transazione è sospetta (0 = controllo disattivato)
  SOGLIA_LITRI_MAX: '0',                          // TODO: litri poco sopra il serbatoio più capiente della flotta. 0 = DISATTIVATO finché non riempita
  SOGLIA_ORA_INIZIO: '6',                         // ora (0-23) di inizio fascia lavorativa, inclusa
  SOGLIA_ORA_FINE: '20',                          // ora (0-23) di fine fascia: rifornimenti dalle FINE:00 in poi sono "fuori orario"
  SOGLIA_GIORNI_LAVORATIVI: '1,2,3,4,5,6',        // 1=lunedì ... 7=domenica; fuori da questi = "giorno non lavorativo"
  SOGLIA_MINUTI_DOPPIA: '30',                     // due transazioni stessa carta entro N minuti (0 = disattivato)
  SOGLIA_STAZIONE_NUOVA: '1',                     // 1 = segnala stazione mai vista prima (0 = disattivato)
  SOGLIA_MIN_STORICO_STAZIONI: '5'                // "stazione nuova" attiva solo dopo almeno N stazioni già note (evita falsi allarmi all'avvio)
};
var STATI_ = { NUOVA: 'nuova', ARCHIVIATA: 'archiviata_gmail' };
var TABELLA_ = 'dkv_autorizzazioni';

function config_() {
  var p = PropertiesService.getScriptProperties();
  var c = {};
  Object.keys(DEFAULTS_).forEach(function (k) {
    var v = p.getProperty(k);
    c[k] = (v == null || String(v).trim() === '') ? DEFAULTS_[k] : String(v).trim();
  });
  c.SUPABASE_URL = c.SUPABASE_URL.replace(/\/+$/, '');
  return c;
}
function num_(s) {
  var n = Number(String(s).replace(',', '.'));
  return isFinite(n) ? n : 0;
}

// ---------- RIFERIMENTI FLOTTA (solo promemoria per il futuro parser: NON usati per estrarre nulla ora) ----------
//  GM972CF = PRAMAC 2, carta DKV ...0322, diesel
//  FX943SG = Clio,     carta DKV ...2153
//  CT068NE = (Renato), diesel
//  FS504WE = (Pietro)
// Quando arriverà un'email campione: mappare carta_last4 -> targa con questa tabella e completare parseEmailDKV.

// ---------- PARSER (PLACEHOLDER) ----------
/**
 * Trasforma una email di notifica DKV in un record per la tabella dkv_autorizzazioni.
 * @param {string} subject  oggetto dell'email
 * @param {string} body     corpo (testo semplice, fallback HTML)
 * @param {Object} headers  { gmail_message_id, ricevuta_il (ISO), from, ... }
 * @return {Object} record con le colonne della tabella; parsed=false se l'estrazione non è riuscita
 */
function parseEmailDKV(subject, body, headers) {
  headers = headers || {};
  // Record con i soli campi grezzi: i campi interpretati restano null.
  var rec = {
    gmail_message_id: headers.gmail_message_id || null,
    ricevuta_il: headers.ricevuta_il || null,
    ts_transazione: null,
    carta_last4: null,
    targa: null,
    stazione: null,
    prodotto: null,
    importo: null,
    litri: null,
    esito: null,
    raw_subject: String(subject == null ? '' : subject),
    raw_body: String(body == null ? '' : body).substring(0, 100000),
    parsed: false
  };
  // TODO: completare estrazione con email campione
  // Non conosciamo ancora il formato: l'email contiene un link a DKV Analytics, i dati potrebbero essere nel
  // corpo oppure solo dietro il link. NON inventare regex: attendere un campione reale, poi valorizzare
  // ts_transazione, carta_last4 (+ targa dalla mappa flotta), stazione, prodotto, importo, litri, esito
  // e impostare parsed=true SOLO se i campi minimi (ts, carta, importo) sono stati estratti.
  return rec;
}

// ---------- ANOMALIE ----------
/**
 * Valuta un record. Gestisce i null senza esplodere.
 * @param {Object} record
 * @param {Object=} ctx   { altre: [{gmail_message_id, ts_transazione}] stessa carta in finestra,
 *                          stazioniNote: [string] stazioni già viste }  (letto da Supabase dall'ingest)
 * @param {Object=} cfg   config (default: config_())
 * @return {{sospetta:boolean, motivi:string[], da_verificare:boolean}}
 *   da_verificare = record non interpretato (parsed=false): NON è sospetto, ma va segnalato.
 */
function valutaSospetti(record, ctx, cfg) {
  cfg = cfg || config_();
  ctx = ctx || {};
  var motivi = [];
  var r = record || {};
  var tz = cfg.TIMEZONE;

  var importo = r.importo == null ? null : Number(r.importo);
  var litri = r.litri == null ? null : Number(r.litri);
  var maxImp = num_(cfg.SOGLIA_IMPORTO_MAX), maxLit = num_(cfg.SOGLIA_LITRI_MAX);
  if (importo != null && isFinite(importo) && maxImp > 0 && importo > maxImp) {
    motivi.push('importo ' + importo.toFixed(2) + ' EUR oltre il massimo ' + maxImp);
  }
  if (litri != null && isFinite(litri) && maxLit > 0 && litri > maxLit) {
    motivi.push('litri ' + litri + ' oltre il massimo ' + maxLit);
  }

  var ts = r.ts_transazione ? new Date(r.ts_transazione) : null;
  if (ts && !isNaN(ts.getTime())) {
    var ora = Number(Utilities.formatDate(ts, tz, 'H'));
    var gio = Number(Utilities.formatDate(ts, tz, 'u'));
    var giorni = String(cfg.SOGLIA_GIORNI_LAVORATIVI).split(',').map(function (x) { return Number(x.trim()); });
    if (giorni.indexOf(gio) < 0) motivi.push('rifornimento in giorno non lavorativo');
    else if (ora < num_(cfg.SOGLIA_ORA_INIZIO) || ora >= num_(cfg.SOGLIA_ORA_FINE)) motivi.push('rifornimento fuori orario (ore ' + ora + ')');

    var finestra = num_(cfg.SOGLIA_MINUTI_DOPPIA);
    if (finestra > 0 && r.carta_last4) {
      (ctx.altre || []).forEach(function (o) {
        if (!o || o.gmail_message_id === r.gmail_message_id || !o.ts_transazione) return;
        var d = Math.abs(new Date(o.ts_transazione).getTime() - ts.getTime()) / 60000;
        if (d <= finestra) motivi.push('due transazioni stessa carta ...' + r.carta_last4 + ' entro ' + finestra + ' min');
      });
    }
  }

  if (num_(cfg.SOGLIA_STAZIONE_NUOVA) > 0 && r.stazione) {
    var note = (ctx.stazioniNote || []).map(function (s) { return String(s).trim().toLowerCase(); });
    if (note.length >= num_(cfg.SOGLIA_MIN_STORICO_STAZIONI) && note.indexOf(String(r.stazione).trim().toLowerCase()) < 0) {
      motivi.push('stazione mai vista prima: ' + r.stazione);
    }
  }

  return { sospetta: motivi.length > 0, motivi: unici_(motivi), da_verificare: r.parsed !== true };
}

// ---------- INGEST (scrittura) ----------
function processaGiornata() {
  var cfg = config_();
  var lab = GmailApp.getUserLabelByName(cfg.LABEL_IN);
  if (!lab) { Logger.log('Label "' + cfg.LABEL_IN + '" non trovata: esegui setup().'); return { threads: 0, record: 0, errori: 0 }; }
  var done = GmailApp.getUserLabelByName(cfg.LABEL_DONE) || GmailApp.createLabel(cfg.LABEL_DONE);
  var threads = lab.getThreads(0, Math.max(1, Math.floor(num_(cfg.MAX_THREAD_PER_GIRO)) || 50));
  var tot = { threads: 0, record: 0, errori: 0 };

  threads.forEach(function (th) {
    try {
      var ids = [];
      th.getMessages().forEach(function (m) {
        var rec = parseEmailDKV(m.getSubject(), corpo_(m), {
          gmail_message_id: m.getId(),
          ricevuta_il: m.getDate().toISOString(),
          from: m.getFrom()
        });
        var v = valutaSospetti(rec, contesto_(cfg, rec), cfg);
        rec.sospetta = v.sospetta;
        rec.motivi_sospetto = v.motivi.length ? v.motivi.join('; ') : null;
        rec.stato = STATI_.NUOVA;
        upsert_(cfg, [rec]);
        ids.push(rec.gmail_message_id);
        tot.record++;
      });
      // Solo dopo che TUTTI i messaggi sono salvati: etichetta + archivia (mai cancellare/cestinare)
      th.addLabel(done);
      th.removeLabel(lab);
      th.moveToArchive();
      aggiornaStato_(cfg, ids, STATI_.ARCHIVIATA);
      tot.threads++;
    } catch (err) {
      tot.errori++;
      Logger.log('Errore ingest thread: ' + sicuro_(err)); // il thread resta in LABEL_IN e verrà ritentato
    }
  });
  Logger.log('Ingest: ' + JSON.stringify(tot));
  return tot;
}
function corpo_(m) {
  var t = '';
  try { t = m.getPlainBody(); } catch (e) { t = ''; }
  if (!t) { try { t = m.getBody(); } catch (e2) { t = ''; } }
  return t || '';
}

// Contesto per valutaSospetti: letture da Supabase, solo se servono dati interpretati
function contesto_(cfg, rec) {
  var ctx = { altre: [], stazioniNote: [] };
  try {
    var q;
    if (rec.carta_last4 && rec.ts_transazione && num_(cfg.SOGLIA_MINUTI_DOPPIA) > 0) {
      var t = new Date(rec.ts_transazione).getTime(), w = num_(cfg.SOGLIA_MINUTI_DOPPIA) * 60000;
      if (!isNaN(t)) {
        q = '?select=gmail_message_id,ts_transazione&carta_last4=eq.' + encodeURIComponent(rec.carta_last4) +
          '&ts_transazione=gte.' + encodeURIComponent(new Date(t - w).toISOString()) +
          '&ts_transazione=lte.' + encodeURIComponent(new Date(t + w).toISOString());
        ctx.altre = supabase_(cfg, 'get', q).json || [];
      }
    }
    if (rec.stazione && num_(cfg.SOGLIA_STAZIONE_NUOVA) > 0) {
      var righe = supabase_(cfg, 'get', '?select=stazione&stazione=not.is.null&limit=1000').json || [];
      ctx.stazioniNote = unici_(righe.map(function (x) { return x.stazione; }));
    }
  } catch (err) {
    Logger.log('Contesto sospetti non disponibile: ' + sicuro_(err));
  }
  return ctx;
}

// Upsert idempotente: una riga per gmail_message_id (merge-duplicates)
function upsert_(cfg, records) {
  records.forEach(function (r) { if (!r.gmail_message_id) throw new Error('gmail_message_id mancante'); });
  return supabase_(cfg, 'post', '?on_conflict=gmail_message_id', records, { Prefer: 'resolution=merge-duplicates,return=minimal' });
}
function aggiornaStato_(cfg, ids, stato) {
  ids = ids.filter(String);
  if (!ids.length) return;
  var lista = ids.map(function (i) { return '"' + String(i).replace(/"/g, '') + '"'; }).join(',');
  supabase_(cfg, 'patch', '?gmail_message_id=in.(' + encodeURIComponent(lista) + ')', { stato: stato }, { Prefer: 'return=minimal' });
}

// Chiamata REST a Supabase con service-role key. Gli errori non contengono mai la chiave.
function supabase_(cfg, metodo, query, payload, extra) {
  var key = cfg.SUPABASE_SERVICE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_KEY mancante nelle Script Properties');
  var headers = { apikey: key, Authorization: 'Bearer ' + key };
  if (payload !== undefined) headers['Content-Type'] = 'application/json';
  Object.keys(extra || {}).forEach(function (k) { headers[k] = extra[k]; });
  var opt = { method: metodo, headers: headers, muteHttpExceptions: true };
  if (payload !== undefined) opt.payload = JSON.stringify(payload);
  var res = UrlFetchApp.fetch(cfg.SUPABASE_URL + '/rest/v1/' + TABELLA_ + (query || ''), opt);
  var code = res.getResponseCode();
  var testo = res.getContentText() || '';
  if (code < 200 || code >= 300) throw new Error('Supabase HTTP ' + code + ': ' + testo.substring(0, 200).replace(key, '***'));
  var json = null;
  try { json = testo ? JSON.parse(testo) : null; } catch (e) { json = null; }
  return { code: code, json: json };
}

// ---------- REPORT (SOLA LETTURA) ----------
function reportSerale() {
  var cfg = config_();
  var giorno = Utilities.formatDate(new Date(), cfg.TIMEZONE, 'yyyy-MM-dd');
  var off = Utilities.formatDate(new Date(), cfg.TIMEZONE, 'XXX');
  var da = giorno + 'T00:00:00' + off;
  var a = giorno + 'T23:59:59' + off;
  var righe = supabase_(cfg, 'get',
    '?select=*&ricevuta_il=gte.' + encodeURIComponent(da) + '&ricevuta_il=lte.' + encodeURIComponent(a) +
    '&order=ricevuta_il.asc&limit=1000').json || [];
  var html = htmlReport_(righe, giorno);
  var sosp = righe.filter(function (r) { return r.sospetta; }).length;
  GmailApp.sendEmail(cfg.REPORT_TO, 'DKV ' + giorno + ': ' + righe.length + ' transazioni' + (sosp ? ', ' + sosp + ' SOSPETTE' : ''),
    'Report DKV del ' + giorno + ' (apri in HTML).', { htmlBody: html, name: 'Antifrode DKV 81|00' });
  return { giorno: giorno, transazioni: righe.length, sospette: sosp };
}

function esc_(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function htmlReport_(righe, giorno) {
  var sosp = righe.filter(function (r) { return r.sospetta; });
  var dav = righe.filter(function (r) { return !r.parsed; });
  var totale = righe.reduce(function (s, r) { return s + (r.importo == null ? 0 : Number(r.importo) || 0); }, 0);
  var h = '<div style="font-family:Arial,sans-serif;font-size:14px">';
  h += '<h2>Report DKV ' + esc_(giorno) + '</h2>';
  h += '<p>Transazioni: <b>' + righe.length + '</b> &middot; Totale importi: <b>' + totale.toFixed(2) + ' EUR</b>' +
    ' &middot; Sospette: <b style="color:#c00">' + sosp.length + '</b> &middot; Da verificare (non interpretate): <b>' + dav.length + '</b></p>';
  if (sosp.length) {
    h += '<div style="border:2px solid #c00;padding:8px;margin:8px 0"><h3 style="color:#c00;margin:0 0 6px">ANOMALIE SOSPETTE</h3><ul style="color:#c00">';
    sosp.forEach(function (r) { h += '<li>' + riga_(r) + '<br><b>Motivi:</b> ' + esc_(r.motivi_sospetto) + '</li>'; });
    h += '</ul></div>';
  }
  if (dav.length) {
    h += '<p><b>Da verificare a mano</b> (email non interpretata, nessun giudizio di frode):</p><ul>';
    dav.forEach(function (r) { h += '<li>' + esc_(r.raw_subject) + ' (ricevuta ' + esc_(r.ricevuta_il) + ')</li>'; });
    h += '</ul>';
  }
  h += '<h3>Elenco del giorno</h3>';
  if (!righe.length) h += '<p>Nessuna transazione.</p>';
  else {
    h += '<table style="border-collapse:collapse;font-size:12px" cellpadding="4" border="1">' +
      '<tr><th>Ora</th><th>Carta</th><th>Targa</th><th>Stazione</th><th>Prodotto</th><th>EUR</th><th>Litri</th><th>Esito</th></tr>';
    righe.forEach(function (r) {
      var st = r.sospetta ? ' style="color:#c00"' : '';
      h += '<tr' + st + '><td>' + esc_(r.ts_transazione || r.ricevuta_il) + '</td><td>' + esc_(r.carta_last4) + '</td><td>' + esc_(r.targa) +
        '</td><td>' + esc_(r.stazione) + '</td><td>' + esc_(r.prodotto) + '</td><td>' + esc_(r.importo) + '</td><td>' + esc_(r.litri) +
        '</td><td>' + esc_(r.esito) + '</td></tr>';
    });
    h += '</table>';
  }
  return h + '</div>';
}
function riga_(r) {
  return esc_([r.ts_transazione || r.ricevuta_il, r.targa || ('carta ...' + (r.carta_last4 || '?')), r.stazione, r.importo == null ? '' : r.importo + ' EUR',
    r.litri == null ? '' : r.litri + ' L'].filter(function (x) { return x !== '' && x != null; }).join(' | '));
}

// ---------- utilità ----------
function unici_(l) {
  var v = {};
  return l.filter(function (x) { if (v[x]) return false; v[x] = true; return true; });
}
function sicuro_(err) {
  var s = String((err && err.message) || err);
  var k = '';
  try { k = PropertiesService.getScriptProperties().getProperty('SUPABASE_SERVICE_KEY') || ''; } catch (e) { k = ''; }
  return k ? s.split(k).join('***') : s;
}

// ---------- funzioni da eseguire a mano dall'editor ----------
// Crea le label Gmail mancanti e stampa le istruzioni per il filtro.
function setup() {
  var cfg = config_();
  [cfg.LABEL_IN, cfg.LABEL_DONE].forEach(function (n) {
    if (!GmailApp.getUserLabelByName(n)) { GmailApp.createLabel(n); Logger.log('Creata label: ' + n); }
    else Logger.log('Label già presente: ' + n);
  });
  Logger.log([
    'FILTRO GMAIL da creare a mano (Impostazioni > Filtri e indirizzi bloccati > Crea un nuovo filtro):',
    '  Da:      TODO: mittente DKV da confermare sul primo campione reale (es. @dkv-euroservice.com?)',
    '  Oggetto: TODO: oggetto da confermare sul primo campione reale (notifica "Autorizzazioni LIVE")',
    '  Azione:  Applica l\'etichetta "' + cfg.LABEL_IN + '"  (NON "Elimina")',
    'Finché mittente/oggetto non sono confermati, applica la label a mano a una email DKV per provare.'
  ].join('\n'));
}

// Esempio/placeholder: sostituisci i valori, esegui UNA volta, poi riporta i placeholder (la chiave non va lasciata nel codice).
function impostaProprieta() {
  PropertiesService.getScriptProperties().setProperties({
    SUPABASE_URL: 'https://xqbhujcnjvwbwzpwjujf.supabase.co',
    SUPABASE_SERVICE_KEY: 'INCOLLA_QUI_LA_SERVICE_ROLE_KEY',
    REPORT_TO: 'giaquinto.giuseppe@gmail.com',
    LABEL_IN: 'DKV/da-processare',
    LABEL_DONE: 'DKV/processata',
    SOGLIA_IMPORTO_MAX: '300',
    SOGLIA_LITRI_MAX: '0' // TODO: litri poco sopra il serbatoio più capiente della flotta
  }, false);
  Logger.log('Script Properties impostate. Verifica che SUPABASE_SERVICE_KEY non sia più il placeholder, poi cancella la chiave dal codice.');
}

// Verifica accesso Gmail + fetch a Supabase (non stampa mai la chiave).
function provaAutorizzazioni() {
  var cfg = config_();
  Logger.log('Account: ' + Session.getEffectiveUser().getEmail());
  Logger.log('Thread in Posta in arrivo: ' + GmailApp.getInboxThreads(0, 1).length);
  Logger.log('Label IN presente: ' + !!GmailApp.getUserLabelByName(cfg.LABEL_IN) + ' | DONE presente: ' + !!GmailApp.getUserLabelByName(cfg.LABEL_DONE));
  Logger.log('Service key presente: ' + !!cfg.SUPABASE_SERVICE_KEY);
  try {
    var r = supabase_(cfg, 'get', '?select=id&limit=1');
    Logger.log('Supabase OK: HTTP ' + r.code);
  } catch (err) {
    Logger.log('Supabase KO: ' + sicuro_(err));
  }
}

// Installa i due trigger temporali (rimuove prima i vecchi trigger di queste due funzioni).
function creaTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var f = t.getHandlerFunction();
    if (f === 'processaGiornata' || f === 'reportSerale') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('processaGiornata').timeBased().everyMinutes(30).create();
  ScriptApp.newTrigger('reportSerale').timeBased().atHour(21).everyDays(1).inTimezone(DEFAULTS_.TIMEZONE).create();
  Logger.log('Trigger creati: processaGiornata ogni 30 min; reportSerale ogni giorno alle 21:00 (Europe/Rome, finestra fino alle 22).');
}
