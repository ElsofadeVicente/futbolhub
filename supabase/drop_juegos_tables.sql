-- =====================================================================
-- DROP — tablas de schema_juegos.sql ya sustituidas por Supabase Storage
-- (bucket "game-data", subido con admin/upload_juegos_data_to_storage.py).
--
-- Ejecutar A MANO en el SQL Editor de Supabase, y solo DESPUÉS de haber
-- confirmado que todos los juegos cargan bien sus datos desde Storage.
--
-- mentiroso_players y mentiroso_stat_definitions se dejan intactas a
-- propósito: Mentiroso sigue leyendo mentiroso/js/data.js en local, no
-- forma parte de esta migración.
-- =====================================================================

drop table if exists crucigrama_puzzles;
drop table if exists la_torre_daily;
drop table if exists once_kits;
drop table if exists once_matches;
drop table if exists top_questions;
drop table if exists estadios;
drop table if exists coche_companeros;
drop table if exists coche_entrenadores;
drop table if exists coche_ganadores_clubes_intl;
drop table if exists coche_ganadores_seleccion;
drop table if exists coche_ganadores_liga_copa;
drop table if exists coche_premios_individuales;
drop table if exists blackjack_players;
