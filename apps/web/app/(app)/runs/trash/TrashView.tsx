'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

interface TrashedRun {
  id: string;
  brandId: string;
  productId: string | null;
  status: string;
  durationSeconds: number | null;
  deletedAt: string | null;
  createdAt: string;
}

export function TrashView({ runs }: { runs: TrashedRun[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string>('');
  const [error, setError] = useState<string>('');

  async function restore(id: string) {
    setBusy(id);
    setError('');
    try {
      const res = await fetch(`/api/runs/${id}/trash`, { method: 'PUT' });
      if (!res.ok) throw new Error(await res.text());
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function purge(id: string) {
    if (!confirm('Esto borra el video DEFINITIVAMENTE (DB + archivos). No se puede deshacer.')) return;
    setBusy(id);
    setError('');
    try {
      const res = await fetch(`/api/runs/${id}/trash`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await res.text());
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  function daysLeft(deletedAtIso: string | null): number {
    if (!deletedAtIso) return 30;
    const deletedAt = new Date(deletedAtIso).getTime();
    const cutoff = deletedAt + 30 * 24 * 60 * 60 * 1000;
    return Math.max(0, Math.ceil((cutoff - Date.now()) / (24 * 60 * 60 * 1000)));
  }

  return (
    <div className="space-y-3">
      {error && (
        <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {runs.map((r) => {
          const dleft = daysLeft(r.deletedAt);
          return (
            <Card key={r.id}>
              <CardContent className="pt-4 space-y-2">
                <p className="text-sm font-medium">{r.brandId} {r.productId ? `· ${r.productId}` : ''}</p>
                <div className="text-xs text-muted-foreground space-y-0.5">
                  <p>Creado {new Date(r.createdAt).toLocaleString('es')}</p>
                  {r.deletedAt && (
                    <p>Mandado a papelera {new Date(r.deletedAt).toLocaleString('es')}</p>
                  )}
                  <p className={dleft <= 7 ? 'text-destructive' : ''}>
                    Quedan {dleft} día{dleft === 1 ? '' : 's'} antes del purge
                  </p>
                </div>
                <div className="flex gap-2 pt-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => restore(r.id)}
                    disabled={busy === r.id}
                  >
                    Restaurar
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => purge(r.id)}
                    disabled={busy === r.id}
                  >
                    Borrar ya
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
