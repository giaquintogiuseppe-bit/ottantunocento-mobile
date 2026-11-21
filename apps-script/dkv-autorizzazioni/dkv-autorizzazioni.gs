/**
 * Antifrode carte DKV 81|00 — Apps Script sul Gmail di Giuseppe (NON è una web app).
 *
 * Contesto: carte carburante DKV (cliente 4301665111). Su DKV Cockpit la notifica "Autorizzazioni LIVE"
 * manda un'email immediata a ogni rifornimento. Questo script:
 *   1. INGEST  (processaGiornata, trigger ogni 30 min): legge i thread con label LABEL_IN, legge l'ALLEGATO xlsx
 *      di ogni email (parseEmailDKV, conversione via Drive) -> una riga per transazione, valuta i sospetti, fa upsert
 *      su Supabase (tabella dkv_autorizzazioni, idempotente su authorization_id), poi etichetta LABEL_DONE e ARCHIVIA il thread. Non cancella e non cestina mai.
 *   1b. RICONCILIAZIONE (riconciliaScontrini, trigger ogni 2 ore, scrive): incrocio con gli scontrini del bot Telegram
 *      (tabella Supabase scontrini_telegram: ts, autore, mezzo, cantiere, note). All'ingest si ARRICCHISCE solo il record
 *      (cantiere/autore dello scontrino se già presente). Lo scontrino arriva spesso DOPO l'email DKV (anche il giorno
 *      dopo): quindi "senza scontrino" si dichiara SOLO dopo SOGLIA_ORE_GRACE_SCONTRINO ore, in riconciliaScontrini.
 *   2. REPORT  (reportSerale, trigger giornaliero ~21:00 Europe/Rome): SOLA LETTURA su Supabase; invia a REPORT_TO
 *      un'email HTML con le transazioni del giorno e, in cima in rosso, quelle sospette.
 *
 * SCELTA DEI TRIGGER: ingest e report sono separati di proposito. Ingest frequente (30 min) = i dati restano
 * freschi e la inbox pulita; il report è uno solo, la sera, e non scrive nulla (né DB né Gmail oltre alla mail di report).
 *
 * La tabella dkv_autorizzazioni è SOLO antifrode: questo script NON scrive in DB.carburante e non tocca
 * il gestionale; la fonte costi autorevole resta l'import xlsx.
 *
 * Servizi: Gmail + Drive Advanced Service (appsscript.json) per convertire l'xlsx allegato in Google Sheet temporaneo.
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
  SOGLIA_MIN_STORICO_STAZIONI: '5',               // "stazione nuova" attiva solo dopo almeno N stazioni già note (evita falsi allarmi all'avvio)
  SOGLIA_MINUTI_SCONTRINO: '1440',                // finestra abbinamento DKV<->scontrino: gli scontrini si registrano spesso la SERA, non all'istante del rifornimento -> finestra ampia (1440 = 24h)
  SOGLIA_ORE_GRACE_SCONTRINO: '24',               // ore da attendere prima di dichiarare "senza scontrino" (lo scontrino può arrivare il giorno dopo)
  FLOTTA_SHEET_ID: ''                             // id di un Foglio Google con la flotta (colonne nome|dkv|targa|gps|alias). Vuoto = si usa FLOTTA_ del codice
};
var STATI_ = { NUOVA: 'nuova', ARCHIVIATA: 'archiviata_gmail' };
var TABELLA_ = 'dkv_autorizzazioni';
var TABELLA_SCONTRINI_ = 'scontrini_telegram';   // scritta dal bot Telegram; qui SOLO lettura
var MOTIVO_SENZA_SCONTRINO_ = 'rifornimento senza scontrino Telegram (non associato a cantiere)';
// Flotta Ottantunocento: per ogni mezzo gli ALIAS con cui può comparire nello scontrino Telegram.
// `dkv` = come il mezzo appare nell'email DKV (campo "Licence plate"): NON sempre è la targa reale
// (es. Clio: DKV F9341PT ma targa reale FX943SG). `alias` = targa reale, id GPS e nome con cui il bot
// può indicare il mezzo. NB: "PRAMAC 1" è condiviso da due macchine (Generatore pramac e Ragno): una
// transazione DKV "Pramac 1" NON è distinguibile tra le due (stessa carta/PIN).
// Se la Script Property FLOTTA_SHEET_ID è valorizzata e il foglio contiene almeno una voce valida, il foglio SOSTITUISCE
// questa lista (vedi caricaFlotta_); questa resta il fallback. preparaFoglioFlotta() crea il foglio a partire da qui.
var FLOTTA_ = [
  { nome: 'Iveco con sponda',   dkv: 'GM972CF',  alias: ['GM972CF'] },
  { nome: 'Iveco aperto',       dkv: 'CT068NE',  alias: ['CT068NE'] },
  { nome: 'Doblò',              dkv: 'FS504WE',  alias: ['FS504WE'] },
  { nome: 'Clio',               dkv: 'F9341PT',  alias: ['FX943SG', 'CLIO'] },
  { nome: 'Skoda',              dkv: 'G86499N',  alias: ['GB649YN', 'SKODA'] },   // DKV: G86499N (email); GB649YN = id GPS
  { nome: 'Generatore pramac',  dkv: 'PRAMAC 1', alias: ['PRAMAC 3', 'PRAMAC 1', 'GENERATORE PRAMAC'] },
  { nome: 'Ragno',              dkv: 'PRAMAC 1', alias: ['ATOM', 'PRAMAC 1', 'RAGNO'] },
  { nome: 'Generatore piccolo', dkv: 'PRAMAC 2', alias: ['AIR TAG', 'PRAMAC 2', 'GENERATORE PICCOLO'] }
];

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

// ---------- PARSER (REALE: allegato xlsx) ----------
// Email DKV Analytics (mittente no-reply@my-mail.dkv-mobility.com, oggetto 'DKV Analytics notification: New data
// available for your rule "rifornimento"'): i DATI sono nell'ALLEGATO xlsx, non nel corpo.
// Foglio: riga 0 = titolo, riga 1 = intestazioni (inglese), riga 2+ = una transazione per riga.
// La targa arriva già dall'email: la vecchia mappa carta->targa della flotta non serve più.

// Colonna del record -> testo (minuscolo) da cercare nelle intestazioni del foglio.
var COLONNE_DKV_ = {
  authorization_id: 'authorization id',
  targa: 'licence plate',
  ts: 'authorization time',
  litri: 'sales',                          // convenzione gestionale: Sales = LITRI (colonna "Unit" = L)
  importo: 'authorization amount gross',   // importo lordo AUTORIZZATO, es. "70.00 EUR"
  prodotto: 'product',
  prodotto_gruppo: 'product group',
  product_code: 'product code',
  carta: 'number of card or box',
  stazione: 'station name',
  station_number: 'station number',
  citta: 'town',
  esito: 'response',
  km: 'mileage',
  customer_number: 'customer number'
};

// Cerca il valore per intestazione: prima match esatto, poi "contiene" (case-insensitive).
function colonna_(obj, nome) {
  var chiavi = Object.keys(obj || {});
  var n = String(nome).toLowerCase();
  var norm = function (k) { return String(k).trim().toLowerCase(); };
  for (var i = 0; i < chiavi.length; i++) if (norm(chiavi[i]) === n) return obj[chiavi[i]];
  for (var j = 0; j < chiavi.length; j++) if (norm(chiavi[j]).indexOf(n) >= 0) return obj[chiavi[j]];
  return undefined;
}
function testo_(v) {
  if (v == null) return null;
  var t = String(v).trim();
  return t === '' ? null : t;
}
// "33.51", "33,51", 33.51, "70.00 EUR" -> numero (null se assente/non numerico)
function numeroDKV_(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  var m = String(v).match(/-?[\d.,]+/);
  if (!m) return null;
  var t = m[0];
  if (t.indexOf(',') >= 0 && t.indexOf('.') >= 0) t = t.replace(/,/g, '');   // 1,234.50
  else t = t.replace(',', '.');
  var n = Number(t);
  return isFinite(n) ? n : null;
}
function offsetMs_(off) {
  var m = /^([+-])(\d{2}):?(\d{2})$/.exec(off);
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60000;
}
function p2_(n) { return (n < 10 ? '0' : '') + n; }
// "18.11.2026 - 09:50" (ora locale Europe/Rome) -> "2026-11-18T09:50:00+01:00" (gestisce ora legale). null se non valido.
function parseDataOraDKV_(v, tz) {
  if (v == null || v === '') return null;
  if (Object.prototype.toString.call(v) === '[object Date]') return isNaN(v.getTime()) ? null : v.toISOString();
  var m = String(v).match(/^\s*(\d{1,2})\.(\d{1,2})\.(\d{4})\s*-?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/);
  if (!m) return null;
  var d = Number(m[1]), mo = Number(m[2]), y = Number(m[3]), h = Number(m[4]), mi = Number(m[5]), sec = Number(m[6] || 0);
  var guess = Date.UTC(y, mo - 1, d, h, mi, sec);
  var chk = new Date(guess);
  if (chk.getUTCDate() !== d || chk.getUTCMonth() !== mo - 1 || h > 23 || mi > 59 || sec > 59) return null;
  tz = tz || DEFAULTS_.TIMEZONE;
  var off1 = Utilities.formatDate(new Date(guess), tz, 'XXX');
  var off = Utilities.formatDate(new Date(guess - offsetMs_(off1)), tz, 'XXX');
  return y + '-' + p2_(mo) + '-' + p2_(d) + 'T' + p2_(h) + ':' + p2_(mi) + ':' + p2_(sec) + off;
}
// Benzina/RON->Verde, GPL/Gas auto/LPG->GPL, Diesel->Diesel, AdBlue->AdBlue, altrimenti testo grezzo.
function prodottoDKV_(prodotto, gruppo) {
  var t = (String(prodotto == null ? '' : prodotto) + ' ' + String(gruppo == null ? '' : gruppo)).toLowerCase();
  if (/adblue/.test(t)) return 'AdBlue';
  if (/\bgpl\b|\blpg\b|gas\s*auto/.test(t)) return 'GPL';
  if (/diesel|gasolio/.test(t)) return 'Diesel';
  if (/benzina|\bron\b/.test(t)) return 'Verde';
  return testo_(prodotto) || testo_(gruppo);
}
// Esito grezzo (es. APP_LIM20_APPR) -> 'approvata' (inizia con APP) / 'rifiutata' (inizia con DEC) / 'altro' / null
function esitoDKV_(esito) {
  var e = String(esito == null ? '' : esito).trim().toUpperCase();
  if (!e) return null;
  if (e.indexOf('APP') === 0) return 'approvata';
  if (e.indexOf('DEC') === 0) return 'rifiutata';
  return 'altro';
}
// Record con TUTTE le colonne (stesse chiavi per ogni riga: serve all'upsert bulk di PostgREST)
function recordVuoto_() {
  return {
    authorization_id: null, gmail_message_id: null, ricevuta_il: null, ts_transazione: null, carta_last4: null, targa: null,
    stazione: null, prodotto: null, importo: null, litri: null, esito: null, product_code: null, km: null, citta: null,
    station_number: null, customer_number: null, raw_subject: '', raw_body: '', parsed: false,
    cantiere: null, scontrino_autore: null, scontrino_trovato: false
  };
}

/**
 * FUNZIONE PURA (testata): mappa una riga {intestazione -> valore} dell'xlsx DKV in un record della tabella.
 * parsed=true solo se ci sono almeno authorization_id e ts_transazione.
 * @param {Object} obj  es. {'Licence plate':'G86499N','Authorization Time':'18.11.2026 - 09:50',...}
 * @param {string=} tz  default Europe/Rome
 */
function mappaRigaDKV_(obj, tz) {
  var C = COLONNE_DKV_, r = recordVuoto_();
  r.authorization_id = testo_(colonna_(obj, C.authorization_id));
  r.targa = testo_(colonna_(obj, C.targa));
  r.ts_transazione = parseDataOraDKV_(colonna_(obj, C.ts), tz);
  r.litri = numeroDKV_(colonna_(obj, C.litri));
  // NB: importo = importo lordo AUTORIZZATO ("Authorization Amount Gross"): può essere un massimale
  // pre-autorizzato e non il consumato reale. Il consumato reale resta nell'import xlsx del gestionale.
  r.importo = numeroDKV_(colonna_(obj, C.importo));
  r.prodotto = prodottoDKV_(colonna_(obj, C.prodotto), colonna_(obj, C.prodotto_gruppo));
  var carta = String(colonna_(obj, C.carta) == null ? '' : colonna_(obj, C.carta)).replace(/\D/g, '');
  r.carta_last4 = carta ? carta.slice(-4) : null;
  r.stazione = testo_(colonna_(obj, C.stazione));
  r.esito = testo_(colonna_(obj, C.esito));          // grezzo; vedi esitoDKV_()
  r.product_code = testo_(colonna_(obj, C.product_code));
  r.km = numeroDKV_(colonna_(obj, C.km));
  r.citta = testo_(colonna_(obj, C.citta));
  r.station_number = testo_(colonna_(obj, C.station_number));
  r.customer_number = testo_(colonna_(obj, C.customer_number));
  r.parsed = !!(r.authorization_id && r.ts_transazione);
  return r;
}

// Helper Drive/SpreadsheetApp (NON unit-testato). Converte ogni allegato xlsx in un Google Sheet temporaneo
// (Drive Advanced Service, scope Drive), legge i valori e ELIMINA sempre il file temporaneo.
// Ritorna [{file: nomeAllegato, righe: [ {intestazione: valore}, ... ]}]
function leggiAllegatiXlsx_(msg) {
  var out = [];
  msg.getAttachments({ includeInlineImages: false, includeAttachments: true }).forEach(function (blob) {
    var nome = String(blob.getName() || '');
    var tipo = String(blob.getContentType() || '');
    if (!/\.xlsx$/i.test(nome) && tipo.indexOf('spreadsheetml') < 0) return;
    var id = null;
    try {
      var f = Drive.Files.insert({ title: 'tmp-dkv-' + Date.now(), mimeType: 'application/vnd.google-apps.spreadsheet' }, blob, { convert: true });
      id = f.id;
      var v = SpreadsheetApp.openById(id).getSheets()[0].getDataRange().getValues();
      var righe = [];
      if (v.length >= 2) {                       // riga 0 = titolo (saltata), riga 1 = intestazioni
        var h = v[1].map(function (x) { return String(x == null ? '' : x).trim(); });
        for (var i = 2; i < v.length; i++) {
          var o = {}, vuota = true;
          for (var c = 0; c < h.length; c++) {
            if (!h[c]) continue;
            o[h[c]] = v[i][c];
            if (v[i][c] !== '' && v[i][c] != null) vuota = false;
          }
          if (!vuota) righe.push(o);
        }
      }
      out.push({ file: nome, righe: righe });
    } finally {
      if (id) {
        try { Drive.Files.remove(id); }
        catch (e) { try { DriveApp.getFileById(id).setTrashed(true); } catch (e2) { Logger.log('File temporaneo non eliminato: ' + sicuro_(e2)); } }
      }
    }
  });
  return out;
}

/**
 * Trasforma un messaggio Gmail DKV in un ARRAY di record (uno per riga dati dell'xlsx allegato).
 * Se non ci sono allegati xlsx (o nessuna riga dati): un solo record parsed=false con raw_subject/raw_body (fallback).
 * Se la lettura dell'xlsx fallisce l'errore PROPAGA: il thread resta in LABEL_IN e viene ritentato (nessuna perdita dati).
 * @param {GmailMessage} msg
 * @return {Object[]}
 */
function parseEmailDKV(msg) {
  var base = {
    gmail_message_id: msg.getId(),
    ricevuta_il: msg.getDate().toISOString(),
    raw_subject: String(msg.getSubject() == null ? '' : msg.getSubject())
  };
  var out = [];
  leggiAllegatiXlsx_(msg).forEach(function (a) {
    a.righe.forEach(function (obj, i) {
      var r = mappaRigaDKV_(obj);
      r.gmail_message_id = base.gmail_message_id;
      r.ricevuta_il = base.ricevuta_il;
      r.raw_subject = base.raw_subject;
      r.raw_body = 'allegato: ' + a.file + ' (riga dati ' + (i + 1) + ')';
      out.push(r);
    });
  });
  if (!out.length) {
    var f = recordVuoto_();
    f.gmail_message_id = base.gmail_message_id;
    f.ricevuta_il = base.ricevuta_il;
    f.raw_subject = base.raw_subject;
    f.raw_body = corpo_(msg).substring(0, 100000);
    out.push(f);
  }
  return out;
}

// ---------- ANOMALIE ----------
/**
 * Valuta un record. Gestisce i null senza esplodere.
 * @param {Object} record
 * @param {Object=} ctx   { altre: [{authorization_id, ts_transazione}] stessa carta in finestra,
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

  if (esitoDKV_(r.esito) === 'rifiutata') motivi.push('transazione rifiutata (esito ' + r.esito + ')');

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
        if (!o || o.authorization_id === r.authorization_id || !o.ts_transazione) return;
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

// ---------- INCROCIO SCONTRINI TELEGRAM ----------
// Maiuscolo, solo caratteri alfanumerici ("gm 972-cf" -> "GM972CF").
function normId_(s) {
  return String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');
}
function msValido_(v) {
  if (v == null || v === '') return null;
  var t = new Date(v).getTime();
  return isNaN(t) ? null : t;
}
// Uguali oppure uno contiene l'altro (il "contiene" solo da 3 caratteri in su, per non agganciare sigle di 1-2 lettere).
function simile_(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  return (a.length >= 3 && b.length >= 3) && (a.indexOf(b) >= 0 || b.indexOf(a) >= 0);
}
/**
 * FUNZIONE PURA (testata): converte la matrice di un Foglio (Sheet.getValues(); riga 0 = intestazioni) in una lista flotta
 * [{nome, dkv, alias:[...]}]. Intestazioni (case-insensitive, "contiene", in qualsiasi ordine): nome, dkv, targa, gps, alias
 * (alias = lista separata da virgola o ;, opzionale). `alias` in uscita = targa + gps + alias extra (vuoti scartati, senza doppioni).
 * Le righe senza `dkv` sono saltate. Celle null/numeriche tollerate; mai eccezioni.
 * @param {Array[]} values
 * @return {{nome:string, dkv:string, alias:string[]}[]}
 */
function parseRigheFlotta_(values) {
  if (!Array.isArray(values) || values.length < 2 || !Array.isArray(values[0])) return [];
  var idx = {};
  ['nome', 'dkv', 'targa', 'gps', 'alias'].forEach(function (k) {
    idx[k] = -1;
    for (var i = 0; i < values[0].length; i++) {
      if (String(values[0][i] == null ? '' : values[0][i]).toLowerCase().indexOf(k) >= 0) { idx[k] = i; break; }
    }
  });
  if (idx.dkv < 0) return [];
  var cella = function (row, k) {
    if (idx[k] < 0 || idx[k] >= row.length || row[idx[k]] == null) return '';
    return String(row[idx[k]]).trim();
  };
  var out = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    if (!Array.isArray(row)) continue;
    var dkv = cella(row, 'dkv');
    if (!dkv) continue;
    var alias = [cella(row, 'targa'), cella(row, 'gps')].concat(cella(row, 'alias').split(/[,;]/))
      .map(function (x) { return x.trim(); }).filter(function (x) { return x; });
    out.push({ nome: cella(row, 'nome'), dkv: dkv, alias: unici_(alias) });
  }
  return out;
}
// NON testata (usa SpreadsheetApp): sorgente della flotta. Se FLOTTA_SHEET_ID è valorizzata e il foglio dà almeno una voce
// valida, SOSTITUISCE FLOTTA_; altrimenti (assente/illeggibile/vuoto) fallback a FLOTTA_ con un avviso nel log.
// Cache per esecuzione in _flottaCache (resettata all'inizio di processaGiornata e riconciliaScontrini).
var _flottaCache = null;
function caricaFlotta_(cfg) {
  if (_flottaCache) return _flottaCache;
  var id = cfg && cfg.FLOTTA_SHEET_ID ? String(cfg.FLOTTA_SHEET_ID).trim() : '';
  var flotta = null;
  if (id) {
    try {
      var l = parseRigheFlotta_(SpreadsheetApp.openById(id).getSheets()[0].getDataRange().getValues());
      if (l.length) flotta = l;
      else Logger.log('Foglio flotta vuoto o senza voci valide: uso FLOTTA_ del codice.');
    } catch (err) {
      Logger.log('Foglio flotta non leggibile (' + sicuro_(err) + '): uso FLOTTA_ del codice.');
    }
  }
  _flottaCache = flotta || FLOTTA_;
  return _flottaCache;
}
// Tutti gli alias (normalizzati) con cui può comparire il mezzo la cui identità DKV è `dkvId`.
// Include sempre dkvId stesso, così un mezzo non ancora in FLOTTA_ si abbina almeno sulla sua sigla DKV.
// `flotta` opzionale (default FLOTTA_): resta pura.
function aliasFlotta_(dkvId, flotta) {
  var d = normId_(dkvId);
  var out = d ? [d] : [];
  (Array.isArray(flotta) ? flotta : FLOTTA_).forEach(function (m) {
    if (normId_(m.dkv) !== d) return;
    (m.alias || []).forEach(function (a) { var n = normId_(a); if (n) out.push(n); });
  });
  return unici_(out);
}
/**
 * FUNZIONE PURA (testata): cerca lo scontrino Telegram che corrisponde a una transazione DKV.
 * Match: mezzo dello scontrino ~ uno qualsiasi degli alias del mezzo la cui identità DKV è `rec.targa`
 * (aliasFlotta_: DKV, targa reale, id GPS, nome; normalizzati; uguali o uno contiene l'altro), con |ts_scontrino - ts_transazione| <= finestraMin.
 * Fra più candidati vince il più vicino nel tempo. Null/ts non validi: nessun match, mai eccezioni.
 * @param {Object} rec  record DKV ({targa, ts_transazione})
 * @param {Object[]} scontrini  [{ts, autore, mezzo, cantiere, note}]
 * @param {number} finestraMin
 * @param {Object[]=} flotta  lista {nome, dkv, alias:[]} (default FLOTTA_ del codice)
 * @return {{trovato:boolean, cantiere:?string, autore:?string}}
 */
function abbinaScontrino_(rec, scontrini, finestraMin, flotta) {
  var nessuno = { trovato: false, cantiere: null, autore: null };
  var targa = normId_(rec && rec.targa);
  var t0 = msValido_(rec && rec.ts_transazione);
  var fin = Number(finestraMin);
  if (!targa || t0 == null || !isFinite(fin) || fin < 0 || !Array.isArray(scontrini)) return nessuno;
  var aliases = aliasFlotta_(targa, flotta);   // DKV, targa reale, id GPS, nome: tutti i modi in cui lo scontrino può nominare il mezzo
  var best = null, bestD = Infinity;
  scontrini.forEach(function (s) {
    if (!s) return;
    var t = msValido_(s.ts);
    var mezzo = normId_(s.mezzo);
    if (t == null || !mezzo) return;
    var d = Math.abs(t - t0) / 60000;
    if (d > fin) return;
    if (!aliases.some(function (al) { return simile_(mezzo, al); })) return;
    if (d < bestD) { bestD = d; best = s; }
  });
  if (!best) return nessuno;
  return { trovato: true, cantiere: testo_(best.cantiere), autore: testo_(best.autore) };
}
/**
 * FUNZIONE PURA (testata): aggiunge/rimuove il motivo "senza scontrino" da motivi_sospetto (testo separato da "; ")
 * senza duplicati, e ricalcola `sospetta` (true se resta almeno un motivo).
 * @param {?string} motiviStr  motivi_sospetto attuale
 * @param {boolean} senzaScontrino  true = aggiungi il motivo, false = rimuovilo
 * @return {{sospetta:boolean, motivi_sospetto:?string}}
 */
function aggiornaMotivoScontrino_(motiviStr, senzaScontrino) {
  var l = String(motiviStr == null ? '' : motiviStr).split(';').map(function (x) { return x.trim(); })
    .filter(function (x) { return x && x !== MOTIVO_SENZA_SCONTRINO_; });
  if (senzaScontrino) l.push(MOTIVO_SENZA_SCONTRINO_);
  l = unici_(l);
  return { sospetta: l.length > 0, motivi_sospetto: l.length ? l.join('; ') : null };
}
// Legge da scontrini_telegram gli scontrini nella finestra +-SOGLIA_MINUTI_SCONTRINO attorno a ts_transazione.
// Gli errori PROPAGANO (il chiamante decide): un errore di lettura NON deve mai valere "senza scontrino".
function scontriniInFinestra_(cfg, rec) {
  var t = msValido_(rec.ts_transazione);
  if (t == null) return [];
  var w = num_(cfg.SOGLIA_MINUTI_SCONTRINO) * 60000;
  var q = '?select=ts,autore,mezzo,cantiere,note&ts=gte.' + encodeURIComponent(new Date(t - w).toISOString()) +
    '&ts=lte.' + encodeURIComponent(new Date(t + w).toISOString()) + '&limit=500';
  return supabaseTab_(cfg, TABELLA_SCONTRINI_, 'get', q).json || [];
}
// Ingest: se esiste già lo scontrino valorizza cantiere/scontrino_autore/scontrino_trovato sul record. Mai errori fatali.
function arricchisciConScontrino_(cfg, rec, flotta) {
  if (!rec.targa || !rec.ts_transazione) return rec;
  try {
    var m = abbinaScontrino_(rec, scontriniInFinestra_(cfg, rec), num_(cfg.SOGLIA_MINUTI_SCONTRINO), flotta);
    if (m.trovato) { rec.cantiere = m.cantiere; rec.scontrino_autore = m.autore; rec.scontrino_trovato = true; }
  } catch (err) {
    Logger.log('Scontrini non disponibili (si riprova in riconciliaScontrini): ' + sicuro_(err));
  }
  return rec;
}

/**
 * RICONCILIAZIONE (scrive, lato ingest, trigger ogni 2 ore). Per le righe DKV interpretate, senza scontrino abbinato e
 * più vecchie di SOGLIA_ORE_GRACE_SCONTRINO ore: riprova l'abbinamento.
 *  - trovato  -> PATCH scontrino_trovato=true, cantiere, scontrino_autore; toglie il motivo "senza scontrino" e ricalcola sospetta;
 *  - non trovato -> sospetta=true + motivo "senza scontrino" (una sola volta); scontrino_trovato resta false.
 * Idempotente (nessun PATCH se non cambia nulla), non cancella nulla. Le transazioni RIFIUTATE (DEC*) sono saltate:
 * non c'è stato rifornimento, quindi non può esserci scontrino. Se la lettura degli scontrini fallisce la riga è saltata
 * (mai "senza scontrino" per un errore di rete).
 */
function riconciliaScontrini(cfg) {
  cfg = cfg || config_();
  _flottaCache = null;
  var flotta = caricaFlotta_(cfg);
  var tot = { esaminate: 0, trovate: 0, senza_scontrino: 0, saltate: 0, errori: 0 };
  var limite = new Date(Date.now() - num_(cfg.SOGLIA_ORE_GRACE_SCONTRINO) * 3600000).toISOString();
  var righe = supabase_(cfg, 'get',
    '?select=authorization_id,targa,ts_transazione,esito,sospetta,motivi_sospetto&scontrino_trovato=eq.false&parsed=eq.true' +
    '&ts_transazione=lte.' + encodeURIComponent(limite) + '&order=ts_transazione.asc&limit=500').json || [];
  righe.forEach(function (r) {
    if (!r || !r.authorization_id) return;
    if (esitoDKV_(r.esito) === 'rifiutata') { tot.saltate++; return; }
    tot.esaminate++;
    try {
      var m = abbinaScontrino_(r, scontriniInFinestra_(cfg, r), num_(cfg.SOGLIA_MINUTI_SCONTRINO), flotta);
      var upd = aggiornaMotivoScontrino_(r.motivi_sospetto, !m.trovato);
      var patch = null;
      if (m.trovato) {
        patch = { scontrino_trovato: true, cantiere: m.cantiere, scontrino_autore: m.autore, sospetta: upd.sospetta, motivi_sospetto: upd.motivi_sospetto };
        tot.trovate++;
      } else {
        tot.senza_scontrino++;
        if (upd.motivi_sospetto !== (r.motivi_sospetto == null ? null : r.motivi_sospetto) || r.sospetta !== true) {
          patch = { sospetta: true, motivi_sospetto: upd.motivi_sospetto };
        }
      }
      if (patch) {
        supabase_(cfg, 'patch', '?authorization_id=eq.' + encodeURIComponent(String(r.authorization_id)), patch, { Prefer: 'return=minimal' });
      }
    } catch (err) {
      tot.errori++;
      Logger.log('Errore riconciliazione ' + r.authorization_id + ': ' + sicuro_(err));
    }
  });
  Logger.log('Riconciliazione scontrini: ' + JSON.stringify(tot));
  return tot;
}

// ---------- INGEST (scrittura) ----------
function processaGiornata() {
  var cfg = config_();
  _flottaCache = null;
  var flotta = caricaFlotta_(cfg);
  var lab = GmailApp.getUserLabelByName(cfg.LABEL_IN);
  if (!lab) { Logger.log('Label "' + cfg.LABEL_IN + '" non trovata: esegui setup().'); return { threads: 0, record: 0, errori: 0 }; }
  var done = GmailApp.getUserLabelByName(cfg.LABEL_DONE) || GmailApp.createLabel(cfg.LABEL_DONE);
  var threads = lab.getThreads(0, Math.max(1, Math.floor(num_(cfg.MAX_THREAD_PER_GIRO)) || 50));
  var tot = { threads: 0, record: 0, errori: 0 };

  threads.forEach(function (th) {
    try {
      var ids = [];
      th.getMessages().forEach(function (m) {
        // parseEmailDKV ritorna un ARRAY (una riga dati xlsx = una transazione)
        parseEmailDKV(m).forEach(function (rec, idx) {
          // Senza authorization_id: id sintetico stabile (messaggio + indice riga) per restare idempotenti
          if (!rec.authorization_id) rec.authorization_id = 'GMAIL-' + rec.gmail_message_id + '-' + idx;
          arricchisciConScontrino_(cfg, rec, flotta);   // solo arricchimento: NIENTE "senza scontrino" qui (vedi riconciliaScontrini)
          var v = valutaSospetti(rec, contesto_(cfg, rec), cfg);
          rec.sospetta = v.sospetta;
          rec.motivi_sospetto = v.motivi.length ? v.motivi.join('; ') : null;
          rec.stato = STATI_.NUOVA;
          upsert_(cfg, [rec]);
          ids.push(rec.authorization_id);
          tot.record++;
        });
      });
      // Solo dopo che TUTTE le righe del thread sono salvate: etichetta + archivia (mai cancellare/cestinare)
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
        q = '?select=authorization_id,ts_transazione&carta_last4=eq.' + encodeURIComponent(rec.carta_last4) +
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

// Upsert idempotente: una riga per authorization_id (merge-duplicates). gmail_message_id è solo un riferimento.
function upsert_(cfg, records) {
  records.forEach(function (r) { if (!r.authorization_id) throw new Error('authorization_id mancante'); });
  return supabase_(cfg, 'post', '?on_conflict=authorization_id', records, { Prefer: 'resolution=merge-duplicates,return=minimal' });
}
function aggiornaStato_(cfg, ids, stato) {
  ids = ids.filter(String);
  if (!ids.length) return;
  var lista = ids.map(function (i) { return '"' + String(i).replace(/"/g, '') + '"'; }).join(',');
  supabase_(cfg, 'patch', '?authorization_id=in.(' + encodeURIComponent(lista) + ')', { stato: stato }, { Prefer: 'return=minimal' });
}

// Chiamata REST a Supabase con service-role key su una tabella qualsiasi. Gli errori non contengono mai la chiave.
function supabaseTab_(cfg, tabella, metodo, query, payload, extra) {
  var key = cfg.SUPABASE_SERVICE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_KEY mancante nelle Script Properties');
  var headers = { apikey: key, Authorization: 'Bearer ' + key };
  if (payload !== undefined) headers['Content-Type'] = 'application/json';
  Object.keys(extra || {}).forEach(function (k) { headers[k] = extra[k]; });
  var opt = { method: metodo, headers: headers, muteHttpExceptions: true };
  if (payload !== undefined) opt.payload = JSON.stringify(payload);
  var res = UrlFetchApp.fetch(cfg.SUPABASE_URL + '/rest/v1/' + tabella + (query || ''), opt);
  var code = res.getResponseCode();
  var testo = res.getContentText() || '';
  if (code < 200 || code >= 300) throw new Error('Supabase HTTP ' + code + ': ' + testo.substring(0, 200).split(key).join('***'));
  var json = null;
  try { json = testo ? JSON.parse(testo) : null; } catch (e) { json = null; }
  return { code: code, json: json };
}
// Compatibilità: tabella principale dkv_autorizzazioni.
function supabase_(cfg, metodo, query, payload, extra) {
  return supabaseTab_(cfg, TABELLA_, metodo, query, payload, extra);
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
  var rif = righe.filter(function (r) { return esitoDKV_(r.esito) === 'rifiutata'; });   // restano comunque tra le sospette
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
  if (rif.length) {
    h += '<div style="border:1px solid #c60;padding:8px;margin:8px 0"><h3 style="color:#c60;margin:0 0 6px">Transazioni rifiutate (DEC)</h3><ul>';
    rif.forEach(function (r) {
      h += '<li>' + esc_([r.targa || ('carta ...' + (r.carta_last4 || '?')), r.ts_transazione || r.ricevuta_il, r.stazione, r.esito]
        .filter(function (x) { return x !== '' && x != null; }).join(' | ')) + '</li>';
    });
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
      '<tr><th>Ora</th><th>Carta</th><th>Targa</th><th>Cantiere</th><th>Stazione</th><th>Prodotto</th><th>EUR</th><th>Litri</th><th>Esito</th></tr>';
    righe.forEach(function (r) {
      var st = r.sospetta ? ' style="color:#c00"' : '';
      h += '<tr' + st + '><td>' + esc_(r.ts_transazione || r.ricevuta_il) + '</td><td>' + esc_(r.carta_last4) + '</td><td>' + esc_(r.targa) +
        '</td><td>' + esc_(r.cantiere) + '</td><td>' + esc_(r.stazione) + '</td><td>' + esc_(r.prodotto) + '</td><td>' + esc_(r.importo) + '</td><td>' + esc_(r.litri) +
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
    '  Da:      no-reply@my-mail.dkv-mobility.com',
    '  (oggetto tipico: DKV Analytics notification: New data available for your rule "rifornimento")',
    '  Azione:  Applica l\'etichetta "' + cfg.LABEL_IN + '"  (NON "Elimina")',
    'Per provare: applica la label a mano a una email DKV esistente con allegato xlsx.'
  ].join('\n'));
}

// Crea un nuovo Foglio Google "Flotta DKV 81|00" con intestazione nome|dkv|targa|gps|alias e una riga per ogni voce di FLOTTA_
// (gli alias noti vanno tutti nella colonna alias; targa/gps restano vuoti). Non cancella nulla: stampa l'id da incollare in FLOTTA_SHEET_ID.
function preparaFoglioFlotta() {
  var ss = SpreadsheetApp.create('Flotta DKV 81|00');
  var righe = [['nome', 'dkv', 'targa', 'gps', 'alias']];
  FLOTTA_.forEach(function (m) { righe.push([m.nome || '', m.dkv || '', '', '', (m.alias || []).join(', ')]); });
  ss.getSheets()[0].getRange(1, 1, righe.length, 5).setValues(righe);
  Logger.log('Foglio creato: ' + ss.getUrl() + '\nIncolla questo id nella Script Property FLOTTA_SHEET_ID: ' + ss.getId());
  return ss.getId();
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

// Chiede su Telegram il cantiere dei rifornimenti DKV ancora orfani: chiama la Edge Function telegram-bot (?dkv-ask).
// Autenticazione con la service-role key (la funzione verifica Authorization: Bearer <service-role>). Nessun segreto nel codice.
function chiediCantieriMancanti() {
  var cfg = config_();
  try {
    var res = UrlFetchApp.fetch(cfg.SUPABASE_URL + '/functions/v1/telegram-bot?dkv-ask', {
      method: 'post', muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + cfg.SUPABASE_SERVICE_KEY }
    });
    Logger.log('Richiesta cantieri Telegram: HTTP ' + res.getResponseCode() + ' ' + String(res.getContentText() || '').substring(0, 200));
  } catch (err) { Logger.log('chiediCantieriMancanti KO: ' + sicuro_(err)); }
}

// Installa i trigger temporali (rimuove prima i vecchi trigger di queste funzioni).
function creaTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var f = t.getHandlerFunction();
    if (f === 'processaGiornata' || f === 'reportSerale' || f === 'riconciliaScontrini' || f === 'chiediCantieriMancanti') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('processaGiornata').timeBased().everyMinutes(30).create();
  ScriptApp.newTrigger('reportSerale').timeBased().atHour(21).everyDays(1).inTimezone(DEFAULTS_.TIMEZONE).create();
  // Ogni 2 ore: con grace 24h basta; così "senza scontrino" è già scritto quando parte il report delle 21:00.
  ScriptApp.newTrigger('riconciliaScontrini').timeBased().everyHours(2).create();
  // La sera (ore 20): chiede su Telegram il cantiere dei rifornimenti ancora orfani (prima del report delle 21).
  ScriptApp.newTrigger('chiediCantieriMancanti').timeBased().atHour(20).everyDays(1).inTimezone(DEFAULTS_.TIMEZONE).create();
  Logger.log('Trigger creati: processaGiornata ogni 30 min; riconciliaScontrini ogni 2 ore; chiediCantieriMancanti ore 20; reportSerale ore 21 (Europe/Rome).');
}
