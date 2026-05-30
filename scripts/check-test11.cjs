const path = require('node:path');
const { createClient } = require('../apps/web/node_modules/@libsql/client');
const DB_PATH = path.resolve(__dirname, '..', 'db', 'local.db');
const RUN_ID = '96bef2a7-6382-4b52-b7aa-5f1475587ea4';
(async () => {
  const c = createClient({ url: `file:${DB_PATH}` });
  const r = await c.execute({
    sql: 'SELECT status, current_step, progress, image_count, estimated_cost_usd, error_message, started_at, completed_at FROM runs WHERE id = ?',
    args: [RUN_ID],
  });
  console.log(JSON.stringify(r.rows[0], null, 2));
})();
