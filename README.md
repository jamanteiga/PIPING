# PIPING 8.54 · flechas WN, puntos de conexión, desnivel, textos, giros y K de accesorios

Petición de José (15/10/2026 22:32), punto por punto:

1. **Flecha de las bridas** (WN y demás): apunta hacia la cara (RF), dibujada en el lado del tubo («41,15 35,18 41,21» en el símbolo local).
2. **Textos de los componentes:** todos del mismo tamaño (6,5); se quita la reducción al largo del componente en `specEtiqueta`.
3. **Textos sin schedule ni material:** `tagPlano(el)` deja código, línea y tamaño (C90LR02-R01-2") y quita «-STD-WPB».
   - 3.1 · Para verlos completos (`opciones.etqCompleta`):
     - casilla **Sch/material** en la barra de vista, junto a Normal / Isométrico / 3D;
     - **Vista › Textos de los componentes con schedule y material**.
   - El árbol, los listados y los informes siguen con el código completo (`tagDe`).
4. **Etiqueta seleccionada:** R gira 45° en sentido horario, Mayús+R 45° antihorario y Ctrl+R 15° horario. El ángulo ya es libre (`angNorm`); antes se forzaba a −90…90.
5. **Botón derecho sobre una etiqueta:** submenú **Girar** con 15, 45, 90, 180 y 270°, en sentido horario y antihorario.
6. **Componente:**
   - R: 45° horario;
   - **Mayús+R: 15° antihorario**;
   - **Ctrl+R: 15° horario**;
   - en 3D, Mayús+R y Ctrl+R giran 15° y R 90°.
   - Búsqueda/Reemplazo pasa de Ctrl+R a **Ctrl+H**.
7. **K de accesorios sin dato** (y de los roscados o de cobre): el más desfavorable de las fórmulas en régimen turbulento, mediante `kEmpirico` y la tabla `K_EMP`:
   - Hooper 2-K: K∞·(1 + 1/D);
   - Darby 3-K: Ki·(1 + Kd/D^0,3), con D interior en pulgadas;
   - Perry (tabla 6-4);
   - Crane n·fT cuando lo hay.
   - Valores por tipo: codos 90°/45° roscados, de radio corto y de radio largo; te roscada y soldada (paso directo y derivación); manguitos, tuercas, racores, machones y transiciones K = 0,04 (Perry, único dato publicado); espiga portamanguera, contracción + expansión con β ≈ 0,8 (Crane).
   - Las tes roscadas toman el máximo en paso directo y en derivación.
   - Las bridas siguen con K = 0.
   - En la justificación de cálculo se ve cada fórmula y cuál manda.
   - Ejemplos con DN 25: codo 90° roscado ISO 4144 K = 0,78 (Hooper); te roscada, paso directo 0,45 (Darby) y derivación 1,37 (Hooper).
8. **Puntos de conexión del 2D** un 60 % más pequeños (r = 1,04). No salen al imprimir ni al exportar a PDF, SVG o DXF (ya estaba así).

**Tubería que sube o baja:** discontinua bien visible (9,4) y marca «▲ +x,xx m» / «▼ −x,xx m» sobre la línea.

## Entrega
- md5:
  - index.html c702148ed8df9e156089486dcd093464
  - piping.js 32cfe734224484bc1e5d2fa66defceee
  - cad.js d1abdd0718a872a78192a275b780617e
  - informe.js 95ef56a94407a033b1a7517ac316a9e9
- **Incidencia repetida:** la carpeta volvió a la 8.51 a las 22:28 (UTC 20:28:36) con la fecha conservada. Además desapareció `copias/v851`.
  - Parece una herramienta de sincronización que restaura desde otra copia.
  - Se ha vuelto a entregar el juego completo desde la 8.51 y se ha comprobado en el equipo.
  - Las copias que en realidad contenían la 8.51 se han renombrado `copias/v852_contiene_8.51` y `copias/v853_contiene_8.51`.
- Pruebas: test54. En la regresión cambian, como se esperaba, test10 (etiquetas cortas), test17 (Mayús+R = −15°), test42 (ángulo de la etiqueta) y test48 (patrón de la línea discontinua).
