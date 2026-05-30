const path = require('node:path');
const { createClient } = require('../apps/web/node_modules/@libsql/client');
const DB_PATH = path.resolve(__dirname, '..', 'db', 'local.db');
const RUN_ID = 'b91637d8-9a03-47d5-b7cf-e138b6889468';
(async () => {
  const c = createClient({ url: `file:${DB_PATH}` });
  const r = await c.execute({
    sql: 'SELECT status, current_step, progress, image_count, estimated_cost_usd, error_message, started_at, completed_at, duration_seconds, output_path FROM runs WHERE id = ?',
    args: [RUN_ID],
  });
  console.log(JSON.stringify(r.rows[0], null, 2));
})();
