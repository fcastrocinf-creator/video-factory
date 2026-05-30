// scripts/launch-test11.cjs
// Test 11 — Valida el loop M6 v2 con regenerate-scene executor REAL.
//
// Stack activo:
//   - M2 Claude judge per imagen (con product context)
//   - M5 post-render judge técnico (timing per-scene + coherencia visual-producto)
//   - M6 v2 editor IA loop iterativo con TODAS las 6 acciones ejecutables
//   - regenerate-scene executor REAL (re-genera UNA scene + re-render compositor)
//   - M8 chat IA en 5 spots de UI
//
// Script intencionalmente sublingual para que el editor IA detecte mismatch
// si la imagen NO muestra correctamente el uso del producto.

const http = require('node:http');

const SCRIPT = `Si tu rostro se ve hinchado al levantarte, no es tu culpa — es drenaje linfático lento. Las gotas de Vitaly se ponen bajo la lengua, directo al sistema. En 14 días tu cara recupera definición sin cremas caras. Solo unas gotas sublinguales, dos veces al día. Hoy con descuento. Botón abajo.`;

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

console.log('Test 11 — Loop M6 v2 con regenerate-scene REAL');
console.log(`Script (${SCRIPT.length} chars): explicita uso sublingual`);
console.log('');

const req = http.request(opts, (res) => {
  let chunks = '';
  res.on('data', (c) => (chunks += c));
  res.on('end', () => {
    console.log(`HTTP ${res.statusCode}`);
    try {
      console.log(JSON.stringify(JSON.parse(chunks), null, 2));
    } catch {
      console.log(chunks);
    }
    process.exit(res.statusCode >= 200 && res.statusCode < 300 ? 0 : 1);
  });
});
req.on('error', (e) => { console.error('REQ ERR:', e.message); process.exit(1); });
req.write(BODY);
req.end();
