// GET /api/runs/[id]/scene-plan
//
// Devuelve el scene-plan.json del workDir + el scriptRaw del DB.
// La UI lo usa para mostrar:
//   - Texto narrado específico de cada scene (scene.text)
//   - Guión completo expandible (scriptRaw)
//   - imagePrompt usado para generar cada scene

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { NextResponse, type NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, runs } from '@/lib/db';
import { isAuthenticated } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }

  const row = (await db.select().from(runs).where(eq(runs.id, params.id)).limit(1))[0];
  if (!row) {
    return NextResponse.json({ error: 'Run no encontrado' }, { status: 404 });
  }

  let scenes: Array<{
    index: number;
    text: string;
    imagePrompt: string;
    startTimeSeconds?: number;
    endTimeSeconds?: number;
    // v3.2 #145: lip-sync vs voice-over + recorte manual
    speaking?: boolean;
    manualDurationSeconds?: number | null;
  }> = [];

  if (row.workDir) {
    const planPath = resolve(row.workDir, 'scene-plan.json');
    if (existsSync(planPath)) {
      try {
        const raw = await readFile(planPath, 'utf-8');
        const parsed = JSON.parse(raw) as {
          scenes?: typeof scenes;
        };
        if (parsed.scenes) {
          scenes = parsed.scenes.map((s) => ({
            index: s.index,
            text: s.text,
            imagePrompt: s.imagePrompt,
            startTimeSeconds: s.startTimeSeconds,
            endTimeSeconds: s.endTimeSeconds,
            speaking: (s as { speaking?: boolean }).speaking,
            manualDurationSeconds: (s as { manualDurationSeconds?: number | null })
              .manualDurationSeconds,
          }));
        }
      } catch {
        // scene-plan.json corrupto o no se puede leer
      }
    }
  }

  return NextResponse.json({
    runId: params.id,
    scriptRaw: row.scriptRaw,
    scenes,
    totalScenes: scenes.length,
  });
}
