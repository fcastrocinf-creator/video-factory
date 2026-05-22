// GET /api/training/[id]/frame?path=relativePath — sirve un PNG del workDir.
//
// Anti path traversal: validamos que el path resuelto esté DENTRO del workDir
// del training. Si no, 403.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, relative, sep, isAbsolute } from 'node:path';
import { NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import { trainingWorkDirFor } from '@/lib/paths';

export const runtime = 'nodejs';

// Sólo permitimos training IDs con formato UUID-like (no path traversal en el id)
const SAFE_TRAINING_ID = /^[a-zA-Z0-9-]{1,80}$/;

export async function GET(req: Request, { params }: { params: { id: string } }) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  if (!SAFE_TRAINING_ID.test(params.id)) {
    return NextResponse.json({ error: 'training id inválido' }, { status: 400 });
  }
  const url = new URL(req.url);
  const relPath = url.searchParams.get('path');
  if (!relPath) {
    return NextResponse.json({ error: 'param "path" requerido' }, { status: 400 });
  }
  // Rechazamos cualquier path que parezca absoluto o contenga "..": el caller
  // siempre debe pasar paths RELATIVOS dentro del workDir.
  if (isAbsolute(relPath) || relPath.includes('..') || relPath.includes('\0')) {
    return NextResponse.json({ error: 'path inválido' }, { status: 400 });
  }
  const workDir = trainingWorkDirFor(params.id);
  const fullPath = resolve(workDir, relPath);
  // Sandbox robusto: usamos path.relative() que devuelve string vacío si los
  // paths son iguales, "subdir/..." si fullPath está dentro de workDir, o
  // empieza con ".." / es absoluto si está afuera. Cross-platform safe.
  const rel = relative(workDir, fullPath);
  if (rel.startsWith('..') || isAbsolute(rel) || rel.includes(`..${sep}`)) {
    return NextResponse.json({ error: 'path fuera del workDir' }, { status: 403 });
  }
  if (!existsSync(fullPath)) {
    return NextResponse.json({ error: 'frame no encontrado' }, { status: 404 });
  }
  try {
    const buf = await readFile(fullPath);
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        'content-type': 'image/png',
        'cache-control': 'private, max-age=60',
      },
    });
  } catch {
    return NextResponse.json({ error: 'no se pudo leer el frame' }, { status: 500 });
  }
}
