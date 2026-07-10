-- =====================================================================
-- ESQUEMA POSTGRES PARA SUPABASE — "mismo dato, solo movido de sitio"
-- Cada tabla guarda el mismo bloque de información que hoy tienes en
-- el JSON, pero una fila por elemento en vez de un archivo gigante.
-- No se trocea nada en columnas nuevas: menos riesgo, migración directa.
-- =====================================================================

-- ─── PLAYERS (sustituye a players/chunks/*.json) ─────────────────────
-- Antes: 15 archivos con miles de jugadores cada uno, hay que saber en
--        qué "chunk" busca cada ID.
-- Ahora: una tabla, una fila por jugador, se busca por su id directamente.
create table players (
  id   bigint primary key,   -- el mismo id de Transfermarkt que ya usas
  data jsonb   not null      -- el mismo objeto {n, p, nat, b, f, h, teams, ...} tal cual
);
-- índice para poder filtrar/buscar dentro del JSON sin leer toda la tabla
create index idx_players_data on players using gin (data);

-- ─── TEAMS (sustituye a teams/details.json) ──────────────────────────
create table teams (
  id   bigint primary key,   -- id de Transfermarkt
  data jsonb   not null      -- {n, slug, logo, ctry, seasons: [...]}
);
create index idx_teams_data on teams using gin (data);

-- ─── LEAGUES (sustituye a teams/league-teams.json) ───────────────────
-- Antes era UN archivo con todas las ligas dentro; aquí una fila por liga.
create table leagues (
  name text primary key,     -- "La Liga", "Premier League", ...
  data jsonb not null        -- {priority, teams: [...]}
);

-- ─── TRANSFERS (sustituye a transfers/chunks/*.json) ─────────────────
-- Una fila por jugador, con el mismo array de traspasos que ya tenías.
create table transfers (
  player_id bigint primary key references players(id) on delete cascade,
  data      jsonb  not null    -- [{s, fn, tn, type, d, fid, tid, val, fee}, ...]
);

-- ─── TEAMMATES (sustituye a teammates/chunks/*.json) ─────────────────
create table teammates (
  player_id bigint primary key references players(id) on delete cascade,
  data      jsonb  not null    -- [{id, n, ppg, jgp}, ...]
);

-- ─── PERFORMANCES (sustituye a performances/chunks/*.json) ───────────
create table performances (
  player_id bigint primary key references players(id) on delete cascade,
  data      jsonb  not null    -- [{s, cid, cn, tn, app, st, g, a, ...}, ...]
);

-- ─── NATIONAL_TEAM_RECORDS (sustituye a national/all.json) ───────────
create table national_team_records (
  player_id bigint primary key references players(id) on delete cascade,
  data      jsonb  not null    -- [{tid, m, g, shirt, debut, state}, ...]
);

-- ─── HIGHER_OR_LOWER_PLAYERS (sustituye a higher-or-lower/*.json) ────
-- Antes: 5 archivos, uno por liga (bundesliga.json, laliga.json...).
-- Ahora: 1 tabla, con una columna "league" para distinguir de qué liga es.
create table higher_or_lower_players (
  league    text   not null,   -- "bundesliga" | "laliga" | "serie-a" | ...
  player_id bigint not null,
  data      jsonb  not null,   -- el mismo objeto de jugador que ya tenías
  primary key (league, player_id)
);

-- ─── HIGHER_OR_LOWER_TOP_PLAYERS (sustituye a .../top-players/*.json) ─
create table higher_or_lower_top_players (
  league    text   not null,
  player_id bigint not null,
  data      jsonb  not null,
  primary key (league, player_id)
);

-- =====================================================================
-- NOTAS
-- =====================================================================
-- 1. team-names.json y players/name-index.json no necesitan tabla propia:
--    son listas derivadas de "teams" y "players" (una consulta simple
--    los genera al vuelo), así que no se duplica esa información.
--
-- 2. Fuera de esta fase (dominios independientes, no bloquean nada):
--    - crucigrama/data/*.json   (55 crucigramas diarios, 244K)
--    - mentiroso/data/data.js   (pool de cartas propio, pequeño y aparte)
--    - en-el-top/data/enteltop.json (preguntas curadas a mano)
--
-- 3. RLS (quién puede leer/escribir) se define en policies.sql,
--    ejecutar ese archivo justo después de este.
-- =====================================================================

-- ─── TEAM_NAMES_INDEX (sustituye a teams/team-names.json) ────────────
-- OJO: es una lista distinta de "teams" (no hay solapamiento). Se usa
-- para autocompletar nombres de equipo en varios juegos.
create table team_names_index (
  name text primary key
);
