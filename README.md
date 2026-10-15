# PIPING 8.51 · equipos (punto 34) y bomba 3D paramétrica (punto 3 de la lista nueva)

## 34 · Librería › Equipos
Tipos nuevos en `cat: 'equipos'`. Calculan con la Δp nominal del fabricante (`qNom` / `dpNom`). Δp por defecto (`dpDef`, filtro limpio):

| Tipo | Código | Δp por defecto |
|---|---|---|
| Filtro de cesta vertical / horizontal | FCV / FCH | 20 kPa |
| Strainer vertical (en T) / horizontal (en Y) | STV / STH | 15 kPa |
| Filtro coalescente vertical / horizontal | FKV / FKH | 50 kPa |
| Separador de sentinas CPS (coalescent plate separator) | CPS | 30 kPa |
| STP, sewage treatment plant | STP | 20 kPa |
| VTP, vacuum treatment plant | VTP | 20 kPa |

- **Monitor contraincendios (MON):** es un punto de consumo (`esConsumoT` sustituye a `subtype === 'consumo'` en todo el código). Por defecto 120 m³/h y 7 bar.
- Cada tipo tiene símbolo P&ID propio y cuerpo 3D:
  - cilindro vertical u horizontal con tapa;
  - el strainer en Y lleva la pata inclinada;
  - CPS, STP y VTP como caja;
  - monitor con pedestal y lanza.

## Bomba 3D paramétrica
- **Disposición en 3D** (`el.forma3D`):
  - `horizontal`: centrífuga horizontal con aspiración axial e impulsión vertical. Es la opción por defecto en las bombas centrífugas nuevas.
  - `linea`: en línea, como antes. Es la que conservan las bombas de proyectos anteriores.
- **Cotas del catálogo** (`el.cotas3D`, texto «a=42; f=286; h1=92; h2=148; h3=240; n1=190; n2=160»):
  - a: cara de aspiración – eje de impulsión;
  - f: longitud total;
  - h1: altura del eje;
  - h2: cara de impulsión;
  - h3: altura total;
  - n1 × n2: base.
  - Si faltan, `cotasBomba` las estima con el DN.
- Modelo dibujado: voluta, toberas y bocas, linterna, motor con tapa del ventilador, caja de bornes, base y pies.
- La serie Pedrollo CP lleva las cotas de la hoja del fabricante (CP100–132, 150–158, 170, 190 y 200).
- Geometría:
  - `colocar` tiene una rama propia: boca de aspiración a la distancia a sobre el eje y boca de impulsión a h2 − h1 hacia arriba;
  - si la bomba es la raíz, la impulsión arranca hacia +Z;
  - la tubería que sale de la impulsión sigue la boca, es decir, vertical.
  - Aviso nuevo: si esa tubería es horizontal según sus cotas, falta un codo de 90° a la salida (o hay que cambiar la disposición a «En línea»).
- **IA de la ficha:** el esquema de `supabase/functions/piping-bomba-pdf/index.ts` incluye ahora `disposicion` y `cota_a_mm` … `cota_n2_mm`. El cliente las pasa a `forma3D` y `cotas3D`.
  - En Supabase van dentro de `connections` (jsonb), sin cambiar la tabla.
  - **José tiene que volver a desplegar la Edge Function.**

## Entrega
- Copia de seguridad en `copias/v850`.
- md5:
  - index.html 494e96ae49c5811cd8d4ab723bec67ae
  - piping.js e1a14a0a3f76bec955e777eb6144af2c
  - informe.js 879fa72a987bcb0724a062c3029d84ca
  - index.ts 15883d70aacab8d72d9c0de0a37681b2
- Pruebas:
  - test51 nuevo;
  - test42 cambia porque la bomba nueva es horizontal: la válvula queda en tubería vertical y el giro Z es ahora el eje de su conexión;
  - el resto, solo recuentos del panel.
