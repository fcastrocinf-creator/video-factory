// scripts/monitor-test11.cjs — monitor Test 11 (loop M6 v2)
const path = require('node:path');
const { createClient } = require('../apps/web/node_modules/@libsql/client');
const DB_PATH = path.resolve(__dirname, '..', 'db', 'local.db');
const RUN_ID = '96bef2a7-6382-4b52-b7aa-5f1475587ea4';
const POLL_MS = 20_000;
const MAX_WAIT_MS = 45 * 60 * 1000;

const c = createClient({ url: `file:${DB_PATH}` });
let lastSnapshot = '';
const started = Date.now();
let tick = 0;

async function check() {
  tick++;
  const r = await c.execute({
    sql: 'SELECT status, current_step, progress, image_count, estimated_cost_usd, error_message FROM runs WHERE id = ?',
    args: [RUN_ID],
  });
  const elapsedMin = ((Date.now() - started) / 60000).toFixed(1);
  if (r.rows.length === 0) { console.log(`[tick ${tick} · t=${elapsedMin}m] ✗ Run no existe`); process.exit(1); }
  const row = r.rows[0];
  const snapshot = `${row.status}|${row.current_step}|${row.progress}|${row.image_count}|${row.estimated_cost_usd}`;
  if (snapshot !== lastSnapshot) {
    console.log(`[tick ${tick} · t=${elapsedMin}m] status=${row.status} step=${row.current_step} progress=${row.progress}% imgs=${row.image_count} cost=$${Number(row.estimated_cost_usd || 0).toFixed(3)}`);
    lastSnapshot = snapshot;
  }
  if (row.status === 'completed') { console.log(`\n✓ COMPLETED en ${elapsedMin}m · imgs=${row.image_count} · cost=$${Number(row.estimated_cost_usd).toFixed(3)}`); process.exit(0); }
  if (row.status === 'failed') { console.log(`\n✗ FAILED en ${elapsedMin}m · step=${row.current_step}`); console.log(`  error=${row.error_message}`); process.exit(1); }
  if (Date.now() - started > MAX_WAIT_MS) { console.log(`\n⚠ TIMEOUT 45min`); process.exit(2); }
}

(async () => {
  await check();
  setInterval(() => check().catch((e) => console.error(`[tick ${tick}] err:`, e.message)), POLL_MS);
})();
