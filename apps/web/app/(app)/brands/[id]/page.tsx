import { notFound } from 'next/navigation';
import Link from 'next/link';
import { readBrand } from '@/lib/brand-ingredients-store';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { IngredientsEditor } from './IngredientsEditor';

export const dynamic = 'force-dynamic';

export default async function BrandIngredientsPage({ params }: { params: { id: string } }) {
  let brand;
  try {
    brand = await readBrand(params.id);
  } catch {
    notFound();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <Link
            href="/brands"
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            ← Marcas
          </Link>
          <h1 className="text-3xl font-bold tracking-tight">{brand.displayName}</h1>
          <p className="text-sm text-muted-foreground">
            id <code className="rounded bg-muted px-1 text-xs">{brand.id}</code> · {brand.language}
          </p>
        </div>
        <Link
          href={`/create`}
          className={cn(buttonVariants({ variant: 'outline' }))}
        >
          Crear video
        </Link>
      </div>

      <IngredientsEditor
        brandId={brand.id}
        initialIngredients={brand.ingredients}
        products={brand.products}
      />
    </div>
  );
}
