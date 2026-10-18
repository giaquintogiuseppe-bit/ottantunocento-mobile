-- Jarvis usa il motore condiviso agente_*: nuovi tipi di proposta.
alter table public.jarvis_azioni drop constraint if exists jarvis_azioni_tipo_check;
alter table public.jarvis_azioni add constraint jarvis_azioni_tipo_check
  check (tipo in ('pagamento', 'pianificazione', 'spesa', 'richiesta', 'timbratura',
                  'cantiere', 'lavorazione', 'presenza', 'preventivo'));
