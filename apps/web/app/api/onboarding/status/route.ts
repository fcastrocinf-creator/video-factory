// /api/onboarding/status
//
// Endpoint PÚBLICO (sin autenticación requerida) que retorna el estado del
// setup del empleado para el checklist de onboarding.
//
// Siempre retorna HTTP 200 aunque haya keys faltantes: el cliente (la página
// /onboarding) necesita leer el JSON para saber qué falta. Un 4xx rompería
// el checklist antes de que el usuario lo vea.
//
// REGLA DE SEGURIDAD: solo presencia booleana. NUNCA valores de env vars.

import { NextResponse } from 'next/server';
import { existsSync } from 'node:fs';
import { isSyncConfigured } from '@/lib/kb/sync';
import { db, runs } from '@/lib/db';
import { findFfmpegPath, isFfmpegBundled } from '@/lib/ffmpeg-locator';

export const runtime = 'nodejs';

/** Retorna true si la variable de entorno existe y tiene contenido no vacío. */
function presence(key: string): boolean {
  const v = process.env[key];
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Verifica que el binario de ffmpeg sea accesible.
 * Usa isFfmpegBundled() primero (rápido, sin I/O si ya está cacheado), y como
 * fallback comprueba que el path exista en disco.
 * Retorna true si ffmpeg está disponible (bundled o en PATH).
 */
function checkFfmpeg(): boolean {
  try {
    if (isFfmpegBundled()) return true;
    // Si no es bundled, comprobamos si el path apunta a algo existente.
    const p = findFfmpegPath();
    // El fallback es 'ffmpeg' / 'ffmpeg.exe' (solo nombre sin ruta absoluta).
    // En ese caso asumimos true: si está en PATH Next.js ya arrancó con él.
    if (!p.includes('/') && !p.includes('\\')) return true;
    return existsSync(p);
  } catch {
    return false;
  }
}

/**
 * Verifica que la base de datos sea accesible con una query trivial.
 * Retorna true si la DB responde; false si la DB no existe o falta db:migrate.
 */
async function checkDb(): Promise<boolean> {
  try {
    // Una query mínima al ORM basta para confirmar que la DB existe y tiene
    // las tablas creadas (db:migrate ya corrió).
    await db.select().from(runs).limit(1);
    return true;
  } catch {
    return false;
  }
}

export async function GET(): Promise<NextResponse> {
  // Verificar ffmpeg y DB en paralelo para minimizar latencia.
  const [ffmpeg, dbOk] = await Promise.all([
    Promise.resolve(checkFfmpeg()),
    checkDb(),
  ]);

  const keys = {
    APP_PASSWORD: presence('APP_PASSWORD'),
    OPENAI_API_KEY: presence('OPENAI_API_KEY'),
    ELEVENLABS_API_KEY: presence('ELEVENLABS_API_KEY'),
    GOOGLE_AI_API_KEY: presence('GOOGLE_AI_API_KEY'),
    ANTHROPIC_API_KEY: presence('ANTHROPIC_API_KEY'),
    GOOGLE_SPEECH_API_KEY: presence('GOOGLE_SPEECH_API_KEY'),
    GCP_PROJECT_ID: presence('GCP_PROJECT_ID'),
    GOOGLE_APPLICATION_CREDENTIALS: presence('GOOGLE_APPLICATION_CREDENTIALS'),
    GCP_LOCATION: presence('GCP_LOCATION'),
    HIGGSFIELD: presence('HIGGSFIELD_KEY_ID') && presence('HIGGSFIELD_KEY_SECRET'),
    KLING: presence('KLING_ACCESS_KEY') && presence('KLING_SECRET_KEY'),
    FAL_API_KEY: presence('FAL_API_KEY'),
    ZAPCAP_API_KEY: presence('ZAPCAP_API_KEY'),
    LOG_LEVEL: presence('LOG_LEVEL'),
  };

  // ok = true solo si todos los prerrequisitos y keys requeridas están presentes.
  const ok =
    keys.APP_PASSWORD &&
    keys.OPENAI_API_KEY &&
    keys.ELEVENLABS_API_KEY &&
    keys.GOOGLE_AI_API_KEY &&
    ffmpeg &&
    dbOk;

  return NextResponse.json(
    {
      prereqs: {
        // Node siempre es true si el servidor arrancó.
        node: true,
        // pnpm siempre es true si el servidor arrancó (pnpm install ya corrió).
        pnpm: true,
        ffmpeg,
        db: dbOk,
      },
      keys,
      sync: {
        configured: isSyncConfigured(),
      },
      ok,
    },
    { status: 200 },
  );
}
