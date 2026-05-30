// scripts/step1b-kill-test4-zombie.cjs
//
// Marca el run del Test 4 (2d712e90-...) como failed porque el dev server
// que lo estaba ejecutando murió. Mismo patrón que step1-kill-zombies-only.cjs.
// User-authorized: el patrón fue confirmado vía AskUserQuestion 2026-05-24.

const path = require('node:path');
const { createClient } = require('../apps/web/node_modules/@libsql/client');

const DB_PATH = path.resolve(__dirname, '..', 'db', 'local.db');
const RUN_ID = '2d712e90-8ae8-4485-8314-8f685319fc78';

(async () => {
  const c = createClient({ url: `file:${DB_PATH}` });
  const result = await c.execute({
    sql: `UPDATE runs
          SET status = 'failed',
              error_message = 'dev-server-crashed during rip-fidelity-aligner @68% (16h uptime + intensive aligner loop, probable Node process OOM)',
              completed_at = unixepoch()
          WHERE id = ? AND status = 'running'`,
    args: [RUN_ID],
  });
  console.log(`✓ ${result.rowsAffected} fila(s) actualizadas`);
  const r = await c.execute({
    sql: 'SELECT id, status, current_step, progress, error_message FROM runs WHERE id = ?',
    args: [RUN_ID],
  });
  console.log(JSON.stringify(r.rows[0], null, 2));
})().catch((e) => {
  console.error('ERR:', e.message);
  process.exit(1);
});
