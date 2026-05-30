// scripts/cleanup-and-launch-test4.cjs
//
// Test 4 launcher:
//   1) UPDATE los 2 runs zombie (status='running' huérfano de la última sesión
//      de hace 2 días) a status='failed' con error_message claro. Sólo afecta
//      esos 2 IDs específicos — no es blanket UPDATE.
//   2) Verifica que el slot quedó libre (0 runs en pending/running).
//   3) POST /api/rip/{ripId}/rip con cookie app_auth=valid pre-armada.
//      Body: brandId=vitaly, presetId=learned-vitaly-…bfd664eb,
//      productId=vitaly_gotas, fidelityMode=high.
//   4) Imprime el runId resultante.
//
// Costo esperado: ~$2-3 USD (gpt-image-1 + cascada multi-provider).
// Duración esperada: 25-35 min en background.

const path = require('node:path');
const http = require('node:http');
const { createClient } = require('../apps/web/node_modules/@libsql/client');

const DB_PATH = path.resolve(__dirname, '..', 'db', 'local.db');
const RIP_ID = '27ad591c-ad6c-4975-ba92-59f25e06dfda';
const ZOMBIE_RUN_IDS = [
  '85b4168e-279c-42c8-9b06-4d7d24d1d1f8',
  '8789d43b-172c-400d-8c36-b0169edd721e',
];

const RIP_BODY = {
  brandId: 'vitaly',
  presetId: 'learned-vitaly-media-23faa1f14cc9-bfd664eb',
  productId: 'vitaly_gotas',
  fidelityMode: 'high',
};

async function step1_killZombies(c) {
  console.log('=== STEP 1: Cleanup zombies ===');
  const result = await c.execute({
    sql: `UPDATE runs
          SET status = 'failed',
              error_message = 'killed-by-restart-pre-test4 (zombie de sesión 22-may)',
              completed_at = unixepoch()
          WHERE id IN (?, ?) AND status = 'running'`,
    args: ZOMBIE_RUN_IDS,
  });
  console.log(`  → ${result.rowsAffected} fila(s) actualizadas`);
}

async function step2_verifyEmpty(c) {
  console.log('\n=== STEP 2: Verificar slot libre ===');
  const r = await c.execute({
    sql: "SELECT id, status, current_step FROM runs WHERE status IN ('pending', 'running')",
    args: [],
  });
  if (r.rows.length > 0) {
    console.error(`  ✗ ${r.rows.length} run(s) aún activos:`);
    console.error(JSON.stringify(r.rows, null, 2));
    throw new Error('Slot no quedó libre');
  }
  console.log('  ✓ 0 runs activos');
}

function step3_postRip() {
  return new Promise((resolve, reject) => {
    console.log('\n=== STEP 3: POST /api/rip/{id}/rip ===');
    const body = JSON.stringify(RIP_BODY);
    const opts = {
      hostname: 'localhost',
      port: 3000,
      path: `/api/rip/${RIP_ID}/rip`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Cookie: 'app_auth=valid',
      },
    };
    const req = http.request(opts, (res) => {
      let chunks = '';
      res.on('data', (c) => (chunks += c));
      res.on('end', () => {
        console.log(`  HTTP ${res.statusCode}`);
        let parsed;
        try {
          parsed = JSON.parse(chunks);
        } catch {
          parsed = chunks;
        }
        console.log(`  Response:`, JSON.stringify(parsed, null, 2));
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(parsed);
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${JSON.stringify(parsed)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function step4_confirmRun(c, runId) {
  console.log('\n=== STEP 4: Confirmar run creado ===');
  const r = await c.execute({
    sql: 'SELECT id, status, current_step, progress, brand_id, preset_id FROM runs WHERE id = ?',
    args: [runId],
  });
  if (r.rows.length === 0) {
    console.warn(`  ⚠ Run ${runId} no encontrado en DB todavía (puede ser propagación)`);
    return;
  }
  console.log(`  ✓ Run en DB:`);
  console.log(JSON.stringify(r.rows[0], null, 2));
}

(async () => {
  const c = createClient({ url: `file:${DB_PATH}` });
  try {
    await step1_killZombies(c);
    await step2_verifyEmpty(c);
    const response = await step3_postRip();
    const runId = response.runId || response.id;
    if (!runId) {
      console.error('\n✗ La response no incluye runId — revisar shape de ripAd()');
      console.error(JSON.stringify(response, null, 2));
      process.exit(1);
    }
    await step4_confirmRun(c, runId);
    console.log('\n=== ✓ TEST 4 LAUNCHED ===');
    console.log(`Run ID: ${runId}`);
    console.log(`Monitor en background detectará el slot libre en su próximo tick.`);
    console.log(`Para seguir el progreso: SELECT current_step, progress FROM runs WHERE id='${runId}';`);
  } catch (e) {
    console.error('\n✗ FALLÓ:', e.message);
    if (e.stack) console.error(e.stack);
    process.exit(1);
  }
})();
