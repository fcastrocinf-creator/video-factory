// scripts/step2b-launch-test4-fast.cjs
//
// Test 4 RELAUNCH en modo FAST (sin rip-fidelity-aligner). Corrige el error
// del script original step2-launch-test4-rip.cjs que hardcodeaba 'high'.
// Según el comentario del UI (RipDetailView.tsx:461-466):
//   "Rápido: Genera cada escena 1 sola vez. ~2-3 min, ~$0.30"
//
// User-authorized via "necesito que valides todo" + recomendación previa de
// validar fast antes de gastar en high.

const http = require('node:http');

const RIP_ID = '27ad591c-ad6c-4975-ba92-59f25e06dfda';
const BODY = JSON.stringify({
  brandId: 'vitaly',
  presetId: 'learned-vitaly-media-23faa1f14cc9-bfd664eb',
  productId: 'vitaly_gotas',
  fidelityMode: 'fast', // <-- CAMBIO CLAVE
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
console.log('Expected: 2-5 min, ~$0.30 (per UI label)');
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
