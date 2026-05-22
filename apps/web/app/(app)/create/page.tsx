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
          Elige marca, preset y pega el guión. El render se inicia al hacer clic en Generar.
        </p>
      </div>
      <CreateForm
        brands={brands.map((b) => ({
          id: b.id,
          displayName: b.displayName,
          products: b.products.map((p) => ({ id: p.id, name: p.name })),
          voices: [
            {
              voiceId: b.defaultVoice.voiceId,
              label: b.defaultVoice.label || `${b.displayName} · default`,
              gender: b.defaultVoice.gender,
              ageRange: b.defaultVoice.ageRange,
            },
            ...(b.voiceLibrary ?? []).map((v) => ({
              voiceId: v.voiceId,
              label: v.label || v.voiceId,
              gender: v.gender,
              ageRange: v.ageRange,
            })),
          ],
        }))}
        presets={presets.map((p) => ({
          id: p.id,
          displayName: p.displayName,
          description: p.description,
          estrategia: p.estrategia,
          visualEngine: p.visualEngine,
          categoryId: p.category?.id,
          categoryDisplayName: p.category?.displayName,
          categoryDescription: p.category?.description,
          formatId: p.format?.id,
          formatDisplayName: p.format?.displayName,
          formatDescription: p.format?.description,
          styleId: p.style?.id,
          styleDisplayName: p.style?.displayName,
        }))}
      />
    </div>
  );
}
