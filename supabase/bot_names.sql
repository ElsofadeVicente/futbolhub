-- =====================================================================
-- NOMBRES DE BOTS
-- Tabla que alimenta a los jugadores automáticos de las salas públicas.
-- Los nombres se eligen al azar entre todos los de la tabla, así que
-- cuantos más haya, menos se repiten y menos cantan.
--
-- Ejecutar en el SQL Editor de Supabase.
-- =====================================================================

create table if not exists bot_names (
  name text primary key
);

alter table bot_names enable row level security;

-- Lectura pública: el navegador lee la tabla con la publishable key.
-- No hay política de insert/update/delete, así que nadie puede escribir
-- desde el cliente (solo desde el panel de Supabase o con service key).
drop policy if exists "bot_names public read" on bot_names;
create policy "bot_names public read"
  on bot_names for select
  using (true);


-- ─── CARGAR LOS NOMBRES ──────────────────────────────────────────────
-- Opción A (recomendada): Table Editor → bot_names → Import data from CSV.
--   Sube un CSV con una sola columna llamada "name" y un nombre por línea:
--
--     name
--     Primer nombre
--     Segundo nombre
--     ...
--
-- Opción B: pegar aquí los nombres y ejecutar. "on conflict do nothing"
--   permite volver a ejecutarlo para añadir nuevos sin duplicar.
--
-- insert into bot_names (name) values
--   ('Primer nombre'),
--   ('Segundo nombre'),
--   ('Tercer nombre')
-- on conflict (name) do nothing;


-- ─── COMPROBAR ───────────────────────────────────────────────────────
-- select count(*) from bot_names;
