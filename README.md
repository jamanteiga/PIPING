# PIPING v8.5-acceso (01/10/2026) — modo invitado / administrador y correcciones de materiales

Ficheros cambiados: `index.html`, `js/piping.js`, `i18n/en.js`, `pt.js`, `ko.js`. Copia de la 8.4.1 en `copias/v841/`.

## Acceso

- **Sin acreditación: invitado.**
  - Se ve y se prueba toda la interfaz: dibujar, calcular, ver resultados y abrir proyectos .pid.
  - No se guarda ni se exporta nada: Guardar y Guardar como (pid, dxf, json, xml, svg, png, PDF con capas), informe .docx, listados .xlsx, imprimir, nube, librería, plantillas, capas predeterminadas, plantillas Excel, registrar revisión.
  - Tampoco quedan copias en el navegador: último proyecto y copias de seguridad.
  - Al cerrar la pestaña no sale el aviso de cambios sin guardar.
- **Administrador:** menú **Administración**, al final, después de Ayuda > Iniciar sesión (administrador), con el usuario `admin`. La contraseña la tiene José y no se escribe en el código ni en esta documentación.
  - La sesión dura lo que la pestaña; con la casilla «Recordar en este equipo» se mantiene en ese navegador.
  - Administración > Cambiar contraseña… cambia la contraseña solo en ese navegador.
  - Administración > Cerrar sesión.
- **Indicador:** en la barra superior, «Invitado (solo consulta)» o «Administrador». Clic en el de invitado: abre el inicio de sesión.
- **Implementación:**
  - En el código solo está el resumen SHA-256 con sal, de 20 000 iteraciones.
  - La comprobación central es `puedeGuardar()`.
  - El testigo de sesión se guarda en sessionStorage o en localStorage.

### Limitación (importante)

Es una protección en el navegador de una web estática. El código está publicado en GitHub, y con las herramientas del navegador se puede saltar. También se puede intentar adivinar la contraseña por fuerza bruta a partir del resumen. Sirve para impedir el uso normal sin acreditación, pero no es seguridad real.

Para protección real hace falta Supabase Auth: el guardado iría a la nube con RLS, que ya está preparado en `04_proyectos_usuarios.sql`. Además, el repositorio tendría que ser privado o el código tendría que estar detrás de un servidor con autenticación.

## Materiales (incongruencias confirmadas por José y tablas nuevas)

- SA-181 → Cl.60 / Cl.70.
- CF8M → GX5CrNiMo19-11-2 / 1.4408.
- **Grados a baja temperatura:**
  - P275NL1 / 1.0488 y P355NL1 / 1.0566.
  - P275NL2 / 1.1104 y P355NL2 / 1.1106, con ensayo de impacto.
- SA-105N, EN 1092-1: P250GH / 1.0460 y P265GH / 1.0425 (normalizado).
- SA-234 Gr.WPC: se sustituye P355GH, que es acero de chapa (EN 10028-2), por **P355NH / 1.0565 (EN 10253-2)**. Es una propuesta: hay que confirmarla con la norma.
- Tes, cruces y reducciones (de acero al carbono y de inoxidable) tienen las mismas equivalencias que los codos. Las tablas pasan a llamarse «codos, tes, cruces y reducciones». Las listas de material de Accesorios (codos, tes, cruces, reducciones) incluyen todos los grados.
- Los proyectos antiguos convierten solas las denominaciones (p. ej. `SA-181 Gr.II` → `SA-181 Cl.70`).

## Pruebas

- Regresión test10 a test23 correcta: las pruebas inician la sesión de administrador.
- `t_acceso.js` comprueba:
  - El invitado no descarga ni guarda en el navegador.
  - Una contraseña errónea es rechazada.
  - Con la contraseña correcta se pasa a administrador.
  - Tras recargar, la sesión se mantiene.
  - Administración aparece después de Ayuda.
# PIPING v8.6-usuarios (01/10/2026) — usuarios y roles en Supabase

Ficheros: `index.html`, `js/piping.js`, `css/piping.css`, `i18n/*.js` y **`supabase/05_usuarios.sql` (nuevo)**. Copia de la 8.5.1 en `copias/v851/`.

## Puesta en marcha

1. Supabase > SQL Editor: ejecutar `supabase/05_usuarios.sql`.
2. En PIPING: Archivo > Administración > Iniciar sesión con `admin` y la contraseña de la aplicación. Con la tabla vacía se crea solo el administrador en Supabase (`piping_inicializar`).
   - Hay que hacerlo enseguida tras ejecutar el SQL: mientras la tabla esté vacía, cualquiera podría crear el primer administrador.
3. Archivo > Administración > Usuarios: dar de alta al resto.

## Usuarios (Archivo > Administración > Usuarios, solo administrador)

- **Alta:** nombre, apellidos, usuario (3–40 caracteres: minúsculas, números, `.` `-` `_`), contraseña por defecto (≥ 8; se propone una aleatoria) y rol.
- **Tabla editable:**
  - Columnas: nombre, apellidos, rol, activo, estado de la contraseña (pendiente / propia) y último acceso.
  - Botones por fila: Guardar, Resetear contraseña (pone otra por defecto) y Eliminar.
- **Contraseña por defecto:** al entrar con ella se pide cambiarla. Cada uno la cambia en Archivo > Administración > Cambiar mi contraseña.
- **Reglas en el servidor:**
  - Siempre queda al menos un administrador activo.
  - Nadie puede borrarse a sí mismo.
  - 5 intentos fallidos bloquean el usuario 15 min.
  - Desactivar a un usuario cierra sus sesiones.

## Roles y permisos

| Permiso | Admin | Supervisor | Jefe de proyecto | Usuario |
|---|---|---|---|---|
| Guardar, exportar, imprimir, informes, nube | ✓ | ✓ | ✓ | ✓ |
| Registrar revisión (emitir) | ✓ | ✓ | ✓ | — |
| Congelar plano | ✓ | ✓ | ✓ | — |
| Descongelar plano | ✓ | ✓ | — | — |
| Librería, capas predeterminadas, librería del equipo | ✓ | ✓ | — | — |
| Resolver / reabrir comentarios de revisión | ✓ | ✓ | — | — |
| Usuarios | ✓ | — | — | — |

Sin sesión: invitado (solo consulta). En la barra superior aparecen el nombre y el rol: verde para administrador, azul para los demás roles y ámbar para invitado. Los comentarios de revisión llevan como autor el usuario de la sesión.

## Técnica

- **Tablas** `piping_usuarios` y `piping_sesiones`:
  - Seguridad por filas activada sin políticas: ni la clave anon ni los usuarios las leen directamente.
  - Contraseñas con bcrypt (pgcrypto, coste 10).
  - Testigo de sesión aleatorio de 256 bits; dura 12 h, o 30 días con «Recordar en este equipo».
- **Funciones** (SECURITY DEFINER, con la clave anon): `piping_login`, `piping_logout`, `piping_cambiar_clave`, `piping_usuarios_listar`, `piping_usuario_crear`, `piping_usuario_actualizar`, `piping_usuario_resetear`, `piping_usuario_borrar`, `piping_usuarios_vacio` y `piping_inicializar`. Las que gestionan usuarios comprueban en el servidor que el testigo es de un administrador.
- **Sin conexión con Supabase,** o sin el SQL ejecutado, solo entra el administrador local, con la contraseña de la aplicación.
- **Clave anon:** el formulario de inicio de sesión pide la clave anon de Supabase si ese equipo no la tiene. Pendiente: que José facilite la clave anon (es pública) para incluirla en el código y que no haya que escribirla en cada equipo.
- **Límite:** la gestión de usuarios y las contraseñas están protegidas en el servidor. En cambio, el bloqueo de guardar o exportar según el rol se comprueba en el navegador (código público) y se podría saltar con sus herramientas.

## Pruebas

- **`t_usuarios.js`:** el cliente contra el SQL real en PostgreSQL 16. Comprueba:
  - Creación del primer administrador.
  - Alta de jefe, usuario y supervisor.
  - Cambio de rol y desactivación.
  - Cambio obligatorio de la contraseña por defecto.
  - Permisos del jefe: no descongela ni ve Usuarios.
  - Acceso denegado al usuario desactivado.
  - Reseteo de contraseña por el administrador.
  - Un no administrador no puede listar usuarios (rechazo en el servidor).
- **Regresión test10 a test23:** correcta.
# PIPING 8.7.1 «accesorios» (2026-10-02)

Entrega en `C:\Users\jaman\Documents\PROYECTOS\PIPING\` · copia de la 8.7 en `copias\v87\`.
Prueba de la nueva librería solo con **accesorios de tubería**; si convence, se extiende al resto de grupos.

## Librerías > Accesorios > Accesorios de tubería...
- **Tipos:** Codo 45°, Codo 60°, Codo 90°, Cruce, Filtro, Injerto, Reducción, Strainer (rejilla), Te.
  Salen de este grupo: Continuación entre hojas (no es accesorio; sin librería), Junta de expansión y Manguito antivibratorio (pasan a Librerías > Accesorios > Juntas de expansión y manguitos..., grupo `compensadores`).
- **Administrador:** arriba, tabla con **todos** los accesorios y todos sus datos (Tipo, Nombre/modelo, Fabricante, Referencia, Material, Norma, PN/clase, Tipo Crane, Serie/Sch, K, Notas, En el proyecto, URL), con filtro por tipo y buscador. Debajo, la ficha del marcado.
  - Nuevo · Nuevo a partir del marcado (copia todos los datos; se puede cambiar el tipo en «Tipo de accesorio») · Eliminar · Guardar (edita el marcado).
- **Resto de roles:** ventana anterior (desplegable de tipo + lista), con los tipos nuevos.
- **Reducción:** campo «Reducción: concéntrica o excéntrica» (`props.variante`). En el plano, «Modelo de librería» de una reducción solo ofrece los de su variante (o sin variante).
- **Materiales** (`MATERIALES.accesorio`): exactamente los de Ayuda > Equivalencia ASME / Norma europea para codos, tes, cruces y reducciones (SA-234 WPB/WPC, SA-420 WPL6, SA-403 WP304…WP347H y sus EN 10253-2 / -3 / -4). Se retiran SA-105 y SA-182 F316L (B16.11), P235TR2 (EN 10253-1) y EN-GJS-400-15; los componentes que ya los tuvieran los conservan como «Otro».
  - Filtro y Strainer (`MATERIALES.filtro`): además fundición de la misma ayuda (SA-216 Gr.WCB, SA-351 Gr.CF8/CF8M; GP240GH, 1.4308, 1.4408).
  - Bajo el desplegable de material se muestra el equivalente ASME ↔ EN (`equivalenteMaterial`).

## Ayuda
- El menú y el título pasan a «Equivalencia ASME / Norma europea» (ASME en mayúsculas por ser sigla).

## Código
- `GRUPOS_LIB.accesorios.excluir`, `GRUPOS_LIB.compensadores`, `libTodos()`, `itemsGrupoLib()`, `pintarTablaLibTodos()`, `equivalenteMaterial()`; `libVista.filtroTipo/q`.
- Versión `8.7.1-accesorios`, `VERSION_WEB = '8.7.1'`, `?v=8.7.1`. Las partes `js/partes/*.js` no cambian.

## Pruebas
- `t_lib.js`: administrador (alta, copia a reducción excéntrica, edición, búsqueda, borrado, materiales de filtro, equivalencias) y supervisor (ventana anterior). Regresión test10–test23: solo cambia el menú de Librerías.

## Pendiente
- La librería sigue guardándose en el navegador de cada equipo (y en la nube con «Compartir mi librería»); no es todavía una librería central de empresa.
- Extender la tabla completa al resto de grupos si la prueba convence.
- Clave anon de Supabase (8.7, punto 1) y confirmación de materiales de bombas (8.6.1).
# PIPING 8.7.1 «accesorios» (2026-10-02)

Entrega en `C:\Users\jaman\Documents\PROYECTOS\PIPING\` · copia de la 8.7 en `copias\v87\`.
Prueba de la nueva librería solo con **accesorios de tubería**; si convence, se extiende al resto de grupos.

## Librerías > Accesorios > Accesorios de tubería...
- **Tipos:** Codo 45°, Codo 60°, Codo 90°, Cruce, Filtro, Injerto, Reducción, Strainer (rejilla), Te.
  Salen de este grupo: Continuación entre hojas (no es accesorio; sin librería), Junta de expansión y Manguito antivibratorio (pasan a Librerías > Accesorios > Juntas de expansión y manguitos..., grupo `compensadores`).
- **Administrador:** arriba, tabla con **todos** los accesorios y todos sus datos (Tipo, Nombre/modelo, Fabricante, Referencia, Material, Norma, PN/clase, Tipo Crane, Serie/Sch, K, Notas, En el proyecto, URL), con filtro por tipo y buscador. Debajo, la ficha del marcado.
  - Nuevo · Nuevo a partir del marcado (copia todos los datos; se puede cambiar el tipo en «Tipo de accesorio») · Eliminar · Guardar (edita el marcado).
- **Resto de roles:** ventana anterior (desplegable de tipo + lista), con los tipos nuevos.
- **Reducción:** campo «Reducción: concéntrica o excéntrica» (`props.variante`). En el plano, «Modelo de librería» de una reducción solo ofrece los de su variante (o sin variante).
- **Materiales** (`MATERIALES.accesorio`): exactamente los de Ayuda > Equivalencia ASME / Norma europea para codos, tes, cruces y reducciones (SA-234 WPB/WPC, SA-420 WPL6, SA-403 WP304…WP347H y sus EN 10253-2 / -3 / -4). Se retiran SA-105 y SA-182 F316L (B16.11), P235TR2 (EN 10253-1) y EN-GJS-400-15; los componentes que ya los tuvieran los conservan como «Otro».
  - Filtro y Strainer (`MATERIALES.filtro`): además fundición de la misma ayuda (SA-216 Gr.WCB, SA-351 Gr.CF8/CF8M; GP240GH, 1.4308, 1.4408).
  - Bajo el desplegable de material se muestra el equivalente ASME ↔ EN (`equivalenteMaterial`).

## Ayuda
- El menú y el título pasan a «Equivalencia ASME / Norma europea» (ASME en mayúsculas por ser sigla).

## Código
- `GRUPOS_LIB.accesorios.excluir`, `GRUPOS_LIB.compensadores`, `libTodos()`, `itemsGrupoLib()`, `pintarTablaLibTodos()`, `equivalenteMaterial()`; `libVista.filtroTipo/q`.
- Versión `8.7.1-accesorios`, `VERSION_WEB = '8.7.1'`, `?v=8.7.1`. Las partes `js/partes/*.js` no cambian.

## Pruebas
- `t_lib.js`: administrador (alta, copia a reducción excéntrica, edición, búsqueda, borrado, materiales de filtro, equivalencias) y supervisor (ventana anterior). Regresión test10–test23: solo cambia el menú de Librerías.

## Pendiente
- La librería sigue guardándose en el navegador de cada equipo (y en la nube con «Compartir mi librería»); no es todavía una librería central de empresa.
- Extender la tabla completa al resto de grupos si la prueba convence.
- Clave anon de Supabase (8.7, punto 1) y confirmación de materiales de bombas (8.6.1).
# PIPING 8.10 «tablas» (2026-10-02) — accesorios en tablas separadas y código compuesto en el plano

Entrega en `C:\Users\jaman\Documents\PROYECTOS\PIPING\` · copia de la 8.9 en `copias\v89\`.
Sustituye al catálogo de 9 748 filas de la 8.9 (decisión de José: demasiadas referencias para un P&ID).

## Idea
El accesorio concreto (este codo, 2", Sch 40, WPB) no se guarda en ninguna tabla: se compone al insertarlo, eligiendo modelo, medida nominal, schedule, material y rating en su mismo cuadro. Con eso se forma su código.

**Código:** `TIPO-MEDIDA-SCHEDULE-MATERIAL(-RATING)`, medida en pulgadas en ASME y en DN en EN.
- `C90LR-2"-S40-WPB` · `C90LR-4"-S40S-WP316L-150#` · `RE-3"x2"-STD-WPB` · `C90-3D-DN100-E4.5-P235GH` · `C90SW-1"-S80-A105N-3000#`
- En EN el espesor va como `E4.5` (mm).
- Etiqueta en pantalla: el código con el número y la línea intercalados, `C90LR01-P01-2"-S40-WPB`.
- El mismo código sale en el listado de componentes y en la ficha del elemento.

## Tablas (Supabase `piping_acc_*`, y copia local `datos/accesorios_tablas.js`)
| Tabla | Filas | Contenido |
|---|---|---|
| `piping_acc_modelos` | 32 | Tipos de accesorio: código del tipo, símbolo, variante, norma, conexión, sistema de medidas, tipo Crane, grupo de materiales, tabla de espesores, K de fabricante |
| `piping_acc_medidas` | 68 | NPS / DN y diámetro exterior, ASME y EN |
| `piping_acc_espesores` | 562 | Espesor por medida y schedule: B36.10 (carbono), B36.19 (inoxidable), EN 10253-1 (único), EN 10253-2 (series 1 a 8) |
| `piping_acc_materiales` | 28 | Código corto (WPB, WP316L, A105N, P235GH…), designación, familia, grupo, equivalencia ASME ↔ EN |
| `piping_acc_ratings` | 17 | 150# a 2500#, forjados 2000# a 9000#, PN 6 a PN 100 |
| `piping_acc_cotas` | 1 246 | Cotas de norma por modelo y medida (consulta) |

Modelos de partida: B16.9 (C45LR, C90LR, C90SR, TE, RC, RE), B16.11 (C45/C90/TE/CR en SW y roscado), EN 10253-1 (C45-3D/5D, C90-2D/3D/5D, TE, RC, RC-F1, RE), EN 10253-2 (C45 y C90 en 2D/3D/5D, TE, RC, RE).
Fuera: codo reductor y te reductora como modelos propios (el símbolo solo tiene un tamaño; la te vale para recta y reductora).

## Supabase
`supabase/07_accesorios.sql` (después de 05 y 06): crea las seis tablas con sus datos (no hay CSV que importar), elimina `piping_accesorios` de las 8.8 / 8.9 y define:
- `piping_acc_tablas()` — todas las tablas en una llamada (lectura con clave anon).
- `piping_acc_modelo_guardar(token, item)`, `piping_acc_modelo_borrar(token, id)`, `piping_acc_modelos_recuperar(token)` — solo administrador; anotadas en el registro de actividad.
- Medidas, espesores, materiales, ratings y cotas se editan en el Table Editor; la app las relee al abrirse.

## Aplicación
- **Al insertar** un codo, te, cruce o reducción (ventana de inserción) y en **propiedades**: Modelo, Material (solo los del grupo del modelo), Schedule / espesor (solo los que existen para esa medida y familia), Medida nominal, Rating / PN. Debajo, el código, OD, espesor, cota de norma y equivalencia del material.
- Al elegir modelo: fija el tipo Crane (LR 14 fT, SR 20 fT…), la variante de la reducción, y propone material y schedule a partir de la tubería conectada.
- Si se cambia medida o material y el schedule deja de existir, se vacía.
- Sin modelo elegido, el accesorio se comporta como antes (etiqueta `C9001-P01-2`).
- **Librerías > Accesorios > Accesorios de tubería...:** pestañas Accesorios (los 32 modelos; Nuevo, Nuevo a partir del marcado, Eliminar, Guardar), Medidas nominales, Espesores / schedule, Materiales, Rating / PN y Cotas (consulta).
- Campos del elemento: `accModelo`, `accSch`, `materialComp`, `dn`, `dnMenor`, `pn`. Funciones: `modeloAcc`, `schedulesAcc`, `materialesAcc`, `ratingsAcc`, `espesorAcc`, `cotasAcc`, `codigoAccesorio`, `partesCodigoAcc`, `aplicarModeloAcc`, `ajustarScheduleAcc`, `camposAccesorio`.
- `PN_LISTA` añade 1500#, 2500#, 2000#, 3000#, 6000#, 9000#.
- Versión `8.10-tablas`. Generador: `gen_tablas.py` (a partir de `gen_catalogo.py`). Revisión: `accesorios_tablas.xlsx`.

## Pruebas
- SQL 07 en PostgreSQL local (dos ejecuciones seguidas, borrado de la tabla antigua).
- `t_tab.js`: librería y pestañas; composición del código en ASME carbono, ASME inoxidable, EN y forjados; reducción y te; panel, etiqueta, listado; ventana de inserción; administrador de Supabase (crear a partir de uno, eliminar) e invitado que ve los cambios.
- Regresión test10–test23: solo cambia el número de opciones de PN.

## Pendiente
- Clase de tubería por línea (propuesta, no hecha): fijaría norma, schedule, material y rating una vez por línea.
- Edición de materiales, espesores y medidas desde la aplicación (hoy, solo en Supabase).
- Incongruencias de la Excel de tubos: ver `claude/version-8.9-catalogo-accesorios.md`.

# PIPING 8.10 «tablas» (2026-10-02) — accesorios en tablas separadas y código compuesto en el plano

Entrega en `C:\Users\jaman\Documents\PROYECTOS\PIPING\` · copia de la 8.9 en `copias\v89\`.
Sustituye al catálogo de 9 748 filas de la 8.9 (decisión de José: demasiadas referencias para un P&ID).

## Idea
El accesorio concreto (este codo, 2", Sch 40, WPB) no se guarda en ninguna tabla: se compone al insertarlo, eligiendo modelo, medida nominal, schedule, material y rating en su mismo cuadro. Con eso se forma su código.

**Código:** `TIPO-MEDIDA-SCHEDULE-MATERIAL(-RATING)`, medida en pulgadas en ASME y en DN en EN.
- `C90LR-2"-S40-WPB` · `C90LR-4"-S40S-WP316L-150#` · `RE-3"x2"-STD-WPB` · `C90-3D-DN100-E4.5-P235GH` · `C90SW-1"-S80-A105N-3000#`
- En EN el espesor va como `E4.5` (mm).
- Etiqueta en pantalla: el código con el número y la línea intercalados, `C90LR01-P01-2"-S40-WPB`.
- El mismo código sale en el listado de componentes y en la ficha del elemento.

## Tablas (Supabase `piping_acc_*`, y copia local `datos/accesorios_tablas.js`)
| Tabla | Filas | Contenido |
|---|---|---|
| `piping_acc_modelos` | 32 | Tipos de accesorio: código del tipo, símbolo, variante, norma, conexión, sistema de medidas, tipo Crane, grupo de materiales, tabla de espesores, K de fabricante |
| `piping_acc_medidas` | 68 | NPS / DN y diámetro exterior, ASME y EN |
| `piping_acc_espesores` | 562 | Espesor por medida y schedule: B36.10 (carbono), B36.19 (inoxidable), EN 10253-1 (único), EN 10253-2 (series 1 a 8) |
| `piping_acc_materiales` | 28 | Código corto (WPB, WP316L, A105N, P235GH…), designación, familia, grupo, equivalencia ASME ↔ EN |
| `piping_acc_ratings` | 17 | 150# a 2500#, forjados 2000# a 9000#, PN 6 a PN 100 |
| `piping_acc_cotas` | 1 246 | Cotas de norma por modelo y medida (consulta) |

Modelos de partida: B16.9 (C45LR, C90LR, C90SR, TE, RC, RE), B16.11 (C45/C90/TE/CR en SW y roscado), EN 10253-1 (C45-3D/5D, C90-2D/3D/5D, TE, RC, RC-F1, RE), EN 10253-2 (C45 y C90 en 2D/3D/5D, TE, RC, RE).
Fuera: codo reductor y te reductora como modelos propios (el símbolo solo tiene un tamaño; la te vale para recta y reductora).

## Supabase
`supabase/07_accesorios.sql` (después de 05 y 06): crea las seis tablas con sus datos (no hay CSV que importar), elimina `piping_accesorios` de las 8.8 / 8.9 y define:
- `piping_acc_tablas()` — todas las tablas en una llamada (lectura con clave anon).
- `piping_acc_modelo_guardar(token, item)`, `piping_acc_modelo_borrar(token, id)`, `piping_acc_modelos_recuperar(token)` — solo administrador; anotadas en el registro de actividad.
- Medidas, espesores, materiales, ratings y cotas se editan en el Table Editor; la app las relee al abrirse.

## Aplicación
- **Al insertar** un codo, te, cruce o reducción (ventana de inserción) y en **propiedades**: Modelo, Material (solo los del grupo del modelo), Schedule / espesor (solo los que existen para esa medida y familia), Medida nominal, Rating / PN. Debajo, el código, OD, espesor, cota de norma y equivalencia del material.
- Al elegir modelo: fija el tipo Crane (LR 14 fT, SR 20 fT…), la variante de la reducción, y propone material y schedule a partir de la tubería conectada.
- Si se cambia medida o material y el schedule deja de existir, se vacía.
- Sin modelo elegido, el accesorio se comporta como antes (etiqueta `C9001-P01-2`).
- **Librerías > Accesorios > Accesorios de tubería...:** pestañas Accesorios (los 32 modelos; Nuevo, Nuevo a partir del marcado, Eliminar, Guardar), Medidas nominales, Espesores / schedule, Materiales, Rating / PN y Cotas (consulta).
- Campos del elemento: `accModelo`, `accSch`, `materialComp`, `dn`, `dnMenor`, `pn`. Funciones: `modeloAcc`, `schedulesAcc`, `materialesAcc`, `ratingsAcc`, `espesorAcc`, `cotasAcc`, `codigoAccesorio`, `partesCodigoAcc`, `aplicarModeloAcc`, `ajustarScheduleAcc`, `camposAccesorio`.
- `PN_LISTA` añade 1500#, 2500#, 2000#, 3000#, 6000#, 9000#.
- Versión `8.10-tablas`. Generador: `gen_tablas.py` (a partir de `gen_catalogo.py`). Revisión: `accesorios_tablas.xlsx`.

## Pruebas
- SQL 07 en PostgreSQL local (dos ejecuciones seguidas, borrado de la tabla antigua).
- `t_tab.js`: librería y pestañas; composición del código en ASME carbono, ASME inoxidable, EN y forjados; reducción y te; panel, etiqueta, listado; ventana de inserción; administrador de Supabase (crear a partir de uno, eliminar) e invitado que ve los cambios.
- Regresión test10–test23: solo cambia el número de opciones de PN.

## Pendiente
- Clase de tubería por línea (propuesta, no hecha): fijaría norma, schedule, material y rating una vez por línea.
- Edición de materiales, espesores y medidas desde la aplicación (hoy, solo en Supabase).
- Incongruencias de la Excel de tubos: ver `claude/version-8.9-catalogo-accesorios.md`.
# Versión 8.14 — Rating solo donde existe, socket weld, tes y reducciones EN inoxidables

Fecha: 2026-10-03. Versión anterior: 8.13.1 (copia en `copias\v8131\`). Hay que ejecutar `supabase\07_accesorios.sql`.

## Rating

José: «las tuberías, reducciones, tes, codos no tienen rating». Correcto para tubos y accesorios para soldar a tope; la excepción son los forjados ASME B16.11.

| Componente | Rating | En el código |
|---|---|---|
| Tubería | No (su presión la da el espesor) | `TAC-2"-S40-SA106B` |
| Accesorios para soldar a tope: ASME B16.9, EN 10253-1/-2/-3/-4 | No | `C90LR-2"-S40-WPB`, `RC-3"x2"-S40-WPB` |
| Forjados ASME B16.11 socket weld | Clase 3000, 6000, 9000 | `C90SW-1"-S80-SA105N-3000#` |
| Forjados ASME B16.11 roscados | Clase 2000, 3000, 6000 | |
| Bridas | Clase / PN | `WN-2"-S40-SA105N-300#-RF` |

- El campo Rating / PN desaparece del cuadro y de las propiedades de tuberías y accesorios para soldar a tope, y de la columna PN / clase del listado.
- La tubería guarda internamente el rating de la línea (heredado del componente anterior) solo para pasarlo a las válvulas y bridas que se conecten después; no se ve ni va en su código.
- En `piping_acc_modelos.ratings`: `NO` = sin rating; lista = clases admitidas; vacío = todas las de su sistema.
- Librerías > Accesorios: la pestaña «Rating / PN» pasa a «Clase (forjados)»; en Librerías > Tuberías > Acero ASME / EN desaparece.

## Socket weld

«Enchufe y soldadura (SW)» pasa a «Socket weld (SW)» en nombres de modelo y conexión (accesorios B16.11 y brida SW de B16.5). El SQL actualiza los modelos de catálogo que nadie haya editado.

## Reducciones y tes

- El desplegable Modelo de una reducción solo muestra los de su variante (concéntrica o excéntrica).
- Modelos nuevos EN inoxidable: `EN3-TE`, `EN3-RC`, `EN3-RE` (EN 10253-3, sin inspección específica) y `EN4-TE`, `EN4-RC`, `EN4-RE` (EN 10253-4, con inspección específica). Materiales (grupo `EN34`): 1.4301, 1.4306, 1.4401, 1.4404, 1.4541, 1.4550.
- **Pendiente:** espesores y cotas de EN 10253-3 / -4 (y EN ISO 1127); mientras tanto el código de estos accesorios no lleva espesor. Tampoco hay codos EN inoxidables.
- EN 10253-2: materiales P235GH / P265GH anotados como «tubo EN 10216-2 / chapa EN 10028-2».
- ASME: sin cambios (SA-234 WPB / WPC, SA-420 WPL6, SA-403 WP304…WP347H, ASME II).

## Dudas abiertas con José

- Escribió «EN 10288» como norma de material: se ha tomado como EN 10028 (chapa para aparatos a presión). EN 10288 es de recubrimientos de polietileno. Pendiente de confirmar.
- Código de diseño: para tubería el programa usa ASME B31.3 (PMA por espesor). ASME VIII Div. 1 es de recipientes; EN 13480-3 sería el equivalente europeo para tubería (espesor mínimo y tensiones admisibles EN). No implementado: pendiente de que José diga si quiere el cálculo de espesor por EN 13480-3 para las tuberías y accesorios EN.
- Siguen pendientes: normas de bridas (ASME B16.5, B16.47, EN 1092-1), EN ISO 1127 y la decisión sobre fórmulas empíricas de pérdida de carga.

## Ficheros entregados

`index.html`, `js/piping.js`, `i18n/*.js`, `datos/accesorios_tablas.js`, `supabase/07_accesorios.sql`, `accesorios_tablas.xlsx`.

## Pruebas

`t_14.js`, `t_tab.js` (base de datos), `t_tub.js`, `t_br.js`, `t_br3.js`, `t_esc.js`, `t_m.js` y regresión test10–test23 sin errores. Cambio esperado en la regresión: las tuberías ya no admiten rating propio.
# Versión 8.14 — Rating solo donde existe, socket weld, tes y reducciones EN inoxidables

Fecha: 2026-10-03. Versión anterior: 8.13.1 (copia en `copias\v8131\`). Hay que ejecutar `supabase\07_accesorios.sql`.

## 8.14.1 — Ficha oculta en las librerías de accesorios, bridas y tuberías de acero

Petición de José: al abrir la ventana (Librerías > Accesorios > Codos, Tes, Reducciones, Bridas; Librerías > Tuberías > Acero ASME / EN) solo se ve la tabla; la ficha de datos queda oculta.

- La ficha se despliega con **Nuevo**, **Nuevo a partir del marcado** o **Editar** (botón nuevo), o con doble clic en la fila.
- Un clic en una fila solo la marca (habilita Nuevo a partir del marcado, Editar y Eliminar).
- Tras **Guardar**, la ficha se vuelve a ocultar.
- Quien no puede modificar tiene el botón **Ver ficha**.
- Estado en `libVista.form`; funciones `seleccionarItemLib` (detecta el doble clic, porque la tabla se repinta en cada clic) y `editarItemLib`.
- Sin cambios de base de datos. Copia de la 8.14 en `copias\v814\`. Ficheros: `index.html`, `js/piping.js`, `i18n/*.js`.

## Rating

José: «las tuberías, reducciones, tes, codos no tienen rating». Correcto para tubos y accesorios para soldar a tope; la excepción son los forjados ASME B16.11.

| Componente | Rating | En el código |
|---|---|---|
| Tubería | No (su presión la da el espesor) | `TAC-2"-S40-SA106B` |
| Accesorios para soldar a tope: ASME B16.9, EN 10253-1/-2/-3/-4 | No | `C90LR-2"-S40-WPB`, `RC-3"x2"-S40-WPB` |
| Forjados ASME B16.11 socket weld | Clase 3000, 6000, 9000 | `C90SW-1"-S80-SA105N-3000#` |
| Forjados ASME B16.11 roscados | Clase 2000, 3000, 6000 | |
| Bridas | Clase / PN | `WN-2"-S40-SA105N-300#-RF` |

- El campo Rating / PN desaparece del cuadro y de las propiedades de tuberías y accesorios para soldar a tope, y de la columna PN / clase del listado.
- La tubería guarda internamente el rating de la línea (heredado del componente anterior) solo para pasarlo a las válvulas y bridas que se conecten después; no se ve ni va en su código.
- En `piping_acc_modelos.ratings`: `NO` = sin rating; lista = clases admitidas; vacío = todas las de su sistema.
- Librerías > Accesorios: la pestaña «Rating / PN» pasa a «Clase (forjados)»; en Librerías > Tuberías > Acero ASME / EN desaparece.

## Socket weld

«Enchufe y soldadura (SW)» pasa a «Socket weld (SW)» en nombres de modelo y conexión (accesorios B16.11 y brida SW de B16.5). El SQL actualiza los modelos de catálogo que nadie haya editado.

## Reducciones y tes

- El desplegable Modelo de una reducción solo muestra los de su variante (concéntrica o excéntrica).
- Modelos nuevos EN inoxidable: `EN3-TE`, `EN3-RC`, `EN3-RE` (EN 10253-3, sin inspección específica) y `EN4-TE`, `EN4-RC`, `EN4-RE` (EN 10253-4, con inspección específica). Materiales (grupo `EN34`): 1.4301, 1.4306, 1.4401, 1.4404, 1.4541, 1.4550.
- **Pendiente:** espesores y cotas de EN 10253-3 / -4 (y EN ISO 1127); mientras tanto el código de estos accesorios no lleva espesor. Tampoco hay codos EN inoxidables.
- EN 10253-2: materiales P235GH / P265GH anotados como «tubo EN 10216-2 / chapa EN 10028-2».
- ASME: sin cambios (SA-234 WPB / WPC, SA-420 WPL6, SA-403 WP304…WP347H, ASME II).

## Dudas abiertas con José

- Escribió «EN 10288» como norma de material: se ha tomado como EN 10028 (chapa para aparatos a presión). EN 10288 es de recubrimientos de polietileno. Pendiente de confirmar.
- Código de diseño: para tubería el programa usa ASME B31.3 (PMA por espesor). ASME VIII Div. 1 es de recipientes; EN 13480-3 sería el equivalente europeo para tubería (espesor mínimo y tensiones admisibles EN). No implementado: pendiente de que José diga si quiere el cálculo de espesor por EN 13480-3 para las tuberías y accesorios EN.
- Siguen pendientes: normas de bridas (ASME B16.5, B16.47, EN 1092-1), EN ISO 1127 y la decisión sobre fórmulas empíricas de pérdida de carga.

## Ficheros entregados (8.14)

`index.html`, `js/piping.js`, `i18n/*.js`, `datos/accesorios_tablas.js`, `supabase/07_accesorios.sql`, `accesorios_tablas.xlsx`.

## Pruebas

`t_14.js`, `t_f.js` (ficha oculta), `t_tab.js` (base de datos), `t_tub.js`, `t_br.js`, `t_br3.js`, `t_esc.js`, `t_m.js` y regresión test10–test23 sin errores. Cambio esperado en la regresión: las tuberías ya no admiten rating propio.
