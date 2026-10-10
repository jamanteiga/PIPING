# PIPING v8.30 · K/Cv de válvulas (a–d) y vista 3D fase F1

Fecha: 2026-10-10 · Copia de la 8.29 en `copias\v829\`.

## Punto 5 · K y Cv
- (a) Curvas típicas Cv/Cv100 frente a apertura por tipo (CURVAS_TIPICAS_APERTURA): mariposa (Crane Center Line S200), bola y macho, compuerta y tajadera (K 0,15 / 0,26 / 2,1 / 17 a 100/75/50/25 %), globo y aguja (lineal), membrana (apertura rápida). En modo Crane, campo «Apertura (%)» en el panel: K = K100/(Cv/Cv100)². Ej.: compuerta DN 80 al 50 % → K × 14.
- (b) Librerías > Válvulas > Tabla de Cv: columna «Cv Crane (ref.)» y botón «Completar los tamaños que faltan (escalado Crane con fT)»: n = K/fT en los tamaños conocidos, interpolado en log(D); estimados en naranja y anotados en Notas.
- (c) Válvulas de control: autoridad N = Δp válvula / Δp del recorrido de mayor pérdida (aprox.) y característica instalada Q/Q100 = 1/√((1−N) + N/f²) a 10/25/50/75/90/100 %; aviso si N < 0,25.
- (d) Aviso en el cálculo si el Cv de catálogo difiere más del ±50 % del equivalente de Crane para el mismo subtipo y DN.

## Vista 3D · F1 (botón «3D» junto a Normal / Isométrico, o Vista > Vista 3D)
- Three.js 0.147 (cdn.jsdelivr.net, se carga al abrir). Ejes navales dextrógiros: origen en el eje del timón (cuaderna 0), +X proa, +Y babor, −Y estribor, +Z arriba.
- Toolbar: Planta, Perfil (desde estribor, proa a la derecha), Desde proa, Isométrica, Ajustar; «Inicio de P01 respecto al eje del timón» X/Y/Z en mm (proyecto.origen3D); «Cuaderna (mm)» (proyecto.cuaderna, 750 por defecto); etiquetas y cuadernas activables (líneas cada cuaderna, marcadas cada 5, crujía discontinua, eje del timón).
- Geometría desde el P&ID (dirección del esquema, longitud y cotas a/b): tubos con su Ø exterior real, válvulas, bombas, depósitos (por volumen y altura), consumos, equipos. Colores: rojo fallo, naranja seleccionado.
- Ratón: arrastrar gira, botón derecho o Mayús desplaza, rueda zoom; al pasar: tag + coordenadas navales (cuaderna + mm, babor/estribor de crujía, Z); clic selecciona (panel de propiedades).
- Funciones: abrirVista3D, iniciarMotor3D, construirEscena3D, vista3dCamara, elegir3D, textoNaval, refrescar3D.

Archivos (md5): index.html 22adc39a · js/piping.js 0ce6fd01 · css/piping.css 678b46f2 · i18n en 7398b37a, pt ccc30742, ko 1bf841ef.

## Siguiente (F2)
Trazado en 3D desde puertos libres con direcciones ±X/±Y/±Z y longitud, codos automáticos, válvulas sobre tubo con su cara a cara, giro del vástago; posiciones 3D guardadas en cada elemento y relación biunívoca con el P&ID.
