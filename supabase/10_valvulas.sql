-- PIPING v8.26 · Base de datos de válvulas (librería compartida de la empresa)
-- Ejecutar en Supabase > SQL Editor después de 05, 06 y 08. Se puede volver a ejecutar sin perder datos.
-- Lectura: cualquier navegador con la clave anon (RPC piping_valves_listar).
-- Escritura y borrado: solo administradores con sesión de PIPING (piping_exigir_admin), y queda en piping_registro.

create table if not exists public.piping_valves (
    valve_id         varchar(80) primary key,               -- 'cat:<nombre>' sustituye a una válvula del catálogo del programa
    subtype          varchar(40) not null,                  -- bola, mariposa, compuerta, globo, retencion, control...
    name             varchar(200) not null,
    manufacturer     varchar(100) default '',
    model            varchar(100) default '',
    body_material    varchar(120) default '',               -- material del cuerpo (ASTM / EN)
    standard         varchar(120) default '',               -- norma de fabricación / dimensional
    pressure_rating  varchar(20) default '',                -- PN 16, 150#...
    url              text default '',
    notes            text default '',
    -- resto de datos: craneTipo, cv (por tamaño), kvs, FL, curvaApertura, conexValv, normaValv, caraCara, dnMinV, dnMaxV,
    -- tMinV, tMaxV, asiento, obturador, vastago, normaDisenoV, accionamiento, fireSafe
    props            jsonb not null default '{}'::jsonb,
    modificado       timestamptz default now(),
    modificado_por   varchar(60) default ''
);
create index if not exists piping_valves_subtype on public.piping_valves (subtype, name);
alter table public.piping_valves enable row level security;
revoke all on public.piping_valves from anon, authenticated;

create or replace function public.piping_valves_listar() returns json
language sql stable security definer set search_path = public as $$
    select coalesce(json_agg(to_jsonb(v) order by v.subtype, v.name), '[]'::json) from public.piping_valves v $$;

create or replace function public.piping_valve_guardar(p_token text, p_item json) returns json
language plpgsql volatile security definer set search_path = public, extensions as $$
declare u public.piping_usuarios; v_id text := nullif(trim(p_item->>'valve_id'), ''); v_nuevo boolean; r public.piping_valves;
begin
    u := public.piping_exigir_admin(p_token);
    if coalesce(trim(p_item->>'name'), '') = '' then raise exception 'Indica el nombre de la válvula'; end if;
    if coalesce(trim(p_item->>'subtype'), '') = '' then raise exception 'Indica el tipo de válvula'; end if;
    if v_id is null then
        v_id := left('VAL-' || upper(regexp_replace(coalesce(nullif(trim(p_item->>'manufacturer'), ''), 'EMP') || '-' || coalesce(nullif(trim(p_item->>'model'), ''), trim(p_item->>'name')), '[^A-Za-z0-9]+', '-', 'g')), 70);
        if exists (select 1 from public.piping_valves where valve_id = v_id) then v_id := left(v_id, 70) || '-' || upper(encode(gen_random_bytes(2), 'hex')); end if;
    end if;
    v_nuevo := not exists (select 1 from public.piping_valves where valve_id = v_id);
    insert into public.piping_valves (valve_id, subtype, name, manufacturer, model, body_material, standard, pressure_rating, url, notes, props, modificado, modificado_por)
    values (v_id, trim(p_item->>'subtype'), trim(p_item->>'name'), coalesce(p_item->>'manufacturer', ''), coalesce(p_item->>'model', ''), coalesce(p_item->>'body_material', ''),
            coalesce(p_item->>'standard', ''), coalesce(p_item->>'pressure_rating', ''), coalesce(p_item->>'url', ''), coalesce(p_item->>'notes', ''),
            case when json_typeof(p_item->'props') = 'object' then (p_item->'props')::jsonb else '{}'::jsonb end, now(), u.usuario)
    on conflict (valve_id) do update set subtype = excluded.subtype, name = excluded.name, manufacturer = excluded.manufacturer, model = excluded.model, body_material = excluded.body_material,
            standard = excluded.standard, pressure_rating = excluded.pressure_rating, url = excluded.url, notes = excluded.notes, props = excluded.props, modificado = now(), modificado_por = u.usuario
    returning * into r;
    insert into public.piping_registro (usuario, nombre, rol, accion, detalle) values (u.usuario, trim(u.nombre || ' ' || u.apellidos), u.rol, case when v_nuevo then 'válvula creada' else 'válvula modificada' end, left(r.valve_id || ' · ' || r.name, 500));
    return row_to_json(r);
end $$;

create or replace function public.piping_valve_borrar(p_token text, p_id text) returns void
language plpgsql volatile security definer set search_path = public, extensions as $$
declare u public.piping_usuarios; n text;
begin
    u := public.piping_exigir_admin(p_token);
    delete from public.piping_valves where valve_id = p_id returning name into n;
    if not found then raise exception 'Válvula no encontrada'; end if;
    insert into public.piping_registro (usuario, nombre, rol, accion, detalle) values (u.usuario, trim(u.nombre || ' ' || u.apellidos), u.rol, 'válvula eliminada', left(p_id || ' · ' || n, 500));
end $$;

grant execute on function public.piping_valves_listar(), public.piping_valve_guardar(text, json), public.piping_valve_borrar(text, text) to anon, authenticated;

notify pgrst, 'reload schema';
