# PIPING 8.48 · bloque A de la lista PIPING_151020261252 (edición 2D/3D)

Entregado en C:\Users\jaman\Documents\PROYECTOS\PIPING (index.html, js/piping.js y css/piping.css). La versión anterior queda en copias\v847. md5 verificado.

## Plan acordado con José (15/10/2026)
- **A (8.48):** puntos 2, 3, 5-6, 9, 13-14, 22, 26, 27, 31.1, 35-36, 38-39, 42-47 y 50.
- **B:** materiales y librería: 4, 16, 29, 30, 32, 33 y 34.
- **C:** informes, precios y bombas: 12, 23, 24 y 25.
- **D:** 3D: 15 (bomba centrífuga horizontal por defecto), 28, 37 y 41.
- **E:** Supabase con el usuario y la contraseña de la app (cada usuario con su cuenta de Supabase Auth; la clave anon, una vez por instalación), copias diarias, trabajo sin conexión, DXF/DWG y tablet.
- **F:** visor CAD aparte.

### Decisiones
- **Punto 9:** una tubería con desnivel se dibuja con línea de trazo y punto.
- **Punto 15:** la bomba del 3D es centrífuga horizontal.
- **Puntos 1 y 10:** se entra con el usuario y la contraseña de la app.

## Hecho en 8.48
- **2.** El panel de la selección múltiple tiene Girar −90° y «Escalar...». La escala se aplica al dibujo, respecto al centro de la selección (`escalarSeleccion`); las longitudes reales no cambian. Ctrl+A, mover y girar ya existían.
- **3.** Material de los componentes según la norma del elemento: con ASME solo aparecen materiales ASME, y con EN solo EN.
  - La norma sale de `normaPN`, del material elegido o del tubo vecino (`sistemaMaterialDe`).
  - En redes de acero solo aparecen aceros al carbono e inoxidables: fuera fundiciones, bronces y plásticos (`familiaMatTexto`).
- **5-6.** Nombres por defecto de los archivos:
  - proyecto (pid, json, xml): `NÚMERO_INSTALACIÓN_RevX`;
  - planos (dxf, svg, png): `NÚMERO-PLANO-Hhoja_RevX`;
  - PDF de varias hojas: `NÚMERO-PLANO-H00a03_RevX`.
- **9.** Una tubería con cota A distinta de la cota B se dibuja en 2D con trazo y punto (7, 2, 1,6, 2).
- **13.** El árbol del 3D no lleva recuadro: va sobre el mismo lienzo, con halo del color del fondo. En fondo oscuro, el texto es claro.
- **14.** Brújula SVG en la esquina superior izquierda del 3D, solo en instalaciones en tierra. Indica el norte proyectado y se arrastra para girarlo (ajuste a 5°; Mayús sin ajuste). Guarda el valor en `proyecto.norte` y redibuja la flecha N de la escena. El árbol baja 88 px para dejarle sitio.
- **22.** Alt+1 alterna 2D → isométrico → 3D → 2D.
- **26.** La tabla de propiedades solo muestra las pestañas de los tipos que existen en la hoja y abre en uno que exista.
- **27.** La repetición de la última orden funciona con Intro y con Espacio. Ya era así; solo se ha comprobado.
- **31.1.** Se quitan la línea y el rótulo «Eje del timón».
- **35.** Cubo de vistas en SVG: cada cara se proyecta en ortogonal y el texto lleva una transformación afín, así que es vectorial y nítido. Mantiene las 9 zonas por cara (26 vistas), el resaltado, el clic, el arrastre, la casita y el menú ▾. Sustituye al cubo CSS 3D de la 8.46.
- **36.** En el 3D, Ajustes › «Mover toda la red ΔX ΔY ΔZ (mm)» (`moverTodo3D`): desplaza el origen y los componentes sueltos (pos3D). El origen de la red se usa ahora también en industria.
- **38/39.** Al eliminar un componente intermedio en línea (dos conexiones opuestas), lo que va detrás se desplaza y se une al anterior (`cerrarHuecoAlEliminar`). No se cierra el hueco si hay malla ni en codos o tes. En el 3D ya no «desaparece» lo posterior.
- **42.** Al pegar líneas copiadas enteras se crean líneas nuevas (siguiente P / R) y nomenclatura nueva. Por ejemplo, VB01-P01 pegada pasa a VB02-P03.
- **43.** «Renombrar...» en el menú del componente (`renombrarElemento`, `el.tagManual`). Su número queda libre en `proyecto.numLibres` y lo toma el siguiente componente igual que se inserte. Si el nombre se deja vacío, vuelve a la nomenclatura automática.
- **44/45.** Vista › Mostrar la leyenda / el listado de materiales / la nomenclatura de los componentes. Lo que se oculta no sale ni en pantalla ni al imprimir.
- **46.** Zoom con la rueda multiplicativo (×1,15), entre 0,05 y 60; zoom ventana hasta 60; Ajustar hasta 12.
- **47.** Las ventanas de resultados (modal-red) y la tabla de propiedades se arrastran por el título y no bloquean el plano. Datos del proyecto también se arrastra. Cada ventana recuerda su posición (`hacerMovible`).

## Pendiente
- **50.** Bomba Pedrollo CPM 158 a 2 m³/h y 20 m c.l. marcada como errónea. Se ha pedido a José el .pid o el mensaje exacto del error.
- **4.** Hay que pedir de nuevo la foto «pipe fittings common types» del 7/10/2026 a las 19:43: no está entre los adjuntos.

## Pruebas
- **test48 (nuevo):** renombrar y reutilizar el número; eliminar cerrando el hueco; pegar con líneas nuevas; escalar; ocultar; trazo de desnivel; materiales EN/ASME; nombres de archivo; zoom 60; Alt+1; tabla; cubo SVG (27 zonas y 3 textos); brújula (norte 40°); mover todo (+1000 / −500 / +200).
- **test46:** adaptado al cubo SVG.
- **Regresión:** cambian solo cosas previstas: «Renombrar...» en el menú, materiales filtrados (test14 OPTS 18 → 7) y la posición del árbol en 3D.
