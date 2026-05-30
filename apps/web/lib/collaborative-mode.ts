// ╔══════════════════════════════════════════════════════════════════════════╗
// ║              COLLABORATIVE MODE — "Hacer video en conjunto"              ║
// ║                                                                          ║
// ║  Cuando el run se crea con mode='collaborative', el pipeline pausa       ║
// ║  después de cada scene + VALIDATOR validation y espera intervención del  ║
// ║  owner antes de proceder a la siguiente.                                 ║
// ║                                                                          ║
// ║  Mecanismo:                                                              ║
// ║    1. Pipeline llama waitForApprovalIfCollaborative(runId, sceneIndex)   ║
// ║    2. Si mode != 'collaborative' → return inmediato                      ║
// ║    3. Si sí → setea awaitingApproval=true, pausedAtSceneIndex=N en DB   ║
// ║    4. Loop de polling cada 5s leyendo el campo awaitingApproval         ║
// ║    5. Cuando owner clickea botón en UI → POST /api/runs/[id]/intervene  ║
// ║       setea awaitingApproval=false + persiste action en interventions   ║
// ║    6. El loop detecta y retorna                                          ║
// ║    7. scene-animator/pipeline interpreta la action (approve/regen/skip)  ║
// ║                                                                          ║
// ║  Timeout defensivo: si owner no responde en MAX_WAIT_MS, se abandona    ║
// ║  el run con status='failed' + errorMessage explicativo. Default 60 min. ║
// ╚══════════════════════════════════════════════════════════════════════════╝

import { eq } from 'drizzle-orm';
import { db, runs } from './db';
import {
  readPendingInterventions,
  markInterventionProcessed,
  type OwnerIntervention,
} from './owner-feedback';

const POLL_INTERVAL_MS = 5_000;
const MAX_WAIT_MS = 60 * 60 * 1_000; // 1 hora — owner tiene tiempo a re-arrancar browser

interface MinimalLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
}

export interface ApprovalResult {
  /** Acción del owner. */
  action: 'approve' | 'reject' | 'skip' | 'comment-only' | 'timeout';
  /** Intervención que disparó la liberación (si action != 'timeout'). */
  intervention?: OwnerIntervention;
  /** Si action='reject', el prompt nuevo (opcional). */
  newImagePrompt?: string;
  newMotionPrompt?: string;
  /** Comments adicionales que el owner dejó durante la pausa. */
  additionalComments: string[];
  /** Tiempo total esperando aprobación. */
  waitedMs: number;
}

/**
 * Mecanismo de pausa colaborativa. Si el run está en mode='collaborative',
 * setea awaitingApproval=true + pausedAtSceneIndex y espera intervención.
 * Si está en mode='auto', return inmediato con action='approve' (no bloquea).
 */
export async function waitForApprovalIfCollaborative(input: {
  runId: string;
  sceneIndex: number;
  logger?: MinimalLogger;
}): Promise<ApprovalResult> {
  const t0 = Date.now();
  // Leer el modo del run
  const row = (
    await db.select().from(runs).where(eq(runs.id, input.runId)).limit(1)
  )[0];
  if (!row) {
    return {
      action: 'approve',
      additionalComments: [],
      waitedMs: 0,
    };
  }
  // Cast porque drizzle-typed columns no siempre infieren mode correctamente
  const mode = (row as { mode?: string }).mode ?? 'auto';
  if (mode !== 'collaborative') {
    return {
      action: 'approve',
      additionalComments: [],
      waitedMs: 0,
    };
  }

  // Setear paused state
  await db
    .update(runs)
    .set({
      pausedAtSceneIndex: input.sceneIndex,
      awaitingApproval: true,
      currentStep: `aguardando aprobación · scene ${input.sceneIndex}`,
    })
    .where(eq(runs.id, input.runId));

  input.logger?.info(
    {
      runId: input.runId,
      sceneIndex: input.sceneIndex,
      entity: 'COLLABORATIVE MODE',
    },
    'collaborative:paused_waiting_for_owner',
  );

  const additionalComments: string[] = [];

  // Polling loop
  while (Date.now() - t0 < MAX_WAIT_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    // Chequear intervenciones para esta scene
    const pending = await readPendingInterventions(
      input.runId,
      input.sceneIndex,
    ).catch(() => []);

    for (const intv of pending) {
      if (intv.type === 'comment') {
        // Los comments NO liberan la pausa pero los acumulamos
        if (intv.comment) additionalComments.push(intv.comment);
        await markInterventionProcessed(input.runId, intv.id).catch(() => {});
        continue;
      }

      // approve / reject / skip → liberar
      await markInterventionProcessed(input.runId, intv.id).catch(() => {});
      await db
        .update(runs)
        .set({
          awaitingApproval: false,
          pausedAtSceneIndex: null,
        })
        .where(eq(runs.id, input.runId));

      const waitedMs = Date.now() - t0;
      input.logger?.info(
        {
          runId: input.runId,
          sceneIndex: input.sceneIndex,
          action: intv.type,
          waitedSec: (waitedMs / 1000).toFixed(1),
          entity: 'COLLABORATIVE MODE',
        },
        'collaborative:resumed_by_owner',
      );

      return {
        action:
          intv.type === 'approve'
            ? 'approve'
            : intv.type === 'reject'
              ? 'reject'
              : 'skip',
        intervention: intv,
        newImagePrompt: intv.newImagePrompt ?? undefined,
        newMotionPrompt: intv.newMotionPrompt ?? undefined,
        additionalComments,
        waitedMs,
      };
    }
  }

  // Timeout
  await db
    .update(runs)
    .set({
      awaitingApproval: false,
      pausedAtSceneIndex: null,
    })
    .where(eq(runs.id, input.runId));

  input.logger?.warn(
    {
      runId: input.runId,
      sceneIndex: input.sceneIndex,
      timeoutMin: MAX_WAIT_MS / 60_000,
      entity: 'COLLABORATIVE MODE',
    },
    'collaborative:timeout_owner_no_response',
  );

  return {
    action: 'timeout',
    additionalComments,
    waitedMs: Date.now() - t0,
  };
}

/**
 * Helper para que la UI sepa si el pipeline está esperando intervención.
 */
export async function isAwaitingApproval(runId: string): Promise<{
  awaitingApproval: boolean;
  pausedAtSceneIndex: number | null;
  mode: 'auto' | 'collaborative';
}> {
  const row = (
    await db.select().from(runs).where(eq(runs.id, runId)).limit(1)
  )[0];
  if (!row) {
    return { awaitingApproval: false, pausedAtSceneIndex: null, mode: 'auto' };
  }
  return {
    awaitingApproval: Boolean((row as { awaitingApproval?: boolean }).awaitingApproval),
    pausedAtSceneIndex: (row as { pausedAtSceneIndex?: number | null }).pausedAtSceneIndex ?? null,
    mode: ((row as { mode?: string }).mode ?? 'auto') as 'auto' | 'collaborative',
  };
}
