-- =====================================================================================
-- PIPING v8.7 · Renovación de sesión, perfil del usuario (iniciales) y registro de actividad
-- Ejecutar en Supabase > SQL Editor después de 05_usuarios.sql. Se puede ejecutar varias veces.
-- =====================================================================================

alter table public.piping_usuarios add column if not exists iniciales text not null default '';
alter table public.piping_sesiones add column if not exists recordar boolean not null default false;

create table if not exists public.piping_registro (
    id        bigserial primary key,
    fecha     timestamptz not null default now(),
    usuario   text not null,
    nombre    text,
    rol       text,
    accion    text not null,
    detalle   text,
    proyecto  text
);
create index if not exists piping_registro_fecha_idx on public.piping_registro (fecha desc);
alter table public.piping_registro enable row level security;
revoke all on public.piping_registro from anon, authenticated;

-- los datos del usuario que ve la aplicación incluyen las iniciales
create or replace function public.piping_json_usuario(u public.piping_usuarios) returns json
language sql stable as $$ select json_build_object('id', u.id, 'usuario', u.usuario, 'nombre', u.nombre, 'apellidos', u.apellidos, 'iniciales', u.iniciales, 'rol', u.rol,
    'debe_cambiar', u.debe_cambiar, 'activo', u.activo, 'ultimo_acceso', u.ultimo_acceso, 'creado', u.creado, 'creado_por', u.creado_por) $$;

-- inicio de sesión: igual que en 05, y además deja constancia en el registro (accesos correctos y fallidos)
create or replace function public.piping_login(p_usuario text, p_clave text, p_recordar boolean default false) returns json
language plpgsql volatile security definer set search_path = public, extensions as $$
declare u public.piping_usuarios; t text; dur interval;
begin
    select * into u from public.piping_usuarios where usuario = lower(trim(p_usuario));
    if not found then
        insert into public.piping_registro (usuario, accion, detalle) values (left(lower(trim(p_usuario)), 40), 'acceso fallido', 'usuario inexistente');
        return json_build_object('ok', false, 'error', 'Usuario o contraseña incorrectos'); end if;
    if not u.activo then return json_build_object('ok', false, 'error', 'Usuario desactivado: consulta con el administrador'); end if;
    if u.bloqueado_hasta is not null and u.bloqueado_hasta > now() then
        return json_build_object('ok', false, 'error', 'Demasiados intentos fallidos: espera unos minutos'); end if;
    if u.clave_hash <> crypt(p_clave, u.clave_hash) then
        update public.piping_usuarios set intentos = intentos + 1,
               bloqueado_hasta = case when intentos + 1 >= 5 then now() + interval '15 minutes' else null end
         where id = u.id;
        insert into public.piping_registro (usuario, nombre, rol, accion, detalle) values (u.usuario, trim(u.nombre || ' ' || u.apellidos), u.rol, 'acceso fallido', 'contraseña incorrecta');
        return json_build_object('ok', false, 'error', 'Usuario o contraseña incorrectos');
    end if;
    update public.piping_usuarios set intentos = 0, bloqueado_hasta = null, ultimo_acceso = now() where id = u.id;
    delete from public.piping_sesiones where expira < now();
    t := encode(gen_random_bytes(32), 'hex'); dur := case when p_recordar then interval '30 days' else interval '12 hours' end;
    insert into public.piping_sesiones (token, usuario_id, expira, recordar) values (t, u.id, now() + dur, coalesce(p_recordar, false));
    insert into public.piping_registro (usuario, nombre, rol, accion) values (u.usuario, trim(u.nombre || ' ' || u.apellidos), u.rol, 'inicio de sesión');
    return json_build_object('ok', true, 'token', t, 'expira', now() + dur, 'usuario', public.piping_json_usuario(u));
end $$;

-- renovación: mientras se trabaja, la sesión se alarga (12 h, o 30 días con «Recordar»)
create or replace function public.piping_renovar(p_token text) returns json
language plpgsql volatile security definer set search_path = public, extensions as $$
declare u public.piping_usuarios; e timestamptz;
begin
    u := public.piping_usuario_de_token(p_token);
    update public.piping_sesiones set expira = now() + case when recordar then interval '30 days' else interval '12 hours' end where token = p_token returning expira into e;
    return json_build_object('ok', true, 'expira', e, 'usuario', public.piping_json_usuario(u));
end $$;

-- «Mi perfil»: cada usuario cambia su nombre, apellidos e iniciales (no su rol)
create or replace function public.piping_perfil_actualizar(p_token text, p_nombre text, p_apellidos text, p_iniciales text) returns json
language plpgsql volatile security definer set search_path = public, extensions as $$
declare u public.piping_usuarios;
begin
    u := public.piping_usuario_de_token(p_token);
    if coalesce(trim(p_nombre), '') = '' then raise exception 'El nombre no puede quedar vacío'; end if;
    update public.piping_usuarios set nombre = trim(p_nombre), apellidos = coalesce(trim(p_apellidos), ''), iniciales = upper(left(coalesce(trim(p_iniciales), ''), 6)) where id = u.id returning * into u;
    return public.piping_json_usuario(u);
end $$;

-- registro de actividad: lo escribe la aplicación con la sesión del usuario; solo lo lee un administrador
create or replace function public.piping_registrar(p_token text, p_accion text, p_detalle text default null, p_proyecto text default null) returns void
language plpgsql volatile security definer set search_path = public, extensions as $$
declare u public.piping_usuarios;
begin
    u := public.piping_usuario_de_token(p_token);
    insert into public.piping_registro (usuario, nombre, rol, accion, detalle, proyecto)
    values (u.usuario, trim(u.nombre || ' ' || u.apellidos), u.rol, left(p_accion, 60), left(p_detalle, 500), left(p_proyecto, 120));
end $$;

create or replace function public.piping_registro_listar(p_token text, p_limite integer default 500, p_usuario text default null, p_desde timestamptz default null) returns json
language plpgsql stable security definer set search_path = public, extensions as $$
begin
    perform public.piping_exigir_admin(p_token);
    return coalesce((select json_agg(x) from (select id, fecha, usuario, nombre, rol, accion, detalle, proyecto from public.piping_registro
        where (p_usuario is null or usuario = lower(p_usuario)) and (p_desde is null or fecha >= p_desde) order by fecha desc limit least(greatest(p_limite, 1), 5000)) x), '[]'::json);
end $$;

grant execute on function public.piping_login(text, text, boolean), public.piping_renovar(text), public.piping_perfil_actualizar(text, text, text, text),
    public.piping_registrar(text, text, text, text), public.piping_registro_listar(text, integer, text, timestamptz) to anon, authenticated;
notify pgrst, 'reload schema';
