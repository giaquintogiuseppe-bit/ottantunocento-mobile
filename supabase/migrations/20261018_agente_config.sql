-- Configurazione dell'agente 81|00 (solo service_role).
-- 'mcp_token_sha256' = impronta SHA-256 del token del connettore MCP (il token in chiaro non sta né qui né nel codice).
-- Per cambiare token:
--   update agente_config set valore = encode(extensions.digest('<nuovo token>', 'sha256'), 'hex'), aggiornato_il = now()
--    where chiave = 'mcp_token_sha256';
create table if not exists public.agente_config (
  chiave text primary key,
  valore text not null,
  aggiornato_il timestamptz not null default now()
);
alter table public.agente_config enable row level security;
-- nessuna policy: solo service_role.
