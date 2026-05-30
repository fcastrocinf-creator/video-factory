// Marca un run zombie (status=running pero proceso muerto) como failed para
// que el botón "Reintentar render" aparezca en la UI.
// Usa libsql client directo para evitar pasar por path aliases.
import { createClient } from '@libsql/client';
import { resolve } from 'node:path';

async function main(): Promise<void> {
  const RUN_ID = process.argv[2];
  if (!RUN_ID) {
    console.error('Usage: pnpm exec tsx scripts/mark-run-failed.ts <runId>');
    process.exit(1);
  }

  const dbPath = resolve(import.meta.dirname, '..', 'db', 'local.db');
  const client = createClient({ url: `file:${dbPath}` });

  const before = await client.execute({
    sql: 'SELECT id, status, current_step, progress FROM runs WHERE id = ? LIMIT 1',
    args: [RUN_ID],
  });
  if (before.rows.length === 0) {
    console.error(`Run ${RUN_ID} no encontrado en ${dbPath}`);
    process.exit(1);
  }
  console.log('Antes:', before.rows[0]);

  await client.execute({
    sql:
      "UPDATE runs SET status = 'failed', " +
      "error_message = ?, completed_at = strftime('%s','now') * 1000 WHERE id = ?",
    args: [
      'Proceso terminado: dev server caído a mitad de pipeline. ' +
        'Las imágenes generadas hasta el punto de corte están preservadas en disco. ' +
        'Usa "Reintentar render" para completar las faltantes.',
      RUN_ID,
    ],
  });

  const after = await client.execute({
    sql: 'SELECT id, status, current_step, progress, error_message FROM runs WHERE id = ? LIMIT 1',
    args: [RUN_ID],
  });
  console.log('Después:', after.rows[0]);
  client.close();
  process.exit(0);
}

void main();
