-- =====================================================================================
-- PIPING · Esquema de base de datos para Supabase (PostgreSQL 15+)
-- Versión 7.2 · 2026-09-29
-- Agrupación: catálogo técnico (lectura para todos los usuarios, escritura solo ADMIN)
--             + proyectos (cada usuario ve los suyos y los compartidos con él).
-- Las tablas reproducen la estructura de catalogo.js: la app construirá window.CATALOGO con
-- la vista v_catalogo (o con consultas por grupo), sin cambiar el motor de cálculo.
-- =====================================================================================

create extension if not exists "pgcrypto";

-- ---------- Usuarios y roles ----------
create table if not exists perfiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  nombre      text,
  empresa     text,
  rol         text not null default 'USUARIO' check (rol in ('ADMIN','USUARIO','REVISOR')),
  creado      timestamptz not null default now()
);
create or replace function es_admin() returns boolean language sql stable security definer as $$
  select exists (select 1 from perfiles where id = auth.uid() and rol = 'ADMIN');
$$;

-- ---------- Versión del catálogo ----------
create table if not exists catalogo_version (
  version     text primary key,            -- p. ej. '2026-09-26'
  fecha       date not null default current_date,
  fuentes     text,
  vigente     boolean not null default false
);

-- =====================================================================================
-- 1. FLUIDOS
-- =====================================================================================
create table if not exists fluidos (
  id          serial primary key,
  nombre      text not null unique,
  grupo_ped   smallint check (grupo_ped in (1,2)),   -- null = automático según TS
  medio_naval text,                                    -- 'toxico','inflamable','vapor','agua'...
  kf_gpa      numeric,                                 -- módulo de compresibilidad (golpe de ariete)
  t_congelacion_c numeric,                             -- glicoles
  nota        text,
  activo      boolean not null default true
);
create table if not exists fluido_propiedades (
  fluido_id   int not null references fluidos(id) on delete cascade,
  t_c         numeric not null,        -- °C
  rho_kgm3    numeric not null,        -- kg/m³
  nu_mm2s     numeric not null,        -- viscosidad cinemática mm²/s (cSt)
  pv_kpa      numeric not null,        -- presión de vapor kPa abs
  primary key (fluido_id, t_c)
);
create table if not exists velocidades_recomendadas (
  fluido_id         int not null references fluidos(id) on delete cascade,
  tipo_instalacion  text not null check (tipo_instalacion in ('edificacion','industrial','naval')),
  v_asp_ms          numeric not null,
  v_imp_ms          numeric not null,
  primary key (fluido_id, tipo_instalacion)
);

-- =====================================================================================
-- 2. TUBERÍAS (materiales, series, tamaños y espesores)
-- =====================================================================================
create table if not exists materiales (
  id          serial primary key,
  nombre      text not null unique,     -- 'Acero al carbono', 'PE100'...
  codigo      text not null,            -- TAC, TAI, TPE... (nomenclatura)
  norma       text,                     -- ASME B36.10M, EN 12201-2...
  rugosidad_mm numeric not null,
  serie_def   text,
  s_adm_mpa   numeric,                  -- tensión admisible (ASME B31.3) · PMA
  sobreespesor_mm numeric,
  e_modulo_gpa numeric,                 -- Young (ariete)
  alfa_mm_mK  numeric,                  -- dilatación
  densidad_kgm3 numeric,
  dint_referencia boolean not null default false   -- sin tabla propia: Dint de Sch 40
);
create table if not exists material_series (
  material_id int not null references materiales(id) on delete cascade,
  serie       text not null,            -- '40', '10S', 'SDR 11 (PN16)', 'PN10'...
  orden       smallint not null default 0,
  primary key (material_id, serie)
);
create table if not exists tubo_tamanos (
  id          serial primary key,
  material_id int not null references materiales(id) on delete cascade,
  clave       text not null,            -- 'DN 50', 'd63'
  nps         text,                     -- '2', '1-1/2'
  od_mm       numeric not null,
  unique (material_id, clave)
);
create table if not exists tubo_espesores (
  tamano_id   int not null references tubo_tamanos(id) on delete cascade,
  serie       text not null,
  e_mm        numeric not null,
  primary key (tamano_id, serie)
);
create table if not exists equivalencia_dn_plastico (
  dn          int primary key,          -- DN de componente
  od_mm       numeric not null          -- diámetro exterior del tubo plástico equivalente
);
create table if not exists pulgadas_dn (
  nps         text primary key,
  dn          int not null
);

-- =====================================================================================
-- 3. PÉRDIDAS SINGULARES (Crane TP-410) Y ACCESORIOS
-- =====================================================================================
create table if not exists crane_ft (
  dn          int primary key,
  ft          numeric not null          -- factor de fricción en turbulencia completa
);
create table if not exists crane_k (
  id          serial primary key,
  clave       text not null,            -- 'codo', 'bola', 'globo'... (TIPOS[].crane)
  descripcion text not null,
  n_ft        numeric,                  -- K = n · fT
  k_fijo      numeric,                  -- K independiente del DN
  referencia  text,                     -- reutiliza la tabla de otra clave (p. ej. 'mariposa')
  calculo     text,                     -- fórmula especial: 'bolaRed', 'pedirCv'
  orden       smallint not null default 0,
  unique (clave, descripcion)
);
create table if not exists reducciones_b169 (
  dn_mayor    int not null,
  dn_menor    int not null,
  h_mm        numeric not null,         -- longitud ASME B16.9
  theta_deg   numeric not null,         -- ángulo total del cono
  primary key (dn_mayor, dn_menor)
);
create table if not exists retencion_vmin (
  tipo        text primary key,         -- 'Clapeta oscilante (swing)'...
  c           numeric not null          -- Vmin = C·√(1/ρ) (Crane)
);
-- Tipos de componente de la librería (símbolo, puertos, código de nomenclatura)
create table if not exists tipos_componente (
  subtipo     text primary key,         -- 'bola', 'tee', 'tkdiario'...
  tipo        text not null check (tipo in ('tuberia','accesorio','valvula','instrumento','bomba','equipo','terminal','anotacion')),
  categoria   text not null,            -- 'accesorios','tanques','intercambiadores','valvulas'...
  codigo      text not null,            -- VB, TE, TKD...
  nombre      text not null,
  calculo     text not null,            -- crane, cero, pedir, nodo, reduccion, sinflujo, equipo, consumo, deposito
  crane_clave text,
  puertos     jsonb not null default '[]', -- [{x,y,id}] en el cuadro de 50×50
  circuitos   smallint not null default 1,
  simbolo_svg text,                     -- plantilla opcional (norma de la empresa cliente)
  norma       text not null default 'ISO 10628-2'
);

-- =====================================================================================
-- 4. VÁLVULAS DE CATÁLOGO (Cv por tamaño) Y PRESIONES NOMINALES
-- =====================================================================================
create table if not exists fabricantes (
  id          serial primary key,
  nombre      text not null unique,
  web         text
);
create table if not exists valvulas_catalogo (
  id          serial primary key,
  fabricante_id int references fabricantes(id),
  nombre      text not null unique,     -- 'Tyco · Figure F803 · Total · Brida'
  tipo        text not null,            -- subtipo de TIPOS ('bola','mariposa'...)
  pn          text,                     -- 'PN 16', '150#'
  fuente      text,
  nota        text
);
create table if not exists valvula_cv (
  valvula_id  int not null references valvulas_catalogo(id) on delete cascade,
  nps         text not null,            -- '2', '1-1/4'
  cv          numeric not null,         -- gpm/√psi
  primary key (valvula_id, nps)
);
create table if not exists presion_nominal (
  norma       text not null,            -- 'EN 1092-1', 'ASME B16.5'
  clase       text not null,            -- 'PN 16', '150#'
  grupo_material text not null,         -- '1.1' (A105/WCB), '2.2' (316)... o 'EN'
  t_c         numeric not null,
  p_bar       numeric not null,         -- presión admisible
  primary key (norma, clase, grupo_material, t_c)
);
-- Tablas PN del fabricante (cuando las aporte): sustituyen a las orientativas
create table if not exists presion_nominal_fabricante (
  fabricante_id int not null references fabricantes(id) on delete cascade,
  serie       text not null,
  clase       text not null,
  t_c         numeric not null,
  p_bar       numeric not null,
  primary key (fabricante_id, serie, clase, t_c)
);

-- =====================================================================================
-- 5. BOMBAS Y MOTORES
-- =====================================================================================
create table if not exists bombas_catalogo (
  id          serial primary key,
  fabricante_id int references fabricantes(id),
  modelo      text not null,
  tipo        text,                     -- centrífuga normalizada, en línea, sumergible...
  dn_asp      text, dn_imp text,
  rpm         int,
  diametro_rodete_mm numeric,
  pn          text,
  fuente      text,                     -- PDF de la curva
  unique (fabricante_id, modelo, diametro_rodete_mm, rpm)
);
create table if not exists bomba_curva (
  bomba_id    int not null references bombas_catalogo(id) on delete cascade,
  q_m3h       numeric not null,
  h_m         numeric not null,
  eta         numeric,                  -- rendimiento (0-1)
  npshr_m     numeric,
  p_kw        numeric,
  primary key (bomba_id, q_m3h)
);
create table if not exists motores_iec (
  potencia_kw numeric primary key,      -- 0,12 … 400 kW (IEC 60034)
  eficiencia_ie3 numeric
);

-- =====================================================================================
-- 6. TANQUES, INTERCAMBIADORES, EQUIPOS E INSTRUMENTOS DE CATÁLOGO
-- =====================================================================================
create table if not exists tanques_catalogo (
  id          serial primary key,
  fabricante_id int references fabricantes(id),
  subtipo     text not null references tipos_componente(subtipo),
  modelo      text not null,
  volumen_l   numeric,
  altura_m    numeric,
  presion_max_bar numeric,
  conexiones  jsonb not null default '[]'   -- [{puerto:'b', altura_m, dn, tipo:'Brida'}]
);
create table if not exists equipos_catalogo (
  id          serial primary key,
  fabricante_id int references fabricantes(id),
  subtipo     text not null references tipos_componente(subtipo),   -- icplacas, enfriadora, fancoil...
  modelo      text not null,
  q_nom_m3h   numeric, dp_nom_kpa numeric,          -- primario
  q_nom2_m3h  numeric, dp_nom2_kpa numeric,         -- secundario (dos circuitos)
  volumen_l   numeric,
  pn          text,
  potencia_kw numeric
);
create table if not exists instrumentos_catalogo (
  id          serial primary key,
  fabricante_id int references fabricantes(id),
  subtipo     text not null references tipos_componente(subtipo),
  modelo      text not null,
  rango       text,
  conexion    text                      -- '1/2" NPT', 'G 1/2'
);

-- =====================================================================================
-- 7. CRITERIOS NORMATIVOS (PED, RITE, clases navales)
-- =====================================================================================
create table if not exists ped_limites (
  cuadro      smallint not null,        -- 6..9 (anexo II)
  categoria   text not null,            -- 'art. 4.3', 'I', 'II', 'III'
  ps_dn_max   numeric, dn_max numeric, ps_max numeric,
  primary key (cuadro, categoria)
);
create table if not exists rite_aislamiento (
  tipo        text not null check (tipo in ('calor','frio')),
  d_ext_max_mm numeric not null,
  t_min_c     numeric not null,
  t_max_c     numeric not null,
  espesor_mm  numeric not null,
  primary key (tipo, d_ext_max_mm, t_min_c)
);
create table if not exists clases_navales (
  sociedad    text not null,            -- BV, LR, DNV
  medio       text not null,
  clase       smallint not null,
  p_max_bar   numeric, t_max_c numeric,
  primary key (sociedad, medio, clase)
);

-- =====================================================================================
-- 8. PROYECTOS
-- =====================================================================================
create table if not exists proyectos (
  id          uuid primary key default gen_random_uuid(),
  propietario uuid not null references auth.users(id) default auth.uid(),
  numero      text not null,
  cliente     text,
  instalacion text,
  revision    text not null default '0',
  datos       jsonb not null,           -- objeto "proyecto" de la app
  contenido   jsonb not null,           -- .pid completo (elementos, líneas, opciones)
  version_app text,
  version_catalogo text references catalogo_version(version),
  actualizado timestamptz not null default now(),
  unique (propietario, numero)
);
create table if not exists proyecto_compartido (
  proyecto_id uuid not null references proyectos(id) on delete cascade,
  usuario_id  uuid not null references auth.users(id) on delete cascade,
  permiso     text not null default 'lectura' check (permiso in ('lectura','edicion')),
  primary key (proyecto_id, usuario_id)
);
create table if not exists proyecto_revisiones (
  proyecto_id uuid not null references proyectos(id) on delete cascade,
  rev         text not null,
  fecha       date not null default current_date,
  autor       text,
  descripcion text,
  contenido   jsonb not null,
  primary key (proyecto_id, rev)
);
create table if not exists plantillas (
  id          serial primary key,
  propietario uuid references auth.users(id) default auth.uid(),   -- null = plantilla de empresa
  nombre      text not null,
  contenido   jsonb not null
);
create index if not exists idx_tamanos_material on tubo_tamanos(material_id);
create index if not exists idx_proyectos_prop on proyectos(propietario);

-- =====================================================================================
-- 9. SEGURIDAD (RLS): catálogo de solo lectura; escritura ADMIN; proyectos por propietario
-- =====================================================================================
do $$
declare t text;
begin
  foreach t in array array['catalogo_version','fluidos','fluido_propiedades','velocidades_recomendadas','materiales','material_series',
    'tubo_tamanos','tubo_espesores','equivalencia_dn_plastico','pulgadas_dn','crane_ft','crane_k','reducciones_b169','retencion_vmin',
    'tipos_componente','fabricantes','valvulas_catalogo','valvula_cv','presion_nominal','presion_nominal_fabricante','bombas_catalogo',
    'bomba_curva','motores_iec','tanques_catalogo','equipos_catalogo','instrumentos_catalogo','ped_limites','rite_aislamiento','clases_navales']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists lectura on %I', t);
    execute format('create policy lectura on %I for select to authenticated using (true)', t);
    execute format('drop policy if exists escritura_admin on %I', t);
    execute format('create policy escritura_admin on %I for all to authenticated using (es_admin()) with check (es_admin())', t);
  end loop;
end $$;

alter table perfiles enable row level security;
drop policy if exists perfil_propio on perfiles;
create policy perfil_propio on perfiles for select to authenticated using (id = auth.uid() or es_admin());
drop policy if exists perfil_admin on perfiles;
create policy perfil_admin on perfiles for update to authenticated using (es_admin());

alter table proyectos enable row level security;
drop policy if exists proyectos_ver on proyectos;
create policy proyectos_ver on proyectos for select to authenticated using (
  propietario = auth.uid() or es_admin() or exists (select 1 from proyecto_compartido c where c.proyecto_id = id and c.usuario_id = auth.uid()));
drop policy if exists proyectos_crear on proyectos;
create policy proyectos_crear on proyectos for insert to authenticated with check (propietario = auth.uid());
drop policy if exists proyectos_editar on proyectos;
create policy proyectos_editar on proyectos for update to authenticated using (
  propietario = auth.uid() or exists (select 1 from proyecto_compartido c where c.proyecto_id = id and c.usuario_id = auth.uid() and c.permiso = 'edicion'));
drop policy if exists proyectos_borrar on proyectos;
create policy proyectos_borrar on proyectos for delete to authenticated using (propietario = auth.uid());

alter table proyecto_compartido enable row level security;
drop policy if exists compartir on proyecto_compartido;
create policy compartir on proyecto_compartido for all to authenticated using (
  exists (select 1 from proyectos p where p.id = proyecto_id and p.propietario = auth.uid()) or usuario_id = auth.uid());

alter table proyecto_revisiones enable row level security;
drop policy if exists revisiones on proyecto_revisiones;
create policy revisiones on proyecto_revisiones for all to authenticated using (
  exists (select 1 from proyectos p where p.id = proyecto_id and (p.propietario = auth.uid() or es_admin())));

alter table plantillas enable row level security;
drop policy if exists plantillas_ver on plantillas;
create policy plantillas_ver on plantillas for select to authenticated using (propietario is null or propietario = auth.uid());
drop policy if exists plantillas_editar on plantillas;
create policy plantillas_editar on plantillas for all to authenticated using (propietario = auth.uid() or (propietario is null and es_admin()));

-- =====================================================================================
-- 10. VISTA: catálogo en el mismo formato que catalogo.js (una sola petición al arrancar)
-- =====================================================================================
create or replace view v_catalogo as
select jsonb_build_object(
  'version', (select version from catalogo_version where vigente limit 1),
  'fuentes', (select fuentes from catalogo_version where vigente limit 1),
  'fluidos', (select jsonb_object_agg(f.nombre, jsonb_strip_nulls(jsonb_build_object(
      'tabla', (select jsonb_agg(jsonb_build_array(p.t_c, p.rho_kgm3, p.nu_mm2s, p.pv_kpa) order by p.t_c) from fluido_propiedades p where p.fluido_id = f.id),
      'nota', f.nota, 'Kf', f.kf_gpa, 'Tcong', f.t_congelacion_c))) from fluidos f where f.activo),
  'materiales', (select jsonb_object_agg(m.nombre, jsonb_build_object(
      'norma', m.norma, 'rug', m.rugosidad_mm, 'serieDef', m.serie_def,
      'series', (select jsonb_agg(s.serie order by s.orden) from material_series s where s.material_id = m.id),
      'tamanos', (select jsonb_agg(jsonb_build_object('clave', t.clave, 'nps', t.nps, 'od', t.od_mm,
                    'e', (select jsonb_object_agg(e.serie, e.e_mm) from tubo_espesores e where e.tamano_id = t.id)) order by t.od_mm)
                  from tubo_tamanos t where t.material_id = m.id))) from materiales m),
  'crane', (select jsonb_object_agg(c.clave, c.lista) from (select clave, jsonb_agg(jsonb_build_array(descripcion,
      coalesce(to_jsonb(n_ft), case when k_fijo is not null then jsonb_build_object('K', k_fijo) end, to_jsonb(referencia), jsonb_build_object('calc', calculo))) order by orden) lista
      from crane_k group by clave) c),
  'ft', (select jsonb_agg(jsonb_build_array(dn, ft) order by dn) from crane_ft),
  'vmin', (select jsonb_object_agg(tipo, c) from retencion_vmin),
  'reducciones', (select jsonb_object_agg(dn_mayor || '-' || dn_menor, jsonb_build_object('H', h_mm, 'theta', theta_deg)) from reducciones_b169),
  'inchDN', (select jsonb_object_agg(nps, dn) from pulgadas_dn),
  'valvulas', (select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('nombre', v.nombre, 'tipo', v.tipo, 'fuente', v.fuente, 'nota', v.nota,
      'cv', (select jsonb_object_agg(c.nps, c.cv) from valvula_cv c where c.valvula_id = v.id)))) from valvulas_catalogo v)
) as catalogo;
grant select on v_catalogo to authenticated;
