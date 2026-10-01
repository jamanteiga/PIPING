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
