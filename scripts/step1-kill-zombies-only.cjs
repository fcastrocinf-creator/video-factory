// scripts/step1-kill-zombies-only.cjs
//
// SOLO el step 1: marca los 2 runs zombie como failed. No toca providers,
// no gasta nada, no lanza ningún rip. Solo UPDATE en la DB local de los 2
// IDs explícitamente listados, condicionado a status='running'.
//
// User-authorized via AskUserQuestion 2026-05-24: "Sí, ambas".
//
// Costo: $0. Duración: <100ms.

const path = require('node:path');
const { createClient } = require('../apps/web/node_modules/@libsql/client');

const DB_PATH = path.resolve(__dirname, '..', 'db', 'local.db');
const ZOMBIE_RUN_IDS = [
  '85b4168e-279c-42c8-9b06-4d7d24d1d1f8',
  '8789d43b-172c-400d-8c36-b0169edd721e',
];

(async () => {
  const c = createClient({ url: `file:${DB_PATH}` });
  console.log('Antes:');
  const before = await c.execute({
    sql: 'SELECT id, status, current_step, progress FROM runs WHERE id IN (?, ?)',
    args: ZOMBIE_RUN_IDS,
  });
  console.log(JSON.stringify(before.rows, null, 2));

  const result = await c.execute({
    sql: `UPDATE runs
          SET status = 'failed',
              error_message = 'killed-by-restart-pre-test4 (zombie sesión 22-may, user-authorized cleanup)',
              completed_at = unixepoch()
          WHERE id IN (?, ?) AND status = 'running'`,
    args: ZOMBIE_RUN_IDS,
  });
  console.log(`\n✓ ${result.rowsAffected} fila(s) actualizadas`);

  console.log('\nDespués:');
  const after = await c.execute({
    sql: 'SELECT id, status, error_message FROM runs WHERE id IN (?, ?)',
    args: ZOMBIE_RUN_IDS,
  });
  console.log(JSON.stringify(after.rows, null, 2));

  console.log('\nSlot activo ahora:');
  const active = await c.execute({
    sql: "SELECT COUNT(*) as n FROM runs WHERE status IN ('pending', 'running')",
    args: [],
  });
  console.log(`  ${active.rows[0].n} run(s) activo(s)`);
})().catch((e) => {
  console.error('ERR:', e.message);
  process.exit(1);
});
