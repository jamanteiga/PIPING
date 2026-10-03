// PIPING v8.19 · Edge Function «piping-bomba-pdf»
// Lee la ficha técnica de una bomba (PDF o imagen) con Google Gemini y devuelve los datos de la ficha en JSON.
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
    plan_sellado: txt("Plan de sellado API 682 o tipo de cierre"),
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

    // sesión de PIPING y límite diario
    const url = Deno.env.get("SUPABASE_URL")!, anon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const p = await fetch(`${url}/rest/v1/rpc/piping_ia_permiso`, {
      method: "POST",
      headers: { apikey: anon, Authorization: "Bearer " + anon, "Content-Type": "application/json" },
      body: JSON.stringify({ p_token: e.token, p_funcion: "bomba-pdf" }),
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
          { type: "text", text: INSTRUCCIONES + (pista ? `\nModelo indicado por el usuario: ${pista}` : "") },
        ],
        response_format: { type: "text", mime_type: "application/json", schema: ESQUEMA },
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
