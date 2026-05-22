import { CompositionEditor } from './CompositionEditor';

export const dynamic = 'force-dynamic';

export default function EditorPage({ params }: { params: { id: string } }) {
  return (
    <div className="space-y-4">
      <h1 className="text-3xl font-bold tracking-tight">Editor de composición</h1>
      <p className="text-xs text-muted-foreground font-mono">{params.id}</p>
      <CompositionEditor runId={params.id} />
    </div>
  );
}
