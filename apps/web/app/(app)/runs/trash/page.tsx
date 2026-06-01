import Link from 'next/link';
import { listTrashedRuns } from '@/lib/runs-repository';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { TrashView } from './TrashView';
import { PageHeader, PageHint } from '@/components/PageHint';

export const dynamic = 'force-dynamic';

export default async function TrashPage() {
  const trashed = await listTrashedRuns();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Papelera"
        subtitle="Videos eliminados — se purgan a los 30 días"
        actions={
          <Link href="/runs" className={cn(buttonVariants({ variant: 'outline' }))}>
            ← Volver
          </Link>
        }
      />
      <PageHint emoji="🗑️">
        Acá están los videos que eliminaste. Puedes <b className="text-foreground">restaurarlos</b> o borrarlos
        definitivamente. Pasados 30 días se eliminan solos.
      </PageHint>

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
