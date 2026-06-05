// Imprime el estado + advisory de un run (para verificar el candado de validación).
// Uso: pnpm tsx scripts/check-run.ts <runId>
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
try {
  const env = readFileSync(resolve(process.cwd(), '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
  }
} catch {}
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { eq } from 'drizzle-orm';
import { runs } from '../db/schema';

async function main(): Promise<void> {
  const runId = process.argv[2]!;
  const dbFile = process.env['DATABASE_URL'] ?? `file:${resolve(process.cwd(), 'db', 'local.db')}`;
  const db = drizzle(createClient({ url: dbFile }));
  const r = (await db.select().from(runs).where(eq(runs.id, runId)).limit(1))[0];
  if (!r) { console.log('Run no encontrado'); return; }
  console.log(`status:       ${r.status}`);
  console.log(`currentStep:  ${r.currentStep ?? '(null)'}`);
  console.log(`errorMessage: ${r.errorMessage ?? '(ninguno)'}`);
}
main().catch((e: unknown) => { console.error(e); process.exit(1); });
