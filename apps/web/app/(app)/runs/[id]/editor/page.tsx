import { CompositionEditor } from './CompositionEditor';
import { PageHeader, PageHint } from '@/components/PageHint';

export const dynamic = 'force-dynamic';

export default function EditorPage({ params }: { params: { id: string } }) {
  return (
    <div className="space-y-4">
      <div>
        <PageHeader title="Editor de video" subtitle="Ajusta y vuelve a generar" />
        <p className="-mt-3 text-[11px] text-muted-foreground font-mono">{params.id}</p>
      </div>
      <PageHint emoji="✂️">
        <b className="text-foreground">Afina el resultado.</b> Cambia la duración de cada escena, activa o
        desactiva el <b className="text-foreground">movimiento Ken Burns</b> y vuelve a generar el video. El
        audio y los subtítulos se re-sincronizan solos.
      </PageHint>
      <CompositionEditor runId={params.id} />
    </div>
  );
}
