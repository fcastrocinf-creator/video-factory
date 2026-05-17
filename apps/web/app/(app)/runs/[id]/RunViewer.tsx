'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Button, buttonVariants } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';

interface RunStatus {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  currentStep: string | null;
  progress: number;
  outputPath: string | null;
  errorMessage: string | null;
  durationSeconds: number | null;
}

const STEP_LABELS: Record<string, string> = {
  'script-processor': '1/5 Procesando guión',
  'tts-elevenlabs': '2/5 Generando voz (ElevenLabs)',
  'subtitles-whisper': '3/5 Transcribiendo (Whisper)',
  'image-gen-imagen': '4/5 Generando imagen (Imagen 4)',
  'compositor-remotion': '5/5 Renderizando video (Remotion)',
};

export interface RunViewerProps {
  runId: string;
}

export function RunViewer({ runId }: RunViewerProps) {
  const [run, setRun] = useState<RunStatus | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let stopped = false;

    async function fetchOnce() {
      try {
        const res = await fetch(`/api/runs/${runId}`, { cache: 'no-store' });
        if (!res.ok) {
          setError(`No se pudo obtener el run (${res.status})`);
          return false;
        }
        const data = (await res.json()) as RunStatus;
        setRun(data);
        return data.status === 'completed' || data.status === 'failed';
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error de red');
        return false;
      }
    }

    async function loop() {
      while (!stopped) {
        const done = await fetchOnce();
        if (done) break;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }

    loop();

    return () => {
      stopped = true;
    };
  }, [runId]);

  if (error) {
    return <p className="text-sm text-destructive">{error}</p>;
  }

  if (!run) {
    return <p className="text-sm text-muted-foreground">Cargando...</p>;
  }

  if (run.status === 'completed') {
    return (
      <div className="space-y-4">
        <div className="rounded-md bg-green-500/10 px-4 py-2 text-sm text-green-700 dark:text-green-400">
          ✓ Render completado{' '}
          {run.durationSeconds ? `· ${run.durationSeconds.toFixed(1)}s de video` : ''}
        </div>
        <Card>
          <CardContent className="flex justify-center pt-6">
            <video
              src={`/api/runs/${runId}/video`}
              controls
              playsInline
              className="aspect-[9/16] max-h-[80vh] rounded-md bg-black"
            />
          </CardContent>
        </Card>
        <div className="flex gap-3">
          <a
            href={`/api/runs/${runId}/video?download=1`}
            className={cn(buttonVariants({ variant: 'default' }))}
          >
            Descargar MP4
          </a>
          <Link href="/create" className={cn(buttonVariants({ variant: 'outline' }))}>
            Crear otro
          </Link>
        </div>
      </div>
    );
  }

  if (run.status === 'failed') {
    return (
      <div className="space-y-4">
        <div className="rounded-md bg-destructive/10 p-4 text-sm text-destructive">
          <p className="font-medium">El render falló.</p>
          {run.errorMessage && <pre className="mt-2 whitespace-pre-wrap text-xs">{run.errorMessage}</pre>}
        </div>
        <Link href="/create" className={cn(buttonVariants({ variant: 'outline' }))}>
          Volver a crear
        </Link>
      </div>
    );
  }

  const stepLabel = run.currentStep ? STEP_LABELS[run.currentStep] ?? run.currentStep : 'Pendiente';

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="pt-6 space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">{stepLabel}</span>
            <span className="text-xs text-muted-foreground">{run.progress}%</span>
          </div>
          <Progress value={run.progress} />
        </CardContent>
      </Card>
      <p className="text-xs text-muted-foreground">
        El primer render descarga Chromium headless (~150 MB) y puede tomar 1-3 minutos extra.
      </p>
    </div>
  );
}
