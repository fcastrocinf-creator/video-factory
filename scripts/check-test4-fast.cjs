// scripts/check-test4-fast.cjs — diagnostic snapshot del Test 4 fast actual
const path = require('node:path');
const { createClient } = require('../apps/web/node_modules/@libsql/client');
const DB_PATH = path.resolve(__dirname, '..', 'db', 'local.db');
const RUN_ID = 'e848f576-205d-46eb-9cb7-871927241db2';
(async () => {
  const c = createClient({ url: `file:${DB_PATH}` });
  const r = await c.execute({
    sql: 'SELECT status, current_step, progress, image_count, estimated_cost_usd, error_message, started_at, completed_at FROM runs WHERE id = ?',
    args: [RUN_ID],
  });
  console.log(JSON.stringify(r.rows[0], null, 2));
})();
