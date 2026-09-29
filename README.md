# PIPING 7.3 · Marco SolidWorks, Supabase y enlace PED (2026-09-29)

- **index.html** (7.3.1): md5 8649667b…; la copia anterior es `index_antes_v731.html`.

## Marco A3 estilo DRAWINGS (según la imagen de José)
- Fondo «Papel SolidWorks» (#e8e6dc), que es el nuevo valor por defecto.
- Marco grueso a 10 mm en los cuatro lados y línea fina exterior a 4 mm del borde.
- Divisiones de zona entre la línea exterior y el marco:
  - números arriba y abajo (de mayor a 1);
  - letras a izquierda y derecha (A abajo).
- Marcas de centrado que entran 5 mm en el marco.
- Rejilla discontinua: líneas mayores cada 10 mm y 2 divisiones.
- El mismo estilo se aplica en A4, A2, A1 y A0.
- **A4 en vertical** (7.3.1): 210 × 297 mm, es decir, el A3 girado 90° antihorario. Letras A–F en el eje Y y números 4–1 en el eje X; se imprime en vertical. A3, A2, A1 y A0 siguen apaisados.
- Cajetín: pendiente de que José lo envíe en dwg, dgn o dxf.

## Supabase (proyecto wuarkraddnndmgvfnkmm)
- URL: https://wuarkraddnndmgvfnkmm.supabase.co
- Configuración en **Opciones > Supabase**: se pega la clave **anon**; la app rechaza la service_role.
  - La clave está en Supabase, en Project Settings > API Keys > Legacy API Keys > anon public (empieza por eyJ…).
- El catálogo se lee de la vista `v_catalogo` y se guarda en el navegador. Sustituye a catalogo.js si está completo y su versión es igual o más reciente.
- Al arrancar, con clave configurada, se sincroniza en segundo plano.
- Instalación en el SQL Editor, en este orden: `01_esquema.sql`, `02_datos.sql` y `03_permisos_anon.sql`. Este último permite leer `v_catalogo` con la clave anon.
- Pendiente: guardar proyectos en Supabase. Requiere inicio de sesión (Auth) y definir roles.

## Enlace con «Recipientes a presión» (jamanteiga.github.io/RecipientesPresion)
- **Origen**: la app local está en `Documents\PROYECTOS\CE\RECIPIENTES_PRESION\index.html`.
- **Cambio en esa app**: ahora lee parámetros de la URL: `?ps=&v=&fluido=<id>`, o bien `&grupo=1|2&estado=gas|liquido&nombre=`. Copia previa: `index_antes_enlace_PIPING.html`. Hay que publicarla en GitHub Pages para que el enlace funcione en línea.
- **Clasificación en PIPING**: los tanques y equipos con volumen se clasifican con los cuadros 1 a 4. Son las funciones de la app de José, verificadas punto a punto.
  - PS: la indicada o, si no se indica, la mayor entre la presión sobre la lámina y la calculada.
  - Se muestra en el panel, el tooltip, los resultados y el informe (apartado 5.1 o 5.2), con un enlace que abre la app ya rellenada.
- **Cuadro 9**: se añade la excepción de TS > 350 °C (categoría II → III).
- **Incongruencia en la app de José**: sus cuadros 6 a 9 (tuberías) no coinciden con el art. 4.1.c:
  - omiten la categoría I en los cuadros 6 y 7 y la categoría II en el 7;
  - en los cuadros 8 y 9 clasifican como categoría I la zona que es del art. 4.3.
  - PIPING mantiene su propia versión, coherente con el artículo.
  - Pendiente de que José decida si corrige su app.
