import { loadAllBrands } from '@/lib/brand-preset-loader';
import { RipDetailView } from './RipDetailView';

export const dynamic = 'force-dynamic';

export default async function RipDetailPage({ params }: { params: { id: string } }) {
  const brands = await loadAllBrands();
  return (
    <RipDetailView
      ripId={params.id}
      brands={brands.map((b) => ({
        id: b.id,
        displayName: b.displayName,
        language: b.language,
        products: b.products.map((p) => ({ id: p.id, name: p.name })),
        hasLogo: Boolean(b.ingredients?.logoPath ?? b.logoPath),
        assets: (b.ingredients?.assets ?? []).map((a) => ({
          id: a.id,
          kind: a.kind,
          description: a.description,
        })),
      }))}
    />
  );
}
