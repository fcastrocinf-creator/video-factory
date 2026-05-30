'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Button, buttonVariants } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import { CorrectionPanel } from './CorrectionPanel';
import { ValidationLog } from './ValidationLog';
import { ZapCapSubtitles } from './ZapCapSubtitles';

interface RunStatus {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'completed-with-warnings' | 'failed';
  currentStep: string | null;
  progress: number;
  outputPath: string | null;
  errorMessage: string | null;
  durationSeconds: number | null;
  brandId?: string;
  productId?: string | null;
  presetId?: string;
  estimatedCostUsd?: number;
  imageCount?: number;
  ttsCharsBilled?: number;
  originalRunId?: string | null;
}

const STEP_LABELS: Record<string, string> = {
  'script-processor': '1/8 Procesando guion',
  'narrator-analyzer': '2/8 Detectando narrador (Gemini)',
  'tts-elevenlabs': '3/8 Generando voz (ElevenLabs)',
  'tts-openai-fallback': '3/8 Generando voz (OpenAI fallback)',
  'subtitles-google': '4/8 Subtítulos word-level (Google STT)',
  'subtitles-whisper': '4/8 Transcribiendo (Whisper)',
  'scene-planner': '5/8 Planificando escenas (Gemini Pro)',
  'ingredients-vision-refine': '6/8 Refinando prompts con GPT-4o vision',
  'image-gen-imagen': '7/8 Generando imagen (Imagen 4)',
  'image-gen-multi': '7/8 Generando imágenes + validator V3',
  'rip-fidelity-aligner': '7/8 Ripeo alta fidelidad: alineando con keyframes del original',
  'video-gen-veo': '7/8 Generando clip Veo',
  'video-gen-veo-skipped': '7/8 Veo falló, usando imagen estática',
  'compositor-remotion': '8/8 Renderizando video (Remotion)',
  'correction-parsing': 'Procesando corrección',
  'correction-copying-assets': 'Copiando assets del run original',
  'correction-applying': 'Aplicando corrección a escenas',
};

export interface RunViewerProps {
  runId: string;
}

// XMLHttpRequest wrapper — esquiva extensiones Chrome que interceptan window.fetch
// (ej. frame_ant ID hoklmmgfnpapgjgcpechhaamimifchmp) y rompen el polling.
function getViaXhr<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.setRequestHeader('cache-control', 'no-store');
    xhr.onload = () => {
      try {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(JSON.parse(xhr.responseText) as T);
        } else {
          reject(new Error(`HTTP ${xhr.status}`));
        }
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    };
    xhr.onerror = () => reject(new Error('XHR network error'));
    xhr.ontimeout = () => reject(new Error('XHR timeout'));
    xhr.send();
  });
}

export function RunViewer({ runId }: RunViewerProps) {
  const [run, setRun] = useState<RunStatus | null>(null);
  const [error, setError] = useState('');
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState('');
  // Bump para re-arrancar el polling loop tras un retry exitoso (el loop
  // anterior terminó al ver status='failed' o 'completed').
  const [pollEpoch, setPollEpoch] = useState(0);

  useEffect(() => {
    let stopped = false;

    async function fetchOnce(): Promise<boolean> {
      try {
        const data = await getViaXhr<RunStatus>(`/api/runs/${runId}`);
        if (stopped) return true;
        setRun(data);
        setError(''); // recuperación si hubo error transitorio
        return (
          data.status === 'completed' ||
          data.status === 'completed-with-warnings' ||
          data.status === 'failed'
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Error de red';
        // No abandonamos el polling por errores transitorios; solo lo mostramos.
        // Los AbortError vienen del dev-overlay de Next, NO son nuestros.
        if (!/abort/i.test(msg)) {
          setError(msg);
        }
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
  }, [runId, pollEpoch]);

  async function retryRun() {
    setRetrying(true);
    setRetryError('');
    try {
      const r = await fetch(`/api/runs/${runId}/retry`, { method: 'POST' });
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      setRun((prev) => (prev ? { ...prev, status: 'pending', progress: 0, errorMessage: null } : prev));
      setPollEpoch((n) => n + 1);
    } catch (e) {
      setRetryError((e as Error).message);
    } finally {
      setRetrying(false);
    }
  }

  if (error && !run) {
    return <p className="text-sm text-destructive">{error}</p>;
  }

  if (!run) {
    return <p className="text-sm text-muted-foreground">Cargando...</p>;
  }

  if (run.status === 'completed' || run.status === 'completed-with-warnings') {
    const costStr =
      run.estimatedCostUsd && run.estimatedCostUsd > 0
        ? ` · $${run.estimatedCostUsd.toFixed(2)} USD`
        : '';
    const imgStr =
      run.imageCount && run.imageCount > 0 ? ` · ${run.imageCount} imágenes` : '';
    return (
      <div className="space-y-4">
        <div className="rounded-md bg-green-500/10 px-4 py-2 text-sm text-green-700 dark:text-green-400">
          ✓ Render completado{' '}
          {run.durationSeconds ? `· ${run.durationSeconds.toFixed(1)}s de video` : ''}
          {costStr}
          {imgStr}
        </div>
        {run.errorMessage ? (
          <div className="rounded-md bg-amber-500/10 px-4 py-2 text-sm text-amber-700 dark:text-amber-400">
            ⚠ Entregado con advertencias: {run.errorMessage}
          </div>
        ) : null}
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
          <a
            href={`/api/runs/${runId}/subtitles`}
            className={cn(buttonVariants({ variant: 'outline' }))}
            title="Subtítulos .srt con tu texto exacto — para importar en CapCut / ZapCap"
          >
            Descargar subtítulos (.srt)
          </a>
          <Link
            href={`/runs/${runId}/editor`}
            className={cn(buttonVariants({ variant: 'outline' }))}
          >
            Editor de composición
          </Link>
          <Link href="/create" className={cn(buttonVariants({ variant: 'outline' }))}>
            Crear otro
          </Link>
        </div>
        <ZapCapSubtitles runId={runId} />
        <ValidationLog runId={runId} />
        <CorrectionPanel runId={runId} />
      </div>
    );
  }

  if (run.status === 'failed') {
    // Heurística: errores que típicamente son transitorios y vale la pena reintentar.
    // - "Gemini devolvió 0 escenas" → blip safety/token, retry suele andar
    // - "API_5\d\d" → server error de Google
    // - timeout / network / ETIMEDOUT / ECONNRESET → red
    const errMsg = run.errorMessage ?? '';
    const looksTransient =
      /0 escenas|503|502|500|504|429|timeout|ETIMEDOUT|ECONNRESET|network|fetch failed|prepayment|RESOURCE_EXHAUSTED/i.test(
        errMsg,
      );
    return (
      <div className="space-y-4">
        <div className="rounded-md bg-destructive/10 p-4 text-sm text-destructive">
          <p className="font-medium">El render falló.</p>
          {run.errorMessage && <pre className="mt-2 whitespace-pre-wrap text-xs">{run.errorMessage}</pre>}
          {looksTransient && (
            <p className="mt-2 text-xs text-destructive/80">
              Parece un error transitorio (server, safety filter o quota). El retry usa
              el mismo guion + preset y suele resolverse.
            </p>
          )}
        </div>
        {retryError && (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{retryError}</p>
        )}
        <div className="flex gap-2 flex-wrap">
          <Button onClick={retryRun} disabled={retrying}>
            {retrying ? 'Reintentando…' : '🔄 Reintentar render'}
          </Button>
          <Link href="/create" className={cn(buttonVariants({ variant: 'outline' }))}>
            Volver a crear
          </Link>
        </div>
        {/* Aún en run failed mostramos las validaciones IA si llegaron a generarse */}
        <ValidationLog runId={runId} />
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
        Generación premium con validators V3. Tiempo típico: 5-15 min (depende del provider de imagen).
      </p>
    </div>
  );
}
