import { redirect } from 'next/navigation';
import { listPendingPresets } from '@/lib/admin-presets-store';
import { AdminPanel } from './AdminPanel';
import { PageHeader, PageHint } from '@/components/PageHint';
import { isOwner } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  // Solo el owner (VF_ROLE=owner) ve el panel admin. Un usuario va a sus videos.
  if (!isOwner()) redirect('/runs');
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
