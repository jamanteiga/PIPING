// PIPING v8.19 · Edge Function «piping-bomba-pdf» (v8.23: caudal mínimo y presión máxima del cuerpo · v8.25: conexiones · v8.26: válvulas)
// Lee la ficha técnica de una bomba o de una válvula (campo «clase»: 'bomba' | 'valvula') con Google Gemini y devuelve los datos en JSON.
// Secretos (Supabase > Edge Functions > Secrets):
//   GEMINI_API_KEY   clave de Google AI Studio (obligatoria; nunca va en el navegador)
//   GEMINI_MODEL     opcional; por defecto gemini-3.8-flash
// SUPABASE_URL y SUPABASE_ANON_KEY los pone Supabase.
// Desplegar con «Verify JWT» desactivado: la función valida la sesión de PIPING (piping_ia_permiso).

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const MAX_BYTES = 12 * 1024 * 1024;
const TIPOS = ["centrifuga", "peristaltica", "piston", "dosificadora", "membrana", "engranajes", "tornillo", "lobulos"];
const MIMES = ["application/pdf", "image/png", "image/jpeg", "image/webp"];

const num = (d: string) => ({ type: ["number", "null"], description: d });
const txt = (d: string) => ({ type: ["string", "null"], description: d });
const ESQUEMA = {
  type: "object",
  properties: {
    fabricante: txt("Fabricante de la bomba"),
    modelo: txt("Modelo / referencia exacta de la bomba"),
    tag: txt("Tag o ítem del equipo si figura (p. ej. P-101A)"),
    tipo: { type: ["string", "null"], enum: [...TIPOS, null], description: "Tipo de bomba" },
    fluido: txt("Fluido de diseño"),
    caudal_m3h: num("Caudal en el punto de diseño, en m3/h"),
    altura_m: num("Altura manométrica en el punto de diseño, en m de columna de líquido"),
    altura_caudal_cero_m: num("Altura a caudal cero (shut-off head), en m"),
    npshr_m: num("NPSH requerido en el punto de diseño, en m"),
    rpm: num("Velocidad de rotación, rpm"),
    potencia_motor_kw: num("Potencia nominal del motor, kW"),
    rendimiento_pct: num("Rendimiento hidráulico en el punto de diseño, en %"),
    tension: txt("Tensión de alimentación, p. ej. 400 V 3~"),
    frecuencia: txt("Frecuencia, p. ej. 50 Hz"),
    ip: txt("Grado de protección, p. ej. IP55"),
    impulsor_mm: num("Diámetro del impulsor instalado, mm"),
    impulsor_max_mm: num("Diámetro máximo del impulsor, mm"),
    dn_aspiracion_mm: num("Diámetro nominal de la brida de aspiración, DN en mm (2 pulgadas = 50)"),
    dn_impulsion_mm: num("Diámetro nominal de la brida de impulsión, DN en mm"),
    norma_bridas: { type: ["string", "null"], enum: ["ASME", "EN", null], description: "Norma de las bridas: ASME (ANSI, clases en #) o EN (DIN, PN)" },
    rating: txt("PN o rating de las bridas, escrito 'PN 16' o '150#'"),
    conexion_aspiracion: { type: ["string", "null"], enum: ["Bridada", "Roscada", "Soldada a tope (BW)", "Socket weld (SW)", "Clamp sanitario", "Ranurada (Victaulic)", "Racor / manguito", null], description: "Tipo de conexión de la aspiración" },
    conexion_impulsion: { type: ["string", "null"], enum: ["Bridada", "Roscada", "Soldada a tope (BW)", "Socket weld (SW)", "Clamp sanitario", "Ranurada (Victaulic)", "Racor / manguito", null], description: "Tipo de conexión de la impulsión" },
    norma_conexion: txt("Norma de la brida o de la rosca tal como figura en la ficha, p. ej. 'EN 1092-1', 'ASME B16.5', 'NPT', 'BSPP (ISO 228-1)', 'BSPT (ISO 7-1)'"),
    plan_sellado: txt("Plan de sellado API 682 o tipo de cierre"),
    caudal_minimo_m3h: num("Caudal mínimo continuo (estable / térmico) recomendado por el fabricante, m3/h"),
    presion_max_cuerpo_bar: num("Presión máxima admisible del cuerpo de la bomba (carcasa), bar"),
    vol_cilindrada_cm3: num("Bombas volumétricas: volumen por ciclo o revolución, cm3"),
    vol_pmax_bar: num("Bombas volumétricas: presión máxima de trabajo, bar"),
    vol_ciclos_min: num("Bombas volumétricas: ciclos, emboladas o revoluciones por minuto"),
    vol_cilindros: num("Bombas volumétricas: número de cilindros o cabezales"),
    vol_material: txt("Bombas volumétricas: material de manguera, membrana, válvulas o sellos"),
    curva_tabulada: {
      type: "array",
      description: "Puntos de la curva SOLO si el documento los da en una tabla numérica. Nunca leídos de una gráfica.",
      items: {
        type: "object",
        properties: { q_m3h: { type: "number" }, h_m: { type: "number" }, eta_pct: { type: ["number", "null"] }, npshr_m: { type: ["number", "null"] } },
        required: ["q_m3h", "h_m"],
      },
    },
    // v8.51 · cotas del dibujo de dimensiones (mm), para el modelo 3D paramétrico
    disposicion: { type: ["string", "null"], enum: ["horizontal", "en_linea", "vertical", null], description: "Disposición: horizontal (aspiración axial, impulsión vertical hacia arriba), en línea (aspiración e impulsión alineadas) o vertical" },
    cota_a_mm: num("Cotas: distancia de la cara de la boca de aspiración al eje de la boca de impulsión, mm"),
    cota_f_mm: num("Cotas: longitud total de la bomba con el motor, mm"),
    cota_h1_mm: num("Cotas: altura del eje (suelo / apoyo al eje del rodete), mm"),
    cota_h2_mm: num("Cotas: altura de la cara de la boca de impulsión sobre el apoyo, mm"),
    cota_h3_mm: num("Cotas: altura total, mm"),
    cota_n1_mm: num("Cotas: largo de la base o de los pies (en la dirección del eje), mm"),
    cota_n2_mm: num("Cotas: ancho de la base o de los pies, mm"),
    conversiones: txt("Conversiones de unidades hechas (p. ej. '120 gpm -> 27,3 m3/h')"),
    avisos: { type: "array", items: { type: "string" }, description: "Dudas, ambigüedades o datos de varios modelos en el mismo documento" },
  },
  required: ["fabricante", "modelo", "tipo", "caudal_m3h", "altura_m", "curva_tabulada", "avisos"],
};

const INSTRUCCIONES = `Eres un ingeniero que extrae datos de la ficha técnica de una bomba para una base de datos.
Reglas:
- Devuelve solo lo que el documento dice de forma explícita. Si un dato no aparece, null. No estimes ni inventes.
- Convierte a las unidades pedidas (m3/h, m, kW, mm, bar, cm3) y anota cada conversión en "conversiones". Presión diferencial a altura: usa la densidad indicada en el documento; si no hay, agua (10,2 m por bar) y avísalo.
- No leas valores de las gráficas: los puntos de la curva solo si están en una tabla numérica. Si solo hay gráfica, "curva_tabulada" vacía.
- Si el documento es un catálogo con varios modelos o tamaños, toma el indicado por el usuario; si no indica ninguno, el primero, y dilo en "avisos" junto con la lista de modelos encontrados.
- Si el documento no es la ficha de una bomba, deja todo en null y explícalo en "avisos".
- Cotas: solo si hay dibujo o tabla de dimensiones; usa las letras del fabricante para identificar cada cota y dilo en "conversiones" (p. ej. "h1 = altura del eje").
- Avisos en español, breves.`;

// v8.26 · ficha de válvula
const TIPOS_VALV = ["bola", "compuerta", "globo", "mariposa", "membrana", "macho", "neumatica", "control", "retencion", "tajadera", "aguja", "seguridad", "alivio"];
const ESQUEMA_VALV = {
  type: "object",
  properties: {
    fabricante: txt("Fabricante de la válvula"),
    modelo: txt("Modelo / serie / figura exacta"),
    tipo: { type: ["string", "null"], enum: [...TIPOS_VALV, null], description: "Tipo de válvula: bola, compuerta, globo, mariposa, membrana, macho, neumatica (todo/nada con actuador), control (regulación), retencion, tajadera, aguja, seguridad, alivio" },
    material_cuerpo: txt("Material del cuerpo con su designación (p. ej. 'ASTM A216 WCB', 'EN-GJS-400-15', 'ASTM A351 CF8M')"),
    material_obturador: txt("Material de la bola, disco u obturador"),
    material_vastago: txt("Material del vástago o eje"),
    material_asiento: { type: ["string", "null"], enum: ["PTFE", "RPTFE (PTFE reforzado)", "PEEK", "EPDM", "NBR", "FKM (Viton)", "Neopreno (CR)", "Silicona (VMQ)", "Grafito", "Metal-metal", null], description: "Material del asiento o de la junta principal" },
    conexion: { type: ["string", "null"], enum: ["Bridada", "Wafer (entre bridas)", "Lug (orejetas roscadas)", "Roscada", "Socket weld (SW)", "Soldada a tope (BW)", "Clamp sanitario", "Ranurada (Victaulic)", "Racor / manguito", null], description: "Tipo de conexión a la tubería" },
    norma_conexion: txt("Norma de la brida o de la rosca, p. ej. 'EN 1092-1', 'ASME B16.5', 'NPT', 'BSPP'"),
    cara_cara: txt("Norma de la distancia entre caras, p. ej. 'EN 558 serie 20', 'ASME B16.10', 'API 609 categoría A'"),
    pn_rating: txt("Presión nominal o clase, escrita 'PN 16' o '150#'"),
    norma_diseno: txt("Norma de diseño / fabricación (p. ej. 'API 6D', 'ISO 17292', 'EN 593', 'API 609')"),
    dn_min_mm: num("DN mínimo de la serie, en mm"),
    dn_max_mm: num("DN máximo de la serie, en mm"),
    t_min_c: num("Temperatura mínima de servicio, °C"),
    t_max_c: num("Temperatura máxima de servicio, °C"),
    fire_safe: { type: ["string", "null"], enum: ["No", "API 607", "ISO 10497", "API 6FA", null], description: "Certificación fire-safe; 'No' solo si el documento dice que no lo es" },
    accionamiento: { type: ["string", "null"], enum: ["Palanca", "Volante", "Reductor manual", "Actuador neumático simple efecto", "Actuador neumático doble efecto", "Actuador eléctrico", "Actuador hidráulico", "Automática (sin accionamiento)", null], description: "Accionamiento" },
    kvs_m3h: num("Válvulas de control: Kvs en m3/h"),
    fl: num("Válvulas de control: factor de recuperación FL"),
    cv_tabla: {
      type: "array", description: "Cv (gpm/√psi) a apertura total por tamaño, solo si está en una tabla numérica. Si el documento da Kv, Cv = 1,156·Kv (anótalo en conversiones)",
      items: { type: "object", properties: { tamano: { type: "string", description: "tamaño en pulgadas ('2', '1-1/4') o DN ('DN 50')" }, cv: { type: "number" } }, required: ["tamano", "cv"] },
    },
    curva_apertura: {
      type: "array", description: "Capacidad relativa frente a apertura si figura en una tabla: apertura en % de la carrera (en mariposas, grados/90·100) y Cv en % del Cv a apertura total",
      items: { type: "object", properties: { apertura_pct: { type: "number" }, cv_pct: { type: "number" } }, required: ["apertura_pct", "cv_pct"] },
    },
    conversiones: txt("Conversiones de unidades hechas"),
    avisos: { type: "array", items: { type: "string" }, description: "Dudas, ambigüedades o varios modelos en el mismo documento" },
  },
  required: ["fabricante", "modelo", "tipo", "cv_tabla", "avisos"],
};
const INSTRUCCIONES_VALV = `Eres un ingeniero que extrae datos de la ficha técnica de una válvula industrial para una base de datos.
Reglas:
- Devuelve solo lo que el documento dice de forma explícita. Si un dato no aparece, null. No estimes ni inventes.
- Convierte a las unidades pedidas (mm, °C, Cv en gpm/√psi) y anota cada conversión en "conversiones". °F a °C; pulgadas de DN: 2" = DN 50.
- Cv o Kv solo de tablas numéricas, no de gráficas.
- Si el documento cubre varias series o materiales, toma la indicada por el usuario; si no, la primera, y dilo en "avisos".
- Si el documento no es la ficha de una válvula, deja todo en null y explícalo en "avisos".
- Avisos en español, breves.`;

function json(cuerpo: unknown, estado = 200) {
  return new Response(JSON.stringify(cuerpo), { status: estado, headers: { ...CORS, "Content-Type": "application/json" } });
}

// el texto de la respuesta, sea cual sea la variante del formato
function textoDe(r: any): string {
  if (!r) return "";
  if (typeof r.output_text === "string") return r.output_text;
  if (typeof r.outputText === "string") return r.outputText;
  const trozos: string[] = [];
  const mirar = (lista: any) => {
    for (const p of Array.isArray(lista) ? lista : []) {
      if (p && p.thought) continue;
      if (p && typeof p.text === "string" && (!p.type || p.type === "text")) trozos.push(p.text);
    }
  };
  for (const s of Array.isArray(r.steps) ? r.steps : []) { if (!s.type || s.type === "model_output") mirar(s.content); }
  if (!trozos.length) mirar(r.outputs);
  if (!trozos.length) for (const c of Array.isArray(r.candidates) ? r.candidates : []) mirar(c?.content?.parts);
  return trozos.length ? trozos[trozos.length - 1] : "";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
  try {
    const clave = Deno.env.get("GEMINI_API_KEY");
    if (!clave) return json({ error: "Falta el secreto GEMINI_API_KEY en Supabase (Edge Functions > Secrets)." }, 500);
    const modelo = Deno.env.get("GEMINI_MODEL") || "gemini-3.8-flash";

    const e = await req.json().catch(() => null);
    if (!e || typeof e.token !== "string" || typeof e.datos !== "string") return json({ error: "Petición incompleta." }, 400);
    const mime = String(e.mime || "application/pdf");
    if (!MIMES.includes(mime)) return json({ error: "Formato no admitido: usa PDF, PNG o JPG." }, 400);
    if (e.datos.length * 0.75 > MAX_BYTES) return json({ error: "El archivo supera 12 MB." }, 413);
    if (!/^[A-Za-z0-9+/=]+$/.test(e.datos.slice(0, 2000))) return json({ error: "Archivo mal codificado." }, 400);

    const esValv = e.clase === "valvula";
    // sesión de PIPING y límite diario
    const url = Deno.env.get("SUPABASE_URL")!, anon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const p = await fetch(`${url}/rest/v1/rpc/piping_ia_permiso`, {
      method: "POST",
      headers: { apikey: anon, Authorization: "Bearer " + anon, "Content-Type": "application/json" },
      body: JSON.stringify({ p_token: e.token, p_funcion: esValv ? "valvula-pdf" : "bomba-pdf" }),
    });
    const permiso = await p.json().catch(() => null);
    if (!p.ok) return json({ error: (permiso && permiso.message) || "Sesión no válida." }, p.status === 404 ? 500 : 403);

    const pista = String(e.modelo || "").slice(0, 120).replace(/[\r\n]+/g, " ");
    const g = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
      method: "POST",
      headers: { "x-goog-api-key": clave, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelo,
        input: [
          { type: mime === "application/pdf" ? "document" : "image", data: e.datos, mime_type: mime },
          { type: "text", text: (esValv ? INSTRUCCIONES_VALV : INSTRUCCIONES) + (pista ? `\nModelo indicado por el usuario: ${pista}` : "") },
        ],
        response_format: { type: "text", mime_type: "application/json", schema: esValv ? ESQUEMA_VALV : ESQUEMA },
      }),
    });
    const r = await g.json().catch(() => null);
    if (!g.ok) {
      const m = (r && r.error && (r.error.message || r.error.status)) || ("HTTP " + g.status);
      return json({ error: g.status === 429 ? "Gemini: cuota agotada por ahora; prueba dentro de unos minutos." : "Gemini: " + String(m).slice(0, 300) }, 502);
    }
    let datos: any = null;
    try { datos = JSON.parse(textoDe(r).replace(/^```(?:json)?\s*|\s*```$/g, "")); } catch (_) { /* sin JSON */ }
    if (!datos || typeof datos !== "object") return json({ error: "Gemini no ha devuelto datos legibles." }, 502);
    return json({ datos, modelo, usadas_hoy: permiso.usadas_hoy, limite: permiso.limite });
  } catch (x) {
    return json({ error: "Error interno: " + String((x as Error).message || x).slice(0, 200) }, 500);
  }
});
