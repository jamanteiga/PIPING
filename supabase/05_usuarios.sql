-- =====================================================================================
-- PIPING v8.6 · Usuarios de la aplicación (Archivo > Administración > Usuarios)
-- Ejecutar en Supabase > SQL Editor (después de 01–04). No necesita Supabase Auth ni correos:
-- usuario + contraseña propios, contraseñas con bcrypt (pgcrypto) y sesiones con testigo aleatorio.
-- Las tablas no son accesibles directamente (RLS sin políticas): solo a través de las funciones.
-- El primer administrador lo crea la aplicación (piping_inicializar) cuando la tabla está vacía.
-- Roles: admin (Administrador), supervisor (Supervisor), jefe (Jefe de proyecto), usuario (Usuario).
-- =====================================================================================

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.piping_usuarios (
    id               uuid primary key default gen_random_uuid(),
    usuario          text not null unique check (usuario ~ '^[a-z0-9._-]{3,40}$'),
    nombre           text not null,
    apellidos        text not null default '',
    rol              text not null check (rol in ('admin', 'supervisor', 'jefe', 'usuario')),
    clave_hash       text not null,
    debe_cambiar     boolean not null default true,
    activo           boolean not null default true,
    intentos         integer not null default 0,
    bloqueado_hasta  timestamptz,
    ultimo_acceso    timestamptz,
    creado           timestamptz not null default now(),
    creado_por       text
);
create table if not exists public.piping_sesiones (
    token       text primary key,
    usuario_id  uuid not null references public.piping_usuarios(id) on delete cascade,
    expira      timestamptz not null,
    creada      timestamptz not null default now()
);
alter table public.piping_usuarios enable row level security;
alter table public.piping_sesiones enable row level security;
revoke all on public.piping_usuarios, public.piping_sesiones from anon, authenticated;

-- ---------- auxiliares (no expuestas) ----------
create or replace function public.piping_hash_clave(p_clave text) returns text
language sql volatile security definer set search_path = public, extensions as $$ select crypt(p_clave, gen_salt('bf', 10)) $$;

create or replace function public.piping_usuario_de_token(p_token text) returns public.piping_usuarios
language plpgsql stable security definer set search_path = public, extensions as $$
declare u public.piping_usuarios;
begin
    select x.* into u from public.piping_sesiones s join public.piping_usuarios x on x.id = s.usuario_id
     where s.token = p_token and s.expira > now() and x.activo;
    if not found then raise exception 'Sesión no válida o caducada: vuelve a iniciar sesión'; end if;
    return u;
end $$;

create or replace function public.piping_exigir_admin(p_token text) returns public.piping_usuarios
language plpgsql stable security definer set search_path = public, extensions as $$
declare u public.piping_usuarios;
begin
    u := public.piping_usuario_de_token(p_token);
    if u.rol <> 'admin' then raise exception 'Solo un administrador puede gestionar usuarios'; end if;
    return u;
end $$;

create or replace function public.piping_json_usuario(u public.piping_usuarios) returns json
language sql stable as $$ select json_build_object('id', u.id, 'usuario', u.usuario, 'nombre', u.nombre, 'apellidos', u.apellidos, 'rol', u.rol,
    'debe_cambiar', u.debe_cambiar, 'activo', u.activo, 'ultimo_acceso', u.ultimo_acceso, 'creado', u.creado, 'creado_por', u.creado_por) $$;

create or replace function public.piping_quedan_admins(p_excluir uuid) returns integer
language sql stable security definer set search_path = public as $$
    select count(*)::int from public.piping_usuarios where rol = 'admin' and activo and id <> p_excluir $$;

-- ---------- funciones públicas ----------
create or replace function public.piping_usuarios_vacio() returns boolean
language sql stable security definer set search_path = public as $$ select not exists (select 1 from public.piping_usuarios) $$;

-- primer administrador (solo con la tabla vacía)
create or replace function public.piping_inicializar(p_usuario text, p_nombre text, p_clave text) returns json
language plpgsql volatile security definer set search_path = public, extensions as $$
begin
    if exists (select 1 from public.piping_usuarios) then raise exception 'Ya hay usuarios: inicia sesión con uno de ellos'; end if;
    if length(p_clave) < 8 then raise exception 'La contraseña debe tener al menos 8 caracteres'; end if;
    insert into public.piping_usuarios (usuario, nombre, rol, clave_hash, debe_cambiar, creado_por)
    values (lower(trim(p_usuario)), coalesce(nullif(trim(p_nombre), ''), 'Administrador'), 'admin', public.piping_hash_clave(p_clave), false, 'inicialización');
    return public.piping_login(p_usuario, p_clave, false);
end $$;

create or replace function public.piping_login(p_usuario text, p_clave text, p_recordar boolean default false) returns json
language plpgsql volatile security definer set search_path = public, extensions as $$
declare u public.piping_usuarios; t text;
begin
    select * into u from public.piping_usuarios where usuario = lower(trim(p_usuario));
    if not found then return json_build_object('ok', false, 'error', 'Usuario o contraseña incorrectos'); end if;
    if not u.activo then return json_build_object('ok', false, 'error', 'Usuario desactivado: consulta con el administrador'); end if;
    if u.bloqueado_hasta is not null and u.bloqueado_hasta > now() then
        return json_build_object('ok', false, 'error', 'Demasiados intentos fallidos: espera unos minutos'); end if;
    if u.clave_hash <> crypt(p_clave, u.clave_hash) then
        update public.piping_usuarios set intentos = intentos + 1,
               bloqueado_hasta = case when intentos + 1 >= 5 then now() + interval '15 minutes' else null end
         where id = u.id;
        return json_build_object('ok', false, 'error', 'Usuario o contraseña incorrectos');
    end if;
    update public.piping_usuarios set intentos = 0, bloqueado_hasta = null, ultimo_acceso = now() where id = u.id;
    delete from public.piping_sesiones where expira < now();
    t := encode(gen_random_bytes(32), 'hex');
    insert into public.piping_sesiones (token, usuario_id, expira) values (t, u.id, now() + case when p_recordar then interval '30 days' else interval '12 hours' end);
    return json_build_object('ok', true, 'token', t, 'usuario', public.piping_json_usuario(u));
end $$;

create or replace function public.piping_logout(p_token text) returns void
language sql volatile security definer set search_path = public as $$ delete from public.piping_sesiones where token = p_token $$;

create or replace function public.piping_cambiar_clave(p_token text, p_actual text, p_nueva text) returns void
language plpgsql volatile security definer set search_path = public, extensions as $$
declare u public.piping_usuarios;
begin
    u := public.piping_usuario_de_token(p_token);
    if u.clave_hash <> crypt(p_actual, u.clave_hash) then raise exception 'La contraseña actual no es correcta'; end if;
    if length(p_nueva) < 8 then raise exception 'La nueva contraseña debe tener al menos 8 caracteres'; end if;
    if p_nueva = p_actual then raise exception 'La nueva contraseña debe ser distinta de la actual'; end if;
    update public.piping_usuarios set clave_hash = public.piping_hash_clave(p_nueva), debe_cambiar = false where id = u.id;
end $$;

create or replace function public.piping_usuarios_listar(p_token text) returns json
language plpgsql stable security definer set search_path = public, extensions as $$
begin
    perform public.piping_exigir_admin(p_token);
    return coalesce((select json_agg(public.piping_json_usuario(x) order by x.apellidos, x.nombre) from public.piping_usuarios x), '[]'::json);
end $$;

create or replace function public.piping_usuario_crear(p_token text, p_usuario text, p_nombre text, p_apellidos text, p_rol text, p_clave text) returns json
language plpgsql volatile security definer set search_path = public, extensions as $$
declare a public.piping_usuarios; u public.piping_usuarios;
begin
    a := public.piping_exigir_admin(p_token);
    if length(p_clave) < 8 then raise exception 'La contraseña por defecto debe tener al menos 8 caracteres'; end if;
    if exists (select 1 from public.piping_usuarios where usuario = lower(trim(p_usuario))) then raise exception 'Ya existe el usuario %', lower(trim(p_usuario)); end if;
    insert into public.piping_usuarios (usuario, nombre, apellidos, rol, clave_hash, debe_cambiar, creado_por)
    values (lower(trim(p_usuario)), trim(p_nombre), coalesce(trim(p_apellidos), ''), p_rol, public.piping_hash_clave(p_clave), true, a.usuario)
    returning * into u;
    return public.piping_json_usuario(u);
end $$;

create or replace function public.piping_usuario_actualizar(p_token text, p_id uuid, p_nombre text, p_apellidos text, p_rol text, p_activo boolean) returns json
language plpgsql volatile security definer set search_path = public, extensions as $$
declare a public.piping_usuarios; u public.piping_usuarios;
begin
    a := public.piping_exigir_admin(p_token);
    select * into u from public.piping_usuarios where id = p_id; if not found then raise exception 'Usuario no encontrado'; end if;
    if u.rol = 'admin' and (p_rol <> 'admin' or not p_activo) and public.piping_quedan_admins(u.id) = 0 then
        raise exception 'Tiene que quedar al menos un administrador activo'; end if;
    update public.piping_usuarios set nombre = trim(p_nombre), apellidos = coalesce(trim(p_apellidos), ''), rol = p_rol, activo = p_activo where id = p_id returning * into u;
    if not p_activo then delete from public.piping_sesiones where usuario_id = p_id; end if;
    return public.piping_json_usuario(u);
end $$;

create or replace function public.piping_usuario_resetear(p_token text, p_id uuid, p_clave text) returns void
language plpgsql volatile security definer set search_path = public, extensions as $$
begin
    perform public.piping_exigir_admin(p_token);
    if length(p_clave) < 8 then raise exception 'La contraseña debe tener al menos 8 caracteres'; end if;
    update public.piping_usuarios set clave_hash = public.piping_hash_clave(p_clave), debe_cambiar = true, intentos = 0, bloqueado_hasta = null where id = p_id;
    if not found then raise exception 'Usuario no encontrado'; end if;
    delete from public.piping_sesiones where usuario_id = p_id;
end $$;

create or replace function public.piping_usuario_borrar(p_token text, p_id uuid) returns void
language plpgsql volatile security definer set search_path = public, extensions as $$
declare a public.piping_usuarios; u public.piping_usuarios;
begin
    a := public.piping_exigir_admin(p_token);
    if a.id = p_id then raise exception 'No puedes eliminar tu propio usuario'; end if;
    select * into u from public.piping_usuarios where id = p_id; if not found then return; end if;
    if u.rol = 'admin' and public.piping_quedan_admins(u.id) = 0 then raise exception 'Tiene que quedar al menos un administrador'; end if;
    delete from public.piping_usuarios where id = p_id;
end $$;

-- solo las funciones públicas se pueden llamar con la clave anon
revoke execute on function public.piping_hash_clave(text), public.piping_usuario_de_token(text), public.piping_exigir_admin(text), public.piping_quedan_admins(uuid) from public, anon, authenticated;
grant execute on function public.piping_usuarios_vacio(), public.piping_inicializar(text, text, text), public.piping_login(text, text, boolean), public.piping_logout(text),
    public.piping_cambiar_clave(text, text, text), public.piping_usuarios_listar(text), public.piping_usuario_crear(text, text, text, text, text, text),
    public.piping_usuario_actualizar(text, uuid, text, text, text, boolean), public.piping_usuario_resetear(text, uuid, text), public.piping_usuario_borrar(text, uuid) to anon, authenticated;
notify pgrst, 'reload schema';
