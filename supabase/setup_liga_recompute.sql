-- =====================================================================
-- LIGA — ANTI-TRAMPAS: recálculo de la puntuación en el servidor
-- Pegar entero en el SQL Editor de Supabase y darle a Run. Idempotente:
-- se puede ejecutar varias veces. Requiere haber ejecutado antes
-- setup_liga.sql (usa las tablas liga_diarios, liga_estado, etc.).
--
-- POR QUÉ
--   Hasta ahora liga_enviar_diario CONFIABA en el número que mandaba el
--   cliente (solo comprobaba el rango 0..25000). Cualquiera con sesión
--   podía abrir la consola y hacer:
--       FHAuth.client.rpc('liga_enviar_diario', { p_puntos: 25000 })
--   y plantarse en Mundial sin jugar. Esto lo cierra: el cliente ya no
--   manda el total, manda las 5 PISTAS (qué estadio + dónde puso el pin)
--   y el servidor RECALCULA la puntuación con la misma fórmula que el
--   juego, usando las coordenadas reales que guarda aquí (no las que
--   diga el cliente).
--
-- LÍMITE CONOCIDO (imposible de cerrar en un GeoGuessr)
--   La coordenada real del estadio viaja al navegador dentro del iframe
--   de Street View (cbll=lat,lng), así que alguien que lea ese iframe
--   puede clavar el pin y sacar 25.000. Eso es indistinguible de jugar
--   perfecto y no se puede impedir. Lo que SÍ matamos aquí es el truco
--   fácil y realista de inventarse el número desde la consola.
--
-- CONVENCIÓN "datos en JSON, no en tablas"
--   La tabla el_estadio_coords es una EXCEPCIÓN justificada: no sirve
--   datos de juego al cliente (el juego los sigue leyendo de Storage);
--   es solo metadato de VALIDACIÓN que necesita el servidor para poder
--   recalcular. 44 filas, se resiembran abajo desde estadios.json.
-- =====================================================================

-- ─── TABLA DE VALIDACIÓN: coords reales de cada estadio ──────────────
-- id = mismo identificador que estadios.json (el que el juego mete en
-- state.rondas[i].id). lat/lng = coordenada oficial del estadio.
create table if not exists el_estadio_coords (
  id  text primary key,
  lat double precision not null,
  lng double precision not null
);

-- Nadie la lee desde el navegador: RLS activada y SIN políticas de
-- lectura. La función de recálculo (SECURITY DEFINER) la lee como dueña,
-- saltando la RLS de forma controlada. Así no se puede volcar por
-- PostgREST (aunque las coords estén en el iframe, no hace falta servirlas).
alter table el_estadio_coords enable row level security;

-- ─── SEMILLA: 44 estadios (regenerada desde el-estadio/data/estadios.json)
-- Al cambiar el dataset, volver a generar este bloque (o añadirlo al sync).
-- upsert: re-ejecutar actualiza coords y no duplica.
insert into el_estadio_coords (id, lat, lng) values
  ('abanca-balaidos', 42.21198, -8.73826),
  ('av-n-colombino', 37.24623, -6.95527),
  ('campo-de-futbol-de-vallecas', 40.39237, -3.6592),
  ('coliseum-alfonso-perez', 40.32581, -3.71649),
  ('estadi-municipal-de-montilivi', 41.96095, 2.82713),
  ('estadi-olimpic-lluis-companys', 41.36453, 2.15765),
  ('estadio-abanca-riazor', 43.36787, -8.41767),
  ('estadio-benito-villamarin', 37.35563, -5.98104),
  ('estadio-butarque', 40.34038, -3.75964),
  ('estadio-carlos-belmonte', 38.98101, -1.85312),
  ('estadio-ciudad-de-valencia', 39.49519, -0.36484),
  ('estadio-de-gran-canaria', 28.10046, -15.45749),
  ('estadio-de-wembley', 51.55522, -0.27754),
  ('estadio-el-molinon-enrique-castro-quini', 43.53637, -5.63865),
  ('estadio-el-sadar', 42.79702, -1.63824),
  ('estadio-el-sardinero', 43.47609, -3.79429),
  ('estadio-enrique-roca-de-murcia', 38.04166, -1.14584),
  ('estadio-jose-rico-perez', 38.35731, -0.49374),
  ('estadio-jose-zorrilla', 41.64504, -4.76002),
  ('estadio-juegos-del-mediterraneo', 36.84007, -2.43571),
  ('estadio-la-rosaleda', 36.73302, -4.42665),
  ('estadio-mendizorroza', 42.83746, -2.68933),
  ('estadio-municipal-carlos-tartiere', 43.36055, -5.87179),
  ('estadio-municipal-las-gaunas', 42.4535, -2.45451),
  ('estadio-nuevo-arcangel-de-cordoba', 37.87237, -4.7658),
  ('estadio-ramon-de-carranza', 36.50305, -6.27421),
  ('estadio-ramon-sanchez-pizjuan', 37.3838, -5.96959),
  ('estadio-santiago-bernabeu', 40.45196, -3.68829),
  ('estadio-skyfi-castalia', 39.99547, -0.03916),
  ('heliodoro-rodriguez-lopez', 28.46386, -16.2604),
  ('la-cartuja', 37.41707, -6.00671),
  ('la-ceramica', 39.94452, -0.10393),
  ('la-romareda', 41.63645, -0.90184),
  ('manuel-martinez-valero', 38.2663, -0.66217),
  ('mestalla', 39.47453, -0.35685),
  ('nou-estadi-costa-daurada', 41.12784, 1.27228),
  ('nuevo-los-carmenes', 37.15181, -3.59517),
  ('rcde-stadium', 41.34724, 2.07615),
  ('reale-arena', 43.3022, -1.97478),
  ('reino-de-leon', 42.58793, -5.57581),
  ('riyadh-air-metropolitano', 40.43612, -3.60157),
  ('san-mames', 43.26372, -2.94792),
  ('son-moix', 39.58911, 2.63136),
  ('spotify-camp-nou', 41.3802, 2.12154)
on conflict (id) do update set lat = excluded.lat, lng = excluded.lng;

-- ─── PUNTUACIÓN: misma fórmula que el juego (game.js) ────────────────
-- Distancia Haversine (km) entre el pin y el estadio, y decay exponencial:
--   5000 si < 100 m, si no max(0, round(5000 * exp(-distKm/500))), 0 mínimo.
-- Constantes espejo de game.js: MAX_SCORE=5000, DECAY_KM=500, PERFECT_M=100.
create or replace function el_estadio_puntos(
  g_lat double precision, g_lng double precision,
  e_lat double precision, e_lng double precision)
returns int
language plpgsql
immutable
as $$
declare
  r    double precision := 6371;
  dlat double precision := radians(e_lat - g_lat);
  dlng double precision := radians(e_lng - g_lng);
  a    double precision;
  dist double precision;   -- km
begin
  a := sin(dlat / 2) ^ 2
       + cos(radians(g_lat)) * cos(radians(e_lat)) * sin(dlng / 2) ^ 2;
  dist := r * 2 * atan2(sqrt(a), sqrt(1 - a));
  if dist * 1000 < 100 then
    return 5000;
  end if;
  -- ::numeric para que round() sea "half away from zero" como Math.round de JS
  return greatest(0, round((5000 * exp(-dist / 500))::numeric)::int);
end;
$$;

-- ─── RPC: subir el resultado del día (RECALCULANDO en el servidor) ───
-- El cliente ya NO manda el total. Manda p_pistas: un array JSON de 5
-- objetos {id, lat, lng} = qué estadio tocó cada ronda y dónde puso el
-- pin. El servidor busca la coord real de cada id, recalcula la
-- puntuación de las 5 rondas y guarda ESE total (nunca el que diga el
-- cliente). El resto (divisiones, suma semanal, ascensos) sigue igual.
--
-- DESPLIEGUE SIN CORTES: esta función es una SEGUNDA variante (por su
-- parámetro p_pistas jsonb) que CONVIVE con la vieja liga_enviar_diario
-- (text, int) sin ambigüedad — cada cliente resuelve la suya por el
-- nombre de sus argumentos (p_pistas vs p_puntos). Mientras se despliega
-- el JS nuevo, los clientes viejos siguen usando la vieja y nadie se
-- queda sin puntuar. Cuando el JS nuevo esté en producción, ejecuta el
-- bloque "FASE 2" del final para borrar la vieja y cerrar el agujero.
-- p_pistas va PRIMERO y sin default a propósito: así la firma (jsonb, text)
-- no puede ser ambigua con la vieja (text, int) ni al crearla ni al llamarla.
-- El cliente llama por nombre (PostgREST), el orden le da igual.
create or replace function liga_enviar_diario(
  p_pistas jsonb,
  p_juego  text default 'el-estadio')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user     uuid := auth.uid();
  v_dia      date := (now() at time zone 'Europe/Madrid')::date;
  v_semana   date := liga_semana_de(now());
  v_tramo    smallint;
  v_division bigint;
  v_total    int;
  v_puntos   int := 0;
  v_n        int;
  pista      jsonb;
  v_id       text;
  v_glat     double precision;
  v_glng     double precision;
  v_elat     double precision;
  v_elng     double precision;
begin
  if v_user is null then
    raise exception 'No autenticado';
  end if;
  if p_juego is null then p_juego := 'el-estadio'; end if;

  -- ── Validar y RECALCULAR desde las pistas ──
  if p_pistas is null or jsonb_typeof(p_pistas) <> 'array' then
    raise exception 'Falta el detalle de la partida. Actualiza la página e inténtalo de nuevo.';
  end if;
  v_n := jsonb_array_length(p_pistas);
  if v_n <> 5 then
    raise exception 'La partida debe tener 5 rondas (llegaron %).', v_n;
  end if;

  for pista in select * from jsonb_array_elements(p_pistas)
  loop
    v_id   := pista->>'id';
    v_glat := (pista->>'lat')::double precision;
    v_glng := (pista->>'lng')::double precision;
    if v_id is null or v_glat is null or v_glng is null then
      raise exception 'Pista incompleta.';
    end if;
    if v_glat < -90 or v_glat > 90 or v_glng < -180 or v_glng > 180 then
      raise exception 'Coordenada del pin fuera de rango.';
    end if;

    select lat, lng into v_elat, v_elng from el_estadio_coords where id = v_id;
    if v_elat is null then
      raise exception 'Estadio desconocido: %', v_id;
    end if;

    v_puntos := v_puntos + el_estadio_puntos(v_glat, v_glng, v_elat, v_elng);
  end loop;

  -- Red de seguridad (5 rondas * 5000 = 25000 como mucho).
  if v_puntos < 0 or v_puntos > 25000 then
    raise exception 'Puntuación recalculada fuera de rango: %', v_puntos;
  end if;

  -- 1) Guardar el diario. El primer envío del día manda; los reenvíos se
  --    ignoran (no se puede regrabar una puntuación mejor a mano).
  insert into liga_diarios (user_id, juego, dia, puntos)
  values (v_user, p_juego, v_dia, v_puntos)
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
    'puntos', v_total, 'dia', v_dia, 'hoy', v_puntos);
end;
$$;

-- ─── PERMISOS ────────────────────────────────────────────────────────
revoke execute on function el_estadio_puntos(double precision, double precision, double precision, double precision) from public;
grant  execute on function liga_enviar_diario(jsonb, text) to authenticated;

-- Forzar a PostgREST a recargar el esquema para exponer ya la nueva firma
-- de la RPC (si no, la primera llamada podría no encontrarla).
notify pgrst, 'reload schema';

-- =====================================================================
-- FASE 2 — cerrar el agujero (ejecutar SOLO cuando el JS nuevo ya esté
-- en producción, es decir, cuando la web sirva el game.js/liga.js que
-- mandan p_pistas). Borra la función vieja que aún confía en el número
-- del cliente. Es lo único que queda para que el truco de consola
-- p_puntos:25000 deje de funcionar del todo.
--
-- Descomenta estas dos líneas y ejecútalas cuando toque:
--
-- drop function if exists liga_enviar_diario(text, int);
-- notify pgrst, 'reload schema';
-- =====================================================================
