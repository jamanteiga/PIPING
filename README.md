# PIPING 8.53 · reparto del caudal en las salidas libres

## Decisión de José (15/10/2026 22:24)
- **Red sin bomba:**
  - los puntos de consumo toman su caudal;
  - las salidas libres se reparten **a partes iguales lo que falte hasta el caudal de diseño**: Qresto = máx(0, Qdiseño − ΣQconsumos) / n salidas;
  - si los consumos ya llegan al caudal de diseño, las salidas libres quedan sin caudal;
  - la presión en cada salida es el resultado del cálculo, y la ventana de puntos finales comprueba que sea ≥ 0.
- **Red con bomba:**
  - el caudal de la bomba debe ser ≥ el de diseño (motivo «Q de funcionamiento < caudal de diseño», ya existente);
  - las salidas libres siguen a p = 0, así que el caudal de la bomba se reparte entre consumos y salidas según la hidráulica de la red;
  - la ventana de puntos finales da por bueno el total si Q bombas ≥ Q diseño.

## Código
- En `calcularResultado` (rama `sb`), las salidas siempre reciben una demanda impuesta: el resto hasta el caudal de diseño. Se guardan `sb.Qcons` y `sb.Qresto`.
- `resultado.sinBomba.Qcons` y el Q de cada salida pasan a ser Qresto / n.
- Avisos nuevos en el cálculo, en la ventana de condiciones de contorno y en el resumen de `mostrarPuntosFinales` (con o sin bomba).
- Comprobado en test53:
  - red sin bomba, 6 m³/h y 3 bar → salida libre 4,00 m³/h a 2,64 bar y consumo 2,00 m³/h a 2,73 bar;
  - con bomba CP 200 → 12,15 m³/h repartidos.

## Entrega e incidencia
- Al entregar se vio que la carpeta de José estaba otra vez en la **8.51** (ficheros con fecha 22:17 local). Además habían desaparecido las copias de seguridad v845–v850 de `copias`.
- Se ha entregado el juego completo 8.53, que incluye los cambios de la 8.52: index.html, piping.js, cad.js, informe.js e i18n.
- La copia hecha antes de entregar contenía la 8.51 y se ha renombrado `copias/v852_contiene_8.51`.
- md5:
  - index.html 40ea41c5e800dc0f3f85960babf780bd
  - piping.js 7d8f24e998a65b44d4d74dccffb5a449
  - cad.js d1abdd0718a872a78192a275b780617e
  - informe.js 918f6b4b93a4614fe1ac3719c016ad29
