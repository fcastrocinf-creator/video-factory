'use client';

// Live co-pilot view — owner ve a VALIDATOR CHAT IA trabajando en vivo y
// puede intervenir scene por scene.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

interface ValidatorHistoryEntry {
  runId: string;
  sceneIndex: number;
  timestampIso: string;
  attempt: number;
  durationMs: number;
  hadAnimatedClip: boolean;
  keyframesExtracted: number;
  verdict: {
    verdict: 'right' | 'wrong';
    confidence: number;
    staticImageOk: boolean;
    animationOk: boolean | null;
    nextAction: string;
    scoreComposition?: number | null;
    scoreLighting?: number | null;
    scorePaletteCompliance?: number | null;
    scoreFacialAccuracy?: number | null;
    scoreMotionQuality?: number | null;
    scoreNarrationAlignment?: number | null;
    scoreStyleAdherence?: number | null;
    issues: Array<{
      severity: 'minor' | 'major' | 'critical';
      category: string;
      description: string;
      evidenceFrameIndex: number | null;
      evidenceRegion: string | null;
      issueConfidence?: number;
    }>;
    correctedImagePrompt?: string;
    correctedMotionPrompt?: string;
    systemicAntiPattern?: string;
    rationale: string;
  } | null;
  apiError: { type: string; message: string } | null;
  thinkingContent?: string;
}

interface RunStatus {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'completed-with-warnings' | 'failed';
  currentStep: string | null;
  progress: number;
  outputPath: string | null;
  errorMessage: string | null;
  brandId: string;
  presetId: string;
}

interface Intervention {
  id: string;
  sceneIndex: number | null;
  type: string;
  category?: string | null;
  comment?: string | null;
  timestampIso: string;
  processed: boolean;
}

type ActionState = 'idle' | 'sending' | 'sent' | 'error';

const POLL_INTERVAL_MS = 5000;

export function LiveCoPilot({ runId }: { runId: string }) {
  const [runStatus, setRunStatus] = useState<RunStatus | null>(null);
  const [history, setHistory] = useState<ValidatorHistoryEntry[]>([]);
  const [interventions, setInterventions] = useState<Intervention[]>([]);
  const [expandedThinking, setExpandedThinking] = useState<Set<string>>(new Set());
  const [actionStates, setActionStates] = useState<Record<number, ActionState>>({});
  const [commentDrafts, setCommentDrafts] = useState<Record<number, string>>({});
  const [promptDrafts, setPromptDrafts] = useState<Record<number, string>>({});
  const [globalComment, setGlobalComment] = useState('');
  const [error, setError] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    try {
      const [runRes, valRes, intRes] = await Promise.all([
        fetch(`/api/runs/${runId}`),
        fetch(`/api/runs/${runId}/validator-history`),
        fetch(`/api/runs/${runId}/intervene`),
      ]);
      if (runRes.ok) {
        const r = (await runRes.json()) as RunStatus;
        setRunStatus(r);
      }
      if (valRes.ok) {
        const v = (await valRes.json()) as { history: ValidatorHistoryEntry[] };
        setHistory(v.history ?? []);
      }
      if (intRes.ok) {
        const i = (await intRes.json()) as { interventions: Intervention[] };
        setInterventions(i.interventions ?? []);
      }
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [runId]);

  // Polling
  useEffect(() => {
    void fetchAll();
    const iv = setInterval(fetchAll, POLL_INTERVAL_MS);
    return () => clearInterval(iv);
  }, [fetchAll]);

  const sendIntervention = useCallback(
    async (
      type: 'approve' | 'reject' | 'comment' | 'skip',
      sceneIndex: number | null,
      extras: { comment?: string; newImagePrompt?: string; category?: string } = {},
    ) => {
      const key = sceneIndex ?? -1;
      setActionStates((s) => ({ ...s, [key]: 'sending' }));
      try {
        const res = await fetch(`/api/runs/${runId}/intervene`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type,
            sceneIndex,
            ...extras,
          }),
        });
        if (!res.ok) {
          const errBody = await res.json();
          throw new Error(errBody.error || `HTTP ${res.status}`);
        }
        setActionStates((s) => ({ ...s, [key]: 'sent' }));
        if (sceneIndex !== null) {
          setCommentDrafts((d) => ({ ...d, [sceneIndex]: '' }));
          setPromptDrafts((d) => ({ ...d, [sceneIndex]: '' }));
        } else {
          setGlobalComment('');
        }
        await fetchAll();
      } catch (e) {
        setActionStates((s) => ({ ...s, [key]: 'error' }));
        setError((e as Error).message);
      }
    },
    [runId, fetchAll],
  );

  // Group by sceneIndex: keep latest per scene
  const sceneMap = new Map<number, ValidatorHistoryEntry>();
  for (const h of history) {
    const existing = sceneMap.get(h.sceneIndex);
    if (!existing || h.attempt > existing.attempt) sceneMap.set(h.sceneIndex, h);
  }
  const scenes = Array.from(sceneMap.entries()).sort((a, b) => a[0] - b[0]);

  const interventionBySceneIndex = new Map<number | null, Intervention[]>();
  for (const i of interventions) {
    if (!interventionBySceneIndex.has(i.sceneIndex))
      interventionBySceneIndex.set(i.sceneIndex, []);
    interventionBySceneIndex.get(i.sceneIndex)!.push(i);
  }

  return (
    <div className="container mx-auto max-w-6xl py-6 space-y-6">
      <div className="flex justify-between items-start gap-4">
        <div>
          <h1 className="text-2xl font-bold">
            🤖 VALIDATOR CHAT IA — Live Co-Pilot
          </h1>
          <p className="text-sm text-muted-foreground">
            Run: <code className="text-xs">{runId.slice(0, 8)}</code> ·{' '}
            {runStatus?.brandId} · {runStatus?.presetId}
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <Link
            href={`/runs/${runId}`}
            className="text-sm text-blue-600 hover:underline"
          >
            ← Volver al run viewer
          </Link>
          <div className="text-xs text-muted-foreground">
            Auto-refresh cada {POLL_INTERVAL_MS / 1000}s
          </div>
        </div>
      </div>

      {/* Status bar */}
      {runStatus && (
        <div className="rounded-lg border bg-card p-4 flex items-center gap-4">
          <StatusBadge status={runStatus.status} />
          <div className="flex-1">
            <div className="text-sm font-medium">
              {runStatus.currentStep ?? 'completado'} ·{' '}
              <span className="text-muted-foreground">{runStatus.progress}%</span>
            </div>
            <div className="w-full mt-2 bg-muted rounded-full h-2">
              <div
                className="h-2 bg-blue-500 rounded-full transition-all"
                style={{ width: `${runStatus.progress}%` }}
              />
            </div>
          </div>
          <div className="text-sm">
            {scenes.length} scene{scenes.length !== 1 ? 's' : ''} validated
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-lg bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800 p-3 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {/* Global comment area */}
      <div className="rounded-lg border bg-card p-4 space-y-3">
        <h2 className="text-sm font-semibold">💬 Comentario global del run</h2>
        <textarea
          value={globalComment}
          onChange={(e) => setGlobalComment(e.target.value)}
          placeholder='Ej: "el estilo está demasiado fotorealista para una marca como Vitaly, debería ser más acuarela cálida"'
          className="w-full min-h-[80px] rounded-md border bg-background px-3 py-2 text-sm"
        />
        <div className="flex justify-between items-center">
          <span className="text-xs text-muted-foreground">
            Este comentario alimenta VALIDATOR para escenas futuras + memoria cross-run.
          </span>
          <button
            onClick={() => sendIntervention('comment', null, { comment: globalComment })}
            disabled={!globalComment.trim() || actionStates[-1] === 'sending'}
            className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium disabled:opacity-50"
          >
            {actionStates[-1] === 'sending' ? 'Enviando...' : 'Enviar comentario global'}
          </button>
        </div>
      </div>

      {/* Scene cards */}
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Scenes evaluadas por VALIDATOR</h2>
        {scenes.length === 0 && (
          <div className="text-sm text-muted-foreground italic">
            Esperando primera evaluación de VALIDATOR...
          </div>
        )}
        {scenes.map(([sceneIdx, entry]) => {
          const v = entry.verdict;
          const thinkingKey = `${sceneIdx}_${entry.attempt}`;
          const isExpanded = expandedThinking.has(thinkingKey);
          const sceneInterventions = interventionBySceneIndex.get(sceneIdx) ?? [];
          const actionState = actionStates[sceneIdx] ?? 'idle';
          return (
            <div
              key={sceneIdx}
              className="rounded-lg border bg-card p-4 space-y-3"
            >
              <div className="flex justify-between items-start gap-3">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">Scene #{sceneIdx}</span>
                    <span className="text-xs text-muted-foreground">
                      attempt {entry.attempt}
                    </span>
                    {v && <VerdictBadge verdict={v.verdict} />}
                    {v && <ConfidencePill confidence={v.confidence} />}
                  </div>
                  {v && (
                    <div className="text-sm text-muted-foreground mt-1">
                      nextAction: <code className="text-xs">{v.nextAction}</code> ·{' '}
                      thinking: {(entry.thinkingContent?.length ?? 0).toLocaleString()}c ·{' '}
                      {(entry.durationMs / 1000).toFixed(1)}s
                    </div>
                  )}
                </div>
              </div>

              {/* Scores */}
              {v && (
                <ScoresGrid
                  composition={v.scoreComposition}
                  lighting={v.scoreLighting}
                  palette={v.scorePaletteCompliance}
                  facial={v.scoreFacialAccuracy}
                  motion={v.scoreMotionQuality}
                  narration={v.scoreNarrationAlignment}
                  style={v.scoreStyleAdherence}
                />
              )}

              {/* Issues */}
              {v && v.issues.length > 0 && (
                <div className="space-y-1">
                  <div className="text-xs font-semibold text-muted-foreground">
                    Issues detectados:
                  </div>
                  {v.issues.map((iss, i) => (
                    <div
                      key={i}
                      className={`text-xs p-2 rounded ${
                        iss.severity === 'critical'
                          ? 'bg-red-50 dark:bg-red-950/20 text-red-700 dark:text-red-300'
                          : iss.severity === 'major'
                            ? 'bg-orange-50 dark:bg-orange-950/20 text-orange-700 dark:text-orange-300'
                            : 'bg-yellow-50 dark:bg-yellow-950/20 text-yellow-700 dark:text-yellow-300'
                      }`}
                    >
                      <span className="font-mono font-semibold">
                        [{iss.severity}/{iss.category}]
                      </span>{' '}
                      frame {iss.evidenceFrameIndex ?? '?'} ({iss.evidenceRegion ?? '?'}):{' '}
                      {iss.description}
                      {iss.issueConfidence !== undefined && (
                        <span className="ml-2 opacity-70">conf: {iss.issueConfidence}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Rationale */}
              {v?.rationale && (
                <div className="text-xs italic text-muted-foreground border-l-2 border-muted pl-3">
                  "{v.rationale}"
                </div>
              )}

              {/* Thinking expandable */}
              {entry.thinkingContent && (
                <details
                  open={isExpanded}
                  onToggle={(e) => {
                    const next = new Set(expandedThinking);
                    if ((e.target as HTMLDetailsElement).open) next.add(thinkingKey);
                    else next.delete(thinkingKey);
                    setExpandedThinking(next);
                  }}
                  className="text-xs"
                >
                  <summary className="cursor-pointer text-blue-600 hover:underline">
                    🧠 Ver razonamiento interno ({entry.thinkingContent.length.toLocaleString()}c)
                  </summary>
                  <pre className="mt-2 p-3 bg-muted/50 rounded text-xs whitespace-pre-wrap font-mono">
                    {entry.thinkingContent}
                  </pre>
                </details>
              )}

              {/* Prior interventions for this scene */}
              {sceneInterventions.length > 0 && (
                <div className="space-y-1">
                  <div className="text-xs font-semibold text-muted-foreground">
                    Tus intervenciones previas:
                  </div>
                  {sceneInterventions.map((it) => (
                    <div
                      key={it.id}
                      className="text-xs p-2 rounded bg-blue-50 dark:bg-blue-950/20 text-blue-700 dark:text-blue-300"
                    >
                      <code className="font-mono">{it.type}</code>{' '}
                      {it.comment && <span>: "{it.comment}"</span>}
                      <span className="ml-2 opacity-70">
                        {new Date(it.timestampIso).toLocaleTimeString()}
                      </span>
                      {it.processed && (
                        <span className="ml-2 text-green-600">✓ procesada</span>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Action area */}
              <div className="border-t pt-3 space-y-2">
                <textarea
                  value={commentDrafts[sceneIdx] ?? ''}
                  onChange={(e) =>
                    setCommentDrafts((d) => ({ ...d, [sceneIdx]: e.target.value }))
                  }
                  placeholder='Ej: "la luz se ve muy fría, debería ser más cálida sepia"'
                  className="w-full min-h-[60px] rounded-md border bg-background px-3 py-2 text-xs"
                />
                <textarea
                  value={promptDrafts[sceneIdx] ?? ''}
                  onChange={(e) =>
                    setPromptDrafts((d) => ({ ...d, [sceneIdx]: e.target.value }))
                  }
                  placeholder="(opcional) Prompt completo corregido para regenerar"
                  className="w-full min-h-[60px] rounded-md border bg-background px-3 py-2 text-xs font-mono"
                />
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => sendIntervention('approve', sceneIdx)}
                    disabled={actionState === 'sending'}
                    className="px-3 py-1.5 bg-green-600 text-white rounded-md text-xs font-medium disabled:opacity-50"
                  >
                    ✅ Aprobar
                  </button>
                  <button
                    onClick={() =>
                      sendIntervention('reject', sceneIdx, {
                        comment: commentDrafts[sceneIdx] || undefined,
                        newImagePrompt: promptDrafts[sceneIdx] || undefined,
                      })
                    }
                    disabled={
                      actionState === 'sending' ||
                      (!commentDrafts[sceneIdx] && !promptDrafts[sceneIdx])
                    }
                    className="px-3 py-1.5 bg-red-600 text-white rounded-md text-xs font-medium disabled:opacity-50"
                  >
                    ❌ Rechazar y regenerar
                  </button>
                  <button
                    onClick={() =>
                      sendIntervention('comment', sceneIdx, {
                        comment: commentDrafts[sceneIdx],
                      })
                    }
                    disabled={
                      actionState === 'sending' || !commentDrafts[sceneIdx]
                    }
                    className="px-3 py-1.5 bg-blue-600 text-white rounded-md text-xs font-medium disabled:opacity-50"
                  >
                    💬 Comentar (alimenta VALIDATOR)
                  </button>
                  <button
                    onClick={() => sendIntervention('skip', sceneIdx)}
                    disabled={actionState === 'sending'}
                    className="px-3 py-1.5 bg-gray-500 text-white rounded-md text-xs font-medium disabled:opacity-50"
                  >
                    ⏭ Skip (aceptar tal cual)
                  </button>
                  {actionState === 'sent' && (
                    <span className="text-xs text-green-600 self-center">
                      ✓ enviado
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StatusBadge({
  status,
}: {
  status: RunStatus['status'];
}) {
  const colors = {
    pending: 'bg-gray-200 text-gray-700',
    running: 'bg-blue-100 text-blue-700 animate-pulse',
    completed: 'bg-green-100 text-green-700',
    'completed-with-warnings': 'bg-yellow-100 text-yellow-700',
    failed: 'bg-red-100 text-red-700',
  } as const;
  return (
    <span
      className={`px-3 py-1 rounded-full text-xs font-semibold ${colors[status]}`}
    >
      {status}
    </span>
  );
}

function VerdictBadge({ verdict }: { verdict: 'right' | 'wrong' }) {
  return (
    <span
      className={`px-2 py-0.5 rounded text-xs font-semibold ${
        verdict === 'right'
          ? 'bg-green-100 text-green-700'
          : 'bg-red-100 text-red-700'
      }`}
    >
      {verdict.toUpperCase()}
    </span>
  );
}

function ConfidencePill({ confidence }: { confidence: number }) {
  const color =
    confidence >= 80
      ? 'bg-green-100 text-green-700'
      : confidence >= 65
        ? 'bg-yellow-100 text-yellow-700'
        : 'bg-red-100 text-red-700';
  return (
    <span className={`px-2 py-0.5 rounded text-xs ${color}`}>
      conf {confidence}/100
    </span>
  );
}

function ScoresGrid(props: {
  composition: number | null | undefined;
  lighting: number | null | undefined;
  palette: number | null | undefined;
  facial: number | null | undefined;
  motion: number | null | undefined;
  narration: number | null | undefined;
  style: number | null | undefined;
}) {
  const entries: Array<[string, number | null | undefined]> = [
    ['Composition', props.composition],
    ['Lighting', props.lighting],
    ['Palette', props.palette],
    ['Facial', props.facial],
    ['Motion', props.motion],
    ['Narration', props.narration],
    ['Style', props.style],
  ];
  return (
    <div className="grid grid-cols-2 md:grid-cols-7 gap-2">
      {entries.map(([label, score]) => (
        <div key={label} className="text-center">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {label}
          </div>
          <div
            className={`text-lg font-bold ${
              score === null || score === undefined
                ? 'text-muted-foreground'
                : score >= 80
                  ? 'text-green-600'
                  : score >= 60
                    ? 'text-yellow-600'
                    : 'text-red-600'
            }`}
          >
            {score === null || score === undefined ? '—' : score}
          </div>
        </div>
      ))}
    </div>
  );
}
