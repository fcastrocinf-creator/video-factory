import { loadAllBrands } from '@/lib/brand-preset-loader';
import { loadWinningPrompts } from '@/lib/promptlab/prompt-library';
import { PageHeader, PageHint } from '@/components/PageHint';
import { PromptLab } from './PromptLab';

export const dynamic = 'force-dynamic';

export default async function LaboratorioPage() {
  const [brands, library] = await Promise.all([loadAllBrands(), loadWinningPrompts()]);
  const brandList = brands.map((b) => ({ id: b.id, displayName: b.displayName }));
  const lib = library
    .sort((a, b) => (a.ts < b.ts ? 1 : -1))
    .map((w) => ({
      id: w.id,
      mode: w.mode,
      intention: w.intention ?? '',
      score: w.score,
      prompt: w.prompt,
      brandId: w.brandId ?? null,
    }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Laboratorio de Prompts"
        subtitle="La IA genera, juzga la similitud y refina el prompt hasta aprobar la visual"
      />
      <PageHint emoji="🧪">
        <b className="text-foreground">Prompts que se aprueban solos.</b> Describe la escena que quieres;
        la herramienta genera una imagen, una IA con visión revisa <b>todos los detalles</b> y refina el
        prompt hasta que la visual <b>pasa</b>. Los prompts ganadores se guardan y siembran los próximos
        — así mejora la fidelidad de ripeo y creación con el tiempo.
      </PageHint>
      <PromptLab brands={brandList} initialLibrary={lib} />
    </div>
  );
}
