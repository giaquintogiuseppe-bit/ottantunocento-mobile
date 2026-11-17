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
      JSON.parse(o.payload).forEach((r) => { const i = db.findIndex((x) => x.gmail_message_id === r.gmail_message_id); if (i >= 0) db[i] = { ...db[i], ...r }; else db.push({ ...r }); });
      return { getResponseCode: () => 201, getContentText: () => '' };
    }
    return { getResponseCode: () => 200, getContentText: () => '[]' };
  } },
  GmailApp: { sendEmail: (to, s, b, opt) => sentMails.push({ to, s, b, opt }) },
};
vm.createContext(ctx); vm.runInContext(src, ctx);
const cfg = ctx.config_();

// (a) parseEmailDKV: placeholder, parsed=false, campi grezzi
const rec = ctx.parseEmailDKV('Autorizzazioni LIVE', 'corpo grezzo', { gmail_message_id: 'g1', ricevuta_il: '2026-11-17T09:00:00.000Z' });
assert.strictEqual(rec.parsed, false);
assert.strictEqual(rec.raw_subject, 'Autorizzazioni LIVE'); assert.strictEqual(rec.raw_body, 'corpo grezzo');
assert.strictEqual(rec.gmail_message_id, 'g1'); assert.strictEqual(rec.ricevuta_il, '2026-11-17T09:00:00.000Z');
['importo', 'litri', 'carta_last4', 'stazione', 'ts_transazione'].forEach((k) => assert.strictEqual(rec[k], null));
assert.doesNotThrow(() => ctx.parseEmailDKV(null, undefined, undefined));

// (b) valutaSospetti
const base = { gmail_message_id: 'g2', parsed: true, carta_last4: '0322', stazione: 'Eni A', importo: 100, litri: 60, ts_transazione: '2026-11-17T10:00:00+01:00' }; // martedì 10:00
let v = ctx.valutaSospetti(base, { altre: [], stazioniNote: ['Eni A', 'B', 'C', 'D', 'E'] }, cfg);
assert.strictEqual(v.sospetta, false); assert.strictEqual(v.motivi.length, 0); assert.strictEqual(v.da_verificare, false);
v = ctx.valutaSospetti({ ...base, importo: 301 }, {}, cfg); assert.ok(v.sospetta && /importo/.test(v.motivi[0]));
v = ctx.valutaSospetti({ ...base, importo: 300 }, {}, cfg); assert.strictEqual(v.sospetta, false);
v = ctx.valutaSospetti({ ...base, litri: 121 }, {}, cfg); assert.ok(v.sospetta && /litri/.test(v.motivi[0]));
v = ctx.valutaSospetti({ ...base, litri: 120 }, {}, cfg); assert.strictEqual(v.sospetta, false);
v = ctx.valutaSospetti({ ...base, ts_transazione: '2026-11-17T23:30:00+01:00' }, {}, cfg); assert.ok(v.sospetta && /fuori orario/.test(v.motivi[0]));
v = ctx.valutaSospetti({ ...base, ts_transazione: '2026-11-22T10:00:00+01:00' }, {}, cfg); assert.ok(v.sospetta && /non lavorativo/.test(v.motivi[0])); // domenica
v = ctx.valutaSospetti(base, { altre: [{ gmail_message_id: 'x', ts_transazione: '2026-11-17T09:45:00+01:00' }] }, cfg); assert.ok(v.sospetta && /entro 30 min/.test(v.motivi[0]));
v = ctx.valutaSospetti(base, { altre: [{ gmail_message_id: 'x', ts_transazione: '2026-11-17T08:00:00+01:00' }] }, cfg); assert.strictEqual(v.sospetta, false);
v = ctx.valutaSospetti(base, { stazioniNote: ['B', 'C', 'D', 'E', 'F'] }, cfg); assert.ok(v.sospetta && /stazione mai vista/.test(v.motivi[0]));
v = ctx.valutaSospetti(base, { stazioniNote: ['B'] }, cfg); assert.strictEqual(v.sospetta, false); // storico troppo corto
// soglia disattivata (0) => nessun allarme
v = ctx.valutaSospetti({ ...base, litri: 9999 }, {}, { ...cfg, SOGLIA_LITRI_MAX: '0' }); assert.strictEqual(v.sospetta, false);
// null: non esplode, non sospetta ma da_verificare
v = ctx.valutaSospetti(rec, {}, cfg); assert.strictEqual(v.sospetta, false); assert.strictEqual(v.da_verificare, true);
assert.doesNotThrow(() => ctx.valutaSospetti(null)); assert.doesNotThrow(() => ctx.valutaSospetti({}, null, cfg));

// (c) upsert: payload con gmail_message_id, idempotente, chiave negli header e mai nel testo errori
ctx.upsert_(cfg, [{ ...rec, sospetta: false, stato: 'nuova' }]);
ctx.upsert_(cfg, [{ ...rec, sospetta: false, stato: 'nuova' }]);
assert.strictEqual(db.length, 1);
const f = fetches.filter((x) => x.o.method === 'post')[0];
assert.match(f.url, /\/rest\/v1\/dkv_autorizzazioni\?on_conflict=gmail_message_id$/);
assert.strictEqual(f.o.headers.Prefer, 'resolution=merge-duplicates,return=minimal');
assert.strictEqual(f.o.headers.apikey, 'CHIAVE-SEGRETA'); assert.strictEqual(f.o.headers.Authorization, 'Bearer CHIAVE-SEGRETA');
assert.strictEqual(JSON.parse(f.o.payload)[0].gmail_message_id, 'g1');
assert.throws(() => ctx.upsert_(cfg, [{ raw_subject: 'senza id' }]), /gmail_message_id/);
ctx.UrlFetchApp.fetch = () => ({ getResponseCode: () => 401, getContentText: () => 'bad key CHIAVE-SEGRETA' });
try { ctx.upsert_(cfg, [rec]); assert.fail('doveva lanciare'); } catch (e) { assert.ok(!/CHIAVE-SEGRETA/.test(e.message), 'chiave nell\'errore'); }

// ingest end-to-end: archivia, non cestina, solo label+archivio
const calls = [];
const lab = (n) => ({ n, getThreads: () => [thread] });
const thread = { getMessages: () => [{ getId: () => 'm9', getSubject: () => 'S', getPlainBody: () => 'B', getDate: () => new Date('2026-11-17T09:00:00Z'), getFrom: () => 'dkv' }],
  addLabel: (l) => calls.push('add:' + l.n), removeLabel: (l) => calls.push('rem:' + l.n), moveToArchive: () => calls.push('archive'),
  moveToTrash: () => calls.push('TRASH') };
ctx.GmailApp.getUserLabelByName = (n) => (n === 'DKV/da-processare' ? lab(n) : { n });
ctx.UrlFetchApp.fetch = (url, o) => { fetches.push({ url, o }); if (o.method === 'post') { JSON.parse(o.payload).forEach((r) => db.push(r)); } return { getResponseCode: () => 200, getContentText: () => '[]' }; };
db = [];
const tot = ctx.processaGiornata();
assert.strictEqual(tot.threads, 1); assert.deepStrictEqual([...calls], ['add:DKV/processata', 'rem:DKV/da-processare', 'archive']);
assert.strictEqual(db[0].gmail_message_id, 'm9'); assert.strictEqual(db[0].parsed, false); assert.strictEqual(db[0].sospetta, false);
const patch = fetches.filter((x) => x.o.method === 'patch').pop();
assert.strictEqual(JSON.parse(patch.o.payload).stato, 'archiviata_gmail');

// report: sola lettura (solo GET), mail senza chiave, sospette in rosso
fetches.length = 0;
ctx.UrlFetchApp.fetch = (url, o) => { fetches.push({ url, o }); return { getResponseCode: () => 200, getContentText: () => JSON.stringify([
  { gmail_message_id: 'a', parsed: true, sospetta: true, motivi_sospetto: 'importo 400 oltre <max>', importo: 400, targa: 'GM972CF', ricevuta_il: '2026-11-17T10:00:00Z' },
  { gmail_message_id: 'b', parsed: false, raw_subject: 'non letta', ricevuta_il: '2026-11-17T11:00:00Z' }]) }; };
const out = ctx.reportSerale();
assert.deepStrictEqual(fetches.map((x) => x.o.method), ['get']); assert.strictEqual(out.transazioni, 2); assert.strictEqual(out.sospette, 1);
const m = sentMails[0]; assert.strictEqual(m.to, 'giaquinto.giuseppe@gmail.com');
assert.ok(m.opt.htmlBody.indexOf('ANOMALIE SOSPETTE') < m.opt.htmlBody.indexOf('Elenco del giorno'));
assert.ok(m.opt.htmlBody.includes('&lt;max&gt;')); assert.ok(!JSON.stringify(m).includes('CHIAVE-SEGRETA'));
console.log('OK: tutti i test DKV passano');
