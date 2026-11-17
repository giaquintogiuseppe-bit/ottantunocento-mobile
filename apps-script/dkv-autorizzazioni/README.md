# Antifrode carte DKV — Apps Script

Individua **frodi giornaliere** sulle carte carburante DKV (cliente 4301665111) a partire dalla notifica
"Autorizzazioni LIVE" di DKV Cockpit (email immediata a ogni rifornimento sul Gmail di Giuseppe).

> **ATTENZIONE: `parseEmailDKV` è incompleto.** Non conosciamo ancora il formato dell'email DKV (contiene un link a
> DKV Analytics: i dati possono essere nel corpo o solo dietro il link). Finché non arriva un'**email campione reale**
> il parser salva solo i campi grezzi (`raw_subject`, `raw_body`, `gmail_message_id`, `ricevuta_il`) con `parsed=false`.
> Nel report quelle righe compaiono come "da verificare", **non** come sospette. Cerca `TODO: completare estrazione con email campione`.

```
DKV Cockpit ──email Autorizzazioni LIVE──▶ Gmail Giuseppe
                                            │ filtro Gmail applica label "DKV/da-processare"
                                            ▼
  trigger ogni 30 min ─▶ processaGiornata()  (INGEST, scrive)
                           parseEmailDKV → valutaSospetti → upsert Supabase (service-role, on_conflict=gmail_message_id)
                           → label "DKV/processata" + ARCHIVIA (mai cancella) → stato='archiviata_gmail'
                                            ▼
                                  Supabase: dkv_autorizzazioni  (solo antifrode)
                                            ▼
  trigger 21:00 Europe/Rome ─▶ reportSerale()  (REPORT, sola lettura)
                           email HTML a REPORT_TO: totali + sospette in rosso in cima
```

La tabella è **solo antifrode**: non scrive in `DB.carburante`, non tocca `index.html`; la fonte costi autorevole resta l'import xlsx.

## Installazione (una volta, manuale)

1. **Migration**: applica `supabase/migrations/20261117_dkv_autorizzazioni.sql` al progetto `xqbhujcnjvwbwzpwjujf`.
2. **script.google.com** (loggato come Giuseppe) → Nuovo progetto *Antifrode DKV 81|00* → incolla `dkv-autorizzazioni.gs`;
   Impostazioni progetto → mostra `appsscript.json` e incolla quello di questa cartella (nessun servizio avanzato, nessuna web app).
3. Esegui **`impostaProprieta`** (poi, in Impostazioni progetto → Proprietà script, metti la vera `SUPABASE_SERVICE_KEY`
   e rimuovi la chiave dal codice se l'hai scritta lì). La service-role key non va mai in chat/email/log.
4. Esegui **`setup`**: crea le label `DKV/da-processare` e `DKV/processata` e stampa le istruzioni del filtro.
5. **Filtro Gmail** (Impostazioni → Filtri e indirizzi bloccati → Crea filtro): *Da* / *Oggetto* = **TODO, da confermare sul primo
   campione reale** (notifica "Autorizzazioni LIVE") → azione **Applica l'etichetta `DKV/da-processare`** (non "Elimina").
6. Esegui **`provaAutorizzazioni`** → concedi i permessi Google (Gmail, servizi esterni) e controlla il registro.
7. Esegui **`creaTrigger`**.

## Script Properties

| Proprietà | Default | Note |
|---|---|---|
| `SUPABASE_URL` | `https://xqbhujcnjvwbwzpwjujf.supabase.co` | |
| `SUPABASE_SERVICE_KEY` | — (obbligatoria) | service-role key, bypassa RLS |
| `REPORT_TO` | `giaquinto.giuseppe@gmail.com` | destinatario del report |
| `LABEL_IN` / `LABEL_DONE` | `DKV/da-processare` / `DKV/processata` | |
| `SOGLIA_IMPORTO_MAX` | `300` (EUR) | sopra = sospetta; `0` disattiva |
| `SOGLIA_LITRI_MAX` | `0` (**disattivato**) | **TODO: riempire con i litri poco sopra il serbatoio più capiente della flotta** |
| `SOGLIA_ORA_INIZIO` / `SOGLIA_ORA_FINE` | `6` / `20` | fuori fascia = fuori orario |
| `SOGLIA_GIORNI_LAVORATIVI` | `1,2,3,4,5,6` | 1=lun … 7=dom |
| `SOGLIA_MINUTI_DOPPIA` | `30` | due transazioni stessa carta entro N min; `0` disattiva |
| `SOGLIA_STAZIONE_NUOVA` | `1` | `0` disattiva |
| `SOGLIA_MIN_STORICO_STAZIONI` | `5` | "stazione nuova" attiva solo dopo N stazioni note |
| `MAX_THREAD_PER_GIRO` | `50` | thread per esecuzione dell'ingest |

Tutte le soglie vivono nei `DEFAULTS_` in cima al `.gs` e nelle Script Properties: nessun valore hardcoded altrove.

## Trigger

- `processaGiornata` ogni **30 minuti**: solo ingest (parse + salva + archivia). Se un thread fallisce resta in `DKV/da-processare` e viene ritentato.
- `reportSerale` una volta al giorno alle **21:00 Europe/Rome** (Apps Script esegue nella finestra 21:00–22:00): sola lettura.
- `creaTrigger()` rimuove i vecchi trigger di queste due funzioni e li reinstalla (idempotente).

## Sicurezza

- Le email vengono solo **etichettate e archiviate**: nessun `moveToTrash`/delete.
- Idempotenza: `gmail_message_id` UNIQUE + upsert `on_conflict=gmail_message_id` (`merge-duplicates`).
- La service-role key sta solo nelle Script Properties; non viene mai loggata né inviata via email; i messaggi d'errore la mascherano.
- RLS attiva: `anon` ha SELECT/INSERT/UPDATE, **non DELETE**.
- Il report HTML esegue l'escape dei campi; non include `raw_body`.

## Mappa flotta (per il futuro parser, non usata ora)

GM972CF = PRAMAC 2 (carta ...0322, diesel) · FX943SG = Clio (carta ...2153) · CT068NE = Renato (diesel) · FS504WE = Pietro.

## Test

`node test-dkv.js` — Gmail/UrlFetch/PropertiesService finti: parser placeholder, soglie (sopra/sotto/null), upsert idempotente,
ingest (solo label+archivio), report in sola lettura.
`node --check` non accetta l'estensione `.gs`: per la sintassi copia il file con estensione `.js`.
