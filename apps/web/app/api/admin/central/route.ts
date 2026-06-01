// GET /api/admin/central — dashboard de COSTO-EFICIENCIA cross-instalación.
// Solo el OWNER (VF_ROLE=owner). Lee el buzón central (eventos recibidos de cada
// instalación) y devuelve el gasto agregado por instalación. El costo es un
// ESTIMADO del pipeline (no exacto al centavo) — sirve para comparar.

import { NextResponse } from 'next/server';
import { isAuthenticated, isOwner } from '@/lib/auth';
import { centralCostStats } from '@/lib/kb/central-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  if (!isOwner()) {
    return NextResponse.json({ error: 'Solo el owner puede ver esto' }, { status: 403 });
  }
  const stats = await centralCostStats();
  return NextResponse.json({ stats });
}
