// GET /api/promptlab/[id] — trayectoria del run (para poll en vivo).

import { NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import { readTrajectory } from '@/lib/promptlab/service';

export const runtime = 'nodejs';

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  const t = await readTrajectory(params.id);
  if (!t) {
    return NextResponse.json({ error: 'No encontrado' }, { status: 404 });
  }
  return NextResponse.json(t);
}
