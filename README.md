# PIPING 6.8: cotas, consumos, PMA, golpe de ariete, dimensionado, listados, selección múltiple y unidades

## Cotas
- Las tuberías tienen cota en el extremo a y en el extremo b. Al insertar una tubería se piden las dos: la del extremo conectado se hereda y el desnivel no puede superar la longitud.
- Los componentes heredan la cota del punto al que se conectan. Todas las cotas se pueden editar en el panel.
- La cota de cada nodo es la media de las cotas de sus puertos. Si no coinciden, se genera un aviso.
- Los extremos abiertos toman la cota del elemento; en la ventana de contorno solo se pide la presión.
- Presión en cada nodo: p = (H − z)·ρ·g − p_atm.

## Terminales y equipos (librería: "Consumos y depósitos" y "Equipos")
- **CON · Punto de consumo:** caudal impuesto (sumidero en el nodo) y presión mínima. Se comprueba p ≥ p mín.
- **DEP · Depósito:** altura fija H = cota de lámina + (p_atm + p)/(ρ·g).
- **Equipos:** IC intercambiador, EF enfriador, ENF enfriadora, FC fan-coil y EQ genérico. Se definen con el Δp del fabricante a caudal nominal; en el cálculo, Δp = Δp nom·(Q/Q nom)², equivalente a un K referido a la tubería conectada.
- **Equilibrado:** el consumo con menor exceso de presión es el más desfavorable y no lleva válvula.
  - En el resto, Δp = exceso − exceso mínimo, y la válvula se dimensiona con Kv = Q·√[(ρ/1000)/Δp].
  - El exceso del consumo más desfavorable queda como margen de la bomba y genera un aviso si pasa de 0,1 bar.
- **Ruta crítica:** es el camino con mayor valor de hf acumulada + altura requerida en el extremo.

## PMA de tuberías (automática y editable)
- **Acero al carbono:** ASTM A106 Gr. B, S = 137,9 MPa (hasta 204 °C).
- **Acero inoxidable:** ASTM A312 TP316L, S = 115,1 MPa (hasta 150 °C).
- **Fórmula para acero (ASME B31.3 ec. 3a):** P = 2·S·E·W·t/(D − 2·Y·t), con E = W = 1, Y = 0,4 y t = 0,875·e − c. Sobreespesor c por defecto: 1 mm en carbono y 0 en inoxidable.
- **PVC-U:** PMA = PN × fT según EN ISO 1452-2 anexo A (≤25 °C: 1; ≤35 °C: 0,8; ≤45 °C: 0,63).
- **PE:** PMA = PN × fT según EN 12201-1 anexo A (20 °C: 1; 30 °C: 0,87; 40 °C: 0,74).
- **Otros materiales:** CPVC, PP-R, PVDF, PP-H, cobre, fundición y hormigón no tienen PMA automática; se introduce a mano y, si falta, se genera un aviso.
- **Criterios:**
  - p de servicio > PMA → fallo.
  - p con la bomba contra válvula cerrada (Hs + H0) > PMA → aviso.
  - p absoluta < pv en cualquier nodo → fallo (vaporización).

## Golpe de ariete (aviso)
- Celeridad (Korteweg): a = √[(Kf/ρ)/(1 + Kf·D/(E·e))].
- Tiempo crítico: Tc = 2L/a, con L = longitud de tuberías de la línea.
- Cierre rápido (tc ≤ Tc): Joukowsky, Δp = ρ·a·V. Cierre lento: Michaud, Δp = 2ρLV/tc.
- El tiempo de cierre se indica en los datos del proyecto; si se deja vacío, el cierre se considera instantáneo.
- Si p + Δp > PMA se genera un aviso.
- Valores orientativos de E (MPa): acero al carbono 207 000, inoxidable 193 000, PVC 3000, PE100 1100, PE80 900, CPVC 2900, PP-R 900, PVDF 1800, PP-H 1300, cobre 117 000, fundición 170 000, hormigón 30 000.
- Kf de cada fluido: está en el catálogo (valores orientativos).

## Avisos de coherencia
- DN de un componente distinto del de la tubería conectada. En plásticos se compara por el diámetro exterior equivalente.
- Retención con el caudal en sentido contrario.
- Bomba con caudal inverso.

## Fluidos nuevos (generados con CoolProp)
- Agua de mar con S = 35 g/kg (Sharqawy/MIT). pv = 0,979·pv del agua.
- MEG y MPG al 20, 30 y 40 % en masa (Melinder, IIR 2010). La tabla empieza cerca del punto de congelación. pv por la ley de Raoult.

## Herramientas
- **Herramientas > Dimensionar tuberías:**
  - elige el menor tamaño de la misma serie que cumple V ≤ Vmax del lado correspondiente, y recalcula iterativamente;
  - los componentes contiguos de la línea siguen a su tubería y las reducciones se ajustan (con aviso si dejan de reducir);
  - muestra la propuesta antes de aplicarla y se puede deshacer.
- **Informe > Listados (*.xlsx):** hojas Líneas, Válvulas (incluye las válvulas de equilibrado propuestas), Materiales (metros por material/serie/DN y unidades de accesorios) y Equipos y consumos. Usa SheetJS desde jsDelivr.

## Uso
- **Autoguardado:** copia de trabajo en el navegador 2 s después de cada cambio y cada 30 s. Al abrir la app ofrece recuperarla. Se borra al guardar el .pid, al abrir un archivo o al crear un proyecto nuevo.
- **Selección múltiple:**
  - Ctrl o Mayús + clic;
  - arrastrar sobre una zona vacía para seleccionar por ventana;
  - menú Seleccionar: Todo (Ctrl+A), Nada (Esc), por Línea y Girar;
  - el grupo se mueve arrastrando y gira de forma rígida;
  - copiar, cortar y pegar en grupo; Supr elimina.
- **Opciones > Unidades:** presión en bar, kPa o m c.a. (1 m c.a. = 9806,65 Pa) y caudal en m³/h o l/s. Afecta al panel, a las ventanas de inserción, al contorno, a los resultados y al tooltip. El informe y los listados siguen en bar y m³/h.

## Pendiente
- Curvas de bomba en PDF.
- Cajetín del plano y logo de la empresa (más adelante).
