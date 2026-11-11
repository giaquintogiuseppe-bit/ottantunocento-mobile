const fs = require('fs'), vm = require('vm'), assert = require('assert');
const src = fs.readFileSync(process.argv[2] || __dirname + '/mailer-preventivi.gs', 'utf8');
const created = [], sent = [];
const msg = (from, to, cc, subj, extra = {}) => ({
  getFrom: () => from, getTo: () => to, getCc: () => cc, getReplyTo: () => extra.replyTo || '', getSubject: () => subj,
  isDraft: () => !!extra.draft, getHeader: (h) => ({ 'Message-ID': extra.mid || '<m1@x>', References: extra.refs || '' })[h] || '',
});
const threads = {
  T1: [msg('Mario Rossi <mario@cliente.it>', 'Giuseppe <giaquinto.giuseppe@gmail.com>, anna@cliente.it', 'boss@cliente.it', 'Richiesta preventivo palco', { mid: '<a@c>' }),
       msg('Giuseppe <giaquinto.giuseppe@gmail.com>', 'mario@cliente.it', '', 'Re: Richiesta preventivo palco', { mid: '<b@g>', refs: '<a@c>' })],
  T2: [msg('giaquinto.giuseppe@gmail.com', '"Rossi, Mario" <mario@cliente.it>', 'x@y.it', 'Offerta')],
};
const ctx = {
  console, JSON, String, Array, Math, Error,
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => 'SEGRETO' }) },
  ContentService: { MimeType: { JSON: 'j' }, createTextOutput: (s) => ({ setMimeType: () => JSON.parse(s) }) },
  Session: { getEffectiveUser: () => ({ getEmail: () => 'giaquinto.giuseppe@gmail.com' }) },
  GmailApp: { getAliases: () => ['ticketteria@81100.it'], getThreadById: (id) => threads[id] ? { getId: () => id, getMessages: () => threads[id] } : null },
  Utilities: {
    Charset: { UTF_8: 'utf8' }, getUuid: () => '1234-5678',
    base64Encode: (x) => Buffer.from(typeof x === 'string' ? Buffer.from(x, 'utf8') : Buffer.from(x)).toString('base64'),
    base64EncodeWebSafe: (s) => Buffer.from(s, 'utf8').toString('base64url'),
  },
  UrlFetchApp: { fetch: (u) => ({ getResponseCode: () => 200, getContent: () => [...Buffer.from('%PDF-1.7 finto')] }) },
  Gmail: { Users: { Drafts: {
    create: (r, me) => { created.push(r); return { id: 'D1', message: { id: 'M1', threadId: r.message.threadId } }; },
    send: (r, me) => { sent.push(r); return { id: 'M2', threadId: 'T1' }; },
  } } },
};
vm.createContext(ctx); vm.runInContext(src, ctx);
const post = (o) => ctx.doPost({ postData: { contents: JSON.stringify(o) } });
const PDF = 'https://xqbhujcnjvwbwzpwjujf.supabase.co/storage/v1/object/sign/preventivi-pdf/2026/PREV-2026-101.pdf?token=abc';

// secret errato
assert.deepStrictEqual(post({ secret: 'no', threadId: 'T1', body: 'x' }).ok, false);
// anteprima: reply-all sul messaggio ricevuto (mario), cc anna+boss, esclusi i miei
let r = post({ secret: 'SEGRETO', azione: 'anteprima', threadId: 'T1', body: 'Buongiorno' });
assert.strictEqual(r.ok, true, r.error); assert.deepStrictEqual([...r.to], ['mario@cliente.it']);
assert.deepStrictEqual([...r.cc], ['anna@cliente.it', 'boss@cliente.it']); assert.strictEqual(r.subject, 'Re: Richiesta preventivo palco');
assert.strictEqual(created.length, 0);
// thread tutto mio → destinatari = To/Cc del mio messaggio, nome con virgola
r = post({ secret: 'SEGRETO', azione: 'anteprima', threadId: 'T2', body: 'x' });
assert.deepStrictEqual([...r.to], ['mario@cliente.it']); assert.deepStrictEqual([...r.cc], ['x@y.it']); assert.strictEqual(r.subject, 'Re: Offerta');
// to forzato → niente cc automatici
r = post({ secret: 'SEGRETO', azione: 'anteprima', threadId: 'T1', body: 'x', to: ['Altro@Ditta.it'] });
assert.deepStrictEqual([...r.to], ['altro@ditta.it']); assert.deepStrictEqual([...r.cc], []);
// pdfUrl estraneo rifiutato
r = post({ secret: 'SEGRETO', azione: 'bozza', threadId: 'T1', body: 'x', pdfUrl: 'https://evil.com/a.pdf', filename: 'a.pdf' });
assert.strictEqual(r.ok, false); assert.match(r.error, /non ammesso/);
// from non alias rifiutato
r = post({ secret: 'SEGRETO', azione: 'anteprima', threadId: 'T1', body: 'x', from: 'pippo@x.it' });
assert.strictEqual(r.ok, false);
// bozza
r = post({ secret: 'SEGRETO', azione: 'bozza', threadId: 'T1', body: 'Buongiorno, in allegato il preventivo. Cordialità, Giuseppe — €', pdfUrl: PDF, filename: 'Preventivo PREV-2026-101.pdf' });
assert.strictEqual(r.ok, true, r.error); assert.strictEqual(r.mode, 'draft'); assert.strictEqual(r.draftId, 'D1'); assert.strictEqual(sent.length, 0);
const mime = Buffer.from(created[0].message.raw, 'base64url').toString('utf8');
assert.strictEqual(created[0].message.threadId, 'T1');
assert.match(mime, /^To: mario@cliente\.it\r\nCc: anna@cliente\.it, boss@cliente\.it\r\nSubject: Re: Richiesta preventivo palco\r\nIn-Reply-To: <a@c>\r\nReferences: <a@c>\r\n/);
assert.match(mime, /filename="Preventivo PREV-2026-101\.pdf"/);
assert.ok(/^[\x00-\x7f]*$/.test(mime), 'MIME solo ASCII');
const parts = mime.split('--b81100_12345678');
assert.strictEqual(Buffer.from(parts[1].split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8').trim(), 'Buongiorno, in allegato il preventivo. Cordialità, Giuseppe — €');
assert.strictEqual(Buffer.from(parts[2].split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString(), '%PDF-1.7 finto');
// invio
r = post({ secret: 'SEGRETO', azione: 'invia', threadId: 'T1', body: 'x', pdfUrl: PDF, filename: 'P.pdf', subject: 'Preventivo à' });
assert.strictEqual(r.mode, 'sent'); assert.strictEqual(r.messageId, 'M2'); assert.strictEqual(sent[0].id, 'D1');
assert.match(Buffer.from(created[1].message.raw, 'base64url').toString(), /Subject: =\?UTF-8\?B\?/);
// thread inesistente
assert.match(post({ secret: 'SEGRETO', azione: 'anteprima', threadId: 'XX', body: 'x' }).error, /non trovato/);
console.log('OK: tutti i test del postino passano');
