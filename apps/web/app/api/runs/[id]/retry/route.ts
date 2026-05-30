// POST /api/runs/[id]/retry — reinicia un run que falló.
//
// Limpia el workDir (parcial del intento anterior), resetea el row a status='pending'
// con progress=0 y errorMessage=null, y re-dispara runPipeline en background con
// los MISMOS params (brandId, presetId, productId, scriptRaw).
//
// Útil para errores transitorios:
//   - "Gemini devolvió 0 escenas" (scene-planner blip)
//   - Provider 5xx temporal
//   - Timeout de red

import { rm, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, runs } from '@/lib/db';
import { isAuthenticated } from '@/lib/auth';
import { workDirFor } from '@/lib/paths';
import { runPipeline } from '@/lib/pipeline';

export const runtime = 'nodejs';

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  const row = (await db.select().from(runs).where(eq(runs.id, params.id)).limit(1))[0];
  if (!row) {
    return NextResponse.json({ error: 'Run no encontrado' }, { status: 404 });
  }
  if (row.status === 'pending' || row.status === 'running') {
    return NextResponse.json(
      { error: `Run ya en curso (status=${row.status})` },
      { status: 409 },
    );
  }

  // Limpiamos workDir si existe (puede tener artefactos parciales del intento fallido)
  const workDir = row.workDir ?? workDirFor(row.id);
  // v3.3 (fix-dataloss): si el run ya tiene escenas generadas/aprobadas, NO las
  // destruimos con rm -rf. Reintentar desde cero borraría trabajo aprobado del
  // owner — lo dirigimos al flujo de fork (que preserva las escenas).
  if (existsSync(workDir)) {
    const hasScenes = (await readdir(workDir)).some((f) => /^scene_\d+\.png$/.test(f));
    if (hasScenes) {
      return NextResponse.json(
        {
          error:
            'Este run ya tiene escenas generadas. Para no perderlas, usa "Forkear" y continúa desde la última escena buena, en vez de reintentar desde cero (que las borraría).',
        },
        { status: 409 },
      );
    }
    try {
      await rm(workDir, { recursive: true, force: true });
    } catch {
      // Si no se puede borrar (algún archivo bloqueado), seguimos igual —
      // runPipeline puede sobreescribir lo necesario.
    }
  }
  await mkdir(workDir, { recursive: true });

  // Reset del row en DB
  await db
    .update(runs)
    .set({
      status: 'pending',
      progress: 0,
      currentStep: null,
      errorMessage: null,
      outputPath: null,
      durationSeconds: null,
      completedAt: null,
      startedAt: null,
      workDir,
    })
    .where(eq(runs.id, params.id));

  // Re-disparar pipeline en background con los mismos params del run original
  void runPipeline(row.id, row.brandId, row.presetId, row.scriptRaw, {
    voiceOverride: null,
    narratorGenderOverride: null,
  }).catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[runs/retry] pipeline uncaught error for run', row.id, err);
  });

  return NextResponse.json({ ok: true, runId: row.id, status: 'pending' });
}
