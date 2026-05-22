'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';

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

      {/* Progress bar arriba */}
      {(data.status === 'analyzing' || data.status === 'training') && (
        <Card>
          <CardContent className="pt-5 space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">{data.currentStep ?? data.status}</span>
              <span className="text-xs text-muted-foreground">{data.progress}%</span>
            </div>
            <Progress value={data.progress} />
            <p className="text-[11px] text-muted-foreground">
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
            <p className="text-[11px] text-muted-foreground">
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
          <span className="text-[10px] text-muted-foreground p-1">sin imagen</span>
        )}
      </div>
      <div className="flex items-center justify-between mt-1 text-[10px]">
        <span className={isOriginal ? 'font-medium' : 'text-muted-foreground'}>{label}</span>
        {score !== undefined && (
          <span className={`rounded px-1 ${scoreColor}`}>{score.toFixed(0)}</span>
        )}
      </div>
    </div>
  );
}
