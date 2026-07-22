-- =====================================================================
-- PERFILES v2 — cambio de nombre "una sola vez" + foto de perfil
-- Pegar entero en el SQL Editor de Supabase y darle a Run. Idempotente:
-- se puede ejecutar varias veces sin romper nada. Requiere haber
-- ejecutado antes setup_perfiles.sql.
-- =====================================================================

-- ─── Marca de "ya gastó su cambio de nombre" ─────────────────────────
alter table profiles
  add column if not exists username_changed boolean not null default false;

-- ─── TRIGGER: forzar la regla del cambio único a nivel de base de datos
-- (no vale solo el control en el navegador: un usuario avanzado podría
--  llamar a la API directamente. Aquí la regla es imposible de saltar.)
--
-- Casos:
--  · Primer nombre (antes NULL → ahora un valor): permitido, NO gasta el
--    cambio (es el alta; p. ej. cuentas de Google que lo eligen al entrar).
--  · Renombrar teniendo ya nombre: permitido UNA vez; marca username_changed.
--  · Renombrar cuando username_changed ya es true: se rechaza.
--  · Si el username no cambia, se ignora cualquier intento del cliente de
--    tocar username_changed (anti-trampa).
create or replace function public.enforce_username_change()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if new.username is distinct from old.username then
    if old.username is null then
      new.username_changed := false;            -- alta: aún le queda su cambio
    elsif old.username_changed then
      raise exception 'username_change_not_allowed'
        using errcode = 'check_violation';
    else
      new.username_changed := true;             -- gasta su único cambio
    end if;
  else
    new.username_changed := old.username_changed; -- sin cambio de nombre, no se toca
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_username_change on profiles;
create trigger trg_enforce_username_change
  before update on profiles
  for each row execute function public.enforce_username_change();
