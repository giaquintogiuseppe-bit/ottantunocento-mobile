-- Autorizzazioni LIVE DKV (cliente 4301665111): tabella SOLO antifrode.
-- NON alimenta DB.carburante né i costi del gestionale: la fonte costi autorevole resta l'import xlsx.
-- Popolata dall'Apps Script apps-script/dkv-autorizzazioni (Gmail di Giuseppe), che legge l'allegato xlsx
-- delle email DKV Analytics: UNA riga per transazione (una email può contenerne più d'una).

create table if not exists public.dkv_autorizzazioni (
  id               uuid primary key default gen_random_uuid(),
  authorization_id text unique,            -- chiave di idempotenza REALE (colonna "Authorization ID" dell'xlsx DKV)
  gmail_message_id text,                   -- solo riferimento all'email d'origine (NON unico: più transazioni per email)
  ricevuta_il      timestamptz,
  ts_transazione   timestamptz,
  carta_last4      text,
  targa            text,
  stazione         text,
  prodotto         text,
  importo          numeric,                -- "Authorization Amount Gross" in EUR: importo lordo AUTORIZZATO (può essere un massimale pre-autorizzato, non il consumato)
  litri            numeric,                -- colonna "Sales" (unità L)
  esito            text,                   -- "Response" grezzo, es. APP_LIM20_APPR (APP* = approvata, DEC* = rifiutata)
  product_code     text,
  km               numeric,
  citta            text,
  station_number   text,
  customer_number  text,
  raw_subject      text,
  raw_body         text,
  parsed           boolean not null default false,
  sospetta         boolean not null default false,
  motivi_sospetto  text,
  cantiere         text,                   -- cantiere dello scontrino Telegram abbinato (null se non abbinato)
  scontrino_autore text,                   -- autore dello scontrino Telegram abbinato
  scontrino_trovato boolean not null default false,  -- true = abbinato a uno scontrino in scontrini_telegram (targa/mezzo +-45 min)
  stato            text not null default 'nuova',  -- nuova / vista / archiviata_gmail
  creato_il        timestamptz not null default now()
);

create index if not exists dkv_autorizzazioni_gmail_message_id_idx on public.dkv_autorizzazioni (gmail_message_id);
-- authorization_id è già indicizzato dal vincolo UNIQUE
create index if not exists dkv_autorizzazioni_ricevuta_il_idx on public.dkv_autorizzazioni (ricevuta_il desc);
create index if not exists dkv_autorizzazioni_sospetta_idx    on public.dkv_autorizzazioni (sospetta) where sospetta;
create index if not exists dkv_autorizzazioni_carta_ts_idx    on public.dkv_autorizzazioni (carta_last4, ts_transazione);

-- RLS: abilitata. Come le altre tabelle operative (rifornimenti, scontrini_telegram): un'unica policy
-- "operativo" per il ruolo authenticated (il gestionale/front-end interroga come utente LOGGATO, non anon).
-- L'Apps Script scrive con la service-role key, che bypassa comunque la RLS.
alter table public.dkv_autorizzazioni enable row level security;

drop policy if exists operativo on public.dkv_autorizzazioni;
create policy operativo on public.dkv_autorizzazioni for all to authenticated using (true) with check (true);
