import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, runs } from '@/lib/db';
import { isAuthenticated } from '@/lib/auth';
import { workDirFor } from '@/lib/paths';
import { applyCorrection } from '@/lib/correction-pipeline';

export const runtime = 'nodejs';

const ACCEPTED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'video/mp4',
]);

const MAX_ASSET_BYTES = 50 * 1024 * 1024; // 50 MB

export async function POST(req: Request, { params }: { params: { id: string } }) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }

  const originalRunId = params.id;

  // Buscamos el run original — debe existir y estar completado para corregir
  const result = await db.select().from(runs).where(eq(runs.id, originalRunId)).limit(1);
  const original = result[0];
  if (!original) {
    return NextResponse.json({ error: 'Run original no encontrado' }, { status: 404 });
  }
  if (original.status !== 'completed') {
    return NextResponse.json(
      { error: 'Solo se pueden corregir runs ya completados' },
      { status: 409 },
    );
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: 'FormData inválido' }, { status: 400 });
  }

  const message = (formData.get('message') as string | null)?.trim() ?? '';
  if (!message || message.length < 5) {
    return NextResponse.json({ error: 'Mensaje de corrección requerido' }, { status: 400 });
  }

  // Si hay asset adjunto, validamos tipo y lo guardamos en el workDir del nuevo run
  const asset = formData.get('asset');
  let uploadedAssetPath: string | null = null;
  let uploadedAssetIsVideo = false;

  // Creamos el nuevo runId ANTES para usar su workDir como destino del asset
  const newRunId = randomUUID();
  const newWorkDir = workDirFor(newRunId);
  await mkdir(newWorkDir, { recursive: true });

  if (asset instanceof File && asset.size > 0) {
    if (!ACCEPTED_MIME.has(asset.type)) {
      return NextResponse.json(
        { error: `Tipo de archivo no soportado: ${asset.type}` },
        { status: 415 },
      );
    }
    if (asset.size > MAX_ASSET_BYTES) {
      return NextResponse.json(
        { error: `Archivo demasiado grande: ${(asset.size / 1024 / 1024).toFixed(1)} MB (máx 50 MB)` },
        { status: 413 },
      );
    }
    const ext = asset.type === 'video/mp4' ? 'mp4'
      : asset.type === 'image/jpeg' ? 'jpg'
      : asset.type === 'image/webp' ? 'webp'
      : 'png';
    uploadedAssetPath = resolve(newWorkDir, `correction-asset.${ext}`);
    const buf = Buffer.from(await asset.arrayBuffer());
    await writeFile(uploadedAssetPath, buf);
    uploadedAssetIsVideo = asset.type === 'video/mp4';
  }

  const correctionId = randomUUID();

  // Insertamos el registro del nuevo run en pending — el pipeline lo va a actualizar.
  // Heredamos productId y originalRunId para mantener trazabilidad del linaje:
  // el repositorio de runs muestra "Corrección de #abc123" usando originalRunId,
  // y el filtro por producto agrupa correcciones bajo el mismo producto del padre.
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

  // Lanzamos el pipeline de corrección en background
  void applyCorrection({
    originalRunId,
    newRunId,
    correctionMessage: message,
    uploadedAssetPath,
    uploadedAssetIsVideo,
  }).catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[correction] uncaught error for run', newRunId, err);
  });

  return NextResponse.json({
    correctionId,
    newRunId,
    message: 'Corrección encolada. Redirige a /runs/' + newRunId + ' para ver el progreso.',
  });
}
