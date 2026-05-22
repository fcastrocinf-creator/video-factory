import Link from 'next/link';
import { CreateBrandForm } from './CreateBrandForm';

export const dynamic = 'force-dynamic';

export default function NewBrandPage() {
  return (
    <div className="space-y-4 max-w-3xl">
      <Link href="/brands" className="text-xs text-muted-foreground hover:text-foreground">
        ← Marcas
      </Link>
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Crear marca nueva</h1>
        <p className="text-sm text-muted-foreground">
          Completa los campos. Una vez creada, la marca aparece automáticamente en{' '}
          <code className="rounded bg-muted px-1">/create</code>,{' '}
          <code className="rounded bg-muted px-1">/rip</code> y{' '}
          <code className="rounded bg-muted px-1">/aprendizaje</code>. Después puedes
          subir logo, packshots y configurar paleta de colores desde{' '}
          <em>Editar ingredients</em>.
        </p>
      </div>
      <CreateBrandForm />
    </div>
  );
}
