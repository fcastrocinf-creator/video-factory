// POST /api/training/[id]/learn — dispara el loop de aprendizaje de estilo.
//
// Validations:
//   - Training debe existir y estar en status 'uploaded' o 'failed' (re-try)
//   - Si está en 'analyzing' o 'training' actualmente, rechazamos para evitar
//     ejecutar el mismo loop dos veces en paralelo

import { NextResponse } from 'next/server';
import { and, eq, inArray } from 'drizzle-orm';
import { db, trainingVideos } from '@/lib/db';
import { isAuthenticated } from '@/lib/auth';
import { trainingWorkDirFor } from '@/lib/paths';
import { trainStyle, persistTrajectory } from '@/lib/style-trainer';

export const runtime = 'nodejs';

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  const row = (
    await db.select().from(trainingVideos).where(eq(trainingVideos.id, params.id)).limit(1)
  )[0];
  if (!row) {
    return NextResponse.json({ error: 'Training no encontrado' }, { status: 404 });
  }
  if (row.status === 'analyzing' || row.status === 'training') {
    return NextResponse.json(
      { error: `Training ya en curso (status=${row.status})` },
      { status: 409 },
    );
  }

  // CLAIM ATÓMICO: actualizamos a 'analyzing' SOLO si el status sigue en uploaded
  // o failed (es decir, nadie más arrancó el loop entre nuestro SELECT anterior
  // y este UPDATE). Esto evita la race condition donde dos requests paralelos al
  // mismo /learn podrían disparar dos trainStyle() en simultáneo.
  // libsql con drizzle no devuelve rowCount directamente en update sin returning,
  // así que usamos una bandera-flag query post-update.
  await db
    .update(trainingVideos)
    .set({
      status: 'analyzing',
      progress: 5,
      currentStep: 'ad-analyzer',
      errorMessage: null,
    })
    .where(
      and(
        eq(trainingVideos.id, params.id),
        inArray(trainingVideos.status, ['uploaded', 'failed']),
      ),
    );
  // Verificamos que el claim atómico tomó efecto. Si no, otro request ganó la
  // carrera y devolvemos 409.
  const claimed = (
    await db
      .select({ status: trainingVideos.status })
      .from(trainingVideos)
      .where(eq(trainingVideos.id, params.id))
      .limit(1)
  )[0];
  if (!claimed || claimed.status !== 'analyzing') {
    return NextResponse.json(
      { error: `No se pudo arrancar el training (status actual=${claimed?.status ?? 'desconocido'}). Otro request puede estar en curso.` },
      { status: 409 },
    );
  }

  const trainingId = row.id;
  const videoPath = row.videoPath;
  const workDir = trainingWorkDirFor(trainingId);

  // Background loop
  void (async () => {
    try {
      const result = await trainStyle({
        trainingId,
        videoPath,
        workDir,
        onAnalysisDone: async (analysis) => {
          // Si el JSON.stringify del análisis tira (referencias circulares?), no
          // queremos abortar el loop. Loggeamos y seguimos.
          try {
            await db
              .update(trainingVideos)
              .set({
                status: 'training',
                progress: 12,
                currentStep: 'extracting-keyframes',
                analysisJson: JSON.stringify(analysis),
              })
              .where(eq(trainingVideos.id, trainingId));
          } catch (persistErr) {
            // eslint-disable-next-line no-console
            console.warn(
              '[training] onAnalysisDone persist falló (continuando)',
              trainingId,
              (persistErr as Error).message,
            );
          }
        },
        onIteration: async (trajectory, progress) => {
          // Mismo principio: si la persistencia del progreso falla en una
          // iteración, no abortamos. La siguiente iteración intenta de nuevo.
          try {
            await persistTrajectory(
              trainingId,
              trajectory,
              progress,
              `keyframe ${trajectory.keyframes.length}/${trajectory.keyframes.length}`,
            );
          } catch (persistErr) {
            // eslint-disable-next-line no-console
            console.warn(
              '[training] onIteration persist falló (continuando)',
              trainingId,
              (persistErr as Error).message,
            );
          }
        },
      });

      // Marcamos completed
      await db
        .update(trainingVideos)
        .set({
          status: 'completed',
          progress: 100,
          currentStep: null,
          trajectoryJson: JSON.stringify(result.trajectory),
          resultPresetId: result.resultPresetId,
          generalIdeasJson: JSON.stringify(result.generalIdeas),
          trainedAt: new Date(),
        })
        .where(eq(trainingVideos.id, trainingId));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[training] loop falló', trainingId, err);
      try {
        await db
          .update(trainingVideos)
          .set({
            status: 'failed',
            errorMessage: err instanceof Error ? err.message : String(err),
          })
          .where(eq(trainingVideos.id, trainingId));
      } catch (dbErr) {
        // eslint-disable-next-line no-console
        console.error('[training] no se pudo persistir failed state', trainingId, dbErr);
      }
    }
  })();

  return NextResponse.json({ ok: true, status: 'analyzing' });
}
