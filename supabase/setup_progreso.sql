-- =====================================================================
-- PROGRESO EN EL PERFIL — rachas, partidas de hoy y resultados
-- Pegar entero en el SQL Editor de Supabase y darle a Run. Idempotente:
-- se puede ejecutar varias veces sin romper nada. Requiere haber
-- ejecutado antes setup_perfiles.sql.
--
-- Hasta ahora el progreso de cada juego vivía SOLO en el localStorage
-- del navegador: cambiabas de móvil a ordenador y la racha empezaba de
-- cero. Con esto el progreso viaja con la cuenta.
--
-- No se crea ninguna tabla nueva: es una columna más del perfil que ya
-- existe, y dentro va el mismo JSON que el juego guarda en el navegador
-- (js/progress-sync.js se encarga de subirlo y bajarlo). Se puede abrir
-- y editar a mano desde el panel de Supabase como cualquier otro JSON.
--
-- Forma del JSON:
--   {
--     "v": 1,
--     "keys": {
--       "carrera_day_2026-07-27": { "s": "{\"won\":true}", "t": 1769... },
--       "enteltop_day_2026-07-27": { "s": "{\"score\":10}", "t": 1769... }
--     }
--   }
--   s = el valor tal cual lo guarda el juego;  t = cuándo se guardó (ms).
--   El "t" es lo que decide quién gana cuando dos dispositivos difieren.
-- =====================================================================

-- ─── Columna de progreso ─────────────────────────────────────────────
alter table profiles
  add column if not exists progress jsonb not null default '{}'::jsonb;

comment on column profiles.progress is
  'Progreso de los juegos (rachas, partidas del día y resultados) sincronizado desde el navegador por js/progress-sync.js.';

-- ─── Permisos ────────────────────────────────────────────────────────
-- Las políticas de setup_perfiles.sql ya sirven: cada usuario solo puede
-- MODIFICAR su propia fila (auth.uid() = id), así que nadie puede tocar
-- el progreso de otro. La lectura de profiles es pública, igual que el
-- username y el avatar: aquí solo hay resultados de partidas, la misma
-- información que ya se enseña en el hub.
--
-- Si algún día se quiere que el progreso sea privado, hay que cambiar la
-- política "public read" para que no devuelva esta columna (una vista
-- pública con username/avatar y lectura de profiles solo para el dueño).
