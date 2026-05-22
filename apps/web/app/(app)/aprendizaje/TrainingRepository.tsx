'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';

interface TrainingItem {
  id: string;
  videoFileName: string;
  videoBytes: number;
  status: 'uploaded' | 'analyzing' | 'training' | 'completed' | 'failed';
  progress: number;
  currentStep: string | null;
  resultPresetId: string | null;
  errorMessage: string | null;
  createdAt: string;
  trainedAt: string | null;
}

interface Props {
  initialItems: TrainingItem[];
}

const STATUS_LABEL: Record<TrainingItem['status'], string> = {
  uploaded: 'En repositorio',
  analyzing: 'Analizando con Gemini',
  training: 'Entrenando',
  completed: 'Listo · preset destilado',
  failed: 'Falló',
};

const STATUS_COLOR: Record<TrainingItem['status'], string> = {
  uploaded: 'text-muted-foreground',
  analyzing: 'text-blue-600 dark:text-blue-400',
  training: 'text-amber-600 dark:text-amber-400',
  completed: 'text-green-600 dark:text-green-400',
  failed: 'text-destructive',
};

export function TrainingRepository({ initialItems }: Props) {
  const router = useRouter();
  const [items, setItems] = useState<TrainingItem[]>(initialItems);
  const [globalError, setGlobalError] = useState('');

  // Poll cada 3s para refrescar items en estado intermedio (analyzing|training)
  useEffect(() => {
    const hasActive = items.some(
      (i) => i.status === 'analyzing' || i.status === 'training',
    );
    if (!hasActive) return;
    const interval = setInterval(async () => {
      try {
        const r = await fetch('/api/training', { cache: 'no-store' });
        if (r.ok) {
          const data = (await r.json()) as { items: TrainingItem[] };
          // El endpoint devuelve createdAt/trainedAt como timestamps drizzle (number*1000 en server) o Date. Adaptamos.
          const normalized = data.items.map((it) => ({
            ...it,
            createdAt:
              typeof it.createdAt === 'number'
                ? new Date(it.createdAt * 1000).toISOString()
                : it.createdAt,
            trainedAt:
              typeof it.trainedAt === 'number'
                ? new Date(it.trainedAt * 1000).toISOString()
                : it.trainedAt,
          }));
          setItems(normalized);
        }
      } catch {
        // ignored
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [items]);

  async function startLearning(id: string) {
    setGlobalError('');
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, status: 'analyzing', progress: 5 } : i)));
    try {
      const r = await fetch(`/api/training/${id}/learn`, { method: 'POST' });
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      router.push(`/aprendizaje/${id}`);
    } catch (e) {
      setGlobalError((e as Error).message);
      // Revertir status optimista
      setItems((prev) => prev.map((i) => (i.id === id ? { ...i, status: 'uploaded', progress: 0 } : i)));
    }
  }

  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="pt-6 text-center space-y-3">
          <div className="text-5xl">🎓</div>
          <p className="text-sm font-medium">Repositorio vacío</p>
          <p className="text-xs text-muted-foreground max-w-md mx-auto">
            Sube un video arriba para empezar. Cuando haces clic en{' '}
            <em>Aprender formato</em>, la IA analiza el video, extrae keyframes y
            entrena un preset visual hasta lograr alta fidelidad.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          <strong>{items.length}</strong> video{items.length === 1 ? '' : 's'} en el repositorio
        </p>
      </div>
      {globalError && (
        <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{globalError}</p>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        {items.map((item) => (
          <Card key={item.id}>
            <CardContent className="space-y-3 pt-5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-semibold truncate" title={item.videoFileName}>
                    {item.videoFileName}
                  </h3>
                  <p className="text-[11px] text-muted-foreground">
                    {(item.videoBytes / 1024 / 1024).toFixed(1)} MB · {fmtDate(item.createdAt)}
                  </p>
                </div>
                <span className={`text-xs font-medium ${STATUS_COLOR[item.status]} whitespace-nowrap`}>
                  {STATUS_LABEL[item.status]}
                </span>
              </div>

              {(item.status === 'analyzing' || item.status === 'training') && (
                <div className="space-y-1.5">
                  <Progress value={item.progress} />
                  <p className="text-[11px] text-muted-foreground">
                    {item.currentStep ?? 'En curso'} · {item.progress}%
                  </p>
                </div>
              )}

              {item.status === 'failed' && item.errorMessage && (
                <pre className="rounded-md bg-destructive/10 p-2 text-[10px] text-destructive whitespace-pre-wrap">
                  {item.errorMessage.slice(0, 300)}
                </pre>
              )}

              {item.status === 'completed' && item.resultPresetId && (
                <div className="rounded-md bg-green-500/10 px-3 py-2 text-xs">
                  ✓ Preset destilado en{' '}
                  <code className="text-[10px]">{item.resultPresetId}</code> ·
                  Aprobalo en <Link href="/admin" className="underline">/admin</Link> para
                  que aparezca en <Link href="/create" className="underline">/create</Link>.
                </div>
              )}

              <div className="flex gap-2 flex-wrap pt-1">
                {item.status === 'uploaded' || item.status === 'failed' ? (
                  <Button size="sm" onClick={() => startLearning(item.id)}>
                    {item.status === 'failed' ? 'Reintentar aprendizaje' : '🎓 Aprender formato'}
                  </Button>
                ) : (
                  <Link
                    href={`/aprendizaje/${item.id}`}
                    className="inline-flex items-center rounded-md border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted"
                  >
                    Ver trayectoria
                  </Link>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function fmtDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return iso.slice(0, 16);
  }
}
