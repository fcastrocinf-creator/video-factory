// repair-executor.ts — Fase 2 del círculo ("Aplicar"), parte 2: el BRAZO (efectos).
//
// planRepairs (repair-loop.ts) DECIDE qué reparación haría falta; este executor la
// EJECUTA — pero SOLO con OK del owner (lo dispara un endpoint tras su clic),
// respetando el invariante "nada se auto-aplica" al SISTEMA. Reparar un ARTEFACTO del
// run (regenerar la escena que falla) sí está permitido.
//
// NO reconstruye un motor: REUSA la "mano" que ya existe (applyCorrection), que
// forkea el run (preserva el original), regenera SOLO las escenas afectadas y
// re-renderiza. La diferencia con el flujo conversacional: aquí el plan es
// DETERMINISTA (el hallazgo ya viene localizado en su escena por la compuerta), así
// que pasamos `parseOverride` y NOS SALTAMOS el parseo NL con Gemini.
//
// La lógica PURA (traducir hallazgo → plan) vive en repair-plan.ts (testeable sin
// DB/IA); aquí van los EFECTOS. Re-exportamos la parte pura por conveniencia.

import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { db, runs } from './db';
import { workDirFor } from './paths';
import { applyCorrection } from './correction-pipeline';
import type { RepairTarget } from './kb/quality-gate';
import { buildRepairParse } from './repair-plan';

export { buildRepairParse, repairActionIsExecutable } from './repair-plan';

export interface GateRepairInput {
  /** Run cuyo render falló el gate (el que se va a reparar). */
  originalRunId: string;
  /** La reparación a aplicar (un RepairTarget de planRepairs, ya localizado). */
  repair: RepairTarget;
}

export interface GateRepairOutcome {
  ok: boolean;
  /** Run NUEVO (fork corregido) si se disparó la reparación. */
  newRunId?: string;
  /** Por qué NO se pudo ejecutar (acción no regenerable, run inválido, etc.). */
  reason?: string;
}

/**
 * EJECUTA una reparación dirigida CON OK del owner (lo invoca el endpoint tras su
 * clic). Forkea el run y regenera SOLO la escena del hallazgo (fire-and-forget,
 * igual que /corrections). El owner verifica el resultado re-corriendo el gate
 * (ver + oír). NUNCA toca el run original ni el sistema.
 */
export async function executeGateRepair(input: GateRepairInput): Promise<GateRepairOutcome> {
  const parse = buildRepairParse(input.repair);
  if (!parse) {
    return {
      ok: false,
      reason:
        'Esta acción no regenera una escena: ajústala en el editor o requiere una revisión mayor.',
    };
  }

  const rows = await db.select().from(runs).where(eq(runs.id, input.originalRunId)).limit(1);
  const original = rows[0];
  if (!original) return { ok: false, reason: 'Run original no encontrado.' };
  if (!original.workDir) return { ok: false, reason: 'Run original sin workDir.' };
  if (original.status !== 'completed' && original.status !== 'completed-with-warnings') {
    return { ok: false, reason: 'Solo se puede reparar un run completado.' };
  }

  // Fork: nuevo run (preserva el original). Mismo patrón que /api/runs/[id]/corrections.
  const newRunId = randomUUID();
  const newWorkDir = workDirFor(newRunId);
  await mkdir(newWorkDir, { recursive: true });
  await db.insert(runs).values({
    id: newRunId,
    brandId: original.brandId,
    presetId: original.presetId,
    productId: original.productId,
    scriptRaw: original.scriptRaw,
    status: 'pending',
    workDir: newWorkDir,
    progress: 0,
    originalRunId: original.id,
  });

  // Dispara la reparación en background con el plan determinista (regenera SOLO la
  // escena del hallazgo, con el fix como dirección). NO esperamos: el owner sigue el
  // progreso en /runs/<newRunId>, igual que una corrección.
  void applyCorrection({
    originalRunId: input.originalRunId,
    newRunId,
    correctionMessage: input.repair.blocker.titulo || 'Reparación del gate',
    uploadedAssetPath: null,
    uploadedAssetIsVideo: false,
    parseOverride: parse,
  }).catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error('[repair-executor] uncaught error for run', newRunId, err);
  });

  return { ok: true, newRunId };
}
