// scripts/wait-runs-idle.cjs
// Monitor: poll cada 60s hasta que NO haya runs en status='running' o 'pending'.
// Termina con exit 0 cuando el slot esta libre, exit 1 si timeout (90 min).
//
// Uso: invocado en background mientras esperamos para lanzar Test 4 sin que
// runs en vuelo compitan por cuotas de OpenAI/Gemini/Vertex.

const path = require('node:path');
const { createClient } = require('../apps/web/node_modules/@libsql/client');

const DB_PATH = path.resolve(__dirname, '..', 'db', 'local.db');
const POLL_MS = 60_000;
const MAX_WAIT_MS = 90 * 60 * 1000; // 90 min cap

const c = createClient({ url: `file:${DB_PATH}` });

const started = Date.now();
let tick = 0;

async function check() {
  tick++;
  const r = await c.execute({
    sql: "SELECT id, status, current_step, progress FROM runs WHERE status IN ('pending', 'running')",
    args: [],
  });
  const elapsedMin = ((Date.now() - started) / 60000).toFixed(1);
  if (r.rows.length === 0) {
    console.log(`[tick ${tick} · t=${elapsedMin}m] ✓ SLOT LIBRE — 0 runs activos`);
    process.exit(0);
  }
  const summary = r.rows
    .map((row) => `${row.id.slice(0, 8)}@${row.current_step}:${row.progress}%`)
    .join(' | ');
  console.log(`[tick ${tick} · t=${elapsedMin}m] ⏳ ${r.rows.length} run(s) activos: ${summary}`);
  if (Date.now() - started > MAX_WAIT_MS) {
    console.error(`[tick ${tick}] ✗ TIMEOUT — 90 min sin que los runs terminen`);
    process.exit(1);
  }
}

(async () => {
  await check(); // primer check inmediato
  setInterval(() => {
    check().catch((e) => {
      console.error(`[tick ${tick}] DB err:`, e.message);
    });
  }, POLL_MS);
})();
