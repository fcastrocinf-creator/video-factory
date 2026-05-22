import Link from 'next/link';
import { TrainingDetailView } from './TrainingDetailView';

export const dynamic = 'force-dynamic';

export default function TrainingDetailPage({ params }: { params: { id: string } }) {
  return (
    <div className="space-y-4">
      <Link href="/aprendizaje" className="text-xs text-muted-foreground hover:text-foreground">
        ← Repositorio
      </Link>
      <TrainingDetailView trainingId={params.id} />
    </div>
  );
}
