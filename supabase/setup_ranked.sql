-- =====================================================================
-- RANKED — Clasificatoria 1v1 por ELO (PLAN-coche-ranked.md)
-- Pegar entero en el SQL Editor de Supabase y darle a Run. Idempotente.
-- Requiere setup_perfiles.sql (tabla profiles) y setup_liga_ratelimit.sql
-- (reutiliza rl_allow/rl_hits para el throttle de las RPC de lectura).
--
-- DIFERENCIA DE FONDO CON setup_liga.sql: la liga de El Estadio es
-- ASÍNCRONA (sumas puntos del día, el servidor solo agrega) y su recompute
-- vive en Postgres porque la fórmula de puntuación es SQL puro. Ranked es
-- 1v1 EN VIVO y la validación de cada respuesta necesita el motor JS
-- (js/ranked-engine.js + js/futbol-restrictions.js) contra los chunks de
-- jugadores, así que esa parte vive en el árbitro de Node (api/ranked.js),
-- que escribe aquí con la service_role key (salta RLS por diseño: es el
-- único escritor de rating/récord/partidas). Estas tablas NO tienen
-- políticas de INSERT/UPDATE para nadie — ni para "authenticated" — a
-- propósito: la única puerta de escritura es el service_role del árbitro.
--
-- Genérico por "juego" desde el día 1 (columna en las 5 tablas) aunque
-- este trabajo solo cablea 'coche'. Añadir otro juego más adelante no
-- toca el esquema, solo el árbitro y el botón del juego correspondiente.
-- =====================================================================

-- ─── TABLAS ──────────────────────────────────────────────────────────

create table if not exists ranked_rating (
  juego       text  not null,
  user_id     uuid  not null references profiles(id) on delete cascade,
  elo         int   not null default 200,
  partidas    int   not null default 0,
  victorias   int   not null default 0,
  derrotas    int   not null default 0,
  racha       int   not null default 0,
  provisional boolean not null default true,
  temporada   int   not null default 1,
  updated_at  timestamptz not null default now(),
  primary key (juego, user_id)
);
create index if not exists ranked_rating_leaderboard on ranked_rating (juego, temporada, elo desc);

-- Récord histórico: NUNCA se resetea, ni siquiera al cerrar temporada.
-- "temporadas" acumula una entrada {temporada, tramo, elo} por cada cierre.
create table if not exists ranked_record (
  juego      text not null,
  user_id    uuid not null references profiles(id) on delete cascade,
  elo_max    int  not null default 200,
  tramo_max  smallint not null default 0,
  temporadas jsonb not null default '[]'::jsonb,
  primary key (juego, user_id)
);

create table if not exists ranked_match (
  id             uuid primary key default gen_random_uuid(),
  juego          text not null,
  a_uid          uuid not null references profiles(id) on delete cascade,
  b_uid          uuid not null references profiles(id) on delete cascade,
  seed_base      bigint not null,
  estado         text not null default 'activa' check (estado in ('activa','terminada','abandonada')),
  ganador_uid    uuid references profiles(id),
  a_pts          int not null default 0,
  b_pts          int not null default 0,
  elo_delta_a    int,
  elo_delta_b    int,
  created_at     timestamptz not null default now(),
  deadline       timestamptz not null default (now() + interval '90 seconds')
);
create index if not exists ranked_match_participantes on ranked_match (a_uid, b_uid, estado);

-- Registro AUTORITATIVO de cada respuesta: lo escribe solo el árbitro tras
-- validarla contra su propia semilla, nunca el cliente. "puntos" ya viene
-- validado (0 si la respuesta no cumplía la restricción).
create table if not exists ranked_match_ronda (
  match_id  uuid not null references ranked_match(id) on delete cascade,
  ronda     int  not null,
  uid       uuid not null references profiles(id) on delete cascade,
  answer_id text,
  puntos    int  not null default 0,
  ts        timestamptz not null default now(),
  primary key (match_id, ronda, uid)
);

create table if not exists ranked_season (
  juego     text not null,
  temporada int  not null,
  abre      date not null,
  cierra    date,
  activa    boolean not null default true,
  primary key (juego, temporada)
);
create unique index if not exists ranked_season_activa_unica
  on ranked_season (juego) where activa;

-- ─── ROW LEVEL SECURITY ──────────────────────────────────────────────
-- rating/record/season: lectura pública (leaderboard, perfil, medallas).
-- match/match_ronda: lectura solo para los dos participantes.
-- Ninguna tabla lleva política de escritura: la única vía es el
-- service_role del árbitro, que salta RLS por diseño de Supabase.

alter table ranked_rating      enable row level security;
alter table ranked_record      enable row level security;
alter table ranked_match       enable row level security;
alter table ranked_match_ronda enable row level security;
alter table ranked_season      enable row level security;

drop policy if exists "ranked_rating lectura" on ranked_rating;
drop policy if exists "ranked_record lectura" on ranked_record;
drop policy if exists "ranked_season lectura" on ranked_season;
drop policy if exists "ranked_match participantes" on ranked_match;
drop policy if exists "ranked_match_ronda participantes" on ranked_match_ronda;

create policy "ranked_rating lectura" on ranked_rating for select using (true);
create policy "ranked_record lectura" on ranked_record for select using (true);
create policy "ranked_season lectura" on ranked_season for select using (true);

create policy "ranked_match participantes" on ranked_match
  for select using (auth.uid() = a_uid or auth.uid() = b_uid);

create policy "ranked_match_ronda participantes" on ranked_match_ronda
  for select using (
    exists (
      select 1 from ranked_match m
      where m.id = ranked_match_ronda.match_id
        and (m.a_uid = auth.uid() or m.b_uid = auth.uid())
    )
  );

-- ─── TRAMOS: umbrales cosméticos del ELO (función pura) ───────────────
-- DEBE ser idéntica a tramoDeElo() en js/ranked.js y a la constante
-- TRAMOS_UMBRALES del árbitro (api/ranked.js). Si divergen, el perfil
-- puede mostrar un tramo distinto al que calcula el árbitro al cerrar
-- una partida.
create or replace function ranked_tramo_de_elo(p_elo int)
returns smallint
language sql
immutable
set search_path = public
as $$
  select case
    when p_elo >= 1600 then 7
    when p_elo >= 1350 then 6
    when p_elo >= 1150 then 5
    when p_elo >= 950  then 4
    when p_elo >= 750  then 3
    when p_elo >= 550  then 2
    when p_elo >= 350  then 1
    else 0
  end::smallint;
$$;

-- ─── RPC DE LECTURA (anon + authenticated, con rate-limit/caché) ──────

create or replace function ranked_perfil(p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller uuid := auth.uid();
  v_result jsonb;
begin
  if v_caller is null then
    return jsonb_build_object('auth', false);
  end if;
  if not rl_allow('ranked_perfil:' || v_caller::text, 30, 60) then
    raise exception 'rate_limited' using errcode = '42901';
  end if;

  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) into v_result
  from (
    select
      r.juego,
      r.elo,
      ranked_tramo_de_elo(r.elo) as tramo,
      r.partidas, r.victorias, r.derrotas, r.racha,
      r.provisional, r.temporada,
      coalesce(rec.elo_max, r.elo)                       as elo_max,
      coalesce(rec.tramo_max, ranked_tramo_de_elo(r.elo)) as tramo_max,
      coalesce(rec.temporadas, '[]'::jsonb)               as temporadas
    from ranked_rating r
    left join ranked_record rec on rec.juego = r.juego and rec.user_id = r.user_id
    where r.user_id = p_user
  ) t;

  return jsonb_build_object('auth', true, 'juegos', v_result);
end;
$$;

create table if not exists ranked_leaderboard_cache (
  juego       text not null,
  temporada   int  not null,
  payload     jsonb not null,
  computed_at timestamptz not null default now(),
  primary key (juego, temporada)
);
alter table ranked_leaderboard_cache enable row level security;
revoke all on ranked_leaderboard_cache from anon, authenticated;

create or replace function ranked_leaderboard(p_juego text, p_limit int default 100)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_temporada int;
  v_cached    jsonb;
  v_when      timestamptz;
  v_list      jsonb;
  v_result    jsonb;
  v_yo        jsonb;
begin
  p_limit := least(greatest(p_limit, 1), 200);

  select max(temporada) into v_temporada from ranked_rating where juego = p_juego;
  if v_temporada is null then
    return jsonb_build_object('juego', p_juego, 'temporada', null, 'top', '[]'::jsonb);
  end if;

  select payload, computed_at into v_cached, v_when
  from ranked_leaderboard_cache where juego = p_juego and temporada = v_temporada;

  if v_cached is not null and v_when > now() - interval '30 seconds' then
    v_result := v_cached;
  else
    select coalesce(jsonb_agg(row_to_json(t) order by t.puesto), '[]'::jsonb) into v_list
    from (
      select row_number() over (order by r.elo desc) as puesto,
             r.user_id, p.username, p.avatar_url, r.elo,
             ranked_tramo_de_elo(r.elo) as tramo
      from ranked_rating r
      join profiles p on p.id = r.user_id
      where r.juego = p_juego and r.temporada = v_temporada
      order by r.elo desc
      limit p_limit
    ) t;

    v_result := jsonb_build_object('juego', p_juego, 'temporada', v_temporada, 'top', v_list);

    insert into ranked_leaderboard_cache (juego, temporada, payload, computed_at)
    values (p_juego, v_temporada, v_result, now())
    on conflict (juego, temporada) do update
      set payload = excluded.payload, computed_at = excluded.computed_at;
  end if;

  if auth.uid() is not null then
    select jsonb_build_object(
      'user_id', r.user_id, 'elo', r.elo,
      'tramo', ranked_tramo_de_elo(r.elo),
      'puesto', (select count(*) + 1 from ranked_rating r2
                 where r2.juego = p_juego and r2.temporada = v_temporada and r2.elo > r.elo)
    ) into v_yo
    from ranked_rating r
    where r.juego = p_juego and r.temporada = v_temporada and r.user_id = auth.uid();
  end if;

  return v_result || jsonb_build_object('yo', coalesce(v_yo, 'null'::jsonb));
end;
$$;

-- ─── CIERRE DE TEMPORADA (mensual, blando) ────────────────────────────
-- Idempotente: si la temporada activa de "juego" todavía no ha llegado a
-- su mes de cierre, no hace nada. Pensada para pg_cron (no expuesta a
-- anon/authenticated, igual que liga_cerrar_mes/liga_cerrar_semanas).
create or replace function ranked_cerrar_temporada(p_juego text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hoy        date := (now() at time zone 'Europe/Madrid')::date;
  v_mes_actual date := date_trunc('month', now() at time zone 'Europe/Madrid')::date;
  v_activa     ranked_season%rowtype;
  v_row        ranked_rating%rowtype;
  v_nuevo_elo  int;
begin
  select * into v_activa from ranked_season where juego = p_juego and activa limit 1;

  if v_activa is null then
    -- Primera vez que se toca este juego: abrir temporada 1 y salir.
    insert into ranked_season (juego, temporada, abre, activa)
    values (p_juego, 1, v_mes_actual, true)
    on conflict do nothing;
    return;
  end if;

  -- Solo cierra si ya ha empezado un mes natural distinto al de apertura.
  if v_mes_actual <= v_activa.abre then
    return;
  end if;

  for v_row in select * from ranked_rating where juego = p_juego loop
    insert into ranked_record (juego, user_id, elo_max, tramo_max, temporadas)
    values (
      p_juego, v_row.user_id, v_row.elo, ranked_tramo_de_elo(v_row.elo),
      jsonb_build_array(jsonb_build_object(
        'temporada', v_row.temporada, 'tramo', ranked_tramo_de_elo(v_row.elo), 'elo', v_row.elo))
    )
    on conflict (juego, user_id) do update set
      elo_max    = greatest(ranked_record.elo_max, v_row.elo),
      tramo_max  = greatest(ranked_record.tramo_max, ranked_tramo_de_elo(v_row.elo)),
      temporadas = ranked_record.temporadas || jsonb_build_object(
        'temporada', v_row.temporada, 'tramo', ranked_tramo_de_elo(v_row.elo), 'elo', v_row.elo);

    v_nuevo_elo := greatest(0, round(200 + (v_row.elo - 200) * 0.5));

    update ranked_rating set
      elo = v_nuevo_elo, partidas = 0, victorias = 0, derrotas = 0, racha = 0,
      provisional = true, temporada = v_row.temporada + 1, updated_at = now()
    where juego = p_juego and user_id = v_row.user_id;
  end loop;

  update ranked_season set activa = false, cierra = v_hoy
  where juego = p_juego and temporada = v_activa.temporada;

  insert into ranked_season (juego, temporada, abre, activa)
  values (p_juego, v_activa.temporada + 1, v_mes_actual, true)
  on conflict do nothing;
end;
$$;

-- ─── PERMISOS DE EJECUCIÓN ───────────────────────────────────────────
grant execute on function ranked_perfil(uuid)        to authenticated, anon;
grant execute on function ranked_leaderboard(text,int) to authenticated, anon;

revoke all on function ranked_tramo_de_elo(int)      from public, anon, authenticated;
revoke all on function ranked_cerrar_temporada(text) from public, anon, authenticated;
-- ranked_tramo_de_elo la llaman ranked_perfil/ranked_leaderboard (SECURITY
-- DEFINER, corren como dueño), así que revocarla a anon/authenticated no
-- rompe nada — mismo patrón que rl_allow en setup_liga_ratelimit.sql.
grant execute on function ranked_tramo_de_elo(int) to postgres;

-- ─── pg_cron: cierre mensual, uno por juego cableado ──────────────────
-- Igual que en setup_liga.sql: si pg_cron no está activo, activar la
-- extensión (Database → Extensions → pg_cron) y volver a correr este
-- bloque, o llamar a ranked_cerrar_temporada('coche') a mano.
do $$
begin
  perform cron.schedule('ranked-cierre-coche', '20 * * * *', $c$select ranked_cerrar_temporada('coche');$c$);
exception when undefined_function then
  raise notice 'pg_cron no está activo: activa la extensión y vuelve a ejecutar este bloque, o llama a ranked_cerrar_temporada(''coche'') a mano.';
end $$;
