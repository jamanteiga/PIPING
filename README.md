# PIPING v8.25 · Vista isométrica, preselección de bombas, conexiones y compatibilidad material–fluido

Fecha: 2026-10-10 · Copia de la 8.24 en `copias\v824\`.

## 1. Barra del lienzo: Normal / Isométrico / Calcular
- «Calcular» sale del panel «Símbolos P&ID» y pasa a la barra de Deshacer/Rehacer: `Deshacer · Rehacer | Normal · Isométrico · Calcular`.
- **Isométrico** (también Vista > Vista isométrica) dibuja en la misma hoja, sin crear otra, toda la red en 3D a partir de longitud y cotas a/b de cada tubería: planta = dirección del esquema (+X este, +Y norte), vertical +Z por las cotas. Componentes como símbolo en su nudo, longitudes, tags, cotas EL en cambios de nivel, ejes +X/+Y/+Z. Respeta el rojo de los fallos. Es de consulta: clic selecciona (panel), doble clic abre la ventana. Arrastrar un símbolo de la librería vuelve a «Normal».
- Funciones: `ponerVista`, `geometriaIsoRed` (BFS por los nudos del grafo; tramos de cierre de anillo en discontinua), `dibujarVistaIso`. Herramientas > Isométrico de línea (hoja nueva + DXF) se mantiene.

## 2. Preselección de bombas
- Herramientas > Preseleccionar bomba (base de datos)... y botón en Dimensionar bomba.
- Punto: el de Dimensionar bomba (H necesaria + 10 %, NPSHd) o, sin red, caudal de diseño y presión de diseño pasada a m. Editable.
- Evalúa todas las bombas (Supabase + usuario) con ecuaciones, puntos o parábola del punto de diseño: H(Q)/Hnec 100–125 % (aviso hasta 150 %, más = sobredimensionada), % BEP 70–120 % (fuera de 50–130 % no cumple), NPSHr + margen ≤ NPSHd, Q ≥ Qmin, P eje ≤ motor, cuerpo ≥ presión de diseño. Muestra velocidad en las bocas y DN mínimo de tubería por velocidad.
- «Validar y asignar» pasa por el diálogo de validación (queda registrado). «Buscar en internet» y «Nueva bomba en la librería con este punto» (luego ficha PDF con IA y guardar en la BD).

## 3. Conexiones de la bomba (aspiración e impulsión)
- Por lado: tipo (Bridada, Roscada, BW, SW, Clamp sanitario, Ranurada, Racor), tamaño, norma de brida o rosca (ASME B16.5/B16.47, EN 1092-1/-2, JIS B2220, NPT, BSPT, BSPP, métrica, DIN 11851, ISO 2852, ASME BPE) y PN/rating. En librería, panel y ventana de inserción.
- BD: columna `connections jsonb` en `piping_pumps` (08_bombas.sql). Se mantienen flange_standard/pressure_rating (derivados). Fichas antiguas se migran solas.
- IA (Edge Function): nuevos campos opcionales conexion_aspiracion, conexion_impulsion, norma_conexion.
- Cálculo: PN/rating de cada conexión frente a la presión de ese lado y a la de diseño (rojo). Avisos: roscada con norma de brida (y al revés), roscada o SW > DN 50, BSPP sin junta.

## 4. Compatibilidad material – fluido
- Tabla orientativa 18 familias × 8 clases de fluido (A apto / B con condiciones T y V / X no apto) con notas y normas (NACE SP0294, SP0403, EI 1540, ASME B31.3 §323.4.2, ISO/TR 10358). Tmax de plásticos.
- En el cálculo: X o B fuera de límites → rojo con motivo; B dentro → aviso agrupado. Herramientas > Compatibilidad material – fluido... muestra la tabla y los materiales de la hoja.
- Incongruencia comentada: el acero al carbono **sí** se usa con H2SO4 93–99 % (T ≤ 40 °C, V ≤ 0,9 m/s); no es apto con ácido diluido. Se ha codificado como B con esos límites.

## Pendiente de José
- Ejecutar de nuevo `08_bombas.sql` en Supabase (columna connections).
- Volver a pegar `supabase/functions/piping-bomba-pdf/index.ts` en la Edge Function y Deploy (campos de conexión).
- Revisar la tabla de compatibilidad con sus especificaciones de materiales.

## Archivos entregados (md5)
index.html 78dad765… · js/piping.js 45b32465… · js/partes admin a174db0e, cad 7d38701c, herr 8124ddcd, informe 5aba7024 · css/piping.css 9b540411… · i18n en c76ba13c, pt 98a2cc03, ko 77101be1 · supabase/08_bombas.sql d98722d3 · functions/piping-bomba-pdf/index.ts 1b0dd3af.

## Pruebas
test10–23 sin cambios salvo campos nuevos y el número de órdenes de la paleta; t_crane, t_bom, t_af, t_rojo, t_ts, t_ec, t_tee4 correctas; t_bomdb825 (PostgreSQL local, columna connections) correcto; t_825 nuevo (vista iso, compatibilidad H2SO4/NaOH/agua de mar, conexiones, BD, preselección y asignación) sin errores, también con carga diferida.
