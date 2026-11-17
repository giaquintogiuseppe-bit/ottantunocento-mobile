-- Autorizzazioni LIVE DKV (cliente 4301665111): tabella SOLO antifrode.
-- NON alimenta DB.carburante né i costi del gestionale: la fonte costi autorevole resta l'import xlsx.
-- Popolata dall'Apps Script apps-script/dkv-autorizzazioni (Gmail di Giuseppe).

create table if not exists public.dkv_autorizzazioni (
  id               uuid primary key default gen_random_uuid(),
  gmail_message_id text unique,            -- idempotenza: una riga per email, niente doppioni
  ricevuta_il      timestamptz,
  ts_transazione   timestamptz,
  carta_last4      text,
  targa            text,
  stazione         text,
  prodotto         text,
  importo          numeric,
  litri            numeric,
  esito            text,                   -- riuscita / pin_errato / ...
  raw_subject      text,
  raw_body         text,
  parsed           boolean not null default false,
  sospetta         boolean not null default false,
  motivi_sospetto  text,
  stato            text not null default 'nuova',  -- nuova / vista / archiviata_gmail
  creato_il        timestamptz not null default now()
);

create index if not exists dkv_autorizzazioni_ricevuta_il_idx on public.dkv_autorizzazioni (ricevuta_il desc);
create index if not exists dkv_autorizzazioni_sospetta_idx    on public.dkv_autorizzazioni (sospetta) where sospetta;
create index if not exists dkv_autorizzazioni_carta_ts_idx    on public.dkv_autorizzazioni (carta_last4, ts_transazione);

-- RLS: abilitata. Policy per `anon` come per le altre tabelle operative (i front-end usano la anon key):
-- SELECT, INSERT, UPDATE; NESSUNA policy DELETE (le righe antifrode non si cancellano da client).
-- L'Apps Script scrive invece con la service-role key, che bypassa RLS: le policy qui sotto
-- servono solo ai front-end che leggono/marcano come "vista".
alter table public.dkv_autorizzazioni enable row level security;

drop policy if exists dkv_autorizzazioni_anon_select on public.dkv_autorizzazioni;
drop policy if exists dkv_autorizzazioni_anon_insert on public.dkv_autorizzazioni;
drop policy if exists dkv_autorizzazioni_anon_update on public.dkv_autorizzazioni;

create policy dkv_autorizzazioni_anon_select on public.dkv_autorizzazioni for select to anon using (true);
create policy dkv_autorizzazioni_anon_insert on public.dkv_autorizzazioni for insert to anon with check (true);
create policy dkv_autorizzazioni_anon_update on public.dkv_autorizzazioni for update to anon using (true) with check (true);
