-- ═══ AGENTE 81|00 — motore di scrittura condiviso ═══
-- Un'unica logica per creare cantieri, lavorazioni (interventi), presenze e preventivi,
-- usata sia dal connettore MCP (app Claude) sia da Jarvis (Telegram).
--
-- Ogni funzione ha la firma  agente_xxx(p jsonb, conferma boolean, canale text) → jsonb
--   conferma = false → ANTEPRIMA: valida tutto e restituisce cosa scriverebbe, senza scrivere.
--   conferma = true  → SCRIVE in un'unica UPDATE atomica (riga gestionale_dati bloccata),
--                      il trigger alza `versione`: Gestionale e Mobile vedono la modifica e la
--                      riuniscono (Gestionale ricarica, Mobile fonde a 3 vie). Nessuna sovrascrittura.
-- Errori (cantiere/persona ambigui, doppioni, date sbagliate) → eccezione con messaggio leggibile.
-- Solo service_role può eseguirle (Edge Function): niente accesso da anon/authenticated.

-- ─── registro delle azioni eseguite dall'agente ───
create table if not exists public.agente_log (
  id bigint generated always as identity primary key,
  ts timestamptz not null default now(),
  canale text not null,
  azione text not null,
  input jsonb not null,
  risultato jsonb
);
alter table public.agente_log enable row level security;
-- nessuna policy: solo service_role.

-- ─── utilità ───
create or replace function public.agente_norm(s text) returns text
language sql immutable as $$
  select btrim(regexp_replace(
    translate(lower(coalesce(s, '')), 'àáâäãèéêëìíîïòóôöõùúûüçñ''’', 'aaaaaeeeeiiiiooooouuuucn  '),
    '[^a-z0-9]+', ' ', 'g'))
$$;

create or replace function public.agente_oggi() returns date
language sql stable as $$ select (now() at time zone 'Europe/Rome')::date $$;

create or replace function public.agente_id(prefisso text) returns text
language sql volatile as $$
  select prefisso || substr(md5(random()::text || clock_timestamp()::text), 1, 10)
$$;

create or replace function public.agente_eur(n numeric) returns text
language sql immutable as $$
  select translate(to_char(coalesce(n, 0), 'FM999,999,990.00'), ',.', '.,')
$$;

create or replace function public.agente_data(s text, campo text) returns text
language plpgsql immutable as $$
begin
  if s is null or s !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception '% non valida: «%» (formato AAAA-MM-GG)', campo, coalesce(s, '');
  end if;
  perform s::date;
  return s;
end $$;

create or replace function public.agente_ora(s text, predefinita text) returns text
language plpgsql immutable as $$
declare m text[];
begin
  if s is null or btrim(s) = '' then return predefinita; end if;
  m := regexp_match(btrim(s), '^([01]?\d|2[0-3])[:.]([0-5]\d)$');
  if m is null then raise exception 'Orario non valido: «%» (formato HH:MM)', s; end if;
  return lpad(m[1], 2, '0') || ':' || m[2];
end $$;

-- Trova un cantiere (id, codice COM-…, nome esatto o parziale). Esclude archiviati e persi
-- nella ricerca per nome. Ambiguo/inesistente → eccezione con i candidati.
create or replace function public.agente_trova_cantiere(d jsonb, q text, out idx int, out c jsonb)
language plpgsql stable as $$
declare n text := agente_norm(q); cand jsonb; scelta jsonb; elenco text;
begin
  if n = '' then raise exception 'Specifica il cantiere'; end if;
  select (o - 1)::int, x into idx, c
    from jsonb_array_elements(coalesce(d->'cantieri', '[]')) with ordinality t(x, o)
   where x->>'id' = btrim(q) or upper(coalesce(x->>'codice', '')) = upper(btrim(q))
   limit 1;
  if c is not null then return; end if;

  select coalesce(jsonb_agg(jsonb_build_object('i', (o - 1)::int, 'x', x, 'esatto', agente_norm(x->>'nome') = n,
                                               'aperto', coalesce(x->>'stato', '') <> 'concluso')), '[]')
    into cand
    from jsonb_array_elements(coalesce(d->'cantieri', '[]')) with ordinality t(x, o)
   where coalesce(x->>'archiviato', 'false') <> 'true'
     and coalesce(x->>'stato', '') <> 'perso'
     and (agente_norm(x->>'nome') like '%' || n || '%'
          or (length(n) > 4 and (select bool_and(agente_norm(x->>'nome') like '%' || tok || '%')
                                   from unnest(string_to_array(n, ' ')) tok)));

  -- priorità: nome esatto → unico non concluso → unico in assoluto
  select coalesce(jsonb_agg(e), '[]') into scelta from jsonb_array_elements(cand) e where (e->>'esatto')::boolean;
  if jsonb_array_length(scelta) <> 1 then
    select coalesce(jsonb_agg(e), '[]') into scelta from jsonb_array_elements(cand) e where (e->>'aperto')::boolean;
    if jsonb_array_length(scelta) = 0 then scelta := cand; end if;
  end if;
  if jsonb_array_length(scelta) = 1 then
    idx := (scelta->0->>'i')::int; c := scelta->0->'x'; return;
  end if;
  if jsonb_array_length(scelta) > 1 then
    select string_agg(format('%s [%s%s, id %s]', e->'x'->>'nome', coalesce(e->'x'->>'stato', 'da confermare'),
                             coalesce(', ' || (e->'x'->>'codice'), ''), e->'x'->>'id'), '; ')
      into elenco from (select e from jsonb_array_elements(scelta) e limit 10) s;
    raise exception 'Più cantieri corrispondono a «%»: %. Indica quale (id o codice).', q, elenco;
  end if;
  raise exception 'Nessun cantiere «%». Cerca con cantieri_lista o crealo con crea_cantiere.', q;
end $$;

-- Trova una persona attiva in personale[] (id, nome completo, nome o cognome).
create or replace function public.agente_trova_persona(d jsonb, q text) returns jsonb
language plpgsql stable as $$
declare n text := agente_norm(q); r jsonb; cnt int; elenco text;
begin
  if n = '' then raise exception 'Nome persona vuoto'; end if;
  select x into r from jsonb_array_elements(coalesce(d->'personale', '[]')) x
   where (x->>'id' = btrim(q) or agente_norm(x->>'nome') = n) and coalesce(x->>'stato', '') <> 'cessato'
   limit 1;
  if r is not null then return r; end if;
  select count(*), string_agg(x->>'nome', ', '), (array_agg(x))[1] into cnt, elenco, r
    from jsonb_array_elements(coalesce(d->'personale', '[]')) x
   where coalesce(x->>'stato', '') <> 'cessato'
     and (n = any(string_to_array(agente_norm(x->>'nome'), ' ')) or agente_norm(x->>'nome') like '%' || n || '%');
  if cnt = 1 then return r; end if;
  if cnt > 1 then raise exception '«%» è ambiguo: %. Indica nome e cognome.', q, elenco; end if;
  select string_agg(x->>'nome', ', ' order by x->>'nome') into elenco
    from jsonb_array_elements(coalesce(d->'personale', '[]')) x where coalesce(x->>'stato', '') <> 'cessato';
  raise exception 'Nessun dipendente «%». Personale attivo: %', q, elenco;
end $$;

-- Costruisce un intervento (giornata di lavoro) validato. squadra = nomi come in personale[].
create or replace function public.agente_intervento(d jsonb, g jsonb, luogo_def text) returns jsonb
language plpgsql volatile as $$
declare dt text; oi text; ofi text; sq jsonb := '[]'; nm text; p jsonb;
begin
  dt := agente_data(g->>'data', 'Data della giornata');
  oi := agente_ora(g->>'ora_inizio', '08:00');
  ofi := agente_ora(g->>'ora_fine', '18:00');
  for nm in select jsonb_array_elements_text(coalesce(g->'squadra', '[]')) loop
    p := agente_trova_persona(d, nm);
    if not sq @> jsonb_build_array(p->>'nome') then sq := sq || jsonb_build_array(p->>'nome'); end if;
  end loop;
  return jsonb_build_object(
    'id', agente_id('iv'), 'data', dt, 'oraInizio', oi, 'oraFine', ofi,
    'notturno', coalesce((g->>'notturno')::boolean, ofi <= oi),
    'descrizione', coalesce(g->>'descrizione', ''),
    'luogo', coalesce(nullif(g->>'luogo', ''), luogo_def, ''),
    'squadra', sq, 'mezzi', '[]'::jsonb, 'esterni', '[]'::jsonb);
end $$;

-- Persone della squadra già impegnate quel giorno su altri cantieri (avvisi, non errori).
create or replace function public.agente_conflitti(d jsonb, iv jsonb, escludi_id text) returns text[]
language sql stable as $$
  select coalesce(array_agg(distinct format('%s è già su %s il %s%s', nome, c->>'nome',
                  to_char((iv->>'data')::date, 'DD/MM'), coalesce(' (' || (x->>'oraInizio') || ')', ''))), '{}')
    from jsonb_array_elements(coalesce(d->'cantieri', '[]')) c,
         jsonb_array_elements(coalesce(c->'interventi', '[]')) x,
         jsonb_array_elements_text(coalesce(iv->'squadra', '[]')) nome
   where c->>'id' <> coalesce(escludi_id, '')
     and coalesce(c->>'stato', '') not in ('perso', 'concluso')
     and coalesce(c->>'archiviato', 'false') <> 'true'
     and x->>'data' = iv->>'data'
     and jsonb_typeof(x->'squadra') = 'array' and x->'squadra' @> jsonb_build_array(nome)
$$;

create or replace function public.agente_scrivi(d jsonb, canale text) returns void
language sql volatile as $$
  update gestionale_dati set dati = d, salvato_da = 'Agente 81|00 · ' || canale where id = 'unico'
$$;

create or replace function public.agente_registra(canale text, azione text, input jsonb, risultato jsonb) returns void
language sql volatile as $$
  insert into agente_log(canale, azione, input, risultato) values (canale, azione, input, risultato)
$$;

-- Specchio nella tabella commesse (stessa mappatura di syncCommessePerno del Gestionale).
create or replace function public.agente_sync_commessa(c jsonb, ricavo numeric) returns void
language sql volatile as $$
  insert into commesse(id, codice, nome, cliente_id, cliente_nome, committente, tipo_cant, continuativa, stato,
                       luogo, periodo_inizio, periodo_fine, origine, preventivo_id, ricavo, non_fatturabile, archiviato, aggiornato_il)
  values (c->>'id', c->>'codice', c->>'nome', c->>'clienteId', c->>'clienteNome', c->>'committente',
          coalesce(c->'tipoCant', '[]'), (c->>'continuativa')::boolean, c->>'stato', c->>'luogo',
          c->>'periodoInizio', c->>'periodoFine', c->>'origine', c->>'preventivoId', ricavo, false, false, now())
  on conflict (id) do update set codice = excluded.codice, nome = excluded.nome, cliente_id = excluded.cliente_id,
     cliente_nome = excluded.cliente_nome, committente = excluded.committente, tipo_cant = excluded.tipo_cant,
     continuativa = excluded.continuativa, stato = excluded.stato, luogo = excluded.luogo,
     periodo_inizio = excluded.periodo_inizio, periodo_fine = excluded.periodo_fine, origine = excluded.origine,
     preventivo_id = excluded.preventivo_id, ricavo = coalesce(excluded.ricavo, commesse.ricavo), aggiornato_il = now()
$$;

-- ═══ 1. CREA CANTIERE ═══
-- p: nome*, cliente, luogo, data_inizio, data_fine, tipo_cant[] (evento|noleggio|fornitura|servizio|interno),
--    stato (da confermare|in corso|fermo), note, ricavo_previsto, preventivo (numero PREV-…),
--    giornate[] {data, ora_inizio, ora_fine, descrizione, squadra[], notturno, luogo}, forza_doppione
create or replace function public.agente_crea_cantiere(p jsonb, conferma boolean default false, canale text default 'claude')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  d jsonb; nome text := btrim(coalesce(p->>'nome', '')); dup jsonb; cli jsonb; cli_txt text := btrim(coalesce(p->>'cliente', ''));
  cnt int; elenco text; tipi jsonb; t text; stato text; di text; df text; anno text; mx int; c jsonb;
  ivs jsonb := '[]'; g jsonb; iv jsonb; avvisi text[] := '{}'; ricavo numeric; prev_id bigint; prev_num text; prev_cid text; ris jsonb;
begin
  if nome = '' then raise exception 'Serve il nome del cantiere'; end if;
  if conferma then select dati into d from gestionale_dati where id = 'unico' for update;
  else select dati into d from gestionale_dati where id = 'unico'; end if;

  select x into dup from jsonb_array_elements(coalesce(d->'cantieri', '[]')) x
   where agente_norm(x->>'nome') = agente_norm(nome) and coalesce(x->>'archiviato', 'false') <> 'true' limit 1;
  if dup is not null and coalesce((p->>'forza_doppione')::boolean, false) is not true then
    raise exception 'Esiste già il cantiere «%» (%, stato %, id %). Usa quello, oppure conferma che è un altro (forza_doppione).',
      dup->>'nome', coalesce(dup->>'codice', 'senza codice'), coalesce(dup->>'stato', 'da confermare'), dup->>'id';
  end if;

  -- cliente: cerca in anagrafica clienti del Gestionale
  if cli_txt <> '' then
    select count(*), string_agg(x->>'ragioneSociale', '; '), (array_agg(x))[1] into cnt, elenco, cli
      from jsonb_array_elements(coalesce(d->'clienti', '[]')) x
     where agente_norm(coalesce(x->>'ragioneSociale', x->>'nome')) = agente_norm(cli_txt);
    if cnt <> 1 then
      select count(*), string_agg(coalesce(x->>'ragioneSociale', x->>'nome'), '; '), (array_agg(x))[1] into cnt, elenco, cli
        from jsonb_array_elements(coalesce(d->'clienti', '[]')) x
       where agente_norm(coalesce(x->>'ragioneSociale', x->>'nome')) like '%' || agente_norm(cli_txt) || '%';
    end if;
    if cnt > 1 then
      raise exception 'Cliente «%» ambiguo in anagrafica: %. Scrivi la ragione sociale esatta.', cli_txt, left(elenco, 600);
    end if;
    if cnt = 0 then
      cli := null;
      avvisi := avvisi || format('Cliente «%s» non presente in anagrafica clienti: salvato solo come committente (aggiungilo nel Gestionale).', cli_txt);
    end if;
  end if;

  tipi := coalesce(p->'tipo_cant', '["evento"]'::jsonb);
  if jsonb_typeof(tipi) <> 'array' or jsonb_array_length(tipi) = 0 then tipi := '["evento"]'; end if;
  for t in select jsonb_array_elements_text(tipi) loop
    if t not in ('evento', 'noleggio', 'fornitura', 'servizio', 'interno') then
      raise exception 'Tipo cantiere «%» non valido: usa evento, noleggio, fornitura, servizio, interno', t;
    end if;
  end loop;

  stato := coalesce(nullif(p->>'stato', ''), 'da confermare');
  if stato not in ('da confermare', 'in corso', 'fermo') then
    raise exception 'Stato «%» non valido per un cantiere nuovo: da confermare, in corso, fermo', stato;
  end if;

  -- giornate di lavoro
  for g in select jsonb_array_elements(coalesce(p->'giornate', '[]')) loop
    iv := agente_intervento(d, g, nullif(p->>'luogo', ''));
    ivs := ivs || iv;
    avvisi := avvisi || agente_conflitti(d, iv, null);
  end loop;

  di := nullif(p->>'data_inizio', '');
  df := nullif(p->>'data_fine', '');
  if di is null then select min(x->>'data') into di from jsonb_array_elements(ivs) x; end if;
  if df is null then select max(x->>'data') into df from jsonb_array_elements(ivs) x; end if;
  if di is not null then di := agente_data(di, 'Data inizio'); end if;
  df := coalesce(df, di);
  if df is not null then df := agente_data(df, 'Data fine'); end if;
  if di is not null and df < di then raise exception 'La data fine (%) è prima della data inizio (%)', df, di; end if;

  anno := to_char(agente_oggi(), 'YYYY');
  select coalesce(max((regexp_match(cod, '^COM-' || anno || '-(\d+)$'))[1]::int), 0) into mx
    from (select x->>'codice' cod from jsonb_array_elements(coalesce(d->'cantieri', '[]')) x
          union all select codice from commesse) s;

  c := jsonb_build_object(
    'id', agente_id('ag'), 'nome', nome, 'codice', format('COM-%s-%s', anno, lpad((mx + 1)::text, 3, '0')),
    'stato', stato, 'tipo', 'standard', 'tipoCant', tipi,
    'continuativa', (tipi ? 'evento' or tipi ? 'interno'),
    'committente', coalesce(cli->>'ragioneSociale', nullif(cli_txt, '')),
    'clienteNome', coalesce(cli->>'ragioneSociale', nullif(cli_txt, '')),
    'luogo', coalesce(p->>'luogo', ''), 'periodo', '',
    'periodoInizio', coalesce(di, ''), 'periodoFine', coalesce(df, ''),
    'note', coalesce(p->>'note', ''), 'notifica', jsonb_build_object('attiva', false, 'giorni', 2),
    'interventi', ivs, 'personaleAssegnato', '[]'::jsonb, 'mezzi', '[]'::jsonb, 'materiali', '[]'::jsonb,
    'attrezzature', '[]'::jsonb, 'serviziEsterni', '[]'::jsonb, 'ricavo', 0, 'costo', 0, 'fonte', 'agente');
  if cli is not null then c := c || jsonb_build_object('clienteId', cli->>'id'); end if;
  if p ? 'stato' then c := c || jsonb_build_object('_statoManuale', true); end if;

  if nullif(p->>'preventivo', '') is not null then
    select id, numero, cantiere_id into prev_id, prev_num, prev_cid from preventivi where upper(numero) = upper(btrim(p->>'preventivo'));
    if prev_num is null then raise exception 'Preventivo «%» non trovato', p->>'preventivo'; end if;
    if coalesce(prev_cid, '') <> '' then
      avvisi := avvisi || format('Il preventivo %s era già collegato al cantiere %s: lo ricollego a questo.', prev_num, prev_cid);
    end if;
    c := c || jsonb_build_object('origine', 'da_preventivo', 'preventivoId', prev_num,
                                 'preventivoRef', prev_num, '_daPreventivo', prev_num);
  end if;

  ricavo := nullif(p->>'ricavo_previsto', '')::numeric;

  ris := jsonb_build_object('eseguito', conferma, 'cantiere', c, 'ricavo_previsto', ricavo, 'avvisi', to_jsonb(avvisi),
    'riepilogo', format('Cantiere %s «%s»%s%s%s · stato %s · %s giornate%s',
      c->>'codice', nome,
      coalesce(' · cliente ' || (c->>'committente'), ''),
      coalesce(' · ' || nullif(c->>'luogo', ''), ''),
      case when di is null then '' else ' · dal ' || to_char(di::date, 'DD/MM/YYYY') || ' al ' || to_char(df::date, 'DD/MM/YYYY') end,
      stato, jsonb_array_length(ivs),
      case when ricavo is null then '' else ' · ricavo previsto € ' || agente_eur(ricavo) end));
  if not conferma then return ris; end if;

  d := jsonb_set(d, '{cantieri}', coalesce(d->'cantieri', '[]') || c);
  if ricavo is not null and ricavo > 0 then
    d := jsonb_set(d, '{budgetCantieri}', coalesce(d->'budgetCantieri', '[]') ||
      jsonb_build_object('cantiereId', c->>'id', 'cantiereName', nome, 'ricavoPrevisto', ricavo, 'note', ''));
  end if;
  perform agente_scrivi(d, canale);
  perform agente_sync_commessa(c, ricavo);
  if prev_id is not null then
    update preventivi set cantiere_id = c->>'id', cantiere_ref = c->>'id', aggiornato_il = now() where id = prev_id;
  end if;
  perform agente_registra(canale, 'crea_cantiere', p, jsonb_build_object('id', c->>'id', 'codice', c->>'codice'));
  return ris;
end $$;

-- ═══ 2. AGGIUNGI LAVORAZIONE (giornate/interventi su un cantiere esistente) ═══
-- p: cantiere* (id, codice o nome), giornate* [{data*, ora_inizio, ora_fine, descrizione, squadra[], notturno, luogo}]
create or replace function public.agente_aggiungi_lavorazione(p jsonb, conferma boolean default false, canale text default 'claude')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  d jsonb; ci int; c jsonb; g jsonb; iv jsonb; ivs jsonb := '[]'; avvisi text[] := '{}'; dmin text; dmax text; ris jsonb; righe text[] := '{}';
begin
  if coalesce(jsonb_typeof(p->'giornate'), '') <> 'array' or jsonb_array_length(p->'giornate') = 0 then
    raise exception 'Serve almeno una giornata (data, orario, squadra)';
  end if;
  if conferma then select dati into d from gestionale_dati where id = 'unico' for update;
  else select dati into d from gestionale_dati where id = 'unico'; end if;
  select idx, t.c into ci, c from agente_trova_cantiere(d, p->>'cantiere') t;

  for g in select jsonb_array_elements(p->'giornate') loop
    iv := agente_intervento(d, g, nullif(c->>'luogo', ''));
    if exists (select 1 from jsonb_array_elements(coalesce(c->'interventi', '[]')) x
                where x->>'data' = iv->>'data' and x->>'oraInizio' = iv->>'oraInizio'
                  and coalesce(x->'squadra', '[]') = iv->'squadra') then
      avvisi := avvisi || format('Sul cantiere c''è già una giornata identica il %s alle %s.', to_char((iv->>'data')::date, 'DD/MM'), iv->>'oraInizio');
    end if;
    ivs := ivs || iv;
    avvisi := avvisi || agente_conflitti(d, iv, c->>'id');
    righe := righe || format('%s %s–%s%s%s', to_char((iv->>'data')::date, 'DD/MM/YYYY'), iv->>'oraInizio', iv->>'oraFine',
      case when jsonb_array_length(iv->'squadra') > 0 then ' · ' || (select string_agg(s, ', ') from jsonb_array_elements_text(iv->'squadra') s) else ' · squadra da definire' end,
      coalesce(' · ' || nullif(iv->>'descrizione', ''), ''));
  end loop;

  ris := jsonb_build_object('eseguito', conferma, 'cantiere', jsonb_build_object('id', c->>'id', 'nome', c->>'nome', 'codice', c->>'codice', 'stato', c->>'stato'),
    'giornate', ivs, 'avvisi', to_jsonb(avvisi),
    'riepilogo', format('Lavorazione su «%s»: %s', c->>'nome', array_to_string(righe, ' | ')));
  if not conferma then return ris; end if;

  d := jsonb_set(d, array['cantieri', ci::text, 'interventi'], coalesce(c->'interventi', '[]') || ivs);
  -- allarga il periodo del cantiere se le nuove giornate cadono fuori
  select min(x->>'data'), max(x->>'data') into dmin, dmax from jsonb_array_elements(ivs) x;
  if coalesce(c->>'periodoInizio', '') = '' or dmin < c->>'periodoInizio' then
    d := jsonb_set(d, array['cantieri', ci::text, 'periodoInizio'], to_jsonb(dmin));
  end if;
  if coalesce(c->>'periodoFine', '') = '' or dmax > c->>'periodoFine' then
    d := jsonb_set(d, array['cantieri', ci::text, 'periodoFine'], to_jsonb(dmax));
  end if;
  perform agente_scrivi(d, canale);
  perform agente_registra(canale, 'aggiungi_lavorazione', p,
    jsonb_build_object('cantiere_id', c->>'id', 'interventi', (select jsonb_agg(x->>'id') from jsonb_array_elements(ivs) x)));
  return ris;
end $$;

-- ═══ 3. AGGIUNGI PRESENZA ═══
-- p: data*, cantiere* (id, codice o nome), persone* [{nome*, importo}], ora_inizio, ora_fine, importo (per tutti), notturno, note, forza_doppione
-- La presenza va in presenze[data][idPersona].turni[] (cantiere per NOME, come fanno le app).
create or replace function public.agente_aggiungi_presenza(p jsonb, conferma boolean default false, canale text default 'claude')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  d jsonb; dt text; ci int; c jsonb; oi text; ofi text; nott boolean; pe jsonb; pers jsonb; cell jsonb; turni jsonb;
  imp numeric; turno jsonb; avvisi text[] := '{}'; righe text[] := '{}'; scritti jsonb := '[]'; ris jsonb; tot numeric := 0;
begin
  dt := agente_data(coalesce(nullif(p->>'data', ''), agente_oggi()::text), 'Data');
  if dt::date > agente_oggi() + 1 then raise exception 'La data % è nel futuro: le presenze si registrano a giornata fatta (per pianificare usa aggiungi_lavorazione)', dt; end if;
  if coalesce(jsonb_typeof(p->'persone'), '') <> 'array' or jsonb_array_length(p->'persone') = 0 then raise exception 'Indica almeno una persona'; end if;
  oi := agente_ora(p->>'ora_inizio', '08:00');
  ofi := agente_ora(p->>'ora_fine', '18:00');
  nott := coalesce((p->>'notturno')::boolean, ofi <= oi);

  if conferma then select dati into d from gestionale_dati where id = 'unico' for update;
  else select dati into d from gestionale_dati where id = 'unico'; end if;
  select t.c into c from agente_trova_cantiere(d, p->>'cantiere') t;
  if c->>'stato' = 'concluso' then avvisi := avvisi || format('Il cantiere «%s» risulta concluso.', c->>'nome'); end if;

  if d->'presenze' is null or jsonb_typeof(d->'presenze') <> 'object' then d := jsonb_set(d, '{presenze}', '{}'); end if;
  if d->'presenze'->dt is null then d := jsonb_set(d, array['presenze', dt], '{}'); end if;

  for pe in select jsonb_array_elements(p->'persone') loop
    if jsonb_typeof(pe) = 'string' then pe := jsonb_build_object('nome', pe #>> '{}'); end if;
    pers := agente_trova_persona(d, pe->>'nome');
    imp := coalesce(nullif(pe->>'importo', '')::numeric, nullif(p->>'importo', '')::numeric);
    if imp is null then
      avvisi := avvisi || format('Importo di %s non indicato: salvato a 0 €, da completare.', pers->>'nome');
      imp := 0;
    end if;
    if imp < 0 then raise exception 'Importo negativo per %', pers->>'nome'; end if;

    cell := d->'presenze'->dt->(pers->>'id');
    if cell is null then
      turni := '[]';
    elsif jsonb_typeof(cell->'turni') = 'array' then
      turni := cell->'turni';
    else -- vecchio formato {cantiere, base, straord, totale} → turno singolo
      turni := jsonb_build_array(jsonb_build_object('id', agente_id('t'), 'cantiere', coalesce(cell->>'cantiere', ''),
                 'oraI', '08:00', 'oraF', '18:00', 'importo', coalesce((cell->>'totale')::numeric, 0), 'notturno', false));
    end if;

    if exists (select 1 from jsonb_array_elements(turni) x where agente_norm(x->>'cantiere') = agente_norm(c->>'nome'))
       and coalesce((p->>'forza_doppione')::boolean, false) is not true then
      raise exception '% ha già un turno su «%» il %. Se è un secondo turno conferma con forza_doppione.', pers->>'nome', c->>'nome', to_char(dt::date, 'DD/MM/YYYY');
    end if;
    if jsonb_array_length(turni) > 0 then
      avvisi := avvisi || format('%s ha già altri turni il %s: %s', pers->>'nome', to_char(dt::date, 'DD/MM'),
        (select string_agg(format('%s %s-%s', x->>'cantiere', x->>'oraI', x->>'oraF'), '; ') from jsonb_array_elements(turni) x));
    end if;

    turno := jsonb_build_object('id', agente_id('t'), 'cantiere', c->>'nome', 'oraI', oi, 'oraF', ofi, 'importo', imp, 'notturno', nott);
    if nullif(p->>'note', '') is not null then turno := turno || jsonb_build_object('note', p->>'note'); end if;
    turni := turni || turno;
    cell := coalesce(cell, '{}') - 'cantiere' - 'base' - 'straord' || jsonb_build_object('turni', turni,
              'totale', (select coalesce(sum(coalesce((x->>'importo')::numeric, 0)), 0) from jsonb_array_elements(turni) x));
    d := jsonb_set(d, array['presenze', dt, pers->>'id'], cell);
    scritti := scritti || jsonb_build_object('id', pers->>'id', 'nome', pers->>'nome', 'importo', imp);
    righe := righe || format('%s € %s', pers->>'nome', agente_eur(imp));
    tot := tot + imp;
  end loop;

  ris := jsonb_build_object('eseguito', conferma, 'data', dt, 'cantiere', c->>'nome', 'ora_inizio', oi, 'ora_fine', ofi,
    'notturno', nott, 'persone', scritti, 'totale', tot, 'avvisi', to_jsonb(avvisi),
    'riepilogo', format('Presenze %s su «%s» %s–%s%s: %s (tot € %s)', to_char(dt::date, 'DD/MM/YYYY'), c->>'nome', oi, ofi,
      case when nott then ' 🌙' else '' end, array_to_string(righe, ', '), agente_eur(tot)));
  if not conferma then return ris; end if;
  perform agente_scrivi(d, canale);
  perform agente_registra(canale, 'aggiungi_presenza', p, jsonb_build_object('data', dt, 'cantiere', c->>'nome', 'persone', scritti));
  return ris;
end $$;

-- ═══ 4. CREA PREVENTIVO (tabella preventivi, stato bozza) ═══
-- p: cliente*, oggetto*, righe* [{descrizione*, qta, prezzo}], cliente_indirizzo, cliente_piva, cliente_riferimento,
--    rif_richiesta, intro, note_finali, validita, modalita (dettagliata|corpo), iva_tipo (normale|split|art7quater), cantiere
create or replace function public.agente_crea_preventivo(p jsonb, conferma boolean default false, canale text default 'claude')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  d jsonb; cli_txt text := btrim(coalesce(p->>'cliente', '')); r jsonb; v_righe jsonb := '[]'; imp numeric := 0; iva numeric;
  q numeric; pr numeric; cp record; cg jsonb; ind text; piva text; rif text; c jsonb; anno text; mx int; v_numero text;
  v_modalita text := coalesce(nullif(p->>'modalita', ''), 'dettagliata'); v_iva_tipo text := coalesce(nullif(p->>'iva_tipo', ''), 'normale');
  avvisi text[] := '{}'; ris jsonb; nid bigint;
begin
  if cli_txt = '' then raise exception 'Serve il cliente del preventivo'; end if;
  if coalesce(btrim(p->>'oggetto'), '') = '' then raise exception 'Serve l''oggetto del preventivo'; end if;
  if coalesce(jsonb_typeof(p->'righe'), '') <> 'array' or jsonb_array_length(p->'righe') = 0 then raise exception 'Servono le righe del preventivo (descrizione, quantità, prezzo)'; end if;
  if v_modalita not in ('dettagliata', 'corpo') then raise exception 'Modalità «%» non valida: dettagliata o corpo', v_modalita; end if;
  if v_iva_tipo not in ('normale', 'split', 'art7quater') then raise exception 'Tipo IVA «%» non valido: normale, split, art7quater', v_iva_tipo; end if;

  for r in select jsonb_array_elements(p->'righe') loop
    if coalesce(btrim(r->>'descrizione'), '') = '' then raise exception 'Ogni riga deve avere una descrizione'; end if;
    q := coalesce(nullif(r->>'qta', '')::numeric, 1);
    pr := coalesce(nullif(r->>'prezzo', '')::numeric, 0);
    if pr = 0 then avvisi := avvisi || format('Riga «%s» senza prezzo.', left(r->>'descrizione', 60)); end if;
    v_righe := v_righe || jsonb_build_object('qta', q, 'prezzo', pr, 'descrizione', btrim(r->>'descrizione'));
    imp := imp + q * pr;
  end loop;
  imp := round(imp, 2);
  iva := round(imp * 22) / 100;   -- stesso calcolo delle app (IVA 22% memorizzata anche per split/art7quater)

  -- dati cliente: prima dalla rubrica Preventivi, poi dall'anagrafica clienti del Gestionale
  select dati into d from gestionale_dati where id = 'unico';
  select * into cp from clienti_preventivi where agente_norm(nome) = agente_norm(cli_txt) limit 1;
  select x into cg from jsonb_array_elements(coalesce(d->'clienti', '[]')) x
   where agente_norm(coalesce(x->>'ragioneSociale', x->>'nome')) = agente_norm(cli_txt) limit 1;
  ind := coalesce(nullif(p->>'cliente_indirizzo', ''), cp.indirizzo, cg->>'indirizzo');
  piva := coalesce(nullif(p->>'cliente_piva', ''), cp.piva, cg->>'piva');
  rif := coalesce(nullif(p->>'cliente_riferimento', ''), cp.riferimento, cg->>'referente');
  if cp.nome is null and cg is null then
    avvisi := avvisi || format('Cliente «%s» non trovato né in rubrica Preventivi né in anagrafica: completa indirizzo e P.IVA se servono.', cli_txt);
  end if;

  if nullif(p->>'cantiere', '') is not null then
    select t.c into c from agente_trova_cantiere(d, p->>'cantiere') t;
  end if;

  if conferma then perform pg_advisory_xact_lock(81100001); end if;   -- numerazione senza doppioni
  anno := to_char(agente_oggi(), 'YYYY');
  select coalesce(max((regexp_match(numero, '^PREV-' || anno || '-(\d+)$'))[1]::int), 0) into mx from preventivi;
  v_numero := format('PREV-%s-%s', anno, lpad((mx + 1)::text, 3, '0'));

  ris := jsonb_build_object('eseguito', conferma, 'numero', v_numero, 'cliente', coalesce(cp.nome, cg->>'ragioneSociale', cli_txt),
    'cliente_indirizzo', ind, 'cliente_piva', piva, 'cliente_riferimento', rif, 'oggetto', p->>'oggetto', 'righe', v_righe,
    'imponibile', imp, 'iva', iva, 'totale', round(imp + iva, 2), 'iva_tipo', v_iva_tipo,
    'cantiere', case when c is null then null else jsonb_build_object('id', c->>'id', 'nome', c->>'nome') end,
    'avvisi', to_jsonb(avvisi),
    'riepilogo', format('Preventivo %s (bozza) per %s — %s · %s righe · imponibile € %s + IVA € %s = € %s%s',
      v_numero, coalesce(cp.nome, cg->>'ragioneSociale', cli_txt), p->>'oggetto', jsonb_array_length(v_righe),
      agente_eur(imp), agente_eur(iva), agente_eur(round(imp + iva, 2)),
      case when v_iva_tipo = 'split' then ' (split payment)' when v_iva_tipo = 'art7quater' then ' (art. 7-quater)' else '' end));
  if not conferma then
    return ris || jsonb_build_object('nota', 'Il numero definitivo viene assegnato al salvataggio.');
  end if;

  insert into preventivi(numero, data, cliente_nome, cliente_indirizzo, cliente_piva, cliente_riferimento, rif_richiesta, oggetto,
                         intro, modalita, righe, imponibile, iva_tipo, iva_perc, iva_importo, totale, validita, note_finali, stato,
                         cantiere_ref, cantiere_id)
  values (v_numero, agente_oggi(), coalesce(cp.nome, cg->>'ragioneSociale', cli_txt), ind, piva, rif, nullif(p->>'rif_richiesta', ''), p->>'oggetto',
          coalesce(nullif(p->>'intro', ''), 'In riscontro alla Vostra richiesta in oggetto, con la presente si formula la seguente offerta economica per quanto di seguito indicato:'),
          v_modalita, v_righe, imp, v_iva_tipo, 22, iva, round(imp + iva, 2),
          coalesce(nullif(p->>'validita', ''), '30 giorni dalla data del presente preventivo'),
          coalesce(nullif(p->>'note_finali', ''), 'Restando a disposizione per eventuali sopralluoghi ed ogni ulteriore chiarimento, si porgono distinti saluti.'),
          'bozza', c->>'id', c->>'id')
  returning id into nid;
  perform agente_registra(canale, 'crea_preventivo', p, jsonb_build_object('id', nid, 'numero', v_numero));
  return ris || jsonb_build_object('id', nid);
end $$;

-- ─── permessi: solo service_role (le Edge Function) ───
do $$
declare f text;
begin
  foreach f in array array[
    'agente_norm(text)', 'agente_oggi()', 'agente_eur(numeric)', 'agente_id(text)', 'agente_data(text,text)', 'agente_ora(text,text)',
    'agente_trova_cantiere(jsonb,text)', 'agente_trova_persona(jsonb,text)', 'agente_intervento(jsonb,jsonb,text)',
    'agente_conflitti(jsonb,jsonb,text)', 'agente_scrivi(jsonb,text)', 'agente_registra(text,text,jsonb,jsonb)',
    'agente_sync_commessa(jsonb,numeric)',
    'agente_crea_cantiere(jsonb,boolean,text)', 'agente_aggiungi_lavorazione(jsonb,boolean,text)',
    'agente_aggiungi_presenza(jsonb,boolean,text)', 'agente_crea_preventivo(jsonb,boolean,text)']
  loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
