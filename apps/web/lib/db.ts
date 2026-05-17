import { resolve } from 'node:path';
import { createClient, type Client } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { runs } from '@db/schema';
import { REPO_ROOT } from './paths';

let _client: Client | null = null;
let _db: LibSQLDatabase | null = null;

function buildDbUrl(): string {
  const fromEnv = process.env['DATABASE_URL'];
  if (fromEnv) return fromEnv;
  // Default: SQLite local en <repoRoot>/db/local.db. Path absoluto para que funcione
  // independiente del cwd (build, dev, scripts, etc.).
  return `file:${resolve(REPO_ROOT, 'db', 'local.db')}`;
}

function init(): LibSQLDatabase {
  if (!_db) {
    _client = createClient({ url: buildDbUrl() });
    _db = drizzle(_client);
  }
  return _db;
}

// Proxy que difiere la conexión hasta el primer acceso real (insert/select/etc.).
// Evita que Next.js abra la DB durante "collect page data" del build.
export const db = new Proxy({} as LibSQLDatabase, {
  get(_target, prop, receiver) {
    return Reflect.get(init() as object, prop, receiver);
  },
});

export { runs };
