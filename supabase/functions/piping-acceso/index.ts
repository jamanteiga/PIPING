// PIPING v8.65 · Edge Function «piping-acceso»: registra cada acceso a la web en public.piping_accesos.
// Desplegar con «Verify JWT» DESACTIVADO (el navegador del visitante no lleva ninguna clave).
// No necesita secretos propios: SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY los pone Supabase en la función.
// La IP sale de la cabecera de la petición (no la manda el navegador) y se geolocaliza con ipwho.is.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const EVENTOS = ["entrada", "inicio de sesión", "salida"];
const t = (v: unknown, n = 300) => (v == null ? null : String(v).slice(0, n));

function ipDe(req: Request): string | null {
  const h = req.headers;
  const xf = h.get("x-forwarded-for");
  return t(h.get("cf-connecting-ip") || (xf ? xf.split(",")[0].trim() : null) || h.get("x-real-ip"), 64);
}

function sistema(ua: string, ch: any): string {
  if (ch && ch.platform) {
    const v = String(ch.platformVersion || "");
    if (ch.platform === "Windows") return parseInt(v) >= 13 ? "Windows 11" : parseInt(v) > 0 ? "Windows 10" : "Windows";
    if (ch.platform === "macOS") return "macOS " + v.split(".").slice(0, 2).join(".");
    if (ch.platform === "Android") return "Android " + v.split(".")[0] + (ch.model ? " · " + ch.model : "");
    return (ch.platform + " " + v).trim();
  }
  let m;
  if ((m = ua.match(/Windows NT ([\d.]+)/))) return { "10.0": "Windows 10/11", "6.3": "Windows 8.1", "6.2": "Windows 8", "6.1": "Windows 7" }[m[1]] || "Windows NT " + m[1];
  if ((m = ua.match(/iPhone OS ([\d_]+)/))) return "iOS " + m[1].replace(/_/g, ".");
  if ((m = ua.match(/iPad.*OS ([\d_]+)/))) return "iPadOS " + m[1].replace(/_/g, ".");
  if ((m = ua.match(/Android ([\d.]+)/))) return "Android " + m[1];
  if ((m = ua.match(/Mac OS X ([\d_.]+)/))) return "macOS " + m[1].replace(/_/g, ".");
  if (/CrOS/.test(ua)) return "ChromeOS";
  if (/Linux/.test(ua)) return "Linux";
  return "desconocido";
}

function navegador(ua: string, ch: any): string {
  const marcas = ch && ch.marcas ? String(ch.marcas) : "";
  const de = (re: RegExp, n: string) => { const m = ua.match(re); return m ? n + " " + m[1].split(".")[0] : null; };
  if (/bot|crawl|spider|slurp|headless/i.test(ua)) return "robot · " + ua.slice(0, 60);
  return de(/Edg\/([\d.]+)/, "Edge") || de(/OPR\/([\d.]+)/, "Opera") || de(/SamsungBrowser\/([\d.]+)/, "Samsung Internet") ||
    de(/Firefox\/([\d.]+)/, "Firefox") || de(/FxiOS\/([\d.]+)/, "Firefox") || de(/CriOS\/([\d.]+)/, "Chrome") ||
    (/Brave/.test(marcas) ? "Brave" : null) || de(/Chrome\/([\d.]+)/, "Chrome") ||
    (/Safari/.test(ua) ? de(/Version\/([\d.]+)/, "Safari") || "Safari" : null) || "desconocido";
}

function dispositivo(ua: string, ch: any, tactil: boolean): string {
  if (/iPad|Tablet/i.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua))) return "tableta";
  if ((ch && ch.movil) || /Mobi|iPhone|Android.*Mobile/i.test(ua)) return "móvil";
  return tactil ? "PC táctil" : "PC";
}

async function geo(ip: string | null) {
  if (!ip || /^(10\.|127\.|192\.168\.|::1|fc|fd)/.test(ip)) return {};
  try {
    const r = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}?lang=es&fields=success,country,region,city,latitude,longitude,connection`, { signal: AbortSignal.timeout(2500) });
    const d = await r.json();
    if (!d || d.success === false) return {};
    return { pais: t(d.country, 80), region: t(d.region, 80), ciudad: t(d.city, 80), lat: d.latitude ?? null, lon: d.longitude ?? null, isp: t(d.connection && (d.connection.isp || d.connection.org), 120) };
  } catch (_) { return {}; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return new Response("método no permitido", { status: 405, headers: CORS });
  let b: any;
  try { const txt = await req.text(); if (txt.length > 20000) throw 0; b = JSON.parse(txt); } catch (_) { return new Response("cuerpo no válido", { status: 400, headers: CORS }); }
  const evento = EVENTOS.includes(b.evento) ? b.evento : null;
  if (!evento) return new Response("evento no válido", { status: 400, headers: CORS });
  const ua = t(b.ua, 500) || t(req.headers.get("user-agent"), 500) || "", ch = b.uach || null, ip = ipDe(req);
  const fila = {
    evento, modo: t(b.modo, 40), usuario: t(b.usuario, 40), rol: t(b.rol, 20), ip,
    so: sistema(ua, ch), navegador: navegador(ua, ch), dispositivo: dispositivo(ua, ch, !!b.tactil),
    idioma: t(b.idioma, 20), zona: t(b.zona, 60), pantalla: t(b.pantalla, 40), ventana: t(b.ventana, 40),
    referer: t(b.referer, 300), url: t(b.url, 300), version: t(b.version, 20),
    visitante: t(b.visitante, 64), sesion: t(b.sesion, 64), segundos: Number.isFinite(+b.segundos) ? Math.max(0, Math.round(+b.segundos)) : null,
    ua, extra: { idiomas: t(b.idiomas, 120), plataforma: t(b.plataforma, 40), nucleos: b.nucleos ?? null, memoria: b.memoria ?? null, uach: ch, detalle: t(b.detalle, 200) },
    ...(evento === "salida" ? {} : await geo(ip)),
  };
  const url = Deno.env.get("SUPABASE_URL")!, key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const r = await fetch(`${url}/rest/v1/piping_accesos`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(fila),
  });
  if (evento === "entrada" && Math.random() < 0.05) fetch(`${url}/rest/v1/rpc/piping_accesos_purgar`, { method: "POST", headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: "{}" }).catch(() => {});
  return new Response(r.ok ? "ok" : "error", { status: r.ok ? 200 : 500, headers: CORS });
});
