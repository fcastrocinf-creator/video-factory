// GET /api/presets/[id]/preview → sirve el GIF preview de un preset aprendido,
// si existe. 404 si no hay preview o si el preset no es learned-*.
//
// Los previews se generan automáticamente al completar el primer run con un
// preset learned-* (ver pipeline.ts → generateLearnedPresetPreview).

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import { PRESETS_DIR, PENDING_PRESETS_DIR } from '@/lib/paths';

export const runtime = 'nodejs';

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }

  // Solo servimos previews de presets aprendidos. Los manuales no tienen
  // preview auto-generado (podrían tenerlo manual si alguien los pone, pero
  // por seguridad limitamos al prefix learned-).
  if (!params.id.startsWith('learned-')) {
    return NextResponse.json({ error: 'Preview no disponible para presets manuales' }, { status: 404 });
  }

  // Buscamos en ambos dirs: aprobados primero, pendientes después.
  const approvedPath = join(PRESETS_DIR, `${params.id}.preview.gif`);
  const pendingPath = join(PENDING_PRESETS_DIR, `${params.id}.preview.gif`);
  const previewPath = existsSync(approvedPath)
    ? approvedPath
    : existsSync(pendingPath)
      ? pendingPath
      : null;

  if (!previewPath) {
    return NextResponse.json({ error: 'Preview todavía no generado (corre un run primero)' }, { status: 404 });
  }

  try {
    const buf = await readFile(previewPath);
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        'content-type': 'image/gif',
        'cache-control': 'private, max-age=600',
      },
    });
  } catch {
    return NextResponse.json({ error: 'No se pudo leer el preview' }, { status: 500 });
  }
}
