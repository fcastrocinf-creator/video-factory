import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, runs } from '@/lib/db';
import { isAuthenticated } from '@/lib/auth';

export const runtime = 'nodejs';

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }

  const result = await db.select().from(runs).where(eq(runs.id, params.id)).limit(1);
  const run = result[0];
  if (!run) {
    return NextResponse.json({ error: 'Run no encontrado' }, { status: 404 });
  }

  return NextResponse.json({
    id: run.id,
    status: run.status,
    currentStep: run.currentStep,
    progress: run.progress,
    outputPath: run.outputPath,
    errorMessage: run.errorMessage,
    durationSeconds: run.durationSeconds,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
  });
}
