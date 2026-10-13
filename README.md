# PIPING 8.45 · flechas de flujo en la línea y trazos un 20 % más finos

Entregado en C:\Users\jaman\Documents\PROYECTOS\PIPING (index.html y js/piping.js). La versión anterior queda en copias\v844. md5 verificado.

## Cambios en el 2D
- **Tubería:** la flecha del sentido de flujo va dentro de la propia línea, centrada, con el color de la línea. Antes era verde y estaba por encima.
- **Te:** lleva dos flechas, una en cada salida (a → b y a → c), dentro de sus tramos y con el color del componente.
- **Resto de componentes:** conservan la flecha verde de referencia por encima del símbolo.
- **Grosor de los trazos:** todos los trazos de los componentes del P&ID son un 20 % más finos. Se aplica con `afinarTrazos` y `FACTOR_TRAZO = 0,8` sobre los `stroke-width` de los símbolos. Las anotaciones (leyenda, listado, notas, cajetín) no cambian.
- Los trazos más finos también pasan a la impresión, el PDF y el DXF, porque todos salen del mismo dibujo.

## Pruebas
- **test45:** la flecha de la tubería queda en la línea (y = 20) con el color de la línea, la línea tiene 1,76 de grosor (antes 2,2), la te lleva 2 flechas y las líneas de la te tienen 1,6 (antes 2).
- **Regresión (test10–23, test41–44):** sin cambios, salvo el tamaño del DXF, que cambia como se esperaba.

## Pendiente de 8.43
- El cubo de vistas no se ve en el equipo de José, con la 8.44. En las pruebas aparece a escala 100 % y 150 %. Se le ha pedido una captura del 3D para ver qué lo tapa.
