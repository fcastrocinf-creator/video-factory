// GET /api/runs/[id]
//
// AUTO-RECOVERY DE RUNS ZOMBIE (27-may-2026): si el dev server cae a mitad
// de un pipeline, el row en DB queda con status='running' para siempre — el
// proceso Node murió antes de poder marcarlo failed. La UI poll lo muestra
// como "running 69%" indefinidamente y el botón "Reintentar" no aparece.
//
// Fix automatizado: al consultar el run, detectamos zombies (status=running
// + startedAt > ZOMBIE_THRESHOLD_MS atrás) y los auto-marcamos failed antes
// de devolver al cliente. Threshold 45 min es seguro: runs típicos tardan
// 5-25 min, alta fidelidad con muchas escenas hasta 30 min. 45 min es 1.5x
// el worst-case razonable.

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, runs } from '@/lib/db';
import { isAuthenticated } from '@/lib/auth';
import { logSystemEvent } from '@/lib/system-log';

export const runtime = 'nodejs';

// FIX 28-may-2026: threshold subido de 45 → 90 min después de false positives
// con rips de alta fidelidad (~52 escenas tardan 50-60 min legítimamente).
// 90 min cubre worst-case razonable (60 escenas × 3 attempts × ~30s c/u + animación).
const ZOMBIE_THRESHOLD_MS = 90 * 60 * 1000; // 90 minutos
// Anti-falso-positivo: si la última escritura del workDir es reciente, NO es zombie
// incluso si startedAt es viejo (el pipeline está vivo, solo es un rip largo).
const STALE_WORKDIR_THRESHOLD_MS = 5 * 60 * 1000; // 5 min sin escritura = sospechoso

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }

  const result = await db.select().from(runs).where(eq(runs.id, params.id)).limit(1);
  let run = result[0];
  if (!run) {
    return NextResponse.json({ error: 'Run no encontrado' }, { status: 404 });
  }

  // Auto-detection de zombie con doble check defensivo:
  //   1. status='running' y startedAt > ZOMBIE_THRESHOLD_MS atrás
  //   2. workDir.mtime > STALE_WORKDIR_THRESHOLD_MS atrás (sino el pipeline sigue vivo)
  // Si AMBAS condiciones se cumplen, marcamos failed. Sino, asumimos pipeline activo.
  let isZombie = false;
  if (
    run.status === 'running' &&
    // v3.3 (fix): un run colaborativo PAUSADO esperando aprobación del owner NO es
    // un zombie — está vivo, esperándote. No lo marcamos failed.
    !(run as { awaitingApproval?: unknown }).awaitingApproval &&
    run.startedAt &&
    Date.now() - new Date(run.startedAt).getTime() > ZOMBIE_THRESHOLD_MS
  ) {
    // Doble check: si el workDir está siendo escrito activamente, no es zombie.
    try {
      const { stat, readdir } = await import('node:fs/promises');
      if (run.workDir) {
        const entries = await readdir(run.workDir).catch(() => []);
        let mostRecentMtime = 0;
        for (const entry of entries) {
          try {
            const s = await stat(`${run.workDir}/${entry}`);
            if (s.mtimeMs > mostRecentMtime) mostRecentMtime = s.mtimeMs;
          } catch {
            /* skip */
          }
        }
        if (mostRecentMtime > 0 && Date.now() - mostRecentMtime < STALE_WORKDIR_THRESHOLD_MS) {
          // workDir escrito en los últimos 5 min → pipeline ACTIVO, NO marcar failed
          isZombie = false;
        } else {
          isZombie = true;
        }
      } else {
        isZombie = true; // sin workDir, no hay forma de saber, asumir zombie
      }
    } catch {
      isZombie = false; // si falla el check, mejor no marcar failed
    }
  }
  if (isZombie && run.startedAt) {
    const ageMinutes = Math.floor(
      (Date.now() - new Date(run.startedAt).getTime()) / 60000,
    );
    const zombieMessage =
      `Run auto-marcado FAILED por inactividad (${ageMinutes} min sin completar). ` +
      `Probable causa: dev server caído o proceso terminado a mitad de pipeline. ` +
      `Las imágenes/animaciones generadas hasta el corte están preservadas en disco. ` +
      `Usa "Forkear" para continuar desde la última escena buena sin perder lo generado.`;
    try {
      await db
        .update(runs)
        .set({
          status: 'failed',
          errorMessage: zombieMessage,
          completedAt: new Date(),
        })
        .where(eq(runs.id, params.id));
      // Re-leer el row actualizado para devolver el estado correcto al cliente
      const reloaded = await db.select().from(runs).where(eq(runs.id, params.id)).limit(1);
      if (reloaded[0]) run = reloaded[0];
      void logSystemEvent({
        kind: 'run-failed',
        data: {
          runId: params.id,
          ageMinutes,
          lastKnownStep: run.currentStep,
          lastKnownProgress: run.progress,
          triggerSource: 'auto-zombie-detection',
        },
        summary: `Run ${params.id.slice(0, 8)} auto-marcado FAILED por inactividad (${ageMinutes}min). Pipeline murió en ${run.currentStep ?? '?'} @ ${run.progress}%.`,
      });
    } catch {
      // Best-effort. Si el update falla, devolvemos el row original (status running)
      // — el peor caso es que el user vea la barra trabada igual que antes.
    }
  }

  return NextResponse.json({
    id: run.id,
    status: run.status,
    currentStep: run.currentStep,
    progress: run.progress,
    outputPath: run.outputPath,
    errorMessage: run.errorMessage,
    durationSeconds: run.durationSeconds,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    brandId: run.brandId,
    productId: run.productId,
    presetId: run.presetId,
    estimatedCostUsd: run.estimatedCostUsd,
    imageCount: run.imageCount,
    ttsCharsBilled: run.ttsCharsBilled,
    originalRunId: run.originalRunId,
  });
}
