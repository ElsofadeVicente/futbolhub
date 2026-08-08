-- =====================================================================
-- AVATARES v2 — límites de verdad, no solo en el navegador
-- Pegar entero en el SQL Editor de Supabase y darle a Run. Idempotente.
-- Requiere haber ejecutado antes setup_perfiles.sql.
--
-- EL PROBLEMA
-- js/auth.js comprueba que la foto sea una imagen y que no pase de 4 MB
-- (MAX_AVATAR_BYTES), pero eso es JavaScript en el navegador del usuario:
-- cualquiera con la sesión iniciada puede llamar a la API de Storage
-- directamente y saltárselo. El bucket se creó sin file_size_limit ni
-- allowed_mime_types, así que hasta ahora un usuario registrado podía
-- alojar archivos arbitrarios, del tamaño que quisiera, servidos desde
-- nuestro dominio. Eso es un problema de abuso (y de factura).
--
-- Además profiles.avatar_url aceptaba CUALQUIER cadena: se podía apuntar a
-- una URL externa y hacer que los navegadores del resto de usuarios la
-- pidieran (píxel de rastreo de terceros con nuestra cara).
-- =====================================================================

-- ─── Límites del bucket ──────────────────────────────────────────────
-- 4 MB para que coincida con MAX_AVATAR_BYTES de js/auth.js, y los mismos
-- formatos que acepta el formulario. Ahora la regla la aplica el servidor
-- y el JS solo sirve para dar un mensaje bonito antes de subir.
update storage.buckets
   set file_size_limit   = 4194304,       -- 4 MB
       allowed_mime_types = array['image/png','image/jpeg','image/webp','image/gif']
 where id = 'avatars';

-- ─── La foto tiene que vivir en NUESTRO bucket ───────────────────────
-- Se añade primero como NOT VALID para que la sentencia no pueda fallar
-- por una fila antigua rara, y se valida después (ver más abajo).
alter table profiles
  drop constraint if exists avatar_url_propio;

alter table profiles
  add constraint avatar_url_propio
  check (
    avatar_url is null
    or avatar_url like 'https://rssvejgdekwysiseqzkd.supabase.co/storage/v1/object/public/avatars/%'
  ) not valid;

-- ¿Hay algún avatar que la incumpla? Si "incumplen" da 0, se puede validar.
select count(*) filter (where avatar_url is not null) as con_foto,
       count(*) filter (where avatar_url is not null
         and avatar_url not like 'https://rssvejgdekwysiseqzkd.supabase.co/storage/v1/object/public/avatars/%') as incumplen,
       count(*) as perfiles_total
  from profiles;

-- Validarla deja de tratarla como "solo para filas nuevas" y la garantiza
-- también para las viejas. Solo si la consulta de arriba da incumplen = 0.
alter table profiles validate constraint avatar_url_propio;

-- ─── Comprobación ────────────────────────────────────────────────────
select id, public, file_size_limit, allowed_mime_types
  from storage.buckets
 where id = 'avatars';

select conname as restriccion, convalidated as validada, pg_get_constraintdef(oid) as definicion
  from pg_constraint
 where conrelid = 'public.profiles'::regclass
   and conname = 'avatar_url_propio';

-- =====================================================================
-- APLICADO EN PRODUCCIÓN el 2026-08-08 (SQL Editor, proyecto
-- rssvejgdekwysiseqzkd, rama main). Resultado comprobado:
--   storage.buckets 'avatars' → file_size_limit 4194304,
--     allowed_mime_types ["image/png","image/jpeg","image/webp","image/gif"]
--   profiles.avatar_url_propio → convalidated = true
--   perfiles con foto: 4 · incumplen: 0
-- =====================================================================
