-- PIPING · lectura pública del catálogo con la clave anon (la app aún no pide inicio de sesión).
-- La vista v_catalogo se ejecuta con los permisos de su propietario, así que basta con concederla;
-- las tablas siguen protegidas por RLS (lectura solo para usuarios autenticados, escritura ADMIN).
grant usage on schema public to anon;
grant select on v_catalogo to anon, authenticated;
