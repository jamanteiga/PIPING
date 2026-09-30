# Versión 8.0-atajos-congelar

## Listado y cajetín
- Cajetín oculto (CAD > Cajetín > Mostrar cajetín): el listado de componentes ocupa su sitio (esquina inferior derecha del marco). Al volver a mostrarlo, el listado vuelve encima del cajetín. Automático (el punto de enganche depende de opciones.cajetin).

## Árbol de estructura
- Ramas "Formato" y "Anotaciones" plegadas por defecto (Anotaciones ahora es plegable y muestra el número).

## Leyenda de componentes
- Símbolos un 25 % mayores (8,75 mm), renglón de 9 mm.

## Hojas
- Alt+A añade una hoja (antes: mostrar accesorios en el panel, que queda solo en el menú Librerías).

## Congelar plano
- Botón derecho en el lienzo > Congelar plano / Descongelar plano. Con el plano congelado no se puede modificar nada (insertar, mover, girar, borrar, editar propiedades, correcciones, deshacer/rehacer): el bloqueo está en guardarEstado(), por el que pasa toda modificación.
- Banda azul "PLANO CONGELADO · hoja xx · clic para descongelar"; lienzo con cursor de prohibido.
- Estado por hoja, guardado en el .pid. En el DXF todas las capas salen bloqueadas.

## Atajos de teclado
- Registro único de atajos (ACCIONES_BASE + cualquier orden de los menús, por su ruta "Menú › … › Orden").
- CAD > Atajos de teclado…: pestaña Teclado (categoría, buscar, Asignar = pulsar la combinación, quitar, conflicto con aviso y reasignación, Restaurar valores predeterminados, Copiar lista) y pestaña Gestos del ratón.
- Ayuda > Atajos de teclado: consulta (se completa sola con los atajos nuevos) + teclas fijas y ratón + guía de gestos.
- Los menús muestran el atajo vigente (también los personalizados).
- Reservadas: Esc, Intro, Retroceso, Tab. Configuración en este navegador (localStorage piping-atajos).
- De fábrica: Ctrl+N, Ctrl+O, Ctrl+G, Ctrl+P, Ctrl+R, Ctrl+K, Ctrl+C/X/V, Supr y B (eliminar), Ctrl+Z, Ctrl+Y y Ctrl+Mayús+Z, Ctrl+A, R / Mayús+R (45°), L (trazar tubería), Alt+A (añadir hoja), F (ajustar), T (zoom todo), W (zoom ventana).

## Gestos del ratón (diseño propio)
- Botón derecho pulsado + desplazamiento (> 30 px) en una dirección y soltar = orden asignada; aparece una guía circular con sectores y nombres. 4 u 8 direcciones.
- De fábrica: arriba Paleta de comandos, arriba-derecha Trazar tubería, derecha Zoom todo, abajo-derecha Zoom ajustar, abajo Calcular red, abajo-izquierda Rehacer, izquierda Deshacer, arriba-izquierda Tabla de propiedades.
- Un clic derecho sin desplazar abre el menú contextual normal.

## Menú contextual con órdenes alrededor del cursor
- Al hacer clic derecho aparecen "píldoras" alrededor del cursor y la lista habitual debajo.
- En el lienzo: las órdenes de los gestos (misma posición que su dirección).
- Sobre un componente: Editar, Girar 45° horario, Mover, Copiar, Eliminar, Nota anclada, Girar 45° antihorario, Tabla de propiedades.
