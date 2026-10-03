-- =====================================================================================
-- PIPING v8.18 · Base de datos de bombas
--   piping_pumps                   datos generales, punto de diseño (duty point), motor y conexiones
--   piping_pump_curves             curva característica por puntos (solo centrífugas): Q-H, Q-η, Q-NPSHr
--   piping_volumetric_pump_specs   bombas volumétricas (pistón, peristáltica, dosificadora...): desplazamiento y presión máxima
--
-- Ejecutar en Supabase > SQL Editor después de 05 y 06. Se puede repetir.
-- Lectura: cualquiera con la clave anon (piping_pumps_listar). Altas, cambios y bajas: solo administrador, desde
-- Librerías > Bombas... de la aplicación.
-- =====================================================================================

create table if not exists public.piping_pumps (
    pump_id          varchar(50) primary key,
    tag_name         varchar(50) not null default '',   -- identificador del equipo (p. ej. P-101A)
    pump_type        varchar(50) not null default 'Centrifugal',   -- Centrifugal, Peristaltic, Piston, Metering, Diaphragm, Gear, Screw, Lobe
    manufacturer     varchar(100) default '',
    model            varchar(100) default '',
    design_fluid     varchar(100) default '',           -- fluido de diseño (texto: tipo, viscosidad, temperatura)
    -- punto de diseño (duty point)
    design_flow_m3h  decimal(10, 4) not null,           -- caudal de diseño
    design_head_m    decimal(10, 4) not null,           -- altura manométrica total (m)
    shutoff_head_m   decimal(10, 4),                    -- altura a caudal cero (m)
    npshr_m          decimal(6, 2),                     -- NPSH requerido
    operational_rpm  decimal(8, 2),                     -- velocidad de giro
    -- datos eléctricos y rendimiento
    motor_power_kw   decimal(8, 2),                     -- potencia instalada
    efficiency_pct   decimal(5, 2),                     -- rendimiento hidráulico-mecánico (%)
    voltage          varchar(30) default '',
    frequency_hz     varchar(20) default '',
    ip_rating        varchar(20) default '',
    -- impulsor (centrífugas)
    impeller_mm      decimal(8, 2),
    impeller_max_mm  decimal(8, 2),
    -- conexiones y bridas (ASME / EN)
    suction_size     varchar(20) default '',            -- p. ej. DN 80
    discharge_size   varchar(20) default '',
    flange_standard  varchar(20) default '',            -- ASME o EN
    pressure_rating  varchar(20) default '',            -- 150#, PN 16, PN 40...
    api_plan         varchar(50) default '',            -- plan de sellado (API 682): 11, 21, 52...
    url              text default '',
    notes            text default '',
    modificado       timestamptz not null default now(),
    modificado_por   text
);
create table if not exists public.piping_pump_curves (
    curve_id        bigint generated always as identity primary key,
    pump_id         varchar(50) not null references public.piping_pumps(pump_id) on delete cascade,
    flow_m3h        decimal(10, 4) not null,            -- caudal en el punto
    head_m          decimal(10, 4) not null,            -- altura generada (m)
    efficiency_pct  decimal(5, 2),                      -- rendimiento en ese punto
    npshr_m         decimal(6, 2)                       -- NPSHr en ese punto
);
create index if not exists piping_pump_curves_pump on public.piping_pump_curves (pump_id, flow_m3h);
create table if not exists public.piping_volumetric_pump_specs (
    pump_id                      varchar(50) primary key references public.piping_pumps(pump_id) on delete cascade,
    displacement_per_stroke_cm3  decimal(10, 4),        -- volumen por revolución / embolada
    max_discharge_pressure_bar   decimal(10, 2) not null,   -- límite de presión (tarado del alivio)
    strokes_per_minute           decimal(8, 2),         -- frecuencia de ciclos
    cylinders                    integer,               -- n.º de cilindros / pulsaciones por ciclo
    internal_material            varchar(50) default '' -- manguera (peristáltica) o sellos / válvulas (pistón)
);
alter table public.piping_pumps enable row level security;
alter table public.piping_pump_curves enable row level security;
alter table public.piping_volumetric_pump_specs enable row level security;
revoke all on public.piping_pumps, public.piping_pump_curves, public.piping_volumetric_pump_specs from anon, authenticated;

-- todas las bombas con su curva y sus datos volumétricos
create or replace function public.piping_pumps_listar() returns json
language sql stable security definer set search_path = public as $$
    select coalesce(json_agg(x order by x->>'manufacturer', x->>'model', x->>'pump_id'), '[]'::json) from (
        select (to_jsonb(p) || jsonb_build_object(
            'curves', coalesce((select jsonb_agg(jsonb_build_object('flow_m3h', c.flow_m3h, 'head_m', c.head_m, 'efficiency_pct', c.efficiency_pct, 'npshr_m', c.npshr_m) order by c.flow_m3h) from public.piping_pump_curves c where c.pump_id = p.pump_id), '[]'::jsonb),
            'volumetric', (select to_jsonb(v) - 'pump_id' from public.piping_volumetric_pump_specs v where v.pump_id = p.pump_id)))::json as x
        from public.piping_pumps p) t $$;

create or replace function public.piping_pump_guardar(p_token text, p_item json) returns json
language plpgsql volatile security definer set search_path = public, extensions as $$
declare u public.piping_usuarios; v_id text := nullif(trim(p_item->>'pump_id'), ''); v_nuevo boolean; v json := p_item->'volumetric'; c json; r public.piping_pumps;
    n numeric;
begin
    u := public.piping_exigir_admin(p_token);
    if coalesce(nullif(p_item->>'design_flow_m3h', '')::numeric, 0) <= 0 then raise exception 'Indica el caudal de diseño'; end if;
    if coalesce(nullif(p_item->>'design_head_m', '')::numeric, 0) <= 0 then raise exception 'Indica la altura manométrica de diseño'; end if;
    if v_id is null then
        v_id := left(upper(regexp_replace(coalesce(nullif(trim(p_item->>'manufacturer'), ''), 'BOMBA') || '-' || coalesce(nullif(trim(p_item->>'model'), ''), 'MODELO'), '[^A-Za-z0-9]+', '-', 'g')), 40);
        if exists (select 1 from public.piping_pumps where pump_id = v_id) then v_id := left(v_id, 40) || '-' || upper(encode(gen_random_bytes(2), 'hex')); end if;
    end if;
    v_nuevo := not exists (select 1 from public.piping_pumps where pump_id = v_id);
    insert into public.piping_pumps (pump_id, tag_name, pump_type, manufacturer, model, design_fluid, design_flow_m3h, design_head_m, shutoff_head_m, npshr_m, operational_rpm, motor_power_kw, efficiency_pct, voltage, frequency_hz, ip_rating,
            impeller_mm, impeller_max_mm, suction_size, discharge_size, flange_standard, pressure_rating, api_plan, url, notes, modificado, modificado_por)
    values (v_id, coalesce(p_item->>'tag_name', ''), coalesce(nullif(p_item->>'pump_type', ''), 'Centrifugal'), coalesce(p_item->>'manufacturer', ''), coalesce(p_item->>'model', ''), coalesce(p_item->>'design_fluid', ''),
            (p_item->>'design_flow_m3h')::numeric, (p_item->>'design_head_m')::numeric, nullif(p_item->>'shutoff_head_m', '')::numeric, nullif(p_item->>'npshr_m', '')::numeric, nullif(p_item->>'operational_rpm', '')::numeric,
            nullif(p_item->>'motor_power_kw', '')::numeric, nullif(p_item->>'efficiency_pct', '')::numeric, coalesce(p_item->>'voltage', ''), coalesce(p_item->>'frequency_hz', ''), coalesce(p_item->>'ip_rating', ''),
            nullif(p_item->>'impeller_mm', '')::numeric, nullif(p_item->>'impeller_max_mm', '')::numeric, coalesce(p_item->>'suction_size', ''), coalesce(p_item->>'discharge_size', ''), coalesce(p_item->>'flange_standard', ''),
            coalesce(p_item->>'pressure_rating', ''), coalesce(p_item->>'api_plan', ''), coalesce(p_item->>'url', ''), coalesce(p_item->>'notes', ''), now(), u.usuario)
    on conflict (pump_id) do update set tag_name = excluded.tag_name, pump_type = excluded.pump_type, manufacturer = excluded.manufacturer, model = excluded.model, design_fluid = excluded.design_fluid,
            design_flow_m3h = excluded.design_flow_m3h, design_head_m = excluded.design_head_m, shutoff_head_m = excluded.shutoff_head_m, npshr_m = excluded.npshr_m, operational_rpm = excluded.operational_rpm,
            motor_power_kw = excluded.motor_power_kw, efficiency_pct = excluded.efficiency_pct, voltage = excluded.voltage, frequency_hz = excluded.frequency_hz, ip_rating = excluded.ip_rating,
            impeller_mm = excluded.impeller_mm, impeller_max_mm = excluded.impeller_max_mm, suction_size = excluded.suction_size, discharge_size = excluded.discharge_size, flange_standard = excluded.flange_standard,
            pressure_rating = excluded.pressure_rating, api_plan = excluded.api_plan, url = excluded.url, notes = excluded.notes, modificado = now(), modificado_por = u.usuario
    returning * into r;
    -- la curva y los datos volumétricos se sustituyen enteros
    delete from public.piping_pump_curves where pump_id = v_id;
    if json_typeof(p_item->'curves') = 'array' then
        for c in select * from json_array_elements(p_item->'curves') loop
            insert into public.piping_pump_curves (pump_id, flow_m3h, head_m, efficiency_pct, npshr_m)
            values (v_id, (c->>'flow_m3h')::numeric, (c->>'head_m')::numeric, nullif(c->>'efficiency_pct', '')::numeric, nullif(c->>'npshr_m', '')::numeric);
        end loop;
    end if;
    delete from public.piping_volumetric_pump_specs where pump_id = v_id;
    if json_typeof(v) = 'object' then
        n := nullif(v->>'max_discharge_pressure_bar', '')::numeric;
        if coalesce(n, 0) <= 0 then raise exception 'En una bomba volumétrica hay que indicar la presión máxima de trabajo'; end if;
        insert into public.piping_volumetric_pump_specs (pump_id, displacement_per_stroke_cm3, max_discharge_pressure_bar, strokes_per_minute, cylinders, internal_material)
        values (v_id, nullif(v->>'displacement_per_stroke_cm3', '')::numeric, n, nullif(v->>'strokes_per_minute', '')::numeric, nullif(v->>'cylinders', '')::numeric::integer, coalesce(v->>'internal_material', ''));
    end if;
    insert into public.piping_registro (usuario, nombre, rol, accion, detalle) values (u.usuario, trim(u.nombre || ' ' || u.apellidos), u.rol, case when v_nuevo then 'bomba creada' else 'bomba modificada' end, left(r.pump_id || ' · ' || r.manufacturer || ' ' || r.model, 500));
    return row_to_json(r);
end $$;

create or replace function public.piping_pump_borrar(p_token text, p_id text) returns void
language plpgsql volatile security definer set search_path = public, extensions as $$
declare u public.piping_usuarios; n text;
begin
    u := public.piping_exigir_admin(p_token);
    delete from public.piping_pumps where pump_id = p_id returning manufacturer || ' ' || model into n;
    if not found then raise exception 'Bomba no encontrada'; end if;
    insert into public.piping_registro (usuario, nombre, rol, accion, detalle) values (u.usuario, trim(u.nombre || ' ' || u.apellidos), u.rol, 'bomba eliminada', left(p_id || ' · ' || n, 500));
end $$;

grant execute on function public.piping_pumps_listar(), public.piping_pump_guardar(text, json), public.piping_pump_borrar(text, text) to anon, authenticated;

notify pgrst, 'reload schema';
