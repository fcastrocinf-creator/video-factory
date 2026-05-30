// scripts/launch-test5-acuarela.cjs
//
// Test 5 — Aprendizaje formal del sub-tipo "B-ROLL animado acuarela".
// Usa preset YA EXISTENTE: mujer_protagonista_broll_animado_comic_sepia.
//
// Caracteristicas del preset:
//   - format: b-roll-animated
//   - style: comic_sepia (displayName "Comic / Acuarela Sepia")
//   - visualEngine: veo-lite (cada escena se anima)
//   - paleta: amber/ochre/cream/burgundy (sepia-watercolor)
//   - 18 escenas/min, default 60s
//
// Costo esperado: $3-7 (caro porque Veo anima cada escena ~$0.30/clip).
// La cascada multi-provider (Bug 1+2 fix) debe saltar a Kling/Higgsfield
// si Veo agota cuota.

const http = require('node:http');

const SCRIPT = `Como mujer de 40, sentí que mi cara cambió rápido. Ojos hinchados al levantarme, mandíbula menos definida, me veía cansada todo el tiempo. Probé cremas carísimas, masajes faciales con esos rodillos de jade, hasta procedimientos en clínica. Nada lograba lo que las gotas de Vitaly hicieron en dos semanas. El drenaje linfático facial se activó desde adentro. Mis pómulos volvieron a notarse. Mi piel se ve más firme y descansada. Y lo mejor: la gente me pregunta qué cambié, y yo solo digo que descansé mejor. Si todavía ves el botón naranja aquí abajo, las gotas siguen disponibles. Aprovecha antes de que se agote.`;

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
console.log('Preset: mujer_protagonista_broll_animado_comic_sepia (B-ROLL animado acuarela sepia)');
console.log('Visual engine: veo-lite');
console.log(`Script (${SCRIPT.length} chars): "${SCRIPT.slice(0, 100)}..."`);
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
