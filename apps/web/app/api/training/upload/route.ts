// POST /api/training/upload — sube un video al repositorio de aprendizaje.
//
// AUTO-LEARN POST-UPLOAD (M7-B v3, 25-may-2026): al terminar el upload
// disparamos en background `runPresetLearningLoop` con targetScore=95. El
// preset queda persistido en `packages/presets/pending/` listo para reutilizar
// sin que el usuario tenga que ir a apretar botones. Misma lógica que el rip
// (`pipeline.ts`). Fire-and-forget — NO bloquea la respuesta al upload.
//
// El usuario puede igual usar los botones manuales en /aprendizaje/[id] para
// re-ejecutar con otro target o sobrescribir si quiere.

import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, extname } from 'node:path';
import { NextResponse } from 'next/server';
import { db, trainingVideos } from '@/lib/db';
import { isAuthenticated } from '@/lib/auth';
import { trainingWorkDirFor } from '@/lib/paths';
import { logSystemEvent } from '@/lib/system-log';

export const runtime = 'nodejs';

const MAX_BYTES = 200 * 1024 * 1024;
const ACCEPTED_MIME = new Set(['video/mp4', 'video/quicktime', 'video/webm']);
const MIME_TO_EXT: Record<string, string> = {
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
};

export async function POST(req: Request) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: 'FormData inválido' }, { status: 400 });
  }

  const file = formData.get('video');
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: 'Archivo de video requerido en campo "video"' }, { status: 400 });
  }
  if (!ACCEPTED_MIME.has(file.type)) {
    return NextResponse.json(
      { error: `Tipo no soportado: ${file.type}. Acepta MP4, MOV, WebM.` },
      { status: 415 },
    );
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      {
        error: `Video demasiado grande: ${(file.size / 1024 / 1024).toFixed(1)} MB. Máximo 200 MB.`,
      },
      { status: 413 },
    );
  }

  const trainingId = randomUUID();
  const workDir = trainingWorkDirFor(trainingId);
  await mkdir(workDir, { recursive: true });
  const ext = extname(file.name) || MIME_TO_EXT[file.type] || '.bin';
  const videoPath = resolve(workDir, `source${ext}`);
  const buffer = Buffer.from(await file.arrayBuffer());
  await writeFile(videoPath, buffer);

  await db.insert(trainingVideos).values({
    id: trainingId,
    videoPath,
    videoFileName: file.name,
    videoBytes: file.size,
    status: 'uploaded',
  });

  // AUTO-LEARN POST-UPLOAD: dispara el loop iterativo en background con target
  // 95% (mismo default que el hook del rip en pipeline.ts). Best-effort — si
  // falla solo loggeamos, el usuario puede re-ejecutar manualmente con los
  // botones de /aprendizaje/[id].
  if (process.env['ANTHROPIC_API_KEY'] && !process.env['ANTHROPIC_API_KEY'].startsWith('ROTATE_')) {
    void (async () => {
      try {
        const { runPresetLearningLoop } = await import('@/lib/preset-learning-loop');
        const result = await runPresetLearningLoop({
          videoPath,
          targetScore: 95,
          maxIterations: 4,
          displayNameOverride: `🎯 Auto-learned from training ${trainingId.slice(0, 8)}`,
        });
        void logSystemEvent({
          kind: 'preset-approved',
          data: {
            trainingId,
            presetId: result.preset.id,
            approved: result.approved,
            exhausted: result.exhausted,
            finalScore: result.finalScore,
            iterations: result.iterationsRun,
            elapsedSec: Number(result.elapsedSec.toFixed(1)),
            triggerSource: 'training-upload-auto',
          },
          summary: `Preset auto-aprendido desde training ${trainingId.slice(0, 8)} — score ${result.finalScore}/100 ${result.approved ? 'APROBADO' : 'exhausted'} en ${result.iterationsRun} iter`,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // eslint-disable-next-line no-console
        console.warn(`[training/upload] auto-learn loop falló para ${trainingId}: ${msg.slice(0, 300)}`);
      }
    })();
  }

  return NextResponse.json({
    trainingId,
    status: 'uploaded',
    autoLearnDispatched: Boolean(
      process.env['ANTHROPIC_API_KEY'] && !process.env['ANTHROPIC_API_KEY'].startsWith('ROTATE_'),
    ),
  });
}
