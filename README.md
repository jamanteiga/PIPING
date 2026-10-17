# PIPING 8.59 — K de válvulas por fórmula, etiquetas de terminales, ratón 3D, DN de bocas de bomba

## Válvulas: K siempre por fórmula
- `kElemento`: en las válvulas con `modoK` 'cv' o 'manual' se usa la fórmula.
  - Es la mayor entre Crane TP-410 y las empíricas (Hooper, Darby, Perry).
  - Se informa el Cv equivalente.
- El Cv o K tecleado solo se compara: si difiere más de ×3 sale el aviso «no es coherente con la fórmula: no se usa».
- Excepciones:
  - doble clapeta (`pedirCv`), que no tiene fórmula;
  - válvulas de control con Kvs;
  - series de catálogo (Cv del fabricante en la BD).
- Aguja (antes «pedir»): Crane 340·fT, como globo de asiento; es un valor mínimo.
- PROYECTO-PRUEBA-001: VB01 y VB02 (Cv 0,3 / 0,5 tecleados) pasan a K 0,044 (Cv 469); VMB01 a K 2,30 (Cv 74).

## Etiquetas de puntos finales en el plano
- Posición y borrado guardados en el elemento (`el.pfEtq[port]`): persisten al recalcular y en el .pid.
  - `huellaRed` ignora `pfEtq`.
- Clic derecho en la etiqueta:
  - Eliminar esta etiqueta;
  - Eliminar todas;
  - Posición automática;
  - Volver a mostrar todas.
- Seleccionar la etiqueta y pulsar Supr también la borra.
- Vista › «Volver a mostrar las etiquetas de puntos finales eliminadas».
- Funciones: `pfObj`, `pfOcultar`, `pfMostrarTodas`.

## Ratón 3D
- Al abrir el 3D se conecta solo si el navegador ya lo autorizó.
- Si el permiso se perdió, el primer clic o rueda en la vista 3D lo vuelve a pedir solo: WebHID exige un gesto (`smGesto`, `localStorage piping-sm`).
- Sin contexto seguro (file://) aparece la nota: hay que abrir por https (GitHub Pages) o http://localhost.

## Curva Q-H de la bomba
- Muestra el punto de diseño del proyecto (Qd y presión de diseño en mca):
  - línea vertical y cruz;
  - veredicto CUMPLE / NO CUMPLE / FUERA DE RANGO.
- El círculo verde pasa a llamarse «punto nominal de la bomba».

## Uniones: DN distinto sin reducción
- `difDNUnion` / `dnPuerto` / `dnMmTxt`: compara el DN de la boca de la bomba (dnAsp/dnImp) con lo que se le une.
  - Si no coincide es un fallo: «no se puede embocar directamente; intercala una ampliación concéntrica / reducción excéntrica (aspiración, parte plana arriba)».
  - Otros elementos con DN distinto sin reducción: aviso.

## Bomba fuera de su curva en funcionamiento
- Si el corte con la red cae más allá del final de la curva por puntos, aparece el aviso FUERA DE RANGO en funcionamiento.
  - Ejemplo: 10,46 m³/h con salidas libres y válvulas ya por fórmula.
- Recomienda válvula de regulación, placa de orificio o presión mínima en las salidas.

## Entrega
- `index.html` md5 3f741bd4dbd7380c262f14db50f681cd; `js/piping.js` md5 b622c3889ecdbd3046c382b202db5ee5.
- Copias en `copias/v858` (8.58) y `copias/v859`.
- La carpeta del PC había vuelto a la 8.57 tras la entrega de la 8.58.
