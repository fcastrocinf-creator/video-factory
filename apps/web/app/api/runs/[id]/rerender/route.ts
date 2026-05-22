// POST /api/runs/[id]/rerender
//
// Dispara el re-render del video con la composición editada (scene-plan.json).
// No regenera imágenes — solo vuelve a correr el compositor. Corre en background.

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, runs } from '@/lib/db';
import { isAuthenticated } from '@/lib/auth';
import { rerenderComposition, renderJobExists } from '@/lib/rerender-composition';

export const runtime = 'nodejs';

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }

  const result = await db.select().from(runs).where(eq(runs.id, params.id)).limit(1);
  const run = result[0];
  if (!run || !run.workDir) {
    return NextResponse.json({ error: 'Run sin workDir' }, { status: 404 });
  }
  if (run.status === 'running') {
    return NextResponse.json(
      { error: 'El run ya está procesando — espera a que termine' },
      { status: 409 },
    );
  }
  if (!renderJobExists(run.workDir)) {
    return NextResponse.json(
      { error: 'Este run no soporta re-render (es anterior a la persistencia del render-job).' },
      { status: 409 },
    );
  }

  // Lanzamos el re-render en background. La UI puede polear el status del run.
  void rerenderComposition(params.id).catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[rerender] uncaught error for run', params.id, err);
  });

  return NextResponse.json({
    ok: true,
    message: 'Re-render encolado. El run pasará a "running" y volverá a "completed" al terminar.',
  });
}
