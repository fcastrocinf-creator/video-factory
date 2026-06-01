// Base de Conocimiento — Módulo de sincronización OPT-IN al buzón central.
//
// Envía los eventos del KB local al endpoint central del responsable técnico
// para que el aprendizaje de cada instalación se consolide.
//
// COMPORTAMIENTO POR DEFECTO: OFF.
// Si VF_LEARNING_SYNC_URL no está en process.env, todas las funciones son
// no-op totales: no tocan disco, no hacen peticiones de red, no tienen costo.
//
// Qué se envía: solo KbEvento (metadatos estructurados < 1 KB c/u).
// Qué NUNCA se envía: videos, imágenes, audio, scripts, valores de keys.
//
// El módulo es best-effort: nunca lanza errores que interrumpan el pipeline.
// Usa el fetch global de Node.js >= 18 (disponible en el runtime del proyecto).
// No importa nada de 'next/server' para garantizar portabilidad en Node puro,
// scripts CLI y futuros cron jobs.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { hostname } from 'node:os';
import { STORAGE_DIR } from '../paths';
import { query } from './query';
import type { KbEvento } from './record';

// Ruta del cursor local que guarda el timestamp del último evento enviado.
const SYNC_CURSOR_PATH = resolve(STORAGE_DIR, 'kb', 'sync-cursor.json');

// Máximo de eventos por lote. Garantiza que el cursor avance de forma segura
// aunque haya miles de eventos pendientes (proceso por tandas).
const MAX_BATCH_SIZE = 500;

/** Cursor persistido en disco que registra el progreso de la sync. */
interface SyncCursor {
  ultimoTs: string | null;
}

/**
 * Resultado de una operación de sync.
 *
 * - `configured`: false si VF_LEARNING_SYNC_URL no está configurada (no-op)
 * - `enviados`: cuántos eventos se enviaron en esta llamada
 * - `cursor`: timestamp ISO 8601 del último evento procesado
 * - `error`: mensaje de error si algo salió mal (la sync igual no lanza)
 */
export interface SyncResult {
  enviados: number;
  cursor: string | null;
  configured: boolean;
  error?: string;
}

/**
 * Indica si la sincronización está configurada (VF_LEARNING_SYNC_URL presente).
 * Retorna false si la URL es una cadena vacía.
 */
export function isSyncConfigured(): boolean {
  const url = process.env['VF_LEARNING_SYNC_URL'];
  return typeof url === 'string' && url.trim().length > 0;
}

/**
 * Lee el cursor guardado en disco. Si no existe o está corrupto, retorna null.
 * Best-effort: nunca lanza.
 */
async function readCursor(): Promise<SyncCursor> {
  try {
    const raw = await readFile(SYNC_CURSOR_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'ultimoTs' in parsed
    ) {
      return parsed as SyncCursor;
    }
  } catch {
    // Archivo inexistente o corrupto: empezar desde el principio.
  }
  return { ultimoTs: null };
}

/**
 * Persiste el cursor en disco.
 * Crea el directorio si no existe. Best-effort: nunca lanza.
 */
async function writeCursor(cursor: SyncCursor): Promise<void> {
  try {
    await mkdir(resolve(STORAGE_DIR, 'kb'), { recursive: true });
    await writeFile(SYNC_CURSOR_PATH, JSON.stringify(cursor, null, 2), 'utf-8');
  } catch {
    // best-effort
  }
}

/**
 * Sincroniza los eventos pendientes del KB local al buzón central.
 *
 * Si VF_LEARNING_SYNC_URL no está configurada, retorna inmediatamente sin
 * tocar disco ni red: { enviados: 0, cursor: null, configured: false }.
 *
 * Si falla la petición HTTP, no actualiza el cursor (los eventos se
 * reintentarán en la próxima llamada).
 *
 * Envía en lotes de MAX_BATCH_SIZE (500) ordenados por ts asc para garantizar
 * que el cursor avance de forma correcta cuando hay muchos eventos pendientes.
 *
 * Nunca lanza. Toda excepción se captura y se retorna en el campo `error`.
 */
export async function syncPendingEventos(): Promise<SyncResult> {
  // No-op si no hay URL configurada.
  if (!isSyncConfigured()) {
    return { enviados: 0, cursor: null, configured: false };
  }

  const syncUrl = process.env['VF_LEARNING_SYNC_URL'] as string;
  const syncKey = process.env['VF_LEARNING_SYNC_KEY'] ?? '';

  try {
    // Leer el cursor actual.
    const cursor = await readCursor();

    // Obtener todos los eventos nuevos posteriores al cursor.
    const eventosNuevos = await query({ desde: cursor.ultimoTs ?? undefined });

    if (eventosNuevos.length === 0) {
      return { enviados: 0, cursor: cursor.ultimoTs, configured: true };
    }

    // Ordenar por ts asc para procesar los más antiguos primero y avanzar
    // el cursor de forma segura.
    const ordenados = [...eventosNuevos].sort((a, b) =>
      a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0,
    );

    // Tomar el primer lote (máx. MAX_BATCH_SIZE).
    const lote: KbEvento[] = ordenados.slice(0, MAX_BATCH_SIZE);

    // Obtener el nombre del host para identificar la instalación.
    let instalacion = 'unknown';
    try {
      instalacion = hostname();
    } catch {
      // ignorar: en algunos entornos restringidos hostname() puede fallar
    }

    // Payload del POST. NUNCA incluye valores de variables de entorno.
    const payload = {
      eventos: lote,
      instalacion,
      enviadoEn: new Date().toISOString(),
    };

    // Construir headers de la petición.
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (syncKey) {
      headers['Authorization'] = `Bearer ${syncKey}`;
    }

    // Enviar el lote al endpoint central.
    const response = await fetch(syncUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      // No actualizar el cursor: reintentar en la próxima sync.
      return {
        enviados: 0,
        cursor: cursor.ultimoTs,
        configured: true,
        error: `HTTP ${response.status} — el endpoint rechazó el lote`,
      };
    }

    // Actualizar el cursor al ts del último evento del lote (el más reciente
    // del lote ordenado asc = el último elemento).
    const nuevoTs = lote[lote.length - 1]!.ts;
    const nuevoCursor: SyncCursor = { ultimoTs: nuevoTs };
    await writeCursor(nuevoCursor);

    return {
      enviados: lote.length,
      cursor: nuevoTs,
      configured: true,
    };
  } catch (err) {
    // Capturar cualquier error (red, parse, I/O) sin propagarlo.
    const mensaje =
      err instanceof Error ? err.message : 'Error desconocido en sync';
    return {
      enviados: 0,
      cursor: null,
      configured: true,
      error: mensaje,
    };
  }
}
