import { RunViewer } from './RunViewer';
import { PageHeader, PageHint } from '@/components/PageHint';

export const dynamic = 'force-dynamic';

export default function RunPage({ params }: { params: { id: string } }) {
  return (
    <div className="space-y-6">
      <div>
        <PageHeader title="Tu video" subtitle="Míralo, descárgalo o ábrelo en el editor" />
        <p className="-mt-3 text-xs text-muted-foreground font-mono">{params.id}</p>
      </div>
      <PageHint emoji="🎬">
        Acá ves el resultado final y el detalle de cada paso (escenas, voz, subtítulos). ¿Necesitas ajustar
        cortes, micro-escenas o activar Ken Burns? Entra al <b className="text-foreground">editor</b> desde
        el botón de esta página.
      </PageHint>
      <RunViewer runId={params.id} />
    </div>
  );
}
