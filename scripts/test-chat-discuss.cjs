// scripts/test-chat-discuss.cjs
// Test del endpoint /api/chat/discuss (M8 backend) standalone.
// Requiere dev server arriba. Costo: ~$0.002.

const http = require('node:http');

const BODY = JSON.stringify({
  contextType: 'sugerencia',
  contextData: {
    brandsConocidas: ['vitaly', 'nelo'],
    presetsExistentes: ['mujer_protagonista_broll_animado_comic_sepia', 'doctor_pixar_animado'],
  },
  conversation: [
    {
      role: 'user',
      content:
        'Tengo una idea: agregar un preset nuevo para UGC fotorealista con personaje masculino de 30-40 hablando sobre productos para reflujo. ¿Te parece útil o ya existe algo parecido?',
    },
  ],
});

const opts = {
  hostname: 'localhost',
  port: 3000,
  path: '/api/chat/discuss',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(BODY),
  },
};

console.log('=== Test /api/chat/discuss ===');
console.log('contextType: sugerencia');
console.log('user msg: pregunta sobre crear preset UGC fotorealista masculino');
console.log('');

const req = http.request(opts, (res) => {
  let chunks = '';
  res.on('data', (c) => (chunks += c));
  res.on('end', () => {
    console.log(`HTTP ${res.statusCode}`);
    try {
      const j = JSON.parse(chunks);
      if (j.reply) {
        console.log(`\n=== Reply de Claude (${j.elapsedSec?.toFixed(1)}s, model=${j.modelUsed}) ===`);
        console.log(j.reply);
        console.log(`\nTokens: in=${j.tokensUsed?.input}, out=${j.tokensUsed?.output}`);
        process.exit(0);
      } else {
        console.error('\n✗ Error response:');
        console.error(JSON.stringify(j, null, 2));
        process.exit(1);
      }
    } catch {
      console.log(chunks);
      process.exit(1);
    }
  });
});
req.on('error', (e) => { console.error('REQ ERR:', e.message); process.exit(1); });
req.write(BODY);
req.end();
