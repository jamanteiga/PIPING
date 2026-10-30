-- PIPING v8.65 · Registro de accesos (quién entra, desde dónde, IP, sistema, navegador…)
-- Ejecutar en Supabase > SQL Editor después de 05 y 06. Lo escribe solo la Edge Function «piping-acceso»
-- (con la clave service_role que Supabase le da dentro; nunca va en el navegador). Lo lee un administrador
-- de PIPING con su sesión: Archivo › Administración › Registro de accesos.

create table if not exists public.piping_accesos (
    id          bigint generated always as identity primary key,
    fecha       timestamptz not null default now(),
    evento      text not null,              -- entrada · inicio de sesión · salida
    modo        text,                       -- invitado · sesión · sesión recordada
    usuario     text, rol text,
    ip          text, pais text, region text, ciudad text, isp text, lat numeric, lon numeric,
    so          text, navegador text, dispositivo text,
    idioma      text, zona text, pantalla text, ventana text,
    referer     text, url text, version text,
    visitante   text, sesion text, segundos integer,
    ua          text, extra jsonb
);
create index if not exists piping_accesos_fecha_idx on public.piping_accesos (fecha desc);
create index if not exists piping_accesos_sesion_idx on public.piping_accesos (sesion);
alter table public.piping_accesos enable row level security;
revoke all on public.piping_accesos from anon, authenticated;

-- lectura: solo un administrador de PIPING (token de piping_sesiones, rol admin)
create or replace function public.piping_accesos_listar(p_token text, p_limite integer default 2000, p_desde timestamptz default null) returns json
language plpgsql stable security definer set search_path = public, extensions as $$
begin
    perform public.piping_exigir_admin(p_token);
    return coalesce((select json_agg(x order by x.fecha desc) from (
        select id, fecha, evento, modo, usuario, rol, ip, pais, region, ciudad, isp, so, navegador, dispositivo, idioma, zona, pantalla,
               referer, url, version, visitante, sesion, segundos, ua
          from public.piping_accesos where p_desde is null or fecha >= p_desde
         order by fecha desc limit least(greatest(coalesce(p_limite, 2000), 1), 10000)) x), '[]'::json);
end $$;
revoke all on function public.piping_accesos_listar(text, integer, timestamptz) from public;
grant execute on function public.piping_accesos_listar(text, integer, timestamptz) to anon, authenticated;

-- conservación: la función borra (de vez en cuando, al registrar una entrada) los accesos de más de 12 meses (RGPD: minimización)
create or replace function public.piping_accesos_purgar() returns void language sql security definer set search_path = public as $$
    delete from public.piping_accesos where fecha < now() - interval '12 months';
$$;
revoke all on function public.piping_accesos_purgar() from public, anon, authenticated;
