import { desc } from 'drizzle-orm';
import { db, trainingVideos } from '@/lib/db';
import { TrainingRepository } from './TrainingRepository';
import { TrainingUploader } from './TrainingUploader';
import { PageHeader, PageHint } from '@/components/PageHint';

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
      <PageHeader title="Aprendizaje" subtitle="Enseña a la IA a replicar un estilo de video" />
      <PageHint emoji="🎓">
        <b className="text-foreground">Enséñale un estilo nuevo.</b> Sube un video que quieras que la IA
        aprenda a replicar. El sistema saca los fotogramas clave, prueba variaciones y compara hasta lograr
        un estilo fiel. Al terminar lo apruebas en <a href="/admin" className="underline">Admin</a> y queda
        disponible al <a href="/create" className="underline">crear videos</a>.
      </PageHint>

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
