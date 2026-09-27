// 81|00 — telegram-presenze: DISATTIVATA (27/09/2026).
// Bot presenze non più usato (ultima registrazione 08/08/2026) e aperto a chiunque finché
// la lista presenze_autorizzati era vuota. Risponde 200 senza fare nulla, così Telegram
// non ritenta l'invio degli update. Le presenze si registrano da Mobile/Gestionale.
Deno.serve(() => new Response("ok"));
