import { desc } from 'drizzle-orm';
import { db, trainingVideos } from '@/lib/db';
import { TrainingRepository } from './TrainingRepository';
import { TrainingUploader } from './TrainingUploader';

export const dynamic = 'force-dynamic';

export default async function AprendizajePage() {
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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Aprendizaje</h1>
        <p className="text-sm text-muted-foreground max-w-3xl">
          Sube videos que quieres que la IA replique al 99% de fidelidad visual.
          Cada video queda en este repositorio. Cuando haces clic en{' '}
          <strong>&quot;Aprender formato&quot;</strong>, el sistema extrae keyframes
          del original, genera variaciones con el provider chain, las compara con
          Gemini Vision e itera hasta lograr similitud alta. El estilo destilado
          aparece en <a href="/admin" className="underline">/admin</a> para aprobar
          y después está disponible en <a href="/create" className="underline">/create</a>.
        </p>
      </div>

      <TrainingUploader />

      <TrainingRepository
        initialItems={rows.map((r) => ({
          id: r.id,
          videoFileName: r.videoFileName,
          videoBytes: r.videoBytes,
          status: r.status,
          progress: r.progress,
          currentStep: r.currentStep,
          resultPresetId: r.resultPresetId,
          errorMessage: r.errorMessage,
          createdAt: (r.createdAt instanceof Date
            ? r.createdAt
            : new Date((r.createdAt as unknown as number) * 1000)
          ).toISOString(),
          trainedAt:
            r.trainedAt instanceof Date
              ? r.trainedAt.toISOString()
              : r.trainedAt
                ? new Date((r.trainedAt as unknown as number) * 1000).toISOString()
                : null,
        }))}
      />
    </div>
  );
}
