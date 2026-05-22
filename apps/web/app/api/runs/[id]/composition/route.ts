// Endpoint del EDITOR MANUAL de composición.
//
//   GET  /api/runs/[id]/composition  → devuelve el sceneTrack del run (escenas
//        + su composición libre / subScenes / imagePath). El editor lo consume
//        para dibujar el canvas.
//   PUT  /api/runs/[id]/composition  → recibe { sceneIndex, composition } y
//        reescribe scene-plan.json con la composición ajustada por el usuario.
//        El loop de aprendizaje (Fase 4) lee estos cambios.
//
// Fuente de verdad: workDir/scene-plan.json (lo persiste pipeline.ts al final).

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, runs } from '@/lib/db';
import { isAuthenticated } from '@/lib/auth';
import {
  SceneTrackSchema,
  CompositeElementSchema,
  RenderJobSchema,
} from '@video-factory/contracts';
import { diffComposition, recordCompositionCorrection } from '@video-factory/core';

export const runtime = 'nodejs';

function scenePlanPath(workDir: string): string {
  return resolve(workDir, 'scene-plan.json');
}

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }

  const result = await db.select().from(runs).where(eq(runs.id, params.id)).limit(1);
  const run = result[0];
  if (!run || !run.workDir) {
    return NextResponse.json({ error: 'Run sin workDir' }, { status: 404 });
  }

  const planPath = scenePlanPath(run.workDir);
  if (!existsSync(planPath)) {
    return NextResponse.json(
      { error: 'Este run no tiene scene-plan.json (es anterior a la persistencia del sceneTrack).' },
      { status: 404 },
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(planPath, 'utf-8'));
  } catch (e) {
    return NextResponse.json(
      { error: `scene-plan.json corrupto: ${(e as Error).message}` },
      { status: 500 },
    );
  }

  const parsed = SceneTrackSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: `scene-plan.json inválido: ${parsed.error.message}` },
      { status: 500 },
    );
  }

  return NextResponse.json({
    runId: run.id,
    totalDurationSeconds: parsed.data.totalDurationSeconds,
    styleBase: parsed.data.styleBase,
    scenes: parsed.data.scenes,
  });
}

const PutBodySchema = z.object({
  sceneIndex: z.number().int().nonnegative(),
  composition: z.array(CompositeElementSchema),
});

export async function PUT(req: Request, { params }: { params: { id: string } }) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }

  const result = await db.select().from(runs).where(eq(runs.id, params.id)).limit(1);
  const run = result[0];
  if (!run || !run.workDir) {
    return NextResponse.json({ error: 'Run sin workDir' }, { status: 404 });
  }

  const planPath = scenePlanPath(run.workDir);
  if (!existsSync(planPath)) {
    return NextResponse.json({ error: 'Run sin scene-plan.json' }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }
  const parsedBody = PutBodySchema.safeParse(body);
  if (!parsedBody.success) {
    return NextResponse.json({ error: parsedBody.error.message }, { status: 400 });
  }

  // Cargar y validar el sceneTrack actual
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(planPath, 'utf-8'));
  } catch (e) {
    return NextResponse.json(
      { error: `scene-plan.json corrupto: ${(e as Error).message}` },
      { status: 500 },
    );
  }
  const parsed = SceneTrackSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: `scene-plan.json inválido: ${parsed.error.message}` },
      { status: 500 },
    );
  }

  const sceneTrack = parsed.data;
  const target = sceneTrack.scenes.find((s) => s.index === parsedBody.data.sceneIndex);
  if (!target) {
    return NextResponse.json(
      { error: `Escena ${parsedBody.data.sceneIndex} no existe en este run` },
      { status: 404 },
    );
  }

  // Aplicar la composición editada a la escena objetivo
  target.composition = parsedBody.data.composition;

  try {
    await writeFile(planPath, JSON.stringify(sceneTrack, null, 2), 'utf-8');
  } catch (e) {
    return NextResponse.json(
      { error: `No se pudo guardar scene-plan.json: ${(e as Error).message}` },
      { status: 500 },
    );
  }

  // === LOOP DE APRENDIZAJE (Fase 4) ===
  // Comparamos la composición que el usuario guardó con la que la IA propuso
  // originalmente (render-job.json, inmutable) y registramos la corrección.
  // El detector de geometría lee estas correcciones como ejemplos few-shot.
  // Best-effort: si algo falla, NO bloquea el guardado.
  let learnedCorrections = 0;
  try {
    const renderJobPath = resolve(run.workDir, 'render-job.json');
    if (existsSync(renderJobPath)) {
      const rj = RenderJobSchema.safeParse(JSON.parse(await readFile(renderJobPath, 'utf-8')));
      if (rj.success) {
        const aiScene = rj.data.sceneTrack?.scenes.find(
          (s) => s.index === parsedBody.data.sceneIndex,
        );
        const aiComposition = aiScene?.composition ?? [];
        if (aiComposition.length > 0) {
          const toLike = (el: {
            id: string;
            kind: string;
            rect: { xPct: number; yPct: number; widthPct: number; heightPct: number };
            rotationDeg?: number;
            opacity?: number;
            zIndex?: number;
          }) => ({
            id: el.id,
            kind: el.kind,
            rect: el.rect,
            rotationDeg: el.rotationDeg,
            opacity: el.opacity,
            zIndex: el.zIndex,
          });
          const { corrections, summary } = diffComposition(
            aiComposition.map(toLike),
            parsedBody.data.composition.map(toLike),
          );
          if (corrections.length > 0) {
            await recordCompositionCorrection({
              runId: run.id,
              brand: run.brandId,
              preset: run.presetId,
              sceneIndex: parsedBody.data.sceneIndex,
              narration: target.text,
              elementCorrections: corrections,
              summary,
            });
            learnedCorrections = corrections.length;
          }
        }
      }
    }
  } catch {
    // best-effort — el aprendizaje no debe romper el guardado
  }

  return NextResponse.json({
    ok: true,
    sceneIndex: parsedBody.data.sceneIndex,
    elementCount: parsedBody.data.composition.length,
    learnedCorrections,
  });
}
