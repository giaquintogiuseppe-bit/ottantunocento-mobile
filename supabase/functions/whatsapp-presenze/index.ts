// 81|00 — whatsapp-presenze: DISATTIVATA (27/09/2026).
// Bot presenze WhatsApp (Twilio) mai usato (0 registrazioni), senza verifica della firma
// Twilio e aperto a chiunque finché whatsapp_autorizzati era vuota. Risponde con un TwiML
// vuoto: Twilio non segnala errori e non invia risposte. Le presenze si registrano da Mobile/Gestionale.
Deno.serve(() => new Response("<Response/>", { headers: { "Content-Type": "text/xml" } }));
