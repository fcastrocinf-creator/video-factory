import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, runs } from '@/lib/db';
import { isAuthenticated } from '@/lib/auth';

export const runtime = 'nodejs';

// GET /api/runs/[id]/thumbnail → devuelve scene_00.png si existe, sino 404.
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }

  const result = await db.select().from(runs).where(eq(runs.id, params.id)).limit(1);
  const run = result[0];
  if (!run || !run.workDir) {
    return NextResponse.json({ error: 'Run sin workDir' }, { status: 404 });
  }
  const sceneZero = resolve(run.workDir, 'scene_00.png');
  if (!existsSync(sceneZero)) {
    return NextResponse.json({ error: 'Thumbnail no disponible' }, { status: 404 });
  }
  try {
    const buf = await readFile(sceneZero);
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        'content-type': 'image/png',
        'cache-control': 'private, max-age=300',
      },
    });
  } catch {
    return NextResponse.json({ error: 'No se pudo leer thumbnail' }, { status: 500 });
  }
}
