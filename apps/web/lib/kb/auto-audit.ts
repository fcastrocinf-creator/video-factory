// Disparador del Consejo: análisis continuo AGRUPADO.
// Se llama fire-and-forget al terminar cada run; corre deepAudit() SOLO cada N
// runs o pasadas X horas, para que el costo de IA sea mínimo (agrupado +
// scopeado + cacheado por codeVersion, todo eso ya lo hace deepAudit).
// Gate por VF_AUTO_AUDIT (OFF por defecto). Best-effort: nunca rompe el flujo.

import { resolve } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { KB_DIR } from './record';

const CURSOR_PATH = resolve(KB_DIR, 'auto-audit-cursor.json');

interface AutoAuditCursor {
  runsDesdeUltima: number;
  ultimaTs: string | null;
}

function envInt(name: string, def: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : def;
}

function autoAuditEnabled(): boolean {
  const v = process.env['VF_AUTO_AUDIT'];
  return v === '1' || v === 'true';
}

async function readCursor(): Promise<AutoAuditCursor> {
  try {
    return JSON.parse(await readFile(CURSOR_PATH, 'utf-8')) as AutoAuditCursor;
  } catch {
    return { runsDesdeUltima: 0, ultimaTs: null };
  }
}

async function writeCursor(c: AutoAuditCursor): Promise<void> {
  try {
    await mkdir(KB_DIR, { recursive: true });
    await writeFile(CURSOR_PATH, JSON.stringify(c), 'utf-8');
  } catch {
    // best-effort
  }
}

export interface MaybeAutoAuditResult {
  triggered: boolean;
  reason: string;
}

/**
 * Cuenta el run recién terminado y, si se alcanzó el umbral (cada N runs o
 * pasadas X horas desde el último análisis), dispara deepAudit() agrupado.
 * No hace NADA si VF_AUTO_AUDIT no está activo. Best-effort.
 *
 * Pensado para llamarse fire-and-forget al finalizar un run:
 *   void maybeAutoAudit();
 */
export async function maybeAutoAudit(): Promise<MaybeAutoAuditResult> {
  if (!autoAuditEnabled()) return { triggered: false, reason: 'disabled' };

  const every = envInt('VF_AUTO_AUDIT_EVERY', 5);
  const maxHours = envInt('VF_AUTO_AUDIT_MAX_HOURS', 24);

  const cursor = await readCursor();
  const runs = cursor.runsDesdeUltima + 1;
  const horas = cursor.ultimaTs
    ? (Date.now() - new Date(cursor.ultimaTs).getTime()) / 3_600_000
    : Infinity;

  const porRuns = runs >= every;
  const porTiempo = cursor.ultimaTs !== null && horas >= maxHours;

  if (!porRuns && !porTiempo) {
    await writeCursor({ runsDesdeUltima: runs, ultimaTs: cursor.ultimaTs });
    return { triggered: false, reason: `acumulando (${runs}/${every})` };
  }

  // Reset ANTES de auditar: si llega otro run mientras deepAudit corre, no
  // re-dispara. La marca de tiempo nueva arranca la ventana de horas.
  await writeCursor({ runsDesdeUltima: 0, ultimaTs: new Date().toISOString() });

  try {
    const { deepAudit } = await import('./deep-audit');
    // Auto-scopeado (subsistemas con actividad) + cacheado por codeVersion +
    // modelo Haiku (rápido/barato). deepAudit saltea lo que no cambió.
    await deepAudit({ depth: 'rapido' });
    return { triggered: true, reason: porRuns ? `cada ${every} runs` : `${maxHours}h sin auditar` };
  } catch {
    return { triggered: false, reason: 'error en deepAudit' };
  }
}

/** Lee el estado del motor automático para mostrarlo en el admin (solo lectura). */
export async function getAutoAuditStatus(): Promise<{
  enabled: boolean;
  every: number;
  maxHours: number;
  runsDesdeUltima: number;
  ultimaTs: string | null;
}> {
  const cursor = await readCursor();
  return {
    enabled: autoAuditEnabled(),
    every: envInt('VF_AUTO_AUDIT_EVERY', 5),
    maxHours: envInt('VF_AUTO_AUDIT_MAX_HOURS', 24),
    runsDesdeUltima: cursor.runsDesdeUltima,
    ultimaTs: cursor.ultimaTs,
  };
}
