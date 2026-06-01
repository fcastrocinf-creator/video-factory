import Link from 'next/link';
import { CreateBrandForm } from './CreateBrandForm';
import { PageHeader, PageHint } from '@/components/PageHint';

export const dynamic = 'force-dynamic';

export default function NewBrandPage() {
  return (
    <div className="space-y-4 max-w-3xl">
      <Link href="/brands" className="text-xs text-muted-foreground hover:text-foreground">
        ← Marcas
      </Link>
      <PageHeader title="Crear marca nueva" subtitle="Lo básico ahora; logo y colores se agregan después" />
      <PageHint emoji="🏷️">
        Completa los campos y la marca aparecerá automáticamente al <b className="text-foreground">crear</b>,{' '}
        <b className="text-foreground">ripear</b> y en <b className="text-foreground">aprendizaje</b>. Luego
        subes logo, packshots y la paleta de colores desde <em>Editar ingredients</em>.
      </PageHint>
      <CreateBrandForm />
    </div>
  );
}
