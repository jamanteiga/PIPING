# PIPING v8.34 · Ratón normal en el 3D y zoom ventana

Etiqueta: `8.34-raton-3d`. Ficheros cambiados: `index.html` y `js/piping.js`. Copia de la versión anterior: `copias\v833`.

## Cambios
- **El ratón normal siempre funciona**, aunque el ratón 3D esté conectado. Esto anula la exclusividad que se introdujo en la 8.33.
  | Acción | Resultado |
  |---|---|
  | Botón izquierdo y arrastrar | Girar alrededor del pivote |
  | Ctrl o Mayús + botón central | Girar |
  | Botón derecho, botón central o Mayús + arrastrar | Desplazar |
  | Rueda | Acercar o alejar hacia el punto bajo el cursor (`zoomCursor3D`); ese punto queda fijo en la pantalla |
  | Doble clic con la rueda (sin arrastrar) | Encajar, igual que T |
- **W en el 3D**, y también **Zoom > Ventana**: activa el zoom ventana.
  - Se arrastra un rectángulo con el botón izquierdo; Esc o el botón derecho cancelan.
  - El centro de la nueva vista es el componente que hay en el centro del rectángulo, o el plano de la vista si no hay ninguno.
  - La distancia se ajusta para que el rectángulo llene la pantalla.
  - F vuelve a la vista anterior.
  - Funciones: `zoomVentana3D`, `rectZoom3D`, `aplicarZoomVentana3D`, `puntoPlanoVista3D`.

## Pruebas
- t_834, con un ratón 3D simulado como conectado, comprueba:
  - el botón izquierdo gira;
  - la rueda acerca hacia el cursor y el punto bajo el cursor no se mueve;
  - el botón central desplaza sin girar;
  - Mayús + botón central gira;
  - W y el rectángulo pasan de r 6,4 a 0,52 m centrando el componente;
  - F vuelve a la vista anterior;
  - Esc cancela el zoom ventana;
  - el botón derecho sigue abriendo el menú.
- t_831, t_832 y t_833 sin errores. test10, 13, 14, 20 y 23 sin diferencias.
