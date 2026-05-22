'use client';

import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface CorrectionPanelProps {
  runId: string;
}

type SubmitState = 'idle' | 'submitting' | 'queued' | 'error';

interface CorrectionResponse {
  correctionId: string;
  newRunId: string;
  message: string;
}

export function CorrectionPanel({ runId }: CorrectionPanelProps) {
  const [message, setMessage] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [state, setState] = useState<SubmitState>('idle');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [newRunId, setNewRunId] = useState<string>('');

  async function submitCorrection() {
    if (!message.trim()) {
      setErrorMessage('Escribe qué quieres corregir.');
      setState('error');
      return;
    }
    setState('submitting');
    setErrorMessage('');

    const form = new FormData();
    form.append('message', message.trim());
    if (file) form.append('asset', file);

    try {
      const res = await fetch(`/api/runs/${runId}/corrections`, {
        method: 'POST',
        body: form,
      });
      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`HTTP ${res.status}: ${errBody.slice(0, 200)}`);
      }
      const data = (await res.json()) as CorrectionResponse;
      setNewRunId(data.newRunId);
      setState('queued');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error desconocido';
      setErrorMessage(msg);
      setState('error');
    }
  }

  if (state === 'queued' && newRunId) {
    return (
      <Card className="border-green-500/30 bg-green-500/5">
        <CardContent className="space-y-3 pt-6">
          <p className="text-sm font-medium text-green-700 dark:text-green-400">
            Corrección enviada. Se está generando una nueva versión del video.
          </p>
          <a
            href={`/runs/${newRunId}`}
            className={cn(buttonVariants({ variant: 'default' }), 'w-fit')}
          >
            Ver el nuevo render
          </a>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="space-y-5 pt-6">
        <div className="space-y-1">
          <h3 className="text-base font-semibold">¿Quieres corregir algo del video?</h3>
          <p className="text-xs text-muted-foreground">
            Describe qué cambiar y opcionalmente adjunta una imagen o MP4. El sistema
            identifica las escenas afectadas y regenera solo esa parte.
          </p>
        </div>

        <div className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground space-y-1">
          <p className="font-medium text-foreground">Cómo usar:</p>
          <ol className="ml-4 list-decimal space-y-0.5">
            <li>Indica el rango de tiempo o número de escena (ej: <em>&quot;Del segundo 8 al 12&quot;</em>).</li>
            <li>Describe el cambio (ej: <em>&quot;cambia por una imagen más realista de una mujer&quot;</em>).</li>
            <li>Si tienes una imagen o MP4 propio, súbelo abajo para reemplazar esa parte.</li>
            <li>Pulsa <strong>Aplicar corrección</strong> y espera el nuevo render.</li>
          </ol>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="correction-message" className="text-sm font-medium">
            Deja aquí tus correcciones
          </label>
          <Textarea
            id="correction-message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Ej: Del segundo 8 al 12 cambia la imagen por algo más natural, sin tantos detalles abstractos."
            className="min-h-[110px]"
            disabled={state === 'submitting'}
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="correction-asset" className="text-sm font-medium">
            Adjuntar imagen o MP4 (opcional)
          </label>
          <input
            id="correction-asset"
            type="file"
            accept="image/png,image/jpeg,image/webp,video/mp4"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            disabled={state === 'submitting'}
            className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border-0 file:bg-primary file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-primary-foreground file:hover:bg-primary/90"
          />
          {file && (
            <p className="text-xs text-muted-foreground">
              Seleccionado: {file.name} ({(file.size / 1024).toFixed(1)} KB)
            </p>
          )}
        </div>

        {state === 'error' && errorMessage && (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {errorMessage}
          </p>
        )}

        <div className="flex gap-3">
          <Button onClick={submitCorrection} disabled={state === 'submitting' || !message.trim()}>
            {state === 'submitting' ? 'Enviando…' : 'Aplicar corrección'}
          </Button>
          {message || file ? (
            <Button
              variant="outline"
              onClick={() => {
                setMessage('');
                setFile(null);
                setErrorMessage('');
                setState('idle');
              }}
              disabled={state === 'submitting'}
            >
              Limpiar
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
