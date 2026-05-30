// scripts/step2-launch-test4-rip.cjs
//
// SOLO el step 2: POST /api/rip/{ripId}/rip para lanzar Test 4 — el rip
// real con preset learned-vitaly contra el rip de prueba (media-23faa1f14cc9).
//
// User-authorized via AskUserQuestion 2026-05-24: "Sí, ambas".
//
// Configuración:
//   - Rip:     27ad591c-ad6c-4975-ba92-59f25e06dfda (analyzed, source.mp4 en disco)
//   - Brand:   vitaly
//   - Preset:  learned-vitaly-media-23faa1f14cc9-bfd664eb (pending/, b-roll-static, imagen4)
//   - Producto: vitaly_gotas
//   - Modo:    high (activa rip-fidelity-aligner — el path costoso)
//
// Cookie: app_auth=valid (pre-armada — equivalente a auth con password .env).
//
// Costo esperado: ~$2-3 USD (gpt-image-1 + cascada multi-provider con los
// fixes recientes — bug 1+2 del vertex-provider + Gemini Nano Banana como
// segundo position + throttling Bottleneck per-provider).
// Duración: 25-35 min en background.

const http = require('node:http');

const RIP_ID = '27ad591c-ad6c-4975-ba92-59f25e06dfda';
const BODY = JSON.stringify({
  brandId: 'vitaly',
  presetId: 'learned-vitaly-media-23faa1f14cc9-bfd664eb',
  productId: 'vitaly_gotas',
  fidelityMode: 'high',
});

const opts = {
  hostname: 'localhost',
  port: 3000,
  path: `/api/rip/${RIP_ID}/rip`,
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(BODY),
    Cookie: 'app_auth=valid',
  },
};

console.log(`POST http://localhost:3000${opts.path}`);
console.log('Body:', BODY);
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
