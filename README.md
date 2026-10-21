# PIPING 8.60 — Etiquetas del isométrico, modelo 3D de bomba desde catálogo, cinta 3D, catálogo sin aviso

## Isométrico de línea: etiquetas de componentes
- Cada etiqueta (`iso.marcas[i]`) guarda `dx`, `dy` y `rot`; la línea de referencia va siempre del componente al texto.
- Arrastrar con el ratón mueve la etiqueta.
- Clic derecho:
  - girar 90° horario / antihorario;
  - girar 15° horario / antihorario;
  - paralela a la tubería (±30°);
  - horizontal;
  - posición automática.
- Teclas con la etiqueta seleccionada: R (90° horario), Mayús+R (90° antihorario), Ctrl+R (15°), Ctrl+Mayús+R (15° antihorario).
- El resaltado de la selección se quita al exportar o imprimir.
- Funciones: `isoEtqSel`, `isoMarca`, `isoGirarEtq`, `isoAutoEtq`.

## Modelo 3D de la bomba desde el catálogo
- Acceso: propiedades de la bomba › «Modelo 3D desde el catálogo (tabla de medidas)…» (`abrirModelo3DBomba`).
- Se pega la tabla de medidas de la ficha: cabecera con las letras y filas por modelo, separadas por tabuladores, «;» o espacios (`leerTablaCotas`).
  - La fila se elige sola por el modelo de la bomba (p. ej. CPM158 → «CP 158»).
- Cada cota del modelo (a, f, h1, h2, h3, n1, n2 y las nuevas opcionales m1 = separación de pies, dm = Ø motor) se asigna a una columna. Se emparejan solas si la letra coincide; el valor también se puede escribir a mano.
- Vista previa: alzado lateral a escala con las cotas (`vistasBomba3D`). La imagen del catálogo se puede cargar como referencia.
- «Generar el modelo 3D»:
  - escribe `forma3D = horizontal` y `cotas3D`;
  - comprueba que h2 > h1, h3 > h1 y f > a.
- `cotasBomba` y la malla 3D usan `dm` (radio del motor) y `m1` (pies).
- Sigue disponible la lectura de la ficha PDF con IA (Gemini), que ya rellena `cota_*_mm`.

## 3D
- Cinta `.v3d-cinta` con `flex-wrap: wrap` y `overflow-x: hidden`: ya no aparece barra horizontal.
- El árbol se recoloca con un ResizeObserver cuando la cinta pasa a dos filas.

## Catálogo de Supabase
- Desaparece la pregunta «¿Recargar ahora?» al abrir. El catálogo se guarda y se aplica solo en la siguiente carga; solo se informa si se sincroniza a mano.

## Entrega
- Ficheros:
  - `index.html` 8219bf3d02397000d0b8dfd73f18fb19
  - `js/piping.js` c6198588821309673e5b9b7d6f98f6a4
  - `css/piping.css` e49de0e8c704f643ce704e496287ea2d
  - `js/partes/cad.js` f2ba53a68d5ad1f7cf67e15aa6c67b0e
- Copias: `copias/v859` (rehecha: la anterior había desaparecido con la resincronización) y `copias/v860`.
