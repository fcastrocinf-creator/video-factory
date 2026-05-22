import Link from 'next/link';
import { loadAllBrands, loadAllPresets } from '@/lib/brand-preset-loader';
import { listActiveRuns } from '@/lib/runs-repository';
import { CANONICAL_FORMATS } from '@video-factory/contracts';
import { Card, CardContent } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { RepositoryView } from './RepositoryView';

export const dynamic = 'force-dynamic';

export default async function RunsPage({
  searchParams,
}: {
  searchParams: { brand?: string; product?: string; status?: string; format?: string };
}) {
  const [brands, presets] = await Promise.all([loadAllBrands(), loadAllPresets()]);

  const brandFilter = searchParams.brand;
  const productFilter = searchParams.product;
  const formatFilter = searchParams.format;
  const statusFilter = (searchParams.status as 'completed' | 'failed' | undefined) ?? undefined;

  // Mapeo presetId → formatId para poder filtrar por formato (el run guarda
  // presetId pero no format directamente — lo resolvemos del preset).
  const presetToFormat = new Map<string, string>();
  for (const p of presets) {
    if (p.format?.id) presetToFormat.set(p.id, p.format.id);
  }

  const rawItems = await listActiveRuns({
    brandId: brandFilter,
    productId:
      productFilter === undefined
        ? undefined
        : productFilter === 'none'
          ? null
          : productFilter,
    status: statusFilter,
  });

  const items = formatFilter
    ? rawItems.filter((r) => presetToFormat.get(r.presetId) === formatFilter)
    : rawItems;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Repositorio de videos</h1>
          <p className="text-sm text-muted-foreground">
            Todos los videos generados. Agrupá por marca y producto. La papelera
            guarda los borrados 30 días antes del purge definitivo.
          </p>
        </div>
        <div className="flex gap-2">
          <Link href="/runs/trash" className={cn(buttonVariants({ variant: 'outline' }))}>
            Papelera
          </Link>
          <Link href="/create" className={cn(buttonVariants({ variant: 'default' }))}>
            + Crear video
          </Link>
        </div>
      </div>

      <RepositoryView
        brands={brands.map((b) => ({
          id: b.id,
          displayName: b.displayName,
          products: b.products.map((p) => ({ id: p.id, name: p.name })),
        }))}
        formats={CANONICAL_FORMATS}
        runs={items.map((r) => ({
          id: r.id,
          brandId: r.brandId,
          productId: r.productId,
          presetId: r.presetId,
          formatId: presetToFormat.get(r.presetId) ?? null,
          status: r.status,
          durationSeconds: r.durationSeconds,
          estimatedCostUsd: r.estimatedCostUsd,
          imageCount: r.imageCount,
          createdAt: r.createdAt.toISOString(),
          completedAt: r.completedAt?.toISOString() ?? null,
          originalRunId: r.originalRunId,
        }))}
        filters={{
          brandId: brandFilter,
          productId: productFilter,
          formatId: formatFilter,
          status: statusFilter,
        }}
      />

      {items.length === 0 && (
        <Card>
          <CardContent className="pt-6 text-center text-sm text-muted-foreground">
            Sin videos para los filtros actuales.
          </CardContent>
        </Card>
      )}
    </div>
  );
}
