// 81|00 — carica-file-storage: DISATTIVATA (27/09/2026).
// Caricava file in QUALSIASI bucket con i permessi di service_role e sovrascrittura (upsert),
// protetta solo da un segreto fisso nel codice. Nessuna app la usa: l'Archivio carica
// i documenti direttamente con la sessione dell'utente (Storage + RLS).
// Se servisse di nuovo: ripristinarla con verify_jwt attivo, controllo che l'utente sia admin
// in app_utenti, bucket fisso "archivio-documenti" e niente upsert.
Deno.serve(() => new Response("carica-file-storage disattivata", { status: 410 }));
