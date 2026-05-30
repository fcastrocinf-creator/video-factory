// scripts/preflight-db-check.cjs
// Pre-flight check para Test 4: verifica que el rip y los recursos estén OK
// antes de gastar ~$2-3 disparando el rip real.
const path = require('node:path');
const { createClient } = require('../apps/web/node_modules/@libsql/client');

const RIP_ID = '27ad591c-ad6c-4975-ba92-59f25e06dfda';
const DB_PATH = path.resolve(__dirname, '..', 'db', 'local.db');

(async () => {
  const c = createClient({ url: `file:${DB_PATH}` });

  // 1) Verificar que el rip existe en DB
  const rip = await c.execute({
    sql: 'SELECT id, status, video_file_name, video_bytes, created_at FROM rips WHERE id = ?',
    args: [RIP_ID],
  });
  console.log('=== Rip en DB ===');
  if (rip.rows.length === 0) {
    console.log(`✗ Rip ${RIP_ID} NO encontrado en DB`);
  } else {
    console.log(`✓ Rip encontrado:`);
    console.log(JSON.stringify(rip.rows[0], null, 2));
  }

  // 2) Últimos 3 runs (para ver historial reciente)
  const runs = await c.execute({
    sql: 'SELECT id, status, current_step, progress, image_count, estimated_cost_usd FROM runs ORDER BY created_at DESC LIMIT 3',
    args: [],
  });
  console.log('\n=== Últimos 3 runs ===');
  console.log(JSON.stringify(runs.rows, null, 2));

  // 3) Runs activos (no terminados)
  const activeRuns = await c.execute({
    sql: "SELECT id, status, current_step, progress FROM runs WHERE status IN ('pending', 'running')",
    args: [],
  });
  console.log('\n=== Runs activos (pending/running) ===');
  if (activeRuns.rows.length === 0) {
    console.log('✓ Ninguno — slot libre para Test 4');
  } else {
    console.log(`⚠ ${activeRuns.rows.length} run(s) activo(s):`);
    console.log(JSON.stringify(activeRuns.rows, null, 2));
  }

  process.exit(0);
})().catch((e) => {
  console.error('ERR:', e.message);
  console.error(e.stack);
  process.exit(1);
});
