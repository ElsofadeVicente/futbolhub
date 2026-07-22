-- =====================================================================
-- SETUP PERFILES — TODO EN UNO (tabla + trigger + RLS + bucket avatares)
-- Pegar entero en el SQL Editor de Supabase y darle a Run. Es
-- idempotente: se puede ejecutar varias veces sin romper nada.
--
-- Las cuentas (correo, contraseña hasheada, identidad de Google) viven
-- en la tabla interna auth.users que gestiona Supabase; aquí solo
-- guardamos los datos públicos del perfil (username, avatar).
-- =====================================================================

-- ─── TABLA DE PERFILES ───────────────────────────────────────────────
create table if not exists profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  -- Único en toda la web. NULL para cuentas de Google hasta que el
  -- usuario elige el suyo en su primer inicio de sesión.
  username   text unique,
  avatar_url text,
  created_at timestamptz not null default now(),
  -- 3-20 caracteres: minúsculas, números, punto y guion bajo
  constraint username_format check (username is null or username ~ '^[a-z0-9_.]{3,20}$')
);

-- ─── TRIGGER: crear el perfil automáticamente al registrarse ─────────
-- El registro con correo manda el username elegido en options.data
-- (llega como raw_user_meta_data). Con Google no viene: queda NULL y
-- el widget pide elegirlo la primera vez.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  wanted text;
begin
  wanted := lower(new.raw_user_meta_data->>'username');
  if wanted is null or wanted !~ '^[a-z0-9_.]{3,20}$' then
    wanted := null;
  end if;
  begin
    insert into public.profiles (id, username) values (new.id, wanted);
  exception when unique_violation then
    -- carrera: otro se registró con ese nombre entre la comprobación y el
    -- alta. No rompemos el registro: queda sin nombre y lo elige al entrar.
    insert into public.profiles (id, username) values (new.id, null);
  end;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ─── ROW LEVEL SECURITY ──────────────────────────────────────────────
-- Lectura pública (los usernames/avatares son públicos y hacen falta
-- para comprobar si un nombre está libre). Cada usuario solo puede
-- MODIFICAR su propia fila (auth.uid() = id). Nadie inserta ni borra
-- desde el navegador: el alta la hace el trigger (security definer) y
-- el borrado llega en cascada si se elimina la cuenta.
alter table profiles enable row level security;

drop policy if exists "public read" on profiles;
create policy "public read" on profiles for select using (true);

drop policy if exists "update own profile" on profiles;
create policy "update own profile" on profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- ─── BUCKET DE AVATARES ──────────────────────────────────────────────
-- Lectura pública (como los demás buckets de la web); cada usuario solo
-- puede escribir dentro de su carpeta avatars/{su-uid}/...
-- (La UI de subir foto llegará más adelante; esto ya queda listo.)
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

drop policy if exists "avatars public read" on storage.objects;
create policy "avatars public read" on storage.objects
  for select using (bucket_id = 'avatars');

drop policy if exists "avatars insert own" on storage.objects;
create policy "avatars insert own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "avatars update own" on storage.objects;
create policy "avatars update own" on storage.objects
  for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "avatars delete own" on storage.objects;
create policy "avatars delete own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
