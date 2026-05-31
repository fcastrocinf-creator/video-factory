// RE-RENDER de composición (Fase 3 — editor manual).
//
// Vuelve a generar el final.mp4 de un run usando el scene-plan.json EDITADO por
// el usuario en el editor de composición — SIN regenerar imágenes ni audio.
// Recarga el render-job.json persistido por el pipeline, le inyecta el
// sceneTrack actualizado, y corre únicamente el compositor-remotion.
//
// Es barato y rápido comparado con un rip completo: solo es el render de
// Remotion (~1-3 min), cero llamadas a APIs de generación.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { createLogger, type BlockContext } from '@video-factory/core';
import { RenderJobSchema, SceneTrackSchema } from '@video-factory/contracts';
import { compositorRemotion } from '@video-factory/block-compositor-remotion';
import { db, runs } from './db';
import { loadBrand, loadPreset } from './brand-preset-loader';

async function updateRun(runId: string, updates: Record<string, unknown>): Promise<void> {
  await db.update(runs).set(updates).where(eq(runs.id, runId));
}

export function renderJobExists(workDir: string): boolean {
  return existsSync(resolve(workDir, 'render-job.json'));
}

/**
 * Re-renderiza el video de un run con la composición editada. Pensado para
 * correr en background (el caller hace `void rerenderComposition(id)`).
 * Actualiza el status del run mientras procesa.
 */
export async function rerenderComposition(
  runId: string,
  opts: { kenBurns?: boolean } = {},
): Promise<void> {
  const logger = createLogger(runId);
  try {
    const result = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    const run = result[0];
    if (!run || !run.workDir) throw new Error('Run sin workDir');
    const workDir = run.workDir;

    const renderJobPath = resolve(workDir, 'render-job.json');
    const scenePlanPath = resolve(workDir, 'scene-plan.json');
    if (!existsSync(renderJobPath)) {
      throw new Error('render-job.json no encontrado — este run es anterior a la persistencia');
    }
    if (!existsSync(scenePlanPath)) {
      throw new Error('scene-plan.json no encontrado');
    }

    // Recargar el RenderJob base persistido por el pipeline.
    const renderJob = RenderJobSchema.parse(JSON.parse(await readFile(renderJobPath, 'utf-8')));
    // Recargar el sceneTrack EDITADO por el editor de composición.
    const sceneTrack = SceneTrackSchema.parse(JSON.parse(await readFile(scenePlanPath, 'utf-8')));
    // Inyectar el sceneTrack editado y resetear estado del job.
    renderJob.sceneTrack = sceneTrack;
    renderJob.status = 'pending';
    // Ken Burns OPT-IN: el usuario lo activa/desactiva desde el editor de composición.
    if (opts.kenBurns !== undefined) renderJob.kenBurns = opts.kenBurns;

    const [brand, preset] = await Promise.all([
      loadBrand(run.brandId),
      loadPreset(run.presetId),
    ]);

    const ctx: BlockContext = {
      runId,
      workDir,
      logger,
      brand,
      preset,
      onBlockProgress: (subPct) => {
        const pct = Math.min(99, Math.max(5, Math.round(subPct * 100)));
        void updateRun(runId, { progress: pct }).catch(() => {});
      },
    };

    await updateRun(runId, {
      status: 'running',
      currentStep: 'compositor-remotion',
      progress: 5,
      errorMessage: null,
    });

    const renderResult = await compositorRemotion.run(renderJob, ctx);
    if (renderResult.isErr()) throw renderResult.error;

    await updateRun(runId, { status: 'completed', currentStep: null, progress: 100 });
    logger.info({ runId }, 'rerender:done');
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    logger.error({ runId, err: msg }, 'rerender:failed');
    // El video original sigue siendo válido — dejamos el run 'completed' pero
    // registramos el error para que la UI lo muestre.
    await updateRun(runId, {
      status: 'completed',
      currentStep: null,
      progress: 100,
      errorMessage: `Re-render falló: ${msg.slice(0, 300)}`,
    }).catch(() => {});
    throw e;
  }
}
