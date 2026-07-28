-- =====================================================================
-- LIGA COMPETITIVA — divisiones semanales + Top 100 mensual (Mundial)
-- Pegar entero en el SQL Editor de Supabase y darle a Run. Idempotente:
-- se puede ejecutar varias veces sin romper nada. Requiere haber
-- ejecutado antes setup_perfiles.sql (usa la tabla profiles).
--
-- IDEA
--   El Estadio ya es un juego DIARIO y determinista: todo el mundo juega
--   los mismos 5 estadios cada día (semilla por fecha), así que las
--   puntuaciones del día son comparables. Sobre eso montamos una liga
--   estilo Duolingo con temática de fútbol:
--
--     · Cada semana (lun→dom, hora de Madrid) estás en una DIVISIÓN de
--       ~50 jugadores de tu mismo TRAMO.
--     · Cada día sumas a tu marcador de la semana el total de la partida
--       diaria (las repeticiones casual NO cuentan).
--     · Al cerrar la semana: los 10 mejores de tu división ASCIENDEN un
--       tramo, los 10 peores DESCIENDEN, el resto se queda.
--     · TRAMOS (0..7):
--         0 Tercera División   4 Conference League
--         1 Segunda B          5 Europa League
--         2 Segunda División   6 Champions League
--         3 Primera División   7 Mundial   (techo de la liga)
--     · TOP 100 MENSUAL: aparte, solo entre jugadores de Mundial. Se
--       ordena por los puntos del MES natural y se guarda una foto al
--       cerrar el mes (salón de la fama).
--
--   Anti-trampas (primera versión): el juego calcula el total y lo sube
--   tal cual por la función liga_enviar_diario. Confiamos en ese número,
--   pero el reparto en divisiones, la suma semanal y los ascensos los
--   controla el servidor (RLS + funciones SECURITY DEFINER). Endurecerlo
--   más adelante (recalcular desde los pins) sería tocar solo esa función.
--
--   Los nombres de los tramos viven en el cliente (js/liga.js); aquí el
--   tramo es un número 0..7 para no acoplar la base de datos al texto.
-- =====================================================================

-- ─── TABLAS ──────────────────────────────────────────────────────────

-- Tramo persistente de cada usuario (dónde está en la escalera). La
-- columna "juego" deja preparado el sistema para más juegos en el futuro.
create table if not exists liga_estado (
  user_id     uuid not null references profiles(id) on delete cascade,
  juego       text not null default 'el-estadio',
  tramo       smallint not null default 0 check (tramo between 0 and 7),
  actualizado timestamptz not null default now(),
  primary key (user_id, juego)
);

-- Cada división es una cohorte para un juego + tramo + semana.
create table if not exists liga_divisiones (
  id       bigint generated always as identity primary key,
  juego    text not null default 'el-estadio',
  tramo    smallint not null check (tramo between 0 and 7),
  semana   date not null,                 -- lunes (hora de Madrid) de la semana
  resuelta boolean not null default false,-- ya se aplicaron ascensos/descensos
  creada   timestamptz not null default now()
);
create index if not exists liga_div_busqueda on liga_divisiones (juego, tramo, semana);

-- Pertenencia semanal + puntos acumulados. "juego" y "semana" van
-- denormalizados para poder exigir "un usuario, una sola división por
-- juego y semana" y para consultar rápido.
create table if not exists liga_miembros (
  division_id bigint not null references liga_divisiones(id) on delete cascade,
  user_id     uuid   not null references profiles(id) on delete cascade,
  juego       text   not null,
  semana      date   not null,
  puntos      int    not null default 0,
  entro       timestamptz not null default now(),
  primary key (division_id, user_id)
);
create unique index if not exists liga_miembros_unico
  on liga_miembros (juego, semana, user_id);
create index if not exists liga_miembros_division on liga_miembros (division_id);

-- El resultado diario que sube el cliente (fuente de la suma semanal y
-- mensual). Un solo registro por usuario/juego/día: el primer envío manda.
create table if not exists liga_diarios (
  user_id uuid not null references profiles(id) on delete cascade,
  juego   text not null default 'el-estadio',
  dia     date not null,
  puntos  int  not null check (puntos between 0 and 25000),
  subido  timestamptz not null default now(),
  primary key (user_id, juego, dia)
);
create index if not exists liga_diarios_dia on liga_diarios (juego, dia);

-- Salón de la fama: foto mensual del Top 100 de Mundial.
create table if not exists liga_top100_historico (
  mes     date not null,                  -- primer día del mes
  juego   text not null default 'el-estadio',
  puesto  int  not null,
  user_id uuid not null references profiles(id) on delete cascade,
  puntos  int  not null,
  primary key (mes, juego, puesto)
);

-- ─── ROW LEVEL SECURITY ──────────────────────────────────────────────
-- Lectura pública (la clasificación se enseña a todos, igual que el
-- username/avatar de profiles). NADIE escribe estas tablas a mano desde
-- el navegador: todas las escrituras pasan por funciones SECURITY DEFINER
-- (más abajo), que corren como dueño y saltan la RLS de forma controlada.

alter table liga_estado           enable row level security;
alter table liga_divisiones       enable row level security;
alter table liga_miembros         enable row level security;
alter table liga_diarios          enable row level security;
alter table liga_top100_historico enable row level security;

drop policy if exists "liga_estado lectura"     on liga_estado;
drop policy if exists "liga_divisiones lectura" on liga_divisiones;
drop policy if exists "liga_miembros lectura"   on liga_miembros;
drop policy if exists "liga_diarios lectura"    on liga_diarios;
drop policy if exists "liga_top100 lectura"     on liga_top100_historico;

create policy "liga_estado lectura"     on liga_estado           for select using (true);
create policy "liga_divisiones lectura" on liga_divisiones       for select using (true);
create policy "liga_miembros lectura"   on liga_miembros         for select using (true);
create policy "liga_diarios lectura"    on liga_diarios          for select using (true);
create policy "liga_top100 lectura"     on liga_top100_historico for select using (true);

-- ─── HELPERS DE FECHA (hora de Madrid) ───────────────────────────────
-- date_trunc('week', ...) usa el lunes como inicio (norma ISO). Trabajar
-- siempre en "Europe/Madrid" para que el corte semanal/mensual caiga a
-- medianoche local y no dependa del huso del servidor.

create or replace function liga_semana_de(ts timestamptz)
returns date language sql immutable as $$
  select date_trunc('week',  (ts at time zone 'Europe/Madrid'))::date;
$$;

create or replace function liga_mes_de(ts timestamptz)
returns date language sql immutable as $$
  select date_trunc('month', (ts at time zone 'Europe/Madrid'))::date;
$$;

-- ─── INTERNA: colocar al usuario en una división con hueco ───────────
-- Busca una división del tramo/semana con menos de 50 miembros; si no hay,
-- crea una nueva. Devuelve la división en la que queda el usuario.
create or replace function liga_asignar_division(
  p_user uuid, p_juego text, p_tramo smallint, p_semana date)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_division bigint;
  v_cap int := 50;
begin
  select d.id into v_division
  from liga_divisiones d
  where d.juego = p_juego and d.tramo = p_tramo and d.semana = p_semana
    and (select count(*) from liga_miembros m where m.division_id = d.id) < v_cap
  order by d.id
  limit 1;

  if v_division is null then
    insert into liga_divisiones (juego, tramo, semana)
    values (p_juego, p_tramo, p_semana)
    returning id into v_division;
  end if;

  insert into liga_miembros (division_id, user_id, juego, semana, puntos)
  values (v_division, p_user, p_juego, p_semana, 0)
  on conflict (juego, semana, user_id) do nothing;

  -- Releer: si el usuario ya estaba en otra división de esta semana, el
  -- on conflict no insertó y hay que devolver la que ya tenía.
  select division_id into v_division
  from liga_miembros
  where juego = p_juego and semana = p_semana and user_id = p_user;

  return v_division;
end;
$$;

-- ─── RPC: subir el resultado del día ─────────────────────────────────
-- La llama el juego al terminar la partida diaria. Guarda el diario (una
-- vez por día), coloca al usuario en su división si aún no está y recalcula
-- su marcador de la semana. Devuelve {tramo, division_id, puntos, dia}.
create or replace function liga_enviar_diario(
  p_juego text default 'el-estadio', p_puntos int default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user     uuid     := auth.uid();
  v_dia      date     := (now() at time zone 'Europe/Madrid')::date;
  v_semana   date     := liga_semana_de(now());
  v_tramo    smallint;
  v_division bigint;
  v_total    int;
begin
  if v_user is null then
    raise exception 'No autenticado';
  end if;
  if p_juego is null then p_juego := 'el-estadio'; end if;
  if p_puntos is null or p_puntos < 0 or p_puntos > 25000 then
    raise exception 'Puntos fuera de rango (0..25000)';
  end if;

  -- 1) Guardar el diario. El primer envío del día manda; los reenvíos se
  --    ignoran (no se puede regrabar una puntuación mejor a mano).
  insert into liga_diarios (user_id, juego, dia, puntos)
  values (v_user, p_juego, v_dia, p_puntos)
  on conflict (user_id, juego, dia) do nothing;

  -- 2) Tramo persistente (usuario nuevo => Tercera División).
  insert into liga_estado (user_id, juego, tramo)
  values (v_user, p_juego, 0)
  on conflict (user_id, juego) do nothing;
  select tramo into v_tramo from liga_estado
  where user_id = v_user and juego = p_juego;

  -- 3) Asegurar pertenencia a una división de esta semana en su tramo.
  select division_id into v_division
  from liga_miembros
  where juego = p_juego and semana = v_semana and user_id = v_user;
  if v_division is null then
    v_division := liga_asignar_division(v_user, p_juego, v_tramo, v_semana);
  end if;

  -- 4) Recalcular el marcador de la semana (suma de los diarios lun..dom).
  select coalesce(sum(puntos), 0) into v_total
  from liga_diarios
  where user_id = v_user and juego = p_juego
    and dia >= v_semana and dia < v_semana + 7;

  update liga_miembros set puntos = v_total
  where division_id = v_division and user_id = v_user;

  return jsonb_build_object(
    'tramo', v_tramo, 'division_id', v_division,
    'puntos', v_total, 'dia', v_dia);
end;
$$;

-- ─── RPC: datos del panel de liga del usuario ────────────────────────
-- Devuelve su tramo, la semana en curso y la clasificación de su división
-- (con username y avatar para pintar las fotos). Si no ha jugado esta
-- semana todavía, "division_id" es null y la clasificación va vacía.
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

-- ─── RPC: Top 100 mensual (solo jugadores de Mundial) ────────────────
-- Ranking en vivo del mes en curso entre los usuarios que están HOY en
-- el tramo Mundial (7), por puntos acumulados del mes. Con foto de perfil.
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
begin
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

  return jsonb_build_object('mes', v_mes, 'top100', coalesce(v_list, '[]'::jsonb));
end;
$$;

-- ─── CIERRE SEMANAL (ascensos/descensos) ─────────────────────────────
-- Idempotente: resuelve TODA división cuya semana ya terminó y que aún no
-- esté resuelta. Así da igual si el cron llega tarde o corre dos veces.
-- Los usuarios que no jugaron esa semana no tienen fila en ninguna
-- división → no se les toca (no hay descenso por inactividad).
create or replace function liga_cerrar_semanas()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_semana_actual date := liga_semana_de(now());
  d      record;
  v_n    int;
  v_sube int := 10;
  v_baja int := 10;
begin
  for d in
    select * from liga_divisiones
    where semana < v_semana_actual and resuelta = false
    order by semana, id
  loop
    select count(*) into v_n from liga_miembros where division_id = d.id;

    with ranked as (
      select user_id,
             row_number() over (order by puntos desc, entro asc) as pos
      from liga_miembros
      where division_id = d.id
    )
    update liga_estado e
    set tramo = greatest(0, least(7,
          e.tramo
          + case when r.pos <= v_sube        and d.tramo < 7 then 1 else 0 end
          - case when r.pos >  v_n - v_baja  and d.tramo > 0 then 1 else 0 end)),
        actualizado = now()
    from ranked r
    where e.user_id = r.user_id and e.juego = d.juego;

    update liga_divisiones set resuelta = true where id = d.id;
  end loop;
end;
$$;

-- ─── CIERRE MENSUAL (foto del Top 100 de Mundial) ────────────────────
-- Idempotente: si el mes anterior aún no tiene foto, la guarda. Congela el
-- ranking del mes que acaba de terminar para el salón de la fama.
create or replace function liga_cerrar_mes()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mes_actual date := liga_mes_de(now());
  v_mes        date := (v_mes_actual - interval '1 month')::date;
  v_juego      text := 'el-estadio';
begin
  if exists (select 1 from liga_top100_historico where mes = v_mes and juego = v_juego) then
    return;
  end if;

  insert into liga_top100_historico (mes, juego, puesto, user_id, puntos)
  select v_mes, v_juego,
         row_number() over (order by s.puntos desc),
         s.user_id, s.puntos
  from (
    select di.user_id, sum(di.puntos) as puntos
    from liga_diarios di
    join liga_estado e
      on e.user_id = di.user_id and e.juego = di.juego
    where di.juego = v_juego
      and e.tramo = 7
      and di.dia >= v_mes and di.dia < v_mes_actual
    group by di.user_id
    order by puntos desc
    limit 100
  ) s;
end;
$$;

-- ─── PERMISOS DE EJECUCIÓN ───────────────────────────────────────────
-- Enviar el diario exige sesión (authenticated). Leer el panel/Top 100 se
-- permite también a anon por si algún día se enseña sin login; hoy el
-- cliente lo pinta borroso a los no logueados. Las funciones internas y de
-- cierre NO se exponen (solo las llaman otras funciones o el cron).
grant execute on function liga_enviar_diario(text, int) to authenticated;
grant execute on function liga_panel(text)              to authenticated, anon;
grant execute on function liga_top100(text)             to authenticated, anon;
revoke execute on function liga_asignar_division(uuid, text, smallint, date) from public;
revoke execute on function liga_cerrar_semanas() from public;
revoke execute on function liga_cerrar_mes()     from public;

-- ─── CRON (opcional pero recomendado) ────────────────────────────────
-- Los cierres son idempotentes, así que basta con dispararlos a menudo:
-- programándolos cada hora evitamos pelearnos con el cambio de hora (DST)
-- y con la diferencia entre UTC y Madrid. Requiere la extensión pg_cron
-- (Supabase: Database → Extensions → activar "pg_cron").
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('liga-cierre-semanal', '5 * * * *',  'select liga_cerrar_semanas();');
    perform cron.schedule('liga-cierre-mensual', '15 * * * *', 'select liga_cerrar_mes();');
  else
    raise notice 'pg_cron no está activo: activa la extensión y vuelve a ejecutar este bloque, o llama a liga_cerrar_semanas()/liga_cerrar_mes() a mano.';
  end if;
end $$;
