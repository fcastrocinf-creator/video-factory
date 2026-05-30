// POST /api/runs/[id]/fork
//
// SISTEMA FORK v3.2 (29-may-2026)
//
// Cualquier run puede "forkearse" desde una scene específica: copiamos los
// assets aprobados (scene_00 hasta scene_NN .png y .mp4) + scene-plan.json +
// audio.mp3 a un workDir nuevo, creamos un run nuevo apuntando al fuente vía
// originalRunId, y arrancamos el pipeline en modo colaborativo.
//
// El pipeline detecta el fork-metadata.json en workDir y:
//   - SALTA el scene-planner (usa el scene-plan.json copiado tal cual)
//   - SALTA image-gen-multi para scenes con .png existente
//   - SALTA scene-animator + VALIDATOR + collaborative-pause para scenes
//     pre-aprobadas (las que vinieron del fork)
//   - ARRANCA en la próxima scene no aprobada
//
// Casos de uso:
//   1. "Empezar de cero pero conservando lo que ya aprobé" — fork al final
//      del run actual antes de irse a dormir, mañana sigue tranquilo.
//   2. "Probar alternativa desde la scene N" — fork acá, edita scene N+1
//      diferente, compara con el original.
//   3. "Recuperar trabajo perdido" — si el dev-server se reinició y mató
//      el pipeline (cosa que ya nos pasó hoy), fork del último estado bueno.
//
// Body:
//   { "fromSceneIndex": N }    // copia scenes 0..N (inclusive)
//
// Response:
//   { "runId": "<new-uuid>", "mode": "collaborative", "copiedScenes": N+1 }

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { NextResponse, type NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, runs } from '@/lib/db';
import { isAuthenticated } from '@/lib/auth';
import { runPipeline } from '@/lib/pipeline';
import { workDirFor } from '@/lib/paths';

export const runtime = 'nodejs';

// v3.2 #138 audit: cap fromSceneIndex a 100 (un video normal tiene 8-30 scenes).
// Sin esto un valor enorme dispara N existsSync syscalls innecesarios.
const ForkRequestSchema = z.object({
  fromSceneIndex: z.number().int().nonnegative().max(100),
});

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }

  const source = (await db.select().from(runs).where(eq(runs.id, params.id)).limit(1))[0];
  if (!source) {
    return NextResponse.json({ error: 'Run de origen no encontrado' }, { status: 404 });
  }

  // v3.2 #138 audit: rechazar fork sobre run en curso. El pipeline activo puede
  // estar escribiendo scene-plan.json o scene_NN.png mientras copyFile los lee
  // → JSON truncado o png corrupto en el destino. Owner debe esperar a que el
  // run de origen pause (awaitingApproval=true) o termine antes de forkear.
  if (source.status === 'running' && !(source as { awaitingApproval?: boolean }).awaitingApproval) {
    return NextResponse.json(
      {
        error:
          'El run de origen está corriendo activamente. Espera a que pause (pidiendo aprobación) o complete antes de forkear, para evitar copiar archivos a medio escribir.',
      },
      { status: 409 },
    );
  }

  let body: z.infer<typeof ForkRequestSchema>;
  try {
    const raw = await req.json();
    const parsed = ForkRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: `Body inválido: ${parsed.error.message.slice(0, 200)}` },
        { status: 400 },
      );
    }
    body = parsed.data;
  } catch {
    return NextResponse.json({ error: 'Body no es JSON válido' }, { status: 400 });
  }

  const sourceWorkDir = (source as { workDir?: string }).workDir ?? workDirFor(source.id);
  if (!existsSync(sourceWorkDir)) {
    return NextResponse.json(
      { error: `Workdir del run de origen no existe: ${sourceWorkDir}` },
      { status: 404 },
    );
  }
  const sourcePlanPath = resolve(sourceWorkDir, 'scene-plan.json');
  if (!existsSync(sourcePlanPath)) {
    return NextResponse.json(
      { error: 'scene-plan.json no existe en el run de origen — no se puede forkear' },
      { status: 400 },
    );
  }

  // Verificar que las scenes pedidas existan en disco Y SEAN CONTIGUAS.
  // v3.2 #138 audit: rechazar fork con gaps. Si scene_00 + scene_02 existen
  // pero scene_01 falta, el pipeline se va a pausar en scene 1 después de
  // saltar la 0, rompiendo la invariante "0..N pre-aprobadas". Mejor abortar.
  const scenesToCopy: number[] = [];
  let gapAt: number | null = null;
  for (let i = 0; i <= body.fromSceneIndex; i++) {
    const padded = String(i).padStart(2, '0');
    const png = resolve(sourceWorkDir, `scene_${padded}.png`);
    if (existsSync(png)) {
      scenesToCopy.push(i);
    } else if (scenesToCopy.length > 0) {
      // Ya teníamos contiguos y ahora apareció un hueco.
      gapAt = i;
      break;
    }
  }
  if (gapAt !== null) {
    return NextResponse.json(
      {
        error: `El run de origen tiene un hueco en scene ${gapAt}. Solo puedes forkear desde un bloque contiguo de scenes aprobadas. Prueba con fromSceneIndex=${gapAt - 1}.`,
      },
      { status: 400 },
    );
  }
  if (scenesToCopy.length === 0) {
    return NextResponse.json(
      {
        error: `Ninguna scene_00..scene_${String(body.fromSceneIndex).padStart(2, '0')}.png existe en disco. Asegúrate que el run de origen llegó a esa scene.`,
      },
      { status: 400 },
    );
  }

  // v3.2 #138 audit: verificar que CADA scene tenga AMBOS png y mp4. Si solo
  // hay png, el scene-animator va a re-animar igual (no skip) → wasted compute.
  // Mejor avisar al owner.
  const partialScenes: number[] = [];
  for (const idx of scenesToCopy) {
    const padded = String(idx).padStart(2, '0');
    const mp4 = resolve(sourceWorkDir, `scene_${padded}.mp4`);
    if (!existsSync(mp4)) partialScenes.push(idx);
  }
  if (partialScenes.length > 0 && partialScenes.length === scenesToCopy.length) {
    return NextResponse.json(
      {
        error: `Las scenes ${partialScenes.join(', ')} tienen imagen pero no clip animado. Espera a que terminen de animarse antes de forkear.`,
      },
      { status: 400 },
    );
  }

  // Crear el run nuevo
  const newRunId = randomUUID();
  const newWorkDir = workDirFor(newRunId);
  await mkdir(newWorkDir, { recursive: true });

  // Copiar audio.mp3
  const sourceAudio = resolve(sourceWorkDir, 'audio.mp3');
  if (existsSync(sourceAudio)) {
    try {
      await copyFile(sourceAudio, resolve(newWorkDir, 'audio.mp3'));
    } catch (e) {
      return NextResponse.json(
        { error: `No se pudo copiar audio: ${(e as Error).message}` },
        { status: 500 },
      );
    }
  }

  // Copiar scene-plan.json
  try {
    await copyFile(sourcePlanPath, resolve(newWorkDir, 'scene-plan.json'));
  } catch (e) {
    return NextResponse.json(
      { error: `No se pudo copiar scene-plan.json: ${(e as Error).message}` },
      { status: 500 },
    );
  }

  // Copiar assets de scenes aprobadas
  for (const idx of scenesToCopy) {
    const padded = String(idx).padStart(2, '0');
    for (const ext of ['png', 'mp4']) {
      const src = resolve(sourceWorkDir, `scene_${padded}.${ext}`);
      if (existsSync(src)) {
        try {
          await copyFile(src, resolve(newWorkDir, `scene_${padded}.${ext}`));
        } catch {
          // No fatal — la pipeline puede regenerar si falta
        }
      }
    }
  }

  // Escribir fork-metadata.json para que el pipeline sepa qué scenes ya están listas
  const forkMeta = {
    sourceRunId: source.id,
    fromSceneIndex: body.fromSceneIndex,
    copiedScenes: scenesToCopy,
    forkedAt: new Date().toISOString(),
    note: 'Las scenes en copiedScenes ya están aprobadas — el pipeline NO debe regenerarlas ni pausar para owner.',
  };
  await writeFile(
    resolve(newWorkDir, 'fork-metadata.json'),
    JSON.stringify(forkMeta, null, 2),
    'utf-8',
  );

  // Crear row del run nuevo en DB
  await db.insert(runs).values({
    id: newRunId,
    brandId: source.brandId,
    presetId: source.presetId,
    productId: source.productId,
    scriptRaw: source.scriptRaw,
    status: 'pending',
    progress: 0,
    workDir: newWorkDir,
    originalRunId: source.id,
    mode: 'collaborative',
    createdAt: new Date(),
    startedAt: new Date(),
  } as never);

  // Arrancar el pipeline (en background, no esperamos)
  // v3.2 #138 audit: si runPipeline throwea ANTES de su try/catch interno
  // (ej. brandId inválido, presetId no encontrado), el row queda 'pending'
  // forever. Marcamos failed defensivamente con el error.
  void runPipeline(newRunId, source.brandId, source.presetId, source.scriptRaw ?? '', {
    productId: source.productId ?? null,
    mode: 'collaborative',
  }).catch(async (pipelineErr) => {
    try {
      await db
        .update(runs)
        .set({
          status: 'failed',
          errorMessage: `Pipeline arrancó pero murió antes del try/catch interno: ${(pipelineErr as Error).message?.slice(0, 500) ?? 'sin mensaje'}`,
          completedAt: new Date(),
        })
        .where(eq(runs.id, newRunId));
    } catch {
      // best-effort, sin throw para no perder el evento
    }
  });

  return NextResponse.json({
    runId: newRunId,
    mode: 'collaborative',
    copiedScenes: scenesToCopy.length,
    sourceRunId: source.id,
  });
}
