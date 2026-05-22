// GET /api/training/[id] — estado actual de un training, incluyendo la trayectoria
// para que el frontend muestre vivo el progreso (frames + iters + scores).

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, trainingVideos } from '@/lib/db';
import { isAuthenticated } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  const row = (
    await db.select().from(trainingVideos).where(eq(trainingVideos.id, params.id)).limit(1)
  )[0];
  if (!row) {
    return NextResponse.json({ error: 'Training no encontrado' }, { status: 404 });
  }

  // JSON parsing defensivo: si la data en DB está corrupta (escritura parcial,
  // bug previo), no queremos crashear el endpoint del polling. Devolvemos null
  // y un warning legible que el frontend puede mostrar.
  const safeParse = <T,>(raw: string | null, field: string): T | null => {
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(
        `[training/${params.id}] ${field} JSON corrupto:`,
        (e as Error).message,
      );
      return null;
    }
  };

  // Normalizamos timestamps a ISO string para que el cliente siempre reciba
  // el mismo tipo (evita ambigüedad number vs Date en JSON).
  const toIso = (d: Date | number | null): string | null => {
    if (d === null) return null;
    if (d instanceof Date) return d.toISOString();
    return new Date((d as number) * 1000).toISOString();
  };

  return NextResponse.json({
    id: row.id,
    videoFileName: row.videoFileName,
    videoBytes: row.videoBytes,
    status: row.status,
    progress: row.progress,
    currentStep: row.currentStep,
    errorMessage: row.errorMessage,
    resultPresetId: row.resultPresetId,
    analysis: safeParse(row.analysisJson, 'analysisJson'),
    trajectory: safeParse(row.trajectoryJson, 'trajectoryJson'),
    generalIdeas: safeParse(row.generalIdeasJson, 'generalIdeasJson'),
    createdAt: toIso(row.createdAt),
    trainedAt: toIso(row.trainedAt),
  });
}
