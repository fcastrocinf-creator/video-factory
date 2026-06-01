import { listPendingPresets } from '@/lib/admin-presets-store';
import { AdminPanel } from './AdminPanel';
import { PageHeader, PageHint } from '@/components/PageHint';

export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  const pending = await listPendingPresets();
  return (
    <div className="space-y-6">
      <PageHeader title="Admin" subtitle="Aprueba estilos aprendidos y revisa el sistema" />
      <PageHint emoji="⚙️">
        <b className="text-foreground">El panel de control.</b> Acá revisas y apruebas los estilos que la IA
        aprendió de tus videos: aprueba para que aparezcan al <a href="/create" className="underline">crear</a>,
        o rechaza para descartarlos. También vive aquí el “cerebro evolutivo” que propone mejoras.
      </PageHint>
      <AdminPanel initialPending={pending} />
    </div>
  );
}
