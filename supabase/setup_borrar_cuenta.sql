-- =====================================================================
-- SETUP BORRAR CUENTA — autoborrado de cuenta desde el widget de perfil
-- Pegar entero en el SQL Editor de Supabase y darle a Run. Idempotente.
--
-- borrar_mi_cuenta() borra la fila del usuario que llama en auth.users.
-- Todo lo que cuelga de profiles(id) con "on delete cascade" (perfil,
-- liga_miembros/diarios, ranked_rating/historial/record...) se va con
-- ella, y las tablas internas de Supabase Auth (identities, sessions,
-- refresh_tokens, mfa_factors...) están a su vez encadenadas a
-- auth.users, así que un solo DELETE basta.
--
-- Ojo: los archivos que el usuario haya subido a Storage
-- (avatars/<uid>/...) NO se borran aquí — no hay cascada de Postgres
-- entre profiles y storage.objects. Quedan huérfanos hasta que se
-- limpien aparte (bucket pequeño, bajo impacto; no bloquea esto).
-- =====================================================================

create or replace function public.borrar_mi_cuenta()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller uuid := auth.uid();
begin
  if v_caller is null then
    raise exception 'No has iniciado sesión.' using errcode = '28000';
  end if;

  delete from auth.users where id = v_caller;
end;
$$;

-- Solo cuentas ya logueadas pueden borrarse a sí mismas; anon fuera.
--
-- OJO: "revoke ... from public" NO basta en este proyecto. Supabase
-- concede EXECUTE a anon/authenticated en cada función nueva vía
-- ALTER DEFAULT PRIVILEGES (se comprobó con has_function_privilege()
-- tras crearla: anon podía ejecutarla igual que si nunca se hubiera
-- revocado). Hay que revocárselo a esos dos roles explícitamente —
-- mismo patrón que ya usan las funciones de solo-admin de la Liga
-- (liga_asignar_division, liga_cerrar_mes/semanas).
revoke execute on function public.borrar_mi_cuenta() from public, anon, authenticated;
grant execute on function public.borrar_mi_cuenta() to authenticated;
