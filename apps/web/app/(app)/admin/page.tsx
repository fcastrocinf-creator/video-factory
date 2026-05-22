import { listPendingPresets } from '@/lib/admin-presets-store';
import { AdminPanel } from './AdminPanel';

export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  const pending = await listPendingPresets();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Panel de Admin</h1>
        <p className="text-sm text-muted-foreground">
          Presets aprendidos por la IA al analizar videos. Revisa, edita si quieres
          ajustar el nombre/descripción/categoría/prompt, y aprueba para que
          aparezcan en <code className="rounded bg-muted px-1">/create</code>.
          Cualquier preset rechazado se borra (incluyendo su GIF preview).
        </p>
      </div>
      <AdminPanel initialPending={pending} />
    </div>
  );
}
