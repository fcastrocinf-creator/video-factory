import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

async function main() {
  const url = process.env['DATABASE_URL'] ?? 'file:./db/local.db';

  if (url.startsWith('file:')) {
    const filePath = resolve(url.slice('file:'.length));
    mkdirSync(dirname(filePath), { recursive: true });
  }

  const client = createClient({ url });
  const db = drizzle(client);

  await migrate(db, { migrationsFolder: './db/migrations' });

  // eslint-disable-next-line no-console
  console.log(`✓ Migraciones aplicadas (${url})`);
  client.close();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Error aplicando migraciones:', err);
  process.exit(1);
});
