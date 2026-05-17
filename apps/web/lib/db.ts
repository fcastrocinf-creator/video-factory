import { resolve } from 'node:path';
import { createClient, type Client } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { runs } from '@db/schema';
import { REPO_ROOT } from './paths';

let _client: Client | null = null;
let _db: LibSQLDatabase | null = null;

function buildDbUrl(): string {
  const fromEnv = process.env['DATABASE_URL'];
  const raw = fromEnv ?? `file:${resolve(REPO_ROOT, 'db', 'local.db')}`;

  // Si la URL es `file:` con path relativo, lo resolvemos contra REPO_ROOT.
  // Necesario porque libsql resuelve el path contra el cwd (apps/web en dev),
  // pero la DB vive en <repoRoot>/db/local.db.
  if (raw.startsWith('file:')) {
    const path = raw.slice('file:'.length);
    const isAbsolute = /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('/');
    if (!isAbsolute) {
      return `file:${resolve(REPO_ROOT, path)}`;
    }
  }
  return raw;
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
