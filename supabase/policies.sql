-- =====================================================================
-- ROW LEVEL SECURITY — solo lectura pública
-- (mismo nivel de exposición que ahora: datos públicos, sin login)
-- Ejecutar DESPUÉS de schema.sql
-- =====================================================================

alter table players                     enable row level security;
alter table teams                       enable row level security;
alter table leagues                     enable row level security;
alter table transfers                   enable row level security;
alter table teammates                   enable row level security;
alter table performances                enable row level security;
alter table national_team_records       enable row level security;
alter table higher_or_lower_players     enable row level security;
alter table higher_or_lower_top_players enable row level security;

-- Una policy de SELECT por tabla, para el rol "anon" (clave pública del navegador).
-- No se crea ninguna policy de INSERT/UPDATE/DELETE => el cliente público
-- nunca puede escribir. Solo la service_role key (que nunca va en el
-- navegador) puede modificar datos, y esa la usan los scripts de migración.

create policy "public read" on players                     for select using (true);
create policy "public read" on teams                       for select using (true);
create policy "public read" on leagues                     for select using (true);
create policy "public read" on transfers                   for select using (true);
create policy "public read" on teammates                   for select using (true);
create policy "public read" on performances                for select using (true);
create policy "public read" on national_team_records       for select using (true);
create policy "public read" on higher_or_lower_players     for select using (true);
create policy "public read" on higher_or_lower_top_players for select using (true);

alter table team_names_index enable row level security;
create policy "public read" on team_names_index for select using (true);
