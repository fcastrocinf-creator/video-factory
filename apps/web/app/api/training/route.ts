// GET /api/training — lista todos los videos del repositorio de aprendizaje.

import { NextResponse } from 'next/server';
import { desc } from 'drizzle-orm';
import { db, trainingVideos } from '@/lib/db';
import { isAuthenticated } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  const rows = await db
    .select({
      id: trainingVideos.id,
      videoFileName: trainingVideos.videoFileName,
      videoBytes: trainingVideos.videoBytes,
      status: trainingVideos.status,
      progress: trainingVideos.progress,
      currentStep: trainingVideos.currentStep,
      resultPresetId: trainingVideos.resultPresetId,
      errorMessage: trainingVideos.errorMessage,
      createdAt: trainingVideos.createdAt,
      trainedAt: trainingVideos.trainedAt,
    })
    .from(trainingVideos)
    .orderBy(desc(trainingVideos.createdAt));

  // Normalizamos timestamps a ISO string para que el cliente siempre reciba
  // el mismo tipo (Drizzle puede devolver Date o number según versión/driver).
  const toIso = (d: Date | number | null): string | null => {
    if (d === null) return null;
    if (d instanceof Date) return d.toISOString();
    return new Date((d as number) * 1000).toISOString();
  };
  const items = rows.map((r) => ({
    ...r,
    createdAt: toIso(r.createdAt),
    trainedAt: toIso(r.trainedAt),
  }));
  return NextResponse.json({ items });
}
