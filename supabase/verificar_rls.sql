-- =====================================================================
-- VERIFICAR RLS — diagnóstico de solo lectura del estado REAL en Supabase
--
-- Un fichero .sql en el repo no garantiza que se haya ejecutado en el
-- proyecto, ni que alguien no haya creado luego una tabla sin RLS. Este
-- script consulta el catálogo vivo de Postgres y te dice si hay agujeros.
-- NO modifica nada: son SELECT sobre tablas de sistema.
--
-- CÓMO USARLO: Supabase → SQL Editor → pega TODO → ejecuta el BLOQUE 1.
-- El editor muestra el resultado del último SELECT, así que ejecuta cada
-- bloque por separado (selecciona el bloque y pulsa Run), o léelos de uno
-- en uno. El bloque 1 es el importante: si devuelve 0 filas, estás bien.
-- =====================================================================


-- ─────────────────────────────────────────────────────────────────────
-- BLOQUE 1 — ALERTAS.  Debe devolver CERO filas. Cada fila es un problema.
-- ─────────────────────────────────────────────────────────────────────
-- (a) Tablas de datos SIN row level security → cualquiera con la clave
--     pública podría escribir/leer sin restricción.
select 'RLS DESACTIVADO' as alerta,
       schemaname || '.' || tablename as objeto,
       'La tabla no tiene RLS: actívalo con  alter table ' || tablename || ' enable row level security;' as detalle
from pg_tables
where schemaname = 'public'
  and rowsecurity = false

union all

-- (b) Tablas CON RLS pero SIN ninguna política → nadie puede ni leer.
--     Suele ser un olvido (falta ejecutar el policies*.sql correspondiente).
select 'RLS SIN POLÍTICAS',
       t.schemaname || '.' || t.tablename,
       'RLS activo pero sin policies: probablemente falta ejecutar su policies*.sql'
from pg_tables t
where t.schemaname = 'public'
  and t.rowsecurity = true
  and not exists (
    select 1 from pg_policies p
    where p.schemaname = t.schemaname and p.tablename = t.tablename
  )

union all

-- (c) Políticas de ESCRITURA (INSERT/UPDATE/DELETE/ALL) abiertas a anon o
--     public con condición permisiva (true / sin condición) → escritura
--     pública real. OJO: las que están limitadas por auth.uid() = id (como
--     "update own profile") NO salen aquí, y está bien que no salgan.
select 'ESCRITURA PÚBLICA ABIERTA: ' || cmd || ' (' || policyname || ')',
       schemaname || '.' || tablename,
       'Condición: ' || coalesce(coalesce(with_check, qual), '(sin condición)')
from pg_policies
where schemaname in ('public', 'storage')
  and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
  and (roles @> array['anon']::name[] or roles @> array['public']::name[])
  and (coalesce(with_check, qual) is null
       or btrim(coalesce(with_check, qual)) = 'true')

order by 1;


-- ─────────────────────────────────────────────────────────────────────
-- BLOQUE 2 — INVENTARIO de RLS por tabla (informativo).
-- ─────────────────────────────────────────────────────────────────────
select tablename as tabla,
       rowsecurity as rls_activo,
       (select count(*) from pg_policies p
         where p.schemaname = 'public' and p.tablename = t.tablename) as num_policies
from pg_tables t
where schemaname = 'public'
order by rowsecurity, tablename;


-- ─────────────────────────────────────────────────────────────────────
-- BLOQUE 3 — TODAS las políticas (informativo). Revisa que las de escritura
-- (cmd distinto de SELECT) estén limitadas por auth.uid() y que ninguna
-- tabla de datos de juego tenga políticas de INSERT/UPDATE/DELETE.
-- ─────────────────────────────────────────────────────────────────────
select schemaname || '.' || tablename as objeto,
       policyname,
       cmd,
       roles,
       qual        as condicion_using,
       with_check  as condicion_check
from pg_policies
where schemaname in ('public', 'storage')
order by schemaname, tablename, cmd;


-- ─────────────────────────────────────────────────────────────────────
-- BLOQUE 4 — BUCKETS de Storage: cuáles son públicos.
-- 'avatars' debe ser público en LECTURA (public = true) pero la escritura
-- la limitan las políticas del bloque 3 (solo el dueño en su carpeta).
-- ─────────────────────────────────────────────────────────────────────
select id as bucket, public as lectura_publica
from storage.buckets
order by id;
