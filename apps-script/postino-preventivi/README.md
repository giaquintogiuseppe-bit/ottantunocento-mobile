# Invio preventivo via email — postino Apps Script

Risponde a una mail cliente allegando il PDF del preventivo **senza far passare il PDF in base64 da Claude**.

```
Claude ──invia_preventivo_email──▶ Edge Function mcp-81100 (Supabase)
                                     │ genera PDF → bucket preventivi-pdf → link firmato 30 gg
                                     ▼
                                   Apps Script "postino" (Gmail di Giuseppe)
                                     │ verifica secret → scarica PDF dal link → risposta nel thread
                                     ▼
                                   Bozza nel thread (default)  /  mail inviata (invia=true, confermato)
```

## Tool MCP `invia_preventivo_email` (mcp-81100 ≥ 2.5.0)

| Parametro | Tipo | Note |
|---|---|---|
| `numero` | string, obbl. | es. `PREV-2026-101` |
| `thread_id` | string, obbl. | thread Gmail a cui rispondere |
| `testo` | string, obbl. | corpo in testo semplice |
| `invia` | bool, default `false` | `false` = bozza; `true` = spedisce (due passi) |
| `to` | string[] | forza i destinatari; se presente, niente Cc automatici |
| `cc` | string[] | sostituisce i Cc di default |
| `oggetto` | string | default: oggetto del thread (`Re: …`) |
| `codice_conferma` | string | solo con `invia=true`, dall'anteprima |

- **Bozza** (`invia` omesso/false): un passo solo → `{ ok, modalita:"bozza", thread_id, draft_id, file, to, cc, oggetto }`.
- **Invio** (`invia=true`): 1ª chiamata senza codice → `modalita:"anteprima"` con destinatari/oggetto reali e `codice_conferma`
  (nessun PDF, nessuna bozza); 2ª chiamata con gli stessi dati + codice → `modalita:"inviata"`.
  Stessa regola delle altre scritture del connettore: si spedisce solo dopo il sì esplicito di Giuseppe.
- **Destinatari di default** = "rispondi a tutti": Reply-To/mittente dell'ultimo messaggio ricevuto nel thread + gli altri in A/Cc,
  esclusi l'indirizzo di Giuseppe e i suoi alias "invia come". Se il thread contiene solo messaggi di Giuseppe: A/Cc del suo ultimo messaggio.
- Ogni bozza/invio viene registrato in `agente_log` (azione `invia_preventivo_email`, canale `claude`).

## Installazione (una volta, manuale)

1. **script.google.com** → Nuovo progetto, nome *Postino preventivi 81|00* → incolla `mailer-preventivi.gs` al posto di `Codice.gs`.
2. **Servizi (+)** → *Gmail API* → Aggiungi (identificatore `Gmail`). In alternativa: Impostazioni progetto → mostra `appsscript.json` e incolla quello di questa cartella.
3. Seleziona la funzione **`impostaSegreto`** → Esegui → nel *Registro di esecuzione* copia il valore.
   Supabase → progetto `xqbhujcnjvwbwzpwjujf` → Edge Functions → **Secrets** → `PREVENTIVO_MAIL_SECRET` = quel valore.
4. Seleziona **`provaAutorizzazioni`** → Esegui → concedi i permessi Google (Gmail, connessioni a servizi esterni).
5. **Esegui il deployment → Nuovo deployment** → tipo *Applicazione web* → *Esegui come: Me* → *Chi ha accesso: Chiunque* → Esegui deployment.
   Copia l'URL che finisce in `/exec` → secret Supabase `APPS_SCRIPT_MAILER_URL`.
6. Test: prima `invia=false` (bozza nel thread col PDF), poi una prova `invia=true`.

Dopo ogni modifica al codice: *Gestisci deployment* → matita → *Versione: Nuova versione* (l'URL `/exec` non cambia).

## Sicurezza

- Web App pubblico ma inutilizzabile senza il secret (confronto a tempo costante; il secret non viene mai loggato né restituito).
  Apps Script non può rispondere con HTTP 403: risponde `200` con `{ ok:false, error:"forbidden (403) …" }`.
- Il postino scarica PDF **solo** da `https://xqbhujcnjvwbwzpwjujf.supabase.co/storage/v1/object/sign/preventivi-pdf/…` e verifica che il file inizi con `%PDF`.
- Max 20 destinatari per mail; indirizzi validati sia nella Edge Function sia nello script.
- `from` (alias "invia come", es. ticketteria@) è già supportato dallo script ma accettato solo se è un alias configurato in Gmail;
  il tool MCP non lo espone ancora.

## Test

`node test-postino.js` — prova il postino con Gmail/UrlFetch finti (destinatari, MIME, bozza/invio, rifiuti).

## Note

- La mail è creata via Gmail API (MIME costruito dallo script, con `In-Reply-To`/`References`), quindi resta nel thread
  e permette di forzare `to`. La firma Gmail **non** viene aggiunta in automatico: va scritta nel `testo`.
- Cambiare `oggetto` può far uscire la risposta dal thread in alcuni client di posta.
- Fase 2 (pulsante app Amministrazione): senza `thread_id` servirà un'azione "nuova mail" con `to` esplicito — da aggiungere al postino quando si fa il bottone.
