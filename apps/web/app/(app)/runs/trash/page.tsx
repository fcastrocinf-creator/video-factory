import Link from 'next/link';
import { listTrashedRuns } from '@/lib/runs-repository';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { TrashView } from './TrashView';

export const dynamic = 'force-dynamic';

export default async function TrashPage() {
  const trashed = await listTrashedRuns();

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Papelera</h1>
          <p className="text-sm text-muted-foreground">
            Videos eliminados. Se purgan permanentemente a los 30 días. Puedes
            restaurarlos o eliminarlos definitivamente desde aquí.
          </p>
        </div>
        <Link href="/runs" className={cn(buttonVariants({ variant: 'outline' }))}>
          ← Volver al repositorio
        </Link>
      </div>

      {trashed.length === 0 ? (
        <Card>
          <CardContent className="pt-6 text-center text-sm text-muted-foreground">
            Papelera vacía.
          </CardContent>
        </Card>
      ) : (
        <TrashView
          runs={trashed.map((r) => ({
            id: r.id,
            brandId: r.brandId,
            productId: r.productId,
            status: r.status,
            durationSeconds: r.durationSeconds,
            deletedAt: r.deletedAt?.toISOString() ?? null,
            createdAt: r.createdAt.toISOString(),
          }))}
        />
      )}
    </div>
  );
}
