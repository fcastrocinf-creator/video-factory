'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { ClaudeChatPanel } from '@/components/ClaudeChatPanel';

interface TrainingIteration {
  iter: number;
  promptUsed: string;
  imagePath: string;
  imageRelPath: string;
  score: number;
  hint: string;
  provider: string;
  generatedAt: string;
}
interface TrainingKeyframe {
  index: number;
  sourceTimeSec: number;
  originalFramePath: string;
  originalFrameRelPath: string;
  iterations: TrainingIteration[];
  bestIter: number;
  finalScore: number;
  converged: boolean;
}
interface TrainingTrajectory {
  keyframes: TrainingKeyframe[];
  overallScore: number;
  converged: boolean;
  startedAt: string;
  completedAt?: string;
}

interface TrainingStatus {
  id: string;
  videoFileName: string;
  videoBytes: number;
  status: 'uploaded' | 'analyzing' | 'training' | 'completed' | 'failed';
  progress: number;
  currentStep: string | null;
  errorMessage: string | null;
  resultPresetId: string | null;
  analysis: { editorialLine?: string; hookType?: string; summary?: string } | null;
  trajectory: TrainingTrajectory | null;
  generalIdeas: string[] | null;
}

export function TrainingDetailView({ trainingId }: { trainingId: string }) {
  const [data, setData] = useState<TrainingStatus | null>(null);
  const [pollError, setPollError] = useState('');
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState('');
  // Cuando hacemos retry, incrementamos este epoch para forzar al useEffect a
  // re-ejecutar y arrancar un loop de polling nuevo (porque el viejo terminó
  // al ver status='failed').
  const [pollEpoch, setPollEpoch] = useState(0);

  useEffect(() => {
    let stopped = false;
    async function loop() {
      while (!stopped) {
        try {
          const r = await fetch(`/api/training/${trainingId}`, { cache: 'no-store' });
          if (r.ok) {
            const d = (await r.json()) as TrainingStatus;
            if (!stopped) {
              setData(d);
              setPollError('');
              if (d.status === 'completed' || d.status === 'failed') return;
            }
          } else if (r.status === 404) {
            setPollError('Training no encontrado');
            return;
          }
        } catch (e) {
          setPollError((e as Error).message);
        }
        await new Promise((res) => setTimeout(res, 2000));
      }
    }
    void loop();
    return () => {
      stopped = true;
    };
  }, [trainingId, pollEpoch]);

  if (!data) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">Cargando…</p>
        {pollError && <p className="text-sm text-destructive">{pollError}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight truncate">{data.videoFileName}</h1>
          <p className="text-xs text-muted-foreground">
            {(data.videoBytes / 1024 / 1024).toFixed(1)} MB · status:{' '}
            <strong className="text-foreground">{data.status}</strong>
          </p>
        </div>
        {data.status === 'completed' && data.resultPresetId && (
          <Link
            href="/admin"
            className="inline-flex items-center rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          >
            Revisar en /admin →
          </Link>
        )}
      </div>

      {/* M7-B v1 — botón Auto-Learn con Claude (cuando el video está subido) */}
      <AutoLearnSection trainingId={trainingId} />
      <AutoLearnIterativeSection trainingId={trainingId} />

      {/* M8: chat IA para discutir el aprendizaje */}
      {(data.status === 'completed' || data.status === 'failed') && (
        <ClaudeChatPanel
          contextType="preset-tuning"
          contextData={{
            trainingId,
            videoFileName: data.videoFileName,
            status: data.status,
            hasResultPreset: !!data.resultPresetId,
            resultPresetId: data.resultPresetId,
            analysis: data.analysis,
            overallScore: data.trajectory?.overallScore,
            generalIdeas: data.generalIdeas,
          }}
          title="Discutí el aprendizaje con Claude"
          placeholder="Ej: '¿El preset captura bien el estilo?' o 'Cómo lo mejoro para que se vea más cinematográfico?'"
        />
      )}

      {/* Progress bar arriba */}
      {(data.status === 'analyzing' || data.status === 'training') && (
        <Card>
          <CardContent className="pt-5 space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">{data.currentStep ?? data.status}</span>
              <span className="text-xs text-muted-foreground">{data.progress}%</span>
            </div>
            <Progress value={data.progress} />
            <p className="text-xs text-muted-foreground">
              El loop genera variaciones, las compara con Gemini Vision y refina
              hasta lograr alta similitud por frame. Tarda 1-5 min según largo del video y nro de iteraciones necesarias.
            </p>
          </CardContent>
        </Card>
      )}

      {data.status === 'failed' && (
        <Card className="border-destructive/30 bg-destructive/5">
          <CardContent className="pt-5 space-y-3">
            <p className="text-sm font-medium text-destructive">Aprendizaje falló</p>
            {data.errorMessage && (
              <pre className="text-xs text-destructive/80 whitespace-pre-wrap">
                {data.errorMessage}
              </pre>
            )}
            <p className="text-xs text-muted-foreground">
              Los errores 5xx de Google API suelen ser transitorios (server overload).
              Reintentar suele funcionar.
            </p>
            {retryError && (
              <p className="text-xs text-destructive">{retryError}</p>
            )}
            <Button
              size="sm"
              disabled={retrying}
              onClick={async () => {
                setRetrying(true);
                setRetryError('');
                try {
                  const r = await fetch(`/api/training/${trainingId}/learn`, {
                    method: 'POST',
                  });
                  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
                  // El polling automático recoge el nuevo status; bumpeamos epoch
                  // para forzar al useEffect a re-arrancar el loop que terminó
                  // al ver 'failed' anteriormente.
                  setData((prev) =>
                    prev ? { ...prev, status: 'analyzing', progress: 5, errorMessage: null } : prev,
                  );
                  setPollEpoch((n) => n + 1);
                } catch (e) {
                  setRetryError((e as Error).message);
                } finally {
                  setRetrying(false);
                }
              }}
            >
              {retrying ? 'Reintentando…' : '🔄 Reintentar aprendizaje'}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* "Ideas generales" cuando hay */}
      {data.generalIdeas && data.generalIdeas.length > 0 && (
        <Card>
          <CardContent className="pt-5 space-y-2">
            <p className="text-sm font-semibold">💡 Ideas generales aprendidas</p>
            <ul className="space-y-1.5 text-xs">
              {data.generalIdeas.map((idea, i) => (
                <li key={i} className="flex gap-2">
                  <span className="text-muted-foreground">{i + 1}.</span>
                  <span>{idea}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Análisis brief (siempre que esté disponible) */}
      {data.analysis && (
        <Card>
          <CardContent className="pt-5 space-y-1.5 text-xs">
            <p>
              <span className="font-medium">Hook:</span> {data.analysis.hookType ?? '?'}
            </p>
            {data.analysis.editorialLine && (
              <p>
                <span className="font-medium">Línea editorial:</span>{' '}
                <span className="text-muted-foreground">
                  {data.analysis.editorialLine.slice(0, 220)}
                  {data.analysis.editorialLine.length > 220 && '…'}
                </span>
              </p>
            )}
            {data.analysis.summary && (
              <p>
                <span className="font-medium">Resumen:</span>{' '}
                <span className="text-muted-foreground">{data.analysis.summary}</span>
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Trayectoria: mosaico de frames */}
      {data.trajectory && data.trajectory.keyframes.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold">Trayectoria del aprendizaje</h2>
            {data.trajectory.completedAt && (
              <p className="text-xs text-muted-foreground">
                Score promedio: <strong className="text-foreground">{data.trajectory.overallScore.toFixed(1)}</strong>
                {' · '}
                {data.trajectory.converged ? '✓ Convergió' : '⚠ Best-effort'}
              </p>
            )}
          </div>
          <div className="space-y-3">
            {data.trajectory.keyframes.map((kf) => (
              <KeyframeRow key={kf.index} kf={kf} trainingId={trainingId} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function KeyframeRow({
  kf,
  trainingId,
}: {
  kf: TrainingKeyframe;
  trainingId: string;
}) {
  const bestColor =
    kf.finalScore >= 90
      ? 'text-green-600 dark:text-green-400'
      : kf.finalScore >= 75
        ? 'text-amber-600 dark:text-amber-400'
        : 'text-destructive';

  return (
    <Card>
      <CardContent className="pt-4 space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span className="font-medium">
            Frame {kf.index + 1} · t = {kf.sourceTimeSec.toFixed(1)}s
          </span>
          <span className={`font-medium ${bestColor}`}>
            {kf.converged ? '✓' : ''} Score: {kf.finalScore.toFixed(1)} · iter mejor: {kf.bestIter + 1}/{kf.iterations.length}
          </span>
        </div>
        <div className="flex gap-2 overflow-x-auto pb-1">
          {/* Original */}
          <FrameCell
            label="Original"
            isOriginal
            src={`/api/training/${trainingId}/frame?path=${encodeURIComponent(kf.originalFrameRelPath)}`}
          />
          {/* Iteraciones */}
          {kf.iterations.map((it) => (
            <FrameCell
              key={it.iter}
              label={`Iter ${it.iter + 1}`}
              score={it.score}
              hint={it.hint}
              provider={it.provider}
              highlighted={it.iter === kf.bestIter}
              src={
                it.imageRelPath
                  ? `/api/training/${trainingId}/frame?path=${encodeURIComponent(it.imageRelPath)}`
                  : null
              }
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function FrameCell({
  label,
  src,
  score,
  hint,
  provider,
  isOriginal,
  highlighted,
}: {
  label: string;
  src: string | null;
  score?: number;
  hint?: string;
  provider?: string;
  isOriginal?: boolean;
  highlighted?: boolean;
}) {
  const scoreColor =
    score !== undefined
      ? score >= 90
        ? 'bg-green-600 text-white'
        : score >= 75
          ? 'bg-amber-500 text-white'
          : 'bg-destructive text-destructive-foreground'
      : '';

  return (
    <div
      className={`relative shrink-0 ${highlighted ? 'ring-2 ring-primary rounded-md' : ''}`}
      title={hint ? `${label}\nProvider: ${provider}\nHint: ${hint}` : label}
    >
      <div className="w-[110px] aspect-[9/16] rounded-md border bg-muted overflow-hidden flex items-center justify-center">
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt={label} className="h-full w-full object-cover" />
        ) : (
          <span className="text-xs text-muted-foreground p-1">sin imagen</span>
        )}
      </div>
      <div className="flex items-center justify-between mt-1 text-xs">
        <span className={isOriginal ? 'font-medium' : 'text-muted-foreground'}>{label}</span>
        {score !== undefined && (
          <span className={`rounded px-1 ${scoreColor}`}>{score.toFixed(0)}</span>
        )}
      </div>
    </div>
  );
}

// ============================================================
// M7-B v1 — AutoLearn section
// ============================================================
// Botón que invoca POST /api/training/[id]/auto-learn. Genera un preset
// completo desde el video con Claude multimodal en una sola pasada.
// Independiente del flow legacy de iteraciones — más rápido y útil para
// owner cuando solo quiere entender el video y obtener un preset base.

interface AutoLearnResult {
  ok: boolean;
  presetId: string;
  displayName: string;
  presetFilePath: string;
  understandingFilePath?: string;
  executiveSummary: string;
  styleId: string;
  hookType: string;
  palette: string[];
  sceneCount: number;
  modelUsed: string;
  elapsedSec: number;
}

function AutoLearnSection({ trainingId }: { trainingId: string }) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AutoLearnResult | null>(null);
  const [error, setError] = useState('');

  async function handleAutoLearn() {
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const resp = await fetch(`/api/training/${trainingId}/auto-learn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = (await resp.json()) as AutoLearnResult & { error?: string };
      if (!resp.ok) {
        setError(data.error ?? `HTTP ${resp.status}`);
        return;
      }
      setResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card className="border-purple-500/30 bg-purple-500/5">
      <CardContent className="pt-5 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">🧠 Auto-Learn con Claude</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Genera un preset completo en UNA pasada — Claude multimodal mira keyframes del
              video y devuelve estilo + hook + paleta + personaje + scenes + preset listo.
              ~$0.05, ~15-25s. Independiente del loop iterativo legacy.
            </p>
          </div>
          <Button
            onClick={handleAutoLearn}
            disabled={loading}
            size="sm"
            className="shrink-0 bg-purple-600 hover:bg-purple-700"
          >
            {loading ? 'Analizando…' : '🚀 Auto-Learn'}
          </Button>
        </div>

        {error && (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        )}

        {result && (
          <div className="space-y-2 rounded-md bg-background/60 p-3 text-xs">
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <span>
                <strong>Preset:</strong> <code>{result.presetId}</code>
              </span>
              <span>
                <strong>Style:</strong> {result.styleId}
              </span>
              <span>
                <strong>Hook:</strong> {result.hookType}
              </span>
              <span>
                <strong>Scenes:</strong> {result.sceneCount}
              </span>
              <span>
                <strong>{result.elapsedSec.toFixed(1)}s</strong>
              </span>
            </div>
            <div className="flex gap-1">
              {result.palette.map((c) => (
                <span
                  key={c}
                  className="h-4 w-4 rounded border"
                  style={{ backgroundColor: c }}
                  title={c}
                />
              ))}
            </div>
            <p className="text-muted-foreground italic">{result.executiveSummary}</p>
            <p className="text-xs text-muted-foreground">
              Persistido en <code>{result.presetFilePath}</code>. Aprobá en /admin para usar.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================
// M7-B v2 — AutoLearn ITERATIVO (loop con validador de similitud)
// ============================================================
// Sección con loop iterativo verdadero: genera preset → renderiza test →
// compara vs keyframe original → refina prompt con Claude → repite hasta
// 80%+ similitud o 3 iteraciones. Cierra el círculo "aprende los prompts
// hasta lograr coincidencia muy similar y se reutiliza para nuevos videos".

interface IterativeIterationResult {
  iteration: number;
  score: number;
  details: { palette: number; composition: number; character: number; mood: number };
  hint: string;
}

interface IterativeResult {
  ok: boolean;
  presetId: string;
  displayName: string;
  presetFilePath: string;
  approved: boolean;
  exhausted: boolean;
  finalScore: number;
  iterationsRun: number;
  iterations: IterativeIterationResult[];
  elapsedSec: number;
}

function AutoLearnIterativeSection({ trainingId }: { trainingId: string }) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<IterativeResult | null>(null);
  const [error, setError] = useState('');
  const [targetScore, setTargetScore] = useState(95);
  const [maxIterations, setMaxIterations] = useState(4);

  async function handleIterativeLearn() {
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const resp = await fetch(`/api/training/${trainingId}/auto-learn-iterative`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targetScore, maxIterations }),
      });
      const data = (await resp.json()) as IterativeResult & { error?: string };
      if (!resp.ok) {
        setError(data.error ?? `HTTP ${resp.status}`);
        return;
      }
      setResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card className="border-emerald-500/30 bg-emerald-500/5">
      <CardContent className="pt-5 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">🔁 Auto-Learn ITERATIVO (con validador IA)</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Loop completo: Claude entiende el video → genera imagen de prueba → compara con
              keyframe del original con Gemini Vision → refina el prompt hasta lograr similitud ≥{' '}
              {targetScore}% (o agotar {maxIterations} iteraciones). El preset resultante queda
              listo para reutilizar en /create con confianza visual.
              <strong className="block mt-1 text-emerald-600 dark:text-emerald-400">
                ⚡ Al subir un video, este loop YA se dispara automáticamente al 95%. Este botón
                sirve para re-ejecutar manualmente con otro target/iters.
              </strong>
              ~$0.40-1.20, ~90-240s.
            </p>
          </div>
          <Button
            onClick={handleIterativeLearn}
            disabled={loading}
            size="sm"
            className="shrink-0 bg-emerald-600 hover:bg-emerald-700"
          >
            {loading ? 'Loop corriendo…' : '🔁 Auto-Learn iterativo'}
          </Button>
        </div>

        <div className="flex gap-3 text-xs text-muted-foreground">
          <label className="flex items-center gap-1">
            Target score:
            <input
              type="number"
              min={50}
              max={95}
              value={targetScore}
              onChange={(e) => setTargetScore(parseInt(e.target.value) || 80)}
              className="w-14 rounded border bg-background px-1 py-0.5"
              disabled={loading}
            />
          </label>
          <label className="flex items-center gap-1">
            Max iter:
            <input
              type="number"
              min={1}
              max={5}
              value={maxIterations}
              onChange={(e) => setMaxIterations(parseInt(e.target.value) || 3)}
              className="w-12 rounded border bg-background px-1 py-0.5"
              disabled={loading}
            />
          </label>
        </div>

        {error && (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>
        )}

        {result && (
          <div className="space-y-2 rounded-md bg-background/60 p-3 text-xs">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span
                className={`rounded px-2 py-0.5 font-semibold uppercase tracking-wide ${result.approved ? 'bg-green-500/20 text-green-700 dark:text-green-300' : 'bg-yellow-500/20 text-yellow-700 dark:text-yellow-300'}`}
              >
                {result.approved ? 'APROBADO' : 'EXHAUSTED'}
              </span>
              <span>
                <strong>Score final:</strong> {result.finalScore}/100
              </span>
              <span>
                <strong>Iters:</strong> {result.iterationsRun}/{maxIterations}
              </span>
              <span>
                <strong>{result.elapsedSec.toFixed(1)}s</strong>
              </span>
              <span>
                <code>{result.presetId}</code>
              </span>
            </div>
            <div className="space-y-1">
              {result.iterations.map((it) => (
                <div
                  key={it.iteration}
                  className="rounded border border-border/50 bg-muted/30 px-2 py-1.5 text-xs"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-mono">iter {it.iteration}</span>
                    <span className="font-semibold">{it.score}/100</span>
                    <span className="text-muted-foreground">
                      palette {it.details.palette} · compos {it.details.composition} · char{' '}
                      {it.details.character} · mood {it.details.mood}
                    </span>
                  </div>
                  <p className="mt-0.5 text-muted-foreground italic">{it.hint}</p>
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Persistido en <code>{result.presetFilePath}</code>. Reporte de iteraciones al lado en{' '}
              <code>*.iterations.json</code>.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
