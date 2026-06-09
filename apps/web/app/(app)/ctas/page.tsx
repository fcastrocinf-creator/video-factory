import { loadAllBrands } from '@/lib/brand-preset-loader';
import { listCtas } from '@/lib/cta-store';
import { PageHeader, PageHint } from '@/components/PageHint';
import { CtasManager } from './CtasManager';

export const dynamic = 'force-dynamic';

export default async function CtasPage() {
  const brands = await loadAllBrands();
  const data = await Promise.all(
    brands.map(async (b) => ({
      id: b.id,
      displayName: b.displayName,
      ctas: await listCtas(b.id),
    })),
  );

  return (
    <div className="space-y-6">
      <PageHeader title="CTAs" subtitle="Cierres reusables por marca — imágenes y videos" />
      <PageHint emoji="📣">
        <b className="text-foreground">Tu librería de cierres.</b> Guarda aquí los CTA de cada marca
        (el personaje apuntando al link, el producto en cámara, etc.). Son <b>solo visual</b> — sin
        audio ni texto — para cargarlos o editarlos cuando armes un video.
      </PageHint>
      <CtasManager brands={data} />
    </div>
  );
}
