-- =====================================================================================
-- PIPING v8.3 · Proyectos y librerías en la nube por equipos, con bloqueo de edición
-- Ejecutar en Supabase > SQL Editor después de 01, 02 y 03.
-- Tablas con prefijo piping_ para no chocar con las de otras aplicaciones del mismo proyecto Supabase
-- (p. ej. una tabla «proyectos» existente sin columna equipo_id).
-- Requiere Authentication > Providers > Email activado (usuarios con correo y contraseña).
-- =====================================================================================

create extension if not exists pgcrypto;

-- ---------- equipos y miembros ----------
create table if not exists public.piping_equipos (
    id          uuid primary key default gen_random_uuid(),
    nombre      text not null,
    creado_por  uuid references auth.users(id) default auth.uid(),
    creado      timestamptz not null default now()
);
create table if not exists public.piping_miembros (
    equipo_id   uuid not null references public.piping_equipos(id) on delete cascade,
    usuario_id  uuid not null references auth.users(id) on delete cascade,
    email       text,
    rol         text not null default 'editor' check (rol in ('admin', 'editor', 'lector')),
    primary key (equipo_id, usuario_id)
);

-- ---------- proyectos (.pid completo en «contenido») ----------
create table if not exists public.piping_proyectos (
    id                     uuid primary key default gen_random_uuid(),
    equipo_id              uuid not null references public.piping_equipos(id) on delete cascade,
    nombre                 text,
    numero                 text,
    contenido              text not null,
    version                integer not null default 1,
    creado                 timestamptz not null default now(),
    actualizado            timestamptz not null default now(),
    actualizado_por        uuid default auth.uid(),
    actualizado_por_email  text,
    bloqueado_por          uuid,
    bloqueado_por_email    text,
    bloqueado_hasta        timestamptz
);
create index if not exists piping_proyectos_equipo_idx on public.piping_proyectos (equipo_id, actualizado desc);

-- ---------- librerías compartidas (modelos de LIB.items) ----------
create table if not exists public.piping_librerias (
    id                     uuid primary key default gen_random_uuid(),
    equipo_id              uuid not null references public.piping_equipos(id) on delete cascade,
    nombre                 text not null,
    items                  jsonb not null default '[]'::jsonb,
    actualizado            timestamptz not null default now(),
    actualizado_por_email  text,
    unique (equipo_id, nombre)
);

-- ---------- funciones auxiliares ----------
create or replace function public.piping_es_miembro(e uuid, roles text[] default array['admin', 'editor', 'lector'])
returns boolean language sql stable security definer set search_path = public as $$
    select exists (select 1 from public.piping_miembros m where m.equipo_id = e and m.usuario_id = auth.uid() and m.rol = any (roles));
$$;

-- el creador de un equipo pasa a ser su administrador
create or replace function public.piping_equipo_creado() returns trigger language plpgsql security definer set search_path = public as $$
begin
    insert into public.piping_miembros (equipo_id, usuario_id, email, rol)
    values (new.id, auth.uid(), (select email from auth.users where id = auth.uid()), 'admin')
    on conflict do nothing;
    return new;
end $$;
drop trigger if exists tr_piping_equipo_creado on public.piping_equipos;
create trigger tr_piping_equipo_creado after insert on public.piping_equipos for each row execute function public.piping_equipo_creado();

-- un administrador añade miembros por su correo (deben haberse registrado antes)
create or replace function public.piping_anadir_miembro(p_equipo uuid, p_email text, p_rol text default 'editor')
returns void language plpgsql security definer set search_path = public as $$
declare u uuid;
begin
    if not public.piping_es_miembro(p_equipo, array['admin']) then raise exception 'Solo un administrador del equipo puede añadir miembros'; end if;
    select id into u from auth.users where lower(email) = lower(p_email);
    if u is null then raise exception 'No hay ningún usuario registrado con el correo %', p_email; end if;
    insert into public.piping_miembros (equipo_id, usuario_id, email, rol) values (p_equipo, u, lower(p_email), p_rol)
    on conflict (equipo_id, usuario_id) do update set rol = excluded.rol;
end $$;

-- bloqueo de edición: se concede si está libre, caducado o ya es del usuario (lo renueva PIPING cada 5 min)
create or replace function public.piping_bloquear_proyecto(p_id uuid, p_minutos integer default 10)
returns table (ok boolean, por text, hasta timestamptz) language plpgsql security definer set search_path = public as $$
declare r public.piping_proyectos;
begin
    update public.piping_proyectos p
       set bloqueado_por = auth.uid(), bloqueado_por_email = (auth.jwt() ->> 'email'), bloqueado_hasta = now() + make_interval(mins => p_minutos)
     where p.id = p_id and public.piping_es_miembro(p.equipo_id, array['admin', 'editor'])
       and (p.bloqueado_por is null or p.bloqueado_por = auth.uid() or p.bloqueado_hasta < now())
    returning * into r;
    if found then return query select true, r.bloqueado_por_email, r.bloqueado_hasta; return; end if;
    return query select false, p.bloqueado_por_email, p.bloqueado_hasta from public.piping_proyectos p where p.id = p_id;
end $$;

create or replace function public.piping_liberar_proyecto(p_id uuid)
returns void language sql security definer set search_path = public as $$
    update public.piping_proyectos set bloqueado_por = null, bloqueado_por_email = null, bloqueado_hasta = null
     where id = p_id and bloqueado_por = auth.uid();
$$;

-- ---------- seguridad por filas ----------
alter table public.piping_equipos   enable row level security;
alter table public.piping_miembros  enable row level security;
alter table public.piping_proyectos enable row level security;
alter table public.piping_librerias enable row level security;

drop policy if exists piping_eq_sel on public.piping_equipos;   create policy piping_eq_sel on public.piping_equipos   for select to authenticated using (public.piping_es_miembro(id) or creado_por = auth.uid());
drop policy if exists piping_eq_ins on public.piping_equipos;   create policy piping_eq_ins on public.piping_equipos   for insert to authenticated with check (auth.uid() is not null);
drop policy if exists piping_eq_upd on public.piping_equipos;   create policy piping_eq_upd on public.piping_equipos   for update to authenticated using (public.piping_es_miembro(id, array['admin']));
drop policy if exists piping_eq_del on public.piping_equipos;   create policy piping_eq_del on public.piping_equipos   for delete to authenticated using (public.piping_es_miembro(id, array['admin']));

drop policy if exists piping_mi_sel on public.piping_miembros;  create policy piping_mi_sel on public.piping_miembros  for select to authenticated using (usuario_id = auth.uid() or public.piping_es_miembro(equipo_id));
drop policy if exists piping_mi_del on public.piping_miembros;  create policy piping_mi_del on public.piping_miembros  for delete to authenticated using (public.piping_es_miembro(equipo_id, array['admin']) or usuario_id = auth.uid());

drop policy if exists piping_pr_sel on public.piping_proyectos; create policy piping_pr_sel on public.piping_proyectos for select to authenticated using (public.piping_es_miembro(equipo_id));
drop policy if exists piping_pr_ins on public.piping_proyectos; create policy piping_pr_ins on public.piping_proyectos for insert to authenticated with check (public.piping_es_miembro(equipo_id, array['admin', 'editor']));
-- solo se modifica con el bloqueo propio (o libre / caducado)
drop policy if exists piping_pr_upd on public.piping_proyectos; create policy piping_pr_upd on public.piping_proyectos for update to authenticated
    using (public.piping_es_miembro(equipo_id, array['admin', 'editor']) and (bloqueado_por is null or bloqueado_por = auth.uid() or bloqueado_hasta < now()))
    with check (public.piping_es_miembro(equipo_id, array['admin', 'editor']));
drop policy if exists piping_pr_del on public.piping_proyectos; create policy piping_pr_del on public.piping_proyectos for delete to authenticated using (public.piping_es_miembro(equipo_id, array['admin']));

drop policy if exists piping_li_sel on public.piping_librerias; create policy piping_li_sel on public.piping_librerias for select to authenticated using (public.piping_es_miembro(equipo_id));
drop policy if exists piping_li_ins on public.piping_librerias; create policy piping_li_ins on public.piping_librerias for insert to authenticated with check (public.piping_es_miembro(equipo_id, array['admin', 'editor']));
drop policy if exists piping_li_upd on public.piping_librerias; create policy piping_li_upd on public.piping_librerias for update to authenticated using (public.piping_es_miembro(equipo_id, array['admin', 'editor']));
drop policy if exists piping_li_del on public.piping_librerias; create policy piping_li_del on public.piping_librerias for delete to authenticated using (public.piping_es_miembro(equipo_id, array['admin']));

grant select, insert, update, delete on public.piping_equipos, public.piping_miembros, public.piping_proyectos, public.piping_librerias to authenticated;
grant execute on function public.piping_es_miembro(uuid, text[]), public.piping_anadir_miembro(uuid, text, text), public.piping_bloquear_proyecto(uuid, integer), public.piping_liberar_proyecto(uuid) to authenticated;
