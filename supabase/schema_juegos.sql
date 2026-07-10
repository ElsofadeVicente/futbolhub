-- =====================================================================
-- ESQUEMA POSTGRES — DATOS PROPIOS DE CADA JUEGO (fase 2)
-- Mismo criterio que schema.sql: "mismo dato, solo movido de sitio"
-- (una fila por elemento, contenido tal cual en una columna jsonb).
-- Ejecutar en el SQL Editor de Supabase, DESPUÉS de schema.sql/policies.sql.
-- =====================================================================

-- ─── CRUCIGRAMA (sustituye a crucigrama/data/YYYY-MM-DD.json) ────────
create table crucigrama_puzzles (
  date text primary key,   -- "2026-03-03"
  data jsonb not null      -- {date, title, grid_size, grid, words}
);

-- ─── LA TORRE (sustituye a la-torre/data/YYYY-MM-DD.json) ────────────
create table la_torre_daily (
  date text primary key,
  data jsonb not null      -- {date, title, subtitle, commonTrait, oddPlayerId, oddReason, players}
);

-- ─── EN EL ONCE — KITS (sustituye a en-el-once/data/kits.json) ───────
-- Una sola fila: el archivo entero es un objeto {gk, rules}, no una lista.
create table once_kits (
  id   int primary key default 1,
  data jsonb not null,
  constraint once_kits_single_row check (id = 1)
);

-- ─── EN EL ONCE — PARTIDOS (sustituye a champions/, historico/, liga/, once-diario/) ─
-- "source" identifica de qué archivo/carpeta venía cada partido, para poder
-- pedir exactamente el mismo grupo que antes (p.ej. "liga/14_15", "champions/finales").
create table once_matches (
  source text not null,    -- "champions/finales" | "historico/mundiales" | "liga/14_15" | "once-diario/Septiembre_2026"
  idx    int  not null,    -- posición dentro del archivo original (por si el orden importa)
  data   jsonb not null,   -- objeto partido completo {competition, homeTeam, awayTeam, ...}
  primary key (source, idx)
);

-- ─── EN EL TOP — PREGUNTAS (sustituye a en-el-top/data/enteltop.json) ─
create table top_questions (
  id   bigserial primary key,
  data jsonb not null
);

-- ─── EL ESTADIO (sustituye a el-estadio/data/estadios.json) ──────────
create table estadios (
  id   text primary key,   -- "abanca-balaidos"
  data jsonb not null      -- {id, name, coord}
);

-- ─── MENTIROSO (sustituye a mentiroso/js/data.js -> window.PLAYERS) ──
create table mentiroso_players (
  id   bigint primary key,
  data jsonb not null
);

-- ─── MENTIROSO — definiciones de stats (window.STAT_DEFINITIONS) ─────
-- Una sola fila: es una lista de configuración fija, no datos por jugador.
create table mentiroso_stat_definitions (
  id   int primary key default 1,
  data jsonb not null,
  constraint mentiroso_stat_definitions_single_row check (id = 1)
);

-- ─── COCHE — datasets propios del juego (restricciones) ──────────────
create table coche_companeros (
  player_id bigint primary key,
  data      jsonb not null
);
create table coche_entrenadores (
  id   bigint primary key,
  data jsonb not null
);
create table coche_ganadores_clubes_intl (
  competition text primary key,
  data        jsonb not null
);
create table coche_ganadores_seleccion (
  competition text primary key,
  data        jsonb not null
);
create table coche_ganadores_liga_copa (
  competition text primary key,
  data        jsonb not null
);
create table coche_premios_individuales (
  premio text primary key,
  data