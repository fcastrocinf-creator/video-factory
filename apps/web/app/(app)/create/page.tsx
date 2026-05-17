import { loadAllBrands, loadAllPresets } from '@/lib/brand-preset-loader';
import { CreateForm } from './CreateForm';

export const dynamic = 'force-dynamic';

export default async function CreatePage() {
  const [brands, presets] = await Promise.all([loadAllBrands(), loadAllPresets()]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Crear video</h1>
        <p className="text-sm text-muted-foreground">
          Elegí marca, preset y pegá el guión. El render arranca al darle Generar.
        </p>
      </div>
      <CreateForm
        brands={brands.map((b) => ({ id: b.id, displayName: b.displayName }))}
        presets={presets.map((p) => ({
          id: p.id,
          displayName: p.displayName,
          description: p.description,
          estrategia: p.estrategia,
        }))}
      />
    </div>
  );
}
