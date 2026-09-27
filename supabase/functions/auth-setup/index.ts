// 81|00 — auth-setup: DISATTIVATA (27/09/2026).
// Era la funzione "una tantum" che creava/reimpostava gli account di Giuseppe e Campo
// e restituiva la password nella risposta, protetta solo da un segreto nell'URL
// facile da indovinare. Gli account esistono già: la funzione non serve più.
// Per reimpostare una password: Supabase → Authentication → Users → "Send password recovery",
// oppure dal pannello "Reset password" dell'utente.
Deno.serve(() => new Response("auth-setup disattivata", { status: 410 }));
