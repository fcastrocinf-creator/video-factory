// POST /api/runs/[id]/scene-duration
//
// RECORTE MANUAL v3.2 #145 (29-may-2026)
//
// El owner quiere cortar una escena en el segundo que elija (en vez de la
// duración auto-alineada al audio). Este endpoint persiste
// scene.manualDurationSeconds en scene-plan.json. El compositor lo respeta al
// renderizar el video final (NO requiere regenerar la imagen ni el clip — solo
// cambia cuánto tiempo se muestra esa escena).
//
// Body:
//   { "sceneIndex": 1, "durationSeconds": 2.3 }   // recortar a 2.3s
//   { "sceneIndex": 1, "durationSeconds": null }  // volver al auto-trim
//
// Response:
//   { "ok": true, "sceneIndex": 1, "durationSeconds": 2.3 }

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { NextResponse, type NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, runs } from '@/lib/db';
import { isAuthenticated } from '@/lib/auth';
import { workDirFor } from '@/lib/paths';

export const runtime = 'nodejs';

const RequestSchema = z.object({
  sceneIndex: z.number().int().nonnegative(),
  // null = limpiar el override (volver al auto-trim). Número = segundos.
  durationSeconds: z.number().positive().max(60).nullable(),
});

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  const row = (await db.select().from(runs).where(eq(runs.id, params.id)).limit(1))[0];
  if (!row) {
    return NextResponse.json({ error: 'Run no encontrado' }, { status: 404 });
  }

  let body: z.infer<typeof RequestSchema>;
  try {
    const parsed = RequestSchema.safeParse(await req.json());
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

  const workDir = (row as { workDir?: string }).workDir ?? workDirFor(row.id);
  const planPath = resolve(workDir, 'scene-plan.json');
  if (!existsSync(planPath)) {
    return NextResponse.json({ error: 'scene-plan.json no existe' }, { status: 404 });
  }

  try {
    const raw = await readFile(planPath, 'utf-8');
    const plan = JSON.parse(raw) as {
      scenes: Array<{ index: number; manualDurationSeconds?: number | null }>;
    };
    const scene = plan.scenes.find((s) => s.index === body.sceneIndex);
    if (!scene) {
      return NextResponse.json(
        { error: `Scene ${body.sceneIndex} no existe en el plan` },
        { status: 404 },
      );
    }
    scene.manualDurationSeconds = body.durationSeconds;
    await writeFile(planPath, JSON.stringify(plan, null, 2), 'utf-8');
    return NextResponse.json({
      ok: true,
      sceneIndex: body.sceneIndex,
      durationSeconds: body.durationSeconds,
      note: body.durationSeconds
        ? `Scene ${body.sceneIndex} se recortará a ${body.durationSeconds}s en el render final.`
        : `Scene ${body.sceneIndex} vuelve al recorte automático.`,
    });
  } catch (e) {
    return NextResponse.json(
      { error: `No se pudo actualizar: ${(e as Error).message}` },
      { status: 500 },
    );
  }
}
