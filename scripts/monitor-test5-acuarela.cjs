// scripts/monitor-test5-acuarela.cjs — monitor del Test 5 acuarela
const path = require('node:path');
const { createClient } = require('../apps/web/node_modules/@libsql/client');
const DB_PATH = path.resolve(__dirname, '..', 'db', 'local.db');
const RUN_ID = 'b91637d8-9a03-47d5-b7cf-e138b6889468';
const POLL_MS = 30_000;
const MAX_WAIT_MS = 45 * 60 * 1000; // 45min cap — veo-lite anima cada escena, mas lento que image-only

const c = createClient({ url: `file:${DB_PATH}` });
let lastSnapshot = '';
const started = Date.now();
let tick = 0;

async function check() {
  tick++;
  const r = await c.execute({
    sql: `SELECT status, current_step, progress, image_count, estimated_cost_usd, error_message
          FROM runs WHERE id = ?`,
    args: [RUN_ID],
  });
  const elapsedMin = ((Date.now() - started) / 60000).toFixed(1);
  if (r.rows.length === 0) {
    console.log(`[tick ${tick} · t=${elapsedMin}m] ✗ Run no existe`);
    process.exit(1);
  }
  const row = r.rows[0];
  const snapshot = `${row.status}|${row.current_step}|${row.progress}|${row.image_count}|${row.estimated_cost_usd}`;
  if (snapshot !== lastSnapshot) {
    console.log(
      `[tick ${tick} · t=${elapsedMin}m] status=${row.status} step=${row.current_step} progress=${row.progress}% imgs=${row.image_count} cost=$${Number(row.estimated_cost_usd || 0).toFixed(3)}`,
    );
    lastSnapshot = snapshot;
  }
  if (row.status === 'completed') {
    console.log(`\n✓ COMPLETED en ${elapsedMin}m · imgs=${row.image_count} · cost=$${Number(row.estimated_cost_usd).toFixed(3)}`);
    process.exit(0);
  }
  if (row.status === 'failed') {
    console.log(`\n✗ FAILED en ${elapsedMin}m · step=${row.current_step} · progress=${row.progress}%`);
    console.log(`  error=${row.error_message}`);
    process.exit(1);
  }
  if (Date.now() - started > MAX_WAIT_MS) {
    console.log(`\n⚠ TIMEOUT 45min — sigue en ${row.status}@${row.current_step}:${row.progress}%`);
    process.exit(2);
  }
}

(async () => {
  await check();
  setInterval(() => check().catch((e) => console.error(`[tick ${tick}] err:`, e.message)), POLL_MS);
})();
