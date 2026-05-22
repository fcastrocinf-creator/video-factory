// Sirve un archivo de imagen/video del workDir de un run, para que el editor
// manual de composición pueda mostrar las piezas (scene_XX.png,
// scene_XX_panel_*.png, etc.) en el canvas.
//
//   GET /api/runs/[id]/scene-asset?file=scene_05_panel_top-left.png
//
// Seguridad: `file` debe ser un basename simple (sin separadores de ruta ni
// "..") con una extensión de media permitida — así no se puede salir del workDir.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, runs } from '@/lib/db';
import { isAuthenticated } from '@/lib/auth';

export const runtime = 'nodejs';

const SAFE_FILE = /^[A-Za-z0-9._-]+\.(png|jpg|jpeg|webp|mp4)$/;

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  mp4: 'video/mp4',
};

export async function GET(req: Request, { params }: { params: { id: string } }) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }

  const url = new URL(req.url);
  const file = url.searchParams.get('file') ?? '';
  // Doble defensa: regex + basename() para neutralizar cualquier intento de
  // path traversal (../, rutas absolutas, separadores).
  if (!SAFE_FILE.test(file) || basename(file) !== file) {
    return NextResponse.json({ error: 'Nombre de archivo inválido' }, { status: 400 });
  }

  const result = await db.select().from(runs).where(eq(runs.id, params.id)).limit(1);
  const run = result[0];
  if (!run || !run.workDir) {
    return NextResponse.json({ error: 'Run sin workDir' }, { status: 404 });
  }

  const assetPath = resolve(run.workDir, file);
  // Confirmamos que el path resuelto sigue dentro del workDir.
  if (!assetPath.startsWith(resolve(run.workDir))) {
    return NextResponse.json({ error: 'Ruta fuera del workDir' }, { status: 400 });
  }
  if (!existsSync(assetPath)) {
    return NextResponse.json({ error: 'Archivo no encontrado' }, { status: 404 });
  }

  const ext = file.split('.').pop()!.toLowerCase();
  try {
    const buf = await readFile(assetPath);
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        'content-type': MIME[ext] ?? 'application/octet-stream',
        'cache-control': 'private, max-age=120',
      },
    });
  } catch {
    return NextResponse.json({ error: 'No se pudo leer el archivo' }, { status: 500 });
  }
}
