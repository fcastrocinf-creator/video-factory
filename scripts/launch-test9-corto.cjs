// scripts/launch-test9-corto.cjs
// Test 9 — Prueba CORTA con loop iterativo M6 activo.
//
// Script reducido (~25s de video, ~5-7 escenas) para minimizar costo + tiempo.
// Cambios activos: subs OFF + Fix duración + M2 Claude judge + M5 + M6 loop iterativo.
//
// Esperado: pipeline normal + editor IA aprueba en 1-2 iteraciones.
// Costo esperado: ~$0.50-1.00. Tiempo: ~5-10 min.

const http = require('node:http');

const SHORT_SCRIPT = `¿Tu cara se ve hinchada al levantarte? La culpa es del drenaje linfático lento. Las gotas de Vitaly lo reactivan en 14 días. Tu rostro recupera definición sin tratamientos caros. Solo unas gotas, dos veces al día. Hoy con descuento. El botón está abajo.`;

const BODY = JSON.stringify({
  brandId: 'vitaly',
  presetId: 'mujer_protagonista_broll_animado_comic_sepia',
  productId: 'vitaly_gotas',
  script: SHORT_SCRIPT,
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
console.log(`Script CORTO (${SHORT_SCRIPT.length} chars):`);
console.log(`  "${SHORT_SCRIPT}"`);
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
