// Genera 02_datos.sql con el contenido actual de catalogo.js (node gen_datos.js)
global.window = {}; require('../catalogo.js'); const C = window.CATALOGO;
const q = v => v == null ? 'null' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
const out = ['-- PIPING · datos iniciales del catálogo ' + C.version + ' (generado desde catalogo.js)', 'begin;'];
out.push(`insert into catalogo_version (version, fuentes, vigente) values (${q(C.version)}, ${q(C.fuentes)}, true) on conflict (version) do update set fuentes = excluded.fuentes, vigente = true;`);
Object.entries(C.fluidos).forEach(([n, f]) => {
  out.push(`insert into fluidos (nombre, nota, kf_gpa, t_congelacion_c) values (${q(n)}, ${q(f.nota)}, ${q(f.Kf)}, ${q(f.Tcong)}) on conflict (nombre) do update set nota = excluded.nota, kf_gpa = excluded.kf_gpa, t_congelacion_c = excluded.t_congelacion_c;`);
  f.tabla.forEach(r => out.push(`insert into fluido_propiedades values ((select id from fluidos where nombre = ${q(n)}), ${r[0]}, ${r[1]}, ${r[2]}, ${r[3]}) on conflict do nothing;`));
});
const COD = { 'Acero al carbono': 'TAC', 'Acero inoxidable': 'TAI', 'PVC-U': 'TPVC', 'PE100': 'TPE', 'PE80': 'TPE', 'CPVC': 'TCPVC', 'PP-R': 'TPPR', 'PVDF': 'TPVDF', 'PP-H': 'TPPH', 'Cobre (Dint ref. Sch 40)': 'TCU', 'Fundición (Dint ref. Sch 40)': 'TFD', 'Hormigón (Dint ref. Sch 40)': 'THM' };
Object.entries(C.materiales).forEach(([n, m]) => {
  out.push(`insert into materiales (nombre, codigo, norma, rugosidad_mm, serie_def, dint_referencia) values (${q(n)}, ${q(COD[n] || 'T')}, ${q(m.norma)}, ${m.rug}, ${q(m.serieDef)}, ${/Dint ref/.test(n)}) on conflict (nombre) do nothing;`);
  const mid = `(select id from materiales where nombre = ${q(n)})`;
  m.series.forEach((s, i) => out.push(`insert into material_series values (${mid}, ${q(s)}, ${i}) on conflict do nothing;`));
  m.tamanos.forEach(t => {
    out.push(`insert into tubo_tamanos (material_id, clave, nps, od_mm) values (${mid}, ${q(t.clave)}, ${q(t.nps)}, ${t.od}) on conflict do nothing;`);
    Object.entries(t.e).forEach(([s, e]) => out.push(`insert into tubo_espesores values ((select id from tubo_tamanos where material_id = ${mid} and clave = ${q(t.clave)}), ${q(s)}, ${e}) on conflict do nothing;`));
  });
});
C.ft.forEach(([dn, ft]) => out.push(`insert into crane_ft values (${dn}, ${ft}) on conflict do nothing;`));
Object.entries(C.crane).forEach(([k, l]) => l.forEach((x, i) => out.push(`insert into crane_k (clave, descripcion, n_ft, referencia, orden) values (${q(k)}, ${q(x[0])}, ${typeof x[1] === 'number' ? x[1] : 'null'}, ${typeof x[1] === 'string' ? q(x[1]) : 'null'}, ${i}) on conflict do nothing;`)));
Object.entries(C.reducciones).forEach(([k, r]) => { const [a, b] = k.split('-'); out.push(`insert into reducciones_b169 values (${a}, ${b}, ${r.H}, ${r.theta}) on conflict do nothing;`); });
Object.entries(C.vmin).forEach(([t, c]) => out.push(`insert into retencion_vmin values (${q(t)}, ${c}) on conflict do nothing;`));
Object.entries(C.inchDN).forEach(([n, d]) => out.push(`insert into pulgadas_dn values (${q(n)}, ${d}) on conflict do nothing;`));
[[15, 20], [20, 25], [25, 32], [32, 40], [40, 50], [50, 63], [65, 75], [80, 90], [100, 110], [125, 140], [150, 160], [200, 225], [250, 250], [300, 315], [350, 355], [400, 400], [450, 450], [500, 500]].forEach(([d, o]) => out.push(`insert into equivalencia_dn_plastico values (${d}, ${o}) on conflict do nothing;`));
C.valvulas.forEach(v => {
  const fab = v.nombre.split(' · ')[0];
  out.push(`insert into fabricantes (nombre) values (${q(fab)}) on conflict do nothing;`);
  out.push(`insert into valvulas_catalogo (fabricante_id, nombre, tipo, fuente, nota) values ((select id from fabricantes where nombre = ${q(fab)}), ${q(v.nombre)}, ${q(v.tipo)}, ${q(v.fuente)}, ${q(v.nota)}) on conflict (nombre) do nothing;`);
  Object.entries(v.cv).forEach(([n, cv]) => out.push(`insert into valvula_cv values ((select id from valvulas_catalogo where nombre = ${q(v.nombre)}), ${q(n)}, ${cv}) on conflict do nothing;`));
});
[0.12, 0.18, 0.25, 0.37, 0.55, 0.75, 1.1, 1.5, 2.2, 3, 4, 5.5, 7.5, 11, 15, 18.5, 22, 30, 37, 45, 55, 75, 90, 110, 132, 160, 200, 250, 315, 355, 400].forEach(k => out.push(`insert into motores_iec (potencia_kw) values (${k}) on conflict do nothing;`));
const B = { T: [38, 50, 100, 150, 200], '1.1': { 150: [19.6, 19.2, 17.7, 15.8, 13.8], 300: [51.1, 50.1, 46.6, 45.1, 43.8], 600: [102.1, 100.2, 93.2, 90.2, 87.6], 900: [153.2, 150.4, 139.8, 135.2, 131.4] }, '2.2': { 150: [19.0, 18.4, 16.2, 14.8, 13.7], 300: [49.6, 48.1, 42.2, 38.5, 35.7], 600: [99.3, 96.2, 84.4, 77.0, 71.3], 900: [148.9, 144.3, 126.6, 115.5, 107.0] } };
['1.1', '2.2'].forEach(g => Object.entries(B[g]).forEach(([c, ps]) => ps.forEach((p, i) => out.push(`insert into presion_nominal values ('ASME B16.5', '${c}#', '${g}', ${B.T[i]}, ${p}) on conflict do nothing;`))));
[6, 10, 16, 25, 40, 63, 100].forEach(pn => [[50, 1], [100, 0.9], [150, 0.8]].forEach(([t, f]) => out.push(`insert into presion_nominal values ('EN 1092-1', 'PN ${pn}', 'EN', ${t}, ${+(pn * f).toFixed(2)}) on conflict do nothing;`)));
out.push('commit;');
require('fs').writeFileSync(__dirname + '/02_datos.sql', out.join('\n') + '\n');
console.log('02_datos.sql:', out.length, 'sentencias');
