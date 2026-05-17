import { RunViewer } from './RunViewer';

export const dynamic = 'force-dynamic';

export default function RunPage({ params }: { params: { id: string } }) {
  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold tracking-tight">Render</h1>
      <p className="text-xs text-muted-foreground font-mono">{params.id}</p>
      <RunViewer runId={params.id} />
    </div>
  );
}
