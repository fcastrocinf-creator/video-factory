'use client';

import { useState, useTransition } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Button, buttonVariants } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';

interface Brand {
  id: string;
  displayName: string;
  products: Array<{ id: string; name: string }>;
}
interface FormatOption {
  id: string;
  displayName: string;
  description: string;
}
interface RunItem {
  id: string;
  brandId: string;
  productId: string | null;
  presetId: string;
  formatId: string | null;
  status: 'pending' | 'running' | 'completed' | 'failed';
  durationSeconds: number | null;
  estimatedCostUsd: number;
  imageCount: number;
  createdAt: string;
  completedAt: string | null;
  originalRunId: string | null;
}

export interface RepositoryViewProps {
  brands: Brand[];
  formats: FormatOption[];
  runs: RunItem[];
  filters: {
    brandId?: string;
    productId?: string;
    formatId?: string;
    status?: string;
  };
}

export function RepositoryView({ brands, formats, runs, filters }: RepositoryViewProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string>('');

  const selectedBrand = brands.find((b) => b.id === filters.brandId);

  function setFilter(key: 'brand' | 'product' | 'status' | 'format', value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (!value) params.delete(key);
    else params.set(key, value);
    // Si cambia marca, limpiar producto
    if (key === 'brand') params.delete('product');
    startTransition(() => {
      router.push(`/runs?${params.toString()}`);
    });
  }

  async function trash(runId: string) {
    if (!confirm('¿Mandar a papelera? Se guarda 30 días antes del purge.')) return;
    setError('');
    try {
      const res = await fetch(`/api/runs/${runId}/trash`, { method: 'POST' });
      if (!res.ok) throw new Error(await res.text());
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function reassign(runId: string, newProductId: string) {
    setError('');
    try {
      const res = await fetch(`/api/runs/${runId}/product`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ productId: newProductId || null }),
      });
      if (!res.ok) throw new Error(await res.text());
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // Agrupar por marca → producto cuando no hay filtro de marca específico
  const grouped = new Map<string, Map<string | null, RunItem[]>>();
  for (const r of runs) {
    if (!grouped.has(r.brandId)) grouped.set(r.brandId, new Map());
    const byProduct = grouped.get(r.brandId)!;
    if (!byProduct.has(r.productId)) byProduct.set(r.productId, []);
    byProduct.get(r.productId)!.push(r);
  }

  return (
    <div className="space-y-5">
      {/* FILTROS */}
      <Card>
        <CardContent className="pt-6 grid grid-cols-1 md:grid-cols-4 gap-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium">Marca</label>
            <Select value={filters.brandId ?? ''} onChange={(e) => setFilter('brand', e.target.value)}>
              <option value="">Todas</option>
              {brands.map((b) => (
                <option key={b.id} value={b.id}>{b.displayName}</option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium">Producto</label>
            <Select
              value={filters.productId ?? ''}
              onChange={(e) => setFilter('product', e.target.value)}
              disabled={!selectedBrand}
            >
              <option value="">{selectedBrand ? 'Todos los del brand' : 'Selecciona marca primero'}</option>
              {selectedBrand && (
                <>
                  <option value="none">Sin asignar</option>
                  {selectedBrand.products.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </>
              )}
            </Select>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium">Formato</label>
            <Select value={filters.formatId ?? ''} onChange={(e) => setFilter('format', e.target.value)}>
              <option value="">Todos</option>
              {formats.map((f) => (
                <option key={f.id} value={f.id}>{f.displayName}</option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium">Estado</label>
            <Select value={filters.status ?? ''} onChange={(e) => setFilter('status', e.target.value)}>
              <option value="">Todos</option>
              <option value="completed">Completados</option>
              <option value="running">En proceso</option>
              <option value="failed">Fallidos</option>
            </Select>
          </div>
        </CardContent>
      </Card>

      {error && (
        <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>
      )}
      {isPending && <p className="text-xs text-muted-foreground">Filtrando…</p>}

      {/* GRUPOS */}
      {[...grouped.entries()].map(([brandId, byProduct]) => {
        const brand = brands.find((b) => b.id === brandId);
        return (
          <section key={brandId} className="space-y-3">
            <h2 className="text-lg font-semibold">{brand?.displayName ?? brandId}</h2>
            {[...byProduct.entries()].map(([productId, productRuns]) => {
              const product = brand?.products.find((p) => p.id === productId);
              const productLabel = product?.name ?? (productId ? `id: ${productId}` : 'Sin producto asignado');
              return (
                <div key={`${brandId}-${productId ?? 'none'}`} className="space-y-2">
                  <h3 className="text-sm font-medium text-muted-foreground">
                    {productLabel}{' '}
                    <span className="text-xs">({productRuns.length})</span>
                  </h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                    {productRuns.map((r) => (
                      <RunCard
                        key={r.id}
                        run={r}
                        brand={brand}
                        onTrash={() => trash(r.id)}
                        onReassign={(pid) => reassign(r.id, pid)}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}

function RunCard({
  run,
  brand,
  onTrash,
  onReassign,
}: {
  run: RunItem;
  brand?: Brand;
  onTrash: () => void;
  onReassign: (pid: string) => void;
}) {
  const statusBadge = {
    completed: 'bg-green-500/10 text-green-700 dark:text-green-400',
    running: 'bg-blue-500/10 text-blue-700 dark:text-blue-400',
    failed: 'bg-destructive/10 text-destructive',
    pending: 'bg-muted text-muted-foreground',
  }[run.status];

  const date = new Date(run.createdAt).toLocaleString('es', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <Card>
      <CardContent className="pt-4 space-y-2">
        <Link href={`/runs/${run.id}`} className="block">
          {run.status === 'completed' ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`/api/runs/${run.id}/thumbnail`}
              alt="Thumbnail"
              className="aspect-[9/16] w-full rounded-md bg-muted object-cover"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = 'none';
              }}
            />
          ) : (
            <div className="aspect-[9/16] w-full rounded-md bg-muted flex items-center justify-center text-xs text-muted-foreground">
              {run.status === 'running' ? 'En proceso…' : run.status}
            </div>
          )}
        </Link>
        <div className="flex items-center justify-between text-xs">
          <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium', statusBadge)}>
            {run.status}
          </span>
          <span className="text-muted-foreground">{date}</span>
        </div>
        <div className="text-xs space-y-0.5 text-muted-foreground">
          {run.durationSeconds && <p>{run.durationSeconds.toFixed(1)}s de video</p>}
          {run.estimatedCostUsd > 0 && (
            <p>
              ${run.estimatedCostUsd.toFixed(2)} · {run.imageCount} img
            </p>
          )}
          {run.originalRunId && (
            <p>
              Corrección de{' '}
              <Link href={`/runs/${run.originalRunId}`} className="underline">
                {run.originalRunId.slice(0, 8)}
              </Link>
            </p>
          )}
        </div>
        <div className="flex gap-2">
          {brand && brand.products.length > 0 && (
            <Select
              value={run.productId ?? ''}
              onChange={(e) => onReassign(e.target.value)}
              className="h-8 text-xs"
            >
              <option value="">Sin asignar</option>
              {brand.products.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </Select>
          )}
          <Button variant="outline" size="sm" onClick={onTrash} className="text-xs">
            Papelera
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
