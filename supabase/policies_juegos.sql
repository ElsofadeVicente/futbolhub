-- =====================================================================
-- RLS — solo lectura pública, para las tablas de schema_juegos.sql
-- Ejecutar DESPUÉS de schema_juegos.sql
-- =====================================================================

alter table crucigrama_puzzles           enable row level security;
alter table la_torre_daily               enable row level security;
alter table once_kits                    enable row level security;
alter table once_matches                 enable row level security;
alter table top_questions                enable row level security;
alter table estadios                     enable row level security;
alter table mentiroso_players             enable row level security;
alter table mentiroso_stat_definitions     enable row level security;
alter table coche_companeros              enable row level security;
alter table coche_entrenadores            enable row level security;
alter table coche_ganadores_clubes_intl   enable row level security;
alter table coche_ganadores_seleccion     enable row level security;
alter table coche_ganadores_liga_copa     enable row level security;
alter table coche_premios_individuales    enable row level security;
alter table blackjack_players             enable row level security;

create policy "public read" on crucigrama_puzzles         for select using (true);
create policy "public read" on la_torre_daily             for select using (true);
create policy "public read" on once_kits                  for select using (true);
create policy "public read" on once_matches               for select using (true);
create policy "public read" on top_questions              for select using (true);
create policy "public read" on estadios                   for select using (true);
create policy "public read" on mentiroso_players           for select using (true);
create policy "public read" on mentiroso_stat_definitions   for select using (true);
create policy "public read" on coche_companeros            for select using (true);
create policy "public read" on coche_entrenadores          for select using (true);
create policy "public read" on coche_ganadores_clubes_intl for select using (true);
create policy "public read" on coche_ganadores_seleccion   for select using (true);
create policy "public read" on coche_ganadores_liga_copa   for select using (true);
create policy "public read" on coche_premios_individuales  for select using (true);
create policy "public read" on blackjack_players            for select using (true);
