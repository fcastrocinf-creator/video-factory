// scripts/launch-test8-script-nuevo.cjs
//
// Test 8 — Validar pipeline con SCRIPT DIFERENTE al usado en Test 5/6/7
// (storytelling primera persona). Ahora ángulo educativo/curiosidad.
//
// Cambios activos en este test:
//   - Subtítulos DESACTIVADOS (no overlay)
//   - Fix A duración (última scene cubre todo el audio → no negro al final)
//   - Editor IA verdict (Claude actúa como editor senior, bloquea si block-shipping)
//   - M1 (validator estricto) + M2 (Claude judge per scene)
//   - M5 + N1 + Bottleneck paid limits + Kling restaurado

const http = require('node:http');

// SCRIPT DIFERENTE — tono educativo/curiosidad (vs primera persona Test 5-7)
const SCRIPT = `¿Por qué tu cara se ve hinchada al levantarte si dormiste 8 horas? La respuesta no es lo que crees. Tu sistema linfático facial se ralentiza con la edad y el estrés. Eso causa retención, papada, ojos cansados. Las gotas de Vitaly contienen ingredientes naturales que reactivan ese drenaje linfático en 14 días. Tu cara recupera definición. Tu piel se ve más firme. Y no necesitas tratamientos costosos. Solo unas gotas, dos veces al día. Hoy con 50 por ciento de descuento. El botón está justo abajo.`;

const BODY = JSON.stringify({
  brandId: 'vitaly',
  presetId: 'mujer_protagonista_broll_animado_comic_sepia',
  productId: 'vitaly_gotas',
  script: SCRIPT,
});

const opts = {
  hostname: 'localhost',
  port: 3000,
  path: '/api/generate',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(BODY),
    Cookie: 'app_auth=valid',
  },
};

console.log(`POST http://localhost:3000${opts.path}`);
console.log('Preset: mujer_protagonista_broll_animado_comic_sepia');
console.log(`Script (${SCRIPT.length} chars, ANGULO: educativo/curiosidad):`);
console.log(`  "${SCRIPT.slice(0, 120)}..."`);
console.log('');

const req = http.request(opts, (res) => {
  let chunks = '';
  res.on('data', (c) => (chunks += c));
  res.on('end', () => {
    console.log(`HTTP ${res.statusCode}`);
    let parsed;
    try {
      parsed = JSON.parse(chunks);
    } catch {
      parsed = chunks;
    }
    console.log(JSON.stringify(parsed, null, 2));
    process.exit(res.statusCode >= 200 && res.statusCode < 300 ? 0 : 1);
  });
});

req.on('error', (e) => {
  console.error('REQ ERR:', e.message);
  process.exit(1);
});

req.write(BODY);
req.end();
