# PIPING v8.38 · Iconos propios (Opciones > Iconos)

Etiqueta: `8.38-iconos`. Ficheros cambiados: `index.html`, `js/piping.js`, `i18n/en.js`, `i18n/pt.js`, `i18n/ko.js`. Copia de la versión anterior: `copias\v837`.

## Decisión de José
Estilo por defecto: **B · baldosa con degradado**. Se puede cambiar en cualquier momento a A · bicolor o C · línea técnica. También queda la opción Clásico (Font Awesome).

## Implementación
- **Glifos:** `GLIFOS_P`, 101 glifos SVG de 24×24 con trazo (clase `t`) y acento (clase `a`).
- **Correspondencias:** `FA_A_GLIFO` (135 iconos de Font Awesome → glifo), `FAMILIA_FA` (familia de color de cada uno) y `COLORES_FAMILIA`:
  - Dibujo, azul;
  - Cálculo, verde;
  - Vista y 3D, naranja;
  - Edición, gris (por defecto);
  - Eliminar, rojo;
  - Sistema y archivos, violeta.
- **Iconos sin glifo propio** (unos 30 poco usados): se muestra el de Font Awesome dentro del mismo estilo; en B, blanco sobre la baldosa de color.
- **Zonas donde se aplican** (`ZONAS_ICONO`): menús y submenús, menú del botón derecho, órdenes alrededor del cursor, barra rápida, barras flotantes y paleta de comandos.
  - Las casillas ✓/□ de los menús y los iconos auxiliares (flechas, bloqueos) no se tocan (`NO_ICONO`).
- **Aplicación:**
  - `aplicarIconos()` cambia cada `<i class="fa-solid fa-…">` de esas zonas por `<span class="icp" data-fa>` con el SVG.
  - La lanza un `MutationObserver` agrupado por microtarea, así que también se aplica a los menús que se crean al vuelo.
  - Salta los `<i>` que ya están dentro de un `.icp`; sin esa comprobación había un bucle infinito en la paleta.
- **Estilos:** CSS inyectado (`#estilo-iconos`) con las clases `body.ic-A`, `body.ic-B` y `body.ic-C`. `ponerEstiloIconos(e)` cambia la clase, restaura los `<i>` originales al pasar a Clásico y vuelve a pintar las barras.
- **Persistencia:** `CONF_ATAJOS.iconos`, por usuario. Viaja con CAD > Exportar / Importar configuración del CAD.

## Pruebas
- t_838, en carga normal y diferida, comprueba:
  - estilo B por defecto;
  - menú Cálculo: 22 iconos SVG, 2 iconos de Font Awesome en estilo y las 4 casillas sin tocar;
  - menú del botón derecho: 13 iconos; barras flotantes: 12; paleta: 44;
  - el paso a Clásico deja 0 iconos convertidos, y la vuelta a B los recupera.
- Capturas de A, B y C revisadas.
- Regresión: solo cambian el menú Opciones (test13) y el número de órdenes de la paleta (test14). t_832 a t_837 sin errores.
