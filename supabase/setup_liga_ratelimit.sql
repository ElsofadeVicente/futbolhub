-- ═══════════════════════════════════════════════════════════════════
-- Rate limiting para las RPC de liga abiertas a anon
-- ═══════════════════════════════════════════════════════════════════
-- liga_panel y liga_top100 son las únicas funciones de liga con
-- `grant execute ... to authenticated, anon` (ver setup_liga.sql), así
-- que cualquiera puede llamarlas en bucle sin estar logueado. No es un
-- problema de fuga de datos (la clasificación ya es pública) sino de
-- coste/carga: alguien podría machacarlas para ralentizar la BD o
-- inflar el consumo de Supabase. Ver backlog de seguridad, punto 4.
--
-- Ejecutar DESPUÉS de setup_liga.sql (sustituye esas dos funciones).
-- Idempotente: se puede volver a correr sin problema.

-- ─── 1) Contador genérico de golpes por clave, ventana deslizante ────
create table if not exists public.rl_hits (
  key text        not null,
  ts  timestamptz not null default now()
);
create index if not exists rl_hits_key_ts_idx on public.rl_hits (key, ts);

alter table public.rl_hits enable row level security;
revoke all on public.rl_hits from anon, authenticated;

create or replace function public.rl_allow(p_key text, p_limit int, p_window_sec int)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  delete from rl_hits where key = p_key and ts < now() - make_interval(secs => p_window_sec);
  select count(*) into v_count from rl_hits where key = p_key;
  if v_count >= p_limit then
    return false;
  end if;
  insert into rl_hits(key) values (p_key);
  return true;
end;
$$;
revoke all on function public.rl_allow(text, int, int) from anon, authenticated;

-- ─── 2) liga_panel: throttle por usuario ──────────────────────────────
-- Ya es barata para anon (corta en seco si auth.uid() es null, sin
-- consultar nada). El coste real es por usuario autenticado consultando
-- su división; 20 llamadas/minuto es de sobra para el uso normal (una
-- por apertura de panel) y corta a quien la llame en bucle.
create or replace function liga_panel(p_juego text default 'el-estadio')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user     uuid := auth.uid();
  v_semana   date := liga_semana_de(now());
  v_tramo    smallint;
  v_division bigint;
  v_clasif   jsonb;
begin
  if v_user is null then
    return jsonb_build_object('auth', false);
  end if;

  if not rl_allow('liga_panel:' || v_user::text, 20, 60) then
    raise exception 'rate_limited' using errcode = '42901';
  end if;

  select tramo into v_tramo from liga_estado
  where user_id = v_user and juego = p_juego;
  if v_tramo is null then v_tramo := 0; end if;

  select division_id into v_division
  from liga_miembros
  where juego = p_juego and semana = v_semana and user_id = v_user;

  if v_division is not null then
    select jsonb_agg(row_to_json(t) order by t.pos) into v_clasif
    from (
      select m.user_id,
             p.username,
             p.avatar_url,
             m.puntos,
             row_number() over (order by m.puntos desc, m.entro asc) as pos
      from liga_miembros m
      join profiles p on p.id = m.user_id
      where m.division_id = v_division
    ) t;
  end if;

  return jsonb_build_object(
    'auth', true,
    'juego', p_juego,
    'tramo', v_tramo,
    'semana', v_semana,
    'division_id', v_division,
    'yo', v_user,
    'sube', 10,
    'baja', 10,
    'cap', 50,
    'clasificacion', coalesce(v_clasif, '[]'::jsonb));
end;
$$;

-- ─── 3) liga_top100: caché con TTL en vez de throttle por llamante ────
-- Esta sí es cara siempre (agrega liga_diarios) y no hay identidad de
-- llamante para anon (no hay IP fiable a nivel de función Postgres).
-- La defensa correcta aquí no es contar llamadas por IP sino acotar
-- cuántas veces se recalcula de verdad: como el top100 no necesita ser
-- exacto al segundo, se sirve desde caché si tiene menos de 30s y solo
-- se recalcula pasado ese tiempo, sin importar cuántas veces la llamen.
create table if not exists public.liga_top100_cache (
  juego       text primary key,
  payload     jsonb       not null,
  computed_at timestamptz not null default now()
);
alter table public.liga_top100_cache enable row level security;
revoke all on public.liga_top100_cache from anon, authenticated;

create or replace function liga_top100(p_juego text default 'el-estadio')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mes     date := liga_mes_de(now());
  v_mes_fin date := (date_trunc('month', (now() at time zone 'Europe/Madrid')) + interval '1 month')::date;
  v_list    jsonb;
  v_cached  jsonb;
  v_when    timestamptz;
  v_result  jsonb;
begin
  select payload, computed_at into v_cached, v_when
  from liga_top100_cache where juego = p_juego;

  if v_cached is not null and v_when > now() - interval '30 seconds' then
    return v_cached;
  end if;

  select jsonb_agg(row_to_json(t) order by t.puesto) into v_list
  from (
    select row_number() over (order by s.puntos desc) as puesto,
           s.user_id, p.username, p.avatar_url, s.puntos
    from (
      select di.user_id, sum(di.puntos) as puntos
      from liga_diarios di
      join liga_estado e
        on e.user_id = di.user_id and e.juego = di.juego
      where di.juego = p_juego
        and e.tramo = 7                       -- solo Mundial
        and di.dia >= v_mes and di.dia < v_mes_fin
      group by di.user_id
      order by puntos desc
      limit 100
    ) s
    join profiles p on p.id = s.user_id
  ) t;

  v_result := jsonb_build_object('mes', v_mes, 'top100', coalesce(v_list, '[]'::jsonb));

  insert into liga_top100_cache(juego, payload, computed_at)
  values (p_juego, v_result, now())
  on conflict (juego) do update set payload = excluded.payload, computed_at = excluded.computed_at;

  return v_result;
end;
$$;

grant execute on function liga_panel(text)  to authenticated, anon;
grant execute on function liga_top100(text) to authenticated, anon;
