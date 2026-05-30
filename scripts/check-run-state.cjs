// scripts/check-run-state.cjs — diagnostic snapshot del run del Test 4
const path = require('node:path');
const { createClient } = require('../apps/web/node_modules/@libsql/client');
const DB_PATH = path.resolve(__dirname, '..', 'db', 'local.db');
const RUN_ID = '2d712e90-8ae8-4485-8314-8f685319fc78';
(async () => {
  const c = createClient({ url: `file:${DB_PATH}` });
  const r = await c.execute({
    sql: 'SELECT status, current_step, progress, image_count, estimated_cost_usd, error_message, started_at, completed_at FROM runs WHERE id = ?',
    args: [RUN_ID],
  });
  console.log(JSON.stringify(r.rows[0], null, 2));
})();
