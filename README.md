# PIPING v8.4-web (01/10/2026) — index.html aligerado para GitHub Pages

Repositorio: https://github.com/jamanteiga/PIPING · Pages: https://jamanteiga.github.io/PIPING/
Misma funcionalidad que la 8.3.1; solo cambia la estructura. Copia del monolito 8.3.1: `index_antes_v84.html`.

## Estructura

| Fichero | Tamaño | gzip | Contenido |
|---|---|---|---|
| `index.html` | 22 KB | 6 KB | HTML y cargador |
| `css/piping.css` | 27 KB | 6 KB | estilos propios + Tailwind compilado (sustituye a cdn.tailwindcss.com) |
| `js/piping.js` | 973 KB | 269 KB | toda la aplicación (script clásico, no módulo ES) |
| `i18n/en.js`, `pt.js`, `ko.js` | ~108 KB c/u | ~35 KB | diccionarios; se cargan solo si se usan |
| `catalogo.js` | 57 KB | 11 KB | sin cambios |

Antes: `index.html` de 1 326 KB (381 KB gzip) más el Tailwind del CDN generando estilos en cada carga.

## Decisiones

- Scripts clásicos con rutas relativas: funciona igual con doble clic (file://) y en GitHub Pages.
- Rutas con `?v=8.4`: al publicar una versión nueva se cambia el número para que el navegador no use la caché antigua.
- Idiomas bajo demanda: el de la interfaz se carga antes de arrancar (según `localStorage piping-idioma`); el del informe/cajetín se carga al dibujar, al cambiarlo o al generar el informe (`asegurarIdioma`).
- Orden del CSS: estilos propios antes que Tailwind (como con el CDN, que inyectaba Tailwind al final de `<head>`).
- Con file:// los errores de un script externo llegan como «Script error.» sin el objeto de error: el manejador del plano congelado / solo lectura lo reconoce también así.
- A partir de esta versión se edita la estructura dividida (`js/piping.js`, etc.), no un monolito.

## Publicar en GitHub

1. Repositorio > Add file > Upload files: arrastrar `index.html` y las carpetas `css`, `js`, `i18n` (y `catalogo.js` si cambia).
2. Settings > Pages > Build and deployment > Deploy from a branch > `main` / `(root)` > Save.

## Pruebas

Regresión test10–test23 sobre la versión dividida, por file:// y por http: mismos resultados que la 8.3.1. Arranque en coreano: carga solo `i18n/ko.js`.
