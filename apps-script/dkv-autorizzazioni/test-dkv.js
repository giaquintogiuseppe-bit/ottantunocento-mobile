const fs = require('fs'), vm = require('vm'), assert = require('assert');
const src = fs.readFileSync(process.argv[2] || __dirname + '/dkv-autorizzazioni.gs', 'utf8');

const props = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_KEY: 'CHIAVE-SEGRETA', SOGLIA_IMPORTO_MAX: '300', SOGLIA_LITRI_MAX: '120' };
const fetches = [], sentMails = [];
let db = [];                                   // finto DB con semantica merge-duplicates
const ctx = {
  console, JSON, String, Number, Array, Math, Error, Object, Date, isFinite,
  PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null) }) },
  Logger: { log: () => {} },
  Utilities: { formatDate: (d, tz, f) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: 'numeric', hour12: false, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(d).map((x) => [x.type, x.value]));
    if (f === 'H') return String(Number(p.hour) % 24);
    if (f === 'u') return String({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[p.weekday]);
    if (f === 'XXX') return '+01:00';
    return `${p.year}-${p.month}-${p.day}`;
  } },
  UrlFetchApp: { fetch: (url, o) => {
    fetches.push({ url, o });
    if (o.method === 'post') {
      JSON.parse(o.payload).forEach((r) => { const i = db.findIndex((x) => x.authorization_id === r.authorization_id); if (i >= 0) db[i] = { ...db[i], ...r }; else db.push({ ...r }); });
      return { getResponseCode: () => 201, getContentText: () => '' };
    }
    return { getResponseCode: () => 200, getContentText: () => '[]' };
  } },
  GmailApp: { sendEmail: (to, s, b, opt) => sentMails.push({ to, s, b, opt }) },
};
vm.createContext(ctx); vm.runInContext(src, ctx);
const cfg = ctx.config_();

// (a) mappaRigaDKV_ (pura) sul campione reale
const riga = { 'Licence plate': 'G86499N', 'Authorization Time': '18.11.2026 - 09:50', Sales: '33.51', 'Cost group': 'Costi del carburante',
  'Product group': 'Benzina', Product: 'Benzina - RON 95', 'Product code': 'WA0036', 'Authorization Amount Gross': '70.00 EUR',
  'Service country': 'IT', Mileage: '176387', 'Customer number': '4301665111', 'Number of card or box': '7043100113582313',
  'Cost center': '', 'Card addition': '', Response: 'APP_LIM20_APPR', 'Station number': 'SS1401934', 'Station name': 'TOIL Station',
  Town: 'Caserta', 'Station category': 'Any', Unit: 'L', 'Authorization ID': '010000000413644615' };
const rec = ctx.mappaRigaDKV_(riga);
assert.strictEqual(rec.authorization_id, '010000000413644615');
assert.strictEqual(rec.targa, 'G86499N');
assert.strictEqual(rec.ts_transazione, '2026-11-18T09:50:00+01:00');
assert.strictEqual(new Date(rec.ts_transazione).toISOString(), '2026-11-18T08:50:00.000Z');
assert.strictEqual(rec.litri, 33.51); assert.strictEqual(rec.importo, 70.00);
assert.strictEqual(rec.prodotto, 'Verde'); assert.strictEqual(rec.carta_last4, '2313');
assert.strictEqual(rec.stazione, 'TOIL Station'); assert.strictEqual(rec.esito, 'APP_LIM20_APPR');
assert.strictEqual(ctx.esitoDKV_(rec.esito), 'approvata'); assert.strictEqual(ctx.esitoDKV_('DEC_PIN'), 'rifiutata');
assert.strictEqual(rec.product_code, 'WA0036'); assert.strictEqual(rec.km, 176387); assert.strictEqual(rec.citta, 'Caserta');
assert.strictEqual(rec.station_number, 'SS1401934'); assert.strictEqual(rec.customer_number, '4301665111');
assert.strictEqual(rec.parsed, true);
// prodotti, numeri con virgola, intestazioni "contiene" case-insensitive, parsed=false senza id/ts
assert.strictEqual(ctx.mappaRigaDKV_({ ...riga, Product: 'Diesel', 'Product group': 'Gasolio' }).prodotto, 'Diesel');
assert.strictEqual(ctx.mappaRigaDKV_({ ...riga, Product: 'GPL auto', 'Product group': 'Gas auto' }).prodotto, 'GPL');
assert.strictEqual(ctx.mappaRigaDKV_({ ...riga, Product: 'AdBlue sfuso', 'Product group': 'Additivi' }).prodotto, 'AdBlue');
assert.strictEqual(ctx.mappaRigaDKV_({ ...riga, Product: 'Lavaggio', 'Product group': 'Servizi' }).prodotto, 'Lavaggio');
const r2 = ctx.mappaRigaDKV_({ 'LICENCE PLATE (x)': 'AB123CD', 'authorization id': '77', 'Authorization Time': '18.11.2026 - 09:50', sales: '33,5' });
assert.strictEqual(r2.targa, 'AB123CD'); assert.strictEqual(r2.litri, 33.5); assert.strictEqual(r2.parsed, true);
assert.strictEqual(ctx.mappaRigaDKV_({ ...riga, 'Authorization ID': '' }).parsed, false);
assert.strictEqual(ctx.mappaRigaDKV_({ ...riga, 'Authorization Time': 'boh' }).parsed, false);
assert.doesNotThrow(() => ctx.mappaRigaDKV_({})); assert.doesNotThrow(() => ctx.mappaRigaDKV_(null));
assert.deepStrictEqual(Object.keys(ctx.mappaRigaDKV_({})), Object.keys(rec).filter((k) => k in ctx.recordVuoto_()));

// (b) valutaSospetti
const base = { authorization_id: 'g2', parsed: true, carta_last4: '0322', stazione: 'Eni A', importo: 100, litri: 60, ts_transazione: '2026-11-17T10:00:00+01:00' }; // martedì 10:00
let v = ctx.valutaSospetti(base, { altre: [], stazioniNote: ['Eni A', 'B', 'C', 'D', 'E'] }, cfg);
assert.strictEqual(v.sospetta, false); assert.strictEqual(v.motivi.length, 0); assert.strictEqual(v.da_verificare, false);
v = ctx.valutaSospetti({ ...base, importo: 301 }, {}, cfg); assert.ok(v.sospetta && /importo/.test(v.motivi[0]));
v = ctx.valutaSospetti({ ...base, importo: 300 }, {}, cfg); assert.strictEqual(v.sospetta, false);
v = ctx.valutaSospetti({ ...base, litri: 121 }, {}, cfg); assert.ok(v.sospetta && /litri/.test(v.motivi[0]));
v = ctx.valutaSospetti({ ...base, litri: 120 }, {}, cfg); assert.strictEqual(v.sospetta, false);
v = ctx.valutaSospetti({ ...base, ts_transazione: '2026-11-17T23:30:00+01:00' }, {}, cfg); assert.ok(v.sospetta && /fuori orario/.test(v.motivi[0]));
v = ctx.valutaSospetti({ ...base, ts_transazione: '2026-11-22T10:00:00+01:00' }, {}, cfg); assert.ok(v.sospetta && /non lavorativo/.test(v.motivi[0])); // domenica
v = ctx.valutaSospetti(base, { altre: [{ authorization_id: 'x', ts_transazione: '2026-11-17T09:45:00+01:00' }] }, cfg); assert.ok(v.sospetta && /entro 30 min/.test(v.motivi[0]));
v = ctx.valutaSospetti(base, { altre: [{ authorization_id: 'x', ts_transazione: '2026-11-17T08:00:00+01:00' }] }, cfg); assert.strictEqual(v.sospetta, false);
v = ctx.valutaSospetti(base, { stazioniNote: ['B', 'C', 'D', 'E', 'F'] }, cfg); assert.ok(v.sospetta && /stazione mai vista/.test(v.motivi[0]));
v = ctx.valutaSospetti(base, { stazioniNote: ['B'] }, cfg); assert.strictEqual(v.sospetta, false); // storico troppo corto
// soglia disattivata (0) => nessun allarme
v = ctx.valutaSospetti({ ...base, litri: 9999 }, {}, { ...cfg, SOGLIA_LITRI_MAX: '0' }); assert.strictEqual(v.sospetta, false);
// null: non esplode, non sospetta ma da_verificare
const vuoto = ctx.mappaRigaDKV_({});
v = ctx.valutaSospetti(vuoto, {}, cfg); assert.strictEqual(v.sospetta, false); assert.strictEqual(v.da_verificare, true);
v = ctx.valutaSospetti({ ...base, esito: 'DEC_PIN_ERR' }, {}, cfg); assert.ok(v.sospetta && /rifiutata/.test(v.motivi[0]));
v = ctx.valutaSospetti({ ...base, esito: 'APP_LIM20_APPR' }, {}, cfg); assert.strictEqual(v.sospetta, false);
v = ctx.valutaSospetti(rec, {}, cfg); assert.strictEqual(v.sospetta, false); // campione reale, mercoledì 09:50, 70 EUR
assert.doesNotThrow(() => ctx.valutaSospetti(null)); assert.doesNotThrow(() => ctx.valutaSospetti({}, null, cfg));

// (c) upsert: on_conflict=authorization_id, idempotente, chiave negli header e mai nel testo errori
const recDb = { ...rec, gmail_message_id: 'g1', sospetta: false, stato: 'nuova' };
ctx.upsert_(cfg, [recDb]);
ctx.upsert_(cfg, [recDb]);
assert.strictEqual(db.length, 1);
const f = fetches.filter((x) => x.o.method === 'post')[0];
assert.match(f.url, /\/rest\/v1\/dkv_autorizzazioni\?on_conflict=authorization_id$/);
assert.strictEqual(f.o.headers.Prefer, 'resolution=merge-duplicates,return=minimal');
assert.strictEqual(f.o.headers.apikey, 'CHIAVE-SEGRETA'); assert.strictEqual(f.o.headers.Authorization, 'Bearer CHIAVE-SEGRETA');
assert.strictEqual(JSON.parse(f.o.payload)[0].authorization_id, '010000000413644615');
assert.throws(() => ctx.upsert_(cfg, [{ raw_subject: 'senza id' }]), /authorization_id/);
ctx.UrlFetchApp.fetch = () => ({ getResponseCode: () => 401, getContentText: () => 'bad key CHIAVE-SEGRETA' });
try { ctx.upsert_(cfg, [recDb]); assert.fail('doveva lanciare'); } catch (e) { assert.ok(!/CHIAVE-SEGRETA/.test(e.message), 'chiave nell\'errore'); }

// ingest end-to-end (xlsx stubbato: 2 righe in un messaggio + 1 messaggio senza allegati): archivia, non cestina
const calls = [];
const lab = (n) => ({ n, getThreads: () => [thread] });
const msg = (id, sub) => ({ getId: () => id, getSubject: () => sub, getPlainBody: () => 'corpo', getDate: () => new Date('2026-11-18T08:00:00Z'), getFrom: () => 'dkv' });
const thread = { getMessages: () => [msg('m1', 'S1'), msg('m2', 'S2')],
  addLabel: (l) => calls.push('add:' + l.n), removeLabel: (l) => calls.push('rem:' + l.n), moveToArchive: () => calls.push('archive'),
  moveToTrash: () => calls.push('TRASH') };
ctx.leggiAllegatiXlsx_ = (m) => (m.getId() === 'm1' ? [{ file: 'r.xlsx', righe: [riga, { ...riga, 'Authorization ID': '010000000413644616', 'Authorization Time': '18.11.2026 - 22:10' }] }] : []);
ctx.GmailApp.getUserLabelByName = (n) => (n === 'DKV/da-processare' ? lab(n) : { n });
ctx.UrlFetchApp.fetch = (url, o) => { fetches.push({ url, o }); if (o.method === 'post') { JSON.parse(o.payload).forEach((r) => db.push(r)); } return { getResponseCode: () => 200, getContentText: () => '[]' }; };
db = []; fetches.length = 0;
const tot = ctx.processaGiornata();
assert.strictEqual(tot.threads, 1); assert.strictEqual(tot.record, 3); assert.strictEqual(tot.errori, 0);
assert.deepStrictEqual([...calls], ['add:DKV/processata', 'rem:DKV/da-processare', 'archive']);
assert.strictEqual(db.length, 3);
assert.strictEqual(db[0].authorization_id, '010000000413644615'); assert.strictEqual(db[0].gmail_message_id, 'm1'); assert.strictEqual(db[0].parsed, true);
assert.strictEqual(db[1].sospetta, true); assert.ok(/fuori orario/.test(db[1].motivi_sospetto)); // 22:10
assert.strictEqual(db[2].authorization_id, 'GMAIL-m2-0'); assert.strictEqual(db[2].parsed, false); assert.strictEqual(db[2].sospetta, false);
assert.ok(fetches.filter((x) => x.o.method === 'post').every((x) => /on_conflict=authorization_id$/.test(x.url)));
const patch = fetches.filter((x) => x.o.method === 'patch').pop();
assert.match(patch.url, /\?authorization_id=in\./); assert.strictEqual(JSON.parse(patch.o.payload).stato, 'archiviata_gmail');
// errore di lettura xlsx: il thread NON viene archiviato e verrà ritentato
calls.length = 0;
ctx.leggiAllegatiXlsx_ = () => { throw new Error('Drive KO'); };
const tot2 = ctx.processaGiornata();
assert.strictEqual(tot2.errori, 1); assert.strictEqual(tot2.threads, 0); assert.deepStrictEqual([...calls], []);

// (d) abbinaScontrino_ (pura) + helper motivi "senza scontrino"
{
  const r0 = { targa: 'FS504WE', ts_transazione: '2026-11-18T09:50:00+01:00' };   // = 08:50Z
  const sc = (ts, mezzo, cantiere, autore) => ({ ts, mezzo, cantiere, autore, note: '' });
  let a = ctx.abbinaScontrino_(r0, [sc('2026-11-18T08:30:00Z', 'fs 504-we', 'Cantiere Rossi', 'Mario')], 45);
  assert.deepStrictEqual({ ...a }, { trovato: true, cantiere: 'Cantiere Rossi', autore: 'Mario' });          // targa uguale (normalizzata), 20 min
  a = ctx.abbinaScontrino_(r0, [sc('2026-11-18T07:50:00Z', 'FS504WE', 'X', 'Y')], 45); assert.strictEqual(a.trovato, false); assert.strictEqual(a.cantiere, null); // 60 min: fuori finestra
  a = ctx.abbinaScontrino_(r0, [sc('2026-11-18T08:50:00Z', 'GM972CF', 'X', 'Y')], 45); assert.strictEqual(a.trovato, false);  // altro mezzo
  a = ctx.abbinaScontrino_(r0, [sc('2026-11-18T08:50:00Z', 'furgone FS504WE', 'Bianchi', 'Lia')], 45); assert.strictEqual(a.trovato, true); // contiene
  const r1 = { targa: 'GM972CF', ts_transazione: '2026-11-18T09:50:00+01:00' };
  a = ctx.abbinaScontrino_(r1, [sc('2026-11-18T08:45:00Z', 'Pramac 2', 'Verdi', 'Gigi')], 45); assert.strictEqual(a.trovato, true); assert.strictEqual(a.cantiere, 'Verdi'); // nome via mappa flotta
  a = ctx.abbinaScontrino_({ targa: 'FX943SG', ts_transazione: '2026-11-18T09:50:00+01:00' }, [sc('2026-11-18T08:50:00Z', 'Clio', 'Neri', 'Pia')], 45); assert.strictEqual(a.trovato, true);
  a = ctx.abbinaScontrino_(r1, [sc('2026-11-18T08:20:00Z', 'GM972CF', 'Lontano', 'A'), sc('2026-11-18T08:48:00Z', 'GM972CF', 'Vicino', 'B')], 45); assert.strictEqual(a.cantiere, 'Vicino'); // il più vicino
  a = ctx.abbinaScontrino_(r1, [sc('2026-11-18T08:50:00Z', 'Pramac 2', '  ', 'B')], 45); assert.strictEqual(a.trovato, true); assert.strictEqual(a.cantiere, null);
  // null-safe
  [[null, []], [{}, []], [r1, null], [r1, undefined], [r1, [null, {}, { ts: 'boh', mezzo: 'GM972CF' }, { ts: '2026-11-18T08:50:00Z' }]],
    [{ targa: 'GM972CF', ts_transazione: 'boh' }, [sc('2026-11-18T08:50:00Z', 'GM972CF', 'X', 'Y')]], [{ ts_transazione: '2026-11-18T08:50:00Z' }, [sc('2026-11-18T08:50:00Z', '', 'X', 'Y')]]]
    .forEach(([rr, ss]) => { assert.doesNotThrow(() => ctx.abbinaScontrino_(rr, ss, 45)); assert.strictEqual(ctx.abbinaScontrino_(rr, ss, 45).trovato, false); });
  assert.strictEqual(ctx.abbinaScontrino_(r1, [], 45).trovato, false);
  // helper motivi: aggiunge una volta sola, rimuove, ricalcola sospetta
  const M = ctx.MOTIVO_SENZA_SCONTRINO_;
  let h = ctx.aggiornaMotivoScontrino_(null, true); assert.deepStrictEqual({ ...h }, { sospetta: true, motivi_sospetto: M });
  h = ctx.aggiornaMotivoScontrino_(h.motivi_sospetto, true); assert.strictEqual(h.motivi_sospetto, M);                                  // niente doppioni
  h = ctx.aggiornaMotivoScontrino_('importo 400 oltre il massimo 300', true); assert.strictEqual(h.motivi_sospetto, 'importo 400 oltre il massimo 300; ' + M);
  h = ctx.aggiornaMotivoScontrino_(h.motivi_sospetto, true); assert.strictEqual(h.motivi_sospetto.split(M).length, 2);
  h = ctx.aggiornaMotivoScontrino_(h.motivi_sospetto, false); assert.deepStrictEqual({ ...h }, { sospetta: true, motivi_sospetto: 'importo 400 oltre il massimo 300' }); // resta sospetta per altro
  h = ctx.aggiornaMotivoScontrino_(M, false); assert.deepStrictEqual({ ...h }, { sospetta: false, motivi_sospetto: null });
  h = ctx.aggiornaMotivoScontrino_(null, false); assert.deepStrictEqual({ ...h }, { sospetta: false, motivi_sospetto: null });
}

// (e) supabaseTab_ su altra tabella + riconciliaScontrini (grace, idempotenza, scrittura solo PATCH)
{
  const log = []; let dkvRows = []; let scontrini = []; let scFail = false;
  ctx.UrlFetchApp.fetch = (url, o) => {
    log.push({ url, o });
    if (/\/scontrini_telegram\?/.test(url)) { if (scFail) return { getResponseCode: () => 500, getContentText: () => 'KO CHIAVE-SEGRETA' }; return { getResponseCode: () => 200, getContentText: () => JSON.stringify(scontrini) }; }
    if (o.method === 'get') return { getResponseCode: () => 200, getContentText: () => JSON.stringify(dkvRows) };
    return { getResponseCode: () => 204, getContentText: () => '' };
  };
  ctx.supabaseTab_(cfg, 'scontrini_telegram', 'get', '?select=ts');
  assert.match(log[0].url, /\/rest\/v1\/scontrini_telegram\?select=ts$/); assert.strictEqual(log[0].o.headers.apikey, 'CHIAVE-SEGRETA');
  ctx.supabase_(cfg, 'get', '?select=id'); assert.match(log[1].url, /\/rest\/v1\/dkv_autorizzazioni\?select=id$/);

  const ts = new Date(Date.now() - 48 * 3600000).toISOString();
  dkvRows = [
    { authorization_id: 'A1', targa: 'FS504WE', ts_transazione: ts, esito: 'APP_X', sospetta: false, motivi_sospetto: null },            // senza scontrino -> flag
    { authorization_id: 'A2', targa: 'FS504WE', ts_transazione: ts, esito: 'APP_X', sospetta: true, motivi_sospetto: ctx.MOTIVO_SENZA_SCONTRINO_ }, // già flaggata, ora trovato
    { authorization_id: 'A3', targa: 'FS504WE', ts_transazione: ts, esito: 'DEC_PIN', sospetta: true, motivi_sospetto: 'x' },             // rifiutata: saltata
    { authorization_id: 'A4', targa: 'FS504WE', ts_transazione: ts, esito: 'APP_X', sospetta: true, motivi_sospetto: ctx.MOTIVO_SENZA_SCONTRINO_ } // già flaggata, ancora senza: nessun PATCH
  ];
  scontrini = [];
  log.length = 0;
  let t = ctx.riconciliaScontrini(cfg);
  assert.deepStrictEqual({ ...t }, { esaminate: 3, trovate: 0, senza_scontrino: 3, saltate: 1, errori: 0 });
  const q = log[0].url; assert.match(q, /scontrino_trovato=eq\.false/); assert.match(q, /parsed=eq\.true/); assert.match(q, /ts_transazione=lte\./);
  const patches = log.filter((x) => x.o.method === 'patch');
  assert.strictEqual(patches.length, 1); assert.match(patches[0].url, /authorization_id=eq\.A1$/);                      // solo A1: A2/A4 già segnalate (idempotente)
  assert.deepStrictEqual({ ...JSON.parse(patches[0].o.payload) }, { sospetta: true, motivi_sospetto: ctx.MOTIVO_SENZA_SCONTRINO_ });
  assert.ok(log.every((x) => x.o.method === 'get' || x.o.method === 'patch'));                                          // niente POST/DELETE
  // ora arriva lo scontrino: A1 e A2 trovate, motivo tolto, sospetta ricalcolata
  scontrini = [{ ts, mezzo: 'FS504WE', cantiere: 'Rossi', autore: 'Mario' }];
  log.length = 0; t = ctx.riconciliaScontrini(cfg);
  assert.strictEqual(t.trovate, 3);
  const p2 = log.filter((x) => x.o.method === 'patch').map((x) => JSON.parse(x.o.payload));
  assert.strictEqual(p2.length, 3); assert.strictEqual(p2[0].scontrino_trovato, true); assert.strictEqual(p2[0].cantiere, 'Rossi');
  assert.deepStrictEqual({ sospetta: p2[1].sospetta, m: p2[1].motivi_sospetto }, { sospetta: false, m: null });         // A2: motivo rimosso
  // errore di lettura scontrini: riga saltata, nessun PATCH, nessuna chiave nei log/errori
  scFail = true; log.length = 0; t = ctx.riconciliaScontrini(cfg);
  assert.strictEqual(t.errori, 3); assert.strictEqual(log.filter((x) => x.o.method === 'patch').length, 0);
}

// report: sola lettura (solo GET), mail senza chiave, sospette in rosso
fetches.length = 0;
ctx.UrlFetchApp.fetch = (url, o) => { fetches.push({ url, o }); return { getResponseCode: () => 200, getContentText: () => JSON.stringify([
  { gmail_message_id: 'a', parsed: true, sospetta: true, motivi_sospetto: 'importo 400 oltre <max>', importo: 400, targa: 'GM972CF', ricevuta_il: '2026-11-17T10:00:00Z' },
  { gmail_message_id: 'b', parsed: false, raw_subject: 'non letta', ricevuta_il: '2026-11-17T11:00:00Z' }]) }; };
const out = ctx.reportSerale();
assert.deepStrictEqual(fetches.map((x) => x.o.method), ['get']); assert.strictEqual(out.transazioni, 2); assert.strictEqual(out.sospette, 1);
const m = sentMails[0]; assert.strictEqual(m.to, 'giaquinto.giuseppe@gmail.com');
assert.ok(m.opt.htmlBody.indexOf('ANOMALIE SOSPETTE') < m.opt.htmlBody.indexOf('Elenco del giorno'));
assert.ok(m.opt.htmlBody.includes('<th>Cantiere</th>')); assert.ok(m.opt.htmlBody.includes('&lt;max&gt;')); assert.ok(!JSON.stringify(m).includes('CHIAVE-SEGRETA'));
console.log('OK: tutti i test DKV passano');
