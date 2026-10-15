# PIPING 8.52 · bloque C (12, 23, 24, 25) y puntos finales de la red

## 12 · Leyenda en el isométrico
- `leyendaIso` dibuja un renglón por tipo de componente, con el símbolo simplificado del isométrico (`claseIso` / `simboloIso`).
  - Siempre incluye el renglón de tubería y el de «EL ±x,xx · cota de elevación».
- Dónde aparece:
  - en la hoja de **Herramientas › Isométrico de línea...**, a la derecha (el dibujo se estrecha 80 mm para dejarle sitio);
  - en la **vista Isométrico** del lienzo, arriba a la derecha.
- Vista › Mostrar la leyenda la oculta (`opciones.ocultarLeyenda`).

## 23 · Informe › Listados de líneas, válvulas y materiales (*.xlsx)
- Diálogo previo (`elegirListados`) para elegir:
  - qué **hojas** se generan;
  - qué **columnas** de cada hoja;
  - qué **líneas** entran (filtra todas las hojas: `datosListados(filtroLin)`);
  - «Quitar las columnas sin datos» (análisis automático), marcado por defecto.
- La elección se recuerda en el navegador (`piping-listados-cfg`) y se aplica con `aplicarCfgListados`.

## 24 · Fabricantes de bombas
- `FABRICANTES_BOMBA`: 40 marcas habituales, entre ellas Grundfos, KSB, Wilo, Xylem, Sulzer, Flowserve, Ebara, Pedrollo, Calpeda, Desmi, Allweiler, IMO, Shinko, Naniwa, Taiko, Svanehøj y Framo.
- Se ofrecen en un desplegable (`datalist`) en el fabricante de la bomba, tanto en los atributos como en la ficha de la librería.
- La lista añade los fabricantes de la base de datos de bombas, y se puede escribir otro.

## 25 · Precio
- Campo **Precio** en todos los componentes: €/ud, y €/m en tuberías (`el.precio`; moneda `proyecto.moneda`, por defecto €).
- Dónde se puede poner o ver:
  - en los atributos;
  - en la ficha de la librería (pasa al componente al elegir el modelo);
  - en Tabla › Tabla de propiedades (columna nueva en cada grupo).
- En el Excel, la hoja Materiales lleva «Precio unitario» e «Importe», con fila TOTAL. Agrupa también por precio y añade el fabricante a la descripción.
- En las bombas de Supabase el precio se guarda dentro de `connections`. En válvulas y accesorios de Supabase **no se guarda** todavía en la base de datos; sí en la librería local y en el proyecto.

## Puntos finales de la red (petición de José, 15/10 22:10)
- `puntosFinalesRed`: nudos con una sola conexión por los que sale el caudal o no circula. Quedan fuera las alimentaciones (Q entrante) y el origen de la red sin bomba.
- Para cada punto: Q y p manométrica de salida, y la condición:

| Punto final | Condición |
|---|---|
| Consumo | p ≥ p mín y Q demandado |
| Salida libre | p ≥ 0 |
| Llegada a depósito | p ≥ 0 |
| Extremo cerrado | sin caudal |

- Se muestran de tres formas:
  - **Ventana flotante al calcular** (F2): `mostrarPuntosFinales`. Se arrastra por el título y recuerda su posición; clic en una fila lleva al punto. En la red sin bomba indica origen, presión, caudal y fluido. Compara el caudal total con el de diseño (aviso si difiere más de un 2 %).
  - **Etiqueta en el plano** junto a cada punto final, con Q y p en verde o rojo (`svgPuntosFinales`, capa de etiquetas).
  - **Menú Cálculo:** «Puntos finales de la red (Q y p de salida)...», «Abrir la ventana de puntos finales al calcular» y «Mostrar Q y p en los puntos finales del plano».
- **Incongruencia detectada:** en una red sin bomba que tiene puntos de consumo, las salidas libres van a p = 0 y descargan el caudal que resulta de la presión de diseño, que puede ser mucho mayor que el caudal de diseño. La ventana lo avisa.

## Entrega
- Copia de seguridad en `copias/v851`.
- md5:
  - index.html 96a744de13e38232419273baf11e8225
  - piping.js e29b321ea46035db57940541cada9bf7
  - cad.js d1abdd0718a872a78192a275b780617e
  - informe.js 918f6b4b93a4614fe1ac3719c016ad29
- Pruebas: test52 (precios, Excel, isométrico) y test53 (puntos finales, red sin bomba con te). Regresión sin cambios salvo recuentos; test20 sigue siendo intermitente.
