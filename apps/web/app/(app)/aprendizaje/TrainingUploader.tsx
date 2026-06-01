'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

const MAX_MB = 200;

export function TrainingUploader() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);

  async function submit() {
    if (!file) {
      setError('Selecciona un video MP4 primero');
      return;
    }
    if (file.size > MAX_MB * 1024 * 1024) {
      setError(`Video demasiado grande (${(file.size / 1024 / 1024).toFixed(1)} MB). Máx ${MAX_MB} MB.`);
      return;
    }
    setError('');
    setUploading(true);
    try {
      const form = new FormData();
      form.append('video', file);
      const resp = await fetch('/api/training/upload', { method: 'POST', body: form });
      if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`${resp.status}: ${body.slice(0, 200)}`);
      }
      // Refrescamos la lista para que aparezca la card nueva
      setFile(null);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  return (
    <Card>
      <CardContent className="space-y-3 pt-6">
        <div className="space-y-1.5">
          <label htmlFor="training-video" className="text-sm font-medium">
            Sube un video al repositorio
          </label>
          <input
            id="training-video"
            type="file"
            accept="video/mp4,video/quicktime,video/webm"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            disabled={uploading}
            className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border-0 file:bg-primary file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-primary-foreground file:hover:bg-primary/90"
          />
          {file && (
            <p className="text-xs text-muted-foreground">
              {file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Máximo {MAX_MB} MB. Idealmente videos de 15-90s. MP4 / MOV / WebM.
            No se inicia el aprendizaje automáticamente: el video queda en el
            repositorio para que tú decidas cuándo aprenderlo.
          </p>
        </div>

        {error && (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
        )}

        <Button onClick={submit} disabled={uploading || !file}>
          {uploading ? 'Subiendo…' : 'Agregar al repositorio'}
        </Button>
      </CardContent>
    </Card>
  );
}
