// PIPING 8.4 · Diseño P&ID y cálculo de redes de tuberías · José A. Manteiga
// Código de la aplicación (antes dentro de index.html). Lo carga index.html con <script src>.
        // ---- carga por partes (v8.7): el empaquetado saca de este archivo el informe, CAD/PDF/Excel, administración/nube y herramientas ----
        const PARTES_LISTA = ["informe","cad","admin","herr"];
        const PARTES_OK = {}, CARGAS_PARTE = {};
        function cargarParte(g, silencio) {
            if (PARTES_OK[g] || typeof PARTES_LISTA === 'undefined') return Promise.resolve();
            if (!CARGAS_PARTE[g]) CARGAS_PARTE[g] = new Promise((ok, ko) => {
                const sc = document.createElement('script'); sc.src = `js/partes/${g}.js?v=${VERSION_WEB}`;
                sc.onload = () => PARTES_OK[g] ? ok() : ko(new Error('parte ' + g));
                sc.onerror = () => { delete CARGAS_PARTE[g]; if (!silencio) aviso(`No se ha podido cargar una parte del programa (js/partes/${g}.js). Comprueba la conexión y vuelve a intentarlo.`, 'error'); ko(new Error('parte ' + g)); };
                document.head.appendChild(sc);
            });
            return CARGAS_PARTE[g];
        }
        async function cargarTodasLasPartes() { if (typeof PARTES_LISTA === 'undefined') return; for (const g of PARTES_LISTA) { try { await cargarParte(g, true); } catch (e) { /* se reintenta al usarla */ } await new Promise(r => setTimeout(r, 250)); } }
        let elementosRed = [];
        let idioma = (() => { try { const l = localStorage.getItem('piping-idioma'); return ['es', 'en', 'pt', 'ko'].includes(l) ? l : 'es'; } catch (e) { return 'es'; } })(); // Opciones > Idioma
        let planoCongelado = false; // hoja congelada (botón derecho en el lienzo > Congelar plano)
        let hojas = [{ id: '00' }], hojaActual = 0; // hojas del proyecto (ver HOJAS DEL PROYECTO)
        let idSeleccionado = null;
        let anchoArbol = 270; // ancho del árbol de especificación (px)
        let idMenuContextual = null;
        let zoomScale = 1.0;
        let currentFileHandle = null;

        let isDraggingSymbol = false;
        const seleccion = new Set(); // selección múltiple (Ctrl/Mayús + clic o ventana sobre el lienzo)
        let arrastreGrupo = false;
        let activeSymbolId = null;
        let dragStartX = 0, dragStartY = 0;
        let desenganchado = false;
        let arrastreMovido = false;

        let modoZoomVentana = false;
        let isSelectingZoom = false;
        let zoomStartX = 0, zoomStartY = 0;

        // Historial de Deshacer/Rehacer: snapshots JSON de elementosRed. guardarEstado() se llama
        // SIEMPRE antes de mutar elementosRed (no después), para que el snapshot guardado sea el
        // estado previo a la acción que se quiere poder deshacer.
        let historialUndo = [];
        let historialRedo = [];
        const MAX_HISTORIAL = 60;

        const instantanea = () => JSON.stringify({ e: elementosRed, l: lineas });
        function guardarEstado() {
            comprobarCongelado(); // plano congelado: se corta cualquier modificación
            historialUndo.push(instantanea());
            if (historialUndo.length > MAX_HISTORIAL) historialUndo.shift();
            historialRedo = []; // cualquier acción nueva invalida lo que se pudiera rehacer
            marcarCambios(true);
            actualizarBotonesHistorial();
        }

        function restaurarEstado(json) {
            const d = JSON.parse(json);
            if (Array.isArray(d)) { elementosRed = d; } else { elementosRed = d.e || []; lineas = d.l || []; }
            idSeleccionado = null;
            invalidarResultados();
            renderizarVectorial();
            if (typeof ventanaId !== 'undefined' && ventanaId) pintarVentana();
            const panel = document.getElementById("panel-propiedades");
            if (panel) panel.innerHTML = `<p class="text-slate-400 italic text-[10px]">Selecciona un elemento.</p>`;
            const lbl = document.getElementById("lbl-tipo-activo");
            if (lbl) lbl.innerText = "Ninguno";
        }

        function deshacer() {
            if (historialUndo.length === 0) return;
            if (planoCongelado) { avisarCongelado(); return; }
            historialRedo.push(instantanea());
            restaurarEstado(historialUndo.pop());
            marcarCambios(true);
            actualizarBotonesHistorial();
        }

        function rehacer() {
            if (historialRedo.length === 0) return;
            if (planoCongelado) { avisarCongelado(); return; }
            historialUndo.push(instantanea());
            restaurarEstado(historialRedo.pop());
            marcarCambios(true);
            actualizarBotonesHistorial();
        }

        function actualizarBotonesHistorial() {
            const btnU = document.getElementById('btn-deshacer');
            const btnR = document.getElementById('btn-rehacer');
            if (btnU) btnU.disabled = historialUndo.length === 0;
            if (btnR) btnR.disabled = historialRedo.length === 0;
        }

        // Resultados del último cálculo por elemento (no se guardan en el .pid). Cualquier cambio en la
        // red los invalida: vuelven los colores normales hasta el siguiente "Calcular red".
        let ultimoResultado = null;
        let ultimoCalculo = null; // { resultado, condiciones, huella } para el informe
        let ultimoResultadoPrevio = null; // último resultado antes de un cambio (para proponer DN al insertar)
        function invalidarResultados() {
            if (ultimoResultado) ultimoResultadoPrevio = ultimoResultado;
            ultimoResultado = null; ultimoCalculo = null;
            elementosRed.forEach(e => { e.estado = null; e.esLineaCritica = false; });
            if (typeof programarCalculoAuto === 'function') programarCalculoAuto();
            if (typeof actualizarPanelAvisos === 'function') actualizarPanelAvisos();
        }

        // Condiciones de contorno de la red (cota/presión en extremos abiertos), indexadas por "elId:portId"
        let condicionesContorno = {};

        // Lienzo infinito con convenio CAD: el.x/el.y son coordenadas de MUNDO con origen (0,0) en la
        // esquina inferior izquierda del lienzo y el eje Y creciendo hacia ARRIBA (como AutoCAD/DXF).
        // El lienzo SVG interno sigue dibujándose en píxeles de pantalla (Y hacia abajo, origen arriba),
        // así que la conversión mundo↔pantalla se hace en un único punto: mundoAScreenY().
        // Esto no afecta a la geometría relativa (rotación, imantado/snapping, motor de cálculo
        // hidráulico), que solo comparan distancias entre puertos y son indiferentes al sentido de Y.
        // Hoja A3 apaisada por defecto (420 x 297 mm; A4 en vertical) a 96 ppp: 1 unidad de dibujo = 1 px = 0,2646 mm en papel.
        // Solo se puede trabajar dentro de la hoja: ver limitarAHoja().
        // Tamaño de la hoja en unidades de dibujo: cambia con el formato (ver aplicarFormato)
        let ANCHO_A3 = 1587;
        let ALTO_A3 = 1123;
        const MARGEN_HOJA = 40; // px de fondo gris alrededor de la hoja
        let ALTO_MUNDO = ALTO_A3;
        function mundoAScreenY(y) { return ALTO_MUNDO - y; }
        const anchoArbolVisible = () => { try { return opciones.arbol ? anchoArbol + 10 : 0; } catch (e) { return 0; } };
        function screenAMundoY(sy) { return ALTO_MUNDO - sy; } // conversión inversa (misma fórmula, es una reflexión)

        // Muestra la hoja A3 completa, centrada en la ventana (también es el "Zoom Todo")
        function irAOrigenEnEsquina() {
            const cw = canvasContainer.clientWidth - 2 * MARGEN_HOJA - anchoArbolVisible();
            const ch = canvasContainer.clientHeight - 2 * MARGEN_HOJA;
            if (cw > 0 && ch > 0) zoomScale = Math.min(cw / ANCHO_A3, ch / ALTO_A3);
            aplicarZoom();
            canvasContainer.scrollLeft = 0;
            canvasContainer.scrollTop = 0;
        }

        // Posición de la hoja dentro del contenedor con scroll: centrada si cabe, con margen si no.
        // offX/offY son necesarios para pasar de coordenadas del contenedor a coordenadas de hoja.
        let offX = MARGEN_HOJA, offY = MARGEN_HOJA;
        function aplicarZoom() {
            const w = ANCHO_A3 * zoomScale, h = ALTO_A3 * zoomScale;
            const wA = anchoArbolVisible(); // la hoja se centra en el espacio que deja libre el árbol
            offX = Math.max(MARGEN_HOJA + wA, (canvasContainer.clientWidth - w + wA) / 2);
            offY = Math.max(MARGEN_HOJA, (canvasContainer.clientHeight - h) / 2);
            marcoA3.style.left = offX + 'px';
            marcoA3.style.top = offY + 'px';
            marcoA3.style.transform = `scale(${zoomScale})`;
            const esp = document.getElementById('lienzo-espaciador');
            esp.style.left = (offX + w + MARGEN_HOJA - 1) + 'px';
            esp.style.top = (offY + h + MARGEN_HOJA - 1) + 'px';
        }

        // Mantiene un elemento dentro de la hoja A3 (símbolo + etiqueta). Devuelve true si lo ha movido.
        function limitarAHoja(el) {
            // la mayoría de los elementos están lejos del borde: se descartan por geometría, sin medir el DOM
            // (medir obliga al navegador a recalcular la página en cada redibujo)
            if (el.type !== 'anotacion') {
                const b = cajaSimbolo(el), mg = el.type === 'tuberia' ? 6 : 28 * (el.scale || 1);
                if (b.x0 - mg > 0 && b.y0 - mg > 0 && b.x1 + mg < ANCHO_A3 && b.y1 + mg < ALTO_A3) return false;
            }
            const g = svgCanvas.querySelector(`g[data-id="${el.id}"]`);
            if (!g) return false;
            const rM = marcoA3.getBoundingClientRect();
            if (!rM.width) return false;
            const esc = rM.width / ANCHO_A3; // escala real en pantalla
            const r = g.getBoundingClientRect();
            const izq = (r.left - rM.left) / esc, der = (r.right - rM.left) / esc;
            const arr = (r.top - rM.top) / esc, aba = (r.bottom - rM.top) / esc;
            let dx = 0, dy = 0;
            if (der - izq <= ANCHO_A3) { if (izq < 0) dx = -izq; else if (der > ANCHO_A3) dx = ANCHO_A3 - der; }
            if (aba - arr <= ALTO_A3) { if (arr < 0) dy = -arr; else if (aba > ALTO_A3) dy = ALTO_A3 - aba; }
            if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return false;
            el.x += dx;
            el.y -= dy; // dy en pantalla (abajo +); en mundo Y-arriba se resta
            return true;
        }

        // ---- DATOS DE INGENIERÍA: se leen de catalogo.js (window.CATALOGO) ----
        // catalogo.js se genera desde las tablas revisadas de PIPING_corregido.docx y los catálogos de
        // DOCUMENTACION. Tiene la misma estructura que tendrán las tablas de Supabase, de modo que
        // conectar la base de datos solo cambiará DE DÓNDE se carga CATALOGO, no cómo se usa.
        const G = 9.81; // m/s²
        const PRESION_ATM = 101325; // Pa
        const CAT = window.CATALOGO || null;
        if (!CAT) alert('No se ha encontrado catalogo.js junto a index.html. Sin él no se pueden cargar fluidos, tuberías ni válvulas.');

        const MATERIAL_DEF = 'Acero al carbono';
        // Nombres de material de versiones anteriores -> catálogo actual
        const MIGRA_MATERIAL = {
            'Acero al Carbono': 'Acero al carbono', 'Acero Inoxidable': 'Acero inoxidable', 'PVC': 'PVC-U',
            'Cobre': 'Cobre (Dint ref. Sch 40)', 'Fundición': 'Fundición (Dint ref. Sch 40)', 'Hormigón': 'Hormigón (Dint ref. Sch 40)'
        };
        // Equivalencia habitual DN (acero) -> diámetro exterior de tubería plástica
        const DN_A_PLASTICO = { 15: 20, 20: 25, 25: 32, 32: 40, 40: 50, 50: 63, 65: 75, 80: 90, 100: 110, 125: 140, 150: 160,
                                200: 225, 250: 250, 300: 315, 350: 355, 400: 400, 450: 450, 500: 500 };
        const ACERO_TAM = CAT ? CAT.materiales[MATERIAL_DEF].tamanos : [];
        const LISTA_DN = ACERO_TAM.map(t => t.clave);                 // 'DN 6' ... 'DN 900'
        function dnNum(clave) { return parseInt(String(clave || '').replace(/[^0-9]/g, ''), 10) || 50; }
        function npsDeDN(clave) { const t = ACERO_TAM.find(x => x.clave === clave); return t ? t.nps : ''; }
        // Tamaño nominal: en pulgadas (NPS) con el DN entre paréntesis; las dimensiones siempre en mm
        function etiquetaDN(clave) { const n = npsDeDN(clave); return n ? `${pulgadasTxt(n)}" (${clave})` : clave; }
        function pulgadasTxt(nps) { return typeof pulgadas === 'function' ? pulgadas(nps) : nps; }
        const esAceroTubo = material => { const b = (CAT && CAT.materiales[material] && CAT.materiales[material].base) || material; return b === 'Acero al carbono' || b === 'Acero inoxidable'; };
        // Tamaño de tubería para mostrar: acero al carbono/inox en pulgadas; plásticos y resto con su clave (d63, DN...)
        function tamanoTubo(material, dn) { const n = npsDeDN(dn); return esAceroTubo(material) && n && !(CAT.materiales[material] || {}).sistema ? `${pulgadasTxt(n)}"` : dn; }

        // Diámetro interior de referencia de un DN: acero Sch 40 (o STD si no existe Sch 40), en mm
        function dintReferencia(clave) {
            const t = ACERO_TAM.find(x => x.clave === clave);
            if (!t) return 52.5;
            const e = t.e['40'] != null ? t.e['40'] : t.e['STD'];
            return t.od - 2 * e;
        }

        // Factor de fricción en turbulencia total f_T (Crane A-24). Fuera de tabla: Colebrook con ε = 0,045 mm.
        function fT(dn, Dmm) {
            const fila = CAT.ft.find(r => r[0] === dn);
            if (fila) return fila[1];
            if (dn < 15) return 0.027;
            const D = Dmm || dn;
            return 0.25 / Math.pow(Math.log10(0.045 / (3.7 * D)), 2);
        }

        // ---------- Tuberías ----------
        function materialDe(el) { return (CAT && CAT.materiales[el.material]) || CAT.materiales[MATERIAL_DEF]; }
        function normalizarTuberia(el) {
            if (!CAT) return;
            if (MIGRA_MATERIAL[el.material]) el.material = MIGRA_MATERIAL[el.material];
            if (!CAT.materiales[el.material]) el.material = MATERIAL_DEF;
            const m = CAT.materiales[el.material];
            if (!m.series.includes(el.serie)) el.serie = m.serieDef;
            let t = m.tamanos.find(x => x.clave === el.dn);
            if (!t && /^DN/.test(el.dn || '') && !/^DN/.test(m.tamanos[0].clave)) {
                // proyecto antiguo (DN de acero) pasado a material plástico: diámetro exterior equivalente
                const od = DN_A_PLASTICO[dnNum(el.dn)];
                t = m.tamanos.find(x => x.od === od);
                if (t) el.dn = t.clave;
            }
            if (!t || t.e[el.serie] == null) {
                // tamaño inexistente en esa serie: el más próximo (por diámetro exterior) que sí exista
                const odAct = t ? t.od : (ACERO_TAM.find(x => x.clave === el.dn) || { od: 60.3 }).od;
                const cand = m.tamanos.filter(x => x.e[el.serie] != null);
                cand.sort((a, b) => Math.abs(a.od - odAct) - Math.abs(b.od - odAct));
                if (cand.length) el.dn = cand[0].clave;
            }
        }
        function datosTuberia(el) {
            const m = materialDe(el);
            const t = m.tamanos.find(x => x.clave === el.dn) || m.tamanos[0];
            const e = t.e[el.serie] != null ? t.e[el.serie] : Object.values(t.e)[0];
            return { od: t.od, e, Dint: t.od - 2 * e, rug: m.rug, norma: m.norma, nps: t.nps, ref: !!m.ref };
        }
        // Presión máxima admisible (bar man.) de una tubería a la temperatura T (°C).
        //  - Valor del usuario (pmaManual) si lo hay.
        //  - PVC-U: PN de la serie × factor de temperatura EN ISO 1452-2 anexo A (≤25 °C 1; ≤35 °C 0,8; ≤45 °C 0,63).
        //  - PE80/PE100: PN de la serie × factor EN 12201-1 anexo A (20 °C 1; 30 °C 0,87; 40 °C 0,74).
        //  - Acero al carbono (A106 Gr. B, S = 137,9 MPa) e inoxidable (A312 TP316L, S = 115 MPa): ASME B31.3
        //    ec. (3a) P = 2·S·E·W·t/(D − 2·Y·t), E = 1, W = 1, Y = 0,4, t = 0,875·e − c (c = sobreespesor).
        //  - Resto de materiales: sin dato (lo introduce el usuario).
        const S_ADM = { 'Acero al carbono': { S: 137.9, Tmax: 204, mat: 'ASTM A106 Gr. B', c: 1.0 }, 'Acero al carbono EN': { S: 150, Tmax: 204, mat: 'P235GH', c: 1.0 }, 'Acero inoxidable': { S: 115.1, Tmax: 150, mat: 'ASTM A312 TP316L', c: 0 } };
        function pmaTuberia(el, T) {
            if (+el.pmaManual > 0) return { pma: +el.pmaManual, origen: 'dato del usuario' };
            const dt = datosTuberia(el);
            let sa = S_ADM[el.material];
            if (sa && el.gradoMaterial && S_GRADO[el.gradoMaterial]) sa = Object.assign({}, sa, { S: S_GRADO[el.gradoMaterial], mat: el.gradoMaterial });
            if (sa) {
                if (T > sa.Tmax) return { pma: null, origen: `T > ${sa.Tmax} °C: introduce la PMA` };
                const c = el.sobreespesor != null && !isNaN(+el.sobreespesor) ? +el.sobreespesor : sa.c;
                const t = 0.875 * dt.e - c;
                if (t <= 0) return { pma: 0, origen: 'espesor útil nulo (tolerancia + sobreespesor)' };
                const P = 2 * sa.S * t / (dt.od - 2 * 0.4 * t); // MPa
                return { pma: P * 10, origen: `ASME B31.3 (${sa.mat}, S ${sa.S} MPa, c ${c} mm)`, t, c, S: sa.S };
            }
            const pnM = String(el.serie || '').match(/PN\s*([0-9.]+)/), mb = matBase(el.material);
            if (pnM && /^(PVC-U|PE100|PE80)$/.test(mb)) {
                const PN = parseFloat(pnM[1]);
                let f = null;
                if (mb === 'PVC-U') f = T <= 25 ? 1 : T <= 35 ? 0.8 : T <= 45 ? 0.63 : null;
                else f = T <= 20 ? 1 : T <= 30 ? 1 - 0.013 * (T - 20) : T <= 40 ? 0.87 - 0.013 * (T - 30) : null;
                if (f == null) return { pma: null, origen: `fuera del rango de temperatura de la norma: introduce la PMA` };
                return { pma: PN * f, origen: `PN ${PN} × ${f.toFixed(2)} (${mb === 'PVC-U' ? 'EN ISO 1452-2' : 'EN 12201-1'}, ${T} °C)`, PN, fT: f };
            }
            return { pma: null, origen: 'sin dato: introduce la PMA' };
        }
        function etiquetaTuberia(el) {
            const s = String(el.serie || '').replace(/ \(.*\)/, '');
            return /^DN/.test(el.dn) ? `${tamanoTubo(el.material, el.dn)} ${/^[0-9]+S?$/.test(s) ? 'Sch ' + s : s}` : `${el.dn} ${s}`;
        }

        // ---------- Fluidos ----------
        const MIGRA_FLUIDO = {
            'Agua (20°C)': { nombre: 'Agua', T: 20 },
            'Aceite Térmico': { nombre: 'Aceite hidráulico ISO VG 46', T: 40, aviso: 'El fluido "Aceite Térmico" ya no existe: se ha sustituido por "Aceite hidráulico ISO VG 46" a 40 °C.' },
            'Vapor Saturado': { nombre: 'Agua', T: 20, aviso: 'El vapor saturado ya no se calcula (necesita flujo compresible): se ha sustituido por agua a 20 °C.' }
        };
        // Interpolación en la tabla del fluido: lineal para ρ, logarítmica para ν y pv (varían de forma exponencial).
        // Fuera del rango tabulado no se extrapola: ok = false y el cálculo no se ejecuta.
        function propiedadesFluido(nombre, T) {
            const f = CAT && CAT.fluidos[nombre];
            if (!f) return { ok: false, msg: `Fluido "${nombre}" no encontrado en el catálogo.` };
            const tab = f.tabla, Tmin = tab[0][0], Tmax = tab[tab.length - 1][0];
            if (!(T >= Tmin && T <= Tmax)) return { ok: false, Tmin, Tmax, msg: `${nombre}: la temperatura ${T} °C está fuera del rango de datos (${Tmin} a ${Tmax} °C). No se extrapola.` };
            let i = 0; while (i < tab.length - 2 && T > tab[i + 1][0]) i++;
            const a = tab[i], b = tab[i + 1], x = (b[0] === a[0]) ? 0 : (T - a[0]) / (b[0] - a[0]);
            const lin = (p, q) => p + (q - p) * x;
            const lg = (p, q) => (p > 0 && q > 0) ? Math.exp(Math.log(p) + (Math.log(q) - Math.log(p)) * x) : lin(p, q);
            const rho = lin(a[1], b[1]), nu = lg(a[2], b[2]) * 1e-6, pv = lg(a[3], b[3]) * 1000;
            return { ok: true, nombre, T, rho, nu, mu: nu * rho, pv, Tmin, Tmax, nota: f.nota };
        }
        function fluidoSeleccionado() {
            const nombre = document.getElementById('selector-fluido').value;
            const T = parseFloat(document.getElementById('temp-fluido').value);
            return propiedadesFluido(nombre, T);
        }
        function actualizarInfoFluido() {
            const info = document.getElementById('info-fluido');
            if (!info) return;
            const p = fluidoSeleccionado();
            info.innerHTML = p.ok
                ? `ρ ${p.rho.toFixed(1)} kg/m³ · ν ${(p.nu * 1e6).toPrecision(3)} mm²/s<br>pv ${(p.pv / 1000).toPrecision(3)} kPa · rango ${p.Tmin}…${p.Tmax} °C`
                : `<span class="text-rose-600">${p.msg || 'Datos no válidos'}</span>`;
        }

        // ---------- Coeficientes K ----------
        function opcionesCrane(clave) { return (CAT && CAT.crane[clave]) || []; }
        function nCrane(valor, dn) {
            if (typeof valor === 'number') return valor;
            if (valor === 'mariposa') return dn <= 200 ? 45 : (dn <= 350 ? 35 : 25);
            if (valor === 'basc5') return dn <= 200 ? 40 : (dn <= 350 ? 30 : 20);
            if (valor === 'basc15') return dn <= 200 ? 120 : (dn <= 350 ? 90 : 60);
            return 0;
        }
        function entradaCrane(el) {
            const ops = opcionesCrane(claveCrane(el));
            return ops.find(o => o[0] === el.craneTipo) || ops[0] || null;
        }
        function kDeEntradaCrane(ent, dn, Dmm) {
            if (!ent) return { K: 0, origen: 'Crane (sin dato)' };
            if (ent[1] && ent[1].calc === 'bolaRed') {
                const f = fT(dn, Dmm), b = 0.8, b2 = 1 - b * b, K = (3 * f + Math.sin(15 * Math.PI / 180) * (0.8 * b2 + 2.6 * b2 * b2)) / Math.pow(b, 4);
                return { K, origen: `Crane fórm. 6 (${ent[0]})` };
            }
            if (ent[1] && ent[1].pedirCv) return { K: 0, origen: 'falta el Cv del fabricante', aviso: 'Válvula de doble clapeta: introduce el Cv del fabricante.' };
            if (ent[1] && typeof ent[1] === 'object') return { K: ent[1].K, origen: ent[0] };
            const n = nCrane(ent[1], dn);
            return { K: n * fT(dn, Dmm), origen: `Crane ${n}·fT (${ent[0]})` };
        }
        function seriesValvula(el) {
            if (!CAT || el.type !== 'valvula') return [];
            const tipos = el.subtype === 'neumatica' ? ['bola', 'mariposa', 'globo'] : [el.subtype];
            const nps = npsDeDN(el.dn);
            return CAT.valvulas.filter(v => tipos.includes(v.tipo) && v.cv[nps] != null);
        }
        const kDesdeCv = (cv, Dmm) => 891 * Math.pow(Dmm / 25.4, 4) / (cv * cv);
        // Válvula de control: Kv a la apertura h (0–1). Lineal Kv = Kvs·h; isoporcentual Kv = Kvs·R^(h−1), R = 50
        function kvApertura(el) {
            const kvs = +el.kvs, h = Math.min(Math.max((+el.apertura || 0) / 100, 0.02), 1);
            if (!(kvs > 0)) return 0;
            return el.caracteristica === 'lineal' ? kvs * h : kvs * Math.pow(50, h - 1);
        }
        // K de válvulas y accesorios de dos puertos para un diámetro interior D (mm).
        // Devuelve { K, origen, aviso }
        function kElemento(el, Dmm) {
            const dn = dnNum(el.dn);
            if (calcDe(el) === 'cero') return { K: 0, origen: 'Despreciable (K = 0)' };
            if (el.modoK === 'manual') return { K: +el.k || 0, origen: 'K del usuario' };
            if (el.modoK === 'kvs') {
                const kv = kvApertura(el);
                if (!(kv > 0)) return { K: 0, origen: 'Kvs sin definir', aviso: `${tagDe(el)}: falta el Kvs de la válvula de control.` };
                return { K: kDesdeCv(1.156 * kv, Dmm), origen: `Kvs ${el.kvs} · ${el.caracteristica === 'lineal' ? 'lineal' : 'isoporcentual'} · apertura ${el.apertura} % → Kv ${kv.toFixed(2)}` };
            }
            if (el.modoK === 'cv') {
                if (+el.cvUsuario > 0) return { K: kDesdeCv(+el.cvUsuario, Dmm), origen: `Cv ${el.cvUsuario} del usuario` };
                return { K: 0, origen: 'Cv sin definir', aviso: `${tagDe(el)}: falta el Cv; se toma K = 0.` };
            }
            if (el.type === 'valvula' && el.modoK === 'catalogo') {
                const s = CAT.valvulas.find(v => v.nombre === el.serieCat);
                const cv = s ? s.cv[npsDeDN(el.dn)] : null;
                if (cv) return { K: kDesdeCv(cv, Dmm), origen: `Cv ${cv} (${s.nombre.split(' · ').slice(0, 2).join(' ')})` };
                const r = kDeEntradaCrane(entradaCrane(el), dn, Dmm);
                return { K: r.K, origen: r.origen, aviso: `${tagDe(el)}: la serie de catálogo no tiene ${el.dn}; se usa el K de Crane.` };
            }
            return kDeEntradaCrane(entradaCrane(el), dn, Dmm);
        }
        // Te, cruce e injerto: K de paso directo y de derivación. Se reparten en ramas desde un nodo
        // central: ramas a y b = K_run/2; ramas de derivación (c, d) = K_der − K_run/2.
        // Te y cruce: Crane 20·fT / 60·fT. Injerto: paso directo 0 (es la propia tubería) y 60·fT.
        function kTee(el) {
            const dn = dnNum(el.dn);
            if (el.modoK === 'manual') return { run: +el.kRun || 0, der: +el.kBranch || 0, origen: 'K del usuario' };
            const f = fT(dn, dintReferencia(el.dn));
            if (el.subtype === 'injerto') return { run: 0, der: 60 * f, origen: 'Crane 60·fT derivación' };
            return { run: 20 * f, der: 60 * f, origen: 'Crane 20·fT / 60·fT' };
        }
        // Reducción (Crane, fórmulas 1–4): K referido al diámetro menor. θ de ASME B16.9 si existe.
        function thetaReduccion(el) {
            const r = CAT && CAT.reducciones[`${dnNum(el.dn)}-${dnNum(el.dnMenor)}`];
            if (r && !el.thetaManual) return { theta: r.theta, H: r.H, fuente: 'ASME B16.9' };
            return { theta: +el.theta || 30, H: null, fuente: 'manual' };
        }
        function kReduccion(el, D1, D2) {
            const th = thetaReduccion(el).theta;
            const beta = Math.min(D2 / D1, 1);
            const s = Math.sin(th * Math.PI / 360), b2 = 1 - beta * beta;
            const kc = th <= 45 ? 0.8 * s * b2 : 0.5 * b2 * Math.sqrt(s);
            const ke = th <= 45 ? 2.6 * s * b2 * b2 : b2 * b2;
            return { kc, ke, theta: th, beta };
        }
        // Valores por defecto de la librería en versiones anteriores: si un elemento antiguo conserva
        // ese valor, se pasa a K automático; si el usuario lo cambió, se respeta como K manual.
        const K_LIBRERIA_ANTIGUA = { codo: 0.75, tee: 0.9, union: 0.05, bola: 0.05, compuerta: 0.2, globo: 6.0, mariposa: 0.5, neumatica: 0.3, retencion: 2.0 };

        // ==================================================================================
        // BIBLIOTECA DE COMPONENTES
        // Un único registro por subtipo con: código de la nomenclatura, categoría de la librería,
        // puertos imantados (coordenadas locales del símbolo 50×50) y forma de cálculo:
        //   crane     -> K = n·fT (o K fijo) de la tabla de Crane; admite catálogo/Cv/manual
        //   cero      -> K despreciable (bridas, manguitos, racores...)
        //   pedir     -> el K o el Cv los da el usuario al insertar (filtros, juntas, membrana, aguja)
        //   nodo      -> te, cruce, injerto: ramas desde un nodo central
        //   reduccion -> Crane fórmulas 1–4 con θ de B16.9
        //   sinflujo  -> sin caudal (instrumentos, PSV, alivio): no generan arista ni piden contorno
        // ==================================================================================
        // denominaciones de material de tubería de versiones anteriores → lista actual
        const GRADOS_ANTIGUOS = { 'SA-106 Gr. B': 'SA-106 Gr.B', 'SA-53 Gr. B (ERW)': 'SA-53 Gr.B', 'SA-53 Gr. B': 'SA-53 Gr.B', 'SA-333 Gr. 6 (baja temperatura)': 'SA-333 Gr.6', 'SA-333 Gr. 6': 'SA-333 Gr.6',
            'P235GH (EN 10216-2)': 'P235GH', 'P265GH (EN 10216-2)': 'P265GH', 'P235TR2 (EN 10217-1)': 'P235TR2',
            'SA-312 TP304': 'SA-312 Gr.Tp304', 'SA-312 TP304L': 'SA-312 Gr.Tp304L', 'SA-312 TP316': 'SA-312 Gr.Tp316', 'SA-312 TP316L': 'SA-312 Gr.Tp316L', 'SA-312 TP321': 'SA-312 Gr.Tp321', 'SA-358 TP316L (soldado)': 'SA-358',
            '1.4301 X5CrNi18-10 (EN 10216-5)': 'X5CrNi18-10/1.4301', '1.4401 X5CrNiMo17-12-2 (EN 10216-5)': 'X5CrNiMo17-12-2/1.4401', '1.4404 X2CrNiMo17-12-2 (EN 10216-5)': 'X2CrNiMo17-12-2/1.4404', '1.4541 X6CrNiTi18-10 (EN 10216-5)': 'X6CrNiTi18-10/1.4541' };
        const GRADO_NUEVO = g => GRADOS_ANTIGUOS[g] || g;
        const PA = { x: 10, y: 25, id: 'a' }, PB = { x: 40, y: 25, id: 'b' };
        // brida simple: el puerto a (cara de la brida) queda un poco a la izquierda del centro de la brida
        const PBR = { x: 25.5, y: 25, id: 'a' };
        function puertoAngulo(ang) { const r = ang * Math.PI / 180; return { x: +(25 + 15 * Math.cos(r)).toFixed(3), y: +(25 - 15 * Math.sin(r)).toFixed(3), id: 'b' }; }
        const P_INSTR = [{ x: 25, y: 45, id: 'a' }];
        const P_SEC_C = { x: 25, y: 5, id: 'c' }, P_SEC_D = { x: 25, y: 45, id: 'd' };
        const P_TANQUE = [{ x: 40, y: 25, id: 'b' }, { x: 22, y: 2, id: 'c' }];
        const TIPOS = {
            // --- accesorios ---
            continuacion:  { type: 'accesorio', codigo: 'CONT', nombre: 'Continuación entre hojas', cat: 'accesorios', calc: 'sinflujo', puertos: [PA] },
            codo90:        { type: 'accesorio', codigo: 'C90', nombre: 'Codo 90°', cat: 'accesorios', calc: 'crane', crane: 'codo', puertos: [{ x: 15, y: 35, id: 'a' }, { x: 35, y: 15, id: 'b' }] },
            codo45:        { type: 'accesorio', codigo: 'C45', nombre: 'Codo 45°', cat: 'accesorios', calc: 'crane', crane: 'codo45', puertos: [PA, puertoAngulo(45)] },
            codo60:        { type: 'accesorio', codigo: 'C60', nombre: 'Codo 60°', cat: 'accesorios', calc: 'crane', crane: 'codo60', puertos: [PA, puertoAngulo(60)] },
            tee:           { type: 'accesorio', codigo: 'TE', nombre: 'Te', cat: 'accesorios', calc: 'nodo', puertos: [PA, PB, { x: 25, y: 40, id: 'c' }] },
            cruce:         { type: 'accesorio', codigo: 'CR', nombre: 'Cruce', cat: 'accesorios', calc: 'nodo', puertos: [PA, PB, { x: 25, y: 40, id: 'c' }, { x: 25, y: 10, id: 'd' }] },
            injerto:       { type: 'accesorio', codigo: 'IN', nombre: 'Injerto', cat: 'accesorios', calc: 'nodo', puertos: [PA, PB, { x: 25, y: 10, id: 'c' }] },
            reduccion:     { type: 'accesorio', codigo: el => el.excentrica ? 'RE' : 'RC', nombre: 'Reducción', cat: 'accesorios', calc: 'reduccion', puertos: [PA, PB] },
            junta:         { type: 'accesorio', codigo: 'JE', nombre: 'Junta de expansión', cat: 'accesorios', calc: 'pedir', puertos: [PA, PB] },
            antivibratorio:{ type: 'accesorio', codigo: 'MAV', nombre: 'Manguito antivibratorio', cat: 'accesorios', calc: 'pedir', puertos: [PA, PB] },
            filtro:        { type: 'accesorio', codigo: 'FI', nombre: 'Filtro', cat: 'accesorios', calc: 'pedir', puertos: [PA, PB] },
            strainer:      { type: 'accesorio', codigo: 'ST', nombre: 'Strainer (rejilla)', cat: 'accesorios', calc: 'pedir', puertos: [PA, PB] },
            // --- uniones y bridas (K = 0) ---
            manguito:      { type: 'accesorio', codigo: 'MU', nombre: 'Manguito de unión', cat: 'uniones', calc: 'cero', puertos: [PA, PB] },
            tuerca:        { type: 'accesorio', codigo: 'TU', nombre: 'Tuerca de unión', cat: 'uniones', calc: 'cero', puertos: [PA, PB] },
            machon:        { type: 'accesorio', codigo: 'MA', nombre: 'Machón', cat: 'uniones', calc: 'cero', puertos: [PA, PB] },
            racor:         { type: 'accesorio', codigo: 'RA', nombre: 'Racord', cat: 'uniones', calc: 'cero', puertos: [PA, PB] },
            bridaunion:    { type: 'accesorio', codigo: 'BU', nombre: 'Brida unión', cat: 'uniones', calc: 'cero', puertos: [PBR, PB] },
            bridawn:       { type: 'accesorio', codigo: 'WN', nombre: 'Brida con cuello (WN)', cat: 'uniones', calc: 'cero', puertos: [PBR, PB] },
            bridaplana:    { type: 'accesorio', codigo: 'BP', nombre: 'Brida plana', cat: 'uniones', calc: 'cero', puertos: [PBR, PB] },
            bridaroscada:  { type: 'accesorio', codigo: 'BR', nombre: 'Brida roscada', cat: 'uniones', calc: 'cero', puertos: [PBR, PB] },
            bridaloca:     { type: 'accesorio', codigo: 'BL', nombre: 'Brida loca', cat: 'uniones', calc: 'cero', puertos: [PBR, PB] },
            bridaplastica: { type: 'accesorio', codigo: 'BPL', nombre: 'Brida plástica', cat: 'uniones', calc: 'cero', puertos: [PBR, PB] },
            bridaciega:    { type: 'accesorio', codigo: 'BC', nombre: 'Brida ciega', cat: 'uniones', calc: 'sinflujo', puertos: [PBR] },
            // --- válvulas ---
            bola:          { type: 'valvula', codigo: 'VB', nombre: 'Válvula de bola', cat: 'valvulas', calc: 'crane', puertos: [PA, PB] },
            compuerta:     { type: 'valvula', codigo: 'VC', nombre: 'Válvula de compuerta', cat: 'valvulas', calc: 'crane', puertos: [PA, PB] },
            globo:         { type: 'valvula', codigo: 'VG', nombre: 'Válvula de globo', cat: 'valvulas', calc: 'crane', puertos: [PA, PB] },
            mariposa:      { type: 'valvula', codigo: 'VM', nombre: 'Válvula de mariposa', cat: 'valvulas', calc: 'crane', puertos: [PA, PB] },
            membrana:      { type: 'valvula', codigo: 'VMB', nombre: 'Válvula de membrana', cat: 'valvulas', calc: 'pedir', crane: 'membrana', puertos: [PA, PB] },
            macho:         { type: 'valvula', codigo: 'VMA', nombre: 'Válvula macho', cat: 'valvulas', calc: 'crane', crane: 'macho', puertos: [PA, PB] },
            neumatica:     { type: 'valvula', codigo: 'VN', nombre: 'Válvula neumática', cat: 'valvulas', calc: 'crane', puertos: [PA, PB] },
            control:       { type: 'valvula', codigo: 'VCO', nombre: 'Válvula de control (regulación)', cat: 'valvulas', calc: 'crane', crane: 'globo', puertos: [PA, PB] },
            retencion:     { type: 'valvula', codigo: 'VR', nombre: 'Válvula de retención', cat: 'valvulas', calc: 'crane', puertos: [PA, PB] },
            tajadera:      { type: 'valvula', codigo: 'VT', nombre: 'Válvula de tajadera', cat: 'valvulas', calc: 'crane', puertos: [PA, PB] },
            aguja:         { type: 'valvula', codigo: 'VAG', nombre: 'Válvula de aguja', cat: 'valvulas', calc: 'pedir', puertos: [PA, PB] },
            seguridad:     { type: 'valvula', codigo: 'PSV', nombre: 'Válvula de seguridad', cat: 'valvulas', calc: 'sinflujo', puertos: [{ x: 25, y: 45, id: 'a' }, { x: 40, y: 25, id: 'b' }] },
            alivio:        { type: 'valvula', codigo: 'VAL', nombre: 'Válvula de alivio', cat: 'valvulas', calc: 'sinflujo', puertos: [{ x: 25, y: 45, id: 'a' }, { x: 40, y: 25, id: 'b' }] },
            // --- instrumentos (sin caudal, excluidos del cálculo) ---
            nota:          { type: 'anotacion', codigo: 'NOTA', nombre: 'Nota de texto', cat: 'anotaciones', calc: 'sinflujo', puertos: [] },
            leyenda:       { type: 'anotacion', codigo: 'LEY', nombre: 'Leyenda de componentes (automática)', cat: 'anotaciones', calc: 'sinflujo', puertos: [] },
            tabla:         { type: 'anotacion', codigo: 'TB', nombre: 'Tabla', cat: 'ninguna', calc: 'sinflujo', puertos: [] },
            materiales:    { type: 'anotacion', codigo: 'LST', nombre: 'Listado de componentes (automático)', cat: 'anotaciones', calc: 'sinflujo', puertos: [] },
            purgador:      { type: 'instrumento', codigo: 'PG', nombre: 'Purgador de aire', cat: 'instrumentos', calc: 'sinflujo', puertos: P_INSTR },
            drenaje:       { type: 'instrumento', codigo: 'DR', nombre: 'Drenaje / vaciado', cat: 'instrumentos', calc: 'sinflujo', puertos: [{ x: 25, y: 5, id: 'a' }] },
            vasoexp:       { type: 'instrumento', codigo: 'VE', nombre: 'Vaso de expansión', cat: 'instrumentos', calc: 'sinflujo', puertos: P_INSTR },
            tomapresion:   { type: 'instrumento', codigo: 'TP', nombre: 'Toma de presión', cat: 'instrumentos', calc: 'sinflujo', puertos: P_INSTR },
            manometro:     { type: 'instrumento', codigo: 'MAN', nombre: 'Manómetro', cat: 'instrumentos', calc: 'sinflujo', puertos: P_INSTR },
            vacuometro:    { type: 'instrumento', codigo: 'VAC', nombre: 'Vacuómetro', cat: 'instrumentos', calc: 'sinflujo', puertos: P_INSTR },
            portainstr:    { type: 'instrumento', codigo: 'PI', nombre: 'Portainstrumentos', cat: 'instrumentos', calc: 'sinflujo', puertos: P_INSTR },
            // --- equipos con pérdida de carga conocida (Δp a caudal nominal, dato del fabricante) ---
            intercambiador:{ type: 'equipo', codigo: 'IC', nombre: 'Intercambiador de calor (un circuito)', cat: 'intercambiadores', calc: 'equipo', puertos: [PA, PB] },
            enfriador:     { type: 'equipo', codigo: 'EF', nombre: 'Enfriador / cooler (un circuito)', cat: 'intercambiadores', calc: 'equipo', puertos: [PA, PB] },
            // intercambiadores de dos circuitos: primario a–b (horizontal) y secundario c–d (vertical)
            icplacas:      { type: 'equipo', codigo: 'ICP', nombre: 'Intercambiador de placas', cat: 'intercambiadores', calc: 'equipo', puertos: [PA, PB, P_SEC_C, P_SEC_D], circuitos: 2 },
            ictubos:       { type: 'equipo', codigo: 'ICT', nombre: 'Intercambiador de carcasa y tubos', cat: 'intercambiadores', calc: 'equipo', puertos: [PA, PB, P_SEC_C, P_SEC_D], circuitos: 2 },
            enfcentral:    { type: 'equipo', codigo: 'ECE', nombre: 'Enfriador central (agua salada / agua dulce)', cat: 'intercambiadores', calc: 'equipo', puertos: [PA, PB, P_SEC_C, P_SEC_D], circuitos: 2 },
            enfaceite:     { type: 'equipo', codigo: 'EAL', nombre: 'Enfriador de aceite lubricante', cat: 'intercambiadores', calc: 'equipo', puertos: [PA, PB, P_SEC_C, P_SEC_D], circuitos: 2 },
            enfcamisas:    { type: 'equipo', codigo: 'EAC', nombre: 'Enfriador de agua de camisas (AT)', cat: 'intercambiadores', calc: 'equipo', puertos: [PA, PB, P_SEC_C, P_SEC_D], circuitos: 2 },
            calfuel:       { type: 'equipo', codigo: 'CFO', nombre: 'Calentador de combustible', cat: 'intercambiadores', calc: 'equipo', puertos: [PA, PB, P_SEC_C, P_SEC_D], circuitos: 2 },
            enfriadora:    { type: 'equipo', codigo: 'ENF', nombre: 'Enfriadora (chiller)', cat: 'equipos', calc: 'equipo', puertos: [PA, PB] },
            fancoil:       { type: 'equipo', codigo: 'FC', nombre: 'Fan-coil / batería', cat: 'equipos', calc: 'equipo', puertos: [PA, PB] },
            equipo:        { type: 'equipo', codigo: 'EQ', nombre: 'Equipo genérico', cat: 'equipos', calc: 'equipo', puertos: [PA, PB] },
            // --- terminales de la red ---
            consumo:       { type: 'terminal', codigo: 'CON', nombre: 'Punto de consumo', cat: 'terminales', calc: 'consumo', puertos: [PA] },
            // tanques: salida lateral b (40,25) y entrada superior c; altura fija = lámina + presión
            deposito:      { type: 'terminal', codigo: 'DEP', nombre: 'Depósito genérico', cat: 'tanques', calc: 'deposito', puertos: P_TANQUE },
            tkalmacen:     { type: 'terminal', codigo: 'TKA', nombre: 'Tanque de almacén', cat: 'tanques', calc: 'deposito', puertos: P_TANQUE },
            tkdiario:      { type: 'terminal', codigo: 'TKD', nombre: 'Tanque de servicio diario', cat: 'tanques', calc: 'deposito', puertos: P_TANQUE },
            tksedim:       { type: 'terminal', codigo: 'TKS', nombre: 'Tanque de sedimentación', cat: 'tanques', calc: 'deposito', puertos: P_TANQUE },
            tkexp:         { type: 'terminal', codigo: 'TKE', nombre: 'Tanque de expansión', cat: 'tanques', calc: 'deposito', puertos: P_TANQUE },
            tkreboses:     { type: 'terminal', codigo: 'TKR', nombre: 'Tanque de reboses / lodos', cat: 'tanques', calc: 'deposito', puertos: P_TANQUE },
            tkagua:        { type: 'terminal', codigo: 'TKW', nombre: 'Tanque de agua dulce / aljibe', cat: 'tanques', calc: 'deposito', puertos: P_TANQUE },
            hidroforo:     { type: 'terminal', codigo: 'TKH', nombre: 'Tanque hidróforo (presurizado)', cat: 'tanques', calc: 'deposito', puertos: P_TANQUE }
        };
        // Subtipos de versiones anteriores
        const MIGRA_SUBTIPO = { codo: 'codo90', union: 'bridaunion' };
        const CATEGORIAS = [['tuberias', 'Tuberías'], ['accesorios', 'Accesorios'], ['valvulas', 'Válvulas'], ['instrumentos', 'Instrumentos'], ['bombas', 'Bombas'], ['equipos', 'Equipos'], ['compensadores', 'Filtros, injertos y juntas'], ['terminales', 'Consumos'], ['anotaciones', 'Anotaciones']];
        // Grupos que se muestran dentro de la categoría Accesorios de la librería

        // Tablas de Crane adicionales (se añaden al catálogo). Un valor numérico es el múltiplo n de
        // fT; un objeto {K} es un K fijo (no depende del DN).
        if (CAT) Object.assign(CAT.crane, {
            codo45: [['Codo 45° estándar (Crane)', 16], ['Inglete 45°', 15]],
            codo60: [['Codo 60° (estimado entre 45° y 90° LR)', 15], ['Inglete 60°', 25]],
            macho: [['Macho paso directo', 18], ['Macho 3 vías, paso directo', 30], ['Macho 3 vías, derivación', 90]],
            membrana: [['Zappe/ESDU tipo Weir (aprox.)', { K: 2.3 }], ['Zappe/ESDU paso recto (aprox.)', { K: 0.6 }]],
            cero: [['Despreciable (K = 0)', 0]]
        });
        // Subtipos de válvula adicionales
        if (CAT) {
            CAT.crane.bola.push(['Bola paso reducido (β 0,8; Crane fórm. 6, θ 30°)', { calc: 'bolaRed' }]);
            CAT.crane.mariposa.push(['Mariposa doble excéntrica (K de mariposa Crane)', 'mariposa'], ['Mariposa triple excéntrica (K de mariposa Crane)', 'mariposa']);
            CAT.crane.retencion.push(['Doble clapeta tipo wafer (dual plate): Cv del fabricante', { pedirCv: true }]);
        }
        // ---------- Presión nominal de componentes (orientativa) ----------
        // EN 1092-1: PN a ≤ 50 °C, reducción lineal hasta 0,9·PN a 100 °C y 0,8·PN a 150 °C.
        // ASME B16.5: grupo 1.1 (acero al carbono A105/WCB) y 2.2 (inox 316), a 38/50/100/150/200 °C.
        const TIPOS_CONEXION = ['Brida', 'Roscada', 'Soldada a tope', 'Soldada con manguito (socket)', 'Manguito / racor'];
        const PN_LISTA = ['PN 2.5', 'PN 6', 'PN 10', 'PN 16', 'PN 25', 'PN 40', 'PN 63', 'PN 100', 'PN 160', 'PN 250', 'PN 320', 'PN 400', '75#', '150#', '300#', '400#', '600#', '900#', '1500#', '2500#', '2000#', '3000#', '6000#', '9000#'];
        // PN / Rating: lo tienen las bridas, las válvulas, los equipos y los componentes embridados. Tubos, codos, tes, cruces, reducciones y uniones roscadas no.
        const SIN_RATING = new Set(['codo90', 'codo45', 'codo60', 'tee', 'cruce', 'reduccion', 'injerto', 'manguito', 'tuerca', 'machon', 'racor', 'continuacion']);
        function tieneRating(el) {
            if (!el) return false;
            const m = el.accModelo ? modeloAcc(el) : null;
            if (m) return !sinRatingAcc(m) && (!!String(m.props.ratings || '').trim() || !SIN_RATING.has(el.subtype));   // con modelo manda el modelo: los forjados B16.11 llevan clase
            return el.type === 'valvula' || el.type === 'equipo' || (el.type === 'accesorio' && !SIN_RATING.has(el.subtype));
        }
        // norma del componente: ASME (rating: 150#, 300#...) o EN (PN 10, PN 16...)
        function normaPN(el) {
            const m = el.accModelo ? modeloAcc(el) : null; if (m) return m.props.sistema === 'EN' ? 'EN' : 'ASME';
            if (/#$/.test(el.pn || '')) return 'ASME'; if (/^PN/.test(el.pn || '')) return 'EN';   // el PN / rating que ya tiene manda
            if (el.normaPN === 'ASME' || el.normaPN === 'EN') return el.normaPN;
            let tv = null; try { tv = tuboVecino(el); } catch (e) { }
            return tv && (tv.material === 'Acero al carbono' || tv.material === 'Acero inoxidable') ? 'ASME' : 'EN';
        }
        // equivalencias orientativas entre PN y rating (criterio de José): PN 16 ≈ 150#, PN 40 ≈ 300#, PN 63 / PN 100 ≈ 600#
        const EQUIV_PN = { 'PN 16': '150#', 'PN 40': '300#', 'PN 63': '600#', 'PN 100': '600#', '150#': 'PN 16', '300#': 'PN 40', '600#': 'PN 100' };
        const ETIQ_EQUIV = { '600#': 'PN 63 / PN 100' };
        const conEquiv = l => l.map(x => Array.isArray(x) ? x : [x, EQUIV_PN[x] ? `${x} (≈ ${ETIQ_EQUIV[x] || EQUIV_PN[x]})` : x]);
        const listaPN = el => conEquiv(PN_LISTA.filter(x => normaPN(el) === 'ASME' ? /#$/.test(x) && !/^(75|2000|3000|6000|9000)#$/.test(x) : /^PN/.test(x)));
        const NORMAS_PN = [['ASME', 'ASME (rating)'], ['EN', 'EN (PN)']];
        // tras cambiar la norma, el PN / rating tiene que ser de esa norma
        function ajustarPN(el) { if (!tieneRating(el) || (el.accModelo && modeloAcc(el))) return; const l = listaPN(el).map(x => x[0]); if (!l.includes(el.pn)) el.pn = normaPN(el) === 'ASME' ? '150#' : 'PN 16'; }
        // el usuario cambia la norma: el PN / rating pasa al habitual de esa norma
        function cambiarNormaPN(el, norma) { const eq = EQUIV_PN[el.pn]; el.normaPN = norma === 'ASME' ? 'ASME' : 'EN'; delete el.pn; if (eq && /#$/.test(eq) === (el.normaPN === 'ASME')) el.pn = eq; ajustarPN(el); }
        function nuevoCambiarNorma(norma) { const { el } = nuevoPendiente; leerModalNuevo(false); cambiarNormaPN(el, norma); pintarModalNuevo(); }
        // clases ASME: "150#" (antes "Clase 150")
        const PN_NUEVO = pn => typeof pn === 'string' ? pn.replace(/^\s*Clase\s*(\d+)\s*$/i, '$1#') : pn;
        const B165 = { T: [38, 50, 100, 150, 200],
            '1.1': { 150: [19.6, 19.2, 17.7, 15.8, 13.8], 300: [51.1, 50.1, 46.6, 45.1, 43.8], 600: [102.1, 100.2, 93.2, 90.2, 87.6], 900: [153.2, 150.4, 139.8, 135.2, 131.4] },
            '2.2': { 150: [19.0, 18.4, 16.2, 14.8, 13.7], 300: [49.6, 48.1, 42.2, 38.5, 35.7], 600: [99.3, 96.2, 84.4, 77.0, 71.3], 900: [148.9, 144.3, 126.6, 115.5, 107.0] } };
        function presionAdmisiblePN(pn, T, inox) {
            const t = PN_NUEVO(String(pn || '')), mp = t.match(/^PN\s*(\d+(?:\.\d+)?)/), mc = t.match(/^(\d+)\s*#$/);
            if (!mp && !mc) return null;
            const v = +(mp || mc)[1];
            if (mp) return v * (T <= 50 ? 1 : T <= 100 ? 1 - 0.1 * (T - 50) / 50 : T <= 150 ? 0.9 - 0.1 * (T - 100) / 50 : 0.8);
            // clases 400, 1500 y 2500: proporcionales a la clase 300 (así las tabula B16.5 a partir de la clase 300)
            const G = B165[inox ? '2.2' : '1.1'], tab = G[v] || ([400, 1500, 2500].includes(v) ? G[300].map(x => x * v / 300) : null); if (!tab) return null;
            const Ts = B165.T; if (T <= Ts[0]) return tab[0];
            for (let i = 1; i < Ts.length; i++) if (T <= Ts[i]) return tab[i - 1] + (tab[i] - tab[i - 1]) * (T - Ts[i - 1]) / (Ts[i] - Ts[i - 1]);
            return tab[tab.length - 1];
        }
        function claveCrane(el) {
            const t = TIPOS[el.subtype];
            if (!t) return el.subtype;
            if (t.calc === 'cero') return 'cero';
            return t.crane || el.subtype;
        }
        const calcDe = el => el.type === 'tuberia' ? 'tuberia' : el.type === 'bomba' ? 'bomba' : ((TIPOS[el.subtype] || {}).calc || 'crane');
        const esNodo = el => calcDe(el) === 'nodo';
        const esTerminal = el => el.type === 'terminal';
        const esAnotacion = el => el.type === 'anotacion';
        // Bombas de reserva (1+1): una bomba con reservaDe = id de la bomba de servicio a la que respalda.
        // Escenario normal: funcionan las de servicio; escenario 'reserva': cada reserva sustituye a la
        // suya (esa bomba de servicio se para). Una bomba parada es una válvula cerrada: sin caudal.
        let escenarioBombas = 'normal';
        function bombaEnMarcha(el) {
            if (el.type !== 'bomba') return true;
            if (el.reservaDe) return escenarioBombas === 'reserva' && elementosRed.some(e => e.id === el.reservaDe);
            if (escenarioBombas === 'reserva' && elementosRed.some(e => e.type === 'bomba' && e.reservaDe === el.id)) return false;
            return true;
        }
        const esDeposito = el => (TIPOS[el.subtype] || {}).calc === 'deposito';
        const dosCircuitos = el => (TIPOS[el.subtype] || {}).circuitos === 2;
        const esEquipo = el => el.type === 'equipo';
        const sinFlujo = el => calcDe(el) === 'sinflujo';

        // ==================================================================================
        // NOMENCLATURA Y LÍNEAS
        //   Tubo:        TAC01-P01-2-S10       (código+nº, línea, tamaño, serie)
        //   Componente:  VB01-R01-2 · RC01-P01-3x2 · BO01-P01
        //   Línea principal P01, P02...; ramal R01, R02...; subramal R01.01...
        // Contador por código en toda la red (cada etiqueta es única); se asigna al insertar y no se
        // reutiliza. Más de 99 elementos de un código -> pasa a 3 cifras.
        // ==================================================================================
        let lineas = []; // { id, tipo: 'principal'|'ramal', nombre, padre, desde }
        const CODIGO_MATERIAL = { 'Acero al carbono': 'TAC', 'Acero al carbono EN': 'TAC', 'Acero inoxidable': 'TAI', 'PVC-U': 'TPVC', 'PE100': 'TPE', 'PE80': 'TPE',
            'CPVC': 'TCPVC', 'PP-R': 'TPPR', 'PVDF': 'TPVDF', 'PP-H': 'TPPH',
            'Cobre (Dint ref. Sch 40)': 'TCU', 'Fundición (Dint ref. Sch 40)': 'TFD', 'Hormigón (Dint ref. Sch 40)': 'THM' };
        function codigoDe(el) {
            if (el.type === 'tuberia') return CODIGO_MATERIAL[el.material] || 'TAC';
            if (el.type === 'bomba') return 'BO';
            const t = TIPOS[el.subtype];
            if (!t) return 'X';
            return typeof t.codigo === 'function' ? t.codigo(el) : t.codigo;
        }
        function asignarNumero(el, lista = elementosRed.concat(elementosOtrasHojas())) {
            const c = codigoDe(el);
            if (el.codigo === c && el.num) return;
            el.codigo = c;
            el.num = 1 + Math.max(0, ...lista.filter(e => e.id !== el.id && e.codigo === c).map(e => e.num || 0));
        }
        const FRACCION = { '1/8': '⅛', '1/4': '¼', '3/8': '⅜', '1/2': '½', '3/4': '¾' };
        function pulgadas(nps) {
            if (!nps) return '';
            const m = String(nps).match(/^(\d+)-(\d\/\d)$/);
            if (m) return m[1] + (FRACCION[m[2]] || '.' + m[2]);
            return FRACCION[nps] || String(nps);
        }
        function tamanoTexto(el) {
            if (el.type === 'tuberia') { const dt = datosTuberia(el); return dt.nps ? pulgadas(dt.nps) : (materialDe(el).sistema === 'EN' ? 'DN' + dnNum(el.dn) : String(Math.round(dt.od))); }
            if (el.type === 'bomba' || el.type === 'instrumento' || el.type === 'anotacion') return '';
            if (el.subtype === 'reduccion') return `${pulgadas(npsDeDN(el.dn))}x${pulgadas(npsDeDN(el.dnMenor))}`;
            return pulgadas(npsDeDN(el.dn));
        }
        function serieTexto(el) {
            if (/^[\d.]+ mm$/.test(String(el.serie || ''))) return 'E' + parseFloat(el.serie);
            const s = String(el.serie || '').replace(/ \(.*\)/, '').replace(/\s+/g, '');
            return /^[0-9]+S?$/.test(s) ? 'S' + s : s;
        }
        function tagDe(el) {
            const n = String(el.num || 0).padStart(2, '0');
            if (el.type === 'anotacion') return (el.codigo || codigoDe(el)) + n;
            if (el.accModelo && typeof modeloAcc === 'function') { const m = modeloAcc(el); if (m) return [(m.props.cod || el.codigo || codigoDe(el)) + n, el.linea || '??', ...partesCodigoAcc(el, m)].join('-'); }
            if (el.type === 'tuberia' && el.gradoMaterial && typeof esTuboAceroNorma === 'function' && esTuboAceroNorma(el)) return [(el.codigo || codigoDe(el)) + n, el.linea || '??', ...partesCodigoTubo(el)].join('-');
            const partes = [(el.codigo || codigoDe(el)) + n, el.linea || '??', tamanoTexto(el)];
            if (el.type === 'tuberia') partes.push(serieTexto(el));
            return partes.filter(Boolean).join('-');
        }
        const lineaPorId = id => lineas.find(l => l.id === id);
        function siguienteLinea(tipo, padre) {
            if (tipo === 'principal') {
                const n = 1 + Math.max(0, ...todasLineas().filter(l => l.tipo === 'principal').map(l => parseInt(l.id.slice(1), 10) || 0));
                return 'P' + String(n).padStart(2, '0');
            }
            const lp = lineaPorId(padre);
            if (lp && lp.tipo === 'ramal') {
                const pref = lp.id + '.';
                const n = 1 + Math.max(0, ...todasLineas().filter(l => l.id.startsWith(pref) && !l.id.slice(pref.length).includes('.')).map(l => parseInt(l.id.slice(pref.length), 10) || 0));
                return pref + String(n).padStart(2, '0');
            }
            const n = 1 + Math.max(0, ...todasLineas().filter(l => l.tipo === 'ramal' && !l.id.includes('.')).map(l => parseInt(l.id.slice(1), 10) || 0));
            return 'R' + String(n).padStart(2, '0');
        }
        // Cota (m) del puerto de un elemento
        function cotaPuerto(el, pid) {
            if (el.type === 'tuberia') return pid === 'b' ? +el.cotaB || 0 : +el.cotaA || 0;
            if (esDeposito(el) && pid === 'c') return +el.cotaEntrada || 0;
            return +el.cota || 0;
        }
        // Elementos cuyos puertos coinciden con los de el (conexión real tras el imantado)
        function vecinosDe(el) {
            const mios = obtenerPuertosConexion(el), res = [];
            elementosRed.forEach(o => {
                if (o.id === el.id) return;
                obtenerPuertosConexion(o).forEach(po => mios.forEach(pm => {
                    if (Math.hypot(po.x - pm.x, po.y - pm.y) < 1) res.push({ otro: o, puertoOtro: po.id, puertoEl: pm.id });
                }));
            });
            return res;
        }

        const panelIzq = document.getElementById('panel-izq');
        const panelDer = document.getElementById('panel-der');
        const resizer1 = document.getElementById('resizer-1');
        const resizer2 = document.getElementById('resizer-2');
        const canvasContainer = document.getElementById('canvas-container');
        const marcoA3 = document.getElementById('marco-a3');
        const svgCanvas = document.getElementById('svg-canvas');
        const contextMenu = document.getElementById('context-menu');
        const modalEdicion = document.getElementById('modal-edicion');
        const zoomBox = document.getElementById('zoom-window-box');

        function initResizers() {
            resizer1.style.left = panelIzq.offsetWidth + 'px';
            resizer2.style.right = panelDer.offsetWidth + 'px';

            resizer1.onmousedown = function(e) {
                e.preventDefault();
                document.onmousemove = function(e) {
                    let newWidth = e.clientX;
                    if (newWidth >= 160 && newWidth <= 400) {
                        panelIzq.style.width = newWidth + 'px';
                        resizer1.style.left = newWidth + 'px';
                    }
                };
                document.onmouseup = function() { document.onmousemove = document.onmouseup = null; };
            };

            resizer2.onmousedown = function(e) {
                e.preventDefault();
                document.onmousemove = function(e) {
                    let newWidth = window.innerWidth - e.clientX;
                    if (newWidth >= 160 && newWidth <= 400) {
                        panelDer.style.width = newWidth + 'px';
                        resizer2.style.right = newWidth + 'px';
                    }
                };
                document.onmouseup = function() { document.onmousemove = document.onmouseup = null; };
            };
        }
        window.onload = function() {
            initResizers();
            iniciarSelectorFluido();
            aplicarLibreria();
            construirLibreria();
            aplicarFondo();
            renderArbol();
            aplicarFormato();
            irAOrigenEnEsquina();
            renderizarVectorial();
            new ResizeObserver(() => aplicarZoom()).observe(canvasContainer);
            setTimeout(pantallaInicio, 150);
        };

        function iniciarSelectorFluido() {
            const sel = document.getElementById('selector-fluido');
            if (!sel || !CAT) return;
            sel.innerHTML = Object.keys(CAT.fluidos).map(f => `<option>${f}</option>`).join('');
            sel.value = 'Agua';
            sel.addEventListener('change', () => { marcarCambios(true); actualizarInfoFluido(); invalidarResultados(); renderizarVectorial(); });
            const t = document.getElementById('temp-fluido');
            t.addEventListener('change', () => { marcarCambios(true); actualizarInfoFluido(); invalidarResultados(); renderizarVectorial(); });
            t.addEventListener('input', actualizarInfoFluido);
            actualizarInfoFluido();
        }

        function centrarVistaEnPunto(x, y) {
            canvasContainer.scrollLeft = offX + x * zoomScale - canvasContainer.clientWidth / 2;
            canvasContainer.scrollTop = offY + y * zoomScale - canvasContainer.clientHeight / 2;
        }

        canvasContainer.addEventListener('wheel', function(e) {
            e.preventDefault();
            const zoomIntensity = 0.1;
            const rect = canvasContainer.getBoundingClientRect();
            // Punto del lienzo bajo el cursor antes de cambiar el zoom (para zoom-al-cursor)
            const cursorEnContenedorX = e.clientX - rect.left + canvasContainer.scrollLeft;
            const cursorEnContenedorY = e.clientY - rect.top + canvasContainer.scrollTop;
            const puntoMundoX = (cursorEnContenedorX - offX) / zoomScale;
            const puntoMundoY = (cursorEnContenedorY - offY) / zoomScale;

            if (e.deltaY < 0) {
                zoomScale = Math.min(zoomScale + zoomIntensity, 3.0);
            } else {
                zoomScale = Math.max(zoomScale - zoomIntensity, 0.2);
            }
            aplicarZoom();

            // Reajustar el scroll para que el punto bajo el cursor no se desplace
            canvasContainer.scrollLeft = offX + puntoMundoX * zoomScale - (e.clientX - rect.left);
            canvasContainer.scrollTop = offY + puntoMundoY * zoomScale - (e.clientY - rect.top);
        }, { passive: false });

        window.addEventListener('keydown', function(e) {
            if (false) {
            } else if (e.key === 'Escape' && modoZoomVentana) {
                modoZoomVentana = false;
                isSelectingZoom = false;
                zoomBox.style.display = 'none';
                canvasContainer.style.cursor = 'default';
            }
        });

        function ajustarVistaVentana() {
            const containerWidth = canvasContainer.clientWidth;
            const containerHeight = canvasContainer.clientHeight;

            if (elementosRed.length === 0) {
                zoomScale = 1.0;
                aplicarZoom();
                irAOrigenEnEsquina();
                return;
            }

            // minX/maxX/minY/maxY están en coordenadas de MUNDO (Y hacia arriba)
            const margen = 80;
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            elementosRed.forEach(el => {
                minX = Math.min(minX, el.x - margen); minY = Math.min(minY, el.y - margen);
                maxX = Math.max(maxX, el.x + margen); maxY = Math.max(maxY, el.y + margen);
            });

            const anchoContenido = Math.max(maxX - minX, 100);
            const altoContenido = Math.max(maxY - minY, 100);
            // el árbol ocupa la franja izquierda: se encuadra en el espacio que queda a su derecha
            const wArbol = opciones.arbol ? (anchoArbol + 10) : 0;
            const scaleX = Math.max(containerWidth - wArbol, 200) / anchoContenido;
            const scaleY = containerHeight / altoContenido;
            zoomScale = Math.min(scaleX, scaleY, 2.0);
            aplicarZoom();
            // centrarVistaEnPunto espera coordenadas de pantalla (Y hacia abajo) -> convertir el centro Y
            centrarVistaEnPunto((minX + maxX) / 2 - wArbol / 2 / zoomScale, mundoAScreenY((minY + maxY) / 2));
        }

        // Selección por ventana: arrastrar sobre una zona vacía del lienzo
        let selVentana = null;
        const selBox = document.getElementById('sel-box');
        canvasContainer.addEventListener('mousedown', function(e) {
            if (modoZoomVentana || e.button !== 0) return;
            if (!(e.target === svgCanvas || e.target === marcoA3 || e.target === canvasContainer || e.target.id === 'lienzo-espaciador' || e.target.closest('#empty-state') || e.target.closest('#capa-formato'))) return;
            const rect = canvasContainer.getBoundingClientRect();
            selVentana = { x0: e.clientX - rect.left + canvasContainer.scrollLeft, y0: e.clientY - rect.top + canvasContainer.scrollTop, sumar: e.ctrlKey || e.shiftKey || e.metaKey };
            Object.assign(selBox.style, { left: selVentana.x0 + 'px', top: selVentana.y0 + 'px', width: '0px', height: '0px', display: 'block' });
        });
        window.addEventListener('mousemove', function(e) {
            if (!selVentana) return;
            const rect = canvasContainer.getBoundingClientRect();
            const x = e.clientX - rect.left + canvasContainer.scrollLeft, y = e.clientY - rect.top + canvasContainer.scrollTop;
            Object.assign(selBox.style, { left: Math.min(x, selVentana.x0) + 'px', top: Math.min(y, selVentana.y0) + 'px', width: Math.abs(x - selVentana.x0) + 'px', height: Math.abs(y - selVentana.y0) + 'px' });
            selVentana.x1 = x; selVentana.y1 = y;
        });
        window.addEventListener('mouseup', function() {
            if (!selVentana) return;
            const v = selVentana; selVentana = null; selBox.style.display = 'none';
            if (v.x1 == null || (Math.abs(v.x1 - v.x0) < 4 && Math.abs(v.y1 - v.y0) < 4)) { if (!v.sumar) limpiarSeleccion(); return; }
            const x1 = (Math.min(v.x0, v.x1) - offX) / zoomScale, x2 = (Math.max(v.x0, v.x1) - offX) / zoomScale;
            const y1 = (Math.min(v.y0, v.y1) - offY) / zoomScale, y2 = (Math.max(v.y0, v.y1) - offY) / zoomScale;
            if (!v.sumar) seleccion.clear();
            if (idSeleccionado && v.sumar) seleccion.add(idSeleccionado);
            elementosRed.forEach(el => { const c = centroElemento(el); if (c.x >= x1 && c.x <= x2 && c.y >= y1 && c.y <= y2) seleccion.add(el.id); });
            actualizarSeleccion();
        });
        canvasContainer.addEventListener('mousedown', function(e) {
            if (!modoZoomVentana) return;
            isSelectingZoom = true;
            const rect = canvasContainer.getBoundingClientRect();
            zoomStartX = e.clientX - rect.left + canvasContainer.scrollLeft;
            zoomStartY = e.clientY - rect.top + canvasContainer.scrollTop;
            zoomBox.style.left = zoomStartX + 'px';
            zoomBox.style.top = zoomStartY + 'px';
            zoomBox.style.width = '0px';
            zoomBox.style.height = '0px';
            zoomBox.style.display = 'block';
        });

        canvasContainer.addEventListener('mousemove', function(e) {
            if (!isSelectingZoom || !modoZoomVentana) return;
            const rect = canvasContainer.getBoundingClientRect();
            let currentX = e.clientX - rect.left + canvasContainer.scrollLeft;
            let currentY = e.clientY - rect.top + canvasContainer.scrollTop;
            
            let width = currentX - zoomStartX;
            let height = currentY - zoomStartY;
            
            zoomBox.style.width = Math.abs(width) + 'px';
            zoomBox.style.height = Math.abs(height) + 'px';
            if (width < 0) zoomBox.style.left = currentX + 'px';
            if (height < 0) zoomBox.style.top = currentY + 'px';
        });

        canvasContainer.addEventListener('mouseup', function(e) {
            if (!isSelectingZoom || !modoZoomVentana) return;
            isSelectingZoom = false;
            zoomBox.style.display = 'none';
            modoZoomVentana = false;
            canvasContainer.style.cursor = 'default';

            const rect = canvasContainer.getBoundingClientRect();
            let finX = e.clientX - rect.left + canvasContainer.scrollLeft;
            let finY = e.clientY - rect.top + canvasContainer.scrollTop;

            // zoomStartX/Y y finX/Y están en píxeles de pantalla YA escalados por el zoom actual
            // (son relativos al scroll del contenedor). Se dividen por zoomScale para pasarlos al
            // mismo espacio "sin escalar" en el que viven el.x y mundoAScreenY(el.y) — el mismo
            // criterio que usa el zoom con la rueda del ratón.
            let x1 = (Math.min(zoomStartX, finX) - offX) / zoomScale;
            let x2 = (Math.max(zoomStartX, finX) - offX) / zoomScale;
            let y1 = (Math.min(zoomStartY, finY) - offY) / zoomScale;
            let y2 = (Math.max(zoomStartY, finY) - offY) / zoomScale;

            const anchoSeleccion = x2 - x1;
            const altoSeleccion = y2 - y1;
            if (anchoSeleccion < 5 || altoSeleccion < 5) return; // clic sin arrastre real: se ignora, como en AutoCAD

            const scaleX = canvasContainer.clientWidth / anchoSeleccion;
            const scaleY = canvasContainer.clientHeight / altoSeleccion;
            // El zoom ventana sí permite acercarse más que el límite habitual de la rueda (3.0),
            // ya que su objetivo es precisamente encuadrar un detalle pequeño.
            zoomScale = Math.min(scaleX, scaleY, 15.0);
            aplicarZoom();
            centrarVistaEnPunto((x1 + x2) / 2, (y1 + y2) / 2);
        });

        function cerrarMenuContextual(e) {
            if (!contextMenu.contains(e.target)) {
                contextMenu.style.display = 'none';
                if (!(e.target.closest && e.target.closest('#marcas-menu'))) quitarMarcas();
            }
        }

        function drag(ev) {
            ev.dataTransfer.setData("text/plain", JSON.stringify(ev.target.dataset));
        }

        // ---------- Conexión automática al soltar (2.9) ----------
        // Dirección hacia fuera de un puerto, en grados de pantalla (0 derecha, 90 abajo, 180 izquierda, 270 arriba)
        function dirPuertoLocal(el, pid) {
            if (el.type === 'tuberia') return pid === 'a' ? 180 : 0;
            if (el.type === 'bomba') return pid === 'succion' ? 180 : 0;
            if (el.subtype === 'codo90') return pid === 'a' ? 90 : 0;
            if (/^brida/.test(el.subtype || '')) return pid === 'a' ? 180 : 0;
            if (esDeposito(el) && pid === 'c') return 270;
            const p = obtenerPuertosLocales(el).find(q => q.id === pid);
            if (!p) return 0;
            return Math.round((Math.atan2(p.y - 25, p.x - 25) * 180 / Math.PI + 360) % 360);
        }
        // Puertos sin conectar de la red (coordenadas de pantalla de la hoja)
        function puertosLibres(excluirId) {
            const todos = [];
            elementosRed.forEach(e => { if (!esAnotacion(e) && e.id !== excluirId) obtenerPuertosConexion(e).forEach(p => todos.push({ el: e, id: p.id, x: p.x, y: p.y })); });
            return todos.filter(p => !todos.some(q => q.el.id !== p.el.id && Math.hypot(q.x - p.x, q.y - p.y) < 1));
        }
        const RADIO_CONEXION = 60; // px: distancia del cursor a un puerto libre para conectar al soltar
        function puertoLibreCercano(cx, cy, excluirId) {
            let mejor = null;
            puertosLibres(excluirId).forEach(p => { const d = Math.hypot(p.x - cx, p.y - cy); if (d < RADIO_CONEXION && (!mejor || d < mejor.d)) mejor = Object.assign(p, { d }); });
            return mejor;
        }
        // Puertos de entrada (el flujo entra al elemento por ellos)
        const esPuertoEntrada = (el, pid) => pid === 'a' || pid === 'succion' || (pid === 'c' && (esDeposito(el) || dosCircuitos(el)));
        function conectarAlSoltar(el, cx, cy) {
            const t = puertoLibreCercano(cx, cy, el.id);
            if (!t) return false;
            const mios = obtenerPuertosLocales(el).map(p => p.id);
            if (!mios.length) return false;
            let mio;
            if (mios.length === 1 || sinFlujo(el)) mio = mios[0];
            else if (/^brida/.test(el.subtype || '')) mio = t.el.type === 'tuberia' ? 'b' : 'a'; // la tubería se suelda al cuello (b); la cara (a) mira a la otra brida o al equipo
            else if (esPuertoEntrada(t.el, t.id)) mio = mios.includes('b') ? 'b' : mios.includes('descarga') ? 'descarga' : mios[mios.length - 1];
            else mio = mios.includes('a') ? 'a' : mios.includes('succion') ? 'succion' : mios[0];
            const dT = dirPuertoLocal(t.el, t.id) + (t.el.rotation || 0), dM = dirPuertoLocal(el, mio);
            el.rotation = ((Math.round(dT + 180 - dM) % 360) + 360) % 360;
            const pm = obtenerPuertosConexion(el).find(p => p.id === mio);
            el.x += t.x - pm.x; el.y -= t.y - pm.y;
            return true;
        }
        // Pista visual mientras se arrastra desde la librería: círculo en el puerto al que se conectará
        function allowDrop(ev) {
            ev.preventDefault();
            const r = marcoA3.getBoundingClientRect(), cx = (ev.clientX - r.left) / zoomScale, cy = (ev.clientY - r.top) / zoomScale;
            let t = puertoLibreCercano(cx, cy, null);
            if (!t) { const m = tuberiaBajoPunto(cx, cy); if (m) t = { x: m.A.x + m.ux * m.s, y: m.A.y + m.uy * m.s }; }
            let c = document.getElementById('pista-snap');
            if (!t) { if (c) c.remove(); return; }
            if (!c) { c = document.createElementNS('http://www.w3.org/2000/svg', 'circle'); c.setAttribute('id', 'pista-snap'); c.setAttribute('r', '7'); c.setAttribute('fill', 'rgba(245,158,11,.25)'); c.setAttribute('stroke', '#f59e0b'); c.setAttribute('stroke-width', '2'); c.setAttribute('pointer-events', 'none'); svgCanvas.appendChild(c); }
            c.setAttribute('cx', t.x); c.setAttribute('cy', t.y);
        }
        svgCanvas.addEventListener('dragleave', e => { if (e.target === svgCanvas) document.getElementById('pista-snap')?.remove(); });

        function dropElemento(ev) {
            ev.preventDefault();
            document.getElementById('pista-snap')?.remove();
            // Siempre se trabaja dentro de un proyecto
            if (!proyectoDefinido()) { aviso('Antes de dibujar, define el proyecto (Archivo > Datos del proyecto).', 'error'); abrirDatosProyecto(null, { obligatorio: true }); return; }
            // "Mover/Desconectar" deja esta bandera en true para el siguiente arrastre manual; un
            // componente NUEVO desde la librería siempre debe intentar imantarse.
            desenganchado = false;
            const data = JSON.parse(ev.dataTransfer.getData("text/plain"));
            const rectMarco = marcoA3.getBoundingClientRect();
            const cx = (ev.clientX - rectMarco.left) / zoomScale, cy = (ev.clientY - rectMarco.top) / zoomScale;
            insertarComponente(data, cx, cy);
        }
        // Crea un componente de la librería en (cx, cy) de la hoja: se conecta al puerto libre más
        // cercano, parte la tubería sobre la que cae (componentes en línea) o se imanta a la rejilla.
        function insertarComponente(data, cx, cy) {
            if (!proyectoDefinido()) { aviso('Antes de dibujar, define el proyecto (Archivo > Datos del proyecto).', 'error'); abrirDatosProyecto(null, { obligatorio: true }); return; }
            if (traza) cancelarTrazado();
            desenganchado = false;
            if (data.type === 'anotacion' && data.subtype === 'leyenda') { colocarLeyenda(); return; }
            if (data.type === 'anotacion' && data.subtype === 'materiales') { insertarListado(cx, cy); return; }
            document.getElementById("empty-state")?.remove();
            guardarEstado();
            // Hoja sin componentes: la numeración y las líneas empiezan de nuevo (P01, VAG01-P01...)
            if (data.type !== 'anotacion' && !elementosRed.some(e => !esAnotacion(e))) { lineas = []; condicionesContorno = {}; }

            const idUnico = 'sym_' + Date.now();
            let nuevoElemento = {
                id: idUnico,
                type: data.type,
                subtype: data.subtype || '',
                name: data.name,
                x: cx - 25,
                y: screenAMundoY(cy - 25),
                scale: 1.0,
                rotation: 0
            };

            if (data.type === 'tuberia') {
                nuevoElemento.material = data.material || MATERIAL_DEF;
                nuevoElemento.serie = data.serie || '40';
                nuevoElemento.dn = data.dn || "DN 50";
                nuevoElemento.longitud = parseFloat(data.longitud) || 3000;
            } else if (data.type === 'bomba') {
                nuevoElemento.caudal = +proyecto.caudalDiseno > 0 ? +proyecto.caudalDiseno : (parseFloat(data.caudal) || 50); // m³/h, punto de diseño
                nuevoElemento.presion = parseFloat(data.presion) || 3.5; // bar, altura en el punto de diseño
                nuevoElemento.npsh = (parseFloat(data.npsh) || 2500) / 1000; // NPSH requerido, en metros
                nuevoElemento.h0 = +((nuevoElemento.presion * 1.2).toFixed(2)); // bar a caudal cero (cierre), editable
                nuevoElemento.cota = 0; // m, cota de referencia de la bomba (para NPSH)
            } else if (data.type === 'valvula' || data.type === 'accesorio') {
                nuevoElemento.dn = data.dn || 'DN 50';
                nuevoElemento.modoK = calcDe(nuevoElemento) === 'pedir' ? 'manual' : 'crane';
                if (data.subtype === 'reduccion') { nuevoElemento.dn = 'DN 80'; nuevoElemento.dnMenor = 'DN 50'; nuevoElemento.excentrica = data.excentrica === 'true'; }
            }

            if ((TIPOS[nuevoElemento.subtype] || {}).calc === 'deposito') Object.assign(nuevoElemento, { cotaFondo: 0, hB: 0.2, hLamina: 2, hC: 2.5 });
            normalizarElemento(nuevoElemento);
            registrarInsercion(data);
            elementosRed.push(nuevoElemento);
            if (data.type === 'anotacion') { nuevoElemento.x = cx; nuevoElemento.y = screenAMundoY(cy); }
            else if (puertoLibreCercano(cx, cy, nuevoElemento.id) ? !conectarAlSoltar(nuevoElemento, cx, cy) : !intentarPartirTuberia(nuevoElemento, cx, cy)) aplicarSnapping(nuevoElemento);
            invalidarResultados();
            renderizarVectorial();
            if (!vecinosDe(nuevoElemento).length) limitarAMarco(nuevoElemento);
            expandirCategoriaDe(nuevoElemento);
            prepararNuevoElemento(nuevoElemento);
        }

        // ---------- Herencia de propiedades al insertar (2.8) ----------
        // Tubería más próxima de la misma línea recorriendo la red desde un elemento
        function tuberiaReferencia(desde, linea) {
            const vistos = new Set([desde.id]), cola = [desde];
            while (cola.length && vistos.size < 80) {
                const x = cola.shift();
                if (x.type === 'tuberia') return x;
                vecinosDe(x).forEach(v => { if (!vistos.has(v.otro.id) && (!linea || v.otro.linea === linea)) { vistos.add(v.otro.id); cola.push(v.otro); } });
            }
            return elementosRed.find(e => e.type === 'tuberia' && e.linea === linea && e.id !== desde.id) || null;
        }
        // DN (acero Sch 40) más pequeño que cumple la velocidad máxima con el caudal indicado
        function dnPorCaudal(Q, vl) {
            if (!(Q > 0) || !(vl > 0)) return null;
            const m = CAT.materiales[MATERIAL_DEF];
            const c = m.tamanos.filter(t => t.e['40'] != null).map(t => ({ clave: t.clave, D: (t.od - 2 * t.e['40']) / 1000 })).sort((x, y) => x.D - y.D).find(x => Q / 3600 / (Math.PI * x.D * x.D / 4) <= vl);
            return c ? c.clave : null;
        }
        // Tamaño de una tubería (en su material y serie) equivalente a un DN de componente
        function tamanoTuboDeDN(material, serie, dn) {
            const m = CAT.materiales[material]; if (!m || !dn) return null;
            const ok = t => t.e[serie] != null;
            if (m.tamanos.some(t => t.clave === dn && ok(t))) return dn;
            const od = DN_A_PLASTICO[dnNum(dn)], t = od && m.tamanos.find(x => x.od === od && ok(x));
            return t ? t.clave : null;
        }
        function dnDeVecino(v) {
            if (!v) return null;
            const o = v.otro;
            if (o.type === 'tuberia') return dnEquivalente(o);
            if (o.subtype === 'reduccion') return v.puertoOtro === 'b' ? o.dnMenor : o.dn;
            if (esDeposito(o) && o.dnConexion) return o.dnConexion;
            return o.dn && /^DN/.test(o.dn) ? o.dn : null;
        }

        // Tras soltar un componente: hereda tamaño, clase, material y línea del elemento al que se ha
        // conectado; si sale de una te o un cruce abre un ramal nuevo (R01, R02...); si es el primero
        // se dimensiona para la velocidad máxima con el caudal de diseño. Siempre se abre la ventana de
        // datos particulares del componente para confirmarlos.
        function prepararNuevoElemento(el) {
            if (esAnotacion(el)) { asignarNumero(el); if (el.subtype === 'nota' && !el.texto) el.texto = 'Nota'; renderizarVectorial(); seleccionarElemento(el.id); return; }
            const vec = vecinosDe(el);
            const v = vec[0];
            const herencia = [];
            const dnV = dnDeVecino(v), lim = limitesVelocidad(), Qd = +proyecto.caudalDiseno || 0;
            const refT = v ? tuberiaReferencia(v.otro, v.otro.linea) : null;
            const pnRef = (v && v.otro.pn) || (refT && refT.pn) || null;
            if ((el.type === 'valvula' || el.type === 'accesorio') && el.subtype !== 'reduccion') {
                if (dnV) { el.dn = dnV; herencia.push(`tamaño ${etiquetaDN(dnV)}`); }
                else if (!v) { const d = dnPorCaudal(Qd, lim.imp); if (d) { el.dn = d; herencia.push(`${etiquetaDN(d)} para ${fQ(Qd, 1)} ${lQ()} con V ≤ ${lim.imp} m/s`); } }
            }
            if (el.subtype === 'reduccion' && dnV) {
                const i = LISTA_DN.indexOf(dnV);
                if (v.puertoEl === 'b') { el.dnMenor = dnV; el.dn = LISTA_DN[Math.min(LISTA_DN.length - 1, i + 1)]; } else { el.dn = dnV; el.dnMenor = LISTA_DN[Math.max(0, i - 1)]; }
                herencia.push(`lado ${v.puertoEl === 'b' ? 'menor' : 'mayor'} ${etiquetaDN(dnV)}`);
            }
            if (pnRef && (el.type === 'valvula' || el.type === 'accesorio' || el.type === 'equipo')) { el.pn = pnRef; if (tieneRating(el)) herencia.push(pnRef); }
            if (tieneRating(el) && !el.accModelo) { el.normaPN = pnRef ? (/#$/.test(pnRef) ? 'ASME' : 'EN') : (refT && (refT.material === 'Acero al carbono' || refT.material === 'Acero inoxidable') ? 'ASME' : 'EN'); ajustarPN(el); }
            if (esNodo(el)) el.puertoEntrada = v ? v.puertoEl : 'a';
            if (el.type === 'tuberia') {
                if (refT) { el.material = refT.material; el.serie = refT.serie; herencia.push(`${refT.material} ${/^[0-9]+S?$/.test(refT.serie) ? 'Sch ' + refT.serie : refT.serie}`); }
                // la tubería no tiene rating propio, pero guarda el de la línea para pasarlo a las válvulas y bridas que se conecten después
                if (pnRef) el.pn = pnRef; else delete el.pn;
                const tDN = v && v.otro.type === 'tuberia' ? v.otro.dn : tamanoTuboDeDN(el.material, el.serie, dnV);
                if (tDN) { el.dn = tDN; herencia.push(`tamaño ${tamanoTubo(el.material, tDN)}`); }
                normalizarElemento(el);
            }
            if (herencia.length && v) el._herencia = `Hereda de ${tagDe(v.otro)}: ${herencia.join(' · ')}`;
            else if (herencia.length) el._herencia = `Primer elemento: ${herencia.join(' · ')}`;
            // Cota heredada del punto de conexión
            const zv = v ? cotaPuerto(v.otro, v.puertoOtro) : 0;
            if (el.type === 'tuberia') {
                el.cotaA = zv; el.cotaB = zv; el._conectadoEn = v ? v.puertoEl : null;
                if (!dnV || !v) {
                    // Propuesta de tamaño: caudal que llega por el elemento conectado (último cálculo) o el de diseño
                    const rPrev = v && (ultimoResultadoPrevio || {})[v.otro.id];
                    const Qest = rPrev && rPrev.Q > 0 ? rPrev.Q : Qd;
                    const lado = (v && v.otro.type === 'bomba' && v.puertoOtro === 'succion') || (rPrev && rPrev.lado === 'asp') ? 'asp' : 'imp';
                    if (Qest > 0) {
                        const vl = lim[lado], m = materialDe(el);
                        const c = m.tamanos.filter(t => t.e[el.serie] != null).map(t => ({ t, D: (t.od - 2 * t.e[el.serie]) / 1000 })).sort((x, y) => x.D - y.D).find(x => Qest / 3600 / (Math.PI * x.D * x.D / 4) <= vl);
                        if (c) { el._propuestaDN = { dn: c.t.clave, Q: Qest, V: Qest / 3600 / (Math.PI * c.D * c.D / 4), vl, lado, origen: rPrev && rPrev.Q > 0 ? 'caudal del elemento conectado' : 'caudal de diseño' }; el.dn = c.t.clave; normalizarElemento(el); }
                    }
                }
            }
            else el.cota = zv;
            if (esDeposito(el)) {
                if (v && v.puertoEl === 'c') el.cotaFondo = +(zv - (+el.hC || 0)).toFixed(3);
                else if (v) el.cotaFondo = +(zv - (+el.hB || 0)).toFixed(3);
                normalizarElemento(el);
            }
            let necesitaLinea = true, propuesta = null;
            if (v && v.otro.linea) {
                const o = v.otro;
                if (dosCircuitos(o) && (v.puertoOtro === 'c' || v.puertoOtro === 'd')) {
                    // circuito secundario de un intercambiador: línea del elemento del otro puerto secundario, o una nueva
                    const otroP = v.puertoOtro === 'c' ? 'd' : 'c';
                    const w = vecinosDe(o).find(x => x.puertoEl === otroP && x.otro.id !== el.id && x.otro.linea);
                    if (w) { el.linea = w.otro.linea; necesitaLinea = false; } else propuesta = { tipo: 'principal' };
                }
                else if (esNodo(o) && !sinFlujo(el) && v.puertoOtro !== (o.puertoEntrada || 'a') && !(o.subtype === 'injerto' && v.puertoOtro === 'b')) {
                    // cada salida de una te o de un cruce es un ramal nuevo: R01, R02 (R03 en el cruce)...
                    const id = siguienteLinea('ramal', o.linea);
                    lineas.push({ id, tipo: 'ramal', nombre: '', padre: o.linea, desde: o.id, puerto: v.puertoOtro });
                    el.linea = id; el.inicioLinea = true; necesitaLinea = false;
                    el._herencia = (el._herencia ? el._herencia + '. ' : '') + `Nuevo ramal ${id} desde ${tagDe(o)} (salida ${v.puertoOtro})`;
                }
                else { el.linea = o.linea; necesitaLinea = false; }
            }
            // elemento sin conexión: por defecto abre una línea principal nueva (se puede elegir otra)
            if (necesitaLinea && !propuesta) propuesta = { tipo: 'principal', linea: lineas.length ? lineas[lineas.length - 1].id : null };
            const necesitaK = calcDe(el) === 'pedir';
            const conPN = el.type === 'valvula' || el.type === 'accesorio' || el.type === 'equipo';
            asignarNumero(el);
            abrirModalNuevo(el, necesitaLinea ? propuesta : null, necesitaK, true, { pedirPN: conPN, pedirValv: el.type === 'valvula' && !sinFlujo(el) });
        }

        let nuevoPendiente = null;
        const opt = (lista, actual) => lista.map(o => { const [v, t] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(v)}" ${String(v) === String(actual) ? 'selected' : ''}>${esc(t)}</option>`; }).join('');
        // Controles de la ventana de inserción: data-campo = campo del elemento que rellenan
        const nNum = (id, campo, et, v, paso = 'any') => `<label class="flex items-center justify-between gap-2">${et}<input type="number" step="${paso}" id="${id}" data-campo="${campo}" value="${esc(v)}" class="border rounded p-1 w-28"></label>`;
        const nSel = (id, campo, et, lista, v, extra = '') => `<label class="flex items-center justify-between gap-2">${et}<select id="${id}" data-campo="${campo}" class="border rounded p-1" style="max-width:250px" ${extra}>${opt(lista, v)}</select></label>`;
        const nTxt = (id, campo, et, v) => `<label class="flex items-center justify-between gap-2">${et}<input type="text" id="${id}" data-campo="${campo}" value="${esc(v)}" class="border rounded p-1 w-40"></label>`;
        function abrirModalNuevo(el, propuesta, necesitaK, pedirDatos, extra = {}) {
            nuevoPendiente = { el, propuesta, necesitaK, pedirDatos, extra };
            pintarModalNuevo();
            document.getElementById('modal-nuevo').style.display = 'flex';
        }
        // Material o serie de la tubería cambiados en la ventana de inserción: se aplica y se redibuja
        function nuevoCambiarTubo(campo, valor) {
            const { el } = nuevoPendiente; leerModalNuevo(false);
            if (campo === 'tuboTipo') aplicarTipoTubo(el, valor); else if (campo === 'gradoMaterial' && esTuboAceroNorma(el)) aplicarGradoTubo(el, valor); else if (campo === 'pn') { if (valor) el.pn = valor; else delete el.pn; } else el[campo] = valor;
            normalizarElemento(el);
            const m = materialDe(el);
            if (!m.tamanos.some(t => t.clave === el.dn && t.e[el.serie] != null)) { const t = m.tamanos.find(x => x.e[el.serie] != null); if (t) el.dn = t.clave; }
            delete el._propuestaDN; pintarModalNuevo();
        }
        function pintarModalNuevo() {
            const { el, propuesta, necesitaK, extra } = nuevoPendiente;
            const t = TIPOS[el.subtype] || {};
            const listaDN = LISTA_DN.map(d => [d, etiquetaDN(d)]);
            let h = `<p class="text-slate-600 mb-1"><b>${esc(t.nombre || (el.type === 'tuberia' ? 'Tubería' : 'Bomba centrífuga'))}</b> · ${esc(tagDe(el))}${el.linea ? ` · línea <b>${esc(el.linea)}</b>` : ''}</p>`;
            if (el._herencia) h += `<p class="text-[10px] text-emerald-700 mb-2">${esc(el._herencia)}</p>`;
            if (propuesta) {
                const opsLinea = lineas.map(l => `<option value="${l.id}" ${propuesta.linea === l.id || propuesta.padre === l.id ? 'selected' : ''}>${l.id}${l.nombre ? ' · ' + esc(l.nombre) : ''}</option>`).join('');
                h += `<div class="border border-slate-200 rounded p-2 space-y-1.5 mb-2">
                    <p class="font-bold text-slate-600">Línea a la que pertenece</p>
                    <label class="flex items-center gap-1.5"><input type="radio" name="nl-tipo" value="principal" ${propuesta.tipo === 'principal' ? 'checked' : ''}> Nueva línea principal <b>${siguienteLinea('principal')}</b></label>
                    <input type="text" id="nl-nombre" placeholder="Nombre de la línea principal (p. ej. Agua de refrigeración)" class="w-full border rounded p-1.5 ml-5" style="width:calc(100% - 1.25rem)">
                    ${lineas.length ? `<label class="flex items-center gap-1.5"><input type="radio" name="nl-tipo" value="ramal" ${propuesta.tipo === 'ramal' ? 'checked' : ''}> Nuevo ramal que parte de la línea <select id="nl-padre" class="border rounded p-1">${opsLinea}</select></label>
                    <label class="flex items-center gap-1.5"><input type="radio" name="nl-tipo" value="existente" ${propuesta.tipo === 'existente' ? 'checked' : ''}> Añadir a la línea <select id="nl-existente" class="border rounded p-1">${opsLinea}</select></label>` : ''}
                </div>`;
            }
            h += `<div class="border border-slate-200 rounded p-2 space-y-1.5">`;
            {   // modelo de la librería, material y URL
                const esAcc = el.type === 'accesorio' && esSubtipoAccesorio(el.subtype), mAcc = esAcc ? modeloAcc(el) : null;
                if (esAcc && !ACC_ORIGEN) asegurarAccesorios().then(() => { if (nuevoPendiente && nuevoPendiente.el === el) pintarModalNuevo(); });
                if (esAcc) {
                    h += `<label class="flex items-center justify-between gap-2">Modelo<select id="nd-accModelo" class="border rounded p-1" style="max-width:270px" onchange="nuevoAplicarModelo(this.value)"><option value="">— sin definir —</option>${modelosAcc(el.subtype, el).map(i => `<option value="${esc(i.id)}" ${i.id === el.accModelo ? 'selected' : ''}>${esc(i.nombre)} · ${esc(i.norma)}</option>`).join('')}</select></label>`;
                    if (mAcc) {
                        const mats = materialesAcc(mAcc), sch = schedulesAcc(el, mAcc);
                        h += `<label class="flex items-center justify-between gap-2">Material<select id="nd-materialComp" data-campo="materialComp" class="border rounded p-1" style="max-width:270px" onchange="nuevoRefrescar()">${mats.length ? '<option value="">— sin indicar —</option>' : opcionesMaterial(grupoMaterial(el), el.materialComp || '')}${FAMILIAS_ACC.map(f => { const g = mats.filter(x => x.familia === f); return g.length ? `<optgroup label="${f}">${g.map(x => `<option value="${esc(x.designacion)}" ${x.designacion === el.materialComp ? 'selected' : ''}>${esc(x.designacion)}</option>`).join('')}</optgroup>` : ''; }).join('')}</select></label>`;
                        const carasM = carasAcc(mAcc);
                        if (carasM.length) h += `<label class="flex items-center justify-between gap-2">Cara<select id="nd-cara" data-campo="cara" class="border rounded p-1" style="max-width:270px" onchange="nuevoRefrescar()"><option value="">— sin indicar —</option>${carasM.map(x => `<option value="${esc(x)}" ${x === el.cara ? 'selected' : ''}>${esc(NOMBRE_CARA[x] || x)}</option>`).join('')}</select></label>`;
                        if (!sinEspesorAcc(mAcc)) h += `<label class="flex items-center justify-between gap-2">${SUBTIPOS_BRIDA.includes(el.subtype) ? 'Schedule / espesor del cuello' : 'Schedule / espesor'}<select id="nd-accSch" data-campo="accSch" class="border rounded p-1" style="max-width:270px" onchange="nuevoRefrescar()"><option value="">— sin definir —</option>${sch.map(x => `<option value="${esc(x.schedule)}" ${x.schedule === el.accSch ? 'selected' : ''}>${esc(x.schedule)}${/mm$/.test(x.schedule) ? '' : ' · ' + x.espesor + ' mm'}</option>`).join('')}</select></label>`;
                        const md = medidaAcc(el, mAcc), e = espesorAcc(el, mAcc), co = cotasAcc(el, mAcc);
                        h += `<p class="text-[10px] text-slate-500">Código: <b class="text-slate-700">${esc(codigoAccesorio(el))}</b>${md ? ` · OD ${md.od} mm` : ' · <span class="text-amber-600">medida fuera de la norma</span>'}${e != null ? ` · e ${e} mm` : ''}${co ? ` · ${esc(co)}` : ''}</p>`;
                    }
                }
                const lista = el.type === 'tuberia' || esAcc ? [] : itemsLib(el.type === 'bomba' ? 'bomba' : el.subtype);
                if (lista.length) h += `<label class="flex items-center justify-between gap-2">Modelo de librería<select id="nd-libItem" class="border rounded p-1" style="max-width:250px" onchange="nuevoAplicarItem(this.value)"><option value="">— ninguno (genérico) —</option>${lista.map(i => `<option value="${esc(i.id)}" ${i.id === el.libItem ? 'selected' : ''}>${esc(i.nombre)}</option>`).join('')}</select></label>`;
                const gm = grupoMaterial(el), campoM = el.type === 'tuberia' ? 'gradoMaterial' : 'materialComp';
                if (esTuboAceroNorma(el)) { const gr = gradosTubo(tipoTubo(el));
                    h += `<label class="flex items-center justify-between gap-2">Material<select id="nd-gradoMaterial" data-campo="gradoMaterial" class="border rounded p-1" style="max-width:250px" onchange="nuevoCambiarTubo('gradoMaterial', this.value)"><option value="">— sin indicar —</option>${FAMILIAS_ACC.map(f => { const g = gr.filter(x => x.familia === f); return g.length ? `<optgroup label="${f}">${g.map(x => `<option value="${esc(x.designacion)}" ${x.designacion === el.gradoMaterial ? 'selected' : ''}>${esc(x.designacion)}</option>`).join('')}</optgroup>` : ''; }).join('')}</select></label>`; }
                else if (!mAcc) h += `<label class="flex items-center justify-between gap-2">${el.type === 'tuberia' ? 'Material (grado)' : 'Material'}<select id="nd-${campoM}" data-campo="${campoM}" class="border rounded p-1" style="max-width:250px" onchange="if (this.value === '__otro') { const t = prompt('Material:', ''); if (t) this.add(new Option(t, t, true, true), 0); else this.value = ''; }">${opcionesMaterial(gm, el[campoM] || (el.type === 'tuberia' ? (CAT.materiales[el.material] || {}).grado || '' : ''))}</select></label>`;
                h += nTxt('nd-url', 'url', 'URL del componente', el.url || '');
            }
            if (el.type === 'tuberia') {
                const con = el._conectadoEn, pr = el._propuestaDN, m = materialDe(el);
                const tams = m.tamanos.filter(x => x.e[el.serie] != null);
                h += `<p class="font-bold text-slate-600">Tubería</p>
                    <label class="flex items-center justify-between gap-2">Tipo de tubería<select id="nd-material" class="border rounded p-1" style="max-width:250px" onchange="nuevoCambiarTubo('tuboTipo', this.value)">${opt(opcionesTipoTubo(), tipoTubo(el))}</select></label>
                    <label class="flex items-center justify-between gap-2">Serie / schedule<select id="nd-serie" class="border rounded p-1" onchange="nuevoCambiarTubo('serie', this.value)">${opt(m.series.filter(sr => m.tamanos.some(x => x.e[sr] != null)).map(sr => [sr, /^[0-9]+$/.test(sr) ? 'Sch ' + sr : sr]), el.serie)}</select></label>
                    <label class="flex items-center justify-between gap-2">Medida nominal<select id="nd-dn" data-campo="dn" class="border rounded p-1" style="max-width:250px" onchange="nuevoCambiarTubo('dn', this.value)">${tams.map(x => `<option value="${x.clave}" ${x.clave === el.dn ? 'selected' : ''}>${esc(tamanoTubo(el.material, x.clave))}${esAceroTubo(el.material) ? ' (' + x.clave + ')' : ''} · De ${x.od} × ${x.e[el.serie]} mm</option>`).join('')}</select></label>
                    ${pr ? `<p class="text-[10px] text-emerald-700">Propuesto ${esc(tamanoTubo(el.material, pr.dn))} para Q = ${fQ(pr.Q, 2)} ${lQ()} (${pr.origen}) → V ${pr.V.toFixed(2)} m/s ≤ ${pr.vl} m/s (${pr.lado === 'asp' ? 'aspiración' : 'impulsión'})</p>` : ''}
                    ${codigoTubo(el) ? `<p class="text-[10px] text-slate-500">Código: <b class="text-slate-700">${esc(codigoTubo(el))}</b></p>` : (esTuboAceroNorma(el) ? '<p class="text-[10px] text-slate-400">Elige el material para completar el código de la tubería.</p>' : '')}
                    ${nNum('nd-longitud', 'longitud', 'Longitud (mm)', el.longitud, '1')}
                    <p class="font-bold text-slate-600 pt-1">Cotas (m)</p>
                    ${nNum('nd-cotaA', 'cotaA', `Cota extremo a (mm)${con === 'a' ? ' <span class="text-slate-400">(heredada)</span>' : ''}`, mostrarCampo('cotaA', el.cotaA), '1')}
                    ${nNum('nd-cotaB', 'cotaB', `Cota extremo b (mm)${con === 'b' ? ' <span class="text-slate-400">(heredada)</span>' : ''}`, mostrarCampo('cotaB', el.cotaB), '1')}`;
            } else if (el.type === 'bomba') {
                const otras = elementosRed.filter(e => e.type === 'bomba' && e.id !== el.id && !e.reservaDe);
                h += `<p class="font-bold text-slate-600">Bomba (punto de diseño)</p>
                    ${nSel('nd-bombaTipo', 'bombaTipo', 'Tipo de bomba', TIPOS_BOMBA, el.bombaTipo || 'centrifuga')}
                    ${nNum('nd-caudal', 'caudal', `Caudal (${lQ()})`, mostrarCampo('caudal', el.caudal))}${nNum('nd-presion', 'presion', `Presión (${lP()})`, mostrarCampo('presion', el.presion))}
                    ${nNum('nd-h0', 'h0', `Presión a caudal cero (${lP()})`, mostrarCampo('h0', el.h0))}${nNum('nd-npsh', 'npsh', 'NPSH requerido (m)', el.npsh, '0.1')}
                    ${nNum('nd-eta', 'eta', 'Rendimiento η', el.eta || 0.7, '0.01')}${nNum('nd-cota', 'cota', 'Cota de la bomba (mm)', mostrarCampo('cota', el.cota), '1')}
                    ${nSel('nd-reservaDe', 'reservaDe', 'Función', [['', 'Servicio'], ...otras.map(e => [e.id, 'Reserva de ' + tagDe(e)])], el.reservaDe || '')}
                    <p class="font-bold text-slate-600 pt-1">Conexiones</p>
                    ${(() => { const dns = [['', '—'], ...LISTA_DN.map(d => [d, etiquetaDN(d)])], pns = [['', '—'], ...PN_LISTA.filter(x => !/^(2000|3000|6000|9000)#$/.test(x))];
                        return nSel('nd-dnAsp', 'dnAsp', 'Entrada (aspiración) · tamaño', dns, el.dnAsp || '') + nSel('nd-pnAsp', 'pnAsp', 'Entrada · rating', pns, el.pnAsp || '') + nSel('nd-dnImp', 'dnImp', 'Salida (impulsión) · tamaño', dns, el.dnImp || '') + nSel('nd-pnImp', 'pnImp', 'Salida · rating', pns, el.pnImp || ''); })()}
                    <p class="text-[10px] text-slate-400">Aspiración (A) a la izquierda e impulsión (I) a la derecha. Herramientas > Dimensionar bomba propone el punto Q-H.</p>`;
            } else if (esEquipo(el)) {
                const dc = dosCircuitos(el);
                h += `<p class="font-bold text-slate-600">Pérdida de carga del equipo (dato del fabricante)</p>
                    ${dc ? '<p class="text-[10px] text-slate-500">Circuito primario (a–b, horizontal)</p>' : ''}
                    ${nNum('nd-qNom', 'qNom', `Caudal nominal (${lQ()})`, mostrarCampo('qNom', el.qNom))}${nNum('nd-dpNom', 'dpNom', `Pérdida de carga a caudal nominal (${lP()})`, mostrarCampo('dpNom', el.dpNom))}
                    ${dc ? `<p class="text-[10px] text-slate-500">Circuito secundario (c–d, vertical)</p>${nNum('nd-qNom2', 'qNom2', `Caudal nominal (${lQ()})`, mostrarCampo('qNom2', el.qNom2))}${nNum('nd-dpNom2', 'dpNom2', `Pérdida de carga a caudal nominal (${lP()})`, mostrarCampo('dpNom2', el.dpNom2))}` : ''}
                    ${nSel('nv-normaPN', 'normaPN', 'Norma', NORMAS_PN, normaPN(el), 'onchange="nuevoCambiarNorma(this.value)"')}${nSel('nv-pn', 'pn', 'PN / Rating', listaPN(el), el.pn)}${nNum('nd-volumen', 'volumen', 'Volumen interior (l)', el.volumen || '')}
                    ${nNum('nd-cota', 'cota', 'Cota (mm)', mostrarCampo('cota', el.cota), '1')}
                    <p class="text-[10px] text-slate-400">Se aplica Δp = Δp nom · (Q/Q nom)².</p>`;
            } else if (el.subtype === 'consumo') {
                h += `<p class="font-bold text-slate-600">Punto de consumo</p>
                    ${nNum('nd-qCons', 'qCons', `Caudal demandado (${lQ()})`, mostrarCampo('qCons', el.qCons))}${nNum('nd-pMin', 'pMin', `Presión mínima requerida (${lP()} man.)`, mostrarCampo('pMin', el.pMin))}
                    ${nNum('nd-cota', 'cota', 'Cota del punto de consumo (mm)', mostrarCampo('cota', el.cota), '1')}`;
            } else if (esDeposito(el)) {
                h += `<p class="font-bold text-slate-600">Tanque / depósito</p>
                    ${nNum('nd-cotaFondo', 'cotaFondo', 'Cota del fondo del tanque (mm)', mostrarCampo('cotaFondo', el.cotaFondo), '1')}
                    ${nNum('nd-hB', 'hB', 'Altura de la conexión lateral b sobre el fondo (m)', el.hB, '0.01')}
                    ${nNum('nd-hC', 'hC', 'Altura de la conexión superior c sobre el fondo (m)', el.hC, '0.01')}
                    ${nNum('nd-hLamina', 'hLamina', 'Nivel de líquido sobre el fondo (m)', el.hLamina, '0.01')}
                    ${nSel('nd-tipoConexion', 'tipoConexion', 'Tipo de conexión', TIPOS_CONEXION, el.tipoConexion)}
                    ${nSel('nd-dnConexion', 'dnConexion', 'Tamaño de la conexión', [['', '— igual que la tubería —'], ...listaDN], el.dnConexion || '')}
                    ${nNum('nd-presionDep', 'presionDep', `Presión sobre la lámina (${lP()} man.; 0 = abierto)`, mostrarCampo('presionDep', el.presionDep))}
                    ${nNum('nd-volumen', 'volumen', 'Volumen interior (l) · PED recipientes', el.volumen || '')}
                    <p class="text-[10px] text-slate-400">Conexión b a cota ${fmt(el.cota, 2)} m · lámina a ${fmt(el.cotaLamina, 2)} m (se recalculan al aceptar).</p>`;
            } else if (el.type === 'instrumento') {
                h += `<p class="font-bold text-slate-600">Instrumento</p>
                    ${nSel('nd-dnInstr', 'dnInstr', 'Conexión a proceso', [['', '—'], ...listaDN.slice(0, 8)], el.dnInstr || '')}
                    ${nTxt('nd-rango', 'rango', 'Rango / escala', el.rango || '')}
                    ${nNum('nd-cota', 'cota', 'Cota (mm)', mostrarCampo('cota', el.cota), '1')}`;
            } else {
                // válvulas y accesorios
                const esRed = el.subtype === 'reduccion';
                h += `<p class="font-bold text-slate-600">${el.type === 'valvula' ? 'Válvula' : 'Accesorio'}</p>`;
                const refr = el.accModelo ? 'onchange="nuevoRefrescar()"' : '';
                if (esRed) h += nSel('nd-dnMayor', 'dn', 'DN mayor (puerto a)', listaDN, el.dn, refr) + nSel('nd-dnMenor', 'dnMenor', 'DN menor (puerto b)', listaDN, el.dnMenor, refr) + nSel('nd-excentrica', 'excentrica', 'Tipo', [['false', 'Concéntrica'], ['true', 'Excéntrica']], String(!!el.excentrica));
                else { const mR = el.accModelo ? modeloAcc(el) : null, lDN = mR ? listaDN.filter(d => dnEnRangoAcc(mR, d[0]) || d[0] === el.dn) : listaDN; h += nSel('nd-dnc', 'dn', el.accModelo ? 'Medida nominal' : 'Tamaño', lDN.length ? lDN : listaDN, el.dn, refr); }
                const esCtrl = el.subtype === 'control';
                const ops = calcDe(el) === 'crane' && !esCtrl ? opcionesCrane(claveCrane(el)) : [];
                if (ops.length > 1) h += nSel('nv-tipo', 'craneTipo', el.type === 'valvula' ? 'Subtipo' : 'Tipo', ops.map(o => o[0]), el.craneTipo);
                h += !tieneRating(el) || (el.accModelo && sinRatingAcc(modeloAcc(el))) ? '' : el.accModelo && modeloAcc(el) ? nSel('nv-pn', 'pn', 'PN / Rating', [['', '— sin indicar —'], ...ratingsAcc(modeloAcc(el))], el.pn || '', 'onchange="nuevoRefrescar()"') : nSel('nv-normaPN', 'normaPN', 'Norma', NORMAS_PN, normaPN(el), 'onchange="nuevoCambiarNorma(this.value)"') + nSel('nv-pn', 'pn', 'PN / Rating', listaPN(el), el.pn);
                if (sinFlujo(el) && el.type === 'valvula') h += nNum('nd-pTarado', 'pTarado', `Presión de tarado (${lP()})`, mostrarCampo('pTarado', el.pTarado || ''));
                if (extra.pedirValv && calcDe(el) === 'crane' && !esCtrl) h += nNum('nv-cv', 'cvUsuario', 'Cv del fabricante (opcional; obligatorio en doble clapeta)', el.modoK === 'cv' ? el.cvUsuario : '');
                if (esCtrl) h += nNum('nv-kvs', 'kvs', 'Kvs (m³/h)', el.kvs || '') + nSel('nv-car', 'caracteristica', 'Característica', [['iso', 'Isoporcentual'], ['lineal', 'Lineal']], el.caracteristica || 'iso') + nNum('nv-ap', 'apertura', 'Apertura de cálculo (%)', el.apertura || 70, '1');
                h += nNum('nd-cota', 'cota', 'Cota (mm)', mostrarCampo('cota', el.cota), '1');
            }
            h += `</div>`;
            if (necesitaK) {
                const craneOps = opcionesCrane(claveCrane(el));
                h += `<div class="border border-slate-200 rounded p-2 space-y-1.5 mt-2">
                    <p class="font-bold text-slate-600">Coeficiente de pérdida (dato del fabricante)</p>
                    <label class="flex items-center gap-1.5"><input type="radio" name="nk-modo" value="cv" checked> Cv (gpm/√psi) <input type="number" step="any" id="nk-cv" class="border rounded p-1 w-24"></label>
                    <label class="flex items-center gap-1.5"><input type="radio" name="nk-modo" value="manual"> K <input type="number" step="any" id="nk-k" class="border rounded p-1 w-24"></label>
                    ${craneOps.length ? `<label class="flex items-center gap-1.5"><input type="radio" name="nk-modo" value="crane"> Sin dato: ${esc(craneOps[0][0])}</label>` : ''}
                </div>`;
            }
            document.getElementById('modal-nuevo-body').innerHTML = h;
        }
        const CAMPOS_TEXTO_NUEVO = ['accSch', 'cara', 'normaPN', 'bombaTipo', 'dn', 'dnMenor', 'pn', 'craneTipo', 'caracteristica', 'reservaDe', 'tipoConexion', 'dnConexion', 'dnInstr', 'rango', 'materialComp', 'gradoMaterial', 'url', 'dnAsp', 'pnAsp', 'dnImp', 'pnImp'];
        function nuevoAplicarModelo(id) { const { el } = nuevoPendiente; leerModalNuevo(false); aplicarModeloAcc(el, id); pintarModalNuevo(); }
        function nuevoRefrescar() { const { el } = nuevoPendiente; leerModalNuevo(false); if (el.accModelo) ajustarScheduleAcc(el); pintarModalNuevo(); }
        function nuevoAplicarItem(id) { const { el } = nuevoPendiente; leerModalNuevo(false); aplicarItemLib(el, id ? itemPorId(id) : null); pintarModalNuevo(); }
        // Lee los controles de la ventana de inserción y los aplica al elemento. Devuelve un error o null.
        function leerModalNuevo(validar = true) {
            const { el } = nuevoPendiente;
            for (const x of document.querySelectorAll('#modal-nuevo-body [data-campo]')) {
                const c = x.dataset.campo, raw = x.value;
                if (c === 'excentrica') { el.excentrica = raw === 'true'; continue; }
                if (CAMPOS_TEXTO_NUEVO.includes(c)) { if (raw === '' && ['pn', 'reservaDe', 'dnConexion', 'dnInstr', 'rango', 'materialComp', 'gradoMaterial', 'url', 'dnAsp', 'pnAsp', 'dnImp', 'pnImp'].includes(c)) { if (c !== 'pn' || el.type === 'tuberia') delete el[c]; } else if (raw !== '__otro') el[c] = raw; continue; }
                if (String(raw).trim() === '') { if (['cvUsuario', 'kvs', 'volumen', 'pTarado'].includes(c)) continue; if (validar) return 'Revisa los datos numéricos.'; continue; }
                let v = parseFloat(raw); if (isNaN(v)) { if (validar) return 'Revisa los datos numéricos.'; continue; }
                if (CAMPOS_UNIDAD[c]) v = leerCampo(c, v);
                if (c === 'cvUsuario') { if (v > 0) { el.modoK = 'cv'; el.cvUsuario = v; } continue; }
                el[c] = v;
            }
            return null;
        }
        function confirmarModalNuevo() {
            if (!nuevoPendiente) return;
            const { el, propuesta, necesitaK } = nuevoPendiente;
            const err = leerModalNuevo(true);
            if (err) { alert(err); return; }
            if (esTuboAceroNorma(el) && el.gradoMaterial) aplicarGradoTubo(el, el.gradoMaterial);
            if (el.type === 'tuberia' && !(el.longitud > 0)) { alert('La longitud debe ser mayor que cero.'); return; }
            if (el.type === 'tuberia' && Math.abs(el.cotaB - el.cotaA) > el.longitud / 1000 + 1e-6) { alert(`El desnivel (${Math.abs(el.cotaB - el.cotaA).toFixed(2)} m) no puede ser mayor que la longitud de la tubería (${el.longitud / 1000} m).`); return; }
            if ((el.qNom2 != null && !(el.qNom2 > 0)) || (el.dpNom2 != null && el.dpNom2 < 0) || (esEquipo(el) && (!(el.qNom > 0) || el.dpNom < 0)) || (el.qCons != null && el.qCons < 0)) { alert('El caudal debe ser > 0 y la pérdida de carga ≥ 0.'); return; }
            if (esDeposito(el) && (el.hB < 0 || el.hC < 0 || el.hLamina < 0)) { alert('Las alturas sobre el fondo del tanque no pueden ser negativas.'); return; }
            if (esDeposito(el) && el.hLamina < el.hB) { alert('El nivel de líquido debe quedar por encima de la conexión lateral b (si no, la salida aspiraría aire).'); return; }
            if (el.subtype === 'reduccion' && dnNum(el.dnMenor) >= dnNum(el.dn)) { alert('En la reducción, el DN menor debe ser más pequeño que el DN mayor.'); return; }
            const ent = opcionesCrane(claveCrane(el)).find(o => o[0] === el.craneTipo);
            if (ent && ent[1] && ent[1].pedirCv && !(el.modoK === 'cv' && el.cvUsuario > 0)) { alert('La válvula de doble clapeta necesita el Cv del fabricante.'); return; }
            if (el.subtype === 'control') {
                if (!(el.kvs > 0) || !(el.apertura > 0 && el.apertura <= 100)) { alert('Indica el Kvs (> 0) y una apertura entre 1 y 100 %.'); return; }
                el.modoK = 'kvs';
            }
            if (propuesta) {
                const tipo = (document.querySelector('input[name="nl-tipo"]:checked') || {}).value || 'principal';
                if (tipo === 'principal') {
                    const id = siguienteLinea('principal');
                    lineas.push({ id, tipo: 'principal', nombre: document.getElementById('nl-nombre').value.trim() });
                    el.linea = id; el.inicioLinea = true;
                } else if (tipo === 'ramal') {
                    const padre = document.getElementById('nl-padre').value;
                    const id = siguienteLinea('ramal', padre);
                    lineas.push({ id, tipo: 'ramal', nombre: '', padre, desde: propuesta.desde || null });
                    el.linea = id; el.inicioLinea = true;
                } else {
                    el.linea = document.getElementById('nl-existente').value;
                }
            }
            if (necesitaK) {
                const modo = (document.querySelector('input[name="nk-modo"]:checked') || {}).value || 'cv';
                if (modo === 'cv') {
                    const cv = parseFloat(document.getElementById('nk-cv').value);
                    if (!(cv > 0)) { alert('Introduce un Cv mayor que cero, o elige otra opción.'); return; }
                    el.modoK = 'cv'; el.cvUsuario = cv;
                } else if (modo === 'manual') {
                    const k = parseFloat(document.getElementById('nk-k').value);
                    if (!(k >= 0)) { alert('Introduce un K válido (≥ 0), o elige otra opción.'); return; }
                    el.modoK = 'manual'; el.k = k;
                } else el.modoK = 'crane';
            }
            normalizarElemento(el); el.codigo = null; asignarNumero(el);
            ['_conectadoEn', '_propuestaDN', '_herencia'].forEach(k => delete el[k]);
            document.getElementById('modal-nuevo').style.display = 'none';
            const alConfirmar = nuevoPendiente.alConfirmar;
            nuevoPendiente = null;
            if (alConfirmar) alConfirmar(el);
            invalidarResultados();
            renderizarVectorial();
            seleccionarElemento(el.id);
        }
        function cancelarModalNuevo() {
            // Cancelar la inserción: se deshace el componente recién soltado
            document.getElementById('modal-nuevo').style.display = 'none';
            nuevoPendiente = null;
            deshacer();
        }

        // Puertos locales (sin rotar/trasladar) de cada símbolo, coherentes con su dibujo SVG.
        // Cada puerto lleva un "id" semántico estable (usado por el motor de cálculo), independiente
        // de la posición/rotación visual.
        function obtenerPuertosLocales(el) {
            if (el.type === 'tuberia') {
                let largoPx = (el.longitud || 3000) / 30;
                return [{ x: 0, y: 20, id: 'a' }, { x: largoPx, y: 20, id: 'b' }];
            }
            if (el.type === 'bomba') {
                // Coinciden con el borde real del círculo dibujado (cx=25, cy=25, r=20)
                return [{ x: 5, y: 25, id: 'succion' }, { x: 45, y: 25, id: 'descarga' }];
            }
            const t = TIPOS[el.subtype];
            return t ? t.puertos : [PA, PB];
        }

        function obtenerPuertosConexion(el) {
            // Debe replicar EXACTAMENTE la transformación SVG con la que se dibuja el símbolo
            // (`translate(el.x, screenY) rotate(rot, 25, 25) scale(el.scale)`, ver renderizarVectorial),
            // para que el puerto calculado coincida en pantalla, sin ninguna desviación, con el
            // puntito azul realmente dibujado. Antes esta función mezclaba mundo (el.y, Y-arriba)
            // con coordenadas locales pensadas en pantalla (Y-abajo) y usaba, para la tubería, un
            // pivote de rotación distinto al que realmente usa el render (que SIEMPRE rota alrededor
            // de (25,25), sea cual sea la longitud) — ambas cosas dejaban huecos reales aunque el
            // propio snapping "creyera" haber conectado exacto.
            let rot = el.rotation || 0;
            let rad = rot * Math.PI / 180;
            let escala = el.scale || 1;
            const PIVOTE = { x: 25, y: 25 }; // coincide siempre con rotate(rot, 25, 25) del render
            let screenYEl = mundoAScreenY(el.y);
            return obtenerPuertosLocales(el).map(p => {
                let pEscalado = { x: p.x * escala, y: p.y * escala };
                let global = rotarPunto(pEscalado, PIVOTE, rad, el.x, screenYEl);
                global.id = p.id;
                return global; // coordenadas de PANTALLA reales (Y hacia abajo), no de mundo
            });
        }

        function rotarPunto(p, centro, rad, posX, posY) {
            let cos = Math.cos(rad);
            let sin = Math.sin(rad);
            let nx = cos * (p.x - centro.x) - sin * (p.y - centro.y) + centro.x;
            let ny = sin * (p.x - centro.x) + cos * (p.y - centro.y) + centro.y;
            return { x: posX + nx, y: posY + ny };
        }

        // Rellena valores por defecto que puedan faltar (elementos creados con versiones anteriores)
        function normalizarElemento(el) {
            if (el.materialComp && typeof MATCOMP_ANTIGUOS === 'object') { const M = el.type === 'bomba' ? MATCOMP_BOMBA_ANTIGUOS : MATCOMP_ANTIGUOS; if (M[el.materialComp]) el.materialComp = M[el.materialComp]; }
            if (el.pn) el.pn = PN_NUEVO(el.pn);
            if (el.subtype === 'continuacion' && typeof prepararContinuacion === 'function') prepararContinuacion(el);
            if (el.gradoMaterial) el.gradoMaterial = GRADO_NUEVO(el.gradoMaterial);
            el.esLineaCritica = false; // se recalcula en el próximo "Calcular Red"
            el.estado = null;
            if (tieneRating(el) && !PN_LISTA.includes(el.pn) && !(el.accModelo && !el.pn)) el.pn = el.normaPN === 'ASME' ? '150#' : 'PN 16';   // con modelo, el rating puede quedar sin indicar
            if (el.subtype === 'control' && !el._kvsIni) { el._kvsIni = true; el.modoK = 'kvs'; if (el.apertura == null) el.apertura = 70; if (!el.caracteristica) el.caracteristica = 'iso'; }
            // Cotas (m): tuberías en cada extremo; el resto, una cota única en sus puertos
            if (el.type === 'tuberia') { if (el.cotaA == null || isNaN(+el.cotaA)) el.cotaA = 0; if (el.cotaB == null || isNaN(+el.cotaB)) el.cotaB = +el.cotaA; if (el.pn && !PN_LISTA.includes(el.pn)) delete el.pn; }
            else if (el.cota == null || isNaN(+el.cota)) el.cota = 0;
            if (MIGRA_SUBTIPO[el.subtype]) el.subtype = MIGRA_SUBTIPO[el.subtype];
            if (el.subtype === 'tabla') {
                if (!Array.isArray(el.anchos) || !el.anchos.length) el.anchos = [30, 30, 30];
                if (!Array.isArray(el.altos) || !el.altos.length) el.altos = [6, 6, 6];
                el.celdas = el.altos.map((_, i) => el.anchos.map((_, j) => ((el.celdas || [])[i] || [])[j] || ''));
            }
            if (el.type === 'bomba') {
                if (el.h0 == null) el.h0 = +(((el.presion || 3.5) * 1.2).toFixed(2));
                if (el.bombaTipo === 'centrifuga') delete el.bombaTipo;
                if (el.cota == null) el.cota = 0;
                if (el.npsh == null) el.npsh = 2.5;
                else if (el.npsh > 100) el.npsh = el.npsh / 1000; // formato antiguo en mm
            } else if (el.type === 'tuberia') {
                delete el.espesor; // el espesor sale ahora de la tabla material/serie/tamaño
                normalizarTuberia(el);
            } else if (el.type === 'instrumento') {
                // sin caudal: no necesita DN ni K
            } else if (el.type === 'equipo') {
                if (!(+el.qNom > 0)) el.qNom = 10;          // m³/h
                if (!(+el.dpNom >= 0)) el.dpNom = 30;       // kPa a qNom
                if (dosCircuitos(el)) { if (!(+el.qNom2 > 0)) el.qNom2 = el.qNom; if (!(+el.dpNom2 >= 0)) el.dpNom2 = el.dpNom; }
            } else if (el.subtype === 'consumo') {
                if (!(+el.qCons >= 0)) el.qCons = 1;        // m³/h demandado
                if (el.pMin == null || isNaN(+el.pMin)) el.pMin = 1; // bar man. mínima
            } else if (esDeposito(el)) {
                // Geometría del tanque referida a su fondo: cota del fondo + alturas de las conexiones b
                // (lateral) y c (superior) y nivel de líquido. Proyectos anteriores: se deducen de las cotas.
                const n = x => x != null && x !== '' && !isNaN(+x);
                if (!n(el.cotaFondo)) {
                    const zb = +el.cota || 0, zl = n(el.cotaLamina) ? +el.cotaLamina : zb + 2, ze = n(el.cotaEntrada) ? +el.cotaEntrada : zl + 0.5;
                    const f = Math.min(zb, zl, ze);
                    el.cotaFondo = f; el.hB = +(zb - f).toFixed(3); el.hLamina = +(zl - f).toFixed(3); el.hC = +(Math.max(ze, zl) - f).toFixed(3);
                }
                if (!n(el.hB)) el.hB = 0.2; if (!n(el.hLamina)) el.hLamina = 2; if (!n(el.hC)) el.hC = 2.5;
                el.cotaFondo = +el.cotaFondo; el.hB = +el.hB; el.hC = +el.hC; el.hLamina = +el.hLamina;
                el.cota = +(el.cotaFondo + el.hB).toFixed(3); el.cotaLamina = +(el.cotaFondo + el.hLamina).toFixed(3); el.cotaEntrada = +(el.cotaFondo + el.hC).toFixed(3);
                if (el.presionDep == null || isNaN(+el.presionDep)) el.presionDep = el.subtype === 'hidroforo' ? 4 : 0; // bar man. sobre la lámina
                if (!el.tipoConexion) el.tipoConexion = 'Brida';
            } else if (el.type === 'valvula' || el.type === 'accesorio') {
                if (el.dn == null || !LISTA_DN.includes(el.dn)) el.dn = 'DN 50';
                const calc = calcDe(el);
                if (el.modoK == null) {
                    // Proyecto de una versión anterior: si el K es el de la librería antigua se pasa a
                    // K automático; si el usuario lo había cambiado, se conserva como K manual.
                    const def = K_LIBRERIA_ANTIGUA[el.subtype === 'codo90' ? 'codo' : el.subtype === 'bridaunion' ? 'union' : el.subtype];
                    el.modoK = (el.k == null || el.subtype === 'tee' || (def != null && Math.abs(el.k - def) < 1e-9)) ? 'crane' : 'manual';
                }
                if (calc === 'pedir' && el.modoK === 'crane' && !opcionesCrane(claveCrane(el)).length) el.modoK = 'manual';
                if (el.subtype === 'reduccion') {
                    if (!LISTA_DN.includes(el.dnMenor) || dnNum(el.dnMenor) >= dnNum(el.dn)) {
                        const i = LISTA_DN.indexOf(el.dn);
                        el.dnMenor = LISTA_DN[Math.max(0, i - 1)];
                    }
                }
                if (el.modoK === 'catalogo' && !seriesValvula(el).some(v => v.nombre === el.serieCat)) {
                    const lista = seriesValvula(el);
                    el.serieCat = lista.length ? lista[0].nombre : '';
                }
                const ops = opcionesCrane(claveCrane(el));
                if (ops.length && !ops.some(o => o[0] === el.craneTipo)) el.craneTipo = ops[0][0];
                if (el.modoK === 'manual') {
                    if (esNodo(el)) { if (el.kRun == null) el.kRun = 0.3; if (el.kBranch == null) el.kBranch = 1.0; }
                    else if (el.k == null) el.k = 0;
                }
            }
        }

        function aplicarSnapping(el, umbral = 35) {
            if (desenganchado) return;
            const snapThreshold = umbral;
            let puertosArrastrados = obtenerPuertosConexion(el);

            // Se evalúan TODAS las combinaciones puerto-arrastrado / puerto-fijo dentro del umbral
            // (de cualquier otro elemento) y se elige la de MENOR distancia, no la primera que se
            // encuentre. Antes, al haber varios puertos cercanos a la vez, el imán podía "irse" a
            // uno más lejano solo porque se comprobaba antes en el orden de la lista.
            let mejor = null;
            for (let otroEl of elementosRed) {
                if (otroEl.id === el.id) continue;
                let puertosFijos = obtenerPuertosConexion(otroEl);
                for (let pa of puertosArrastrados) {
                    for (let pf of puertosFijos) {
                        let distancia = Math.hypot(pa.x - pf.x, pa.y - pf.y);
                        if (distancia < snapThreshold && (!mejor || distancia < mejor.distancia)) {
                            mejor = { pa, pf, distancia };
                        }
                    }
                }
            }

            if (mejor) {
                // pa/pf son coordenadas de PANTALLA (ver obtenerPuertosConexion). En X, mundo y
                // pantalla avanzan igual, pero en Y el mundo está invertido respecto a pantalla, así
                // que la corrección de pantalla se SUMA a el.y (no se resta, al contrario que con
                // el.x) para que el puerto quede exacto sobre el fijo, sin ninguna desviación.
                let offsetX = mejor.pa.x - el.x;
                let offsetYPantalla = mejor.pa.y - mejor.pf.y;
                el.x = mejor.pf.x - offsetX;
                el.y = el.y + offsetYPantalla;
            }
        }

        // Reajusta el imantado de TODOS los elementos ya colocados, con un umbral más estrecho que
        // el arrastre interactivo (para no unir elementos que no se pretendía conectar). Corrige
        // huecos que quedan cuando: se abre un proyecto guardado con una geometría de puertos
        // ligeramente distinta a una versión anterior, o se ha movido a mano un conjunto ya
        // conectado y algún extremo quedó suelto.
        function reajustarTodasLasConexiones(registrarEnHistorial = true) {
            desenganchado = false; // una acción manual de reajuste nunca debe quedar bloqueada por esta bandera
            if (registrarEnHistorial) guardarEstado();
            const UMBRAL_REAJUSTE = 15;
            for (let pasada = 0; pasada < 3; pasada++) {
                elementosRed.forEach(el => aplicarSnapping(el, UMBRAL_REAJUSTE));
            }
            renderizarVectorial();
        }

        // ==================================================================================
        // OPCIONES DE VISUALIZACIÓN Y COLORES
        // ==================================================================================
        let opciones = { fondo: 'papel', norma: 'ISO', vmax: 3.0, margenNPSH: 0.5, arbol: true, uPresion: 'bar', uCaudal: 'm3h', calculoAuto: true,
            formato: 'A3', rejillaVisible: true, rejillaMayor: 10, rejillaMenores: 2, rejilla: false };
        const FONDOS = {
            papel: { nombre: 'Papel', hoja: '#e8e6dc', punto: '#c3c1b6', oscuro: false },
            blanco:     { nombre: 'Blanco',      hoja: '#ffffff', punto: '#cbd5e1', oscuro: false },
            grisClaro:  { nombre: 'Gris claro',  hoja: '#e5e7eb', punto: '#c4c9d1', oscuro: false },
            grisOscuro: { nombre: 'Gris oscuro', hoja: '#374151', punto: '#4b5563', oscuro: true },
            negro:      { nombre: 'Negro',       hoja: '#0b0f14', punto: '#1f2937', oscuro: true }
        };
        const NORMAS = { ISO: 'ISO 10628-2', ISA: 'ISA 5.1', CLIENTE: 'Empresa cliente' };
        function paleta() {
            const f = FONDOS[opciones.fondo] || FONDOS.papel;
            return f.oscuro
                ? { base: '#60a5fa', texto: '#e2e8f0', halo: f.hoja, relleno: f.hoja, ok: '#4ade80', fallo: '#f87171', critica: '#c084fc', flecha: '#4ade80', sel: '#fbbf24' }
                : { base: '#2563eb', texto: '#1e3a8a', halo: f.hoja, relleno: f.hoja, ok: '#16a34a', fallo: '#dc2626', critica: '#7c3aed', flecha: '#16a34a', sel: '#f59e0b' };
        }
        function aplicarFondo() {
            const f = FONDOS[opciones.fondo] || FONDOS.papel;
            marcoA3.style.backgroundColor = f.hoja;
            marcoA3.style.backgroundImage = 'none'; // la rejilla se dibuja en el SVG (capa de formato)
        }
        // Color de un elemento: rojo si no cumple; violeta si es de la ruta crítica; verde si cumple;
        // azul (según fondo) si todavía no se ha calculado.
        function colorElemento(el, P) {
            if (el.esLineaCritica) return P.critica; // la ruta crítica siempre en violeta (un fallo en ella lleva la marca roja «!»)
            if (el.estado === 'fallo') return P.fallo;
            if (el.estado === 'ok') return P.ok;
            return P.base;
        }

        // ==================================================================================
        // SÍMBOLOS (ISO 10628-2 por defecto; ISA 5.1 y "Empresa cliente" seleccionables)
        // Todos se dibujan en un cuadro local de 50×50 con la línea de proceso a y = 25; los puertos
        // imantados están en TIPOS[subtipo].puertos.
        // ==================================================================================
        // Bomba centrífuga: cuerpo Ø28 y tubuladuras de aspiración (a la izquierda, puerto 'succion') e
        // impulsión (a la derecha, puerto 'descarga') con su brida; letras A / I bajo cada conexión.
        function simboloBomba(c, P) {
            const ln = (x1, y1, x2, y2, w = 1.6) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${c}" stroke-width="${w}" stroke-linecap="round"/>`;
            return `<circle cx="25" cy="25" r="14" fill="${P.relleno}" stroke="${c}" stroke-width="1.8"/>` +
                `<polygon points="20,17.5 33,25 20,32.5" fill="none" stroke="${c}" stroke-width="1.5" stroke-linejoin="round"/>` +
                ln(5, 25, 11, 25, 2) + ln(39, 25, 45, 25, 2) + ln(7, 21.5, 7, 28.5, 1.6) + ln(43, 21.5, 43, 28.5, 1.6) +
                `<text x="7" y="35" font-family="sans-serif" font-size="5" font-weight="bold" fill="${c}" text-anchor="middle">A</text>` +
                `<text x="43" y="35" font-family="sans-serif" font-size="5" font-weight="bold" fill="${c}" text-anchor="middle">I</text>`;
        }
        function simboloSVG(el, c, P) {
            const sw = 1.6, st = `stroke="${c}" stroke-width="${sw}" fill="${P.relleno}" stroke-linejoin="round"`;
            const ln = (x1, y1, x2, y2, w = sw) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${c}" stroke-width="${w}" stroke-linecap="round"/>`;
            const stubs = ln(10, 25, 12, 25) + ln(38, 25, 40, 25);
            const lazo = `<polygon points="12,15 12,35 25,25" ${st}/><polygon points="38,15 38,35 25,25" ${st}/>`;
            const isa = opciones.norma === 'ISA';
            switch (el.subtype) {
                // --- válvulas (formas de ISO 10628-2 facilitadas por José) ---
                case 'globo':
                    return stubs + lazo + (isa ? `<circle cx="25" cy="25" r="3.2" fill="${c}"/>` : '');
                case 'bola':
                    return stubs + lazo + (isa ? `<circle cx="25" cy="25" r="4" fill="${P.relleno}" stroke="${c}" stroke-width="${sw}"/>` : `<circle cx="25" cy="25" r="4" fill="${c}"/>`);
                case 'compuerta':
                    return stubs + lazo + (isa ? '' : ln(25, 12, 25, 38));
                case 'mariposa':
                    return ln(10, 25, 13, 25) + ln(37, 25, 40, 25) + `<rect x="13" y="16" width="24" height="18" ${st}/>` + ln(13, 34, 37, 16) + `<circle cx="25" cy="25" r="2.8" fill="${c}"/>`;
                case 'retencion':
                    return stubs + lazo + ln(35, 17.3, 35, 32.7);
                case 'control':
                    return stubs + lazo + ln(25, 25, 25, 6) + `<path d="M 16 6 L 16 1 A 9 6 0 0 1 34 1 L 34 6 Z" ${st}/>` + `<text x="25" y="4.8" font-family="sans-serif" font-size="4.5" font-weight="bold" fill="${c}" text-anchor="middle">C</text>`;
                case 'neumatica':
                    // actuador de diafragma sobre vástago largo
                    return stubs + lazo + ln(25, 25, 25, 3) + `<path d="M 16 3 L 16 -2 A 9 6 0 0 1 34 -2 L 34 3 Z" ${st}/>`;
                case 'membrana':
                    return stubs + lazo + `<path d="M 18 14 Q 25 6 32 14" fill="none" stroke="${c}" stroke-width="${sw}"/>` + ln(25, 10, 25, 4) + ln(21, 4, 29, 4);
                case 'macho':
                    return stubs + lazo + `<rect x="22.5" y="18" width="5" height="14" fill="${c}"/>`;
                case 'tajadera':
                    return stubs + lazo + `<rect x="23.8" y="5" width="2.4" height="20" fill="${c}"/>`;
                case 'aguja':
                    return stubs + lazo + `<polygon points="22,13 28,13 25,23" fill="${c}"/>` + ln(25, 13, 25, 5);
                case 'seguridad':
                case 'alivio': {
                    const muelle = el.subtype === 'seguridad' ? '25,25 25,21 20,19 30,15 20,11 30,7 25,5 25,2' : '25,25 25,20 21,18 29,14 21,10 25,8';
                    return ln(25, 45, 25, 38) + `<polygon points="19,38 31,38 25,25" ${st}/><polygon points="38,19 38,31 25,25" ${st}/>` + ln(38, 25, 40, 25) +
                        `<polyline points="${muelle}" fill="none" stroke="${c}" stroke-width="1.3"/>`;
                }
                // --- accesorios ---
                case 'codo90':
                    return `<path d="M 15 35 L 15 15 L 35 15" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
                case 'codo45':
                case 'codo60': {
                    const pb = TIPOS[el.subtype].puertos[1];
                    return `<path d="M 10 25 L 25 25 L ${pb.x} ${pb.y}" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
                }
                case 'continuacion': { // bandera "continúa en hoja xx"
                    const dst = String(el.hojaDestino || '?'), g = ((el.rotation || 0) % 360 + 360) % 360, inv = g > 90 && g < 270;
                    return ln(10, 25, 16, 25, 2) + `<polygon points="16,17 34,17 42,25 34,33 16,33" ${st}/>` +
                        `<text x="28" y="27.6" font-family="sans-serif" font-size="7.5" font-weight="bold" fill="${c}" text-anchor="middle" ${inv ? 'transform="rotate(180 28 25)"' : ''}>${esc(dst)}</text>`;
                }
                case 'tee':
                    return ln(10, 25, 40, 25, 2) + ln(25, 25, 25, 40, 2);
                case 'cruce':
                    return ln(10, 25, 40, 25, 2) + ln(25, 10, 25, 40, 2);
                case 'injerto':
                    return ln(10, 25, 40, 25, 2) + ln(25, 25, 25, 10, 1.6) + `<circle cx="25" cy="25" r="2.2" fill="${c}"/>`;
                case 'reduccion': {
                    const pts = el.excentrica ? '12,14 38,22 38,35 12,35' : '12,14 38,20 38,30 12,36';
                    return stubs + `<polygon points="${pts}" ${st}/>`;
                }
                case 'junta':   // fuelle
                    return ln(10, 25, 15, 25) + ln(35, 25, 40, 25) + `<polyline points="15,17 15,33 18,17 21,33 24,17 27,33 30,17 33,33 35,17 35,33" fill="none" stroke="${c}" stroke-width="1.3"/>`;
                case 'antivibratorio':
                    return ln(10, 25, 14, 25) + ln(36, 25, 40, 25) + `<rect x="14" y="17" width="22" height="16" rx="6" ${st}/>` + `<path d="M 17 25 q 2 -4 4 0 t 4 0 t 4 0 t 4 0" fill="none" stroke="${c}" stroke-width="1.2"/>`;
                case 'filtro':
                    return ln(10, 25, 13, 25) + ln(37, 25, 40, 25) + `<polygon points="25,13 37,25 25,37 13,25" ${st}/>` + `<line x1="25" y1="13" x2="25" y2="37" stroke="${c}" stroke-width="1.2" stroke-dasharray="2,1.5"/>`;
                case 'strainer':
                    return ln(10, 25, 40, 25, 2) + `<polygon points="20,25 30,25 36,37 26,37" ${st}/>` + `<line x1="24" y1="28" x2="32" y2="35" stroke="${c}" stroke-width="1" stroke-dasharray="1.5,1.5"/>`;
                case 'manguito':
                    return ln(10, 25, 17, 25, 2) + ln(33, 25, 40, 25, 2) + `<rect x="17" y="20" width="16" height="10" ${st}/>`;
                case 'tuerca':
                    return ln(10, 25, 18, 25, 2) + ln(32, 25, 40, 25, 2) + ln(18, 18, 18, 32) + ln(32, 18, 32, 32) + `<polygon points="21,20 29,20 31,25 29,30 21,30 19,25" ${st}/>`;
                case 'machon':
                    return ln(10, 25, 17, 25, 2) + ln(33, 25, 40, 25, 2) + `<polygon points="19,19 31,19 34,25 31,31 19,31 16,25" ${st}/>`;
                case 'racor':
                    return ln(10, 25, 18, 25, 2) + ln(32, 25, 40, 25, 2) + `<circle cx="21" cy="25" r="4" ${st}/><circle cx="29" cy="25" r="4" ${st}/>`;
                case 'bridaciega':   // brida ciega: como la plana, pero solo el tramo vertical (ahí termina la tubería)
                    return `<line x1="27" y1="14" x2="27" y2="36" stroke="${c}" stroke-width="2.4"/>`;
                case 'bridaunion': case 'bridawn': case 'bridaplana': case 'bridaroscada': case 'bridaloca': case 'bridaplastica': {
                    // brida simple (una sola): cara a la izquierda (puerto a, junto al centro) y tubería a la derecha (puerto b)
                    const cuello = el.subtype === 'bridawn' ? `<polygon points="34,22 28,19 28,31 34,28" ${st}/>` : '';
                    const extra = el.subtype === 'bridaloca' ? ln(31, 16, 31, 34, 1) : el.subtype === 'bridaroscada' ? `<path d="M 30 23 l 2 -2 l 2 2 l 2 -2" fill="none" stroke="${c}" stroke-width="1"/>` : '';
                    const guion = el.subtype === 'bridaplastica' ? '3,1.5' : '';
                    return ln(28, 25, 40, 25, 2) + cuello +
                        `<line x1="27" y1="14" x2="27" y2="36" stroke="${c}" stroke-width="2.4" ${guion ? `stroke-dasharray="${guion}"` : ''}/>` + extra;
                }
                // --- equipos: rectángulo con el código ---
                case 'icplacas': case 'ictubos': case 'enfcentral': case 'enfaceite': case 'enfcamisas': case 'calfuel': {
                    const cod = TIPOS[el.subtype].codigo;
                    const cuerpo = el.subtype === 'ictubos'
                        ? `<rect x="11" y="15" width="28" height="20" rx="10" ${st}/>` + ln(15, 21, 35, 21, 1) + ln(15, 29, 35, 29, 1)
                        : `<rect x="13" y="12" width="24" height="26" ${st}/>` + [17, 21, 25, 29, 33].map(x => ln(x, 14, x, 36, 0.8)).join('');
                    return ln(10, 25, 13, 25) + ln(37, 25, 40, 25) + ln(25, 5, 25, 12) + ln(25, 38, 25, 45) + cuerpo +
                        `<text x="25" y="${el.subtype === 'ictubos' ? 43 : 9.5}" dx="${el.subtype === 'ictubos' ? 9 : 9}" font-family="sans-serif" font-size="5" font-weight="bold" fill="${c}" text-anchor="start">${cod}</text>`;
                }
                case 'intercambiador': case 'enfriador': case 'enfriadora': case 'fancoil': case 'equipo': {
                    const cod = TIPOS[el.subtype].codigo;
                    const dib = el.subtype === 'intercambiador' ? `<circle cx="25" cy="25" r="11" ${st}/><polyline points="14,25 19,19 25,31 31,19 36,25" fill="none" stroke="${c}" stroke-width="1.3"/>`
                        : el.subtype === 'fancoil' ? `<rect x="13" y="15" width="24" height="20" ${st}/><polyline points="13,25 17,19 21,31 25,19 29,31 33,19 37,25" fill="none" stroke="${c}" stroke-width="1.1"/>`
                        : `<rect x="13" y="14" width="24" height="22" rx="2" ${st}/><text x="25" y="27.5" font-family="sans-serif" font-size="${cod.length > 2 ? 6 : 7.5}" font-weight="bold" fill="${c}" text-anchor="middle">${cod}</text>`;
                    return ln(10, 25, 14, 25) + ln(36, 25, 40, 25) + dib;
                }
                case 'consumo':
                    return ln(10, 25, 24, 25) + `<polygon points="24,18 38,25 24,32" fill="${c}"/><text x="31" y="41" font-family="sans-serif" font-size="6" font-weight="bold" fill="${c}" text-anchor="middle">Q</text>`;
                case 'deposito': case 'tkalmacen': case 'tkdiario': case 'tksedim': case 'tkexp': case 'tkreboses': case 'tkagua': case 'hidroforo': {
                    const cod = TIPOS[el.subtype].codigo;
                    const cuerpo = el.subtype === 'hidroforo'
                        ? `<rect x="8" y="8" width="28" height="36" rx="12" ${st}/>`
                        : `<path d="M 8 8 L 8 40 Q 8 44 12 44 L 32 44 Q 36 44 36 40 L 36 8 Z" ${st}/>`;
                    return cuerpo + `<line x1="10" y1="17" x2="34" y2="17" stroke="${c}" stroke-width="1" stroke-dasharray="3,1.5"/>` +
                        `<polygon points="28,14 30,17 26,17" fill="${c}"/>` + ln(36, 25, 40, 25) + ln(22, 2, 22, 8) +
                        `<text x="22" y="34" font-family="sans-serif" font-size="6" font-weight="bold" fill="${c}" text-anchor="middle">${cod}</text>`;
                }
                // --- instrumentos: globo con el código ---
                case 'nota':
                    return `<rect x="10" y="12" width="30" height="26" fill="${P.relleno}" stroke="${c}" stroke-width="1.2"/>` + ln(14, 20, 36, 20, 1) + ln(14, 25, 36, 25, 1) + ln(14, 30, 30, 30, 1);
                case 'materiales':
                    return `<rect x="8" y="10" width="34" height="30" fill="${P.relleno}" stroke="${c}" stroke-width="1.2"/>` + [17, 24, 31].map(y => ln(8, y, 42, y, 0.8)).join('') + ln(16, 10, 16, 40, 0.8);
                case 'leyenda':
                    return `<rect x="8" y="10" width="34" height="30" fill="${P.relleno}" stroke="${c}" stroke-width="1.2"/>` + ln(12, 17, 18, 17, 1.5) + ln(21, 17, 38, 17, 0.8) + `<circle cx="15" cy="25" r="3" fill="none" stroke="${c}"/>` + ln(21, 25, 38, 25, 0.8) + `<polygon points="12,30 18,33 12,36" fill="${c}"/>` + ln(21, 33, 38, 33, 0.8);
                case 'purgador':
                    return ln(25, 45, 25, 30) + `<rect x="18" y="16" width="14" height="14" rx="2" ${st}/>` + ln(25, 16, 25, 9) + `<polygon points="21,10 29,10 25,5" fill="${c}"/>`;
                case 'drenaje':
                    return ln(25, 5, 25, 18) + `<polygon points="19,18 31,18 25,28" ${st}/><polygon points="19,38 31,38 25,28" ${st}/>` + ln(25, 38, 25, 44) + `<polyline points="20,44 25,48 30,44" fill="none" stroke="${c}" stroke-width="1.2"/>`;
                case 'vasoexp':
                    return ln(25, 45, 25, 36) + `<path d="M 13 36 L 13 16 A 12 8 0 0 1 37 16 L 37 36 Z" ${st}/>` + ln(13, 24, 37, 24, 1) + `<text x="25" y="33" font-family="sans-serif" font-size="6" font-weight="bold" fill="${c}" text-anchor="middle">VE</text>`;
                case 'tomapresion': case 'manometro': case 'vacuometro': case 'portainstr': {
                    const cod = TIPOS[el.subtype].codigo;
                    const cuerpo = el.subtype === 'portainstr'
                        ? `<rect x="19" y="10" width="12" height="16" ${st}/>`
                        : `<circle cx="25" cy="17" r="9" ${st}/><text x="25" y="19.5" font-family="sans-serif" font-size="6.5" font-weight="bold" fill="${c}" text-anchor="middle">${cod}</text>`;
                    return ln(25, 45, 25, el.subtype === 'portainstr' ? 26 : 26) + cuerpo;
                }
            }
            return stubs + lazo;
        }

        // ---------- Anotaciones: notas de texto y leyenda automática de símbolos ----------
        function dibujoAnotacion(el, c, P) {
            const fs = +el.tamTexto > 0 ? +el.tamTexto : 7;
            if (el.subtype === 'nota') {
                const lineasTxt = String(el.texto || 'Nota').split('\n');
                const w = Math.max(40, ...lineasTxt.map(t => t.length * fs * 0.55)) + 8, h = lineasTxt.length * fs * 1.25 + 6;
                return (el.marco !== false ? `<rect x="0" y="0" width="${w}" height="${h}" fill="${P.relleno}" fill-opacity="0.85" stroke="${c}" stroke-width="0.8" stroke-dasharray="${el.marco === 'discontinuo' ? '3,2' : ''}"/>` : `<rect x="0" y="0" width="${w}" height="${h}" fill="transparent"/>`) +
                    lineasTxt.map((t, i) => `<text x="4" y="${4 + fs * (i + 1) * 1.15}" font-family="sans-serif" font-size="${fs}" fill="${c}">${esc(t)}</text>`).join('');
            }
            if (el.subtype === 'tabla') return dibujoTabla(el, c, P);
            if (el.subtype === 'materiales') return dibujoListado(c, P);
            return dibujoLeyenda(c, P);
        }
        // ---------- Listado y leyenda de componentes: textos en mm (título 4 mm negrita, resto 3 mm, mayúsculas) ----------
        const MM = v => v * PX_MM;
        const TXT_MM = 3, TIT_MM = 4;
        const recortarA = (t, fs, w, neg) => { t = String(t || ''); ctxMedida.font = `${neg ? 'bold ' : ''}${fs}px sans-serif`; if (ctxMedida.measureText(t).width <= w) return t; while (t.length > 1 && ctxMedida.measureText(t + '…').width > w) t = t.slice(0, -1); return t + '…'; };
        // columnas en mm para un cajetín de 180 mm; se escalan al ancho real del cajetín (190 mm en A4)
        const COLS_LISTADO_180 = [['ITEM', 11], ['CANTIDAD', 19], ['DESCRIPCIÓN', 66], ['TAMAÑO', 21], ['PN / RATING', 23], ['MATERIAL', 40]];
        let COLS_LISTADO = COLS_LISTADO_180;
        function geomListado() {
            const k = anchoCajetinMm() / 180; COLS_LISTADO = COLS_LISTADO_180.map(([n, w]) => [n, w * k]);
            const filas = filasListadoPlano(), W = MM(COLS_LISTADO.reduce((s, c) => s + c[1], 0)), hT = MM(8), hC = MM(6), hF = MM(6);
            return { filas, W, hT, hC, hF, H: hT + hC + Math.max(1, filas.length) * hF };
        }
        function dibujoListado(c, P) {
            const g = geomListado(), fs = MM(TXT_MM), ft = MM(TIT_MM), F = `font-family="sans-serif" fill="${c}"`;
            const tx = (x, y, t, o = '') => `<text x="${x.toFixed(2)}" y="${y.toFixed(2)}" font-size="${fs.toFixed(2)}" ${F} ${o}>${esc(t)}</text>`;
            const Lh = (y, w) => `<line x1="0" y1="${y.toFixed(2)}" x2="${g.W.toFixed(2)}" y2="${y.toFixed(2)}" stroke="${c}" stroke-width="${w}"/>`;
            let h = `<rect x="0" y="0" width="${g.W.toFixed(2)}" height="${g.H.toFixed(2)}" fill="${P.relleno}" stroke="${c}" stroke-width="0.9"/>`;
            h += `<text x="${(g.W / 2).toFixed(2)}" y="${(g.hT / 2 + ft * 0.36).toFixed(2)}" font-size="${ft.toFixed(2)}" font-weight="bold" text-anchor="middle" ${F}>${esc(tradMayDoc('LISTADO DE COMPONENTES'))}</text>`;
            h += Lh(g.hT, 0.7) + Lh(g.hT + g.hC, 0.7);
            let x = 0; const xs = COLS_LISTADO.map(([, w]) => { const x0 = x; x += MM(w); return [x0, MM(w)]; });
            const yC = g.hT + g.hC / 2 + fs * 0.36;
            COLS_LISTADO.forEach(([n], k) => { const [x0, w] = xs[k]; h += tx(x0 + w / 2, yC, tradMayDoc(n), 'font-weight="bold" text-anchor="middle"') + (k ? `<line x1="${x0.toFixed(2)}" y1="${g.hT.toFixed(2)}" x2="${x0.toFixed(2)}" y2="${g.H.toFixed(2)}" stroke="${c}" stroke-width="0.45"/>` : ''); });
            g.filas.forEach((f, i) => {
                const y0 = g.hT + g.hC + i * g.hF, y = y0 + g.hF / 2 + fs * 0.36;
                const vals = [String(i + 1), f.ud === 'm' ? String(Math.round(f.n * 1000)) : String(f.n), f.desc, f.tam, f.pn, f.mat].map(v => String(v || '').toUpperCase());
                vals.forEach((v, k) => { const [x0, w] = xs[k]; const cen = k !== 2 && k !== 5; h += tx(cen ? x0 + w / 2 : x0 + MM(1.5), y, recortarA(v, fs, w - MM(3)), cen ? 'text-anchor="middle"' : ''); });
                if (i) h += Lh(y0, 0.3);
            });
            if (!g.filas.length) h += tx(MM(1.5), g.hT + g.hC + g.hF / 2 + fs * 0.36, tradMayDoc('SIN COMPONENTES'), 'font-style="italic"');
            // punto de enganche: esquina inferior derecha (se imanta a la esquina superior derecha del cajetín)
            return h + `<circle class="punto-enganche" cx="${g.W.toFixed(2)}" cy="${g.H.toFixed(2)}" r="2.2" fill="#2563eb" stroke="#fff" stroke-width="0.6"/>`;
        }
        // un renglón por tipo de componente (todas las tuberías en uno), solo con la definición
        function usadosLeyenda() { return [...new Map(elementosRed.filter(e => !esAnotacion(e)).map(e => [e.type === 'tuberia' ? 'tub' : e.type === 'bomba' ? 'bomba' : e.subtype + (e.subtype === 'reduccion' && e.excentrica ? 'E' : ''), e])).values()]; }
        const nombreLeyenda = e => tradDoc(e.type === 'tuberia' ? 'Tubería' : e.type === 'bomba' ? 'Bomba centrífuga' : e.subtype === 'codo90' ? 'Codo' : nombreTipo(e)).toUpperCase();
        function geomLeyenda() {
            const us = usadosLeyenda(), fs = MM(TXT_MM), ft = MM(TIT_MM), hT = MM(8), hF = MM(9), xT = MM(14);
            ctxMedida.font = `bold ${ft}px sans-serif`; const wt = ctxMedida.measureText(tradMayDoc('LEYENDA DE COMPONENTES')).width + MM(8);
            const wf = Math.max(0, ...us.map(e => { ctxMedida.font = `${fs}px sans-serif`; return ctxMedida.measureText(nombreLeyenda(e)).width; })) + xT + MM(3);
            const W = Math.max(MM(80), wt, wf);
            return { us, W, hT, hF, xT, H: hT + Math.max(1, us.length) * hF + MM(1) };
        }
        function dibujoLeyenda(c, P) {
            const g = geomLeyenda(), fs = MM(TXT_MM), ft = MM(TIT_MM), F = `font-family="sans-serif" fill="${c}"`;
            let h = `<rect x="0" y="0" width="${g.W.toFixed(2)}" height="${g.H.toFixed(2)}" fill="${P.relleno}" stroke="${c}" stroke-width="0.9"/>` +
                `<text x="${(g.W / 2).toFixed(2)}" y="${(g.hT / 2 + ft * 0.36).toFixed(2)}" font-size="${ft.toFixed(2)}" font-weight="bold" text-anchor="middle" ${F}>${esc(tradMayDoc('LEYENDA DE COMPONENTES'))}</text>` +
                `<line x1="0" y1="${g.hT.toFixed(2)}" x2="${g.W.toFixed(2)}" y2="${g.hT.toFixed(2)}" stroke="${c}" stroke-width="0.7"/>`;
            const esc_ = MM(7) * 1.25 / 50; // símbolos un 25 % mayores que en 7.9
            g.us.forEach((e, i) => {
                const y0 = g.hT + i * g.hF, ym = y0 + g.hF / 2;
                const sim = e.type === 'tuberia' ? `<line x1="${MM(1.5).toFixed(2)}" y1="${ym.toFixed(2)}" x2="${(g.xT - MM(1.5)).toFixed(2)}" y2="${ym.toFixed(2)}" stroke="${P.base}" stroke-width="2"/>`
                    : `<g transform="translate(${(g.xT / 2 - 25 * esc_).toFixed(2)} ${(ym - 25 * esc_).toFixed(2)}) scale(${esc_.toFixed(3)})">${(e.type === 'bomba' ? simboloBomba(P.base, P) : simboloSVG(e, P.base, P)).replace(/<text[\s\S]*?<\/text>/g, '')}</g>`; // sin códigos dentro del símbolo
                h += sim + `<text x="${g.xT.toFixed(2)}" y="${(ym + fs * 0.36).toFixed(2)}" font-size="${fs.toFixed(2)}" ${F}>${esc(nombreLeyenda(e))}</text>`;
            });
            if (!g.us.length) h += `<text x="${MM(1.5).toFixed(2)}" y="${(g.hT + g.hF / 2 + fs * 0.36).toFixed(2)}" font-size="${fs.toFixed(2)}" font-style="italic" ${F}>${esc(tradMayDoc('SIN COMPONENTES'))}</text>`;
            // punto de enganche: esquina superior derecha (se imanta a la esquina superior derecha de la zona de trabajo)
            return h + `<circle class="punto-enganche" cx="${g.W.toFixed(2)}" cy="0" r="2.2" fill="#2563eb" stroke="#fff" stroke-width="0.6"/>`;
        }
        // ---------- Enganche de las dos tablas a la hoja ----------
        // Listado: esquina inferior derecha ↔ esquina superior derecha del cajetín. Leyenda: esquina superior
        // derecha ↔ esquina superior derecha de la zona de trabajo (marco). Posición = punto de enganche + offHoja
        // (0,0 = enganchada); al cambiar de formato se recolocan solas. Solo se mueven con Mover / Desconectar.
        const esTablaHoja = el => el && el.type === 'anotacion' && (el.subtype === 'materiales' || el.subtype === 'leyenda');
        function enganchesTabla(el) {
            // con el cajetín oculto el listado ocupa su posición (esquina inferior derecha del marco)
            if (el.subtype === 'materiales') { const g = geomListado(), cj = cajaCajetin(); return { W: g.W, H: g.H, ax: cj.x1, ay: opciones.cajetin === false ? cj.y1 : cj.y0, px: g.W, py: g.H, dest: opciones.cajetin === false ? 'sitio del cajetín' : 'cajetín' }; }
            const g = geomLeyenda(), fr = marcoInterior(); return { W: g.W, H: g.H, ax: fr.x1, ay: fr.y0, px: g.W, py: 0, dest: 'marco (esquina superior derecha)' };
        }
        const RADIO_ENGANCHE = 15; // px
        function recolocarTablasHoja() {
            elementosRed.filter(esTablaHoja).forEach(el => {
                if (isDraggingSymbol && activeSymbolId === el.id && el._suelto) return;
                const q = enganchesTabla(el);
                el.scale = 1; el.rotation = 0;
                if (!el.offHoja) { // dibujos anteriores: se conserva su posición (o se engancha si está cerca)
                    const dx = el.x + q.px - q.ax, dy = mundoAScreenY(el.y) + q.py - q.ay;
                    el.offHoja = Math.hypot(dx, dy) < 40 ? { dx: 0, dy: 0 } : { dx: +dx.toFixed(1), dy: +dy.toFixed(1) };
                }
                el.x = q.ax - q.px + el.offHoja.dx; el.y = screenAMundoY(q.ay - q.py + el.offHoja.dy);
            });
        }
        // Arrastre libre (tras Mover / Desconectar) con imán al punto de enganche
        function moverTablaHoja(el, dx, dy) {
            const q = enganchesTabla(el);
            el._raw = el._raw || { x: el.x, sy: mundoAScreenY(el.y) };
            el._raw.x += dx; el._raw.sy += dy;
            const ox = el._raw.x + q.px - q.ax, oy = el._raw.sy + q.py - q.ay, pega = Math.hypot(ox, oy) < RADIO_ENGANCHE;
            el.offHoja = pega ? { dx: 0, dy: 0 } : { dx: +ox.toFixed(1), dy: +oy.toFixed(1) };
            el.x = q.ax - q.px + el.offHoja.dx; el.y = screenAMundoY(q.ay - q.py + el.offHoja.dy);
        }
        function soltarTablaHoja(el) {
            delete el._raw; delete el._suelto;
            const q = enganchesTabla(el);
            const lis = el.subtype === 'materiales';
            aviso(el.offHoja && !el.offHoja.dx && !el.offHoja.dy ? `${lis ? 'Listado enganchado' : 'Leyenda enganchada'} al ${q.dest}.` : `${lis ? 'Listado suelto' : 'Leyenda suelta'}: se mantiene a la misma distancia del ${q.dest} al cambiar de formato.`);
        }
        // ==================================================================================
        // FORMATO DE LA HOJA (A4 vertical; A3…A0 apaisados) Y REJILLA
        // 1 unidad de dibujo = 1 px a 96 ppp. Marco ISO 5457: 20 mm a la izquierda (encuadernación) y
        // 10 mm en los demás lados; referencias por zonas fuera del marco: letras (sin I ni O) desde la
        // esquina inferior izquierda hacia arriba y números de mayor (izquierda) a 1 (derecha).
        // ==================================================================================
        const PX_MM = 96 / 25.4;
        const FORMATOS = { A4: { w: 210, h: 297, cols: 4, filas: 6 }, // A4 vertical (A3 girado 90° antihorario): letras en Y, números en X
             A3: { w: 420, h: 297, cols: 8, filas: 6 }, A2: { w: 594, h: 420, cols: 12, filas: 8 },
            A1: { w: 841, h: 594, cols: 16, filas: 12 }, A0: { w: 1189, h: 841, cols: 24, filas: 18 } };
        const LETRAS_ZONA = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
        const formatoActual = () => FORMATOS[opciones.formato] || FORMATOS.A3;
        const MARGEN_IZQ = 10, MARGEN = 10, BANDA = 6; // mm (marco a 10 mm, línea exterior de referencias a 4 mm del borde)
        function marcoInterior() { return { x0: MARGEN_IZQ * PX_MM, y0: MARGEN * PX_MM, x1: ANCHO_A3 - MARGEN * PX_MM, y1: ALTO_A3 - MARGEN * PX_MM }; }
        function aplicarFormato() {
            const f = formatoActual();
            ANCHO_A3 = Math.round(f.w * PX_MM); ALTO_A3 = Math.round(f.h * PX_MM); ALTO_MUNDO = ALTO_A3;
            marcoA3.style.width = ANCHO_A3 + 'px'; marcoA3.style.height = ALTO_A3 + 'px';
            let st = document.getElementById('estilo-impresion');
            if (!st) { st = document.createElement('style'); st.id = 'estilo-impresion'; document.head.appendChild(st); }
            st.textContent = `@media print { @page { size: ${opciones.formato || 'A3'} ${f.w < f.h ? 'portrait' : 'landscape'}; margin: 0; } #marco-a3 { width: ${f.w}mm !important; height: ${f.h}mm !important; } .punto-enganche { display: none; } }`;
            aplicarZoom();
        }
        // Cambio de formato: el dibujo conserva sus coordenadas (origen abajo a la izquierda); no se
        // permite pasar a una hoja en la que no cabe.
        function cambiarFormato(fmt) {
            if (!FORMATOS[fmt] || fmt === (opciones.formato || 'A3')) return;
            const f = FORMATOS[fmt], W = Math.round(f.w * PX_MM), H = Math.round(f.h * PX_MM);
            let xMax = 0, yMax = 0;
            elementosRed.forEach(el => { if (esTablaHoja(el)) return; const g = svgCanvas.querySelector(`g[data-id="${el.id}"]`); if (!g) return;
                const r = g.getBoundingClientRect(), rM = marcoA3.getBoundingClientRect(), esc = rM.width / ANCHO_A3;
                xMax = Math.max(xMax, (r.right - rM.left) / esc); yMax = Math.max(yMax, ALTO_A3 - (r.top - rM.top) / esc); });
            if (xMax > W - MARGEN * PX_MM || yMax > H - MARGEN * PX_MM) {
                const cabe = Object.entries(FORMATOS).find(([, g]) => xMax <= g.w * PX_MM - MARGEN * PX_MM && yMax <= g.h * PX_MM - MARGEN * PX_MM);
                aviso(`El dibujo no cabe en ${fmt} (${f.w} × ${f.h} mm). Formato mínimo: ${cabe ? cabe[0] : 'A0'}.`, 'error'); return;
            }
            guardarEstado();
            opciones.formato = fmt; aplicarFormato(); renderizarVectorial(); zoomTodo(); renderArbol();
            aviso(`Formato ${fmt} (${f.w} × ${f.h} mm).`);
        }
        // Marco de la hoja (modelo A3 facilitado por José): línea fina exterior de
        // referencias, marco grueso, divisiones de zona entre ambas, números arriba y abajo (de mayor a 1),
        // letras a izquierda y derecha (A abajo) y marcas de centrado que entran 5 mm en el marco.
        function dibujoFormato(P) {
            const f = formatoActual(), m = v => v * PX_MM, F = FONDOS[opciones.fondo] || FONDOS.papel;
            const col = F.oscuro ? '#cbd5e1' : '#1a1a1a', fr = marcoInterior();
            const b = { x0: fr.x0 - m(BANDA), y0: fr.y0 - m(BANDA), x1: fr.x1 + m(BANDA), y1: fr.y1 + m(BANDA) };
            const L = (x1, y1, x2, y2, w) => `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${col}" stroke-width="${w}"/>`;
            const T = (x, y, t) => `<text x="${x.toFixed(1)}" y="${(y + m(1.3)).toFixed(1)}" font-family="'Century Gothic', 'Avenir', 'Segoe UI', sans-serif" font-size="${m(3.6).toFixed(1)}" fill="${col}" text-anchor="middle">${t}</text>`;
            let h = '';
            // rejilla: líneas discontinuas finas (menores) y algo más marcadas (mayores)
            if (opciones.rejillaVisible !== false) {
                const may = m(+opciones.rejillaMayor > 0 ? +opciones.rejillaMayor : 10), n = Math.max(1, Math.round(+opciones.rejillaMenores || 2)), men = may / n;
                const cMen = F.oscuro ? "#3f4856" : "#bab8ac", cMay = F.oscuro ? '#5b6676' : '#a9a699';
                let pat = '';
                for (let i = 1; i < n; i++) pat += `<line x1="${(i * men).toFixed(2)}" y1="0" x2="${(i * men).toFixed(2)}" y2="${may.toFixed(2)}" stroke="${cMen}" stroke-width="0.45" stroke-dasharray="2.2,2.2"/><line x1="0" y1="${(i * men).toFixed(2)}" x2="${may.toFixed(2)}" y2="${(i * men).toFixed(2)}" stroke="${cMen}" stroke-width="0.45" stroke-dasharray="2.2,2.2"/>`;
                pat += `<line x1="0" y1="0" x2="${may.toFixed(2)}" y2="0" stroke="${cMay}" stroke-width="0.6" stroke-dasharray="3.5,2"/><line x1="0" y1="0" x2="0" y2="${may.toFixed(2)}" stroke="${cMay}" stroke-width="0.6" stroke-dasharray="3.5,2"/>`;
                h += `<defs><pattern id="patron-rejilla" patternUnits="userSpaceOnUse" x="${fr.x0.toFixed(2)}" y="${fr.y1.toFixed(2)}" width="${may.toFixed(2)}" height="${may.toFixed(2)}">${pat}</pattern></defs>` +
                    `<rect id="rejilla" x="${fr.x0.toFixed(1)}" y="${fr.y0.toFixed(1)}" width="${(fr.x1 - fr.x0).toFixed(1)}" height="${(fr.y1 - fr.y0).toFixed(1)}" fill="url(#patron-rejilla)"/>`;
            }
            h += `<rect x="${b.x0.toFixed(1)}" y="${b.y0.toFixed(1)}" width="${(b.x1 - b.x0).toFixed(1)}" height="${(b.y1 - b.y0).toFixed(1)}" fill="none" stroke="${col}" stroke-width="${m(0.35).toFixed(2)}"/>`;
            h += `<rect x="${fr.x0.toFixed(1)}" y="${fr.y0.toFixed(1)}" width="${(fr.x1 - fr.x0).toFixed(1)}" height="${(fr.y1 - fr.y0).toFixed(1)}" fill="none" stroke="${col}" stroke-width="${m(0.8).toFixed(2)}"/>`;
            // zonas: divisiones sobre la línea exterior (de ella al marco), repartidas entre los extremos del marco
            const dx = (fr.x1 - fr.x0) / f.cols, dy = (fr.y1 - fr.y0) / f.filas;
            for (let i = 0; i <= f.cols; i++) { const x = fr.x0 + i * dx; if (i > 0 && i < f.cols) h += L(x, b.y0, x, fr.y0, m(0.35)) + L(x, fr.y1, x, b.y1, m(0.35)); if (i < f.cols) { const t = f.cols - i, xc = x + dx / 2; h += T(xc, (b.y0 + fr.y0) / 2, t) + T(xc, (b.y1 + fr.y1) / 2, t); } }
            for (let j = 0; j <= f.filas; j++) { const y = fr.y1 - j * dy; if (j > 0 && j < f.filas) h += L(b.x0, y, fr.x0, y, m(0.35)) + L(fr.x1, y, b.x1, y, m(0.35)); if (j < f.filas) { const t = LETRAS_ZONA[j] || '?', yc = y - dy / 2; h += T((b.x0 + fr.x0) / 2, yc, t) + T((b.x1 + fr.x1) / 2, yc, t); } }
            // marcas de centrado: de la línea exterior hasta 5 mm dentro del marco
            const cx = (fr.x0 + fr.x1) / 2, cy = (fr.y0 + fr.y1) / 2, e = m(5), w = m(0.5);
            // la marca inferior no entra en el marco si cae sobre el aviso de propiedad (junto al cajetín)
            const av = opciones.cajetin !== false && typeof cajaAvisoPropiedad === 'function' ? cajaAvisoPropiedad() : null, tapa = av && cx > av.x0 - e && cx < av.x0 + av.w + e && av.y0 + av.h > fr.y1 - e - 1;
            h += L(cx, b.y0, cx, fr.y0 + e, w) + L(cx, tapa ? fr.y1 : fr.y1 - e, cx, b.y1, w) + L(b.x0, cy, fr.x0 + e, cy, w) + L(fr.x1 - e, cy, b.x1, cy, w);
            if (opciones.cajetin !== false) h += dibujoCajetin(col, fr) + dibujoAvisoPropiedad(fr);
            return h;
        }
        // ---------- Cajetín (modelo facilitado por José): solo líneas y textos, sin fondo ----------
        // Geometría en unidades del modelo (1830 × 553) escalada a 180 mm de ancho, en la esquina inferior
        // derecha del marco. Los valores salen de Archivo > Datos del proyecto (apartado Cajetín).
        const CAJETIN_ANCHO_MM = 180, CAJ_W = 1830, CAJ_H = 553;
        // en A4 (vertical) el cajetín ocupa todo el ancho útil de la hoja (entre márgenes del marco)
        const anchoCajetinMm = () => (opciones.formato === 'A4' ? formatoActual().w - MARGEN_IZQ - MARGEN : CAJETIN_ANCHO_MM);
        // fecha del cajetín en formato dd/mm/aaaa (admite aaaa-mm-dd y d/m/aa)
        function fechaDMA(f) {
            f = String(f || '').trim(); if (!f) return '';
            let m = f.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); if (m) return `${m[3].padStart(2, '0')}/${m[2].padStart(2, '0')}/${m[1]}`;
            m = f.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/); if (m) return `${m[1].padStart(2, '0')}/${m[2].padStart(2, '0')}/${m[3].length === 2 ? '20' + m[3] : m[3]}`;
            return f;
        }
        function cajaCajetin() { const fr = marcoInterior(), k = anchoCajetinMm() * PX_MM / CAJ_W; return { x0: fr.x1 - CAJ_W * k, y0: fr.y1 - CAJ_H * k, x1: fr.x1, y1: fr.y1, k }; }
        // ---------- Aviso de propiedad junto al cajetín: texto de 1,5 mm en la capa Tratt ----------
        // A3/A2…: recuadro a la izquierda del cajetín, apoyado en su borde inferior. A4: encima del cajetín, a la izquierda.
        const AVISO_PROPIEDAD = 'Esta aplicación está licenciada bajo Safe Creative, toda la información contenida en el mismo, no puede ser reproducida, revelada, transmitida o hecha pública de cualquier otra forma sin la autorización escrita del propietario, cualquier persona en posesión de este documento reconoce su obligación de tratarlo confidencialmente.';
        const AVISO_ANCHO_MM = 58, AVISO_TXT_MM = 1.5;
        function cajaAvisoPropiedad() {
            const c = cajaCajetin(), fs = MM(AVISO_TXT_MM), pad = MM(1.5), w = MM(AVISO_ANCHO_MM);
            ctxMedida.font = `${fs}px sans-serif`;
            const lineas = []; let ln = '';
            String(tradDoc(AVISO_PROPIEDAD)).split(/\s+/).forEach(p => { const pr = ln ? ln + ' ' + p : p; if (ctxMedida.measureText(pr).width <= w - 2 * pad || !ln) ln = pr; else { lineas.push(ln); ln = p; } });
            if (ln) lineas.push(ln);
            const h = lineas.length * fs * 1.3 + 2 * pad - fs * 0.3;
            const a4 = opciones.formato === 'A4';
            return { x0: a4 ? c.x0 : c.x0 - w, y0: a4 ? c.y0 - h : c.y1 - h, w, h, fs, pad, lineas, a4 };
        }
        function dibujoAvisoPropiedad(fr) {
            const capa = capasActuales().find(x => x.nombre === 'Tratt');
            if (!capa || capa.visible === false || capa.inutilizada) return '';
            const b = cajaAvisoPropiedad(), col = hexRGB(capa.color), op = capa.transparencia ? ` opacity="${(1 - capa.transparencia / 100).toFixed(2)}"` : '';
            const sw = (0.35 * PX_MM).toFixed(2), x1 = b.x0 + b.w, y1 = b.y0 + b.h;
            const L = (xa, ya, xb, yb) => `<line x1="${xa.toFixed(2)}" y1="${ya.toFixed(2)}" x2="${xb.toFixed(2)}" y2="${yb.toFixed(2)}" stroke="${col}" stroke-width="${sw}"/>`;
            // lados libres del recuadro (el que toca el cajetín ya es su borde)
            let h = `<g id="aviso-propiedad" data-capa="Tratt"${op}>` + L(b.x0, b.y0, x1, b.y0) + (b.a4 ? L(b.x0, b.y0, b.x0, y1) + L(x1, b.y0, x1, y1) : L(b.x0, b.y0, b.x0, y1) + L(b.x0, y1, x1, y1));
            b.lineas.forEach((t, i) => { h += `<text x="${(b.x0 + b.pad).toFixed(2)}" y="${(b.y0 + b.pad + b.fs * (0.75 + i * 1.3)).toFixed(2)}" font-family="sans-serif" font-size="${b.fs.toFixed(2)}" fill="${col}">${esc(t)}</text>`; });
            return h + '</g>';
        }
        function dibujoCajetin(col, fr) {
            const c = cajaCajetin(), k = c.k, X = u => (c.x0 + u * k).toFixed(2), Y = u => (c.y0 + u * k).toFixed(2), p = proyecto || {};
            const L = (x1, y1, x2, y2) => `<line x1="${X(x1)}" y1="${Y(y1)}" x2="${X(x2)}" y2="${Y(y2)}" stroke="${col}" stroke-width="${(0.35 * PX_MM).toFixed(2)}"/>`;
            const fnt = `font-family="sans-serif" fill="${col}"`;
            const E = (x, y, t, fs = 22) => `<text x="${X(x)}" y="${Y(y)}" font-size="${(fs * k).toFixed(2)}" ${fnt}>${esc(etiquetaCajetin(t))}</text>`;
            const V = (x, y, t, fs = 34, extra = '') => t ? `<text x="${X(x)}" y="${Y(y)}" font-size="${(fs * k).toFixed(2)}" font-weight="bold" ${fnt} ${extra}>${esc(t)}</text>` : '';
            let h = `<g id="cajetin">` + `<rect x="${X(0)}" y="${Y(0)}" width="${(CAJ_W * k).toFixed(2)}" height="${(CAJ_H * k).toFixed(2)}" fill="none" stroke="${col}" stroke-width="${(0.5 * PX_MM).toFixed(2)}"/>`;
            // líneas
            h += L(0, 238, CAJ_W, 238) + L(0, 400, CAJ_W, 400) + L(0, 476, CAJ_W, 476) + L(1145, 324, CAJ_W, 324);
            h += L(1145, 0, 1145, CAJ_H) + L(1488, 238, 1488, CAJ_H);
            h += L(162, 238, 162, 400) + L(468, 238, 468, 400) + L(811, 238, 811, 400) + L(344, 400, 344, 476) + L(687, 400, 687, 476);
            // rótulos (español / inglés)
            h += E(22, 38, 'Nombre:') + E(22, 62, 'Name:');
            h += E(23, 277, 'Tamaño:') + E(23, 302, 'Size:') + E(193, 277, 'Nº de Proyecto:') + E(193, 302, 'BM code n.:') + E(489, 277, 'Plano nº:') + E(489, 302, 'Dwn nº:');
            h += E(833, 277, 'Rev:') + E(833, 302, 'Rev:') + E(996, 277, 'Letra:') + E(1022, 302, 'Ltr:');
            h += E(1163, 266, 'Dibujado por:') + E(1163, 290, 'Draw by:') + E(1505, 266, 'Fecha:') + E(1505, 290, 'Date:');
            h += E(1163, 351, 'Revisado por:') + E(1163, 375, 'Checked by:') + E(1505, 351, 'Fecha:') + E(1505, 375, 'Date:');
            h += E(22, 431, 'Escala:') + E(22, 455, 'Scale:') + E(350, 418, 'Grupo Nº:') + E(350, 438, 'Group Nr:') + E(727, 428, 'Hoja n.:') + E(727, 452, 'Sheet n.:') + E(934, 428, 'De:') + E(934, 452, 'Of:');
            h += E(1165, 431, 'Aprobado por:') + E(1165, 455, 'Approved by:') + E(1505, 431, 'Fecha:') + E(1505, 455, 'Date:');
            h += E(19, 504, 'N. de Código:') + E(19, 528, 'Ident. code n.:') + E(788, 509, 'Plano Cert. Nº:', 17) + E(798, 528, 'Dwn Cert. Nº:', 17);
            // valores
            const nombre = p.nombrePlano || [p.instalacion, p.descripcion].filter(Boolean).join(' · ');
            const tr = (t, n) => t && t.length > n ? t.slice(0, n - 1) + '…' : t;
            // nombre del plano en varias líneas (ajuste automático al ancho del recuadro "Nombre"; se reduce la letra si no cabe)
            const sub = p.nombrePlano2 || p.cliente || '';
            // el nombre empieza un poco a la derecha de la "e:" del rótulo "Nombre:"
            ctxMedida.font = `${22 * k}px sans-serif`; const xN = 22 + ctxMedida.measureText('Nombre:').width / k + 12;
            const partir = (t, fsU) => { const fpx = fsU * k, maxW = (1130 - xN) * k, out = []; let ln = '';
                ctxMedida.font = `bold ${fpx}px sans-serif`;
                String(t || '').split(/\s+/).filter(Boolean).forEach(w => { const pr = ln ? ln + ' ' + w : w; if (ctxMedida.measureText(pr).width <= maxW || !ln) ln = pr; else { out.push(ln); ln = w; } });
                if (ln) out.push(ln); return out; };
            let fsN = 44, fsS = p.nombrePlano2 ? 34 : 30, LN, LS;
            for (;;) { LN = partir(nombre, fsN); LS = sub ? partir(sub, fsS) : []; const alto = LN.length * fsN * 1.15 + LS.length * fsS * 1.2; if (alto <= 160 || fsN <= 22) break; fsN -= 2; fsS = Math.max(18, fsS - 1.5); }
            let yN = 72 + fsN * 0.95;
            LN.forEach(t => { h += V(xN, yN, t, fsN); yN += fsN * 1.15; });
            yN += fsS * 0.25; LS.forEach(t => { h += V(xN, yN + fsS * 0.2, t, fsS); yN += fsS * 1.2; });
            // texto que no cabe en su casilla: se reduce la letra (ancho máximo en unidades del modelo)
            const Vf = (x, y, t, fs, maxU, extra = '') => { if (!t) return ''; ctxMedida.font = `bold ${fs * k}px sans-serif`; const w = ctxMedida.measureText(String(t)).width / k; return V(x, y, t, w > maxU ? Math.max(14, fs * maxU / w) : fs, extra); };
            // Plano nº: el nº de plano (o, si no se ha indicado, la referencia del proyecto); Nº de proyecto solo si ambos existen
            const planoN = p.planoNumero || p.numero, proyN = p.planoNumero ? p.numero : '';
            const CEN = 'text-anchor="middle"';
            h += V(60, 370, opciones.formato || 'A3') + Vf(193, 370, proyN, 34, 265) + Vf(640, 374, planoN, 42, 320, CEN) + Vf(905, 374, p.revision, 42, 140, CEN) + V(1045, 374, p.letraRevision, 34);
            // nombres de dibujante, revisor y aprobador alineados a la derecha de su casilla
            const DER = 'text-anchor="end"';
            h += Vf(1468, 316, p.autor, 34, 270, DER) + Vf(1812, 316, fechaDMA(p.fecha), 34, 300, DER) + Vf(1468, 394, p.revisadoPor, 34, 270, DER) + Vf(1812, 394, fechaDMA(p.fechaRevisado), 34, 300, DER);
            h += V(120, 460, p.escala || 'N/A', 30) + V(470, 460, p.grupoPlano, 30) + V(840, 452, codigoHoja(), 30) + V(990, 452, String(hojas.length), 30);
            h += Vf(1468, 470, p.aprobadoPor, 34, 270, DER) + Vf(1812, 470, fechaDMA(p.fechaAprobado), 34, 300, DER);
            if (p.logo) h += `<image href="${p.logo}" x="${X(1165)}" y="${Y(18)}" width="${(645 * k).toFixed(2)}" height="${(200 * k).toFixed(2)}" preserveAspectRatio="xMidYMid meet"/>`;
            h += V(230, 530, tr(p.codigoPlano, 28), 30) + V(960, 530, tr(p.planoCert, 10), 26);
            return h + '</g>';
        }

        // ==================================================================================
        // ETIQUETAS (nomenclatura) EN CAPA PROPIA
        //  - Siguen la orientación del componente y se leen en horizontal o, en vertical, desde la
        //    derecha del plano (texto de abajo arriba): ángulo en [-90°, 90°).
        //  - Si la etiqueta es más larga que el componente, se reduce el tamaño de letra hasta su largo.
        //  - Colocación automática sin solapes (etiquetas y símbolos); el usuario puede arrastrarla
        //    cerca del componente y girarla (doble clic): se guarda en el elemento (etq) y sigue al
        //    componente cuando este se mueve.
        // ==================================================================================
        const ctxMedida = document.createElement('canvas').getContext('2d');
        function anchoTexto(t, fs) { ctxMedida.font = `${fs}px sans-serif`; return ctxMedida.measureText(t).width; }
        const angLegible = rot => { const a = ((rot % 180) + 180) % 180; return a >= 90 ? a - 180 : a; };
        function specEtiqueta(el) {
            const s = el.scale || 1, rot = el.rotation || 0, r = rot * Math.PI / 180;
            const ctr = el.type === 'instrumento' ? aPantalla(el, 25, 17) : centroElemento(el);
            let largo, off;
            if (el.type === 'tuberia') { largo = (el.longitud || 3000) / 30 * s; off = 5; }
            else if (el.type === 'bomba') { largo = 44 * s; off = 16 * s + 3; }
            else if (esDeposito(el)) { largo = 36 * s; off = 21 * s + 3; }
            else if (el.type === 'instrumento') { largo = 70; off = 9 * s + 3; }
            else { largo = 34 * s; off = 14 * s + 3; }
            const lineas = [tagDe(el)];
            const rr = el.type === 'bomba' && ultimoResultado && ultimoResultado[el.id];
            if (rr && rr.npshd != null) lineas.push(`NPSHd ${fmt(rr.npshd, 1)} / NPSHr ${fmt(el.npsh, 1)} m`);
            let fs = 6.5;
            const w0 = anchoTexto(lineas[0], fs);
            if (w0 > largo) fs = Math.max(3, fs * largo / w0); // la nomenclatura no supera el largo del componente
            const fs2 = 5; // segunda línea (NPSH de la bomba): tamaño fijo, siempre legible
            const w = Math.max(anchoTexto(lineas[0], fs), lineas[1] ? anchoTexto(lineas[1], fs2) : 0), h = fs * 1.2 + (lineas.length > 1 ? fs2 * 1.25 : 0);
            const ang = el.type === 'instrumento' ? 0 : angLegible(rot);
            // normal al eje del componente; se prefiere debajo (horizontal) o a la derecha (vertical)
            let n = { x: -Math.sin(r), y: Math.cos(r) };
            if (Math.abs(n.x) > Math.abs(n.y) ? n.x < 0 : n.y < 0) n = { x: -n.x, y: -n.y };
            const eje = { x: Math.cos(r), y: Math.sin(r) };
            return { el, lineas, ctr, ang, largo, off, fs, fs2, w, h, n, eje };
        }
        function cajaEtiqueta(cx, cy, w, h, ang) {
            const a = ang * Math.PI / 180, c = Math.abs(Math.cos(a)), sn = Math.abs(Math.sin(a));
            const W = w * c + h * sn, H = w * sn + h * c;
            return { x0: cx - W / 2, y0: cy - H / 2, x1: cx + W / 2, y1: cy + H / 2 };
        }
        const solapan = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
        function cajaSimbolo(el) {
            if (el.type === 'tuberia') { const p = obtenerPuertosConexion(el); return { x0: Math.min(p[0].x, p[1].x) - 1.5, y0: Math.min(p[0].y, p[1].y) - 1.5, x1: Math.max(p[0].x, p[1].x) + 1.5, y1: Math.max(p[0].y, p[1].y) + 1.5 }; }
            const c = centroElemento(el), r = 15 * (el.scale || 1);
            return { x0: c.x - r, y0: c.y - r, x1: c.x + r, y1: c.y + r };
        }
        function colocarEtiquetas(specs) {
            const puestas = [], obst = elementosRed.filter(e => !esAnotacion(e)).map(e => ({ id: e.id, b: cajaSimbolo(e) }));
            const libre = (b, id) => !puestas.some(p => solapan(p.b, b)) && !obst.some(o => o.id !== id && solapan(o.b, b));
            specs.filter(sp => sp.el.etq).forEach(sp => { const q = sp.el.etq, ang = q.ang != null ? q.ang : sp.ang; const b = cajaEtiqueta(sp.ctr.x + q.dx, sp.ctr.y + q.dy, sp.w, sp.h, ang); Object.assign(sp, { x: sp.ctr.x + q.dx, y: sp.ctr.y + q.dy, ang, b, manual: true }); puestas.push(sp); });
            specs.filter(sp => !sp.el.etq).sort((a, b) => a.ctr.x - b.ctr.x || a.ctr.y - b.ctr.y).forEach(sp => {
                const hn = Math.abs(sp.n.x) > Math.abs(sp.n.y) ? (sp.ang === 0 ? sp.w : sp.h) : (sp.ang === 0 ? sp.h : sp.w);
                const cand = [];
                if (sp.el.type === 'instrumento') {
                    [[1, 0], [-1, 0], [0, -1], [0, 1]].forEach(([ux, uy]) => { for (const k of [1, 1.8]) cand.push({ x: sp.ctr.x + ux * (sp.off + sp.w / 2) * k, y: sp.ctr.y + uy * (sp.off + sp.h / 2) * k }); });
                } else {
                    const d = sp.off + hn / 2;
                    for (const k of [1, 1.7, 2.5]) for (const sg of [1, -1]) for (const t of [0, 0.5, -0.5])
                        cand.push({ x: sp.ctr.x + sg * sp.n.x * d * k + sp.eje.x * t * (sp.w + 4), y: sp.ctr.y + sg * sp.n.y * d * k + sp.eje.y * t * (sp.w + 4) });
                }
                let elegido = cand[0];
                for (const c of cand) { if (libre(cajaEtiqueta(c.x, c.y, sp.w, sp.h, sp.ang), sp.el.id)) { elegido = c; break; } }
                Object.assign(sp, elegido, { b: cajaEtiqueta(elegido.x, elegido.y, sp.w, sp.h, sp.ang) });
                puestas.push(sp);
            });
            return specs;
        }
        function svgEtiquetas(specs, P) {
            let lideres = '', txt = '';
            specs.forEach(sp => {
                const el = sp.el, isSel = idSeleccionado === el.id || seleccion.has(el.id);
                const col = isSel ? P.sel : (el.estado || el.esLineaCritica ? colorElemento(el, P) : P.texto);
                const est = `font-family="sans-serif" fill="${col}" text-anchor="middle" paint-order="stroke" stroke="${P.halo}" stroke-width="2.6" stroke-linejoin="round"`;
                if (sp.manual && Math.hypot(sp.x - sp.ctr.x, sp.y - sp.ctr.y) > sp.off + Math.max(sp.w, sp.h) / 2 + 8)
                    lideres += `<line x1="${sp.ctr.x.toFixed(1)}" y1="${sp.ctr.y.toFixed(1)}" x2="${sp.x.toFixed(1)}" y2="${sp.y.toFixed(1)}" stroke="${P.texto}" stroke-width="0.5" stroke-dasharray="2,1.5" opacity="0.7"/>`;
                const y0 = -sp.h / 2 + sp.fs * 0.95;
                let t = `<text x="0" y="${y0.toFixed(2)}" font-size="${sp.fs.toFixed(2)}" ${est}>${esc(sp.lineas[0])}</text>`;
                if (sp.lineas[1]) { const rr = ultimoResultado && ultimoResultado[el.id]; const okN = rr && rr.npshd != null && rr.npshd >= (+el.npsh || 0) + (+opciones.margenNPSH || 0.5);
                    t += `<text x="0" y="${(y0 + sp.fs2 * 1.3).toFixed(2)}" font-size="${sp.fs2}" font-weight="bold" ${est.replace(`fill="${col}"`, `fill="${okN ? P.ok : P.fallo}"`)}>${esc(sp.lineas[1])}</text>`; }
                txt += `<g class="etiqueta" data-etq="${el.id}" transform="translate(${sp.x.toFixed(2)} ${sp.y.toFixed(2)}) rotate(${sp.ang})" style="cursor:move"><rect x="${(-sp.w / 2 - 1).toFixed(2)}" y="${(-sp.h / 2).toFixed(2)}" width="${(sp.w + 2).toFixed(2)}" height="${sp.h.toFixed(2)}" fill="transparent"/>${t}</g>`;
            });
            return `<g pointer-events="none">${lideres}</g>${txt}`;
        }
        let ultimoClic = {};
        function renderizarVectorial() {
            recolocarTablasHoja();
            const emptyState = document.getElementById("empty-state");
            svgCanvas.innerHTML = "";
            const P = paleta();
            const gFmt = document.createElementNS("http://www.w3.org/2000/svg", "g");
            gFmt.setAttribute('id', 'capa-formato'); gFmt.setAttribute('pointer-events', 'none');
            gFmt.innerHTML = dibujoFormato(P);
            svgCanvas.appendChild(gFmt);
            if (emptyState && elementosRed.length === 0) { emptyState.setAttribute('transform', `translate(${ANCHO_A3 / 2}, ${ALTO_A3 / 2})`); svgCanvas.appendChild(emptyState); }
            let fondoDXF = null; try { fondoDXF = proyecto.fondo; } catch (e) { fondoDXF = null; }
            if (fondoDXF && fondoDXF.visible && fondoDXF.svg) {
                const gF = document.createElementNS("http://www.w3.org/2000/svg", "g");
                gF.setAttribute('id', 'fondo-dxf'); gF.setAttribute('opacity', proyecto.fondo.opacidad || 0.35); gF.setAttribute('pointer-events', 'none');
                gF.setAttribute('stroke', P.texto); gF.setAttribute('fill', P.texto); gF.setAttribute('stroke-width', '0.6');
                gF.innerHTML = proyecto.fondo.svg;
                svgCanvas.appendChild(gF);
            }
            // notas ancladas a un componente: siguen al componente (desplazamiento ox/oy)
            elementosRed.forEach(n => {
                if (!esAnotacion(n) || !n.ancla) return;
                const a = elementosRed.find(e => e.id === n.ancla);
                if (!a) { delete n.ancla; return; }
                n.x = a.x + (+n.ox || 0); n.y = a.y + (+n.oy || 0);
            });
            const specs = [];
            let lideresNotas = '';
            elementosRed.forEach(el => {
                const isSelected = idSeleccionado === el.id || seleccion.has(el.id);
                const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
                g.setAttribute("class", `symbol-group ${isSelected ? 'symbol-selected' : ''}`);
                const rot = el.rotation || 0;
                // el.x/el.y son coordenadas de MUNDO (Y arriba); se convierten a pantalla (Y abajo) solo al dibujar
                g.setAttribute("transform", `translate(${el.x}, ${mundoAScreenY(el.y)}) rotate(${rot}, 25, 25) scale(${el.scale})${trEspejo(el)}`);
                g.setAttribute("data-id", el.id);

                g.addEventListener('mousedown', function(e) {
                    if (e.button === 2) return;
                    e.stopPropagation();
                    ocultarTooltip();
                    // doble clic detectado a mano: el primer clic redibuja el lienzo y el navegador no
                    // siempre emite 'dblclick' sobre el nodo nuevo
                    const ahora = Date.now();
                    if (ultimoClic.id === el.id && ahora - ultimoClic.t < 420 && !(e.ctrlKey || e.shiftKey || e.metaKey)) { ultimoClic = {}; e.preventDefault(); abrirVentanaElemento(el.id, e.clientX, e.clientY); return; }
                    ultimoClic = { id: el.id, t: ahora };
                    if (e.ctrlKey || e.shiftKey || e.metaKey) {
                        // Ctrl/Mayús + clic: añadir o quitar de la selección múltiple
                        if (idSeleccionado && !seleccion.size) seleccion.add(idSeleccionado);
                        if (seleccion.has(el.id)) seleccion.delete(el.id); else seleccion.add(el.id);
                        actualizarSeleccion();
                        return;
                    }
                    arrastreGrupo = seleccion.size > 1 && seleccion.has(el.id);
                    if (!arrastreGrupo) seleccion.clear();
                    activeSymbolId = el.id;
                    isDraggingSymbol = true;
                    arrastreMovido = false;
                    desenganchado = !!el._suelto;
                    // Un único snapshot al EMPEZAR el arrastre (no en cada mousemove), para que
                    // Deshacer devuelva la pieza a su posición anterior al arrastre completo.
                    guardarEstado();
                    dragStartX = e.clientX;
                    dragStartY = e.clientY;
                    if (arrastreGrupo) { renderizarVectorial(); return; }
                    seleccionarElemento(el.id);
                });
                g.addEventListener('dblclick', function(e) { e.stopPropagation(); if (ventanaId !== el.id) abrirVentanaElemento(el.id, e.clientX, e.clientY); });
                if (el.subtype === 'tabla') { g.addEventListener('mouseenter', () => mostrarBotonTabla(el, g)); g.addEventListener('mouseleave', () => ocultarBotonTabla()); }
                else g.addEventListener('mouseenter', e => programarTooltip(el.id, e));
                g.addEventListener('mousemove', e => moverTooltip(e));
                g.addEventListener('mouseleave', () => ocultarTooltip());
                g.oncontextmenu = function(e) {
                    e.preventDefault();
                    e.stopPropagation();
                    ocultarTooltip();
                    idMenuContextual = el.id;
                    if (!(seleccion.size > 1 && seleccion.has(el.id))) { seleccion.clear(); seleccionarElemento(el.id); }
                    mostrarMenuContextual(e.clientX, e.clientY, itemsMenuElemento(el), planoCongelado ? null : marcasElemento(el));
                };

                const c = isSelected ? P.sel : colorElemento(el, P);
                // Flecha verde del sentido de referencia del flujo, por encima de la línea para que no la tape
                const flecha = (y) => `<polygon points="42,${y - 3} 48,${y} 42,${y + 3}" fill="${P.flecha}"/>`;
                const marcaFallo = (x, y) => el.estado === 'fallo' && el.esLineaCritica ? `<circle cx="${x}" cy="${y}" r="3.6" fill="${P.fallo}"/><text x="${x}" y="${y + 2.4}" font-family="sans-serif" font-size="6" font-weight="bold" fill="#fff" text-anchor="middle">!</text>` : '';
                let d = '';
                if (esAnotacion(el)) {
                    d = dibujoAnotacion(el, isSelected ? P.sel : P.texto, P);
                    if (el.ancla) { const a = elementosRed.find(e => e.id === el.ancla); if (a) { const ca = centroElemento(a); lideresNotas += `<line x1="${ca.x.toFixed(1)}" y1="${ca.y.toFixed(1)}" x2="${el.x.toFixed(1)}" y2="${mundoAScreenY(el.y).toFixed(1)}" stroke="${P.texto}" stroke-width="0.6"/><circle cx="${ca.x.toFixed(1)}" cy="${ca.y.toFixed(1)}" r="1.4" fill="${P.texto}"/>`; } }
                } else if (el.type === 'bomba') {
                    d = simboloBomba(c, P) + marcaFallo(25, 6);
                } else if (el.type === 'tuberia') {
                    const largoPx = (el.longitud || 3000) / 30;
                    const ax = Math.max(largoPx / 2 + 6, 8);
                    d = `<line x1="0" y1="20" x2="${largoPx}" y2="20" stroke="${c}" stroke-width="2.2" stroke-linecap="round"/>
                         <polygon points="${ax - 6},12.5 ${ax},15.5 ${ax - 6},18.5" fill="${P.flecha}"/>` + marcaFallo(largoPx / 2 - 8, 13);
                } else {
                    d = simboloSVG(el, c, P);
                    if (el.type !== 'instrumento' && !sinFlujo(el) && !/^codo/.test(el.subtype)) d += flecha(18);
                    d += marcaFallo(25, 5);
                }
                if (!esAnotacion(el)) specs.push(specEtiqueta(el));
                obtenerPuertosLocales(el).forEach(p => {
                    d += `<circle class="connection-port" cx="${p.x}" cy="${p.y}" r="2.6" data-portid="${p.id}"/>`;
                });
                g.innerHTML = d;
                // textos interiores del símbolo (códigos, A/I de la bomba...): siempre legibles, en horizontal
                // o en vertical leyendo desde la derecha, aunque el componente esté girado
                if (!esAnotacion(el) && (rot || trEspejo(el))) { const corr = angLegible(rot) - rot, esp = !!trEspejo(el); g.querySelectorAll('text').forEach(t => { const x = +t.getAttribute('x') || 0, y = (+t.getAttribute('y') || 0) - (+t.getAttribute('font-size') || 6) * 0.35; t.setAttribute('transform', (esp ? `translate(0 ${2 * y}) scale(1 -1) ` : '') + `rotate(${corr} ${x} ${y})`); }); }
                svgCanvas.appendChild(g);
            });
            if (lideresNotas) { const gl = document.createElementNS("http://www.w3.org/2000/svg", "g"); gl.setAttribute('pointer-events', 'none'); gl.setAttribute('id', 'lideres-notas'); gl.innerHTML = lideresNotas; svgCanvas.insertBefore(gl, svgCanvas.querySelector('g[data-id]')); }
            // etiquetas: capa superior
            const gE = document.createElementNS("http://www.w3.org/2000/svg", "g");
            gE.setAttribute('id', 'capa-etiquetas');
            gE.innerHTML = svgEtiquetas(colocarEtiquetas(specs), P);
            svgCanvas.appendChild(gE);

            // Solo se trabaja dentro de la hoja: si algo queda fuera, se devuelve al borde y se redibuja
            if (!renderizarVectorial._limitando) {
                let movido = false;
                elementosRed.forEach(el => { if (limitarAHoja(el)) movido = true; });
                if (movido) {
                    renderizarVectorial._limitando = true;
                    renderizarVectorial();
                    renderizarVectorial._limitando = false;
                }
            }
            if (!isDraggingSymbol) programarArbol();
        }
        // Arrastre y doble clic de etiquetas (delegados en el lienzo)
        let arrastreEtq = null;
        svgCanvas.addEventListener('mousedown', e => {
            const g = e.target.closest && e.target.closest('g.etiqueta');
            if (!g || e.button !== 0) return;
            e.stopPropagation(); e.preventDefault();
            const el = elementosRed.find(x => x.id === g.getAttribute('data-etq'));
            if (!el) return;
            const ahora = Date.now();
            if (ultimoClic.etq === el.id && ahora - ultimoClic.t < 420) { ultimoClic = {}; mostrarMenuContextual(e.clientX, e.clientY, itemsMenuEtiqueta(el)); return; }
            ultimoClic = { etq: el.id, t: ahora };
            const sp = specEtiqueta(el), m = g.transform.baseVal.consolidate();
            const cx = m ? m.matrix.e : sp.ctr.x, cy = m ? m.matrix.f : sp.ctr.y;
            const ang = el.etq && el.etq.ang != null ? el.etq.ang : (m ? Math.round(Math.atan2(m.matrix.b, m.matrix.a) * 180 / Math.PI) : sp.ang);
            arrastreEtq = { el, x0: e.clientX, y0: e.clientY, dx: cx - sp.ctr.x, dy: cy - sp.ctr.y, ang, movido: false, lim: Math.max(60, sp.off + sp.w + 20) };
        }, true);
        window.addEventListener('mousemove', e => {
            if (!arrastreEtq) return;
            const A = arrastreEtq;
            if (!A.movido) { if (Math.hypot(e.clientX - A.x0, e.clientY - A.y0) < 3) return; A.movido = true; guardarEstado(); }
            let dx = A.dx + (e.clientX - A.x0) / zoomScale, dy = A.dy + (e.clientY - A.y0) / zoomScale;
            const d = Math.hypot(dx, dy); if (d > A.lim) { dx *= A.lim / d; dy *= A.lim / d; } // siempre cerca de su componente
            A.el.etq = { dx: +dx.toFixed(1), dy: +dy.toFixed(1), ang: A.ang };
            renderizarVectorial();
        });
        window.addEventListener('mouseup', () => { if (arrastreEtq && arrastreEtq.movido) marcarCambios(true); arrastreEtq = null; });
        svgCanvas.addEventListener('dblclick', e => {
            const g = e.target.closest && e.target.closest('g.etiqueta');
            if (!g) return;
            e.stopPropagation();
            const el = elementosRed.find(x => x.id === g.getAttribute('data-etq'));
            if (el && contextMenu.style.display !== 'block') mostrarMenuContextual(e.clientX, e.clientY, itemsMenuEtiqueta(el));
        });
        function girarEtiqueta(el, ang) {
            const sp = specEtiqueta(el); guardarEstado();
            const q = el.etq || { dx: sp.n.x * (sp.off + sp.h / 2), dy: sp.n.y * (sp.off + sp.h / 2) };
            el.etq = { dx: q.dx, dy: q.dy, ang };
            renderizarVectorial();
        }
        function itemsMenuEtiqueta(el) {
            return [
                { icono: 'fa-arrows-up-down-left-right', texto: 'Arrastra la etiqueta para moverla (siempre cerca del componente)', accion: () => {} },
                'sep',
                { icono: 'fa-text-width', texto: 'Texto horizontal', accion: () => girarEtiqueta(el, 0) },
                { icono: 'fa-text-height', texto: 'Texto vertical (se lee desde la derecha)', accion: () => girarEtiqueta(el, -90) },
                { icono: 'fa-rotate-left', texto: 'Girar 90° antihorario', accion: () => girarEtiqueta(el, angLegible(((el.etq && el.etq.ang != null ? el.etq.ang : specEtiqueta(el).ang) - 90))) },
                { icono: 'fa-rotate-right', texto: 'Girar 90° horario', accion: () => girarEtiqueta(el, angLegible(((el.etq && el.etq.ang != null ? el.etq.ang : specEtiqueta(el).ang) + 90))) },
                'sep',
                { icono: 'fa-wand-magic-sparkles', texto: 'Posición automática', accion: () => { guardarEstado(); delete el.etq; renderizarVectorial(); } }
            ];
        }

        // Arrastre fluido: el primer movimiento se dibuja en el acto; los que lleguen dentro del mismo
        // fotograma se acumulan y se dibujan juntos en el siguiente (un redibujo por fotograma como máximo)
        let arrastreEnCola = null, arrastreFotograma = false;
        function vaciarArrastre() { if (arrastreEnCola) { const e = arrastreEnCola; arrastreEnCola = null; procesarArrastre(e); if (typeof guiasTrasArrastre === 'function') guiasTrasArrastre(); } }
        window.addEventListener('mousemove', function (e) {
            if (!isDraggingSymbol || !activeSymbolId) return;
            if (arrastreFotograma) { arrastreEnCola = e; return; }
            arrastreFotograma = true; procesarArrastre(e); if (typeof guiasTrasArrastre === 'function') guiasTrasArrastre();
            requestAnimationFrame(() => { arrastreFotograma = false; vaciarArrastre(); });
        });
        window.addEventListener('mouseup', vaciarArrastre, true);
        function procesarArrastre(e) {
            if (!isDraggingSymbol || !activeSymbolId) return;
            const dx = (e.clientX - dragStartX) / zoomScale;
            const dy = (e.clientY - dragStartY) / zoomScale;
            dragStartX = e.clientX;
            dragStartY = e.clientY;

            if (arrastreGrupo) {
                if (!arrastreMovido && (dx || dy)) { arrastreMovido = true; invalidarResultados(); }
                elementosRed.forEach(x => { if (seleccion.has(x.id) && !esTablaHoja(x)) { x.x += dx; x.y -= dy; } });
                renderizarVectorial();
                return;
            }
            const el = elementosRed.find(item => item.id === activeSymbolId);
            if (el && esTablaHoja(el)) {
                // listado y leyenda: solo se mueven tras Mover / Desconectar (menú del botón derecho)
                if (!el._suelto) return;
                if (!arrastreMovido && (dx || dy)) arrastreMovido = true;
                moverTablaHoja(el, dx, dy); renderizarVectorial(); return;
            }
            if (el) {
                if (!arrastreMovido && (dx || dy)) { arrastreMovido = true; if (!esAnotacion(el)) invalidarResultados(); }
                if (esAnotacion(el) && (el.ancla || el.sigueA)) { el.ox = (+el.ox || 0) + dx; el.oy = (+el.oy || 0) - dy; renderizarVectorial(); return; }
                el.x += dx;
                el.y -= dy; // dy es un delta de pantalla (abajo = positivo); en mundo Y-arriba se resta
                if (!esAnotacion(el)) aplicarSnapping(el);
                renderizarVectorial();
            }
        }

        window.addEventListener('mouseup', function() {
            if (isDraggingSymbol) {
                // un clic sin mover no debe dejar un paso de Deshacer vacío
                if (!arrastreMovido && historialUndo.length) { historialUndo.pop(); actualizarBotonesHistorial(); }
                else if (arrastreMovido) {
                    const el = elementosRed.find(item => item.id === activeSymbolId);
                    if (el && esTablaHoja(el) && !arrastreGrupo) { soltarTablaHoja(el); desenganchado = false; renderizarVectorial(); }
                    else {
                    // ajuste a rejilla (Opciones > Ajuste a rejilla) si no ha quedado imantado a otro elemento
                    if (opciones.rejilla) {
                        // paso = separación de las líneas menores de la rejilla; origen en la esquina inferior izquierda del marco
                        const g = pasoRejillaPx(), fr = marcoInterior(), ox = fr.x0, oy = ALTO_A3 - fr.y1;
                        const aj = (v, o) => o + Math.round((v - o) / g) * g;
                        if (arrastreGrupo) { const ref = elementosRed.find(x => x.id === activeSymbolId); if (ref) { const dx = aj(ref.x, ox) - ref.x, dy = aj(ref.y, oy) - ref.y; elementosRed.forEach(x => { if (seleccion.has(x.id)) { x.x += dx; x.y += dy; } }); } }
                        else if (el && !vecinosDe(el).length) { el.x = aj(el.x, ox); el.y = aj(el.y, oy); }
                    }
                    if (el && !arrastreGrupo) limitarAMarco(el);
                    if (el) delete el._suelto;
                    desenganchado = false;
                    // si al moverlo se ha conectado a otro elemento sin línea asignada, hereda su línea
                    if (el && !el.linea) { const v = vecinosDe(el).find(x => x.otro.linea); if (v) el.linea = v.otro.linea; }
                    renderizarVectorial();
                    }
                }
            }
            const moviose = isDraggingSymbol && arrastreMovido;
            isDraggingSymbol = false;
            activeSymbolId = null;
            arrastreGrupo = false;
            programarArbol();
            if (moviose) programarCalculoAuto();
        });

        const pasoRejillaPx = () => (+opciones.rejillaMayor > 0 ? +opciones.rejillaMayor : 10) * PX_MM / Math.max(1, Math.round(+opciones.rejillaMenores || 2));
        // Mantiene un elemento dentro del marco del formato (al soltarlo tras arrastrar o insertar)
        function limitarAMarco(el) {
            const g = svgCanvas.querySelector(`g[data-id="${el.id}"]`); if (!g) return false;
            const rM = marcoA3.getBoundingClientRect(); if (!rM.width) return false;
            const esc = rM.width / ANCHO_A3, r = g.getBoundingClientRect(), fr = marcoInterior();
            const izq = (r.left - rM.left) / esc, der = (r.right - rM.left) / esc, arr = (r.top - rM.top) / esc, aba = (r.bottom - rM.top) / esc;
            let dx = 0, dy = 0;
            if (der - izq <= fr.x1 - fr.x0) { if (izq < fr.x0) dx = fr.x0 - izq; else if (der > fr.x1) dx = fr.x1 - der; }
            if (aba - arr <= fr.y1 - fr.y0) { if (arr < fr.y0) dy = fr.y0 - arr; else if (aba > fr.y1) dy = fr.y1 - aba; }
            if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return false;
            el.x += dx; el.y -= dy; renderizarVectorial(); return true;
        }
        // Giro de un elemento. inc > 0: horario; inc < 0: antihorario. Si está conectado por un único
        // puerto, gira alrededor de ese puerto para no perder la conexión.
        function girarElemento(el, inc) {
            const vec = vecinosDe(el);
            const fijo = vec.length === 1 ? obtenerPuertosConexion(el).find(p => p.id === vec[0].puertoEl) : null;
            el.rotation = ((((el.rotation || 0) + inc) % 360) + 360) % 360;
            if (fijo) { const q = obtenerPuertosConexion(el).find(p => p.id === fijo.id); if (q) { el.x += fijo.x - q.x; el.y -= fijo.y - q.y; } }
        }
        // ---------- Menús contextuales (mismo aspecto que la barra de menús) ----------
        function mostrarMenuContextual(x, y, items, marcas) {
            cerrarMenus();
            contextMenu.className = 'menu-desplegable';
            // con órdenes alrededor del cursor (píldoras) la lista queda debajo de ellas
            if (marcas && Object.values(marcas).some(Boolean)) { pintarMarcas(x, y, marcas); x -= 70; y += 80; }
            contextMenu.style.cssText = `display:block; position:fixed; left:${x}px; top:${y}px; z-index:3500;`;
            construirItems(items, contextMenu);
            const r = contextMenu.getBoundingClientRect();
            if (r.right > window.innerWidth - 4) contextMenu.style.left = Math.max(4, window.innerWidth - r.width - 4) + 'px';
            if (r.bottom > window.innerHeight - 4) contextMenu.style.top = Math.max(4, window.innerHeight - r.height - 4) + 'px';
        }
        // Capa del DXF de un elemento: la elegida por el usuario (botón derecho > Capa) o la de su tipo
        const capaPorTipo = el => el.subtype === 'materiales' ? 'Marca' : el.subtype === 'tabla' ? 'Text' : 'Object';
        const capaDe = el => (el.capa && capasActuales().some(c => c.nombre === el.capa)) ? el.capa : capaPorTipo(el);
        function itemCapa(el, enGrupo) {
            const objetivo = () => enGrupo ? elementosRed.filter(e => seleccion.has(e.id)) : [el];
            return { icono: 'fa-layer-group', texto: `Capa (${capaDe(el)})`, sub: () => capasActuales().map(c => ({ icono: capaDe(el) === c.nombre ? 'fa-check' : 'fa-square', texto: c.nombre + (c.nombre === capaPorTipo(el) ? ' (por defecto)' : '') + (c.uso ? ' · ' + c.uso : ''),
                accion: () => { guardarEstado(); objetivo().forEach(e => { if (c.nombre === capaPorTipo(e)) delete e.capa; else e.capa = c.nombre; }); renderizarVectorial(); aviso(`${enGrupo ? objetivo().length + ' elementos' : tagDe(el)} en la capa ${c.nombre}.`, 'ok'); } })) };
        }
        function itemsMenuElemento(el) {
            const enGrupo = seleccion.size > 1 && seleccion.has(el.id);
            const giro = inc => () => {
                if (enGrupo) { girarSeleccion(inc); return; }
                guardarEstado(); invalidarResultados(); girarElemento(el, inc); renderizarVectorial(); seleccionarElemento(el.id);
            };
            if (esTablaHoja(el)) {
                const q = enganchesTabla(el), eng = el.offHoja && !el.offHoja.dx && !el.offHoja.dy;
                return [
                    { icono: 'fa-pen-to-square', texto: 'Editar...', accion: () => abrirVentanaElemento(el.id) },
                    { icono: 'fa-arrows-up-down-left-right', texto: 'Mover / Desconectar', accion: () => { el._suelto = true; aviso(`Tabla liberada: arrástrala. Cerca de su punto de enganche (${q.dest}) se imanta.`); } },
                    itemCapa(el, false),
                    ...(eng ? [] : [{ icono: 'fa-magnet', texto: `Enganchar al ${q.dest}`, accion: () => { guardarEstado(); el.offHoja = { dx: 0, dy: 0 }; renderizarVectorial(); marcarCambios(true); } }]),
                    'sep',
                    { icono: 'fa-trash-can', texto: 'Eliminar', accion: () => eliminarElemento(el.id) }
                ];
            }
            return [
                { icono: 'fa-pen-to-square', texto: 'Editar...', accion: () => abrirVentanaElemento(el.id) },
                { icono: 'fa-rotate', texto: 'Girar', sub: [
                    { icono: 'fa-rotate-right', texto: '90° horario', accion: giro(90) },
                    { icono: 'fa-rotate-right', texto: '180° horario', accion: giro(180) },
                    { icono: 'fa-rotate-right', texto: '270° horario', accion: giro(270) },
                    'sep',
                    { icono: 'fa-rotate-left', texto: '90° antihorario', accion: giro(-90) },
                    { icono: 'fa-rotate-left', texto: '180° antihorario', accion: giro(-180) },
                    { icono: 'fa-rotate-left', texto: '270° antihorario', accion: giro(-270) }] },
                ...(esAnotacion(el) ? [] : [{ icono: 'fa-sitemap', texto: 'Cambiar de línea / ramal...', accion: () => abrirVentanaElemento(el.id) },
                    { icono: 'fa-note-sticky', texto: 'Nota de texto anclada al componente', accion: () => insertarNotaAnclada(el) }]),
                { icono: 'fa-expand', texto: 'Escalar...', accion: () => { const v = prompt('Factor de escala:', el.scale || 1.0); if (v && +v > 0) { guardarEstado(); el.scale = +v; renderizarVectorial(); seleccionarElemento(el.id); } } },
                { icono: 'fa-arrows-up-down-left-right', texto: 'Mover / Desconectar', accion: () => { el._suelto = true; aviso('Componente liberado del imantado: arrástralo a su nueva posición.'); } },
                ...(el.type === 'tuberia' ? [{ icono: 'fa-scissors', texto: 'Partir tubería...', accion: () => partirTuberiaDialogo(el.id) }] : []),
                ...(el.type === 'bomba' ? [{ icono: 'fa-chart-line', texto: 'Curva Q-H del fabricante...', accion: () => abrirCurvaBomba(el.id) }] : []),
                ...(el.subtype === 'retencion' || (['valvula', 'accesorio'].includes(el.type) && typeof componenteEnLinea === 'function' && componenteEnLinea(el)) ? [{ icono: 'fa-right-left', texto: 'Invertir sentido', accion: () => invertirComponente(el.id) }] : []),
                itemCapa(el, enGrupo),
                'sep',
                { icono: 'fa-trash-can', texto: 'Eliminar', accion: () => { if (enGrupo) eliminarSeleccion(); else eliminarElemento(el.id); } }
            ];
        }
        // Botón derecho sobre el lienzo vacío (opciones por orden alfabético)
        function itemsMenuLienzo(px, py) {
            const items = [
                { icono: 'fa-calculator', texto: 'Calcular red', accion: () => calcularRed() },
                ...(ultimaOrden ? [{ icono: 'fa-repeat', texto: 'Repetir: ' + textoUltimaOrden(), accion: () => { ratonHoja = { x: px, y: py }; repetirUltimaOrden(); } }] : []),
                planoCongelado ? { icono: 'fa-fire', texto: 'Descongelar plano', accion: () => congelarPlano(false) } : { icono: 'fa-snowflake', texto: 'Congelar plano', accion: () => congelarPlano(true) },
                { icono: 'fa-list', texto: 'Leyenda de componentes', accion: () => colocarLeyenda() },
                { icono: 'fa-table-list', texto: 'Listado de componentes', accion: () => insertarListado(px, py) },
                { icono: 'fa-note-sticky', texto: 'Nota de texto', accion: () => insertarNotaEn(px, py) },
                { icono: 'fa-ruler-combined', texto: 'Redimensionar red', accion: () => dimensionarTuberias() },
                { icono: 'fa-diagram-project', texto: 'Seleccionar línea', sub: () => lineas.length ? lineasEnOrden().map(o => ({ icono: o.linea.tipo === 'principal' ? 'fa-diagram-project' : 'fa-code-branch', texto: ' '.repeat(o.nivel) + o.linea.id + (o.linea.nombre ? ' · ' + o.linea.nombre : ''), accion: () => seleccionarLinea(o.linea.id) })) : [{ icono: 'fa-ban', texto: 'Sin líneas', accion: () => {} }] },
                { icono: 'fa-magnifying-glass', texto: 'Zoom', sub: [
                    { icono: 'fa-expand', texto: 'Ajustar', atajo: 'F', accion: () => ajustarVistaVentana() },
                    { icono: 'fa-maximize', texto: 'Todo', atajo: 'T', accion: () => zoomTodo() },
                    { icono: 'fa-vector-square', texto: 'Ventana', atajo: 'W', accion: () => activarZoomVentana() }] }
            ];
            return items.sort((a, b) => a.texto.localeCompare(b.texto, 'es'));
        }
        canvasContainer.addEventListener('contextmenu', e => {
            if (e.target.closest && (e.target.closest('g[data-id]') || e.target.closest('#arbol-cuerpo .nodo'))) return;
            e.preventDefault(); ocultarTooltip();
            const rM = marcoA3.getBoundingClientRect();
            mostrarMenuContextual(e.clientX, e.clientY, itemsMenuLienzo((e.clientX - rM.left) / zoomScale, (e.clientY - rM.top) / zoomScale), planoCongelado ? null : marcasLienzo());
        });
        // ---------- Notas, leyenda y listado de componentes ----------
        function nuevaAnotacion(sub, px, py) {
            const el = { id: 'sym_' + Date.now() + '_' + Math.floor(Math.random() * 1000), type: 'anotacion', subtype: sub, x: px, y: screenAMundoY(py), scale: 1, rotation: 0, name: '' };
            if (sub === 'nota') el.texto = 'Nota';
            normalizarElemento(el); elementosRed.push(el); asignarNumero(el);
            document.getElementById('empty-state')?.remove();
            return el;
        }
        function anclarNota(n, a) { n.ancla = a.id; n.ox = n.x - a.x; n.oy = n.y - a.y; }
        // Nota en el punto del clic; si hay un componente a menos de 70 px se ancla a él (lo sigue al moverlo)
        function insertarNotaEn(px, py) {
            guardarEstado();
            const n = nuevaAnotacion('nota', px, py);
            let mejor = null;
            elementosRed.filter(e => !esAnotacion(e)).forEach(e => { const c = centroElemento(e), d = Math.hypot(c.x - px, c.y - py); if (d < 70 && (!mejor || d < mejor.d)) mejor = { e, d }; });
            if (mejor) { anclarNota(n, mejor.e); aviso(`Nota anclada a ${tagDe(mejor.e)}: se moverá con él.`); }
            seleccionarElemento(n.id); abrirVentanaElemento(n.id);
        }
        function insertarNotaAnclada(el) {
            guardarEstado();
            const c = centroElemento(el), n = nuevaAnotacion('nota', c.x + 35, c.y - 55);
            anclarNota(n, el); seleccionarElemento(n.id); abrirVentanaElemento(n.id);
        }
        // Leyenda de componentes: una sola, por defecto en la esquina superior derecha del marco
        function posicionLeyenda() { const fr = marcoInterior(); return { x: fr.x1 - 190 - 4 * PX_MM, y: screenAMundoY(fr.y0 + 4 * PX_MM) }; }
        function colocarLeyenda() {
            guardarEstado();
            let l = elementosRed.find(e => e.subtype === 'leyenda');
            const p = posicionLeyenda();
            if (!l) l = nuevaAnotacion('leyenda', p.x, mundoAScreenY(p.y));
            l.offHoja = { dx: 0, dy: 0 }; renderizarVectorial();
            seleccionarElemento(l.id);
        }
        function insertarListado(px, py) {
            guardarEstado();
            let l = elementosRed.find(e => e.subtype === 'materiales');
            // siempre enganchado por defecto a la esquina superior derecha del cajetín
            if (!l) l = nuevaAnotacion('materiales', px, py);
            l.offHoja = { dx: 0, dy: 0 }; renderizarVectorial();
            seleccionarElemento(l.id);
        }
        // Filas del listado de componentes del plano: tuberías por material/serie/tamaño (m) y
        // componentes por tipo, tamaño y PN (ud)
        function filasListadoPlano() {
            const m = new Map();
            elementosRed.filter(e => !esAnotacion(e)).forEach(e => {
                let k, fila;
                if (e.type === 'tuberia') { k = ['T', e.material, e.serie, e.dn, e.gradoMaterial || '', codigoTubo(e)].join('|'); fila = { desc: `${tradDoc('Tubería')} ${tradDoc(e.material)} ${/^[0-9]+S?$/.test(e.serie) ? 'Sch ' + e.serie : e.serie}${codigoTubo(e) ? ' · ' + codigoTubo(e) : ''}`, mat: e.gradoMaterial || trad(e.material) || '', tam: tamanoTubo(e.material, e.dn), pn: '', ud: 'm', n: 0 }; }
                else if (e.type === 'bomba') { const pu = d => d && /^DN/.test(d) ? pulgadas(npsDeDN(d)) + '"' : '', tam = [pu(e.dnAsp), pu(e.dnImp)].filter(Boolean).join(' × '), pn = e.pnAsp && e.pnImp && e.pnAsp !== e.pnImp ? `${e.pnAsp} / ${e.pnImp}` : (e.pnAsp || e.pnImp || ''); k = ['B', tam, pn, e.materialComp || ''].join('|'); fila = { desc: tradDoc(nombreTipo(e)), mat: e.materialComp || '', tam, pn, ud: 'ud', n: 0 }; }
                else { const tam = e.subtype === 'reduccion' ? `${pulgadas(npsDeDN(e.dn))}" × ${pulgadas(npsDeDN(e.dnMenor))}"` : (e.dn && /^DN/.test(e.dn) ? pulgadas(npsDeDN(e.dn)) + '"' : ''); const ca = e.accModelo ? codigoAccesorio(e) : '', ma = ca ? modeloAcc(e) : null; k = [e.type, e.subtype, tam, e.pn || '', e.craneTipo || '', e.materialComp || '', ca].join('|'); fila = { desc: ma ? `${tradDoc(ma.nombre)}${e.accSch ? ' ' + e.accSch : ''} · ${ma.norma} · ${ca}` : tradDoc(nombreTipo(e)), mat: e.materialComp || '', tam, pn: !tieneRating(e) || (e.accModelo && sinRatingAcc(modeloAcc(e))) ? '' : (e.pn || ''), ud: 'ud', n: 0 }; }
                if (!m.has(k)) m.set(k, Object.assign(fila, { tags: [] }));
                const f = m.get(k); f.n += e.type === 'tuberia' ? e.longitud / 1000 : 1; f.tags.push(tagDe(e));
            });
            return [...m.values()].sort((a, b) => (a.ud === 'm' ? 0 : 1) - (b.ud === 'm' ? 0 : 1) || a.desc.localeCompare(b.desc, 'es') || a.tam.localeCompare(b.tam, 'es'));
        }

        // ==================================================================================
        // EDICIÓN DE PROPIEDADES (panel lateral y ventana modal comparten los mismos campos)
        // camposEspecificos(obj, fn) genera los controles; cada cambio llama a fn(campo, valor).
        //  - Panel: fn = cambiarCampoPanel -> se aplica al elemento en el acto (con Deshacer).
        //  - Modal: fn = cambiarCampoModal -> se aplica a un borrador; "Guardar Cambios" lo confirma.
        // Tras cada cambio se redibujan los campos, porque unos dependen de otros (material -> serie
        // -> tamaño; modo de K -> tipo Crane / serie de catálogo / K manual).
        // ==================================================================================
        const CAMPOS_NUMERICOS = ['rpm', 'potMotor', 'impulsor', 'impulsorMax', 'volCilindrada', 'volCiclos', 'volPmax', 'volCilindros', 'scale', 'rotation', 'longitud', 'caudal', 'presion', 'h0', 'npsh', 'cota', 'k', 'kRun', 'kBranch', 'theta', 'cvUsuario',
            'cotaA', 'cotaB', 'qNom', 'dpNom', 'qNom2', 'dpNom2', 'cotaEntrada', 'aislamiento', 'lambdaAisl', 'volumen', 'kvs', 'apertura', 'FL', 'eta', 'tamTexto', 'qCons', 'pMin', 'cotaLamina', 'presionDep', 'pmaManual', 'sobreespesor', 'cotaFondo', 'hB', 'hC', 'hLamina', 'pTarado', 'ox', 'oy', 'psRecipiente'];
        const CLS_CTRL = 'w-full bg-white border border-slate-300 rounded p-1 mt-0.5';
        const esc = v => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
        function opcionesSelect(lista, actual) {
            return lista.map(o => { const [v, t] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(v)}" ${v === actual ? 'selected' : ''}>${esc(t)}</option>`; }).join('');
        }
        function ctrlSelect(fn, campo, lista, actual, etiqueta) {
            return `<div>${etiqueta}: <select onchange="${fn}('${campo}', this.value)" class="${CLS_CTRL}">${opcionesSelect(lista, actual)}</select></div>`;
        }
        function ctrlNum(fn, campo, valor, etiqueta, paso = 'any') {
            return `<div>${etiqueta}: <input type="number" step="${paso}" value="${esc(valor)}" onchange="${fn}('${campo}', this.value)" class="${CLS_CTRL}"></div>`;
        }
        function ctrlTexto(fn, campo, valor, etiqueta) {
            return `<div>${etiqueta}: <input type="text" value="${esc(valor)}" onchange="${fn}('${campo}', this.value)" class="${CLS_CTRL}"></div>`;
        }
        const info = t => `<div class="text-[10px] text-slate-500 bg-white border border-slate-200 rounded p-1 leading-snug">${t}</div>`;
        const fmt = (x, n = 3) => (x == null || !isFinite(x)) ? '—' : (+x).toFixed(n);
        // ---------- Unidades de presión y caudal (Opciones > Unidades). Internamente: bar y m³/h ----------
        const UNIDADES = { p: { bar: [1, 'bar'], kPa: [100, 'kPa'], mca: [1 / 0.0980665, 'm c.a.'] }, q: { m3h: [1, 'm³/h'], ls: [1 / 3.6, 'l/s'] } };
        const uP = () => UNIDADES.p[opciones.uPresion] || UNIDADES.p.bar, uQ = () => UNIDADES.q[opciones.uCaudal] || UNIDADES.q.m3h;
        const aP = bar => bar * uP()[0], deP = v => v / uP()[0], aQ = q => q * uQ()[0], deQ = v => v / uQ()[0];
        const decP = d => opciones.uPresion === 'kPa' ? Math.max(0, d - 2) : opciones.uPresion === 'mca' ? Math.max(0, d - 1) : d;
        const fP = (bar, d = 2) => fmt(bar == null ? null : aP(bar), decP(d)), fQ = (q, d = 2) => fmt(q == null ? null : aQ(q), d);
        const lP = () => uP()[1], lQ = () => uQ()[1];
        // Campos guardados en unidades internas que se muestran y editan en las del usuario
        const CAMPOS_UNIDAD = { cota: 'mm', cotaA: 'mm', cotaB: 'mm', cotaFondo: 'mm', psRecipiente: 'p', pTarado: 'p', qNom2: 'q', dpNom2: 'pk', caudal: 'q', qNom: 'q', qCons: 'q', presion: 'p', h0: 'p', pMin: 'p', presionDep: 'p', pmaManual: 'p', dpNom: 'pk' };
        const mostrarCampo = (campo, v) => { if (v === '' || v == null) return v; const t = CAMPOS_UNIDAD[campo]; return t === 'mm' ? Math.round(+v * 1e5) / 100 : t === 'q' ? +aQ(+v).toFixed(4) : t === 'p' ? +aP(+v).toFixed(4) : t === 'pk' ? +aP(+v / 100).toFixed(4) : v; };
        const leerCampo = (campo, v) => { const t = CAMPOS_UNIDAD[campo]; return t === 'mm' ? v / 1000 : t === 'q' ? deQ(v) : t === 'p' ? deP(v) : t === 'pk' ? deP(v) * 100 : v; };
        // Control numérico con conversión de unidades; etiqueta sin unidad (se añade la del usuario)
        function ctrlMag(fn, campo, valor, etiqueta, extra = '') {
            const t = CAMPOS_UNIDAD[campo], u = t === 'q' ? lQ() : lP();
            return ctrlNum(fn, campo, mostrarCampo(campo, valor), `${etiqueta} (${u}${extra})`, 'any');
        }

        function camposComunes(obj, fn) {
            return ctrlTexto(fn, 'name', obj.name, 'Descripción') + ctrlNum(fn, 'scale', obj.scale, 'Escala', '0.1') + ctrlNum(fn, 'rotation', obj.rotation || 0, 'Rotación (°)', '90');
        }

        function camposEspecificos(obj, fn) {
            let h = esAnotacion(obj) ? info(`<b class="text-slate-700">${esc(tagDe(obj))}</b>`) : info(`<b class="text-slate-700">${esc(tagDe(obj))}</b><br>Línea ${obj.linea || '<span class="text-amber-600">sin asignar</span>'}${lineaPorId(obj.linea) && lineaPorId(obj.linea).nombre ? ' · ' + esc(lineaPorId(obj.linea).nombre) : ''}`);
            if (esAnotacion(obj)) {
                if (obj.subtype === 'nota') {
                    h += `<div>Texto:<textarea rows="4" onchange="${fn}('texto', this.value)" class="${CLS_CTRL}">${esc(obj.texto || '')}</textarea></div>` + ctrlSelect(fn, 'marco', [['true', 'Con marco'], ['discontinuo', 'Marco discontinuo'], ['false', 'Sin marco']], String(obj.marco == null ? true : obj.marco), 'Marco');
                    h += ctrlSelect(fn, 'ancla', [['', '— sin anclar —'], ...elementosRed.filter(e => !esAnotacion(e)).map(e => [e.id, tagDe(e)])], obj.ancla || '', 'Anclada a (sigue al componente)');
                }
                if (obj.subtype === 'nota') h += ctrlNum(fn, 'tamTexto', obj.tamTexto || 7, 'Tamaño de texto', '0.5');
                return h + info(obj.subtype === 'leyenda' ? 'Se actualiza sola con los componentes del plano. Enganchada por su esquina superior derecha a la de la zona de trabajo; se recoloca al cambiar de formato. Para moverla: botón derecho sobre la tabla > Mover / Desconectar.' : obj.subtype === 'materiales' ? 'Tabla de materiales del plano (se actualiza sola). Enganchada por su esquina inferior derecha a la superior derecha del cajetín; se recoloca al cambiar de formato. Para moverla: botón derecho sobre la tabla > Mover / Desconectar.' : 'Anotación: no interviene en el cálculo.');
            }
            h += camposLibreria(obj, fn);
            if (obj.subtype === 'continuacion') {
                const otras = hojas.filter((x, i) => i !== hojaActual).map(x => [x.id, 'Hoja ' + x.id]);
                h += ctrlSelect(fn, 'hojaDestino', [['', '— sin hoja —'], ...otras], obj.hojaDestino || '', 'Continúa en la hoja');
                const par = parejaDe(obj);
                h += info(`Enlace <b>${esc(obj.enlace || '')}</b> · ${par ? `pareja ${esc(tagDe(par))} en la hoja ${esc(obj.hojaDestino)} <button onclick="irAParejaContinuacion('${obj.id}')" class="ml-1 px-1.5 border rounded text-blue-700">Ir</button>` : otras.length ? 'la pareja se crea en la hoja de destino al elegirla' : 'añade otra hoja (Alt+A) para continuar la línea'}. Para calcular las hojas unidas: Cálculo &gt; Calcular proyecto completo.`);
            }
            if (tieneRating(obj) && !(obj.accModelo && sinRatingAcc(modeloAcc(obj)))) h += (obj.accModelo && modeloAcc(obj) ? '' : ctrlSelect(fn, 'normaPN', NORMAS_PN, normaPN(obj), 'Norma')) + ctrlSelect(fn, 'pn', obj.accModelo && modeloAcc(obj) ? [['', '— sin indicar —'], ...ratingsAcc(modeloAcc(obj))] : listaPN(obj), obj.pn || '', 'PN / Rating');
            if (obj.type !== 'tuberia' && obj.type !== 'bomba' && !esDeposito(obj)) h += ctrlNum(fn, 'cota', mostrarCampo('cota', obj.cota || 0), 'Cota (mm)', '1');
            if (obj.type === 'equipo') {
                h += ctrlMag(fn, 'qNom', obj.qNom, dosCircuitos(obj) ? 'Primario a–b: caudal nominal' : 'Caudal nominal') + ctrlMag(fn, 'dpNom', obj.dpNom, 'Δp a caudal nominal');
                if (dosCircuitos(obj)) h += ctrlMag(fn, 'qNom2', obj.qNom2, 'Secundario c–d: caudal nominal') + ctrlMag(fn, 'dpNom2', obj.dpNom2, 'Δp a caudal nominal');
                h += ctrlNum(fn, 'volumen', obj.volumen || '', 'Volumen interior (l) · vaso de expansión y PED recipientes', 'any');
                if (+obj.volumen > 0) h += ctrlMag(fn, 'psRecipiente', obj.psRecipiente || '', 'PS del recipiente', '; vacío = calculada') + infoRecipiente(obj);
                return h + info('Pérdida de carga del fabricante: Δp = Δp nom · (Q/Q nom)².');
            }
            if (obj.subtype === 'consumo') {
                h += ctrlMag(fn, 'qCons', obj.qCons, 'Caudal demandado') + ctrlMag(fn, 'pMin', obj.pMin, 'Presión mínima', ' man.');
                return h + info('Extremo con caudal impuesto. Se comprueba p ≥ p mín. y se calcula la válvula de equilibrado para el exceso de presión.');
            }
            if (esDeposito(obj)) {
                h += ctrlNum(fn, 'cotaFondo', mostrarCampo('cotaFondo', obj.cotaFondo), 'Cota del fondo del tanque (mm)', '1') + ctrlNum(fn, 'hB', obj.hB, 'Conexión lateral b: altura sobre el fondo (m)', '0.01') +
                    ctrlNum(fn, 'hC', obj.hC, 'Conexión superior c: altura sobre el fondo (m)', '0.01') + ctrlNum(fn, 'hLamina', obj.hLamina, 'Nivel de líquido sobre el fondo (m)', '0.01') +
                    ctrlSelect(fn, 'tipoConexion', TIPOS_CONEXION, obj.tipoConexion, 'Tipo de conexión') + ctrlSelect(fn, 'dnConexion', [['', '— igual que la tubería —'], ...LISTA_DN.map(d => [d, etiquetaDN(d)])], obj.dnConexion || '', 'Tamaño de la conexión') +
                    ctrlMag(fn, 'presionDep', obj.presionDep, 'Presión sobre la lámina', ' man.') +
                    ctrlNum(fn, 'volumen', obj.volumen || '', 'Volumen interior (l) · PED recipientes y vaso', 'any') + ctrlMag(fn, 'psRecipiente', obj.psRecipiente || '', 'PS del recipiente', '; vacío = calculada') + infoRecipiente(obj);
                return h + info(`Conexión b a cota ${fmt(obj.cota, 2)} m · c a ${fmt(obj.cotaEntrada, 2)} m · lámina a ${fmt(obj.cotaLamina, 2)} m.<br>Condición de contorno: altura piezométrica = cota de lámina + presión.`);
            }
            if (obj.type === 'instrumento') {
                h += ctrlSelect(fn, 'dnInstr', [['', '—'], ...LISTA_DN.slice(0, 8).map(d => [d, etiquetaDN(d)])], obj.dnInstr || '', 'Conexión a proceso') + ctrlTexto(fn, 'rango', obj.rango || '', 'Rango / escala');
            }
            if (obj.type === 'instrumento' || sinFlujo(obj)) {
                if (obj.type !== 'instrumento') h += ctrlSelect(fn, 'dn', LISTA_DN.map(d => [d, etiquetaDN(d)]), obj.dn, 'DN') + ctrlMag(fn, 'pTarado', obj.pTarado || '', 'Presión de tarado');
                return h + info('Sin caudal en servicio normal: se excluye del cálculo hidráulico y su conexión no necesita condición de contorno.');
            }
            if (obj.type === 'tuberia') {
                const m = materialDe(obj);
                const tams = m.tamanos.filter(t => t.e[obj.serie] != null).map(t => [t.clave, t.nps ? (esAceroTubo(obj.material) ? `${pulgadas(t.nps)}" (${t.clave}) · De ${t.od} mm` : `${t.clave} (${t.nps}")`) : `${t.clave} (De ${t.od} mm)`]);
                const dt = datosTuberia(obj);
                h += ctrlSelect(fn, 'serie', m.series.filter(sr => m.tamanos.some(t => t.e[sr] != null)).map(sr => [sr, /^[0-9]+$/.test(sr) ? 'Sch ' + sr : sr]), obj.serie, 'Serie / schedule');
                h += ctrlSelect(fn, 'dn', tams, obj.dn, 'Medida nominal');
                h += ctrlNum(fn, 'longitud', obj.longitud, 'Longitud (mm)', '1');
                h += ctrlNum(fn, 'cotaA', mostrarCampo('cotaA', obj.cotaA), 'Cota extremo a (mm)', '1') + ctrlNum(fn, 'cotaB', mostrarCampo('cotaB', obj.cotaB), 'Cota extremo b (mm)', '1');
                const T = parseFloat(document.getElementById('temp-fluido').value) || 20, pm = pmaTuberia(obj, T);
                if (S_ADM[obj.material]) h += ctrlNum(fn, 'sobreespesor', obj.sobreespesor != null ? obj.sobreespesor : S_ADM[obj.material].c, 'Sobreespesor de corrosión c (mm)', '0.1');
                h += ctrlMag(fn, 'pmaManual', obj.pmaManual || '', 'PMA manual', '; vacío = automática');
                h += ctrlNum(fn, 'aislamiento', obj.aislamiento || '', 'Aislamiento, espesor (mm; vacío = sin aislar)', '1') + ctrlNum(fn, 'lambdaAisl', obj.lambdaAisl || 0.040, 'λ del aislamiento (W/m·K)', '0.001');
                { const eR = aislamientoRITE(dt.od, T, !!proyecto.exterior); if (eR) h += info(`Mínimo RITE a ${T} °C: ${Math.ceil(espesorPorLambda(dt.od, eR, +obj.lambdaAisl > 0 ? +obj.lambdaAisl : 0.04))} mm (λ ${obj.lambdaAisl || 0.040})`); }
                h += info(`PMA a ${T} °C: <b>${pm.pma != null ? fP(pm.pma, 1) + ' ' + lP() : '<span class="text-amber-600">sin dato</span>'}</b><br>${esc(pm.origen)}`);
                h += info(`${dt.norma}${dt.ref ? ' (sin tabla propia)' : ''}<br>OD ${fmt(dt.od, 1)} · e ${fmt(dt.e, 2)} · <b>Dint ${fmt(dt.Dint, 1)} mm</b><br>Rugosidad ε ${dt.rug} mm`);
            } else if (obj.type === 'valvula' || obj.type === 'accesorio') {
                const esRed = obj.subtype === 'reduccion', esTee = esNodo(obj);
                const listaDN = LISTA_DN.map(d => [d, etiquetaDN(d)]);
                h += ctrlSelect(fn, 'dn', listaDN, obj.dn, esRed ? 'DN mayor (puerto a)' : 'DN');
                if (esRed) {
                    h += ctrlSelect(fn, 'dnMenor', listaDN.filter(d => dnNum(d[0]) < dnNum(obj.dn)), obj.dnMenor, 'DN menor (puerto b)');
                    h += ctrlSelect(fn, 'excentrica', [['false', 'Concéntrica'], ['true', 'Excéntrica']], String(!!obj.excentrica), 'Tipo');
                    const t = thetaReduccion(obj);
                    if (CAT.reducciones[`${dnNum(obj.dn)}-${dnNum(obj.dnMenor)}`]) {
                        h += ctrlSelect(fn, 'thetaManual', [['false', `ASME B16.9 (H ${t.H} mm, θ ${t.theta}°)`], ['true', 'Ángulo manual']], String(!!obj.thetaManual), 'Ángulo del cono');
                    }
                    if (t.fuente === 'manual') h += ctrlNum(fn, 'theta', obj.theta || 30, 'Ángulo total del cono θ (°)', '1');
                    const r = kReduccion(obj, dintReferencia(obj.dn), dintReferencia(obj.dnMenor));
                    h += info(`θ ${fmt(r.theta, 1)}° · β ${fmt(r.beta, 3)}<br>K contracción ${fmt(r.kc)} · K expansión ${fmt(r.ke)}<br>(referidos al DN menor; el sentido lo fija el caudal calculado)`);
                    return h;
                }
                if (calcDe(obj) === 'cero') return h + info('K despreciable (K = 0).');
                const modos = [];
                if (opcionesCrane(claveCrane(obj)).length || esTee) modos.push(['crane', esTee ? 'Automático (Crane)' : (calcDe(obj) === 'pedir' ? 'Sin dato del fabricante (estimado)' : 'Automático (Crane)')]);
                if (obj.type === 'valvula' && !esTee) modos.push(['catalogo', 'Catálogo de fabricante (Cv)']);
                if (!esTee) modos.push(['cv', 'Cv del fabricante (introducido)']);
                if (obj.subtype === 'control' || obj.subtype === 'neumatica') modos.push(['kvs', 'Regulación: Kvs, característica y apertura']);
                modos.push(['manual', 'K manual']);
                h += ctrlSelect(fn, 'modoK', modos, obj.modoK, 'Coeficiente K');
                if (esTee) {
                    if (obj.modoK === 'manual') {
                        h += ctrlNum(fn, 'kRun', obj.kRun, 'K paso directo', '0.01') + ctrlNum(fn, 'kBranch', obj.kBranch, 'K derivación', '0.01');
                    } else {
                        const kt = kTee(obj);
                        h += info(`Paso directo 20·fT = ${fmt(kt.run)}<br>Derivación 60·fT = ${fmt(kt.der)}<br>Puertos a–b: paso directo · c: derivación`);
                    }
                    return h;
                }
                if (obj.modoK === 'manual') {
                    h += ctrlNum(fn, 'k', obj.k, 'K', '0.01');
                } else if (obj.modoK === 'kvs') {
                    h += ctrlNum(fn, 'kvs', obj.kvs || '', 'Kvs (m³/h, 1 bar)', 'any') + ctrlSelect(fn, 'caracteristica', [['iso', 'Isoporcentual (R = 50)'], ['lineal', 'Lineal']], obj.caracteristica || 'iso', 'Característica') +
                        ctrlNum(fn, 'apertura', obj.apertura != null ? obj.apertura : 70, 'Apertura (%)', '1') + ctrlNum(fn, 'FL', obj.FL || 0.9, 'Factor de recuperación FL (IEC 60534)', '0.01');
                    h += info(`Kv a la apertura: ${fmt(kvApertura(obj), 2)} m³/h. Se comprueba la cavitación (σ y Δp de estrangulamiento IEC 60534).`);
                } else if (obj.modoK === 'cv') {
                    h += ctrlNum(fn, 'cvUsuario', obj.cvUsuario, 'Cv (gpm/√psi)', 'any');
                    const kk = kElemento(obj, dintReferencia(obj.dn));
                    h += info(`Kv ${obj.cvUsuario ? fmt(obj.cvUsuario / 1.156, 1) : '—'} · K ≈ ${fmt(kk.K)} con Dint Sch 40`);
                } else if (obj.modoK === 'catalogo') {
                    const lista = seriesValvula(obj);
                    if (!lista.length) h += info(`<span class="text-amber-600">No hay series de catálogo de este tipo con ${obj.dn}. Se usará el K de Crane.</span>`);
                    else {
                        h += ctrlSelect(fn, 'serieCat', lista.map(v => v.nombre), obj.serieCat, 'Serie de catálogo');
                        const sv = lista.find(v => v.nombre === obj.serieCat);
                        const kk = kElemento(obj, dintReferencia(obj.dn));
                        h += info(`Cv ${sv ? sv.cv[npsDeDN(obj.dn)] : '—'} (${npsDeDN(obj.dn)}") · Kv ${sv ? fmt(sv.cv[npsDeDN(obj.dn)] / 1.156, 1) : '—'}<br>K ≈ ${fmt(kk.K)} con Dint Sch 40<br>${sv ? esc(sv.fuente) : ''}${sv && sv.nota ? '<br><span class="text-amber-600">' + esc(sv.nota) + '</span>' : ''}`);
                    }
                } else {
                    const ops = opcionesCrane(claveCrane(obj));
                    if (ops.length > 1) h += ctrlSelect(fn, 'craneTipo', ops.map(o => o[0]), obj.craneTipo, 'Tipo');
                    const kk = kElemento(obj, dintReferencia(obj.dn));
                    h += info(`${esc(kk.origen)}<br>fT ${fmt(fT(dnNum(obj.dn), dintReferencia(obj.dn)), 4)} · K = ${fmt(kk.K)}`);
                }
                if (obj.modoK === 'catalogo' || obj.modoK === 'cv' || (obj.modoK === 'crane' && calcDe(obj) !== 'pedir')) h += info('En el cálculo, K se recalcula con el Dint de la tubería conectada.');
            } else if (obj.type === 'bomba') {
                const vol = esVolumetrica(obj), rhoB = fluidoActual().rho || 1000;
                h += ctrlSelect(fn, 'bombaTipo', TIPOS_BOMBA, obj.bombaTipo || 'centrifuga', 'Tipo de bomba');
                h += ctrlTexto(fn, 'fabricante', obj.fabricante || '', 'Fabricante') + ctrlTexto(fn, 'modelo', obj.modelo || '', 'Modelo');
                h += ctrlMag(fn, 'caudal', obj.caudal, 'Caudal de diseño');
                h += ctrlMag(fn, 'presion', obj.presion, vol ? 'Presión de descarga de diseño' : 'Presión de diseño');
                h += info(`Altura manométrica: ${fmt((+obj.presion || 0) * 1e5 / (rhoB * G), 2)} m c.l.`);
                if (vol) {
                    h += `<p class="font-bold text-slate-600 pt-1 text-[11px]">Bomba volumétrica</p>` + ctrlNum(fn, 'volCilindrada', obj.volCilindrada == null ? '' : obj.volCilindrada, 'Volumen por ciclo / revolución (cm³)') + ctrlNum(fn, 'volCiclos', obj.volCiclos == null ? '' : obj.volCiclos, 'Ciclos o revoluciones por minuto') +
                        ctrlNum(fn, 'volPmax', obj.volPmax == null ? '' : obj.volPmax, 'Presión máxima de trabajo (bar)') + ctrlNum(fn, 'volCilindros', obj.volCilindros == null ? '' : obj.volCilindros, 'N.º de cilindros / pulsaciones por ciclo', '1') + ctrlTexto(fn, 'volMaterial', obj.volMaterial || '', obj.bombaTipo === 'peristaltica' ? 'Material del tubo / manguera' : 'Material de válvulas y sellos');
                    h += info(`El caudal no depende de la presión de descarga: ${+obj.volCilindrada > 0 && +obj.volCiclos > 0 ? `${fmt(caudalVolumetrica(obj), 3)} m³/h (volumen por ciclo × ciclos)` : 'se toma el caudal de diseño'}.${+obj.volPmax > 0 ? '' : ' <b class="text-amber-700">Falta la presión máxima de trabajo.</b>'}`);
                } else h += ctrlMag(fn, 'h0', obj.h0, 'Presión a caudal cero / cierre');
                h += ctrlNum(fn, 'npsh', obj.npsh, 'NPSH requerido (m)', '0.1');
                { const r = ultimoResultado && ultimoResultado[obj.id];
                  if (r && r.npshd != null) { const marg = r.npshd - obj.npsh, ok = marg >= opciones.margenNPSH;
                    h += `<div class="rounded border-2 p-1.5 text-[11px] ${ok ? 'border-emerald-500 bg-emerald-50 text-emerald-800' : 'border-rose-500 bg-rose-50 text-rose-700'}"><b>NPSH ${ok ? 'CORRECTO' : 'INSUFICIENTE — RIESGO DE CAVITACIÓN'}</b><br>NPSHd ${fmt(r.npshd, 2)} m · NPSHr ${fmt(obj.npsh, 2)} m · margen ${fmt(marg, 2)} m (mín. ${opciones.margenNPSH} m)</div>`; }
                  else h += info('NPSH: se comprueba al calcular la red (NPSHd ≥ NPSHr + margen).'); }
                h += ctrlNum(fn, 'cota', mostrarCampo('cota', obj.cota || 0), 'Cota de la bomba (mm)', '1');
                h += ctrlNum(fn, 'eta', obj.eta || 0.70, 'Rendimiento de la bomba η', '0.01');
                h += ctrlNum(fn, 'rpm', obj.rpm == null ? '' : obj.rpm, 'Velocidad de rotación (rpm)', '1') + ctrlNum(fn, 'potMotor', obj.potMotor == null ? '' : obj.potMotor, 'Potencia del motor (kW)');
                h += ctrlTexto(fn, 'tension', obj.tension || '', 'Tensión (V)') + ctrlTexto(fn, 'frecuencia', obj.frecuencia || '', 'Frecuencia (Hz)') + ctrlTexto(fn, 'ip', obj.ip || '', 'Grado de protección (IP)');
                if (!vol) h += ctrlNum(fn, 'impulsor', obj.impulsor == null ? '' : obj.impulsor, 'Diámetro del impulsor (mm)') + ctrlNum(fn, 'impulsorMax', obj.impulsorMax == null ? '' : obj.impulsorMax, 'Diámetro máximo del impulsor (mm)');
                h += ctrlTexto(fn, 'apiPlan', obj.apiPlan || '', 'Plan de sellado (API 682)');
                { const dns = [['', '—'], ...LISTA_DN.map(d => [d, etiquetaDN(d)])], pns = [['', '—'], ...PN_LISTA.filter(x => !/^(2000|3000|6000|9000)#$/.test(x))];
                  h += `<p class="font-bold text-slate-600 pt-1 text-[11px]">Conexiones</p>` + ctrlSelect(fn, 'dnAsp', dns, obj.dnAsp || '', 'Entrada (aspiración) · tamaño') + ctrlSelect(fn, 'pnAsp', pns, obj.pnAsp || '', 'Entrada · rating') +
                       ctrlSelect(fn, 'dnImp', dns, obj.dnImp || '', 'Salida (impulsión) · tamaño') + ctrlSelect(fn, 'pnImp', pns, obj.pnImp || '', 'Salida · rating'); }
                if (!vol) h += `<button onclick="abrirCurvaBomba('${obj.id}')" class="w-full mt-1 px-2 py-1 border border-blue-300 rounded text-blue-700 hover:bg-blue-50 text-[11px]"><i class="fa-solid fa-chart-line mr-1"></i>${obj.curva ? `Curva del fabricante (${obj.curva.length} puntos, ${obj.curvaModo === 'puntos' ? 'interpolada' : 'ajustada'})...` : 'Curva Q-H del fabricante: pegar o digitalizar...'}</button>`;
                const otras = elementosRed.filter(e => e.type === 'bomba' && e.id !== obj.id && !e.reservaDe);
                h += ctrlSelect(fn, 'reservaDe', [['', 'Servicio'], ...otras.map(e => [e.id, 'Reserva de ' + tagDe(e)])], obj.reservaDe || '', 'Función');
                if (obj.reservaDe) h += info('Bomba de reserva: se calcula parada en el escenario normal y sustituye a su bomba de servicio en Cálculo > Escenario de bombas > Reserva en marcha. El informe comprueba los dos escenarios.');
            }
            return h;
        }

        // Categoría PED del recipiente (último cálculo) y enlace a la app «Recipientes a presión»
        function infoRecipiente(obj) {
            if (!(+obj.volumen > 0)) return info('Indica el volumen interior para clasificarlo como recipiente (PED, cuadros 1 a 4).');
            const x = ultimoCalculo && (ultimoCalculo.resultado.pedRecipientes || []).find(r => r.id === obj.id);
            if (!x) return info('Categoría PED del recipiente: se obtiene al calcular la red.');
            return info(`<b>PED recipiente: ${esc(x.cat === 'Art. 4.3' ? 'art. 4.3' : x.cat === 'Fuera' ? 'fuera de la Directiva' : 'categoría ' + x.cat)}</b> · ${esc(x.cuadro)}<br>PS ${fP(x.PS, 2)} ${lP()} (${x.origenPS}) · V ${fmt(x.V, 0)} l · PS·V ${fmt(x.PSV, 0)}<br><a href="${esc(x.url)}" target="_blank" rel="noopener" class="text-blue-600 hover:underline">Abrir en Recipientes a presión ↗</a>`);
        }
        function convertirValor(campo, valor) {
            if (CAMPOS_NUMERICOS.includes(campo)) { const v = parseFloat(valor); return isNaN(v) ? null : v; }
            if (valor === 'true') return true;
            if (valor === 'false') return false;
            return valor;
        }
        // Aplica un cambio a un objeto (elemento o borrador) y deja coherentes los campos dependientes
        function aplicarCambio(obj, campo, valor) {
            if (campo === 'pmaManual' && String(valor).trim() === '') { delete obj.pmaManual; return true; }
            if (campo === 'aislamiento' && (String(valor).trim() === '' || +valor <= 0)) { delete obj.aislamiento; return true; }
            if (campo === 'marco') { obj.marco = valor === 'true' ? true : valor === 'false' ? false : valor; return true; }
            if (campo === 'libItem') { aplicarItemLib(obj, valor ? itemPorId(valor) : null); return true; }
            if (campo === 'accModelo') { aplicarModeloAcc(obj, valor); return true; }
            if (campo === 'accSch') { if (valor) obj.accSch = valor; else delete obj.accSch; return true; }
            if (['materialComp', 'url', 'gradoMaterial'].includes(campo) && String(valor).trim() === '') { delete obj[campo]; return true; }
            if (campo === 'ancla') { const a = valor && elementosRed.find(e => e.id === valor); if (a) { obj.ancla = a.id; obj.ox = obj.x - a.x; obj.oy = obj.y - a.y; } else { delete obj.ancla; delete obj.ox; delete obj.oy; } return true; }
            if (['pn', 'dnConexion', 'dnInstr', 'pTarado', 'psRecipiente', 'volumen'].includes(campo) && String(valor).trim() === '') { if (campo !== 'pn' || obj.type === 'tuberia') delete obj[campo]; return true; }
            if (campo === 'reservaDe') { if (valor) { obj.reservaDe = valor; elementosRed.filter(e => e.reservaDe === obj.id).forEach(e => delete e.reservaDe); } else delete obj.reservaDe; return true; }
            let v = convertirValor(campo, valor);
            if (v === null) return false;
            if (CAMPOS_UNIDAD[campo]) v = leerCampo(campo, v); // número no válido: se ignora (evita NaN en el cálculo)
            if (campo === 'scale' && v <= 0) return false;
            if (campo === 'longitud' && v <= 0) return false;
            if (campo === 'pmaManual' && String(valor).trim() === '') { delete obj.pmaManual; normalizarElemento(obj); return true; }
            if (obj.type === 'tuberia' && (campo === 'cotaA' || campo === 'cotaB' || campo === 'longitud')) {
                const za = campo === 'cotaA' ? v : +obj.cotaA, zb = campo === 'cotaB' ? v : +obj.cotaB, L = (campo === 'longitud' ? v : obj.longitud) / 1000;
                if (Math.abs(zb - za) > L + 1e-6) { alert(`El desnivel (${Math.abs(zb - za).toFixed(2)} m) no puede superar la longitud (${L} m).`); return false; }
            }
            if ((campo === 'qNom' && !(v > 0)) || ((campo === 'dpNom' || campo === 'qCons') && v < 0)) return false;
            // tubería que cambia de largo en el dibujo: lo que cuelga de su extremo se desplaza con él (sin huecos)
            const arrastre = obj.type === 'tuberia' && (campo === 'longitud' || campo === 'scale') && elementosRed.includes(obj) && +obj[campo] !== v ? prepararArrastreTuberia(obj) : null;
            obj[campo] = v;
            if (arrastre) arrastrarTrasTuberia(obj, arrastre);
            if (campo === 'modoK' && v === 'manual') {
                const kk = esNodo(obj) ? kTee(Object.assign({}, obj, { modoK: 'crane' })) : null;
                if (kk) { obj.kRun = +kk.run.toFixed(3); obj.kBranch = +kk.der.toFixed(3); }
                else if (obj.k == null) obj.k = 0;
            }
            normalizarElemento(obj);
            asignarNumero(obj); // si cambia el código (material, concéntrica/excéntrica) se renumera
            return true;
        }

        // Al acortar o alargar una tubería, su extremo a queda fijo y todo lo conectado aguas abajo de b
        // (recorriendo la red sin volver a pasar por la tubería) se traslada lo mismo que b. Si b no tiene
        // nada conectado y a sí, se mueve la propia tubería (queda fijo b). En una malla cerrada no se
        // puede trasladar como sólido rígido: se avisa.
        function grupoDesde(inicio, excluir) {
            const vistos = new Set([excluir.id]), grupo = [], cola = [...inicio];
            cola.forEach(e => vistos.add(e.id));
            while (cola.length) { const x = cola.shift(); grupo.push(x); vecinosDe(x).forEach(v => { if (!vistos.has(v.otro.id)) { vistos.add(v.otro.id); cola.push(v.otro); } }); }
            return grupo;
        }
        function prepararArrastreTuberia(t) {
            const vec = vecinosDe(t), enA = vec.filter(v => v.puertoEl === 'a').map(v => v.otro), enB = vec.filter(v => v.puertoEl === 'b').map(v => v.otro);
            const pp = obtenerPuertosConexion(t), A = pp.find(p => p.id === 'a'), B = pp.find(p => p.id === 'b');
            if (!enB.length) return { modo: 'fijoA', A, B };
            if (!enA.length) return { modo: 'fijoB', A, B }; // extremo a libre: se mueve la tubería y la red no
            const grupo = grupoDesde(enB, t);
            if (enA.some(e => grupo.includes(e))) return { modo: 'malla', A, B };
            return { modo: 'arrastre', grupo, A, B };
        }
        function arrastrarTrasTuberia(t, q) {
            const pp = obtenerPuertosConexion(t), B2 = pp.find(p => p.id === 'b');
            const dx = B2.x - q.B.x, dy = B2.y - q.B.y;
            if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return;
            if (q.modo === 'fijoB') { t.x -= dx; t.y += dy; }
            else if (q.modo === 'arrastre') { q.grupo.forEach(e => { if (!esTablaHoja(e)) { e.x += dx; e.y -= dy; } }); }
            else if (q.modo === 'malla') aviso(`${tagDe(t)} forma parte de una malla cerrada: los componentes no se pueden trasladar sin romper otra conexión. Reajusta el dibujo a mano.`, 'error');
        }
        function cambiarCampoPanel(id, campo, valor) {
            const el = elementosRed.find(item => item.id === id);
            if (!el) return;
            guardarEstado();
            invalidarResultados();
            aplicarCambio(el, campo, valor);
            seleccionarElemento(id); // redibuja el lienzo y el panel (campos dependientes)
        }

        // ---------- Ventana flotante del elemento (doble clic) ----------
        // Los cambios se aplican en el acto (con Deshacer), igual que en el panel izquierdo.
        let ventanaId = null;
        function abrirVentanaElemento(id, x, y) {
            const el = elementosRed.find(e => e.id === id);
            if (!el) return;
            ventanaId = id;
            if (idSeleccionado !== id) seleccionarElemento(id);
            const v = modalEdicion;
            v.style.display = 'block';
            pintarVentana();
            if (x != null) {
                const w = v.offsetWidth, h = v.offsetHeight;
                v.style.left = Math.max(8, Math.min(x + 24, window.innerWidth - w - 8)) + 'px';
                v.style.top = Math.max(8, Math.min(y - 40, window.innerHeight - h - 8)) + 'px';
            } else if (!v.style.left) { v.style.left = (window.innerWidth - 420) + 'px'; v.style.top = '110px'; }
        }
        const abrirModalEdicion = id => abrirVentanaElemento(id);
        window.__cambiarVentana = (campo, valor) => { if (!ventanaId) return; cambiarCampoPanel(ventanaId, campo, valor); pintarVentana(); };
        function accionVentana(accion) {
            const el = elementosRed.find(e => e.id === ventanaId); if (!el) return;
            if (accion === 'eliminar') { eliminarElemento(el.id); cerrarModal(); return; }
            if (accion === 'suelto') { el._suelto = true; aviso('Componente liberado del imantado: arrástralo a su nueva posición.'); return; }
            if (accion === 'nota') { insertarNotaAnclada(el); return; }
            guardarEstado(); invalidarResultados(); girarElemento(el, +accion); renderizarVectorial(); seleccionarElemento(el.id); pintarVentana();
        }
        function pintarVentana() {
            const el = elementosRed.find(e => e.id === ventanaId);
            if (!el) { cerrarModal(); return; }
            modalEdicion.style.width = el.subtype === 'tabla' ? 'min(92vw, 860px)' : '380px';
            document.getElementById('ventana-titulo').innerHTML = `<i class="fa-solid fa-sliders text-blue-600 mr-1.5"></i>${esc(tagDe(el))} <span class="font-normal text-slate-400">· ${esc(nombreTipo(el))}</span>`;
            const b = (acc, ico, t, cls = '') => `<button onclick="accionVentana('${acc}')" title="${t}" class="border border-slate-300 rounded px-1.5 py-1 hover:bg-slate-50 ${cls}"><i class="fa-solid ${ico} mr-1"></i>${t}</button>`;
            let h = `<div class="flex flex-wrap gap-1">${b('90', 'fa-rotate-right text-emerald-600', '90° horario')}${b('-90', 'fa-rotate-left text-emerald-600', '90° antihorario')}${b('180', 'fa-rotate text-emerald-600', '180°')}${b('suelto', 'fa-arrows-up-down-left-right text-amber-600', 'Mover')}${esAnotacion(el) ? '' : b('nota', 'fa-note-sticky text-blue-600', 'Nota')}${b('eliminar', 'fa-trash-can', 'Eliminar', 'text-rose-600')}</div>`;
            if (!esAnotacion(el)) {
                const ops = lineasEnOrden().map(o => `<option value="${o.linea.id}" ${o.linea.id === el.linea ? 'selected' : ''}>${' '.repeat(o.nivel)}${o.linea.id}${o.linea.nombre ? ' · ' + esc(o.linea.nombre) : ''}</option>`).join('');
                const huerf = lineas.filter(l => !lineasEnOrden().some(o => o.linea.id === l.id)).map(l => `<option value="${l.id}" ${l.id === el.linea ? 'selected' : ''}>${l.id}</option>`).join('');
                h += `<div>Línea / ramal: <select onchange="cambiarLineaElemento('${el.id}', this.value)" class="${CLS_CTRL}">${el.linea ? '' : '<option value="" selected>— sin asignar —</option>'}${ops}${huerf}<option value="__ramal">+ Nuevo ramal que parte de ${esc(el.linea || 'la línea')}</option><option value="__principal">+ Nueva línea principal</option></select></div>`;
            }
            if (el.subtype === 'tabla') h += editorTabla(el);
            else h += `<div class="space-y-1.5">${camposComunes(el, '__cambiarVentana')}${camposEspecificos(el, '__cambiarVentana')}</div>`;
            h += `<div class="flex justify-end pt-1"><button onclick="cerrarModal()" class="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded font-medium">Cerrar</button></div>`;
            document.getElementById('modal-content-body').innerHTML = h;
            const r = modalEdicion.getBoundingClientRect();
            if (r.right > window.innerWidth - 8) modalEdicion.style.left = Math.max(8, window.innerWidth - r.width - 8) + 'px';
        }
        // Cambio de la línea (o ramal) a la que pertenece un elemento
        function cambiarLineaElemento(id, valor) {
            const el = elementosRed.find(e => e.id === id); if (!el) return;
            guardarEstado(); invalidarResultados();
            if (valor === '__ramal') {
                const padre = el.linea || (lineas[0] || {}).id;
                if (!padre) { valor = '__principal'; }
                else { const nid = siguienteLinea('ramal', padre); const nodo = vecinosDe(el).find(v => esNodo(v.otro)); lineas.push({ id: nid, tipo: 'ramal', nombre: '', padre, desde: nodo ? nodo.otro.id : null }); el.linea = nid; el.inicioLinea = true; }
            }
            if (valor === '__principal') {
                const nombre = prompt('Nombre de la nueva línea principal:', '') || '';
                const nid = siguienteLinea('principal'); lineas.push({ id: nid, tipo: 'principal', nombre: nombre.trim() }); el.linea = nid; el.inicioLinea = true;
            } else if (valor && valor !== '__ramal') { el.linea = valor; }
            purgarLineasVacias();
            renderizarVectorial(); seleccionarElemento(el.id); if (ventanaId === el.id) pintarVentana();
        }
        // Quita las líneas sin elementos ni ramales que dependan de ellas
        function purgarLineasVacias() {
            let cambio = true;
            while (cambio) { cambio = false; lineas = lineas.filter(l => { const usada = elementosRed.some(e => e.linea === l.id) || lineas.some(r => r.padre === l.id); if (!usada) cambio = true; return usada; }); }
        }
        function cerrarModal() { modalEdicion.style.display = 'none'; ventanaId = null; }
        function guardarEdicionModal() { cerrarModal(); } // compatibilidad: la ventana aplica los cambios en el acto
        // Arrastre de la ventana por su cabecera
        (function () {
            const cab = document.getElementById('ventana-cabecera'); let d = null;
            cab.addEventListener('mousedown', e => { if (e.target.closest('button')) return; const r = modalEdicion.getBoundingClientRect(); d = { x: e.clientX - r.left, y: e.clientY - r.top }; e.preventDefault(); });
            window.addEventListener('mousemove', e => { if (!d) return; modalEdicion.style.left = Math.max(0, Math.min(e.clientX - d.x, window.innerWidth - 60)) + 'px'; modalEdicion.style.top = Math.max(0, Math.min(e.clientY - d.y, window.innerHeight - 30)) + 'px'; });
            window.addEventListener('mouseup', () => { d = null; });
        })();
        // ---------- Avisos breves y diálogo con botones ----------
        function aviso(texto, tipo = 'info') {
            const c = document.getElementById('avisos'); if (!c) return;
            const d = document.createElement('div');
            d.className = `px-3 py-2 rounded shadow-lg text-xs ${tipo === 'error' ? 'bg-rose-600 text-white' : tipo === 'ok' ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-white'}`;
            d.style.maxWidth = '560px'; d.textContent = texto;
            c.appendChild(d);
            setTimeout(() => { d.style.transition = 'opacity .4s'; d.style.opacity = '0'; setTimeout(() => d.remove(), 450); }, tipo === 'error' ? 6000 : 3500);
        }
        // botones: [{ texto, valor, clase }] -> Promise con el valor del botón pulsado
        function dialogo(titulo, html, botones) {
            return new Promise(ok => {
                document.getElementById('dialogo-titulo').innerHTML = titulo;
                document.getElementById('dialogo-cuerpo').innerHTML = html;
                const cont = document.getElementById('dialogo-botones'); cont.innerHTML = '';
                botones.forEach(b => {
                    const btn = document.createElement('button');
                    btn.className = 'px-3 py-1.5 rounded font-medium ' + (b.clase || 'bg-slate-100 hover:bg-slate-200 text-slate-700');
                    btn.textContent = b.texto;
                    btn.onclick = () => { document.getElementById('modal-dialogo').style.display = 'none'; ok(b.valor); };
                    if (b.valor == null) btn.dataset.esc = '1'; // el botón que pulsa Escape (Cancelar / Cerrar)
                    cont.appendChild(btn);
                });
                if (botones.length === 1) cont.firstChild.dataset.esc = '1';
                document.getElementById('modal-dialogo').style.display = 'flex';
            });
        }

        function seleccionarElemento(id) {
            seleccion.clear();
            idSeleccionado = id;
            renderizarVectorial();
            const el = elementosRed.find(item => item.id === id);
            if (!el) return;
            expandirCategoriaDe(el);

            document.getElementById("lbl-tipo-activo").innerText = el.type.toUpperCase();
            const panel = document.getElementById("panel-propiedades");
            // cambiarCampoPanel necesita el id: se envuelve en una función con nombre fijo por elemento
            window.__cambiarSel = (campo, valor) => cambiarCampoPanel(el.id, campo, valor);
            panel.innerHTML = `
                <div class="font-bold text-slate-700 mb-1 flex justify-between items-center">
                    <span>${esc(tagDe(el))}</span>
                    <button onclick="eliminarElemento('${el.id}')" class="text-rose-500 hover:text-rose-700 text-[10px]"><i class="fa-solid fa-trash-can mr-1"></i>Eliminar</button>
                </div>
                <div class="space-y-1.5 mt-1">
                    ${ctrlTexto('__cambiarSel', 'name', el.name, 'Descripción')}
                    ${ctrlNum('__cambiarSel', 'scale', el.scale, 'Escala', '0.1')}
                    ${ctrlNum('__cambiarSel', 'rotation', el.rotation || 0, 'Rotación (°)', '90')}
                    ${camposEspecificos(el, '__cambiarSel')}
                </div>`;
        }

        function actualizarAtributo(id, campo, valor) { cambiarCampoPanel(id, campo, valor); }

        function eliminarElemento(id) {
            guardarEstado();
            invalidarResultados();
            elementosRed = elementosRed.filter(item => item.id !== id);
            if (ventanaId === id) cerrarModal();
            purgarLineasVacias();
            if(idSeleccionado === id) {
                idSeleccionado = null;
                document.getElementById("lbl-tipo-activo").innerText = "Ninguno";
                document.getElementById("panel-propiedades").innerHTML = `<p class="text-slate-400 italic text-[10px]">Selecciona un elemento.</p>`;
            }
            renderizarVectorial();
        }

        let nombreArchivoActual = '';
        // ---------- Inicio: siempre se elige Nuevo proyecto o Proyecto existente (sin datos de partida) ----------
        function leerUltimoGuardado() { try { return JSON.parse(localStorage.getItem(CLAVE_ULTIMO) || 'null') || JSON.parse(localStorage.getItem(CLAVE_AUTOGUARDADO) || 'null'); } catch (e) { return null; } }
        function pantallaInicio() {
            const u = leerUltimoGuardado(), pend = u && u.contenido && u.guardado === false;
            dialogo('<i class="fa-solid fa-network-wired text-blue-600 mr-1.5"></i>PIPING P&amp;ID',
                '<p>Para trabajar hace falta un proyecto.</p><p class="text-slate-400">Nuevo proyecto: se introducen sus datos desde cero. Proyecto existente: se recupera un proyecto ya guardado.</p>' +
                (pend ? `<p class="mt-2 text-amber-700"><i class="fa-solid fa-triangle-exclamation mr-1"></i>El proyecto <b>${esc(u.numero || 'sin número')}</b> tiene cambios sin guardar del ${new Date(u.fecha).toLocaleString('es-ES')}.</p>` : ''),
                [...(pend ? [{ texto: 'Recuperar cambios sin guardar', valor: 'recuperar', clase: 'bg-amber-500 hover:bg-amber-600 text-white' }] : []), { texto: 'Nuevo proyecto', valor: 'nuevo', clase: 'bg-blue-600 hover:bg-blue-700 text-white' }, { texto: 'Proyecto existente', valor: 'existente', clase: 'bg-white hover:bg-slate-50 border border-slate-300 text-slate-700' }])
                .then(r => r === 'recuperar' ? abrirUltimoProyecto() : r === 'nuevo' ? nuevoProyecto(true) : proyectoExistente(true));
        }
        function nuevoProyecto(desdeInicio) {
            if (desdeInicio !== true && hayCambiosSinGuardar && !confirm("Hay cambios sin guardar que se perderán. ¿Iniciar un nuevo proyecto igualmente?")) return;
            abrirDatosProyecto(null, { nuevo: true, desdeInicio: desdeInicio === true });
        }
        async function proyectoExistente(desdeInicio) {
            if (desdeInicio !== true && hayCambiosSinGuardar && !confirm("Hay cambios sin guardar que se perderán. ¿Abrir otro proyecto igualmente?")) return;
            const u = leerUltimoGuardado(), ini = desdeInicio === true;
            const botones = [];
            if (u && u.contenido) botones.push({ texto: 'Abrir el último proyecto', valor: 'ultimo', clase: 'bg-blue-600 hover:bg-blue-700 text-white' });
            botones.push({ texto: 'Abrir archivo (*.pid)...', valor: 'archivo', clase: u && u.contenido ? 'bg-white hover:bg-slate-50 border border-slate-300 text-slate-700' : 'bg-blue-600 hover:bg-blue-700 text-white' });
            botones.push({ texto: ini ? 'Volver' : 'Cancelar', valor: null });
            const r = await dialogo('<i class="fa-solid fa-folder-open text-blue-600 mr-1.5"></i>Proyecto existente',
                u && u.contenido ? `<p>Último proyecto de trabajo en este navegador:</p><p class="font-bold text-slate-700">${esc(u.numero || 'sin número')}${u.archivo ? ' · ' + esc(u.archivo) : ''}</p><p class="text-slate-400">${u.n || 0} elementos · ${new Date(u.fecha).toLocaleString('es-ES')}${u.guardado === false ? ' · con cambios sin guardar en archivo' : ''}</p>` : '<p>No hay ningún proyecto de trabajo guardado en este navegador: abre el archivo del proyecto.</p>',
                botones);
            if (r === 'ultimo') { abrirUltimoProyecto(); return; }
            if (r === 'archivo') { abrirProyectoCarpeta(true, () => { if (ini && !proyectoDefinido()) pantallaInicio(); }); return; }
            if (ini) pantallaInicio();
        }

        // Elementos sueltos (sin ninguna conexión) en una red con más elementos: no se puede guardar así
        function elementosSueltos() {
            const comps = elementosRed.filter(e => !esAnotacion(e));
            if (comps.length < 2) return [];
            return comps.filter(e => !vecinosDe(e).length);
        }
        async function comprobarSueltosAntesDeGuardar() {
            const s_ = elementosSueltos();
            if (!s_.length) return true;
            const r = await dialogo('<i class="fa-solid fa-triangle-exclamation text-amber-600 mr-1.5"></i>Hay elementos sueltos en el lienzo',
                `<p>No están conectados a la red:</p><p class="font-bold text-slate-700">${s_.map(e => esc(tagDe(e))).join(', ')}</p><p>Colócalos en su posición de trabajo o elimínalos antes de guardar.</p>`,
                [{ texto: 'Colocarlos (ir al primero)', valor: 'ir', clase: 'bg-blue-600 hover:bg-blue-700 text-white' }, { texto: 'Eliminarlos y guardar', valor: 'borrar', clase: 'bg-rose-600 hover:bg-rose-700 text-white' }, { texto: 'Cancelar', valor: null }]);
            if (r === 'ir') { seleccion.clear(); s_.forEach(e => seleccion.add(e.id)); actualizarSeleccion(); const c = centroElemento(s_[0]); centrarVistaEnPunto(c.x, c.y); return false; }
            if (r === 'borrar') { guardarEstado(); invalidarResultados(); const ids = new Set(s_.map(e => e.id)); elementosRed = elementosRed.filter(e => !ids.has(e.id)); purgarLineasVacias(); limpiarSeleccion(); return true; }
            return false;
        }

        async function guardarProyecto() {
            if (!(await comprobarSueltosAntesDeGuardar())) return;
            if (!currentFileHandle) {
                await guardarComoProyecto('pid');
            } else {
                try {
                    const contenido = generarContenido('pid');
                    const writable = await currentFileHandle.createWritable();
                    await writable.write(contenido);
                    await writable.close();
                    marcarCambios(false);
                    aviso("Proyecto guardado correctamente.", 'ok');
                } catch (err) {
                    console.error(err);
                    await guardarComoProyecto('pid');
                }
            }
        }

        async function handleGuardarComo(selectElement) {
            const formato = selectElement.value;
            selectElement.value = ""; 
            if (!formato) return;
            await guardarComoProyecto(formato);
        }

        async function guardarComoProyecto(formato) {
            if ((formato === 'pid' || formato === 'json') && !(await comprobarSueltosAntesDeGuardar())) return;
            if (formato === 'dxf') await cargarParte('cad');
            const contenido = generarContenido(formato);
            const extensiones = {
                pid: { description: 'Archivo P&ID (*.pid)', accept: { 'application/json': ['.pid'] } },
                dxf: { description: 'LibreCAD DXF (*.dxf)', accept: { 'application/dxf': ['.dxf'] } },
                svg: { description: 'Imagen SVG (*.svg)', accept: { 'image/svg+xml': ['.svg'] } },
                json: { description: 'Datos JSON (*.json)', accept: { 'application/json': ['.json'] } },
                xml: { description: 'Datos XML (*.xml)', accept: { 'application/xml': ['.xml'] } },
                png: { description: 'Imagen PNG (*.png)', accept: { 'image/png': ['.png'] } }
            };

            if (window.showSaveFilePicker) {
                try {
                    const handle = await window.showSaveFilePicker({
                        suggestedName: `${(proyecto.numero || 'proyecto').replace(/[^\w.-]+/g, '_')}.${formato}`,
                        types: [extensiones[formato]]
                    });
                    if (formato === 'pid') {
                        currentFileHandle = handle; nombreArchivoActual = handle.name || '';
                    }
                    const writable = await handle.createWritable();
                    await writable.write(contenido);
                    await writable.close();
                    if (formato === 'pid') marcarCambios(false);
                    aviso("Archivo guardado: " + (handle.name || ''), 'ok');
                } catch (err) {
                    if (err.name !== 'AbortError') {
                        descargarArchivo(contenido, `proyecto_pid.${formato}`, 'text/plain');
                    }
                }
            } else {
                let nombre = prompt("Introduce el nombre del archivo:", `proyecto_pid.${formato}`);
                if (nombre) {
                    descargarArchivo(contenido, nombre, 'text/plain');
                    if (formato === 'pid') marcarCambios(false);
                }
            }
        }

        function datosProyecto() {
            return {
                version: "8.11-tuberias",
                catalogo: CAT ? CAT.version : null,
                proyecto: proyecto,
                lineas: lineas,
                opciones: opciones,
                elementos: elementosRed,
                hojas: hojasParaGuardar(), hojaActual,
                // modelos y tuberías de la librería del usuario que usa el dibujo (para abrirlo en otro equipo)
                libreriaUsada: (typeof LIB !== 'undefined' ? LIB.items : []).filter(i => elementosRed.concat(elementosOtrasHojas()).some(e => e.libItem === i.id || (i.grupo === 'tuberias' && e.material === i.nombre))),
                condicionesContorno: condicionesContorno,
                fluido: document.getElementById('selector-fluido')?.value,
                temperatura: parseFloat(document.getElementById('temp-fluido')?.value)
            };
        }
        function generarContenido(formato) {
            if (formato === 'pid' || formato === 'json') return JSON.stringify(datosProyecto(), null, 2);
            if (formato === 'dxf') return exportarDXF();
            if (formato === 'xml') return exportarXML();
            if (formato === 'svg') return document.getElementById("marco-a3").outerHTML;
            if (formato === 'png') { alert("Para exportar a PNG de alta resolución, utiliza Archivo > Imprimir (A3)."); return ""; }
            return "";
        }

        // ---------- XML: líneas y elementos con su etiqueta y todos sus atributos ----------
        function exportarXML() {
            const x = v => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
            const attrs = o => Object.entries(o).filter(([k, v]) => v !== null && v !== undefined && typeof v !== 'object' && !k.startsWith('_')).map(([k, v]) => `${k}="${x(v)}"`).join(' ');
            let out = `<?xml version="1.0" encoding="UTF-8"?>\n<piping version="8.11-tuberias" catalogo="${x(CAT ? CAT.version : '')}" fluido="${x(document.getElementById('selector-fluido').value)}" temperatura="${x(document.getElementById('temp-fluido').value)}">\n  <lineas>\n`;
            lineas.forEach(l => { out += `    <linea ${attrs(l)}/>\n`; });
            out += '  </lineas>\n  <elementos>\n';
            elementosRed.forEach(el => {
                const extra = { tag: tagDe(el) };
                if (el.type === 'tuberia') { const dt = datosTuberia(el); Object.assign(extra, { od: dt.od, espesor: dt.e, dint: +dt.Dint.toFixed(2), rugosidad: dt.rug }); }
                const r = ultimoResultado && ultimoResultado[el.id];
                out += `    <elemento ${attrs(Object.assign({}, el, extra))}${r ? '>\n      <resultado ' + attrs({ Q_m3h: r.Q && +r.Q.toFixed(3), V_ms: r.V && +r.V.toFixed(3), hf_m: r.hf && +r.hf.toFixed(4), estado: el.estado }) + '/>\n    </elemento>' : '/>'}\n`;
            });
            out += '  </elementos>\n  <condicionesContorno>\n';
            Object.entries(condicionesContorno).forEach(([k, c]) => { out += `    <contorno puerto="${x(k)}" cota="${x(c.elevacion)}" presion="${x(c.presion)}"/>\n`; });
            return out + '  </condicionesContorno>\n</piping>\n';
        }

        // ---------- DXF (R12, AC1009): geometría real de cada símbolo, en mm de papel A3 ----------
        // Se recorre el SVG dibujado y cada primitiva se transforma con su matriz real (getCTM), así el
        // DXF reproduce exactamente lo que se ve (rotación, escala, textos). Y invertida (DXF: Y arriba).
        // DXF R12 es ASCII: los caracteres no ASCII (½, ·, ñ, °...) se escriben como \U+XXXX, que AutoCAD y LibreCAD interpretan
        const textoDXF = t => String(t).replace(/[\r\n]/g, ' ').replace(/[^\x20-\x7e]/g, c => '\\U+' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'));
        // ---------- Capas normalizadas de salida (DXF R2000 / AC1015, con tipo y grosor de línea por capa) ----------
        const CAPAS_DXF = [
            { nombre: '0', color: [255, 255, 255], aci: 7, tipo: 'Continuous', grosor: 0.20, uso: 'Capa por defecto' },
            { nombre: 'Bord', color: [255, 255, 0], aci: 2, tipo: 'Continuous', grosor: 0.70, uso: 'Bordes: marco, zonas de referencia y cajetín' },
            { nombre: 'Dim', color: [255, 0, 255], aci: 6, tipo: 'Continuous', grosor: 0.30, uso: 'Cotas (si se requieren)' },
            { nombre: 'Hid', color: [255, 0, 0], aci: 1, tipo: 'Trazado', grosor: 0.20, uso: 'Líneas ocultas' },
            { nombre: 'Hidden', color: [0, 0, 255], aci: 5, tipo: 'Trazado y punto', grosor: 0.25, uso: 'Ejes' },
            { nombre: 'Marca', color: [255, 255, 255], aci: 7, tipo: 'Continuous', grosor: 0.35, uso: 'Marcas de material (listado de componentes)' },
            { nombre: 'Object', color: [255, 255, 255], aci: 7, tipo: 'Continuous', grosor: 0.35, uso: 'Todos los objetos del esquema (salvo textos)' },
            { nombre: 'Text', color: [0, 255, 0], aci: 3, tipo: 'Continuous', grosor: 0.35, uso: 'Todos los textos y las tablas' },
            { nombre: 'Tratt', color: [0, 0, 255], aci: 5, tipo: 'Continuous', grosor: 0.15, uso: 'Tramados / rayados' }
        ];
        // Plantilla R2000 generada con ezdxf (dxf/gen_plantilla.py): cabecera, tablas (capas y tipos de línea),
        // bloques y objetos; aquí solo se añaden las entidades con identificadores a partir de "seed".
        
        function exportarDXF(...a) { return PARTES_OK.cad ? exportarDXF__p.apply(this, a) : cargarParte('cad').then(() => exportarDXF__p.apply(this, a)); }
        // ==================================================================================
        // CAPAS EDITABLES (CAD > Capas...): color del sistema, tipo y grosor de línea, visible, inutilizada,
        // bloqueada, imprimible y transparencia. Se guardan con el proyecto (opciones.capas) y se pueden
        // dejar como predeterminadas del diseñador (este navegador). No se admiten los colores reservados
        // del cálculo (verde = correcto, rojo = no cumple, violeta = ruta crítica).
        // ==================================================================================
        const ACI_RGB = [[0,0,0],[255,0,0],[255,255,0],[0,255,0],[0,255,255],[0,0,255],[255,0,255],[255,255,255],[128,128,128],[192,192,192],[255,0,0],[255,127,127],[165,0,0],[165,82,82],[127,0,0],[127,63,63],[76,0,0],[76,38,38],[38,0,0],[38,19,19],[255,63,0],[255,159,127],[165,41,0],[165,103,82],[127,31,0],[127,79,63],[76,19,0],[76,47,38],[38,9,0],[38,23,19],[255,127,0],[255,191,127],[165,82,0],[165,124,82],[127,63,0],[127,95,63],[76,38,0],[76,57,38],[38,19,0],[38,28,19],[255,191,0],[255,223,127],[165,124,0],[165,145,82],[127,95,0],[127,111,63],[76,57,0],[76,66,38],[38,28,0],[38,33,19],[255,255,0],[255,255,127],[165,165,0],[165,165,82],[127,127,0],[127,127,63],[76,76,0],[76,76,38],[38,38,0],[38,38,19],[191,255,0],[223,255,127],[124,165,0],[145,165,82],[95,127,0],[111,127,63],[57,76,0],[66,76,38],[28,38,0],[33,38,19],[127,255,0],[191,255,127],[82,165,0],[124,165,82],[63,127,0],[95,127,63],[38,76,0],[57,76,38],[19,38,0],[28,38,19],[63,255,0],[159,255,127],[41,165,0],[103,165,82],[31,127,0],[79,127,63],[19,76,0],[47,76,38],[9,38,0],[23,38,19],[0,255,0],[127,255,127],[0,165,0],[82,165,82],[0,127,0],[63,127,63],[0,76,0],[38,76,38],[0,38,0],[19,38,19],[0,255,63],[127,255,159],[0,165,41],[82,165,103],[0,127,31],[63,127,79],[0,76,19],[38,76,47],[0,38,9],[19,88,23],[0,255,127],[127,255,191],[0,165,82],[82,165,124],[0,127,63],[63,127,95],[0,76,38],[38,76,57],[0,38,19],[19,88,28],[0,255,191],[127,255,223],[0,165,124],[82,165,145],[0,127,95],[63,127,111],[0,76,57],[38,76,66],[0,38,28],[19,88,88],[0,255,255],[127,255,255],[0,165,165],[82,165,165],[0,127,127],[63,127,127],[0,76,76],[38,76,76],[0,38,38],[19,88,88],[0,191,255],[127,223,255],[0,124,165],[82,145,165],[0,95,127],[63,111,127],[0,57,76],[38,66,126],[0,28,38],[19,88,88],[0,127,255],[127,191,255],[0,82,165],[82,124,165],[0,63,127],[63,95,127],[0,38,76],[38,57,126],[0,19,38],[19,28,88],[0,63,255],[127,159,255],[0,41,165],[82,103,165],[0,31,127],[63,79,127],[0,19,76],[38,47,126],[0,9,38],[19,23,88],[0,0,255],[127,127,255],[0,0,165],[82,82,165],[0,0,127],[63,63,127],[0,0,76],[38,38,126],[0,0,38],[19,19,88],[63,0,255],[159,127,255],[41,0,165],[103,82,165],[31,0,127],[79,63,127],[19,0,76],[47,38,126],[9,0,38],[23,19,88],[127,0,255],[191,127,255],[82,0,165],[124,82,165],[63,0,127],[95,63,127],[38,0,76],[57,38,126],[19,0,38],[28,19,88],[191,0,255],[223,127,255],[124,0,165],[145,82,165],[95,0,127],[111,63,127],[57,0,76],[66,38,76],[28,0,38],[88,19,88],[255,0,255],[255,127,255],[165,0,165],[165,82,165],[127,0,127],[127,63,127],[76,0,76],[76,38,76],[38,0,38],[88,19,88],[255,0,191],[255,127,223],[165,0,124],[165,82,145],[127,0,95],[127,63,111],[76,0,57],[76,38,66],[38,0,28],[88,19,88],[255,0,127],[255,127,191],[165,0,82],[165,82,124],[127,0,63],[127,63,95],[76,0,38],[76,38,57],[38,0,19],[88,19,28],[255,0,63],[255,127,159],[165,0,41],[165,82,103],[127,0,31],[127,63,79],[76,0,19],[76,38,47],[38,0,9],[88,19,23],[0,0,0],[101,101,101],[102,102,102],[153,153,153],[204,204,204],[255,255,255]];
        const GROSORES_DXF = [0, 0.05, 0.09, 0.13, 0.15, 0.18, 0.20, 0.25, 0.30, 0.35, 0.40, 0.50, 0.53, 0.60, 0.70, 0.80, 0.90, 1.00, 1.06, 1.20, 1.40, 1.58, 2.00, 2.11];
        // tipos de línea de la plantilla DXF (dxf/gen_plantilla.py): patrón [longitud, trazo, -hueco, 0 = punto…] en mm
        const PATRONES_LINEA = {"Continuous": null, "Cadena": [21, 12, -3, 3, -3], "Continuo": null, "Doble trazado y doble punto": [36, 12, -3, 12, -3, 0, -3, 0, -3], "Doble trazado y triple punto": [39, 12, -3, 12, -3, 0, -3, 0, -3, 0, -3], "Punto": [3, 0, -3], "Trazado": [15.0, 12.0, -3.0], "Trazado doble y cadena": [36, 12, -3, 12, -3, 3, -3], "Trazado doble y punto": [33, 12, -3, 12, -3, 0, -3], "Trazado largo y doble punto": [33, 24, -3, 0, -3, 0, -3], "Trazado largo y punto": [30, 24, -3, 0, -3], "Trazado largo y triple punto": [36, 24, -3, 0, -3, 0, -3, 0, -3], "Trazado y doble punto": [21, 12, -3, 0, -3, 0, -3], "Trazado y espacio": [18, 12, -6], "Trazado y punto": [30.5, 24.0, -3.0, 0.5, -3.0], "Trazado y triple punto": [24, 12, -3, 0, -3, 0, -3, 0, -3]};
        const TIPOS_LINEA = Object.keys(PATRONES_LINEA).sort((a, b) => a.localeCompare(b, 'es'));
        const tipoLineaDXF = t => (t === 'Continua' || !PATRONES_LINEA.hasOwnProperty(t)) ? 'Continuous' : t;
        const dashLinea = t => { const p = PATRONES_LINEA[tipoLineaDXF(t)]; return p ? p.slice(1).map(x => Math.max(0.6, Math.abs(x)) * 0.8).join(',') : ''; };
        const CAPAS_BASE = CAPAS_DXF.map(c => c.nombre);
        const CLAVE_CAPAS = 'piping-capas';
        const capaPorDefecto = c => ({ nombre: c.nombre, color: c.color.slice(), tipo: c.tipo, grosor: c.grosor, uso: c.uso, visible: true, inutilizada: false, bloqueada: false, imprimible: true, transparencia: 0 });
        function capasPredeterminadas() {
            try { const g = JSON.parse(localStorage.getItem(CLAVE_CAPAS) || 'null'); if (Array.isArray(g) && g.length) return g; } catch (e) {}
            return CAPAS_DXF.map(capaPorDefecto);
        }
        function capasActuales() {
            if (!Array.isArray(opciones.capas) || !opciones.capas.length) opciones.capas = JSON.parse(JSON.stringify(capasPredeterminadas()));
            // las capas que usa PIPING siempre existen
            CAPAS_DXF.forEach(c => { if (!opciones.capas.some(x => x.nombre === c.nombre)) opciones.capas.push(capaPorDefecto(c)); });
            opciones.capas.forEach(c => { c.tipo = tipoLineaDXF(c.tipo); });
            return opciones.capas;
        }
        const hexRGB = c => '#' + c.map(v => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, '0')).join('');
        const rgbHex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
        
        // colores del cálculo en el lienzo (claro y oscuro)
        const COLORES_RESERVADOS = [['verde (componente o línea correctos)', '#16a34a'], ['verde (componente o línea correctos)', '#4ade80'], ['rojo (hay que modificar el componente o la línea)', '#dc2626'], ['rojo (hay que modificar el componente o la línea)', '#f87171'], ['violeta (ruta crítica)', '#7c3aed'], ['violeta (ruta crítica)', '#c084fc']];

        // Tabla LAYER del DXF con las capas actuales (se conservan los identificadores de la plantilla)
        
        function abrirLineasCapas(...a) { return PARTES_OK.herr ? abrirLineasCapas__p.apply(this, a) : cargarParte('herr').then(() => abrirLineasCapas__p.apply(this, a)); }

        function capasComoPredeterminadas() { try { localStorage.setItem(CLAVE_CAPAS, JSON.stringify(capasActuales())); aviso('Capas guardadas como predeterminadas para los proyectos nuevos.', 'ok'); } catch (e) { aviso('No se han podido guardar en este navegador.', 'error'); } }

        function descargarArchivo(contenido, nombre, tipo) {
            const blob = new Blob([contenido], { type: tipo });
            const url = URL.createObjectURL(blob);
            const dl = document.createElement('a');
            dl.href = url;
            dl.download = nombre;
            dl.click();
            URL.revokeObjectURL(url);
        }

        async function abrirProyectoCarpeta(sinConfirmar, alCancelar) {
            if (sinConfirmar !== true && hayCambiosSinGuardar && !confirm("Hay cambios sin guardar que se perderán. ¿Abrir otro proyecto igualmente?")) return;
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json,.pid,.dxf';
            input.addEventListener('cancel', () => { if (typeof alCancelar === 'function') alCancelar(); });
            input.onchange = e => {
                const file = e.target.files[0];
                if (!file) { if (typeof alCancelar === 'function') alCancelar(); return; }
                const reader = new FileReader();
                reader.onload = event => {
                    try {
                        const avisos = cargarProyectoDesdeTexto(event.target.result);
                        nombreArchivoActual = file.name; currentFileHandle = null; guardarUltimo();
                        historialUndo = []; historialRedo = []; actualizarBotonesHistorial();
                        ajustarVistaVentana();
                        if (avisos.length) alert("Proyecto abierto.\n\n" + avisos.join("\n")); else aviso('Proyecto abierto: ' + file.name, 'ok');
                        if (!proyectoDefinido()) abrirDatosProyecto(null, { obligatorio: true });
                    } catch(err) { console.error(err); alert("Error al abrir archivo o formato no compatible."); }
                };
                reader.readAsText(file);
            };
            input.click();
        }
        // Carga un proyecto (.pid/.json) desde su texto; devuelve los avisos de migración
        function cargarProyectoDesdeTexto(texto) {
                        if (typeof hacerCopiaSeguridad === 'function') hacerCopiaSeguridad('antes de abrir otro proyecto');
                        planoCongelado = false; // el proyecto que se abre trae su propio estado por hoja
                        guardarEstado(); // permite deshacer la apertura y recuperar el proyecto anterior
                        const res = JSON.parse(texto);
                        if (Array.isArray(res.libreriaUsada) && res.libreriaUsada.length) {
                            const ids = new Set(LIB.items.map(i => i.id)), nuevos = res.libreriaUsada.filter(i => !ids.has(i.id));
                            if (nuevos.length) { LIB.items = LIB.items.concat(nuevos); guardarLib(); aplicarLibreria(); }
                        }
                        elementosRed = res.elementos || [];
                        elementosRed.forEach(normalizarElemento);
                        lineas = res.lineas || [];
                        proyecto = Object.assign(PROYECTO_VACIO(), res.proyecto || {});
                        proyecto.buque = Object.assign(PROYECTO_VACIO().buque, (res.proyecto || {}).buque || {});
                        actualizarTituloProyecto();
                        if (res.opciones) opciones = Object.assign({}, opciones, res.opciones);
                        if (!FORMATOS[opciones.formato]) opciones.formato = 'A3';
                        if (!FONDOS[opciones.fondo]) opciones.fondo = 'papel';
                        aplicarFormato();
                        // versiones anteriores: la Vmax única pasa a ser la de impulsión
                        if (!res.proyecto && res.opciones && +res.opciones.vmax > 0) proyecto.vImp = String(res.opciones.vmax);
                        aplicarFondo(); construirLibreria();
                        // Proyecto sin líneas (versión anterior): todo pasa a una línea principal P01
                        if (!lineas.length && elementosRed.length) {
                            lineas = [{ id: 'P01', tipo: 'principal', nombre: 'Línea principal' }];
                            elementosRed.forEach(e => { if (!e.linea) e.linea = 'P01'; });
                        }
                        elementosRed.forEach(e => { if (!e.num) { e.codigo = null; asignarNumero(e); } });
                        condicionesContorno = res.condicionesContorno || {};
                        cargarHojasDe(res);
                        const avisosApertura = [];
                        if (res.fluido) {
                            const sel = document.getElementById('selector-fluido');
                            let nombre = res.fluido, T = res.temperatura;
                            const m = MIGRA_FLUIDO[res.fluido];
                            if (m) { nombre = m.nombre; if (T == null) T = m.T; if (m.aviso) avisosApertura.push(m.aviso); }
                            if (!CAT.fluidos[nombre]) { avisosApertura.push(`El fluido "${res.fluido}" no está en el catálogo: se usa agua.`); nombre = 'Agua'; }
                            if (sel) sel.value = nombre;
                            document.getElementById('temp-fluido').value = (T != null && isFinite(T)) ? T : 20;
                            actualizarInfoFluido();
                        }
                        // el fluido y la temperatura forman parte de los datos del proyecto
                        if (!(res.proyecto && res.proyecto.fluido && CAT.fluidos[res.proyecto.fluido])) proyecto.fluido = document.getElementById('selector-fluido').value;
                        if (!(res.proyecto && res.proyecto.temperatura !== '' && res.proyecto.temperatura != null)) proyecto.temperatura = document.getElementById('temp-fluido').value;
                        if (res.proyecto && res.proyecto.fluido && !CAT.fluidos[res.proyecto.fluido]) { avisosApertura.push(`El fluido "${res.proyecto.fluido}" no está en el catálogo: se usa agua.`); proyecto.fluido = 'Agua'; }
                        aplicarFluidoProyecto();
                        if (res.version && res.version < '6.7') avisosApertura.push('Proyecto sin nomenclatura de líneas: todos los elementos se han asignado a la línea principal P01 y se han numerado. Revisa los ramales con "Cambiar de línea" (menú del botón derecho).');
                        if (!res.version || res.version < '6.6') avisosApertura.push('Proyecto de una versión anterior: las tuberías, válvulas y accesorios se han adaptado al catálogo nuevo (K automático salvo los K que se habían modificado a mano).');
                        reajustarTodasLasConexiones(false); // corrige huecos por cambios de geometría entre versiones (sin snapshot adicional)
                        marcarCambios(false);
                        return avisosApertura;
        }

        function imprimirPDF() { window.print(); }

        // ==================================================================================
        // MOTOR DE CÁLCULO HIDRÁULICO (Fase 1)
        // Modelo: grafo de nodos/aristas construido por proximidad de puertos tras el snapping.
        // Simplificaciones asumidas (documentadas también en el panel de resultados):
        //  - Cada "Tee" se modela como tres ramas que salen de un nodo central interno: las ramas
        //    a y b (paso directo) llevan K_run/2 cada una y la rama c (derivación) K_der − K_run/2,
        //    de modo que a→b suma 20·fT y a→c 60·fT (Crane) con velocidades iguales.
        //  - La curva de la bomba se aproxima con una parábola H(Q) = H0 - k·Q² ajustada por el
        //    punto de diseño (caudal/presión) y una presión de cierre editable.
        //  - Fluidos incompresibles del catálogo (propiedades interpoladas a la temperatura de servicio).
        //  - K de válvulas y accesorios: Crane TP-410 (n·fT), Cv de catálogo (K = 891·d⁴/Cv²) o manual,
        //    siempre con el diámetro interior de la tubería conectada.
        //  - La red se resuelve por el método de teoría lineal (Wood & Charles): iteración de
        //    resistencias linealizadas hasta convergencia de caudales.
        // ==================================================================================

        function construirGrafoRed() {
            let puertosTodos = [];
            elementosRed.forEach(el => {
                obtenerPuertosConexion(el).forEach(p => {
                    puertosTodos.push({ elId: el.id, portId: p.id, x: p.x, y: p.y, nodo: null });
                });
            });

            const TOL = 4; // px de tolerancia para considerar dos puertos "conectados"
            let padre = puertosTodos.map((_, i) => i);
            function find(i) { while (padre[i] !== i) { padre[i] = padre[padre[i]]; i = padre[i]; } return i; }
            function unir(i, j) { let ri = find(i), rj = find(j); if (ri !== rj) padre[ri] = rj; }

            for (let i = 0; i < puertosTodos.length; i++) {
                for (let j = i + 1; j < puertosTodos.length; j++) {
                    if (puertosTodos[i].elId === puertosTodos[j].elId) continue;
                    let d = Math.hypot(puertosTodos[i].x - puertosTodos[j].x, puertosTodos[i].y - puertosTodos[j].y);
                    if (d < TOL) unir(i, j);
                }
            }

            // continuaciones entre hojas (cálculo del proyecto completo): las parejas con el mismo enlace se unen
            const porEnlace = {}, elPorId = Object.fromEntries(elementosRed.map(e => [e.id, e]));
            puertosTodos.forEach((p, i) => { const e = elPorId[p.elId]; if (e && e.subtype === 'continuacion' && e.enlace) (porEnlace[e.enlace] = porEnlace[e.enlace] || []).push(i); });
            Object.values(porEnlace).forEach(l => l.slice(1).forEach(j => unir(l[0], j)));
            let porElemento = {};
            puertosTodos.forEach((p, idx) => { (porElemento[p.elId] = porElemento[p.elId] || []).push(idx); });

            let mapaNodo = {};
            let nodos = [];
            puertosTodos.forEach((p, idx) => {
                let r = find(idx);
                if (!(r in mapaNodo)) { mapaNodo[r] = nodos.length; nodos.push({ id: nodos.length, puertos: [] }); }
                p.nodo = mapaNodo[r];
                nodos[p.nodo].puertos.push(p);
            });

            // Nodo central interno de cada Tee (sin puertos visibles)
            let centroTee = {};
            elementosRed.filter(el => esNodo(el)).forEach(el => {
                centroTee[el.id] = nodos.length;
                nodos.push({ id: nodos.length, puertos: [], interno: true });
            });

            return { puertosTodos, nodos, porElemento, centroTee };
        }

        function construirAristas(grafo) {
            let aristas = [];
            elementosRed.forEach(el => {
                let puertos = grafo.puertosTodos.filter(p => p.elId === el.id);
                if (sinFlujo(el)) return; // instrumentos, PSV, alivio: sin caudal, no forman parte de la red hidráulica
                if (esNodo(el)) {
                    puertos.forEach(p => aristas.push({ elId: el.id, el, nodoA: p.nodo, nodoB: grafo.centroTee[el.id], rama: p.portId }));
                    return;
                }
                if (esTerminal(el)) return; // depósitos y consumos son condiciones de contorno, no aristas
                if (el.type === 'bomba' && !bombaEnMarcha(el)) return; // bomba parada (reserva o sustituida)
                if (puertos.length < 2) return;
                const pp = id => puertos.find(p => p.portId === id);
                if (dosCircuitos(el)) {
                    if (pp('a') && pp('b')) aristas.push({ elId: el.id, el, nodoA: pp('a').nodo, nodoB: pp('b').nodo });
                    if (pp('c') && pp('d')) aristas.push({ elId: el.id, el, nodoA: pp('c').nodo, nodoB: pp('d').nodo, rama: 'sec' });
                    return;
                }
                aristas.push({ elId: el.id, el, nodoA: puertos[0].nodo, nodoB: puertos[1].nodo });
            });
            return aristas;
        }

        function nombrePuerto(el, portId) {
            if (el.type === 'bomba') return portId === 'succion' ? 'Aspiración' : 'Descarga';
            if (el.type === 'tuberia') return portId === 'a' ? 'extremo A' : 'extremo B';
            return `puerto ${portId}`;
        }

        function colebrookWhite(Re, relRug) {
            // Estimación inicial explícita (Swamee-Jain)
            let f = 0.25 / Math.pow(Math.log10(relRug / 3.7 + 5.74 / Math.pow(Re, 0.9)), 2);
            // Refinamiento por Newton sobre la ecuación implícita de Colebrook-White
            for (let i = 0; i < 6; i++) {
                const ecuacion = (fi) => {
                    let sqrtF = Math.sqrt(fi);
                    return 1 / sqrtF + 2 * Math.log10(relRug / 3.7 + 2.51 / (Re * sqrtF));
                };
                let F = ecuacion(f);
                let df = 1e-6;
                let deriv = (ecuacion(f + df) - F) / df;
                if (Math.abs(deriv) < 1e-12) break;
                let fNuevo = f - F / deriv;
                if (!isFinite(fNuevo) || fNuevo <= 0) break;
                f = fNuevo;
            }
            return f;
        }

        function prepararArista(a) {
            const el = a.el;
            a.esBomba = false; a.esValvulaAcc = false; a.avisos = [];
            if (el.type === 'tuberia') {
                const dt = datosTuberia(el);
                a.dn = etiquetaTuberia(el);
                a.D = dt.Dint / 1000;
                a.L = (el.longitud || 3000) / 1000;
                a.rugosidad = dt.rug / 1000;
                a.A = Math.PI * a.D * a.D / 4;
            } else if (el.type === 'valvula' || el.type === 'accesorio' || el.type === 'equipo') {
                a.dn = el.subtype === 'reduccion' ? `${el.dn}×${dnNum(el.dnMenor)}` : el.dn;
                a.esValvulaAcc = true;
                a.esEquipo = el.type === 'equipo';
            } else if (el.type === 'bomba') {
                a.esBomba = true;
                a.Qd = (el.caudal || 50) / 3600; // m³/s
                a.Hd_bar = el.presion != null ? el.presion : 3.5;
                a.H0_bar = el.h0 != null ? el.h0 : a.Hd_bar * 1.2;
                aplicarModeloBomba(a, el);
            }
        }

        // Diámetro interior de una tubería conectada al nodo (la primera que se encuentre), en mm
        function dintTuberiaEnNodo(nodo, aristas, preferirDN) {
            const tubs = aristas.filter(x => x.el.type === 'tuberia' && (x.nodoA === nodo || x.nodoB === nodo));
            if (!tubs.length) return null;
            const igual = preferirDN ? tubs.find(x => x.el.dn === preferirDN) : null;
            return (igual || tubs[0]).D * 1000;
        }

        // Tras preparar las tuberías, las válvulas y accesorios toman el diámetro interior REAL de la
        // tubería conectada (si no hay ninguna, el Dint de referencia Sch 40 de su DN) y con él su K.
        function asignarDiametrosYK(aristas, fluido) {
            aristas.forEach(a => {
                if (!a.esValvulaAcc) return;
                const el = a.el;
                if (a.esEquipo) {
                    // Δp = Δp nom·(Q/Qnom)²  ->  K referido a la tubería conectada: K = 2g·hf_nom/V_nom²
                    const Dmm = dintTuberiaEnNodo(a.nodoA, aristas) || dintTuberiaEnNodo(a.nodoB, aristas) || dintReferencia(el.dn || 'DN 50');
                    a.D = Dmm / 1000; a.A = Math.PI * a.D * a.D / 4;
                    const sec = a.rama === 'sec', dpN = sec ? +el.dpNom2 : +el.dpNom, qN = sec ? +el.qNom2 : +el.qNom;
                    const hfN = (dpN || 0) * 1000 / (fluido.rho * G), Vn = (qN || 1) / 3600 / a.A;
                    a.K = 2 * G * hfN / (Vn * Vn);
                    a.origenK = `${sec ? 'secundario: ' : ''}Δp ${dpN} kPa a ${qN} m³/h (fabricante)`;
                    return;
                }
                if (el.subtype === 'reduccion') {
                    const D1 = dintTuberiaEnNodo(a.nodoA, aristas) || dintReferencia(el.dn);
                    const D2 = dintTuberiaEnNodo(a.nodoB, aristas) || dintReferencia(el.dnMenor);
                    const r = kReduccion(el, Math.max(D1, D2), Math.min(D1, D2));
                    a.D = Math.min(D1, D2) / 1000; a.Kc = r.kc; a.Ke = r.ke; a.K = r.kc;
                    a.origenK = `Crane θ ${fmt(r.theta, 1)}° β ${fmt(r.beta, 2)}`;
                } else if (esNodo(el)) {
                    const Dmm = dintTuberiaEnNodo(a.nodoA, aristas, el.dn) || dintReferencia(el.dn);
                    const kt = kTee(el);
                    a.D = Dmm / 1000;
                    a.K = (a.rama === 'c' || a.rama === 'd') ? Math.max(kt.der - kt.run / 2, 0) : kt.run / 2;
                    a.origenK = `${kt.origen} · rama ${a.rama}`;
                } else {
                    const Dmm = dintTuberiaEnNodo(a.nodoA, aristas, el.dn) || dintTuberiaEnNodo(a.nodoB, aristas, el.dn) || dintReferencia(el.dn);
                    const kk = kElemento(el, Dmm);
                    a.D = Dmm / 1000; a.K = kk.K; a.origenK = kk.origen;
                    if (kk.aviso) a.avisos.push(kk.aviso);
                }
                a.A = Math.PI * a.D * a.D / 4;
            });
        }

        // Tipos de bomba. Las volumétricas (todas menos la centrífuga) dan un caudal fijo, independiente de la presión de descarga.
        const TIPOS_BOMBA = [['centrifuga', 'Centrífuga'], ['peristaltica', 'Peristáltica'], ['piston', 'Alternativa / pistón'], ['dosificadora', 'Dosificadora'], ['membrana', 'Membrana'], ['engranajes', 'Engranajes'], ['tornillo', 'Tornillo / husillo'], ['lobulos', 'Lóbulos']];
        const nombreTipoBomba = el => (TIPOS_BOMBA.find(t => t[0] === ((el && el.bombaTipo) || 'centrifuga')) || TIPOS_BOMBA[0])[1];
        const esVolumetrica = el => !!el && el.type === 'bomba' && !!el.bombaTipo && el.bombaTipo !== 'centrifuga';
        // caudal de una volumétrica (m³/h): volumen por ciclo (cm³) × ciclos por minuto; si faltan, el caudal de diseño
        function caudalVolumetrica(el) { const c = +el.volCilindrada, n = +el.volCiclos; return c > 0 && n > 0 ? c * n * 60 / 1e6 : (+el.caudal || 0); }
        // interpolación lineal por tramos en una columna de la curva del fabricante: filas [Q m³/h, H bar, η (0-1), NPSHr m]
        function interpolarCurva(curva, col, Q) {
            const P = (curva || []).filter(p => p[col] != null && isFinite(+p[col])).map(p => [+p[0], +p[col]]).sort((a, b) => a[0] - b[0]);
            if (!P.length) return null; if (P.length === 1 || Q <= P[0][0]) return P[0][1]; if (Q >= P[P.length - 1][0]) return P[P.length - 1][1];
            let i = 0; while (i < P.length - 2 && Q > P[i + 1][0]) i++;
            return P[i][1] + (P[i + 1][1] - P[i][1]) * (Q - P[i][0]) / Math.max(P[i + 1][0] - P[i][0], 1e-12);
        }
        function aplicarModeloBomba(a, el) {
            a.vol = esVolumetrica(el); a.pts = null;
            if (a.vol) { a.Qvol = caudalVolumetrica(el) / 3600; if (a.Qvol > 0) a.Qd = a.Qvol; if (+el.volPmax > 0) a.H0_bar = +el.volPmax; }
            else if (el.curvaModo === 'puntos' && Array.isArray(el.curva) && el.curva.length >= 2) a.pts = el.curva.map(p => [p[0] / 3600, +p[1]]).sort((x, y) => x[0] - y[0]);
        }
        function actualizarResistencia(a, fluido) {
            if (a.esBomba && a.pts) {
                // curva del fabricante por puntos: entre cada dos puntos, H = H₀ − k·Q² (exacta en los puntos)
                const P = a.pts, Qp = Math.max(Math.abs(a.Qprev), 1e-6), m = bar => bar * 1e5 / (fluido.rho * G);
                let i = 0; while (i < P.length - 2 && Qp > P[i + 1][0]) i++;
                const H1 = m(P[i][1]), H2 = m(P[i + 1][1]), d = P[i + 1][0] ** 2 - P[i][0] ** 2;
                const kMin = 0.02 * Math.max(H1, 1e-3) / Math.max(P[i + 1][0] ** 2, 1e-9);   // tramo plano o ascendente: pendiente mínima para que el cálculo converja
                a.kPump = Math.max(d > 0 ? (H1 - H2) / d : 0, kMin, 1e-6);
                a.H0m = H1 + a.kPump * P[i][0] ** 2; a.Hd_m = m(a.Hd_bar);
                a.H0cierre = m(P[0][1]) + (P[0][0] > 0 && P.length > 1 ? Math.max(0, (m(P[0][1]) - m(P[1][1])) / Math.max(P[1][0] ** 2 - P[0][0] ** 2, 1e-12)) * P[0][0] ** 2 : 0);
                return;
            }
            if (a.esBomba) {
                let Hd_m = a.Hd_bar * 1e5 / (fluido.rho * G);
                let H0_m = a.H0_bar * 1e5 / (fluido.rho * G);
                let k = (H0_m - Hd_m) / Math.max(a.Qd * a.Qd, 1e-9);
                a.kPump = Math.max(k, 1e-6);
                a.H0m = H0_m; a.Hd_m = Hd_m;
                return;
            }
            let Q = Math.max(Math.abs(a.Qprev), 1e-6);
            let V = Q / a.A;
            let Re = V * a.D * fluido.rho / fluido.mu;
            let f;
            if (Re < 2300) { f = Re > 1 ? 64 / Re : 64; }
            else { f = colebrookWhite(Re, (a.rugosidad || 0) / a.D); }
            a.Re = Re; a.f = f; a.V = V;
            // Reducción: contracción si el caudal va del extremo mayor (a) al menor (b), expansión si no
            if (a.el.subtype === 'reduccion') { a.K = a.Qprev >= 0 ? a.Kc : a.Ke; a.sentidoRed = a.Qprev >= 0 ? 'contracción' : 'expansión'; }
            a.R = a.esValvulaAcc ? (a.K / (2 * G * a.A * a.A)) : (f * a.L / (a.D * a.A * a.A * 2 * G));
            // K = 0 (bridas, manguitos, paso directo del injerto): resistencia mínima para que el
            // sistema lineal no divida por cero; es despreciable frente a la de cualquier tubería.
            a.R = Math.max(a.R, 1e-3);
        }

        function resolverSistemaLineal(A, b) {
            const n = b.length;
            if (n === 0) return [];
            let M = A.map((fila, i) => [...fila, b[i]]);
            for (let col = 0; col < n; col++) {
                let maxFila = col;
                for (let f = col + 1; f < n; f++) if (Math.abs(M[f][col]) > Math.abs(M[maxFila][col])) maxFila = f;
                [M[col], M[maxFila]] = [M[maxFila], M[col]];
                if (Math.abs(M[col][col]) < 1e-12) continue;
                for (let f = 0; f < n; f++) {
                    if (f === col) continue;
                    let factor = M[f][col] / M[col][col];
                    for (let c = col; c <= n; c++) M[f][c] -= factor * M[col][c];
                }
            }
            return M.map((fila, i) => Math.abs(fila[i]) < 1e-12 ? 0 : fila[n] / fila[i]);
        }

        function resolverRed(grafo, aristas, condiciones, fluido, demandas = {}) {
            let fixedH = {};
            Object.keys(condiciones).forEach(nid => {
                let c = condiciones[nid];
                let pAbs = PRESION_ATM + (c.presion || 0) * 1e5;
                fixedH[nid] = (c.elevacion || 0) + pAbs / (fluido.rho * G);
            });

            let libres = [], idxLibre = {};
            grafo.nodos.forEach(n => { if (!(n.id in fixedH)) { idxLibre[n.id] = libres.length; libres.push(n.id); } });

            aristas.forEach(a => {
                prepararArista(a);
                a.Qprev = a.el.type === 'bomba' ? Math.max((a.vol && a.Qvol > 0 ? a.Qvol : (a.el.caudal || 10) / 3600), 1e-4) : 1e-3;
            });
            asignarDiametrosYK(aristas, fluido);

            const QMIN = 1e-6;
            let Hnodo = {};
            for (let iter = 0; iter < 60; iter++) {
                aristas.forEach(a => actualizarResistencia(a, fluido));

                let A = Array.from({ length: libres.length }, () => new Array(libres.length).fill(0));
                let b = new Array(libres.length).fill(0);
                // Consumos: caudal saliente impuesto en el nodo (m³/s)
                Object.entries(demandas).forEach(([nid, q]) => { if (nid in idxLibre) b[idxLibre[nid]] -= q; });

                aristas.forEach(a => {
                    let Qp = Math.max(Math.abs(a.Qprev), QMIN);
                    let g, Isrc = 0;
                    if (a.esBomba && a.vol) { g = 1e-9; Isrc = a.Qvol || 0; }   // volumétrica: caudal impuesto, la altura es un resultado
                    else if (a.esBomba) { g = 1 / (a.kPump * Qp); Isrc = g * a.H0m; }
                    else { g = 1 / (a.R * Qp); }

                    let i = a.nodoA, j = a.nodoB;
                    let iFijo = (i in fixedH), jFijo = (j in fixedH);
                    let li = idxLibre[i], lj = idxLibre[j];

                    if (!iFijo) A[li][li] += g;
                    if (!jFijo) A[lj][lj] += g;
                    if (!iFijo && !jFijo) { A[li][lj] -= g; A[lj][li] -= g; }
                    if (!iFijo && jFijo) b[li] += g * fixedH[j];
                    if (!jFijo && iFijo) b[lj] += g * fixedH[i];
                    if (Isrc !== 0) {
                        if (!jFijo) b[lj] += Isrc;
                        if (!iFijo) b[li] -= Isrc;
                    }
                });

                let Hlibres = resolverSistemaLineal(A, b);
                Hnodo = {};
                grafo.nodos.forEach(n => { Hnodo[n.id] = (n.id in fixedH) ? fixedH[n.id] : Hlibres[idxLibre[n.id]]; });

                let maxCambioRel = 0;
                aristas.forEach(a => {
                    let Hi = Hnodo[a.nodoA], Hj = Hnodo[a.nodoB];
                    let Qp = Math.max(Math.abs(a.Qprev), QMIN);
                    let Qnuevo = a.esBomba && a.vol ? 1e-9 * (Hi - Hj) + (a.Qvol || 0) : a.esBomba
                        ? (1 / (a.kPump * Qp)) * (Hi - Hj) + (1 / (a.kPump * Qp)) * a.H0m
                        : (1 / (a.R * Qp)) * (Hi - Hj);
                    let rel = Math.abs(Qnuevo - a.Qprev) / Math.max(Math.abs(a.Qprev), 1e-6);
                    maxCambioRel = Math.max(maxCambioRel, rel);
                    a.Qprev = 0.5 * a.Qprev + 0.5 * Qnuevo;
                });
                if (maxCambioRel < 1e-4) break;
            }

            aristas.forEach(a => actualizarResistencia(a, fluido));
            return { aristas, Hnodo, fluido };
        }

        function velocidadEnNodo(nodoId, aristas, excluir) {
            let ar = aristas.find(a => a !== excluir && !a.esBomba && (a.nodoA === nodoId || a.nodoB === nodoId));
            return ar ? (ar.V || 0) : 0;
        }

        function calcularNPSH(a, Hnodo, fluido) {
            if (fluido.pv == null) return null;
            let Hsuccion = Hnodo[a.nodoA];
            let cota = a.el.cota || 0;
            let npshd = (Hsuccion - cota) - fluido.pv / (fluido.rho * G);
            npshd += Math.pow(velocidadEnNodo(a.nodoA, a._todas, a), 2) / (2 * G);
            return npshd;
        }

        function calcularRed() {
            const grafo = construirGrafoRed();
            const aristas = construirAristas(grafo);

            if (aristas.length === 0) {
                alert("No hay elementos conectados entre sí. Conecta al menos dos componentes (tuberías, válvulas, bomba...) para poder calcular la red.");
                return;
            }

            const seguir = () => mostrarModalContorno(grafo, aristas, nodosContornoDe(grafo, aristas));
            // red sin bomba ni depósito: P01 parte con la presión de diseño del proyecto; si falta, se pide ahora
            if (!(+proyecto.presionDiseno > 0) && origenSinBomba(grafo, aristas, terminalesRed(grafo))) {
                dialogo('<i class="fa-solid fa-gauge-high text-blue-600 mr-1.5"></i>Presión de diseño',
                    `<p>La red no tiene bomba ni depósito: la línea P01 parte con la presión y el caudal de diseño del proyecto (${fQ(+proyecto.caudalDiseno || 0, 2)} ${lQ()}).</p><p class="mt-2">Falta la presión de diseño:</p><label class="block mt-1">Presión de diseño (bar)<input id="pd-valor" type="number" step="any" min="0" class="w-full border rounded p-1.5 mt-0.5" placeholder="p. ej. 4"></label><p class="text-[10px] text-slate-400 mt-2">Se guarda en Archivo > Datos del proyecto.</p>`,
                    [{ texto: 'Calcular', valor: 'si', clase: 'bg-blue-600 hover:bg-blue-700 text-white' }, { texto: 'Cancelar', valor: null }]).then(r => {
                        if (r !== 'si') return;
                        const v = parseFloat(String((document.getElementById('pd-valor') || {}).value || '').replace(',', '.'));
                        if (!(v > 0)) { aviso('Indica una presión de diseño mayor que cero.', 'error'); return; }
                        proyecto.presionDiseno = String(v); actualizarPanelDiseno(); marcarCambios(true); seguir();
                    });
                return;
            }
            seguir();
        }

        // Extremos abiertos de la red (necesitan cota y presión): nodos con una sola arista, salvo los
        // que acaban en un elemento sin caudal (instrumento, PSV, alivio), que son extremos cerrados.
        function nodosContornoDe(grafo, aristas) {
            let grado = new Array(grafo.nodos.length).fill(0);
            aristas.forEach(a => { grado[a.nodoA]++; grado[a.nodoB]++; });
            const elPorId = id => elementosRed.find(e => e.id === id);
            return grafo.nodos.filter(n => grado[n.id] === 1 && !n.puertos.some(p => { const e = elPorId(p.elId); return e && (sinFlujo(e) || esTerminal(e) || (e.type === 'bomba' && !bombaEnMarcha(e))); }))
                .map(n => Object.assign(n, { puertoContorno: n.puertos.find(p => { const e = elPorId(p.elId); return e && !sinFlujo(e); }) || n.puertos[0] }));
        }

        // Cota (m) de cada nodo a partir de los puertos que lo forman; avisa si no coinciden
        function cotasNodos(grafo) {
            const z = {}, incoherencias = [];
            grafo.nodos.forEach(n => {
                const vals = n.puertos.map(p => { const e = elementosRed.find(x => x.id === p.elId); return e && !sinFlujo(e) ? { z: cotaPuerto(e, p.portId), e } : null; }).filter(Boolean);
                if (!vals.length) { z[n.id] = 0; return; }
                const zs = vals.map(v => v.z), max = Math.max(...zs), min = Math.min(...zs);
                z[n.id] = zs.reduce((s, x) => s + x, 0) / zs.length;
                if (max - min > 0.01) incoherencias.push(`Cotas distintas en la unión de ${[...new Set(vals.map(v => tagDe(v.e)))].join(', ')} (${min.toFixed(2)} / ${max.toFixed(2)} m): se toma la media.`);
            });
            Object.entries(grafo.centroTee).forEach(([id, nid]) => { const e = elementosRed.find(x => x.id === id); z[nid] = e ? +e.cota || 0 : 0; });
            return { z, incoherencias };
        }
        // Depósitos (altura fija) y consumos (caudal impuesto) conectados a la red
        function terminalesRed(grafo) {
            const fijos = {}, demandas = {}, porNodo = {}, puertoTerm = {};
            grafo.nodos.forEach(n => n.puertos.forEach(p => {
                const e = elementosRed.find(x => x.id === p.elId);
                if (!e || !esTerminal(e)) return;
                if (n.puertos.length < 2) return; // terminal suelto, sin conectar
                porNodo[n.id] = e; puertoTerm[n.id] = p.portId;
                // entrada superior por encima de la lámina: descarga libre a la cota de la entrada
                if (esDeposito(e)) fijos[n.id] = { elevacion: p.portId === 'c' ? Math.max(+e.cotaEntrada || 0, +e.cotaLamina || 0) : (+e.cotaLamina || 0), presion: +e.presionDep || 0, deposito: e, puerto: p.portId };
                else demandas[n.id] = (demandas[n.id] || 0) + (+e.qCons || 0) / 3600;
            }));
            return { fijos, demandas, porNodo, puertoTerm, elementos: [...new Set(Object.values(porNodo))] };
        }
        // Red sin bomba ni depósitos: la línea P01 parte con la presión y el caudal de diseño del proyecto.
        // Devuelve el extremo de origen (el extremo abierto del primer elemento de la primera línea principal) y las demás salidas, o null.
        function origenSinBomba(grafo, aristas, term) {
            if (aristas.some(a => a.el.type === 'bomba' && bombaEnMarcha(a.el))) return null;
            if (term && Object.keys(term.fijos).length) return null;   // un depósito ya fija la presión de partida
            const nodos = nodosContornoDe(grafo, aristas); if (!nodos.length) return null;
            const lp = (lineas.find(l => l.tipo === 'principal') || {}).id;
            const el = n => elementosRed.find(e => e.id === n.puertoContorno.elId) || {};
            const peso = n => { const e = el(n); return (e.linea === lp ? 0 : 1e6) + (n.puertoContorno.portId === 'a' ? 0 : 1e3) + (e.num || 999); };
            const origen = nodos.slice().sort((x, y) => peso(x) - peso(y))[0];
            return { origen, clave: `${origen.puertoContorno.elId}:${origen.puertoContorno.portId}`, salidas: nodos.filter(n => n !== origen) };
        }
        function mostrarModalContorno(grafo, aristas, nodosContorno) {
            const sb = origenSinBomba(grafo, aristas, terminalesRed(grafo)), sinConsumos = sb && !elementosRed.some(e => e.subtype === 'consumo' && +e.qCons > 0);
            const zN = cotasNodos(grafo).z;
            let filas = nodosContorno.map(n => {
                let p = n.puertoContorno;
                let el = elementosRed.find(e => e.id === p.elId);
                if (!el) return '';
                let key = `${p.elId}:${p.portId}`;
                let cond = condicionesContorno[key] || { elevacion: 0, presion: 0 };
                if (sb && sb.clave === key && !(+cond.presion > 0)) cond = { elevacion: cond.elevacion || 0, presion: +proyecto.presionDiseno || 0 };
                const esOrigen = sb && sb.clave === key, esSalidaQ = sinConsumos && !esOrigen;
                return `
                <tr data-key="${key}">
                    <td class="pr-2 py-1">${esc(tagDe(el))} (${nombrePuerto(el, p.portId)})${esOrigen ? ' <b class="text-blue-700">· origen: presión de diseño</b>' : esSalidaQ ? ' <span class="text-slate-400">· salida: la presión es un resultado</span>' : ''}</td>
                    <td class="pr-2 text-slate-600" title="Se edita en la cota del elemento">${fmt(zN[n.id] * 1000, 0)}</td>
                    <td><input type="number" step="any" class="w-20 border rounded p-1 presion-input" value="${+aP(cond.presion || 0).toFixed(4)}"></td>
                </tr>`;
            }).join('');

            document.getElementById('red-content').innerHTML = `
                <p class="text-xs text-slate-500 mb-3">Indica la presión manométrica en cada extremo abierto de la red (0 = descarga/aspiración atmosférica). La cota es la del elemento en ese extremo. Los depósitos y los puntos de consumo usan sus propios datos.</p>
                ${sb ? `<p class="text-xs text-blue-800 bg-blue-50 border border-blue-200 rounded p-2 mb-3"><i class="fa-solid fa-circle-info mr-1"></i>Red sin bomba: la línea parte de <b>${esc(tagDe(elementosRed.find(e => e.id === sb.origen.puertoContorno.elId) || {}))}</b> con la presión de diseño (${fP(+proyecto.presionDiseno || 0, 2)} ${lP()}) y el caudal de diseño (${fQ(+proyecto.caudalDiseno, 2)} ${lQ()}) del proyecto.${sinConsumos ? ' Como no hay puntos de consumo, ese caudal sale por ' + (sb.salidas.length > 1 ? 'las demás salidas, a partes iguales' : 'la otra salida') + ', y su presión es un resultado del cálculo.' : ' El reparto del caudal lo fijan los puntos de consumo.'}</p>` : ''}
                ${filas ? `<table class="w-full text-xs mb-2">
                    <thead><tr class="text-left text-slate-500"><th class="pb-1">Extremo</th><th class="pb-1">Cota (mm)</th><th class="pb-1">Presión man. (${lP()})</th></tr></thead>
                    <tbody>${filas}</tbody>
                </table>` : `<p class="text-slate-400 italic text-[11px]">No se han detectado extremos abiertos (red cerrada).</p>`}
                <div class="mt-2 grid grid-cols-3 gap-2">
                    <div class="col-span-2"><label class="block text-slate-500 mb-1 text-xs">Fluido</label>
                        <select id="selector-fluido-modal" class="w-full bg-slate-50 border border-slate-300 rounded p-1.5 text-xs">
                            ${Object.keys(CAT.fluidos).map(f => `<option ${f === document.getElementById('selector-fluido').value ? 'selected' : ''}>${f}</option>`).join('')}
                        </select></div>
                    <div><label class="block text-slate-500 mb-1 text-xs">Temperatura (°C)</label>
                        <input type="number" step="1" id="temp-fluido-modal" value="${document.getElementById('temp-fluido').value}" class="w-full bg-slate-50 border border-slate-300 rounded p-1.5 text-xs"></div>
                </div>
                <div id="info-fluido-modal" class="text-[11px] mt-1"></div>
            `;
            const refrescarInfoModal = () => {
                const p = propiedadesFluido(document.getElementById('selector-fluido-modal').value, parseFloat(document.getElementById('temp-fluido-modal').value));
                document.getElementById('info-fluido-modal').innerHTML = p.ok
                    ? `<span class="text-slate-500">ρ ${p.rho.toFixed(1)} kg/m³ · ν ${(p.nu * 1e6).toPrecision(3)} mm²/s · pv ${(p.pv / 1000).toPrecision(3)} kPa${p.nota ? ' · ' + p.nota : ''}</span>`
                    : `<span class="text-rose-600">${p.msg}</span>`;
            };
            document.getElementById('selector-fluido-modal').onchange = refrescarInfoModal;
            document.getElementById('temp-fluido-modal').oninput = refrescarInfoModal;
            refrescarInfoModal();
            document.getElementById('red-footer').innerHTML = `
                <button onclick="cerrarModalRed()" class="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded font-medium">Cancelar</button>
                <button id="btn-ejecutar-calculo" class="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded font-medium">Calcular</button>
            `;
            document.getElementById('btn-ejecutar-calculo').onclick = function () {
                document.querySelectorAll('#red-content tr[data-key]').forEach(tr => {
                    let key = tr.dataset.key;
                    let elevacion = 0;
                    let presion = deP(parseFloat(tr.querySelector('.presion-input').value) || 0);
                    condicionesContorno[key] = { elevacion, presion };
                });
                marcarCambios(true);
                document.getElementById('selector-fluido').value = document.getElementById('selector-fluido-modal').value;
                document.getElementById('temp-fluido').value = document.getElementById('temp-fluido-modal').value;
                actualizarInfoFluido();
                ejecutarCalculo(grafo, aristas);
            };
            document.getElementById('modal-red').style.display = 'flex';
        }

        // Cálculo silencioso del escenario "reserva en marcha"; deja la red en el escenario normal recalculada
        function escenarioReserva() {
            if (!elementosRed.some(e => e.type === 'bomba' && e.reservaDe)) return null;
            const previo = escenarioBombas, tenia = !!ultimoCalculo;
            escenarioBombas = 'reserva';
            let out = null;
            try {
                const g = construirGrafoRed(), a = construirAristas(g), r = calcularResultado(g, a);
                if (r.error) out = { error: r.error, fallos: [r.error] };
                else {
                    const res = r.resultado;
                    out = { fallos: elementosRed.filter(e => e.estado === 'fallo').map(e => `${tagDe(e)}: ${(ultimoResultado[e.id] || { motivos: [] }).motivos.join('; ')}`),
                        bombas: res.aristas.filter(x => x.esBomba).map(x => { const rr = ultimoResultado[x.el.id]; return { tag: tagDe(x.el), sustituye: x.el.reservaDe ? tagDe(elementosRed.find(e => e.id === x.el.reservaDe)) : '', Q: rr.Q, H: rr.H, npshd: rr.npshd, npshr: x.el.npsh, estado: x.el.estado }; }),
                        lc: res.lineaCritica ? res.lineaCritica.hfTotal : null, avisos: res.avisosRed || [] };
                }
            } finally {
                escenarioBombas = previo;
                const g = construirGrafoRed(), a = construirAristas(g), r = a.length ? calcularResultado(g, a) : { error: 'x' };
                if (!r.error && tenia) ultimoCalculo = { resultado: r.resultado, condiciones: r.condiciones, huella: huellaRed() };
                else if (!tenia) invalidarSinProgramar();
            }
            return out;
        }
        // Huella de todo lo que influye en el cálculo: si cambia, el informe exige recalcular
        function huellaRed() {
            const els = elementosRed.map(e => { const c = Object.assign({}, e); delete c.estado; delete c.esLineaCritica; return c; });
            return JSON.stringify([els, lineas, condicionesContorno, document.getElementById('selector-fluido').value, document.getElementById('temp-fluido').value,
                proyecto.caudalDiseno, proyecto.vAsp, proyecto.vImp, proyecto.tipoInstalacion, proyecto.tCierre, proyecto.tsMax, proyecto.grupoPED, proyecto.criterioPrueba, proyecto.salvaguardas, proyecto.esBuque, proyecto.tAmbiente, proyecto.tMontaje, proyecto.exterior, proyecto.horasAnuales, proyecto.precioEnergia, proyecto.etaMotor, opciones.margenNPSH, escenarioBombas]);
        }
        function cerrarModalRed() { document.getElementById('modal-red').style.display = 'none'; if (document.querySelector('#red-content .hoja-impresa')) document.getElementById('red-content').innerHTML = ''; document.querySelector('#modal-red > div').style.width = ''; const t = document.querySelector('#modal-red h3 span'); if (t) t.innerHTML = '<i class="fa-solid fa-diagram-project text-blue-600 mr-1.5"></i> Cálculo Hidráulico de la Red'; }

        function hfDeArista(a) {
            if (a.esBomba) return 0;
            return a.esValvulaAcc ? (a.K * a.V * a.V / (2 * G)) : (a.f * a.L / a.D * a.V * a.V / (2 * G));
        }

        // Línea crítica = el camino, desde la descarga de cada bomba hasta un extremo abierto de
        // la red, con mayor pérdida de carga acumulada (fricción + accesorios, a los caudales ya
        // convergidos). Es el camino que determina la altura mínima que debe dar la bomba para
        // garantizar presión suficiente en TODOS los extremos; el resto de ramas, al tener menos
        // resistencia, quedan con margen de sobra (se equilibrarían con válvulas de balanceo si
        // hiciera falta). Se calcula por búsqueda en profundidad (caminos simples) desde el nodo de
        // descarga de cada bomba hasta cada nodo de grado 1 (extremo abierto) que no sea la propia
        // aspiración de esa bomba.
        function identificarLineaCritica(grafo, aristas, hreq = {}) {
            elementosRed.forEach(el => { el.esLineaCritica = false; });

            let grado = new Array(grafo.nodos.length).fill(0);
            aristas.forEach(a => { grado[a.nodoA]++; grado[a.nodoB]++; });

            // Grafo de adyacencia SIN las bombas: el camino siempre arranca en el nodo de descarga
            // de una bomba, así que no tiene sentido atravesarla en sentido inverso.
            let adyacencia = {};
            aristas.forEach(a => {
                if (a.esBomba) return;
                let hf = hfDeArista(a);
                (adyacencia[a.nodoA] = adyacencia[a.nodoA] || []).push({ vecino: a.nodoB, arista: a, hf });
                (adyacencia[a.nodoB] = adyacencia[a.nodoB] || []).push({ vecino: a.nodoA, arista: a, hf });
            });

            let mejor = null; // { hfTotal, aristasCamino }
            function dfs(nodoActual, nodoSuccionBomba, visitados, caminoAristas, hfAcumulado) {
                let esExtremo = grado[nodoActual] === 1 && nodoActual !== nodoSuccionBomba;
                const puntuacion = hfAcumulado + (hreq[nodoActual] || 0);
                if (esExtremo && caminoAristas.length > 0 && (!mejor || puntuacion > mejor.puntuacion)) {
                    mejor = { hfTotal: hfAcumulado, puntuacion, nodoFin: nodoActual, aristasCamino: [...caminoAristas] };
                }
                for (let conexion of (adyacencia[nodoActual] || [])) {
                    if (visitados.has(conexion.vecino)) continue;
                    visitados.add(conexion.vecino);
                    caminoAristas.push(conexion.arista);
                    dfs(conexion.vecino, nodoSuccionBomba, visitados, caminoAristas, hfAcumulado + conexion.hf);
                    caminoAristas.pop();
                    visitados.delete(conexion.vecino);
                }
            }

            aristas.filter(a => a.esBomba).forEach(bomba => {
                let visitados = new Set([bomba.nodoB]);
                dfs(bomba.nodoB, bomba.nodoA, visitados, [], 0);
            });
            // Red sin bombas (gravedad o depósito presurizado): la ruta arranca en cada depósito de alimentación
            if (!aristas.some(a => a.esBomba)) {
                let t = null; try { t = terminalesRed(grafo); } catch (e) { t = null; }
                Object.entries((t && t.porNodo) || {}).filter(([, e]) => esDeposito(e)).forEach(([n]) => { const k = Number(n); dfs(k, k, new Set([k]), [], 0); });
            }

            if (mejor) mejor.aristasCamino.forEach(a => { a.el.esLineaCritica = true; });
            return mejor;
        }

        // Comprobación de cada elemento con los criterios (Opciones > Criterios de cálculo):
        //  - tuberías, válvulas y accesorios: V ≤ Vmax
        //  - retenciones: V ≥ velocidad mínima de apertura total (Crane)
        //  - bombas: NPSHd − NPSHr ≥ margen
        // El resultado queda en el.estado ('ok' | 'fallo') y en ultimoResultado[id] para el tooltip.
        function evaluarCriterios(resultado) {
            const { aristas, Hnodo, fluido } = resultado;
            ultimoResultado = {};
            elementosRed.forEach(e => { e.estado = null; });
            // Lado de aspiración: lo alcanzable desde la succión de cada bomba sin atravesar bombas
            const lim = limitesVelocidad();
            resultado.limites = lim;
            const ady = {};
            aristas.forEach(a => { a.lado = 'imp'; if (a.esBomba) return; (ady[a.nodoA] = ady[a.nodoA] || []).push([a.nodoB, a]); (ady[a.nodoB] = ady[a.nodoB] || []).push([a.nodoA, a]); });
            aristas.filter(a => a.esBomba).forEach(b => {
                const vistos = new Set([b.nodoA]), cola = [b.nodoA], marc = [];
                let bucle = false;
                while (cola.length) {
                    const n = cola.shift();
                    if (n === b.nodoB) { bucle = true; break; }
                    (ady[n] || []).forEach(([v, a]) => { marc.push(a); if (!vistos.has(v)) { vistos.add(v); cola.push(v); } });
                }
                if (!bucle) marc.forEach(a => { a.lado = 'asp'; });
            });
            aristas.forEach(a => {
                const el = a.el;
                const r = ultimoResultado[el.id] = ultimoResultado[el.id] || { Q: 0, V: 0, hf: 0, motivos: [], ramas: [] };
                const motivos = [];
                if (a.esBomba) {
                    const npshd = calcularNPSH(a, Hnodo, fluido);
                    const Hop = Hnodo[a.nodoB] - Hnodo[a.nodoA];
                    Object.assign(r, { Q: Math.abs(a.Qprev) * 3600, H: Hop, npshd, potencia: fluido.rho * G * a.Qprev * Hop / 1000 });
                    // rendimiento y NPSHr del punto de funcionamiento, si la curva del fabricante los trae
                    const etaC = interpolarCurva(el.curva, 2, r.Q), npshC = interpolarCurva(el.curva, 3, r.Q);
                    r.npshr = npshC != null ? npshC : el.npsh; r.etaOp = etaC != null && etaC > 0 ? etaC : null; r.tipoBomba = el.bombaTipo || 'centrifuga';
                    if (a.vol) {
                        r.dp = Hop * fluido.rho * G / 1e5;
                        if (+el.volPmax > 0 && r.dp > +el.volPmax) motivos.push(`Presión de descarga necesaria ${r.dp.toFixed(2)} bar > presión máxima de trabajo ${(+el.volPmax).toFixed(2)} bar (bomba volumétrica: hace falta válvula de alivio)`);
                        if (!(+el.volPmax > 0)) resultado.avisosRed.push(`${tagDe(el)}: bomba ${nombreTipoBomba(el).toLowerCase()} sin presión máxima de trabajo. Una volumétrica contra una válvula cerrada sigue subiendo la presión: indica el límite y protege la línea con una válvula de alivio.`);
                        if (+el.volCilindros > 0 && +el.volCiclos > 0) r.pulsosHz = +el.volCilindros * +el.volCiclos / 60;
                    }
                    { const etaB = r.etaOp || (+el.eta > 0 ? +el.eta : 0.70), etaM = +proyecto.etaMotor > 0 ? +proyecto.etaMotor : 0.90, horas = +proyecto.horasAnuales > 0 ? +proyecto.horasAnuales : 4000, precio = +proyecto.precioEnergia > 0 ? +proyecto.precioEnergia : 0.15;
                      const Pe = Math.max(r.potencia, 0) / etaB / etaM; r.energia = { etaB, etaM, horas, precio, Pe, kWh: Pe * horas, eur: Pe * horas * precio }; }
                    if (npshd != null && npshd - r.npshr < opciones.margenNPSH) motivos.push(`NPSHd ${npshd.toFixed(2)} m < NPSHr + margen (${(r.npshr + opciones.margenNPSH).toFixed(2)} m)`);
                } else {
                    const hf = hfDeArista(a);
                    if (a.rama) r.ramas.push({ rama: a.rama, Q: Math.abs(a.Qprev) * 3600, V: a.V, K: a.K, hf });
                    else Object.assign(r, { Q: Math.abs(a.Qprev) * 3600, V: a.V, Re: a.Re, f: el.type === 'tuberia' ? a.f : null, K: a.K, hf, D: a.D * 1000, origenK: a.origenK, sentido: a.sentidoRed });
                    const vlim = a.lado === 'asp' ? lim.asp : lim.imp;
                    r.lado = a.lado; r.vlim = vlim;
                    if (a.rama) r.ramas[r.ramas.length - 1].vlim = vlim;
                    if (a.esEquipo) { r.dp = a.K * a.V * a.V / (2 * G) * fluido.rho * G / 1000; r.vlim = null; }
                    else if (a.V > vlim) motivos.push(`V ${a.V.toFixed(2)} m/s > Vmax ${a.lado === 'asp' ? 'aspiración' : 'impulsión'} ${vlim} m/s${a.rama ? ' (rama ' + a.rama + ')' : ''}`);
                    if (el.type === 'valvula' && el.subtype === 'retencion') {
                        const tipo = el.modoK === 'crane' ? el.craneTipo : 'Clapeta oscilante (swing)';
                        const C = CAT.vmin[tipo];
                        if (C && a.V > 1e-3) { const vmin = C * Math.sqrt(1 / fluido.rho); if (a.V < vmin) motivos.push(`V ${a.V.toFixed(2)} m/s < mínima de apertura total ${vmin.toFixed(2)} m/s`); }
                    }
                }
                r.motivos.push(...motivos);
                el.estado = (el.estado === 'fallo' || motivos.length) ? 'fallo' : 'ok';
            });
            comprobacionesPresion(resultado);
            // Caudal de diseño: la suma de los caudales de las bombas debe alcanzarlo
            const Qd = +proyecto.caudalDiseno;
            const bombas = aristas.filter(a => a.esBomba);
            resultado.Qdiseno = Qd > 0 ? Qd : null;
            if (Qd > 0 && bombas.length) {
                const Qb = bombas.reduce((s, a) => s + Math.abs(a.Qprev) * 3600, 0);
                resultado.Qbombas = Qb; resultado.origenQ = 'bombas';
                if (Qb < Qd * 0.999) bombas.forEach(a => {
                    ultimoResultado[a.el.id].motivos.push(`Q de funcionamiento ${Qb.toFixed(2)} m³/h < caudal de diseño ${Qd} m³/h`);
                    a.el.estado = 'fallo';
                });
            } else if (Qd > 0) {
                // Red sin bombas (por gravedad o desde un depósito presurizado / hidróforo): el caudal de
                // funcionamiento es el que aportan a la red los depósitos y extremos de alimentación
                const fuentes = elementosRed.filter(e => esTerminal(e) && e.subtype !== 'consumo' && ultimoResultado[e.id] && /aporta/.test(ultimoResultado[e.id].sentido || ''));
                let Qf = fuentes.reduce((s, e) => s + (ultimoResultado[e.id].Q || 0), 0);
                if (!fuentes.length) Qf = elementosRed.filter(e => e.subtype === 'consumo' && ultimoResultado[e.id]).reduce((s, e) => s + (ultimoResultado[e.id].Q || 0), 0);
                resultado.Qbombas = Qf; resultado.origenQ = fuentes.length ? 'fuentes' : 'consumos'; resultado.fuentesQ = fuentes.map(e => tagDe(e));
                if (Qf < Qd * 0.999) fuentes.forEach(e => { ultimoResultado[e.id].motivos.push(`Q aportado por la alimentación ${Qf.toFixed(2)} m³/h < caudal de diseño ${Qd} m³/h`); e.estado = 'fallo'; });
                const impuesto = resultado.sinBomba && resultado.sinBomba.salidas.length;   // el caudal de diseño ya está impuesto en las salidas
                if (impuesto) { resultado.Qbombas = Qd; resultado.origenQ = 'proyecto'; }
                if (Qf < Qd * 0.999 && !fuentes.length && !impuesto) resultado.avisosRed.push(`Red sin bombas ni depósitos de alimentación: la suma de consumos (${Qf.toFixed(2)} m³/h) no alcanza el caudal de diseño (${Qd} m³/h).${+proyecto.presionDiseno > 0 ? '' : ' Indica la presión de diseño en Archivo > Datos del proyecto para que la línea P01 parta con esa presión y el caudal de diseño.'}`);
            }
            proponerAlternativas(resultado);
        }
        // ---------- Alternativas para los elementos que no cumplen ----------
        function proponerAlternativas(resultado) {
            const { aristas, fluido } = resultado, lim = resultado.limites;
            const A = D => Math.PI * D * D / 4;
            elementosRed.filter(e => e.estado === 'fallo').forEach(el => {
                const r = ultimoResultado[el.id]; if (!r) return;
                const alt = r.alternativas = [], acc = r.acciones = [];
                // alternativa que se puede aplicar con un clic desde el panel de avisos
                const altA = (texto, corto, cambios) => { alt.push(texto); acc.push({ texto, corto, cambios }); };
                const ars = aristas.filter(a => a.el.id === el.id);
                const a = ars.find(x => !x.rama) || ars[0];
                const txt = r.motivos.join(' ');
                if (el.type === 'tuberia' && a) {
                    const m = materialDe(el), Q = Math.abs(a.Qprev), vl = a.lado === 'asp' ? lim.asp : lim.imp;
                    if (/Vmax/.test(txt)) {
                        const c = m.tamanos.filter(t => t.e[el.serie] != null).map(t => ({ t, D: (t.od - 2 * t.e[el.serie]) / 1000 })).sort((x, y) => x.D - y.D).find(x => Q / A(x.D) <= vl);
                        if (c) altA(`Tamaño: ${tamanoTubo(el.material, c.t.clave)} ${etiquetaTuberia(Object.assign({}, el, { dn: c.t.clave })).split(' ').slice(1).join(' ')} (Dint ${(c.D * 1000).toFixed(1)} mm) → V ${(Q / A(c.D)).toFixed(2)} m/s`, `Cambiar a ${tamanoTubo(el.material, c.t.clave)}`, [['dn', c.t.clave]]);
                        else alt.push('Ningún tamaño de esta serie cumple: revisa el caudal o usa varias líneas en paralelo.');
                    }
                    if (/PMA/.test(txt)) {
                        const t = m.tamanos.find(x => x.clave === el.dn);
                        const ok = m.series.filter(sr => t && t.e[sr] != null && sr !== el.serie).map(sr => ({ sr, p: pmaTuberia(Object.assign({}, el, { serie: sr, pmaManual: null }), fluido.T).pma })).filter(x => x.p != null && x.p >= r.pmax).sort((x, y) => x.p - y.p)[0];
                        if (ok) altA(`Serie: ${/^[0-9]+S?$/.test(ok.sr) ? 'Sch ' + ok.sr : ok.sr} (PMA ${ok.p.toFixed(1)} bar ≥ ${r.pmax.toFixed(2)} bar)`, `Serie ${/^[0-9]+S?$/.test(ok.sr) ? 'Sch ' + ok.sr : ok.sr}`, [['serie', ok.sr]]);
                        else alt.push('Ninguna serie de este material alcanza la presión: cambia de material (p. ej. acero) o reduce la presión de servicio.');
                    }
                }
                if ((el.type === 'valvula' || el.type === 'accesorio' || el.type === 'equipo') && a) {
                    if (r.fallaPN) {
                        const esPN = /^PN/.test(el.pn);
                        const sig = PN_LISTA.filter(x => esPN ? x.startsWith('PN') : x.endsWith('#')).find(x => (presionAdmisiblePN(x, fluido.T, r.pnInox) || 0) >= r.pmaxComp);
                        if (sig) altA(`Presión nominal: ${sig} (${presionAdmisiblePN(sig, fluido.T, r.pnInox).toFixed(1)} bar ≥ ${r.pmaxComp.toFixed(2)} bar)`, `Cambiar a ${sig}`, [['pn', sig]]);
                        else alt.push('Ninguna presión nominal de la serie alcanza la presión de servicio.');
                    }
                    const Q = Math.abs(a.Qprev), vl = a.lado === 'asp' ? lim.asp : lim.imp;
                    if (/Vmax/.test(txt) && el.subtype === 'reduccion') {
                        const Q2 = Math.abs(a.Qprev), dn = LISTA_DN.filter(d => dnNum(d) > dnNum(el.dnMenor) && dnNum(d) < dnNum(el.dn)).find(d => Q2 / A(dintReferencia(d) / 1000) <= vl);
                        if (dn) altA(`Reducción: ${etiquetaDN(el.dn)} × ${etiquetaDN(dn)} → V ${(Q2 / A(dintReferencia(dn) / 1000)).toFixed(2)} m/s (y tubería de salida del mismo tamaño)`, `Reducción ${etiquetaDN(el.dn)} × ${etiquetaDN(dn)}`, [['dnMenor', dn]]);
                        else alt.push('Suprime la reducción y mantén el tamaño mayor aguas abajo.');
                    }
                    if (/Vmax/.test(txt) && el.subtype !== 'reduccion') {
                        const dn = LISTA_DN.filter(d => dnNum(d) > dnNum(el.dn)).find(d => Q / A(dintReferencia(d) / 1000) <= vl);
                        if (dn) altA(`Tamaño: ${etiquetaDN(dn)} → V ${(Q / A(dintReferencia(dn) / 1000)).toFixed(2)} m/s (con la tubería contigua del mismo tamaño)`, `Cambiar a ${etiquetaDN(dn)}`, [['dn', dn]]);
                    }
                    if (el.subtype === 'retencion' && /apertura total/.test(txt)) {
                        const V = a.V, subt = Object.entries(CAT.vmin).filter(([t, C]) => C * Math.sqrt(1 / fluido.rho) <= V).map(([t, C]) => `${t} (Vmin ${(C * Math.sqrt(1 / fluido.rho)).toFixed(2)} m/s)`);
                        if (subt.length) alt.push(`Subtipo: ${subt.slice(0, 3).join(' · ')}`);
                        const tipo = el.modoK === 'crane' ? el.craneTipo : 'Clapeta oscilante (swing)', vmin = (CAT.vmin[tipo] || 45) * Math.sqrt(1 / fluido.rho);
                        const dn = LISTA_DN.filter(d => dnNum(d) < dnNum(el.dn)).reverse().find(d => { const v = Q / A(dintReferencia(d) / 1000); return v >= vmin && v <= vl; });
                        if (dn) alt.push(`Tamaño: ${etiquetaDN(dn)} con reducciones → V ${(Q / A(dintReferencia(dn) / 1000)).toFixed(2)} m/s ≥ ${vmin.toFixed(2)} m/s`);
                    }
                }
                if (el.type === 'bomba') {
                    if (/NPSHd/.test(txt)) alt.push(`NPSH: sube el nivel de aspiración o baja la bomba ${Math.max(0, (el.npsh + opciones.margenNPSH) - (r.npshd || 0)).toFixed(2)} m, aumenta el DN de aspiración o elige una bomba con NPSHr ≤ ${Math.max(0, (r.npshd || 0) - opciones.margenNPSH).toFixed(2)} m.`);
                    if (/caudal de diseño/.test(txt)) alt.push('Caudal: usa Herramientas > Dimensionar bomba para obtener el punto Q-H necesario.');
                }
                if (el.subtype === 'consumo' && /p mín/.test(txt)) alt.push(`Falta ${((+el.pMin || 0) - r.p).toFixed(2)} bar (${(((+el.pMin || 0) - r.p) * 1e5 / (fluido.rho * G)).toFixed(2)} m c.l.): aumenta la altura de la bomba (Herramientas > Dimensionar bomba) o reduce pérdidas en su ruta.`);
                if (/vaporización/.test(txt)) alt.push('Vaporización: aumenta la presión en ese punto (más altura de aspiración o de bomba) o reduce la cota del tramo.');
            });
        }

        // Módulo de elasticidad del material de la tubería (MPa), para la celeridad de la onda (orientativo)
        const E_MATERIAL = { 'Acero al carbono': 207000, 'Acero al carbono EN': 207000, 'Acero inoxidable': 193000, 'PVC-U': 3000, 'PE100': 1100, 'PE80': 900, 'CPVC': 2900,
            'PP-R': 900, 'PVDF': 1800, 'PP-H': 1300, 'Cobre (Dint ref. Sch 40)': 117000, 'Fundición (Dint ref. Sch 40)': 170000, 'Hormigón (Dint ref. Sch 40)': 30000 };
        // Golpe de ariete en una tubería: celeridad de Korteweg a = √[(Kf/ρ)/(1 + Kf·D/(E·e))];
        // cierre rápido (tc ≤ 2L/a): Joukowsky Δp = ρ·a·V; cierre lento: Michaud Δp = 2·ρ·L·V/tc.
        // L = longitud de tuberías de la línea (distancia a la reflexión, criterio conservador).
        function arieteTuberia(a, fluido, Llinea, tc) {
            const dt = datosTuberia(a.el), Kf = ((CAT.fluidos[fluido.nombre] || {}).Kf || 2200) * 1e6, E = (E_MATERIAL[a.el.material] || 207000) * 1e6;
            const cel = Math.sqrt((Kf / fluido.rho) / (1 + Kf * dt.Dint / (E * dt.e)));
            const Tcrit = 2 * Llinea / cel;
            const rapido = !(tc > Tcrit);
            const dp = rapido ? fluido.rho * cel * a.V : 2 * fluido.rho * Llinea * a.V / tc;
            return { cel, Tcrit, L: Llinea, tc, rapido, dp, Kf, E, Dint: dt.Dint, e: dt.e };
        }
        // Presiones: vaporización, PMA de tuberías, presión a caudal nulo, golpe de ariete, consumos,
        // depósitos y avisos de coherencia (DN, sentido de retenciones y bombas)
        function comprobacionesPresion(resultado) {
            const { aristas, Hnodo, fluido, pMan, pAbs, z, terminales } = resultado;
            const avisos = resultado.avisosRed = resultado.avisosRed || [];
            const fallo = (el, m) => { const r = ultimoResultado[el.id] = ultimoResultado[el.id] || { motivos: [], ramas: [] }; r.motivos.push(m); el.estado = 'fallo'; };
            const bar = pa => pa / 1e5;
            aristas.forEach(a => { a.pA = bar(pMan[a.nodoA]); a.pB = bar(pMan[a.nodoB]); const r = ultimoResultado[a.el.id]; if (r && !a.rama) { r.pA = a.pA; r.pB = a.pB; } });
            // vaporización
            aristas.forEach(a => {
                if (a.esBomba) return;
                const pmin = Math.min(pAbs[a.nodoA], pAbs[a.nodoB]);
                if (pmin < fluido.pv && !(ultimoResultado[a.el.id].motivos || []).some(m => /vaporización/.test(m))) fallo(a.el, `p abs ${(pmin / 1000).toFixed(2)} kPa < pv ${(fluido.pv / 1000).toFixed(2)} kPa (vaporización)`);
            });
            // presión a caudal nulo (bomba contra válvula cerrada), lado de impulsión
            const bombas = aristas.filter(a => a.esBomba);
            const Hcierre = bombas.length ? Math.max(...bombas.map(b => Hnodo[b.nodoA] + (b.H0cierre != null ? b.H0cierre : b.H0m))) : null;
            // golpe de ariete: longitud de tuberías por línea
            const Llinea = {};
            aristas.filter(a => a.el.type === 'tuberia').forEach(a => { Llinea[a.el.linea || '?'] = (Llinea[a.el.linea || '?'] || 0) + a.L; });
            const tc = +proyecto.tCierre > 0 ? +proyecto.tCierre : 0;
            aristas.filter(a => a.el.type === 'tuberia').forEach(a => {
                const el = a.el, tag = tagDe(el), r = ultimoResultado[el.id];
                const pm = pmaTuberia(el, fluido.T), pmax = Math.max(a.pA, a.pB);
                a.pma = pm.pma; a.pmaOrigen = pm.origen; a.pmax = pmax;
                a.pCierre = (Hcierre != null && a.lado === 'imp') ? Math.max(...[a.nodoA, a.nodoB].map(n => bar((Hcierre - z[n]) * fluido.rho * G - PRESION_ATM))) : null;
                a.ariete = arieteTuberia(a, fluido, Llinea[el.linea || '?'], tc);
                Object.assign(r, { pma: pm.pma, pmaOrigen: pm.origen, pmax, pCierre: a.pCierre, ariete: a.ariete });
                if (pm.pma == null) { avisos.push(`${tag}: sin presión máxima admisible (${pm.origen}).`); return; }
                if (pmax > pm.pma) fallo(el, `p ${pmax.toFixed(2)} bar > PMA ${pm.pma.toFixed(1)} bar`);
                if (a.pCierre != null && a.pCierre > pm.pma) avisos.push(`${tag}: a caudal nulo (bomba contra válvula cerrada) p = ${a.pCierre.toFixed(2)} bar > PMA ${pm.pma.toFixed(1)} bar.`);
                const pAriete = pmax + bar(a.ariete.dp);
                if (pAriete > pm.pma) avisos.push(`${tag}: golpe de ariete Δp = ${bar(a.ariete.dp).toFixed(2)} bar (${a.ariete.rapido ? 'Joukowsky' : 'Michaud'}); p + Δp = ${pAriete.toFixed(2)} bar > PMA ${pm.pma.toFixed(1)} bar → prever cierre lento, calderín o antiariete.`);
            });
            // presión nominal de válvulas, accesorios y equipos (inox si la tubería conectada es inoxidable)
            const vistosPN = new Set();
            aristas.filter(a => (a.el.type === 'valvula' || a.el.type === 'accesorio' || a.el.type === 'equipo') && a.el.pn).forEach(a => {
                const el = a.el;
                const pmax = Math.max(a.pA, a.pB);
                const r = ultimoResultado[el.id]; r.pmaxComp = Math.max(r.pmaxComp || -Infinity, pmax);
                if (vistosPN.has(el.id)) return;
                const tubs = aristas.filter(t => t.el.type === 'tuberia' && [t.nodoA, t.nodoB].some(n => n === a.nodoA || n === a.nodoB));
                const inox = tubs.some(t => matBase(t.el.material) === 'Acero inoxidable');
                const adm = presionAdmisiblePN(el.pn, fluido.T, inox);
                r.pnAdm = adm; r.pnInox = inox;
                if (adm != null && r.pmaxComp > adm + 1e-6) { vistosPN.add(el.id); fallo(el, `p ${r.pmaxComp.toFixed(2)} bar > ${el.pn} (${adm.toFixed(1)} bar a ${fluido.T} °C)`); r.fallaPN = true; }
                if (adm != null && Hcierre != null && a.lado === 'imp') {
                    const pc = Math.max(...[a.nodoA, a.nodoB].map(n => bar((Hcierre - z[n]) * fluido.rho * G - PRESION_ATM)));
                    if (pc > adm) avisos.push(`${tagDe(el)}: a caudal nulo p = ${pc.toFixed(2)} bar > ${el.pn} (${adm.toFixed(1)} bar).`);
                }
            });
            // válvulas de control: cavitación (IEC 60534): Δp estrangulado = FL²·(p1 − FF·pv), FF = 0,96 − 0,28·√(pv/pc)
            aristas.filter(a => a.el.type === 'valvula' && a.el.modoK === 'kvs' && Math.abs(a.Qprev) > 1e-7).forEach(a => {
                const el = a.el, r = ultimoResultado[el.id];
                const n1 = a.Qprev >= 0 ? a.nodoA : a.nodoB, n2 = a.Qprev >= 0 ? a.nodoB : a.nodoA;
                const p1 = pAbs[n1], p2 = pAbs[n2], dp = p1 - p2, FL = +el.FL || 0.9, FF = 0.96 - 0.28 * Math.sqrt(Math.min(fluido.pv / 22.06e6, 1));
                const dpMax = FL * FL * (p1 - FF * fluido.pv), sigma = (p1 - fluido.pv) / Math.max(dp, 1);
                const Qh = Math.abs(a.Qprev) * 3600, kvNec = dp > 0 ? Qh * Math.sqrt((fluido.rho / 1000) / (dp / 1e5)) : null;
                r.control = { p1, p2, dp, dpMax, sigma, FL, kv: kvApertura(el), kvNec, kvsRec: kvNec ? kvNec / (el.caracteristica === 'lineal' ? 0.7 : Math.pow(50, 0.7 - 1)) : null };
                if (dp >= dpMax) fallo(el, `cavitación / flujo estrangulado: Δp ${(dp / 1e5).toFixed(2)} bar ≥ ${(dpMax / 1e5).toFixed(2)} bar (FL ${FL})`);
                else if (sigma < 2) avisos.push(`${tagDe(el)}: σ = ${sigma.toFixed(2)} < 2 → riesgo de cavitación incipiente; valorar FL mayor, dos etapas o menor Δp.`);
                const ap = +el.apertura;
                if (ap < 20 || ap > 90) avisos.push(`${tagDe(el)}: apertura ${ap} % fuera del rango de regulación recomendado (20–90 %).`);
            });
            // consumos y depósitos
            Object.entries(terminales.porNodo).forEach(([n, e]) => {
                const qNodo = aristas.reduce((s, a) => s + (a.nodoA == n ? a.Qprev : a.nodoB == n ? -a.Qprev : 0), 0); // caudal que sale del nodo por la red
                const p = bar(pMan[n]);
                if (esDeposito(e)) {
                    // un depósito puede tener dos conexiones (salida b, entrada c): se acumulan
                    const r = ultimoResultado[e.id] = ultimoResultado[e.id] && ultimoResultado[e.id]._tanque ? ultimoResultado[e.id] : { motivos: [], ramas: [], _tanque: true, qNeto: 0, conexiones: [] };
                    const pid = terminales.puertoTerm[n];
                    r.qNeto += qNodo;
                    r.conexiones.push({ puerto: pid, Q: qNodo * 3600, p, z: z[n], H: Hnodo[n] });
                    if (pid === 'b' || r.p == null) Object.assign(r, { p, z: z[n], H: Hnodo[n] });
                    Object.assign(r, { Q: Math.abs(r.qNeto) * 3600, sentido: r.conexiones.length > 1 ? (r.qNeto >= 0 ? 'balance: aporta a la red' : 'balance: recibe de la red') : (qNodo >= 0 ? 'aporta a la red' : 'recibe de la red') });
                    e.estado = 'ok';
                    return;
                }
                const r = ultimoResultado[e.id] = { motivos: [], ramas: [], p, z: z[n], H: Hnodo[n] };
                if (e.subtype === 'consumo') {
                    const exceso = p - (+e.pMin || 0);
                    Object.assign(r, { Q: +e.qCons || 0, pMin: +e.pMin || 0, exceso });
                    if (exceso < -1e-4) { r.motivos.push(`p ${p.toFixed(2)} bar < p mín ${(+e.pMin).toFixed(2)} bar`); e.estado = 'fallo'; }
                    else e.estado = 'ok';
                } else {
                    Object.assign(r, { Q: Math.abs(qNodo) * 3600, sentido: qNodo >= 0 ? 'aporta a la red' : 'recibe de la red' });
                    e.estado = 'ok';
                }
            });
            // Equilibrado: el consumo con menor exceso de presión es el más desfavorable; el resto se
            // equilibra a su mismo exceso (Δp = exceso_i − exceso_mín). El exceso del más desfavorable es
            // el margen de la bomba (se ajusta con variador o válvula de regulación en la impulsión).
            const cons = (terminales.elementos).filter(e => e.subtype === 'consumo' && e.estado === 'ok');
            if (cons.length) {
                const exMin = Math.min(...cons.map(e => ultimoResultado[e.id].exceso));
                const crit = cons.find(e => ultimoResultado[e.id].exceso === exMin);
                resultado.consumoCritico = { el: crit, margen: exMin };
                cons.forEach(e => {
                    const r = ultimoResultado[e.id]; r.critico = e === crit;
                    const dp = r.exceso - exMin;
                    if (!r.critico && dp > 0.01 && r.Q > 0) { const Kv = r.Q * Math.sqrt((fluido.rho / 1000) / dp); r.equilibrado = { dp, Kv, Cv: 1.156 * Kv }; }
                });
                if (exMin > 0.1) avisos.push(`El consumo más desfavorable (${tagDe(crit)}) tiene ${exMin.toFixed(2)} bar por encima de su presión mínima: ${resultado.aristas.some(a => a.esBomba) ? 'margen de la bomba, a ajustar con variador o válvula de regulación' : 'margen de la alimentación, a ajustar con válvula de regulación'}.`);
            }
            // coherencia de DN entre componentes y tuberías conectadas
            const dnCompatible = (dn, tub) => tub.el.dn === dn || (!/^DN/.test(tub.el.dn) && datosTuberia(tub.el).od === DN_A_PLASTICO[dnNum(dn)]);
            aristas.filter(a => (a.el.type === 'valvula' || a.el.type === 'accesorio') && a.el.dn).forEach(a => {
                const el = a.el;
                [[a.nodoA, 'a'], [a.nodoB, 'b']].forEach(([n, puerto]) => {
                    if (esNodo(el) && puerto === 'b') return; // en tes, nodoB es el centro interno
                    const dn = el.subtype === 'reduccion' && puerto === 'b' ? el.dnMenor : el.dn;
                    aristas.filter(t => t.el.type === 'tuberia' && (t.nodoA === n || t.nodoB === n)).forEach(t => {
                        if (!dnCompatible(dn, t)) avisos.push(`${tagDe(el)} (${dn}) conectado a ${tagDe(t.el)} (${t.el.dn}, Dint ${(t.D * 1000).toFixed(1)} mm): diámetros distintos.`);
                    });
                });
            });
            // sentido del flujo
            aristas.forEach(a => {
                if (a.el.subtype === 'retencion' && a.Qprev < -1e-7) { const t = `${tagDe(a.el)}: el caudal circula en sentido contrario a la retención (la válvula cerraría). Gírala o revisa la red.`; avisos.push(t); (resultado.accionesRed = resultado.accionesRed || []).push({ texto: t, id: a.el.id, tag: tagDe(a.el) }); }
                if (a.esBomba && a.Qprev < -1e-7) avisos.push(`${tagDe(a.el)}: la bomba trabaja con caudal inverso. Revisa su orientación.`);
            });
            resultado.avisosRed = [...new Set(avisos)];
        }
        function ejecutarCalculo(grafo, aristas) {
            const r = calcularResultado(grafo, aristas);
            if (r.error) { alert(r.error + (todosLosElementos().some(esContinuacion) ? '\n\nLa hoja tiene continuaciones a otras hojas: usa Cálculo > Calcular proyecto completo.' : '')); return; }
            renderizarVectorial(); // colores: verde cumple, rojo no cumple, violeta ruta crítica
            ultimoCalculo = { resultado: r.resultado, condiciones: r.condiciones, huella: huellaRed() };
            mostrarResultados(r.resultado);
            actualizarPanelAvisos();
            // cálculo correcto: el diseñador decide si genera ya el informe
            const ci = comprobarInforme();
            if (!elementosRed.some(e => e.estado === 'fallo') && (!ci || ci.tipo === 'datos')) setTimeout(async () => {
                const q = await dialogo('<i class="fa-solid fa-circle-check text-emerald-600 mr-1.5"></i>Cálculo correcto',
                    '<p>Todos los componentes y líneas cumplen los criterios de cálculo.</p><p>¿Quieres generar ahora el informe (*.docx)?</p>',
                    [{ texto: 'Sí, generar el informe', valor: 'si', clase: 'bg-blue-600 hover:bg-blue-700 text-white' }, { texto: 'No', valor: null }]);
                if (q === 'si') { cerrarModalRed(); generarInforme(); }
            }, 60);
        }
        // Cálculo completo sin interfaz: { resultado, condiciones } o { error }
        function calcularResultado(grafo, aristas) {
            const { z: zNodo, incoherencias } = cotasNodos(grafo);
            const term = terminalesRed(grafo);
            let condiciones = {};
            nodosContornoDe(grafo, aristas).forEach(n => {
                const p = n.puertoContorno;
                const c = condicionesContorno[`${p.elId}:${p.portId}`] || { presion: 0 };
                condiciones[n.id] = { elevacion: zNodo[n.id], presion: c.presion || 0 };
            });
            Object.entries(term.fijos).forEach(([nid, c]) => { condiciones[nid] = { elevacion: c.elevacion, presion: c.presion, deposito: c.deposito.id }; });
            // red sin bomba: P01 parte con la presión y el caudal de diseño del proyecto
            const sb = origenSinBomba(grafo, aristas, term), Qd0 = +proyecto.caudalDiseno || 0;
            let salidasQ = [];
            if (sb) {
                // en el origen, una presión guardada de 0 equivale a «sin indicar»: se parte de la presión de diseño
                if (!(condicionesContorno[sb.clave] && +condicionesContorno[sb.clave].presion > 0)) condiciones[sb.origen.id].presion = +proyecto.presionDiseno || 0;
                const hayConsumos = Object.values(term.demandas).some(q => q > 0);
                if (!hayConsumos && Qd0 > 0 && sb.salidas.length) {
                    salidasQ = sb.salidas;
                    salidasQ.forEach(n => { delete condiciones[n.id]; term.demandas[n.id] = (term.demandas[n.id] || 0) + Qd0 / 3600 / salidasQ.length; });
                }
            }

            const fluido = fluidoSeleccionado();
            if (!fluido.ok) return { error: fluido.msg + '\nCambia la temperatura o el fluido.' };
            const fluidoNombre = `${fluido.nombre} a ${fluido.T} °C`;
            if (!Object.keys(condiciones).length) return { error: 'La red necesita al menos un punto de presión conocida: un extremo abierto o un depósito.' };

            let resultado;
            try {
                resultado = resolverRed(grafo, aristas, condiciones, fluido, term.demandas);
                resultado.aristas.forEach(a => { a._todas = resultado.aristas; });
            } catch (err) {
                console.error(err);
                return { error: "No se ha podido resolver la red: " + err.message };
            }
            resultado.fluidoNombre = fluidoNombre;
            // Presiones en los nodos: p_abs = (H − z)·ρ·g; manométrica = p_abs − p_atm
            resultado.z = zNodo; resultado.pAbs = {}; resultado.pMan = {};
            Object.keys(resultado.Hnodo).forEach(n => { const pa = (resultado.Hnodo[n] - (zNodo[n] || 0)) * fluido.rho * G; resultado.pAbs[n] = pa; resultado.pMan[n] = pa - PRESION_ATM; });
            resultado.terminales = term; resultado.condiciones = condiciones;
            resultado.avisosRed = incoherencias.slice();
            if (sb) {
                const tg = n => { const e = elementosRed.find(x => x.id === n.puertoContorno.elId); return e ? tagDe(e) : '?'; };
                resultado.sinBomba = { origen: tg(sb.origen), presion: condiciones[sb.origen.id].presion, caudal: Qd0, salidas: salidasQ.map(n => ({ tag: tg(n), Q: Qd0 / salidasQ.length, p: resultado.pMan[n.id] / 1e5 })) };
                resultado.avisosRed.push(`Red sin bomba: parte de ${resultado.sinBomba.origen} con ${fP(resultado.sinBomba.presion, 2)} ${lP()}${salidasQ.length ? ` y ${fQ(Qd0, 2)} ${lQ()}` : ''} (presión y caudal de diseño del proyecto).`);
                if (!(+proyecto.presionDiseno > 0)) resultado.avisosRed.push('Falta la presión de diseño del proyecto (Archivo > Datos del proyecto): las presiones se han calculado partiendo de la presión indicada en el origen. Los caudales, las velocidades y las pérdidas de carga no dependen de ella.');
                resultado.sinBomba.salidas.forEach(x => resultado.avisosRed.push(`Salida ${x.tag}: ${fQ(x.Q, 2)} ${lQ()} a ${fP(x.p, 2)} ${lP()}${x.p < 0 && +proyecto.presionDiseno > 0 ? ' — PRESIÓN INSUFICIENTE: la presión de diseño no vence las pérdidas de carga y el desnivel' : ''}.`));
                if (salidasQ.length > 1) resultado.avisosRed.push(`El caudal de diseño se ha repartido a partes iguales entre las ${salidasQ.length} salidas. Para fijar otro reparto, coloca un punto de consumo en cada salida (panel lateral > Consumos).`);
            }
            evaluarCriterios(resultado);
            try { clasificacionPED(resultado); } catch (e) { console.error(e); }
            try { termicaYSoportes(resultado); } catch (e) { console.error(e); }
            try { puntosAltosBajos(resultado, grafo); } catch (e) { console.error(e); }
            // Altura necesaria en cada extremo: la de contorno (abiertos, depósitos) o la de consumo (z + p mín)
            const hreq = {};
            Object.entries(condiciones).forEach(([n, c]) => { hreq[n] = c.elevacion + (PRESION_ATM + (c.presion || 0) * 1e5) / (fluido.rho * G); });
            Object.entries(term.porNodo).forEach(([n, e]) => { if (e.subtype === 'consumo') hreq[n] = (zNodo[n] || 0) + (PRESION_ATM + (+e.pMin || 0) * 1e5) / (fluido.rho * G); });
            resultado.lineaCritica = identificarLineaCritica(grafo, resultado.aristas, hreq);
            if (resultado.lineaCritica) { const eFin = term.porNodo[resultado.lineaCritica.nodoFin]; if (eFin) { eFin.esLineaCritica = true; resultado.lineaCritica.terminal = eFin; } }
            if (resultado.lineaCritica) {
                const els = [...new Set(resultado.lineaCritica.aristasCamino.map(a => a.el))];
                resultado.lineaCritica.ok = els.every(e => e.estado !== 'fallo');
            }
            return { resultado, condiciones };
        }

        // ==================================================================================
        // CÁLCULO AUTOMÁTICO: tras cada cambio (0,5 s sin cambios) se recalcula la red sin abrir ventanas,
        // con las condiciones de contorno guardadas. Colorea el plano y el árbol y muestra el estado abajo
        // a la derecha. Se desactiva en Cálculo > Cálculo automático.
        // ==================================================================================
        let temporizadorCalc = null, calculandoAuto = false;
        function programarCalculoAuto() {
            if (calculandoAuto) return;
            clearTimeout(temporizadorCalc);
            temporizadorCalc = setTimeout(calculoAutomatico, 500);
        }
        function estadoCalculo(html, color) {
            const d = document.getElementById('estado-calculo'); if (!d) return;
            if (!html) { d.style.display = 'none'; return; }
            d.style.display = 'block'; d.style.color = color || '#334155'; d.innerHTML = html;
        }
        function calculoAutomatico() {
            if (!opciones.calculoAuto) { estadoCalculo(null); return; }
            if (isDraggingSymbol || selVentana || document.getElementById('modal-nuevo').style.display === 'flex') { programarCalculoAuto(); return; }
            const grafo = construirGrafoRed(), aristas = construirAristas(grafo);
            if (!aristas.length) { estadoCalculo(elementosRed.length ? '<i class="fa-solid fa-circle-pause mr-1"></i>Cálculo automático: red incompleta' : null, '#64748b'); return; }
            calculandoAuto = true;
            try {
                const r = calcularResultado(grafo, aristas);
                if (r.error) { invalidarSinProgramar(); estadoCalculo(`<i class="fa-solid fa-circle-exclamation mr-1"></i>${esc(r.error.split('\n')[0])}`, '#b45309'); }
                else {
                    ultimoCalculo = { resultado: r.resultado, condiciones: r.condiciones, huella: huellaRed() };
                    const nf_ = elementosRed.filter(e => e.estado === 'fallo').length, lc = r.resultado.lineaCritica;
                    const pre = escenarioBombas === 'reserva' ? '<b>[Reserva en marcha]</b> ' : '';
                    estadoCalculo(nf_ ? `${pre}<i class="fa-solid fa-circle-xmark mr-1"></i>${nf_} elemento(s) no cumplen · clic: avisos`
                        : `${pre}<i class="fa-solid fa-circle-check mr-1"></i>Red OK${lc ? ` · ruta crítica ${fmt(lc.hfTotal, 2)} m` : ''}${(r.resultado.avisosRed || []).length ? ` · ${r.resultado.avisosRed.length} aviso(s)` : ''}`, nf_ ? '#dc2626' : '#15803d');
                }
            } catch (e) { console.error(e); estadoCalculo('<i class="fa-solid fa-circle-exclamation mr-1"></i>Cálculo automático: error', '#b45309'); }
            calculandoAuto = false;
            renderizarVectorial();
            actualizarPanelAvisos();
            if (idSeleccionado && document.activeElement && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'SELECT') seleccionarElemento(idSeleccionado);
        }
        function invalidarSinProgramar() { ultimoResultado = null; ultimoCalculo = null; elementosRed.forEach(e => { e.estado = null; e.esLineaCritica = false; }); }
        function verResultadosAuto() { if (ultimoCalculo) { mostrarResultados(ultimoCalculo.resultado); document.getElementById('modal-red').style.display = 'flex'; } else calcularRed(); }
        function cambiarEscenario(e) {
            if (e === 'reserva' && !elementosRed.some(x => x.type === 'bomba' && x.reservaDe)) { alert('No hay bombas de reserva. Selecciona una bomba y en Función elige "Reserva de …".'); return; }
            escenarioBombas = e; invalidarResultados(); renderizarVectorial();
            estadoCalculo(null);
        }
        function alternarCalculoAuto() { opciones.calculoAuto = !opciones.calculoAuto; marcarCambios(true); if (opciones.calculoAuto) programarCalculoAuto(); else estadoCalculo(null); }

        // ==================================================================================
        // DIMENSIONADO AUTOMÁTICO (Herramientas > Dimensionar tuberías)
        // Para cada tubería se elige el menor tamaño de su material y serie con V ≤ Vmax del lado
        // (aspiración/impulsión). Se itera recalculando la red (los caudales cambian con los diámetros
        // si hay extremos a presión fija). Los componentes conectados que tenían el DN de la tubería lo
        // siguen; las reducciones se ajustan a los tubos de sus extremos. Se muestra la propuesta y se
        // aplica solo si se acepta (con Deshacer).
        // ==================================================================================
        function dnEquivalente(tub) { // DN de acero equivalente a una tubería (plásticos: por diámetro exterior)
            if (/^DN/.test(tub.dn)) return tub.dn;
            const od = datosTuberia(tub).od, par = Object.entries(DN_A_PLASTICO).find(([, o]) => o === od);
            return par ? 'DN ' + par[0] : null;
        }
        function propagarDN(cambios) { // cambios: [{ el, dnAntes }]
            const avisos = [];
            cambios.forEach(({ el, dnAntes }) => {
                const nuevoEq = dnEquivalente(el), antesEq = dnEquivalente(Object.assign({}, el, { dn: dnAntes }));
                if (!nuevoEq) return;
                // recorrido por los componentes contiguos de la misma línea con el DN anterior
                const vistos = new Set([el.id]), cola = [el];
                while (cola.length) {
                    const x = cola.shift();
                    vecinosDe(x).forEach(v => {
                        const o = v.otro;
                        if (vistos.has(o.id) || o.type === 'tuberia' || o.type === 'bomba' || sinFlujo(o) || o.linea !== el.linea) return;
                        vistos.add(o.id);
                        if (o.subtype === 'reduccion') {
                            if (v.puertoOtro === 'a' && o.dn === antesEq) o.dn = nuevoEq;
                            else if (v.puertoOtro === 'b' && o.dnMenor === antesEq) o.dnMenor = nuevoEq;
                            if (dnNum(o.dnMenor) >= dnNum(o.dn)) avisos.push(`${tagDe(o)}: tras el cambio ${o.dn} × ${o.dnMenor} ya no reduce; sustitúyela o elimínala.`);
                            return; // la reducción corta la propagación
                        }
                        if (o.dn === antesEq || esEquipo(o) || esTerminal(o)) { if (!esEquipo(o) && !esTerminal(o)) o.dn = nuevoEq; cola.push(o); }
                    });
                }
            });
            return avisos;
        }
        function dimensionarTuberias() {
            const antes = instantanea();
            const tubs0 = elementosRed.filter(e => e.type === 'tuberia').map(e => ({ id: e.id, dn: e.dn }));
            if (!tubs0.length) { alert('No hay tuberías en la red.'); return; }
            let iter = 0, cambiosTot = 0, ok = false, error = null, avisos = [];
            for (; iter < 10; iter++) {
                const grafo = construirGrafoRed(), aristas = construirAristas(grafo);
                const r = calcularResultado(grafo, aristas);
                if (r.error) { error = r.error; break; }
                const lim = r.resultado.limites, cambios = [];
                r.resultado.aristas.filter(a => a.el.type === 'tuberia').forEach(a => {
                    const el = a.el, m = materialDe(el), Q = Math.abs(a.Qprev), vl = a.lado === 'asp' ? lim.asp : lim.imp;
                    const cand = m.tamanos.filter(t => t.e[el.serie] != null).map(t => ({ clave: t.clave, D: (t.od - 2 * t.e[el.serie]) / 1000 })).sort((x, y) => x.D - y.D);
                    const elegido = cand.find(t => Q / (Math.PI * t.D * t.D / 4) <= vl) || cand[cand.length - 1];
                    if (elegido && elegido.clave !== el.dn) { cambios.push({ el, dnAntes: el.dn }); el.dn = elegido.clave; normalizarElemento(el); }
                });
                if (!cambios.length) { ok = true; break; }
                cambiosTot += cambios.length;
                avisos = avisos.concat(propagarDN(cambios));
            }
            // propuesta: estado final frente al inicial
            const propuesta = elementosRed.filter(e => e.type === 'tuberia').map(e => ({ tag: tagDe(e), antes: tamanoTubo(e.material, tubs0.find(t => t.id === e.id).dn), despues: tamanoTubo(e.material, e.dn) })).filter(x => x.antes !== x.despues);
            const componentes = elementosRed.filter(e => e.type !== 'tuberia').map(e => { const a = JSON.parse(antes).e.find(x => x.id === e.id); return a && (a.dn !== e.dn || a.dnMenor !== e.dnMenor) ? { tag: tagDe(e), antes: a.dnMenor ? `${a.dn} × ${a.dnMenor}` : a.dn, despues: e.dnMenor ? `${e.dn} × ${e.dnMenor}` : e.dn } : null; }).filter(Boolean);
            const finalEstado = instantanea();
            restaurarEstado(antes);
            if (error) { alert(error); return; }
            const filas = x => x.map(c => `<tr><td class="py-0.5 pr-2">${esc(c.tag)}</td><td class="pr-2">${esc(c.antes)}</td><td class="pr-2">→</td><td class="font-bold">${esc(c.despues)}</td></tr>`).join('');
            document.getElementById('red-content').innerHTML = `
                <p class="text-[11px] text-slate-500 mb-2">Criterio: menor tamaño de la misma serie con V ≤ ${limitesVelocidad().asp} m/s en aspiración y ≤ ${limitesVelocidad().imp} m/s en impulsión (Archivo &gt; Datos del proyecto). ${ok ? `Converge en ${iter + 1} cálculo(s).` : '<span class="text-amber-600">No ha convergido en 10 iteraciones: revisa el resultado.</span>'}</p>
                ${propuesta.length || componentes.length ? `
                <h4 class="text-xs font-bold text-slate-600 mb-1">Tuberías</h4>
                <table class="text-[11px] mb-3">${filas(propuesta) || '<tr><td class="text-slate-400 italic">Sin cambios</td></tr>'}</table>
                <h4 class="text-xs font-bold text-slate-600 mb-1">Componentes que siguen a su tubería</h4>
                <table class="text-[11px] mb-3">${filas(componentes) || '<tr><td class="text-slate-400 italic">Sin cambios</td></tr>'}</table>` : '<p class="text-emerald-700 text-xs font-bold">Todas las tuberías ya tienen el tamaño adecuado.</p>'}
                ${avisos.length ? `<div class="bg-amber-50 border border-amber-200 text-amber-700 rounded p-2 text-[11px]">${[...new Set(avisos)].map(a => `<p>${esc(a)}</p>`).join('')}</div>` : ''}`;
            document.getElementById('red-footer').innerHTML = `
                <button onclick="cerrarModalRed()" class="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded font-medium">Cancelar</button>
                ${propuesta.length || componentes.length ? `<button id="btn-aplicar-dim" class="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded font-medium">Aplicar cambios</button>` : ''}`;
            const b = document.getElementById('btn-aplicar-dim');
            if (b) b.onclick = () => { guardarEstado(); restaurarEstado(finalEstado); marcarCambios(true); cerrarModalRed(); calcularRed(); };
            document.getElementById('modal-red').style.display = 'flex';
        }

        function mostrarResultados(resultado) {
            const { aristas, Hnodo, fluido, fluidoNombre, lineaCritica } = resultado;
            const marca = el => el.estado === 'fallo'
                ? '<span class="text-rose-600 font-bold">No cumple</span>'
                : (el.esLineaCritica ? '<span class="text-violet-600 font-bold">OK · crítica</span>' : '<span class="text-emerald-600 font-bold">OK</span>');

            let bloqueLineaCritica = '';
            if (lineaCritica) {
                // las ramas de una te son aristas distintas del mismo elemento: se nombra una sola vez
                const nombres = lineaCritica.aristasCamino.map(a => tagDe(a.el)).filter((n, i, arr) => i === 0 || n !== arr[i - 1]).join(' → ');
                const ok = lineaCritica.ok;
                bloqueLineaCritica = `
                <div class="${ok ? 'bg-violet-50 border-violet-200 text-violet-700' : 'bg-rose-50 border-rose-200 text-rose-700'} border rounded p-2 mb-3 text-[11px]">
                    <p class="font-bold mb-0.5"><i class="fa-solid ${ok ? 'fa-route' : 'fa-circle-exclamation'} mr-1"></i>Ruta crítica ${ok ? 'OK (violeta en el plano)' : 'con elementos que NO cumplen (rojo en el plano)'}</p>
                    <p>Pérdida de carga total: <strong>${lineaCritica.hfTotal.toFixed(3)} m</strong></p>
                    <p>${esc(nombres)}</p>
                </div>`;
            }

            let avisos = [...(resultado.avisosRed || [])];
            aristas.forEach(a => (a.avisos || []).forEach(t => avisos.push(t)));
            aristas.filter(a => !a.esBomba && a.Re > 2300 && a.Re < 4000).forEach(a =>
                avisos.push(`${tagDe(a.el)}: Re = ${Math.round(a.Re)} en zona de transición; el factor de fricción es incierto.`));
            // Incumplimientos de criterios (ver evaluarCriterios)
            const fallos = elementosRed.filter(e => e.estado === 'fallo').map(e => `${tagDe(e)}: ${ultimoResultado[e.id].motivos.join('; ')}${(ultimoResultado[e.id].alternativas || []).length ? '\n   → Alternativa: ' + ultimoResultado[e.id].alternativas.join('\n   → Alternativa: ') : ''}`);

            let filasTuberia = aristas.filter(a => a.el.type === 'tuberia').map(a => `
                <tr>
                    <td class="py-1 pr-2">${esc(tagDe(a.el))}</td><td class="pr-2">Ø${(a.D * 1000).toFixed(1)}</td>
                    <td class="pr-2">${fQ(Math.abs(a.Qprev) * 3600, 2)}</td><td class="pr-2">${a.V.toFixed(2)}</td>
                    <td class="pr-2">${Math.round(a.Re)}</td><td class="pr-2">${a.f.toFixed(4)}</td>
                    <td class="pr-2">${(a.f * a.L / a.D * a.V * a.V / (2 * G)).toFixed(3)}</td>
                    <td class="pr-2">${fP(a.pmax, 2)}</td><td class="pr-2">${a.pma != null ? fP(a.pma, 1) : '<span class="text-amber-600">—</span>'}</td><td class="pr-2">${a.ariete ? fP(a.ariete.dp / 1e5, 2) : '—'}</td><td>${marca(a.el)}</td>
                </tr>`).join('');

            let filasAcc = aristas.filter(a => a.el.type === 'valvula' || a.el.type === 'accesorio' || a.el.type === 'equipo').map(a => `
                <tr>
                    <td class="py-1 pr-2">${esc(tagDe(a.el))}${a.rama ? ` (rama ${a.rama})` : ''}${a.sentidoRed ? ` (${a.sentidoRed})` : ''}</td>
                    <td class="pr-2">${fQ(Math.abs(a.Qprev) * 3600, 2)}</td><td class="pr-2">${a.V.toFixed(2)}</td>
                    <td class="pr-2">${a.K.toFixed(3)}</td><td class="pr-2">${(a.K * a.V * a.V / (2 * G)).toFixed(3)}</td>
                    <td class="pr-2 text-slate-400">${esc(a.origenK || '')}</td><td>${marca(a.el)}</td>
                </tr>`).join('');

            let filasBomba = aristas.filter(a => a.el.type === 'bomba').map(a => {
                const r = ultimoResultado[a.el.id];
                return `
                <tr>
                    <td class="py-1 pr-2">${esc(tagDe(a.el))}</td><td class="pr-2">${fQ(r.Q, 2)}</td>
                    <td class="pr-2">${r.H.toFixed(2)}</td><td class="pr-2">${r.potencia.toFixed(2)}</td>
                    <td class="pr-2">${(() => { const ok = r.npshd != null && r.npshd - a.el.npsh >= opciones.margenNPSH; return `<span class="px-1 rounded font-bold ${r.npshd == null ? 'bg-slate-100' : ok ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-700'}">${r.npshd != null ? r.npshd.toFixed(2) : 'N/D'}</span>`; })()}</td>
                    <td class="pr-2">${a.el.npsh.toFixed(2)}</td><td class="pr-2">${r.energia ? fmt(r.energia.Pe, 2) : '—'}</td><td class="pr-2">${r.energia ? fmt(r.energia.kWh, 0) : '—'}</td><td class="pr-2">${r.energia ? fmt(r.energia.eur, 0) : '—'}</td><td>${marca(a.el)}</td>
                </tr>`;
            }).join('');

            const term = resultado.terminales || { porNodo: {} };
            const filasTerm = (term.elementos || []).map(e => {
                const r = ultimoResultado[e.id] || {};
                return e.subtype === 'consumo'
                    ? `<tr><td class="py-1 pr-2">${esc(tagDe(e))}</td><td class="pr-2">Consumo</td><td class="pr-2">${fQ(r.Q, 2)}</td><td class="pr-2">${fmt(r.z, 2)}</td><td class="pr-2">${fP(r.p, 2)}</td><td class="pr-2">${fP(r.pMin, 2)}</td>
                       <td class="pr-2">${r.equilibrado ? `Δp ${fP(r.equilibrado.dp, 2)} ${lP()} · Kv ${fmt(r.equilibrado.Kv, 2)} m³/h` : (r.critico ? `más desfavorable · margen ${fP(r.exceso, 2)} ${lP()}` : '—')}</td><td>${marca(e)}</td></tr>`
                    : `<tr><td class="py-1 pr-2">${esc(tagDe(e))}</td><td class="pr-2">Depósito</td><td class="pr-2">${fQ(r.Q, 2)}</td><td class="pr-2">${fmt(r.z, 2)}</td><td class="pr-2">${fP(r.p, 2)}</td><td class="pr-2">—</td><td class="pr-2">${esc(r.sentido || '')} · lámina ${fmt(e.cotaLamina, 2)} m</td><td>${marca(e)}</td></tr>`;
            }).join('');
            document.getElementById('red-content').innerHTML = `
                <p class="text-[11px] text-slate-500 mb-2">Fluido: <b>${esc(fluidoNombre)}</b> · ρ ${fluido.rho.toFixed(1)} kg/m³ · ν ${(fluido.nu * 1e6).toPrecision(3)} mm²/s · pv ${(fluido.pv / 1000).toPrecision(3)} kPa${fluido.nota ? ` · <span class="text-slate-400">${esc(fluido.nota)}</span>` : ''}
                <br>Criterios: V aspiración ≤ ${resultado.limites.asp} m/s · V impulsión ≤ ${resultado.limites.imp} m/s · retenciones totalmente abiertas · margen NPSH ≥ ${opciones.margenNPSH} m${resultado.Qdiseno ? ` · Q bombas ≥ ${fQ(resultado.Qdiseno, 2)} ${lQ()} (diseño)` : ' · <span class="text-amber-600">sin caudal de diseño (Archivo &gt; Datos del proyecto)</span>'}</p>
                ${bloqueLineaCritica}
                ${fallos.length ? `<div class="bg-rose-50 border border-rose-200 text-rose-700 rounded p-2 mb-3 text-[11px] space-y-1">
                    ${fallos.map(a => `<p style="white-space:pre-line"><i class="fa-solid fa-xmark mr-1"></i>${esc(a)}</p>`).join('')}
                </div>` : ''}
                ${avisos.length ? `<div class="bg-amber-50 border border-amber-200 text-amber-700 rounded p-2 mb-3 text-[11px] space-y-1">
                    ${avisos.map(a => `<p><i class="fa-solid fa-triangle-exclamation mr-1"></i>${esc(a)}</p>`).join('')}
                </div>` : ''}
                <h4 class="text-xs font-bold text-slate-600 mb-1">Tuberías</h4>
                <table class="w-full text-[11px] mb-3">
                    <thead><tr class="text-left text-slate-500"><th>Elemento</th><th>Dint (mm)</th><th>Q (${lQ()})</th><th>V (m/s)</th><th>Re</th><th>f</th><th>hf (m)</th><th title="Presión manométrica máxima en sus extremos">p máx (${lP()})</th><th title="Presión máxima admisible">PMA (${lP()})</th><th title="Sobrepresión por golpe de ariete">Δp ariete (${lP()})</th><th>Estado</th></tr></thead>
                    <tbody>${filasTuberia || '<tr><td colspan="11" class="text-slate-400 italic py-1">Sin tuberías</td></tr>'}</tbody>
                </table>
                <h4 class="text-xs font-bold text-slate-600 mb-1">Válvulas y Accesorios</h4>
                <table class="w-full text-[11px] mb-3">
                    <thead><tr class="text-left text-slate-500"><th>Elemento</th><th>Q (${lQ()})</th><th>V (m/s)</th><th>K</th><th>hf (m)</th><th>Origen de K</th><th>Estado</th></tr></thead>
                    <tbody>${filasAcc || '<tr><td colspan="7" class="text-slate-400 italic py-1">Sin válvulas/accesorios</td></tr>'}</tbody>
                </table>
                ${filasTerm ? `<h4 class="text-xs font-bold text-slate-600 mb-1">Consumos y depósitos</h4>
                <table class="w-full text-[11px] mb-3">
                    <thead><tr class="text-left text-slate-500"><th>Elemento</th><th>Tipo</th><th>Q (${lQ()})</th><th>Cota (m)</th><th>p (${lP()})</th><th>p mín (${lP()})</th><th>Válvula de equilibrado / observaciones</th><th>Estado</th></tr></thead>
                    <tbody>${filasTerm}</tbody>
                </table>` : ''}
                ${resultado.termica && resultado.termica.lineas.length ? `<h4 class="text-xs font-bold text-slate-600 mb-1">Aislamiento, dilatación y soportes (por línea)</h4>
                <table class="w-full text-[11px] mb-3"><thead><tr class="text-left text-slate-500"><th>Línea</th><th>L tubería (m)</th><th>Pérdidas (W)</th><th>ΔL total (mm)</th><th>Nº soportes</th><th>Peso lleno (kg)</th></tr></thead>
                <tbody>${resultado.termica.lineas.map(x => `<tr><td class="py-1 pr-2">${esc(x.linea)}</td><td class="pr-2">${fmt(x.L, 2)}</td><td class="pr-2">${fmt(x.Qw, 0)}</td><td class="pr-2">${fmt(x.dL, 1)}</td><td class="pr-2">${x.nSop}</td><td>${fmt(x.peso, 0)}</td></tr>`).join('')}</tbody></table>` : ''}
                ${(resultado.ped || []).length ? `<h4 class="text-xs font-bold text-slate-600 mb-1">Clasificación PED (2014/68/UE) y prueba de presión</h4>
                <table class="w-full text-[11px] mb-3">
                    <thead><tr class="text-left text-slate-500"><th>Línea</th><th>PS (${lP()})</th><th>DN</th><th>PS·DN</th><th>Cuadro</th><th>Categoría</th><th>Pt (${lP()})</th>${resultado.ped[0].naval ? '<th>Clase buque</th>' : ''}</tr></thead>
                    <tbody>${resultado.ped.map(x => `<tr><td class="py-1 pr-2">${esc(x.linea)}</td><td class="pr-2">${fP(x.PS, 2)}</td><td class="pr-2">${x.DN}</td><td class="pr-2">${fmt(x.PSDN, 0)}</td><td class="pr-2 text-slate-500">${esc(x.cuadro)}</td><td class="pr-2 font-bold">${esc(x.cat)}</td><td>${fP(x.Pt, 2)}</td>${x.naval ? `<td class="font-bold">Clase ${x.clase}</td>` : ''}</tr>`).join('')}</tbody>
                </table>
                ${(resultado.pedRecipientes || []).length ? `<h4 class="text-xs font-bold text-slate-600 mb-1">Recipientes (cuadros 1 a 4)</h4><table class="w-full text-[11px] mb-3"><thead><tr class="text-left text-slate-500"><th>Elemento</th><th>V (l)</th><th>PS (${lP()})</th><th>PS·V</th><th>Cuadro</th><th>Categoría</th><th></th></tr></thead><tbody>${resultado.pedRecipientes.map(x => `<tr><td class="py-1 pr-2">${esc(x.tag)}</td><td class="pr-2">${fmt(x.V, 0)}</td><td class="pr-2">${fP(x.PS, 2)}</td><td class="pr-2">${fmt(x.PSV, 0)}</td><td class="pr-2 text-slate-500">${esc(x.cuadro)}</td><td class="pr-2 font-bold">${esc(x.cat)}</td><td><a href="${esc(x.url)}" target="_blank" rel="noopener" class="text-blue-600 hover:underline">Recipientes a presión ↗</a></td></tr>`).join('')}</tbody></table>` : ''}
                <p class="text-[10px] text-slate-400 -mt-2 mb-3">Fluido grupo ${resultado.ped[0].grupo} (${esc(resultado.ped[0].motivoGrupo)}), ${resultado.ped[0].gas ? 'gas/vapor' : 'líquido'} · TS ${resultado.ped[0].TS} °C · ${esc(resultado.ped[0].criterio)}</p>` : ''}
                <h4 class="text-xs font-bold text-slate-600 mb-1">Bombas</h4>
                <table class="w-full text-[11px]">
                    <thead><tr class="text-left text-slate-500"><th>Elemento</th><th>Q (${lQ()})</th><th>H (m)</th><th>Potencia (kW)</th> <th>NPSHd (m)</th><th>NPSHr (m)</th><th>P eléctrica (kW)</th><th>kWh/año</th><th>€/año</th><th>Estado</th></tr></thead>
                    <tbody>${filasBomba || '<tr><td colspan="10" class="text-slate-400 italic py-1">Sin bombas</td></tr>'}</tbody>
                </table>
            `;
            document.getElementById('red-footer').innerHTML = `
                <button onclick="cerrarModalRed()" class="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded font-medium">Cerrar</button>
            `;
        }

        // ==================================================================================
        // LIBRERÍA DE SÍMBOLOS (panel derecho), generada desde TIPOS
        // ==================================================================================
        const TUBERIAS_LIBRERIA = [
            { material: 'Acero al carbono', serie: '40', dn: 'DN 50', texto: 'Acero ASME / EN', acero: true },
            { material: 'PE80', texto: 'PE80' }, { material: 'PE100', serie: 'SDR 11 (PN16)', dn: 'd63', texto: 'PE100' }, { material: 'PVC-U', serie: 'PN10', dn: 'd63', texto: 'PVC-U' },
            { material: 'CPVC', texto: 'CPVC' }, { material: 'PP-R', texto: 'PP-R' }, { material: 'PP-H', texto: 'PP-H' }, { material: 'PVDF', texto: 'PVDF' },
            { material: 'Cobre (Dint ref. Sch 40)', texto: 'Cobre' }, { material: 'Fundición (Dint ref. Sch 40)', texto: 'Fundición' }, { material: 'Hormigón (Dint ref. Sch 40)', texto: 'Hormigón' }
        ];
        // schedule y medida por defecto de una tubería del panel (los que falten se toman del material)
        function tuboPanel(t) {
            const mt = CAT && CAT.materiales[t.material]; if (!mt) return null;
            const serie = t.serie && mt.series.includes(t.serie) ? t.serie : (mt.serieDef || mt.series[0]);
            const tam = mt.tamanos.find(x => x.clave === t.dn && x.e[serie] != null) || mt.tamanos.find(x => x.e[serie] != null && (x.clave === 'DN 50' || x.clave === 'd63')) || mt.tamanos.find(x => x.e[serie] != null);
            return tam ? Object.assign({}, t, { serie, dn: tam.clave }) : null;
        }
        function iconoLibreria(tipo, extra) {
            const P = { base: '#2563eb', relleno: '#ffffff', flecha: '#16a34a' };
            const el = Object.assign({ subtype: tipo, type: (TIPOS[tipo] || {}).type }, extra || {});
            return `<svg viewBox="4 0 42 50" width="26" height="20" style="flex:none"><g>${simboloSVG(el, '#2563eb', P)}</g></svg>`;
        }
        // Librería en acordeón: todas las categorías plegadas al empezar; al desplegar una se pliegan las
        // demás. Dentro de Accesorios, sus tres grupos siguen el mismo criterio. Al seleccionar o insertar
        // un elemento se despliega su categoría (y su grupo).
        let libAbierta = null, libSubAbierta = null;
        // Accesorios del panel lateral, por familias. Con un solo elemento la familia es el propio elemento; con varios, un grupo desplegable.
        const BRIDAS_PANEL = ['bridaunion', 'bridawn', 'bridaplana', 'bridaroscada', 'bridaloca', 'bridaplastica', 'bridaciega'];
        const FAMILIAS_PANEL = [
            { id: 'bridas', titulo: 'Bridas', subtipos: BRIDAS_PANEL },
            { id: 'codos', titulo: 'Codos', subtipos: ['codo45', 'codo60', 'codo90'] },
            { id: 'intercambiadores', titulo: 'Intercambiadores (buques)', cat: 'intercambiadores' },
            { id: 'machones', titulo: 'Machones', subtipos: ['machon'] },
            { id: 'manguitos', titulo: 'Manguitos de unión', subtipos: ['manguito'] },
            { id: 'racord', titulo: 'Racord', subtipos: ['racor'] },
            { id: 'redconc', titulo: 'Reducciones concéntricas', subtipos: ['reduccion'], excentrica: false },
            { id: 'redexc', titulo: 'Reducciones excéntricas', subtipos: ['reduccion'], excentrica: true },
            { id: 'tanques', titulo: 'Tanques y depósitos', cat: 'tanques' },
            { id: 'tes', titulo: 'Tes', subtipos: ['tee'] },
            { id: 'cruces', titulo: 'Cruces', subtipos: ['cruce'] },
            { id: 'tuercas', titulo: 'Tuercas de unión', subtipos: ['tuerca'] }
        ];
        const subtiposFamilia = f => (f.subtipos || Object.keys(TIPOS).filter(k => TIPOS[k].cat === f.cat)).filter(k => TIPOS[k]);
        const SUBTIPOS_COMPENSADORES = ['filtro', 'strainer', 'injerto', 'junta', 'antivibratorio'];
        const SUBGRUPOS_LIB = () => FAMILIAS_PANEL.map(f => [f.id, f.titulo]).sort((a, b) => a[1].localeCompare(b[1], 'es'));
        function construirLibreria() {
            const cont = document.getElementById('libreria');
            if (!cont) return;
            const item = (attrs, texto, icono) => `<div draggable="true" ondragstart="drag(event)" onclick="cogerDelPanel(this)" title="Arrastra para insertar uno · clic para insertar varios seguidos" ${attrs} class="bg-slate-50 hover:bg-blue-50 border border-slate-200 px-1 py-0.5 rounded cursor-grab flex items-center gap-1.5">${icono || ''}<span class="flex-1">${texto}</span><i class="fa-solid fa-plus text-blue-600 text-[9px]"></i></div>`;
            const itemTipo = (st, texto) => { const t = TIPOS[st]; return item(`data-type="${t.type}" data-subtype="${st}" data-name="${t.nombre}"`, `${texto || t.nombre}<span class="text-slate-400"> · ${t.codigo}</span>`, iconoLibreria(st)); };
            const itemRed = (exc, texto) => item(`data-type="accesorio" data-subtype="reduccion" data-excentrica="${exc}" data-name="Reducción ${exc ? 'excéntrica' : 'concéntrica'}"`, `${texto}<span class="text-slate-400"> · ${exc ? 'RE' : 'RC'}</span>`, iconoLibreria('reduccion', exc ? { excentrica: true } : null));
            const porNombre = l => l.filter(st => TIPOS[st]).sort((a, b) => TIPOS[a].nombre.localeCompare(TIPOS[b].nombre, 'es'));
            const itemsDe = cat => {
                let items = '';
                Object.entries(TIPOS).filter(([st, t]) => t.cat === cat && !(cat === 'accesorios' && st === 'continuacion')).sort((a, b) => a[1].nombre.localeCompare(b[1].nombre, 'es')).forEach(([st, t]) => {
                    if (st === 'reduccion') {
                        items += item(`data-type="accesorio" data-subtype="reduccion" data-excentrica="false" data-name="Reducción concéntrica"`, 'Reducción concéntrica<span class="text-slate-400"> · RC</span>', iconoLibreria('reduccion'));
                        items += item(`data-type="accesorio" data-subtype="reduccion" data-excentrica="true" data-name="Reducción excéntrica"`, 'Reducción excéntrica<span class="text-slate-400"> · RE</span>', iconoLibreria('reduccion', { excentrica: true }));
                    } else items += item(`data-type="${t.type}" data-subtype="${st}" data-name="${t.nombre}"`, `${t.nombre}<span class="text-slate-400"> · ${t.codigo}</span>`, iconoLibreria(st));
                });
                return items;
            };
            const chev = abierto => `style="transform:rotate(${abierto ? 0 : -90}deg)"`;
            let h = '';
            CATEGORIAS.slice().sort((a, b) => a[1].localeCompare(b[1], 'es')).forEach(([id, titulo]) => {
                let items = '';
                if (id === 'tuberias') items = TUBERIAS_LIBRERIA.map(tuboPanel).filter(Boolean).sort((a, b) => a.texto.localeCompare(b.texto, 'es')).map(t => item(`data-type="tuberia" data-material="${t.material}" data-serie="${t.serie}" data-dn="${t.dn}" data-longitud="3000" data-name="Tubería"`, `${t.texto}<span class="text-slate-400"> · ${t.acero ? 'TAC / TAI' : CODIGO_MATERIAL[t.material]}</span>`, `<svg viewBox="0 0 42 40" width="26" height="20" style="flex:none"><line x1="2" y1="20" x2="40" y2="20" stroke="#2563eb" stroke-width="2.5"/><polygon points="24,12 30,15 24,18" fill="#16a34a"/></svg>`)).join('');
                else if (id === 'bombas') items = item(`data-type="bomba" data-name="Bomba centrífuga" data-caudal="50" data-presion="3.5" data-npsh="2500"`, 'Bomba centrífuga<span class="text-slate-400"> · BO</span>', `<svg viewBox="0 0 50 50" width="26" height="20" style="flex:none">${simboloBomba('#2563eb', { relleno: '#fff' })}</svg>`);
                else if (id === 'accesorios') {
                    FAMILIAS_PANEL.slice().sort((x, y) => x.titulo.localeCompare(y.titulo, 'es')).forEach(f => {
                        const sts = porNombre(subtiposFamilia(f));
                        if (f.excentrica != null) { items += itemRed(f.excentrica, f.titulo); return; }
                        if (sts.length === 1) { items += itemTipo(sts[0], f.titulo); return; }
                        const sg = f.id, ab = libSubAbierta === sg;
                        items += `<div class="border border-slate-100 rounded"><button type="button" onclick="toggleSubgrupo('${sg}')" class="w-full flex items-center justify-between px-1 py-0.5 hover:bg-slate-50 text-left"><span class="text-[9px] font-bold text-slate-500 uppercase">${f.titulo}</span><i id="chevron-sg-${sg}" class="fa-solid fa-chevron-down text-slate-400 text-[8px] transition-transform duration-150" ${chev(ab)}></i></button>
                            <div id="lista-sg-${sg}" class="grid grid-cols-1 gap-0.5 p-0.5" style="${ab ? '' : 'display:none'}">${sts.map(st => itemTipo(st)).join('')}</div></div>`;
                    });
                } else if (id === 'compensadores') items = porNombre(SUBTIPOS_COMPENSADORES).map(st => itemTipo(st)).join('');
                else if (id === 'anotaciones') items = itemsDe(id) + (TIPOS.continuacion ? itemTipo('continuacion') : '');
                else items = itemsDe(id);
                const ab = libAbierta === id;
                h += `<div class="border border-slate-200 rounded">
                    <button type="button" onclick="toggleCategoria('${id}')" class="w-full flex items-center justify-between px-1.5 py-1 bg-white hover:bg-slate-50 rounded text-left">
                        <span class="text-[10px] font-bold text-blue-600 uppercase">${titulo}</span>
                        <i id="chevron-${id}" class="fa-solid fa-chevron-down text-slate-400 text-[9px] transition-transform duration-150" ${chev(ab)}></i>
                    </button>
                    <div id="lista-${id}" class="grid grid-cols-1 gap-0.5 p-1 border-t border-slate-100 text-[10px]" style="${ab ? '' : 'display:none'}">${items}</div>
                </div>`;
            });
            cont.innerHTML = h;
        }
        function pintarAcordeon() {
            CATEGORIAS.forEach(([id]) => {
                const l = document.getElementById('lista-' + id), c = document.getElementById('chevron-' + id);
                if (l) l.style.display = libAbierta === id ? '' : 'none';
                if (c) c.style.transform = `rotate(${libAbierta === id ? 0 : -90}deg)`;
            });
            SUBGRUPOS_LIB().forEach(([sg]) => {
                const l = document.getElementById('lista-sg-' + sg), c = document.getElementById('chevron-sg-' + sg);
                if (l) l.style.display = libSubAbierta === sg ? '' : 'none';
                if (c) c.style.transform = `rotate(${libSubAbierta === sg ? 0 : -90}deg)`;
            });
        }
        function toggleCategoria(nombre) { libAbierta = libAbierta === nombre ? null : nombre; pintarAcordeon(); }
        function toggleSubgrupo(sg) { libSubAbierta = libSubAbierta === sg ? null : sg; pintarAcordeon(); }
        // Categoría (y grupo de Accesorios) de la librería a la que pertenece un elemento
        function categoriaLibreria(el) {
            if (el.type === 'tuberia') return ['tuberias', null];
            if (el.type === 'bomba') return ['bombas', null];
            const c = (TIPOS[el.subtype] || {}).cat;
            if (el.subtype === 'continuacion') return ['anotaciones', null];
            if (SUBTIPOS_COMPENSADORES.includes(el.subtype)) return ['compensadores', null];
            if (c === 'tanques' || c === 'intercambiadores' || c === 'accesorios' || c === 'uniones') { const f = FAMILIAS_PANEL.find(x => x.excentrica == null && subtiposFamilia(x).includes(el.subtype)); return ['accesorios', f ? f.id : null]; }
            return [c, null];
        }
        function expandirCategoriaDe(el) {
            if (!el) return;
            const [c, sg] = categoriaLibreria(el);
            if (!c) return;
            libAbierta = c; if (sg) libSubAbierta = sg;
            pintarAcordeon();
        }

        // ==================================================================================
        // LIBRERÍA DE COMPONENTES (Librerías > ...)
        // Por cada tipo de componente, una lista de modelos (fabricante, material, PN, URL y datos técnicos)
        // que se pueden crear, copiar, modificar y eliminar. Se guarda en el navegador (piping-libreria) y se
        // puede exportar/importar. Las válvulas de catálogo (catalogo.js) son la base de su lista: al
        // modificarlas se guarda una copia del usuario; al eliminarlas se ocultan. Las tuberías nuevas por
        // material se añaden al catálogo de materiales y aparecen en Tuberías del panel derecho.
        // ==================================================================================
        const MATERIALES = {
            // tuberías de acero al carbono e inoxidable (lista de José; equivalencias en Ayuda > Equivalencias)
            tuboAC: { ASME: ['SA-53 Gr.B', 'SA-106 Gr.B', 'SA-333 Gr.6', 'SA-671', 'SA-672'], EN: ['P235TR1', 'P235TR2', 'P265TR1', 'P265TR2', 'P235GH', 'P265GH', 'P295GH', 'P275NL1', 'P275NL2', 'P355NL1', 'P355NL2'] },
            tuboInox: { ASME: ['SA-312 Gr.Tp304', 'SA-312 Gr.Tp304L', 'SA-312 Gr.Tp316', 'SA-312 Gr.Tp316L', 'SA-312 Gr.Tp321', 'SA-312 Gr.Tp321H', 'SA-312 Gr.Tp347', 'SA-312 Gr.Tp347H', 'SA-358'], EN: ['X5CrNi18-10/1.4301', 'X2CrNi19-11/1.4306', 'X5CrNiMo17-12-2/1.4401', 'X2CrNiMo17-12-2/1.4404', 'X6CrNiTi18-10/1.4541', 'X7CrNiTi18-10/1.4940', 'X6CrNiNb18-10/1.4550', 'X7CrNiNb18-10/1.4912'] },
            plastico: { ASME: [], EN: ['PE100 (EN 12201-2)', 'PE80 (EN 12201-2)', 'PVC-U (EN ISO 1452-2)', 'PVC-C (EN ISO 15877)', 'PP-R (EN ISO 15874)', 'PP-H (EN ISO 15494)', 'PVDF (EN ISO 10931)'] },
            // bridas y forjados (tablas de José 01/10/2026; equivalencias en Ayuda > Equivalencias)
            brida: { ASME: ['SA-105N', 'SA-350 Gr.LF2', 'SA-181 Cl.60', 'SA-181 Cl.70', 'SA-216 Gr.WCB', 'SA-182 Gr.F304', 'SA-182 Gr.F304L', 'SA-182 Gr.F316', 'SA-182 Gr.F316L', 'SA-182 Gr.F321', 'SA-182 Gr.F321H', 'SA-182 Gr.F347', 'SA-182 Gr.F347H', 'SA-351 Gr.CF8', 'SA-351 Gr.CF8M'],
                EN: ['P245GH (EN 10222-2)', 'P250GH (EN 10222-2)', 'P280GH (EN 10222-2)', 'P305GH (EN 10222-2)', 'P275NL1/1.0488 (EN 10222-3)', 'P355NL1/1.0566 (EN 10222-3)', 'P275NL2/1.1104 (EN 1092-1)', 'P355NL2/1.1106 (EN 1092-1)', 'GP240GH/1.0619 (EN 10213)', 'X5CrNi18-10/1.4301 (EN 10222-5)', 'X2CrNi19-11/1.4306 (EN 10222-5)', 'X5CrNiMo17-12-2/1.4401 (EN 10222-5)', 'X2CrNiMo17-12-2/1.4404 (EN 10222-5)', 'X6CrNiTi18-10/1.4541 (EN 10222-5)', 'X6CrNiNb18-10/1.4550 (EN 10222-5)', 'GX5CrNi19-10/1.4308 (EN 10213)', 'GX5CrNiMo19-11-2/1.4408 (EN 10213)', 'S235JR (EN 10025-2)', 'PP / PVC (bridas plásticas)'] },
            // codos, tes, cruces, reducciones y demás accesorios para soldar a tope
            accesorio: { ASME: ['SA-234 Gr.WPB', 'SA-234 Gr.WPC', 'SA-420 Gr.WPL6', 'SA-403 Gr.WP304', 'SA-403 Gr.WP304L', 'SA-403 Gr.WP316', 'SA-403 Gr.WP316L', 'SA-403 Gr.WP321', 'SA-403 Gr.WP321H', 'SA-403 Gr.WP347', 'SA-403 Gr.WP347H'],
                EN: ['P235GH/1.0345 (EN 10253-2)', 'P265GH/1.0425 (EN 10253-2)', 'P355NH/1.0565 (EN 10253-2)', 'P275NL1/1.0488 (EN 10253-2)', 'P355NL1/1.0566 (EN 10253-2)', 'P275NL2/1.1104 (EN 10253-2)', 'P355NL2/1.1106 (EN 10253-2)', 'X5CrNi18-10/1.4301 (EN 10253-3/-4)', 'X2CrNi19-11/1.4306 (EN 10253-3/-4)', 'X5CrNiMo17-12-2/1.4401 (EN 10253-3/-4)', 'X2CrNiMo17-12-2/1.4404 (EN 10253-3/-4)', 'X6CrNiTi18-10/1.4541 (EN 10253-3/-4)', 'X6CrNiNb18-10/1.4550 (EN 10253-3/-4)'] },
            accesorioCarbono: { ASME: ['SA-234 Gr.WPB', 'SA-234 Gr.WPC', 'SA-420 Gr.WPL6', 'SA-105N'], EN: ['S235 (EN 10253-1)', 'P235GH/1.0345 (EN 10253-2)', 'P265GH/1.0425 (EN 10253-2)', 'P355NH/1.0565 (EN 10253-2)', 'P275NL1/1.0488 (EN 10253-2)', 'P355NL1/1.0566 (EN 10253-2)', 'P275NL2/1.1104 (EN 10253-2)', 'P355NL2/1.1106 (EN 10253-2)'] },
            accesorioInox: { ASME: ['SA-403 Gr.WP304', 'SA-403 Gr.WP304L', 'SA-403 Gr.WP316', 'SA-403 Gr.WP316L', 'SA-403 Gr.WP321', 'SA-403 Gr.WP321H', 'SA-403 Gr.WP347', 'SA-403 Gr.WP347H', 'SA-182 Gr.F304L', 'SA-182 Gr.F316L'], EN: ['X5CrNi18-10/1.4301 (EN 10253-3/-4)', 'X2CrNi19-11/1.4306 (EN 10253-3/-4)', 'X5CrNiMo17-12-2/1.4401 (EN 10253-3/-4)', 'X2CrNiMo17-12-2/1.4404 (EN 10253-3/-4)', 'X6CrNiTi18-10/1.4541 (EN 10253-3/-4)', 'X6CrNiNb18-10/1.4550 (EN 10253-3/-4)'] },
            // filtros y strainers: cuerpo fundido (ayuda de equivalencias, bridas y forjados) o fabricado con accesorios para soldar
            filtro: { ASME: ['SA-216 Gr.WCB', 'SA-351 Gr.CF8', 'SA-351 Gr.CF8M', 'SA-234 Gr.WPB', 'SA-234 Gr.WPC', 'SA-420 Gr.WPL6', 'SA-403 Gr.WP304', 'SA-403 Gr.WP304L', 'SA-403 Gr.WP316', 'SA-403 Gr.WP316L', 'SA-403 Gr.WP321', 'SA-403 Gr.WP347'],
                EN: ['GP240GH/1.0619 (EN 10213)', 'GX5CrNi19-10/1.4308 (EN 10213)', 'GX5CrNiMo19-11-2/1.4408 (EN 10213)', 'P235GH/1.0345 (EN 10253-2)', 'P265GH/1.0425 (EN 10253-2)', 'P355NH/1.0565 (EN 10253-2)', 'P275NL1/1.0488 (EN 10253-2)', 'P355NL1/1.0566 (EN 10253-2)', 'X5CrNi18-10/1.4301 (EN 10253-3/-4)', 'X2CrNi19-11/1.4306 (EN 10253-3/-4)', 'X5CrNiMo17-12-2/1.4401 (EN 10253-3/-4)', 'X2CrNiMo17-12-2/1.4404 (EN 10253-3/-4)', 'X6CrNiTi18-10/1.4541 (EN 10253-3/-4)', 'X6CrNiNb18-10/1.4550 (EN 10253-3/-4)'] },
            valvula: { ASME: ['SA-216 WCB', 'SA-352 LCB', 'SA-351 CF8', 'SA-351 CF8M', 'SA-351 CF3M', 'SA-105 (forjado)', 'SA-182 F316 (forjado)', 'B62 bronce', 'SA-395 fundición dúctil'], EN: ['1.0619 GP240GH (EN 10213)', '1.6220 G20Mn5 (EN 10213)', '1.4408 GX5CrNiMo19-11-2 (EN 10213)', 'EN-GJS-400-15 (EN 1563)', 'EN-GJL-250 (EN 1561)', 'CC491K bronce (EN 1982)', 'CW617N latón (EN 12165)'] },
            // bombas (lista de José 01/10/2026; equivalencias en Ayuda > Equivalencias)
            bomba: { ASME: ['ASTM A48 Cl.30B', 'ASTM A48 Cl.35B', 'ASTM A536 65-45-12 (fundición dúctil)', 'ASTM A216 Gr.WCB', 'SA-105 (forjado)', 'ASTM A351 Gr.CF8', 'ASTM A351 Gr.CF8M', 'ASTM A890/A995 Gr.4A (dúplex)', 'ASTM A890/A995 Gr.5A (superdúplex)', 'ASTM A890/A995 Gr.6A (superdúplex)', 'Bronce', 'Hastelloy', 'Inconel', 'Titanio'],
                EN: ['EN-GJL-250 (EN 1561)', 'EN-GJS-400-15 (EN 1563)', 'GP240GH/1.0619 (EN 10213)', 'GX5CrNi19-10/1.4308 (EN 10213)', 'GX5CrNiMo19-11-2/1.4408 (EN 10213)', '1.4462 dúplex (EN 10213 / EN 10283)', '1.4410 superdúplex (EN 10213 / EN 10283)', 'CC491K bronce (EN 1982)', '1.4470 dúplex (EN 10213)'] },
            equipo: { ASME: ['SA-516 Gr. 70', 'SA-240 TP316L', 'SB-265 Gr. 1 (titanio)', 'SB-111 C70600 (Cu-Ni 90/10)'], EN: ['P265GH (EN 10028-2)', 'P355NL1 (EN 10028-3)', '1.4404 (EN 10028-7)', 'Titanio Gr. 1', 'CuNi10Fe1Mn (EN 12449)'] },
            tanque: { ASME: ['SA-516 Gr. 70', 'SA-283 Gr. C', 'SA-240 TP316L'], EN: ['S235JR (EN 10025-2)', 'S275JR (EN 10025-2)', 'P265GH (EN 10028-2)', '1.4404 (EN 10028-7)', 'PRFV (EN 13121)', 'PE rotomoldeado'] },
            instrumento: { ASME: ['SA-182 F316L / 316L', 'Latón'], EN: ['1.4404 (AISI 316L)', 'CW617N latón (EN 12165)', 'Plástico técnico (PA / PP)'] }
        };
        // Tensión admisible orientativa por grado (MPa, hasta ~38 °C): ASME B31.3 tabla A-1; EN 13480-3 f = min(ReH/1,5; Rm/2,4)
        const S_GRADO = {
            // lista 7.9.2 (ASME B31.3 tabla A-1 a temperatura ambiente; EN 13480-3: f = min(ReH/1,5; Rm/2,4) con ReH/Rm mínimos de la norma)
            'SA-53 Gr.B': 137.9, 'SA-106 Gr.B': 137.9, 'SA-333 Gr.6': 137.9, 'P235TR1': 150, 'P235TR2': 150, 'P265TR1': 170.8, 'P265TR2': 170.8, 'P295GH': 191.7, 'X7CrNiTi18-10/1.4940': 166.7, 'X7CrNiNb18-10/1.4912': 170, 'P235GH': 150, 'P265GH': 170.8, 'P355GH': 212.5, 'P275NL1': 162.5, 'P275NL2': 162.5, 'P355NL1': 204.2, 'P355NL2': 204.2,
            'SA-312 Gr.Tp304': 137.9, 'SA-312 Gr.Tp304L': 115.1, 'SA-312 Gr.Tp316': 137.9, 'SA-312 Gr.Tp316L': 115.1, 'SA-312 Gr.Tp321': 137.9, 'SA-312 Gr.Tp321H': 137.9, 'SA-312 Gr.Tp347': 137.9, 'SA-312 Gr.Tp347H': 137.9,
            'X5CrNi18-10/1.4301': 166.7, 'X2CrNi19-11/1.4306': 150, 'X5CrNiMo17-12-2/1.4401': 170, 'X2CrNiMo17-12-2/1.4404': 173.3, 'X6CrNiTi18-10/1.4541': 166.7, 'X6CrNiNb18-10/1.4550': 170,
            // denominaciones de versiones anteriores (proyectos ya guardados)
            'SA-106 Gr. B': 137.9, 'SA-106 Gr. C': 160.6, 'SA-53 Gr. B (ERW)': 117.2, 'SA-333 Gr. 6 (baja temperatura)': 137.9, 'API 5L Gr. B': 137.9,
            'P235GH (EN 10216-2)': 150, 'P265GH (EN 10216-2)': 170.8, 'P235TR1 (EN 10216-1)': 150, 'P235TR2 (EN 10217-1)': 150, 'L245 (EN ISO 3183)': 163.3, 'S235JRH (EN 10219)': 150, 'P355N (EN 10216-3)': 204,
            'SA-312 TP304': 137.9, 'SA-312 TP304L': 115.1, 'SA-312 TP316': 137.9, 'SA-312 TP316L': 115.1, 'SA-312 TP321': 137.9, 'SA-358 TP316L (soldado)': 97.8,
            '1.4301 X5CrNi18-10 (EN 10216-5)': 166.7, '1.4307 X2CrNi18-9 (EN 10216-5)': 150, '1.4401 X5CrNiMo17-12-2 (EN 10216-5)': 170, '1.4404 X2CrNiMo17-12-2 (EN 10216-5)': 173.3, '1.4541 X6CrNiTi18-10 (EN 10216-5)': 166.7, '1.4404 soldado (EN 10217-7)': 147.3 };
        var MATCOMP_BOMBA_ANTIGUOS = { 'SA-216 WCB': 'ASTM A216 Gr.WCB', 'SA-351 CF8M': 'ASTM A351 Gr.CF8M', 'SA-48 Cl. 30 (fundición gris)': 'ASTM A48 Cl.30B', '1.4408 GX5CrNiMo19-11-2 (EN 10213)': 'GX5CrNiMo19-11-2/1.4408 (EN 10213)' };
        var MATCOMP_ANTIGUOS = { 'SA-105': 'SA-105N', 'SA-350 LF2 Cl. 1': 'SA-350 Gr.LF2', 'SA-182 F304': 'SA-182 Gr.F304', 'SA-182 F304L': 'SA-182 Gr.F304L', 'SA-182 F316': 'SA-182 Gr.F316', 'SA-182 F316L': 'SA-182 Gr.F316L',
            'SA-181 Gr.II': 'SA-181 Cl.70', 'P275NL1 (EN 10222-3)': 'P275NL1/1.0488 (EN 10222-3)', 'P355NL (EN 10222-3)': 'P355NL1/1.0566 (EN 10222-3)', 'P355GH/1.0473 (EN 10253-2)': 'P355NH/1.0565 (EN 10253-2)', 'P275NL1 (EN 10253-2)': 'P275NL1/1.0488 (EN 10253-2)', 'P355NL (EN 10253-2)': 'P355NL1/1.0566 (EN 10253-2)',
            '1.4307 (EN 10222-5)': 'X2CrNi19-11/1.4306 (EN 10222-5)', '1.4404 (EN 10222-5)': 'X2CrNiMo17-12-2/1.4404 (EN 10222-5)',
            'SA-234 WPB': 'SA-234 Gr.WPB', 'SA-234 WPC': 'SA-234 Gr.WPC', 'SA-420 WPL6': 'SA-420 Gr.WPL6', 'SA-403 WP304L': 'SA-403 Gr.WP304L', 'SA-403 WP316L': 'SA-403 Gr.WP316L',
            'P235GH (EN 10253-2)': 'P235GH/1.0345 (EN 10253-2)', 'P265GH (EN 10253-2)': 'P265GH/1.0425 (EN 10253-2)', '1.4307 (EN 10253-4)': 'X2CrNi19-11/1.4306 (EN 10253-3/-4)', '1.4404 (EN 10253-4)': 'X2CrNiMo17-12-2/1.4404 (EN 10253-3/-4)' };
        const matBase = m => (CAT && CAT.materiales[m] && CAT.materiales[m].base) || m;
        function familiaMaterialTubo(m) { const b = matBase(m); return b === 'Acero al carbono' ? 'tuboAC' : b === 'Acero inoxidable' ? 'tuboInox' : 'plastico'; }
        function grupoMaterial(el) {
            if (el.type === 'tuberia') return familiaMaterialTubo(el.material);
            if (el.type === 'bomba') return 'bomba';
            if (el.subtype === 'filtro' || el.subtype === 'strainer') return 'filtro';
            const c = (TIPOS[el.subtype] || {}).cat;
            return { uniones: 'brida', accesorios: 'accesorio', valvulas: 'valvula', intercambiadores: 'equipo', equipos: 'equipo', tanques: 'tanque', terminales: 'tanque', instrumentos: 'instrumento' }[c] || 'accesorio';
        }
        const opcionesMaterial = (grupo, actual) => {
            const M = MATERIALES[grupo] || { ASME: [], EN: [] }, todos = [...M.ASME, ...M.EN];
            return `<option value="">— sin indicar —</option>` + (M.ASME.length ? `<optgroup label="ASME / ASTM">${M.ASME.map(x => `<option ${x === actual ? 'selected' : ''}>${esc(x)}</option>`).join('')}</optgroup>` : '') +
                `<optgroup label="Norma europea (EN)">${M.EN.map(x => `<option ${x === actual ? 'selected' : ''}>${esc(x)}</option>`).join('')}</optgroup>` +
                (actual && !todos.includes(actual) ? `<optgroup label="Otro"><option selected>${esc(actual)}</option></optgroup>` : '') + `<option value="__otro">Otro (escribir)...</option>`;
        };
        function ctrlMaterial(fn, campo, valor, grupo, etiqueta = 'Material') {
            return `<div>${etiqueta}: <select onchange="if (this.value === '__otro') { const t = prompt('Material:', ''); if (t) ${fn}('${campo}', t); else this.value = ''; } else ${fn}('${campo}', this.value)" class="${CLS_CTRL}">${opcionesMaterial(grupo, valor)}</select></div>`;
        }
        // Grupos de la librería y sus tipos
        const TIPOS_BOMBA_LIB = [['centrifuga', 'Centrífuga'], ['peristaltica', 'Peristáltica'], ['piston', 'Alternativa / pistón'], ['dosificadora', 'Dosificadora'], ['membrana', 'Membrana'], ['engranajes', 'Engranajes'], ['tornillo', 'Tornillo / husillo'], ['lobulos', 'Lóbulos']];
        const PN_LISTA_BRIDAS = PN_LISTA.filter(x => !/^(75|2000|3000|6000|9000)#$/.test(x));
        const GRUPOS_MAT_ACC_LISTA = [['BW-ASME', 'Accesorios para soldar a tope ASME (SA-234, SA-420, SA-403)'], ['FORJ-ASME', 'Forjados ASME (SA-105, SA-350, SA-182)'], ['EN1', 'EN 10253-1 (S235, S265)'], ['EN2', 'EN 10253-2 (P235GH, P265GH...)'], ['EN34', 'EN 10253-3 / -4 (inoxidable: 1.4301, 1.4404...)'], ['TUBO-ASME', 'Tubos ASME (SA-53, SA-106, SA-333, SA-312...)'], ['TUBO-EN', 'Tubos EN (P235TR2, P235GH, P265GH...)'], ['FORJ-ASME,BRIDA-ASME', 'Bridas ASME (SA-105, SA-350, SA-181, SA-182...)'], ['BRIDA-ASME', 'Bridas ASME, además de los forjados (SA-181, SA-216, SA-351...)'], ['BRIDA-EN', 'Bridas EN (EN 10222-2 / -3 / -5, EN 10213)']];
        const SUBTIPOS_BRIDA = ['bridawn', 'bridaplana', 'bridaroscada', 'bridaloca', 'bridaciega', 'bridaunion', 'bridaplastica'];   // bridas de acero con modelo por norma (ASME B16.5 / B16.47, EN 1092-1)
        const esGrupoTablas = g => g === 'accesorios' || g === 'tubosAcero' || g === 'bridas';
        const GRUPOS_LIB = {
            accesorios: { titulo: 'Accesorios de tubería', cat: 'accesorios', mat: 'accesorio', excluir: ['continuacion', 'junta', 'antivibratorio', 'filtro', 'strainer', 'injerto'], extra: ['manguito'] },
            compensadores: { titulo: 'Filtros, injertos, juntas de expansión y manguitos', subtipos: ['filtro', 'strainer', 'injerto', 'junta', 'antivibratorio'], mat: 'accesorio' },
            intercambiadores: { titulo: 'Intercambiadores (buques)', cat: 'intercambiadores', mat: 'equipo' },
            tanques: { titulo: 'Tanques y depósitos', cat: 'tanques', mat: 'tanque' },
            bombas: { titulo: 'Bombas', subtipos: ['bomba'], mat: 'bomba' },
            equipos: { titulo: 'Equipos', cat: 'equipos', mat: 'equipo' },
            instrumentos: { titulo: 'Instrumentos', cat: 'instrumentos', mat: 'instrumento' },
            bridas: { titulo: 'Bridas', subtipos: SUBTIPOS_BRIDA, mat: 'brida' },
            uniones: { titulo: 'Uniones', cat: 'uniones', mat: 'brida', excluir: [...SUBTIPOS_BRIDA, 'manguito'] },
            valvulas: { titulo: 'Válvulas', cat: 'valvulas', mat: 'valvula' },
            tuberias: { titulo: 'Tuberías', subtipos: ['Acero al carbono', 'Acero inoxidable', 'PE100', 'PVC-U'], mat: 'tubo' },
            tubosAcero: { titulo: 'Tuberías de acero', subtipos: ['tuberia'], mat: 'tubo' }
        };
        const SUBTIPOS_SOLO_LIB = {};   // tipos solo de librería, sin símbolo en el plano (ninguno por ahora)
        const nombreSubtipo = st => st === 'bomba' ? 'Bomba centrífuga' : st === 'tuberia' ? 'Tubería' : (TIPOS[st] ? TIPOS[st].nombre : (SUBTIPOS_SOLO_LIB[st] || st));
        function subtiposGrupo(g) {
            const G = GRUPOS_LIB[g];
            if (g === 'tuberias') return [...G.subtipos, ...Object.keys(CAT.materiales).filter(m => !G.subtipos.includes(m) && !CAT.materiales[m].base)];
            return G.subtipos || Object.entries(TIPOS).filter(([k, t]) => t.cat === G.cat && !(G.excluir || []).includes(k)).map(([k]) => k).concat(G.extra || []).sort((a, b) => nombreSubtipo(a).localeCompare(nombreSubtipo(b), 'es'));
        }
        const grupoDeSubtipo = st => Object.keys(GRUPOS_LIB).find(g => subtiposGrupo(g).includes(st)) || (CAT.materiales[st] ? 'tuberias' : null);
        // Campos técnicos por grupo: [campo, etiqueta, tipo ('num' | 'txt' | 'sel'), opciones]
        const CAMPOS_LIB = {
            valvulas: [['craneTipo', 'Subtipo (pérdida de carga Crane)', 'crane'], ['cv', 'Cv por tamaño (pulg.:Cv; p. ej. 1/2:20; 1:78; 2:395)', 'txt'], ['kvs', 'Kvs (válvulas de control, m³/h)', 'num'], ['FL', 'Factor FL (IEC 60534)', 'num']],
            accesorios: [['cod', 'Código del tipo (va en la etiqueta: C90LR, TE, RC...) *', 'txt'], ['variante', 'Variante (LR, SR, 3D, concéntrica, excéntrica, SW...)', 'txt'], ['sistema', 'Medidas', 'sel', [['ASME', 'ASME (pulgadas)'], ['EN', 'EN (DN)']]],
                ['conexion', 'Conexión', 'sel', ['Soldar a tope (BW)', 'Socket weld (SW)', 'Roscado (NPT)']], ['matGrupo', 'Materiales que admite', 'sel', GRUPOS_MAT_ACC_LISTA], ['espTabla', 'Tabla de espesores', 'sel', [['ASME', 'ASME B36.10 / B36.19 según el material'], ['EN1', 'EN 10253-1 (un espesor por DN)'], ['EN2', 'EN 10253-2 (series 1 a 8)'], ['NO', 'Sin tabla cargada']]], ['ratings', 'Clase que admite (separadas por comas; NO = sin clase)', 'txt'],
                ['craneTipo', 'Tipo (pérdida de carga Crane)', 'crane'], ['k', 'K del fabricante (vacío = Crane)', 'num']],
            bridas: [['cod', 'Código del tipo (va en la etiqueta: WN, SO, BL, T11...) *', 'txt'], ['variante', 'Variante (WN, SO, tipo 11, serie A...)', 'txt'], ['sistema', 'Medidas', 'sel', [['ASME', 'ASME (pulgadas)'], ['EN', 'EN (DN)']]],
                ['conexion', 'Conexión', 'sel', ['Soldar a tope (BW)', 'Soldadura en ángulo', 'Socket weld (SW)', 'Roscado (NPT)', 'Roscado', 'Loca con stub end', 'Loca con collarín', 'Ciega']], ['matGrupo', 'Materiales que admite', 'sel', GRUPOS_MAT_ACC_LISTA],
                ['espTabla', 'Espesor del cuello / taladro', 'sel', [['NO', 'No aplica'], ['ASME', 'ASME B36.10M / B36.19M según el material'], ['EN10220', 'EN 10220']]], ['ratings', 'PN / Rating que admite (separados por comas; vacío = todos)', 'txt'], ['caras', 'Tipos de cara (separados por comas)', 'txt'],
                ['dnMin', 'DN mínimo', 'num'], ['dnMax', 'DN máximo', 'num']],
            tubosAcero: [['sistema', 'Medidas', 'sel', [['ASME', 'ASME (pulgadas)'], ['EN', 'EN (DN)']]], ['matGrupo', 'Materiales que admite', 'sel', GRUPOS_MAT_ACC_LISTA], ['espTabla', 'Tabla de espesores', 'sel', [['ASME', 'ASME B36.10M / B36.19M según el material'], ['EN10220', 'EN 10220']]]],
            compensadores: [['serie', 'Serie / espesor (Sch)', 'txt'], ['k', 'K del fabricante', 'num']],
            intercambiadores: [['qNom', 'Primario: caudal nominal (m³/h)', 'num'], ['dpNom', 'Primario: Δp a caudal nominal (kPa)', 'num'], ['qNom2', 'Secundario: caudal nominal (m³/h)', 'num'], ['dpNom2', 'Secundario: Δp (kPa)', 'num'], ['volumen', 'Volumen interior (l)', 'num'], ['potencia', 'Potencia térmica (kW)', 'num']],
            equipos: [['qNom', 'Caudal nominal (m³/h)', 'num'], ['dpNom', 'Δp a caudal nominal (kPa)', 'num'], ['volumen', 'Volumen interior (l)', 'num'], ['potencia', 'Potencia (kW)', 'num']],
            tanques: [['volumen', 'Volumen (l)', 'num'], ['altura', 'Altura (m)', 'num'], ['hB', 'Conexión lateral b sobre el fondo (m)', 'num'], ['hC', 'Conexión superior c sobre el fondo (m)', 'num'], ['psRecipiente', 'Presión máxima admisible PS (bar)', 'num'], ['tipoConexion', 'Tipo de conexión', 'conex'], ['dnConexion', 'Tamaño de la conexión', 'dn']],
            bombas: [['tag', 'Tag del equipo (p. ej. P-101A)', 'txt'], ['bombaTipo', 'Tipo de bomba', 'sel', TIPOS_BOMBA_LIB], ['fluidoDiseno', 'Fluido de diseño', 'txt'],
                ['caudal', 'Caudal de diseño (m³/h) *', 'num'], ['altura', 'Altura manométrica de diseño (m) *', 'num'], ['alturaCero', 'Altura a caudal cero (m)', 'num', null, 'cen'], ['npsh', 'NPSH requerido (m)', 'num'], ['rpm', 'Velocidad de rotación (rpm)', 'num'],
                ['potMotor', 'Potencia del motor (kW)', 'num'], ['eta', 'Rendimiento en el punto de diseño (%)', 'num'], ['tension', 'Tensión (V)', 'txt'], ['frecuencia', 'Frecuencia (Hz)', 'txt'], ['ip', 'Grado de protección (IP)', 'txt'],
                ['impulsor', 'Diámetro del impulsor (mm)', 'num', null, 'cen'], ['impulsorMax', 'Diámetro máximo del impulsor (mm)', 'num', null, 'cen'],
                ['volCilindrada', 'Volumen por ciclo / revolución (cm³)', 'num', null, 'vol'], ['volPmax', 'Presión máxima de trabajo (bar) *', 'num', null, 'vol'], ['volCiclos', 'Ciclos o revoluciones por minuto', 'num', null, 'vol'], ['volCilindros', 'N.º de cilindros / pulsaciones por ciclo', 'num', null, 'vol'], ['volMaterial', 'Material de manguera, válvulas o sellos', 'txt', null, 'vol'],
                ['dnAsp', 'Brida de aspiración', 'dn'], ['dnImp', 'Brida de impulsión', 'dn'], ['normaBridas', 'Norma de las bridas', 'sel', ['ASME', 'EN']], ['rating', 'PN / Rating', 'sel', PN_LISTA_BRIDAS], ['apiPlan', 'Plan de sellado (API 682)', 'txt'],
                ['curva', 'Curva característica: una fila por punto con caudal (m³/h), altura (m), rendimiento (%), NPSHr (m) y potencia en el eje (kW)', 'curva', null, 'cen']],
            instrumentos: [['rango', 'Rango / escala', 'txt'], ['dnInstr', 'Conexión a proceso', 'dn'], ['precision', 'Clase de precisión', 'txt']],
            uniones: [['cara', 'Tipo de cara', 'sel', ['RF (resalte)', 'FF (plana)', 'RTJ (junta anular)', 'Roscada', 'Encolada / termofusión']], ['normaDim', 'Norma dimensional', 'sel', ['ASME B16.5', 'ASME B16.47', 'ASME B16.11', 'EN 1092-1', 'EN 1092-2', 'EN 1092-3', 'DIN / ISO (plásticos)']]],
            tuberias: [['base', 'Tabla de tamaños y espesores', 'base'], ['codigo', 'Código de etiqueta (p. ej. TAC)', 'txt'], ['rug', 'Rugosidad ε (mm)', 'num'], ['sAdm', 'Tensión admisible S (MPa; vacío = según grado)', 'num'], ['c', 'Sobreespesor de corrosión (mm)', 'num'], ['Tmax', 'Temperatura máxima (°C)', 'num']]
        };
        let LIB = { items: [], ocultos: [] };
        try { const x = JSON.parse(localStorage.getItem('piping-libreria') || 'null'); if (x && Array.isArray(x.items)) LIB = { items: x.items, ocultos: x.ocultos || [] }; } catch (e) { }
        LIB.items.forEach(i => { if (i.pn) i.pn = PN_NUEVO(i.pn); });
        const guardarLib = () => { if (typeof puedeGuardar === 'function' && !puedeGuardar('cambiar la librería', 'compartido')) return; try { localStorage.setItem('piping-libreria', JSON.stringify(LIB)); } catch (e) { aviso('No se ha podido guardar la librería en el navegador.', 'error'); } };
        const VALVULAS_BASE = CAT ? CAT.valvulas.slice() : [];
        const TUBERIAS_BASE = TUBERIAS_LIBRERIA.slice();
        const MATERIALES_BASE = CAT ? new Set(Object.keys(CAT.materiales)) : new Set();
        const cvTexto = cv => Object.entries(cv || {}).map(([k, v]) => `${k}:${v}`).join('; ');
        const cvDesdeTexto = t => { const o = {}; String(t || '').split(/[;\n]+/).forEach(p => { const m = p.trim().match(/^([\d\-\/]+)\s*[:=]\s*([\d.,]+)$/); if (m) o[m[1]] = parseFloat(m[2].replace(',', '.')); }); return o; };
        // ---------- accesorios de tubería (v8.10): tablas separadas ----------
        // modelos (tipo de accesorio), medidas nominales, espesores por schedule, materiales, rating / PN y cotas.
        // El accesorio concreto se compone en el plano: modelo + medida + schedule + material (+ rating), con su código.
        // Origen: tablas piping_acc_* de Supabase; si no se pueden leer, datos/accesorios_tablas.js (mismo contenido).
        var ACC_T = null, ACC_BASE = [], ACC_POR_TIPO = {}, ACC_ORIGEN = null, CARGA_ACC = null;
        const SUBTIPOS_ACC = new Set([...subtiposGrupo('accesorios'), ...SUBTIPOS_BRIDA]);
        const esSubtipoAccesorio = st => SUBTIPOS_ACC.has(st);
        const FAMILIAS_ACC = ['Acero al carbono', 'Acero inoxidable'];
        const campoLibAplica = () => true;
        // administrador con sesión de Supabase y tablas leídas de la base de datos: sus cambios van a la base de datos
        function accEnBD() { const s = typeof sesionActual === 'function' ? sesionActual() : null; return ACC_ORIGEN === 'supabase' && !!s && s.origen === 'supabase' && s.rol === 'admin'; }
        function itemDeModeloAcc(m) {
            return { id: m.id, subtipo: m.subtipo, grupo: SUBTIPOS_BRIDA.includes(m.subtipo) ? 'bridas' : m.subtipo === 'tuberia' ? 'tubosAcero' : 'accesorios', origen: m.origen || 'catálogo', nombre: m.nombre, fabricante: m.fabricante || '', referencia: m.referencia || '', material: '', norma: m.norma || '', pn: '', url: m.url || '', notas: m.notas || '',
                modificado_por: m.modificado_por || '', props: { cod: m.cod, variante: m.variante || '', sistema: m.sistema || 'ASME', conexion: m.conexion || '', craneTipo: m.tipo_crane || '', matGrupo: m.mat_grupo || '', espTabla: m.esp_tabla || 'ASME', k: m.k == null ? '' : m.k, orden: m.orden, ratings: m.ratings || '', caras: m.caras || '', dnMin: m.dn_min == null ? '' : m.dn_min, dnMax: m.dn_max == null ? '' : m.dn_max } };
        }
        function modeloDeItemAcc(b) { const p = b.props || {}; return { id: b.id, cod: String(p.cod || '').trim().toUpperCase(), subtipo: b.subtipo, tipo: nombreSubtipo(b.subtipo), variante: p.variante || '', nombre: b.nombre, sistema: p.sistema || 'ASME', norma: b.norma || '', conexion: p.conexion || '', tipo_crane: p.craneTipo || '', mat_grupo: p.matGrupo || '', esp_tabla: p.espTabla || 'ASME', k: p.k === '' || p.k == null ? '' : p.k, notas: b.notas || '', fabricante: b.fabricante || '', referencia: b.referencia || '', url: b.url || '', ratings: String(p.ratings || '').trim(), caras: String(p.caras || '').trim(), dn_min: p.dnMin === '' || p.dnMin == null ? '' : p.dnMin, dn_max: p.dnMax === '' || p.dnMax == null ? '' : p.dnMax }; }
        function indexarAccesorios() { ACC_POR_TIPO = {}; ACC_BASE.forEach(i => (ACC_POR_TIPO[i.subtipo] = ACC_POR_TIPO[i.subtipo] || []).push(i)); }
        function asegurarAccesorios(forzar) {
            if (CARGA_ACC && !forzar) return CARGA_ACC;
            return CARGA_ACC = (async () => {
                let T = null, origen = 'local';
                if (typeof rpcUsuarios === 'function' && claveSupabase()) {
                    try { const d = await rpcUsuarios('piping_acc_tablas', {}); if (d && Array.isArray(d.modelos) && d.modelos.length && Array.isArray(d.espesores)) { T = d; origen = 'supabase'; } } catch (e) { /* sin tablas, sin clave o sin red: copia local */ }
                }
                if (!T) {
                    if (!window.PIPING_ACC_TABLAS) await new Promise(ok => { const sc = document.createElement('script'); sc.src = `datos/accesorios_tablas.js?v=${VERSION_WEB}`; sc.onload = ok; sc.onerror = () => { aviso('No se ha podido cargar datos/accesorios_tablas.js.', 'error'); ok(); }; document.head.appendChild(sc); });
                    const C = window.PIPING_ACC_TABLAS || {}; T = {};
                    ['modelos', 'medidas', 'espesores', 'materiales', 'ratings', 'cotas'].forEach(k => { const t = C[k]; T[k] = t ? t.filas.map(f => Object.fromEntries(t.cols.map((c, n) => [c, f[n]]))) : []; });
                }
                ACC_T = T; ACC_BASE = T.modelos.filter(m => SUBTIPOS_ACC.has(m.subtipo) || m.subtipo === 'tuberia').map(itemDeModeloAcc); try { sincronizarTubosAcc(); } catch (e) { console.warn(e); } indexarAccesorios(); ACC_ORIGEN = origen;
                try { if (elementosRed.some(e => e.accModelo || e.type === 'tuberia')) renderizarVectorial(); } catch (e) { }
                return origen;
            })();
        }
        const kItemLib = i => { const p = i.props || {}; return p.k !== '' && p.k != null ? String(p.k) : ''; };
        // tubería unida a un componente: propone la familia de material y el schedule
        function tuboVecino(el) { try { const v = vecinosDe(el).map(x => x.otro).find(o => o && o.type === 'tuberia'); return v || null; } catch (e) { return null; } }
        // modelo elegido para un accesorio del plano (o null)
        function modeloAcc(el) { if (!el || !el.accModelo) return null; return (ACC_POR_TIPO[el.subtype] || []).concat(typeof LIB !== 'undefined' ? LIB.items : []).find(i => i.id === el.accModelo) || ACC_BASE.find(i => i.id === el.accModelo) || null; }
        function modelosAcc(subtipo, el) { let l; try { l = itemsLib(subtipo); } catch (e) { l = ACC_POR_TIPO[subtipo] || []; }
            // reducción: solo los modelos de su variante (concéntrica o excéntrica)
            if (subtipo === 'reduccion' && el) { const exc = !!el.excentrica; l = l.filter(i => i.id === el.accModelo || !/c[eé]ntrica/i.test((i.props || {}).variante || '') || /^exc/i.test(i.props.variante) === exc); }
            return l; }
        function materialesAcc(m) { const g = m && m.props.matGrupo ? String(m.props.matGrupo).split(',') : null; return ACC_T ? ACC_T.materiales.filter(x => !g || g.includes(x.grupo)) : []; }
        function materialAcc(designacion) { return ACC_T && designacion ? ACC_T.materiales.find(x => x.designacion === designacion) || null : null; }
        function familiaAcc(el, m) { const mt = materialAcc(el.materialComp); if (mt) return mt.familia; const tv = tuboVecino(el), b = tv && ((CAT.materiales[tv.material] || {}).base || tv.material); return FAMILIAS_ACC.includes(b) ? b : 'Acero al carbono'; }
        function tablaEspAcc(el, m) { const t = m.props.espTabla || 'ASME'; return t === 'ASME' ? (familiaAcc(el, m) === 'Acero inoxidable' ? 'B36.19' : 'B36.10') : t; }
        function schedulesAcc(el, m, dnClave) { if (!ACC_T || !m || sinEspesorAcc(m)) return []; const t = tablaEspAcc(el, m), dn = dnNum(dnClave || el.dn); return ACC_T.espesores.filter(x => x.tabla === t && x.dn === dn); }
        function ratingsAcc(m) { const lim = m && m.props.ratings ? String(m.props.ratings).split(',').map(x => x.trim()).filter(Boolean) : null; if (lim && lim.length) return lim[0] === 'NO' ? [] : lim;
            // sin lista propia: los de su sistema; las clases de forjado (2000 a 9000) solo en accesorios y 75 / 400 solo en bridas
            const br = m && SUBTIPOS_BRIDA.includes(m.subtipo), l = ACC_T ? ACC_T.ratings.filter(r => !m || r.sistema === (m.props.sistema || 'ASME')).map(r => r.rating).filter(r => !m || (br ? !/^(2000|3000|6000|9000)#$/.test(r) : !/^(75#|400#|PN 2\.5|PN 160|PN 250|PN 320|PN 400)$/.test(r))) : []; return l.length ? l : PN_LISTA; }
        const sinRatingAcc = m => !!m && String(m.props.ratings || '').trim() === 'NO';   // soldar a tope (B16.9, EN 10253) y tubos: sin rating
        const carasAcc = m => m && m.props.caras ? String(m.props.caras).split(',').map(x => x.trim()).filter(Boolean) : [];
        const NOMBRE_CARA = { RF: 'RF · resalte', FF: 'FF · plana', RTJ: 'RTJ · junta anular', A: 'A · plana', B1: 'B1 · resalte', B2: 'B2 · resalte (acabado fino)', C: 'C · macho (lengüeta)', D: 'D · hembra (ranura)', E: 'E · macho (espiga)', F: 'F · hembra (alojamiento)', G: 'G · alojamiento con junta tórica', H: 'H · ranura para junta tórica' };
        const sinEspesorAcc = m => !!m && m.props.espTabla === 'NO';
        const dnEnRangoAcc = (m, dnClave) => { const d = dnNum(dnClave), a = +m.props.dnMin || 0, b = +m.props.dnMax || 1e9; return d >= a && d <= b; };
        function espesorAcc(el, m) { const x = schedulesAcc(el, m).find(s => s.schedule === el.accSch); return x ? x.espesor : null; }
        // ASME B16.11, tabla 6: socket weld clase 6000 hasta NPS 2 y clase 9000 de NPS 1/2 a 2
        const fueraClaseB1611 = (el, m) => /^B1611-/.test(m.id) && /SW$/.test(m.id) && ((el.pn === '6000#' && dnNum(el.dn) > 50) || (el.pn === '9000#' && (dnNum(el.dn) < 15 || dnNum(el.dn) > 50)));
        function medidaAcc(el, m) { if (!ACC_T || !m || !dnEnRangoAcc(m, el.dn) || fueraClaseB1611(el, m)) return null; return ACC_T.medidas.find(x => x.sistema === (m.props.sistema || 'ASME') && x.dn === dnNum(el.dn)) || null; }
        function cotasAcc(el, m) { if (!ACC_T || !m) return ''; const dn = dnNum(el.dn), dn2 = el.subtype === 'reduccion' ? dnNum(el.dnMenor) : null; const c = ACC_T.cotas.filter(x => x.modelo === m.id && x.dn === dn && (dn2 == null || x.dn2 === dn2)); const r = c.find(x => x.rating && x.rating === el.pn) || c.find(x => !x.dn2 || dn2 != null) || c[0]; return r ? r.cotas : ''; }
        const schCortoAcc = (sch, e) => { const s = String(sch || ''); if (!s) return ''; if (/^Sch /.test(s)) return 'S' + s.slice(4).replace(/\s+/g, ''); if (/^Serie |mm$/.test(s)) return e != null ? 'E' + e : s.replace(/\s+/g, ''); return s.replace(/\s+/g, ''); };
        // partes del código de un accesorio: medida, schedule, material y rating (lo que el usuario haya definido)
        function partesCodigoAcc(el, m) {
            const en = (m.props.sistema || 'ASME') === 'EN', dn = dnNum(el.dn), d2 = el.subtype === 'reduccion' && el.dnMenor ? dnNum(el.dnMenor) : null;
            const pul = c => { const n = npsDeDN(c); return n ? pulgadas(n) + '"' : String(c).replace(/\s+/g, ''); };
            const medida = en ? 'DN' + dn + (d2 ? 'x' + d2 : '') : pul(el.dn) + (d2 ? 'x' + pul(el.dnMenor) : '');
            const mt = materialAcc(el.materialComp), mat = mt ? mt.codigo : String(el.materialComp || '').replace(/\s*\(.*$/, '').replace(/^SA-\d+\s*Gr\./, '').replace(/[\s\/]+/g, '');
            return [medida, schCortoAcc(el.accSch, espesorAcc(el, m)), mat, el.pn && !sinRatingAcc(m) ? String(el.pn).replace(/\s+/g, '') : '', el.cara && carasAcc(m).includes(el.cara) ? el.cara : ''].filter(Boolean);
        }
        // código del accesorio: TIPO-MEDIDA-SCHEDULE-MATERIAL(-RATING), p. ej. C90LR-2"-S40-WPB; en bridas, además la cara: WN-2"-S40-SA105N-150#-RF
        function codigoAccesorio(el) { const m = modeloAcc(el); return m ? [m.props.cod || el.codigo || codigoDe(el), ...partesCodigoAcc(el, m)].join('-') : ''; }
        // al elegir el modelo: tipo de pérdida de carga, variante de la reducción y valores por defecto de la tubería conectada
        function aplicarModeloAcc(el, id) {
            if (!id) { delete el.accModelo; delete el.accSch; return; }
            el.accModelo = id; delete el.libItem; const m = modeloAcc(el); if (!m) return;
            if (m.props.craneTipo && opcionesCrane(claveCrane(el)).some(o => o[0] === m.props.craneTipo)) { el.craneTipo = m.props.craneTipo; if (el.modoK === 'manual' || !el.modoK) el.modoK = 'crane'; }
            if (m.props.k !== '' && m.props.k != null && !isNaN(+m.props.k)) { el.modoK = 'manual'; el.k = +m.props.k; }
            if (el.subtype === 'reduccion' && /c[eé]ntrica/i.test(m.props.variante || '')) el.excentrica = /^exc/i.test(m.props.variante);
            const mats = materialesAcc(m), tv = tuboVecino(el);
            if (!mats.some(x => x.designacion === el.materialComp)) { const fam = familiaAcc(Object.assign({}, el, { materialComp: '' }), m), d = mats.find(x => x.familia === fam) || mats[0]; if (d) el.materialComp = d.designacion; }
            ajustarScheduleAcc(el, tv);
            if (sinRatingAcc(m) || (el.pn && !ratingsAcc(m).includes(el.pn))) delete el.pn;
            const cs = carasAcc(m); if (!cs.length) delete el.cara; else if (!cs.includes(el.cara)) el.cara = cs.includes('RF') ? 'RF' : cs.includes('B1') ? 'B1' : cs[0];
        }
        // el schedule tiene que existir para la medida y la familia: si no, el de la tubería conectada o ninguno
        function ajustarScheduleAcc(el, tv) {
            const m = modeloAcc(el); if (!m) return; const ops = schedulesAcc(el, m).map(x => x.schedule);
            if (ops.includes(el.accSch)) return;
            tv = tv || tuboVecino(el); const st = tv ? (/^[0-9]+S?$/.test(tv.serie) ? 'Sch ' + tv.serie : tv.serie) : '';
            if (ops.includes(st)) el.accSch = st; else if (ops.length === 1) el.accSch = ops[0]; else delete el.accSch;
        }
        { const _ac = aplicarCambio; aplicarCambio = function (obj, campo, valor) { if (obj && obj.type === 'tuberia' && campo === 'tuboTipo') { aplicarTipoTubo(obj, valor); return true; } if (obj && esTuboAceroNorma(obj) && campo === 'gradoMaterial') { aplicarGradoTubo(obj, String(valor).trim()); return true; } if (obj && obj.accModelo && campo === 'pn' && String(valor).trim() === '') { delete obj.pn; return true; } if (obj && campo === 'normaPN') { cambiarNormaPN(obj, valor); return true; } if (obj && obj.type === 'bomba' && ['fabricante', 'modelo', 'tension', 'frecuencia', 'ip', 'apiPlan', 'volMaterial', 'rpm', 'potMotor', 'impulsor', 'impulsorMax', 'volCilindrada', 'volCiclos', 'volPmax', 'volCilindros'].includes(campo) && String(valor).trim() === '') { delete obj[campo]; return true; } if (obj && obj.type === 'bomba' && campo === 'bombaTipo') { if (valor && valor !== 'centrifuga') { obj.bombaTipo = valor; delete obj.curva; delete obj.curvaModo; } else delete obj.bombaTipo; return true; } if (obj && obj.accModelo && campo === 'cara') { if (valor) obj.cara = valor; else delete obj.cara; return true; } const r = _ac.apply(this, arguments); try { if (obj && obj.accModelo && ['materialComp', 'dn', 'dnMenor'].includes(campo)) ajustarScheduleAcc(obj); } catch (e) { } return r; }; }
        // ---------- tuberías de acero (v8.11): un modelo por norma (ASME, EN); la familia la da el material ----------
        const TUBO_EN = 'Acero al carbono EN';
        const MAT_CORTO_TUBO = { 'SA-53 Gr.B': 'SA53B', 'SA-106 Gr.B': 'SA106B', 'SA-333 Gr.6': 'SA333-6', 'SA-671': 'SA671', 'SA-672': 'SA672', 'SA-312 Gr.Tp304': 'TP304', 'SA-312 Gr.Tp304L': 'TP304L', 'SA-312 Gr.Tp316': 'TP316', 'SA-312 Gr.Tp316L': 'TP316L',
            'SA-312 Gr.Tp321': 'TP321', 'SA-312 Gr.Tp321H': 'TP321H', 'SA-312 Gr.Tp347': 'TP347', 'SA-312 Gr.Tp347H': 'TP347H', 'SA-358': 'SA358' };
        // tipo de tubería: TUB-ASME, TUB-EN o el nombre del material (plásticos y tuberías creadas por el usuario)
        function tipoTubo(el) { const m = el.material; return m === TUBO_EN ? 'TUB-EN' : (m === 'Acero al carbono' || m === 'Acero inoxidable') ? 'TUB-ASME' : m; }
        const esTuboAceroNorma = el => el && el.type === 'tuberia' && /^TUB-/.test(tipoTubo(el));
        function opcionesTipoTubo() {
            const mod = id => (ACC_POR_TIPO.tuberia || []).find(i => i.id === id);
            const et = (id, def) => { const m = mod(id); return m ? `${m.nombre} · ${m.norma}` : def; };
            return [['TUB-ASME', et('TUB-ASME', 'Tubería de acero ASME · ASME B36.10M / B36.19M')], ['TUB-EN', et('TUB-EN', 'Tubería de acero EN · EN 10220')], ...Object.keys(CAT.materiales).filter(m => !['Acero al carbono', 'Acero inoxidable', TUBO_EN].includes(m)).map(m => [m, m])];
        }
        // grados de material de un tipo de tubería de acero: de la tabla de materiales o, si aún no se ha leído, de las listas del programa
        function gradosTubo(tipo) {
            const g = tipo === 'TUB-EN' ? 'TUBO-EN' : 'TUBO-ASME';
            if (ACC_T && ACC_T.materiales.some(x => x.grupo === g)) return ACC_T.materiales.filter(x => x.grupo === g);
            const f = (l, familia) => l.map(d => ({ codigo: MAT_CORTO_TUBO[d] || d.replace(/[\s\/].*$/, ''), designacion: d, familia, grupo: g, equivalente: '' }));
            return tipo === 'TUB-EN' ? f(MATERIALES.tuboAC.EN, 'Acero al carbono') : f(MATERIALES.tuboAC.ASME, 'Acero al carbono').concat(f(MATERIALES.tuboInox.ASME, 'Acero inoxidable'));
        }
        function gradoTubo(el) { return el.gradoMaterial ? gradosTubo(tipoTubo(el)).find(x => x.designacion === el.gradoMaterial) || null : null; }
        function matCortoTubo(el) { const g = gradoTubo(el); return g ? g.codigo : String(el.gradoMaterial || '').replace(/^SA-/, 'SA').replace(/\s*Gr\./, '').replace(/[\s\/(].*$/, ''); }
        // partes del código de una tubería de acero: medida, schedule, material y rating
        function partesCodigoTubo(el) {
            const dt = datosTuberia(el), en = el.material === TUBO_EN;
            const medida = en ? 'DN' + dnNum(el.dn) : (dt.nps ? pulgadas(dt.nps) + '"' : String(el.dn).replace(/\s+/g, ''));
            const sch = serieTexto(el);
            return [medida, sch, matCortoTubo(el)].filter(Boolean);   // la tubería no tiene rating: su presión la da el espesor
        }
        // código: TIPO-MEDIDA-SCHEDULE-MATERIAL, p. ej. TAC-2"-S40-SA106B; solo cuando la tubería de acero tiene material
        function codigoTubo(el) { return esTuboAceroNorma(el) && el.gradoMaterial ? [el.codigo || codigoDe(el), ...partesCodigoTubo(el)].join('-') : ''; }
        // cambia el tipo de tubería (o el material, en plásticos) dejando coherentes grado, schedule y medida
        function aplicarTipoTubo(el, tipo) {
            const antes = tipoTubo(el), fam = (gradoTubo(el) || {}).familia;
            const mat = tipo === 'TUB-EN' ? TUBO_EN : tipo === 'TUB-ASME' ? (antes === 'TUB-ASME' ? el.material : 'Acero al carbono') : tipo;
            if (!CAT.materiales[mat]) return;
            const dnAntes = dnNum(el.dn), esDN = /^DN /.test(String(el.dn));
            el.material = mat;
            if (tipo !== antes && el.gradoMaterial && !gradosTubo(tipo).some(x => x.designacion === el.gradoMaterial)) delete el.gradoMaterial;
            ajustarSerieTubo(el, esDN ? dnAntes : null);
            if (el.codigo && el.codigo !== codigoDe(el)) asignarNumero(el); // TAC / TAI / TPE…: el código sigue al material
        }
        // la serie y la medida tienen que existir en la tabla del material
        function ajustarSerieTubo(el, dnPreferido) {
            const m = materialDe(el);
            if (dnPreferido) { const t = m.tamanos.find(x => dnNum(x.clave) === dnPreferido && /^DN /.test(x.clave)); if (t) el.dn = t.clave; }
            let t = m.tamanos.find(x => x.clave === el.dn) || m.tamanos.find(x => x.e[el.serie] != null) || m.tamanos[0];
            el.dn = t.clave;
            if (t.e[el.serie] == null) { const def = m.serieDef && t.e[m.serieDef] != null ? m.serieDef : Object.keys(t.e)[0]; el.serie = def; }
        }
        // elegir el material (grado) de una tubería de acero ASME fija la familia: al carbono (B36.10M) o inoxidable (B36.19M)
        function aplicarGradoTubo(el, grado) {
            if (!grado) { delete el.gradoMaterial; return; }
            el.gradoMaterial = grado;
            const g = gradosTubo(tipoTubo(el)).find(x => x.designacion === grado);
            if (g && tipoTubo(el) === 'TUB-ASME' && g.familia !== el.material && CAT.materiales[g.familia]) { const dn = dnNum(el.dn); el.material = g.familia; ajustarSerieTubo(el, dn); if (el.codigo && el.codigo !== codigoDe(el)) asignarNumero(el); }
        }
        // los espesores de tubo de las tablas (Supabase o copia local) pasan a las tablas de cálculo del programa
        function sincronizarTubosAcc() {
            if (!ACC_T) return; const M = { 'B36.10': 'Acero al carbono', 'B36.19': 'Acero inoxidable', 'EN10220': TUBO_EN };
            ACC_T.espesores.forEach(x => { const mat = CAT.materiales[M[x.tabla]]; if (!mat) return; const t = mat.tamanos.find(y => y.clave === 'DN ' + x.dn); if (!t) return;
                const k = /^Sch /.test(x.schedule) ? x.schedule.slice(4) : x.schedule; if (!mat.series.includes(k)) mat.series.push(k); if (+x.espesor > 0) t.e[k] = +x.espesor; });
        }
        // controles de tipo de tubería y material en el panel de propiedades
        function camposTubo(obj, fn) {
            const tipo = tipoTubo(obj), acero = /^TUB-/.test(tipo);
            let h = ctrlSelect(fn, 'tuboTipo', opcionesTipoTubo(), tipo, 'Tipo de tubería');
            if (!acero) return h + ctrlMaterial(fn, 'gradoMaterial', obj.gradoMaterial || (CAT.materiales[obj.material] || {}).grado || '', familiaMaterialTubo(obj.material), 'Material (grado)');
            const gr = gradosTubo(tipo);
            h += `<div>Material: <select onchange="${fn}('gradoMaterial', this.value)" class="${CLS_CTRL}"><option value="">— sin indicar —</option>${FAMILIAS_ACC.map(f => { const g = gr.filter(x => x.familia === f); return g.length ? `<optgroup label="${f}">${g.map(x => `<option value="${esc(x.designacion)}" ${x.designacion === obj.gradoMaterial ? 'selected' : ''}>${esc(x.designacion)}</option>`).join('')}</optgroup>` : ''; }).join('')}${obj.gradoMaterial && !gr.some(x => x.designacion === obj.gradoMaterial) ? `<option selected>${esc(obj.gradoMaterial)}</option>` : ''}</select></div>`;
            const c = codigoTubo(obj), g = gradoTubo(obj);
            h += info(c ? `Código: <b class="text-slate-700">${esc(c)}</b>${g && g.equivalente ? `<br>Equivalente: ${esc(g.equivalente)}` : ''}` : 'Elige el material para completar el código de la tubería.');
            return h;
        }
        // controles del accesorio en el panel de propiedades: modelo, material y schedule (la medida y el rating van aparte)
        function camposAccesorio(obj, fn) {
            if (!ACC_ORIGEN) { asegurarAccesorios().then(() => { try { if (idSeleccionado === obj.id) seleccionarElemento(obj.id); } catch (e) { } }); return `<div class="text-slate-400 italic">Cargando modelos de accesorio...</div>`; }
            const m = modeloAcc(obj), lista = modelosAcc(obj.subtype, obj);
            let h = `<div>Modelo: <select onchange="${fn}('accModelo', this.value)" class="${CLS_CTRL}"><option value="">— sin definir —</option>${lista.map(i => `<option value="${esc(i.id)}" ${i.id === obj.accModelo ? 'selected' : ''}>${esc(i.nombre)} · ${esc(i.norma)}</option>`).join('')}</select></div>`;
            if (!m) return h + ctrlMaterial(fn, 'materialComp', obj.materialComp || '', grupoMaterial(obj));
            const mats = materialesAcc(m), sch = schedulesAcc(obj, m);
            if (!mats.length) h += ctrlMaterial(fn, 'materialComp', obj.materialComp || '', grupoMaterial(obj)); else h += `<div>Material: <select onchange="${fn}('materialComp', this.value)" class="${CLS_CTRL}"><option value="">— sin indicar —</option>${FAMILIAS_ACC.map(f => { const g = mats.filter(x => x.familia === f); return g.length ? `<optgroup label="${f}">${g.map(x => `<option value="${esc(x.designacion)}" ${x.designacion === obj.materialComp ? 'selected' : ''}>${esc(x.designacion)}</option>`).join('')}</optgroup>` : ''; }).join('')}${obj.materialComp && !mats.some(x => x.designacion === obj.materialComp) ? `<option selected>${esc(obj.materialComp)}</option>` : ''}</select></div>`;
            const caras = carasAcc(m);
            if (caras.length) h += `<div>Cara: <select onchange="${fn}('cara', this.value)" class="${CLS_CTRL}"><option value="">— sin indicar —</option>${caras.map(x => `<option value="${esc(x)}" ${x === obj.cara ? 'selected' : ''}>${esc(NOMBRE_CARA[x] || x)}</option>`).join('')}</select></div>`;
            if (!sinEspesorAcc(m)) h += `<div>${SUBTIPOS_BRIDA.includes(obj.subtype) ? 'Schedule / espesor del cuello' : 'Schedule / espesor'}: <select onchange="${fn}('accSch', this.value)" class="${CLS_CTRL}"><option value="">— sin definir —</option>${sch.map(x => `<option value="${esc(x.schedule)}" ${x.schedule === obj.accSch ? 'selected' : ''}>${esc(x.schedule)}${/mm$/.test(x.schedule) ? '' : ' · ' + x.espesor + ' mm'}</option>`).join('')}</select></div>`;
            const md = medidaAcc(obj, m), e = espesorAcc(obj, m), co = cotasAcc(obj, m), mt = materialAcc(obj.materialComp);
            h += info(`Código: <b class="text-slate-700">${esc(codigoAccesorio(obj))}</b><br>${esc(m.norma)}${md ? ` · OD ${md.od} mm` : ' · <span class="text-amber-600">medida fuera de la norma</span>'}${e != null ? ` · e ${e} mm` : ''}${co ? ` · ${esc(co)}` : ''}${mt && mt.equivalente ? `<br>Equivalente: ${esc(mt.equivalente)}` : ''}`);
            return h;
        }
        // Elementos de la lista de un tipo (base del catálogo + del usuario, sin los ocultos)
        function itemsLib(subtipo) {
            const usuario = LIB.items.filter(i => i.subtipo === subtipo);
            let base = [];
            if (TIPOS[subtipo] && TIPOS[subtipo].type === 'valvula') base = VALVULAS_BASE.filter(v => v.tipo === subtipo).map(v => ({ id: 'cat:' + v.nombre, subtipo, origen: 'catálogo', nombre: v.nombre, fabricante: v.nombre.split(' · ')[0], url: '', notas: [v.fuente, v.nota].filter(Boolean).join(' · '), props: { cv: cvTexto(v.cv) } }));
            if (GRUPOS_LIB.tuberias.subtipos.includes(subtipo) || (CAT.materiales[subtipo] && MATERIALES_BASE.has(subtipo))) {
                const m = CAT.materiales[subtipo], sa = S_ADM[subtipo] || {};
                base = [{ id: 'mat:' + subtipo, subtipo, origen: 'catálogo', nombre: subtipo, material: sa.mat ? GRADO_NUEVO(sa.mat.replace(/^ASTM A/, 'SA-').replace(/Gr\. /g, 'Gr.')) : '', norma: m ? m.norma : '', props: { base: subtipo, codigo: CODIGO_MATERIAL[subtipo] || '', rug: m ? m.rug : '', sAdm: sa.S || '', c: sa.c != null ? sa.c : '', Tmax: sa.Tmax || '' } }];
                // tuberías del usuario creadas sobre esta tabla de tamaños
                LIB.items.filter(i => i.grupo === 'tuberias' && i.props && i.props.base === subtipo && i.subtipo !== subtipo).forEach(i => base.push(i));
            }
            if (esSubtipoAccesorio(subtipo) || subtipo === 'tuberia') base = (typeof ACC_POR_TIPO === 'object' && ACC_POR_TIPO[subtipo]) || [];
            if (subtipo === 'bomba' && typeof BOMBAS_BD !== 'undefined') base = BOMBAS_BD;
            const ids = new Set(usuario.map(i => i.id));
            return [...base.filter(b => !ids.has(b.id)), ...usuario].filter(i => !LIB.ocultos.includes(i.id));
        }
        const itemPorId = id => { for (const i of LIB.items) if (i.id === id) return i; const st = [...Object.keys(TIPOS), 'bomba', ...Object.keys(CAT.materiales)]; for (const s of st) { const x = itemsLib(s).find(i => i.id === id); if (x) return x; } return null; };
        // Aplica la librería al catálogo en memoria: válvulas con Cv y materiales de tubería nuevos
        function aplicarLibreria() {
            if (!CAT) return;
            const sobre = new Set(LIB.items.map(i => i.id));
            CAT.valvulas = VALVULAS_BASE.filter(v => !LIB.ocultos.includes('cat:' + v.nombre) && !sobre.has('cat:' + v.nombre));
            LIB.items.filter(i => TIPOS[i.subtipo] && TIPOS[i.subtipo].type === 'valvula' && i.props && i.props.cv).forEach(i => {
                const cv = cvDesdeTexto(i.props.cv);
                if (Object.keys(cv).length) CAT.valvulas.push({ nombre: i.nombre, tipo: i.subtipo, fuente: i.url || 'Librería de usuario', nota: i.notas || '', cv });
            });
            // materiales base modificados (rugosidad, S) y tuberías nuevas por material
            LIB.items.filter(i => i.grupo === 'tuberias').forEach(i => {
                const p = i.props || {}, base = MATERIALES_BASE.has(p.base) ? p.base : 'Acero al carbono';
                if (i.id === 'mat:' + i.subtipo && MATERIALES_BASE.has(i.subtipo)) {
                    if (+p.rug > 0) CAT.materiales[i.subtipo].rug = +p.rug;
                    if (S_ADM[i.subtipo] && +p.sAdm > 0) Object.assign(S_ADM[i.subtipo], { S: +p.sAdm, mat: i.material || S_ADM[i.subtipo].mat });
                    return;
                }
                if (LIB.ocultos.includes(i.id)) return;
                const n = i.nombre; if (!n || MATERIALES_BASE.has(n)) return;
                CAT.materiales[n] = Object.assign(JSON.parse(JSON.stringify(CAT.materiales[base])), { base, rug: +p.rug > 0 ? +p.rug : CAT.materiales[base].rug, norma: i.norma || CAT.materiales[base].norma, grado: i.material || '' });
                CODIGO_MATERIAL[n] = (p.codigo || CODIGO_MATERIAL[base] || 'T').toUpperCase();
                [ALFA_MAT, DENS_MAT, E_MATERIAL].forEach(t => { if (t && t[base] != null) t[n] = t[base]; });
                const sb = S_ADM[base];
                const S = +p.sAdm > 0 ? +p.sAdm : S_GRADO[i.material];
                if (sb || S) S_ADM[n] = { S: S || sb.S, Tmax: +p.Tmax > 0 ? +p.Tmax : (sb ? sb.Tmax : 150), mat: i.material || (sb ? sb.mat : ''), c: p.c !== '' && p.c != null && !isNaN(+p.c) ? +p.c : (sb ? sb.c : 0) };
            });
            // tuberías del panel derecho: las del programa y una por cada material nuevo
            TUBERIAS_LIBRERIA.length = 0;
            TUBERIAS_BASE.forEach(t => { const r = tuboPanel(t); if (r) TUBERIAS_LIBRERIA.push(r); });
            Object.keys(CAT.materiales).filter(m => CAT.materiales[m].base && m !== TUBO_EN && !LIB.ocultos.includes(m)).forEach(m => {
                const mt = CAT.materiales[m], serie = mt.serieDef || mt.series[0], t = mt.tamanos.find(x => x.clave === 'DN 50' && x.e[serie] != null) || mt.tamanos.find(x => x.e[serie] != null);
                if (t) TUBERIAS_LIBRERIA.push({ material: m, serie, dn: t.clave, texto: m });
            });
        }
        // Aplica un modelo de la librería a un elemento del dibujo
        function aplicarItemLib(el, item) {
            if (!item) { delete el.libItem; return; }
            const p = item.props || {}, num = v => v !== '' && v != null && !isNaN(+v) ? +v : null;
            el.libItem = item.id; el.fabricante = item.fabricante || ''; if (item.material) el.materialComp = item.material; if (item.url) el.url = item.url;
            if (item.pn && el.type !== 'tuberia') el.pn = item.pn;
            if (el.type === 'valvula') {
                if (p.craneTipo) el.craneTipo = p.craneTipo;
                if (p.cv && Object.keys(cvDesdeTexto(p.cv)).length) { el.modoK = 'catalogo'; el.serieCat = item.nombre; }
                if (num(p.kvs) && el.subtype === 'control') el.kvs = num(p.kvs);
                if (num(p.FL)) el.FL = num(p.FL);
            } else if (el.type === 'accesorio') {
                if (p.craneTipo) el.craneTipo = p.craneTipo;
                if (num(p.k) != null && item.origen !== 'catálogo') { el.modoK = 'manual'; el.k = num(p.k); }   // los B16.9 de partida siguen con Crane (mismo K)
            } else if (el.type === 'bomba') { aplicarBombaLib(el, p); if (item.fabricante) el.fabricante = item.fabricante; if (item.referencia || item.nombre) el.modelo = item.referencia || item.nombre; }
            else if (esEquipo(el)) ['qNom', 'dpNom', 'qNom2', 'dpNom2', 'volumen'].forEach(k => { if (num(p[k]) != null) el[k] = num(p[k]); });
            else if (esDeposito(el)) { ['volumen', 'hB', 'hC', 'psRecipiente'].forEach(k => { if (num(p[k]) != null) el[k] = num(p[k]); }); if (p.tipoConexion) el.tipoConexion = p.tipoConexion; if (p.dnConexion) el.dnConexion = p.dnConexion; }
            else if (el.type === 'instrumento') { if (p.rango) el.rango = p.rango; if (p.dnInstr) el.dnInstr = p.dnInstr; }
            normalizarElemento(el);
        }
        // Controles de «modelo de librería», material y URL para las propiedades de un elemento
        function camposLibreria(obj, fn) {
            if (esAnotacion(obj)) return '';
            let h = '';
            if (obj.type !== 'tuberia') {
                if (obj.type === 'accesorio' && esSubtipoAccesorio(obj.subtype)) return camposAccesorio(obj, fn) + `<div>URL del componente: <input type="text" value="${esc(obj.url || '')}" placeholder="https://..." onchange="${fn}('url', this.value)" class="${CLS_CTRL}"></div>`;
                const lista = itemsLib(obj.type === 'bomba' ? 'bomba' : obj.subtype);
                h += `<div>Modelo de librería: <select onchange="${fn}('libItem', this.value)" class="${CLS_CTRL}"><option value="">— ninguno (genérico) —</option>${lista.map(i => `<option value="${esc(i.id)}" ${i.id === obj.libItem ? 'selected' : ''}>${esc(i.nombre)}${i.material ? ' · ' + esc(i.material) : ''}</option>`).join('')}</select></div>`;
                h += ctrlMaterial(fn, 'materialComp', obj.materialComp || '', grupoMaterial(obj));
            } else h += camposTubo(obj, fn);
            h += `<div>URL del componente: <div class="flex gap-1"><input type="text" value="${esc(obj.url || '')}" placeholder="https://..." onchange="${fn}('url', this.value)" class="${CLS_CTRL}">${obj.url ? `<a href="${esc(obj.url)}" target="_blank" rel="noopener" class="text-blue-600 mt-1.5" title="Abrir"><i class="fa-solid fa-arrow-up-right-from-square"></i></a>` : ''}</div></div>`;
            return h;
        }

        // ---------- Ventana de la librería ----------
        let libVista = { grupo: null, subtipo: null, id: null, borrador: null };
        // familias de la librería de accesorios (Librerías > Accesorios > Codos, Tes, Reducciones...)
        const FAM_ACC = {
            codos: { titulo: 'Codos', subs: ['codo45', 'codo60', 'codo90'] },
            tes: { titulo: 'Tes', subs: ['tee'] },
            cruces: { titulo: 'Cruces', subs: ['cruce'] },
            manguitos: { titulo: 'Manguitos de unión', subs: ['manguito'] },
            redconc: { titulo: 'Reducciones concéntricas', subs: ['reduccion'], f: i => !/exc/i.test(((i.props || {}).variante || '') + ' ' + (i.nombre || '')) },
            redexc: { titulo: 'Reducciones excéntricas', subs: ['reduccion'], f: i => /exc/i.test(((i.props || {}).variante || '') + ' ' + (i.nombre || '')) }
        };
        const famLib = () => libVista && libVista.grupo === 'accesorios' && FAM_ACC[libVista.fam] || null;
        function abrirLibreria(grupo, subtipo, fam) {
            const subs = grupo === 'accesorios' && FAM_ACC[fam] ? FAM_ACC[fam].subs : subtiposGrupo(grupo);
            libVista = { grupo, solo: grupo === 'tuberias' && !!subtipo, fam: grupo === 'accesorios' && FAM_ACC[fam] ? fam : '', subtipo: subtipo && subs.includes(subtipo) ? subtipo : subs[0], id: null, borrador: null, filtroTipo: '', q: '', tab: 'modelos' };
            document.getElementById('modal-libreria').style.display = 'flex';
            document.getElementById('lib-caja').style.width = esGrupoTablas(grupo) ? 'min(1500px, 97vw)' : 'min(1150px, 96vw)';
            if (grupo === 'bombas') asegurarBombas(true).then(() => { if (libVista && libVista.grupo === 'bombas' && document.getElementById('modal-libreria').style.display === 'flex' && !libVista.borrador) pintarLibreria(); });
            if (esGrupoTablas(grupo) && (!ACC_ORIGEN || (ACC_ORIGEN === 'local' && claveSupabase()))) {
                if (!ACC_ORIGEN) { document.getElementById('lib-titulo').innerHTML = `<i class="fa-solid fa-book text-blue-600 mr-1.5"></i>Librería · ${esc(GRUPOS_LIB[grupo].titulo)}`; document.getElementById('lib-cuerpo').innerHTML = '<p class="text-slate-400 italic p-4"><i class="fa-solid fa-spinner fa-spin mr-1"></i>Cargando accesorios...</p>'; }
                else pintarLibreria();
                asegurarAccesorios(true).then(() => { if (esGrupoTablas(libVista.grupo) && document.getElementById('modal-libreria').style.display === 'flex' && !libVista.borrador) pintarLibreria(); });
                return;
            }
            pintarLibreria();
        }
        function cerrarLibreria() { document.getElementById('modal-libreria').style.display = 'none'; }
        function nuevoItemLib(copiaDe) {
            const V = libVista, base = copiaDe ? JSON.parse(JSON.stringify(copiaDe)) : { nombre: '', fabricante: '', referencia: '', material: '', norma: '', pn: '', url: '', notas: '', props: V.grupo === 'tuberias' ? { base: MATERIALES_BASE.has(V.subtipo) ? V.subtipo : ((CAT.materiales[V.subtipo] || {}).base || 'Acero al carbono') } : {} };
            base.id = 'usr:' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
            base.subtipo = V.subtipo; base.grupo = V.grupo; base.origen = 'usuario';
            if (copiaDe) base.nombre = (copiaDe.nombre || '') + ' (copia)';
            if (V.grupo === 'accesorios') { base.props = base.props || {}; if (!copiaDe) Object.assign(base.props, { sistema: 'ASME', conexion: 'Soldar a tope (BW)', matGrupo: 'BW-ASME', espTabla: 'ASME' }); }
            if (V.grupo === 'bridas') { base.props = base.props || {}; if (!copiaDe) Object.assign(base.props, { sistema: 'ASME', conexion: 'Soldar a tope (BW)', matGrupo: 'FORJ-ASME,BRIDA-ASME', espTabla: 'NO', ratings: '', caras: 'RF,FF,RTJ' }); }
            if (V.grupo === 'tubosAcero') { base.props = base.props || {}; if (!copiaDe) Object.assign(base.props, { cod: 'T', sistema: 'ASME', matGrupo: 'TUBO-ASME', espTabla: 'ASME' }); }
            if (V.grupo === 'tuberias') { base.props.base = base.props.base || (MATERIALES_BASE.has(V.subtipo) ? V.subtipo : 'Acero al carbono'); if (!copiaDe) base.nombre = base.props.base + ' '; }
            V.id = base.id; V.borrador = base; V.form = true; pintarLibreria();
        }
        let _clicLib = { id: null, t: 0 };
        function seleccionarItemLib(id) { const ahora = Date.now(), doble = libTodos() && _clicLib.id === id && ahora - _clicLib.t < 450; _clicLib = { id, t: ahora };   // la tabla se repinta en cada clic: el doble clic se detecta aquí
            let it = itemsLib(libVista.subtipo).find(i => i.id === id); if (!it && libTodos()) { it = itemsGrupoLib(libVista.grupo).find(i => i.id === id); if (it) libVista.subtipo = it.subtipo; } libVista.id = id; libVista.borrador = it ? JSON.parse(JSON.stringify(it)) : null; libVista.form = doble && !!it; pintarLibreria(); }
        function editarItemLib(id) { if (!libVista.borrador) return; libVista.form = true; pintarLibreria(); }
        function digitalizarCurvaLib() { leerFormLib(); abrirDigitalizador(filas => { const b = libVista && libVista.borrador; if (!b) return; b.props = b.props || {}; b.props.curva = textoDeCurva(filas); pintarLibreria(); }); }
        function leerFormLib() {
            const b = libVista.borrador; if (!b) return null;
            document.querySelectorAll('#lib-form [data-lib]').forEach(x => { const k = x.dataset.lib, v = x.value; if (k.startsWith('p.')) { b.props = b.props || {}; b.props[k.slice(2)] = v; } else b[k] = v; });
            return b;
        }
        function guardarItemLib() {
            const b = leerFormLib(); if (!b) return;
            if (!String(b.nombre || '').trim()) { alert('Indica el nombre del elemento.'); return; }
            b.nombre = b.nombre.trim(); libVista.ia = null;
            if (libVista.grupo === 'tuberias' && b.id !== 'mat:' + libVista.subtipo) {
                if (MATERIALES_BASE.has(b.nombre)) { alert('Ese nombre es el de un material del programa: usa otro (p. ej. «Acero al carbono SA-333 Gr. 6»).'); return; }
                if (LIB.items.some(i => i.grupo === 'tuberias' && i.nombre === b.nombre && i.id !== b.id)) { alert('Ya hay una tubería con ese nombre.'); return; }
            }
            if (esGrupoTablas(libVista.grupo) && accEnBD()) { guardarAccesorioBD(b); return; }
            if (libVista.grupo === 'bombas' && bombasEnBD()) { guardarBombaBD(b); return; }
            if (esGrupoTablas(libVista.grupo) && !prepararAccesorio(b)) return;
            const antes = LIB.items.find(i => i.id === b.id);
            if (antes && antes.grupo === 'tuberias' && antes.nombre !== b.nombre && elementosRed.some(e => e.material === antes.nombre)) { alert(`Hay tuberías del dibujo con «${antes.nombre}»: no se puede cambiar el nombre (crea una copia).`); return; }
            b.grupo = libVista.grupo; b.subtipo = b.subtipo || libVista.subtipo; b.fecha = new Date().toISOString();
            LIB.items = LIB.items.filter(i => i.id !== b.id).concat([JSON.parse(JSON.stringify(b))]);
            if (antes && antes.grupo === 'tuberias' && antes.nombre !== b.nombre) delete CAT.materiales[antes.nombre];
            guardarLib(); aplicarLibreria(); construirLibreria(); libVista.id = b.id; if (libTodos()) libVista.form = false; pintarLibreria();
            aviso(`Guardado en la librería: ${b.nombre}`, 'ok');
        }
        function prepararAccesorio(b) {
            b.grupo = libVista.grupo; b.subtipo = libVista.grupo === 'tubosAcero' ? 'tuberia' : (b.subtipo || libVista.subtipo); b.props = b.props || {}; if (libVista.grupo === 'tubosAcero' && !b.props.cod) b.props.cod = 'T';
            b.props.cod = String(b.props.cod || '').trim().toUpperCase().replace(/[^A-Z0-9.-]+/g, '');
            if (!b.props.cod) { alert('Indica el código del tipo (p. ej. C90LR): es el que aparece en la etiqueta del accesorio.'); return false; }
            const existe = LIB.items.some(i => i.id === b.id) || ACC_BASE.some(i => i.id === b.id);
            if (!existe) {
                let id = 'EMP-' + b.props.cod, n = 1; const usados = new Set(ACC_BASE.concat(LIB.items).map(i => i.id));
                while (usados.has(id)) id = 'EMP-' + b.props.cod + '-' + (++n);
                b.id = id;
            }
            return true;
        }
        async function guardarAccesorioBD(b) {
            if (!prepararAccesorio(b)) return;
            try {
                const nuevo = !ACC_BASE.some(i => i.id === b.id);
                const r = itemDeModeloAcc(await rpcUsuarios('piping_acc_modelo_guardar', { p_token: sesionActual().token, p_item: Object.assign(modeloDeItemAcc(b), nuevo ? { _nuevo: 'si' } : {}) }));
                ACC_BASE = ACC_BASE.filter(i => i.id !== r.id).concat([r]); indexarAccesorios();
                if (ACC_T) { const m = modeloDeItemAcc(r); m.origen = r.origen; ACC_T.modelos = ACC_T.modelos.filter(x => x.id !== r.id).concat([m]); }
                if (LIB.items.some(i => i.id === r.id)) { LIB.items = LIB.items.filter(i => i.id !== r.id); guardarLib(); }
                libVista.id = r.id; libVista.subtipo = r.subtipo; libVista.borrador = JSON.parse(JSON.stringify(r)); libVista.form = false; pintarLibreria(); renderizarVectorial();
                aviso(`Guardado en la base de datos: ${r.nombre}`, 'ok');
            } catch (e) { aviso(e.sinFuncion ? 'Falta ejecutar supabase/07_accesorios.sql.' : 'No se ha guardado: ' + e.message, 'error'); }
        }
        async function eliminarAccesorioBD(it) {
            const usados = elementosRed.filter(e => e.accModelo === it.id);
            if (!confirm(`¿Eliminar «${it.nombre}» de la base de datos? Dejará de verlo todo el mundo.${usados.length ? `\n\nLo usan ${usados.length} elemento(s) del dibujo: conservan sus datos.` : ''}`)) return;
            try { await rpcUsuarios('piping_acc_modelo_borrar', { p_token: sesionActual().token, p_id: it.id }); ACC_BASE = ACC_BASE.filter(i => i.id !== it.id); indexarAccesorios(); libVista.id = null; libVista.borrador = null; pintarLibreria(); aviso('Modelo eliminado de la base de datos.'); }
            catch (e) { aviso('No se ha eliminado: ' + e.message, 'error'); }
        }
        async function recuperarAccesoriosBD() {
            if (!confirm('¿Recuperar todos los modelos eliminados de la base de datos?')) return;
            try { const n = await rpcUsuarios('piping_acc_modelos_recuperar', { p_token: sesionActual().token }); await asegurarAccesorios(true); pintarLibreria(); aviso(`Recuperados: ${n}.`, 'ok'); } catch (e) { aviso(e.message, 'error'); }
        }
        function eliminarItemLib() {
            const V = libVista, it = V.borrador; if (!it) return;
            if (esGrupoTablas(V.grupo) && accEnBD() && ACC_BASE.some(i => i.id === it.id)) { eliminarAccesorioBD(it); return; }
            if (V.grupo === 'bombas' && bombasEnBD() && BOMBAS_BD.some(i => i.id === it.id)) { eliminarBombaBD(it); return; }
            const usados = elementosRed.filter(e => e.libItem === it.id || (V.grupo === 'tuberias' && e.material === it.nombre && !MATERIALES_BASE.has(it.nombre)));
            if (V.grupo === 'tuberias' && MATERIALES_BASE.has(it.nombre)) { alert('Los materiales del programa no se eliminan; puedes modificar su rugosidad y tensión admisible.'); return; }
            if (!confirm(`¿Eliminar «${it.nombre}» de la librería?${usados.length ? `\n\nLo usan ${usados.length} elemento(s) del dibujo: conservan sus datos.` : ''}`)) return;
            if (V.grupo === 'tuberias' && usados.length) { alert('Hay tuberías del dibujo con este material: cámbialas antes de eliminarlo.'); return; }
            LIB.items = LIB.items.filter(i => i.id !== it.id);
            if (it.origen === 'catálogo' || String(it.id).startsWith('cat:')) LIB.ocultos.push(it.id);
            if (V.grupo === 'tuberias') delete CAT.materiales[it.nombre];
            guardarLib(); aplicarLibreria(); construirLibreria(); V.id = null; V.borrador = null; pintarLibreria();
        }
        function restaurarOcultosLib() { if (!LIB.ocultos.length) return; if (!confirm(`¿Recuperar los ${LIB.ocultos.length} elementos del catálogo eliminados?`)) return; LIB.ocultos = []; guardarLib(); aplicarLibreria(); pintarLibreria(); }
        function pintarLibreria() {
            const V = libVista, G = GRUPOS_LIB[V.grupo], F = famLib(), subs = F ? F.subs : V.grupo === 'tuberias' && V.solo ? [V.subtipo] : subtiposGrupo(V.grupo), lista = libTodos() ? [] : itemsLib(V.subtipo);
            const b = V.borrador, admin = libTodos();
            document.getElementById('lib-titulo').innerHTML = `<i class="fa-solid fa-book text-blue-600 mr-1.5"></i>Librería · ${esc(G.titulo)}${F ? ' · ' + esc(F.titulo) : ''}`;
            let izq = subs.length > 1 ? `<select onchange="libVista.subtipo = this.value; libVista.id = null; libVista.borrador = null; pintarLibreria()" class="w-full border rounded p-1.5 mb-2">${subs.map(s => `<option value="${esc(s)}" ${s === V.subtipo ? 'selected' : ''}>${esc(nombreSubtipo(s))}</option>`).join('')}</select>` : `<p class="font-bold text-slate-600 mb-2">${esc(nombreSubtipo(V.subtipo))}</p>`;
            izq += `<div class="border rounded divide-y overflow-y-auto" style="max-height:52vh">${lista.map(i => `<button type="button" onclick="seleccionarItemLib('${esc(i.id)}')" class="block w-full text-left px-2 py-1 hover:bg-blue-50 ${i.id === V.id ? 'bg-amber-50' : ''}"><b>${esc(i.nombre)}</b><br><span class="text-[10px] text-slate-400">${esc([i.fabricante, i.material, i.pn].filter(Boolean).join(' · ') || (i.origen === 'catálogo' ? 'catálogo del programa' : 'usuario'))}</span></button>`).join('') || '<p class="p-2 text-slate-400 italic">Sin elementos: pulsa «Nuevo».</p>'}</div>`;
            izq += `<div class="flex flex-wrap gap-1 mt-2"><button onclick="nuevoItemLib()" class="px-2 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded"><i class="fa-solid fa-plus mr-1"></i>Nuevo</button><button onclick="if (libVista.borrador) nuevoItemLib(leerFormLib())" class="px-2 py-1 border rounded hover:bg-slate-50" ${b ? '' : 'disabled'}><i class="fa-solid fa-copy mr-1"></i>Copiar</button><button onclick="eliminarItemLib()" class="px-2 py-1 border rounded hover:bg-rose-50 text-rose-600" ${b ? '' : 'disabled'}><i class="fa-solid fa-trash-can mr-1"></i>Eliminar</button>${LIB.ocultos.length ? `<button onclick="restaurarOcultosLib()" class="px-2 py-1 border rounded hover:bg-slate-50 text-[10px]">Recuperar eliminados (${LIB.ocultos.length})</button>` : ''}</div>`;
            let der = '<p class="text-slate-400 italic mt-1 mb-2">Selecciona un elemento de la lista o de la tabla, o pulsa «Nuevo» (o «Copiar» para partir de uno existente).</p>';
            if (b) {
                const f = (k, et, v, extra = '') => `<label class="block"><span class="text-slate-500">${et}</span><input data-lib="${k}" value="${esc(v == null ? '' : v)}" class="w-full border rounded p-1 mt-0.5" ${extra}></label>`;
                const sel = (k, et, ops, v) => `<label class="block"><span class="text-slate-500">${et}</span><select data-lib="${k}" class="w-full border rounded p-1 mt-0.5">${(v && !ops.some(o => String(Array.isArray(o) ? o[0] : o) === String(v)) ? ops.concat([v]) : ops).map(o => { const [a, t] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(a)}" ${String(a) === String(v || '') ? 'selected' : ''}>${esc(t)}</option>`; }).join('')}</select></label>`;
                const stB = b.subtipo || V.subtipo;
                const grupoMat = V.grupo === 'tuberias' ? familiaMaterialTubo((b.props || {}).base || V.subtipo) : (stB === 'filtro' || stB === 'strainer' ? 'filtro' : G.mat);
                const matSel = `<label class="block"><span class="text-slate-500">Material ${grupoMat === 'plastico' ? '' : '(ASME / EN)'}</span><select data-lib="material" class="w-full border rounded p-1 mt-0.5" onchange="if (this.value === '__otro') { const t = prompt('Material:', ''); if (t) { const o = new Option(t, t, true, true); this.add(o, 0); } else this.value = ''; } const e = document.getElementById('lib-equiv'); if (e) e.textContent = equivalenteMaterial(this.value);">${opcionesMaterial(grupoMat, b.material || '')}</select><span id="lib-equiv" class="text-[10px] text-slate-400">${esc(equivalenteMaterial(b.material || ''))}</span></label>`;
                const esTub = V.grupo === 'tuberias', esBase = esTub && b.id === 'mat:' + V.subtipo;
                der = `${V.grupo === 'bombas' ? cabeceraIABomba(b) : ''}<div id="lib-form" class="grid ${admin ? 'grid-cols-4' : 'grid-cols-2'} gap-2">
                    ${admin ? `<label class="block col-span-2"><span class="text-slate-500">Tipo de accesorio *</span><select data-lib="subtipo" onchange="leerFormLib(); libVista.subtipo = this.value; pintarLibreria()" class="w-full border rounded p-1 mt-0.5">${subs.map(x => `<option value="${esc(x)}" ${x === stB ? 'selected' : ''}>${esc(nombreSubtipo(x))}</option>`).join('')}</select></label>` : ''}
                    ${f('nombre', esTub ? 'Nombre del tipo de tubería (aparece en Tuberías del panel derecho) *' : 'Nombre / modelo *', b.nombre, esBase ? 'readonly' : '')}
                    ${f('fabricante', 'Fabricante', b.fabricante)}${f('referencia', 'Referencia del fabricante', b.referencia)}
                    ${esGrupoTablas(V.grupo) ? '' : matSel}${f('norma', 'Norma (fabricación / dimensional)', b.norma)}
                    ${esTub || esGrupoTablas(V.grupo) ? '' : sel('pn', 'PN / Rating', [['', '—'], ...PN_LISTA], b.pn)}
                    <label class="block col-span-2"><span class="text-slate-500">URL (dónde se ha encontrado el componente)</span><div class="flex gap-1 mt-0.5"><input data-lib="url" value="${esc(b.url || '')}" placeholder="https://..." class="w-full border rounded p-1">${b.url ? `<a href="${esc(b.url)}" target="_blank" rel="noopener" class="px-2 py-1 border rounded text-blue-600" title="Abrir"><i class="fa-solid fa-arrow-up-right-from-square"></i></a>` : ''}</div></label>
                    ${(CAMPOS_LIB[V.grupo] || []).filter(c => !(esBase && (c[0] === 'base' || c[0] === 'codigo'))).filter(c => campoLibAplica(c[0], stB)).filter(c => !c[4] || (c[4] === 'vol') === (!!(b.props || {}).bombaTipo && (b.props || {}).bombaTipo !== 'centrifuga')).filter(c => !(V.grupo === 'intercambiadores' && /2$/.test(c[0]) && !(TIPOS[V.subtipo] || {}).circuitos)).map(([k, et, tipo, ops]) => {
                        const v = (b.props || {})[k];
                        if (tipo === 'crane') { const o = opcionesCrane(claveCrane({ subtype: stB })); return o.length ? sel('p.' + k, et, [['', '—'], ...o.map(x => x[0])], v) : ''; }
                        if (tipo === 'sel') return sel('p.' + k, et, [['', '—'], ...ops], v);
                        if (tipo === 'conex') return sel('p.' + k, et, [['', '—'], ...TIPOS_CONEXION], v);
                        if (tipo === 'dn') return sel('p.' + k, et, [['', '—'], ...LISTA_DN.map(d => [d, etiquetaDN(d)])], v);
                        if (tipo === 'base') return sel('p.' + k, et, [...MATERIALES_BASE].map(m => [m, m + ' (' + (CAT.materiales[m].norma || '') + ')']), v);
                        if (tipo === 'curva') return `<label class="block col-span-full"><span class="text-slate-500">${et}</span><div class="flex gap-2 mt-0.5 items-start"><textarea data-lib="p.${k}" rows="6" class="flex-1 border rounded p-1 font-mono" placeholder="0\t32\t0\t1,5&#10;10\t31,5\t45\t1,6&#10;20\t29,8\t68\t2,0&#10;30\t26,9\t74\t2,9">${esc(v || '')}</textarea><button type="button" onclick="digitalizarCurvaLib()" class="px-2 py-1.5 border border-blue-300 rounded text-blue-700 hover:bg-blue-50 whitespace-nowrap"><i class="fa-solid fa-crosshairs mr-1"></i>Digitalizar desde una imagen...</button></div></label>`;
                        return f('p.' + k, et, v, tipo === 'num' ? 'type="number" step="any"' : '');
                    }).join('')}
                    <label class="block col-span-full"><span class="text-slate-500">Notas</span><textarea data-lib="notas" rows="2" class="w-full border rounded p-1 mt-0.5">${esc(b.notas || '')}</textarea></label>
                    <p class="col-span-full text-[10px] text-slate-400">${b.origen === 'catálogo' ? 'Elemento del catálogo del programa: al guardar se crea tu versión modificada.' : 'Elemento de la librería del usuario.'} ${esTub ? 'Las tuberías nuevas heredan la tabla de tamaños y espesores del material base.' : 'Se elige al insertar el componente o en sus propiedades («Modelo de librería»).'}</p>
                    <div class="col-span-full flex justify-end ${esGrupoTablas(V.grupo) && !tienePermiso('compartido') ? 'hidden' : ''}"><button onclick="guardarItemLib()" class="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded font-medium"><i class="fa-solid fa-floppy-disk mr-1"></i>Guardar</button></div>
                </div>`;
            }
            // elementos existentes de este tipo, en la misma ventana (con cuántos hay en el proyecto)
            const todos = elementosRed.concat(elementosOtrasHojas());
            const usos = i => todos.filter(e => e.libItem === i.id || (V.grupo === 'tuberias' && e.type === 'tuberia' && e.material === i.nombre)).length;
            const tabla = `<div class="mt-3"><p class="font-bold text-slate-600 mb-1">Elementos existentes · ${esc(nombreSubtipo(V.subtipo))} (${lista.length})</p>
                <div class="border rounded overflow-auto" style="max-height:${b ? 26 : 56}vh"><table class="w-full text-[11px]"><thead class="bg-slate-100 sticky top-0"><tr class="text-left text-slate-500">
                <th class="px-1 py-1">Nombre / modelo</th><th class="px-1">Origen</th><th class="px-1">Fabricante</th><th class="px-1">Referencia</th><th class="px-1">Material</th><th class="px-1">Norma</th>${V.grupo === 'tuberias' ? '' : '<th class="px-1">PN / Rating</th>'}<th class="px-1 text-center">En el proyecto</th><th class="px-1">URL</th></tr></thead><tbody>
                ${lista.map(i => { const n = usos(i); return `<tr onclick="seleccionarItemLib('${esc(i.id)}')" class="border-t border-slate-100 cursor-pointer ${i.id === V.id ? 'bg-amber-50' : 'hover:bg-blue-50'}"><td class="px-1 py-0.5 font-bold">${esc(i.nombre)}</td><td class="px-1 text-slate-500">${esc(i.origen === 'catálogo' ? 'catálogo' : 'usuario')}</td><td class="px-1">${esc(i.fabricante || '')}</td><td class="px-1">${esc(i.referencia || '')}</td><td class="px-1">${esc(i.material || '')}</td><td class="px-1">${esc(i.norma || '')}</td>${V.grupo === 'tuberias' ? '' : `<td class="px-1">${esc(i.pn || '')}</td>`}<td class="px-1 text-center ${n ? 'font-bold text-emerald-700' : 'text-slate-300'}">${n}</td><td class="px-1">${i.url ? `<a href="${esc(i.url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" class="text-blue-600"><i class="fa-solid fa-arrow-up-right-from-square"></i></a>` : ''}</td></tr>`; }).join('') || '<tr><td colspan="9" class="p-2 text-slate-400 italic">Sin elementos de este tipo.</td></tr>'}
                </tbody></table></div></div>`;
            if (admin) {
                // administrador: arriba, todos los accesorios con todos sus datos; debajo, la ficha del marcado
                const edita = tienePermiso('compartido'), tab = V.tab || 'modelos';
                const tub = V.grupo === 'tubosAcero';
                const TABS = [['modelos', tub ? 'Tuberías' : V.grupo === 'bridas' ? 'Bridas' : F ? F.titulo : 'Accesorios'], ['medidas', 'Medidas nominales'], ['espesores', 'Espesores / schedule'], ['materiales', 'Materiales'], ...(tub ? [] : [['ratings', V.grupo === 'bridas' ? 'PN / Rating' : 'Clase (forjados B16.11)'], ['cotas', 'Cotas']])];
                const pest = `<div class="flex flex-wrap gap-1 mb-2 border-b">${TABS.map(([k, t]) => `<button onclick="libVista.tab = '${k}'; libVista.q = ''; pintarLibreria()" class="px-3 py-1.5 -mb-px border-b-2 ${k === tab ? 'border-blue-600 text-blue-700 font-bold' : 'border-transparent text-slate-500 hover:text-slate-700'}">${t}${ACC_T ? ` <span class="text-[10px] font-normal text-slate-400">${k === 'modelos' ? itemsGrupoLib(V.grupo).length : filasTablaAcc(k, V.grupo).length}</span>` : ''}</button>`).join('')}</div>`;
                const estado = `<p class="text-[10px] mb-2 ${ACC_ORIGEN === 'supabase' ? 'text-emerald-700' : 'text-amber-700'}"><i class="fa-solid ${ACC_ORIGEN === 'supabase' ? 'fa-database' : 'fa-hard-drive'} mr-1"></i>${ACC_ORIGEN === 'supabase' ? (accEnBD() ? 'Tablas leídas de la base de datos (Supabase): los modelos que guardes o elimines los ven todos los usuarios.' : 'Tablas leídas de la base de datos (Supabase).' + (edita ? ' Tu sesión no es de un administrador de Supabase: los modelos que cambies se guardan solo en este navegador.' : '')) : 'Tablas locales (datos/accesorios_tablas.js). Para usar la base de datos, ejecuta supabase/07_accesorios.sql.' + (edita ? ' Los modelos que cambies se guardan solo en este navegador.' : '')}</p>`;
                if (tab !== 'modelos') {
                    document.getElementById('lib-cuerpo').innerHTML = `${pest}${estado}<div class="flex gap-1 mb-2"><input value="${esc(V.q || '')}" oninput="libVista.q = this.value; pintarTablaAccDatos()" placeholder="Buscar..." class="border rounded p-1.5 flex-1"></div><div id="lib-tabla-datos"></div><p class="text-[10px] text-slate-400 mt-2">Tabla de consulta. Se edita en Supabase > Table Editor (tabla piping_acc_${tab}); la aplicación la vuelve a leer al abrirse.</p>`;
                    pintarTablaAccDatos(); return;
                }
                const barra = `${pest}<div class="flex flex-wrap items-center gap-1 mb-2">
                    <select onchange="libVista.filtroTipo = this.value; pintarTablaLibTodos()" class="border rounded p-1.5 ${subs.length > 1 ? '' : 'hidden'}"><option value="">Todos los tipos</option>${subs.map(x => `<option value="${esc(x)}" ${x === V.filtroTipo ? 'selected' : ''}>${esc(nombreSubtipo(x))}</option>`).join('')}</select>
                    <input value="${esc(V.q || '')}" oninput="libVista.q = this.value; pintarTablaLibTodos()" placeholder="Buscar: código, nombre, norma..." class="border rounded p-1.5 flex-1" style="min-width:160px">
                    ${edita ? `<button onclick="if (libVista.filtroTipo) libVista.subtipo = libVista.filtroTipo; nuevoItemLib()" class="px-2 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded"><i class="fa-solid fa-plus mr-1"></i>Nuevo</button>
                    <button onclick="if (libVista.borrador) nuevoItemLib(libVista.form ? leerFormLib() : libVista.borrador)" class="px-2 py-1.5 border rounded hover:bg-slate-50" ${b ? '' : 'disabled'} title="Crea un modelo nuevo con los datos del marcado"><i class="fa-solid fa-copy mr-1"></i>Nuevo a partir del marcado</button>
                    <button onclick="editarItemLib()" class="px-2 py-1.5 border rounded hover:bg-slate-50" ${b && !V.form ? '' : 'disabled'} title="Abre la ficha del marcado para modificarla (también con doble clic en la fila)"><i class="fa-solid fa-pen mr-1"></i>Editar</button>
                    <button onclick="eliminarItemLib()" class="px-2 py-1.5 border rounded hover:bg-rose-50 text-rose-600" ${b ? '' : 'disabled'}><i class="fa-solid fa-trash-can mr-1"></i>Eliminar</button>` : ''}
                    ${edita ? '' : `<button onclick="editarItemLib()" class="px-2 py-1.5 border rounded hover:bg-slate-50" ${b && !V.form ? '' : 'disabled'} title="Muestra la ficha del marcado (también con doble clic en la fila)"><i class="fa-solid fa-eye mr-1"></i>Ver ficha</button>`}
                    ${edita && LIB.ocultos.length ? `<button onclick="restaurarOcultosLib()" class="px-2 py-1.5 border rounded hover:bg-slate-50 text-[10px]">Recuperar eliminados (${LIB.ocultos.length})</button>` : ''}
                    ${accEnBD() ? '<button onclick="recuperarAccesoriosBD()" class="px-2 py-1.5 border rounded hover:bg-slate-50 text-[10px]">Recuperar eliminados de la base de datos</button>' : ''}</div>${estado}
                    <p class="text-[10px] text-slate-500 mb-2">${tub ? 'Aquí están los tipos de tubería de acero, uno por norma. La medida nominal, el schedule y el material (al carbono o inoxidable) se eligen al insertar cada tubería en el plano, y con ellos se forma su código (p. ej. TAC-2"-S40-SA106B). La tubería no tiene rating: su presión la da el espesor. Las tuberías de plástico siguen en Librerías > Tuberías.' : V.grupo === 'bridas' ? 'Aquí están los tipos de brida de acero, por norma (ASME B16.5, ASME B16.47 serie A y B, EN 1092-1). La medida nominal, el rating o PN, la cara, el material (al carbono o inoxidable) y, en las de cuello, el schedule se eligen al insertar cada brida en el plano, y con ellos se forma su código (p. ej. WN-2"-S40-SA105N-150#-RF).' : 'Aquí están los tipos de accesorio. La medida nominal, el schedule y el material se eligen al insertar cada accesorio en el plano, y con ellos se forma su código (p. ej. C90LR-2"-S40-WPB). Los accesorios para soldar a tope (ASME B16.9, EN 10253) no llevan rating; los forjados ASME B16.11 llevan clase: roscados 2000#, 3000#, 6000# y socket weld 3000#, 6000#, 9000# (p. ej. C90SW-1"-S80-SA105N-3000#).'}</p>`;
                document.getElementById('lib-cuerpo').innerHTML = `${barra}<div id="lib-tabla-todos"></div><div class="mt-3">${b && V.form ? `<p class="font-bold text-slate-600 mb-1">${LIB.items.some(i => i.id === b.id) || ACC_BASE.some(i => i.id === b.id) ? 'Editar' : 'Nuevo'} · ${esc(nombreSubtipo(b.subtipo || V.subtipo))}</p>${der}` : ''}</div>`;
                pintarTablaLibTodos(); return;
            }
            document.getElementById('lib-cuerpo').innerHTML = `<div class="grid gap-4" style="grid-template-columns: 250px 1fr"><div>${izq}</div><div>${der}${tabla}</div></div>`;
            marcarCamposIA();
        }
        // vista completa de un grupo: accesorios de tubería, para todos los roles (solo modifica quien tiene permiso)
        function libTodos() { return esGrupoTablas(libVista.grupo); }
        function itemsGrupoLib(g) { const F = g === 'accesorios' ? famLib() : null; return (F ? F.subs : subtiposGrupo(g)).flatMap(st => itemsLib(st)).filter(i => !F || !F.f || F.f(i)); }
        const MAX_FILAS_LIB = 500;
        function pintarTablaLibTodos() {
            const c = document.getElementById('lib-tabla-todos'); if (!c) return;
            const V = libVista, q = String(V.q || '').toLowerCase().trim().split(/\s+/).filter(Boolean), todos = elementosRed.concat(elementosOtrasHojas());
            const lista = (V.filtroTipo ? itemsLib(V.filtroTipo).filter(i => !famLib() || !famLib().f || famLib().f(i)) : itemsGrupoLib(V.grupo)).filter(i => { const p = i.props || {};
                return !q.length || (t => q.every(w => t.includes(w)))([i.id, p.cod, nombreSubtipo(i.subtipo), i.nombre, i.norma, p.variante, p.conexion, p.craneTipo, i.notas, i.fabricante].join(' ').toLowerCase()); })
                .sort((a, b) => ((a.props || {}).orden ?? 1e9) - ((b.props || {}).orden ?? 1e9) || String(a.nombre).localeCompare(String(b.nombre), 'es', { numeric: true }));
            const usos = {}; todos.forEach(e => { const k = e.accModelo || (e.type === 'tuberia' && /^TUB-/.test(tipoTubo(e)) ? tipoTubo(e) : null); if (k) usos[k] = (usos[k] || 0) + 1; });
            const td = (v, cls = '') => `<td class="px-1 ${cls}" style="overflow:hidden;text-overflow:ellipsis" title="${esc(v == null ? '' : v)}">${esc(v == null ? '' : v)}</td>`;
            const gm = Object.fromEntries(GRUPOS_MAT_ACC_LISTA);
            c.innerHTML = `<div class="border rounded overflow-auto" style="max-height:${V.borrador && V.form ? 32 : 62}vh"><table class="w-full text-[11px] whitespace-nowrap" style="table-layout:fixed"><colgroup>${[8, 8, 19, 9, 12, 9, 19, 14, 2].map(w => `<col style="width:${w}%">`).join('')}</colgroup><thead class="bg-slate-100 sticky top-0"><tr class="text-left text-slate-500">
                <th class="px-1 py-1" title="Código del tipo: es el que encabeza la etiqueta del accesorio">Código</th><th class="px-1">Tipo</th><th class="px-1">Nombre / modelo</th><th class="px-1">Norma</th><th class="px-1">Conexión</th><th class="px-1">Medidas</th><th class="px-1">${V.grupo === 'tubosAcero' ? 'Espesores' : V.grupo === 'bridas' ? 'PN / Rating' : 'Clase · Tipo (Crane)'}</th><th class="px-1">Materiales que admite</th><th class="px-1 text-center" title="Veces que se usa en el proyecto">Uso</th></tr></thead><tbody>
                ${lista.map(i => { const p = i.props || {}, n = usos[i.id] || 0; return `<tr onclick="seleccionarItemLib('${esc(i.id)}')" class="border-t border-slate-100 cursor-pointer ${i.id === V.id ? 'bg-amber-50' : 'hover:bg-blue-50'}">${td(p.cod, 'py-0.5 font-mono font-bold')}${td(nombreSubtipo(i.subtipo), 'text-slate-500')}${td(i.nombre, 'font-bold')}${td(i.norma)}${td(p.conexion)}${td(p.sistema === 'EN' ? 'EN (DN)' : 'ASME (pulgadas)')}${td(i.subtipo === 'tuberia' ? ({ ASME: 'ASME B36.10M / B36.19M', EN10220: 'EN 10220' }[p.espTabla] || p.espTabla) : (V.grupo === 'bridas' ? (p.ratings || 'todos') : [p.ratings && p.ratings !== 'NO' ? p.ratings : '', p.craneTipo || (p.k !== '' && p.k != null ? 'K ' + p.k : '')].filter(Boolean).join(' · ')))}${td(gm[p.matGrupo] || p.matGrupo)}<td class="px-1 text-center ${n ? 'font-bold text-emerald-700' : 'text-slate-300'}">${n}</td></tr>`; }).join('') || '<tr><td colspan="9" class="p-2 text-slate-400 italic">Sin modelos con ese filtro.</td></tr>'}
                </tbody></table></div>`;
        }
        // filas de una tabla de consulta que aplican a un grupo: tuberías de acero o accesorios
        function filasTablaAcc(tab, grupo) {
            const t = (ACC_T && ACC_T[tab]) || [], tub = grupo === 'tubosAcero', bri = grupo === 'bridas';
            if (tab === 'espesores') return t.filter(r => tub || bri ? ['B36.10', 'B36.19', 'EN10220'].includes(r.tabla) : r.tabla !== 'EN10220');
            if (tab === 'materiales') return t.filter(r => tub ? /^TUBO-/.test(r.grupo) : bri ? ['FORJ-ASME', 'BRIDA-ASME', 'BRIDA-EN'].includes(r.grupo) : !/^(TUBO|BRIDA)-/.test(r.grupo));
            if (tab === 'ratings') return t.filter(r => bri ? !/^(2000|3000|6000|9000)#$/.test(r.rating) : /^(2000|3000|6000|9000)#$/.test(r.rating));   // accesorios: solo las clases de los forjados B16.11
            if (tab === 'cotas') return t.filter(r => { const m = ACC_BASE.find(i => i.id === r.modelo); return bri ? !!m && m.grupo === 'bridas' : !m || m.grupo !== 'bridas'; });
            return t;
        }
        // tablas de consulta: medidas, espesores, materiales, rating / PN y cotas
        function pintarTablaAccDatos() {
            const c = document.getElementById('lib-tabla-datos'); if (!c || !ACC_T) return;
            const V = libVista, tab = V.tab, q = String(V.q || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
            const DEF = {
                medidas: [['Medidas', r => r.sistema === 'EN' ? 'EN (DN)' : 'ASME (pulgadas)'], ['NPS', r => r.nps], ['DN', r => r.dn], ['Diámetro exterior (mm)', r => r.od]],
                espesores: [['Tabla', r => ({ 'B36.10': 'ASME B36.10M', 'B36.19': 'ASME B36.19M', EN10220: 'EN 10220', EN1: 'EN 10253-1', EN2: 'EN 10253-2' }[r.tabla] || r.tabla)], ['Familia', r => r.familia], ['DN', r => r.dn], ['NPS', r => { const n = npsDeDN('DN ' + r.dn); return /^B36/.test(r.tabla) && n ? pulgadas(n) + '"' : ''; }], ['Schedule / serie', r => r.schedule], ['Espesor (mm)', r => r.espesor]],
                materiales: [['Código', r => r.codigo], ['Designación', r => r.designacion], ['Familia', r => r.familia], ['Para', r => (GRUPOS_MAT_ACC_LISTA.find(g => g[0] === r.grupo) || [0, r.grupo])[1]], ['Norma', r => r.norma], ['Equivalente', r => r.equivalente]],
                ratings: [['PN / Rating', r => r.rating], ['Sistema', r => r.sistema], ['Notas', r => r.notas]],
                cotas: [['Modelo', r => { const m = ACC_BASE.find(i => i.id === r.modelo); return m ? m.nombre + ' · ' + m.norma : r.modelo; }], ['DN', r => r.dn], ['DN menor', r => r.dn2 || ''], ['Rating', r => r.rating], ['Cotas (mm)', r => r.cotas], ['θ (°)', r => r.theta == null ? '' : r.theta]]
            }[tab] || [];
            const filas = filasTablaAcc(tab, V.grupo).map(r => DEF.map(d => d[1](r))).filter(f => !q.length || q.every(w => f.join(' ').toLowerCase().includes(w)));
            const ver = filas.slice(0, MAX_FILAS_LIB);
            c.innerHTML = `<div class="border rounded overflow-auto" style="max-height:60vh"><table class="w-full text-[11px]"><thead class="bg-slate-100 sticky top-0"><tr class="text-left text-slate-500">${DEF.map(d => `<th class="px-2 py-1">${d[0]}</th>`).join('')}</tr></thead><tbody>${ver.map(f => `<tr class="border-t border-slate-100">${f.map((v, k) => `<td class="px-2 py-0.5 ${k === 0 ? 'font-bold' : ''}">${esc(v == null ? '' : v)}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${DEF.length}" class="p-2 text-slate-400 italic">Sin datos.</td></tr>`}</tbody></table></div>${filas.length > ver.length ? `<p class="text-[10px] text-amber-700 mt-1">Se muestran ${ver.length} de ${filas.length}: usa el buscador.</p>` : ''}`;
        }
        // equivalente ASME ↔ EN de un material según la ayuda de equivalencias (texto orientativo bajo el desplegable)
        function equivalenteMaterial(m) {
            m = String(m || ''); if (!m) return '';
            const limpio = x => x.replace(/\s*\(.*$/, '').replace(/\s*\/\s*/g, '/').trim(), k = limpio(m);
            const out = [];
            EQUIVALENCIAS.forEach(([, g]) => g.forEach(([asme, ens]) => {
                const asmes = limpio(asme).split('/').map((x, n, a) => n ? x.replace(/^(?!SA-|ASTM)/, a[0].replace(/\w+$/, '')) : x).map(x => x.trim());
                if (asmes.includes(k)) ens.forEach(([norma, gr]) => out.push(`${norma}: ${gr.join(', ')}`));
                else ens.forEach(([norma, gr]) => { if (gr.some(x => limpio(x) === k)) out.push(asme); });
            }));
            return out.length ? 'Equivalente: ' + [...new Set(out)].join(' · ') : '';
        }
        function exportarLibreria() { descargarArchivo(JSON.stringify({ tipo: 'piping-libreria', version: 1, fecha: new Date().toISOString(), ...LIB }, null, 2), `libreria_PIPING_${new Date().toISOString().slice(0, 10)}.json`, 'application/json'); }
        async function importarLibreria() {
            const f = await elegirArchivo('.json'); if (!f) return;
            try {
                const d = JSON.parse(await f.text()); if (!Array.isArray(d.items)) throw new Error('no es una librería de PIPING');
                const ids = new Set(d.items.map(i => i.id));
                LIB.items = LIB.items.filter(i => !ids.has(i.id)).concat(d.items); LIB.ocultos = [...new Set([...LIB.ocultos, ...(d.ocultos || [])])];
                guardarLib(); aplicarLibreria(); construirLibreria(); aviso(`Librería importada: ${d.items.length} elementos.`, 'ok');
            } catch (e) { alert('No se ha podido importar: ' + e.message); }
        }
        // submenús de Librerías
        // ---------- Ayuda > Equivalencias: materiales ASME ↔ norma europea (tabla facilitada por José) ----------
        const EQUIVALENCIAS = [
            ['Material para tuberías de acero al carbono', [
                ['SA-53 Gr.B', [['EN 10216-1', ['P235TR2', 'P265TR2']], ['EN 10217-1', ['P235TR1', 'P235TR2', 'P265TR1', 'P265TR2']], ['EN 10217-2', ['P235GH']]]],
                ['SA-106 Gr.B', [['EN 10216-2', ['P235GH', 'P265GH']]]],
                ['SA-333 Gr.6', [['EN 10216-4', ['P275NL1', 'P355NL1', 'P355NL2']]]],
                ['SA-671', [['EN 10217-6', ['P275NL1', 'P275NL2', 'P355NL1', 'P355NL2']]]],
                ['SA-672', [['EN 10217-5', ['P235GH', 'P265GH', 'P295GH']]]]]],
            ['Material para tuberías de acero inoxidable', [
                ['SA-312 Gr.Tp304', [['EN 10216-5', ['X5CrNi18-10/1.4301']]]],
                ['SA-312 Gr.Tp304L', [['EN 10216-5', ['X2CrNi19-11/1.4306']]]],
                ['SA-312 Gr.Tp316', [['EN 10216-5', ['X5CrNiMo17-12-2/1.4401']]]],
                ['SA-312 Gr.Tp316L', [['EN 10216-5', ['X2CrNiMo17-12-2/1.4404']]]],
                ['SA-312 Gr.Tp321', [['EN 10216-5', ['X6CrNiTi18-10/1.4541']]]],
                ['SA-312 Gr.Tp321H', [['EN 10216-5', ['X7CrNiTi18-10/1.4940']]]],
                ['SA-312 Gr.Tp347', [['EN 10216-5', ['X6CrNiNb18-10/1.4550']]]],
                ['SA-312 Gr.Tp347H', [['EN 10216-5', ['X7CrNiNb18-10/1.4912']]]],
                ['SA-358', [['EN 10217-7', ['X5CrNi18-10', 'X2CrNiMo17-12-2']]]]]],
            ['Material para bridas y forjados de acero al carbono', [
                ['SA-105N (forjado al carbono, normalizado)', [['EN 10222-2', ['P250GH', 'P280GH', 'P305GH']], ['EN 1092-1', ['P250GH / 1.0460', 'P265GH / 1.0425 (normalizado)']]]],
                ['SA-350 Gr.LF2 (baja temperatura, normalizado)', [['EN 10222-3', ['P275NL1 / 1.0488', 'P355NL1 / 1.0566']], ['EN 1092-1', ['P275NL2 / 1.1104', 'P355NL2 / 1.1106 (con ensayo de impacto)']]]],
                ['SA-181 Cl.60 / Cl.70 (uso general / menor exigencia)', [['EN 10222-2', ['P245GH']], ['EN 1092-1', ['P245GH']]]],
                ['SA-216 Gr.WCB (fundición)', [['EN 10213', ['GP240GH / 1.0619']]]]]],
            ['Material para bridas y forjados de acero inoxidable', [
                ['SA-182 Gr.F304 / F304L', [['EN 10222-5', ['X5CrNi18-10 / 1.4301', 'X2CrNi19-11 / 1.4306']], ['EN 1092-1', ['—']]]],
                ['SA-182 Gr.F316 / F316L', [['EN 10222-5', ['X5CrNiMo17-12-2 / 1.4401', 'X2CrNiMo17-12-2 / 1.4404']], ['EN 1092-1', ['—']]]],
                ['SA-182 Gr.F321 / F321H', [['EN 10222-5', ['X6CrNiTi18-10 / 1.4541']], ['EN 1092-1', ['—']]]],
                ['SA-182 Gr.F347 / F347H', [['EN 10222-5', ['X6CrNiNb18-10 / 1.4550']], ['EN 1092-1', ['—']]]],
                ['SA-351 Gr.CF8 / CF8M (fundición para válvulas / bridas)', [['EN 10213', ['GX5CrNi19-10 / 1.4308', 'GX5CrNiMo19-11-2 / 1.4408']]]]]],
            ['Material para codos, tes, cruces y reducciones de acero al carbono (accesorios para soldar)', [
                ['SA-234 Gr.WPB (uso general / temperatura moderada)', [['EN 10253-2', ['P235GH / 1.0345', 'P265GH / 1.0425']]]],
                ['SA-420 Gr.WPL6 (servicio a baja temperatura)', [['EN 10253-2', ['P275NL1 / 1.0488', 'P355NL1 / 1.0566', 'P275NL2 / 1.1104', 'P355NL2 / 1.1106 (con ensayo de impacto)']]]],
                ['SA-234 Gr.WPC (mayor resistencia mecánica)', [['EN 10253-2', ['P355NH / 1.0565']]]]]],
            ['Material para bombas', [
                ['ASTM A48 Cl.30B / 35B (fundición gris)', [['EN 1561', ['EN-GJL-250']]]],
                ['ASTM A536 65-45-12 (fundición dúctil)', [['EN 1563', ['EN-GJS-400-15']]]],
                ['ASTM A216 Gr.WCB (carcasa fundida) / SA-105 (forjado)', [['EN 10213', ['GP240GH / 1.0619']]]],
                ['ASTM A351 Gr.CF8M (AISI 316 fundido) / CF8 (AISI 304 fundido)', [['EN 10213', ['GX5CrNiMo19-11-2 / 1.4408', 'GX5CrNi19-10 / 1.4308']]]],
                ['ASTM A890 / A995 Gr.4A, 5A, 6A (dúplex y superdúplex)', [['EN 10213 / EN 10283', ['1.4462', '1.4410']]]],
                ['Bronce y aleaciones especiales (impulsores y cuerpos en agua de mar; ácidos muy corrosivos)', [['—', ['Bronce (EN 1982)', 'Alto níquel (Hastelloy, Inconel)', 'Titanio']]]]]],
            ['Material para codos, tes, cruces y reducciones de acero inoxidable (accesorios para soldar)', [
                ['SA-403 Gr.WP304 / WP304L', [['EN 10253-3 / EN 10253-4', ['X5CrNi18-10 / 1.4301', 'X2CrNi19-11 / 1.4306']]]],
                ['SA-403 Gr.WP316 / WP316L', [['EN 10253-3 / EN 10253-4', ['X5CrNiMo17-12-2 / 1.4401', 'X2CrNiMo17-12-2 / 1.4404']]]],
                ['SA-403 Gr.WP321 / WP321H', [['EN 10253-3 / EN 10253-4', ['X6CrNiTi18-10 / 1.4541']]]],
                ['SA-403 Gr.WP347 / WP347H', [['EN 10253-3 / EN 10253-4', ['X6CrNiNb18-10 / 1.4550']]]]]]
        ];
        function mostrarEquivalencias() {
            cerrarMenus();
            const filas = g => g.map(([asme, ens]) => ens.map(([norma, grados], k) => `<tr class="border-t border-slate-100 align-top">${k === 0 ? `<td rowspan="${ens.length}" class="py-1 pr-3 font-bold text-slate-700 whitespace-nowrap">${esc(asme)}</td>` : ''}<td class="py-1 pr-3 whitespace-nowrap text-blue-700">${esc(norma)}</td><td class="py-1">${grados.map(esc).join('<br>')}</td></tr>`).join('')).join('');
            document.getElementById('red-content').innerHTML = `<p class="text-[11px] text-slate-500 mb-2">Equivalencias orientativas entre materiales ASME y norma europea. Comprueba siempre la especificación del proyecto y los requisitos de cada norma (composición, ensayos, temperatura de diseño). P355GH no figura: es un acero de chapa (EN 10028-2), no de tubo ni de accesorio; para SA-234 Gr.WPC se toma P355NH (EN 10253-2). Las tes, cruces y reducciones tienen las mismas equivalencias que los codos.</p>` +
                EQUIVALENCIAS.map(([tit, g]) => `<h4 class="font-bold text-slate-600 uppercase text-[11px] mt-3 mb-1">${esc(tit)}</h4><table class="w-full text-[11px]"><thead><tr class="text-left text-slate-500"><th class="py-1">ASME</th><th>Norma europea</th><th>Designación</th></tr></thead><tbody>${filas(g)}</tbody></table>`).join('');
            document.getElementById('red-footer').innerHTML = '<button onclick="cerrarModalRed()" class="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded font-medium">Cerrar</button>';
            document.querySelector('#modal-red h3 span').innerHTML = '<i class="fa-solid fa-right-left text-blue-600 mr-1.5"></i> Equivalencia ASME / Norma europea';
            document.getElementById('modal-red').style.display = 'flex';
        }
        function menuLibreria() {
            const it = (g, st, t) => ({ icono: 'fa-circle', texto: t || nombreSubtipo(st), accion: () => abrirLibreria(g, st) });
            const porGrupo = g => subtiposGrupo(g).map(st => it(g, st));
            return [
                { icono: 'fa-shapes', texto: 'Accesorios', sub: () => [
                    { icono: 'fa-ring', texto: 'Bridas...', accion: () => abrirLibreria('bridas') },
                    { icono: 'fa-grip-lines', texto: 'Codos...', accion: () => abrirLibreria('accesorios', null, 'codos') },
                    { icono: 'fa-circle', texto: 'Machones...', accion: () => abrirLibreria('uniones', 'machon') },
                    { icono: 'fa-grip-lines', texto: 'Cruces...', accion: () => abrirLibreria('accesorios', null, 'cruces') },
                    { icono: 'fa-circle', texto: 'Manguitos de unión...', accion: () => abrirLibreria('accesorios', null, 'manguitos') },
                    { icono: 'fa-circle', texto: 'Racord...', accion: () => abrirLibreria('uniones', 'racor') },
                    { icono: 'fa-grip-lines', texto: 'Reducciones concéntricas...', accion: () => abrirLibreria('accesorios', null, 'redconc') },
                    { icono: 'fa-grip-lines', texto: 'Reducciones excéntricas...', accion: () => abrirLibreria('accesorios', null, 'redexc') },
                    { icono: 'fa-grip-lines', texto: 'Tes...', accion: () => abrirLibreria('accesorios', null, 'tes') },
                    { icono: 'fa-circle', texto: 'Tuercas de unión...', accion: () => abrirLibreria('uniones', 'tuerca') }].sort((x, y) => x.texto.localeCompare(y.texto, 'es')) },
                { icono: 'fa-fan', texto: 'Bombas...', accion: () => abrirLibreria('bombas', 'bomba') },
                { icono: 'fa-industry', texto: 'Equipos', sub: () => porGrupo('equipos') },
                { icono: 'fa-arrows-left-right-to-line', texto: 'Filtros, injertos, juntas y manguitos...', accion: () => abrirLibreria('compensadores') },
                { icono: 'fa-gauge', texto: 'Instrumentos', sub: () => porGrupo('instrumentos') },
                { icono: 'fa-fire-flame-simple', texto: 'Intercambiadores...', accion: () => abrirLibreria('intercambiadores') },
                { icono: 'fa-database', texto: 'Tanques y depósitos...', accion: () => abrirLibreria('tanques') },
                { icono: 'fa-grip-lines', texto: 'Tuberías', sub: () => [{ icono: 'fa-grip-lines', texto: 'Acero ASME / EN...', accion: () => abrirLibreria('tubosAcero', 'tuberia') }, ...subtiposGrupo('tuberias').filter(m => m !== 'Acero al carbono' && m !== 'Acero inoxidable').map(m => it('tuberias', m, m.replace(/ \(Dint ref\. Sch 40\)/, '')))].sort((x, y) => x.texto.localeCompare(y.texto, 'es')) },
                { icono: 'fa-circle-half-stroke', texto: 'Válvulas', sub: () => porGrupo('valvulas') },
                'sep',
                { icono: 'fa-shapes', texto: 'Mostrar accesorios en el panel', accion: () => mostrarLibreriaAccesorios() },
                { icono: 'fa-file-export', texto: 'Exportar librería (*.json)', accion: () => exportarLibreria() },
                { icono: 'fa-file-import', texto: 'Importar librería (*.json)...', accion: () => importarLibreria() }
            ];
        }

        // ==================================================================================
        // TABLAS (Tabla > Añadir tabla): anotación con filas y columnas, texto por celda y ancho/alto
        // editables. Van a la capa Text del DXF.
        // ==================================================================================
        async function anadirTabla() {
            if (!proyectoDefinido()) { pantallaInicio(); return; }
            const r = await dialogo('<i class="fa-solid fa-table text-blue-600 mr-1.5"></i>Añadir tabla',
                `<div class="grid grid-cols-2 gap-2"><label>Filas<input id="tb-filas" type="number" min="1" max="60" value="4" class="w-full border rounded p-1.5"></label><label>Columnas<input id="tb-cols" type="number" min="1" max="20" value="3" class="w-full border rounded p-1.5"></label>
                 <label>Ancho de columna (mm)<input id="tb-ancho" type="number" step="any" value="30" class="w-full border rounded p-1.5"></label><label>Alto de fila (mm)<input id="tb-alto" type="number" step="any" value="6" class="w-full border rounded p-1.5"></label>
                 <label class="col-span-2 flex items-center gap-1.5"><input id="tb-cab" type="checkbox" checked> Primera fila como cabecera (negrita)</label></div>`,
                [{ texto: 'Insertar', valor: 'ok', clase: 'bg-blue-600 hover:bg-blue-700 text-white' }, { texto: 'Cancelar', valor: null }]);
            if (r !== 'ok') return;
            const v = id => parseFloat(document.getElementById(id).value);
            const nf = Math.max(1, Math.min(60, Math.round(v('tb-filas')) || 1)), nc = Math.max(1, Math.min(20, Math.round(v('tb-cols')) || 1));
            const an = v('tb-ancho') > 0 ? v('tb-ancho') : 30, al = v('tb-alto') > 0 ? v('tb-alto') : 6;
            guardarEstado();
            const c = centroVista();
            const el = { id: 'sym_' + Date.now(), type: 'anotacion', subtype: 'tabla', x: c.x - nc * an * PX_MM / 2, y: c.y + nf * al * PX_MM / 2, scale: 1, rotation: 0, name: '',
                anchos: Array(nc).fill(an), altos: Array(nf).fill(al), celdas: Array.from({ length: nf }, () => Array(nc).fill('')), tamTextoMm: 2.5, cabecera: document.getElementById('tb-cab').checked };
            elementosRed.push(el); asignarNumero(el);
            document.getElementById('empty-state')?.remove();
            seleccionarElemento(el.id); abrirVentanaElemento(el.id);
        }
        function dibujoTabla(el, c, P) {
            const A = (el.anchos || []).map(w => w * PX_MM), H = (el.altos || []).map(w => w * PX_MM), W = A.reduce((s, x) => s + x, 0), T = H.reduce((s, x) => s + x, 0), fs = (+el.tamTextoMm || 2.5) * PX_MM;
            let h = `<rect x="0" y="0" width="${W.toFixed(2)}" height="${T.toFixed(2)}" fill="${P.relleno}" fill-opacity="0.001" stroke="${c}" stroke-width="0.9"/>`;
            let y = 0; H.forEach((hh, i) => { if (i) h += `<line x1="0" y1="${y.toFixed(2)}" x2="${W.toFixed(2)}" y2="${y.toFixed(2)}" stroke="${c}" stroke-width="${i === 1 && el.cabecera ? 0.8 : 0.45}"/>`; y += hh; });
            let x = 0; A.forEach((w, j) => { if (j) h += `<line x1="${x.toFixed(2)}" y1="0" x2="${x.toFixed(2)}" y2="${T.toFixed(2)}" stroke="${c}" stroke-width="0.45"/>`; x += w; });
            y = 0;
            H.forEach((hh, i) => {
                x = 0;
                A.forEach((w, j) => {
                    const t = ((el.celdas || [])[i] || [])[j];
                    if (t) { const al = ((el.alinear || [])[j]) || 'start', tx = al === 'middle' ? x + w / 2 : al === 'end' ? x + w - PX_MM : x + PX_MM;
                        h += `<text x="${tx.toFixed(2)}" y="${(y + hh / 2 + fs * 0.35).toFixed(2)}" font-family="sans-serif" font-size="${fs.toFixed(2)}" ${i === 0 && el.cabecera ? 'font-weight="bold"' : ''} text-anchor="${al}" fill="${c}">${esc(t)}</text>`; }
                    x += w;
                });
                y += hh;
            });
            return h;
        }
        // Editor de la tabla (en la ventana flotante)
        window.__tabla = (accion, a, b, v) => {
            const el = elementosRed.find(e => e.id === ventanaId); if (!el) return;
            guardarEstado();
            const nf = el.altos.length, nc = el.anchos.length;
            if (accion === 'celda') { el.celdas[a][b] = v; }
            else if (accion === 'ancho') { if (+v > 0) el.anchos[a] = +v; }
            else if (accion === 'alto') { if (+v > 0) el.altos[a] = +v; }
            else if (accion === 'celdaTam') { const [w, hh] = String(v).split('x').map(Number); if (w > 0) el.anchos[b] = w; if (hh > 0) el.altos[a] = hh; }
            else if (accion === 'fila+') { el.altos.splice(a + 1, 0, el.altos[a] || 6); el.celdas.splice(a + 1, 0, Array(nc).fill('')); }
            else if (accion === 'fila-') { if (nf > 1) { el.altos.splice(a, 1); el.celdas.splice(a, 1); } }
            else if (accion === 'col+') { el.anchos.splice(a + 1, 0, el.anchos[a] || 30); el.celdas.forEach(f => f.splice(a + 1, 0, '')); (el.alinear = el.alinear || []).splice(a + 1, 0, 'start'); }
            else if (accion === 'col-') { if (nc > 1) { el.anchos.splice(a, 1); el.celdas.forEach(f => f.splice(a, 1)); if (el.alinear) el.alinear.splice(a, 1); } }
            else if (accion === 'alinear') { el.alinear = el.alinear || Array(nc).fill('start'); el.alinear[a] = v; }
            else if (accion === 'tam') { if (+v > 0) el.tamTextoMm = +v; }
            else if (accion === 'cabecera') { el.cabecera = !!v; }
            renderizarVectorial(); if (accion !== 'celda') pintarVentana();
        };
        function editorTabla(el) {
            const nc = el.anchos.length;
            let h = `<div class="flex flex-wrap gap-2 items-end"><label>Texto (mm)<input type="number" step="0.1" value="${el.tamTextoMm || 2.5}" onchange="__tabla('tam', 0, 0, this.value)" class="border rounded p-1 w-16 ml-1"></label>
                <label class="flex items-center gap-1"><input type="checkbox" ${el.cabecera ? 'checked' : ''} onchange="__tabla('cabecera', 0, 0, this.checked)"> Cabecera en negrita</label>
                <span class="text-[10px] text-slate-400">Capa DXF: Text</span></div>`;
            h += `<div class="overflow-auto border rounded mt-1" style="max-height:46vh"><table class="text-[11px]"><thead><tr><th></th>${el.anchos.map((w, j) => `<th class="p-0.5 align-bottom"><div class="flex gap-0.5 justify-center"><button title="Insertar columna a la derecha" onclick="__tabla('col+', ${j})" class="px-1 border rounded">+</button><button title="Eliminar columna" onclick="__tabla('col-', ${j})" class="px-1 border rounded text-rose-600">−</button></div>
                <input type="number" step="any" value="${w}" title="Ancho de la columna (mm)" onchange="__tabla('ancho', ${j}, 0, this.value)" class="border rounded p-0.5 w-16 mt-0.5"> <select onchange="__tabla('alinear', ${j}, 0, this.value)" class="border rounded text-[10px]">${[['start', '⟸'], ['middle', '≡'], ['end', '⟹']].map(([a, t]) => `<option value="${a}" ${((el.alinear || [])[j] || 'start') === a ? 'selected' : ''}>${t}</option>`).join('')}</select></th>`).join('')}</tr></thead><tbody>`;
            el.altos.forEach((hh, i) => {
                h += `<tr><td class="p-0.5 whitespace-nowrap"><input type="number" step="any" value="${hh}" title="Alto de la fila (mm)" onchange="__tabla('alto', ${i}, 0, this.value)" class="border rounded p-0.5 w-14"><button title="Insertar fila debajo" onclick="__tabla('fila+', ${i})" class="px-1 border rounded ml-0.5">+</button><button title="Eliminar fila" onclick="__tabla('fila-', ${i})" class="px-1 border rounded text-rose-600">−</button></td>` +
                    el.anchos.map((w, j) => `<td class="p-0.5"><input value="${esc((el.celdas[i] || [])[j] || '')}" oninput="__tabla('celda', ${i}, ${j}, this.value)" onfocus="document.getElementById('tb-celda-sel').innerHTML = 'Celda ${i + 1}·${j + 1}: <input value=&quot;${el.anchos[j]}x${hh}&quot; title=&quot;ancho x alto (mm)&quot; onchange=&quot;__tabla(\\'celdaTam\\', ${i}, ${j}, this.value)&quot; class=&quot;border rounded p-0.5 w-24&quot;> mm (ancho x alto)'" class="border rounded p-0.5" style="width:${Math.max(60, Math.min(160, w * 3))}px"></td>`).join('') + '</tr>';
            });
            h += `</tbody></table></div><div id="tb-celda-sel" class="text-[11px] text-slate-500 mt-1">Haz clic en una celda para cambiar su ancho y alto.</div>`;
            return h;
        }
        // Al pasar el ratón por encima de una tabla aparece el botón de sus propiedades
        let temporizadorBotonTabla = null;
        function mostrarBotonTabla(el, g) {
            const b = document.getElementById('btn-tabla'); if (!b) return;
            clearTimeout(temporizadorBotonTabla);
            const r = g.getBoundingClientRect();
            Object.assign(b.style, { display: 'block', left: Math.min(window.innerWidth - 150, r.right - 4) + 'px', top: Math.max(4, r.top - 26) + 'px' });
            b.onclick = () => { b.style.display = 'none'; seleccionarElemento(el.id); abrirVentanaElemento(el.id, r.right, r.top); };
        }
        function ocultarBotonTabla() { clearTimeout(temporizadorBotonTabla); temporizadorBotonTabla = setTimeout(() => { const b = document.getElementById('btn-tabla'); if (b && !b.matches(':hover')) b.style.display = 'none'; }, 900); }

        // ==================================================================================
        // 1) TRAZADO DE TUBERÍAS (Insertar > Trazar tubería, tecla T)
        // Clic en el punto inicial (o en un puerto libre), clic en cada cambio de dirección (tramos
        // ortogonales) y doble clic, Intro o clic en un puerto libre para terminar. Cada tramo es una
        // tubería y cada cambio de dirección un codo de 90°. Esc cancela; Retroceso quita el último punto.
        // ==================================================================================
        let traza = null;
        const OFF_CODO = 20; // px del vértice del codo 90° a cada uno de sus puertos (símbolo de 50×50)
        function iniciarTrazado() {
            ultimaOrden = { tipo: 'trazar' };
            if (!proyectoDefinido()) { pantallaInicio(); return; }
            cerrarMenus(); ocultarTooltip();
            traza = { puntos: [], inicio: null, raton: null };
            canvasContainer.style.cursor = 'crosshair';
            aviso('Trazar tubería: clic en el inicio (o en un puerto libre), clic en cada cambio de dirección; doble clic, Intro o clic en un puerto libre para terminar · Esc cancela · Retroceso quita el último punto.');
        }
        function cancelarTrazado() { traza = null; canvasContainer.style.cursor = 'default'; document.getElementById('traza')?.remove(); }
        const puntoHoja = e => { const r = marcoA3.getBoundingClientRect(); return { x: (e.clientX - r.left) / zoomScale, y: (e.clientY - r.top) / zoomScale }; };
        // Punto de trazado: puerto libre cercano, o tramo ortogonal desde el punto anterior (con rejilla)
        function puntoTraza(p) {
            const port = puertoLibreCercano(p.x, p.y, null);
            if (port && port.d < 14) return { x: port.x, y: port.y, puerto: port };
            let q = { x: p.x, y: p.y };
            if (opciones.rejilla) { const g = pasoRejillaPx(), fr = marcoInterior(); q = { x: fr.x0 + Math.round((q.x - fr.x0) / g) * g, y: fr.y1 - Math.round((fr.y1 - q.y) / g) * g }; }
            const ult = traza.puntos[traza.puntos.length - 1];
            if (ult) {
                // primer tramo desde un puerto: en la dirección de ese puerto
                if (traza.puntos.length === 1 && traza.inicio) { const d = (dirPuertoLocal(traza.inicio.el, traza.inicio.id) + (traza.inicio.el.rotation || 0)) % 180; if (d === 0) q.y = ult.y; else q.x = ult.x; }
                else if (Math.abs(q.x - ult.x) >= Math.abs(q.y - ult.y)) q.y = ult.y; else q.x = ult.x;
            }
            return q;
        }
        function pintarTraza() {
            document.getElementById('traza')?.remove();
            if (!traza) return;
            const pts = traza.puntos.slice(); if (traza.raton) pts.push(traza.raton);
            const g = document.createElementNS('http://www.w3.org/2000/svg', 'g'); g.setAttribute('id', 'traza'); g.setAttribute('pointer-events', 'none');
            let h = pts.length > 1 ? `<polyline points="${pts.map(p => p.x.toFixed(1) + ',' + p.y.toFixed(1)).join(' ')}" fill="none" stroke="#f59e0b" stroke-width="2.2" stroke-dasharray="6,3"/>` : '';
            pts.forEach(p => { h += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${p.puerto ? 5 : 2.5}" fill="${p.puerto ? 'rgba(245,158,11,.3)' : '#f59e0b'}" stroke="#f59e0b"/>`; });
            if (pts.length > 1) { const a = pts[pts.length - 2], b = pts[pts.length - 1], L = Math.hypot(b.x - a.x, b.y - a.y) * 30;
                h += `<text x="${((a.x + b.x) / 2 + 6).toFixed(1)}" y="${((a.y + b.y) / 2 - 6).toFixed(1)}" font-family="sans-serif" font-size="8" font-weight="bold" fill="#b45309" paint-order="stroke" stroke="#fff" stroke-width="3">L ≈ ${Math.round(L / 10) * 10} mm</text>`; }
            g.innerHTML = h; svgCanvas.appendChild(g);
        }
        canvasContainer.addEventListener('mousedown', e => {
            if (!traza || e.button !== 0) return;
            e.preventDefault(); e.stopPropagation();
            const q = puntoTraza(puntoHoja(e)), ult = traza.puntos[traza.puntos.length - 1];
            if (!ult) { traza.puntos.push(q); if (q.puerto) traza.inicio = { el: q.puerto.el, id: q.puerto.id }; pintarTraza(); return; }
            if (Math.hypot(q.x - ult.x, q.y - ult.y) < 3) return;
            // llegada a un puerto: si no está alineado se añade el codo necesario
            if (q.puerto) {
                const d = (dirPuertoLocal(q.puerto.el, q.puerto.id) + (q.puerto.el.rotation || 0)) % 180;
                if (d === 0 && Math.abs(q.y - ult.y) > 0.5) traza.puntos.push({ x: ult.x, y: q.y });
                else if (d !== 0 && Math.abs(q.x - ult.x) > 0.5) traza.puntos.push({ x: q.x, y: ult.y });
                traza.puntos.push(q); finalizarTrazado(); return;
            }
            traza.puntos.push(q); pintarTraza();
        }, true);
        canvasContainer.addEventListener('mousemove', e => { if (!traza) return; traza.raton = traza.puntos.length ? puntoTraza(puntoHoja(e)) : null; pintarTraza(); });
        canvasContainer.addEventListener('dblclick', e => { if (!traza) return; e.preventDefault(); e.stopPropagation(); finalizarTrazado(); }, true);
        window.addEventListener('keydown', e => {
            if (!traza) return;
            if (e.key === 'Escape') { e.preventDefault(); cancelarTrazado(); aviso('Trazado cancelado.'); }
            else if (e.key === 'Enter') { e.preventDefault(); finalizarTrazado(); }
            else if (e.key === 'Backspace') { e.preventDefault(); traza.puntos.pop(); if (!traza.puntos.length) traza.inicio = null; pintarTraza(); }
        }, true);
        function colocarPorPuerto(el, pid, destino) { const p = obtenerPuertosConexion(el).find(q => q.id === pid); el.x += destino.x - p.x; el.y -= destino.y - p.y; }
        function finalizarTrazado() {
            if (!traza) return;
            // quitar puntos repetidos y colineales
            let P = traza.puntos.filter((p, i, a) => !i || Math.hypot(p.x - a[i - 1].x, p.y - a[i - 1].y) > 0.5);
            P = P.filter((p, i, a) => i === 0 || i === a.length - 1 || !((Math.abs(a[i - 1].x - p.x) < 0.5 && Math.abs(p.x - a[i + 1].x) < 0.5) || (Math.abs(a[i - 1].y - p.y) < 0.5 && Math.abs(p.y - a[i + 1].y) < 0.5)));
            const inicio = traza.inicio;
            cancelarTrazado();
            if (P.length < 2) { aviso('Trazado sin tramos: haz al menos dos clics.', 'error'); return; }
            const dirs = P.slice(1).map((b, i) => { const a = P[i]; return Math.abs(b.x - a.x) > Math.abs(b.y - a.y) ? (b.x > a.x ? 0 : 180) : (b.y > a.y ? 90 : 270); });
            const tramos = P.slice(1).map((b, i) => { const a = P[i]; let L = Math.hypot(b.x - a.x, b.y - a.y); if (i > 0) L -= OFF_CODO; if (i < P.length - 2) L -= OFF_CODO; return L; });
            for (let i = 1; i < dirs.length; i++) if (dirs[i] === dirs[i - 1] || (dirs[i] + 180) % 360 === dirs[i - 1]) { aviso('El trazado vuelve sobre sí mismo: revisa los puntos.', 'error'); return; }
            if (tramos.some(L => L < 6)) { aviso(`Hay tramos demasiado cortos para colocar los codos (mínimo ≈ ${Math.ceil((2 * OFF_CODO + 6) * 30 / 10) * 10} mm entre cambios de dirección).`, 'error'); return; }
            guardarEstado();
            document.getElementById('empty-state')?.remove();
            if (!elementosRed.some(e => !esAnotacion(e))) { lineas = []; condicionesContorno = {}; }
            // tipo de tubería: la del elemento de partida, la última usada o la primera de la librería
            const refT = inicio ? (inicio.el.type === 'tuberia' ? inicio.el : tuberiaReferencia(inicio.el, inicio.el.linea)) : null;
            const ult = refT || [...elementosRed].reverse().find(e => e.type === 'tuberia') || tuboPanel(TUBERIAS_LIBRERIA[0]) || TUBERIAS_LIBRERIA[0];
            const nuevaTub = (i) => {
                const t = { id: 'sym_' + Date.now() + '_t' + i, type: 'tuberia', subtype: '', name: 'Tubería', x: 0, y: screenAMundoY(0), scale: 1, rotation: dirs[i], material: ult.material || MATERIAL_DEF, serie: ult.serie || '40', dn: ult.dn || 'DN 50', longitud: Math.max(10, Math.round(tramos[i] * 30)) };
                if (ult.pn) t.pn = ult.pn; if (ult.gradoMaterial) t.gradoMaterial = ult.gradoMaterial;
                normalizarElemento(t);
                colocarPorPuerto(t, 'a', i === 0 ? P[0] : { x: P[i].x + OFF_CODO * Math.cos(dirs[i] * Math.PI / 180), y: P[i].y + OFF_CODO * Math.sin(dirs[i] * Math.PI / 180) });
                return t;
            };
            const primera = nuevaTub(0);
            elementosRed.push(primera);
            invalidarResultados(); renderizarVectorial();
            // la primera tubería pasa por la ventana de inserción (hereda, propone tamaño, línea...); al aceptar se crean el resto y los codos
            prepararNuevoElemento(primera);
            if (!nuevoPendiente) return;
            nuevoPendiente.alConfirmar = t0 => {
                const creados = [];
                for (let i = 1; i < dirs.length; i++) {
                    const dIn = dirs[i - 1], dOut = dirs[i], giro = ((dOut - dIn) % 360 + 360) % 360;
                    const c = { id: 'sym_' + Date.now() + '_c' + i, type: 'accesorio', subtype: 'codo90', name: 'Codo 90°', x: 0, y: screenAMundoY(0), scale: 1, rotation: giro === 90 ? dOut : (dIn + 180) % 360, dn: dnEquivalente(t0) || 'DN 50', modoK: 'crane', linea: t0.linea, cota: +t0.cotaB || 0 };
                    if (t0.pn) c.pn = t0.pn;
                    normalizarElemento(c);
                    // vértice del codo (15,15 en su cuadro) sobre el punto de cambio de dirección
                    const v0 = rotarPunto({ x: 15, y: 15 }, { x: 25, y: 25 }, c.rotation * Math.PI / 180, c.x, mundoAScreenY(c.y));
                    c.x += P[i].x - v0.x; c.y -= P[i].y - v0.y;
                    elementosRed.push(c); asignarNumero(c); creados.push(c);
                    const t = nuevaTub(i);
                    Object.assign(t, { material: t0.material, serie: t0.serie, dn: t0.dn, linea: t0.linea, cotaA: +t0.cotaB || 0, cotaB: +t0.cotaB || 0 });
                    ['pn', 'gradoMaterial', 'aislamiento', 'lambdaAisl'].forEach(k => { if (t0[k] != null) t[k] = t0[k]; else delete t[k]; });
                    normalizarElemento(t); colocarPorPuerto(t, 'a', { x: P[i].x + OFF_CODO * Math.cos(dOut * Math.PI / 180), y: P[i].y + OFF_CODO * Math.sin(dOut * Math.PI / 180) });
                    elementosRed.push(t); asignarNumero(t); creados.push(t);
                }
                invalidarResultados(); renderizarVectorial();
                aviso(`Trazado: ${dirs.length} tubería(s) y ${dirs.length - 1} codo(s) en la línea ${t0.linea || ''}.`, 'ok');
            };
        }

        // ==================================================================================
        // 2) INSERTAR EN MITAD DE UNA TUBERÍA: un componente en línea (puertos a–b opuestos) soltado sobre
        // una tubería la parte en dos y queda conectado entre ambas.
        // ==================================================================================
        function componenteEnLinea(el) {
            if (el.type === 'tuberia' || esAnotacion(el) || sinFlujo(el) || el.type === 'instrumento' || esTerminal(el)) return false;
            const ids = obtenerPuertosLocales(el).map(p => p.id);
            return ids.includes('a') && ids.includes(el.type === 'bomba' ? 'descarga' : 'b') && (el.type === 'bomba' || (dirPuertoLocal(el, 'a') === 180 && dirPuertoLocal(el, 'b') === 0));
        }
        function tuberiaBajoPunto(cx, cy, largo = 30) {
            let mejor = null;
            elementosRed.forEach(t => {
                if (t.type !== 'tuberia') return;
                const pp = obtenerPuertosConexion(t), A = pp.find(p => p.id === 'a'), B = pp.find(p => p.id === 'b');
                const len = Math.hypot(B.x - A.x, B.y - A.y); if (len < 1) return;
                const ux = (B.x - A.x) / len, uy = (B.y - A.y) / len, s = (cx - A.x) * ux + (cy - A.y) * uy, d = Math.abs((cx - A.x) * uy - (cy - A.y) * ux);
                if (d < 10 && s > largo / 2 + 4 && s < len - largo / 2 - 4 && (!mejor || d < mejor.d)) mejor = { t, A, B, s, len, ux, uy, d };
            });
            return mejor;
        }
        function intentarPartirTuberia(el, cx, cy) {
            if (!componenteEnLinea(el)) return false;
            const loc = obtenerPuertosLocales(el), pa = loc.find(p => p.id === 'a' || p.id === 'succion'), pb = loc.find(p => p.id === 'b' || p.id === 'descarga');
            const largo = Math.hypot(pb.x - pa.x, pb.y - pa.y) * (el.scale || 1);
            const m = tuberiaBajoPunto(cx, cy, largo); if (!m) return false;
            const { t, A, s, len, ux, uy } = m, l1 = s - largo / 2, l2 = len - s - largo / 2;
            const t2 = JSON.parse(JSON.stringify(t));
            t2.id = 'sym_' + Date.now() + '_p'; t2.num = null; t2.codigo = null; delete t2.inicioLinea; delete t2.etq; delete t2.estado;
            const za = +t.cotaA || 0, zb = +t.cotaB || 0;
            t.longitud = Math.max(10, Math.round(l1 * 30)); t.cotaB = +(za + (zb - za) * l1 / len).toFixed(3);
            t2.longitud = Math.max(10, Math.round(l2 * 30)); t2.cotaA = t.cotaB;   // el componente del corte no tiene altura: los dos tramos comparten cota
            el.rotation = t.rotation || 0;
            colocarPorPuerto(el, pa.id, { x: A.x + ux * l1, y: A.y + uy * l1 });
            el.cota = t.cotaB;
            normalizarElemento(t2); elementosRed.push(t2); asignarNumero(t2);
            colocarPorPuerto(t2, 'a', obtenerPuertosConexion(el).find(p => p.id === pb.id));
            // la tubería original queda antes que el componente en la lista (para heredar de ella)
            const i = elementosRed.indexOf(el), j = elementosRed.indexOf(t); if (j > i) { elementosRed.splice(j, 1); elementosRed.splice(i, 0, t); }
            aviso(`${tagDe(t)} partida en dos: ${t.longitud} mm + ${t2.longitud} mm.`);
            return true;
        }

        // ==================================================================================
        // 7) PANEL DE AVISOS DEL CÁLCULO y 8) CORRECCIÓN CON UN CLIC
        // ==================================================================================
        let panelAvisosAbierto = false;
        function alternarPanelAvisos(forzar) { panelAvisosAbierto = forzar != null ? forzar : !panelAvisosAbierto; actualizarPanelAvisos(); }
        function actualizarPanelAvisos() {
            const p = document.getElementById('panel-avisos'); if (!p) return;
            p.style.display = panelAvisosAbierto ? 'flex' : 'none';
            if (!panelAvisosAbierto) return;
            const c = document.getElementById('panel-avisos-cuerpo'), res = ultimoCalculo && ultimoCalculo.resultado;
            if (!res) { c.innerHTML = `<p class="p-2 text-slate-400 italic">${elementosRed.some(e => !esAnotacion(e)) ? 'Red sin calcular o con cambios: se recalcula sola (cálculo automático) o con el botón Calcular.' : 'Sin red.'}</p>`; document.getElementById('panel-avisos-titulo').innerText = 'Avisos del cálculo'; return; }
            const fallos = elementosRed.filter(e => e.estado === 'fallo');
            const calc = new Set(res.aristas.map(a => a.el.id));
            const sinCalc = elementosRed.filter(e => !esAnotacion(e) && !sinFlujo(e) && !calc.has(e.id) && !(esTerminal(e) && ultimoResultado && ultimoResultado[e.id]) && bombaEnMarcha(e));
            const avisos = res.avisosRed || [];
            const tags = elementosRed.filter(e => !esAnotacion(e)).map(e => ({ e, t: tagDe(e) })).sort((a, b) => b.t.length - a.t.length);
            const enlazar = txt => { const m = tags.find(x => txt.includes(x.t)); return m ? `<a href="#" onclick="event.preventDefault(); irAElemento('${m.e.id}')" class="text-blue-700 hover:underline">${esc(txt)}</a>` : esc(txt); };
            let h = '';
            fallos.forEach(e => {
                const r = ultimoResultado[e.id] || { motivos: [] };
                h += `<div class="p-2 border-b border-slate-100"><div class="flex items-start gap-1.5"><i class="fa-solid fa-circle-xmark text-rose-600 mt-0.5"></i><div class="flex-1"><a href="#" onclick="event.preventDefault(); irAElemento('${e.id}')" class="font-bold text-rose-700 hover:underline">${esc(tagDe(e))}</a> <span class="text-slate-600">${esc(r.motivos.join('; '))}</span>` +
                    ((r.acciones || []).length ? `<div class="flex flex-wrap gap-1 mt-1">${r.acciones.map((a, k) => `<button onclick="aplicarAccion('${e.id}', ${k})" class="px-1.5 py-0.5 rounded bg-emerald-600 hover:bg-emerald-700 text-white text-[10px]" title="${esc(a.texto)}"><i class="fa-solid fa-wand-magic-sparkles mr-1"></i>${esc(a.corto || a.texto)}</button>`).join('')}</div>` : '') +
                    ((r.alternativas || []).filter(t => !(r.acciones || []).some(a => a.texto === t)).map(t => `<div class="text-[10px] text-amber-700">→ ${esc(t)}</div>`).join('')) + '</div></div></div>';
            });
            sinCalc.forEach(e => { h += `<div class="p-2 border-b border-slate-100"><i class="fa-solid fa-link-slash text-amber-600 mr-1"></i><a href="#" onclick="event.preventDefault(); irAElemento('${e.id}')" class="font-bold text-amber-700 hover:underline">${esc(tagDe(e))}</a> no está conectado a la red (no se ha calculado).</div>`; });
            avisos.forEach(t => { const ac = (res.accionesRed || []).find(a => a.texto === t); h += `<div class="p-2 border-b border-slate-100"><i class="fa-solid fa-triangle-exclamation text-amber-500 mr-1"></i>${enlazar(t)}${ac ? `<div class="mt-1"><button onclick="invertirComponente('${ac.id}')" class="px-1.5 py-0.5 rounded bg-emerald-600 hover:bg-emerald-700 text-white text-[10px]"><i class="fa-solid fa-right-left mr-1"></i>Invertir ${esc(ac.tag)}</button></div>` : ''}</div>`; });
            const n = fallos.length + sinCalc.length + avisos.length;
            document.getElementById('panel-avisos-titulo').innerHTML = `Avisos del cálculo · <span class="${fallos.length ? 'text-rose-600' : 'text-emerald-700'}">${fallos.length} fallo(s)</span> · ${sinCalc.length + avisos.length} aviso(s)`;
            c.innerHTML = n ? h : '<p class="p-2 text-emerald-700"><i class="fa-solid fa-circle-check mr-1"></i>Sin fallos ni avisos.</p>';
        }
        function aplicarAccion(id, k) {
            const el = elementosRed.find(e => e.id === id), r = ultimoResultado && ultimoResultado[id], a = r && (r.acciones || [])[k];
            if (!el || !a) return;
            guardarEstado();
            a.cambios.forEach(([campo, valor]) => {
                const antes = el.dn;
                aplicarCambio(el, campo, valor);
                if (campo === 'dn' && el.type === 'tuberia') { const av = propagarDN([{ el, dnAntes: antes }]); av.forEach(t => aviso(t, 'error')); }
            });
            invalidarResultados(); renderizarVectorial();
            if (idSeleccionado === id) seleccionarElemento(id);
            aviso(`${tagDe(el)}: ${a.texto}`, 'ok');
            if (!opciones.calculoAuto) aviso('Cálculo automático desactivado: pulsa Calcular para comprobar la corrección.');
        }

        // ==================================================================================
        // 12) PALETA DE COMANDOS (Ctrl+K): menús, insertar componentes, ir a elementos y líneas
        // ==================================================================================
        let paleta_ = { lista: [], sel: 0 };
        const sinAcentos = t => String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
        function comandosPaleta() {
            const out = [];
            const recorrer = (items, ruta) => (items || []).forEach(it => {
                if (it === 'sep' || !it.texto) return;
                if (it.habilitado && !it.habilitado()) return;
                const r = ruta ? ruta + ' › ' + it.texto : it.texto;
                if (it.sub) recorrer(typeof it.sub === 'function' ? it.sub() : it.sub, r);
                else if (it.accion && !/^(Ctrl|Origen del catálogo)/.test(it.texto)) out.push({ texto: r, icono: it.icono || 'fa-angle-right', grupo: 'Menú', accion: it.accion });
            });
            MENUS.forEach(m => recorrer(m.items, m.titulo));
            out.push({ texto: 'Trazar tubería', icono: 'fa-pen-ruler', grupo: 'Dibujo', accion: () => iniciarTrazado() });
            out.push({ texto: 'Tabla de propiedades', icono: 'fa-table-cells-large', grupo: 'Edición', accion: () => abrirTablaPropiedades() });
            out.push({ texto: 'Panel de avisos del cálculo', icono: 'fa-triangle-exclamation', grupo: 'Cálculo', accion: () => alternarPanelAvisos(true) });
            TUBERIAS_LIBRERIA.map(tuboPanel).filter(Boolean).forEach(t => out.push({ texto: 'Insertar tubería · ' + t.texto, icono: 'fa-grip-lines', grupo: 'Insertar', accion: () => insertarEnCentro({ type: 'tuberia', material: t.material, serie: t.serie, dn: t.dn, longitud: '3000', name: 'Tubería' }) }));
            out.push({ texto: 'Insertar · Bomba centrífuga', icono: 'fa-fan', grupo: 'Insertar', accion: () => insertarEnCentro({ type: 'bomba', name: 'Bomba centrífuga', caudal: '50', presion: '3.5', npsh: '2500' }) });
            Object.entries(TIPOS).filter(([k, t]) => t.cat !== 'ninguna' && t.type !== 'anotacion').forEach(([k, t]) => {
                if (k === 'reduccion') { ['false', 'true'].forEach(ex => out.push({ texto: `Insertar · Reducción ${ex === 'true' ? 'excéntrica' : 'concéntrica'} (${ex === 'true' ? 'RE' : 'RC'})`, icono: 'fa-shapes', grupo: 'Insertar', accion: () => insertarEnCentro({ type: 'accesorio', subtype: 'reduccion', excentrica: ex, name: 'Reducción' }) })); return; }
                out.push({ texto: `Insertar · ${t.nombre} (${t.codigo})`, icono: iconoArbol({ type: t.type, subtype: k }), grupo: 'Insertar', accion: () => insertarEnCentro({ type: t.type, subtype: k, name: t.nombre }) });
            });
            lineasEnOrden().forEach(o => out.push({ texto: `Seleccionar línea · ${o.linea.id}${o.linea.nombre ? ' · ' + o.linea.nombre : ''}`, icono: 'fa-diagram-project', grupo: 'Línea', accion: () => seleccionarLinea(o.linea.id) }));
            elementosRed.filter(e => !esAnotacion(e)).forEach(e => out.push({ texto: `Ir a · ${tagDe(e)} · ${nombreTipo(e)}`, icono: 'fa-location-crosshairs', grupo: 'Elemento', accion: () => irAElemento(e.id) }));
            return out;
        }
        function abrirPaleta() {
            cerrarMenus();
            const p = document.getElementById('paleta'); p.style.display = 'flex';
            const inp = document.getElementById('paleta-texto'); inp.value = ''; paleta_.todos = comandosPaleta(); filtrarPaleta(); setTimeout(() => inp.focus(), 10);
        }
        function cerrarPaleta() { document.getElementById('paleta').style.display = 'none'; }
        function filtrarPaleta() {
            const q = sinAcentos(document.getElementById('paleta-texto').value).split(/\s+/).filter(Boolean);
            // orden: dibujo e inserción primero, luego menús (las librerías al final), líneas y elementos
            const pri = c => ({ Dibujo: 0, Insertar: 1, Edición: 2, 'Cálculo': 2, 'Menú': /^Librerías/.test(c.texto) ? 4 : 3, 'Línea': 5, Elemento: 6 })[c.grupo] ?? 3;
            paleta_.lista = paleta_.todos.filter(c => { const t = sinAcentos(c.texto + ' ' + c.grupo); return q.every(w => t.includes(w)); })
                .map((c, i) => [c, i]).sort((x, y) => (q.length ? pri(x[0]) - pri(y[0]) : 0) || x[1] - y[1]).map(x => x[0]).slice(0, 60);
            paleta_.sel = 0; pintarPaleta();
        }
        function pintarPaleta() {
            document.getElementById('paleta-lista').innerHTML = paleta_.lista.map((c, i) => `<div onmousedown="event.preventDefault(); ejecutarPaleta(${i})" onmousemove="if (paleta_.sel !== ${i}) { paleta_.sel = ${i}; pintarPaleta(); }" class="px-3 py-1.5 flex items-center gap-2 cursor-pointer ${i === paleta_.sel ? 'bg-blue-600 text-white' : 'hover:bg-slate-50'}"><i class="fa-solid ${c.icono} w-4 text-center ${i === paleta_.sel ? '' : 'text-blue-600'}"></i><span class="flex-1">${esc(c.texto)}</span><span class="text-[10px] ${i === paleta_.sel ? 'text-blue-100' : 'text-slate-400'}">${c.grupo}</span></div>`).join('') || '<p class="px-3 py-2 text-slate-400 italic">Sin coincidencias</p>';
            const s = document.querySelector('#paleta-lista > div:nth-child(' + (paleta_.sel + 1) + ')'); if (s) s.scrollIntoView({ block: 'nearest' });
        }
        function ejecutarPaleta(i) { const c = paleta_.lista[i]; cerrarPaleta(); if (c) setTimeout(() => c.accion(), 0); }
        function tecladoPaleta(e) {
            if (e.key === 'ArrowDown') { e.preventDefault(); paleta_.sel = Math.min(paleta_.lista.length - 1, paleta_.sel + 1); pintarPaleta(); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); paleta_.sel = Math.max(0, paleta_.sel - 1); pintarPaleta(); }
            else if (e.key === 'Enter') { e.preventDefault(); ejecutarPaleta(paleta_.sel); }
            else if (e.key === 'Escape') { e.preventDefault(); cerrarPaleta(); }
        }
        function insertarEnCentro(data) { const c = centroVista(); insertarComponente(data, c.x + 25, mundoAScreenY(c.y) + 25); }

        // ==================================================================================
        // 17) TABLA DE PROPIEDADES (edición en bloque, Edición > Tabla de propiedades)
        // ==================================================================================
        let masivo = { grupo: 'tuberia', linea: '', texto: '', marcados: new Set() };
        const GRUPOS_MASIVO = [['tuberia', 'Tuberías'], ['valvula', 'Válvulas'], ['accesorio', 'Accesorios, uniones y bridas'], ['bomba', 'Bombas'], ['equipo', 'Equipos'], ['terminal', 'Tanques y consumos'], ['instrumento', 'Instrumentos']];
        function columnasMasivo(g) {
            const lin = () => lineas.map(l => [l.id, l.id]);
            const pn = el => tieneRating(el) && !(el.accModelo && sinRatingAcc(modeloAcc(el))) ? (el.accModelo && modeloAcc(el) ? [['', '—'], ...ratingsAcc(modeloAcc(el))] : listaPN(el)) : [['', '—']];
            const C = {
                tuberia: [['linea', 'Línea', 'sel', lin], ['material', 'Tipo / material', 'sel', () => Object.keys(CAT.materiales)], ['serie', 'Serie', 'sel', el => materialDe(el).series.filter(sr => materialDe(el).tamanos.some(t => t.e[sr] != null))], ['dn', 'Tamaño', 'sel', el => materialDe(el).tamanos.filter(t => t.e[el.serie] != null).map(t => [t.clave, tamanoTubo(el.material, t.clave)])], ['gradoMaterial', 'Material (grado)', 'mat'], ['longitud', 'L (mm)', 'num'], ['cotaA', 'Cota a (m)', 'num'], ['cotaB', 'Cota b (m)', 'num'], ['aislamiento', 'Aisl. (mm)', 'num']],
                valvula: [['linea', 'Línea', 'sel', lin], ['_tipo', 'Tipo', 'ro'], ['dn', 'DN', 'sel', () => LISTA_DN.map(d => [d, etiquetaDN(d)])], ['pn', 'PN / Rating', 'sel', pn], ['craneTipo', 'Subtipo', 'sel', el => opcionesCrane(claveCrane(el)).map(o => o[0])], ['libItem', 'Modelo de librería', 'sel', el => [['', '—'], ...itemsLib(el.subtype).map(i => [i.id, i.nombre])]], ['materialComp', 'Material', 'mat'], ['url', 'URL', 'txt'], ['cota', 'Cota (mm)', 'mag']],
                accesorio: [['linea', 'Línea', 'sel', lin], ['_tipo', 'Tipo', 'ro'], ['dn', 'DN', 'sel', () => LISTA_DN.map(d => [d, etiquetaDN(d)])], ['dnMenor', 'DN menor', 'sel', el => el.subtype === 'reduccion' ? LISTA_DN.filter(d => dnNum(d) < dnNum(el.dn)).map(d => [d, etiquetaDN(d)]) : null], ['pn', 'PN / Rating', 'sel', pn], ['craneTipo', 'Tipo (Crane)', 'sel', el => { const o = opcionesCrane(claveCrane(el)); return o.length > 1 ? o.map(x => x[0]) : null; }], ['libItem', 'Modelo de librería', 'sel', el => [['', '—'], ...itemsLib(el.subtype).map(i => [i.id, i.nombre])]], ['materialComp', 'Material', 'mat'], ['url', 'URL', 'txt'], ['cota', 'Cota (mm)', 'mag']],
                bomba: [['linea', 'Línea', 'sel', lin], ['caudal', `Q (${lQ()})`, 'mag'], ['presion', `p (${lP()})`, 'mag'], ['h0', `p₀ (${lP()})`, 'mag'], ['npsh', 'NPSHr (m)', 'num'], ['eta', 'η', 'num'], ['cota', 'Cota (mm)', 'mag'], ['dnAsp', 'DN entrada', 'sel', () => LISTA_DN.map(d => [d, etiquetaDN(d)])], ['pnAsp', 'Rating entrada', 'sel', pn], ['dnImp', 'DN salida', 'sel', () => LISTA_DN.map(d => [d, etiquetaDN(d)])], ['pnImp', 'Rating salida', 'sel', pn], ['libItem', 'Modelo de librería', 'sel', () => [['', '—'], ...itemsLib('bomba').map(i => [i.id, i.nombre])]], ['materialComp', 'Material', 'mat'], ['url', 'URL', 'txt']],
                equipo: [['linea', 'Línea', 'sel', lin], ['_tipo', 'Tipo', 'ro'], ['qNom', `Q nom (${lQ()})`, 'mag'], ['dpNom', `Δp nom (${lP()})`, 'mag'], ['pn', 'PN / Rating', 'sel', pn], ['volumen', 'V (l)', 'num'], ['cota', 'Cota (mm)', 'mag'], ['materialComp', 'Material', 'mat'], ['url', 'URL', 'txt']],
                terminal: [['linea', 'Línea', 'sel', lin], ['_tipo', 'Tipo', 'ro'], ['qCons', `Q cons. (${lQ()})`, 'mag', el => el.subtype === 'consumo'], ['pMin', `p mín (${lP()})`, 'mag', el => el.subtype === 'consumo'], ['cota', 'Cota (mm)', 'mag', el => el.subtype === 'consumo'], ['cotaFondo', 'Cota fondo (m)', 'num', el => esDeposito(el)], ['hLamina', 'Nivel (m)', 'num', el => esDeposito(el)], ['presionDep', `p lámina (${lP()})`, 'mag', el => esDeposito(el)], ['volumen', 'V (l)', 'num', el => esDeposito(el)], ['materialComp', 'Material', 'mat'], ['url', 'URL', 'txt']],
                instrumento: [['linea', 'Línea', 'sel', lin], ['_tipo', 'Tipo', 'ro'], ['dnInstr', 'Conexión', 'sel', () => [['', '—'], ...LISTA_DN.slice(0, 8).map(d => [d, etiquetaDN(d)])]], ['rango', 'Rango', 'txt'], ['cota', 'Cota (mm)', 'mag'], ['materialComp', 'Material', 'mat'], ['url', 'URL', 'txt']]
            };
            return C[g];
        }
        function elementosMasivo() {
            const q = sinAcentos(masivo.texto);
            return elementosRed.filter(e => e.type === masivo.grupo && (!masivo.linea || e.linea === masivo.linea) && (!q || sinAcentos(tagDe(e) + ' ' + nombreTipo(e) + ' ' + (e.materialComp || e.material || '')).includes(q)))
                .sort((a, b) => String(a.linea || '').localeCompare(String(b.linea || '')) || tagDe(a).localeCompare(tagDe(b)));
        }
        function abrirTablaPropiedades(grupo) {
            if (grupo) masivo.grupo = grupo;
            document.getElementById('modal-masivo').style.display = 'flex';
            pintarTablaPropiedades();
        }
        function cerrarTablaPropiedades() { document.getElementById('modal-masivo').style.display = 'none'; }
        function celdaMasivo(el, [campo, , tipo, ops]) {
            if (tipo === 'ro') return `<td class="px-1 whitespace-nowrap text-slate-600">${esc(nombreTipo(el))}</td>`;
            if (typeof ops === 'function' && tipo !== 'sel' && ops(el) === false) return '<td class="px-1 text-slate-300">—</td>';
            const on = v => `onchange="cambioMasivo('${el.id}', '${campo}', ${v})"`;
            const val = el[campo];
            if (tipo === 'sel') {
                const lista = ops(el); if (!lista) return '<td class="px-1 text-slate-300">—</td>';
                return `<td class="px-0.5"><select ${on('this.value')} class="border rounded p-0.5 text-[11px] max-w-[170px]">${lista.map(o => { const [v, t] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(v)}" ${String(v) === String(val == null ? '' : val) ? 'selected' : ''}>${esc(t)}</option>`; }).join('')}</select></td>`;
            }
            if (tipo === 'mat') return `<td class="px-0.5"><select onchange="if (this.value === '__otro') { const t = prompt('Material:', ''); if (t) cambioMasivo('${el.id}', '${campo}', t); else this.value = ''; } else cambioMasivo('${el.id}', '${campo}', this.value)" class="border rounded p-0.5 text-[11px] max-w-[170px]">${opcionesMaterial(grupoMaterial(el), val || '')}</select></td>`;
            if (tipo === 'mag') return `<td class="px-0.5"><input type="number" step="any" value="${esc(mostrarCampo(campo, val))}" ${on('this.value')} class="border rounded p-0.5 w-20 text-[11px]"></td>`;
            if (tipo === 'num') return `<td class="px-0.5"><input type="number" step="any" value="${esc(val == null ? '' : val)}" ${on('this.value')} class="border rounded p-0.5 w-20 text-[11px]"></td>`;
            return `<td class="px-0.5"><input type="text" value="${esc(val || '')}" ${on('this.value')} class="border rounded p-0.5 w-40 text-[11px]"></td>`;
        }
        function pintarTablaPropiedades() {
            const cols = columnasMasivo(masivo.grupo), els = elementosMasivo();
            masivo.marcados = new Set([...masivo.marcados].filter(id => els.some(e => e.id === id)));
            const edit = cols.filter(c => c[2] !== 'ro');
            document.getElementById('masivo-cuerpo').innerHTML = `
                <div class="flex flex-wrap gap-2 items-center mb-2">
                    <div class="flex border rounded overflow-hidden">${GRUPOS_MASIVO.map(([g, t]) => `<button onclick="masivo.grupo='${g}'; masivo.marcados.clear(); pintarTablaPropiedades()" class="px-2 py-1 ${g === masivo.grupo ? 'bg-blue-600 text-white' : 'hover:bg-slate-50'}">${t} <span class="opacity-70">${elementosRed.filter(e => e.type === g).length}</span></button>`).join('')}</div>
                    <select onchange="masivo.linea = this.value; pintarTablaPropiedades()" class="border rounded p-1"><option value="">Todas las líneas</option>${lineas.map(l => `<option ${l.id === masivo.linea ? 'selected' : ''}>${l.id}</option>`).join('')}</select>
                    <input value="${esc(masivo.texto)}" placeholder="Filtrar (etiqueta, tipo, material)" oninput="masivo.texto = this.value; clearTimeout(window.__tmF); window.__tmF = setTimeout(pintarTablaPropiedades, 250)" class="border rounded p-1 w-56">
                </div>
                <div class="flex flex-wrap gap-2 items-center mb-2 bg-slate-50 border rounded p-1.5"><b>Marcados: ${masivo.marcados.size}</b> · Asignar
                    <select id="masivo-campo" class="border rounded p-1">${edit.map(c => `<option value="${c[0]}">${esc(c[1])}</option>`).join('')}</select>
                    = <input id="masivo-valor" placeholder="valor (tal como aparece en la columna)" class="border rounded p-1 w-56">
                    <button onclick="asignarMasivo()" class="px-2 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded" ${masivo.marcados.size ? '' : 'disabled'}>Aplicar a los marcados</button>
                    <span class="text-[10px] text-slate-400">Consejo: cambia un elemento en la tabla y copia su valor a los demás con este botón.</span></div>
                <div class="overflow-auto border rounded" style="max-height:60vh"><table class="text-[11px] w-full"><thead class="bg-slate-100 sticky top-0"><tr>
                    <th class="px-1"><input type="checkbox" ${els.length && masivo.marcados.size === els.length ? 'checked' : ''} onchange="if (this.checked) elementosMasivo().forEach(e => masivo.marcados.add(e.id)); else masivo.marcados.clear(); pintarTablaPropiedades()"></th><th class="px-1 text-left">Etiqueta</th>${cols.map(c => `<th class="px-1 text-left whitespace-nowrap">${esc(c[1])}</th>`).join('')}</tr></thead>
                    <tbody>${els.map(el => `<tr class="border-t border-slate-100 ${el.estado === 'fallo' ? 'bg-rose-50' : ''}"><td class="px-1"><input type="checkbox" ${masivo.marcados.has(el.id) ? 'checked' : ''} onchange="if (this.checked) masivo.marcados.add('${el.id}'); else masivo.marcados.delete('${el.id}'); pintarTablaPropiedades()"></td>
                        <td class="px-1 whitespace-nowrap"><a href="#" onclick="event.preventDefault(); irAElemento('${el.id}')" class="text-blue-700 hover:underline font-bold">${esc(tagDe(el))}</a></td>${cols.map(c => celdaMasivo(el, c)).join('')}</tr>`).join('') || `<tr><td colspan="${cols.length + 2}" class="p-2 text-slate-400 italic">Sin elementos de este tipo.</td></tr>`}</tbody></table></div>`;
        }
        function cambioMasivo(id, campo, valor, sinPintar) {
            const el = elementosRed.find(e => e.id === id); if (!el) return false;
            if (!sinPintar) guardarEstado();
            const antes = el.dn;
            let ok;
            if (campo === 'linea') { if (!lineas.some(l => l.id === valor)) ok = false; else { el.linea = valor; asignarNumero(el); purgarLineasVacias(); ok = true; } }
            else ok = aplicarCambio(el, campo, valor);
            if (ok !== false && campo === 'dn' && el.type === 'tuberia') propagarDN([{ el, dnAntes: antes }]);
            if (!sinPintar) { invalidarResultados(); renderizarVectorial(); pintarTablaPropiedades(); }
            return ok !== false;
        }
        function asignarMasivo() {
            const campo = document.getElementById('masivo-campo').value; let valor = document.getElementById('masivo-valor').value.trim();
            const col = columnasMasivo(masivo.grupo).find(c => c[0] === campo);
            guardarEstado(); let n = 0, no = 0;
            [...masivo.marcados].forEach(id => {
                const el = elementosRed.find(e => e.id === id); if (!el) return;
                let v = valor;
                if (col && col[2] === 'sel') { const lista = col[3](el) || []; const hit = lista.map(o => Array.isArray(o) ? o : [o, o]).find(([a, t]) => sinAcentos(a) === sinAcentos(valor) || sinAcentos(t) === sinAcentos(valor)); if (!hit) { no++; return; } v = hit[0]; }
                if (cambioMasivo(id, campo, v, true)) n++; else no++;
            });
            invalidarResultados(); renderizarVectorial(); pintarTablaPropiedades();
            aviso(`${col ? col[1] : campo}: ${n} elemento(s) cambiados${no ? ` · ${no} sin cambiar (valor no válido para ese elemento)` : ''}.`, no ? 'error' : 'ok');
        }

        // ==================================================================================
        // HOJAS DEL PROYECTO (pestañas abajo a la izquierda: 00, 01, 02… y "Añadir hoja")
        // La hoja activa vive en elementosRed / lineas / condicionesContorno / opciones.formato; las demás
        // se guardan en hojas[i]. La numeración de componentes y de líneas nuevas es única en el proyecto.
        // ==================================================================================
        function sincronizarHoja() {
            const h = hojas[hojaActual] || (hojas[hojaActual] = { id: '00' });
            Object.assign(h, { e: elementosRed, l: lineas, cc: condicionesContorno, formato: opciones.formato || 'A3', congelado: planoCongelado });
        }
        function elementosOtrasHojas() { return hojas.filter((h, i) => i !== hojaActual).flatMap(h => h.e || []); }
        function lineasOtrasHojas() { return hojas.filter((h, i) => i !== hojaActual).flatMap(h => h.l || []); }
        const todasLineas = () => lineas.concat(lineasOtrasHojas());
        const codigoHoja = () => (hojas[hojaActual] || {}).id || '00';
        function cargarHoja(i) {
            if (typeof comparacion !== 'undefined' && comparacion) { comparacion = null; document.getElementById('banda-comparacion')?.remove(); }
            if (typeof traza !== 'undefined' && traza) cancelarTrazado();
            hojaActual = i; const h = hojas[i];
            elementosRed = h.e || []; lineas = h.l || []; condicionesContorno = h.cc || {};
            planoCongelado = !!h.congelado; pintarCongelado();
            if (h.formato && FORMATOS[h.formato]) opciones.formato = h.formato;
            historialUndo = []; historialRedo = []; actualizarBotonesHistorial();
            idSeleccionado = null; seleccion.clear(); ultimoResultado = null; ultimoCalculo = null;
            invalidarResultados(); aplicarFormato(); renderizarVectorial(); renderArbol(); zoomTodo(); pintarHojas();
            const panel = document.getElementById('panel-propiedades'); if (panel) panel.innerHTML = '<p class="text-slate-400 italic text-[10px]">Selecciona un elemento.</p>';
        }
        function cambiarHoja(i) { if (i === hojaActual || !hojas[i]) return; sincronizarHoja(); cargarHoja(i); }
        function anadirHoja() {
            if (!proyectoDefinido()) { pantallaInicio(); return; }
            sincronizarHoja();
            const n = 1 + Math.max(-1, ...hojas.map(h => parseInt(h.id, 10) || 0));
            hojas.push({ id: String(n).padStart(2, '0'), e: [], l: [], cc: {}, formato: opciones.formato || 'A3', congelado: false });
            marcarCambios(true); cargarHoja(hojas.length - 1);
            aviso(`Hoja ${codigoHoja()} añadida (${hojas.length} hojas).`, 'ok');
        }
        async function eliminarHoja(i) {
            if (hojas.length < 2) { aviso('El proyecto tiene una sola hoja: no se puede eliminar.', 'error'); return; }
            sincronizarHoja();
            const h = hojas[i], n = (h.e || []).length;
            const r = await dialogo('<i class="fa-solid fa-trash-can text-rose-600 mr-1.5"></i>Eliminar hoja', `<p>¿Eliminar la hoja <b>${esc(h.id)}</b>${n ? ` y sus <b>${n}</b> elementos` : ''}? No se puede deshacer.</p>`,
                [{ texto: 'Eliminar', valor: 'si', clase: 'bg-rose-600 hover:bg-rose-700 text-white' }, { texto: 'Cancelar', valor: null }]);
            if (r !== 'si') return;
            const activa = hojas[hojaActual];
            hojas.splice(i, 1); marcarCambios(true);
            if (i === hojaActual) cargarHoja(Math.min(i, hojas.length - 1));
            else { hojaActual = hojas.indexOf(activa); renderizarVectorial(); pintarHojas(); }
            aviso(`Hoja ${h.id} eliminada (${hojas.length} hoja${hojas.length > 1 ? 's' : ''}).`);
        }
        function pintarHojas() {
            const b = document.getElementById('barra-hojas'); if (!b) return;
            b.innerHTML = hojas.map((h, i) => `<button onclick="cambiarHoja(${i})" oncontextmenu="event.preventDefault(); mostrarMenuContextual(event.clientX, event.clientY, [{ icono: 'fa-trash-can', texto: 'Eliminar hoja ${h.id}', accion: () => eliminarHoja(${i}) }])" title="Hoja ${h.id} · botón derecho: eliminar"
                class="px-3 h-6 -mb-px border border-slate-300 rounded-t text-[11px] font-bold ${i === hojaActual ? 'bg-white text-blue-700 border-b-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-50'}">${esc(h.id)}</button>`).join('') +
                `<button onclick="anadirHoja()" title="Añadir hoja" class="ml-1 px-2 h-6 text-[11px] text-slate-600 hover:text-blue-700 hover:bg-white rounded"><i class="fa-solid fa-file-circle-plus mr-1"></i>Añadir hoja</button>`;
        }
        // .pid: la hoja activa va en "elementos/lineas" (compatibilidad); el resto en "hojas"
        function hojasParaGuardar() {
            sincronizarHoja();
            return hojas.map((h, i) => i === hojaActual ? { id: h.id, activa: true, formato: h.formato, congelado: !!h.congelado } : { id: h.id, formato: h.formato, congelado: !!h.congelado, elementos: h.e || [], lineas: h.l || [], condicionesContorno: h.cc || {} });
        }
        function cargarHojasDe(res) {
            if (Array.isArray(res.hojas) && res.hojas.length) {
                hojas = res.hojas.map(h => ({ id: h.id, formato: h.formato, congelado: !!h.congelado, e: (h.elementos || []).map(e => { normalizarElemento(e); return e; }), l: h.lineas || [], cc: h.condicionesContorno || {} }));
                hojaActual = Math.max(0, res.hojas.findIndex(h => h.activa));
                planoCongelado = !!hojas[hojaActual].congelado;
            } else { hojas = [{ id: '00' }]; hojaActual = 0; planoCongelado = false; }
            sincronizarHoja(); pintarHojas(); pintarCongelado();
        }
        setTimeout(pintarHojas, 0);

        // ==================================================================================
        // CONGELAR PLANO (botón derecho en el lienzo > Congelar plano / Descongelar plano)
        // Con el plano congelado no se puede modificar nada: toda modificación pasa por guardarEstado(),
        // que la corta. Se guarda por hoja y en el DXF las capas salen bloqueadas.
        // ==================================================================================

        class ErrorPlanoCongelado extends Error { constructor() { super('Plano congelado'); this.name = 'PlanoCongelado'; } }
        let avisoCongeladoT = 0;
        function avisarCongelado() {
            if (Date.now() - avisoCongeladoT > 1500) { avisoCongeladoT = Date.now(); aviso('Plano congelado: no se puede modificar. Botón derecho en el lienzo > Descongelar plano.', 'error'); }
        }
        function comprobarCongelado() { if (planoCongelado) { avisarCongelado(); throw new ErrorPlanoCongelado(); } }
        const esErrorCongelado = x => x && (x instanceof ErrorPlanoCongelado || x.name === 'PlanoCongelado');
        window.addEventListener('error', e => { if (esErrorCongelado(e.error) || (!e.error && /^Script error/.test(e.message || '') && (planoCongelado || (typeof nubeSoloLectura !== 'undefined' && nubeSoloLectura)))) { e.preventDefault(); refrescarTrasCongelado(); } });
        window.addEventListener('unhandledrejection', e => { if (esErrorCongelado(e.reason)) { e.preventDefault(); refrescarTrasCongelado(); } });
        function refrescarTrasCongelado() {
            isDraggingSymbol = false; activeSymbolId = null; if (typeof arrastreEtq !== 'undefined') arrastreEtq = null;
            setTimeout(() => { renderizarVectorial(); if (idSeleccionado) seleccionarElemento(idSeleccionado); }, 0);
        }
        function pintarCongelado() {
            let b = document.getElementById('banda-congelado');
            if (!planoCongelado) { if (b) b.remove(); canvasContainer.classList.remove('lienzo-congelado'); return; }
            if (!b) { b = document.createElement('div'); b.id = 'banda-congelado'; b.className = 'absolute top-2 left-1/2 -translate-x-1/2 z-30 bg-sky-700 text-white text-[11px] font-bold px-3 py-1 rounded shadow cursor-pointer'; b.title = 'Clic para descongelar'; b.onclick = () => congelarPlano(false); canvasContainer.parentElement.appendChild(b); }
            b.innerHTML = `<i class="fa-solid fa-snowflake mr-1.5"></i>PLANO CONGELADO · hoja ${esc(codigoHoja())} · clic para descongelar`;
            canvasContainer.classList.add('lienzo-congelado');
        }
        function congelarPlano(si) {
            if (typeof traza !== 'undefined' && traza) cancelarTrazado();
            planoCongelado = !!si; if (hojas[hojaActual]) hojas[hojaActual].congelado = planoCongelado;
            limpiarSeleccion(); cerrarMenus(); pintarCongelado(); marcarCambios(true);
            aviso(si ? 'Plano congelado: no se puede modificar nada hasta descongelarlo.' : 'Plano descongelado: vuelve a ser editable.', 'ok');
        }

        // ==================================================================================
        // ATAJOS DE TECLADO (CAD > Atajos de teclado… para verlos, cambiarlos y crear nuevos;
        // Ayuda > Atajos de teclado para consultarlos). Cualquier orden de los menús admite atajo.
        // ==================================================================================
        const CLAVE_ATAJOS = 'piping-atajos';
        let CONF_ATAJOS = (() => { try { return JSON.parse(localStorage.getItem(CLAVE_ATAJOS) || 'null') || {}; } catch (e) { return {}; } })();
        if (!CONF_ATAJOS.teclas) CONF_ATAJOS.teclas = {};
        function guardarConfAtajos() { try { localStorage.setItem(CLAVE_ATAJOS, JSON.stringify(CONF_ATAJOS)); } catch (e) { } }
        const libreDeCampo = () => { const a = document.activeElement; return !(a && (['INPUT', 'TEXTAREA', 'SELECT'].includes(a.tagName) || a.isContentEditable)); };
        const sinVentanas = () => !document.querySelector('[id^="modal-"][style*="flex"]') && document.getElementById('paleta').style.display !== 'flex' && !menuAbierto && !(typeof traza !== 'undefined' && traza);
        // órdenes con atajo de fábrica (id = ruta del menú cuando la orden está en un menú)
        const ACCIONES_BASE = [
            { id: 'Archivo › Nuevo proyecto...', teclas: ['Ctrl+N'], campo: true, accion: () => nuevoProyecto() },
            { id: 'Archivo › Proyecto existente...', teclas: ['Ctrl+O'], campo: true, accion: () => proyectoExistente() },
            { id: 'Archivo › Guardar', teclas: ['Ctrl+G'], campo: true, accion: () => guardarProyecto() },
            { id: 'Archivo › Imprimir...', teclas: ['Ctrl+P'], campo: true, accion: () => abrirImpresion() },
            { id: 'Edición › Búsqueda/Reemplazo...', teclas: ['Ctrl+R'], campo: true, accion: () => abrirBuscarReemplazar() },
            { id: 'Edición › Paleta de comandos...', teclas: ['Ctrl+K'], campo: true, accion: () => abrirPaleta() },
            { id: 'Edición › Copiar', teclas: ['Ctrl+C'], cuando: () => haySeleccion(), accion: () => copiarSeleccion() },
            { id: 'Edición › Cortar', teclas: ['Ctrl+X'], cuando: () => haySeleccion(), accion: () => cortarSeleccion() },
            { id: 'Edición › Pegar', teclas: ['Ctrl+V'], cuando: () => !!(portapapeles && portapapeles.length), accion: () => pegarPortapapeles() },
            { id: 'Edición › Eliminar selección', teclas: ['Supr', 'B'], cuando: () => haySeleccion(), accion: () => eliminarSeleccion() },
            { id: 'Edición › Deshacer', teclas: ['Ctrl+Z'], accion: () => deshacer() },
            { id: 'Edición › Rehacer', teclas: ['Ctrl+Y', 'Ctrl+Mayús+Z'], accion: () => rehacer() },
            { id: 'Seleccionar › Todo', teclas: ['Ctrl+A'], accion: () => seleccionarTodo() },
            { id: 'Selección › Girar 45° horario', teclas: ['R'], cuando: () => haySeleccion(), accion: () => girar45(45) },
            { id: 'Selección › Girar 45° antihorario', teclas: ['Mayús+R'], cuando: () => haySeleccion(), accion: () => girar45(-45) },
            { id: 'Insertar › Trazar tubería (tramos y codos)', teclas: ['L'], accion: () => iniciarTrazado() },
            { id: 'Hojas › Añadir hoja', teclas: ['Alt+A'], campo: true, accion: () => anadirHoja() },
            { id: 'Zoom › Ajustar', teclas: ['F'], accion: () => ajustarVistaVentana() },
            { id: 'Zoom › Todo', teclas: ['T'], accion: () => zoomTodo() },
            { id: 'Zoom › Ventana', teclas: ['W'], accion: () => { modoZoomVentana = !modoZoomVentana; canvasContainer.style.cursor = modoZoomVentana ? 'crosshair' : 'default'; } }
        ];
        const BASE_POR_ID = Object.fromEntries(ACCIONES_BASE.map(a => [a.id, a]));
        // Todas las órdenes: las de los menús (ruta completa) y las de teclado sin menú
        function listaComandos() {
            const out = [], vistos = new Set();
            const recorrer = (items, ruta, cat) => (typeof items === 'function' ? items() : items || []).forEach(it => {
                if (it === 'sep' || !it.texto) return;
                const r = ruta ? ruta + ' › ' + it.texto : it.texto;
                if (it.sub) { try { recorrer(it.sub, r, cat); } catch (e) { } }
                else if (it.accion && !/^(Ctrl\/|Origen del catálogo)/.test(it.texto) && !vistos.has(r)) { vistos.add(r); out.push({ id: r, cat, texto: r.split(' › ').slice(1).join(' › '), icono: it.icono || 'fa-angle-right', item: it }); }
            });
            MENUS.forEach(m => recorrer(m.items, m.titulo, m.titulo));
            ACCIONES_BASE.forEach(a => { if (!vistos.has(a.id)) { vistos.add(a.id); out.push({ id: a.id, cat: a.id.split(' › ')[0], texto: a.id.split(' › ').slice(1).join(' › '), icono: 'fa-keyboard' }); } });
            return out;
        }
        const teclasDe = id => CONF_ATAJOS.teclas[id] || (BASE_POR_ID[id] ? BASE_POR_ID[id].teclas : []);
        function atajoTexto(id, def) { const t = teclasDe(id); return t.length || CONF_ATAJOS.teclas[id] || BASE_POR_ID[id] ? t.join(' / ') : (def || ''); }
        function ejecutarComando(id) {
            if (!id) return false;
            const b = BASE_POR_ID[id];
            if (b) { if (b.cuando && !b.cuando()) return false; b.accion(); return true; }
            const c = listaComandos().find(x => x.id === id);
            if (!c || !c.item) return false;
            if (c.item.habilitado && !c.item.habilitado()) return false;
            c.item.accion(); return true;
        }
        function comboDe(e) {
            if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph'].includes(e.key)) return null;
            let k = e.key;
            if (/^Key[A-Z]$/.test(e.code)) k = e.code.slice(3);
            else if (/^Digit\d$/.test(e.code)) k = e.code.slice(5);
            else if (k === ' ') k = 'Espacio'; else if (k === 'Delete') k = 'Supr'; else if (k === 'Escape') k = 'Esc';
            else if (k === 'Enter') k = 'Intro'; else if (k === 'Backspace') k = 'Retroceso';
            else if (k.length === 1) k = k.toUpperCase();
            return [(e.ctrlKey || e.metaKey) && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Mayús', k].filter(Boolean).join('+');
        }
        const TECLAS_RESERVADAS = ['Esc', 'Intro', 'Retroceso', 'Tab', 'Mayús+Tab'];
        function idDeCombo(c) {
            for (const [id, t] of Object.entries(CONF_ATAJOS.teclas)) if (t.includes(c)) return id;
            for (const a of ACCIONES_BASE) if (!CONF_ATAJOS.teclas[a.id] && a.teclas.includes(c)) return a.id;
            return null;
        }
        let capturaAtajo = null; // id de la orden a la que se está asignando un atajo (editor)
        window.addEventListener('keydown', e => {
            if (capturaAtajo) { e.preventDefault(); e.stopImmediatePropagation(); capturarAtajo(e); return; }
            const c = comboDe(e); if (!c || TECLAS_RESERVADAS.includes(c)) return;
            const id = idDeCombo(c); if (!id) return;
            const b = BASE_POR_ID[id], simple = !(e.ctrlKey || e.metaKey || e.altKey);
            if (!(b && b.campo) && !libreDeCampo()) return;
            if (simple && !sinVentanas()) return;
            if (b && b.cuando && !b.cuando()) return;
            e.preventDefault(); e.stopImmediatePropagation(); cerrarMenus();
            ejecutarComando(id);
        }, true);

        // ---------- Editor: CAD > Atajos de teclado ----------
        let vistaAtajos = { pestana: 'teclado', cat: '', texto: '' };
        function abrirEditorAtajos(pestana) {
            if (pestana) vistaAtajos.pestana = pestana;
            cerrarMenus(); pintarEditorAtajos();
            document.querySelector('#modal-red h3 span').innerHTML = '<i class="fa-solid fa-keyboard text-blue-600 mr-1.5"></i> Atajos de teclado y gestos del ratón';
            document.querySelector('#modal-red > div').style.width = 'min(1100px, 96vw)';
            document.getElementById('modal-red').style.display = 'flex';
        }
        const kbd = t => `<kbd class="inline-block bg-slate-100 border border-slate-300 rounded px-1.5 py-0.5 text-[10px] font-mono text-slate-700">${esc(t)}</kbd>`;
        function pintarEditorAtajos(...a) { return PARTES_OK.herr ? pintarEditorAtajos__p.apply(this, a) : cargarParte('herr').then(() => pintarEditorAtajos__p.apply(this, a)); }
        
        function capturarAtajo(e) {
            const c = comboDe(e); if (!c) return;
            const id = capturaAtajo;
            if (c === 'Esc') { capturaAtajo = null; pintarEditorAtajos(); return; }
            if (TECLAS_RESERVADAS.includes(c)) { aviso(`${c} está reservada.`, 'error'); return; }
            const otro = idDeCombo(c);
            capturaAtajo = null;
            if (otro === id) { pintarEditorAtajos(); return; }
            if (otro && !confirm(`${c} ya está asignado a «${otro}». ¿Asignarlo a «${id}» y quitarlo de la otra orden?`)) { pintarEditorAtajos(); return; }
            if (otro) CONF_ATAJOS.teclas[otro] = teclasDe(otro).filter(x => x !== c);
            CONF_ATAJOS.teclas[id] = [...teclasDe(id), c];
            guardarConfAtajos(); pintarEditorAtajos(); aviso(`${c} → ${id}`, 'ok');
        }

        // ---------- Ayuda > Atajos de teclado (consulta; se completa sola con los atajos nuevos) ----------
        function mostrarAtajosAyuda(...a) { return PARTES_OK.herr ? mostrarAtajosAyuda__p.apply(this, a) : cargarParte('herr').then(() => mostrarAtajosAyuda__p.apply(this, a)); }

        // ==================================================================================
        // GESTOS DEL RATÓN: botón derecho pulsado + desplazamiento en una dirección = orden asignada
        // ==================================================================================
        const DIRS8 = ['E', 'SE', 'S', 'SO', 'O', 'NO', 'N', 'NE'], DIRS4 = ['E', 'S', 'O', 'N'];
        const NOMBRE_DIR = { N: 'Arriba', NE: 'Arriba derecha', E: 'Derecha', SE: 'Abajo derecha', S: 'Abajo', SO: 'Abajo izquierda', O: 'Izquierda', NO: 'Arriba izquierda' };
        const ANG_DIR = { E: 0, SE: 45, S: 90, SO: 135, O: 180, NO: 225, N: 270, NE: 315 };
        const GESTOS_FABRICA = { N: 'Edición › Paleta de comandos...', NE: 'Insertar › Trazar tubería (tramos y codos)', E: 'Zoom › Todo', SE: 'Zoom › Ajustar', S: 'Cálculo › Calcular red...', SO: 'Edición › Rehacer', O: 'Edición › Deshacer', NO: 'Edición › Tabla de propiedades...' };
        function confGestos() {
            if (!CONF_ATAJOS.gestos) CONF_ATAJOS.gestos = { activo: true, n: 8, dir: Object.assign({}, GESTOS_FABRICA) };
            const g = CONF_ATAJOS.gestos; if (g.n !== 4) g.n = 8; if (!g.dir) g.dir = Object.assign({}, GESTOS_FABRICA);
            return g;
        }
        const comandoPorId = id => id && listaComandos().find(c => c.id === id);
        const textoCorto = id => { const c = comandoPorId(id); if (!c) return ''; const t = c.texto.split(' › ').pop().replace(/\.\.\.$/, '').replace(/ \(.*\)$/, ''); return c.cat === 'Zoom' ? 'Zoom ' + t.toLowerCase() : t; };
        // guía propia: círculo con sectores y el nombre de la orden de cada dirección
        function svgGuiaGestos(G, activa, ancho) {
            const dirs = G.n === 4 ? DIRS4 : DIRS8, R = 62, r = 20, W = ancho || 300, H = Math.round(W * 0.72), cx = W / 2, cy = H / 2, paso = 360 / dirs.length;
            const pt = (a, rr) => [cx + rr * Math.cos(a * Math.PI / 180), cy + rr * Math.sin(a * Math.PI / 180)];
            let s = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="font-family:sans-serif">`;
            dirs.forEach(d => {
                const a = ANG_DIR[d], a0 = a - paso / 2, a1 = a + paso / 2, [x0, y0] = pt(a0, R), [x1, y1] = pt(a1, R), [x2, y2] = pt(a1, r), [x3, y3] = pt(a0, r);
                s += `<path d="M ${x0} ${y0} A ${R} ${R} 0 0 1 ${x1} ${y1} L ${x2} ${y2} A ${r} ${r} 0 0 0 ${x3} ${y3} Z" fill="${d === activa ? '#2563eb' : '#eef2f7'}" stroke="#94a3b8" stroke-width="0.8"/>`;
                const [lx, ly] = pt(a, R + 10), anc = Math.abs(Math.cos(a * Math.PI / 180)) < 0.3 ? 'middle' : Math.cos(a * Math.PI / 180) > 0 ? 'start' : 'end';
                const t = textoCorto(G.dir[d]) || '—';
                s += `<text x="${lx}" y="${ly + 3}" font-size="9.5" text-anchor="${anc}" fill="${d === activa ? '#1d4ed8' : '#334155'}" font-weight="${d === activa ? 'bold' : 'normal'}">${esc(t.length > 26 ? t.slice(0, 25) + '…' : t)}</text>`;
            });
            s += `<circle cx="${cx}" cy="${cy}" r="${r - 4}" fill="#fff" stroke="#94a3b8"/><path d="M ${cx - 4} ${cy - 7} h 8 v 10 a 4 4 0 0 1 -8 0 z" fill="none" stroke="#475569" stroke-width="1.2"/><line x1="${cx}" y1="${cy - 7}" x2="${cx}" y2="${cy - 2}" stroke="#475569" stroke-width="1"/>`;
            return s + '</svg>';
        }
        let gesto = null, suprimirCtx = false;
        const dirDe = (dx, dy, n) => { const a = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360, dirs = n === 4 ? DIRS4 : DIRS8, paso = 360 / dirs.length; return dirs[Math.round(a / paso) % dirs.length]; };
        canvasContainer.addEventListener('mousedown', e => { if (e.button === 2 && confGestos().activo) { gesto = { x0: e.clientX, y0: e.clientY, dir: null, ctx: null }; } }, true);
        window.addEventListener('mousemove', e => {
            if (!gesto) return;
            const dx = e.clientX - gesto.x0, dy = e.clientY - gesto.y0, G = confGestos();
            gesto.dir = Math.hypot(dx, dy) > 30 ? dirDe(dx, dy, G.n) : null;
            let g = document.getElementById('guia-gestos');
            if (gesto.dir || g) {
                if (!g) { g = document.createElement('div'); g.id = 'guia-gestos'; g.style.cssText = 'position:fixed; z-index:3600; pointer-events:none; background:rgba(255,255,255,.93); border:1px solid #cbd5e1; border-radius:10px; box-shadow:0 6px 18px rgba(0,0,0,.15)'; document.body.appendChild(g); }
                g.innerHTML = svgGuiaGestos(G, gesto.dir, 300); g.style.left = (gesto.x0 - 150) + 'px'; g.style.top = (gesto.y0 - 108) + 'px';
            }
        }, true);
        window.addEventListener('mouseup', e => {
            if (!gesto || e.button !== 2) return;
            const g = gesto; gesto = null; document.getElementById('guia-gestos')?.remove();
            if (g.dir) {
                if (!g.ctx) { suprimirCtx = true; setTimeout(() => { suprimirCtx = false; }, 600); }
                const id = confGestos().dir[g.dir];
                if (id) { cerrarMenus(); setTimeout(() => { if (!ejecutarComando(id)) aviso('Esa orden no está disponible ahora.'); }, 0); }
            } else if (g.ctx) {
                const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: g.ctx.x, clientY: g.ctx.y, button: 2 }); ev.__piping = true; g.ctx.target.dispatchEvent(ev);
            }
        }, true);
        canvasContainer.addEventListener('contextmenu', e => {
            if (e.__piping) return;
            if (gesto) { e.preventDefault(); e.stopImmediatePropagation(); gesto.ctx = { target: e.target, x: e.clientX, y: e.clientY }; return; } // (macOS / Linux: el menú llega al pulsar)
            if (suprimirCtx) { e.preventDefault(); e.stopImmediatePropagation(); suprimirCtx = false; }
        }, true);

        // ==================================================================================
        // MENÚ CONTEXTUAL CON ÓRDENES ALREDEDOR DEL CURSOR (píldoras) + lista debajo
        // ==================================================================================
        const POS_MARCA = { N: [0, -76], NE: [88, -48], E: [104, -6], SE: [88, 36], S: [0, 60], SO: [-88, 36], O: [-104, -6], NO: [-88, -48] };
        let accionesMarcas = {};
        function pintarMarcas(x, y, marcas) {
            quitarMarcas();
            const cont = document.createElement('div'); cont.id = 'marcas-menu'; cont.style.cssText = 'position:fixed; left:0; top:0; z-index:3490; pointer-events:none';
            accionesMarcas = {};
            Object.entries(marcas).forEach(([d, m]) => {
                if (!m || !POS_MARCA[d]) return;
                accionesMarcas[d] = m.accion;
                const [ox, oy] = POS_MARCA[d], b = document.createElement('button');
                b.type = 'button'; b.className = 'marca-menu'; b.disabled = m.habilitado === false;
                b.innerHTML = `<span>${esc(m.texto)}</span><i class="fa-solid ${m.icono || 'fa-angle-right'}"></i>`;
                b.style.left = (x + ox) + 'px'; b.style.top = (y + oy) + 'px';
                b.onclick = ev => { ev.stopPropagation(); cerrarMenus(); try { m.accion(); } catch (err) { if (!esErrorCongelado(err)) throw err; refrescarTrasCongelado(); } };
                cont.appendChild(b);
            });
            document.body.appendChild(cont);
        }
        function quitarMarcas() { document.getElementById('marcas-menu')?.remove(); }
        function marcasLienzo() {
            const G = confGestos(), dirs = G.n === 4 ? DIRS4 : DIRS8, out = {};
            dirs.forEach(d => { const id = G.dir[d], c = comandoPorId(id); if (c) out[d] = { texto: textoCorto(id), icono: c.icono === 'fa-keyboard' ? 'fa-angle-right' : c.icono, accion: () => ejecutarComando(id) }; });
            return out;
        }
        function marcasElemento(el) {
            const giro = inc => () => { seleccion.clear(); idSeleccionado = el.id; girar45(inc); };
            return {
                N: { texto: 'Editar', icono: 'fa-pen-to-square', accion: () => abrirVentanaElemento(el.id) },
                NE: { texto: 'Girar 45° horario', icono: 'fa-rotate-right', accion: giro(45) },
                E: { texto: 'Mover', icono: 'fa-arrows-up-down-left-right', accion: () => { el._suelto = true; aviso('Liberado del imantado: arrástralo a su nueva posición.'); } },
                SE: { texto: 'Copiar', icono: 'fa-copy', accion: () => { seleccion.clear(); seleccionarElemento(el.id); copiarSeleccion(); } },
                S: { texto: 'Eliminar', icono: 'fa-trash-can', accion: () => eliminarElemento(el.id) },
                SO: esAnotacion(el) ? null : { texto: 'Nota anclada', icono: 'fa-note-sticky', accion: () => insertarNotaAnclada(el) },
                O: { texto: 'Girar 45° antihorario', icono: 'fa-rotate-left', accion: giro(-45) },
                NO: { texto: 'Tabla de propiedades', icono: 'fa-table-cells-large', accion: () => abrirTablaPropiedades(GRUPOS_MASIVO.some(g => g[0] === el.type) ? el.type : undefined) }
            };
        }

        // ==================================================================================
        // 1) REPETIR LA ÚLTIMA ORDEN (Intro o barra espaciadora en el lienzo) y
        // 2) INSERTAR VARIOS SEGUIDOS (clic en un componente del panel: queda "en la mano")
        // ==================================================================================
        let ultimaOrden = null;   // { tipo: 'insertar', data, nombre } | { tipo: 'trazar' }
        let enMano = null;        // { data, n } componente cogido del panel
        let ratonHoja = null;     // última posición del ratón sobre la hoja (px de hoja)
        canvasContainer.addEventListener('mousemove', e => { ratonHoja = puntoHoja(e); if (enMano) pintarFantasma(); });
        canvasContainer.addEventListener('mouseleave', () => { document.getElementById('fantasma-mano')?.remove(); });
        function registrarInsercion(data) {
            if (!data || data.type === 'anotacion') return;
            ultimaOrden = { tipo: 'insertar', data: Object.assign({}, data), nombre: data.name || nombreTipo({ type: data.type, subtype: data.subtype }) };
        }
        function repetirUltimaOrden() {
            if (!ultimaOrden) { aviso('Todavía no hay ninguna orden que repetir.'); return; }
            if (ultimaOrden.tipo === 'trazar') { iniciarTrazado(); return; }
            const p = ratonHoja || (() => { const c = centroVista(); return { x: c.x + 25, y: mundoAScreenY(c.y) + 25 }; })();
            insertarComponente(Object.assign({}, ultimaOrden.data), p.x, p.y);
        }
        const textoUltimaOrden = () => !ultimaOrden ? '' : ultimaOrden.tipo === 'trazar' ? 'Trazar tubería' : 'Insertar ' + ultimaOrden.nombre;
        // Intro / Espacio: repetir (fuera de campos, ventanas, trazado y sin el componente en la mano)
        window.addEventListener('keydown', e => {
            if (capturaAtajo || e.ctrlKey || e.metaKey || e.altKey) return;
            if (e.key !== 'Enter' && e.key !== ' ') return;
            if (!libreDeCampo() || !sinVentanas() || enMano) return;
            const a = document.activeElement; if (a && a.tagName === 'BUTTON') return;
            e.preventDefault(); e.stopPropagation(); repetirUltimaOrden();
        }, true);
        // Coger del panel (clic sin arrastrar): cada clic en la hoja inserta otro igual; Esc o botón derecho termina
        function cogerDelPanel(div) {
            if (!proyectoDefinido()) { pantallaInicio(); return; }
            if (planoCongelado) { avisarCongelado(); return; }
            if (typeof traza !== 'undefined' && traza) cancelarTrazado();
            const data = Object.assign({}, div.dataset);
            enMano = { data, n: 0 };
            canvasContainer.style.cursor = 'copy';
            aviso(`${data.name || 'Componente'} en la mano: clic en la hoja para insertar (uno tras otro) · Esc o botón derecho para terminar.`);
        }
        function soltarMano(avisar) { if (!enMano) return; enMano = null; document.getElementById('fantasma-mano')?.remove(); document.getElementById('pista-snap')?.remove(); canvasContainer.style.cursor = 'default'; if (avisar) aviso('Inserción terminada.'); }
        function pintarFantasma() {
            if (!enMano || !ratonHoja) return;
            let g = document.getElementById('fantasma-mano');
            if (!g) { g = document.createElementNS('http://www.w3.org/2000/svg', 'g'); g.id = 'fantasma-mano'; g.setAttribute('pointer-events', 'none'); g.setAttribute('opacity', '0.45'); }
            const d = enMano.data, P = paleta();
            const el = { type: d.type, subtype: d.subtype || '', excentrica: d.excentrica === 'true', material: d.material, serie: d.serie, dn: d.dn || 'DN 50', longitud: +d.longitud || 3000, scale: 1, rotation: 0 };
            g.innerHTML = d.type === 'tuberia' ? `<line x1="0" y1="25" x2="100" y2="25" stroke="${P.base}" stroke-width="2.2"/>` : d.type === 'bomba' ? simboloBomba(P.base, P) : simboloSVG(el, P.base, P);
            g.setAttribute('transform', `translate(${(ratonHoja.x - 25).toFixed(1)}, ${(ratonHoja.y - 25).toFixed(1)})`);
            svgCanvas.appendChild(g);
            // pista del punto de conexión o de corte de tubería (como al arrastrar desde el panel)
            let t = puertoLibreCercano(ratonHoja.x, ratonHoja.y, null);
            if (!t) { const m = tuberiaBajoPunto(ratonHoja.x, ratonHoja.y); if (m) t = { x: m.A.x + m.ux * m.s, y: m.A.y + m.uy * m.s }; }
            let c = document.getElementById('pista-snap');
            if (!t) { if (c) c.remove(); return; }
            if (!c) { c = document.createElementNS('http://www.w3.org/2000/svg', 'circle'); c.setAttribute('id', 'pista-snap'); c.setAttribute('r', '7'); c.setAttribute('fill', 'rgba(245,158,11,.25)'); c.setAttribute('stroke', '#f59e0b'); c.setAttribute('stroke-width', '2'); c.setAttribute('pointer-events', 'none'); }
            c.setAttribute('cx', t.x); c.setAttribute('cy', t.y); svgCanvas.appendChild(c);
        }
        canvasContainer.addEventListener('mousedown', e => {
            if (!enMano) return;
            if (e.button === 2) { e.preventDefault(); e.stopPropagation(); gesto = null; soltarMano(true); suprimirCtx = true; setTimeout(() => { suprimirCtx = false; }, 600); return; }
            if (e.button !== 0) return;
            if (nuevoPendiente) return; // hay una ventana de inserción abierta
            e.preventDefault(); e.stopPropagation();
            const p = puntoHoja(e), data = Object.assign({}, enMano.data);
            document.getElementById('fantasma-mano')?.remove(); document.getElementById('pista-snap')?.remove();
            enMano.n++;
            insertarComponente(data, p.x, p.y);
            // a partir del segundo, si hereda línea y datos de su conexión, se acepta sin preguntar
            if (enMano && enMano.n > 1 && nuevoPendiente && !nuevoPendiente.propuesta && !nuevoPendiente.necesitaK) confirmarModalNuevo();
        }, true);
        window.addEventListener('keydown', e => { if (enMano && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); soltarMano(true); } }, true);

        // ==================================================================================
        // 5) ESTIRAR UNA TUBERÍA ARRASTRANDO SU EXTREMO (asas en la tubería seleccionada)
        // Extremo b: queda fijo a y lo conectado aguas abajo se desplaza. Extremo a (solo si está libre y b
        // conectado): queda fijo b. Pasos de 10 mm (Mayús: 1 mm).
        // ==================================================================================
        let estiraTubo = null;
        function pintarAsasTuberia() {
            document.querySelectorAll('.asa-tubo').forEach(x => x.remove());
            if (planoCongelado || seleccion.size > 1 || !idSeleccionado) return;
            const t = elementosRed.find(e => e.id === idSeleccionado); if (!t || t.type !== 'tuberia') return;
            const pp = obtenerPuertosConexion(t), vec = vecinosDe(t), A = pp.find(p => p.id === 'a'), B = pp.find(p => p.id === 'b');
            const libreA = !vec.some(v => v.puertoEl === 'a'), conB = vec.some(v => v.puertoEl === 'b');
            const asa = (p, extremo) => {
                const c = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                const t2 = 5 / zoomScale; // tamaño constante en pantalla (10 px)
                c.setAttribute('class', 'asa-tubo'); c.setAttribute('x', p.x - t2); c.setAttribute('y', p.y - t2); c.setAttribute('width', 2 * t2); c.setAttribute('height', 2 * t2);
                c.setAttribute('fill', '#fff'); c.setAttribute('stroke', '#f59e0b'); c.setAttribute('stroke-width', 1.6 / zoomScale); c.style.cursor = 'ew-resize';
                const tit = document.createElementNS('http://www.w3.org/2000/svg', 'title'); tit.textContent = 'Arrastra para cambiar la longitud (Mayús: pasos de 1 mm)'; c.appendChild(tit);
                c.addEventListener('mousedown', ev => {
                    if (ev.button !== 0) return; ev.stopPropagation(); ev.preventDefault();
                    guardarEstado();
                    const fijo = extremo === 'b' ? A : B, movil = extremo === 'b' ? B : A, L = Math.hypot(movil.x - fijo.x, movil.y - fijo.y) || 1;
                    estiraTubo = { t, extremo, fijo: { x: fijo.x, y: fijo.y }, u: { x: (movil.x - fijo.x) / L, y: (movil.y - fijo.y) / L }, L0: t.longitud };
                });
                svgCanvas.appendChild(c);
            };
            asa(B, 'b');
            if (libreA && conB) asa(A, 'a');
        }
        window.addEventListener('mousemove', e => {
            if (!estiraTubo) return;
            const q = estiraTubo, p = puntoHoja(e), s = (p.x - q.fijo.x) * q.u.x + (p.y - q.fijo.y) * q.u.y;
            const paso = e.shiftKey ? 1 : 10, dz = Math.abs((+q.t.cotaB || 0) - (+q.t.cotaA || 0)) * 1000;
            const L = Math.max(10, Math.ceil(dz / paso) * paso, Math.round(s * 30 / paso) * paso);
            if (L !== q.t.longitud) { aplicarCambio(q.t, 'longitud', L); renderizarVectorial(); }
            let et = document.getElementById('etq-estira');
            if (!et) { et = document.createElement('div'); et.id = 'etq-estira'; et.style.cssText = 'position:fixed; z-index:3600; pointer-events:none; background:#1e293b; color:#fff; font-size:11px; padding:2px 6px; border-radius:4px'; document.body.appendChild(et); }
            et.style.left = (e.clientX + 14) + 'px'; et.style.top = (e.clientY + 10) + 'px';
            et.textContent = `L = ${q.t.longitud} mm${q.L0 !== q.t.longitud ? ` (${q.t.longitud > q.L0 ? '+' : ''}${q.t.longitud - q.L0})` : ''}`;
        });
        window.addEventListener('mouseup', () => {
            if (!estiraTubo) return;
            const q = estiraTubo; estiraTubo = null; document.getElementById('etq-estira')?.remove();
            if (q.t.longitud === q.L0 && historialUndo.length) { historialUndo.pop(); actualizarBotonesHistorial(); }
            else { invalidarResultados(); aviso(`${tagDe(q.t)}: ${q.L0} → ${q.t.longitud} mm.`, 'ok'); }
            renderizarVectorial(); seleccionarElemento(q.t.id);
        });

        // ==================================================================================
        // 18) CONTINUACIÓN ENTRE HOJAS: símbolo "continúa en hoja xx". Se crea su pareja en la hoja de
        // destino (misma línea, mismo enlace). Cálculo > Calcular proyecto completo une las parejas.
        // ==================================================================================
        const esContinuacion = el => el && el.subtype === 'continuacion';
        function todosLosElementos() { return elementosRed.concat(elementosOtrasHojas()); }
        function prepararContinuacion(el) {
            if (!esContinuacion(el)) return;
            if (!el.enlace) { const n = 1 + Math.max(0, ...todosLosElementos().filter(esContinuacion).map(e => parseInt(String(e.enlace || '').slice(1), 10) || 0)); el.enlace = 'C' + n; }
            if (el.hojaDestino == null) { const otra = hojas.find((h, i) => i !== hojaActual); el.hojaDestino = otra ? otra.id : ''; }
        }
        function parejaDe(el) {
            const h = hojas.find(x => x.id === el.hojaDestino); if (!h) return null;
            const lista = hojas.indexOf(h) === hojaActual ? elementosRed : (h.e || []);
            return lista.find(e => esContinuacion(e) && e.enlace === el.enlace && e.id !== el.id) || null;
        }
        // crea la pareja que falte (hoja de destino) con la misma línea
        function sincronizarContinuaciones() {
            if (nuevoPendiente || !hojas.length) return;
            elementosRed.filter(esContinuacion).forEach(el => {
                prepararContinuacion(el);
                if (!el.linea) return; // aún en la ventana de inserción
                const i = hojas.findIndex(h => h.id === el.hojaDestino);
                if (i < 0 || i === hojaActual) return;
                const ya = parejaDe(el);
                if (ya) { if (!ya.linea) { ya.linea = el.linea; asignarNumero(ya, todosLosElementos()); } const hh = hojas[i]; const lin = lineas.find(l => l.id === el.linea); if (lin && hh.l && !hh.l.some(l => l.id === lin.id)) hh.l.push(Object.assign({}, lin, { desde: null })); return; }
                const h = hojas[i]; h.e = h.e || []; h.l = h.l || [];
                const lin = lineas.find(l => l.id === el.linea);
                if (lin && !h.l.some(l => l.id === lin.id)) h.l.push(Object.assign({}, lin, { desde: null }));
                const p = { id: 'sym_' + Date.now() + '_cont', type: 'accesorio', subtype: 'continuacion', name: 'Continuación', x: el.x, y: el.y, scale: 1, rotation: ((el.rotation || 0) + 180) % 360, dn: el.dn, pn: el.pn, linea: el.linea, enlace: el.enlace, hojaDestino: codigoHoja(), modoK: 'crane' };
                normalizarElemento(p); asignarNumero(p, todosLosElementos()); h.e.push(p);
                aviso(`Continuación ${el.enlace}: creada su pareja en la hoja ${h.id} (línea ${el.linea || '—'}).`, 'ok');
            });
        }
        function irAParejaContinuacion(id) {
            const el = elementosRed.find(e => e.id === id); if (!el) return;
            const i = hojas.findIndex(h => h.id === el.hojaDestino); if (i < 0) { aviso('La hoja de destino no existe.', 'error'); return; }
            const enlace = el.enlace; cambiarHoja(i);
            const p = elementosRed.find(e => esContinuacion(e) && e.enlace === enlace); if (p) irAElemento(p.id);
        }
        // Cálculo de todas las hojas a la vez: las parejas de continuación se unen en un mismo nudo
        function calcularProyectoCompleto() {
            cerrarMenus(); sincronizarHoja();
            if (hojas.length < 2) { calcularRed(); return; }
            const guarda = { e: elementosRed, l: lineas, cc: condicionesContorno }, desplazados = [];
            const todos = [], lins = new Map(), cc = {};
            hojas.forEach((h, i) => { (h.e || []).forEach(e => { if (i) { e.x += i * 60000; desplazados.push([e, i * 60000]); } todos.push(e); }); (h.l || []).forEach(l => { if (!lins.has(l.id)) lins.set(l.id, l); }); Object.assign(cc, h.cc || {}); });
            let r, error = null;
            try {
                elementosRed = todos; lineas = [...lins.values()]; condicionesContorno = cc;
                const grafo = construirGrafoRed(), aristas = construirAristas(grafo);
                if (!aristas.length) error = 'No hay elementos conectados.'; else { r = calcularResultado(grafo, aristas); if (r.error) error = r.error; }
            } catch (e) { console.error(e); error = e.message; }
            finally { desplazados.forEach(([e, d]) => { e.x -= d; }); elementosRed = guarda.e; lineas = guarda.l; condicionesContorno = guarda.cc; }
            renderizarVectorial(); renderArbol();
            const hojaDe = id => { const i = hojas.findIndex((h, k) => (k === hojaActual ? elementosRed : h.e || []).some(e => e.id === id)); return i; };
            let h = '';
            if (error) h = `<p class="text-rose-700"><i class="fa-solid fa-circle-exclamation mr-1"></i>${esc(error)}</p>`;
            else {
                const res = r.resultado, fallos = todos.filter(e => e.estado === 'fallo');
                const pares = todos.filter(esContinuacion), emparejadas = pares.filter(e => pares.some(o => o !== e && o.enlace === e.enlace)).length / 2;
                h += `<p>${hojas.length} hojas · ${todos.filter(e => !esAnotacion(e)).length} componentes · ${emparejadas} continuación(es) enlazada(s)${res.lineaCritica ? ` · ruta crítica ${fmt(res.lineaCritica.hfTotal, 2)} m` : ''}</p>`;
                h += fallos.length ? `<p class="font-bold text-rose-700 mt-2">${fallos.length} elemento(s) no cumplen:</p><table class="w-full text-[11px]">${fallos.map(e => { const i = hojaDe(e.id); return `<tr class="border-t border-slate-100"><td class="py-0.5 pr-2 whitespace-nowrap">Hoja ${esc((hojas[i] || {}).id || '?')}</td><td class="pr-2 font-bold">${esc(tagDe(e))}</td><td>${esc(((ultimoResultado || {})[e.id] || { motivos: [] }).motivos.join('; '))}</td><td class="text-right"><button onclick="cerrarModalRed(); if (${i} !== hojaActual) cambiarHoja(${i}); irAElemento('${e.id}')" class="px-2 border rounded text-blue-700">Ir</button></td></tr>`; }).join('')}</table>`
                    : '<p class="text-emerald-700 mt-2"><i class="fa-solid fa-circle-check mr-1"></i>Todo el proyecto cumple los criterios de cálculo.</p>';
                if ((res.avisosRed || []).length) h += `<p class="font-bold text-amber-700 mt-2">Avisos</p><ul class="list-disc ml-5">${res.avisosRed.map(t => `<li>${esc(t)}</li>`).join('')}</ul>`;
            }
            document.getElementById('red-content').innerHTML = `<div class="text-xs">${h}</div>`;
            document.getElementById('red-footer').innerHTML = '<button onclick="cerrarModalRed()" class="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded font-medium">Cerrar</button>';
            document.querySelector('#modal-red h3 span').innerHTML = '<i class="fa-solid fa-layer-group text-blue-600 mr-1.5"></i> Cálculo del proyecto completo';
            document.getElementById('modal-red').style.display = 'flex';
        }

        // ==================================================================================
        // 10) COMPROBAR ANTES DE EMITIR (Archivo > Comprobar antes de emitir…)
        // ==================================================================================
        function comprobarAntesDeEmitir() {
            cerrarMenus(); sincronizarHoja();
            const p = proyecto || {}, filas = [];
            const fila = (ok, titulo, detalle, boton) => filas.push({ ok, titulo, detalle, boton });
            const faltan = [['Nombre del plano', p.nombrePlano || p.instalacion], ['Plano nº', p.planoNumero || p.numero], ['Dibujado por', p.autor], ['Fecha', p.fecha], ['Revisión', p.revision !== '' && p.revision != null ? String(p.revision) : '']].filter(x => !x[1]).map(x => x[0]);
            fila(!faltan.length, 'Cajetín completo', faltan.length ? 'Falta: ' + faltan.join(', ') : 'Nombre, plano nº, autor, fecha y revisión', faltan.length ? ['Completar', 'cerrarModalRed(); abrirDatosProyecto()'] : null);
            const rev = String(p.revision || '0'), regs = (p.revisiones || []).some(r => String(r.rev) === rev);
            fila(regs, `Revisión ${rev} registrada`, regs ? 'Figura en el historial de revisiones' : 'No está en el historial de revisiones del proyecto', regs ? null : ['Registrar', 'cerrarModalRed(); registrarRevision()']);
            hojas.forEach((h, i) => {
                const els = i === hojaActual ? elementosRed : (h.e || []), comps = els.filter(e => !esAnotacion(e));
                const ir = `cerrarModalRed(); if (${i} !== hojaActual) cambiarHoja(${i});`;
                if (!comps.length) { fila(true, `Hoja ${h.id}`, 'Sin componentes', null); return; }
                const sueltos = comps.length > 1 ? comps.filter(e => { const v = vecinosDeEn(e, els); return !v; }) : [];
                fila(!sueltos.length, `Hoja ${h.id}: sin elementos sueltos`, sueltos.length ? sueltos.map(tagDe).join(', ') : `${comps.length} componentes conectados`, sueltos.length ? ['Ir', `${ir} seleccion.clear(); ${JSON.stringify(sueltos.map(e => e.id))}.forEach(id => seleccion.add(id)); actualizarSeleccion();`] : null);
                const ley = els.some(e => e.subtype === 'leyenda'), lis = els.some(e => e.subtype === 'materiales');
                fila(ley && lis, `Hoja ${h.id}: leyenda y listado de componentes`, [ley ? '' : 'falta la leyenda', lis ? '' : 'falta el listado'].filter(Boolean).join(' y ') || 'Presentes', ley && lis ? null : ['Añadir', `${ir} ${ley ? '' : 'colocarLeyenda();'} ${lis ? '' : 'insertarListado(0, 0);'}`]);
                els.filter(esContinuacion).forEach(c => { const dest = hojas.find(x => x.id === c.hojaDestino), di = hojas.indexOf(dest), par = dest && ((di === hojaActual ? elementosRed : dest.e || []).some(e => esContinuacion(e) && e.enlace === c.enlace && e.id !== c.id));
                    fila(!!par, `Hoja ${h.id}: continuación ${c.enlace || ''}`, par ? `Enlazada con la hoja ${dest.id}` : (dest ? `Sin pareja en la hoja ${dest.id}` : 'Sin hoja de destino'), par ? null : ['Ir', `${ir} irAElemento('${c.id}')`]); });
            });
            { const cc = casiConexiones(); fila(!cc.length, `Hoja ${codigoHoja()}: extremos casi unidos`, cc.length ? `${cc.length} pareja(s) a menos de 2 mm sin conectar` : 'Ninguno', cc.length ? ['Unir', 'cerrarModalRed(); corregirConexiones()'] : null); }
            { const com = hojas.reduce((s_, h, i) => s_ + (i === hojaActual ? elementosRed : h.e || []).filter(e => e.subtype === 'comentario' && e.estadoCom !== 'resuelto').length, 0); fila(!com, 'Comentarios de revisión resueltos', com ? `${com} comentario(s) abiertos` : 'Sin comentarios abiertos', com ? ['Ver', 'cerrarModalRed(); verComentarios()'] : null); }
            const actual = ultimoCalculo && ultimoCalculo.huella === huellaRed(), fallos = elementosRed.filter(e => e.estado === 'fallo').length;
            const hayCont = todosLosElementos().some(esContinuacion);
            fila(actual && !fallos, `Cálculo de la hoja ${codigoHoja()}`, !actual ? 'Sin calcular o con cambios posteriores al cálculo' : fallos ? `${fallos} elemento(s) no cumplen` : 'Al día y sin fallos', !actual ? ['Calcular', 'cerrarModalRed(); calcularRed()'] : fallos ? ['Ver avisos', 'cerrarModalRed(); alternarPanelAvisos(true)'] : null);
            if (hayCont) fila(true, 'Proyecto con continuaciones entre hojas', 'Comprueba el conjunto con Cálculo > Calcular proyecto completo', ['Calcular todo', 'calcularProyectoCompleto()']);
            fila(!hayCambiosSinGuardar, 'Proyecto guardado', hayCambiosSinGuardar ? 'Hay cambios sin guardar en el archivo' : 'Sin cambios pendientes', hayCambiosSinGuardar ? ['Guardar', 'cerrarModalRed(); guardarProyecto()'] : null);
            const nOk = filas.filter(f => f.ok).length;
            document.getElementById('red-content').innerHTML = `<p class="text-[11px] mb-2 ${nOk === filas.length ? 'text-emerald-700' : 'text-amber-700'}"><b>${nOk} de ${filas.length}</b> comprobaciones correctas.${nOk === filas.length ? ' El plano está listo para emitir (puedes congelarlo: botón derecho en el lienzo > Congelar plano).' : ''}</p>
                <table class="w-full text-[11px]">${filas.map(f => `<tr class="border-t border-slate-100"><td class="py-1 w-6"><i class="fa-solid ${f.ok ? 'fa-circle-check text-emerald-600' : 'fa-circle-xmark text-rose-600'}"></i></td><td class="font-bold pr-2">${esc(f.titulo)}</td><td class="text-slate-600">${esc(f.detalle)}</td><td class="text-right">${f.boton ? `<button onclick="${f.boton[1].replace(/"/g, '&quot;')}" class="px-2 py-0.5 border rounded text-blue-700 hover:bg-blue-50">${esc(f.boton[0])}</button>` : ''}</td></tr>`).join('')}</table>`;
            document.getElementById('red-footer').innerHTML = `<div class="flex gap-2 w-full text-xs"><button onclick="comprobarAntesDeEmitir()" class="px-3 py-1.5 bg-white hover:bg-slate-50 border border-slate-300 rounded"><i class="fa-solid fa-rotate mr-1"></i>Volver a comprobar</button><span class="flex-1"></span><button onclick="cerrarModalRed()" class="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded font-medium">Cerrar</button></div>`;
            document.querySelector('#modal-red h3 span').innerHTML = '<i class="fa-solid fa-list-check text-blue-600 mr-1.5"></i> Comprobar antes de emitir';
            document.querySelector('#modal-red > div').style.width = 'min(900px, 96vw)';
            document.getElementById('modal-red').style.display = 'flex';
        }
        // ¿tiene alguna conexión el elemento dentro de la lista dada? (para hojas no activas)
        function vecinosDeEn(el, lista) {
            const mios = obtenerPuertosConexion(el);
            return lista.some(o => o.id !== el.id && !esAnotacion(o) && obtenerPuertosConexion(o).some(po => mios.some(pm => Math.hypot(po.x - pm.x, po.y - pm.y) < 1)));
        }

        // ==================================================================================
        // 22) GUARDADO AUTOMÁTICO: copia en el navegador en cada cambio (ya existente), copias de
        // seguridad con fecha (Archivo > Recuperar copia de seguridad…), guardado automático en el
        // archivo .pid cada N minutos (Opciones > Guardado automático) y recuperación al arrancar.
        // ==================================================================================
        const CLAVE_COPIAS = 'piping-copias';
        function leerCopias() { try { return JSON.parse(localStorage.getItem(CLAVE_COPIAS) || '[]'); } catch (e) { return []; } }
        function hacerCopiaSeguridad(motivo) {
            if (!proyecto.numero && !elementosRed.length) return;
            try {
                const c = leerCopias(), contenido = generarContenido('pid');
                if (c[0] && c[0].contenido === contenido) return;
                c.unshift({ fecha: new Date().toISOString(), numero: proyecto.numero || '', archivo: nombreArchivoActual || '', motivo: motivo || 'automática', n: todosLosElementos().length, contenido });
                while (c.length > 8) c.pop();
                let txt = JSON.stringify(c); while (txt.length > 4e6 && c.length > 1) { c.pop(); txt = JSON.stringify(c); }
                localStorage.setItem(CLAVE_COPIAS, txt);
            } catch (e) { /* almacenamiento lleno */ }
        }
        setInterval(() => { if (hayCambiosSinGuardar) hacerCopiaSeguridad('automática'); }, 5 * 60000);
        let temporizadorArchivo = null;
        function programarGuardadoArchivo() {
            clearInterval(temporizadorArchivo);
            const min = +opciones.autoArchivoMin || 0; if (!min) return;
            temporizadorArchivo = setInterval(async () => {
                if (!hayCambiosSinGuardar || !currentFileHandle || nuevoPendiente) return;
                try { const w = await currentFileHandle.createWritable(); await w.write(generarContenido('pid')); await w.close(); marcarCambios(false); aviso(`Guardado automático en ${nombreArchivoActual || 'el archivo'}.`, 'ok'); } catch (e) { console.warn(e); }
            }, min * 60000);
        }
        setTimeout(programarGuardadoArchivo, 0);
        function fijarGuardadoArchivo(min) { opciones.autoArchivoMin = min; try { localStorage.setItem('piping-auto-archivo', String(min)); } catch (e) { } programarGuardadoArchivo(); aviso(min ? `Guardado automático en el archivo .pid cada ${min} min (cuando el proyecto se ha guardado o abierto como archivo).` : 'Guardado automático en el archivo desactivado (sigue la copia en el navegador).', 'ok'); }
        try { const m = +localStorage.getItem('piping-auto-archivo'); if (m > 0) opciones.autoArchivoMin = m; } catch (e) { }
        const fechaHora = f => { const d = new Date(f); return d.toLocaleDateString('es-ES') + ' ' + d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }); };
        function recuperarCopia() {
            cerrarMenus();
            const c = leerCopias(), u = leerUltimoGuardado();
            const filas = [];
            if (u && u.contenido) filas.push({ t: 'Último estado de trabajo', f: u.fecha, numero: u.numero, archivo: u.archivo, n: u.n, pend: u.guardado === false, k: 'ultimo' });
            c.forEach((x, i) => filas.push({ t: 'Copia ' + x.motivo, f: x.fecha, numero: x.numero, archivo: x.archivo, n: x.n, k: i }));
            document.getElementById('red-content').innerHTML = filas.length ? `<p class="text-[11px] text-slate-500 mb-2">Copias guardadas en este navegador (la última de trabajo en cada cambio y una copia de seguridad cada 5 minutos con cambios, hasta 8).</p>
                <table class="w-full text-[11px]"><thead><tr class="text-left text-slate-500"><th class="py-1">Copia</th><th>Fecha</th><th>Proyecto</th><th>Archivo</th><th>Elementos</th><th></th></tr></thead><tbody>${filas.map(x => `<tr class="border-t border-slate-100"><td class="py-1 font-bold">${esc(x.t)}${x.pend ? ' <span class="text-amber-600 font-normal">(cambios sin guardar)</span>' : ''}</td><td>${fechaHora(x.f)}</td><td>${esc(x.numero || '—')}</td><td>${esc(x.archivo || '—')}</td><td>${x.n || 0}</td><td class="text-right"><button onclick="abrirCopia('${x.k}')" class="px-2 py-0.5 border rounded text-blue-700 hover:bg-blue-50">Abrir</button></td></tr>`).join('')}</tbody></table>` : '<p class="text-slate-400 italic">No hay copias en este navegador.</p>';
            document.getElementById('red-footer').innerHTML = '<button onclick="cerrarModalRed()" class="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded font-medium">Cerrar</button>';
            document.querySelector('#modal-red h3 span').innerHTML = '<i class="fa-solid fa-clock-rotate-left text-blue-600 mr-1.5"></i> Recuperar copia de seguridad';
            document.querySelector('#modal-red > div').style.width = 'min(900px, 96vw)';
            document.getElementById('modal-red').style.display = 'flex';
        }
        function abrirCopia(k) {
            const x = k === 'ultimo' ? leerUltimoGuardado() : leerCopias()[+k]; if (!x || !x.contenido) return;
            if (hayCambiosSinGuardar && !confirm('Hay cambios sin guardar que se perderán (quedan en las copias). ¿Abrir la copia?')) return;
            hacerCopiaSeguridad('antes de recuperar');
            try { cargarProyectoDesdeTexto(x.contenido); nombreArchivoActual = x.archivo || ''; currentFileHandle = null; historialUndo = []; historialRedo = []; actualizarBotonesHistorial(); marcarCambios(true); renderizarVectorial(); renderArbol(); zoomTodo(); cerrarModalRed(); aviso(`Copia del ${fechaHora(x.fecha)} abierta. Guárdala con Archivo > Guardar como.`, 'ok'); }
            catch (e) { console.error(e); aviso('No se ha podido abrir la copia.', 'error'); }
        }

        // tras cada redibujado: parejas de continuación y asas de la tubería seleccionada
        { const _rv = renderizarVectorial; renderizarVectorial = function () { try { sincronizarContinuaciones(); } catch (e) { console.error(e); } _rv.apply(this, arguments); pintarAsasTuberia(); }; }
        // ==================================================================================
        // 11) RESALTAR AL PASAR POR EL ÁRBOL y PARPADEO AL IR A UN ELEMENTO
        // ==================================================================================
        let resaltadoLinea = null, resaltadoElem = null, parpadeoId = null, tParpadeo = null;
        function resaltarLinea(id) { resaltadoLinea = id; aplicarResaltado(); }
        function resaltarElemento(id) { resaltadoElem = id; aplicarResaltado(); }
        function aplicarResaltado() {
            const porId = {}; elementosRed.forEach(e => { porId[e.id] = e; });
            svgCanvas.querySelectorAll('g[data-id]').forEach(g => {
                const el = porId[g.getAttribute('data-id')]; if (!el) return;
                g.classList.toggle('resaltado', !!((resaltadoLinea && el.linea === resaltadoLinea) || (resaltadoElem && el.id === resaltadoElem)));
                g.classList.toggle('parpadeo', el.id === parpadeoId);
                if (comparacion) { g.classList.toggle('cmp-nuevo', comparacion.nuevos.has(el.id)); g.classList.toggle('cmp-cambiado', comparacion.cambiados.has(el.id)); }
            });
        }
        { const _ir = irAElemento; irAElemento = function (id) { _ir(id); parpadeoId = id; clearTimeout(tParpadeo); aplicarResaltado(); tParpadeo = setTimeout(() => { parpadeoId = null; aplicarResaltado(); }, 1700); }; }

        // ==================================================================================
        // 12) SENTIDO DE FLUJO INCOHERENTE: botón "Invertir" (retenciones y componentes en línea)
        // ==================================================================================
        function invertirComponente(id) {
            const el = elementosRed.find(e => e.id === id); if (!el) return;
            guardarEstado(); invalidarResultados();
            // giro de 180° sobre su centro: los puertos a y b (simétricos) intercambian su posición y siguen conectados
            el.rotation = (((el.rotation || 0) + 180) % 360 + 360) % 360;
            renderizarVectorial(); seleccionarElemento(el.id);
            aviso(`${tagDe(el)} invertido: el sentido del símbolo sigue ahora al del caudal.`, 'ok');
        }

        // ==================================================================================
        // 17) CURVA DE LA BOMBA PEGADA DESDE EXCEL (Q-H): ajuste H = H0 − k·Q² por mínimos cuadrados
        // ==================================================================================
        let curvaVista = { id: null, texto: '', uQ: 'm3h', uH: 'm' };
        function abrirCurvaBomba(id) {
            const el = elementosRed.find(e => e.id === id); if (!el) return;
            curvaVista = { id, texto: (el.curva || []).map(p => [p[0], +(p[1] * 1e5 / (fluidoActual().rho * G)).toFixed(2), p[2] == null ? (p[3] == null ? null : '-') : +(p[2] * 100).toFixed(1), p[3]].filter(x => x != null).join('\t')).join('\n'), uQ: 'm3h', uH: 'm', modo: el.curvaModo || (el.curva ? 'ajuste' : 'puntos') };
            pintarCurvaBomba();
            document.querySelector('#modal-red h3 span').innerHTML = `<i class="fa-solid fa-chart-line text-blue-600 mr-1.5"></i> Curva Q-H de ${esc(tagDe(el))}`;
            document.querySelector('#modal-red > div').style.width = 'min(900px, 96vw)';
            document.getElementById('modal-red').style.display = 'flex';
        }
        function fluidoActual() { try { return propiedadesFluido(document.getElementById('selector-fluido').value, +document.getElementById('temp-fluido').value || 20) || { rho: 1000 }; } catch (e) { return { rho: 1000 }; } }
        function puntosCurva() {
            const rho = fluidoActual().rho || 1000, pts = [];
            String(curvaVista.texto).split(/\r?\n/).forEach(l => {
                const n = l.trim().replace(/(\d),(\d)/g, '$1.$2').split(/[\t;\s]+/).map(x => x === '' || x === '-' ? NaN : Number(x));
                if (n.length >= 2 && isFinite(n[0]) && isFinite(n[1])) { const Q = curvaVista.uQ === 'ls' ? n[0] * 3.6 : n[0], H = curvaVista.uH === 'm' ? n[1] * rho * G / 1e5 : curvaVista.uH === 'kPa' ? n[1] / 100 : n[1]; if (Q >= 0 && H > 0) pts.push([Q, H, isFinite(n[2]) ? n[2] / 100 : null, isFinite(n[3]) ? n[3] : null]); }
            });
            return pts.sort((a, b) => a[0] - b[0]); // [Q m³/h, H bar]
        }
        function ajusteCurva(pts) {
            if (pts.length < 2) return null;
            const X = pts.map(p => p[0] * p[0]), Y = pts.map(p => p[1]), n = X.length, mx = X.reduce((s, x) => s + x, 0) / n, my = Y.reduce((s, y) => s + y, 0) / n;
            const sxx = X.reduce((s, x) => s + (x - mx) ** 2, 0), sxy = X.reduce((s, x, i) => s + (x - mx) * (Y[i] - my), 0);
            if (sxx < 1e-12) return null;
            const b = sxy / sxx, a = my - b * mx, k = -b, ssr = Y.reduce((s, y, i) => s + (y - (a + b * X[i])) ** 2, 0), sst = Y.reduce((s, y) => s + (y - my) ** 2, 0);
            return { H0: a, k, r2: sst > 0 ? 1 - ssr / sst : 1 };
        }
        function pintarCurvaBomba() {
            const el = elementosRed.find(e => e.id === curvaVista.id); if (!el) return;
            const pts = puntosCurva(), aj = ajusteCurva(pts), rho = fluidoActual().rho || 1000, aM = bar => bar * 1e5 / (rho * G);
            let graf = '<p class="text-slate-400 italic mt-6">Pega al menos dos puntos (caudal y altura, en dos columnas).</p>';
            if (pts.length) {
                const W = 380, H = 240, m = { l: 42, r: 10, t: 10, b: 30 }, Qm = Math.max(...pts.map(p => p[0]), el.caudal || 0) * 1.1 || 1, Hm = Math.max(...pts.map(p => aM(p[1])), aj ? aM(aj.H0) : 0) * 1.1 || 1;
                const X = q => m.l + q / Qm * (W - m.l - m.r), Y = h => H - m.b - h / Hm * (H - m.t - m.b);
                let s = `<svg width="${W}" height="${H}" style="font-family:sans-serif;font-size:9px"><rect x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}" fill="#f8fafc" stroke="#cbd5e1"/>`;
                for (let i = 0; i <= 4; i++) { const q = Qm * i / 4, h = Hm * i / 4; s += `<text x="${X(q)}" y="${H - m.b + 12}" text-anchor="middle" fill="#64748b">${fmt(q, 1)}</text><text x="${m.l - 4}" y="${Y(h) + 3}" text-anchor="end" fill="#64748b">${fmt(h, 1)}</text>`; }
                s += `<text x="${(W + m.l) / 2}" y="${H - 4}" text-anchor="middle" fill="#334155">Q (m³/h)</text><text x="10" y="${m.t + 8}" fill="#334155">H (m)</text>`;
                if (curvaVista.modo === 'puntos' && pts.length >= 2) s += `<path d="${pts.map((p, i) => (i ? 'L' : 'M') + X(p[0]).toFixed(1) + ' ' + Y(aM(p[1])).toFixed(1)).join('')}" fill="none" stroke="#2563eb" stroke-width="2"/>`;
                else if (aj && aj.k > 0) { let d = ''; for (let i = 0; i <= 40; i++) { const q = Qm * i / 40, h = aM(aj.H0 - aj.k * q * q); if (h < 0) break; d += (i ? 'L' : 'M') + X(q).toFixed(1) + ' ' + Y(h).toFixed(1); } s += `<path d="${d}" fill="none" stroke="#2563eb" stroke-width="2"/>`; }
                pts.forEach(p => { s += `<circle cx="${X(p[0])}" cy="${Y(aM(p[1]))}" r="3.2" fill="#f59e0b" stroke="#fff"/>`; });
                if (aj && el.caudal) { const hd = aj.H0 - aj.k * el.caudal * el.caudal; if (hd > 0) s += `<circle cx="${X(el.caudal)}" cy="${Y(aM(hd))}" r="4.5" fill="none" stroke="#16a34a" stroke-width="2"/>`; }
                graf = s + '</svg>';
            }
            const okAj = aj && aj.k > 0, porPuntos = curvaVista.modo === 'puntos', okAplicar = porPuntos ? pts.length >= 2 : okAj;
            document.getElementById('red-content').innerHTML = `<div class="grid gap-4 text-[11px]" style="grid-template-columns: 1fr 390px"><div>
                <p class="text-slate-500 mb-2">Copia de Excel (o de la hoja del fabricante) las columnas: caudal, altura y, si las tienes, rendimiento (%) y NPSHr (m). También puedes sacar los puntos de una imagen de la curva.</p>
                <div class="flex flex-wrap items-center gap-2 mb-2"><button onclick="digitalizarCurvaElemento()" class="px-2 py-1 border border-blue-300 rounded text-blue-700 hover:bg-blue-50"><i class="fa-solid fa-crosshairs mr-1"></i>Digitalizar desde una imagen...</button>
                <label>Modelo en el cálculo <select onchange="curvaVista.modo = this.value; pintarCurvaBomba()" class="border rounded p-0.5"><option value="puntos" ${porPuntos ? 'selected' : ''}>Interpolación entre los puntos</option><option value="ajuste" ${porPuntos ? '' : 'selected'}>Ajuste H = H₀ − k·Q²</option></select></label></div>
                <div class="flex gap-3 mb-2"><label>Caudal <select onchange="curvaVista.uQ = this.value; pintarCurvaBomba()" class="border rounded p-0.5"><option value="m3h" ${curvaVista.uQ === 'm3h' ? 'selected' : ''}>m³/h</option><option value="ls" ${curvaVista.uQ === 'ls' ? 'selected' : ''}>l/s</option></select></label>
                <label>Altura <select onchange="curvaVista.uH = this.value; pintarCurvaBomba()" class="border rounded p-0.5"><option value="m" ${curvaVista.uH === 'm' ? 'selected' : ''}>m c.l.</option><option value="bar" ${curvaVista.uH === 'bar' ? 'selected' : ''}>bar</option><option value="kPa" ${curvaVista.uH === 'kPa' ? 'selected' : ''}>kPa</option></select></label></div>
                <textarea id="curva-texto" rows="12" oninput="curvaVista.texto = this.value; clearTimeout(window.__tC); window.__tC = setTimeout(() => { pintarCurvaBomba(); const t = document.getElementById('curva-texto'); t.focus(); t.setSelectionRange(t.value.length, t.value.length); }, 400)" class="w-full border rounded p-1 font-mono" placeholder="0\t32&#10;10\t31,5&#10;20\t29,8&#10;30\t26,9">${esc(curvaVista.texto)}</textarea>
                <p class="mt-2">${pts.length} punto(s)${okAj ? ` · H₀ = ${fmt(aM(aj.H0), 2)} m (${fmt(aj.H0, 3)} bar) · k = ${aj.k.toExponential(3)} bar/(m³/h)² · R² = ${aj.r2.toFixed(4)}` : pts.length >= 2 ? ' · <span class="text-rose-600">los puntos no dan una curva descendente</span>' : ''}</p>
                ${okAj && el.caudal ? `<p>En el punto de diseño (${fmt(el.caudal, 2)} m³/h): H = ${fmt(aM(aj.H0 - aj.k * el.caudal * el.caudal), 2)} m</p>` : ''}
                ${okAj && aj.r2 < 0.97 ? '<p class="text-amber-700">El ajuste es pobre (R² &lt; 0,97): revisa los puntos o usa solo el tramo de trabajo.</p>' : ''}</div><div>${graf}<p class="text-[10px] text-slate-400">Puntos (naranja), curva ajustada (azul), punto de diseño (verde).</p></div></div>`;
            document.getElementById('red-footer').innerHTML = `<div class="flex gap-2 w-full text-xs">${el.curva ? '<button onclick="quitarCurvaBomba()" class="px-3 py-1.5 border rounded text-rose-700">Quitar la curva</button>' : ''}<span class="flex-1"></span>
                <button onclick="cerrarModalRed()" class="px-3 py-1.5 border rounded">Cancelar</button><button onclick="aplicarCurvaBomba()" ${okAplicar ? '' : 'disabled'} class="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white rounded font-medium">Aplicar a la bomba</button></div>`;
        }
        function aplicarCurvaBomba() {
            const el = elementosRed.find(e => e.id === curvaVista.id), pts = puntosCurva(), aj = ajusteCurva(pts), porPuntos = curvaVista.modo === 'puntos';
            if (!el || (porPuntos ? pts.length < 2 : !aj || !(aj.k > 0))) return;
            guardarEstado(); invalidarResultados();
            el.curva = pts.map(p => [+p[0].toFixed(3), +p[1].toFixed(4), p[2], p[3]]);
            el.curvaModo = porPuntos ? 'puntos' : 'ajuste';
            const Q = el.caudal > 0 ? el.caudal : pts[Math.floor(pts.length / 2)][0];
            el.caudal = +Q.toFixed(3);
            if (porPuntos) { el.h0 = +(pts[0][0] < 1e-6 ? pts[0][1] : (aj && aj.k > 0 ? Math.max(aj.H0, pts[0][1]) : pts[0][1])).toFixed(4); el.presion = +Math.max(0.01, interpolarCurva(el.curva, 1, Q)).toFixed(4); const e = interpolarCurva(el.curva, 2, Q), n = interpolarCurva(el.curva, 3, Q); if (e > 0) el.eta = +e.toFixed(3); if (n > 0) el.npsh = +n.toFixed(2); }
            else { el.h0 = +aj.H0.toFixed(4); el.presion = +Math.max(0.01, aj.H0 - aj.k * Q * Q).toFixed(4); }
            cerrarModalRed(); renderizarVectorial(); seleccionarElemento(el.id);
            aviso(`${tagDe(el)}: curva del fabricante aplicada (H₀ ${fmt(el.h0, 2)} bar; en ${fmt(el.caudal, 1)} m³/h → ${fmt(el.presion, 2)} bar).`, 'ok');
        }
        function digitalizarCurvaElemento() { abrirDigitalizador(filas => { curvaVista.texto = textoDeCurva(filas); curvaVista.uQ = 'm3h'; curvaVista.uH = 'm'; curvaVista.modo = 'puntos'; pintarCurvaBomba(); }); }
        function quitarCurvaBomba() { const el = elementosRed.find(e => e.id === curvaVista.id); if (!el) return; guardarEstado(); delete el.curvaModo; delete el.curva; cerrarModalRed(); seleccionarElemento(el.id); }

        // ==================================================================================
        // 19) HOJAS: duplicar, renombrar y reordenar arrastrando la pestaña
        // ==================================================================================
        function menuPestana(i) {
            return [
                { icono: 'fa-copy', texto: `Duplicar hoja ${hojas[i].id}`, accion: () => duplicarHoja(i) },
                { icono: 'fa-i-cursor', texto: `Renombrar hoja ${hojas[i].id}...`, accion: () => renombrarHoja(i) },
                'sep',
                { icono: 'fa-trash-can', texto: `Eliminar hoja ${hojas[i].id}`, accion: () => eliminarHoja(i) }
            ];
        }
        function siguienteIdHoja() { return String(1 + Math.max(-1, ...hojas.map(h => parseInt(h.id, 10) || 0))).padStart(2, '0'); }
        function duplicarHoja(i) {
            sincronizarHoja();
            const h = hojas[i], mapa = {}, todos = todosLosElementos();
            const e = JSON.parse(JSON.stringify(h.e || [])).map((x, k) => { const n = 'sym_' + Date.now() + '_h' + k; mapa[x.id] = n; x.id = n; return x; });
            e.forEach(x => { if (x.ancla && mapa[x.ancla]) x.ancla = mapa[x.ancla]; if (x.reservaDe && mapa[x.reservaDe]) x.reservaDe = mapa[x.reservaDe]; if (esContinuacion(x)) { delete x.enlace; delete x.hojaDestino; } delete x.estado; });
            const acumulado = todos.slice();
            e.forEach(x => { x.codigo = null; x.num = null; asignarNumero(x, acumulado); acumulado.push(x); });
            const nueva = { id: siguienteIdHoja(), e, l: JSON.parse(JSON.stringify(h.l || [])).map(l => Object.assign(l, { desde: l.desde && mapa[l.desde] ? mapa[l.desde] : l.desde })), cc: {}, formato: h.formato, congelado: false };
            Object.entries(h.cc || {}).forEach(([k, v]) => { const [id, p] = k.split(':'); if (mapa[id]) nueva.cc[mapa[id] + ':' + p] = v; });
            hojas.splice(i + 1, 0, nueva); marcarCambios(true); cargarHoja(i + 1);
            aviso(`Hoja ${h.id} duplicada como ${nueva.id} (componentes renumerados).`, 'ok');
        }
        function renombrarHoja(i) {
            const h = hojas[i], n = (prompt('Nuevo nombre (código) de la hoja:', h.id) || '').trim();
            if (!n || n === h.id) return;
            if (n.length > 8 || /[<>"'&]/.test(n)) { aviso('Nombre no válido (máximo 8 caracteres).', 'error'); return; }
            if (hojas.some(x => x.id === n)) { aviso(`Ya existe la hoja ${n}.`, 'error'); return; }
            sincronizarHoja();
            hojas.forEach(x => (x.e || []).forEach(e => { if (esContinuacion(e) && e.hojaDestino === h.id) e.hojaDestino = n; }));
            h.id = n; marcarCambios(true); pintarHojas(); renderizarVectorial(); renderArbol();
            aviso(`Hoja renombrada: ${n}.`, 'ok');
        }
        let arrastrePestana = null;
        function moverHoja(de, a) {
            if (de === a || de == null) return;
            sincronizarHoja(); const activa = hojas[hojaActual];
            const [h] = hojas.splice(de, 1); hojas.splice(a, 0, h);
            hojaActual = hojas.indexOf(activa); marcarCambios(true); pintarHojas(); renderizarVectorial();
        }
        { const _ph = pintarHojas; pintarHojas = function () {
            _ph();
            const b = document.getElementById('barra-hojas'); if (!b) return;
            [...b.querySelectorAll('button')].slice(0, hojas.length).forEach((btn, i) => {
                btn.draggable = true; btn.title = `Hoja ${hojas[i].id} · arrastra para reordenar · botón derecho: duplicar, renombrar, eliminar`;
                btn.oncontextmenu = ev => { ev.preventDefault(); mostrarMenuContextual(ev.clientX, ev.clientY, menuPestana(i)); };
                btn.ondblclick = () => renombrarHoja(i);
                btn.ondragstart = ev => { arrastrePestana = i; ev.dataTransfer.setData('text/x-hoja', String(i)); };
                btn.ondragover = ev => { if (arrastrePestana != null) { ev.preventDefault(); btn.style.boxShadow = 'inset 3px 0 0 #2563eb'; } };
                btn.ondragleave = () => { btn.style.boxShadow = ''; };
                btn.ondrop = ev => { ev.preventDefault(); btn.style.boxShadow = ''; const de = arrastrePestana; arrastrePestana = null; moverHoja(de, i); };
                btn.ondragend = () => { arrastrePestana = null; };
            });
        }; }

        // ==================================================================================
        // 20) VISTA PREVIA DE IMPRESIÓN y PDF de varias hojas (Archivo > Imprimir…)
        // ==================================================================================
        let impresionSel = null;
        // dibujo de una hoja cualquiera sin cambiar de hoja (se restaura todo)
        
        function abrirImpresion(...a) { return PARTES_OK.cad ? abrirImpresion__p.apply(this, a) : cargarParte('cad').then(() => abrirImpresion__p.apply(this, a)); }
        function imprimirHojas(...a) { return PARTES_OK.cad ? imprimirHojas__p.apply(this, a) : cargarParte('cad').then(() => imprimirHojas__p.apply(this, a)); }

        // ==================================================================================
        // 21) COMPARAR CON UNA REVISIÓN (Archivo > Comparar con revisión…): verde añadido,
        // ámbar modificado, rojo (fantasma) eliminado
        // ==================================================================================
        let comparacion = null;
        function abrirComparacion() {
            cerrarMenus();
            const rs = (proyecto.revisiones || []).filter(r => r.red || r.hojas);
            if (!rs.length) { aviso('No hay revisiones registradas con dibujo (Archivo > Registrar revisión…).', 'error'); return; }
            dialogo('<i class="fa-solid fa-code-compare text-blue-600 mr-1.5"></i>Comparar con revisión', `<p>Hoja ${esc(codigoHoja())}: elige la revisión con la que comparar el dibujo actual.</p>`,
                [...rs.slice().reverse().map(r => ({ texto: `Rev. ${r.rev} · ${fechaDMA(r.fecha)}${r.descripcion ? ' · ' + r.descripcion : ''}`, valor: r.rev, clase: 'bg-white hover:bg-slate-50 border border-slate-300 text-slate-700' })), { texto: 'Cancelar', valor: null }])
                .then(v => { if (v != null) compararCon(rs.find(r => String(r.rev) === String(v))); });
        }
        function compararCon(rev) {
            let antes = null;
            if (rev.hojas) { const h = rev.hojas.find(x => x.id === codigoHoja()); antes = h ? h.e : []; }
            else antes = JSON.parse(rev.red).e;
            antes = (antes || []).filter(e => !esAnotacion(e));
            const ahora = elementosRed.filter(e => !esAnotacion(e)), nuevos = new Set(), cambiados = new Map(), borrados = [];
            ahora.forEach(e => { const a = antes.find(x => x.id === e.id); if (!a) { nuevos.add(e.id); return; } const d = CAMPOS_DIFF.filter(k => String(a[k] ?? '') !== String(e[k] ?? '')); const mov = Math.hypot((a.x || 0) - (e.x || 0), (a.y || 0) - (e.y || 0)) > 1 || (a.rotation || 0) !== (e.rotation || 0); if (d.length || mov) cambiados.set(e.id, d.map(k => `${k}: ${a[k] ?? '—'} → ${e[k] ?? '—'}`).concat(mov ? ['posición'] : [])); });
            antes.forEach(a => { if (!ahora.some(e => e.id === a.id)) borrados.push(a); });
            comparacion = { rev: rev.rev, nuevos, cambiados, borrados };
            renderizarVectorial(); pintarBandaComparacion();
            aviso(`Comparación con la revisión ${rev.rev}: ${nuevos.size} añadido(s), ${cambiados.size} modificado(s), ${borrados.length} eliminado(s).`, 'ok');
        }
        function salirComparacion() { comparacion = null; document.getElementById('banda-comparacion')?.remove(); renderizarVectorial(); }
        function pintarBandaComparacion() {
            let b = document.getElementById('banda-comparacion');
            if (!comparacion) { if (b) b.remove(); return; }
            if (!b) { b = document.createElement('div'); b.id = 'banda-comparacion'; b.className = 'absolute top-9 left-1/2 -translate-x-1/2 z-30 bg-white border border-slate-300 text-[11px] px-3 py-1 rounded shadow flex items-center gap-3'; canvasContainer.parentElement.appendChild(b); }
            const C = comparacion;
            b.innerHTML = `<b>Comparando con la revisión ${esc(String(C.rev))}</b><span class="text-emerald-700"><i class="fa-solid fa-square mr-1"></i>${C.nuevos.size} añadidos</span><span class="text-amber-600"><i class="fa-solid fa-square mr-1"></i>${C.cambiados.size} modificados</span><span class="text-rose-600"><i class="fa-regular fa-square mr-1"></i>${C.borrados.length} eliminados</span><button onclick="listaComparacion()" class="px-2 border rounded text-blue-700">Lista</button><button onclick="salirComparacion()" class="px-2 border rounded"><i class="fa-solid fa-xmark mr-1"></i>Salir</button>`;
        }
        function listaComparacion() {
            const C = comparacion; if (!C) return;
            const f = (tipo, cls, e, det, ir) => `<tr class="border-t border-slate-100"><td class="py-0.5 pr-2 ${cls} font-bold">${tipo}</td><td class="pr-2">${esc(tagDe(e))}</td><td class="text-slate-600">${esc(det)}</td><td>${ir ? `<button onclick="cerrarModalRed(); irAElemento('${e.id}')" class="px-2 border rounded text-blue-700">Ir</button>` : ''}</td></tr>`;
            document.getElementById('red-content').innerHTML = `<table class="w-full text-[11px]">${[...C.nuevos].map(id => f('Añadido', 'text-emerald-700', elementosRed.find(e => e.id === id), nombreTipo(elementosRed.find(e => e.id === id)), true)).join('')}${[...C.cambiados].map(([id, d]) => f('Modificado', 'text-amber-600', elementosRed.find(e => e.id === id), d.join('; '), true)).join('')}${C.borrados.map(e => f('Eliminado', 'text-rose-600', e, nombreTipo(e), false)).join('')}</table>`;
            document.getElementById('red-footer').innerHTML = '<button onclick="cerrarModalRed()" class="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded font-medium">Cerrar</button>';
            document.querySelector('#modal-red h3 span').innerHTML = `<i class="fa-solid fa-code-compare text-blue-600 mr-1.5"></i> Cambios respecto a la revisión ${esc(String(C.rev))}`;
            document.getElementById('modal-red').style.display = 'flex';
        }
        function pintarFantasmasComparacion() {
            document.getElementById('fantasmas-cmp')?.remove();
            if (!comparacion || !comparacion.borrados.length) return;
            const g = document.createElementNS('http://www.w3.org/2000/svg', 'g'); g.id = 'fantasmas-cmp'; g.setAttribute('pointer-events', 'none');
            const P = paleta(), rojo = '#dc2626';
            g.innerHTML = comparacion.borrados.map(e => {
                if (e.type === 'tuberia') { const pp = obtenerPuertosConexion(e); return `<line x1="${pp[0].x}" y1="${pp[0].y}" x2="${pp[1].x}" y2="${pp[1].y}" stroke="${rojo}" stroke-width="2" stroke-dasharray="5,3" opacity=".8"/>`; }
                return `<g transform="translate(${e.x}, ${mundoAScreenY(e.y)}) rotate(${e.rotation || 0}, 25, 25) scale(${e.scale || 1})${trEspejo(e)}" opacity=".75" style="stroke-dasharray:3 2">${e.type === 'bomba' ? simboloBomba(rojo, P) : simboloSVG(e, rojo, P)}</g>`;
            }).join('');
            svgCanvas.appendChild(g);
        }

        // ==================================================================================
        // 23) BARRA DE HERRAMIENTAS RÁPIDA (personalizable en CAD > Atajos de teclado > Barra rápida;
        // también arrastrando una orden de la lista de atajos a la barra)
        // ==================================================================================
        const BARRA_FABRICA = ['Archivo › Guardar', 'Insertar › Trazar tubería (tramos y codos)', 'Edición › Paleta de comandos...', 'Cálculo › Calcular red...', 'Edición › Tabla de propiedades...', 'Zoom › Todo', 'Archivo › Comprobar antes de emitir...'];
        const barraRapida = () => Array.isArray(CONF_ATAJOS.barra) ? CONF_ATAJOS.barra : BARRA_FABRICA;
        function pintarBarraRapida() {
            let b = document.getElementById('barra-rapida');
            if (!b) { const cont = document.getElementById('btn-rehacer')?.parentElement; if (!cont) return; b = document.createElement('div'); b.id = 'barra-rapida'; b.className = 'flex items-center gap-1 ml-2 pl-2 border-l border-slate-200 min-h-[26px] min-w-[40px]'; cont.appendChild(b);
                b.ondragover = ev => { if (ev.dataTransfer.types.includes('text/x-orden')) { ev.preventDefault(); b.classList.add('bg-blue-50'); } };
                b.ondragleave = () => b.classList.remove('bg-blue-50');
                b.ondrop = ev => { b.classList.remove('bg-blue-50'); const id = ev.dataTransfer.getData('text/x-orden'); if (!id) return; ev.preventDefault(); const l = barraRapida().slice(); const de = l.indexOf(id); if (de >= 0) l.splice(de, 1); const destino = ev.target.closest && ev.target.closest('[data-orden]'); const i = destino ? l.indexOf(destino.dataset.orden) : -1; if (i >= 0) l.splice(i, 0, id); else l.push(id); CONF_ATAJOS.barra = l; guardarConfAtajos(); pintarBarraRapida(); if (document.getElementById('modal-red').style.display === 'flex' && vistaAtajos.pestana === 'barra') pintarEditorAtajos(); };
            }
            const cmds = listaComandos();
            b.innerHTML = barraRapida().map(id => { const c = cmds.find(x => x.id === id); if (!c) return ''; const t = teclasDe(id);
                return `<button type="button" data-orden="${esc(id)}" draggable="true" onclick="ejecutarComando(this.dataset.orden)" title="${esc(trad(c.texto))}${t.length ? ' (' + t.join(' / ') + ')' : ''}" class="w-7 h-7 flex items-center justify-center rounded border border-transparent hover:border-slate-300 hover:bg-slate-50 text-blue-600" ondragstart="event.dataTransfer.setData('text/x-orden', this.dataset.orden)"><i class="fa-solid ${c.icono === 'fa-keyboard' ? 'fa-bolt' : c.icono}"></i></button>`; }).join('') || '<span class="text-[10px] text-slate-400 px-1">Arrastra órdenes aquí</span>';
            b.oncontextmenu = ev => { ev.preventDefault(); mostrarMenuContextual(ev.clientX, ev.clientY, [{ icono: 'fa-sliders', texto: 'Personalizar la barra rápida...', accion: () => abrirEditorAtajos('barra') }, ...(ev.target.closest('[data-orden]') ? [{ icono: 'fa-xmark', texto: 'Quitar de la barra', accion: () => { CONF_ATAJOS.barra = barraRapida().filter(x => x !== ev.target.closest('[data-orden]').dataset.orden); guardarConfAtajos(); pintarBarraRapida(); } }] : [])]); };
        }
        setTimeout(pintarBarraRapida, 0);
        function editorBarraRapida(...a) { return PARTES_OK.herr ? editorBarraRapida__p.apply(this, a) : cargarParte('herr').then(() => editorBarraRapida__p.apply(this, a)); }

        // ==================================================================================
        // 24) PLANTILLA DE CLIENTE: capas, cajetín, logotipo, plantilla Word y criterios en un archivo
        // ==================================================================================
        const CLAVE_PLANTILLAS_CLIENTE = 'piping-plantillas-cliente';
        const leerPlantillasCliente = () => { try { return JSON.parse(localStorage.getItem(CLAVE_PLANTILLAS_CLIENTE) || '{}'); } catch (e) { return {}; } };
        const CRITERIOS_PLANTILLA = ['vImp', 'vAsp', 'tsMax', 'tipoInstalacion', 'tCierre', 'grupoPED', 'criterioPrueba', 'salvaguardas', 'pais'];
        const CAJETIN_PLANTILLA = ['revisadoPor', 'aprobadoPor', 'escala', 'grupoPlano', 'codigoPlano', 'planoCert', 'nombrePlano2'];
        const OPCIONES_PLANTILLA = ['margenNPSH', 'uPresion', 'uCaudal', 'formato', 'norma', 'fondo', 'cajetin', 'rejillaMayor', 'rejillaMenores'];
        function crearPlantillaCliente() {
            const p = proyecto, cli = String(p.cliente || '').trim();
            let word = null; try { word = cli ? JSON.parse(localStorage.getItem(clavePlantilla()) || 'null') : null; } catch (e) { }
            return { tipo: 'piping-plantilla-cliente', version: 1, cliente: cli, fecha: new Date().toISOString(), capas: JSON.parse(JSON.stringify(capasActuales())),
                cajetin: Object.fromEntries(CAJETIN_PLANTILLA.map(k => [k, p[k] || ''])), logo: p.logo || null, plantillaWord: word,
                criterios: Object.fromEntries(CRITERIOS_PLANTILLA.map(k => [k, p[k] ?? ''])), opciones: Object.fromEntries(OPCIONES_PLANTILLA.map(k => [k, opciones[k]])), idioma: idiomaActual() };
        }
        function guardarPlantillaCliente() {
            cerrarMenus();
            const t = crearPlantillaCliente(); if (!t.cliente) { aviso('Indica el cliente en Archivo > Datos del proyecto.', 'error'); return; }
            const todas = leerPlantillasCliente(); todas[t.cliente.toLowerCase()] = t;
            try { localStorage.setItem(CLAVE_PLANTILLAS_CLIENTE, JSON.stringify(todas)); aviso(`Plantilla de ${t.cliente} guardada en este navegador (capas, cajetín, logotipo, Word y criterios).`, 'ok'); }
            catch (e) { aviso('No cabe en el navegador: expórtala a archivo.', 'error'); }
        }
        function exportarPlantillaCliente() { const t = crearPlantillaCliente(); descargarArchivo(JSON.stringify(t, null, 1), `plantilla_cliente_${(t.cliente || 'sin_cliente').replace(/[^\w.-]+/g, '_')}.json`, 'application/json'); }
        async function importarPlantillaCliente() {
            const f = await elegirArchivo('.json'); if (!f) return;
            try { const t = JSON.parse(await f.text()); if (t.tipo !== 'piping-plantilla-cliente') throw new Error('no es una plantilla de cliente de PIPING'); const todas = leerPlantillasCliente(); todas[String(t.cliente || '').toLowerCase()] = t; try { localStorage.setItem(CLAVE_PLANTILLAS_CLIENTE, JSON.stringify(todas)); } catch (e) { } aplicarPlantillaCliente(t); }
            catch (e) { aviso('No se ha podido importar: ' + e.message, 'error'); }
        }
        function aplicarPlantillaCliente(t) {
            if (!t) return;
            guardarEstado();
            if (t.cliente && !proyecto.cliente) proyecto.cliente = t.cliente;
            Object.entries(t.cajetin || {}).forEach(([k, v]) => { if (v !== '' && v != null) proyecto[k] = v; });
            Object.entries(t.criterios || {}).forEach(([k, v]) => { if (v !== '' && v != null) proyecto[k] = v; });
            if (t.logo) proyecto.logo = t.logo;
            if (Array.isArray(t.capas) && t.capas.length) opciones.capas = JSON.parse(JSON.stringify(t.capas));
            Object.entries(t.opciones || {}).forEach(([k, v]) => { if (v != null) opciones[k] = v; });
            if (t.plantillaWord && proyecto.cliente) { try { localStorage.setItem(clavePlantilla(), JSON.stringify(t.plantillaWord)); } catch (e) { } }
            if (t.idioma && t.idioma !== idiomaActual()) cambiarIdioma(t.idioma, true);
            aplicarFormato(); aplicarFondo && aplicarFondo(); marcarCambios(true); renderizarVectorial(); renderArbol(); aplicarFluidoProyecto();
            aviso(`Plantilla de ${t.cliente || 'cliente'} aplicada.`, 'ok');
        }
        function submenuPlantillasCliente() {
            const todas = Object.values(leerPlantillasCliente());
            return [
                { icono: 'fa-floppy-disk', texto: 'Guardar la del cliente actual', accion: () => guardarPlantillaCliente() },
                ...(todas.length ? ['sep', ...todas.map(t => ({ icono: 'fa-building', texto: `Aplicar: ${t.cliente} (${fechaDMA(String(t.fecha).slice(0, 10))})`, accion: () => aplicarPlantillaCliente(t) }))] : []),
                'sep',
                { icono: 'fa-file-export', texto: 'Exportar a archivo (*.json)', accion: () => exportarPlantillaCliente() },
                { icono: 'fa-file-import', texto: 'Importar de archivo (*.json)...', accion: () => importarPlantillaCliente() }
            ];
        }
        // logotipo del cliente en el cajetín (recuadro superior derecho)
        async function elegirLogotipo() {
            cerrarMenus();
            const f = await elegirArchivo('.png,.jpg,.jpeg,.svg,.webp'); if (!f) return;
            const url = await new Promise(ok => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(f); });
            let final = url;
            if (!/svg/.test(f.type)) final = await new Promise(ok => { const img = new Image(); img.onload = () => { const k = Math.min(1, 600 / Math.max(img.width, img.height)), c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); ok(c.toDataURL('image/png')); }; img.onerror = () => ok(url); img.src = url; });
            guardarEstado(); proyecto.logo = final; marcarCambios(true); renderizarVectorial(); aviso('Logotipo colocado en el cajetín.', 'ok');
        }
        function quitarLogotipo() { if (!proyecto.logo) return; guardarEstado(); delete proyecto.logo; renderizarVectorial(); }
        function ofrecerPlantillaCliente() {
            const cli = String(proyecto.cliente || '').trim().toLowerCase(), t = leerPlantillasCliente()[cli];
            if (!t) return;
            dialogo('<i class="fa-solid fa-building text-blue-600 mr-1.5"></i>Plantilla de cliente', `<p>Hay una plantilla guardada para <b>${esc(t.cliente)}</b> (${fechaDMA(String(t.fecha).slice(0, 10))}): capas, cajetín, logotipo, Word y criterios.</p><p>¿Aplicarla a este proyecto?</p>`,
                [{ texto: 'Aplicar', valor: 'si', clase: 'bg-blue-600 hover:bg-blue-700 text-white' }, { texto: 'No', valor: null }]).then(v => { if (v === 'si') aplicarPlantillaCliente(t); });
        }

        // ==================================================================================
        // 26) TUTORIAL GUIADO (primera vez; Ayuda > Tutorial guiado)
        // ==================================================================================
        const PASOS_TUTORIAL = [
            ['#panel-der', 'Símbolos P&ID', 'Arrastra un componente al lienzo para insertar uno, o haz clic en él para insertar varios seguidos (Esc termina). Al soltarlo junto a un extremo libre se conecta solo y hereda línea, tamaño y PN.'],
            ['#canvas-container', 'Dibujar la red', 'Pulsa L para trazar tuberías con codos automáticos. Intro o Espacio repiten la última orden. Soltar una válvula sobre una tubería la parte en dos. Arrastra el cuadrado naranja del extremo de una tubería para estirarla.'],
            ['#canvas-container', 'Botón derecho y gestos', 'Clic derecho: órdenes alrededor del cursor y menú. Botón derecho pulsado + desplazamiento en una dirección: gesto rápido (configurable en CAD > Atajos de teclado).'],
            ['#btn-calcular', 'Calcular', 'Calcula la red. El cálculo automático va comprobando velocidades, presiones, NPSH y PN mientras dibujas; si todo cumple te ofrece generar el informe.'],
            ['#estado-calculo', 'Avisos y correcciones', 'Clic en el estado del cálculo: panel de avisos con los fallos, enlaces a cada elemento y botones de corrección con un clic.'],
            ['#barra-hojas', 'Hojas, emisión e informe', 'Añade hojas (Alt+A) y enlázalas con el componente «Continuación entre hojas». Antes de emitir: Archivo > Comprobar antes de emitir. Informe en el menú Informe.']
        ];
        let pasoTutorial = -1;
        function iniciarTutorial() { cerrarMenus(); pasoTutorial = 0; pintarTutorial(); }
        function cerrarTutorial() { pasoTutorial = -1; document.getElementById('tutorial')?.remove(); try { localStorage.setItem('piping-tutorial-visto', '1'); } catch (e) { } }
        function pintarTutorial() {
            document.getElementById('tutorial')?.remove();
            if (pasoTutorial < 0 || pasoTutorial >= PASOS_TUTORIAL.length) { cerrarTutorial(); return; }
            const [sel, tit, txt] = PASOS_TUTORIAL[pasoTutorial], obj = document.querySelector(sel);
            const r = obj && obj.offsetParent !== null ? obj.getBoundingClientRect() : { left: innerWidth / 2 - 100, top: innerHeight / 2 - 50, width: 200, height: 100, right: innerWidth / 2 + 100, bottom: innerHeight / 2 + 50 };
            const d = document.createElement('div'); d.id = 'tutorial'; d.style.cssText = 'position:fixed; inset:0; z-index:4000;';
            const pad = 6, bx = { l: r.left - pad, t: r.top - pad, w: r.width + 2 * pad, h: r.height + 2 * pad };
            const W = 330, izq = bx.l + bx.w + 14 + W < innerWidth ? bx.l + bx.w + 14 : Math.max(10, bx.l - W - 14), arriba = Math.min(Math.max(10, bx.t), innerHeight - 220);
            const cabe = !(bx.w > innerWidth * 0.5 && bx.h > innerHeight * 0.5);
            d.innerHTML = `<div style="position:absolute; left:${bx.l}px; top:${bx.t}px; width:${bx.w}px; height:${bx.h}px; border:3px solid #f59e0b; border-radius:8px; box-shadow:0 0 0 9999px rgba(15,23,42,.45); pointer-events:none"></div>
                <div style="position:absolute; left:${cabe ? izq : innerWidth / 2 - W / 2}px; top:${cabe ? arriba : innerHeight / 2 - 90}px; width:${W}px" class="bg-white rounded-lg shadow-2xl p-4 text-xs">
                    <p class="text-[10px] text-slate-400 mb-1">Paso ${pasoTutorial + 1} de ${PASOS_TUTORIAL.length}</p><p class="font-bold text-sm text-slate-800 mb-1">${esc(trad(tit))}</p><p class="text-slate-600 leading-relaxed">${esc(trad(txt))}</p>
                    <div class="flex gap-2 mt-3"><button onclick="cerrarTutorial()" class="px-2 py-1 text-slate-500 hover:underline">Saltar</button><span class="flex-1"></span>${pasoTutorial ? '<button onclick="pasoTutorial--; pintarTutorial()" class="px-3 py-1 border rounded">Anterior</button>' : ''}<button onclick="pasoTutorial++; pintarTutorial()" class="px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded">${pasoTutorial === PASOS_TUTORIAL.length - 1 ? 'Terminar' : 'Siguiente'}</button></div></div>`;
            document.body.appendChild(d);
        }
        function ofrecerTutorial() { let visto = null; try { visto = localStorage.getItem('piping-tutorial-visto'); } catch (e) { } if (!visto && proyectoDefinido()) setTimeout(() => { if (sinVentanas() && !nuevoPendiente) iniciarTutorial(); }, 600); }
        window.addEventListener('keydown', e => { if (pasoTutorial >= 0 && e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); cerrarTutorial(); } }, true);

        // ==================================================================================
        // 27) AYUDA CONTEXTUAL: F1 sobre un campo explica qué es y de dónde sale
        // ==================================================================================
        const AYUDA_CAMPOS = {
            dn: 'Diámetro nominal. En tuberías, tamaño de la tabla del material (NPS en pulgadas / DN). Se hereda del elemento al que se conecta y el tamaño propuesto sale del caudal de diseño con V ≤ Vmax.',
            dnMenor: 'Diámetro nominal del lado pequeño de la reducción (salida si el flujo va de mayor a menor).',
            pn: 'PN (norma europea, EN 1092) o rating ASME B16.5 (150#, 300#…), según la norma del componente. Se compara con la presión de servicio corregida por temperatura; si no alcanza, el componente falla.',
            material: 'Material o tipo de tubería: define la tabla de tamaños y espesores, la rugosidad y la tensión admisible.',
            serie: 'Serie o schedule (Sch 40, 80, SDR…): fija el espesor de pared y, con él, el diámetro interior y la presión máxima admisible (PMA).',
            gradoMaterial: 'Grado del material según ASME o norma europea (SA-106 Gr.B, P235GH…). Da la tensión admisible del cálculo de espesor (Ayuda > Equivalencias).',
            longitud: 'Longitud real de la tubería en mm (pérdidas por fricción). Al cambiarla, lo conectado aguas abajo se desplaza en el dibujo.',
            cotaA: 'Cota del extremo a de la tubería (mm, respecto al origen del proyecto). Sirve para la presión estática y el NPSH.',
            cotaB: 'Cota del extremo b de la tubería (mm). El desnivel no puede ser mayor que la longitud.',
            cota: 'Cota del componente (mm). Interviene en la presión estática del nudo.',
            caudal: 'Caudal del punto de diseño de la bomba.', presion: 'Presión (altura) de la bomba en el punto de diseño.',
            h0: 'Presión de la bomba a caudal cero (cierre). Con el punto de diseño define la curva H = H₀ − k·Q². También se puede pegar la curva del fabricante.',
            npsh: 'NPSH requerido por la bomba (m, del fabricante). Se comprueba NPSHd ≥ NPSHr + margen (Opciones > Criterios de cálculo).',
            eta: 'Rendimiento de la bomba (0–1) para la potencia absorbida.',
            qCons: 'Caudal que demanda el consumo (extremo con caudal impuesto).', pMin: 'Presión mínima que debe llegar al consumo.',
            cotaFondo: 'Cota del fondo del tanque (mm).', hB: 'Altura de la conexión lateral b sobre el fondo del tanque (m).', hLamina: 'Nivel de líquido sobre el fondo (m): da la presión estática de salida.', hC: 'Altura de la conexión c (entrada superior) sobre el fondo (m).',
            presionDep: 'Presión sobre la lámina de líquido (0 = tanque abierto a la atmósfera).', volumen: 'Volumen del tanque o equipo (l): para el vaso de expansión y la categoría PED.',
            kvs: 'Kvs de la válvula de control (m³/h con Δp = 1 bar, totalmente abierta).', apertura: 'Apertura de la válvula de control (%).',
            modoK: 'Cómo se obtiene la pérdida del componente: automático (Crane TP-410), Cv del fabricante o K manual.', craneTipo: 'Subtipo del componente según Crane TP-410 (fija su K = f·L/D).',
            k: 'Coeficiente de pérdida K (Δh = K·V²/2g).', cvUsuario: 'Cv del fabricante (gpm con Δp = 1 psi).',
            aislamiento: 'Espesor de aislamiento (mm) para las pérdidas térmicas y el RITE.', linea: 'Línea a la que pertenece el elemento (principal P01… o ramal R01…). Define la nomenclatura.',
            scale: 'Escala del símbolo en el dibujo (no cambia el cálculo).', rotation: 'Giro del símbolo en grados (R: +45°, Mayús+R: −45°).',
            qNom: 'Caudal nominal del equipo (con su pérdida de carga nominal define su resistencia).', dpNom: 'Pérdida de carga del equipo a su caudal nominal.',
            pTarado: 'Presión de tarado de la válvula de seguridad o alivio.', hojaDestino: 'Hoja en la que continúa la línea. Se crea sola la pareja de la continuación en esa hoja.',
            caudalDiseno: 'Caudal de diseño del proyecto: se usa para proponer tamaños y comprobar que las fuentes lo aportan.', vImp: 'Velocidad máxima admisible en impulsión (m/s).', vAsp: 'Velocidad máxima admisible en aspiración (m/s).',
            tsMax: 'Temperatura máxima admisible TS (°C): para PN, PMA y categoría PED.', temperatura: 'Temperatura de servicio del fluido (°C): densidad, viscosidad y presión de vapor.',
            fluido: 'Fluido del proyecto (catálogo): propiedades físicas para el cálculo.', tipoInstalacion: 'Tipo de instalación: fija criterios (edificación RITE, industrial, buques…).',
            tCierre: 'Tiempo de cierre de válvulas (s) para el golpe de ariete (Joukowsky / Michaud).', numero: 'Número o referencia del proyecto. Si no se indica plano nº, aparece en el cajetín como Plano nº.',
            nombrePlano: 'Nombre del plano en el cajetín (varias líneas automáticas).', planoNumero: 'Número de plano del cajetín.', autor: 'Dibujado por (cajetín).', revision: 'Revisión en curso. Archivo > Registrar revisión la guarda y pasa a la siguiente.', escala: 'Escala del plano (vacío = N/A).',
            materialComp: 'Material del componente: aparece en el listado de componentes.', url: 'Dirección web de la ficha del componente.', libItem: 'Modelo de la librería (Librerías): aplica sus datos al componente.'
        };
        function campoDeControl(el) {
            if (!el) return null;
            if (el.dataset && el.dataset.campo) return el.dataset.campo;
            const oc = el.getAttribute && (el.getAttribute('onchange') || el.getAttribute('oninput') || ''); const m = oc && oc.match(/\(\s*'([a-zA-Z]+)'/); if (m) return m[1];
            const id = el.id || ''; let n = id.match(/^dp-p-(\w+)$/) || id.match(/^dp-(\w+)$/) || id.match(/^nd-(\w+)$/); if (n) return n[1];
            return null;
        }
        window.addEventListener('keydown', e => {
            if (e.key !== 'F1') return;
            e.preventDefault(); e.stopPropagation();
            const a = document.activeElement, campo = campoDeControl(a), txt = campo && AYUDA_CAMPOS[campo] && trad(AYUDA_CAMPOS[campo]);
            document.getElementById('ayuda-f1')?.remove();
            if (!txt) { aviso('F1: sitúate en un campo (panel de propiedades, ventana de inserción o datos del proyecto) para ver su ayuda. Ayuda > Tutorial guiado para el recorrido general.'); return; }
            const r = a.getBoundingClientRect(), d = document.createElement('div'); d.id = 'ayuda-f1';
            d.style.cssText = `position:fixed; z-index:3700; left:${Math.min(r.left, innerWidth - 340)}px; top:${r.bottom + 6 + 150 > innerHeight ? r.top - 150 : r.bottom + 6}px; width:320px`;
            d.className = 'bg-slate-800 text-slate-100 text-[11px] rounded shadow-lg p-2.5 leading-relaxed';
            d.innerHTML = `<b class="text-amber-300">${esc(campo)}</b> · ${esc(txt)}<div class="text-[10px] text-slate-400 mt-1">Esc o clic para cerrar</div>`;
            d.onclick = () => d.remove(); document.body.appendChild(d);
            const quitar = ev => { if (ev.key === 'Escape' || ev.type === 'mousedown') { d.remove(); window.removeEventListener('keydown', quitar, true); window.removeEventListener('mousedown', quitar, true); } };
            setTimeout(() => { window.addEventListener('keydown', quitar, true); window.addEventListener('mousedown', quitar, true); }, 0);
        }, true);

        { const _rv2 = renderizarVectorial; renderizarVectorial = function () { _rv2.apply(this, arguments); pintarFantasmasComparacion(); aplicarResaltado(); pintarBandaComparacion(); }; }

        const DICCIONARIO = { en: {}, pt: {}, ko: {} }; // se rellena al cargar i18n/<idioma>.js
        // ==================================================================================
        // 28) IDIOMAS: español, English, Português (Brasil), 한국어 (Opciones > Idioma)
        // Traducción por diccionario de la interfaz (menús, paneles, ventanas, botones, avisos fijos),
        // del cajetín, del listado y la leyenda de componentes y de títulos y cabeceras del informe.
        // ==================================================================================
        const IDIOMAS = { es: 'Español', en: 'English', pt: 'Português (Brasil)', ko: '한국어' };
        function idiomaActual() { return idioma; }
        function trad(s, l) {
            l = l || idioma;
            if (l === 'es' || s == null) return s;
            const D = DICCIONARIO[l], str = String(s);
            if (D[str] != null) return D[str];
            const t = str.trim(); if (!t) return str;
            if (t !== str && D[t] != null) return str.replace(t, D[t]);
            if (t.includes(' › ')) return str.replace(t, t.split(' › ').map(x => trad(x, l)).join(' › '));
            let m = t.match(/^(.*?)(\s*[:*]+)$/); if (m && m[1] && D[m[1].trim()] != null) return str.replace(t, D[m[1].trim()] + m[2]);
            m = t.match(/^(.*?)\s*\(([^()]*)\)(\s*[:*]*)$/); if (m && m[1] && D[m[1].trim()] != null) return str.replace(t, `${D[m[1].trim()]} (${D[m[2]] != null ? D[m[2]] : m[2]})${m[3]}`);
            m = t.match(/^(.*?)(\.\.\.|…)$/); if (m && D[m[1]] != null) return str.replace(t, D[m[1]] + m[2]);
            const pl = tradPlantilla(t, l); if (pl != null) return str.replace(t, pl);
            return str;
        }
        const tradMay = (s, l) => { l = l || idioma; const u = String(s); if (l === 'es') return u; const D = DICCIONARIO[l]; if (D[u] != null) return D[u]; const c = u.charAt(0) + u.slice(1).toLowerCase(); return D[c] != null ? D[c].toUpperCase() : u; };
        // --- traducción del DOM (se guarda el texto original de cada nodo para volver al español) ---
        const TXT_ORIG = new WeakMap(), TXT_PUESTO = new WeakMap(), ATR_ORIG = new WeakMap();
        const fueraDeTraduccion = el => !el || el.closest('script, style, #svg-canvas, textarea, [data-no-trad], #tooltip-comp code');
        function traducirTexto(n) {
            const p = n.parentElement; if (fueraDeTraduccion(p)) return;
            const actual = n.nodeValue;
            if (TXT_PUESTO.get(n) !== actual) TXT_ORIG.set(n, actual); // texto nuevo puesto por la aplicación
            const o = TXT_ORIG.get(n), t = idioma === 'es' ? o : trad(o);
            if (t !== actual) { n.nodeValue = t; }
            TXT_PUESTO.set(n, t);
        }
        function traducirAtributos(el) {
            if (!el.getAttribute || fueraDeTraduccion(el)) return;
            ['placeholder', 'title'].forEach(a => {
                const v = el.getAttribute(a); if (v == null) return;
                let rec = ATR_ORIG.get(el); if (!rec) { rec = {}; ATR_ORIG.set(el, rec); }
                if (!rec[a] || rec[a].puesto !== v) rec[a] = { orig: v };
                const t = idioma === 'es' ? rec[a].orig : trad(rec[a].orig);
                rec[a].puesto = t; if (t !== v) el.setAttribute(a, t);
            });
        }
        function traducirArbolDOM(raiz) {
            if (!raiz) return;
            if (raiz.nodeType === 3) { traducirTexto(raiz); return; }
            if (raiz.nodeType !== 1 || (raiz.id === 'svg-canvas') || raiz.tagName === 'SCRIPT' || raiz.tagName === 'STYLE') return;
            traducirAtributos(raiz);
            const w = document.createTreeWalker(raiz, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, { acceptNode: n => (n.nodeType === 1 && (n.id === 'svg-canvas' || n.tagName === 'SCRIPT' || n.tagName === 'STYLE' || n.tagName === 'TEXTAREA')) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
            let n; while ((n = w.nextNode())) { if (n.nodeType === 3) traducirTexto(n); else traducirAtributos(n); }
        }
        let traduciendo = false;
        const observadorIdioma = new MutationObserver(lista => {
            if (idioma === 'es' || traduciendo) return;
            traduciendo = true;
            try {
                lista.forEach(m => {
                    if (m.type === 'childList') m.addedNodes.forEach(n => { if (n.nodeType === 1 && n.closest && n.closest('#svg-canvas')) return; traducirArbolDOM(n); });
                    else if (m.type === 'characterData') traducirTexto(m.target);
                    else if (m.type === 'attributes') traducirAtributos(m.target);
                });
            } finally { traduciendo = false; }
        });
        observadorIdioma.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['placeholder', 'title'] });
        function cambiarIdioma(l, silencioso) {
            if (!IDIOMAS[l]) return;
            idioma = l; try { localStorage.setItem('piping-idioma', l); } catch (e) { }
            document.documentElement.lang = l === 'pt' ? 'pt-BR' : l;
            traduciendo = true; try { traducirArbolDOM(document.body); } finally { traduciendo = false; }
            try { construirLibreria(); } catch (e) { }
            renderizarVectorial(); renderArbol(); pintarHojas(); pintarBarraRapida();
            if (!silencioso) aviso(trad('Idioma') + ': ' + IDIOMAS[l], 'ok');
        }
        // cajetín: primera línea en el idioma elegido, segunda en inglés (en inglés, la segunda en español)
        const CAJ_ETIQUETAS = [
            ['Nombre:', 'Name:', 'Nome:', '명칭:'], ['Tamaño:', 'Size:', 'Formato:', '크기:'], ['Nº de Proyecto:', 'BM code n.:', 'Nº do projeto:', '프로젝트 번호:'], ['Plano nº:', 'Dwn nº:', 'Desenho nº:', '도면 번호:'],
            ['Rev:', 'Rev:', 'Rev:', '리비전:'], ['Letra:', 'Ltr:', 'Letra:', '문자:'], ['Dibujado por:', 'Draw by:', 'Desenhado por:', '작성:'], ['Fecha:', 'Date:', 'Data:', '일자:'], ['Revisado por:', 'Checked by:', 'Verificado por:', '검토:'],
            ['Escala:', 'Scale:', 'Escala:', '축척:'], ['Grupo Nº:', 'Group Nr:', 'Grupo nº:', '그룹 번호:'], ['Hoja n.:', 'Sheet n.:', 'Folha nº:', '시트 번호:'], ['De:', 'Of:', 'De:', '총:'], ['Aprobado por:', 'Approved by:', 'Aprovado por:', '승인:'],
            ['N. de Código:', 'Ident. code n.:', 'Código nº:', '식별 코드:'], ['Plano Cert. Nº:', 'Dwn Cert. Nº:', 'Desenho cert. nº:', '인증 도면 번호:']
        ];
        const CAJ_ES = Object.fromEntries(CAJ_ETIQUETAS.map(r => [r[0], r])), CAJ_EN = Object.fromEntries(CAJ_ETIQUETAS.map(r => [r[1], r]));
        function etiquetaCajetin(t) {
            const idioma = idiomaDocumento();
            if (idioma === 'es') return t;
            const col = { en: 1, pt: 2, ko: 3 }[idioma];
            if (CAJ_ES[t]) return CAJ_ES[t][col];
            if (CAJ_EN[t]) return idioma === 'en' ? CAJ_EN[t][0] : t;
            return t;
        }

        // ==================================================================================
        // 3) GUÍAS DE ALINEACIÓN y 4) DISTANCIA AL VECINO mientras se arrastra un elemento
        // ==================================================================================
        const TOL_GUIA = 5; // px de hoja
        function pintarGuiasArrastre(el) {
            document.getElementById('guias-arrastre')?.remove();
            if (!el || esAnotacion(el)) return;
            const c = centroElemento(el), otros = elementosRed.filter(e => e.id !== el.id && !esAnotacion(e) && !seleccion.has(e.id));
            let mx = null, my = null;
            otros.forEach(o => { const q = centroElemento(o); const dx = Math.abs(q.x - c.x), dy = Math.abs(q.y - c.y); if (dx < TOL_GUIA && (!mx || dx < mx.d)) mx = { d: dx, x: q.x, o: q }; if (dy < TOL_GUIA && (!my || dy < my.d)) my = { d: dy, y: q.y, o: q }; });
            // imán a la guía solo si el elemento no ha quedado conectado a otro
            if (!vecinosDe(el).length && (mx || my)) { if (mx) el.x += mx.x - c.x; if (my) el.y -= my.y - c.y; }
            const c2 = centroElemento(el), b = cajaSimbolo(el);
            // vecino más próximo a la derecha/izquierda y arriba/abajo (huecos entre cajas)
            let hx = null, hy = null;
            otros.forEach(o => { const q = cajaSimbolo(o);
                if (q.y0 < b.y1 && q.y1 > b.y0) { const g = q.x0 >= b.x1 ? q.x0 - b.x1 : b.x0 >= q.x1 ? b.x0 - q.x1 : null; if (g != null && (!hx || g < hx.g)) hx = { g, x0: q.x0 >= b.x1 ? b.x1 : q.x1, x1: q.x0 >= b.x1 ? q.x0 : b.x0, y: (Math.max(b.y0, q.y0) + Math.min(b.y1, q.y1)) / 2 }; }
                if (q.x0 < b.x1 && q.x1 > b.x0) { const g = q.y0 >= b.y1 ? q.y0 - b.y1 : b.y0 >= q.y1 ? b.y0 - q.y1 : null; if (g != null && (!hy || g < hy.g)) hy = { g, y0: q.y0 >= b.y1 ? b.y1 : q.y1, y1: q.y0 >= b.y1 ? q.y0 : b.y0, x: (Math.max(b.x0, q.x0) + Math.min(b.x1, q.x1)) / 2 }; } });
            const g = document.createElementNS('http://www.w3.org/2000/svg', 'g'); g.id = 'guias-arrastre'; g.setAttribute('pointer-events', 'none');
            const z = 1 / zoomScale, col = '#ec4899';
            let h = '';
            if (mx) h += `<line x1="${c2.x}" y1="${Math.min(c2.y, mx.o.y) - 30}" x2="${c2.x}" y2="${Math.max(c2.y, mx.o.y) + 30}" stroke="${col}" stroke-width="${0.8 * z}" stroke-dasharray="${4 * z},${3 * z}"/>`;
            if (my) h += `<line x1="${Math.min(c2.x, my.o.x) - 30}" y1="${c2.y}" x2="${Math.max(c2.x, my.o.x) + 30}" y2="${c2.y}" stroke="${col}" stroke-width="${0.8 * z}" stroke-dasharray="${4 * z},${3 * z}"/>`;
            const cota = (x0, y0, x1, y1, d, tx, ty) => `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" stroke="#0ea5e9" stroke-width="${0.8 * z}" marker-start="url(#flecha-cota)" marker-end="url(#flecha-cota)"/><text x="${tx}" y="${ty}" font-family="sans-serif" font-size="${9 * z}" fill="#0369a1" text-anchor="middle" paint-order="stroke" stroke="#fff" stroke-width="${3 * z}">${(d / PX_MM).toFixed(1)} mm</text>`;
            h += `<defs><marker id="flecha-cota" markerWidth="6" markerHeight="6" refX="3" refY="3" orient="auto-start-reverse"><path d="M0,0 L6,3 L0,6 z" fill="#0ea5e9"/></marker></defs>`;
            if (hx && hx.g < 400) h += cota(hx.x0, hx.y, hx.x1, hx.y, hx.g, (hx.x0 + hx.x1) / 2, hx.y - 4 * z);
            if (hy && hy.g < 400) h += cota(hy.x, hy.y0, hy.x, hy.y1, hy.g, hy.x + 4 * z, (hy.y0 + hy.y1) / 2);
            g.innerHTML = h; svgCanvas.appendChild(g);
        }
        function guiasTrasArrastre() {
            if (!isDraggingSymbol || !activeSymbolId || arrastreGrupo || !arrastreMovido) return;
            const el = elementosRed.find(e => e.id === activeSymbolId); if (!el || esTablaHoja(el)) return;
            const x = el.x, y = el.y;
            pintarGuiasArrastre(el);
            if (el.x !== x || el.y !== y) { renderizarVectorial(); pintarGuiasArrastre(el); }
        }
        window.addEventListener('mouseup', () => { document.getElementById('guias-arrastre')?.remove(); });

        // ---------- utilidades de copia (6, 7, 8) ----------
        function clonarElementos(lista, dx, dy, lineaNueva) {
            const mapa = {}, acumulado = todosLosElementos().slice();
            const nuevos = JSON.parse(JSON.stringify(lista)).map((x, k) => { const n = 'sym_' + Date.now() + '_c' + k + '_' + Math.floor(Math.random() * 1e4); mapa[x.id] = n; x.id = n; return x; });
            nuevos.forEach(x => {
                x.x += dx; x.y -= dy; delete x.estado; delete x.etq; x.esLineaCritica = false;
                if (x.ancla) x.ancla = mapa[x.ancla] || x.ancla; if (x.reservaDe) x.reservaDe = mapa[x.reservaDe] || x.reservaDe; if (x.sigueA) x.sigueA = mapa[x.sigueA] || x.sigueA;
                if (lineaNueva && x.linea) x.linea = lineaNueva(x.linea);
                if (esContinuacion(x)) { delete x.enlace; delete x.hojaDestino; }
                x.codigo = null; x.num = null; normalizarElemento(x); asignarNumero(x, acumulado); acumulado.push(x);
            });
            return { nuevos, mapa };
        }
        function cajaDe(lista) { const bs = lista.map(cajaSimbolo); return { x0: Math.min(...bs.map(b => b.x0)), y0: Math.min(...bs.map(b => b.y0)), x1: Math.max(...bs.map(b => b.x1)), y1: Math.max(...bs.map(b => b.y1)) }; }

        // ==================================================================================
        // 6) DUPLICAR UNA LÍNEA COMPLETA (con sus ramales opcionalmente): línea nueva y numeración nueva
        // ==================================================================================
        function duplicarLinea(id) {
            cerrarMenus();
            const l = lineaPorId(id); if (!l) return;
            const ramas = new Set([id]); lineas.forEach(x => { if (x.padre && ramas.has(x.padre)) ramas.add(x.id); });
            const conRamales = ramas.size > 1 ? confirm(`La línea ${id} tiene ${ramas.size - 1} ramal(es). ¿Duplicarlos también?`) : false;
            const ids = conRamales ? ramas : new Set([id]);
            const els = elementosRed.filter(e => ids.has(e.linea)); if (!els.length) return;
            guardarEstado(); invalidarResultados();
            const nuevasLineas = {};
            [...ids].forEach(lid => {
                const lo = lineaPorId(lid), padreNuevo = lo.padre && nuevasLineas[lo.padre];
                const nid = lo.tipo === 'principal' ? siguienteLinea('principal') : siguienteLinea('ramal', padreNuevo || lo.padre);
                nuevasLineas[lid] = nid;
                lineas.push(Object.assign({}, lo, { id: nid, nombre: lo.nombre ? lo.nombre + ' (copia)' : '', padre: padreNuevo || lo.padre }));
            });
            const b = cajaDe(els), dy = (b.y1 - b.y0) + 40;
            const { nuevos, mapa } = clonarElementos(els, 0, dy, lid => nuevasLineas[lid] || lid);
            lineas.filter(x => Object.values(nuevasLineas).includes(x.id)).forEach(x => { if (x.desde && mapa[x.desde]) x.desde = mapa[x.desde]; else if (x.desde && !mapa[x.desde]) x.desde = null; });
            elementosRed.push(...nuevos);
            seleccion.clear(); nuevos.forEach(n => seleccion.add(n.id)); actualizarSeleccion(); renderArbol();
            aviso(`Línea ${id} duplicada como ${nuevasLineas[id]} (${nuevos.length} elementos${conRamales ? ', con ramales' : ''}). Muévela a su sitio y conéctala.`, 'ok');
        }

        // ==================================================================================
        // 7) SIMETRÍA (espejo) de la selección respecto a su eje vertical u horizontal
        // Los símbolos llevan el indicador "espejo" (volteo local) y se giran 180°−θ / −θ.
        // ==================================================================================
        { const _opl = obtenerPuertosLocales; obtenerPuertosLocales = function (el) { const p = _opl(el); return el.espejo && el.type !== 'tuberia' ? p.map(q => ({ x: q.x, y: 50 - q.y, id: q.id })) : p; }; }
        function simetriaSeleccion(eje) {
            cerrarMenus();
            const ids = idsSeleccion(), els = elementosRed.filter(e => ids.includes(e.id) && !esTablaHoja(e)); if (!els.length) { aviso('Selecciona los elementos a reflejar.'); return; }
            guardarEstado(); invalidarResultados();
            const b = cajaDe(els), cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
            const refl = p => eje === 'v' ? { x: 2 * cx - p.x, y: p.y } : { x: p.x, y: 2 * cy - p.y };
            els.forEach(el => {
                if (el.type === 'tuberia') {
                    const pp = obtenerPuertosConexion(el), A = refl(pp.find(p => p.id === 'a')), B = refl(pp.find(p => p.id === 'b'));
                    el.rotation = ((Math.round(Math.atan2(B.y - A.y, B.x - A.x) * 180 / Math.PI) % 360) + 360) % 360;
                    colocarPorPuerto(el, 'a', A);
                } else if (esAnotacion(el)) {
                    const sy = mundoAScreenY(el.y), q = refl({ x: el.x, y: sy }); el.x = q.x - (eje === 'v' ? 50 : 0); el.y = screenAMundoY(q.y);
                } else {
                    const piv = { x: el.x + 25, y: mundoAScreenY(el.y) + 25 }, q = refl(piv), r = el.rotation || 0;
                    el.rotation = (((eje === 'v' ? 180 - r : -r) % 360) + 360) % 360; el.espejo = !el.espejo;
                    el.x = q.x - 25; el.y = screenAMundoY(q.y - 25);
                }
                delete el.etq;
            });
            renderizarVectorial(); if (els.length === 1) seleccionarElemento(els[0].id); else actualizarSeleccion();
            aviso(`Simetría ${eje === 'v' ? 'izquierda ↔ derecha' : 'arriba ↔ abajo'} aplicada a ${els.length} elemento(s).`, 'ok');
        }

        // ==================================================================================
        // 8) MATRIZ: n copias de la selección con separación dada (mm de papel)
        // ==================================================================================
        function matrizSeleccion(...a) { return PARTES_OK.herr ? matrizSeleccion__p.apply(this, a) : cargarParte('herr').then(() => matrizSeleccion__p.apply(this, a)); }

        // ==================================================================================
        // 9) AUTOCORRECCIÓN DE CONEXIONES: extremos libres casi unidos (≤ 2 mm de papel)
        // ==================================================================================
        function casiConexiones() {
            const libres = puertosLibres(), lim = 2 * PX_MM, pares = [];
            for (let i = 0; i < libres.length; i++) for (let j = i + 1; j < libres.length; j++) {
                const a = libres[i], b = libres[j]; if (a.el.id === b.el.id || esAnotacion(a.el) || esAnotacion(b.el)) continue;
                const d = Math.hypot(a.x - b.x, a.y - b.y); if (d >= 1 && d <= lim) pares.push({ a, b, d });
            }
            return pares.sort((x, y) => x.d - y.d);
        }
        function unirCasiConexiones(pares) {
            let n = 0, no = 0; const usados = new Set();
            pares.forEach(({ a, b }) => {
                if (usados.has(a.el.id + a.id) || usados.has(b.el.id + b.id)) return;
                // se mueve el elemento que no tiene otras conexiones (si los dos tienen, se estira la tubería)
                const va = vecinosDe(a.el).length, vb = vecinosDe(b.el).length;
                let mover = va <= vb ? a : b, fijo = mover === a ? b : a;
                if (vecinosDe(mover.el).length) {
                    const t = [a, b].find(p => p.el.type === 'tuberia' && p.id === 'b');
                    if (t) { const o = t === a ? b : a, pp = obtenerPuertosConexion(t.el), A = pp.find(p => p.id === 'a'), u = { x: (t.x - A.x), y: (t.y - A.y) }, L = Math.hypot(u.x, u.y); const s = ((o.x - A.x) * u.x + (o.y - A.y) * u.y) / L; t.el.longitud = Math.max(10, Math.round(s * 30)); const pb = obtenerPuertosConexion(t.el).find(p => p.id === 'b'); if (Math.hypot(pb.x - o.x, pb.y - o.y) < 1) { n++; usados.add(a.el.id + a.id); usados.add(b.el.id + b.id); return; } }
                    no++; return;
                }
                mover.el.x += fijo.x - mover.x; mover.el.y -= fijo.y - mover.y; n++;
                usados.add(a.el.id + a.id); usados.add(b.el.id + b.id);
            });
            return { n, no };
        }
        async function corregirConexiones(silencioso) {
            const pares = casiConexiones();
            if (!pares.length) { if (!silencioso) aviso('No hay extremos casi unidos: todas las conexiones están cerradas.', 'ok'); return true; }
            const lista = pares.slice(0, 12).map(p => `<li>${esc(tagDe(p.a.el))} (${p.a.id}) ↔ ${esc(tagDe(p.b.el))} (${p.b.id}): ${(p.d / PX_MM).toFixed(2)} mm</li>`).join('');
            const r = await dialogo('<i class="fa-solid fa-link text-amber-600 mr-1.5"></i>Conexiones casi unidas', `<p>Hay <b>${pares.length}</b> pareja(s) de extremos a menos de 2 mm que no llegan a tocarse (el cálculo los trataría como desconectados):</p><ul class="list-disc ml-5 my-1">${lista}</ul>`,
                [{ texto: 'Unirlas', valor: 'unir', clase: 'bg-blue-600 hover:bg-blue-700 text-white' }, { texto: 'Ir a la primera', valor: 'ir' }, { texto: silencioso ? 'Seguir sin unir' : 'Cancelar', valor: null }]);
            if (r === 'unir') { guardarEstado(); invalidarResultados(); const x = unirCasiConexiones(pares); renderizarVectorial(); aviso(`${x.n} conexión(es) unidas${x.no ? ` · ${x.no} sin unir (los dos elementos ya tienen otras conexiones)` : ''}.`, x.no ? 'error' : 'ok'); return true; }
            if (r === 'ir') { irAElemento(pares[0].a.el.id); return false; }
            return true;
        }

        // ==================================================================================
        // 13) ESCENARIOS A / B: guardar el cálculo actual y comparar dos escenarios
        // ==================================================================================
        function fotoCalculo(nombre) {
            const res = ultimoCalculo && ultimoCalculo.resultado; if (!res) return null;
            const el = {};
            elementosRed.filter(e => !esAnotacion(e)).forEach(e => { const r = ultimoResultado && ultimoResultado[e.id]; if (!r) return; el[e.id] = { tag: tagDe(e), tipo: e.type, Q: r.Q, V: r.V, hf: r.hf, pA: r.pA, pB: r.pB, H: r.H, npshd: r.npshd, p: r.p, estado: e.estado }; });
            return { nombre, fecha: new Date().toISOString(), hoja: codigoHoja(), el, hfCritica: res.lineaCritica ? res.lineaCritica.hfTotal : null, fallos: elementosRed.filter(e => e.estado === 'fallo').length };
        }
        function guardarEscenario(k) {
            cerrarMenus();
            if (!ultimoCalculo) { aviso('Calcula la red antes de guardar el escenario.', 'error'); return; }
            const n = prompt(`Nombre del escenario ${k}:`, k === 'A' ? 'Situación actual' : 'Alternativa'); if (n == null) return;
            proyecto.escenarios = proyecto.escenarios || {}; proyecto.escenarios[k] = fotoCalculo(n.trim() || k); marcarCambios(true);
            aviso(`Escenario ${k} guardado (${Object.keys(proyecto.escenarios[k].el).length} elementos).`, 'ok');
        }
        function compararEscenarios(...a) { return PARTES_OK.herr ? compararEscenarios__p.apply(this, a) : cargarParte('herr').then(() => compararEscenarios__p.apply(this, a)); }
        async function exportarComparacionEscenarios() {
            const E = proyecto.escenarios || {}, A = E.A, B = E.B || fotoCalculo('Cálculo actual'); if (!A || !B) return;
            const X = await cargarXLSX(), ids = [...new Set([...Object.keys(A.el), ...Object.keys(B.el)])];
            const filas = [['Elemento', 'Q A (m³/h)', 'Q B (m³/h)', 'V A (m/s)', 'V B (m/s)', 'hf A (m)', 'hf B (m)', 'p A (bar)', 'p B (bar)', 'NPSHd A (m)', 'NPSHd B (m)', 'Estado A', 'Estado B']].concat(ids.map(id => { const a = A.el[id] || {}, b = B.el[id] || {}; return [a.tag || b.tag, a.Q, b.Q, a.V, b.V, a.hf, b.hf, a.pB ?? a.p, b.pB ?? b.p, a.npshd, b.npshd, a.estado, b.estado]; }));
            const wb = X.utils.book_new(); X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(filas), 'Escenarios'); X.writeFile(wb, `escenarios_${(proyecto.numero || 'proyecto').replace(/[^\w.-]+/g, '_')}.xlsx`);
        }

        // ==================================================================================
        // 15) PERFIL HIDRÁULICO DE LA RUTA CRÍTICA: cota y línea piezométrica a lo largo del recorrido
        // ==================================================================================
        function perfilRutaCritica() {
            cerrarMenus();
            const res = ultimoCalculo && ultimoCalculo.resultado, lc = res && res.lineaCritica;
            if (!lc || !lc.aristasCamino || !lc.aristasCamino.length) { aviso('Calcula la red: no hay ruta crítica.', 'error'); return; }
            const ar = lc.aristasCamino, fl = res.fluido, hAtm = PRESION_ATM / (fl.rho * G);
            let actual = ar.length > 1 ? ([ar[0].nodoA, ar[0].nodoB].find(n => n !== ar[1].nodoA && n !== ar[1].nodoB) ?? ar[0].nodoA) : (res.Hnodo[ar[0].nodoA] >= res.Hnodo[ar[0].nodoB] ? ar[0].nodoA : ar[0].nodoB);
            const pts = [{ x: 0, z: res.z[actual] || 0, h: res.Hnodo[actual] - hAtm, tag: '' }]; let x = 0;
            ar.forEach(a => { const sig = a.nodoA === actual ? a.nodoB : a.nodoA; x += a.el.type === 'tuberia' ? (a.el.longitud || 0) / 1000 : 0; pts.push({ x, z: res.z[sig] || 0, h: res.Hnodo[sig] - hAtm, tag: tagDe(a.el), tipo: a.el.type }); actual = sig; });
            const W = 900, H = 380, m = { l: 56, r: 20, t: 16, b: 70 }, xm = Math.max(x, 1), ys = pts.flatMap(p => [p.z, p.h]), y0 = Math.min(0, ...ys), y1 = Math.max(...ys) * 1.08 + 0.5;
            const X = v => m.l + v / xm * (W - m.l - m.r), Y = v => H - m.b - (v - y0) / (y1 - y0) * (H - m.t - m.b);
            let s = `<svg width="${W}" height="${H}" style="font-family:sans-serif;font-size:10px"><rect x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}" fill="#f8fafc" stroke="#cbd5e1"/>`;
            for (let i = 0; i <= 5; i++) { const v = y0 + (y1 - y0) * i / 5, q = xm * i / 5; s += `<line x1="${m.l}" y1="${Y(v)}" x2="${W - m.r}" y2="${Y(v)}" stroke="#e2e8f0"/><text x="${m.l - 4}" y="${Y(v) + 3}" text-anchor="end" fill="#64748b">${v.toFixed(1)}</text><text x="${X(q)}" y="${H - m.b + 13}" text-anchor="middle" fill="#64748b">${q.toFixed(1)}</text>`; }
            s += `<path d="${pts.map((p, i) => (i ? 'L' : 'M') + X(p.x).toFixed(1) + ' ' + Y(p.z).toFixed(1)).join(' ')} L ${X(x)} ${Y(y0)} L ${X(0)} ${Y(y0)} Z" fill="#cbd5e1" opacity=".55" stroke="#64748b" stroke-width="1.5"/>`;
            s += `<path d="${pts.map((p, i) => (i ? 'L' : 'M') + X(p.x).toFixed(1) + ' ' + Y(p.h).toFixed(1)).join(' ')}" fill="none" stroke="#2563eb" stroke-width="2.2"/>`;
            let ultX = -99;
            pts.forEach(p => { if (!p.tag) return; s += `<circle cx="${X(p.x)}" cy="${Y(p.h)}" r="2.2" fill="#2563eb"/>`; if (X(p.x) - ultX > 22 && p.tipo !== 'tuberia') { s += `<text transform="translate(${X(p.x) + 3} ${H - m.b + 22}) rotate(55)" fill="#334155" font-size="9">${esc(p.tag)}</text>`; ultX = X(p.x); } });
            s += `<text x="${(W + m.l) / 2}" y="${H - 6}" text-anchor="middle" fill="#334155">Longitud recorrida (m)</text><text transform="translate(14 ${(H - m.b + m.t) / 2}) rotate(-90)" text-anchor="middle" fill="#334155">m (cota / altura piezométrica manométrica)</text>`;
            s += `<g transform="translate(${m.l + 10} ${m.t + 8})"><rect width="210" height="34" fill="#fff" stroke="#cbd5e1"/><line x1="8" y1="11" x2="30" y2="11" stroke="#2563eb" stroke-width="2.2"/><text x="36" y="14">Línea piezométrica (z + p/ρg)</text><rect x="8" y="20" width="22" height="8" fill="#cbd5e1" stroke="#64748b"/><text x="36" y="28">Cota de la tubería (z)</text></g></svg>`;
            const pmin = Math.min(...pts.map(p => (p.h - p.z) * fl.rho * G / 1e5));
            document.getElementById('red-content').innerHTML = `<p class="text-[11px] mb-2">Ruta crítica: ${ar.length} tramos · ${x.toFixed(1)} m · pérdidas ${fmt(lc.hfTotal, 2)} m · presión mínima en el recorrido ${pmin.toFixed(2)} bar man.${pmin < 0 ? ' <b class="text-rose-600">(depresión)</b>' : ''}</p>${s}`;
            document.getElementById('red-footer').innerHTML = '<button onclick="cerrarModalRed()" class="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded font-medium">Cerrar</button>';
            document.querySelector('#modal-red h3 span').innerHTML = '<i class="fa-solid fa-chart-area text-blue-600 mr-1.5"></i> Perfil hidráulico de la ruta crítica';
            document.querySelector('#modal-red > div').style.width = 'min(960px, 97vw)';
            document.getElementById('modal-red').style.display = 'flex';
        }

        // ==================================================================================
        // 16) CURVA DE LA BOMBA SOBRE LA CURVA DE LA RED (punto de funcionamiento)
        // ==================================================================================
        function curvaBombaRed(id) {
            cerrarMenus();
            const res = ultimoCalculo && ultimoCalculo.resultado;
            const bo = id ? elementosRed.find(e => e.id === id) : elementosRed.find(e => e.type === 'bomba');
            if (!bo) { aviso('No hay bombas en la hoja.', 'error'); return; }
            const r = ultimoResultado && ultimoResultado[bo.id];
            if (!res || !r || r.H == null) { aviso('Calcula la red para ver el punto de funcionamiento.', 'error'); return; }
            const fl = res.fluido, aM = bar => bar * 1e5 / (fl.rho * G), H0 = aM(bo.h0), Hd = aM(bo.presion), Qd = bo.caudal, k = (H0 - Hd) / Math.max(Qd * Qd, 1e-9);
            const Qop = r.Q, Hop = r.H, hfR = res.lineaCritica ? res.lineaCritica.hfTotal : 0, Hst = Math.max(0, Math.min(Hop, Hop - hfR)), Ks = (Hop - Hst) / Math.max(Qop * Qop, 1e-9);
            const W = 640, H = 370, m = { l: 50, r: 120, t: 24, b: 40 }, Qm = Math.max(Math.sqrt(H0 / Math.max(k, 1e-9)), Qd, Qop) * 1.1, Hm = Math.max(H0, Hst + Ks * Qm * Qm * 0.6, Hop) * 1.1;
            const X = q => m.l + q / Qm * (W - m.l - m.r), Y = h => H - m.b - h / Hm * (H - m.t - m.b);
            let s = `<svg width="${W}" height="${H}" style="font-family:sans-serif;font-size:10px"><rect x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}" fill="#f8fafc" stroke="#cbd5e1"/>`;
            for (let i = 0; i <= 5; i++) { const q = Qm * i / 5, h = Hm * i / 5; s += `<line x1="${X(q)}" y1="${m.t}" x2="${X(q)}" y2="${H - m.b}" stroke="#e2e8f0"/><line x1="${m.l}" y1="${Y(h)}" x2="${W - m.r}" y2="${Y(h)}" stroke="#e2e8f0"/><text x="${X(q)}" y="${H - m.b + 13}" text-anchor="middle" fill="#64748b">${q.toFixed(1)}</text><text x="${m.l - 4}" y="${Y(h) + 3}" text-anchor="end" fill="#64748b">${h.toFixed(1)}</text>`; }
            const curva = f => { let d = ''; for (let i = 0; i <= 60; i++) { const q = Qm * i / 60, h = f(q); if (h < 0 || h > Hm * 1.05) continue; d += (d ? 'L' : 'M') + X(q).toFixed(1) + ' ' + Y(h).toFixed(1); } return d; };
            s += `<path d="${curva(q => H0 - k * q * q)}" fill="none" stroke="#2563eb" stroke-width="2.2"/><path d="${curva(q => Hst + Ks * q * q)}" fill="none" stroke="#f59e0b" stroke-width="2.2"/>`;
            (bo.curva || []).forEach(([q, hb]) => { s += `<circle cx="${X(q)}" cy="${Y(aM(hb))}" r="3" fill="#fff" stroke="#2563eb" stroke-width="1.5"/>`; });
            s += `<circle cx="${X(Qd)}" cy="${Y(Hd)}" r="4" fill="none" stroke="#16a34a" stroke-width="2"/><circle cx="${X(Qop)}" cy="${Y(Hop)}" r="5" fill="#dc2626"/>`;
            s += `<text x="${(W - m.r + m.l) / 2}" y="${H - 8}" text-anchor="middle" fill="#334155">Q (m³/h)</text><text x="12" y="${m.t - 10}" fill="#334155">H (m)</text>`;
            s += `<g transform="translate(${W - m.r + 8} ${m.t + 4})" font-size="9.5"><line x1="0" y1="6" x2="18" y2="6" stroke="#2563eb" stroke-width="2.2"/><text x="22" y="9">Bomba</text><line x1="0" y1="22" x2="18" y2="22" stroke="#f59e0b" stroke-width="2.2"/><text x="22" y="25">Red (estimada)</text><circle cx="9" cy="38" r="4" fill="#dc2626"/><text x="22" y="41">Funcionamiento</text><circle cx="9" cy="54" r="4" fill="none" stroke="#16a34a" stroke-width="2"/><text x="22" y="57">Diseño</text>${bo.curva ? '<circle cx="9" cy="70" r="3" fill="#fff" stroke="#2563eb" stroke-width="1.5"/><text x="22" y="73">Fabricante</text>' : ''}</g></svg>`;
            const bombas = elementosRed.filter(e => e.type === 'bomba');
            document.getElementById('red-content').innerHTML = `${bombas.length > 1 ? `<p class="mb-2 text-[11px]">Bomba: <select onchange="curvaBombaRed(this.value)" class="border rounded p-0.5">${bombas.map(b => `<option value="${b.id}" ${b.id === bo.id ? 'selected' : ''}>${esc(tagDe(b))}</option>`).join('')}</select></p>` : ''}
                <div class="flex gap-4"><div>${s}</div><div class="text-[11px] space-y-1"><p><b>${esc(tagDe(bo))}</b></p><p>Funcionamiento: <b>${fmt(Qop, 2)} m³/h · ${fmt(Hop, 2)} m</b></p><p>Diseño: ${fmt(Qd, 2)} m³/h · ${fmt(Hd, 2)} m</p><p>H₀ (cierre): ${fmt(H0, 2)} m</p><p>Altura estática estimada: ${fmt(Hst, 2)} m</p><p>Pérdidas en la ruta crítica: ${fmt(hfR, 2)} m</p><p class="text-slate-400">La curva de la red se estima como H = H<sub>est</sub> + K·Q² por el punto de funcionamiento.</p>${Math.abs(Qop - Qd) / Math.max(Qd, 1e-6) > 0.15 ? `<p class="text-amber-700">El punto de funcionamiento se aleja un ${Math.round(Math.abs(Qop - Qd) / Qd * 100)} % del de diseño.</p>` : ''}</div></div>`;
            document.getElementById('red-footer').innerHTML = `<div class="flex gap-2 w-full text-xs"><button onclick="abrirCurvaBomba('${bo.id}')" class="px-3 py-1.5 border rounded">Curva del fabricante...</button><span class="flex-1"></span><button onclick="cerrarModalRed()" class="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded font-medium">Cerrar</button></div>`;
            document.querySelector('#modal-red h3 span').innerHTML = '<i class="fa-solid fa-chart-line text-blue-600 mr-1.5"></i> Curva de la bomba y de la red';
            document.querySelector('#modal-red > div').style.width = 'min(1000px, 97vw)';
            document.getElementById('modal-red').style.display = 'flex';
        }

        // ==================================================================================
        // 34) BANDEROLA DE LÍNEA: línea · tamaño · material · fluido · sentido (anclada a la tubería)
        // ==================================================================================
        function textoBanderola(t) {
            const fl = tradDoc((proyecto && proyecto.fluido) || document.getElementById('selector-fluido')?.value || '');
            return [t.linea || '??', tamanoTexto(t) + '"', CODIGO_MATERIAL[t.material] || '', serieTexto(t), fl].filter(Boolean).join(' · ');
        }
        function sentidoTuberia(t) {
            const a = ultimoCalculo && ultimoCalculo.resultado && ultimoCalculo.resultado.aristas && ultimoCalculo.resultado.aristas.find(x => x.el.id === t.id && !x.rama);
            return ((t.rotation || 0) + (a && a.Qprev < 0 ? 180 : 0)) % 360;
        }
        function insertarBanderola(t, silencioso) {
            if (!t || t.type !== 'tuberia') return null;
            if (elementosRed.some(e => e.subtype === 'banderola' && e.sigueA === t.id)) return null;
            if (!silencioso) guardarEstado();
            const c = centroElemento(t), n = nuevaAnotacion('banderola', c.x - 30, c.y - 34);
            anclarSigue(n, t);
            if (!silencioso) { renderizarVectorial(); seleccionarElemento(n.id); }
            return n;
        }
        function banderolasTodasLasLineas() {
            cerrarMenus(); guardarEstado(); let k = 0;
            lineas.forEach(l => { const ts = elementosRed.filter(e => e.type === 'tuberia' && e.linea === l.id); if (!ts.length) return; const t = ts.sort((a, b) => b.longitud - a.longitud)[0]; if (insertarBanderola(t, true)) k++; });
            renderizarVectorial(); aviso(`${k} banderola(s) de línea añadidas (en la tubería más larga de cada línea).`, 'ok');
        }
        function dibujoBanderola(el, c, P) {
            const t = el.sigueA && elementosRed.find(e => e.id === el.sigueA);
            const txt = t ? textoBanderola(t) : 'sin tubería', fs = MM(2.5); ctxMedida.font = `bold ${fs}px sans-serif`;
            const w = ctxMedida.measureText(txt).width + MM(4), h = MM(5), ang = t ? sentidoTuberia(t) : 0;
            const fx = w + MM(4), fy = h / 2, r = MM(2.2);
            const flecha = `<g transform="translate(${fx.toFixed(2)} ${fy.toFixed(2)}) rotate(${ang})"><path d="M ${-r} ${-r * 0.7} L ${r} 0 L ${-r} ${r * 0.7} Z" fill="${c}"/></g>`;
            return `<rect x="0" y="0" width="${w.toFixed(2)}" height="${h.toFixed(2)}" rx="${(h / 2).toFixed(2)}" fill="${P.relleno}" stroke="${c}" stroke-width="0.8"/><text x="${(w / 2).toFixed(2)}" y="${(h / 2 + fs * 0.36).toFixed(2)}" font-family="sans-serif" font-size="${fs.toFixed(2)}" font-weight="bold" text-anchor="middle" fill="${c}">${esc(txt)}</text>${flecha}`;
        }

        // ==================================================================================
        // 37) COMENTARIOS DE REVISIÓN (redlines): chincheta con autor, fecha, texto y estado;
        // no se imprimen ni se exportan al DXF
        // ==================================================================================
        const autorComentarios = () => { const ses = typeof sesionActual === 'function' && sesionActual(); if (ses && ses.origen === 'supabase') return nombreSesion(ses); try { return localStorage.getItem('piping-autor-comentarios') || proyecto.autor || ''; } catch (e) { return proyecto.autor || ''; } };
        function insertarComentario(px, py) {
            cerrarMenus();
            const texto = prompt('Comentario de revisión:', ''); if (!texto) return;
            let autor = autorComentarios(); if (!autor) { autor = prompt('Tu nombre o iniciales (autor de los comentarios):', '') || 'Revisor'; try { localStorage.setItem('piping-autor-comentarios', autor); } catch (e) { } }
            guardarEstado();
            const n = nuevaAnotacion('comentario', px, py); Object.assign(n, { texto, autor, fecha: new Date().toISOString(), estadoCom: 'abierto', respuestas: [] });
            let mejor = null; elementosRed.filter(e => !esAnotacion(e)).forEach(e => { const c = centroElemento(e), d = Math.hypot(c.x - px, c.y - py); if (d < 60 && (!mejor || d < mejor.d)) mejor = { e, d }; });
            if (mejor) anclarSigue(n, mejor.e);
            renderizarVectorial(); aviso('Comentario añadido (Vista > Comentarios de revisión).', 'ok');
        }
        function dibujoComentario(el, c, P) {
            const ab = el.estadoCom !== 'resuelto', col = ab ? '#e11d48' : '#64748b', fs = 7;
            const lineasT = String(el.texto || '').match(/.{1,38}(\s|$)/g) || [''], w = Math.max(80, ...lineasT.map(l => anchoTexto(l, fs))) + 10, h = (lineasT.length + 1) * fs * 1.25 + 6;
            return `<g class="no-imprimir"><path d="M 0 0 C -6 -10 -14 -12 -14 -20 A 8 8 0 1 1 2 -20 C 2 -12 -6 -10 0 0 Z" transform="translate(6 18)" fill="${col}" stroke="#fff" stroke-width="1"/><circle cx="0" cy="-4" r="2.6" fill="#fff"/>
                <g transform="translate(12 -28)"><rect width="${w}" height="${h}" rx="3" fill="${ab ? '#fff1f2' : '#f1f5f9'}" stroke="${col}" stroke-width="0.8" stroke-dasharray="${ab ? '' : '2,2'}"/>
                <text x="5" y="${fs * 1.2 + 2}" font-family="sans-serif" font-size="${fs - 1}" font-weight="bold" fill="${col}">${esc(el.autor || '')} · ${esc(fechaDMA(String(el.fecha || '').slice(0, 10)))}${ab ? '' : ' · resuelto'}</text>
                ${lineasT.map((l, i) => `<text x="5" y="${fs * 1.25 * (i + 2) + 2}" font-family="sans-serif" font-size="${fs}" fill="#1e293b">${esc(l.trim())}</text>`).join('')}</g></g>`;
        }
        function verComentarios(...a) { return PARTES_OK.admin ? verComentarios__p.apply(this, a) : cargarParte('admin').then(() => verComentarios__p.apply(this, a)); }
        function estadoComentario(i, id) {
            const lista = i === hojaActual ? elementosRed : hojas[i].e || [], e = lista.find(x => x.id === id); if (!e) return;
            if (i === hojaActual) guardarEstado();
            e.estadoCom = e.estadoCom === 'resuelto' ? 'abierto' : 'resuelto'; e.fechaEstado = new Date().toISOString(); marcarCambios(true); renderizarVectorial(); verComentarios();
        }

        // traducciones v8.3 (informe, avisos, F1, tutorial y órdenes nuevas): frase en español → idioma
        const TR83 = { en: {}, pt: {}, ko: {} }; // se rellena al cargar i18n/<idioma>.js
        // ==================================================================================
        // 30) IDIOMA DEL INFORME Y DEL CAJETÍN independiente del de la interfaz
        // (Opciones > Idioma > Informe, cajetín y listados). Se guarda con el proyecto (opciones.idiomaDoc).
        // 29) TRADUCCIÓN POR PLANTILLAS: frases con valores ({0}, {1}…) del informe, avisos, F1 y tutorial
        // ==================================================================================
        function idiomaDocumento() { return IDIOMAS[opciones.idiomaDoc] ? opciones.idiomaDoc : idioma; }
        function tradDoc(s) { return trad(s, idiomaDocumento()); }
        const tradMayDoc = s => tradMay(s, idiomaDocumento());
        const decimalDoc = () => ['en', 'ko'].includes(idiomaDocumento()) ? '.' : ',';
        function cambiarIdiomaDoc(l) {
            opciones.idiomaDoc = l || ''; marcarCambios(true); renderizarVectorial();
            aviso(trad('Informe, cajetín y listados') + ': ' + (l ? IDIOMAS[l] : trad('igual que la interfaz') + ' (' + IDIOMAS[idioma] + ')'), 'ok');
        }
        const PLANTILLAS_TR = {};
        const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        function plantillasDe(l) {
            if (PLANTILLAS_TR[l]) return PLANTILLAS_TR[l];
            const lista = [];
            Object.entries((TR83[l] || {})).forEach(([k, v]) => {
                if (!/\{\d+\}/.test(k)) return;
                const partes = k.split(/\{(\d+)\}/); let re = '^'; const orden = [];
                partes.forEach((p, i) => { if (i % 2) { re += '([\\s\\S]*?)'; orden.push(+p); } else re += escRe(p); });
                const est = partes.filter((p, i) => !(i % 2)).join('');
                if (!/[a-záéíóúñ]{3,}/i.test(est)) return;
                lista.push({ re: new RegExp(re + '$'), orden, tr: v, est: est.length, pref: partes[0] });
            });
            lista.sort((a, b) => b.est - a.est);
            return (PLANTILLAS_TR[l] = lista);
        }
        // traducción de una frase con valores; los valores también se traducen si son frases conocidas
        function tradPlantilla(s, l, prof = 0) {
            if (prof > 4 || !/[a-záéíóúñ]{3,}/i.test(s) || s.length > 4000) return null;
            for (const p of plantillasDe(l)) {
                if (p.pref && !s.startsWith(p.pref)) continue;
                const m = s.match(p.re); if (!m) continue;
                const v = {}; p.orden.forEach((ix, j) => { v[ix] = m[j + 1]; });
                return p.tr.replace(/\{(\d+)\}/g, (x, i) => v[i] == null ? x : tradValor(v[i], l, prof + 1));
            }
            // listas de motivos separadas por «; »
            if (s.includes('; ')) { const pz = s.split('; '), t = pz.map(x => tradValor(x, l, prof + 1)); if (t.some((x, i) => x !== pz[i])) return t.join('; '); }
            return null;
        }
        function tradValor(s, l, prof) { const D = DICCIONARIO[l] || {}; if (D[s] != null) return D[s]; const t = s.trim(); if (t && t !== s && D[t] != null) return s.replace(t, D[t]); const r = tradPlantilla(s, l, prof); return r == null ? s : r; }
        // diccionario ampliado: frases fijas → al diccionario general; frases con valores → plantillas
        Object.keys(TR83).forEach(l => { const D = DICCIONARIO[l] = DICCIONARIO[l] || {}; Object.entries(TR83[l]).forEach(([k, v]) => { if (!/\{\d+\}/.test(k) && D[k] == null && v !== k) D[k] = v; }); });

        // ==================================================================================
        // 31) ISOMÉTRICO AUTOMÁTICO DE UNA LÍNEA a partir de las cotas (hoja nueva, imprimible y exportable a DXF)
        // Direcciones en planta: las del esquema (derecha = este, arriba = norte); vertical: cota b − cota a.
        // ==================================================================================
        
        const ISO_C = Math.cos(Math.PI / 6), ISO_S = Math.sin(Math.PI / 6);
        const isoProy = p => ({ u: (p.x + p.y) * ISO_C, v: (p.x - p.y) * ISO_S - p.z });
        function isometricoLinea(...a) { return PARTES_OK.cad ? isometricoLinea__p.apply(this, a) : cargarParte('cad').then(() => isometricoLinea__p.apply(this, a)); }
        function dibujoIsometrico(el, c, P) {
            const g = el.iso; if (!g) return '';
            const fs = MM(2.5), fsT = MM(4);
            const leg = a => { a = ((a % 360) + 360) % 360; return a > 90 && a < 270 ? a - 180 : a; };
            let h = `<rect x="${-MM(6)}" y="${-MM(24)}" width="${g.w + MM(12)}" height="${g.h + MM(30)}" fill="transparent"/>`;
            h += `<text x="0" y="${-MM(17)}" font-family="sans-serif" font-size="${fsT}" font-weight="bold" fill="${c}">${esc(tradMayDoc('ISOMÉTRICO'))} · ${esc(g.titulo)}</text><text x="0" y="${-MM(12)}" font-family="sans-serif" font-size="${fs}" fill="${c}">${esc(g.sub)}</text>`;
            // flecha del norte (eje N del isométrico)
            const nx = g.w + MM(2), ny = -MM(8), dl = MM(8);
            h += `<line x1="${nx}" y1="${ny}" x2="${(nx + dl * ISO_C).toFixed(2)}" y2="${(ny - dl * ISO_S).toFixed(2)}" stroke="${c}" stroke-width="0.8"/><polygon points="${(nx + dl * ISO_C).toFixed(2)},${(ny - dl * ISO_S).toFixed(2)} ${(nx + dl * ISO_C - MM(2)).toFixed(2)},${(ny - dl * ISO_S - MM(0.2)).toFixed(2)} ${(nx + dl * ISO_C - MM(1.4)).toFixed(2)},${(ny - dl * ISO_S + MM(1.2)).toFixed(2)}" fill="${c}"/><text x="${(nx + dl * ISO_C + MM(1)).toFixed(2)}" y="${(ny - dl * ISO_S).toFixed(2)}" font-family="sans-serif" font-size="${fs}" font-weight="bold" fill="${c}">N</text>`;
            g.segs.forEach(s => {
                h += `<line x1="${s.x1}" y1="${s.y1}" x2="${s.x2}" y2="${s.y2}" stroke="${c}" stroke-width="1.8" stroke-linecap="round"/>`;
                const len = Math.hypot(s.x2 - s.x1, s.y2 - s.y1); if (len < MM(6)) return;
                const ang = Math.atan2(s.y2 - s.y1, s.x2 - s.x1) * 180 / Math.PI, a = leg(ang), mx = (s.x1 + s.x2) / 2, my = (s.y1 + s.y2) / 2;
                h += `<text transform="translate(${mx.toFixed(2)} ${my.toFixed(2)}) rotate(${a.toFixed(1)})" x="0" y="${-MM(1.2)}" font-family="sans-serif" font-size="${fs}" text-anchor="middle" fill="${c}">${s.L}</text>`;
                if (len > MM(30)) h += `<text transform="translate(${mx.toFixed(2)} ${my.toFixed(2)}) rotate(${a.toFixed(1)})" x="0" y="${MM(3.4)}" font-family="sans-serif" font-size="${MM(2)}" text-anchor="middle" fill="${c}">${esc(s.tag)}</text>`;
            });
            const usados = [];
            g.marcas.forEach(m => {
                const kk = usados.filter(u => Math.hypot(u.x - m.x, u.y - m.y) < MM(2)).length; usados.push(m); const dyL = kk * MM(3.2);
                const s = g.segs.find(q => Math.hypot(q.x1 - m.x, q.y1 - m.y) < 0.5) || g.segs.find(q => Math.hypot(q.x2 - m.x, q.y2 - m.y) < 0.5);
                const ang = s ? Math.atan2(s.y2 - s.y1, s.x2 - s.x1) * 180 / Math.PI : 0, r = MM(1.8);
                let sym;
                if (m.tipo === 'valvula') sym = `<polygon points="${-r},${-r} ${r},${r} ${r},${-r} ${-r},${r}" fill="#fff" stroke="${c}" stroke-width="0.8"/>`;
                else if (m.tipo === 'bomba' || m.tipo === 'equipo' || m.tipo === 'terminal') sym = `<rect x="${-r * 1.4}" y="${-r * 1.4}" width="${r * 2.8}" height="${r * 2.8}" fill="#fff" stroke="${c}" stroke-width="0.8"/>`;
                else if (/^codo/.test(m.sub)) sym = '';
                else sym = `<circle cx="0" cy="0" r="${r * 0.8}" fill="#fff" stroke="${c}" stroke-width="0.8"/>`;
                h += `<g transform="translate(${m.x} ${m.y}) rotate(${ang.toFixed(1)})">${sym}</g>`;
                if (!/^codo/.test(m.sub)) h += `<line x1="${m.x}" y1="${m.y}" x2="${m.x + MM(4)}" y2="${m.y - MM(6) - dyL}" stroke="${c}" stroke-width="0.4"/><text x="${m.x + MM(4.5)}" y="${m.y - MM(6.3) - dyL}" font-family="sans-serif" font-size="${MM(2.2)}" fill="${c}">${esc(m.tag)}${m.ramal ? ' ↳' : ''}</text>`;
            });
            (g.cotas || []).forEach(q => { h += `<text x="${(q.x + MM(1.5)).toFixed(2)}" y="${(q.y + MM(4)).toFixed(2)}" font-family="sans-serif" font-size="${MM(2.2)}" font-style="italic" fill="${c}">${esc(q.t)}</text>`; });
            return h;
        }

        // ==================================================================================
        // 35) IMPORTAR LISTAS DE LÍNEAS Y EQUIPOS DESDE EXCEL y generar un esquema base
        // Hoja «Equipos»: Tag, Tipo, Nombre, Cota · Hoja «Líneas»: Línea, Nombre, Desde, Hasta, Material, Serie, DN,
        // Longitud (mm), Cota a, Cota b, Componentes (códigos separados por «;», p. ej. VB;FI;VR)
        // ==================================================================================
        function tipoDesdeTexto(t) {
            const s = String(t || '').trim(), k = s.toLowerCase(); if (!s) return null;
            if (/^bomba|^pump|^b$/i.test(s)) return 'bomba';
            if (TIPOS[k]) return k;
            const e = Object.entries(TIPOS).find(([kk, x]) => typeof x.codigo === 'string' && x.codigo.toLowerCase() === k) || Object.entries(TIPOS).find(([kk, x]) => x.nombre.toLowerCase().startsWith(k));
            return e ? e[0] : null;
        }
        function elementoDeTipo(sub, x, y, extra) {
            const el = sub === 'bomba' ? { type: 'bomba' } : { type: TIPOS[sub].type, subtype: sub };
            Object.assign(el, { id: 'sym_' + Date.now() + '_' + Math.floor(Math.random() * 1e6), x, y, scale: 1, rotation: 0, name: '' }, extra || {});
            if (el.type === 'valvula' && !el.modoK) el.modoK = sub === 'control' ? 'kvs' : 'crane';
            normalizarElemento(el); return el;
        }
        async function descargarPlantillaLineasEquipos() {
            cerrarMenus();
            try {
                const X = await cargarXLSX(), wb = X.utils.book_new();
                const eq = X.utils.aoa_to_sheet([['Tag', 'Tipo', 'Nombre', 'Cota (m)'], ['TK-01', 'tkalmacen', 'Tanque de agua', 0], ['B-01', 'bomba', 'Bomba de impulsión', 0], ['CON-01', 'consumo', 'Consumo planta', 5]]);
                eq['!cols'] = [10, 16, 26, 10].map(w => ({ wch: w })); X.utils.book_append_sheet(wb, eq, 'Equipos');
                const li = X.utils.aoa_to_sheet([['Línea', 'Nombre', 'Desde', 'Hasta', 'Material', 'Serie', 'DN', 'Longitud (mm)', 'Cota a (m)', 'Cota b (m)', 'Componentes'],
                    ['P01', 'Aspiración', 'TK-01', 'B-01', 'Acero al carbono', '40', 'DN 100', 4000, 0, 0, 'VM;FI'], ['P02', 'Impulsión', 'B-01', 'CON-01', 'Acero al carbono', '40', 'DN 80', 25000, 0, 5, 'VR;VM']]);
                li['!cols'] = [8, 18, 10, 10, 18, 10, 8, 14, 10, 10, 16].map(w => ({ wch: w })); X.utils.book_append_sheet(wb, li, 'Líneas');
                const cod = X.utils.aoa_to_sheet([['Código', 'Componente', 'Clave de tipo'], ...Object.entries(TIPOS).filter(([k, t]) => typeof t.codigo === 'string' && t.type !== 'anotacion' && t.cat !== 'ninguna').map(([k, t]) => [t.codigo, t.nombre, k]), ['B', 'Bomba centrífuga', 'bomba']]);
                cod['!cols'] = [8, 44, 16].map(w => ({ wch: w })); X.utils.book_append_sheet(wb, cod, 'Códigos');
                X.writeFile(wb, 'Plantilla_lineas_equipos_PIPING.xlsx');
            } catch (e) { alert(e.message); }
        }
        function importarLineasEquipos(...a) { return PARTES_OK.cad ? importarLineasEquipos__p.apply(this, a) : cargarParte('cad').then(() => importarLineasEquipos__p.apply(this, a)); }

        // puerto de salida de un elemento ya colocado: el libre más a la derecha

        // ==================================================================================
        // 39) BUSCAR UN COMPONENTE EN EL CATÁLOGO DEL FABRICANTE (catálogo / Supabase, librería o URL)
        // e insertarlo con sus datos
        // ==================================================================================
        let catExterno = [];
        function fuentesCatalogo() {
            const r = [];
            (CAT.valvulas || []).forEach((v, i) => r.push({ origen: /^Supabase/.test(window.CATALOGO_ORIGEN || '') ? 'Supabase' : 'Catálogo', nombre: v.nombre, sub: v.tipo, info: v.fuente || '', cv: v.cv, k: 'cat:' + i }));
            (typeof LIB !== 'undefined' ? LIB.items : []).filter(i => i.subtipo && (TIPOS[i.subtipo] || i.subtipo === 'bomba') && !LIB.ocultos.includes(i.id)).forEach(i => r.push({ origen: 'Librería', nombre: i.nombre, sub: i.subtipo, info: [i.fabricante, i.material, i.pn].filter(Boolean).join(' · '), item: i, k: 'lib:' + i.id }));
            catExterno.forEach((x, i) => r.push(Object.assign({ origen: 'URL', k: 'url:' + i }, x)));
            return r;
        }
        function buscarCatalogo() {
            cerrarMenus();
            document.getElementById('red-content').innerHTML = `<div class="flex gap-2 mb-2 text-xs"><input id="bc-q" placeholder="Buscar: fabricante, modelo, tipo (p. ej. «mariposa wafer», «Velan»)" class="border rounded p-1.5 flex-1" oninput="pintarBusquedaCatalogo()"><select id="bc-tipo" class="border rounded p-1" onchange="pintarBusquedaCatalogo()"><option value="">Todos los tipos</option>${[...new Set(fuentesCatalogo().map(x => x.sub))].sort().map(s => `<option value="${s}">${esc(s === 'bomba' ? 'Bomba' : (TIPOS[s] || {}).nombre || s)}</option>`).join('')}</select></div>
                <div class="flex gap-2 mb-2 text-[11px] items-center"><input id="bc-url" placeholder="URL de un catálogo JSON del fabricante (opcional)" class="border rounded p-1 flex-1" value="${esc(localStorage.getItem('piping-catalogo-url') || '')}"><button onclick="cargarCatalogoURL()" class="px-2 py-1 border rounded">Cargar</button></div>
                <div id="bc-lista" class="overflow-auto" style="max-height:55vh"></div>`;
            document.getElementById('red-footer').innerHTML = `<div class="flex gap-2 w-full text-xs"><span class="text-slate-400 self-center">Se inserta en el centro de la vista; si hay un elemento seleccionado, hereda su línea y su DN.</span><span class="flex-1"></span><button onclick="cerrarModalRed()" class="px-3 py-1.5 border rounded">Cerrar</button></div>`;
            document.querySelector('#modal-red h3 span').innerHTML = '<i class="fa-solid fa-magnifying-glass text-blue-600 mr-1.5"></i> Buscar en el catálogo del fabricante';
            document.querySelector('#modal-red > div').style.width = 'min(1000px, 97vw)';
            document.getElementById('modal-red').style.display = 'flex';
            pintarBusquedaCatalogo(); setTimeout(() => document.getElementById('bc-q')?.focus(), 30);
        }
        function pintarBusquedaCatalogo() {
            const q = (document.getElementById('bc-q')?.value || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''), t = document.getElementById('bc-tipo')?.value || '';
            const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
            const res = fuentesCatalogo().filter(x => (!t || x.sub === t) && q.split(/\s+/).every(w => !w || norm(x.nombre + ' ' + x.info + ' ' + ((TIPOS[x.sub] || {}).nombre || x.sub) + ' ' + x.origen).includes(w)));
            const cont = document.getElementById('bc-lista'); if (!cont) return;
            cont.innerHTML = res.length ? `<table class="w-full text-[11px]"><thead class="sticky top-0 bg-white"><tr class="text-left text-slate-500"><th class="py-1">Origen</th><th>Tipo</th><th>Componente</th><th>Datos</th><th></th></tr></thead><tbody>${res.slice(0, 200).map(x => `<tr class="border-t border-slate-100"><td class="py-1 pr-2 whitespace-nowrap">${esc(x.origen)}</td><td class="pr-2">${esc(x.sub === 'bomba' ? 'Bomba' : (TIPOS[x.sub] || {}).nombre || x.sub)}</td><td class="pr-2 font-medium">${esc(x.nombre)}</td><td class="text-slate-500">${esc(x.info)}${x.cv ? ` · Cv ${Object.keys(x.cv).length} tamaños` : ''}</td><td class="text-right"><button onclick="insertarDesdeCatalogo('${esc(x.k)}')" class="px-2 py-0.5 bg-blue-600 hover:bg-blue-700 text-white rounded">Insertar</button></td></tr>`).join('')}</tbody></table>${res.length > 200 ? `<p class="text-slate-400 mt-1">${res.length - 200} más: afina la búsqueda.</p>` : ''}` : '<p class="text-slate-400 italic">Sin resultados.</p>';
        }
        async function cargarCatalogoURL() {
            const u = (document.getElementById('bc-url')?.value || '').trim(); if (!u) return;
            try {
                const r = await fetch(u); if (!r.ok) throw new Error('HTTP ' + r.status);
                const d = await r.json(), lista = Array.isArray(d) ? d : (d.valvulas || d.items || d.componentes || []);
                catExterno = lista.map(x => ({ nombre: x.nombre || x.name || x.modelo || '?', sub: tipoDesdeTexto(x.tipo || x.subtipo || x.type) || 'bola', info: [x.fabricante || x.manufacturer, x.material, x.pn, x.fuente].filter(Boolean).join(' · '), cv: x.cv, item: x.props || x.pn || x.url ? { id: 'url:' + (x.id || x.nombre), nombre: x.nombre, fabricante: x.fabricante, material: x.material, pn: x.pn, url: x.url, props: x.props || {} } : null }));
                try { localStorage.setItem('piping-catalogo-url', u); } catch (e) { }
                aviso(`${catExterno.length} componente(s) cargados de la URL.`, 'ok'); pintarBusquedaCatalogo();
            } catch (e) { aviso('No se ha podido leer el catálogo: ' + e.message + ' (la URL debe devolver JSON y permitir CORS).', 'error'); }
        }
        function insertarDesdeCatalogo(k) {
            const x = fuentesCatalogo().find(q => q.k === k); if (!x) return;
            const sel = idSeleccionado && elementosRed.find(e => e.id === idSeleccionado), c = centroVista();
            guardarEstado(); invalidarResultados(); document.getElementById('empty-state')?.remove();
            const el = elementoDeTipo(x.sub === 'bomba' ? 'bomba' : (TIPOS[x.sub] ? x.sub : 'bola'), c.x - 25, c.y + 25, sel && sel.dn && /^DN/.test(sel.dn) && x.sub !== 'bomba' ? { dn: sel.dn } : {});
            if (sel && sel.linea) el.linea = sel.linea;
            if (x.item) aplicarItemLib(el, x.item);
            if (x.cv && el.type === 'valvula') {
                if (x.origen === 'URL') { CAT.valvulas.push({ nombre: x.nombre, tipo: el.subtype, fuente: 'URL', cv: x.cv }); }
                el.modoK = 'catalogo'; el.serieCat = x.nombre; normalizarElemento(el);
            }
            elementosRed.push(el); asignarNumero(el); cerrarModalRed(); renderizarVectorial(); seleccionarElemento(el.id);
            aviso(`${tagDe(el)} insertado: ${x.nombre}. Arrástralo a su sitio.`, 'ok');
        }

        // ==================================================================================
        // 40) VALIDACIÓN PED POR LÍNEA: módulo de evaluación de la conformidad (anexo III) y enlace con
        // «Recipientes a presión» (la aplicación devuelve categoría y módulo con postMessage)
        // ==================================================================================
        const MODULOS_PED = {
            'Art. 4.3': ['SEP (buenas prácticas de ingeniería)'],
            'I': ['A'],
            'II': ['A2', 'D1', 'E1'],
            'III': ['B (tipo de diseño) + D', 'B (tipo de diseño) + F', 'B (tipo de producción) + E', 'B (tipo de producción) + C2', 'H'],
            'IV': ['B (tipo de producción) + D', 'B (tipo de producción) + F', 'G', 'H1']
        };
        const modulosDe = cat => MODULOS_PED[cat] || [];
        function enlacePEDLinea(x) {
            const fl = (ultimoCalculo && ultimoCalculo.resultado.fluido) || {};
            const q = new URLSearchParams({ equipo: 'tuberia', ps: (+x.PS).toFixed(2), dn: String(x.DN), grupo: String(x.grupo), estado: x.gas ? 'gas' : 'liquido', nombre: fl.nombre || '', ts: String(x.TS ?? ''), linea: x.linea, origen: 'PIPING · ' + x.linea, respuesta: 'postMessage' });
            const id = FLUIDO_RECIPIENTES[fl.nombre]; if (id) q.set('fluido', id);
            return URL_RECIPIENTES + '?' + q.toString();
        }
        let ventanaPED = null;
        function validarLineaPED(linea) {
            const x = ((ultimoCalculo && ultimoCalculo.resultado.ped) || []).find(p => p.linea === linea); if (!x) return;
            ventanaPED = window.open(enlacePEDLinea(x), 'piping-recipientes');
            aviso(`Validando ${linea} en «Recipientes a presión»: al confirmar allí la categoría y el módulo se anotan aquí.`);
        }
        window.addEventListener('message', ev => {
            const d = ev.data; if (!d || d.tipo !== 'ped-resultado' || !d.linea) return;
            if (!(ev.source === ventanaPED || ev.source === window || /^https:\/\/jamanteiga\.github\.io$/.test(ev.origin) || ev.origin === location.origin)) return;
            proyecto.pedModulos = proyecto.pedModulos || {};
            const m = proyecto.pedModulos[d.linea] = proyecto.pedModulos[d.linea] || {};
            m.validado = { categoria: String(d.categoria || ''), modulo: String(d.modulo || ''), fecha: new Date().toISOString(), origen: 'Recipientes a presión' };
            if (d.modulo) m.modulo = String(d.modulo);
            marcarCambios(true);
            const x = ((ultimoCalculo && ultimoCalculo.resultado.ped) || []).find(p => p.linea === d.linea);
            const dif = x && d.categoria && normCat(d.categoria) !== normCat(x.cat);
            aviso(`PED ${d.linea}: categoría ${d.categoria}${d.modulo ? ', módulo ' + d.modulo : ''} recibida${dif ? ` — distinta de la calculada (${x.cat}): revísalo` : ''}.`, dif ? 'error' : 'ok');
            if (document.getElementById('ped-modulos')) validacionPED();
        });
        const normCat = c => { const s = String(c).toUpperCase().replace(/CATEGOR[IÍ]A\s*/, '').trim(); return /SEP|4\.?3|ART/.test(s) ? 'ART. 4.3' : s; };
        function validacionPED() {
            cerrarMenus();
            const ped = (ultimoCalculo && ultimoCalculo.resultado.ped) || [];
            if (!ped.length) { aviso('Calcula la red: no hay líneas clasificadas.', 'error'); return; }
            const M = proyecto.pedModulos = proyecto.pedModulos || {};
            const filas = ped.map(x => {
                const ops = modulosDe(x.cat), m = M[x.linea] || {}, v = m.validado;
                const sel = ops.length ? `<select class="border rounded p-0.5" onchange="fijarModuloPED('${x.linea}', this.value)">${ops.length > 1 ? '<option value="">— elegir —</option>' : ''}${ops.map(o => `<option ${m.modulo === o || (ops.length === 1 && !m.modulo) ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>` : '<span class="text-slate-400">—</span>';
                const ok = v ? normCat(v.categoria) === normCat(x.cat) : null;
                return `<tr class="border-t border-slate-100"><td class="py-1 font-bold">${esc(x.linea)}</td><td>${fmt(x.PS, 2)}</td><td>${x.DN}</td><td>${esc(x.cuadro)}</td><td class="font-bold">${esc(x.cat)}</td><td>${sel}</td>
                    <td>${v ? `<span class="${ok ? 'text-emerald-700' : 'text-rose-700'}"><i class="fa-solid ${ok ? 'fa-check' : 'fa-triangle-exclamation'} mr-1"></i>${esc(v.categoria)}${v.modulo ? ' · ' + esc(v.modulo) : ''}</span> <span class="text-slate-400">${fechaHora(v.fecha)}</span>` : '<span class="text-slate-400">sin validar</span>'}</td>
                    <td class="text-right">${x.cat === 'Fuera' ? '' : `<button onclick="validarLineaPED('${x.linea}')" class="px-2 border rounded text-blue-700">Validar en Recipientes</button>`}</td></tr>`;
            }).join('');
            document.getElementById('red-content').innerHTML = `<p class="text-[11px] text-slate-500 mb-2">Categoría según el anexo II (cuadros 6 a 9) y módulos de evaluación de la conformidad admisibles según el anexo III de la Directiva 2014/68/UE. El módulo elegido y la validación externa se guardan con el proyecto y aparecen en el informe (apartado 5).</p>
                <table id="ped-modulos" class="w-full text-[11px]"><thead><tr class="text-left text-slate-500"><th class="py-1">Línea</th><th>PS (bar)</th><th>DN</th><th>Cuadro</th><th>Categoría</th><th>Módulo</th><th>Validación externa</th><th></th></tr></thead><tbody>${filas}</tbody></table>
                <p class="text-[10px] text-slate-400 mt-2">«Validar en Recipientes» abre ${esc(URL_RECIPIENTES)} con los datos de la línea; la aplicación devuelve <code>{tipo: 'ped-resultado', linea, categoria, modulo}</code> con postMessage.</p>`;
            document.getElementById('red-footer').innerHTML = '<button onclick="cerrarModalRed()" class="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded font-medium">Cerrar</button>';
            document.querySelector('#modal-red h3 span').innerHTML = '<i class="fa-solid fa-certificate text-blue-600 mr-1.5"></i> Validación PED por línea';
            document.querySelector('#modal-red > div').style.width = 'min(1150px, 97vw)';
            document.getElementById('modal-red').style.display = 'flex';
        }
        function fijarModuloPED(linea, v) { proyecto.pedModulos = proyecto.pedModulos || {}; (proyecto.pedModulos[linea] = proyecto.pedModulos[linea] || {}).modulo = v; marcarCambios(true); }
        // filas de la tabla del informe

        // ==================================================================================
        // 36) NUBE (Supabase): usuarios, equipos, proyectos y librerías compartidas con bloqueo de edición
        // Archivo > Nube. Tablas piping_* y permisos: supabase/04_proyectos_usuarios.sql (RLS por equipo).
        // Cliente REST propio (sin dependencias): auth/v1 y rest/v1 con la clave anon + token del usuario.
        // ==================================================================================
        const SB = {
            sesion() { try { return JSON.parse(localStorage.getItem('piping-sb-sesion') || 'null'); } catch (e) { return null; } },
            fijar(d) { const s = { access_token: d.access_token, refresh_token: d.refresh_token, expires_at: d.expires_at || Math.floor(Date.now() / 1000) + (d.expires_in || 3600), user: { id: d.user && d.user.id, email: d.user && d.user.email } }; try { localStorage.setItem('piping-sb-sesion', JSON.stringify(s)); } catch (e) { } return s; },
            salir() { try { localStorage.removeItem('piping-sb-sesion'); } catch (e) { } },
            async auth(ruta, cuerpo) {
                if (!claveSupabase()) throw new Error('Configura antes la conexión (Opciones > Supabase > Configurar conexión).');
                const r = await fetch(`${SUPABASE_URL}/auth/v1/${ruta}`, { method: 'POST', headers: { apikey: claveSupabase(), 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) });
                const d = await r.json().catch(() => ({}));
                if (!r.ok) throw new Error(d.error_description || d.msg || d.message || ('HTTP ' + r.status));
                return d;
            },
            async token() {
                let s = this.sesion(); if (!s) throw new Error('Inicia sesión (Archivo > Nube > Iniciar sesión).');
                if (s.expires_at && s.expires_at * 1000 < Date.now() + 60000) s = this.fijar(await this.auth('token?grant_type=refresh_token', { refresh_token: s.refresh_token }));
                return s.access_token;
            },
            async rest(ruta, o = {}) {
                const t = await this.token();
                const h = { apikey: claveSupabase(), Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }; if (o.prefer) h.Prefer = o.prefer;
                const r = await fetch(`${SUPABASE_URL}/rest/v1/${ruta}`, { method: o.method || 'GET', headers: h, body: o.body != null ? JSON.stringify(o.body) : undefined });
                const txt = await r.text(); let d = null; try { d = txt ? JSON.parse(txt) : null; } catch (e) { d = txt; }
                if (!r.ok) throw new Error((d && (d.message || d.hint || d.error)) || ('HTTP ' + r.status));
                return d;
            },
            rpc(f, args) { return this.rest('rpc/' + f, { method: 'POST', body: args || {} }); }
        };
        let nubeActual = null, nubeSoloLectura = false, temporizadorBloqueo = null;
        const usuarioNube = () => (SB.sesion() || {}).user || null;
        { const _cc = comprobarCongelado; comprobarCongelado = function () { if (nubeSoloLectura) { aviso(`Proyecto de la nube en solo lectura: lo está editando ${nubeActual && nubeActual.bloqueadoPor || 'otro usuario'}. Archivo > Nube > Reintentar edición.`, 'error'); throw new ErrorPlanoCongelado(); } return _cc.apply(this, arguments); }; }
        async function nubeIniciarSesion() {
            cerrarMenus();
            if (!claveSupabase()) { configurarSupabase(); return; }
            const r = await dialogo('<i class="fa-solid fa-user text-blue-600 mr-1.5"></i>Nube · iniciar sesión', `<div class="space-y-2"><label class="block">Correo <input id="nb-email" type="email" class="border rounded p-1 w-full" value="${esc((usuarioNube() || {}).email || '')}"></label><label class="block">Contraseña <input id="nb-clave" type="password" class="border rounded p-1 w-full"></label><p class="text-[10px] text-slate-400">Usuarios de Supabase Auth del proyecto ${esc(SUPABASE_URL)}.</p></div>`,
                [{ texto: 'Entrar', valor: 'entrar', clase: 'bg-blue-600 hover:bg-blue-700 text-white' }, { texto: 'Crear cuenta', valor: 'alta' }, { texto: 'Cancelar', valor: null }]);
            if (!r) return;
            const email = document.getElementById('nb-email').value.trim(), password = document.getElementById('nb-clave').value;
            try {
                if (r === 'alta') { const d = await SB.auth('signup', { email, password }); if (d.access_token) { SB.fijar(d); aviso('Cuenta creada y sesión iniciada: ' + email, 'ok'); } else aviso('Cuenta creada: confirma el correo y vuelve a entrar.', 'ok'); return; }
                SB.fijar(await SB.auth('token?grant_type=password', { email, password }));
                aviso('Sesión iniciada: ' + email, 'ok');
            } catch (e) { aviso('Nube: ' + e.message, 'error'); }
        }
        async function nubeCerrarSesion() { cerrarMenus(); await nubeLiberar(); SB.salir(); nubeActual = null; nubeSoloLectura = false; aviso('Sesión cerrada.'); }
        async function equiposNube() { const u = usuarioNube(); return (await SB.rest(`piping_miembros?select=equipo_id,rol,equipos:piping_equipos(nombre)&usuario_id=eq.${u.id}`)) || []; }
        async function nubeEquipos() {
            cerrarMenus();
            try {
                const eq = await equiposNube();
                const r = await dialogo('<i class="fa-solid fa-users text-blue-600 mr-1.5"></i>Equipos', `${eq.length ? `<table class="w-full text-[11px]"><tr class="text-left text-slate-500"><th>Equipo</th><th>Rol</th></tr>${eq.map(x => `<tr class="border-t"><td class="py-1">${esc(x.equipos ? x.equipos.nombre : x.equipo_id)}</td><td>${esc(x.rol)}</td></tr>`).join('')}</table>` : '<p>No perteneces a ningún equipo.</p>'}
                    <div class="mt-3 grid grid-cols-2 gap-2"><label>Nuevo equipo <input id="nb-eq" class="border rounded p-1 w-full"></label><span></span><label>Añadir miembro (correo) <input id="nb-mi" class="border rounded p-1 w-full"></label><label>al equipo <select id="nb-mieq" class="border rounded p-1 w-full">${eq.filter(x => x.rol === 'admin').map(x => `<option value="${x.equipo_id}">${esc(x.equipos ? x.equipos.nombre : x.equipo_id)}</option>`).join('')}</select></label></div>`,
                    [{ texto: 'Crear equipo', valor: 'crear' }, { texto: 'Añadir miembro', valor: 'miembro' }, { texto: 'Cerrar', valor: null }]);
                if (r === 'crear') { const n = document.getElementById('nb-eq').value.trim(); if (!n) return; await SB.rest('piping_equipos', { method: 'POST', body: { nombre: n }, prefer: 'return=representation' }); aviso(`Equipo «${n}» creado (eres su administrador).`, 'ok'); }
                if (r === 'miembro') { const m = document.getElementById('nb-mi').value.trim(), e = document.getElementById('nb-mieq').value; if (!m || !e) return; await SB.rpc('piping_anadir_miembro', { p_equipo: e, p_email: m, p_rol: 'editor' }); aviso(`${m} añadido al equipo como editor.`, 'ok'); }
            } catch (e) { aviso('Nube: ' + e.message, 'error'); }
        }
        function nubeGuardar(...a) { return PARTES_OK.admin ? nubeGuardar__p.apply(this, a) : cargarParte('admin').then(() => nubeGuardar__p.apply(this, a)); }
        function nubeAbrir(...a) { return PARTES_OK.admin ? nubeAbrir__p.apply(this, a) : cargarParte('admin').then(() => nubeAbrir__p.apply(this, a)); }
        async function nubeAbrirProyecto(id) {
            try {
                if (hayCambiosSinGuardar && !confirm('Hay cambios sin guardar en el proyecto actual. ¿Abrir el de la nube de todos modos?')) return;
                await nubeLiberar();
                const d = await SB.rest(`piping_proyectos?id=eq.${id}&select=id,nombre,version,contenido`); if (!d || !d.length) throw new Error('Proyecto no encontrado.');
                cerrarModalRed(); nubeSoloLectura = false;
                cargarProyectoDesdeTexto(d[0].contenido);
                nubeActual = { id, version: d[0].version || 1, nombre: d[0].nombre };
                const ok = await nubeBloquear();
                if (!ok) { nubeSoloLectura = true; aviso(`Abierto en SOLO LECTURA: lo está editando ${nubeActual.bloqueadoPor}. Archivo > Nube > Reintentar edición.`, 'error'); }
                else aviso(`Proyecto «${d[0].nombre}» abierto de la nube y bloqueado para tu edición.`, 'ok');
                marcarCambios(false);
            } catch (e) { aviso('Nube: ' + e.message, 'error'); }
        }
        async function nubeBloquear() {
            if (!nubeActual) return false;
            const r = await SB.rpc('piping_bloquear_proyecto', { p_id: nubeActual.id, p_minutos: 10 });
            const x = Array.isArray(r) ? r[0] : r;
            if (x && x.ok) { nubeActual.bloqueadoPor = null; clearInterval(temporizadorBloqueo); temporizadorBloqueo = setInterval(() => { if (nubeActual && !nubeSoloLectura) SB.rpc('piping_bloquear_proyecto', { p_id: nubeActual.id, p_minutos: 10 }).catch(e => console.warn('Bloqueo:', e.message)); }, 5 * 60 * 1000); return true; }
            nubeActual.bloqueadoPor = (x && x.por) || 'otro usuario'; return false;
        }
        async function nubeReintentarEdicion() { cerrarMenus(); if (!nubeActual) return; if (await nubeBloquear().catch(() => false)) { nubeSoloLectura = false; aviso('Ya puedes editar: el proyecto está bloqueado para ti.', 'ok'); } else aviso(`Sigue bloqueado por ${nubeActual.bloqueadoPor}.`, 'error'); }
        async function nubeLiberar() { clearInterval(temporizadorBloqueo); if (nubeActual && !nubeSoloLectura) { try { await SB.rpc('piping_liberar_proyecto', { p_id: nubeActual.id }); } catch (e) { } } }
        window.addEventListener('beforeunload', () => {
            if (!nubeActual || nubeSoloLectura) return; const s = SB.sesion(); if (!s) return;
            try { fetch(`${SUPABASE_URL}/rest/v1/rpc/piping_liberar_proyecto`, { method: 'POST', keepalive: true, headers: { apikey: claveSupabase(), Authorization: 'Bearer ' + s.access_token, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_id: nubeActual.id }) }); } catch (e) { }
        });
        async function nubeSubirLibreria() {
            cerrarMenus();
            try {
                const eq = (await equiposNube()).filter(x => x.rol !== 'lector'); if (!eq.length) { aviso('Crea antes un equipo (Archivo > Nube > Equipos).', 'error'); return; }
                const r = await dialogo('<i class="fa-solid fa-book text-blue-600 mr-1.5"></i>Compartir librería', `<p>Se suben los ${LIB.items.length} modelos de tu librería.</p><p class="mt-1">Equipo: <select id="nb-lq" class="border rounded p-1">${eq.map(x => `<option value="${x.equipo_id}">${esc(x.equipos ? x.equipos.nombre : x.equipo_id)}</option>`).join('')}</select> Nombre: <input id="nb-ln" class="border rounded p-1" value="Librería ${esc(usuarioNube().email.split('@')[0])}"></p>`, [{ texto: 'Subir', valor: 'si', clase: 'bg-blue-600 hover:bg-blue-700 text-white' }, { texto: 'Cancelar', valor: null }]);
                if (r !== 'si') return;
                await SB.rest('piping_librerias?on_conflict=equipo_id,nombre', { method: 'POST', body: { equipo_id: document.getElementById('nb-lq').value, nombre: document.getElementById('nb-ln').value.trim() || 'Librería', items: LIB.items, actualizado: new Date().toISOString(), actualizado_por_email: usuarioNube().email }, prefer: 'resolution=merge-duplicates,return=minimal' });
                aviso('Librería compartida con el equipo.', 'ok');
            } catch (e) { aviso('Nube: ' + e.message, 'error'); }
        }
        async function nubeDescargarLibreria() {
            cerrarMenus();
            try {
                const ls = await SB.rest('piping_librerias?select=id,nombre,actualizado,actualizado_por_email,items,equipos:piping_equipos(nombre)&order=actualizado.desc');
                if (!ls || !ls.length) { aviso('Tus equipos no tienen librerías compartidas.'); return; }
                const v = await dialogo('<i class="fa-solid fa-book text-blue-600 mr-1.5"></i>Librerías del equipo', '<p>Elige la librería a incorporar (los modelos con el mismo identificador se actualizan; los tuyos se conservan).</p>',
                    [...ls.map(l => ({ texto: `${l.nombre} · ${(l.items || []).length} modelos · ${l.equipos ? l.equipos.nombre : ''} · ${fechaDMA(String(l.actualizado).slice(0, 10))}`, valor: l.id, clase: 'bg-white hover:bg-slate-50 border border-slate-300 text-slate-700' })), { texto: 'Cancelar', valor: null }]);
                const l = ls.find(x => x.id === v); if (!l) return;
                const mapa = new Map(LIB.items.map(i => [i.id, i])); (l.items || []).forEach(i => mapa.set(i.id, i)); LIB.items = [...mapa.values()];
                guardarLib(); aplicarLibreria(); construirLibreria();
                aviso(`Librería «${l.nombre}» incorporada (${(l.items || []).length} modelos).`, 'ok');
            } catch (e) { aviso('Nube: ' + e.message, 'error'); }
        }
        function submenuNube() {
            const u = usuarioNube();
            return [
                u ? { icono: 'fa-user-check', texto: 'Sesión: ' + u.email, accion: () => {} } : { icono: 'fa-right-to-bracket', texto: 'Iniciar sesión...', accion: () => nubeIniciarSesion() },
                'sep',
                { icono: 'fa-cloud-arrow-down', texto: 'Abrir de la nube...', accion: () => nubeAbrir() },
                { icono: 'fa-cloud-arrow-up', texto: nubeActual ? 'Guardar en la nube (' + (nubeActual.nombre || '') + ')' : 'Guardar en la nube...', accion: () => nubeGuardar(false) },
                ...(nubeActual ? [{ icono: 'fa-clone', texto: 'Guardar en la nube como proyecto nuevo...', accion: () => nubeGuardar(true) }] : []),
                ...(nubeSoloLectura ? [{ icono: 'fa-lock-open', texto: 'Reintentar edición (bloqueo)', accion: () => nubeReintentarEdicion() }] : []),
                'sep',
                { icono: 'fa-book', texto: 'Compartir mi librería con el equipo...', accion: () => nubeSubirLibreria() },
                { icono: 'fa-book-open', texto: 'Incorporar librería del equipo...', accion: () => nubeDescargarLibreria() },
                { icono: 'fa-users', texto: 'Equipos...', accion: () => nubeEquipos() },
                ...(u ? ['sep', { icono: 'fa-right-from-bracket', texto: 'Cerrar sesión', accion: () => nubeCerrarSesion() }] : [])
            ];
        }

        // ==================================================================================
        // 38) PDF VECTORIAL CON CAPAS (una página por hoja; cada capa CAD es una capa PDF)
        // Escritor PDF propio: trazos, rellenos, discontinuas, transparencias, textos Helvetica (WinAnsi)
        // y el logotipo. Los caracteres fuera de WinAnsi (coreano…) se sustituyen.
        // ==================================================================================
        const ANCHOS_HELV = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
        const ANCHOS_HELVB = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];
        const WINANSI_EXTRA = { '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8A, '‹': 0x8B, 'Œ': 0x8C, 'Ž': 0x8E, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9A, '›': 0x9B, 'œ': 0x9C, 'ž': 0x9E, 'Ÿ': 0x9F, 'μ': 0xB5 };
        const SUSTITUTOS_PDF = { '≥': '>=', '≤': '<=', '→': '->', '←': '<-', '↔': '<->', '↳': '>', 'Δ': 'D', 'ρ': 'rho', 'ν': 'nu', 'η': 'eta', 'λ': 'lambda', '√': 'raiz', '₀': '0', '₁': '1', '₂': '2', '″': '"', '′': "'", '−': '-', '·': '·', '⌀': 'Ø', '✓': 'OK' };
        
        const anchoHelv = (s, neg) => { const T = neg ? ANCHOS_HELVB : ANCHOS_HELV; let w = 0; for (const ch of s) { const c = ch.charCodeAt(0); w += c >= 32 && c < 127 ? T[c - 32] : 556; } return w / 1000; };
        const escPDF = s => s.replace(/[\\()]/g, '\\$&');
        const nPDF = v => { const x = Math.round(v * 1000) / 1000; return Object.is(x, -0) ? '0' : String(x); };
        
        // ---- trayectos SVG (path d) → órdenes PDF con curvas de Bézier ----
        
        const KAPPA = 0.5522847498;

        // dibujo de la hoja cargada en el lienzo → órdenes PDF por capa

        const bytesLatin = s => { const u = new Uint8Array(s.length); for (let k = 0; k < s.length; k++) u[k] = s.charCodeAt(k) & 0xFF; return u; };
        
        function exportarPDFCapas(...a) { return PARTES_OK.cad ? exportarPDFCapas__p.apply(this, a) : cargarParte('cad').then(() => exportarPDFCapas__p.apply(this, a)); }

        // ==================================================================================
        // v8.3: integración (tipos nuevos de anotación, dibujo, menús contextuales, árbol, guardado)
        // ==================================================================================
        Object.assign(TIPOS, {
            banderola:  { type: 'anotacion', codigo: 'BAN', nombre: 'Banderola de línea', cat: 'ninguna', calc: 'sinflujo', puertos: [] },
            comentario: { type: 'anotacion', codigo: 'COM', nombre: 'Comentario de revisión', cat: 'ninguna', calc: 'sinflujo', puertos: [] },
            isometrico: { type: 'anotacion', codigo: 'ISO', nombre: 'Isométrico de línea', cat: 'ninguna', calc: 'sinflujo', puertos: [] }
        });
        // banderolas y comentarios siguen a su elemento sin línea de referencia (las notas ancladas sí la llevan)
        function anclarSigue(n, a) { n.sigueA = a.id; n.ox = n.x - a.x; n.oy = n.y - a.y; }
        { const _da = dibujoAnotacion; dibujoAnotacion = function (el, c, P) {
            if (el.subtype === 'banderola') return dibujoBanderola(el, c, P);
            if (el.subtype === 'comentario') return opciones.verComentarios === false ? '' : dibujoComentario(el, c, P);
            if (el.subtype === 'isometrico') return dibujoIsometrico(el, c, P);
            return _da(el, c, P);
        }; }
        { const _rv = renderizarVectorial; renderizarVectorial = function () {
            elementosRed.forEach(n => { if (!n.sigueA) return; const a = elementosRed.find(e => e.id === n.sigueA); if (!a) { delete n.sigueA; return; } n.x = a.x + (+n.ox || 0); n.y = a.y + (+n.oy || 0); });
            return _rv.apply(this, arguments);
        }; }
        // transformación del volteo (simetría) de un símbolo: y → 50 − y en coordenadas locales
        const trEspejo = el => el && el.espejo && el.type !== 'tuberia' && !esAnotacion(el) ? ' translate(0, 50) scale(1, -1)' : '';
        // menús contextuales
        { const _ime = itemsMenuElemento; itemsMenuElemento = function (el) {
            const it = _ime(el); if (esTablaHoja(el) || esAnotacion(el)) {
                if (el.subtype === 'comentario') it.splice(1, 0, { icono: el.estadoCom === 'resuelto' ? 'fa-rotate-left' : 'fa-check', texto: el.estadoCom === 'resuelto' ? 'Reabrir comentario' : 'Marcar comentario como resuelto', accion: () => estadoComentario(hojaActual, el.id) }, { icono: 'fa-comment-dots', texto: 'Comentarios de revisión...', accion: () => verComentarios() });
                return it;
            }
            const i = it.findIndex(x => x && x.icono === 'fa-arrows-up-down-left-right') + 1;
            const extra = [
                ...(el.type === 'tuberia' ? [{ icono: 'fa-flag', texto: 'Banderola de línea', accion: () => { const n = insertarBanderola(el); if (!n) aviso('Esta tubería ya tiene banderola.'); } }] : []),
                ...(el.type === 'bomba' ? [{ icono: 'fa-chart-line', texto: 'Curva de la bomba y de la red', accion: () => curvaBombaRed(el.id) }] : []),
                { icono: 'fa-clone', texto: 'Copiar, reflejar, isométrico', sub: [
                    { icono: 'fa-arrows-left-right', texto: 'Simetría izquierda ↔ derecha', accion: () => simetriaSeleccion('v') },
                    { icono: 'fa-arrows-up-down', texto: 'Simetría arriba ↔ abajo', accion: () => simetriaSeleccion('h') },
                    { icono: 'fa-table-cells', texto: 'Matriz (copias)...', accion: () => matrizSeleccion() },
                    ...(el.linea ? ['sep', { icono: 'fa-clone', texto: `Duplicar la línea ${el.linea}`, accion: () => duplicarLinea(el.linea) }, { icono: 'fa-cube', texto: `Isométrico de la línea ${el.linea}`, accion: () => isometricoLinea(el.linea) }] : []),
                    'sep', { icono: 'fa-comment-dots', texto: 'Comentario de revisión', accion: () => { const c = centroElemento(el); insertarComentario(c.x + 20, c.y - 30); } }] }
            ];
            it.splice(i > 0 ? i : it.length - 2, 0, ...extra);
            return it;
        }; }
        { const _iml = itemsMenuLienzo; itemsMenuLienzo = function (px, py) {
            const it = _iml(px, py);
            it.push({ icono: 'fa-comment-dots', texto: 'Comentario de revisión aquí', accion: () => insertarComentario(px, py) });
            if (lineas.length) it.push({ icono: 'fa-cube', texto: 'Isométrico de línea...', accion: () => isometricoLinea() });
            return it.sort((a, b) => a.texto.localeCompare(b.texto, 'es'));
        }; }
        // árbol: botón derecho sobre una línea
        document.getElementById('arbol-cuerpo')?.addEventListener('contextmenu', e => {
            const n = e.target.closest && e.target.closest('.nodo'); if (!n) return;
            const m = (n.getAttribute('onclick') || '').match(/seleccionarLinea\('([^']+)'\)/); if (!m) return;
            e.preventDefault(); e.stopPropagation();
            const id = m[1];
            mostrarMenuContextual(e.clientX, e.clientY, [
                { icono: 'fa-object-group', texto: `Seleccionar la línea ${id}`, accion: () => seleccionarLinea(id) },
                { icono: 'fa-clone', texto: 'Duplicar línea', accion: () => duplicarLinea(id) },
                { icono: 'fa-cube', texto: 'Isométrico de la línea', accion: () => isometricoLinea(id) },
                { icono: 'fa-flag', texto: 'Banderola de línea', accion: () => { const ts = elementosRed.filter(x => x.type === 'tuberia' && x.linea === id).sort((a, b) => b.longitud - a.longitud); if (ts.length && insertarBanderola(ts[0])) aviso(`Banderola añadida a ${id}.`, 'ok'); else aviso('La línea no tiene tuberías o ya tiene banderola.'); } }
            ]);
        });
        // 9) antes de guardar se ofrecen unir los extremos casi unidos
        { const _cs = comprobarSueltosAntesDeGuardar; comprobarSueltosAntesDeGuardar = async function () { try { await corregirConexiones(true); } catch (e) { console.warn(e); } return _cs.apply(this, arguments); }; }

        // ==================================================================================
        // DICCIONARIOS BAJO DEMANDA (i18n/<idioma>.js): solo se descarga el idioma de la interfaz y,
        // si es otro, el del informe y el cajetín
        // ==================================================================================
        const VERSION_WEB = '8.19.1';
        const IDIOMAS_CARGADOS = new Set(['es']), CARGAS_IDIOMA = {};
        function integrarIdioma(l) {
            const x = window.PIPING_I18N && window.PIPING_I18N[l]; if (!x || IDIOMAS_CARGADOS.has(l)) return !!x;
            Object.assign(DICCIONARIO[l], x.d); Object.assign(TR83[l], x.t);
            Object.entries(x.t).forEach(([k, v]) => { if (!/\{\d+\}/.test(k) && DICCIONARIO[l][k] == null && v !== k) DICCIONARIO[l][k] = v; });
            delete PLANTILLAS_TR[l]; IDIOMAS_CARGADOS.add(l); return true;
        }
        function asegurarIdioma(l) {
            if (!IDIOMAS[l] || IDIOMAS_CARGADOS.has(l) || integrarIdioma(l)) return Promise.resolve(true);
            if (!CARGAS_IDIOMA[l]) CARGAS_IDIOMA[l] = new Promise(ok => { const s = document.createElement('script'); s.src = `i18n/${l}.js?v=${VERSION_WEB}`; s.onload = () => ok(integrarIdioma(l)); s.onerror = () => { aviso(`No se ha podido cargar el idioma ${IDIOMAS[l]} (i18n/${l}.js).`, 'error'); delete CARGAS_IDIOMA[l]; ok(false); }; document.head.appendChild(s); });
            return CARGAS_IDIOMA[l];
        }
        ['en', 'pt', 'ko'].forEach(integrarIdioma);
        { const _ci = cambiarIdioma; cambiarIdioma = function (l, silencioso) { if (IDIOMAS_CARGADOS.has(l)) return _ci(l, silencioso); asegurarIdioma(l).then(ok => { if (ok) _ci(l, silencioso); }); }; }
        { const _cd = cambiarIdiomaDoc; cambiarIdiomaDoc = function (l) { if (!l || IDIOMAS_CARGADOS.has(l)) return _cd(l); asegurarIdioma(l).then(ok => { if (ok) _cd(l); }); }; }
        { const _rv = renderizarVectorial; renderizarVectorial = function () { const l = idiomaDocumento(); if (!IDIOMAS_CARGADOS.has(l)) asegurarIdioma(l).then(ok => { if (ok) renderizarVectorial(); }); return _rv.apply(this, arguments); }; }
        { const _gi = typeof generarInforme === 'function' ? generarInforme : null; if (_gi) generarInforme = async function () { await asegurarIdioma(idiomaDocumento()); return _gi.apply(this, arguments); }; }
        // ==================================================================================
        // TOOLTIP: al dejar el ratón quieto sobre un componente, toda su información
        // ==================================================================================
        let temporizadorTooltip = null;
        const tooltip = () => document.getElementById('tooltip-comp');
        function programarTooltip(id, e) {
            clearTimeout(temporizadorTooltip);
            const x = e.clientX, y = e.clientY;
            temporizadorTooltip = setTimeout(() => { if (!isDraggingSymbol) mostrarTooltip(id, x, y); }, 450);
        }
        function moverTooltip(e) {
            const t = tooltip();
            if (t.style.display === 'block') { colocarTooltip(e.clientX, e.clientY); }
            else if (!isDraggingSymbol) { clearTimeout(temporizadorTooltip); const x = e.clientX, y = e.clientY, id = e.currentTarget.getAttribute('data-id'); temporizadorTooltip = setTimeout(() => mostrarTooltip(id, x, y), 450); }
        }
        function ocultarTooltip() { clearTimeout(temporizadorTooltip); const t = tooltip(); if (t) t.style.display = 'none'; }
        function colocarTooltip(x, y) {
            const t = tooltip();
            const w = t.offsetWidth, h = t.offsetHeight;
            t.style.left = Math.min(x + 14, window.innerWidth - w - 8) + 'px';
            t.style.top = Math.min(y + 14, window.innerHeight - h - 8) + 'px';
        }
        function infoElementoHTML(el) {
            const t = TIPOS[el.subtype];
            const filas = [];
            const f = (k, v) => filas.push(`<tr><td class="text-slate-400 pr-2 align-top">${k}</td><td>${v}</td></tr>`);
            const lin = lineaPorId(el.linea);
            f('Tipo', el.type === 'tuberia' ? 'Tubería' : el.type === 'bomba' ? 'Bomba ' + nombreTipoBomba(el).toLowerCase() : (t ? t.nombre : el.subtype));
            if (el.name && !/^(Tubería|Bomba centrífuga)$/.test(el.name) && (!t || el.name !== t.nombre)) f('Descripción', esc(el.name));
            if (el.libItem) { const it = itemPorId(el.libItem); if (it) f('Modelo', esc(it.nombre) + (it.fabricante ? ' · ' + esc(it.fabricante) : '')); }
            if (el.accModelo && modeloAcc(el)) { const m = modeloAcc(el), e = espesorAcc(el, m); f('Modelo', esc(m.nombre) + ' · ' + esc(m.norma)); f('Código', '<b>' + esc(codigoAccesorio(el)) + '</b>'); if (el.accSch) f('Schedule', esc(el.accSch) + (e != null && !/mm$/.test(el.accSch) ? ' · ' + e + ' mm' : '')); }
            if (el.materialComp || el.gradoMaterial) f('Material', esc(el.materialComp || el.gradoMaterial));
            if (el.url) f('URL', esc(el.url));
            f('Línea', el.linea ? `${el.linea}${lin && lin.nombre ? ' · ' + esc(lin.nombre) : ''}${lin && lin.tipo === 'ramal' ? ' (ramal de ' + lin.padre + ')' : ''}` : '<span class="text-amber-300">sin asignar</span>');
            if (el.type === 'tuberia') {
                const dt = datosTuberia(el);
                f('Material', `${esc(el.material)} · ${dt.norma}`);
                f('Tamaño', `${esc(etiquetaTuberia(el))}${esAceroTubo(el.material) ? ' (' + el.dn + ')' : ''}${el.pn ? ' · ' + esc(el.pn) : ''}`);
                f('Geometría', `OD ${fmt(dt.od, 1)} · e ${fmt(dt.e, 2)} · Dint ${fmt(dt.Dint, 1)} mm · L ${el.longitud} mm`);
                f('Rugosidad', `${dt.rug} mm`);
                f('Cotas', `a ${fmt(el.cotaA, 2)} m · b ${fmt(el.cotaB, 2)} m`);
                if (+el.aislamiento > 0) f('Aislamiento', `${el.aislamiento} mm · λ ${el.lambdaAisl || 0.040} W/m·K`);
                { const rt = ultimoResultado && ultimoResultado[el.id] && ultimoResultado[el.id].termica; if (rt) f('Térmica / soportes', `q ${fmt(rt.q, 1)} W/m · ΔL ${fmt(rt.dL, 1)} mm · soportes cada ${fmt(rt.sep, 2)} m (${rt.nSop})`); }
            } else if (el.type === 'bomba') {
                f('Diseño', `${fQ(el.caudal, 2)} ${lQ()} a ${fP(el.presion, 2)} ${lP()} · cierre ${fP(el.h0, 2)} ${lP()}`);
                f('NPSHr / cota', `${el.npsh} m · ${el.cota || 0} m`);
                const res_ = el.reservaDe && elementosRed.find(e => e.id === el.reservaDe), sus = elementosRed.find(e => e.reservaDe === el.id);
                if (res_ || sus) f('Función', res_ ? `Reserva de ${esc(tagDe(res_))}${bombaEnMarcha(el) ? ' · <b>en marcha</b>' : ' · parada'}` : `Servicio, con reserva ${esc(tagDe(sus))}${bombaEnMarcha(el) ? '' : ' · <b>parada</b>'}`);
            } else if (el.type === 'equipo') {
                f('Δp fabricante', `${fP(el.dpNom / 100, 3)} ${lP()} a ${fQ(el.qNom, 2)} ${lQ()} · cota ${fmt(el.cota, 2)} m`);
            } else if (el.subtype === 'consumo') {
                f('Consumo', `${fQ(el.qCons, 2)} ${lQ()} · p mín ${fP(el.pMin, 2)} ${lP()} · cota ${fmt(el.cota, 2)} m`);
            } else if (esDeposito(el)) {
                f('Tanque', `fondo ${fmt(el.cotaFondo, 2)} m · conexión b a ${fmt(el.hB, 2)} m del fondo (${esc(el.tipoConexion || '')}${el.dnConexion ? ' ' + etiquetaDN(el.dnConexion) : ''}) · c a ${fmt(el.hC, 2)} m`);
                f('Nivel', `lámina a ${fmt(el.hLamina, 2)} m del fondo (cota ${fmt(el.cotaLamina, 2)} m) · ${fP(el.presionDep, 2)} ${lP()} man.`);
            } else if (el.type !== 'instrumento') {
                f('DN', el.subtype === 'reduccion' ? `${etiquetaDN(el.dn)} × ${etiquetaDN(el.dnMenor)} · ${el.excentrica ? 'excéntrica' : 'concéntrica'}` : etiquetaDN(el.dn));
                if (sinFlujo(el)) f('Cálculo', 'Sin caudal en servicio normal (excluido)');
                else if (esNodo(el)) { const k = kTee(el); f('K', `paso directo ${fmt(k.run)} · derivación ${fmt(k.der)} (${esc(k.origen)})`); }
                else if (el.subtype === 'reduccion') { const r = kReduccion(el, dintReferencia(el.dn), dintReferencia(el.dnMenor)); f('K', `contracción ${fmt(r.kc)} · expansión ${fmt(r.ke)} · θ ${fmt(r.theta, 1)}°`); }
                else { const k = kElemento(el, dintReferencia(el.dn)); f('K', `${fmt(k.K)} (${esc(k.origen)})`); }
            } else f('Cálculo', `Instrumento sin caudal (excluido)${el.rango ? ' · rango ' + esc(el.rango) : ''}${el.dnInstr ? ' · conexión ' + etiquetaDN(el.dnInstr) : ''}`);
            const r = ultimoResultado && ultimoResultado[el.id];
            if (r) {
                if (el.type === 'bomba') { f('Resultado', `Q ${fQ(r.Q, 2)} ${lQ()} · H ${fmt(r.H, 2)} m · ${fmt(r.potencia, 2)} kW`); const okN = r.npshd != null && r.npshd - el.npsh >= opciones.margenNPSH; f('NPSH', `<b class="${okN ? 'text-emerald-300' : 'text-rose-300'}">NPSHd ${fmt(r.npshd, 2)} m · NPSHr ${fmt(el.npsh, 2)} m · margen ${fmt(r.npshd - el.npsh, 2)} m ${okN ? '✔' : '✘ cavitación'}</b>`); }
                else if (r.ramas && r.ramas.length) r.ramas.forEach(x => f(`Rama ${x.rama}`, `Q ${fQ(x.Q, 2)} ${lQ()} · V ${fmt(x.V, 2)} m/s · K ${fmt(x.K)} · hf ${fmt(x.hf, 3)} m`));
                else if (esTerminal(el)) f('Resultado', el.subtype === 'consumo' ? `Q ${fQ(r.Q, 2)} ${lQ()} · p ${fP(r.p, 2)} ${lP()} (mín ${fP(r.pMin, 2)})${r.equilibrado ? ` · equilibrado Δp ${fP(r.equilibrado.dp, 2)} ${lP()}, Kv ${fmt(r.equilibrado.Kv, 2)}` : ''}` : `Q ${fQ(r.Q, 2)} ${lQ()} (${esc(r.sentido)}) · p ${fP(r.p, 2)} ${lP()}`);
                else f('Resultado', `Q ${fQ(r.Q, 2)} ${lQ()} · V ${fmt(r.V, 2)} m/s${r.Re ? ' · Re ' + Math.round(r.Re) : ''}${r.f ? ' · f ' + fmt(r.f, 4) : ''} · hf ${fmt(r.hf, 3)} m${r.sentido ? ' · ' + r.sentido : ''}${r.dp != null ? ' · Δp ' + fmt(r.dp, 1) + ' kPa' : ''}`);
                if (r.pA != null && !esTerminal(el)) f('Presión', `${fP(r.pA, 2)} → ${fP(r.pB, 2)} ${lP()} man.${r.pma != null ? ` · PMA ${fP(r.pma, 1)} ${lP()}` : ''}${r.ariete ? ` · ariete Δp ${fP(r.ariete.dp / 1e5, 2)} ${lP()}` : ''}`);
                f('Estado', el.estado === 'fallo' ? `<span class="text-rose-300 font-bold">No cumple</span>: ${esc(r.motivos.join('; '))}${(r.alternativas || []).map(x => `<br><span class="text-amber-300">→ ${esc(x)}</span>`).join('')}` : `<span class="text-emerald-300 font-bold">Cumple</span>${el.esLineaCritica ? ' · <span class="text-violet-300">ruta crítica</span>' : ''}`);
            }
            { const x = ultimoCalculo && (ultimoCalculo.resultado.pedRecipientes || []).find(q => q.id === el.id); if (x) f('PED recipiente', `${esc(x.cat)} · ${esc(x.cuadro)} · PS ${fP(x.PS, 2)} ${lP()} · V ${fmt(x.V, 0)} l`); }
            return `<div class="font-bold text-white mb-1">${esc(tagDe(el))}</div><table>${filas.join('')}</table>`;
        }
        function mostrarTooltip(id, x, y) {
            const el = elementosRed.find(e => e.id === id);
            if (!el) return;
            const t = tooltip();
            t.innerHTML = infoElementoHTML(el);
            t.style.display = 'block';
            colocarTooltip(x, y);
        }

        // ==================================================================================
        // ÁRBOL DE ESTRUCTURA: línea principal (raíz) -> componentes en orden de flujo -> ramales que
        // salen de cada te/cruce/injerto -> subramales. Nodos plegables; clic = seleccionar y centrar.
        // ==================================================================================
        const arbolPlegados = new Set(['FORMATO', 'ANOT']); // ramas Formato y Anotaciones plegadas por defecto
        let temporizadorArbol = null;
        function programarArbol() { clearTimeout(temporizadorArbol); temporizadorArbol = setTimeout(renderArbol, 60); }
        function plegarArbol() { alternarNodoArbol('RAIZ'); }

        function alternarNodoArbol(clave) { if (arbolPlegados.has(clave)) arbolPlegados.delete(clave); else arbolPlegados.add(clave); renderArbol(); }
        function irAElemento(id) {
            const el = elementosRed.find(e => e.id === id);
            if (!el) return;
            seleccionarElemento(id);
            centrarVistaEnPunto(el.x + 25, mundoAScreenY(el.y) + 25);
        }
        function ordenarLinea(idLinea, vecinos) {
            const miembros = elementosRed.filter(e => e.linea === idLinea);
            if (!miembros.length) return [];
            const enLinea = new Set(miembros.map(e => e.id));
            let inicio = miembros.find(e => e.inicioLinea) || miembros.slice().sort((a, b) => (vecinos[a.id] || []).filter(v => enLinea.has(v)).length - (vecinos[b.id] || []).filter(v => enLinea.has(v)).length)[0];
            const orden = [], vistos = new Set();
            const pila = [inicio.id];
            while (pila.length) {
                const id = pila.pop();
                if (vistos.has(id)) continue;
                vistos.add(id); orden.push(id);
                (vecinos[id] || []).filter(v => enLinea.has(v) && !vistos.has(v)).reverse().forEach(v => pila.push(v));
            }
            miembros.forEach(e => { if (!vistos.has(e.id)) orden.push(e.id); }); // elementos no conectados al resto de su línea
            return orden;
        }
        // Vecindad entre elementos (puertos coincidentes): { id: [ids vecinos] }
        function mapaVecinos() {
            const vecinos = {};
            construirGrafoRed().nodos.forEach(n => {
                const ids = [...new Set(n.puertos.map(p => p.elId))];
                ids.forEach(a => ids.forEach(b => { if (a !== b) (vecinos[a] = vecinos[a] || []).includes(b) || vecinos[a].push(b); }));
            });
            return vecinos;
        }
        // Líneas en el orden del árbol (principal y, en profundidad, los ramales según su punto de salida)
        function lineasEnOrden() {
            const vecinos = mapaVecinos(), res = [], vistas = new Set();
            const ramalesDesde = {};
            lineas.filter(l => l.tipo === 'ramal').forEach(l => { const k = l.desde && elementosRed.some(e => e.id === l.desde) ? l.desde : '__' + l.padre; (ramalesDesde[k] = ramalesDesde[k] || []).push(l); });
            const visitar = (l, nivel) => {
                if (vistas.has(l.id)) return; vistas.add(l.id);
                const orden = ordenarLinea(l.id, vecinos);
                res.push({ linea: l, nivel, orden });
                orden.forEach(id => (ramalesDesde[id] || []).forEach(r => visitar(r, nivel + 1)));
                (ramalesDesde['__' + l.id] || []).forEach(r => visitar(r, nivel + 1));
            };
            lineas.filter(l => l.tipo === 'principal').forEach(l => visitar(l, 0));
            lineas.forEach(l => visitar(l, 0)); // huérfanas
            return res.filter(x => x.orden.length);
        }
        function iconoArbol(el) {
            const m = { anotacion: 'fa-note-sticky', tuberia: 'fa-grip-lines', bomba: 'fa-fan', valvula: 'fa-circle-half-stroke', accesorio: 'fa-shapes', instrumento: 'fa-gauge', equipo: 'fa-industry', terminal: esDeposito(el) || (TIPOS[el.subtype] || {}).calc === 'deposito' ? 'fa-database' : 'fa-faucet' };
            return m[el.type] || 'fa-cube';
        }
        function renderArbol() {
            const cuerpo = document.getElementById('arbol-cuerpo');
            const caja = document.getElementById('arbol');
            if (!cuerpo) return;
            caja.style.display = opciones.arbol ? 'flex' : 'none';
            caja.style.width = anchoArbol + 'px';
            if (!opciones.arbol) return;
            const vecinos = mapaVecinos();
            const P = paleta(), F = FONDOS[opciones.fondo] || FONDOS.papel;
            caja.style.setProperty('--arbol-linea', F.oscuro ? '#94a3b8' : '#64748b');
            caja.style.setProperty('--arbol-fondo', F.hoja);
            caja.style.setProperty('--arbol-texto', P.texto);
            caja.style.color = P.texto;
            const ramalesDesde = {};
            lineas.filter(l => l.tipo === 'ramal').forEach(l => { const k = l.desde && elementosRed.some(e => e.id === l.desde) ? l.desde : '__' + l.padre; (ramalesDesde[k] = ramalesDesde[k] || []).push(l); });
            // Color del texto: ruta crítica en morado, fallos en rojo, cumple en verde, sin calcular en el color del fondo
            const colorTxt = el => el.estado === 'fallo' ? P.fallo : el.esLineaCritica ? P.critica : el.estado === 'ok' ? P.ok : P.texto;
            const peso = el => el.estado === 'fallo' || el.esLineaCritica ? 'font-weight:600' : '';
            const mas = (clave, plegado) => `<span class="mas" onclick="event.stopPropagation(); alternarNodoArbol('${clave}')">${plegado ? '+' : '−'}</span>`;
            const filaEl = el => `<div class="fila"><span class="nodo ${el.id === idSeleccionado || seleccion.has(el.id) ? 'sel' : ''}" onclick="irAElemento('${el.id}')" onmouseenter="resaltarElemento('${el.id}')" onmouseleave="resaltarElemento(null)" title="${esc(nombreTipo(el))}"><i class="fa-solid ${iconoArbol(el)}" style="color:${colorElemento(el, P)};font-size:10px;width:12px;text-align:center"></i><span class="txt" style="color:${colorTxt(el)};${peso(el)}">${esc(tagDe(el))}</span></span></div>`;
            const pintarLinea = l => {
                const clave = 'L:' + l.id, plegado = arbolPlegados.has(clave);
                const orden = ordenarLinea(l.id, vecinos);
                const critica = orden.some(id => (elementosRed.find(e => e.id === id) || {}).esLineaCritica);
                const falla = orden.some(id => (elementosRed.find(e => e.id === id) || {}).estado === 'fallo');
                let h = `<div class="fila">${mas(clave, plegado)}<span class="nodo" onclick="seleccionarLinea('${l.id}')" onmouseenter="resaltarLinea('${l.id}')" onmouseleave="resaltarLinea(null)" title="Seleccionar la línea"><i class="fa-solid ${l.tipo === 'principal' ? 'fa-diagram-project' : 'fa-code-branch'}" style="color:${falla ? P.fallo : critica ? P.critica : P.base};font-size:10px"></i><span class="txt" style="${critica || falla ? 'color:' + (falla ? P.fallo : P.critica) + ';' : ''}font-weight:700">${l.id}</span><span class="txt" style="opacity:.8">${l.nombre ? esc(l.nombre) : ''} (${orden.length})</span></span>`;
                if (!plegado) {
                    h += '<div class="hijos">';
                    orden.forEach(id => {
                        const el = elementosRed.find(e => e.id === id);
                        h += filaEl(el);
                        (ramalesDesde[id] || []).forEach(r => { h += pintarLinea(r); });
                    });
                    (ramalesDesde['__' + l.id] || []).forEach(r => { h += pintarLinea(r); });
                    h += '</div>';
                }
                return h + '</div>';
            };
            const raizPlegada = arbolPlegados.has('RAIZ');
            // Formato de la hoja (siempre visible): se cambia desde aquí
            const fAct = opciones.formato || 'A3', fPleg = arbolPlegados.has('FORMATO');
            const filaFmt = `<div class="fila">${mas('FORMATO', fPleg)}<span class="nodo" onclick="alternarNodoArbol('FORMATO')" title="Formato de la hoja"><i class="fa-solid fa-file" style="color:${P.base};font-size:10px"></i><span class="txt" style="font-weight:700">Formato</span><span class="txt" style="opacity:.8">${fAct} (${FORMATOS[fAct].w} × ${FORMATOS[fAct].h})</span></span>` +
                (fPleg ? '' : `<div class="hijos">${Object.entries(FORMATOS).map(([k, f]) => `<div class="fila"><span class="nodo ${k === fAct ? 'sel' : ''}" onclick="cambiarFormato('${k}')" title="Cambiar a ${k}"><i class="fa-regular ${k === fAct ? 'fa-circle-dot' : 'fa-circle'}" style="font-size:9px"></i><span class="txt">${k} · ${f.w} × ${f.h} mm</span></span></div>`).join('')}
                    <div class="fila"><span class="nodo" onclick="alternarRejilla('rejillaVisible')" title="Mostrar u ocultar la rejilla"><i class="fa-solid fa-border-all" style="font-size:9px;color:${P.base}"></i><span class="txt">Rejilla: ${opciones.rejillaVisible !== false ? 'visible' : 'oculta'} · ${opciones.rejillaMayor || 10} mm / ${opciones.rejillaMenores || 2}</span></span></div>
                    <div class="fila"><span class="nodo" onclick="alternarRejilla('cajetin')" title="Mostrar u ocultar el cajetín"><i class="fa-solid fa-table-cells" style="font-size:9px;color:${P.base}"></i><span class="txt">Cajetín: ${opciones.cajetin !== false ? 'visible' : 'oculto'}</span></span></div>
                    <div class="fila"><span class="nodo" onclick="alternarRejilla('rejilla')" title="Ajuste a rejilla"><i class="fa-solid fa-magnet" style="font-size:9px;color:${P.base}"></i><span class="txt">Ajuste a rejilla: ${opciones.rejilla ? 'sí' : 'no'}</span></span></div></div>`) + '</div>';
            const comps = elementosRed.filter(e => !esAnotacion(e));
            if (!elementosRed.length) { cuerpo.innerHTML = `<div class="fila" style="padding-left:16px"><div class="hijos" style="border-left:none;margin-left:0">${filaFmt}</div></div>`; return; }
            let h = `<div class="fila" style="padding-left:16px">${mas('RAIZ', raizPlegada)}<span class="nodo" onclick="alternarNodoArbol('RAIZ')"><i class="fa-solid fa-sitemap" style="color:${P.base};font-size:10px"></i><span class="txt" style="font-weight:700">Red${proyecto.numero ? ' · ' + esc(proyecto.numero) : ''}${hojas.length > 1 ? ' · hoja ' + esc(codigoHoja()) : ''}</span></span>`;
            if (!raizPlegada) {
                h += '<div class="hijos">' + (comps.length ? lineas.filter(l => l.tipo === 'principal').map(pintarLinea).join('') : '');
                const sueltos = elementosRed.filter(e => (!e.linea || !lineaPorId(e.linea)) && !esAnotacion(e));
                const anot = elementosRed.filter(esAnotacion);
                if (sueltos.length) h += `<div class="fila"><span class="nodo"><i class="fa-solid fa-triangle-exclamation" style="color:#d97706;font-size:10px"></i><span class="txt" style="color:#d97706">Sin línea asignada</span></span><div class="hijos">${sueltos.map(filaEl).join('')}</div></div>`;
                if (anot.length) { const aP = arbolPlegados.has('ANOT'); h += `<div class="fila">${mas('ANOT', aP)}<span class="nodo" onclick="alternarNodoArbol('ANOT')"><i class="fa-solid fa-note-sticky" style="color:${P.base};font-size:10px"></i><span class="txt">Anotaciones</span><span class="txt" style="opacity:.7">(${anot.length})</span></span>${aP ? '' : `<div class="hijos">${anot.map(filaEl).join('')}</div>`}</div>`; }
                h += filaFmt;
                h += '</div>';
            }
            cuerpo.innerHTML = h + '</div>';
        }
        // Ancho del árbol: arrastrando su borde derecho
        (function () {
            const asa = document.getElementById('arbol-asa');
            if (!asa) return;
            let x0 = null, w0 = 0;
            asa.addEventListener('mousedown', e => { x0 = e.clientX; w0 = anchoArbol; e.preventDefault(); e.stopPropagation(); });
            window.addEventListener('mousemove', e => { if (x0 == null) return; anchoArbol = Math.max(150, Math.min(600, w0 + e.clientX - x0)); document.getElementById('arbol').style.width = anchoArbol + 'px'; });
            window.addEventListener('mouseup', () => { if (x0 != null) aplicarZoom(); x0 = null; });
        })();

        // ==================================================================================
        // OPCIONES: fondo, norma de símbolos, criterios de cálculo
        // ==================================================================================
        function cambiarFondo(f) { opciones.fondo = f; aplicarFondo(); renderizarVectorial(); marcarCambios(true); }
        function cambiarNorma(n) {
            opciones.norma = n;
            if (n === 'CLIENTE') alert('Símbolos de la empresa cliente: mientras no se carguen sus plantillas se usan los de ISO 10628-2.');
            construirLibreria(); renderizarVectorial(); marcarCambios(true);
        }
        function cambiarUnidad(clave, valor) {
            opciones[clave] = valor; marcarCambios(true);
            if (idSeleccionado) seleccionarElemento(idSeleccionado);
            if (ultimoCalculo && document.getElementById('modal-red').style.display === 'flex') mostrarResultados(ultimoCalculo.resultado);
        }
        function alternarRejilla(clave) { opciones[clave] = (clave === 'rejillaVisible' || clave === 'cajetin') ? opciones[clave] === false : !opciones[clave]; marcarCambios(true); renderizarVectorial(); renderArbol(); }
        function configurarRejilla() {
            const may = prompt('Separación de las líneas mayores de la rejilla (mm de papel):', opciones.rejillaMayor || 10);
            if (may == null) return;
            const n = prompt('Número de divisiones menores entre líneas mayores:', opciones.rejillaMenores || 2);
            if (n == null) return;
            if (!(+may > 0) || !(+n >= 1)) { aviso('Valores de rejilla no válidos.', 'error'); return; }
            opciones.rejillaMayor = +may; opciones.rejillaMenores = Math.round(+n); opciones.rejillaVisible = true;
            marcarCambios(true); renderizarVectorial(); renderArbol();
            aviso(`Rejilla: líneas mayores cada ${opciones.rejillaMayor} mm, menores cada ${fmt(opciones.rejillaMayor / opciones.rejillaMenores, 2)} mm.`);
        }
        function alternarArbol() { opciones.arbol = !opciones.arbol; renderArbol(); aplicarZoom(); }
        // Velocidades y caudal de diseño viven en los datos del proyecto; aquí solo el margen NPSH
        function abrirCriterios() {
            const m = prompt('Margen mínimo NPSHd − NPSHr de las bombas (m).\n(Las velocidades máximas y el caudal de diseño se editan en Archivo > Datos del proyecto.)', opciones.margenNPSH);
            if (m === null) return;
            const v2 = parseFloat(m);
            if (!(v2 >= 0)) { alert('Valor no válido.'); return; }
            opciones.margenNPSH = v2; marcarCambios(true); invalidarResultados(); renderizarVectorial();
        }

        // ==================================================================================
        // DATOS DEL PROYECTO (se piden al crear un proyecto nuevo y antes de generar el informe)
        // ==================================================================================
        // ==================================================================================
        // CLASIFICACIÓN PED (Directiva 2014/68/UE, art. 4.1.c y anexo II, cuadros 6 a 9) Y PRUEBA DE PRESIÓN
        // Por línea: PS = mayor presión de diseño de sus tuberías (máx. entre servicio y caudal nulo),
        // DN = mayor DN (plásticos: DN equivalente), TS = temperatura máxima admisible del proyecto.
        // Estado: gas si pv(TS) > 0,5 bar por encima de la atmosférica; si no, líquido.
        // Grupo (art. 13): automático por fluido (inflamables de cat. 3 pasan a grupo 1 si TS > punto de
        // inflamación) o fijado en los datos del proyecto.
        // ==================================================================================
        const GRUPO_PED = { 'Gasolina 95 (verano, RVP 60 kPa)': { g: 1 }, 'Gasolina 95 (invierno, RVP 90 kPa)': { g: 1 },
            'Gasóleo (EN 590)': { fp: 55 }, 'Queroseno (Jet A-1)': { fp: 38 }, 'Fuelóleo HFO RMG 380': { fp: 60 }, 'Aceite hidráulico ISO VG 46': { fp: 200 } };
        function grupoFluidoPED(nombre, TS) {
            if (proyecto.grupoPED === '1' || proyecto.grupoPED === '2') return { g: +proyecto.grupoPED, motivo: 'fijado en los datos del proyecto' };
            const d = GRUPO_PED[nombre] || (CAT.fluidos[nombre] || {}).ped || {};
            if (d.g === 1) return { g: 1, motivo: 'líquido extremadamente inflamable' };
            if (d.fp != null) return TS > d.fp ? { g: 1, motivo: `inflamable cat. 3 con TS ${TS} °C > punto de inflamación ${d.fp} °C` } : { g: 2, motivo: `TS ${TS} °C ≤ punto de inflamación ${d.fp} °C` };
            return { g: 2, motivo: 'fluido no peligroso según art. 13' };
        }
        // Cuadros 6 a 9 del anexo II (tuberías): devuelve 'Fuera' | 'Art. 4.3' | 'I' | 'II' | 'III'
        function categoriaPED(gas, grupo, PS, DN, TS = 0) {
            const x = PS * DN;
            if (!(PS > 0.5)) return { cat: 'Fuera', cuadro: '—' };
            if (gas && grupo === 1) { // cuadro 6
                const cat = DN <= 25 ? 'Art. 4.3' : DN > 350 ? 'III' : DN <= 100 ? (x <= 1000 ? 'I' : 'II') : (x <= 3500 ? 'II' : 'III');
                return { cat, cuadro: 'Cuadro 6 (gases grupo 1)' };
            }
            if (gas) { // cuadro 7
                const cat = (DN <= 32 || x <= 1000) ? 'Art. 4.3' : DN <= 100 ? 'I' : x <= 3500 ? 'I' : DN <= 250 ? 'II' : x <= 5000 ? 'II' : 'III';
                return { cat, cuadro: 'Cuadro 7 (gases grupo 2)' };
            }
            if (grupo === 1) { // cuadro 8
                const cat = (DN <= 25 || x <= 2000) ? 'Art. 4.3' : PS <= 10 ? 'I' : PS <= 500 ? 'II' : 'III';
                return { cat, cuadro: 'Cuadro 8 (líquidos grupo 1)' };
            }
            let cat = (PS <= 10 || DN <= 200 || x <= 5000) ? 'Art. 4.3' : PS <= 500 ? 'I' : 'II'; // cuadro 9
            if (cat === 'II' && TS > 350) cat = 'III'; // excepción del cuadro 9: TS > 350 °C
            return { cat, cuadro: 'Cuadro 9 (líquidos grupo 2)' };
        }
        // ---------- Recipientes (cuadros 1 a 4 del anexo II) ----------
        // Funciones tomadas de la app «Recipientes a presión» de José (jamanteiga.github.io/RecipientesPresion),
        // verificadas punto a punto contra los diagramas del anexo II. 'SEP' = art. 4.3.
        const URL_RECIPIENTES = 'https://jamanteiga.github.io/RecipientesPresion/';
        function cuadroRecipiente(gas, grupo, PS, V) {
            if (!(PS > 0.5)) return { cat: 'Fuera', cuadro: '—', n: null };
            let c, n;
            if (gas && grupo === 1) { n = 1; if (V <= 1) c = PS <= 200 ? 'SEP' : PS <= 1000 ? 'III' : 'IV'; else { const k = PS * V; c = k <= 25 ? 'SEP' : k <= 50 ? 'I' : k <= 200 ? 'II' : k <= 1000 ? 'III' : 'IV'; } }
            else if (gas) { n = 2; if (V <= 1) c = PS <= 1000 ? 'SEP' : PS <= 3000 ? 'III' : 'IV'; else { const k = PS * V; c = k <= 50 ? 'SEP' : k <= 200 ? 'I' : k <= 1000 ? 'II' : PS <= (V <= 750 ? 3000 / V : 4) ? 'III' : 'IV'; } }
            else if (grupo === 1) { n = 3; if (V <= 1) c = PS <= 500 ? 'SEP' : 'II'; else { const k = PS * V; c = k <= 200 ? 'SEP' : PS <= 10 ? 'I' : PS <= 500 ? 'II' : 'III'; } }
            else { n = 4; const lim = V <= 10 ? 1000 : V <= 1000 ? 10000 / V : 10; c = PS <= lim ? 'SEP' : V <= 10 ? 'I' : PS <= 500 ? 'I' : 'II'; }
            return { cat: c === 'SEP' ? 'Art. 4.3' : c, cuadro: `Cuadro ${n} (recipientes, ${gas ? 'gas' : 'líquido'} grupo ${grupo})`, n };
        }
        // Fluidos de PIPING con equivalente en la app de recipientes (id de su lista)
        const FLUIDO_RECIPIENTES = { 'Agua': 'agua', 'Gasóleo (EN 590)': 'gasoleo', 'Queroseno (Jet A-1)': 'jeta1', 'Fuelóleo HFO RMG 380': 'hfo', 'Gasolina 95 (verano, RVP 60 kPa)': 'gasolina', 'Gasolina 95 (invierno, RVP 90 kPa)': 'gasolina' };
        function enlaceRecipientes(nombreFluido, grupo, gas, PS, V, tag) {
            const q = new URLSearchParams({ ps: (+PS).toFixed(2), v: String(+(+V).toFixed(1)), grupo: String(grupo), estado: gas ? 'gas' : 'liquido', nombre: nombreFluido, origen: 'PIPING' + (tag ? ' · ' + tag : '') });
            const id = FLUIDO_RECIPIENTES[nombreFluido]; if (id) q.set('fluido', id);
            return URL_RECIPIENTES + '?' + q.toString();
        }
        // Recipientes de la red (tanques, hidróforo y equipos con volumen): PS = la indicada o la mayor entre
        // la presión sobre la lámina y la calculada en sus conexiones
        function recipientesPED(resultado, gas, grupo, TS) {
            return elementosRed.filter(e => (esDeposito(e) || esEquipo(e)) && +e.volumen > 0).map(e => {
                const ars = resultado.aristas.filter(a => a.el.id === e.id), r = ultimoResultado && ultimoResultado[e.id];
                const pCalc = Math.max(0, ...ars.map(a => Math.max(a.pA || 0, a.pB || 0, a.pmax || 0)), r && r.p || 0);
                const PS = +e.psRecipiente > 0 ? +e.psRecipiente : Math.max(+e.presionDep || 0, pCalc);
                const c = cuadroRecipiente(gas, grupo, PS, +e.volumen);
                return { id: e.id, tag: tagDe(e), nombre: nombreTipo(e), V: +e.volumen, PS, origenPS: +e.psRecipiente > 0 ? 'indicada' : 'calculada', cat: c.cat, cuadro: c.cuadro, PSV: PS * e.volumen, TS, url: enlaceRecipientes(resultado.fluido.nombre, grupo, gas, PS, e.volumen, tagDe(e)) };
            });
        }
        // Clases de tuberías de buques (BV Pt C Ch1 Sec10, LR Pt5 Ch12, DNV Pt4 Ch6: criterio común IACS)
        // p en bar (presión de diseño) y T en °C (temperatura de diseño)
        function medioNaval(nombre, TS) {
            if (/NaOH|sulfúrico/i.test(nombre)) return 'toxico';
            if (/Gasolina/.test(nombre)) return 'toxico';
            const fp = (GRUPO_PED[nombre] || {}).fp;
            if (fp != null && fp < 60) return 'toxico';                  // punto de inflamación < 60 °C
            if (fp != null && TS > fp) return 'toxico';                    // calentado por encima del punto de inflamación
            if (/Fuelóleo|Gasóleo|Queroseno|Aceite/.test(nombre)) return 'combustible';
            return 'otros';
        }
        const MEDIOS_NAVALES = { toxico: 'Tóxicos, corrosivos o inflamables (p. inflamación < 60 °C o calentados por encima)', combustible: 'Combustible, aceite lubricante y aceite hidráulico inflamable', otros: 'Otros medios (agua, agua de mar, aire, gases e hidráulico no inflamable)' };
        function claseNaval(medio, p, T) {
            if (medio === 'toxico') return proyecto.salvaguardas ? 'II' : 'I';
            if (medio === 'combustible') return (p > 16 || T > 150) ? 'I' : (p <= 7 && T <= 60) ? 'III' : 'II';
            return (p > 40 || T > 300) ? 'I' : (p <= 16 && T <= 200) ? 'III' : 'II';
        }
        const CRITERIOS_PRUEBA = {
            PED: { nombre: 'PED anexo I 7.4: máx(1,25·PS·fa/fT; 1,43·PS)', f: (PS, rel) => Math.max(1.25 * PS * rel, 1.43 * PS), texto: 'Pt = máx(1,25·PS·fa/fT; 1,43·PS)' },
            B313: { nombre: 'ASME B31.3 §345.4: 1,5·P·ST/S', f: (PS, rel) => 1.5 * PS * rel, texto: 'Pt = 1,5·P·ST/S' },
            SOC: { nombre: 'Sociedad de clasificación (BV/DNV/LR): 1,5·p', f: PS => 1.5 * PS, texto: 'Pt = 1,5·p (reglas de la sociedad)' }
        };
        function clasificacionPED(resultado) {
            const fl = resultado.fluido, TS = +proyecto.tsMax > 0 ? +proyecto.tsMax : fl.T;
            const pf = propiedadesFluido(fl.nombre, TS), pvTS = pf.ok ? pf.pv : fl.pv;
            const gas = pvTS > PRESION_ATM + 0.5e5;
            const gr = grupoFluidoPED(fl.nombre, TS);
            const crit = CRITERIOS_PRUEBA[proyecto.criterioPrueba] || CRITERIOS_PRUEBA.PED;
            const out = [];
            lineas.forEach(l => {
                const ars = resultado.aristas.filter(a => a.el.linea === l.id && a.el.type === 'tuberia');
                if (!ars.length) return;
                const PS = Math.max(0, ...ars.map(a => Math.max(a.pmax || 0, a.pCierre || 0)));
                const DNs = ars.map(a => { const eq = dnEquivalente(a.el); return eq ? dnNum(eq) : Math.round(datosTuberia(a.el).Dint); });
                const DN = Math.max(...DNs);
                const c = categoriaPED(gas, gr.g, PS, DN, TS);
                // relación de tensiones admisibles a temperatura de prueba / de diseño (≤ 50 °C: 1 en acero)
                const rel = 1;
                const Pt = crit.f(PS, rel);
                // comprobaciones de la prueba: tuberías hasta 1,5·PMA; componentes hasta la prueba de cuerpo 1,5·PN
                const avisos = [];
                ars.forEach(a => { if (a.pma != null && Pt > 1.5 * a.pma) avisos.push(`${tagDe(a.el)}: Pt ${Pt.toFixed(1)} bar > 1,5·PMA (${(1.5 * a.pma).toFixed(1)} bar)`); });
                elementosRed.filter(e => e.linea === l.id && e.pn && (e.type === 'valvula' || e.type === 'accesorio' || e.type === 'equipo')).forEach(e => {
                    const adm = presionAdmisiblePN(e.pn, 20, false);
                    if (adm != null && Pt > 1.5 * adm) avisos.push(`${tagDe(e)}: Pt ${Pt.toFixed(1)} bar > prueba de cuerpo 1,5·${e.pn} (${(1.5 * adm).toFixed(1)} bar): aislarlo durante la prueba o subir PN`);
                });
                const naval = proyecto.esBuque || proyecto.tipoInstalacion === 'naval';
                const medio = naval ? medioNaval(fl.nombre, TS) : null;
                out.push({ linea: l.id, nombre: l.nombre || '', PS, DN, TS, gas, grupo: gr.g, motivoGrupo: gr.motivo, cat: c.cat, cuadro: c.cuadro, PSDN: PS * DN, Pt, criterio: crit.texto, avisos,
                    naval, medio, clase: naval ? claseNaval(medio, PS, TS) : null });
            });
            resultado.ped = out;
            resultado.pedRecipientes = recipientesPED(resultado, gas, gr.g, TS);
            resultado.pedFluido = { gas, grupo: gr.g, motivo: gr.motivo, TS };
            out.forEach(x => x.avisos.forEach(t => resultado.avisosRed.push(`Prueba de presión ${x.linea}: ${t}`)));
        }
        const PROYECTO_VACIO = () => ({
            numero: '', revision: '', fecha: '', autor: '',
            cliente: '', refCliente: '', descripcion: '', instalacion: '', direccion: '', ciudad: '', provincia: '', pais: '',
            nombrePlano: '', nombrePlano2: '', planoNumero: '', letraRevision: '', grupoPlano: '', codigoPlano: '', planoCert: '', revisadoPor: '', fechaRevisado: '', aprobadoPor: '', fechaAprobado: '', escala: '', hoja: '', hojas: '',
            esBuque: false,
            buque: { astillero: '', construccion: '', nombre: '', armador: '', tipo: '', imo: '', bandera: '', clasificacion: '', esloraTotal: '', esloraPP: '', manga: '', puntal: '', calado: '', peMuerto: '' },
            fluido: '', temperatura: '',
            tipoInstalacion: '', caudalDiseno: '', presionDiseno: '', vAsp: '', vImp: '', tCierre: '', tsMax: '', grupoPED: 'auto', criterioPrueba: 'PED', tAmbiente: '', tMontaje: '', exterior: false, horasAnuales: '', precioEnergia: '', etaMotor: ''
        });
        let proyecto = PROYECTO_VACIO();
        const TIPOS_INSTALACION = { edificacion: 'Edificación (RITE/CTE)', industrial: 'Industrial / proceso', naval: 'Naval / buque' };
        // Velocidades orientativas (m/s) según fluido y tipo de instalación: [aspiración, impulsión].
        // Práctica habitual de diseño; el usuario las confirma o cambia en los datos del proyecto.
        const V_RECOMENDADA = {
            'Agua':                        { edificacion: [1.0, 2.0], industrial: [1.5, 3.0], naval: [1.5, 3.0] },
            'Aceite hidráulico ISO VG 46': { edificacion: [1.0, 4.0], industrial: [1.0, 4.0], naval: [1.0, 4.0] },
            'Gasolina 95':                 { edificacion: [1.0, 2.0], industrial: [1.0, 2.0], naval: [1.0, 2.0] },
            'Gasóleo (EN 590)':            { edificacion: [1.0, 2.0], industrial: [1.0, 2.0], naval: [1.0, 2.0] },
            'Queroseno (Jet A-1)':         { edificacion: [1.0, 2.0], industrial: [1.0, 2.0], naval: [1.0, 2.0] },
            'Fuelóleo HFO RMG 380':        { edificacion: [0.6, 1.2], industrial: [0.6, 1.2], naval: [0.6, 1.2] },
            'Sosa cáustica 50 % NaOH':     { edificacion: [0.9, 1.5], industrial: [0.9, 1.5], naval: [0.9, 1.5] },
            'Ácido sulfúrico 98 %':        { edificacion: [0.9, 1.5], industrial: [0.9, 1.5], naval: [0.9, 1.5] }
        };
        function velocidadRecomendada(fluido, tipo) {
            const como = ((CAT.fluidos[fluido] || {}).como) || fluido;   // los fluidos nuevos indican a qué familia se asimilan
            const clave = Object.keys(V_RECOMENDADA).find(k => como && como.startsWith(k.split(' (')[0])) || 'Agua';
            return (V_RECOMENDADA[clave][tipo] || V_RECOMENDADA[clave].industrial);
        }
        // Límites efectivos para el cálculo (si no se han definido en el proyecto, los recomendados)
        function limitesVelocidad() {
            const rec = velocidadRecomendada(document.getElementById('selector-fluido').value, proyecto.tipoInstalacion);
            return { asp: +proyecto.vAsp > 0 ? +proyecto.vAsp : rec[0], imp: +proyecto.vImp > 0 ? +proyecto.vImp : rec[1] };
        }
        const CAMPOS_PROYECTO = [
            ['numero', 'Nº de proyecto *'], ['revision', 'Revisión (vacío = 0)'], ['fecha', 'Fecha (vacío = hoy)', 'date'], ['autor', 'Autor / calculista'],
            ['cliente', 'Cliente *'], ['refCliente', 'Referencia del cliente'], ['descripcion', 'Descripción del proyecto', 'textarea'],
            ['instalacion', 'Instalación *'], ['direccion', 'Dirección / emplazamiento'], ['ciudad', 'Ciudad'], ['provincia', 'Provincia'], ['pais', 'País']
        ];
        const CAMPOS_CAJETIN = [
            ['nombrePlano', 'Nombre del plano (vacío = instalación · descripción)'], ['nombrePlano2', 'Nombre, 2ª línea (vacío = cliente)'], ['planoNumero', 'Plano nº'], ['letraRevision', 'Letra de revisión'],
            ['escala', 'Escala (vacío = N/A)'], ['grupoPlano', 'Grupo nº'],
            ['codigoPlano', 'Nº de código'], ['planoCert', 'Plano Cert. nº'], ['revisadoPor', 'Revisado por'], ['fechaRevisado', 'Fecha de revisión', 'date'],
            ['aprobadoPor', 'Aprobado por'], ['fechaAprobado', 'Fecha de aprobación', 'date']
        ];
        const CAMPOS_BUQUE = [
            ['astillero', 'Astillero *'], ['construccion', 'Nº de construcción *'], ['nombre', 'Nombre del buque *'], ['armador', 'Armador *'],
            ['tipo', 'Tipo de buque *'], ['imo', 'Nº IMO'], ['bandera', 'Bandera'], ['clasificacion', 'Sociedad de clasificación'],
            ['esloraTotal', 'Eslora total (m)', 'number'], ['esloraPP', 'Eslora entre perpendiculares (m)', 'number'], ['manga', 'Manga de trazado (m)', 'number'],
            ['puntal', 'Puntal de trazado (m)', 'number'], ['calado', 'Calado de trazado (m)', 'number'], ['peMuerto', 'Peso muerto (t)', 'number']
        ];
        function campoHTML(id, etiqueta, tipo, valor, grupo) {
            const idc = `dp-${grupo}-${id}`;
            if (tipo === 'textarea') return `<div class="col-span-2"><label class="block text-slate-500 mb-0.5">${etiqueta}</label><textarea id="${idc}" rows="2" class="w-full border rounded p-1.5">${esc(valor)}</textarea></div>`;
            return `<div><label class="block text-slate-500 mb-0.5">${etiqueta}</label><input id="${idc}" type="${tipo || 'text'}" ${tipo === 'number' ? 'step="any"' : ''} value="${esc(valor)}" class="w-full border rounded p-1.5"></div>`;
        }
        let alGuardarProyecto = null, modoProyecto = {};
        // Siempre se trabaja dentro de un proyecto: estos datos son imprescindibles para dibujar
        function faltanObligatorios(p = proyecto) {
            const f = [];
            if (!p.numero) f.push('Nº de proyecto'); if (!p.cliente) f.push('Cliente'); if (!p.instalacion) f.push('Instalación');
            if (!TIPOS_INSTALACION[p.tipoInstalacion]) f.push('Tipo de instalación');
            if (!p.fluido || !CAT.fluidos[p.fluido]) f.push('Fluido'); if (p.temperatura === '' || p.temperatura == null || isNaN(+p.temperatura)) f.push('Temperatura de servicio');
            if (p.tsMax === '' || p.tsMax == null || isNaN(+p.tsMax)) f.push('Temperatura máxima admisible TS');
            if (!(+p.caudalDiseno > 0)) f.push('Caudal de diseño'); if (!(+p.vImp > 0)) f.push('Velocidad máx. en impulsión'); if (!(+p.vAsp > 0)) f.push('Velocidad máx. en aspiración');
            return f;
        }
        const proyectoDefinido = () => !faltanObligatorios().length;
        const etiquetaProvincia = pais => !pais || /^espa(ñ|n)a$/i.test(pais.trim()) ? 'Provincia' : 'Provincia / Estado / Departamento';
        function tablaVelocidades(fl, tipo) {
            return `<table class="w-full text-[11px] border border-slate-200 mt-1"><thead><tr class="bg-slate-50 text-slate-500"><th class="text-left px-1">Velocidades recomendadas · ${esc(fl)}</th><th class="px-1">Aspiración (m/s)</th><th class="px-1">Impulsión (m/s)</th></tr></thead><tbody>` +
                Object.entries(TIPOS_INSTALACION).map(([k, t]) => { const r = velocidadRecomendada(fl, k); return `<tr class="${k === tipo ? 'bg-blue-50 font-bold' : ''}"><td class="px-1">${t}</td><td class="text-center">${r[0]}</td><td class="text-center">${r[1]}</td></tr>`; }).join('') + '</tbody></table>';
        }
        function abrirDatosProyecto(despues, modo = {}) {
            if (!(modo && modo.nuevo) && !proyecto.numero && !elementosRed.length) { pantallaInicio(); return; }
            alGuardarProyecto = despues || null;
            modoProyecto = modo || {};
            if (!proyectoDefinido() && !modoProyecto.nuevo) modoProyecto.obligatorio = true;
            const p = modoProyecto.nuevo ? PROYECTO_VACIO() : proyecto;
            const fl = p.fluido || '';
            const T = p.temperatura != null ? p.temperatura : '';
            const rec = velocidadRecomendada(fl, p.tipoInstalacion);
            const campoP = ([k, e, t]) => k === 'provincia' ? `<div><label id="dp-lbl-provincia" class="block text-slate-500 mb-0.5">${etiquetaProvincia(p.pais)}</label><input id="dp-p-provincia" value="${esc(p.provincia)}" class="w-full border rounded p-1.5"></div>`
                : k === 'pais' ? `<div><label class="block text-slate-500 mb-0.5">País</label><input id="dp-p-pais" value="${esc(p.pais)}" oninput="document.getElementById('dp-lbl-provincia').innerText = etiquetaProvincia(this.value)" class="w-full border rounded p-1.5"></div>` : campoHTML(k, e, t, p[k], 'p');
            document.getElementById('modal-proyecto-body').innerHTML = `
                ${modoProyecto.obligatorio || modoProyecto.nuevo ? `<div class="bg-blue-50 border border-blue-200 text-blue-800 rounded p-2 mb-3">${modoProyecto.nuevo ? 'Nuevo proyecto: introduce sus datos; al guardarlos se empieza un dibujo en blanco. Para recuperar uno ya guardado: Archivo &gt; Proyecto existente.' : 'Completa los datos obligatorios (*) del proyecto.'} Los datos de diseño solo se pueden cambiar después desde <b>Archivo &gt; Datos del proyecto</b>.</div>` : ''}
                <p class="font-bold text-slate-600 mb-1">Proyecto e instalación</p>
                <div class="grid grid-cols-2 gap-2 mb-3">${CAMPOS_PROYECTO.map(campoP).join('')}</div>
                <label class="flex items-center gap-1.5 font-bold text-slate-600 mb-1"><input type="checkbox" id="dp-esBuque" ${p.esBuque ? 'checked' : ''} onchange="document.getElementById('dp-bloque-buque').style.display = this.checked ? '' : 'none'"> El cliente es un astillero (instalación en un buque)</label>
                <div id="dp-bloque-buque" class="grid grid-cols-2 gap-2 mb-3 border border-slate-200 rounded p-2" style="${p.esBuque ? '' : 'display:none'}">${CAMPOS_BUQUE.map(([k, e, t]) => campoHTML(k, e, t, p.buque[k], 'b')).join('')}</div>
                <p class="font-bold text-slate-600 mb-1">Cajetín del plano <span class="font-normal text-slate-400">(vacío = se toma de los datos del proyecto)</span></p>
                <div class="grid grid-cols-2 gap-2 mb-3">${CAMPOS_CAJETIN.map(([k, e, t]) => campoHTML(k, e, t, p[k], 'p')).join('')}</div>
                <p class="font-bold text-slate-600 mb-1">Datos de diseño</p>
                <div class="grid grid-cols-2 gap-2">
                    <div><label class="block text-slate-500 mb-0.5">Fluido *</label><select id="dp-fluido" class="w-full border rounded p-1.5" onchange="actualizarVRecomendada(true)"><option value="" ${fl ? '' : 'selected'}>— elegir —</option>${Object.keys(CAT.fluidos).map(f => `<option ${f === fl ? 'selected' : ''}>${esc(f)}</option>`).join('')}</select></div>
                    ${campoHTML('temperatura', 'Temperatura de servicio (°C) *', 'number', T, 'p')}
                    <div><label class="block text-slate-500 mb-0.5">Tipo de instalación *</label><select id="dp-tipoInstalacion" class="w-full border rounded p-1.5" onchange="actualizarVRecomendada(true)"><option value="" ${p.tipoInstalacion ? '' : 'selected'}>— elegir —</option>${Object.entries(TIPOS_INSTALACION).map(([k, t]) => `<option value="${k}" ${p.tipoInstalacion === k ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
                    ${campoHTML('tsMax', 'Temperatura máxima admisible TS (°C) *', 'number', p.tsMax, 'p')}
                    ${campoHTML('caudalDiseno', 'Caudal de diseño (m³/h) *', 'number', p.caudalDiseno, 'p')}
                    ${campoHTML('presionDiseno', 'Presión de diseño (bar) * · presión con la que parte la línea P01', 'number', p.presionDiseno == null ? '' : p.presionDiseno, 'p')}
                    ${campoHTML('tCierre', 'Tiempo de cierre de válvulas (s) · golpe de ariete (vacío = instantáneo)', 'number', p.tCierre, 'p')}
                    ${campoHTML('vImp', `Velocidad máx. en impulsión (m/s) * · recomendada <span id="rec-imp">${rec[1]}</span>`, 'number', p.vImp, 'p')}
                    ${campoHTML('vAsp', `Velocidad máx. en aspiración de bombas (m/s) * · recomendada <span id="rec-asp">${rec[0]}</span>`, 'number', p.vAsp, 'p')}
                    <div class="col-span-2"><div id="dp-tabla-v">${tablaVelocidades(fl || '—', p.tipoInstalacion)}</div><button type="button" onclick="actualizarVRecomendada('forzar')" class="mt-1 px-2 py-1 border rounded hover:bg-slate-50 text-[11px]"><i class="fa-solid fa-wand-magic-sparkles mr-1 text-blue-600"></i>Usar las velocidades recomendadas</button></div>
                    <div><label class="block text-slate-500 mb-0.5">Grupo del fluido (PED art. 13)</label><select id="dp-grupoPED" class="w-full border rounded p-1.5">${[['auto', 'Automático según fluido y TS'], ['1', 'Grupo 1 (peligroso)'], ['2', 'Grupo 2']].map(([k, t]) => `<option value="${k}" ${p.grupoPED === k ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
                    <div><label class="block text-slate-500 mb-0.5">Criterio de presión de prueba</label><select id="dp-criterioPrueba" class="w-full border rounded p-1.5">${Object.entries(CRITERIOS_PRUEBA).map(([k, c]) => `<option value="${k}" ${p.criterioPrueba === k ? 'selected' : ''}>${c.nombre}</option>`).join('')}</select></div>
                    ${campoHTML('horasAnuales', 'Horas de funcionamiento al año · coste energético (vacío = 4000)', 'number', p.horasAnuales, 'p')}
                    ${campoHTML('precioEnergia', 'Precio de la energía (€/kWh; vacío = 0,15)', 'number', p.precioEnergia, 'p')}
                    ${campoHTML('etaMotor', 'Rendimiento del motor (vacío = 0,90)', 'number', p.etaMotor, 'p')}
                    ${campoHTML('tAmbiente', 'Temperatura ambiente (°C) · aislamiento (vacío = 20)', 'number', p.tAmbiente, 'p')}
                    ${campoHTML('tMontaje', 'Temperatura de montaje (°C) · dilatación (vacío = 20)', 'number', p.tMontaje, 'p')}
                    <label class="flex items-center gap-1.5 text-slate-600"><input type="checkbox" id="dp-exterior" ${p.exterior ? 'checked' : ''}> Tuberías al exterior (RITE: +10 mm calientes, +20 mm fríos)</label>
                    <label class="flex items-center gap-1.5 text-slate-600 col-span-2"><input type="checkbox" id="dp-salvaguardas" ${p.salvaguardas ? 'checked' : ''}> Buques: tuberías de fluidos tóxicos/inflamables con salvaguardas especiales (clase II)</label>
                </div>
                ${modoProyecto.nuevo ? '' : `<p class="font-bold text-slate-600 mt-3 mb-1">Control de revisiones <span class="font-normal text-slate-400">(revisión en curso: ${esc(p.revision || '0')})</span></p>
                <table class="w-full text-[11px] mb-1"><thead><tr class="text-left text-slate-500"><th>Rev.</th><th>Fecha</th><th>Autor</th><th>Descripción</th></tr></thead><tbody>
                ${(p.revisiones || []).map(r => `<tr><td>${esc(r.rev)}</td><td>${esc(r.fecha)}</td><td>${esc(r.autor)}</td><td>${esc(r.descripcion)}</td></tr>`).join('') || '<tr><td colspan="4" class="text-slate-400 italic">Sin revisiones registradas</td></tr>'}
                </tbody></table>
                <button type="button" onclick="registrarRevision()" class="px-2 py-1 border rounded hover:bg-slate-50 text-[11px]"><i class="fa-solid fa-code-compare mr-1 text-blue-600"></i>Registrar la revisión ${esc(p.revision || '0')} (guarda una copia de la red)</button>`}
                <p class="text-[10px] text-slate-400 mt-2">* obligatorio. Las velocidades recomendadas son valores orientativos de práctica de diseño según fluido e instalación; se toman las indicadas aquí para todo el proyecto.</p>`;
            const cancelar = !modoProyecto.obligatorio;
            document.querySelectorAll('#modal-proyecto .btn-cancelar-proyecto').forEach(b => b.style.display = cancelar ? '' : 'none');
            document.getElementById('modal-proyecto').style.display = 'flex';
        }
        function actualizarVRecomendada(fijar) {
            const fl = document.getElementById('dp-fluido').value, tipo = document.getElementById('dp-tipoInstalacion').value;
            const rec = velocidadRecomendada(fl, tipo);
            document.getElementById('rec-asp').innerText = rec[0]; document.getElementById('rec-imp').innerText = rec[1];
            // solo se rellenan si están vacías (o con el botón "Usar las velocidades recomendadas")
            const a = document.getElementById('dp-p-vAsp'), i = document.getElementById('dp-p-vImp');
            if (fijar === 'forzar' || (fijar && fl && tipo)) { if (fijar === 'forzar' || !a.value) a.value = rec[0]; if (fijar === 'forzar' || !i.value) i.value = rec[1]; }
            document.getElementById('dp-tabla-v').innerHTML = tablaVelocidades(fl || '—', tipo);
        }
        function cerrarDatosProyecto() {
            if (modoProyecto.obligatorio) return;
            const volver = modoProyecto.desdeInicio || !proyectoDefinido();
            document.getElementById('modal-proyecto').style.display = 'none'; alGuardarProyecto = null; modoProyecto = {};
            if (volver && !proyectoDefinido()) pantallaInicio();
        }
        function guardarDatosProyecto() {
            const v = id => (document.getElementById(id) || {}).value;
            const nuevo = !!modoProyecto.nuevo;
            const destino = nuevo ? PROYECTO_VACIO() : proyecto;
            const claveCalculo = () => [destino.fluido, destino.temperatura, destino.tipoInstalacion, destino.caudalDiseno, destino.vAsp, destino.vImp, destino.tCierre, destino.tsMax, destino.grupoPED, destino.criterioPrueba, destino.salvaguardas, destino.esBuque, destino.tAmbiente, destino.tMontaje, destino.exterior, destino.horasAnuales, destino.precioEnergia, destino.etaMotor].join('|');
            const antes = claveCalculo();
            const copia = JSON.parse(JSON.stringify(destino));
            CAMPOS_PROYECTO.forEach(([k]) => { copia[k] = (v('dp-p-' + k) || '').trim(); });
            CAMPOS_CAJETIN.forEach(([k]) => { copia[k] = (v('dp-p-' + k) || '').trim(); });
            if (!copia.revision) copia.revision = '0';
            if (!copia.fecha) copia.fecha = new Date().toISOString().slice(0, 10);
            copia.esBuque = document.getElementById('dp-esBuque').checked;
            CAMPOS_BUQUE.forEach(([k]) => { copia.buque[k] = (v('dp-b-' + k) || '').trim(); });
            copia.tipoInstalacion = v('dp-tipoInstalacion');
            copia.fluido = v('dp-fluido');
            ['temperatura', 'caudalDiseno', 'presionDiseno', 'vAsp', 'vImp', 'tCierre', 'tsMax', 'tAmbiente', 'tMontaje', 'horasAnuales', 'precioEnergia', 'etaMotor'].forEach(k => { copia[k] = (v('dp-p-' + k) || '').trim(); });
            copia.grupoPED = v('dp-grupoPED') || 'auto'; copia.criterioPrueba = v('dp-criterioPrueba') || 'PED';
            copia.salvaguardas = !!(document.getElementById('dp-salvaguardas') || {}).checked;
            copia.exterior = !!(document.getElementById('dp-exterior') || {}).checked;
            const falta = faltanObligatorios(copia);
            if (!(+copia.presionDiseno > 0)) falta.push('Presión de diseño');
            if (falta.length) { alert('Faltan datos obligatorios:\n\n· ' + falta.join('\n· ')); return; }
            const neg = ['caudalDiseno', 'vAsp', 'vImp', 'tCierre'].filter(k => copia[k] !== '' && !(+copia[k] > 0));
            if (neg.length) { alert('El caudal, las velocidades y el tiempo de cierre deben ser números mayores que cero.'); return; }
            if (+copia.tsMax < +copia.temperatura) { alert('La temperatura máxima admisible TS no puede ser menor que la de servicio.'); return; }
            document.getElementById('modal-proyecto').style.display = 'none';
            if (nuevo) {
                planoCongelado = false; pintarCongelado();
                guardarEstado();
                elementosRed = []; lineas = []; condicionesContorno = {}; idSeleccionado = null; seleccion.clear();
                hojas = [{ id: '00' }]; hojaActual = 0; sincronizarHoja(); pintarHojas();
                currentFileHandle = null; nombreArchivoActual = ''; ultimoResultado = null; ultimoCalculo = null;
                proyecto = copia; cerrarModal();
                setTimeout(() => { ofrecerPlantillaCliente(); ofrecerTutorial(); }, 300);
            } else Object.assign(proyecto, copia);
            modoProyecto = {};
            aplicarFluidoProyecto();
            marcarCambios(true);
            if (nuevo || claveCalculo() !== antes) { invalidarResultados(); }
            renderizarVectorial();
            if (nuevo) { irAOrigenEnEsquina(); limpiarSeleccion(); }
            actualizarTituloProyecto();
            const f = alGuardarProyecto; alGuardarProyecto = null; if (f) f();
        }
        // El fluido y la temperatura del panel izquierdo son los del proyecto (solo lectura)
        function aplicarFluidoProyecto() {
            const sel = document.getElementById('selector-fluido'), t = document.getElementById('temp-fluido');
            if (proyecto.fluido && CAT.fluidos[proyecto.fluido]) sel.value = proyecto.fluido;
            if (proyecto.temperatura !== '' && proyecto.temperatura != null && isFinite(+proyecto.temperatura)) t.value = proyecto.temperatura;
            actualizarInfoFluido(); actualizarPanelDiseno();
        }
        function actualizarPanelDiseno() {
            const d = document.getElementById('panel-diseno'); if (!d) return;
            const lim = limitesVelocidad(), fila = (k, v) => `<div class="flex justify-between gap-2"><span class="text-slate-400">${k}</span><b class="text-slate-700">${v}</b></div>`;
            d.innerHTML = proyectoDefinido() ? fila('Caudal de proyecto', `${fQ(+proyecto.caudalDiseno, 2)} ${lQ()}`) + (+proyecto.presionDiseno > 0 ? fila('Presión de diseño', `${fP(+proyecto.presionDiseno, 2)} ${lP()}`) : '') + fila('V máx. impulsión', `${lim.imp} m/s`) + fila('V máx. aspiración', `${lim.asp} m/s`) + fila('TS máx.', `${proyecto.tsMax} °C`)
                : '<span class="text-amber-600">Proyecto sin definir</span>';
        }
        function faltanDatosProyecto() {
            const f = [];
            if (!proyecto.numero) f.push('Nº de proyecto'); if (!proyecto.cliente) f.push('Cliente'); if (!proyecto.instalacion) f.push('Instalación');
            if (!(+proyecto.caudalDiseno > 0)) f.push('Caudal de diseño');
            if (proyecto.esBuque) CAMPOS_BUQUE.filter(([, e]) => e.endsWith('*')).forEach(([k, e]) => { if (!proyecto.buque[k]) f.push(e.replace(' *', '')); });
            return f;
        }
        function actualizarTituloProyecto() {
            const h = document.querySelector('header h1');
            if (h) h.innerHTML = `<i class="fa-solid fa-network-wired mr-2 text-blue-600"></i>PIPING P&ID${proyecto.numero ? ' · ' + esc(proyecto.numero) + (proyecto.cliente ? ' · ' + esc(proyecto.cliente) : '') : ''}`;
        }

        // ==================================================================================
        // INFORME DE CÁLCULO (.docx)
        // Menú Informe > Generar informe. Requisitos: datos del proyecto completos, red calculada
        // tras el último cambio y ningún elemento en rojo. Se genera con la librería docx (se carga
        // bajo demanda desde jsDelivr) y se guarda donde indique el usuario.
        // Estructura: portada · índices (contenido, tablas, figuras) · 1 datos del proyecto (y del
        // buque) · 2 bases de diseño · 3 descripción de la red y resumen · 4 cálculo justificativo por
        // líneas en el orden del árbol (croquis, componentes, resultados, justificación) · 5 balance de
        // la ruta crítica · 6 conclusiones · anexos.
        // ==================================================================================
        const URL_DOCX = 'https://cdn.jsdelivr.net/npm/docx@9.6.1/dist/index.iife.js';
        
        // Formatos numéricos del informe (coma decimal)
        const nf = (x, d = 3) => (x == null || !isFinite(x)) ? '—' : (+x).toFixed(d).replace('.', decimalDoc());
        const SUP = { '-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };
        
        function nombreTipo(el) {
            if (el.type === 'tuberia') return 'Tubería';
            if (el.type === 'bomba') return 'Bomba centrífuga';
            const t = TIPOS[el.subtype];
            return t ? t.nombre + (el.subtype === 'reduccion' ? (el.excentrica ? ' excéntrica' : ' concéntrica') : '') : el.subtype;
        }

        // ---------- Comprobaciones previas ----------
        function comprobarInforme() {
            const falta = faltanDatosProyecto();
            if (falta.length) return { tipo: 'datos', falta };
            if (!ultimoCalculo || ultimoCalculo.huella !== huellaRed()) return { tipo: 'calculo' };
            const ars = ultimoCalculo.resultado.aristas;
            const calculados = new Set(ars.map(a => a.el.id));
            const fallos = elementosRed.filter(e => e.estado === 'fallo').map(e => { const r = ultimoResultado[e.id] || { motivos: [] }; return `${tagDe(e)}: ${r.motivos.join('; ')}${(r.alternativas || []).map(x => '\n    → ' + x).join('')}`; });
            elementosRed.filter(e => !sinFlujo(e) && !calculados.has(e.id) && !(esTerminal(e) && ultimoResultado[e.id]) && bombaEnMarcha(e)).forEach(e => fallos.push(`${tagDe(e)}: no está conectado a la red (no se ha calculado)`));
            if (!ars.some(a => a.esBomba) && ultimoCalculo.resultado.Qbombas != null && ultimoCalculo.resultado.Qbombas < (+proyecto.caudalDiseno || 0) * 0.999) fallos.push(`Red sin bombas: el caudal de funcionamiento (${ultimoCalculo.resultado.Qbombas.toFixed(2)} m³/h) no alcanza el caudal de diseño (${proyecto.caudalDiseno} m³/h).`);
            if (fallos.length) return { tipo: 'fallos', fallos };
            // con bombas de reserva, también debe cumplir el escenario "reserva en marcha"
            const esc = escenarioReserva();
            if (esc && esc.fallos.length) return { tipo: 'fallos', fallos: esc.fallos.map(f => '[Reserva en marcha] ' + f) };
            return null;
        }

        // ==================================================================================
        // PLANTILLA DE WORD DEL INFORME (una por cliente, guardada en el navegador)
        // La plantilla aporta página, cabecera, pie, estilos (los títulos y la leyenda se asignan por nombre de
        // estilo: «heading 1», «caption»...) y, si quiere, una portada propia. Marcadores que se sustituyen en
        // la plantilla (cuerpo, cabecera y pie): {{INFORME}} (donde se inserta el informe; si no está, se añade
        // al final y se mantiene la portada del programa), {{PROYECTO}}, {{CLIENTE}}, {{REF_CLIENTE}},
        // {{INSTALACION}}, {{DESCRIPCION}}, {{FECHA}}, {{REVISION}}, {{AUTOR}}, {{TITULO}}.
        // ==================================================================================
        const URL_JSZIP = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
        
        const clavePlantilla = () => 'piping-plantilla:' + String(proyecto.cliente || '').trim().toLowerCase();
        const b64aBuf = b => { const s = atob(b), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u.buffer; };
        const bufAb64 = buf => { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i += 32768) s += String.fromCharCode.apply(null, u.subarray(i, i + 32768)); return btoa(s); };
        const textoXML = x => x.replace(/<[^>]+>/g, '');
        function elegirArchivo(accept) {
            return new Promise(ok => { const i = document.createElement('input'); i.type = 'file'; i.accept = accept; i.onchange = () => ok(i.files[0] || null); i.addEventListener('cancel', () => ok(null)); i.click(); });
        }
        function elegirPlantillaInforme(...a) { return PARTES_OK.informe ? elegirPlantillaInforme__p.apply(this, a) : cargarParte('informe').then(() => elegirPlantillaInforme__p.apply(this, a)); }
        // Sustituye {{MARCADOR}} aunque Word lo haya partido en varias ejecuciones de texto

        function generarInforme(...a) { return PARTES_OK.informe ? generarInforme__p.apply(this, a) : cargarParte('informe').then(() => generarInforme__p.apply(this, a)); }

        // ---------- Figuras (croquis SVG -> PNG) ----------
        function aPantalla(el, px, py) {
            const s = el.scale || 1, r = (el.rotation || 0) * Math.PI / 180;
            const dx = px * s - 25, dy = py * s - 25;
            return { x: el.x + 25 + dx * Math.cos(r) - dy * Math.sin(r), y: mundoAScreenY(el.y) + 25 + dx * Math.sin(r) + dy * Math.cos(r) };
        }
        function centroElemento(el) { return el.type === 'tuberia' ? aPantalla(el, (el.longitud || 3000) / 60, 20) : aPantalla(el, 25, 25); }
        
        // opciones: { principales: [el], contexto: [el], numeros: {id: n}, rotulosLinea: bool }

        // ---------- Justificación de cada elemento ----------
        // Devuelve { k: texto K/Cv para la tabla de componentes, filas: [[magnitud, expresión, sustitución, resultado]] }

        // ---------- Documento ----------

        // ==================================================================================
        // AISLAMIENTO, DILATACIÓN Y SOPORTES (por tubería y por línea)
        //  - Aislamiento mínimo: RITE IT 1.2.4.2.1.2, tablas 1.2.4.2.1 (calientes) y 1.2.4.2.2 (fríos), λref 0,040
        //    W/(m·K); en exterior +10 mm (calientes) y +20 mm (fríos); corrección de espesor para otro λ.
        //  - Pérdidas: q = ΔT/(ln(D2/D1)/(2πλ) + 1/(h·π·D2)), h = 10 W/(m²·K); caída de T exponencial con ṁ·cp.
        //  - Dilatación: ΔL = α·L·ΔT, ΔT = TS − T de montaje. Aviso si un tramo recto supera 10 mm.
        //  - Soportes: separación máxima orientativa (ASME B31.1 tabla 121.5 para acero lleno de agua;
        //    termoplásticos por diámetro exterior), nº de soportes = ceil(L/s).
        // ==================================================================================
        const ALFA_MAT = { 'Acero al carbono': 0.012, 'Acero al carbono EN': 0.012, 'Acero inoxidable': 0.016, 'PVC-U': 0.08, 'PE100': 0.2, 'PE80': 0.2, 'CPVC': 0.07, 'PP-R': 0.15, 'PVDF': 0.12, 'PP-H': 0.15,
            'Cobre (Dint ref. Sch 40)': 0.017, 'Fundición (Dint ref. Sch 40)': 0.011, 'Hormigón (Dint ref. Sch 40)': 0.012 }; // mm/(m·K)
        const DENS_MAT = { 'Acero al carbono': 7850, 'Acero al carbono EN': 7850, 'Acero inoxidable': 7950, 'PVC-U': 1400, 'PE100': 955, 'PE80': 950, 'CPVC': 1550, 'PP-R': 900, 'PVDF': 1780, 'PP-H': 905,
            'Cobre (Dint ref. Sch 40)': 8940, 'Fundición (Dint ref. Sch 40)': 7100, 'Hormigón (Dint ref. Sch 40)': 2400 };
        const CP_FLUIDO = n => /glicol/i.test(n) ? 3700 : /mar/.test(n) ? 3990 : /^Agua/.test(n) ? 4186 : /Aceite|Gasóleo|Queroseno|Fuelóleo|Gasolina/.test(n) ? 2000 : /NaOH/.test(n) ? 3200 : /sulfúrico/.test(n) ? 1400 : 4000;
        const RITE_CAL = { T: [60, 100, 180], D: [35, 60, 90, 140, 1e9], e: [[25, 25, 30], [30, 30, 40], [30, 30, 40], [30, 40, 50], [35, 40, 50]] };
        const RITE_FRIO = { e: [[30, 20, 20], [40, 30, 20], [40, 30, 30], [50, 40, 30], [50, 40, 30]] }; // columnas: −10…0, 0…10, >10 °C
        function aislamientoRITE(Dext, T, exterior) {
            const fila = RITE_CAL.D.findIndex(d => Dext <= d);
            if (T > 40) { const c = T <= 60 ? 0 : T <= 100 ? 1 : 2; return RITE_CAL.e[fila][c] + (exterior ? 10 : 0); }
            if (T < 40 && T >= -10 && T < (+proyecto.tAmbiente || 20)) { const c = T <= 0 ? 0 : T <= 10 ? 1 : 2; return RITE_FRIO.e[fila][c] + (exterior ? 20 : 0); }
            return 0; // entre la ambiente y 40 °C: no exigido
        }
        // espesor equivalente para otro λ (RITE, cilindros): d = D/2·[exp(λ/λref·ln((D+2·dref)/D)) − 1]
        const espesorPorLambda = (Dext, dref, lam) => Dext / 2 * (Math.exp(lam / 0.040 * Math.log((Dext + 2 * dref) / Dext)) - 1);
        function separacionSoportes(el, T) {
            const dt = datosTuberia(el), De = dt.od;
            if (esAceroTubo(el.material) || /Cobre|Fundición/.test(el.material)) {
                const tab = [[33.4, 2.1], [60.3, 3.0], [88.9, 3.7], [114.3, 4.3], [168.3, 5.2], [219.1, 5.8], [323.9, 7.0], [406.4, 8.2], [508, 9.1], [610, 9.8]];
                if (De <= tab[0][0]) return tab[0][1] * De / tab[0][0] < 1.5 ? 1.5 : tab[0][1];
                for (let i = 1; i < tab.length; i++) if (De <= tab[i][0]) return tab[i - 1][1] + (tab[i][1] - tab[i - 1][1]) * (De - tab[i - 1][0]) / (tab[i][0] - tab[i - 1][0]);
                return tab[tab.length - 1][1];
            }
            const k = { 'PVC-U': 14, 'CPVC': 13, 'PVDF': 12, 'PP-R': 10, 'PP-H': 10, 'PE100': 10, 'PE80': 10 }[matBase(el.material)] || 10;
            const fT = T <= 20 ? 1 : T <= 40 ? 0.85 : T <= 60 ? 0.7 : 0.6;
            return Math.max(0.3, k * De / 1000 * fT);
        }
        function termicaYSoportes(resultado) {
            const fl = resultado.fluido, TS = +proyecto.tsMax > 0 ? +proyecto.tsMax : fl.T, Tm = proyecto.tMontaje !== '' && proyecto.tMontaje != null && !isNaN(+proyecto.tMontaje) ? +proyecto.tMontaje : 20;
            const Ta = proyecto.tAmbiente !== '' && proyecto.tAmbiente != null && !isNaN(+proyecto.tAmbiente) ? +proyecto.tAmbiente : 20, ext = !!proyecto.exterior, cp = CP_FLUIDO(fl.nombre);
            const porLinea = {};
            resultado.aristas.filter(a => a.el.type === 'tuberia').forEach(a => {
                const el = a.el, dt = datosTuberia(el), L = a.L, lam = +el.lambdaAisl > 0 ? +el.lambdaAisl : 0.040;
                const eMin = aislamientoRITE(dt.od, fl.T, ext), eMinLam = eMin ? espesorPorLambda(dt.od, eMin, lam) : 0;
                const e = +el.aislamiento > 0 ? +el.aislamiento : 0;
                const D1 = dt.od / 1000, D2 = (dt.od + 2 * e) / 1000, h = 10;
                const R = (e > 0 ? Math.log(D2 / D1) / (2 * Math.PI * lam) : 0) + 1 / (h * Math.PI * D2); // m·K/W (pared metálica despreciable)
                const q = (fl.T - Ta) / R;                               // W/m (+ pierde, − gana)
                const m = Math.abs(a.Qprev) * fl.rho;                    // kg/s
                const Tsal = m > 1e-9 ? Ta + (fl.T - Ta) * Math.exp(-L / (R * m * cp)) : Ta;
                const dL = (ALFA_MAT[el.material] || 0.012) * L * (TS - Tm);   // mm
                const s_ = separacionSoportes(el, TS), nSop = Math.max(1, Math.ceil(L / s_));
                const Amet = Math.PI / 4 * (dt.od * dt.od - dt.Dint * dt.Dint) / 1e6, peso = Amet * (DENS_MAT[el.material] || 7850) + Math.PI / 4 * Math.pow(dt.Dint / 1000, 2) * fl.rho; // kg/m lleno (sin aislamiento)
                const x = { tag: tagDe(el), De: dt.od, L, e, eMin: eMinLam ? Math.ceil(eMinLam) : 0, lam, q, Qw: q * L, dT: fl.T - Tsal, dL, sep: s_, nSop, peso };
                const r = ultimoResultado[el.id]; if (r) r.termica = x;
                if (eMin && e + 1e-6 < x.eMin) resultado.avisosRed.push(`${x.tag}: aislamiento ${e} mm < mínimo RITE ${x.eMin} mm (λ ${lam} W/m·K, ${fl.T} °C${ext ? ', exterior' : ''}).`);
                if (Math.abs(dL) > 10) resultado.avisosRed.push(`${x.tag}: dilatación ΔL = ${dL.toFixed(1)} mm (ΔT ${(TS - Tm).toFixed(0)} K): prever lira, compensador o cambio de dirección.`);
                (porLinea[el.linea || '?'] = porLinea[el.linea || '?'] || []).push(x);
            });
            resultado.termica = { TS, Tm, Ta, ext, cp, lineas: Object.entries(porLinea).map(([id, t]) => ({ linea: id, tubos: t, L: t.reduce((s, x) => s + x.L, 0), Qw: t.reduce((s, x) => s + x.Qw, 0), dL: t.reduce((s, x) => s + x.dL, 0), nSop: t.reduce((s, x) => s + x.nSop, 0), peso: t.reduce((s, x) => s + x.peso * x.L, 0) })) };
        }
        function aplicarAislamientoRITE() {
            const fl = fluidoSeleccionado(); if (!fl.ok) { alert(fl.msg); return; }
            guardarEstado(); invalidarResultados();
            let n = 0;
            elementosRed.filter(e => e.type === 'tuberia').forEach(e => {
                const dt = datosTuberia(e), lam = +e.lambdaAisl > 0 ? +e.lambdaAisl : 0.040, eMin = aislamientoRITE(dt.od, fl.T, !!proyecto.exterior);
                if (eMin) { e.aislamiento = Math.ceil(espesorPorLambda(dt.od, eMin, lam)); n++; } else delete e.aislamiento;
            });
            renderizarVectorial();
            alert(n ? `Aislamiento mínimo RITE aplicado a ${n} tuberías (fluido a ${fl.T} °C, ${proyecto.exterior ? 'exterior' : 'interior'}).` : `A ${fl.T} °C el RITE no exige aislamiento (entre la temperatura ambiente y 40 °C).`);
        }

        // ==================================================================================
        // PUNTOS ALTOS Y BAJOS (purgadores y drenajes), VOLUMEN, VASO DE EXPANSIÓN Y GLICOL
        // Un nodo interior es punto alto si su cota es ≥ la de todos sus vecinos por tubería y mayor que
        // alguno de ellos (análogo para punto bajo). Debe llevar purgador (PG) o drenaje (DR) conectado.
        // Vaso de expansión (circuito cerrado, UNE 100155): Vv = V·Ce·Cp, Ce = ρ(Tmín)/ρ(Tmáx) − 1,
        // Cp = PM/(PM − Pm) en presiones absolutas.
        // ==================================================================================
        function rhoAguaReal(T) { // IAPWS aproximada (kg/m³), solo para la dilatación del agua
            return 1000 * (1 - (T + 288.9414) / (508929.2 * (T + 68.12963)) * Math.pow(T - 3.9863, 2));
        }
        function puntosAltosBajos(resultado, grafo) {
            const { aristas, z } = resultado, avisos = [];
            if (resultado.fluido && propiedadesFluido(resultado.fluido.nombre, resultado.fluido.T).pv > PRESION_ATM + 0.5e5) return [];
            const vec = {};
            aristas.filter(a => a.el.type === 'tuberia').forEach(a => { (vec[a.nodoA] = vec[a.nodoA] || []).push(a.nodoB); (vec[a.nodoB] = vec[a.nodoB] || []).push(a.nodoA); });
            const conElem = (n, sub) => grafo.nodos[n] && grafo.nodos[n].puertos.some(p => { const e = elementosRed.find(x => x.id === p.elId); return e && sub.includes(e.subtype); });
            const nombreNodo = n => { const ps = (grafo.nodos[n] || { puertos: [] }).puertos.map(p => elementosRed.find(x => x.id === p.elId)).filter(Boolean); return [...new Set(ps.map(tagDe))].join(' / '); };
            const res = [];
            Object.keys(vec).forEach(k => {
                const n = +k, zs = vec[k].map(v => z[v]);
                if (vec[k].length < 2 || (grafo.nodos[n] && grafo.nodos[n].interno)) return;
                const zn = z[n];
                const alto = zs.every(x => zn >= x - 1e-6) && zs.some(x => zn > x + 1e-3);
                const bajo = zs.every(x => zn <= x + 1e-6) && zs.some(x => zn < x - 1e-3);
                if (alto && !conElem(n, ['purgador'])) res.push({ tipo: 'alto', nodo: n, z: zn, donde: nombreNodo(n) });
                if (bajo && !conElem(n, ['drenaje'])) res.push({ tipo: 'bajo', nodo: n, z: zn, donde: nombreNodo(n) });
            });
            res.forEach(r => resultado.avisosRed.push(`Punto ${r.tipo} en ${r.donde} (cota ${r.z.toFixed(2)} m): ${r.tipo === 'alto' ? 'añadir purgador de aire (PG)' : 'añadir drenaje (DR)'}.`));
            resultado.puntosAB = res;
            return res;
        }
        function volumenCircuitos() {
            const circs = [], grafo = construirGrafoRed(), aristas = construirAristas(grafo);
            const padre = grafo.nodos.map((_, i) => i), f = i => { while (padre[i] !== i) i = padre[i] = padre[padre[i]]; return i; };
            aristas.forEach(a => { const x = f(a.nodoA), y = f(a.nodoB); if (x !== y) padre[x] = y; });
            const g = {};
            aristas.forEach(a => { const c = f(a.nodoA); (g[c] = g[c] || { els: new Set(), secundario: new Set() }); g[c].els.add(a.el); if (a.rama === 'sec') g[c].secundario.add(a.el.id); });
            grafo.nodos.forEach(n => n.puertos.forEach(p => { const e = elementosRed.find(x => x.id === p.elId); if (e && (esTerminal(e) || e.subtype === 'vasoexp')) { const c = f(n.id); if (g[c]) g[c].els.add(e); } }));
            Object.values(g).forEach(c => {
                const els = [...c.els];
                const Vtub = els.filter(e => e.type === 'tuberia').reduce((s, e) => { const d = datosTuberia(e).Dint / 1000; return s + Math.PI / 4 * d * d * e.longitud / 1000; }, 0) * 1000;
                const Veq = els.filter(e => e.type === 'equipo').reduce((s, e) => s + (+e.volumen || 0), 0);
                const abierto = els.some(e => esDeposito(e) && !(+e.presionDep > 0) || e.subtype === 'consumo');
                const cotas = els.flatMap(e => e.type === 'tuberia' ? [+e.cotaA, +e.cotaB] : [+e.cota || 0]);
                circs.push({ lineas: [...new Set(els.map(e => e.linea).filter(Boolean))].sort(), Vtub, Veq, V: Vtub + Veq, abierto, zmin: Math.min(...cotas), zmax: Math.max(...cotas), vaso: els.find(e => e.subtype === 'vasoexp') });
            });
            return circs;
        }
        const VASOS_NORMALIZADOS = [8, 12, 18, 25, 35, 50, 80, 100, 140, 200, 250, 300, 400, 500, 600, 800, 1000, 1500, 2000];
        function abrirVolumenVaso(...a) { return PARTES_OK.herr ? abrirVolumenVaso__p.apply(this, a) : cargarParte('herr').then(() => abrirVolumenVaso__p.apply(this, a)); }
        let ultimoVolumen = null;
        function calcVaso(V, fl, t1, t2, h, psv) {
            const rho = T => /^Agua( |$)/.test(fl.nombre) && !/mar|glicol/.test(fl.nombre) ? rhoAguaReal(T) : (propiedadesFluido(fl.nombre, T).rho || fl.rho);
            const Ce = rho(t1) / rho(t2) - 1;
            const Pm = 1.01325 + h * fl.rho * G / 1e5 + 0.2;                       // bar abs (altura estática + 0,2 bar)
            const PM = 1.01325 + Math.max(psv - Math.max(0.1 * psv, 0.35), 0.1);  // bar abs (tarado − margen de cierre)
            const Cp = PM > Pm ? PM / (PM - Pm) : Infinity;
            const Vv = V * Ce * Cp;
            return { t1, t2, h, psv, Ce, Pm, PM, Cp, Vv, nor: VASOS_NORMALIZADOS.find(x => x >= Vv) };
        }
        // ==================================================================================
        // DIMENSIONADO DE LA BOMBA (Herramientas > Dimensionar bomba)
        // La bomba se sustituye por una altura constante ΔH y se busca (bisección) la mínima ΔH con la
        // que la red da el caudal necesario (caudal de diseño o suma de consumos) y todos los consumos
        // tienen su presión mínima. Repitiendo a caudales parciales (consumos escalados) se obtiene la
        // curva de la instalación. Se propone H = 1,10·ΔH, potencia al eje con η y motor IEC (+15 %).
        // Varias bombas: se consideran iguales y en paralelo (misma ΔH, caudal repartido).
        // ==================================================================================
        const MOTORES_IEC = [0.12, 0.18, 0.25, 0.37, 0.55, 0.75, 1.1, 1.5, 2.2, 3, 4, 5.5, 7.5, 11, 15, 18.5, 22, 30, 37, 45, 55, 75, 90, 110, 132, 160, 200, 250, 315, 355, 400, 450, 500];
        let ultimoDimBomba = null;
        // Circuitos hidráulicamente independientes (p. ej. primario y secundario de un intercambiador)
        function circuitosRed() {
            const grafo = construirGrafoRed(), aristas = construirAristas(grafo);
            const padre = grafo.nodos.map((_, i) => i), f = i => { while (padre[i] !== i) i = padre[i] = padre[padre[i]]; return i; };
            aristas.forEach(a => { const x = f(a.nodoA), y = f(a.nodoB); if (x !== y) padre[x] = y; });
            const grupos = {};
            aristas.forEach(a => { const c = f(a.nodoA); (grupos[c] = grupos[c] || { bombas: new Set(), elementos: new Set(), nodos: new Set() }); grupos[c].elementos.add(a.el.id); grupos[c].nodos.add(a.nodoA); grupos[c].nodos.add(a.nodoB); if (a.el.type === 'bomba') grupos[c].bombas.add(a.el.id); });
            // terminales conectados a cada circuito
            grafo.nodos.forEach(n => n.puertos.forEach(p => { const e = elementosRed.find(x => x.id === p.elId); if (e && esTerminal(e)) { const c = f(n.id); if (grupos[c]) grupos[c].elementos.add(e.id); } }));
            return Object.values(grupos).filter(g => g.bombas.size).map(g => ({ bombas: [...g.bombas], elementos: [...g.elementos] }));
        }
        function evaluarConAltura(dH, factor, circ, Qobj) {
            // dH en m c.l. para las bombas del circuito; factor escala sus consumos. Sin tocar la interfaz
            const fl = fluidoSeleccionado();
            const bar = dH * fl.rho * G / 1e5;
            elementosRed.forEach(e => {
                if (!circ.elementos.includes(e.id)) return;
                // curva casi plana que da exactamente dH al caudal objetivo (pendiente suave: sistema bien condicionado)
                if (e.type === 'bomba') { e.presion = bar; e.h0 = bar * 1.05 + 1e-4; e.caudal = Math.max((Qobj || 0) / circ.bombas.length, 0.5); }
                if (e.subtype === 'consumo') { if (e._q0 == null) e._q0 = +e.qCons || 0; e.qCons = e._q0 * factor; }
            });
            const grafo = construirGrafoRed(), aristas = construirAristas(grafo);
            const r = calcularResultado(grafo, aristas);
            if (r.error) return { error: r.error };
            const res = r.resultado, Q = res.aristas.filter(a => a.esBomba && circ.bombas.includes(a.el.id)).reduce((s, a) => s + a.Qprev * 3600, 0);
            const cons = res.terminales.elementos.filter(e => e.subtype === 'consumo' && circ.elementos.includes(e.id));
            const consOk = cons.every(e => (ultimoResultado[e.id] || {}).exceso >= -1e-4);
            return { Q, consOk, res };
        }
        function alturaNecesaria(Qobj, factor, circ) {
            let lo = 0, hi = 800, fin = null;
            const cumple = x => { const r = evaluarConAltura(x, factor, circ, Qobj); if (r.error) throw new Error(r.error); fin = r; return r.Q >= Qobj * 0.999 - 1e-6 && r.consOk; };
            if (!cumple(hi)) return null;
            for (let i = 0; i < 30 && hi - lo > 0.01; i++) { const m = (lo + hi) / 2; if (cumple(m)) hi = m; else lo = m; }
            cumple(hi);
            // altura que da realmente la bomba en ese estado (la curva auxiliar no es plana del todo)
            const bs = fin.res.aristas.filter(a => a.esBomba && circ.bombas.includes(a.el.id));
            const Hreal = bs.length ? Math.max(...bs.map(a => fin.res.Hnodo[a.nodoB] - fin.res.Hnodo[a.nodoA])) : hi;
            return { H: Hreal, r: fin };
        }
        function dimensionarBomba(...a) { return PARTES_OK.herr ? dimensionarBomba__p.apply(this, a) : cargarParte('herr').then(() => dimensionarBomba__p.apply(this, a)); }
        // Dimensionado sin interfaz (también lo usa el informe). Deja la red como estaba.
        function calcularDimBomba(eta) {
            if (!elementosRed.some(e => e.type === 'bomba')) return { error: 'La red no tiene bomba. Inserta una bomba (librería > Bombas) y vuelve a intentarlo.' };
            const fl = fluidoSeleccionado();
            if (!fl.ok) return { error: fl.msg };
            eta = eta || (ultimoDimBomba && ultimoDimBomba.eta) || 0.70;
            const circuitos = circuitosRed();
            if (!circuitos.length) return { error: 'Ninguna bomba está conectada a la red.' };
            const guardado = { c: !!ultimoCalculo };
            const copia = instantanea();
            const principal = circuitos.find(c => c.elementos.some(id => (elementosRed.find(e => e.id === id) || {}).linea === 'P01')) || circuitos[0];
            const salida = [], errores = [];
            circuitos.forEach((circ, ic) => {
                try {
                    const els = elementosRed.filter(e => circ.elementos.includes(e.id));
                    const cons = els.filter(e => e.subtype === 'consumo'), sumaCons = cons.reduce((s, e) => s + (+e.qCons || 0), 0);
                    const bombasEl = els.filter(e => e.type === 'bomba');
                    const Qd = circ === principal ? (+proyecto.caudalDiseno || 0) : 0;
                    const Qbase = bombasEl.reduce((s, e) => s + (+e.caudal || 0), 0);
                    const Qreq = cons.length ? sumaCons : (Qd || Qbase);
                    const origenQ = cons.length ? 'suma de consumos' : Qd ? 'caudal de diseño del proyecto' : 'caudal de diseño de la(s) bomba(s)';
                    if (!(Qreq > 0)) throw new Error('sin caudal necesario (indica el caudal de diseño o añade consumos)');
                    const nec = alturaNecesaria(Qreq, 1, circ);
                    if (!nec) throw new Error('ni con 800 m se alcanza el caudal o la presión de los consumos');
                    const npsh = nec.r.res.aristas.filter(a => a.esBomba && circ.bombas.includes(a.el.id)).reduce((m, a) => { const v = calcularNPSH(a, nec.r.res.Hnodo, fl); return v == null ? m : Math.min(m, v); }, Infinity);
                    const curva = [];
                    for (const f of [0, 0.25, 0.5, 0.75, 1, 1.15, 1.3]) { const x = alturaNecesaria(f === 0 ? 0 : Qreq * f, f, circ); if (x) curva.push({ Q: Qreq * f, H: x.H }); }
                    const nB = bombasEl.length, H = nec.H * 1.10, Qb = Qreq / nB;
                    const Ph = fl.rho * G * (Qb / 3600) * H / 1000, Peje = Ph / eta, Pmotor = MOTORES_IEC.find(x => x >= Peje * 1.15) || Math.ceil(Peje * 1.15);
                    salida.push({ bombas: bombasEl.map(e => e.id), tags: bombasEl.map(tagDe), Qreq, origenQ, Qd, sumaCons, Hreq: nec.H, H, Qb, nB, Ph, Peje, Pmotor, Hbar: H * fl.rho * G / 1e5, npsh, curva });
                } catch (e) { errores.push(`Circuito ${ic + 1}: ${e.message}`); }
            });
            // restaurar sin perder el último cálculo (mismos objetos no; se recalcula el estado visual)
            const d = JSON.parse(copia);
            elementosRed = d.e || []; lineas = d.l || [];
            // se recalcula la red original para dejar resultados y colores coherentes con los objetos restaurados
            const g0 = construirGrafoRed(), a0 = construirAristas(g0), r0 = a0.length ? calcularResultado(g0, a0) : { error: 'sin red' };
            if (!r0.error && guardado.c) ultimoCalculo = { resultado: r0.resultado, condiciones: r0.condiciones, huella: huellaRed() };
            else { ultimoCalculo = null; if (!guardado.c) invalidarSinProgramar(); }
            renderizarVectorial();
            if (!salida.length) return { error: 'Dimensionado de la bomba:\n' + errores.join('\n') };
            return { circuitos: salida, errores, eta, fluido: `${fl.nombre} a ${fl.T} °C`, rho: fl.rho };
        }
        // Curva H(Q) de una bomba del modelo de la app: H = H0 − k·Q²  (a partir de caudal, presión y h0 en bar)
        function curvaBombaApp(el, rho) {
            const Hd = el.presion * 1e5 / (rho * G), H0 = el.h0 * 1e5 / (rho * G), Qd = el.caudal;
            const k = (H0 - Hd) / Math.max(Qd * Qd, 1e-9);
            return Q => H0 - k * Q * Q;
        }
        function graficoBombaSVG(d, bombaActual, rho) {
            const W = 620, Hh = 280, m = { l: 48, r: 110, t: 14, b: 38 };
            const cs = d.curva.map(p => ({ Q: p.Q / d.nB, H: p.H }));
            const Qmax = Math.max(...cs.map(p => p.Q), d.Qb) * 1.08;
            const H0p = 1.2 * d.H, kp = (H0p - d.H) / Math.max(d.Qb * d.Qb, 1e-9);
            const actual = bombaActual ? curvaBombaApp(bombaActual, rho) : null;
            const Hmax = Math.max(H0p, ...cs.map(p => p.H), actual ? actual(0) : 0) * 1.08;
            const x = q => m.l + q / Qmax * (W - m.l - m.r), y = h => Hh - m.b - h / Hmax * (Hh - m.t - m.b);
            const puntos = n => Array.from({ length: n + 1 }, (_, i) => i / n * Qmax);
            const linea = (f, extra) => `<polyline fill="none" stroke-width="2" stroke-linejoin="round" ${extra} points="${puntos(40).filter(q => f(q) >= 0).map(q => `${x(q).toFixed(1)},${y(f(q)).toFixed(1)}`).join(' ')}"/>`;
            const inst = `<polyline fill="none" stroke="#2a78d6" stroke-width="2" stroke-linejoin="round" points="${cs.map(p => `${x(p.Q).toFixed(1)},${y(p.H).toFixed(1)}`).join(' ')}"/>` + cs.map(p => `<circle cx="${x(p.Q)}" cy="${y(p.H)}" r="4" fill="#2a78d6" stroke="#fff" stroke-width="1.5"><title>Instalación: Q ${p.Q.toFixed(2)} m³/h · H ${p.H.toFixed(2)} m</title></circle>`).join('');
            const ticksX = puntos(5), ticksY = Array.from({ length: 6 }, (_, i) => i / 5 * Hmax);
            const grid = ticksY.map(h => `<line x1="${m.l}" x2="${W - m.r}" y1="${y(h)}" y2="${y(h)}" stroke="#eef0f3"/><text x="${m.l - 6}" y="${y(h) + 3}" font-size="10" text-anchor="end" fill="#64748b">${h.toFixed(0)}</text>`).join('') +
                ticksX.map(q => `<text x="${x(q)}" y="${Hh - m.b + 14}" font-size="10" text-anchor="middle" fill="#64748b">${q.toFixed(q < 10 ? 1 : 0)}</text>`).join('');
            const ult = cs[cs.length - 1];
            // etiquetas directas sin solaparse
            const yInst = y(ult.H) + 3, yProp0 = y(Math.max(0, H0p - kp * Qmax * Qmax)) + 3;
            const yProp = Math.abs(yProp0 - yInst) < 12 ? yInst + 12 : yProp0;
            let yAct = actual ? y(Math.max(0, actual(Qmax))) + 3 : 0;
            [yInst, yProp].forEach(v => { if (actual && Math.abs(yAct - v) < 12) yAct = v + 12; });
            return `<svg viewBox="0 0 ${W} ${Hh}" width="100%" style="max-width:${W}px;font-family:sans-serif">${grid}
                <line x1="${m.l}" x2="${W - m.r}" y1="${y(0)}" y2="${y(0)}" stroke="#94a3b8"/><line x1="${m.l}" x2="${m.l}" y1="${m.t}" y2="${y(0)}" stroke="#94a3b8"/>
                <text x="${(m.l + W - m.r) / 2}" y="${Hh - 4}" font-size="10" text-anchor="middle" fill="#475569">Q por bomba (m³/h)</text>
                <text x="12" y="${(m.t + Hh - m.b) / 2}" font-size="10" text-anchor="middle" fill="#475569" transform="rotate(-90 12 ${(m.t + Hh - m.b) / 2})">H (m c.l.)</text>
                ${inst}
                ${linea(q => H0p - kp * q * q, 'stroke="#eb6834"')}
                ${actual ? linea(actual, 'stroke="#1baf7a" stroke-dasharray="6 4"') : ''}
                <circle cx="${x(d.Qb)}" cy="${y(d.H)}" r="5" fill="#eb6834" stroke="#fff" stroke-width="2"><title>Punto de selección: ${d.Qb.toFixed(2)} m³/h · ${d.H.toFixed(2)} m</title></circle>
                <text x="${W - m.r + 6}" y="${y(ult.H) + 3}" font-size="10" fill="#1e293b">Instalación</text>
                <text x="${W - m.r + 6}" y="${yProp}" font-size="10" fill="#1e293b">Bomba propuesta</text>
                ${actual ? `<text x="${W - m.r + 6}" y="${yAct}" font-size="10" fill="#1e293b">Bomba actual</text>` : ''}
                <text x="${x(d.Qb) + 8}" y="${y(d.H) - 6}" font-size="10" fill="#1e293b">${d.Qb.toFixed(1)} m³/h · ${d.H.toFixed(1)} m</text>
            </svg>`;
        }

        // ==================================================================================
        // LISTADOS (Informe > Listados *.xlsx): líneas, válvulas, materiales, equipos y consumos
        // Librería SheetJS cargada bajo demanda. Si la red está calculada (y sin cambios) se añaden
        // caudales, velocidades y presiones.
        // ==================================================================================
        const URL_XLSX = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
        function cargarXLSX() {
            if (window.XLSX) return Promise.resolve(window.XLSX);
            return new Promise((ok, ko) => {
                const s = document.createElement('script'); s.src = URL_XLSX;
                s.onload = () => window.XLSX ? ok(window.XLSX) : ko(new Error('La librería de Excel no se ha inicializado.'));
                s.onerror = () => ko(new Error('No se ha podido descargar la librería de Excel (SheetJS) desde jsDelivr. Comprueba la conexión a internet.'));
                document.head.appendChild(s);
            });
        }
        
        function generarListados(...a) { return PARTES_OK.informe ? generarListados__p.apply(this, a) : cargarParte('informe').then(() => generarListados__p.apply(this, a)); }

        // ==================================================================================
        // EDICIÓN DEL PLANO: alinear, distribuir, plantillas de conjuntos, notas y leyenda
        // ==================================================================================
        function centroVista() {
            const x = (canvasContainer.scrollLeft + canvasContainer.clientWidth / 2 - offX) / zoomScale;
            const y = (canvasContainer.scrollTop + canvasContainer.clientHeight / 2 - offY) / zoomScale;
            return { x, y: screenAMundoY(y) };
        }
        function alinearSeleccion(modo) {
            const els = elementosRed.filter(e => seleccion.has(e.id));
            if (els.length < 2) { alert('Selecciona al menos dos elementos (Ctrl + clic o ventana).'); return; }
            guardarEstado(); invalidarResultados();
            const cs = els.map(centroElemento);
            if (modo === 'h') { const ym = cs.reduce((s_, c) => s_ + c.y, 0) / cs.length; els.forEach((e, i) => { e.y -= (ym - cs[i].y); }); }
            else if (modo === 'v') { const xm = cs.reduce((s_, c) => s_ + c.x, 0) / cs.length; els.forEach((e, i) => { e.x += xm - cs[i].x; }); }
            else if (modo === 'dh' || modo === 'dv') {
                const k = modo === 'dh' ? 'x' : 'y', orden = els.map((e, i) => ({ e, c: cs[i][k] })).sort((a, b) => a.c - b.c);
                const c0 = orden[0].c, c1 = orden[orden.length - 1].c, paso = (c1 - c0) / (orden.length - 1);
                orden.forEach((o, i) => { const d = c0 + paso * i - o.c; if (k === 'x') o.e.x += d; else o.e.y -= d; });
            }
            actualizarSeleccion();
        }
        const PLANTILLAS_BASE = [
            { nombre: 'Grupo de bomba: aislamiento, filtro, antivibratorios, retención y manómetro', defs: [
                { type: 'valvula', subtype: 'mariposa', name: 'Aislamiento aspiración' }, { type: 'accesorio', subtype: 'filtro', modoK: 'manual', k: 1.5 }, { type: 'accesorio', subtype: 'antivibratorio', modoK: 'manual', k: 0.2 },
                { type: 'bomba', caudal: 20, presion: 3, h0: 3.6, npsh: 2.5, cota: 0 }, { type: 'accesorio', subtype: 'antivibratorio', modoK: 'manual', k: 0.2 },
                { type: 'valvula', subtype: 'retencion' }, { type: 'valvula', subtype: 'mariposa', name: 'Aislamiento descarga' }] },
            { nombre: 'Estación de filtrado con by-pass simple (filtro entre válvulas)', defs: [
                { type: 'valvula', subtype: 'compuerta' }, { type: 'accesorio', subtype: 'filtro', modoK: 'manual', k: 1.5 }, { type: 'valvula', subtype: 'compuerta' }] },
            { nombre: 'Válvula de control con aislamiento (válvula de bola + VCO + bola)', defs: [
                { type: 'valvula', subtype: 'bola' }, { type: 'valvula', subtype: 'control', kvs: 25, apertura: 70, caracteristica: 'iso' }, { type: 'valvula', subtype: 'bola' }] }
        ];
        function plantillasUsuario() { try { return JSON.parse(localStorage.getItem('piping-plantillas') || '[]'); } catch (e) { return []; } }
        function guardarPlantillasUsuario(l) { try { localStorage.setItem('piping-plantillas', JSON.stringify(l)); } catch (e) { alert('No se ha podido guardar la plantilla en este navegador.'); } }
        function puertoEntradaSalida(el) {
            const ps = obtenerPuertosConexion(el);
            if (el.type === 'bomba') return [ps.find(p => p.id === 'succion'), ps.find(p => p.id === 'descarga')];
            return [ps.find(p => p.id === 'a') || ps[0], ps.find(p => p.id === 'b') || ps[ps.length - 1]];
        }
        function insertarPlantilla(pl) {
            guardarEstado(); invalidarResultados();
            document.getElementById('empty-state')?.remove();
            const c = centroVista(), sel = idSeleccionado && elementosRed.find(e => e.id === idSeleccionado);
            const linea = (sel && sel.linea) || (lineas[0] && lineas[0].id) || null, dn = sel && sel.dn;
            const nuevos = [];
            const base = Date.now();
            if (pl.defs) {
                let prev = null;
                pl.defs.forEach((d, i) => {
                    const el = Object.assign({ id: `sym_${base}_${i}`, x: c.x, y: c.y, scale: 1, rotation: 0, name: '' }, JSON.parse(JSON.stringify(d)));
                    if ((el.type === 'valvula' || el.type === 'accesorio') && !el.dn) el.dn = dn && /^DN/.test(dn) ? dn : 'DN 50';
                    if (el.type === 'valvula' && !el.modoK) el.modoK = el.subtype === 'control' ? 'kvs' : 'crane';
                    normalizarElemento(el);
                    if (prev) { const [, pb] = puertoEntradaSalida(prev), [pa] = puertoEntradaSalida(el); el.x += pb.x - pa.x; el.y -= (pb.y - pa.y); }
                    if (linea) el.linea = linea;
                    elementosRed.push(el); asignarNumero(el); nuevos.push(el); prev = el;
                });
            } else if (pl.elementos) {
                pl.elementos.forEach((d, i) => {
                    const el = JSON.parse(JSON.stringify(d)); el.id = `sym_${base}_${i}`; el.x += c.x; el.y += c.y; el.num = null; el.inicioLinea = false;
                    if (linea) el.linea = linea; else delete el.linea;
                    normalizarElemento(el); elementosRed.push(el); asignarNumero(el); nuevos.push(el);
                });
            }
            seleccion.clear(); nuevos.forEach(n => seleccion.add(n.id));
            actualizarSeleccion();
            alert(`Plantilla insertada (${nuevos.length} elementos${linea ? ', línea ' + linea : ''}). Arrastra el grupo hasta su posición; revisa DN y datos de cada elemento.`);
        }
        function guardarSeleccionComoPlantilla() {
            const els = elementosRed.filter(e => seleccion.has(e.id) || (!seleccion.size && e.id === idSeleccionado));
            if (els.length < 2) { alert('Selecciona al menos dos elementos para guardarlos como plantilla.'); return; }
            const nombre = prompt('Nombre de la plantilla:', 'Conjunto ' + (plantillasUsuario().length + 1));
            if (!nombre) return;
            const x0 = Math.min(...els.map(e => e.x)), y0 = Math.max(...els.map(e => e.y));
            const elementos = els.map(e => { const c = JSON.parse(JSON.stringify(e)); c.x -= x0; c.y -= y0; delete c.estado; delete c.esLineaCritica; delete c.linea; return c; });
            const l = plantillasUsuario().filter(p => p.nombre !== nombre); l.push({ nombre, elementos }); guardarPlantillasUsuario(l);
            alert(`Plantilla "${nombre}" guardada en este navegador (Insertar > Plantilla).`);
        }
        function borrarPlantilla(nombre) { if (confirm(`¿Eliminar la plantilla "${nombre}"?`)) guardarPlantillasUsuario(plantillasUsuario().filter(p => p.nombre !== nombre)); }
        function insertarAnotacion(sub) {
            if (sub === 'leyenda') { colocarLeyenda(); return; }
            if (sub === 'materiales') { const c = centroVista(); insertarListado(c.x, mundoAScreenY(c.y)); return; }
            guardarEstado();
            const c = centroVista();
            const el = { id: 'sym_' + Date.now(), type: 'anotacion', subtype: sub, x: c.x, y: c.y, scale: 1, rotation: 0, name: '', texto: sub === 'nota' ? 'Nota' : undefined };
            normalizarElemento(el); elementosRed.push(el); asignarNumero(el);
            document.getElementById('empty-state')?.remove();
            seleccionarElemento(el.id);
        }

        // ==================================================================================
        // CONTROL DE REVISIONES: se registra la revisión actual (con una copia de la red) y se compara
        // con la anterior; el informe incluye el historial y los cambios.
        // ==================================================================================
        function siguienteRevision(r) { if (/^\d+$/.test(r)) return String(+r + 1); if (/^[A-Y]$/i.test(r)) return String.fromCharCode(r.toUpperCase().charCodeAt(0) + 1); return r + '.1'; }
        function registrarRevision() {
            const desc = prompt(`Descripción de la revisión ${proyecto.revision || '0'}:`, (proyecto.revisiones || []).length ? 'Modificación' : 'Emisión inicial');
            if (desc == null) return;
            proyecto.revisiones = proyecto.revisiones || [];
            proyecto.revisiones.push({ rev: proyecto.revision || '0', fecha: new Date().toISOString().slice(0, 10), autor: proyecto.autor || '', descripcion: desc,
                red: JSON.stringify({ e: elementosRed.map(e => { const c = Object.assign({}, e); delete c.estado; delete c.esLineaCritica; return c; }), l: lineas }),
                hojas: (sincronizarHoja(), hojas.map(h => ({ id: h.id, e: (h.e || []).map(e => { const c = Object.assign({}, e); delete c.estado; delete c.esLineaCritica; return c; }) }))) });
            proyecto.revision = siguienteRevision(proyecto.revision || '0');
            marcarCambios(true);
            if (document.getElementById('modal-proyecto').style.display === 'flex') abrirDatosProyecto(alGuardarProyecto);
            alert(`Revisión registrada. La revisión en curso pasa a ser la ${proyecto.revision}.`);
        }
        const CAMPOS_DIFF = ['material', 'serie', 'dn', 'dnMenor', 'longitud', 'cotaA', 'cotaB', 'cota', 'pn', 'modoK', 'craneTipo', 'k', 'cvUsuario', 'kvs', 'apertura', 'caudal', 'presion', 'h0', 'npsh', 'qNom', 'dpNom', 'qCons', 'pMin', 'cotaLamina', 'presionDep', 'aislamiento', 'linea', 'reservaDe'];

        // ==================================================================================
        // IMPORTACIÓN: líneas desde Excel y DXF de referencia como fondo del plano
        // ==================================================================================
        async function descargarPlantillaExcel() {
            try {
                const X = await cargarXLSX(), wb = X.utils.book_new();
                const ws = X.utils.aoa_to_sheet([['Línea', 'Nombre', 'Material', 'Serie', 'DN', 'Longitud (mm)', 'Cota a (m)', 'Cota b (m)'],
                    ['P01', 'Agua de refrigeración', 'Acero al carbono', '40', 'DN 80', 3000, 0, 0], ['P01', '', 'Acero al carbono', '40', 'DN 80', 6000, 0, 2], ['R01', 'Ramal 1', 'PE100', 'SDR 11 (PN16)', 'd63', 4000, 2, 2]]);
                ws['!cols'] = [8, 24, 18, 14, 8, 14, 10, 10].map(w => ({ wch: w }));
                X.utils.book_append_sheet(wb, ws, 'Líneas');
                const X2 = X.utils.aoa_to_sheet([['Materiales y series válidos'], ...Object.entries(CAT.materiales).map(([m, d]) => [m, d.series.join(' | ')])]);
                X.utils.book_append_sheet(wb, X2, 'Materiales');
                const buf = X.write(wb, { type: 'array', bookType: 'xlsx' }), blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
                const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = 'Plantilla_lineas_PIPING.xlsx'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000);
            } catch (e) { alert(e.message); }
        }
        function importarExcel(...a) { return PARTES_OK.cad ? importarExcel__p.apply(this, a) : cargarParte('cad').then(() => importarExcel__p.apply(this, a)); }
        // DXF → SVG simple (LINE, LWPOLYLINE, POLYLINE/VERTEX, CIRCLE, ARC, TEXT, MTEXT), escalado a la hoja A3
        function dxfASVG(texto) {
            const l = texto.split(/\r?\n/), pares = [];
            for (let i = 0; i + 1 < l.length; i += 2) pares.push([+l[i].trim(), l[i + 1].trim()]);
            let i = pares.findIndex((p, k) => p[0] === 2 && p[1] === 'ENTITIES' && pares[k - 1] && pares[k - 1][1] === 'SECTION');
            if (i < 0) throw new Error('El DXF no tiene sección ENTITIES.');
            const ents = []; let cur = null;
            for (i++; i < pares.length; i++) {
                const [c, v] = pares[i];
                if (c === 0) { if (cur) ents.push(cur); if (v === 'ENDSEC') { cur = null; break; } cur = { t: v, g: [] }; }
                else if (cur) cur.g.push([c, v]);
            }
            const get = (e, c) => { const x = e.g.find(p => p[0] === c); return x ? x[1] : null; }, num = (e, c, d = 0) => { const x = get(e, c); return x == null ? d : parseFloat(x); };
            const geo = []; let poly = null;
            ents.forEach(e => {
                if (e.t === 'LINE') geo.push({ t: 'l', p: [[num(e, 10), num(e, 20)], [num(e, 11), num(e, 21)]] });
                else if (e.t === 'LWPOLYLINE') { const xs = e.g.filter(p => p[0] === 10).map(p => +p[1]), ys = e.g.filter(p => p[0] === 20).map(p => +p[1]); geo.push({ t: 'l', p: xs.map((x, k) => [x, ys[k]]), c: (num(e, 70) & 1) === 1 }); }
                else if (e.t === 'POLYLINE') poly = { t: 'l', p: [], c: (num(e, 70) & 1) === 1 };
                else if (e.t === 'VERTEX' && poly) poly.p.push([num(e, 10), num(e, 20)]);
                else if (e.t === 'SEQEND' && poly) { geo.push(poly); poly = null; }
                else if (e.t === 'CIRCLE') geo.push({ t: 'c', x: num(e, 10), y: num(e, 20), r: num(e, 40) });
                else if (e.t === 'ARC') geo.push({ t: 'a', x: num(e, 10), y: num(e, 20), r: num(e, 40), a0: num(e, 50), a1: num(e, 51) });
                else if (e.t === 'TEXT' || e.t === 'MTEXT') geo.push({ t: 't', x: num(e, 10), y: num(e, 20), h: num(e, 40, 2.5), s: (get(e, 1) || '').replace(/\\P/g, ' ').replace(/\{|\}|\\[A-Za-z][^;]*;/g, ''), r: num(e, 50) });
            });
            if (!geo.length) throw new Error('No hay entidades de dibujo reconocibles (LINE, POLYLINE, CIRCLE, ARC, TEXT).');
            const pts = geo.flatMap(g => g.t === 'l' ? g.p : g.t === 't' ? [[g.x, g.y]] : [[g.x - g.r, g.y - g.r], [g.x + g.r, g.y + g.r]]);
            const x0 = Math.min(...pts.map(p => p[0])), x1 = Math.max(...pts.map(p => p[0])), y0 = Math.min(...pts.map(p => p[1])), y1 = Math.max(...pts.map(p => p[1]));
            const k = Math.min((ANCHO_A3 - 60) / Math.max(x1 - x0, 1e-9), (ALTO_A3 - 60) / Math.max(y1 - y0, 1e-9)), X = x => 30 + (x - x0) * k, Y = y => 30 + (y1 - y) * k;
            const out = geo.map(g => {
                if (g.t === 'l') return `<polyline points="${g.p.map(p => X(p[0]).toFixed(1) + ',' + Y(p[1]).toFixed(1)).join(' ')}${g.c ? ' ' + X(g.p[0][0]).toFixed(1) + ',' + Y(g.p[0][1]).toFixed(1) : ''}" fill="none"/>`;
                if (g.t === 'c') return `<circle cx="${X(g.x).toFixed(1)}" cy="${Y(g.y).toFixed(1)}" r="${(g.r * k).toFixed(1)}" fill="none"/>`;
                if (g.t === 'a') { const a0 = g.a0 * Math.PI / 180, a1 = g.a1 * Math.PI / 180, sx = X(g.x + g.r * Math.cos(a0)), sy = Y(g.y + g.r * Math.sin(a0)), ex = X(g.x + g.r * Math.cos(a1)), ey = Y(g.y + g.r * Math.sin(a1)); let da = g.a1 - g.a0; if (da < 0) da += 360; return `<path d="M ${sx.toFixed(1)} ${sy.toFixed(1)} A ${(g.r * k).toFixed(1)} ${(g.r * k).toFixed(1)} 0 ${da > 180 ? 1 : 0} 0 ${ex.toFixed(1)} ${ey.toFixed(1)}" fill="none"/>`; }
                return `<text x="${X(g.x).toFixed(1)}" y="${Y(g.y).toFixed(1)}" font-size="${Math.max(g.h * k, 2).toFixed(1)}" font-family="sans-serif" transform="rotate(${-g.r} ${X(g.x).toFixed(1)} ${Y(g.y).toFixed(1)})" stroke="none">${esc(g.s)}</text>`;
            }).join('');
            return { svg: out, n: geo.length, escala: k };
        }
        function importarDXFFondo() {
            const input = document.createElement('input'); input.type = 'file'; input.accept = '.dxf';
            input.onchange = ev => {
                const f = ev.target.files[0]; if (!f) return;
                const rd = new FileReader();
                rd.onload = () => {
                    try {
                        const r = dxfASVG(rd.result);
                        proyecto.fondo = { svg: r.svg, nombre: f.name, visible: true, opacidad: 0.35 };
                        marcarCambios(true); renderizarVectorial(); zoomTodo();
                        alert(`DXF de referencia cargado como fondo: ${r.n} entidades (${f.name}). Se ha encajado en la hoja A3; está bloqueado y no interviene en el cálculo.\nVista > Fondo DXF para ocultarlo o quitarlo.`);
                    } catch (e) { alert('No se ha podido leer el DXF: ' + e.message); }
                };
                rd.readAsText(f);
            };
            input.click();
        }
        // ==================================================================================
        // CONTROL DE CAMBIOS SIN GUARDAR
        // guardarEstado() (se llama antes de cualquier modificación) marca el proyecto como
        // modificado; guardar en *.pid, Nuevo o Abrir lo dejan limpio. Si se cierra o recarga la
        // pestaña con cambios pendientes, el navegador pide confirmación.
        // ==================================================================================
        let hayCambiosSinGuardar = false;
        const TITULO_BASE = document.title;
        function marcarCambios(modificado = true) {
            hayCambiosSinGuardar = modificado;
            document.title = (modificado ? '* ' : '') + TITULO_BASE;
            programarAutoguardado();
            if (typeof actualizarPanelDiseno === 'function') actualizarPanelDiseno();
        }
        // ---------- Último proyecto de trabajo ----------
        // Se guarda en el navegador en cada cambio (y al guardar/abrir). Al arrancar se abre siempre el
        // último proyecto en el que se estaba trabajando; si no hay ninguno se piden los datos del proyecto.
        const CLAVE_ULTIMO = 'piping-ultimo-proyecto';
        const CLAVE_AUTOGUARDADO = 'piping-autoguardado'; // versiones ≤ 7.1
        let temporizadorAutoguardado = null;
        function programarAutoguardado() { clearTimeout(temporizadorAutoguardado); temporizadorAutoguardado = setTimeout(guardarUltimo, 1500); }
        function guardarUltimo() {
            if (!proyecto.numero && !elementosRed.length) return;
            try { localStorage.setItem(CLAVE_ULTIMO, JSON.stringify({ fecha: new Date().toISOString(), numero: proyecto.numero || '', archivo: nombreArchivoActual || '', guardado: !hayCambiosSinGuardar, n: elementosRed.length, contenido: generarContenido('pid') })); } catch (e) { /* almacenamiento no disponible */ }
        }
        const autoguardar = guardarUltimo;
        setInterval(() => { if (hayCambiosSinGuardar) guardarUltimo(); }, 30000);
        function abrirUltimoProyecto() {
            let u = null;
            u = leerUltimoGuardado();
            if (u && u.contenido) {
                try {
                    const avisos = cargarProyectoDesdeTexto(u.contenido);
                    nombreArchivoActual = u.archivo || '';
                    historialUndo = []; historialRedo = []; actualizarBotonesHistorial();
                    marcarCambios(u.guardado !== true);
                    ajustarVistaVentana();
                    aviso(`Abierto el último proyecto: ${u.numero || 'sin número'}${u.archivo ? ' (' + u.archivo + ')' : ''} · ${new Date(u.fecha).toLocaleString('es-ES')}${hayCambiosSinGuardar ? ' · con cambios sin guardar en archivo' : ''}`);
                    if (avisos.length) console.info(avisos.join('\n'));
                    try { localStorage.removeItem(CLAVE_AUTOGUARDADO); } catch (e) { }
                } catch (e) { console.error(e); aviso('No se ha podido abrir el último proyecto guardado en el navegador.', 'error'); }
            }
            if (!proyecto.numero) { pantallaInicio(); return; }
            if (!proyectoDefinido()) abrirDatosProyecto(null, { obligatorio: true });
            else { aplicarFluidoProyecto(); ofrecerTutorial(); }
        }
        const ofrecerRecuperacion = abrirUltimoProyecto; // compatibilidad
        window.addEventListener('beforeunload', function(e) {
            if (!hayCambiosSinGuardar) return;
            e.preventDefault();
            e.returnValue = ''; // el navegador muestra su propio aviso de "cambios sin guardar"
        });
        document.getElementById('selector-fluido')?.addEventListener('change', () => marcarCambios(true));

        // ==================================================================================
        // PORTAPAPELES INTERNO (Copiar / Cortar / Pegar)
        // ==================================================================================
        let portapapeles = null; // lista de elementos copiados
        let contadorPegado = 0;
        // R: gira la selección 45° en sentido horario; Mayús+R, 45° en sentido antihorario
        function girar45(inc) {
            const ids = idsSeleccion().filter(id => !esTablaHoja(elementosRed.find(e => e.id === id)));
            if (!ids.length) return;
            if (ids.length > 1) { girarSeleccion(inc); renderizarVectorial(); return; }
            const el = elementosRed.find(e => e.id === ids[0]); if (!el) return;
            guardarEstado(); if (!esAnotacion(el)) invalidarResultados();
            girarElemento(el, inc); renderizarVectorial(); seleccionarElemento(el.id);
        }
        const idsSeleccion = () => seleccion.size ? [...seleccion] : (idSeleccionado ? [idSeleccionado] : []);
        const haySeleccion = () => idsSeleccion().length > 0;

        function copiarSeleccion() {
            const ids = idsSeleccion();
            if (!ids.length) return;
            portapapeles = elementosRed.filter(e => ids.includes(e.id)).map(e => JSON.parse(JSON.stringify(e)));
            contadorPegado = 0; // cada pegado se desplaza 50 px respecto al original
        }

        function cortarSeleccion() {
            if (!haySeleccion()) return;
            copiarSeleccion();
            contadorPegado = -1; // el primer pegado tras Cortar vuelve a la posición original
            eliminarSeleccion();
        }

        function pegarPortapapeles() {
            if (!portapapeles || !portapapeles.length) return;
            guardarEstado();
            contadorPegado++;
            invalidarResultados();
            document.getElementById("empty-state")?.remove();
            seleccion.clear();
            const nuevos = portapapeles.map((orig, i) => {
                const nuevo = JSON.parse(JSON.stringify(orig));
                nuevo.id = 'sym_' + Date.now() + '_' + i + '_' + Math.floor(Math.random() * 1000);
                nuevo.num = null; nuevo.inicioLinea = false;
                if (nuevo.linea && !lineaPorId(nuevo.linea)) delete nuevo.linea;
                nuevo.x += 50 * contadorPegado;
                nuevo.y -= 50 * contadorPegado;
                elementosRed.push(nuevo); asignarNumero(nuevo);
                return nuevo;
            });
            if (nuevos.length === 1) seleccionarElemento(nuevos[0].id);
            else { nuevos.forEach(n => seleccion.add(n.id)); actualizarSeleccion(); }
        }

        // ---------- Selección múltiple ----------
        function actualizarSeleccion() {
            if (seleccion.size === 1) { const id = [...seleccion][0]; seleccion.clear(); seleccionarElemento(id); return; }
            if (!seleccion.size) { limpiarSeleccion(); return; }
            idSeleccionado = null;
            renderizarVectorial();
            document.getElementById('lbl-tipo-activo').innerText = 'SELECCIÓN';
            const els = elementosRed.filter(e => seleccion.has(e.id));
            const L = els.filter(e => e.type === 'tuberia').reduce((s, e) => s + e.longitud / 1000, 0);
            document.getElementById('panel-propiedades').innerHTML = `
                <div class="font-bold text-slate-700 mb-1">${els.length} elementos seleccionados</div>
                ${info(`${[...new Set(els.map(e => nombreTipo(e)))].slice(0, 6).join(', ')}${L ? `<br>Tubería: ${fmt(L, 2)} m` : ''}<br>Arrastra cualquiera de ellos para mover el grupo.`)}
                <div class="grid grid-cols-2 gap-1 mt-2">
                    <button onclick="girarSeleccion(90)" class="border rounded p-1 hover:bg-slate-50"><i class="fa-solid fa-rotate-right text-emerald-600 mr-1"></i>Girar 90°</button>
                    <button onclick="girarSeleccion(180)" class="border rounded p-1 hover:bg-slate-50"><i class="fa-solid fa-rotate text-emerald-600 mr-1"></i>Girar 180°</button>
                    <button onclick="copiarSeleccion()" class="border rounded p-1 hover:bg-slate-50"><i class="fa-solid fa-copy text-blue-600 mr-1"></i>Copiar</button>
                    <button onclick="eliminarSeleccion()" class="border rounded p-1 hover:bg-rose-50 text-rose-600"><i class="fa-solid fa-trash-can mr-1"></i>Eliminar</button>
                </div>`;
        }
        function limpiarSeleccion() {
            seleccion.clear(); idSeleccionado = null;
            renderizarVectorial();
            document.getElementById('lbl-tipo-activo').innerText = 'Ninguno';
            document.getElementById('panel-propiedades').innerHTML = `<p class="text-slate-400 italic text-[10px]">Selecciona un elemento.</p>`;
        }
        function seleccionarTodo() { seleccion.clear(); elementosRed.forEach(e => seleccion.add(e.id)); actualizarSeleccion(); }
        function seleccionarLinea(id) { seleccion.clear(); elementosRed.filter(e => e.linea === id).forEach(e => seleccion.add(e.id)); actualizarSeleccion(); }
        function eliminarSeleccion() {
            const ids = idsSeleccion();
            if (!ids.length) return;
            if (ids.length === 1) { eliminarElemento(ids[0]); return; }
            guardarEstado(); invalidarResultados();
            elementosRed = elementosRed.filter(e => !ids.includes(e.id));
            limpiarSeleccion();
        }
        // Giro rígido del grupo alrededor de su centro (cada elemento gira sobre su pivote y se recoloca)
        function girarSeleccion(inc) {
            const ids = idsSeleccion();
            if (!ids.length) return;
            guardarEstado(); invalidarResultados();
            const els = elementosRed.filter(e => ids.includes(e.id));
            const piv = els.map(e => ({ x: e.x + 25, y: mundoAScreenY(e.y) + 25 }));
            const cx = piv.reduce((s, p) => s + p.x, 0) / piv.length, cy = piv.reduce((s, p) => s + p.y, 0) / piv.length;
            const r = inc * Math.PI / 180, c = Math.cos(r), sn = Math.sin(r);
            els.forEach((e, i) => {
                const dx = piv[i].x - cx, dy = piv[i].y - cy;
                const nx = cx + dx * c - dy * sn, ny = cy + dx * sn + dy * c;
                e.x = nx - 25; e.y = screenAMundoY(ny - 25);
                e.rotation = (((e.rotation || 0) + inc) % 360 + 360) % 360;
            });
            if (els.length === 1) seleccionarElemento(els[0].id); else actualizarSeleccion();
        }

        // ==================================================================================
        // BÚSQUEDA / REEMPLAZO (sobre el nombre de los elementos)
        // ==================================================================================
        function abrirBuscarReemplazar() {
            const panel = document.getElementById('panel-buscar');
            panel.style.display = 'block';
            const inp = document.getElementById('buscar-texto');
            inp.focus(); inp.select();
            document.getElementById('buscar-estado').innerText = '';
        }
        function cerrarBuscarReemplazar() { document.getElementById('panel-buscar').style.display = 'none'; }
        function estadoBusqueda(txt) { document.getElementById('buscar-estado').innerText = txt; }

        function regexBusqueda() {
            const txt = document.getElementById('buscar-texto').value;
            if (!txt) return null;
            const mayus = document.getElementById('buscar-mayus').checked;
            return new RegExp(txt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), mayus ? 'g' : 'gi');
        }
        function coincidenciasBusqueda() {
            const re = regexBusqueda();
            if (!re) return [];
            return elementosRed.filter(el => { re.lastIndex = 0; return re.test(String(el.name || '')); });
        }

        function buscarSiguiente() {
            const res = coincidenciasBusqueda();
            if (!regexBusqueda()) { estadoBusqueda('Escribe el texto a buscar.'); return; }
            if (!res.length) { estadoBusqueda('Sin coincidencias.'); return; }
            let i = res.findIndex(el => el.id === idSeleccionado);
            i = (i + 1) % res.length;
            const el = res[i];
            seleccionarElemento(el.id);
            centrarVistaEnPunto(el.x + 25, mundoAScreenY(el.y) + 25);
            estadoBusqueda(`${i + 1} de ${res.length}: ${el.name}`);
        }

        function reemplazarActual() {
            const re = regexBusqueda();
            if (!re) { estadoBusqueda('Escribe el texto a buscar.'); return; }
            const el = elementosRed.find(item => item.id === idSeleccionado);
            re.lastIndex = 0;
            if (!el || !re.test(String(el.name || ''))) { buscarSiguiente(); return; }
            guardarEstado();
            re.lastIndex = 0;
            el.name = String(el.name).replace(re, document.getElementById('reemplazar-texto').value);
            seleccionarElemento(el.id);
            buscarSiguiente();
        }

        function reemplazarTodo() {
            const re = regexBusqueda();
            if (!re) { estadoBusqueda('Escribe el texto a buscar.'); return; }
            const res = coincidenciasBusqueda();
            if (!res.length) { estadoBusqueda('Sin coincidencias.'); return; }
            guardarEstado();
            const nuevoTxt = document.getElementById('reemplazar-texto').value;
            res.forEach(el => { re.lastIndex = 0; el.name = String(el.name).replace(re, nuevoTxt); });
            if (idSeleccionado) seleccionarElemento(idSeleccionado); else renderizarVectorial();
            estadoBusqueda(`${res.length} elemento(s) modificados.`);
        }

        document.getElementById('buscar-texto').addEventListener('keydown', e => {
            if (e.key === 'Enter') { e.preventDefault(); buscarSiguiente(); }
        });
        document.getElementById('panel-buscar').addEventListener('keydown', e => {
            if (e.key === 'Escape') cerrarBuscarReemplazar();
        });

        // ==================================================================================
        // LIBRERÍAS / ZOOM / AYUDA
        // ==================================================================================
        function mostrarLibreriaAccesorios() {
            const lista = document.getElementById('lista-accesorios');
            libAbierta = 'accesorios'; pintarAcordeon();
            const caja = lista.parentElement;
            caja.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            caja.style.outline = '2px solid #60a5fa';
            setTimeout(() => { caja.style.outline = ''; }, 1200);
        }

        // Zoom Todo: muestra la hoja A3 completa
        function zoomTodo() { irAOrigenEnEsquina(); }

        function activarZoomVentana() {
            modoZoomVentana = true;
            canvasContainer.style.cursor = 'crosshair';
        }

        function mostrarCreditos() { document.getElementById('version-catalogo').innerText = CAT ? CAT.version + ' · ' + (window.CATALOGO_ORIGEN || '') : 'no cargado'; document.getElementById('modal-creditos').style.display = 'flex'; }
        function cerrarCreditos() { document.getElementById('modal-creditos').style.display = 'none'; }

        // ==================================================================================
        // BARRA DE MENÚS (estilo Paint)
        // Para añadir opciones a un menú, añade objetos a su lista "items":
        //   { icono: 'fa-...', texto: '...', atajo: 'Ctrl+?', accion: () => ..., habilitado: () => true }
        //   'sep' dibuja un separador; "sub: [ ... ]" crea un submenú desplegable.
        // Los atajos de teclado se programan aparte, en atajosMenu().
        // ==================================================================================
        // ==================================================================================
        // SUPABASE: proyecto wuarkraddnndmgvfnkmm. Solo se necesita la clave pública "anon" (Project
        // Settings > API); nunca la service_role. El catálogo se lee de la vista v_catalogo, que devuelve el
        // mismo JSON que catalogo.js, y se guarda en el navegador para el siguiente arranque.
        // ==================================================================================
        const SUPABASE_URL = 'https://wuarkraddnndmgvfnkmm.supabase.co';
        // clave pública «anon» del proyecto (Supabase > Project Settings > API > anon public): con ella dentro nadie tiene que pegarla
        const SUPABASE_ANON = '';
        const claveSupabase = () => { try { return localStorage.getItem('piping-supabase-clave') || SUPABASE_ANON; } catch (e) { return SUPABASE_ANON; } };
        function configurarSupabase() {
            const actual = claveSupabase();
            const k = prompt(`Proyecto Supabase: ${SUPABASE_URL}\n\nPega la clave pública "anon" (Supabase > Project Settings > API > anon public).\nNo uses la clave service_role.\n\nDeja vacío para desconectar.`, actual);
            if (k == null) return;
            const v = k.trim();
            let rol = ''; try { rol = JSON.parse(atob((v.split('.')[1] || '').replace(/-/g, '+').replace(/_/g, '/'))).role || ''; } catch (e) { rol = ''; }
            if (v && rol === 'service_role') { aviso('Esa es la clave service_role: no debe usarse en el navegador. Usa la clave anon.', 'error'); return; }
            try { if (v) localStorage.setItem('piping-supabase-clave', v); else localStorage.removeItem('piping-supabase-clave'); } catch (e) { }
            if (v) sincronizarCatalogoSupabase(true); else aviso('Supabase desconectado: se usa catalogo.js.');
        }
        async function sincronizarCatalogoSupabase(manual) {
            const k = claveSupabase();
            if (!k) { if (manual) configurarSupabase(); return; }
            try {
                const r = await fetch(`${SUPABASE_URL}/rest/v1/v_catalogo?select=catalogo`, { headers: { apikey: k, Authorization: 'Bearer ' + k } });
                if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`);
                const d = await r.json(), cat = d && d[0] && d[0].catalogo;
                if (!cat || !cat.version || !cat.materiales || !cat.fluidos) throw new Error('La vista v_catalogo no devuelve un catálogo completo (¿se han ejecutado 01, 02 y 03 en el SQL Editor?).');
                const nuevo = !CAT || String(cat.version) !== String(CAT.version) || !/^Supabase/.test(window.CATALOGO_ORIGEN);
                localStorage.setItem('piping-catalogo-supabase', JSON.stringify({ fecha: new Date().toISOString(), catalogo: cat }));
                if (nuevo) { if (confirm(`Catálogo ${cat.version} descargado de Supabase (${Object.keys(cat.fluidos).length} fluidos, ${Object.keys(cat.materiales).length} materiales, ${cat.valvulas.length} válvulas).\n\nSe aplica al recargar la página. ¿Recargar ahora? (el proyecto se reabre solo)`)) { guardarUltimo(); location.reload(); } }
                else if (manual) aviso(`Catálogo al día: ${cat.version} (Supabase).`, 'ok');
            } catch (e) { if (manual) aviso('No se ha podido leer el catálogo de Supabase: ' + e.message, 'error'); else console.warn('Supabase:', e.message); }
        }
        function usarCatalogoLocal() {
            try { localStorage.removeItem('piping-catalogo-supabase'); } catch (e) { }
            if (confirm('Se usará catalogo.js. ¿Recargar ahora?')) { guardarUltimo(); location.reload(); }
        }
        setTimeout(() => sincronizarCatalogoSupabase(false), 2500);

        const MENUS = [
            { titulo: 'Archivo', items: [
                { icono: 'fa-file', texto: 'Nuevo proyecto...', atajo: 'Ctrl+N', accion: () => nuevoProyecto() },
                { icono: 'fa-folder-open', texto: 'Proyecto existente...', atajo: 'Ctrl+O', accion: () => proyectoExistente() },
                { icono: 'fa-floppy-disk', texto: 'Guardar', atajo: 'Ctrl+G', accion: () => guardarProyecto() },
                { icono: 'fa-file-export', texto: 'Guardar como', sub: [
                    { icono: 'fa-file-code', texto: 'Proyecto P&ID (*.pid)', accion: () => guardarComoProyecto('pid') },
                    { icono: 'fa-compass-drafting', texto: 'Dibujo CAD (*.dxf, capas normalizadas)', accion: () => guardarComoProyecto('dxf') },
                    { icono: 'fa-file-lines', texto: 'Datos JSON (*.json)', accion: () => guardarComoProyecto('json') },
                    { icono: 'fa-file-code', texto: 'Datos XML (*.xml)', accion: () => guardarComoProyecto('xml') },
                    { icono: 'fa-bezier-curve', texto: 'Imagen vectorial (*.svg)', accion: () => guardarComoProyecto('svg') },
                    { icono: 'fa-file-image', texto: 'Imagen (*.png)', accion: () => guardarComoProyecto('png') },
                    { icono: 'fa-file-pdf', texto: 'PDF vectorial con capas (*.pdf)', accion: () => exportarPDFCapas() }
                ]},
                'sep',
                { icono: 'fa-id-card', texto: 'Datos del proyecto...', accion: () => abrirDatosProyecto() },
                { icono: 'fa-code-compare', texto: 'Registrar revisión...', accion: () => registrarRevision() },
                { icono: 'fa-list-check', texto: 'Comprobar antes de emitir...', accion: () => comprobarAntesDeEmitir() },
                { icono: 'fa-code-compare', texto: 'Comparar con revisión...', accion: () => abrirComparacion() },
                { icono: 'fa-building', texto: 'Plantilla de cliente', sub: () => submenuPlantillasCliente() },
                { icono: 'fa-clock-rotate-left', texto: 'Recuperar copia de seguridad...', accion: () => recuperarCopia() },
                { icono: 'fa-cloud', texto: 'Nube (equipo)', sub: () => submenuNube() },
                'sep',
                { icono: 'fa-file-import', texto: 'Importar', sub: [
                    { icono: 'fa-file-excel', texto: 'Líneas desde Excel (*.xlsx)...', accion: () => importarExcel() },
                    { icono: 'fa-file-arrow-down', texto: 'Descargar plantilla Excel de líneas', accion: () => descargarPlantillaExcel() },
                    { icono: 'fa-diagram-project', texto: 'Líneas y equipos desde Excel (esquema base)...', accion: () => importarLineasEquipos() },
                    { icono: 'fa-file-arrow-down', texto: 'Descargar plantilla Excel de líneas y equipos', accion: () => descargarPlantillaLineasEquipos() },
                    { icono: 'fa-compass-drafting', texto: 'DXF de referencia como fondo...', accion: () => importarDXFFondo() }
                ]},
                'sep',
                { icono: 'fa-print', texto: 'Imprimir...', atajo: 'Ctrl+P', accion: () => abrirImpresion() }
            ]},
            { titulo: 'Edición', items: [
                { icono: 'fa-magnifying-glass', texto: 'Búsqueda/Reemplazo...', atajo: 'Ctrl+R', accion: () => abrirBuscarReemplazar() },
                { icono: 'fa-repeat', get texto() { return 'Repetir' + (typeof ultimaOrden !== 'undefined' && ultimaOrden ? ': ' + textoUltimaOrden() : ' la última orden'); }, atajo: 'Intro / Espacio', accion: () => repetirUltimaOrden() },
                { icono: 'fa-terminal', texto: 'Paleta de comandos...', atajo: 'Ctrl+K', accion: () => abrirPaleta() },
                { icono: 'fa-table-cells-large', texto: 'Tabla de propiedades...', accion: () => abrirTablaPropiedades() },
                'sep',
                { icono: 'fa-copy', texto: 'Copiar', atajo: 'Ctrl+C', accion: () => copiarSeleccion(), habilitado: () => haySeleccion() },
                { icono: 'fa-scissors', texto: 'Cortar', atajo: 'Ctrl+X', accion: () => cortarSeleccion(), habilitado: () => haySeleccion() },
                { icono: 'fa-paste', texto: 'Pegar', atajo: 'Ctrl+V', accion: () => pegarPortapapeles(), habilitado: () => !!(portapapeles && portapapeles.length) },
                { icono: 'fa-trash-can', texto: 'Eliminar selección', atajo: 'Supr / B', accion: () => eliminarSeleccion(), habilitado: () => haySeleccion() },
                'sep',
                { icono: 'fa-clone', texto: 'Duplicar línea', sub: () => lineas.length ? lineas.map(l => ({ icono: l.tipo === 'principal' ? 'fa-diagram-project' : 'fa-code-branch', texto: l.id + (l.nombre ? ' · ' + l.nombre : ''), accion: () => duplicarLinea(l.id) })) : [{ icono: 'fa-circle-info', texto: 'No hay líneas', accion: () => {} }] },
                { icono: 'fa-arrows-left-right', texto: 'Simetría izquierda ↔ derecha', accion: () => simetriaSeleccion('v'), habilitado: () => haySeleccion() },
                { icono: 'fa-arrows-up-down', texto: 'Simetría arriba ↔ abajo', accion: () => simetriaSeleccion('h'), habilitado: () => haySeleccion() },
                { icono: 'fa-table-cells', texto: 'Matriz (copias con separación)...', accion: () => matrizSeleccion(), habilitado: () => haySeleccion() },
                'sep',
                { icono: 'fa-rotate-left', texto: 'Deshacer', atajo: 'Ctrl+Z', accion: () => deshacer(), habilitado: () => historialUndo.length > 0 },
                { icono: 'fa-rotate-right', texto: 'Rehacer', atajo: 'Ctrl+Y', accion: () => rehacer(), habilitado: () => historialRedo.length > 0 }
            ]},
            { titulo: 'Librerías', get items() { return menuLibreria(); } },
            { titulo: 'Cálculo', items: [
                { icono: 'fa-calculator', texto: 'Calcular red...', accion: () => calcularRed() },
                { icono: 'fa-layer-group', texto: 'Calcular proyecto completo (todas las hojas)', accion: () => calcularProyectoCompleto() },
                { icono: 'fa-scale-balanced', texto: 'Escenarios A / B', sub: () => [
                    { icono: 'fa-a', texto: 'Guardar el cálculo como escenario A' + (proyecto.escenarios && proyecto.escenarios.A ? ' (' + proyecto.escenarios.A.nombre + ')' : ''), accion: () => guardarEscenario('A') },
                    { icono: 'fa-b', texto: 'Guardar el cálculo como escenario B' + (proyecto.escenarios && proyecto.escenarios.B ? ' (' + proyecto.escenarios.B.nombre + ')' : ''), accion: () => guardarEscenario('B') },
                    { icono: 'fa-table', texto: 'Comparar A / B...', accion: () => compararEscenarios() }] },
                { icono: 'fa-chart-area', texto: 'Perfil hidráulico de la ruta crítica...', accion: () => perfilRutaCritica() },
                { icono: 'fa-chart-line', texto: 'Curva de la bomba y de la red...', accion: () => curvaBombaRed() },
                { icono: 'fa-certificate', texto: 'Validación PED por línea...', accion: () => validacionPED() },
                { icono: 'fa-people-arrows', texto: 'Escenario de bombas', sub: () => [
                    { icono: escenarioBombas === 'normal' ? 'fa-check' : 'fa-square', texto: 'Normal (bombas de servicio)', accion: () => cambiarEscenario('normal') },
                    { icono: escenarioBombas === 'reserva' ? 'fa-check' : 'fa-square', texto: 'Reserva en marcha (sustituye a su bomba de servicio)', accion: () => cambiarEscenario('reserva') }] },
                { icono: 'fa-bolt', texto: 'Cálculo automático al editar', sub: () => [{ icono: opciones.calculoAuto ? 'fa-check' : 'fa-square', texto: 'Activado', accion: () => { if (!opciones.calculoAuto) alternarCalculoAuto(); } }, { icono: !opciones.calculoAuto ? 'fa-check' : 'fa-square', texto: 'Desactivado', accion: () => { if (opciones.calculoAuto) alternarCalculoAuto(); } }] }
            ]},
            { titulo: 'Seleccionar', items: [
                { icono: 'fa-object-group', texto: 'Todo', atajo: 'Ctrl+A', accion: () => seleccionarTodo() },
                { icono: 'fa-object-ungroup', texto: 'Nada', atajo: 'Esc', accion: () => limpiarSeleccion() },
                { icono: 'fa-diagram-project', texto: 'Línea', sub: () => lineas.length ? lineas.map(l => ({ icono: l.tipo === 'principal' ? 'fa-diagram-project' : 'fa-code-branch', texto: l.id + (l.nombre ? ' · ' + l.nombre : ''), accion: () => seleccionarLinea(l.id) })) : [{ icono: 'fa-ban', texto: 'Sin líneas', accion: () => {} }] },
                'sep',
                { icono: 'fa-rotate-right', texto: 'Girar selección 90°', accion: () => girarSeleccion(90), habilitado: () => haySeleccion() },
                { icono: 'fa-grip-lines', texto: 'Alinear en horizontal (centros)', accion: () => alinearSeleccion('h') },
                { icono: 'fa-grip-lines-vertical', texto: 'Alinear en vertical (centros)', accion: () => alinearSeleccion('v') },
                { icono: 'fa-arrows-left-right', texto: 'Distribuir en horizontal', accion: () => alinearSeleccion('dh') },
                { icono: 'fa-arrows-up-down', texto: 'Distribuir en vertical', accion: () => alinearSeleccion('dv') },
                { icono: 'fa-circle-info', texto: 'Ctrl/Mayús + clic: añadir o quitar · arrastrar en vacío: ventana', accion: () => {} }
            ]},
            { titulo: 'Vista', items: [
                { icono: 'fa-sitemap', texto: 'Árbol de estructura (mostrar/ocultar)', accion: () => alternarArbol() },
                { icono: 'fa-triangle-exclamation', texto: 'Panel de avisos del cálculo (mostrar/ocultar)', accion: () => alternarPanelAvisos() },
                { icono: 'fa-comment-dots', texto: 'Comentarios de revisión...', accion: () => verComentarios() },
                { icono: 'fa-image', texto: 'Fondo DXF', sub: () => proyecto.fondo ? [
                    { icono: proyecto.fondo.visible ? 'fa-eye-slash' : 'fa-eye', texto: proyecto.fondo.visible ? 'Ocultar' : 'Mostrar', accion: () => { proyecto.fondo.visible = !proyecto.fondo.visible; renderizarVectorial(); marcarCambios(true); } },
                    { icono: 'fa-circle-half-stroke', texto: 'Opacidad', sub: [0.15, 0.25, 0.35, 0.5, 0.75].map(o => ({ icono: Math.abs((proyecto.fondo.opacidad || 0.35) - o) < 1e-3 ? 'fa-check' : 'fa-square', texto: Math.round(o * 100) + ' %', accion: () => { proyecto.fondo.opacidad = o; renderizarVectorial(); marcarCambios(true); } })) },
                    { icono: 'fa-trash-can', texto: 'Quitar el fondo (' + proyecto.fondo.nombre + ')', accion: () => { if (confirm('¿Quitar el DXF de fondo?')) { delete proyecto.fondo; renderizarVectorial(); marcarCambios(true); } } }
                ] : [{ icono: 'fa-file-import', texto: 'Importar DXF de referencia...', accion: () => importarDXFFondo() }] }
            ]},
            { titulo: 'Insertar', items: [
                { icono: 'fa-layer-group', texto: 'Plantilla', sub: () => [
                    ...PLANTILLAS_BASE.map(p => ({ icono: 'fa-cubes', texto: p.nombre, accion: () => insertarPlantilla(p) })),
                    ...(plantillasUsuario().length ? ['sep', ...plantillasUsuario().map(p => ({ icono: 'fa-user', texto: p.nombre, accion: () => insertarPlantilla(p) }))] : []),
                    'sep',
                    { icono: 'fa-floppy-disk', texto: 'Guardar selección como plantilla...', accion: () => guardarSeleccionComoPlantilla() },
                    ...(plantillasUsuario().length ? [{ icono: 'fa-trash-can', texto: 'Eliminar plantilla', sub: plantillasUsuario().map(p => ({ icono: 'fa-xmark', texto: p.nombre, accion: () => borrarPlantilla(p.nombre) })) }] : [])
                ] },
                'sep',
                { icono: 'fa-pen-ruler', texto: 'Trazar tubería (tramos y codos)', atajo: 'L', accion: () => iniciarTrazado() },
                'sep',
                { icono: 'fa-note-sticky', texto: 'Nota de texto', accion: () => insertarAnotacion('nota') },
                { icono: 'fa-list', texto: 'Leyenda de componentes', accion: () => insertarAnotacion('leyenda') },
                { icono: 'fa-table-list', texto: 'Listado de componentes', accion: () => insertarAnotacion('materiales') },
                'sep',
                { icono: 'fa-flag', texto: 'Banderola de línea (tubería seleccionada)', accion: () => { const t = idSeleccionado && elementosRed.find(e => e.id === idSeleccionado); if (!t || t.type !== 'tuberia') { aviso('Selecciona una tubería.'); return; } if (!insertarBanderola(t)) aviso('Esta tubería ya tiene banderola.'); } },
                { icono: 'fa-flag-checkered', texto: 'Banderolas en todas las líneas', accion: () => banderolasTodasLasLineas() },
                { icono: 'fa-comment-dots', texto: 'Comentario de revisión', accion: () => { const c = centroVista(); insertarComentario(c.x, mundoAScreenY(c.y)); } },
                { icono: 'fa-magnifying-glass', texto: 'Componente del catálogo del fabricante...', accion: () => buscarCatalogo() }
            ]},
            { titulo: 'CAD', items: [
                { icono: 'fa-layer-group', texto: 'Capas...', accion: () => abrirLineasCapas() },
                { icono: 'fa-table-cells', texto: 'Cajetín', sub: () => [
                    { icono: opciones.cajetin !== false ? 'fa-check' : 'fa-square', texto: 'Mostrar cajetín', accion: () => alternarRejilla('cajetin') },
                    { icono: 'fa-pen-to-square', texto: 'Datos del cajetín (Datos del proyecto)...', accion: () => abrirDatosProyecto() },
                    { icono: 'fa-image', texto: 'Logotipo del cliente...', accion: () => elegirLogotipo() },
                    ...(proyecto.logo ? [{ icono: 'fa-xmark', texto: 'Quitar el logotipo', accion: () => quitarLogotipo() }] : [])] },
                { icono: 'fa-file', texto: 'Formato de la hoja', sub: () => Object.entries(FORMATOS).map(([k, f]) => ({ icono: (opciones.formato || 'A3') === k ? 'fa-check' : 'fa-square', texto: `${k} (${f.w} × ${f.h} mm)`, accion: () => cambiarFormato(k) })) },
                { icono: 'fa-border-all', texto: 'Rejilla', sub: () => [
                    { icono: opciones.rejillaVisible !== false ? 'fa-check' : 'fa-square', texto: 'Mostrar rejilla', accion: () => alternarRejilla('rejillaVisible') },
                    { icono: opciones.rejilla ? 'fa-check' : 'fa-square', texto: 'Ajuste a rejilla (líneas menores)', accion: () => alternarRejilla('rejilla') },
                    { icono: 'fa-ruler', texto: `Espaciado... (${opciones.rejillaMayor || 10} mm / ${opciones.rejillaMenores || 2})`, accion: () => configurarRejilla() }] },
                { icono: 'fa-scale-balanced', texto: 'Unidades', sub: () => [
                    ...Object.entries(UNIDADES.p).map(([k, u]) => ({ icono: (opciones.uPresion || 'bar') === k ? 'fa-check' : 'fa-square', texto: 'Presión: ' + u[1], accion: () => cambiarUnidad('uPresion', k) })),
                    'sep',
                    ...Object.entries(UNIDADES.q).map(([k, u]) => ({ icono: (opciones.uCaudal || 'm3h') === k ? 'fa-check' : 'fa-square', texto: 'Caudal: ' + u[1], accion: () => cambiarUnidad('uCaudal', k) }))
                ] },
                { icono: 'fa-keyboard', texto: 'Atajos de teclado...', accion: () => abrirEditorAtajos() },
                { icono: 'fa-shapes', texto: 'Norma de símbolos', sub: () => Object.entries(NORMAS).map(([k, n]) => ({ icono: opciones.norma === k ? 'fa-check' : 'fa-square', texto: n, accion: () => cambiarNorma(k) })) }
            ]},
            { titulo: 'Tabla', items: [
                { icono: 'fa-table', texto: 'Añadir tabla...', accion: () => anadirTabla() },
                { icono: 'fa-table-list', texto: 'Listado de componentes', accion: () => insertarAnotacion('materiales') }
            ]},
            { titulo: 'Informe', items: [
                { icono: 'fa-file-word', texto: 'Generar informe (*.docx)...', accion: () => generarInforme() },
                { icono: 'fa-file-excel', texto: 'Listados de líneas, válvulas y materiales (*.xlsx)...', accion: () => generarListados() }
            ]},
            { titulo: 'Herramientas', items: [
                { icono: 'fa-ruler-combined', texto: 'Dimensionar tuberías (velocidad máxima)...', accion: () => dimensionarTuberias() },
                { icono: 'fa-fan', texto: 'Dimensionar bomba (punto Q-H, potencia y motor)...', accion: () => dimensionarBomba() },
                { icono: 'fa-temperature-half', texto: 'Aplicar aislamiento mínimo RITE a las tuberías', accion: () => aplicarAislamientoRITE() },
                { icono: 'fa-flask', texto: 'Volumen, vaso de expansión y glicol...', accion: () => abrirVolumenVaso() },
                'sep',
                { icono: 'fa-link', texto: 'Corregir conexiones casi unidas', accion: () => corregirConexiones() },
                { icono: 'fa-cube', texto: 'Isométrico de línea...', accion: () => isometricoLinea() },
                { icono: 'fa-magnifying-glass', texto: 'Buscar en el catálogo del fabricante...', accion: () => buscarCatalogo() }
            ]},
            { titulo: 'Opciones', items: [
                { icono: 'fa-language', texto: 'Idioma', sub: () => [...Object.entries(IDIOMAS).map(([k, n]) => ({ icono: idioma === k ? 'fa-check' : 'fa-square', texto: n, accion: () => cambiarIdioma(k) })), 'sep',
                    { icono: 'fa-file-word', texto: 'Informe, cajetín y listados', sub: () => [{ icono: !IDIOMAS[opciones.idiomaDoc] ? 'fa-check' : 'fa-square', texto: 'Igual que la interfaz', accion: () => cambiarIdiomaDoc('') }, ...Object.entries(IDIOMAS).map(([k, n]) => ({ icono: opciones.idiomaDoc === k ? 'fa-check' : 'fa-square', texto: n, accion: () => cambiarIdiomaDoc(k) }))] }] },
                { icono: 'fa-fill-drip', texto: 'Fondo del lienzo', sub: () => Object.entries(FONDOS).map(([k, f]) => ({ icono: opciones.fondo === k ? 'fa-check' : 'fa-square', texto: f.nombre, accion: () => cambiarFondo(k) })) },
                { icono: 'fa-floppy-disk', texto: 'Guardado automático', sub: () => [
                    { icono: 'fa-circle-info', texto: 'En el navegador: siempre (Archivo > Recuperar copia de seguridad)', accion: () => recuperarCopia() }, 'sep',
                    ...[0, 1, 2, 5, 10].map(m => ({ icono: (+opciones.autoArchivoMin || 0) === m ? 'fa-check' : 'fa-square', texto: m ? `En el archivo .pid cada ${m} min` : 'En el archivo .pid: desactivado', accion: () => fijarGuardadoArchivo(m) }))] },
                { icono: 'fa-sliders', texto: 'Criterios de cálculo (margen NPSH)...', accion: () => abrirCriterios() },
                { icono: 'fa-database', texto: 'Supabase', sub: () => [
                    { icono: 'fa-key', texto: claveSupabase() ? 'Conexión configurada (cambiar clave)...' : 'Configurar conexión (clave anon)...', accion: () => configurarSupabase() },
                    { icono: 'fa-cloud-arrow-down', texto: 'Actualizar catálogo desde Supabase', accion: () => sincronizarCatalogoSupabase(true) },
                    { icono: 'fa-file-code', texto: 'Usar catalogo.js local', accion: () => usarCatalogoLocal() },
                    'sep',
                    { icono: 'fa-circle-info', texto: 'Origen del catálogo: ' + (window.CATALOGO_ORIGEN || '') + (CAT ? ' · ' + CAT.version : ''), accion: () => {} }] }
            ]},
            { titulo: 'Zoom', items: [
                { icono: 'fa-expand', texto: 'Ajustar', atajo: 'F', accion: () => ajustarVistaVentana() },
                { icono: 'fa-maximize', texto: 'Todo', atajo: 'T', accion: () => zoomTodo() },
                { icono: 'fa-vector-square', texto: 'Ventana', atajo: 'W', accion: () => activarZoomVentana() }
            ]},
            { titulo: 'Ayuda', items: [
                { icono: 'fa-person-chalkboard', texto: 'Tutorial guiado', accion: () => iniciarTutorial() },
                { icono: 'fa-keyboard', texto: 'Atajos de teclado', accion: () => mostrarAtajosAyuda() },
                { icono: 'fa-right-left', texto: 'Equivalencia ASME / Norma europea...', accion: () => mostrarEquivalencias() },
                { icono: 'fa-circle-info', texto: 'Créditos...', accion: () => mostrarCreditos() }
            ]}
        ];

        // ==================================================================================
        // ACCESO: invitado (ver y probar la interfaz, sin guardar ni exportar nada) o administrador
        // (Administración > Iniciar sesión). En el código solo está el resumen SHA-256 con sal
        // (20 000 iteraciones) de usuario y contraseña, nunca la contraseña.
        // Es una protección en el navegador: el código de una web estática es público y se puede
        // saltar con las herramientas del navegador. Para una protección real: usuarios de Supabase.
        // ==================================================================================
        const ACCESO_SAL = 'pP1ng#5559d5af6c0aa9e0', ACCESO_HASH_BASE = 'f9938863e8e2545986ec6265f81ed1bc07591a191898034d6418a49a6028547a', ACCESO_ITER = 20000;
        function sha256hex(txt) {
            const K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
            const b = new TextEncoder().encode(txt), l = b.length, n = ((l + 9 + 63) >> 6) << 6, m = new Uint8Array(n); m.set(b); m[l] = 0x80;
            const dv = new DataView(m.buffer); dv.setUint32(n - 4, l * 8); dv.setUint32(n - 8, Math.floor(l / 0x20000000));
            let H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]; const W = new Uint32Array(64);
            const r = (x, k) => (x >>> k) | (x << (32 - k));
            for (let o = 0; o < n; o += 64) {
                for (let i = 0; i < 16; i++) W[i] = dv.getUint32(o + i * 4);
                for (let i = 16; i < 64; i++) { const s0 = r(W[i - 15], 7) ^ r(W[i - 15], 18) ^ (W[i - 15] >>> 3), s1 = r(W[i - 2], 17) ^ r(W[i - 2], 19) ^ (W[i - 2] >>> 10); W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0; }
                let [a, bb, c, d, e, f, g, h] = H;
                for (let i = 0; i < 64; i++) { const t1 = (h + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0, t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & bb) ^ (a & c) ^ (bb & c))) | 0; h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0; }
                H = [H[0] + a, H[1] + bb, H[2] + c, H[3] + d, H[4] + e, H[5] + f, H[6] + g, H[7] + h].map(x => x | 0);
            }
            return H.map(x => (x >>> 0).toString(16).padStart(8, '0')).join('');
        }
        function resumenAcceso(usuario, clave) { let h = sha256hex(`${ACCESO_SAL}|${String(usuario).trim().toLowerCase()}|${clave}`); for (let i = 0; i < ACCESO_ITER; i++) h = sha256hex(h + ACCESO_SAL); return h; }
        const hashAcceso = () => { try { return localStorage.getItem('piping-admin-hash') || ACCESO_HASH_BASE; } catch (e) { return ACCESO_HASH_BASE; } };
        const testigoSesion = () => sha256hex(hashAcceso() + 'sesion');
        // ---------- sesión y roles ----------
        // Usuarios en Supabase (supabase/05_usuarios.sql): Archivo > Administración > Usuarios. Sin conexión
        // con Supabase solo funciona el administrador local (contraseña de la aplicación).
        const ROLES = { admin: 'Administrador', supervisor: 'Supervisor', jefe: 'Jefe de proyecto', usuario: 'Usuario' };
        const PERMISOS = {
            guardar: ['admin', 'supervisor', 'jefe', 'usuario'],   // guardar, exportar, imprimir, informes, nube
            revision: ['admin', 'supervisor', 'jefe'],             // registrar revisión (emitir)
            congelar: ['admin', 'supervisor', 'jefe'],
            descongelar: ['admin', 'supervisor'],
            compartido: ['admin', 'supervisor'],                   // librería, capas predeterminadas, librería del equipo
            comentarios: ['admin', 'supervisor'],                  // resolver / reabrir comentarios de revisión
            usuarios: ['admin']
        };
        const DESCRIPCION_ROLES = {
            admin: 'Todo, y la gestión de usuarios.',
            supervisor: 'Todo menos usuarios: revisa y aprueba, resuelve comentarios, congela y descongela, librería y capas compartidas.',
            jefe: 'Guarda, exporta, informes y listados, registra revisiones (emite) y congela planos.',
            usuario: 'Dibuja, calcula, guarda y exporta. No registra revisiones, no descongela ni cambia la librería o las capas compartidas.'
        };
        function sesionActual() {
            let v = null; try { v = sessionStorage.getItem('piping-sesion') || localStorage.getItem('piping-sesion'); } catch (e) { }
            if (!v) return null;
            if (v === testigoSesion()) return { usuario: 'admin', nombre: 'Administrador', apellidos: '', rol: 'admin', origen: 'local' };
            try { const s = JSON.parse(v); if (s && s.token && ROLES[s.rol] && (!s.expira || s.expira > Date.now())) return s; } catch (e) { }
            return null;
        }
        function rolActual() { return (sesionActual() || {}).rol || null; }
        function tienePermiso(p) { const r = rolActual(); return !!r && (PERMISOS[p] || []).includes(r); }
        function esAdministrador() { return rolActual() === 'admin'; }
        function nombreSesion(s) { return s ? ((s.nombre || '') + ' ' + (s.apellidos || '')).trim() || s.usuario : ''; }
        function guardarSesion(s, recordar) {
            try { const v = typeof s === 'string' ? s : JSON.stringify(s); sessionStorage.setItem('piping-sesion', v); if (recordar) localStorage.setItem('piping-sesion', v); else localStorage.removeItem('piping-sesion'); } catch (e) { }
        }
        function borrarSesion() { try { sessionStorage.removeItem('piping-sesion'); localStorage.removeItem('piping-sesion'); } catch (e) { } }
        function puedeGuardar(que, permiso = 'guardar') {
            if (tienePermiso(permiso)) return true;
            const s = sesionActual();
            aviso(s ? `Tu rol (${tradDoc(ROLES[s.rol])}) no permite ${que || 'esta acción'}.` : `Modo invitado: no se puede guardar ni exportar${que ? ' ' + que : ''}. Archivo > Administración > Iniciar sesión.`, 'error');
            return false;
        }
        // llamadas a las funciones de usuarios de Supabase con la clave anon
        async function rpcUsuarios(f, args) {
            const k = claveSupabase(); if (!k) throw new Error('Sin conexión con Supabase (Opciones > Supabase > Configurar conexión).');
            let r; try { r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${f}`, { method: 'POST', headers: { apikey: k, Authorization: 'Bearer ' + k, 'Content-Type': 'application/json' }, body: JSON.stringify(args || {}) }); }
            catch (e) { const x = new Error('No se puede conectar con Supabase.'); x.red = true; throw x; }
            const t = await r.text(); let d = null; try { d = t ? JSON.parse(t) : null; } catch (e) { d = t; }
            if (!r.ok) { const x = new Error((d && (d.message || d.hint)) || ('HTTP ' + r.status)); if (r.status === 404) x.sinFuncion = true; throw x; }
            return d;
        }
        function pintarInsignia() {
            let s = document.getElementById('insignia-sesion');
            if (!s) { const c = document.querySelector('header > div'); if (!c) return; s = document.createElement('span'); s.id = 'insignia-sesion'; s.style.cursor = 'pointer'; s.onclick = () => sesionActual() ? null : iniciarSesionAdmin(); c.appendChild(s); }
            const ses = sesionActual();
            s.className = `text-[10px] font-bold px-2 py-0.5 rounded-full ${!ses ? 'bg-amber-100 text-amber-700' : ses.rol === 'admin' ? 'bg-emerald-100 text-emerald-700' : 'bg-blue-100 text-blue-700'}`;
            s.setAttribute('data-no-trad', '');
            s.innerHTML = ses ? `<i class="fa-solid ${ses.rol === 'admin' ? 'fa-user-shield' : 'fa-user-check'} mr-1"></i>${esc(nombreSesion(ses))} · ${esc(trad(ROLES[ses.rol]))}` : `<i class="fa-solid fa-user mr-1"></i>${esc(trad('Invitado (solo consulta)'))}`;
            s.title = ses ? trad('Sesión iniciada (Archivo > Administración > Cerrar sesión)') : trad('Sin acreditación: no se puede guardar. Clic o Archivo > Administración > Iniciar sesión');
        }
        async function iniciarSesionAdmin() {
            cerrarMenus();
            const sinClave = !claveSupabase();
            const r = await dialogo('<i class="fa-solid fa-user-shield text-blue-600 mr-1.5"></i>Iniciar sesión', `<div class="space-y-2"><label class="block">Usuario <input id="acc-u" autocomplete="username" class="border rounded p-1 w-full"></label><label class="block">Contraseña <input id="acc-c" type="password" autocomplete="current-password" class="border rounded p-1 w-full"></label><label class="flex items-center gap-1 text-[11px]"><input id="acc-r" type="checkbox"> Recordar en este equipo</label>
                ${sinClave ? '<label class="block text-[11px] text-slate-500">Clave anon de Supabase (solo la primera vez en este equipo; sin ella solo entra el administrador local) <input id="acc-k" class="border rounded p-1 w-full font-mono text-[10px]"></label>' : ''}</div>`,
                [{ texto: 'Entrar', valor: 'si', clase: 'bg-blue-600 hover:bg-blue-700 text-white' }, { texto: 'Seguir como invitado', valor: null }]);
            if (r !== 'si') return false;
            const u = document.getElementById('acc-u').value.trim(), c = document.getElementById('acc-c').value, rec = document.getElementById('acc-r').checked, k = (document.getElementById('acc-k') || {}).value;
            if (k && k.trim()) { try { localStorage.setItem('piping-supabase-clave', k.trim()); } catch (e) { } }
            await new Promise(ok => setTimeout(ok, 30));
            const localOk = u.toLowerCase() === 'admin' && resumenAcceso(u, c) === hashAcceso();
            const entrarLocal = motivo => { guardarSesion(testigoSesion(), rec); pintarInsignia(); aviso(`Sesión de administrador local iniciada${motivo ? ' (' + motivo + ')' : ''}.`, 'ok'); return true; };
            const entrarNube = (d, msg) => { const s = Object.assign({}, d.usuario, { token: d.token, origen: 'supabase', expira: Date.parse(d.expira) || Date.now() + (rec ? 30 * 864e5 : 12 * 36e5) }); guardarSesion(s, rec); pintarInsignia(); aviso(msg || `Sesión iniciada: ${nombreSesion(s)} · ${trad(ROLES[s.rol])}.`, 'ok'); return s; };
            if (!claveSupabase()) { if (localOk) return entrarLocal('sin conexión con Supabase'); aviso('Usuario o contraseña incorrectos.', 'error'); return false; }
            try {
                const d = await rpcUsuarios('piping_login', { p_usuario: u, p_clave: c, p_recordar: rec });
                if (d && d.ok) { const s = entrarNube(d); if (s.debe_cambiar) await cambiarClaveAdmin(true); return true; }
                // primer arranque: la tabla de usuarios está vacía y entra el administrador de la aplicación
                if (localOk && await rpcUsuarios('piping_usuarios_vacio')) { const d2 = await rpcUsuarios('piping_inicializar', { p_usuario: 'admin', p_nombre: 'Administrador', p_clave: c }); if (d2 && d2.ok) { entrarNube(d2, 'Usuario administrador creado en Supabase y sesión iniciada. Archivo > Administración > Usuarios para dar de alta al resto.'); return true; } }
                aviso((d && d.error) || 'Usuario o contraseña incorrectos.', 'error'); return false;
            } catch (e) {
                if (localOk) return entrarLocal(e.sinFuncion ? 'falta ejecutar supabase/05_usuarios.sql' : 'sin conexión con Supabase');
                aviso('No se ha podido iniciar sesión: ' + e.message, 'error'); return false;
            }
        }
        async function cerrarSesionAdmin() {
            cerrarMenus(); const s = sesionActual();
            if (s && s.origen === 'supabase') { try { await rpcUsuarios('piping_logout', { p_token: s.token }); } catch (e) { } }
            borrarSesion(); pintarInsignia(); aviso('Sesión cerrada: modo invitado (solo consulta).');
        }
        function cambiarClaveAdmin(...a) { return PARTES_OK.admin ? cambiarClaveAdmin__p.apply(this, a) : cargarParte('admin').then(() => cambiarClaveAdmin__p.apply(this, a)); }
        // ---------- Archivo > Administración > Usuarios ----------
        let listaUsuarios = [];
        const selRol = (id, v) => `<select id="${id}" class="border rounded p-0.5">${Object.entries(ROLES).map(([k, n]) => `<option value="${k}" ${k === v ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>`;
        function abrirUsuarios(...a) { return PARTES_OK.admin ? abrirUsuarios__p.apply(this, a) : cargarParte('admin').then(() => abrirUsuarios__p.apply(this, a)); }
        // sesión de administrador local → se conecta a Supabase (y se crea el administrador si la tabla está vacía),
        // diciendo exactamente qué falla: clave anon, SQL sin ejecutar, contraseña…
        function conectarUsuariosSupabase(...a) { return PARTES_OK.admin ? conectarUsuariosSupabase__p.apply(this, a) : cargarParte('admin').then(() => conectarUsuariosSupabase__p.apply(this, a)); }
        
        const valorCampo = id => (document.getElementById(id) || {}).value || '';

        // ---------- registro de actividad: se anota lo que el rol permite hacer ----------
        [['guardarProyecto', 'guardar', () => nombreArchivoActual || ''], ['guardarComoProyecto', 'guardar como', f => String(f || '')], ['generarInforme', 'informe'], ['generarListados', 'listados'], ['exportarPDFCapas', 'PDF con capas'],
         ['imprimirHojas', 'imprimir'], ['registrarRevision', 'registrar revisión', () => 'rev. ' + (proyecto.revision || '0')], ['nubeGuardar', 'guardar en la nube'], ['nubeAbrirProyecto', 'abrir de la nube']].forEach(([n, accion, det]) => {
            const f = window[n]; if (typeof f !== 'function') return;
            window[n] = function () { try { registrarActividad(accion, det ? det.apply(this, arguments) : ''); } catch (e) { } return f.apply(this, arguments); };
        });
        { const _cp0 = congelarPlano; congelarPlano = function (si) { try { registrarActividad(si ? 'congelar plano' : 'descongelar plano'); } catch (e) { } return _cp0.apply(this, arguments); }; }
        // ---------- qué puede hacer cada rol ----------
        [['guardarProyecto', 'el proyecto'], ['guardarComoProyecto', 'el proyecto'], ['generarInforme', 'el informe'], ['generarListados', 'los listados'], ['abrirImpresion', '(imprimir)'], ['imprimirHojas', '(imprimir)'],
         ['exportarPDFCapas', 'el PDF'], ['exportarComparacionEscenarios', 'la comparación'], ['nubeGuardar', 'en la nube'], ['guardarPlantillasUsuario', 'la plantilla'],
         ['guardarSeleccionComoPlantilla', 'la plantilla'], ['descargarPlantillaExcel', 'la plantilla Excel'], ['descargarPlantillaLineasEquipos', 'la plantilla Excel'],
         ['registrarRevision', 'registrar revisiones', 'revision'], ['nubeSubirLibreria', 'compartir la librería', 'compartido'], ['capasComoPredeterminadas', 'cambiar las capas predeterminadas', 'compartido'],
         ['estadoComentario', 'resolver comentarios de revisión', 'comentarios']].forEach(([n, que, permiso]) => {
            const f = window[n]; if (typeof f !== 'function') return;
            window[n] = function () { if (!puedeGuardar(que, permiso)) return; return f.apply(this, arguments); };
        });
        { const _cp = congelarPlano; congelarPlano = function (si) { if (!puedeGuardar(si ? 'congelar el plano' : 'descongelar el plano', si ? 'congelar' : 'descongelar')) return; return _cp.apply(this, arguments); }; }
        // copias en el navegador (último proyecto y copias de seguridad): sin rastro en modo invitado
        { const _gu = guardarUltimo; guardarUltimo = function () { if (tienePermiso('guardar')) return _gu.apply(this, arguments); }; }
        { const _hc = hacerCopiaSeguridad; hacerCopiaSeguridad = function () { if (tienePermiso('guardar')) return _hc.apply(this, arguments); }; }
        // el invitado no tiene nada que guardar: sin aviso del navegador al cerrar
        window.addEventListener('beforeunload', e => { if (!sesionActual()) e.stopImmediatePropagation(); }, true);
        // Ctrl+G / Ctrl+S, Ctrl+P y similares pasan por las funciones anteriores
        function submenuAdministracion() { const s = sesionActual(); return s ? [
            { icono: s.rol === 'admin' ? 'fa-user-shield' : 'fa-user-check', texto: `Sesión: ${nombreSesion(s)} · ${trad(ROLES[s.rol])}`, accion: () => {} },
            { icono: 'fa-id-badge', texto: 'Mi perfil...', accion: () => abrirPerfil() },
            { icono: 'fa-key', texto: 'Cambiar mi contraseña...', accion: () => cambiarClaveAdmin() },
            ...(s.rol === 'admin' ? ['sep', { icono: 'fa-users', texto: 'Usuarios...', accion: () => abrirUsuarios() }, { icono: 'fa-clipboard-list', texto: 'Registro de actividad...', accion: () => abrirRegistro() }] : []),
            'sep', { icono: 'fa-right-from-bracket', texto: 'Cerrar sesión', accion: () => cerrarSesionAdmin() }
        ] : [{ icono: 'fa-right-to-bracket', texto: 'Iniciar sesión...', accion: () => iniciarSesionAdmin() }, { icono: 'fa-circle-info', texto: 'Modo invitado: se puede ver y probar todo, pero no guardar ni exportar', accion: () => {} }]; }
        { const archivo = MENUS.find(m => m.titulo === 'Archivo'), k = archivo.items.findIndex(x => x && x.texto === 'Nube (equipo)'); archivo.items.splice(k + 1, 0, { icono: 'fa-user-shield', texto: 'Administración', sub: () => submenuAdministracion() }); }
        // al entrar: aviso destacado del modo invitado (si no hay sesión)
        async function pantallaAcceso() {
            const r = await dialogo('<i class="fa-solid fa-user-lock text-amber-600 mr-1.5"></i>Acceso a PIPING',
                `<div class="border-2 border-amber-400 bg-amber-50 rounded-lg p-3 text-center"><p class="text-base font-bold text-amber-700"><i class="fa-solid fa-user mr-1.5"></i>Vas a entrar en MODO INVITADO</p>
                <p class="mt-1 text-amber-800">Puedes ver y probar toda la aplicación, pero <b>no se guarda ni se exporta nada</b> (proyectos, DXF, PDF, informes, listados, impresión, nube).</p></div>
                <p class="mt-2 text-slate-500 text-[11px]">Para trabajar con guardado: Archivo > Administración > Iniciar sesión.</p>`,
                [{ texto: 'Entrar como invitado', valor: 'invitado', clase: 'bg-amber-500 hover:bg-amber-600 text-white' }, { texto: 'Iniciar sesión...', valor: 'admin', clase: 'bg-white hover:bg-slate-50 border border-slate-300 text-slate-700' }]);
            if (r === 'admin') await iniciarSesionAdmin();
            pintarInsignia();
            if (!sesionActual()) aviso('Modo invitado: solo consulta. Archivo > Administración > Iniciar sesión para guardar.');
        }
        { const _pi = pantallaInicio; let primera = true; pantallaInicio = async function () { if (primera) { primera = false; if (!sesionActual()) await pantallaAcceso(); } return _pi.apply(this, arguments); }; }
        setTimeout(pintarInsignia, 0);
        // ==================================================================================
        // v8.7 · Sesión que se renueva sola, «Mi perfil», indicador de guardado, registro de actividad
        // y firma del plano por rol (supabase/06_sesion_perfil_registro.sql)
        // ==================================================================================
        const sesionRecordada = () => { try { return !!localStorage.getItem('piping-sesion'); } catch (e) { return false; } };
        // ---------- 2) renovación de la sesión mientras se trabaja; aviso antes de caducar ----------
        let ultimaActividad = Date.now(), habiaSesion = false, avisadoCaducidad = false;
        ['mousedown', 'keydown', 'wheel'].forEach(ev => window.addEventListener(ev, () => { ultimaActividad = Date.now(); }, true));
        async function renovarSesion(manual) {
            const s = sesionActual(); if (!s || s.origen !== 'supabase') return false;
            try {
                const d = await rpcUsuarios('piping_renovar', { p_token: s.token });
                if (d && d.ok) { Object.assign(s, d.usuario, { expira: Date.parse(d.expira) || Date.now() + 12 * 36e5 }); guardarSesion(s, sesionRecordada()); avisadoCaducidad = false; pintarInsignia(); if (manual) aviso('Sesión renovada.', 'ok'); return true; }
            } catch (e) {
                if (/Sesi[oó]n no v[aá]lida/.test(e.message)) { borrarSesion(); pintarInsignia(); aviso('La sesión ha caducado o el usuario se ha desactivado: vuelve a iniciar sesión (el trabajo sigue en pantalla).', 'error'); }
                else if (e.sinFuncion && manual) aviso('Falta ejecutar supabase/06_sesion_perfil_registro.sql.', 'error');
            }
            return false;
        }
        function vigilarSesion() {
            const s = sesionActual();
            if (!s) { if (habiaSesion) { habiaSesion = false; pintarInsignia(); aviso('La sesión ha caducado: estás en modo invitado. Archivo > Administración > Iniciar sesión (el trabajo sigue en pantalla).', 'error'); } return; }
            habiaSesion = true;
            if (s.origen !== 'supabase' || !s.expira) return;
            const quedan = s.expira - Date.now(), activo = Date.now() - ultimaActividad < 30 * 60000;
            // con actividad reciente se renueva cuando ha pasado media hora desde la última renovación o queda menos de una hora
            if (activo && (quedan < 60 * 60000 || Date.now() - (s.renovada || 0) > 30 * 60000)) { s.renovada = Date.now(); guardarSesion(s, sesionRecordada()); renovarSesion(false); }
            else if (quedan < 10 * 60000 && !avisadoCaducidad) { avisadoCaducidad = true; aviso(`La sesión caduca en ${Math.max(1, Math.round(quedan / 60000))} min: mueve el ratón o pulsa una tecla para renovarla.`, 'error'); }
        }
        setInterval(vigilarSesion, 60000);
        setTimeout(() => { habiaSesion = !!sesionActual(); if (habiaSesion) renovarSesion(false); }, 1500);

        // ---------- 4) Mi perfil ----------
        function perfilLocal() { try { return JSON.parse(localStorage.getItem('piping-perfil-local') || '{}'); } catch (e) { return {}; } }
        // firma para el cajetín: iniciales o, si no hay, nombre y apellidos
        function firmaSesion() { const s = sesionActual(); if (!s) return ''; if (s.origen === 'local') { const p = perfilLocal(); return p.iniciales || p.nombre || 'ADMIN'; } return s.iniciales || nombreSesion(s); }
        function abrirPerfil(...a) { return PARTES_OK.admin ? abrirPerfil__p.apply(this, a) : cargarParte('admin').then(() => abrirPerfil__p.apply(this, a)); }
        // «Dibujado por» de los proyectos: el usuario de la sesión si está vacío; las firmas de revisado y
        // aprobado no se escriben a mano (Archivo > Firmar plano)
        { const _adp = abrirDatosProyecto; abrirDatosProyecto = function () {
            const r = _adp.apply(this, arguments);
            try {
                const au = document.getElementById('dp-p-autor'); if (au && !au.value.trim() && firmaSesion()) au.value = firmaSesion();
                if (!esAdministrador()) ['revisadoPor', 'fechaRevisado', 'aprobadoPor', 'fechaAprobado'].forEach(k => { const x = document.getElementById('dp-p-' + k); if (x) { x.readOnly = true; x.classList.add('bg-slate-100', 'text-slate-500'); x.title = trad('Se rellena al firmar el plano: Archivo > Firmar plano'); if (x.type === 'date') x.addEventListener('keydown', e => e.preventDefault()); x.addEventListener('mousedown', e => { if (x.type === 'date') e.preventDefault(); }); } });
            } catch (e) { }
            return r;
        }; }

        // ---------- 20) indicador de guardado junto al usuario ----------
        let ultimoGuardadoMs = null;
        { const _mc = marcarCambios; marcarCambios = function (modificado = true) { if (modificado === false) ultimoGuardadoMs = Date.now(); const r = _mc.apply(this, arguments); pintarEstadoGuardado(); return r; }; }
        function pintarEstadoGuardado() {
            let s = document.getElementById('estado-guardado');
            if (!s) { const c = document.querySelector('header > div'); if (!c) return; s = document.createElement('span'); s.id = 'estado-guardado'; s.setAttribute('data-no-trad', ''); s.className = 'text-[10px] px-2 py-0.5 rounded-full'; c.appendChild(s); }
            const hayProyecto = !!(proyecto && proyecto.numero) || elementosRed.length > 0;
            let t = '', cls = 'text-slate-400', ico = 'fa-circle-check';
            if (!hayProyecto) t = '';
            else if (!sesionActual()) { t = trad('Invitado: no se guarda'); cls = 'text-amber-700'; ico = 'fa-ban'; }
            else if (hayCambiosSinGuardar) { t = trad('Cambios sin guardar') + (ultimoGuardadoMs ? ' · ' + trad('guardado') + ' ' + haceCuanto(ultimoGuardadoMs) : ''); cls = 'text-rose-600 font-bold'; ico = 'fa-circle-exclamation'; }
            else { t = trad('Guardado') + (ultimoGuardadoMs ? ' ' + haceCuanto(ultimoGuardadoMs) : ''); cls = 'text-emerald-700'; }
            s.className = 'text-[10px] px-2 py-0.5 rounded-full ' + cls; s.style.cursor = hayCambiosSinGuardar && sesionActual() ? 'pointer' : 'default';
            s.innerHTML = t ? `<i class="fa-solid ${ico} mr-1"></i>${esc(t)}` : ''; s.title = hayCambiosSinGuardar && sesionActual() ? trad('Clic para guardar (Ctrl+G)') : '';
            s.onclick = () => { if (hayCambiosSinGuardar && sesionActual()) guardarProyecto(); };
        }
        function haceCuanto(ms) { const m = Math.floor((Date.now() - ms) / 60000); return m < 1 ? trad('ahora mismo') : m < 60 ? trad('hace') + ' ' + m + ' min' : trad('hace') + ' ' + Math.floor(m / 60) + ' h ' + (m % 60) + ' min'; }
        setInterval(pintarEstadoGuardado, 30000); setTimeout(pintarEstadoGuardado, 800);
        { const _pin = pintarInsignia; pintarInsignia = function () { const r = _pin.apply(this, arguments); try { pintarEstadoGuardado(); } catch (e) { } return r; }; }

        // ---------- 7) registro de actividad (solo con usuarios de Supabase) ----------
        function registrarActividad(accion, detalle) {
            const s = sesionActual(); if (!s || s.origen !== 'supabase') return;
            rpcUsuarios('piping_registrar', { p_token: s.token, p_accion: accion, p_detalle: detalle || null, p_proyecto: [proyecto && proyecto.numero, typeof codigoHoja === 'function' && hojas.length > 1 ? 'hoja ' + codigoHoja() : ''].filter(Boolean).join(' · ') || null }).catch(() => { });
        }
        let registroDatos = [];
        function abrirRegistro(...a) { return PARTES_OK.admin ? abrirRegistro__p.apply(this, a) : cargarParte('admin').then(() => abrirRegistro__p.apply(this, a)); }

        // ---------- 11) firma del plano por rol ----------
        PERMISOS.firmarRevisado = ['admin', 'supervisor'];
        PERMISOS.firmarAprobado = ['admin', 'jefe'];
        const hoyISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
        async function firmarPlano(tipo) {
            cerrarMenus();
            const rev = tipo === 'revisado', campo = rev ? 'revisadoPor' : 'aprobadoPor', cFecha = rev ? 'fechaRevisado' : 'fechaAprobado';
            if (!puedeGuardar(rev ? 'firmar como revisado (Supervisor)' : 'firmar como aprobado (Jefe de proyecto)', rev ? 'firmarRevisado' : 'firmarAprobado')) return;
            if (!proyectoDefinido()) { aviso('Completa antes los datos del proyecto (Archivo > Datos del proyecto).', 'error'); return; }
            if (!rev && !proyecto.revisadoPor) { aviso('El plano tiene que estar revisado antes de aprobarlo (Archivo > Firmar plano > Firmar como revisado).', 'error'); return; }
            const firma = firmaSesion();
            const r = await dialogo(`<i class="fa-solid fa-signature text-blue-600 mr-1.5"></i>Firmar como ${rev ? 'revisado' : 'aprobado'}`, `<p>Se anotará en el cajetín: <b>${rev ? 'Revisado por' : 'Aprobado por'}: ${esc(firma)}</b> · ${fechaDMA(hoyISO())}.</p>${proyecto[campo] ? `<p class="text-amber-700 mt-1">Sustituye a la firma actual: ${esc(proyecto[campo])} · ${fechaDMA(proyecto[cFecha])}.</p>` : ''}<p class="text-[11px] text-slate-500 mt-1">Proyecto ${esc(proyecto.numero || '')} · revisión ${esc(String(proyecto.revision || '0'))}.</p>`,
                [{ texto: 'Firmar', valor: 'si', clase: 'bg-blue-600 hover:bg-blue-700 text-white' }, { texto: 'Cancelar', valor: null }]);
            if (r !== 'si') return;
            const s = sesionActual();
            proyecto[campo] = firma; proyecto[cFecha] = hoyISO();
            (proyecto.firmas = proyecto.firmas || []).push({ tipo, firma, usuario: s.usuario, nombre: nombreSesion(s), rol: s.rol, fecha: new Date().toISOString(), revision: String(proyecto.revision || '0') });
            marcarCambios(true); renderizarVectorial();
            registrarActividad(rev ? 'firma: revisado' : 'firma: aprobado', `rev. ${proyecto.revision || '0'} · ${firma}`);
            aviso(`Plano firmado como ${rev ? 'revisado' : 'aprobado'} por ${firma}.`, 'ok');
        }
        function quitarFirma(tipo) {
            cerrarMenus(); const rev = tipo === 'revisado';
            if (!puedeGuardar('quitar la firma', rev ? 'firmarRevisado' : 'firmarAprobado')) return;
            if (!confirm(`¿Quitar la firma de ${rev ? 'revisado' : 'aprobado'}?`)) return;
            proyecto[rev ? 'revisadoPor' : 'aprobadoPor'] = ''; proyecto[rev ? 'fechaRevisado' : 'fechaAprobado'] = '';
            if (rev) { proyecto.aprobadoPor = ''; proyecto.fechaAprobado = ''; }
            marcarCambios(true); renderizarVectorial(); registrarActividad('firma retirada', tipo); aviso('Firma retirada.');
        }
        { const archivo = MENUS.find(m => m.titulo === 'Archivo'), k = archivo.items.findIndex(x => x && x.texto === 'Registrar revisión...');
          archivo.items.splice(k + 1, 0, { icono: 'fa-signature', texto: 'Firmar plano', sub: () => [
            { icono: 'fa-user-check', texto: 'Firmar como revisado (Supervisor)', accion: () => firmarPlano('revisado') },
            { icono: 'fa-stamp', texto: 'Firmar como aprobado (Jefe de proyecto)', accion: () => firmarPlano('aprobado') },
            ...(proyecto.revisadoPor || proyecto.aprobadoPor ? ['sep'] : []),
            ...(proyecto.revisadoPor ? [{ icono: 'fa-eraser', texto: 'Quitar firma de revisado', accion: () => quitarFirma('revisado') }] : []),
            ...(proyecto.aprobadoPor ? [{ icono: 'fa-eraser', texto: 'Quitar firma de aprobado', accion: () => quitarFirma('aprobado') }] : [])] }); }

        // ---------- 5) menús según el rol: lo que no se puede hacer sale en gris con candado ----------
        const PERMISOS_MENU = [
            [/^(Guardar$|Guardar en la nube|Guardar selección como plantilla|Proyecto P&ID \(|Dibujo CAD \(|Datos JSON|Datos XML|Imagen vectorial|Imagen \(|PDF vectorial|Imprimir|Generar informe|Listados de líneas|Descargar plantilla)/, 'guardar'],
            [/^Registrar revisión/, 'revision'], [/^Compartir mi librería/, 'compartido'], [/^Congelar plano/, 'congelar'], [/^Descongelar plano/, 'descongelar'],
            [/^(Firmar como revisado|Quitar firma de revisado)/, 'firmarRevisado'], [/^(Firmar como aprobado|Quitar firma de aprobado)/, 'firmarAprobado']
        ];
        function permisoMenu(texto) { const x = PERMISOS_MENU.find(([re]) => re.test(String(texto || ''))); return x ? x[1] : null; }
        function motivoBloqueo(texto) { const p = permisoMenu(texto); if (!p || tienePermiso(p)) return ''; const s = sesionActual(); return s ? `${trad('Tu rol no lo permite')} (${trad(ROLES[s.rol])})` : trad('Modo invitado: inicia sesión (Archivo > Administración)'); }
        const barraMenus = document.getElementById('barra-menus');
        let menuAbierto = null;

        function construirItems(items, contenedor, ruta) {
            contenedor.innerHTML = '';
            if (!items.length) {
                contenedor.innerHTML = '<div class="menu-vacio">Próximamente</div>';
                return;
            }
            items.forEach(it => {
                if (it === 'sep') {
                    const sep = document.createElement('div');
                    sep.className = 'menu-sep';
                    contenedor.appendChild(sep);
                    return;
                }
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'menu-item';
                btn.innerHTML = `<i class="fa-solid ${it.icono || ''} ico"></i><span>${it.texto}</span>` +
                    (it.sub ? '<i class="fa-solid fa-chevron-right flecha"></i>' : (() => { const at = ruta ? atajoTexto(ruta + ' › ' + it.texto, it.atajo) : it.atajo; return at ? `<span class="atajo">${esc(at)}</span>` : ''; })());
                if (it.habilitado && !it.habilitado()) btn.disabled = true;
                { const mb = !it.sub && typeof motivoBloqueo === 'function' ? motivoBloqueo(it.texto) : ''; if (mb) { btn.style.opacity = '.45'; btn.title = mb; btn.dataset.bloqueado = '1'; btn.insertAdjacentHTML('beforeend', '<i class="fa-solid fa-lock" style="margin-left:8px;font-size:9px"></i>'); } }
                if (it.sub) {
                    const envoltorio = document.createElement('div');
                    envoltorio.className = 'menu-sub';
                    const subMenu = document.createElement('div');
                    subMenu.className = 'menu-desplegable';
                    construirItems(typeof it.sub === 'function' ? it.sub() : it.sub, subMenu, ruta ? ruta + ' › ' + it.texto : null);
                    envoltorio.appendChild(btn);
                    envoltorio.appendChild(subMenu);
                    contenedor.appendChild(envoltorio);
                } else {
                    btn.addEventListener('click', e => {
                        e.stopPropagation();
                        cerrarMenus();
                        it.accion && it.accion();
                    });
                    contenedor.appendChild(btn);
                }
            });
        }

        function abrirMenu(nodo, def) {
            cerrarMenus();
            construirItems(def.items, nodo.querySelector('.menu-desplegable'), def.titulo); // refresca activado/desactivado
            nodo.classList.add('abierto');
            menuAbierto = nodo;
        }

        function cerrarMenus() {
            if (typeof contextMenu !== 'undefined' && contextMenu) contextMenu.style.display = 'none';
            if (typeof quitarMarcas === 'function') quitarMarcas();
            if (menuAbierto) menuAbierto.classList.remove('abierto');
            menuAbierto = null;
        }

        // Menús por orden alfabético (Ayuda siempre al final)
        { const fin = t => t === 'Ayuda' ? 1 : 0; MENUS.sort((a, b) => fin(a.titulo) - fin(b.titulo) || a.titulo.localeCompare(b.titulo, 'es', { sensitivity: 'base' })); } // Ayuda y Administración al final
        MENUS.forEach(def => {
            const nodo = document.createElement('div');
            nodo.className = 'menu-top';
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = def.titulo;
            const desplegable = document.createElement('div');
            desplegable.className = 'menu-desplegable';
            nodo.appendChild(btn);
            nodo.appendChild(desplegable);
            btn.addEventListener('click', e => {
                e.stopPropagation();
                if (menuAbierto === nodo) cerrarMenus(); else abrirMenu(nodo, def);
            });
            // Como en Windows: con un menú abierto, pasar el ratón por otro lo abre
            btn.addEventListener('mouseenter', () => { if (menuAbierto && menuAbierto !== nodo) abrirMenu(nodo, def); });
            barraMenus.appendChild(nodo);
        });

        document.addEventListener('mousedown', e => { if (menuAbierto && !barraMenus.contains(e.target)) cerrarMenus(); });

        // ==================================================================================
        // ATAJOS DE TECLADO DE LOS MENÚS
        // Se capturan antes que los del navegador (Ctrl+P imprimir, Ctrl+R recargar, Ctrl+G, Ctrl+O...).
        // ==================================================================================
        // ==================================================================================
        // v8.18 · PARTIR UNA TUBERÍA en dos tramos de la longitud indicada (con o sin componente en el corte)
        // ==================================================================================
        const COMPONENTES_CORTE = [['', 'Solo partir (sin componente)'], ['tee', 'Te'], ['cruce', 'Cruce'], ['injerto', 'Injerto: manguito soldado al tubo (toma para manómetro, vacuómetro...)'], ['manguito', 'Manguito de unión (en línea)']];
        async function partirTuberiaDialogo(id) {
            const t = elementosRed.find(e => e.id === id && e.type === 'tuberia'); if (!t) return;
            if (typeof planoCongelado !== 'undefined' && planoCongelado) { aviso('El plano está congelado.', 'error'); return; }
            const L = Math.round(+t.longitud || 0); if (L < 20) { aviso('La tubería es demasiado corta para partirla.', 'error'); return; }
            const r = await dialogo(`<i class="fa-solid fa-scissors text-blue-600 mr-1.5"></i>Partir ${esc(tagDe(t))}`,
                `<p class="mb-2">Longitud actual: <b>${L} mm</b>. La tubería se convierte en dos tramos.</p>
                <div class="grid grid-cols-2 gap-2">
                <label class="block">Tramo 1, desde el extremo a (mm)<input id="pt-l1" type="number" step="1" min="10" value="${Math.round(L / 2)}" oninput="if (document.getElementById('pt-total').checked) document.getElementById('pt-l2').value = Math.max(10, ${L} - (+this.value || 0))" class="w-full border rounded p-1.5 mt-0.5"></label>
                <label class="block">Tramo 2, hasta el extremo b (mm)<input id="pt-l2" type="number" step="1" min="10" value="${L - Math.round(L / 2)}" oninput="if (document.getElementById('pt-total').checked) document.getElementById('pt-l1').value = Math.max(10, ${L} - (+this.value || 0))" class="w-full border rounded p-1.5 mt-0.5"></label></div>
                <label class="flex items-center gap-1.5 mt-2"><input id="pt-total" type="checkbox" checked> Mantener la longitud total (${L} mm)</label>
                <label class="block mt-2">Componente en el corte<select id="pt-comp" class="w-full border rounded p-1.5 mt-0.5">${COMPONENTES_CORTE.filter(c => !c[0] || TIPOS[c[0]]).map(c => `<option value="${c[0]}">${esc(c[1])}</option>`).join('')}</select></label>
                <p class="text-[10px] text-slate-400 mt-2">Para un manómetro o vacuómetro: elige «Injerto», conecta un machón a su derivación y rosca en él el instrumento. Si desmarcas «Mantener la longitud total», lo que cuelga del extremo b se desplaza.</p>`,
                [{ texto: 'Partir', valor: 'si', clase: 'bg-blue-600 hover:bg-blue-700 text-white' }, { texto: 'Cancelar', valor: null }]);
            if (r !== 'si') return;
            const L1 = Math.round(+document.getElementById('pt-l1').value), L2 = Math.round(+document.getElementById('pt-l2').value), comp = document.getElementById('pt-comp').value;
            if (!(L1 >= 10) || !(L2 >= 10)) { aviso('Cada tramo tiene que medir al menos 10 mm.', 'error'); return; }
            partirTuberia(t, L1, L2, comp);
        }
        function partirTuberia(t, L1, L2, comp) {
            guardarEstado(); invalidarResultados();
            const pp = obtenerPuertosConexion(t), A = pp.find(p => p.id === 'a'), B = pp.find(p => p.id === 'b'), frac = L1 / (L1 + L2), antes = new Set(elementosRed.map(e => e.id)), za0 = +t.cotaA || 0, zb0 = +t.cotaB || 0, zc = +(za0 + (zb0 - za0) * frac).toFixed(3);
            let t2 = null, el = null;
            if (comp && TIPOS[comp]) {
                el = { id: 'sym_' + Date.now() + '_c', type: 'accesorio', subtype: comp, name: TIPOS[comp].nombre, x: 0, y: 0, scale: 1, rotation: t.rotation || 0, linea: t.linea };
                if (/^DN /.test(String(t.dn))) el.dn = t.dn;
                el.modoK = calcDe(el) === 'pedir' ? 'manual' : 'crane';
                normalizarElemento(el); elementosRed.push(el);
                if (!intentarPartirTuberia(el, A.x + (B.x - A.x) * frac, A.y + (B.y - A.y) * frac)) { elementosRed.splice(elementosRed.indexOf(el), 1); historialUndo.pop(); aviso('No cabe el componente en ese punto: el corte queda demasiado cerca de un extremo.', 'error'); return; }
                if (esNodo(el)) el.puertoEntrada = 'a';
                if (t.pn && typeof tieneRating === 'function') el.pn = t.pn;
                asignarNumero(el);
                t2 = elementosRed.find(e => e.type === 'tuberia' && !antes.has(e.id));
                t.cotaB = zc; el.cota = zc; if (t2) { t2.cotaA = zc; t2.cotaB = zb0; }
            } else {
                const L = +t.longitud, za = +t.cotaA || 0, zb = +t.cotaB || 0;
                t2 = JSON.parse(JSON.stringify(t));
                t2.id = 'sym_' + Date.now() + '_p'; t2.num = null; t2.codigo = null; delete t2.inicioLinea; delete t2.etq; delete t2.estado;
                t.longitud = Math.max(10, Math.round(L * frac)); t2.longitud = Math.max(10, L - t.longitud);
                t.cotaB = +(za + (zb - za) * frac).toFixed(3); t2.cotaA = t.cotaB;
                normalizarElemento(t2); elementosRed.splice(elementosRed.indexOf(t) + 1, 0, t2); asignarNumero(t2);
                colocarPorPuerto(t2, 'a', obtenerPuertosConexion(t).find(p => p.id === 'b'));
            }
            // longitudes exactas: lo que cuelga de cada tramo se desplaza con él (sin huecos)
            if (+t.longitud !== L1) aplicarCambio(t, 'longitud', L1);
            if (t2 && +t2.longitud !== L2) aplicarCambio(t2, 'longitud', L2);
            renderizarVectorial(); seleccionarElemento((el || t2 || t).id); marcarCambios(true);
            aviso(`${tagDe(t)} partida en dos: ${L1} mm + ${L2} mm${el ? ' con ' + tagDe(el) : ''}.`, 'ok');
        }

        // ==================================================================================
        // v8.18 · BOMBAS: datos del fabricante, tipos, curva por puntos y base de datos (piping_pumps)
        // ==================================================================================
        // filas de texto «Q  H  η  NPSHr» -> [[Q m³/h, H m, η %, NPSHr m]]
        function leerTextoCurva(texto) {
            const pts = [];
            String(texto || '').split(/\r?\n/).forEach(l => {
                const n = l.trim().replace(/(\d),(\d)/g, '$1.$2').split(/[\t;\s]+/).map(x => x === '' || x === '-' ? NaN : Number(x));
                if (n.length >= 2 && isFinite(n[0]) && isFinite(n[1]) && n[0] >= 0 && n[1] > 0) pts.push([n[0], n[1], isFinite(n[2]) ? n[2] : null, isFinite(n[3]) ? n[3] : null, isFinite(n[4]) ? n[4] : null]);
            });
            return pts.sort((a, b) => a[0] - b[0]);
        }
        // columnas: Q, H, η, NPSHr, P; los huecos intermedios se escriben «-» y los del final se omiten
        const textoDeCurva = pts => (pts || []).map(p => { const f = [p[0], p[1], p[2], p[3], p[4]].map(x => x == null || x === '' ? null : x); while (f.length > 2 && f[f.length - 1] == null) f.pop(); return f.map(x => x == null ? '-' : x).join('\t'); }).join('\n');
        // datos de una bomba de la librería -> elemento del plano (la altura en m se pasa a bar con el fluido del proyecto)
        function aplicarBombaLib(el, p) {
            const num = v => v === '' || v == null || isNaN(+v) ? null : +v, rho = (fluidoActual().rho || 1000), aBar = m => m * rho * G / 1e5;
            if (p.bombaTipo) el.bombaTipo = p.bombaTipo; else delete el.bombaTipo;
            if (num(p.caudal) != null) el.caudal = num(p.caudal);
            if (num(p.altura) != null) el.presion = +aBar(num(p.altura)).toFixed(4); else if (num(p.presion) != null) el.presion = num(p.presion);
            if (num(p.alturaCero) != null) el.h0 = +aBar(num(p.alturaCero)).toFixed(4); else if (num(p.h0) != null) el.h0 = num(p.h0); else if (num(p.altura) != null) el.h0 = +(el.presion * 1.2).toFixed(4);
            if (num(p.npsh) != null) el.npsh = num(p.npsh);
            if (num(p.eta) != null) el.eta = num(p.eta) > 1 ? num(p.eta) / 100 : num(p.eta);
            ['rpm', 'potMotor', 'impulsor', 'impulsorMax', 'volCilindrada', 'volCiclos', 'volPmax', 'volCilindros'].forEach(k => { if (num(p[k]) != null) el[k] = num(p[k]); else delete el[k]; });
            ['tension', 'frecuencia', 'ip', 'volMaterial', 'apiPlan', 'fluidoDiseno'].forEach(k => { if (p[k]) el[k] = p[k]; else delete el[k]; });
            if (p.dnAsp) el.dnAsp = p.dnAsp; if (p.dnImp) el.dnImp = p.dnImp;
            if (p.rating) { el.pnAsp = p.rating; el.pnImp = p.rating; }
            const pts = leerTextoCurva(p.curva);
            if (pts.length >= 2 && !esVolumetrica(el)) {
                el.curva = pts.map(q => [+q[0].toFixed(3), +aBar(q[1]).toFixed(4), q[2] == null ? null : q[2] / 100, q[3], q[4]]);
                el.curvaModo = 'puntos'; el.h0 = el.curva[0][1];
                if (!(el.caudal > 0)) el.caudal = el.curva[Math.floor(el.curva.length / 2)][0];
                if (num(p.altura) == null) el.presion = +interpolarCurva(el.curva, 1, el.caudal).toFixed(4);
            } else { delete el.curva; delete el.curvaModo; }
            if (esVolumetrica(el) && caudalVolumetrica(el) > 0) el.caudal = +caudalVolumetrica(el).toFixed(4);
        }
        // ---- base de datos de bombas (Supabase: piping_pumps, piping_pump_curves, piping_volumetric_pump_specs) ----
        var BOMBAS_BD = [], BOMBAS_ORIGEN = null, CARGA_BOMBAS = null;
        const TIPO_BD_BOMBA = { centrifuga: 'Centrifugal', peristaltica: 'Peristaltic', piston: 'Piston', dosificadora: 'Metering', membrana: 'Diaphragm', engranajes: 'Gear', tornillo: 'Screw', lobulos: 'Lobe' };
        const tipoDeBD = t => Object.keys(TIPO_BD_BOMBA).find(k => TIPO_BD_BOMBA[k].toLowerCase() === String(t || '').toLowerCase()) || 'centrifuga';
        function itemDeBombaBD(r) {
            const v = r.volumetric || {}, c = (r.curves || []).slice().sort((a, b) => a.flow_m3h - b.flow_m3h);
            return { id: r.pump_id, subtipo: 'bomba', grupo: 'bombas', origen: 'empresa', nombre: [r.manufacturer, r.model].filter(Boolean).join(' ') || r.tag_name || r.pump_id, fabricante: r.manufacturer || '', referencia: r.model || '', url: r.url || '', notas: r.notes || '', modificado_por: r.modificado_por || '',
                props: { tag: r.tag_name || '', bombaTipo: tipoDeBD(r.pump_type), fluidoDiseno: r.design_fluid || '', caudal: r.design_flow_m3h, altura: r.design_head_m, alturaCero: r.shutoff_head_m == null ? '' : r.shutoff_head_m, npsh: r.npshr_m == null ? '' : r.npshr_m, rpm: r.operational_rpm == null ? '' : r.operational_rpm,
                    potMotor: r.motor_power_kw == null ? '' : r.motor_power_kw, eta: r.efficiency_pct == null ? '' : r.efficiency_pct, tension: r.voltage || '', frecuencia: r.frequency_hz || '', ip: r.ip_rating || '', impulsor: r.impeller_mm == null ? '' : r.impeller_mm, impulsorMax: r.impeller_max_mm == null ? '' : r.impeller_max_mm,
                    dnAsp: r.suction_size || '', dnImp: r.discharge_size || '', normaBridas: r.flange_standard || '', rating: r.pressure_rating || '', apiPlan: r.api_plan || '',
                    curva: textoDeCurva(c.map(x => [x.flow_m3h, x.head_m, x.efficiency_pct, x.npshr_m, x.power_kw])),
                    volCilindrada: v.displacement_per_stroke_cm3 == null ? '' : v.displacement_per_stroke_cm3, volPmax: v.max_discharge_pressure_bar == null ? '' : v.max_discharge_pressure_bar, volCiclos: v.strokes_per_minute == null ? '' : v.strokes_per_minute, volCilindros: v.cylinders == null ? '' : v.cylinders, volMaterial: v.internal_material || '' } };
        }
        function bombaBDDeItem(b) {
            const p = b.props || {}, n = v => v === '' || v == null || isNaN(+String(v).replace(',', '.')) ? null : +String(v).replace(',', '.'), vol = p.bombaTipo && p.bombaTipo !== 'centrifuga';
            return { pump_id: /^usr:/.test(b.id) ? '' : b.id, tag_name: p.tag || '', pump_type: TIPO_BD_BOMBA[p.bombaTipo || 'centrifuga'], manufacturer: b.fabricante || '', model: b.referencia || b.nombre || '', design_fluid: p.fluidoDiseno || '',
                design_flow_m3h: n(p.caudal), design_head_m: n(p.altura), shutoff_head_m: n(p.alturaCero), npshr_m: n(p.npsh), operational_rpm: n(p.rpm), motor_power_kw: n(p.potMotor), efficiency_pct: n(p.eta) == null ? null : (n(p.eta) <= 1 ? n(p.eta) * 100 : n(p.eta)),
                voltage: p.tension || '', frequency_hz: p.frecuencia || '', ip_rating: p.ip || '', impeller_mm: n(p.impulsor), impeller_max_mm: n(p.impulsorMax), suction_size: p.dnAsp || '', discharge_size: p.dnImp || '', flange_standard: p.normaBridas || '', pressure_rating: p.rating || '', api_plan: p.apiPlan || '', url: b.url || '', notes: b.notas || '',
                curves: vol ? [] : leerTextoCurva(p.curva).map(q => ({ flow_m3h: q[0], head_m: q[1], efficiency_pct: q[2], npshr_m: q[3], power_kw: q[4] })),
                volumetric: vol ? { displacement_per_stroke_cm3: n(p.volCilindrada), max_discharge_pressure_bar: n(p.volPmax), strokes_per_minute: n(p.volCiclos), cylinders: n(p.volCilindros), internal_material: p.volMaterial || '' } : null };
        }
        function asegurarBombas(forzar) {
            if (CARGA_BOMBAS && !forzar) return CARGA_BOMBAS;
            return CARGA_BOMBAS = (async () => {
                BOMBAS_ORIGEN = 'local';
                if (typeof rpcUsuarios === 'function' && claveSupabase()) {
                    try { const d = await rpcUsuarios('piping_pumps_listar', {}); if (Array.isArray(d)) { BOMBAS_BD = d.map(itemDeBombaBD); BOMBAS_ORIGEN = 'supabase'; } } catch (e) { /* sin tablas (falta 08_bombas.sql), sin clave o sin red: librería local */ }
                }
                return BOMBAS_ORIGEN;
            })();
        }
        function bombasEnBD() { const s = typeof sesionActual === 'function' ? sesionActual() : null; return BOMBAS_ORIGEN === 'supabase' && !!s && s.origen === 'supabase' && s.rol === 'admin'; }
        async function guardarBombaBD(b) {
            const d = bombaBDDeItem(b);
            if (!(d.design_flow_m3h > 0)) { alert('Indica el caudal de diseño de la bomba.'); return; }
            if (!(d.design_head_m > 0)) { alert('Indica la altura manométrica de diseño (m).'); return; }
            if (d.volumetric && !(d.volumetric.max_discharge_pressure_bar > 0)) { alert('En una bomba volumétrica hay que indicar la presión máxima de trabajo.'); return; }
            try {
                const r = await rpcUsuarios('piping_pump_guardar', { p_token: sesionActual().token, p_item: d });
                await asegurarBombas(true); LIB.items = LIB.items.filter(i => i.id !== b.id); guardarLib();
                libVista.id = r.pump_id; const it = BOMBAS_BD.find(i => i.id === r.pump_id); libVista.borrador = it ? JSON.parse(JSON.stringify(it)) : null; pintarLibreria();
                aviso(`Bomba guardada en la base de datos: ${it ? it.nombre : r.pump_id}`, 'ok');
            } catch (e) { alert('No se ha podido guardar en la base de datos:\n' + e.message); }
        }
        async function eliminarBombaBD(it) {
            if (!confirm(`¿Eliminar «${it.nombre}» de la base de datos de bombas?\n\nSe eliminan también su curva y sus datos volumétricos. Las bombas ya colocadas en los planos conservan sus datos.`)) return;
            try { await rpcUsuarios('piping_pump_borrar', { p_token: sesionActual().token, p_id: it.id }); await asegurarBombas(true); libVista.id = null; libVista.borrador = null; pintarLibreria(); aviso('Bomba eliminada de la base de datos.', 'ok'); }
            catch (e) { alert('No se ha podido eliminar:\n' + e.message); }
        }

        // ==================================================================================
        // v8.19 · Ficha de bomba desde un PDF con IA (Gemini, a través de la función de servidor «piping-bomba-pdf»)
        // La IA rellena los campos de la ficha; el usuario los revisa antes de guardar. La curva no se lee de la gráfica: digitalizador.
        // ==================================================================================
        const FUNCION_IA_BOMBA = 'piping-bomba-pdf', MAX_MB_IA = 12;
        function iaDeBorrador(b) { const i = libVista && libVista.ia; return i && b && i.id === b.id ? i : null; }
        function cabeceraIABomba(b) {
            const i = iaDeBorrador(b), ocupado = libVista.iaOcupado;
            let h = `<div class="flex items-center gap-2 mb-2"><button type="button" onclick="rellenarBombaDesdePDF()" ${ocupado ? 'disabled' : ''} class="px-2 py-1.5 border border-blue-300 rounded text-blue-700 hover:bg-blue-50 whitespace-nowrap"><i class="fa-solid ${ocupado ? 'fa-spinner fa-spin' : 'fa-wand-magic-sparkles'} mr-1"></i>${ocupado ? 'Leyendo la ficha...' : 'Rellenar desde PDF (IA)...'}</button><span class="text-[10px] text-slate-400">Ficha técnica en PDF o imagen (máx. ${MAX_MB_IA} MB). El documento se envía a Google Gemini.</span></div>`;
            if (i) h += `<div id="lib-ia-aviso" class="mb-2 p-2 rounded border text-[11px]" style="background:#fffbeb;border-color:#fcd34d;color:#78350f"><b><i class="fa-solid fa-triangle-exclamation mr-1"></i>Datos leídos por IA de «${esc(i.archivo)}»: revisa los ${i.campos.length} campos marcados antes de guardar.</b>${i.sinCurva ? '<br>La curva no se lee de la gráfica: usa «Digitalizar desde una imagen...».' : ''}${i.conversiones ? '<br>Conversiones: ' + esc(i.conversiones) : ''}${i.avisos.length ? '<ul class="list-disc ml-4 mt-1">' + i.avisos.map(a => `<li>${esc(a)}</li>`).join('') + '</ul>' : ''}</div>`;
            return h;
        }
        function marcarCamposIA() {
            const i = iaDeBorrador(libVista && libVista.borrador); if (!i) return;
            document.querySelectorAll('#lib-form [data-lib]').forEach(x => {
                if (!i.campos.includes(x.dataset.lib)) return;
                x.style.background = '#fef3c7'; x.title = 'Leído por IA: revisar';
                const quitar = () => { x.style.background = ''; x.title = ''; i.campos = i.campos.filter(k => k !== x.dataset.lib); };
                x.addEventListener('change', quitar, { once: true });
            });
        }
        // respuesta de la IA -> campos de la ficha; solo se escriben los datos que vienen (los demás se conservan)
        function aplicarDatosIABomba(b, d, archivo) {
            const campos = [], P = b.props = b.props || {};
            const nn = v => typeof v === 'number' && isFinite(v) ? v : (typeof v === 'string' && v.trim() !== '' && isFinite(+v.replace(',', '.')) ? +v.replace(',', '.') : null);
            const tt = v => v == null ? '' : String(v).trim();
            const raiz = (k, v) => { v = tt(v); if (v) { b[k] = v; campos.push(k); } };
            const prop = (k, v) => { if (v === '' || v == null) return; P[k] = v; campos.push('p.' + k); };
            const red = v => { v = nn(v); return v == null ? null : +v.toPrecision(6); };
            raiz('fabricante', d.fabricante); raiz('referencia', d.modelo);
            const nombre = [tt(d.fabricante), tt(d.modelo)].filter(Boolean).join(' ');
            if (nombre && (!tt(b.nombre) || libVista.ia0 === b.id)) { b.nombre = nombre; campos.push('nombre'); }
            prop('tag', tt(d.tag)); prop('fluidoDiseno', tt(d.fluido));
            if (TIPOS_BOMBA_LIB.some(t => t[0] === d.tipo)) prop('bombaTipo', d.tipo);
            prop('caudal', red(d.caudal_m3h)); prop('altura', red(d.altura_m)); prop('alturaCero', red(d.altura_caudal_cero_m)); prop('npsh', red(d.npshr_m));
            prop('rpm', red(d.rpm)); prop('potMotor', red(d.potencia_motor_kw));
            const eta = red(d.rendimiento_pct); prop('eta', eta != null && eta > 0 && eta <= 1 ? +(eta * 100).toFixed(2) : eta);
            prop('tension', tt(d.tension)); prop('frecuencia', tt(d.frecuencia)); prop('ip', tt(d.ip));
            prop('impulsor', red(d.impulsor_mm)); prop('impulsorMax', red(d.impulsor_max_mm));
            prop('volCilindrada', red(d.vol_cilindrada_cm3)); prop('volPmax', red(d.vol_pmax_bar)); prop('volCiclos', red(d.vol_ciclos_min)); prop('volCilindros', red(d.vol_cilindros)); prop('volMaterial', tt(d.vol_material));
            const avisos = (Array.isArray(d.avisos) ? d.avisos : []).map(tt).filter(Boolean).slice(0, 8);
            const dn = v => { v = nn(v); if (!(v > 0)) return ''; const c = LISTA_DN.map(k => [k, Math.abs(parseFloat(String(k).replace(/[^\d.]/g, '')) - v)]).sort((x, y) => x[1] - y[1])[0]; if (c && c[1] <= v * 0.08) return c[0]; avisos.push(`DN ${v} no está en la lista de tamaños: indícalo a mano.`); return ''; };
            prop('dnAsp', dn(d.dn_aspiracion_mm)); prop('dnImp', dn(d.dn_impulsion_mm));
            if (d.norma_bridas === 'ASME' || d.norma_bridas === 'EN') prop('normaBridas', d.norma_bridas);
            const rt = tt(d.rating);
            if (rt) {
                const m = rt.replace(',', '.').match(/(\d+(?:\.\d+)?)/), esPN = /pn/i.test(rt), cand = m ? (esPN ? 'PN ' + m[1] : m[1] + '#') : '';
                if (PN_LISTA_BRIDAS.includes(cand)) prop('rating', cand); else avisos.push(`PN / Rating «${rt}» no reconocido: indícalo a mano.`);
            }
            prop('apiPlan', tt(d.plan_sellado));
            const pts = (Array.isArray(d.curva_tabulada) ? d.curva_tabulada : []).map(q => [nn(q.q_m3h), nn(q.h_m), nn(q.eta_pct), nn(q.npshr_m)]).filter(q => q[0] != null && q[0] >= 0 && q[1] > 0).sort((x, y) => x[0] - y[0]);
            const vol = P.bombaTipo && P.bombaTipo !== 'centrifuga';
            if (pts.length >= 2 && !vol) prop('curva', textoDeCurva(pts));
            libVista.ia = { id: b.id, archivo, campos, avisos, conversiones: tt(d.conversiones), sinCurva: !vol && pts.length < 2 };
            return campos.length;
        }
        function leerArchivoBase64(f) { return new Promise((ok, mal) => { const r = new FileReader(); r.onload = () => ok(String(r.result).replace(/^data:[^,]*,/, '')); r.onerror = () => mal(new Error('No se puede leer el archivo.')); r.readAsDataURL(f); }); }
        async function llamarIABomba(f, pista) {
            const s = sesionActual(), k = claveSupabase();
            const r = await fetch(`${SUPABASE_URL}/functions/v1/${FUNCION_IA_BOMBA}`, { method: 'POST', headers: { apikey: k, Authorization: 'Bearer ' + k, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: s.token, mime: f.type || 'application/pdf', nombre: f.name, modelo: pista || '', datos: await leerArchivoBase64(f) }) });
            const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch (e) { }
            if (r.status === 404 && !(d && d.error)) throw new Error('La función «' + FUNCION_IA_BOMBA + '» no está desplegada en Supabase (Edge Functions).');
            if (!r.ok || !d || !d.datos) throw new Error((d && (d.error || d.message || d.msg)) || ('HTTP ' + r.status));
            return d;
        }
        function rellenarBombaDesdePDF() {
            const s = sesionActual();
            if (!claveSupabase() || !s || !s.token) { alert('La lectura con IA necesita la conexión con Supabase y una sesión iniciada con un usuario de la base de datos.\n\nOpciones > Supabase > Configurar conexión · Archivo > Administración > Iniciar sesión'); return; }
            if (libVista.iaOcupado) return;
            const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'application/pdf,image/png,image/jpeg,image/webp';
            inp.onchange = () => { if (inp.files && inp.files[0]) leerFichaBombaIA(inp.files[0]); };
            inp.click();
        }
        async function leerFichaBombaIA(f) {
            const b = leerFormLib(); if (!b) return;
            const mime = f.type || (/\.pdf$/i.test(f.name) ? 'application/pdf' : '');
            if (!/^(application\/pdf|image\/(png|jpeg|webp))$/.test(mime)) { alert('Formato no admitido: usa un PDF o una imagen PNG / JPG.'); return; }
            if (f.size > MAX_MB_IA * 1048576) { alert(`El archivo ocupa ${(f.size / 1048576).toFixed(1)} MB y el máximo es ${MAX_MB_IA} MB.\n\nSi es un catálogo completo, extrae a otro PDF solo las páginas de la bomba.`); return; }
            const pista = String(b.referencia || '').trim();
            libVista.ia0 = libVista.ia && libVista.ia.id === b.id ? b.id : (String(b.nombre || '').trim() ? null : b.id);   // el nombre solo se sustituye si estaba vacío o lo puso la IA
            libVista.iaOcupado = true; pintarLibreria();
            try {
                const r = await llamarIABomba(f, pista);
                libVista.iaOcupado = false;
                if (!libVista.borrador || libVista.borrador.id !== b.id) return;            // se ha cambiado de elemento mientras tanto
                const n = aplicarDatosIABomba(libVista.borrador, r.datos, f.name);
                pintarLibreria();
                aviso(n ? `IA: ${n} campos leídos de «${f.name}»${r.limite ? ` (${r.usadas_hoy}/${r.limite} lecturas de hoy)` : ''}. Revísalos antes de guardar.` : 'IA: no se ha encontrado ningún dato de bomba en el documento.', n ? 'ok' : 'error');
            } catch (e) { libVista.iaOcupado = false; pintarLibreria(); alert('No se ha podido leer la ficha con IA:\n' + e.message); }
        }

        // ==================================================================================
        // v8.18 · ASISTENTE DE DIGITALIZACIÓN de curvas de bomba: imagen -> calibración de ejes -> puntos (Q, H / η / NPSHr)
        // ==================================================================================
        const SERIES_DIG = { H: { nombre: 'Q – H (altura)', y: 'H', uds: [['m', 'm c.l.'], ['bar', 'bar']], color: '#2563eb' }, npsh: { nombre: 'Q – NPSHr', y: 'NPSHr', uds: [['m', 'm']], color: '#dc2626' },
            pot: { nombre: 'Q – P (potencia)', y: 'P', uds: [['kW', 'kW'], ['CV', 'CV'], ['HP', 'HP']], color: '#d97706' }, eta: { nombre: 'Q – η (rendimiento)', y: 'η', uds: [['%', '%']], color: '#16a34a' } };
        const UDS_Q_DIG = [['m3h', 'm³/h'], ['m3s', 'm³/s'], ['lmin', 'l/min'], ['ls', 'l/s']], F_Q_DIG = { m3h: 1, m3s: 3600, lmin: 0.06, ls: 3.6 }, F_P_DIG = { kW: 1, CV: 0.73549875, HP: 0.74569987 };
        const udQDig = s => (UDS_Q_DIG.find(u => u[0] === DIG.cal[s].uQ) || UDS_Q_DIG[0])[1], udYDig = s => (SERIES_DIG[s].uds.find(u => u[0] === DIG.cal[s].uY) || SERIES_DIG[s].uds[0])[1];
        let DIG = null;
        function abrirDigitalizador(alAplicar, previos) {
            let m = document.getElementById('modal-digit');
            if (!m) { m = document.createElement('div'); m.id = 'modal-digit'; m.className = 'fixed inset-0 bg-black/50 justify-center items-center'; m.style.cssText = 'display:none; z-index:3300'; document.body.appendChild(m); }
            const cal = s => ({ p0: null, px: null, py: null, x0: '', xmax: '', y0: '', ymax: '', logX: false, logY: false, uQ: 'm3h', uY: SERIES_DIG[s].uds[0][0] });
            DIG = { alAplicar, img: null, zoom: 1, ox: 0, oy: 0, modo: 'calibrar', paso: 0, serie: 'H', cal: { H: cal('H'), npsh: cal('npsh'), pot: cal('pot'), eta: cal('eta') }, pts: { H: [], npsh: [], pot: [], eta: [] }, arrastre: null, previos: previos || null };
            m.innerHTML = `<div class="bg-white rounded-lg shadow-2xl border border-slate-300 flex flex-col text-xs" style="width:min(1500px, 97vw); height:min(900px, 94vh)">
                <h3 class="text-sm font-bold text-slate-700 border-b px-4 py-2 flex items-center justify-between"><span><i class="fa-solid fa-crosshairs text-blue-600 mr-1.5"></i>Digitalizar la curva de la bomba desde una imagen</span><button onclick="cerrarDigitalizador()" class="text-slate-400 hover:text-slate-600"><i class="fa-solid fa-xmark"></i></button></h3>
                <div class="flex flex-1 min-h-0"><div id="dig-panel" class="w-[330px] flex-none border-r p-3 overflow-y-auto space-y-2"></div>
                <div id="dig-lienzo" class="flex-1 relative bg-slate-100 overflow-hidden" style="cursor:crosshair"><canvas id="dig-canvas" style="position:absolute; left:0; top:0"></canvas><div id="dig-vacio" class="absolute inset-0 flex items-center justify-center text-slate-400 text-center pointer-events-none"><div><i class="fa-solid fa-image text-4xl mb-2"></i><br>Arrastra aquí la imagen de la curva (PNG, JPG o PDF),<br>pégala con Ctrl+V o usa «Cargar imagen».</div></div></div></div></div>`;
            m.style.display = 'flex';
            const L = document.getElementById('dig-lienzo'), C = document.getElementById('dig-canvas');
            const alPunto = ev => { const r = L.getBoundingClientRect(); return { x: (ev.clientX - r.left - DIG.ox) / DIG.zoom, y: (ev.clientY - r.top - DIG.oy) / DIG.zoom }; };
            L.addEventListener('dragover', ev => { ev.preventDefault(); });
            L.addEventListener('drop', ev => { ev.preventDefault(); const f = ev.dataTransfer.files && ev.dataTransfer.files[0]; if (f) cargarImagenDig(f); });
            L.addEventListener('wheel', ev => { if (!DIG.img) return; ev.preventDefault(); const r = L.getBoundingClientRect(), mx = ev.clientX - r.left, my = ev.clientY - r.top, z = Math.min(40, Math.max(0.05, DIG.zoom * (ev.deltaY < 0 ? 1.2 : 1 / 1.2)));
                DIG.ox = mx - (mx - DIG.ox) * z / DIG.zoom; DIG.oy = my - (my - DIG.oy) * z / DIG.zoom; DIG.zoom = z; pintarDig(); }, { passive: false });
            L.addEventListener('mousedown', ev => { if (!DIG.img) return; if (ev.button === 1 || ev.button === 2 || ev.shiftKey || DIG.modo === 'mover') { ev.preventDefault(); DIG.arrastre = { x: ev.clientX, y: ev.clientY, ox: DIG.ox, oy: DIG.oy, movido: false }; } });
            L.addEventListener('mousemove', ev => { if (DIG && DIG.arrastre) { DIG.ox = DIG.arrastre.ox + ev.clientX - DIG.arrastre.x; DIG.oy = DIG.arrastre.oy + ev.clientY - DIG.arrastre.y; DIG.arrastre.movido = true; pintarDig(); } else if (DIG && DIG.img) { const p = alPunto(ev), v = valorDig(DIG.serie, p), e = document.getElementById('dig-cursor'); if (e) e.textContent = v ? `Q ${fmt(v[0], 2)} ${udQDig(DIG.serie)} · ${SERIES_DIG[DIG.serie].y} ${fmt(v[1], 2)} ${udYDig(DIG.serie)}` : `píxel ${Math.round(p.x)}, ${Math.round(p.y)}`; } });
            window.addEventListener('mouseup', () => { if (DIG) DIG.arrastre = null; });
            L.addEventListener('contextmenu', ev => ev.preventDefault());
            L.addEventListener('click', ev => { if (!DIG.img || ev.shiftKey || DIG.modo === 'mover') return; clicDig(alPunto(ev)); });
            DIG.pegar = ev => { if (!DIG || document.getElementById('modal-digit').style.display !== 'flex') return; const it = [...(ev.clipboardData ? ev.clipboardData.items : [])].find(i => i.type && i.type.startsWith('image/')); if (it) { ev.preventDefault(); cargarImagenDig(it.getAsFile()); } };
            window.addEventListener('paste', DIG.pegar);
            pintarPanelDig();
        }
        function cerrarDigitalizador() { const m = document.getElementById('modal-digit'); if (m) m.style.display = 'none'; if (DIG && DIG.pegar) window.removeEventListener('paste', DIG.pegar); DIG = null; }
        async function cargarImagenDig(file) {
            if (!file) return;
            const poner = img => { DIG.img = img; const L = document.getElementById('dig-lienzo'), z = Math.min(L.clientWidth / img.width, L.clientHeight / img.height) * 0.96; DIG.zoom = z; DIG.ox = (L.clientWidth - img.width * z) / 2; DIG.oy = (L.clientHeight - img.height * z) / 2; document.getElementById('dig-vacio').style.display = 'none'; pintarDig(); pintarPanelDig(); };
            if (/pdf$/i.test(file.type) || /\.pdf$/i.test(file.name || '')) {
                try {
                    if (!window.pdfjsLib) await new Promise((ok, mal) => { const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js'; s.onload = ok; s.onerror = mal; document.head.appendChild(s); });
                    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
                    const pdf = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
                    let n = 1; if (pdf.numPages > 1) n = Math.min(pdf.numPages, Math.max(1, parseInt(prompt(`El PDF tiene ${pdf.numPages} páginas. ¿Qué página contiene la curva?`, '1'), 10) || 1));
                    const pg = await pdf.getPage(n), vp = pg.getViewport({ scale: 2.5 }), c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
                    await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise; poner(c);
                } catch (e) { alert('No se ha podido abrir el PDF. Haz una captura de pantalla de la curva y pégala con Ctrl+V.'); }
                return;
            }
            const url = URL.createObjectURL(file), img = new Image(); img.onload = () => poner(img); img.onerror = () => alert('No se ha podido leer la imagen.'); img.src = url;
        }
        // píxel de la imagen -> valor real, con la calibración de la serie (lineal o logarítmica)
        function valorDig(serie, p) {
            const c = DIG.cal[serie]; if (!c.p0 || !c.px || !c.py || c.x0 === '' || c.y0 === '' || c.xmax === '' || c.ymax === '') return null;
            const x0 = +c.x0, x1 = +c.xmax, y0 = +c.y0, y1 = +c.ymax, tx = (p.x - c.p0.x) / (c.px.x - c.p0.x), ty = (c.p0.y - p.y) / (c.p0.y - c.py.y);
            if (!isFinite(tx) || !isFinite(ty)) return null;
            const X = c.logX && x0 > 0 && x1 > 0 ? x0 * Math.pow(x1 / x0, tx) : x0 + tx * (x1 - x0), Y = c.logY && y0 > 0 && y1 > 0 ? y0 * Math.pow(y1 / y0, ty) : y0 + ty * (y1 - y0);
            return [X, Y];
        }
        const calibradaDig = s => { const c = DIG.cal[s]; return !!(c.p0 && c.px && c.py && c.x0 !== '' && c.y0 !== '' && c.xmax !== '' && c.ymax !== '' && +c.xmax !== +c.x0 && +c.ymax !== +c.y0); };
        // valor de un eje, pedido en el momento de marcar el punto (también se puede corregir después en el panel)
        function pedirValorDig(c, k, texto) {
            const r = prompt(texto, c[k] === '' ? '' : String(c[k])); if (r == null) return;
            const v = parseFloat(String(r).replace(',', '.')); if (isFinite(v)) c[k] = v;
        }
        function clicDig(p) {
            const s = DIG.serie, c = DIG.cal[s], d = SERIES_DIG[s];
            if (DIG.modo === 'calibrar') {
                if (DIG.paso === 0) { c.p0 = p; pintarDig(); pedirValorDig(c, 'x0', `${d.nombre}\nCaudal en el origen de los ejes (${udQDig(s)}):`); pedirValorDig(c, 'y0', `${d.nombre}\n${d.y} en el origen de los ejes (${udYDig(s)}):\n\nOjo: el eje vertical no siempre empieza en 0.`); }
                else if (DIG.paso === 1) { c.px = p; pintarDig(); pedirValorDig(c, 'xmax', `${d.nombre}\nCaudal en el punto marcado del eje X (${udQDig(s)}):`); }
                else { c.py = p; pintarDig(); pedirValorDig(c, 'ymax', `${d.nombre}\n${d.y} en el punto marcado del eje Y (${udYDig(s)}):`); }
                DIG.paso++; if (DIG.paso > 2) { DIG.paso = 0; DIG.modo = 'capturar'; }
            } else if (DIG.modo === 'capturar') {
                if (!calibradaDig(s)) { aviso('Antes de capturar puntos, calibra los ejes de este gráfico e indica sus valores.', 'error'); return; }
                DIG.pts[s].push(p);
            }
            pintarDig(); pintarPanelDig();
        }
        function cambiarSerieDig(s) {
            const ant = DIG.cal[DIG.serie], c = DIG.cal[s];
            if (!c.p0 && !DIG.pts[s].length) c.uQ = ant.uQ;                      // un gráfico nuevo hereda la unidad de caudal del anterior
            DIG.serie = s; DIG.paso = 0; DIG.modo = calibradaDig(s) ? 'capturar' : 'calibrar'; pintarDig(); pintarPanelDig();
        }
        function puntosDig(serie) { return DIG.pts[serie].map(p => valorDig(serie, p)).filter(Boolean).sort((a, b) => a[0] - b[0]); }
        function pintarDig() {
            const L = document.getElementById('dig-lienzo'), C = document.getElementById('dig-canvas'); if (!C || !DIG) return;
            C.width = L.clientWidth; C.height = L.clientHeight; const g = C.getContext('2d'); g.clearRect(0, 0, C.width, C.height); if (!DIG.img) return;
            g.imageSmoothingEnabled = DIG.zoom < 2;
            g.drawImage(DIG.img, DIG.ox, DIG.oy, DIG.img.width * DIG.zoom, DIG.img.height * DIG.zoom);
            const S = p => [DIG.ox + p.x * DIG.zoom, DIG.oy + p.y * DIG.zoom];
            const cruz = (p, color, txt) => { const [x, y] = S(p); g.strokeStyle = color; g.lineWidth = 2; g.beginPath(); g.moveTo(x - 9, y); g.lineTo(x + 9, y); g.moveTo(x, y - 9); g.lineTo(x, y + 9); g.stroke(); g.fillStyle = color; g.font = 'bold 11px sans-serif'; g.fillText(txt, x + 7, y - 7); };
            Object.keys(SERIES_DIG).forEach(s => { const c = DIG.cal[s], col = s === DIG.serie ? '#7c3aed' : '#a78bfa'; if (s !== DIG.serie && !DIG.pts[s].length) return;
                if (c.p0) cruz(c.p0, col, 'origen'); if (c.px) cruz(c.px, col, 'X máx'); if (c.py) cruz(c.py, col, 'Y máx'); });
            Object.entries(SERIES_DIG).forEach(([s, d]) => { const pts = DIG.pts[s].slice().sort((a, b) => a.x - b.x); if (!pts.length) return;
                g.strokeStyle = d.color; g.lineWidth = 1.5; g.beginPath(); pts.forEach((p, i) => { const [x, y] = S(p); if (i) g.lineTo(x, y); else g.moveTo(x, y); }); g.stroke();
                pts.forEach(p => { const [x, y] = S(p); g.beginPath(); g.arc(x, y, 4.5, 0, 6.2832); g.fillStyle = d.color; g.fill(); g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.stroke(); }); });
        }
        function pintarPanelDig() {
            const P = document.getElementById('dig-panel'); if (!P || !DIG) return;
            const s = DIG.serie, c = DIG.cal[s], sd = SERIES_DIG[s], nomY = sd.y, uq = udQDig(s), uy = udYDig(s);
            const pasoTxt = [`1.º clic: origen de los ejes de este gráfico; se piden el caudal y ${nomY} en ese punto`, '2.º clic: un punto conocido del eje X (caudal máximo); se pide su valor', `3.º clic: un punto conocido del eje Y (${nomY} máximo); se pide su valor`][DIG.paso];
            const btn = (modo, ic, t) => `<button onclick="DIG.modo = '${modo}'; ${modo === 'calibrar' ? "DIG.paso = 0; const k = DIG.cal[DIG.serie]; k.p0 = k.px = k.py = null; DIG.pts[DIG.serie] = [];" : ''} pintarDig(); pintarPanelDig()" class="flex-1 px-2 py-1.5 rounded border ${DIG.modo === modo ? 'bg-blue-600 text-white border-blue-600' : 'hover:bg-slate-50'}"><i class="fa-solid ${ic} mr-1"></i>${t}</button>`;
            const inp = (k, et) => `<label class="block">${et}<input type="number" step="any" value="${c[k]}" oninput="DIG.cal[DIG.serie].${k} = this.value; pintarTablaDig()" class="w-full border rounded p-1 mt-0.5"></label>`;
            const selU = (k, ops) => `<select onchange="DIG.cal[DIG.serie].${k} = this.value; pintarPanelDig()" class="w-full border rounded p-1 mt-0.5" ${ops.length < 2 ? 'disabled' : ''}>${ops.map(o => `<option value="${o[0]}" ${o[0] === c[k] ? 'selected' : ''}>${o[1]}</option>`).join('')}</select>`;
            const estado = k => calibradaDig(k) ? (DIG.pts[k].length ? ` · ${DIG.pts[k].length} puntos` : ' · calibrado') : '';
            P.innerHTML = `<div class="flex gap-1"><label class="flex-1 px-2 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded text-center cursor-pointer"><i class="fa-solid fa-folder-open mr-1"></i>Cargar imagen<input type="file" accept="image/*,.pdf" class="hidden" onchange="cargarImagenDig(this.files[0])"></label></div>
                <div class="border rounded p-2 space-y-1"><label class="block font-bold text-slate-600">1. Gráfico que se digitaliza<select id="dig-serie" onchange="cambiarSerieDig(this.value)" class="w-full border rounded p-1 mt-0.5 font-normal">${Object.entries(SERIES_DIG).map(([k, d]) => `<option value="${k}" ${k === s ? 'selected' : ''}>${d.nombre}${estado(k)}</option>`).join('')}</select></label>
                    <div class="grid grid-cols-2 gap-1"><label class="block">Unidad del caudal${selU('uQ', UDS_Q_DIG)}</label><label class="block">Unidad de ${nomY}${selU('uY', sd.uds)}</label></div>
                    <p class="text-[10px] text-slate-400">Cada gráfico (Q – H, Q – NPSHr, Q – P) tiene sus propios ejes: se calibra por separado, con sus unidades.</p></div>
                <p class="font-bold text-slate-600">2. Calibrar los ejes y capturar la curva</p>
                <div class="flex gap-1">${btn('calibrar', 'fa-ruler-combined', 'Calibrar')}${btn('capturar', 'fa-location-crosshairs', 'Capturar')}${btn('mover', 'fa-hand', 'Mover')}</div>
                <p class="rounded p-2 ${DIG.modo === 'calibrar' ? 'bg-violet-50 text-violet-800 border border-violet-200' : 'bg-slate-50 text-slate-500 border'}">${!DIG.img ? 'Carga primero la imagen de la curva.' : DIG.modo === 'calibrar' ? '<b>Calibración · ' + sd.nombre + '.</b> ' + pasoTxt : DIG.modo === 'capturar' ? '<b>Captura · ' + sd.nombre + '.</b> Haz clic sobre la curva, de 5 a 15 puntos repartidos entre el caudal mínimo y el máximo.' : 'Arrastra para mover la imagen. La rueda del ratón acerca y aleja.'}</p>
                <div class="border rounded p-2 space-y-1"><p class="font-bold text-slate-600">Valores de los ejes · ${sd.nombre}</p>
                    <div class="grid grid-cols-2 gap-1">${inp('x0', `Q en el origen (${uq})`)}${inp('xmax', `Q en el punto X máx (${uq})`)}${inp('y0', `${nomY} en el origen (${uy})`)}${inp('ymax', `${nomY} en el punto Y máx (${uy})`)}</div>
                    <div class="flex gap-3"><label><input type="checkbox" ${c.logX ? 'checked' : ''} onchange="DIG.cal[DIG.serie].logX = this.checked; pintarTablaDig()"> Eje X logarítmico</label><label><input type="checkbox" ${c.logY ? 'checked' : ''} onchange="DIG.cal[DIG.serie].logY = this.checked; pintarTablaDig()"> Eje Y logarítmico</label></div>
                    ${s === 'eta' && calibradaDig('H') ? `<button onclick="const h = DIG.cal.H, k = DIG.cal[DIG.serie]; Object.assign(k, { p0: h.p0, px: h.px, py: h.py, x0: h.x0, xmax: h.xmax, logX: h.logX, uQ: h.uQ }); pintarDig(); pintarPanelDig()" class="px-2 py-1 border rounded hover:bg-slate-50 w-full">Usar los mismos puntos de ejes que Q – H</button>` : ''}
                    <p class="text-[10px] ${calibradaDig(s) ? 'text-emerald-700' : 'text-amber-700'}">${calibradaDig(s) ? 'Ejes calibrados.' : 'Faltan: ' + [!c.p0 && 'clic en el origen', !c.px && 'clic en X máx', !c.py && 'clic en Y máx', c.x0 === '' && 'valor de Q en el origen', c.y0 === '' && 'valor de ' + nomY + ' en el origen', c.xmax === '' && 'valor de Q máx', c.ymax === '' && 'valor de ' + nomY + ' máx'].filter(Boolean).join(', ') + '.'}</p></div>
                <div id="dig-tabla"></div>
                <p id="dig-cursor" class="text-[10px] text-slate-400 font-mono">&nbsp;</p>
                ${DIG.pts.pot.length && !DIG.pts.eta.length ? '<p class="text-[10px] text-slate-400">Sin curva de η, el rendimiento se calcula con la potencia: η = ρ·g·Q·H / P.</p>' : ''}
                <div class="flex gap-1 pt-1 border-t"><button onclick="DIG.pts[DIG.serie].pop(); pintarDig(); pintarPanelDig()" class="px-2 py-1.5 border rounded hover:bg-slate-50"><i class="fa-solid fa-rotate-left mr-1"></i>Deshacer punto</button><span class="flex-1"></span>
                    <button onclick="cerrarDigitalizador()" class="px-2 py-1.5 border rounded">Cancelar</button><button onclick="aplicarDigitalizador()" class="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded font-medium">Aplicar</button></div>`;
            pintarTablaDig();
        }
        function pintarTablaDig() {
            const T = document.getElementById('dig-tabla'); if (!T || !DIG) return;
            T.innerHTML = Object.entries(SERIES_DIG).filter(([s]) => DIG.pts[s].length).map(([s, d]) => { const pts = puntosDig(s);
                return `<div class="border rounded"><p class="px-2 py-1 font-bold" style="color:${d.color}">${d.nombre} · ${pts.length} puntos</p><div style="max-height:130px; overflow-y:auto"><table class="w-full font-mono text-[11px]"><tbody>${pts.map(p => `<tr class="border-t"><td class="px-2">${fmt(p[0], 2)} ${udQDig(s)}</td><td class="px-2">${fmt(p[1], 2)} ${udYDig(s)}</td></tr>`).join('')}</tbody></table></div></div>`; }).join('') || '<p class="text-slate-400 italic">Sin puntos capturados.</p>';
        }
        function aplicarDigitalizador() {
            // cada serie, en unidades de trabajo: Q en m³/h; H en m; NPSHr en m; P en kW; η en %
            const rho = fluidoActual().rho || 1000, enBar = DIG.cal.H.uY === 'bar';
            const conv = s => puntosDig(s).map(p => [p[0] * F_Q_DIG[DIG.cal[s].uQ], s === 'H' && enBar ? p[1] * 1e5 / (rho * G) : s === 'pot' ? p[1] * F_P_DIG[DIG.cal.pot.uY] : p[1]]).sort((a, b) => a[0] - b[0]);
            const H = conv('H'), E = conv('eta'), N = conv('npsh'), W = conv('pot');
            if (H.length < 2) { alert('Captura al menos dos puntos de la curva Q – H.'); return; }
            const int = (S, q) => S.length ? interpolarCurva(S, 1, q) : null, rhoP = enBar ? rho : 1000;   // curvas de catálogo en m: agua
            // normalización: η, NPSHr y P interpolados en los caudales de la curva Q – H
            const filas = H.map(p => { const q = +p[0].toFixed(3), h = +p[1].toFixed(3), w = W.length ? int(W, q) : null;
                let e = E.length ? int(E, q) : null; if (e == null && w > 0 && q > 0) { e = 100 * rhoP * G * q * h / 3.6e6 / w; if (!(e > 0 && e < 100)) e = null; }
                return [q, h, e == null ? null : +e.toFixed(2), N.length ? +int(N, q).toFixed(2) : null, w == null ? null : +w.toFixed(3)]; });
            const f = DIG.alAplicar; cerrarDigitalizador(); if (f) f(filas);
        }
        // Escape cierra la ventana que está encima: devuelve la función que la cierra (o null si no hay ninguna abierta)
        function ventanaSuperior() {
            const V = [['modal-digit', cerrarDigitalizador], ['modal-dialogo', () => { const b = document.querySelector('#dialogo-botones [data-esc]'); if (b) b.click(); }],
                ['modal-proyecto', cerrarDatosProyecto], ['modal-libreria', cerrarLibreria], ['modal-nuevo', cancelarModalNuevo], ['modal-creditos', cerrarCreditos],
                ['modal-masivo', cerrarTablaPropiedades], ['modal-red', cerrarModalRed], ['paleta', cerrarPaleta], ['panel-buscar', cerrarBuscarReemplazar], ['modal-edicion', cerrarModal]];
            // trazando, con la mano o en zoom ventana, Escape cancela eso y no cierra las ventanas flotantes
            let ocupado = false; try { ocupado = !!traza || !!enMano || !!modoZoomVentana; } catch (e) { }
            let mejor = null, zMax = -1;
            V.forEach(([id, fn]) => { const d = document.getElementById(id); if (!d || (ocupado && (id === 'modal-edicion' || id === 'panel-buscar'))) return; const cs = getComputedStyle(d); if (cs.display === 'none' || cs.visibility === 'hidden') return;
                const z = +cs.zIndex || 0; if (z > zMax) { zMax = z; mejor = fn; } });
            return mejor;
        }
        function atajosMenu(e) {
            const activo = document.activeElement;
            const enCampo = activo && (['INPUT', 'TEXTAREA', 'SELECT'].includes(activo.tagName) || activo.isContentEditable);
            const ctrl = e.ctrlKey || e.metaKey;
            const k = (e.key || '').toLowerCase();
            let accion = null;

            if (e.key === 'Escape') {
                const sup = ventanaSuperior();
                if (menuAbierto) accion = () => {};
                else if (sup) accion = sup;
                else if (document.getElementById('modal-creditos').style.display === 'flex') accion = cerrarCreditos;
                else if (document.getElementById('modal-masivo').style.display === 'flex') accion = cerrarTablaPropiedades;
                else if (panelAvisosAbierto && !enCampo && !seleccion.size) accion = () => alternarPanelAvisos(false);
                else if (!enCampo && seleccion.size && !modoZoomVentana) accion = limpiarSeleccion;
            }
            // el resto de atajos: registro de atajos (CAD > Atajos de teclado)

            if (accion) {
                e.preventDefault();
                e.stopPropagation();
                cerrarMenus();
                accion();
            }
        }
        window.addEventListener('keydown', atajosMenu, true);
        if (idioma !== 'es') setTimeout(() => cambiarIdioma(idioma, true), 0);
    
        // partes: en segundo plano tras arrancar (o de inmediato si lo pide la página, p. ej. en las pruebas)
        if (typeof PARTES_LISTA !== 'undefined') {
            if (window.PIPING_PRECARGA) PARTES_LISTA.forEach(g => document.write(`<script src="js/partes/${g}.js?v=${VERSION_WEB}"><\/script>`));
            else window.addEventListener('load', () => setTimeout(() => cargarTodasLasPartes().then(() => asegurarAccesorios()), 2500));
        }
