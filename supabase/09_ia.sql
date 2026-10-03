-- PIPING v8.19 · Asistente de IA (lectura de fichas técnicas de bombas en PDF)
-- Ejecutar en Supabase > SQL Editor después de 05_usuarios.sql y 06_sesion_perfil_registro.sql.
-- La función de servidor «piping-bomba-pdf» (Edge Function) llama a piping_ia_permiso antes de consultar a Gemini:
-- comprueba la sesión de PIPING y limita el número de lecturas por usuario y día (la clave de Gemini no sale del servidor).

create table if not exists public.piping_ia_uso (
    id bigint generated always as identity primary key,
    usuario text not null,
    funcion text not null default 'bomba-pdf',
    cuando timestamptz not null default now()
);
create index if not exists piping_ia_uso_usuario on public.piping_ia_uso (usuario, cuando);
alter table public.piping_ia_uso enable row level security;
revoke all on public.piping_ia_uso from anon, authenticated;

-- límite de lecturas: por usuario y día, y total del día (para no agotar la cuota gratuita de Gemini)
create or replace function public.piping_ia_permiso(p_token text, p_funcion text default 'bomba-pdf') returns json
language plpgsql volatile security definer set search_path = public, extensions as $$
declare u public.piping_usuarios; n_usuario integer; n_total integer;
        c_usuario constant integer := 20; c_total constant integer := 60;
begin
    u := public.piping_usuario_de_token(p_token);
    select count(*) filter (where usuario = u.usuario), count(*) into n_usuario, n_total
      from public.piping_ia_uso where cuando >= date_trunc('day', now());
    if n_usuario >= c_usuario then raise exception 'Has alcanzado el límite de % lecturas con IA por día', c_usuario; end if;
    if n_total >= c_total then raise exception 'Se ha alcanzado el límite diario de lecturas con IA (%)', c_total; end if;
    insert into public.piping_ia_uso (usuario, funcion) values (u.usuario, left(coalesce(p_funcion, ''), 40));
    delete from public.piping_ia_uso where cuando < now() - interval '90 days';
    return json_build_object('usuario', u.usuario, 'rol', u.rol, 'usadas_hoy', n_usuario + 1, 'limite', c_usuario);
end $$;

grant execute on function public.piping_ia_permiso(text, text) to anon, authenticated;
notify pgrst, 'reload schema';
