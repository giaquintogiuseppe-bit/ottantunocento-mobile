-- Fase 0: la copia di backup delle fatture era leggibile/modificabile con la anon key.
-- Con RLS attiva e nessuna policy, solo service_role (Edge Function, SQL da dashboard) vi accede.
alter table public._backup_fatture_import_0905 enable row level security;

-- Jarvis (Fase 1): ogni scrittura proposta dall'AI passa da qui e attende il ✅ su Telegram.
create table if not exists public.jarvis_azioni (
  id uuid primary key default gen_random_uuid(),
  telegram_id bigint not null,
  tipo text not null check (tipo in ('pagamento','pianificazione','spesa','richiesta','timbratura')),
  payload jsonb not null,
  riepilogo text not null,
  stato text not null default 'proposta' check (stato in ('proposta','in_esecuzione','eseguita','annullata','scaduta','errore')),
  esito text,
  creato_il timestamptz not null default now(),
  chiusa_il timestamptz
);
create index if not exists jarvis_azioni_aperte on public.jarvis_azioni (telegram_id, stato, creato_il desc);
alter table public.jarvis_azioni enable row level security;
-- nessuna policy: solo la Edge Function (service_role) legge e scrive.

-- raggruppa le proposte nate dallo stesso messaggio (bottone "Conferma tutte")
alter table public.jarvis_azioni add column if not exists lotto text;
create index if not exists jarvis_azioni_lotto on public.jarvis_azioni (lotto);

-- Dedup degli update Telegram (Telegram ritenta il webhook se la risposta tarda).
create table if not exists public.jarvis_update_visti (
  update_id bigint primary key,
  visto_il timestamptz not null default now()
);
alter table public.jarvis_update_visti enable row level security;

-- Lo storico revisioni dei contratti sponsor era leggibile/scrivibile da QUALSIASI utente loggato
-- (anche l'account Campo). Ora come le altre tabelle contratti_*: admin o area contratti_sponsor.
drop policy if exists "revisioni lettura" on public.contratti_revisioni;
drop policy if exists "revisioni scrittura" on public.contratti_revisioni;
create policy "revisioni lettura" on public.contratti_revisioni
  for select to authenticated using (e_admin() or ha_area('contratti_sponsor'));
create policy "revisioni scrittura" on public.contratti_revisioni
  for insert to authenticated with check (e_admin() or ha_area('contratti_sponsor'));
