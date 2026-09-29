# PIPING 7.2 · Interfaz, inserción, formatos y Supabase (2026-09-29)

Entregado en `C:\Users\jaman\Documents\PROYECTOS\PIPING\index.html` (md5 46b0a118…). La copia anterior está en `index_antes_v72.html`.

## Proyecto obligatorio
- Al arrancar se abre siempre el último proyecto de trabajo. Se guarda en el navegador en cada cambio.
- Si no hay ningún proyecto, se piden los datos del proyecto y la ventana no se puede cerrar.
- **Archivo > Nuevo** pide los datos antes de vaciar el lienzo.
- Datos obligatorios:
  - nº de proyecto, cliente e instalación;
  - fluido (desplegable del catálogo) y temperatura de servicio;
  - temperatura máxima admisible TS y caudal de diseño;
  - velocidades máximas en impulsión y en aspiración.
- La ventana muestra una tabla de velocidades recomendadas según el fluido y el tipo de instalación.
- Si el país no es España, el campo pasa a llamarse «Provincia / Estado / Departamento».
- En el panel izquierdo, el fluido, la temperatura, el caudal y las velocidades son de solo lectura. Solo se cambian en **Archivo > Datos del proyecto**.

## Librería (panel derecho)
- Todo aparece plegado.
- Funciona en acordeón: al desplegar una categoría se pliegan las demás.
- Al seleccionar o insertar un elemento se despliega su categoría.
- Las categorías van en orden alfabético.
- Dentro de Accesorios hay tres grupos plegables en acordeón:
  - Accesorios de tubería;
  - Intercambiadores (buques);
  - Tanques y depósitos.

## Inserción
- **Conexión automática**: al acercar el componente a un puerto libre (a menos de 60 px) se conecta solo, orientado en el sentido del flujo. Mientras se arrastra, el puerto de destino se resalta.
- **Herencia de propiedades** del elemento conectado:
  - componentes: tamaño y PN/clase;
  - tuberías: material, serie, clase y tamaño.
- **Primer elemento**: se dimensiona para V ≤ V máx con el caudal de diseño.
- **Ventana de datos particulares**, que siempre se abre al insertar:
  - válvulas: subtipo, DN, PN, Cv, Kvs y apertura;
  - codos y otros accesorios: tipo, DN y PN;
  - reducciones: DN mayor y menor, concéntrica o excéntrica;
  - PSV: presión de tarado;
  - instrumentos: conexión y rango;
  - bombas: Q, p, p a caudal cero, NPSHr, η, cota y servicio/reserva;
  - equipos: Δp, PN y volumen;
  - tanques: cota del fondo, altura de las conexiones b y c sobre el fondo, nivel de líquido, tipo y tamaño de conexión, y presión.
- **Ramales**:
  - cada salida de una te o de un cruce abre un ramal nuevo (te en P01 → R01 y R02; cruce → tres ramales);
  - la numeración es la global en ese momento;
  - en un injerto, el paso continúa la línea y la derivación es un ramal.
- Si la hoja está vacía, la numeración y las líneas empiezan de nuevo (P01, VAG01-P01…).
- La bomba tiene tubuladuras de aspiración (A) e impulsión (I).

## Etiquetas
- Sin longitud; la longitud aparece en el tooltip.
- Van en una capa propia, con colocación automática sin solapes.
- Siguen la orientación del componente y se leen en horizontal o, en vertical, desde la derecha (de abajo arriba).
- Se reducen hasta el largo del componente.
- Se pueden arrastrar cerca del componente; conservan el vínculo, con una línea de referencia si se alejan.
- Doble clic en una etiqueta: horizontal, vertical, girar ±90° o posición automática.
- Los textos interiores de los símbolos también se mantienen legibles.

## Ventanas y menús
- **Doble clic en un elemento** abre una ventana flotante que no bloquea el lienzo y se arrastra por la cabecera. Permite:
  - girar 90° horario o antihorario, o 180°;
  - mover o desconectar;
  - nota anclada y eliminar;
  - cambiar de línea o ramal (incluidos un ramal nuevo o una principal nueva);
  - editar todas las propiedades.
- **Botón derecho en el lienzo**, en orden alfabético: Calcular red, Leyenda de componentes, Listado de componentes, Nota de texto (se ancla al componente más cercano), Redimensionar red, Seleccionar línea ▸, Zoom ▸ (Ajustar, Todo, Ventana).
- **Botón derecho en un componente**: Girar ▸ 90°, 180° o 270°, en sentido horario o antihorario. Si el elemento está conectado por un único puerto, gira alrededor de ese puerto.
- **Al guardar**, si hay elementos sueltos, un aviso permite ir a colocarlos, eliminarlos y guardar, o cancelar.
- **NPSH remarcado**:
  - NPSHd / NPSHr bajo la bomba, en verde o en rojo;
  - recuadro en el panel de la bomba;
  - resaltado en los resultados y en el tooltip.
- **Ruta crítica**: siempre en violeta. Un fallo en la ruta crítica lleva además una marca roja «!».
- **Leyenda de componentes** (sin referencia a la norma): una sola, por defecto en la esquina superior derecha.
- **Listado de componentes**: tabla de materiales del plano, que se puede mover a cualquier sitio.

## Formatos y rejilla
- Formatos A4, A3, A2, A1 y A0 apaisados, con marco ISO 5457: 20 mm a la izquierda y 10 mm en los demás lados.
- Referencias fuera del marco:
  - letras desde abajo, sin I ni O;
  - números de mayor a 1, de izquierda a derecha.
  - A4: 4 columnas × 6 filas (A–F); A3: 8 × 6 (A–F); A2: 12 × 8 (A–H); A1: 16 × 12 (A–M); A0: 24 × 18 (A–T).
- Marcas de centrado en los cuatro lados.
- No se permite cambiar a un formato en el que el dibujo no cabe; se indica el formato mínimo.
- El árbol tiene un apartado «Formato» debajo de Anotaciones para cambiar el formato y la rejilla.
- La rejilla sigue el estilo de las hojas de SolidWorks: líneas mayores y menores.
  - Se configura en **Opciones > Rejilla** (mostrar, ajuste y espaciado; por defecto 10 mm y 4 divisiones).
- La impresión y el DXF usan el formato activo. El DXF tiene capas FORMATO, TEXTOS y ANOTACIONES.

## Supabase (2.22)
- Carpeta `supabase/`.
- `01_esquema.sql` con las tablas por grupos:
  - fluidos y propiedades, velocidades recomendadas;
  - materiales, series, tamaños y espesores;
  - Crane fT y K, reducciones B16.9, Vmin de retención;
  - tipos de componente;
  - fabricantes, válvulas de catálogo y Cv, PN EN 1092-1 y ASME B16.5, y tablas PN del fabricante;
  - bombas y curvas, motores IEC;
  - tanques, equipos e instrumentos de catálogo;
  - límites PED, RITE y clases navales;
  - proyectos, compartidos, revisiones y plantillas.
- RLS: el catálogo es de lectura para todos y de escritura para ADMIN; los proyectos son del propietario o se comparten.
- La vista `v_catalogo` devuelve el mismo JSON que catalogo.js.
- `02_datos.sql` se genera con `gen_datos.js` desde catalogo.js.
- Probado en PostgreSQL 16: la vista reproduce catalogo.js sin diferencias.

## Pendiente / decisiones del usuario
- Cajetín (dwg, dgn o dxf) y foto del marco A3 tipo para copiar su estilo exacto.
- Cargar el catálogo desde Supabase: falta la URL, la clave anon y la decisión de roles.
- Enlace con la app PED propia del usuario: pendiente de sus datos.
- Motor 3D (punto 3), más interactividad (punto 4) y código en servidor (punto 5): propuestos, sin implementar.
