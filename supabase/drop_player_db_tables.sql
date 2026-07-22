-- =====================================================================
-- DROP — tablas de schema.sql (base de datos "núcleo" de jugadores/
-- equipos/ligas) ya sustituidas por Supabase Storage (bucket "player-db",
-- subido con admin/upload_player_db_to_storage.py).
--
-- Ejecutar A MANO en el SQL Editor de Supabase, y solo DESPUÉS de haber
-- confirmado que Coche, En el Top, En la Cadena, La Torre e
-- Higher-or-Lower cargan bien sus datos desde Storage.
-- =====================================================================

drop table if exists players;
drop table if exists teams;
drop table if exists leagues;
drop table if exists team_names_index;
drop table if exists national_team_records;
drop table if exists transfers;
drop table if exists teammates;
drop table if exists performances;
drop table if exists higher_or_lower_players;
drop table if exists higher_or_lower_top_players;
