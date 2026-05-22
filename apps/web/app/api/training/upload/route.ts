// POST /api/training/upload — sube un video al repositorio de aprendizaje.
//
// No dispara el training automáticamente. El user debe ir a /aprendizaje/[id]
// y hacer clic "Aprender formato" para arrancar el loop iterativo.

import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, extname } from 'node:path';
import { NextResponse } from 'next/server';
import { db, trainingVideos } from '@/lib/db';
import { isAuthenticated } from '@/lib/auth';
import { trainingWorkDirFor } from '@/lib/paths';

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

  return NextResponse.json({ trainingId, status: 'uploaded' });
}
