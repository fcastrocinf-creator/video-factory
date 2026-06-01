import Link from 'next/link';
import { loadAllBrands } from '@/lib/brand-preset-loader';
import { Card, CardContent } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { PageHeader, PageHint } from '@/components/PageHint';

export const dynamic = 'force-dynamic';

export default async function BrandsPage() {
  const brands = await loadAllBrands();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Marcas"
        subtitle="Logo, productos, colores y reglas de cada marca"
        actions={
          <Link href="/brands/new" className={cn(buttonVariants({ variant: 'default' }))}>
            ＋ Crear marca
          </Link>
        }
      />
      <PageHint emoji="🏷️">
        <b className="text-foreground">El ADN de cada marca.</b> Acá guardas logo, productos, paleta de
        colores y reglas. La IA los recuerda automáticamente cada vez que generas un video para esa marca.
      </PageHint>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {brands.map((brand) => {
          const ingredients = brand.ingredients;
          const hasLogo = Boolean(ingredients?.logoPath ?? brand.logoPath);
          const assetCount = ingredients?.assets.length ?? 0;
          const colorCount = ingredients?.colorPalette.length ?? 0;
          return (
            <Card key={brand.id}>
              <CardContent className="pt-6 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-lg font-semibold">{brand.displayName}</h2>
                    <p className="text-xs text-muted-foreground">id: {brand.id} · {brand.language}</p>
                  </div>
                  {hasLogo && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={`/api/brands/${brand.id}/file?which=logo`}
                      alt={`Logo ${brand.displayName}`}
                      className="h-12 w-12 rounded-md object-contain bg-muted"
                    />
                  )}
                </div>
                <div className="grid grid-cols-3 gap-2 text-xs text-muted-foreground">
                  <div className="rounded-md bg-muted/50 px-2 py-1.5">
                    <p className="font-medium text-foreground">{brand.products.length}</p>
                    <p>productos</p>
                  </div>
                  <div className="rounded-md bg-muted/50 px-2 py-1.5">
                    <p className="font-medium text-foreground">{assetCount}</p>
                    <p>assets</p>
                  </div>
                  <div className="rounded-md bg-muted/50 px-2 py-1.5">
                    <p className="font-medium text-foreground">{colorCount}</p>
                    <p>colores</p>
                  </div>
                </div>
                <Link
                  href={`/brands/${brand.id}`}
                  className={cn(buttonVariants({ variant: 'outline' }), 'w-full')}
                >
                  Editar ingredients
                </Link>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
