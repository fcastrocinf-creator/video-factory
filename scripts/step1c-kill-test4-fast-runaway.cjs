// scripts/step1c-kill-test4-fast-runaway.cjs
// Marca el run e848f576 (Test 4 fast) como failed - estaba "running" pero
// a ritmo de 0.2%/min (throttle Bottleneck conservador ahogo el pipeline).
// Decisión user-authorized via "Si, la primera" — matar y relanzar Test 5
// con nuevos limits paid tier.

const path = require('node:path');
const { createClient } = require('../apps/web/node_modules/@libsql/client');
const DB_PATH = path.resolve(__dirname, '..', 'db', 'local.db');
const RUN_ID = 'e848f576-205d-46eb-9cb7-871927241db2';
(async () => {
  const c = createClient({ url: `file:${DB_PATH}` });
  const result = await c.execute({
    sql: `UPDATE runs SET status='failed',
          error_message='throttle-too-conservative — pipeline avanzo a 0.2%/min por Bottleneck limits free-tier. Killed para relanzar con limits paid-tier ($5-7 budget aprobado).',
          completed_at=unixepoch()
          WHERE id=? AND status='running'`,
    args: [RUN_ID],
  });
  console.log(`✓ ${result.rowsAffected} fila(s) actualizadas`);
})();
