// ValidationLog — M3
//
// Muestra los reportes de validación de la IA (M5 post-render judge + M6 loop
// iterativo del editor) que el pipeline persistió en el workDir. Sirve para
// que el operador entienda QUÉ vio Claude y por qué tomó las decisiones que
// tomó — sin abrir el filesystem.
//
// Solo se renderiza si hay artefactos. Si el run no llegó a M5 (falló antes)
// o no usó M6, el componente devuelve null y no agrega ruido a la UI.

'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';

interface PostRenderIssue {
  severity: 'critical' | 'warning' | 'info';
  category: string;
  sceneIndex?: number;
  description: string;
  suggestion?: string;
}

interface PostRenderReport {
  pass: boolean;
  totalScenes: number;
  scenesWithVideo: number;
  scenesWithStaticImageOnly: number;
  scenesMissingVisual: number;
  audioDurationSec: number;
  scenePlanDurationSec: number;
  durationMismatchSec: number;
  visualSampleAvgScore: number;
  visualSampleFailures: number;
  issues: PostRenderIssue[];
  rationale: string;
}

interface ValidationsResponse {
  postRender: PostRenderReport | null;
  editorConversationMarkdown: string | null;
}

interface ValidationLogProps {
  runId: string;
}

function SeverityChip({ severity }: { severity: PostRenderIssue['severity'] }) {
  const styles: Record<PostRenderIssue['severity'], string> = {
    critical: 'bg-red-500/20 text-red-700 dark:text-red-300 border-red-500/40',
    warning: 'bg-yellow-500/20 text-yellow-700 dark:text-yellow-300 border-yellow-500/40',
    info: 'bg-blue-500/20 text-blue-700 dark:text-blue-300 border-blue-500/40',
  };
  return (
    <span
      className={`inline-block rounded border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${styles[severity]}`}
    >
      {severity}
    </span>
  );
}

export function ValidationLog({ runId }: ValidationLogProps) {
  const [data, setData] = useState<ValidationsResponse | null>(null);
  const [error, setError] = useState('');
  const [postRenderOpen, setPostRenderOpen] = useState(true);
  const [editorOpen, setEditorOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/runs/${runId}/validations`, { cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
        return r.json() as Promise<ValidationsResponse>;
      })
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Error de red');
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  // Silencioso si aún cargando o no hay artefactos — no metemos ruido visual.
  if (error) {
    return (
      <p className="text-xs text-muted-foreground">
        No se pudieron cargar las validaciones IA: {error}
      </p>
    );
  }
  if (!data) return null;
  if (!data.postRender && !data.editorConversationMarkdown) return null;

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <div>
          <h3 className="text-sm font-semibold">🧠 Validación IA del run</h3>
          <p className="text-xs text-muted-foreground">
            Lo que Claude vio y decidió durante el pipeline.
          </p>
        </div>

        {data.postRender && (
          <div className="rounded border border-border bg-muted/30">
            <button
              type="button"
              onClick={() => setPostRenderOpen((v) => !v)}
              className="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-medium hover:bg-muted/50"
            >
              <span className="flex items-center gap-2">
                <span className={data.postRender.pass ? 'text-green-600' : 'text-red-600'}>
                  {data.postRender.pass ? '✓' : '✗'}
                </span>
                <span>
                  Post-render judge (M5) ·{' '}
                  {data.postRender.scenesWithVideo}/{data.postRender.totalScenes} animadas ·
                  visual {data.postRender.visualSampleAvgScore}/100 ·{' '}
                  {data.postRender.issues.length}{' '}
                  {data.postRender.issues.length === 1 ? 'issue' : 'issues'}
                </span>
              </span>
              <span className="text-muted-foreground">{postRenderOpen ? '▾' : '▸'}</span>
            </button>
            {postRenderOpen && (
              <div className="space-y-3 px-3 pb-3 text-xs">
                <p className="italic text-muted-foreground">
                  {data.postRender.rationale}
                </p>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                  <div>
                    Audio: {data.postRender.audioDurationSec.toFixed(2)}s · Plan:{' '}
                    {data.postRender.scenePlanDurationSec.toFixed(2)}s · Mismatch:{' '}
                    <span
                      className={
                        Math.abs(data.postRender.durationMismatchSec) > 3
                          ? 'text-red-600'
                          : 'text-foreground'
                      }
                    >
                      {data.postRender.durationMismatchSec.toFixed(2)}s
                    </span>
                  </div>
                  <div>
                    Estáticas: {data.postRender.scenesWithStaticImageOnly} · Faltantes:{' '}
                    {data.postRender.scenesMissingVisual}
                  </div>
                </div>
                {data.postRender.issues.length > 0 && (
                  <div className="space-y-2">
                    {data.postRender.issues.map((iss, i) => (
                      <div
                        key={i}
                        className="rounded border border-border/50 bg-background p-2"
                      >
                        <div className="mb-1 flex items-center gap-2">
                          <SeverityChip severity={iss.severity} />
                          <span className="text-[11px] font-medium">
                            {iss.category}
                            {typeof iss.sceneIndex === 'number'
                              ? ` · scene ${iss.sceneIndex}`
                              : ''}
                          </span>
                        </div>
                        <p className="text-[11px]">{iss.description}</p>
                        {iss.suggestion && (
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            💡 {iss.suggestion}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {data.editorConversationMarkdown && (
          <div className="rounded border border-border bg-muted/30">
            <button
              type="button"
              onClick={() => setEditorOpen((v) => !v)}
              className="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-medium hover:bg-muted/50"
            >
              <span>📝 Editor IA — loop iterativo (M6)</span>
              <span className="text-muted-foreground">{editorOpen ? '▾' : '▸'}</span>
            </button>
            {editorOpen && (
              <pre className="overflow-x-auto whitespace-pre-wrap px-3 pb-3 text-[11px] leading-relaxed text-foreground/90">
                {data.editorConversationMarkdown}
              </pre>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
