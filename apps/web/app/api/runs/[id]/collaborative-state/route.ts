// GET /api/runs/[id]/collaborative-state
//
// Devuelve el estado de pausa del modo colaborativo: si el pipeline está
// esperando aprobación del owner para alguna scene, qué scene es, hace cuánto.
// La UI /runs/[id]/build poll este endpoint cada 2-3s para detectar cuando
// llega la próxima scene a revisar.

import { NextResponse, type NextRequest } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import { isAwaitingApproval } from '@/lib/collaborative-mode';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  const state = await isAwaitingApproval(params.id);
  return NextResponse.json({
    runId: params.id,
    mode: state.mode,
    awaitingApproval: state.awaitingApproval,
    pausedAtSceneIndex: state.pausedAtSceneIndex,
  });
}
