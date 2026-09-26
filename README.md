# Integración del catálogo de datos en la app (2026-09-25)

Este documento sustituye varias partes de `motor-calculo-hidraulico.md`: las tablas fijas `TABLA_DN_SCH40`, `RUGOSIDAD_MATERIAL` y `FLUIDOS`, el modelo de la Te y los fluidos Agua 20 °C / Aceite Térmico / Vapor.

## Ficheros en C:\Users\jaman\Documents\PROYECTOS\PIPING
- `index.html`: la app.
- Copia de seguridad previa: `index_antes_datos_202609252330.html`.
- `catalogo.js`: define `window.CATALOGO` y se carga con `<script src="catalogo.js">`. Pesa unos 54 KB y debe estar junto a `index.html`.
  - Se genera desde los scripts de datos de la revisión de PIPING.docx.
  - Su estructura es la que tendrán las tablas de Supabase. Para conectar Supabase solo habrá que cambiar el origen de `CATALOGO`.

## Contenido de CATALOGO
- `fluidos`: 9 tablas con columnas [T, ρ, ν (mm²/s), pv (kPa)].
  - La gasolina aparece dos veces: verano (RVP 60) e invierno (RVP 90).
- `materiales`: 12 materiales con norma, rugosidad ε, series, serieDef y tamaños ({clave, nps, od, e: {serie: espesor}}).
  - Con tabla propia: acero al carbono B36.10M, inoxidable B36.19M, PVC-U, PE100, PE80, CPVC, PP-R, PVDF y PP-H.
  - Heredados (Cobre, Fundición, Hormigón): no tienen tabla y usan el Dint de acero Sch 40 como referencia.
- `crane`: opciones por subtipo con su múltiplo de f_T.
  - Casos especiales: 'mariposa', 'basc5' y 'basc15' dependen del DN.
- `vmin`: coeficiente C de la velocidad mínima de apertura de las retenciones.
- `valvulas`: 47 series, cada una con {nombre, tipo, fuente, nota, cv: {pulgadas: Cv}}.
- `reducciones`: B16.9 indexadas por 'DN1-DN2', con {H, θ}.
- `ft`, `inchDN`.

## Decisiones de implementación
- **Fluido y temperatura:** en el panel izquierdo, con información de ρ, ν y pv.
  - Interpolación lineal para ρ y logarítmica para ν y pv.
  - Fuera de rango, el cálculo no se ejecuta.
  - Se guardan `fluido` y `temperatura` en el .pid, que pasa a la versión "6.6-catalogo".
- **Tuberías:** cascada material → serie → tamaño. Dint = OD − 2e según la tabla.
  - Los plásticos usan la clave 'd63'; el acero, 'DN 50'.
  - `el.serie` es la serie (p. ej. '40' o 'SDR 11 (PN16)'). El campo `espesor` se elimina.
- **Válvulas y accesorios:** `modoK` puede ser 'crane', 'catalogo' (solo válvulas) o 'manual'.
  - En el cálculo se toma el Dint de la tubería conectada; si no hay ninguna, el Dint de referencia Sch 40 del DN.
  - En modo catálogo: K = 891·(D/25,4)⁴/Cv².
  - En modo Crane: K = n·f_T(DN).
- **Te:** tres aristas desde un nodo central interno.
  - Las ramas a y b llevan K_run/2 cada una; la rama c lleva K_der − K_run/2.
  - En modo Crane, K_run = 20 f_T y K_der = 60 f_T. En modo manual se editan `kRun` y `kBranch`.
- **Nuevos símbolos:**
  - Reducción (subtype 'reduccion'): `dn` = extremo mayor (puerto a), `dnMenor` = extremo menor (puerto b), `excentrica`, y θ de B16.9 o manual (`thetaManual`, `theta`). K se refiere al diámetro menor; es de contracción si el caudal va de a→b y de expansión en sentido contrario.
  - Válvula de tajadera (subtype 'tajadera').
  - Tubería PE100 d63 en la librería.
- **Avisos en resultados:**
  - Retención con V < v_min = C·√(1/ρ).
  - Re entre 2300 y 4000.
  - Serie de catálogo sin el DN pedido: se aplica el K de Crane.
  - El resultado muestra además la columna "Origen de K".
- **Migración de .pid antiguos:**
  - Materiales antiguos → nombres nuevos. Un PVC con DN de acero pasa a su d equivalente.
  - K igual al valor por defecto de la librería antigua → modo 'crane'. K modificado por el usuario → 'manual'.
  - Te antigua → 'crane'.
  - 'Agua (20°C)' → Agua a 20 °C. 'Aceite Térmico' → ISO VG 46 a 40 °C, con aviso. 'Vapor Saturado' → Agua, con aviso.
- **Edición:** el panel lateral y el modal comparten `camposEspecificos(obj, fn)`. El modal trabaja sobre un borrador y "Guardar" lo confirma. Los números no válidos se ignoran, así que no se producen NaN.

## Verificación con Playwright
- Red de prueba: bomba, reducción 80×50, globo, te y retención con tramo de PE.
  - Balance de masa: error de 6·10⁻⁷ m³/s. Energía por arista: 1,5·10⁻⁶ m.
  - K contrastados a mano: globo 6,46; reducción 0,069 (θ 18,3°); bola DN100 0,051; codo LR DN250 0,196; mariposa DN150 con Cv 1579 → 0,484. La retención conectada a PE d63 toma Dint 51,4.
- Se abren sin error los proyectos antiguos `proyecto_pid.pid` y `123456.pid`.
- Guardar y volver a abrir un .pid conserva fluido, temperatura, material, serie y tamaño.

## Pendiente
- Curvas de bombas (José las enviará).
- Clave de Supabase.
- Límites conocidos:
  - Los símbolos de codo se dibujan a 90° aunque se elija un tipo de 45° o de 180°.
  - Las etiquetas de componentes vecinos pueden solaparse.
