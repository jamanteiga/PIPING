# PIPING v8.31 · 3D con medidas reales, ramales, ratón 3D, fondo y referencia del proyecto

Fecha: 2026-10-10 · Copia de la 8.30 en `copias\v830\`.

## Geometría 3D (geometria3DReal)
- Recorrido por puertos desde el inicio de P01: cada componente ocupa su longitud real y sus puertos salen en la dirección del esquema (derecha = +X, arriba = +Y), girada para quedar coaxial con el tubo que llega (p. ej. tras un tramo vertical). Así salen los ramales de tes y cruces, los codos y los injertos.
- Medidas orientativas si el modelo no da otras: válvulas cara a cara EN 558 serie 1 (mariposa/tajadera/wafer: serie 20) o «Distancia entre caras (mm)» del modelo; codos B16.9 (LR 1,5·NPS, 45° 0,625·NPS); tes B16.9 (C); reducciones B16.9 (H); bridas B16.5 cl. 150 (Ø exterior, espesor, longitud WN); bombas en línea; depósitos por volumen y altura.
- Codo de 90°: vértice en la esquina del símbolo. Las tuberías: longitud y cotas a/b (vertical si el desnivel ≈ longitud).
- Formas: tubo con Ø exterior real; válvula «pajarita» (como el P&ID), bola con esfera y palanca, mariposa como disco, compuerta/globo con volante, control/neumática con actuador, retención sin vástago, bridas propias si la conexión es «Bridada»; codos curvos; tes; reducciones cónicas; bridas con disco y cuello (WN); machón hexagonal; juntas de expansión; filtros en Y; bomba en línea con voluta, motor vertical y bancada; depósitos; consumos; instrumentos.
- Etiquetas de tamaño constante en pantalla.

## Proyecto (Archivo > Datos del proyecto > Referencia 3D)
- Buque: origen 0,0,0 en el eje del timón (C0), +X proa, +Y babor, −Y estribor, +Z arriba; punto inicial de P01 (X, Y, Z en mm; si el primer elemento es una bomba, su conexión de impulsión) y separación de cuadernas (750 mm por defecto). En 3D: ejes PROA/BABOR, cuadernas cada 5, crujía y eje del timón.
- Industrial: el primer elemento de P01 (o la impulsión de la bomba) en 0,0,0; «Norte (° desde +X, antihorario)», 90 por defecto; en 3D ejes X/Y/Z, flecha N y rejilla; sin proa/popa/babor/estribor.
- Campos guardados en proyecto: origen3D {x,y,z}, cuaderna, norte.

## Vista 3D
- Fondo: selector de color del sistema; se recuerda en el navegador (localStorage «piping-3d») junto con Etiquetas, Cuadernas/Rejilla, sensibilidad, Horizonte fijo e Invertir giros.
- Ratón 3D 3Dconnexion (SpaceMouse) por WebHID (Chrome/Edge): botón «Ratón 3D» la primera vez; después se reconecta solo.

## 8.31.1 · ratón 3D con 6 grados de libertad
- Fallo de la 8.31: se abría la primera colección HID del dispositivo, que no es la de los ejes; solo funcionaba el zoom que el driver 3DxWare emula como rueda. Ahora se abre la colección del controlador multieje (usage page 1, usage 8) y se reconecta sola al enchufar.
- Mapa: X/Y del capuchón (izquierda-derecha) desplazan; empujar/tirar (eje Y del ratón) acerca/aleja; subir/bajar (Z) desplaza en vertical; inclinar adelante/atrás (Rx) cabecea; girar (Rz) gira alrededor de la vertical; inclinar a los lados (Ry) alabea si «Horizonte fijo» está desactivado. Botón 1: Ajustar; botón 2: Isométrica.
- Opciones en la barra 3D: Sens., Horizonte fijo, Invertir giros, Diagnóstico (muestra en la barra inferior el informe HID y los 6 valores).
- Informes HID: 1 (traslación, o los 6 ejes si trae 12 bytes), 2 (giro), 3 (botones).

Archivos (md5) 8.31.1: index.html d423804c · js/piping.js a4d370eb (8.31: index.html 1b9833a1 · js/piping.js f9baded0 · i18n en 422c817a, pt 59b1a52f, ko 854aada5). Copia de la 8.31 en `copias\v831\`.
