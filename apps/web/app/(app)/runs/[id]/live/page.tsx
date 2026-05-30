// /runs/[id]/live — Co-pilot en vivo con VALIDATOR CHAT IA.
//
// Muestra cada scene a medida que VALIDATOR la procesa:
//   - Thumbnail de la imagen estática + estado del clip
//   - Verdict actual (con scores cuantificados)
//   - Issues detectados
//   - Thinking de Sonnet (collapsable)
//   - 4 acciones: Aprobar / Rechazar / Comentar / Skip
//
// Polling cada 5s (v1 simple). En v2 podría ser SSE/WebSocket.
//
// Owner usa esta página mientras el rip corre para:
//   - Aprobar manualmente scenes que VALIDATOR cuestiona
//   - Rechazar y proveer correctedPrompt manual
//   - Dejar comentarios que se acumulan en la memoria cross-run

import { redirect } from 'next/navigation';
import { isAuthenticated } from '@/lib/auth';
import { LiveCoPilot } from './LiveCoPilot';

export const dynamic = 'force-dynamic';

export default async function LivePage({ params }: { params: { id: string } }) {
  if (!isAuthenticated()) {
    redirect('/login');
  }
  return <LiveCoPilot runId={params.id} />;
}
