import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, extname } from 'node:path';
import { NextResponse } from 'next/server';
import { db, rips } from '@/lib/db';
import { isAuthenticated } from '@/lib/auth';
import { ripWorkDirFor } from '@/lib/paths';
import { analyzeAd } from '@/lib/ad-analyzer';
import { eq } from 'drizzle-orm';

export const runtime = 'nodejs';

// Máximo 200 MB. Para <=14 MB usamos inline base64 (rápido). >14 MB pasamos al
// File API de Google AI Studio. ad-analyzer.ts decide el path automáticamente.
const MAX_BYTES = 200 * 1024 * 1024;
const ACCEPTED_MIME = new Set(['video/mp4', 'video/quicktime', 'video/webm']);

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
        error: `Video demasiado grande: ${(file.size / 1024 / 1024).toFixed(1)} MB. Máximo 200 MB. Reduce calidad o duración.`,
      },
      { status: 413 },
    );
  }

  // 1. Guardar el video en storage/rips/<ripId>/source.<ext>
  const ripId = randomUUID();
  const workDir = ripWorkDirFor(ripId);
  await mkdir(workDir, { recursive: true });
  // Si el nombre del archivo no trae extensión, derivamos desde mime para que el
  // archivo en disco tenga la extensión correcta (útil para debugging local).
  const mimeToExt: Record<string, string> = {
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'video/webm': '.webm',
  };
  const ext = extname(file.name) || mimeToExt[file.type] || '.bin';
  const videoPath = resolve(workDir, `source${ext}`);
  const buffer = Buffer.from(await file.arrayBuffer());
  await writeFile(videoPath, buffer);

  // 2. Insertar en DB con status='analyzing'
  await db.insert(rips).values({
    id: ripId,
    videoPath,
    videoFileName: file.name,
    videoBytes: file.size,
    status: 'analyzing',
  });

  // 3. Disparar análisis en background — el frontend pollea /api/rip/[id]
  void (async () => {
    try {
      const analysis = await analyzeAd({ videoPath, mimeType: file.type });
      await db
        .update(rips)
        .set({
          status: 'analyzed',
          analysisJson: JSON.stringify(analysis),
          analyzedAt: new Date(),
        })
        .where(eq(rips.id, ripId));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[rip-upload] análisis falló', ripId, err);
      try {
        await db
          .update(rips)
          .set({
            status: 'failed',
            errorMessage: err instanceof Error ? err.message : String(err),
          })
          .where(eq(rips.id, ripId));
      } catch (dbErr) {
        // Si hasta el update de "failed" falla, lo dejamos en logs. El rip
        // quedará en "analyzing" hasta que alguien lo limpie manualmente.
        // eslint-disable-next-line no-console
        console.error('[rip-upload] failed to persist failure state', ripId, dbErr);
      }
    }
  })();

  return NextResponse.json({ ripId, status: 'analyzing' });
}
